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

    // Pi is only a fallback runtime now (NEWSROOM_AGENT=pi): checked, and required, only when it is the one selected.
    let pi_runtime = pi_selected(env::var("NEWSROOM_AGENT").ok().as_deref());
    let pi = if pi_runtime {
        Some(exact_check("pi", "0.85.1", &args.pi.pi_bin, &["--version"], EXPECTED_PI).await)
    } else {
        None
    };
    let duckdb = exact_check(
        "duckdb",
        "1.5.5",
        &duckdb_bin,
        &["--version"],
        EXPECTED_DUCKDB,
    )
    .await;
    let node = node_check().await;
    let rustc = exact_check(
        "rustc",
        "1.98.1",
        Path::new("rustc"),
        &["--version"],
        EXPECTED_RUST,
    )
    .await;
    let python =
        availability_check("python3", "optional", Path::new("python3"), &["--version"]).await;

    let pi_ok = pi.as_ref().map(|check| check.ok);
    let checks: Vec<Check> = pi
        .into_iter()
        .chain([duckdb, node, rustc, python])
        .collect();
    let live_ready = checks
        .iter()
        .filter(|check| check.requirement != "optional")
        .all(|check| check.ok);
    let report = DoctorReport {
        schema_version: "0.7.0",
        live_ready,
        checks,
    };

    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for check in &report.checks {
            let value = check
                .version
                .as_deref()
                .or(check.error.as_deref())
                .unwrap_or("unknown");
            println!(
                "{:<10} {:<12} {:<5} {}",
                check.name,
                check.requirement,
                if check.ok { "PASS" } else { "FAIL" },
                value
            );
        }
        if pi_runtime {
            println!(
                "baseline   v1.1.0       Rust 1.98.1 | Node >=22.19.0 | Pi 0.85.1 | DuckDB 1.5.5"
            );
        } else {
            println!("baseline   v1.1.0       Rust 1.98.1 | Node >=22.19.0 | DuckDB 1.5.5 (agent: built-in Rust)");
        }
        println!("live ready {}", if live_ready { "yes" } else { "no" });
    }

    if args.strict && !live_ready {
        bail!("live qualification environment is incomplete; run scripts/bootstrap_live_env.sh or fix the failed checks");
    }
    if pi_ok == Some(false) && !args.strict {
        eprintln!("\n❌ Pi 未安装或配置错误");
        eprintln!("\n📦 安装方法:");
        eprintln!("   npm install -g @earendil-works/pi-coding-agent@0.85.1");
        eprintln!("\n🚀 或运行自动安装脚本:");
        eprintln!("   ./scripts/setup.sh");
        eprintln!();
        eprintln!("   或去掉 NEWSROOM_AGENT=pi，改用内置的 Rust agent（默认）");
        eprintln!();
        bail!("Pi is required with NEWSROOM_AGENT=pi. Install/configure Pi, pass --pi-bin <path>, or unset NEWSROOM_AGENT to use the built-in Rust agent");
    }

    // 提供友好的安装建议（如果有失败的检查）
    if !args.json && !live_ready {
        eprintln!("\n💡 提示: 运行自动安装脚本配置所有依赖:");
        eprintln!("   ./scripts/setup.sh\n");
    }

    Ok(())
}

async fn exact_check(
    name: &'static str,
    requirement: &'static str,
    bin: &Path,
    args: &[&str],
    expected: &str,
) -> Check {
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

async fn availability_check(
    name: &'static str,
    requirement: &'static str,
    bin: &Path,
    args: &[&str],
) -> Check {
    match check(bin, args).await {
        Ok(version) => Check {
            name,
            requirement,
            ok: true,
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

async fn node_check() -> Check {
    match check(Path::new("node"), &["--version"]).await {
        Ok(version) => {
            let ok = parse_version(&version)
                .map(|value| value >= MIN_NODE)
                .unwrap_or(false);
            Check {
                name: "node",
                requirement: ">=22.19.0",
                ok,
                version: Some(version),
                error: None,
            }
        }
        Err(error) => Check {
            name: "node",
            requirement: ">=22.19.0",
            ok: false,
            version: None,
            error: Some(error),
        },
    }
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let token = text
        .trim()
        .trim_start_matches('v')
        .split_whitespace()
        .next()?;
    let mut parts = token.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

async fn check(bin: &Path, args: &[&str]) -> std::result::Result<String, String> {
    let mut command = Command::new(bin);
    strip_keylike_env(command.as_std_mut());
    match command.args(args).output().await {
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

/// This group's own copy of the key-name rule in tool_host.rs (`is_keylike`): the cross-group rule lets no group call another group's
/// function, so each group that starts children keeps a copy; a tool_host test holds every copy equal to the original. Names only.
pub(crate) fn keylike_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["_API_KEY", "_BASE_URL", "_TOKEN", "_SECRET", "PASSWORD"]
        .iter()
        .any(|suffix| upper.ends_with(suffix))
        || upper.split('_').any(|part| {
            part == "KEY"
                || ["SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL"]
                    .iter()
                    .any(|word| part.contains(word))
                || ["APIKEY", "ACCESSKEY", "PRIVATEKEY", "SECRETKEY"]
                    .iter()
                    .any(|compound| part.ends_with(compound))
        })
}

/// Drops every key-like name of this process's environment from a child that otherwise inherits it (see `keylike_env_name`).
pub(crate) fn strip_keylike_env(cmd: &mut std::process::Command) {
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_none_or(keylike_env_name) {
            cmd.env_remove(&name);
        }
    }
}

/// This group's own reading of the runtime switch (agent_loop.rs `rust_selected`, which the cross-group rule keeps out of reach): only
/// the exact value "pi" selects the old Pi runtime. An agent_loop test holds the two equal.
pub(crate) fn pi_selected(value: Option<&str>) -> bool {
    value == Some("pi")
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
