use crate::agent::{create_default_registry, NewsroomAgent};
use crate::cli::InvestigateV2Args;
use crate::llm::{LLMClient, Provider};
use crate::output;
use anyhow::{Context, Result};
use std::fs;

pub async fn run(args: InvestigateV2Args) -> Result<()> {
    let output_root = output::resolve_output_dir(&args.out)?;
    output::announce_and_confirm(&output_root, args.confirm_output)?;

    // 1. 解析 provider
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
        .ok_or_else(|| {
            let env_var = match provider {
                Provider::Anthropic => "ANTHROPIC_API_KEY",
                Provider::OpenAI => "OPENAI_API_KEY",
                Provider::DragonCode => "DRAGONCODE_API_KEY or OPENAI_API_KEY",
            };
            anyhow::anyhow!(
                "No API key found. Set {} environment variable or use --api-key.",
                env_var
            )
        })?;

    let run_dir = output::create_run_dir(&output_root, &args.topic.join(" "))?;
    // The V2 tools run in this process and can therefore share one explicit,
    // user-visible destination without adding paths to model prompts.
    std::env::set_var("NEWSROOM_OUTPUT_DIR", &run_dir);

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

    // 4. 创建工具注册表
    let tools = create_default_registry();
    eprintln!(
        "🔧 Loaded {} tools: {}",
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

    let report_path = run_dir.join("report.md");
    fs::write(&report_path, format!("{report}\n"))
        .with_context(|| format!("failed to write {}", report_path.display()))?;

    // 7. 输出报告
    println!("\n{}", "=".repeat(80));
    println!("{}", report);
    println!("{}", "=".repeat(80));
    eprintln!("report: {}", report_path.display());

    Ok(())
}
