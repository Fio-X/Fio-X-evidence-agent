use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write as StdWrite;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command as StdCommand;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::Instant;

use crate::tool_registry::{tools_for_profile, DEFAULT_TOOL_PROFILE};

#[derive(Debug, Clone)]
pub struct PiConfig {
    pub binary: PathBuf,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub thinking: Option<String>,
    pub approve_project: bool,
    pub extension: Option<PathBuf>,
    pub artifact_dir: Option<PathBuf>,
    pub session_dir: Option<PathBuf>,
    pub continue_session: bool,
    pub tool_profile: String,
}

#[derive(Debug)]
pub struct PiRunResult {
    pub text: String,
    pub session_stats: Option<Value>,
}

#[cfg(target_os = "macos")]
fn parse_system_https_proxy(raw: &str) -> Option<String> {
    let mut http_enabled = false;
    let mut https_enabled = false;
    let mut http_host = None;
    let mut https_host = None;
    let mut http_port = None;
    let mut https_port = None;

    for line in raw.lines() {
        let Some((key, value)) = line.trim().split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "HTTPEnable" => http_enabled = value == "1",
            "HTTPSEnable" => https_enabled = value == "1",
            "HTTPProxy" if !value.is_empty() => http_host = Some(value),
            "HTTPSProxy" if !value.is_empty() => https_host = Some(value),
            "HTTPPort" => http_port = value.parse::<u16>().ok(),
            "HTTPSPort" => https_port = value.parse::<u16>().ok(),
            _ => {}
        }
    }

    let (enabled, host, port) = if https_enabled {
        (
            https_enabled,
            https_host.or(http_host),
            https_port.or(http_port),
        )
    } else if http_enabled {
        (http_enabled, http_host, http_port)
    } else {
        (false, None, None)
    };
    if !enabled {
        return None;
    }
    let host = host?;
    let port = port.filter(|port| *port > 0)?;
    if host
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
        || host.contains(['/', '@', '#', '?'])
    {
        return None;
    }
    let authority = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    Some(format!("http://{authority}:{port}"))
}

fn configured_system_proxy() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = StdCommand::new("scutil").arg("--proxy").output().ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        parse_system_https_proxy(&text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn append_node_option(existing: Option<String>, option: &str) -> String {
    let current = existing.unwrap_or_default();
    if current.split_whitespace().any(|value| value == option) {
        current
    } else if current.trim().is_empty() {
        option.to_owned()
    } else {
        format!("{} {option}", current.trim())
    }
}

fn provider_error_class(event: &Value) -> (&'static str, Option<u16>) {
    let diagnostic = event
        .get("error")
        .or_else(|| event.get("data"))
        .map(Value::to_string)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let status = [400_u16, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504]
        .into_iter()
        .find(|status| diagnostic.contains(&status.to_string()));
    let class = match status {
        Some(401 | 403) => "provider_authentication_failed",
        Some(408 | 504) => "provider_timeout",
        Some(429) => "provider_rate_limited",
        Some(500 | 502 | 503) => "provider_unavailable",
        Some(400 | 404 | 409) => "provider_request_rejected",
        _ if diagnostic.contains("no available accounts")
            || diagnostic.contains("service unavailable") =>
        {
            "provider_unavailable"
        }
        _ => "provider_error",
    };
    (class, status)
}

fn prompt_retry_allowed(event: &Value, prompt_accepted: bool, attempt: u8) -> bool {
    !prompt_accepted
        && attempt < 3
        && event.get("type").and_then(Value::as_str) == Some("response")
        && event.get("command").and_then(Value::as_str) == Some("prompt")
        && event.get("success").and_then(Value::as_bool) == Some(false)
}

fn assistant_provider_turn_failed(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("message_start" | "message_end")
    ) && event
        .get("message")
        .and_then(|message| message.get("stopReason"))
        .and_then(Value::as_str)
        == Some("error")
}

impl PiConfig {
    fn dragoncode_endpoint(value: &str) -> bool {
        let authority = value
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(value)
            .split('/')
            .next()
            .unwrap_or("")
            .rsplit('@')
            .next()
            .unwrap_or("")
            .split(':')
            .next()
            .unwrap_or("");
        authority.eq_ignore_ascii_case("dragoncode.codes")
    }

    fn normalize_provider_with_base(
        provider: Option<&str>,
        configured_base_url: Option<&str>,
    ) -> Option<String> {
        let provider = provider?;
        let dragoncode_base = configured_base_url
            .map(str::to_owned)
            .or_else(|| std::env::var("DRAGONCODE_BASE_URL").ok())
            .or_else(|| std::env::var("OPENAI_BASE_URL").ok());
        if provider.eq_ignore_ascii_case("openai")
            && dragoncode_base
                .as_deref()
                .is_some_and(Self::dragoncode_endpoint)
        {
            Some("dragoncode".to_string())
        } else {
            Some(provider.to_string())
        }
    }

    pub fn normalize_provider(provider: Option<&str>) -> Option<String> {
        Self::normalize_provider_with_base(provider, None)
    }

    pub fn effective_provider(&self) -> Option<String> {
        Self::normalize_provider_with_base(self.provider.as_deref(), self.base_url.as_deref())
    }

    pub fn command(&self) -> Command {
        let mut cmd = Command::new(&self.binary);
        cmd.arg("--mode").arg("rpc");

        if let Some(session_dir) = &self.session_dir {
            cmd.arg("--session-dir").arg(session_dir);
            if self.continue_session {
                cmd.arg("-c");
            }
        } else {
            cmd.arg("--no-session");
        }

        if let Some(provider) = self.effective_provider() {
            if self.provider.as_deref() != Some(provider.as_str()) {
                eprintln!(
                    "[agent] normalized Pi provider to dragoncode for dragoncode.codes (Anthropic Messages route)"
                );
            }
            cmd.arg("--provider").arg(&provider);
            cmd.env("NEWSROOM_ACTIVE_PROVIDER", &provider);
            if let Some(api_key) = self.api_key.as_deref().filter(|value| !value.is_empty()) {
                let key_name = match provider.as_str() {
                    "anthropic" => "ANTHROPIC_API_KEY",
                    "openai" => "OPENAI_API_KEY",
                    "dragoncode" => "DRAGONCODE_API_KEY",
                    _ => "NEWSROOM_API_KEY",
                };
                cmd.env(key_name, api_key);
            }
            if let Some(base_url) = self.base_url.as_deref().filter(|value| !value.is_empty()) {
                let base_name = match provider.as_str() {
                    "anthropic" => "ANTHROPIC_BASE_URL",
                    "openai" => "OPENAI_BASE_URL",
                    "dragoncode" => "DRAGONCODE_BASE_URL",
                    _ => "NEWSROOM_BASE_URL",
                };
                cmd.env(base_name, base_url);
            }
            if provider == "dragoncode" && std::env::var("DRAGONCODE_API_KEY").is_err() {
                if let Ok(key) = std::env::var("OPENAI_API_KEY") {
                    // The existing external .env uses the OpenAI-compatible name
                    // for this DragonCode key. Pass it only to the child process;
                    // never write it to the worktree or a command-line argument.
                    cmd.env("DRAGONCODE_API_KEY", key);
                }
            }
        }
        if let Some(model) = &self.model {
            cmd.arg("--model").arg(model);
            cmd.env("NEWSROOM_ACTIVE_MODEL", model);
        }
        if let Some(thinking) = &self.thinking {
            cmd.arg("--thinking").arg(thinking);
        }

        if let Some(extension) = &self.extension {
            // Ignore ambient extensions/skills and load only the bundled newsroom capability.
            // Pi explicitly supports --no-extensions combined with -e <extension>.
            cmd.arg("--no-extensions")
                .arg("-e")
                .arg(extension)
                .arg("--no-skills")
                .arg("--no-prompt-templates")
                .arg("--no-context-files")
                .arg("--tools")
                .arg(tools_for_profile(&self.tool_profile).unwrap_or_else(|| {
                    tools_for_profile(DEFAULT_TOOL_PROFILE)
                        .expect("default tool profile must exist")
                }));
        }

        if self.approve_project {
            cmd.arg("--approve");
        } else {
            cmd.arg("--no-approve");
        }

        if let Some(artifact_dir) = &self.artifact_dir {
            cmd.env("NEWSROOM_ARTIFACT_DIR", artifact_dir);
        }
        let effective_profile = if tools_for_profile(&self.tool_profile).is_some() {
            self.tool_profile.as_str()
        } else {
            DEFAULT_TOOL_PROFILE
        };
        cmd.env("NEWSROOM_TOOL_PROFILE", effective_profile);

        // Keep the wrapper reproducible and avoid Pi's startup version check / telemetry.
        // Model-provider and explicitly invoked newsroom network tools remain available.
        cmd.env("PI_SKIP_VERSION_CHECK", "1");
        cmd.env("PI_TELEMETRY", "0");

        let inherited_https_proxy = std::env::var("HTTPS_PROXY")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let inherited_http_proxy = std::env::var("HTTP_PROXY")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let system_proxy = if inherited_https_proxy.is_none() && inherited_http_proxy.is_none() {
            configured_system_proxy()
        } else {
            None
        };
        if let Some(proxy) = system_proxy.as_ref() {
            cmd.env("HTTPS_PROXY", proxy);
            cmd.env("HTTP_PROXY", proxy);
            eprintln!("[agent] network route=macOS system proxy enabled (proxy host hidden)");
        }
        let proxy_available = inherited_https_proxy
            .or(inherited_http_proxy)
            .or(system_proxy);
        if proxy_available.is_some() {
            let node_options =
                append_node_option(std::env::var("NODE_OPTIONS").ok(), "--use-env-proxy");
            cmd.env("NODE_OPTIONS", node_options);
        }
        cmd
    }

    pub fn display_runtime(&self) -> String {
        let provider = self
            .effective_provider()
            .unwrap_or_else(|| "<pi-default>".to_string());
        let model = self.model.as_deref().unwrap_or("<pi-default>");
        let session = if self.session_dir.is_some() {
            if self.continue_session {
                "persistent/resume"
            } else {
                "persistent/new"
            }
        } else {
            "ephemeral"
        };
        let profile = if tools_for_profile(&self.tool_profile).is_some() {
            self.tool_profile.as_str()
        } else {
            DEFAULT_TOOL_PROFILE
        };
        format!("pi-rpc provider={provider} model={model} session={session} tools={profile}")
    }
}

fn redact_event(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => {
            for secret in secrets {
                *text = text.replace(secret, "[REDACTED]");
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_event(item, secrets);
            }
        }
        Value::Object(object) => {
            for (key, item) in object {
                if matches!(key.as_str(), "error" | "errorMessage") {
                    *item = json!("diagnostic suppressed");
                } else {
                    redact_event(item, secrets);
                }
            }
        }
        _ => {}
    }
}

/// All durations are milliseconds. Active tools/thinking/retries use the total
/// deadline rather than a token-silence heuristic. Zero disables only total.
fn wait_duration(name: &str, default: u64, allow_zero: bool) -> Result<Duration> {
    let value = match std::env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .with_context(|| format!("invalid {name}"))?,
        Err(std::env::VarError::NotPresent) => default,
        Err(_) => bail!("invalid {name}"),
    };
    if (!allow_zero && value == 0) || value > 604_800_000 {
        bail!(
            "{name} must be within {}..=604800000 milliseconds",
            if allow_zero { 0 } else { 1 }
        );
    }
    Ok(Duration::from_millis(value))
}

#[cfg(unix)]
struct ProcessGroup(u32);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // Pi and its non-detached tool descendants share this new process group.
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

pub async fn run_prompt(
    config: &PiConfig,
    prompt: &str,
    event_log: Option<&Path>,
) -> Result<PiRunResult> {
    run_prompt_sequence(config, &[prompt.to_string()], event_log).await
}

/// Bounded opt-in/session entry point: send a finite prompt sequence through
/// one Pi child. The default run_prompt path remains a one-prompt session.
pub async fn run_prompt_sequence(
    config: &PiConfig,
    prompts: &[String],
    event_log: Option<&Path>,
) -> Result<PiRunResult> {
    if prompts.is_empty() {
        bail!("Pi RPC prompt sequence cannot be empty");
    }
    let startup = wait_duration("NEWSROOM_RPC_STARTUP_MS", 60_000, false)?;
    let idle = wait_duration("NEWSROOM_RPC_IDLE_MS", 300_000, false)?;
    let finish = wait_duration("NEWSROOM_RPC_FINISH_MS", 30_000, false)?;
    let total = wait_duration("NEWSROOM_RPC_TOTAL_MS", 86_400_000, true)?;
    let heartbeat = wait_duration("NEWSROOM_RPC_HEARTBEAT_MS", 5_000, false)?;
    let secrets: Vec<String> = std::env::vars()
        .filter_map(|(key, value)| {
            let key = key.to_ascii_uppercase();
            (value.len() >= 8
                && ["API_KEY", "TOKEN", "SECRET", "PASSWORD"]
                    .iter()
                    .any(|part| key.contains(part)))
            .then_some(value)
        })
        .collect();
    let started = Instant::now();
    eprintln!("[agent] phase=startup elapsed_ms=0");
    let mut command = config.command();
    #[cfg(unix)]
    command.process_group(0);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start Pi executable: {}", config.binary.display()))?;

    #[cfg(unix)]
    let group = ProcessGroup(child.id().context("Pi process id unavailable")?);
    let outcome = async {
        let mut stdin = child
            .stdin
            .take()
            .context("Pi RPC stdin was not available")?;
        let stdout = child
            .stdout
            .take()
            .context("Pi RPC stdout was not available")?;
        let mut reader = BufReader::new(stdout);
        let mut log = match event_log {
            Some(path) => Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .with_context(|| format!("failed to open event log: {}", path.display()))?,
            ),
            None => None,
        };

        send_json(
            &mut stdin,
            &json!({
                "id": "news-prompt",
                "type": "prompt",
                "message": prompts[0]
            }),
            startup,
        )
        .await?;

        let mut streamed_answer = String::new();
        let mut final_answer: Option<String> = None;
        let mut final_text_response_received = false;
        let mut session_stats: Option<Value> = None;
        let mut session_stats_response_received = false;
        let mut prompt_accepted = false;
        let mut prompt_attempt = 1_u8;
        let mut saw_settled = false;
        let mut final_queries_sent = false;
        let mut active_work = false;
        let mut last_activity = Instant::now();
        let mut finish_started = None;
        let mut first_text_ms: Option<u128> = None;
        let mut startup_ms: Option<u128> = None;
        let mut ticks = tokio::time::interval(heartbeat.min(Duration::from_millis(100)));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut next_heartbeat = started + heartbeat;
        let mut extension_errors: Vec<String> = Vec::new();
        let mut provider_turn_failed = false;
        let mut prompt_index = 0_usize;

        let mut line = Vec::new();
        loop {
            tokio::select! {
                read = read_record(&mut reader, &mut line) => {
                    let bytes = read?;
                    if bytes == 0 {
                        break;
                    }
                }
                signal = tokio::signal::ctrl_c() => {
                    signal?;
                    bail!("Pi RPC cancelled by user");
                }
                _ = ticks.tick() => {
                    let now = Instant::now();
                    let phase = if finish_started.is_some() { "finishing" }
                        else if !prompt_accepted { "startup" }
                        else if active_work { "active-work" } else { "rpc-wait" };
                    if now >= next_heartbeat {
                        eprintln!("[agent] phase={phase} elapsed_ms={}", started.elapsed().as_millis());
                        next_heartbeat = now + heartbeat;
                    }
                    let expired = if !total.is_zero() && started.elapsed() >= total { Some("total") }
                        else if !prompt_accepted && started.elapsed() >= startup { Some("startup") }
                        else if finish_started.is_some_and(|t: Instant| t.elapsed() >= finish) { Some("finishing") }
                        else if prompt_accepted && !active_work && finish_started.is_none() && last_activity.elapsed() >= idle { Some("idle") }
                        else { None };
                    if let Some(phase) = expired { bail!("Pi RPC {phase} timeout"); }
                    continue;
                }
            }

            let record = std::str::from_utf8(&line)
                .context("Pi emitted invalid UTF-8")?
                .trim();
            if record.is_empty() {
                line.clear();
                continue;
            }

            let event: Value = serde_json::from_str(record)
                .context("invalid JSONL record from Pi (payload suppressed)")?;
            line.clear();
            last_activity = Instant::now();

            let mut event = event;
            redact_event(&mut event, &secrets);
            // Provider/extension diagnostics are untrusted and may contain credentials.
            if event.get("type").and_then(Value::as_str) == Some("extension_error")
                || (event.get("type").and_then(Value::as_str) == Some("response")
                    && event.get("success").and_then(Value::as_bool) == Some(false))
            {
                let (error_class, http_status) = provider_error_class(&event);
                let object = event.as_object_mut().context("invalid RPC event")?;
                object.remove("error");
                object.remove("data");
                object.insert("diagnostic_suppressed".into(), Value::Bool(true));
                object.insert(
                    "provider_error_class".into(),
                    Value::String(error_class.to_string()),
                );
                if let Some(status) = http_status {
                    object.insert("provider_http_status".into(), Value::from(status));
                }
            }
            if let Some(file) = log.as_mut() {
                let mut logged_event = event.clone();
                if let Some(object) = logged_event.as_object_mut() {
                    object.insert(
                        "_newsroom_recorded_at".to_string(),
                        Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
                    );
                }
                writeln!(file, "{}", serde_json::to_string(&logged_event)?)?;
                file.flush()?;
            }

            if assistant_provider_turn_failed(&event) {
                provider_turn_failed = true;
            }

            match event.get("type").and_then(Value::as_str) {
                Some("response")
                    if event.get("command").and_then(Value::as_str) == Some("prompt") =>
                {
                    if event.get("success").and_then(Value::as_bool) == Some(true) {
                        prompt_accepted = true;
                        let accepted_ms = started.elapsed().as_millis();
                        startup_ms = Some(accepted_ms);
                        eprintln!("[agent] startup_ms={accepted_ms}");
                    } else if prompt_retry_allowed(&event, prompt_accepted, prompt_attempt) {
                        prompt_attempt += 1;
                        eprintln!(
                            "[agent] prompt_not_accepted retry={prompt_attempt}/3 elapsed_ms={}",
                            started.elapsed().as_millis()
                        );
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        send_json(
                            &mut stdin,
                            &json!({
                                "id": format!("news-prompt-retry-{prompt_attempt}"),
                                "type": "prompt",
                                "message": prompts[prompt_index]
                            }),
                            startup,
                        )
                        .await?;
                    } else {
                        let class = event
                            .get("provider_error_class")
                            .and_then(Value::as_str)
                            .unwrap_or("provider_error");
                        let status = event
                            .get("provider_http_status")
                            .and_then(Value::as_u64)
                            .map(|value| format!(" HTTP {value}"))
                            .unwrap_or_default();
                        bail!(
                            "Pi rejected the prompt: {class}{status} (raw diagnostic suppressed)"
                        );
                    }
                }
                Some("response")
                    if event.get("command").and_then(Value::as_str)
                        == Some("get_last_assistant_text") =>
                {
                    if event.get("success").and_then(Value::as_bool) != Some(true) {
                        bail!("Pi final text query failed (diagnostic suppressed)");
                    }
                    final_text_response_received = true;
                    if event.get("success").and_then(Value::as_bool) == Some(true) {
                        final_answer = event
                            .get("data")
                            .and_then(|data| data.get("text"))
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                    }
                }
                Some("response")
                    if event.get("command").and_then(Value::as_str)
                        == Some("get_session_stats") =>
                {
                    if event.get("success").and_then(Value::as_bool) != Some(true) {
                        bail!("Pi session statistics query failed (diagnostic suppressed)");
                    }
                    session_stats_response_received = true;
                    if event.get("success").and_then(Value::as_bool) == Some(true) {
                        session_stats = event.get("data").cloned();
                    }
                }
                Some("message_update") => {
                    active_work = true;
                    if let Some(update) = event.get("assistantMessageEvent") {
                        if update.get("type").and_then(Value::as_str) == Some("text_delta") {
                            if let Some(delta) = update.get("delta").and_then(Value::as_str) {
                                if first_text_ms.is_none() {
                                    first_text_ms = Some(started.elapsed().as_millis());
                                }
                                print!("{delta}");
                                std::io::stdout().flush().ok();
                                streamed_answer.push_str(delta);
                            }
                        }
                    }
                }
                Some("tool_execution_start") => {
                    active_work = true;
                    eprintln!(
                        "[agent] phase=tool-running elapsed_ms={}",
                        started.elapsed().as_millis()
                    );
                }
                Some("tool_execution_end") => {
                    eprintln!(
                        "[agent] phase=tool-complete elapsed_ms={}",
                        started.elapsed().as_millis()
                    );
                }
                Some("turn_start") => {
                    // A new model/tool turn is active even when the provider
                    // emits no visible text while it is thinking.
                    active_work = true;
                }
                Some("turn_end") => {
                    // Re-enable the idle boundary between turns. Tool and
                    // thinking events keep this true for the whole turn, so a
                    // long tool call is never mistaken for token silence.
                    active_work = false;
                }
                Some("agent_start" | "message_start" | "auto_retry_start") => {
                    active_work = true;
                }
                Some("extension_error") => {
                    extension_errors.push("suppressed".to_string());
                    eprintln!("[extension] runtime error (payload suppressed)");
                }
                Some("agent_settled") => {
                    saw_settled = true;
                    if prompt_index + 1 < prompts.len() {
                        prompt_index += 1;
                        saw_settled = false;
                        prompt_accepted = false;
                        active_work = false;
                        finish_started = None;
                        final_text_response_received = false;
                        session_stats_response_received = false;
                        final_queries_sent = false;
                        send_json(
                            &mut stdin,
                            &json!({
                                "id": format!("news-prompt-{}", prompt_index + 1),
                                "type": "prompt",
                                "message": prompts[prompt_index]
                            }),
                            startup,
                        )
                        .await?;
                    } else {
                        finish_started.get_or_insert_with(Instant::now);
                    }
                    if saw_settled && !final_queries_sent {
                        send_json(
                            &mut stdin,
                            &json!({
                                "id": "news-final-text",
                                "type": "get_last_assistant_text"
                            }),
                            finish,
                        )
                        .await?;
                        send_json(
                            &mut stdin,
                            &json!({
                                "id": "news-session-stats",
                                "type": "get_session_stats"
                            }),
                            finish,
                        )
                        .await?;
                        final_queries_sent = true;
                    }
                }
                _ => {}
            }

            if saw_settled && final_text_response_received && session_stats_response_received {
                break;
            }
        }

        drop(stdin);

        if !prompt_accepted {
            return Err(anyhow!(
                "Pi RPC stream ended before the prompt was accepted"
            ));
        }
        if !saw_settled {
            return Err(anyhow!("Pi RPC stream ended before agent_settled"));
        }
        if !final_text_response_received || !session_stats_response_received {
            bail!("Pi RPC ended before final replies");
        }
        if !extension_errors.is_empty() {
            eprintln!(
                "[extension] {} runtime error(s) were recorded in events.jsonl",
                extension_errors.len()
            );
        }

        let answer = final_answer.unwrap_or(streamed_answer);
        if answer.trim().is_empty() {
            if provider_turn_failed {
                bail!("Pi provider failed after internal retries (diagnostic suppressed)");
            }
            bail!("Pi returned an empty final answer (provider diagnostic suppressed)");
        }
        if !answer.ends_with('\n') {
            println!();
        }

        let rpc_ms = started.elapsed().as_millis();
        eprintln!(
            "[agent] phase=complete rpc_ms={} first_model_text_ms={}",
            rpc_ms,
            first_text_ms
                .map(|v| v.to_string())
                .unwrap_or_else(|| "N/A".into())
        );
        let token_value = |key: &str| {
            session_stats
                .as_ref()
                .and_then(|stats| stats.get("tokens"))
                .and_then(|tokens| tokens.get(key))
                .and_then(Value::as_u64)
        };
        eprintln!(
            "[agent] tokens_input={} tokens_output={} tokens_cache_read={} tokens_cache_write={}",
            token_value("input")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "N/A".into()),
            token_value("output")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "N/A".into()),
            token_value("cacheRead")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "N/A".into()),
            token_value("cacheWrite")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "N/A".into())
        );
        if let Some(file) = log.as_mut() {
            let effective_profile = if tools_for_profile(&config.tool_profile).is_some() {
                config.tool_profile.as_str()
            } else {
                DEFAULT_TOOL_PROFILE
            };
            let tool_count = tools_for_profile(effective_profile)
                .map(|tools| tools.split(',').filter(|name| !name.is_empty()).count())
                .unwrap_or(0);
            let metric_event = json!({
                "type": "newsroom_rpc_metrics",
                "schema_version": "0.1.0",
                "startup_ms": startup_ms,
                "rpc_ms": rpc_ms,
                "first_model_text_ms": first_text_ms,
                "prompt_attempts": prompt_attempt,
                "prompt_bytes": prompts.iter().map(|value| value.len()).sum::<usize>(),
                "prompt_count": prompts.len(),
                "tool_profile": effective_profile,
                "tool_count": tool_count,
                "continue_session": config.continue_session,
                "tokens_input": token_value("input"),
                "tokens_output": token_value("output"),
                "tokens_cache_read": token_value("cacheRead"),
                "tokens_cache_write": token_value("cacheWrite"),
                "_newsroom_recorded_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            });
            writeln!(file, "{}", serde_json::to_string(&metric_event)?)?;
            file.flush()?;
        }
        Ok(PiRunResult {
            text: answer,
            session_stats,
        })
    };
    let outcome = tokio::select! {
        result = outcome => result,
        _ = tokio::signal::ctrl_c() => Err(anyhow!("Pi RPC cancelled by user")),
        _ = tokio::time::sleep(total), if !total.is_zero() => Err(anyhow!("Pi RPC total timeout")),
    };
    #[cfg(unix)]
    {
        // Give Pi a bounded chance to clean up its own tracked detached tools.
        unsafe {
            libc::kill(-(group.0 as i32), libc::SIGTERM);
        }
        let _ = tokio::time::timeout(Duration::from_millis(500), child.wait()).await;
        drop(group);
    }
    let _ = child.kill().await;
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    outcome
}

// fill_buf/consume keeps partial JSON safe across select cancellation and caps memory.
async fn read_record(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    line: &mut Vec<u8>,
) -> Result<usize> {
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            return Ok(line.len());
        }
        let end = buf.iter().position(|b| *b == b'\n');
        let count = end.map_or(buf.len(), |i| i + 1);
        if line.len() + count > 8_000_000 {
            bail!("Pi RPC record limit exceeded");
        }
        line.extend_from_slice(&buf[..count]);
        reader.consume(count);
        if end.is_some() {
            return Ok(line.len());
        }
    }
}

async fn send_json(
    stdin: &mut tokio::process::ChildStdin,
    value: &Value,
    limit: Duration,
) -> Result<()> {
    let wire = serde_json::to_string(value)?;

    let heartbeat = wait_duration("NEWSROOM_RPC_HEARTBEAT_MS", 5_000, false)?;
    let started = Instant::now();
    let write = tokio::time::timeout(limit, async {
        stdin.write_all(wire.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await
    });
    tokio::pin!(write);
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => bail!("Pi RPC cancelled by user"),
            result = &mut write => { result.context("Pi RPC write timeout")??; break; },
            _ = tokio::time::sleep(heartbeat) => eprintln!("[agent] phase=rpc-write elapsed_ms={}", started.elapsed().as_millis()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_label_uses_defaults() {
        let cfg = PiConfig {
            binary: "pi".into(),
            provider: None,
            model: None,
            api_key: None,
            base_url: None,
            thinking: None,
            approve_project: false,
            extension: None,
            artifact_dir: None,
            session_dir: None,
            continue_session: false,
            tool_profile: "investigate".to_string(),
        };
        assert_eq!(
            cfg.display_runtime(),
            "pi-rpc provider=<pi-default> model=<pi-default> session=ephemeral tools=investigate"
        );
    }

    #[test]
    fn dragoncode_endpoint_matching_is_exact() {
        assert!(PiConfig::dragoncode_endpoint("https://dragoncode.codes"));
        assert!(PiConfig::dragoncode_endpoint("https://dragoncode.codes/v1"));
        assert!(!PiConfig::dragoncode_endpoint(
            "https://api.dragoncode.codes"
        ));
        assert!(!PiConfig::dragoncode_endpoint(
            "https://dragoncode.codes.example"
        ));
    }

    #[test]
    fn node_proxy_option_is_added_once() {
        assert_eq!(
            append_node_option(None, "--use-env-proxy"),
            "--use-env-proxy"
        );
        assert_eq!(
            append_node_option(Some("--import=observer.mjs".to_string()), "--use-env-proxy"),
            "--import=observer.mjs --use-env-proxy"
        );
        assert_eq!(
            append_node_option(Some("--use-env-proxy".to_string()), "--use-env-proxy"),
            "--use-env-proxy"
        );
    }

    #[test]
    fn provider_errors_are_safely_classified_without_returning_diagnostics() {
        let unavailable = json!({
            "type": "response",
            "success": false,
            "error": "HTTP 503 no available accounts secret-token"
        });
        assert_eq!(
            provider_error_class(&unavailable),
            ("provider_unavailable", Some(503))
        );
        let rate_limited = json!({"data": {"status": 429, "message": "secret-token"}});
        assert_eq!(
            provider_error_class(&rate_limited),
            ("provider_rate_limited", Some(429))
        );
        assert_eq!(provider_error_class(&json!({})), ("provider_error", None));
    }

    #[test]
    fn prompt_retries_are_bounded_and_only_pre_acceptance() {
        let rejected = json!({"type": "response", "command": "prompt", "success": false});
        assert!(prompt_retry_allowed(&rejected, false, 1));
        assert!(prompt_retry_allowed(&rejected, false, 2));
        assert!(!prompt_retry_allowed(&rejected, false, 3));
        assert!(!prompt_retry_allowed(&rejected, true, 1));
        assert!(!prompt_retry_allowed(
            &json!({"type": "response", "command": "prompt", "success": true}),
            false,
            1
        ));
    }

    #[test]
    fn assistant_error_turns_are_not_misreported_as_empty_answers() {
        assert!(assistant_provider_turn_failed(&json!({
            "type": "message_end",
            "message": {"stopReason": "error", "errorMessage": "diagnostic suppressed"}
        })));
        assert!(!assistant_provider_turn_failed(&json!({
            "type": "message_end",
            "message": {"stopReason": "stop"}
        })));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_macos_https_proxy_without_exposing_credentials() {
        let raw = "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 1082\n";
        assert_eq!(
            parse_system_https_proxy(raw).as_deref(),
            Some("http://127.0.0.1:1082")
        );
        assert!(parse_system_https_proxy(
            "HTTPSEnable : 1\nHTTPSProxy : bad/path\nHTTPSPort : 1082\n"
        )
        .is_none());
    }
}
