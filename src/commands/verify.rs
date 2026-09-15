use crate::cli::VerifyArgs;
use crate::verify::{recompute_artifact, verify_artifact};
use anyhow::{bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::json;
use std::fs;

pub async fn run(args: VerifyArgs) -> Result<()> {
    let report = verify_artifact(&args.artifact)?;
    let replay = if args.recompute && report.passed {
        Some(recompute_artifact(&args.artifact, &args.duckdb_bin, args.recompute_timeout).await?)
    } else {
        None
    };
    let passed = report.passed && replay.as_ref().map(|value| value.passed).unwrap_or(true);
    let total_checks = report.checks + replay.as_ref().map(|value| value.checks).unwrap_or(0);
    let output = json!({
        "schema_version": "0.7.0",
        "verified_at": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        "passed": passed,
        "checks": total_checks,
        "integrity": {
            "passed": report.passed,
            "checks": report.checks,
            "errors": &report.errors,
            "warnings": &report.warnings,
        },
        "recompute": replay.as_ref().map(|value| json!({
            "passed": value.passed,
            "checks": value.checks,
            "errors": value.errors,
            "duration_ms": value.duration_ms,
            "duckdb_bin": args.duckdb_bin,
        })),
    });
    let path = args.artifact.join("verification.json");
    fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&output)?))
        .with_context(|| format!("failed to write {}", path.display()))?;

    println!("artifact integrity: {}", if report.passed { "PASS" } else { "FAIL" });
    println!("integrity checks: {}", report.checks);
    if let Some(replay) = &replay {
        println!("SQL recompute: {}", if replay.passed { "PASS" } else { "FAIL" });
        println!("recompute checks: {}", replay.checks);
        println!("recompute time: {} ms", replay.duration_ms);
        for error in &replay.errors {
            println!("FAIL  {error}");
        }
    }
    println!("report: {}", path.display());
    for warning in &report.warnings {
        println!("WARN  {warning}");
    }
    for error in &report.errors {
        println!("FAIL  {error}");
    }
    if !passed {
        bail!("artifact verification failed");
    }
    Ok(())
}
