use clap::{Args, Parser, Subcommand};
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
    pub command: Commands,
}

#[derive(Debug, Subcommand)]
pub enum Commands {
    /// Check required and optional local dependencies.
    Doctor(DoctorArgs),

    /// Send an ephemeral raw prompt to Pi over RPC.
    Ask(AskArgs),

    /// Start a persistent, tool-using data-news investigation.
    Investigate(InvestigateArgs),

    /// Continue an existing investigation with full Pi session context.
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

    /// Agent-visible tool profile. Use investigate for the compact default surface; visual/publication/competition/full expose broader capabilities.
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
