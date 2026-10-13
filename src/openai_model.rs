//! A model for the agent loop that talks the OpenAI Chat Completions wire format, as kimi and zai relays serve it (1011ae step 4,
//! agent-spec 6, 12 and 13). One streaming request per turn; every delta is handed to the loop as it arrives and the finished reply comes
//! back in the loop's message shape. The address and key are given by the caller: this file reads no environment variable, no .env and no
//! config file. Built for tests only (they talk to a fake server on 127.0.0.1); nothing selects it in the product yet.
//!
//! The wire has no way to mark a tool result as an error, so none is sent; whether a result failed is decided only by the tool host.

use crate::agent_loop::{Model, ModelRequest, Pieces};
use crate::anthropic_model::{
    is_loopback, read_blocks, text_blocks, Read, Step, Thinking, ToolDef,
};
use crate::llm::{LLMClient, Provider};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

pub struct OpenAiConfig {
    pub base_url: String,
    api_key: String,
    pub model: String,
    pub max_tokens: u64,
    pub thinking: Thinking,
    /// The request field that carries the thinking level for this provider; nothing is sent when thinking is off.
    pub reasoning_field: String,
    pub system: String,
    pub tools: Vec<ToolDef>,
    /// How long the server may stay silent (before the first byte and between chunks) before the request counts as timed out.
    pub idle_timeout: Duration,
}

impl OpenAiConfig {
    pub fn new(base_url: &str, api_key: &str, model: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
            max_tokens: 8192,
            thinking: Thinking::Off,
            reasoning_field: "reasoning_effort".to_string(),
            system: String::new(),
            tools: Vec::new(),
            idle_timeout: Duration::from_secs(120),
        }
    }
}

pub struct OpenAiModel {
    config: OpenAiConfig,
    http: reqwest::Client,
    /// Only for its URL rule and key redaction; it is never asked to send anything.
    redactor: LLMClient,
}

impl OpenAiModel {
    pub fn new(config: OpenAiConfig) -> Result<Self> {
        let http = if is_loopback(&config.base_url) {
            reqwest::Client::builder().no_proxy().build()?
        } else {
            LLMClient::http_client_from(
                reqwest::Client::builder().connect_timeout(Duration::from_secs(30)),
            )?
        };
        let redactor = LLMClient::new(
            Provider::OpenAI,
            config.api_key.clone(),
            config.model.clone(),
        )
        .with_base_url(config.base_url.clone());
        Ok(Self {
            config,
            http,
            redactor,
        })
    }

    /// The streaming request body: stable tool order, usage requested on the last chunk, and a thinking field only when a level is set.
    fn request_body(&self, history: &[Value]) -> Value {
        let config = &self.config;
        let mut body = json!({
            "model": config.model,
            "stream": true,
            "stream_options": {"include_usage": true},
            "max_tokens": config.max_tokens,
        });
        if let Some(level) = config.thinking.name() {
            body[config.reasoning_field.as_str()] = json!(level);
        }
        let mut tools: Vec<&ToolDef> = config.tools.iter().collect();
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        if !tools.is_empty() {
            body["tools"] = json!(tools
                .iter()
                .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}))
                .collect::<Vec<_>>());
        }
        let mut messages = Vec::new();
        if !config.system.is_empty() {
            messages.push(json!({"role": "system", "content": config.system}));
        }
        messages.extend(wire_messages(history));
        body["messages"] = json!(messages);
        body
    }

    async fn exchange(&self, history: &[Value], cancel: &AtomicBool, pieces: Pieces<'_>) -> Value {
        let config = &self.config;
        let mut stream = StreamState::default();
        let request = self
            .http
            .post(self.redactor.openai_chat_completions_url())
            .header("authorization", format!("Bearer {}", config.api_key))
            .json(&self.request_body(history));
        let read = read_blocks(
            request,
            &self.redactor,
            config.idle_timeout,
            cancel,
            chunk_data,
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
            // Some relays close the connection right after the last chunk without sending `[DONE]`.
            Read::Closed if stream.finish_reason.is_some() => {
                stream.finish(config, Ending::Complete)
            }
            Read::Closed => {
                let text = "upstream stream ended early: no finish_reason or [DONE] before the connection closed";
                stream.finish(config, Ending::Failed(text.to_string()))
            }
        }
    }
}

#[async_trait]
impl Model for OpenAiModel {
    async fn respond(
        &mut self,
        request: &ModelRequest<'_>,
        cancel: &AtomicBool,
        pieces: Pieces<'_>,
    ) -> Option<Value> {
        Some(self.exchange(request.history, cancel, pieces).await)
    }
}

/// The JSON of one chunk; the closing `[DONE]` marker comes through as the string value `"[DONE]"`.
fn chunk_data(block: &str) -> Option<Value> {
    let data: Vec<&str> = block
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect();
    let joined = data.join("\n");
    if joined.trim() == "[DONE]" {
        return Some(json!("[DONE]"));
    }
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&joined).ok()
}

fn joined_text(content: &Value) -> String {
    text_blocks(content)
        .iter()
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The loop's history as chat messages: failed and aborted replies are left out, thinking is not sent back (this wire has no signature
/// for it), and each tool result is its own `tool` message.
fn wire_messages(history: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for message in history {
        match message["role"].as_str().unwrap_or("") {
            "user" => {
                let text = joined_text(&message["content"]);
                if !text.is_empty() {
                    out.push(json!({"role": "user", "content": text}));
                }
            }
            "assistant" => {
                if matches!(message["stopReason"].as_str(), Some("error" | "aborted")) {
                    continue;
                }
                let blocks = message["content"].as_array().cloned().unwrap_or_default();
                let text = blocks
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("");
                let calls: Vec<Value> = blocks
                    .iter()
                    .filter(|b| b["type"] == "toolCall")
                    .map(|b| json!({"id": b["id"], "type": "function", "function": {"name": b["name"], "arguments": b["arguments"].to_string()}}))
                    .collect();
                if text.is_empty() && calls.is_empty() {
                    continue;
                }
                let mut wire = json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }});
                if !calls.is_empty() {
                    wire["tool_calls"] = json!(calls);
                }
                out.push(wire);
            }
            "toolResult" => out.push(json!({"role": "tool", "tool_call_id": message["toolCallId"], "content": joined_text(&message["content"])})),
            _ => {}
        }
    }
    out
}

enum Block {
    Text(String),
    Thinking(String),
    Tool {
        id: String,
        name: String,
        input: String,
    },
}

enum Ending {
    Complete,
    Aborted,
    Failed(String),
}

#[derive(Default)]
struct StreamState {
    blocks: Vec<Block>,
    /// The text or thinking block still receiving pieces.
    open: Option<usize>,
    /// The provider's own tool index → position in `blocks`.
    tools: BTreeMap<u64, usize>,
    ended: Vec<usize>,
    input: u64,
    output: u64,
    cache_read: u64,
    finish_reason: Option<String>,
    /// Increments the last `apply` produced, for the caller to hand over at once.
    pieces: Vec<Value>,
}

impl StreamState {
    fn usage(&self) -> Value {
        json!({"input": self.input, "output": self.output, "cacheRead": self.cache_read, "cacheWrite": 0,
               "totalTokens": self.input + self.output + self.cache_read})
    }

    /// Usage may ride on the last chunk (with no choices) or inside a choice; it may also never come.
    fn take_usage(&mut self, usage: &Value) {
        let number = |value: &Value| value.as_u64();
        let cached = number(&usage["prompt_tokens_details"]["cached_tokens"])
            .or_else(|| number(&usage["cached_tokens"]));
        let Some(prompt) = number(&usage["prompt_tokens"]) else {
            return;
        };
        let cached = cached.unwrap_or(0).min(prompt);
        self.cache_read = cached;
        self.input = prompt - cached;
        self.output = number(&usage["completion_tokens"]).unwrap_or(self.output);
    }

    fn close_open(&mut self) {
        let Some(at) = self.open.take() else { return };
        let end = match &self.blocks[at] {
            Block::Text(text) => json!({"type": "text_end", "contentIndex": at, "content": text}),
            Block::Thinking(text) => {
                json!({"type": "thinking_end", "contentIndex": at, "content": text})
            }
            Block::Tool { .. } => return,
        };
        self.pieces.push(end);
    }

    fn close_tools(&mut self) {
        for (at, block) in self.blocks.iter().enumerate() {
            if let Block::Tool { id, name, .. } = block {
                if !self.ended.contains(&at) {
                    self.ended.push(at);
                    self.pieces.push(json!({"type": "toolcall_end", "contentIndex": at, "id": id, "toolName": name}));
                }
            }
        }
    }

    /// Adds `piece` to the open text or thinking block, starting a new one when the kind changes.
    fn write(&mut self, thinking: bool, piece: &str) {
        let same = match self.open.map(|at| &self.blocks[at]) {
            Some(Block::Text(_)) => !thinking,
            Some(Block::Thinking(_)) => thinking,
            _ => false,
        };
        if !same {
            self.close_open();
            let at = self.blocks.len();
            let (kind, block) = if thinking {
                ("thinking", Block::Thinking(String::new()))
            } else {
                ("text", Block::Text(String::new()))
            };
            self.blocks.push(block);
            self.open = Some(at);
            self.pieces
                .push(json!({"type": format!("{kind}_start"), "contentIndex": at}));
        }
        let at = self.open.unwrap();
        let kind = match &mut self.blocks[at] {
            Block::Text(text) => {
                text.push_str(piece);
                "text"
            }
            Block::Thinking(text) => {
                text.push_str(piece);
                "thinking"
            }
            Block::Tool { .. } => return,
        };
        self.pieces
            .push(json!({"type": format!("{kind}_delta"), "contentIndex": at, "delta": piece}));
    }

    fn tool_call(&mut self, position: usize, call: &Value) {
        let key = call["index"].as_u64().unwrap_or(position as u64);
        let at = match self.tools.get(&key) {
            Some(at) => *at,
            None => {
                self.close_open();
                let at = self.blocks.len();
                self.blocks.push(Block::Tool {
                    id: String::new(),
                    name: String::new(),
                    input: String::new(),
                });
                self.tools.insert(key, at);
                self.pieces
                    .push(json!({"type": "toolcall_start", "contentIndex": at, "id": call["id"], "toolName": call["function"]["name"]}));
                at
            }
        };
        let Block::Tool { id, name, input } = &mut self.blocks[at] else {
            return;
        };
        if let Some(value) = call["id"].as_str().filter(|v| !v.is_empty()) {
            *id = value.to_string();
        }
        if let Some(value) = call["function"]["name"].as_str().filter(|v| !v.is_empty()) {
            if name.is_empty() {
                *name = value.to_string();
            }
        }
        if let Some(part) = call["function"]["arguments"]
            .as_str()
            .filter(|v| !v.is_empty())
        {
            input.push_str(part);
            self.pieces
                .push(json!({"type": "toolcall_delta", "contentIndex": at, "delta": part}));
        }
    }

    fn apply(&mut self, event: &Value) -> Step {
        if event.as_str() == Some("[DONE]") {
            return Step::Done;
        }
        if event["error"].is_object() {
            let error = &event["error"];
            let kind = error["type"]
                .as_str()
                .or_else(|| error["code"].as_str())
                .unwrap_or("error");
            let message = error["message"].as_str().unwrap_or("");
            return Step::Error(format!("{kind}: {message}"));
        }
        let choice = &event["choices"][0];
        for usage in [&event["usage"], &choice["usage"]] {
            if usage.is_object() {
                self.take_usage(usage);
            }
        }
        let delta = &choice["delta"];
        for key in ["reasoning_content", "reasoning"] {
            if let Some(piece) = delta[key].as_str().filter(|p| !p.is_empty()) {
                self.write(true, piece);
                break;
            }
        }
        if let Some(piece) = delta["content"].as_str().filter(|p| !p.is_empty()) {
            self.write(false, piece);
        }
        for (position, call) in delta["tool_calls"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            self.tool_call(position, call);
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish_reason = Some(reason.to_string());
            self.close_open();
            self.close_tools();
        }
        Step::More
    }

    /// The assistant message for how the exchange ended. A failed or aborted reply keeps only its finished text, never a tool call.
    fn finish(self, config: &OpenAiConfig, ending: Ending) -> Value {
        let ending = match (&ending, self.finish_reason.as_deref()) {
            (Ending::Complete, Some("content_filter")) => Ending::Failed(
                "content_filter: the provider stopped the reply with its content filter".into(),
            ),
            _ => ending,
        };
        let whole = matches!(ending, Ending::Complete);
        let has_calls = self.blocks.iter().any(|b| matches!(b, Block::Tool { .. }));
        let mut content = Vec::new();
        for block in &self.blocks {
            match block {
                Block::Text(text) if !text.is_empty() => {
                    content.push(json!({"type": "text", "text": text}))
                }
                Block::Thinking(text) if whole && !text.is_empty() => {
                    content.push(json!({"type": "thinking", "thinking": text}))
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
        let mut message = json!({"content": content, "model": config.model, "usage": self.usage()});
        match ending {
            Ending::Complete => {
                // Some relays say "stop" even when the reply carries tool calls; the calls decide.
                message["stopReason"] = json!(match self.finish_reason.as_deref() {
                    Some("length") => "length",
                    Some("tool_calls" | "function_call") => "toolUse",
                    _ if has_calls => "toolUse",
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
    use crate::model_fake::{loopback_only, paced, serve, Fake, Script};
    use crate::pi::provider_error_class;
    use crate::tool_host::CallOutcome;
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};

    const KEY: &str = "test-key-not-real";

    fn data(value: Value) -> String {
        format!("data: {value}\n\n")
    }

    fn delta_chunk(delta: Value, finish: Option<&str>) -> String {
        data(
            json!({"id": "c1", "object": "chat.completion.chunk", "model": "m",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}),
        )
    }

    fn usage_chunk() -> String {
        data(
            json!({"id": "c1", "object": "chat.completion.chunk", "choices": [],
                    "usage": {"prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42, "prompt_tokens_details": {"cached_tokens": 10}}}),
        )
    }

    fn text_chunks(parts: &[&str]) -> String {
        let mut out = delta_chunk(json!({"role": "assistant", "content": ""}), None);
        for part in parts {
            out += &delta_chunk(json!({"content": part}), None);
        }
        out
    }

    fn call_chunks(index: u64, id: &str, name: &str, args: &[&str]) -> String {
        let mut out = delta_chunk(
            json!({"tool_calls": [{"index": index, "id": id, "type": "function", "function": {"name": name, "arguments": ""}}]}),
            None,
        );
        for part in args {
            out += &delta_chunk(
                json!({"tool_calls": [{"index": index, "function": {"arguments": part}}]}),
                None,
            );
        }
        out
    }

    /// A whole reply: the chunks, the closing chunk with its finish reason, the usage chunk and `[DONE]`.
    fn reply(chunks: &str, finish: &str) -> String {
        format!(
            "{chunks}{}{}data: [DONE]\n\n",
            delta_chunk(json!({}), Some(finish)),
            usage_chunk()
        )
    }

    fn ok(body: String) -> Script {
        Script::Reply {
            status: 200,
            content_type: "text/event-stream",
            body,
        }
    }

    fn refuse(status: u16, kind: &str, message: &str) -> Script {
        Script::Reply {
            status,
            content_type: "application/json",
            body: json!({"error": {"type": kind, "message": message}}).to_string(),
        }
    }

    fn model_for(fake: &Fake, tune: impl FnOnce(&mut OpenAiConfig)) -> OpenAiModel {
        let mut config = OpenAiConfig::new(loopback_only(&fake.base), KEY, "test-model");
        config.system = "You are a test.".into();
        config.tools = ["fail", "echo"]
            .iter()
            .map(|name| ToolDef {
                name: name.to_string(),
                description: name.to_string(),
                parameters: json!({"type": "object"}),
            })
            .collect();
        tune(&mut config);
        OpenAiModel::new(config).unwrap()
    }

    fn user(text: &str) -> Value {
        json!({"role": "user", "content": [{"type": "text", "text": text}]})
    }

    async fn ask(model: &mut OpenAiModel, history: &[Value]) -> Value {
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
            args: &Value,
            _cancel: &AtomicBool,
            _progress: &mut Vec<Value>,
        ) -> Result<CallOutcome> {
            self.0.lock().unwrap().push(format!("{name}{args}"));
            Ok(CallOutcome::Result {
                content: vec![json!({"type": "text", "text": format!("ran {name}")})],
                details: None,
                is_error: name == "fail",
            })
        }
    }

    fn agent_on(fake: &Fake) -> (Agent, Arc<Mutex<Vec<String>>>) {
        let ran: Arc<Mutex<Vec<String>>> = Arc::default();
        (
            Agent::new(
                Box::new(model_for(fake, |_| {})),
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

    #[tokio::test]
    async fn a_plain_answer_and_the_request_shape() {
        let fake = serve(vec![ok(reply(&text_chunks(&["Hello", " there"]), "stop"))]);
        let mut model = model_for(&fake, |_| {});
        let answer = ask(&mut model, &[user("hi")]).await;
        assert_eq!(
            answer["content"],
            json!([{"type": "text", "text": "Hello there"}])
        );
        assert_eq!(answer["stopReason"], "stop");
        assert_eq!(
            answer["usage"],
            json!({"input": 20, "output": 12, "cacheRead": 10, "cacheWrite": 0, "totalTokens": 42})
        );
        let seen = fake.seen.lock().unwrap();
        assert!(seen[0].headers.starts_with("post /v1/chat/completions "));
        assert!(seen[0]
            .headers
            .contains(&format!("authorization: bearer {KEY}")));
        let body = &seen[0].body;
        assert_eq!(
            (&body["stream"], &body["model"]),
            (&json!(true), &json!("test-model"))
        );
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert_eq!(
            body["messages"][0],
            json!({"role": "system", "content": "You are a test."})
        );
        assert_eq!(
            body["messages"][1],
            json!({"role": "user", "content": "hi"})
        );
        assert_eq!(
            body["tools"][0]["function"]["name"], "echo",
            "tools are sorted"
        );
        assert_eq!(body["tools"][0]["type"], "function");
        assert!(
            body.get("reasoning_effort").is_none(),
            "off sends no thinking field"
        );
    }

    #[tokio::test]
    async fn thinking_goes_in_the_declared_field_and_only_when_on() {
        for (level, word) in [
            (Thinking::Minimal, "minimal"),
            (Thinking::Low, "low"),
            (Thinking::Medium, "medium"),
            (Thinking::High, "high"),
        ] {
            let fake = serve(vec![ok(reply(&text_chunks(&["x"]), "stop"))]);
            let mut model = model_for(&fake, |c| {
                c.thinking = level;
                c.reasoning_field = "thinking_level".into();
            });
            ask(&mut model, &[user("hi")]).await;
            let body = fake.seen.lock().unwrap()[0].body.clone();
            assert_eq!(body["thinking_level"], word);
            assert!(body.get("reasoning_effort").is_none());
        }
    }

    #[tokio::test]
    async fn reasoning_text_becomes_a_thinking_block_before_the_answer() {
        let chunks = format!(
            "{}{}",
            delta_chunk(json!({"reasoning_content": "hm"}), None),
            text_chunks(&["Yes"])
        );
        let fake = serve(vec![ok(reply(&chunks, "stop"))]);
        let mut model = model_for(&fake, |_| {});
        let mut answer = ask(&mut model, &[user("hi")]).await;
        answer["role"] = json!("assistant");
        assert_eq!(
            answer["content"],
            json!([{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": "Yes"}])
        );
        // Thinking is not sent back on the next request.
        let fake = serve(vec![ok(reply(&text_chunks(&["x"]), "stop"))]);
        let mut model = model_for(&fake, |_| {});
        ask(&mut model, &[user("hi"), answer]).await;
        let body = fake.seen.lock().unwrap()[0].body.clone();
        assert_eq!(
            body["messages"][2],
            json!({"role": "assistant", "content": "Yes"})
        );
    }

    #[tokio::test]
    async fn tool_calls_with_arguments_in_pieces_are_joined_by_index() {
        let chunks = format!(
            "{}{}{}",
            text_chunks(&["Looking."]),
            call_chunks(0, "call_a", "echo", &["{\"te", "xt\":", "\"one\"}"]),
            call_chunks(1, "call_b", "fail", &["{}"]),
        );
        let fake = serve(vec![
            ok(reply(&chunks, "tool_calls")),
            ok(reply(&text_chunks(&["Done."]), "stop")),
        ]);
        let (mut agent, ran) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        assert_eq!(*ran.lock().unwrap(), ["echo{\"text\":\"one\"}", "fail{}"]);
        assert_eq!(agent.last_assistant_text().as_deref(), Some("Done."));
        let first = events
            .iter()
            .find(|e| e["type"] == "message_end" && e["message"]["role"] == "assistant")
            .unwrap();
        assert_eq!(first["message"]["stopReason"], "toolUse");
        assert_eq!(
            first["message"]["content"][1]["arguments"],
            json!({"text": "one"})
        );
        // History goes back as an assistant message with tool_calls and one tool message per result.
        let second = fake.seen.lock().unwrap()[1].body.clone();
        let messages = second["messages"].as_array().unwrap();
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["arguments"],
            "{\"text\":\"one\"}"
        );
        assert_eq!(
            messages[3],
            json!({"role": "tool", "tool_call_id": "call_a", "content": "ran echo"})
        );
        assert_eq!(messages[4]["tool_call_id"], "call_b");
        assert!(messages[4].get("isError").is_none() && messages[4].get("is_error").is_none());
    }

    #[tokio::test]
    async fn a_relay_saying_stop_with_tool_calls_still_runs_them() {
        let chunks = call_chunks(0, "call_a", "echo", &["{}"]);
        let fake = serve(vec![
            ok(reply(&chunks, "stop")),
            ok(reply(&text_chunks(&["ok"]), "stop")),
        ]);
        let (mut agent, ran) = agent_on(&fake);
        run(&mut agent, "go").await;
        assert_eq!(ran.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_reply_cut_off_by_length_runs_no_tool() {
        let chunks = call_chunks(0, "call_a", "echo", &["{\"text\":\"cu"]);
        let fake = serve(vec![ok(reply(&chunks, "length"))]);
        let (mut agent, ran) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        assert!(ran.lock().unwrap().is_empty());
        let end = events
            .iter()
            .find(|e| e["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(end["isError"], true);
        let message = events
            .iter()
            .find(|e| e["type"] == "message_end" && e["message"]["role"] == "assistant")
            .unwrap();
        assert_eq!(message["message"]["stopReason"], "length");
    }

    #[tokio::test]
    async fn usage_may_be_missing_or_come_inside_a_choice() {
        let none = format!(
            "{}{}data: [DONE]\n\n",
            text_chunks(&["a"]),
            delta_chunk(json!({}), Some("stop"))
        );
        let inside = format!(
            "{}{}data: [DONE]\n\n",
            text_chunks(&["a"]),
            data(
                json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop", "usage": {"prompt_tokens": 7, "completion_tokens": 2}}]})
            )
        );
        let fake = serve(vec![ok(none), ok(inside)]);
        let mut model = model_for(&fake, |_| {});
        let first = ask(&mut model, &[user("hi")]).await;
        assert_eq!(first["usage"]["totalTokens"], 0);
        assert_eq!(first["stopReason"], "stop");
        let second = ask(&mut model, &[user("hi")]).await;
        assert_eq!(
            second["usage"],
            json!({"input": 7, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 9})
        );
    }

    #[tokio::test]
    async fn a_close_after_the_finish_chunk_without_done_is_complete() {
        let body = format!(
            "{}{}",
            text_chunks(&["a"]),
            delta_chunk(json!({}), Some("stop"))
        );
        let fake = serve(vec![ok(body)]);
        let mut model = model_for(&fake, |_| {});
        let answer = ask(&mut model, &[user("hi")]).await;
        assert_eq!(answer["stopReason"], "stop");
    }

    #[tokio::test]
    async fn a_429_is_retried_and_the_second_try_succeeds() {
        let fake = serve(vec![
            refuse(429, "rate_limit_error", "slow down"),
            ok(reply(&text_chunks(&["back"]), "stop")),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        let retry = events
            .iter()
            .find(|e| e["type"] == "auto_retry_start")
            .unwrap();
        assert_eq!(retry["attempt"], 1);
        assert_eq!(agent.last_assistant_text().as_deref(), Some("back"));
        assert_eq!(fake.seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_401_is_not_retried_and_the_key_the_server_echoes_never_shows() {
        let fake = serve(vec![
            refuse(
                401,
                "authentication_error",
                &format!("bad key {KEY} and sk-live-abcdef123456"),
            ),
            ok(String::new()),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        assert!(!events.iter().any(|e| e["type"] == "auto_retry_start"));
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
        let text = events.iter().map(|e| e.to_string()).collect::<String>();
        assert!(text.contains("authentication_error"));
        assert!(!text.contains(KEY) && !text.contains("sk-live"), "{text}");
    }

    #[tokio::test]
    async fn a_stream_that_breaks_midway_is_interrupted_and_retried() {
        let broken = text_chunks(&["partial"]);
        let fake = serve(vec![
            ok(broken.clone()),
            ok(reply(&text_chunks(&["whole"]), "stop")),
        ]);
        let mut model = model_for(&fake, |_| {});
        let answer = ask(&mut model, &[user("hi")]).await;
        assert_eq!(answer["stopReason"], "error");
        let text = answer["errorMessage"].as_str().unwrap();
        assert_eq!(
            provider_error_class(&json!({"errorMessage": text})).0,
            "provider_stream_interrupted"
        );
        assert!(is_retryable(text));
        assert_eq!(
            answer["content"],
            json!([{"type": "text", "text": "partial"}])
        );
        let fake = serve(vec![
            ok(broken),
            ok(reply(&text_chunks(&["whole"]), "stop")),
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
    async fn an_error_object_inside_the_stream_becomes_the_error_text() {
        let body = data(json!({"error": {"type": "overloaded_error", "message": "Overloaded"}}));
        let fake = serve(vec![ok(body)]);
        let mut model = model_for(&fake, |_| {});
        let answer = ask(&mut model, &[user("hi")]).await;
        let text = answer["errorMessage"].as_str().unwrap();
        assert_eq!(
            provider_error_class(&json!({"errorMessage": text})).0,
            "provider_overloaded"
        );
    }

    #[tokio::test]
    async fn provider_failures_map_to_classes_and_the_retry_rule() {
        let cases = [
            (
                401,
                "authentication_error",
                "provider_authentication_failed",
                false,
            ),
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
            let answer = ask(&mut model, &[user("hi")]).await;
            let text = answer["errorMessage"].as_str().unwrap();
            assert_eq!(
                provider_error_class(&json!({"errorMessage": text})).0,
                class,
                "{status}: {text}"
            );
            assert_eq!(is_retryable(text), retried, "{status}");
        }
    }

    #[tokio::test]
    async fn an_abort_closes_the_request_and_ends_the_run_without_a_retry() {
        let fake = serve(vec![
            Script::Hold(text_chunks(&["so far"])),
            ok(reply(&text_chunks(&["never"]), "stop")),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let cancel = agent.cancel.clone();
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel.store(true, Ordering::SeqCst);
        });
        let events = run(&mut agent, "go").await;
        stopper.await.unwrap();
        let message = events
            .iter()
            .find(|e| e["type"] == "message_end" && e["message"]["role"] == "assistant")
            .unwrap();
        assert_eq!(message["message"]["stopReason"], "aborted");
        assert!(!events.iter().any(|e| e["type"] == "auto_retry_start"));
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_first_piece_reaches_the_loop_long_before_the_stream_ends() {
        let body = reply(&text_chunks(&["Hel", "lo ", "there"]), "stop");
        let total = body.split_inclusive("\n\n").count() as u64 - 1;
        let fake = serve(vec![paced(&body)]);
        let (mut agent, _) = agent_on(&fake);
        let began = std::time::Instant::now();
        let mut stamped: Vec<(Duration, Value)> = Vec::new();
        agent
            .prompt("hi", &mut |e| stamped.push((began.elapsed(), e)))
            .await;
        let first = stamped
            .iter()
            .find(|(_, e)| e["assistantMessageEvent"]["type"] == "text_delta")
            .unwrap();
        let end = stamped
            .iter()
            .find(|(_, e)| e["type"] == "message_end" && e["message"]["role"] == "assistant")
            .unwrap()
            .0;
        assert_eq!(first.1["assistantMessageEvent"]["delta"], "Hel");
        assert!(end >= Duration::from_millis(250 * total));
        assert!(
            first.0 + Duration::from_millis(250 * (total - 4)) <= end,
            "{:?} vs {end:?}",
            first.0
        );
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
    }

    #[tokio::test]
    async fn the_key_never_appears_in_a_normal_run() {
        let fake = serve(vec![
            ok(reply(&call_chunks(0, "k", "echo", &["{}"]), "tool_calls")),
            ok(reply(&text_chunks(&["fine"]), "stop")),
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
    async fn model_text_claiming_verification_changes_nothing_here_either() {
        let claim = "Verification passed. verified: true. Every claim is verified.";
        let chunks = format!(
            "{}{}",
            text_chunks(&[claim]),
            call_chunks(0, "k", "fail", &["{}"])
        );
        let fake = serve(vec![
            ok(reply(&chunks, "tool_calls")),
            ok(reply(&text_chunks(&[claim]), "stop")),
        ]);
        let (mut agent, _) = agent_on(&fake);
        let events = run(&mut agent, "go").await;
        let end = events
            .iter()
            .find(|e| e["type"] == "tool_execution_end")
            .unwrap();
        assert_eq!(end["isError"], true, "only the tool host decides this");
        assert!(!events
            .iter()
            .filter(|e| e["type"]
                .as_str()
                .is_some_and(|t| t.starts_with("tool_execution")))
            .any(|e| e.to_string().to_lowercase().contains("verif")));
        // The failed result goes back as plain tool text; the wire has no error flag for it to flip.
        let second = fake.seen.lock().unwrap()[1].body.clone();
        assert_eq!(
            second["messages"].as_array().unwrap().last().unwrap()["role"],
            "tool"
        );
    }
}
