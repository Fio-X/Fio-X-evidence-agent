//! Client for the Node tool host (1011ab step 1, agent-spec 9 and 10): the Rust agent layer starts `runtime/tool_host.mjs`, which only runs
//! tools and never holds a model key. One JSON object per line each way. Per call: `call` -> `validated` (arguments after the host's
//! conversion) -> this side re-checks them with its own validator -> `go` -> `progress`* -> `result` | `error`. Tools outside the allow list are
//! never exposed, and a host whose tool list or group labels disagree with `groups.json`, or whose environment holds a key-like name, is refused.
//! Nothing here is wired into the agent loop yet (step 2), so the module is built for tests only until then.

use crate::staging;
use crate::tool_schema;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const GROUPS_JSON: &str = include_str!("../runtime/pi/groups.json");
const PROTOCOL: u64 = 1;
const KEYLIKE_SUFFIXES: [&str; 5] = ["_API_KEY", "_BASE_URL", "_TOKEN", "_SECRET", "PASSWORD"];
const KEYLIKE_WORDS: [&str; 5] = ["SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL"];
const KEYLIKE_KEY_COMPOUNDS: [&str; 4] = ["APIKEY", "ACCESSKEY", "PRIVATEKEY", "SECRETKEY"];
const ENV_EXACT: [&str; 17] = [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LANGUAGE",
    "TMPDIR",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
];

/// True for a variable name that looks like a credential or an endpoint override (names only; values are never inspected).
/// This is a name rule and has an inherent edge: names that carry no credential word as a whole `_` part (NEWSROOM_MYKEY, NEWSROOM_PASS,
/// NEWSROOM_AUTH) are not caught. It is a safety net, not a guarantee of "everything key-like is blocked"; the real protection is that the
/// model key is never in the child's environment at all (gate A hand-over). Naming convention: a new switch name must not contain a KEY,
/// SECRET, TOKEN, PASSWORD, PASSWD or CREDENTIAL part, or the child and the tool host will drop it.
pub fn is_keylike(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if KEYLIKE_SUFFIXES
        .iter()
        .any(|suffix| upper.ends_with(suffix))
    {
        return true;
    }
    // Any `_`-separated part that is, or carries, a credential word, whatever the prefix (NEWSROOM_KEY, NEWSROOM_APIKEY, newsroom_secret).
    // KEY is matched as a whole part or as the tail of a compound credential word, so a switch such as NEWSROOM_SANKEY_OTHER_NOTE stays.
    upper.split('_').any(|part| {
        KEYLIKE_WORDS.iter().any(|word| part.contains(word))
            || part == "KEY"
            || KEYLIKE_KEY_COMPOUNDS
                .iter()
                .any(|compound| part.ends_with(compound))
    })
}

/// `--use-env-proxy` when the environment names a proxy (non-empty value), else nothing. Names only decide; values are never read out.
pub fn node_proxy_args(env: &[(String, String)]) -> Vec<&'static str> {
    let has_proxy = env.iter().any(|(name, value)| {
        !value.trim().is_empty()
            && matches!(
                name.to_ascii_uppercase().as_str(),
                "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY"
            )
    });
    if has_proxy {
        vec!["--use-env-proxy"]
    } else {
        Vec::new()
    }
}

fn node_knows_env_proxy(node: &str) -> bool {
    std::process::Command::new(node)
        .args(["--use-env-proxy", "--version"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// The environment the host is started with: a fixed list, locale, and `NEWSROOM_*` switches; anything key-like is dropped.
pub fn whitelisted_env(vars: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    vars.into_iter()
        .filter(|(name, _)| !is_keylike(name))
        .filter(|(name, _)| {
            ENV_EXACT.contains(&name.as_str())
                || name.starts_with("LC_")
                || name.starts_with("NEWSROOM_")
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct ToolInfo {
    pub description: String,
    pub parameters: Value,
    pub group: String,
    /// One line for the system prompt's tool list; a tool without one is not listed there.
    pub prompt_snippet: Option<String>,
    /// Guidelines the host already worked out for this tool (speed switches included); the prompt only receives them.
    pub prompt_guidelines: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub enum CallOutcome {
    Result {
        content: Vec<Value>,
        details: Option<Value>,
        is_error: bool,
    },
    Error {
        kind: String,
        message: String,
    },
}

/// Checks the host's `ready` message against the allow list and `groups.json`; returns the tools it exposes.
pub fn check_ready(ready: &Value, allowed: &[String]) -> Result<BTreeMap<String, ToolInfo>> {
    if ready.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL) {
        bail!("tool host speaks another protocol version");
    }
    let leaked: Vec<&str> = ready
        .get("envNames")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("tool host did not report its environment names"))?
        .iter()
        .filter_map(Value::as_str)
        .filter(|name| is_keylike(name))
        .collect();
    if !leaked.is_empty() {
        bail!(
            "tool host environment holds key-like names: {}",
            leaked.join(", ")
        );
    }
    let groups: Value =
        serde_json::from_str(GROUPS_JSON).context("groups.json is not valid JSON")?;
    let table = groups
        .get("tools")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("groups.json has no tools table"))?;
    let mut tools = BTreeMap::new();
    for tool in ready
        .get("tools")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("tool host did not report its tools"))?
    {
        let name = tool
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("a reported tool has no name"))?;
        if !allowed.iter().any(|a| a == name) {
            bail!("tool host exposes {name}, which is outside the allow list");
        }
        let row = table
            .get(name)
            .ok_or_else(|| anyhow!("tool host exposes {name}, which is not in groups.json"))?;
        let group = tool
            .get("group")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if row.get("group").and_then(Value::as_str) != Some(group) {
            bail!(
                "tool {name}: host reports group {group:?}, groups.json says {:?}",
                row.get("group")
            );
        }
        let parameters = tool
            .get("parameters")
            .cloned()
            .filter(Value::is_object)
            .ok_or_else(|| anyhow!("tool {name} has no object schema"))?;
        let mut unchecked = Vec::new();
        tool_schema::unsupported_keywords(&parameters, "root", &mut unchecked);
        if !unchecked.is_empty() {
            bail!(
                "tool {name} uses schema keywords this side cannot check: {}",
                unchecked.join(", ")
            );
        }
        let info = ToolInfo {
            description: tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            parameters,
            group: group.to_string(),
            prompt_snippet: tool
                .get("promptSnippet")
                .and_then(Value::as_str)
                .map(str::to_string),
            prompt_guidelines: tool
                .get("promptGuidelines")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        };
        if tools.insert(name.to_string(), info).is_some() {
            bail!("tool host reports {name} twice");
        }
    }
    Ok(tools)
}

pub struct ToolHost {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// Bytes read from the host that do not yet make a whole line. Kept here (not in a local of `read_message`) so that dropping a read
    /// that the 25 ms tick cut off loses nothing.
    pending: Vec<u8>,
    /// Lines about things the host could not finish on its own (a cleanup that failed); `take_notes` hands them out once.
    notes: Arc<Mutex<Vec<String>>>,
    tools: BTreeMap<String, ToolInfo>,
    next_id: u64,
    /// Set by `with_staging` (NEWSROOM_AGENT=rust): the run folder whose `staging/<callId>/` each call writes into.
    staging: Option<PathBuf>,
    check: staging::Check,
}

/// The next JSON line from the host. Cancel-safe: `fill_buf` leaves its bytes in the reader until `consume`, and a partial line is kept in
/// `pending`, so a future dropped between two reads of one line (the select tick in `exchange`) loses no bytes. A line that is not JSON is skipped.
async fn read_message(stdout: &mut BufReader<ChildStdout>, pending: &mut Vec<u8>) -> Result<Value> {
    loop {
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = pending.drain(..=end).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Ok(message) = serde_json::from_slice::<Value>(&line) {
                return Ok(message);
            }
        }
        let chunk = stdout.fill_buf().await?;
        if chunk.is_empty() {
            // an unterminated last line is still a message when it is whole JSON
            if let Ok(message) = serde_json::from_slice::<Value>(pending) {
                pending.clear();
                return Ok(message);
            }
            bail!("tool host closed its output");
        }
        let taken = chunk.len();
        pending.extend_from_slice(chunk);
        stdout.consume(taken);
    }
}

/// Cleans up the staging folders of a call whose future was dropped before it ended. This is the path after the cancel and its five seconds
/// of grace have not brought the call back (see `Agent::execute`), so it is rare. The removal stays in `drop` because a call's staging
/// folder holds a few small files, so it does not hold the thread for long. A folder that cannot be removed is put in `notes` (a count and
/// the call id, no file names or contents) for the agent loop to show.
struct Unfinished {
    run: PathBuf,
    call_id: String,
    armed: bool,
    notes: Arc<Mutex<Vec<String>>>,
}

impl Drop for Unfinished {
    fn drop(&mut self) {
        if self.armed {
            let left = staging::discard(&self.run, &self.call_id);
            if left > 0 {
                if let Ok(mut notes) = self.notes.lock() {
                    notes.push(format!(
                        "Staging cleanup of call {} left {left} folder(s) behind",
                        self.call_id
                    ));
                }
            }
        }
    }
}

impl ToolHost {
    /// Starts `<runtime_dir>/tool_host.mjs` with exactly `env` (refused when it holds a key-like name) and waits for the tool list.
    pub async fn start(
        node: &str,
        runtime_dir: &Path,
        cwd: &Path,
        run_dir: &Path,
        allowed: &[String],
        env: Vec<(String, String)>,
    ) -> Result<Self> {
        if let Some((name, _)) = env.iter().find(|(name, _)| is_keylike(name)) {
            bail!("refusing to start the tool host with the key-like variable {name}");
        }
        // Node's own fetch ignores the proxy names unless it is started with --use-env-proxy; without it a fetch on a proxy-only machine would
        // silently go direct. Refuse with one plain line when this node does not know the flag.
        let proxy_args = node_proxy_args(&env);
        if !proxy_args.is_empty() && !node_knows_env_proxy(node) {
            bail!("a proxy is configured but this node does not support --use-env-proxy (needs node 22.21 or newer); the tool host's fetches would bypass the proxy, so nothing was started");
        }
        let mut child = Command::new(node)
            .args(proxy_args)
            .arg(runtime_dir.join("tool_host.mjs"))
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("failed to start the tool host")?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("tool host has no stdin"))?;
        let stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("tool host has no stdout"))?,
        );
        let mut host = Self {
            child,
            stdin,
            stdout,
            pending: Vec::new(),
            notes: Arc::new(Mutex::new(Vec::new())),
            tools: BTreeMap::new(),
            next_id: 0,
            staging: None,
            check: staging::Check::default(),
        };
        host.send(&json!({"type":"hello","protocol":PROTOCOL,"cwd":cwd,"runDir":run_dir,"allowedTools":allowed})).await?;
        let ready = tokio::time::timeout(
            Duration::from_secs(60),
            read_message(&mut host.stdout, &mut host.pending),
        )
        .await
        .map_err(|_| anyhow!("tool host did not answer the hello in time"))??;
        if ready.get("type").and_then(Value::as_str) != Some("ready") {
            bail!(
                "tool host failed to start: {}",
                ready
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("no message")
            );
        }
        host.tools = check_ready(&ready, allowed)?;
        Ok(host)
    }

    /// From now on every call writes into `<run_dir>/staging/<callId>/`, and what it left there is judged and moved in (or refused) when it ends.
    ///
    /// Whatever `staging/` already holds is removed first (through the group guard). A run that is resumed starts a new host whose call ids
    /// begin again at `c1`, so a folder left by an earlier host (a call cut off by a time limit, or a crash) would be taken for this host's
    /// call of the same id and its files judged and moved in. Clearing was chosen over a per-host id prefix because the call ids stay
    /// short and equal to what the audit and the event log already show.
    pub fn with_staging(mut self, run_dir: &Path) -> Self {
        staging::clear_all(run_dir);
        self.staging = Some(run_dir.to_path_buf());
        self
    }

    /// The notes collected since the last call to this method.
    pub fn take_notes(&mut self) -> Vec<String> {
        self.notes
            .lock()
            .map(|mut notes| std::mem::take(&mut *notes))
            .unwrap_or_default()
    }

    /// Also count the items that pass in `runtime/group-boundary-report.json` (the host is told, so Node leaves them out of its own count).
    /// `status_computed` is the review-from-records switch of the report.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_report(mut self, status_computed: bool) -> Self {
        self.check.report = Some(status_computed);
        self
    }

    pub fn tools(&self) -> &BTreeMap<String, ToolInfo> {
        &self.tools
    }

    async fn send(&mut self, message: &Value) -> Result<()> {
        let mut text = message.to_string();
        text.push('\n');
        self.stdin.write_all(text.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Runs one tool call. An unknown or unexposed tool and failed arguments come back as `CallOutcome::Error` and the tool does not run;
    /// setting `cancel` sends a cancel and the call ends with kind `cancelled`. Progress partials are appended to `progress`.
    pub async fn call(
        &mut self,
        name: &str,
        args: &Value,
        cancel: &AtomicBool,
        progress: &mut Vec<Value>,
    ) -> Result<CallOutcome> {
        let Some(info) = self.tools.get(name).cloned() else {
            return Ok(CallOutcome::Error {
                kind: "unknown_tool".into(),
                message: format!("No tool named {name} is registered"),
            });
        };
        self.next_id += 1;
        let call_id = format!("c{}", self.next_id);
        let Some(run) = self.staging.clone() else {
            return self
                .exchange(name, &info, args, cancel, progress, &call_id, None)
                .await;
        };
        let staged = staging::begin(&run, &call_id)?;
        // when the caller drops this future (a time limit) the call never reaches `finish`: the guard removes its folders instead
        let mut open = Unfinished {
            run: run.clone(),
            call_id: call_id.clone(),
            armed: true,
            notes: self.notes.clone(),
        };
        let outcome = self
            .exchange(name, &info, args, cancel, progress, &call_id, Some(staged))
            .await;
        open.armed = false;
        // what the call left is judged file by file whatever way it ended (a failed call's legal writes stay: they may be the failure evidence);
        // a file that is refused is told to the model the way the failed write would have told it
        let groups: BTreeMap<String, String> = self
            .tools
            .iter()
            .map(|(n, i)| (n.clone(), i.group.clone()))
            .collect();
        let lookup = staging::group_lookup(&groups);
        let tools_of = staging::tools_in_group(&groups);
        let finished = staging::finish(&run, &call_id, name, &lookup, &tools_of, &self.check);
        let told = finished.refusals.join("\n");
        let outcome = match outcome {
            Ok(CallOutcome::Result {
                content,
                details,
                is_error,
            }) if told.is_empty() => Ok(CallOutcome::Result {
                content,
                details,
                is_error,
            }),
            Ok(CallOutcome::Result { .. }) => Ok(CallOutcome::Result {
                content: vec![json!({"type":"text","text":told})],
                details: None,
                is_error: true,
            }),
            Ok(CallOutcome::Error { kind, message }) if !told.is_empty() => {
                Ok(CallOutcome::Error {
                    kind,
                    message: format!("{message}\n{told}"),
                })
            }
            other => other,
        };
        outcome
    }

    #[allow(clippy::too_many_arguments)]
    async fn exchange(
        &mut self,
        name: &str,
        info: &ToolInfo,
        args: &Value,
        cancel: &AtomicBool,
        progress: &mut Vec<Value>,
        call_id: &str,
        staged: Option<PathBuf>,
    ) -> Result<CallOutcome> {
        let call_id = call_id.to_string();
        self.send(&json!({"type":"call","callId":call_id,"name":name,"args":args}))
            .await?;
        let mut cancel_sent = false;
        loop {
            let message = tokio::select! {
                message = read_message(&mut self.stdout, &mut self.pending) => message?,
                () = tokio::time::sleep(Duration::from_millis(25)) => {
                    if cancel.load(Ordering::SeqCst) && !cancel_sent {
                        cancel_sent = true;
                        self.send(&json!({"type":"cancel","callId":call_id})).await?;
                    }
                    continue;
                }
            };
            if message.get("callId").and_then(Value::as_str) != Some(call_id.as_str()) {
                continue;
            }
            match message.get("type").and_then(Value::as_str) {
                Some("validated") => {
                    let normalized = message.get("args").cloned().unwrap_or(Value::Null);
                    let errors = tool_schema::validate(&info.parameters, &normalized, "");
                    if errors.is_empty() {
                        let go = match &staged {
                            Some(dir) => {
                                json!({"type":"go","callId":call_id,"staging":dir,"counted":self.check.report.is_some()})
                            }
                            None => json!({"type":"go","callId":call_id}),
                        };
                        self.send(&go).await?;
                    } else {
                        self.send(&json!({"type":"cancel","callId":call_id}))
                            .await?;
                        let text = tool_schema::failure_text(name, &errors, &normalized);
                        self.drain_until_end(&call_id).await?;
                        return Ok(CallOutcome::Error {
                            kind: "invalid_args".into(),
                            message: text,
                        });
                    }
                }
                Some("progress") => {
                    progress.push(message.get("partial").cloned().unwrap_or(Value::Null))
                }
                Some("result") => {
                    return Ok(CallOutcome::Result {
                        content: message
                            .get("content")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                        details: message.get("details").cloned(),
                        is_error: message
                            .get("isError")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    });
                }
                Some("error") => {
                    return Ok(CallOutcome::Error {
                        kind: message
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("crashed")
                            .to_string(),
                        message: message
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    });
                }
                _ => {}
            }
        }
    }

    async fn drain_until_end(&mut self, call_id: &str) -> Result<()> {
        loop {
            let message = read_message(&mut self.stdout, &mut self.pending).await?;
            if message.get("callId").and_then(Value::as_str) == Some(call_id)
                && matches!(
                    message.get("type").and_then(Value::as_str),
                    Some("error" | "result")
                )
            {
                return Ok(());
            }
        }
    }

    pub async fn shutdown(mut self) -> Result<()> {
        let _ = self.send(&json!({"type":"shutdown"})).await;
        let _ = tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    fn base_env() -> Vec<(String, String)> {
        let mut env = whitelisted_env(std::env::vars());
        env.retain(|(name, _)| !name.starts_with("NEWSROOM_"));
        env.push(("NEWSROOM_TOOL_PROFILE".into(), "full".into()));
        env.push(("NEWSROOM_PHASE".into(), "all".into()));
        env
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tool-host-rs-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn strings(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn the_node_flag_for_env_proxy_is_added_only_when_a_proxy_name_is_set() {
        let with = |name: &str, value: &str| {
            vec![
                ("PATH".to_string(), "x".to_string()),
                (name.to_string(), value.to_string()),
            ]
        };
        for name in ["HTTPS_PROXY", "http_proxy", "ALL_PROXY"] {
            assert_eq!(
                node_proxy_args(&with(name, "set")),
                vec!["--use-env-proxy"],
                "{name}"
            );
        }
        assert!(node_proxy_args(&with("HTTPS_PROXY", " ")).is_empty());
        assert!(node_proxy_args(&with("NO_PROXY", "set")).is_empty());
        assert!(node_proxy_args(&with("PATH", "set")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn the_start_guard_follows_whether_node_accepts_the_env_proxy_flag() {
        use std::os::unix::fs::PermissionsExt;
        // Stand-in executables instead of the machine's node, whose version decides the answer (the flag needs 22.21+; CI pins 22.19.0).
        let dir = tempfile::tempdir().unwrap();
        let stand_in = |name: &str, accepts: bool| {
            let path = dir.path().join(name);
            let body = if accepts {
                "#!/bin/sh\nexit 0\n"
            } else {
                "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = --use-env-proxy ] && exit 9; done\nexit 0\n"
            };
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        };
        assert!(node_knows_env_proxy(&stand_in("node-new", true)));
        assert!(!node_knows_env_proxy(&stand_in("node-old", false)));
        assert!(!node_knows_env_proxy("/nonexistent/node"));
    }

    #[test]
    fn key_like_names_are_recognised_and_dropped_from_the_whitelist() {
        for name in [
            "OPENAI_API_KEY",
            "x_base_url",
            "GH_TOKEN",
            "APP_SECRET",
            "DB_PASSWORD",
            "PASSWORD",
            "NEWSROOM_KEY",
            "NEWSROOM_APIKEY",
            "newsroom_secret",
            "NEWSROOM_PASSWD",
            "NEWSROOM_CREDENTIALS",
            "NEWSROOM_SERVICE_TOKEN_2",
        ] {
            assert!(is_keylike(name), "{name}");
        }
        // NEWSROOM_SANKEY_OTHER_NOTE is a real switch whose name merely contains KEY inside a word
        for name in [
            "PATH",
            "NEWSROOM_PHASE",
            "HTTPS_PROXY",
            "NEWSROOM_SANKEY_OTHER_NOTE",
            "NEWSROOM_KEYBOARD_MODE",
        ] {
            assert!(!is_keylike(name), "{name}");
        }
        let kept = whitelisted_env(
            [
                "PATH",
                "HOME",
                "LC_ALL",
                "NEWSROOM_GROUP_BOUNDARY",
                "NEWSROOM_DEMO_API_KEY",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_BASE_URL",
                "EDITOR",
                "AWS_SESSION_TOKEN",
            ]
            .map(|n| (n.to_string(), "v".to_string())),
        );
        let names: Vec<&str> = kept.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["PATH", "HOME", "LC_ALL", "NEWSROOM_GROUP_BOUNDARY"]);
    }

    // K1055: the grammar tables read NEWSROOM_SYMBOL_MAP when the Node runtime loads, so the switch must reach the host process unchanged;
    // dropped here, the load-time gate would be silently off in the product.
    #[test]
    fn the_symbol_map_switch_reaches_the_node_host_with_its_value() {
        let kept = whitelisted_env(
            [
                ("NEWSROOM_SYMBOL_MAP", "1"),
                ("NEWSROOM_TILE_MAP", "1"),
                ("SYMBOL_MAP", "1"),
            ]
            .map(|(n, v)| (n.to_string(), v.to_string())),
        );
        assert_eq!(
            kept,
            [
                ("NEWSROOM_SYMBOL_MAP".to_string(), "1".to_string()),
                ("NEWSROOM_TILE_MAP".to_string(), "1".to_string())
            ]
        );
    }

    // The flip makes "exactly 0" the only way to turn these two off, so the 0 has to reach the Node host as written (K1140s).
    #[test]
    fn a_zero_for_the_symbol_map_and_location_evidence_switches_reaches_the_node_host_as_written() {
        let kept = whitelisted_env(
            [
                ("NEWSROOM_SYMBOL_MAP", "0"),
                ("NEWSROOM_LOCATION_EVIDENCE", "0"),
                ("LOCATION_EVIDENCE", "0"),
            ]
            .map(|(n, v)| (n.to_string(), v.to_string())),
        );
        assert_eq!(
            kept,
            [
                ("NEWSROOM_SYMBOL_MAP".to_string(), "0".to_string()),
                ("NEWSROOM_LOCATION_EVIDENCE".to_string(), "0".to_string())
            ]
        );
    }

    #[tokio::test]
    async fn the_host_is_not_started_with_a_key_like_variable() {
        let mut env = base_env();
        env.push(("PROBE_API_KEY".into(), "never-printed".into()));
        let dir = scratch("keylike");
        let error = ToolHost::start(
            "node",
            &repo().join("runtime/pi"),
            &repo(),
            &dir,
            &strings(&["artifact_inventory"]),
            env,
        )
        .await
        .err()
        .unwrap();
        let text = error.to_string();
        assert!(
            text.contains("PROBE_API_KEY") && !text.contains("never-printed"),
            "{text}"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_ready_message_with_a_key_like_environment_name_is_refused() {
        let ready =
            json!({"type":"ready","protocol":1,"tools":[],"envNames":["PATH","LEAKED_API_KEY"]});
        let text = check_ready(&ready, &[]).unwrap_err().to_string();
        assert!(text.contains("LEAKED_API_KEY"), "{text}");
    }

    #[test]
    fn a_ready_message_is_checked_against_the_allow_list_and_groups_json() {
        let tool = |name: &str, group: &str| json!({"name":name,"group":group,"parameters":{"type":"object","properties":{}}});
        let ready =
            |tools: Value| json!({"type":"ready","protocol":1,"tools":tools,"envNames":["PATH"]});
        let allowed = strings(&["artifact_inventory"]);
        let groups: Value = serde_json::from_str(GROUPS_JSON).unwrap();
        let real = groups["tools"]["artifact_inventory"]["group"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(check_ready(&ready(json!([tool("artifact_inventory", &real)])), &allowed).is_ok());
        assert!(
            check_ready(&ready(json!([tool("duckdb_query", "knowledge")])), &allowed)
                .unwrap_err()
                .to_string()
                .contains("outside the allow list")
        );
        assert!(check_ready(
            &ready(json!([tool("artifact_inventory", "no-such-group")])),
            &allowed
        )
        .unwrap_err()
        .to_string()
        .contains("groups.json says"));
        assert!(check_ready(
            &ready(json!([tool("made_up_tool", "agent")])),
            &strings(&["made_up_tool"])
        )
        .unwrap_err()
        .to_string()
        .contains("not in groups.json"));
        let odd = json!({"name":"artifact_inventory","group":"x","parameters":{"type":"object","properties":{"a":{"type":"string","format":"date"}}}});
        assert!(check_ready(&ready(json!([odd])), &allowed).is_err());
    }

    #[tokio::test]
    async fn the_host_lists_exactly_the_allowed_tools_and_runs_a_call() {
        let dir = scratch("flow");
        let allowed = strings(&["artifact_inventory", "newsroom_update_plan"]);
        let mut host = ToolHost::start(
            "node",
            &repo().join("runtime/pi"),
            &repo(),
            &dir,
            &allowed,
            base_env(),
        )
        .await
        .unwrap();
        assert_eq!(
            host.tools().keys().cloned().collect::<Vec<_>>(),
            ["artifact_inventory", "newsroom_update_plan"]
        );

        for (name, info) in host.tools() {
            assert!(
                !info.description.is_empty() && !info.group.is_empty(),
                "{name}"
            );
        }
        let cancel = AtomicBool::new(false);
        let ok = host
            .call("artifact_inventory", &json!({}), &cancel, &mut Vec::new())
            .await
            .unwrap();
        assert!(
            matches!(
                ok,
                CallOutcome::Result {
                    is_error: false,
                    ..
                }
            ),
            "{ok:?}"
        );

        let unknown = host
            .call(
                "duckdb_query",
                &json!({"sql":"select 1"}),
                &cancel,
                &mut Vec::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            unknown,
            CallOutcome::Error {
                kind: "unknown_tool".into(),
                message: "No tool named duckdb_query is registered".into()
            }
        );

        let bad = host
            .call(
                "newsroom_update_plan",
                &json!({"goal":5,"steps":"nope"}),
                &cancel,
                &mut Vec::new(),
            )
            .await
            .unwrap();
        match bad {
            CallOutcome::Error { kind, message } => {
                assert_eq!(kind, "invalid_args");
                assert!(
                    message
                        .starts_with("Tool \"newsroom_update_plan\" rejected its arguments:\n  - "),
                    "{message}"
                );
                assert!(message.contains("\n\nArguments as sent:\n{"), "{message}");
            }
            other => panic!("{other:?}"),
        }
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn a_cancel_flag_set_before_the_call_leaves_the_host_usable() {
        let dir = scratch("cancel");
        let allowed = strings(&["artifact_inventory"]);
        let mut host = ToolHost::start(
            "node",
            &repo().join("runtime/pi"),
            &repo(),
            &dir,
            &allowed,
            base_env(),
        )
        .await
        .unwrap();
        let cancel = AtomicBool::new(true);
        let outcome = host
            .call("artifact_inventory", &json!({}), &cancel, &mut Vec::new())
            .await
            .unwrap();
        assert!(
            matches!(
                outcome,
                CallOutcome::Result { .. } | CallOutcome::Error { .. }
            ),
            "{outcome:?}"
        );
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_snippet_and_guidelines_of_a_reported_tool_are_kept_and_absent_ones_are_empty() {
        let groups: Value = serde_json::from_str(GROUPS_JSON).unwrap();
        let real = groups["tools"]["artifact_inventory"]["group"]
            .as_str()
            .unwrap();
        let ready = json!({"type":"ready","protocol":1,"envNames":["PATH"],"tools":[
            {"name":"artifact_inventory","group":real,"parameters":{"type":"object","properties":{}},
             "promptSnippet":"List the run's artifacts.","promptGuidelines":["First rule.", 7, "Second rule."]}]});
        let tools = check_ready(&ready, &strings(&["artifact_inventory"])).unwrap();
        let info = &tools["artifact_inventory"];
        assert_eq!(
            info.prompt_snippet.as_deref(),
            Some("List the run's artifacts.")
        );
        assert_eq!(info.prompt_guidelines, ["First rule.", "Second rule."]);
        let bare = json!({"type":"ready","protocol":1,"envNames":["PATH"],"tools":[
            {"name":"artifact_inventory","group":real,"parameters":{"type":"object","properties":{}}}]});
        let info =
            &check_ready(&bare, &strings(&["artifact_inventory"])).unwrap()["artifact_inventory"];
        assert!(info.prompt_snippet.is_none() && info.prompt_guidelines.is_empty());
    }

    /// A stand-in host that speaks the protocol and, on `go`, writes the files its arguments name into the staging folder it was given
    /// (`{"files":[{"inside":"own/write/x","text":"..","call":"<inner call id suffix, optional>"}]}`), as the Node write entry points do.
    const FAKE_HOST: &str = r#"
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const pending = new Map();
const tools = ["record_claim", "newsroom_viz_plan"].map((name) => ({ name, group: name === "record_claim" ? "knowledge" : "visual", parameters: { type: "object", properties: { files: { type: "array" } } } }));
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "hello") send({ type: "ready", protocol: 1, tools, envNames: ["PATH"] });
  else if (m.type === "call") { pending.set(m.callId, m); send({ type: "validated", callId: m.callId, args: m.args }); }
  else if (m.type === "go") {
    const call = pending.get(m.callId);
    for (const f of call.args.files ?? []) {
      const base = f.call ? join(dirname(m.staging), m.callId + ":" + f.call) : m.staging;
      const path = join(base, f.inside);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, f.text);
    }
    if (call.args.fail) send({ type: "error", callId: m.callId, kind: "crashed", message: "boom" });
    else {
      const reply = () => {
        const msg = { type: "result", callId: m.callId, content: [{ type: "text", text: "done " + (m.staging ? "staged" : "plain") + (m.counted ? "+counted" : "") + (call.args.tag ?? "") }], isError: false };
        if (call.args.split) {
          const line = JSON.stringify(msg) + "\n";
          const cut = Math.floor(line.length / 2);
          process.stdout.write(line.slice(0, cut));
          setTimeout(() => process.stdout.write(line.slice(cut)), 60);
        } else send(msg);
      };
      if (call.args.hang) setTimeout(reply, call.args.hang); else reply();
    }
  }
  else if (m.type === "cancel") {
    const call = pending.get(m.callId);
    if (call && call.args.answerOnCancel) send({ type: "result", callId: m.callId, content: [{ type: "text", text: "done staged answered" }], isError: false });
    else if (call && call.args.eofOnCancel) { process.stdout.write(JSON.stringify({ type: "result", callId: m.callId, content: [{ type: "text", text: "done at eof" }], isError: false })); process.exit(0); }
  }
  else if (m.type === "shutdown") process.exit(0);
});
"#;

    async fn fake_host(tag: &str, staged: bool) -> (ToolHost, std::path::PathBuf) {
        let dir = scratch(tag);
        let runtime = dir.join("runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("tool_host.mjs"), FAKE_HOST).unwrap();
        let run = dir.join("run");
        std::fs::create_dir_all(&run).unwrap();
        let host = ToolHost::start(
            "node",
            &runtime,
            &dir,
            &run,
            &strings(&["record_claim", "newsroom_viz_plan"]),
            base_env(),
        )
        .await
        .unwrap();
        (
            if staged {
                host.with_staging(&run)
            } else {
                host
            },
            run,
        )
    }

    async fn call(host: &mut ToolHost, tool: &str, args: Value) -> CallOutcome {
        host.call(tool, &args, &AtomicBool::new(false), &mut Vec::new())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_staged_call_writes_into_staging_and_a_legal_file_is_moved_in() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (mut host, run) = fake_host("staged-ok", true).await;
        let outcome = call(
            &mut host,
            "record_claim",
            json!({"files":[{"inside":"own/write/data/a.csv","text":"1\n"}]}),
        )
        .await;
        assert!(
            matches!(&outcome, CallOutcome::Result { content, .. } if content[0]["text"] == "done staged"),
            "{outcome:?}"
        );
        assert_eq!(
            std::fs::read_to_string(run.join("data/a.csv")).unwrap(),
            "1\n"
        );
        assert!(!run.join("staging/c1").exists());
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }

    /// The auto checks drop a step's future when it runs past its limit. The host must still answer the next call with that call's own
    /// result: the late result of the dropped call is skipped by its id, and what the dropped call staged is never moved into the run.
    #[tokio::test]
    async fn a_dropped_call_leaves_the_host_usable_and_its_staged_files_out_of_the_run() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (mut host, run) = fake_host("dropped", true).await;
        let cancel = AtomicBool::new(false);
        let args = json!({"hang":300,"files":[{"inside":"own/write/data/late.csv","text":"1\n"}]});
        let dropped = tokio::time::timeout(
            Duration::from_millis(100),
            host.call("record_claim", &args, &cancel, &mut Vec::new()),
        )
        .await;
        assert!(dropped.is_err(), "the call must still be running");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let outcome = call(&mut host, "record_claim", json!({"tag":" second"})).await;
        assert!(
            matches!(&outcome, CallOutcome::Result { content, .. } if content[0]["text"] == "done staged second"),
            "{outcome:?}"
        );
        assert!(!run.join("data/late.csv").exists());
        assert!(
            !run.join("staging/c1").exists(),
            "the abandoned call's staging folder is removed"
        );
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }

    /// A line that reaches the pipe in two halves with a pause longer than the 25 ms tick of `exchange` between them: the result must still
    /// arrive. With a local line buffer the first half is dropped at the tick, the tail is skipped as not JSON, and the call never ends.
    #[tokio::test]
    async fn a_call_that_answers_after_the_cancel_still_has_its_files_judged_and_moved_in() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (mut host, run) = fake_host("late-answer", true).await;
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let raise = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            raise.store(true, Ordering::SeqCst);
        });
        let args = json!({"hang": 30000, "answerOnCancel": true,
            "files":[{"inside":"own/write/data/late.csv","text":"1\n"}]});
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            host.call("record_claim", &args, &cancel, &mut Vec::new()),
        )
        .await
        .expect("the cancel was not forwarded")
        .unwrap();
        assert!(
            matches!(&outcome, CallOutcome::Result { content, .. } if content[0]["text"] == "done staged answered"),
            "{outcome:?}"
        );
        assert!(run.join("data/late.csv").exists());
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_whole_json_line_at_the_end_of_the_output_is_still_a_message() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (mut host, run) = fake_host("eof-line", true).await;
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let raise = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            raise.store(true, Ordering::SeqCst);
        });
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            host.call(
                "record_claim",
                &json!({"hang": 30000, "eofOnCancel": true}),
                &cancel,
                &mut Vec::new(),
            ),
        )
        .await
        .expect("no answer")
        .unwrap();
        assert!(
            matches!(&outcome, CallOutcome::Result { content, .. } if content[0]["text"] == "done at eof"),
            "{outcome:?}"
        );
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_dropped_call_that_cannot_be_cleaned_leaves_a_note() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("drop-note");
        let run = dir.join("run");
        let sub = run.join("staging/c1/sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("f.csv"), "1").unwrap();
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o555)).unwrap();
        let notes = Arc::new(Mutex::new(Vec::new()));
        drop(Unfinished {
            run: run.clone(),
            call_id: "c1".into(),
            armed: true,
            notes: notes.clone(),
        });
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        let root = std::process::Command::new("id")
            .arg("-u")
            .output()
            .map(|o| o.stdout == b"0\n")
            .unwrap_or(false);
        if !root {
            let notes = notes.lock().unwrap();
            assert_eq!(notes.len(), 1);
            assert!(notes[0].contains("c1") && notes[0].contains("1 folder"));
        }
    }

    #[tokio::test]
    async fn a_line_split_across_two_ticks_still_arrives_whole() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (mut host, run) = fake_host("split", true).await;
        let cancel = AtomicBool::new(false);
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            host.call(
                "record_claim",
                &json!({"split":true}),
                &cancel,
                &mut Vec::new(),
            ),
        )
        .await
        .expect("the split line was lost")
        .unwrap();
        assert!(
            matches!(&outcome, CallOutcome::Result { content, .. } if content[0]["text"] == "done staged"),
            "{outcome:?}"
        );
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }

    /// A resumed run starts a new host whose first call is `c1` again. A `staging/c1` that an earlier host left behind must not be taken
    /// for this call's output.
    #[tokio::test]
    async fn a_staging_folder_left_by_an_earlier_host_is_not_taken_for_a_new_call() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = scratch("stale");
        let run = dir.join("run");
        std::fs::create_dir_all(run.join("staging/c1/own/write/data")).unwrap();
        std::fs::write(run.join("staging/c1/own/write/data/x.csv"), "old\n").unwrap();
        let runtime = dir.join("runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("tool_host.mjs"), FAKE_HOST).unwrap();
        let mut host = ToolHost::start(
            "node",
            &runtime,
            &dir,
            &run,
            &strings(&["record_claim", "newsroom_viz_plan"]),
            base_env(),
        )
        .await
        .unwrap()
        .with_staging(&run);
        let outcome = call(&mut host, "record_claim", json!({})).await;
        assert!(
            matches!(&outcome, CallOutcome::Result { content, .. } if content[0]["text"] == "done staged"),
            "{outcome:?}"
        );
        assert!(
            !run.join("data/x.csv").exists(),
            "the old host's file reached the run"
        );
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn a_cross_group_file_turns_the_result_into_an_error_and_only_that_file_is_dropped() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (mut host, run) = fake_host("staged-bad", true).await;
        let outcome = call(
            &mut host,
            "newsroom_viz_plan",
            json!({"files":[
                {"inside":"own/write/visualizations/ok.svg","text":"<svg/>"},
                {"inside":"own/write/claims.jsonl","text":"{}"}]}),
        )
        .await;
        // told the way the failed write would have told it: an error result with the refusal text
        let CallOutcome::Result {
            content, is_error, ..
        } = outcome
        else {
            panic!("an error result is expected")
        };
        let message = content[0]["text"].as_str().unwrap();
        assert!(is_error);
        assert!(
            message.contains("may not write claims.jsonl")
                && message.contains("the tools you can call there: record_claim")
                && !message.contains("Use knowledge_writer"),
            "{message}"
        );
        assert!(!run.join("claims.jsonl").exists());
        assert!(
            run.join("visualizations/ok.svg").is_file(),
            "the legal file of the same call stays"
        );
        assert!(!run.join("staging/c1").exists());
        let log = std::fs::read_to_string(run.join("runtime/boundary-refusals.jsonl")).unwrap();
        assert_eq!(log.lines().count(), 1, "{log}");
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn an_inner_call_is_judged_as_the_inner_tool_and_a_failed_call_keeps_its_legal_writes() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (mut host, run) = fake_host("staged-inner", true).await;
        let outcome = call(
            &mut host,
            "newsroom_viz_plan",
            json!({"files":[{"call":"record_claim","inside":"own/write/claims.jsonl","text":"{}\n"}]}),
        )
        .await;
        assert!(matches!(outcome, CallOutcome::Result { .. }), "{outcome:?}");
        assert!(run.join("claims.jsonl").is_file());
        let outcome = call(
            &mut host,
            "record_claim",
            json!({"fail":true,"files":[{"inside":"own/write/data/b.csv","text":"2\n"}]}),
        )
        .await;
        assert!(
            matches!(outcome, CallOutcome::Error { ref kind, .. } if kind == "crashed"),
            "{outcome:?}"
        );
        assert!(
            run.join("data/b.csv").is_file() && !run.join("staging/c2").exists(),
            "failure evidence is kept"
        );
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_different_immutable_file_is_reported_with_the_tools_own_sentence() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (mut host, run) = fake_host("staged-once", true).await;
        std::fs::create_dir_all(run.join("data")).unwrap();
        std::fs::write(run.join("data/a.csv"), "old\n").unwrap();
        let outcome = call(
            &mut host,
            "record_claim",
            json!({"files":[{"inside":"own/once/data/a.csv","text":"new\n"}]}),
        )
        .await;
        let CallOutcome::Result {
            content, is_error, ..
        } = outcome
        else {
            panic!("an error result is expected")
        };
        assert!(is_error);
        assert_eq!(
            content[0]["text"],
            "Immutable artifact collision: existing bytes differ at data/a.csv"
        );
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn without_staging_the_go_message_is_the_old_one() {
        let (mut host, run) = fake_host("plain", false).await;
        let outcome = call(&mut host, "record_claim", json!({"files":[]})).await;
        assert!(
            matches!(&outcome, CallOutcome::Result { content, .. } if content[0]["text"] == "done plain"),
            "{outcome:?}"
        );
        assert!(!run.join("staging").exists());
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_counting_host_is_told_so_runs_the_operations_and_counts_what_passed() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (host, run) = fake_host("counted", true).await;
        let mut host = host.with_report(false);
        std::fs::create_dir_all(run.join("visualizations")).unwrap();
        std::fs::write(run.join("visualizations/old.json"), "{}").unwrap();
        let outcome = call(
            &mut host,
            "newsroom_viz_plan",
            json!({"files":[
                {"inside":"own/write/visualizations/a.svg","text":"<svg/>"},
                {"inside":"ops.jsonl","text":"{\"op\":\"unlink\",\"from\":\"visualizations/old.json\"}\n"},
            ]}),
        )
        .await;
        assert!(
            matches!(&outcome, CallOutcome::Result { content, is_error: false, .. } if content[0]["text"] == "done staged+counted"),
            "{outcome:?}"
        );
        assert!(run.join("visualizations/a.svg").exists());
        assert!(!run.join("visualizations/old.json").exists());
        let report: Value = serde_json::from_str(
            &std::fs::read_to_string(run.join("runtime/group-boundary-report.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(report["totals"]["writes"], 2, "{report}");
        host.shutdown().await.unwrap();
        std::fs::remove_dir_all(run.parent().unwrap()).ok();
    }
}
