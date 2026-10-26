use crate::group_guard;
use crate::tool_registry::{capability_class, is_capability_class};
use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditSummary {
    pub schema_version: &'static str,
    pub generated_at: String,
    pub turns: usize,
    pub tool_calls: usize,
    /// Calls that are not expanded chain steps (`tool_calls` minus the chain steps). With auto checks on this still counts the program's own
    /// auto calls; `model_initiated_calls` is the count of calls the model itself made.
    pub outer_tool_calls: usize,
    /// Steps executed inside a chain call and expanded from its result.
    pub inner_tool_calls: usize,
    /// Calls the program ran itself after a plan call (auto checks); they stay inside `tool_calls`, `tools` and `capability_classes`, because
    /// lint/render/critic names are gate evidence. They are NOT counted in the autonomy readings: `capability_tool_calls`,
    /// `successful_capability_tool_calls`, `failed_tool_calls` and the four `*_observed` flags are over the model's own calls only, so a
    /// run with auto checks on compares with one without. No gate reads this to decide anything.
    /// The three auto fields are written only when auto calls exist, so a run without them has the same tools.json bytes as before.
    #[serde(skip_serializing_if = "is_zero")]
    pub auto_calls: usize,
    /// Calls the model itself made: neither an auto call nor an expanded chain step. Only set when auto calls exist (otherwise it equals `outer_tool_calls`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_initiated_calls: Option<usize>,
    /// Distinct tool names among the model's own calls (auto calls left out). `tools` keeps the auto calls, which are gate evidence; the
    /// autonomy summary counts distinct tools from this one. Only set when auto calls exist (otherwise it equals `tools.len()`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distinct_model_tools: Option<usize>,
    /// Problems found in the order or ids of auto calls (parent missing, started before the parent ended, ids out of order); empty when sound.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub auto_order_problems: Vec<String>,
    pub capability_tool_calls: usize,
    pub successful_capability_tool_calls: usize,
    pub failed_tool_calls: usize,
    pub automatic_retries: usize,
    pub provider_failed_turns: usize,
    pub provider_auto_retries: usize,
    pub provider_retry_max_attempt: usize,
    pub provider_retry_delay_ms_total: u64,
    pub provider_failure_observed: bool,
    pub provider_error_classes: BTreeMap<String, usize>,
    pub plan_revisions: usize,
    pub successful_plan_calls: usize,
    pub follow_up_goals: usize,
    pub distinct_capability_classes: usize,
    pub capability_classes: BTreeMap<String, usize>,
    pub autonomous_execution_observed: bool,
    pub adaptive_replanning_observed: bool,
    pub tool_failure_recovery_observed: bool,
    pub follow_up_replanning_observed: bool,
    pub tools: BTreeMap<String, usize>,
    pub calls: Vec<ToolCall>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub tool: String,
    pub args: Value,
    pub is_error: Option<bool>,
    pub start_seq: usize,
    pub end_seq: usize,
    pub capability_class: Option<&'static str>,
    /// Set on an inner step expanded from a chain call's result; absent on real calls.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_call_id: Option<String>,
    /// True on a call the program ran itself after a plan call (event field `auto`); never set on a model call.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub auto: bool,
    /// The model call an auto call follows (event field `auto_parent_call_id`); not the same as `parent_call_id`, which only chain steps use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_parent_call_id: Option<String>,
}

/// Fixed step order of each runtime-only chain tool (runtime/pi/tool_chain.mjs).
const CHAIN_STEPS: [(&str, &[&str]); 2] = [
    (
        "newsroom_viz_chain",
        &[
            "newsroom_viz_plan",
            "newsroom_viz_lint",
            "newsroom_viz_render",
            "newsroom_viz_critic",
        ],
    ),
    (
        "newsroom_infographic_chain",
        &[
            "newsroom_infographic_plan",
            "newsroom_infographic_lint",
            "newsroom_infographic_render",
            "newsroom_infographic_critic",
            "newsroom_infographic_preview",
        ],
    ),
];

/// Stop codes the chain runtime can report (`runtime/pi/tool_chain.mjs`); any other
/// code makes the record unbelievable.
const CHAIN_STOP_CODES: &[&str] = &[
    "BLOCKED",
    "CANCELLED",
    "CLAIM_COMPUTATION_MISMATCH",
    "CLAIM_MANIFEST_MISMATCH",
    "DRAFT",
    "MISSING_FIELD",
    "RENDER_QA_FAILED",
    "REVISE",
    "SCHEMA_REJECTED",
    "STEP_ERROR",
    "TOOL_NOT_ENABLED",
];

/// Patch tools (runtime/pi/newsroom.ts `registerPatchTool`) and the tool each runs. A patch
/// call is read exactly like a call of the wrapped tool; a tool name not listed here is not.
const PATCH_WRAPS: [(&str, &str); 2] = [
    (
        "newsroom_infographic_plan_patch",
        "newsroom_infographic_plan",
    ),
    (
        "newsroom_infographic_chain_patch",
        "newsroom_infographic_chain",
    ),
];

fn wrapped_tool(outer_tool: &str) -> &str {
    PATCH_WRAPS
        .iter()
        .find(|(patch, _)| *patch == outer_tool)
        .map_or(outer_tool, |(_, wrapped)| wrapped)
}

/// Inner calls of a finished chain call, read only from the outer call's own
/// result in the main event stream. Anything missing or malformed yields no
/// inner calls at all: an incomplete record is never partly believed. The inner
/// calls take the outer call's `auto`, as design pack steps do.
fn chain_inner_calls(
    outer_tool: &str,
    outer_id: &str,
    event: &Value,
    start_seq: usize,
    end_seq: usize,
    auto: bool,
) -> Vec<ToolCall> {
    let patched = wrapped_tool(outer_tool) != outer_tool;
    let outer_tool = wrapped_tool(outer_tool);
    if event.get("isError").and_then(Value::as_bool) != Some(false) {
        return Vec::new();
    }
    let Some(details) = event.pointer("/result/details").and_then(Value::as_object) else {
        return Vec::new();
    };
    // A patched plan call is a plan call: only the wrapped plan tool's own success
    // details (a plan reference and a module count) make it one.
    if patched && outer_tool == "newsroom_infographic_plan" {
        let ok = details
            .get("planRef")
            .and_then(Value::as_str)
            .is_some_and(|r| !r.is_empty())
            && details.get("modules").is_some_and(Value::is_u64);
        return if ok {
            vec![ToolCall {
                id: format!("{outer_id}:{outer_tool}"),
                tool: outer_tool.to_string(),
                args: Value::Null,
                is_error: Some(false),
                start_seq,
                end_seq,
                capability_class: capability_class(outer_tool),
                parent_call_id: Some(outer_id.to_string()),
                auto,
                auto_parent_call_id: None,
            }]
        } else {
            Vec::new()
        };
    }
    let Some((_, expected)) = CHAIN_STEPS.iter().find(|(name, _)| *name == outer_tool) else {
        return Vec::new();
    };
    if details.get("chain").and_then(Value::as_str) != Some(outer_tool) {
        return Vec::new();
    }
    let Some(steps) = details.get("steps").and_then(Value::as_array) else {
        return Vec::new();
    };
    if steps.len() > expected.len() {
        return Vec::new();
    }
    let mut names: Vec<&str> = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let Some(object) = step.as_object() else {
            return Vec::new();
        };
        let tool = object.get("tool").and_then(Value::as_str);
        let params_ok = object.get("params").is_some_and(Value::is_object);
        let details_ok = object.get("details").is_some_and(Value::is_object);
        if tool != Some(expected[index]) || !params_ok || !details_ok {
            return Vec::new();
        }
        names.push(expected[index]);
    }
    // The status must agree with the steps present, or the record is incomplete.
    let failed_step = match details.get("chainStatus").and_then(Value::as_str) {
        Some("COMPLETE") if steps.len() == expected.len() => None,
        Some("STOPPED") => {
            let stop_code = details.get("stopCode").and_then(Value::as_str);
            let failed_at = details.get("failedAt").and_then(Value::as_str);
            let after_last = expected.get(steps.len()).copied();
            let at_last = steps.len().checked_sub(1).map(|i| expected[i]);
            match (stop_code, failed_at) {
                // A step error is the one step that ran and failed, right after the
                // last finished step; it never fits any other position.
                (Some("STEP_ERROR"), Some(at)) if Some(at) == after_last && !steps.is_empty() => {
                    Some(at)
                }
                (Some(code), Some(at))
                    if code != "STEP_ERROR"
                        && CHAIN_STOP_CODES.contains(&code)
                        && (Some(at) == after_last || Some(at) == at_last) =>
                {
                    None
                }
                _ => return Vec::new(),
            }
        }
        _ => return Vec::new(),
    };
    let mut inner: Vec<ToolCall> = steps
        .iter()
        .zip(names)
        .map(|(step, tool)| ToolCall {
            id: format!("{outer_id}:{tool}"),
            tool: tool.to_string(),
            args: step.get("params").cloned().unwrap_or(Value::Null),
            is_error: Some(false),
            start_seq,
            end_seq,
            capability_class: capability_class(tool),
            parent_call_id: Some(outer_id.to_string()),
            auto,
            auto_parent_call_id: None,
        })
        .collect();
    if let Some(tool) = failed_step {
        inner.push(ToolCall {
            id: format!("{outer_id}:{tool}"),
            tool: tool.to_string(),
            args: Value::Null,
            is_error: Some(true),
            start_seq,
            end_seq,
            capability_class: capability_class(tool),
            parent_call_id: Some(outer_id.to_string()),
            auto,
            auto_parent_call_id: None,
        });
    }
    inner
}

/// Fixed inner steps of a RENDERED design pack (runtime/pi/design_pack.mjs `INNER_STEP_TOOLS`): the page chain, then the publication.
const DESIGN_PACK_STEPS: [&str; 8] = [
    "newsroom_infographic_plan",
    "newsroom_infographic_lint",
    "newsroom_infographic_render",
    "newsroom_infographic_critic",
    "newsroom_infographic_preview",
    "newsroom_publication_plan",
    "newsroom_publication_render",
    "newsroom_publication_qa",
];

/// Reads the bytes of `reference` under `run_dir`: relative, only plain path parts (no `..`), the given folder prefix, and a real file
/// that stays inside the run folder once links are resolved. `None` when any of that fails.
fn design_pack_file(run_dir: &Path, reference: &str, prefix: &str) -> Option<Vec<u8>> {
    let relative = Path::new(reference);
    if relative.is_absolute()
        || !reference.starts_with(prefix)
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return None;
    }
    let root = run_dir.canonicalize().ok()?;
    let path = root.join(relative).canonicalize().ok()?;
    if !path.starts_with(&root) || !path.is_file() {
        return None;
    }
    std::fs::read(path).ok()
}

fn design_pack_json(run_dir: &Path, reference: &str, prefix: &str) -> Option<Value> {
    serde_json::from_slice(&design_pack_file(run_dir, reference, prefix)?).ok()
}

/// Inner calls of a finished design pack call. The pack names itself a chain only when it is RENDERED and every inner step is on record
/// (runtime/pi/design_pack.mjs `finish`), and this reads that record plus the files it names: all or nothing, like `chain_inner_calls`.
/// A call that stopped, is only the first half, has any problem, or whose record does not match the steps, the refs or the files on disk
/// yields no inner calls. Nothing is rebuilt from refs. The inner steps take the outer call's `auto`: a pack the program ran is the
/// program's, a pack the model called is the model's.
fn design_pack_inner_calls(
    outer_id: &str,
    event: &Value,
    run_dir: &Path,
    start_seq: usize,
    end_seq: usize,
    auto: bool,
) -> Vec<ToolCall> {
    design_pack_checked_steps(event, run_dir)
        .map(|steps| {
            steps
                .iter()
                .zip(DESIGN_PACK_STEPS)
                .map(|(step, tool)| ToolCall {
                    id: format!("{outer_id}:{tool}"),
                    tool: tool.to_string(),
                    args: step.get("params").cloned().unwrap_or(Value::Null),
                    is_error: Some(false),
                    start_seq,
                    end_seq,
                    capability_class: capability_class(tool),
                    parent_call_id: Some(outer_id.to_string()),
                    auto,
                    auto_parent_call_id: None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The shared sample of the asset source rule (also read by runtime/pi/art_direction.mjs): which run-relative paths are the page's own files.
const ASSET_SOURCE_PREFIXES: &str =
    include_str!("../fixtures/design_pack/asset-source-prefixes.json");

/// How a source path of an asset plan reads against the shared sample: `own_page`, `accepted_folder` or `unknown`.
fn asset_source_verdict(path: &str) -> &'static str {
    let table: Value = serde_json::from_str(ASSET_SOURCE_PREFIXES).unwrap_or(Value::Null);
    let listed = |key: &str| {
        table
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    // A file directly in an accepted folder, named <name>.json, is an accepted kind.
    for entry in listed("accepted_folders") {
        let Some(folder) = entry.get("folder").and_then(Value::as_str) else {
            continue;
        };
        if let Some(name) = path.strip_prefix(folder) {
            if name.len() > ".json".len() && name.ends_with(".json") && !name.contains('/') {
                return "accepted_folder";
            }
        }
    }
    let own = listed("own_page").iter().any(|entry| {
        entry
            .get("prefix")
            .and_then(Value::as_str)
            .is_some_and(|prefix| path.starts_with(prefix))
    });
    if own {
        "own_page"
    } else {
        "unknown"
    }
}

/// True when every available requirement of the asset plan cites sources that are not the page's own files. A requirement marked
/// available with no list of strings to cite, or with an empty one, does not pass: the safe direction is no expansion.
fn asset_plan_sources_are_outside(asset_json: &Value) -> bool {
    let Some(requirements) = asset_json.get("requirements").and_then(Value::as_array) else {
        return false;
    };
    // `available` that is missing or not a boolean is malformed, not false: no expansion
    if requirements.iter().any(|requirement| {
        requirement
            .get("available")
            .and_then(Value::as_bool)
            .is_none()
    }) {
        return false;
    }
    requirements
        .iter()
        .filter(|requirement| requirement.get("available").and_then(Value::as_bool) == Some(true))
        .all(|requirement| {
            requirement
                .get("source_refs")
                .and_then(Value::as_array)
                .is_some_and(|refs| {
                    !refs.is_empty()
                        && refs.iter().all(|reference| {
                            reference.as_str().is_some_and(|path| {
                                !path.is_empty() && asset_source_verdict(path) != "own_page"
                            })
                        })
                })
        })
}

/// `reference` is `<folder><name>.json` with nothing between the folder and the name.
fn directly_in(reference: &str, folder: &str) -> bool {
    reference.strip_prefix(folder).is_some_and(|name| {
        name.len() > ".json".len() && name.ends_with(".json") && !name.contains('/')
    })
}

fn design_pack_checked_steps<'a>(event: &'a Value, run_dir: &Path) -> Option<&'a Vec<Value>> {
    if event.get("isError").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    let details = event.pointer("/result/details")?.as_object()?;
    let text = |object: &serde_json::Map<String, Value>, key: &str| -> Option<String> {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    if details.get("designPack").and_then(Value::as_bool) != Some(true)
        || details.get("chain").and_then(Value::as_str) != Some("newsroom_design_pack")
        || details.get("chainStatus").and_then(Value::as_str) != Some("COMPLETE")
        || details.get("status").and_then(Value::as_str) != Some("RENDERED")
        || !details
            .get("problems")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    {
        return None;
    }
    let steps = details.get("steps")?.as_array()?;
    if steps.len() != DESIGN_PACK_STEPS.len() {
        return None;
    }
    let mut step_details: Vec<&serde_json::Map<String, Value>> = Vec::new();
    for (step, expected) in steps.iter().zip(DESIGN_PACK_STEPS) {
        let object = step.as_object()?;
        if object.get("tool").and_then(Value::as_str) != Some(expected)
            || !object.get("params").is_some_and(Value::is_object)
        {
            return None;
        }
        step_details.push(object.get("details")?.as_object()?);
    }
    let refs = details.get("refs")?.as_object()?;
    // Every ref the pack reports must be the one the step itself reported.
    let plan = text(step_details[0], "planRef")?;
    let lint = text(step_details[1], "lintRef")?;
    let manifest = text(step_details[2], "manifestRef")?;
    let critic = text(step_details[3], "criticRef")?;
    let preview = text(step_details[4], "previewRef")?;
    let pub_plan = text(step_details[5], "planRef")?;
    let html = text(step_details[6], "htmlRef")?;
    let pub_manifest = text(step_details[6], "manifestRef")?;
    let qa = text(step_details[7], "reportRef")?;
    let asset_plan = text(refs, "assetPlanRef")?;
    for (key, value) in [
        ("infographicPlanRef", &plan),
        ("infographicManifestRef", &manifest),
        ("infographicCriticRef", &critic),
        ("previewRef", &preview),
        ("publicationPlanRef", &pub_plan),
        ("publicationHtmlRef", &html),
        ("publicationManifestRef", &pub_manifest),
        ("publicationQaRef", &qa),
    ] {
        if text(refs, key).as_deref() != Some(value.as_str()) {
            return None;
        }
    }
    // The files on disk: where each ref points, and that they point at each other.
    let linked =
        |value: &Value, key: &str, want: &str| value.get(key).and_then(Value::as_str) == Some(want);
    let plan_json = design_pack_json(run_dir, &plan, "infographics/plans/")?;
    let lint_json = design_pack_json(run_dir, &lint, "infographics/lints/")?;
    // The infographic manifest sits directly under infographics/, not in the plans, lints, critics or previews folders.
    if !directly_in(&manifest, "infographics/") {
        return None;
    }
    let manifest_json = design_pack_json(run_dir, &manifest, "infographics/")?;
    let critic_json = design_pack_json(run_dir, &critic, "infographics/critics/")?;
    let preview_json = design_pack_json(run_dir, &preview, "infographics/previews/")?;
    let pub_plan_json = design_pack_json(run_dir, &pub_plan, "publications/plans/")?;
    let pub_manifest_json = design_pack_json(run_dir, &pub_manifest, "publications/")?;
    let qa_json = design_pack_json(run_dir, &qa, "publications/qa/")?;
    let html_bytes = design_pack_file(run_dir, &html, "publications/")?;
    let asset_json = design_pack_json(run_dir, &asset_plan, "editorial/assets/")?;
    // The page plan names the asset plan it was written against (editorial.asset_plan_ref); another CONTINUE plan does not count.
    let plan_names_asset_plan = plan_json
        .get("editorial")
        .and_then(|editorial| editorial.get("asset_plan_ref"))
        .and_then(Value::as_str)
        == Some(asset_plan.as_str());
    if plan_json.get("kind").and_then(Value::as_str).is_none()
        || !plan_names_asset_plan
        || preview_json.get("kind").and_then(Value::as_str) != Some("infographic_visual_preview")
        || asset_json.get("kind").and_then(Value::as_str) != Some("editorial_asset_plan")
        || asset_json.get("decision").and_then(Value::as_str) != Some("CONTINUE")
        || !linked(&lint_json, "plan_ref", &plan)
        || !linked(&critic_json, "plan_ref", &plan)
        || !linked(&critic_json, "lint_ref", &lint)
        || !linked(&critic_json, "manifest_ref", &manifest)
        || !linked(&manifest_json, "plan_ref", &plan)
        || !linked(&manifest_json, "lint_ref", &lint)
        || !linked(&preview_json, "manifest_ref", &manifest)
        || !linked(&pub_plan_json, "infographic_plan_ref", &plan)
        || lint_json.get("passed").and_then(Value::as_bool) != Some(true)
        || critic_json.get("passed").and_then(Value::as_bool) != Some(true)
        || !asset_plan_sources_are_outside(&asset_json)
    {
        return None;
    }
    // The publication manifest names this plan, this page plan and this HTML, both files sit in one publication folder.
    let html_folder = html.rsplit_once('/').map(|(folder, _)| folder);
    if html_folder.is_none()
        || html_folder != pub_manifest.rsplit_once('/').map(|(folder, _)| folder)
        || !linked(&pub_manifest_json, "html_ref", &html)
        || !linked(&pub_manifest_json, "plan_ref", &pub_plan)
        || !linked(&pub_manifest_json, "infographic_plan_ref", &plan)
    {
        return None;
    }
    // A pass is the report on disk saying PASS about exactly these HTML bytes, never the details alone.
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(&html_bytes));
    if qa_json.get("status").and_then(Value::as_str) != Some("PASS")
        || qa_json.get("html_sha256").and_then(Value::as_str) != Some(digest.as_str())
        || pub_manifest_json.get("html_sha256").and_then(Value::as_str) != Some(digest.as_str())
    {
        return None;
    }
    Some(steps)
}

impl AuditSummary {
    /// Calls the model itself made: all calls minus the auto ones, so a chain's inner steps stay in (the reading compares with a run that has
    /// no auto checks). The autonomy block reads this, not `tool_calls`.
    pub fn model_tool_calls(&self) -> usize {
        self.tool_calls.saturating_sub(self.auto_calls)
    }

    /// Distinct tools the model itself called (auto calls left out).
    pub fn model_distinct_tools(&self) -> usize {
        self.distinct_model_tools.unwrap_or(self.tools.len())
    }

    /// Backward-compatible name used by the control plane.  The semantics are
    /// deliberately strict: a plan must precede a successful capability
    /// action, and the environment observation must be followed by another
    /// observable agent decision (another tool action or turn completion).
    pub fn has_agent_loop_evidence(&self) -> bool {
        self.autonomous_execution_observed
    }
}

pub fn append_user_goal_event(events_path: &Path, mode: &str) -> Result<()> {
    let mut file = group_guard::as_run_bundle(|| {
        group_guard::open_append(events_path.parent().unwrap_or(Path::new("")), events_path)
    })
    .with_context(|| format!("failed to open event log: {}", events_path.display()))?;
    let event = json!({
        "type": "newsroom_user_goal",
        "mode": mode,
        "recordedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    });
    writeln!(file, "{}", serde_json::to_string(&event)?)?;
    Ok(())
}

pub fn append_completion_retry_event(
    events_path: &Path,
    attempt: usize,
    gaps: &[String],
) -> Result<()> {
    let mut file = group_guard::as_run_bundle(|| {
        group_guard::open_append(events_path.parent().unwrap_or(Path::new("")), events_path)
    })
    .with_context(|| format!("failed to open event log: {}", events_path.display()))?;
    let event = json!({
        "type": "auto_retry_start",
        "reason": "visual_completion_gate",
        "attempt": attempt,
        "gaps": gaps,
        "recordedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    });
    writeln!(file, "{}", serde_json::to_string(&event)?)?;
    Ok(())
}

/// Checks the auto calls of a sorted call list: each names a parent that is a real model call, starts after that parent ended, and has the id
/// `<parent>:auto:<n>` with n rising in start order. A problem is reported, never repaired, and the calls stay counted as they are.
/// Inner steps (a `parent_call_id`) are vouched for by their outer call, which is checked here like any other.
fn auto_order_problems(calls: &[ToolCall]) -> Vec<String> {
    let mut problems = Vec::new();
    let mut last_serial: HashMap<&str, u64> = HashMap::new();
    for call in calls
        .iter()
        .filter(|call| call.auto && call.parent_call_id.is_none())
    {
        let Some(parent_id) = call.auto_parent_call_id.as_deref() else {
            problems.push(format!("{}: auto call names no parent", call.id));
            continue;
        };
        let Some(parent) = calls
            .iter()
            .find(|c| !c.auto && c.parent_call_id.is_none() && c.id == parent_id)
        else {
            problems.push(format!(
                "{}: parent {parent_id} is not a model call",
                call.id
            ));
            continue;
        };
        if call.start_seq <= parent.end_seq {
            problems.push(format!("{}: started before its parent ended", call.id));
        }
        let serial = call
            .id
            .strip_prefix(parent_id)
            .and_then(|rest| rest.strip_prefix(":auto:"))
            .and_then(|n| n.parse::<u64>().ok());
        match serial {
            None => problems.push(format!("{}: id is not <parent>:auto:<n>", call.id)),
            Some(n) => {
                if last_serial.get(parent_id).is_some_and(|last| n <= *last) {
                    problems.push(format!("{}: serial not ascending", call.id));
                }
                last_serial.insert(parent_id, n);
            }
        }
    }
    problems
}

pub fn build(events_path: &Path, output_path: &Path) -> Result<AuditSummary> {
    let file = File::open(events_path)
        .with_context(|| format!("failed to open event log: {}", events_path.display()))?;
    let reader = BufReader::new(file);
    let mut starts: HashMap<String, (String, Value, usize)> = HashMap::new();
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut turns = 0usize;
    let mut retries = 0usize;
    let mut provider_failed_turns = 0usize;
    let mut provider_auto_retries = 0usize;
    let mut provider_retry_max_attempt = 0usize;
    let mut provider_retry_delay_ms_total = 0u64;
    let mut provider_error_classes: BTreeMap<String, usize> = BTreeMap::new();
    let mut turn_end_seqs = Vec::new();
    let mut follow_up_goal_seqs = Vec::new();
    let mut sequence = 0usize;

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        sequence += 1;
        if let Some(class) = event.get("provider_error_class").and_then(Value::as_str) {
            *provider_error_classes
                .entry(class.to_string())
                .or_insert(0usize) += 1;
        }
        match event.get("type").and_then(Value::as_str) {
            Some("turn_end") => {
                turns += 1;
                turn_end_seqs.push(sequence);
                if event
                    .get("message")
                    .and_then(|message| message.get("stopReason"))
                    .and_then(Value::as_str)
                    == Some("error")
                {
                    provider_failed_turns += 1;
                }
            }
            Some("auto_retry_start") => {
                retries += 1;
                if event.get("reason").and_then(Value::as_str) != Some("visual_completion_gate")
                    && event.get("delayMs").and_then(Value::as_u64).is_some()
                {
                    provider_auto_retries += 1;
                    provider_retry_max_attempt = provider_retry_max_attempt
                        .max(event.get("attempt").and_then(Value::as_u64).unwrap_or(0) as usize);
                    provider_retry_delay_ms_total +=
                        event.get("delayMs").and_then(Value::as_u64).unwrap_or(0);
                }
            }
            Some("newsroom_user_goal") => {
                if event.get("mode").and_then(Value::as_str) == Some("follow_up") {
                    follow_up_goal_seqs.push(sequence);
                }
            }
            Some("tool_execution_start") => {
                let id = event
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let tool = event
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let args = event.get("args").cloned().unwrap_or(Value::Null);
                starts.insert(id, (tool, args, sequence));
            }
            Some("tool_execution_end") => {
                let id = event
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                let (tool, args, start_seq) = starts
                    .remove(&id)
                    .unwrap_or_else(|| ("unknown".to_string(), Value::Null, sequence));
                let class = capability_class(&tool);
                let auto = event.get("auto").and_then(Value::as_bool) == Some(true);
                let inner = if tool == "newsroom_design_pack" {
                    design_pack_inner_calls(
                        &id,
                        &event,
                        events_path.parent().unwrap_or(Path::new("")),
                        start_seq,
                        sequence,
                        auto,
                    )
                } else {
                    chain_inner_calls(&tool, &id, &event, start_seq, sequence, auto)
                };
                calls.push(ToolCall {
                    id,
                    tool,
                    args,
                    is_error: event.get("isError").and_then(Value::as_bool),
                    start_seq,
                    end_seq: sequence,
                    capability_class: class,
                    parent_call_id: None,
                    auto,
                    auto_parent_call_id: event
                        .get("auto_parent_call_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
                calls.extend(inner);
            }
            _ => {}
        }
    }

    for (id, (tool, args, start_seq)) in starts {
        let class = capability_class(&tool);
        calls.push(ToolCall {
            id,
            tool,
            args,
            is_error: None,
            start_seq,
            end_seq: sequence.saturating_add(1),
            capability_class: class,
            parent_call_id: None,
            auto: false,
            auto_parent_call_id: None,
        });
    }
    calls.sort_by_key(|call| (call.start_seq, call.end_seq));

    let auto_order_problems = auto_order_problems(&calls);

    let mut tools = BTreeMap::new();
    let mut capability_classes = BTreeMap::new();
    let mut failed = 0usize;
    let mut plan_revisions = 0usize;
    let mut successful_plan_calls = 0usize;
    let mut capability_tool_calls = 0usize;
    let mut successful_capability_tool_calls = 0usize;

    for call in &calls {
        *tools.entry(call.tool.clone()).or_insert(0usize) += 1;
        if call.is_error == Some(true) && !call.auto {
            failed += 1;
        }
        if call.tool == "newsroom_update_plan" {
            plan_revisions += 1;
            if call.is_error == Some(false) {
                successful_plan_calls += 1;
            }
        }
        if is_capability_class(call.capability_class) {
            if let Some(class) = call.capability_class {
                *capability_classes
                    .entry(class.to_string())
                    .or_insert(0usize) += 1;
            }
            // the autonomy readings count what the model did, not what the program ran for it
            if !call.auto {
                capability_tool_calls += 1;
                if call.is_error == Some(false) {
                    successful_capability_tool_calls += 1;
                }
            }
        }
    }

    let successful_plans: Vec<&ToolCall> = calls
        .iter()
        .filter(|call| call.tool == "newsroom_update_plan" && call.is_error == Some(false))
        .collect();
    let successful_capabilities: Vec<&ToolCall> = calls
        .iter()
        .filter(|call| {
            !call.auto && is_capability_class(call.capability_class) && call.is_error == Some(false)
        })
        .collect();

    let autonomous_execution_observed = successful_plans.iter().any(|plan| {
        successful_capabilities.iter().any(|capability| {
            if capability.start_seq <= plan.end_seq {
                return false;
            }
            let later_tool_decision = calls
                .iter()
                .any(|next| !next.auto && next.start_seq > capability.end_seq);
            let later_turn_decision = turn_end_seqs.iter().any(|seq| *seq > capability.end_seq);
            later_tool_decision || later_turn_decision
        })
    });

    let mut adaptive_replanning_observed = false;
    let mut tool_failure_recovery_observed = false;
    let mut follow_up_replanning_observed = false;
    for (index, revision) in successful_plans.iter().enumerate().skip(1) {
        let previous_plan_end = successful_plans[index - 1].end_seq;
        let failed_since_previous_plan = calls.iter().any(|call| {
            call.is_error == Some(true)
                && !call.auto
                && call.end_seq > previous_plan_end
                && call.end_seq < revision.start_seq
        });
        let follow_up_since_previous_plan = follow_up_goal_seqs
            .iter()
            .any(|seq| *seq > previous_plan_end && *seq < revision.start_seq);
        let post_revision_action = successful_capabilities
            .iter()
            .any(|call| call.start_seq > revision.end_seq);
        if post_revision_action && (failed_since_previous_plan || follow_up_since_previous_plan) {
            adaptive_replanning_observed = true;
        }
        if post_revision_action && failed_since_previous_plan {
            tool_failure_recovery_observed = true;
        }
        if post_revision_action && follow_up_since_previous_plan {
            follow_up_replanning_observed = true;
        }
    }

    let summary = AuditSummary {
        schema_version: "0.8.0",
        generated_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        turns,
        tool_calls: calls.len(),
        outer_tool_calls: calls
            .iter()
            .filter(|call| call.parent_call_id.is_none())
            .count(),
        inner_tool_calls: calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .count(),
        auto_calls: calls.iter().filter(|call| call.auto).count(),
        model_initiated_calls: calls.iter().any(|call| call.auto).then(|| {
            calls
                .iter()
                .filter(|call| call.parent_call_id.is_none() && !call.auto)
                .count()
        }),
        distinct_model_tools: calls.iter().any(|call| call.auto).then(|| {
            calls
                .iter()
                .filter(|call| !call.auto)
                .map(|call| call.tool.as_str())
                .collect::<std::collections::BTreeSet<_>>()
                .len()
        }),
        auto_order_problems,
        capability_tool_calls,
        successful_capability_tool_calls,
        failed_tool_calls: failed,
        automatic_retries: retries,
        provider_failed_turns,
        provider_auto_retries,
        provider_retry_max_attempt,
        provider_retry_delay_ms_total,
        provider_failure_observed: provider_failed_turns > 0 || !provider_error_classes.is_empty(),
        provider_error_classes,
        plan_revisions,
        successful_plan_calls,
        follow_up_goals: follow_up_goal_seqs.len(),
        distinct_capability_classes: capability_classes.len(),
        capability_classes,
        autonomous_execution_observed,
        adaptive_replanning_observed,
        tool_failure_recovery_observed,
        follow_up_replanning_observed,
        tools,
        calls,
    };

    let json = serde_json::to_string_pretty(&summary)?;
    group_guard::as_run_bundle(|| {
        group_guard::write(
            output_path.parent().unwrap_or(Path::new("")),
            output_path,
            format!("{json}\n"),
        )
    })
    .with_context(|| format!("failed to write audit: {}", output_path.display()))?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    fn build_fixture(events: Vec<Value>) -> AuditSummary {
        let fixture_id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "newsroom-audit-{}-{fixture_id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let events_path = root.join("events.jsonl");
        let output_path = root.join("tools.json");
        let mut text = String::new();
        for event in events {
            text.push_str(&serde_json::to_string(&event).unwrap());
            text.push('\n');
        }
        fs::write(&events_path, text).unwrap();
        let summary = build(&events_path, &output_path).unwrap();
        let _ = fs::remove_dir_all(root);
        summary
    }

    fn call(id: &str, tool: &str, is_error: bool) -> Vec<Value> {
        vec![
            json!({"type":"tool_execution_start","toolCallId":id,"toolName":tool,"args":{}}),
            json!({"type":"tool_execution_end","toolCallId":id,"toolName":tool,"isError":is_error}),
        ]
    }

    /// The audit of the same events with and without `model_timing` events (NEWSROOM_MODEL_TIMING_RECORD) between the lines.
    #[test]
    fn model_timing_events_shift_the_sequence_numbers_but_not_how_the_calls_nest() {
        let _command = crate::group_guard::command_for_test("investigate");
        let timing =
            || json!({"type":"model_timing","started_at":"2026-01-01T00:00:00Z","blocks":[]});
        let mut plain = call("p1", "newsroom_update_plan", false);
        plain.extend(call("q1", "duckdb_query", false));
        plain.push(json!({"type":"turn_end"}));
        let mut recorded = vec![timing()];
        for event in &plain {
            recorded.push(event.clone());
            recorded.push(timing());
        }
        let as_value = |events: Vec<Value>| {
            let mut value = serde_json::to_value(build_fixture(events)).unwrap();
            value.as_object_mut().unwrap().remove("generated_at");
            value
        };
        let (a, b) = (as_value(plain), as_value(recorded));
        let strip = |value: &Value| {
            let mut value = value.clone();
            for call in value["calls"].as_array_mut().unwrap() {
                call.as_object_mut().unwrap().remove("start_seq");
                call.as_object_mut().unwrap().remove("end_seq");
            }
            value
        };
        let ends = |value: &Value| -> Vec<(u64, u64)> {
            value["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    (
                        c["start_seq"].as_u64().unwrap(),
                        c["end_seq"].as_u64().unwrap(),
                    )
                })
                .collect()
        };
        assert_eq!(
            strip(&a),
            strip(&b),
            "everything but the sequence numbers is the same"
        );
        let (plain_ranges, recorded_ranges) = (ends(&a), ends(&b));
        assert_ne!(
            plain_ranges, recorded_ranges,
            "the numbers shift with the record on"
        );
        let order = |ranges: &[(u64, u64)]| {
            let mut points: Vec<(u64, usize, bool)> = ranges
                .iter()
                .enumerate()
                .flat_map(|(i, r)| [(r.0, i, true), (r.1, i, false)])
                .collect();
            points.sort();
            points
                .into_iter()
                .map(|(_, i, start)| (i, start))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            order(&plain_ranges),
            order(&recorded_ranges),
            "every start and end keeps its place relative to the others"
        );
    }

    #[test]
    fn planning_without_capability_is_not_agent_loop() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut events = call("p1", "newsroom_update_plan", false);
        events.push(json!({"type":"turn_end"}));
        let summary = build_fixture(events);
        assert!(!summary.autonomous_execution_observed);
        assert!(!summary.adaptive_replanning_observed);
        assert_eq!(summary.capability_tool_calls, 0);
    }

    #[test]
    fn plan_capability_observation_then_completion_is_autonomous() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut events = call("p1", "newsroom_update_plan", false);
        events.extend(call("q1", "duckdb_query", false));
        events.push(json!({"type":"turn_end"}));
        let summary = build_fixture(events);
        assert!(summary.autonomous_execution_observed);
        assert!(!summary.adaptive_replanning_observed);
        assert_eq!(summary.distinct_capability_classes, 1);
    }

    #[test]
    fn tool_failure_then_replan_then_action_is_adaptive() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut events = call("p1", "newsroom_update_plan", false);
        events.extend(call("f1", "fetch_url", true));
        events.extend(call("p2", "newsroom_update_plan", false));
        events.extend(call("q1", "duckdb_query", false));
        events.push(json!({"type":"turn_end"}));
        let summary = build_fixture(events);
        assert!(summary.autonomous_execution_observed);
        assert!(summary.adaptive_replanning_observed);
        assert!(summary.tool_failure_recovery_observed);
    }

    #[test]
    fn repeated_plans_without_observable_trigger_do_not_count_as_adaptive() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut events = call("p1", "newsroom_update_plan", false);
        events.extend(call("p2", "newsroom_update_plan", false));
        events.extend(call("q1", "duckdb_query", false));
        events.push(json!({"type":"turn_end"}));
        let summary = build_fixture(events);
        assert!(summary.autonomous_execution_observed);
        assert!(!summary.adaptive_replanning_observed);
    }

    #[test]
    fn follow_up_then_replan_then_action_is_adaptive() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut events = call("p1", "newsroom_update_plan", false);
        events.extend(call("q0", "duckdb_query", false));
        events.push(json!({"type":"turn_end"}));
        events.push(json!({"type":"newsroom_user_goal","mode":"follow_up"}));
        events.extend(call("p2", "newsroom_update_plan", false));
        events.extend(call("q1", "duckdb_query", false));
        events.push(json!({"type":"turn_end"}));
        let summary = build_fixture(events);
        assert!(summary.adaptive_replanning_observed);
        assert!(!summary.tool_failure_recovery_observed);
        assert!(summary.follow_up_replanning_observed);
        assert_eq!(summary.follow_up_goals, 1);
    }

    #[test]
    fn provider_failures_and_backoff_are_safely_counted() {
        let _command = crate::group_guard::command_for_test("investigate");
        let events = vec![
            json!({"type":"turn_end","message":{"stopReason":"error","errorMessage":"diagnostic suppressed"}}),
            json!({"type":"auto_retry_start","attempt":1,"delayMs":2000}),
            json!({"type":"turn_end","message":{"stopReason":"error","errorMessage":"diagnostic suppressed"}}),
            json!({"type":"auto_retry_start","attempt":2,"delayMs":4000}),
            json!({"type":"response","success":false,"provider_error_class":"provider_unavailable","provider_http_status":503}),
        ];
        let summary = build_fixture(events);
        assert_eq!(summary.provider_failed_turns, 2);
        assert_eq!(summary.provider_auto_retries, 2);
        assert_eq!(summary.provider_retry_max_attempt, 2);
        assert_eq!(summary.provider_retry_delay_ms_total, 6000);
        assert!(summary.provider_failure_observed);
        assert_eq!(
            summary.provider_error_classes.get("provider_unavailable"),
            Some(&1)
        );
    }

    #[test]
    fn completion_retry_event_is_counted_and_records_gaps() {
        let _command = crate::group_guard::command_for_test("investigate");
        let fixture_id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "newsroom-audit-retry-{}-{fixture_id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let events_path = root.join("events.jsonl");
        let output_path = root.join("tools.json");
        let gaps = vec!["requested desktop/mobile PNG pair is incomplete".to_string()];
        append_completion_retry_event(&events_path, 1, &gaps).unwrap();
        let event: Value =
            serde_json::from_str(&fs::read_to_string(&events_path).unwrap()).unwrap();
        assert_eq!(event["reason"], "visual_completion_gate");
        assert_eq!(event["attempt"], 1);
        assert_eq!(event["gaps"][0], gaps[0]);
        assert_eq!(
            build(&events_path, &output_path).unwrap().automatic_retries,
            1
        );
        let _ = fs::remove_dir_all(root);
    }

    const VIZ: [&str; 4] = [
        "newsroom_viz_plan",
        "newsroom_viz_lint",
        "newsroom_viz_render",
        "newsroom_viz_critic",
    ];

    fn chain_steps(tools: &[&str]) -> Vec<Value> {
        tools
            .iter()
            .map(|tool| json!({"tool": tool, "params": {"plan_ref": "p"}, "details": {"passed": true}}))
            .collect()
    }

    fn chain_call(id: &str, tool: &str, is_error: bool, details: Value) -> Vec<Value> {
        vec![
            json!({"type":"tool_execution_start","toolCallId":id,"toolName":tool,"args":{}}),
            json!({"type":"tool_execution_end","toolCallId":id,"toolName":tool,"isError":is_error,
                   "result":{"content":[],"details":details}}),
        ]
    }

    fn viz_done(steps: &[&str]) -> Value {
        json!({"chain":"newsroom_viz_chain","chainStatus":"COMPLETE","steps":chain_steps(steps)})
    }

    fn inner_count(summary: &AuditSummary) -> usize {
        summary
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .count()
    }

    #[test]
    fn a_finished_viz_chain_shows_its_four_inner_tools_once() {
        let _command = crate::group_guard::command_for_test("investigate");
        let summary = build_fixture(chain_call(
            "c1",
            "newsroom_viz_chain",
            false,
            viz_done(&VIZ),
        ));
        for tool in VIZ {
            assert_eq!(summary.tools.get(tool), Some(&1), "{tool}");
        }
        assert_eq!(
            summary.tool_calls, 5,
            "the outer call plus four inner steps"
        );
        assert_eq!(summary.failed_tool_calls, 0);
        let order: Vec<&str> = summary
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .map(|call| call.tool.as_str())
            .collect();
        assert_eq!(order, VIZ);
        assert!(summary
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .all(|call| call.parent_call_id.as_deref() == Some("c1")));
    }

    #[test]
    fn a_viz_chain_the_program_ran_has_auto_inner_steps_and_grants_no_autonomy() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut events = call("m1", "newsroom_choose", false);
        for mut event in chain_call("m1:auto:1", "newsroom_viz_chain", false, viz_done(&VIZ)) {
            event["auto"] = json!(true);
            event["auto_parent_call_id"] = json!("m1");
            events.push(event);
        }
        let summary = build_fixture(events);
        assert_eq!(inner_count(&summary), VIZ.len());
        assert!(summary
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .all(|call| call.auto && call.parent_call_id.as_deref() == Some("m1:auto:1")));
        assert_eq!(
            summary.auto_calls,
            1 + VIZ.len(),
            "the chain plus its inner steps"
        );
        assert!(
            summary.auto_order_problems.is_empty(),
            "{:?}",
            summary.auto_order_problems
        );
        assert!(
            !summary.autonomous_execution_observed,
            "the program's chain is not the model's work"
        );
    }

    #[test]
    fn expanded_inner_calls_read_like_direct_calls() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut direct = Vec::new();
        for tool in VIZ {
            direct.push(json!({"type":"tool_execution_start","toolCallId":tool,"toolName":tool,"args":{"plan_ref":"p"}}));
            direct.push(json!({"type":"tool_execution_end","toolCallId":tool,"toolName":tool,"isError":false}));
        }
        let direct = build_fixture(direct);
        let chained = build_fixture(chain_call(
            "c1",
            "newsroom_viz_chain",
            false,
            viz_done(&VIZ),
        ));
        let key = |call: &ToolCall| {
            (
                call.tool.clone(),
                call.args.clone(),
                call.is_error,
                call.capability_class,
            )
        };
        let inner: Vec<_> = chained
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .map(key)
            .collect();
        let direct: Vec<_> = direct.calls.iter().map(key).collect();
        assert_eq!(inner, direct);
    }

    #[test]
    fn a_page_chain_expands_five_steps_and_a_blocker_stop_keeps_its_steps() {
        let _command = crate::group_guard::command_for_test("investigate");
        let page = [
            "newsroom_infographic_plan",
            "newsroom_infographic_lint",
            "newsroom_infographic_render",
            "newsroom_infographic_critic",
            "newsroom_infographic_preview",
        ];
        let full = json!({"chain":"newsroom_infographic_chain","chainStatus":"COMPLETE","steps":chain_steps(&page)});
        assert_eq!(
            inner_count(&build_fixture(chain_call(
                "g1",
                "newsroom_infographic_chain",
                false,
                full
            ))),
            5
        );
        let blocked = json!({"chain":"newsroom_infographic_chain","chainStatus":"STOPPED","failedAt":"newsroom_infographic_lint","stopCode":"BLOCKED","steps":chain_steps(&page[..2])});
        let summary = build_fixture(chain_call(
            "g2",
            "newsroom_infographic_chain",
            false,
            blocked,
        ));
        assert_eq!(inner_count(&summary), 2);
        assert_eq!(
            summary.failed_tool_calls, 0,
            "a lint blocker is a normal result, as in a direct call"
        );
    }

    #[test]
    fn outer_and_inner_calls_are_counted_separately() {
        let _command = crate::group_guard::command_for_test("investigate");
        let summary = build_fixture(chain_call(
            "k1",
            "newsroom_viz_chain",
            false,
            viz_done(&VIZ),
        ));
        assert_eq!(summary.tool_calls, 5);
        assert_eq!(summary.outer_tool_calls, 1);
        assert_eq!(summary.inner_tool_calls, 4);
    }

    #[test]
    fn a_stopped_record_with_a_wrong_shape_yields_no_inner_calls() {
        let _command = crate::group_guard::command_for_test("investigate");
        let stopped = |code: &str, failed_at: &str, n: usize| json!({"chain":"newsroom_viz_chain","chainStatus":"STOPPED","failedAt":failed_at,"stopCode":code,"steps":chain_steps(&VIZ[..n])});
        let cases = [
            (
                "unknown stop code",
                stopped("MADE_UP", "newsroom_viz_render", 2),
            ),
            (
                "step error on the last finished step",
                stopped("STEP_ERROR", "newsroom_viz_lint", 2),
            ),
            (
                "step error with no finished step",
                stopped("STEP_ERROR", "newsroom_viz_plan", 0),
            ),
        ];
        for (label, details) in cases {
            let summary = build_fixture(chain_call("w1", "newsroom_viz_chain", false, details));
            assert_eq!(inner_count(&summary), 0, "{label}");
        }
        let cancelled = stopped("CANCELLED", "newsroom_viz_render", 2);
        assert_eq!(
            inner_count(&build_fixture(chain_call(
                "w2",
                "newsroom_viz_chain",
                false,
                cancelled
            ))),
            2
        );
    }

    #[test]
    fn an_inner_step_error_counts_once_as_a_failure() {
        let _command = crate::group_guard::command_for_test("investigate");
        let details = json!({"chain":"newsroom_viz_chain","chainStatus":"STOPPED","failedAt":"newsroom_viz_render","stopCode":"STEP_ERROR","steps":chain_steps(&VIZ[..2])});
        let summary = build_fixture(chain_call("c1", "newsroom_viz_chain", false, details));
        assert_eq!(inner_count(&summary), 3);
        assert_eq!(summary.failed_tool_calls, 1);
        let failed: Vec<_> = summary
            .calls
            .iter()
            .filter(|call| call.is_error == Some(true))
            .collect();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].tool, "newsroom_viz_render");
    }

    #[test]
    fn untrusted_or_incomplete_chain_records_expand_to_nothing() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut shapes: Vec<(&str, bool, Value)> = vec![
            ("outer error", true, viz_done(&VIZ)),
            ("details missing", false, Value::Null),
            ("details not an object", false, json!("COMPLETE")),
            (
                "steps missing",
                false,
                json!({"chain":"newsroom_viz_chain","chainStatus":"COMPLETE"}),
            ),
            (
                "steps not an array",
                false,
                json!({"chain":"newsroom_viz_chain","chainStatus":"COMPLETE","steps":{}}),
            ),
            ("complete but a step is missing", false, viz_done(&VIZ[..3])),
            (
                "wrong chain name",
                false,
                json!({"chain":"newsroom_infographic_chain","chainStatus":"COMPLETE","steps":chain_steps(&VIZ)}),
            ),
            (
                "step out of order",
                false,
                viz_done(&[VIZ[1], VIZ[0], VIZ[2], VIZ[3]]),
            ),
            (
                "a step of another tool",
                false,
                viz_done(&["duckdb_query", VIZ[1], VIZ[2], VIZ[3]]),
            ),
            (
                "too many steps",
                false,
                viz_done(&[VIZ[0], VIZ[1], VIZ[2], VIZ[3], VIZ[3]]),
            ),
            (
                "step without params",
                false,
                json!({"chain":"newsroom_viz_chain","chainStatus":"COMPLETE","steps":VIZ.iter().map(|t| json!({"tool":t,"details":{}})).collect::<Vec<_>>()}),
            ),
            (
                "unknown status",
                false,
                json!({"chain":"newsroom_viz_chain","chainStatus":"RUNNING","steps":chain_steps(&VIZ)}),
            ),
            (
                "stopped without a stop code",
                false,
                json!({"chain":"newsroom_viz_chain","chainStatus":"STOPPED","failedAt":"newsroom_viz_lint","steps":chain_steps(&VIZ[..2])}),
            ),
            (
                "step error naming the wrong tool",
                false,
                json!({"chain":"newsroom_viz_chain","chainStatus":"STOPPED","failedAt":"newsroom_viz_critic","stopCode":"STEP_ERROR","steps":chain_steps(&VIZ[..2])}),
            ),
        ];
        shapes.push(("not a chain tool", false, viz_done(&VIZ)));
        for (label, is_error, details) in shapes {
            let tool = if label == "not a chain tool" {
                "duckdb_query"
            } else {
                "newsroom_viz_chain"
            };
            let summary = build_fixture(chain_call("c1", tool, is_error, details));
            assert_eq!(inner_count(&summary), 0, "{label}");
            assert_eq!(summary.tool_calls, 1, "{label}");
        }
    }

    #[test]
    fn a_chain_end_with_no_start_or_no_end_is_not_expanded() {
        let _command = crate::group_guard::command_for_test("investigate");
        // Inner-looking steps in a sidecar never reach events.jsonl; and a
        // chain end event without its own start, or a start without an end, adds nothing.
        let end_only = vec![
            json!({"type":"tool_execution_end","toolCallId":"x","toolName":"newsroom_viz_chain","isError":false,
            "result":{"details":viz_done(&VIZ)}}),
        ];
        assert_eq!(inner_count(&build_fixture(end_only)), 0);
        let start_only = vec![
            json!({"type":"tool_execution_start","toolCallId":"x","toolName":"newsroom_viz_chain","args":{}}),
        ];
        assert_eq!(inner_count(&build_fixture(start_only)), 0);
    }

    const PAGE: [&str; 5] = [
        "newsroom_infographic_plan",
        "newsroom_infographic_lint",
        "newsroom_infographic_render",
        "newsroom_infographic_critic",
        "newsroom_infographic_preview",
    ];
    const PAGE_PATCH: &str = "newsroom_infographic_chain_patch";

    fn page_done(steps: &[&str]) -> Value {
        json!({"chain":"newsroom_infographic_chain","chainStatus":"COMPLETE","steps":chain_steps(steps)})
    }

    fn page_stopped_at_lint() -> Value {
        json!({"chain":"newsroom_infographic_chain","chainStatus":"STOPPED","failedAt":"newsroom_infographic_lint","stopCode":"BLOCKED","steps":chain_steps(&PAGE[..2])})
    }

    fn inner_tools(summary: &AuditSummary) -> Vec<&str> {
        summary
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .map(|call| call.tool.as_str())
            .collect()
    }

    #[test]
    fn a_chain_patch_call_that_completes_all_five_steps_counts_as_complete() {
        let _command = crate::group_guard::command_for_test("investigate");
        let patched = build_fixture(chain_call(PAGE_PATCH, PAGE_PATCH, false, page_done(&PAGE)));
        let direct = build_fixture(chain_call(
            "c1",
            "newsroom_infographic_chain",
            false,
            page_done(&PAGE),
        ));
        assert_eq!(inner_tools(&patched), PAGE);
        assert_eq!(inner_tools(&patched), inner_tools(&direct));
        assert_eq!(patched.failed_tool_calls, 0);
        for call in patched
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
        {
            assert_eq!(call.is_error, Some(false));
            assert_eq!(call.parent_call_id.as_deref(), Some(PAGE_PATCH));
        }
    }

    #[test]
    fn a_chain_patch_call_that_stops_at_lint_counts_as_stopped_at_lint() {
        let _command = crate::group_guard::command_for_test("investigate");
        let patched = build_fixture(chain_call("p1", PAGE_PATCH, false, page_stopped_at_lint()));
        assert_eq!(inner_tools(&patched), &PAGE[..2]);
        assert_eq!(patched.tools.get("newsroom_infographic_render"), None);
        // The same record from a direct chain call reads the same way.
        let direct = build_fixture(chain_call(
            "p1",
            "newsroom_infographic_chain",
            false,
            page_stopped_at_lint(),
        ));
        assert_eq!(inner_tools(&patched), inner_tools(&direct));
    }

    #[test]
    fn a_malformed_patch_record_yields_no_inner_calls() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut shapes: Vec<(&str, bool, Value)> = vec![
            ("outer error", true, page_done(&PAGE)),
            (
                "complete but a step is missing",
                false,
                page_done(&PAGE[..4]),
            ),
            (
                "step out of order",
                false,
                page_done(&[PAGE[1], PAGE[0], PAGE[2], PAGE[3], PAGE[4]]),
            ),
            (
                "wrong chain name",
                false,
                json!({"chain":PAGE_PATCH,"chainStatus":"COMPLETE","steps":chain_steps(&PAGE)}),
            ),
            (
                "viz chain name",
                false,
                json!({"chain":"newsroom_viz_chain","chainStatus":"COMPLETE","steps":chain_steps(&PAGE)}),
            ),
            (
                "unknown stop code",
                false,
                json!({"chain":"newsroom_infographic_chain","chainStatus":"STOPPED","failedAt":PAGE[2],"stopCode":"MADE_UP","steps":chain_steps(&PAGE[..2])}),
            ),
            ("details missing", false, Value::Null),
        ];
        shapes.push((
            "steps not an array",
            false,
            json!({"chain":"newsroom_infographic_chain","chainStatus":"COMPLETE","steps":{}}),
        ));
        for (label, is_error, details) in shapes {
            let summary = build_fixture(chain_call("m1", PAGE_PATCH, is_error, details));
            assert_eq!(inner_count(&summary), 0, "{label}");
            assert_eq!(summary.tool_calls, 1, "{label}");
        }
        // A plan patch counts only with the plan tool's own success details.
        for details in [
            Value::Null,
            json!({}),
            json!({"planRef":"","modules":3}),
            json!({"planRef":"infographics/plans/x.json"}),
        ] {
            let summary = build_fixture(chain_call(
                "m2",
                "newsroom_infographic_plan_patch",
                false,
                details,
            ));
            assert_eq!(inner_count(&summary), 0);
        }
    }

    #[test]
    fn a_tool_name_not_in_the_patch_table_is_ignored() {
        let _command = crate::group_guard::command_for_test("investigate");
        for tool in [
            "newsroom_viz_chain_patch",
            "newsroom_infographic_chain_patch2",
            "x_newsroom_infographic_chain_patch",
            "newsroom_infographic_render_patch",
        ] {
            let summary = build_fixture(chain_call("i1", tool, false, page_done(&PAGE)));
            assert_eq!(inner_count(&summary), 0, "{tool}");
            assert_eq!(summary.tool_calls, 1, "{tool}");
        }
    }

    #[test]
    fn a_successful_plan_patch_counts_as_one_plan_call() {
        let _command = crate::group_guard::command_for_test("investigate");
        let details = json!({"planRef":"infographics/plans/x.json","modules":4});
        let summary = build_fixture(chain_call(
            "pp",
            "newsroom_infographic_plan_patch",
            false,
            details,
        ));
        assert_eq!(inner_tools(&summary), ["newsroom_infographic_plan"]);
    }

    fn auto_event(kind: &str, id: &str, parent: &str, tool: &str) -> Value {
        json!({"type":kind,"toolCallId":id,"toolName":tool,"args":{},"isError":false,"auto":true,"auto_parent_call_id":parent})
    }

    /// plan call c1, then auto lint and render, then a model call c2
    fn auto_run() -> Vec<Value> {
        let mut events = call("c1", "newsroom_infographic_plan", false);
        events.push(auto_event(
            "tool_execution_start",
            "c1:auto:1",
            "c1",
            "newsroom_infographic_lint",
        ));
        events.push(auto_event(
            "tool_execution_end",
            "c1:auto:1",
            "c1",
            "newsroom_infographic_lint",
        ));
        events.push(auto_event(
            "tool_execution_start",
            "c1:auto:2",
            "c1",
            "newsroom_infographic_render",
        ));
        events.push(auto_event(
            "tool_execution_end",
            "c1:auto:2",
            "c1",
            "newsroom_infographic_render",
        ));
        events.extend(call("c2", "newsroom_infographic_critic", false));
        events
    }

    #[test]
    fn auto_calls_stay_in_the_tool_counts_and_get_their_own_two_counts() {
        let _command = crate::group_guard::command_for_test("investigate");
        let summary = build_fixture(auto_run());
        assert_eq!(summary.tool_calls, 4);
        assert_eq!(summary.auto_calls, 2);
        assert_eq!(summary.model_initiated_calls, Some(2));
        assert!(summary.auto_order_problems.is_empty());
        // the auto lint is still lint evidence: it is in the tools count and its capability class is the same as a model-made lint
        assert_eq!(summary.tools["newsroom_infographic_lint"], 1);
        let model_lint = build_fixture(call("m1", "newsroom_infographic_lint", false));
        let auto_lint = summary
            .calls
            .iter()
            .find(|c| c.tool == "newsroom_infographic_lint")
            .unwrap();
        assert!(auto_lint.auto);
        assert_eq!(
            auto_lint.capability_class,
            model_lint.calls[0].capability_class
        );
        // a model call of the same tool name is never an auto call
        assert_eq!(model_lint.auto_calls, 0);
        assert_eq!(model_lint.model_initiated_calls, None);
        assert!(!model_lint.calls[0].auto);
    }

    /// p1, a plan call c1 (with or without an auto lint that fails), p2, a model query, then the turn ends
    fn run_with_auto_lint(auto: bool) -> Vec<Value> {
        let mut events = call("p1", "newsroom_update_plan", false);
        events.extend(call("c1", "newsroom_infographic_plan", false));
        if auto {
            let mut lint = vec![
                auto_event(
                    "tool_execution_start",
                    "c1:auto:1",
                    "c1",
                    "newsroom_infographic_lint",
                ),
                auto_event(
                    "tool_execution_end",
                    "c1:auto:1",
                    "c1",
                    "newsroom_infographic_lint",
                ),
            ];
            lint[1]["isError"] = json!(true);
            events.extend(lint);
        }
        events.extend(call("p2", "newsroom_update_plan", false));
        events.extend(call("q1", "duckdb_query", false));
        events.push(json!({"type":"turn_end"}));
        events
    }

    #[test]
    fn the_autonomy_block_reads_the_model_counts_not_the_totals() {
        let _command = crate::group_guard::command_for_test("investigate");
        let with = build_fixture(run_with_auto_lint(true));
        let without = build_fixture(run_with_auto_lint(false));
        assert_eq!(with.tool_calls, without.tool_calls + 1);
        assert_eq!(with.model_tool_calls(), without.model_tool_calls());
        assert_eq!(with.model_distinct_tools(), without.model_distinct_tools());
    }

    #[test]
    fn the_model_call_count_keeps_chain_steps_and_drops_only_auto_calls() {
        let _command = crate::group_guard::command_for_test("investigate");
        let mut summary = build_fixture(run_with_auto_lint(false));
        summary.tool_calls = 10;
        summary.auto_calls = 2;
        summary.model_initiated_calls = Some(5); // outer calls only: it loses the 3 chain steps
        assert_eq!(summary.model_tool_calls(), 8);
    }

    #[test]
    fn a_successful_auto_step_after_a_revision_is_not_a_recovery_by_the_model() {
        let _command = crate::group_guard::command_for_test("investigate");
        // p1, a failing model call, p2, and then only an auto lint (child of p2) that succeeds
        let run = |auto: bool| {
            let mut events = call("p1", "newsroom_update_plan", false);
            events.extend(call("c1", "newsroom_infographic_plan", true));
            events.extend(call("p2", "newsroom_update_plan", false));
            if auto {
                events.push(auto_event(
                    "tool_execution_start",
                    "p2:auto:1",
                    "p2",
                    "newsroom_infographic_lint",
                ));
                events.push(auto_event(
                    "tool_execution_end",
                    "p2:auto:1",
                    "p2",
                    "newsroom_infographic_lint",
                ));
            }
            events.push(json!({"type":"turn_end"}));
            build_fixture(events)
        };
        let (with, without) = (run(true), run(false));
        assert!(!without.tool_failure_recovery_observed);
        assert_eq!(
            with.tool_failure_recovery_observed,
            without.tool_failure_recovery_observed
        );
        assert_eq!(
            with.adaptive_replanning_observed,
            without.adaptive_replanning_observed
        );
    }

    #[test]
    fn the_autonomy_readings_are_the_same_with_and_without_an_auto_lint() {
        let _command = crate::group_guard::command_for_test("investigate");
        let with = build_fixture(run_with_auto_lint(true));
        let without = build_fixture(run_with_auto_lint(false));
        // the auto lint is evidence: it is in the tools and the capability classes
        assert_eq!(with.tools["newsroom_infographic_lint"], 1);
        assert_eq!(
            with.capability_classes["visual"],
            without.capability_classes["visual"] + 1
        );
        // and it moves none of the readings that stand for what the model did
        assert_eq!(with.capability_tool_calls, without.capability_tool_calls);
        assert_eq!(
            with.successful_capability_tool_calls,
            without.successful_capability_tool_calls
        );
        assert_eq!(with.failed_tool_calls, 0);
        assert_eq!(with.failed_tool_calls, without.failed_tool_calls);
        assert_eq!(with.distinct_model_tools, Some(without.tools.len()));
        assert_eq!(without.distinct_model_tools, None);
        assert_eq!(
            with.autonomous_execution_observed,
            without.autonomous_execution_observed
        );
        assert_eq!(
            with.adaptive_replanning_observed,
            without.adaptive_replanning_observed
        );
        assert!(
            !with.tool_failure_recovery_observed,
            "a failed auto step is not a recovery by the model"
        );
        assert_eq!(
            with.tool_failure_recovery_observed,
            without.tool_failure_recovery_observed
        );
        assert_eq!(
            with.follow_up_replanning_observed,
            without.follow_up_replanning_observed
        );
    }

    #[test]
    fn an_auto_call_after_the_last_capability_is_not_a_later_decision() {
        let _command = crate::group_guard::command_for_test("investigate");
        // p1, a model capability call whose own auto step runs after it, and no turn end: nothing the model decided came after the capability
        let mut events = call("p1", "newsroom_update_plan", false);
        events.extend(call("c1", "newsroom_infographic_plan", false));
        events.push(auto_event(
            "tool_execution_start",
            "c1:auto:1",
            "c1",
            "newsroom_infographic_lint",
        ));
        events.push(auto_event(
            "tool_execution_end",
            "c1:auto:1",
            "c1",
            "newsroom_infographic_lint",
        ));
        assert!(!build_fixture(events).autonomous_execution_observed);
        let mut alone = call("p1", "newsroom_update_plan", false);
        alone.extend(call("c1", "newsroom_infographic_plan", false));
        assert!(!build_fixture(alone).autonomous_execution_observed);
    }

    #[test]
    fn a_run_without_auto_calls_writes_the_same_summary_fields_as_before() {
        let _command = crate::group_guard::command_for_test("investigate");
        let summary = build_fixture(call("c1", "newsroom_infographic_plan", false));
        let text = serde_json::to_value(&summary).unwrap();
        for key in [
            "auto_calls",
            "model_initiated_calls",
            "distinct_model_tools",
            "auto_order_problems",
        ] {
            assert!(text.get(key).is_none(), "{key}");
        }
        assert!(text["calls"][0].get("auto").is_none());
        assert!(text["calls"][0].get("auto_parent_call_id").is_none());
    }

    #[test]
    fn auto_order_problems_are_reported_for_a_missing_parent_early_start_and_bad_serials() {
        let _command = crate::group_guard::command_for_test("investigate");
        // parent missing
        let orphan = vec![
            auto_event(
                "tool_execution_start",
                "x:auto:1",
                "x",
                "newsroom_infographic_lint",
            ),
            auto_event(
                "tool_execution_end",
                "x:auto:1",
                "x",
                "newsroom_infographic_lint",
            ),
        ];
        assert_eq!(build_fixture(orphan).auto_order_problems.len(), 1);
        // started before the parent ended
        let mut early = vec![
            json!({"type":"tool_execution_start","toolCallId":"c1","toolName":"newsroom_infographic_plan","args":{}}),
        ];
        early.push(auto_event(
            "tool_execution_start",
            "c1:auto:1",
            "c1",
            "newsroom_infographic_lint",
        ));
        early.push(auto_event(
            "tool_execution_end",
            "c1:auto:1",
            "c1",
            "newsroom_infographic_lint",
        ));
        early.push(json!({"type":"tool_execution_end","toolCallId":"c1","toolName":"newsroom_infographic_plan","isError":false}));
        let problems = build_fixture(early).auto_order_problems;
        assert!(
            problems
                .iter()
                .any(|p| p.contains("before its parent ended")),
            "{problems:?}"
        );
        // serials not ascending
        let mut events = call("c1", "newsroom_infographic_plan", false);
        for n in [2, 1] {
            let id = format!("c1:auto:{n}");
            events.push(auto_event(
                "tool_execution_start",
                &id,
                "c1",
                "newsroom_infographic_lint",
            ));
            events.push(auto_event(
                "tool_execution_end",
                &id,
                "c1",
                "newsroom_infographic_lint",
            ));
        }
        let problems = build_fixture(events).auto_order_problems;
        assert!(
            problems.iter().any(|p| p.contains("serial not ascending")),
            "{problems:?}"
        );
        // a parent that is itself an auto call is refused
        let mut nested = auto_run();
        nested.push(auto_event(
            "tool_execution_start",
            "c1:auto:1:auto:1",
            "c1:auto:1",
            "newsroom_infographic_critic",
        ));
        nested.push(auto_event(
            "tool_execution_end",
            "c1:auto:1:auto:1",
            "c1:auto:1",
            "newsroom_infographic_critic",
        ));
        assert!(!build_fixture(nested).auto_order_problems.is_empty());
    }

    // ---- the design pack's inner steps (runtime/pi/design_pack.mjs): read from the call's own record and the files it names ----

    /// The sample the runtime test (scripts/test_design_pack.mjs) reads too: if the pack's `details` change shape, one of the two goes red.
    const DESIGN_PACK_SAMPLE: &str = include_str!("../fixtures/design_pack/rendered-details.json");
    /// sha256 of the compact, key-sorted JSON of `runtime/pi/groups.json` "cross_calls" as of this change.
    /// Since it was pinned, the table gained only the registration of `groups.mjs::withBoundaryContext` (one `imported` row, one `not_wrapped` row),
    /// and on 10-26 rule one's `rust_rule_next` (the new-route files, the shared kinds and the agent group's system write entries).
    const CROSS_CALLS_DIGEST: &str =
        "29b0dd6c3f84c0ce455394f4719322cfd5ae2ed6b90478c3af410ec9dd8ccba2";
    const PACK_HTML: &[u8] = b"<html>design pack page</html>";

    fn write_pack_file(root: &Path, reference: &str, bytes: &[u8]) {
        let path = root.join(reference);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn pack_ref(details: &Value, key: &str) -> String {
        details["refs"][key].as_str().unwrap().to_string()
    }

    fn write_pack_files(root: &Path, details: &Value) {
        use sha2::{Digest, Sha256};
        let plan = pack_ref(details, "infographicPlanRef");
        let lint = details["steps"][1]["details"]["lintRef"]
            .as_str()
            .unwrap()
            .to_string();
        let manifest = pack_ref(details, "infographicManifestRef");
        let json = |value: Value| serde_json::to_vec(&value).unwrap();
        write_pack_file(
            root,
            &plan,
            &json(json!({
                "kind": "infographic_plan",
                "editorial": {"asset_plan_ref": pack_ref(details, "assetPlanRef")}
            })),
        );
        write_pack_file(
            root,
            &lint,
            &json(json!({"plan_ref": plan, "passed": true})),
        );
        write_pack_file(
            root,
            &manifest,
            &json(json!({"plan_ref": plan, "lint_ref": lint})),
        );
        write_pack_file(
            root,
            &pack_ref(details, "infographicCriticRef"),
            &json(
                json!({"plan_ref": plan, "lint_ref": lint, "manifest_ref": manifest, "passed": true}),
            ),
        );
        write_pack_file(
            root,
            &pack_ref(details, "previewRef"),
            &json(json!({"kind": "infographic_visual_preview", "manifest_ref": manifest})),
        );
        write_pack_file(
            root,
            &pack_ref(details, "publicationPlanRef"),
            &json(json!({"infographic_plan_ref": plan})),
        );
        write_pack_file(
            root,
            &pack_ref(details, "publicationManifestRef"),
            &json(json!({
                "html_ref": pack_ref(details, "publicationHtmlRef"),
                "html_sha256": format!("{:x}", Sha256::digest(PACK_HTML)),
                "plan_ref": pack_ref(details, "publicationPlanRef"),
                "infographic_plan_ref": plan
            })),
        );
        write_pack_file(root, &pack_ref(details, "publicationHtmlRef"), PACK_HTML);
        write_pack_file(
            root,
            &pack_ref(details, "publicationQaRef"),
            &json(
                json!({"status": "PASS", "html_sha256": format!("{:x}", Sha256::digest(PACK_HTML))}),
            ),
        );
        write_pack_file(
            root,
            &pack_ref(details, "assetPlanRef"),
            &json(json!({
                "kind": "editorial_asset_plan",
                "decision": "CONTINUE",
                "requirements": [{"id": "asset-1", "available": true, "source_refs": ["maps/basemaps/world.json"]}]
            })),
        );
    }

    /// A run folder with the sample's files on disk; `edit` may change the details and the files before the audit reads them.
    fn pack_run_with(
        tool: &str,
        is_error: bool,
        edit: impl FnOnce(&mut Value, &Path),
    ) -> AuditSummary {
        pack_run_events(edit, |details| chain_call("dp1", tool, is_error, details))
    }

    /// The same run folder, with the event log built from the (edited) details by `events`.
    fn pack_run_events(
        edit: impl FnOnce(&mut Value, &Path),
        events: impl FnOnce(Value) -> Vec<Value>,
    ) -> AuditSummary {
        let fixture_id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "newsroom-audit-pack-{}-{fixture_id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut details: Value = serde_json::from_str(DESIGN_PACK_SAMPLE).unwrap();
        write_pack_files(&root, &details);
        edit(&mut details, &root);
        let mut text = String::new();
        for event in events(details) {
            text.push_str(&serde_json::to_string(&event).unwrap());
            text.push('\n');
        }
        let events_path = root.join("events.jsonl");
        fs::write(&events_path, text).unwrap();
        let summary = build(&events_path, &root.join("tools.json")).unwrap();
        let _ = fs::remove_dir_all(root);
        summary
    }

    fn pack_run(edit: impl FnOnce(&mut Value, &Path)) -> AuditSummary {
        pack_run_with("newsroom_design_pack", false, edit)
    }

    fn pack_inner(summary: &AuditSummary) -> Vec<&str> {
        summary
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .map(|call| call.tool.as_str())
            .collect()
    }

    #[test]
    fn a_rendered_design_pack_shows_its_eight_inner_steps_once() {
        let _command = crate::group_guard::command_for_test("investigate");
        let summary = pack_run(|_, _| {});
        assert_eq!(pack_inner(&summary), DESIGN_PACK_STEPS);
        assert_eq!(summary.tool_calls, 9, "the pack plus eight inner steps");
        assert_eq!(summary.outer_tool_calls, 1);
        assert_eq!(summary.inner_tool_calls, 8);
        assert_eq!(summary.failed_tool_calls, 0);
        assert!(summary
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .all(|call| call.parent_call_id.as_deref() == Some("dp1")
                && !call.auto
                && call.is_error == Some(false)));
        // the render step carries the real plan path, which the requested-mode gate reads
        let render = summary
            .calls
            .iter()
            .find(|call| call.tool == "newsroom_infographic_render")
            .unwrap();
        assert_eq!(render.args["plan_ref"], "infographics/plans/bbbb.json");
        assert_eq!(summary.tools.get("newsroom_design_pack"), Some(&1));
        // the pack's own record only names the 7 required steps and the preview: nothing from the editorial preflight is expanded
        for name in [
            "newsroom_editorial_discovery",
            "newsroom_visual_concepts",
            "newsroom_semantic_novelty",
            "newsroom_asset_requirements",
        ] {
            assert!(!summary.tools.contains_key(name), "{name}");
        }
    }

    #[test]
    fn a_design_pack_the_program_ran_after_a_model_call_has_auto_inner_steps_and_no_order_problem()
    {
        let _command = crate::group_guard::command_for_test("investigate");
        let summary = pack_run_events(
            |_, _| {},
            |details| {
                let mut events = call("m1", "newsroom_choose", false);
                for mut event in chain_call("m1:auto:1", "newsroom_design_pack", false, details) {
                    event["auto"] = json!(true);
                    event["auto_parent_call_id"] = json!("m1");
                    events.push(event);
                }
                events
            },
        );
        assert_eq!(pack_inner(&summary), DESIGN_PACK_STEPS);
        assert!(summary
            .calls
            .iter()
            .filter(|call| call.parent_call_id.is_some())
            .all(|call| call.parent_call_id.as_deref() == Some("m1:auto:1")
                && call.auto
                && call.auto_parent_call_id.is_none()));
        assert_eq!(summary.auto_calls, 9, "the pack plus its eight inner steps");
        assert!(
            summary.auto_order_problems.is_empty(),
            "{:?}",
            summary.auto_order_problems
        );
        // the pack itself is still checked: without its model parent it is reported, once
        let orphan = pack_run_events(
            |_, _| {},
            |details| {
                chain_call("x:auto:1", "newsroom_design_pack", false, details)
                    .into_iter()
                    .map(|mut event| {
                        event["auto"] = json!(true);
                        event["auto_parent_call_id"] = json!("x");
                        event
                    })
                    .collect()
            },
        );
        assert_eq!(
            orphan.auto_order_problems.len(),
            1,
            "{:?}",
            orphan.auto_order_problems
        );
    }

    #[test]
    fn a_design_pack_record_missing_any_one_step_expands_to_nothing() {
        let _command = crate::group_guard::command_for_test("investigate");
        for index in 0..DESIGN_PACK_STEPS.len() {
            let summary = pack_run(|details, _| {
                details["steps"].as_array_mut().unwrap().remove(index);
            });
            assert!(pack_inner(&summary).is_empty(), "without step {index}");
            assert_eq!(summary.tool_calls, 1, "without step {index}");
        }
    }

    #[test]
    fn a_design_pack_that_did_not_finish_expands_to_nothing() {
        let _command = crate::group_guard::command_for_test("investigate");
        for (name, edit) in [
            (
                "stopped",
                Box::new(|d: &mut Value, _: &Path| d["status"] = json!("STOPPED"))
                    as Box<dyn FnOnce(&mut Value, &Path)>,
            ),
            (
                "first half",
                Box::new(|d, _| d["status"] = json!("FIRST_HALF_DONE")),
            ),
            (
                "no chain status",
                Box::new(|d, _| {
                    d.as_object_mut().unwrap().remove("chainStatus");
                }),
            ),
            (
                "chain stopped",
                Box::new(|d, _| d["chainStatus"] = json!("STOPPED")),
            ),
            (
                "a problem",
                Box::new(|d, _| d["problems"] = json!([{"step": "x", "message": "y"}])),
            ),
            (
                "no problems list",
                Box::new(|d, _| {
                    d.as_object_mut().unwrap().remove("problems");
                }),
            ),
            (
                "no qa ref",
                Box::new(|d, _| {
                    d["refs"]
                        .as_object_mut()
                        .unwrap()
                        .remove("publicationQaRef");
                }),
            ),
            (
                "no design pack flag",
                Box::new(|d, _| d["designPack"] = json!(false)),
            ),
            (
                "wrong chain name",
                Box::new(|d, _| d["chain"] = json!("newsroom_infographic_chain")),
            ),
        ] {
            let summary = pack_run(edit);
            assert!(pack_inner(&summary).is_empty(), "{name}");
        }
        assert!(
            pack_inner(&pack_run_with("newsroom_design_pack", true, |_, _| {})).is_empty(),
            "outer isError"
        );
    }

    #[test]
    fn a_design_pack_record_that_is_forged_or_inconsistent_expands_to_nothing() {
        let _command = crate::group_guard::command_for_test("investigate");
        let cases: Vec<(&str, Box<dyn FnOnce(&mut Value, &Path)>)> = vec![
            (
                "refs without steps",
                Box::new(|d, _| {
                    d.as_object_mut().unwrap().remove("steps");
                }),
            ),
            ("empty steps", Box::new(|d, _| d["steps"] = json!([]))),
            (
                "one step too many",
                Box::new(|d, _| {
                    let extra = d["steps"][7].clone();
                    d["steps"].as_array_mut().unwrap().push(extra);
                }),
            ),
            (
                "wrong tool name",
                Box::new(|d, _| d["steps"][3]["tool"] = json!("newsroom_viz_critic")),
            ),
            (
                "steps swapped",
                Box::new(|d, _| d["steps"].as_array_mut().unwrap().swap(5, 6)),
            ),
            (
                "params not an object",
                Box::new(|d, _| d["steps"][2]["params"] = json!("x")),
            ),
            (
                "details not an object",
                Box::new(|d, _| d["steps"][2]["details"] = json!([])),
            ),
            (
                "plan ref differs from the step's",
                Box::new(|d, _| {
                    d["refs"]["infographicPlanRef"] = json!("infographics/plans/other.json")
                }),
            ),
            (
                "qa ref differs from the step's",
                Box::new(|d, _| {
                    d["refs"]["publicationQaRef"] = json!("publications/qa/gggg/other.json")
                }),
            ),
            (
                "no lint ref in the lint step",
                Box::new(|d, _| {
                    d["steps"][1]["details"]
                        .as_object_mut()
                        .unwrap()
                        .remove("lintRef");
                }),
            ),
            (
                "no asset plan ref",
                Box::new(|d, _| {
                    d["refs"].as_object_mut().unwrap().remove("assetPlanRef");
                }),
            ),
        ];
        for (name, edit) in cases {
            assert!(pack_inner(&pack_run(edit)).is_empty(), "{name}");
        }
    }

    #[test]
    fn a_design_pack_ref_that_is_not_a_file_under_the_run_expands_to_nothing_even_when_one_is_fine()
    {
        let _command = crate::group_guard::command_for_test("investigate");
        // each case breaks exactly one ref (in the step and in refs, so only the file check can catch it); the other nine stay good
        let set = |details: &mut Value, step: usize, field: &str, key: &str, value: &str| {
            details["steps"][step]["details"][field] = json!(value);
            details["refs"][key] = json!(value);
        };
        let cases: Vec<(&str, Box<dyn FnOnce(&mut Value, &Path)>)> = vec![
            (
                "outside the folder",
                Box::new(move |d, _| {
                    set(
                        d,
                        0,
                        "planRef",
                        "infographicPlanRef",
                        "../infographics/plans/bbbb.json",
                    )
                }),
            ),
            (
                "dot dot inside",
                Box::new(move |d, _| {
                    set(
                        d,
                        0,
                        "planRef",
                        "infographicPlanRef",
                        "infographics/x/../plans/bbbb.json",
                    )
                }),
            ),
            (
                "absolute",
                Box::new(move |d, _| set(d, 0, "planRef", "infographicPlanRef", "/etc/hosts")),
            ),
            (
                "wrong prefix",
                Box::new(move |d, _| {
                    set(
                        d,
                        4,
                        "previewRef",
                        "previewRef",
                        "publications/plans/ffff.json",
                    )
                }),
            ),
            (
                "missing file",
                Box::new(move |d, _| {
                    set(
                        d,
                        3,
                        "criticRef",
                        "infographicCriticRef",
                        "infographics/critics/none.json",
                    )
                }),
            ),
            (
                "a folder, not a file",
                Box::new(move |d, root| {
                    fs::create_dir_all(root.join("infographics/critics/dir.json")).unwrap();
                    set(
                        d,
                        3,
                        "criticRef",
                        "infographicCriticRef",
                        "infographics/critics/dir.json",
                    );
                }),
            ),
            (
                "the asset plan is another category",
                Box::new(|d, _| d["refs"]["assetPlanRef"] = json!("infographics/plans/bbbb.json")),
            ),
            (
                "preview of another kind",
                Box::new(|d, root| {
                    write_pack_file(
                        root,
                        d["refs"]["previewRef"].as_str().unwrap(),
                        br#"{"kind":"other"}"#,
                    )
                }),
            ),
            (
                "critic points at another plan",
                Box::new(|d, root| {
                    write_pack_file(root, d["refs"]["infographicCriticRef"].as_str().unwrap(), br#"{"plan_ref":"infographics/plans/zzzz.json","lint_ref":"infographics/lints/ffff0.json","manifest_ref":"infographics/cccc.json"}"#)
                }),
            ),
            (
                "publication plan points at another page plan",
                Box::new(|d, root| {
                    write_pack_file(
                        root,
                        d["refs"]["publicationPlanRef"].as_str().unwrap(),
                        br#"{"infographic_plan_ref":"infographics/plans/zzzz.json"}"#,
                    )
                }),
            ),
            (
                "a file that is not JSON",
                Box::new(|d, root| {
                    write_pack_file(
                        root,
                        d["refs"]["infographicManifestRef"].as_str().unwrap(),
                        b"not json",
                    )
                }),
            ),
        ];
        for (name, edit) in cases {
            assert!(pack_inner(&pack_run(edit)).is_empty(), "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_design_pack_ref_through_a_link_out_of_the_run_expands_to_nothing() {
        let _command = crate::group_guard::command_for_test("investigate");
        let summary = pack_run(|d, root| {
            let outside = root.with_file_name(format!(
                "{}-outside.json",
                root.file_name().unwrap().to_string_lossy()
            ));
            fs::write(&outside, br#"{"kind":"infographic_plan"}"#).unwrap();
            let plan = root.join(d["refs"]["infographicPlanRef"].as_str().unwrap());
            fs::remove_file(&plan).unwrap();
            std::os::unix::fs::symlink(&outside, &plan).unwrap();
        });
        assert!(pack_inner(&summary).is_empty());
    }

    #[test]
    fn a_design_pack_pass_is_the_report_on_disk_for_those_html_bytes() {
        let _command = crate::group_guard::command_for_test("investigate");
        // the details say passed; the disk is what counts
        use sha2::{Digest, Sha256};
        let right_hash = format!("{:x}", Sha256::digest(PACK_HTML));
        for (name, report) in [
            (
                "FAIL",
                serde_json::to_vec(&json!({"status": "FAIL", "html_sha256": right_hash})).unwrap(),
            ),
            (
                "no status",
                serde_json::to_vec(&json!({"html_sha256": right_hash})).unwrap(),
            ),
            (
                "passed false in the old shape",
                br#"{"passed":false,"judged":false}"#.to_vec(),
            ),
        ] {
            let summary = pack_run(|d, root| {
                write_pack_file(
                    root,
                    d["refs"]["publicationQaRef"].as_str().unwrap(),
                    &report,
                )
            });
            assert!(pack_inner(&summary).is_empty(), "{name}");
        }
        // a PASS for other bytes than the page on disk
        let summary = pack_run(|d, root| {
            write_pack_file(
                root,
                d["refs"]["publicationHtmlRef"].as_str().unwrap(),
                b"<html>another page</html>",
            )
        });
        assert!(
            pack_inner(&summary).is_empty(),
            "html changed after the report"
        );
        // file names are not content hashes in this runtime, so a name that is not the bytes' hash is fine
        assert_eq!(pack_inner(&pack_run(|_, _| {})).len(), 8);
    }

    #[test]
    fn a_design_pack_page_plan_must_name_the_asset_plan_the_pack_reports() {
        let _command = crate::group_guard::command_for_test("investigate");
        // an unrelated plan that also says CONTINUE, on disk under another name
        let other = "editorial/assets/ffff0000.json";
        let summary = pack_run(|d, root| {
            write_pack_file(
                root,
                other,
                br#"{"kind":"editorial_asset_plan","decision":"CONTINUE","requirements":[{"available":true,"source_refs":["maps/basemaps/world.json"]}]}"#,
            );
            d["refs"]["assetPlanRef"] = json!(other);
        });
        assert!(
            pack_inner(&summary).is_empty(),
            "reported plan is not the page plan's"
        );
        for editorial in [
            json!({}),
            json!({"asset_plan_ref": null}),
            json!({"asset_plan_ref": other}),
        ] {
            let summary = pack_run(|d, root| {
                let plan = pack_ref(d, "infographicPlanRef");
                write_pack_file(
                    root,
                    &plan,
                    serde_json::to_vec(
                        &json!({"kind": "infographic_plan", "editorial": editorial}),
                    )
                    .unwrap()
                    .as_slice(),
                );
            });
            assert!(pack_inner(&summary).is_empty(), "{editorial}");
        }
        assert_eq!(pack_inner(&pack_run(|_, _| {})).len(), 8);
    }

    #[test]
    fn a_design_pack_asset_plan_must_say_continue() {
        let _command = crate::group_guard::command_for_test("investigate");
        for decision in ["REVISE", "RESEARCH_MORE", ""] {
            let summary = pack_run(|d, root| {
                write_pack_file(
                    root,
                    d["refs"]["assetPlanRef"].as_str().unwrap(),
                    serde_json::to_vec(
                        &json!({"kind": "editorial_asset_plan", "decision": decision, "requirements": [{"available": true, "source_refs": ["maps/basemaps/world.json"]}]}),
                    )
                    .unwrap()
                    .as_slice(),
                );
            });
            assert!(pack_inner(&summary).is_empty(), "{decision:?}");
        }
        let summary = pack_run(|d, root| {
            write_pack_file(
                root,
                d["refs"]["assetPlanRef"].as_str().unwrap(),
                br#"{"kind":"editorial_asset_plan","requirements":[{"available":true,"source_refs":["maps/basemaps/world.json"]}]}"#,
            )
        });
        assert!(pack_inner(&summary).is_empty(), "no decision");
    }

    /// The asset plan of a recorded run lists the published map base and the coordinates as available, citing a
    /// visualization artifact (derived from the run's own data) as their only `source_refs`: a circular plan. The pack must not expand on it.
    const CIRCULAR_ASSET_PLAN: &str =
        include_str!("../fixtures/design_pack/asset-plan-circular-source.json");

    #[test]
    fn a_circular_asset_plan_citing_the_pages_own_files_does_not_let_the_pack_expand() {
        let _command = crate::group_guard::command_for_test("investigate");
        let plan: Value = serde_json::from_str(CIRCULAR_ASSET_PLAN).unwrap();
        // the recorded plan, with its text fields in English: citing a visualization, available, decision CONTINUE
        assert_eq!(plan["kind"], "editorial_asset_plan");
        assert_eq!(plan["decision"], "CONTINUE");
        assert!(plan["requirements"]
            .as_array()
            .unwrap()
            .iter()
            .all(|requirement| requirement["available"] == true
                && requirement["source_refs"][0]
                    .as_str()
                    .unwrap()
                    .starts_with("visualizations/")));
        let summary = pack_run(|details, root| {
            write_pack_file(
                root,
                details["refs"]["assetPlanRef"].as_str().unwrap(),
                CIRCULAR_ASSET_PLAN.as_bytes(),
            );
        });
        assert!(pack_inner(&summary).is_empty());
    }

    fn rewrite_pack_json(root: &Path, reference: &str, edit: impl FnOnce(&mut Value)) {
        let mut value: Value =
            serde_json::from_slice(&fs::read(root.join(reference)).unwrap()).unwrap();
        edit(&mut value);
        write_pack_file(root, reference, &serde_json::to_vec(&value).unwrap());
    }

    #[test]
    fn the_asset_source_rule_matches_the_shared_probes() {
        let table: Value = serde_json::from_str(ASSET_SOURCE_PREFIXES).unwrap();
        let probes = table["probes"].as_object().unwrap();
        assert!(probes.len() >= 15);
        for (path, verdict) in probes {
            assert_eq!(
                asset_source_verdict(path),
                verdict.as_str().unwrap(),
                "{path}"
            );
        }
    }

    #[test]
    fn the_asset_source_rule_follows_every_row_of_the_shared_sample() {
        let table: Value = serde_json::from_str(ASSET_SOURCE_PREFIXES).unwrap();
        let own = table["own_page"].as_array().unwrap();
        let accepted = table["accepted_folders"].as_array().unwrap();
        assert!(own.len() >= 8 && accepted.len() >= 2);
        for entry in own {
            let prefix = entry["prefix"].as_str().unwrap();
            // a file in the prefix is the page's own, unless it sits directly in the except folder as <name>.json
            assert_eq!(
                asset_source_verdict(&format!("{prefix}zz-none.bin")),
                "own_page",
                "{prefix}"
            );
            assert_eq!(
                asset_source_verdict(&format!("{prefix}deep/zz-none.json")),
                "own_page",
                "{prefix}"
            );
            if let Some(except) = entry["except_folder"].as_str() {
                // the rule checks accepted folders first, so an except folder the sample does not accept would be unreachable
                assert!(
                    accepted
                        .iter()
                        .any(|row| row["folder"].as_str() == Some(except)),
                    "{except} is not in accepted_folders"
                );
                assert_eq!(
                    asset_source_verdict(&format!("{except}zz-none.json")),
                    "accepted_folder",
                    "{except}"
                );
                assert_eq!(
                    asset_source_verdict(&format!("{except}zz-none.svg")),
                    "own_page",
                    "{except}"
                );
                assert_eq!(
                    asset_source_verdict(&format!("{except}sub/zz-none.json")),
                    "own_page",
                    "{except}"
                );
            }
        }
        for entry in accepted {
            let folder = entry["folder"].as_str().unwrap();
            assert_eq!(
                asset_source_verdict(&format!("{folder}zz-none.json")),
                "accepted_folder",
                "{folder}"
            );
        }
        // nothing outside the sample is read as the page's own: the first path part is not one of its prefixes
        let prefixes: Vec<&str> = own
            .iter()
            .map(|entry| entry["prefix"].as_str().unwrap())
            .collect();
        for path in [
            "runtime/zz-none.json",
            "zz-none.json",
            "Maps/zz-none.json",
            "notes/data/zz-none.json",
            "mapsx/zz-none.json",
        ] {
            assert!(!prefixes.iter().any(|prefix| path.starts_with(prefix)));
            assert_eq!(asset_source_verdict(path), "unknown", "{path}");
        }
    }

    #[test]
    fn an_available_asset_may_not_cite_the_pages_own_files() {
        let _command = crate::group_guard::command_for_test("investigate");
        let cases = [
            (
                json!([{"available": true, "source_refs": ["infographics/plans/x.json"]}]),
                false,
            ),
            (
                json!([{"available": true, "source_refs": ["maps/basemaps/a.json", "publications/x/index.html"]}]),
                false,
            ),
            (
                json!([{"available": true, "source_refs": ["visualizations/abc.json"]}]),
                false,
            ),
            (
                json!([{"available": true, "source_refs": ["maps/basemaps/a.json", "visualizations/illustrations/b.json"]}]),
                true,
            ),
            // not available: nothing is cited, whatever it lists
            (
                json!([{"available": false, "source_refs": ["infographics/x.json"]}, {"available": true, "source_refs": ["maps/basemaps/a.json"]}]),
                true,
            ),
            // malformed: no expansion
            (json!([{"available": true}]), false),
            (json!([{"available": true, "source_refs": []}]), false),
            (
                json!([{"available": true, "source_refs": "maps/basemaps/a.json"}]),
                false,
            ),
            (json!([{"available": true, "source_refs": [7]}]), false),
            (json!([{"available": true, "source_refs": [""]}]), false),
            (json!({"available": true}), false),
            // `available` missing or not a boolean is malformed too, even beside a good one
            (json!([{"source_refs": ["maps/basemaps/a.json"]}]), false),
            (
                json!([{"available": "true", "source_refs": ["maps/basemaps/a.json"]}]),
                false,
            ),
            (
                json!([{"available": 1, "source_refs": ["maps/basemaps/a.json"]}]),
                false,
            ),
            (
                json!([{"available": null, "source_refs": ["maps/basemaps/a.json"]}]),
                false,
            ),
            (
                json!([{"available": true, "source_refs": ["maps/basemaps/a.json"]}, {"available": "no"}]),
                false,
            ),
        ];
        for (requirements, expands) in cases {
            let summary = pack_run(|d, root| {
                write_pack_file(
                    root,
                    d["refs"]["assetPlanRef"].as_str().unwrap(),
                    serde_json::to_vec(&json!({"kind": "editorial_asset_plan", "decision": "CONTINUE", "requirements": requirements}))
                        .unwrap()
                        .as_slice(),
                );
            });
            assert_eq!(
                pack_inner(&summary).len(),
                if expands { 8 } else { 0 },
                "{requirements}"
            );
        }
        let missing = pack_run(|d, root| {
            write_pack_file(
                root,
                d["refs"]["assetPlanRef"].as_str().unwrap(),
                br#"{"kind":"editorial_asset_plan","decision":"CONTINUE"}"#,
            );
        });
        assert!(pack_inner(&missing).is_empty(), "no requirements list");
    }

    #[test]
    fn lint_and_critic_must_say_passed() {
        let _command = crate::group_guard::command_for_test("investigate");
        for (key, step) in [("lintRef", 1), ("criticRef", 3)] {
            for passed in [json!(false), json!(null), json!("true")] {
                let summary = pack_run(|d, root| {
                    let reference = d["steps"][step]["details"][key]
                        .as_str()
                        .unwrap()
                        .to_string();
                    rewrite_pack_json(root, &reference, |v| v["passed"] = passed.clone());
                });
                assert!(pack_inner(&summary).is_empty(), "{key} {passed}");
            }
            let summary = pack_run(|d, root| {
                let reference = d["steps"][step]["details"][key]
                    .as_str()
                    .unwrap()
                    .to_string();
                rewrite_pack_json(root, &reference, |v| {
                    v.as_object_mut().unwrap().remove("passed");
                });
            });
            assert!(pack_inner(&summary).is_empty(), "{key} missing");
        }
    }

    #[test]
    fn the_infographic_manifest_sits_directly_under_infographics() {
        let _command = crate::group_guard::command_for_test("investigate");
        for folder in [
            "infographics/plans/",
            "infographics/lints/",
            "infographics/critics/",
            "infographics/previews/",
            "infographics/sub/deep/",
        ] {
            let moved = format!("{folder}cccc.json");
            let summary = pack_run(|d, root| {
                let old = pack_ref(d, "infographicManifestRef");
                let plan = pack_ref(d, "infographicPlanRef");
                let lint = d["steps"][1]["details"]["lintRef"]
                    .as_str()
                    .unwrap()
                    .to_string();
                write_pack_file(
                    root,
                    &moved,
                    &serde_json::to_vec(&json!({"plan_ref": plan, "lint_ref": lint})).unwrap(),
                );
                d["refs"]["infographicManifestRef"] = json!(moved);
                d["steps"][2]["details"]["manifestRef"] = json!(moved);
                for key in ["infographicCriticRef", "previewRef"] {
                    let reference = pack_ref(d, key);
                    rewrite_pack_json(root, &reference, |v| v["manifest_ref"] = json!(moved));
                }
                let _ = old;
            });
            assert!(pack_inner(&summary).is_empty(), "{folder}");
        }
    }

    #[test]
    fn the_publication_manifest_and_the_qa_name_the_same_html() {
        let _command = crate::group_guard::command_for_test("investigate");
        let wrong = json!("publications/zzzz/index.html");
        type Change<'a> = Box<dyn Fn(&mut Value) + 'a>;
        let cases: Vec<(&str, Change)> = vec![
            ("html_ref", Box::new(|v| v["html_ref"] = wrong.clone())),
            (
                "plan_ref",
                Box::new(|v| v["plan_ref"] = json!("publications/plans/other.json")),
            ),
            (
                "infographic_plan_ref",
                Box::new(|v| v["infographic_plan_ref"] = json!("infographics/plans/other.json")),
            ),
            ("html_sha256", Box::new(|v| v["html_sha256"] = json!("00"))),
            (
                "html_ref gone",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("html_ref");
                }),
            ),
            (
                "html_sha256 gone",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("html_sha256");
                }),
            ),
        ];
        for (name, change) in cases {
            let summary = pack_run(|d, root| {
                let reference = pack_ref(d, "publicationManifestRef");
                rewrite_pack_json(root, &reference, |v| change(v));
            });
            assert!(pack_inner(&summary).is_empty(), "{name}");
        }
        // a manifest in another publication folder than the HTML it names
        let summary = pack_run(|d, root| {
            let html = pack_ref(d, "publicationHtmlRef");
            let other = "publications/hhhh/manifest.json";
            let mut manifest: Value = serde_json::from_slice(
                &fs::read(root.join(pack_ref(d, "publicationManifestRef"))).unwrap(),
            )
            .unwrap();
            manifest["html_ref"] = json!(html);
            write_pack_file(root, other, &serde_json::to_vec(&manifest).unwrap());
            d["refs"]["publicationManifestRef"] = json!(other);
            d["steps"][6]["details"]["manifestRef"] = json!(other);
        });
        assert!(pack_inner(&summary).is_empty(), "other folder");
        // the QA report about other bytes
        let summary = pack_run(|d, root| {
            let reference = pack_ref(d, "publicationQaRef");
            rewrite_pack_json(root, &reference, |v| v["html_sha256"] = json!("00"));
        });
        assert!(pack_inner(&summary).is_empty(), "qa sha");
    }

    #[test]
    fn only_the_design_pack_tool_is_read_as_a_design_pack() {
        let _command = crate::group_guard::command_for_test("investigate");
        for tool in [
            "newsroom_viz_chain",
            "newsroom_infographic_chain",
            "newsroom_publication_qa",
            "newsroom_design_pack_draft",
            "some_other_tool",
        ] {
            let summary = pack_run_with(tool, false, |_, _| {});
            assert!(pack_inner(&summary).is_empty(), "{tool}");
        }
    }

    #[test]
    fn the_design_pack_expansion_leaves_the_group_tables_alone() {
        // The pack is an agent-group tool whose inner calls the runtime already runs under their own groups; the audit reads a record and files only.
        // The cross-calls table and the group of every file stay as they are (a line added to either changes the digest and turns this red).
        use sha2::{Digest, Sha256};
        let groups: Value =
            serde_json::from_str(include_str!("../runtime/pi/groups.json")).unwrap();
        let cross = serde_json::to_string(&groups["cross_calls"]).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(cross.as_bytes())),
            CROSS_CALLS_DIGEST
        );
        assert_eq!(
            groups["tools"]["newsroom_design_pack"]["registered_as"],
            "agent.design_pack"
        );
    }
}
