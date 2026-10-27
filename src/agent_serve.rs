//! The Rust agent as the child process of a run (1011ak step 9a, `NEWSROOM_AGENT=rust`, exactly that value, default off).
//!
//! `news` starts this where it used to start Pi: the same binary, first argument `__agent_rpc`, speaking the same JSONL protocol on
//! stdin and stdout (prompt, abort, get_last_assistant_text, get_session_stats in; the run's events out). The parent's reader, its time
//! limits, its process group handling and every gate after the run stay exactly as they are; only the producer of the events changes.
//!
//! This version only talks to a stand-in model on this machine: the address comes from `NEWSROOM_AGENT_LOCAL_URL` and must be
//! 127.0.0.1 or localhost; the key is a fixed literal that is not a credential. Nothing here reads the user's configuration, a `.env`
//! file or any key (`main` leaves `load_project_env` out for this path too). The tool host is started with the same
//! whitelisted environment as in the tests (key-like and endpoint names dropped).
//!
//! Gate A (`NEWSROOM_AGENT_REAL=1`, exactly, together with `NEWSROOM_AGENT=rust`; default off, and off changes nothing above): the child
//! talks to a real model. The key never travels in the child's arguments or environment. The parent computes the route (provider
//! normalisation, address, optional proxy) and sends one first protocol line on stdin, `{"type":"model_config","base_url":..,"proxy":..,"api_key":..}`.
//! The child keeps it in memory only (never on disk, in an event, in an error text or in the tool host's environment), sends no model request
//! before it has arrived, and refuses a second one.

use crate::agent_loop::{Agent, Config};
use crate::anthropic_model::{AnthropicConfig, AnthropicModel, ToolDef};
use crate::tool_host::{whitelisted_env, ToolHost};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

/// The first argument that makes `news` the Rust agent child of a run (only honoured with `NEWSROOM_AGENT=rust`).
pub const SERVE_ARG: &str = "__agent_rpc";
/// Where the stand-in model listens: 127.0.0.1 or localhost only.
pub const LOCAL_URL_ENV: &str = "NEWSROOM_AGENT_LOCAL_URL";
/// The parent's command name, so the child's own writes are judged under the same command and group.
pub const COMMAND_ENV: &str = "NEWSROOM_AGENT_COMMAND";
/// Not a credential: the stand-in relay ignores the key, and this version never reads a real one.
const STANDIN_KEY: &str = "standin-local-key";
const DEFAULT_MODEL: &str = "standin";
/// Gate A switch: only the exact value "1" turns the real-model route on.
pub const REAL_ENV: &str = "NEWSROOM_AGENT_REAL";
/// The type of the first protocol line that hands the model route to the child.
pub const HANDOFF_TYPE: &str = "model_config";
const STANDIN_ONLY: &str = "the Rust agent path only supports a stand-in model on this machine in this version; set NEWSROOM_AGENT_LOCAL_URL to an http://127.0.0.1:<port> or http://localhost:<port> address";

fn real_selected(value: Option<&str>) -> bool {
    value == Some("1")
}

pub fn real_enabled() -> bool {
    real_selected(std::env::var(REAL_ENV).ok().as_deref())
}

/// What the parent hands over: the resolved address, an optional proxy and the key. `Debug` never shows the key or the proxy.
#[derive(Clone, PartialEq)]
pub struct Handoff {
    pub base_url: String,
    pub proxy: Option<String>,
    api_key: String,
}

impl std::fmt::Debug for Handoff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Handoff { .. }")
    }
}

impl Handoff {
    pub fn new(base_url: &str, proxy: Option<&str>, api_key: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            proxy: proxy.filter(|p| !p.trim().is_empty()).map(str::to_string),
            api_key: api_key.to_string(),
        }
    }

    /// The protocol line (as a value) the parent writes first.
    pub fn message(&self) -> Value {
        json!({"type": HANDOFF_TYPE, "base_url": self.base_url, "proxy": self.proxy, "api_key": self.api_key})
    }

    /// What the new route scans out of every exchange it would write: the key, the proxy's pieces, and the address with its
    /// host as written and lowercased (a client's connection error names the address or the host it could not reach). The
    /// host is listed without its port ("relay.example", not "relay.example:8443"), as a name (a dot, a letter, 4 characters
    /// or more) or as an IPv4 address; the scan matches an IPv4 entry only standing apart from other numbers ("110.1.2.35"
    /// does not hold 10.1.2.3).
    pub fn secrets(&self) -> Vec<String> {
        let rest = self.base_url.split_once("://").map_or(self.base_url.as_str(), |(_, rest)| rest);
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
        let host = match host.strip_prefix('[') {
            Some(v6) => v6.split(']').next().unwrap_or(""),
            None => host.split(':').next().unwrap_or(""),
        };
        let named = host.len() >= 4 && host.contains('.') && host.bytes().any(|b| b.is_ascii_alphabetic());
        let ip = host.parse::<std::net::Ipv4Addr>().is_ok();
        let hosts = if named || ip { vec![host.to_string(), host.to_ascii_lowercase()] } else { Vec::new() };
        let mut out: Vec<String> = [self.api_key.clone(), self.base_url.clone()]
            .into_iter()
            .chain(hosts)
            .chain(self.proxy.iter().flat_map(|p| crate::llm::proxy_secrets(p)))
            .filter(|s| !s.is_empty())
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Reads the first line. Errors never contain the key or the proxy.
    pub fn parse(value: &Value) -> Result<Self> {
        let text = |name: &str| {
            value
                .get(name)
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty())
        };
        let base_url = text("base_url").context("the model configuration has no address")?;
        let api_key = text("api_key").context("the model configuration has no key")?;
        let proxy = value.get("proxy").and_then(Value::as_str);
        let https = base_url
            .get(..8)
            .is_some_and(|p| p.eq_ignore_ascii_case("https://"));
        if !(https || crate::anthropic_model::is_loopback(base_url)) {
            bail!(
                "the model address must be https:// (plain http is only accepted for this machine)"
            );
        }
        Ok(Self::new(base_url, proxy, api_key))
    }
}

/// The model of a real-model child before and after the handoff. Until the configuration has arrived every request is refused
/// without any network traffic; the slot is filled once by the stdin reader.
pub struct DeferredModel {
    slot: Arc<Mutex<Option<AnthropicModel>>>,
    inner: Option<AnthropicModel>,
}

impl DeferredModel {
    pub fn new(slot: Arc<Mutex<Option<AnthropicModel>>>) -> Self {
        Self { slot, inner: None }
    }
}

#[async_trait::async_trait]
impl crate::agent_loop::Model for DeferredModel {
    async fn respond(
        &mut self,
        request: &crate::agent_loop::ModelRequest<'_>,
        cancel: &std::sync::atomic::AtomicBool,
        pieces: crate::agent_loop::Pieces<'_>,
    ) -> Option<Value> {
        if self.inner.is_none() {
            self.inner = self.slot.lock().ok().and_then(|mut s| s.take());
        }
        match self.inner.as_mut() {
            Some(model) => model.respond(request, cancel, pieces).await,
            None => Some(json!({
                "content": [],
                "stopReason": "error",
                "errorMessage": "the model configuration has not been received yet; no request was sent",
                "usage": {}
            })),
        }
    }
}

/// True when the key already sits in this process's own arguments or environment: then the handoff did not keep it out, and the child refuses to use it.
/// Keys shorter than 8 bytes are not looked for (too short to tell a key from any other text).
pub fn key_in_own_process(
    key: &str,
    args: impl IntoIterator<Item = String>,
    vars: impl IntoIterator<Item = (String, String)>,
) -> bool {
    key.len() >= 8
        && (args.into_iter().any(|a| a.contains(key))
            || vars.into_iter().any(|(_, v)| v.contains(key)))
}

/// What the stdin reader does with a line while a real-model child waits for its configuration.
#[derive(Debug, PartialEq)]
pub enum HandoffStep {
    /// Not a handoff line: pass it on as before.
    Forward,
    /// First handoff accepted; the model is ready.
    Accepted(Handoff),
    /// A handoff line that was refused (second one, or malformed); the text holds no secret.
    Refused(&'static str),
}

/// Tracks that the handoff happens exactly once.
#[derive(Default)]
pub struct HandoffGate {
    received: bool,
}

impl HandoffGate {
    pub fn step(&mut self, line: &str) -> HandoffStep {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return HandoffStep::Forward;
        };
        if value["type"] != HANDOFF_TYPE {
            return HandoffStep::Forward;
        }
        if self.received {
            return HandoffStep::Refused("the model configuration was already received");
        }
        match Handoff::parse(&value) {
            Ok(handoff) => {
                self.received = true;
                HandoffStep::Accepted(handoff)
            }
            Err(_) => HandoffStep::Refused("the model configuration is not valid"),
        }
    }
}

/// The stand-in address, or the reason this version refuses to start. Only the address is looked at, never any key or configuration file.
pub fn local_url() -> Result<String> {
    let url = std::env::var(LOCAL_URL_ENV).unwrap_or_default();
    check_local_url(&url)?;
    Ok(url)
}

fn check_local_url(url: &str) -> Result<()> {
    if !crate::anthropic_model::is_loopback(url) {
        bail!("{STANDIN_ONLY}");
    }
    Ok(())
}

/// The part of the Pi command line this child understands; every other Pi flag is ignored.
#[derive(Debug, Default, PartialEq)]
pub struct ServeArgs {
    pub session_dir: Option<PathBuf>,
    pub continue_session: bool,
    pub model: Option<String>,
    pub extension: Option<PathBuf>,
    pub tools: Vec<String>,
}

pub fn parse_args(args: &[String]) -> ServeArgs {
    let mut out = ServeArgs::default();
    let mut i = 0;
    while i < args.len() {
        let value = args.get(i + 1);
        match (args[i].as_str(), value) {
            ("--session-dir", Some(v)) => {
                out.session_dir = Some(PathBuf::from(v));
                i += 1;
            }
            ("-c", _) => out.continue_session = true,
            ("--model", Some(v)) => {
                out.model = Some(v.clone());
                i += 1;
            }
            ("-e", Some(v)) => {
                out.extension = Some(PathBuf::from(v));
                i += 1;
            }
            ("--tools", Some(v)) => {
                out.tools = v
                    .split(',')
                    .filter(|t| !t.is_empty())
                    .map(str::to_string)
                    .collect();
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// One line of stdout per event; stdout is the protocol, so nothing else is ever printed there.
fn emit(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// Runs the child: reads commands from stdin until it closes, answers on stdout.
pub async fn serve(args: Vec<String>) -> Result<()> {
    let parsed = parse_args(&args);
    let real = real_enabled();
    // gate A: the address comes with the handoff, not from here; off, only the local stand-in is accepted as before
    let base_url = if real { String::new() } else { local_url()? };
    let run_dir = PathBuf::from(
        std::env::var("NEWSROOM_ARTIFACT_DIR")
            .context("the Rust agent needs the run folder (NEWSROOM_ARTIFACT_DIR)")?,
    );
    let extension = parsed
        .extension
        .clone()
        .context("the Rust agent needs the materialized runtime (-e <newsroom.ts>)")?;
    let runtime_dir = extension
        .parent()
        .map(Path::to_path_buf)
        .context("the runtime folder cannot be found")?;
    let cwd = std::env::current_dir().context("no working directory")?;

    let env = whitelisted_env(std::env::vars());
    let host = ToolHost::start("node", &runtime_dir, &cwd, &run_dir, &parsed.tools, env)
        .await?
        .with_staging(&run_dir);
    let host = if crate::group_guard::report_enabled() {
        host.with_report(crate::group_guard::status_computed_enabled())
    } else {
        host
    };

    let model_name = parsed.model.as_deref().unwrap_or(DEFAULT_MODEL).to_string();
    let mut config = AnthropicConfig::new(&base_url, STANDIN_KEY, &model_name);
    config.system = crate::agent_prompt::system_prompt(host.tools(), &parsed.tools, &run_dir);
    config.name_unfinished_tool = crate::pi::speed_switches_from_env().design_pack;
    config.tools = parsed
        .tools
        .iter()
        .filter_map(|name| {
            host.tools().get(name).map(|info| ToolDef {
                name: name.clone(),
                description: info.description.clone(),
                parameters: info.parameters.clone(),
            })
        })
        .collect();
    // the new route (NEWSROOM_NEXT=1) offers one tool per step itself and asks with its own system text
    let next = crate::next_flow::next_enabled();
    if next {
        config.system = crate::next_serve::SYSTEM.to_string();
        config.tools.clear();
    }
    let slot: Arc<Mutex<Option<AnthropicModel>>> = Arc::new(Mutex::new(None));
    // the new route's exchanges are scanned for the handed-over key and the proxy's pieces
    let secrets: Arc<Mutex<Vec<String>>> = Arc::default();

    if let Some(name) = std::env::var(COMMAND_ENV)
        .ok()
        .and_then(|n| crate::cli::COMMAND_ORDER.iter().copied().find(|c| *c == n))
    {
        crate::group_guard::enter_command(name, crate::cli::group_of(name));
    }
    if next {
        let standin = if real { None } else { Some(standin_model(&config)?) };
        let asker = crate::next_serve::NextAsker::new(standin, slot.clone());
        let child =
            crate::next_serve::NextServe::new(host, asker, run_dir.clone(), parsed.continue_session, secrets.clone());
        let cancel = child.cancel.clone();
        let incoming = spawn_reader(real, config, slot, secrets, cancel);
        let mut child = child;
        while let Ok(line) = incoming.recv() {
            child.command(&line, &mut |event| emit(&event)).await;
        }
        return Ok(());
    }
    let model: Box<dyn crate::agent_loop::Model + Send> = if real {
        Box::new(DeferredModel::new(slot.clone()))
    } else {
        Box::new(standin_model(&config)?)
    };
    let cwd_text = cwd.display().to_string();
    let agent = Agent::new(
        model,
        Box::new(crate::recipes::AfterDownload::new(
            host,
            &run_dir,
            crate::pi::speed_switches_from_env().recipes,
        )),
        Config::default(),
    );
    let agent = agent
        .with_auto_checks(
            crate::auto_checks::enabled(),
            crate::auto_checks::images_on(),
        )
        .with_auto_publish(crate::auto_checks::publish_enabled())
        .with_pack_split(crate::pi::speed_switches_from_env().design_pack)
        .with_run_stop(crate::pi::speed_switches_from_env().page_build);
    let mut agent = if parsed.continue_session {
        agent.with_resumed_session(&run_dir, &cwd_text)
    } else {
        agent.with_new_session(&run_dir, &cwd_text)
    }
    .map_err(|e| anyhow::anyhow!("session record could not be opened: {e}"))?;

    // Commands arrive on a reader task so that `abort` takes effect while a prompt is running; everything else is answered in order.
    let incoming = spawn_reader(real, config, slot, secrets, agent.cancel.clone());
    // idle between commands, so waiting here holds nothing else up
    while let Ok(line) = incoming.recv() {
        agent.command(&line, &mut |event| emit(&event)).await;
    }
    Ok(())
}

/// Reads stdin on its own thread (tokio's stdin is not enabled in this build): the handoff line is taken here (gate A), `abort` sets
/// `cancel` at once, every other line goes to the returned channel in order. `secrets` gets the handed-over key and the proxy's
/// pieces, in memory only, for the new route's exchange scan.
fn spawn_reader(
    real: bool,
    config: AnthropicConfig,
    slot: Arc<Mutex<Option<AnthropicModel>>>,
    secrets: Arc<Mutex<Vec<String>>>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
) -> std::sync::mpsc::Receiver<String> {
    let (lines, incoming) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let mut gate = HandoffGate::default();
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if real {
                match gate.step(&line) {
                    HandoffStep::Forward => {}
                    HandoffStep::Accepted(handoff) => {
                        if key_in_own_process(&handoff.api_key, std::env::args(), std::env::vars())
                        {
                            emit(
                                &json!({"type": "response", "command": HANDOFF_TYPE, "success": false,
                                "error": "the key was found in this process's own arguments or environment; it is not used"}),
                            );
                            continue;
                        }
                        let mut model_config = config.clone_template();
                        model_config.base_url = handoff.base_url.clone();
                        let built = model_config
                            .with_key(&handoff.api_key)
                            .with_route(handoff.proxy.clone());
                        if let Ok(mut s) = secrets.lock() {
                            *s = handoff.secrets();
                        }
                        let ok = match AnthropicModel::new(built) {
                            Ok(model) => {
                                if let Ok(mut s) = slot.lock() {
                                    *s = Some(model);
                                }
                                true
                            }
                            Err(_) => false,
                        };
                        emit(&json!({"type": "response", "command": HANDOFF_TYPE, "success": ok}));
                        continue;
                    }
                    HandoffStep::Refused(why) => {
                        emit(
                            &json!({"type": "response", "command": HANDOFF_TYPE, "success": false, "error": why}),
                        );
                        continue;
                    }
                }
            }
            let parsed = serde_json::from_str::<Value>(&line).ok();
            if parsed.as_ref().is_some_and(|v| v["type"] == "abort") {
                cancel.store(true, Ordering::SeqCst);
                let mut response = json!({"type": "response", "command": "abort", "success": true});
                if let Some(id) = parsed.as_ref().and_then(|v| v.get("id")) {
                    response["id"] = id.clone();
                }
                emit(&response);
            } else if lines.send(line).is_err() {
                break;
            }
        }
        // stdin closed: the parent is gone (it was killed or crashed), so a run still going must not keep asking the model
        cancel.store(true, Ordering::SeqCst);
    });
    incoming
}

/// The switch-off path: exactly the client this child always had, with the stand-in key in `x-api-key` (the template copy has an empty key).
fn standin_model(config: &AnthropicConfig) -> Result<AnthropicModel> {
    AnthropicModel::new(config.clone_template().with_key(STANDIN_KEY))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_handed_address_key_and_proxy_are_secrets_of_the_new_route() {
        let handoff = Handoff::new(
            "https://Relay-Host.invalid/anthropic",
            Some("http://u:p4ss@proxy.invalid:8080"),
            "sk-ant-handoff-key-0123",
        );
        let secrets = handoff.secrets();
        for error in [
            "error sending request for url (https://relay-host.invalid/anthropic/v1/messages)",
            "failed to lookup address information for Relay-Host.invalid",
            "HTTP 401: key sk-ant-handoff-key-0123 is not valid",
            "proxy authentication with p4ss was refused",
        ] {
            let reply = json!({"content": [], "stopReason": "error", "errorMessage": error});
            assert_eq!(
                crate::next_flow::secret_in(&reply, &secrets),
                Some(crate::next_flow::SecretKind::Handoff),
                "{error}"
            );
        }
        let reply = json!({"content": [{"type": "text", "text": "the anthropic share rose"}]});
        assert_eq!(crate::next_flow::secret_in(&reply, &secrets), None);
        // an IP host is caught alone, but never inside a longer number
        let by_ip = Handoff::new("https://10.1.2.3:8443/anthropic", None, "sk-ant-handoff-key-0123").secrets();
        for row in ["row 110.1.2.35 of the table", "version 10.1.2.3.5", "share 5.10.1.2.3"] {
            let row = json!({"content": [{"type": "text", "text": row}]});
            assert_eq!(crate::next_flow::secret_in(&row, &by_ip), None, "{row}");
        }
        for error in [
            "error sending request for url (https://10.1.2.3:8443/anthropic/v1/messages)",
            "tcp connect error: 10.1.2.3:443",
            "connection refused (10.1.2.3)",
            "could not reach 10.1.2.3.",
            "10.1.2.3",
        ] {
            let error = json!({"errorMessage": error});
            assert_eq!(crate::next_flow::secret_in(&error, &by_ip), Some(crate::next_flow::SecretKind::Handoff), "{error}");
        }
    }

    #[test]
    fn a_host_is_listed_without_its_port() {
        let named = Handoff::new("https://relay.example:8443/x", None, "sk-ant-handoff-key-0123").secrets();
        assert!(named.contains(&"relay.example".to_string()), "{named:?}");
        assert!(!named.iter().any(|s| s == "relay.example:8443"));
        let error = json!({"errorMessage": "failed to lookup address information for relay.example"});
        assert_eq!(crate::next_flow::secret_in(&error, &named), Some(crate::next_flow::SecretKind::Handoff));
        let with_user = Handoff::new("https://u@relay.example:8443?x=1", None, "sk-ant-handoff-key-0123").secrets();
        assert!(with_user.contains(&"relay.example".to_string()), "{with_user:?}");
        let v6 = Handoff::new("https://[2001:db8::1]:8443/x", None, "sk-ant-handoff-key-0123").secrets();
        // an IPv6 host has no dot and is caught only as part of its address
        assert_eq!(v6, strings(&["https://[2001:db8::1]:8443/x", "sk-ant-handoff-key-0123"]));
    }

    #[test]
    fn only_a_local_stand_in_address_is_accepted() {
        for ok in [
            "http://127.0.0.1:8123",
            "http://localhost:8123",
            "http://127.0.0.1",
            "http://localhost/",
        ] {
            assert!(check_local_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "https://api.example.com",
            "http://127.0.0.1.evil.example:80",
            "http://example.com:80/127.0.0.1",
            "http://localhost.evil.example",
            "https://127.0.0.1:8123",
            "127.0.0.1:8123",
            "http://10.0.0.1:80",
            "http://[::1]:80",
            "http://user@evil.example/",
            "http://localhost:80@evil.example/",
            "http://127.0.0.1.nip.io:80",
        ] {
            let text = check_local_url(bad).unwrap_err().to_string();
            assert!(text.contains("stand-in model on this machine"), "{bad}");
        }
    }

    #[test]
    fn the_child_reads_only_the_flags_it_understands_and_ignores_the_rest() {
        let args = strings(&[
            "--session-dir",
            "/r/session",
            "-c",
            "--provider",
            "anthropic",
            "--model",
            "m1",
            "--thinking",
            "off",
            "--no-extensions",
            "-e",
            "/r/runtime/newsroom.ts",
            "--no-skills",
            "--tools",
            "a,b,c",
            "--no-approve",
        ]);
        assert_eq!(
            parse_args(&args),
            ServeArgs {
                session_dir: Some("/r/session".into()),
                continue_session: true,
                model: Some("m1".into()),
                extension: Some("/r/runtime/newsroom.ts".into()),
                tools: strings(&["a", "b", "c"]),
            }
        );
        assert_eq!(parse_args(&[]), ServeArgs::default());
    }

    const KEY: &str = "e7-handed-key-0000-not-real";

    fn handoff_line(base: &str) -> String {
        Handoff::new(base, None, KEY).message().to_string()
    }

    #[test]
    fn the_handoff_roundtrips_and_never_shows_its_key_in_debug_or_errors() {
        let handoff = Handoff::new("https://relay.example.invalid", Some("http://p:1"), KEY);
        assert_eq!(Handoff::parse(&handoff.message()).unwrap(), handoff);
        assert!(!format!("{handoff:?}").contains(KEY));
        for bad in [
            json!({"type": HANDOFF_TYPE, "base_url": "https://x.invalid"}),
            json!({"type": HANDOFF_TYPE, "api_key": KEY}),
            json!({"type": HANDOFF_TYPE, "base_url": "http://relay.example.invalid", "api_key": KEY}),
            json!({"type": HANDOFF_TYPE, "base_url": "", "api_key": KEY}),
        ] {
            let text = format!("{:#}", Handoff::parse(&bad).unwrap_err());
            assert!(!text.contains(KEY), "{text}");
        }
        assert!(Handoff::parse(&Handoff::new("http://127.0.0.1:9", None, KEY).message()).is_ok());
    }

    #[test]
    fn the_first_handoff_is_accepted_and_a_second_one_is_refused() {
        let mut gate = HandoffGate::default();
        assert_eq!(
            gate.step(r#"{"type":"prompt","message":"hi"}"#),
            HandoffStep::Forward
        );
        assert_eq!(gate.step("not json"), HandoffStep::Forward);
        // a broken first handoff does not use up the one allowed
        assert!(matches!(
            gate.step(r#"{"type":"model_config","base_url":"http://evil.invalid","api_key":"k"}"#),
            HandoffStep::Refused(_)
        ));
        let first = handoff_line("http://127.0.0.1:9");
        assert!(
            matches!(gate.step(&first), HandoffStep::Accepted(h) if h.message()["api_key"] == KEY)
        );
        let second = gate.step(&handoff_line("http://127.0.0.1:10"));
        assert!(matches!(second, HandoffStep::Refused(text) if !text.contains(KEY)));
        // the line is never passed on to the agent
        assert!(!matches!(gate.step(&first), HandoffStep::Forward));
    }

    async fn ask(model: &mut DeferredModel, history: &[Value]) -> Value {
        use crate::agent_loop::{Model, ModelRequest};
        model
            .respond(
                &ModelRequest { history },
                &std::sync::atomic::AtomicBool::new(false),
                &mut |_, _| {},
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn no_model_request_leaves_before_the_handoff_and_the_key_goes_out_after_it() {
        use crate::model_fake::{loopback_only, serve, Script};
        let refusal = |status| {
            Script::Reply {
            status,
            content_type: "application/json",
            body: json!({"type": "error", "error": {"type": "invalid_request_error", "message": "stand-in refusal"}}).to_string(),
        }
        };
        let fake = serve(vec![refusal(400)]);
        let slot: Arc<Mutex<Option<AnthropicModel>>> = Arc::default();
        let mut model = DeferredModel::new(slot.clone());
        let history = vec![json!({"role": "user", "content": [{"type": "text", "text": "hi"}]})];
        let early = ask(&mut model, &history).await;
        assert_eq!(early["stopReason"], "error");
        assert!(early["errorMessage"]
            .as_str()
            .unwrap()
            .contains("no request was sent"));
        assert_eq!(
            fake.seen.lock().unwrap().len(),
            0,
            "a request left before the handoff"
        );
        let config = AnthropicConfig::new(loopback_only(&fake.base), KEY, "m1").with_route(None);
        *slot.lock().unwrap() = Some(AnthropicModel::new(config).unwrap());
        let late = ask(&mut model, &history).await;
        assert_eq!(late["stopReason"], "error");
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(
            seen[0].headers.contains(&format!("x-api-key: {KEY}")),
            "the handed key is what authenticates"
        );
        // the key is not in the error text that goes on to the events
        assert!(!late.to_string().contains(KEY));
    }

    #[tokio::test]
    async fn with_the_switch_off_the_request_still_carries_the_stand_in_key() {
        use crate::agent_loop::{Model, ModelRequest};
        use crate::model_fake::{loopback_only, serve, Script};
        let fake = serve(vec![Script::Reply {
            status: 400,
            content_type: "application/json",
            body: json!({"type": "error", "error": {"type": "invalid_request_error", "message": "stand-in refusal"}}).to_string(),
        }]);
        let config = AnthropicConfig::new(loopback_only(&fake.base), STANDIN_KEY, "m1");
        let mut model = standin_model(&config).unwrap();
        let history = vec![json!({"role": "user", "content": [{"type": "text", "text": "hi"}]})];
        let _ = model
            .respond(
                &ModelRequest { history: &history },
                &std::sync::atomic::AtomicBool::new(false),
                &mut |_, _| {},
            )
            .await;
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert!(
            seen[0]
                .headers
                .contains(&format!("x-api-key: {STANDIN_KEY}")),
            "x-api-key must be the stand-in key, as before gate A"
        );
    }

    #[test]
    fn only_the_exact_value_one_switches_the_real_model_route_on() {
        // the pure reading is shared with real_enabled(); the process-wide variable itself is covered in the pi.rs tests
        for other in ["0", "true", "yes", "", " 1", "1 ", "on"] {
            assert_ne!(Some(other), Some("1"));
        }
        assert!(!real_selected(None));
        assert!(real_selected(Some("1")));
        for other in ["0", "true", "yes", "", " 1", "1 ", "on"] {
            assert!(!real_selected(Some(other)), "{other:?}");
        }
    }

    /// Re-run by the pi.rs test `gate_a_child_holds_no_key_in_its_arguments_or_environment` as the child process: it looks at its
    /// own argv and environment. Does nothing in a normal test run.
    #[test]
    fn child_probe_reads_its_own_arguments_and_environment() {
        let Ok(out) = std::env::var("E7_GATE_A_PROBE_OUT") else {
            return;
        };
        // the key to look for arrives on stdin, so the probe itself does not put it into its own environment or arguments
        let mut key = String::new();
        let _ = std::io::stdin().read_line(&mut key);
        let key = key.trim().to_string();
        assert!(!key.is_empty());
        let args: Vec<String> = std::env::args().collect();
        let in_args = args.iter().any(|a| a.contains(&key));
        let in_env = std::env::vars().any(|(_, v)| v.contains(&key));
        let keylike: Vec<String> = std::env::vars()
            .map(|(k, _)| k)
            .filter(|k| {
                k.starts_with("E7GATEA_")
                    || [
                        "SECRET_KEY",
                        "OPENAI_KEY",
                        "APIKEY",
                        "PASSWD",
                        "CREDENTIALS",
                        concat!("NEWSROOM_", "KEY"),
                        concat!("NEWSROOM_", "APIKEY"),
                        "newsroom_secret",
                    ]
                    .contains(&k.as_str())
            })
            .collect();
        let proxies: Vec<String> = std::env::vars()
            .map(|(k, _)| k)
            .filter(|k| {
                ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]
                    .contains(&k.to_ascii_uppercase().as_str())
            })
            .collect();
        // what the tool host would get
        let host_env = whitelisted_env(std::env::vars());
        let in_host = host_env.iter().any(|(_, v)| v.contains(&key));
        let host_proxies: Vec<String> = host_env
            .iter()
            .map(|(k, _)| k.clone())
            .filter(|k| k.to_ascii_uppercase().ends_with("_PROXY"))
            .collect();
        // the new route's catalogue opened from what this child was handed (no table is read)
        let catalogue_open = match crate::next_flow::GroupCatalogue::from_env(|k| std::env::var(k).ok()) {
            Ok(_) => "ok".to_string(),
            Err(stop) => stop.to_string(),
        };
        let news_other_left = std::env::var_os("NEWS_OTHER_DIR").is_some();
        std::fs::write(
            out,
            json!({"args_have_key": in_args, "env_has_key": in_env, "keylike_left": keylike, "proxies_left": proxies, "host_proxies": host_proxies, "host_env_has_key": in_host, "args_seen": args.len(), "catalogue_open": catalogue_open, "news_other_left": news_other_left}).to_string(),
        )
        .unwrap();
    }

    struct NoTools;

    #[async_trait::async_trait]
    impl crate::agent_loop::ToolRunner for NoTools {
        fn exposes(&self, _name: &str) -> bool {
            false
        }
        async fn run(
            &mut self,
            _name: &str,
            _args: &Value,
            _cancel: &std::sync::atomic::AtomicBool,
            _progress: &mut Vec<Value>,
        ) -> Result<crate::tool_host::CallOutcome> {
            bail!("no tools in this test")
        }
    }

    fn all_bytes(dir: &Path) -> Vec<u8> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(all_bytes(&path));
            } else {
                out.extend(std::fs::read(&path).unwrap());
            }
        }
        out
    }

    /// A run through the real client with a handed-over key: failures that echo the key, and a context overflow, leave the key out of every
    /// event, error text and file of the run folder; an overflow is a clear class, is not retried, and the folder is kept.
    #[tokio::test]
    async fn the_key_stays_out_of_events_errors_and_the_run_folder_and_overflow_is_clear() {
        let _command = crate::group_guard::command_for_test("investigate");
        use crate::model_fake::{loopback_only, serve, Script};
        let echo = Script::Reply {
            status: 401,
            content_type: "application/json",
            body: json!({"type": "error", "error": {"type": "authentication_error", "message": format!("invalid x-api-key {KEY}")}}).to_string(),
        };
        let overflow = Script::Reply {
            status: 400,
            content_type: "application/json",
            body: json!({"type": "error", "error": {"type": "invalid_request_error", "message": format!("prompt is too long: 250000 tokens > 200000 maximum (key {KEY})")}}).to_string(),
        };
        let dir = std::env::temp_dir().join(format!("e7-gate-a-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (script, class, retried) in [
            (echo, "provider_authentication_failed", false),
            (overflow, "provider_context_overflow", false),
        ] {
            let fake = serve(vec![script]);
            let slot: Arc<Mutex<Option<AnthropicModel>>> = Arc::default();
            let config =
                AnthropicConfig::new(loopback_only(&fake.base), KEY, "m1").with_route(None);
            *slot.lock().unwrap() = Some(AnthropicModel::new(config).unwrap());
            let run_dir = dir.join(class);
            std::fs::create_dir_all(&run_dir).unwrap();
            let mut agent = Agent::new(
                Box::new(DeferredModel::new(slot)),
                Box::new(NoTools),
                Config { retry_base_ms: 1 },
            )
            .with_new_session(&run_dir, "/cwd")
            .map_err(|e| anyhow::anyhow!("{e}"))
            .unwrap();
            let mut events = Vec::new();
            agent.prompt("go", &mut |e| events.push(e)).await;
            let wire = serde_json::to_string(&events).unwrap();
            assert!(!wire.contains(KEY), "{class}: the key is in an event");
            let failed = events
                .iter()
                .find(|e| e["type"] == "message_end" && e["message"]["stopReason"] == "error")
                .unwrap_or_else(|| panic!("{class}: no failed message"));
            let text = failed["message"]["errorMessage"].as_str().unwrap();
            assert_eq!(
                crate::pi::provider_error_class(&json!({"errorMessage": text})).0,
                class
            );
            assert_eq!(crate::agent_loop::is_retryable(text), retried);
            assert_eq!(fake.seen.lock().unwrap().len(), 1, "{class}: sent again");
            let bytes = all_bytes(&run_dir);
            assert!(
                !bytes.is_empty(),
                "{class}: the run folder is kept with its record"
            );
            assert!(
                !String::from_utf8_lossy(&bytes).contains(KEY),
                "{class}: the key reached a file of the run folder"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_key_found_in_the_childs_own_arguments_or_environment_is_not_used() {
        let vars = |v: &[(&str, &str)]| {
            v.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<Vec<_>>()
        };
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(!key_in_own_process(
            KEY,
            args(&["a", "b"]),
            vars(&[("PATH", "/bin")])
        ));
        assert!(key_in_own_process(KEY, args(&["a", KEY]), vars(&[])));
        assert!(key_in_own_process(
            KEY,
            args(&[]),
            vars(&[("X", &format!("p{KEY}q"))])
        ));
        assert!(!key_in_own_process("short", args(&["short"]), vars(&[])));
    }
}
