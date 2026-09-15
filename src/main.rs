mod artifact;
mod audit;
mod cli;
mod commands;
mod hash;
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
    let cli = Cli::parse();

    match cli.command {
        Commands::Doctor(args) => commands::doctor::run(args).await,
        Commands::Ask(args) => commands::ask::run(args).await,
        Commands::Investigate(args) => commands::investigate::run(args).await,
        Commands::Continue(args) => commands::continue_investigation::run(args).await,
        Commands::Inspect(args) => commands::inspect::run(args).await,
        Commands::Verify(args) => commands::verify::run(args).await,
    }
}
