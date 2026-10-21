use crate::cli::VerifyArgs;
use crate::verify::{recompute_artifact, verify_artifact, RecomputeReport, VerificationReport};
use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Exit codes of one-shot runs: 0 VERIFIED, 1 completed but NOT VERIFIED,
/// 2 tool, usage or provider error before any verdict.
pub const EXIT_NOT_VERIFIED: i32 = 1;
pub const EXIT_ERROR: i32 = 2;

/// Set by interactive sessions, which must keep running after a failed
/// verification instead of exiting the process.
static INTERACTIVE_SESSION: AtomicBool = AtomicBool::new(false);

pub fn mark_interactive_session() {
    INTERACTIVE_SESSION.store(true, Ordering::SeqCst);
}

/// What only this module can make: the verdict `verify_and_record` computed. A "passed" verification record is written only with one in
/// hand (group_guard::write_verification_record), so neither a command that asks nor another module can produce a pass the checks did
/// not compute. The field is private on purpose: no other module can build the struct.
pub struct VerifiedOutcome {
    passed: bool,
}

impl VerifiedOutcome {
    pub fn passed(&self) -> bool {
        self.passed
    }

    /// Tests of other modules need a credential; this exists only in test builds.
    #[cfg(test)]
    pub fn for_test(passed: bool) -> Self {
        Self { passed }
    }
}

/// Result of integrity verification plus optional SQL recompute, already
/// written to `verification.json`.
pub struct Verification {
    pub report: VerificationReport,
    pub replay: Option<RecomputeReport>,
    pub passed: bool,
    pub path: std::path::PathBuf,
}

/// Shared by `news verify` and the post-run check: integrity first, then SQL
/// recompute whenever requested and integrity passed, then `verification.json`.
pub async fn verify_and_record(
    artifact: &Path,
    duckdb_bin: &Path,
    recompute_timeout: u64,
    recompute: bool,
) -> Result<Verification> {
    let report = verify_artifact(artifact)?;
    let replay = if recompute && report.passed {
        Some(recompute_artifact(artifact, duckdb_bin, recompute_timeout).await?)
    } else {
        None
    };
    let passed = report.passed && replay.as_ref().map(|value| value.passed).unwrap_or(true);
    let total_checks = report.checks + replay.as_ref().map(|value| value.checks).unwrap_or(0);
    let mut output = json!({
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
            "duckdb_bin": duckdb_bin,
        })),
    });
    if passed && chain_fingerprint_at_pass_on() {
        // The chart chain as of this pass: a later follow-up reuses this round only while the chain still matches.
        output["chain_fingerprint_sha256"] = json!(chain_fingerprint_at_pass(artifact)?);
    }
    let path = artifact.join("verification.json");
    crate::group_guard::write_verification_record(
        artifact,
        &path,
        &output,
        &VerifiedOutcome { passed },
    )
    .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(Verification {
        report,
        replay,
        passed,
        path,
    })
}

/// NEWSROOM_CHAIN_FINGERPRINT_AT_PASS=1 (exact "1", default off). The follow-up side (continue_investigation.rs) reads the
/// same switch and computes the same digest from its own copy; the two copies must stay identical, and a unit test in
/// continue_investigation.rs pins that they agree.
fn chain_fingerprint_at_pass_on() -> bool {
    std::env::var("NEWSROOM_CHAIN_FINGERPRINT_AT_PASS")
        .ok()
        .as_deref()
        == Some("1")
}

/// A sorted "relative path TAB sha256" list over every file under the chart chain's directories, hashed once more.
fn chain_fingerprint_at_pass(artifact: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<()> {
        if !dir.is_dir() {
            return Ok(());
        }
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                walk(root, &path, out)?;
            } else if path.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .display()
                    .to_string();
                out.push(format!(
                    "{relative}\t{}",
                    hex(&Sha256::digest(std::fs::read(&path)?))
                ));
            }
        }
        Ok(())
    }
    let mut lines = Vec::new();
    for dir in ["infographics", "publications", "visualizations"] {
        walk(artifact, &artifact.join(dir), &mut lines)?;
    }
    lines.sort();
    Ok(hex(&Sha256::digest(lines.join("\n").as_bytes())))
}

#[cfg(test)]
pub(crate) fn chain_fingerprint_at_pass_for_test(artifact: &Path) -> String {
    chain_fingerprint_at_pass(artifact).unwrap()
}

fn one_line(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 160 {
        format!("{}...", flat.chars().take(157).collect::<String>())
    } else {
        flat
    }
}

/// Final verdict of a run: `None` when verified, otherwise a short reason.
/// Recompute always runs when integrity passes; if it cannot run the verdict
/// is NOT VERIFIED. There is deliberately no opt-out.
pub async fn post_run_verdict(artifact: &Path) -> Option<String> {
    let duckdb_bin = std::path::PathBuf::from(
        std::env::var("NEWSROOM_DUCKDB_BIN")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "duckdb".to_string()),
    );
    match verify_and_record(artifact, &duckdb_bin, 30, true).await {
        Ok(result) if result.passed => None,
        Ok(result) => {
            let (stage, errors) = if !result.report.passed {
                ("integrity", &result.report.errors)
            } else {
                (
                    "recompute",
                    result
                        .replay
                        .as_ref()
                        .map(|value| &value.errors)
                        .unwrap_or(&result.report.errors),
                )
            };
            let first = errors
                .first()
                .map(|value| one_line(value))
                .unwrap_or_default();
            Some(format!(
                "{stage} failed ({} issue(s)): {first}; see verification.json",
                errors.len()
            ))
        }
        Err(error) => Some(format!(
            "verification could not run: {}",
            one_line(&format!("{error:#}"))
        )),
    }
}

/// Runs the post-run check, prints the final `VERIFIED` / `NOT VERIFIED:`
/// line on stderr (stdout carries the streamed answer) and returns whether the
/// artifact verified.
pub async fn announce_post_run_verdict(artifact: &Path) -> bool {
    announce_verdict(post_run_verdict(artifact).await)
}

/// Prints a verdict that was already computed (the step-lines closing line needs it first).
pub fn announce_verdict(verdict: Option<String>) -> bool {
    match verdict {
        None => {
            eprintln!("VERIFIED");
            true
        }
        Some(reason) => {
            eprintln!("NOT VERIFIED: {reason}");
            false
        }
    }
}

/// One-shot CLI commands exit 1 when a completed run is NOT VERIFIED.
pub fn exit_if_not_verified(verified: bool) {
    if !verified && !INTERACTIVE_SESSION.load(Ordering::SeqCst) {
        std::process::exit(EXIT_NOT_VERIFIED);
    }
}

/// Reports a run that failed before any verdict (machine-readable final line
/// on stderr) and exits with the error code. Interactive sessions never exit.
pub fn exit_on_error(error: &anyhow::Error) -> anyhow::Error {
    if INTERACTIVE_SESSION.load(Ordering::SeqCst) {
        return anyhow::anyhow!("{error:#}");
    }
    eprintln!("error: {error:#}");
    eprintln!("NOT VERIFIED: run failed before verification");
    // the failure record is written by now; a SIGTERM or SIGHUP that stopped the run ends the process by that signal
    #[cfg(unix)]
    if let Some(signal) = crate::pi::terminated() {
        crate::pi::die_by(signal);
    }
    std::process::exit(EXIT_ERROR);
}

pub async fn run(args: VerifyArgs) -> Result<()> {
    let Verification {
        report,
        replay,
        passed,
        path,
    } = verify_and_record(
        &args.artifact,
        &args.duckdb_bin,
        args.recompute_timeout,
        args.recompute,
    )
    .await
    .map_err(|error| exit_on_error(&error))?;

    println!(
        "artifact integrity: {}",
        if report.passed { "PASS" } else { "FAIL" }
    );
    println!("integrity checks: {}", report.checks);
    if let Some(replay) = &replay {
        println!(
            "SQL recompute: {}",
            if replay.passed { "PASS" } else { "FAIL" }
        );
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
        eprintln!("NOT VERIFIED: artifact verification failed; see the FAIL lines above");
        std::process::exit(EXIT_NOT_VERIFIED);
    }
    eprintln!("VERIFIED");
    Ok(())
}
