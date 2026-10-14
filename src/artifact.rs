use crate::audit::AuditSummary;
use crate::group_guard;
use crate::hash::{sha256_bytes, sha256_file};
use anyhow::{bail, Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

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
    /// Name and sha256 of the method recipe appended to the first prompt (`NEWSROOM_SPEED_RECIPES`),
    /// set by the caller; a bundle reopened later reads it back from the manifest instead.
    pub recipe: Option<(String, String)>,
    /// Reasons a `<file>.source.json` beside a local data file was ignored (`NEWSROOM_LOCAL_SOURCE_NOTE`): file name and
    /// reason only, never the note's content. Written to the manifest when not empty.
    pub source_note_warnings: Vec<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    recipe: Option<RecipeRecord>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    source_note_warnings: Vec<String>,
}

/// The recipe the program appended to the first prompt: its name and the sha256 of the text sent.
#[derive(Debug, Serialize)]
struct RecipeRecord {
    name: String,
    sha256: String,
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
    provider_failed_turns: usize,
    provider_auto_retries: usize,
    provider_retry_max_attempt: usize,
    provider_retry_delay_ms_total: u64,
    provider_failure_observed: bool,
    provider_error_classes: std::collections::BTreeMap<String, usize>,
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

/// On the Rust path the session is real only when `agent-session/session.jsonl` exists and holds something; the empty
/// `session/` folder the bundle always creates says nothing about it.
fn rust_session_recorded(dir: &Path) -> bool {
    fs::metadata(dir.join("agent-session").join("session.jsonl"))
        .is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}

impl InvestigationBundle {
    pub fn create(root: &Path, topic: &str) -> Result<Self> {
        let timestamp = Utc::now().format("%Y%m%dT%H%M%S%3fZ").to_string();
        let slug = slugify(topic);
        let id = format!("{timestamp}-{slug}");
        let dir = root.join(&id);
        group_guard::as_run_bundle(|| group_guard::create_dir_all(&dir, &dir))
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
            group_guard::as_run_bundle(|| group_guard::create_dir_all(&dir, &dir.join(child)))
                .with_context(|| {
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
            recipe: None,
            source_note_warnings: Vec::new(),
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

    pub fn import_data(&mut self, source: &Path) -> Result<String> {
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
            group_guard::as_data_import(|| group_guard::copy(&self.dir, source, &destination))
                .with_context(|| {
                    format!(
                        "failed to copy local data {} to {}",
                        source.display(),
                        destination.display()
                    )
                })?;
        }
        // K214 part B (only with NEWSROOM_GROUP_TOOLS=1): the stored file must hash to the address it is stored under before its metadata and origin are written
        if group_guard::enabled() {
            let stored = sha256_file(&destination).with_context(|| {
                format!("failed to hash stored dataset {}", destination.display())
            })?;
            group_guard::check_imported_data(&self.dir, &relative_file, &sha256, &stored)?;
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
            group_guard::as_data_import(|| {
                group_guard::write(&self.dir, &metadata_path, &metadata_text)
            })
            .with_context(|| format!("failed to write {}", metadata_path.display()))?;
        }

        let mut origin = serde_json::json!({
            "schema_version": "0.7.0",
            "origin": "local_file",
            "original_filename": original_name,
            "sha256": sha256,
            "file": relative_file
        });
        if local_source_note_enabled() {
            match read_local_source_note(source, &sha256) {
                Ok(Some(note)) => origin["source_note_file"] = note,
                Ok(None) => {}
                Err(reason) => self
                    .source_note_warnings
                    .push(format!("{original_name}.source.json ignored: {reason}")),
            }
        }
        let origin_bytes = serde_json::to_vec(&origin)?;
        let origin_hash = sha256_bytes(&origin_bytes);
        let origin_dir = self.dir.join("data").join("origins");
        group_guard::as_run_bundle(|| group_guard::create_dir_all(&self.dir, &origin_dir))?;
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
            group_guard::as_data_import(|| {
                group_guard::write(&self.dir, &origin_path, origin_text)
            })
            .with_context(|| format!("failed to write {}", origin_path.display()))?;
        }
        Ok(format!("data/{stored_name}"))
    }

    pub fn write_prompt(&self, prompt: &str) -> Result<()> {
        group_guard::as_run_bundle(|| group_guard::write(&self.dir, &self.prompt_path, prompt))
            .with_context(|| format!("failed to write {}", self.prompt_path.display()))
    }

    pub fn write_answer(&self, answer: &str) -> Result<()> {
        group_guard::as_run_bundle(|| group_guard::write(&self.dir, &self.answer_path, answer))
            .with_context(|| format!("failed to write {}", self.answer_path.display()))
    }

    pub fn write_session_stats(&self, stats: &Value) -> Result<()> {
        let json = serde_json::to_string_pretty(stats)?;
        group_guard::as_run_bundle(|| {
            group_guard::write(&self.dir, &self.session_stats_path, format!("{json}\n"))
        })
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
        let mut file = group_guard::as_run_bundle(|| {
            group_guard::open_append(&self.dir, &self.run_metrics_path)
        })
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
            "automatic_retries": audit.map(|a| a.automatic_retries),
            "provider_failed_turns": audit.map(|a| a.provider_failed_turns),
            "provider_auto_retries": audit.map(|a| a.provider_auto_retries),
            "provider_retry_max_attempt": audit.map(|a| a.provider_retry_max_attempt),
            "provider_retry_delay_ms_total": audit.map(|a| a.provider_retry_delay_ms_total),
            "provider_failure_observed": audit.map(|a| a.provider_failure_observed),
            "provider_error_classes": audit.map(|a| &a.provider_error_classes),
            "pi_rpc": pi_rpc,
        });
        writeln!(file, "{}", serde_json::to_string(&value)?)?;
        Ok(())
    }

    pub fn append_conversation(&self, user: &str, assistant: &str) -> Result<()> {
        let mut file = group_guard::as_run_bundle(|| {
            group_guard::open_append(&self.dir, &self.conversation_path)
        })
        .with_context(|| format!("failed to open {}", self.conversation_path.display()))?;
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        writeln!(file, "\n## Turn {now}\n")?;
        writeln!(file, "### User\n\n{user}\n")?;
        writeln!(file, "### Agent\n\n{assistant}\n")?;
        Ok(())
    }

    /// With NEWSROOM_LOCAL_SOURCE_NOTE=1: the warnings of this import, the ones an earlier turn left in the manifest, and the
    /// page-level ones the runtime wrote beside a rendered page. Switch off: this import's warnings only (always empty), as before.
    fn all_source_note_warnings(&self) -> Vec<String> {
        let mut all = self.source_note_warnings.clone();
        if !local_source_note_enabled() {
            return all;
        }
        let mut earlier = Vec::new();
        if let Ok(text) = fs::read_to_string(&self.manifest_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                earlier.extend(string_array(value.get("source_note_warnings")));
            }
        }
        if let Ok(files) = relative_files(&self.dir, "infographics") {
            for file in files {
                // Only the page manifests directly under infographics/ (key.json), not plans, lints, qa or critics.
                if file.matches('/').count() == 1 && file.ends_with(".json") {
                    if let Ok(text) = fs::read_to_string(self.dir.join(&file)) {
                        if let Ok(value) = serde_json::from_str::<Value>(&text) {
                            earlier.extend(string_array(value.get("source_note_warnings")));
                        }
                    }
                }
            }
        }
        earlier.append(&mut all);
        let mut seen = std::collections::HashSet::new();
        earlier.retain(|warning| seen.insert(warning.clone()));
        earlier
    }

    /// A follow-up import reopens the bundle and never writes the manifest itself. With NEWSROOM_LOCAL_SOURCE_NOTE=1 and at least one
    /// warning from this import, add them to the existing manifest's `source_note_warnings` (the rest of the file is kept as is).
    /// Switch off, or no warnings, or no manifest yet: nothing is read or written.
    pub fn persist_source_note_warnings(&self) -> Result<()> {
        if !local_source_note_enabled() || self.source_note_warnings.is_empty() {
            return Ok(());
        }
        let Ok(text) = fs::read_to_string(&self.manifest_path) else {
            return Ok(());
        };
        let mut value: Value = serde_json::from_str(&text)
            .with_context(|| format!("failed to parse {}", self.manifest_path.display()))?;
        let mut warnings = string_array(value.get("source_note_warnings"));
        for warning in &self.source_note_warnings {
            if !warnings.contains(warning) {
                warnings.push(warning.clone());
            }
        }
        value["source_note_warnings"] = serde_json::json!(warnings);
        let json = serde_json::to_string_pretty(&value)?;
        group_guard::write(&self.dir, &self.manifest_path, format!("{json}\n"))
            .with_context(|| format!("failed to write {}", self.manifest_path.display()))
    }

    pub fn write_manifest(
        &self,
        topic: &str,
        provider: Option<&str>,
        model: Option<&str>,
        status: &str,
        audit: Option<&AuditSummary>,
        rust_agent: bool,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let created_at = existing_created_at(&self.manifest_path).unwrap_or_else(|| now.clone());
        let empty_audit = AuditSummary {
            schema_version: "0.8.0",
            generated_at: now.clone(),
            turns: 0,
            tool_calls: 0,
            outer_tool_calls: 0,
            inner_tool_calls: 0,
            capability_tool_calls: 0,
            successful_capability_tool_calls: 0,
            failed_tool_calls: 0,
            automatic_retries: 0,
            provider_failed_turns: 0,
            provider_auto_retries: 0,
            provider_retry_max_attempt: 0,
            provider_retry_delay_ms_total: 0,
            provider_failure_observed: false,
            provider_error_classes: Default::default(),
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

        let rust = rust_agent;
        let manifest = Manifest {
            schema_version: "0.9.0",
            id: &self.id,
            kind: "investigation",
            created_at,
            updated_at: now,
            topic,
            status,
            runtime: Runtime {
                backend: if rust { "rust-agent" } else { "pi-rpc" },
                provider,
                model,
                session_dir: if rust { "agent-session/" } else { "session/" },
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
                persistent_session: if rust {
                    rust_session_recorded(&self.dir)
                } else {
                    self.session_dir.is_dir()
                },
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
                provider_failed_turns: audit.provider_failed_turns,
                provider_auto_retries: audit.provider_auto_retries,
                provider_retry_max_attempt: audit.provider_retry_max_attempt,
                provider_retry_delay_ms_total: audit.provider_retry_delay_ms_total,
                provider_failure_observed: audit.provider_failure_observed,
                provider_error_classes: audit.provider_error_classes.clone(),
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
            source_note_warnings: self.all_source_note_warnings(),
            recipe: self
                .recipe
                .clone()
                .or_else(|| existing_recipe(&self.manifest_path))
                .map(|(name, sha256)| RecipeRecord { name, sha256 }),
        };

        let json = serde_json::to_string_pretty(&manifest)?;
        group_guard::write(&self.dir, &self.manifest_path, format!("{json}\n"))
            .with_context(|| format!("failed to write {}", self.manifest_path.display()))
    }

    pub fn primary_artifact(&self) -> Result<Option<(String, String)>> {
        let delivery = discover_delivery(&self.dir)?;
        Ok(delivery.primary_artifact.zip(delivery.primary_kind))
    }

    /// The first publication page a top-level publication manifest hands a reader that was written at or after
    /// `since` (the round's start): the same candidates and test `discover_delivery` uses to prefer a page when
    /// story.json declares nothing. A page an earlier round left does not count. Unlike `primary_artifact` it is not
    /// overridden by a declared chart.
    pub fn publication_page(&self, since: SystemTime) -> Result<Option<(String, String)>> {
        let mut candidates = publication_candidates(&self.dir, Some(since))?;
        candidates.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(candidates
            .into_iter()
            .find(is_publication_html)
            .map(|candidate| (candidate.path, "html".to_string())))
    }

    /// The newest chart a follow-up round made that passed its checks, read from the program's own
    /// records only: a `visualizations/<key>.json` manifest written at or after `since` whose
    /// `render_qa.passed` is true and `artifact_status` is `VERIFIED`, with a passing critic record
    /// under `visualizations/critics/` bound to that manifest. Nothing here reads the model's text.
    /// `None` when the round made no such chart.
    pub fn latest_passing_chart_since(
        &self,
        since: SystemTime,
    ) -> Result<Option<(String, String)>> {
        latest_passing_chart(&self.dir, since)
    }

    /// `required_pngs` is how many PNG renders a PNG/screenshot request
    /// needs: 0 when none was requested, 1 for the desktop page alone, 2 for
    /// the desktop/mobile pair when mobile pages are enabled.
    pub fn visual_delivery_gaps(
        &self,
        require_html: bool,
        required_pngs: usize,
    ) -> Result<Vec<String>> {
        // Both checks below are manifest-backed, unlike story.json's own
        // `delivery.html`/`.images` inventory (still an unrestricted
        // recursive listing - see discover_delivery): require_html is only
        // satisfied by a top-level publication's html_ref, and a PNG only
        // counts when a PASSing publications/qa/ report binds it to one.
        let candidates = delivery_candidates(&self.dir)?;
        let mut gaps = Vec::new();
        if require_html && !candidates.iter().any(is_publication_html) {
            gaps.push("requested self-contained HTML is missing".to_string());
        }
        if required_pngs > 0 {
            let png_count = qualifying_publication_screenshots(&self.dir, &candidates)?.len();
            if png_count < required_pngs {
                gaps.push(if required_pngs == 1 {
                    format!("requested desktop PNG is missing ({png_count}/1 found)")
                } else {
                    format!(
                        "requested desktop/mobile PNG pair is incomplete ({png_count}/{required_pngs} found)"
                    )
                });
            }
        }
        Ok(gaps)
    }

    /// `Some(reason)` unless a measured publication exists: a top-level
    /// publication that is not a Lieflat page (Lieflat pages carry no
    /// measured lint, critic or browser QA) and whose HTML is bound, by
    /// `html_sha256`, to a PASSing `publications/qa/*/browser-qa.json`.
    /// `newsroom_publication_qa` returns a non-error result both when QA
    /// could not run and for a FAIL verdict, so a successful tool call is
    /// not evidence; only this artifact-level binding is.
    pub fn measured_publication_gap(&self) -> Result<Option<String>> {
        let root = &self.dir;
        let passing = passing_browser_qa_html_hashes(root)?;
        let publications_dir = root.join("publications");
        let mut lieflat_only = false;
        if publications_dir.is_dir() {
            for entry in fs::read_dir(&publications_dir)? {
                let entry = entry?;
                if !entry.file_type()?.is_dir()
                    || matches!(
                        entry.file_name().to_str(),
                        Some("plans" | "qa" | "rejected")
                    )
                {
                    continue;
                }
                let Some(manifest) = read_manifest_json(&entry.path().join("manifest.json")) else {
                    continue;
                };
                let Some(html_ref) = manifest.get("html_ref").and_then(Value::as_str) else {
                    continue;
                };
                let Some(html) = accept_ref(root, html_ref) else {
                    continue;
                };
                let is_lieflat = manifest
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.starts_with("lieflat"));
                if is_lieflat {
                    lieflat_only = true;
                    continue;
                }
                if sha256_file(&root.join(&html)).is_ok_and(|hash| passing.contains(&hash)) {
                    return Ok(None);
                }
            }
        }
        Ok(Some(if lieflat_only {
            "only a Lieflat page exists: it carries no measured lint, critic or browser QA, so the measured publication with a PASSing browser-qa.json report is still missing".to_string()
        } else {
            "no publication with a PASSing browser-qa.json report bound to its HTML exists"
                .to_string()
        }))
    }

    /// The tool profile the most recent Pi invocation of this investigation
    /// actually ran with: the last `newsroom_rpc_metrics` event in
    /// `events.jsonl` whose `tool_profile` is a known profile, falling back
    /// to the last `run-metrics.jsonl` row that lists exactly one. `None`
    /// when nothing usable was recorded.
    pub fn recorded_tool_profile(&self) -> Option<String> {
        let known = |profile: &str| crate::tool_registry::tools_for_profile(profile).is_some();
        let mut latest: Option<String> = None;
        if let Ok(file) = fs::File::open(&self.events_path) {
            for line in BufReader::new(file).lines().map_while(|line| line.ok()) {
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if event.get("type").and_then(Value::as_str) != Some("newsroom_rpc_metrics") {
                    continue;
                }
                if let Some(profile) = event
                    .get("tool_profile")
                    .and_then(Value::as_str)
                    .filter(|profile| known(profile))
                {
                    latest = Some(profile.to_string());
                }
            }
        }
        if latest.is_some() {
            return latest;
        }
        let file = fs::File::open(&self.run_metrics_path).ok()?;
        for line in BufReader::new(file).lines().map_while(|line| line.ok()) {
            let Ok(row) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(profiles) = row
                .pointer("/pi_rpc/tool_profiles")
                .and_then(Value::as_array)
            else {
                continue;
            };
            if let [only] = profiles.as_slice() {
                if let Some(profile) = only.as_str().filter(|profile| known(profile)) {
                    latest = Some(profile.to_string());
                }
            }
        }
        latest
    }
}

/// `html_sha256` of every PASSing `publications/qa/*/browser-qa.json`.
fn passing_browser_qa_html_hashes(root: &Path) -> Result<std::collections::BTreeSet<String>> {
    let mut hashes = std::collections::BTreeSet::new();
    let qa_dir = root.join("publications/qa");
    if !qa_dir.is_dir() {
        return Ok(hashes);
    }
    for entry in fs::read_dir(&qa_dir)? {
        let report_dir = entry?.path();
        let Some(report) = read_manifest_json(&report_dir.join("browser-qa.json")) else {
            continue;
        };
        if report.get("status").and_then(Value::as_str) != Some("PASS") {
            continue;
        }
        if let Some(hash) = report.get("html_sha256").and_then(Value::as_str) {
            hashes.insert(hash.to_string());
        }
    }
    Ok(hashes)
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
        "rpc_ms_total": rpc_ms_total,
        "startup_ms_total": startup_ms_total,
        "first_model_text_ms_min": first_model_text_ms_min,
        "first_model_text_ms_max": first_model_text_ms_max,
        "prompt_attempts_total": prompt_attempts_total,
        "prompt_bytes_total": prompt_bytes_total,
        "tool_profiles": tool_profiles,
        "tool_count_max": tool_count_max,
        "tokens_input_total": tokens_input_total,
        "tokens_output_total": tokens_output_total,
        "tokens_cache_read_total": tokens_cache_read_total,
        "tokens_cache_write_total": tokens_cache_write_total,
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

/// `NEWSROOM_LOCAL_SOURCE_NOTE=1` (default off): a user data file `X.csv` may carry `X.csv.source.json` beside it.
fn local_source_note_enabled() -> bool {
    std::env::var("NEWSROOM_LOCAL_SOURCE_NOTE").as_deref() == Ok("1")
}

const SOURCE_NOTE_FIELD_MAX: usize = 120;
const SOURCE_NOTE_FILE_MAX_BYTES: u64 = 16 * 1024;

/// Characters a note field may not carry: C0/C1 controls, zero-width and bidirectional controls, and the byte-order mark.
/// The same set is refused in `acceptedLocalSourceNote` (runtime/pi/newsroom.ts).
fn is_refused_note_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// The note beside `source`, or None when there is no such file. Err carries only the reason it is refused.
/// Accepted only when it parses, publisher/dataset/license/sha256 are present, non-empty strings of at most 120 chars,
/// url (if present) is https, retrieved (if present) is YYYY-MM-DD, and sha256 equals the data file's sha256.
fn read_local_source_note(
    source: &Path,
    data_sha256: &str,
) -> std::result::Result<Option<Value>, &'static str> {
    let mut note_path = source.as_os_str().to_owned();
    note_path.push(".source.json");
    let note_path = PathBuf::from(note_path);
    let meta = match fs::symlink_metadata(&note_path) {
        Ok(meta) => meta,
        Err(_) => return Ok(None),
    };
    if meta.file_type().is_symlink() {
        return Err("the note is a link");
    }
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > SOURCE_NOTE_FILE_MAX_BYTES {
        return Err("the note is too large");
    }
    let bytes = fs::read(&note_path).map_err(|_| "the note file cannot be read")?;
    if bytes.len() as u64 > SOURCE_NOTE_FILE_MAX_BYTES {
        return Err("the note is too large");
    }
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| "the note is not valid JSON")?;
    let object = parsed.as_object().ok_or("the note is not a JSON object")?;
    let field = |name: &str| object.get(name).and_then(Value::as_str).map(str::trim);
    let mut accepted = serde_json::Map::new();
    for required in ["publisher", "dataset", "license"] {
        let value = field(required)
            .filter(|v| !v.is_empty())
            .ok_or(match required {
                "publisher" => "publisher is missing or empty",
                "dataset" => "dataset is missing or empty",
                _ => "license is missing or empty",
            })?;
        if value.chars().count() > SOURCE_NOTE_FIELD_MAX || value.chars().any(is_refused_note_char)
        {
            return Err("a field is longer than 120 characters or has control characters");
        }
        accepted.insert(required.to_owned(), Value::String(value.to_owned()));
    }
    if let Some(url) = object.get("url") {
        let url = url.as_str().ok_or("url is not a string")?.trim();
        if !url.starts_with("https://")
            || url.len() <= "https://".len()
            || url.chars().count() > SOURCE_NOTE_FIELD_MAX * 2
            || url
                .chars()
                .any(|c| is_refused_note_char(c) || c.is_whitespace())
        {
            return Err("url is not an https address");
        }
        accepted.insert("url".to_owned(), Value::String(url.to_owned()));
    }
    if let Some(retrieved) = object.get("retrieved") {
        let retrieved = retrieved
            .as_str()
            .ok_or("retrieved is not a string")?
            .trim();
        if chrono::NaiveDate::parse_from_str(retrieved, "%Y-%m-%d").is_err()
            || retrieved.len() != 10
        {
            return Err("retrieved is not a YYYY-MM-DD date");
        }
        accepted.insert("retrieved".to_owned(), Value::String(retrieved.to_owned()));
    }
    let claimed = field("sha256")
        .filter(|v| !v.is_empty())
        .ok_or("sha256 is missing or empty")?;
    if !claimed.eq_ignore_ascii_case(data_sha256) {
        return Err("sha256 does not match the data file");
    }
    accepted.insert("sha256".to_owned(), Value::String(data_sha256.to_owned()));
    accepted.insert(
        "note_sha256".to_owned(),
        Value::String(sha256_bytes(&bytes)),
    );
    Ok(Some(Value::Object(accepted)))
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn existing_recipe(path: &Path) -> Option<(String, String)> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let recipe = value.get("recipe")?;
    Some((
        recipe.get("name")?.as_str()?.to_owned(),
        recipe.get("sha256")?.as_str()?.to_owned(),
    ))
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
    // The delivered primary must be the output of a top-level manifest the
    // verifiers check (publications/<k>/manifest.json, infographics/*.json,
    // visualizations/*.json) - never a render-QA rejection, an orphaned file
    // a critic's rejection left behind, a publication moved to
    // publications/rejected/, or a QA screenshot. `html`/`images`/`manifests`
    // above stay an unrestricted recursive listing; only primary selection
    // is narrowed to `candidates`.
    let candidates = delivery_candidates(root)?;
    let declared_primary = fs::read_to_string(root.join("story.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|story| {
            story
                .pointer("/delivery/primary_artifact")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|declared| {
            candidates
                .iter()
                .any(|candidate| &candidate.path == declared)
        });
    let primary = declared_primary
        .or_else(|| {
            candidates
                .iter()
                .find(|candidate| is_publication_html(candidate))
                .map(|candidate| candidate.path.clone())
        })
        .or_else(|| {
            candidates
                .iter()
                .find(|candidate| candidate.path.to_ascii_lowercase().ends_with(".html"))
                .map(|candidate| candidate.path.clone())
        })
        .or_else(|| {
            candidates
                .iter()
                .find(|candidate| candidate.origin == ManifestOrigin::Infographic)
                .map(|candidate| candidate.path.clone())
        })
        .or_else(|| candidates.first().map(|candidate| candidate.path.clone()));
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ManifestOrigin {
    Publication,
    Infographic,
    Visualization,
}

/// A rendered-output path a top-level manifest declares as its own: a
/// publication's `html_ref`, or an infographic/visualization's
/// `variants.desktop` (falling back to its top-level `svg` field).
struct DeliveryCandidate {
    path: String,
    origin: ManifestOrigin,
}

/// True only for a publication's own HTML entry point - the sole thing an
/// HTML request (`discover_delivery`'s primary selection and
/// `visual_delivery_gaps`'s `require_html`) may treat as "the requested
/// HTML". An infographic/visualization candidate is never HTML in
/// practice, but this checks the extension too rather than trusting origin
/// alone.
fn is_publication_html(candidate: &DeliveryCandidate) -> bool {
    candidate.origin == ManifestOrigin::Publication
        && candidate.path.to_ascii_lowercase().ends_with(".html")
}

/// The publication entries of `delivery_candidates`. With `since`, only a manifest written at or after that
/// time counts (the page this round made, not one an earlier round left).
fn publication_candidates(
    root: &Path,
    since: Option<SystemTime>,
) -> Result<Vec<DeliveryCandidate>> {
    let mut candidates = Vec::new();
    let publications_dir = root.join("publications");
    if publications_dir.is_dir() {
        for entry in fs::read_dir(&publications_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if matches!(
                entry.file_name().to_str(),
                Some("plans" | "qa" | "rejected")
            ) {
                continue;
            }
            let manifest_path = entry.path().join("manifest.json");
            if let Some(since) = since {
                match fs::metadata(&manifest_path).and_then(|meta| meta.modified()) {
                    Ok(modified) if modified >= since => {}
                    _ => continue,
                }
            }
            let Some(manifest) = read_manifest_json(&manifest_path) else {
                continue;
            };
            let Some(html_ref) = manifest.get("html_ref").and_then(Value::as_str) else {
                continue;
            };
            if let Some(path) = accept_ref(root, html_ref) {
                candidates.push(DeliveryCandidate {
                    path,
                    origin: ManifestOrigin::Publication,
                });
            }
        }
    }
    Ok(candidates)
}

/// Every path a top-level manifest can hand a reader as its delivered
/// output - the same manifests `verify.rs` and `verify_artifact.py` check:
/// `publications/<k>/manifest.json` for a direct child `k` of
/// `publications/` other than `plans`, `qa` or `rejected`, plus direct-child
/// `infographics/*.json` and `visualizations/*.json`. A rejected render
/// (kept only under `<dir>/rejected/<key>/`), an orphaned SVG whose manifest
/// a critic rejected, a publication moved to `publications/rejected/<k>/`,
/// and a QA screenshot under `publications/qa/<k>/` all fall outside this
/// set, so none of them can ever be picked as the primary. A manifest that
/// fails to parse, or that has no usable ref, contributes nothing.
fn delivery_candidates(root: &Path) -> Result<Vec<DeliveryCandidate>> {
    let mut candidates = Vec::new();

    candidates.extend(publication_candidates(root, None)?);

    for (child, origin) in [
        ("infographics", ManifestOrigin::Infographic),
        ("visualizations", ManifestOrigin::Visualization),
    ] {
        let dir = root.join(child);
        if !dir.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&dir)? {
            let path = entry?.path();
            if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let Some(manifest) = read_manifest_json(&path) else {
                continue;
            };
            let reference = manifest
                .pointer("/variants/desktop")
                .and_then(Value::as_str)
                .or_else(|| manifest.get("svg").and_then(Value::as_str));
            let Some(reference) = reference else {
                continue;
            };
            if let Some(path) = accept_ref(root, reference) {
                candidates.push(DeliveryCandidate { path, origin });
            }
        }
    }

    candidates.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(candidates)
}

fn latest_passing_chart(root: &Path, since: SystemTime) -> Result<Option<(String, String)>> {
    let dir = root.join("visualizations");
    if !dir.is_dir() {
        return Ok(None);
    }
    let mut passing_critics = std::collections::BTreeSet::new();
    let critics = dir.join("critics");
    if critics.is_dir() {
        for entry in fs::read_dir(&critics)? {
            let path = entry?.path();
            let Some(record) = read_manifest_json(&path) else {
                continue;
            };
            if record.get("passed").and_then(Value::as_bool) == Some(true) {
                if let Some(manifest_ref) = record.get("manifest_ref").and_then(Value::as_str) {
                    passing_critics.insert(manifest_ref.to_string());
                }
            }
        }
    }
    let mut newest: Option<(SystemTime, String)> = None;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        if modified < since {
            continue;
        }
        let Some(manifest) = read_manifest_json(&path) else {
            continue;
        };
        let manifest_ref = format!("visualizations/{}", entry.file_name().to_string_lossy());
        let passed = manifest
            .pointer("/render_qa/passed")
            .and_then(Value::as_bool)
            == Some(true)
            && manifest.get("artifact_status").and_then(Value::as_str) == Some("VERIFIED")
            && passing_critics.contains(&manifest_ref);
        if !passed {
            continue;
        }
        let reference = manifest
            .pointer("/variants/desktop")
            .and_then(Value::as_str)
            .or_else(|| manifest.get("svg").and_then(Value::as_str));
        let Some(path) = reference.and_then(|reference| accept_ref(root, reference)) else {
            continue;
        };
        if newest
            .as_ref()
            .is_none_or(|(time, key)| (modified, &path) > (*time, key))
        {
            newest = Some((modified, path));
        }
    }
    Ok(newest.map(|(_, path)| {
        let kind = if path.to_ascii_lowercase().ends_with(".png") {
            "png"
        } else {
            "svg"
        };
        (path, kind.to_string())
    }))
}

fn read_manifest_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    let manifest: Value = serde_json::from_str(&text).ok()?;
    Some(manifest)
}

/// True if `reference` is a relative path with no `..` component and no
/// path segment literally named `rejected` or `qa`. A top-level manifest is
/// itself never stored in either subtree, but its own declared ref must not
/// be allowed to reach into one either - those trees hold evidence of a
/// failure, not something to deliver.
fn is_safe_relative_ref(reference: &str) -> bool {
    let candidate = Path::new(reference);
    if candidate.is_absolute() {
        return false;
    }
    !candidate.components().any(|component| match component {
        Component::ParentDir => true,
        Component::Normal(part) => matches!(part.to_str(), Some("rejected" | "qa")),
        _ => false,
    })
}

/// Accepts `reference` only if it is a relative path with no `..` component
/// and no `rejected`/`qa` path segment, that names a file under `root`,
/// returning it unchanged - every ref the runtime writes is already
/// root-relative, so this also serves as the membership test for a
/// declared `story.json` primary.
fn accept_ref(root: &Path, reference: &str) -> Option<String> {
    if !is_safe_relative_ref(reference) {
        return None;
    }
    if root.join(reference).is_file() {
        Some(reference.to_string())
    } else {
        None
    }
}

/// Every distinct screenshot PNG that a PASSing
/// `publications/qa/<qakey>/browser-qa.json` report binds to one of
/// `candidates`' publication HTML files - see `runtime/pi/browser_qa.py`
/// for the report shape (`status`, `html_sha256`, `screenshots: [{width,
/// path, sha256}]`, `archive_fallback: {path, sha256, source_width} |
/// null`). These are the only files `visual_delivery_gaps` may count
/// toward `required_pngs`: a FAIL report, a report whose `html_sha256`
/// does not match a publication candidate (another HTML, or one that was
/// since rejected), and anything outside `publications/qa/` (an
/// infographic/visualization preview PNG, a rejected render, ...) all
/// contribute nothing, no matter how many PNG files sit on disk.
fn qualifying_publication_screenshots(
    root: &Path,
    candidates: &[DeliveryCandidate],
) -> Result<std::collections::BTreeSet<String>> {
    let mut files = std::collections::BTreeSet::new();

    let mut publication_html_hashes = std::collections::BTreeSet::new();
    for candidate in candidates {
        if !is_publication_html(candidate) {
            continue;
        }
        if let Ok(hash) = sha256_file(&root.join(&candidate.path)) {
            publication_html_hashes.insert(hash);
        }
    }
    if publication_html_hashes.is_empty() {
        return Ok(files);
    }

    let qa_dir = root.join("publications/qa");
    if !qa_dir.is_dir() {
        return Ok(files);
    }
    for entry in fs::read_dir(&qa_dir)? {
        let report_dir = entry?.path();
        if !report_dir.is_dir() {
            continue;
        }
        let Some(report) = read_manifest_json(&report_dir.join("browser-qa.json")) else {
            continue;
        };
        if report.get("status").and_then(Value::as_str) != Some("PASS") {
            continue;
        }
        let bound_to_a_candidate = report
            .get("html_sha256")
            .and_then(Value::as_str)
            .is_some_and(|hash| publication_html_hashes.contains(hash));
        if !bound_to_a_candidate {
            continue;
        }

        let mut refs: Vec<&str> = report
            .get("screenshots")
            .and_then(Value::as_array)
            .map(|shots| {
                shots
                    .iter()
                    .filter_map(|shot| shot.get("path").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(path) = report
            .pointer("/archive_fallback/path")
            .and_then(Value::as_str)
        {
            refs.push(path);
        }

        for reference in refs {
            if !is_safe_relative_ref(reference) {
                continue;
            }
            let file = report_dir.join(reference);
            if !file.is_file() {
                continue;
            }
            if let Ok(relative) = file.strip_prefix(root) {
                files.insert(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    Ok(files)
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
    use super::{discover_delivery, read_rpc_metrics, rust_session_recorded, slugify};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn rust_session_is_recorded_only_when_the_session_file_holds_something() {
        let root = tempdir().unwrap();
        assert!(
            !rust_session_recorded(root.path()),
            "no agent-session folder"
        );
        fs::create_dir_all(root.path().join("session")).unwrap();
        assert!(
            !rust_session_recorded(root.path()),
            "the empty session/ folder says nothing"
        );
        fs::create_dir_all(root.path().join("agent-session")).unwrap();
        assert!(
            !rust_session_recorded(root.path()),
            "the folder without the file"
        );
        fs::write(root.path().join("agent-session/session.jsonl"), "").unwrap();
        assert!(!rust_session_recorded(root.path()), "an empty session file");
        fs::write(root.path().join("agent-session/session.jsonl"), "{}\n").unwrap();
        assert!(rust_session_recorded(root.path()));
    }

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
    fn recorded_tool_profile_is_the_latest_valid_profile() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempdir().unwrap();
        let bundle = super::InvestigationBundle::create(root.path(), "profile memory").unwrap();
        assert_eq!(bundle.recorded_tool_profile(), None);
        fs::write(
            &bundle.events_path,
            concat!(
                "{\"type\":\"newsroom_rpc_metrics\",\"tool_profile\":\"visual-story\"}\n",
                "not json\n",
                "{\"type\":\"turn_end\",\"tool_profile\":\"publication\"}\n",
                "{\"type\":\"newsroom_rpc_metrics\",\"tool_profile\":\"no-such-profile\"}\n"
            ),
        )
        .unwrap();
        assert_eq!(
            bundle.recorded_tool_profile().as_deref(),
            Some("visual-story")
        );
        fs::write(
            &bundle.events_path,
            concat!(
                "{\"type\":\"newsroom_rpc_metrics\",\"tool_profile\":\"visual-story\"}\n",
                "{\"type\":\"newsroom_rpc_metrics\",\"tool_profile\":\"visual\"}\n"
            ),
        )
        .unwrap();
        assert_eq!(bundle.recorded_tool_profile().as_deref(), Some("visual"));
    }

    #[test]
    fn measured_publication_needs_a_passing_browser_qa_binding() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempdir().unwrap();
        let bundle = super::InvestigationBundle::create(root.path(), "measured page").unwrap();
        assert!(bundle.measured_publication_gap().unwrap().is_some());

        // A Lieflat page never qualifies, even with a PASS report for its HTML.
        let lieflat = bundle.dir.join("publications/lieflat");
        fs::create_dir_all(&lieflat).unwrap();
        fs::write(lieflat.join("index.html"), "<html>lieflat</html>").unwrap();
        fs::write(
            lieflat.join("manifest.json"),
            r#"{"kind":"lieflat_publication","html_ref":"publications/lieflat/index.html"}"#,
        )
        .unwrap();
        let write_qa = |key: &str, status: &str, html: &std::path::Path| {
            let dir = bundle.dir.join("publications/qa").join(key);
            fs::create_dir_all(&dir).unwrap();
            let hash = crate::hash::sha256_file(html).unwrap();
            fs::write(
                dir.join("browser-qa.json"),
                format!(r#"{{"status":"{status}","html_sha256":"{hash}"}}"#),
            )
            .unwrap();
        };
        write_qa("lieflat", "PASS", &lieflat.join("index.html"));
        let gap = bundle.measured_publication_gap().unwrap().unwrap();
        assert!(gap.contains("Lieflat"), "{gap}");

        let measured = bundle.dir.join("publications/measured");
        fs::create_dir_all(&measured).unwrap();
        fs::write(measured.join("index.html"), "<html>measured</html>").unwrap();
        fs::write(
            measured.join("manifest.json"),
            r#"{"kind":"publication","html_ref":"publications/measured/index.html"}"#,
        )
        .unwrap();
        write_qa("measured", "FAIL", &measured.join("index.html"));
        assert!(bundle.measured_publication_gap().unwrap().is_some());
        write_qa("measured", "PASS", &measured.join("index.html"));
        assert_eq!(bundle.measured_publication_gap().unwrap(), None);
    }

    #[test]
    fn png_request_needs_the_desktop_render_alone_or_the_pair() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempdir().unwrap();
        let bundle = super::InvestigationBundle::create(root.path(), "png gate").unwrap();
        // A PNG only counts once it is the screenshot of a PASSing QA report
        // bound (by html_sha256) to a real, top-level publication - so that
        // publication has to exist first.
        let pub_dir = bundle.dir.join("publications/pubkey");
        fs::create_dir_all(&pub_dir).unwrap();
        fs::write(pub_dir.join("index.html"), "<html>pub</html>").unwrap();
        fs::write(
            pub_dir.join("manifest.json"),
            r#"{"html_ref":"publications/pubkey/index.html"}"#,
        )
        .unwrap();
        let html_sha256 = crate::hash::sha256_file(&pub_dir.join("index.html")).unwrap();

        assert!(bundle.visual_delivery_gaps(false, 0).unwrap().is_empty());
        assert_eq!(
            bundle.visual_delivery_gaps(false, 1).unwrap(),
            vec!["requested desktop PNG is missing (0/1 found)".to_string()]
        );

        let shots = bundle.dir.join("publications/qa/x");
        fs::create_dir_all(&shots).unwrap();
        fs::write(shots.join("1440.png"), b"png").unwrap();
        fs::write(
            shots.join("browser-qa.json"),
            serde_json::json!({
                "status": "PASS",
                "html_sha256": html_sha256,
                "screenshots": [{"width": 1440, "path": "1440.png", "sha256": "irrelevant"}],
            })
            .to_string(),
        )
        .unwrap();
        assert!(bundle.visual_delivery_gaps(false, 1).unwrap().is_empty());
        assert_eq!(
            bundle.visual_delivery_gaps(false, 2).unwrap(),
            vec!["requested desktop/mobile PNG pair is incomplete (1/2 found)".to_string()]
        );

        fs::write(shots.join("390.png"), b"png").unwrap();
        fs::write(
            shots.join("browser-qa.json"),
            serde_json::json!({
                "status": "PASS",
                "html_sha256": html_sha256,
                "screenshots": [
                    {"width": 1440, "path": "1440.png", "sha256": "irrelevant"},
                    {"width": 390, "path": "390.png", "sha256": "irrelevant"},
                ],
            })
            .to_string(),
        )
        .unwrap();
        assert!(bundle.visual_delivery_gaps(false, 2).unwrap().is_empty());
    }

    #[test]
    fn visual_delivery_gaps_html_requirement_ignores_rejected_publication() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempdir().unwrap();
        let bundle = super::InvestigationBundle::create(root.path(), "rejected html gate").unwrap();
        let rejected = bundle.dir.join("publications/rejected/deadbeef");
        fs::create_dir_all(&rejected).unwrap();
        fs::write(rejected.join("index.html"), "rejected").unwrap();
        fs::write(rejected.join("manifest.json"), "{}").unwrap();

        assert_eq!(
            bundle.visual_delivery_gaps(true, 0).unwrap(),
            vec!["requested self-contained HTML is missing".to_string()]
        );
    }

    #[test]
    fn visual_delivery_gaps_html_requirement_ignores_manifest_less_html() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempdir().unwrap();
        let bundle = super::InvestigationBundle::create(root.path(), "bare html gate").unwrap();
        let pub_dir = bundle.dir.join("publications/bare");
        fs::create_dir_all(&pub_dir).unwrap();
        fs::write(
            pub_dir.join("index.html"),
            "bare, no manifest.json next to it",
        )
        .unwrap();

        assert_eq!(
            bundle.visual_delivery_gaps(true, 0).unwrap(),
            vec!["requested self-contained HTML is missing".to_string()]
        );
    }

    #[test]
    fn visual_delivery_gaps_html_requirement_is_satisfied_by_a_top_level_publication() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempdir().unwrap();
        let bundle = super::InvestigationBundle::create(root.path(), "real html gate").unwrap();
        let pub_dir = bundle.dir.join("publications/pubkey");
        fs::create_dir_all(&pub_dir).unwrap();
        fs::write(pub_dir.join("index.html"), "<html></html>").unwrap();
        fs::write(
            pub_dir.join("manifest.json"),
            r#"{"html_ref":"publications/pubkey/index.html"}"#,
        )
        .unwrap();

        assert!(bundle.visual_delivery_gaps(true, 0).unwrap().is_empty());
    }

    #[test]
    fn visual_delivery_gaps_png_requirement_ignores_a_failing_reports_screenshots() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempdir().unwrap();
        let bundle = super::InvestigationBundle::create(root.path(), "fail report gate").unwrap();
        let pub_dir = bundle.dir.join("publications/pubkey");
        fs::create_dir_all(&pub_dir).unwrap();
        fs::write(pub_dir.join("index.html"), "<html>pub</html>").unwrap();
        fs::write(
            pub_dir.join("manifest.json"),
            r#"{"html_ref":"publications/pubkey/index.html"}"#,
        )
        .unwrap();
        let html_sha256 = crate::hash::sha256_file(&pub_dir.join("index.html")).unwrap();

        let qa_dir = bundle.dir.join("publications/qa/qakey");
        fs::create_dir_all(&qa_dir).unwrap();
        fs::write(qa_dir.join("1440.png"), b"png").unwrap();
        fs::write(
            qa_dir.join("browser-qa.json"),
            serde_json::json!({
                "status": "FAIL",
                "html_sha256": html_sha256,
                "screenshots": [{"width": 1440, "path": "1440.png", "sha256": "irrelevant"}],
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            bundle.visual_delivery_gaps(false, 1).unwrap(),
            vec!["requested desktop PNG is missing (0/1 found)".to_string()]
        );
    }

    #[test]
    fn visual_delivery_gaps_png_requirement_ignores_a_rejected_publications_report() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempdir().unwrap();
        let bundle = super::InvestigationBundle::create(root.path(), "rejected pub gate").unwrap();
        let rejected = bundle.dir.join("publications/rejected/deadbeef");
        fs::create_dir_all(&rejected).unwrap();
        fs::write(rejected.join("index.html"), "<html>rejected</html>").unwrap();
        fs::write(rejected.join("manifest.json"), "{}").unwrap();
        let html_sha256 = crate::hash::sha256_file(&rejected.join("index.html")).unwrap();

        // The report still says PASS and still names this exact HTML by
        // hash, but the publication behind it was rejected, so it is no
        // longer a candidate to bind a screenshot to.
        let qa_dir = bundle.dir.join("publications/qa/qakey");
        fs::create_dir_all(&qa_dir).unwrap();
        fs::write(qa_dir.join("1440.png"), b"png").unwrap();
        fs::write(
            qa_dir.join("browser-qa.json"),
            serde_json::json!({
                "status": "PASS",
                "html_sha256": html_sha256,
                "screenshots": [{"width": 1440, "path": "1440.png", "sha256": "irrelevant"}],
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(
            bundle.visual_delivery_gaps(false, 1).unwrap(),
            vec!["requested desktop PNG is missing (0/1 found)".to_string()]
        );
    }

    #[test]
    fn visual_delivery_gaps_png_requirement_ignores_an_infographic_preview_png() {
        let _command = crate::group_guard::command_for_test("investigate");
        let root = tempdir().unwrap();
        let bundle = super::InvestigationBundle::create(root.path(), "preview gate").unwrap();
        let preview = bundle.dir.join("infographics/previews/somekey");
        fs::create_dir_all(&preview).unwrap();
        fs::write(preview.join("desktop.png"), b"png").unwrap();

        assert_eq!(
            bundle.visual_delivery_gaps(false, 1).unwrap(),
            vec!["requested desktop PNG is missing (0/1 found)".to_string()]
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
        // Both publications need a top-level manifest to be delivery
        // candidates at all; without one, neither the lexical-first pick
        // nor the declared override below would have anything to choose.
        fs::write(
            old.join("manifest.json"),
            r#"{"html_ref":"publications/000-old/index.html"}"#,
        )
        .expect("old manifest");
        fs::write(
            current.join("manifest.json"),
            r#"{"html_ref":"publications/999-current/index.html"}"#,
        )
        .expect("current manifest");
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

    #[test]
    fn render_qa_rejected_svg_is_never_the_primary() {
        let dir = tempdir().expect("temp dir");
        let rejected = dir.path().join("visualizations/rejected/deadbeef");
        fs::create_dir_all(&rejected).expect("rejected dir");
        fs::write(rejected.join("desktop.svg"), "<svg>rejected</svg>").expect("rejected svg");
        fs::write(rejected.join("render-qa.json"), "{}").expect("render qa report");

        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(delivery.primary_artifact, None);
    }

    #[test]
    fn orphaned_infographic_svg_is_never_the_primary_but_its_sibling_page_is() {
        let dir = tempdir().expect("temp dir");
        fs::create_dir_all(dir.path().join("infographics")).expect("infographics dir");

        // A critic rejected "orphan"'s manifest, moving it to rejected/; the
        // SVG it used to describe is still sitting at the top level with no
        // manifest of its own.
        fs::write(
            dir.path().join("infographics/orphan.svg"),
            "<svg>orphan</svg>",
        )
        .expect("orphan svg");
        let rejected = dir.path().join("infographics/rejected/orphan");
        fs::create_dir_all(&rejected).expect("rejected dir");
        fs::write(rejected.join("manifest.json"), "{}").expect("rejected manifest");

        // A sibling page still has its top-level manifest and is the only
        // real candidate.
        fs::write(dir.path().join("infographics/page.svg"), "<svg>page</svg>").expect("page svg");
        fs::write(
            dir.path().join("infographics/page.json"),
            r#"{"variants":{"desktop":"infographics/page.svg"}}"#,
        )
        .expect("page manifest");

        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(
            delivery.primary_artifact.as_deref(),
            Some("infographics/page.svg")
        );
    }

    #[test]
    fn rejected_publication_is_never_the_primary() {
        let dir = tempdir().expect("temp dir");
        let rejected = dir.path().join("publications/rejected/deadbeef");
        fs::create_dir_all(&rejected).expect("rejected dir");
        fs::write(rejected.join("index.html"), "rejected").expect("rejected html");
        fs::write(rejected.join("manifest.json"), "{}").expect("rejected manifest");

        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(delivery.primary_artifact, None);
    }

    #[test]
    fn qa_screenshot_is_never_the_primary() {
        let dir = tempdir().expect("temp dir");
        let qa = dir.path().join("publications/qa/deadbeef");
        fs::create_dir_all(&qa).expect("qa dir");
        fs::write(qa.join("1440.png"), b"png").expect("qa screenshot");
        fs::write(qa.join("browser-qa.json"), "{}").expect("qa report");

        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(delivery.primary_artifact, None);
    }

    #[test]
    fn declared_primary_outside_the_candidate_set_is_ignored_but_inside_is_kept() {
        let dir = tempdir().expect("temp dir");
        fs::create_dir_all(dir.path().join("infographics")).expect("infographics dir");
        fs::write(dir.path().join("infographics/page.svg"), "<svg>page</svg>").expect("page svg");
        fs::write(
            dir.path().join("infographics/page.json"),
            r#"{"variants":{"desktop":"infographics/page.svg"}}"#,
        )
        .expect("page manifest");

        // This SVG exists on disk but no top-level manifest names it, so it
        // is not a candidate: a declared primary pointing at it must be
        // ignored in favor of the real candidate.
        fs::write(
            dir.path().join("infographics/orphan.svg"),
            "<svg>orphan</svg>",
        )
        .expect("orphan svg");
        fs::write(
            dir.path().join("story.json"),
            r#"{"delivery":{"primary_artifact":"infographics/orphan.svg"}}"#,
        )
        .expect("story outside set");
        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(
            delivery.primary_artifact.as_deref(),
            Some("infographics/page.svg")
        );

        // Declaring the actual candidate is honored.
        fs::write(
            dir.path().join("story.json"),
            r#"{"delivery":{"primary_artifact":"infographics/page.svg"}}"#,
        )
        .expect("story inside set");
        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(
            delivery.primary_artifact.as_deref(),
            Some("infographics/page.svg")
        );
    }

    #[test]
    fn top_level_publication_manifest_still_picks_its_index_html() {
        let dir = tempdir().expect("temp dir");
        let pub_dir = dir.path().join("publications/abc123");
        fs::create_dir_all(&pub_dir).expect("publication dir");
        fs::write(pub_dir.join("index.html"), "<html></html>").expect("index html");
        fs::write(
            pub_dir.join("manifest.json"),
            r#"{"html_ref":"publications/abc123/index.html"}"#,
        )
        .expect("manifest");

        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(
            delivery.primary_artifact.as_deref(),
            Some("publications/abc123/index.html")
        );
        assert_eq!(delivery.primary_kind.as_deref(), Some("html"));
    }

    #[test]
    fn manifest_ref_pointing_into_rejected_or_qa_is_not_a_candidate() {
        let dir = tempdir().expect("temp dir");

        // A top-level manifest is itself fine, but its own declared ref
        // reaches into rejected/ - evidence of a failure, not a deliverable.
        fs::create_dir_all(dir.path().join("infographics/rejected/orphan")).expect("rejected dir");
        fs::write(
            dir.path().join("infographics/rejected/orphan/desktop.svg"),
            "<svg>rejected</svg>",
        )
        .expect("rejected svg");
        fs::write(
            dir.path().join("infographics/page.json"),
            r#"{"variants":{"desktop":"infographics/rejected/orphan/desktop.svg"}}"#,
        )
        .expect("manifest pointing into rejected/");

        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(delivery.primary_artifact, None);

        // Same for a ref that reaches into qa/.
        fs::create_dir_all(dir.path().join("infographics/qa/orphan")).expect("qa dir");
        fs::write(
            dir.path().join("infographics/qa/orphan/desktop.svg"),
            "<svg>qa</svg>",
        )
        .expect("qa svg");
        fs::write(
            dir.path().join("infographics/other.json"),
            r#"{"variants":{"desktop":"infographics/qa/orphan/desktop.svg"}}"#,
        )
        .expect("manifest pointing into qa/");

        let delivery = discover_delivery(dir.path()).expect("delivery");
        assert_eq!(delivery.primary_artifact, None);
    }

    static NOTE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_note_switch<T>(value: Option<&str>, f: impl FnOnce() -> T) -> T {
        let _guard = NOTE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let old = std::env::var("NEWSROOM_LOCAL_SOURCE_NOTE").ok();
        match value {
            Some(v) => std::env::set_var("NEWSROOM_LOCAL_SOURCE_NOTE", v),
            None => std::env::remove_var("NEWSROOM_LOCAL_SOURCE_NOTE"),
        }
        let out = f();
        match old {
            Some(v) => std::env::set_var("NEWSROOM_LOCAL_SOURCE_NOTE", v),
            None => std::env::remove_var("NEWSROOM_LOCAL_SOURCE_NOTE"),
        }
        out
    }

    /// Imports `X.csv` (with an optional note built from the data's sha256) and returns the origin record and the warnings.
    fn import_with_note(
        switch: Option<&str>,
        note: Option<&dyn Fn(&str) -> String>,
    ) -> (serde_json::Value, Vec<String>) {
        with_note_switch(switch, || {
            let src = tempdir().unwrap();
            let data = src.path().join("X.csv");
            fs::write(&data, "a,b\n1,2\n").unwrap();
            if let Some(make) = note {
                let sha = crate::hash::sha256_file(&data).unwrap();
                fs::write(src.path().join("X.csv.source.json"), make(&sha)).unwrap();
            }
            let out = tempdir().unwrap();
            let mut bundle = super::InvestigationBundle::create(out.path(), "note").unwrap();
            bundle.import_data(&data).unwrap();
            let origins: Vec<_> = fs::read_dir(bundle.dir.join("data/origins"))
                .unwrap()
                .collect();
            assert_eq!(origins.len(), 1);
            let origin: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(origins[0].as_ref().unwrap().path()).unwrap(),
            )
            .unwrap();
            (origin, bundle.source_note_warnings.clone())
        })
    }

    fn good_note(sha: &str) -> String {
        format!(
            r#"{{"publisher":"Our World in Data","dataset":"Energy mix","license":"CC BY 4.0","url":"https://ourworldindata.org/energy","retrieved":"2026-10-01","sha256":"{sha}"}}"#
        )
    }

    #[test]
    fn matching_note_is_recorded_in_the_origin_with_its_own_hash() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (origin, warnings) = import_with_note(Some("1"), Some(&good_note));
        assert!(warnings.is_empty(), "{warnings:?}");
        let note = &origin["source_note_file"];
        assert_eq!(note["publisher"], "Our World in Data");
        assert_eq!(note["dataset"], "Energy mix");
        assert_eq!(note["license"], "CC BY 4.0");
        assert_eq!(note["sha256"], origin["sha256"]);
        assert_eq!(note["note_sha256"].as_str().unwrap().len(), 64);
    }

    type NoteMaker = dyn Fn(&str) -> String;

    #[test]
    fn bad_notes_are_ignored_with_a_reason_and_never_their_content() {
        let _command = crate::group_guard::command_for_test("investigate");
        let wrong_sha = |_: &str| good_note(&"0".repeat(64));
        let no_license =
            |sha: &str| format!(r#"{{"publisher":"P","dataset":"D","sha256":"{sha}"}}"#);
        let http = |sha: &str| good_note(sha).replace("https://", "http://");
        let not_json = |_: &str| "publisher: secret-name".to_owned();
        let long = |sha: &str| good_note(sha).replace("Energy mix", &"x".repeat(121));
        let cases: [(&NoteMaker, &str); 5] = [
            (&wrong_sha, "sha256 does not match"),
            (&no_license, "license is missing"),
            (&http, "url is not an https"),
            (&not_json, "not valid JSON"),
            (&long, "longer than 120"),
        ];
        for (make, reason) in cases {
            let (origin, warnings) = import_with_note(Some("1"), Some(make));
            assert!(origin.get("source_note_file").is_none(), "{reason}");
            assert_eq!(warnings.len(), 1, "{reason} {warnings:?}");
            assert!(warnings[0].contains(reason), "{warnings:?}");
            assert!(
                !warnings[0].contains("secret-name") && !warnings[0].contains("Our World"),
                "{warnings:?}"
            );
        }
    }

    #[test]
    fn switch_off_origin_is_identical_with_or_without_a_note_file() {
        let _command = crate::group_guard::command_for_test("investigate");
        let (plain, w1) = import_with_note(None, None);
        for off in [None, Some("0"), Some("true")] {
            let (with_note, w2) = import_with_note(off, Some(&good_note));
            assert_eq!(with_note, plain, "{off:?}");
            assert!(w1.is_empty() && w2.is_empty());
        }
        // no note file at all with the switch on: nothing recorded, no warning
        let (none_on, w3) = import_with_note(Some("1"), None);
        assert_eq!(none_on, plain);
        assert!(w3.is_empty());
    }

    fn note_dir_with(file_bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let src = tempdir().unwrap();
        let data = src.path().join("X.csv");
        fs::write(&data, "a,b\n1,2\n").unwrap();
        fs::write(src.path().join("X.csv.source.json"), file_bytes).unwrap();
        (src, data)
    }

    #[test]
    fn note_file_that_is_a_link_or_too_large_is_refused_by_reason_only() {
        with_note_switch(Some("1"), || {
            let src = tempdir().unwrap();
            let data = src.path().join("X.csv");
            fs::write(&data, "a,b\n1,2\n").unwrap();
            let sha = crate::hash::sha256_file(&data).unwrap();
            // a link to a perfectly good note elsewhere
            let real = src.path().join("elsewhere.json");
            fs::write(&real, good_note(&sha)).unwrap();
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&real, src.path().join("X.csv.source.json")).unwrap();
                assert_eq!(
                    super::read_local_source_note(&data, &sha),
                    Err("the note is a link")
                );
                fs::remove_file(src.path().join("X.csv.source.json")).unwrap();
            }
            // 17 KiB: refused before it is parsed
            let mut big = good_note(&sha).into_bytes();
            big.extend(std::iter::repeat_n(b' ', 17 * 1024));
            fs::write(src.path().join("X.csv.source.json"), &big).unwrap();
            assert_eq!(
                super::read_local_source_note(&data, &sha),
                Err("the note is too large")
            );
            // exactly at the cap is still read
            let mut edge = good_note(&sha).into_bytes();
            edge.resize(16 * 1024, b' ');
            fs::write(src.path().join("X.csv.source.json"), &edge).unwrap();
            assert!(matches!(
                super::read_local_source_note(&data, &sha),
                Ok(Some(_))
            ));
        });
    }

    #[test]
    fn hidden_and_bidirectional_characters_are_refused_in_every_field() {
        with_note_switch(Some("1"), || {
            for (label, c) in [
                ("C1", "\u{85}"),
                ("zwsp", "\u{200B}"),
                ("lrm", "\u{200E}"),
                ("rlo", "\u{202E}"),
                ("isolate", "\u{2066}"),
                ("bom", "\u{FEFF}"),
                ("c0", "\u{7}"),
            ] {
                for field in ["publisher", "dataset", "license"] {
                    let src = tempdir().unwrap();
                    let data = src.path().join("X.csv");
                    fs::write(&data, "a,b\n1,2\n").unwrap();
                    let sha = crate::hash::sha256_file(&data).unwrap();
                    let mut note: serde_json::Value =
                        serde_json::from_str(&good_note(&sha)).unwrap();
                    note[field] = serde_json::Value::String(format!("Our{c}World"));
                    fs::write(src.path().join("X.csv.source.json"), note.to_string()).unwrap();
                    assert_eq!(
                        super::read_local_source_note(&data, &sha),
                        Err("a field is longer than 120 characters or has control characters"),
                        "{label} in {field}"
                    );
                }
            }
            let (_keep, data) = note_dir_with(b"{}");
            let sha = crate::hash::sha256_file(&data).unwrap();
            assert!(super::read_local_source_note(&data, &sha).is_err());
        });
    }

    fn write_a_manifest(bundle: &super::InvestigationBundle) {
        bundle
            .write_manifest("topic", None, None, "running", None, false)
            .unwrap();
    }

    fn manifest_warnings(dir: &std::path::Path) -> Vec<String> {
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("story.json")).unwrap()).unwrap();
        value
            .get("source_note_warnings")
            .and_then(|w| w.as_array())
            .map(|w| w.iter().map(|x| x.as_str().unwrap().to_owned()).collect())
            .unwrap_or_default()
    }

    fn data_with_bad_note(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let src = tempdir().unwrap();
        let data = src.path().join(name);
        fs::write(&data, format!("a,b\n1,{name}\n")).unwrap();
        fs::write(src.path().join(format!("{name}.source.json")), "not json").unwrap();
        (src, data)
    }

    #[test]
    fn first_turn_manifest_holds_the_warning_when_the_switch_is_on() {
        let _command = crate::group_guard::command_for_test("investigate");
        // the same calls commands/investigate.rs makes: create, import_data, write_manifest on the one bundle
        with_note_switch(Some("1"), || {
            let out = tempdir().unwrap();
            let mut bundle = super::InvestigationBundle::create(out.path(), "topic").unwrap();
            let (_keep, data) = data_with_bad_note("one.csv");
            bundle.import_data(&data).unwrap();
            write_a_manifest(&bundle);
            let warnings = manifest_warnings(&bundle.dir);
            assert_eq!(warnings.len(), 1, "{warnings:?}");
            assert!(warnings[0].contains("not valid JSON") && !warnings[0].contains("not json"));
        });
    }

    #[test]
    fn follow_up_import_keeps_both_warnings() {
        let _command = crate::group_guard::command_for_test("investigate");
        with_note_switch(Some("1"), || {
            let out = tempdir().unwrap();
            let mut bundle = super::InvestigationBundle::create(out.path(), "topic").unwrap();
            let (_k1, first) = data_with_bad_note("one.csv");
            bundle.import_data(&first).unwrap();
            write_a_manifest(&bundle);
            // a follow-up turn reopens the bundle, imports another file and persists its warnings
            let mut reopened = super::InvestigationBundle::open(&bundle.dir).unwrap();
            let (_k2, second) = data_with_bad_note("two.csv");
            reopened.import_data(&second).unwrap();
            reopened.persist_source_note_warnings().unwrap();
            let warnings = manifest_warnings(&bundle.dir);
            assert_eq!(warnings.len(), 2, "{warnings:?}");
            // persisting twice does not duplicate; a later full manifest write keeps both
            reopened.persist_source_note_warnings().unwrap();
            write_a_manifest(&super::InvestigationBundle::open(&bundle.dir).unwrap());
            assert_eq!(manifest_warnings(&bundle.dir).len(), 2);
        });
    }

    #[test]
    fn switch_off_follow_up_import_leaves_the_manifest_bytes_unchanged() {
        let _command = crate::group_guard::command_for_test("investigate");
        with_note_switch(None, || {
            let out = tempdir().unwrap();
            let mut bundle = super::InvestigationBundle::create(out.path(), "topic").unwrap();
            let (_k1, first) = data_with_bad_note("one.csv");
            bundle.import_data(&first).unwrap();
            write_a_manifest(&bundle);
            let before = fs::read(bundle.dir.join("story.json")).unwrap();
            let mut reopened = super::InvestigationBundle::open(&bundle.dir).unwrap();
            let (_k2, second) = data_with_bad_note("two.csv");
            reopened.import_data(&second).unwrap();
            assert!(reopened.source_note_warnings.is_empty());
            reopened.persist_source_note_warnings().unwrap();
            assert_eq!(fs::read(bundle.dir.join("story.json")).unwrap(), before);
            // and a full manifest write with the switch off ignores page-level warning files
            fs::create_dir_all(bundle.dir.join("infographics")).unwrap();
            fs::write(bundle.dir.join("infographics").join(format!("{}.json", "a".repeat(64))), r#"{"source_note_warnings":["page source_note replaced by an accepted local note"]}"#).unwrap();
            assert!(manifest_warnings(&bundle.dir).is_empty());
            write_a_manifest(&super::InvestigationBundle::open(&bundle.dir).unwrap());
            assert!(manifest_warnings(&bundle.dir).is_empty());
        });
    }

    #[test]
    fn page_level_warning_from_a_rendered_page_reaches_the_manifest_only_when_the_switch_is_on() {
        let _command = crate::group_guard::command_for_test("investigate");
        for (switch, expected) in [(Some("1"), 1usize), (None, 0usize)] {
            with_note_switch(switch, || {
                let out = tempdir().unwrap();
                let bundle = super::InvestigationBundle::create(out.path(), "topic").unwrap();
                fs::create_dir_all(bundle.dir.join("infographics/plans")).unwrap();
                let page = r#"{"source_note_warnings":["page source_note replaced by an accepted local note"]}"#;
                fs::write(
                    bundle
                        .dir
                        .join("infographics")
                        .join(format!("{}.json", "b".repeat(64))),
                    page,
                )
                .unwrap();
                // only page manifests directly under infographics/ count, not plans
                fs::write(
                    bundle
                        .dir
                        .join("infographics/plans")
                        .join(format!("{}.json", "c".repeat(64))),
                    page,
                )
                .unwrap();
                write_a_manifest(&bundle);
                write_a_manifest(&bundle);
                assert_eq!(manifest_warnings(&bundle.dir).len(), expected, "{switch:?}");
            });
        }
    }
}
