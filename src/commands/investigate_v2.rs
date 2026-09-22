use crate::agent::{
    create_default_registry, create_default_registry_with_visual_config,
    determine_visual_deliverable_intent, NewsroomAgent,
};
use crate::audit;
use crate::cli::InvestigateV2Args;
use crate::llm::{LLMClient, Provider};
use crate::output;
use crate::pi::{run_prompt, PiConfig};
use crate::runtime;
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};

fn provider_name(provider: &Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "anthropic",
        Provider::OpenAI => "openai",
        Provider::DragonCode => "dragoncode",
    }
}

fn preferred_visual_method(
    intent: crate::agent::VisualDeliverableIntent,
    goal: &str,
) -> &'static str {
    match intent {
        crate::agent::VisualDeliverableIntent::DataReport => "lieflat-charts",
        crate::agent::VisualDeliverableIntent::IntegratedExplainer => "scmp-integrated-explainer",
        crate::agent::VisualDeliverableIntent::VisualEssay => "pudding-visual-essay",
        crate::agent::VisualDeliverableIntent::BrowserPublication => {
            let lower = goal.to_lowercase();
            if [
                "map",
                "spatial",
                "route",
                "mechanism",
                "anatomy",
                "地图",
                "空间",
                "路线",
                "机制",
                "剖面",
            ]
            .iter()
            .any(|term| lower.contains(term))
            {
                "scmp-integrated-explainer"
            } else if [
                "scroll",
                "scrollytelling",
                "visual essay",
                "滚动",
                "视觉文章",
            ]
            .iter()
            .any(|term| lower.contains(term))
            {
                "pudding-visual-essay"
            } else {
                "lieflat-charts"
            }
        }
        crate::agent::VisualDeliverableIntent::SingleChart => "economist-analytical",
        crate::agent::VisualDeliverableIntent::None => "",
    }
}

fn verified_file_inside(root: &Path, path: &Path) -> Option<PathBuf> {
    let canonical_root = fs::canonicalize(root).ok()?;
    let canonical_path = fs::canonicalize(path).ok()?;
    if !canonical_path.starts_with(&canonical_root) {
        return None;
    }
    let metadata = fs::metadata(&canonical_path).ok()?;
    (metadata.is_file() && metadata.len() > 0).then_some(canonical_path)
}

fn find_publication_index(root: &Path) -> Option<PathBuf> {
    fn walk(root: &Path, dir: &Path) -> Option<PathBuf> {
        for entry in fs::read_dir(dir).ok()? {
            let entry = entry.ok()?;
            let path = entry.path();
            let kind = entry.file_type().ok()?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if let Some(found) = walk(root, &path) {
                    return Some(found);
                }
                continue;
            }
            if kind.is_file()
                && path.file_name().and_then(|name| name.to_str()) == Some("index.html")
                && path.strip_prefix(root).ok().is_some_and(|relative| {
                    relative.components().any(|component| {
                        component == Component::Normal(std::ffi::OsStr::new("publications"))
                    })
                })
            {
                return verified_file_inside(root, &path);
            }
        }
        None
    }

    walk(root, root)
}

fn publication_manifest_complete(manifest: &Value) -> bool {
    let completion = manifest.get("story_completion");
    let roles = completion
        .and_then(|value| value.get("story_roles_covered"))
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::HashSet<_>>()
        });
    let Some(roles) = roles else {
        return false;
    };
    let has_role = |role: &str| roles.contains(role);
    let has_context_or_evidence = has_role("context") || has_role("evidence");
    let has_turn_or_explanation = has_role("turn") || has_role("explanation");
    let bool_field =
        |name: &str| completion.and_then(|value| value.get(name)) == Some(&Value::Bool(true));
    let number_field = |name: &str| {
        completion
            .and_then(|value| value.get(name))
            .and_then(Value::as_u64)
    };
    let module_count = number_field("module_count").unwrap_or(0);
    let source_bound_module_count = number_field("source_bound_module_count").unwrap_or(0);
    let assets = completion
        .and_then(|value| value.get("verified_visual_asset_count"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let distinct_findings = completion
        .and_then(|value| value.get("distinct_findings"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let distinct_jobs = completion
        .and_then(|value| value.get("distinct_analytical_jobs"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let modules_are_bound = manifest
        .get("modules")
        .and_then(Value::as_array)
        .is_some_and(|modules| {
            modules.len() == module_count as usize
                && modules.iter().all(|module| {
                    module
                        .get("claim_ids")
                        .and_then(Value::as_array)
                        .is_some_and(|claims| !claims.is_empty())
                        && module
                            .get("source_refs")
                            .and_then(Value::as_array)
                            .is_some_and(|sources| !sources.is_empty())
                })
        });
    manifest.get("artifact_status").and_then(Value::as_str) == Some("PUBLISHABLE")
        && manifest.get("self_contained").and_then(Value::as_bool) == Some(true)
        && manifest.get("network_required").and_then(Value::as_bool) == Some(false)
        && manifest
            .get("network_requests")
            .and_then(Value::as_u64)
            .is_some_and(|requests| requests == 0)
        && manifest.get("security").and_then(|value| value.get("csp")) == Some(&Value::Bool(true))
        && completion.is_some()
        && bool_field("editorial_discovery_passed")
        && bool_field("story_graph_passed")
        && bool_field("infographic_plan_passed")
        && bool_field("infographic_rendered")
        && bool_field("infographic_critic_passed")
        && bool_field("publication_html_verified")
        && bool_field("publication_qa_passed")
        && completion.and_then(|value| value.get("single_chart_fallback"))
            == Some(&Value::Bool(false))
        && has_role("hook")
        && has_context_or_evidence
        && has_turn_or_explanation
        && has_role("resolution")
        && (4..=9).contains(&module_count)
        && source_bound_module_count == module_count
        && assets >= 2
        && distinct_findings >= 2
        && distinct_jobs >= 2
        && modules_are_bound
}

fn publication_paths(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let html = find_publication_index(root)?;
    let report = verified_file_inside(root, &root.join("report.md"))?;
    let publication_dir = html.parent()?;
    let assets_dir = publication_dir.join("assets");
    if !assets_dir.is_dir()
        || !fs::read_dir(&assets_dir)
            .ok()?
            .filter_map(|entry| entry.ok())
            .any(|entry| verified_file_inside(root, &entry.path()).is_some())
    {
        return None;
    }
    let manifest = verified_file_inside(root, &publication_dir.join("manifest.json"))?;
    let manifest_value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest).ok()?).ok()?;
    if manifest_value.get("publication_qa").and_then(Value::as_str) != Some("PASS")
        || !publication_manifest_complete(&manifest_value)
    {
        return None;
    }
    for required in ["story.json", "lieflat/selection.json"] {
        verified_file_inside(root, &root.join(required))?;
    }
    for required_dir in [
        "editorial",
        "visualizations",
        "infographics",
        "publications",
    ] {
        if !root.join(required_dir).is_dir() {
            return None;
        }
    }
    let report_text = fs::read_to_string(&report).ok()?;
    if !report_text.contains(&html.to_string_lossy().to_string())
        || !report_text.contains(&manifest.to_string_lossy().to_string())
    {
        return None;
    }
    Some((html, report))
}

fn count_model_turns(events: &Path) -> usize {
    fs::read_to_string(events)
        .ok()
        .map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|event| event.get("type").and_then(Value::as_str) == Some("turn_start"))
                .count()
        })
        .unwrap_or(0)
}

fn write_visual_metrics(
    root: &Path,
    html: &Path,
    intent: &str,
    corrective_turns: usize,
    pi_runs: usize,
    events: &Path,
) -> Result<PathBuf> {
    let manifest = html
        .parent()
        .context("publication has no parent directory")?
        .join("manifest.json");
    let manifest_value: Value =
        serde_json::from_str(&fs::read_to_string(&manifest).with_context(|| {
            format!(
                "failed to read publication manifest: {}",
                manifest.display()
            )
        })?)?;
    let completion = manifest_value
        .get("story_completion")
        .context("publication manifest has no story_completion")?;
    let roles = completion
        .get("story_roles_covered")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let event_turns = count_model_turns(events);
    let model_turns = event_turns.max(pi_runs);
    let html_bytes = fs::metadata(html)?.len();
    let metrics = json!({
        "schema_version": "1.0.0",
        "intent": intent,
        "selected_method": manifest_value.get("selected_method").and_then(Value::as_str).unwrap_or("lieflat-charts"),
        "selected_skill": manifest_value.get("selected_skill").and_then(Value::as_str).unwrap_or("lieflat-charts"),
        "selected_template": manifest_value.get("template_id").and_then(Value::as_str),
        "upstream_commit": manifest_value.get("upstream_commit").and_then(Value::as_str),
        "story_roles_covered": roles,
        "distinct_findings": completion.get("distinct_findings"),
        "distinct_analytical_jobs": completion.get("distinct_analytical_jobs"),
        "visual_asset_count": completion.get("verified_visual_asset_count"),
        "module_count": completion.get("module_count"),
        "source_bound_module_count": completion.get("source_bound_module_count"),
        "html_path": html.to_string_lossy(),
        "html_bytes": html_bytes,
        "self_contained": manifest_value.get("self_contained"),
        "network_requests": manifest_value.get("network_requests"),
        "desktop_qa": manifest_value.get("desktop_qa"),
        "mobile_qa": manifest_value.get("mobile_qa"),
        "model_turns": model_turns,
        "corrective_turns": corrective_turns,
        "pi_runs": pi_runs,
    });
    let canonical_root = fs::canonicalize(root)?;
    let path = canonical_root.join("visual-metrics.json");
    if path.exists() {
        anyhow::bail!("visual metrics path already exists: {}", path.display());
    }
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&metrics)?),
    )
    .with_context(|| format!("failed to write visual metrics: {}", path.display()))?;
    let canonical_path = fs::canonicalize(&path)?;
    if !canonical_path.starts_with(&canonical_root)
        || !fs::metadata(&canonical_path)?.is_file()
        || fs::metadata(&canonical_path)?.len() == 0
    {
        anyhow::bail!("visual metrics artifact failed run-root verification");
    }
    Ok(canonical_path)
}

async fn run_visual_story(
    provider: Provider,
    api_key: String,
    model: String,
    base_url: Option<String>,
    run_dir: PathBuf,
    goal: String,
    preferred_method: &'static str,
) -> Result<()> {
    fs::create_dir_all(run_dir.join("session"))?;
    let extension = runtime::materialize_extension(&run_dir)?;
    let provider_text = provider_name(&provider).to_string();
    let binary = std::env::var_os("NEWSROOM_PI_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("pi"));
    let thinking = std::env::var("NEWSROOM_PI_THINKING").ok();
    let mut config = PiConfig {
        binary,
        provider: Some(provider_text),
        model: Some(model),
        api_key: Some(api_key),
        base_url,
        thinking,
        approve_project: false,
        extension: Some(extension),
        artifact_dir: Some(run_dir.clone()),
        session_dir: Some(run_dir.join("session")),
        continue_session: false,
        tool_profile: "visual-story".to_string(),
    };
    let events = run_dir.join("events.jsonl");
    let prompt = format!(
        "你正在执行 Fio-X visual-story rich visual pipeline。原始用户目标只能按已确定的 {intent} 意图处理：{goal}\n本次确定性编辑方法是 {preferred_method}；先调用 newsroom_visual_skill 加载该方法，再按该方法的读者任务执行。\n\n必须完成真实证据调研、editorial discovery、通过 lint 的 Story Graph、4–9 个不重复且有顺序的模块、至少两个不同 analytical job、至少两个真实视觉/解释资产、infographic plan/lint/render/critic、固定版本 Lieflat catalog/render 或对应专业方法，以及 publication QA。报告类请求必须写入当前 NEWSROOM_ARTIFACT_DIR 下真实非空的 publications/<hash>/index.html、manifest.json 和 report.md；工具之外的 fenced HTML/SVG/JS 文本不算 artifact。对于 Lieflat render，传入 method_skill={preferred_method} 以便 manifest 记录方法；不要把全部 Skill 正文放进提示词，也不要使用 synthetic data、模板演示数据、Moxt/CDN。最终只需汇报已验证的路径和状态。",
        intent = determine_visual_deliverable_intent(&goal).as_str(),
        goal = goal,
        preferred_method = preferred_method,
    );

    audit::append_user_goal_event(&events, "initial")?;
    let first = run_prompt(&config, &prompt, Some(&events)).await?;
    let mut final_text = first.text;
    let mut corrective_turns = 0usize;
    let mut pi_runs = 1usize;
    if publication_paths(&run_dir).is_none() {
        corrective_turns = 1;
        let correction = "Artifact completion check failed. This is the one allowed corrective turn: continue using the real visual-story tools now. A source-code response or a natural-language saved-to path is not an artifact. Complete Story Graph, evidence-bound modules, infographic critic, and write a verified non-empty publications/<hash>/index.html plus report.md under the run root; if evidence is insufficient, fail clearly instead of inventing modules.";
        config.continue_session = true;
        let retry = run_prompt(&config, correction, Some(&events)).await?;
        final_text = retry.text;
        pi_runs += 1;
    }
    let (html, report) = publication_paths(&run_dir).ok_or_else(|| {
        anyhow::anyhow!(
            "visual-story completion failed after {corrective_turns} corrective turn(s): no publishable HTML/report pair under {}",
            run_dir.display()
        )
    })?;
    let metrics = write_visual_metrics(
        &run_dir,
        &html,
        determine_visual_deliverable_intent(&goal).as_str(),
        corrective_turns,
        pi_runs,
        &events,
    )?;
    fs::write(
        run_dir.join("assistant-answer.md"),
        format!("{final_text}\n"),
    )?;

    println!("\n{}", "=".repeat(80));
    println!("{final_text}");
    println!("publication: {}", html.display());
    println!("report: {}", report.display());
    println!("metrics: {}", metrics.display());
    println!("{}", "=".repeat(80));
    eprintln!("publication: {}", html.display());
    eprintln!("report: {}", report.display());
    eprintln!("metrics: {}", metrics.display());
    Ok(())
}

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

    let goal = args.topic.join(" ");
    let intent = determine_visual_deliverable_intent(&goal);
    let base_url = args.base_url.clone().or_else(|| match provider {
        Provider::DragonCode => std::env::var("DRAGONCODE_BASE_URL")
            .ok()
            .or_else(|| std::env::var("OPENAI_BASE_URL").ok())
            .or_else(|| Some("https://dragoncode.codes".to_string())),
        Provider::OpenAI => std::env::var("OPENAI_BASE_URL").ok(),
        Provider::Anthropic => None,
    });
    if intent.requires_story() {
        eprintln!("🎯 Goal: {goal}");
        eprintln!("🧭 Deterministic visual intent: {}", intent.as_str());
        eprintln!("🚀 Starting direct visual-story runner...\n");
        let preferred_method = preferred_visual_method(intent, &goal);
        return run_visual_story(
            provider,
            api_key,
            args.model,
            base_url,
            run_dir,
            goal,
            preferred_method,
        )
        .await;
    }

    // 3. 创建轻量 LLM 客户端；普通文字和单图路径保持原有回合数。
    let mut client = LLMClient::new(provider.clone(), api_key.clone(), args.model.clone());
    if let Some(ref base_url) = base_url {
        client = client.with_base_url(base_url.clone());
    }

    // 4. 创建工具注册表
    let tools = if intent == crate::agent::VisualDeliverableIntent::SingleChart {
        create_default_registry_with_visual_config(
            provider_name(&provider).to_string(),
            args.model.clone(),
            Some(api_key.clone()),
            base_url.clone(),
        )
    } else {
        create_default_registry()
    };
    eprintln!(
        "🔧 Loaded {} tools: {}",
        tools.list_tools().len(),
        tools.list_tools().join(", ")
    );

    // 5. 创建 agent
    eprintln!("🎯 Goal: {}\n", goal);

    let mut agent = NewsroomAgent::new(client, tools, goal).with_run_root(run_dir.clone());

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
