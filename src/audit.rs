use crate::tool_registry::{capability_class, is_capability_class};
use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct AuditSummary {
    pub schema_version: &'static str,
    pub generated_at: String,
    pub turns: usize,
    pub tool_calls: usize,
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
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_path)
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
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_path)
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
                calls.push(ToolCall {
                    id,
                    tool,
                    args,
                    is_error: event.get("isError").and_then(Value::as_bool),
                    start_seq,
                    end_seq: sequence,
                    capability_class: class,
                });
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
    fs::write(output_path, format!("{json}\n"))
        .with_context(|| format!("failed to write audit: {}", output_path.display()))?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let mut events = call("p1", "newsroom_update_plan", false);
        events.push(json!({"type":"turn_end"}));
        let summary = build_fixture(events);
        assert!(!summary.autonomous_execution_observed);
        assert!(!summary.adaptive_replanning_observed);
        assert_eq!(summary.capability_tool_calls, 0);
    }

    #[test]
    fn plan_capability_observation_then_completion_is_autonomous() {
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
}
