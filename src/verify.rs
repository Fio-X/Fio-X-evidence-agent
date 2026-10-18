use crate::hash::{sha256_bytes, sha256_file};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
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

/// Switch for the stricter readers: a choropleth data-value that is not a finite number fails its region, and an unreadable browser QA report fails the publication instead of being skipped. Exact "1" only.
fn strict_readers() -> bool {
    std::env::var("NEWSROOM_VERIFY_STRICT_READERS").as_deref() == Ok("1")
}

/// Switch for refusing a claim reference or story evidence item that is not a string. Exact "1" only; off keeps the old skip.
fn strict_ref_types() -> bool {
    std::env::var("NEWSROOM_VERIFY_STRICT_REFS").as_deref() == Ok("1")
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
                for (index, item) in items.iter().enumerate() {
                    let Some(reference) = item.as_str() else {
                        if strict_ref_types() {
                            report.error(format!(
                                "story evidence.{kind}[{index}] must be a non-empty string"
                            ));
                        }
                        continue;
                    };
                    match safe_ref(root, reference) {
                        Ok(path) => report.check(
                            path.is_file(),
                            format!("story evidence.{kind} references missing file: {reference}"),
                        ),
                        Err(error) => report.error(format!(
                            "story evidence.{kind} contains unsafe ref {reference}: {error}"
                        )),
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

    record_only_verify(root, &story);
    report.passed = report.errors.is_empty();
    Ok(report)
}

/// The compact form of JSON text: whitespace outside strings dropped, every
/// string and key order untouched.
fn minified_json_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let (mut in_string, mut escaped) = (false, false);
    for ch in text.chars() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            out.push(ch);
        } else if !matches!(ch, ' ' | '\t' | '\r' | '\n') {
            out.push(ch);
        }
    }
    out
}

/// Side file shadow/record_<kind>-<key>.json, written once; never read by any
/// check and never an error.
fn write_record_only(root: &Path, kind: &str, key_inputs: Value, record: Value) {
    let mut keyed = serde_json::Map::new();
    keyed.insert("kind".to_string(), Value::String(kind.to_string()));
    if let Value::Object(inputs) = key_inputs {
        for (name, value) in inputs {
            keyed.insert(name, value);
        }
    }
    let key = sha256_bytes(Value::Object(keyed).to_string().as_bytes());
    let mut body = serde_json::Map::new();
    body.insert(
        "schema_version".to_string(),
        Value::String("0.1.0".to_string()),
    );
    body.insert("kind".to_string(), Value::String(format!("record_{kind}")));
    body.insert("key".to_string(), Value::String(key.clone()));
    if let Value::Object(fields) = record {
        for (name, value) in fields {
            body.insert(name, value);
        }
    }
    let dir = root.join("shadow");
    let Ok(text) = serde_json::to_string_pretty(&Value::Object(body)) else {
        return;
    };
    // shadow/ is the knowledge group's: the post-run verify inside investigate / continue asks the shadow writer, a direct `news verify` writes as itself
    crate::group_guard::as_shadow_writer(|| {
        if crate::group_guard::create_dir_all(root, &dir).is_err() {
            return;
        }
        if let Ok(mut file) =
            crate::group_guard::create_new(root, &dir.join(format!("record_{kind}-{key}.json")))
        {
            use std::io::Write;
            let _ = file.write_all(format!("{text}\n").as_bytes());
        }
    });
}

/// NEWSROOM_RECORD_THIN_RESULT=1 and NEWSROOM_RECORD_ORIGIN_HASH=1 (exact,
/// default off). Record only: no check, error, warning, output or exit code
/// changes. Mirrors verify_artifact.py's record_only_verify.
fn record_only_verify(root: &Path, story: &Value) {
    if std::env::var("NEWSROOM_RECORD_THIN_RESULT").as_deref() == Ok("1") {
        let delivered = story
            .get("delivery")
            .and_then(|delivery| delivery.get("primary_artifact"))
            .map(|value| !value.is_null())
            .unwrap_or(false);
        let inputs: Vec<(&str, bool)> = vec![
            ("computations", root.join("computations").is_dir()),
            ("claims", root.join("claims.jsonl").is_file()),
            ("data", root.join("data").is_dir()),
            ("delivered_artifact", delivered),
            ("infographics", root.join("infographics").is_dir()),
            ("publications", root.join("publications").is_dir()),
            ("sources", root.join("sources").is_dir()),
            ("visualizations", root.join("visualizations").is_dir()),
        ];
        let present: serde_json::Map<String, Value> = inputs
            .iter()
            .map(|(name, on)| (name.to_string(), Value::Bool(*on)))
            .collect();
        let mut skipped: Vec<Value> = inputs
            .iter()
            .filter(|(_, on)| !*on)
            .map(|(name, _)| Value::String(name.to_string()))
            .collect();
        skipped.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        let thin = skipped.len() == inputs.len();
        write_record_only(
            root,
            "thin_result",
            serde_json::json!({ "inputs": present }),
            serde_json::json!({
                "inputs_present": present,
                "checks_skipped_for_absent_input": skipped,
                "counts": { "skipped": skipped.len(), "thin_result": if thin { 1 } else { 0 } },
                "thin_result": thin,
            }),
        );
    }
    if std::env::var("NEWSROOM_RECORD_ORIGIN_HASH").as_deref() == Ok("1") {
        let origin_dir = root.join("data").join("origins");
        let mut findings: Vec<Value> = Vec::new();
        let mut checked = 0usize;
        if let Ok(read) = fs::read_dir(&origin_dir) {
            let mut paths: Vec<PathBuf> = read
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().and_then(|v| v.to_str()) == Some("json"))
                .collect();
            paths.sort();
            for path in paths {
                let Ok(text) = fs::read_to_string(&path) else {
                    continue;
                };
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                checked += 1;
                let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
                if sha256_bytes(minified_json_text(&text).as_bytes()) != stem {
                    findings.push(serde_json::json!({ "origin": relative, "reason": "record hash differs from its file name" }));
                }
                if let Ok(origin) = serde_json::from_str::<Value>(&text) {
                    if let (Some(reference), Some(expected)) = (
                        origin.get("file").and_then(Value::as_str),
                        origin.get("sha256").and_then(Value::as_str),
                    ) {
                        if let Ok(payload) = safe_ref(root, reference) {
                            if payload.is_file()
                                && sha256_file(&payload)
                                    .map(|actual| actual != expected)
                                    .unwrap_or(false)
                            {
                                findings.push(serde_json::json!({ "origin": relative, "reason": "data file hash differs (already refused by the existing check)" }));
                            }
                        }
                    }
                }
            }
        }
        write_record_only(
            root,
            "origin_hash",
            serde_json::json!({ "origins": checked, "findings": findings }),
            serde_json::json!({ "counts": { "origins": checked, "mismatches": findings.len() }, "findings": findings }),
        );
    }
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
    for path in sorted_dir_paths(&data_dir)? {
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
    for path in sorted_dir_paths(&data_dir)? {
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
        if meta.get("served_from").and_then(Value::as_str) == Some("frozen_copy") {
            // Frozen data is replay data, never live evidence and never a pass: a warning with the replay switch on, an error otherwise.
            let line = format!(
                "data served from a frozen copy: {}",
                reference.unwrap_or("<unknown file>")
            );
            if std::env::var("NEWSROOM_DOWNLOAD_FROZEN").as_deref() == Ok("1") {
                report.warnings.push(line);
            } else {
                report.error(line);
            }
        }
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
    verify_derived_tables(root, report);
    let origin_dir = data_dir.join("origins");
    if origin_dir.is_dir() {
        for path in sorted_dir_paths(&origin_dir)? {
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
    for path in sorted_dir_paths(dir)? {
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
    for path in sorted_dir_paths(&dir)? {
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
            verify_computation_read_inputs(root, &path, &value, report);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Read-input binding (issue #36). Mirrors runtime/pi/computation_rows.mjs: a
// computation only supports a claim when the files its SQL really reads
// (recorded as `read_inputs`, re-derivable with DuckDB) include data/ or
// sources/ artifacts the claim cites. Literal-only (VALUES, constants,
// generate_series), unresolved and legacy (unrecorded) computations never do.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputBinding {
    Legacy,
    SourceBound,
    LiteralOnly,
    Unresolved,
}

impl InputBinding {
    fn label(self) -> &'static str {
        match self {
            InputBinding::Legacy => "legacy",
            InputBinding::SourceBound => "source_bound",
            InputBinding::LiteralOnly => "literal_only",
            InputBinding::Unresolved => "unresolved",
        }
    }
}

const MAX_CHAIN_DEPTH: usize = 16;
const FILE_READER_FUNCTIONS: &[&str] = &[
    "read_csv",
    "read_csv_auto",
    "read_json",
    "read_json_auto",
    "read_ndjson",
    "read_ndjson_auto",
    "read_json_objects",
    "read_json_objects_auto",
    "read_ndjson_objects",
    "read_parquet",
    "parquet_scan",
    "read_text",
    "read_blob",
    "parquet_metadata",
    "parquet_schema",
    "parquet_file_metadata",
    "parquet_kv_metadata",
    "sniff_csv",
];
const LITERAL_TABLE_FUNCTIONS: &[&str] = &[
    "range",
    "generate_series",
    "unnest",
    "repeat_row",
    "generate_subscripts",
    "json_each",
    "json_tree",
];

fn is_computation_path(path: &str) -> bool {
    path.strip_prefix("computations/")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn canonical_input_path(raw: &str) -> Option<String> {
    if raw.is_empty()
        || raw.len() > 512
        || !raw
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte))
        || raw.starts_with('/')
        || raw.contains("//")
        || raw.ends_with('/')
        || raw
            .split('/')
            .any(|segment| segment == "." || segment == "..")
    {
        return None;
    }
    if raw.starts_with("data/") || raw.starts_with("sources/") || is_computation_path(raw) {
        Some(raw.to_owned())
    } else {
        None
    }
}

fn constant_strings(expr: &Value) -> Option<Vec<String>> {
    match expr.get("class").and_then(Value::as_str)? {
        "CONSTANT" => {
            let value = expr.get("value")?;
            if value.get("is_null").and_then(Value::as_bool) == Some(false)
                && value.pointer("/type/id").and_then(Value::as_str) == Some("VARCHAR")
            {
                Some(vec![value.get("value")?.as_str()?.to_owned()])
            } else {
                None
            }
        }
        "FUNCTION" if expr.get("function_name").and_then(Value::as_str) == Some("list_value") => {
            let children = expr.get("children")?.as_array()?;
            if children.is_empty() {
                return None;
            }
            let mut out = Vec::new();
            for child in children {
                let inner = constant_strings(child)?;
                if inner.len() != 1 {
                    return None;
                }
                out.push(inner.into_iter().next()?);
            }
            Some(out)
        }
        _ => None,
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct SqlReads {
    paths: Vec<String>,
    unresolved: Vec<String>,
}

fn collect_cte_names(node: &Value, names: &mut HashSet<String>) {
    match node {
        Value::Array(items) => items.iter().for_each(|item| collect_cte_names(item, names)),
        Value::Object(map) => {
            if let Some(entries) = map
                .get("cte_map")
                .and_then(|v| v.get("map"))
                .and_then(Value::as_array)
            {
                for entry in entries {
                    if let Some(key) = entry.get("key").and_then(Value::as_str) {
                        names.insert(key.to_owned());
                    }
                }
            }
            map.values()
                .for_each(|value| collect_cte_names(value, names));
        }
        _ => {}
    }
}

fn walk_sql_reads(
    node: &Value,
    ctes: &HashSet<String>,
    paths: &mut std::collections::BTreeSet<String>,
    unresolved: &mut std::collections::BTreeSet<String>,
) {
    match node {
        Value::Array(items) => items
            .iter()
            .for_each(|item| walk_sql_reads(item, ctes, paths, unresolved)),
        Value::Object(map) => {
            match map.get("type").and_then(Value::as_str) {
                Some("BASE_TABLE") => {
                    let table = map.get("table_name").and_then(Value::as_str).unwrap_or("");
                    let qualified = map
                        .get("schema_name")
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.is_empty())
                        || map
                            .get("catalog_name")
                            .and_then(Value::as_str)
                            .is_some_and(|v| !v.is_empty());
                    if !qualified
                        && !ctes.contains(table)
                        && table.contains(['/', '.', '*', '\\', ':'])
                    {
                        match canonical_input_path(table) {
                            Some(path) => {
                                paths.insert(path);
                            }
                            None => {
                                unresolved.insert(
                                    "table reference is not a plain data/, sources/ or computations/ path"
                                        .to_owned(),
                                );
                            }
                        }
                    }
                }
                Some("TABLE_FUNCTION") => {
                    let function = map.get("function").cloned().unwrap_or(Value::Null);
                    let name = function
                        .get("function_name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if FILE_READER_FUNCTIONS.contains(&name.as_str()) {
                        let positional: Vec<&Value> = function
                            .get("children")
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter(|child| {
                                        child
                                            .get("alias")
                                            .and_then(Value::as_str)
                                            .is_none_or(str::is_empty)
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let listed = if positional.len() == 1 {
                            constant_strings(positional[0])
                        } else {
                            None
                        };
                        match listed {
                            None => {
                                unresolved.insert(format!(
                                    "{name}: path is not a single constant string or list"
                                ));
                            }
                            Some(raws) => {
                                for raw in raws {
                                    match canonical_input_path(&raw) {
                                        Some(path) => {
                                            paths.insert(path);
                                        }
                                        None => {
                                            unresolved.insert(format!(
                                                "{name}: path is not a plain data/, sources/ or computations/ path"
                                            ));
                                        }
                                    }
                                }
                            }
                        }
                    } else if !LITERAL_TABLE_FUNCTIONS.contains(&name.as_str()) {
                        unresolved.insert(format!("table function {name} is not recognized"));
                    }
                }
                _ => {}
            }
            map.values()
                .for_each(|value| walk_sql_reads(value, ctes, paths, unresolved));
        }
        _ => {}
    }
}

/// Pure walk of a `json_serialize_sql` document.
fn collect_sql_reads(ast: &Value) -> SqlReads {
    let single = ast.get("error").and_then(Value::as_bool) == Some(false)
        && ast
            .get("statements")
            .and_then(Value::as_array)
            .is_some_and(|statements| statements.len() == 1);
    if !single {
        return SqlReads {
            paths: Vec::new(),
            unresolved: vec!["SQL is not a single serializable SELECT statement".to_owned()],
        };
    }
    let mut ctes = HashSet::new();
    collect_cte_names(ast, &mut ctes);
    let mut paths = std::collections::BTreeSet::new();
    let mut unresolved = std::collections::BTreeSet::new();
    walk_sql_reads(ast, &ctes, &mut paths, &mut unresolved);
    SqlReads {
        paths: paths.into_iter().collect(),
        unresolved: unresolved.into_iter().collect(),
    }
}

const DERIVED_PREFIX: &str = "data/derived/";

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `data/derived/<sha>.pdf-rows.json` -> `<sha>` when the path has that shape.
fn derived_rows_sha(path: &str) -> Option<&str> {
    path.strip_prefix(DERIVED_PREFIX)?
        .strip_suffix(".pdf-rows.json")
        .filter(|sha| is_hex64(sha))
}

/// Verify the chain of a derived PDF row table, recomputed from bytes on disk:
/// rows file hash == meta.rows_sha256; meta.source_sha256 == sha256 of the PDF
/// data file it names; and a download record binds that PDF to this table.
/// Returns the source PDF path on success.
fn verify_derived_input(root: &Path, path: &str) -> std::result::Result<String, String> {
    let sha = derived_rows_sha(path).ok_or("not a recognised derived table path")?;
    let rows_hash =
        sha256_file(&root.join(path)).map_err(|e| format!("derived table unreadable: {e}"))?;
    let meta_path = root.join(path.trim_end_matches(".json").to_owned() + ".meta.json");
    let meta = read_json(&meta_path).map_err(|e| format!("derived metadata unreadable: {e}"))?;
    let text = |key: &str| meta.get(key).and_then(Value::as_str).unwrap_or("");
    if text("kind") != "pdf_row_table" || text("rows_file") != path {
        return Err("derived metadata does not describe this table".into());
    }
    if rows_hash != text("rows_sha256") {
        return Err("derived table bytes do not match rows_sha256".into());
    }
    if text("source_sha256") != sha {
        return Err("derived table is not named for its source sha256".into());
    }
    let source = text("source_file");
    let in_data = source
        .strip_prefix("data/")
        .is_some_and(|rest| !rest.contains('/'));
    if !in_data
        || !source
            .rsplit('/')
            .next()
            .unwrap_or("")
            .starts_with(&format!("{sha}."))
    {
        return Err("source_file is not the content-addressed PDF".into());
    }
    let source_hash =
        sha256_file(&root.join(source)).map_err(|e| format!("source PDF unreadable: {e}"))?;
    if source_hash != sha {
        return Err("source PDF bytes do not match source_sha256".into());
    }
    let origins = fs::read_dir(root.join("data").join("origins"))
        .map_err(|e| format!("no download records: {e}"))?;
    for entry in origins.flatten() {
        let origin_path = entry.path();
        if origin_path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let Ok(origin) = read_json(&origin_path) else {
            continue;
        };
        let derived = origin.get("derived_text");
        if origin.get("file").and_then(Value::as_str) == Some(source)
            && origin.get("sha256").and_then(Value::as_str) == Some(sha)
            && derived.and_then(|d| d.get("file")).and_then(Value::as_str) == Some(path)
            && derived
                .and_then(|d| d.get("rows_sha256"))
                .and_then(Value::as_str)
                == Some(rows_hash.as_str())
        {
            return Ok(source.to_owned());
        }
    }
    Err("no download record binds this table to the PDF".into())
}

/// Every table under data/derived/ must pass the chain check, so an altered
/// or orphaned derived file is reported even when no computation reads it.
fn verify_derived_tables(root: &Path, report: &mut VerificationReport) {
    let Ok(entries) = fs::read_dir(root.join("data").join("derived")) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".pdf-rows.meta.json") {
            continue;
        }
        let rel = format!("{DERIVED_PREFIX}{name}");
        if let Err(reason) = verify_derived_input(root, &rel) {
            report.error(format!(
                "derived table {rel} failed its provenance chain: {reason}"
            ));
        }
    }
}

/// Classify a set of directly read paths, following chained computations.
fn classify_inputs(
    root: &Path,
    paths: &[String],
    had_unresolved: bool,
    depth: usize,
    seen: &[String],
) -> (InputBinding, std::collections::BTreeSet<String>) {
    let mut effective = std::collections::BTreeSet::new();
    let mut unresolved = had_unresolved;
    for path in paths {
        if path.starts_with(DERIVED_PREFIX) {
            // A derived table is evidence only while its chain to the
            // downloaded PDF verifies; anything else under data/derived/ is
            // unresolved (fails closed).
            match verify_derived_input(root, path) {
                Ok(source_file) => {
                    effective.insert(path.clone());
                    effective.insert(source_file);
                }
                Err(_) => unresolved = true,
            }
            continue;
        }
        if path.starts_with("data/") || path.starts_with("sources/") {
            effective.insert(path.clone());
            continue;
        }
        if !is_computation_path(path) || seen.contains(path) || depth >= MAX_CHAIN_DEPTH {
            unresolved = true;
            continue;
        }
        let dependency = read_json(&root.join(path)).unwrap_or(Value::Null);
        let mut chain = seen.to_vec();
        chain.push(path.clone());
        let (binding, inner) = recorded_input_state(root, &dependency, depth + 1, &chain);
        if matches!(binding, InputBinding::Legacy | InputBinding::Unresolved) {
            unresolved = true;
        }
        effective.extend(inner);
    }
    let binding = if unresolved {
        InputBinding::Unresolved
    } else if effective.is_empty() {
        InputBinding::LiteralOnly
    } else {
        InputBinding::SourceBound
    };
    (binding, effective)
}

fn recorded_read_paths(record: &Value) -> Option<Vec<String>> {
    let items = record.get("read_inputs")?.as_array()?;
    Some(
        items
            .iter()
            .map(|item| {
                item.get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            })
            .collect(),
    )
}

fn recorded_binding_label(record: &Value) -> Option<InputBinding> {
    match record.get("input_binding").and_then(Value::as_str)? {
        "source_bound" => Some(InputBinding::SourceBound),
        "literal_only" => Some(InputBinding::LiteralOnly),
        "unresolved" => Some(InputBinding::Unresolved),
        _ => None,
    }
}

/// Binding implied by what a stored record says it read.
fn recorded_input_state(
    root: &Path,
    record: &Value,
    depth: usize,
    seen: &[String],
) -> (InputBinding, std::collections::BTreeSet<String>) {
    let (Some(paths), Some(label)) = (recorded_read_paths(record), recorded_binding_label(record))
    else {
        return (InputBinding::Legacy, Default::default());
    };
    if depth > MAX_CHAIN_DEPTH {
        return (InputBinding::Unresolved, Default::default());
    }
    classify_inputs(root, &paths, label == InputBinding::Unresolved, depth, seen)
}

/// Record-level checks for computations that carry read_inputs (new builds).
/// Legacy records are not rewritten or flagged here; claims resting on them are
/// judged in `verify_claims`.
fn verify_computation_read_inputs(
    root: &Path,
    path: &Path,
    value: &Value,
    report: &mut VerificationReport,
) {
    let has_inputs = value.get("read_inputs").is_some();
    let has_binding = value.get("input_binding").is_some();
    if !has_inputs && !has_binding {
        return;
    }
    let name = path.display();
    let (Some(items), Some(label)) = (
        value.get("read_inputs").and_then(Value::as_array),
        recorded_binding_label(value),
    ) else {
        report.error(format!(
            "computation {name} must carry both a valid read_inputs array and input_binding"
        ));
        return;
    };
    let mut listed: Vec<String> = Vec::new();
    let mut shape_ok = true;
    for item in items {
        let input_path = item.get("path").and_then(Value::as_str).unwrap_or("");
        let sha = item.get("sha256").and_then(Value::as_str).unwrap_or("");
        let canonical = canonical_input_path(input_path);
        if canonical.is_none() || sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            report.error(format!(
                "computation {name} has an invalid read_inputs entry: {input_path}"
            ));
            shape_ok = false;
            continue;
        }
        listed.push(input_path.to_owned());
        match sha256_file(&root.join(input_path)) {
            Ok(actual) => report.check(
                actual == sha,
                format!("computation {name} read input {input_path} no longer matches its recorded sha256"),
            ),
            Err(_) => report.error(format!(
                "computation {name} read input {input_path} is missing"
            )),
        }
    }
    let mut sorted = listed.clone();
    sorted.sort();
    sorted.dedup();
    report.check(
        listed == sorted,
        format!("read_inputs must be sorted and unique: {name}"),
    );
    if !shape_ok {
        return;
    }
    let (implied, _) = classify_inputs(root, &listed, label == InputBinding::Unresolved, 0, &[]);
    report.check(
        implied == label,
        format!(
            "computation {name} input_binding {} does not match its read_inputs ({})",
            label.label(),
            implied.label()
        ),
    );
}

/// A verified claim may rest only on computations that read, at run time, at
/// least one cited data/ or sources/ artifact.
fn verify_claim_computation_binding(
    root: &Path,
    line_no: usize,
    source_refs: &[String],
    computation_ref: &str,
    report: &mut VerificationReport,
) {
    let Ok(path) = safe_ref(root, computation_ref) else {
        return;
    };
    let Ok(record) = read_json(&path) else {
        report.error(format!(
            "COMPUTATION_PROVENANCE_REQUIRED: computation {computation_ref} cited by verified claim on line {} is unreadable",
            line_no + 1
        ));
        return;
    };
    let (binding, effective) =
        recorded_input_state(root, &record, 0, &[computation_ref.to_owned()]);
    if binding != InputBinding::SourceBound {
        report.error(format!(
            "COMPUTATION_PROVENANCE_REQUIRED: verified claim on line {} rests on computation {computation_ref} whose recorded inputs are {}; literal-only, unresolved or unrecorded (legacy) computations cannot verify a claim",
            line_no + 1,
            binding.label()
        ));
        return;
    }
    report.check(
        source_refs.iter().any(|source| effective.contains(source)),
        format!(
            "COMPUTATION_PROVENANCE_REQUIRED: verified claim on line {} cites no source read by computation {computation_ref}",
            line_no + 1
        ),
    );
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
        let has_claim_id = claim.is_object()
            && claim
                .get("claim_id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty());
        if !has_claim_id {
            report.error(format!(
                "claims.jsonl line {} is not a claim record with a non-empty string claim_id",
                line_no + 1
            ));
            continue;
        }
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
        let cited_sources: Vec<String> = source_refs
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect();
        for (index, item) in source_refs.iter().enumerate() {
            let Some(reference) = item.as_str() else {
                if strict_ref_types() {
                    report.error(format!(
                        "verified claim on line {} source_refs[{index}] must be a non-empty string",
                        line_no + 1
                    ));
                }
                continue;
            };
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
        for (index, item) in computation_refs.iter().enumerate() {
            let Some(reference) = item.as_str() else {
                if strict_ref_types() {
                    report.error(format!(
                        "verified claim on line {} computation_refs[{index}] must be a non-empty string",
                        line_no + 1
                    ));
                }
                continue;
            };
            if !reference.starts_with("computations/") {
                report.error(format!(
                    "verified claim computation ref must be under computations/: {reference}"
                ));
                continue;
            }
            verify_claim_computation_binding(root, line_no, &cited_sources, reference, report);
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
    Ok(())
}

fn verify_visualizations(root: &Path, report: &mut VerificationReport) -> Result<()> {
    let dir = root.join("visualizations");
    if !dir.is_dir() {
        return Ok(());
    }
    let verified_claims = verified_claim_ids(root)?;
    for path in sorted_dir_paths(&dir)? {
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
            // (the runtime no longer renders one), but
            // a listed one is checked like the desktop one and bound to render
            // QA below, and nothing else may be listed.
            for key in variants.keys() {
                report.check(
                    key == "desktop" || key == "mobile" || key == "compact",
                    format!("visualization {name} lists an unknown variant: {key}"),
                );
            }
            // Optional manifest.hashes: every key present must equal the
            // sha256 of the corresponding variant file. A compact variant
            // must carry hashes.compact_sha256 (fail closed); old manifests
            // with no compact variant and no hashes are unaffected.
            let viz_hashes = manifest.get("hashes").and_then(Value::as_object);
            report.check(
                !viz_hashes
                    .map(|h| h.contains_key("compact_sha256"))
                    .unwrap_or(false)
                    || variants.contains_key("compact"),
                format!("visualization {name} has hashes.compact_sha256 without a compact variant"),
            );
            report.check(
                !variants.contains_key("compact")
                    || viz_hashes
                        .map(|h| h.contains_key("compact_sha256"))
                        .unwrap_or(false),
                format!(
                    "visualization {name} lists a compact variant without hashes.compact_sha256"
                ),
            );
            for viewport in ["desktop", "mobile", "compact"] {
                if viewport != "desktop" && !variants.contains_key(viewport) {
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
                            let hash_key = format!("{viewport}_sha256");
                            if let Some(expected) =
                                viz_hashes.and_then(|h| h.get(hash_key.as_str()))
                            {
                                match sha256_file(&svg) {
                                    Ok(actual) => report.check(
                                        expected.as_str() == Some(actual.as_str()),
                                        format!(
                                            "visualization {name} {viewport} hash mismatch against manifest.hashes.{hash_key}"
                                        ),
                                    ),
                                    Err(error) => report.error(format!(
                                        "visualization {name} failed hashing {viewport} SVG: {error}"
                                    )),
                                }
                            }
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
            let compact_ref = variants
                .and_then(|v| v.get("compact"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let split_qa_ref;
            let render_qa_ref = {
                let manifest_rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                split_qa_ref = split_render_qa_ref(
                    root,
                    "visualizations/critics",
                    &manifest_rel,
                    &manifest,
                    &format!("visualization {name}"),
                    report,
                )?;
                split_qa_ref.as_str()
            };
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
            // Heatmap proof claims are re-derived only behind NEWSROOM_HEATMAP_VALUE_LABELS=1 (exact "1").
            let is_heatmap_proof = manifest.get("chart_type").and_then(Value::as_str)
                == Some("heatmap")
                && std::env::var("NEWSROOM_HEATMAP_VALUE_LABELS").as_deref() == Ok("1");
            if draft {
                // A listed compact variant is never exempt from render QA.
                report.check(
                    !render_qa_ref.is_empty()
                        || !variants.map(|v| v.contains_key("compact")).unwrap_or(false),
                    format!("visualization {name} lists a compact variant without a render_qa_ref"),
                );
                if !render_qa_ref.is_empty() {
                    check_render_qa_ref(
                        root,
                        &format!("visualization {name}"),
                        render_qa_ref,
                        "visualizations/qa/",
                        &[
                            ("desktop", desktop_ref),
                            ("mobile", mobile_ref),
                            ("compact", compact_ref),
                        ],
                        false,
                        is_choropleth,
                        is_heatmap_proof,
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
                        &[
                            ("desktop", desktop_ref),
                            ("mobile", mobile_ref),
                            ("compact", compact_ref),
                        ],
                        true,
                        is_choropleth,
                        is_heatmap_proof,
                        report,
                    );
                }
            }
        }

        if manifest.get("chart_type").and_then(Value::as_str) == Some("symbol_map") {
            verify_symbol_map_for_manifest(root, name, &manifest, report);
        }

        if std::env::var("NEWSROOM_QA_TICK_READBACK").as_deref() == Ok("1") {
            verify_tick_readback_for_manifest(root, name, &manifest, report);
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
                return body[inner_start..inner_start + close_rel]
                    .trim()
                    .to_string();
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

/// Splits a label into its leading number, the count of decimals it shows, and what follows the number. None when there is no
/// leading number at all (missing, truncated, or a bare "…").
fn label_number_prefix(text: &str) -> Option<(f64, i32, &str)> {
    let bytes = text.as_bytes();
    let mut i = 0;
    if i < bytes.len() && bytes[i] == b'-' {
        i += 1;
    }
    let digits_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let mut decimals = 0;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            decimals += 1;
        }
    }
    if i == digits_start {
        return None;
    }
    let number: f64 = text[..i].parse().ok()?;
    Some((number, decimals, &text[i..]))
}

/// Half of one unit in the last digit a label shows, in data units: what rounding to that many decimals can move a value.
/// The slack is only float noise, so the check is the rounding rule itself, not a percentage.
fn display_half_step(decimals: i32, scale: f64, expected: f64) -> f64 {
    0.5 * 10f64.powi(-decimals) * scale + 1e-12 * expected.abs().max(1.0)
}

/// Whether a label's distance from data-value is within its half step. Written as "not beyond", the way the 1% check it
/// replaced was, so a NaN data-value (which the finite-value switch refuses on its own) is judged exactly as before.
#[allow(clippy::neg_cmp_op_on_partial_ord)] // deliberate: `!(a > b)` keeps NaN passing, as the replaced check did
fn within_half_step(distance: f64, half: f64) -> bool {
    !(distance > half)
}

/// The compact English scale a label's number carries (bn / m / k directly after the digits), when it is a scale and not a
/// unit: what follows must be nothing, a space (then the unit) or a percent sign, so "1.2mt" and "1.2m²" are not millions.
fn compact_suffix(rest: &str) -> Option<(&'static str, f64)> {
    let (suffix, scale): (&'static str, f64) = if rest.starts_with("bn") {
        ("bn", 1e9)
    } else if rest.starts_with('m') {
        ("m", 1e6)
    } else if rest.starts_with('k') {
        ("k", 1e3)
    } else {
        return None;
    };
    match rest[suffix.len()..].chars().next() {
        None | Some(' ') | Some('%') => Some((suffix, scale)),
        Some(_) => None,
    }
}

/// Exact check of a compact k / m / bn value label, the renderer's English form (runtime/pi/viz.mjs choroplethValueText):
/// the suffix is chosen by the raw magnitude of the value (>= 1e9 bn, >= 1e6 m, >= 1e3 k), the number is value / scale to one
/// decimal, so a correct label is within half a displayed digit of data-value. Anything else (a wrong suffix, a number not
/// shown to one decimal, a value under 1000 carrying a suffix) is a mismatch. None: the label carries no such suffix
/// (the ordinary reader applies).
fn scaled_label_matches(text: &str, expected: f64) -> Option<bool> {
    let (number, decimals, rest) = label_number_prefix(text)?;
    let (suffix, _) = compact_suffix(rest)?;
    if expected.is_nan() {
        return Some(true); // as the 1% check judged it; the finite-value switch refuses NaN separately
    }
    let magnitude = expected.abs();
    let (want_suffix, want_scale): (&str, f64) = if magnitude >= 1e9 {
        ("bn", 1e9)
    } else if magnitude >= 1e6 {
        ("m", 1e6)
    } else if magnitude >= 1e3 {
        ("k", 1e3)
    } else {
        return Some(false);
    };
    if suffix != want_suffix || decimals != 1 {
        return Some(false);
    }
    Some(within_half_step(
        (number * want_scale - expected).abs(),
        display_half_step(decimals, want_scale, expected),
    ))
}

/// Exact check of a Chinese 万 / 亿 / 万亿 value label (the renderer's typeset form for a Chinese page). The renderer picks
/// the suffix by the raw magnitude of the value and prints value / 10^power to one decimal, rounded half up on the shortest
/// decimal spelling of the value. This re-derives that text from data-value with integer arithmetic and requires the
/// number and the suffix to equal it - no tolerance. None: the label carries no such suffix (the ordinary reader
/// applies). Some(true): exact match. Some(false): mismatch, including any arithmetic that does not fit.
fn zh_scaled_label_matches(text: &str, expected: f64) -> Option<bool> {
    let bytes = text.as_bytes();
    let mut i = 0;
    if i < bytes.len() && bytes[i] == b'-' {
        i += 1;
    }
    let digits_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits_start
        || i + 1 >= bytes.len()
        || bytes[i] != b'.'
        || !bytes[i + 1].is_ascii_digit()
    {
        return None;
    }
    let number_end = i + 2;
    let rest = &text[number_end..];
    let (suffix, power): (&str, u32) = if rest.starts_with("万亿") {
        ("万亿", 12)
    } else if rest.starts_with('亿') {
        ("亿", 8)
    } else if rest.starts_with('万') {
        ("万", 4)
    } else {
        return None;
    };
    if rest[suffix.len()..]
        .chars()
        .next()
        .is_some_and(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
    {
        return None;
    }
    let magnitude = expected.abs();
    let (want_suffix, want_power): (&str, u32) = if magnitude >= 1e12 {
        ("万亿", 12)
    } else if magnitude >= 1e8 {
        ("亿", 8)
    } else if magnitude >= 1e4 {
        ("万", 4)
    } else {
        return Some(false);
    };
    if suffix != want_suffix || power != want_power {
        return Some(false);
    }
    let shortest = format!("{magnitude}");
    let (int_part, frac_part) = shortest.split_once('.').unwrap_or((shortest.as_str(), ""));
    let Ok(coefficient) = format!("{int_part}{frac_part}").parse::<u128>() else {
        return Some(false);
    };
    let Some(numerator) = coefficient.checked_mul(10) else {
        return Some(false);
    };
    let Some(denominator) = 10u128.checked_pow(frac_part.len() as u32 + want_power) else {
        return Some(false);
    };
    let (Some(twice_numerator), Some(twice_denominator)) =
        (numerator.checked_mul(2), denominator.checked_mul(2))
    else {
        return Some(false);
    };
    let Some(rounded) = twice_numerator
        .checked_add(denominator)
        .map(|v| v / twice_denominator)
    else {
        return Some(false);
    };
    let want = format!(
        "{}{}.{}",
        if expected < 0.0 { "-" } else { "" },
        rounded / 10,
        rounded % 10
    );
    Some(&text[..number_end] == want.as_str())
}

/// Half-up rounding of |value| to `digits` decimals on the shortest decimal spelling of the value, as integer arithmetic
/// (the renderer's halfUpFixed). Returns the whole and the fractional digits of the result, None when it does not fit.
fn half_up_parts(magnitude: f64, digits: u32) -> Option<(u128, u128)> {
    let shortest = format!("{magnitude}");
    let (int_part, frac_part) = shortest.split_once('.').unwrap_or((shortest.as_str(), ""));
    let coefficient = format!("{int_part}{frac_part}").parse::<u128>().ok()?;
    let numerator = coefficient.checked_mul(10u128.checked_pow(digits)?)?;
    let denominator = 10u128.checked_pow(frac_part.len() as u32)?;
    let rounded =
        numerator.checked_mul(2)?.checked_add(denominator)? / denominator.checked_mul(2)?;
    let scale = 10u128.pow(digits);
    Some((rounded / scale, rounded % scale))
}

/// Exact check of the two plain Chinese choropleth label forms the typeset switch prints besides the 万 / 亿 ones:
/// (1) a unit that already says 万 / 亿 / 千 / 百万 gets the plain one-decimal number and no second scale ("12000.0 万人");
/// (2) an integer-form label ("8766 人"): on a map that has a value of 1万 or more, a value under 1万 prints as its half-up
/// integer; otherwise an integer-form label must be the integer value itself. None: neither form (the ordinary reader
/// applies). Some(true) exact match, Some(false) mismatch.
fn zh_plain_label_matches(text: &str, expected: f64, wan_context: bool) -> Option<bool> {
    let unit_scaled = |rest: &str| rest.chars().any(|c| matches!(c, '万' | '亿' | '千'));
    let negative = expected < 0.0;
    // (1) -?digits.digit<space>unit-with-a-scale-word
    if let Some((number, rest)) = text.split_once(' ') {
        let digits = number.strip_prefix('-').unwrap_or(number);
        if let Some((whole, frac)) = digits.split_once('.') {
            if !whole.is_empty()
                && whole.bytes().all(|b| b.is_ascii_digit())
                && frac.len() == 1
                && frac.bytes().all(|b| b.is_ascii_digit())
                && unit_scaled(rest)
            {
                let Some((w, f)) = half_up_parts(expected.abs(), 1) else {
                    return Some(false);
                };
                let want = format!("{}{w}.{f}", if negative { "-" } else { "" });
                return Some(number == want);
            }
        }
    }
    // (2) optional currency symbol, then -?digits not followed by a digit or a point
    let body = text.strip_prefix(['£', '$', '€', '¥']).unwrap_or(text);
    let signless = body.strip_prefix('-').unwrap_or(body);
    let digit_count = signless.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digit_count == 0 || signless[digit_count..].starts_with('.') {
        return None;
    }
    let shown = &body[..body.len() - signless.len() + digit_count];
    let integer_valued = expected.fract() == 0.0;
    if !integer_valued && !(wan_context && expected.abs() < 10_000.0) {
        return Some(false);
    }
    let Some((w, _)) = half_up_parts(expected.abs(), 0) else {
        return Some(false);
    };
    let want = format!("{}{w}", if negative && w != 0 { "-" } else { "" });
    Some(shown == want)
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
    // NEWSROOM_VERIFY_MAP_FOOTNOTES (default on, off only at exactly "0"): also count the numbered-footnote list rows the renderer draws for
    // regions too small for an on-map label, the same roles render_qa_labels.mjs counts.
    let footnotes = std::env::var("NEWSROOM_VERIFY_MAP_FOOTNOTES").as_deref() != Ok("0");
    let name_roles: &[&str] = if footnotes {
        &[
            "choropleth-label",
            "choropleth-inset-label",
            "choropleth-footnote-name",
        ]
    } else {
        &["choropleth-label", "choropleth-inset-label"]
    };
    let value_roles: &[&str] = if footnotes {
        &[
            "choropleth-label-value",
            "choropleth-inset-label-value",
            "choropleth-footnote-value",
        ]
    } else {
        &["choropleth-label-value", "choropleth-inset-label-value"]
    };

    let mut data_values: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut unreadable: BTreeSet<String> = BTreeSet::new();
    for tag in find_path_tags_with_role(svg_text, "choropleth-data") {
        let (Some(iso3), Some(value_str)) =
            (attr_value(tag, "data-iso3"), attr_value(tag, "data-value"))
        else {
            continue;
        };
        // The renderer writes a plain finite decimal. NaN or inf would make the
        // tolerance comparison below pass for any label, so a data-value that
        // is not a finite number fails the region instead of being skipped.
        let strict = strict_readers();
        match value_str.parse::<f64>() {
            Ok(value) if !strict => {
                data_values.entry(iso3.to_owned()).or_default().push(value);
            }
            Err(_) if !strict => {}
            Ok(value) if value.is_finite() && !value_str.starts_with('+') => {
                data_values.entry(iso3.to_owned()).or_default().push(value);
            }
            _ => {
                let shown: String = value_str.chars().take(40).collect();
                failures.push(format!(
                    "{iso3}'s choropleth-data region has data-value '{shown}', which is not a finite number"
                ));
                unreadable.insert(iso3.to_owned());
            }
        }
    }

    let mut names: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for node in find_text_nodes_with_role(svg_text, name_roles) {
        let Some(iso3) = attr_value(node.tag, "data-iso3") else {
            continue;
        };
        names
            .entry(iso3.to_owned())
            .or_default()
            .push(label_body_text(node.body));
    }
    let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for node in find_text_nodes_with_role(svg_text, value_roles) {
        let Some(iso3) = attr_value(node.tag, "data-iso3") else {
            continue;
        };
        values
            .entry(iso3.to_owned())
            .or_default()
            .push(label_body_text(node.body));
    }

    // A country drawn as several regions (islands, exclaves) repeats one value on each; those count as one value.
    // Two different values, or a value that is not finite (NaN, inf), keep the region count and fail below.
    for vals in data_values.values_mut() {
        if vals.len() > 1 && vals[0].is_finite() && vals.iter().all(|v| *v == vals[0]) {
            vals.truncate(1);
        }
    }
    let wan_context = data_values
        .values()
        .any(|vals| vals.len() == 1 && vals[0].abs() >= 10_000.0);
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
        if let Some(exact) = zh_plain_label_matches(text, expected, wan_context)
            .or_else(|| zh_scaled_label_matches(text, expected))
        {
            if !exact {
                failures.push(format!(
                    "{iso3}'s rendered value label '{text}' does not match its region's data-value {expected}"
                ));
            }
            continue;
        }
        match latin_label_matches(text, expected) {
            Some(true) => {}
            Some(false) => failures.push(format!(
                "{iso3}'s rendered value label '{text}' does not match its region's data-value {expected}"
            )),
            None => failures.push(format!(
                "{iso3}'s rendered value label '{text}' has no readable number (missing, truncated, or malformed)"
            )),
        }
    }

    for iso3 in names.keys().chain(values.keys()) {
        if !data_values.contains_key(iso3) && !unreadable.contains(iso3) {
            failures.push(format!(
                "{iso3} has a rendered label but no matching choropleth-data region in the SVG"
            ));
        }
    }

    failures.sort();
    failures.dedup();
    failures
}

/// Like attr_value, but only matches a whole attribute name (` x="` never matches inside `data-x="`).
fn whole_attr_value<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    attr_value(tag, &format!(" {attr}")).or_else(|| attr_value(tag, &format!("\n{attr}")))
}

/// The non-Chinese label check of a choropleth region: the compact k / m / bn form is judged by `scaled_label_matches`, any
/// other label by half of its last displayed digit. None: the label has no readable number.
fn latin_label_matches(text: &str, expected: f64) -> Option<bool> {
    if let Some(exact) = scaled_label_matches(text, expected) {
        return Some(exact);
    }
    let (shown, decimals, _) = label_number_prefix(text)?;
    Some(within_half_step(
        (shown - expected).abs(),
        display_half_step(decimals, 1.0, expected),
    ))
}

/// A heatmap cell label read as a number: the digits it shows, times 万 / 亿 or k / m / bn when it carries one (fmtSpec prints
/// "1.2k" and "12k"), with half of its last displayed digit (in data units) as the most rounding can move the value.
fn heatmap_label_number(text: &str) -> Option<(f64, f64)> {
    let (number, decimals, rest) = label_number_prefix(text)?;
    let scale = if rest.starts_with('\u{4ebf}') {
        100_000_000.0
    } else if rest.starts_with('\u{4e07}') {
        10_000.0
    } else if let Some((_, scale)) = compact_suffix(rest) {
        scale
    } else {
        1.0
    };
    Some((
        number * scale,
        display_half_step(decimals, scale, number * scale),
    ))
}

/// The heatmap cell label check: `heatmap_label_number` read back within its half step. None: no readable number.
fn heatmap_label_matches(text: &str, expected: f64) -> Option<bool> {
    let (shown, half) = heatmap_label_number(text)?;
    Some(within_half_step((shown - expected).abs(), half))
}

// --- NEWSROOM_QA_TICK_READBACK=1 (exact "1", default off): bar tick and value-label read-back (K198, K200, K202) ---
//
// Independently re-derives, from one rendered SVG plus the data rows it was drawn from, that (T1) every axis tick's
// text read through its suffix or the unit line's data-scale equals its data-tick-value to half a displayed digit,
// (T2) every tick sits where that value falls on the scale fitted from the bars, (V1/V2) every value label reads as
// its data-value and names a bar carrying the same value, and (anchor) every bar's data-value equals its data row.
// Written fresh: it shares nothing with runtime/pi/render_qa_ticks.mjs or the Python verify_tick_readback_from_svg.

const TICK_READBACK_COVERED: [&str; 2] = ["horizontal_bar", "mirrored_bar"];
/// SVG units: about 50x the coordinate rounding, 1/80 of the narrowest grid step.
const TICK_POSITION_TOLERANCE: f64 = 1.0;
const TICK_LABEL_SLIDE_MAX: f64 = 40.0;
const TICK_REL: f64 = 1e-9;

#[derive(Clone, Debug, Default)]
struct TickReadbackContext {
    chart_type: String,
    rows: Option<Vec<Value>>,
    category_field: Option<String>,
    value_field: Option<String>,
    series_field: Option<String>,
    period_field: Option<String>,
    unit: Option<String>,
    language: Option<String>,
}

#[derive(Debug, PartialEq)]
enum TickReadbackStatus {
    Covered,
    Uncovered,
}

type TickAttrs = std::collections::BTreeMap<String, String>;

fn tick_attrs(tag: &str) -> TickAttrs {
    let bytes = tag.as_bytes();
    let is_name = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b':';
    let mut out = TickAttrs::new();
    let mut i = 0;
    while i < bytes.len() {
        if !is_name(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && is_name(bytes[i]) {
            i += 1;
        }
        let name = &tag[start..i];
        let mut j = i;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'=' {
            j += 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                let quote = bytes[j];
                j += 1;
                let value_start = j;
                while j < bytes.len() && bytes[j] != quote {
                    j += 1;
                }
                out.insert(
                    name.to_string(),
                    tag[value_start..j.min(bytes.len())].to_string(),
                );
                i = (j + 1).min(bytes.len());
            }
        }
    }
    out
}

fn tick_body_text(body: &str) -> String {
    let mut stripped = String::new();
    let mut in_tag = false;
    for c in body.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => stripped.push(c),
            _ => {}
        }
    }
    stripped
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
        .trim()
        .to_string()
}

/// A plain decimal number only: [+-] digits [. digits] [e[+-]digits]; never "inf", "nan", hex or empty.
fn tick_num(value: Option<&str>) -> Option<f64> {
    let s = value?.trim();
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - frac_start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return None;
        }
    }
    if i != b.len() {
        return None;
    }
    s.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// What the text shows: (mantissa, displayed decimals, attached suffix multiplier).
fn tick_read_shown(text: &str) -> Option<(f64, usize, Option<f64>)> {
    let t = text.trim();
    let b = t.as_bytes();
    let mut i = 0;
    let mut negative = false;
    if t.starts_with('-') {
        negative = true;
        i = 1;
    } else if t.starts_with('\u{2212}') {
        negative = true;
        i = '\u{2212}'.len_utf8();
    }
    let digits_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits_start {
        return None;
    }
    let mut int_text = t[digits_start..i].to_string();
    // thousands grouping: 1-3 digits then one or more ,ddd groups
    if i - digits_start <= 3 {
        let mut k = i;
        let mut grouped = String::new();
        while k + 3 < b.len() && b[k] == b',' && b[k + 1..k + 4].iter().all(|c| c.is_ascii_digit())
        {
            grouped.push_str(&t[k + 1..k + 4]);
            k += 4;
        }
        if k > i {
            int_text.push_str(&grouped);
            i = k;
        }
    }
    let mut frac = String::new();
    if i + 1 < b.len() && b[i] == b'.' && b[i + 1].is_ascii_digit() {
        let start = i + 1;
        let mut j = start;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        frac = t[start..j].to_string();
        i = j;
    }
    let mantissa_text = format!(
        "{}{}{}",
        if negative { "-" } else { "" },
        int_text,
        if frac.is_empty() {
            String::new()
        } else {
            format!(".{frac}")
        }
    );
    let mantissa: f64 = mantissa_text.parse().ok()?;
    let rest = &t[i..];
    let suffix = if rest.starts_with("\u{4e07}\u{4ebf}") {
        Some(1e12)
    } else if rest.starts_with('\u{4ebf}') {
        Some(1e8)
    } else if rest.starts_with('\u{4e07}') {
        Some(1e4)
    } else {
        let after = |n: usize| {
            rest[n..]
                .chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphabetic())
        };
        if rest.starts_with("bn") && after(2) {
            Some(1e9)
        } else if rest.starts_with('m') && after(1) {
            Some(1e6)
        } else if rest.starts_with('k') && after(1) {
            Some(1e3)
        } else if !rest.trim().is_empty() {
            // a label that names its own unit (1683%, 9541.8 元) is read as written, the unit line's scale is not applied to it
            Some(1.0)
        } else {
            None
        }
    };
    Some((mantissa, frac.len(), suffix))
}

fn tick_unit_word_scale(text: &str) -> f64 {
    if text.contains("\u{4e07}\u{4ebf}") {
        return 1e12;
    }
    if text.contains('\u{4ebf}') {
        return 1e8;
    }
    if text.contains('\u{4e07}') {
        return 1e4;
    }
    let lower = text.to_ascii_lowercase();
    for token in lower.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        match token.trim_end_matches('s') {
            "thousand" if token.len() >= 8 => return 1e3,
            "million" if token.len() >= 7 => return 1e6,
            "billion" if token.len() >= 7 => return 1e9,
            "trillion" if token.len() >= 8 => return 1e12,
            _ => {}
        }
    }
    1.0
}

// --- symbol_map: independent read-back of what the renderer drew (K1016) ---------------------------------------------------
//
// render_qa.mjs checks a symbol map against itself (radius, circle count); this reads the SVG bytes again before publication, and anchors
// every circle to its data row. The legend text is the renderer's exact "nice" value, so it is read back exactly (not to half a digit);
// the per-circle value labels the half-step rule (#199) is meant for are not drawn yet, so that layer is reported as not checked.

/// Smallest radius a circle is ever drawn at (choropleth.mjs SYMBOL_MIN_RADIUS_PX).
const SYMBOL_MIN_RADIUS_PX: f64 = 2.5;
const SYMBOL_RADIUS_TOLERANCE: f64 = 0.01;
/// The renderer writes data-r and data-draw-r with toFixed(3) (viz.mjs:11417-11419), so a written value is within half a thousandth of the radius it was made
/// from; and it flags a circle minimum-size when the UNROUNDED radius is under 2.5 (choropleth.mjs:278, `min: r < rMin`), so data-r may read 2.500 there.
const SYMBOL_WRITTEN_ROUNDING: f64 = 0.0005 + 1e-9;

/// Every `<element ...>` opening tag whose data-role is exactly `role`.
fn svg_tags_with_role<'a>(svg: &'a str, element: &str, role: &str) -> Vec<&'a str> {
    let open = format!("<{element}");
    let needle = format!("data-role=\"{role}\"");
    let mut out = Vec::new();
    let mut idx = 0;
    while let Some(rel) = svg[idx..].find(&open) {
        let start = idx + rel;
        let after = start + open.len();
        if !svg[after..].starts_with(|c: char| c.is_whitespace() || c == '>') {
            idx = after;
            continue;
        }
        let Some(gt_rel) = svg[start..].find('>') else {
            break;
        };
        let end = start + gt_rel + 1;
        let tag = &svg[start..end];
        if tag.contains(&needle) {
            out.push(tag);
        }
        idx = end;
    }
    out
}

/// A finite plain decimal ("12.5", "-3"); NaN, inf, "+5", empty are not numbers here.
fn symbol_number(text: &str) -> Option<f64> {
    if text.starts_with('+') {
        return None;
    }
    text.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// A zh unit that already carries a scale word (万人, 百万吨) is the base unit times that scale: (scale, base unit).
fn symbol_zh_unit_scale(unit: &str) -> Option<(f64, &str)> {
    for (word, scale) in [
        ("百万", 1e6),
        ("千万", 1e7),
        ("万", 1e4),
        ("亿", 1e8),
        ("千", 1e3),
    ] {
        if let Some(base) = unit.strip_prefix(word) {
            if !base.is_empty() {
                return Some((scale, base));
            }
        }
    }
    None
}

/// Whether a legend ring's text shows exactly the ring's value. The renderer writes the exact 1-2-5 value (k / m / bn in English, 万 / 亿 / 万亿 on a
/// Chinese page, a zh unit's own scale word folded in), so the number it shows times its scale must equal the value to float noise, and what follows
/// must be the unit. None: the text has no readable number or scale (fail closed).
fn symbol_legend_text_matches(text: &str, value: f64, unit: &str, zh: bool) -> Option<bool> {
    let (factor, shown_unit) = if zh {
        symbol_zh_unit_scale(unit).unwrap_or((1.0, unit))
    } else {
        (1.0, unit)
    };
    // English pages write a currency symbol before the number ($5m); a Chinese page writes number, scale word, unit (3亿$), so the symbol is a plain suffix there
    let currency = !zh && shown_unit.chars().count() == 1 && "£$€¥".contains(shown_unit);
    let body = if currency {
        text.strip_prefix(shown_unit)?
    } else {
        text
    };
    let (number, _, rest) = label_number_prefix(body)?;
    let want = value * factor;
    let tail = |r: &str| r.trim() == if currency { "" } else { shown_unit };
    let near = |scale: f64| (number * scale - want).abs() <= 1e-9 * want.abs().max(1.0);
    if zh {
        // a zh unit's own scale word may sit next to the page's (3万亿元 = 3 x 万 of 亿元): any reading whose tail is exactly the unit and whose value is right counts
        let mut readings = vec![(1.0, rest)];
        for (word, scale) in [("万亿", 1e12), ("亿", 1e8), ("万", 1e4)] {
            if let Some(after) = rest.strip_prefix(word) {
                readings.push((scale, after));
            }
        }
        return Some(
            readings
                .iter()
                .any(|(scale, after)| tail(after) && near(*scale)),
        );
    }
    let (scale, rest) = match compact_suffix(rest) {
        Some((suffix, scale)) => (scale, &rest[suffix.len()..]),
        None => (1.0, rest),
    };
    Some(tail(rest) && near(scale))
}

/// Failures of one symbol_map SVG read on its own (circles, legend, radii), and its circles as (iso3, data-value) for the data-row anchor.
fn verify_symbol_map_from_svg(
    svg: &str,
    unit: &str,
    zh: bool,
) -> (Vec<String>, Vec<(String, f64)>) {
    let mut failures = Vec::new();
    // (iso3, value, data-r)
    let mut circles: Vec<(String, f64, f64)> = Vec::new();
    let mut seen = BTreeSet::new();
    for tag in svg_tags_with_role(svg, "circle", "symbol-circle") {
        let iso3 = attr_value(tag, "data-iso3").unwrap_or("");
        if iso3.is_empty() {
            failures.push("a symbol-circle has no data-iso3".to_string());
            continue;
        }
        if !seen.insert(iso3.to_string()) {
            failures.push(format!("{iso3} has more than one symbol-circle"));
            continue;
        }
        let value = attr_value(tag, "data-value").and_then(symbol_number);
        let radius = attr_value(tag, "data-r").and_then(symbol_number);
        let (Some(value), Some(radius)) = (value, radius) else {
            failures.push(format!(
                "{iso3}'s symbol-circle has no finite data-value and data-r"
            ));
            continue;
        };
        if value <= 0.0 || radius <= 0.0 {
            failures.push(format!(
                "{iso3}'s symbol-circle data-value and data-r must be positive"
            ));
            continue;
        }
        // the drawn radius is what a reader sees: data-r, or data-draw-r for a circle enlarged to the minimum visible size
        let drawn = whole_attr_value(tag, "r").and_then(symbol_number);
        let draw_r = attr_value(tag, "data-draw-r").and_then(symbol_number);
        let want_drawn = if tag.contains("data-min-r=") {
            match draw_r {
                Some(d)
                    if d + SYMBOL_WRITTEN_ROUNDING >= radius
                        && radius <= SYMBOL_MIN_RADIUS_PX + SYMBOL_WRITTEN_ROUNDING
                        && (d - SYMBOL_MIN_RADIUS_PX).abs() <= SYMBOL_WRITTEN_ROUNDING =>
                {
                    Some(d)
                }
                _ => {
                    failures.push(format!(
                        "{iso3}'s symbol-circle is marked minimum-size but is not a true radius under {SYMBOL_MIN_RADIUS_PX} drawn at it"
                    ));
                    None
                }
            }
        } else if radius < SYMBOL_MIN_RADIUS_PX - 1e-9 {
            // the renderer marks every circle under the minimum visible size; an unmarked one must be at least that large
            failures.push(format!(
                "{iso3}'s symbol-circle has a true radius under {SYMBOL_MIN_RADIUS_PX} but is not marked minimum-size"
            ));
            None
        } else {
            Some(radius)
        };
        if let Some(want) = want_drawn {
            if !matches!(drawn, Some(d) if (d - want).abs() <= SYMBOL_RADIUS_TOLERANCE) {
                failures.push(format!(
                    "{iso3}'s symbol-circle is drawn with a radius other than {want}"
                ));
            }
        }
        circles.push((iso3.to_string(), value, radius));
    }

    let group = svg_tags_with_role(svg, "g", "symbol-map-circles")
        .into_iter()
        .next();
    let legend_circles = svg_tags_with_role(svg, "circle", "symbol-legend-circle");
    if circles.is_empty() && group.is_none() && legend_circles.is_empty() {
        failures
            .push("the SVG of a symbol_map has no symbol-map circles, group or legend".to_string());
        return (failures, Vec::new());
    }
    let r_max = group
        .and_then(|g| attr_value(g, "data-r-max"))
        .and_then(symbol_number);
    let v_max = group
        .and_then(|g| attr_value(g, "data-v-max"))
        .and_then(symbol_number);
    let (Some(r_max), Some(v_max)) = (r_max.filter(|r| *r > 0.0), v_max.filter(|v| *v > 0.0))
    else {
        failures.push(
            "the symbol-map-circles group has no positive data-r-max and data-v-max".to_string(),
        );
        return (
            failures,
            circles.into_iter().map(|(i, v, _)| (i, v)).collect(),
        );
    };
    let drawn_count = group
        .and_then(|g| attr_value(g, "data-circles"))
        .and_then(symbol_number);
    if drawn_count != Some(circles.len() as f64) {
        failures.push(format!(
            "the symbol-map-circles group says {} circles, the SVG has {}",
            drawn_count.map_or("no count".to_string(), |c| c.to_string()),
            circles.len()
        ));
    }
    let top = circles.iter().map(|(_, v, _)| *v).fold(f64::MIN, f64::max);
    if !circles.is_empty() && !tick_close(top, v_max) {
        failures.push(format!(
            "data-v-max {v_max} is not the largest circle value {top}"
        ));
    }
    for (iso3, value, radius) in &circles {
        let want = r_max * (value / v_max).sqrt();
        if (radius - want).abs() > SYMBOL_RADIUS_TOLERANCE {
            failures.push(format!(
                "{iso3}'s symbol-circle data-r {radius} does not follow the area rule (expected {want:.3})"
            ));
        }
    }

    // legend: one ring per text, each on the same area rule, each text exactly its ring's value
    let texts: Vec<String> = find_text_nodes_with_role(svg, &["symbol-legend-value"])
        .iter()
        .map(|n| label_body_text(n.body))
        .collect();
    if !circles.is_empty() && legend_circles.is_empty() {
        failures.push("the symbol map has circles but no legend ring".to_string());
    }
    if legend_circles.len() != texts.len() {
        failures.push(format!(
            "the symbol legend has {} rings and {} value texts",
            legend_circles.len(),
            texts.len()
        ));
    } else {
        for (tag, text) in legend_circles.iter().zip(&texts) {
            let value = attr_value(tag, "data-value").and_then(symbol_number);
            let radius = attr_value(tag, "data-r").and_then(symbol_number);
            let (Some(value), Some(radius)) = (value, radius) else {
                failures
                    .push("a symbol-legend-circle has no finite data-value and data-r".to_string());
                continue;
            };
            let want = r_max * (value / v_max).sqrt();
            if value <= 0.0 || value > v_max || (radius - want).abs() > SYMBOL_RADIUS_TOLERANCE {
                failures.push(format!(
                    "legend ring {value} has data-r {radius}, which does not follow the area rule (expected {want:.3})"
                ));
            }
            match symbol_legend_text_matches(text, value, unit, zh) {
                Some(true) => {}
                Some(false) => failures.push(format!(
                    "legend text '{text}' does not show its ring's value {value}"
                )),
                None => failures.push(format!(
                    "legend text '{text}' has no readable number (missing, truncated, or malformed)"
                )),
            }
        }
    }
    failures.sort();
    failures.dedup();
    (
        failures,
        circles.into_iter().map(|(i, v, _)| (i, v)).collect(),
    )
}

/// What the location evidence says each data row's iso3 is, joined to the computation's rows.
enum SymbolAnchor {
    /// Not checked (reason): shown as a warning, never as a pass.
    Unchecked(String),
    /// Evidence was named but does not hold.
    Failed(Vec<String>),
    /// iso3 -> the one positive value its row carries; iso3 codes with several rows (not anchored).
    Rows(BTreeMap<String, f64>, BTreeMap<String, Vec<f64>>),
}

fn symbol_map_anchor(
    root: &Path,
    manifest: &Value,
    comp_rows: &[Value],
    value_field: &str,
    evidence_on: bool,
) -> SymbolAnchor {
    let text = |key: &str| manifest.get(key).and_then(Value::as_str);
    let (reference, sha) = (
        text("location_evidence_ref"),
        text("location_evidence_sha256"),
    );
    let (reference, sha) = match (reference, sha) {
        (None, None) if evidence_on => {
            return SymbolAnchor::Failed(vec![
                "location evidence is on for this run but the manifest names none".into(),
            ])
        }
        (None, None) => {
            return SymbolAnchor::Unchecked(
                "location evidence is off (NEWSROOM_LOCATION_EVIDENCE is not 1 for this run)"
                    .into(),
            )
        }
        (Some(r), Some(s)) if !r.is_empty() && !s.is_empty() => (r, s),
        _ => {
            return SymbolAnchor::Failed(vec![
                "the manifest names location evidence by only one of ref and sha256".into(),
            ])
        }
    };
    let path = match safe_ref(root, reference) {
        Ok(path) => path,
        Err(error) => return SymbolAnchor::Failed(vec![format!("location evidence ref: {error}")]),
    };
    match sha256_file(&path) {
        Ok(actual) if actual == sha => {}
        Ok(_) => {
            return SymbolAnchor::Failed(vec![
                "location evidence does not hash to the manifest's location_evidence_sha256".into(),
            ])
        }
        Err(error) => {
            return SymbolAnchor::Failed(vec![format!("location evidence cannot be read: {error}")])
        }
    }
    let Ok(evidence) = read_json(&path) else {
        return SymbolAnchor::Failed(vec!["location evidence is not valid JSON".into()]);
    };
    if evidence.get("chart_type").and_then(Value::as_str) != Some("symbol_map") {
        return SymbolAnchor::Failed(vec!["location evidence is not for a symbol_map".into()]);
    }
    let Some(rows) = evidence.get("rows").and_then(Value::as_array) else {
        return SymbolAnchor::Failed(vec!["location evidence has no rows".into()]);
    };
    let manifest_rows = manifest.get("row_count").and_then(Value::as_u64);
    if rows.len() != comp_rows.len() || manifest_rows.is_some_and(|n| n != rows.len() as u64) {
        return SymbolAnchor::Failed(vec![format!(
            "location evidence has {} rows, the computation has {}",
            rows.len(),
            comp_rows.len()
        )]);
    }
    let unmatched: BTreeSet<&str> = evidence
        .get("unmatched")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut by_iso3: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for (position, (entry, row)) in rows.iter().zip(comp_rows).enumerate() {
        if entry.get("row_index").and_then(Value::as_u64) != Some(position as u64) {
            return SymbolAnchor::Failed(vec![format!(
                "location evidence row {position} does not carry row_index {position}"
            )]);
        }
        let Some(iso3) = entry
            .get("iso3")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            continue; // an unmatched row has no region, so no circle
        };
        let value = match row.get(value_field) {
            Some(Value::Number(n)) => n.as_f64().filter(|v| v.is_finite()),
            Some(Value::String(s)) => tick_num(Some(s.as_str())),
            _ => None,
        };
        // null and an empty or blank string are "no data" to the renderer (n()) and to lintSymbolMap: no circle, none required
        let present = match row.get(value_field) {
            None | Some(Value::Null) => false,
            Some(Value::String(s)) => !s.trim().is_empty(),
            Some(_) => true,
        };
        if (present && value.is_none()) || value.is_some_and(|v| v < 0.0) {
            return SymbolAnchor::Failed(vec![format!(
                "data row {position} has a value that is not a finite non-negative number"
            )]);
        }
        // a row the join left unmatched (or matched to no map feature) has no circle
        let skip = entry
            .get("raw")
            .and_then(Value::as_str)
            .is_some_and(|raw| unmatched.contains(raw))
            || entry
                .get("feature_indices")
                .and_then(Value::as_array)
                .is_some_and(|a| a.is_empty());
        if let Some(value) = value.filter(|v| *v > 0.0).filter(|_| !skip) {
            by_iso3.entry(iso3.to_string()).or_default().push(value);
        }
    }
    let mut unique = BTreeMap::new();
    let mut several: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for (iso3, values) in by_iso3 {
        if values.len() == 1 {
            unique.insert(iso3, values[0]);
        } else {
            several.insert(iso3, values);
        }
    }
    SymbolAnchor::Rows(unique, several)
}

/// One symbol_map manifest: each viewport's SVG read back on its own, and its circles anchored to the data rows the manifest binds.
fn verify_symbol_map_for_manifest(
    root: &Path,
    name: &str,
    manifest: &Value,
    report: &mut VerificationReport,
) {
    let text_of = |key: &str| manifest.get(key).and_then(Value::as_str).unwrap_or("");
    let loaded = (|| -> Result<(Value, Value)> {
        Ok((
            read_json(&safe_ref(root, text_of("computation_ref"))?)?,
            read_json(&safe_ref(root, text_of("plan_ref"))?)?,
        ))
    })();
    let (comp, plan) = match loaded {
        Ok(pair) => pair,
        Err(error) => {
            report.error(format!(
                "visualization {name} symbol_map read-back could not run: {error}"
            ));
            return;
        }
    };
    report.check(
        comp.get("result_hash").and_then(Value::as_str) == manifest.get("data_hash").and_then(Value::as_str)
            && comp.get("result_hash").is_some(),
        format!("visualization {name} symbol_map read-back: computation rows are not the manifest's data"),
    );
    let unit = plan.get("unit").and_then(Value::as_str).unwrap_or("");
    let zh = plan.get("language").and_then(Value::as_str) == Some("zh");
    let value_field = plan
        .get("value_field")
        .and_then(Value::as_str)
        .unwrap_or("");
    let comp_rows = comp
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let evidence_on = std::env::var("NEWSROOM_LOCATION_EVIDENCE").as_deref() == Ok("1");
    let anchor = symbol_map_anchor(root, manifest, &comp_rows, value_field, evidence_on);
    match &anchor {
        SymbolAnchor::Unchecked(reason) => report.warnings.push(format!(
            "visualization {name}: symbol_map circle values were not anchored to their data rows (anchor not checked): {reason}"
        )),
        SymbolAnchor::Failed(messages) => {
            for message in messages {
                report.error(format!("visualization {name} symbol_map data-row anchor: {message}"));
            }
        }
        SymbolAnchor::Rows(_, several) if !several.is_empty() => report.error(format!(
            "visualization {name} symbol_map data-row anchor: several data rows map to one region ({}); the renderer draws one circle per row and never sums them, so this cannot be a valid render",
            several.keys().cloned().collect::<Vec<_>>().join(", ")
        )),
        SymbolAnchor::Rows(..) => {}
    }
    report.warnings.push(format!(
        "visualization {name}: symbol_map value labels (layer B) not checked: no per-circle name or value labels are drawn; the iso3 of an anchored row is the renderer's own join, only its evidence hash binding was checked"
    ));
    let Some(variants) = manifest.get("variants").and_then(Value::as_object) else {
        report.error(format!(
            "visualization {name} symbol_map has no variants to read back"
        ));
        return;
    };
    // without evidence there is no iso3 to join on, but every circle value must still be one of the data rows' positive values
    let row_values: Vec<f64> = comp_rows
        .iter()
        .filter_map(|row| match row.get(value_field) {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(text)) => tick_num(Some(text.as_str())),
            _ => None,
        })
        .filter(|v| v.is_finite() && *v > 0.0)
        .collect();
    for (viewport, reference) in variants {
        let Some(svg) = reference
            .as_str()
            .and_then(|r| safe_ref(root, r).ok())
            .and_then(|p| fs::read_to_string(p).ok())
        else {
            report.error(format!(
                "visualization {name} {viewport} symbol_map read-back: the SVG cannot be read"
            ));
            continue;
        };
        let (failures, circles) = verify_symbol_map_from_svg(&svg, unit, zh);
        for failure in failures {
            report.error(format!(
                "visualization {name} {viewport} symbol_map read-back: {failure}"
            ));
        }
        if matches!(anchor, SymbolAnchor::Unchecked(_)) {
            let mut unused = row_values.clone();
            for (iso3, value) in &circles {
                match unused.iter().position(|v| tick_close(*value, *v)) {
                    Some(at) => {
                        unused.swap_remove(at);
                    }
                    None => report.error(format!(
                        "visualization {name} {viewport} symbol_map value check: circle {iso3} data-value {value} is not (or no longer) a positive value of any data row"
                    )),
                }
            }
            if circles.is_empty() && !row_values.is_empty() {
                report.error(format!(
                    "visualization {name} {viewport} symbol_map value check: no circle is drawn but the data has {} positive rows",
                    row_values.len()
                ));
            }
        }
        if let SymbolAnchor::Rows(rows, _) = &anchor {
            for (iso3, value) in &circles {
                match rows.get(iso3) {
                    None => report.error(format!(
                        "visualization {name} {viewport} symbol_map data-row anchor: circle {iso3} has no data row with a positive value"
                    )),
                    Some(expected) if !tick_close(*value, *expected) => report.error(format!(
                        "visualization {name} {viewport} symbol_map data-row anchor: circle {iso3} data-value {value} differs from its data row {expected}"
                    )),
                    _ => {}
                }
            }
            for iso3 in rows.keys() {
                if !circles.iter().any(|(i, _)| i == iso3) {
                    report.error(format!(
                        "visualization {name} {viewport} symbol_map data-row anchor: data row {iso3} has no circle"
                    ));
                }
            }
        }
    }
}

fn tick_close(a: f64, b: f64) -> bool {
    (a - b).abs() <= TICK_REL * 1f64.max(a.abs()).max(b.abs())
}

/// (value the text shows, half a unit of its last displayed digit), both in data units.
fn tick_shown_value(text: &str, unit_scale: f64) -> Option<(f64, f64)> {
    let (mantissa, decimals, suffix) = tick_read_shown(text)?;
    let mult = suffix.unwrap_or(unit_scale);
    Some((mantissa * mult, 0.5 * 10f64.powi(-(decimals as i32)) * mult))
}

fn tick_value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn tick_key(category: &str, series: &str, period: &str) -> String {
    serde_json::to_string(&serde_json::json!([category, series, period])).unwrap_or_default()
}

fn tick_attr_key(attrs: &TickAttrs) -> Option<String> {
    let category = attrs.get("data-category")?;
    Some(tick_key(
        category,
        attrs.get("data-series").map_or("", String::as_str),
        attrs.get("data-period").map_or("", String::as_str),
    ))
}

/// Every `<tag ...>` opening string (and, for text, its body) in document order.
fn tick_elements<'a>(svg: &'a str, tag: &str, with_body: bool) -> Vec<(&'a str, &'a str)> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut idx = 0;
    while let Some(rel) = svg[idx..].find(&open) {
        let start = idx + rel;
        let after = start + open.len();
        idx = after;
        if !svg[after..].starts_with(|c: char| c.is_whitespace() || c == '>' || c == '/') {
            continue;
        }
        let Some(gt) = svg[after..].find('>') else {
            break;
        };
        let tag_end = after + gt + 1;
        if with_body {
            let Some(close_rel) = svg[tag_end..].find(&close) else {
                break;
            };
            out.push((&svg[start..tag_end], &svg[tag_end..tag_end + close_rel]));
            idx = tag_end + close_rel + close.len();
        } else {
            out.push((&svg[start..tag_end], ""));
            idx = tag_end;
        }
    }
    out
}

/// Returns the status and the (rule, message) failures. An uncovered chart type is never a pass.
fn verify_tick_readback_from_svg(
    svg: &str,
    ctx: &TickReadbackContext,
) -> (TickReadbackStatus, Vec<(String, String)>) {
    // zh pages write $B as 亿美元 (x10): the text no longer equals the data unit, the read-back does not cover it yet
    if !TICK_READBACK_COVERED.contains(&ctx.chart_type.as_str())
        || (ctx.language.as_deref() == Some("zh") && ctx.unit.as_deref() == Some("$B"))
    {
        return (TickReadbackStatus::Uncovered, Vec::new());
    }
    let mut failures: Vec<(String, String)> = Vec::new();
    let mut fail = |rule: &str, message: String| failures.push((rule.to_string(), message));
    let mirrored = ctx.chart_type == "mirrored_bar";

    let mut ticks: Vec<(TickAttrs, String)> = Vec::new();
    let mut units: Vec<(TickAttrs, String)> = Vec::new();
    let mut labels: Vec<(TickAttrs, String)> = Vec::new();
    for (open_tag, body) in tick_elements(svg, "text", true) {
        let attrs = tick_attrs(open_tag);
        let item = (attrs.clone(), tick_body_text(body));
        match attrs.get("data-role").map(String::as_str) {
            Some("axis-tick-label") => ticks.push(item),
            Some("axis-unit-line") => units.push(item),
            Some("value-label") => labels.push(item),
            _ => {}
        }
    }
    let bars: Vec<TickAttrs> = tick_elements(svg, "rect", false)
        .into_iter()
        .map(|(open_tag, _)| tick_attrs(open_tag))
        .filter(|a| a.get("data-role").map(String::as_str) == Some("data-bar"))
        .collect();

    let mut unit_scale = 1.0;
    if units.len() > 1 {
        fail(
            "unit_line",
            format!("{} axis unit lines (expected at most 1)", units.len()),
        );
    }
    if let Some((attrs, text)) = units.first() {
        match tick_num(attrs.get("data-scale").map(String::as_str)) {
            Some(scale) if scale > 0.0 => {
                let words = tick_unit_word_scale(text);
                if scale == 1.0 || tick_close(scale, words) {
                    unit_scale = scale;
                } else {
                    fail(
                        "unit_line",
                        format!(
                            "axis unit line '{text}' says scale {words} but data-scale is {scale}"
                        ),
                    );
                }
            }
            _ => fail(
                "unit_line",
                format!("axis unit line '{text}' has no readable positive data-scale"),
            ),
        }
    }

    let mut bar_value: std::collections::BTreeMap<String, f64> = std::collections::BTreeMap::new();
    // (key, value, x, width, side)
    let mut geo: Vec<(String, f64, f64, f64, String)> = Vec::new();
    if bars.is_empty() {
        fail(
            "bar_attrs",
            "the chart has no data-bar to read back against".to_string(),
        );
    }
    for attrs in &bars {
        let Some(key) = tick_attr_key(attrs) else {
            fail("bar_attrs", "a data-bar has no data-category".to_string());
            continue;
        };
        let Some(value) = tick_num(attrs.get("data-value").map(String::as_str)) else {
            fail("bar_attrs", format!("bar {key} has no readable data-value"));
            continue;
        };
        let (Some(x), Some(width)) = (
            tick_num(attrs.get("x").map(String::as_str)),
            tick_num(attrs.get("width").map(String::as_str)),
        ) else {
            fail("bar_attrs", format!("bar {key} has no numeric x/width"));
            continue;
        };
        let side = attrs.get("data-side").cloned().unwrap_or_default();
        if mirrored && side != "left" && side != "right" {
            fail(
                "bar_attrs",
                format!("bar {key} has no data-side left/right"),
            );
            continue;
        }
        if bar_value.contains_key(&key) {
            fail("bar_attrs", format!("bar {key} appears twice"));
            continue;
        }
        bar_value.insert(key.clone(), value);
        geo.push((key, value, x, width, side));
    }

    match (&ctx.rows, &ctx.category_field, &ctx.value_field) {
        (Some(rows), Some(category_field), Some(value_field)) => {
            let mut row_value: std::collections::BTreeMap<String, f64> =
                std::collections::BTreeMap::new();
            for row in rows {
                let series = ctx
                    .series_field
                    .as_ref()
                    .map(|f| tick_value_text(row.get(f)))
                    .unwrap_or_default();
                let period = ctx
                    .period_field
                    .as_ref()
                    .map(|f| tick_value_text(row.get(f)))
                    .unwrap_or_default();
                let key = tick_key(&tick_value_text(row.get(category_field)), &series, &period);
                let value = match row.get(value_field) {
                    Some(Value::Number(n)) => n.as_f64().filter(|v| v.is_finite()),
                    Some(Value::String(s)) => tick_num(Some(s)),
                    _ => None,
                };
                match value {
                    None => fail(
                        "data_anchor",
                        format!("data row {key} has no numeric {value_field}"),
                    ),
                    Some(_) if row_value.contains_key(&key) => {
                        fail("data_anchor", format!("data row key {key} is not unique"))
                    }
                    Some(v) => {
                        row_value.insert(key, v);
                    }
                }
            }
            for (key, value) in &bar_value {
                match row_value.get(key) {
                    None => fail("data_anchor", format!("bar {key} has no data row")),
                    Some(expected) if !tick_close(*value, *expected) => fail(
                        "data_anchor",
                        format!(
                            "bar {key} data-value {value} differs from its data row {expected}"
                        ),
                    ),
                    _ => {}
                }
            }
            // a chart draws the current period only (the other may be an outline or absent): rows of a period no bar carries are not drawn
            let period_of = |key: &str| {
                serde_json::from_str::<Vec<String>>(key)
                    .ok()
                    .and_then(|parts| parts.get(2).cloned())
                    .unwrap_or_default()
            };
            let drawn: std::collections::BTreeSet<String> =
                bar_value.keys().map(|key| period_of(key)).collect();
            for key in row_value.keys() {
                if !bar_value.contains_key(key)
                    && !(ctx.period_field.is_some()
                        && !drawn.is_empty()
                        && !drawn.contains(&period_of(key)))
                {
                    fail("data_anchor", format!("data row {key} has no bar"));
                }
            }
        }
        _ => fail(
            "data_anchor",
            "no data rows or field names to anchor the bars to".to_string(),
        ),
    }

    let mut k: Option<f64> = None;
    let mut origin: std::collections::BTreeMap<String, f64> = std::collections::BTreeMap::new();
    let reference = geo.iter().filter(|g| g.1 != 0.0).fold(
        None::<&(String, f64, f64, f64, String)>,
        |best, g| match best {
            Some(b) if b.1.abs() >= g.1.abs() => Some(b),
            _ => Some(g),
        },
    );
    match reference {
        None => fail(
            "tick_position",
            "no non-zero bar to fit the scale from".to_string(),
        ),
        Some(reference) => {
            let scale = reference.3 / reference.1.abs();
            k = Some(scale);
            for (key, value, x, width, side) in &geo {
                if (width - scale * value.abs()).abs() > TICK_POSITION_TOLERANCE {
                    fail(
                        "tick_position",
                        format!(
                            "bar {key} is {width} wide but its data-value {value} implies {:.2}",
                            scale * value.abs()
                        ),
                    );
                }
                if *value == 0.0 && !mirrored {
                    continue;
                }
                let (zero, slot) = if mirrored {
                    (if side == "left" { x + width } else { *x }, side.clone())
                } else {
                    (if *value < 0.0 { x + width } else { *x }, "bar".to_string())
                };
                match origin.get(&slot) {
                    None => {
                        origin.insert(slot, zero);
                    }
                    Some(existing) if (existing - zero).abs() > TICK_POSITION_TOLERANCE => fail(
                        "tick_position",
                        format!("bar {key} starts at {zero}, the others at {existing}"),
                    ),
                    _ => {}
                }
            }
        }
    }

    if ticks.is_empty() {
        fail(
            "tick_attrs",
            "the chart has no axis-tick-label to read back".to_string(),
        );
    }
    for (attrs, text) in &ticks {
        let Some(tv) = tick_num(attrs.get("data-tick-value").map(String::as_str)) else {
            fail(
                "tick_attrs",
                format!("tick '{text}' has no readable data-tick-value"),
            );
            continue;
        };
        let Some((shown, half)) = tick_shown_value(text, unit_scale) else {
            fail("tick_text", format!("tick '{text}' has no readable number"));
            continue;
        };
        if (shown - tv).abs() > half * (1.0 + TICK_REL) + TICK_REL * tv.abs() {
            fail(
                "tick_text",
                format!("tick '{text}' reads {shown} but data-tick-value is {tv}"),
            );
        }
        let x = tick_num(attrs.get("x").map(String::as_str));
        let tick_x = match attrs.get("data-tick-x") {
            None => x,
            Some(raw) => tick_num(Some(raw)),
        };
        let (Some(x), Some(tick_x)) = (x, tick_x) else {
            fail(
                "tick_position",
                format!("tick '{text}' has no numeric position"),
            );
            continue;
        };
        if (x - tick_x).abs() > TICK_LABEL_SLIDE_MAX {
            fail(
                "tick_position",
                format!(
                    "tick '{text}' text sits {:.1} from its tick",
                    (x - tick_x).abs()
                ),
            );
        }
        let side = attrs.get("data-side").cloned().unwrap_or_default();
        if mirrored && side != "left" && side != "right" {
            fail(
                "tick_attrs",
                format!("tick '{text}' has no data-side left/right"),
            );
            continue;
        }
        let slot = if mirrored {
            side.clone()
        } else {
            "bar".to_string()
        };
        let (Some(scale), Some(zero)) = (k, origin.get(&slot).copied()) else {
            fail(
                "tick_position",
                format!("tick '{text}' position cannot be computed (no bar scale)"),
            );
            continue;
        };
        let expected = if mirrored && side == "left" {
            zero - scale * tv
        } else {
            zero + scale * tv
        };
        if (tick_x - expected).abs() > TICK_POSITION_TOLERANCE {
            fail("tick_position", format!("tick '{text}' is at {tick_x} but its data-tick-value {tv} belongs at {expected:.2}"));
        }
    }

    for (attrs, text) in &labels {
        let Some(key) = tick_attr_key(attrs) else {
            fail(
                "value_label_attrs",
                format!("value label '{text}' has no data-category"),
            );
            continue;
        };
        let Some(value) = tick_num(attrs.get("data-value").map(String::as_str)) else {
            fail(
                "value_label_attrs",
                format!("value label '{text}' has no readable data-value"),
            );
            continue;
        };
        match tick_shown_value(text, unit_scale) {
            None => fail(
                "value_label_text",
                format!("value label '{text}' has no readable number"),
            ),
            Some((shown, half))
                if (shown - value).abs() > half * (1.0 + TICK_REL) + TICK_REL * value.abs() =>
            {
                fail(
                    "value_label_text",
                    format!("value label '{text}' reads {shown} but data-value is {value}"),
                )
            }
            _ => {}
        }
        match bar_value.get(&key) {
            None => fail(
                "value_label_key",
                format!("value label '{text}' names {key}, which is not a bar"),
            ),
            Some(bar) if !tick_close(value, *bar) => fail(
                "value_label_key",
                format!("value label '{text}' carries {value} but its bar {key} is {bar}"),
            ),
            _ => {}
        }
    }
    (TickReadbackStatus::Covered, failures)
}

/// NEWSROOM_QA_TICK_READBACK=1 only. Data anchor: the rows come from the computation record the manifest names (its
/// result_hash is bound to the lint and to manifest.data_hash, and re-hashed against the rows by the computation
/// checks), the field names from the plan the manifest names (a content-addressed spec).
fn verify_tick_readback_for_manifest(
    root: &Path,
    name: &str,
    manifest: &Value,
    report: &mut VerificationReport,
) {
    let chart_type = manifest
        .get("chart_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !TICK_READBACK_COVERED.contains(&chart_type) {
        report.warnings.push(format!(
            "visualization {name}: tick read-back not covered for chart type {chart_type}"
        ));
        return;
    }
    let text_of = |key: &str| {
        manifest
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let loaded = (|| -> Result<(Value, Value)> {
        let comp = read_json(&safe_ref(root, &text_of("computation_ref"))?)?;
        let plan = read_json(&safe_ref(root, &text_of("plan_ref"))?)?;
        Ok((comp, plan))
    })();
    let (comp, plan) = match loaded {
        Ok(pair) => pair,
        Err(error) => {
            report.error(format!(
                "visualization {name} tick read-back could not run: {error}"
            ));
            return;
        }
    };
    report.check(
        comp.get("result_hash").and_then(Value::as_str)
            == manifest.get("data_hash").and_then(Value::as_str)
            && comp.get("result_hash").is_some(),
        format!(
            "visualization {name} tick read-back: computation rows are not the manifest's data"
        ),
    );
    let field = |key: &str| plan.get(key).and_then(Value::as_str).map(str::to_string);
    let ctx = TickReadbackContext {
        chart_type: chart_type.to_string(),
        rows: comp.get("rows").and_then(Value::as_array).cloned(),
        category_field: field("category_field"),
        value_field: field("value_field"),
        series_field: field("series_field"),
        period_field: field("period_field"),
        unit: field("unit"),
        language: field("language"),
    };
    if let Some(variants) = manifest.get("variants").and_then(Value::as_object) {
        for (viewport, reference) in variants {
            let Some(reference) = reference.as_str() else {
                continue;
            };
            let Ok(path) = safe_ref(root, reference) else {
                continue;
            };
            let Ok(svg) = fs::read_to_string(&path) else {
                continue;
            };
            for (rule, message) in verify_tick_readback_from_svg(&svg, &ctx).1 {
                report.error(format!(
                    "visualization {name} {viewport} tick read-back {rule}: {message}"
                ));
            }
        }
    }
}

type HeatmapCells = BTreeMap<(String, String), Vec<(f64, [Option<f64>; 4])>>;
type HeatmapLabels =
    BTreeMap<(String, String), Vec<(String, Option<f64>, Option<f64>, Option<f64>)>>;

/// NEWSROOM_HEATMAP_VALUE_LABELS=1 only. Independently re-derives the heatmap value-labels proof from one rendered
/// viewport's SVG: every `heatmap-cell` rect (data-x, data-y, data-value) has exactly one `heatmap-cell-value` text
/// for the same (x, y) whose number matches the cell's own data-value, is at least 12px, and sits inside the cell;
/// a label with no cell fails. Written fresh - it never calls into render_qa_labels.mjs - and mirrors the Python
/// verifier's verify_heatmap_labels_from_svg. Returns the failure messages (empty means the proof holds).
fn verify_heatmap_labels_from_svg(svg_text: &str) -> Vec<String> {
    let mut failures = Vec::new();
    let mut cells: HeatmapCells = BTreeMap::new();
    let mut idx = 0;
    while let Some(rel) = svg_text[idx..].find("<rect") {
        let start = idx + rel;
        let after = start + "<rect".len();
        if !svg_text[after..].starts_with(|c: char| c.is_whitespace() || c == '>') {
            idx = after;
            continue;
        }
        let Some(gt_rel) = svg_text[start..].find('>') else {
            break;
        };
        let tag_end = start + gt_rel + 1;
        let tag = &svg_text[start..tag_end];
        idx = tag_end;
        if attr_value(tag, "data-role") != Some("heatmap-cell") {
            continue;
        }
        let key = (
            attr_value(tag, "data-x").unwrap_or("").to_owned(),
            attr_value(tag, "data-y").unwrap_or("").to_owned(),
        );
        let Some(value) = attr_value(tag, "data-value").and_then(|v| v.parse::<f64>().ok()) else {
            failures.push(format!("{} / {} has no readable data-value", key.1, key.0));
            continue;
        };
        let num = |name: &str| whole_attr_value(tag, name).and_then(|v| v.parse::<f64>().ok());
        cells
            .entry(key)
            .or_default()
            .push((value, [num("x"), num("y"), num("width"), num("height")]));
    }
    let mut labels: HeatmapLabels = BTreeMap::new();
    for node in find_text_nodes_with_role(svg_text, &["heatmap-cell-value"]) {
        let key = (
            attr_value(node.tag, "data-x").unwrap_or("").to_owned(),
            attr_value(node.tag, "data-y").unwrap_or("").to_owned(),
        );
        let num = |name: &str| whole_attr_value(node.tag, name).and_then(|v| v.parse::<f64>().ok());
        labels.entry(key).or_default().push((
            label_body_text(node.body),
            num("font-size"),
            num("x"),
            num("y"),
        ));
    }
    if cells.is_empty() {
        failures.push("the heatmap has no cell with a value to prove".to_owned());
    }
    for (key, found) in &cells {
        let name = format!("{} / {}", key.1, key.0);
        if found.len() != 1 {
            failures.push(format!(
                "{name} has {} heatmap cells (expected exactly 1)",
                found.len()
            ));
            continue;
        }
        let (expected, rect) = &found[0];
        let texts = labels.get(key).map(Vec::as_slice).unwrap_or(&[]);
        if texts.len() != 1 {
            failures.push(format!(
                "{name} has {} rendered value labels (expected exactly 1)",
                texts.len()
            ));
            continue;
        }
        let (text, size, tx, ty) = &texts[0];
        match heatmap_label_matches(text, *expected) {
            Some(true) => {}
            Some(false) => failures.push(format!(
                "{name}'s rendered value label '{text}' does not match its cell's data-value {expected}"
            )),
            None => failures.push(format!(
                "{name}'s rendered value label '{text}' has no readable number"
            )),
        }
        let (Some(size), Some(tx), Some(ty), [Some(cx), Some(cy), Some(cw), Some(ch)]) =
            (size, tx, ty, rect)
        else {
            failures.push(format!(
                "{name}'s value label or cell is missing numeric geometry"
            ));
            continue;
        };
        if *size < 12.0 {
            failures.push(format!("{name}'s value label is {size}px, below 12px"));
        }
        if !(*cx <= *tx && *tx <= cx + cw && *cy <= *ty && *ty <= cy + ch) {
            failures.push(format!("{name}'s value label is outside its cell"));
        }
    }
    for key in labels.keys() {
        if !cells.contains_key(key) {
            failures.push(format!(
                "{} / {} has a rendered value label but no matching heatmap cell in the SVG",
                key.1, key.0
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
    heatmap_value_labels: bool,
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
                    // Heatmap (NEWSROOM_HEATMAP_VALUE_LABELS=1): a viewport whose report claims a passing
                    // value_labels proof is re-derived from these SVG bytes the same way.
                    if heatmap_value_labels
                        && qa
                            .pointer(&format!("/viewports/{viewport}/value_labels/passed"))
                            .and_then(Value::as_bool)
                            == Some(true)
                    {
                        match fs::read_to_string(&svg_path) {
                            Ok(svg_text) => {
                                for failure in verify_heatmap_labels_from_svg(&svg_text) {
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
/// runtime no longer renders one), but a listed
/// page is bound exactly like the desktop one and nothing else may be
/// listed.
fn verify_infographics(root: &Path, report: &mut VerificationReport) -> Result<()> {
    let dir = root.join("infographics");
    if !dir.is_dir() {
        return Ok(());
    }
    let verified_claims = verified_claim_ids(root)?;
    for path in sorted_dir_paths(&dir)? {
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
        // The plan is read once. A plan that exists but cannot be read is an
        // error naming the file, and the source-quote check is then not run on
        // a plan nobody could read (the error already fails the page).
        // plan_ref gets the same three checks as lint_ref: prefix, safe, present.
        let plan: Option<Value> = if !strict_readers() {
            // Switch off: the plan is read silently and a missing or unreadable one is skipped.
            safe_ref(root, plan_ref)
                .ok()
                .filter(|path| path.is_file())
                .and_then(|path| read_json(&path).ok())
        } else if !plan_ref.starts_with("infographics/plans/") {
            report.error(format!(
                "infographic {name} plan_ref must be under infographics/plans/"
            ));
            None
        } else {
            match safe_ref(root, plan_ref) {
                Ok(path) if path.is_file() => match read_json(&path) {
                    Ok(value) => Some(value),
                    Err(error) => {
                        report.error(format!(
                            "infographic {name} plan {plan_ref} is unreadable: {error}"
                        ));
                        None
                    }
                },
                Ok(_) => {
                    report.error(format!(
                        "infographic {name} references missing plan: {plan_ref}"
                    ));
                    None
                }
                Err(error) => {
                    report.error(format!(
                        "infographic {name} has an unsafe plan_ref: {error}"
                    ));
                    None
                }
            }
        };
        let plan_is_zh = plan
            .as_ref()
            .and_then(|plan| plan.get("language").and_then(Value::as_str))
            .map(|language| language == "zh")
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

        let split_qa_ref;
        let render_qa_ref = {
            split_qa_ref = split_render_qa_ref(
                root,
                "infographics/critics",
                &manifest_ref,
                &manifest,
                &format!("infographic {name}"),
                report,
            )?;
            split_qa_ref.as_str()
        };
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
                false,
                report,
            );
        }

        // Every claim the page cites must be system-verified; an empty verified set cites nothing.
        if let Some(claim_ids) = manifest.get("claim_ids").and_then(Value::as_array) {
            for claim_id in claim_ids {
                let claim_id = claim_id.as_str().unwrap_or("");
                report.check(
                    verified_claims.contains(claim_id),
                    format!("infographic {manifest_ref} claim_id is not verified: {claim_id}"),
                );
            }
        }
        verify_infographic_illustrations(root, &manifest_ref, &manifest, &verified_claims, report)?;
        verify_infographic_critics(root, &manifest_ref, name, &manifest, report)?;
        verify_infographic_source_quotes(
            root,
            name,
            plan.as_ref(),
            plan_is_zh,
            desktop_ref,
            report,
        )?;
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
    plan: Option<&Value>,
    plan_is_zh: bool,
    desktop_ref: &str,
    report: &mut VerificationReport,
) -> Result<()> {
    // None: the plan is missing or was unreadable, which the caller already
    // reported by name.
    let Some(plan) = plan else {
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
    // NEWSROOM_VISION_VETO_ONLY (default on): the model's passed is no release evidence. Every linked record is re-derived from its score,
    // rubric floor and blockers (a record that says passed=false is a failure too), and every record gets the full chain checks.
    if vision_veto_only_enabled() {
        report.check(
            !vision_critics.iter().any(vision_critic_fails),
            format!("infographic {name} failed by an image-aware vision critic (passed false, score below 80, a rubric item below 60 or a blocker)"),
        );
        for vision in &vision_critics {
            verify_vision_critic_record(root, manifest_ref, name, manifest, vision, report)?;
        }
        return Ok(());
    }
    let passing_vision: Vec<&Value> = vision_critics
        .iter()
        .filter(|critic| critic.get("passed").and_then(Value::as_bool) == Some(true))
        .collect();
    report.check(
        !passing_vision.is_empty(),
        format!("infographic {name} has no passing image-aware vision critic"),
    );
    if model_pass_selfreport_enabled() {
        report.check(
            !vision_critics.iter().any(vision_critic_vetoes),
            format!("infographic {name} vetoed by an image-aware vision critic (failed, score below 80 or blocker)"),
        );
    }
    let Some(vision) = passing_vision.first() else {
        return Ok(());
    };
    verify_vision_critic_record(root, manifest_ref, name, manifest, vision, report)
}

/// The per-record chain checks of one image-aware vision critic: schema and kind, score, blockers, rubric keys, its
/// deterministic foundation and the preview with its hashes.
fn verify_vision_critic_record(
    root: &Path,
    manifest_ref: &str,
    name: &str,
    manifest: &Value,
    vision: &Value,
    report: &mut VerificationReport,
) -> Result<()> {
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
            VISION_RUBRIC_KEYS
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
        if manifest.get("replay").and_then(Value::as_str) == Some("frozen_data") {
            // Never report.check(true, ..): frozen data is not live evidence. With the replay switch on it is a warning; otherwise an error.
            let shas = manifest
                .get("frozen_data_sha256")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let line = format!(
                "REPLAY: frozen data, publication is not live evidence: {shas} ({manifest_ref})"
            );
            if std::env::var("NEWSROOM_DOWNLOAD_FROZEN").as_deref() == Ok("1") {
                report.warnings.push(line);
            } else {
                report.error(line);
            }
        }

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
                        // NEWSROOM_PUBLICATION_EMBED_PAGE: the composed page of the bound infographic.
                        "page" => "infographics/",
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
                    if kind == "page" && exists {
                        report.check(
                            page_binding_matches_manifest(
                                root,
                                binding,
                                module_ref,
                                infographic_plan_ref,
                            ),
                            format!(
                                "publication {manifest_ref} page evidence_binding does not match its infographic render manifest: {module_ref}"
                            ),
                        );
                    }
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
                // An unreadable report is a failure, not a skip: skipping let a FAIL report that
                // only fails to parse disappear while a PASS report for the same HTML vouched
                // for the publication.
                let qa_report = match read_json(&report_path) {
                    Ok(value) => value,
                    Err(error) => {
                        if strict_readers() {
                            report.error(format!(
                                "publication {manifest_ref} browser QA report {} is unreadable: {error}",
                                report_path.display()
                            ));
                        }
                        continue;
                    }
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
        if vision_veto_only_enabled() {
            // The review must exist; the model's passed releases nothing, any failing record vetoes.
            report.check(
                !vision_critics.is_empty(),
                format!(
                    "publication {manifest_ref} upstream infographic {infographic_ref} has no image-aware vision critic"
                ),
            );
            report.check(
                !vision_critics.iter().any(vision_critic_fails),
                format!(
                    "publication {manifest_ref} upstream infographic {infographic_ref} failed by an image-aware vision critic"
                ),
            );
            return Ok(());
        }
        let has_passing_vision = vision_critics
            .iter()
            .any(|critic| critic.get("passed").and_then(Value::as_bool) == Some(true));
        report.check(
            has_passing_vision,
            format!(
                "publication {manifest_ref} upstream infographic {infographic_ref} has no passing image-aware vision critic"
            ),
        );
        if model_pass_selfreport_enabled() {
            report.check(
                !vision_critics.iter().any(vision_critic_vetoes),
                format!(
                    "publication {manifest_ref} upstream infographic {infographic_ref} vetoed by an image-aware vision critic"
                ),
            );
        }
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
/// NEWSROOM_MODEL_PASS_SELFREPORT=1 (exact "1", default off; K98): an image-aware
/// critic's verdict is the model's own, so it may only veto. Mirrors
/// runtime/pi/newsroom.ts visionCriticVetoes and scripts/verify_artifact.py.
fn model_pass_selfreport_enabled() -> bool {
    // Tests set the switch per thread so parallel tests never see each other's value.
    #[cfg(test)]
    if let Some(value) = TEST_SELFREPORT.with(|cell| cell.borrow().clone()) {
        return value.as_deref() == Some("1");
    }
    std::env::var("NEWSROOM_MODEL_PASS_SELFREPORT").as_deref() == Ok("1")
}

#[cfg(test)]
thread_local! {
    static TEST_SELFREPORT: std::cell::RefCell<Option<Option<String>>> =
        const { std::cell::RefCell::new(None) };
}

/// A linked vision critic vetoes when it failed, scored below 80 (or gave no
/// score) or reports a blocker issue - the thresholds the passing critic is
/// already held to below.
fn vision_critic_vetoes(critic: &Value) -> bool {
    critic.get("passed").and_then(Value::as_bool) != Some(true)
        || critic
            .get("score")
            .and_then(Value::as_f64)
            .is_none_or(|score| score < 80.0)
        || critic
            .get("issues")
            .and_then(Value::as_array)
            .map(|issues| {
                issues
                    .iter()
                    .any(|issue| issue.get("severity").and_then(Value::as_str) == Some("blocker"))
            })
            .unwrap_or(false)
}

/// The old layout, as the review split sees it: the draw step stamped a render-QA record (`render_qa_ref` or `render_qa`) on the manifest.
/// `split_render_qa_ref` fails a manifest on exactly this, and `old_layout_manifests` (the follow-up refusal) asks the same question.
pub(crate) fn draw_manifest_carries_render_qa(manifest: &Value) -> bool {
    manifest.get("render_qa_ref").is_some() || manifest.get("render_qa").is_some()
}

/// The visualization and infographic manifests (top-level `*.json` of `visualizations/` and `infographics/`) that a verification run with the
/// review split on would pass to `split_render_qa_ref` and that fail it, as run-relative refs. A manifest the verifier skips with its own error
/// before that point (not a gated manifest, Lieflat chart, unsupported infographic schema) or cannot read is not listed: it fails verification
/// for another reason, not for the layout.
pub(crate) fn old_layout_manifests(root: &Path) -> Result<Vec<String>> {
    let mut found = Vec::new();
    for (dir_name, infographic) in [("visualizations", false), ("infographics", true)] {
        let dir = root.join(dir_name);
        if !dir.is_dir() {
            continue;
        }
        for path in sorted_dir_paths(&dir)? {
            if !path.is_file() || path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let Ok(manifest) = read_json(&path) else {
                continue;
            };
            let gated = if infographic {
                let schema = manifest
                    .get("schema_version")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let has = |key: &str| {
                    !manifest
                        .get(key)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .is_empty()
                };
                INFOGRAPHIC_SCHEMA_VERSIONS.contains(&schema)
                    && has("plan_ref")
                    && has("lint_ref")
                    && manifest.get("variants").is_some()
            } else {
                manifest.get("kind").and_then(Value::as_str) != Some("lieflat_chart")
                    && manifest.get("variants").is_some()
                    && manifest.get("plan_ref").is_some()
            };
            if gated && draw_manifest_carries_render_qa(&manifest) {
                found.push(
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    Ok(found)
}

/// The manifests a follow-up of this run folder must refuse: `old_layout_manifests`. The follow-up refusal asks the
/// verifier's own rule through this one function, so the refusal and verification never disagree.
pub(crate) fn pre_split_layout_manifests(root: &Path) -> Result<Vec<String>> {
    old_layout_manifests(root)
}

/// With the review/draw split, a draw tool writes no render-QA record: the manifest must carry none
/// (render_qa_ref / render_qa would be a draw tool writing a review record), and the render-QA report
/// comes from a passing critic linked to the manifest. Returns that critic's `render_qa_ref`, or "" when
/// there is no such critic, so the caller's "missing render_qa_ref" failure applies (fail closed).
fn split_render_qa_ref(
    root: &Path,
    critics_dir: &str,
    manifest_ref: &str,
    manifest: &Value,
    label: &str,
    report: &mut VerificationReport,
) -> Result<String> {
    report.check(
        !draw_manifest_carries_render_qa(manifest),
        format!(
            "{label} carries a render-QA record written by the draw step; with the review split only the critic writes it"
        ),
    );
    for critic in find_critics(root, critics_dir, manifest_ref)? {
        if critic.get("passed").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if let Some(qa_ref) = critic.get("render_qa_ref").and_then(Value::as_str) {
            if !qa_ref.is_empty() {
                return Ok(qa_ref.to_owned());
            }
        }
    }
    Ok(String::new())
}

/// The ten dimensions every image-aware vision critic carries (runtime/pi/vision.mjs VISION_RUBRIC_KEYS).
const VISION_RUBRIC_KEYS: [&str; 10] = [
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

/// NEWSROOM_VISION_VETO_ONLY (default on; only the exact "0" turns it off): the image-aware critic can only veto. Release rests on the program
/// evidence (deterministic critic, render checks, lint, preview hashes, browser QA); the model's passed=true is never read as proof.
/// Mirrors runtime/pi/newsroom.ts visionCriticFails and scripts/verify_artifact.py vision_critic_fails.
fn vision_veto_only_enabled() -> bool {
    // Tests set the switch per thread so parallel tests never see each other's value.
    #[cfg(test)]
    if let Some(value) = TEST_VETO_ONLY.with(|cell| cell.borrow().clone()) {
        return value.as_deref() != Some("0");
    }
    std::env::var("NEWSROOM_VISION_VETO_ONLY").as_deref() != Ok("0")
}

#[cfg(test)]
thread_local! {
    static TEST_VETO_ONLY: std::cell::RefCell<Option<Option<String>>> =
        const { std::cell::RefCell::new(None) };
}

/// A vision critic record fails, re-derived from what it holds and not from its `passed` (only an explicit passed=false, the
/// model's own veto, also counts): score below 80 or missing, any of the ten rubric items below 60 or missing, or a blocker issue.
fn vision_critic_fails(critic: &Value) -> bool {
    if critic.get("passed").and_then(Value::as_bool) == Some(false) {
        return true;
    }
    if critic
        .get("score")
        .and_then(Value::as_f64)
        .is_none_or(|score| score < 80.0)
    {
        return true;
    }
    let rubric = critic.get("rubric").and_then(Value::as_object);
    if VISION_RUBRIC_KEYS.iter().any(|key| {
        rubric
            .and_then(|rubric| rubric.get(*key))
            .and_then(Value::as_f64)
            .is_none_or(|value| value < 60.0)
    }) {
        return true;
    }
    critic
        .get("issues")
        .and_then(Value::as_array)
        .map(|issues| {
            issues
                .iter()
                .any(|issue| issue.get("severity").and_then(Value::as_str) == Some("blocker"))
        })
        .unwrap_or(false)
}

/// The paths directly under `dir`, in sorted order. `fs::read_dir` returns the file system's own order, which differs between
/// platforms; loops whose output (an error list, the first error) follows the order read through this instead.
fn sorted_dir_paths(dir: impl AsRef<Path>) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(dir)? {
        paths.push(entry?.path());
    }
    paths.sort();
    Ok(paths)
}

fn find_critics(root: &Path, critics_dir: &str, manifest_ref: &str) -> Result<Vec<Value>> {
    let dir = root.join(critics_dir);
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for path in sorted_dir_paths(dir)? {
        if path.extension().and_then(|v| v.to_str()) == Some("json") {
            let value = read_json(&path)?;
            if value.get("manifest_ref").and_then(Value::as_str) == Some(manifest_ref) {
                out.push(value);
            }
        }
    }
    Ok(out)
}

// A claim counts as verified only while its latest record in claims.jsonl is system-verified, as in the
// runtime: a later non-verified record for the same claim_id revokes it. Lines that do not parse are
// reported by verify_claims and skipped here.
fn verified_claim_ids(root: &Path) -> Result<HashSet<String>> {
    let mut latest: HashMap<String, Value> = HashMap::new();
    let path = root.join("claims.jsonl");
    if !path.is_file() {
        return Ok(HashSet::new());
    }
    for line in BufReader::new(fs::File::open(path)?).lines() {
        let value: Value = match serde_json::from_str(&line?) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(id) = value.get("claim_id").and_then(Value::as_str) {
            latest.insert(id.to_owned(), value);
        }
    }
    Ok(latest
        .into_iter()
        .filter(|(_, value)| is_system_verified_claim(value))
        .map(|(id, _)| id)
        .collect())
}

pub(crate) fn is_system_verified_claim(value: &Value) -> bool {
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

/// A `page` evidence binding (NEWSROOM_PUBLICATION_EMBED_PAGE): the raw svg bytes must hash to the
/// `hashes.desktop_sha256` of the infographic render manifest named by `manifest_ref`, which must sit under
/// `infographics/` and name that svg as `variants.desktop`. Anything missing or different is invalid.
/// The manifest must also be the top-level render manifest of the publication's own infographic plan, the same
/// shape the runtime accepts in `resolveEmbeddedPage` (runtime/pi/newsroom.ts, via
/// `findTopLevelInfographicManifestByPlanRef`): `infographics/<key>.json` (a direct child, no sub-directory) beside `infographics/<key>.svg`, with
/// `plan_ref` equal to the publication plan's `infographic_plan_ref`.
fn page_binding_matches_manifest(
    root: &Path,
    binding: &Value,
    svg_ref: &str,
    infographic_plan_ref: &str,
) -> bool {
    let Some(manifest_ref) = binding.get("manifest_ref").and_then(Value::as_str) else {
        return false;
    };
    let Some(key) = svg_ref
        .strip_prefix("infographics/")
        .and_then(|rest| rest.strip_suffix(".svg"))
    else {
        return false;
    };
    if key.is_empty() || key.contains('/') {
        return false;
    }
    if manifest_ref != format!("infographics/{key}.json") {
        return false;
    }
    let Ok(manifest_path) = safe_ref(root, manifest_ref) else {
        return false;
    };
    let Ok(manifest) = read_json(&manifest_path) else {
        return false;
    };
    if infographic_plan_ref.is_empty()
        || manifest.get("plan_ref").and_then(Value::as_str) != Some(infographic_plan_ref)
    {
        return false;
    }
    if manifest
        .pointer("/variants/desktop")
        .and_then(Value::as_str)
        != Some(svg_ref)
    {
        return false;
    }
    let Some(expected) = manifest
        .pointer("/hashes/desktop_sha256")
        .and_then(Value::as_str)
    else {
        return false;
    };
    let Ok(svg_path) = safe_ref(root, svg_ref) else {
        return false;
    };
    matches!(sha256_file(&svg_path), Ok(actual) if actual == expected)
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
        crate::group_guard::create_scratch_dir(&path)
            .with_context(|| format!("failed to create recompute scratch {}", path.display()))?;
        Ok(Self { path })
    }
}

impl Drop for RecomputeScratch {
    fn drop(&mut self) {
        crate::group_guard::remove_scratch_dir(&self.path);
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

        crate::group_guard::write_scratch(
            &rows_path,
            format!("{}\n", serde_json::to_string(rows)?),
        )
        .with_context(|| {
            format!(
                "failed writing recompute row projection {}",
                rows_path.display()
            )
        })?;

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

/// Re-derive the read inputs of a stored SQL statement with DuckDB's parser
/// (no data access) and classify them like the runtime did at query time.
async fn derive_read_inputs(
    root: &Path,
    duckdb_bin: &Path,
    sql: &str,
    timeout_seconds: u64,
) -> Result<(Vec<(String, String)>, InputBinding)> {
    use tokio::process::Command;
    use tokio::time::{timeout, Duration};

    let literal = sql.replace('\'', "''");
    let mut command = Command::new(duckdb_bin);
    command
        .current_dir(root)
        .kill_on_drop(true)
        .arg("-noheader")
        .arg("-list")
        .arg(":memory:")
        .arg("-cmd")
        .arg("SET enable_external_access = false")
        .arg("-cmd")
        .arg("SET lock_configuration = true")
        .arg("-c")
        .arg(format!(
            "SELECT json_serialize_sql('{literal}', skip_null := true, skip_empty := true)"
        ));
    let output = timeout(Duration::from_secs(timeout_seconds), command.output())
        .await
        .context("read-input analysis timed out")??;
    if !output.status.success() {
        bail!("DuckDB could not analyze the SQL");
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let ast: Value = serde_json::from_str(text.trim())?;
    let reads = collect_sql_reads(&ast);
    let mut inputs = Vec::new();
    let mut unresolved = !reads.unresolved.is_empty();
    for path in &reads.paths {
        match sha256_file(&root.join(path)) {
            Ok(sha) => inputs.push((path.clone(), sha)),
            Err(_) => unresolved = true,
        }
    }
    let paths: Vec<String> = inputs.iter().map(|(path, _)| path.clone()).collect();
    let (binding, _) = classify_inputs(root, &paths, unresolved, 0, &[]);
    Ok((inputs, binding))
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
        // New-format records (read_inputs present) must match what DuckDB
        // derives from the stored SQL now; legacy records have nothing to
        // compare and are judged by verify_claims instead.
        if let Some(recorded) = value.get("read_inputs").and_then(Value::as_array) {
            let recorded_pairs: Vec<(String, String)> = recorded
                .iter()
                .map(|item| {
                    (
                        item.get("path")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        item.get("sha256")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                    )
                })
                .collect();
            match derive_read_inputs(root, duckdb_bin, &sql, timeout_seconds).await {
                Ok((derived, binding)) => {
                    report.check(
                        derived == recorded_pairs
                            && Some(binding) == recorded_binding_label(&value),
                        format!(
                            "recompute read_inputs mismatch: recorded inputs do not match the SQL of {}",
                            path.display()
                        ),
                    );
                }
                Err(error) => report.check(
                    false,
                    format!(
                        "recompute could not derive read inputs for {}: {error}",
                        path.display()
                    ),
                ),
            }
        }
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
        to_split_layout_viz(temp.path());
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    /// The review-split layout: the manifest carries no render-QA record; a passing critic names the report.
    fn split_viz_fixture(critic_passed: bool, critic_names_report: bool) -> tempfile::TempDir {
        let temp = build_viz_fixture(true, true);
        let root = temp.path();
        let manifest_path = root.join("visualizations/x.json");
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest.as_object_mut().unwrap().remove("render_qa_ref");
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        let mut critic =
            serde_json::json!({"passed": critic_passed, "manifest_ref": "visualizations/x.json"});
        if critic_names_report {
            critic["render_qa_ref"] = Value::String("visualizations/qa/x.json".into());
        }
        fs::write(
            root.join("visualizations/critics/x.json"),
            serde_json::to_string(&critic).unwrap(),
        )
        .unwrap();
        temp
    }

    fn verify_with_split(root: &Path) -> Vec<String> {
        let mut report = VerificationReport::default();
        let result = verify_visualizations(root, &mut report);
        result.unwrap();
        report.errors
    }

    #[test]
    fn review_split_reads_the_render_qa_report_through_the_passing_critic() {
        let temp = split_viz_fixture(true, true);
        let errors = verify_with_split(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
        // the report is still checked in full: a tampered desktop SVG no longer matches the report's hash
        fs::write(
            temp.path().join("visualizations/x.svg"),
            render_qa_svg("tampered"),
        )
        .unwrap();
        let errors = verify_with_split(temp.path());
        assert!(
            !errors.is_empty(),
            "a changed SVG must still fail through the critic's report"
        );
    }

    #[test]
    fn review_split_fails_closed_without_a_passing_critic_that_names_the_report() {
        for (passed, names) in [(true, false), (false, true), (false, false)] {
            let temp = split_viz_fixture(passed, names);
            let errors = verify_with_split(temp.path());
            assert!(
                errors.iter().any(|e| e.contains("missing render_qa_ref")),
                "passed={passed} names={names}: {errors:?}"
            );
        }
    }

    #[test]
    fn review_split_refuses_a_manifest_a_draw_tool_stamped_with_a_render_qa_record() {
        let temp = build_viz_fixture(true, true); // the old layout: render_qa_ref on the manifest
        let errors = verify_with_split(temp.path());
        assert!(
            errors
                .iter()
                .any(|e| e.contains("written by the draw step")),
            "{errors:?}"
        );
        // a manifest carrying the inline render_qa record is refused the same way
        let temp = split_viz_fixture(true, true);
        let manifest_path = temp.path().join("visualizations/x.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["render_qa"] = serde_json::json!({"passed": true});
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        let errors = verify_with_split(temp.path());
        assert!(
            errors
                .iter()
                .any(|e| e.contains("written by the draw step")),
            "{errors:?}"
        );
    }

    #[test]
    fn the_draw_stamp_is_a_render_qa_ref_or_a_render_qa_record() {
        assert!(!draw_manifest_carries_render_qa(&serde_json::json!({})));
        assert!(!draw_manifest_carries_render_qa(
            &serde_json::json!({"variants": {}, "plan_ref": "p"})
        ));
        assert!(draw_manifest_carries_render_qa(
            &serde_json::json!({"render_qa_ref": "visualizations/qa/x.json"})
        ));
        assert!(draw_manifest_carries_render_qa(
            &serde_json::json!({"render_qa": {"passed": true}})
        ));
    }

    // The follow-up refusal and the verifier ask the same question: a manifest is listed exactly when verification with the split on
    // fails it for carrying the draw step's record.
    #[test]
    fn old_layout_manifests_are_the_ones_verification_with_the_split_on_refuses() {
        let temp = build_viz_fixture(true, true); // old layout: render_qa_ref on the manifest
        let root = temp.path();
        assert_eq!(
            old_layout_manifests(root).unwrap(),
            vec!["visualizations/x.json".to_string()]
        );
        assert!(verify_with_split(root)
            .iter()
            .any(|e| e.contains("written by the draw step")));
        to_split_layout_viz(root);
        assert!(old_layout_manifests(root).unwrap().is_empty());
        assert!(!verify_with_split(root)
            .iter()
            .any(|e| e.contains("written by the draw step")));
        // a manifest verification skips with its own error is not listed for the layout
        let skipped = root.join("visualizations/legacy.json");
        fs::write(&skipped, r#"{"render_qa_ref": "x"}"#).unwrap();
        let lieflat = root.join("visualizations/lieflat.json");
        fs::write(
            &lieflat,
            r#"{"kind": "lieflat_chart", "variants": {}, "plan_ref": "p", "render_qa": {}}"#,
        )
        .unwrap();
        assert!(old_layout_manifests(root).unwrap().is_empty());
        // an infographic page manifest of the old layout is listed; one with an unsupported schema is not
        fs::create_dir_all(root.join("infographics")).unwrap();
        let page = |schema: &str| {
            serde_json::json!({
                "schema_version": schema,
                "plan_ref": "infographics/plans/p.json",
                "lint_ref": "infographics/lints/l.json",
                "variants": {"desktop": "infographics/a.svg"},
                "render_qa_ref": "infographics/qa/q.json"
            })
            .to_string()
        };
        fs::write(
            root.join("infographics/a.json"),
            page(INFOGRAPHIC_SCHEMA_VERSIONS[0]),
        )
        .unwrap();
        fs::write(root.join("infographics/b.json"), page("0.0.0-unsupported")).unwrap();
        assert_eq!(
            old_layout_manifests(root).unwrap(),
            vec!["infographics/a.json".to_string()]
        );
    }

    // End to end with the review split: scripts/test_review_split_infographic.mjs (K244_E2E_OUT=<dir>) runs the real plan, lint, render,
    // critic, preview and vision-critic tools and leaves the run folders here; without that variable this test has nothing to read and passes.
    #[test]
    fn review_split_e2e_dir() {
        let Some(base) = std::env::var_os("K244_E2E_DIR") else {
            return;
        };
        let base = std::path::PathBuf::from(base);
        let run = |name: &str| -> Vec<String> {
            let mut report = VerificationReport::default();
            let result = verify_infographics(&base.join(name), &mut report);
            result.unwrap();
            report.errors
        };
        let qa = |errors: &[String]| -> Vec<String> {
            errors
                .iter()
                .filter(|e| e.to_lowercase().contains("render") && e.to_lowercase().contains("qa"))
                .cloned()
                .collect()
        };
        let pass = run("pass");
        eprintln!("pass errors: {pass:?}");
        assert!(qa(&pass).is_empty(), "{pass:?}");
        let noref = run("noref");
        eprintln!("noref errors: {noref:?}");
        assert!(
            noref.iter().any(|e| e.contains("missing render_qa_ref")),
            "{noref:?}"
        );
        let stamped = run("stamped");
        eprintln!("stamped errors: {stamped:?}");
        assert!(
            stamped
                .iter()
                .any(|e| e.contains("written by the draw step")),
            "{stamped:?}"
        );
        let revised = run("revised");
        eprintln!("revised errors: {revised:?}");
        assert!(qa(&revised).is_empty(), "{revised:?}");
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

    /// Rewrites build_viz_fixture's manifest/QA into a desktop+compact
    /// visualization (no mobile) with matching hashes and QA coverage.
    fn build_compact_fixture() -> tempfile::TempDir {
        let temp = build_viz_fixture(true, true);
        let root = temp.path();
        let desktop_sha = sha256_bytes(render_qa_svg("desktop").as_bytes());
        let compact_svg = render_qa_svg("compact");
        let compact_sha = sha256_bytes(compact_svg.as_bytes());
        fs::write(root.join("visualizations/x.compact.svg"), &compact_svg).unwrap();
        fs::remove_file(root.join("visualizations/x.mobile.svg")).unwrap();
        let mut qa = render_qa_report_json(&desktop_sha, &compact_sha, true);
        let compact_viewport = qa["viewports"]["mobile"].clone();
        qa["viewports"].as_object_mut().unwrap().remove("mobile");
        qa["viewports"]["compact"] = compact_viewport;
        fs::write(
            root.join("visualizations/qa/x.json"),
            serde_json::to_string(&qa).unwrap(),
        )
        .unwrap();
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(root.join("visualizations/x.json")).unwrap())
                .unwrap();
        manifest["variants"] = serde_json::json!({
            "desktop": "visualizations/x.svg",
            "compact": "visualizations/x.compact.svg",
        });
        manifest["hashes"] =
            serde_json::json!({"desktop_sha256": desktop_sha, "compact_sha256": compact_sha});
        fs::write(
            root.join("visualizations/x.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        temp
    }

    fn compact_errors(temp: &tempfile::TempDir) -> Vec<String> {
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        report.errors
    }

    fn rewrite_viz_manifest(temp: &tempfile::TempDir, edit: impl FnOnce(&mut Value)) {
        let path = temp.path().join("visualizations/x.json");
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        edit(&mut manifest);
        fs::write(path, serde_json::to_string(&manifest).unwrap()).unwrap();
    }

    #[test]
    fn compact_hash_mismatch_in_manifest_hashes_fails_verification() {
        let temp = build_compact_fixture();
        rewrite_viz_manifest(&temp, |m| {
            m["hashes"]["compact_sha256"] = Value::String("0".repeat(64));
        });
        let errors = compact_errors(&temp);
        assert!(
            errors.iter().any(|e| e.contains("compact hash mismatch")),
            "{errors:?}"
        );
    }

    #[test]
    fn compact_variant_without_compact_sha256_fails_closed() {
        let temp = build_compact_fixture();
        rewrite_viz_manifest(&temp, |m| {
            m["hashes"]
                .as_object_mut()
                .unwrap()
                .remove("compact_sha256");
        });
        let errors = compact_errors(&temp);
        assert!(
            errors
                .iter()
                .any(|e| e.contains("compact variant without hashes.compact_sha256")),
            "{errors:?}"
        );
    }

    #[test]
    fn compact_variant_without_render_qa_ref_fails() {
        let temp = build_compact_fixture();
        rewrite_viz_manifest(&temp, |m| {
            m.as_object_mut().unwrap().remove("render_qa_ref");
        });
        let errors = compact_errors(&temp);
        assert!(
            errors.iter().any(|e| e.contains("missing render_qa_ref")),
            "{errors:?}"
        );
    }

    #[test]
    fn compact_sha256_without_compact_variant_fails() {
        let temp = build_viz_fixture(true, true);
        rewrite_viz_manifest(&temp, |m| {
            m["hashes"] = serde_json::json!({"compact_sha256": "0".repeat(64)});
        });
        let errors = compact_errors(&temp);
        assert!(
            errors
                .iter()
                .any(|e| e.contains("hashes.compact_sha256 without a compact variant")),
            "{errors:?}"
        );
    }

    #[test]
    fn unknown_visualization_variant_key_still_fails() {
        let temp = build_compact_fixture();
        rewrite_viz_manifest(&temp, |m| {
            m["variants"]["tablet"] = Value::String("visualizations/x.svg".into());
        });
        let errors = compact_errors(&temp);
        assert!(
            errors.iter().any(|e| e.contains("unknown variant: tablet")),
            "{errors:?}"
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
    fn build_choropleth_svg_fixture(
        include_name_label: bool,
        include_value_label: bool,
    ) -> tempfile::TempDir {
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

    // -----------------------------------------------------------------
    // heatmap value-labels re-derivation (NEWSROOM_HEATMAP_VALUE_LABELS=1)
    // -----------------------------------------------------------------

    /// One heatmap cell (value 66.6) with its value label controllable.
    fn heatmap_cell_svg(label: Option<&str>, font_size: &str, label_x: &str) -> String {
        let text = label.map(|body| format!(
            "<text data-role=\"heatmap-cell-value\" data-x=\"2020\" data-y=\"A\" x=\"{label_x}\" y=\"25\" text-anchor=\"middle\" font-size=\"{font_size}\">{body}</text>"
        )).unwrap_or_default();
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Fixture</title><desc>Fixture heatmap.</desc><rect data-role=\"heatmap-cell\" data-x=\"2020\" data-y=\"A\" data-value=\"66.6\" x=\"10\" y=\"10\" width=\"40\" height=\"30\"/>{text}</svg>"
        )
    }

    static HEATMAP_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Runs `body` with NEWSROOM_HEATMAP_VALUE_LABELS set (or removed) and restores it afterwards.
    fn with_heatmap_switch<T>(value: Option<&str>, body: impl FnOnce() -> T) -> T {
        let _guard = HEATMAP_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let old = std::env::var("NEWSROOM_HEATMAP_VALUE_LABELS").ok();
        match value {
            Some(v) => std::env::set_var("NEWSROOM_HEATMAP_VALUE_LABELS", v),
            None => std::env::remove_var("NEWSROOM_HEATMAP_VALUE_LABELS"),
        }
        let out = body();
        match old {
            Some(v) => std::env::set_var("NEWSROOM_HEATMAP_VALUE_LABELS", v),
            None => std::env::remove_var("NEWSROOM_HEATMAP_VALUE_LABELS"),
        }
        out
    }

    /// Like build_choropleth_svg_fixture, for a heatmap: the report is honestly sha256-bound to the SVG bytes and
    /// claims value_labels.passed (`claims_passed`) on both viewports.
    fn build_heatmap_svg_fixture(svg: &str, claims_passed: bool) -> tempfile::TempDir {
        let temp = build_viz_fixture(true, true);
        let root = temp.path();
        fs::write(root.join("visualizations/x.svg"), svg).unwrap();
        fs::write(root.join("visualizations/x.mobile.svg"), svg).unwrap();
        let sha = sha256_bytes(svg.as_bytes());
        let qa = render_qa_report_json_choropleth(&sha, &sha, claims_passed);
        fs::write(
            root.join("visualizations/qa/x.json"),
            serde_json::to_string(&qa).unwrap(),
        )
        .unwrap();
        let manifest_path = root.join("visualizations/x.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["chart_type"] = Value::String("heatmap".to_owned());
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        temp
    }

    #[test]
    fn heatmap_labels_from_svg_passes_when_every_cell_is_labelled_once() {
        assert_eq!(
            verify_heatmap_labels_from_svg(&heatmap_cell_svg(Some("66.6"), "12", "30")),
            Vec::<String>::new()
        );
        // a zh scale word applies: 6.66 wan is 66600, not 6.66
        let wan = heatmap_cell_svg(Some("6.7\u{4e07}"), "12", "30").replace("66.6", "66600");
        assert_eq!(verify_heatmap_labels_from_svg(&wan), Vec::<String>::new());
    }

    #[test]
    fn heatmap_labels_from_svg_fails_each_way_a_cell_can_be_unproven() {
        let missing = verify_heatmap_labels_from_svg(&heatmap_cell_svg(None, "12", "30"));
        assert!(
            missing
                .iter()
                .any(|f| f.contains("0 rendered value labels")),
            "{missing:?}"
        );
        let wrong = verify_heatmap_labels_from_svg(&heatmap_cell_svg(Some("12.3"), "12", "30"));
        assert!(
            wrong.iter().any(|f| f.contains("does not match")),
            "{wrong:?}"
        );
        let small = verify_heatmap_labels_from_svg(&heatmap_cell_svg(Some("66.6"), "9", "30"));
        assert!(small.iter().any(|f| f.contains("below 12px")), "{small:?}");
        let outside = verify_heatmap_labels_from_svg(&heatmap_cell_svg(Some("66.6"), "12", "90"));
        assert!(
            outside.iter().any(|f| f.contains("outside its cell")),
            "{outside:?}"
        );
        let nothing =
            verify_heatmap_labels_from_svg("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
        assert!(
            nothing.iter().any(|f| f.contains("no cell with a value")),
            "{nothing:?}"
        );
        let orphan = heatmap_cell_svg(Some("66.6"), "12", "30").replace(
            "data-x=\"2020\" data-y=\"A\" x=\"30\"",
            "data-x=\"2021\" data-y=\"A\" x=\"30\"",
        );
        assert!(verify_heatmap_labels_from_svg(&orphan)
            .iter()
            .any(|f| f.contains("no matching heatmap cell")));
    }

    #[test]
    fn choropleth_labels_from_svg_passes_when_every_region_is_labelled_once() {
        let svg = choropleth_region_svg(true, true);
        assert_eq!(
            verify_choropleth_labels_from_svg(&svg),
            Vec::<String>::new()
        );
    }

    #[test]
    fn choropleth_labels_from_svg_fails_when_a_name_label_is_missing() {
        let svg = choropleth_region_svg(false, true);
        let failures = verify_choropleth_labels_from_svg(&svg);
        assert!(
            failures
                .iter()
                .any(|f| f.contains("GIN") && f.contains("name labels")),
            "{failures:?}"
        );
    }

    #[test]
    fn choropleth_labels_from_svg_fails_when_a_value_label_is_missing() {
        let svg = choropleth_region_svg(true, false);
        let failures = verify_choropleth_labels_from_svg(&svg);
        assert!(
            failures
                .iter()
                .any(|f| f.contains("GIN") && f.contains("value labels")),
            "{failures:?}"
        );
    }

    #[test]
    fn compact_choropleth_labels_are_read_back_to_half_a_displayed_digit() {
        // the renderer's own text (choroplethValueText): suffix by raw magnitude, value / scale to one decimal
        for (value, text) in [
            (1155.7, "1.2k"),
            (1250.0, "1.3k"),
            (1250.0, "1.2k"), // an exact tie: JS toFixed prints 1.3k, either side of the tie is within the half step
            (1000.0, "1.0k"),
            (4949.0, "4.9k"),
            (-1155.7, "-1.2k"),
            (2_431_000.0, "2.4m"),
            (1_549_999_999.0, "1.5bn"),
            (999_960.0, "1000.0k"),
        ] {
            assert_eq!(
                scaled_label_matches(text, value),
                Some(true),
                "{text} for {value}"
            );
        }
        // off by more than half a step, the wrong suffix, a missing suffix, or the wrong number of decimals: a mismatch
        for (value, text) in [
            (1155.7, "1.3k"),
            (1155.7, "1.1k"),
            (1155.7, "1155.7k"),
            (1155.7, "1.20k"),
            (1155.7, "1k"),
            (1155.7, "1.2m"),
            (999.9, "1.0k"),
            (2_431_000.0, "2.5m"),
            (2_431_000.0, "2431.0k"),
            (1_549_999_999.0, "1.6bn"),
            (1_549_999_999.0, "1.5m"),
        ] {
            assert_eq!(
                scaled_label_matches(text, value),
                Some(false),
                "{text} for {value}"
            );
        }
        // no compact suffix: left to the ordinary reader; a unit word is not a scale
        assert_eq!(scaled_label_matches("66.6%", 66.6), None);
        assert_eq!(scaled_label_matches("1.2 mt", 1.2), None);
        assert_eq!(scaled_label_matches("1.2mt", 1.2), None);
        assert_eq!(scaled_label_matches("1.2m\u{b2}", 1_200_000.0), None);
        assert_eq!(scaled_label_matches("1.2k%", 1155.7), Some(true));
        assert_eq!(scaled_label_matches("1.2K", 1155.7), None);
    }

    #[test]
    fn plain_labels_are_read_back_to_half_a_displayed_digit_not_one_percent() {
        let one = |label: &str, value: f64| {
            let svg = choropleth_region_svg(true, true)
                .replace("66.6%", label)
                .replace("data-value=\"66.6\"", &format!("data-value=\"{value}\""));
            verify_choropleth_labels_from_svg(&svg)
        };
        assert_eq!(one("66.6%", 66.6), Vec::<String>::new());
        assert_eq!(one("66.6%", 66.64), Vec::<String>::new());
        assert_eq!(one("67.0%", 66.96), Vec::<String>::new());
        // 1% of 66.6 is 0.67: these used to pass and are now refused
        assert!(!one("66.9%", 66.6).is_empty());
        assert!(!one("66.0%", 66.6).is_empty());
        assert!(!one("1156%", 1150.0).is_empty());
        // the half step follows the decimals the label shows: two -> 0.005 (a label with none is the exact integer reader's)
        assert_eq!(one("66.60%", 66.6), Vec::<String>::new());
        assert_eq!(one("66.61%", 66.614), Vec::<String>::new());
        assert!(!one("66.62%", 66.614).is_empty());
    }

    #[test]
    fn compact_labels_from_the_renderer_are_all_read_back() {
        // fixtures/compact-label-cases.json is what runtime/pi/viz.mjs choroplethValueText prints for a grid of values
        // (scripts/test_compact_label_cases.mjs fails if the renderer drifts from it): every one must read back as its value
        let cases: Value =
            serde_json::from_str(include_str!("../fixtures/compact-label-cases.json")).unwrap();
        let cases = cases.as_array().unwrap();
        assert!(cases.len() >= 100);
        // hand-written pairs, not derived through latin_label_matches: what the renderer prints for these values
        for (value, label) in [
            (1155.7, "1.2k"),
            (2_431_000.0, "2.4m"),
            (2_431_000_000.0, "2.4bn"),
            (-1155.7, "-1.2k"),
            (999.96, "1000.0"),
        ] {
            assert!(
                cases.iter().any(|c| {
                    (c["value"].as_f64().unwrap() - value).abs() < 1e-6 * value.abs()
                        && c["label"] == label
                }),
                "the renderer grid has no {label} for {value}"
            );
        }
        assert_eq!(latin_label_matches("1.2k", 1155.7), Some(true));
        assert_eq!(latin_label_matches("1.3k", 1155.7), Some(false));
        assert_eq!(latin_label_matches("1155.7", 1155.7), Some(true));
        assert_eq!(latin_label_matches("1.2k PJ", 1155.7), Some(true));
        // a currency label is not read at all: refused (fail closed), never skipped
        assert_eq!(latin_label_matches("\u{a3}1.2m", 1_200_000.0), None);
        for case in cases {
            let value = case["value"].as_f64().unwrap();
            let label = case["label"].as_str().unwrap();
            assert!(
                latin_label_matches(label, value).unwrap(),
                "{label} for {value}"
            );
            // the same text beside a value more than half a step away is refused
            let step = if value.abs() >= 1e9 {
                1e9
            } else if value.abs() >= 1e6 {
                1e6
            } else if value.abs() >= 1e3 {
                1e3
            } else {
                1.0
            };
            let far = value + 0.2 * step;
            assert!(
                !latin_label_matches(label, far).unwrap(),
                "{label} must not read back for {far}"
            );
        }
    }

    #[test]
    fn a_nan_data_value_is_judged_as_before_the_half_step_change() {
        // the 1% check never failed a readable label against NaN (the finite-value switch refuses NaN on its own); neither does this
        assert_eq!(latin_label_matches("1.2k", f64::NAN), Some(true));
        assert_eq!(latin_label_matches("66.6%", f64::NAN), Some(true));
        assert_eq!(latin_label_matches("\u{2026}", f64::NAN), None);
        assert_eq!(heatmap_label_matches("12k", f64::NAN), Some(true));
        assert_eq!(latin_label_matches("1.2k", f64::INFINITY), Some(false));
        assert_eq!(heatmap_label_matches("12.5", f64::INFINITY), Some(false));
    }

    #[test]
    fn label_verdicts_match_the_hand_written_table() {
        // fixtures/label-verdict-cases.json is hand-written and shared with scripts/test_label_half_step_parity.py: the Python
        // integrity verifier must give the same verdict for every row
        let table: Value =
            serde_json::from_str(include_str!("../fixtures/label-verdict-cases.json")).unwrap();
        let rows = table.as_array().unwrap();
        assert!(rows.len() >= 40);
        for row in rows {
            let label = row["label"].as_str().unwrap();
            let value = row["value"].as_f64().unwrap();
            let got = match row["kind"].as_str().unwrap() {
                "choropleth" => latin_label_matches(label, value),
                "heatmap" => heatmap_label_matches(label, value),
                other => panic!("unknown kind {other}"),
            };
            let got = match got {
                None => "unreadable",
                Some(true) => "match",
                Some(false) => "mismatch",
            };
            assert_eq!(got, row["verdict"].as_str().unwrap(), "{row}");
        }
    }

    #[test]
    fn compact_label_in_the_de3fu_page_passes_and_a_changed_character_fails() {
        let svg = include_str!("../fixtures/choropleth-compact-label-nor.svg");
        assert_eq!(verify_choropleth_labels_from_svg(svg), Vec::<String>::new());
        // every character of every value label, changed to another digit or letter, must be refused
        let mut changed = 0;
        for (start, _) in svg.match_indices("data-role=\"choropleth-label-value\"") {
            let open_end = start + svg[start..].find('>').unwrap() + 1;
            let close = open_end + svg[open_end..].find("</text>").unwrap();
            let body = &svg[open_end..close];
            let text_start = open_end + body.rfind('>').map(|i| i + 1).unwrap_or(0);
            for (offset, c) in svg[text_start..close].char_indices() {
                if !(c.is_ascii_digit() || c == 'k' || c == 'm') {
                    continue;
                }
                let swap = if c.is_ascii_digit() {
                    if c == '9' {
                        '1'
                    } else {
                        ((c as u8) + 1) as char
                    }
                } else {
                    'x'
                };
                let mut mutated = svg.to_owned();
                mutated.replace_range(
                    text_start + offset..text_start + offset + 1,
                    &swap.to_string(),
                );
                assert!(
                    !verify_choropleth_labels_from_svg(&mutated).is_empty(),
                    "changing {c} at {offset} to {swap} was not refused"
                );
                changed += 1;
            }
        }
        assert!(changed >= 10, "only {changed} label characters were tried");
    }

    #[test]
    fn heatmap_labels_are_read_back_to_half_a_displayed_digit() {
        let ok = |label: &str, value: &str| {
            verify_heatmap_labels_from_svg(
                &heatmap_cell_svg(Some(label), "12", "30").replace("66.6", value),
            )
        };
        assert_eq!(ok("66.6", "66.6"), Vec::<String>::new());
        assert_eq!(ok("67", "66.6"), Vec::<String>::new());
        assert_eq!(ok("6.7\u{4e07}", "66600"), Vec::<String>::new());
        assert!(!ok("66.9", "66.6").is_empty());
        assert!(!ok("6.8\u{4e07}", "66600").is_empty());
        // fmtSpec's compact forms: "1.2k" (one decimal, half step 50) and "12k" (none, half step 500)
        assert_eq!(ok("1.2k", "1155.7"), Vec::<String>::new());
        assert_eq!(ok("12k", "12345"), Vec::<String>::new());
        assert!(!ok("1.3k", "1155.7").is_empty());
        assert!(!ok("13k", "12345").is_empty());
        assert!(!ok("1.2m\u{b2}", "1200000").is_empty());
    }

    #[test]
    fn choropleth_labels_from_svg_fails_when_the_shown_number_disagrees_with_data_value() {
        let svg = choropleth_region_svg(true, true).replace("66.6%", "12.3%");
        let failures = verify_choropleth_labels_from_svg(&svg);
        assert!(
            failures
                .iter()
                .any(|f| f.contains("GIN") && f.contains("does not match")),
            "{failures:?}"
        );
    }

    #[test]
    fn zh_plain_choropleth_labels_are_read_back_exactly() {
        // a unit that already says 万: the plain one-decimal number, no second scale
        assert_eq!(
            zh_plain_label_matches("11500.5 万人", 11500.5, true),
            Some(true)
        );
        assert_eq!(
            zh_plain_label_matches("11500.6 万人", 11500.5, true),
            Some(false)
        );
        assert_eq!(
            zh_plain_label_matches("-12.5 万人", -12.5, false),
            Some(true)
        );
        assert_eq!(zh_plain_label_matches("1.2 人", 1.2, true), None);
        // below 1万 on a map that has a 万 value: the half-up integer
        assert_eq!(zh_plain_label_matches("8766 人", 8765.5, true), Some(true));
        assert_eq!(zh_plain_label_matches("8765 人", 8765.5, true), Some(false));
        assert_eq!(zh_plain_label_matches("0 人", -0.4, true), Some(true));
        assert_eq!(zh_plain_label_matches("¥8766", 8765.5, true), Some(true));
        assert_eq!(zh_plain_label_matches("70%", 70.0, false), Some(true));
        assert_eq!(zh_plain_label_matches("71%", 70.0, false), Some(false));
        // an integer label for a non-integer value is wrong when no value reaches 1万, or for a value of 1万 or more
        assert_eq!(
            zh_plain_label_matches("8766 人", 8765.5, false),
            Some(false)
        );
        assert_eq!(
            zh_plain_label_matches("12346 人", 12345.5, true),
            Some(false)
        );
        // a decimal label is left to the other readers
        assert_eq!(zh_plain_label_matches("8765.5 人", 8765.5, true), None);
        assert_eq!(zh_plain_label_matches("1.2万 人", 11500.0, true), None);
    }

    #[test]
    fn zh_plain_choropleth_labels_round_a_half_up_not_to_even() {
        // exact binary halves, so the tie is a real tie: half-up and round-half-even differ on every line below
        // a unit that already says 万: one decimal (1.25 万 reads 1.3, 12.25 万 reads 12.3)
        assert_eq!(zh_plain_label_matches("1.3 万人", 1.25, true), Some(true));
        assert_eq!(zh_plain_label_matches("1.2 万人", 1.25, true), Some(false));
        assert_eq!(zh_plain_label_matches("12.3 万人", 12.25, true), Some(true));
        assert_eq!(
            zh_plain_label_matches("12.2 万人", 12.25, true),
            Some(false)
        );
        assert_eq!(
            zh_plain_label_matches("-12.3 万人", -12.25, true),
            Some(true)
        );
        // below 1万 on a map with a 万 value: the half-up integer (8764.5 reads 8765, not the even 8764)
        assert_eq!(zh_plain_label_matches("8765 人", 8764.5, true), Some(true));
        assert_eq!(zh_plain_label_matches("8764 人", 8764.5, true), Some(false));
    }

    #[test]
    fn zh_scaled_choropleth_labels_are_read_back_exactly() {
        // the renderer's own text for these values: suffix by raw magnitude, one decimal, half up on the decimal value
        for (value, text) in [
            (11500.0, "1.2万"),
            (12500.0, "1.3万"),
            (10800.0, "1.1万"),
            (99950.0, "10.0万"),
            (-11500.0, "-1.2万"),
            (123456789.0, "1.2亿"),
            (150000000.0, "1.5亿"),
            (2.5e12, "2.5万亿"),
            (10000.0, "1.0万"),
        ] {
            assert_eq!(
                zh_scaled_label_matches(text, value),
                Some(true),
                "{text} for {value}"
            );
        }
        // a neighbour one tenth off, the wrong scale, or a value under 1万 is a mismatch, never forgiven
        assert_eq!(zh_scaled_label_matches("1.1万", 11500.0), Some(false));
        assert_eq!(zh_scaled_label_matches("1.3万", 11500.0), Some(false));
        assert_eq!(zh_scaled_label_matches("1.2亿", 11500.0), Some(false));
        assert_eq!(zh_scaled_label_matches("1.2万", 9000.0), Some(false));
        assert_eq!(zh_scaled_label_matches("1.2万", -11500.0), Some(false));
        // not a 万 / 亿 label: the ordinary reader applies
        assert_eq!(zh_scaled_label_matches("66.6%", 66.6), None);
        assert_eq!(zh_scaled_label_matches("1.2k", 1200.0), None);
        assert_eq!(zh_scaled_label_matches("1.2万吨", 11500.0), None);
    }

    #[test]
    fn choropleth_labels_from_svg_requires_the_exact_zh_scaled_text() {
        let good = choropleth_region_svg(true, true)
            .replace("data-value=\"66.6\"", "data-value=\"11500\"")
            .replace("66.6%", "1.2万");
        assert_eq!(
            verify_choropleth_labels_from_svg(&good),
            Vec::<String>::new()
        );
        let off_by_one_tenth = good.replace("1.2万", "1.1万");
        let failures = verify_choropleth_labels_from_svg(&off_by_one_tenth);
        assert!(
            failures
                .iter()
                .any(|f| f.contains("GIN") && f.contains("does not match")),
            "{failures:?}"
        );
    }

    static FOOTNOTE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_footnote_switch<T>(value: Option<&str>, f: impl FnOnce() -> T) -> T {
        let _guard = FOOTNOTE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let old = std::env::var("NEWSROOM_VERIFY_MAP_FOOTNOTES").ok();
        match value {
            Some(v) => std::env::set_var("NEWSROOM_VERIFY_MAP_FOOTNOTES", v),
            None => std::env::remove_var("NEWSROOM_VERIFY_MAP_FOOTNOTES"),
        }
        let out = f();
        match old {
            Some(v) => std::env::set_var("NEWSROOM_VERIFY_MAP_FOOTNOTES", v),
            None => std::env::remove_var("NEWSROOM_VERIFY_MAP_FOOTNOTES"),
        }
        out
    }

    fn choropleth_footnote_svg(
        on_map_name: bool,
        footnote_name: bool,
        footnote_value: &str,
    ) -> String {
        let on_map = if on_map_name {
            r#"<text data-role="choropleth-label" data-iso3="GIN" x="5" y="5" font-size="12">Guinea</text>"#
        } else {
            ""
        };
        let name = if footnote_name {
            r#"<text data-role="choropleth-footnote-name" data-iso3="GIN" x="80" y="637" font-size="12.5">Guinea</text>"#
        } else {
            ""
        };
        let value = if footnote_value.is_empty() {
            String::new()
        } else {
            format!(
                r#"<text data-role="choropleth-footnote-value" data-iso3="GIN" x="212" y="637" text-anchor="end" font-size="12.5">{footnote_value}</text>"#
            )
        };
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><title>Fixture</title><desc>Fixture choropleth.</desc><path data-role=\"choropleth-data\" data-iso3=\"GIN\" data-value=\"66.6\" d=\"M0,0L10,0L10,10L0,10Z\"/>{on_map}{name}{value}</svg>"
        )
    }

    #[test]
    fn footnote_labelled_region_passes_unless_the_switch_is_exactly_zero() {
        let svg = choropleth_footnote_svg(false, true, "66.6%");
        for on in [None, Some("1"), Some("true"), Some(""), Some("2")] {
            assert_eq!(
                with_footnote_switch(on, || verify_choropleth_labels_from_svg(&svg)),
                Vec::<String>::new(),
                "{on:?}"
            );
        }
        {
            let off = Some("0");
            let failures = with_footnote_switch(off, || verify_choropleth_labels_from_svg(&svg));
            assert!(
                failures
                    .iter()
                    .any(|f| f.contains("GIN") && f.contains("name labels")),
                "{off:?} {failures:?}"
            );
            assert!(
                failures
                    .iter()
                    .any(|f| f.contains("GIN") && f.contains("value labels")),
                "{off:?} {failures:?}"
            );
        }
    }

    #[test]
    fn footnote_value_that_disagrees_with_data_value_fails() {
        let svg = choropleth_footnote_svg(false, true, "12.3%");
        let failures = with_footnote_switch(Some("1"), || verify_choropleth_labels_from_svg(&svg));
        assert!(
            failures
                .iter()
                .any(|f| f.contains("GIN") && f.contains("does not match")),
            "{failures:?}"
        );
    }

    #[test]
    fn region_with_no_label_anywhere_still_fails_with_the_switch_on() {
        let svg = choropleth_footnote_svg(false, false, "");
        let failures = with_footnote_switch(Some("1"), || verify_choropleth_labels_from_svg(&svg));
        assert!(
            failures
                .iter()
                .any(|f| f.contains("GIN") && f.contains("name labels")),
            "{failures:?}"
        );
        assert!(
            failures
                .iter()
                .any(|f| f.contains("GIN") && f.contains("value labels")),
            "{failures:?}"
        );
    }

    #[test]
    fn region_named_on_the_map_and_in_the_footnote_fails_exactly_one() {
        let svg = choropleth_footnote_svg(true, true, "66.6%");
        let failures = with_footnote_switch(Some("1"), || verify_choropleth_labels_from_svg(&svg));
        assert!(
            failures
                .iter()
                .any(|f| f.contains("GIN") && f.contains("2 rendered name labels")),
            "{failures:?}"
        );
    }

    #[test]
    fn on_map_only_svg_is_unchanged_by_the_footnote_switch() {
        let svg = choropleth_region_svg(true, true);
        let off = with_footnote_switch(Some("0"), || verify_choropleth_labels_from_svg(&svg));
        let on = with_footnote_switch(Some("1"), || verify_choropleth_labels_from_svg(&svg));
        assert_eq!(off, Vec::<String>::new());
        assert_eq!(on, off);
        let bad = choropleth_region_svg(false, true);
        assert_eq!(
            with_footnote_switch(Some("0"), || verify_choropleth_labels_from_svg(&bad)),
            with_footnote_switch(Some("1"), || verify_choropleth_labels_from_svg(&bad))
        );
    }

    fn same_value_regions_svg(values: &[&str], labels: bool) -> String {
        let mut svg = String::from(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>Fixture</title><desc>Fixture choropleth.</desc>"#,
        );
        for v in values {
            svg.push_str(&format!(
                r#"<path data-role="choropleth-data" data-iso3="AUS" data-value="{v}" d="M0,0L10,0L10,10L0,10Z"/>"#
            ));
        }
        if labels {
            svg.push_str(r#"<text data-role="choropleth-label" data-iso3="AUS" x="5" y="5" font-size="12">Australia</text>"#);
            svg.push_str(r#"<text data-role="choropleth-label-value" data-iso3="AUS" x="5" y="5" font-size="12">5.5%</text>"#);
        }
        svg.push_str("</svg>");
        svg
    }

    #[test]
    fn regions_with_one_value_count_as_one_value() {
        for values in [&["5.5"][..], &["5.5", "5.5", "5.5"], &["5.5", "5.50"]] {
            let svg = same_value_regions_svg(values, true);
            assert_eq!(
                verify_choropleth_labels_from_svg(&svg),
                Vec::<String>::new(),
                "{values:?}"
            );
        }
        let none =
            verify_choropleth_labels_from_svg(&same_value_regions_svg(&["5.5", "5.5"], false));
        assert!(none.iter().any(|f| f.contains("value labels")), "{none:?}");
        let wrong =
            verify_choropleth_labels_from_svg(&same_value_regions_svg(&["9.5", "9.5"], true));
        assert!(
            wrong.iter().any(|f| f.contains("does not match")),
            "{wrong:?}"
        );
    }

    #[test]
    fn regions_with_different_values_still_fail_with_the_region_count() {
        assert_eq!(
            verify_choropleth_labels_from_svg(&same_value_regions_svg(&["5.5", "6.5"], true)),
            vec![
                "AUS has 2 choropleth-data regions with conflicting data-value attributes"
                    .to_string()
            ]
        );
        assert_eq!(
            verify_choropleth_labels_from_svg(&same_value_regions_svg(
                &["5.5", "5.5", "6.5"],
                true
            )),
            vec![
                "AUS has 3 choropleth-data regions with conflicting data-value attributes"
                    .to_string()
            ]
        );
        // equal infinite values must not collapse into one value that makes any label pass
        let inf = verify_choropleth_labels_from_svg(&same_value_regions_svg(&["inf", "inf"], true));
        assert!(!inf.is_empty(), "{inf:?}");
    }

    static STRICT_READERS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_strict_readers<T>(value: Option<&str>, run: impl FnOnce() -> T) -> T {
        let _guard = STRICT_READERS_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let old = std::env::var("NEWSROOM_VERIFY_STRICT_READERS").ok();
        match value {
            Some(v) => std::env::set_var("NEWSROOM_VERIFY_STRICT_READERS", v),
            None => std::env::remove_var("NEWSROOM_VERIFY_STRICT_READERS"),
        }
        let out = run();
        match old {
            Some(v) => std::env::set_var("NEWSROOM_VERIFY_STRICT_READERS", v),
            None => std::env::remove_var("NEWSROOM_VERIFY_STRICT_READERS"),
        }
        out
    }

    #[test]
    fn choropleth_labels_from_svg_fails_when_a_data_value_is_not_a_finite_number() {
        for bad in [
            "nan", "NaN", "inf", "-inf", "Infinity", "1e400", "", " 66.6", "+66.6", "6_6",
        ] {
            // The label shows 99999: with a NaN or inf data-value the tolerance check used to pass it.
            let svg = choropleth_region_svg(true, true)
                .replace("data-value=\"66.6\"", &format!("data-value=\"{bad}\""))
                .replace("66.6%", "99999%");
            let failures =
                with_strict_readers(Some("1"), || verify_choropleth_labels_from_svg(&svg));
            assert!(
                failures
                    .iter()
                    .any(|f| f.contains("GIN") && f.contains("not a finite number")),
                "data-value {bad:?}: {failures:?}"
            );
            // Switch off or not exactly "1": the old reading, the label is not compared against an unreadable value.
            for off in [None, Some("0"), Some("true"), Some("")] {
                let failures = with_strict_readers(off, || verify_choropleth_labels_from_svg(&svg));
                assert!(
                    !failures.iter().any(|f| f.contains("not a finite number")),
                    "{off:?} {bad:?}: {failures:?}"
                );
            }
        }
    }

    #[test]
    fn choropleth_labels_from_svg_accepts_finite_data_value_spellings() {
        for good in ["66.6", "6.66e1", "66.60"] {
            let svg = choropleth_region_svg(true, true)
                .replace("data-value=\"66.6\"", &format!("data-value=\"{good}\""));
            assert_eq!(
                with_strict_readers(Some("1"), || verify_choropleth_labels_from_svg(&svg)),
                Vec::<String>::new(),
                "data-value {good:?}"
            );
        }
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

    // runs the split layout itself, no separate twin: its subject is the source-quote check, which never reads the render-QA path
    #[test]
    fn source_quote_verbatim_quote_on_correct_page_passes() {
        let (temp, _) = build_source_quote_infographic(
            true,
            "fuelwood and charcoal as renewable energy",
            2,
            Some("将燃料木材和木炭计为可再生能源"),
            true,
        );
        to_split_layout_infographic(temp.path());
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
    fn unreadable_zh_plan_with_an_empty_source_quote_is_refused() {
        // A Chinese plan whose text module has an empty source_quote is refused
        // while the plan is readable. The same plan with a bare NaN in an extra
        // field cannot be read, and that must not let it skip the check or
        // fall back to an English page.
        let (temp, _) = build_source_quote_infographic(
            true,
            "fuelwood and charcoal as renewable energy",
            2,
            Some("将燃料木材和木炭计为可再生能源"),
            true,
        );
        let plan_path = temp.path().join("infographics/plans/x.json");
        let mut plan: Value =
            serde_json::from_str(&fs::read_to_string(&plan_path).unwrap()).unwrap();
        plan["modules"][0]["source_quote"] = serde_json::json!({});
        let readable = serde_json::to_string(&plan).unwrap();
        fs::write(&plan_path, &readable).unwrap();
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(
            !report.errors.is_empty(),
            "readable empty source_quote must fail"
        );

        let unreadable = readable.replacen('{', "{\"extra\":NaN,", 1);
        fs::write(&plan_path, unreadable).unwrap();
        for off in [None, Some("0"), Some("true"), Some("")] {
            let mut report = VerificationReport::default();
            with_strict_readers(off, || {
                verify_infographics(temp.path(), &mut report).unwrap()
            });
            assert!(
                !report.errors.iter().any(|e| e.contains("is unreadable")),
                "{off:?}: {:?}",
                report.errors
            );
        }
        let mut report = VerificationReport::default();
        with_strict_readers(Some("1"), || {
            verify_infographics(temp.path(), &mut report).unwrap()
        });
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("plan infographics/plans/x.json is unreadable")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn unreadable_zh_plan_beside_an_english_strip_is_refused() {
        // Same unreadable Chinese plan, but the page carries an English strip,
        // which is what the language default would expect.
        let (temp, _) = build_source_quote_infographic(
            false,
            "fuelwood and charcoal as renewable energy",
            2,
            None,
            false,
        );
        let plan_path = temp.path().join("infographics/plans/x.json");
        let mut plan: Value =
            serde_json::from_str(&fs::read_to_string(&plan_path).unwrap()).unwrap();
        plan["language"] = Value::String("zh".to_owned());
        plan["modules"][0]["source_quote"] = serde_json::json!({});
        let unreadable = serde_json::to_string(&plan)
            .unwrap()
            .replacen('{', "{\"extra\":NaN,", 1);
        fs::write(&plan_path, unreadable).unwrap();
        let mut report = VerificationReport::default();
        with_strict_readers(Some("1"), || {
            verify_infographics(temp.path(), &mut report).unwrap()
        });
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("plan infographics/plans/x.json is unreadable")),
            "{:?}",
            report.errors
        );
    }

    fn plan_ref_errors(edit: impl Fn(&Path, &mut Value, &mut Value)) -> Vec<String> {
        let (temp, _) = build_source_quote_infographic(
            true,
            "fuelwood and charcoal as renewable energy",
            2,
            Some("将燃料木材和木炭计为可再生能源"),
            true,
        );
        let manifest_path = temp.path().join("infographics/x.json");
        let lint_path = temp.path().join("infographics/lints/x.json");
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let mut lint: Value =
            serde_json::from_str(&fs::read_to_string(&lint_path).unwrap()).unwrap();
        edit(temp.path(), &mut manifest, &mut lint);
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        fs::write(&lint_path, serde_json::to_string(&lint).unwrap()).unwrap();
        to_split_layout_infographic(temp.path());
        let mut report = VerificationReport::default();
        with_strict_readers(Some("1"), || {
            verify_infographics(temp.path(), &mut report).unwrap()
        });
        report.errors
    }

    // a clean control for the plan_ref checks, which never read the render-QA path
    #[test]
    fn infographic_plan_ref_clean_fixture_still_verifies() {
        let errors = plan_ref_errors(|_, _, _| {});
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn infographic_with_a_missing_plan_is_refused() {
        let errors = plan_ref_errors(|root, _, _| {
            fs::remove_file(root.join("infographics/plans/x.json")).unwrap();
        });
        assert!(
            errors
                .iter()
                .any(|e| e.contains("references missing plan: infographics/plans/x.json")),
            "{errors:?}"
        );
    }

    #[test]
    fn infographic_with_a_directory_plan_ref_is_refused() {
        let errors = plan_ref_errors(|_, manifest, lint| {
            manifest["plan_ref"] = Value::String("infographics/plans".to_owned());
            lint["plan_ref"] = Value::String("infographics/plans".to_owned());
        });
        assert!(
            errors.iter().any(|e| e.contains("infographics/plans")),
            "{errors:?}"
        );
    }

    #[test]
    fn infographic_with_an_unsafe_plan_ref_is_refused() {
        let errors = plan_ref_errors(|_, manifest, lint| {
            manifest["plan_ref"] = Value::String("../outside.json".to_owned());
            lint["plan_ref"] = Value::String("../outside.json".to_owned());
        });
        assert!(errors.iter().any(|e| e.contains("plan_ref")), "{errors:?}");
    }

    #[test]
    fn infographic_plan_outside_infographics_plans_is_refused() {
        let errors = plan_ref_errors(|root, manifest, lint| {
            fs::create_dir_all(root.join("elsewhere")).unwrap();
            fs::copy(
                root.join("infographics/plans/x.json"),
                root.join("elsewhere/x.json"),
            )
            .unwrap();
            manifest["plan_ref"] = Value::String("elsewhere/x.json".to_owned());
            lint["plan_ref"] = Value::String("elsewhere/x.json".to_owned());
        });
        assert!(
            errors
                .iter()
                .any(|e| e.contains("plan_ref must be under infographics/plans/")),
            "{errors:?}"
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

    // runs the split layout itself, no separate twin: its subject is the source-quote check, which never reads the render-QA path
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
        to_split_layout_infographic(temp.path());
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

    fn with_selfreport_switch<T>(value: Option<&str>, f: impl FnOnce() -> T) -> T {
        TEST_SELFREPORT.with(|cell| *cell.borrow_mut() = Some(value.map(str::to_string)));
        let out = f();
        TEST_SELFREPORT.with(|cell| *cell.borrow_mut() = None);
        out
    }

    /// A second vision critic for the same page next to the passing one:
    /// `passed` false, or passed with a low score or a blocker.
    fn add_second_vision_critic(root: &Path, manifest_ref: &str, name: &str, critic: Value) {
        let mut critic = critic;
        critic["manifest_ref"] = Value::String(manifest_ref.to_string());
        fs::write(
            root.join(format!("infographics/vision-critics/{name}.json")),
            serde_json::to_string(&critic).unwrap(),
        )
        .unwrap();
    }

    // runs the split layout itself, no separate twin: same path as infographic_vision_review_required_and_passing_verifies_split_on, the self-report switch is independent of the layout
    #[test]
    fn infographic_selfreport_vision_veto_only() {
        // These run the NEWSROOM_VISION_VETO_ONLY=0 path, where the K98 switch still applies.
        // Off (unset and any value but exact "1"): a passing vision critic
        // releases the page even next to a failing one, exactly as before.
        for value in [None, Some("true"), Some("0"), Some(" 1")] {
            let temp = build_infographic_fixture(true, true);
            to_split_layout_infographic(temp.path());
            enable_vision_review(temp.path(), 95.0, false);
            add_second_vision_critic(
                temp.path(),
                "infographics/x.json",
                "y",
                serde_json::json!({"passed": false, "score": 40}),
            );
            let errors = with_legacy_vision_switches(value, || infographic_errors(temp.path()));
            assert!(errors.is_empty(), "off ({value:?}): {errors:?}");
        }
        // On: every linked vision critic counts; a failing, low-scoring or
        // blocker one vetoes the page although another one passed.
        for veto in [
            serde_json::json!({"passed": false, "score": 95}),
            serde_json::json!({"passed": true, "score": 60}),
            serde_json::json!({"passed": true, "score": 95, "issues": [{"severity": "blocker"}]}),
            serde_json::json!({"passed": true}),
        ] {
            let temp = build_infographic_fixture(true, true);
            to_split_layout_infographic(temp.path());
            enable_vision_review(temp.path(), 95.0, false);
            add_second_vision_critic(temp.path(), "infographics/x.json", "y", veto.clone());
            let errors = with_legacy_vision_switches(Some("1"), || infographic_errors(temp.path()));
            assert_error(&errors, "vetoed by an image-aware vision critic");
        }
        // On: a model pass alone still needs every program gate; the vision
        // pass is unchanged as a requirement, never a release by itself.
        let temp = build_infographic_fixture(true, true);
        to_split_layout_infographic(temp.path());
        enable_vision_review(temp.path(), 95.0, false);
        let errors = with_legacy_vision_switches(Some("1"), || infographic_errors(temp.path()));
        assert!(errors.is_empty(), "{errors:?}");
        let temp = build_infographic_fixture(false, true);
        to_split_layout_infographic(temp.path());
        enable_vision_review(temp.path(), 95.0, false);
        let errors = with_legacy_vision_switches(Some("1"), || infographic_errors(temp.path()));
        assert!(
            !errors.is_empty(),
            "model pass must not release a page whose program gates fail"
        );
    }

    fn with_veto_only_switch<T>(value: Option<&str>, f: impl FnOnce() -> T) -> T {
        TEST_VETO_ONLY.with(|cell| *cell.borrow_mut() = Some(value.map(str::to_string)));
        let out = f();
        TEST_VETO_ONLY.with(|cell| *cell.borrow_mut() = None);
        out
    }

    /// Rewrites the fixture's vision critic record x.json with `edit`.
    fn edit_vision_critic(root: &Path, edit: impl FnOnce(&mut Value)) {
        let path = root.join("infographics/vision-critics/x.json");
        let mut critic: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        edit(&mut critic);
        fs::write(&path, serde_json::to_string(&critic).unwrap()).unwrap();
    }

    // runs the split layout itself, no separate twin: same path as infographic_vision_review_required_and_passing_verifies_split_on, the veto switch is independent of the layout
    #[test]
    fn infographic_vision_veto_only_program_pass_and_model_pass_releases() {
        let temp = build_infographic_fixture(true, true);
        to_split_layout_infographic(temp.path());
        enable_vision_review(temp.path(), 95.0, false);
        let errors = with_veto_only_switch(Some("1"), || infographic_errors(temp.path()));
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn infographic_vision_veto_only_program_pass_and_model_fail_rejects() {
        let temp = build_infographic_fixture(true, true);
        enable_vision_review(temp.path(), 95.0, false);
        edit_vision_critic(temp.path(), |critic| critic["passed"] = Value::Bool(false));
        let errors = with_veto_only_switch(Some("1"), || infographic_errors(temp.path()));
        assert_error(&errors, "failed by an image-aware vision critic");
    }

    #[test]
    fn infographic_vision_veto_only_program_fail_and_model_pass_rejects() {
        let temp = build_infographic_fixture(false, true);
        enable_vision_review(temp.path(), 95.0, false);
        let errors = with_veto_only_switch(Some("1"), || infographic_errors(temp.path()));
        assert!(
            !errors.is_empty(),
            "a model pass must not release a page whose program gates fail"
        );
    }

    // runs the split layout itself, no separate twin: same path as infographic_vision_review_required_and_passing_verifies_split_on, the veto switch is independent of the layout
    #[test]
    fn infographic_vision_veto_only_recomputes_instead_of_reading_passed() {
        // Written to disk by hand: passed=true, score 80, every rubric key present, one item at 50.
        let temp = build_infographic_fixture(true, true);
        to_split_layout_infographic(temp.path());
        enable_vision_review(temp.path(), 80.0, false);
        edit_vision_critic(temp.path(), |critic| {
            critic["rubric"]["typography"] = serde_json::json!(50)
        });
        let off = with_veto_only_switch(Some("0"), || infographic_errors(temp.path()));
        assert!(
            off.is_empty(),
            "off: unchanged, the file's passed is read: {off:?}"
        );
        let on = with_veto_only_switch(Some("1"), || infographic_errors(temp.path()));
        assert_error(&on, "failed by an image-aware vision critic");
        // A rubric key that is missing fails too.
        edit_vision_critic(temp.path(), |critic| {
            critic["rubric"]["typography"] = serde_json::json!(90);
            critic["rubric"]
                .as_object_mut()
                .unwrap()
                .remove("legibility");
        });
        let on = with_veto_only_switch(Some("1"), || infographic_errors(temp.path()));
        assert_error(&on, "failed by an image-aware vision critic");
        // passed=true is not read: score and rubric are fine, and the file says nothing about passed.
        let temp = build_infographic_fixture(true, true);
        to_split_layout_infographic(temp.path());
        enable_vision_review(temp.path(), 95.0, false);
        edit_vision_critic(temp.path(), |critic| {
            critic.as_object_mut().unwrap().remove("passed");
        });
        let on = with_veto_only_switch(Some("1"), || infographic_errors(temp.path()));
        assert!(on.is_empty(), "{on:?}");
    }

    #[test]
    fn infographic_vision_veto_only_two_records_one_failing_rejects() {
        let temp = build_infographic_fixture(true, true);
        enable_vision_review(temp.path(), 95.0, false);
        let mut second: Value = serde_json::from_str(
            &fs::read_to_string(temp.path().join("infographics/vision-critics/x.json")).unwrap(),
        )
        .unwrap();
        second["score"] = serde_json::json!(40);
        add_second_vision_critic(temp.path(), "infographics/x.json", "y", second);
        let errors = with_veto_only_switch(Some("1"), || infographic_errors(temp.path()));
        assert_error(&errors, "failed by an image-aware vision critic");
    }

    #[test]
    fn infographic_vision_veto_only_without_any_record_rejects() {
        let temp = build_infographic_fixture(true, true);
        edit_infographic_fixture(temp.path(), |manifest, _qa| {
            manifest["visual_review_required"] = Value::Bool(true);
        });
        let errors = with_veto_only_switch(Some("1"), || infographic_errors(temp.path()));
        assert_error(&errors, "requires image-aware vision critic");
    }

    #[test]
    fn infographic_vision_veto_only_runs_the_chain_checks_on_every_record() {
        // A second record whose score and rubric are fine but whose preview is gone still breaks the page.
        let temp = build_infographic_fixture(true, true);
        enable_vision_review(temp.path(), 95.0, false);
        let mut second: Value = serde_json::from_str(
            &fs::read_to_string(temp.path().join("infographics/vision-critics/x.json")).unwrap(),
        )
        .unwrap();
        second["preview_ref"] = serde_json::json!("infographics/previews/gone.json");
        add_second_vision_critic(temp.path(), "infographics/x.json", "y", second);
        let errors = with_veto_only_switch(Some("1"), || infographic_errors(temp.path()));
        assert_error(&errors, "vision preview missing");
    }

    #[test]
    fn publication_lineage_vision_veto_only() {
        let rubric = serde_json::json!({
            "hierarchy": 90, "legibility": 90, "composition": 90, "visual_coherence": 90,
            "typography": 90, "source_legibility": 90, "responsive_quality": 90,
            "illustration_integration": 90, "color_contrast": 90, "editorial_distinctiveness": 90,
        });
        let write = |root: &Path, name: &str, mut critic: Value| {
            critic["manifest_ref"] = serde_json::json!("infographics/ig1.json");
            fs::write(
                root.join(format!("infographics/vision-critics/{name}.json")),
                serde_json::to_string(&critic).unwrap(),
            )
            .unwrap();
        };
        let (temp, _key) = build_publication_fixture(true, true);
        write(
            temp.path(),
            "v1",
            serde_json::json!({"passed": true, "score": 95, "rubric": rubric}),
        );
        let on = with_veto_only_switch(Some("1"), || publication_errors(temp.path()));
        assert!(
            on.iter().all(|e| !e.contains("upstream infographic")),
            "{on:?}"
        );
        // The hand-written record: passed, score 80, keys complete, one item at 50.
        let mut low = rubric.clone();
        low["typography"] = serde_json::json!(50);
        write(
            temp.path(),
            "v1",
            serde_json::json!({"passed": true, "score": 80, "rubric": low}),
        );
        let off = with_veto_only_switch(Some("0"), || publication_errors(temp.path()));
        assert!(
            off.iter().all(|e| !e.contains("upstream infographic")),
            "{off:?}"
        );
        let on = with_veto_only_switch(Some("1"), || publication_errors(temp.path()));
        assert_error(
            &on,
            "upstream infographic infographics/ig1.json failed by an image-aware vision critic",
        );
        // One passes, one fails.
        write(
            temp.path(),
            "v1",
            serde_json::json!({"passed": true, "score": 95, "rubric": rubric}),
        );
        write(
            temp.path(),
            "v2",
            serde_json::json!({"passed": false, "score": 95, "rubric": rubric}),
        );
        let on = with_veto_only_switch(Some("1"), || publication_errors(temp.path()));
        assert_error(&on, "failed by an image-aware vision critic");
        // None at all.
        fs::remove_file(temp.path().join("infographics/vision-critics/v1.json")).unwrap();
        fs::remove_file(temp.path().join("infographics/vision-critics/v2.json")).unwrap();
        let on = with_veto_only_switch(Some("1"), || publication_errors(temp.path()));
        assert_error(&on, "has no image-aware vision critic");
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

    // runs the split layout itself, no separate twin: illustration critics sit outside the render-QA path; the clean split-on infographic is render_qa_pass_allows_infographic_to_verify_split_on
    #[test]
    fn infographic_illustration_verifies_when_linked_and_passing() {
        let temp = build_infographic_fixture(true, true);
        to_split_layout_infographic(temp.path());
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
    /// A vision critic record that passes on its content and not on `passed` alone (VISION_VETO_ONLY re-derives it): score 95,
    /// all ten rubric items 90, no issues.
    fn passing_vision_critic_record(manifest_ref: &str) -> Value {
        serde_json::json!({
            "manifest_ref": manifest_ref,
            "passed": true,
            "score": 95,
            "rubric": {
                "hierarchy": 90, "legibility": 90, "composition": 90, "visual_coherence": 90,
                "typography": 90, "source_legibility": 90, "responsive_quality": 90,
                "illustration_integration": 90, "color_contrast": 90, "editorial_distinctiveness": 90,
            },
            "issues": [],
        })
    }

    /// The pre-K250 path: NEWSROOM_VISION_VETO_ONLY=0 with the K98 self-report switch set to `selfreport`.
    fn with_legacy_vision_switches<T>(selfreport: Option<&str>, f: impl FnOnce() -> T) -> T {
        with_veto_only_switch(Some("0"), || with_selfreport_switch(selfreport, f))
    }

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
            serde_json::to_string(&passing_vision_critic_record("infographics/ig1.json")).unwrap(),
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

    fn set_module_binding(root: &Path, binding: Value) {
        let plan_path = root.join("publications/plans/plan.json");
        let mut plan: Value =
            serde_json::from_str(&fs::read_to_string(&plan_path).unwrap()).unwrap();
        plan["modules"][0]["evidence_binding"] = binding;
        fs::write(&plan_path, serde_json::to_string(&plan).unwrap()).unwrap();
    }

    /// Writes infographics/page.svg and a render manifest naming it, with the given recorded hash.
    fn write_page_and_manifest(root: &Path, svg: &[u8], recorded_sha: &str, desktop_ref: &str) {
        fs::write(root.join("infographics/page.svg"), svg).unwrap();
        fs::write(
            root.join("infographics/page.json"),
            serde_json::to_string(&serde_json::json!({
                "plan_ref": "infographics/plans/x.json",
                "variants": {"desktop": desktop_ref},
                "hashes": {"desktop_sha256": recorded_sha},
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn page_binding(manifest_ref: Option<&str>) -> Value {
        let mut binding = serde_json::json!({"kind": "page", "ref": "infographics/page.svg"});
        if let Some(manifest_ref) = manifest_ref {
            binding["manifest_ref"] = Value::String(manifest_ref.to_owned());
        }
        binding
    }

    #[test]
    fn publication_page_binding_under_infographics_verifies() {
        let (temp, _key) = build_publication_fixture(true, true);
        write_page_and_manifest(
            temp.path(),
            b"<svg/>",
            &sha256_bytes(b"<svg/>"),
            "infographics/page.svg",
        );
        set_module_binding(temp.path(), page_binding(Some("infographics/page.json")));
        let errors = publication_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn publication_page_binding_hash_counter_examples_fail() {
        let msg = "page evidence_binding does not match its infographic render manifest: infographics/page.svg";
        let (temp, _key) = build_publication_fixture(true, true);
        let root = temp.path();
        // tampered svg: bytes no longer hash to the manifest's desktop_sha256
        write_page_and_manifest(
            root,
            b"<svg/>",
            &sha256_bytes(b"<svg/>"),
            "infographics/page.svg",
        );
        fs::write(root.join("infographics/page.svg"), "<svg><!--x--></svg>").unwrap();
        set_module_binding(root, page_binding(Some("infographics/page.json")));
        assert_error(&publication_errors(root), msg);
        // manifest names another svg as its desktop variant
        write_page_and_manifest(
            root,
            b"<svg/>",
            &sha256_bytes(b"<svg/>"),
            "infographics/other.svg",
        );
        assert_error(&publication_errors(root), msg);
        // no manifest_ref at all
        write_page_and_manifest(
            root,
            b"<svg/>",
            &sha256_bytes(b"<svg/>"),
            "infographics/page.svg",
        );
        set_module_binding(root, page_binding(None));
        assert_error(&publication_errors(root), msg);
        // manifest_ref missing on disk
        set_module_binding(root, page_binding(Some("infographics/absent.json")));
        assert_error(&publication_errors(root), msg);
        // manifest outside infographics/ (a perfectly matching one)
        fs::create_dir_all(root.join("visualizations")).unwrap();
        fs::copy(
            root.join("infographics/page.json"),
            root.join("visualizations/page.json"),
        )
        .unwrap();
        set_module_binding(root, page_binding(Some("visualizations/page.json")));
        assert_error(&publication_errors(root), msg);
        // manifest without hashes.desktop_sha256
        fs::write(
            root.join("infographics/page.json"),
            serde_json::to_string(&serde_json::json!({
                "plan_ref": "infographics/plans/x.json",
                "variants": {"desktop": "infographics/page.svg"},
            }))
            .unwrap(),
        )
        .unwrap();
        set_module_binding(root, page_binding(Some("infographics/page.json")));
        assert_error(&publication_errors(root), msg);
    }

    #[test]
    fn publication_page_binding_plan_and_shape_counter_examples_fail() {
        let msg = "page evidence_binding does not match its infographic render manifest: infographics/page.svg";
        let (temp, _key) = build_publication_fixture(true, true);
        let root = temp.path();
        let svg_sha = sha256_bytes(b"<svg/>");
        // control: top-level manifest beside the svg, plan_ref equal to the publication's infographic_plan_ref
        write_page_and_manifest(root, b"<svg/>", &svg_sha, "infographics/page.svg");
        set_module_binding(root, page_binding(Some("infographics/page.json")));
        assert!(publication_errors(root).is_empty());
        // a self-consistent svg + manifest pair (right hash, right variant) from another infographic plan
        let manifest_path = root.join("infographics/page.json");
        let write_manifest = |manifest: Value| {
            fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        };
        write_manifest(serde_json::json!({
            "plan_ref": "infographics/plans/other.json",
            "variants": {"desktop": "infographics/page.svg"},
            "hashes": {"desktop_sha256": svg_sha},
        }));
        assert_error(&publication_errors(root), msg);
        // manifest without plan_ref
        write_manifest(serde_json::json!({
            "variants": {"desktop": "infographics/page.svg"},
            "hashes": {"desktop_sha256": svg_sha},
        }));
        assert_error(&publication_errors(root), msg);
        // non-top-level manifests (right plan, right hash): under plans/, under rejected/, and not beside the svg
        write_page_and_manifest(root, b"<svg/>", &svg_sha, "infographics/page.svg");
        for dir in ["infographics/plans", "infographics/rejected"] {
            fs::create_dir_all(root.join(dir)).unwrap();
            fs::copy(
                root.join("infographics/page.json"),
                root.join(format!("{dir}/page.json")),
            )
            .unwrap();
            set_module_binding(root, page_binding(Some(&format!("{dir}/page.json"))));
            assert_error(&publication_errors(root), msg);
        }
        fs::copy(
            root.join("infographics/page.json"),
            root.join("infographics/elsewhere.json"),
        )
        .unwrap();
        set_module_binding(root, page_binding(Some("infographics/elsewhere.json")));
        assert_error(&publication_errors(root), msg);
    }

    #[test]
    fn publication_page_binding_outside_infographics_or_missing_fails() {
        let (temp, _key) = build_publication_fixture(true, true);
        fs::create_dir_all(temp.path().join("visualizations")).unwrap();
        fs::write(temp.path().join("visualizations/v.svg"), "<svg/>").unwrap();
        set_module_binding(
            temp.path(),
            serde_json::json!({"kind": "page", "ref": "visualizations/v.svg"}),
        );
        assert_error(
            &publication_errors(temp.path()),
            "module evidence_binding is missing or invalid: visualizations/v.svg",
        );
        set_module_binding(
            temp.path(),
            serde_json::json!({"kind": "page", "ref": "infographics/absent.svg"}),
        );
        assert_error(
            &publication_errors(temp.path()),
            "module evidence_binding is missing or invalid: infographics/absent.svg",
        );
        // an infographics/ ref under any other kind stays invalid
        fs::write(temp.path().join("infographics/page.svg"), "<svg/>").unwrap();
        set_module_binding(
            temp.path(),
            serde_json::json!({"kind": "asset", "ref": "infographics/page.svg"}),
        );
        assert_error(
            &publication_errors(temp.path()),
            "module evidence_binding is missing or invalid: infographics/page.svg",
        );
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
        // Default (VISION_VETO_ONLY on): a record saying passed=false fails the page.
        let errors = publication_errors(temp.path());
        assert_error(
            &errors,
            "upstream infographic infographics/ig1.json failed by an image-aware vision critic",
        );
        // NEWSROOM_VISION_VETO_ONLY=0: the old behaviour, no passing record.
        let errors = with_veto_only_switch(Some("0"), || publication_errors(temp.path()));
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
    fn publication_infographic_lineage_selfreport_vision_veto_only() {
        // Each shape alone must veto: the score and blocker terms must not hide a missing passed term.
        for veto in [
            serde_json::json!({"passed": false, "score": 95}),
            serde_json::json!({"passed": true, "score": 60}),
            serde_json::json!({"passed": true, "score": 95, "issues": [{"severity": "blocker"}]}),
            serde_json::json!({"passed": true}),
        ] {
            let mut failing = veto.clone();
            failing["manifest_ref"] = serde_json::json!("infographics/ig1.json");
            let (temp, _key) = build_publication_fixture(true, true);
            // The fixture's own critic carries no score; give it a clean pass so only the added critic can veto.
            fs::write(
                temp.path().join("infographics/vision-critics/v1.json"),
                serde_json::to_string(&serde_json::json!({
                    "manifest_ref": "infographics/ig1.json", "passed": true, "score": 95
                }))
                .unwrap(),
            )
            .unwrap();
            let clean = with_legacy_vision_switches(Some("1"), || publication_errors(temp.path()));
            assert!(
                clean.iter().all(|e| !e.contains("vetoed")),
                "{veto}: a clean pass alone must not veto: {clean:?}"
            );
            fs::write(
                temp.path().join("infographics/vision-critics/v9.json"),
                serde_json::to_string(&failing).unwrap(),
            )
            .unwrap();
            let off = with_legacy_vision_switches(None, || publication_errors(temp.path()));
            assert!(
                off.iter().all(|e| !e.contains("upstream infographic")),
                "{veto}: {off:?}"
            );
            let on = with_legacy_vision_switches(Some("1"), || publication_errors(temp.path()));
            assert_error(
                &on,
                "upstream infographic infographics/ig1.json vetoed by an image-aware vision critic",
            );
        }
    }

    #[test]
    fn default_on_veto_only_with_selfreport_on_never_releases_a_passed_only_page() {
        // VISION_VETO_ONLY unset (default on) and the K98 self-report switch on: a record carrying only passed=true is not a pass.
        let (temp, _key) = build_publication_fixture(true, true);
        fs::write(
            temp.path().join("infographics/vision-critics/v1.json"),
            serde_json::to_string(
                &serde_json::json!({"manifest_ref": "infographics/ig1.json", "passed": true}),
            )
            .unwrap(),
        )
        .unwrap();
        let errors = with_veto_only_switch(None, || {
            with_selfreport_switch(Some("1"), || publication_errors(temp.path()))
        });
        assert_error(
            &errors,
            "upstream infographic infographics/ig1.json failed by an image-aware vision critic",
        );
        let temp = build_infographic_fixture(true, true);
        enable_vision_review(temp.path(), 95.0, false);
        edit_vision_critic(temp.path(), |critic| {
            *critic = serde_json::json!({
                "manifest_ref": "infographics/x.json", "passed": true,
            });
        });
        let errors = with_veto_only_switch(None, || {
            with_selfreport_switch(Some("1"), || infographic_errors(temp.path()))
        });
        assert_error(&errors, "failed by an image-aware vision critic");
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

    #[test]
    fn publication_unreadable_fail_report_beside_a_pass_report_fails() {
        // The FAIL report only fails to parse (an extra NaN field); it must not be skipped while the PASS
        // report for the same HTML vouches for the publication.
        for first_is_fail in [true, false] {
            let (temp, key) = build_publication_fixture(true, false);
            let (fail_name, pass_name) = if first_is_fail {
                ("a-fail", "b-pass")
            } else {
                ("b-fail", "a-pass")
            };
            add_qa_report(temp.path(), pass_name, &key, "PASS");
            add_qa_report(temp.path(), fail_name, &key, "FAIL");
            let path = temp
                .path()
                .join("publications/qa")
                .join(fail_name)
                .join("browser-qa.json");
            let text = fs::read_to_string(&path)
                .unwrap()
                .replacen('{', "{\"extra\":NaN,", 1);
            fs::write(&path, text).unwrap();
            let errors = with_strict_readers(Some("1"), || publication_errors(temp.path()));
            assert_error(
                &errors,
                &format!("publications/qa/{fail_name}/browser-qa.json is unreadable"),
            );
            for off in [None, Some("0"), Some("true"), Some("")] {
                let errors = with_strict_readers(off, || publication_errors(temp.path()));
                assert!(
                    !errors.iter().any(|e| e.contains("is unreadable")),
                    "{off:?}: {errors:?}"
                );
            }
        }
    }

    #[test]
    fn publication_single_readable_pass_report_still_verifies() {
        let (temp, key) = build_publication_fixture(true, false);
        add_qa_report(temp.path(), "only-pass", &key, "PASS");
        let errors = publication_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
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

    fn set_infographic_claim_ids(root: &Path, claim_ids: &[&str]) {
        let manifest_path = root.join("infographics/x.json");
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest["claim_ids"] = serde_json::json!(claim_ids);
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
    }

    #[test]
    fn infographic_citing_an_unverified_claim_fails() {
        // The fixture has no verified claim at all, so any cited claim id is unverified.
        let temp = build_infographic_fixture(true, true);
        set_infographic_claim_ids(temp.path(), &["c-not-verified"]);
        let errors = infographic_errors(temp.path());
        assert_error(
            &errors,
            "infographic infographics/x.json claim_id is not verified: c-not-verified",
        );
    }

    #[test]
    fn infographic_citing_no_claim_has_no_claim_error() {
        let temp = build_infographic_fixture(true, true);
        set_infographic_claim_ids(temp.path(), &[]);
        let errors = infographic_errors(temp.path());
        assert!(
            !errors
                .iter()
                .any(|e| e.contains("claim_id is not verified")),
            "{errors:?}"
        );
    }

    fn claim_line(claim_id: &str, status: &str) -> String {
        serde_json::to_string(&serde_json::json!({
            "claim_id": claim_id,
            "status": status,
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
        }))
        .unwrap()
    }

    fn write_claim_lines(root: &Path, lines: &[(&str, &str)]) {
        let text: String = lines
            .iter()
            .map(|(id, status)| format!("{}\n", claim_line(id, status)))
            .collect();
        fs::write(root.join("claims.jsonl"), text).unwrap();
    }

    #[test]
    fn infographic_citing_a_revoked_claim_fails_and_a_reverified_one_passes() {
        let temp = build_infographic_fixture(true, true);
        set_infographic_claim_ids(temp.path(), &["c-x"]);
        write_claim_lines(temp.path(), &[("c-x", "verified"), ("c-x", "contested")]);
        assert_error(
            &infographic_errors(temp.path()),
            "infographic infographics/x.json claim_id is not verified: c-x",
        );
        write_claim_lines(temp.path(), &[("c-x", "contested"), ("c-x", "verified")]);
        assert!(
            !infographic_errors(temp.path())
                .iter()
                .any(|e| e.contains("claim_id is not verified")),
            "contested then verified must count as verified"
        );
    }

    #[test]
    fn visualization_citing_a_revoked_claim_fails_and_a_reverified_one_passes() {
        let temp = build_viz_fixture(true, true);
        let id = "claim-render-qa-fixture";
        write_claim_lines(temp.path(), &[(id, "verified"), (id, "contested")]);
        assert_error(
            &viz_errors(temp.path()),
            &format!("claim_id is not verified: {id}"),
        );
        write_claim_lines(temp.path(), &[(id, "contested"), (id, "verified")]);
        assert!(
            !viz_errors(temp.path())
                .iter()
                .any(|e| e.contains("claim_id is not verified")),
            "contested then verified must count as verified"
        );
    }

    fn claims_errors(root: &Path) -> Vec<String> {
        let mut report = VerificationReport::default();
        verify_claims(root, &mut report).unwrap();
        report.errors
    }

    fn write_claims_text(root: &Path, text: &str) {
        fs::write(root.join("claims.jsonl"), text).unwrap();
    }

    static STRICT_REFS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_strict_refs<T>(value: Option<&str>, run: impl FnOnce() -> T) -> T {
        let _guard = STRICT_REFS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let old = std::env::var("NEWSROOM_VERIFY_STRICT_REFS").ok();
        match value {
            Some(v) => std::env::set_var("NEWSROOM_VERIFY_STRICT_REFS", v),
            None => std::env::remove_var("NEWSROOM_VERIFY_STRICT_REFS"),
        }
        let out = run();
        match old {
            Some(v) => std::env::set_var("NEWSROOM_VERIFY_STRICT_REFS", v),
            None => std::env::remove_var("NEWSROOM_VERIFY_STRICT_REFS"),
        }
        out
    }

    fn claim_with_refs(source_refs: Value, computation_refs: Value) -> Vec<String> {
        with_strict_refs(Some("1"), || {
            claim_with_refs_inner(source_refs, computation_refs)
        })
    }

    fn claim_with_refs_inner(source_refs: Value, computation_refs: Value) -> Vec<String> {
        let temp = tempfile::tempdir().unwrap();
        let mut claim: Value = serde_json::from_str(&claim_line("c-x", "verified")).unwrap();
        claim["source_refs"] = source_refs;
        claim["computation_refs"] = computation_refs;
        write_claims_text(
            temp.path(),
            &format!("{}\n", serde_json::to_string(&claim).unwrap()),
        );
        claims_errors(temp.path())
    }

    #[test]
    fn verified_claim_with_a_non_string_source_ref_is_refused() {
        for bad in [
            serde_json::json!(null),
            serde_json::json!(1),
            serde_json::json!({}),
        ] {
            let errors = claim_with_refs(
                serde_json::json!([bad.clone()]),
                serde_json::json!(["computations/x.json"]),
            );
            assert_error(
                &errors,
                "verified claim on line 1 source_refs[0] must be a non-empty string",
            );
        }
    }

    #[test]
    fn verified_claim_with_a_non_string_computation_ref_is_refused() {
        for bad in [
            serde_json::json!(null),
            serde_json::json!(1),
            serde_json::json!({}),
        ] {
            let errors = claim_with_refs(
                serde_json::json!(["sources/x.json"]),
                serde_json::json!([bad.clone()]),
            );
            assert_error(
                &errors,
                "verified claim on line 1 computation_refs[0] must be a non-empty string",
            );
        }
    }

    #[test]
    fn verified_claim_with_only_null_refs_and_no_directories_is_refused() {
        // The 8d79c2b audit case: [null] twice, no sources/ or computations/ directory.
        let errors = claim_with_refs(serde_json::json!([null]), serde_json::json!([null]));
        assert_error(&errors, "source_refs[0] must be a non-empty string");
        assert_error(&errors, "computation_refs[0] must be a non-empty string");
    }

    #[test]
    fn verified_claim_with_string_refs_gets_no_ref_type_error() {
        let errors = claim_with_refs(
            serde_json::json!(["sources/x.json"]),
            serde_json::json!(["computations/x.json"]),
        );
        assert!(
            !errors
                .iter()
                .any(|e| e.contains("must be a non-empty string")),
            "{errors:?}"
        );
    }

    #[test]
    fn story_evidence_item_that_is_not_a_string_is_refused() {
        for bad in [
            serde_json::json!(null),
            serde_json::json!(1),
            serde_json::json!({}),
        ] {
            let temp = tempfile::tempdir().unwrap();
            fs::write(
                temp.path().join("story.json"),
                serde_json::to_string(&serde_json::json!({
                    "kind": "investigation",
                    "files": {},
                    "evidence": {"sources": [bad.clone()]},
                }))
                .unwrap(),
            )
            .unwrap();
            let report = with_strict_refs(Some("1"), || verify_artifact(temp.path()).unwrap());
            assert_error(
                &report.errors,
                "story evidence.sources[0] must be a non-empty string",
            );
            let off = with_strict_refs(None, || verify_artifact(temp.path()).unwrap());
            assert!(
                !off.errors
                    .iter()
                    .any(|e| e.contains("must be a non-empty string")),
                "{:?}",
                off.errors
            );
        }
    }

    #[test]
    fn non_string_claim_refs_are_skipped_as_before_when_the_switch_is_not_exactly_one() {
        for value in [None, Some("0"), Some("true"), Some("")] {
            let errors = with_strict_refs(value, || {
                claim_with_refs_inner(serde_json::json!([null]), serde_json::json!([null]))
            });
            assert!(
                !errors
                    .iter()
                    .any(|e| e.contains("must be a non-empty string")),
                "{value:?}: {errors:?}"
            );
        }
    }

    #[test]
    fn verify_claims_refuses_a_record_without_a_claim_id() {
        let temp = tempfile::tempdir().unwrap();
        let good = claim_line("c-x", "verified");
        write_claims_text(
            temp.path(),
            &format!("{good}\n{{\"status\":\"contested\"}}\n"),
        );
        assert_error(
            &claims_errors(temp.path()),
            "claims.jsonl line 2 is not a claim record with a non-empty string claim_id",
        );
    }

    #[test]
    fn verify_claims_refuses_a_numeric_claim_id() {
        let temp = tempfile::tempdir().unwrap();
        let good = claim_line("1", "verified");
        write_claims_text(
            temp.path(),
            &format!("{good}\n{{\"claim_id\": 1, \"status\": \"contested\"}}\n"),
        );
        assert_error(
            &claims_errors(temp.path()),
            "claims.jsonl line 2 is not a claim record with a non-empty string claim_id",
        );
    }

    #[test]
    fn verify_claims_refuses_a_line_that_is_not_an_object() {
        for bad in ["[1]", "\"x\"", "7", "null"] {
            let temp = tempfile::tempdir().unwrap();
            let good = claim_line("c-x", "verified");
            write_claims_text(temp.path(), &format!("{good}\n\n{bad}\n"));
            assert_error(
                &claims_errors(temp.path()),
                "claims.jsonl line 3 is not a claim record with a non-empty string claim_id",
            );
        }
    }

    #[test]
    fn verify_claims_refuses_an_empty_claim_id() {
        let temp = tempfile::tempdir().unwrap();
        write_claims_text(temp.path(), &format!("{}\n", claim_line("", "contested")));
        assert_error(
            &claims_errors(temp.path()),
            "claims.jsonl line 1 is not a claim record with a non-empty string claim_id",
        );
    }

    // Pins how verify_claims reads whole claims.jsonl files (serde_json, default features, and
    // BufReader::lines(), which splits at \n only), so the Python verifier can follow the same rule.
    fn claims_errors_for_text(text: &str) -> Vec<String> {
        let temp = tempfile::tempdir().unwrap();
        write_claims_text(temp.path(), text);
        claims_errors(temp.path())
    }

    fn assert_claims_line_refused(text: &str, line: usize) {
        let errors = claims_errors_for_text(text);
        assert!(
            errors
                .iter()
                .any(|e| e.starts_with(&format!("claims.jsonl line {line} "))),
            "expected an error for line {line} in {errors:?}"
        );
    }

    #[test]
    fn verify_claims_refuses_non_finite_and_overflowing_numbers() {
        let good = claim_line("c-x", "verified");
        for (name, bad) in [
            (
                "NaN",
                r#"{"claim_id":"a","status":"contested","n":NaN}"#.to_owned(),
            ),
            (
                "Infinity",
                r#"{"claim_id":"a","status":"contested","n":Infinity}"#.to_owned(),
            ),
            (
                "-Infinity",
                r#"{"claim_id":"a","status":"contested","n":-Infinity}"#.to_owned(),
            ),
            (
                "1e400",
                r#"{"claim_id":"a","status":"contested","n":1e400}"#.to_owned(),
            ),
            (
                "-1e400",
                r#"{"claim_id":"a","status":"contested","n":-1e400}"#.to_owned(),
            ),
            (
                "400-digit integer",
                format!(
                    r#"{{"claim_id":"a","status":"contested","n":{}}}"#,
                    "9".repeat(400)
                ),
            ),
        ] {
            let _ = name;
            assert_claims_line_refused(&format!("{good}\n{bad}\n"), 2);
        }
    }

    fn nested(depth: usize) -> String {
        format!(
            r#"{{"claim_id":"a","status":"contested","d":{}0{}}}"#,
            "[".repeat(depth),
            "]".repeat(depth)
        )
    }

    #[test]
    fn verify_claims_pins_the_nesting_depth_boundary() {
        // Probed against serde_json 1.0.151 (recursion limit 128): with the record object as level 1 and the
        // scalar inside as the last, `d` holding 126 arrays is the deepest accepted line; 127 arrays are refused.
        assert!(claims_errors_for_text(&format!("{}\n", nested(126))).is_empty());
        assert_claims_line_refused(&format!("{}\n", nested(127)), 1);
    }

    #[test]
    fn verify_claims_refuses_lines_that_python_would_split_or_strip() {
        let good = claim_line("c-x", "verified");
        let other = claim_line("c-y", "contested");
        assert_claims_line_refused(&format!("{good}\n\u{1c}\u{1d}\u{1e}\u{1f}\n"), 2);
        for sep in [
            "\r", "\x0b", "\x0c", "\u{1c}", "\u{1d}", "\u{1e}", "\u{85}", "\u{2028}", "\u{2029}",
        ] {
            assert_claims_line_refused(&format!("{good}\n{other}{sep}{other}\n"), 2);
        }
    }

    #[test]
    fn verify_claims_refuses_a_bom_and_reads_a_raw_u2028_in_a_string_as_one_record() {
        let good = claim_line("c-x", "contested");
        assert_claims_line_refused(&format!("\u{feff}{good}\n"), 1);
        let with_u2028 =
            "{\"claim_id\":\"a\",\"status\":\"contested\",\"note\":\"one\u{2028}two\"}";
        let errors = claims_errors_for_text(&format!("{good}\n{with_u2028}\n"));
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn verify_claims_pins_blank_lines_in_range_integers_and_lone_surrogates() {
        let good = claim_line("c-x", "contested");
        // str::trim() strips Unicode White_Space only: these lines are blank and skipped.
        let blanks = "\u{85}\n\u{a0}\u{3000}\n\u{2028}\u{2029}\n\t \r\n";
        assert!(claims_errors_for_text(&format!("{good}\n{blanks}{good}\n")).is_empty());
        // An integer past 64 bits is read as f64: 100 digits are accepted.
        let big = format!(
            r#"{{"claim_id":"a","status":"contested","n":{}}}"#,
            "9".repeat(100)
        );
        assert!(claims_errors_for_text(&format!("{good}\n{big}\n")).is_empty());
        // A lone surrogate escape is refused.
        assert_claims_line_refused(
            &format!(
                "{good}\n{}\n",
                r#"{"claim_id":"a","status":"contested","s":"\ud800"}"#
            ),
            2,
        );
    }

    #[test]
    fn verified_claim_set_leaves_out_a_status_only_record() {
        let temp = build_infographic_fixture(true, true);
        set_infographic_claim_ids(temp.path(), &["c-x"]);
        let status_only = serde_json::to_string(&serde_json::json!({
            "claim_id": "c-x", "status": "verified",
        }))
        .unwrap();
        write_claims_text(
            temp.path(),
            &format!("{}\n{status_only}\n", claim_line("c-x", "verified")),
        );
        assert!(!verified_claim_ids(temp.path()).unwrap().contains("c-x"));
        assert_error(
            &infographic_errors(temp.path()),
            "infographic infographics/x.json claim_id is not verified: c-x",
        );
        let viz = build_viz_fixture(true, true);
        let id = "claim-render-qa-fixture";
        write_claims_text(
            viz.path(),
            &format!(
                "{}\n{}\n",
                claim_line(id, "verified"),
                serde_json::json!({"claim_id": id, "status": "verified"})
            ),
        );
        assert_error(
            &viz_errors(viz.path()),
            &format!("claim_id is not verified: {id}"),
        );
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

    // runs the split layout itself, no separate twin: its subject is the schema 1.4.0 rubric, not where the render-QA record lives; the clean split-on infographic is render_qa_pass_allows_infographic_to_verify_split_on
    #[test]
    fn infographic_1_4_0_clean_control_verifies() {
        let temp = build_infographic_fixture(true, true);
        to_split_layout_infographic(temp.path());
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

    /// Snapshot of a page whose text was cut on an emoji ("abc😀def" cut at 4
    /// UTF-16 units). The hashes were produced by Node's sourceContentHash
    /// (runtime/pi/provenance.mjs) and are pinned in
    /// scripts/test_source_cut_wellformed.mjs: `helper` is the record cut by
    /// sliceWellFormed (text "abc"), `plain` the one cut by a plain slice (text
    /// ends in the lone high surrogate \ud83d).
    const CUT_HELPER_HASH: &str =
        "97d11664003459e55307a9407490fd492853b246c7097eada313805388d10172";
    const CUT_PLAIN_HASH: &str = "e3db4cd4bb38976feae3e84e03bb24e905a832167efe888eb1cfc6d3932bcb59";

    fn write_cut_snapshot(root: &Path, hash: &str, text_json: &str) {
        fs::create_dir_all(root.join("sources")).unwrap();
        // Written as raw JSON text so a lone surrogate escape reaches the reader.
        let record = format!(
            r#"{{"schema_version":"0.7.0","final_url":"https://example.org/emoji","status":200,"content_type":"text/html","truncated":true,"content_hash":"{hash}","trust":"untrusted_external_content","text":{text_json}}}"#
        );
        fs::write(root.join(format!("sources/{hash}.json")), record).unwrap();
    }

    #[test]
    fn source_cut_on_an_emoji_by_the_runtime_helper_verifies() {
        let payload = serde_json::json!({
            "content_type": "text/html",
            "final_url": "https://example.org/emoji",
            "status": 200,
            "text": "abc",
            "truncated": true,
        });
        assert_eq!(
            sha256_bytes(canonical_json(&payload).as_bytes()),
            CUT_HELPER_HASH,
            "Rust hash must equal the Node hash"
        );
        let temp = tempfile::tempdir().unwrap();
        write_cut_snapshot(temp.path(), CUT_HELPER_HASH, r#""abc""#);
        let mut report = VerificationReport::default();
        verify_sources(temp.path(), &mut report).expect("snapshot must be readable");
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    #[test]
    fn source_cut_on_an_emoji_by_plain_slice_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        write_cut_snapshot(temp.path(), CUT_PLAIN_HASH, r#""abc\ud83d""#);
        let mut report = VerificationReport::default();
        assert!(verify_sources(temp.path(), &mut report).is_err());
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

    // ---- read-input binding (issue #36) ----

    fn reader_ast(function: &str, path: &str) -> Value {
        serde_json::json!({
            "error": false,
            "statements": [{"node": {"from_table": {
                "type": "TABLE_FUNCTION",
                "function": {"function_name": function, "children": [
                    {"class": "CONSTANT", "value": {"is_null": false, "type": {"id": "VARCHAR"}, "value": path}}
                ]}
            }}}]
        })
    }

    #[test]
    fn sql_reads_classify_files_literals_and_unresolved() {
        let reads = collect_sql_reads(&reader_ast("read_csv_auto", "data/x.csv"));
        assert_eq!(reads.paths, vec!["data/x.csv".to_owned()]);
        assert!(reads.unresolved.is_empty());
        for bad in [
            "data/*.csv",
            "../etc/passwd",
            "/abs/data/x.csv",
            "other/x.csv",
        ] {
            let reads = collect_sql_reads(&reader_ast("read_csv_auto", bad));
            assert!(
                reads.paths.is_empty() && !reads.unresolved.is_empty(),
                "{bad}"
            );
        }
        assert!(!collect_sql_reads(&reader_ast("mystery_fn", "data/x.csv"))
            .unresolved
            .is_empty());
        assert!(!collect_sql_reads(&serde_json::json!({"error": true}))
            .unresolved
            .is_empty());
        let literal = serde_json::json!({"error": false, "statements": [{"node": {"from_table": {
            "type": "TABLE_FUNCTION", "function": {"function_name": "generate_series", "children": []}}}}]});
        assert_eq!(collect_sql_reads(&literal), SqlReads::default());
    }

    const BIND_DATA_SHA: &str = "492d5ea496056f1a6a6592241032fab764c321596317930b4fa0e1e8bc3b7470";

    /// Artifact with data/a.csv, one computation and one verified claim citing it.
    fn build_binding_fixture(computation_extra: Value, source_ref: &str) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join("computations")).unwrap();
        fs::write(root.join("data/a.csv"), "a,b\n1,2\n").unwrap();
        let mut record =
            serde_json::json!({"schema_version": "0.7.0", "sql": "SELECT 1", "rows": []});
        for (key, value) in computation_extra.as_object().unwrap() {
            record[key] = value.clone();
        }
        let computation = format!("computations/{}.json", "c".repeat(64));
        fs::write(root.join(&computation), record.to_string()).unwrap();
        let claim = serde_json::json!({
            "schema_version": "0.8.0", "claim_id": "claim-1", "status": "verified",
            "source_refs": [source_ref], "computation_refs": [computation],
            "verification": {"authority": "system", "source_resolved": true, "extraction_passed": true,
                "computation_replayed": true, "claim_supported": true, "publishable": true,
                "rule_id": "verification.source+extraction+computation+claim.v1"}
        });
        fs::write(root.join("claims.jsonl"), format!("{claim}\n")).unwrap();
        temp
    }

    fn claim_errors(root: &Path) -> Vec<String> {
        let mut report = VerificationReport::default();
        verify_claims(root, &mut report).unwrap();
        report.errors
    }

    #[test]
    fn verified_claim_over_legacy_computation_is_an_integrity_error() {
        // (c) no read_inputs at all: a legacy record, possibly a VALUES table.
        let temp = build_binding_fixture(serde_json::json!({}), "data/a.csv");
        let errors = claim_errors(temp.path());
        assert!(
            errors
                .iter()
                .any(|e| e.starts_with("COMPUTATION_PROVENANCE_REQUIRED") && e.contains("legacy")),
            "{errors:?}"
        );
    }

    #[test]
    fn verified_claim_over_literal_only_computation_is_an_integrity_error() {
        let temp = build_binding_fixture(
            serde_json::json!({"read_inputs": [], "input_binding": "literal_only"}),
            "data/a.csv",
        );
        let errors = claim_errors(temp.path());
        assert!(
            errors.iter().any(|e| e.contains("literal_only")),
            "{errors:?}"
        );
    }

    #[test]
    fn verified_claim_over_computation_reading_the_cited_file_passes() {
        // (b)
        let temp = build_binding_fixture(
            serde_json::json!({"read_inputs": [{"path": "data/a.csv", "sha256": BIND_DATA_SHA}], "input_binding": "source_bound"}),
            "data/a.csv",
        );
        assert_eq!(claim_errors(temp.path()), Vec::<String>::new());
        let mut report = VerificationReport::default();
        let path = temp
            .path()
            .join(format!("computations/{}.json", "c".repeat(64)));
        let value = read_json(&path).unwrap();
        verify_computation_read_inputs(temp.path(), &path, &value, &mut report);
        assert_eq!(report.errors, Vec::<String>::new());
    }

    #[test]
    fn claim_citing_a_source_the_computation_did_not_read_is_refused() {
        let temp = build_binding_fixture(
            serde_json::json!({"read_inputs": [{"path": "data/a.csv", "sha256": BIND_DATA_SHA}], "input_binding": "source_bound"}),
            "data/other.csv",
        );
        let errors = claim_errors(temp.path());
        assert!(
            errors
                .iter()
                .any(|e| e.contains("cites no source read by computation")),
            "{errors:?}"
        );
    }

    #[test]
    fn forged_or_stale_read_inputs_fail_record_validation() {
        for extra in [
            serde_json::json!({"read_inputs": [{"path": "data/a.csv", "sha256": "0".repeat(64)}], "input_binding": "source_bound"}),
            serde_json::json!({"read_inputs": [], "input_binding": "source_bound"}),
            serde_json::json!({"read_inputs": [{"path": "data/a.csv", "sha256": BIND_DATA_SHA}], "input_binding": "literal_only"}),
            serde_json::json!({"read_inputs": [{"path": "../x", "sha256": BIND_DATA_SHA}], "input_binding": "source_bound"}),
            serde_json::json!({"input_binding": "source_bound"}),
        ] {
            let temp = build_binding_fixture(extra.clone(), "data/a.csv");
            let path = temp
                .path()
                .join(format!("computations/{}.json", "c".repeat(64)));
            let value = read_json(&path).unwrap();
            let mut report = VerificationReport::default();
            verify_computation_read_inputs(temp.path(), &path, &value, &mut report);
            assert!(!report.errors.is_empty(), "{extra}");
        }
    }
    // verify_derived_input: one chain per fixture, one link broken per test.
    struct DerivedFixture {
        temp: tempfile::TempDir,
        sha: String,
        rows_path: String,
        meta_path: PathBuf,
        origin_path: PathBuf,
    }

    fn derived_fixture() -> DerivedFixture {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in ["data/derived", "data/origins"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let pdf = b"%PDF-1.4 synthetic pdf bytes";
        let sha = sha256_bytes(pdf);
        let source_file = format!("data/{sha}.data");
        fs::write(root.join(&source_file), pdf).unwrap();
        let rows = br#"[{"page":1,"line":1,"x":0,"text":"Alpha  10"}]"#;
        let rows_path = format!("data/derived/{sha}.pdf-rows.json");
        fs::write(root.join(&rows_path), rows).unwrap();
        let rows_sha = sha256_bytes(rows);
        let meta_path = root.join(format!("data/derived/{sha}.pdf-rows.meta.json"));
        let meta = serde_json::json!({
            "kind": "pdf_row_table", "rows_file": rows_path, "rows_sha256": rows_sha,
            "source_sha256": sha, "source_file": source_file,
        });
        fs::write(&meta_path, meta.to_string()).unwrap();
        let origin_path = root.join("data/origins/origin.json");
        let origin = serde_json::json!({
            "file": source_file, "sha256": sha,
            "derived_text": { "file": rows_path, "rows_sha256": rows_sha },
        });
        fs::write(&origin_path, origin.to_string()).unwrap();
        DerivedFixture {
            temp,
            sha,
            rows_path,
            meta_path,
            origin_path,
        }
    }

    fn rewrite_json(path: &Path, edit: impl FnOnce(&mut Value)) {
        let mut value = read_json(path).unwrap();
        edit(&mut value);
        fs::write(path, value.to_string()).unwrap();
    }

    fn derived_error(fixture: &DerivedFixture) -> String {
        verify_derived_input(fixture.temp.path(), &fixture.rows_path)
            .expect_err("tampered chain must fail")
    }

    #[test]
    fn derived_input_accepts_an_untouched_chain() {
        let fixture = derived_fixture();
        let source = verify_derived_input(fixture.temp.path(), &fixture.rows_path).unwrap();
        assert_eq!(source, format!("data/{}.data", fixture.sha));
    }

    #[test]
    fn derived_input_rejects_a_path_that_is_not_a_derived_table() {
        let fixture = derived_fixture();
        let err = verify_derived_input(fixture.temp.path(), "data/derived/stray.csv").unwrap_err();
        assert_eq!(err, "not a recognised derived table path");
    }

    #[test]
    fn derived_input_rejects_missing_meta() {
        let fixture = derived_fixture();
        fs::remove_file(&fixture.meta_path).unwrap();
        assert!(derived_error(&fixture).starts_with("derived metadata unreadable:"));
    }

    #[test]
    fn derived_input_rejects_missing_origin() {
        let fixture = derived_fixture();
        fs::remove_file(&fixture.origin_path).unwrap();
        assert_eq!(
            derived_error(&fixture),
            "no download record binds this table to the PDF"
        );
    }

    #[test]
    fn derived_input_rejects_an_origin_that_does_not_bind_the_table() {
        let fixture = derived_fixture();
        rewrite_json(&fixture.origin_path, |origin| {
            origin.as_object_mut().unwrap().remove("derived_text");
        });
        assert_eq!(
            derived_error(&fixture),
            "no download record binds this table to the PDF"
        );
    }

    #[test]
    fn derived_input_rejects_edited_rows_bytes() {
        let fixture = derived_fixture();
        fs::write(
            fixture.temp.path().join(&fixture.rows_path),
            br#"[{"page":1,"line":1,"x":0,"text":"Alphx  10"}]"#,
        )
        .unwrap();
        assert_eq!(
            derived_error(&fixture),
            "derived table bytes do not match rows_sha256"
        );
    }

    #[test]
    fn derived_input_rejects_a_changed_source_pdf() {
        let fixture = derived_fixture();
        fs::write(
            fixture
                .temp
                .path()
                .join(format!("data/{}.data", fixture.sha)),
            b"%PDF-1.4 tampered",
        )
        .unwrap();
        assert_eq!(
            derived_error(&fixture),
            "source PDF bytes do not match source_sha256"
        );
    }

    #[test]
    fn derived_input_rejects_a_wrong_source_sha() {
        let fixture = derived_fixture();
        rewrite_json(&fixture.meta_path, |meta| {
            meta["source_sha256"] = Value::from("0".repeat(64))
        });
        assert_eq!(
            derived_error(&fixture),
            "derived table is not named for its source sha256"
        );
    }

    #[test]
    fn derived_input_rejects_a_rows_file_that_names_another_table() {
        let fixture = derived_fixture();
        let other = format!("data/derived/{}.pdf-rows.json", "1".repeat(64));
        rewrite_json(&fixture.meta_path, |meta| {
            meta["rows_file"] = Value::from(other)
        });
        assert_eq!(
            derived_error(&fixture),
            "derived metadata does not describe this table"
        );
    }

    #[test]
    fn derived_input_rejects_a_source_that_is_not_the_content_addressed_pdf() {
        for source in [
            // outside data/
            format!("sources/{}.pdf", "a".repeat(64)),
            // nested below data/
            format!("data/nested/{}.data", "a".repeat(64)),
            // under data/ but not named for the hash
            "data/other.data".to_owned(),
        ] {
            let fixture = derived_fixture();
            let source = source.replace(&"a".repeat(64), &fixture.sha);
            rewrite_json(&fixture.meta_path, |meta| {
                meta["source_file"] = Value::from(source.clone())
            });
            assert_eq!(
                derived_error(&fixture),
                "source_file is not the content-addressed PDF",
                "{source}"
            );
        }
    }

    #[test]
    fn derived_tables_walk_reports_a_broken_chain_and_ignores_meta_files() {
        let fixture = derived_fixture();
        let mut report = VerificationReport::default();
        verify_derived_tables(fixture.temp.path(), &mut report);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        fs::remove_file(&fixture.origin_path).unwrap();
        verify_derived_tables(fixture.temp.path(), &mut report);
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].contains(
            "failed its provenance chain: no download record binds this table to the PDF"
        ));
    }

    // --- NEWSROOM_QA_TICK_READBACK (K198, K200, K202): shared cases + manifest wiring ---

    static TICK_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn tick_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/fixtures/tick_readback")
    }

    fn tick_json(name: &str) -> Value {
        serde_json::from_str(&fs::read_to_string(tick_dir().join(name)).unwrap()).unwrap()
    }

    fn tick_build(case: &Value, fixtures: &Value) -> (String, TickReadbackContext) {
        let f = &fixtures[case["fixture"].as_str().unwrap()];
        let mut svg = fs::read_to_string(tick_dir().join(f["file"].as_str().unwrap())).unwrap();
        for edit in case
            .get("edits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let find = edit["find"].as_str().unwrap();
            assert!(svg.contains(find), "edit target not found: {find}");
            svg = svg.replacen(find, edit["replace"].as_str().unwrap(), 1);
        }
        let mut rows = f["rows"].as_array().unwrap().clone();
        if let Some(extra) = case.get("rows_extra") {
            rows.push(extra.clone());
        }
        let text = |v: &Value| v.as_str().map(str::to_string);
        let mut ctx = TickReadbackContext {
            chart_type: f["chart_type"].as_str().unwrap().to_string(),
            rows: Some(rows),
            category_field: text(&f["category_field"]),
            value_field: text(&f["value_field"]),
            series_field: text(&f["series_field"]),
            period_field: text(&f["period_field"]),
            unit: text(&f["unit"]),
            language: text(&f["language"]),
        };
        if let Some(over) = case.get("ctx").and_then(Value::as_object) {
            if let Some(t) = over.get("chart_type").and_then(Value::as_str) {
                ctx.chart_type = t.to_string();
            }
        }
        for key in case
            .get("ctx_drop")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if key.as_str() == Some("rows") {
                ctx.rows = None;
            }
        }
        (svg, ctx)
    }

    #[test]
    fn tick_readback_shared_cases_match_expectation() {
        let fixtures = tick_json("fixtures.json");
        let cases = tick_json("cases.json");
        let cases = cases.as_array().unwrap();
        assert_eq!(cases.len(), 41);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let (svg, ctx) = tick_build(case, &fixtures);
            let (status, failures) = verify_tick_readback_from_svg(&svg, &ctx);
            match case["expect"].as_str().unwrap() {
                "green" => {
                    assert_eq!(status, TickReadbackStatus::Covered, "{name}");
                    assert!(failures.is_empty(), "{name}: {failures:?}");
                }
                "uncovered" => {
                    assert_eq!(status, TickReadbackStatus::Uncovered, "{name}");
                    assert!(failures.is_empty(), "{name}");
                }
                "red" => {
                    let rule = case["rule"].as_str().unwrap();
                    assert!(
                        failures.iter().any(|(r, _)| r == rule),
                        "{name}: wanted {rule}, got {failures:?}"
                    );
                }
                other => panic!("{name}: unknown expectation {other}"),
            }
        }
    }

    /// Writes plan/computation/svg + a manifest into a temp root and returns it.
    fn tick_tree(fixture_key: &str, edits: &[(&str, &str)]) -> tempfile::TempDir {
        let fixtures = tick_json("fixtures.json");
        let f = &fixtures[fixture_key];
        let mut svg = fs::read_to_string(tick_dir().join(f["file"].as_str().unwrap())).unwrap();
        for (find, replace) in edits {
            assert!(svg.contains(find));
            svg = svg.replacen(find, replace, 1);
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in ["visualizations/plans", "computations"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let mut plan = serde_json::json!({"category_field": f["category_field"], "value_field": f["value_field"]});
        if f.get("series_field").is_some() {
            plan["series_field"] = f["series_field"].clone();
        }
        if f.get("period_field").is_some() {
            plan["period_field"] = f["period_field"].clone();
        }
        fs::write(root.join("visualizations/plans/x.json"), plan.to_string()).unwrap();
        fs::write(
            root.join("computations/x.json"),
            serde_json::json!({"rows": f["rows"], "result_hash": "h1"}).to_string(),
        )
        .unwrap();
        fs::write(root.join("visualizations/x.svg"), svg).unwrap();
        fs::write(
            root.join("visualizations/x.json"),
            serde_json::json!({
                "plan_ref": "visualizations/plans/x.json",
                "computation_ref": "computations/x.json",
                "data_hash": "h1",
                "chart_type": f["chart_type"],
                "variants": {"desktop": "visualizations/x.svg"},
            })
            .to_string(),
        )
        .unwrap();
        temp
    }

    fn tick_manifest(root: &Path) -> Value {
        read_json(&root.join("visualizations/x.json")).unwrap()
    }

    #[test]
    fn tick_readback_manifest_green_and_tampered() {
        let green = tick_tree("hb_B", &[]);
        let mut report = VerificationReport::default();
        verify_tick_readback_from_svg_manifest_for_test(green.path(), &mut report);
        assert!(report.errors.is_empty(), "{:?}", report.errors);

        let red = tick_tree("hb_B", &[(">71万<", ">7.1万<")]);
        let mut report = VerificationReport::default();
        verify_tick_readback_from_svg_manifest_for_test(red.path(), &mut report);
        assert!(!report.errors.is_empty());
        assert!(
            report.errors.iter().any(|e| e.contains("tick read-back")),
            "{:?}",
            report.errors
        );
    }

    fn verify_tick_readback_from_svg_manifest_for_test(
        root: &Path,
        report: &mut VerificationReport,
    ) {
        verify_tick_readback_for_manifest(root, "x.json", &tick_manifest(root), report);
    }

    #[test]
    fn tick_readback_manifest_uncovered_type_warns_and_hash_mismatch_errors() {
        let tree = tick_tree("hb_A", &[]);
        let mut manifest = tick_manifest(tree.path());
        manifest["chart_type"] = Value::String("line".into());
        let mut report = VerificationReport::default();
        verify_tick_readback_for_manifest(tree.path(), "x.json", &manifest, &mut report);
        assert!(report.errors.is_empty());
        assert!(report.warnings.iter().any(|w| w.contains("not covered")));

        let mut manifest = tick_manifest(tree.path());
        manifest["data_hash"] = Value::String("other".into());
        let mut report = VerificationReport::default();
        verify_tick_readback_for_manifest(tree.path(), "x.json", &manifest, &mut report);
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("not the manifest's data")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn tick_readback_switch_gates_the_check_in_verify_visualizations() {
        let _guard = TICK_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let run = |value: Option<&str>| {
            match value {
                Some(v) => std::env::set_var("NEWSROOM_QA_TICK_READBACK", v),
                None => std::env::remove_var("NEWSROOM_QA_TICK_READBACK"),
            }
            let temp = build_viz_fixture(true, true);
            let mut report = VerificationReport::default();
            verify_visualizations(temp.path(), &mut report).unwrap();
            std::env::remove_var("NEWSROOM_QA_TICK_READBACK");
            (report.errors, report.warnings, report.checks)
        };
        let off = run(None);
        for v in ["0", "", "yes", " 1", "on"] {
            assert_eq!(run(Some(v)), off, "switch value {v:?} must equal unset");
        }
        let on = run(Some("1"));
        assert_eq!(on.0, off.0);
        assert!(
            on.1.iter()
                .any(|w| w.contains("tick read-back not covered")),
            "{:?}",
            on.1
        );
        assert!(!off.1.iter().any(|w| w.contains("tick read-back")));
    }

    // -----------------------------------------------------------------
    // Counterparts with the review split on. Each one builds the fixture of its old-layout twin(s), then converts only the layout:
    // the render-QA record comes from a passing critic instead of from the manifest. No data, hash, claim or expected value changes.
    // -----------------------------------------------------------------

    /// Moves `render_qa_ref` from `<dir>/x.json` (the draw step's record) to the passing critic `<dir>/critics/x.json`.
    fn to_split_layout(root: &Path, dir: &str) {
        let manifest_path = root.join(format!("{dir}/x.json"));
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        let qa_ref = manifest.as_object_mut().unwrap().remove("render_qa_ref");
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        let critic_path = root.join(format!("{dir}/critics/x.json"));
        let mut critic: Value = read_json(&critic_path).unwrap();
        if let Some(qa_ref) = qa_ref {
            critic["render_qa_ref"] = qa_ref;
        }
        fs::write(&critic_path, serde_json::to_string(&critic).unwrap()).unwrap();
    }

    fn to_split_layout_viz(root: &Path) {
        to_split_layout(root, "visualizations");
    }

    fn to_split_layout_infographic(root: &Path) {
        to_split_layout(root, "infographics");
    }

    // Twins: render_qa_failed_report_fails_verification
    #[test]
    fn render_qa_failed_report_fails_verification_split_on() {
        let temp = build_viz_fixture(false, true);
        to_split_layout_viz(temp.path());
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

    // Twins: render_qa_tampered_svg_hash_mismatch_fails_verification
    #[test]
    fn render_qa_tampered_svg_hash_mismatch_fails_verification_split_on() {
        let temp = build_viz_fixture(true, true);
        to_split_layout_viz(temp.path());
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

    // Twins: render_qa_unsafe_ref_is_rejected (the unsafe ref moves to the critic with the rest of the layout)
    #[test]
    fn render_qa_unsafe_ref_is_rejected_split_on() {
        let temp = build_viz_fixture(true, true);
        let manifest_path = temp.path().join("visualizations/x.json");
        let mut manifest: Value = read_json(&manifest_path).unwrap();
        manifest["render_qa_ref"] = Value::String("../../etc/passwd".to_owned());
        fs::write(&manifest_path, serde_json::to_string(&manifest).unwrap()).unwrap();
        to_split_layout_viz(temp.path());
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

    // Twins: desktop_only_visualization_verifies, desktop_only_visualization_rejects_a_report_with_a_mobile_viewport,
    // desktop_only_visualization_without_hashes_still_verifies
    #[test]
    fn desktop_only_visualization_verifies_split_on() {
        let temp = build_viz_fixture(true, true);
        edit_viz_fixture(temp.path(), |manifest, qa| {
            manifest["variants"]
                .as_object_mut()
                .unwrap()
                .remove("mobile");
            qa["viewports"].as_object_mut().unwrap().remove("mobile");
        });
        fs::remove_file(temp.path().join("visualizations/x.mobile.svg")).unwrap();
        to_split_layout_viz(temp.path());
        let errors = viz_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");

        let temp = build_viz_fixture(true, true);
        edit_viz_fixture(temp.path(), |manifest, _qa| {
            manifest["variants"]
                .as_object_mut()
                .unwrap()
                .remove("mobile");
        });
        to_split_layout_viz(temp.path());
        assert_error(
            &viz_errors(temp.path()),
            "viewports.mobile, which the manifest does not list",
        );

        let temp = build_viz_fixture(true, true);
        let root = temp.path();
        let desktop_sha = sha256_bytes(render_qa_svg("desktop").as_bytes());
        let mobile_sha = sha256_bytes(render_qa_svg("mobile").as_bytes());
        let mut qa = render_qa_report_json(&desktop_sha, &mobile_sha, true);
        qa["viewports"].as_object_mut().unwrap().remove("mobile");
        fs::write(
            root.join("visualizations/qa/x.json"),
            serde_json::to_string(&qa).unwrap(),
        )
        .unwrap();
        rewrite_viz_manifest(&temp, |m| {
            m["variants"].as_object_mut().unwrap().remove("mobile");
        });
        to_split_layout_viz(temp.path());
        let errors = compact_errors(&temp);
        assert!(errors.is_empty(), "{errors:?}");
    }

    // Twins: visualization_listing_mobile_still_requires_its_svg_and_viewport
    #[test]
    fn visualization_listing_mobile_still_requires_its_svg_and_viewport_split_on() {
        let temp = build_viz_fixture(true, true);
        edit_viz_fixture(temp.path(), |_manifest, qa| {
            qa["viewports"].as_object_mut().unwrap().remove("mobile");
        });
        fs::remove_file(temp.path().join("visualizations/x.mobile.svg")).unwrap();
        to_split_layout_viz(temp.path());
        let errors = viz_errors(temp.path());
        assert_error(&errors, "missing mobile SVG");
        assert_error(&errors, "missing viewports.mobile.svg_sha256");
    }

    // Twins: compact_variant_with_matching_qa_and_hashes_verifies, compact_svg_tampered_after_qa_fails_verification
    #[test]
    fn compact_variant_with_matching_qa_and_hashes_verifies_split_on() {
        let temp = build_compact_fixture();
        to_split_layout_viz(temp.path());
        let errors = compact_errors(&temp);
        assert!(errors.is_empty(), "{errors:?}");

        let temp = build_compact_fixture();
        to_split_layout_viz(temp.path());
        fs::write(
            temp.path().join("visualizations/x.compact.svg"),
            render_qa_svg("tampered-compact"),
        )
        .unwrap();
        let errors = compact_errors(&temp);
        assert!(
            errors
                .iter()
                .any(|e| e.contains("compact SVG hash does not match render_qa report")),
            "{errors:?}"
        );
    }

    // Twins: compact_variant_with_missing_render_qa_file_fails, compact_variant_with_qa_lacking_compact_viewport_fails
    #[test]
    fn compact_variant_with_missing_render_qa_file_fails_split_on() {
        let temp = build_compact_fixture();
        to_split_layout_viz(temp.path());
        fs::remove_file(temp.path().join("visualizations/qa/x.json")).unwrap();
        let errors = compact_errors(&temp);
        assert!(
            errors
                .iter()
                .any(|e| e.contains("render_qa_ref is missing: visualizations/qa/x.json")),
            "{errors:?}"
        );

        let temp = build_compact_fixture();
        to_split_layout_viz(temp.path());
        let path = temp.path().join("visualizations/qa/x.json");
        let mut qa: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        qa["viewports"].as_object_mut().unwrap().remove("compact");
        fs::write(&path, serde_json::to_string(&qa).unwrap()).unwrap();
        let errors = compact_errors(&temp);
        assert!(
            errors
                .iter()
                .any(|e| e.contains("render_qa report is missing viewports.compact.svg_sha256")),
            "{errors:?}"
        );
    }

    // Twins: render_qa_choropleth_with_passing_value_labels_verifies, render_qa_choropleth_missing_value_labels_fails_verification,
    // render_qa_choropleth_failing_value_labels_fails_verification
    #[test]
    fn render_qa_choropleth_with_passing_value_labels_verifies_split_on() {
        let temp = build_choropleth_viz_fixture(true, true);
        to_split_layout_viz(temp.path());
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);

        for (passed, included) in [(true, false), (false, true)] {
            let temp = build_choropleth_viz_fixture(passed, included);
            to_split_layout_viz(temp.path());
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
    }

    // Twins: render_qa_choropleth_report_claiming_passed_over_a_label_missing_svg_fails_verification,
    // render_qa_choropleth_report_with_real_labels_present_verifies, render_qa_choropleth_tampered_svg_fails_value_labels_binding
    #[test]
    fn render_qa_choropleth_report_with_real_labels_present_verifies_split_on() {
        let temp = build_choropleth_svg_fixture(true, false);
        to_split_layout_viz(temp.path());
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(
            report.errors.iter().any(|e| e
                .contains("independent value-labels re-derivation failed")
                && e.contains("value labels")),
            "{:?}",
            report.errors
        );

        let temp = build_choropleth_svg_fixture(true, true);
        to_split_layout_viz(temp.path());
        let mut report = VerificationReport::default();
        verify_visualizations(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);

        let temp = build_choropleth_viz_fixture(true, true);
        to_split_layout_viz(temp.path());
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

    /// heatmap_errors with the layout converted.
    fn heatmap_errors_split_on(
        svg: &str,
        claims_passed: bool,
        switch: Option<&str>,
    ) -> Vec<String> {
        let temp = build_heatmap_svg_fixture(svg, claims_passed);
        to_split_layout_viz(temp.path());
        with_heatmap_switch(switch, || {
            let mut report = VerificationReport::default();
            verify_visualizations(temp.path(), &mut report).unwrap();
            report.errors
        })
    }

    // Twins: heatmap_claim_over_a_label_missing_svg_fails_only_when_the_switch_is_on,
    // heatmap_with_real_labels_or_no_claim_verifies_with_the_switch_on, heatmap_claim_bound_to_a_changed_svg_fails_with_the_switch_on
    #[test]
    fn heatmap_claim_over_a_label_missing_svg_fails_only_when_the_switch_is_on_split_on() {
        let svg = heatmap_cell_svg(None, "12", "30");
        let on = heatmap_errors_split_on(&svg, true, Some("1"));
        assert!(
            on.iter()
                .any(|e| e.contains("independent value-labels re-derivation failed")),
            "{on:?}"
        );
        for off in [None, Some("0"), Some("true"), Some("")] {
            assert_eq!(
                heatmap_errors_split_on(&svg, true, off),
                Vec::<String>::new(),
                "switch {off:?}"
            );
        }

        let good = heatmap_cell_svg(Some("66.6"), "12", "30");
        assert_eq!(
            heatmap_errors_split_on(&good, true, Some("1")),
            Vec::<String>::new()
        );
        let unlabelled = heatmap_cell_svg(None, "12", "30");
        assert_eq!(
            heatmap_errors_split_on(&unlabelled, false, Some("1")),
            Vec::<String>::new()
        );

        let temp = build_heatmap_svg_fixture(&heatmap_cell_svg(Some("66.6"), "12", "30"), true);
        to_split_layout_viz(temp.path());
        fs::write(
            temp.path().join("visualizations/x.svg"),
            heatmap_cell_svg(Some("66.6"), "12", "31"),
        )
        .unwrap();
        let errors = with_heatmap_switch(Some("1"), || {
            let mut report = VerificationReport::default();
            verify_visualizations(temp.path(), &mut report).unwrap();
            report.errors
        });
        assert!(
            errors.iter().any(|e| e.contains("hash does not match")),
            "{errors:?}"
        );
    }

    // Twins: render_qa_pass_allows_infographic_to_verify, desktop_only_infographic_verifies
    #[test]
    fn render_qa_pass_allows_infographic_to_verify_split_on() {
        let temp = build_infographic_fixture(true, true);
        to_split_layout_infographic(temp.path());
        let mut report = VerificationReport::default();
        verify_infographics(temp.path(), &mut report).unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);

        let temp = build_infographic_fixture(true, true);
        drop_mobile_page(temp.path());
        to_split_layout_infographic(temp.path());
        let errors = infographic_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    // Twins: desktop_only_infographic_requires_its_viewport_to_pass, desktop_only_infographic_requires_its_report_hash_to_match
    #[test]
    fn desktop_only_infographic_requires_its_viewport_to_pass_split_on() {
        let temp = build_infographic_fixture(true, true);
        drop_mobile_page(temp.path());
        edit_infographic_fixture(temp.path(), |_manifest, qa| {
            qa["viewports"]["desktop"]["passed"] = Value::Bool(false);
        });
        to_split_layout_infographic(temp.path());
        assert_error(
            &infographic_errors(temp.path()),
            "render QA did not pass for desktop",
        );

        let temp = build_infographic_fixture(true, true);
        drop_mobile_page(temp.path());
        edit_infographic_fixture(temp.path(), |_manifest, qa| {
            qa["viewports"]["desktop"]["svg_sha256"] = Value::String("0".repeat(64));
        });
        to_split_layout_infographic(temp.path());
        assert_error(
            &infographic_errors(temp.path()),
            "desktop SVG hash does not match render_qa report",
        );
    }

    // Twins: desktop_only_infographic_rejects_a_report_with_a_mobile_viewport, listed_mobile_page_still_requires_its_report_viewport
    #[test]
    fn desktop_only_infographic_rejects_a_report_with_a_mobile_viewport_split_on() {
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
        to_split_layout_infographic(temp.path());
        assert_error(
            &infographic_errors(temp.path()),
            "viewports.mobile, which the manifest does not list",
        );

        let temp = build_infographic_fixture(true, true);
        edit_infographic_fixture(temp.path(), |_manifest, qa| {
            qa["viewports"].as_object_mut().unwrap().remove("mobile");
        });
        to_split_layout_infographic(temp.path());
        assert_error(
            &infographic_errors(temp.path()),
            "missing viewports.mobile.svg_sha256",
        );
    }

    // Twins: infographic_vision_review_required_and_passing_verifies (the veto-only and self-report tests share this path)
    #[test]
    fn infographic_vision_review_required_and_passing_verifies_split_on() {
        let temp = build_infographic_fixture(true, true);
        to_split_layout_infographic(temp.path());
        enable_vision_review(temp.path(), 95.0, false);
        let errors = infographic_errors(temp.path());
        assert!(errors.is_empty(), "{errors:?}");
    }

    static FROZEN_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn frozen_meta_fixture(served_from_frozen: bool) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("data")).unwrap();
        let bytes = b"a,b\n1,2\n";
        let sha = sha256_bytes(bytes);
        fs::write(root.join(format!("data/{sha}.csv")), bytes).unwrap();
        let mut meta = serde_json::json!({
            "schema_version": "0.7.0", "bytes": bytes.len(), "sha256": sha, "file": format!("data/{sha}.csv"),
        });
        if served_from_frozen {
            meta["served_from"] = serde_json::json!("frozen_copy");
            meta["frozen_sha256"] = serde_json::json!(sha);
            meta["recorded_run_id"] = serde_json::json!("20260101T000000000Z-recorded");
        }
        fs::write(
            root.join(format!("data/{sha}.csv.meta.json")),
            meta.to_string(),
        )
        .unwrap();
        temp
    }

    #[test]
    fn frozen_copy_data_is_a_warning_with_the_switch_on_and_an_error_otherwise() {
        let _guard = FROZEN_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let is_finding = |line: &String| line.starts_with("data served from a frozen copy: data/");
        let run = |temp: &tempfile::TempDir, switch: Option<&str>| {
            match switch {
                Some(v) => std::env::set_var("NEWSROOM_DOWNLOAD_FROZEN", v),
                None => std::env::remove_var("NEWSROOM_DOWNLOAD_FROZEN"),
            }
            let mut report = VerificationReport::default();
            verify_data(temp.path(), &mut report).unwrap();
            std::env::remove_var("NEWSROOM_DOWNLOAD_FROZEN");
            report
        };
        let frozen = frozen_meta_fixture(true);
        for switch in [None, Some("true"), Some("0"), Some("")] {
            let report = run(&frozen, switch);
            assert_eq!(
                report.errors.iter().filter(|l| is_finding(l)).count(),
                1,
                "{switch:?} {:?}",
                report.errors
            );
            assert!(!report.warnings.iter().any(is_finding), "{switch:?}");
        }
        let on = run(&frozen, Some("1"));
        assert!(on.errors.is_empty(), "{:?}", on.errors);
        assert_eq!(
            on.warnings.iter().filter(|l| is_finding(l)).count(),
            1,
            "{:?}",
            on.warnings
        );
        let live = frozen_meta_fixture(false);
        for switch in [None, Some("1")] {
            let report = run(&live, switch);
            assert!(
                report.errors.is_empty() && report.warnings.is_empty(),
                "{switch:?}"
            );
        }
    }

    #[test]
    fn frozen_publication_mark_is_a_warning_with_the_switch_on_and_an_error_with_it_off() {
        let _guard = FROZEN_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let sha = "ab".repeat(32);
        let make = |mark: bool| {
            let temp = tempfile::tempdir().unwrap();
            let dir = temp.path().join("publications").join("k1");
            fs::create_dir_all(&dir).unwrap();
            let mut manifest = serde_json::json!({"html_ref": "publications/k1/index.html"});
            if mark {
                manifest["replay"] = serde_json::json!("frozen_data");
                manifest["frozen_data_sha256"] = serde_json::json!([sha]);
            }
            fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
            temp
        };
        let run = |temp: &tempfile::TempDir, switch: Option<&str>| {
            match switch {
                Some(v) => std::env::set_var("NEWSROOM_DOWNLOAD_FROZEN", v),
                None => std::env::remove_var("NEWSROOM_DOWNLOAD_FROZEN"),
            }
            let mut report = VerificationReport::default();
            let _ = verify_publications(temp.path(), &mut report);
            std::env::remove_var("NEWSROOM_DOWNLOAD_FROZEN");
            report
        };
        let is_replay = |line: &String| {
            line.starts_with("REPLAY: frozen data, publication is not live evidence: ")
                && line.contains(&sha)
        };
        let marked = make(true);
        let off = run(&marked, None);
        assert!(off.errors.iter().any(is_replay), "{:?}", off.errors);
        assert!(!off.warnings.iter().any(is_replay));
        let on = run(&marked, Some("1"));
        assert!(on.warnings.iter().any(is_replay), "{:?}", on.warnings);
        assert!(!on.errors.iter().any(is_replay));
        let not_exact = run(&marked, Some("true"));
        assert!(not_exact.errors.iter().any(is_replay));
        let unmarked = make(false);
        let plain = run(&unmarked, Some("1"));
        assert!(!plain
            .errors
            .iter()
            .chain(plain.warnings.iter())
            .any(|line| line.starts_with("REPLAY:")));
    }

    // ---- symbol_map read-back (K1016) ----

    const SYMBOL_SVG: &str = concat!(
        "<svg>",
        "<g data-role=\"symbol-map-circles\" data-r-max=\"20\" data-v-max=\"1000\" data-circles=\"3\">",
        "<circle data-role=\"symbol-circle\" data-iso3=\"AAA\" data-value=\"1000\" data-r=\"20\" r=\"20\"/>",
        "<circle data-role=\"symbol-circle\" data-iso3=\"BBB\" data-value=\"250\" data-r=\"10\" r=\"10\"/>",
        "<circle data-role=\"symbol-circle\" data-iso3=\"CCC\" data-value=\"1\" data-r=\"0.632456\" data-min-r=\"1\" data-draw-r=\"2.5\" r=\"2.5\"/>",
        "</g>",
        "<circle data-role=\"symbol-legend-circle\" data-value=\"1000\" data-r=\"20\" r=\"20\"/>",
        "<text data-role=\"symbol-legend-value\">1k</text>",
        "<circle data-role=\"symbol-legend-circle\" data-value=\"250\" data-r=\"10\" r=\"10\"/>",
        "<text data-role=\"symbol-legend-value\">250</text>",
        "</svg>"
    );

    fn symbol_failures(svg: &str) -> Vec<String> {
        verify_symbol_map_from_svg(svg, "", false).0
    }

    fn symbol_edit(find: &str, replace: &str) -> String {
        assert!(SYMBOL_SVG.contains(find), "{find}");
        SYMBOL_SVG.replacen(find, replace, 1)
    }

    #[test]
    fn a_correct_symbol_map_reads_back_clean() {
        let (failures, circles) = verify_symbol_map_from_svg(SYMBOL_SVG, "", false);
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(circles.len(), 3);
    }

    #[test]
    fn a_symbol_map_page_without_symbol_elements_fails() {
        assert!(symbol_failures("<svg><rect/></svg>")
            .iter()
            .any(|f| f.contains("no symbol-map circles")));
    }

    #[test]
    fn symbol_map_defects_are_each_rejected() {
        let cases: [(&str, &str, &str); 13] = [
            (
                "symbol-legend-circle\" data-value=\"250\" data-r=\"10\"",
                "symbol-legend-circle\" data-value=\"250\" data-r=\"12\"",
                "legend ring 250",
            ),
            ("data-value=\"250\" data-r=\"10\" r=\"10\"", "data-value=\"250\" data-r=\"12\" r=\"12\"", "area rule"),
            ("data-value=\"250\" data-r=\"10\" r=\"10\"", "data-value=\"250\" data-r=\"10\" r=\"11\"", "radius other than"),
            ("data-circles=\"3\"", "data-circles=\"4\"", "says 4 circles"),
            ("data-v-max=\"1000\"", "data-v-max=\"2000\"", "not the largest"),
            ("data-iso3=\"BBB\"", "data-iso3=\"AAA\"", "more than one"),
            ("data-draw-r=\"2.5\" r=\"2.5\"", "data-draw-r=\"4\" r=\"4\"", "minimum-size"),
            (">1k<", ">2k<", "does not show"),
            (">1k<", ">1.5k<", "does not show"),
            (">250<", "><", "no readable number"),
            ("data-role=\"symbol-legend-value\">250</text>", "data-role=\"symbol-legend-value\">250</text><text data-role=\"symbol-legend-value\">500</text>", "rings and"),
            ("data-r-max=\"20\" ", "", "no positive data-r-max"),
            (
                "data-value=\"1\" data-r=\"0.632456\" data-min-r=\"1\" data-draw-r=\"2.5\" r=\"2.5\"",
                "data-value=\"1\" data-r=\"0.632456\" r=\"0.632456\"",
                "not marked minimum-size",
            ),
        ];
        for (find, replace, expect) in cases.iter() {
            let failures = symbol_failures(&symbol_edit(find, replace));
            assert!(
                failures.iter().any(|f| f.contains(expect)),
                "{find} -> {replace}: {failures:?}"
            );
        }
    }

    #[test]
    fn a_circle_without_a_legend_is_rejected() {
        let svg = SYMBOL_SVG
            .split("<circle data-role=\"symbol-legend-circle\"")
            .next()
            .unwrap()
            .to_string()
            + "</svg>";
        assert!(symbol_failures(&svg)
            .iter()
            .any(|f| f.contains("no legend ring")));
    }

    #[test]
    fn symbol_legend_text_is_read_exactly() {
        let t = |text: &str, value: f64, unit: &str, zh: bool| {
            symbol_legend_text_matches(text, value, unit, zh)
        };
        assert_eq!(t("1k", 1000.0, "", false), Some(true));
        assert_eq!(t("1000", 1000.0, "", false), Some(true)); // integer kind prints plain
        assert_eq!(t("500", 500.0, "", false), Some(true));
        assert_eq!(t("1.5k", 1000.0, "", false), Some(false));
        assert_eq!(t("2m", 2e6, "", false), Some(true));
        assert_eq!(t("5bn", 5e9, "", false), Some(true));
        assert_eq!(t("$5m", 5e6, "$", false), Some(true));
        assert_eq!(t("$5m", 5e6, "£", false), None);
        assert_eq!(t("50 %", 50.0, "%", false), Some(true));
        assert_eq!(t("50 t", 50.0, "%", false), Some(false));
        assert_eq!(t("abc", 50.0, "", false), None);
        assert_eq!(t("1万", 1e4, "", true), Some(true));
        assert_eq!(t("1.5亿", 1.5e8, "", true), Some(true));
        assert_eq!(t("2万亿", 2e12, "", true), Some(true));
        assert_eq!(t("1万吨", 1e4, "吨", true), Some(true));
        assert_eq!(t("1万", 1e8, "", true), Some(false));
        assert_eq!(t("10亿吨", 1000.0, "百万吨", true), Some(true));
        assert_eq!(t("10亿吨", 100.0, "百万吨", true), Some(false));
        // a Chinese page writes the currency symbol after the number and scale word, as the renderer does (3亿$); the English prefix position fails
        assert_eq!(t("3亿$", 3e8, "$", true), Some(true));
        assert_eq!(t("3亿¥", 3e8, "¥", true), Some(true));
        assert_eq!(t("3亿$", 3e9, "$", true), Some(false));
        assert_ne!(t("$3亿", 3e8, "$", true), Some(true));
        assert_ne!(t("¥3亿", 3e8, "¥", true), Some(true));
        assert_eq!(t("$5m", 5e6, "$", false), Some(true)); // English keeps the prefix
        assert_eq!(t("5m$", 5e6, "$", false), None);
    }

    fn symbol_tree(evidence: Option<Value>, edits: &[(&str, &str)]) -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for dir in [
            "visualizations/plans",
            "visualizations/locations",
            "computations",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        let mut svg = SYMBOL_SVG.to_string();
        for (find, replace) in edits {
            assert!(svg.contains(find));
            svg = svg.replacen(find, replace, 1);
        }
        fs::write(root.join("visualizations/x.svg"), svg).unwrap();
        fs::write(
            root.join("visualizations/plans/x.json"),
            serde_json::json!({"category_field": "c", "value_field": "v", "unit": ""}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("computations/x.json"),
            serde_json::json!({"result_hash": "h1", "rows": [
                {"c": "a", "v": 1000}, {"c": "b", "v": "250"}, {"c": "c", "v": 1}, {"c": "zero", "v": 0}
            ]})
            .to_string(),
        )
        .unwrap();
        let mut manifest = serde_json::json!({
            "plan_ref": "visualizations/plans/x.json",
            "computation_ref": "computations/x.json",
            "data_hash": "h1",
            "chart_type": "symbol_map",
            "row_count": 4,
            "variants": {"desktop": "visualizations/x.svg"},
        });
        if let Some(evidence) = evidence {
            let text = serde_json::to_string_pretty(&evidence).unwrap() + "\n";
            fs::write(root.join("visualizations/locations/x.json"), &text).unwrap();
            manifest["location_evidence_ref"] = "visualizations/locations/x.json".into();
            manifest["location_evidence_sha256"] = sha256_bytes(text.as_bytes()).into();
        }
        fs::write(root.join("visualizations/x.json"), manifest.to_string()).unwrap();
        temp
    }

    fn symbol_evidence() -> Value {
        serde_json::json!({"chart_type": "symbol_map", "rows": [
            {"row_index": 0, "raw": "a", "iso3": "AAA", "feature_indices": [0]},
            {"row_index": 1, "raw": "b", "iso3": "BBB", "feature_indices": [1]},
            {"row_index": 2, "raw": "c", "iso3": "CCC", "feature_indices": [2]},
            {"row_index": 3, "raw": "zero", "iso3": "DDD", "feature_indices": [3]},
        ]})
    }

    fn symbol_report(temp: &tempfile::TempDir) -> VerificationReport {
        let mut report = VerificationReport::default();
        let manifest = read_json(&temp.path().join("visualizations/x.json")).unwrap();
        verify_symbol_map_for_manifest(temp.path(), "x", &manifest, &mut report);
        report
    }

    fn symbol_rows(temp: &tempfile::TempDir, rows: Value) {
        let n = rows.as_array().unwrap().len();
        fs::write(
            temp.path().join("computations/x.json"),
            serde_json::json!({"result_hash": "h1", "rows": rows}).to_string(),
        )
        .unwrap();
        let path = temp.path().join("visualizations/x.json");
        let mut manifest = read_json(&path).unwrap();
        manifest["row_count"] = n.into();
        fs::write(path, manifest.to_string()).unwrap();
    }

    fn has(lines: &[String], needle: &str) -> bool {
        lines.iter().any(|l| l.contains(needle))
    }

    #[test]
    fn without_evidence_the_anchor_is_a_warning_not_a_pass_or_a_failure() {
        let report = symbol_report(&symbol_tree(None, &[]));
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(has(&report.warnings, "anchor not checked"));
        assert!(has(&report.warnings, "layer B) not checked"));
    }

    #[test]
    fn with_good_evidence_circles_are_anchored_to_their_rows() {
        let report = symbol_report(&symbol_tree(Some(symbol_evidence()), &[]));
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(!has(&report.warnings, "anchor not checked"));
        assert!(has(&report.warnings, "layer B) not checked"));
    }

    #[test]
    fn anchor_failures_are_rejected() {
        // a circle value that is not its row's value (consistent radius, so only the anchor can see it)
        let swapped = symbol_tree(
            Some(symbol_evidence()),
            &[(
                "data-iso3=\"BBB\" data-value=\"250\"",
                "data-iso3=\"BBB\" data-value=\"251\"",
            )],
        );
        assert!(has(
            &symbol_report(&swapped).errors,
            "differs from its data row"
        ));
        // a circle for a region the evidence gives to no row
        let mut ev = symbol_evidence();
        ev["rows"][1]["iso3"] = "ZZZ".into();
        let stray = symbol_report(&symbol_tree(Some(ev), &[]));
        assert!(has(&stray.errors, "circle BBB has no data row"));
        assert!(has(&stray.errors, "data row ZZZ has no circle"));
        // row count mismatch
        let mut ev = symbol_evidence();
        ev["rows"].as_array_mut().unwrap().pop();
        assert!(has(
            &symbol_report(&symbol_tree(Some(ev), &[])).errors,
            "location evidence has 3 rows"
        ));
        // evidence edited after the manifest recorded its hash
        let temp = symbol_tree(Some(symbol_evidence()), &[]);
        let path = temp.path().join("visualizations/locations/x.json");
        let text = fs::read_to_string(&path).unwrap().replace("BBB", "EEE");
        fs::write(&path, text).unwrap();
        assert!(has(&symbol_report(&temp).errors, "does not hash"));
        // evidence named but missing
        let temp = symbol_tree(Some(symbol_evidence()), &[]);
        fs::remove_file(temp.path().join("visualizations/locations/x.json")).unwrap();
        assert!(!symbol_report(&temp).errors.is_empty());
        // only one of ref and hash
        let temp = symbol_tree(Some(symbol_evidence()), &[]);
        let path = temp.path().join("visualizations/x.json");
        let mut manifest = read_json(&path).unwrap();
        manifest
            .as_object_mut()
            .unwrap()
            .remove("location_evidence_sha256");
        fs::write(&path, manifest.to_string()).unwrap();
        assert!(has(
            &symbol_report(&temp).errors,
            "only one of ref and sha256"
        ));
    }

    #[test]
    fn a_zero_row_has_no_circle_and_needs_none() {
        // DDD's row is 0: evidence anchors only positive rows, so the absent circle is right
        let report = symbol_report(&symbol_tree(Some(symbol_evidence()), &[]));
        assert!(!has(&report.errors, "DDD"));
    }

    #[test]
    fn computation_rows_not_the_manifests_data_are_rejected() {
        let temp = symbol_tree(None, &[]);
        let path = temp.path().join("visualizations/x.json");
        let mut manifest = read_json(&path).unwrap();
        manifest["data_hash"] = "other".into();
        fs::write(&path, manifest.to_string()).unwrap();
        assert!(!symbol_report(&temp).errors.is_empty());
    }

    #[test]
    fn without_evidence_circle_values_must_still_be_data_row_values() {
        // BBB drawn at 500 with a consistent radius: only the data rows can see it
        let svg_edit = [(
            "data-iso3=\"BBB\" data-value=\"250\" data-r=\"10\" r=\"10\"",
            "data-iso3=\"BBB\" data-value=\"500\" data-r=\"14.142136\" r=\"14.142136\"",
        )];
        let report = symbol_report(&symbol_tree(None, &svg_edit));
        assert!(
            has(&report.errors, "is not (or no longer) a positive value"),
            "{:?}",
            report.errors
        );
        // an empty group against positive data
        let empty = "<svg><g data-role=\"symbol-map-circles\" data-r-max=\"20\" data-v-max=\"1000\" data-circles=\"0\"></g></svg>";
        let temp = symbol_tree(None, &[]);
        fs::write(temp.path().join("visualizations/x.svg"), empty).unwrap();
        assert!(has(&symbol_report(&temp).errors, "no circle is drawn"));
    }

    #[test]
    fn a_missing_or_absent_variant_is_a_failure_not_a_skip() {
        let temp = symbol_tree(None, &[]);
        fs::remove_file(temp.path().join("visualizations/x.svg")).unwrap();
        assert!(has(&symbol_report(&temp).errors, "cannot be read"));
        let temp = symbol_tree(None, &[]);
        let path = temp.path().join("visualizations/x.json");
        let mut manifest = read_json(&path).unwrap();
        manifest.as_object_mut().unwrap().remove("variants");
        fs::write(&path, manifest.to_string()).unwrap();
        assert!(has(&symbol_report(&temp).errors, "no variants"));
    }

    #[test]
    fn evidence_switched_on_but_not_named_is_a_failure() {
        let root = Path::new("/nonexistent");
        let manifest = serde_json::json!({});
        assert!(matches!(
            symbol_map_anchor(root, &manifest, &[], "v", true),
            SymbolAnchor::Failed(_)
        ));
        assert!(matches!(
            symbol_map_anchor(root, &manifest, &[], "v", false),
            SymbolAnchor::Unchecked(_)
        ));
    }

    #[test]
    fn the_anchor_skips_unmatched_rows_and_rejects_unreadable_values() {
        let temp = symbol_tree(Some(symbol_evidence()), &[]);
        let mut ev = symbol_evidence();
        ev["rows"].as_array_mut().unwrap().push(
            serde_json::json!({"row_index": 4, "raw": "chi", "iso3": "CHI", "feature_indices": []}),
        );
        ev["unmatched"] = serde_json::json!([]);
        let temp2 = symbol_tree(Some(ev.clone()), &[]);
        symbol_rows(
            &temp2,
            serde_json::json!([
                {"c": "a", "v": 1000}, {"c": "b", "v": "250"}, {"c": "c", "v": 1}, {"c": "zero", "v": 0}, {"c": "chi", "v": 5}
            ]),
        );
        // evidence file hash was written for the 4-row fixture; rewrite it for the 5 rows
        let text = serde_json::to_string_pretty(&ev).unwrap() + "\n";
        fs::write(temp2.path().join("visualizations/locations/x.json"), &text).unwrap();
        let path = temp2.path().join("visualizations/x.json");
        let mut manifest = read_json(&path).unwrap();
        manifest["location_evidence_sha256"] = sha256_bytes(text.as_bytes()).into();
        fs::write(&path, manifest.to_string()).unwrap();
        let report = symbol_report(&temp2);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        // an unreadable value on a joined row
        symbol_rows(
            &temp,
            serde_json::json!([
                {"c": "a", "v": 1000}, {"c": "b", "v": "250"}, {"c": "c", "v": 1}, {"c": "zero", "v": "n/a"}
            ]),
        );
        assert!(has(
            &symbol_report(&temp).errors,
            "not a finite non-negative"
        ));
        symbol_rows(
            &temp,
            serde_json::json!([
                {"c": "a", "v": 1000}, {"c": "b", "v": "250"}, {"c": "c", "v": 1}, {"c": "zero", "v": -3}
            ]),
        );
        assert!(has(
            &symbol_report(&temp).errors,
            "not a finite non-negative"
        ));
        // an empty or blank string is no data, as for the renderer and the lint: no circle and none required
        for blank in ["", "  "] {
            symbol_rows(
                &temp,
                serde_json::json!([
                    {"c": "a", "v": 1000}, {"c": "b", "v": "250"}, {"c": "c", "v": 1}, {"c": "zero", "v": blank}
                ]),
            );
            let report = symbol_report(&temp);
            assert!(report.errors.is_empty(), "{blank:?}: {:?}", report.errors);
        }
    }

    #[test]
    fn a_region_shared_by_several_rows_is_a_failure_because_the_renderer_never_sums() {
        let mut ev = symbol_evidence();
        ev["rows"][1]["iso3"] = "AAA".into(); // rows 0 and 1 share AAA
        let report = symbol_report(&symbol_tree(Some(ev), &[]));
        assert!(
            has(&report.errors, "several data rows map to one region (AAA)"),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn a_circle_on_the_minimum_boundary_and_a_zh_unit_with_its_own_scale_pass() {
        let svg = symbol_edit(
            "data-value=\"1\" data-r=\"0.632456\" data-min-r=\"1\" data-draw-r=\"2.5\" r=\"2.5\"",
            "data-value=\"15.625\" data-r=\"2.500\" data-min-r=\"1\" data-draw-r=\"2.500\" r=\"2.500\"",
        );
        let failures = symbol_failures(&svg);
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(
            symbol_legend_text_matches("3万亿元", 3.0, "万亿元", true),
            Some(true)
        );
        assert_eq!(
            symbol_legend_text_matches("3亿元", 3.0, "万亿元", true),
            Some(false)
        );
    }

    #[test]
    fn the_minimum_boundary_tolerance_is_only_the_written_rounding() {
        let edit = |r: &str, d: &str| {
            symbol_edit(
                "data-value=\"1\" data-r=\"0.632456\" data-min-r=\"1\" data-draw-r=\"2.5\" r=\"2.5\"",
                &format!("data-value=\"15.625\" data-r=\"{r}\" data-min-r=\"1\" data-draw-r=\"{d}\" r=\"{d}\""),
            )
        };
        // data-r is rounded (toFixed(3)) from a true radius under 2.5: 2.4995 .. 2.500 are what the renderer can write
        for r in ["2.4995", "2.499", "2.500"] {
            let failures = symbol_failures(&edit(r, "2.500"));
            assert!(
                !failures.iter().any(|f| f.contains("minimum-size")),
                "{r}: {failures:?}"
            );
        }
        // just beyond the rounding is not something the renderer writes
        for (r, d) in [
            ("2.501", "2.500"),
            ("2.5006", "2.500"),
            ("2.4995", "2.5006"),
            ("2.4995", "2.4994"),
        ] {
            let failures = symbol_failures(&edit(r, d));
            assert!(
                failures.iter().any(|f| f.contains("minimum-size")),
                "{r}/{d}: {failures:?}"
            );
        }
    }

    #[test]
    fn a_zh_legend_wrong_by_a_wan_or_a_yi_still_fails() {
        let t = |text: &str, value: f64, unit: &str| {
            symbol_legend_text_matches(text, value, unit, true)
        };
        assert_eq!(t("3万元", 3e4, "元"), Some(true));
        assert_eq!(t("3亿元", 3e4, "元"), Some(false)); // wrong by 万
        assert_eq!(t("3万元", 3e8, "元"), Some(false)); // wrong by 万
        assert_eq!(t("3元", 3e4, "元"), Some(false));
        assert_eq!(t("3亿吨", 3e4, "吨"), Some(false));
        assert_eq!(t("3万亿吨", 3e8, "吨"), Some(false)); // true value is 3亿: wrong by 万
        assert_eq!(t("3万亿元", 3.0, "万亿元"), Some(true));
        assert_eq!(t("3万万亿元", 3.0, "万亿元"), Some(false));
        assert_eq!(t("3亿元", 3.0, "万亿元"), Some(false)); // wrong by 万
        assert_eq!(t("3万亿元", 3.0, "亿元"), Some(false)); // wrong by 万
    }
}
