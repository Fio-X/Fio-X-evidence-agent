use crate::artifact::InvestigationBundle;
use crate::cli::{ContinueArgs, InvestigateArgs, PiArgs};
use crate::commands::{continue_investigation, investigate};
use crate::output;
use anyhow::{bail, Context, Result};
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;
use std::env;
use std::io::{self, IsTerminal};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const DEFAULT_ARTIFACT_ROOT: &str = ".newsroom/artifacts";
/// Opt-in (exactly "1"): the conversation picks its tool profile the way `news investigate` does (complex infographic topics go to
/// `visual-story`, follow-ups keep the profile the first round recorded), and `:story` / `:quick` force the next topic's profile.
const INTERACTIVE_STORY_ENV: &str = "NEWSROOM_INTERACTIVE_STORY";

fn story_switch_enabled() -> bool {
    env::var(INTERACTIVE_STORY_ENV).is_ok_and(|v| v == "1")
}

/// What the next topic's profile is forced to (`:story`, `:quick`), or left to the topic itself.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
enum Force {
    #[default]
    Auto,
    Story,
    Quick,
}

/// The tool profile handed to a run. Switch off: the old rule (`NEWSROOM_TOOL_PROFILE`, else `visual`). Switch on: a forced mode wins; else
/// an explicit `NEWSROOM_TOOL_PROFILE`; else `investigate`, which the run turns into `visual-story` / `visual` / `investigate` by the topic.
fn profile_arg(switch_on: bool, force: Force, env_profile: Option<&str>) -> String {
    if !switch_on {
        return env_profile.unwrap_or("visual").to_string();
    }
    match force {
        Force::Story => "visual-story".to_string(),
        Force::Quick => "visual".to_string(),
        Force::Auto => env_profile.unwrap_or("investigate").to_string(),
    }
}

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

    let mut force = Force::Auto;
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
            ":story" | ":quick" if story_switch_enabled() => {
                force = force_from(&input);
                println!("{}\n", force_notice(force));
                continue;
            }
            _ => break input,
        }
    };

    let mut artifact = match start_investigation(&topic, std::mem::take(&mut force)).await {
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
            if story_switch_enabled() {
                let profile = crate::artifact::InvestigationBundle::open(&artifact)
                    .ok()
                    .and_then(|bundle| bundle.recorded_tool_profile())
                    .unwrap_or_else(|| "未记录".to_string());
                println!("当前档: {profile}（下一个 :new 主题: {}）", force_label(force));
            }
            continue;
        }
        if story_switch_enabled() && (input == ":story" || input == ":quick") {
            force = force_from(&input);
            println!("{}", force_notice(force));
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
            match start_investigation(&new_topic, std::mem::take(&mut force)).await {
                Ok(path) => artifact = path,
                Err(error) => eprintln!("[interactive] new investigation failed: {error:#}"),
            }
            continue;
        }

        import_follow_up_data(&artifact, &input)?;
        let args = ContinueArgs {
            pi: default_pi_args(Force::Auto),
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

fn force_from(command: &str) -> Force {
    if command == ":story" {
        Force::Story
    } else {
        Force::Quick
    }
}

fn force_label(force: Force) -> &'static str {
    match force {
        Force::Auto => "按主题自动选",
        Force::Story => "长图档 visual-story",
        Force::Quick => "普通档 visual",
    }
}

fn force_notice(force: Force) -> String {
    format!("下一个主题将走：{}（跟进的追问沿用该主题记下的档）", force_label(force))
}

async fn start_investigation(topic: &str, force: Force) -> Result<PathBuf> {
    investigate::run_with_artifact(InvestigateArgs {
        pi: default_pi_args(force),
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

fn default_pi_args(force: Force) -> PiArgs {
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
        tool_profile: profile_arg(
            story_switch_enabled(),
            force,
            env::var("NEWSROOM_TOOL_PROFILE").ok().as_deref(),
        ),
    }
}

fn import_follow_up_data(artifact: &std::path::Path, message: &str) -> Result<()> {
    let files = discover_data_files(message);
    if files.is_empty() {
        return Ok(());
    }
    let mut bundle = InvestigationBundle::open(artifact)?;
    for file in files {
        let reference = bundle.import_data(&file)?;
        eprintln!("[interactive] imported data={reference}");
    }
    // NEWSROOM_LOCAL_SOURCE_NOTE=1 only: a refused note is reported and kept in the manifest (reasons only). Otherwise nothing changes.
    if !bundle.source_note_warnings.is_empty() {
        for warning in &bundle.source_note_warnings {
            eprintln!("[interactive] source note: {warning}");
        }
        bundle.persist_source_note_warnings()?;
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

/// One in-memory line editor for the whole session. rustyline handles multi-byte,
/// double-width input (IME-committed Chinese) that the terminal's cooked mode cannot
/// delete cleanly. History stays in memory only: topics can be private, and the
/// crate's file-history feature is disabled in Cargo.toml.
fn line_editor() -> Result<&'static Mutex<DefaultEditor>> {
    static EDITOR: OnceLock<Mutex<DefaultEditor>> = OnceLock::new();
    if let Some(editor) = EDITOR.get() {
        return Ok(editor);
    }
    let editor = DefaultEditor::new().context("failed to start the interactive line editor")?;
    Ok(EDITOR.get_or_init(|| Mutex::new(editor)))
}

fn read_line(prompt: &str) -> Result<Option<String>> {
    let mut editor = line_editor()?
        .lock()
        .map_err(|_| anyhow::anyhow!("interactive line editor lock poisoned"))?;
    match editor.readline(prompt) {
        Ok(line) => {
            let line = line.trim().to_owned();
            if !line.is_empty() {
                let _ = editor.add_history_entry(line.as_str());
            }
            Ok(Some(line))
        }
        // Ctrl-D on an empty line and Ctrl-C both end the session cleanly.
        Err(ReadlineError::Eof | ReadlineError::Interrupted) => Ok(None),
        Err(error) => Err(error).context("failed to read interactive input"),
    }
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
    if story_switch_enabled() {
        println!(
            "\n工具档（NEWSROOM_INTERACTIVE_STORY=1）：\n  默认     按主题自动选：复杂信息图走长图档 visual-story，追问沿用首轮记下的档\n  :story   下一个主题强制走长图档 visual-story\n  :quick   下一个主题强制走普通档 visual\n  :path 会同时显示当前档"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_profile_is_the_old_rule_when_the_switch_is_off() {
        for force in [Force::Auto, Force::Story, Force::Quick] {
            assert_eq!(profile_arg(false, force, None), "visual");
            assert_eq!(profile_arg(false, force, Some("full")), "full");
        }
    }

    #[test]
    fn with_the_switch_on_the_topic_picks_unless_forced() {
        assert_eq!(profile_arg(true, Force::Auto, None), "investigate");
        assert_eq!(profile_arg(true, Force::Auto, Some("full")), "full");
        assert_eq!(profile_arg(true, Force::Story, Some("full")), "visual-story");
        assert_eq!(profile_arg(true, Force::Quick, None), "visual");
        assert_eq!(force_from(":story"), Force::Story);
        assert_eq!(force_from(":quick"), Force::Quick);
    }

    #[test]
    fn the_switch_is_exactly_one() {
        let _guard = crate::pi::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let before = env::var(INTERACTIVE_STORY_ENV).ok();
        for (value, expected) in [("1", true), ("true", false), ("0", false), ("", false)] {
            env::set_var(INTERACTIVE_STORY_ENV, value);
            assert_eq!(story_switch_enabled(), expected, "{value:?}");
        }
        env::remove_var(INTERACTIVE_STORY_ENV);
        assert!(!story_switch_enabled());
        if let Some(v) = before {
            env::set_var(INTERACTIVE_STORY_ENV, v);
        }
    }
}
