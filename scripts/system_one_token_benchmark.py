#!/usr/bin/env python3
"""Provider-free repeated observability benchmark; retains only non-sensitive summaries."""
import argparse, json, statistics, subprocess, tempfile, time
from pathlib import Path

def jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []

def run_once(binary, mock, root, index):
    root.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    subprocess.run([str(binary), "investigate", "--out", str(root), "--pi-bin", str(mock), "observability fixture"],
                   capture_output=True, text=True, timeout=15, check=False)
    artifacts = sorted(p for p in root.iterdir() if p.is_dir() and (p / "run-metrics.jsonl").exists())
    artifact = artifacts[-1] if artifacts else None
    metrics = jsonl(artifact / "run-metrics.jsonl") if artifact else []
    run = metrics[-1] if metrics else {}
    rpc = run.get("pi_rpc", {})
    return {"run": index, "e2e_ms": round((time.monotonic() - started) * 1000, 2),
            "rpc_calls": rpc.get("calls"), "prompt_bytes": rpc.get("prompt_bytes_total"),
            "tool_result_bytes": rpc.get("tool_result_bytes_total"), "artifact_bytes": rpc.get("tool_result_artifact_bytes_total"),
            "token_input": rpc.get("tokens_input_total"), "token_output": rpc.get("tokens_output_total")}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=Path("target/release/news"))
    parser.add_argument("--mock", type=Path, default=Path("scripts/perf_mock_pi.py"))
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    root = args.output_dir or Path(tempfile.mkdtemp(prefix="r5-01-token-observability-"))
    root.mkdir(parents=True, exist_ok=True)
    import os
    os.environ.update({"PERF_MOCK_MODE": "normal", "NEWSROOM_RPC_STARTUP_MS": "150", "NEWSROOM_RPC_IDLE_MS": "150", "NEWSROOM_RPC_FINISH_MS": "150", "NEWSROOM_RPC_TOTAL_MS": "3000"})
    runs = [run_once(args.binary.resolve(), args.mock.resolve(), root / f"run-{i}", i) for i in range(1, args.runs + 1)]
    summary = {"schema_version": "r5.0.0", "experiment": "r5-01-token-observability-foundation", "run_count": len(runs),
               "runs": runs, "aggregate": {"median_e2e_ms": statistics.median(r["e2e_ms"] for r in runs),
               "p95_e2e_ms": sorted(r["e2e_ms"] for r in runs)[max(0, int(len(runs) * .95) - 1)]}}
    (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({"summary": str(root / "summary.json"), "aggregate": summary["aggregate"]}))

if __name__ == "__main__":
    main()
