#!/usr/bin/env python3
"""Measure the opt-in sparse checkpoint controller against the unchanged path."""
import argparse
import json
import os
import statistics
import subprocess
import tempfile
from pathlib import Path


def run_case(binary: Path, enabled: bool) -> dict:
    env = os.environ.copy()
    env.update({
        "NEWSROOM_RPC_STARTUP_MS": "1000",
        "NEWSROOM_RPC_IDLE_MS": "1000",
        "NEWSROOM_RPC_FINISH_MS": "1000",
        "NEWSROOM_RPC_TOTAL_MS": "5000",
    })
    if enabled:
        env["NEWSROOM_SPARSE_CHECKPOINTS"] = "1"
    else:
        env.pop("NEWSROOM_SPARSE_CHECKPOINTS", None)
    with tempfile.TemporaryDirectory(prefix="newsroom-sparse-checkpoint-") as output:
        completed = subprocess.run(
            [str(binary), "investigate", "--out", output, "--pi-bin",
             str(binary.parent.parent.parent / "scripts" / "perf_mock_pi.py"),
             "fixed checkpoint measurement"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=10,
        )
        if completed.returncode != 0:
            raise AssertionError(f"mock investigation failed: {completed.returncode}")
        artifacts = list(Path(output).iterdir())
        if len(artifacts) != 1:
            raise AssertionError(f"expected one artifact directory, got {len(artifacts)}")
        artifact = artifacts[0]
        events = [json.loads(line) for line in (artifact / "events.jsonl").read_text().splitlines()]
        metrics = [event for event in events if event.get("type") == "newsroom_rpc_metrics"]
        run_metric = json.loads((artifact / "run-metrics.jsonl").read_text().splitlines()[-1])
        checkpoints = [event for event in events if event.get("type") == "newsroom_macro_checkpoint"]
        return {
            "checkpoint_enabled": enabled,
            "checkpoint_names": [event["checkpoint"] for event in checkpoints],
            "checkpoint_passed": [event["passed"] for event in checkpoints],
            "rpc_count": len(metrics),
            "prompt_bytes": metrics[0]["prompt_bytes"],
            "retries": metrics[0]["prompt_attempts"] - 1,
            "e2e_ms": run_metric["duration_ms"],
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", nargs="?", default="target/release/news")
    args = parser.parse_args()
    binary = Path(args.binary).resolve()
    baseline = [run_case(binary, False) for _ in range(3)]
    variant = [run_case(binary, True) for _ in range(3)]
    assert all(not row["checkpoint_names"] for row in baseline)
    assert all(row["checkpoint_names"] == ["RESEARCH", "DESIGN", "PUBLISH"] for row in variant)
    assert all(row["checkpoint_passed"] == [True, True, True] for row in variant)
    assert all(row["rpc_count"] == 1 for row in baseline + variant)
    assert all(row["retries"] == 0 for row in baseline + variant)
    result = {
        "status": "PASS",
        "baseline": {
            "rpc_count": statistics.median(row["rpc_count"] for row in baseline),
            "prompt_bytes": statistics.median(row["prompt_bytes"] for row in baseline),
            "retries": statistics.median(row["retries"] for row in baseline),
            "e2e_ms": statistics.median(row["e2e_ms"] for row in baseline),
        },
        "variant": {
            "rpc_count": statistics.median(row["rpc_count"] for row in variant),
            "prompt_bytes": statistics.median(row["prompt_bytes"] for row in variant),
            "retries": statistics.median(row["retries"] for row in variant),
            "e2e_ms": statistics.median(row["e2e_ms"] for row in variant),
            "checkpoint_names": variant[0]["checkpoint_names"],
        },
    }
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
