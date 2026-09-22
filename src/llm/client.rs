// LLM 客户端 - Phase 1 实现示例
//
// 这个模块展示如何替换 Pi RPC，直接调用 LLM API

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(target_os = "macos")]
use std::process::Command as StdCommand;
use std::time::Duration;

#[derive(Debug, Clone)]
pub enum Provider {
    Anthropic,
    OpenAI,
    /// DragonCode exposes an Anthropic Messages-compatible endpoint.
    DragonCode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    /// Anthropic content blocks used for tool-use turns. Kept out of the
    /// OpenAI JSON representation; the provider-specific serializer decides
    /// how to encode these blocks.
    #[serde(skip)]
    anthropic_blocks: Option<Vec<Value>>,
}

impl Message {
    pub fn system(content: &str) -> Self {
        Self {
            role: "system".to_string(),
            content: content.to_string(),
            anthropic_blocks: None,
        }
    }

    pub fn user(content: &str) -> Self {
        Self {
            role: "user".to_string(),
            content: content.to_string(),
            anthropic_blocks: None,
        }
    }

    pub fn assistant(content: &str) -> Self {
        Self {
            role: "assistant".to_string(),
            content: content.to_string(),
            anthropic_blocks: None,
        }
    }

    pub fn assistant_response(content: &str, tool_uses: &[ToolUse]) -> Self {
        if tool_uses.is_empty() {
            return Self::assistant(content);
        }

        let mut blocks = Vec::with_capacity(tool_uses.len() + usize::from(!content.is_empty()));
        if !content.is_empty() {
            blocks.push(serde_json::json!({"type": "text", "text": content}));
        }
        blocks.extend(tool_uses.iter().map(|tool_use| {
            serde_json::json!({
                "type": "tool_use",
                "id": tool_use.id,
                "name": tool_use.name,
                "input": tool_use.input,
            })
        }));
        Self {
            role: "assistant".to_string(),
            content: content.to_string(),
            anthropic_blocks: Some(blocks),
        }
    }

    #[allow(dead_code)]
    pub fn tool_result(tool_use_id: &str, content: &str) -> Self {
        Self::tool_results(
            vec![serde_json::json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
            })],
            content.to_string(),
        )
    }

    /// Encode all results from one assistant tool turn in one Anthropic user
    /// message. Anthropic requires the tool_result blocks to be grouped this
    /// way; separate user messages are rejected by the strict wire contract.
    pub fn tool_results(blocks: Vec<Value>, content: String) -> Self {
        Self {
            role: "user".to_string(),
            content,
            anthropic_blocks: Some(blocks),
        }
    }

    /// Encode this provider-neutral turn for OpenAI Chat Completions. The
    /// Anthropic wire format represents tool results as content blocks inside
    /// one user message; OpenAI requires one `tool` message per result and
    /// keeps assistant tool calls on the preceding assistant message.
    fn openai_wire_messages(messages: &[Message]) -> Result<Vec<Value>> {
        let mut wire = Vec::new();
        for message in messages {
            match (message.role.as_str(), message.anthropic_blocks.as_ref()) {
                ("assistant", Some(blocks)) => {
                    let mut tool_calls = Vec::new();
                    let mut text_parts = Vec::new();
                    for block in blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = block.get("text").and_then(Value::as_str) {
                                    text_parts.push(text.to_string());
                                }
                            }
                            Some("tool_use") => {
                                let id = block
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .filter(|value| !value.is_empty())
                                    .ok_or_else(|| {
                                        anyhow::anyhow!("assistant tool_use is missing id")
                                    })?;
                                let name = block
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .filter(|value| !value.is_empty())
                                    .ok_or_else(|| {
                                        anyhow::anyhow!("assistant tool_use is missing name")
                                    })?;
                                let input = block
                                    .get("input")
                                    .filter(|value| value.is_object())
                                    .cloned()
                                    .ok_or_else(|| {
                                        anyhow::anyhow!(
                                            "assistant tool_use {name} input must be a JSON object"
                                        )
                                    })?;
                                let arguments = serde_json::to_string(&input)?;
                                tool_calls.push(serde_json::json!({
                                    "id": id,
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": arguments,
                                    }
                                }));
                            }
                            _ => {}
                        }
                    }
                    let mut value = serde_json::json!({
                        "role": "assistant",
                        "content": if text_parts.is_empty() { Value::Null } else { Value::String(text_parts.join("")) },
                    });
                    if !tool_calls.is_empty() {
                        value["tool_calls"] = Value::Array(tool_calls);
                    }
                    wire.push(value);
                }
                ("user", Some(blocks))
                    if blocks.iter().any(|block| {
                        block.get("type").and_then(Value::as_str) == Some("tool_result")
                    }) =>
                {
                    for block in blocks {
                        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                            continue;
                        }
                        let tool_call_id = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty())
                            .ok_or_else(|| anyhow::anyhow!("tool_result is missing tool_use_id"))?;
                        let content = block.get("content").cloned().unwrap_or(Value::Null);
                        let content = content
                            .as_str()
                            .map(str::to_owned)
                            .map(Ok)
                            .unwrap_or_else(|| serde_json::to_string(&content))?;
                        wire.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": content,
                        }));
                    }
                }
                _ => wire.push(serde_json::json!({
                    "role": message.role,
                    "content": message.content,
                })),
            }
        }
        Ok(wire)
    }
}

#[derive(Debug)]
pub struct ToolUse {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug)]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    ToolUse,
}

#[derive(Debug)]
pub struct Response {
    pub content: String,
    pub tool_uses: Vec<ToolUse>,
    #[allow(dead_code)]
    pub stop_reason: StopReason,
}

pub struct LLMClient {
    provider: Provider,
    api_key: String,
    base_url: Option<String>,
    model: String,
}

impl LLMClient {
    pub fn new(provider: Provider, api_key: String, model: String) -> Self {
        Self {
            provider,
            api_key,
            base_url: None,
            model,
        }
    }

    pub fn with_base_url(mut self, url: String) -> Self {
        self.base_url = Some(url);
        self
    }

    pub fn uses_openai_tools(&self) -> bool {
        matches!(self.provider, Provider::OpenAI)
    }

    /// 发送聊天请求
    pub async fn chat(&self, messages: &[Message], tools: Option<&[Value]>) -> Result<Response> {
        match self.provider {
            Provider::Anthropic => self.chat_anthropic(messages, tools).await,
            Provider::OpenAI => self.chat_openai(messages, tools).await,
            Provider::DragonCode => self.chat_anthropic(messages, tools).await,
        }
    }

    fn anthropic_messages_url(&self) -> String {
        let base = self
            .base_url
            .as_deref()
            .unwrap_or("https://api.anthropic.com")
            .trim_end_matches('/');
        if base.ends_with("/v1/messages") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{base}/messages")
        } else {
            format!("{base}/v1/messages")
        }
    }

    /// Read the active macOS HTTPS proxy without exposing its authority. This
    /// is kept local to the direct client because reqwest 0.11's automatic
    /// system-configuration discovery is unsafe in headless/CI processes.
    #[cfg(target_os = "macos")]
    fn parse_system_proxy(raw: &str) -> Option<String> {
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

    #[cfg(target_os = "macos")]
    fn configured_system_proxy() -> Option<String> {
        let output = StdCommand::new("scutil").arg("--proxy").output().ok()?;
        if !output.status.success() {
            return None;
        }
        Self::parse_system_proxy(&String::from_utf8_lossy(&output.stdout))
    }

    #[cfg(not(target_os = "macos"))]
    fn configured_system_proxy() -> Option<String> {
        None
    }

    /// Build a client using an explicit environment proxy or the active macOS
    /// system proxy. This makes the direct `news chat` route follow the same
    /// network path as the Pi RPC child while retaining safe CI behaviour.
    fn http_client() -> Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(120));
        let explicit_proxy = [
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
            "ALL_PROXY",
            "all_proxy",
        ]
        .into_iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        });
        let system_proxy = explicit_proxy
            .is_none()
            .then(Self::configured_system_proxy)
            .flatten();
        let proxy = explicit_proxy.or(system_proxy.clone());

        if let Some(proxy) = proxy {
            builder =
                builder.proxy(reqwest::Proxy::all(proxy).context("Invalid explicit HTTP proxy")?);
            if system_proxy.is_some() {
                eprintln!("[agent] network route=macOS system proxy enabled (proxy host hidden)");
            }
        } else {
            builder = builder.no_proxy();
        }

        builder
            .build()
            .context("Failed to build HTTP client without unsafe system proxy discovery")
    }

    fn safe_provider_error(&self, text: String) -> String {
        let mut redacted = if self.api_key.is_empty() {
            text
        } else {
            text.replace(&self.api_key, "[REDACTED]")
        };

        // Providers occasionally echo credential-shaped values that differ
        // from the configured key. Redact those before returning diagnostics.
        let mut output = String::with_capacity(redacted.len());
        let bytes = redacted.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            let is_key_prefix = bytes[index..].starts_with(b"sk-");
            if is_key_prefix {
                let start = index;
                index += 3;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric()
                        || bytes[index] == b'_'
                        || bytes[index] == b'-')
                {
                    index += 1;
                }
                output.push_str("[REDACTED]");
                debug_assert!(index > start);
            } else {
                let character = redacted[index..].chars().next().unwrap_or_default();
                output.push(character);
                index += character.len_utf8();
            }
        }

        redacted = output;
        const MAX_ERROR_CHARS: usize = 1_000;
        if redacted.chars().count() > MAX_ERROR_CHARS {
            redacted = redacted.chars().take(MAX_ERROR_CHARS).collect();
            redacted.push('…');
        }
        redacted
    }

    /// Anthropic API 调用
    async fn chat_anthropic(
        &self,
        messages: &[Message],
        tools: Option<&[Value]>,
    ) -> Result<Response> {
        let client = Self::http_client()?;
        let mut system = Vec::new();
        let wire_messages: Vec<Value> = messages
            .iter()
            .filter_map(|message| {
                if message.role == "system" {
                    if !message.content.is_empty() {
                        system.push(message.content.clone());
                    }
                    None
                } else {
                    let content = message
                        .anthropic_blocks
                        .clone()
                        .map(Value::Array)
                        .unwrap_or_else(|| Value::String(message.content.clone()));
                    Some(serde_json::json!({
                        "role": message.role,
                        "content": content,
                    }))
                }
            })
            .collect();
        let mut body = serde_json::json!({
            "model": self.model,
            "max_tokens": 4096,
            "messages": wire_messages,
        });

        if !system.is_empty() {
            body["system"] = Value::String(system.join("\n\n"));
        }

        if let Some(tools) = tools {
            body["tools"] = serde_json::json!(tools);
        }

        let response = client
            .post(self.anthropic_messages_url())
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("Failed to send request to Anthropic-compatible API")?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            anyhow::bail!(
                "Anthropic API error {}: {}",
                status,
                self.safe_provider_error(error_text)
            );
        }

        let response_json: Value = response
            .json()
            .await
            .context("Failed to parse Anthropic response")?;

        self.parse_anthropic_response(response_json)
    }

    /// OpenAI API 调用
    async fn chat_openai(&self, messages: &[Message], tools: Option<&[Value]>) -> Result<Response> {
        let client = Self::http_client()?;
        let url = self.openai_chat_completions_url();

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": Message::openai_wire_messages(messages)?,
        });

        if let Some(tools) = tools {
            body["tools"] = serde_json::json!(tools);
        }

        let response = client
            .post(url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("Failed to send request to OpenAI API")?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            anyhow::bail!(
                "OpenAI API error {}: {}",
                status,
                self.safe_provider_error(error_text)
            );
        }

        let response_json: Value = response
            .json()
            .await
            .context("Failed to parse OpenAI response")?;

        self.parse_openai_response(response_json)
    }

    fn openai_chat_completions_url(&self) -> String {
        let base = self
            .base_url
            .as_deref()
            .unwrap_or("https://api.openai.com")
            .trim_end_matches('/');
        if base.ends_with("/chat/completions") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        }
    }

    fn parse_anthropic_response(&self, response: Value) -> Result<Response> {
        let content_blocks = response
            .get("content")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("Anthropic response is missing a content array"))?;
        let content = content_blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("");

        let stop_reason = match response["stop_reason"].as_str() {
            Some("end_turn") => StopReason::EndTurn,
            Some("max_tokens") => StopReason::MaxTokens,
            Some("tool_use") => StopReason::ToolUse,
            _ => StopReason::EndTurn,
        };

        let tool_uses = content_blocks
            .iter()
            .filter(|item| item["type"] == "tool_use")
            .enumerate()
            .map(|(index, item)| {
                let id = item["id"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("Anthropic tool use {index} is missing id"))?;
                let name = item["name"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("Anthropic tool use {index} is missing name"))?;
                let input = item
                    .get("input")
                    .filter(|value| value.is_object())
                    .cloned()
                    .ok_or_else(|| {
                        anyhow::anyhow!("Anthropic tool use {name} input must be a JSON object")
                    })?;
                Ok(ToolUse {
                    id: id.to_string(),
                    name: name.to_string(),
                    input,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        Ok(Response {
            content,
            tool_uses,
            stop_reason,
        })
    }

    fn parse_openai_response(&self, response: Value) -> Result<Response> {
        let choice = response
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .ok_or_else(|| anyhow::anyhow!("OpenAI response is missing a choices entry"))?;
        let message = choice
            .get("message")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow::anyhow!("OpenAI response choice is missing a message object"))?;
        let content = message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        let stop_reason = match choice.get("finish_reason").and_then(Value::as_str) {
            Some("stop") => StopReason::EndTurn,
            Some("length") => StopReason::MaxTokens,
            Some("tool_calls") => StopReason::ToolUse,
            _ => StopReason::EndTurn,
        };

        let tool_uses = if let Some(tool_calls) =
            message.get("tool_calls").and_then(Value::as_array)
        {
            tool_calls
                .iter()
                .enumerate()
                .map(|(index, call)| {
                    let id = call["id"]
                        .as_str()
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| anyhow::anyhow!("OpenAI tool call {index} is missing id"))?;
                    let name = call["function"]["name"]
                        .as_str()
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            anyhow::anyhow!("OpenAI tool call {index} is missing function.name")
                        })?;
                    let arguments = call["function"]["arguments"].as_str().ok_or_else(|| {
                        anyhow::anyhow!("OpenAI tool call {name} arguments must be a JSON string")
                    })?;
                    let input: Value = serde_json::from_str(arguments).with_context(|| {
                        format!("OpenAI tool call {name} returned invalid JSON arguments")
                    })?;
                    if !input.is_object() {
                        anyhow::bail!(
                            "OpenAI tool call {name} arguments must decode to a JSON object"
                        )
                    }
                    Ok(ToolUse {
                        id: id.to_string(),
                        name: name.to_string(),
                        input,
                    })
                })
                .collect::<Result<Vec<_>>>()?
        } else {
            vec![]
        };

        Ok(Response {
            content,
            tool_uses,
            stop_reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // 需要真实的 API key
    async fn test_anthropic_chat() {
        let client = LLMClient::new(
            Provider::Anthropic,
            std::env::var("ANTHROPIC_API_KEY").unwrap(),
            "claude-sonnet-4".to_string(),
        );

        let messages = vec![Message::user("Hello, how are you?")];

        let response = client.chat(&messages, None).await.unwrap();

        assert!(!response.content.is_empty());
        println!("Response: {}", response.content);
    }

    #[test]
    fn anthropic_messages_url_does_not_duplicate_version_path() {
        let root = LLMClient::new(
            Provider::DragonCode,
            "test-key".to_string(),
            "claude-sonnet-4-6".to_string(),
        )
        .with_base_url("https://dragoncode.codes".to_string());
        assert_eq!(
            root.anthropic_messages_url(),
            "https://dragoncode.codes/v1/messages"
        );

        let versioned = LLMClient::new(
            Provider::DragonCode,
            "test-key".to_string(),
            "claude-sonnet-4-6".to_string(),
        )
        .with_base_url("https://dragoncode.codes/v1".to_string());
        assert_eq!(
            versioned.anthropic_messages_url(),
            "https://dragoncode.codes/v1/messages"
        );

        let endpoint = LLMClient::new(
            Provider::DragonCode,
            "test-key".to_string(),
            "claude-sonnet-4-6".to_string(),
        )
        .with_base_url("https://dragoncode.codes/v1/messages/".to_string());
        assert_eq!(
            endpoint.anthropic_messages_url(),
            "https://dragoncode.codes/v1/messages"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_system_proxy_without_exposing_credentials() {
        let raw = "HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 1082\nHTTPSEnable : 1\n";
        assert_eq!(
            LLMClient::parse_system_proxy(raw).as_deref(),
            Some("http://127.0.0.1:1082")
        );
        assert!(!raw.contains('@'));
        assert!(LLMClient::parse_system_proxy(
            "HTTPSEnable : 1\nHTTPSProxy : user@host\nHTTPSPort : 443\n"
        )
        .is_none());
    }

    #[test]
    fn provider_errors_redact_credentials_and_are_bounded() {
        let client = LLMClient::new(
            Provider::DragonCode,
            "configured-test-key-1234567890".to_string(),
            "test-model".to_string(),
        );
        let raw = format!(
            "configured-test-key-1234567890 sk-fixture-echo {}",
            "x".repeat(2_000)
        );
        let safe = client.safe_provider_error(raw);
        assert!(!safe.contains("configured-test-key-1234567890"));
        assert!(!safe.contains("sk-fixture-echo"));
        assert!(safe.chars().count() <= 1_001);
    }

    #[test]
    fn anthropic_tool_turn_preserves_block_order_and_groups_results() {
        let uses = vec![
            ToolUse {
                id: "tool-1".to_string(),
                name: "calculate".to_string(),
                input: serde_json::json!({"expression": "1 + 1"}),
            },
            ToolUse {
                id: "tool-2".to_string(),
                name: "create_modern_chart".to_string(),
                input: serde_json::json!({"title": "A", "chart_type": "bar", "data": []}),
            },
        ];
        let assistant = Message::assistant_response("working", &uses);
        assert_eq!(assistant.role, "assistant");
        let assistant_blocks = assistant.anthropic_blocks.expect("tool blocks");
        assert_eq!(assistant_blocks[0]["type"], "text");
        assert_eq!(assistant_blocks[1]["type"], "tool_use");
        assert_eq!(assistant_blocks[2]["id"], "tool-2");

        let results = Message::tool_results(
            vec![
                serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "content": "2"
                }),
                serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": "tool-2",
                    "content": "chart"
                }),
            ],
            "2\nchart\n".to_string(),
        );
        assert_eq!(results.role, "user");
        assert_eq!(results.anthropic_blocks.unwrap().len(), 2);
    }

    #[test]
    fn anthropic_parser_concatenates_all_text_blocks() {
        let client = LLMClient::new(
            Provider::DragonCode,
            "test-key".to_string(),
            "test-model".to_string(),
        );
        let response = client
            .parse_anthropic_response(serde_json::json!({
                "content": [
                    {"type": "text", "text": "first"},
                    {"type": "tool_use", "id": "tool-1", "name": "calculate", "input": {}},
                    {"type": "text", "text": "second"}
                ],
                "stop_reason": "tool_use"
            }))
            .expect("response should parse");
        assert_eq!(response.content, "firstsecond");
        assert_eq!(response.tool_uses.len(), 1);
    }

    #[test]
    fn openai_wire_uses_function_tools_and_tool_messages() {
        let uses = vec![ToolUse {
            id: "call-1".to_string(),
            name: "calculate".to_string(),
            input: serde_json::json!({"expression": "2 + 2"}),
        }];
        let messages = vec![
            Message::user("calculate this"),
            Message::assistant_response("working", &uses),
            Message::tool_results(
                vec![serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": "call-1",
                    "content": "4"
                })],
                "4".to_string(),
            ),
        ];
        let wire = Message::openai_wire_messages(&messages).expect("valid tool turn should encode");
        assert_eq!(wire[0]["role"], "user");
        assert_eq!(wire[1]["role"], "assistant");
        assert_eq!(wire[1]["tool_calls"][0]["type"], "function");
        assert_eq!(wire[1]["tool_calls"][0]["function"]["name"], "calculate");
        assert_eq!(
            wire[1]["tool_calls"][0]["function"]["arguments"],
            r#"{"expression":"2 + 2"}"#
        );
        assert_eq!(wire[2]["role"], "tool");
        assert_eq!(wire[2]["tool_call_id"], "call-1");
    }

    #[test]
    fn openai_url_does_not_duplicate_v1_path() {
        let root = LLMClient::new(
            Provider::OpenAI,
            "test-key".to_string(),
            "test-model".to_string(),
        );
        assert_eq!(
            root.openai_chat_completions_url(),
            "https://api.openai.com/v1/chat/completions"
        );
        let versioned = root.with_base_url("https://example.test/v1".to_string());
        assert_eq!(
            versioned.openai_chat_completions_url(),
            "https://example.test/v1/chat/completions"
        );
    }

    #[test]
    fn openai_parser_rejects_non_json_tool_arguments() {
        let client = LLMClient::new(
            Provider::OpenAI,
            "test-key".to_string(),
            "test-model".to_string(),
        );
        let error = client
            .parse_openai_response(serde_json::json!({
                "choices": [{
                    "message": {"content": null, "tool_calls": [{
                        "id": "call-1",
                        "function": {"name": "calculate", "arguments": "not-json"}
                    }]},
                    "finish_reason": "tool_calls"
                }]
            }))
            .expect_err("malformed arguments must fail closed");
        assert!(error.to_string().contains("invalid JSON arguments"));
    }

    #[test]
    fn provider_parsers_reject_malformed_tool_shapes() {
        let client = LLMClient::new(
            Provider::Anthropic,
            "test-key".to_string(),
            "test-model".to_string(),
        );
        let anthropic_error = client
            .parse_anthropic_response(serde_json::json!({
                "content": [{"type": "tool_use", "id": "call-1", "name": "calculate", "input": "{\"x\":1}"}],
                "stop_reason": "tool_use"
            }))
            .expect_err("Anthropic tool input must be an object");
        assert!(anthropic_error
            .to_string()
            .contains("input must be a JSON object"));

        let openai_error = client
            .parse_openai_response(serde_json::json!({"choices": []}))
            .expect_err("an empty choices array is not a valid provider response");
        assert!(openai_error.to_string().contains("choices entry"));
    }
}
