use crate::artifact::InvestigationBundle;
use crate::audit;
use crate::cli::InvestigateArgs;
use crate::pi::{run_prompt, PiConfig, PiRunResult};
use crate::{output, prompt, runtime};
use anyhow::{bail, Result};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::path::{Component, Path};
use std::time::Instant;

fn complex_visual_routing_ab_enabled() -> bool {
    matches!(
        std::env::var("NEWSROOM_COMPLEX_VISUAL_ROUTING_AB")
            .ok()
            .as_deref(),
        Some("1" | "true" | "split")
    )
}

/// Mirrors runtime/pi/newsroom.ts: phone-facing pages (the infographic
/// mobile page and mobile publication widths) exist only when
/// NEWSROOM_MOBILE_PAGES is exactly "1". Otherwise a PNG request is met by
/// the desktop render alone rather than the desktop/mobile pair.
fn mobile_pages_enabled() -> bool {
    std::env::var("NEWSROOM_MOBILE_PAGES").ok().as_deref() == Some("1")
}

fn is_complex_visual_request(topic: &str, split_classifier: bool) -> bool {
    if split_classifier {
        prompt::is_complex_visual_request_split(topic)
    } else {
        prompt::is_complex_visual_request(topic)
    }
}

fn effective_tool_profile(requested: &str, topic: &str, split_classifier: bool) -> String {
    if requested != "investigate" {
        return requested.to_string();
    }
    if is_complex_visual_request(topic, split_classifier) {
        "visual-story".to_string()
    } else if prompt::is_visual_request(topic) {
        "visual".to_string()
    } else {
        requested.to_string()
    }
}

/// Whether completion must go through the measured infographic, publication
/// and browser-QA chain. The goal text can only add this requirement; an
/// explicit visual-story tool profile adds it regardless of the wording.
fn completion_chain_required(topic: &str, split_classifier: bool, profile: Option<&str>) -> bool {
    is_complex_visual_request(topic, split_classifier) || profile == Some("visual-story")
}

fn visual_completion_gaps(
    bundle: &InvestigationBundle,
    topic: &str,
    audit: &audit::AuditSummary,
    split_classifier: bool,
) -> Result<Vec<String>> {
    // The effective profile is what the Pi run recorded, so an explicit
    // `--tool-profile visual-story` is seen here without touching the run loop.
    let profile = bundle.recorded_tool_profile();
    visual_completion_gaps_for_profile(bundle, topic, audit, split_classifier, profile.as_deref())
}

fn visual_completion_gaps_for_profile(
    bundle: &InvestigationBundle,
    topic: &str,
    audit: &audit::AuditSummary,
    split_classifier: bool,
    profile: Option<&str>,
) -> Result<Vec<String>> {
    let successful_tool = |name: &str| {
        audit
            .calls
            .iter()
            .any(|call| call.tool == name && call.is_error != Some(true))
    };
    let required_pngs = match (prompt::requires_png(topic), mobile_pages_enabled()) {
        (false, _) => 0,
        (true, false) => 1,
        (true, true) => 2,
    };
    let mut gaps = bundle.visual_delivery_gaps(prompt::requires_html(topic), required_pngs)?;
    if completion_chain_required(topic, split_classifier, profile) {
        for tool in [
            "newsroom_infographic_plan",
            "newsroom_infographic_lint",
            "newsroom_infographic_render",
            "newsroom_infographic_critic",
            "newsroom_publication_plan",
            "newsroom_publication_render",
            "newsroom_publication_qa",
        ] {
            if !successful_tool(tool) {
                gaps.push(format!("required complex-visual gate did not pass: {tool}"));
            }
        }
        if let Some(reason) = bundle.measured_publication_gap()? {
            gaps.push(format!("no measured publication: {reason}"));
        }
        gaps.extend(requested_visual_mode_gaps(bundle, topic, audit));
    }
    Ok(gaps)
}

fn requested_visual_mode_gaps(
    bundle: &InvestigationBundle,
    topic: &str,
    audit: &audit::AuditSummary,
) -> Vec<String> {
    let required = prompt::required_visual_modes(topic);
    if required.is_empty() {
        return Vec::new();
    }
    let Some(render) = audit
        .calls
        .iter()
        .rev()
        .find(|call| call.tool == "newsroom_infographic_render" && call.is_error != Some(true))
    else {
        // Nothing was rendered, so every requested mode (a requested map
        // included) is still missing.
        return missing_visual_modes(topic, &Value::Null);
    };
    let Some(plan_ref) = render.args.get("plan_ref").and_then(Value::as_str) else {
        return vec!["rendered infographic is missing its plan_ref".to_string()];
    };
    let relative = Path::new(plan_ref);
    if !plan_ref.starts_with("infographics/plans/")
        || relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return vec!["rendered infographic has an invalid plan_ref".to_string()];
    }
    let plan: Value = match fs::read(bundle.dir.join(relative))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(plan) => plan,
        None => return vec!["rendered infographic plan cannot be audited".to_string()],
    };
    missing_visual_modes(topic, &plan)
}

fn missing_visual_modes(topic: &str, plan: &Value) -> Vec<String> {
    let present: HashSet<&str> = plan
        .get("modules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|module| module.get("visual_grammar").and_then(Value::as_str))
        .collect();
    prompt::required_visual_modes(topic)
        .into_iter()
        .filter(|(_, accepted)| !accepted.iter().any(|grammar| present.contains(grammar)))
        .map(|(label, accepted)| {
            format!(
                "explicitly requested visual mode is absent from the rendered infographic: {label} (expected visual_grammar: {})",
                accepted.join(" or ")
            )
        })
        .collect()
}

fn is_transient_completion_provider_error(error: &anyhow::Error) -> bool {
    error
        .to_string()
        .contains("Pi returned an empty final answer")
}

async fn run_prompt_with_empty_recovery(
    config: &PiConfig,
    prompt: &str,
    recovery_prompt: &str,
    event_log: &Path,
) -> Result<PiRunResult> {
    match run_prompt(config, prompt, Some(event_log)).await {
        Ok(result) => Ok(result),
        Err(error) if is_transient_completion_provider_error(&error) => {
            eprintln!(
                "[agent] transient empty provider response; retrying this investigation stage once"
            );
            run_prompt(config, recovery_prompt, Some(event_log)).await
        }
        Err(error) => Err(error),
    }
}

pub async fn run(args: InvestigateArgs) -> Result<()> {
    let split_classifier = complex_visual_routing_ab_enabled();
    if args.dry_run {
        let topic = args.topic.join(" ");
        let declared_local_data: Vec<String> = args
            .data
            .iter()
            .filter_map(|path| path.file_name().and_then(|value| value.to_str()))
            .map(|name| format!("data/{name}"))
            .collect();
        let prompt =
            prompt::investigation_with_classifier(&topic, &declared_local_data, split_classifier);
        print!("{prompt}");
        return Ok(());
    }
    run_with_artifact(args).await.map(|_| ())
}

/// Run a persistent investigation and return its directory so interactive
/// callers can continue the same Pi session without asking the user to copy a
/// path from stderr.
pub async fn run_with_artifact(args: InvestigateArgs) -> Result<PathBuf> {
    let run_started = Instant::now();
    let split_classifier = complex_visual_routing_ab_enabled();
    let topic = args.topic.join(" ");

    let output_root = output::resolve_output_dir(&args.out)?;
    output::announce_and_confirm(&output_root, args.confirm_output)?;

    eprintln!(
        "[agent] phase=preparing elapsed_ms={}",
        run_started.elapsed().as_millis()
    );
    let bundle = InvestigationBundle::create(&output_root, &topic)?;
    let mut local_data = Vec::new();
    for source in &args.data {
        local_data.push(bundle.import_data(source)?);
    }
    let prompt = prompt::investigation_with_classifier(&topic, &local_data, split_classifier);
    bundle.write_prompt(&prompt)?;
    let reported_provider = PiConfig::normalize_provider(args.pi.provider.as_deref());
    bundle.write_manifest(
        &topic,
        reported_provider.as_deref(),
        args.pi.model.as_deref(),
        "draft",
        None,
    )?;
    eprintln!(
        "[agent] phase=runtime-initialization elapsed_ms={}",
        run_started.elapsed().as_millis()
    );
    let runtime_started = Instant::now();
    let extension = runtime::materialize_extension(&bundle.dir)?;
    eprintln!(
        "[agent] runtime_initialization_ms={}",
        runtime_started.elapsed().as_millis()
    );

    let mut config = PiConfig {
        binary: args.pi.pi_bin,
        provider: args.pi.provider,
        model: args.pi.model,
        api_key: None,
        base_url: None,
        thinking: args.pi.thinking,
        approve_project: args.pi.approve_project,
        extension: Some(extension),
        artifact_dir: Some(bundle.dir.clone()),
        session_dir: Some(bundle.session_dir.clone()),
        continue_session: false,
        tool_profile: effective_tool_profile(&args.pi.tool_profile, &topic, split_classifier),
    };
    let reported_provider = config.effective_provider();

    eprintln!("investigation: {}", bundle.id);
    eprintln!("runtime: {}", config.display_runtime());
    eprintln!("artifact: {}\n", bundle.dir.display());

    audit::append_user_goal_event(&bundle.events_path, "initial")?;
    match run_prompt_with_empty_recovery(&config, &prompt, &prompt, &bundle.events_path).await {
        Ok(result) => {
            let persistence_started = Instant::now();
            bundle.append_conversation(&topic, &result.text)?;
            let mut final_text = result.text;
            bundle.write_answer(&final_text)?;
            if let Some(stats) = &result.session_stats {
                bundle.write_session_stats(stats)?;
            }
            let mut audit = audit::build(&bundle.events_path, &bundle.tools_path)?;
            let mut completion_gaps =
                visual_completion_gaps(&bundle, &topic, &audit, split_classifier)?;
            if is_complex_visual_request(&topic, split_classifier) {
                for attempt in 1..=2 {
                    if completion_gaps.is_empty() {
                        break;
                    }
                    audit::append_completion_retry_event(
                        &bundle.events_path,
                        attempt,
                        &completion_gaps,
                    )?;
                    let mode_contract = prompt::visual_mode_contract(&topic);
                    let correction = format!(
                        "System completion gate attempt {attempt}/2 found unfinished required work:\n- {}\n{}Continue the same session and repair only these gaps using the real visual-story tools. Do not weaken, remove, relabel, or replace requested visuals with prose or illustrations. Complete every required infographic and publication gate, then write the self-contained HTML and requested desktop/mobile PNG files under NEWSROOM_ARTIFACT_DIR. Do not invent evidence or quantitative claims.",
                        completion_gaps.join("\n- "),
                        mode_contract,
                    );
                    config.continue_session = true;
                    let recovery = "The provider returned an empty response before completing the previous system completion-gate instruction. Continue the same session now. Do not restart research or weaken any requested visual; finish the outstanding infographic and publication gates.";
                    let retry = run_prompt_with_empty_recovery(
                        &config,
                        &correction,
                        recovery,
                        &bundle.events_path,
                    )
                    .await?;
                    final_text = retry.text;
                    bundle.write_answer(&final_text)?;
                    if let Some(stats) = &retry.session_stats {
                        bundle.write_session_stats(stats)?;
                    }
                    audit = audit::build(&bundle.events_path, &bundle.tools_path)?;
                    completion_gaps =
                        visual_completion_gaps(&bundle, &topic, &audit, split_classifier)?;
                }
            }
            let status = if !completion_gaps.is_empty() {
                "failed"
            } else if audit.has_agent_loop_evidence() {
                "draft"
            } else {
                "incomplete"
            };
            bundle.append_run_metric(
                "investigate",
                reported_provider.as_deref(),
                config.model.as_deref(),
                status,
                run_started.elapsed().as_millis(),
                Some(&audit),
            )?;
            bundle.write_manifest(
                &topic,
                reported_provider.as_deref(),
                config.model.as_deref(),
                status,
                Some(&audit),
            )?;
            if !completion_gaps.is_empty() {
                bail!("visual delivery incomplete: {}", completion_gaps.join("; "));
            }
            if status == "incomplete" {
                eprintln!(
                    "\n[qualification] investigation completed without enough observable planning/tool evidence; inspect tools.json"
                );
            }
            match bundle.primary_artifact()? {
                Some((path, kind)) => {
                    eprintln!(
                        "\nprimary_artifact: {} ({kind})",
                        bundle.dir.join(path).display()
                    );
                    eprintln!("manifest (metadata): {}", bundle.manifest_path.display());
                }
                None if prompt::is_visual_request(&topic) => {
                    eprintln!(
                        "\n[qualification] visual request produced no HTML/SVG/PNG primary artifact; manifest (metadata): {}",
                        bundle.manifest_path.display()
                    );
                }
                None => eprintln!("\nmanifest (metadata): {}", bundle.manifest_path.display()),
            }
            eprintln!(
                "[agent] persistence_ms={} end_to_end_ms={}",
                persistence_started.elapsed().as_millis(),
                run_started.elapsed().as_millis()
            );
            Ok(bundle.dir)
        }
        Err(error) => {
            let diagnostic = format!("# Investigation failed\n\n{error:#}\n");
            bundle.write_answer(&diagnostic)?;
            let audit = if bundle.events_path.is_file() {
                audit::build(&bundle.events_path, &bundle.tools_path).ok()
            } else {
                None
            };
            bundle.append_run_metric(
                "investigate",
                reported_provider.as_deref(),
                config.model.as_deref(),
                "failed",
                run_started.elapsed().as_millis(),
                audit.as_ref(),
            )?;
            bundle.write_manifest(
                &topic,
                reported_provider.as_deref(),
                config.model.as_deref(),
                "failed",
                audit.as_ref(),
            )?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod completion_tests {
    use super::{
        completion_chain_required, is_transient_completion_provider_error, missing_visual_modes,
        visual_completion_gaps_for_profile,
    };
    use crate::artifact::InvestigationBundle;
    use crate::audit;
    use serde_json::json;
    use std::fs;

    const SCMP_LONG_IMAGE_GOAL: &str = "做一张南华早报（SCMP）风格的中文信息长图：一带一路倡议到2017年的进展——哪些国家参与、中国对沿线国家的投资和贸易规模、代表性项目在哪里。要有地图，数字必须来自可核实的数据。";

    /// A run that only ever called newsroom_lieflat_render and left a Lieflat
    /// publication behind: the shape of the run behind issue #37.
    fn lieflat_only_run(
        root: &std::path::Path,
        goal: &str,
    ) -> (InvestigationBundle, audit::AuditSummary) {
        let bundle = InvestigationBundle::create(root, goal).unwrap();
        let page = bundle.dir.join("publications/lieflat-page");
        fs::create_dir_all(&page).unwrap();
        fs::write(page.join("index.html"), "<html>lieflat</html>").unwrap();
        fs::write(
            page.join("manifest.json"),
            r#"{"kind":"lieflat_publication","html_ref":"publications/lieflat-page/index.html"}"#,
        )
        .unwrap();
        fs::write(
            &bundle.events_path,
            concat!(
                "{\"type\":\"tool_execution_start\",\"toolCallId\":\"c1\",\"toolName\":\"newsroom_lieflat_render\",\"args\":{}}\n",
                "{\"type\":\"tool_execution_end\",\"toolCallId\":\"c1\",\"isError\":false}\n"
            ),
        )
        .unwrap();
        let audit = audit::build(&bundle.events_path, &bundle.tools_path).unwrap();
        (bundle, audit)
    }

    #[test]
    fn lieflat_only_run_cannot_complete_the_long_image_goal() {
        // The goal is complex through 信息长图, not the bare 地图, so the full
        // chain is required even with no recorded profile.
        assert!(completion_chain_required(SCMP_LONG_IMAGE_GOAL, false, None));
        let root = tempfile::tempdir().unwrap();
        let (bundle, audit) = lieflat_only_run(root.path(), SCMP_LONG_IMAGE_GOAL);
        for profile in [None, Some("visual"), Some("visual-story")] {
            let gaps = visual_completion_gaps_for_profile(
                &bundle,
                SCMP_LONG_IMAGE_GOAL,
                &audit,
                false,
                profile,
            )
            .unwrap();
            for tool in [
                "newsroom_infographic_plan",
                "newsroom_infographic_lint",
                "newsroom_infographic_render",
                "newsroom_infographic_critic",
                "newsroom_publication_plan",
                "newsroom_publication_render",
                "newsroom_publication_qa",
            ] {
                assert!(
                    gaps.iter().any(|gap| gap.contains(tool)),
                    "{profile:?} missing {tool}: {gaps:?}"
                );
            }
            assert!(
                gaps.iter().any(|gap| gap.contains("map/spatial")),
                "{profile:?} missing map gap: {gaps:?}"
            );
            assert!(
                gaps.iter()
                    .any(|gap| gap.contains("only a Lieflat page exists")),
                "{profile:?} missing publication gap: {gaps:?}"
            );
        }
    }

    #[test]
    fn explicit_visual_story_profile_requires_the_chain_for_any_goal() {
        let goal = "show a chart of exports";
        assert!(!completion_chain_required(goal, false, None));
        assert!(!completion_chain_required(goal, false, Some("visual")));
        assert!(completion_chain_required(goal, false, Some("visual-story")));
        let root = tempfile::tempdir().unwrap();
        let (bundle, audit) = lieflat_only_run(root.path(), goal);
        let plain =
            visual_completion_gaps_for_profile(&bundle, goal, &audit, false, Some("visual"))
                .unwrap();
        assert!(!plain
            .iter()
            .any(|gap| gap.contains("newsroom_publication_qa")));
        let story =
            visual_completion_gaps_for_profile(&bundle, goal, &audit, false, Some("visual-story"))
                .unwrap();
        assert!(story
            .iter()
            .any(|gap| gap.contains("newsroom_publication_qa")));
        assert!(story
            .iter()
            .any(|gap| gap.contains("no measured publication")));
    }

    #[test]
    fn explicit_visual_modes_cannot_be_silently_replaced_by_rank_charts() {
        let plan = json!({"modules": [
            {"type": "visual", "visual_grammar": "trend"},
            {"type": "visual", "visual_grammar": "benchmark"}
        ]});
        let gaps = missing_visual_modes("组合世界流向地图、地区构成和年代比较", &plan);
        assert!(gaps.iter().any(|gap| gap.contains("map/spatial")));
        assert!(gaps.iter().any(|gap| gap.contains("composition")));
        assert!(!gaps.iter().any(|gap| gap.contains("comparison")));

        let sankey_composition_plan = serde_json::json!({
            "modules": [
                {"type": "visual", "visual_grammar": "spatial"},
                {"type": "visual", "visual_grammar": "flow"},
                {"type": "visual", "visual_grammar": "change"}
            ]
        });
        assert!(missing_visual_modes(
            "组合世界流向地图、地区 Sankey 构成和年代比较",
            &sankey_composition_plan
        )
        .is_empty());
    }

    #[test]
    fn requested_modes_pass_when_the_rendered_plan_contains_them() {
        let plan = json!({"modules": [
            {"type": "visual", "visual_grammar": "spatial"},
            {"type": "visual", "visual_grammar": "flow"},
            {"type": "visual", "visual_grammar": "network"},
            {"type": "visual", "visual_grammar": "trend"}
        ]});
        assert!(missing_visual_modes("地图、Sankey、网络图和趋势", &plan).is_empty());
    }

    #[test]
    fn only_empty_final_provider_failures_get_the_bounded_recovery() {
        assert!(is_transient_completion_provider_error(&anyhow::anyhow!(
            "Pi returned an empty final answer (provider diagnostic suppressed)"
        )));
        assert!(!is_transient_completion_provider_error(&anyhow::anyhow!(
            "visual delivery incomplete"
        )));
    }
}
