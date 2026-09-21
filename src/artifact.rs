use crate::audit::AuditSummary;
use crate::hash::{sha256_bytes, sha256_file};
use anyhow::{bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};

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
    delivery: Delivery,
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

#[derive(Debug, Serialize)]
struct Delivery {
    /// The file a user should open first. JSON manifests stay evidence
    /// metadata and are never selected as the primary visual deliverable.
    primary_artifact: Option<String>,
    primary_kind: Option<String>,
    primary_mime_type: Option<String>,
    html: Vec<String>,
    images: Vec<String>,
    manifests: Vec<String>,
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
            .or_else(|| {
                dir.file_name()
                    .and_then(|value| value.to_str())
                    .map(str::to_owned)
            })
            .context("story.json has no id")?;
        Self::from_dir(dir.to_path_buf(), id)
    }

    fn from_dir(dir: PathBuf, id: String) -> Result<Self> {
        for child in [
            "session",
            "runtime",
            "searches",
            "sources",
            "data",
            "computations",
            "visualizations",
            "infographics",
        ] {
            fs::create_dir_all(dir.join(child)).with_context(|| {
                format!(
                    "failed to create artifact subdirectory: {}",
                    dir.join(child).display()
                )
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
            bail!(
                "local data file does not exist or is not a regular file: {}",
                source.display()
            );
        }
        let original_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .context("local data filename is not valid UTF-8")?;
        let safe_name: String = original_name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        if safe_name.is_empty() || safe_name.starts_with('.') {
            bail!("local data filename is not safe: {original_name}");
        }
        let extension = Path::new(&safe_name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "csv" | "json" | "jsonl" | "ndjson" | "tsv" | "parquet"
        ) {
            bail!("unsupported local data extension '.{extension}'; use CSV, JSON, JSONL, NDJSON, TSV, or Parquet");
        }
        let sha256 = sha256_file(source)
            .with_context(|| format!("failed to hash local data {}", source.display()))?;
        let stored_name = if extension.is_empty() {
            sha256.clone()
        } else {
            format!("{sha256}.{extension}")
        };
        let relative_file = format!("data/{stored_name}");
        let destination = self.dir.join(&relative_file);
        let bytes = fs::metadata(source)?.len();
        if destination.exists() {
            let existing = sha256_file(&destination).with_context(|| {
                format!("failed to hash existing dataset {}", destination.display())
            })?;
            if existing != sha256 {
                bail!(
                    "content-addressed dataset collision at {}",
                    destination.display()
                );
            }
        } else {
            fs::copy(source, &destination).with_context(|| {
                format!(
                    "failed to copy local data {} to {}",
                    source.display(),
                    destination.display()
                )
            })?;
        }
        let metadata = serde_json::json!({
            "schema_version": "0.7.0",
            "bytes": bytes,
            "sha256": sha256,
            "file": relative_file
        });
        let metadata_path = self
            .dir
            .join("data")
            .join(format!("{stored_name}.meta.json"));
        let metadata_text = format!("{}\n", serde_json::to_string_pretty(&metadata)?);
        if metadata_path.exists() {
            let existing = fs::read_to_string(&metadata_path)
                .with_context(|| format!("failed to read {}", metadata_path.display()))?;
            if existing != metadata_text {
                bail!(
                    "immutable dataset metadata collision at {}",
                    metadata_path.display()
                );
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
                bail!(
                    "immutable dataset origin collision at {}",
                    origin_path.display()
                );
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
        let previous_pi_rpc = read_last_run_metric_rpc(&self.run_metrics_path);
        let claims = read_claims(&self.claims_path).unwrap_or_default();
        let verified_claims = claims
            .iter()
            .filter(|claim| claim.get("status").and_then(Value::as_str) == Some("verified"))
            .count();
        let verified_claims_with_computation = claims
            .iter()
            .filter(|claim| {
                claim.get("status").and_then(Value::as_str) == Some("verified")
                    && claim
                        .get("source_refs")
                        .and_then(Value::as_array)
                        .map(|v| !v.is_empty())
                        .unwrap_or(false)
                    && claim
                        .get("computation_refs")
                        .and_then(Value::as_array)
                        .map(|v| !v.is_empty())
                        .unwrap_or(false)
            })
            .count();
        let pi_rpc = read_rpc_metrics(&self.events_path);
        let pi_rpc_operation = rpc_metric_delta(&pi_rpc, previous_pi_rpc.as_ref());
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
            "pi_rpc": pi_rpc,
            "pi_rpc_operation": pi_rpc_operation,
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
        let delivery = discover_delivery(&self.dir)?;

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
            delivery,
        };

        let json = serde_json::to_string_pretty(&manifest)?;
        fs::write(&self.manifest_path, format!("{json}\n"))
            .with_context(|| format!("failed to write {}", self.manifest_path.display()))
    }

    pub fn primary_artifact(&self) -> Result<Option<(String, String)>> {
        let delivery = discover_delivery(&self.dir)?;
        Ok(delivery.primary_artifact.zip(delivery.primary_kind))
    }

    pub fn visual_delivery_gaps(
        &self,
        require_html: bool,
        require_png_pair: bool,
    ) -> Result<Vec<String>> {
        let delivery = discover_delivery(&self.dir)?;
        let mut gaps = Vec::new();
        if require_html && delivery.html.is_empty() {
            gaps.push("requested self-contained HTML is missing".to_string());
        }
        if require_png_pair {
            let png_count = delivery
                .images
                .iter()
                .filter(|path| path.to_ascii_lowercase().ends_with(".png"))
                .count();
            if png_count < 2 {
                gaps.push(format!(
                    "requested desktop/mobile PNG pair is incomplete ({png_count}/2 found)"
                ));
            }
        }
        Ok(gaps)
    }
}

fn read_rpc_metrics(path: &Path) -> Value {
    let mut calls = 0_u64;
    let mut rpc_ms_total = 0_u64;
    let mut startup_ms_total = 0_u64;
    let mut first_model_text_ms_min: Option<u64> = None;
    let mut first_model_text_ms_max: Option<u64> = None;
    let mut prompt_attempts_total = 0_u64;
    let mut prompt_bytes_total = 0_u64;
    let mut tokens_input_total = 0_u64;
    let mut tokens_output_total = 0_u64;
    let mut tokens_cache_read_total = 0_u64;
    let mut tokens_cache_write_total = 0_u64;
    let mut tool_count_max = 0_u64;
    let mut tool_profiles: Vec<String> = Vec::new();
    let mut successful_calls = 0_u64;
    let mut failed_calls = 0_u64;
    let mut failure_phases: Vec<String> = Vec::new();
    let mut failure_classes: Vec<String> = Vec::new();

    if let Ok(file) = fs::File::open(path) {
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else {
                continue;
            };
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if event.get("type").and_then(Value::as_str) != Some("newsroom_rpc_metrics") {
                continue;
            }
            calls += 1;
            match event.get("outcome").and_then(Value::as_str) {
                Some("failed") => failed_calls += 1,
                _ => successful_calls += 1,
            }
            if let Some(phase) = event.get("failure_phase").and_then(Value::as_str) {
                if !failure_phases.iter().any(|known| known == phase) {
                    failure_phases.push(phase.to_string());
                }
            }
            if let Some(class) = event.get("failure_class").and_then(Value::as_str) {
                if !failure_classes.iter().any(|known| known == class) {
                    failure_classes.push(class.to_string());
                }
            }
            rpc_ms_total += event.get("rpc_ms").and_then(Value::as_u64).unwrap_or(0);
            startup_ms_total += event.get("startup_ms").and_then(Value::as_u64).unwrap_or(0);
            if let Some(value) = event.get("first_model_text_ms").and_then(Value::as_u64) {
                first_model_text_ms_min =
                    Some(first_model_text_ms_min.map_or(value, |current| current.min(value)));
                first_model_text_ms_max =
                    Some(first_model_text_ms_max.map_or(value, |current| current.max(value)));
            }
            prompt_attempts_total += event
                .get("prompt_attempts")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            prompt_bytes_total += event
                .get("prompt_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            tokens_input_total += event
                .get("tokens_input")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            tokens_output_total += event
                .get("tokens_output")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            tokens_cache_read_total += event
                .get("tokens_cache_read")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            tokens_cache_write_total += event
                .get("tokens_cache_write")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            tool_count_max =
                tool_count_max.max(event.get("tool_count").and_then(Value::as_u64).unwrap_or(0));
            if let Some(profile) = event.get("tool_profile").and_then(Value::as_str) {
                if !tool_profiles.iter().any(|known| known == profile) {
                    tool_profiles.push(profile.to_string());
                }
            }
        }
    }

    serde_json::json!({
        "calls": calls,
        "successful_calls": successful_calls,
        "failed_calls": failed_calls,
        "rpc_ms_total": rpc_ms_total,
        "startup_ms_total": startup_ms_total,
        "first_model_text_ms_min": first_model_text_ms_min,
        "first_model_text_ms_max": first_model_text_ms_max,
        "prompt_attempts_total": prompt_attempts_total,
        "prompt_bytes_total": prompt_bytes_total,
        "tool_profiles": tool_profiles,
        "failure_phases": failure_phases,
        "failure_classes": failure_classes,
        "tool_count_max": tool_count_max,
        "tokens_input_total": tokens_input_total,
        "tokens_output_total": tokens_output_total,
        "tokens_cache_read_total": tokens_cache_read_total,
        "tokens_cache_write_total": tokens_cache_write_total,
    })
}

fn read_last_run_metric_rpc(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    BufReader::new(file)
        .lines()
        .filter_map(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(|value| value.get("pi_rpc").cloned())
        .last()
}

fn rpc_metric_delta(current: &Value, previous: Option<&Value>) -> Value {
    let previous = previous.unwrap_or(&Value::Null);
    let delta = |key: &str| {
        current
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_sub(previous.get(key).and_then(Value::as_u64).unwrap_or(0))
    };
    let calls = delta("calls");
    serde_json::json!({
        "calls": calls, "successful_calls": delta("successful_calls"), "failed_calls": delta("failed_calls"),
        "rpc_ms_total": delta("rpc_ms_total"), "startup_ms_total": delta("startup_ms_total"),
        "prompt_attempts_total": delta("prompt_attempts_total"), "prompt_bytes_total": delta("prompt_bytes_total"),
        "tokens_input_total": delta("tokens_input_total"), "tokens_output_total": delta("tokens_output_total"),
        "tokens_cache_read_total": delta("tokens_cache_read_total"), "tokens_cache_write_total": delta("tokens_cache_write_total"),
        "first_model_text_ms_min": if calls > 0 { current.get("first_model_text_ms_min").cloned().unwrap_or(Value::Null) } else { Value::Null },
        "first_model_text_ms_max": if calls > 0 { current.get("first_model_text_ms_max").cloned().unwrap_or(Value::Null) } else { Value::Null },
    })
}

fn read_user_messages(path: &Path) -> Option<usize> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .get("userMessages")?
        .as_u64()
        .map(|value| value as usize)
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

fn discover_delivery(root: &Path) -> Result<Delivery> {
    let mut html = Vec::new();
    let mut images = Vec::new();
    let mut manifests = Vec::new();
    for child in ["publications", "infographics", "visualizations"] {
        for path in relative_files(root, child)? {
            let lower = path.to_ascii_lowercase();
            if lower.ends_with(".html") {
                html.push(path);
            } else if lower.ends_with(".svg") || lower.ends_with(".png") {
                images.push(path);
            } else if lower.ends_with(".json")
                && !lower.contains("/critics/")
                && !lower.contains("/lints/")
                && !lower.contains("/plans/")
            {
                manifests.push(path);
            }
        }
    }
    html.sort();
    images.sort();
    manifests.sort();
    let declared_primary = fs::read_to_string(root.join("story.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|story| {
            story
                .pointer("/delivery/primary_artifact")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|path| {
            let candidate = Path::new(path);
            !candidate.is_absolute()
                && !candidate
                    .components()
                    .any(|component| matches!(component, Component::ParentDir))
                && root.join(candidate).is_file()
        });
    let primary = declared_primary
        .or_else(|| {
            html.iter()
                .find(|path| path.starts_with("publications/") && path.ends_with("/index.html"))
                .cloned()
        })
        .or_else(|| html.first().cloned())
        .or_else(|| {
            images
                .iter()
                .find(|path| {
                    path.starts_with("infographics/")
                        && path.matches('/').count() == 1
                        && !path.ends_with(".mobile.svg")
                })
                .cloned()
        })
        .or_else(|| {
            images
                .iter()
                .find(|path| !path.ends_with(".mobile.svg"))
                .cloned()
        });
    let (primary_artifact, primary_kind, primary_mime_type) = match primary {
        Some(path) if path.to_ascii_lowercase().ends_with(".html") => (
            Some(path.clone()),
            Some("html".to_string()),
            Some("text/html".to_string()),
        ),
        Some(path) if path.to_ascii_lowercase().ends_with(".png") => (
            Some(path.clone()),
            Some("png".to_string()),
            Some("image/png".to_string()),
        ),
        Some(path) => (
            Some(path.clone()),
            Some("svg".to_string()),
            Some("image/svg+xml".to_string()),
        ),
        None => (None, None, None),
    };
    Ok(Delivery {
        primary_artifact,
        primary_kind,
        primary_mime_type,
        html,
        images,
        manifests,
    })
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
    use super::{discover_delivery, read_rpc_metrics, slugify};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn aggregates_structured_rpc_metrics() {
        let root = tempdir().unwrap();
        let events = root.path().join("events.jsonl");
        fs::write(
            &events,
            concat!(
                "{\"type\":\"turn_end\"}\n",
                "{\"type\":\"newsroom_rpc_metrics\",\"startup_ms\":12,\"rpc_ms\":100,\"first_model_text_ms\":40,\"prompt_attempts\":1,\"prompt_bytes\":50,\"tool_profile\":\"investigate\",\"tool_count\":14,\"tokens_input\":120,\"tokens_output\":20,\"tokens_cache_read\":10,\"tokens_cache_write\":2}\n",
                "{\"type\":\"newsroom_rpc_metrics\",\"startup_ms\":8,\"rpc_ms\":80,\"first_model_text_ms\":30,\"prompt_attempts\":2,\"prompt_bytes\":30,\"tool_profile\":\"visual-story\",\"tool_count\":47,\"tokens_input\":80,\"tokens_output\":10,\"tokens_cache_read\":5,\"tokens_cache_write\":1}\n"
            ),
        )
        .unwrap();

        let metrics = read_rpc_metrics(&events);
        assert_eq!(metrics["calls"], 2);
        assert_eq!(metrics["rpc_ms_total"], 180);
        assert_eq!(metrics["startup_ms_total"], 20);
        assert_eq!(metrics["first_model_text_ms_min"], 30);
        assert_eq!(metrics["first_model_text_ms_max"], 40);
        assert_eq!(metrics["prompt_attempts_total"], 3);
        assert_eq!(metrics["prompt_bytes_total"], 80);
        assert_eq!(metrics["tool_count_max"], 47);
        assert_eq!(metrics["tokens_input_total"], 200);
        assert_eq!(metrics["tokens_output_total"], 30);
        assert_eq!(metrics["tokens_cache_read_total"], 15);
        assert_eq!(metrics["tokens_cache_write_total"], 3);
        assert_eq!(
            metrics["tool_profiles"],
            serde_json::json!(["investigate", "visual-story"])
        );
    }

    #[test]
    fn slugifies_ascii_topic() {
        assert_eq!(
            slugify("US Electricity Prices 2026"),
            "us-electricity-prices-2026"
        );
    }

    #[test]
    fn falls_back_for_non_ascii_topic() {
        assert_eq!(slugify("全球电价"), "story");
    }

    #[test]
    fn slugify_handles_special_characters() {
        assert_eq!(slugify("Data: Analysis & Report!"), "data-analysis-report");
        assert_eq!(slugify("test@example.com"), "test-example-com");
        assert_eq!(slugify("foo___bar"), "foo-bar");
    }

    #[test]
    fn slugify_trims_leading_and_trailing_dashes() {
        assert_eq!(slugify("  hello world  "), "hello-world");
        assert_eq!(slugify("---test---"), "test");
    }

    #[test]
    fn slugify_limits_to_64_chars() {
        let long_input = "a".repeat(100);
        let result = slugify(&long_input);
        assert_eq!(result.len(), 64);
    }

    #[test]
    fn slugify_collapses_multiple_separators() {
        assert_eq!(slugify("hello    world"), "hello-world");
        assert_eq!(slugify("test----case"), "test-case");
    }

    #[test]
    fn slugify_handles_mixed_case() {
        assert_eq!(slugify("HelloWorld"), "helloworld");
        assert_eq!(slugify("API Response"), "api-response");
    }

    #[test]
    fn slugify_handles_numbers() {
        assert_eq!(slugify("2024 Report"), "2024-report");
        assert_eq!(slugify("v1.2.3"), "v1-2-3");
    }

    #[test]
    fn slugify_returns_story_for_empty_input() {
        assert_eq!(slugify(""), "story");
        assert_eq!(slugify("   "), "story");
        assert_eq!(slugify("!!!"), "story");
    }

    #[test]
    fn slugify_handles_unicode_fallback() {
        assert_eq!(slugify("测试数据"), "story");
        assert_eq!(slugify("Тест"), "story");
        assert_eq!(slugify("🚀 rocket"), "rocket");
    }

    #[test]
    fn delivery_prefers_declared_primary_over_lexical_first_publication() {
        let dir = tempdir().expect("temp dir");
        let old = dir.path().join("publications/000-old");
        let current = dir.path().join("publications/999-current");
        fs::create_dir_all(&old).expect("old dir");
        fs::create_dir_all(&current).expect("current dir");
        fs::write(old.join("index.html"), "old").expect("old html");
        fs::write(current.join("index.html"), "current").expect("current html");
        fs::write(
            dir.path().join("story.json"),
            r#"{"delivery":{"primary_artifact":"publications/999-current/index.html"}}"#,
        )
        .expect("story");

        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(
            delivery.primary_artifact.as_deref(),
            Some("publications/999-current/index.html")
        );
    }
}
