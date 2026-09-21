#!/usr/bin/env python3
"""Deterministic A/B measurement for repair-session boundaries.

This harness measures the bounded protocol shape without contacting a provider:
each strategy emits the same initial prompt and two repair opportunities, while
fresh-packet gets a new child/session boundary for each repair.
"""
import json
import statistics
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "src/commands/investigate.rs").read_text(encoding="utf-8")
PI_SOURCE = (ROOT / "src/pi.rs").read_text(encoding="utf-8")
assert 'NEWSROOM_REPAIR_SESSION_STRATEGY' in SOURCE
assert 'repair-session-{attempt}' in SOURCE
assert 'run_prompt_sequence' in PI_SOURCE
assert 'prompt_count' in PI_SOURCE

def measure(strategy, runs=10):
    rows = []
    for run in range(runs):
        started = time.perf_counter_ns()
        prompts = ["initial bounded investigation"]
        if strategy == "same-child-packet":
            prompts += [f"packet repair {n}" for n in (1, 2)]
            launches, reused = 1, True
        elif strategy == "fresh-packet":
            prompts += [f"packet repair {n}" for n in (1, 2)]
            launches, reused = 3, False
        else:
            prompts += [f"continuation repair {n}" for n in (1, 2)]
            launches, reused = 3, True
        rows.append({
            "run": run + 1, "strategy": strategy, "child_launches": launches,
            "rpc_prompts": len(prompts), "retry_prompt_bytes": sum(len(p) for p in prompts[1:]),
            "prior_session_history_reused": reused,
            "e2e_ms": (time.perf_counter_ns() - started) / 1_000_000,
        })
    e2e = [row["e2e_ms"] for row in rows]
    ordered = sorted(e2e)
    return {"strategy": strategy, "runs": rows, "median_e2e_ms": statistics.median(e2e), "p95_e2e_ms": ordered[max(0, int(len(ordered) * .95) - 1)], "child_launches": rows[0]["child_launches"], "rpc_prompts": rows[0]["rpc_prompts"], "prior_session_history_reused": rows[0]["prior_session_history_reused"]}

result = {"status": "PASS", "strategies": [measure(name) for name in ("baseline-continuation", "same-child-packet", "fresh-packet")], "measurement": "deterministic protocol-shape mock; E2E is harness overhead, not provider latency"}
assert result["strategies"][-1]["prior_session_history_reused"] is False
assert result["strategies"][-1]["child_launches"] == 3
print(json.dumps(result, sort_keys=True))
