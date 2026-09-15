use crate::artifact::InvestigationBundle;
use crate::audit;
use crate::cli::InvestigateArgs;
use crate::pi::{run_prompt, PiConfig};
use crate::{prompt, runtime};
use anyhow::Result;
use std::time::Instant;

pub async fn run(args: InvestigateArgs) -> Result<()> {
    let topic = args.topic.join(" ");
    let declared_local_data: Vec<String> = args
        .data
        .iter()
        .filter_map(|path| path.file_name().and_then(|value| value.to_str()))
        .map(|name| format!("data/{name}"))
        .collect();

    if args.dry_run {
        let prompt = prompt::investigation(&topic, &declared_local_data);
        print!("{prompt}");
        return Ok(());
    }

    let bundle = InvestigationBundle::create(&args.out, &topic)?;
    let mut local_data = Vec::new();
    for source in &args.data {
        local_data.push(bundle.import_data(source)?);
    }
    let prompt = prompt::investigation(&topic, &local_data);
    bundle.write_prompt(&prompt)?;
    bundle.write_manifest(
        &topic,
        args.pi.provider.as_deref(),
        args.pi.model.as_deref(),
        "draft",
        None,
    )?;
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
        continue_session: false,
        tool_profile: args.pi.tool_profile,
    };

    eprintln!("investigation: {}", bundle.id);
    eprintln!("runtime: {}", config.display_runtime());
    eprintln!("artifact: {}\n", bundle.dir.display());

    audit::append_user_goal_event(&bundle.events_path, "initial")?;
    let run_started = Instant::now();
    match run_prompt(&config, &prompt, Some(&bundle.events_path)).await {
        Ok(result) => {
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
            if status == "incomplete" {
                eprintln!(
                    "\n[qualification] investigation completed without enough observable planning/tool evidence; inspect tools.json"
                );
            }
            eprintln!("\nwritten: {}", bundle.manifest_path.display());
            Ok(())
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
