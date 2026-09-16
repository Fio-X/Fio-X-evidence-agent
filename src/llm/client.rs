// LLM 客户端 - Phase 1 实现示例
//
// 这个模块展示如何替换 Pi RPC，直接调用 LLM API

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone)]
pub enum Provider {
    Anthropic,
    OpenAI,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

impl Message {
    pub fn system(content: &str) -> Self {
        Self {
            role: "system".to_string(),
            content: content.to_string(),
        }
    }

    pub fn user(content: &str) -> Self {
        Self {
            role: "user".to_string(),
            content: content.to_string(),
        }
    }

    pub fn assistant(content: &str) -> Self {
        Self {
            role: "assistant".to_string(),
            content: content.to_string(),
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
    pub async fn chat(
        &self,
        messages: &[Message],
        tools: Option<&[Value]>,
    ) -> Result<Response> {
        match self.provider {
            Provider::Anthropic => self.chat_anthropic(messages, tools).await,
            Provider::OpenAI => self.chat_openai(messages, tools).await,
        }
    }

    /// Anthropic API 调用
    async fn chat_anthropic(
        &self,
        messages: &[Message],
        tools: Option<&[Value]>,
    ) -> Result<Response> {
        let client = reqwest::Client::new();
        let url = self
            .base_url
            .as_deref()
            .unwrap_or("https://api.anthropic.com");

        let mut body = serde_json::json!({
            "model": self.model,
            "max_tokens": 4096,
            "messages": messages,
        });

        if let Some(tools) = tools {
            body["tools"] = serde_json::json!(tools);
        }

        let response = client
            .post(format!("{}/v1/messages", url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .context("Failed to send request to Anthropic API")?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            anyhow::bail!("Anthropic API error {}: {}", status, error_text);
        }

        let response_json: Value = response
            .json()
            .await
            .context("Failed to parse Anthropic response")?;

        self.parse_anthropic_response(response_json)
    }

    /// OpenAI API 调用
    async fn chat_openai(
        &self,
        messages: &[Message],
        tools: Option<&[Value]>,
    ) -> Result<Response> {
        let client = reqwest::Client::new();
        let url = self
            .base_url
            .as_deref()
            .unwrap_or("https://api.openai.com");

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
            anyhow::bail!("OpenAI API error {}: {}", status, error_text);
        }

        let response_json: Value = response
            .json()
            .await
            .context("Failed to parse OpenAI response")?;

        self.parse_openai_response(response_json)
    }

    fn parse_anthropic_response(&self, response: Value) -> Result<Response> {
        let content = response["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string();

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

        let tool_uses = if let Some(tool_calls) = response["choices"][0]["message"]["tool_calls"]
            .as_array()
        {
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
}
