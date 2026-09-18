// chat 命令 - Phase 1 POC
// 直接使用 LLM API，不依赖 Pi RPC

use crate::cli::ChatArgs;
use crate::llm::{LLMClient, Message, Provider};
use anyhow::{Context, Result};

pub async fn run(args: ChatArgs) -> Result<()> {
    // 1. 确定 provider
    let provider = match args.provider.to_lowercase().as_str() {
        "anthropic" => Provider::Anthropic,
        "openai" => Provider::OpenAI,
        "dragoncode" => Provider::DragonCode,
        _ => anyhow::bail!(
            "Unsupported provider: {}. Use 'anthropic', 'openai', or 'dragoncode'.",
            args.provider
        ),
    };

    // 2. 获取 API key
    let api_key = args
        .api_key
        .or_else(|| match provider {
            Provider::Anthropic => std::env::var("ANTHROPIC_API_KEY").ok(),
            Provider::OpenAI => std::env::var("OPENAI_API_KEY").ok(),
            Provider::DragonCode => std::env::var("DRAGONCODE_API_KEY")
                .ok()
                .or_else(|| std::env::var("OPENAI_API_KEY").ok()),
        })
        .context(format!(
            "No API key found for {}. Set {} environment variable or use --api-key.",
            args.provider,
            match provider {
                Provider::Anthropic => "ANTHROPIC_API_KEY",
                Provider::OpenAI => "OPENAI_API_KEY",
                Provider::DragonCode => "DRAGONCODE_API_KEY or OPENAI_API_KEY",
            }
        ))?;

    // 3. 创建 LLM 客户端
    let mut client = LLMClient::new(provider.clone(), api_key, args.model.clone());

    let base_url = args.base_url.or_else(|| match provider {
        Provider::DragonCode => std::env::var("DRAGONCODE_BASE_URL")
            .ok()
            .or_else(|| std::env::var("OPENAI_BASE_URL").ok())
            .or_else(|| Some("https://dragoncode.codes".to_string())),
        Provider::OpenAI => std::env::var("OPENAI_BASE_URL").ok(),
        Provider::Anthropic => None,
    });
    if let Some(base_url) = base_url {
        client = client.with_base_url(base_url);
    }

    // 4. 构建消息
    let prompt = args.prompt.join(" ");
    let messages = vec![Message::user(&prompt)];

    // 5. 发送请求
    eprintln!("🤖 Calling {:?} with model {}...", provider, args.model);

    let response = client
        .chat(&messages, None)
        .await
        .context("Failed to get response from LLM")?;

    if response.content.trim().is_empty() && response.tool_uses.is_empty() {
        anyhow::bail!("LLM returned an empty response");
    }

    // 6. 输出结果
    println!("{}", response.content);

    Ok(())
}
