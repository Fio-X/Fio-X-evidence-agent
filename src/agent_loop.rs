//! The agent loop in Rust (1011ab step 2, agent-spec 4 to 8): takes a prompt, asks a model for a reply, runs the tools it asks for through
//! the tool host, sends the results back, and repeats until the model stops asking. It reports the run as the 13 JSON event types the
//! existing readers consume. The model here is a replay of recorded assistant messages: no network, nothing live. Selected only by
//! `NEWSROOM_AGENT=rust` (exactly that value, default off) and built for tests only until a later step wires it in.
//!
//! Verification stays outside the loop: nothing here reads model text to set a verification field, `isError` on a tool result comes from the
//! tool runner (or from this loop's own refusals), and failed tool results go back to the model as they are.

use crate::session_store::{SessionError, SessionWriter};
use crate::tool_host::{CallOutcome, ToolHost};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const AGENT_ENV: &str = "NEWSROOM_AGENT";
const MAX_RETRIES: u32 = 3;
const RETRY_BASE_MS: u64 = 2000;
const ABORT_WAIT: Duration = Duration::from_secs(5);
/// Longest one auto-check step (lint, render, critic, preview) may run before the sequence stops at it. A proposed value, not a host
/// value: the Rust path has no per-tool timeout table, and nobody has measured the render steps. The owner may change it; it is named
/// in the `NEWSROOM_SPEED_AUTO_CHECKS` row of ci/switch-owners.json.
pub const AUTO_STEP_TIMEOUT: Duration = Duration::from_secs(120);

fn rust_selected(value: Option<&str>) -> bool {
    value == Some("rust")
}

/// True only when `NEWSROOM_AGENT` is exactly "rust". The explicit value "pi" selects the old runtime and behaves exactly like the
/// variable being unset, so tests and scripts can name the old runtime whatever the default is.
pub fn agent_rust_enabled() -> bool {
    rust_selected(std::env::var(AGENT_ENV).ok().as_deref())
}

/// Whether a failed run with this error text is retried (agent-spec 6.2). The classes come from the project's own provider_error_class:
/// only the transient ones are retried; authentication, context overflow, rejected requests and unknown errors never are. Quota
/// errors have no class of their own yet (no relay sample), so they are only kept out when they classify as a rejected request.
pub fn is_retryable(error_text: &str) -> bool {
    let (class, _) = crate::pi::provider_error_class(&json!({"errorMessage": error_text}));
    matches!(
        class,
        "provider_rate_limited"
            | "provider_overloaded"
            | "provider_timeout"
            | "provider_gateway_error"
            | "provider_stream_interrupted"
            | "provider_unavailable"
    )
}

pub fn retry_delay_ms(base_ms: u64, attempt: u32) -> u64 {
    base_ms * 2u64.pow(attempt.saturating_sub(1))
}

pub struct ModelRequest<'a> {
    pub history: &'a [Value],
}

/// Receives each increment of a reply the moment it arrives: the `assistantMessageEvent` and the usage counted so far.
pub type Pieces<'a> = &'a mut (dyn FnMut(Value, Value) + Send);

/// Source of assistant messages: `{content:[text|thinking|toolCall blocks], stopReason, usage, errorMessage?}`. `None` = nothing left.
/// While a reply is still coming in, the model hands every increment to `pieces`; the finished message is the return value.
#[async_trait]
pub trait Model {
    async fn respond(
        &mut self,
        request: &ModelRequest<'_>,
        cancel: &AtomicBool,
        pieces: Pieces<'_>,
    ) -> Option<Value>;
}

/// The increments a finished message is made of, in order: what a model that already holds the whole reply hands over.
pub fn pieces_of(message: &Value, mut hand: impl FnMut(Value, Value)) {
    let usage = message.get("usage").cloned().unwrap_or(json!({}));
    for (index, block) in blocks(message).iter().enumerate() {
        let mut give = |event: Value| hand(event, usage.clone());
        match block.get("type").and_then(Value::as_str) {
            Some(kind @ ("text" | "thinking")) => {
                let body = block.get(kind).and_then(Value::as_str).unwrap_or("");
                give(json!({"type": format!("{kind}_start"), "contentIndex": index}));
                give(
                    json!({"type": format!("{kind}_delta"), "contentIndex": index, "delta": body}),
                );
                give(
                    json!({"type": format!("{kind}_end"), "contentIndex": index, "content": body}),
                );
            }
            Some("toolCall") => {
                give(
                    json!({"type": "toolcall_start", "contentIndex": index, "id": block["id"], "toolName": block["name"]}),
                );
                give(
                    json!({"type": "toolcall_delta", "contentIndex": index, "delta": block["arguments"].to_string()}),
                );
                give(
                    json!({"type": "toolcall_end", "contentIndex": index, "id": block["id"], "toolName": block["name"]}),
                );
            }
            _ => {}
        }
    }
}

/// Recorded replies played back in order, one per request. Makes no network call.
pub struct ReplayModel {
    turns: VecDeque<Value>,
    pub requests_seen: Arc<std::sync::atomic::AtomicUsize>,
    pub history_sizes: Arc<std::sync::Mutex<Vec<usize>>>,
}

impl ReplayModel {
    pub fn new(turns: Vec<Value>) -> Self {
        Self {
            turns: turns.into(),
            requests_seen: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            history_sizes: Default::default(),
        }
    }
}

#[async_trait]
impl Model for ReplayModel {
    async fn respond(
        &mut self,
        request: &ModelRequest<'_>,
        _cancel: &AtomicBool,
        pieces: Pieces<'_>,
    ) -> Option<Value> {
        self.requests_seen.fetch_add(1, Ordering::SeqCst);
        self.history_sizes
            .lock()
            .unwrap()
            .push(request.history.len());
        let reply = self.turns.pop_front()?;
        pieces_of(&reply, pieces);
        Some(reply)
    }
}

#[async_trait]
pub trait ToolRunner {
    async fn run(
        &mut self,
        name: &str,
        args: &Value,
        cancel: &AtomicBool,
        progress: &mut Vec<Value>,
    ) -> Result<CallOutcome>;

    /// Whether this tool is exposed to the model in this run. No default: an implementation must answer, so a runner that forgets cannot
    /// make every tool look enabled. The auto checks skip a step the run does not expose, silently.
    fn exposes(&self, name: &str) -> bool;
}

#[async_trait]
impl ToolRunner for ToolHost {
    async fn run(
        &mut self,
        name: &str,
        args: &Value,
        cancel: &AtomicBool,
        progress: &mut Vec<Value>,
    ) -> Result<CallOutcome> {
        self.call(name, args, cancel, progress).await
    }

    fn exposes(&self, name: &str) -> bool {
        self.tools().contains_key(name)
    }
}

pub struct Config {
    pub retry_base_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            retry_base_ms: RETRY_BASE_MS,
        }
    }
}

/// How one assistant message ends its turn: decided once, then the loop acts on it.
enum TurnEnd {
    Aborted,
    Failed(String),
    Answer,
    /// Tool calls to run; `truncated` when the model hit its length limit, so the calls are incomplete and none may run.
    Calls {
        calls: Vec<Value>,
        truncated: bool,
    },
}

impl TurnEnd {
    fn of(message: &Value) -> Self {
        match stop_reason(message) {
            "aborted" => Self::Aborted,
            "error" => Self::Failed(
                message["errorMessage"]
                    .as_str()
                    .unwrap_or("unknown error")
                    .to_string(),
            ),
            reason => {
                let calls = tool_calls(message);
                if calls.is_empty() {
                    Self::Answer
                } else {
                    Self::Calls {
                        calls,
                        truncated: reason == "length",
                    }
                }
            }
        }
    }
}

pub struct Agent {
    model: Box<dyn Model + Send>,
    tools: Box<dyn ToolRunner + Send>,
    config: Config,
    history: Vec<Value>,
    pub cancel: Arc<AtomicBool>,
    session: Option<SessionWriter>,
    /// The first failure to write the session file; the run goes on, the caller decides what a lost record means.
    session_error: Option<String>,
    /// `NEWSROOM_SPEED_AUTO_CHECKS`: set by the caller, off unless `with_auto_checks(true, _)`.
    auto_checks: bool,
    /// Whether the auto preview step may run (`NEWSROOM_TOOL_RESULT_IMAGES` exactly "1"); read once by the caller.
    auto_images: bool,
    auto_timeout: Duration,
}

/// What one tool run came to: the parts of a toolResult.
struct Exec {
    content: Vec<Value>,
    details: Option<Value>,
    is_error: bool,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn text_message(role: &str, text: &str) -> Value {
    json!({"role": role, "content": [{"type": "text", "text": text}], "timestamp": now_ms()})
}

fn blocks(message: &Value) -> Vec<Value> {
    message
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn tool_calls(message: &Value) -> Vec<Value> {
    blocks(message)
        .into_iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("toolCall"))
        .collect()
}

fn stop_reason(message: &Value) -> &str {
    message
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("stop")
}

fn message_text(message: &Value) -> String {
    blocks(message)
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

impl Agent {
    pub fn new(
        model: Box<dyn Model + Send>,
        tools: Box<dyn ToolRunner + Send>,
        config: Config,
    ) -> Self {
        Self {
            model,
            tools,
            config,
            history: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            session: None,
            session_error: None,
            auto_checks: false,
            auto_images: false,
            auto_timeout: AUTO_STEP_TIMEOUT,
        }
    }

    /// After a successful plan call the loop runs the lint, render and critic steps itself and folds their results into that call's result.
    pub fn with_auto_checks(mut self, on: bool, images: bool) -> Self {
        self.auto_checks = on;
        self.auto_images = images;
        self
    }

    #[cfg(test)]
    fn with_auto_timeout(mut self, limit: Duration) -> Self {
        self.auto_timeout = limit;
        self
    }

    /// Records this agent's messages in a new session file under `run_dir` (refused when one is already there).
    pub fn with_new_session(mut self, run_dir: &Path, cwd: &str) -> Result<Self, SessionError> {
        self.session = Some(SessionWriter::create(run_dir, cwd)?);
        Ok(self)
    }

    /// The follow-up question (`-c`): loads the run folder's session as history and goes on writing to it; with no session there
    /// yet, starts a new one. A session of the old format is refused with a clear error, never started over.
    pub fn with_resumed_session(mut self, run_dir: &Path, cwd: &str) -> Result<Self, SessionError> {
        match SessionWriter::resume(run_dir)? {
            Some(resumed) => {
                self.history = resumed.history;
                self.session = Some(resumed.writer);
                Ok(self)
            }
            None => self.with_new_session(run_dir, cwd),
        }
    }

    pub fn session_error(&self) -> Option<&str> {
        self.session_error.as_deref()
    }

    fn remember(&mut self, message: Value) {
        if let Some(session) = &mut self.session {
            if let Err(error) = session.append(&message) {
                self.session_error.get_or_insert(error.to_string());
            }
        }
        self.history.push(message);
    }

    pub fn history(&self) -> &[Value] {
        &self.history
    }

    /// Text of the last assistant message (blocks joined, trimmed); an aborted message with no text is skipped; `None` without one.
    pub fn last_assistant_text(&self) -> Option<String> {
        self.history
            .iter()
            .rev()
            .filter(|m| m["role"] == "assistant")
            .find_map(|m| {
                let text = message_text(m).trim().to_string();
                (!(stop_reason(m) == "aborted" && text.is_empty())).then_some(text)
            })
    }

    /// Token totals over every assistant message of the session, plus message counts (agent-spec 7.3).
    pub fn stats(&self) -> Value {
        let mut total = [0u64; 4];
        let count = |role: &str| self.history.iter().filter(|m| m["role"] == role).count();
        for message in self.history.iter().filter(|m| m["role"] == "assistant") {
            for (slot, key) in ["input", "output", "cacheRead", "cacheWrite"]
                .iter()
                .enumerate()
            {
                total[slot] += message["usage"][*key].as_u64().unwrap_or(0);
            }
        }
        let calls: usize = self
            .history
            .iter()
            .filter(|m| m["role"] == "assistant")
            .map(|m| tool_calls(m).len())
            .sum();
        let mut stats = json!({
            "userMessages": count("user"), "assistantMessages": count("assistant"), "toolCalls": calls, "toolResults": count("toolResult"),
            "totalMessages": self.history.len(),
            "tokens": {"input": total[0], "output": total[1], "cacheRead": total[2], "cacheWrite": total[3], "total": total.iter().sum::<u64>()},
            "cost": 0,
        });
        if let Some(session) = &self.session {
            stats["sessionFile"] = json!(session.path().display().to_string());
            stats["sessionId"] = json!(session.id());
        }
        stats
    }

    /// One run for a user message: every event goes to `sink` in order. Returns when the run (retries included) has settled.
    pub async fn prompt(&mut self, message: &str, sink: &mut (dyn FnMut(Value) + Send)) {
        self.cancel.store(false, Ordering::SeqCst);
        let mut produced: Vec<Value> = Vec::new();
        sink(json!({"type": "agent_start"}));
        let user = text_message("user", message);
        self.add(user, &mut produced, sink);
        let mut attempt = 0u32;
        loop {
            let (failed_error, aborted) = self.run_turns(&mut produced, sink).await;
            // A session that cannot be written ends the run (a follow-up could not continue it, nor could it be audited): never retried.
            let record_failed = self.session_error.is_some();
            let failed_error = if record_failed {
                self.session_error
                    .as_ref()
                    .map(|e| format!("session record could not be written: {e}"))
            } else {
                failed_error
            };
            match failed_error {
                Some(error)
                    if !record_failed
                        && !aborted
                        && attempt < MAX_RETRIES
                        && is_retryable(&error) =>
                {
                    attempt += 1;
                    let delay = retry_delay_ms(self.config.retry_base_ms, attempt);
                    sink(json!({"type": "agent_end", "messages": produced, "willRetry": true}));
                    sink(
                        json!({"type": "auto_retry_start", "attempt": attempt, "maxAttempts": MAX_RETRIES, "delayMs": delay, "errorMessage": error}),
                    );
                    // the failed assistant message is not fed back to the model
                    if self
                        .history
                        .last()
                        .is_some_and(|m| m["role"] == "assistant" && stop_reason(m) == "error")
                    {
                        self.history.pop();
                    }
                    if !self.wait_unless_aborted(delay).await {
                        sink(
                            json!({"type": "auto_retry_end", "success": false, "attempt": attempt, "finalError": "aborted"}),
                        );
                        sink(json!({"type": "agent_end", "messages": [], "willRetry": false}));
                        break;
                    }
                    produced.clear();
                    continue;
                }
                other => {
                    if attempt > 0 {
                        sink(
                            json!({"type": "auto_retry_end", "success": other.is_none(), "attempt": attempt, "finalError": other}),
                        );
                    }
                    let mut end =
                        json!({"type": "agent_end", "messages": produced, "willRetry": false});
                    if record_failed {
                        end["error"] = json!(other);
                    }
                    sink(end);
                    break;
                }
            }
        }
        sink(json!({"type": "agent_settled"}));
    }

    async fn wait_unless_aborted(&self, ms: u64) -> bool {
        let mut left = ms;
        while left > 0 {
            if self.cancel.load(Ordering::SeqCst) {
                return false;
            }
            let step = left.min(25);
            tokio::time::sleep(Duration::from_millis(step)).await;
            left -= step;
        }
        !self.cancel.load(Ordering::SeqCst)
    }

    fn add(
        &mut self,
        message: Value,
        produced: &mut Vec<Value>,
        sink: &mut (dyn FnMut(Value) + Send),
    ) {
        sink(json!({"type": "message_start", "message": message}));
        sink(json!({"type": "message_end", "message": message}));
        produced.push(message.clone());
        self.remember(message);
    }

    /// Turns until the model stops asking for tools. Returns (error text when the run ended in an error, whether it was aborted).
    async fn run_turns(
        &mut self,
        produced: &mut Vec<Value>,
        sink: &mut (dyn FnMut(Value) + Send),
    ) -> (Option<String>, bool) {
        loop {
            sink(json!({"type": "turn_start"}));
            let began = now_ms();
            let mut opened = false;
            let mut assistant = if self.cancel.load(Ordering::SeqCst) {
                json!({"role": "assistant", "content": [], "stopReason": "aborted", "usage": {}})
            } else {
                let mut pieces = |event: Value, usage: Value| {
                    if !opened {
                        opened = true;
                        sink(
                            json!({"type": "message_start", "message": {"role": "assistant", "content": [], "timestamp": began}}),
                        );
                    }
                    sink(
                        json!({"type": "message_update", "usage": usage, "assistantMessageEvent": event}),
                    );
                };
                match self
                    .model
                    .respond(
                        &ModelRequest {
                            history: &self.history,
                        },
                        &self.cancel,
                        &mut pieces,
                    )
                    .await
                {
                    Some(reply) => reply,
                    None => {
                        json!({"role": "assistant", "content": [], "stopReason": "error", "errorMessage": "replay model has no more recorded replies", "usage": {}})
                    }
                }
            };
            assistant["role"] = json!("assistant");
            assistant["timestamp"] = json!(now_ms());
            if assistant.get("model").is_none() {
                assistant["model"] = json!("replay");
            }
            if !opened {
                sink(
                    json!({"type": "message_start", "message": {"role": "assistant", "content": [], "timestamp": began}}),
                );
            }
            sink(json!({"type": "message_end", "message": assistant}));
            produced.push(assistant.clone());
            self.remember(assistant.clone());
            match TurnEnd::of(&assistant) {
                TurnEnd::Aborted => {
                    sink(json!({"type": "turn_end", "message": assistant, "toolResults": []}));
                    return (None, true);
                }
                TurnEnd::Failed(error) => {
                    sink(json!({"type": "turn_end", "message": assistant, "toolResults": []}));
                    return (Some(error), false);
                }
                TurnEnd::Answer => {
                    sink(json!({"type": "turn_end", "message": assistant, "toolResults": []}));
                    return (None, false);
                }
                TurnEnd::Calls { calls, truncated } => {
                    let mut results = Vec::new();
                    for call in &calls {
                        let result = self.run_call(call, truncated, sink).await;
                        self.add(result.clone(), produced, sink);
                        results.push(result);
                    }
                    sink(json!({"type": "turn_end", "message": assistant, "toolResults": results}));
                    if self.cancel.load(Ordering::SeqCst) {
                        return (None, true);
                    }
                    if self.session_error.is_some() {
                        // The tools of this turn ran to the end; no further model request is made.
                        return (None, false);
                    }
                }
            }
        }
    }

    /// One tool call: start event, the run (or a refusal), end event; returns the toolResult message for the history.
    async fn run_call(
        &mut self,
        call: &Value,
        truncated: bool,
        sink: &mut (dyn FnMut(Value) + Send),
    ) -> Value {
        let id = call["id"].as_str().unwrap_or("").to_string();
        let name = call["name"].as_str().unwrap_or("").to_string();
        let args = call.get("arguments").cloned().unwrap_or(json!({}));
        sink(
            json!({"type": "tool_execution_start", "toolCallId": id, "toolName": name, "args": args}),
        );
        let mut updates: Vec<Value> = Vec::new();
        let (content, details, is_error) = if truncated {
            (
                vec![
                    json!({"type": "text", "text": format!("Tool call {name} did not run: the reply hit the length limit while the arguments were still being written, so they are unfinished. Issue the call again in full.")}),
                ],
                None,
                true,
            )
        } else if self.cancel.load(Ordering::SeqCst) {
            (
                vec![json!({"type": "text", "text": "Tool call was aborted before it started"})],
                None,
                true,
            )
        } else {
            let exec = self.execute(&name, &args, &mut updates, None).await;
            (exec.content, exec.details, exec.is_error)
        };
        for partial in updates {
            sink(
                json!({"type": "tool_execution_update", "toolCallId": id, "toolName": name, "args": args, "partialResult": partial}),
            );
        }
        let mut result = json!({"content": content});
        if let Some(details) = &details {
            result["details"] = details.clone();
        }
        sink(
            json!({"type": "tool_execution_end", "toolCallId": id, "toolName": name, "result": result, "isError": is_error}),
        );
        let mut content = content;
        if self.auto_checks && !truncated {
            content.extend(
                self.auto_checks_after(&id, &name, details.as_ref(), is_error, sink)
                    .await,
            );
        }
        let mut message = json!({"role": "toolResult", "toolCallId": id, "toolName": name, "content": content, "isError": is_error, "timestamp": now_ms()});
        if let Some(details) = details {
            message["details"] = details;
        }
        message
    }

    /// Runs one tool and maps its outcome to (content, details, isError), with the abort handling `run_call` always had. With `limit` the
    /// run is also stopped once it has been going that long (the auto checks); `None` keeps the old behaviour exactly.
    async fn execute(
        &mut self,
        name: &str,
        args: &Value,
        updates: &mut Vec<Value>,
        limit: Option<Duration>,
    ) -> Exec {
        let began = std::time::Instant::now();
        let mut timed_out = false;
        let outcome = {
            let run = self.tools.run(name, args, &self.cancel, updates);
            tokio::pin!(run);
            let mut abort_seen: Option<std::time::Instant> = None;
            loop {
                tokio::select! {
                    done = &mut run => break Some(done),
                    () = tokio::time::sleep(Duration::from_millis(25)) => {
                        if self.cancel.load(Ordering::SeqCst) && abort_seen.is_none() {
                            abort_seen = Some(std::time::Instant::now());
                        }
                        // after an abort the tool gets five seconds to come back, then the loop stops waiting for it
                        if abort_seen.is_some_and(|at| at.elapsed() > ABORT_WAIT) {
                            break None;
                        }
                        if limit.is_some_and(|l| began.elapsed() > l) {
                            timed_out = true;
                            break None;
                        }
                    }
                }
            }
        };
        let (content, details, is_error) = match outcome {
            Some(Ok(CallOutcome::Result {
                content,
                details,
                is_error,
            })) => (content, details, is_error),
            Some(Ok(CallOutcome::Error { message, .. })) => {
                (vec![json!({"type": "text", "text": message})], None, true)
            }
            Some(Err(error)) => (
                vec![json!({"type": "text", "text": error.to_string()})],
                None,
                true,
            ),
            None if timed_out => (
                vec![
                    json!({"type": "text", "text": format!("Tool call {name} did not finish within {} seconds", limit.map_or(0, |l| l.as_secs()))}),
                ],
                None,
                true,
            ),
            None => (
                vec![
                    json!({"type": "text", "text": "Tool call was cancelled and did not answer in time"}),
                ],
                None,
                true,
            ),
        };
        Exec {
            content,
            details,
            is_error,
        }
    }

    /// The auto checks (see `auto_checks`): after a successful plan call, runs the follow-up steps through the tool runner directly (not
    /// through `run_call`, so nothing recurses and the plan's own events stay as they were). Each started step gets its own start and end
    /// event with the id `<plan call id>:auto:<n>`, `auto: true` and `auto_parent_call_id`; a step that never starts emits nothing. Returns
    /// the blocks appended to the plan call's toolResult. A failed, timed-out, cancelled or not-passing step ends the sequence, no retry.
    async fn auto_checks_after(
        &mut self,
        parent_id: &str,
        plan_name: &str,
        plan_details: Option<&Value>,
        plan_error: bool,
        sink: &mut (dyn FnMut(Value) + Send),
    ) -> Vec<Value> {
        let Some((chain, mut refs)) =
            crate::auto_checks::start(plan_name, plan_details, plan_error)
        else {
            return Vec::new();
        };
        let images = self.auto_images;
        let mut folded = Vec::new();
        for (n, tool) in crate::auto_checks::steps(chain).iter().enumerate() {
            if *tool == crate::auto_checks::PREVIEW_TOOL && !images {
                break;
            }
            if !self.tools.exposes(tool) || self.cancel.load(Ordering::SeqCst) {
                break;
            }
            let Some(args) = crate::auto_checks::args_for(tool, &refs) else {
                break;
            };
            let auto_id = format!("{parent_id}:auto:{}", n + 1);
            sink(
                json!({"type": "tool_execution_start", "toolCallId": auto_id, "toolName": tool, "args": args, "auto": true, "auto_parent_call_id": parent_id}),
            );
            let mut updates: Vec<Value> = Vec::new();
            let exec = self
                .execute(tool, &args, &mut updates, Some(self.auto_timeout))
                .await;
            for partial in updates {
                sink(
                    json!({"type": "tool_execution_update", "toolCallId": auto_id, "toolName": tool, "args": args, "partialResult": partial, "auto": true, "auto_parent_call_id": parent_id}),
                );
            }
            let mut result = json!({"content": exec.content});
            if let Some(details) = &exec.details {
                result["details"] = details.clone();
            }
            let mut end = json!({"type": "tool_execution_end", "toolCallId": auto_id, "toolName": tool, "result": result, "isError": exec.is_error, "auto": true, "auto_parent_call_id": parent_id});
            if exec.is_error && self.cancel.load(Ordering::SeqCst) {
                end["cancelled"] = json!(true);
            }
            sink(end);
            let passed = !exec.is_error
                && crate::auto_checks::judge(
                    tool,
                    exec.details.as_ref(),
                    crate::auto_checks::has_image(&exec.content),
                    &mut refs,
                );
            if passed {
                folded.extend(crate::auto_checks::pass_blocks(tool, &exec.content));
            } else {
                folded.extend(crate::auto_checks::stop_blocks(tool, &exec.content));
                break;
            }
        }
        folded
    }

    /// Answers one command line of the JSONL protocol (agent-spec 2 and 3); `prompt` runs to its end, so `abort` is set through `cancel`.
    pub async fn command(&mut self, line: &str, out: &mut (dyn FnMut(Value) + Send)) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Ok(command) = serde_json::from_str::<Value>(line) else {
            out(
                json!({"type": "response", "command": "parse", "success": false, "error": format!("command line is not valid JSON: {line}")}),
            );
            return;
        };
        let name = command["type"].as_str().unwrap_or("").to_string();
        let mut response = json!({"type": "response", "command": name, "success": true});
        if let Some(id) = command.get("id") {
            response["id"] = id.clone();
        }
        match name.as_str() {
            "prompt" => {
                out(response);
                let text = command["message"].as_str().unwrap_or("").to_string();
                self.prompt(&text, out).await;
            }
            "abort" => {
                self.cancel.store(true, Ordering::SeqCst);
                out(response);
            }
            "get_last_assistant_text" => {
                response["data"] = json!({"text": self.last_assistant_text()});
                out(response);
            }
            "get_session_stats" => {
                response["data"] = self.stats();
                out(response);
            }
            other => {
                response["success"] = json!(false);
                response["error"] = json!(format!("No such command: {other}"));
                out(response);
            }
        }
    }
}

/// Events of one run over a small scripted session, for the tests of the readers that consume them.
#[cfg(test)]
pub async fn sample_events() -> Vec<Value> {
    let reply = |content: Value, reason: &str| json!({"content": content, "stopReason": reason, "usage": {"input": 10, "output": 5, "cacheRead": 2, "cacheWrite": 1}});
    let model = ReplayModel::new(vec![
        reply(
            json!([{"type": "toolCall", "id": "a1", "name": "echo", "arguments": {"text": "hi"}}]),
            "toolUse",
        ),
        reply(json!([{"type": "text", "text": "done"}]), "stop"),
    ]);
    let mut agent = Agent::new(
        Box::new(model),
        Box::new(tests::Fake::new(Default::default())),
        Config::default(),
    );
    let mut events = Vec::new();
    agent.prompt("go", &mut |event| events.push(event)).await;
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_schema;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    pub struct Fake {
        pub log: Arc<Mutex<Vec<String>>>,
        schemas: BTreeMap<&'static str, Value>,
    }

    impl Fake {
        pub fn new(log: Arc<Mutex<Vec<String>>>) -> Self {
            let text_tool = json!({"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]});
            let schemas = BTreeMap::from([
                ("echo", text_tool.clone()),
                ("fail", text_tool),
                ("wait", json!({"type": "object", "properties": {}})),
            ]);
            Self { log, schemas }
        }
    }

    #[async_trait]
    impl ToolRunner for Fake {
        async fn run(
            &mut self,
            name: &str,
            args: &Value,
            cancel: &AtomicBool,
            progress: &mut Vec<Value>,
        ) -> Result<CallOutcome> {
            let Some(schema) = self.schemas.get(name) else {
                return Ok(CallOutcome::Error {
                    kind: "unknown_tool".into(),
                    message: format!("No tool named {name} is registered"),
                });
            };
            let errors = tool_schema::validate(schema, args, "");
            if !errors.is_empty() {
                return Ok(CallOutcome::Error {
                    kind: "invalid_args".into(),
                    message: tool_schema::failure_text(name, &errors, args),
                });
            }
            self.log.lock().unwrap().push(name.to_string());
            if name == "wait" {
                while !cancel.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                return Ok(CallOutcome::Error {
                    kind: "cancelled".into(),
                    message: "cancelled".into(),
                });
            }
            progress.push(json!({"content": [{"type": "text", "text": "working"}]}));
            Ok(CallOutcome::Result {
                content: vec![json!({"type": "text", "text": format!("ran {name}")})],
                details: Some(json!({"ok": true})),
                is_error: name == "fail",
            })
        }

        fn exposes(&self, name: &str) -> bool {
            self.schemas.contains_key(name)
        }
    }

    fn usage() -> Value {
        json!({"input": 10, "output": 5, "cacheRead": 2, "cacheWrite": 1})
    }

    fn say(text: &str) -> Value {
        json!({"content": [{"type": "text", "text": text}], "stopReason": "stop", "usage": usage()})
    }

    fn calls(list: Value, reason: &str) -> Value {
        json!({"content": list, "stopReason": reason, "usage": usage()})
    }

    fn call(id: &str, name: &str, args: Value) -> Value {
        json!({"type": "toolCall", "id": id, "name": name, "arguments": args})
    }

    fn failure(text: &str) -> Value {
        json!({"content": [], "stopReason": "error", "errorMessage": text, "usage": {}})
    }

    fn agent_with(
        turns: Vec<Value>,
        retry_base_ms: u64,
    ) -> (
        Agent,
        Arc<Mutex<Vec<String>>>,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let model = ReplayModel::new(turns);
        let seen = model.requests_seen.clone();
        (
            Agent::new(
                Box::new(model),
                Box::new(Fake::new(log.clone())),
                Config { retry_base_ms },
            ),
            log,
            seen,
        )
    }

    async fn run(agent: &mut Agent, message: &str) -> Vec<Value> {
        let mut events = Vec::new();
        agent.prompt(message, &mut |event| events.push(event)).await;
        events
    }

    fn types(events: &[Value]) -> Vec<String> {
        events
            .iter()
            .map(|e| e["type"].as_str().unwrap_or("").to_string())
            .collect()
    }

    fn ends(events: &[Value]) -> Vec<&Value> {
        events
            .iter()
            .filter(|e| e["type"] == "tool_execution_end")
            .collect()
    }

    fn without_timestamps(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("timestamp");
                map.values_mut().for_each(without_timestamps);
            }
            Value::Array(list) => list.iter_mut().for_each(without_timestamps),
            _ => {}
        }
    }

    #[test]
    fn the_switch_is_exactly_rust() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            agent_rust_enabled(),
            std::env::var(AGENT_ENV).as_deref() == Ok("rust")
        );
        assert!(rust_selected(Some("rust")));
        for other in [
            None,
            Some(""),
            Some("1"),
            Some("Rust"),
            Some("rust "),
            Some("true"),
            Some("pi"),
        ] {
            assert!(!rust_selected(other), "{other:?}");
        }
    }

    #[test]
    fn retry_backoff_and_error_texts_follow_the_spec() {
        assert_eq!(
            [1, 2, 3].map(|n| retry_delay_ms(RETRY_BASE_MS, n)),
            [2000, 4000, 8000]
        );
        for text in [
            "HTTP 504 upstream timeout",
            "Overloaded",
            "429 Too Many Requests",
            "fetch failed",
            "upstream closed the stream early (connection reset)",
            "Service Unavailable",
        ] {
            assert!(is_retryable(text), "{text}");
        }
        for text in [
            "invalid_request_error: insufficient balance, please top up",
            "billing_error: account has no credit",
            "maximum context length exceeded",
            "invalid api key",
        ] {
            assert!(!is_retryable(text), "{text}");
        }
    }

    #[tokio::test]
    async fn a_run_with_a_tool_emits_the_events_in_order_and_with_the_documented_fields() {
        let (mut agent, log, _) = agent_with(
            vec![
                calls(
                    json!([call("c1", "echo", json!({"text": "hi"}))]),
                    "toolUse",
                ),
                say("all done"),
            ],
            1,
        );
        let events = run(&mut agent, "start").await;
        assert_eq!(
            types(&events),
            [
                "agent_start",
                "message_start",
                "message_end",
                "turn_start",
                "message_start",
                "message_update",
                "message_update",
                "message_update",
                "message_end",
                "tool_execution_start",
                "tool_execution_update",
                "tool_execution_end",
                "message_start",
                "message_end",
                "turn_end",
                "turn_start",
                "message_start",
                "message_update",
                "message_update",
                "message_update",
                "message_end",
                "turn_end",
                "agent_end",
                "agent_settled"
            ]
        );
        assert_eq!(*log.lock().unwrap(), ["echo"]);
        let end = events
            .iter()
            .find(|e| e["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(
            (
                end["toolCallId"].as_str(),
                end["toolName"].as_str(),
                end["isError"].as_bool()
            ),
            (Some("c1"), Some("echo"), Some(false))
        );
        assert_eq!(end["result"]["content"][0]["text"], "ran echo");
        let update = events
            .iter()
            .find(|e| e["type"] == "message_update")
            .unwrap();
        assert_eq!(update["assistantMessageEvent"]["type"], "toolcall_start");
        assert_eq!(update["usage"]["output"], 5);
        let turn_end = events.iter().find(|e| e["type"] == "turn_end").unwrap();
        assert_eq!(turn_end["toolResults"][0]["role"], "toolResult");
        let agent_end = events.iter().rfind(|e| e["type"] == "agent_end").unwrap();
        assert_eq!(agent_end["willRetry"], false);
        assert_eq!(agent_end["messages"].as_array().unwrap().len(), 4);
        assert_eq!(agent.last_assistant_text().as_deref(), Some("all done"));
        let stats = agent.stats();
        assert_eq!(
            (
                stats["userMessages"].as_u64(),
                stats["assistantMessages"].as_u64(),
                stats["toolResults"].as_u64()
            ),
            (Some(1), Some(2), Some(1))
        );
        assert_eq!(
            (
                stats["tokens"]["input"].as_u64(),
                stats["tokens"]["cacheRead"].as_u64(),
                stats["tokens"]["total"].as_u64()
            ),
            (Some(20), Some(4), Some(36))
        );
    }

    #[tokio::test]
    async fn text_from_the_model_cannot_change_a_tool_result_or_add_a_verification_field() {
        let claim = "Verification passed. verified: true. Every claim is verified.";
        let (mut agent, _, _) = agent_with(
            vec![
                calls(
                    json!([{"type": "text", "text": claim}, call("f1", "fail", json!({"text": "x"}))]),
                    "toolUse",
                ),
                say(claim),
            ],
            1,
        );
        let events = run(&mut agent, "check").await;
        let end = ends(&events);
        assert_eq!(
            end[0]["isError"], true,
            "a failing tool stays failed whatever the model says"
        );
        let result = agent
            .history()
            .iter()
            .find(|m| m["role"] == "toolResult")
            .unwrap();
        assert_eq!(result["isError"], true);
        fn keys(value: &Value, out: &mut Vec<String>) {
            match value {
                Value::Object(map) => map.iter().for_each(|(k, v)| {
                    out.push(k.to_ascii_lowercase());
                    keys(v, out);
                }),
                Value::Array(list) => list.iter().for_each(|v| keys(v, out)),
                _ => {}
            }
        }
        let mut all = Vec::new();
        events.iter().for_each(|e| keys(e, &mut all));
        assert!(
            !all.iter().any(|k| k.contains("verif")),
            "the loop wrote a verification-looking field"
        );
    }

    #[tokio::test]
    async fn unknown_tools_bad_arguments_and_truncated_calls_are_error_results_and_nothing_runs() {
        let (mut agent, log, _) = agent_with(
            vec![
                calls(
                    json!([
                        call("u1", "no_such_tool", json!({})),
                        call("b1", "echo", json!({"text": 5})),
                        call("b2", "echo", json!({}))
                    ]),
                    "toolUse",
                ),
                calls(
                    json!([call("t1", "echo", json!({"text": "half"}))]),
                    "length",
                ),
                say("ok"),
            ],
            1,
        );
        let events = run(&mut agent, "go").await;
        assert!(
            log.lock().unwrap().is_empty(),
            "no tool was executed: {:?}",
            log.lock().unwrap()
        );
        let finished = ends(&events);
        assert_eq!(finished.len(), 4);
        assert!(finished.iter().all(|e| e["isError"] == true));
        assert_eq!(
            finished[0]["result"]["content"][0]["text"],
            "No tool named no_such_tool is registered"
        );
        assert!(finished[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("Tool \"echo\" rejected its arguments:\n  - text: Expected string"));
        assert!(finished[2]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("text: Expected required property"));
        assert!(finished[3]["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("hit the length limit"));
        let results: Vec<&Value> = agent
            .history()
            .iter()
            .filter(|m| m["role"] == "toolResult")
            .collect();
        assert_eq!(
            results
                .iter()
                .map(|m| m["toolCallId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["u1", "b1", "b2", "t1"],
            "results keep the call order"
        );
        assert_eq!(agent.last_assistant_text().as_deref(), Some("ok"));
    }

    #[tokio::test]
    async fn a_transient_error_is_retried_with_the_spec_backoff_and_the_failed_message_is_dropped()
    {
        let (mut agent, _, seen) = agent_with(
            vec![
                failure("HTTP 504 upstream timeout RAW-TEXT"),
                failure("overloaded"),
                say("recovered"),
            ],
            1,
        );
        let events = run(&mut agent, "go").await;
        let starts: Vec<&Value> = events
            .iter()
            .filter(|e| e["type"] == "auto_retry_start")
            .collect();
        assert_eq!(
            starts
                .iter()
                .map(|e| (
                    e["attempt"].as_u64().unwrap(),
                    e["delayMs"].as_u64().unwrap(),
                    e["maxAttempts"].as_u64().unwrap()
                ))
                .collect::<Vec<_>>(),
            [(1, 1, 3), (2, 2, 3)]
        );
        assert_eq!(
            starts[0]["errorMessage"], "HTTP 504 upstream timeout RAW-TEXT",
            "the provider's words are kept"
        );
        let ends: Vec<&Value> = events.iter().filter(|e| e["type"] == "agent_end").collect();
        assert_eq!(
            ends.iter()
                .map(|e| e["willRetry"].as_bool().unwrap())
                .collect::<Vec<_>>(),
            [true, true, false]
        );
        let finish = events
            .iter()
            .find(|e| e["type"] == "auto_retry_end")
            .unwrap();
        assert_eq!(
            (finish["success"].as_bool(), finish["attempt"].as_u64()),
            (Some(true), Some(2))
        );
        assert_eq!(
            types(&events).last().map(String::as_str),
            Some("agent_settled")
        );
        assert_eq!(seen.load(Ordering::SeqCst), 3);
        assert!(
            agent.history().iter().all(|m| stop_reason(m) != "error"),
            "the failed replies are not fed back"
        );
    }

    #[tokio::test]
    async fn retries_stop_after_three_and_quota_errors_and_context_overflow_are_not_retried() {
        let (mut agent, _, seen) = agent_with(
            vec![
                failure("503"),
                failure("503"),
                failure("503"),
                failure("503 final"),
            ],
            1,
        );
        let events = run(&mut agent, "go").await;
        assert_eq!(
            events
                .iter()
                .filter(|e| e["type"] == "auto_retry_start")
                .count(),
            3
        );
        assert_eq!(seen.load(Ordering::SeqCst), 4);
        let finish = events
            .iter()
            .find(|e| e["type"] == "auto_retry_end")
            .unwrap();
        assert_eq!(
            (finish["success"].as_bool(), finish["finalError"].as_str()),
            (Some(false), Some("503 final"))
        );
        assert_eq!(
            events.iter().rfind(|e| e["type"] == "agent_end").unwrap()["willRetry"],
            false
        );
        for text in [
            "billing_error: insufficient balance",
            "maximum context length exceeded",
        ] {
            let (mut agent, _, seen) = agent_with(vec![failure(text), say("never")], 1);
            let events = run(&mut agent, "go").await;
            assert_eq!(
                events
                    .iter()
                    .filter(|e| e["type"] == "auto_retry_start")
                    .count(),
                0,
                "{text}"
            );
            assert_eq!(seen.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn an_abort_during_a_tool_ends_the_run_cleanly_without_a_retry() {
        let (mut agent, log, seen) = agent_with(
            vec![
                calls(
                    json!([
                        call("w1", "wait", json!({})),
                        call("e1", "echo", json!({"text": "later"}))
                    ]),
                    "toolUse",
                ),
                say("never"),
            ],
            1,
        );
        let cancel = agent.cancel.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            cancel.store(true, Ordering::SeqCst);
        });
        let events = run(&mut agent, "go").await;
        stopper.await.unwrap();
        let finished = ends(&events);
        assert_eq!(finished.len(), 2);
        assert!(
            finished.iter().all(|e| e["isError"] == true),
            "the started tool and the one that never started both end as errors"
        );
        assert_eq!(*log.lock().unwrap(), ["wait"], "the second call never ran");
        let order = types(&events);
        assert_eq!(
            &order[order.len() - 3..],
            ["turn_end", "agent_end", "agent_settled"]
        );
        assert_eq!(
            events.iter().rfind(|e| e["type"] == "agent_end").unwrap()["willRetry"],
            false
        );
        assert_eq!(
            seen.load(Ordering::SeqCst),
            1,
            "no further model request after the abort"
        );
    }

    #[tokio::test]
    async fn an_abort_while_waiting_to_retry_cancels_the_wait_and_does_not_retry() {
        let (mut agent, _, seen) = agent_with(vec![failure("503"), say("never")], 60_000);
        let cancel = agent.cancel.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            cancel.store(true, Ordering::SeqCst);
        });
        let started = std::time::Instant::now();
        let events = run(&mut agent, "go").await;
        stopper.await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        assert_eq!(
            types(&events).last().map(String::as_str),
            Some("agent_settled")
        );
        assert_eq!(
            events.iter().rfind(|e| e["type"] == "agent_end").unwrap()["willRetry"],
            false
        );
    }

    #[tokio::test]
    async fn each_request_carries_the_conversation_so_far_without_failed_replies() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let model = ReplayModel::new(vec![
            failure("503"),
            calls(json!([call("c1", "echo", json!({"text": "a"}))]), "toolUse"),
            say("fin"),
        ]);
        let sizes = model.history_sizes.clone();
        let mut agent = Agent::new(
            Box::new(model),
            Box::new(Fake::new(log)),
            Config { retry_base_ms: 1 },
        );
        run(&mut agent, "go").await;
        assert_eq!(*sizes.lock().unwrap(), [1, 1, 3]);
    }

    #[tokio::test]
    async fn commands_answer_as_the_protocol_says() {
        let (mut agent, _, _) = agent_with(vec![say("  hello  ")], 1);
        let mut out = Vec::new();
        agent.command("{not json", &mut |v| out.push(v)).await;
        agent
            .command(r#"{"id":"1","type":"get_last_assistant_text"}"#, &mut |v| {
                out.push(v)
            })
            .await;
        agent
            .command(r#"{"id":"2","type":"set_model"}"#, &mut |v| out.push(v))
            .await;
        agent
            .command(
                "{\"id\":\"3\",\"type\":\"prompt\",\"message\":\"hi\"}\r",
                &mut |v| out.push(v),
            )
            .await;
        agent
            .command(r#"{"id":"4","type":"get_last_assistant_text"}"#, &mut |v| {
                out.push(v)
            })
            .await;
        agent
            .command(r#"{"id":"5","type":"get_session_stats"}"#, &mut |v| {
                out.push(v)
            })
            .await;
        assert_eq!(out[0]["command"], "parse");
        assert_eq!(out[0]["success"], false);
        assert_eq!(out[1]["data"]["text"], Value::Null);
        assert_eq!(out[2]["error"], "No such command: set_model");
        assert_eq!(
            (
                out[3]["command"].as_str(),
                out[3]["success"].as_bool(),
                out[3]["id"].as_str()
            ),
            (Some("prompt"), Some(true), Some("3"))
        );
        let last = out.iter().rev().find(|v| v["id"] == "4").unwrap();
        assert_eq!(last["data"]["text"], "hello");
        assert_eq!(out.last().unwrap()["data"]["tokens"]["output"], 5);
    }

    /// Output of the old path (the scripted stand-in process) for one scenario: its events, one parsed JSON value per line.
    fn mock_events(scenario: &str, error_text: Option<&str>) -> Vec<Value> {
        use std::io::Write;
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        // Tests run in parallel inside one process and several use the same scenario: the call number keeps each run's folder its own.
        static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let call = CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "agent-loop-mock-{}-{}-{}",
            scenario,
            std::process::id(),
            call
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut command = std::process::Command::new("python3");
        command
            .arg(root.join("scripts/mock_pi.py"))
            .args(["--mode", "rpc"])
            .env("NEWSROOM_ARTIFACT_DIR", &dir)
            .env("MOCK_PI_SCENARIO", scenario);
        if let Some(text) = error_text {
            command.env("MOCK_PI_ERROR_TEXT", text);
        }
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"{\"id\":\"p\",\"type\":\"prompt\",\"message\":\"smoke\"}\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        std::fs::remove_dir_all(&dir).ok();
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// What both paths report for a tool run: the call, its arguments, how it ended, the answer text, and the settle.
    fn tool_projection(events: &[Value]) -> Vec<Value> {
        events
            .iter()
            .filter_map(|e| match e["type"].as_str()? {
                "tool_execution_start" => {
                    Some(json!(["start", e["toolCallId"], e["toolName"], e["args"]]))
                }
                "tool_execution_end" => {
                    Some(json!(["end", e["toolCallId"], e["toolName"], e["isError"]]))
                }
                "message_update" if e["assistantMessageEvent"]["type"] == "text_delta" => {
                    Some(json!(["text", e["assistantMessageEvent"]["delta"]]))
                }
                "agent_settled" => Some(json!(["settled"])),
                _ => None,
            })
            .collect()
    }

    /// What both paths report for a turn that ends in a provider error.
    fn error_projection(events: &[Value]) -> Vec<Value> {
        events
            .iter()
            .filter_map(|e| match e["type"].as_str()? {
                "turn_start" => Some(json!(["turn_start"])),
                "message_end" if e["message"]["role"] == "assistant" => Some(json!([
                    "assistant_end",
                    e["message"]["stopReason"],
                    e["message"]["errorMessage"]
                ])),
                "message_update" if e["assistantMessageEvent"]["type"] == "text_delta" => {
                    Some(json!(["text", e["assistantMessageEvent"]["delta"]]))
                }
                "turn_end" => Some(json!(["turn_end", e["message"]["stopReason"]])),
                "agent_end" => Some(json!(["agent_end", e["willRetry"]])),
                "agent_settled" => Some(json!(["settled"])),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn the_new_path_reports_the_same_tool_events_as_the_old_stand_in_process() {
        let old = mock_events("", None);
        let recorded: Vec<&Value> = old
            .iter()
            .filter(|e| e["type"] == "tool_execution_start")
            .collect();
        let errors: BTreeMap<String, bool> = old
            .iter()
            .filter(|e| e["type"] == "tool_execution_end")
            .map(|e| {
                (
                    e["toolCallId"].as_str().unwrap().to_string(),
                    e["isError"].as_bool().unwrap(),
                )
            })
            .collect();
        assert!(
            recorded.len() > 20 && errors.values().any(|e| *e),
            "the recording holds many calls and one failing call"
        );
        let answer = old.iter().find(|e| e["type"] == "message_update").unwrap()
            ["assistantMessageEvent"]["delta"]
            .as_str()
            .unwrap()
            .to_string();
        let blocks: Vec<Value> = recorded
            .iter()
            .map(|e| {
                call(
                    e["toolCallId"].as_str().unwrap(),
                    e["toolName"].as_str().unwrap(),
                    e["args"].clone(),
                )
            })
            .collect();
        struct ByRecord(BTreeMap<String, bool>, Vec<String>);
        #[async_trait]
        impl ToolRunner for ByRecord {
            async fn run(
                &mut self,
                name: &str,
                _args: &Value,
                _c: &AtomicBool,
                _p: &mut Vec<Value>,
            ) -> Result<CallOutcome> {
                let id = self.1.remove(0);
                Ok(CallOutcome::Result {
                    content: vec![json!({"type": "text", "text": name})],
                    details: None,
                    is_error: self.0[&id],
                })
            }

            fn exposes(&self, _name: &str) -> bool {
                false
            }
        }
        let ids: Vec<String> = recorded
            .iter()
            .map(|e| e["toolCallId"].as_str().unwrap().to_string())
            .collect();
        let model = ReplayModel::new(vec![calls(json!(blocks), "toolUse"), say(&answer)]);
        let mut agent = Agent::new(
            Box::new(model),
            Box::new(ByRecord(errors, ids)),
            Config::default(),
        );
        let new = run(&mut agent, "smoke").await;
        assert_eq!(tool_projection(&new), tool_projection(&old));
    }

    #[tokio::test]
    async fn a_provider_error_turn_matches_the_old_stand_in_process_and_is_not_retried_for_a_context_error(
    ) {
        let text = "maximum context length exceeded MOCK-RAW-PROVIDER-TEXT";
        let old = mock_events("provider_error_after_text", Some(text));
        let model = ReplayModel::new(vec![
            json!({"content": [{"type": "text", "text": "Mock investigation completed after recovering from one source failure."}], "stopReason": "error", "errorMessage": text, "usage": {"input": 51000, "output": 10}}),
        ]);
        let mut agent = Agent::new(
            Box::new(model),
            Box::new(Fake::new(Default::default())),
            Config::default(),
        );
        let new = run(&mut agent, "smoke").await;
        assert_eq!(error_projection(&new), error_projection(&old));
    }

    #[tokio::test]
    async fn every_event_type_of_the_spec_appears_and_nothing_else_does() {
        let (mut agent, _, _) = agent_with(
            vec![
                failure("503"),
                json!({"content": [{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": "x"}, call("c", "echo", json!({"text": "t"}))], "stopReason": "toolUse", "usage": usage()}),
                say("done"),
            ],
            1,
        );
        let mut events = run(&mut agent, "go").await;
        let mut out = Vec::new();
        agent
            .command(r#"{"type":"get_session_stats"}"#, &mut |v| out.push(v))
            .await;
        events.extend(out);
        let mut seen: Vec<String> = types(&events);
        seen.sort();
        seen.dedup();
        let thirteen = [
            "agent_end",
            "agent_settled",
            "agent_start",
            "auto_retry_end",
            "auto_retry_start",
            "message_end",
            "message_start",
            "message_update",
            "response",
            "turn_end",
            "turn_start",
            "tool_execution_end",
            "tool_execution_start",
        ];
        let mut expected: Vec<String> = thirteen.iter().map(|s| s.to_string()).collect();
        expected.push("tool_execution_update".into());
        expected.sort();
        assert_eq!(
            seen, expected,
            "the 12 run events, the response, and the optional progress event"
        );
        let kinds: Vec<&str> = events
            .iter()
            .filter(|e| e["type"] == "message_update")
            .filter_map(|e| e["assistantMessageEvent"]["type"].as_str())
            .collect();
        for kind in [
            "thinking_start",
            "thinking_delta",
            "thinking_end",
            "text_start",
            "text_delta",
            "text_end",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_end",
        ] {
            assert!(kinds.contains(&kind), "{kind}");
        }
    }

    #[tokio::test]
    async fn the_existing_consumers_accept_the_stream() {
        let _command = crate::group_guard::command_for_test("investigate");
        use crate::{audit, repeat_failure::RepeatFailureWatch, step_lines::StepTracker};
        let mut events = sample_events().await;
        let (mut agent, _, _) = agent_with(
            vec![
                calls(json!([call("f1", "fail", json!({"text": "x"}))]), "toolUse"),
                say("end"),
            ],
            1,
        );
        events.extend(run(&mut agent, "again").await);
        let mut tracker = StepTracker::default();
        let mut watch = RepeatFailureWatch::default();
        let mut lines = 0;
        for event in &events {
            match event["type"].as_str() {
                Some("tool_execution_start") => {
                    tracker.on_start(event, 0.0);
                    watch.on_start(event);
                }
                Some("tool_execution_end") => {
                    lines += tracker.on_end(event, 3.0, false).len();
                    assert!(watch.on_end(event).is_none());
                }
                _ => {}
            }
        }
        assert_eq!(lines, 2, "one step line per finished call");
        let mut five = RepeatFailureWatch::default();
        let failing = |id: &str| json!({"type": "tool_execution_end", "toolCallId": id, "toolName": "fail", "isError": true, "result": {"content": [{"type": "text", "text": "boom"}]}});
        let start = |id: &str| json!({"type": "tool_execution_start", "toolCallId": id, "toolName": "fail", "args": {"text": "x"}});
        let stopped = (0..6)
            .filter_map(|i| {
                let id = format!("r{i}");
                five.on_start(&start(&id));
                five.on_end(&failing(&id))
            })
            .count();
        assert!(
            stopped >= 1,
            "identical failures fed through the same watcher still stop the run"
        );
        let dir = std::env::temp_dir().join(format!("agent-loop-audit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("events.jsonl");
        std::fs::write(
            &log,
            events.iter().map(|e| format!("{e}\n")).collect::<String>(),
        )
        .unwrap();
        let summary = audit::build(&log, &dir.join("tools.json")).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(
            (summary.tool_calls, summary.failed_tool_calls, summary.turns),
            (2, 1, 4)
        );
        assert_eq!(summary.tools.get("echo"), Some(&1));
    }

    #[tokio::test]
    async fn the_new_path_and_the_old_one_give_the_same_audit_calls() {
        let _command = crate::group_guard::command_for_test("investigate");
        use crate::audit;
        let old = mock_events("", None);
        let dir = std::env::temp_dir().join(format!("agent-loop-audit2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, events: &[Value]| {
            let path = dir.join(name);
            std::fs::write(
                &path,
                events.iter().map(|e| format!("{e}\n")).collect::<String>(),
            )
            .unwrap();
            audit::build(&path, &dir.join("tools.json")).unwrap()
        };
        let old_summary = write("old.jsonl", &old);
        let recorded: Vec<&Value> = old
            .iter()
            .filter(|e| e["type"] == "tool_execution_start")
            .collect();
        let errors: BTreeMap<String, bool> = old
            .iter()
            .filter(|e| e["type"] == "tool_execution_end")
            .map(|e| {
                (
                    e["toolCallId"].as_str().unwrap().to_string(),
                    e["isError"].as_bool().unwrap(),
                )
            })
            .collect();
        let mut synthetic = Vec::new();
        for e in &recorded {
            synthetic.push((*e).clone());
            synthetic.push(json!({"type": "tool_execution_end", "toolCallId": e["toolCallId"], "toolName": e["toolName"], "isError": errors[e["toolCallId"].as_str().unwrap()], "result": {"content": []}}));
        }
        let new_summary = write("new.jsonl", &synthetic);
        std::fs::remove_dir_all(&dir).ok();
        let calls_of = |s: &audit::AuditSummary| {
            s.calls
                .iter()
                .map(|c| (c.id.clone(), c.tool.clone(), c.args.clone(), c.is_error))
                .collect::<Vec<_>>()
        };
        assert_eq!(calls_of(&old_summary), calls_of(&new_summary));
        let _ = without_timestamps;
    }

    /// A model that hands over one increment, then records how many events the sink had by then.
    struct Slow {
        seen: Arc<Mutex<Vec<String>>>,
        at_second: Arc<Mutex<Option<usize>>>,
    }

    #[async_trait]
    impl Model for Slow {
        async fn respond(
            &mut self,
            _request: &ModelRequest<'_>,
            _cancel: &AtomicBool,
            pieces: Pieces<'_>,
        ) -> Option<Value> {
            pieces(json!({"type": "text_start", "contentIndex": 0}), json!({}));
            pieces(
                json!({"type": "text_delta", "contentIndex": 0, "delta": "Hi"}),
                json!({}),
            );
            *self.at_second.lock().unwrap() = Some(self.seen.lock().unwrap().len());
            Some(
                json!({"content": [{"type": "text", "text": "Hi"}], "stopReason": "stop", "usage": {}}),
            )
        }
    }

    #[tokio::test]
    async fn the_loop_forwards_each_piece_before_the_model_returns() {
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let at_second = Arc::new(Mutex::new(None));
        let model = Slow {
            seen: seen.clone(),
            at_second: at_second.clone(),
        };
        let mut agent = Agent::new(
            Box::new(model),
            Box::new(Fake::new(Arc::default())),
            Config::default(),
        );
        let log = seen.clone();
        agent
            .prompt("hi", &mut |e| {
                log.lock()
                    .unwrap()
                    .push(e["type"].as_str().unwrap_or("").to_string())
            })
            .await;
        // agent_start, the user message (start, end), turn_start, message_start, two message_update were out while respond was still running.
        assert_eq!(*at_second.lock().unwrap(), Some(7));
        let all = seen.lock().unwrap().clone();
        assert_eq!(all[7], "message_end");
    }

    #[tokio::test]
    async fn the_replay_model_goes_through_the_same_path() {
        let reply = json!({"content": [{"type": "text", "text": "ok"}], "stopReason": "stop", "usage": {"input": 3}});
        let mut agent = Agent::new(
            Box::new(ReplayModel::new(vec![reply])),
            Box::new(Fake::new(Arc::default())),
            Config::default(),
        );
        let mut events = Vec::new();
        agent.prompt("hi", &mut |e| events.push(e)).await;
        let kinds: Vec<&str> = events
            .iter()
            .filter_map(|e| e["assistantMessageEvent"]["type"].as_str())
            .collect();
        assert_eq!(kinds, ["text_start", "text_delta", "text_end"]);
        let update = events
            .iter()
            .find(|e| e["type"] == "message_update")
            .unwrap();
        assert_eq!(update["usage"]["input"], 3);
    }

    fn session_agent(turns: Vec<Value>, dir: &Path, resume: bool) -> Result<Agent, SessionError> {
        let (agent, _, _) = agent_with(turns, 1);
        if resume {
            agent.with_resumed_session(dir, "/w")
        } else {
            agent.with_new_session(dir, "/w")
        }
    }

    fn file_lines(dir: &Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("agent-session/session.jsonl"))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn a_run_is_written_to_the_linear_session_and_a_follow_up_continues_it() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let mut agent = session_agent(
            vec![
                calls(json!([call("e1", "echo", json!({"text": "a"}))]), "toolUse"),
                say("first answer"),
            ],
            dir.path(),
            false,
        )
        .unwrap();
        run(&mut agent, "question one").await;
        assert!(agent.session_error().is_none());
        let on_disk = file_lines(dir.path());
        assert_eq!(on_disk[0]["type"], "session-header");
        let roles: Vec<&str> = on_disk[1..]
            .iter()
            .map(|r| r["message"]["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["user", "assistant", "toolResult", "assistant"]);
        assert_eq!(on_disk[1..].len(), agent.history().len());
        let id = agent.stats()["sessionId"].clone();
        drop(agent);

        let (mut second, _, seen) = agent_with(vec![say("second answer")], 1);
        second = second.with_resumed_session(dir.path(), "/w").unwrap();
        assert_eq!(second.history().len(), 4, "history came from the file");
        assert_eq!(second.stats()["sessionId"], id, "same session continues");
        let events = run(&mut second, "question two").await;
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        assert_eq!(
            second.last_assistant_text().as_deref(),
            Some("second answer")
        );
        assert!(types(&events).contains(&"agent_settled".to_string()));
        let all = file_lines(dir.path());
        assert_eq!(
            all.len(),
            1 + 6,
            "one header and six messages, none lost or repeated"
        );
        assert_eq!(
            all.last().unwrap()["message"]["content"][0]["text"],
            "second answer"
        );
    }

    #[tokio::test]
    async fn the_second_run_sends_the_first_runs_messages_to_the_model() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let mut first = session_agent(vec![say("A1")], dir.path(), false).unwrap();
        run(&mut first, "Q1").await;
        drop(first);
        let mut second = session_agent(vec![say("A2")], dir.path(), true).unwrap();
        assert_eq!(second.history()[0]["role"], "user");
        assert_eq!(second.history()[1]["content"][0]["text"], "A1");
        run(&mut second, "Q2").await;
        assert_eq!(second.history().len(), 4);
    }

    #[tokio::test]
    async fn an_old_format_run_folder_is_refused_for_a_follow_up_and_not_started_over() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("session");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("s.jsonl"), "{\"type\":\"session\"}\n").unwrap();
        let error = session_agent(vec![say("never")], dir.path(), true)
            .err()
            .expect("refused");
        assert!(matches!(error, SessionError::OldFormat));
        assert!(!dir.path().join("agent-session").exists());
        assert_eq!(std::fs::read_dir(&old).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn the_stats_match_the_fields_the_old_readers_use() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let mut agent = session_agent(
            vec![
                calls(
                    json!([
                        call("e1", "echo", json!({"text": "a"})),
                        call("f1", "fail", json!({"text": "b"}))
                    ]),
                    "toolUse",
                ),
                say("done"),
            ],
            dir.path(),
            false,
        )
        .unwrap();
        run(&mut agent, "go").await;
        let stats = agent.stats();
        // two assistant messages, each with usage 10 / 5 / 2 / 1
        assert_eq!(stats["tokens"]["input"], 20);
        assert_eq!(stats["tokens"]["output"], 10);
        assert_eq!(stats["tokens"]["cacheRead"], 4);
        assert_eq!(stats["tokens"]["cacheWrite"], 2);
        assert_eq!(stats["userMessages"], 1);
        assert_eq!(stats["assistantMessages"], 2);
        assert_eq!(stats["toolCalls"], 2);
        assert_eq!(stats["toolResults"], 2);
        assert_eq!(stats["totalMessages"], 5);
        assert!(stats["sessionFile"]
            .as_str()
            .unwrap()
            .ends_with("agent-session/session.jsonl"));
        assert!(stats["sessionId"].as_str().is_some_and(|s| !s.is_empty()));
        // The same numbers come back after reading the file again.
        drop(agent);
        let (again, _, _) = agent_with(vec![], 1);
        let again = again.with_resumed_session(dir.path(), "/w").unwrap();
        assert_eq!(again.stats()["tokens"], stats["tokens"]);
        assert_eq!(again.stats()["totalMessages"], stats["totalMessages"]);
    }

    #[tokio::test]
    async fn after_an_abort_the_session_file_ends_on_a_complete_record_and_resumes() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let mut agent = session_agent(
            vec![
                calls(json!([call("w1", "wait", json!({}))]), "toolUse"),
                say("never"),
            ],
            dir.path(),
            false,
        )
        .unwrap();
        let cancel = agent.cancel.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            cancel.store(true, Ordering::SeqCst);
        });
        let events = run(&mut agent, "go").await;
        stopper.await.unwrap();
        let order = types(&events);
        assert_eq!(
            &order[order.len() - 3..],
            ["turn_end", "agent_end", "agent_settled"]
        );
        let text = std::fs::read_to_string(dir.path().join("agent-session/session.jsonl")).unwrap();
        assert!(text.ends_with('\n'), "the file ends on a whole line");
        assert!(text
            .lines()
            .all(|l| serde_json::from_str::<Value>(l).is_ok()));
        let last = file_lines(dir.path()).pop().unwrap();
        assert_eq!(
            last["message"]["role"], "toolResult",
            "the aborted tool's result is the last record"
        );
        assert_eq!(last["message"]["isError"], true);
        drop(agent);
        let mut next = session_agent(vec![say("fine")], dir.path(), true).unwrap();
        run(&mut next, "again").await;
        assert_eq!(next.last_assistant_text().as_deref(), Some("fine"));
    }

    #[tokio::test]
    async fn nothing_secret_is_written_to_the_session() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let mut agent = session_agent(vec![say("plain")], dir.path(), false).unwrap();
        run(&mut agent, "hello").await;
        let text = std::fs::read_to_string(dir.path().join("agent-session/session.jsonl")).unwrap();
        for word in ["authorization", "x-api-key", "bearer", "apiKey", "api_key"] {
            assert!(
                !text.to_lowercase().contains(&word.to_lowercase()),
                "{word}"
            );
        }
    }

    #[tokio::test]
    async fn a_session_write_failure_stops_after_the_turn_with_the_reason_and_no_further_request() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let (agent, log, seen) = agent_with(
            vec![
                calls(
                    json!([
                        call("e1", "echo", json!({"text": "a"})),
                        call("e2", "echo", json!({"text": "b"}))
                    ]),
                    "toolUse",
                ),
                say("never"),
            ],
            1,
        );
        let mut agent = agent.with_new_session(dir.path(), "/w").unwrap();
        agent.session.as_mut().unwrap().poison();
        let events = run(&mut agent, "go").await;
        assert_eq!(
            *log.lock().unwrap(),
            ["echo", "echo"],
            "the running turn's tools were not interrupted"
        );
        assert_eq!(seen.load(Ordering::SeqCst), 1, "no second model request");
        let order = types(&events);
        assert_eq!(
            &order[order.len() - 3..],
            ["turn_end", "agent_end", "agent_settled"]
        );
        assert!(!order.iter().any(|t| t == "auto_retry_start"));
        let end = events.iter().rfind(|e| e["type"] == "agent_end").unwrap();
        assert_eq!(end["willRetry"], false);
        assert!(end["error"]
            .as_str()
            .unwrap()
            .starts_with("session record could not be written"));
        assert!(agent.session_error().is_some());
    }

    #[tokio::test]
    async fn a_run_without_a_write_failure_has_no_error_on_agent_end() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let mut agent = session_agent(vec![say("ok")], dir.path(), false).unwrap();
        let events = run(&mut agent, "go").await;
        let end = events.iter().rfind(|e| e["type"] == "agent_end").unwrap();
        assert!(end.get("error").is_none());
    }
    // ---- auto checks (NEWSROOM_SPEED_AUTO_CHECKS) ----

    type Scripted = (Vec<Value>, Option<Value>, bool);

    /// A tool runner for the auto checks: answers by name, exposes a fixed set, and can hang, refuse or raise the cancel flag.
    struct Auto {
        results: BTreeMap<&'static str, Scripted>,
        exposed: Vec<&'static str>,
        log: Arc<Mutex<Vec<(String, Value)>>>,
        hang: Option<&'static str>,
        refuse: Option<&'static str>,
        cancel_after: Option<(&'static str, Arc<AtomicBool>)>,
    }

    #[async_trait]
    impl ToolRunner for Auto {
        async fn run(
            &mut self,
            name: &str,
            args: &Value,
            cancel: &AtomicBool,
            _progress: &mut Vec<Value>,
        ) -> Result<CallOutcome> {
            self.log
                .lock()
                .unwrap()
                .push((name.to_string(), args.clone()));
            if self.hang == Some(name) {
                while !cancel.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
            if self.refuse == Some(name) {
                return Ok(CallOutcome::Error {
                    kind: "staging".into(),
                    message: "staging refused a file the step wrote".into(),
                });
            }
            if let Some((after, flag)) = &self.cancel_after {
                if *after == name {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            let (content, details, is_error) = self.results[name].clone();
            Ok(CallOutcome::Result {
                content,
                details,
                is_error,
            })
        }

        fn exposes(&self, name: &str) -> bool {
            self.exposed.contains(&name)
        }
    }

    fn txt(t: &str) -> Vec<Value> {
        vec![json!({"type": "text", "text": t})]
    }

    const VIZ_TOOLS: [&str; 4] = [
        "newsroom_viz_plan",
        "newsroom_viz_lint",
        "newsroom_viz_render",
        "newsroom_viz_critic",
    ];
    const PAGE_TOOLS: [&str; 5] = [
        "newsroom_infographic_plan",
        "newsroom_infographic_lint",
        "newsroom_infographic_render",
        "newsroom_infographic_critic",
        "newsroom_infographic_preview",
    ];

    fn viz_results() -> BTreeMap<&'static str, Scripted> {
        BTreeMap::from([
            (
                "newsroom_viz_plan",
                (
                    txt("plan text "),
                    Some(
                        json!({"planRef": "plans/p.json", "chartType": "bar", "verificationMode": "verified", "publishable": true}),
                    ),
                    false,
                ),
            ),
            (
                "newsroom_viz_lint",
                (
                    txt("lint warning: w1\nNext: render"),
                    Some(
                        json!({"passed": true, "lintRef": "lints/l.json", "computationRef": "computations/c.json"}),
                    ),
                    false,
                ),
            ),
            (
                "newsroom_viz_render",
                (
                    txt("rendered"),
                    Some(
                        json!({"renderQaPassed": true, "manifestRef": "manifests/m.json", "publishable": true}),
                    ),
                    false,
                ),
            ),
            (
                "newsroom_viz_critic",
                (
                    txt("critic issues: none\nscore 91\nNext: record"),
                    Some(json!({"passed": true, "score": 91})),
                    false,
                ),
            ),
        ])
    }

    fn page_results(image: Option<Value>) -> BTreeMap<&'static str, Scripted> {
        let mut preview = txt("preview made");
        if let Some(image) = image {
            preview.push(image);
        }
        BTreeMap::from([
            (
                "newsroom_infographic_plan",
                (
                    txt("page plan "),
                    Some(json!({"planRef": "plans/i.json", "modules": 4})),
                    false,
                ),
            ),
            (
                "newsroom_infographic_lint",
                (
                    txt("page lint"),
                    Some(json!({"passed": true, "lintRef": "lints/i.json"})),
                    false,
                ),
            ),
            (
                "newsroom_infographic_render",
                (
                    txt("page render"),
                    Some(json!({"renderQaPassed": true, "manifestRef": "manifests/i.json"})),
                    false,
                ),
            ),
            (
                "newsroom_infographic_critic",
                (
                    txt("page critic"),
                    Some(json!({"passed": true, "score": 80, "criticRef": "critics/i.json"})),
                    false,
                ),
            ),
            (
                "newsroom_infographic_preview",
                (
                    preview,
                    Some(json!({"previewRef": "previews/i.png"})),
                    false,
                ),
            ),
        ])
    }

    struct AutoSetup {
        tools: Vec<&'static str>,
        results: BTreeMap<&'static str, Scripted>,
        on: bool,
        images: bool,
    }

    fn auto_agent(
        turns: Vec<Value>,
        setup: AutoSetup,
        tweak: impl FnOnce(&mut Auto),
    ) -> (Agent, Arc<Mutex<Vec<(String, Value)>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        let mut runner = Auto {
            results: setup.results,
            exposed: setup.tools,
            log: log.clone(),
            hang: None,
            refuse: None,
            cancel_after: None,
        };
        tweak(&mut runner);
        if let Some((_, flag)) = &mut runner.cancel_after {
            *flag = cancel.clone();
        }
        let mut agent = Agent::new(
            Box::new(ReplayModel::new(turns)),
            Box::new(runner),
            Config { retry_base_ms: 1 },
        )
        .with_auto_checks(setup.on, setup.images);
        agent.cancel = cancel;
        (agent, log)
    }

    fn viz_setup(on: bool) -> AutoSetup {
        AutoSetup {
            tools: VIZ_TOOLS.to_vec(),
            results: viz_results(),
            on,
            images: false,
        }
    }

    fn plan_turn(id: &str, tool: &str) -> Vec<Value> {
        vec![
            calls(json!([call(id, tool, json!({}))]), "toolUse"),
            say("done"),
        ]
    }

    fn tool_result_of<'a>(events: &'a [Value], id: &str) -> &'a Value {
        &events
            .iter()
            .find(|e| e["type"] == "message_end" && e["message"]["toolCallId"] == id)
            .unwrap()["message"]
    }

    fn all_text(message: &Value) -> String {
        message["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("")
    }

    fn logged(log: &Arc<Mutex<Vec<(String, Value)>>>) -> Vec<String> {
        log.lock().unwrap().iter().map(|(n, _)| n.clone()).collect()
    }

    #[tokio::test]
    async fn with_the_switch_off_a_plan_call_runs_alone_and_its_events_and_result_are_unchanged() {
        let (mut agent, log) = auto_agent(
            plan_turn("c1", "newsroom_viz_plan"),
            viz_setup(false),
            |_| {},
        );
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log), ["newsroom_viz_plan"]);
        assert_eq!(ends(&events).len(), 1);
        assert!(events.iter().all(|e| e.get("auto").is_none()));
        assert_eq!(all_text(tool_result_of(&events, "c1")), "plan text ");
    }

    #[tokio::test]
    async fn a_publishable_viz_plan_runs_lint_render_critic_with_ref_only_args_and_folds_the_text()
    {
        let (mut agent, log) = auto_agent(
            plan_turn("c1", "newsroom_viz_plan"),
            viz_setup(true),
            |_| {},
        );
        let events = run(&mut agent, "go").await;
        let seen = log.lock().unwrap().clone();
        assert_eq!(
            seen.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            VIZ_TOOLS
        );
        assert_eq!(seen[1].1, json!({"plan_ref": "plans/p.json"}));
        assert_eq!(
            seen[2].1,
            json!({"plan_ref": "plans/p.json", "lint_ref": "lints/l.json"})
        );
        assert_eq!(
            seen[3].1,
            json!({"plan_ref": "plans/p.json", "lint_ref": "lints/l.json", "manifest_ref": "manifests/m.json"})
        );
        // event order: the plan's end comes before the first auto start; ids and fields
        let shape: Vec<String> = events
            .iter()
            .filter(|e| {
                e["type"]
                    .as_str()
                    .is_some_and(|t| t.starts_with("tool_execution_"))
            })
            .map(|e| {
                format!(
                    "{} {}",
                    e["type"].as_str().unwrap(),
                    e["toolCallId"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(
            shape,
            [
                "tool_execution_start c1",
                "tool_execution_end c1",
                "tool_execution_start c1:auto:1",
                "tool_execution_end c1:auto:1",
                "tool_execution_start c1:auto:2",
                "tool_execution_end c1:auto:2",
                "tool_execution_start c1:auto:3",
                "tool_execution_end c1:auto:3",
            ]
        );
        for e in &events {
            if e["toolCallId"]
                .as_str()
                .is_some_and(|id| id.contains(":auto:"))
            {
                assert_eq!(e["auto"], true);
                assert_eq!(e["auto_parent_call_id"], "c1");
            }
        }
        // the plan's own end event holds its original result only
        let plan_end = ends(&events)[0];
        assert_eq!(plan_end["result"]["content"], json!(txt("plan text ")));
        // one toolResult for the one tool call, the plan text first and each step's text verbatim in order
        let message = tool_result_of(&events, "c1");
        let text = all_text(message);
        assert!(text.starts_with("plan text "));
        let order: Vec<usize> = [
            "newsroom_viz_lint PASS",
            "lint warning: w1\nNext: render",
            "newsroom_viz_render PASS",
            "newsroom_viz_critic PASS",
            "critic issues: none\nscore 91\nNext: record",
        ]
        .iter()
        .map(|needle| {
            text.find(needle)
                .unwrap_or_else(|| panic!("{needle} missing in {text}"))
        })
        .collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{order:?}");
        assert_eq!(
            events
                .iter()
                .filter(|e| e["type"] == "message_end" && e["message"]["role"] == "toolResult")
                .count(),
            1
        );
        assert_eq!(message["details"]["planRef"], "plans/p.json");
    }

    #[tokio::test]
    async fn only_the_known_event_types_appear_with_the_auto_checks_on() {
        let (mut agent, _) = auto_agent(
            plan_turn("c1", "newsroom_viz_plan"),
            viz_setup(true),
            |_| {},
        );
        let events = run(&mut agent, "go").await;
        let (mut off, _) = auto_agent(
            plan_turn("c1", "newsroom_viz_plan"),
            viz_setup(false),
            |_| {},
        );
        let off_events = run(&mut off, "go").await;
        let kinds = |list: &[Value]| -> std::collections::BTreeSet<String> {
            types(list).into_iter().collect()
        };
        assert_eq!(kinds(&events), kinds(&off_events));
    }

    #[tokio::test]
    async fn a_failing_lint_stops_the_sequence_and_the_plan_result_stays() {
        let mut setup = viz_setup(true);
        setup.results.insert(
            "newsroom_viz_lint",
            (
                txt("lint blocked: x"),
                Some(json!({"passed": false, "lintRef": "lints/l.json"})),
                false,
            ),
        );
        let (mut agent, log) = auto_agent(plan_turn("c1", "newsroom_viz_plan"), setup, |_| {});
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log), ["newsroom_viz_plan", "newsroom_viz_lint"]);
        let text = all_text(tool_result_of(&events, "c1"));
        assert!(text.starts_with("plan text "));
        assert!(text.contains("lint blocked: x"));
        assert!(text.ends_with("Stopped at newsroom_viz_lint"));
        assert!(!text.contains("PASS"));
        assert_eq!(tool_result_of(&events, "c1")["isError"], false);
    }

    #[tokio::test]
    async fn a_missing_field_is_a_stop_never_a_pass() {
        let mut setup = viz_setup(true);
        setup.results.insert(
            "newsroom_viz_render",
            (
                txt("render without manifest"),
                Some(json!({"renderQaPassed": true})),
                false,
            ),
        );
        let (mut agent, log) = auto_agent(plan_turn("c1", "newsroom_viz_plan"), setup, |_| {});
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log).len(), 3);
        assert!(all_text(tool_result_of(&events, "c1")).ends_with("Stopped at newsroom_viz_render"));
    }

    #[tokio::test]
    async fn a_draft_viz_plan_or_a_plan_without_a_ref_starts_nothing() {
        for details in [
            json!({"planRef": "plans/p.json", "publishable": false}),
            json!({"publishable": true}),
        ] {
            let mut setup = viz_setup(true);
            setup.results.insert(
                "newsroom_viz_plan",
                (txt("plan text "), Some(details), false),
            );
            let (mut agent, log) = auto_agent(plan_turn("c1", "newsroom_viz_plan"), setup, |_| {});
            let events = run(&mut agent, "go").await;
            assert_eq!(logged(&log), ["newsroom_viz_plan"]);
            assert!(events.iter().all(|e| e.get("auto").is_none()));
        }
        // a failed plan call starts nothing either
        let mut setup = viz_setup(true);
        let plan = setup.results["newsroom_viz_plan"].clone();
        setup
            .results
            .insert("newsroom_viz_plan", (plan.0, plan.1, true));
        let (mut agent, log) = auto_agent(plan_turn("c1", "newsroom_viz_plan"), setup, |_| {});
        run(&mut agent, "go").await;
        assert_eq!(logged(&log), ["newsroom_viz_plan"]);
    }

    #[tokio::test]
    async fn a_tool_the_run_does_not_expose_ends_the_sequence_silently() {
        let mut setup = viz_setup(true);
        setup.tools = vec!["newsroom_viz_plan", "newsroom_viz_lint"];
        let (mut agent, log) = auto_agent(plan_turn("c1", "newsroom_viz_plan"), setup, |_| {});
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log), ["newsroom_viz_plan", "newsroom_viz_lint"]);
        let text = all_text(tool_result_of(&events, "c1"));
        assert!(!text.contains("Stopped"));
        assert!(!text.contains("unknown"));
        assert!(!events.iter().any(|e| e["toolCallId"] == "c1:auto:2"));
        // nothing exposed: the plan alone, no auto events at all
        let mut none = viz_setup(true);
        none.tools = vec!["newsroom_viz_plan"];
        let (mut agent, log) = auto_agent(plan_turn("c1", "newsroom_viz_plan"), none, |_| {});
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log), ["newsroom_viz_plan"]);
        assert!(events.iter().all(|e| e.get("auto").is_none()));
    }

    #[tokio::test]
    async fn the_preview_runs_only_when_images_are_on_and_the_image_goes_through() {
        let image = json!({"type": "image", "mimeType": "image/png", "data": "AAAA"});
        let setup = |images| AutoSetup {
            tools: PAGE_TOOLS.to_vec(),
            results: page_results(Some(image.clone())),
            on: true,
            images,
        };
        let (mut agent, log) = auto_agent(
            plan_turn("c1", "newsroom_infographic_plan"),
            setup(false),
            |_| {},
        );
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log).len(), 4, "no preview with images off");
        assert!(!events
            .iter()
            .any(|e| e["toolName"] == "newsroom_infographic_preview"));
        assert!(!all_text(tool_result_of(&events, "c1")).contains("Preview image not sent"));

        let (mut agent, log) = auto_agent(
            plan_turn("c1", "newsroom_infographic_plan"),
            setup(true),
            |_| {},
        );
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log).len(), 5);
        let message = tool_result_of(&events, "c1");
        assert!(message["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["type"] == "image"));
        assert_eq!(
            log.lock().unwrap()[4].1,
            json!({"manifest_ref": "manifests/i.json", "critic_ref": "critics/i.json"})
        );
    }

    #[tokio::test]
    async fn an_image_the_wire_would_refuse_is_replaced_by_the_programs_own_line() {
        let big =
            json!({"type": "image", "mimeType": "image/png", "data": "A".repeat(5 * 1024 * 1024)});
        let setup = AutoSetup {
            tools: PAGE_TOOLS.to_vec(),
            results: page_results(Some(big)),
            on: true,
            images: true,
        };
        let (mut agent, _) =
            auto_agent(plan_turn("c1", "newsroom_infographic_plan"), setup, |_| {});
        let events = run(&mut agent, "go").await;
        let message = tool_result_of(&events, "c1");
        assert!(!message["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["type"] == "image"));
        assert!(all_text(message)
            .contains("Preview image not sent to the model: an image is larger than 3 MiB"));
    }

    #[tokio::test]
    async fn a_preview_without_an_image_block_stops_the_sequence() {
        let setup = AutoSetup {
            tools: PAGE_TOOLS.to_vec(),
            results: page_results(None),
            on: true,
            images: true,
        };
        let (mut agent, _) =
            auto_agent(plan_turn("c1", "newsroom_infographic_plan"), setup, |_| {});
        let events = run(&mut agent, "go").await;
        assert!(all_text(tool_result_of(&events, "c1"))
            .ends_with("Stopped at newsroom_infographic_preview"));
    }

    #[tokio::test]
    async fn a_step_past_the_time_limit_is_stopped_with_its_end_event_and_nothing_after_it() {
        let (agent, log) = auto_agent(plan_turn("c1", "newsroom_viz_plan"), viz_setup(true), |r| {
            r.hang = Some("newsroom_viz_lint");
        });
        let mut agent = agent.with_auto_timeout(Duration::from_millis(60));
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log), ["newsroom_viz_plan", "newsroom_viz_lint"]);
        let end = events
            .iter()
            .find(|e| e["type"] == "tool_execution_end" && e["toolCallId"] == "c1:auto:1")
            .unwrap();
        assert_eq!(end["isError"], true);
        let text = all_text(tool_result_of(&events, "c1"));
        assert!(text.contains("did not finish within"));
        assert!(text.ends_with("Stopped at newsroom_viz_lint"));
        assert!(text.starts_with("plan text "));
    }

    #[tokio::test]
    async fn a_step_that_errors_or_has_its_files_refused_stops_with_the_reason_and_keeps_the_plan()
    {
        let (mut agent, log) =
            auto_agent(plan_turn("c1", "newsroom_viz_plan"), viz_setup(true), |r| {
                r.refuse = Some("newsroom_viz_render");
            });
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log).len(), 3);
        let text = all_text(tool_result_of(&events, "c1"));
        assert!(text.contains("newsroom_viz_lint PASS"));
        assert!(text.contains("staging refused a file the step wrote"));
        assert!(text.ends_with("Stopped at newsroom_viz_render"));
        assert_eq!(tool_result_of(&events, "c1")["isError"], false);
    }

    #[tokio::test]
    async fn a_cancel_between_steps_starts_no_further_step_and_emits_nothing_for_it() {
        let (mut agent, log) =
            auto_agent(plan_turn("c1", "newsroom_viz_plan"), viz_setup(true), |r| {
                r.cancel_after = Some(("newsroom_viz_lint", Arc::new(AtomicBool::new(false))));
            });
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log), ["newsroom_viz_plan", "newsroom_viz_lint"]);
        let starts: Vec<&Value> = events
            .iter()
            .filter(|e| e["type"] == "tool_execution_start" && e["auto"] == true)
            .collect();
        assert_eq!(starts.len(), 1);
        let end_of_lint = events
            .iter()
            .find(|e| e["type"] == "tool_execution_end" && e["toolCallId"] == "c1:auto:1")
            .unwrap();
        assert!(
            end_of_lint.get("cancelled").is_none(),
            "the step finished; it was not cancelled"
        );
    }

    #[tokio::test]
    async fn a_model_call_of_a_check_tool_starts_no_sequence_and_each_plan_gets_its_own() {
        let (mut agent, log) = auto_agent(
            vec![
                calls(
                    json!([call("m1", "newsroom_viz_lint", json!({"plan_ref": "x"}))]),
                    "toolUse",
                ),
                say("done"),
            ],
            viz_setup(true),
            |_| {},
        );
        run(&mut agent, "go").await;
        assert_eq!(logged(&log), ["newsroom_viz_lint"]);

        let (mut agent, log) = auto_agent(
            vec![
                calls(
                    json!([
                        call("a", "newsroom_viz_plan", json!({})),
                        call("b", "newsroom_viz_plan", json!({}))
                    ]),
                    "toolUse",
                ),
                say("done"),
            ],
            viz_setup(true),
            |_| {},
        );
        let events = run(&mut agent, "go").await;
        assert_eq!(logged(&log).len(), 8);
        for id in ["a:auto:1", "a:auto:3", "b:auto:1", "b:auto:3"] {
            assert!(events.iter().any(|e| e["toolCallId"] == id), "{id}");
        }
        assert!(!events.iter().any(|e| e["toolCallId"]
            .as_str()
            .is_some_and(|i| i.matches(":auto:").count() > 1)));
    }
}
