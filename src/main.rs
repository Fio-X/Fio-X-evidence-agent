#[allow(dead_code)]
// 1011ak 9a: only the Rust agent child (NEWSROOM_AGENT=rust) uses it; unused parts are trimmed later
mod agent_loop;
#[allow(dead_code)]
// 1011ak 9a: only the Rust agent child (NEWSROOM_AGENT=rust) uses it; unused parts are trimmed later
mod agent_prompt;
mod agent_serve;
#[cfg(test)]
mod agent_watch;
#[allow(dead_code)]
// 1011ak 9a: only the Rust agent child (NEWSROOM_AGENT=rust) uses it; unused parts are trimmed later
mod anthropic_model;
mod artifact;
mod audit;
mod auto_checks;
mod classify;
mod cli;
mod commands;
mod compose_answer;
mod config;
mod data_profile;
mod group_guard;
mod hash;
mod interactive;
mod l5geo;
mod llm;
#[cfg(test)]
mod model_fake;
mod model_timing;
mod next_companion;
#[cfg(test)]
mod next_drive;
mod next_flow;
mod next_knowledge;
#[allow(dead_code)]
// no page node prints through it until the page nodes land; dropped when they do
mod next_ledger;
#[allow(dead_code)]
// no page node is registered until the page nodes land; dropped when next_visual::call reaches the registry
mod next_nodes;
mod next_pack;
mod next_page;
mod next_params;
mod next_run;
mod next_serve;
mod next_visual;
mod number_audit;
#[cfg(test)]
mod openai_model;
mod output;
mod pi;
mod prompt;
mod recipes;
mod repeat_failure;
mod runtime;
#[allow(dead_code)]
// 1011ak 9a: only the Rust agent child (NEWSROOM_AGENT=rust) uses it; unused parts are trimmed later
mod session_store;
mod shape_registry;
#[allow(dead_code)]
// 1011ak 9a: only the Rust agent child (NEWSROOM_AGENT=rust) uses it; unused parts are trimmed later
mod staging;
mod step_lines;
#[allow(dead_code)]
// 1011ak 9a: only the Rust agent child (NEWSROOM_AGENT=rust) uses it; unused parts are trimmed later
mod tool_host;
mod tool_registry;
#[allow(dead_code)]
// 1011ak 9a: only the Rust agent child (NEWSROOM_AGENT=rust) uses it; unused parts are trimmed later
mod tool_schema;
mod verify;

use anyhow::Result;
use clap::Parser;
use cli::{Cli, Commands};

#[tokio::main]
async fn main() -> Result<()> {
    // NEWSROOM_AGENT=rust (exactly): the Rust agent child of a run. It reads no configuration, `.env` file or key (1011ak 9a).
    if agent_loop::agent_rust_enabled() {
        let mut args = std::env::args().skip(1);
        if args.next().as_deref() == Some(agent_serve::SERVE_ARG) {
            return agent_serve::serve(args.collect()).await;
        }
        // gate A (NEWSROOM_AGENT_REAL=1): the parent of a real-model run reads the configuration as on the Pi path, to hand the key over
        if agent_serve::real_enabled() {
            config::load_project_env()?;
        }
    } else {
        config::load_project_env()?;
    }
    let args = match cli::launch(std::env::args_os().collect()) {
        cli::Launch::Parse(args) => args,
        cli::Launch::Done(code) => std::process::exit(code),
    };
    let cli = Cli::parse_from(args);
    group_guard::startup_check()?;
    if let Some(note) = group_guard::startup_hint() {
        eprintln!("{note}");
    }
    let command_name: &'static str = match &cli.command {
        Some(Commands::Doctor(_)) => "doctor",
        Some(Commands::Ask(_)) => "ask",
        Some(Commands::Investigate(_)) => "investigate",
        Some(Commands::Continue(_)) => "continue",
        Some(Commands::Inspect(_)) => "inspect",
        Some(Commands::Verify(_)) => "verify",
        Some(Commands::Review(_)) => "review",
        None => "interactive",
    };
    group_guard::enter_command(command_name, cli::group_of(command_name));
    if agent_loop::agent_rust_enabled() {
        std::env::set_var(agent_serve::COMMAND_ENV, command_name);
    }

    let result = match cli.command {
        Some(Commands::Doctor(args)) => commands::doctor::run(args).await,
        Some(Commands::Ask(args)) => commands::ask::run(args).await,
        Some(Commands::Investigate(args)) => commands::investigate::run(args).await,
        Some(Commands::Continue(args)) => commands::continue_investigation::run(args).await,
        Some(Commands::Inspect(args)) => commands::inspect::run(args).await,
        Some(Commands::Verify(args)) => commands::verify::run(args).await,
        Some(Commands::Review(args)) => commands::review::run(args).await,
        None => interactive::run().await,
    };
    // A SIGTERM or SIGHUP that stopped a run: the command has written its failure record by now; die by that signal.
    pi::die_if_terminated();
    result
}
