use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::Write as StdWrite;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::tool_registry::{tools_for_profile, DEFAULT_TOOL_PROFILE};

#[derive(Debug, Clone)]
pub struct PiConfig {
    pub binary: PathBuf,
    pub provider: Option<String>,
    pub model: Option<String>,
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

impl PiConfig {
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

        if let Some(provider) = &self.provider {
            cmd.arg("--provider").arg(provider);
            cmd.env("NEWSROOM_ACTIVE_PROVIDER", provider);
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
        cmd
    }

    pub fn display_runtime(&self) -> String {
        let provider = self.provider.as_deref().unwrap_or("<pi-default>");
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

pub async fn run_prompt(
    config: &PiConfig,
    prompt: &str,
    event_log: Option<&Path>,
) -> Result<PiRunResult> {
    let mut command = config.command();
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start Pi executable: {}", config.binary.display()))?;

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
            "message": prompt
        }),
    )
    .await?;

    let mut streamed_answer = String::new();
    let mut final_answer: Option<String> = None;
    let mut final_text_response_received = false;
    let mut session_stats: Option<Value> = None;
    let mut session_stats_response_received = false;
    let mut prompt_accepted = false;
    let mut saw_settled = false;
    let mut final_queries_sent = false;
    let mut abort_sent = false;
    let mut extension_errors: Vec<String> = Vec::new();

    loop {
        let mut line = String::new();

        tokio::select! {
            read = reader.read_line(&mut line) => {
                let bytes = read?;
                if bytes == 0 {
                    break;
                }
            }
            signal = tokio::signal::ctrl_c(), if !abort_sent => {
                signal?;
                send_json(&mut stdin, &json!({"type": "abort"})).await?;
                abort_sent = true;
                eprintln!("\n[agent] abort requested; waiting for Pi to settle...");
                continue;
            }
        }

        let record = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if record.is_empty() {
            continue;
        }

        let event: Value = serde_json::from_str(record)
            .with_context(|| format!("invalid JSONL record from Pi: {record}"))?;

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

        match event.get("type").and_then(Value::as_str) {
            Some("response") if event.get("command").and_then(Value::as_str) == Some("prompt") => {
                if event.get("success").and_then(Value::as_bool) == Some(true) {
                    prompt_accepted = true;
                } else {
                    let error = event
                        .get("error")
                        .map(Value::to_string)
                        .unwrap_or_else(|| "Pi rejected the prompt".to_string());
                    bail!("{error}");
                }
            }
            Some("response")
                if event.get("command").and_then(Value::as_str)
                    == Some("get_last_assistant_text") =>
            {
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
                if event.get("command").and_then(Value::as_str) == Some("get_session_stats") =>
            {
                session_stats_response_received = true;
                if event.get("success").and_then(Value::as_bool) == Some(true) {
                    session_stats = event.get("data").cloned();
                }
            }
            Some("message_update") => {
                if let Some(update) = event.get("assistantMessageEvent") {
                    if update.get("type").and_then(Value::as_str) == Some("text_delta") {
                        if let Some(delta) = update.get("delta").and_then(Value::as_str) {
                            print!("{delta}");
                            std::io::stdout().flush().ok();
                            streamed_answer.push_str(delta);
                        }
                    }
                }
            }
            Some("tool_execution_start") => {
                let tool = event
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                eprintln!("\n[tool] -> {tool}");
            }
            Some("tool_execution_end") => {
                let tool = event
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let failed = event
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if failed {
                    eprintln!("[tool] !! {tool} failed");
                } else {
                    eprintln!("[tool] <- {tool} ok");
                }
            }
            Some("auto_retry_start") => {
                let attempt = event.get("attempt").and_then(Value::as_u64).unwrap_or(0);
                eprintln!("[agent] automatic retry attempt {attempt}");
            }
            Some("extension_error") => {
                let error = event
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown extension error")
                    .to_string();
                extension_errors.push(error.clone());
                eprintln!("[extension] error: {error}");
            }
            Some("agent_settled") => {
                saw_settled = true;
                if !final_queries_sent {
                    send_json(
                        &mut stdin,
                        &json!({
                            "id": "news-final-text",
                            "type": "get_last_assistant_text"
                        }),
                    )
                    .await?;
                    send_json(
                        &mut stdin,
                        &json!({
                            "id": "news-session-stats",
                            "type": "get_session_stats"
                        }),
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
    let _ = child.kill().await;
    let _ = child.wait().await;

    if !prompt_accepted {
        return Err(anyhow!(
            "Pi RPC stream ended before the prompt was accepted"
        ));
    }
    if !saw_settled {
        return Err(anyhow!("Pi RPC stream ended before agent_settled"));
    }
    if !extension_errors.is_empty() {
        eprintln!(
            "[extension] {} runtime error(s) were recorded in events.jsonl",
            extension_errors.len()
        );
    }

    let answer = final_answer.unwrap_or(streamed_answer);
    if !answer.ends_with('\n') {
        println!();
    }

    Ok(PiRunResult {
        text: answer,
        session_stats,
    })
}

async fn send_json(stdin: &mut tokio::process::ChildStdin, value: &Value) -> Result<()> {
    let wire = serde_json::to_string(value)?;
    stdin.write_all(wire.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
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
}
