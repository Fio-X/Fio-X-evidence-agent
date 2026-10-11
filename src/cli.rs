use clap::{Args, CommandFactory, Parser, Subcommand};
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "news",
    version,
    about = "Agentic data newsroom CLI",
    long_about = "A Rust control plane for a Pi-powered agentic data newsroom."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Check required and optional local dependencies.
    Doctor(DoctorArgs),

    /// Send an ephemeral raw prompt to Pi over RPC.
    Ask(AskArgs),

    /// Direct LLM chat (new agent mode, bypasses Pi RPC).
    Chat(ChatArgs),

    /// Start a persistent, tool-using data-news investigation.
    ///
    /// Exit codes: 0 = completed and VERIFIED; 1 = completed but NOT VERIFIED;
    /// 2 = error before any verdict (usage, I/O or provider failure). The final
    /// stderr line is `VERIFIED` or `NOT VERIFIED: <reason>`.
    Investigate(InvestigateArgs),

    /// New autonomous investigation (Phase 3, bypasses Pi).
    InvestigateV2(InvestigateV2Args),

    /// Continue an existing investigation with full Pi session context.
    ///
    /// Exit codes: 0 = completed and VERIFIED; 1 = completed but NOT VERIFIED;
    /// 2 = error before any verdict (usage, I/O or provider failure). The final
    /// stderr line is `VERIFIED` or `NOT VERIFIED: <reason>`.
    Continue(ContinueArgs),

    /// Summarize the observable agent/tool audit trail for an investigation.
    Inspect(InspectArgs),

    /// Verify evidence references, hashes, claims, computations, and visualization provenance.
    Verify(VerifyArgs),
}

#[derive(Debug, Clone, Args)]
pub struct PiArgs {
    /// Pi executable to spawn.
    #[arg(long, env = "NEWSROOM_PI_BIN", default_value = "pi")]
    pub pi_bin: PathBuf,

    /// Pi model provider. If omitted, Pi's configured default is used.
    #[arg(long, env = "NEWSROOM_PI_PROVIDER")]
    pub provider: Option<String>,

    /// Pi model ID or model pattern.
    #[arg(long, env = "NEWSROOM_PI_MODEL")]
    pub model: Option<String>,

    /// Pi reasoning level, for models that support it.
    #[arg(long, env = "NEWSROOM_PI_THINKING")]
    pub thinking: Option<String>,

    /// Trust project-local Pi resources for this run. Newsroom's bundled extension is loaded explicitly regardless.
    #[arg(long, default_value_t = false)]
    pub approve_project: bool,

    /// Agent-visible tool profile. Use investigate for the compact default surface; visual-story exposes the direct rich publication surface, while visual/publication/competition/full expose broader capabilities.
    #[arg(long, env = "NEWSROOM_TOOL_PROFILE", default_value = "investigate")]
    pub tool_profile: String,
}

#[derive(Debug, Args)]
pub struct DoctorArgs {
    #[command(flatten)]
    pub pi: PiArgs,

    /// Emit a machine-readable readiness report.
    #[arg(long, default_value_t = false)]
    pub json: bool,

    /// Fail unless the pinned live-qualification runtime is available.
    #[arg(long, default_value_t = false)]
    pub strict: bool,
}

#[derive(Debug, Args)]
pub struct AskArgs {
    #[command(flatten)]
    pub pi: PiArgs,

    /// Prompt sent to Pi.
    #[arg(required = true, num_args = 1..)]
    pub prompt: Vec<String>,
}

#[derive(Debug, Args)]
pub struct ChatArgs {
    /// LLM provider (anthropic, dragoncode, or openai).
    #[arg(long, env = "NEWSROOM_PROVIDER", default_value = "anthropic")]
    pub provider: String,

    /// Model to use.
    #[arg(long, env = "NEWSROOM_MODEL", default_value = "claude-sonnet-4-6")]
    pub model: String,

    /// API key (falls back to the provider's key env var; DragonCode also accepts OPENAI_API_KEY).
    #[arg(long, env = "NEWSROOM_API_KEY")]
    pub api_key: Option<String>,

    /// Custom base URL for API (e.g., https://dragoncode.codes).
    #[arg(long, env = "NEWSROOM_BASE_URL")]
    pub base_url: Option<String>,

    /// Prompt to send.
    #[arg(required = true, num_args = 1..)]
    pub prompt: Vec<String>,
}

#[derive(Debug, Args)]
pub struct InvestigateV2Args {
    /// LLM provider (anthropic, dragoncode, or openai).
    #[arg(long, env = "NEWSROOM_PROVIDER", default_value = "anthropic")]
    pub provider: String,

    /// Model to use.
    #[arg(long, env = "NEWSROOM_MODEL", default_value = "claude-sonnet-4-6")]
    pub model: String,

    /// API key (falls back to the provider's key env var; DragonCode also accepts OPENAI_API_KEY).
    #[arg(long, env = "NEWSROOM_API_KEY")]
    pub api_key: Option<String>,

    /// Custom base URL for API (e.g., https://dragoncode.codes).
    #[arg(long, env = "NEWSROOM_BASE_URL")]
    pub base_url: Option<String>,

    /// Investigation topic or goal.
    #[arg(required = true, num_args = 1..)]
    pub topic: Vec<String>,

    /// Directory below which this ephemeral run writes its report and generated visuals.
    /// Relative paths are resolved from the directory where `news` was started.
    #[arg(
        long,
        env = "NEWSROOM_OUTPUT_DIR",
        default_value = ".newsroom/artifacts"
    )]
    pub out: PathBuf,

    /// Ask for an interactive confirmation before creating the output directory.
    #[arg(long, default_value_t = false)]
    pub confirm_output: bool,
}

#[derive(Debug, Args)]
pub struct InvestigateArgs {
    #[command(flatten)]
    pub pi: PiArgs,

    /// Topic, question, company, event, or dataset to investigate.
    #[arg(required = true, num_args = 1..)]
    pub topic: Vec<String>,

    /// Directory where investigation bundles are stored.
    #[arg(
        long,
        env = "NEWSROOM_ARTIFACTS_DIR",
        default_value = ".newsroom/artifacts"
    )]
    pub out: PathBuf,

    /// Ask for an interactive confirmation before creating the output directory.
    #[arg(long, default_value_t = false)]
    pub confirm_output: bool,

    /// Seed a local CSV, JSON, JSONL, TSV, or Parquet file into the investigation. Repeat for multiple files.
    #[arg(long = "data", value_name = "FILE")]
    pub data: Vec<PathBuf>,

    /// Print the generated newsroom prompt without invoking Pi.
    #[arg(long, default_value_t = false)]
    pub dry_run: bool,
}

#[derive(Debug, Args)]
pub struct ContinueArgs {
    #[command(flatten)]
    pub pi: PiArgs,

    /// Existing investigation directory containing story.json and session/.
    pub artifact: PathBuf,

    /// Follow-up instruction. Pi resumes the same persisted conversation.
    #[arg(required = true, num_args = 1..)]
    pub message: Vec<String>,
}

#[derive(Debug, Args)]
pub struct InspectArgs {
    /// Existing investigation directory.
    pub artifact: PathBuf,
}

#[derive(Debug, Args)]
pub struct VerifyArgs {
    /// Existing investigation directory.
    pub artifact: PathBuf,

    /// Re-run every stored SQL computation with DuckDB and compare canonical rows.
    #[arg(long, default_value_t = false)]
    pub recompute: bool,

    /// DuckDB executable used for --recompute.
    #[arg(long, env = "NEWSROOM_DUCKDB_BIN", default_value = "duckdb")]
    pub duckdb_bin: PathBuf,

    /// Per-query recomputation timeout in seconds.
    #[arg(long, default_value_t = 30)]
    pub recompute_timeout: u64,
}

/// Which group each command belongs to. Kept equal to the `commands` section of
/// `runtime/pi/groups.json` (a test checks it). Order is the order shown in help.
pub const COMMAND_GROUPS: &[(&str, &str)] = &[
    ("ask", "agent"),
    ("chat", "agent"),
    ("investigate", "agent"),
    ("investigate-v2", "agent"),
    ("continue", "agent"),
    ("verify", "knowledge"),
    ("doctor", "system"),
    ("inspect", "system"),
];

/// Group names in help order. `visual` has no command yet.
pub const GROUPS: &[(&str, &str)] = &[
    ("agent", "Run the agent loop: ask, chat, investigate, investigate-v2, continue"),
    ("knowledge", "Check evidence: verify"),
    ("visual", "Visual tools (they run inside the agent loop; no commands yet)"),
    ("system", "Check the setup and the audit trail: doctor, inspect"),
];

/// Environment switch for the group commands. Only the exact value "1" turns it on.
pub const GROUP_COMMANDS_SWITCH: &str = "NEWSROOM_GROUP_COMMANDS";

/// What to do with the process arguments once the group commands are considered.
pub enum Launch {
    /// Parse these arguments as usual.
    Parse(Vec<OsString>),
    /// Output was already written; exit with this code.
    Done(i32),
}

pub fn group_commands_enabled() -> bool {
    std::env::var(GROUP_COMMANDS_SWITCH).map(|v| v == "1").unwrap_or(false)
}

pub fn group_of(command: &str) -> Option<&'static str> {
    COMMAND_GROUPS.iter().find(|(c, _)| *c == command).map(|(_, g)| *g)
}

fn is_group(name: &str) -> bool {
    GROUPS.iter().any(|(g, _)| *g == name)
}

fn group_command(group: &str) -> clap::Command {
    let (name, about) = GROUPS.iter().find(|(g, _)| *g == group).copied().unwrap_or(("", ""));
    let mut cmd = clap::Command::new(name)
        .about(about)
        .bin_name(format!("news {group}"))
        .disable_help_subcommand(true);
    let all = Cli::command();
    for (name, g) in COMMAND_GROUPS {
        if *g == group {
            if let Some(sub) = all.find_subcommand(name) {
                cmd = cmd.subcommand(sub.clone());
            }
        }
    }
    cmd
}

fn with_groups() -> clap::Command {
    let mut cmd = Cli::command();
    for (g, about) in GROUPS {
        cmd = cmd.subcommand(clap::Command::new(*g).about(*about));
    }
    cmd
}

fn wants_help(arg: &str) -> bool {
    matches!(arg, "-h" | "--help")
}

/// With the switch off this returns the arguments untouched. With it on, `news <group> <command> ...`
/// is rewritten to `news <command> ...`, and the group help and top-level help list the groups.
pub fn launch(args: Vec<OsString>) -> Launch {
    if !group_commands_enabled() {
        return Launch::Parse(args);
    }
    let first = args.get(1).and_then(|a| a.to_str()).map(str::to_string);
    let Some(first) = first else { return Launch::Parse(args) };
    if wants_help(&first) || (first == "help" && args.len() == 2) {
        let mut cmd = with_groups();
        let _ = if first == "-h" { cmd.print_help() } else { cmd.print_long_help() };
        println!();
        return Launch::Done(0);
    }
    if !is_group(&first) {
        return Launch::Parse(args);
    }
    let second = args.get(2).and_then(|a| a.to_str()).map(str::to_string);
    if first == "visual" {
        println!("news visual: the visual tools run inside the agent loop (`news agent ...`). This group has no command-line commands yet.");
        return Launch::Done(0);
    }
    let usage_error = |message: String| -> Launch {
        let mut cmd = Cli::command();
        let err = cmd.error(clap::error::ErrorKind::InvalidSubcommand, message);
        let _ = err.print();
        Launch::Done(err.exit_code())
    };
    match second.as_deref() {
        None => {
            let mut cmd = group_command(&first);
            let _ = cmd.print_help();
            println!();
            Launch::Done(0)
        }
        Some(s) if wants_help(s) => {
            let mut cmd = group_command(&first);
            let _ = if s == "-h" { cmd.print_help() } else { cmd.print_long_help() };
            println!();
            Launch::Done(0)
        }
        Some(sub) => match group_of(sub) {
            Some(g) if g == first => {
                let mut rewritten = vec![args[0].clone()];
                rewritten.extend(args[2..].iter().cloned());
                Launch::Parse(rewritten)
            }
            Some(g) => usage_error(format!("`{sub}` belongs to the `{g}` group: use `news {g} {sub}`")),
            None => usage_error(format!("unrecognized command `{sub}` in the `{first}` group; run `news {first} --help`")),
        },
    }
}
