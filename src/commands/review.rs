use crate::cli::ReviewArgs;
use anyhow::{bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::{Component, Path, PathBuf};

/// The folder and record kind the readers look for (runtime/pi/art_direction.mjs `REVIEW_RECORD_DIR`, `PROGRAM_REVIEW_KIND`; scripts/verify_artifact.py
/// `program_review_ok`). The format is the existing one; this command only gives a person a way to write it.
pub const REVIEW_RECORD_DIR: &str = "editorial/human-reviews/";
pub const PROGRAM_REVIEW_KIND: &str = "program_saved_review";
/// Set on every Pi and Rust-agent child and kept by the tool host (src/pi.rs, src/agent_loop.rs, src/tool_host.rs). A person's shell does not set it.
/// (The plural NEWSROOM_ARTIFACTS_DIR is the user-facing output folder and is not a marker.)
pub const AGENT_CHILD_MARKER: &str = "NEWSROOM_ARTIFACT_DIR";
const PREFERENCES: [&str; 3] = ["baseline", "candidate", "tie"];
/// The five items a blind review rates one by one. A record that carries one is a rating of that item, not a vote on the total preference: the
/// readers skip it when they count votes. A total vote has no `dimension` key at all (never null), so older records and the golden hash stay as they are.
pub const DIMENSIONS: [&str; 5] = [
    "informativeness",
    "chart_choice",
    "gist_at_a_glance",
    "numbers_units_sources",
    "looks_vs_reference",
];

/// Same value as artDirectionHash in art_direction.mjs and editorial_hash in verify_artifact.py: sha256 of the key-sorted compact JSON.
/// serde_json's map is sorted by key here (no preserve_order feature), and the record holds strings only, so the bytes match.
pub fn record_hash(body: &Value) -> String {
    format!("{:x}", Sha256::digest(body.to_string().as_bytes()))
}

/// Why this process may not record a review, or None when it may. Pure so tests can drive it.
pub fn person_only_refusal(
    marker: Option<&str>,
    stdin_tty: bool,
    stderr_tty: bool,
) -> Option<String> {
    if marker.is_some_and(|v| !v.is_empty()) {
        return Some(format!(
            "news review is for a person at a terminal; it refuses inside an agent or tool process ({AGENT_CHILD_MARKER} is set). Nothing was written."
        ));
    }
    if !stdin_tty || !stderr_tty {
        return Some("news review needs an interactive terminal (stdin and stderr must be a terminal). Nothing was written.".to_string());
    }
    None
}

/// `<path>@sha256:<hex of the file>`: the refs the readers compare for equality, so a changed file is a different ref and the record goes stale.
pub fn bound_ref(root: &Path, rel: &str) -> Result<String> {
    let path = Path::new(rel);
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        bail!("{rel}: give a path inside the run folder, without .. or a leading /");
    }
    let full = root.join(path);
    if std::fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink()) {
        bail!("{rel}: a symbolic link cannot be reviewed; give the file itself");
    }
    let bytes =
        std::fs::read(&full).with_context(|| format!("cannot read {rel} in the run folder"))?;
    Ok(format!("{rel}@sha256:{:x}", Sha256::digest(&bytes)))
}

/// The reviewer id is a hash of the name the person typed, never the name (16 to 64 hex characters, as the readers require).
pub fn reviewer_id_hash(name: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("reviewer:{}", name.trim()).as_bytes())
    )[..32]
        .to_string()
}

pub fn build_record(
    baseline_ref: &str,
    candidate_ref: &str,
    reviewer: &str,
    preference: &str,
    comment: Option<&str>,
    dimension: Option<&str>,
) -> Result<Value> {
    if let Some(dimension) = dimension {
        if !DIMENSIONS.contains(&dimension) {
            bail!("dimension must be one of: {}", DIMENSIONS.join(", "));
        }
    }
    if !PREFERENCES.contains(&preference) {
        bail!("preference must be baseline, candidate or tie");
    }
    if reviewer.trim().is_empty() {
        bail!("a reviewer name is required (it is stored only as a hash)");
    }
    let mut body = Map::new();
    body.insert("schema_version".into(), json!("0.1.0"));
    body.insert("kind".into(), json!(PROGRAM_REVIEW_KIND));
    body.insert("saved_by".into(), json!("program"));
    body.insert(
        "saved_at".into(),
        json!(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)),
    );
    body.insert("baseline_ref".into(), json!(baseline_ref));
    body.insert("candidate_ref".into(), json!(candidate_ref));
    body.insert("reviewer_id_hash".into(), json!(reviewer_id_hash(reviewer)));
    body.insert("preference".into(), json!(preference));
    if let Some(dimension) = dimension {
        body.insert("dimension".into(), json!(dimension));
    }
    if let Some(comment) = comment.map(str::trim).filter(|c| !c.is_empty()) {
        body.insert("comment".into(), json!(comment));
    }
    let body = Value::Object(body);
    let hash = record_hash(&body);
    let mut record = body;
    record["content_hash"] = json!(hash);
    Ok(record)
}

/// Write one record with create_new (never overwrites). The write goes through group_guard like every other write into the run folder, so it is
/// the system group's (this command's) and no other group's.
pub fn save_record(root: &Path, record: &Value) -> Result<PathBuf> {
    let hash = record["content_hash"]
        .as_str()
        .context("record has no content_hash")?;
    let id = record["reviewer_id_hash"]
        .as_str()
        .context("record has no reviewer id")?;
    let (Some(id_part), Some(hash_part)) = (id.get(..16), hash.get(..12)) else {
        bail!("record id or hash is too short to name the file");
    };
    let dir = root.join(REVIEW_RECORD_DIR);
    crate::group_guard::create_dir_all(root, &dir)?;
    let path = dir.join(format!("{id_part}-{hash_part}.json"));
    let mut file = crate::group_guard::create_new(root, &path)?;
    file.write_all(format!("{}\n", serde_json::to_string_pretty(record)?).as_bytes())?;
    Ok(path)
}

pub async fn run(args: ReviewArgs) -> Result<()> {
    if let Some(text) = person_only_refusal(
        std::env::var_os(AGENT_CHILD_MARKER)
            .map(|v| v.to_string_lossy().into_owned())
            .as_deref(),
        io::stdin().is_terminal(),
        io::stderr().is_terminal(),
    ) {
        bail!("{text}");
    }
    let root = &args.artifact;
    let baseline_ref = bound_ref(root, &args.baseline)?;
    let candidate_ref = bound_ref(root, &args.candidate)?;
    let record = build_record(
        &baseline_ref,
        &candidate_ref,
        &args.reviewer,
        &args.preference,
        args.comment.as_deref(),
        args.dimension.as_deref(),
    )?;
    let hash = record["content_hash"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let typed_len = 12;
    eprintln!("About to record a human review in {}", root.display());
    eprintln!("  baseline   {baseline_ref}");
    eprintln!("  candidate  {candidate_ref}");
    if let Some(dimension) = &args.dimension {
        eprintln!("  dimension  {dimension} (a rating of this item, not a vote on the total)");
    }
    eprintln!("  preference {}", args.preference);
    eprintln!("  record hash {hash}");
    eprint!("Type the first {typed_len} characters of the record hash to save it (anything else cancels): ");
    io::stderr().flush().ok();
    let mut answer = String::new();
    io::stdin()
        .lock()
        .read_line(&mut answer)
        .context("could not read the confirmation")?;
    if answer.trim() != &hash[..typed_len] {
        bail!("The typed hash did not match. Nothing was written.");
    }
    let path = save_record(root, &record)?;
    println!("saved {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("review-cmd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_marker_a_non_terminal_and_a_missing_terminal_each_refuse() {
        assert!(person_only_refusal(Some("/run"), true, true)
            .unwrap()
            .contains("agent or tool"));
        assert!(person_only_refusal(None, false, true)
            .unwrap()
            .contains("interactive terminal"));
        assert!(person_only_refusal(None, true, false)
            .unwrap()
            .contains("interactive terminal"));
        assert!(person_only_refusal(None, true, true).is_none());
        // an empty marker is not a marker
        assert!(person_only_refusal(Some(""), true, true).is_none());
    }

    #[test]
    fn the_record_has_the_existing_shape_and_its_hash_is_over_the_body() {
        let record = build_record(
            "a.png@sha256:aa",
            "b.png@sha256:bb",
            "Reviewer One",
            "candidate",
            Some(" fine "),
            None,
        )
        .unwrap();
        assert_eq!(record["kind"], "program_saved_review");
        assert_eq!(record["saved_by"], "program");
        assert_eq!(record["comment"], "fine");
        let id = record["reviewer_id_hash"].as_str().unwrap();
        assert!(id.len() >= 16 && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit()));
        let mut body = record.clone();
        let stored = body
            .as_object_mut()
            .unwrap()
            .remove("content_hash")
            .unwrap();
        assert_eq!(stored.as_str().unwrap(), record_hash(&body));
        assert!(build_record("a", "b", "x", "maybe", None, None).is_err());
        assert!(build_record("a", "b", "  ", "tie", None, None).is_err());
        // no dimension: the key is absent, not null
        assert!(!record.as_object().unwrap().contains_key("dimension"));
    }

    #[test]
    fn a_dimension_is_in_the_record_and_in_its_hash_and_only_the_five_are_accepted() {
        for dimension in DIMENSIONS {
            let record = build_record("a@sha256:1", "b@sha256:2", "R", "tie", None, Some(dimension)).unwrap();
            assert_eq!(record["dimension"], dimension);
            let mut body = record.clone();
            let stored = body.as_object_mut().unwrap().remove("content_hash").unwrap();
            assert_eq!(stored.as_str().unwrap(), record_hash(&body), "the dimension is under the hash");
            let mut other = body.clone();
            other["dimension"] = json!("x");
            assert_ne!(stored.as_str().unwrap(), record_hash(&other), "changing it changes the hash");
        }
        for bad in ["", "Chart_choice", "chart choice", "total", "informativeness "] {
            assert!(build_record("a", "b", "R", "tie", None, Some(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_changed_candidate_file_is_a_different_ref() {
        let root = temp_root("ref");
        std::fs::write(root.join("c.png"), b"one").unwrap();
        let first = bound_ref(&root, "c.png").unwrap();
        std::fs::write(root.join("c.png"), b"two").unwrap();
        assert_ne!(first, bound_ref(&root, "c.png").unwrap());
        assert!(bound_ref(&root, "../c.png").is_err());
        assert!(bound_ref(&root, "/etc/hosts").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_is_not_reviewed() {
        let root = temp_root("link");
        std::fs::write(root.join("real.png"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("real.png"), root.join("link.png")).unwrap();
        assert!(bound_ref(&root, "link.png").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn save_refuses_to_overwrite_and_the_file_reads_back() {
        let _command = crate::group_guard::command_for_test("review");
        let root = temp_root("save");
        let record = build_record("a@sha256:1", "b@sha256:2", "R", "tie", None, None).unwrap();
        let path = save_record(&root, &record).unwrap();
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back, record);
        assert!(save_record(&root, &record).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod golden_tests {
    use super::*;

    /// scripts/fixtures/review_record_golden.json is read by scripts/test_review_command_record.mjs and .py. Here the Rust hash must equal the stored
    /// one, so the three languages agree on the bytes (key order, compact separators, non-ASCII and quote escaping).
    #[test]
    fn the_golden_record_hash_matches_the_rust_hash() {
        let mut record: Value = serde_json::from_str(include_str!(
            "../../scripts/fixtures/review_record_golden.json"
        ))
        .unwrap();
        let stored = record
            .as_object_mut()
            .unwrap()
            .remove("content_hash")
            .unwrap();
        assert_eq!(stored.as_str().unwrap(), record_hash(&record));
    }

    /// The same for a record with a dimension (scripts/test_review_dimension_reader.py and .mjs read it too).
    #[test]
    fn the_golden_dimension_record_hash_matches_the_rust_hash() {
        let mut record: Value = serde_json::from_str(include_str!(
            "../../scripts/fixtures/review_record_dimension_golden.json"
        ))
        .unwrap();
        assert!(DIMENSIONS.contains(&record["dimension"].as_str().unwrap()));
        let stored = record
            .as_object_mut()
            .unwrap()
            .remove("content_hash")
            .unwrap();
        assert_eq!(stored.as_str().unwrap(), record_hash(&record));
    }
}
