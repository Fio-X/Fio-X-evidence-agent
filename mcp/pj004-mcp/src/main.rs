//! pj004-mcp: a stdio MCP server in front of the `news` command.
//!
//! It is a client of the command line, like any user: it starts `news` as a child process and relays what that process printed. It
//! has no part in the news program, so it adds nothing to the group rules, and it decides nothing itself: `passed` comes only from
//! `news verify --json`, and a reply whose `passed` disagrees with the exit code is refused instead of relayed.
//!
//! One tool for now: `pj004_verify`. A run folder is named by `run_id`, a folder name under the run root given at start (`--runs`);
//! the tool takes no path, no key and no URL. Nothing is written but the `verification.json` that `news verify` itself writes.
use anyhow::{bail, Context, Result};
use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    schemars, tool, tool_router,
    transport::stdio,
    ErrorData as McpError, ServiceExt,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// One verification (integrity, and the SQL recompute when asked) is far shorter than this; past it the child is killed.
const VERIFY_LIMIT: Duration = Duration::from_secs(300);

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VerifyParams {
    /// Name of a run folder under the run root (a folder name only, no path).
    run_id: String,
    /// Also re-run the stored SQL computations with DuckDB (needs duckdb on this machine).
    #[serde(default)]
    recompute: bool,
}

#[derive(Clone)]
struct Pj004 {
    root: PathBuf,
    news: PathBuf,
}

#[tool_router(server_handler)]
impl Pj004 {
    #[tool(
        description = "Verify a stored run folder with `news verify --json` and return its result unchanged: passed, checks, errors, integrity, recompute. A run that did not verify is a result (passed=false), not a tool error. Offline; writes only that folder's verification.json."
    )]
    async fn pj004_verify(
        &self,
        Parameters(params): Parameters<VerifyParams>,
    ) -> Result<CallToolResult, McpError> {
        Ok(self.verify(&params).await)
    }
}

impl Pj004 {
    async fn verify(&self, params: &VerifyParams) -> CallToolResult {
        let dir = match run_dir(&self.root, &params.run_id) {
            Ok(dir) => dir,
            Err(message) => return tool_error(message),
        };
        let mut command = tokio::process::Command::new(&self.news);
        command.arg("verify").arg(&dir).arg("--json");
        if params.recompute {
            command.arg("--recompute");
        }
        command.kill_on_drop(true);
        let output = match tokio::time::timeout(VERIFY_LIMIT, command.output()).await {
            Err(_) => {
                return tool_error(format!(
                    "news verify did not finish within {} s and was stopped",
                    VERIFY_LIMIT.as_secs()
                ))
            }
            Ok(Err(error)) => return tool_error(format!("could not start news: {error}")),
            Ok(Ok(output)) => output,
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        match relay(
            output.status.code(),
            &stdout,
            &stderr,
            &self.root,
            &params.run_id,
        ) {
            Ok(value) => tool_result(value),
            Err(message) => tool_error(message),
        }
    }
}

fn tool_error(message: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

fn tool_result(value: Value) -> CallToolResult {
    let mut result = CallToolResult::structured(value.clone());
    if result.content.is_empty() {
        result.content = vec![ContentBlock::text(value.to_string())];
    }
    result
}

/// The folder a run_id names: a plain name directly under the run root, a real folder, not a link. Anything else is refused before
/// `news` is started.
fn run_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    let plain = !id.is_empty()
        && id.len() <= 200
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !plain {
        return Err("run_id must be the name of a run folder: letters, digits, '-', '_' and '.', no slash, not starting with '.'".to_string());
    }
    let path = root.join(id);
    let meta = std::fs::symlink_metadata(&path).map_err(|_| format!("no run folder named {id}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!("{id} is not a run folder"));
    }
    Ok(path)
}

/// What a finished `news verify --json` becomes. Exit 0 and 1 are verdicts (the JSON says which); anything else ended before a
/// verdict. `passed` is read from the JSON and must agree with the exit code. Only the report's path is rewritten, to a name under
/// the run root, so no absolute path leaves this process.
fn relay(
    code: Option<i32>,
    stdout: &str,
    stderr: &str,
    root: &Path,
    id: &str,
) -> Result<Value, String> {
    if !matches!(code, Some(0) | Some(1)) {
        let shown = code.map_or("a signal".to_string(), |code| format!("exit code {code}"));
        return Err(format!(
            "news verify ended with {shown} before a verdict: {}",
            last_line(stderr, root)
        ));
    }
    let mut value: Value = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("news verify --json printed no JSON ({error})"))?;
    let passed = value
        .get("passed")
        .and_then(Value::as_bool)
        .ok_or_else(|| "news verify --json printed no `passed` field".to_string())?;
    if passed != (code == Some(0)) {
        return Err(
            "news verify --json disagrees with its own exit code; nothing is relayed".to_string(),
        );
    }
    value["report"] = json!(format!("{id}/verification.json"));
    Ok(value)
}

/// The last non-empty stderr line, with the run root hidden and cut to 300 characters.
fn last_line(stderr: &str, root: &Path) -> String {
    let line = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let line = line.replace(&root.display().to_string(), "<runs>");
    line.chars().take(300).collect()
}

/// `--runs <folder>` (required) and `--news <program>` (default: $PJ004_NEWS_BIN, else `news` on PATH).
fn parse_args(args: Vec<String>) -> Result<(PathBuf, PathBuf)> {
    let (mut runs, mut news) = (None, None);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--runs" => runs = Some(PathBuf::from(args.next().context("--runs needs a folder")?)),
            "--news" => news = Some(PathBuf::from(args.next().context("--news needs a program")?)),
            other => bail!("unknown argument {other}; usage: pj004-mcp --runs <run root> [--news <news program>]"),
        }
    }
    let runs =
        runs.context("--runs <run root> is required: the folder that holds the run folders")?;
    let root = std::fs::canonicalize(&runs)
        .with_context(|| format!("run root {} is not readable", runs.display()))?;
    if !root.is_dir() {
        bail!("run root {} is not a folder", root.display());
    }
    let news = news
        .or_else(|| std::env::var_os("PJ004_NEWS_BIN").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("news"));
    Ok((root, news))
}

#[tokio::main]
async fn main() -> Result<()> {
    let (root, news) = parse_args(std::env::args().skip(1).collect())?;
    let service = Pj004 { root, news }
        .serve(stdio())
        .await
        .map_err(|error| anyhow::anyhow!("could not start the MCP server: {error}"))?;
    service.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_id_is_a_plain_folder_name_under_the_root() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("run-1")).unwrap();
        std::fs::write(temp.path().join("file"), "x").unwrap();
        std::os::unix::fs::symlink(temp.path().join("run-1"), temp.path().join("link")).unwrap();
        assert!(run_dir(temp.path(), "run-1").is_ok());
        for bad in [
            "", ".", "..", ".hidden", "a/b", "../run-1", "/etc", "run 1", "run-1\0", "file",
            "link", "absent",
        ] {
            assert!(run_dir(temp.path(), bad).is_err(), "{bad:?}");
        }
        assert!(run_dir(temp.path(), &"a".repeat(201)).is_err());
    }

    #[test]
    fn relay_takes_passed_from_the_json_and_checks_it_against_the_exit_code() {
        let root = Path::new("/runs");
        let ok = r#"{"passed":true,"checks":3,"errors":[],"report":"/runs/r/verification.json"}"#;
        let value = relay(Some(0), ok, "VERIFIED", root, "r").unwrap();
        assert_eq!(value["passed"], json!(true));
        assert_eq!(value["checks"], json!(3));
        assert_eq!(value["report"], json!("r/verification.json"));
        let bad = r#"{"passed":false,"checks":3,"errors":["x"]}"#;
        assert_eq!(
            relay(Some(1), bad, "", root, "r").unwrap()["errors"],
            json!(["x"])
        );
        assert!(
            relay(Some(1), ok, "", root, "r").is_err(),
            "passed=true with exit 1"
        );
        assert!(
            relay(Some(0), bad, "", root, "r").is_err(),
            "passed=false with exit 0"
        );
        assert!(relay(Some(0), "not json", "", root, "r").is_err());
        assert!(relay(Some(0), "[]", "", root, "r").is_err());
        assert!(relay(Some(0), r#"{"checks":1}"#, "", root, "r").is_err());
    }

    #[test]
    fn exit_two_and_signals_are_errors_that_do_not_show_the_run_root() {
        let root = Path::new("/home/someone/runs");
        let message = relay(
            Some(2),
            "",
            "x\nerror: no such folder /home/someone/runs/r\n\n",
            root,
            "r",
        )
        .unwrap_err();
        assert!(
            message.contains("exit code 2") && message.contains("<runs>/r"),
            "{message}"
        );
        assert!(!message.contains("someone"), "{message}");
        assert!(relay(None, "", "", root, "r")
            .unwrap_err()
            .contains("a signal"));
    }

    #[test]
    fn arguments_need_the_run_root() {
        let temp = tempfile::tempdir().unwrap();
        assert!(parse_args(vec![]).is_err());
        assert!(parse_args(vec!["--runs".into()]).is_err());
        assert!(parse_args(vec!["--other".into()]).is_err());
        assert!(parse_args(vec![
            "--runs".into(),
            temp.path().join("absent").display().to_string()
        ])
        .is_err());
        let (root, news) = parse_args(vec![
            "--runs".into(),
            temp.path().display().to_string(),
            "--news".into(),
            "/bin/true".into(),
        ])
        .unwrap();
        assert_eq!(root, std::fs::canonicalize(temp.path()).unwrap());
        assert_eq!(news, PathBuf::from("/bin/true"));
    }
}
