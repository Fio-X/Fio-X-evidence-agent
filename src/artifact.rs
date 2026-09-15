use crate::audit::AuditSummary;
use crate::hash::{sha256_bytes, sha256_file};
use anyhow::{bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct InvestigationBundle {
    pub id: String,
    pub dir: PathBuf,
    pub prompt_path: PathBuf,
    pub answer_path: PathBuf,
    pub conversation_path: PathBuf,
    pub events_path: PathBuf,
    pub tools_path: PathBuf,
    pub session_stats_path: PathBuf,
    pub run_metrics_path: PathBuf,
    pub plan_path: PathBuf,
    pub claims_path: PathBuf,
    pub manifest_path: PathBuf,
    pub session_dir: PathBuf,
}

#[derive(Debug, Serialize)]
struct Manifest<'a> {
    schema_version: &'static str,
    id: &'a str,
    kind: &'static str,
    created_at: String,
    updated_at: String,
    topic: &'a str,
    status: &'a str,
    runtime: Runtime<'a>,
    files: Files,
    autonomy: Autonomy,
    evidence: Evidence,
}

#[derive(Debug, Serialize)]
struct Runtime<'a> {
    backend: &'static str,
    provider: Option<&'a str>,
    model: Option<&'a str>,
    session_dir: &'static str,
}

#[derive(Debug, Serialize)]
struct Files {
    prompt: &'static str,
    latest_answer: &'static str,
    conversation: &'static str,
    events: &'static str,
    tool_audit: &'static str,
    session_stats: &'static str,
    run_metrics: &'static str,
    plan: &'static str,
    claims: &'static str,
}

#[derive(Debug, Serialize)]
struct Autonomy {
    persistent_session: bool,
    session_resumed: bool,
    multi_turn_context: bool,
    observable_planning: bool,
    agent_loop_observed: bool,
    autonomous_execution_observed: bool,
    adaptive_replanning_observed: bool,
    tool_failure_recovery_observed: bool,
    follow_up_replanning_observed: bool,
    user_messages: usize,
    turns: usize,
    tool_calls: usize,
    capability_tool_calls: usize,
    successful_capability_tool_calls: usize,
    distinct_tools: usize,
    distinct_capability_classes: usize,
    plan_revisions: usize,
    successful_plan_calls: usize,
    follow_up_goals: usize,
    failed_tool_calls: usize,
    automatic_retries: usize,
}

#[derive(Debug, Serialize)]
struct Evidence {
    searches: Vec<String>,
    sources: Vec<String>,
    datasets: Vec<String>,
    computations: Vec<String>,
    claims: Vec<Value>,
    visualizations: Vec<String>,
    infographics: Vec<String>,
}

impl InvestigationBundle {
    pub fn create(root: &Path, topic: &str) -> Result<Self> {
        let timestamp = Utc::now().format("%Y%m%dT%H%M%S%3fZ").to_string();
        let slug = slugify(topic);
        let id = format!("{timestamp}-{slug}");
        let dir = root.join(&id);
        fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create artifact directory: {}", dir.display()))?;
        Self::from_dir(dir, id)
    }

    pub fn open(dir: &Path) -> Result<Self> {
        if !dir.is_dir() {
            bail!("investigation directory does not exist: {}", dir.display());
        }
        let manifest_path = dir.join("story.json");
        if !manifest_path.is_file() {
            bail!("missing story.json in {}", dir.display());
        }
        let manifest: Value = serde_json::from_str(&fs::read_to_string(&manifest_path)?)?;
        let id = manifest
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| dir.file_name().and_then(|value| value.to_str()).map(str::to_owned))
            .context("story.json has no id")?;
        Self::from_dir(dir.to_path_buf(), id)
    }

    fn from_dir(dir: PathBuf, id: String) -> Result<Self> {
        for child in ["session", "runtime", "searches", "sources", "data", "computations", "visualizations", "infographics"] {
            fs::create_dir_all(dir.join(child)).with_context(|| {
                format!("failed to create artifact subdirectory: {}", dir.join(child).display())
            })?;
        }

        Ok(Self {
            id,
            prompt_path: dir.join("prompt.md"),
            answer_path: dir.join("answer.md"),
            conversation_path: dir.join("conversation.md"),
            events_path: dir.join("events.jsonl"),
            tools_path: dir.join("tools.json"),
            session_stats_path: dir.join("session-stats.json"),
            run_metrics_path: dir.join("run-metrics.jsonl"),
            plan_path: dir.join("plan.json"),
            claims_path: dir.join("claims.jsonl"),
            manifest_path: dir.join("story.json"),
            session_dir: dir.join("session"),
            dir,
        })
    }

    pub fn topic(&self) -> Result<String> {
        let manifest: Value = serde_json::from_str(&fs::read_to_string(&self.manifest_path)?)?;
        manifest
            .get("topic")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .context("story.json has no topic")
    }

    pub fn import_data(&self, source: &Path) -> Result<String> {
        if !source.is_file() {
            bail!("local data file does not exist or is not a regular file: {}", source.display());
        }
        let original_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .context("local data filename is not valid UTF-8")?;
        let safe_name: String = original_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
            .collect();
        if safe_name.is_empty() || safe_name.starts_with('.') {
            bail!("local data filename is not safe: {original_name}");
        }
        let extension = Path::new(&safe_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "csv" | "json" | "jsonl" | "ndjson" | "tsv" | "parquet") {
            bail!("unsupported local data extension '.{extension}'; use CSV, JSON, JSONL, NDJSON, TSV, or Parquet");
        }
        let sha256 = sha256_file(source)
            .with_context(|| format!("failed to hash local data {}", source.display()))?;
        let stored_name = if extension.is_empty() { sha256.clone() } else { format!("{sha256}.{extension}") };
        let relative_file = format!("data/{stored_name}");
        let destination = self.dir.join(&relative_file);
        let bytes = fs::metadata(source)?.len();
        if destination.exists() {
            let existing = sha256_file(&destination)
                .with_context(|| format!("failed to hash existing dataset {}", destination.display()))?;
            if existing != sha256 {
                bail!("content-addressed dataset collision at {}", destination.display());
            }
        } else {
            fs::copy(source, &destination).with_context(|| {
                format!("failed to copy local data {} to {}", source.display(), destination.display())
            })?;
        }
        let metadata = serde_json::json!({
            "schema_version": "0.7.0",
            "bytes": bytes,
            "sha256": sha256,
            "file": relative_file
        });
        let metadata_path = self.dir.join("data").join(format!("{stored_name}.meta.json"));
        let metadata_text = format!("{}\n", serde_json::to_string_pretty(&metadata)?);
        if metadata_path.exists() {
            let existing = fs::read_to_string(&metadata_path)
                .with_context(|| format!("failed to read {}", metadata_path.display()))?;
            if existing != metadata_text {
                bail!("immutable dataset metadata collision at {}", metadata_path.display());
            }
        } else {
            fs::write(&metadata_path, &metadata_text)
                .with_context(|| format!("failed to write {}", metadata_path.display()))?;
        }

        let origin = serde_json::json!({
            "schema_version": "0.7.0",
            "origin": "local_file",
            "original_filename": original_name,
            "sha256": sha256,
            "file": relative_file
        });
        let origin_bytes = serde_json::to_vec(&origin)?;
        let origin_hash = sha256_bytes(&origin_bytes);
        let origin_dir = self.dir.join("data").join("origins");
        fs::create_dir_all(&origin_dir)?;
        let origin_path = origin_dir.join(format!("{origin_hash}.json"));
        let origin_text = format!("{}\n", serde_json::to_string_pretty(&origin)?);
        if origin_path.exists() {
            let existing = fs::read_to_string(&origin_path)
                .with_context(|| format!("failed to read {}", origin_path.display()))?;
            if existing != origin_text {
                bail!("immutable dataset origin collision at {}", origin_path.display());
            }
        } else {
            fs::write(&origin_path, origin_text)
                .with_context(|| format!("failed to write {}", origin_path.display()))?;
        }
        Ok(format!("data/{stored_name}"))
    }

    pub fn write_prompt(&self, prompt: &str) -> Result<()> {
        fs::write(&self.prompt_path, prompt)
            .with_context(|| format!("failed to write {}", self.prompt_path.display()))
    }

    pub fn write_answer(&self, answer: &str) -> Result<()> {
        fs::write(&self.answer_path, answer)
            .with_context(|| format!("failed to write {}", self.answer_path.display()))
    }


    pub fn write_session_stats(&self, stats: &Value) -> Result<()> {
        let json = serde_json::to_string_pretty(stats)?;
        fs::write(&self.session_stats_path, format!("{json}\n"))
            .with_context(|| format!("failed to write {}", self.session_stats_path.display()))
    }

    pub fn append_run_metric(
        &self,
        operation: &str,
        provider: Option<&str>,
        model: Option<&str>,
        status: &str,
        duration_ms: u128,
        audit: Option<&AuditSummary>,
    ) -> Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.run_metrics_path)
            .with_context(|| format!("failed to open {}", self.run_metrics_path.display()))?;
        let claims = read_claims(&self.claims_path).unwrap_or_default();
        let verified_claims = claims
            .iter()
            .filter(|claim| claim.get("status").and_then(Value::as_str) == Some("verified"))
            .count();
        let verified_claims_with_computation = claims
            .iter()
            .filter(|claim| {
                claim.get("status").and_then(Value::as_str) == Some("verified")
                    && claim.get("source_refs").and_then(Value::as_array).map(|v| !v.is_empty()).unwrap_or(false)
                    && claim.get("computation_refs").and_then(Value::as_array).map(|v| !v.is_empty()).unwrap_or(false)
            })
            .count();
        let value = serde_json::json!({
            "schema_version": "0.8.0",
            "recorded_at": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            "operation": operation,
            "provider": provider,
            "model": model,
            "status": status,
            "duration_ms": duration_ms,
            "source_snapshots": relative_files(&self.dir, "sources")?.len(),
            "datasets": relative_files(&self.dir, "data")?.len(),
            "computations": relative_files(&self.dir, "computations")?.len(),
            "verified_claims": verified_claims,
            "verified_claims_with_computation": verified_claims_with_computation,
            "tool_calls": audit.map(|a| a.tool_calls),
            "capability_tool_calls": audit.map(|a| a.capability_tool_calls),
            "distinct_capability_classes": audit.map(|a| a.distinct_capability_classes),
            "failed_tool_calls": audit.map(|a| a.failed_tool_calls),
            "autonomous_execution_observed": audit.map(|a| a.autonomous_execution_observed),
            "adaptive_replanning_observed": audit.map(|a| a.adaptive_replanning_observed),
            "tool_failure_recovery_observed": audit.map(|a| a.tool_failure_recovery_observed),
            "follow_up_replanning_observed": audit.map(|a| a.follow_up_replanning_observed),
        });
        writeln!(file, "{}", serde_json::to_string(&value)?)?;
        Ok(())
    }

    pub fn append_conversation(&self, user: &str, assistant: &str) -> Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.conversation_path)
            .with_context(|| format!("failed to open {}", self.conversation_path.display()))?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        writeln!(file, "\n## Turn {now}\n")?;
        writeln!(file, "### User\n\n{user}\n")?;
        writeln!(file, "### Agent\n\n{assistant}\n")?;
        Ok(())
    }

    pub fn write_manifest(
        &self,
        topic: &str,
        provider: Option<&str>,
        model: Option<&str>,
        status: &str,
        audit: Option<&AuditSummary>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let created_at = existing_created_at(&self.manifest_path).unwrap_or_else(|| now.clone());
        let empty_audit = AuditSummary {
            schema_version: "0.7.0",
            generated_at: now.clone(),
            turns: 0,
            tool_calls: 0,
            capability_tool_calls: 0,
            successful_capability_tool_calls: 0,
            failed_tool_calls: 0,
            automatic_retries: 0,
            plan_revisions: 0,
            successful_plan_calls: 0,
            follow_up_goals: 0,
            distinct_capability_classes: 0,
            capability_classes: Default::default(),
            autonomous_execution_observed: false,
            adaptive_replanning_observed: false,
            tool_failure_recovery_observed: false,
            follow_up_replanning_observed: false,
            tools: Default::default(),
            calls: vec![],
        };
        let audit = audit.unwrap_or(&empty_audit);
        let user_messages = read_user_messages(&self.session_stats_path).unwrap_or(0);

        let manifest = Manifest {
            schema_version: "0.7.0",
            id: &self.id,
            kind: "investigation",
            created_at,
            updated_at: now,
            topic,
            status,
            runtime: Runtime {
                backend: "pi-rpc",
                provider,
                model,
                session_dir: "session/",
            },
            files: Files {
                prompt: "prompt.md",
                latest_answer: "answer.md",
                conversation: "conversation.md",
                events: "events.jsonl",
                tool_audit: "tools.json",
                session_stats: "session-stats.json",
                run_metrics: "run-metrics.jsonl",
                plan: "plan.json",
                claims: "claims.jsonl",
            },
            autonomy: Autonomy {
                persistent_session: self.session_dir.is_dir(),
                session_resumed: user_messages > 1 && audit.follow_up_goals > 0,
                multi_turn_context: user_messages > 1 && audit.follow_up_goals > 0,
                observable_planning: self.plan_path.is_file() && audit.successful_plan_calls > 0,
                agent_loop_observed: audit.has_agent_loop_evidence(),
                autonomous_execution_observed: audit.autonomous_execution_observed,
                adaptive_replanning_observed: audit.adaptive_replanning_observed,
                tool_failure_recovery_observed: audit.tool_failure_recovery_observed,
                follow_up_replanning_observed: audit.follow_up_replanning_observed,
                user_messages,
                turns: audit.turns,
                tool_calls: audit.tool_calls,
                capability_tool_calls: audit.capability_tool_calls,
                successful_capability_tool_calls: audit.successful_capability_tool_calls,
                distinct_tools: audit.tools.len(),
                distinct_capability_classes: audit.distinct_capability_classes,
                plan_revisions: audit.plan_revisions,
                successful_plan_calls: audit.successful_plan_calls,
                follow_up_goals: audit.follow_up_goals,
                failed_tool_calls: audit.failed_tool_calls,
                automatic_retries: audit.automatic_retries,
            },
            evidence: Evidence {
                searches: relative_files(&self.dir, "searches")?,
                sources: relative_files(&self.dir, "sources")?,
                datasets: relative_files(&self.dir, "data")?,
                computations: relative_files(&self.dir, "computations")?,
                claims: read_claims(&self.claims_path)?,
                visualizations: relative_files(&self.dir, "visualizations")?,
                infographics: relative_files(&self.dir, "infographics")?,
            },
        };

        let json = serde_json::to_string_pretty(&manifest)?;
        fs::write(&self.manifest_path, format!("{json}\n"))
            .with_context(|| format!("failed to write {}", self.manifest_path.display()))
    }
}


fn read_user_messages(path: &Path) -> Option<usize> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("userMessages")?.as_u64().map(|value| value as usize)
}

fn existing_created_at(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("created_at")?.as_str().map(str::to_owned)
}

fn relative_files(root: &Path, child: &str) -> Result<Vec<String>> {
    fn walk(root: &Path, dir: &Path, values: &mut Vec<String>) -> Result<()> {
        if !dir.is_dir() {
            return Ok(());
        }
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                walk(root, &path, values)?;
            } else if entry.file_type()?.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    values.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        Ok(())
    }

    let mut values = Vec::new();
    walk(root, &root.join(child), &mut values)?;
    values.sort();
    Ok(values)
}

fn read_claims(path: &Path) -> Result<Vec<Value>> {
    if !path.is_file() {
        return Ok(vec![]);
    }
    let file = fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut values = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str(&line) {
            values.push(value);
        }
    }
    Ok(values)
}

pub fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(64));
    let mut last_dash = false;

    for c in input.chars() {
        if out.len() >= 64 {
            break;
        }

        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }

    while out.ends_with('-') {
        out.pop();
    }

    if out.is_empty() {
        "story".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn slugifies_ascii_topic() {
        assert_eq!(slugify("US Electricity Prices 2026"), "us-electricity-prices-2026");
    }

    #[test]
    fn falls_back_for_non_ascii_topic() {
        assert_eq!(slugify("全球电价"), "story");
    }
}
