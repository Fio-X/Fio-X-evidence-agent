use anyhow::{anyhow, bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write as StdWrite;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command as StdCommand;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// Opt-in turn-saving guidance (prompt text and tool guidelines). Set only
    /// by the non-v2 `investigate` command from the parent environment;
    /// every other caller leaves it at the default (all off).
    pub speed: crate::prompt::PromptSpeed,
    /// Set only by the non-v2 `investigate` command for a plain single-chart request when
    /// `NEWSROOM_SPEED_COMPOSE_ANSWER=1`: once the chart is complete and its claim system-verified,
    /// the CLI writes the closing text from the artifacts and ends the model loop there.
    pub compose: Option<crate::compose_answer::ComposeSpec>,
}

/// Parent-environment switches and the matching markers the runtime reads in
/// the Pi child. `PiConfig::command` always resets them from the config.
pub const PARALLEL_HINTS_ENV: &str = "NEWSROOM_SPEED_PARALLEL_HINTS";
pub const COMPUTE_BATCH_ENV: &str = "NEWSROOM_SPEED_COMPUTE_BATCH";
/// Parent switch the chains depend on; the runtime does not register a chain without it.
pub const ATOMIC_ARTIFACT_ENV: &str = "NEWSROOM_SPEED_ATOMIC_ARTIFACT";
pub const CHAIN_VIZ_ENV: &str = "NEWSROOM_SPEED_CHAIN_VIZ";
/// Runtime-only tool that exists when `CHAIN_VIZ_ENV` is on; not in the registry.
pub const VIZ_CHAIN_TOOL: &str = "newsroom_viz_chain";
pub const CHAIN_INFOGRAPHIC_ENV: &str = "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC";
/// Runtime-only tool that exists when `CHAIN_INFOGRAPHIC_ENV` is on; not in the registry.
pub const INFOGRAPHIC_CHAIN_TOOL: &str = "newsroom_infographic_chain";
/// Page-stage preflight and derived-reference fill; the runtime reads the same name.
pub const PREFLIGHT_ENV: &str = "NEWSROOM_SPEED_PREFLIGHT";
/// Layout-only plan edits without re-sending the plan; the runtime reads the same name.
pub const PLAN_EDIT_ENV: &str = "NEWSROOM_SPEED_PLAN_EDIT";
/// Chart claims filled and recorded by the runtime from the chart's own SQL rows.
/// Only exactly "1" counts, and only with the chart chain and atomic writes on;
/// the runtime reads the same name and applies the same conditions.
pub const INLINE_CLAIM_ENV: &str = "NEWSROOM_SPEED_INLINE_CLAIM";
/// Patch retry of a refused plan or page-chain call; each needs atomic writes, the chain one also the page chain.
pub const PLAN_PATCH_ENV: &str = "NEWSROOM_SPEED_PLAN_PATCH";
pub const CHAIN_PATCH_ENV: &str = "NEWSROOM_SPEED_CHAIN_PATCH";
/// Runtime-only switches: one combined plan/chain report, copied references, first-try rule text.
pub const REPORT_ALL_ENV: &str = "NEWSROOM_SPEED_REPORT_ALL";
pub const FILL_COPIED_REFS_ENV: &str = "NEWSROOM_SPEED_FILL_COPIED_REFS";
pub const FIRST_TRY_TEXT_ENV: &str = "NEWSROOM_SPEED_FIRST_TRY_TEXT";
/// Prompt-only: a program-measured profile of local CSV files; the Pi child never reads it.
pub const DATA_PROFILE_ENV: &str = "NEWSROOM_SPEED_DATA_PROFILE";
pub const RECIPES_ENV: &str = "NEWSROOM_SPEED_RECIPES";
/// Parent-only: the CLI composes a single chart's closing text; the Pi child never reads it.
pub const COMPOSE_ANSWER_ENV: &str = "NEWSROOM_SPEED_COMPOSE_ANSWER";
pub const PLAN_PROGRESS_ENV: &str = "NEWSROOM_SPEED_PLAN_PROGRESS";
/// Prompt-only: tells the model where number words and digits are refused; no check changes.
/// 1011y: off by default, only exactly "1" turns it on. On: the Pi child gets PI_OFFLINE=1, so Pi's own background model-catalog
/// refresh (its only self-started connection in rpc mode, built-in providers with credentials only) does not run. Off: nothing
/// is set or removed. Exit condition: merge into the default after an install-time check.
pub const PI_OFFLINE_ENV: &str = "NEWSROOM_PI_OFFLINE";
pub const NUMWORD_PROMPT_ENV: &str = "NEWSROOM_NUMWORD_PROMPT";
pub const LEAN_GATES_ENV: &str = "NEWSROOM_LEAN_GATES";
/// Runtime-only tools that exist when the patch switches are on; not in the registry.
pub const PLAN_PATCH_TOOL: &str = "newsroom_infographic_plan_patch";
pub const CHAIN_PATCH_TOOL: &str = "newsroom_infographic_chain_patch";
/// Runtime-only tool that exists when `PLAN_EDIT_ENV` is on; not in the registry.
pub const PLAN_EDIT_TOOL: &str = "newsroom_infographic_edit";
/// K284: `NEWSROOM_PAGE_OCR_CHECK`, exact "1" only, default off. On: the visual review side may call a runtime-only
/// read-back check that reads a rendered page with the macOS Vision framework and reports structural findings.
/// It is read-only, writes one report under publications/qa, and is not in the registry.
pub const PAGE_OCR_ENV: &str = "NEWSROOM_PAGE_OCR_CHECK";
pub const PAGE_OCR_TOOL: &str = "newsroom_page_ocr_check";
pub const LIEFLAT_TOOLS: [&str; 2] = ["newsroom_lieflat_catalog", "newsroom_lieflat_render"];

/// NEWSROOM_SPEED_COMPLETION_SAME_GAPS=1: a completion attempt that was not sent because nothing changed since the one before.
/// Its own event type, so the audit never counts it as a retry (`auto_retry_start` is what counts retries).
pub fn append_completion_skip_event(
    events_path: &Path,
    attempt: usize,
    gaps: &[String],
    reason: &str,
) -> Result<()> {
    let mut file = crate::group_guard::as_run_bundle(|| {
        crate::group_guard::open_append(events_path.parent().unwrap_or(Path::new("")), events_path)
    })
    .with_context(|| format!("failed to open event log: {}", events_path.display()))?;
    let event = json!({
        "type": "completion_retry_skipped",
        "reason": reason,
        "attempt": attempt,
        "gaps": gaps,
        "recordedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    });
    writeln!(file, "{}", serde_json::to_string(&event)?)?;
    Ok(())
}

#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// The runtime only accepts exactly "1" for these switches, so the prompt side must not accept more.
fn env_switch(name: &str) -> bool {
    std::env::var(name).ok().as_deref() == Some("1")
}

// The runtime only accepts exactly "1" for this switch.
fn atomic_artifact_on() -> bool {
    std::env::var(ATOMIC_ARTIFACT_ENV).ok().as_deref() == Some("1")
}

// The runtime only accepts exactly "1" for this switch.
fn inline_claim_on() -> bool {
    std::env::var(INLINE_CLAIM_ENV).ok().as_deref() == Some("1")
}

// The runtime only accepts exactly "1" for the five switches below.
fn exact_one(name: &str) -> bool {
    std::env::var(name).ok().as_deref() == Some("1")
}

/// The turn-saving switches the parent environment asks for.
pub fn speed_switches_from_env() -> crate::prompt::PromptSpeed {
    let chain_viz = env_switch(CHAIN_VIZ_ENV) && atomic_artifact_on();
    crate::prompt::PromptSpeed {
        // Plan progress is only useful when the first plan call rides with the first research calls.
        parallel_hints: env_switch(PARALLEL_HINTS_ENV) || exact_one(PLAN_PROGRESS_ENV),
        compute_batch: env_switch(COMPUTE_BATCH_ENV),
        chain_viz,
        chain_infographic: env_switch(CHAIN_INFOGRAPHIC_ENV) && atomic_artifact_on(),
        preflight: env_switch(PREFLIGHT_ENV),
        plan_edit: env_switch(PLAN_EDIT_ENV),
        inline_claim: inline_claim_on() && chain_viz,
        plan_patch: exact_one(PLAN_PATCH_ENV) && atomic_artifact_on(),
        chain_patch: exact_one(CHAIN_PATCH_ENV)
            && atomic_artifact_on()
            && exact_one(CHAIN_INFOGRAPHIC_ENV),
        report_all: exact_one(REPORT_ALL_ENV),
        fill_copied_refs: exact_one(FILL_COPIED_REFS_ENV),
        first_try_text: exact_one(FIRST_TRY_TEXT_ENV),
        data_profile: exact_one(DATA_PROFILE_ENV),
        recipes: exact_one(RECIPES_ENV),
        compose_answer: exact_one(COMPOSE_ANSWER_ENV),
        plan_progress: exact_one(PLAN_PROGRESS_ENV),
        numword_prompt: exact_one(NUMWORD_PROMPT_ENV),
        lean_gates: exact_one(LEAN_GATES_ENV),
    }
}

#[derive(Debug)]
pub struct PiRunResult {
    pub text: String,
    pub session_stats: Option<Value>,
}

/// The settled final assistant turn was a provider error. Nothing here is
/// provider text except `partial_text`, which is model output that already
/// passed secret redaction and was streamed to stdout.
#[derive(Debug)]
pub struct ProviderFailure {
    pub class: &'static str,
    pub http_status: Option<u16>,
    pub turn_index: u32,
    pub elapsed_ms: u128,
    pub partial_text: String,
}

/// One plain line for a conversation that has grown past what the model accepts; no compaction is attempted, the run folder is kept.
pub const CONTEXT_OVERFLOW_LINE: &str =
    "The conversation is longer than the model accepts; nothing was shortened, and the run folder is kept as it is.";

impl std::fmt::Display for ProviderFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The Pi path keeps its original sentence; only a run on the Rust agent path says "Model provider".
        let who = if crate::agent_loop::agent_rust_enabled() {
            "Model"
        } else {
            "Pi"
        };
        write!(
            f,
            "{who} provider failed after internal retries: {}",
            self.class
        )?;
        if let Some(status) = self.http_status {
            write!(f, " HTTP {status}")?;
        }
        write!(
            f,
            " (turn {}, {} ms elapsed, raw diagnostic suppressed)",
            self.turn_index, self.elapsed_ms
        )?;
        if self.class == "provider_context_overflow" {
            write!(f, ". {CONTEXT_OVERFLOW_LINE}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ProviderFailure {}

#[derive(Debug, Clone)]
struct TurnFailure {
    class: &'static str,
    status: Option<u16>,
    turn_index: u32,
    at_ms: u128,
    gap_ms: u128,
    turn_ms: Option<u128>,
    turn_events: u64,
    turn_bytes: u64,
    turn_first_event_ms: Option<u128>,
    context_tokens: Option<u64>,
}

/// Non-sensitive counters for one `run_prompt` call: counts, durations and
/// fixed class names only.
#[derive(Debug)]
struct RunTelemetry {
    events: u64,
    bytes: u64,
    first_event_ms: Option<u128>,
    turns: u32,
    turn_start_ms: Option<u128>,
    turn_events0: u64,
    turn_bytes0: u64,
    turn_first_event_ms: Option<u128>,
    last_ok_context_tokens: Option<u64>,
    failed_turns: u32,
    classes: Vec<&'static str>,
    auto_retries: u32,
    pending: Option<TurnFailure>,
    stage: &'static str,
}

impl RunTelemetry {
    fn new() -> Self {
        Self {
            events: 0,
            bytes: 0,
            first_event_ms: None,
            turns: 0,
            turn_start_ms: None,
            turn_events0: 0,
            turn_bytes0: 0,
            turn_first_event_ms: None,
            last_ok_context_tokens: None,
            failed_turns: 0,
            classes: Vec::new(),
            auto_retries: 0,
            pending: None,
            stage: "startup",
        }
    }

    fn note_event(&mut self, now_ms: u128, record_bytes: u64) {
        self.events += 1;
        self.bytes += record_bytes;
        self.first_event_ms.get_or_insert(now_ms);
    }

    fn turn_started(&mut self, now_ms: u128) {
        self.turns += 1;
        self.turn_start_ms = Some(now_ms);
        self.turn_events0 = self.events;
        self.turn_bytes0 = self.bytes;
        self.turn_first_event_ms = None;
    }

    fn stream_event(&mut self, now_ms: u128) {
        if self.turn_first_event_ms.is_none() {
            if let Some(start) = self.turn_start_ms {
                self.turn_first_event_ms = Some(now_ms.saturating_sub(start));
            }
        }
    }

    fn turn_failed(
        &mut self,
        (class, status): (&'static str, Option<u16>),
        now_ms: u128,
        gap_ms: u128,
        context_tokens: Option<u64>,
    ) {
        self.failed_turns += 1;
        if self.classes.len() < 16 {
            self.classes.push(class);
        }
        self.pending = Some(TurnFailure {
            class,
            status,
            turn_index: self.turns,
            at_ms: now_ms,
            gap_ms,
            turn_ms: self.turn_start_ms.map(|start| now_ms.saturating_sub(start)),
            turn_events: self.events.saturating_sub(self.turn_events0),
            turn_bytes: self.bytes.saturating_sub(self.turn_bytes0),
            turn_first_event_ms: self.turn_first_event_ms,
            context_tokens,
        });
    }

    fn turn_ok(&mut self, context_tokens: Option<u64>) {
        self.pending = None;
        if context_tokens.is_some() {
            self.last_ok_context_tokens = context_tokens;
        }
    }
}

/// Prompt-side tokens of one assistant message (input plus cache traffic).
fn message_context_tokens(message: Option<&Value>) -> Option<u64> {
    let usage = message?.get("usage")?;
    let part = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let total = part("input") + part("cacheRead") + part("cacheWrite");
    (total > 0).then_some(total)
}

/// stopReason of a finished assistant turn (`message_end` or `turn_end`).
fn finished_turn_stop_reason(event: &Value) -> Option<&str> {
    if !matches!(
        event.get("type").and_then(Value::as_str),
        Some("message_end" | "turn_end")
    ) {
        return None;
    }
    let message = event.get("message")?;
    if message
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|role| role != "assistant")
    {
        return None;
    }
    message.get("stopReason").and_then(Value::as_str)
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

/// Where the parent looks for the model's proxy: the same six names and order as the Rust client's own default (`llm/client.rs`).
const PROXY_ENV_NAMES: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
];

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

const VALID_NEWSROOM_PHASES: &[&str] = &[
    "core",
    "discover",
    "verify",
    "synthesize",
    "design",
    "publish",
    "verify_publication",
];

fn normalized_newsroom_phase() -> Option<String> {
    let raw = std::env::var("NEWSROOM_PHASE").ok()?;
    let value = raw.trim();
    if value.is_empty() || value == "all" {
        return Some(value.to_owned());
    }
    let phases: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|phase| !phase.is_empty())
        .collect();
    if !phases.is_empty()
        && phases
            .iter()
            .all(|phase| VALID_NEWSROOM_PHASES.contains(phase))
    {
        Some(phases.join(","))
    } else {
        Some("core".to_owned())
    }
}

/// First standalone HTTP status number (not glued to letters or digits, so ids
/// such as `req_01abc503x` or counts such as `2500` never match).
fn standalone_status(diagnostic: &str) -> Option<u16> {
    const KNOWN: [u16; 19] = [
        400, 401, 402, 403, 404, 408, 409, 413, 429, 500, 502, 503, 504, 520, 521, 522, 524, 525,
        529,
    ];
    let bytes = diagnostic.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_digit() {
            let begin = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            let glued = |position: Option<&u8>| {
                position.is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
            };
            if index - begin == 3
                && !glued(begin.checked_sub(1).and_then(|i| bytes.get(i)))
                && !glued(bytes.get(index))
            {
                if let Ok(value) = diagnostic[begin..index].parse::<u16>() {
                    if KNOWN.contains(&value) {
                        return Some(value);
                    }
                }
            }
        } else {
            index += 1;
        }
    }
    None
}

/// Redacted, actionable failure classes. The diagnostic is only inspected here
/// and never returned.
pub(crate) fn provider_error_class(event: &Value) -> (&'static str, Option<u16>) {
    let diagnostic = [
        event.get("error"),
        event.get("data"),
        event.get("errorMessage"),
        event.get("finalError"),
        event
            .get("message")
            .and_then(|message| message.get("errorMessage")),
        event
            .get("message")
            .and_then(|message| message.get("error")),
    ]
    .into_iter()
    .flatten()
    .map(|value| value.to_string())
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase();
    let status = standalone_status(&diagnostic);
    let has = |needles: &[&str]| needles.iter().any(|needle| diagnostic.contains(needle));
    let class = if matches!(status, Some(401 | 403))
        || has(&["authentication_error", "permission_error"])
    {
        "provider_authentication_failed"
    } else if status == Some(429) || has(&["rate_limit_error", "rate limit", "too many requests"]) {
        "provider_rate_limited"
    } else if status == Some(413)
        || has(&[
            "prompt is too long",
            "request_too_large",
            "request too large",
            "exceeds the context window",
            "maximum context length",
            "context_length_exceeded",
            "context length exceeded",
            "too many tokens",
            "input is too long",
            "payload too large",
            "request entity too large",
        ])
    {
        "provider_context_overflow"
    } else if status == Some(529) || has(&["overloaded"]) {
        "provider_overloaded"
    } else if matches!(status, Some(408 | 504 | 522 | 524))
        || has(&[
            "timeout_error",
            "timed out",
            "timeout",
            "etimedout",
            "deadline exceeded",
        ])
    {
        "provider_timeout"
    } else if matches!(status, Some(502 | 503 | 520 | 521 | 525))
        || has(&[
            "bad gateway",
            "service unavailable",
            "no available accounts",
            "<html",
        ])
    {
        "provider_gateway_error"
    } else if has(&[
        "terminated",
        "other side closed",
        "stream ended",
        "fetch failed",
        "socket hang up",
        "econnreset",
        "connection reset",
        "connection closed",
        "premature close",
        "unexpected eof",
        "network error",
        "connection error",
    ]) {
        "provider_stream_interrupted"
    } else if status == Some(500) || has(&["api_error"]) {
        "provider_unavailable"
    } else if matches!(status, Some(400 | 402 | 404 | 409))
        || has(&[
            "invalid_request_error",
            "billing_error",
            "not_found_error",
            "conflict_error",
        ])
    {
        "provider_request_rejected"
    } else {
        "provider_error"
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

/// The tools a finished `newsroom_viz_chain` call lists, in order.
const VIZ_CHAIN_STEPS: [&str; 4] = [
    "newsroom_viz_plan",
    "newsroom_viz_lint",
    "newsroom_viz_render",
    "newsroom_viz_critic",
];

/// A rendered chart's files as announced once its critic passed. Every ref is
/// an artifact-relative path inside `visualizations/`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReadyChart {
    desktop: String,
    compact: Option<String>,
    mobile: Option<String>,
    manifest: String,
}

impl ReadyChart {
    /// Reads a render step's typed details. Every ref that is present must stay
    /// inside `visualizations/`; one that does not leaves the chart unannounced.
    fn from_render_details(details: &Value) -> Option<Self> {
        let text = |key: &str| details.get(key).and_then(Value::as_str);
        let optional = |key: &str| match details.get(key) {
            None | Some(Value::Null) => Some(None),
            Some(Value::String(path)) if is_visualization_ref(path) => Some(Some(path.clone())),
            Some(_) => None,
        };
        let (desktop, manifest) = (text("desktopSvgRef")?, text("manifestRef")?);
        if !is_visualization_ref(desktop) || !is_visualization_ref(manifest) {
            return None;
        }
        Some(Self {
            desktop: desktop.to_string(),
            compact: optional("compactSvgRef")?,
            mobile: optional("mobileSvgRef")?,
            manifest: manifest.to_string(),
        })
    }
}

const PLAN_PROGRESS_FILE: &str = "plan-progress.json";

/// One `plan-progress.json` line per finished tool call, copied from that tool event's own id,
/// name and error flag. It is a record of what ran, not a plan: `plan.json` and the audit's
/// plan-call count are untouched, and an event without a call id yields no line.
fn plan_progress_entry(event: &Value, seq: u64) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("tool_execution_end") {
        return None;
    }
    let call_id = event.get("toolCallId").and_then(Value::as_str)?;
    let tool = event.get("toolName").and_then(Value::as_str)?;
    let is_error = event.get("isError").and_then(Value::as_bool);
    Some(json!({
        "seq": seq,
        "tool_call_id": call_id,
        "tool": tool,
        "is_error": is_error,
        // A missing isError is unknown, never completed.
        "status": match is_error {
            Some(true) => "failed",
            Some(false) => "completed",
            None => "unknown",
        },
        "source": "tool_execution_end",
        "recorded_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }))
}

/// Tracks rendered charts whose deterministic critic passed, so the first one
/// can be announced before the model finishes the rest of the run. The notice
/// is progress output only: it grants no verification, completion or
/// publication status, never ends the Pi session and changes no completion
/// check. Only a run with the inline-claim switch on watches.
#[derive(Default)]
struct ChartReadyWatch {
    renders: HashMap<String, ReadyChart>,
    critic_manifests: HashMap<String, String>,
    announced: bool,
}

impl ChartReadyWatch {
    /// Returns the chart's files the first time a critic passes for a rendered
    /// chart: a `newsroom_viz_chain` that completed with a passing critic, or a
    /// separately called `newsroom_viz_critic` for a manifest that an earlier
    /// `newsroom_viz_render` call produced.
    fn observe(&mut self, event: &Value) -> Option<ReadyChart> {
        let tool = event.get("toolName").and_then(Value::as_str)?;
        let call_id = event.get("toolCallId").and_then(Value::as_str)?;
        match event.get("type").and_then(Value::as_str)? {
            "tool_execution_start" if tool == "newsroom_viz_critic" => {
                let manifest = event.get("args")?.get("manifest_ref")?.as_str()?;
                self.critic_manifests
                    .insert(call_id.to_string(), manifest.to_string());
                None
            }
            "tool_execution_end" => {
                let manifest = self.critic_manifests.remove(call_id);
                if event.get("isError").and_then(Value::as_bool) != Some(false) {
                    return None;
                }
                let details = event.get("result")?.get("details")?;
                match tool {
                    "newsroom_viz_render" => {
                        let chart = ReadyChart::from_render_details(details)?;
                        self.renders.insert(chart.manifest.clone(), chart);
                        None
                    }
                    "newsroom_viz_critic" if !self.announced => {
                        if details.get("passed").and_then(Value::as_bool) != Some(true) {
                            return None;
                        }
                        let chart = self.renders.get(&manifest?)?.clone();
                        self.announced = true;
                        Some(chart)
                    }
                    VIZ_CHAIN_TOOL if !self.announced => {
                        let chart = Self::finished_chain_chart(details)?;
                        self.announced = true;
                        Some(chart)
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// The chart a finished chain call rendered, when all four steps ran, the
    /// chain completed and its critic passed on the manifest that render wrote.
    /// Read only from the call's own result: anything missing or inconsistent
    /// yields nothing.
    fn finished_chain_chart(details: &Value) -> Option<ReadyChart> {
        if details.get("chain").and_then(Value::as_str) != Some(VIZ_CHAIN_TOOL)
            || details.get("chainStatus").and_then(Value::as_str) != Some("COMPLETE")
        {
            return None;
        }
        let steps = details.get("steps")?.as_array()?;
        let [plan, lint, render, critic] = steps.as_slice() else {
            return None;
        };
        if ![plan, lint, render, critic]
            .iter()
            .zip(VIZ_CHAIN_STEPS)
            .all(|(step, name)| step.get("tool").and_then(Value::as_str) == Some(name))
        {
            return None;
        }
        if critic.pointer("/details/passed").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        let chart = ReadyChart::from_render_details(render.get("details")?)?;
        (critic
            .pointer("/params/manifest_ref")
            .and_then(Value::as_str)
            == Some(chart.manifest.as_str()))
        .then_some(chart)
    }
}

/// An artifact-relative path that stays inside `visualizations/`: no absolute
/// part, no `..`, no control character that could forge a log line.
fn is_visualization_ref(path: &str) -> bool {
    path.starts_with("visualizations/")
        && !path.ends_with('/')
        && !path.chars().any(char::is_control)
        && Path::new(path)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
}

/// The one-line first-chart notice. It names files and states only that a
/// critic passed; it never says verified, publishable or complete.
fn chart_ready_line(elapsed_ms: u128, root: &Path, chart: &ReadyChart) -> String {
    let mut line = format!(
        "[agent] chart_ready elapsed_ms={elapsed_ms} desktop={}",
        root.join(&chart.desktop).display()
    );
    for (label, path) in [("compact", &chart.compact), ("mobile", &chart.mobile)] {
        if let Some(path) = path {
            line.push_str(&format!(" {label}={}", root.join(path).display()));
        }
    }
    line.push_str(" (critic passed; progress only, the run continues)");
    line
}

/// Set once the first-chart notice was printed. A recovery or repair prompt
/// starts a new watch and a new clock; the first chart stays the only one named.
static CHART_NOTICE_SENT: AtomicBool = AtomicBool::new(false);

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

fn provider_failure_event(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("extension_error")
        || (event.get("type").and_then(Value::as_str) == Some("response")
            && event.get("success").and_then(Value::as_bool) == Some(false))
        || assistant_provider_turn_failed(event)
}

fn sanitize_provider_event(event: &mut Value, secrets: &[String]) -> Result<()> {
    let classification = provider_failure_event(event).then(|| provider_error_class(event));
    redact_event(event, secrets);
    if let Some((error_class, http_status)) = classification {
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
    Ok(())
}

impl PiConfig {
    fn effective_tool_profile(&self) -> &str {
        if tools_for_profile(&self.tool_profile).is_some() {
            self.tool_profile.as_str()
        } else {
            DEFAULT_TOOL_PROFILE
        }
    }

    /// The Lieflat fallback tools are never offered in a `visual-story` run.
    fn lieflat_hidden(&self) -> bool {
        self.effective_tool_profile() == "visual-story"
    }

    /// Comma-separated tool allowlist handed to Pi via `--tools`.
    pub fn tools_arg(&self) -> String {
        let tools = tools_for_profile(self.effective_tool_profile())
            .expect("effective tool profile must exist");
        let mut names: Vec<&str> = tools.split(',').collect();
        if self.lieflat_hidden() {
            names.retain(|name| !LIEFLAT_TOOLS.contains(name));
        }
        // The chain wraps newsroom_viz_plan, so it is offered only where that tool is.
        if self.speed.chain_viz && names.contains(&"newsroom_viz_plan") {
            names.push(VIZ_CHAIN_TOOL);
        }
        if self.speed.chain_infographic && names.contains(&"newsroom_infographic_plan") {
            names.push(INFOGRAPHIC_CHAIN_TOOL);
        }
        // The edit rewrites a page plan through the plan tool, so it is offered only where that is.
        if self.speed.plan_edit && names.contains(&"newsroom_infographic_plan") {
            names.push(PLAN_EDIT_TOOL);
        }
        // Each patch tool re-runs the tool it wraps, so it is offered only where that tool is.
        if self.speed.plan_patch && names.contains(&"newsroom_infographic_plan") {
            names.push(PLAN_PATCH_TOOL);
        }
        if self.speed.chain_patch && names.contains(&INFOGRAPHIC_CHAIN_TOOL) {
            names.push(CHAIN_PATCH_TOOL);
        }
        // The read-back reads what the page QA reads, so it is offered only where the QA tool is.
        if env_switch(PAGE_OCR_ENV) && names.contains(&"newsroom_publication_qa") {
            names.push(PAGE_OCR_TOOL);
        }
        names.join(",")
    }

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
        // NEWSROOM_AGENT=rust (exactly): the child is this program in its Rust agent mode, speaking the same protocol (1011ak 9a).
        let rust = crate::agent_loop::agent_rust_enabled();
        let mut cmd = if rust {
            Command::new(std::env::current_exe().unwrap_or_else(|_| self.binary.clone()))
        } else {
            Command::new(&self.binary)
        };
        if rust {
            cmd.arg(crate::agent_serve::SERVE_ARG);
        } else {
            cmd.arg("--mode").arg("rpc");
        }

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
            if let Some(api_key) = self
                .api_key
                .as_deref()
                .filter(|value| !value.is_empty() && !rust)
            {
                let key_name = match provider.as_str() {
                    "anthropic" => "ANTHROPIC_API_KEY",
                    "openai" => "OPENAI_API_KEY",
                    "dragoncode" => "DRAGONCODE_API_KEY",
                    _ => "NEWSROOM_API_KEY",
                };
                cmd.env(key_name, api_key);
            }
            if let Some(base_url) = self
                .base_url
                .as_deref()
                .filter(|value| !value.is_empty() && !rust)
            {
                let base_name = match provider.as_str() {
                    "anthropic" => "ANTHROPIC_BASE_URL",
                    "openai" => "OPENAI_BASE_URL",
                    "dragoncode" => "DRAGONCODE_BASE_URL",
                    _ => "NEWSROOM_BASE_URL",
                };
                cmd.env(base_name, base_url);
            }
            if provider == "dragoncode" && !rust && std::env::var("DRAGONCODE_API_KEY").is_err() {
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
                .arg(self.tools_arg());
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
        if self.speed.parallel_hints {
            cmd.env(PARALLEL_HINTS_ENV, "1");
        } else {
            cmd.env_remove(PARALLEL_HINTS_ENV);
        }
        if self.speed.plan_progress {
            cmd.env(PLAN_PROGRESS_ENV, "1");
        } else {
            cmd.env_remove(PLAN_PROGRESS_ENV);
        }
        if self.speed.compute_batch {
            cmd.env(COMPUTE_BATCH_ENV, "1");
        } else {
            cmd.env_remove(COMPUTE_BATCH_ENV);
        }
        if self.speed.chain_viz {
            cmd.env(CHAIN_VIZ_ENV, "1");
        } else {
            cmd.env_remove(CHAIN_VIZ_ENV);
        }
        if self.speed.chain_infographic {
            cmd.env(CHAIN_INFOGRAPHIC_ENV, "1");
        } else {
            cmd.env_remove(CHAIN_INFOGRAPHIC_ENV);
        }
        if self.speed.preflight {
            cmd.env(PREFLIGHT_ENV, "1");
        } else {
            cmd.env_remove(PREFLIGHT_ENV);
        }
        if self.speed.plan_edit {
            cmd.env(PLAN_EDIT_ENV, "1");
        } else {
            cmd.env_remove(PLAN_EDIT_ENV);
        }
        if self.speed.inline_claim {
            cmd.env(INLINE_CLAIM_ENV, "1");
        } else {
            cmd.env_remove(INLINE_CLAIM_ENV);
        }
        for (on, name) in [
            (self.speed.plan_patch, PLAN_PATCH_ENV),
            (self.speed.chain_patch, CHAIN_PATCH_ENV),
            (self.speed.report_all, REPORT_ALL_ENV),
            (self.speed.fill_copied_refs, FILL_COPIED_REFS_ENV),
            (self.speed.first_try_text, FIRST_TRY_TEXT_ENV),
        ] {
            if on {
                cmd.env(name, "1");
            } else {
                cmd.env_remove(name);
            }
        }
        if let Some(phase) = normalized_newsroom_phase() {
            cmd.env("NEWSROOM_PHASE", phase);
        }

        // Keep the wrapper reproducible and avoid Pi's startup version check / telemetry.
        // Model-provider and explicitly invoked newsroom network tools remain available.
        cmd.env("PI_SKIP_VERSION_CHECK", "1");
        cmd.env("PI_TELEMETRY", "0");
        if exact_one(PI_OFFLINE_ENV) {
            cmd.env("PI_OFFLINE", "1");
        }

        if rust && crate::agent_serve::real_enabled() {
            // gate A: the key, the address and the proxy for the model go to the child as its first protocol line, never through its arguments or
            // environment. The child inherits by allow list (the tool host's own list): any other name is removed, key-like or not. The proxy names
            // stay, so the tool host gets the same proxy environment as under the Pi path; the model client ignores them and uses the handed route.
            let set_here: Vec<std::ffi::OsString> = cmd
                .as_std()
                .get_envs()
                .filter(|(_, v)| v.is_some())
                .map(|(k, _)| k.to_os_string())
                .collect();
            for (name, _) in std::env::vars_os() {
                if set_here.contains(&name) {
                    continue;
                }
                let keep = name.to_str().is_some_and(|n| {
                    !crate::tool_host::whitelisted_env([(n.to_string(), String::new())]).is_empty()
                });
                if !keep {
                    cmd.env_remove(&name);
                }
            }
        }
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
        // the Rust child is not a node process, so it is not handed NODE_OPTIONS back; NB the node tool host's own fetch does need --use-env-proxy to honour the proxy names (see tool_host.rs spawn)
        if proxy_available.is_some() && !(rust && crate::agent_serve::real_enabled()) {
            let node_options =
                append_node_option(std::env::var("NODE_OPTIONS").ok(), "--use-env-proxy");
            cmd.env("NODE_OPTIONS", node_options);
        }
        cmd
    }

    /// Gate A: what the real-model child gets as its first protocol line. `None` unless `NEWSROOM_AGENT=rust` and `NEWSROOM_AGENT_REAL=1`.
    /// The error text never contains a key or a proxy.
    pub fn model_handoff(&self) -> Result<Option<crate::agent_serve::Handoff>> {
        if !(crate::agent_loop::agent_rust_enabled() && crate::agent_serve::real_enabled()) {
            return Ok(None);
        }
        self.resolve_handoff(|name| std::env::var(name).ok(), configured_system_proxy)
            .map(Some)
    }

    fn resolve_handoff(
        &self,
        env: impl Fn(&str) -> Option<String>,
        system_proxy: impl FnOnce() -> Option<String>,
    ) -> Result<crate::agent_serve::Handoff> {
        let present = |name: &str| env(name).filter(|v| !v.trim().is_empty());
        let provider = self
            .effective_provider()
            .unwrap_or_else(|| "anthropic".to_string());
        if !matches!(provider.as_str(), "anthropic" | "dragoncode") {
            bail!("the Rust agent speaks only the Anthropic Messages route (provider anthropic or dragoncode), not {provider}");
        }
        let api_key = self
            .api_key
            .clone()
            .filter(|v| !v.is_empty())
            .or_else(|| match provider.as_str() {
                "dragoncode" => present("DRAGONCODE_API_KEY").or_else(|| present("OPENAI_API_KEY")),
                _ => present("ANTHROPIC_API_KEY"),
            })
            .or_else(|| present("NEWSROOM_API_KEY"))
            .context("no model key was found for the Rust agent (nothing was started)")?;
        let base_url = self
            .base_url
            .clone()
            .filter(|v| !v.is_empty())
            .or_else(|| match provider.as_str() {
                "dragoncode" => present("DRAGONCODE_BASE_URL")
                    .or_else(|| present("OPENAI_BASE_URL"))
                    .or_else(|| Some("https://dragoncode.codes".to_string())),
                _ => present("ANTHROPIC_BASE_URL")
                    .or_else(|| Some("https://api.anthropic.com".to_string())),
            })
            .context("no model address was found for the Rust agent")?;
        let proxy = if crate::anthropic_model::is_loopback(&base_url) {
            None
        } else {
            PROXY_ENV_NAMES
                .iter()
                .find_map(|name| present(name))
                .or_else(system_proxy)
        };
        let handoff = crate::agent_serve::Handoff::parse(
            &crate::agent_serve::Handoff::new(&base_url, proxy.as_deref(), &api_key).message(),
        )?;
        Ok(handoff)
    }

    /// The progress line's runtime description. With `NEWSROOM_AGENT=rust` it says `rust-agent` (what actually runs); otherwise the Pi line, byte for byte as before.
    pub fn display_runtime(&self) -> String {
        self.display_runtime_for(crate::agent_loop::agent_rust_enabled())
    }

    fn display_runtime_for(&self, rust: bool) -> String {
        let (runtime, unset) = if rust {
            ("rust-agent", "<default>")
        } else {
            ("pi-rpc", "<pi-default>")
        };
        let provider = self
            .effective_provider()
            .unwrap_or_else(|| unset.to_string());
        let model = self.model.as_deref().unwrap_or(unset);
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
        format!("{runtime} provider={provider} model={model} session={session} tools={profile}")
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
                if matches!(key.as_str(), "error" | "errorMessage" | "finalError") {
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
    if crate::agent_loop::agent_rust_enabled() {
        crate::agent_serve::local_url()?;
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
    let mut telemetry = RunTelemetry::new();
    if !crate::step_lines::enabled() {
        eprintln!("[agent] phase=startup elapsed_ms=0");
    }
    // gate A: resolved before anything starts, so a missing key stops the run with nothing spawned
    let handoff = config.model_handoff()?;
    let mut secrets = secrets;
    if let Some(handoff) = &handoff {
        if let Some(wire) = handoff.message()["api_key"].as_str() {
            secrets.push(wire.to_string());
        }
        if let Some(proxy) = handoff.message()["proxy"].as_str() {
            secrets.extend(crate::llm::proxy_secrets(proxy));
        }
    }
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
                crate::group_guard::as_run_bundle(|| {
                    crate::group_guard::open_append(path.parent().unwrap_or(Path::new("")), path)
                })
                .with_context(|| format!("failed to open event log: {}", path.display()))?,
            ),
            None => None,
        };

        if let Some(handoff) = &handoff {
            send_json(&mut stdin, &handoff.message(), startup).await?;
        }
        send_json(
            &mut stdin,
            &json!({
                "id": "news-prompt",
                "type": "prompt",
                "message": prompt
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
        // Only a run with chart claims filled from rows names its first chart early.
        let mut chart_watch =
            (config.speed.inline_claim || config.compose.is_some()).then(ChartReadyWatch::default);
        // NEWSROOM_STEP_LINES=1: one named line per finished tool call (stderr only; changes no state).
        let mut step_tracker =
            crate::step_lines::enabled().then(crate::step_lines::StepTracker::default);
        // The closing text composed from the artifacts when the one chart is complete; once
        // set, the next model turn is aborted and no later model text is used or shown.
        let mut composed_answer: Option<String> = None;
        let mut compose_abort_sent = false;
        let mut plan_progress_seq = 0u64;
        // NEWSROOM_REPEAT_FAILURE_STOP=1: the same tool failing 5 times in a row with equal arguments ends the run.
        let mut repeat_watch = crate::repeat_failure::enabled()
            .then(crate::repeat_failure::RepeatFailureWatch::default);

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
                        if !crate::step_lines::enabled() {
                            eprintln!("[agent] phase={phase} elapsed_ms={}", started.elapsed().as_millis());
                        }
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
            let record_bytes = line.len() as u64;
            line.clear();
            let gap_ms = last_activity.elapsed().as_millis();
            last_activity = Instant::now();
            let now_ms = started.elapsed().as_millis();
            telemetry.note_event(now_ms, record_bytes);

            let mut event = event;
            // Classify turn failures from the raw event; only the class is kept.
            let turn_stop = finished_turn_stop_reason(&event).map(str::to_owned);
            let turn_class =
                (turn_stop.as_deref() == Some("error")).then(|| provider_error_class(&event));
            let turn_tokens = message_context_tokens(event.get("message"));
            // Classify provider failures before redaction, then retain only the safe class/status.
            sanitize_provider_event(&mut event, &secrets)?;
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
            // Step lines come first so the chart-out line sits right above `[agent] chart_ready`.
            if let Some(tracker) = step_tracker.as_mut() {
                match event.get("type").and_then(Value::as_str) {
                    Some("tool_execution_start") => {
                        tracker.on_start(&event, crate::step_lines::secs_now())
                    }
                    Some("tool_execution_end") => {
                        for line in tracker.on_end(
                            &event,
                            crate::step_lines::secs_now(),
                            crate::step_lines::language_zh(),
                        ) {
                            eprintln!("{line}");
                        }
                    }
                    _ => {}
                }
            }
            if let Some(watch) = repeat_watch.as_mut() {
                match event.get("type").and_then(Value::as_str) {
                    Some("tool_execution_start") => watch.on_start(&event),
                    Some("tool_execution_end") => {
                        if let Some(stop) = watch.on_end(&event) {
                            bail!("{stop}");
                        }
                    }
                    _ => {}
                }
            }
            // Routine plan progress comes from real tool events only, never from model text.
            if config.speed.plan_progress {
                if let (Some(root), Some(entry)) = (
                    config.artifact_dir.as_deref(),
                    plan_progress_entry(&event, plan_progress_seq + 1),
                ) {
                    plan_progress_seq += 1;
                    if let Ok(mut file) =
                        crate::group_guard::open_append(root, &root.join(PLAN_PROGRESS_FILE))
                    {
                        let _ = writeln!(file, "{entry}");
                    }
                }
            }
            // Progress only: the notice changes no state, status or completion check.
            if let Some(chart) = chart_watch.as_mut().and_then(|watch| watch.observe(&event)) {
                let root = config.artifact_dir.as_deref().unwrap_or(Path::new(""));
                if config.speed.inline_claim && !CHART_NOTICE_SENT.swap(true, Ordering::Relaxed) {
                    eprintln!(
                        "{}",
                        chart_ready_line(started.elapsed().as_millis(), root, &chart)
                    );
                }
                if let Some(spec) = config
                    .compose
                    .as_ref()
                    .filter(|_| composed_answer.is_none())
                {
                    let files = crate::compose_answer::ChartFiles {
                        desktop: chart.desktop.clone(),
                        compact: chart.compact.clone(),
                        mobile: chart.mobile.clone(),
                        manifest: chart.manifest.clone(),
                    };
                    let composed = crate::compose_answer::compose(root, &files, spec);
                    let mut record = json!({
                        "type": "newsroom_composed_answer",
                        "schema_version": "0.1.0",
                        "manifest_ref": chart.manifest,
                        "_newsroom_recorded_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                    });
                    match &composed {
                        Ok(_) => record["source"] = json!("runtime"),
                        Err(error) => {
                            record["source"] = json!("model");
                            record["reason"] = json!(format!("{error:#}"));
                        }
                    }
                    if let Some(file) = log.as_mut() {
                        writeln!(file, "{}", serde_json::to_string(&record)?)?;
                        file.flush()?;
                    }
                    eprintln!(
                        "[agent] composed_answer elapsed_ms={} source={}",
                        started.elapsed().as_millis(),
                        if composed.is_ok() { "runtime" } else { "model" }
                    );
                    composed_answer = composed.ok();
                }
            }

            match (turn_stop.as_deref(), turn_class) {
                (Some("error"), Some(class)) => {
                    let is_message_end =
                        event.get("type").and_then(Value::as_str) == Some("message_end");
                    let already = telemetry
                        .pending
                        .as_ref()
                        .is_some_and(|failure| failure.turn_index == telemetry.turns);
                    if is_message_end || !already {
                        telemetry.turn_failed(class, now_ms, gap_ms, turn_tokens);
                    }
                }
                (Some(_), _) => telemetry.turn_ok(turn_tokens),
                _ => {}
            }

            match event.get("type").and_then(Value::as_str) {
                Some("response")
                    if event.get("command").and_then(Value::as_str) == Some("prompt") =>
                {
                    if event.get("success").and_then(Value::as_bool) == Some(true) {
                        prompt_accepted = true;
                        telemetry.stage = "streaming";
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
                                "message": prompt
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
                        let who = if crate::agent_loop::agent_rust_enabled() {
                            "The model"
                        } else {
                            "Pi"
                        };
                        bail!(
                            "{who} rejected the prompt: {class}{status} (raw diagnostic suppressed)"
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
                    telemetry.stream_event(now_ms);
                    if let Some(update) = event.get("assistantMessageEvent") {
                        if update.get("type").and_then(Value::as_str) == Some("text_delta") {
                            if let Some(delta) = update.get("delta").and_then(Value::as_str) {
                                if first_text_ms.is_none() {
                                    first_text_ms = Some(started.elapsed().as_millis());
                                }
                                if composed_answer.is_none() {
                                    print!("{delta}");
                                    std::io::stdout().flush().ok();
                                }
                                streamed_answer.push_str(delta);
                            }
                        }
                    }
                }
                Some("tool_execution_start") => {
                    active_work = true;
                    if !crate::step_lines::enabled() {
                        eprintln!(
                            "[agent] phase=tool-running elapsed_ms={}",
                            started.elapsed().as_millis()
                        );
                    }
                }
                Some("tool_execution_end") => {
                    if !crate::step_lines::enabled() {
                        eprintln!(
                            "[agent] phase=tool-complete elapsed_ms={}",
                            started.elapsed().as_millis()
                        );
                    }
                }
                Some("turn_start") => {
                    // A new model/tool turn is active even when the provider
                    // emits no visible text while it is thinking.
                    active_work = true;
                    telemetry.turn_started(now_ms);
                    if composed_answer.is_some() && !compose_abort_sent {
                        // The one chart is complete and its closing text is composed, so
                        // this turn could only restate it.
                        send_json(
                            &mut stdin,
                            &json!({"id": "news-compose-abort", "type": "abort"}),
                            finish,
                        )
                        .await?;
                        compose_abort_sent = true;
                        finish_started.get_or_insert_with(Instant::now);
                        eprintln!(
                            "[agent] phase=compose-abort elapsed_ms={}",
                            started.elapsed().as_millis()
                        );
                    }
                }
                Some("turn_end") => {
                    // Re-enable the idle boundary between turns. Tool and
                    // thinking events keep this true for the whole turn, so a
                    // long tool call is never mistaken for token silence.
                    active_work = false;
                }
                Some("agent_start" | "message_start" | "auto_retry_start") => {
                    active_work = true;
                    match event.get("type").and_then(Value::as_str) {
                        Some("auto_retry_start") => telemetry.auto_retries += 1,
                        Some("message_start")
                            if event
                                .get("message")
                                .and_then(|m| m.get("stopReason"))
                                .and_then(Value::as_str)
                                != Some("error") =>
                        {
                            telemetry.stream_event(now_ms)
                        }
                        _ => {}
                    }
                }
                Some("extension_error") => {
                    extension_errors.push("suppressed".to_string());
                    eprintln!("[extension] runtime error (payload suppressed)");
                }
                Some("agent_settled") => {
                    saw_settled = true;
                    telemetry.stage = "finishing";
                    finish_started.get_or_insert_with(Instant::now);
                    if !final_queries_sent {
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

        let answer = match composed_answer {
            Some(text) => {
                print!("{text}");
                std::io::stdout().flush().ok();
                text
            }
            None => final_answer.unwrap_or(streamed_answer),
        };
        if let Some(failure) = telemetry.pending.clone() {
            // The settled final turn is a provider error: the run did not
            // complete, even when partial text was streamed. Keep the text.
            if !answer.is_empty() && !answer.ends_with('\n') {
                println!();
            }
            return Err(anyhow::Error::new(ProviderFailure {
                class: failure.class,
                http_status: failure.status,
                turn_index: failure.turn_index,
                elapsed_ms: failure.at_ms,
                partial_text: answer,
            }));
        }
        if answer.trim().is_empty() {
            bail!("Pi returned an empty final answer (provider diagnostic suppressed)");
        }
        if !answer.ends_with('\n') {
            println!();
        }

        let rpc_ms = started.elapsed().as_millis();
        if !crate::step_lines::enabled() {
            eprintln!(
                "[agent] phase=complete rpc_ms={} first_model_text_ms={}",
                rpc_ms,
                first_text_ms
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "N/A".into())
            );
        }
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
            let tool_count = config
                .tools_arg()
                .split(',')
                .filter(|name| !name.is_empty())
                .count();
            let metric_event = json!({
                "type": "newsroom_rpc_metrics",
                "schema_version": "0.2.0",
                "outcome": "completed",
                "events_received": telemetry.events,
                "bytes_received": telemetry.bytes,
                "first_event_ms": telemetry.first_event_ms,
                "turns": telemetry.turns,
                "recovered_failed_turns": telemetry.failed_turns,
                "auto_retries": telemetry.auto_retries,
                "startup_ms": startup_ms,
                "rpc_ms": rpc_ms,
                "first_model_text_ms": first_text_ms,
                "prompt_attempts": prompt_attempt,
                "prompt_bytes": prompt.len(),
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
    if let (Err(error), Some(path)) = (&outcome, event_log) {
        record_rpc_failure(path, config, prompt, &telemetry, started, error);
    }
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

/// Appends one `newsroom_rpc_failure` event (best effort) and prints a one-line
/// stderr summary. Only classes, counts and durations are recorded.
fn record_rpc_failure(
    path: &Path,
    config: &PiConfig,
    prompt: &str,
    telemetry: &RunTelemetry,
    started: Instant,
    error: &anyhow::Error,
) {
    let elapsed_ms = started.elapsed().as_millis();
    let provider = error.downcast_ref::<ProviderFailure>();
    let failure = telemetry.pending.as_ref();
    let message = format!("{error:#}");
    let event = json!({
        "type": "newsroom_rpc_failure",
        "schema_version": "0.1.0",
        "kind": if provider.is_some() { "provider_failure" } else { "rpc_failure" },
        "stage": telemetry.stage,
        "message": message,
        "class": provider.map(|value| value.class),
        "http_status": provider.and_then(|value| value.http_status),
        "turn_index": failure.map(|value| value.turn_index).or((telemetry.turns > 0).then_some(telemetry.turns)),
        "elapsed_ms": elapsed_ms,
        "failure_at_ms": failure.map(|value| value.at_ms),
        "first_event_ms": telemetry.first_event_ms,
        "events_received": telemetry.events,
        "bytes_received": telemetry.bytes,
        "turn_events": failure.map(|value| value.turn_events),
        "turn_bytes": failure.map(|value| value.turn_bytes),
        "turn_ms": failure.and_then(|value| value.turn_ms),
        "turn_first_event_ms": failure.and_then(|value| value.turn_first_event_ms),
        "gap_before_failure_ms": failure.map(|value| value.gap_ms),
        "failed_turn_context_tokens": failure.and_then(|value| value.context_tokens),
        "last_ok_context_tokens": telemetry.last_ok_context_tokens,
        "failed_turns": telemetry.failed_turns,
        "auto_retries": telemetry.auto_retries,
        "turn_classes": telemetry.classes,
        "partial_text_bytes": provider.map(|value| value.partial_text.len()),
        "prompt_bytes": prompt.len(),
        "continue_session": config.continue_session,
        "_newsroom_recorded_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    });
    if let Ok(mut file) = crate::group_guard::as_run_bundle(|| {
        crate::group_guard::open_append(path.parent().unwrap_or(Path::new("")), path)
    }) {
        let _ = writeln!(file, "{event}");
    }
    let number = |value: Option<u128>| value.map_or("N/A".to_string(), |v| v.to_string());
    eprintln!(
        "[agent] rpc_failure class={} stage={} turn={} elapsed_ms={elapsed_ms} first_event_ms={} events={} bytes={} turn_events={} turn_bytes={} turn_ms={} gap_ms={}",
        provider.map_or("none", |value| value.class),
        telemetry.stage,
        telemetry.turns,
        number(telemetry.first_event_ms),
        telemetry.events,
        telemetry.bytes,
        failure.map_or("N/A".to_string(), |value| value.turn_events.to_string()),
        failure.map_or("N/A".to_string(), |value| value.turn_bytes.to_string()),
        number(failure.and_then(|value| value.turn_ms)),
        number(failure.map(|value| value.gap_ms)),
    );
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
            _ = tokio::time::sleep(heartbeat) => {
                if !crate::step_lines::enabled() {
                    eprintln!("[agent] phase=rpc-write elapsed_ms={}", started.elapsed().as_millis());
                }
            }
        }
    }
    Ok(())
}

/// The child command of the old runtime, selected explicitly with NEWSROOM_AGENT=pi so the test does not depend on the default (1012zi step 0).
/// Tests that call it hold ENV_LOCK; the previous value of the switch is put back.
#[cfg(test)]
impl PiConfig {
    pub(crate) fn pi_command(&self) -> Command {
        let before = std::env::var(crate::agent_loop::AGENT_ENV).ok();
        std::env::set_var(crate::agent_loop::AGENT_ENV, "pi");
        let command = self.command();
        match before {
            Some(value) => std::env::set_var(crate::agent_loop::AGENT_ENV, value),
            None => std::env::remove_var(crate::agent_loop::AGENT_ENV),
        }
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_label_uses_defaults() {
        // The line now follows NEWSROOM_AGENT, which other tests set while they hold ENV_LOCK: hold it too (the assertion below is unchanged).
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
            speed: Default::default(),
            compose: None,
        };
        assert_eq!(
            cfg.display_runtime(),
            "pi-rpc provider=<pi-default> model=<pi-default> session=ephemeral tools=investigate"
        );
    }

    #[test]
    fn runtime_label_names_the_rust_agent_on_the_rust_path() {
        let cfg = PiConfig {
            binary: "pi".into(),
            provider: Some("dragoncode".to_string()),
            model: Some("claude-sonnet-4-6".to_string()),
            api_key: Some("not-a-real-key".to_string()),
            base_url: Some("https://relay.example.invalid:8443/v1".to_string()),
            thinking: None,
            approve_project: false,
            extension: None,
            artifact_dir: None,
            session_dir: Some("agent-session".into()),
            continue_session: true,
            tool_profile: "investigate".to_string(),
            speed: Default::default(),
            compose: None,
        };
        let rust = cfg.display_runtime_for(true);
        assert_eq!(
            rust,
            "rust-agent provider=dragoncode model=claude-sonnet-4-6 session=persistent/resume tools=investigate"
        );
        assert!(
            !rust.contains("pi-rpc")
                && !rust.contains("example")
                && !rust.contains("not-a-real-key")
                && !rust.contains("8443"),
            "the line names the runtime, provider and model only"
        );
        assert_eq!(
            cfg.display_runtime_for(false),
            "pi-rpc provider=dragoncode model=claude-sonnet-4-6 session=persistent/resume tools=investigate",
            "the Pi path keeps its line"
        );
        let bare = PiConfig {
            provider: None,
            model: None,
            base_url: None,
            api_key: None,
            session_dir: None,
            continue_session: false,
            ..cfg
        };
        assert_eq!(
            bare.display_runtime_for(true),
            "rust-agent provider=<default> model=<default> session=ephemeral tools=investigate"
        );
        assert_eq!(
            bare.display_runtime_for(false),
            "pi-rpc provider=<pi-default> model=<pi-default> session=ephemeral tools=investigate"
        );
    }

    fn visual_story_config(profile: &str) -> PiConfig {
        PiConfig {
            binary: "pi".into(),
            provider: None,
            model: None,
            api_key: None,
            base_url: None,
            thinking: None,
            approve_project: false,
            extension: Some("ext.ts".into()),
            artifact_dir: None,
            session_dir: None,
            continue_session: false,
            tool_profile: profile.to_string(),
            speed: Default::default(),
            compose: None,
        }
    }

    fn names(config: &PiConfig) -> Vec<String> {
        config.tools_arg().split(',').map(str::to_string).collect()
    }

    #[test]
    fn visual_story_drops_exactly_one_design_and_one_publish_tool() {
        let registry: Value =
            serde_json::from_str(include_str!("../config/tool-registry.json")).unwrap();
        let phase_of = |name: &str| {
            registry["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .map(|tool| tool["phase"].as_str().unwrap().to_string())
                .unwrap_or_else(|| panic!("{name} missing from tool-registry.json"))
        };
        let base: Vec<String> = crate::tool_registry::tools_for_profile("visual-story")
            .unwrap()
            .split(',')
            .map(str::to_string)
            .collect();
        let lean = names(&visual_story_config("visual-story"));
        println!(
            "visual-story registry tools={} offered tools={}",
            base.len(),
            lean.len()
        );
        assert_eq!(base.len() - lean.len(), 2);
        let removed: Vec<&String> = base.iter().filter(|name| !lean.contains(name)).collect();
        let mut phases: Vec<String> = removed.iter().map(|name| phase_of(name)).collect();
        phases.sort();
        assert_eq!(phases, ["design", "publish"]);
        let mut removed_names: Vec<&str> = removed.iter().map(|name| name.as_str()).collect();
        removed_names.sort();
        assert_eq!(removed_names, LIEFLAT_TOOLS);
        // Order of everything else is unchanged.
        let kept: Vec<&String> = base.iter().filter(|name| lean.contains(name)).collect();
        assert_eq!(kept, lean.iter().collect::<Vec<_>>());
    }

    #[test]
    fn the_lieflat_tools_stay_in_every_other_profile() {
        for profile in [
            "investigate",
            "visual",
            "publication",
            "competition",
            "full",
            "no-such-profile",
        ] {
            let effective = if crate::tool_registry::tools_for_profile(profile).is_some() {
                profile
            } else {
                DEFAULT_TOOL_PROFILE
            };
            assert_eq!(
                visual_story_config(profile).tools_arg(),
                crate::tool_registry::tools_for_profile(effective).unwrap(),
                "{profile}"
            );
        }
    }

    #[test]
    fn seven_switches_set_to_true_are_off_on_the_prompt_side_like_the_runtime() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let names = [
            PARALLEL_HINTS_ENV,
            COMPUTE_BATCH_ENV,
            ATOMIC_ARTIFACT_ENV,
            CHAIN_VIZ_ENV,
            CHAIN_INFOGRAPHIC_ENV,
            PREFLIGHT_ENV,
            PLAN_EDIT_ENV,
        ];
        for name in names {
            std::env::remove_var(name);
        }
        for not_one in ["true", "TRUE", "yes", "0", "", " 1", "1 "] {
            for name in names {
                std::env::set_var(name, not_one);
            }
            assert_eq!(
                speed_switches_from_env(),
                crate::prompt::PromptSpeed::default(),
                "{not_one:?}"
            );
        }
        for name in names {
            std::env::set_var(name, "1");
        }
        let on = speed_switches_from_env();
        assert!(
            on.parallel_hints
                && on.compute_batch
                && on.chain_viz
                && on.chain_infographic
                && on.preflight
                && on.plan_edit
        );
        for name in names {
            std::env::remove_var(name);
        }
    }

    #[test]
    fn data_profile_switch_is_exactly_one_and_changes_no_other_switch() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(DATA_PROFILE_ENV);
        assert_eq!(
            speed_switches_from_env(),
            crate::prompt::PromptSpeed::default()
        );
        for not_one in ["0", "true", "yes", ""] {
            std::env::set_var(DATA_PROFILE_ENV, not_one);
            assert!(!speed_switches_from_env().data_profile, "{not_one:?}");
        }
        std::env::set_var(DATA_PROFILE_ENV, "1");
        let on = speed_switches_from_env();
        assert!(on.data_profile);
        assert_eq!(
            crate::prompt::PromptSpeed {
                data_profile: false,
                ..on
            },
            crate::prompt::PromptSpeed::default()
        );
        std::env::remove_var(DATA_PROFILE_ENV);
    }

    #[test]
    fn recipes_switch_is_exactly_one_and_changes_no_other_switch() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(RECIPES_ENV);
        assert_eq!(
            speed_switches_from_env(),
            crate::prompt::PromptSpeed::default()
        );
        for not_one in ["0", "true", "yes", ""] {
            std::env::set_var(RECIPES_ENV, not_one);
            assert!(!speed_switches_from_env().recipes, "{not_one:?}");
        }
        std::env::set_var(RECIPES_ENV, "1");
        let on = speed_switches_from_env();
        assert!(on.recipes);
        assert_eq!(
            crate::prompt::PromptSpeed {
                recipes: false,
                ..on
            },
            crate::prompt::PromptSpeed::default()
        );
        std::env::remove_var(RECIPES_ENV);
    }

    #[test]
    fn plan_progress_lines_come_only_from_tool_end_events_and_never_from_text() {
        let end = json!({"type": "tool_execution_end", "toolName": "duckdb_query", "toolCallId": "c9", "isError": true});
        let line = plan_progress_entry(&end, 3).unwrap();
        assert_eq!(line["tool_call_id"], "c9");
        assert_eq!(line["tool"], "duckdb_query");
        assert_eq!(line["seq"], 3);
        assert_eq!(line["status"], "failed");
        let ok = json!({"type": "tool_execution_end", "toolName": "duckdb_query", "toolCallId": "c10", "isError": false});
        assert_eq!(plan_progress_entry(&ok, 4).unwrap()["status"], "completed");
        let unknown =
            json!({"type": "tool_execution_end", "toolName": "duckdb_query", "toolCallId": "c11"});
        let line = plan_progress_entry(&unknown, 5).unwrap();
        assert_eq!(line["status"], "unknown");
        assert!(line["is_error"].is_null());
        for other in [
            json!({"type": "tool_execution_start", "toolName": "x", "toolCallId": "c1"}),
            json!({"type": "message_update", "assistantMessageEvent": {"delta": "plan: done"}}),
            json!({"type": "tool_execution_end", "toolName": "x"}),
        ] {
            assert!(plan_progress_entry(&other, 1).is_none());
        }
    }

    #[test]
    fn plan_progress_switch_is_exactly_one_and_turns_parallel_hints_on_with_it() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(PLAN_PROGRESS_ENV);
        std::env::remove_var(PARALLEL_HINTS_ENV);
        for not_one in ["0", "true", "yes", ""] {
            std::env::set_var(PLAN_PROGRESS_ENV, not_one);
            assert_eq!(
                speed_switches_from_env(),
                crate::prompt::PromptSpeed::default()
            );
        }
        std::env::set_var(PLAN_PROGRESS_ENV, "1");
        let on = speed_switches_from_env();
        assert!(on.plan_progress && on.parallel_hints);
        assert_eq!(
            crate::prompt::PromptSpeed {
                plan_progress: false,
                parallel_hints: false,
                ..on
            },
            crate::prompt::PromptSpeed::default()
        );
        std::env::remove_var(PLAN_PROGRESS_ENV);
    }

    #[test]
    fn compose_switch_is_exactly_one_and_changes_no_other_switch() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(COMPOSE_ANSWER_ENV);
        for not_one in ["0", "true", "yes", ""] {
            std::env::set_var(COMPOSE_ANSWER_ENV, not_one);
            assert!(!speed_switches_from_env().compose_answer, "{not_one:?}");
        }
        std::env::set_var(COMPOSE_ANSWER_ENV, "1");
        let on = speed_switches_from_env();
        assert!(on.compose_answer);
        assert_eq!(
            crate::prompt::PromptSpeed {
                compose_answer: false,
                ..on
            },
            crate::prompt::PromptSpeed::default()
        );
        std::env::remove_var(COMPOSE_ANSWER_ENV);
    }

    #[test]
    fn numword_prompt_switch_is_exactly_one_and_changes_no_other_switch() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(NUMWORD_PROMPT_ENV);
        for not_one in ["0", "true", "yes", ""] {
            std::env::set_var(NUMWORD_PROMPT_ENV, not_one);
            assert!(!speed_switches_from_env().numword_prompt, "{not_one:?}");
        }
        std::env::set_var(NUMWORD_PROMPT_ENV, "1");
        let on = speed_switches_from_env();
        assert!(on.numword_prompt);
        assert_eq!(
            crate::prompt::PromptSpeed {
                numword_prompt: false,
                ..on
            },
            crate::prompt::PromptSpeed::default()
        );
        std::env::remove_var(NUMWORD_PROMPT_ENV);
    }

    #[test]
    fn lean_gates_prompt_switch_is_exactly_one_and_changes_no_other_switch() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(LEAN_GATES_ENV);
        for not_one in ["0", "true", "yes", " 1", ""] {
            std::env::set_var(LEAN_GATES_ENV, not_one);
            assert!(!speed_switches_from_env().lean_gates, "{not_one:?}");
        }
        std::env::set_var(LEAN_GATES_ENV, "1");
        let on = speed_switches_from_env();
        assert!(on.lean_gates);
        assert_eq!(
            crate::prompt::PromptSpeed {
                lean_gates: false,
                ..on
            },
            crate::prompt::PromptSpeed::default()
        );
        std::env::remove_var(LEAN_GATES_ENV);
    }

    #[test]
    fn pi_offline_is_set_only_when_the_switch_is_exactly_one() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = std::env::var(PI_OFFLINE_ENV).ok();
        let offline = || {
            let command = visual_story_config("investigate").pi_command();
            let found = command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == "PI_OFFLINE")
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
            found
        };
        std::env::remove_var(PI_OFFLINE_ENV);
        assert_eq!(offline(), None);
        for off in ["", "true", "0", " 1", "yes"] {
            std::env::set_var(PI_OFFLINE_ENV, off);
            assert_eq!(
                offline(),
                None,
                "switch value {off:?} must not set PI_OFFLINE"
            );
        }
        std::env::set_var(PI_OFFLINE_ENV, "1");
        assert_eq!(offline(), Some(Some("1".to_string())));
        match saved {
            Some(value) => std::env::set_var(PI_OFFLINE_ENV, value),
            None => std::env::remove_var(PI_OFFLINE_ENV),
        }
    }

    #[test]
    fn speed_markers_follow_the_config_not_the_parent() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(PARALLEL_HINTS_ENV, "1");
        let marker = |config: &PiConfig| {
            let command = config.pi_command();
            let found = command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == PARALLEL_HINTS_ENV)
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
            found
        };
        let mut config = visual_story_config("investigate");
        // The parent asked for it, the config did not: the child must not see it.
        assert_eq!(marker(&config), Some(None));
        config.speed.parallel_hints = true;
        assert_eq!(marker(&config), Some(Some("1".to_string())));
        assert!(speed_switches_from_env().parallel_hints);
        std::env::set_var(PARALLEL_HINTS_ENV, "0");
        assert!(!speed_switches_from_env().parallel_hints);
        std::env::remove_var(PARALLEL_HINTS_ENV);
        assert!(!speed_switches_from_env().parallel_hints);

        std::env::set_var(COMPUTE_BATCH_ENV, "1");
        let batch_marker = |config: &PiConfig| {
            let command = config.pi_command();
            let found = command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == COMPUTE_BATCH_ENV)
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
            found
        };
        let mut config = visual_story_config("investigate");
        assert_eq!(batch_marker(&config), Some(None));
        assert!(speed_switches_from_env().compute_batch);
        config.speed.compute_batch = true;
        assert_eq!(batch_marker(&config), Some(Some("1".to_string())));
        std::env::remove_var(COMPUTE_BATCH_ENV);
        assert!(!speed_switches_from_env().compute_batch);

        std::env::set_var(CHAIN_VIZ_ENV, "1");
        std::env::remove_var(ATOMIC_ARTIFACT_ENV);
        assert!(
            !speed_switches_from_env().chain_viz,
            "chains need atomic writes"
        );
        std::env::set_var(ATOMIC_ARTIFACT_ENV, "1");
        let chain_marker = |config: &PiConfig| {
            let command = config.pi_command();
            let found = command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == CHAIN_VIZ_ENV)
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
            found
        };
        let mut config = visual_story_config("investigate");
        assert_eq!(chain_marker(&config), Some(None));
        assert!(speed_switches_from_env().chain_viz);
        config.speed.chain_viz = true;
        assert_eq!(chain_marker(&config), Some(Some("1".to_string())));
        std::env::remove_var(CHAIN_VIZ_ENV);
        assert!(!speed_switches_from_env().chain_viz);

        std::env::set_var(CHAIN_INFOGRAPHIC_ENV, "1");
        std::env::remove_var(ATOMIC_ARTIFACT_ENV);
        assert!(
            !speed_switches_from_env().chain_infographic,
            "chains need atomic writes"
        );
        std::env::set_var(ATOMIC_ARTIFACT_ENV, "1");
        let page_marker = |config: &PiConfig| {
            let command = config.pi_command();
            let found = command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == CHAIN_INFOGRAPHIC_ENV)
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
            found
        };
        let mut config = visual_story_config("investigate");
        assert_eq!(page_marker(&config), Some(None));
        assert!(speed_switches_from_env().chain_infographic);
        config.speed.chain_infographic = true;
        assert_eq!(page_marker(&config), Some(Some("1".to_string())));
        std::env::remove_var(CHAIN_INFOGRAPHIC_ENV);
        assert!(!speed_switches_from_env().chain_infographic);
        std::env::remove_var(ATOMIC_ARTIFACT_ENV);

        // Preflight needs no other switch and follows the config like the rest.
        let preflight_marker = |config: &PiConfig| {
            let command = config.pi_command();
            let found = command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == PREFLIGHT_ENV)
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
            found
        };
        std::env::set_var(PREFLIGHT_ENV, "1");
        let mut config = visual_story_config("investigate");
        assert!(speed_switches_from_env().preflight);
        assert_eq!(preflight_marker(&config), Some(None));
        config.speed.preflight = true;
        assert_eq!(preflight_marker(&config), Some(Some("1".to_string())));
        std::env::remove_var(PREFLIGHT_ENV);
        assert!(!speed_switches_from_env().preflight);

        // Plan edit: marker follows the config; the tool is offered only with the plan tool.
        let edit_marker = |config: &PiConfig| {
            let command = config.pi_command();
            let found = command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == PLAN_EDIT_ENV)
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
            found
        };
        std::env::set_var(PLAN_EDIT_ENV, "1");
        let mut config = visual_story_config("investigate");
        assert!(speed_switches_from_env().plan_edit);
        assert_eq!(edit_marker(&config), Some(None));
        assert!(!config
            .tools_arg()
            .split(',')
            .any(|name| name == PLAN_EDIT_TOOL));
        config.speed.plan_edit = true;
        assert_eq!(edit_marker(&config), Some(Some("1".to_string())));
        std::env::remove_var(PLAN_EDIT_ENV);
        assert!(!speed_switches_from_env().plan_edit);
    }

    #[test]
    fn the_page_read_back_tool_is_offered_only_with_exactly_one_and_the_qa_tool() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = std::env::var(PAGE_OCR_ENV).ok();
        let offered = |profile: &str| {
            visual_story_config(profile)
                .tools_arg()
                .split(',')
                .any(|name| name == PAGE_OCR_TOOL)
        };
        std::env::remove_var(PAGE_OCR_ENV);
        assert!(!offered("visual-story"));
        for not_one in ["true", "TRUE", "yes", "0", "", " 1", "1 "] {
            std::env::set_var(PAGE_OCR_ENV, not_one);
            assert!(!offered("visual-story"), "{not_one:?}");
        }
        let off = visual_story_config("visual-story").tools_arg();
        std::env::set_var(PAGE_OCR_ENV, "1");
        assert!(offered("visual-story"));
        assert!(offered("publication"));
        // Where the QA tool is not offered, the read-back is not either.
        assert!(!offered("investigate"));
        let on = visual_story_config("visual-story").tools_arg();
        assert_eq!(on, format!("{off},{PAGE_OCR_TOOL}"));
        match saved {
            Some(value) => std::env::set_var(PAGE_OCR_ENV, value),
            None => std::env::remove_var(PAGE_OCR_ENV),
        }
    }

    #[test]
    fn inline_claim_switch_needs_the_chain_and_atomic_writes_and_is_exactly_one() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let marker = |config: &PiConfig| {
            let command = config.pi_command();
            let found = command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == INLINE_CLAIM_ENV)
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
            found
        };
        std::env::set_var(INLINE_CLAIM_ENV, "1");
        std::env::remove_var(CHAIN_VIZ_ENV);
        std::env::remove_var(ATOMIC_ARTIFACT_ENV);
        assert!(
            !speed_switches_from_env().inline_claim,
            "needs the chart chain"
        );
        std::env::set_var(CHAIN_VIZ_ENV, "1");
        assert!(
            !speed_switches_from_env().inline_claim,
            "needs atomic writes"
        );
        std::env::set_var(ATOMIC_ARTIFACT_ENV, "1");
        assert!(speed_switches_from_env().inline_claim);
        for not_one in ["true", "0", "", "yes", "1 "] {
            std::env::set_var(INLINE_CLAIM_ENV, not_one);
            assert!(!speed_switches_from_env().inline_claim, "{not_one:?}");
        }
        std::env::set_var(INLINE_CLAIM_ENV, "1");
        // The child marker follows the config, never the parent.
        let mut config = visual_story_config("investigate");
        assert_eq!(marker(&config), Some(None));
        config.speed.inline_claim = true;
        assert_eq!(marker(&config), Some(Some("1".to_string())));
        // It does not change the tool list: the chain tool carries the extra parameters.
        let mut chain = visual_story_config("visual-story");
        chain.speed.chain_viz = true;
        let without = chain.tools_arg();
        chain.speed.inline_claim = true;
        assert_eq!(chain.tools_arg(), without);
        std::env::remove_var(INLINE_CLAIM_ENV);
        std::env::remove_var(CHAIN_VIZ_ENV);
        std::env::remove_var(ATOMIC_ARTIFACT_ENV);
        assert!(!speed_switches_from_env().inline_claim);
    }

    fn viz_chain_steps(render: Value, critic_manifest: &str, passed: bool) -> Value {
        json!([
            {"tool": "newsroom_viz_plan", "params": {}, "details": {"planRef": "visualizations/plans/p.json", "publishable": true}},
            {"tool": "newsroom_viz_lint", "params": {"plan_ref": "visualizations/plans/p.json"}, "details": {"passed": true}},
            {"tool": "newsroom_viz_render", "params": {"plan_ref": "visualizations/plans/p.json"}, "details": render},
            {"tool": "newsroom_viz_critic", "params": {"manifest_ref": critic_manifest}, "details": {"passed": passed}}
        ])
    }

    fn viz_chain_end(id: &str, chain_status: &str, steps: Value) -> Value {
        json!({"type": "tool_execution_end", "toolName": "newsroom_viz_chain", "toolCallId": id, "isError": false,
            "result": {"details": {"chain": "newsroom_viz_chain", "chainStatus": chain_status, "steps": steps}}})
    }

    #[test]
    fn chart_ready_fires_once_for_a_completed_chain_whose_critic_passed() {
        let render = |desktop: &str, compact: &str| json!({"manifestRef": "visualizations/a.json", "desktopSvgRef": desktop, "compactSvgRef": compact});
        let good_render = || render("visualizations/a.svg", "visualizations/a.compact.svg");
        let mut watch = ChartReadyWatch::default();
        assert_eq!(
            watch.observe(&json!({"type": "tool_execution_start", "toolName": "newsroom_viz_chain", "toolCallId": "s", "args": {}})),
            None,
            "a start event announces nothing"
        );
        let refused: Vec<(&str, Value)> = vec![
            (
                "a stopped chain, even with every step listed",
                viz_chain_end(
                    "c1",
                    "STOPPED",
                    viz_chain_steps(good_render(), "visualizations/a.json", true),
                ),
            ),
            (
                "a chain stopped at a critic revision",
                viz_chain_end(
                    "c1b",
                    "STOPPED",
                    viz_chain_steps(good_render(), "visualizations/a.json", false),
                ),
            ),
            (
                "a completed chain whose critic did not pass",
                viz_chain_end(
                    "c2",
                    "COMPLETE",
                    viz_chain_steps(good_render(), "visualizations/a.json", false),
                ),
            ),
            (
                "a completed chain with a step missing",
                viz_chain_end(
                    "c3",
                    "COMPLETE",
                    json!(
                        viz_chain_steps(good_render(), "visualizations/a.json", true)
                            .as_array()
                            .unwrap()[..3]
                    ),
                ),
            ),
            (
                "a critic that judged another manifest",
                viz_chain_end(
                    "c4",
                    "COMPLETE",
                    viz_chain_steps(good_render(), "visualizations/other.json", true),
                ),
            ),
            (
                "an absolute desktop ref",
                viz_chain_end(
                    "c5",
                    "COMPLETE",
                    viz_chain_steps(
                        render("/tmp/a.svg", "visualizations/a.compact.svg"),
                        "visualizations/a.json",
                        true,
                    ),
                ),
            ),
            (
                "a compact ref that climbs out of visualizations",
                viz_chain_end(
                    "c6",
                    "COMPLETE",
                    viz_chain_steps(
                        render("visualizations/a.svg", "visualizations/../a.compact.svg"),
                        "visualizations/a.json",
                        true,
                    ),
                ),
            ),
            (
                "a render without a manifest",
                viz_chain_end(
                    "c7",
                    "COMPLETE",
                    viz_chain_steps(
                        json!({"desktopSvgRef": "visualizations/a.svg"}),
                        "visualizations/a.json",
                        true,
                    ),
                ),
            ),
        ];
        for (why, event) in &refused {
            assert_eq!(watch.observe(event), None, "{why}");
        }
        let mut errored = viz_chain_end(
            "c8",
            "COMPLETE",
            viz_chain_steps(good_render(), "visualizations/a.json", true),
        );
        errored["isError"] = json!(true);
        assert_eq!(watch.observe(&errored), None, "a call that errored");
        let mut other_chain = viz_chain_end(
            "c9",
            "COMPLETE",
            viz_chain_steps(good_render(), "visualizations/a.json", true),
        );
        other_chain["result"]["details"]["chain"] = json!("newsroom_infographic_chain");
        assert_eq!(watch.observe(&other_chain), None, "another chain's record");
        let mut reordered = viz_chain_steps(good_render(), "visualizations/a.json", true);
        reordered.as_array_mut().unwrap().swap(0, 1);
        assert_eq!(
            watch.observe(&viz_chain_end("c10", "COMPLETE", reordered)),
            None,
            "steps out of order"
        );
        let good = viz_chain_end(
            "c11",
            "COMPLETE",
            viz_chain_steps(good_render(), "visualizations/a.json", true),
        );
        assert_eq!(
            watch.observe(&good),
            Some(ReadyChart {
                desktop: "visualizations/a.svg".to_string(),
                compact: Some("visualizations/a.compact.svg".to_string()),
                mobile: None,
                manifest: "visualizations/a.json".to_string(),
            })
        );
        assert_eq!(
            watch.observe(&viz_chain_end(
                "c12",
                "COMPLETE",
                viz_chain_steps(good_render(), "visualizations/a.json", true)
            )),
            None,
            "announce only once"
        );
    }

    #[test]
    fn chart_ready_fires_for_a_separately_called_critic_of_a_rendered_manifest() {
        let render = |manifest: &str, desktop: &str| {
            json!({"type": "tool_execution_end", "toolName": "newsroom_viz_render", "toolCallId": format!("r-{manifest}"), "isError": false,
                "result": {"details": {"manifestRef": manifest, "desktopSvgRef": desktop, "mobileSvgRef": "visualizations/a.mobile.svg"}}})
        };
        let critic_start = |id: &str, manifest: &str| json!({"type": "tool_execution_start", "toolName": "newsroom_viz_critic", "toolCallId": id, "args": {"manifest_ref": manifest}});
        let critic_end = |id: &str, passed: bool| {
            json!({"type": "tool_execution_end", "toolName": "newsroom_viz_critic", "toolCallId": id, "isError": false,
                "result": {"details": {"passed": passed}}})
        };
        let mut watch = ChartReadyWatch::default();
        assert_eq!(
            watch.observe(&render("visualizations/a.json", "visualizations/a.svg")),
            None
        );
        assert_eq!(
            watch.observe(&render("visualizations/x.json", "visualizations/../x.svg")),
            None
        );
        watch.observe(&critic_start("c1", "visualizations/a.json"));
        assert_eq!(watch.observe(&critic_end("c1", false)), None);
        watch.observe(&critic_start("c2", "visualizations/x.json"));
        assert_eq!(
            watch.observe(&critic_end("c2", true)),
            None,
            "unsafe render refs are never announced"
        );
        watch.observe(&critic_start("c0", "visualizations/never-rendered.json"));
        assert_eq!(
            watch.observe(&critic_end("c0", true)),
            None,
            "a critic for a manifest no render produced"
        );
        watch.observe(&critic_start("c3", "visualizations/a.json"));
        assert_eq!(
            watch.observe(&critic_end("c3", true)),
            Some(ReadyChart {
                desktop: "visualizations/a.svg".to_string(),
                compact: None,
                mobile: Some("visualizations/a.mobile.svg".to_string()),
                manifest: "visualizations/a.json".to_string(),
            })
        );
        watch.observe(&critic_start("c4", "visualizations/a.json"));
        assert_eq!(
            watch.observe(&critic_end("c4", true)),
            None,
            "announce only once"
        );
    }

    #[test]
    fn chart_ready_line_names_each_file_and_claims_no_status() {
        let chart = ReadyChart {
            desktop: "visualizations/a.svg".to_string(),
            compact: Some("visualizations/a.compact.svg".to_string()),
            mobile: None,
            manifest: "visualizations/a.json".to_string(),
        };
        let line = chart_ready_line(1234, Path::new("/runs/r1"), &chart);
        assert_eq!(
            line,
            "[agent] chart_ready elapsed_ms=1234 desktop=/runs/r1/visualizations/a.svg compact=/runs/r1/visualizations/a.compact.svg (critic passed; progress only, the run continues)"
        );
        for word in ["verified", "publishable", "complete", "passed qa"] {
            assert!(!line.to_lowercase().contains(word), "{word}");
        }
        let both = ReadyChart {
            mobile: Some("visualizations/a.mobile.svg".to_string()),
            ..chart.clone()
        };
        let line = chart_ready_line(5, Path::new(""), &both);
        assert!(line
            .contains(" compact=visualizations/a.compact.svg mobile=visualizations/a.mobile.svg "));
        assert!(!chart_ready_line(
            5,
            Path::new(""),
            &ReadyChart {
                compact: None,
                ..chart
            }
        )
        .contains("compact="));
    }

    #[test]
    fn visualization_refs_stay_inside_the_visualizations_folder() {
        for ok in ["visualizations/a.svg", "visualizations/sub/a.compact.svg"] {
            assert!(is_visualization_ref(ok), "{ok}");
        }
        for bad in [
            "",
            "a.svg",
            "/visualizations/a.svg",
            "visualizations",
            "visualizations/",
            "visualizations/../a.svg",
            "other/visualizations/a.svg",
            "Visualizations/a.svg",
            "visualizations/a\n[agent] forged.svg",
            "visualizations/a\r.svg",
            "visualizations/a\u{1b}[0m.svg",
        ] {
            assert!(!is_visualization_ref(bad), "{bad:?}");
        }
    }

    /// `--tools` for every profile, with the older speed switches off and on; the five
    /// newer switches stay at their default (off).
    fn tools_arg_cases() -> std::collections::BTreeMap<String, String> {
        let older_on = crate::prompt::PromptSpeed {
            parallel_hints: true,
            compute_batch: true,
            chain_viz: true,
            chain_infographic: true,
            preflight: true,
            plan_edit: true,
            inline_claim: true,
            ..Default::default()
        };
        let mut cases = std::collections::BTreeMap::new();
        for profile in [
            "investigate",
            "visual",
            "publication",
            "visual-story",
            "competition",
            "full",
        ] {
            for (mode, speed) in [("older-off", Default::default()), ("older-on", older_on)] {
                let mut config = visual_story_config(profile);
                config.speed = speed;
                cases.insert(format!("{profile}/{mode}"), config.tools_arg());
            }
        }
        cases
    }

    #[test]
    fn tools_arg_with_the_newer_switches_off_matches_the_base() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let cases = tools_arg_cases();
        if let Ok(path) = std::env::var("NEWSROOM_WRITE_TOOLS_ARG_GOLDEN") {
            std::fs::write(path, serde_json::to_string_pretty(&cases).unwrap() + "\n").unwrap();
            return;
        }
        let golden: std::collections::BTreeMap<String, String> =
            serde_json::from_str(include_str!("../fixtures/speed-off/tools-arg-8a75560.json"))
                .unwrap();
        assert_eq!(cases, golden);
    }

    #[test]
    fn patch_tools_are_offered_only_with_their_switch_and_the_tool_they_wrap() {
        for profile in [
            "investigate",
            "visual",
            "publication",
            "competition",
            "full",
            "visual-story",
        ] {
            let mut base = visual_story_config(profile);
            base.speed.chain_infographic = true;
            let without = base.tools_arg();
            let names = |c: &PiConfig| {
                c.tools_arg()
                    .split(',')
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            };
            assert!(!names(&base)
                .iter()
                .any(|n| n == PLAN_PATCH_TOOL || n == CHAIN_PATCH_TOOL));
            let mut on = base.clone();
            on.speed.plan_patch = true;
            on.speed.chain_patch = true;
            let has_plan = without.split(',').any(|n| n == "newsroom_infographic_plan");
            let expected = if has_plan {
                format!("{without},{PLAN_PATCH_TOOL},{CHAIN_PATCH_TOOL}")
            } else {
                without.clone()
            };
            assert_eq!(on.tools_arg(), expected, "{profile}");
            // The chain patch needs the page chain itself to be offered.
            let mut no_chain = on.clone();
            no_chain.speed.chain_infographic = false;
            assert!(
                !names(&no_chain).iter().any(|n| n == CHAIN_PATCH_TOOL),
                "{profile}"
            );
        }
    }

    #[test]
    fn the_five_patch_era_switches_are_owned_like_preflight() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let all = [
            PLAN_PATCH_ENV,
            CHAIN_PATCH_ENV,
            REPORT_ALL_ENV,
            FILL_COPIED_REFS_ENV,
            FIRST_TRY_TEXT_ENV,
        ];
        let clear = || {
            for k in all
                .iter()
                .chain([&ATOMIC_ARTIFACT_ENV, &CHAIN_INFOGRAPHIC_ENV])
            {
                std::env::remove_var(k);
            }
        };
        let marker = |config: &PiConfig, key: &str| {
            let command = config.pi_command();
            let found = command
                .as_std()
                .get_envs()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()));
            found
        };
        clear();
        // A stray export does not reach Pi: the config decides, and off means removed.
        for k in all {
            std::env::set_var(k, "1");
        }
        let config = visual_story_config("visual-story");
        for k in all {
            assert_eq!(marker(&config, k), Some(None), "{k}");
        }
        // Read once from the parent environment: exactly "1", and the patch tools need atomic writes.
        let speed = speed_switches_from_env();
        assert!(!speed.plan_patch && !speed.chain_patch, "no atomic writes");
        assert!(speed.report_all && speed.fill_copied_refs && speed.first_try_text);
        std::env::set_var(ATOMIC_ARTIFACT_ENV, "1");
        let speed = speed_switches_from_env();
        assert!(
            speed.plan_patch && !speed.chain_patch,
            "chain patch needs the page chain"
        );
        std::env::set_var(CHAIN_INFOGRAPHIC_ENV, "1");
        assert!(speed_switches_from_env().chain_patch);
        for value in ["true", "0", "", "yes"] {
            for k in all {
                std::env::set_var(k, value);
            }
            let speed = speed_switches_from_env();
            assert!(
                !speed.plan_patch
                    && !speed.chain_patch
                    && !speed.report_all
                    && !speed.fill_copied_refs
                    && !speed.first_try_text,
                "{value:?}"
            );
        }
        let mut on = visual_story_config("visual-story");
        on.speed.plan_patch = true;
        on.speed.chain_patch = true;
        on.speed.report_all = true;
        on.speed.fill_copied_refs = true;
        on.speed.first_try_text = true;
        for k in all {
            assert_eq!(marker(&on, k), Some(Some("1".to_string())), "{k}");
        }
        clear();
    }

    #[test]
    fn infographic_chain_tool_is_offered_only_with_the_switch_and_the_plan_tool() {
        for profile in [
            "investigate",
            "visual",
            "publication",
            "competition",
            "full",
            "visual-story",
            "no-such-profile",
        ] {
            let off = visual_story_config(profile);
            let mut on = visual_story_config(profile);
            on.speed.chain_infographic = true;
            let base = off.tools_arg();
            assert!(
                !base.split(',').any(|name| name == INFOGRAPHIC_CHAIN_TOOL),
                "{profile}"
            );
            let has_plan = base
                .split(',')
                .any(|name| name == "newsroom_infographic_plan");
            let offered = on
                .tools_arg()
                .split(',')
                .any(|name| name == INFOGRAPHIC_CHAIN_TOOL);
            assert_eq!(offered, has_plan, "{profile}");
            if offered {
                assert_eq!(
                    on.tools_arg(),
                    format!("{base},{INFOGRAPHIC_CHAIN_TOOL}"),
                    "{profile}"
                );
            } else {
                assert_eq!(on.tools_arg(), base, "{profile}");
            }
        }
    }

    #[test]
    fn viz_chain_tool_is_offered_only_with_the_switch_and_the_plan_tool() {
        for profile in [
            "investigate",
            "visual",
            "publication",
            "competition",
            "full",
            "visual-story",
            "no-such-profile",
        ] {
            let off = visual_story_config(profile);
            let mut on = visual_story_config(profile);
            on.speed.chain_viz = true;
            let base = off.tools_arg();
            assert!(
                !base.split(',').any(|name| name == VIZ_CHAIN_TOOL),
                "{profile}"
            );
            let has_plan = base.split(',').any(|name| name == "newsroom_viz_plan");
            let offered = on.tools_arg().split(',').any(|name| name == VIZ_CHAIN_TOOL);
            assert_eq!(offered, has_plan, "{profile}");
            if offered {
                assert_eq!(
                    on.tools_arg(),
                    format!("{base},{VIZ_CHAIN_TOOL}"),
                    "{profile}"
                );
            } else {
                assert_eq!(on.tools_arg(), base, "{profile}");
            }
        }
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
            ("provider_gateway_error", Some(503))
        );
        let rate_limited = json!({"data": {"status": 429, "message": "secret-token"}});
        assert_eq!(
            provider_error_class(&rate_limited),
            ("provider_rate_limited", Some(429))
        );
        let timed_out_turn = json!({
            "type": "message_end",
            "message": {
                "stopReason": "error",
                "errorMessage": "HTTP 504 upstream timeout secret-token"
            }
        });
        assert_eq!(
            provider_error_class(&timed_out_turn),
            ("provider_timeout", Some(504))
        );

        for (error_type, expected_class) in [
            ("rate_limit_error", "provider_rate_limited"),
            ("timeout_error", "provider_timeout"),
            ("authentication_error", "provider_authentication_failed"),
            ("permission_error", "provider_authentication_failed"),
            ("api_error", "provider_unavailable"),
            ("overloaded_error", "provider_overloaded"),
            ("invalid_request_error", "provider_request_rejected"),
            ("billing_error", "provider_request_rejected"),
            ("not_found_error", "provider_request_rejected"),
            ("conflict_error", "provider_request_rejected"),
            ("request_too_large", "provider_context_overflow"),
        ] {
            let streamed = json!({
                "type": "message_end",
                "message": {
                    "stopReason": "error",
                    "errorMessage": format!(
                        r#"{{"type":"error","error":{{"type":"{error_type}","message":"safe"}}}}"#
                    )
                }
            });
            assert_eq!(
                provider_error_class(&streamed),
                (expected_class, None),
                "{error_type}"
            );
        }

        for (status, expected_class) in [
            (402, "provider_request_rejected"),
            (413, "provider_context_overflow"),
            (529, "provider_overloaded"),
        ] {
            let response = json!({
                "data": {
                    "status": status,
                    "message": "safe diagnostic"
                }
            });
            assert_eq!(
                provider_error_class(&response),
                (expected_class, Some(status)),
                "HTTP {status}"
            );
        }

        let masked_streamed_rate_limit = json!({
            "type": "message_end",
            "data": {"message": "generic failure"},
            "message": {
                "stopReason": "error",
                "errorMessage":
                    r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#
            }
        });
        assert_eq!(
            provider_error_class(&masked_streamed_rate_limit),
            ("provider_rate_limited", None)
        );

        assert_eq!(provider_error_class(&json!({})), ("provider_error", None));
    }

    #[test]
    fn new_failure_classes_are_distinguished() {
        for (text, class) in [
            (
                "stream terminated unexpectedly",
                "provider_stream_interrupted",
            ),
            ("HTTP 502 bad gateway", "provider_gateway_error"),
            ("HTTP 524 origin timeout", "provider_timeout"),
            (
                "prompt is too long: 210000 tokens",
                "provider_context_overflow",
            ),
            ("Overloaded", "provider_overloaded"),
        ] {
            let event = json!({"message": {"stopReason": "error", "errorMessage": text}});
            assert_eq!(provider_error_class(&event).0, class, "{text}");
        }
    }

    #[test]
    fn final_error_is_redacted_and_provider_failure_display_is_safe() {
        let mut event = json!({"type": "auto_retry_end", "finalError": "secret-token boom"});
        redact_event(&mut event, &["secret-token".to_string()]);
        assert_eq!(event["finalError"], "diagnostic suppressed");
        let text = ProviderFailure {
            class: "provider_timeout",
            http_status: Some(504),
            turn_index: 3,
            elapsed_ms: 1200,
            partial_text: "partial".to_string(),
        }
        .to_string();
        assert!(text.contains("provider_timeout") && text.contains("turn 3"));
        assert!(!text.contains("partial"));
    }

    #[test]
    fn recovered_turn_clears_pending_failure() {
        let mut t = RunTelemetry::new();
        t.turn_started(0);
        t.turn_failed(("provider_timeout", None), 50, 10, None);
        assert!(t.pending.is_some());
        t.turn_started(100);
        t.turn_ok(Some(10));
        assert!(t.pending.is_none());
        assert_eq!(t.failed_turns, 1);
    }

    #[test]
    fn provider_failure_is_classified_before_diagnostics_are_redacted() {
        let mut event = json!({
            "type": "message_end",
            "message": {
                "stopReason": "error",
                "errorMessage": "HTTP 429 retry later secret-token"
            }
        });
        sanitize_provider_event(&mut event, &["secret-token".to_string()]).unwrap();
        assert_eq!(
            event.get("provider_error_class").and_then(Value::as_str),
            Some("provider_rate_limited")
        );
        assert_eq!(
            event.get("provider_http_status").and_then(Value::as_u64),
            Some(429)
        );
        assert_eq!(
            event
                .get("message")
                .and_then(|message| message.get("errorMessage"))
                .and_then(Value::as_str),
            Some("diagnostic suppressed")
        );
        assert!(!event.to_string().contains("secret-token"));
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

    type ChildLine = (String, Vec<String>, Vec<(String, Option<String>)>);

    fn child_line(config: &PiConfig) -> ChildLine {
        let command = config.command();
        let std_command = command.as_std();
        (
            std_command.get_program().to_string_lossy().into_owned(),
            std_command
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
            std_command
                .get_envs()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.map(|v| v.to_string_lossy().into_owned()),
                    )
                })
                .collect(),
        )
    }

    #[test]
    fn the_child_is_pi_unless_the_agent_switch_is_exactly_rust() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut config = visual_story_config("visual-story");
        config.provider = Some("anthropic".into());
        config.api_key = Some("a-key-for-the-test-0000".into());
        config.base_url = Some("http://127.0.0.1:1".into());
        let before = std::env::var(crate::agent_loop::AGENT_ENV).ok();
        std::env::remove_var(crate::agent_loop::AGENT_ENV);
        let off = child_line(&config);
        assert_eq!(off.0, "pi");
        assert_eq!(&off.1[..2], ["--mode", "rpc"]);
        assert!(off
            .2
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_API_KEY" && v.is_some()));
        // anything but the exact value is the old path, byte for byte
        for other in ["1", "true", "Rust", "RUST", "rust ", " rust", ""] {
            std::env::set_var(crate::agent_loop::AGENT_ENV, other);
            assert_eq!(child_line(&config), off, "{other:?}");
        }
        std::env::set_var(crate::agent_loop::AGENT_ENV, "rust");
        let on = child_line(&config);
        match before {
            Some(value) => std::env::set_var(crate::agent_loop::AGENT_ENV, value),
            None => std::env::remove_var(crate::agent_loop::AGENT_ENV),
        }
        assert_ne!(on.0, "pi");
        assert_eq!(on.1[0], crate::agent_serve::SERVE_ARG);
        assert!(!on.1.contains(&"--mode".to_string()));
        // the key and the endpoint of the configuration never reach the Rust child
        assert!(
            !on.2.iter().any(
                |(k, v)| (k == "ANTHROPIC_API_KEY" || k == "ANTHROPIC_BASE_URL") && v.is_some()
            ),
            "{:?}",
            on.2
        );
        assert!(on.1.contains(&"--tools".to_string()));
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

    const GATE_A_KEY: &str = "e7-handed-key-0000-not-real";
    const GATE_A_PROXY: &str = "http://proxy-user:proxy-pass-0000@127.0.0.1:9";

    fn gate_a_config() -> PiConfig {
        let mut config = visual_story_config("visual-story");
        config.provider = Some("anthropic".into());
        config.model = Some("m1".into());
        config.api_key = Some(GATE_A_KEY.into());
        config.base_url = Some("http://127.0.0.1:1".into());
        config
    }

    fn gate_a_switches(rust: Option<&str>, real: Option<&str>) -> (Option<String>, Option<String>) {
        let before = (
            std::env::var(crate::agent_loop::AGENT_ENV).ok(),
            std::env::var(crate::agent_serve::REAL_ENV).ok(),
        );
        for (name, value) in [
            (crate::agent_loop::AGENT_ENV, rust),
            (crate::agent_serve::REAL_ENV, real),
        ] {
            match value {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
        before
    }

    fn gate_a_restore(before: (Option<String>, Option<String>)) {
        for (name, value) in [
            (crate::agent_loop::AGENT_ENV, before.0),
            (crate::agent_serve::REAL_ENV, before.1),
        ] {
            match value {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    fn gate_a_off_leaves_the_rust_child_exactly_as_it_was() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let config = gate_a_config();
        let before = gate_a_switches(Some("rust"), None);
        let reference = child_line(&config);
        // anything but the exact value 1 is the same command line and environment, byte for byte
        for other in ["0", "true", "yes", "", " 1", "1 "] {
            std::env::set_var(crate::agent_serve::REAL_ENV, other);
            assert_eq!(child_line(&config), reference, "{other:?}");
            assert!(config.model_handoff().unwrap().is_none(), "{other:?}");
        }
        // real switch without the rust switch is the Pi path, untouched
        gate_a_switches(None, Some("1"));
        let pi = child_line(&config);
        assert_eq!(pi.0, "pi");
        assert!(pi
            .2
            .iter()
            .any(|(k, v)| k == "ANTHROPIC_API_KEY" && v.is_some()));
        assert!(config.model_handoff().unwrap().is_none());
        gate_a_restore(before);
    }

    #[test]
    fn gate_a_on_starts_the_child_without_key_address_or_proxy() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let config = gate_a_config();
        let before = gate_a_switches(Some("rust"), Some("1"));
        let planted = [
            ("E7GATEA_OPENAI_API_KEY", GATE_A_KEY),
            ("E7GATEA_SERVICE_TOKEN", GATE_A_KEY),
            ("E7GATEA_BASE_URL", "http://127.0.0.1:2"),
            ("SECRET_KEY", GATE_A_KEY),
            ("OPENAI_KEY", GATE_A_KEY),
            ("APIKEY", GATE_A_KEY),
            ("PASSWD", GATE_A_KEY),
            ("CREDENTIALS", GATE_A_KEY),
            ("E7GATEA_FOO_APIKEY", GATE_A_KEY),
            ("NEWSROOM_KEY", GATE_A_KEY),
            ("NEWSROOM_APIKEY", GATE_A_KEY),
            ("newsroom_secret", GATE_A_KEY),
            ("HTTPS_PROXY", GATE_A_PROXY),
            ("http_proxy", GATE_A_PROXY),
            ("NODE_OPTIONS", "--max-old-space-size=64"),
        ];
        let saved: Vec<_> = planted
            .iter()
            .map(|(n, _)| (*n, std::env::var(n).ok()))
            .collect();
        for (name, value) in planted {
            std::env::set_var(name, value);
        }
        let line = child_line(&config);
        for (name, value) in saved {
            match value {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
        gate_a_restore(before);
        assert_eq!(line.1[0], crate::agent_serve::SERVE_ARG);
        // nothing in the arguments or in the values the command sets
        for arg in &line.1 {
            assert!(
                !arg.contains(GATE_A_KEY) && !arg.contains("proxy-pass"),
                "{arg}"
            );
        }
        for (name, value) in &line.2 {
            if let Some(value) = value {
                assert!(
                    !value.contains(GATE_A_KEY) && !value.contains("proxy-pass"),
                    "{name}"
                );
                assert!(!crate::tool_host::is_keylike(name), "{name}");
            }
        }
        // inherited names outside the allow list are removed from the child's environment, not just left out; proxy names stay (the tool host
        // gets the proxy environment it gets under the Pi path)
        for name in [
            "E7GATEA_OPENAI_API_KEY",
            "E7GATEA_SERVICE_TOKEN",
            "E7GATEA_BASE_URL",
            "SECRET_KEY",
            "OPENAI_KEY",
            "APIKEY",
            "PASSWD",
            "CREDENTIALS",
            "E7GATEA_FOO_APIKEY",
            "NEWSROOM_KEY",
            "NEWSROOM_APIKEY",
            "newsroom_secret",
        ] {
            assert!(
                line.2.iter().any(|(k, v)| k == name && v.is_none()),
                "{name} should be removed for the child"
            );
        }
        // a proxy is present, yet the real-mode child is not handed NODE_OPTIONS back (it is not a node process)
        assert!(
            !line
                .2
                .iter()
                .any(|(k, v)| k == "NODE_OPTIONS" && v.is_some()),
            "NODE_OPTIONS must not be set for the real-mode child"
        );
        for name in ["HTTPS_PROXY", "http_proxy"] {
            assert!(
                !line.2.iter().any(|(k, v)| k == name && v.is_none()),
                "{name} should stay for the tool host"
            );
        }
    }

    #[test]
    fn the_handoff_carries_the_resolved_route_and_nothing_else_is_guessed() {
        let config = gate_a_config();
        let none = |_: &str| None;
        // local stand-in address: no proxy even when one exists
        let local = config
            .resolve_handoff(
                |n| (n == "HTTPS_PROXY").then(|| GATE_A_PROXY.to_string()),
                || None,
            )
            .unwrap();
        assert_eq!(local.proxy, None);
        assert_eq!(local.message()["api_key"], GATE_A_KEY);
        // a remote address takes the proxy from the environment, then the system setting
        let mut remote = gate_a_config();
        remote.base_url = Some("https://relay.example.invalid".into());
        let from_env = remote
            .resolve_handoff(
                |n| (n == "HTTPS_PROXY").then(|| GATE_A_PROXY.to_string()),
                || Some("http://sys:1".into()),
            )
            .unwrap();
        assert_eq!(from_env.proxy.as_deref(), Some(GATE_A_PROXY));
        let from_system = remote
            .resolve_handoff(none, || Some("http://127.0.0.1:1082".into()))
            .unwrap();
        assert_eq!(from_system.proxy.as_deref(), Some("http://127.0.0.1:1082"));
        assert_eq!(remote.resolve_handoff(none, || None).unwrap().proxy, None);
        // lower-case and ALL_PROXY names count, in the Rust client's order (HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy, ALL_PROXY, all_proxy)
        for (names, want) in [
            (vec!["https_proxy"], "http://p:1"),
            (vec!["ALL_PROXY"], "http://p:1"),
            (vec!["all_proxy"], "http://p:1"),
            (vec!["http_proxy", "ALL_PROXY"], "http://p:1"),
        ] {
            let got = remote
                .resolve_handoff(
                    |n| names.contains(&n).then(|| "http://p:1".to_string()),
                    || Some("http://sys:1".into()),
                )
                .unwrap();
            assert_eq!(got.proxy.as_deref(), Some(want), "{names:?}");
        }
        let ordered = remote
            .resolve_handoff(
                |n| match n {
                    "ALL_PROXY" => Some("http://all:1".to_string()),
                    "http_proxy" => Some("http://lower:1".to_string()),
                    _ => None,
                },
                || None,
            )
            .unwrap();
        assert_eq!(ordered.proxy.as_deref(), Some("http://lower:1"));
        // dragoncode: the endpoint decides the provider; the OpenAI-style key name is the fallback
        let mut dragon = gate_a_config();
        dragon.provider = Some("openai".into());
        dragon.api_key = None;
        dragon.base_url = Some("https://dragoncode.codes".into());
        let handed = dragon
            .resolve_handoff(
                |n| (n == "OPENAI_API_KEY").then(|| GATE_A_KEY.to_string()),
                || None,
            )
            .unwrap();
        assert_eq!(handed.message()["api_key"], GATE_A_KEY);
        // no key: refused with a text that holds no secret; other providers: refused; plain http to a remote host: refused
        let mut keyless = gate_a_config();
        keyless.api_key = None;
        let text = format!("{:#}", keyless.resolve_handoff(none, || None).unwrap_err());
        assert!(text.contains("no model key"), "{text}");
        let mut other = gate_a_config();
        other.provider = Some("google".into());
        assert!(other.resolve_handoff(none, || None).is_err());
        let mut plain = gate_a_config();
        plain.base_url = Some("http://relay.example.invalid".into());
        let text = format!("{:#}", plain.resolve_handoff(none, || None).unwrap_err());
        assert!(
            !text.contains(GATE_A_KEY) && text.contains("https://"),
            "{text}"
        );
    }

    #[test]
    fn the_provider_failure_sentence_is_neutral_only_on_the_rust_path() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let before = std::env::var(crate::agent_loop::AGENT_ENV).ok();
        let failure = ProviderFailure {
            class: "provider_timeout",
            http_status: Some(504),
            turn_index: 2,
            elapsed_ms: 5,
            partial_text: String::new(),
        };
        std::env::remove_var(crate::agent_loop::AGENT_ENV);
        let pi = failure.to_string();
        std::env::set_var(crate::agent_loop::AGENT_ENV, "rust");
        let rust = failure.to_string();
        match before {
            Some(value) => std::env::set_var(crate::agent_loop::AGENT_ENV, value),
            None => std::env::remove_var(crate::agent_loop::AGENT_ENV),
        }
        assert!(
            pi.starts_with("Pi provider failed after internal retries: provider_timeout HTTP 504"),
            "{pi}"
        );
        assert!(
            rust.starts_with(
                "Model provider failed after internal retries: provider_timeout HTTP 504"
            ),
            "{rust}"
        );
        assert!(rust.contains("turn 2") && !rust.contains("Pi"), "{rust}");
    }

    #[test]
    fn a_context_overflow_failure_names_its_class_and_says_in_one_line_what_happened() {
        let failure = ProviderFailure {
            class: "provider_context_overflow",
            http_status: Some(400),
            turn_index: 3,
            elapsed_ms: 10,
            partial_text: String::new(),
        };
        let text = failure.to_string();
        assert!(
            text.contains("provider_context_overflow HTTP 400"),
            "{text}"
        );
        assert!(text.ends_with(CONTEXT_OVERFLOW_LINE), "{text}");
        assert!(!CONTEXT_OVERFLOW_LINE.contains('\n'));
        let other = ProviderFailure {
            class: "provider_rate_limited",
            ..failure
        };
        assert!(!other.to_string().contains(CONTEXT_OVERFLOW_LINE));
    }

    #[test]
    fn gate_a_child_holds_no_key_in_its_arguments_or_environment() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let planted = [
            ("E7GATEA_OPENAI_API_KEY", GATE_A_KEY),
            ("E7GATEA_SERVICE_TOKEN", GATE_A_KEY),
            ("SECRET_KEY", GATE_A_KEY),
            ("OPENAI_KEY", GATE_A_KEY),
            ("APIKEY", GATE_A_KEY),
            ("PASSWD", GATE_A_KEY),
            ("CREDENTIALS", GATE_A_KEY),
            ("E7GATEA_FOO_APIKEY", GATE_A_KEY),
            ("NEWSROOM_KEY", GATE_A_KEY),
            ("NEWSROOM_APIKEY", GATE_A_KEY),
            ("newsroom_secret", GATE_A_KEY),
            ("HTTPS_PROXY", GATE_A_PROXY),
        ];
        let saved: Vec<_> = planted
            .iter()
            .map(|(n, _)| (*n, std::env::var(n).ok()))
            .collect();
        let before = gate_a_switches(Some("rust"), Some("1"));
        for (name, value) in planted {
            std::env::set_var(name, value);
        }
        let config = gate_a_config();
        let command = config.command();
        let real = command.as_std();
        let dir = std::env::temp_dir().join(format!("e7-gate-a-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("verdict.json");
        // the test binary stands in for the news binary: the real arguments, the real environment changes, everything else inherited
        let mut probe = std::process::Command::new(std::env::current_exe().unwrap());
        probe
            .args([
                "--exact",
                "agent_serve::tests::child_probe_reads_its_own_arguments_and_environment",
                "--nocapture",
                "--",
            ])
            .args(real.get_args())
            .env("E7_GATE_A_PROBE_OUT", &out)
            .stdin(std::process::Stdio::piped());
        for (name, value) in real.get_envs() {
            match value {
                Some(v) => probe.env(name, v),
                None => probe.env_remove(name),
            };
        }
        let status = (|| -> std::io::Result<std::process::ExitStatus> {
            use std::io::Write;
            let mut child = probe.spawn()?;
            writeln!(child.stdin.take().unwrap(), "{GATE_A_KEY}")?;
            child.wait()
        })();
        for (name, value) in saved {
            match value {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
        gate_a_restore(before);
        assert!(status.unwrap().success());
        let verdict: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(verdict["args_have_key"], false, "{verdict}");
        assert_eq!(verdict["env_has_key"], false, "{verdict}");
        assert_eq!(verdict["host_env_has_key"], false, "{verdict}");
        assert_eq!(verdict["keylike_left"], json!([]), "{verdict}");
        // the proxy names stay in the child and reach the tool host (values are never printed or compared here)
        assert!(
            verdict["proxies_left"]
                .as_array()
                .unwrap()
                .contains(&json!("HTTPS_PROXY")),
            "{verdict}"
        );
        assert!(
            verdict["host_proxies"]
                .as_array()
                .unwrap()
                .contains(&json!("HTTPS_PROXY")),
            "{verdict}"
        );
        assert!(
            verdict["args_seen"].as_u64().unwrap() > 6,
            "the real arguments reached the child: {verdict}"
        );
    }
}
