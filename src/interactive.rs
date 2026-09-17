use crate::artifact::InvestigationBundle;
use crate::cli::{ContinueArgs, InvestigateArgs, PiArgs};
use crate::commands::{continue_investigation, investigate};
use crate::output;
use anyhow::{bail, Context, Result};
use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;

const DEFAULT_ARTIFACT_ROOT: &str = ".newsroom/artifacts";

/// Start the conversational newsroom when the user invokes `news` without a
/// subcommand. This is intentionally a terminal-only entry point: scripts
/// should keep using an explicit subcommand so they never block on stdin.
pub async fn run() -> Result<()> {
    if !io::stdin().is_terminal() {
        bail!(
            "news without a subcommand needs an interactive terminal; use `news investigate ...` for scripts"
        );
    }

    let output_root = output::resolve_output_dir(&artifact_root())?;
    eprintln!(
        "[interactive] output_root={} (use :path to print the active artifact)",
        output_root.display()
    );
    println!("Fio-X data newsroom");
    println!(
        "直接输入你要调查的主题；后续继续输入即可修改、追问或要求新的图表。输入 :help 查看命令。\n"
    );

    let topic = loop {
        let Some(input) = read_line("news> ")? else {
            println!();
            return Ok(());
        };
        if input.is_empty() {
            continue;
        }
        if is_exit_command(&input) {
            return Ok(());
        }
        match input.as_str() {
            ":help" => {
                print_help();
                continue;
            }
            ":path" => {
                println!("当前还没有 artifact；先输入调查主题。\n");
                continue;
            }
            ":new" => {
                println!("这是首个调查；直接输入主题即可。\n");
                continue;
            }
            _ => break input,
        }
    };

    let mut artifact = match start_investigation(&topic).await {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[interactive] investigation failed: {error:#}");
            return Err(error);
        }
    };

    loop {
        let Some(input) = read_line("news> ")? else {
            println!();
            break;
        };
        if input.is_empty() {
            continue;
        }
        if is_exit_command(&input) {
            break;
        }
        if input == ":help" {
            print_help();
            continue;
        }
        if input == ":path" {
            println!("当前 artifact: {}", artifact.display());
            continue;
        }
        if input == ":new" {
            let Some(new_topic) = read_line("new topic> ")? else {
                println!();
                break;
            };
            if new_topic.is_empty() || is_exit_command(&new_topic) {
                continue;
            }
            match start_investigation(&new_topic).await {
                Ok(path) => artifact = path,
                Err(error) => eprintln!("[interactive] new investigation failed: {error:#}"),
            }
            continue;
        }

        import_follow_up_data(&artifact, &input)?;
        let args = ContinueArgs {
            pi: default_pi_args(),
            artifact: artifact.clone(),
            message: vec![input],
        };
        if let Err(error) = continue_investigation::run(args).await {
            eprintln!("[interactive] follow-up failed: {error:#}");
        }
    }

    eprintln!(
        "[interactive] session ended; artifact={}",
        artifact.display()
    );
    Ok(())
}

async fn start_investigation(topic: &str) -> Result<PathBuf> {
    investigate::run_with_artifact(InvestigateArgs {
        pi: default_pi_args(),
        topic: vec![topic.to_owned()],
        out: artifact_root(),
        confirm_output: false,
        data: discover_data_files(topic),
        dry_run: false,
    })
    .await
}

fn artifact_root() -> PathBuf {
    env::var_os("NEWSROOM_ARTIFACTS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_ARTIFACT_ROOT))
}

fn default_pi_args() -> PiArgs {
    PiArgs {
        pi_bin: env::var_os("NEWSROOM_PI_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("pi")),
        provider: Some(
            env::var("NEWSROOM_PI_PROVIDER").unwrap_or_else(|_| "dragoncode".to_string()),
        ),
        model: Some(
            env::var("NEWSROOM_PI_MODEL").unwrap_or_else(|_| "claude-sonnet-4-6".to_string()),
        ),
        thinking: env::var("NEWSROOM_PI_THINKING").ok(),
        approve_project: false,
        tool_profile: env::var("NEWSROOM_TOOL_PROFILE").unwrap_or_else(|_| "visual".to_string()),
    }
}

fn import_follow_up_data(artifact: &std::path::Path, message: &str) -> Result<()> {
    let files = discover_data_files(message);
    if files.is_empty() {
        return Ok(());
    }
    let bundle = InvestigationBundle::open(artifact)?;
    for file in files {
        let reference = bundle.import_data(&file)?;
        eprintln!("[interactive] imported data={reference}");
    }
    Ok(())
}

fn discover_data_files(text: &str) -> Vec<PathBuf> {
    text.split_whitespace()
        .map(|part| {
            part.trim_matches(|character: char| {
                matches!(
                    character,
                    '"' | '\'' | ',' | '，' | '。' | '、' | ':' | '：' | '(' | ')' | '（' | '）'
                )
            })
            .to_owned()
        })
        .filter(|part| !part.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .filter(|path| {
            matches!(
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str(),
                "csv" | "json" | "jsonl" | "ndjson" | "tsv" | "parquet"
            )
        })
        .collect()
}

fn read_line(prompt: &str) -> Result<Option<String>> {
    print!("{prompt}");
    io::stdout()
        .flush()
        .context("failed to flush interactive prompt")?;
    let mut input = String::new();
    let bytes = io::stdin()
        .read_line(&mut input)
        .context("failed to read interactive input")?;
    if bytes == 0 {
        return Ok(None);
    }
    Ok(Some(input.trim().to_owned()))
}

fn is_exit_command(input: &str) -> bool {
    matches!(
        input.to_ascii_lowercase().as_str(),
        ":q" | ":quit" | "quit" | "exit"
    )
}

fn print_help() {
    println!(
        "命令：\n  :help   显示帮助\n  :path   显示当前 artifact 路径\n  :new    开始新的调查\n  :quit   退出并保留全部产物\n\n把 CSV/JSON/TSV/Parquet 路径直接写进主题或追问中，CLI 会自动导入。"
    );
}
