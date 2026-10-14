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

#[derive(Debug, Clone, Serialize)]
pub struct AuditSummary {
    pub schema_version: &'static str,
    pub generated_at: String,
    pub turns: usize,
    pub tool_calls: usize,
    /// Calls the model itself made (`tool_calls` minus the expanded chain steps).
    pub outer_tool_calls: usize,
    /// Steps executed inside a chain call and expanded from its result.
    pub inner_tool_calls: usize,
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
/// inner calls at all: an incomplete record is never partly believed.
fn chain_inner_calls(
    outer_tool: &str,
    outer_id: &str,
    event: &Value,
    start_seq: usize,
    end_seq: usize,
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
        });
    }
    inner
}

impl AuditSummary {
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
                let inner = chain_inner_calls(&tool, &id, &event, start_seq, sequence);
                calls.push(ToolCall {
                    id,
                    tool,
                    args,
                    is_error: event.get("isError").and_then(Value::as_bool),
                    start_seq,
                    end_seq: sequence,
                    capability_class: class,
                    parent_call_id: None,
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
        });
    }
    calls.sort_by_key(|call| (call.start_seq, call.end_seq));

    let mut tools = BTreeMap::new();
    let mut capability_classes = BTreeMap::new();
    let mut failed = 0usize;
    let mut plan_revisions = 0usize;
    let mut successful_plan_calls = 0usize;
    let mut capability_tool_calls = 0usize;
    let mut successful_capability_tool_calls = 0usize;

    for call in &calls {
        *tools.entry(call.tool.clone()).or_insert(0usize) += 1;
        if call.is_error == Some(true) {
            failed += 1;
        }
        if call.tool == "newsroom_update_plan" {
            plan_revisions += 1;
            if call.is_error == Some(false) {
                successful_plan_calls += 1;
            }
        }
        if is_capability_class(call.capability_class) {
            capability_tool_calls += 1;
            if let Some(class) = call.capability_class {
                *capability_classes
                    .entry(class.to_string())
                    .or_insert(0usize) += 1;
            }
            if call.is_error == Some(false) {
                successful_capability_tool_calls += 1;
            }
        }
    }

    let successful_plans: Vec<&ToolCall> = calls
        .iter()
        .filter(|call| call.tool == "newsroom_update_plan" && call.is_error == Some(false))
        .collect();
    let successful_capabilities: Vec<&ToolCall> = calls
        .iter()
        .filter(|call| is_capability_class(call.capability_class) && call.is_error == Some(false))
        .collect();

    let autonomous_execution_observed = successful_plans.iter().any(|plan| {
        successful_capabilities.iter().any(|capability| {
            if capability.start_seq <= plan.end_seq {
                return false;
            }
            let later_tool_decision = calls.iter().any(|next| next.start_seq > capability.end_seq);
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
}
