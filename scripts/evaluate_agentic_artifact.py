#!/usr/bin/env python3
"""Evaluate causal agent behavior without requiring a preset tool/workflow path."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

from verify_artifact import system_verified_claim

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = json.loads((ROOT / "config" / "tool-registry.json").read_text(encoding="utf-8"))
CAPABILITY = {
    row["name"]: row["capability_class"]
    for row in REGISTRY["tools"]
    if row["capability_class"] not in {"planning", "meta"}
}

def git_commit():
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return None


def load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def jsonl(path: Path):
    rows = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    except Exception:
        pass
    return rows


def flatten_numeric(value, prefix=""):
    out = {}
    if isinstance(value, dict):
        for key, child in value.items():
            name = f"{prefix}.{key}" if prefix else str(key)
            out.update(flatten_numeric(child, name))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            out.update(flatten_numeric(child, f"{prefix}[{index}]"))
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        out[prefix] = value
    return out


def usage_number(metrics: dict, suffix: str):
    suffix = suffix.lower()
    exact = []
    fallback = []
    for key, value in metrics.items():
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            continue
        lower = key.lower()
        if lower == suffix:
            exact.append(value)
        elif lower.endswith("." + suffix):
            fallback.append(value)
    values = exact or fallback
    return values[0] if values else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("artifact", type=Path)
    ap.add_argument("--provider", default=os.environ.get("NEWSROOM_PROVIDER"))
    ap.add_argument("--model", default=os.environ.get("NEWSROOM_MODEL"))
    ap.add_argument("--scenario", default=os.environ.get("NEWSROOM_AGENTIC_SCENARIO_ID"))
    args = ap.parse_args()
    root = args.artifact

    story = load(root / "story.json", {})
    tools = load(root / "tools.json", {})
    plan = load(root / "plan.json", {})
    claims = jsonl(root / "claims.jsonl")
    metrics = jsonl(root / "run-metrics.jsonl")
    session_stats = load(root / "session-stats.json", {})

    autonomy = story.get("autonomy") or {}
    counts = tools.get("tools") or {}
    classes = {
        CAPABILITY[name]
        for name, count in counts.items()
        if count and name in CAPABILITY
    }
    verified_claims = [claim for claim in claims if system_verified_claim(claim)]
    verified = [
        claim
        for claim in verified_claims
        if claim.get("source_refs")
        and claim.get("computation_refs")
    ]
    unsupported_verified = [
        claim
        for claim in verified_claims
        if not claim.get("source_refs") or not claim.get("computation_refs")
    ]

    checks = {
        "persistent_session": autonomy.get("persistent_session") is True,
        "same_session_follow_up": autonomy.get("multi_turn_context") is True
        and autonomy.get("session_resumed") is True,
        "contextual_follow_up_replanning": autonomy.get("follow_up_replanning_observed") is True,
        "observable_plan": autonomy.get("observable_planning") is True
        and bool(plan.get("steps")),
        "causal_autonomous_execution": autonomy.get("autonomous_execution_observed") is True
        and autonomy.get("agent_loop_observed") is True,
        "adaptive_replanning": autonomy.get("adaptive_replanning_observed") is True,
        "hidden_tool_failure_recovery": autonomy.get("tool_failure_recovery_observed") is True,
        "multiple_capability_classes": len(classes) >= 2,
        "verified_source_and_computation_claim": len(verified) >= 1,
        "unsupported_verified_claims_zero": len(unsupported_verified) == 0,
    }
    passed = all(checks.values())
    usage_numbers = flatten_numeric(session_stats)
    usage_metrics = {
        key: value
        for key, value in usage_numbers.items()
        if any(token in key.lower() for token in ("token", "cost", "cache", "usage"))
    }
    fresh_input_tokens = usage_number(usage_numbers, "tokens.input")
    output_tokens = usage_number(usage_numbers, "tokens.output")
    cache_read_tokens = usage_number(usage_numbers, "tokens.cacheread")
    cache_write_tokens = usage_number(usage_numbers, "tokens.cachewrite")
    reported_cost = usage_number(usage_numbers, "cost")
    fresh_tokens = (
        fresh_input_tokens + output_tokens
        if fresh_input_tokens is not None and output_tokens is not None
        else None
    )
    usage_accounting = {
        "fresh_input_tokens": fresh_input_tokens,
        "output_tokens": output_tokens,
        "fresh_tokens": fresh_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_write_tokens": cache_write_tokens,
        "reported_cost": reported_cost,
        "cost_available": reported_cost is not None,
    }

    result = {
        "schema_version": "1.2.0",
        "qualification_type": "agentic",
        "scenario_id": args.scenario,
        "source_commit": git_commit(),
        "status": "PASS" if passed else "FAIL",
        "passed": passed,
        "provider": args.provider,
        "model": args.model,
        "artifact_id": story.get("id") or root.name,
        "checks": checks,
        "passed_checks": sum(checks.values()),
        "total_checks": len(checks),
        "capability_classes": sorted(classes),
        "verified_source_and_computation_claims": len(verified),
        "unsupported_verified_claims": len(unsupported_verified),
        "user_messages": autonomy.get("user_messages", 0),
        "turns": autonomy.get("turns", 0),
        "tool_calls": autonomy.get("tool_calls", 0),
        "capability_tool_calls": autonomy.get("capability_tool_calls", 0),
        "successful_capability_tool_calls": autonomy.get("successful_capability_tool_calls", 0),
        "distinct_capability_classes": autonomy.get("distinct_capability_classes", len(classes)),
        "distinct_tools": autonomy.get("distinct_tools", 0),
        "plan_revisions": autonomy.get("plan_revisions", 0),
        "failed_tool_calls": autonomy.get("failed_tool_calls", tools.get("failed_tool_calls", 0)),
        "automatic_retries": autonomy.get("automatic_retries", 0),
        "provider_failed_turns": autonomy.get("provider_failed_turns", 0),
        "provider_auto_retries": autonomy.get("provider_auto_retries", 0),
        "provider_retry_max_attempt": autonomy.get("provider_retry_max_attempt", 0),
        "provider_retry_delay_ms_total": autonomy.get("provider_retry_delay_ms_total", 0),
        "provider_failure_observed": autonomy.get("provider_failure_observed", False),
        "provider_error_classes": autonomy.get("provider_error_classes", {}),
        "agent_wall_ms_total": sum(int(row.get("duration_ms", 0) or 0) for row in metrics),
        "run_metrics": metrics,
        "usage_metrics": usage_metrics,
        "usage_accounting": usage_accounting,
    }
    (root / "agentic-qualification.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    for name, ok in checks.items():
        print(f"{'PASS' if ok else 'MISS':4}  {name}")
    print(f"agentic gate: {result['passed_checks']}/{result['total_checks']}")
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
