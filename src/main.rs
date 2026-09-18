mod agent;
mod artifact;
mod audit;
mod cli;
mod commands;
mod config;
mod hash;
mod interactive;
mod llm;
mod output;
mod pi;
mod prompt;
mod runtime;
mod tool_registry;
mod verify;

use anyhow::Result;
use clap::Parser;
use cli::{Cli, Commands};

#[tokio::main]
async fn main() -> Result<()> {
    config::load_project_env()?;
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Doctor(args)) => commands::doctor::run(args).await,
        Some(Commands::Ask(args)) => commands::ask::run(args).await,
        Some(Commands::Chat(args)) => commands::chat::run(args).await,
        Some(Commands::Investigate(args)) => commands::investigate::run(args).await,
        Some(Commands::InvestigateV2(args)) => commands::investigate_v2::run(args).await,
        Some(Commands::Continue(args)) => commands::continue_investigation::run(args).await,
        Some(Commands::Inspect(args)) => commands::inspect::run(args).await,
        Some(Commands::Verify(args)) => commands::verify::run(args).await,
        None => interactive::run().await,
    }
}
