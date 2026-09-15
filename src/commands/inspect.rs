use crate::artifact::InvestigationBundle;
use crate::audit;
use crate::cli::InspectArgs;
use anyhow::Result;
use serde_json::Value;
use std::fs;

pub async fn run(args: InspectArgs) -> Result<()> {
    let bundle = InvestigationBundle::open(&args.artifact)?;
    let audit = audit::build(&bundle.events_path, &bundle.tools_path)?;
    let story: Value = serde_json::from_str(&fs::read_to_string(&bundle.manifest_path)?)?;
    let user_messages = story
        .pointer("/autonomy/user_messages")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    println!("investigation  {}", bundle.id);
    println!("user messages  {user_messages}");
    println!("agent turns    {}", audit.turns);
    println!("plan revisions {}", audit.plan_revisions);
    println!("tool calls      {}", audit.tool_calls);
    println!("capability calls {}", audit.capability_tool_calls);
    println!(
        "successful capability calls {}",
        audit.successful_capability_tool_calls
    );
    println!("capability classes {}", audit.distinct_capability_classes);
    println!("tool failures    {}", audit.failed_tool_calls);
    println!("auto retries     {}", audit.automatic_retries);
    println!(
        "autonomous loop  {}",
        if audit.autonomous_execution_observed {
            "observed"
        } else {
            "insufficient evidence"
        }
    );
    println!(
        "adaptive replan  {}",
        if audit.adaptive_replanning_observed {
            "observed"
        } else {
            "not observed"
        }
    );
    println!(
        "failure recovery {}",
        if audit.tool_failure_recovery_observed {
            "observed"
        } else {
            "not observed"
        }
    );
    println!(
        "follow-up replan {}",
        if audit.follow_up_replanning_observed {
            "observed"
        } else {
            "not observed"
        }
    );
    if let Ok(text) = fs::read_to_string(&bundle.run_metrics_path) {
        let durations: Vec<u64> = text
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|value| value.get("duration_ms").and_then(Value::as_u64))
            .collect();
        if !durations.is_empty() {
            let total: u64 = durations.iter().sum();
            println!("agent runs       {}", durations.len());
            println!("agent wall ms    {total}");
            println!(
                "latest run ms    {}",
                durations.last().copied().unwrap_or(0)
            );
        }
    }
    for (label, pointer) in [
        ("source snapshots", "/evidence/sources"),
        ("datasets", "/evidence/datasets"),
        ("computations", "/evidence/computations"),
        ("claims", "/evidence/claims"),
        ("visualizations", "/evidence/visualizations"),
    ] {
        let count = story
            .pointer(pointer)
            .and_then(Value::as_array)
            .map(|v| v.len())
            .unwrap_or(0);
        println!("{label:16} {count}");
    }
    if !audit.tools.is_empty() {
        println!("tools:");
        for (name, count) in &audit.tools {
            println!("  {name:24} {count}");
        }
    }
    println!("audit file      {}", bundle.tools_path.display());
    println!("plan file       {}", bundle.plan_path.display());
    println!("story file      {}", bundle.manifest_path.display());
    Ok(())
}
