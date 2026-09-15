#!/usr/bin/env python3
"""Scale smoke for artifact verification over a moderately sized investigation."""
from __future__ import annotations

import hashlib
import json
import statistics
import tempfile
import time
from pathlib import Path

from selftest_evaluator import build_valid, canonical, sha_bytes
from verify_artifact import verify

EXTRA_COMPUTATIONS = 40
ITERATIONS = 100
P95_BUDGET_MS = 40.0


def write_json(path: Path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def percentile(values, q):
    values = sorted(values)
    return values[int(round((len(values) - 1) * q))]


def main():
    with tempfile.TemporaryDirectory(prefix="newsroom-verify-scale-") as tmp:
        root = Path(tmp)
        build_valid(root)
        base_claim = json.loads((root / "claims.jsonl").read_text(encoding="utf-8"))
        base_comp = json.loads((root / base_claim["computation_refs"][0]).read_text(encoding="utf-8"))
        fingerprints = base_comp["input_fingerprints"]
        input_hash = base_comp["input_snapshot_hash"]
        story = json.loads((root / "story.json").read_text(encoding="utf-8"))
        for i in range(EXTRA_COMPUTATIONS):
            rows = [{"bucket": i, "value": i * 2}, {"bucket": i + 1, "value": i * 3}]
            result_hash = sha_bytes(canonical(rows).encode())
            sql = f"select {i} as bucket, {i * 2} as value"
            key = sha_bytes(f"{sql}\n{input_hash}\n{result_hash}".encode())
            ref = f"computations/{key}.json"
            write_json(root / ref, {
                "schema_version": "0.7.0",
                "sql": sql,
                "input_snapshot_hash": input_hash,
                "input_fingerprints": fingerprints,
                "result_hash": result_hash,
                "rows": rows,
            })
            story["evidence"]["computations"].append(ref)
        write_json(root / "story.json", story)

        baseline = verify(root)
        if not baseline.passed:
            raise SystemExit("scale fixture invalid: " + " | ".join(baseline.errors[:5]))
        samples = []
        for _ in range(ITERATIONS):
            start = time.perf_counter_ns()
            report = verify(root)
            samples.append((time.perf_counter_ns() - start) / 1_000_000)
            if not report.passed:
                raise SystemExit("verifier failed during scale benchmark")
        p50 = statistics.median(samples)
        p95 = percentile(samples, .95)
        print(f"artifact verifier scale benchmark: {EXTRA_COMPUTATIONS + 1} computations, {baseline.checks} checks/run, {ITERATIONS} iterations")
        print(f"p50={p50:.3f}ms p95={p95:.3f}ms max={max(samples):.3f}ms budget={P95_BUDGET_MS:.1f}ms")
        if p95 > P95_BUDGET_MS:
            raise SystemExit("scaled verifier performance budget exceeded")
        print("artifact verifier scale budget: PASS")


if __name__ == "__main__":
    main()
