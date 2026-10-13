use crate::artifact::InvestigationBundle;
use crate::audit;
use crate::cli::InvestigateArgs;
use crate::commands::verify;
use crate::compose_answer;
use crate::pi::{self, run_prompt, PiConfig, PiRunResult};
use crate::{output, prompt, runtime};
use anyhow::{bail, Result};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::path::{Component, Path};
use std::time::Instant;

pub(crate) fn complex_visual_routing_ab_enabled() -> bool {
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

pub(crate) fn is_complex_visual_request(topic: &str, split_classifier: bool) -> bool {
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

/// Opt-in (`NEWSROOM_HIDE_LIEFLAT=1`): drop the unmeasured Lieflat fallback
/// tools from this command's `visual-story` runs. Only this non-v2 path asks
/// for it; v2 builds its own `PiConfig` and keeps both tools. Gates are
/// untouched: a Lieflat page never counted as the delivered page.
fn lieflat_hidden_for(requested: &str, topic: &str, split_classifier: bool) -> bool {
    pi::hide_lieflat_switch_enabled()
        && effective_tool_profile(requested, topic, split_classifier) == "visual-story"
}

/// Whether completion must go through the measured infographic, publication
/// and browser-QA chain. The goal text can only add this requirement; an
/// explicit visual-story tool profile adds it regardless of the wording.
pub(crate) fn completion_chain_required(
    topic: &str,
    split_classifier: bool,
    profile: Option<&str>,
) -> bool {
    is_complex_visual_request(topic, split_classifier) || profile == Some("visual-story")
}

/// A composed closing text is only for a run whose completion does not need the infographic,
/// publication and browser-QA chain, whether the topic or the tool profile asks for it.
fn compose_allowed(topic: &str, split_classifier: bool, profile: &str) -> bool {
    !completion_chain_required(topic, split_classifier, Some(profile))
        && compose_answer::eligible(
            topic,
            is_complex_visual_request(topic, split_classifier),
            prompt::requires_html(topic),
            prompt::requires_png(topic),
        )
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

pub(crate) fn visual_completion_gaps_for_profile(
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
        if completion_plan_gap_on() && !bundle.plan_path.is_file() {
            gaps.push(PLAN_GAP_TEXT.to_string());
        }
    }
    Ok(gaps)
}

/// NEWSROOM_COMPLETION_PLAN_GAP=1 (exact "1", default off): a run that needs the complex-visual chain also
/// has a gap while plan.json is missing, because verification refuses a story whose `files.plan` is not a
/// file (src/verify.rs checks every `files` entry with `is_file()`, and artifact.rs always lists plan.json).
/// The condition is the same as verification's, so a run this gap lets through is not refused for its plan.
/// Only a check is added; verification and the other gaps are unchanged.
pub const COMPLETION_PLAN_GAP_ENV: &str = "NEWSROOM_COMPLETION_PLAN_GAP";

const PLAN_GAP_TEXT: &str = "plan.json is missing: call newsroom_update_plan with {goal: string, steps: [{id: string, action: string, status: \"pending\"|\"in_progress\"|\"completed\"|\"blocked\"}]} (each step is an object, never a plain string)";

fn completion_plan_gap_on() -> bool {
    std::env::var(COMPLETION_PLAN_GAP_ENV).ok().as_deref() == Some("1")
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

/// Exactly "1" turns it on (default off): before a second completion attempt, skip it when the gaps are the same as before the
/// attempt that was just sent and the model made no tool call in it. The first attempt is always sent.
pub const COMPLETION_SAME_GAPS_ENV: &str = "NEWSROOM_SPEED_COMPLETION_SAME_GAPS";

pub(crate) fn completion_same_gaps_on() -> bool {
    std::env::var(COMPLETION_SAME_GAPS_ENV).ok().as_deref() == Some("1")
}

/// What the previous completion attempt left behind: the gaps it was sent with and how many tool calls the model made in it.
pub(crate) struct SentAttempt {
    pub gaps: Vec<String>,
    pub calls: usize,
}

/// True when the next completion attempt would only ask the same thing again: the gaps now are the same set as the gaps the
/// previous attempt was sent with, and the model made no tool call during that attempt (a failed call counts as a call).
/// Compared as a set (sorted, duplicates dropped): the order the gate lists gaps in carries no meaning, so a reordering is not
/// a change. Never true for the first attempt (`previous` is None).
pub(crate) fn skip_completion_attempt(previous: Option<&SentAttempt>, gaps: &[String]) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    let set = |list: &[String]| {
        let mut sorted = list.to_vec();
        sorted.sort();
        sorted.dedup();
        sorted
    };
    previous.calls == 0 && set(&previous.gaps) == set(gaps)
}

/// NEWSROOM_COMPLETION_GAP_HINTS=1 (exact "1", default off): the correction names, for each missing item, the
/// tool that supplies it, and says what comes next once a chart has passed. Only the text sent to the model
/// changes; which gaps exist and what ends the run are untouched.
pub const COMPLETION_GAP_HINTS_ENV: &str = "NEWSROOM_COMPLETION_GAP_HINTS";

fn completion_gap_hints_on() -> bool {
    std::env::var(COMPLETION_GAP_HINTS_ENV).ok().as_deref() == Some("1")
}

fn gap_supplier(gap: &str) -> Option<&str> {
    if let Some(tool) = gap.strip_prefix("required complex-visual gate did not pass: ") {
        return Some(tool);
    }
    match gap {
        g if g.starts_with("requested self-contained HTML") => Some("newsroom_publication_render"),
        g if g.starts_with("requested desktop") || g.starts_with("no measured publication") => {
            Some("newsroom_publication_qa")
        }
        g if g.starts_with("explicitly requested visual mode") => Some("newsroom_infographic_plan"),
        g if g.starts_with("rendered infographic") => Some("newsroom_infographic_render"),
        g if g == PLAN_GAP_TEXT => Some("newsroom_update_plan"),
        _ => None,
    }
}

/// Whether the program's own critic record says a chart passed: any
/// `visualizations/critics/*.json` with `passed: true`. A REVISE result is a normal result, not an error,
/// so a successful call alone does not show a pass; model text is never read.
fn chart_critic_record_passed(artifact: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(artifact.join("visualizations").join("critics")) else {
        return false;
    };
    entries.flatten().any(|entry| {
        std::fs::read_to_string(entry.path())
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|record| record.get("passed").and_then(Value::as_bool))
            == Some(true)
    })
}

/// The text of one completion-gate retry. `hints` is `Some((audit, critic_record_passed))` only with the
/// switch on; `None` is byte-identical to the message that was always sent.
fn completion_correction(
    attempt: usize,
    gaps: &[String],
    mode_contract: &str,
    hints: Option<(&audit::AuditSummary, bool)>,
) -> String {
    let listed = match hints {
        None => gaps.join("\n- "),
        Some(_) => gaps
            .iter()
            .map(|gap| match gap_supplier(gap) {
                Some(tool) => format!("{gap} (supplied by {tool})"),
                None => gap.clone(),
            })
            .collect::<Vec<_>>()
            .join("\n- "),
    };
    let next = hints
        .and_then(|(audit, record_passed)| {
            let chart_passed = record_passed
                && audit
                    .calls
                    .iter()
                    .any(|call| call.tool == "newsroom_viz_critic" && call.is_error != Some(true));
            let first = gaps.iter().find_map(|gap| gap_supplier(gap))?;
            chart_passed.then(|| {
                format!("A chart already passed its checks; do not redo it. Next call {first}.\n")
            })
        })
        .unwrap_or_default();
    format!(
        "System completion gate attempt {attempt}/2 found unfinished required work:\n- {listed}\n{next}{mode_contract}Continue the same session and repair only these gaps using the real visual-story tools. Do not weaken, remove, relabel, or replace requested visuals with prose or illustrations. Complete every required infographic and publication gate, then write the self-contained HTML and requested desktop/mobile PNG files under NEWSROOM_ARTIFACT_DIR. Do not invent evidence or quantitative claims."
    )
}

fn is_transient_completion_provider_error(error: &anyhow::Error) -> bool {
    error
        .to_string()
        .contains("Pi returned an empty final answer")
}

pub(crate) async fn run_prompt_with_empty_recovery(
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
        let hide_lieflat = lieflat_hidden_for(&args.pi.tool_profile, &topic, split_classifier);
        let speed = pi::speed_switches_from_env();
        let mut prompt = prompt::investigation_with_options(
            &topic,
            &declared_local_data,
            split_classifier,
            hide_lieflat,
            speed,
        );
        if speed.data_profile {
            let files: Vec<(String, PathBuf)> = declared_local_data
                .iter()
                .cloned()
                .zip(args.data.iter().cloned())
                .collect();
            prompt.push_str(&crate::data_profile::profile_section(&files));
        }
        if speed.recipes {
            let files: Vec<(String, PathBuf)> = declared_local_data
                .iter()
                .cloned()
                .zip(args.data.iter().cloned())
                .collect();
            if let Some(recipe) = crate::recipes::section(&files) {
                prompt.push_str(&recipe.text);
            }
        }
        print!("{prompt}");
        return Ok(());
    }
    let (_, verified) = match run_inner(args).await {
        Ok(done) => done,
        Err(error) => return Err(verify::exit_on_error(&error)),
    };
    verify::exit_if_not_verified(verified);
    Ok(())
}

/// Run a persistent investigation and return its directory so interactive
/// callers can continue the same Pi session without asking the user to copy a
/// path from stderr.
pub async fn run_with_artifact(args: InvestigateArgs) -> Result<PathBuf> {
    verify::mark_interactive_session();
    run_inner(args).await.map(|(dir, _)| dir)
}

/// Answer written for a failed run: the redacted error plus any partial text
/// the model had already streamed (kept so nothing on disk is lost).
fn failure_answer(error: &anyhow::Error) -> String {
    let mut text = format!("# Investigation failed\n\n{error:#}\n");
    if let Some(failure) = error.downcast_ref::<crate::pi::ProviderFailure>() {
        if !failure.partial_text.trim().is_empty() {
            text.push_str("\n## Partial output before the failure\n\n");
            text.push_str(&failure.partial_text);
            if !failure.partial_text.ends_with('\n') {
                text.push('\n');
            }
        }
    }
    text
}

async fn run_inner(args: InvestigateArgs) -> Result<(PathBuf, bool)> {
    let run_started = Instant::now();
    let split_classifier = complex_visual_routing_ab_enabled();
    let topic = args.topic.join(" ");
    crate::step_lines::begin(&topic);

    let output_root = output::resolve_output_dir(&args.out)?;
    output::announce_and_confirm(&output_root, args.confirm_output)?;

    if !crate::step_lines::enabled() {
        eprintln!(
            "[agent] phase=preparing elapsed_ms={}",
            run_started.elapsed().as_millis()
        );
    }
    let mut bundle = InvestigationBundle::create(&output_root, &topic)?;
    let mut local_data = Vec::new();
    for source in &args.data {
        local_data.push(bundle.import_data(source)?);
    }
    let hide_lieflat = lieflat_hidden_for(&args.pi.tool_profile, &topic, split_classifier);
    let speed = pi::speed_switches_from_env();
    let mut prompt = prompt::investigation_with_options(
        &topic,
        &local_data,
        split_classifier,
        hide_lieflat,
        speed,
    );
    if speed.data_profile {
        // Profile the imported copy the model will query, not the original that may change.
        let files: Vec<(String, PathBuf)> = local_data
            .iter()
            .map(|shown| (shown.clone(), bundle.dir.join(shown)))
            .collect();
        prompt.push_str(&crate::data_profile::profile_section(&files));
    }
    if speed.recipes {
        // The shape comes from the imported copy the model will query, not from the request text.
        let files: Vec<(String, PathBuf)> = local_data
            .iter()
            .map(|shown| (shown.clone(), bundle.dir.join(shown)))
            .collect();
        if let Some(recipe) = crate::recipes::section(&files) {
            prompt.push_str(&recipe.text);
            bundle.recipe = Some((recipe.name.to_string(), recipe.sha256));
        }
    }
    bundle.write_prompt(&prompt)?;
    let reported_provider = PiConfig::normalize_provider(args.pi.provider.as_deref());
    bundle.write_manifest(
        &topic,
        reported_provider.as_deref(),
        args.pi.model.as_deref(),
        "draft",
        None,
        crate::agent_loop::agent_rust_enabled(),
    )?;
    if !crate::step_lines::enabled() {
        eprintln!(
            "[agent] phase=runtime-initialization elapsed_ms={}",
            run_started.elapsed().as_millis()
        );
    }
    let runtime_started = Instant::now();
    let extension = runtime::materialize_extension(&bundle.dir)?;
    eprintln!(
        "[agent] runtime_initialization_ms={}",
        runtime_started.elapsed().as_millis()
    );

    let tool_profile = effective_tool_profile(&args.pi.tool_profile, &topic, split_classifier);
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
        tool_profile: tool_profile.clone(),
        hide_lieflat,
        speed,
        compose: (speed.compose_answer && compose_allowed(&topic, split_classifier, &tool_profile))
            .then(|| compose_answer::ComposeSpec {
                chinese: prompt::language_instruction(&topic).contains("Simplified Chinese"),
            }),
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
                let mut sent: Option<SentAttempt> = None;
                for attempt in 1..=2 {
                    if completion_gaps.is_empty() {
                        break;
                    }
                    if completion_same_gaps_on()
                        && skip_completion_attempt(sent.as_ref(), &completion_gaps)
                    {
                        crate::pi::append_completion_skip_event(
                            &bundle.events_path,
                            attempt,
                            &completion_gaps,
                            "same_gaps_no_tool_call",
                        )?;
                        break;
                    }
                    let calls_before_attempt = audit.tool_calls;
                    sent = Some(SentAttempt {
                        gaps: completion_gaps.clone(),
                        calls: 0,
                    });
                    audit::append_completion_retry_event(
                        &bundle.events_path,
                        attempt,
                        &completion_gaps,
                    )?;
                    let mode_contract = prompt::visual_mode_contract(&topic);
                    let correction = completion_correction(
                        attempt,
                        &completion_gaps,
                        &mode_contract,
                        completion_gap_hints_on()
                            .then(|| (&audit, chart_critic_record_passed(&bundle.dir))),
                    );
                    config.continue_session = true;
                    let recovery = "The provider returned an empty response before completing the previous system completion-gate instruction. Continue the same session now. Do not restart research or weaken any requested visual; finish the outstanding infographic and publication gates.";
                    let retry = match run_prompt_with_empty_recovery(
                        &config,
                        &correction,
                        recovery,
                        &bundle.events_path,
                    )
                    .await
                    {
                        Ok(retry) => retry,
                        Err(error) => {
                            bundle.write_answer(&failure_answer(&error))?;
                            let audit = audit::build(&bundle.events_path, &bundle.tools_path).ok();
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
                                crate::agent_loop::agent_rust_enabled(),
                            )?;
                            return Err(error);
                        }
                    };
                    final_text = retry.text;
                    bundle.write_answer(&final_text)?;
                    if let Some(stats) = &retry.session_stats {
                        bundle.write_session_stats(stats)?;
                    }
                    audit = audit::build(&bundle.events_path, &bundle.tools_path)?;
                    if let Some(sent) = sent.as_mut() {
                        sent.calls = audit.tool_calls.saturating_sub(calls_before_attempt);
                    }
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
                crate::agent_loop::agent_rust_enabled(),
            )?;
            if !completion_gaps.is_empty() {
                bail!("visual delivery incomplete: {}", completion_gaps.join("; "));
            }
            if status == "incomplete" {
                eprintln!(
                    "\n[qualification] investigation completed without enough observable planning/tool evidence; inspect tools.json"
                );
            }
            // Step lines on: the verdict is computed here so the closing line sits right above primary_artifact.
            let early_verdict = if crate::step_lines::enabled() {
                let verdict = verify::post_run_verdict(&bundle.dir).await;
                crate::step_lines::print_final(verdict.is_none());
                Some(verdict)
            } else {
                None
            };
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
            let verified = match early_verdict {
                Some(verdict) => verify::announce_verdict(verdict),
                None => verify::announce_post_run_verdict(&bundle.dir).await,
            };
            Ok((bundle.dir, verified))
        }
        Err(error) => {
            let diagnostic = failure_answer(&error);
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
                crate::agent_loop::agent_rust_enabled(),
            )?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod completion_tests {
    use super::{
        chart_critic_record_passed, completion_chain_required, completion_correction,
        completion_gap_hints_on, completion_plan_gap_on, completion_same_gaps_on, compose_allowed,
        gap_supplier, is_transient_completion_provider_error, lieflat_hidden_for,
        missing_visual_modes, skip_completion_attempt, visual_completion_gaps_for_profile,
        SentAttempt, COMPLETION_GAP_HINTS_ENV, COMPLETION_PLAN_GAP_ENV, COMPLETION_SAME_GAPS_ENV,
        PLAN_GAP_TEXT,
    };
    use crate::artifact::InvestigationBundle;
    use crate::audit;
    use crate::pi;
    use serde_json::json;
    use std::fs;

    #[test]
    fn composed_closing_text_never_replaces_a_visual_story_completion_chain() {
        let simple = "Show the GISTEMP anomaly as one line chart";
        assert!(compose_allowed(simple, false, "investigate"));
        // An explicit visual-story profile requires the chain even for a simple topic.
        assert!(!compose_allowed(simple, false, "visual-story"));
    }

    const SCMP_LONG_IMAGE_GOAL: &str = "做一张南华早报（SCMP）风格的中文信息长图：一带一路倡议到2017年的进展——哪些国家参与、中国对沿线国家的投资和贸易规模、代表性项目在哪里。要有地图，数字必须来自可核实的数据。";

    #[test]
    fn lieflat_is_hidden_only_for_visual_story_with_the_switch_on() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let complex = SCMP_LONG_IMAGE_GOAL;
        for value in [None, Some("0"), Some("")] {
            match value {
                Some(v) => std::env::set_var(pi::HIDE_LIEFLAT_ENV, v),
                None => std::env::remove_var(pi::HIDE_LIEFLAT_ENV),
            }
            assert!(
                !lieflat_hidden_for("investigate", complex, false),
                "{value:?}"
            );
            assert!(
                !lieflat_hidden_for("visual-story", complex, false),
                "{value:?}"
            );
        }
        std::env::set_var(pi::HIDE_LIEFLAT_ENV, "1");
        let complex_on = lieflat_hidden_for("investigate", complex, false);
        let explicit_on = lieflat_hidden_for("visual-story", "总结这篇新闻", false);
        let simple_visual = lieflat_hidden_for("investigate", "制作一个信息图", false);
        let plain = lieflat_hidden_for("investigate", "总结这篇新闻", false);
        let other_profile = lieflat_hidden_for("visual", complex, false);
        std::env::remove_var(pi::HIDE_LIEFLAT_ENV);
        assert!(complex_on);
        assert!(explicit_on);
        assert!(!simple_visual && !plain && !other_profile);
    }

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
    fn a_page_whose_only_page_call_is_a_stopped_patch_call_stays_not_verified() {
        let root = tempfile::tempdir().unwrap();
        let bundle = InvestigationBundle::create(root.path(), SCMP_LONG_IMAGE_GOAL).unwrap();
        let steps: Vec<_> = ["newsroom_infographic_plan", "newsroom_infographic_lint"]
            .iter()
            .map(|tool| json!({"tool": tool, "params": {"plan_ref": "p"}, "details": {"passed": true}}))
            .collect();
        let stopped = json!({"chain":"newsroom_infographic_chain","chainStatus":"STOPPED","failedAt":"newsroom_infographic_lint","stopCode":"BLOCKED","steps":steps});
        let events = [
            json!({"type":"tool_execution_start","toolCallId":"c1","toolName":"newsroom_infographic_chain_patch","args":{}}),
            json!({"type":"tool_execution_end","toolCallId":"c1","toolName":"newsroom_infographic_chain_patch","isError":false,"result":{"content":[],"details":stopped}}),
        ];
        let text: String = events.iter().map(|e| format!("{e}\n")).collect();
        fs::write(&bundle.events_path, text).unwrap();
        let audit = audit::build(&bundle.events_path, &bundle.tools_path).unwrap();
        let gaps = visual_completion_gaps_for_profile(
            &bundle,
            SCMP_LONG_IMAGE_GOAL,
            &audit,
            false,
            Some("visual-story"),
        )
        .unwrap();
        // Plan and lint count; everything after the stop still does not.
        for tool in [
            "newsroom_infographic_render",
            "newsroom_infographic_critic",
            "newsroom_publication_plan",
            "newsroom_publication_render",
            "newsroom_publication_qa",
        ] {
            assert!(
                gaps.iter().any(|gap| gap.contains(tool)),
                "{tool}: {gaps:?}"
            );
        }
        assert!(!gaps
            .iter()
            .any(|gap| gap.contains("newsroom_infographic_plan")));
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

    /// The correction message exactly as it was sent before the hints existed.
    fn legacy_correction(attempt: usize, gaps: &[String], mode_contract: &str) -> String {
        format!(
            "System completion gate attempt {attempt}/2 found unfinished required work:\n- {}\n{}Continue the same session and repair only these gaps using the real visual-story tools. Do not weaken, remove, relabel, or replace requested visuals with prose or illustrations. Complete every required infographic and publication gate, then write the self-contained HTML and requested desktop/mobile PNG files under NEWSROOM_ARTIFACT_DIR. Do not invent evidence or quantitative claims.",
            gaps.join("\n- "),
            mode_contract,
        )
    }

    /// A run that stopped after one chart: the viz critic passed, nothing else was called.
    fn one_chart_run(root: &std::path::Path) -> (InvestigationBundle, audit::AuditSummary) {
        let bundle = InvestigationBundle::create(root, SCMP_LONG_IMAGE_GOAL).unwrap();
        fs::write(
            &bundle.events_path,
            concat!(
                "{\"type\":\"tool_execution_start\",\"toolCallId\":\"c1\",\"toolName\":\"newsroom_viz_critic\",\"args\":{}}\n",
                "{\"type\":\"tool_execution_end\",\"toolCallId\":\"c1\",\"isError\":false}\n"
            ),
        )
        .unwrap();
        let audit = audit::build(&bundle.events_path, &bundle.tools_path).unwrap();
        (bundle, audit)
    }

    #[test]
    fn completion_gap_hints_switch_takes_only_the_exact_value_one() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (value, expected) in [
            (None, false),
            (Some(""), false),
            (Some("0"), false),
            (Some("true"), false),
            (Some(" 1"), false),
            (Some("01"), false),
            (Some("1"), true),
        ] {
            match value {
                Some(v) => std::env::set_var(COMPLETION_GAP_HINTS_ENV, v),
                None => std::env::remove_var(COMPLETION_GAP_HINTS_ENV),
            }
            assert_eq!(completion_gap_hints_on(), expected, "{value:?}");
        }
        std::env::remove_var(COMPLETION_GAP_HINTS_ENV);
    }

    #[test]
    fn same_gaps_switch_takes_only_the_exact_value_one() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (value, expected) in [
            (None, false),
            (Some(""), false),
            (Some("0"), false),
            (Some("true"), false),
            (Some("yes"), false),
            (Some(" 1"), false),
            (Some("01"), false),
            (Some("1"), true),
        ] {
            match value {
                Some(v) => std::env::set_var(COMPLETION_SAME_GAPS_ENV, v),
                None => std::env::remove_var(COMPLETION_SAME_GAPS_ENV),
            }
            assert_eq!(completion_same_gaps_on(), expected, "{value:?}");
        }
        std::env::remove_var(COMPLETION_SAME_GAPS_ENV);
    }

    #[test]
    fn a_completion_attempt_is_skipped_only_for_the_same_gaps_and_no_tool_call() {
        let gaps = |list: &[&str]| list.iter().map(|g| g.to_string()).collect::<Vec<_>>();
        let sent = |list: &[&str], calls: usize| SentAttempt {
            gaps: gaps(list),
            calls,
        };
        // the first attempt is never skipped
        assert!(!skip_completion_attempt(None, &gaps(&["a", "b"])));
        // same gaps, no call: skip
        assert!(skip_completion_attempt(
            Some(&sent(&["a", "b"], 0)),
            &gaps(&["a", "b"])
        ));
        // the order of the gaps is not a change; a repeated gap is not a new one
        assert!(skip_completion_attempt(
            Some(&sent(&["a", "b"], 0)),
            &gaps(&["b", "a", "a"])
        ));
        // any tool call in the attempt: send again
        assert!(!skip_completion_attempt(
            Some(&sent(&["a", "b"], 1)),
            &gaps(&["a", "b"])
        ));
        // a gap closed, a gap added, or a gap replaced: send again
        assert!(!skip_completion_attempt(
            Some(&sent(&["a", "b"], 0)),
            &gaps(&["a"])
        ));
        assert!(!skip_completion_attempt(
            Some(&sent(&["a"], 0)),
            &gaps(&["a", "b"])
        ));
        assert!(!skip_completion_attempt(
            Some(&sent(&["a", "b"], 0)),
            &gaps(&["a", "c"])
        ));
    }

    #[test]
    fn completion_correction_without_hints_is_byte_identical_to_the_old_message() {
        let root = tempfile::tempdir().unwrap();
        let (bundle, audit) = one_chart_run(root.path());
        let gaps = visual_completion_gaps_for_profile(
            &bundle,
            SCMP_LONG_IMAGE_GOAL,
            &audit,
            false,
            Some("visual-story"),
        )
        .unwrap();
        assert!(!gaps.is_empty());
        let contract = crate::prompt::visual_mode_contract(SCMP_LONG_IMAGE_GOAL);
        for attempt in [1, 2] {
            assert_eq!(
                completion_correction(attempt, &gaps, &contract, None),
                legacy_correction(attempt, &gaps, &contract)
            );
        }
        assert!(legacy_correction(1, &gaps, &contract).contains("attempt 1/2"));
    }

    #[test]
    fn completion_correction_with_hints_names_the_supplier_and_the_next_call() {
        let root = tempfile::tempdir().unwrap();
        let (bundle, audit) = one_chart_run(root.path());
        let gaps = visual_completion_gaps_for_profile(
            &bundle,
            SCMP_LONG_IMAGE_GOAL,
            &audit,
            false,
            Some("visual-story"),
        )
        .unwrap();
        let contract = crate::prompt::visual_mode_contract(SCMP_LONG_IMAGE_GOAL);
        let plain = completion_correction(1, &gaps, &contract, None);
        let hinted = completion_correction(1, &gaps, &contract, Some((&audit, true)));
        // The wording and the attempt counter stay.
        assert!(
            hinted.contains("System completion gate attempt 1/2 found unfinished required work:")
        );
        // Every required-gate gap says which tool supplies it.
        for tool in [
            "newsroom_infographic_plan",
            "newsroom_publication_qa",
            "newsroom_publication_render",
        ] {
            assert!(
                hinted.contains(&format!(
                    "required complex-visual gate did not pass: {tool} (supplied by {tool})"
                )),
                "{tool}\n{hinted}"
            );
        }
        assert!(
            hinted.contains("no measured publication:")
                && hinted.contains("(supplied by newsroom_publication_qa)")
        );
        // A chart passed, so the message says what comes next: the first missing gate.
        assert!(hinted.contains("A chart already passed its checks; do not redo it. Next call newsroom_infographic_plan.\n"), "{hinted}");
        // Nothing but the added text differs: removing it and the supplier marks gives the old message back.
        let mut rebuilt = hinted.replace(
            "A chart already passed its checks; do not redo it. Next call newsroom_infographic_plan.\n",
            "",
        );
        while let Some(start) = rebuilt.find(" (supplied by ") {
            let end = rebuilt[start..].find(')').unwrap() + start + 1;
            rebuilt.replace_range(start..end, "");
        }
        assert_eq!(rebuilt, plain);
        assert!(plain.len() < hinted.len());
        // Gaps that name no tool of their own stay as they were.
        let odd = vec!["some gap nobody maps".to_string()];
        assert_eq!(
            completion_correction(2, &odd, &contract, Some((&audit, true))),
            legacy_correction(2, &odd, &contract)
        );
    }

    #[test]
    fn completion_plan_gap_switch_takes_only_the_exact_value_one() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (value, expected) in [
            (None, false),
            (Some(""), false),
            (Some("0"), false),
            (Some("true"), false),
            (Some(" 1"), false),
            (Some("01"), false),
            (Some("1"), true),
        ] {
            match value {
                Some(v) => std::env::set_var(COMPLETION_PLAN_GAP_ENV, v),
                None => std::env::remove_var(COMPLETION_PLAN_GAP_ENV),
            }
            assert_eq!(completion_plan_gap_on(), expected, "{value:?}");
        }
        std::env::remove_var(COMPLETION_PLAN_GAP_ENV);
    }

    #[test]
    fn completion_plan_gap_is_added_only_when_on_and_plan_json_is_missing() {
        let _guard = crate::pi::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let root = tempfile::tempdir().unwrap();
        let (bundle, audit) = one_chart_run(root.path());
        let gaps_for = |bundle: &InvestigationBundle| {
            visual_completion_gaps_for_profile(
                bundle,
                SCMP_LONG_IMAGE_GOAL,
                &audit,
                false,
                Some("visual-story"),
            )
            .unwrap()
        };
        let has_plan_gap = |gaps: &[String]| gaps.iter().any(|gap| gap == PLAN_GAP_TEXT);
        std::env::remove_var(COMPLETION_PLAN_GAP_ENV);
        let off = gaps_for(&bundle);
        assert!(!bundle.plan_path.is_file() && !has_plan_gap(&off));
        std::env::set_var(COMPLETION_PLAN_GAP_ENV, "1");
        // Missing plan: exactly one gap is added, the rest are the off-path gaps in the same order.
        let on = gaps_for(&bundle);
        assert!(has_plan_gap(&on));
        assert_eq!(&on[..on.len() - 1], &off[..]);
        // The correction names the tool and the step object shape; with hints it also names the supplier.
        let contract = crate::prompt::visual_mode_contract(SCMP_LONG_IMAGE_GOAL);
        let text = completion_correction(1, &on, &contract, None);
        assert!(text.contains("newsroom_update_plan") && text.contains("{id: string, action: string, status:"));
        assert_eq!(gap_supplier(PLAN_GAP_TEXT), Some("newsroom_update_plan"));
        // Present plan.json: same condition as verification, no gap.
        fs::write(&bundle.plan_path, "{}").unwrap();
        assert!(!has_plan_gap(&gaps_for(&bundle)));
        std::env::remove_var(COMPLETION_PLAN_GAP_ENV);
        assert_eq!(gaps_for(&bundle), off);
    }

    #[test]
    fn a_revise_result_is_not_a_pass_even_though_the_call_succeeded() {
        let root = tempfile::tempdir().unwrap();
        let (bundle, audit) = one_chart_run(root.path());
        let gaps = visual_completion_gaps_for_profile(
            &bundle,
            SCMP_LONG_IMAGE_GOAL,
            &audit,
            false,
            Some("visual-story"),
        )
        .unwrap();
        let contract = crate::prompt::visual_mode_contract(SCMP_LONG_IMAGE_GOAL);
        // The critic call succeeded (is_error false) but its record says REVISE.
        let critics = bundle.dir.join("visualizations").join("critics");
        fs::create_dir_all(&critics).unwrap();
        fs::write(critics.join("a.json"), "{\"passed\": false, \"score\": 61}").unwrap();
        assert!(!chart_critic_record_passed(&bundle.dir));
        let revise = completion_correction(
            1,
            &gaps,
            &contract,
            Some((&audit, chart_critic_record_passed(&bundle.dir))),
        );
        assert!(!revise.contains("A chart already passed"), "{revise}");
        assert!(revise.contains("(supplied by"));
        // A record with passed:true says so; a text-only claim or a missing field does not.
        fs::write(critics.join("b.json"), "{\"passed\": \"true\"}").unwrap();
        fs::write(critics.join("c.json"), "not json").unwrap();
        assert!(!chart_critic_record_passed(&bundle.dir));
        fs::write(critics.join("d.json"), "{\"passed\": true}").unwrap();
        assert!(chart_critic_record_passed(&bundle.dir));
        let pass = completion_correction(
            1,
            &gaps,
            &contract,
            Some((&audit, chart_critic_record_passed(&bundle.dir))),
        );
        assert!(pass.contains("A chart already passed its checks"), "{pass}");
        // No critics folder at all: not passed.
        assert!(!chart_critic_record_passed(root.path()));
    }

    #[test]
    fn completion_correction_says_no_next_step_when_no_chart_passed() {
        let root = tempfile::tempdir().unwrap();
        let (bundle, audit) = lieflat_only_run(root.path(), SCMP_LONG_IMAGE_GOAL);
        let gaps = visual_completion_gaps_for_profile(
            &bundle,
            SCMP_LONG_IMAGE_GOAL,
            &audit,
            false,
            Some("visual-story"),
        )
        .unwrap();
        let contract = crate::prompt::visual_mode_contract(SCMP_LONG_IMAGE_GOAL);
        let hinted = completion_correction(1, &gaps, &contract, Some((&audit, true)));
        assert!(hinted.contains("(supplied by"));
        assert!(!hinted.contains("A chart already passed"), "{hinted}");
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
