use crate::artifact::InvestigationBundle;
use crate::audit;
use crate::cli::ContinueArgs;
use crate::commands::verify;
use crate::pi::{run_prompt, PiConfig};
use crate::prompt::PromptSpeed;
use crate::{prompt, runtime};
use anyhow::{bail, Context, Result};
use std::path::Path;
use std::time::{Instant, SystemTime};

/// Opt-in (exactly `1`): a follow-up hands Pi the settings the first question
/// would get under the same environment (speed and merge switches as set, the
/// Lieflat fallback tools hidden as the hide switch says) instead of turning
/// them off. Only the speed/merge settings follow; the tool profile logic is
/// unchanged.
pub const FOLLOWUP_SAME_SETTINGS_ENV: &str = "NEWSROOM_FOLLOWUP_SAME_SETTINGS";

fn followup_same_settings_on() -> bool {
    std::env::var(FOLLOWUP_SAME_SETTINGS_ENV).ok().as_deref() == Some("1")
}

/// Opt-in (exactly `1`): a follow-up runs the completion check the first
/// question runs (the model is sent back at most twice when the requested
/// visual work is not done), and each round's verification is recorded apart:
/// the verification file a round replaces is first kept under
/// `verification-rounds/`, and a round that fails before verification writes
/// a record saying so instead of leaving the previous round's pass in place.
pub const FOLLOWUP_COMPLETION_ENV: &str = "NEWSROOM_FOLLOWUP_COMPLETION_GATE";

fn followup_completion_gate_on() -> bool {
    std::env::var(FOLLOWUP_COMPLETION_ENV).ok().as_deref() == Some("1")
}

/// Opt-in (exactly `1`): after a follow-up, the `primary_artifact:` line names the newest chart this
/// round made that passed its checks (render QA, critic and verification records on disk). A round that
/// made no such chart keeps the line it printed before. Off: the line is unchanged.
pub const FOLLOWUP_PRIMARY_LATEST_ENV: &str = "NEWSROOM_FOLLOWUP_PRIMARY_LATEST";

fn followup_primary_latest_on() -> bool {
    std::env::var(FOLLOWUP_PRIMARY_LATEST_ENV).ok().as_deref() == Some("1")
}

const ROUNDS_DIR: &str = "verification-rounds";

/// Copies the current `verification.json` to the next free
/// `verification-rounds/round-N.json` (never overwriting one) and returns that
/// relative path; `None` when there is no verification file yet.
fn archive_previous_verification(artifact: &Path) -> Result<Option<String>> {
    let current = artifact.join("verification.json");
    if !current.is_file() {
        return Ok(None);
    }
    let dir = artifact.join(ROUNDS_DIR);
    std::fs::create_dir_all(&dir)?;
    let mut n = 1;
    loop {
        let target = dir.join(format!("round-{n}.json"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(&std::fs::read(&current)?)?;
                return Ok(Some(format!("{ROUNDS_DIR}/round-{n}.json")));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(error) => return Err(error).context("failed to archive verification.json"),
        }
    }
}

/// A round that ended before verification ran: the current result is "not
/// verified" for this round, and the file names where the previous round's
/// verification was kept.
fn record_round_not_verified(
    artifact: &Path,
    previous: Option<&str>,
    stage: &str,
    reason: &str,
) -> Result<()> {
    let record = serde_json::json!({
        "schema_version": "0.7.0",
        "verified_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "passed": false,
        "checks": 0,
        "round_status": "not_verified",
        "stage": stage,
        "reason": reason,
        "previous_round_file": previous,
    });
    std::fs::write(
        artifact.join("verification.json"),
        format!("{}\n", serde_json::to_string_pretty(&record)?),
    )
    .context("failed to write verification.json")
}

/// The completion gaps of this round only: calls made in earlier rounds do
/// not count as this round's work.
fn followup_completion_gaps(
    bundle: &InvestigationBundle,
    goal: &str,
    audit: &audit::AuditSummary,
    calls_before: usize,
    profile: Option<&str>,
) -> Result<Vec<String>> {
    let mut this_round = audit.clone();
    this_round.calls = audit.calls.iter().skip(calls_before).cloned().collect();
    crate::commands::investigate::visual_completion_gaps_for_profile(
        bundle,
        goal,
        &this_round,
        crate::commands::investigate::complex_visual_routing_ab_enabled(),
        profile,
    )
}

/// The text the first question sends when the completion check finds gaps
/// (kept equal to commands/investigate.rs by a test).
fn completion_retry_message(attempt: usize, gaps: &[String], mode_contract: &str) -> String {
    format!(
        "System completion gate attempt {attempt}/2 found unfinished required work:\n- {}\n{}Continue the same session and repair only these gaps using the real visual-story tools. Do not weaken, remove, relabel, or replace requested visuals with prose or illustrations. Complete every required infographic and publication gate, then write the self-contained HTML and requested desktop/mobile PNG files under NEWSROOM_ARTIFACT_DIR. Do not invent evidence or quantitative claims.",
        gaps.join("\n- "),
        mode_contract,
    )
}

/// `(hide_lieflat, speed)` for the follow-up's `PiConfig`.
fn followup_settings(same_settings: bool) -> (bool, PromptSpeed) {
    if same_settings {
        (
            crate::pi::hide_lieflat_switch_enabled(),
            crate::pi::speed_switches_from_env(),
        )
    } else {
        (false, Default::default())
    }
}

/// Text-based routing used when nothing better is known.
fn inferred_tool_profile(text: &str) -> &'static str {
    if prompt::is_complex_visual_request(text) {
        "visual-story"
    } else if prompt::is_visual_request(text) {
        "visual"
    } else {
        "investigate"
    }
}

/// The profile a follow-up runs with, and whether it was carried over from
/// the previous run.
///
/// An explicit `--tool-profile` other than the default always wins. Left at
/// the default, the profile the previous Pi run recorded is reused so a
/// follow-up does not silently drop tools the investigation was built with
/// (a visual-story run whose follow-up text no longer mentions a chart must
/// not fall back to `investigate`). Nothing recorded, or a recorded
/// `investigate`, keeps the text inference, including its escalation from a
/// recorded `visual` to `visual-story` for a complex follow-up.
///
/// The default cannot be told apart from an explicit
/// `--tool-profile investigate`; both count as "not specified".
fn effective_tool_profile(requested: &str, text: &str, recorded: Option<&str>) -> (String, bool) {
    if requested != "investigate" {
        return (requested.to_string(), false);
    }
    let inferred = inferred_tool_profile(text);
    match recorded {
        Some("investigate") | None => (inferred.to_string(), false),
        Some("visual") if inferred == "visual-story" => (inferred.to_string(), false),
        Some(profile) => (profile.to_string(), true),
    }
}

pub async fn run(args: ContinueArgs) -> Result<()> {
    let run_started = Instant::now();
    if !crate::step_lines::enabled() {
        eprintln!(
            "[agent] phase=preparing elapsed_ms={}",
            run_started.elapsed().as_millis()
        );
    }
    let bundle = InvestigationBundle::open(&args.artifact)?;
    let topic = bundle.topic()?;
    let message = args.message.join(" ");
    crate::step_lines::begin(&message);
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

    let recorded_profile = bundle.recorded_tool_profile();
    let (tool_profile, reused_profile) = effective_tool_profile(
        &args.pi.tool_profile,
        &format!("{topic} {message}"),
        recorded_profile.as_deref(),
    );
    if reused_profile {
        eprintln!(
            "continue: reusing tool profile {tool_profile} recorded by the previous run (pass --tool-profile to override)"
        );
    }

    let (hide_lieflat, speed) = followup_settings(followup_same_settings_on());
    let config = PiConfig {
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
        continue_session: true,
        tool_profile,
        hide_lieflat,
        speed,
        compose: None,
    };
    let reported_provider = config.effective_provider();

    eprintln!("continuing: {}", bundle.id);
    eprintln!("runtime: {}", config.display_runtime());
    eprintln!("artifact: {}\n", bundle.dir.display());

    let follow_up = format!(
        "Continue the same investigation using the existing conversation and evidence. User follow-up:\n\n{}\n\nApply the same evidence and autonomy rules as the original investigation. Reuse existing evidence when it remains valid, and acquire or compute additional evidence only when the updated goal requires it.{}",
        message,
        prompt::language_instruction(&message)
    );

    let completion_gate = followup_completion_gate_on();
    let goal = format!("{topic} {message}");
    let (calls_before, archived) = if completion_gate {
        let before = if bundle.events_path.is_file() {
            audit::build(&bundle.events_path, &bundle.tools_path)
                .map(|value| value.calls.len())
                .unwrap_or(0)
        } else {
            0
        };
        (before, archive_previous_verification(&bundle.dir)?)
    } else {
        (0, None)
    };
    audit::append_user_goal_event(&bundle.events_path, "follow_up")?;
    let round_started_at = SystemTime::now();
    match run_prompt(&config, &follow_up, Some(&bundle.events_path)).await {
        Ok(result) => {
            let persistence_started = Instant::now();
            bundle.write_answer(&result.text)?;
            bundle.append_conversation(&message, &result.text)?;
            if let Some(stats) = &result.session_stats {
                bundle.write_session_stats(stats)?;
            }
            let mut audit = audit::build(&bundle.events_path, &bundle.tools_path)?;
            let mut completion_gaps = Vec::new();
            if completion_gate {
                let split = crate::commands::investigate::complex_visual_routing_ab_enabled();
                let profile = bundle.recorded_tool_profile();
                completion_gaps = followup_completion_gaps(
                    &bundle,
                    &goal,
                    &audit,
                    calls_before,
                    profile.as_deref(),
                )?;
                if crate::commands::investigate::is_complex_visual_request(&goal, split) {
                    for attempt in 1..=2 {
                        if completion_gaps.is_empty() {
                            break;
                        }
                        audit::append_completion_retry_event(
                            &bundle.events_path,
                            attempt,
                            &completion_gaps,
                        )?;
                        let correction = completion_retry_message(
                            attempt,
                            &completion_gaps,
                            &prompt::visual_mode_contract(&goal),
                        );
                        let recovery = "The provider returned an empty response before completing the previous system completion-gate instruction. Continue the same session now. Do not restart research or weaken any requested visual; finish the outstanding infographic and publication gates.";
                        let retry =
                            match crate::commands::investigate::run_prompt_with_empty_recovery(
                                &config,
                                &correction,
                                recovery,
                                &bundle.events_path,
                            )
                            .await
                            {
                                Ok(retry) => retry,
                                Err(error) => {
                                    record_round_not_verified(
                                        &bundle.dir,
                                        archived.as_deref(),
                                        "completion_gate_retry_failed",
                                        &format!("{error:#}"),
                                    )?;
                                    return Err(verify::exit_on_error(&error));
                                }
                            };
                        bundle.write_answer(&retry.text)?;
                        if let Some(stats) = &retry.session_stats {
                            bundle.write_session_stats(stats)?;
                        }
                        audit = audit::build(&bundle.events_path, &bundle.tools_path)?;
                        completion_gaps = followup_completion_gaps(
                            &bundle,
                            &goal,
                            &audit,
                            calls_before,
                            profile.as_deref(),
                        )?;
                    }
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
                "continue",
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
                record_round_not_verified(
                    &bundle.dir,
                    archived.as_deref(),
                    "completion_gate",
                    &completion_gaps.join("; "),
                )?;
                bail!("visual delivery incomplete: {}", completion_gaps.join("; "));
            }
            // Step lines on: the verdict is computed here so the closing line sits right above primary_artifact.
            let early_verdict = if crate::step_lines::enabled() {
                let verdict = verify::post_run_verdict(&bundle.dir).await;
                crate::step_lines::print_final(verdict.is_none());
                Some(verdict)
            } else {
                None
            };
            let latest = if followup_primary_latest_on() {
                bundle.latest_passing_chart_since(round_started_at)?
            } else {
                None
            };
            match latest.or(bundle.primary_artifact()?) {
                Some((path, kind)) => {
                    eprintln!(
                        "\nprimary_artifact: {} ({kind})",
                        bundle.dir.join(path).display()
                    );
                    eprintln!("manifest (metadata): {}", bundle.manifest_path.display());
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
            verify::exit_if_not_verified(verified);
            Ok(())
        }
        Err(error) => {
            if completion_gate {
                record_round_not_verified(
                    &bundle.dir,
                    archived.as_deref(),
                    "run_failed",
                    &format!("{error:#}"),
                )?;
            }
            let audit = if bundle.events_path.is_file() {
                audit::build(&bundle.events_path, &bundle.tools_path).ok()
            } else {
                None
            };
            bundle.append_run_metric(
                "continue",
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
            Err(verify::exit_on_error(&error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        effective_tool_profile, followup_same_settings_on, followup_settings,
        FOLLOWUP_SAME_SETTINGS_ENV,
    };
    use crate::artifact::InvestigationBundle;
    use crate::pi::{PiConfig, ENV_LOCK};
    use std::fs;

    #[test]
    fn default_flag_reuses_the_recorded_profile() {
        let follow_up = "thanks, now add one more caveat";
        assert_eq!(
            effective_tool_profile("investigate", follow_up, Some("visual-story")),
            ("visual-story".to_string(), true)
        );
        assert_eq!(
            effective_tool_profile("investigate", follow_up, Some("publication")),
            ("publication".to_string(), true)
        );
    }

    #[test]
    fn explicit_profile_beats_the_recorded_one() {
        assert_eq!(
            effective_tool_profile("competition", "make a chart", Some("visual-story")),
            ("competition".to_string(), false)
        );
        assert_eq!(
            effective_tool_profile("visual", "anything", Some("visual-story")),
            ("visual".to_string(), false)
        );
    }

    #[test]
    fn nothing_recorded_keeps_the_text_inference() {
        assert_eq!(
            effective_tool_profile("investigate", "summarize the source", None),
            ("investigate".to_string(), false)
        );
        assert_eq!(
            effective_tool_profile("investigate", "make a chart", None),
            ("visual".to_string(), false)
        );
        assert_eq!(
            effective_tool_profile("investigate", "做一张信息长图", None),
            ("visual-story".to_string(), false)
        );
        // A recorded plain-investigate run is not a reason to stay there.
        assert_eq!(
            effective_tool_profile("investigate", "make a chart", Some("investigate")),
            ("visual".to_string(), false)
        );
        // An unknown recorded profile never reaches here (the artifact reader
        // filters it), so inference applies.
        assert_eq!(
            effective_tool_profile("investigate", "make a chart", None).0,
            "visual"
        );
    }

    #[test]
    fn complex_follow_up_still_escalates_a_recorded_visual_run() {
        assert_eq!(
            effective_tool_profile("investigate", "做一张信息长图", Some("visual")),
            ("visual-story".to_string(), false)
        );
        assert_eq!(
            effective_tool_profile("investigate", "make a chart", Some("visual")),
            ("visual".to_string(), true)
        );
    }

    #[test]
    fn profile_is_read_from_the_artifact_metrics() {
        let root = tempfile::tempdir().unwrap();
        let bundle = InvestigationBundle::create(root.path(), "profile memory").unwrap();
        fs::write(
            &bundle.events_path,
            "{\"type\":\"newsroom_rpc_metrics\",\"tool_profile\":\"visual-story\"}\n",
        )
        .unwrap();
        let recorded = bundle.recorded_tool_profile();
        assert_eq!(
            effective_tool_profile("investigate", "keep going", recorded.as_deref()),
            ("visual-story".to_string(), true)
        );
        let empty = tempfile::tempdir().unwrap();
        let fresh = InvestigationBundle::create(empty.path(), "no metrics").unwrap();
        assert_eq!(
            effective_tool_profile(
                "investigate",
                "keep going",
                fresh.recorded_tool_profile().as_deref()
            ),
            ("investigate".to_string(), false)
        );
    }

    const SPEED_ENVS: [&str; 16] = [
        "NEWSROOM_SPEED_PARALLEL_HINTS",
        "NEWSROOM_SPEED_COMPUTE_BATCH",
        "NEWSROOM_SPEED_ATOMIC_ARTIFACT",
        "NEWSROOM_SPEED_CHAIN_VIZ",
        "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC",
        "NEWSROOM_SPEED_PREFLIGHT",
        "NEWSROOM_SPEED_PLAN_EDIT",
        "NEWSROOM_SPEED_INLINE_CLAIM",
        "NEWSROOM_SPEED_PLAN_PATCH",
        "NEWSROOM_SPEED_CHAIN_PATCH",
        "NEWSROOM_SPEED_REPORT_ALL",
        "NEWSROOM_SPEED_FILL_COPIED_REFS",
        "NEWSROOM_SPEED_FIRST_TRY_TEXT",
        "NEWSROOM_SPEED_DATA_PROFILE",
        "NEWSROOM_SPEED_PLAN_PROGRESS",
        "NEWSROOM_HIDE_LIEFLAT",
    ];

    fn clear_env() {
        for name in SPEED_ENVS {
            std::env::remove_var(name);
        }
        std::env::remove_var(FOLLOWUP_SAME_SETTINGS_ENV);
    }

    fn set_all_speed_switches() {
        for name in SPEED_ENVS {
            std::env::set_var(name, "1");
        }
    }

    fn config(
        profile: &str,
        continue_session: bool,
        hide: bool,
        speed: crate::prompt::PromptSpeed,
    ) -> PiConfig {
        PiConfig {
            binary: "pi".into(),
            provider: None,
            model: None,
            api_key: None,
            base_url: None,
            thinking: None,
            approve_project: false,
            extension: Some("ext.ts".into()),
            artifact_dir: Some("/tmp/artifact".into()),
            session_dir: Some("/tmp/artifact/session".into()),
            continue_session,
            tool_profile: profile.to_string(),
            hide_lieflat: hide,
            speed,
            compose: None,
        }
    }

    /// The environment Pi gets for the run: every NEWSROOM_* name with its
    /// value, or None where the command removes it.
    fn pi_env(config: &PiConfig) -> Vec<(String, Option<String>)> {
        let command = config.command();
        let mut out: Vec<(String, Option<String>)> = command
            .as_std()
            .get_envs()
            .filter(|(name, _)| name.to_string_lossy().starts_with("NEWSROOM_"))
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        out.sort();
        out
    }

    /// What `investigate` hands Pi for the first question under the same env.
    fn first_question(profile: &str) -> PiConfig {
        config(
            profile,
            false,
            crate::pi::hide_lieflat_switch_enabled(),
            crate::pi::speed_switches_from_env(),
        )
    }

    fn follow_up(profile: &str, same: bool) -> PiConfig {
        let (hide, speed) = followup_settings(same);
        config(profile, true, hide, speed)
    }

    #[test]
    fn switch_is_exactly_one() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_env();
        assert!(!followup_same_settings_on());
        for not_one in ["0", "true", "yes", "", " 1", "01"] {
            std::env::set_var(FOLLOWUP_SAME_SETTINGS_ENV, not_one);
            assert!(!followup_same_settings_on(), "{not_one:?}");
        }
        std::env::set_var(FOLLOWUP_SAME_SETTINGS_ENV, "1");
        assert!(followup_same_settings_on());
        clear_env();
    }

    #[test]
    fn switch_on_follow_up_settings_and_tools_equal_the_first_questions() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_env();
        set_all_speed_switches();
        for profile in [
            "investigate",
            "visual",
            "visual-story",
            "publication",
            "competition",
        ] {
            let first = first_question(profile);
            let second = follow_up(profile, true);
            assert!(first.speed.chain_viz && first.speed.parallel_hints);
            assert_eq!(second.speed, first.speed, "{profile}: speed settings");
            assert_eq!(
                second.tools_arg(),
                first.tools_arg(),
                "{profile}: tool list"
            );
            assert_eq!(
                pi_env(&second),
                pi_env(&first),
                "{profile}: env handed to Pi"
            );
        }
        // The merge settings and the fallback-tool hiding are the ones the old follow-up dropped.
        let second = follow_up("visual-story", true);
        assert!(second.speed.compute_batch && second.speed.chain_infographic);
        assert!(!second.tools_arg().contains("newsroom_lieflat_render"));
        clear_env();
    }

    #[test]
    fn switch_on_with_nothing_set_equals_the_first_question_too() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_env();
        for profile in ["investigate", "visual-story"] {
            let first = first_question(profile);
            let second = follow_up(profile, true);
            assert_eq!(second.tools_arg(), first.tools_arg());
            assert_eq!(pi_env(&second), pi_env(&first));
        }
    }

    #[test]
    fn switch_off_follow_up_ignores_the_speed_environment_as_before() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_env();
        set_all_speed_switches();
        for profile in ["investigate", "visual", "visual-story"] {
            let legacy = config(profile, true, false, Default::default());
            let second = follow_up(profile, false);
            assert_eq!(second.speed, Default::default());
            assert_eq!(
                second.tools_arg(),
                legacy.tools_arg(),
                "{profile}: tool list"
            );
            assert_eq!(
                pi_env(&second),
                pi_env(&legacy),
                "{profile}: env handed to Pi"
            );
            // Every speed name is removed from the child's environment, as in f2aec34.
            let env = pi_env(&second);
            for name in SPEED_ENVS {
                if let Some((_, value)) = env.iter().find(|(n, _)| n == name) {
                    assert_eq!(value, &None, "{name} must be removed");
                }
            }
        }
        // The fallback tools stay in the visual-story list.
        assert!(follow_up("visual-story", false)
            .tools_arg()
            .contains("newsroom_lieflat_render"));
        clear_env();
    }
    #[test]
    fn primary_latest_switch_is_exactly_one() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for (value, on) in [
            ("1", true),
            ("0", false),
            ("true", false),
            ("yes", false),
            ("", false),
            (" 1", false),
            ("01", false),
        ] {
            std::env::set_var(super::FOLLOWUP_PRIMARY_LATEST_ENV, value);
            assert_eq!(super::followup_primary_latest_on(), on, "{value:?}");
        }
        std::env::remove_var(super::FOLLOWUP_PRIMARY_LATEST_ENV);
        assert!(!super::followup_primary_latest_on());
    }
    #[test]
    fn completion_switch_is_exactly_one() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for (value, on) in [
            ("1", true),
            ("0", false),
            ("true", false),
            ("yes", false),
            ("", false),
            (" 1", false),
            ("01", false),
        ] {
            std::env::set_var(super::FOLLOWUP_COMPLETION_ENV, value);
            assert_eq!(super::followup_completion_gate_on(), on, "{value:?}");
        }
        std::env::remove_var(super::FOLLOWUP_COMPLETION_ENV);
        assert!(!super::followup_completion_gate_on());
    }

    #[test]
    fn retry_message_is_the_one_the_first_question_sends() {
        let gaps = vec!["gap one".to_string(), "gap two".to_string()];
        let message = super::completion_retry_message(2, &gaps, "CONTRACT ");
        assert!(message.starts_with(
            "System completion gate attempt 2/2 found unfinished required work:\n- gap one\n- gap two\nCONTRACT Continue the same session"
        ));
        // The sentence after the gaps is the same literal text as in commands/investigate.rs.
        let tail = message.split("CONTRACT ").nth(1).unwrap();
        let investigate = include_str!("investigate.rs");
        assert!(
            investigate.contains(tail),
            "retry wording drifted from investigate.rs"
        );
        assert!(investigate.contains(
            "System completion gate attempt {attempt}/2 found unfinished required work:"
        ));
    }

    #[test]
    fn previous_verification_is_kept_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            super::archive_previous_verification(dir.path()).unwrap(),
            None
        );
        assert!(!dir.path().join("verification-rounds").exists());
        let first = "{\"passed\": true, \"round\": \"first\"}\n";
        fs::write(dir.path().join("verification.json"), first).unwrap();
        assert_eq!(
            super::archive_previous_verification(dir.path())
                .unwrap()
                .as_deref(),
            Some("verification-rounds/round-1.json")
        );
        // A later verification.json is archived next to it, not over it.
        fs::write(
            dir.path().join("verification.json"),
            "{\"passed\": false}\n",
        )
        .unwrap();
        assert_eq!(
            super::archive_previous_verification(dir.path())
                .unwrap()
                .as_deref(),
            Some("verification-rounds/round-2.json")
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("verification-rounds/round-1.json")).unwrap(),
            first
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("verification-rounds/round-2.json")).unwrap(),
            "{\"passed\": false}\n"
        );
    }

    #[test]
    fn a_round_that_does_not_verify_is_not_read_as_the_previous_pass() {
        let dir = tempfile::tempdir().unwrap();
        let pass = "{\"passed\": true}\n";
        fs::write(dir.path().join("verification.json"), pass).unwrap();
        let kept = super::archive_previous_verification(dir.path()).unwrap();
        super::record_round_not_verified(dir.path(), kept.as_deref(), "run_failed", "boom")
            .unwrap();
        let now: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join("verification.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(now["passed"], false);
        assert_eq!(now["round_status"], "not_verified");
        assert_eq!(now["stage"], "run_failed");
        assert_eq!(
            now["previous_round_file"],
            "verification-rounds/round-1.json"
        );
        // The earlier pass is still on disk, byte for byte.
        assert_eq!(
            fs::read_to_string(dir.path().join("verification-rounds/round-1.json")).unwrap(),
            pass
        );
    }
}
