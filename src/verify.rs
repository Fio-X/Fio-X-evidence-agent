use crate::hash::{sha256_bytes, sha256_file};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};

/// schema_version of the render QA report produced by
/// runtime/pi/render_qa.mjs's runRenderQa(). Model output cannot grant
/// verification status: this constant, and the hash-binding checks below,
/// are the only things that decide whether a rendered visual's render QA
/// report is trusted.
const RENDER_QA_REPORT_SCHEMA_VERSION: &str = "render-qa/1.0.0";

/// runtime/pi/infographic.mjs's own INFOGRAPHIC_SCHEMA_VERSIONS constant
/// (infographic.mjs:18). Kept in sync by hand - the runtime module cannot
/// be imported from this verifier's own build.
const INFOGRAPHIC_SCHEMA_VERSIONS: [&str; 6] =
    ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0"];

#[derive(Debug, Default, Serialize)]
pub struct VerificationReport {
    pub passed: bool,
    pub checks: usize,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl VerificationReport {
    fn check(&mut self, condition: bool, message: impl Into<String>) {
        self.checks += 1;
        if !condition {
            self.errors.push(message.into());
        }
    }

    fn error(&mut self, message: impl Into<String>) {
        self.checks += 1;
        self.errors.push(message.into());
    }
}

pub fn verify_artifact(root: &Path) -> Result<VerificationReport> {
    if !root.is_dir() {
        bail!("artifact directory does not exist: {}", root.display());
    }
    let mut report = VerificationReport::default();
    let story_path = root.join("story.json");
    let story = read_json(&story_path)
        .with_context(|| format!("failed to read {}", story_path.display()))?;
    report.check(
        story.get("kind").and_then(Value::as_str) == Some("investigation"),
        "story.json kind must be investigation",
    );

    if let Some(files) = story.get("files").and_then(Value::as_object) {
        for (key, value) in files {
            match value.as_str() {
                Some(reference) => match safe_ref(root, reference) {
                    Ok(path) => report.check(
                        path.is_file(),
                        format!("story files.{key} is missing: {reference}"),
                    ),
                    Err(error) => report.error(format!("story files.{key} is unsafe: {error}")),
                },
                None => report.error(format!("story files.{key} must be a string")),
            }
        }
    } else {
        report.error("story.json files object is missing");
    }

    if let Some(evidence) = story.get("evidence").and_then(Value::as_object) {
        for (kind, values) in evidence {
            if kind == "claims" {
                continue;
            }
            if let Some(items) = values.as_array() {
                for item in items {
                    if let Some(reference) = item.as_str() {
                        match safe_ref(root, reference) {
                            Ok(path) => report.check(
                                path.is_file(),
                                format!(
                                    "story evidence.{kind} references missing file: {reference}"
                                ),
                            ),
                            Err(error) => report.error(format!(
                                "story evidence.{kind} contains unsafe ref {reference}: {error}"
                            )),
                        }
                    }
                }
            }
        }
    }

    verify_run_metrics(root, &story, &mut report)?;
    verify_data(root, &mut report)?;
    verify_sources(root, &mut report)?;
    verify_computations(root, &mut report)?;
    verify_claims(root, &mut report)?;
    verify_visualizations(root, &mut report)?;
    verify_infographics(root, &mut report)?;
    verify_publications(root, &mut report)?;
    verify_delivered_artifact(root, &story, &mut report)?;

    report.passed = report.errors.is_empty();
    Ok(report)
}

fn verify_run_metrics(root: &Path, story: &Value, report: &mut VerificationReport) -> Result<()> {
    if story
        .get("schema_version")
        .and_then(Value::as_str)
        .unwrap_or("")
        < "0.7.0"
    {
        return Ok(());
    }
    let reference = story.pointer("/files/run_metrics").and_then(Value::as_str);
    report.check(
        reference.is_some(),
        "v0.7 story files.run_metrics is missing",
    );
    let Some(reference) = reference else {
        return Ok(());
    };
    let path = match safe_ref(root, reference) {
        Ok(path) => path,
        Err(error) => {
            report.error(format!("run metrics reference is unsafe: {error}"));
            return Ok(());
        }
    };
    report.check(
        path.is_file(),
        format!("run metrics file missing: {reference}"),
    );
    if !path.is_file() {
        return Ok(());
    }
    let mut count = 0usize;
    for (line_no, line) in BufReader::new(fs::File::open(&path)?).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        count += 1;
        match serde_json::from_str::<Value>(&line) {
            Ok(value) => {
                report.check(
                    matches!(
                        value.get("operation").and_then(Value::as_str),
                        Some("investigate" | "continue")
                    ),
                    format!("run metric line {} has invalid operation", line_no + 1),
                );
                report.check(
                    value.get("duration_ms").and_then(Value::as_u64).is_some(),
                    format!("run metric line {} has invalid duration_ms", line_no + 1),
                );
                report.check(
                    matches!(
                        value.get("status").and_then(Value::as_str),
                        Some("draft" | "incomplete" | "failed" | "verified" | "published")
                    ),
                    format!("run metric line {} has invalid status", line_no + 1),
                );
            }
            Err(error) => report.error(format!(
                "run metric line {} is invalid JSON: {error}",
                line_no + 1
            )),
        }
    }
    report.check(
        count > 0,
        "v0.7 run metrics must contain at least one operation",
    );
    Ok(())
}

fn verify_data(root: &Path, report: &mut VerificationReport) -> Result<()> {
    let data_dir = root.join("data");
    if !data_dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(&data_dir)? {
        let path = entry?.path();
        if path.is_file()
            && !path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .ends_with(".meta.json")
        {
            let sidecar = PathBuf::from(format!("{}.meta.json", path.display()));
            report.check(
                sidecar.is_file(),
                format!("dataset is missing metadata sidecar: {}", path.display()),
            );
        }
    }
    for entry in fs::read_dir(&data_dir)? {
        let path = entry?.path();
        if !path.is_file()
            || !path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .ends_with(".meta.json")
        {
            continue;
        }
        let meta = read_json(&path)?;
        let reference = meta.get("file").and_then(Value::as_str);
        let expected = meta.get("sha256").and_then(Value::as_str);
        match (reference, expected) {
            (Some(reference), Some(expected)) => match safe_ref(root, reference) {
                Ok(file) => {
                    report.check(
                        file.is_file(),
                        format!("dataset metadata references missing file: {reference}"),
                    );
                    if file.is_file() {
                        match sha256_file(&file) {
                            Ok(actual) => {
                                report.check(actual == expected, format!("dataset hash mismatch for {reference}: expected {expected}, got {actual}"));
                                let name = file
                                    .file_name()
                                    .and_then(|value| value.to_str())
                                    .unwrap_or("");
                                report.check(
                                    name == expected || name.starts_with(&format!("{expected}.")),
                                    format!("dataset path is not content-addressed: {reference}"),
                                );
                            }
                            Err(error) => {
                                report.error(format!("failed hashing dataset {reference}: {error}"))
                            }
                        }
                    }
                }
                Err(error) => report.error(format!("unsafe dataset file ref {reference}: {error}")),
            },
            _ => report.error(format!(
                "dataset metadata {} must contain file and sha256",
                path.display()
            )),
        }
    }
    let origin_dir = data_dir.join("origins");
    if origin_dir.is_dir() {
        for entry in fs::read_dir(&origin_dir)? {
            let path = entry?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let origin = read_json(&path)?;
            let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
            report.check(
                stem.len() == 64
                    && stem
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                format!("dataset origin path is not hash-shaped: {}", path.display()),
            );
            let reference = origin.get("file").and_then(Value::as_str);
            let expected = origin.get("sha256").and_then(Value::as_str);
            match (reference, expected) {
                (Some(reference), Some(expected)) => {
                    match safe_ref(root, reference) {
                        Ok(payload) => {
                            report.check(
                                reference.starts_with("data/"),
                                format!("dataset origin ref is outside data/: {reference}"),
                            );
                            report.check(
                                payload.is_file(),
                                format!("dataset origin points to missing payload: {reference}"),
                            );
                            if payload.is_file() {
                                match sha256_file(&payload) {
                                Ok(actual) => report.check(actual == expected, format!("dataset origin hash mismatch for {reference}")),
                                Err(error) => report.error(format!("failed hashing dataset origin payload {reference}: {error}")),
                            }
                            }
                        }
                        Err(error) => {
                            report.error(format!("unsafe dataset origin ref {reference}: {error}"))
                        }
                    }
                }
                _ => report.error(format!(
                    "dataset origin {} must contain file and sha256",
                    path.display()
                )),
            }
        }
    }
    Ok(())
}

/// The same 5-field payload runtime/pi/provenance.mjs's sourceContentHash
/// hashes (content_type, final_url, status, text, truncated - in that key
/// order via canonical_json), so every place that must confirm a
/// sources/<hash>.json record has not been edited since it was fetched
/// (verify_sources' own sweep, and the source_quote verbatim-quote check)
/// recomputes the identical hash the same way.
fn expected_source_hash(source: &Value) -> String {
    let payload = serde_json::json!({
        "content_type": source.get("content_type").cloned().unwrap_or(Value::Null),
        "final_url": source.get("final_url").cloned().unwrap_or(Value::Null),
        "status": source.get("status").cloned().unwrap_or(Value::Null),
        "text": source.get("text").cloned().unwrap_or(Value::Null),
        "truncated": source.get("truncated").cloned().unwrap_or(Value::Null),
    });
    sha256_bytes(canonical_json(&payload).as_bytes())
}

fn verify_sources(root: &Path, report: &mut VerificationReport) -> Result<()> {
    let dir = root.join("sources");
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let source = read_json(&path)?;
        if source
            .get("schema_version")
            .and_then(Value::as_str)
            .unwrap_or("")
            >= "0.7.0"
        {
            let expected = source
                .get("content_hash")
                .and_then(Value::as_str)
                .unwrap_or("");
            let actual = expected_source_hash(&source);
            report.check(
                !expected.is_empty() && expected == actual,
                format!("source content_hash mismatch: {}", path.display()),
            );
            report.check(
                source.get("trust").and_then(Value::as_str) == Some("untrusted_external_content"),
                format!(
                    "source trust boundary missing or altered: {}",
                    path.display()
                ),
            );
            let stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            report.check(
                stem == expected,
                format!("source path is not content-addressed: {}", path.display()),
            );
        }
    }
    Ok(())
}

fn verify_input_fingerprint(root: &Path, fingerprint: &str, report: &mut VerificationReport) {
    if let Some(body) = fingerprint.strip_prefix("data:") {
        let Some((reference, expected)) = body.rsplit_once(':') else {
            report.error(format!("malformed data input fingerprint: {fingerprint}"));
            return;
        };
        match safe_ref(root, reference) {
            Ok(path) => {
                report.check(
                    path.is_file(),
                    format!("input fingerprint dataset missing: {reference}"),
                );
                if path.is_file() {
                    match sha256_file(&path) {
                        Ok(actual) => report.check(
                            actual == expected,
                            format!("input fingerprint dataset hash mismatch: {reference}"),
                        ),
                        Err(error) => report.error(format!(
                            "failed hashing fingerprint dataset {reference}: {error}"
                        )),
                    }
                }
            }
            Err(error) => report.error(format!(
                "unsafe data input fingerprint {fingerprint}: {error}"
            )),
        }
        return;
    }
    if let Some(body) = fingerprint.strip_prefix("source:") {
        let Some((filename, expected)) = body.rsplit_once(':') else {
            report.error(format!("malformed source input fingerprint: {fingerprint}"));
            return;
        };
        let reference = format!("sources/{filename}");
        match safe_ref(root, &reference) {
            Ok(path) => {
                report.check(
                    path.is_file(),
                    format!("input fingerprint source missing: {reference}"),
                );
                if path.is_file() {
                    match read_json(&path) {
                        Ok(source) => report.check(
                            source.get("content_hash").and_then(Value::as_str) == Some(expected),
                            format!("input fingerprint source hash mismatch: {reference}"),
                        ),
                        Err(error) => report.error(format!(
                            "failed reading fingerprint source {reference}: {error}"
                        )),
                    }
                }
            }
            Err(error) => report.error(format!(
                "unsafe source input fingerprint {fingerprint}: {error}"
            )),
        }
        return;
    }
    report.error(format!("unknown input fingerprint kind: {fingerprint}"));
}

fn verify_computations(root: &Path, report: &mut VerificationReport) -> Result<()> {
    let dir = root.join("computations");
    let mut verified_input_fingerprints: HashSet<String> = HashSet::new();
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let value = read_json(&path)?;
        let rows = value.get("rows");
        report.check(
            rows.and_then(Value::as_array).is_some(),
            format!("computation {} must contain rows array", path.display()),
        );
        if let (Some(rows), Some(expected)) =
            (rows, value.get("result_hash").and_then(Value::as_str))
        {
            let actual = sha256_bytes(canonical_rows_json(rows).as_bytes());
            report.check(
                actual == expected,
                format!("computation result_hash mismatch in {}", path.display()),
            );
        } else if value
            .get("schema_version")
            .and_then(Value::as_str)
            .unwrap_or("")
            >= "0.7.0"
        {
            report.error(format!(
                "v0.7 computation {} must contain result_hash",
                path.display()
            ));
        }
        if value
            .get("schema_version")
            .and_then(Value::as_str)
            .unwrap_or("")
            >= "0.7.0"
        {
            let input_hash = value.get("input_snapshot_hash").and_then(Value::as_str);
            report.check(
                input_hash.is_some(),
                format!(
                    "v0.7 computation {} must contain input_snapshot_hash",
                    path.display()
                ),
            );
            match value.get("input_fingerprints").and_then(Value::as_array) {
                Some(items) => {
                    let all_strings = items.iter().all(|item| item.as_str().is_some());
                    report.check(
                        all_strings,
                        format!(
                            "v0.7 computation {} input_fingerprints must be strings",
                            path.display()
                        ),
                    );
                    if all_strings {
                        let fingerprints: Vec<String> = items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect();
                        let mut normalized = fingerprints.clone();
                        normalized.sort();
                        normalized.dedup();
                        report.check(
                            fingerprints == normalized,
                            format!(
                                "input_fingerprints must be sorted and unique: {}",
                                path.display()
                            ),
                        );
                        let actual_snapshot = sha256_bytes(fingerprints.join("\n").as_bytes());
                        report.check(
                            input_hash == Some(actual_snapshot.as_str()),
                            format!("input_snapshot_hash mismatch: {}", path.display()),
                        );
                        for fingerprint in &fingerprints {
                            if verified_input_fingerprints.insert(fingerprint.clone()) {
                                verify_input_fingerprint(root, fingerprint, report);
                            }
                        }
                    }
                }
                None => report.error(format!(
                    "v0.7 computation {} must contain input_fingerprints",
                    path.display()
                )),
            }
            if let (Some(sql), Some(input_hash), Some(result_hash)) = (
                value.get("sql").and_then(Value::as_str),
                input_hash,
                value.get("result_hash").and_then(Value::as_str),
            ) {
                let expected_name = format!(
                    "{}.json",
                    sha256_bytes(format!("{sql}\n{input_hash}\n{result_hash}").as_bytes())
                );
                let actual_name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                report.check(
                    actual_name == expected_name,
                    format!(
                        "computation path is not content-addressed: {}",
                        path.display()
                    ),
                );
            }
        }
    }
    Ok(())
}

fn verify_claims(root: &Path, report: &mut VerificationReport) -> Result<()> {
    let path = root.join("claims.jsonl");
    if !path.is_file() {
        return Ok(());
    }
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    for (line_no, line) in reader.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let claim: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                report.error(format!(
                    "claims.jsonl line {} is invalid JSON: {error}",
                    line_no + 1
                ));
                continue;
            }
        };
        if claim.get("status").and_then(Value::as_str) != Some("verified") {
            continue;
        }
        report.check(
            is_system_verified_claim(&claim),
            format!(
                "verified claim on line {} lacks system-derived verification",
                line_no + 1
            ),
        );
        if !is_system_verified_claim(&claim) {
            continue;
        }
        let source_refs = claim
            .get("source_refs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let computation_refs = claim
            .get("computation_refs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        report.check(
            !source_refs.is_empty(),
            format!("verified claim on line {} has no source refs", line_no + 1),
        );
        report.check(
            !computation_refs.is_empty(),
            format!(
                "verified claim on line {} has no computation refs",
                line_no + 1
            ),
        );
        for item in source_refs {
            if let Some(reference) = item.as_str() {
                match safe_ref(root, reference) {
                    Ok(path) => report.check(
                        path.is_file(),
                        format!("verified claim references missing source: {reference}"),
                    ),
                    Err(error) => report.error(format!(
                        "verified claim has unsafe source ref {reference}: {error}"
                    )),
                }
            }
        }
        for item in computation_refs {
            if let Some(reference) = item.as_str() {
                if !reference.starts_with("computations/") {
                    report.error(format!(
                        "verified claim computation ref must be under computations/: {reference}"
                    ));
                    continue;
                }
                match safe_ref(root, reference) {
                    Ok(path) => report.check(
                        path.is_file(),
                        format!("verified claim references missing computation: {reference}"),
                    ),
                    Err(error) => report.error(format!(
                        "verified claim has unsafe computation ref {reference}: {error}"
                    )),
                }
            }
        }
    }
    Ok(())
}

fn verify_visualizations(root: &Path, report: &mut VerificationReport) -> Result<()> {
    let dir = root.join("visualizations");
    if !dir.is_dir() {
        return Ok(());
    }
    let verified_claims = verified_claim_ids(root)?;
    for entry in fs::read_dir(&dir)? {
        let path = entry?.path();
        if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let manifest = read_json(&path)?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("<manifest>");
        if manifest.get("kind").and_then(Value::as_str) == Some("lieflat_chart") {
            // runtime/pi/lieflat.mjs's chart mode writes artifact_status:
            // "VERIFIED" and desktop_qa: "PASS" as renderer constants, with
            // no render_qa_ref, lint_ref or critic at all - never trust
            // this self-issued pair, and give it its own message rather
            // than the generic legacy-newsroom_chart wording below (this
            // manifest does have variants, just no plan_ref, so it would
            // otherwise fall into that generic branch too).
            report.error(format!(
                "visualization {name} is a Lieflat chart whose desktop_qa/artifact_status are renderer constants (kind=lieflat_chart), not measured render QA or critic results"
            ));
            continue;
        }
        if manifest.get("variants").is_none() || manifest.get("plan_ref").is_none() {
            // Anything under visualizations/ shaped like this bypassed
            // newsroom_viz_plan -> lint -> render entirely - most commonly
            // the legacy newsroom_chart tool, which writes a flat SVG+claim
            // manifest with no plan_ref/variants at all. Fail closed instead
            // of silently skipping it, so lint, render QA and critic cannot
            // be bypassed by using the older tool.
            report.error(format!(
                "visualization {name} is not a gated visualization manifest (no plan_ref/variants), e.g. output of the legacy newsroom_chart tool"
            ));
            continue;
        }
        let plan_ref = manifest
            .get("plan_ref")
            .and_then(Value::as_str)
            .unwrap_or("");
        let lint_ref = manifest
            .get("lint_ref")
            .and_then(Value::as_str)
            .unwrap_or("");
        let claim_id = manifest
            .get("claim_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        let verification_mode = manifest
            .get("verification_mode")
            .and_then(Value::as_str)
            .unwrap_or("verified");
        let draft = verification_mode == "draft"
            || manifest.get("artifact_status").and_then(Value::as_str) == Some("DRAFT")
            || manifest.get("publishable").and_then(Value::as_bool) == Some(false);
        report.check(
            !plan_ref.is_empty(),
            format!("visualization {name} missing plan_ref"),
        );
        report.check(
            !lint_ref.is_empty(),
            format!("visualization {name} missing lint_ref"),
        );
        if draft {
            report.check(
                claim_id.is_empty() || verified_claims.contains(claim_id),
                format!(
                    "draft visualization {name} has an unverified optional claim_id: {claim_id}"
                ),
            );
        } else {
            report.check(
                verified_claims.contains(claim_id),
                format!("visualization {name} claim_id is not verified: {claim_id}"),
            );
        }
        for (label, reference, prefix) in [
            ("plan", plan_ref, "visualizations/plans/"),
            ("lint", lint_ref, "visualizations/lints/"),
        ] {
            if !reference.starts_with(prefix) {
                report.error(format!(
                    "visualization {name} {label} ref must be under {prefix}"
                ));
                continue;
            }
            match safe_ref(root, reference) {
                Ok(path) => report.check(
                    path.is_file(),
                    format!("visualization {name} references missing {label}: {reference}"),
                ),
                Err(error) => report.error(format!(
                    "visualization {name} has unsafe {label} ref: {error}"
                )),
            }
        }

        if let Some(variants) = manifest.get("variants").and_then(Value::as_object) {
            // The desktop SVG is required. The compact mobile SVG is optional
            // (the runtime renders it only when NEWSROOM_MOBILE_PAGES=1), but
            // a listed one is checked like the desktop one and bound to render
            // QA below, and nothing else may be listed.
            for key in variants.keys() {
                report.check(
                    key == "desktop" || key == "mobile",
                    format!("visualization {name} lists an unknown variant: {key}"),
                );
            }
            for viewport in ["desktop", "mobile"] {
                if viewport == "mobile" && !variants.contains_key("mobile") {
                    continue;
                }
                let reference = variants.get(viewport).and_then(Value::as_str).unwrap_or("");
                if reference.is_empty() {
                    report.error(format!("visualization {name} missing {viewport} SVG ref"));
                    continue;
                }
                match safe_ref(root, reference) {
                    Ok(svg) => {
                        report.check(
                            svg.is_file(),
                            format!("visualization {name} missing {viewport} SVG: {reference}"),
                        );
                        if svg.is_file() {
                            let text = fs::read_to_string(&svg).unwrap_or_default();
                            report.check(text.contains("<svg") && text.contains("<title") && text.contains("<desc"), format!("visualization {name} {viewport} SVG lacks accessible SVG/title/desc markup"));
                            report.check(
                                text.len() > 120,
                                format!(
                                    "visualization {name} {viewport} SVG is suspiciously small"
                                ),
                            );
                        }
                    }
                    Err(error) => report.error(format!(
                        "visualization {name} has unsafe {viewport} ref: {error}"
                    )),
                }
            }
        }

        {
            let variants = manifest.get("variants").and_then(Value::as_object);
            let desktop_ref = variants
                .and_then(|v| v.get("desktop"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let mobile_ref = variants
                .and_then(|v| v.get("mobile"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let render_qa_ref = manifest
                .get("render_qa_ref")
                .and_then(Value::as_str)
                .unwrap_or("");
            // A choropleth's color channel can only be exempted from the
            // color_only_quantity lint blocker (editorial_validators.mjs)
            // when its render_qa report proves every plotted region's value
            // is shown as complete, exact, legible text - never from the
            // plan's own say-so. Require that proof here too, independently
            // re-derived from the artifact, so a published choropleth cannot
            // carry a missing/failing/stale value_labels check even if the
            // JS lint that ran at plan time somehow let one through.
            let is_choropleth =
                manifest.get("chart_type").and_then(Value::as_str) == Some("choropleth");
            if draft {
                if !render_qa_ref.is_empty() {
                    check_render_qa_ref(
                        root,
                        &format!("visualization {name}"),
                        render_qa_ref,
                        "visualizations/qa/",
                        &[("desktop", desktop_ref), ("mobile", mobile_ref)],
                        false,
                        is_choropleth,
                        report,
                    );
                }
            } else {
                report.check(
                    !render_qa_ref.is_empty(),
                    format!("visualization {name} missing render_qa_ref"),
                );
                if !render_qa_ref.is_empty() {
                    check_render_qa_ref(
                        root,
                        &format!("visualization {name}"),
                        render_qa_ref,
                        "visualizations/qa/",
                        &[("desktop", desktop_ref), ("mobile", mobile_ref)],
                        true,
                        is_choropleth,
                        report,
                    );
                }
            }
        }

        if !lint_ref.is_empty() {
            if let Ok(lint_path) = safe_ref(root, lint_ref) {
                if lint_path.is_file() {
                    let lint = read_json(&lint_path)?;
                    report.check(
                        lint.get("passed").and_then(Value::as_bool) == Some(true),
                        format!("visualization {name} lint did not pass"),
                    );
                    report.check(
                        lint.get("plan_ref").and_then(Value::as_str) == Some(plan_ref),
                        format!("visualization {name} lint plan_ref mismatch"),
                    );
                    let comp_ref = lint
                        .get("computation_ref")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if comp_ref.is_empty() {
                        report.error(format!("visualization {name} lint missing computation_ref"));
                    } else if let Ok(comp_path) = safe_ref(root, comp_ref) {
                        report.check(
                            comp_path.is_file(),
                            format!("visualization {name} lint computation missing: {comp_ref}"),
                        );
                        if comp_path.is_file() {
                            let comp = read_json(&comp_path)?;
                            if let (Some(lint_hash), Some(result_hash)) = (
                                lint.get("data_hash").and_then(Value::as_str),
                                comp.get("result_hash").and_then(Value::as_str),
                            ) {
                                report.check(lint_hash == result_hash, format!("visualization {name} lint data_hash does not match computation result_hash"));
                                if let Some(manifest_hash) =
                                    manifest.get("data_hash").and_then(Value::as_str)
                                {
                                    report.check(manifest_hash == result_hash, format!("visualization {name} manifest data_hash does not match computation result_hash"));
                                }
                            }
                        }
                    }
                }
            }
        }

        let manifest_ref = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let critics = find_critics(root, "visualizations/critics", &manifest_ref)?;
        report.check(
            !critics.is_empty(),
            format!("visualization {name} has no critic artifact"),
        );
        report.check(
            critics
                .iter()
                .any(|value| value.get("passed").and_then(Value::as_bool) == Some(true)),
            format!("visualization {name} has no passing critic"),
        );
    }
    Ok(())
}

// --- Independent choropleth value-labels re-derivation (review fix 7) -----
//
// check_render_qa_ref's require_choropleth_value_labels branch used to stop
// at "the render_qa report's viewports.<viewport>.value_labels.passed is
// true, and the report is sha256-bound to these exact SVG bytes". That
// hash-binding proves the report was *computed against* these bytes at some
// point; it does not prove the report's own label-proof logic actually ran,
// or ran correctly, against them - a hand-crafted or buggy report could
// still say `passed: true` next to an SVG that has no labels at all. The
// functions below re-derive the same "every plotted region is labelled
// exactly once, with its own value" proof directly from the rendered SVG
// markup, from scratch, independent of - and never calling into -
// runtime/pi/render_qa_labels.mjs's own JS implementation, so a defect in
// one checker cannot silently pass through the other. (No regex crate is a
// project dependency, so this is a small hand-rolled scanner rather than a
// pattern match; the choropleth SVG markup it reads is emitted by a fixed,
// small set of call sites in runtime/pi/viz.mjs, not arbitrary XML.)

/// Returns the value of `attr="..."` inside a single opening-tag string
/// (e.g. `<path data-role="x" data-iso3="GIN".../>`), or None if absent.
fn attr_value<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let needle = format!("{attr}=\"");
    let start = tag.find(needle.as_str())? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Finds every self-closing `<path ...>` tag whose `data-role` is exactly
/// `role`, returning each match's full opening-tag text.
fn find_path_tags_with_role<'a>(svg: &'a str, role: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut idx = 0;
    while let Some(rel) = svg[idx..].find("<path") {
        let start = idx + rel;
        let after = start + "<path".len();
        if !svg[after..].starts_with(|c: char| c.is_whitespace() || c == '>') {
            idx = after;
            continue;
        }
        let Some(gt_rel) = svg[start..].find('>') else {
            break;
        };
        let tag_end = start + gt_rel + 1;
        let tag = &svg[start..tag_end];
        idx = tag_end;
        if attr_value(tag, "data-role") == Some(role) {
            out.push(tag);
        }
    }
    out
}

/// One `<text ...>BODY</text>` node's opening-tag text and inner body.
struct SvgTextNode<'a> {
    tag: &'a str,
    body: &'a str,
}

/// Finds every `<text ...>...</text>` node whose `data-role` is one of
/// `roles`.
fn find_text_nodes_with_role<'a>(svg: &'a str, roles: &[&str]) -> Vec<SvgTextNode<'a>> {
    let mut out = Vec::new();
    let mut idx = 0;
    while let Some(rel) = svg[idx..].find("<text") {
        let start = idx + rel;
        let after = start + "<text".len();
        if !svg[after..].starts_with(|c: char| c.is_whitespace() || c == '>') {
            idx = after;
            continue;
        }
        let Some(gt_rel) = svg[start..].find('>') else {
            break;
        };
        let tag_end = start + gt_rel + 1;
        let tag = &svg[start..tag_end];
        let Some(close_rel) = svg[tag_end..].find("</text>") else {
            idx = tag_end;
            continue;
        };
        let body = &svg[tag_end..tag_end + close_rel];
        idx = tag_end + close_rel + "</text>".len();
        if let Some(role) = attr_value(tag, "data-role") {
            if roles.contains(&role) {
                out.push(SvgTextNode { tag, body });
            }
        }
    }
    out
}

/// A label's rendered text: the first `<tspan>...</tspan>`'s inner text when
/// present (the on-map/inset layout, where a second tspan may carry a
/// reference period), otherwise the body's own text with any tags stripped
/// (the margin/overflow layout, where truncation shows up as a literal "…").
/// Mirrors render_qa_labels.mjs's labelText, written fresh rather than
/// shared.
fn label_body_text(body: &str) -> String {
    if let Some(start_rel) = body.find("<tspan") {
        if let Some(gt_rel) = body[start_rel..].find('>') {
            let inner_start = start_rel + gt_rel + 1;
            if let Some(close_rel) = body[inner_start..].find("</tspan>") {
                return body[inner_start..inner_start + close_rel].trim().to_string();
            }
        }
    }
    let mut out = String::new();
    let mut in_tag = false;
    for c in body.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Parses a label's leading number, applying a trailing k/m/bn scale suffix
/// exactly like runtime/pi/viz.mjs's choroplethValueText (a rendered value
/// of "1.2m" means 1_200_000, not 1.2). Any other trailing suffix (percent
/// sign, currency symbol, bare unit word) leaves the number's own scale
/// alone - the digits are what must match the region's data-value. Returns
/// None when there is no leading number at all (missing, truncated, or a
/// bare "…").
fn leading_number_with_scale(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    let mut i = 0;
    if i < bytes.len() && bytes[i] == b'-' {
        i += 1;
    }
    let digits_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
    }
    if i == digits_start {
        return None;
    }
    let number: f64 = text[..i].parse().ok()?;
    let rest = text[i..].to_ascii_lowercase();
    let scale = if rest.starts_with("bn") {
        1_000_000_000.0
    } else if rest.starts_with('m') {
        1_000_000.0
    } else if rest.starts_with('k') {
        1_000.0
    } else {
        1.0
    };
    Some(number * scale)
}

/// Independently re-derives the choropleth value-labels proof straight from
/// one rendered viewport's SVG markup: every `choropleth-data` region's own
/// `data-iso3`/`data-value`, and every name/value label's `data-iso3` and
/// rendered text, on the main map or inside a zoom inset. Requires each data
/// region to be named exactly once and valued exactly once, with the shown
/// number matching the region's own data-value, and rejects any label that
/// names a region with no matching data path. Returns the list of failure
/// messages (empty means the proof holds).
fn verify_choropleth_labels_from_svg(svg_text: &str) -> Vec<String> {
    let mut failures = Vec::new();

    let mut data_values: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for tag in find_path_tags_with_role(svg_text, "choropleth-data") {
        let (Some(iso3), Some(value_str)) =
            (attr_value(tag, "data-iso3"), attr_value(tag, "data-value"))
        else {
            continue;
        };
        let Ok(value) = value_str.parse::<f64>() else {
            continue;
        };
        data_values.entry(iso3.to_owned()).or_default().push(value);
    }

    let mut names: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for node in find_text_nodes_with_role(svg_text, &["choropleth-label", "choropleth-inset-label"]) {
        let Some(iso3) = attr_value(node.tag, "data-iso3") else {
            continue;
        };
        names
            .entry(iso3.to_owned())
            .or_default()
            .push(label_body_text(node.body));
    }
    let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for node in
        find_text_nodes_with_role(svg_text, &["choropleth-label-value", "choropleth-inset-label-value"])
    {
        let Some(iso3) = attr_value(node.tag, "data-iso3") else {
            continue;
        };
        values
            .entry(iso3.to_owned())
            .or_default()
            .push(label_body_text(node.body));
    }

    for (iso3, vals) in &data_values {
        if vals.len() != 1 {
            failures.push(format!(
                "{iso3} has {} choropleth-data regions with conflicting data-value attributes",
                vals.len()
            ));
            continue;
        }
        let expected = vals[0];
        let name_count = names.get(iso3).map(|v| v.len()).unwrap_or(0);
        if name_count != 1 {
            failures.push(format!(
                "{iso3} has {name_count} rendered name labels in the SVG (expected exactly 1)"
            ));
        }
        let value_texts = values.get(iso3).cloned().unwrap_or_default();
        if value_texts.len() != 1 {
            failures.push(format!(
                "{iso3} has {} rendered value labels in the SVG (expected exactly 1)",
                value_texts.len()
            ));
            continue;
        }
        let text = &value_texts[0];
        match leading_number_with_scale(text) {
            Some(shown) => {
                let tolerance = (expected.abs() * 0.01).max(0.05);
                if (shown - expected).abs() > tolerance {
                    failures.push(format!(
                        "{iso3}'s rendered value label '{text}' does not match its region's data-value {expected}"
                    ));
                }
            }
            None => failures.push(format!(
                "{iso3}'s rendered value label '{text}' has no readable number (missing, truncated, or malformed)"
            )),
        }
    }

    for iso3 in names.keys().chain(values.keys()) {
        if !data_values.contains_key(iso3) {
            failures.push(format!(
                "{iso3} has a rendered label but no matching choropleth-data region in the SVG"
            ));
        }
    }

    failures.sort();
    failures.dedup();
    failures
}

/// Validates one manifest's `render_qa_ref`: it must be a safe reference
/// under `qa_prefix` pointing at an existing JSON file with the known render
/// QA report schema_version, and for every named viewport, the report's
/// stored `svg_sha256` must equal the sha256 of that viewport's actual
/// rendered SVG bytes on disk - recomputed here in Rust, never trusted from
/// the report or from model output. The report's viewports must be exactly
/// the named (non-empty) variants: a viewport the manifest does not list is
/// a QA claim bound to nothing. When `require_passed` is true the report's
/// own `passed` and every named viewport's `passed` must also be `true`;
/// callers pass `false` for a draft artifact, where a present ref is still
/// checked for well-formedness and hash-binding but is not required to have
/// passed. When `require_choropleth_value_labels` is true, the value-labels
/// proof is ALSO independently re-derived straight from each named
/// viewport's SVG bytes (verify_choropleth_labels_from_svg) - not just read
/// off the report's own `value_labels.passed` boolean.
#[allow(clippy::too_many_arguments)]
fn check_render_qa_ref(
    root: &Path,
    name: &str,
    qa_ref: &str,
    qa_prefix: &str,
    variants: &[(&str, &str)],
    require_passed: bool,
    require_choropleth_value_labels: bool,
    report: &mut VerificationReport,
) {
    if !qa_ref.starts_with(qa_prefix) {
        report.error(format!(
            "{name} render_qa_ref must be under {qa_prefix}: {qa_ref}"
        ));
        return;
    }
    let qa_path = match safe_ref(root, qa_ref) {
        Ok(path) => path,
        Err(error) => {
            report.error(format!("{name} has an unsafe render_qa_ref: {error}"));
            return;
        }
    };
    report.check(
        qa_path.is_file(),
        format!("{name} render_qa_ref is missing: {qa_ref}"),
    );
    if !qa_path.is_file() {
        return;
    }
    let qa = match read_json(&qa_path) {
        Ok(value) => value,
        Err(error) => {
            report.error(format!(
                "{name} render_qa report is not valid JSON: {error}"
            ));
            return;
        }
    };
    report.check(
        qa.get("schema_version").and_then(Value::as_str) == Some(RENDER_QA_REPORT_SCHEMA_VERSION),
        format!("{name} render_qa report has an unknown schema_version"),
    );
    if require_passed {
        report.check(
            qa.get("passed").and_then(Value::as_bool) == Some(true),
            format!("{name} render QA did not pass"),
        );
    }
    match qa.get("viewports").and_then(Value::as_object) {
        Some(viewports) => {
            for reported in viewports.keys() {
                let listed = variants.iter().any(|(viewport, reference)| {
                    *viewport == reported.as_str() && !reference.is_empty()
                });
                report.check(
                    listed,
                    format!(
                        "{name} render_qa report has viewports.{reported}, which the manifest does not list"
                    ),
                );
            }
        }
        None => report.error(format!("{name} render_qa report has no viewports object")),
    }
    for (viewport, svg_reference) in variants {
        if svg_reference.is_empty() {
            continue;
        }
        if require_passed {
            report.check(
                qa.pointer(&format!("/viewports/{viewport}/passed"))
                    .and_then(Value::as_bool)
                    == Some(true),
                format!("{name} render QA did not pass for {viewport}"),
            );
        }
        if require_choropleth_value_labels {
            report.check(
                qa.pointer(&format!("/viewports/{viewport}/value_labels/passed"))
                    .and_then(Value::as_bool)
                    == Some(true),
                format!(
                    "{name} render QA is missing a passing value_labels check for {viewport} (required for a choropleth)"
                ),
            );
        }
        let expected = qa
            .pointer(&format!("/viewports/{viewport}/svg_sha256"))
            .and_then(Value::as_str);
        report.check(
            expected.is_some(),
            format!("{name} render_qa report is missing viewports.{viewport}.svg_sha256"),
        );
        let Some(expected) = expected else {
            continue;
        };
        match safe_ref(root, svg_reference) {
            Ok(svg_path) => {
                // Missing-file existence is already reported by the caller's
                // own variant-existence check; only compare hashes here.
                if svg_path.is_file() {
                    match sha256_file(&svg_path) {
                        Ok(actual) => report.check(
                            actual == expected,
                            format!(
                                "{name} {viewport} SVG hash does not match render_qa report: {svg_reference}"
                            ),
                        ),
                        Err(error) => report.error(format!(
                            "{name} failed hashing {viewport} SVG {svg_reference}: {error}"
                        )),
                    }
                    // Review fix 7: never trust the report's own
                    // value_labels.passed boolean alone, even sha256-bound -
                    // independently re-derive the same proof from these SVG
                    // bytes on disk.
                    if require_choropleth_value_labels {
                        match fs::read_to_string(&svg_path) {
                            Ok(svg_text) => {
                                for failure in verify_choropleth_labels_from_svg(&svg_text) {
                                    report.error(format!(
                                        "{name} {viewport} independent value-labels re-derivation failed: {failure}"
                                    ));
                                }
                            }
                            Err(error) => report.error(format!(
                                "{name} failed reading {viewport} SVG {svg_reference} for independent value-labels re-derivation: {error}"
                            )),
                        }
                    }
                }
            }
            Err(error) => report.error(format!("{name} has an unsafe {viewport} ref: {error}")),
        }
    }
}

/// Verifies infographics/*.json page manifests (the plans/, lints/,
/// critics/, previews/, vision-critics/, revisions/ and
/// competition-preflight/ subdirectories are never iterated as pages
/// themselves, exactly like verify_visualizations does for
/// visualizations/, but critics/, vision-critics/ and the illustrations
/// a page links are read and independently re-checked - see
/// verify_infographic_critics and verify_infographic_illustrations). A
/// page must not verify while any SVG it lists fails the reader-facing
/// render QA checks, while it lacks a passing critic (and, when
/// visual_review_required is set, a passing image-aware vision critic),
/// or while any illustration it links fails its own provenance/critic
/// gate. The desktop page is required; the mobile page is optional (the
/// runtime renders it only when NEWSROOM_MOBILE_PAGES=1), but a listed
/// page is bound exactly like the desktop one and nothing else may be
/// listed.
fn verify_infographics(root: &Path, report: &mut VerificationReport) -> Result<()> {
    let dir = root.join("infographics");
    if !dir.is_dir() {
        return Ok(());
    }
    let verified_claims = verified_claim_ids(root)?;
    for entry in fs::read_dir(&dir)? {
        let path = entry?.path();
        if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let manifest = read_json(&path)?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("<manifest>");

        let schema_version = manifest
            .get("schema_version")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !INFOGRAPHIC_SCHEMA_VERSIONS.contains(&schema_version) {
            // Every top-level infographics/*.json is verified - never
            // silently skipped, the same failure mode V4 closed for
            // visualizations/*.json. newsroom_infographic_render copies
            // spec.schema_version verbatim into the manifest
            // (newsroom.ts), so an out-of-range value here means the
            // manifest was never validated by validateInfographicSpec at
            // all.
            report.error(format!(
                "infographic {name} has an unsupported schema_version: {schema_version}"
            ));
            continue;
        }

        let plan_ref = manifest
            .get("plan_ref")
            .and_then(Value::as_str)
            .unwrap_or("");
        let lint_ref = manifest
            .get("lint_ref")
            .and_then(Value::as_str)
            .unwrap_or("");
        if plan_ref.is_empty() || lint_ref.is_empty() || manifest.get("variants").is_none() {
            // Anything shaped like this bypassed
            // newsroom_infographic_plan -> lint -> render entirely, the
            // same silent-skip gap V4 closed for visualizations/*.json.
            report.error(format!(
                "infographic {name} is not a gated infographic manifest (no plan_ref/lint_ref/variants)"
            ));
            continue;
        }
        let manifest_ref = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        if !lint_ref.starts_with("infographics/lints/") {
            report.error(format!(
                "infographic {name} lint_ref must be under infographics/lints/"
            ));
        } else {
            match safe_ref(root, lint_ref) {
                Ok(lint_path) => {
                    report.check(
                        lint_path.is_file(),
                        format!("infographic {name} references missing lint: {lint_ref}"),
                    );
                    if lint_path.is_file() {
                        match read_json(&lint_path) {
                            Ok(lint) => report.check(
                                lint.get("passed").and_then(Value::as_bool) == Some(true),
                                format!("infographic {name} lint did not pass"),
                            ),
                            Err(error) => report.error(format!(
                                "infographic {name} lint is not valid JSON: {error}"
                            )),
                        }
                    }
                }
                Err(error) => report.error(format!(
                    "infographic {name} has an unsafe lint_ref: {error}"
                )),
            }
        }

        let variants = manifest.get("variants").and_then(Value::as_object);
        let hashes = manifest.get("hashes").and_then(Value::as_object);
        if let Some(variants) = variants {
            for key in variants.keys() {
                report.check(
                    key == "desktop" || key == "mobile",
                    format!("infographic {name} lists an unknown variant: {key}"),
                );
            }
        }
        if let Some(hashes) = hashes {
            for key in hashes.keys() {
                let listed = key
                    .strip_suffix("_sha256")
                    .and_then(|viewport| variants.and_then(|v| v.get(viewport)))
                    .is_some();
                report.check(
                    listed,
                    format!("infographic {name} has hashes.{key} without a matching variant"),
                );
            }
        }
        // The source strip's expected language is read from the hash-bound
        // plan (never from the rendered SVG text itself), so a page can't
        // pass by having any strip at all - it must be the one its own plan
        // asked for. Defaults to false ("en"), matching the runtime's own
        // language: params.language ?? "en" default.
        let plan_is_zh = safe_ref(root, plan_ref)
            .ok()
            .filter(|path| path.is_file())
            .and_then(|path| read_json(&path).ok())
            .and_then(|plan| {
                plan.get("language")
                    .and_then(Value::as_str)
                    .map(|language| language == "zh")
            })
            .unwrap_or(false);

        let mut desktop_ref = "";
        let mut mobile_ref = "";
        for viewport in ["desktop", "mobile"] {
            let Some(value) = variants.and_then(|v| v.get(viewport)) else {
                if viewport == "desktop" {
                    report.error(format!("infographic {name} missing desktop SVG ref"));
                }
                continue;
            };
            let reference = value.as_str().unwrap_or("");
            if viewport == "desktop" {
                desktop_ref = reference;
            } else {
                mobile_ref = reference;
            }
            if reference.is_empty() {
                report.error(format!("infographic {name} missing {viewport} SVG ref"));
                continue;
            }
            let hash_key = format!("{viewport}_sha256");
            let expected = hashes
                .and_then(|h| h.get(hash_key.as_str()))
                .and_then(Value::as_str);
            match safe_ref(root, reference) {
                Ok(svg_path) => {
                    report.check(
                        svg_path.is_file(),
                        format!("infographic {name} missing {viewport} SVG: {reference}"),
                    );
                    if svg_path.is_file() {
                        report.check(
                            expected.is_some(),
                            format!("infographic {name} manifest is missing hashes.{hash_key}"),
                        );
                        if let Some(expected) = expected {
                            match sha256_file(&svg_path) {
                                Ok(actual) => report.check(
                                    actual == expected,
                                    format!(
                                        "infographic {name} {viewport} SVG hash does not match manifest hashes: {reference}"
                                    ),
                                ),
                                Err(error) => report.error(format!(
                                    "infographic {name} failed hashing {viewport} SVG {reference}: {error}"
                                )),
                            }
                        }
                        match fs::read_to_string(&svg_path) {
                            Ok(text) => {
                                let expected_strip = if plan_is_zh {
                                    "资料来源与方法"
                                } else {
                                    "SOURCES &amp; METHODS"
                                };
                                report.check(
                                    text.contains(expected_strip),
                                    format!(
                                        "infographic {name} {viewport} source strip missing or wrong language for plan language={}",
                                        if plan_is_zh { "zh" } else { "en" }
                                    ),
                                );
                            }
                            Err(error) => report.error(format!(
                                "infographic {name} failed reading {viewport} SVG {reference}: {error}"
                            )),
                        }
                    }
                }
                Err(error) => report.error(format!(
                    "infographic {name} has an unsafe {viewport} ref: {error}"
                )),
            }
        }

        let render_qa_ref = manifest
            .get("render_qa_ref")
            .and_then(Value::as_str)
            .unwrap_or("");
        report.check(
            !render_qa_ref.is_empty(),
            format!("infographic {name} missing render_qa_ref"),
        );
        if !render_qa_ref.is_empty() {
            check_render_qa_ref(
                root,
                &format!("infographic {name}"),
                render_qa_ref,
                "infographics/qa/",
                &[("desktop", desktop_ref), ("mobile", mobile_ref)],
                true,
                false,
                report,
            );
        }

        verify_infographic_illustrations(root, &manifest_ref, &manifest, &verified_claims, report)?;
        verify_infographic_critics(root, &manifest_ref, name, &manifest, report)?;
        verify_infographic_source_quotes(root, name, plan_ref, plan_is_zh, desktop_ref, report)?;
    }
    Ok(())
}

/// Finds every `[page N]\n` marker runtime/pi/pdf_extract.mjs's
/// formatPagesWithMarkers writes into a PDF source's saved text, and returns
/// (page_number, marker_start_byte, content_start_byte) for each in order.
/// Hand-rolled instead of a regex crate dependency - the marker is a fixed
/// ASCII literal, so a plain substring scan is exact and dependency-free.
fn find_pdf_page_markers(text: &str) -> Vec<(u64, usize, usize)> {
    let mut marks = Vec::new();
    let mut search_from = 0usize;
    while let Some(rel) = text[search_from..].find("[page ") {
        let start = search_from + rel;
        let digits_start = start + "[page ".len();
        let mut end = digits_start;
        while end < text.len() && text.as_bytes()[end].is_ascii_digit() {
            end += 1;
        }
        if end > digits_start && text[end..].starts_with("]\n") {
            if let Ok(page) = text[digits_start..end].parse::<u64>() {
                marks.push((page, start, end + 2));
            }
        }
        search_from = start + "[page ".len();
    }
    marks
}

/// A source with no `[page N]` markers at all (an HTML/plain-text
/// extraction, which has no page concept) collapses to a single implicit
/// page 1, so a source_quote module is shaped identically whether or not its
/// source happens to be a paginated PDF.
fn source_page_text(text: &str, page: u64) -> Option<String> {
    let marks = find_pdf_page_markers(text);
    if marks.is_empty() {
        return if page == 1 {
            Some(text.to_string())
        } else {
            None
        };
    }
    let index = marks.iter().position(|(p, _, _)| *p == page)?;
    let content_start = marks[index].2;
    let content_end = marks
        .get(index + 1)
        .map(|(_, start, _)| *start)
        .unwrap_or(text.len());
    Some(text[content_start..content_end].to_string())
}

/// Whitespace-collapse and line-break-hyphenation joins only - nothing
/// semantic - mirroring runtime/pi/infographic.mjs's
/// normalizeSourceQuoteText and scripts/verify_artifact.py's
/// normalize_source_quote_text exactly, so all three verbatim-quote checks
/// (JS lint, this Rust verifier, the Python verifier) accept and reject the
/// same inputs.
fn normalize_source_quote_text(value: &str) -> String {
    value
        .replace("-\n", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

const SOURCE_QUOTE_PROSE_MAX_CHARS: usize = 60;

/// True for an ASCII digit, a full-width digit (U+FF10-U+FF19), or '%' -
/// mirrors runtime/pi/infographic.mjs's SOURCE_QUOTE_PROSE_FORBIDDEN and
/// scripts/verify_artifact.py's identical check exactly.
fn is_source_quote_prose_digit_or_percent(c: char) -> bool {
    c.is_ascii_digit() || matches!(c as u32, 0xFF10..=0xFF19) || c == '%'
}

/// A text module's body/heading are bound to neither its source_quote nor
/// any claim, so free prose sitting next to a source-only quote must stay
/// short and free of anything that could pass for a verified figure.
fn check_source_quote_prose_field(
    report: &mut VerificationReport,
    name: &str,
    module_id: &str,
    field: &str,
    value: &str,
) {
    report.check(
        value.chars().count() <= SOURCE_QUOTE_PROSE_MAX_CHARS,
        format!(
            "infographic {name} text module '{module_id}' source_quote {field} must be at most {SOURCE_QUOTE_PROSE_MAX_CHARS} characters"
        ),
    );
    report.check(
        !value.chars().any(is_source_quote_prose_digit_or_percent),
        format!(
            "infographic {name} text module '{module_id}' source_quote {field} must not contain digits or a percent sign: a source-only note must never look like a verified figure"
        ),
    );
}

/// Rechecks every text module's source_quote (runtime/pi/infographic.mjs's
/// InfographicSpec extension) against the saved source's own bytes, read
/// fresh from artifacts here - never trusted from the plan or the lint
/// record - so an edited quote, a wrong page, or a source swapped after
/// planning fails verification even if lint once passed. Also confirms the
/// rendered desktop SVG visibly carries the page number and, on a zh page,
/// the 译述 translation label, so a source-only note can never look
/// indistinguishable from a verified finding.
fn verify_infographic_source_quotes(
    root: &Path,
    name: &str,
    plan_ref: &str,
    plan_is_zh: bool,
    desktop_ref: &str,
    report: &mut VerificationReport,
) -> Result<()> {
    let Ok(plan_path) = safe_ref(root, plan_ref) else {
        return Ok(());
    };
    if !plan_path.is_file() {
        return Ok(());
    }
    let Ok(plan) = read_json(&plan_path) else {
        return Ok(());
    };
    let modules = plan
        .get("modules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let desktop_svg = safe_ref(root, desktop_ref)
        .ok()
        .filter(|p| p.is_file())
        .and_then(|p| fs::read_to_string(&p).ok());
    for module in &modules {
        if module.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(sq) = module.get("source_quote") else {
            continue;
        };
        let module_id = module.get("id").and_then(Value::as_str).unwrap_or("?");
        // Body and heading sit beside the source_quote but are bound to
        // neither a claim nor the quote itself, so free prose there must
        // never be able to pass for a verified figure: rechecked here from
        // the plan artifact, independent of runtime/pi/infographic.mjs's
        // validateInfographicSpec (which normally catches this first).
        let body = module.get("body").and_then(Value::as_str).unwrap_or("");
        if !body.trim().is_empty() {
            check_source_quote_prose_field(report, name, module_id, "body", body);
        }
        let heading = module.get("heading").and_then(Value::as_str).unwrap_or("");
        if !heading.trim().is_empty() {
            check_source_quote_prose_field(report, name, module_id, "heading", heading);
        }
        let source_ref = sq.get("source_ref").and_then(Value::as_str).unwrap_or("");
        let page = sq.get("page").and_then(Value::as_u64);
        let quote = sq.get("quote").and_then(Value::as_str).unwrap_or("");
        let translation = sq.get("translation").and_then(Value::as_str);

        let Some(page) = page else {
            report.error(format!(
                "infographic {name} text module '{module_id}' source_quote has no integer page"
            ));
            continue;
        };
        let Ok(source_path) = safe_ref(root, source_ref) else {
            report.error(format!(
                "infographic {name} text module '{module_id}' source_quote has an unsafe source_ref: {source_ref}"
            ));
            continue;
        };
        if !source_path.is_file() {
            report.error(format!(
                "infographic {name} text module '{module_id}' source_quote references missing source: {source_ref}"
            ));
            continue;
        }
        let Ok(source) = read_json(&source_path) else {
            report.error(format!(
                "infographic {name} text module '{module_id}' source_quote source is not valid JSON: {source_ref}"
            ));
            continue;
        };
        let expected_hash = expected_source_hash(&source);
        let recorded_hash = source
            .get("content_hash")
            .and_then(Value::as_str)
            .unwrap_or("");
        report.check(
            !recorded_hash.is_empty() && recorded_hash == expected_hash,
            format!(
                "infographic {name} text module '{module_id}' source_quote source content_hash mismatch: {source_ref}"
            ),
        );
        let source_text = source.get("text").and_then(Value::as_str).unwrap_or("");
        let matched = source_page_text(source_text, page)
            .map(|page_text| {
                let needle = normalize_source_quote_text(quote);
                !needle.is_empty() && normalize_source_quote_text(&page_text).contains(&needle)
            })
            .unwrap_or(false);
        report.check(
            matched,
            format!(
                "infographic {name} text module '{module_id}' source_quote text does not appear verbatim on page {page} of {source_ref}"
            ),
        );
        if let Some(svg) = &desktop_svg {
            report.check(
                svg.contains(&page.to_string()),
                format!(
                    "infographic {name} text module '{module_id}' rendered page does not show the source_quote page number"
                ),
            );
            if plan_is_zh {
                report.check(
                    translation.is_some(),
                    format!(
                        "infographic {name} text module '{module_id}' zh page source_quote is missing its required translation"
                    ),
                );
            }
            if translation.is_some() {
                report.check(
                    svg.contains("译述"),
                    format!(
                        "infographic {name} text module '{module_id}' has a translation but the rendered page has no 译述 label"
                    ),
                );
            }
        } else {
            report.error(format!(
                "infographic {name} text module '{module_id}' has a source_quote but the desktop SVG could not be read to confirm its labels"
            ));
        }
    }
    Ok(())
}

/// Verifies infographics/<page>.json's `illustration_manifest_refs`: each
/// entry must point to a `visualizations/illustrations/<hash>.json`
/// manifest (0.1.0 schematic explainer or 0.2.0 rich_illustration) with
/// schema-appropriate disclosure fields and accessibility/provenance markup
/// baked into its SVG, every claim_id it lists already verified, its own
/// plan/lint present, and at least one passing critic in
/// visualizations/illustrations/critics/ linked by manifest_ref. Ported
/// from scripts/verify_artifact.py's illustration_manifest_refs loop
/// (~911-987) with identical pass/fail semantics.
fn verify_infographic_illustrations(
    root: &Path,
    manifest_ref: &str,
    manifest: &Value,
    verified_claims: &HashSet<String>,
    report: &mut VerificationReport,
) -> Result<()> {
    let illustration_refs_value = manifest.get("illustration_manifest_refs");
    report.check(
        illustration_refs_value.map(Value::is_array).unwrap_or(true),
        format!("infographic {manifest_ref} illustration_manifest_refs must be a list"),
    );
    let empty = Vec::new();
    let refs = illustration_refs_value
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    for item in refs {
        let illustration_ref = item.as_str().unwrap_or("");
        let ok_ref = illustration_ref.starts_with("visualizations/illustrations/");
        report.check(
            ok_ref,
            format!("infographic {manifest_ref} invalid illustration ref: {item}"),
        );
        if !ok_ref {
            continue;
        }
        let illustration_path = match safe_ref(root, illustration_ref) {
            Ok(path) => path,
            Err(error) => {
                report.error(format!(
                    "infographic {manifest_ref} illustration verification failed for {illustration_ref}: {error}"
                ));
                continue;
            }
        };
        report.check(
            illustration_path.is_file(),
            format!("infographic {manifest_ref} missing illustration: {illustration_ref}"),
        );
        if !illustration_path.is_file() {
            continue;
        }
        let illustration = match read_json(&illustration_path) {
            Ok(value) => value,
            Err(error) => {
                report.error(format!(
                    "infographic {manifest_ref} illustration verification failed for {illustration_ref}: {error}"
                ));
                continue;
            }
        };
        let illustration_version = illustration
            .get("schema_version")
            .and_then(Value::as_str)
            .unwrap_or("");
        report.check(
            matches!(illustration_version, "0.1.0" | "0.2.0"),
            format!("illustration {illustration_ref} schema_version mismatch"),
        );
        if illustration_version == "0.1.0" {
            report.check(
                illustration.get("not_to_scale").and_then(Value::as_bool) == Some(true),
                format!("illustration {illustration_ref} must disclose not_to_scale"),
            );
        } else if illustration_version == "0.2.0" {
            report.check(
                illustration.get("kind").and_then(Value::as_str) == Some("rich_illustration"),
                format!("illustration {illustration_ref} 0.2 must declare kind=rich_illustration"),
            );
            let provenance = illustration.get("provenance").and_then(Value::as_object);
            let origin = provenance
                .and_then(|p| p.get("origin"))
                .and_then(Value::as_str)
                .unwrap_or("");
            report.check(
                matches!(origin, "human" | "generative_ai" | "mixed" | "software"),
                format!("illustration {illustration_ref} has invalid origin provenance"),
            );
            report.check(
                provenance
                    .and_then(|p| p.get("digital_source_type"))
                    .and_then(Value::as_str)
                    .map(|value| !value.is_empty())
                    .unwrap_or(false),
                format!("illustration {illustration_ref} missing digital_source_type"),
            );
            report.check(
                provenance
                    .and_then(|p| p.get("disclosure"))
                    .and_then(Value::as_str)
                    .map(|value| !value.is_empty())
                    .unwrap_or(false),
                format!("illustration {illustration_ref} missing disclosure"),
            );
            if matches!(origin, "generative_ai" | "mixed") {
                let has_provider = provenance
                    .and_then(|p| p.get("provider"))
                    .and_then(Value::as_str)
                    .map(|value| !value.is_empty())
                    .unwrap_or(false);
                let has_model = provenance
                    .and_then(|p| p.get("model"))
                    .and_then(Value::as_str)
                    .map(|value| !value.is_empty())
                    .unwrap_or(false);
                report.check(
                    has_provider && has_model,
                    format!("illustration {illustration_ref} missing AI system provenance"),
                );
            }
            if let Some(evidence_refs) = illustration.get("evidence_refs").and_then(Value::as_array)
            {
                for evidence_ref in evidence_refs {
                    let evidence_ref = evidence_ref.as_str().unwrap_or("");
                    let allowed = evidence_ref.starts_with("sources/")
                        || evidence_ref.starts_with("data/")
                        || evidence_ref.starts_with("computations/");
                    let exists = allowed
                        && safe_ref(root, evidence_ref)
                            .map(|path| path.is_file())
                            .unwrap_or(false);
                    report.check(
                        exists,
                        format!(
                            "illustration {illustration_ref} missing evidence ref: {evidence_ref}"
                        ),
                    );
                }
            }
        }
        if let Some(claim_ids) = illustration.get("claim_ids").and_then(Value::as_array) {
            for claim_id in claim_ids {
                let claim_id = claim_id.as_str().unwrap_or_default();
                report.check(
                    verified_claims.contains(claim_id),
                    format!("illustration {illustration_ref} claim_id is not verified: {claim_id}"),
                );
            }
        }
        let variants = illustration.get("variants").and_then(Value::as_object);
        let hashes = illustration.get("hashes").and_then(Value::as_object);
        if let Some(variants) = variants {
            for key in variants.keys() {
                report.check(
                    key == "desktop" || key == "mobile",
                    format!("illustration {illustration_ref} lists an unknown variant: {key}"),
                );
            }
        }
        let has_mobile_variant = variants.map(|v| v.contains_key("mobile")).unwrap_or(false);
        report.check(
            !hashes
                .map(|h| h.contains_key("mobile_sha256"))
                .unwrap_or(false)
                || has_mobile_variant,
            format!(
                "illustration {illustration_ref} has hashes.mobile_sha256 without a mobile variant"
            ),
        );
        for viewport in ["desktop", "mobile"] {
            if viewport == "mobile" && !has_mobile_variant {
                continue;
            }
            let hash_key = format!("{viewport}_sha256");
            let svg_ref = variants
                .and_then(|v| v.get(viewport))
                .and_then(Value::as_str);
            report.check(
                svg_ref
                    .map(|r| r.starts_with("visualizations/illustrations/"))
                    .unwrap_or(false),
                format!("illustration {illustration_ref} invalid {viewport} variant"),
            );
            let Some(svg_ref) = svg_ref else { continue };
            let svg_path = match safe_ref(root, svg_ref) {
                Ok(path) => path,
                Err(error) => {
                    report.error(format!(
                        "illustration {illustration_ref} unsafe {viewport} ref: {error}"
                    ));
                    continue;
                }
            };
            report.check(
                svg_path.is_file(),
                format!("illustration {illustration_ref} missing {viewport} SVG"),
            );
            if !svg_path.is_file() {
                continue;
            }
            let text = fs::read_to_string(&svg_path).unwrap_or_default();
            let expected_tokens: &[&str] = if illustration_version == "0.1.0" {
                &[
                    "<svg",
                    "<title",
                    "<desc",
                    "data-explainer-version=\"0.1.0\"",
                    "SCHEMATIC / NOT TO SCALE",
                ]
            } else {
                &[
                    "<svg",
                    "<title",
                    "<desc",
                    "data-rich-illustration-version=\"0.2.0\"",
                    "data-origin=",
                ]
            };
            report.check(
                expected_tokens.iter().all(|token| text.contains(token)),
                format!(
                    "illustration {illustration_ref} {viewport} lacks provenance/accessibility disclosure"
                ),
            );
            let lower = text.to_ascii_lowercase();
            report.check(
                !lower.contains("<script") && !lower.contains("<foreignobject"),
                format!("illustration {illustration_ref} {viewport} contains active SVG content"),
            );
            let expected_hash = hashes
                .and_then(|h| h.get(hash_key.as_str()))
                .and_then(Value::as_str);
            report.check(
                expected_hash
                    .map(|value| value.len() == 64)
                    .unwrap_or(false),
                format!("illustration {illustration_ref} missing {hash_key}"),
            );
            if let Some(expected_hash) = expected_hash {
                match sha256_file(&svg_path) {
                    Ok(actual) => report.check(
                        actual == expected_hash,
                        format!("illustration {illustration_ref} {viewport} hash mismatch"),
                    ),
                    Err(error) => report.error(format!(
                        "illustration {illustration_ref} failed hashing {viewport} SVG: {error}"
                    )),
                }
            }
        }
        let plan_ref_i = illustration.get("plan_ref").and_then(Value::as_str);
        report.check(
            plan_ref_i
                .map(|r| safe_ref(root, r).map(|p| p.is_file()).unwrap_or(false))
                .unwrap_or(false),
            format!("illustration {illustration_ref} missing plan"),
        );
        let lint_ref_i = illustration.get("lint_ref").and_then(Value::as_str);
        report.check(
            lint_ref_i
                .map(|r| safe_ref(root, r).map(|p| p.is_file()).unwrap_or(false))
                .unwrap_or(false),
            format!("illustration {illustration_ref} missing lint"),
        );

        let critics = find_critics(
            root,
            "visualizations/illustrations/critics",
            illustration_ref,
        )?;
        report.check(
            critics
                .iter()
                .any(|value| value.get("passed").and_then(Value::as_bool) == Some(true)),
            format!("illustration {illustration_ref} has no passing critic"),
        );
    }
    Ok(())
}

/// Verifies infographics/<page>.json's critic gate: at least one linked
/// (by manifest_ref) passing critic in infographics/critics/, the
/// award-informed rubric dimensions on every schema_version
/// critiqueInfographic hands to critiqueAwardOne (1.1.0-1.5.0 - only
/// 1.0.0 uses critiqueLegacyOne, which writes no rubric at all), and -
/// when the manifest declares visual_review_required - a linked passing
/// image-aware vision critic in infographics/vision-critics/ with a
/// verified deterministic foundation and preview-hash binding. Ported from
/// scripts/verify_artifact.py's infographic critic/vision-critic checks
/// (~1027-1079) with identical semantics; the critic's own claimed
/// `passed`/`score`/rubric fields are independently re-checked here, never
/// trusted outright - model output alone cannot grant verification status.
fn verify_infographic_critics(
    root: &Path,
    manifest_ref: &str,
    name: &str,
    manifest: &Value,
    report: &mut VerificationReport,
) -> Result<()> {
    const EXPECTED_RUBRIC: [&str; 10] = [
        "impact_story_focus",
        "engagement",
        "clarity_information_flow",
        "effectiveness",
        "hierarchy",
        "editorial_rhythm",
        "inclusion_accessibility",
        "responsive_execution",
        "craft_geometry",
        "originality_variety",
    ];
    const EXPECTED_VISION_RUBRIC: [&str; 10] = [
        "hierarchy",
        "legibility",
        "composition",
        "visual_coherence",
        "typography",
        "source_legibility",
        "responsive_quality",
        "illustration_integration",
        "color_contrast",
        "editorial_distinctiveness",
    ];

    let schema_version = manifest
        .get("schema_version")
        .and_then(Value::as_str)
        .unwrap_or("");

    let critics = find_critics(root, "infographics/critics", manifest_ref)?;
    report.check(
        !critics.is_empty(),
        format!("infographic {name} has no critic artifact"),
    );
    let passing_critics: Vec<&Value> = critics
        .iter()
        .filter(|critic| critic.get("passed").and_then(Value::as_bool) == Some(true))
        .collect();
    report.check(
        !passing_critics.is_empty(),
        format!("infographic {name} has no passing critic"),
    );
    // infographic.mjs's critiqueInfographic dispatches on this exact set
    // (["1.1.0","1.2.0","1.3.0","1.4.0","1.5.0"].includes(spec.schema_version),
    // infographic.mjs:1214): every one of these versions - not just
    // 1.1.0/1.2.0 - gets critiqueAwardOne's full rubric object; only
    // 1.0.0 falls back to critiqueLegacyOne, whose returned critique has
    // no rubric field at all.
    if matches!(
        schema_version,
        "1.1.0" | "1.2.0" | "1.3.0" | "1.4.0" | "1.5.0"
    ) {
        if let Some(first) = passing_critics.first() {
            let has_all_dimensions = first
                .get("rubric")
                .and_then(Value::as_object)
                .map(|rubric| EXPECTED_RUBRIC.iter().all(|key| rubric.contains_key(*key)))
                .unwrap_or(false);
            report.check(
                has_all_dimensions,
                format!("infographic {name} critic missing award-informed rubric dimensions"),
            );
        }
    }

    if manifest
        .get("visual_review_required")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Ok(());
    }

    let vision_critics = find_critics(root, "infographics/vision-critics", manifest_ref)?;
    report.check(
        !vision_critics.is_empty(),
        format!("infographic {name} requires image-aware vision critic"),
    );
    let passing_vision: Vec<&Value> = vision_critics
        .iter()
        .filter(|critic| critic.get("passed").and_then(Value::as_bool) == Some(true))
        .collect();
    report.check(
        !passing_vision.is_empty(),
        format!("infographic {name} has no passing image-aware vision critic"),
    );
    let Some(vision) = passing_vision.first() else {
        return Ok(());
    };

    report.check(
        matches!(
            vision.get("schema_version").and_then(Value::as_str),
            Some("0.1.0" | "0.2.0")
        ) && vision.get("kind").and_then(Value::as_str) == Some("image_aware_model"),
        format!("infographic {name} vision critic schema/kind mismatch"),
    );
    let score = vision.get("score").and_then(Value::as_f64).unwrap_or(0.0);
    report.check(
        score >= 80.0,
        format!("infographic {name} vision critic score below 80"),
    );
    let has_blocker = vision
        .get("issues")
        .and_then(Value::as_array)
        .map(|issues| {
            issues
                .iter()
                .any(|issue| issue.get("severity").and_then(Value::as_str) == Some("blocker"))
        })
        .unwrap_or(false);
    report.check(
        !has_blocker,
        format!("infographic {name} vision critic contains blocker"),
    );
    let vision_rubric_ok = vision
        .get("rubric")
        .and_then(Value::as_object)
        .map(|rubric| {
            EXPECTED_VISION_RUBRIC
                .iter()
                .all(|key| rubric.contains_key(*key))
        })
        .unwrap_or(false);
    report.check(
        vision_rubric_ok,
        format!("infographic {name} vision critic missing rubric dimensions"),
    );

    let deterministic_ref = vision
        .get("deterministic_critic_ref")
        .and_then(Value::as_str);
    let deterministic_path = deterministic_ref.and_then(|r| safe_ref(root, r).ok());
    let deterministic_exists = deterministic_path
        .as_ref()
        .map(|path| path.is_file())
        .unwrap_or(false)
        && deterministic_ref
            .map(|r| r.starts_with("infographics/critics/"))
            .unwrap_or(false);
    report.check(
        deterministic_exists,
        format!("infographic {name} vision critic lacks deterministic foundation"),
    );
    if deterministic_exists {
        if let Some(path) = &deterministic_path {
            match read_json(path) {
                Ok(deterministic) => report.check(
                    deterministic.get("manifest_ref").and_then(Value::as_str) == Some(manifest_ref)
                        && deterministic.get("passed").and_then(Value::as_bool) == Some(true),
                    format!("infographic {name} vision critic deterministic link mismatch"),
                ),
                Err(error) => report.error(format!(
                    "infographic {name} deterministic critic ref invalid: {error}"
                )),
            }
        }
    }

    let preview_ref = vision.get("preview_ref").and_then(Value::as_str);
    let preview_path = preview_ref.and_then(|r| safe_ref(root, r).ok());
    let preview_exists = preview_path
        .as_ref()
        .map(|path| path.is_file())
        .unwrap_or(false)
        && preview_ref
            .map(|r| r.starts_with("infographics/previews/"))
            .unwrap_or(false);
    report.check(
        preview_exists,
        format!("infographic {name} vision preview missing"),
    );
    if !preview_exists {
        return Ok(());
    }
    let preview_path = preview_path.unwrap();
    let preview = match read_json(&preview_path) {
        Ok(value) => value,
        Err(error) => {
            report.error(format!(
                "infographic {name} vision preview verification failed: {error}"
            ));
            return Ok(());
        }
    };
    report.check(
        preview.get("manifest_ref").and_then(Value::as_str) == Some(manifest_ref),
        format!("infographic {name} preview manifest link mismatch"),
    );
    report.check(
        preview.get("source_hashes") == manifest.get("hashes"),
        format!("infographic {name} preview source hashes mismatch"),
    );
    let manifest_variant_keys: HashSet<&str> = manifest
        .get("variants")
        .and_then(Value::as_object)
        .map(|variants| variants.keys().map(String::as_str).collect())
        .unwrap_or_default();
    let preview_variants = preview.get("variants").and_then(Value::as_object);
    let preview_variant_keys: HashSet<&str> = preview_variants
        .map(|variants| variants.keys().map(String::as_str).collect())
        .unwrap_or_default();
    report.check(
        preview_variant_keys == manifest_variant_keys,
        format!("infographic {name} preview variants do not match the page variants"),
    );
    let preview_hashes = preview.get("hashes").and_then(Value::as_object);
    for viewport in ["desktop", "mobile"] {
        if viewport == "mobile" && !manifest_variant_keys.contains("mobile") {
            continue;
        }
        let hash_key = format!("{viewport}_sha256");
        let png_ref = preview_variants
            .and_then(|variants| variants.get(viewport))
            .and_then(Value::as_str);
        report.check(
            png_ref
                .map(|r| r.starts_with("infographics/previews/"))
                .unwrap_or(false),
            format!("infographic {name} preview missing {viewport} PNG ref"),
        );
        let Some(png_ref) = png_ref else { continue };
        match safe_ref(root, png_ref) {
            Ok(png_path) => {
                report.check(
                    png_path.is_file(),
                    format!("infographic {name} preview missing {viewport} PNG"),
                );
                if png_path.is_file() {
                    match fs::read(&png_path) {
                        Ok(data) => {
                            report.check(
                                data.starts_with(b"\x89PNG\r\n\x1a\n"),
                                format!("infographic {name} {viewport} preview is not PNG"),
                            );
                            let expected = preview_hashes
                                .and_then(|hashes| hashes.get(hash_key.as_str()))
                                .and_then(Value::as_str);
                            let hash_ok = match expected {
                                Some(expected) => sha256_file(&png_path)
                                    .map(|actual| actual == expected)
                                    .unwrap_or(false),
                                None => false,
                            };
                            report.check(
                                hash_ok,
                                format!("infographic {name} {viewport} preview hash mismatch"),
                            );
                        }
                        Err(error) => report.error(format!(
                            "infographic {name} failed reading {viewport} preview: {error}"
                        )),
                    }
                }
            }
            Err(error) => report.error(format!(
                "infographic {name} vision preview verification failed: {error}"
            )),
        }
    }
    Ok(())
}

/// Verifies one screenshot or archive_fallback entry a browser-qa.json
/// report lists (`{"path": <bare filename>, "sha256": ...}`, relative to
/// the report's own qa directory - runtime/pi/browser_qa.py writes these
/// with `shot.name`, never a full artifact-root path) actually exists with
/// matching content, exactly like check_render_qa_ref never trusts a
/// report's own claimed status without independently re-hashing what is on
/// disk.
fn verify_qa_screenshot_entry(
    qa_dir: &Path,
    entry: &Value,
    label: &str,
    manifest_ref: &str,
    report: &mut VerificationReport,
) -> bool {
    let path_field = entry.get("path").and_then(Value::as_str).unwrap_or("");
    let expected_sha = entry.get("sha256").and_then(Value::as_str).unwrap_or("");
    let safe_name = !path_field.is_empty()
        && !path_field.contains('/')
        && !path_field.contains('\\')
        && path_field != "."
        && path_field != "..";
    if !safe_name {
        report.error(format!(
            "publication {manifest_ref} browser QA {label} has an invalid path: {path_field}"
        ));
        return false;
    }
    let shot_path = qa_dir.join(path_field);
    if !shot_path.is_file() {
        report.error(format!(
            "publication {manifest_ref} browser QA {label} file is missing: {path_field}"
        ));
        return false;
    }
    match sha256_file(&shot_path) {
        Ok(actual) if !expected_sha.is_empty() && actual == expected_sha => true,
        Ok(_) => {
            report.error(format!(
                "publication {manifest_ref} browser QA {label} sha256 mismatch: {path_field}"
            ));
            false
        }
        Err(error) => {
            report.error(format!(
                "publication {manifest_ref} failed hashing browser QA {label} {path_field}: {error}"
            ));
            false
        }
    }
}

/// Verifies every entry in a browser-qa.json report's `screenshots` list
/// and its `archive_fallback`, if present. Returns false (and records
/// specific errors) if any listed file is missing, unsafe, or does not
/// hash to its own claimed sha256.
fn verify_qa_screenshots(
    qa_dir: &Path,
    qa_report: &Value,
    manifest_ref: &str,
    report: &mut VerificationReport,
) -> bool {
    let mut ok = true;
    if let Some(screenshots) = qa_report.get("screenshots").and_then(Value::as_array) {
        for shot in screenshots {
            if !verify_qa_screenshot_entry(qa_dir, shot, "screenshot", manifest_ref, report) {
                ok = false;
            }
        }
    }
    if let Some(archive) = qa_report
        .get("archive_fallback")
        .filter(|value| !value.is_null())
    {
        if !verify_qa_screenshot_entry(qa_dir, archive, "archive_fallback", manifest_ref, report) {
            ok = false;
        }
    }
    ok
}

/// Verifies publications/<html_sha256>/manifest.json browser-publication
/// manifests (the plans/ and qa/ subdirectories are never iterated as
/// publication instances themselves - they hold the PublicationSpec plans
/// newsroom_publication_plan/newsroom_portable_publication write and the
/// browser_qa.py reports newsroom_publication_qa writes). A publication
/// directory's own name must equal the sha256 of its index.html, exactly
/// like sources/<hash>.json and computations/<hash>.json are
/// content-addressed elsewhere in this verifier, and that hash must also
/// match the manifest's own html_sha256 field. plan_ref must resolve to an
/// existing plan under publications/plans/; every evidence-bound module in
/// that plan must resolve to a file that exists (its own hash chain is
/// independently re-verified elsewhere in this file, e.g. by
/// verify_computations - this only confirms the reference is not
/// dangling). A publication must not verify while its plan's
/// delivery.breakpoints violates the same desktop-only-or-multi-width rule
/// runtime/pi/publication.mjs's validatePublicationSpec enforces - derived
/// here purely from the stored array's own shape, never from an
/// environment variable - or, unless the plan is the explicitly documented
/// self-contained portable_fallback (which the runtime's own tool result
/// states plainly does not run browser QA), while it lacks a passing
/// newsroom_publication_qa browser-qa.json report bound to the same
/// index.html by content hash (browser-qa.json has no plan_ref/manifest_ref
/// field of its own - html_sha256 equality is the only available link, and
/// browser_qa.py's exit code is fully determined by its own status field,
/// so status=="PASS" alone is a sufficient and complete pass signal).
/// Except for the portable/direct sentinel, the plan's infographic_plan_ref
/// must also resolve to a top-level, non-rejected infographic manifest
/// whose own critic and (whenever required) image-aware vision critic have
/// both passed - see verify_publication_infographic_lineage. A plan file
/// existing on disk is not enough: every page ever rendered from it may
/// have been rejected by a critic, moved to infographics/rejected/<key>/,
/// with no top-level manifest left to bind.
fn verify_publications(root: &Path, report: &mut VerificationReport) -> Result<()> {
    let dir = root.join("publications");
    if !dir.is_dir() {
        return Ok(());
    }
    // Sorted so the error list's publication order is deterministic across
    // filesystems, matching Python's sorted(publications_dir.iterdir()).
    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect();
    entries.sort();
    for entry_path in entries {
        if !entry_path.is_dir() {
            continue;
        }
        let dir_name = entry_path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("<publication>")
            .to_owned();
        if dir_name == "plans" || dir_name == "qa" || dir_name == "rejected" {
            // publications/rejected/<k>/ is where a publication whose
            // browser QA FAILed is moved whole (index.html, manifest.json,
            // assets/, a copy of the QA report, rejection.json) - never a
            // top-level publication instance itself, exactly like plans/
            // and qa/ above.
            continue;
        }
        let manifest_path = entry_path.join("manifest.json");
        report.check(
            manifest_path.is_file(),
            format!("publication {dir_name} is missing manifest.json"),
        );
        if !manifest_path.is_file() {
            continue;
        }
        let manifest = read_json(&manifest_path)?;
        let manifest_ref = format!("publications/{dir_name}/manifest.json");

        if manifest.get("kind").and_then(Value::as_str) == Some("lieflat_publication") {
            // runtime/pi/lieflat.mjs's report mode writes
            // publications/<key>/qa.json and
            // infographics/<key>/{plan,lint,critic}.json with passed:true
            // and a fixed score:100 - none of it measured. The generic
            // checks below already fail this manifest (its
            // infographic_plan_ref is not a real plan_ref under
            // publications/plans/, and it has no linked
            // publications/qa/*/browser-qa.json), but call it out by name
            // so the report is unambiguous about why.
            report.error(format!(
                "publication {manifest_ref} is a Lieflat publication (kind=lieflat_publication) whose lint/critic/publication QA are self-issued passed:true/score:100 constants, not measured results"
            ));
        }

        let html_ref = manifest
            .get("html_ref")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut actual_html_sha256: Option<String> = None;
        if html_ref.is_empty() {
            report.error(format!("publication {manifest_ref} missing html_ref"));
        } else {
            match safe_ref(root, html_ref) {
                Ok(html_file_path) => {
                    report.check(
                        html_file_path.is_file(),
                        format!("publication {manifest_ref} missing html: {html_ref}"),
                    );
                    if html_file_path.is_file() {
                        match sha256_file(&html_file_path) {
                            Ok(actual) => {
                                let expected = manifest.get("html_sha256").and_then(Value::as_str);
                                report.check(
                                    expected == Some(actual.as_str()),
                                    format!("publication {manifest_ref} html_sha256 mismatch"),
                                );
                                report.check(
                                    dir_name == actual,
                                    format!(
                                        "publication {manifest_ref} directory is not content-addressed by its own index.html"
                                    ),
                                );
                                actual_html_sha256 = Some(actual);
                            }
                            Err(error) => report.error(format!(
                                "publication {manifest_ref} failed hashing html: {error}"
                            )),
                        }
                    }
                }
                Err(error) => report.error(format!(
                    "publication {manifest_ref} has an unsafe html_ref: {error}"
                )),
            }
        }

        let plan_ref = manifest
            .get("plan_ref")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut plan: Option<Value> = None;
        if !plan_ref.starts_with("publications/plans/") {
            report.error(format!(
                "publication {manifest_ref} plan_ref must be under publications/plans/"
            ));
        } else {
            match safe_ref(root, plan_ref) {
                Ok(plan_file_path) => {
                    report.check(
                        plan_file_path.is_file(),
                        format!("publication {manifest_ref} missing plan: {plan_ref}"),
                    );
                    if plan_file_path.is_file() {
                        match read_json(&plan_file_path) {
                            Ok(value) => plan = Some(value),
                            Err(error) => report.error(format!(
                                "publication {manifest_ref} plan is not valid JSON: {error}"
                            )),
                        }
                    }
                }
                Err(error) => report.error(format!(
                    "publication {manifest_ref} has an unsafe plan_ref: {error}"
                )),
            }
        }

        if let Some(plan) = &plan {
            let breakpoints = plan
                .get("delivery")
                .and_then(|delivery| delivery.get("breakpoints"))
                .and_then(Value::as_array);
            let breakpoints_ok = match breakpoints {
                Some(values) if values.len() == 1 => values[0].as_f64() == Some(1440.0),
                Some(values) => values.len() >= 2,
                None => false,
            };
            report.check(
                breakpoints_ok,
                format!(
                    "publication {manifest_ref} plan delivery.breakpoints must be exactly [1440] or at least two widths"
                ),
            );

            // newsroom_portable_publication writes the literal sentinel
            // "portable/direct" here instead of a real infographic plan
            // ref, since the portable path never goes through
            // newsroom_infographic_plan - only require this to resolve to
            // an actual file outside that documented exemption.
            let infographic_plan_ref = plan
                .get("infographic_plan_ref")
                .and_then(Value::as_str)
                .unwrap_or("");
            if infographic_plan_ref != "portable/direct" {
                let infographic_plan_ok = infographic_plan_ref.starts_with("infographics/plans/")
                    && safe_ref(root, infographic_plan_ref)
                        .map(|path| path.is_file())
                        .unwrap_or(false);
                report.check(
                    infographic_plan_ok,
                    format!(
                        "publication {manifest_ref} missing upstream infographic plan: {infographic_plan_ref}"
                    ),
                );
                if infographic_plan_ok {
                    verify_publication_infographic_lineage(
                        root,
                        &manifest_ref,
                        infographic_plan_ref,
                        report,
                    )?;
                }
            }

            if let Some(modules) = plan.get("modules").and_then(Value::as_array) {
                for module in modules {
                    let Some(binding) = module.get("evidence_binding") else {
                        continue;
                    };
                    let kind = binding.get("kind").and_then(Value::as_str).unwrap_or("");
                    let module_ref = binding.get("ref").and_then(Value::as_str).unwrap_or("");
                    let prefix = match kind {
                        "computation" => "computations/",
                        "analysis" => "visualizations/graph-analysis/",
                        "map" => "maps/",
                        "model" => "models/",
                        "asset" => "visualizations/",
                        _ => "",
                    };
                    let exists = !prefix.is_empty()
                        && module_ref.starts_with(prefix)
                        && safe_ref(root, module_ref)
                            .map(|path| path.is_file())
                            .unwrap_or(false);
                    report.check(
                        exists,
                        format!(
                            "publication {manifest_ref} module evidence_binding is missing or invalid: {module_ref}"
                        ),
                    );
                }
            }
        }

        // A portable_fallback publication is still evidence-bound, but its
        // own tool result says plainly "this does not replace browser QA" -
        // it needs a linked passing browser-qa.json exactly like any other
        // publication, not an exemption.
        let Some(actual_html_sha256) = actual_html_sha256 else {
            continue;
        };
        // Every linked report must independently verify - not just the
        // first one iteration happens to reach. read_dir's order is
        // filesystem-dependent, so a stale FAIL and a later PASS for the
        // same html would otherwise give an order-dependent verdict;
        // walking in sorted order and requiring all of them to pass makes
        // the result deterministic. The runtime now moves a FAILed
        // publication's whole directory out of the top level
        // (publications/rejected/<k>/, skipped above), so a genuine
        // top-level publication should never have a linked FAIL report in
        // the first place - if one is still linked here, that is itself a
        // fail-closed signal, not something to average away.
        let qa_dir = dir.join("qa");
        let mut linked = false;
        let mut passing = true;
        if qa_dir.is_dir() {
            let mut qa_entries: Vec<PathBuf> = fs::read_dir(&qa_dir)?
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .collect();
            qa_entries.sort();
            for qa_key_dir in qa_entries {
                let report_path = qa_key_dir.join("browser-qa.json");
                if !report_path.is_file() {
                    continue;
                }
                let Ok(qa_report) = read_json(&report_path) else {
                    continue;
                };
                if qa_report.get("html_sha256").and_then(Value::as_str)
                    == Some(actual_html_sha256.as_str())
                {
                    linked = true;
                    let status_ok = qa_report.get("status").and_then(Value::as_str) == Some("PASS");
                    let screenshots_ok =
                        verify_qa_screenshots(&qa_key_dir, &qa_report, &manifest_ref, report);
                    if !(status_ok && screenshots_ok) {
                        passing = false;
                    }
                }
            }
        }
        report.check(
            linked,
            format!("publication {manifest_ref} has no linked browser QA report"),
        );
        report.check(
            linked && passing,
            format!("publication {manifest_ref} has no passing browser QA report"),
        );
    }
    Ok(())
}

/// The gate this worktree adds: a top-level publication's
/// infographic_plan_ref (already confirmed by the caller to resolve to an
/// existing infographics/plans/*.json file) must be the plan_ref of a
/// top-level, non-rejected infographics/<key>.json manifest - scanned
/// exactly like verify_infographics's own loop, so infographics/plans,
/// critics, vision-critics, previews, revisions, qa and rejected are never
/// candidates - and that manifest's critic and, whenever it declares
/// visual_review_required (currently unconditional on every rendered page -
/// see newsroom_infographic_render), image-aware vision critic must both be
/// linked by manifest_ref and passed:true, using find_critics's own linking
/// rule rather than a new one. A plan whose only rendered page was moved to
/// infographics/rejected/<key>/ after either critic failed has no match
/// here at all - the same "no approved lineage exists" signal as a plan
/// that was never rendered. Entries are walked in sorted order and the
/// first match wins, so the result is deterministic even if more than one
/// top-level manifest was ever rendered from the same plan_ref.
fn verify_publication_infographic_lineage(
    root: &Path,
    manifest_ref: &str,
    infographic_plan_ref: &str,
    report: &mut VerificationReport,
) -> Result<()> {
    let dir = root.join("infographics");
    let mut found: Option<(String, Value)> = None;
    if dir.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(&dir)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect();
        entries.sort();
        for path in entries {
            if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let Ok(candidate) = read_json(&path) else {
                continue;
            };
            if candidate.get("plan_ref").and_then(Value::as_str) == Some(infographic_plan_ref) {
                let candidate_ref = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                found = Some((candidate_ref, candidate));
                break;
            }
        }
    }
    let Some((infographic_ref, infographic_manifest)) = found else {
        report.error(format!(
            "publication {manifest_ref} upstream infographic plan {infographic_plan_ref} has no top-level, non-rejected infographic manifest bound to it"
        ));
        return Ok(());
    };
    let critics = find_critics(root, "infographics/critics", &infographic_ref)?;
    let has_passing_critic = critics
        .iter()
        .any(|critic| critic.get("passed").and_then(Value::as_bool) == Some(true));
    report.check(
        has_passing_critic,
        format!(
            "publication {manifest_ref} upstream infographic {infographic_ref} has no passing critic"
        ),
    );
    if infographic_manifest
        .get("visual_review_required")
        .and_then(Value::as_bool)
        == Some(true)
    {
        let vision_critics = find_critics(root, "infographics/vision-critics", &infographic_ref)?;
        let has_passing_vision = vision_critics
            .iter()
            .any(|critic| critic.get("passed").and_then(Value::as_bool) == Some(true));
        report.check(
            has_passing_vision,
            format!(
                "publication {manifest_ref} upstream infographic {infographic_ref} has no passing image-aware vision critic"
            ),
        );
    }
    Ok(())
}

/// Verifies story.json's delivery.primary_artifact, when set, is the
/// output of a top-level manifest rather than an orphan file or one moved
/// out of the top level (publications/rejected/<k>/, publications/qa/*/,
/// or a bare SVG/PNG nobody's manifest references). A missing or null
/// primary_artifact is not checked at all - this only binds it when the
/// newsroom actually declares one. Two backing forms are accepted:
/// publications/<k>/index.html (k not one of the reserved directory
/// names) with a sibling publications/<k>/manifest.json whose own
/// html_ref field equals it exactly - verify_publications independently
/// re-verifies that whole manifest's hash chain and QA elsewhere, this
/// only confirms the declared path is not dangling; or an SVG referenced
/// by the variants or svg field of a top-level infographics/*.json or
/// visualizations/*.json manifest (verify_infographics/verify_visualizations
/// independently re-verify that manifest itself elsewhere).
fn verify_delivered_artifact(
    root: &Path,
    story: &Value,
    report: &mut VerificationReport,
) -> Result<()> {
    let primary_field = story
        .get("delivery")
        .and_then(|delivery| delivery.get("primary_artifact"));
    let is_set = primary_field.map(|value| !value.is_null()).unwrap_or(false);
    if !is_set {
        return Ok(());
    }
    let primary = primary_field.and_then(Value::as_str).unwrap_or("");

    let mut bound = false;
    let parts: Vec<&str> = primary.split('/').collect();
    if parts.len() == 3
        && parts[0] == "publications"
        && parts[2] == "index.html"
        && !matches!(parts[1], "plans" | "qa" | "rejected")
    {
        let manifest_path = root
            .join("publications")
            .join(parts[1])
            .join("manifest.json");
        if manifest_path.is_file() {
            if let Ok(manifest) = read_json(&manifest_path) {
                bound = manifest.get("html_ref").and_then(Value::as_str) == Some(primary);
            }
        }
    } else {
        'search: for sub in ["infographics", "visualizations"] {
            let dir = root.join(sub);
            if !dir.is_dir() {
                continue;
            }
            for entry in fs::read_dir(&dir)? {
                let path = entry?.path();
                if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("json") {
                    continue;
                }
                let Ok(manifest) = read_json(&path) else {
                    continue;
                };
                let svg_match = manifest.get("svg").and_then(Value::as_str) == Some(primary);
                let variant_match = manifest
                    .get("variants")
                    .and_then(Value::as_object)
                    .map(|variants| {
                        variants
                            .values()
                            .any(|value| value.as_str() == Some(primary))
                    })
                    .unwrap_or(false);
                if svg_match || variant_match {
                    bound = true;
                    break 'search;
                }
            }
        }
    }

    report.check(
        bound,
        format!("delivered artifact {primary} is not backed by a verified manifest"),
    );
    Ok(())
}

/// Finds every `<critics_dir>/*.json` critic artifact whose own
/// `manifest_ref` field equals `manifest_ref` exactly (the same relative
/// path a caller would pass to `readArtifactJson` in the Pi runtime, e.g.
/// `visualizations/x.json` or `infographics/x.json`). Reused for
/// visualizations/critics, infographics/critics, infographics/vision-critics
/// and visualizations/illustrations/critics - the shape and matching rule
/// are identical, only the directory and linked manifest kind differ.
fn find_critics(root: &Path, critics_dir: &str, manifest_ref: &str) -> Result<Vec<Value>> {
    let dir = root.join(critics_dir);
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|v| v.to_str()) == Some("json") {
            let value = read_json(&path)?;
            if value.get("manifest_ref").and_then(Value::as_str) == Some(manifest_ref) {
                out.push(value);
            }
        }
    }
    Ok(out)
}

fn verified_claim_ids(root: &Path) -> Result<HashSet<String>> {
    let mut ids = HashSet::new();
    let path = root.join("claims.jsonl");
    if !path.is_file() {
        return Ok(ids);
    }
    for line in BufReader::new(fs::File::open(path)?).lines() {
        let value: Value = match serde_json::from_str(&line?) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if is_system_verified_claim(&value) {
            if let Some(id) = value.get("claim_id").and_then(Value::as_str) {
                ids.insert(id.to_owned());
            }
        }
    }
    Ok(ids)
}

fn is_system_verified_claim(value: &Value) -> bool {
    let verification = match value.get("verification") {
        Some(value) => value,
        None => return false,
    };
    value.get("status").and_then(Value::as_str) == Some("verified")
        && verification.get("authority").and_then(Value::as_str) == Some("system")
        && verification.get("rule_id").and_then(Value::as_str)
            == Some("verification.source+extraction+computation+claim.v1")
        && [
            "source_resolved",
            "extraction_passed",
            "computation_replayed",
            "claim_supported",
            "publishable",
        ]
        .iter()
        .all(|key| verification.get(key).and_then(Value::as_bool) == Some(true))
}

fn safe_ref(root: &Path, reference: &str) -> Result<PathBuf> {
    let rel = Path::new(reference);
    if rel.is_absolute() || reference.is_empty() {
        bail!("reference must be a non-empty relative path");
    }
    for component in rel.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            bail!("reference escapes artifact root");
        }
    }
    Ok(root.join(rel))
}

fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(_) | Value::String(_) => serde_json::to_string(value).unwrap_or_default(),
        Value::Number(number) => canonical_number(number),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            let body = sorted
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
    }
}

/// Canonical wire form for computation rows. JavaScript/V8, serde_json and
/// Python can choose different decimal spellings and halfway rounding for the
/// same IEEE-754 value. Hashing non-integral values as six-decimal strings,
/// rounded explicitly half-away-from-zero, keeps the evidence hash stable
/// across those runtimes while preserving the precision used by the newsroom
/// data contracts.
fn canonical_rows_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(_) | Value::String(_) => serde_json::to_string(value).unwrap_or_default(),
        Value::Number(number) => canonical_row_number(number),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_rows_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            let body = sorted
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_rows_json(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
    }
}

fn canonical_row_number(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_f64() {
        const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
        if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
            return (value as i64).to_string();
        }
        if value.is_finite() {
            let magnitude = (value.abs() * 1_000_000.0 + 0.5).floor();
            if magnitude.is_finite() && magnitude <= MAX_SAFE_INTEGER {
                let scaled = magnitude as u64;
                let sign = if value.is_sign_negative() { "-" } else { "" };
                let whole = scaled / 1_000_000;
                let fraction = scaled % 1_000_000;
                return serde_json::to_string(&format!("{sign}{whole}.{fraction:06}"))
                    .unwrap_or_default();
            }
            return serde_json::to_string(&format!("{value:.6}")).unwrap_or_default();
        }
    }
    number.to_string()
}

/// DuckDB's JSON output may spell an integral CSV coordinate as `35.0` while
/// the original tool response stores the same value as `35`. Normalize only
/// exactly representable, safe integral floats; retain the original JSON
/// spelling for fractional or large values so evidence hashes stay precise.
fn canonical_number(number: &serde_json::Number) -> String {
    if number.is_f64() {
        if let Some(value) = number.as_f64() {
            const MAX_EXACT_INTEGER: f64 = 9_007_199_254_740_991.0;
            if value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_EXACT_INTEGER {
                return (value as i64).to_string();
            }
        }
    }
    number.to_string()
}

struct RecomputeScratch {
    path: PathBuf,
}

impl RecomputeScratch {
    fn new() -> Result<Self> {
        let path =
            std::env::temp_dir().join(format!("newsroom-recompute-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path)
            .with_context(|| format!("failed to create recompute scratch {}", path.display()))?;
        Ok(Self { path })
    }
}

impl Drop for RecomputeScratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn valid_computation_row_ref(reference: &str) -> bool {
    let Some(name) = reference.strip_prefix("computations/") else {
        return false;
    };
    let Some(hash) = name.strip_suffix(".json") else {
        return false;
    };
    !hash.contains('/') && hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn computation_row_refs(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut refs = Vec::new();
    let mut index = 0usize;

    while index < bytes.len() {
        let quote = bytes[index];
        if quote != b'\'' && quote != b'"' {
            index += 1;
            continue;
        }

        let start = index + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end] != quote {
            end += 1;
        }
        if end >= bytes.len() {
            break;
        }

        let candidate = &sql[start..end];
        if valid_computation_row_ref(candidate) {
            refs.push(candidate.to_owned());
        }
        index = end + 1;
    }

    refs.sort();
    refs.dedup();
    refs
}

fn materialize_recompute_rows(root: &Path, sql: &str, scratch: &Path) -> Result<String> {
    let mut rewritten = sql.to_owned();

    for reference in computation_row_refs(sql) {
        let path = safe_ref(root, &reference)?;
        let computation = read_json(&path)
            .with_context(|| format!("failed reading chained computation {reference}"))?;
        let rows = computation
            .get("rows")
            .and_then(Value::as_array)
            .with_context(|| format!("chained computation {reference} does not contain rows"))?;

        let filename = Path::new(&reference)
            .file_name()
            .and_then(|value| value.to_str())
            .context("invalid chained computation filename")?;
        let rows_path = scratch.join(filename);

        fs::write(&rows_path, format!("{}\n", serde_json::to_string(rows)?)).with_context(
            || {
                format!(
                    "failed writing recompute row projection {}",
                    rows_path.display()
                )
            },
        )?;

        let normalized = rows_path.to_string_lossy().replace('\\', "/");
        let single_quoted = normalized.replace('\'', "''");
        let double_quoted = normalized.replace('"', "\"\"");

        rewritten = rewritten
            .replace(&format!("'{reference}'"), &format!("'{single_quoted}'"))
            .replace(&format!("\"{reference}\""), &format!("\"{double_quoted}\""));
    }

    Ok(rewritten)
}

#[derive(Debug, Default, Serialize)]
pub struct RecomputeReport {
    pub passed: bool,
    pub checks: usize,
    pub errors: Vec<String>,
    pub duration_ms: u128,
}

impl RecomputeReport {
    fn check(&mut self, condition: bool, message: impl Into<String>) {
        self.checks += 1;
        if !condition {
            self.errors.push(message.into());
        }
    }
}

pub async fn recompute_artifact(
    root: &Path,
    duckdb_bin: &Path,
    timeout_seconds: u64,
) -> Result<RecomputeReport> {
    use std::time::Instant;
    use tokio::process::Command;
    use tokio::time::{timeout, Duration};

    if !root.is_dir() {
        bail!("artifact directory does not exist: {}", root.display());
    }
    // DuckDB runs with the artifact as its working directory and resolves the
    // allowed_directories entries below against it, so a relative root such
    // as `news verify .newsroom/x` would allow `.newsroom/x/.newsroom/x/data`
    // and reject every stored query. Pin the root to an absolute path first,
    // as resolve_output_dir does for --out.
    let root = std::path::absolute(root)
        .with_context(|| format!("failed to resolve artifact directory {}", root.display()))?;
    let root = root.as_path();
    let started = Instant::now();
    let mut report = RecomputeReport::default();
    let dir = root.join("computations");
    let mut computations = Vec::new();
    if dir.is_dir() {
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                computations.push(path);
            }
        }
    }
    computations.sort();
    report.check(
        !computations.is_empty(),
        "recompute requires at least one stored computation",
    );

    let data_dir = root.join("data").to_string_lossy().replace('\'', "''");
    let source_dir = root.join("sources").to_string_lossy().replace('\'', "''");
    let scratch = RecomputeScratch::new()?;
    let scratch_dir = scratch.path.to_string_lossy().replace('\'', "''");

    for path in computations {
        let value = read_json(&path)?;
        let sql = match value.get("sql").and_then(Value::as_str) {
            Some(sql) => match validate_read_only_sql(sql) {
                Ok(sql) => sql,
                Err(error) => {
                    report.check(
                        false,
                        format!("recompute blocked {}: {error}", path.display()),
                    );
                    continue;
                }
            },
            None => {
                report.check(false, format!("recompute missing SQL: {}", path.display()));
                continue;
            }
        };
        let sql = match materialize_recompute_rows(root, &sql, &scratch.path) {
            Ok(sql) => sql,
            Err(error) => {
                report.check(
                    false,
                    format!(
                        "recompute could not materialize chained computation rows for {}: {error}",
                        path.display()
                    ),
                );
                continue;
            }
        };

        let stored_rows = match value.get("rows").and_then(Value::as_array) {
            Some(_) => value.get("rows").cloned().unwrap_or(Value::Array(vec![])),
            None => {
                report.check(false, format!("recompute missing rows: {}", path.display()));
                continue;
            }
        };

        let computation_dir = root
            .join("computations")
            .to_string_lossy()
            .replace('\'', "''");
        let allowed_dirs = format!(
            "SET allowed_directories = ['{data_dir}', '{source_dir}', '{computation_dir}', '{scratch_dir}']"
        );
        let mut command = Command::new(duckdb_bin);
        command
            .current_dir(root)
            .kill_on_drop(true)
            .arg("-json")
            .arg(":memory:")
            .arg("-cmd")
            .arg(&allowed_dirs)
            .arg("-cmd")
            .arg("SET enable_external_access = false")
            .arg("-cmd")
            .arg("SET allow_community_extensions = false")
            .arg("-cmd")
            .arg("SET memory_limit = '512MB'")
            .arg("-cmd")
            .arg("SET threads = 2")
            .arg("-cmd")
            .arg("SET lock_configuration = true")
            .arg("-c")
            .arg(&sql);

        let output = match timeout(Duration::from_secs(timeout_seconds), command.output()).await {
            Ok(result) => match result {
                Ok(output) => output,
                Err(error) => {
                    report.check(
                        false,
                        format!("failed to execute DuckDB for {}: {error}", path.display()),
                    );
                    continue;
                }
            },
            Err(_) => {
                report.check(
                    false,
                    format!(
                        "recompute timed out after {timeout_seconds}s: {}",
                        path.display()
                    ),
                );
                continue;
            }
        };

        if !output.status.success() {
            report.check(
                false,
                format!(
                    "DuckDB recompute failed for {}: {}",
                    path.display(),
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            );
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let actual_rows: Value = if text.is_empty() {
            Value::Array(vec![])
        } else {
            match serde_json::from_str::<Value>(&text) {
                Ok(Value::Array(rows)) => Value::Array(rows),
                Ok(other) => Value::Array(vec![other]),
                Err(error) => {
                    report.check(
                        false,
                        format!(
                            "DuckDB returned invalid JSON for {}: {error}",
                            path.display()
                        ),
                    );
                    continue;
                }
            }
        };
        report.check(
            canonical_rows_json(&actual_rows) == canonical_rows_json(&stored_rows),
            format!("recompute rows mismatch: {}", path.display()),
        );
        if let Some(expected) = value.get("result_hash").and_then(Value::as_str) {
            let actual = sha256_bytes(canonical_rows_json(&actual_rows).as_bytes());
            report.check(
                actual == expected,
                format!("recompute result_hash mismatch: {}", path.display()),
            );
        } else {
            report.check(
                false,
                format!("recompute result_hash missing: {}", path.display()),
            );
        }
    }

    report.duration_ms = started.elapsed().as_millis();
    report.passed = report.errors.is_empty();
    Ok(report)
}

fn validate_read_only_sql(sql: &str) -> Result<String> {
    let cleaned = sql.trim().trim_end_matches(';').trim().to_owned();
    if cleaned.is_empty() || cleaned.contains(';') {
        bail!("only one non-empty SQL statement is allowed");
    }
    let lower = cleaned.to_ascii_lowercase();
    let first = lower.split_whitespace().next().unwrap_or("");
    if !matches!(
        first,
        "select" | "with" | "describe" | "summarize" | "from" | "explain"
    ) {
        bail!("only read-only analytical SQL is allowed");
    }
    let forbidden = [
        "install", "load", "copy", "export", "import", "attach", "detach", "create", "drop",
        "delete", "update", "insert", "alter", "call", "pragma", "set",
    ];
    let tokens: HashSet<&str> = lower
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
        .filter(|token| !token.is_empty())
        .collect();
    if forbidden.iter().any(|word| tokens.contains(word)) {
        bail!("mutating or extension-loading SQL is blocked");
    }
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_object_keys() {
        let value: Value = serde_json::from_str(r#"[{"b":2,"a":1}]"#).unwrap();
        assert_eq!(canonical_json(&value), r#"[{"a":1,"b":2}]"#);
    }

    #[test]
    fn safe_ref_allows_normal_relative_paths() {
        let root = Path::new("/tmp/root");

        // 正常相对路径应该通过
        assert!(safe_ref(root, "data/file.json").is_ok());
        assert!(safe_ref(root, "evidence/report.txt").is_ok());
        assert!(safe_ref(root, "nested/deep/path/file.md").is_ok());
    }

    #[test]
    fn safe_ref_prevents_path_traversal() {
        let root = Path::new("/tmp/root");

        // 路径遍历应该失败
        assert!(safe_ref(root, "../etc/passwd").is_err());
        assert!(safe_ref(root, "data/../../etc/passwd").is_err());
        assert!(safe_ref(root, "./data/../../../secrets").is_err());
    }

    #[test]
    fn safe_ref_rejects_absolute_paths() {
        let root = Path::new("/tmp/root");

        // 绝对路径应该失败
        assert!(safe_ref(root, "/etc/passwd").is_err());
        assert!(safe_ref(root, "/var/log/system.log").is_err());
    }

    #[test]
    fn safe_ref_rejects_empty_paths() {
        let root = Path::new("/tmp/root");

        // 空路径应该失败
        assert!(safe_ref(root, "").is_err());
    }

    #[test]
    fn canonical_json_handles_nested_objects() {
        let value: Value =
            serde_json::from_str(r#"{"z": {"b": 2, "a": 1}, "a": [{"d": 4, "c": 3}]}"#).unwrap();
        assert_eq!(
            canonical_json(&value),
            r#"{"a":[{"c":3,"d":4}],"z":{"a":1,"b":2}}"#
        );
    }

    #[test]
    fn canonical_json_preserves_numbers_and_booleans() {
        let value: Value =
            serde_json::from_str(r#"{"num": 42, "float": 3.14, "bool": true, "null": null}"#)
                .unwrap();
        assert_eq!(
            canonical_json(&value),
            r#"{"bool":true,"float":3.14,"null":null,"num":42}"#
        );
    }

    #[test]
    fn canonical_json_normalizes_integral_float_spelling() {
        let integer: Value = serde_json::from_str("35").unwrap();
        let float: Value = serde_json::from_str("35.0").unwrap();
        assert_eq!(canonical_json(&integer), canonical_json(&float));
        let fractional: Value = serde_json::from_str("35.25").unwrap();
        assert_ne!(canonical_json(&integer), canonical_json(&fractional));
    }

    #[test]
    fn canonical_rows_uses_cross_runtime_float_wire_form() {
        let value: Value = serde_json::from_str(
            r#"[{"b":15208319.706770007,"a":35.0,"c":-0.28029356075421674,"half":23747.0703125}]"#,
        )
        .unwrap();
        assert_eq!(
            canonical_rows_json(&value),
            r#"[{"a":35,"b":"15208319.706770","c":"-0.280294","half":"23747.070313"}]"#
        );
    }

    #[test]
    fn recompute_materializes_chained_computation_rows_without_mutating_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("computations")).unwrap();

        let hash = "a".repeat(64);
        let reference = format!("computations/{hash}.json");
        let upstream_rows = serde_json::json!([
            {"label": "A", "value": 10},
            {"label": "B", "value": 20}
        ]);
        fs::write(
            root.join(&reference),
            format!(
                "{}\n",
                serde_json::to_string(&serde_json::json!({
                    "schema_version": "0.7.0",
                    "rows": upstream_rows
                }))
                .unwrap()
            ),
        )
        .unwrap();

        let scratch = RecomputeScratch::new().unwrap();
        let sql = format!("SELECT label, value FROM '{reference}' ORDER BY label");
        let rewritten = materialize_recompute_rows(root, &sql, &scratch.path).unwrap();

        assert!(!rewritten.contains(&format!("'{reference}'")));

        let projected = read_json(&scratch.path.join(format!("{hash}.json"))).unwrap();
        assert_eq!(
            projected,
            serde_json::json!([
                {"label": "A", "value": 10},
                {"label": "B", "value": 20}
            ])
        );

        assert!(
            !root.join("runtime/query-rows").exists(),
            "recompute must not mutate artifact runtime sidecars"
        );
    }

    #[test]
    fn verification_report_tracks_errors() {
        let mut report = VerificationReport::default();

        assert_eq!(report.checks, 0);
        assert_eq!(report.errors.len(), 0);

        report.check(true, "should pass");
        assert_eq!(report.checks, 1);
        assert_eq!(report.errors.len(), 0);

        report.check(false, "should fail");
        assert_eq!(report.checks, 2);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0], "should fail");

        report.error("explicit error");
        assert_eq!(report.checks, 3);
        assert_eq!(report.errors.len(), 2);
        assert_eq!(report.errors[1], "explicit error");
    }

    #[test]
    fn safe_ref_constructs_correct_path() {
        let root = Path::new("/tmp/root");

        let result = safe_ref(root, "data/file.json").unwrap();
        assert_eq!(result, Path::new("/tmp/root/data/file.json"));

        let result = safe_ref(root, "nested/deep/file.txt").unwrap();
        assert_eq!(result, Path::new("/tmp/root/nested/deep/file.txt"));
    }

    // -----------------------------------------------------------------
    // render QA gate: verify_visualizations / verify_infographics
    // -----------------------------------------------------------------

    fn render_qa_svg(label: &str) -> String {
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 200 100\"><title>Fixture</title><desc>Fixture chart for verify.rs render QA regression tests, padded so it clears the minimum accessible-SVG length check used elsewhere in this module.</desc><text x=\"10\" y=\"50\">{label}</text></svg>"
        )
    }

    fn write_verified_claim(root: &Path, claim_id: &str) {
        let claim = serde_json::json!({
            "schema_version": "0.8.0",
            "claim_id": claim_id,
            "status": "verified",
            "verification": {
                "authority": "system",
                "source_resolved": true,
                "extraction_passed": true,
                "computation_replayed": true,
                "claim_supported": true,
                "publishable": true,
                "rule_id": "verification.source+extraction+computation+claim.v1",
            },
            "source_refs": ["sources/x.json"],
            "computation_refs": ["computations/x.json"],
        });
        fs::write(
            root.join("claims.jsonl"),
            format!("{}\n", serde_json::to_string(&claim).unwrap()),
        )
        .unwrap();
    }

    fn render_qa_report_json(desktop_sha: &str, mobile_sha: &str, passed: bool) -> Value {
        let viewport = |sha: &str, passed: bool| {
            serde_json::json!({
                "svg_sha256": sha,
                "passed": passed,
                "geometry": {"passed": true, "failures": [], "notes": [], "summary": {}},
                "contrast": {
                    "passed": passed,
                    "failures": if passed { vec![] } else { vec![serde_json::json!({"rule": "text_contrast", "message": "fixture failure"})] },
                    "unmeasured": [],
                },
            })
        };
        serde_json::json!({
            "schema_version": RENDER_QA_REPORT_SCHEMA_VERSION,
            "geometry_check_version": "0.1.0",
            "contrast_check_version": "1.0.0",
            "passed": passed,
            "failure_count": if passed { 0 } else { 1 },
            "viewports": {
                "desktop": viewport(desktop_sha, passed),
                "mobile": viewport(mobile_sha, true),
            },
        })
    }

    /// Builds a minimal, valid (non-draft, claim-verified) visualization
    /// fixture under a fresh temp root. Returns the temp dir (kept alive by
    /// the caller) and the root path.
    fn build_viz_fixture(qa_passed: bool, include_qa_ref: bool) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let claim_id = "claim-render-qa-fixture";
        write_verified_claim(root, claim_id);

        for dir in [
            "visualizations/plans",
            "visualizations/lints",
            "visualizations/critics",
            "visualizations/qa",
            "computations",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let plan_ref = "visualizations/plans/x.json";
        let lint_ref = "visualizations/lints/x.json";
        let comp_ref = "computations/x.json";
        fs::write(root.join(plan_ref), "{}").unwrap();
        fs::write(
            root.join(comp_ref),
            serde_json::to_string(&serde_json::json!({"rows": []})).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(lint_ref),
            serde_json::to_string(&serde_json::json!({
                "passed": true, "plan_ref": plan_ref, "computation_ref": comp_ref, "data_hash": "h",
            }))
            .unwrap(),
        )
        .unwrap();

        let desktop_svg = render_qa_svg("desktop");
        let mobile_svg = render_qa_svg("mobile");
        fs::write(root.join("visualizations/x.svg"), &desktop_svg).unwrap();
        fs::write(root.join("visualizations/x.mobile.svg"), &mobile_svg).unwrap();
        let desktop_sha = sha256_bytes(desktop_svg.as_bytes());
        let mobile_sha = sha256_bytes(mobile_svg.as_bytes());

        let qa_ref = "visualizations/qa/x.json".to_owned();
        if include_qa_ref {
            fs::write(
                root.join(&qa_ref),
                serde_json::to_string(&render_qa_report_json(&desktop_sha, &mobile_sha, qa_passed))
                    .unwrap(),
            )
            .unwrap();
        }

        fs::write(
            root.join("visualizations/critics/x.json"),
            serde_json::to_string(
                &serde_json::json!({"passed": true, "manifest_ref": "visualizations/x.json"}),
            )
            .unwrap(),
        )
        .unwrap();

        let mut manifest = serde_json::json!({
            "plan_ref": plan_ref,
            "lint_ref": lint_ref,
            "claim_id": claim_id,
            "verification_mode": "verified",
            "variants": {"desktop": "visualizations/x.svg", "mobile": "visualizations/x.mobile.svg"},
        });
        if include_qa_ref {
            manifest["render_qa_ref"] = Value::String(qa_ref.clone());
        }
        fs::write(
            root.join("visualizations/x.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();

        temp
    }

    #[test]
    fn render_qa_pass_allows_visualization_to_verify() {
        let temp = build_viz_fixture(true, true);
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    #[test]
    fn render_qa_missing_ref_fails_non_draft_visualization() {
        let temp = build_viz_fixture(true, false);
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("missing render_qa_ref")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn render_qa_failed_report_fails_verification() {
        let temp = build_viz_fixture(false, true);
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("render QA did not pass")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn render_qa_tampered_svg_hash_mismatch_fails_verification() {
        let temp = build_viz_fixture(true, true);
        // Tamper with the rendered desktop SVG bytes after the QA report was
        // written; the report's stored svg_sha256 no longer matches the file
        // on disk, so a re-hash (never a trust of the report) must catch it.
        fs::write(
            temp.path().join("visualizations/x.svg"),
            render_qa_svg("tampered-after-qa"),
        )
        .unwrap();
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("SVG hash does not match render_qa report")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn render_qa_unsafe_ref_is_rejected() {
        let temp = build_viz_fixture(true, true);
        let manifest_path = temp.path().join("visualizations/x.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["render_qa_ref"] = Value::String("../../etc/passwd".to_owned());
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("unsafe render_qa_ref") || e.contains("must be under")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn render_qa_draft_visualization_is_exempt_from_passed_requirement() {
        let temp = build_viz_fixture(false, true);
        let manifest_path = temp.path().join("visualizations/x.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["verification_mode"] = Value::String("draft".to_owned());
        manifest["claim_id"] = Value::String(String::new());
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            !report.errors.iter().any(
                |e| e.contains("render QA did not pass") || e.contains("missing render_qa_ref")
            ),
            "draft visualization must not require render QA to pass or even be present: {:?}",
            report.errors
        );

        // A draft with no render_qa_ref at all is fully exempt too.
        let temp2 = build_viz_fixture(true, false);
        let manifest_path2 = temp2.path().join("visualizations/x.json");
        let mut manifest2: Value = read_json(&manifest_path2).unwrap();
        manifest2["verification_mode"] = Value::String("draft".to_owned());
        manifest2["claim_id"] = Value::String(String::new());
        fs::write(&manifest_path2, serde_json::to_string(&manifest2).unwrap()).unwrap();
        let mut report2 = VerificationReport::default();
        verify_visualizations(temp2.path(), &mut report2).unwrap();
        assert!(
            !report2
                .errors
                .iter()
                .any(|e| e.contains("render_qa") || e.contains("render QA")),
            "{:?}",
            report2.errors
        );
    }

    // -----------------------------------------------------------------
    // choropleth value_labels gate: a published (non-draft) choropleth
    // visualization must carry a render_qa report whose viewports each
    // have a passing value_labels check, bound to the actual SVG on disk
    // exactly like geometry/contrast already are.
    // -----------------------------------------------------------------

    fn render_qa_report_json_choropleth(
        desktop_sha: &str,
        mobile_sha: &str,
        value_labels_passed: bool,
    ) -> Value {
        let mut qa = render_qa_report_json(desktop_sha, mobile_sha, true);
        let value_labels = serde_json::json!({
            "passed": value_labels_passed,
            "checked": 1,
            "failures": if value_labels_passed { vec![] } else { vec![serde_json::json!({"rule": "value_label_missing", "message": "fixture failure"})] },
        });
        qa["viewports"]["desktop"]["value_labels"] = value_labels.clone();
        qa["viewports"]["mobile"]["value_labels"] = value_labels;
        qa
    }

    /// Like build_viz_fixture, but chart_type is "choropleth" and the
    /// render_qa report carries a value_labels check per viewport.
    fn build_choropleth_viz_fixture(
        value_labels_passed: bool,
        include_value_labels: bool,
    ) -> tempfile::TempDir {
        let temp = build_viz_fixture(true, true);
        let root = temp.path();
        let desktop_svg = fs::read_to_string(root.join("visualizations/x.svg")).unwrap();
        let mobile_svg = fs::read_to_string(root.join("visualizations/x.mobile.svg")).unwrap();
        let desktop_sha = sha256_bytes(desktop_svg.as_bytes());
        let mobile_sha = sha256_bytes(mobile_svg.as_bytes());
        let qa = if include_value_labels {
            render_qa_report_json_choropleth(&desktop_sha, &mobile_sha, value_labels_passed)
        } else {
            render_qa_report_json(&desktop_sha, &mobile_sha, true)
        };
        fs::write(
            root.join("visualizations/qa/x.json"),
            serde_json::to_string(&qa).unwrap(),
        )
        .unwrap();
        let manifest_path = root.join("visualizations/x.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["chart_type"] = Value::String("choropleth".to_owned());
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        temp
    }

    #[test]
    fn render_qa_choropleth_with_passing_value_labels_verifies() {
        let temp = build_choropleth_viz_fixture(true, true);
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    #[test]
    fn render_qa_choropleth_missing_value_labels_fails_verification() {
        let temp = build_choropleth_viz_fixture(true, false);
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("missing a passing value_labels check")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn render_qa_choropleth_failing_value_labels_fails_verification() {
        let temp = build_choropleth_viz_fixture(false, true);
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("missing a passing value_labels check")),
            "{:?}",
            report.errors
        );
    }

    /// A minimal but real choropleth SVG for one region (GIN, data-value
    /// 66.6), with its name/value labels controllable so a test can drop one
    /// out - review fix 7's independent re-derivation must catch that even
    /// when the render_qa report is honestly sha256-bound to these exact
    /// (label-missing) bytes and claims value_labels.passed: true anyway.
    fn choropleth_region_svg(include_name_label: bool, include_value_label: bool) -> String {
        let name = if include_name_label {
            r#"<text data-role="choropleth-label" data-iso3="GIN" text-anchor="middle" x="5" y="5" font-size="12">Guinea</text>"#
        } else {
            ""
        };
        let value = if include_value_label {
            r#"<text data-role="choropleth-label-value" data-iso3="GIN" text-anchor="middle" x="5" y="5" font-size="12"><tspan>66.6%</tspan></text>"#
        } else {
            ""
        };
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Fixture</title><desc>Fixture choropleth for verify.rs's independent value-labels re-derivation tests.</desc><path data-role=\"choropleth-data\" data-iso3=\"GIN\" data-value=\"66.6\" d=\"M0,0L10,0L10,10L0,10Z\"/>{name}{value}</svg>"
        )
    }

    /// Like build_choropleth_viz_fixture, but the desktop/mobile SVGs carry
    /// real choropleth-data/label markup for one region (GIN), and the
    /// render_qa report is honestly sha256-bound to whatever bytes were
    /// actually written - it always claims value_labels.passed: true,
    /// exactly as a report writer that never ran (or mis-ran) the JS
    /// checker would.
    fn build_choropleth_svg_fixture(include_name_label: bool, include_value_label: bool) -> tempfile::TempDir {
        let temp = build_viz_fixture(true, true);
        let root = temp.path();
        let desktop_svg = choropleth_region_svg(include_name_label, include_value_label);
        let mobile_svg = choropleth_region_svg(include_name_label, include_value_label);
        fs::write(root.join("visualizations/x.svg"), &desktop_svg).unwrap();
        fs::write(root.join("visualizations/x.mobile.svg"), &mobile_svg).unwrap();
        let desktop_sha = sha256_bytes(desktop_svg.as_bytes());
        let mobile_sha = sha256_bytes(mobile_svg.as_bytes());
        let qa = render_qa_report_json_choropleth(&desktop_sha, &mobile_sha, true);
        fs::write(
            root.join("visualizations/qa/x.json"),
            serde_json::to_string(&qa).unwrap(),
        )
        .unwrap();
        let manifest_path = root.join("visualizations/x.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["chart_type"] = Value::String("choropleth".to_owned());
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        temp
    }

    #[test]
    fn choropleth_labels_from_svg_passes_when_every_region_is_labelled_once() {
        let svg = choropleth_region_svg(true, true);
        assert_eq!(verify_choropleth_labels_from_svg(&svg), Vec::<String>::new());
    }

    #[test]
    fn choropleth_labels_from_svg_fails_when_a_name_label_is_missing() {
        let svg = choropleth_region_svg(false, true);
        let failures = verify_choropleth_labels_from_svg(&svg);
        assert!(failures.iter().any(|f| f.contains("GIN") && f.contains("name labels")), "{failures:?}");
    }

    #[test]
    fn choropleth_labels_from_svg_fails_when_a_value_label_is_missing() {
        let svg = choropleth_region_svg(true, false);
        let failures = verify_choropleth_labels_from_svg(&svg);
        assert!(failures.iter().any(|f| f.contains("GIN") && f.contains("value labels")), "{failures:?}");
    }

    #[test]
    fn choropleth_labels_from_svg_fails_when_the_shown_number_disagrees_with_data_value() {
        let svg = choropleth_region_svg(true, true).replace("66.6%", "12.3%");
        let failures = verify_choropleth_labels_from_svg(&svg);
        assert!(failures.iter().any(|f| f.contains("GIN") && f.contains("does not match")), "{failures:?}");
    }

    /// Review fix 7: a render_qa report that is genuinely, honestly
    /// sha256-bound to the SVG on disk, and claims value_labels.passed:
    /// true, must still fail full artifact verification when the SVG
    /// itself has no value label for a plotted region - the exact case
    /// hash-binding alone cannot catch, because the hash matches and the
    /// report's own boolean says everything is fine.
    #[test]
    fn render_qa_choropleth_report_claiming_passed_over_a_label_missing_svg_fails_verification() {
        let temp = build_choropleth_svg_fixture(true, false);
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("independent value-labels re-derivation failed") && e.contains("value labels")),
            "{:?}",
            report.errors
        );
    }

    /// The same shape of report/SVG pair, but with every label actually
    /// present, must verify cleanly - the independent re-derivation is not
    /// itself a new source of false failures.
    #[test]
    fn render_qa_choropleth_report_with_real_labels_present_verifies() {
        let temp = build_choropleth_svg_fixture(true, true);
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    #[test]
    fn render_qa_choropleth_tampered_svg_fails_value_labels_binding() {
        let temp = build_choropleth_viz_fixture(true, true);
        // Tamper the SVG after the QA report (with its passing value_labels)
        // was written: the whole viewport report - value_labels included -
        // is bound by svg_sha256, so this must still be caught by the
        // existing hash-mismatch check, not silently accepted because
        // value_labels itself still reads "passed".
        fs::write(
            temp.path().join("visualizations/x.svg"),
            render_qa_svg("tampered-after-qa"),
        )
        .unwrap();
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("SVG hash does not match render_qa report")),
            "{:?}",
            report.errors
        );
    }

    /// Builds a minimal, valid infographic page manifest (plan_ref, lint_ref,
    /// desktop/mobile SVG + hashes, render_qa_ref) under a fresh temp root.
    /// The plan has no language field (runtime default "en"), and both SVGs
    /// carry the matching English source strip, same as every other fixture
    /// in this module built before the B3 language-keyed source-strip check
    /// existed.
    fn build_infographic_fixture(qa_passed: bool, include_qa_ref: bool) -> tempfile::TempDir {
        build_infographic_fixture_with_plan(
            qa_passed,
            include_qa_ref,
            &serde_json::json!({}),
            "SOURCES &amp; METHODS",
            "SOURCES &amp; METHODS",
        )
    }

    /// Same fixture as build_infographic_fixture, but lets a test control
    /// the plan JSON (e.g. {"language": "zh"}) written at plan_ref and the
    /// source-strip text baked into each viewport's SVG, so the B3
    /// language-keyed source-strip check (read from the hash-bound plan,
    /// never from the SVG text alone) can be exercised in isolation.
    fn build_infographic_fixture_with_plan(
        qa_passed: bool,
        include_qa_ref: bool,
        plan: &Value,
        desktop_strip: &str,
        mobile_strip: &str,
    ) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in [
            "infographics/plans",
            "infographics/lints",
            "infographics/qa",
            "infographics/critics",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        // The runtime's newsroom_infographic_critic never lets a page verify
        // without a linked passing critic (see verify_infographic_critics),
        // so every fixture that expects to verify needs one by default.
        fs::write(
            root.join("infographics/critics/x.json"),
            serde_json::to_string(&serde_json::json!({
                "manifest_ref": "infographics/x.json",
                "passed": true,
                "rubric": {},
            }))
            .unwrap(),
        )
        .unwrap();
        let plan_ref = "infographics/plans/x.json";
        let lint_ref = "infographics/lints/x.json";
        fs::write(root.join(plan_ref), serde_json::to_string(plan).unwrap()).unwrap();
        fs::write(
            root.join(lint_ref),
            serde_json::to_string(&serde_json::json!({"passed": true, "plan_ref": plan_ref}))
                .unwrap(),
        )
        .unwrap();

        let desktop_svg = render_qa_svg("infographic-desktop").replace(
            "</svg>",
            &format!("<text x=\"10\" y=\"90\">{desktop_strip}</text></svg>"),
        );
        let mobile_svg = render_qa_svg("infographic-mobile").replace(
            "</svg>",
            &format!("<text x=\"10\" y=\"90\">{mobile_strip}</text></svg>"),
        );
        fs::write(root.join("infographics/x.svg"), &desktop_svg).unwrap();
        fs::write(root.join("infographics/x.mobile.svg"), &mobile_svg).unwrap();
        let desktop_sha = sha256_bytes(desktop_svg.as_bytes());
        let mobile_sha = sha256_bytes(mobile_svg.as_bytes());

        let qa_ref = "infographics/qa/x.json".to_owned();
        if include_qa_ref {
            fs::write(
                root.join(&qa_ref),
                serde_json::to_string(&render_qa_report_json(&desktop_sha, &mobile_sha, qa_passed))
                    .unwrap(),
            )
            .unwrap();
        }

        let mut manifest = serde_json::json!({
            "schema_version": "1.0.0",
            "plan_ref": plan_ref,
            "lint_ref": lint_ref,
            "variants": {"desktop": "infographics/x.svg", "mobile": "infographics/x.mobile.svg"},
            "hashes": {"desktop_sha256": desktop_sha, "mobile_sha256": mobile_sha},
        });
        if include_qa_ref {
            manifest["render_qa_ref"] = Value::String(qa_ref);
        }
        fs::write(
            root.join("infographics/x.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        temp
    }

    #[test]
    fn render_qa_pass_allows_infographic_to_verify() {
        let temp = build_infographic_fixture(true, true);
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    #[test]
    fn render_qa_missing_ref_fails_infographic() {
        let temp = build_infographic_fixture(true, false);
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("missing render_qa_ref")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn source_strip_zh_plan_with_zh_strip_passes() {
        let temp = build_infographic_fixture_with_plan(
            true,
            true,
            &serde_json::json!({"language": "zh"}),
            "资料来源与方法",
            "资料来源与方法",
        );
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            !report.errors.iter().any(|e| e.contains("source strip")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn source_strip_zh_plan_with_english_strip_fails() {
        let temp = build_infographic_fixture_with_plan(
            true,
            true,
            &serde_json::json!({"language": "zh"}),
            "SOURCES &amp; METHODS",
            "SOURCES &amp; METHODS",
        );
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("source strip missing or wrong language for plan language=zh")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn source_strip_en_plan_unchanged_still_requires_english_strip() {
        // The plan has no language field at all (the runtime's own
        // params.language ?? "en" default), and the fixture's strip is
        // still the plain English one this check has always required -
        // adding the zh rule must not change en pass/fail behavior.
        let temp = build_infographic_fixture(true, true);
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            !report.errors.iter().any(|e| e.contains("source strip")),
            "{:?}",
            report.errors
        );
    }

    /// Writes a sources/<hash>.json record with a two-page pdftotext-style
    /// body ("[page N]\n..." markers), content-addressed by its own
    /// content_hash exactly like runtime/pi/provenance.mjs's
    /// sourceContentHash, and returns (source_ref, page_2_text) so a test can
    /// build a matching or mismatching source_quote against it.
    fn write_source_quote_fixture(root: &Path) -> (String, String) {
        let page1 = "ALPHA introductory material spans several lines\nof running text.";
        let page2 = "This indicator counts fuel-\nwood and charcoal as renewable energy.";
        let text = format!("[page 1]\n{page1}\n\n[page 2]\n{page2}");
        let payload = serde_json::json!({
            "content_type": "application/pdf",
            "final_url": "https://example.org/metadata.pdf",
            "status": 200,
            "text": text,
            "truncated": false,
        });
        let content_hash = sha256_bytes(canonical_json(&payload).as_bytes());
        let record = serde_json::json!({
            "schema_version": "0.7.0",
            "final_url": payload["final_url"],
            "status": payload["status"],
            "content_type": payload["content_type"],
            "truncated": payload["truncated"],
            "content_hash": content_hash,
            "trust": "untrusted_external_content",
            "text": text,
        });
        fs::create_dir_all(root.join("sources")).unwrap();
        let source_ref = format!("sources/{content_hash}.json");
        fs::write(
            root.join(&source_ref),
            serde_json::to_string(&record).unwrap(),
        )
        .unwrap();
        (
            source_ref,
            "fuelwood and charcoal as renewable energy".to_owned(),
        )
    }

    /// Builds a full gated infographic fixture (plan/lint/critic/qa/manifest,
    /// same shape as build_infographic_fixture_with_plan) whose plan carries
    /// one text module with a source_quote, and whose rendered SVGs carry the
    /// page-number and (on a zh plan, when asked) 译述 labels a real render
    /// would produce - so tests can flip one input (the quote, the page, the
    /// source text, or the rendered label) at a time.
    fn build_source_quote_infographic(
        zh: bool,
        quote: &str,
        page: u64,
        translation: Option<&str>,
        render_translation_label: bool,
    ) -> (tempfile::TempDir, String) {
        build_source_quote_infographic_with_body(
            zh,
            quote,
            page,
            translation,
            render_translation_label,
            Some("A scope note from the source metadata."),
        )
    }

    /// Same as build_source_quote_infographic, but lets a test control the
    /// text module's body directly - None omits body entirely (the
    /// no-body-next-to-a-quote case), Some(text) sets it verbatim so a
    /// test can put a digit, a percent sign, or an over-long string right
    /// where a real editor might accidentally leave one.
    fn build_source_quote_infographic_with_body(
        zh: bool,
        quote: &str,
        page: u64,
        translation: Option<&str>,
        render_translation_label: bool,
        body: Option<&str>,
    ) -> (tempfile::TempDir, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in [
            "infographics/plans",
            "infographics/lints",
            "infographics/qa",
            "infographics/critics",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let (source_ref, _) = write_source_quote_fixture(root);
        fs::write(
            root.join("infographics/critics/x.json"),
            serde_json::to_string(&serde_json::json!({
                "manifest_ref": "infographics/x.json", "passed": true, "rubric": {},
            }))
            .unwrap(),
        )
        .unwrap();

        let mut module = serde_json::json!({
            "id": "definition-note", "type": "text",
            "source_quote": {"source_ref": source_ref, "page": page, "quote": quote},
        });
        if let Some(body) = body {
            module["body"] = Value::String(body.to_owned());
        }
        if let Some(translation) = translation {
            module["source_quote"]["translation"] = Value::String(translation.to_owned());
        }
        let mut plan = serde_json::json!({"modules": [module]});
        if zh {
            plan["language"] = Value::String("zh".to_owned());
        }
        let plan_ref = "infographics/plans/x.json";
        let lint_ref = "infographics/lints/x.json";
        fs::write(root.join(plan_ref), serde_json::to_string(&plan).unwrap()).unwrap();
        fs::write(
            root.join(lint_ref),
            serde_json::to_string(&serde_json::json!({"passed": true, "plan_ref": plan_ref}))
                .unwrap(),
        )
        .unwrap();

        let strip = if zh {
            let mut s = format!("资料来源与方法 {page}");
            if render_translation_label {
                s.push_str(" 译述：内容");
            }
            s
        } else {
            format!("SOURCES &amp; METHODS p. {page}")
        };
        let desktop_svg = render_qa_svg("infographic-desktop").replace(
            "</svg>",
            &format!("<text x=\"10\" y=\"90\">{strip}</text></svg>"),
        );
        let mobile_svg = render_qa_svg("infographic-mobile").replace(
            "</svg>",
            &format!("<text x=\"10\" y=\"90\">{strip}</text></svg>"),
        );
        fs::write(root.join("infographics/x.svg"), &desktop_svg).unwrap();
        fs::write(root.join("infographics/x.mobile.svg"), &mobile_svg).unwrap();
        let desktop_sha = sha256_bytes(desktop_svg.as_bytes());
        let mobile_sha = sha256_bytes(mobile_svg.as_bytes());
        fs::write(
            root.join("infographics/qa/x.json"),
            serde_json::to_string(&render_qa_report_json(&desktop_sha, &mobile_sha, true)).unwrap(),
        )
        .unwrap();
        let manifest = serde_json::json!({
            "schema_version": "1.0.0",
            "plan_ref": plan_ref,
            "lint_ref": lint_ref,
            "variants": {"desktop": "infographics/x.svg", "mobile": "infographics/x.mobile.svg"},
            "hashes": {"desktop_sha256": desktop_sha, "mobile_sha256": mobile_sha},
            "render_qa_ref": "infographics/qa/x.json",
        });
        fs::write(
            root.join("infographics/x.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        (temp, source_ref)
    }

    #[test]
    fn source_quote_verbatim_quote_on_correct_page_passes() {
        let (temp, _) = build_source_quote_infographic(
            true,
            "fuelwood and charcoal as renewable energy",
            2,
            Some("将燃料木材和木炭计为可再生能源"),
            true,
        );
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    #[test]
    fn source_quote_non_verbatim_text_fails() {
        let (temp, _) = build_source_quote_infographic(
            true,
            "fuel-wood and charcoal are the main renewable source",
            2,
            Some("译文"),
            true,
        );
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("does not appear verbatim")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn source_quote_wrong_page_fails() {
        // The quote text is real (it is page 2's text), but the module
        // claims it is on page 1, where it does not appear.
        let (temp, _) = build_source_quote_infographic(
            true,
            "fuelwood and charcoal as renewable energy",
            1,
            Some("译文"),
            true,
        );
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("does not appear verbatim on page 1")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn source_quote_tampered_source_after_planning_fails() {
        let (temp, source_ref) = build_source_quote_infographic(
            true,
            "fuelwood and charcoal as renewable energy",
            2,
            Some("译文"),
            true,
        );
        let source_path = temp.path().join(&source_ref);
        let mut record: Value = read_json(&source_path).unwrap();
        record["text"] = Value::String(
            record["text"]
                .as_str()
                .unwrap()
                .replace("charcoal as renewable energy", "charcoal as fossil energy"),
        );
        fs::write(&source_path, serde_json::to_string(&record).unwrap()).unwrap();
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("source content_hash mismatch")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn source_quote_missing_translation_label_on_zh_page_fails() {
        // A translation is present in the plan, but the rendered page never
        // shows the 译述 label - the render must be caught, not just the plan.
        let (temp, _) = build_source_quote_infographic(
            true,
            "fuelwood and charcoal as renewable energy",
            2,
            Some("译文"),
            false,
        );
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            report.errors.iter().any(|e| e.contains("no 译述 label")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn source_quote_body_with_a_digit_fails() {
        // Body is bound to neither the source_quote nor a claim, so it must
        // never be able to read like a verified figure of its own.
        let (temp, _) = build_source_quote_infographic_with_body(
            true,
            "fuelwood and charcoal as renewable energy",
            2,
            Some("译文"),
            true,
            Some("This note cites 3 sources."),
        );
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("source_quote body must not contain digits or a percent sign")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn source_quote_body_over_60_chars_fails() {
        let long_body = "x".repeat(61);
        let (temp, _) = build_source_quote_infographic_with_body(
            true,
            "fuelwood and charcoal as renewable energy",
            2,
            Some("译文"),
            true,
            Some(&long_body),
        );
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("source_quote body must be at most 60 characters")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn source_quote_with_no_body_passes_and_renders() {
        // The quote block itself carries the content - body is optional
        // next to a source_quote, and omitting it entirely must still pass.
        let (temp, _) = build_source_quote_infographic_with_body(
            true,
            "fuelwood and charcoal as renewable energy",
            2,
            Some("译文"),
            true,
            None,
        );
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    // source_quote+claim_ids mutual exclusion (a source-only note must never
    // count as a verified finding) is enforced at schema-validation time in
    // runtime/pi/infographic.mjs's validateInfographicSpec, before a plan
    // with both can ever reach a manifest this verifier reads; see
    // scripts/test_infographic_source_quote.mjs for that coverage. There is
    // nothing for this file's artifact-only verifier to independently
    // recheck here, so no Rust test stands in for it.

    #[test]
    fn render_qa_tampered_infographic_svg_hash_mismatch_fails_verification() {
        let temp = build_infographic_fixture(true, true);
        fs::write(
            temp.path().join("infographics/x.svg"),
            render_qa_svg("tampered-infographic"),
        )
        .unwrap();
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        // The manifest's own hashes.desktop_sha256 no longer matches the
        // tampered file either, so this is caught before render QA runs.
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("SVG hash does not match manifest hashes")),
            "{:?}",
            report.errors
        );
    }

    /// Rewrites the infographic fixture's manifest and render QA report in
    /// place, so a test can drop or alter one viewport.
    fn edit_infographic_fixture(root: &Path, edit: impl FnOnce(&mut Value, &mut Value)) {
        let manifest_path = root.join("infographics/x.json");
        let qa_path = root.join("infographics/qa/x.json");
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let mut qa: Value = serde_json::from_str(&fs::read_to_string(&qa_path).unwrap()).unwrap();
        edit(&mut manifest, &mut qa);
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        fs::write(&qa_path, serde_json::to_string(&qa).unwrap()).unwrap();
    }

    /// What the runtime writes with mobile pages off: the manifest lists the
    /// desktop page alone and its render QA report covers desktop alone.
    fn drop_mobile_page(root: &Path) {
        edit_infographic_fixture(root, |manifest, qa| {
            manifest["variants"]
                .as_object_mut()
                .unwrap()
                .remove("mobile");
            manifest["hashes"]
                .as_object_mut()
                .unwrap()
                .remove("mobile_sha256");
            qa["viewports"].as_object_mut().unwrap().remove("mobile");
        });
        fs::remove_file(root.join("infographics/x.mobile.svg")).unwrap();
    }

    fn infographic_errors(root: &Path) -> Vec<String> {
        let mut report = VerificationReport::default();
        verify_infographics(root, &mut report).unwrap();
        report.errors
    }

    fn assert_error(errors: &[String], needle: &str) {
        assert!(
            errors.iter().any(|e| e.contains(needle)),
            "expected '{needle}' in {errors:?}"
        );
    }

    #[test]
    fn desktop_only_infographic_verifies() {
        let temp = build_infographic_fixture(true, true);
        drop_mobile_page(temp.path());
        let errors = infographic_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn desktop_only_infographic_rejects_a_report_with_a_mobile_viewport() {
        let temp = build_infographic_fixture(true, true);
        edit_infographic_fixture(temp.path(), |manifest, _qa| {
            manifest["variants"]
                .as_object_mut()
                .unwrap()
                .remove("mobile");
            manifest["hashes"]
                .as_object_mut()
                .unwrap()
                .remove("mobile_sha256");
        });
        assert_error(
            &infographic_errors(temp.path()),
            "viewports.mobile, which the manifest does not list",
        );
    }

    #[test]
    fn listed_mobile_page_still_requires_its_report_viewport() {
        let temp = build_infographic_fixture(true, true);
        edit_infographic_fixture(temp.path(), |_manifest, qa| {
            qa["viewports"].as_object_mut().unwrap().remove("mobile");
        });
        assert_error(
            &infographic_errors(temp.path()),
            "missing viewports.mobile.svg_sha256",
        );
    }

    #[test]
    fn infographic_without_a_desktop_page_fails() {
        let temp = build_infographic_fixture(true, true);
        edit_infographic_fixture(temp.path(), |manifest, qa| {
            manifest["variants"]
                .as_object_mut()
                .unwrap()
                .remove("desktop");
            manifest["hashes"]
                .as_object_mut()
                .unwrap()
                .remove("desktop_sha256");
            qa["viewports"].as_object_mut().unwrap().remove("desktop");
        });
        assert_error(&infographic_errors(temp.path()), "missing desktop SVG ref");
    }

    #[test]
    fn infographic_hash_without_a_listed_variant_fails() {
        let temp = build_infographic_fixture(true, true);
        edit_infographic_fixture(temp.path(), |manifest, qa| {
            manifest["variants"]
                .as_object_mut()
                .unwrap()
                .remove("mobile");
            qa["viewports"].as_object_mut().unwrap().remove("mobile");
        });
        assert_error(
            &infographic_errors(temp.path()),
            "hashes.mobile_sha256 without a matching variant",
        );
    }

    #[test]
    fn infographic_unknown_variant_fails() {
        let temp = build_infographic_fixture(true, true);
        edit_infographic_fixture(temp.path(), |manifest, _qa| {
            manifest["variants"]["tablet"] = Value::String("infographics/x.svg".into());
        });
        assert_error(&infographic_errors(temp.path()), "unknown variant: tablet");
    }

    #[test]
    fn desktop_only_infographic_requires_its_viewport_to_pass() {
        let temp = build_infographic_fixture(true, true);
        drop_mobile_page(temp.path());
        edit_infographic_fixture(temp.path(), |_manifest, qa| {
            qa["viewports"]["desktop"]["passed"] = Value::Bool(false);
        });
        assert_error(
            &infographic_errors(temp.path()),
            "render QA did not pass for desktop",
        );
    }

    #[test]
    fn desktop_only_infographic_requires_its_report_hash_to_match() {
        let temp = build_infographic_fixture(true, true);
        drop_mobile_page(temp.path());
        edit_infographic_fixture(temp.path(), |_manifest, qa| {
            qa["viewports"]["desktop"]["svg_sha256"] = Value::String("0".repeat(64));
        });
        assert_error(
            &infographic_errors(temp.path()),
            "desktop SVG hash does not match render_qa report",
        );
    }

    /// Rewrites the visualization fixture's manifest and render QA report in
    /// place, like edit_infographic_fixture.
    fn edit_viz_fixture(root: &Path, edit: impl FnOnce(&mut Value, &mut Value)) {
        let manifest_path = root.join("visualizations/x.json");
        let qa_path = root.join("visualizations/qa/x.json");
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let mut qa: Value = serde_json::from_str(&fs::read_to_string(&qa_path).unwrap()).unwrap();
        edit(&mut manifest, &mut qa);
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        fs::write(&qa_path, serde_json::to_string(&qa).unwrap()).unwrap();
    }

    fn viz_errors(root: &Path) -> Vec<String> {
        let mut report = VerificationReport::default();
        verify_visualizations(root, &mut report).unwrap();
        report.errors
    }

    #[test]
    fn desktop_only_visualization_verifies() {
        let temp = build_viz_fixture(true, true);
        edit_viz_fixture(temp.path(), |manifest, qa| {
            manifest["variants"]
                .as_object_mut()
                .unwrap()
                .remove("mobile");
            qa["viewports"].as_object_mut().unwrap().remove("mobile");
        });
        fs::remove_file(temp.path().join("visualizations/x.mobile.svg")).unwrap();
        let errors = viz_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn desktop_only_visualization_rejects_a_report_with_a_mobile_viewport() {
        let temp = build_viz_fixture(true, true);
        edit_viz_fixture(temp.path(), |manifest, _qa| {
            manifest["variants"]
                .as_object_mut()
                .unwrap()
                .remove("mobile");
        });
        assert_error(
            &viz_errors(temp.path()),
            "viewports.mobile, which the manifest does not list",
        );
    }

    #[test]
    fn visualization_listing_mobile_still_requires_its_svg_and_viewport() {
        let temp = build_viz_fixture(true, true);
        edit_viz_fixture(temp.path(), |_manifest, qa| {
            qa["viewports"].as_object_mut().unwrap().remove("mobile");
        });
        fs::remove_file(temp.path().join("visualizations/x.mobile.svg")).unwrap();
        let errors = viz_errors(temp.path());
        assert_error(&errors, "missing mobile SVG");
        assert_error(&errors, "missing viewports.mobile.svg_sha256");
    }

    #[test]
    fn visualization_without_desktop_or_with_unknown_variant_fails() {
        let temp = build_viz_fixture(true, true);
        edit_viz_fixture(temp.path(), |manifest, _qa| {
            manifest["variants"]
                .as_object_mut()
                .unwrap()
                .remove("desktop");
            manifest["variants"]["tablet"] = Value::String("visualizations/x.svg".into());
        });
        let errors = viz_errors(temp.path());
        assert_error(&errors, "missing desktop SVG ref");
        assert_error(&errors, "unknown variant: tablet");
    }

    #[test]
    fn legacy_chart_manifest_without_plan_ref_or_variants_fails() {
        // Mirrors exactly what runtime/pi/newsroom.ts's legacy
        // newsroom_chart tool writes directly under visualizations/: no
        // plan_ref, no variants - a bypass of the
        // newsroom_viz_plan -> lint -> render gate chain.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("visualizations")).unwrap();
        fs::write(
            root.join("visualizations/legacy-chart.json"),
            serde_json::to_string(&serde_json::json!({
                "schema_version": "0.7.0",
                "claim_id": "claim-x",
                "computation_ref": "computations/x.json",
                "title": "Legacy chart",
                "chart_type": "bar",
                "sql": "select 1",
                "x_field": "x",
                "y_field": "y",
                "source_note": "Fixture",
                "svg": "visualizations/legacy-chart.svg",
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(root.join("visualizations/legacy-chart.svg"), "<svg></svg>").unwrap();
        assert_error(
            &viz_errors(root),
            "is not a gated visualization manifest (no plan_ref/variants)",
        );
    }

    #[test]
    fn lieflat_chart_manifest_fails_with_explicit_reason() {
        // Mirrors exactly what runtime/pi/lieflat.mjs's chart mode writes
        // under visualizations/: kind=lieflat_chart, variants present (so
        // it would NOT trip the generic no-plan_ref/variants check above),
        // but desktop_qa/artifact_status are renderer constants with no
        // render_qa_ref, lint_ref or critic at all.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("visualizations")).unwrap();
        fs::write(root.join("visualizations/lieflat.svg"), "<svg></svg>").unwrap();
        fs::write(
            root.join("visualizations/lieflat.json"),
            serde_json::to_string(&serde_json::json!({
                "schema_version": "1.0.0",
                "kind": "lieflat_chart",
                "artifact_status": "VERIFIED",
                "variants": {"desktop": "visualizations/lieflat.svg"},
                "desktop_qa": "PASS",
            }))
            .unwrap(),
        )
        .unwrap();
        let errors = viz_errors(root);
        assert_error(
            &errors,
            "is a Lieflat chart whose desktop_qa/artifact_status are renderer constants",
        );
        // It must not also be double-counted under the generic message.
        assert!(
            !errors
                .iter()
                .any(|e| e.contains("is not a gated visualization manifest")),
            "{errors:?}"
        );
    }

    #[test]
    fn infographic_without_critic_fails() {
        let temp = build_infographic_fixture(true, true);
        fs::remove_file(temp.path().join("infographics/critics/x.json")).unwrap();
        let errors = infographic_errors(temp.path());
        assert_error(&errors, "has no critic artifact");
    }

    #[test]
    fn infographic_with_only_failing_critic_fails() {
        let temp = build_infographic_fixture(true, true);
        fs::write(
            temp.path().join("infographics/critics/x.json"),
            serde_json::to_string(&serde_json::json!({
                "manifest_ref": "infographics/x.json",
                "passed": false,
            }))
            .unwrap(),
        )
        .unwrap();
        let errors = infographic_errors(temp.path());
        assert_error(&errors, "has no passing critic");
    }

    /// Adds a passing deterministic critic link and preview-hash chain,
    /// then a vision critic scored `score` (with a blocker issue when
    /// `has_blocker`), and flips the manifest's own
    /// `visual_review_required` to true - mirroring exactly what
    /// newsroom_infographic_vision_critic binds together at runtime
    /// (deterministic_critic_ref, preview_ref, source_hashes, variants).
    fn enable_vision_review(root: &Path, score: f64, has_blocker: bool) {
        for dir in ["infographics/vision-critics", "infographics/previews"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let manifest_path = root.join("infographics/x.json");
        let manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        edit_infographic_fixture(root, |manifest, _qa| {
            manifest["visual_review_required"] = Value::Bool(true);
        });

        let desktop_png = b"\x89PNG\r\n\x1a\ndesktop-preview".to_vec();
        let mobile_png = b"\x89PNG\r\n\x1a\nmobile-preview".to_vec();
        fs::write(
            root.join("infographics/previews/x-desktop.png"),
            &desktop_png,
        )
        .unwrap();
        fs::write(root.join("infographics/previews/x-mobile.png"), &mobile_png).unwrap();
        let desktop_sha = sha256_bytes(&desktop_png);
        let mobile_sha = sha256_bytes(&mobile_png);
        let preview = serde_json::json!({
            "schema_version": "0.1.0",
            "kind": "infographic_visual_preview",
            "manifest_ref": "infographics/x.json",
            "deterministic_critic_ref": "infographics/critics/x.json",
            "source_hashes": manifest["hashes"],
            "variants": {
                "desktop": "infographics/previews/x-desktop.png",
                "mobile": "infographics/previews/x-mobile.png",
            },
            "hashes": {"desktop_sha256": desktop_sha, "mobile_sha256": mobile_sha},
        });
        fs::write(
            root.join("infographics/previews/x.json"),
            serde_json::to_string(&preview).unwrap(),
        )
        .unwrap();

        let rubric = serde_json::json!({
            "hierarchy": 90, "legibility": 90, "composition": 90, "visual_coherence": 90,
            "typography": 90, "source_legibility": 90, "responsive_quality": 90,
            "illustration_integration": 90, "color_contrast": 90, "editorial_distinctiveness": 90,
        });
        let issues: Vec<Value> = if has_blocker {
            vec![serde_json::json!({
                "severity": "blocker",
                "viewport": "desktop",
                "code": "x",
                "evidence": "x",
                "recommendation": "x",
            })]
        } else {
            vec![]
        };
        let vision = serde_json::json!({
            "schema_version": "0.2.0",
            "kind": "image_aware_model",
            "manifest_ref": "infographics/x.json",
            "passed": true,
            "score": score,
            "rubric": rubric,
            "issues": issues,
            "deterministic_critic_ref": "infographics/critics/x.json",
            "preview_ref": "infographics/previews/x.json",
        });
        fs::write(
            root.join("infographics/vision-critics/x.json"),
            serde_json::to_string(&vision).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn infographic_vision_review_required_without_vision_critic_fails() {
        let temp = build_infographic_fixture(true, true);
        edit_infographic_fixture(temp.path(), |manifest, _qa| {
            manifest["visual_review_required"] = Value::Bool(true);
        });
        let errors = infographic_errors(temp.path());
        assert_error(&errors, "requires image-aware vision critic");
    }

    #[test]
    fn infographic_vision_review_required_with_low_score_fails() {
        let temp = build_infographic_fixture(true, true);
        enable_vision_review(temp.path(), 50.0, false);
        let errors = infographic_errors(temp.path());
        assert_error(&errors, "vision critic score below 80");
    }

    #[test]
    fn infographic_vision_review_required_with_blocker_fails() {
        let temp = build_infographic_fixture(true, true);
        enable_vision_review(temp.path(), 95.0, true);
        let errors = infographic_errors(temp.path());
        assert_error(&errors, "vision critic contains blocker");
    }

    #[test]
    fn infographic_vision_review_required_and_passing_verifies() {
        let temp = build_infographic_fixture(true, true);
        enable_vision_review(temp.path(), 95.0, false);
        let errors = infographic_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    /// Attaches a passing visualizations/illustrations/y.json (0.1.0
    /// schematic explainer) to the infographic fixture's
    /// illustration_manifest_refs, mirroring what newsroom_explainer_render
    /// + newsroom_explainer_critic write together at runtime.
    fn attach_illustration_fixture(root: &Path) {
        for dir in [
            "visualizations/illustrations",
            "visualizations/illustrations/critics",
            "visualizations/illustrations/plans",
            "visualizations/illustrations/lints",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let svg = "<svg><title>t</title><desc>d</desc><text data-explainer-version=\"0.1.0\">SCHEMATIC / NOT TO SCALE</text></svg>".to_owned();
        fs::write(root.join("visualizations/illustrations/y.svg"), &svg).unwrap();
        let sha = sha256_bytes(svg.as_bytes());
        fs::write(root.join("visualizations/illustrations/plans/y.json"), "{}").unwrap();
        fs::write(root.join("visualizations/illustrations/lints/y.json"), "{}").unwrap();
        let illustration = serde_json::json!({
            "schema_version": "0.1.0",
            "not_to_scale": true,
            "plan_ref": "visualizations/illustrations/plans/y.json",
            "lint_ref": "visualizations/illustrations/lints/y.json",
            "variants": {"desktop": "visualizations/illustrations/y.svg"},
            "hashes": {"desktop_sha256": sha},
        });
        fs::write(
            root.join("visualizations/illustrations/y.json"),
            serde_json::to_string(&illustration).unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("visualizations/illustrations/critics/y.json"),
            serde_json::to_string(&serde_json::json!({
                "manifest_ref": "visualizations/illustrations/y.json",
                "passed": true,
            }))
            .unwrap(),
        )
        .unwrap();
        edit_infographic_fixture(root, |manifest, _qa| {
            manifest["illustration_manifest_refs"] =
                serde_json::json!(["visualizations/illustrations/y.json"]);
        });
    }

    #[test]
    fn infographic_illustration_verifies_when_linked_and_passing() {
        let temp = build_infographic_fixture(true, true);
        attach_illustration_fixture(temp.path());
        let errors = infographic_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn infographic_illustration_without_passing_critic_fails() {
        let temp = build_infographic_fixture(true, true);
        attach_illustration_fixture(temp.path());
        fs::remove_file(
            temp.path()
                .join("visualizations/illustrations/critics/y.json"),
        )
        .unwrap();
        let errors = infographic_errors(temp.path());
        assert_error(
            &errors,
            "illustration visualizations/illustrations/y.json has no passing critic",
        );
    }

    #[test]
    fn infographic_illustration_missing_not_to_scale_disclosure_fails() {
        let temp = build_infographic_fixture(true, true);
        attach_illustration_fixture(temp.path());
        let illustration_path = temp.path().join("visualizations/illustrations/y.json");
        let mut illustration: Value =
            serde_json::from_str(&fs::read_to_string(&illustration_path).unwrap()).unwrap();
        illustration["not_to_scale"] = Value::Bool(false);
        fs::write(
            &illustration_path,
            serde_json::to_string(&illustration).unwrap(),
        )
        .unwrap();
        let errors = infographic_errors(temp.path());
        assert_error(&errors, "must disclose not_to_scale");
    }

    #[test]
    fn infographic_illustration_svg_hash_mismatch_fails() {
        let temp = build_infographic_fixture(true, true);
        attach_illustration_fixture(temp.path());
        fs::write(
            temp.path().join("visualizations/illustrations/y.svg"),
            "<svg><title>t</title><desc>d</desc><text data-explainer-version=\"0.1.0\">SCHEMATIC / NOT TO SCALE tampered</text></svg>",
        )
        .unwrap();
        let errors = infographic_errors(temp.path());
        assert_error(
            &errors,
            "illustration visualizations/illustrations/y.json desktop hash mismatch",
        );
    }

    /// Builds a minimal but complete publications/<html_sha256>/manifest.json
    /// fixture (desktop-only breakpoints, one computation-bound module, a
    /// real upstream infographic plan bound to a top-level infographic
    /// manifest with a passing critic and passing vision critic, and a
    /// linked passing browser-qa.json unless `include_qa` is false),
    /// mirroring what newsroom_publication_plan -> newsroom_publication_render
    /// -> newsroom_publication_qa write together at runtime. Returns the
    /// temp root and the html content hash used to name the publication
    /// directory.
    fn build_publication_fixture(qa_passed: bool, include_qa: bool) -> (tempfile::TempDir, String) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in [
            "publications/plans",
            "publications/qa",
            "computations",
            "infographics/plans",
            "infographics/critics",
            "infographics/vision-critics",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join("computations/c1.json"), "{}").unwrap();
        fs::write(root.join("infographics/plans/x.json"), "{}").unwrap();
        // The upstream infographic this publication's infographic_plan_ref
        // binds to: a top-level, non-rejected manifest whose plan_ref points
        // back at infographics/plans/x.json, with a passing critic and a
        // passing image-aware vision critic linked by manifest_ref - the
        // lineage verify_publication_infographic_lineage requires.
        fs::write(
            root.join("infographics/ig1.json"),
            serde_json::to_string(&serde_json::json!({
                "plan_ref": "infographics/plans/x.json",
                "visual_review_required": true,
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("infographics/critics/c1.json"),
            serde_json::to_string(
                &serde_json::json!({"manifest_ref": "infographics/ig1.json", "passed": true}),
            )
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("infographics/vision-critics/v1.json"),
            serde_json::to_string(
                &serde_json::json!({"manifest_ref": "infographics/ig1.json", "passed": true}),
            )
            .unwrap(),
        )
        .unwrap();

        let plan = serde_json::json!({
            "schema_version": "0.3.0",
            "infographic_plan_ref": "infographics/plans/x.json",
            "delivery": {"breakpoints": [1440]},
            "modules": [
                {"id": "m1", "evidence_binding": {"kind": "computation", "ref": "computations/c1.json"}},
            ],
        });
        fs::write(
            root.join("publications/plans/plan.json"),
            serde_json::to_string(&plan).unwrap(),
        )
        .unwrap();

        let html = "<html>fixture</html>";
        let key = sha256_bytes(html.as_bytes());
        fs::create_dir_all(root.join(format!("publications/{key}"))).unwrap();
        fs::write(root.join(format!("publications/{key}/index.html")), html).unwrap();
        let manifest = serde_json::json!({
            "plan_ref": "publications/plans/plan.json",
            "html_ref": format!("publications/{key}/index.html"),
            "html_sha256": key,
        });
        fs::write(
            root.join(format!("publications/{key}/manifest.json")),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();

        if include_qa {
            fs::create_dir_all(root.join("publications/qa/q1")).unwrap();
            let shot_bytes = b"fake-screenshot-bytes";
            let shot_sha = sha256_bytes(shot_bytes);
            fs::write(
                root.join("publications/qa/q1/publication-1440.png"),
                shot_bytes,
            )
            .unwrap();
            fs::write(root.join("publications/qa/q1/archive.png"), shot_bytes).unwrap();
            fs::write(
                root.join("publications/qa/q1/browser-qa.json"),
                serde_json::to_string(&serde_json::json!({
                    "html_sha256": key,
                    "status": if qa_passed { "PASS" } else { "FAIL" },
                    "screenshots": [{"width": 1440, "path": "publication-1440.png", "sha256": shot_sha}],
                    "archive_fallback": {"path": "archive.png", "sha256": shot_sha, "source_width": 1440},
                }))
                .unwrap(),
            )
            .unwrap();
        }

        (temp, key)
    }

    fn publication_errors(root: &Path) -> Vec<String> {
        let mut report = VerificationReport::default();
        verify_publications(root, &mut report).unwrap();
        report.errors
    }

    #[test]
    fn publication_verifies_when_complete() {
        let (temp, _key) = build_publication_fixture(true, true);
        let errors = publication_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn publication_tampered_html_fails_hash_check() {
        let (temp, key) = build_publication_fixture(true, true);
        fs::write(
            temp.path().join(format!("publications/{key}/index.html")),
            "<html>tampered</html>",
        )
        .unwrap();
        let errors = publication_errors(temp.path());
        assert_error(&errors, "html_sha256 mismatch");
    }

    #[test]
    fn publication_missing_qa_report_fails() {
        let (temp, _key) = build_publication_fixture(true, false);
        let errors = publication_errors(temp.path());
        assert_error(&errors, "has no linked browser QA report");
    }

    #[test]
    fn publication_failing_qa_report_fails() {
        let (temp, _key) = build_publication_fixture(false, true);
        let errors = publication_errors(temp.path());
        assert_error(&errors, "has no passing browser QA report");
    }

    #[test]
    fn publication_breakpoint_mismatch_fails() {
        let (temp, _key) = build_publication_fixture(true, true);
        let plan_path = temp.path().join("publications/plans/plan.json");
        let mut plan: Value =
            serde_json::from_str(&fs::read_to_string(&plan_path).unwrap()).unwrap();
        // Neither exactly [1440] nor at least two widths.
        plan["delivery"]["breakpoints"] = serde_json::json!([768]);
        fs::write(&plan_path, serde_json::to_string(&plan).unwrap()).unwrap();
        let errors = publication_errors(temp.path());
        assert_error(
            &errors,
            "plan delivery.breakpoints must be exactly [1440] or at least two widths",
        );
    }

    #[test]
    fn publication_portable_fallback_without_qa_fails() {
        // The portable path's own tool result says plainly "this does not
        // replace browser QA" - it must not verify without one either.
        let (temp, key) = build_publication_fixture(true, false);
        let manifest_path = temp
            .path()
            .join(format!("publications/{key}/manifest.json"));
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest["portable_fallback"] = Value::Bool(true);
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        let errors = publication_errors(temp.path());
        assert_error(&errors, "has no linked browser QA report");
    }

    #[test]
    fn publication_portable_fallback_with_passing_qa_verifies() {
        let (temp, key) = build_publication_fixture(true, true);
        let manifest_path = temp
            .path()
            .join(format!("publications/{key}/manifest.json"));
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest["portable_fallback"] = Value::Bool(true);
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        let errors = publication_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn publication_qa_screenshot_tampered_fails() {
        let (temp, _key) = build_publication_fixture(true, true);
        fs::write(
            temp.path().join("publications/qa/q1/publication-1440.png"),
            b"tampered-bytes",
        )
        .unwrap();
        let errors = publication_errors(temp.path());
        assert_error(&errors, "browser QA screenshot sha256 mismatch");
        // Screenshot tampering must sink the whole QA report, not just log
        // a warning alongside an otherwise-accepted pass.
        assert_error(&errors, "has no passing browser QA report");
    }

    #[test]
    fn publication_qa_missing_archive_fallback_file_fails() {
        let (temp, _key) = build_publication_fixture(true, true);
        fs::remove_file(temp.path().join("publications/qa/q1/archive.png")).unwrap();
        let errors = publication_errors(temp.path());
        assert_error(&errors, "browser QA archive_fallback file is missing");
    }

    #[test]
    fn publication_realistic_lieflat_publication_fails_generic_and_specific_checks() {
        // Mirrors exactly what renderLieflatPublication's report mode
        // writes: no plan_ref at all (only infographic_plan_ref, itself
        // pointing at a Lieflat-kind plan under infographics/<key>/), and
        // no publications/qa/*/browser-qa.json - only a self-issued
        // publications/<key>/qa.json.
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let html = "<html>lieflat</html>";
        let key = sha256_bytes(html.as_bytes());
        fs::create_dir_all(root.join(format!("publications/{key}"))).unwrap();
        fs::write(root.join(format!("publications/{key}/index.html")), html).unwrap();
        fs::write(
            root.join(format!("publications/{key}/qa.json")),
            serde_json::to_string(&serde_json::json!({
                "schema_version": "1.0.0",
                "kind": "publication_qa",
                "passed": true,
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join(format!("publications/{key}/manifest.json")),
            serde_json::to_string(&serde_json::json!({
                "schema_version": "1.0.0",
                "kind": "lieflat_publication",
                "html_ref": format!("publications/{key}/index.html"),
                "html_sha256": key,
                "infographic_plan_ref": "infographics/lieflat-key/plan.json",
            }))
            .unwrap(),
        )
        .unwrap();
        let errors = publication_errors(root);
        assert_error(
            &errors,
            "is a Lieflat publication (kind=lieflat_publication)",
        );
        assert_error(&errors, "plan_ref must be under publications/plans/");
        assert_error(&errors, "has no linked browser QA report");
    }

    #[test]
    fn publication_missing_upstream_infographic_plan_fails() {
        let (temp, _key) = build_publication_fixture(true, true);
        fs::remove_file(temp.path().join("infographics/plans/x.json")).unwrap();
        let errors = publication_errors(temp.path());
        assert_error(&errors, "missing upstream infographic plan");
    }

    /// The gate this worktree adds: an infographic_plan_ref that resolves to
    /// a real plan file (so the pre-existing "missing upstream infographic
    /// plan" check above stays green) but whose only rendered page was
    /// moved out of the top level - e.g. after a critic rejected it, the
    /// exact africa-01 dev-run shape this closes - must still fail.
    #[test]
    fn publication_infographic_lineage_no_top_level_manifest_fails() {
        let (temp, _key) = build_publication_fixture(true, true);
        fs::remove_file(temp.path().join("infographics/ig1.json")).unwrap();
        let errors = publication_errors(temp.path());
        assert_error(
            &errors,
            "has no top-level, non-rejected infographic manifest bound to it",
        );
    }

    #[test]
    fn publication_infographic_lineage_no_passing_critic_fails() {
        let (temp, _key) = build_publication_fixture(true, true);
        fs::write(
            temp.path().join("infographics/critics/c1.json"),
            serde_json::to_string(
                &serde_json::json!({"manifest_ref": "infographics/ig1.json", "passed": false}),
            )
            .unwrap(),
        )
        .unwrap();
        let errors = publication_errors(temp.path());
        assert_error(
            &errors,
            "upstream infographic infographics/ig1.json has no passing critic",
        );
    }

    #[test]
    fn publication_infographic_lineage_no_passing_vision_critic_fails() {
        let (temp, _key) = build_publication_fixture(true, true);
        fs::write(
            temp.path().join("infographics/vision-critics/v1.json"),
            serde_json::to_string(
                &serde_json::json!({"manifest_ref": "infographics/ig1.json", "passed": false}),
            )
            .unwrap(),
        )
        .unwrap();
        let errors = publication_errors(temp.path());
        assert_error(
            &errors,
            "upstream infographic infographics/ig1.json has no passing image-aware vision critic",
        );
    }

    #[test]
    fn publication_infographic_lineage_verifies_with_passing_critic_and_vision_critic() {
        // The positive case: build_publication_fixture's default upstream
        // infographic (a top-level, non-rejected manifest with a passing
        // critic and a passing vision critic linked by manifest_ref) must
        // not itself produce any lineage error.
        let (temp, _key) = build_publication_fixture(true, true);
        let errors = publication_errors(temp.path());
        assert!(
            errors.iter().all(|e| !e.contains("upstream infographic")),
            "{errors:?}"
        );
    }

    #[test]
    fn publication_missing_manifest_json_fails() {
        let (temp, key) = build_publication_fixture(true, true);
        fs::remove_file(
            temp.path()
                .join(format!("publications/{key}/manifest.json")),
        )
        .unwrap();
        let errors = publication_errors(temp.path());
        assert_error(&errors, "is missing manifest.json");
    }

    /// Mirrors what the runtime moves a browser-QA-FAILed publication into:
    /// publications/rejected/<k>/{index.html, manifest.json, assets/,
    /// a copy of the QA report, rejection.json}. Deliberately given a
    /// nonsensical html_sha256 - if this were ever mistakenly walked as a
    /// top-level publication it would fail loudly, so an empty error list
    /// in tests using it is proof the directory was skipped, not that it
    /// happened to pass.
    fn add_rejected_publication(root: &Path) {
        let dir = root.join("publications/rejected/deadbeef");
        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::write(dir.join("index.html"), "<html>rejected</html>").unwrap();
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_string(&serde_json::json!({
                "html_ref": "publications/rejected/deadbeef/index.html",
                "html_sha256": "not-even-a-real-hash",
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join("rejection.json"),
            serde_json::to_string(&serde_json::json!({"reason": "browser QA FAIL"})).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn publication_rejected_directory_does_not_block_verification() {
        let (temp, _key) = build_publication_fixture(true, true);
        add_rejected_publication(temp.path());
        let errors = publication_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn publication_next_to_rejected_directory_is_still_checked() {
        let (temp, key) = build_publication_fixture(true, true);
        add_rejected_publication(temp.path());
        fs::write(
            temp.path().join(format!("publications/{key}/index.html")),
            "<html>tampered</html>",
        )
        .unwrap();
        let errors = publication_errors(temp.path());
        assert_error(&errors, "html_sha256 mismatch");
    }

    /// Writes an additional publications/qa/<key_dir_name>/browser-qa.json
    /// (with real screenshot/archive files) linked to html_sha256 by
    /// content hash, alongside whatever build_publication_fixture already
    /// wrote.
    fn add_qa_report(root: &Path, key_dir_name: &str, html_sha256: &str, status: &str) {
        let dir = root.join("publications/qa").join(key_dir_name);
        fs::create_dir_all(&dir).unwrap();
        let shot_bytes = b"fake-screenshot-bytes";
        let shot_sha = sha256_bytes(shot_bytes);
        fs::write(dir.join("publication-1440.png"), shot_bytes).unwrap();
        fs::write(dir.join("archive.png"), shot_bytes).unwrap();
        fs::write(
            dir.join("browser-qa.json"),
            serde_json::to_string(&serde_json::json!({
                "html_sha256": html_sha256,
                "status": status,
                "screenshots": [{"width": 1440, "path": "publication-1440.png", "sha256": shot_sha}],
                "archive_fallback": {"path": "archive.png", "sha256": shot_sha, "source_width": 1440},
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn publication_fail_and_pass_reports_fail_when_fail_sorts_first() {
        let (temp, key) = build_publication_fixture(true, false);
        add_qa_report(temp.path(), "a-fail", &key, "FAIL");
        add_qa_report(temp.path(), "b-pass", &key, "PASS");
        let errors = publication_errors(temp.path());
        assert_error(&errors, "has no passing browser QA report");
    }

    #[test]
    fn publication_fail_and_pass_reports_fail_when_pass_sorts_first() {
        let (temp, key) = build_publication_fixture(true, false);
        add_qa_report(temp.path(), "a-pass", &key, "PASS");
        add_qa_report(temp.path(), "b-fail", &key, "FAIL");
        let errors = publication_errors(temp.path());
        assert_error(&errors, "has no passing browser QA report");
    }

    fn delivered_artifact_errors(root: &Path, primary_artifact: Value) -> Vec<String> {
        let mut report = VerificationReport::default();
        let story = serde_json::json!({"delivery": {"primary_artifact": primary_artifact}});
        verify_delivered_artifact(root, &story, &mut report).unwrap();
        report.errors
    }

    #[test]
    fn delivered_artifact_null_or_absent_is_not_checked() {
        let temp = tempfile::tempdir().unwrap();
        let mut report = VerificationReport::default();
        verify_delivered_artifact(
            temp.path(),
            &serde_json::json!({"delivery": {}}),
            &mut report,
        )
        .unwrap();
        verify_delivered_artifact(
            temp.path(),
            &serde_json::json!({"delivery": {"primary_artifact": null}}),
            &mut report,
        )
        .unwrap();
        assert_eq!(report.checks, 0);
        assert!(report.errors.is_empty());
    }

    #[test]
    fn delivered_artifact_publication_html_ref_binding_verifies() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("publications/k1")).unwrap();
        fs::write(
            root.join("publications/k1/manifest.json"),
            serde_json::to_string(&serde_json::json!({"html_ref": "publications/k1/index.html"}))
                .unwrap(),
        )
        .unwrap();
        let errors =
            delivered_artifact_errors(root, serde_json::json!("publications/k1/index.html"));
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn delivered_artifact_publication_without_matching_manifest_fails() {
        let temp = tempfile::tempdir().unwrap();
        let errors =
            delivered_artifact_errors(temp.path(), serde_json::json!("publications/k1/index.html"));
        assert_error(
            &errors,
            "delivered artifact publications/k1/index.html is not backed by a verified manifest",
        );
    }

    #[test]
    fn delivered_artifact_reserved_directory_name_is_not_a_valid_publication_key() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        // Same shape a publications/<k>/index.html binding would have, but
        // k is a reserved directory name (qa/plans/rejected), not a real
        // publication key.
        fs::create_dir_all(root.join("publications/qa")).unwrap();
        fs::write(
            root.join("publications/qa/manifest.json"),
            serde_json::to_string(&serde_json::json!({"html_ref": "publications/qa/index.html"}))
                .unwrap(),
        )
        .unwrap();
        let errors =
            delivered_artifact_errors(root, serde_json::json!("publications/qa/index.html"));
        assert_error(&errors, "is not backed by a verified manifest");
    }

    #[test]
    fn delivered_artifact_under_rejected_fails() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("publications/rejected/k1")).unwrap();
        fs::write(
            root.join("publications/rejected/k1/manifest.json"),
            serde_json::to_string(
                &serde_json::json!({"html_ref": "publications/rejected/k1/index.html"}),
            )
            .unwrap(),
        )
        .unwrap();
        let errors = delivered_artifact_errors(
            root,
            serde_json::json!("publications/rejected/k1/index.html"),
        );
        assert_error(&errors, "is not backed by a verified manifest");
    }

    #[test]
    fn delivered_artifact_svg_variant_binding_verifies() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("visualizations")).unwrap();
        fs::write(root.join("visualizations/x.svg"), "<svg></svg>").unwrap();
        fs::write(
            root.join("visualizations/x.json"),
            serde_json::to_string(&serde_json::json!({
                "variants": {"desktop": "visualizations/x.svg"},
            }))
            .unwrap(),
        )
        .unwrap();
        let errors = delivered_artifact_errors(root, serde_json::json!("visualizations/x.svg"));
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn delivered_artifact_top_level_svg_field_binding_verifies() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("infographics")).unwrap();
        fs::create_dir_all(root.join("visualizations")).unwrap();
        fs::write(
            root.join("infographics/x.json"),
            serde_json::to_string(&serde_json::json!({"svg": "visualizations/x.svg"})).unwrap(),
        )
        .unwrap();
        let errors = delivered_artifact_errors(root, serde_json::json!("visualizations/x.svg"));
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn delivered_artifact_orphan_svg_fails() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("visualizations")).unwrap();
        fs::write(root.join("visualizations/orphan.svg"), "<svg></svg>").unwrap();
        let errors =
            delivered_artifact_errors(root, serde_json::json!("visualizations/orphan.svg"));
        assert_error(
            &errors,
            "delivered artifact visualizations/orphan.svg is not backed by a verified manifest",
        );
    }

    #[test]
    fn delivered_artifact_non_top_level_manifest_does_not_count() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("visualizations/illustrations")).unwrap();
        fs::write(
            root.join("visualizations/illustrations/x.json"),
            serde_json::to_string(&serde_json::json!({
                "variants": {"desktop": "visualizations/illustrations/x.svg"},
            }))
            .unwrap(),
        )
        .unwrap();
        let errors = delivered_artifact_errors(
            root,
            serde_json::json!("visualizations/illustrations/x.svg"),
        );
        assert_error(&errors, "is not backed by a verified manifest");
    }

    fn set_infographic_schema_version(root: &Path, schema_version: &str) {
        let manifest_path = root.join("infographics/x.json");
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest["schema_version"] = Value::String(schema_version.to_owned());
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
    }

    #[test]
    fn infographic_1_4_0_without_passing_critic_fails() {
        // Before F7, Python's version gate only recognized up to 1.3.0 and
        // silently `continue`d past anything else, so a 1.4.0 page with no
        // critic at all used to verify clean. infographic.mjs's own
        // INFOGRAPHIC_SCHEMA_VERSIONS accepts 1.4.0, and
        // newsroom_infographic_render copies schema_version straight from
        // the spec, so this is a completely ordinary, real manifest shape.
        let temp = build_infographic_fixture(true, true);
        set_infographic_schema_version(temp.path(), "1.4.0");
        fs::remove_file(temp.path().join("infographics/critics/x.json")).unwrap();
        let errors = infographic_errors(temp.path());
        assert_error(&errors, "has no critic artifact");
    }

    #[test]
    fn infographic_unsupported_schema_version_fails() {
        let temp = build_infographic_fixture(true, true);
        set_infographic_schema_version(temp.path(), "1.6.0");
        let errors = infographic_errors(temp.path());
        assert_error(&errors, "has an unsupported schema_version: 1.6.0");
    }

    #[test]
    fn infographic_missing_plan_ref_fails_as_not_gated() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("infographics")).unwrap();
        fs::write(
            root.join("infographics/x.json"),
            serde_json::to_string(&serde_json::json!({
                "schema_version": "1.0.0",
                "lint_ref": "infographics/lints/x.json",
                "variants": {"desktop": "infographics/x.svg"},
            }))
            .unwrap(),
        )
        .unwrap();
        let errors = infographic_errors(root);
        assert_error(
            &errors,
            "is not a gated infographic manifest (no plan_ref/lint_ref/variants)",
        );
    }

    #[test]
    fn infographic_1_4_0_clean_control_verifies() {
        let temp = build_infographic_fixture(true, true);
        set_infographic_schema_version(temp.path(), "1.4.0");
        let critic_path = temp.path().join("infographics/critics/x.json");
        let mut critic: Value =
            serde_json::from_str(&fs::read_to_string(&critic_path).unwrap()).unwrap();
        critic["rubric"] = serde_json::json!({
            "impact_story_focus": 90, "engagement": 90, "clarity_information_flow": 90,
            "effectiveness": 90, "hierarchy": 90, "editorial_rhythm": 90,
            "inclusion_accessibility": 90, "responsive_execution": 90, "craft_geometry": 90,
            "originality_variety": 90,
        });
        fs::write(&critic_path, serde_json::to_string(&critic).unwrap()).unwrap();
        let errors = infographic_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn infographic_1_4_0_critic_missing_rubric_dimensions_fails() {
        // 1.4.0 now requires the same award-informed rubric dimensions as
        // 1.1.0/1.2.0, matching critiqueInfographic's own version dispatch
        // in infographic.mjs - build_infographic_fixture's default critic
        // has an empty rubric object.
        let temp = build_infographic_fixture(true, true);
        set_infographic_schema_version(temp.path(), "1.4.0");
        let errors = infographic_errors(temp.path());
        assert_error(&errors, "critic missing award-informed rubric dimensions");
    }

    fn source_errors(root: &Path) -> Vec<String> {
        let mut report = VerificationReport::default();
        verify_sources(root, &mut report).unwrap();
        report.errors
    }

    /// Writes a sources/<hash>.json fixture using the exact 5-field payload
    /// verify_sources recomputes (content_type, final_url, status, text,
    /// truncated). This is the same hash formula runtime/pi/provenance.mjs's
    /// sourceContentHash uses, so these tests exercise the real hash-binding
    /// path that fetch_url's PDF extraction (runtime/pi/pdf_extract.mjs) now
    /// feeds into - extraction metadata (tool/version/pages, or an
    /// unavailable_reason) sits outside the hashed payload, exactly like the
    /// pre-existing trust/schema_version fields do.
    fn write_pdf_source(root: &Path, text: &str, extraction: Value, truncated: bool) -> String {
        fs::create_dir_all(root.join("sources")).unwrap();
        let payload = serde_json::json!({
            "content_type": "application/pdf",
            "final_url": "https://unstats.un.org/sdgs/metadata/files/Metadata-07-02-01.pdf",
            "status": 200,
            "text": text,
            "truncated": truncated,
        });
        let hash = sha256_bytes(canonical_json(&payload).as_bytes());
        let record = serde_json::json!({
            "schema_version": "0.7.0",
            "final_url": payload["final_url"],
            "status": payload["status"],
            "content_type": payload["content_type"],
            "truncated": payload["truncated"],
            "content_hash": hash,
            "trust": "untrusted_external_content",
            "text": text,
            "extraction": extraction,
        });
        fs::write(
            root.join(format!("sources/{hash}.json")),
            serde_json::to_string_pretty(&record).unwrap(),
        )
        .unwrap();
        hash
    }

    #[test]
    fn pdf_source_with_extracted_text_and_page_markers_verifies() {
        let temp = tempfile::tempdir().unwrap();
        write_pdf_source(
            temp.path(),
            "[page 1]\nALPHA LINE ONE\n\n[page 2]\nBRAVO LINE TWO",
            serde_json::json!({"tool": "pdftotext", "version": "26.09.0", "pages": 2}),
            false,
        );
        let errors = source_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn pdf_source_unavailable_pdftotext_not_found_still_verifies() {
        // An honest "extraction was unavailable" statement is still a
        // structurally valid source record - the hash/trust/content-address
        // checks are the same regardless of why the text reads that way.
        let temp = tempfile::tempdir().unwrap();
        write_pdf_source(
            temp.path(),
            "PDF text unavailable: pdftotext_not_found",
            serde_json::json!({"tool": "pdftotext", "unavailable_reason": "pdftotext_not_found"}),
            false,
        );
        let errors = source_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn pdf_source_unavailable_pdf_truncated_still_verifies() {
        let temp = tempfile::tempdir().unwrap();
        write_pdf_source(
            temp.path(),
            "PDF text unavailable: pdf_truncated",
            serde_json::json!({"tool": "pdftotext", "unavailable_reason": "pdf_truncated"}),
            true,
        );
        let errors = source_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn pdf_source_tampered_after_hashing_fails() {
        let temp = tempfile::tempdir().unwrap();
        let hash = write_pdf_source(
            temp.path(),
            "[page 1]\nALPHA LINE ONE\n\n[page 2]\nBRAVO LINE TWO",
            serde_json::json!({"tool": "pdftotext", "version": "26.09.0", "pages": 2}),
            false,
        );
        let path = temp.path().join(format!("sources/{hash}.json"));
        let mut record: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        record["text"] = serde_json::json!("[page 1]\nTAMPERED\n\n[page 2]\nBRAVO LINE TWO");
        fs::write(&path, serde_json::to_string_pretty(&record).unwrap()).unwrap();
        let errors = source_errors(temp.path());
        assert_error(&errors, "source content_hash mismatch");
    }
}
