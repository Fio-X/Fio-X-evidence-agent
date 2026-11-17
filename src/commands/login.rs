// `news login`: save one model provider, model and key to the user's credentials file (TOML, permissions 600), test the key with a
// one-token request first, show the saved login with the key masked, or remove it. The key is read from the terminal with echo off, or from
// standard input with --key-stdin; it is never a command-line argument, never put in a child's environment, and never printed.

use crate::cli::LoginArgs;
use crate::config::{self, SavedLogin};
use anyhow::{bail, Context, Result};
use std::io::{BufRead, IsTerminal, Write};
use std::time::Duration;

const DEFAULT_ANTHROPIC_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_DRAGONCODE_URL: &str = "https://dragoncode.codes";

/// One choice of the provider menu.
struct Choice {
    /// Name accepted by --provider.
    name: &'static str,
    label: &'static str,
    /// What goes into the credentials file (`custom` is an Anthropic Messages-compatible endpoint).
    saved_as: &'static str,
    key_page: Option<&'static str>,
    default_model: &'static str,
    /// None: the provider's own address is used unless one is given. Some(""): an address must be given.
    default_base_url: Option<&'static str>,
}

const CHOICES: &[Choice] = &[
    Choice {
        name: "anthropic",
        label: "Anthropic (Claude API)",
        saved_as: "anthropic",
        key_page: Some("https://console.anthropic.com/settings/keys"),
        default_model: DEFAULT_ANTHROPIC_MODEL,
        default_base_url: None,
    },
    Choice {
        name: "dragoncode",
        label: "DragonCode",
        saved_as: "dragoncode",
        key_page: None,
        default_model: DEFAULT_ANTHROPIC_MODEL,
        default_base_url: Some(DEFAULT_DRAGONCODE_URL),
    },
    Choice {
        name: "custom",
        label: "Custom endpoint (Anthropic Messages-compatible)",
        saved_as: "anthropic",
        key_page: None,
        default_model: DEFAULT_ANTHROPIC_MODEL,
        default_base_url: Some(""),
    },
];

fn choice_named(name: &str) -> Option<&'static Choice> {
    CHOICES
        .iter()
        .find(|c| c.name.eq_ignore_ascii_case(name.trim()))
}

pub async fn run(args: LoginArgs) -> Result<()> {
    let path = config::credentials_path()
        .context("neither XDG_CONFIG_HOME nor HOME is set; cannot place the credentials file")?;
    if args.show {
        return show(&path);
    }
    if args.clear {
        return clear(&path);
    }
    let interactive = !args.key_stdin && std::io::stdin().is_terminal();
    if !interactive && !args.key_stdin {
        bail!(
            "standard input is not a terminal: pass --key-stdin and send the key on standard input"
        );
    }
    let mut input = Input::new(interactive);

    let choice = match &args.provider {
        Some(name) => choice_named(name).with_context(|| {
            format!("unknown provider `{name}`; use one of: anthropic, dragoncode, custom")
        })?,
        None if interactive => ask_provider(&mut input)?,
        None => &CHOICES[0],
    };
    let base_url = match (&args.base_url, choice.default_base_url) {
        (Some(url), _) => Some(url.trim().to_string()),
        (None, Some(default)) if interactive => {
            let answer = input.ask(&prompt_with_default("Endpoint URL", default))?;
            Some(if answer.is_empty() {
                default.to_string()
            } else {
                answer
            })
        }
        (None, Some(default)) => Some(default.to_string()),
        (None, None) => None,
    }
    .filter(|url| !url.is_empty());
    if choice.default_base_url == Some("") && base_url.is_none() {
        bail!("the custom provider needs an endpoint URL (--base-url)");
    }
    if let Some(url) = &base_url {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            bail!("the endpoint URL must start with https:// or http://");
        }
    }

    if interactive {
        offer_key_page(&mut input, choice, args.no_browser)?;
    }
    let model = match &args.model {
        Some(model) => model.trim().to_string(),
        None if interactive => {
            let answer = input.ask(&prompt_with_default("Model", choice.default_model))?;
            if answer.is_empty() {
                choice.default_model.to_string()
            } else {
                answer
            }
        }
        None => choice.default_model.to_string(),
    };

    loop {
        let api_key = if interactive {
            input.ask_hidden("Paste your API key: ")?
        } else {
            input.line()?
        };
        if api_key.is_empty() {
            bail!("no API key was given");
        }
        if api_key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            bail!("the API key contains spaces or control characters; paste it again without them");
        }
        let login = SavedLogin {
            provider: choice.saved_as.to_string(),
            model: Some(model.clone()),
            base_url: base_url.clone(),
            api_key,
        };
        eprintln!("Testing the connection...");
        match test_connection(&login).await {
            Ok(()) => {
                println!("✓ Connection test passed");
                config::write_credentials(&path, &login)?;
                println!(
                    "✓ Saved to {} (provider {}, model {})",
                    path.display(),
                    login.provider,
                    model
                );
                if config::MODEL_KEY_NAMES
                    .iter()
                    .any(|name| std::env::var_os(name).is_some_and(|v| !v.is_empty()))
                    && !config::saved_login_in_use()
                {
                    println!("Note: a key from your shell or .env is set; it takes precedence over this saved login.");
                }
                return Ok(());
            }
            Err(error) => {
                eprintln!("✗ Connection test failed: {error:#}");
                if !interactive || !input.yes("Try another key?")? {
                    bail!("nothing was saved");
                }
            }
        }
    }
}

fn show(path: &std::path::Path) -> Result<()> {
    if !path.exists() {
        println!(
            "No saved login ({} does not exist). Run `news login` to add one.",
            path.display()
        );
        return Ok(());
    }
    let Some(login) = config::read_credentials(path)? else {
        println!(
            "{} has no [default] login with a key. Run `news login` to add one.",
            path.display()
        );
        return Ok(());
    };
    println!("File:     {}", path.display());
    println!("Provider: {}", login.provider);
    println!(
        "Model:    {}",
        login.model.as_deref().unwrap_or("(default)")
    );
    if let Some(url) = &login.base_url {
        println!("Endpoint: {url}");
    }
    println!("API key:  {}", config::mask_key(&login.api_key));
    if !config::saved_login_in_use() {
        println!("In use:   no (a key from your shell or .env takes precedence)");
    } else {
        println!("In use:   yes");
    }
    Ok(())
}

fn clear(path: &std::path::Path) -> Result<()> {
    match crate::group_guard::remove_private_file(path) {
        Ok(()) => println!("Removed {}", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            println!(
                "No saved login to remove ({} does not exist).",
                path.display()
            )
        }
        Err(error) => {
            return Err(error).with_context(|| format!("cannot remove {}", path.display()))
        }
    }
    Ok(())
}

fn prompt_with_default(label: &str, default: &str) -> String {
    format!("{label} (default {default}): ")
}

fn ask_provider(input: &mut Input) -> Result<&'static Choice> {
    println!("Choose an LLM provider:");
    for (index, choice) in CHOICES.iter().enumerate() {
        println!("  {}. {}", index + 1, choice.label);
    }
    loop {
        let answer = input.ask("Number (default 1): ")?;
        if answer.is_empty() {
            return Ok(&CHOICES[0]);
        }
        if let Some(choice) = answer
            .parse::<usize>()
            .ok()
            .and_then(|n| n.checked_sub(1))
            .and_then(|i| CHOICES.get(i))
            .or_else(|| choice_named(&answer))
        {
            return Ok(choice);
        }
        println!("Please enter a number from 1 to {}.", CHOICES.len());
    }
}

fn offer_key_page(input: &mut Input, choice: &Choice, no_browser: bool) -> Result<()> {
    let Some(page) = choice.key_page else {
        println!("Get an API key from your {} account.", choice.label);
        return Ok(());
    };
    println!("Get an API key here: {page}");
    if no_browser {
        return Ok(());
    }
    let answer = input.ask("Press Enter to open it in your browser, or type s to skip: ")?;
    if answer.is_empty() {
        open_in_browser(page);
    }
    Ok(())
}

/// Open a fixed key page; a failure only prints the link again.
fn open_in_browser(url: &str) {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let status = std::process::Command::new(opener)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if !status.is_ok_and(|s| s.success()) {
        println!("Could not open a browser; visit {url} yourself.");
    }
}

/// One request of at most one output token. Only the HTTP status and the provider's error type are reported; the reply body is never
/// printed, because a provider may echo the key back.
async fn test_connection(login: &SavedLogin) -> Result<()> {
    let model = login.model.clone().unwrap_or_default();
    let url = messages_url(login.base_url.as_deref().unwrap_or(ANTHROPIC_URL));
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
    // An explicit proxy from the environment is used, except for a local endpoint; nothing else is discovered.
    builder = match proxy_from_env().filter(|_| !is_local(&url)) {
        Some(proxy) => builder.proxy(
            reqwest::Proxy::all(proxy)
                .context("the proxy in HTTPS_PROXY/HTTP_PROXY/ALL_PROXY is not a valid URL")?,
        ),
        None => builder.no_proxy(),
    };
    let http = builder.build().context("cannot build the HTTP client")?;
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "ping"}],
    });
    let request = http
        .post(&url)
        .header("x-api-key", &login.api_key)
        .header("anthropic-version", "2023-06-01");
    let response = request.json(&body).send().await.map_err(|error| {
        let kind = if error.is_timeout() {
            "timed out"
        } else if error.is_connect() {
            "could not connect"
        } else {
            "request failed"
        };
        anyhow::anyhow!("{kind} (check the endpoint URL, your network or proxy)")
    })?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let error_type = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| {
            v["error"]["type"]
                .as_str()
                .or_else(|| v["error"]["code"].as_str())
                .map(str::to_string)
        })
        .filter(|t| {
            t.len() <= 64
                && !t.starts_with("sk-")
                && !login.api_key.contains(t.as_str())
                && t.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        });
    let hint = match status.as_u16() {
        401 | 403 => "the key was not accepted",
        404 => "the endpoint or model was not found",
        429 => "rate limited or out of credit",
        _ => "the provider refused the request",
    };
    match error_type {
        Some(t) => bail!("HTTP {} ({t}): {hint}", status.as_u16()),
        None => bail!("HTTP {}: {hint}", status.as_u16()),
    }
}

const ANTHROPIC_URL: &str = "https://api.anthropic.com";

/// The Messages address for a base URL given with or without `/v1` or `/v1/messages`.
fn messages_url(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.ends_with("/v1/messages") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn proxy_from_env() -> Option<String> {
    [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]
    .into_iter()
    .find_map(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()))
}

fn is_local(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1"))
}

/// Lines from standard input, with prompts on standard error.
struct Input {
    interactive: bool,
    stdin: std::io::StdinLock<'static>,
}

impl Input {
    fn new(interactive: bool) -> Self {
        Self {
            interactive,
            stdin: std::io::stdin().lock(),
        }
    }

    fn line(&mut self) -> Result<String> {
        let mut line = String::new();
        self.stdin
            .read_line(&mut line)
            .context("cannot read standard input")?;
        Ok(line.trim().to_string())
    }

    fn ask(&mut self, prompt: &str) -> Result<String> {
        eprint!("{prompt}");
        std::io::stderr().flush().ok();
        self.line()
    }

    fn yes(&mut self, question: &str) -> Result<bool> {
        let answer = self.ask(&format!("{question} [Y/n] "))?;
        Ok(!answer.to_ascii_lowercase().starts_with('n'))
    }

    /// Read one line with the terminal's echo off; echo comes back even when reading fails.
    fn ask_hidden(&mut self, prompt: &str) -> Result<String> {
        eprint!("{prompt}");
        std::io::stderr().flush().ok();
        let _echo = self.interactive.then(EchoOff::new).flatten();
        let line = self.line();
        drop(_echo);
        eprintln!();
        line
    }
}

/// Turns terminal echo off until dropped.
#[cfg(unix)]
struct EchoOff(libc::termios);

#[cfg(unix)]
impl EchoOff {
    fn new() -> Option<Self> {
        // SAFETY: tcgetattr/tcsetattr on fd 0 with a zeroed termios that tcgetattr fills in.
        unsafe {
            let mut term: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut term) != 0 {
                return None;
            }
            let saved = term;
            term.c_lflag &= !libc::ECHO;
            if libc::tcsetattr(0, libc::TCSANOW, &term) != 0 {
                return None;
            }
            Some(Self(saved))
        }
    }
}

#[cfg(unix)]
impl Drop for EchoOff {
    fn drop(&mut self) {
        // SAFETY: restores the attributes read in `new`.
        unsafe {
            libc::tcsetattr(0, libc::TCSANOW, &self.0);
        }
    }
}

#[cfg(not(unix))]
struct EchoOff;

#[cfg(not(unix))]
impl EchoOff {
    fn new() -> Option<Self> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_menu_choice_saves_a_provider_the_config_reads() {
        for choice in CHOICES {
            assert!(
                config::provider_names(choice.saved_as).is_some(),
                "{}",
                choice.name
            );
            assert_eq!(choice_named(choice.name).map(|c| c.name), Some(choice.name));
        }
        assert!(choice_named("nosuch").is_none());
        // the built-in agent speaks only Anthropic Messages, so no other route is offered or saved
        assert!(choice_named("openai").is_none());
        assert!(config::provider_names("openai").is_none());
    }

    #[test]
    fn the_messages_address_and_the_local_test_follow_the_base_url() {
        for base in [
            "https://h",
            "https://h/",
            "https://h/v1",
            "https://h/v1/messages",
        ] {
            assert_eq!(messages_url(base), "https://h/v1/messages", "{base}");
        }
        assert!(
            is_local("http://127.0.0.1:9/v1/messages") && is_local("http://localhost/v1/messages")
        );
        assert!(!is_local("https://api.anthropic.com/v1/messages"));
    }

    const KEY: &str = "sk-fake-login-0123456789abcdef";

    /// A one-shot local server: answers the first request with `status` and a body that echoes the key, and hands back the request head.
    async fn fake_server(status: u16) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                seen.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&seen).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if seen.len() >= end + 4 + length || n == 0 {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let body = format!("{{\"error\":{{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key {KEY}\"}}}}");
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&seen).to_ascii_lowercase()
        });
        (url, task)
    }

    fn login_for(provider: &str, url: &str) -> SavedLogin {
        SavedLogin {
            provider: provider.into(),
            model: Some("m-1".into()),
            base_url: Some(url.into()),
            api_key: KEY.into(),
        }
    }

    #[tokio::test]
    async fn the_test_request_is_one_token_to_the_messages_route_with_the_key_in_a_header() {
        let (url, seen) = fake_server(200).await;
        test_connection(&login_for("anthropic", &url))
            .await
            .unwrap();
        let seen = seen.await.unwrap();
        assert!(seen.starts_with("post /v1/messages "), "{seen}");
        assert!(seen.contains(&format!("x-api-key: {KEY}")));
        assert!(seen.contains("\"max_tokens\":1"));
    }

    #[tokio::test]
    async fn a_refused_key_reports_status_and_type_but_never_the_key_the_server_echoes() {
        let (url, _seen) = fake_server(401).await;
        let error = format!(
            "{:#}",
            test_connection(&login_for("anthropic", &url))
                .await
                .unwrap_err()
        );
        assert!(
            error.contains("HTTP 401") && error.contains("authentication_error"),
            "{error}"
        );
        assert!(
            !error.contains(KEY) && !error.contains(&KEY[..8]),
            "{error}"
        );
    }

    #[tokio::test]
    async fn an_unreachable_endpoint_says_so_without_the_key() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let error = format!(
            "{:#}",
            test_connection(&login_for("anthropic", &url))
                .await
                .unwrap_err()
        );
        assert!(error.contains("could not connect"), "{error}");
        assert!(!error.contains(KEY));
    }
}
