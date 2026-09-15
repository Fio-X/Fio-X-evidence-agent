use crate::artifact::InvestigationBundle;
use crate::audit;
use crate::cli::ContinueArgs;
use crate::pi::{run_prompt, PiConfig};
use crate::runtime;
use anyhow::Result;
use std::time::Instant;

pub async fn run(args: ContinueArgs) -> Result<()> {
    let bundle = InvestigationBundle::open(&args.artifact)?;
    let topic = bundle.topic()?;
    let message = args.message.join(" ");
    let extension = runtime::materialize_extension(&bundle.dir)?;

    let config = PiConfig {
        binary: args.pi.pi_bin,
        provider: args.pi.provider,
        model: args.pi.model,
        thinking: args.pi.thinking,
        approve_project: args.pi.approve_project,
        extension: Some(extension),
        artifact_dir: Some(bundle.dir.clone()),
        session_dir: Some(bundle.session_dir.clone()),
        continue_session: true,
        tool_profile: args.pi.tool_profile,
    };

    eprintln!("continuing: {}", bundle.id);
    eprintln!("runtime: {}", config.display_runtime());
    eprintln!("artifact: {}\n", bundle.dir.display());

    let follow_up = format!(
        "Continue the same investigation using the existing conversation and evidence. User follow-up:\n\n{}\n\nApply the same evidence and autonomy rules as the original investigation. Reuse existing evidence when it remains valid, and acquire or compute additional evidence only when the updated goal requires it.",
        message
    );

    audit::append_user_goal_event(&bundle.events_path, "follow_up")?;
    let run_started = Instant::now();
    match run_prompt(&config, &follow_up, Some(&bundle.events_path)).await {
        Ok(result) => {
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
                config.provider.as_deref(),
                config.model.as_deref(),
                status,
                run_started.elapsed().as_millis(),
                Some(&audit),
            )?;
            bundle.write_manifest(
                &topic,
                config.provider.as_deref(),
                config.model.as_deref(),
                status,
                Some(&audit),
            )?;
            eprintln!("\nupdated: {}", bundle.manifest_path.display());
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
                config.provider.as_deref(),
                config.model.as_deref(),
                "failed",
                run_started.elapsed().as_millis(),
                audit.as_ref(),
            )?;
            bundle.write_manifest(
                &topic,
                config.provider.as_deref(),
                config.model.as_deref(),
                "failed",
                audit.as_ref(),
            )?;
            Err(error)
        }
    }
}
