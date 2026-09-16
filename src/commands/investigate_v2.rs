use anyhow::Result;
use crate::cli::InvestigateV2Args;
use crate::llm::{LLMClient, Provider};
use crate::agent::{NewsroomAgent, create_default_registry};

pub async fn run(args: InvestigateV2Args) -> Result<()> {
    // 1. 解析 provider
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
    }).ok_or_else(|| {
        let env_var = match provider {
            Provider::Anthropic => "ANTHROPIC_API_KEY",
            Provider::OpenAI => "OPENAI_API_KEY",
        };
        anyhow::anyhow!("No API key found. Set {} environment variable or use --api-key.", env_var)
    })?;

    // 3. 创建 LLM 客户端
    let mut client = LLMClient::new(provider, api_key, args.model.clone());
    if let Some(base_url) = args.base_url {
        client = client.with_base_url(base_url);
    }

    // 4. 创建工具注册表
    let tools = create_default_registry();
    eprintln!("🔧 Loaded {} tools: {}",
        tools.list_tools().len(),
        tools.list_tools().join(", ")
    );

    // 5. 创建 agent
    let goal = args.topic.join(" ");
    eprintln!("🎯 Goal: {}\n", goal);

    let mut agent = NewsroomAgent::new(client, tools, goal);

    // 6. 执行调查
    eprintln!("🚀 Starting investigation...\n");
    let report = agent.investigate().await?;

    // 7. 输出报告
    println!("\n{}", "=".repeat(80));
    println!("{}", report);
    println!("{}", "=".repeat(80));

    Ok(())
}
