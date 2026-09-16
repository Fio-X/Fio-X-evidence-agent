// chat 命令 - Phase 1 POC
// 直接使用 LLM API，不依赖 Pi RPC

use anyhow::{Context, Result};
use crate::cli::ChatArgs;
use crate::llm::{LLMClient, Message, Provider};

pub async fn run(args: ChatArgs) -> Result<()> {
    // 1. 确定 provider
    let provider = match args.provider.to_lowercase().as_str() {
        "anthropic" => Provider::Anthropic,
        "openai" => Provider::OpenAI,
        _ => anyhow::bail!("Unsupported provider: {}. Use 'anthropic' or 'openai'.", args.provider),
    };

    // 2. 获取 API key
    let api_key = args.api_key.or_else(|| {
        match provider {
            Provider::Anthropic => std::env::var("ANTHROPIC_API_KEY").ok(),
            Provider::OpenAI => std::env::var("OPENAI_API_KEY").ok(),
        }
    }).context(format!(
        "No API key found for {}. Set {} environment variable or use --api-key.",
        args.provider,
        match provider {
            Provider::Anthropic => "ANTHROPIC_API_KEY",
            Provider::OpenAI => "OPENAI_API_KEY",
        }
    ))?;

    // 3. 创建 LLM 客户端
    let mut client = LLMClient::new(provider.clone(), api_key, args.model.clone());

    if let Some(base_url) = args.base_url {
        client = client.with_base_url(base_url);
    }

    // 4. 构建消息
    let prompt = args.prompt.join(" ");
    let messages = vec![Message::user(&prompt)];

    // 5. 发送请求
    eprintln!("🤖 Calling {:?} with model {}...", provider, args.model);

    let response = client.chat(&messages, None).await
        .context("Failed to get response from LLM")?;

    // 6. 输出结果
    println!("{}", response.content);

    Ok(())
}
