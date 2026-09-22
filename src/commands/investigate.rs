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

fn visual_completion_gaps(
    bundle: &InvestigationBundle,
    topic: &str,
    audit: &audit::AuditSummary,
) -> Result<Vec<String>> {
    let successful_tool = |name: &str| {
        audit
            .calls
            .iter()
            .any(|call| call.tool == name && call.is_error != Some(true))
    };
    let mut gaps =
        bundle.visual_delivery_gaps(prompt::requires_html(topic), prompt::requires_png(topic))?;
    if prompt::is_complex_visual_request(topic) {
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
        return Vec::new();
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
            let mut completion_gaps = visual_completion_gaps(&bundle, &topic, &audit)?;
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
                    completion_gaps = visual_completion_gaps(&bundle, &topic, &audit)?;
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
    use super::{is_transient_completion_provider_error, missing_visual_modes};
    use serde_json::json;

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
