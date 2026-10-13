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

    /// Send an ephemeral raw prompt to the agent: Pi over RPC, or the Rust agent with NEWSROOM_AGENT=rust.
    Ask(AskArgs),

    /// Start a persistent, tool-using data-news investigation.
    ///
    /// Exit codes: 0 = completed and VERIFIED; 1 = completed but NOT VERIFIED;
    /// 2 = error before any verdict (usage, I/O or provider failure). The final
    /// stderr line is `VERIFIED` or `NOT VERIFIED: <reason>`.
    Investigate(InvestigateArgs),

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

    /// Prompt sent to the agent.
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

/// The commands in the order the group help shows them. Only names: which group a command belongs to comes from the `commands` section of
/// `runtime/pi/groups.json` (compiled in, see `command_groups`), so the mapping has one source. A command that groups.json has and this list lacks (or
/// the other way round) fails a test. Bare `news` (the interactive launcher) is the agent group's starter; it has no subcommand of its own, so it is
/// not listed in help.
pub const COMMAND_ORDER: &[&str] = &[
    "ask",
    "investigate",
    "continue",
    "interactive",
    "verify",
    "doctor",
    "inspect",
];

const GROUPS_JSON: &str = include_str!("../runtime/pi/groups.json");

/// Which group each command belongs to, in `COMMAND_ORDER`, read from the compiled-in `commands` section of groups.json. A command without a
/// string `group` there is left out (and a test fails); the table is never changed at run time.
pub fn command_groups() -> &'static [(&'static str, String)] {
    static TABLE: std::sync::OnceLock<Vec<(&'static str, String)>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let json: serde_json::Value = serde_json::from_str(GROUPS_JSON).unwrap_or_default();
        COMMAND_ORDER
            .iter()
            .filter_map(|name| {
                let group = json["commands"][*name]["group"].as_str()?;
                Some((*name, group.to_string()))
            })
            .collect()
    })
}

/// Group names in help order. `visual` has no command yet.
pub const GROUPS: &[(&str, &str)] = &[
    (
        "agent",
        "Run the agent loop: ask, investigate, continue",
    ),
    ("knowledge", "Check evidence: verify"),
    (
        "visual",
        "Visual tools (they run inside the agent loop; no commands yet)",
    ),
    (
        "system",
        "Check the setup and the audit trail: doctor, inspect",
    ),
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
    std::env::var(GROUP_COMMANDS_SWITCH)
        .map(|v| v == "1")
        .unwrap_or(false)
}

pub fn group_of(command: &str) -> Option<&'static str> {
    command_groups()
        .iter()
        .find(|(c, _)| *c == command)
        .map(|(_, g)| g.as_str())
}

fn is_group(name: &str) -> bool {
    GROUPS.iter().any(|(g, _)| *g == name)
}

fn group_command(group: &str) -> clap::Command {
    let (name, about) = GROUPS
        .iter()
        .find(|(g, _)| *g == group)
        .copied()
        .unwrap_or(("", ""));
    let mut cmd = clap::Command::new(name)
        .about(about)
        .bin_name(format!("news {group}"))
        .disable_help_subcommand(true);
    let all = Cli::command();
    for (name, g) in command_groups() {
        if g == group {
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
    let Some(first) = first else {
        return Launch::Parse(args);
    };
    if wants_help(&first) || (first == "help" && args.len() == 2) {
        let mut cmd = with_groups();
        let _ = if first == "-h" {
            cmd.print_help()
        } else {
            cmd.print_long_help()
        };
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
            let _ = if s == "-h" {
                cmd.print_help()
            } else {
                cmd.print_long_help()
            };
            println!();
            Launch::Done(0)
        }
        Some(sub) => match group_of(sub) {
            Some(g) if g == first => {
                let mut rewritten = vec![args[0].clone()];
                rewritten.extend(args[2..].iter().cloned());
                Launch::Parse(rewritten)
            }
            Some(g) => usage_error(format!(
                "`{sub}` belongs to the `{g}` group: use `news {g} {sub}`"
            )),
            None => usage_error(format!(
                "unrecognized command `{sub}` in the `{first}` group; run `news {first} --help`"
            )),
        },
    }
}

#[cfg(test)]
mod group_table_tests {
    use super::*;

    /// The commands' groups as they were when the table was written out by hand in this file (before it was read from groups.json; `chat` left with K209).
    const BEFORE: &[(&str, &str)] = &[
        ("ask", "agent"),
        ("investigate", "agent"),
        ("continue", "agent"),
        ("interactive", "agent"),
        ("verify", "knowledge"),
        ("doctor", "system"),
        ("inspect", "system"),
    ];

    #[test]
    fn the_commands_have_the_same_groups_as_before_the_table_came_from_groups_json() {
        let now: Vec<(&str, &str)> = command_groups()
            .iter()
            .map(|(c, g)| (*c, g.as_str()))
            .collect();
        assert_eq!(now, BEFORE);
        for (command, group) in BEFORE {
            assert_eq!(group_of(command), Some(*group));
        }
        assert_eq!(group_of("nosuch"), None);
    }

    #[test]
    fn groups_json_and_the_help_order_list_the_same_commands_and_every_group_is_known() {
        let json: serde_json::Value = serde_json::from_str(GROUPS_JSON).unwrap();
        let mut in_json: Vec<&str> = json["commands"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        in_json.sort_unstable();
        let mut ordered = COMMAND_ORDER.to_vec();
        ordered.sort_unstable();
        assert_eq!(in_json, ordered);
        for (command, group) in command_groups() {
            assert!(is_group(group), "{command}: {group} is not a group");
        }
    }

    #[test]
    fn with_the_switch_off_the_arguments_come_back_unchanged() {
        if group_commands_enabled() {
            return;
        }
        for args in [
            vec!["news"],
            vec!["news", "agent", "ask", "x"],
            vec!["news", "--help"],
            vec!["news", "nosuch"],
        ] {
            let args: Vec<OsString> = args.into_iter().map(OsString::from).collect();
            match launch(args.clone()) {
                Launch::Parse(back) => assert_eq!(back, args),
                Launch::Done(_) => panic!("the switch is off: nothing is printed here"),
            }
        }
    }
}
