//! A model for the agent loop that talks the Anthropic Messages wire format (1011ad step 3, agent-spec 6 and 12). It builds one streaming
//! request from the loop's history, reads the server-sent events to the end, and hands back one assistant message in the loop's shape.
//! The address and key are given by the caller: this file reads no environment variable, no .env and no config file. Built for tests only
//! (they talk to a fake server on 127.0.0.1); nothing selects it in the product yet.
//!
//! Errors keep the provider's own words (key-redacted and bounded) so the loop can classify them with `provider_error_class`.

use crate::agent_loop::{Model, ModelRequest, Pieces};
use crate::llm::{LLMClient, Provider};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Thinking level (agent-spec 6.1). `Off` sends no thinking field at all.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Thinking {
    Off,
    Minimal,
    Low,
    Medium,
    High,
}

impl Thinking {
    /// The level's word for providers that take a named effort; `None` for `Off`.
    pub(crate) fn name(self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Minimal => Some("minimal"),
            Self::Low => Some("low"),
            Self::Medium => Some("medium"),
            Self::High => Some("high"),
        }
    }

    fn budget(self) -> Option<u64> {
        match self {
            Self::Off => None,
            Self::Minimal => Some(1024),
            Self::Low => Some(2048),
            Self::Medium => Some(8192),
            Self::High => Some(16384),
        }
    }
}

/// How thinking is switched on. The relay's support for the adaptive form is unknown, so the budget form is the default.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ThinkingField {
    Budget,
    Adaptive,
}

#[derive(Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

pub struct AnthropicConfig {
    pub base_url: String,
    api_key: String,
    pub model: String,
    pub max_tokens: u64,
    pub thinking: Thinking,
    pub thinking_field: ThinkingField,
    pub system: String,
    pub tools: Vec<ToolDef>,
    /// How long the server may stay silent (before the first byte and between chunks) before the request counts as timed out.
    pub idle_timeout: Duration,
    /// `Some(proxy)`: the route was computed by the parent and handed over (gate A); the client then reads no proxy setting of its own.
    route: Option<Option<String>>,
}

impl AnthropicConfig {
    pub fn new(base_url: &str, api_key: &str, model: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
            max_tokens: 8192,
            thinking: Thinking::Off,
            thinking_field: ThinkingField::Budget,
            system: String::new(),
            tools: Vec::new(),
            idle_timeout: Duration::from_secs(120),
            route: None,
        }
    }

    /// A copy with the same model, prompt and tools, for building the real client once the handoff has arrived. The key of the copy is empty.
    pub fn clone_template(&self) -> Self {
        Self {
            base_url: self.base_url.clone(),
            api_key: String::new(),
            model: self.model.clone(),
            max_tokens: self.max_tokens,
            thinking: self.thinking,
            thinking_field: self.thinking_field,
            system: self.system.clone(),
            tools: self.tools.clone(),
            idle_timeout: self.idle_timeout,
            route: self.route.clone(),
        }
    }

    pub fn with_key(mut self, key: &str) -> Self {
        self.api_key = key.to_string();
        self
    }

    /// Use exactly this route: the optional proxy as given, never the environment or the system settings.
    pub fn with_route(mut self, proxy: Option<String>) -> Self {
        self.route = Some(proxy);
        self
    }
}

pub struct AnthropicModel {
    config: AnthropicConfig,
    http: reqwest::Client,
    /// Only for its URL rule and key redaction; it is never asked to send anything.
    redactor: LLMClient,
}

/// The one rule for "this address is the local machine", shared by the Rust agent's start-up check and the client's no-proxy choice.
/// Only `http://`; the authority (up to the first `/`, `?` or `#`) is `127.0.0.1` or `localhost` with an optional all-digit port: no user name or
/// password (`@`), no backslash, no empty port, no IPv6 (`[::1]` is refused: the stand-in relay only listens on 127.0.0.1). The scheme and the host name are
/// compared without regard to case, as a URL does, so `HTTP://LocalHost:80` is the same address as `http://localhost:80`.
pub(crate) fn is_loopback(base_url: &str) -> bool {
    let Some((scheme, rest)) = base_url.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains(['@', '\\']) {
        return false;
    }
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    let port_ok =
        port.is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()));
    port_ok && (host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost"))
}

const EPHEMERAL: fn() -> Value = || json!({"type": "ephemeral"});

impl AnthropicModel {
    pub fn new(config: AnthropicConfig) -> Result<Self> {
        let http = if let Some(proxy) = &config.route {
            let mut builder = reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(30));
            if let Some(proxy) = proxy.as_deref().filter(|p| !p.trim().is_empty()) {
                builder =
                    builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| {
                        anyhow::anyhow!("the handed-over proxy address is not valid")
                    })?);
            }
            builder.build()?
        } else if is_loopback(&config.base_url) {
            reqwest::Client::builder().no_proxy().build()?
        } else {
            LLMClient::http_client_from(
                reqwest::Client::builder().connect_timeout(Duration::from_secs(30)),
            )?
        };
        let redactor = LLMClient::new(
            Provider::Anthropic,
            config.api_key.clone(),
            config.model.clone(),
        )
        .with_base_url(config.base_url.clone())
        .with_redacted(
            config
                .route
                .iter()
                .flatten()
                .flat_map(|p| crate::llm::proxy_secrets(p))
                .collect(),
        );
        Ok(Self {
            config,
            http,
            redactor,
        })
    }

    /// The streaming request body for this history: stable tool order, cache marks on the last system block, the last tool and the last
    /// user block, and the thinking field only when a level is set.
    fn request_body(&self, history: &[Value]) -> Value {
        let config = &self.config;
        let mut max_tokens = config.max_tokens;
        let mut body = json!({"model": config.model, "stream": true});
        match (config.thinking.budget(), config.thinking_field) {
            (Some(budget), ThinkingField::Budget) => {
                if max_tokens <= budget {
                    max_tokens = budget + 4096;
                }
                body["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
            }
            (Some(_), ThinkingField::Adaptive) => body["thinking"] = json!({"type": "adaptive"}),
            (None, _) => {}
        }
        body["max_tokens"] = json!(max_tokens);
        if !config.system.is_empty() {
            body["system"] =
                json!([{"type": "text", "text": config.system, "cache_control": EPHEMERAL()}]);
        }
        let mut tools: Vec<&ToolDef> = config.tools.iter().collect();
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        let mut wire_tools: Vec<Value> = tools
            .iter()
            .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.parameters}))
            .collect();
        if let Some(last) = wire_tools.last_mut() {
            last["cache_control"] = EPHEMERAL();
        }
        if !wire_tools.is_empty() {
            body["tools"] = json!(wire_tools);
        }
        let mut messages = wire_messages(
            history,
            images_enabled(std::env::var(TOOL_RESULT_IMAGES_ENV).ok().as_deref()),
        );
        if let Some(block) = messages
            .last_mut()
            .filter(|m| m["role"] == "user")
            .and_then(|m| m["content"].as_array_mut())
            .and_then(|blocks| blocks.last_mut())
        {
            block["cache_control"] = EPHEMERAL();
        }
        body["messages"] = json!(messages);
        body
    }

    async fn exchange(&self, history: &[Value], cancel: &AtomicBool, pieces: Pieces<'_>) -> Value {
        let config = &self.config;
        let mut stream = StreamState::default();
        let request = self
            .http
            .post(self.redactor.anthropic_messages_url())
            .header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&self.request_body(history));
        let read = read_events(
            request,
            &self.redactor,
            config.idle_timeout,
            cancel,
            |event| {
                let step = stream.apply(&event);
                for piece in std::mem::take(&mut stream.pieces) {
                    pieces(piece, stream.usage());
                }
                step
            },
        )
        .await;
        match read {
            Read::Done => stream.finish(config, Ending::Complete),
            Read::Aborted => stream.finish(config, Ending::Aborted),
            Read::Failed(text) => stream.finish(config, Ending::Failed(text)),
            Read::Closed => {
                let text =
                    "upstream stream ended early: no message_stop before the connection closed";
                stream.finish(config, Ending::Failed(text.to_string()))
            }
        }
    }
}

/// How reading one streamed reply ended.
pub(crate) enum Read {
    Done,
    Aborted,
    Failed(String),
    /// The connection closed with no end marker; the caller decides whether what arrived is complete.
    Closed,
}

/// Sends `request` (as an event stream) and feeds every server-sent event's JSON data to `on_event` until it says `Done` or `Error`.
/// Non-2xx answers, transport failures, silence longer than `idle` and an abort all end as a `Read` with the provider's own words,
/// key-redacted. Data that is not JSON (keep-alives) is skipped.
pub(crate) async fn read_events(
    request: reqwest::RequestBuilder,
    redactor: &LLMClient,
    idle: Duration,
    cancel: &AtomicBool,
    on_event: impl FnMut(Value) -> Step,
) -> Read {
    read_blocks(request, redactor, idle, cancel, sse_data, on_event).await
}

/// Like `read_events`, with the block parser chosen by the caller (a parser that returns `None` skips the block).
pub(crate) async fn read_blocks(
    request: reqwest::RequestBuilder,
    redactor: &LLMClient,
    idle: Duration,
    cancel: &AtomicBool,
    parse: impl Fn(&str) -> Option<Value>,
    mut on_event: impl FnMut(Value) -> Step,
) -> Read {
    let transport = |error: &reqwest::Error| {
        let text = redactor.safe_provider_error(error.to_string());
        let lower = text.to_ascii_lowercase();
        if error.is_timeout() {
            format!("request timed out: {text}")
        } else if lower.contains("dns") || lower.contains("lookup") {
            text
        } else {
            format!("connection error: {text}")
        }
    };
    let sent = request.header("accept", "text/event-stream").send();
    let mut response = match watch(tokio::time::timeout(idle, sent), cancel).await {
        None => return Read::Aborted,
        Some(Err(_)) => return Read::Failed(timeout_text(idle)),
        Some(Ok(Err(error))) => return Read::Failed(transport(&error)),
        Some(Ok(Ok(response))) => response,
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = match watch(response.text(), cancel).await {
            None => return Read::Aborted,
            Some(text) => text.unwrap_or_default(),
        };
        return Read::Failed(redactor.safe_provider_error(format!("HTTP {status}: {body}")));
    }
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match watch(tokio::time::timeout(idle, response.chunk()), cancel).await {
            None => return Read::Aborted,
            Some(Err(_)) => return Read::Failed(timeout_text(idle)),
            Some(Ok(Err(error))) => return Read::Failed(transport(&error)),
            Some(Ok(Ok(None))) => return Read::Closed,
            Some(Ok(Ok(Some(chunk)))) => {
                pending.extend(chunk.iter().filter(|b| **b != b'\r'));
                while let Some(at) = pending.windows(2).position(|w| w == b"\n\n") {
                    let raw: Vec<u8> = pending.drain(..at + 2).collect();
                    let Some(event) = parse(&String::from_utf8_lossy(&raw)) else {
                        continue;
                    };
                    match on_event(event) {
                        Step::More => {}
                        Step::Done => return Read::Done,
                        Step::Error(text) => {
                            return Read::Failed(redactor.safe_provider_error(text))
                        }
                    }
                }
            }
        }
    }
}

#[async_trait]
impl Model for AnthropicModel {
    async fn respond(
        &mut self,
        request: &ModelRequest<'_>,
        cancel: &AtomicBool,
        pieces: Pieces<'_>,
    ) -> Option<Value> {
        Some(self.exchange(request.history, cancel, pieces).await)
    }
}

pub(crate) fn timeout_text(idle: Duration) -> String {
    format!(
        "request timed out: no data from the upstream within {} ms",
        idle.as_millis()
    )
}

/// Polls `cancel` every 25 ms while `work` runs; `None` means the abort came first.
pub(crate) async fn watch<F: Future>(work: F, cancel: &AtomicBool) -> Option<F::Output> {
    tokio::pin!(work);
    loop {
        tokio::select! {
            done = &mut work => return Some(done),
            () = tokio::time::sleep(Duration::from_millis(25)) => {
                if cancel.load(Ordering::SeqCst) {
                    return None;
                }
            }
        }
    }
}

/// The data payload of one server-sent event, parsed; `None` for comments, keep-alives and anything that is not JSON.
pub(crate) fn sse_data(block: &str) -> Option<Value> {
    let data: Vec<&str> = block
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect();
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&data.join("\n")).ok()
}

pub(crate) fn text_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::String(text) if !text.is_empty() => vec![json!({"type": "text", "text": text})],
        Value::Array(list) => list
            .iter()
            .filter(|b| b["type"] == "text" && b["text"].as_str().is_some_and(|t| !t.is_empty()))
            .map(|b| json!({"type": "text", "text": b["text"]}))
            .collect(),
        _ => vec![],
    }
}

/// Switch for sending images that tools return. Only the exact value `1` turns it on; it is off by default, and then a tool result
/// goes out as text only, as before. It governs this Anthropic path only: `openai_model.rs` has no image path and is not touched.
pub const TOOL_RESULT_IMAGES_ENV: &str = "NEWSROOM_TOOL_RESULT_IMAGES";
/// Largest image a tool result may carry to the model, decoded.
const MAX_IMAGE_BYTES: usize = 3 * 1024 * 1024;
/// Total base64 text of the images sent in one run, counted in history order like the count above; it keeps the whole request body
/// well under the API's request size limit.
const MAX_IMAGE_BASE64_TOTAL: usize = 20 * 1024 * 1024;
/// Images sent in one run, counted in the order they appear in the history. The 21st and later become a text note. An image that is
/// already sent is never removed or changed, so each request stays an exact extension of the one before it and the cache holds.
const MAX_IMAGES_PER_RUN: usize = 20;

pub(crate) fn images_enabled(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Decoded size of a standard base64 string, or `None` if it is not well formed.
fn base64_decoded_len(data: &str) -> Option<usize> {
    let bytes = data.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let pad = bytes.iter().rev().take_while(|&&b| b == b'=').count();
    if pad > 2 {
        return None;
    }
    let body = &bytes[..bytes.len() - pad];
    if !body
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/')
    {
        return None;
    }
    Some(bytes.len() / 4 * 3 - pad)
}

/// One image block of a tool result as a wire block, or the reason it is not sent.
fn wire_image(block: &Value, sent: (usize, usize)) -> Result<Value, &'static str> {
    let media = block["mimeType"].as_str().unwrap_or("");
    if !matches!(
        media,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err("unsupported image type");
    }
    let Some(data) = block["data"].as_str() else {
        return Err("no image data");
    };
    let Some(size) = base64_decoded_len(data) else {
        return Err("image data is not valid base64");
    };
    if size > MAX_IMAGE_BYTES {
        return Err("image is larger than 3 MiB");
    }
    // The first bytes of the file must match the type it claims: an image the API would reject can never be taken back out.
    let magic: &[&str] = match media {
        "image/png" => &["iVBORw0KGgo"],
        "image/jpeg" => &["/9j/"],
        "image/gif" => &["R0lGODdh", "R0lGODlh"],
        _ => &["UklGR"],
    };
    if !magic.iter().any(|m| data.starts_with(m)) {
        return Err("image bytes do not match the type");
    }
    if sent.0 >= MAX_IMAGES_PER_RUN {
        return Err("run image limit of 20 reached");
    }
    if sent.1 + data.len() > MAX_IMAGE_BASE64_TOTAL {
        return Err("run image size limit reached");
    }
    Ok(json!({"type": "image", "source": {"type": "base64", "media_type": media, "data": data}}))
}

/// Content of a tool_result with images: the text, then a `[image not sent: reason]` note for each image that does not pass, then the
/// images that do. With no text and no note, `(see attached image)` comes first. `sent` is the count and the base64 length of the
/// images sent so far in the run, from the start of the history.
fn tool_result_content(content: &Value, sent: &mut (usize, usize)) -> Vec<Value> {
    let mut out = text_blocks(content);
    let mut images = Vec::new();
    for block in content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "image")
    {
        match wire_image(block, *sent) {
            Ok(image) => {
                sent.0 += 1;
                sent.1 += block["data"].as_str().map_or(0, str::len);
                images.push(image);
            }
            Err(reason) => {
                out.push(json!({"type": "text", "text": format!("[image not sent: {reason}]")}))
            }
        }
    }
    if !images.is_empty() && out.is_empty() {
        out.push(json!({"type": "text", "text": "(see attached image)"}));
    }
    out.extend(images);
    out
}

/// The loop's history as Messages-format messages. Failed and aborted replies are left out, a thinking block goes back with its
/// signature (and is dropped without one), and consecutive tool results share one user message.
fn wire_messages(history: &[Value], images: bool) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut images_sent = (0, 0);
    let mut results_open = false;
    for message in history {
        match message["role"].as_str().unwrap_or("") {
            "user" => {
                results_open = false;
                let blocks = text_blocks(&message["content"]);
                if !blocks.is_empty() {
                    out.push(json!({"role": "user", "content": blocks}));
                }
            }
            "assistant" => {
                results_open = false;
                if matches!(message["stopReason"].as_str(), Some("error" | "aborted")) {
                    continue;
                }
                let mut blocks = Vec::new();
                for block in message["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") if block["text"].as_str().is_some_and(|t| !t.is_empty()) => {
                            blocks.push(json!({"type": "text", "text": block["text"]}));
                        }
                        Some("thinking") if block["signature"].as_str().is_some() => {
                            blocks.push(json!({"type": "thinking", "thinking": block["thinking"], "signature": block["signature"]}));
                        }
                        Some("toolCall") => {
                            blocks.push(json!({"type": "tool_use", "id": block["id"], "name": block["name"], "input": block["arguments"]}));
                        }
                        _ => {}
                    }
                }
                if !blocks.is_empty() {
                    out.push(json!({"role": "assistant", "content": blocks}));
                }
            }
            "toolResult" => {
                let mut block =
                    json!({"type": "tool_result", "tool_use_id": message["toolCallId"]});
                let content = if images {
                    tool_result_content(&message["content"], &mut images_sent)
                } else {
                    text_blocks(&message["content"])
                };
                if !content.is_empty() {
                    block["content"] = json!(content);
                }
                if message["isError"] == true {
                    block["is_error"] = json!(true);
                }
                match out.last_mut().filter(|_| results_open) {
                    Some(last) => last["content"].as_array_mut().unwrap().push(block),
                    None => out.push(json!({"role": "user", "content": [block]})),
                }
                results_open = true;
            }
            _ => {}
        }
    }
    out
}

enum Block {
    Text(String),
    Thinking {
        text: String,
        signature: String,
    },
    Tool {
        id: String,
        name: String,
        input: String,
    },
}

pub(crate) enum Step {
    More,
    Done,
    Error(String),
}

enum Ending {
    Complete,
    Aborted,
    Failed(String),
}

#[derive(Default)]
struct StreamState {
    blocks: BTreeMap<u64, Block>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    stop_reason: Option<String>,
    /// Increments the last `apply` produced, for the caller to hand over at once.
    pieces: Vec<Value>,
}

impl StreamState {
    fn usage(&self) -> Value {
        json!({"input": self.input, "output": self.output, "cacheRead": self.cache_read, "cacheWrite": self.cache_write,
               "totalTokens": self.input + self.output + self.cache_read + self.cache_write})
    }

    fn take_usage(&mut self, usage: &Value) {
        let number = |key: &str| usage.get(key).and_then(Value::as_u64);
        self.input = number("input_tokens").unwrap_or(self.input);
        self.output = number("output_tokens").unwrap_or(self.output);
        self.cache_read = number("cache_read_input_tokens").unwrap_or(self.cache_read);
        self.cache_write = number("cache_creation_input_tokens").unwrap_or(self.cache_write);
    }

    fn apply(&mut self, event: &Value) -> Step {
        let index = event["index"].as_u64().unwrap_or(0);
        match event["type"].as_str().unwrap_or("") {
            "message_start" => self.take_usage(&event["message"]["usage"]),
            "content_block_start" => {
                let start = &event["content_block"];
                let text = |key: &str| start[key].as_str().unwrap_or("").to_string();
                let block = match start["type"].as_str() {
                    Some("text") => Some(Block::Text(text("text"))),
                    Some("thinking") => Some(Block::Thinking {
                        text: text("thinking"),
                        signature: String::new(),
                    }),
                    Some("tool_use") => Some(Block::Tool {
                        id: text("id"),
                        name: text("name"),
                        input: String::new(),
                    }),
                    _ => None,
                };
                if let Some(block) = block {
                    let (kind, first) = match &block {
                        Block::Text(text) => ("text", text.clone()),
                        Block::Thinking { text, .. } => ("thinking", text.clone()),
                        Block::Tool { .. } => ("toolcall", String::new()),
                    };
                    self.pieces.push(match &block {
                        Block::Tool { id, name, .. } => {
                            json!({"type": "toolcall_start", "contentIndex": index, "id": id, "toolName": name})
                        }
                        _ => json!({"type": format!("{kind}_start"), "contentIndex": index}),
                    });
                    if !first.is_empty() {
                        self.pieces.push(json!({"type": format!("{kind}_delta"), "contentIndex": index, "delta": first}));
                    }
                    self.blocks.insert(index, block);
                }
            }
            "content_block_delta" => {
                let delta = &event["delta"];
                let piece = |key: &str| delta[key].as_str().unwrap_or("");
                let mut give = |kind: &str, text: &str| {
                    self.pieces.push(json!({"type": format!("{kind}_delta"), "contentIndex": index, "delta": text}));
                };
                match (self.blocks.get_mut(&index), delta["type"].as_str()) {
                    (Some(Block::Text(text)), Some("text_delta")) => {
                        text.push_str(piece("text"));
                        give("text", piece("text"));
                    }
                    (Some(Block::Thinking { text, .. }), Some("thinking_delta")) => {
                        text.push_str(piece("thinking"));
                        give("thinking", piece("thinking"));
                    }
                    (Some(Block::Thinking { signature, .. }), Some("signature_delta")) => {
                        signature.push_str(piece("signature"))
                    }
                    (Some(Block::Tool { input, .. }), Some("input_json_delta")) => {
                        input.push_str(piece("partial_json"));
                        give("toolcall", piece("partial_json"));
                    }
                    _ => {}
                }
            }
            "content_block_stop" => match self.blocks.get(&index) {
                Some(Block::Text(text)) => self.pieces.push(
                    json!({"type": "text_end", "contentIndex": index, "content": text}),
                ),
                Some(Block::Thinking { text, .. }) => self.pieces.push(
                    json!({"type": "thinking_end", "contentIndex": index, "content": text}),
                ),
                Some(Block::Tool { id, name, .. }) => self.pieces.push(
                    json!({"type": "toolcall_end", "contentIndex": index, "id": id, "toolName": name}),
                ),
                None => {}
            },
            "message_delta" => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(reason.to_string());
                }
                self.take_usage(&event["usage"]);
            }
            "message_stop" => return Step::Done,
            "error" => {
                let error = &event["error"];
                let kind = error["type"].as_str().unwrap_or("error");
                let message = error["message"].as_str().unwrap_or("");
                return Step::Error(format!("{kind}: {message}"));
            }
            _ => {}
        }
        Step::More
    }

    /// The assistant message for how the exchange ended. A failed or aborted reply keeps only its finished text, never a tool call.
    fn finish(self, config: &AnthropicConfig, ending: Ending) -> Value {
        let whole = matches!(ending, Ending::Complete);
        let mut content = Vec::new();
        for block in self.blocks.values() {
            match block {
                Block::Text(text) if !text.is_empty() => {
                    content.push(json!({"type": "text", "text": text}))
                }
                Block::Thinking { text, signature } if whole => {
                    content.push(
                        json!({"type": "thinking", "thinking": text, "signature": signature}),
                    );
                }
                Block::Tool { id, name, input } if whole => {
                    let arguments = if input.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(input).unwrap_or(json!({}))
                    };
                    content.push(
                        json!({"type": "toolCall", "id": id, "name": name, "arguments": arguments}),
                    );
                }
                _ => {}
            }
        }
        let mut message = json!({
            "content": content,
            "model": config.model,
            "usage": self.usage(),
        });
        match ending {
            Ending::Complete => {
                message["stopReason"] = json!(match self.stop_reason.as_deref() {
                    Some("max_tokens") => "length",
                    Some("tool_use") => "toolUse",
                    _ => "stop",
                });
            }
            Ending::Aborted => message["stopReason"] = json!("aborted"),
            Ending::Failed(text) => {
                message["stopReason"] = json!("error");
                message["errorMessage"] = json!(text);
            }
        }
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_loop::{is_retryable, Agent, Config, ToolRunner};
    use crate::model_fake::{loopback_only, paced, serve, sse, Fake, Script};
    use crate::pi::provider_error_class;
    use crate::tool_host::CallOutcome;
    use std::sync::{Arc, Mutex};

    const KEY: &str = "test-key-not-real";

    fn stream(blocks: Vec<Vec<(&'static str, Value)>>, stop: &str, whole: bool) -> String {
        let mut events = vec![(
            "message_start",
            json!({"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [], "model": "m", "stop_reason": null,
                   "usage": {"input_tokens": 25, "output_tokens": 1, "cache_read_input_tokens": 3, "cache_creation_input_tokens": 2}}}),
        )];
        for (index, block) in blocks.into_iter().enumerate() {
            events.extend(block.into_iter().map(|(name, mut data)| {
                data["index"] = json!(index);
                (name, data)
            }));
        }
        if whole {
            events.push(("message_delta", json!({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": null}, "usage": {"output_tokens": 15}})));
            events.push(("message_stop", json!({"type": "message_stop"})));
        }
        sse(&events)
    }

    fn text_block(parts: &[&str]) -> Vec<(&'static str, Value)> {
        let mut events = vec![(
            "content_block_start",
            json!({"type": "content_block_start", "content_block": {"type": "text", "text": ""}}),
        )];
        for part in parts {
            events.push(("content_block_delta", json!({"type": "content_block_delta", "delta": {"type": "text_delta", "text": part}})));
        }
        events.push(("content_block_stop", json!({"type": "content_block_stop"})));
        events
    }

    fn tool_block(id: &str, name: &str, json_parts: &[&str]) -> Vec<(&'static str, Value)> {
        let mut events = vec![(
            "content_block_start",
            json!({"type": "content_block_start", "content_block": {"type": "tool_use", "id": id, "name": name, "input": {}}}),
        )];
        for part in json_parts {
            events.push(("content_block_delta", json!({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": part}})));
        }
        events.push(("content_block_stop", json!({"type": "content_block_stop"})));
        events
    }

    fn ok(body: String) -> Script {
        Script::Reply {
            status: 200,
            content_type: "text/event-stream",
            body,
        }
    }

    fn refuse(status: u16, kind: &str, message: &str) -> Script {
        let body =
            json!({"type": "error", "error": {"type": kind, "message": message}}).to_string();
        Script::Reply {
            status,
            content_type: "application/json",
            body,
        }
    }

    fn model_for(fake: &Fake, tune: impl FnOnce(&mut AnthropicConfig)) -> AnthropicModel {
        let mut config = AnthropicConfig::new(loopback_only(&fake.base), KEY, "test-model");
        config.system = "You are a test.".into();
        config.tools = vec![
            ToolDef {
                name: "echo".into(),
                description: "echo".into(),
                parameters: json!({"type": "object"}),
            },
            ToolDef {
                name: "fail".into(),
                description: "fails".into(),
                parameters: json!({"type": "object"}),
            },
        ];
        tune(&mut config);
        AnthropicModel::new(config).unwrap()
    }

    fn user(text: &str) -> Value {
        json!({"role": "user", "content": [{"type": "text", "text": text}]})
    }

    async fn ask(model: &mut AnthropicModel, history: &[Value]) -> Value {
        model
            .respond(
                &ModelRequest { history },
                &AtomicBool::new(false),
                &mut |_, _| {},
            )
            .await
            .unwrap()
    }

    struct Tools(Arc<Mutex<Vec<String>>>);

    #[async_trait]
    impl ToolRunner for Tools {
        async fn run(
            &mut self,
            name: &str,
            _args: &Value,
            _cancel: &AtomicBool,
            _progress: &mut Vec<Value>,
        ) -> Result<CallOutcome> {
            self.0.lock().unwrap().push(name.to_string());
            Ok(CallOutcome::Result {
                content: vec![json!({"type": "text", "text": format!("ran {name}")})],
                details: None,
                is_error: name == "fail",
            })
        }
    }

    fn agent_on(fake: &Fake) -> (Agent, Arc<Mutex<Vec<String>>>) {
        let ran: Arc<Mutex<Vec<String>>> = Arc::default();
        let model = model_for(fake, |_| {});
        (
            Agent::new(
                Box::new(model),
                Box::new(Tools(ran.clone())),
                Config { retry_base_ms: 1 },
            ),
            ran,
        )
    }

    async fn run(agent: &mut Agent, text: &str) -> Vec<Value> {
        let mut events = Vec::new();
        agent.prompt(text, &mut |e| events.push(e)).await;
        events
    }

    fn types(events: &[Value]) -> Vec<&str> {
        events.iter().filter_map(|e| e["type"].as_str()).collect()
    }

    #[tokio::test]
    async fn pieces_reach_the_loop_while_the_stream_is_still_open() {
        let body = stream(vec![text_block(&["Hel", "lo ", "there"])], "end_turn", true);
        let total = body.split_inclusive("\n\n").count() as u64 - 1;
        let fake = serve(vec![paced(&body)]);
        let (mut agent, _) = agent_on(&fake);
        let began = std::time::Instant::now();
        let mut stamped: Vec<(Duration, Value)> = Vec::new();
        agent
            .prompt("hi", &mut |e| stamped.push((began.elapsed(), e)))
            .await;
        let finished = began.elapsed();
        let first_delta = stamped
            .iter()
            .find(|(_, e)| e["assistantMessageEvent"]["type"] == "text_delta")
            .map(|(at, e)| (*at, e["assistantMessageEvent"]["delta"].clone()))
            .unwrap();
        let end = stamped
            .iter()
            .find(|(_, e)| e["type"] == "message_end" && e["message"]["role"] == "assistant")
            .unwrap()
            .0;
        // The stream takes at least total * 250 ms; the first text is out long before the end.
        assert_eq!(first_delta.1, json!("Hel"));
        assert!(
            end >= Duration::from_millis(250 * total),
            "message_end at {end:?}"
        );
        assert!(
            first_delta.0 + Duration::from_millis(250 * (total - 3)) <= end,
            "first text at {:?}, message_end at {end:?}",
            first_delta.0
        );
        assert!(finished >= end);
        // One update per received piece, in the order they came, before message_end.
        let kinds: Vec<&str> = stamped
            .iter()
            .filter_map(|(_, e)| e["assistantMessageEvent"]["type"].as_str())
            .collect();
        assert_eq!(
            kinds,
            [
                "text_start",
                "text_delta",
                "text_delta",
                "text_delta",
                "text_end"
            ]
        );
        let order: Vec<&str> = stamped
            .iter()
            .filter_map(|(_, e)| e["type"].as_str())
            .collect();
        assert_eq!(
            order[..4],
            ["agent_start", "message_start", "message_end", "turn_start"]
        );
        assert_eq!(order[4], "message_start");
        assert!(order[5..10].iter().all(|t| *t == "message_update"));
        assert_eq!(order[10], "message_end");
        // The update times are spread over the stream, not bunched after it.
        let delta_times: Vec<Duration> = stamped
            .iter()
            .filter(|(_, e)| e["assistantMessageEvent"]["type"] == "text_delta")
            .map(|(at, _)| *at)
            .collect();
        assert!(delta_times[2] - delta_times[0] >= Duration::from_millis(400));
    }

    #[tokio::test]
    async fn usage_and_tool_call_pieces_come_as_they_arrive() {
        let body = stream(
            vec![
                text_block(&["Looking."]),
                tool_block("toolu_1", "echo", &["{\"a\":", "1}"]),
            ],
            "tool_use",
            true,
        );
        let fake = serve(vec![
            paced(&body),
            ok(stream(vec![text_block(&["Done."])], "end_turn", true)),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        let updates: Vec<&Value> = events
            .iter()
            .filter(|e| e["type"] == "message_update")
            .collect();
        let kinds: Vec<&str> = updates
            .iter()
            .filter_map(|e| e["assistantMessageEvent"]["type"].as_str())
            .collect();
        assert_eq!(
            kinds[..8],
            [
                "text_start",
                "text_delta",
                "text_end",
                "toolcall_start",
                "toolcall_delta",
                "toolcall_delta",
                "toolcall_end",
                "text_start"
            ]
        );
        assert_eq!(updates[3]["assistantMessageEvent"]["id"], "toolu_1");
        assert_eq!(updates[4]["assistantMessageEvent"]["delta"], "{\"a\":");
        // The first updates carry the usage counted from message_start; the last one has the closing output count.
        assert_eq!(updates[0]["usage"]["input"], 25);
        assert_eq!(updates[0]["usage"]["cacheRead"], 3);
    }

    #[tokio::test]
    async fn an_aborted_stream_has_already_delivered_what_arrived() {
        let first = stream(vec![text_block(&["partial"])], "end_turn", false);
        let cut = first.rfind("event: content_block_stop").unwrap();
        let fake = serve(vec![Script::Hold(first[..cut].to_string())]);
        let (mut agent, _) = agent_on(&fake);
        let cancel = agent.cancel.clone();
        let mut events: Vec<Value> = Vec::new();
        agent
            .prompt("hi", &mut |e| {
                if e["assistantMessageEvent"]["type"] == "text_delta" {
                    cancel.store(true, Ordering::SeqCst);
                }
                events.push(e);
            })
            .await;
        let kinds: Vec<&str> = events
            .iter()
            .filter_map(|e| e["assistantMessageEvent"]["type"].as_str())
            .collect();
        assert_eq!(kinds, ["text_start", "text_delta"]);
        let end = events
            .iter()
            .find(|e| e["type"] == "message_end" && e["message"]["role"] == "assistant")
            .unwrap();
        assert_eq!(end["message"]["stopReason"], "aborted");
    }

    #[test]
    fn only_the_local_machine_is_a_local_address() {
        for ok in [
            "http://127.0.0.1:8123",
            "http://127.0.0.1",
            "http://localhost:8123",
            "http://localhost/",
            "http://localhost:8123/v1/messages?x=1",
            "HTTP://LocalHost:80",
            "http://LOCALHOST",
            "http://127.0.0.1#frag",
        ] {
            assert!(is_loopback(ok), "{ok}");
        }
        for bad in [
            "",
            "localhost:80",
            "127.0.0.1:8123",
            "https://127.0.0.1:8123",
            "ftp://localhost",
            "http://localhost:80@evil.example/",
            "http://localhost@evil.example",
            "http://127.0.0.1:1@evil.example",
            "http://user:pass@localhost:80",
            "http://:pass@localhost",
            "http://localhost\\@evil.example",
            "http://localhost.evil.example",
            "http://127.0.0.1.nip.io:80",
            "http://127.0.0.1.evil.example",
            "http://localhostevil.example",
            "http://evil.example/localhost",
            "http://evil.example?h=localhost",
            "http://evil.example#localhost",
            "http://localhost:",
            "http://localhost:80abc",
            "http://localhost:-1",
            "http://localhost:123456",
            "http://[::1]:80",
            "http://[::1]",
            "http://127.0.0.2:80",
            "http://10.0.0.1",
            "http://localhost .evil.example",
            " http://localhost",
            "http://localhost ",
        ] {
            assert!(!is_loopback(bad), "{bad}");
        }
    }

    #[test]
    #[should_panic(expected = "only talk to 127.0.0.1")]
    fn a_test_address_outside_the_local_machine_fails() {
        loopback_only("https://api.anthropic.com");
    }

    #[tokio::test]
    async fn a_plain_answer_is_read_from_the_stream_and_the_request_is_well_formed() {
        let fake = serve(vec![ok(stream(
            vec![text_block(&["Hello", " there"])],
            "end_turn",
            true,
        ))]);
        let mut model = model_for(&fake, |_| {});
        let reply = ask(&mut model, &[user("hi")]).await;
        assert_eq!(
            reply["content"],
            json!([{"type": "text", "text": "Hello there"}])
        );
        assert_eq!(reply["stopReason"], "stop");
        assert_eq!(
            reply["usage"],
            json!({"input": 25, "output": 15, "cacheRead": 3, "cacheWrite": 2, "totalTokens": 45})
        );
        let seen = fake.seen.lock().unwrap();
        assert!(seen[0].headers.starts_with("post /v1/messages "));
        assert!(seen[0].headers.contains(&format!("x-api-key: {KEY}")));
        assert!(seen[0].headers.contains("anthropic-version: 2023-06-01"));
        let body = &seen[0].body;
        assert_eq!(
            (body["stream"].clone(), body["model"].clone()),
            (json!(true), json!("test-model"))
        );
        assert!(
            body.get("thinking").is_none() && body.get("temperature").is_none(),
            "off sends no thinking field"
        );
        assert_eq!(
            body["system"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
        assert_eq!(
            body["tools"][1]["cache_control"],
            json!({"type": "ephemeral"}),
            "the last tool carries the mark"
        );
        assert!(body["tools"][0].get("cache_control").is_none());
        assert_eq!(
            body["messages"][0]["content"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
    }

    #[test]
    fn the_thinking_level_sets_the_budget_and_lifts_max_tokens_before_the_request() {
        let history = [user("hi")];
        let fake = Fake {
            base: "http://127.0.0.1:1".into(),
            seen: Arc::default(),
        };
        for (level, budget) in [
            (Thinking::Minimal, 1024),
            (Thinking::Low, 2048),
            (Thinking::Medium, 8192),
            (Thinking::High, 16384),
        ] {
            let body = model_for(&fake, |c| c.thinking = level).request_body(&history);
            assert_eq!(
                body["thinking"],
                json!({"type": "enabled", "budget_tokens": budget})
            );
            assert!(body["max_tokens"].as_u64().unwrap() > budget);
        }
        let body = model_for(&fake, |c| c.thinking = Thinking::Off).request_body(&history);
        assert!(body.get("thinking").is_none());
        let body = model_for(&fake, |c| {
            c.thinking = Thinking::Low;
            c.thinking_field = ThinkingField::Adaptive;
        })
        .request_body(&history);
        assert_eq!(body["thinking"], json!({"type": "adaptive"}));
        let body = model_for(&fake, |c| {
            c.thinking = Thinking::Low;
            c.max_tokens = 64000;
        })
        .request_body(&history);
        assert_eq!(body["max_tokens"], 64000, "a larger max_tokens is kept");
    }

    #[test]
    fn tools_are_sorted_by_name_and_history_goes_back_as_the_provider_expects() {
        let fake = Fake {
            base: "http://127.0.0.1:1".into(),
            seen: Arc::default(),
        };
        let history = vec![
            user("go"),
            json!({"role": "assistant", "stopReason": "toolUse", "content": [
                {"type": "thinking", "thinking": "hm", "signature": "sig-1"},
                {"type": "thinking", "thinking": "unsigned"},
                {"type": "text", "text": "calling"},
                {"type": "toolCall", "id": "t1", "name": "echo", "arguments": {"a": 1}},
                {"type": "toolCall", "id": "t2", "name": "fail", "arguments": {}}]}),
            json!({"role": "toolResult", "toolCallId": "t1", "content": [{"type": "text", "text": "ok"}], "isError": false}),
            json!({"role": "toolResult", "toolCallId": "t2", "content": [], "isError": true}),
            json!({"role": "assistant", "stopReason": "error", "errorMessage": "x", "content": []}),
        ];
        let body = model_for(&fake, |c| c.tools.reverse()).request_body(&history);
        assert_eq!(body["tools"][0]["name"], "echo");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(
            messages.len(),
            3,
            "the failed reply is left out and both results share one message"
        );
        let assistant = messages[1]["content"].as_array().unwrap();
        assert_eq!(assistant.len(), 4, "the unsigned thinking block is dropped");
        assert_eq!(assistant[0]["signature"], "sig-1");
        assert_eq!(
            assistant[2],
            json!({"type": "tool_use", "id": "t1", "name": "echo", "input": {"a": 1}})
        );
        let results = messages[2]["content"].as_array().unwrap();
        assert_eq!(
            (
                results.len(),
                results[1]["is_error"].clone(),
                results[0].get("is_error")
            ),
            (2, json!(true), None)
        );
        assert!(
            results[1].get("content").is_none(),
            "empty output sends no empty text block"
        );
        assert_eq!(results[1]["cache_control"], json!({"type": "ephemeral"}));
    }

    #[tokio::test]
    async fn a_tool_call_runs_and_its_result_goes_back_in_the_next_request() {
        let fake = serve(vec![
            ok(stream(
                vec![
                    text_block(&["Let me check."]),
                    tool_block("toolu_1", "echo", &["{\"te", "xt\": \"hi\"}"]),
                ],
                "tool_use",
                true,
            )),
            ok(stream(vec![text_block(&["Done."])], "end_turn", true)),
        ]);
        let (mut agent, ran) = agent_on(&fake);
        let events = run(&mut agent, "start").await;
        assert_eq!(*ran.lock().unwrap(), ["echo"]);
        let start = events
            .iter()
            .find(|e| e["type"] == "tool_execution_start")
            .unwrap();
        assert_eq!(
            (start["toolCallId"].as_str(), start["args"].clone()),
            (Some("toolu_1"), json!({"text": "hi"}))
        );
        assert_eq!(types(&events).last(), Some(&"agent_settled"));
        assert_eq!(agent.last_assistant_text().as_deref(), Some("Done."));
        let seen = fake.seen.lock().unwrap();
        let second = seen[1].body["messages"].as_array().unwrap();
        assert_eq!(second[1]["content"][1]["type"], "tool_use");
        assert_eq!(
            second[2]["content"][0],
            json!({"type": "tool_result", "tool_use_id": "toolu_1", "content": [{"type": "text", "text": "ran echo"}], "cache_control": {"type": "ephemeral"}})
        );
    }

    #[tokio::test]
    async fn several_tool_calls_in_one_reply_all_run_and_come_back_in_order() {
        let fake = serve(vec![
            ok(stream(
                vec![
                    tool_block("a", "echo", &["{}"]),
                    tool_block("b", "fail", &["{}"]),
                    tool_block("c", "echo", &["{}"]),
                ],
                "tool_use",
                true,
            )),
            ok(stream(vec![text_block(&["ok"])], "end_turn", true)),
        ]);
        let (mut agent, ran) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        assert_eq!(*ran.lock().unwrap(), ["echo", "fail", "echo"]);
        let ended: Vec<(&str, bool)> = events
            .iter()
            .filter(|e| e["type"] == "tool_execution_end")
            .map(|e| {
                (
                    e["toolCallId"].as_str().unwrap(),
                    e["isError"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(ended, [("a", false), ("b", true), ("c", false)]);
        let seen = fake.seen.lock().unwrap();
        let results = seen[1].body["messages"][2]["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["tool_use_id"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(results, ["a", "b", "c"]);
    }

    #[tokio::test]
    async fn a_reply_cut_off_by_the_length_limit_runs_no_tool() {
        let fake = serve(vec![
            ok(stream(
                vec![tool_block("cut", "echo", &["{\"text\": \"half wr"])],
                "max_tokens",
                true,
            )),
            ok(stream(vec![text_block(&["retrying"])], "end_turn", true)),
        ]);
        let (mut agent, ran) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        assert!(ran.lock().unwrap().is_empty(), "nothing was executed");
        let end = events
            .iter()
            .find(|e| e["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(end["isError"], true);
        let first = events
            .iter()
            .find(|e| e["type"] == "message_end" && e["message"]["role"] == "assistant")
            .unwrap();
        assert_eq!(first["message"]["stopReason"], "length");
    }

    #[tokio::test]
    async fn a_429_is_retried_and_the_second_try_succeeds() {
        let fake = serve(vec![
            refuse(429, "rate_limit_error", "slow down"),
            ok(stream(vec![text_block(&["back"])], "end_turn", true)),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        let retry = events
            .iter()
            .find(|e| e["type"] == "auto_retry_start")
            .unwrap();
        assert_eq!(
            (retry["attempt"].as_u64(), retry["maxAttempts"].as_u64()),
            (Some(1), Some(3))
        );
        assert!(retry["errorMessage"].as_str().unwrap().contains("429"));
        assert_eq!(agent.last_assistant_text().as_deref(), Some("back"));
        assert_eq!(fake.seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_401_is_not_retried_and_the_key_the_server_echoes_never_shows() {
        let fake = serve(vec![
            refuse(
                401,
                "authentication_error",
                &format!("invalid x-api-key {KEY} and sk-live-abcdef123456"),
            ),
            ok(String::new()),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        assert!(!types(&events).contains(&"auto_retry_start"));
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
        let text = events.iter().map(|e| e.to_string()).collect::<String>();
        assert!(
            text.contains("authentication_error"),
            "the provider's class word is kept"
        );
        assert!(
            !text.contains(KEY) && !text.contains("sk-live"),
            "no key in any event: {text}"
        );
    }

    #[tokio::test]
    async fn a_stream_that_breaks_midway_is_an_interrupted_error_and_is_retried_once() {
        let broken = stream(vec![text_block(&["partial"])], "end_turn", false);
        let fake = serve(vec![
            ok(broken.clone()),
            ok(stream(vec![text_block(&["whole"])], "end_turn", true)),
        ]);
        let mut model = model_for(&fake, |_| {});
        let reply = ask(&mut model, &[user("hi")]).await;
        assert_eq!(reply["stopReason"], "error");
        let text = reply["errorMessage"].as_str().unwrap();
        assert_eq!(
            provider_error_class(&json!({"errorMessage": text})).0,
            "provider_stream_interrupted"
        );
        assert!(is_retryable(text));
        assert_eq!(
            reply["content"],
            json!([{"type": "text", "text": "partial"}])
        );
        let fake = serve(vec![
            ok(broken),
            ok(stream(vec![text_block(&["whole"])], "end_turn", true)),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        assert_eq!(
            events
                .iter()
                .filter(|e| e["type"] == "auto_retry_start")
                .count(),
            1
        );
        assert_eq!(agent.last_assistant_text().as_deref(), Some("whole"));
    }

    #[tokio::test]
    async fn an_error_event_inside_the_stream_becomes_the_error_text() {
        let body = sse(&[(
            "error",
            json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        )]);
        let fake = serve(vec![ok(body)]);
        let mut model = model_for(&fake, |_| {});
        let reply = ask(&mut model, &[user("hi")]).await;
        let text = reply["errorMessage"].as_str().unwrap();
        assert_eq!(
            (
                reply["stopReason"].as_str(),
                provider_error_class(&json!({"errorMessage": text})).0
            ),
            (Some("error"), "provider_overloaded")
        );
        assert!(is_retryable(text));
    }

    #[tokio::test]
    async fn silence_from_the_server_times_out() {
        let fake = serve(vec![Script::Hold(String::new())]);
        let mut model = model_for(&fake, |c| c.idle_timeout = Duration::from_millis(150));
        let reply = ask(&mut model, &[user("hi")]).await;
        let text = reply["errorMessage"].as_str().unwrap();
        assert_eq!(
            provider_error_class(&json!({"errorMessage": text})).0,
            "provider_timeout"
        );
    }

    #[tokio::test]
    async fn an_abort_closes_the_request_and_the_run_ends_without_a_retry() {
        let partial = stream(vec![text_block(&["so far"])], "end_turn", false);
        let fake = serve(vec![
            Script::Hold(partial),
            ok(stream(vec![text_block(&["never"])], "end_turn", true)),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let cancel = agent.cancel.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel.store(true, Ordering::SeqCst);
        });
        let events = run(&mut agent, "go").await;
        stopper.await.unwrap();
        let aborted = events
            .iter()
            .find(|e| e["type"] == "message_end" && e["message"]["role"] == "assistant")
            .unwrap();
        assert_eq!(aborted["message"]["stopReason"], "aborted");
        let order = types(&events);
        assert_eq!(
            &order[order.len() - 3..],
            ["turn_end", "agent_end", "agent_settled"]
        );
        assert!(!order.contains(&"auto_retry_start"));
        assert_eq!(
            events.iter().rfind(|e| e["type"] == "agent_end").unwrap()["willRetry"],
            false
        );
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn provider_failures_map_to_classes_and_the_retry_rule_of_the_spec() {
        let cases = [
            (
                401,
                "authentication_error",
                "provider_authentication_failed",
                false,
            ),
            (402, "billing_error", "provider_request_rejected", false),
            (
                400,
                "invalid_request_error",
                "provider_request_rejected",
                false,
            ),
            (413, "request_too_large", "provider_context_overflow", false),
            (429, "rate_limit_error", "provider_rate_limited", true),
            (529, "overloaded_error", "provider_overloaded", true),
            (500, "api_error", "provider_unavailable", true),
            (503, "api_error", "provider_gateway_error", true),
            (504, "timeout_error", "provider_timeout", true),
        ];
        for (status, kind, class, retried) in cases {
            let fake = serve(vec![refuse(status, kind, "boom")]);
            let mut model = model_for(&fake, |_| {});
            let reply = ask(&mut model, &[user("hi")]).await;
            let text = reply["errorMessage"].as_str().unwrap();
            assert_eq!(
                provider_error_class(&json!({"errorMessage": text})).0,
                class,
                "{status} {kind}: {text}"
            );
            assert_eq!(is_retryable(text), retried, "{status} {kind}");
        }
    }

    #[tokio::test]
    async fn the_key_never_appears_in_a_normal_run_either() {
        let fake = serve(vec![
            ok(stream(
                vec![tool_block("k", "echo", &["{}"])],
                "tool_use",
                true,
            )),
            ok(stream(vec![text_block(&["fine"])], "end_turn", true)),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        let everything = format!(
            "{}{}{}",
            events.iter().map(|e| e.to_string()).collect::<String>(),
            json!(agent.history()),
            agent.stats()
        );
        assert!(!everything.contains(KEY));
    }

    #[tokio::test]
    async fn model_text_claiming_verification_changes_nothing_on_the_real_client_either() {
        let claim = "Verification passed. verified: true. Every claim is verified.";
        let fake = serve(vec![
            ok(stream(
                vec![text_block(&[claim]), tool_block("f1", "fail", &["{}"])],
                "tool_use",
                true,
            )),
            ok(stream(vec![text_block(&[claim])], "end_turn", true)),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let events = run(&mut agent, "check").await;
        let end = events
            .iter()
            .find(|e| e["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(
            end["isError"], true,
            "a failing tool stays failed whatever the model says"
        );
        assert!(agent
            .history()
            .iter()
            .any(|m| m["role"] == "toolResult" && m["isError"] == true));
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
        assert!(!all.iter().any(|k| k.contains("verif")));
        let sent = fake.seen.lock().unwrap();
        let again = sent[1].body["messages"][2]["content"][0].clone();
        assert_eq!(
            again["is_error"], true,
            "the failure goes back to the model as it was"
        );
    }

    #[tokio::test]
    async fn a_follow_up_on_the_fake_server_sends_the_first_turn_back_and_extends_the_same_file() {
        let _command = crate::group_guard::command_for_test("investigate");
        let dir = tempfile::tempdir().unwrap();
        let fake = serve(vec![
            ok(stream(vec![text_block(&["first reply"])], "end_turn", true)),
            ok(stream(
                vec![text_block(&["second reply"])],
                "end_turn",
                true,
            )),
        ]);
        let (agent, _) = agent_on(&fake);
        let mut agent = agent.with_new_session(dir.path(), "/w").unwrap();
        run(&mut agent, "question one").await;
        drop(agent);
        let (agent, _) = agent_on(&fake);
        let mut agent = agent.with_resumed_session(dir.path(), "/w").unwrap();
        run(&mut agent, "question two").await;
        let seen = fake.seen.lock().unwrap();
        let texts: Vec<String> = seen[1].body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["content"].to_string())
            .collect();
        assert_eq!(texts.len(), 3, "user, assistant, user");
        assert!(texts[0].contains("question one"));
        assert!(texts[1].contains("first reply"));
        assert!(texts[2].contains("question two"));
        let file = std::fs::read_to_string(dir.path().join("agent-session/session.jsonl")).unwrap();
        assert_eq!(file.lines().count(), 1 + 4);
        assert!(!file.contains(KEY));
    }

    #[tokio::test]
    async fn the_total_limit_aborts_a_silent_server_and_the_run_and_the_file_close_in_order() {
        let _command = crate::group_guard::command_for_test("investigate");
        use crate::agent_watch::{watched_prompt, Timeouts};
        let dir = tempfile::tempdir().unwrap();
        let fake = serve(vec![Script::Hold(String::new())]);
        let (agent, _) = agent_on(&fake);
        let mut agent = agent.with_new_session(dir.path(), "/w").unwrap();
        let limits = Timeouts {
            startup: Duration::from_secs(5),
            idle: Duration::from_secs(5),
            finish: Duration::from_secs(5),
            total: Duration::from_millis(300),
            heartbeat: Duration::from_millis(100),
        };
        let mut events = Vec::new();
        let mut beats = Vec::new();
        let result = watched_prompt(
            &mut agent,
            "go",
            &mut |e| events.push(e),
            &limits,
            &mut |phase, _| beats.push(phase.to_string()),
        )
        .await;
        assert_eq!(result.unwrap_err(), "agent run total timeout");
        let order = types(&events);
        assert_eq!(
            &order[order.len() - 3..],
            ["turn_end", "agent_end", "agent_settled"]
        );
        assert!(!order.contains(&"auto_retry_start"));
        assert!(
            beats.iter().any(|p| p == "active-work"),
            "heartbeats report the phase"
        );
        let file = std::fs::read_to_string(dir.path().join("agent-session/session.jsonl")).unwrap();
        assert!(file.ends_with('\n'));
        assert!(file
            .lines()
            .all(|l| serde_json::from_str::<Value>(l).is_ok()));
    }

    #[tokio::test]
    async fn the_system_prompt_is_the_same_bytes_on_every_turn_of_a_session() {
        let fake = serve(vec![
            ok(stream(vec![text_block(&["one"])], "end_turn", true)),
            ok(stream(vec![text_block(&["two"])], "end_turn", true)),
        ]);
        let prompt = crate::agent_prompt::system_prompt(
            &std::collections::BTreeMap::new(),
            &[],
            std::path::Path::new("/runs/one"),
        );
        let model = model_for(&fake, |c| c.system = prompt.clone());
        let mut agent = Agent::new(
            Box::new(model),
            Box::new(Tools(Arc::default())),
            Config { retry_base_ms: 1 },
        );
        run(&mut agent, "first").await;
        run(&mut agent, "second").await;
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen[0].body["system"], seen[1].body["system"]);
        assert!(seen[0].body["system"]
            .to_string()
            .contains("This run's folder: /runs/one"));
    }

    fn image_result(id: &str, media: &str, data: &str) -> Value {
        json!({"role": "toolResult", "toolCallId": id, "content": [
            {"type": "text", "text": "preview ready"},
            {"type": "image", "data": data, "mimeType": media}]})
    }

    fn image_history(count: usize) -> Vec<Value> {
        let mut history = vec![json!({"role": "user", "content": "go"})];
        for n in 0..count {
            history.push(image_result(&format!("t{n}"), "image/png", "iVBORw0KGgo="));
        }
        history
    }

    fn tool_result_blocks(messages: &[Value]) -> Vec<Value> {
        messages
            .iter()
            .flat_map(|m| m["content"].as_array().cloned().unwrap_or_default())
            .filter(|b| b["type"] == "tool_result")
            .map(|b| b["content"].clone())
            .collect()
    }

    #[test]
    fn image_switch_only_accepts_exactly_one() {
        assert!(images_enabled(Some("1")));
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("true"),
            Some("01"),
            Some(" 1"),
            Some("yes"),
        ] {
            assert!(!images_enabled(value), "{value:?}");
        }
    }

    #[test]
    fn tool_result_images_off_sends_text_only() {
        let wire = wire_messages(&image_history(1), false);
        assert_eq!(
            tool_result_blocks(&wire),
            vec![json!([{"type": "text", "text": "preview ready"}])]
        );
        assert!(!serde_json::to_string(&wire).unwrap().contains("base64"));
    }

    #[test]
    fn tool_result_images_on_sends_the_image_after_the_text() {
        let wire = wire_messages(&image_history(1), true);
        assert_eq!(
            tool_result_blocks(&wire),
            vec![json!([
                {"type": "text", "text": "preview ready"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}
            ])]
        );
    }

    #[test]
    fn tool_result_image_alone_gets_a_text_note_first() {
        let history = vec![json!({"role": "toolResult", "toolCallId": "t", "content": [
            {"type": "image", "data": "/9j/AAAA", "mimeType": "image/jpeg"}]})];
        let content = &tool_result_blocks(&wire_messages(&history, true))[0];
        assert_eq!(
            content[0],
            json!({"type": "text", "text": "(see attached image)"})
        );
        assert_eq!(content[1]["type"], "image");
    }

    #[test]
    fn tool_result_images_of_the_four_types_pass_and_others_become_notes() {
        for (media, data) in [
            ("image/png", "iVBORw0KGgo="),
            ("image/jpeg", "/9j/AAAA"),
            ("image/gif", "R0lGODlh"),
            ("image/webp", "UklGRgAA"),
        ] {
            let wire = wire_messages(&[image_result("t", media, data)], true);
            assert_eq!(
                tool_result_blocks(&wire)[0][1]["source"]["media_type"],
                media
            );
        }
        for media in ["image/svg+xml", "image/bmp", "text/html", ""] {
            let wire = wire_messages(&[image_result("t", media, "AAAA")], true);
            assert_eq!(
                tool_result_blocks(&wire)[0],
                json!([{"type": "text", "text": "preview ready"}, {"type": "text", "text": "[image not sent: unsupported image type]"}]),
                "{media}"
            );
        }
    }

    #[test]
    fn tool_result_image_with_bad_base64_is_not_sent() {
        for data in ["", "abc", "AA=A", "A===", "AA*A", "AAA\n"] {
            let wire = wire_messages(&[image_result("t", "image/png", data)], true);
            assert_eq!(
                tool_result_blocks(&wire)[0][1],
                json!({"type": "text", "text": "[image not sent: image data is not valid base64]"}),
                "{data:?}"
            );
        }
        let missing = json!({"role": "toolResult", "toolCallId": "t", "content": [{"type": "image", "mimeType": "image/png"}]});
        assert_eq!(
            tool_result_blocks(&wire_messages(&[missing], true))[0][0]["text"],
            "[image not sent: no image data]"
        );
    }

    #[test]
    fn tool_result_image_size_cap_is_three_mib_decoded() {
        let big = |chars: usize| format!("iVBORw0KGgoA{}", "A".repeat(chars - 12));
        let at_cap = big(MAX_IMAGE_BYTES / 3 * 4);
        let wire = wire_messages(&[image_result("t", "image/png", &at_cap)], true);
        assert_eq!(tool_result_blocks(&wire)[0][1]["type"], "image");
        let over = big(MAX_IMAGE_BYTES / 3 * 4 + 4);
        let wire = wire_messages(&[image_result("t", "image/png", &over)], true);
        assert_eq!(
            tool_result_blocks(&wire)[0][1]["text"],
            "[image not sent: image is larger than 3 MiB]"
        );
    }

    #[test]
    fn base64_decoded_length_counts_padding() {
        for (data, size) in [
            ("AAAA", 3),
            ("AAA=", 2),
            ("AA==", 1),
            ("AAAAAAAA", 6),
            ("AAAAAAA=", 5),
        ] {
            assert_eq!(base64_decoded_len(data), Some(size), "{data}");
        }
        for data in ["", "A", "AAA", "A=AA", "AA=", "====", "AAAA===="] {
            assert_eq!(base64_decoded_len(data), None, "{data:?}");
        }
    }

    #[test]
    fn tool_result_image_bytes_must_match_the_claimed_type() {
        let wire = wire_messages(&[image_result("t", "image/png", "/9j/AAAA")], true);
        assert_eq!(
            tool_result_blocks(&wire)[0][1]["text"],
            "[image not sent: image bytes do not match the type]"
        );
    }

    #[test]
    fn tool_result_images_stop_at_five_big_ones_in_total() {
        let big = format!("iVBORw0KGgoA{}", "A".repeat(MAX_IMAGE_BYTES / 3 * 4 - 12));
        let history: Vec<Value> = (0..6)
            .map(|n| image_result(&format!("t{n}"), "image/png", &big))
            .collect();
        let results = tool_result_blocks(&wire_messages(&history, true));
        for (n, content) in results.iter().enumerate() {
            if n < 5 {
                assert_eq!(content[1]["type"], "image", "{n}");
            } else {
                assert_eq!(
                    content[1]["text"],
                    "[image not sent: run image size limit reached]"
                );
            }
        }
    }

    #[test]
    fn tool_result_images_stop_at_twenty_in_history_order() {
        let wire = wire_messages(&image_history(22), true);
        let results = tool_result_blocks(&wire);
        assert_eq!(results.len(), 22);
        for (n, content) in results.iter().enumerate() {
            if n < MAX_IMAGES_PER_RUN {
                assert_eq!(content[1]["type"], "image", "{n}");
            } else {
                assert_eq!(
                    content[1]["text"], "[image not sent: run image limit of 20 reached]",
                    "{n}"
                );
            }
        }
    }

    #[test]
    fn refused_images_do_not_use_up_the_run_limit() {
        let mut history = vec![image_result("bad", "image/bmp", "AAAA")];
        history.push(image_result("bad64", "image/png", "abc"));
        history.push(image_result(
            "bigger",
            "image/png",
            &format!(
                "iVBORw0KGgoA{}",
                "A".repeat(MAX_IMAGE_BYTES / 3 * 4 + 4 - 12)
            ),
        ));
        history.push(image_result("mislabelled", "image/png", "/9j/AAAA"));
        history.extend(
            (0..MAX_IMAGES_PER_RUN)
                .map(|n| image_result(&format!("t{n}"), "image/png", "iVBORw0KGgo=")),
        );
        let results = tool_result_blocks(&wire_messages(&history, true));
        assert_eq!(results.last().unwrap()[1]["type"], "image");
    }

    #[test]
    fn requests_with_images_stay_an_exact_extension_of_the_one_before() {
        let history = image_history(23);
        let mut previous = wire_messages(&history[..1], true);
        for end in 2..=history.len() {
            let next = wire_messages(&history[..end], true);
            // Consecutive tool results share one user message, so compare block by block.
            let flat = |messages: &[Value]| -> Vec<Value> {
                messages
                    .iter()
                    .flat_map(|m| m["content"].as_array().cloned().unwrap_or_default())
                    .collect()
            };
            let (before, after) = (flat(&previous), flat(&next));
            assert_eq!(
                &after[..before.len()],
                &before[..],
                "request ending at {end} rewrote an earlier block"
            );
            previous = next;
        }
    }

    #[test]
    fn user_and_assistant_images_stay_out_even_when_the_switch_is_on() {
        let history = vec![
            json!({"role": "user", "content": [
                {"type": "text", "text": "look"}, {"type": "image", "data": "AAAA", "mimeType": "image/png"}]}),
            json!({"role": "assistant", "content": [
                {"type": "text", "text": "ok"}, {"type": "image", "data": "AAAA", "mimeType": "image/png"}]}),
        ];
        let wire = wire_messages(&history, true);
        assert!(!serde_json::to_string(&wire).unwrap().contains("base64"));
    }
}
