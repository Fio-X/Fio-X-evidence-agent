use crate::artifact::InvestigationBundle;
use crate::audit;
use crate::cli::InvestigateArgs;
use crate::pi::{run_prompt, PiConfig};
use crate::{output, prompt, runtime};
use anyhow::Result;
use std::path::PathBuf;
use std::time::Instant;

pub async fn run(args: InvestigateArgs) -> Result<()> {
    if args.dry_run {
        let topic = args.topic.join(" ");
        let declared_local_data: Vec<String> = args
            .data
            .iter()
            .filter_map(|path| path.file_name().and_then(|value| value.to_str()))
            .map(|name| format!("data/{name}"))
            .collect();
        let prompt = prompt::investigation(&topic, &declared_local_data);
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
    let prompt = prompt::investigation(&topic, &local_data);
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

    let config = PiConfig {
        binary: args.pi.pi_bin,
        provider: args.pi.provider,
        model: args.pi.model,
        thinking: args.pi.thinking,
        approve_project: args.pi.approve_project,
        extension: Some(extension),
        artifact_dir: Some(bundle.dir.clone()),
        session_dir: Some(bundle.session_dir.clone()),
        continue_session: false,
        tool_profile: args.pi.tool_profile,
    };
    let reported_provider = config.effective_provider();

    eprintln!("investigation: {}", bundle.id);
    eprintln!("runtime: {}", config.display_runtime());
    eprintln!("artifact: {}\n", bundle.dir.display());

    audit::append_user_goal_event(&bundle.events_path, "initial")?;
    match run_prompt(&config, &prompt, Some(&bundle.events_path)).await {
        Ok(result) => {
            let persistence_started = Instant::now();
            bundle.write_answer(&result.text)?;
            bundle.append_conversation(&topic, &result.text)?;
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
            if status == "incomplete" {
                eprintln!(
                    "\n[qualification] investigation completed without enough observable planning/tool evidence; inspect tools.json"
                );
            }
            eprintln!("\nwritten: {}", bundle.manifest_path.display());
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
