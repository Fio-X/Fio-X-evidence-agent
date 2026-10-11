mod agent;
mod artifact;
mod audit;
mod cli;
mod commands;
mod compose_answer;
mod config;
mod data_profile;
mod group_guard;
mod hash;
mod interactive;
mod llm;
mod output;
mod pi;
mod prompt;
mod recipes;
mod repeat_failure;
mod runtime;
mod step_lines;
mod tool_registry;
mod verify;

use anyhow::Result;
use clap::Parser;
use cli::{Cli, Commands};

#[tokio::main]
async fn main() -> Result<()> {
    config::load_project_env()?;
    let args = match cli::launch(std::env::args_os().collect()) {
        cli::Launch::Parse(args) => args,
        cli::Launch::Done(code) => std::process::exit(code),
    };
    let cli = Cli::parse_from(args);
    group_guard::startup_check()?;
    let command_name: &'static str = match &cli.command {
        Some(Commands::Doctor(_)) => "doctor",
        Some(Commands::Ask(_)) => "ask",
        Some(Commands::Chat(_)) => "chat",
        Some(Commands::Investigate(_)) => "investigate",
        Some(Commands::InvestigateV2(_)) => "investigate-v2",
        Some(Commands::Continue(_)) => "continue",
        Some(Commands::Inspect(_)) => "inspect",
        Some(Commands::Verify(_)) => "verify",
        None => "",
    };
    group_guard::enter_command(command_name, cli::group_of(command_name));

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
