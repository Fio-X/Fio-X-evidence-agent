use crate::cli::AskArgs;
use crate::pi::{run_prompt, PiConfig};
use anyhow::Result;

pub async fn run(args: AskArgs) -> Result<()> {
    let prompt = args.prompt.join(" ");
    let config = PiConfig {
        binary: args.pi.pi_bin,
        provider: args.pi.provider,
        model: args.pi.model,
        thinking: args.pi.thinking,
        approve_project: args.pi.approve_project,
        extension: None,
        artifact_dir: None,
        session_dir: None,
        continue_session: false,
        tool_profile: args.pi.tool_profile,
    };

    run_prompt(&config, &prompt, None).await?;
    Ok(())
}
