#!/usr/bin/env python3
"""Microbenchmark v1.4 editorial-artifact verification and replay."""
from __future__ import annotations

import statistics
import tempfile
import time
from pathlib import Path

from selftest_evaluator import build_valid
from test_editorial_verifier_v14 import install
from verify_artifact import verify

ITERATIONS = 200
P95_BUDGET_MS = 15.0

def percentile(values, q):
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * q))))
    return ordered[idx]

def main():
    with tempfile.TemporaryDirectory(prefix="newsroom-editorial-verify-bench-") as tmp:
        root = Path(tmp)
        build_valid(root)
        install(root)
        warm = verify(root)
        if not warm.passed:
            raise SystemExit("editorial verifier benchmark fixture invalid: " + " | ".join(warm.errors[:5]))
        for _ in range(20):
            if not verify(root).passed:
                raise SystemExit("editorial verifier failed during warmup")
        samples = []
        for _ in range(ITERATIONS):
            start = time.perf_counter_ns()
            report = verify(root)
            samples.append((time.perf_counter_ns() - start) / 1_000_000)
            if not report.passed:
                raise SystemExit("editorial verifier failed during benchmark")
        p50 = statistics.median(samples)
        p95 = percentile(samples, 0.95)
        max_v = max(samples)
        print(f"editorial artifact verifier benchmark: {ITERATIONS} iterations, {warm.checks} checks/run")
        print(f"p50={p50:.3f}ms p95={p95:.3f}ms max={max_v:.3f}ms budget={P95_BUDGET_MS:.1f}ms")
        if p95 > P95_BUDGET_MS:
            raise SystemExit(f"editorial verifier performance budget exceeded: p95 {p95:.3f}ms > {P95_BUDGET_MS:.1f}ms")
        print("editorial artifact verifier performance budget: PASS")

if __name__ == "__main__":
    main()
