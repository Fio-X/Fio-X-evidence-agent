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
        let url = self.base_url.as_deref().unwrap_or("https://api.openai.com");

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": messages,
        });

        if let Some(tools) = tools {
            body["tools"] = serde_json::json!(tools);
        }

        let response = client
            .post(format!("{}/v1/chat/completions", url))
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

    fn parse_anthropic_response(&self, response: Value) -> Result<Response> {
        let content = response["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|block| block["type"] == "text")
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();

        let stop_reason = match response["stop_reason"].as_str() {
            Some("end_turn") => StopReason::EndTurn,
            Some("max_tokens") => StopReason::MaxTokens,
            Some("tool_use") => StopReason::ToolUse,
            _ => StopReason::EndTurn,
        };

        let tool_uses = if let Some(content_array) = response["content"].as_array() {
            content_array
                .iter()
                .filter(|item| item["type"] == "tool_use")
                .map(|item| ToolUse {
                    id: item["id"].as_str().unwrap_or("").to_string(),
                    name: item["name"].as_str().unwrap_or("").to_string(),
                    input: item["input"].clone(),
                })
                .collect()
        } else {
            vec![]
        };

        Ok(Response {
            content,
            tool_uses,
            stop_reason,
        })
    }

    fn parse_openai_response(&self, response: Value) -> Result<Response> {
        let content = response["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string();

        let stop_reason = match response["choices"][0]["finish_reason"].as_str() {
            Some("stop") => StopReason::EndTurn,
            Some("length") => StopReason::MaxTokens,
            Some("tool_calls") => StopReason::ToolUse,
            _ => StopReason::EndTurn,
        };

        let tool_uses =
            if let Some(tool_calls) = response["choices"][0]["message"]["tool_calls"].as_array() {
                tool_calls
                    .iter()
                    .map(|call| ToolUse {
                        id: call["id"].as_str().unwrap_or("").to_string(),
                        name: call["function"]["name"].as_str().unwrap_or("").to_string(),
                        input: serde_json::from_str(
                            call["function"]["arguments"].as_str().unwrap_or("{}"),
                        )
                        .unwrap_or_default(),
                    })
                    .collect()
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
}
