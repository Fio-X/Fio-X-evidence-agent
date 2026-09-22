use crate::artifact::InvestigationBundle;
use crate::audit;
use crate::cli::ContinueArgs;
use crate::pi::{run_prompt, PiConfig};
use crate::{prompt, runtime};
use anyhow::Result;
use std::time::Instant;

fn effective_tool_profile(requested: &str, text: &str) -> String {
    if requested != "investigate" {
        return requested.to_string();
    }
    if prompt::is_complex_visual_request(text) {
        "visual-story".to_string()
    } else if prompt::is_visual_request(text) {
        "visual".to_string()
    } else {
        requested.to_string()
    }
}

pub async fn run(args: ContinueArgs) -> Result<()> {
    let run_started = Instant::now();
    eprintln!(
        "[agent] phase=preparing elapsed_ms={}",
        run_started.elapsed().as_millis()
    );
    let bundle = InvestigationBundle::open(&args.artifact)?;
    let topic = bundle.topic()?;
    let message = args.message.join(" ");
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
        tool_profile: effective_tool_profile(&args.pi.tool_profile, &format!("{topic} {message}")),
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

    audit::append_user_goal_event(&bundle.events_path, "follow_up")?;
    match run_prompt(&config, &follow_up, Some(&bundle.events_path)).await {
        Ok(result) => {
            let persistence_started = Instant::now();
            bundle.write_answer(&result.text)?;
            bundle.append_conversation(&message, &result.text)?;
            if let Some(stats) = &result.session_stats {
                bundle.write_session_stats(stats)?;
            }
            let audit = audit::build(&bundle.events_path, &bundle.tools_path)?;
            let status = if audit.has_agent_loop_evidence() {
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
            match bundle.primary_artifact()? {
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
            Ok(())
        }
        Err(error) => {
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
            Err(error)
        }
    }
}
