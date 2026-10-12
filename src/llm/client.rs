// Provider plumbing shared by the Rust agent's model adapters (anthropic_model, openai_model): provider names, endpoint
// addresses, the proxy decision for the HTTP client, and redaction of provider error text. The direct chat client
// (`news chat`, K209) is gone; nothing here sends a request.

use anyhow::{Context, Result};
#[cfg(target_os = "macos")]
use std::process::Command as StdCommand;

#[derive(Debug, Clone)]
pub enum Provider {
    Anthropic,
    OpenAI,
    /// DragonCode exposes an Anthropic Messages-compatible endpoint.
    DragonCode,
}

pub struct LLMClient {
    // kept so `LLMClient::new` keeps its shape for the model adapters; nothing reads it now that the chat client is gone
    #[allow(dead_code)]
    provider: Provider,
    api_key: String,
    base_url: Option<String>,
    // kept so `LLMClient::new` keeps its shape for the model adapters; nothing reads it now that the chat client is gone
    #[allow(dead_code)]
    model: String,
    // further values that must never appear in error text (the handed-over proxy address and its credentials)
    extra_secrets: Vec<String>,
}

/// The strings that identify a proxy with credentials: the whole address, the `user:pass` part, the user and the password.
/// An address without credentials gives only itself (and nothing shorter than 3 bytes is ever listed).
pub(crate) fn proxy_secrets(proxy: &str) -> Vec<String> {
    let proxy = proxy.trim();
    let mut out = vec![proxy.to_string()];
    let rest = proxy.split_once("://").map_or(proxy, |(_, rest)| rest);
    if let Some((userinfo, _)) = rest.rsplit_once('@') {
        out.push(userinfo.to_string());
        for part in userinfo.split(':') {
            out.push(part.to_string());
        }
    }
    // the same pieces after %-decoding (a password written p%40ss in the address is p@ss on the wire and in a library's error text)
    let decoded: Vec<String> = out.iter().map(|s| percent_decode(s)).collect();
    out.extend(decoded);
    out.retain(|s| s.len() >= 3);
    out.sort();
    out.dedup();
    out
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let pair = (bytes.get(i + 1), bytes.get(i + 2));
        if let (b'%', (Some(&h), Some(&l))) = (bytes[i], pair) {
            if let (Some(h), Some(l)) = ((h as char).to_digit(16), (l as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl LLMClient {
    pub fn new(provider: Provider, api_key: String, model: String) -> Self {
        Self {
            provider,
            api_key,
            base_url: None,
            model,
            extra_secrets: Vec::new(),
        }
    }

    pub(crate) fn with_redacted(mut self, secrets: Vec<String>) -> Self {
        self.extra_secrets = secrets;
        self
    }

    pub fn with_base_url(mut self, url: String) -> Self {
        self.base_url = Some(url);
        self
    }

    pub(crate) fn anthropic_messages_url(&self) -> String {
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

    /// The same proxy decision for a caller that sets its own timeouts (a streamed reply must not die at a whole-request timeout).
    pub(crate) fn http_client_from(mut builder: reqwest::ClientBuilder) -> Result<reqwest::Client> {
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

    pub(crate) fn safe_provider_error(&self, text: String) -> String {
        let mut redacted = if self.api_key.is_empty() {
            text
        } else {
            text.replace(&self.api_key, "[REDACTED]")
        };

        for secret in &self.extra_secrets {
            redacted = redacted.replace(secret.as_str(), "[REDACTED]");
        }

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

    // only openai_model (test builds) calls it
    #[allow(dead_code)]
    pub(crate) fn openai_chat_completions_url(&self) -> String {
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn provider_errors_redact_the_proxy_address_and_its_credentials() {
        let proxy = "http://pxuser:pxpass@127.0.0.1:9";
        let client = LLMClient::new(Provider::DragonCode, "k".to_string(), "m".to_string())
            .with_redacted(proxy_secrets(proxy));
        let safe = client.safe_provider_error(format!(
            "connect via {proxy} failed; auth pxuser:pxpass; password pxpass; user pxuser"
        ));
        for needle in ["pxuser", "pxpass", "http://pxuser"] {
            assert!(!safe.contains(needle), "{needle} leaked: {safe}");
        }
    }

    #[test]
    fn proxy_redaction_covers_the_encoded_and_the_decoded_password() {
        let proxy = "http://pxuser:p%40ss@127.0.0.1:9";
        let client = LLMClient::new(Provider::DragonCode, "k".to_string(), "m".to_string())
            .with_redacted(proxy_secrets(proxy));
        let safe = client.safe_provider_error(
            "tried pxuser:p%40ss and pxuser:p@ss; password p%40ss / p@ss".to_string(),
        );
        for needle in ["p%40ss", "p@ss", "pxuser"] {
            assert!(!safe.contains(needle), "{needle} leaked: {safe}");
        }
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
}
