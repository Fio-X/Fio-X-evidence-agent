use crate::cli::DoctorArgs;
use anyhow::{bail, Result};
use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};
use tokio::process::Command;

const EXPECTED_PI: &str = "0.85.1";
const EXPECTED_DUCKDB: &str = "1.5.5";
const EXPECTED_RUST: &str = "1.98.1";
const MIN_NODE: (u64, u64, u64) = (22, 19, 0);

#[derive(Debug, Serialize)]
struct Check {
    name: &'static str,
    requirement: &'static str,
    ok: bool,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct DoctorReport {
    schema_version: &'static str,
    live_ready: bool,
    checks: Vec<Check>,
}

pub async fn run(args: DoctorArgs) -> Result<()> {
    let duckdb_bin = env::var_os("NEWSROOM_DUCKDB_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("duckdb"));

    let pi = exact_check("pi", "0.85.1", &args.pi.pi_bin, &["--version"], EXPECTED_PI).await;
    let duckdb = exact_check("duckdb", "1.5.5", &duckdb_bin, &["--version"], EXPECTED_DUCKDB).await;
    let node = node_check().await;
    let rustc = exact_check("rustc", "1.98.1", Path::new("rustc"), &["--version"], EXPECTED_RUST).await;
    let python = availability_check("python3", "optional", Path::new("python3"), &["--version"]).await;

    let checks = vec![pi, duckdb, node, rustc, python];
    let live_ready = checks.iter().filter(|check| check.requirement != "optional").all(|check| check.ok);
    let report = DoctorReport {
        schema_version: "0.7.0",
        live_ready,
        checks,
    };

    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for check in &report.checks {
            let value = check.version.as_deref().or(check.error.as_deref()).unwrap_or("unknown");
            println!("{:<10} {:<12} {:<5} {}", check.name, check.requirement, if check.ok { "PASS" } else { "FAIL" }, value);
        }
        println!("baseline   v1.1.0       Rust 1.98.1 | Node >=22.19.0 | Pi 0.85.1 | DuckDB 1.5.5");
        println!("live ready {}", if live_ready { "yes" } else { "no" });
    }

    if args.strict && !live_ready {
        bail!("live qualification environment is incomplete; run scripts/bootstrap_live_env.sh or fix the failed checks");
    }
    if report.checks.first().map(|check| check.ok) != Some(true) && !args.strict {
        bail!("Pi is required. Install/configure Pi or pass --pi-bin <path>");
    }
    Ok(())
}

async fn exact_check(name: &'static str, requirement: &'static str, bin: &Path, args: &[&str], expected: &str) -> Check {
    match check(bin, args).await {
        Ok(version) => Check {
            name,
            requirement,
            ok: version.contains(expected),
            version: Some(version),
            error: None,
        },
        Err(error) => Check {
            name,
            requirement,
            ok: false,
            version: None,
            error: Some(error),
        },
    }
}

async fn availability_check(name: &'static str, requirement: &'static str, bin: &Path, args: &[&str]) -> Check {
    match check(bin, args).await {
        Ok(version) => Check { name, requirement, ok: true, version: Some(version), error: None },
        Err(error) => Check { name, requirement, ok: false, version: None, error: Some(error) },
    }
}

async fn node_check() -> Check {
    match check(Path::new("node"), &["--version"]).await {
        Ok(version) => {
            let ok = parse_version(&version).map(|value| value >= MIN_NODE).unwrap_or(false);
            Check { name: "node", requirement: ">=22.19.0", ok, version: Some(version), error: None }
        }
        Err(error) => Check { name: "node", requirement: ">=22.19.0", ok: false, version: None, error: Some(error) },
    }
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let token = text.trim().trim_start_matches('v').split_whitespace().next()?;
    let mut parts = token.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

async fn check(bin: &Path, args: &[&str]) -> std::result::Result<String, String> {
    match Command::new(bin).args(args).output().await {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            let value = if stdout.is_empty() { stderr } else { stdout };
            Ok(value.lines().next().unwrap_or("ok").to_owned())
        }
        Ok(output) => Err(format!("exit {}", output.status)),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_node_versions() {
        assert_eq!(parse_version("v22.19.0"), Some((22, 19, 0)));
        assert_eq!(parse_version("22.20.1"), Some((22, 20, 1)));
        assert!(parse_version("v22.18.9").unwrap() < MIN_NODE);
    }
}
