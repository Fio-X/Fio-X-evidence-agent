#!/usr/bin/env python3
"""Fixed, provider-free complex-visual benchmark for System One token-curve work."""

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path


GOAL = (
    "Create a complex visual report with a world map, a flow diagram, and a trend chart; "
    "deliver self-contained HTML plus desktop and mobile outputs."
)


def jsonl(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def artifact_bytes(root):
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())


def percentile(values, percent):
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * percent / 100
    lower, upper = int(index), min(int(index) + 1, len(ordered) - 1)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower), 2)


def run_once(binary, mock, output_root, index):
    run_root = output_root / f"run-{index}"
    run_root.mkdir()
    env = {
        **os.environ,
        "PERF_MOCK_MODE": "normal",
        "NEWSROOM_RPC_STARTUP_MS": "500",
        "NEWSROOM_RPC_IDLE_MS": "500",
        "NEWSROOM_RPC_FINISH_MS": "500",
        "NEWSROOM_RPC_TOTAL_MS": "3000",
        "NEWSROOM_RPC_HEARTBEAT_MS": "100",
    }
    stdout_path, stderr_path = run_root / "stdout.log", run_root / "stderr.log"
    started = time.monotonic()
    with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open("w", encoding="utf-8") as stderr:
        completed = subprocess.run(
            [str(binary), "investigate", "--out", str(run_root), "--pi-bin", str(mock), GOAL],
            env=env,
            stdout=stdout,
            stderr=stderr,
            timeout=15,
            check=False,
        )
    elapsed_ms = round((time.monotonic() - started) * 1000, 2)
    candidates = sorted(
        p for p in run_root.iterdir() if p.is_dir() and (p / "run-metrics.jsonl").exists()
    )
    artifact = candidates[-1] if candidates else None
    events = jsonl(artifact / "events.jsonl") if artifact else []
    metrics = jsonl(artifact / "run-metrics.jsonl") if artifact else []
    tools = json.loads((artifact / "tools.json").read_text(encoding="utf-8")) if artifact and (artifact / "tools.json").exists() else {}
    story = json.loads((artifact / "story.json").read_text(encoding="utf-8")) if artifact and (artifact / "story.json").exists() else {}
    rpc = [event for event in events if event.get("type") == "newsroom_rpc_metrics"]
    run_metric = metrics[-1] if metrics else {}
    pi_rpc = run_metric.get("pi_rpc", {})
    retry_count = sum(event.get("type") == "auto_retry_start" for event in events)
    qa = {
        "evidence": story.get("evidence_gate") or story.get("evidence_status") or "unavailable",
        "publication": story.get("publication_qa") or "unavailable",
        "visual": story.get("visual_qa") or "unavailable",
        "status": story.get("status", "unavailable"),
    }
    return {
        "run": index,
        "returncode": completed.returncode,
        "artifact_path": str(artifact) if artifact else None,
        "artifact_bytes_full": artifact_bytes(artifact) if artifact else None,
        "e2e_ms": elapsed_ms,
        "pi_rpc_count": pi_rpc.get("calls", len(rpc)),
        "prompt_bytes": pi_rpc.get("prompt_bytes_total"),
        "effective_tools": pi_rpc.get("tool_count_max"),
        "tool_profile": (pi_rpc.get("tool_profiles") or [None])[-1],
        "tool_schema_bytes": None,
        "model_visible_result_bytes": None,
        "model_visible_result_bytes_status": "unavailable: baseline emits no generic result-byte telemetry",
        "token_counters": {
            "input": pi_rpc.get("tokens_input_total"),
            "output": pi_rpc.get("tokens_output_total"),
            "status": "unavailable: deterministic mock reports zero counters",
        },
        "completion_retries": retry_count,
        "qa": qa,
        "metrics_source": str(artifact / "run-metrics.jsonl") if artifact else None,
        "event_source": str(artifact / "events.jsonl") if artifact else None,
        "raw_rpc_prompt_bytes": [event.get("prompt_bytes") for event in rpc],
        "raw_rpc_count": len(rpc),
        "raw_run_metric_duration_ms": run_metric.get("duration_ms"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=Path("target/release/news"))
    parser.add_argument("--mock", type=Path, default=Path("scripts/perf_mock_pi.py"))
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--output-dir", type=Path, default=None)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    binary, mock = args.binary.resolve(), args.mock.resolve()
    if not binary.is_file() or not mock.is_file():
        parser.error(f"missing benchmark input: binary={binary} mock={mock}")
    output_root = args.output_dir.resolve() if args.output_dir else Path(tempfile.mkdtemp(prefix="r4-01-token-benchmark-"))
    output_root.mkdir(parents=True, exist_ok=True)
    runs = [run_once(binary, mock, output_root, index) for index in range(1, args.runs + 1)]
    e2e = [run["e2e_ms"] for run in runs]
    summary = {
        "schema_version": "r4.0.0",
        "experiment": "r4-01-fixed-token-benchmark",
        "goal": GOAL,
        "provider_dependency": "none; scripts/perf_mock_pi.py only",
        "output_root": str(output_root),
        "runs": runs,
        "aggregate": {
            "run_count": len(runs),
            "median_e2e_ms": round(statistics.median(e2e), 2),
            "p95_e2e_ms": percentile(e2e, 95),
            "median_prompt_bytes": round(statistics.median([r["prompt_bytes"] for r in runs]), 2),
            "median_artifact_bytes_full": round(statistics.median([r["artifact_bytes_full"] for r in runs]), 2),
            "median_pi_rpc_count": round(statistics.median([r["pi_rpc_count"] for r in runs]), 2),
            "median_completion_retries": round(statistics.median([r["completion_retries"] for r in runs]), 2),
        },
        "unavailable_fields": ["model_visible_result_bytes", "tool_schema_bytes", "token_counters.input/output"],
        "replay_note": "Each run retains its complete artifact directory; benchmark output contains refs only.",
    }
    json_path = output_root / "summary.json"
    table_path = output_root / "summary.txt"
    json_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    columns = ["run", "returncode", "e2e_ms", "pi_rpc_count", "prompt_bytes", "artifact_bytes_full", "effective_tools", "completion_retries", "qa.status"]
    lines = ["\t".join(columns)]
    lines.extend("\t".join(str(run.get(column.split(".")[-1]) if "." not in column else run["qa"].get(column.split(".")[1])) for column in columns) for run in runs)
    lines.append("")
    lines.append(json.dumps(summary["aggregate"], sort_keys=True))
    table_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"summary_json": str(json_path), "summary_table": str(table_path), "aggregate": summary["aggregate"]}, sort_keys=True))
    return 0 if all(run["returncode"] != 127 for run in runs) else 1


if __name__ == "__main__":
    sys.exit(main())
