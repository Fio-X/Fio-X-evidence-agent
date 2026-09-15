#!/usr/bin/env python3
"""Microbenchmark the independent artifact integrity verifier."""
from __future__ import annotations

import statistics
import tempfile
import time
from pathlib import Path

from selftest_evaluator import build_valid
from verify_artifact import verify

ITERATIONS = 400
P95_BUDGET_MS = 15.0


def percentile(values, q):
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * q))))
    return ordered[idx]


def main():
    with tempfile.TemporaryDirectory(prefix="newsroom-verify-bench-") as tmp:
        root = Path(tmp)
        build_valid(root)
        warm = verify(root)
        if not warm.passed:
            raise SystemExit("benchmark fixture did not pass verifier: " + " | ".join(warm.errors))
        samples = []
        checks = warm.checks
        for _ in range(ITERATIONS):
            start = time.perf_counter_ns()
            report = verify(root)
            elapsed_ms = (time.perf_counter_ns() - start) / 1_000_000
            if not report.passed:
                raise SystemExit("verifier failed during benchmark")
            samples.append(elapsed_ms)
        p50 = statistics.median(samples)
        p95 = percentile(samples, 0.95)
        max_v = max(samples)
        print(f"artifact verifier benchmark: {ITERATIONS} iterations, {checks} checks/run")
        print(f"p50={p50:.3f}ms p95={p95:.3f}ms max={max_v:.3f}ms budget={P95_BUDGET_MS:.1f}ms")
        if p95 > P95_BUDGET_MS:
            raise SystemExit(f"performance budget exceeded: p95 {p95:.3f}ms > {P95_BUDGET_MS:.1f}ms")
        print("artifact verifier performance budget: PASS")


if __name__ == "__main__":
    main()
