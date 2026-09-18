use crate::hash::{sha256_bytes, sha256_file};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};

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
            let payload = serde_json::json!({
                "content_type": source.get("content_type").cloned().unwrap_or(Value::Null),
                "final_url": source.get("final_url").cloned().unwrap_or(Value::Null),
                "status": source.get("status").cloned().unwrap_or(Value::Null),
                "text": source.get("text").cloned().unwrap_or(Value::Null),
                "truncated": source.get("truncated").cloned().unwrap_or(Value::Null),
            });
            let actual = sha256_bytes(canonical_json(&payload).as_bytes());
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
            let actual = sha256_bytes(canonical_json(rows).as_bytes());
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
        if manifest.get("variants").is_none() || manifest.get("plan_ref").is_none() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("<manifest>");
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
        report.check(
            !plan_ref.is_empty(),
            format!("visualization {name} missing plan_ref"),
        );
        report.check(
            !lint_ref.is_empty(),
            format!("visualization {name} missing lint_ref"),
        );
        report.check(
            verified_claims.contains(claim_id),
            format!("visualization {name} claim_id is not verified: {claim_id}"),
        );
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
            for viewport in ["desktop", "mobile"] {
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

        let critics = find_critics(
            root,
            path.strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/"),
        )?;
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

fn find_critics(root: &Path, manifest_ref: String) -> Result<Vec<Value>> {
    let dir = root.join("visualizations/critics");
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|v| v.to_str()) == Some("json") {
            let value = read_json(&path)?;
            if value.get("manifest_ref").and_then(Value::as_str) == Some(manifest_ref.as_str()) {
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
        if value.get("status").and_then(Value::as_str) == Some("verified") {
            if let Some(id) = value.get("claim_id").and_then(Value::as_str) {
                ids.insert(id.to_owned());
            }
        }
    }
    Ok(ids)
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
        let stored_rows = match value.get("rows").and_then(Value::as_array) {
            Some(_) => value.get("rows").cloned().unwrap_or(Value::Array(vec![])),
            None => {
                report.check(false, format!("recompute missing rows: {}", path.display()));
                continue;
            }
        };

        let allowed_dirs = format!("SET allowed_directories = ['{data_dir}', '{source_dir}']");
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
            canonical_json(&actual_rows) == canonical_json(&stored_rows),
            format!("recompute rows mismatch: {}", path.display()),
        );
        if let Some(expected) = value.get("result_hash").and_then(Value::as_str) {
            let actual = sha256_bytes(canonical_json(&actual_rows).as_bytes());
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
}
