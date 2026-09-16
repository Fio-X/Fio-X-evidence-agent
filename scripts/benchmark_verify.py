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
MAX_ATTEMPTS = 3
P95_BUDGET_MS = 15.0


def percentile(values, q):
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * q))))
    return ordered[idx]


def benchmark_attempt(root: Path):
    samples = []
    checks = None
    for _ in range(ITERATIONS):
        start = time.perf_counter_ns()
        report = verify(root)
        elapsed_ms = (time.perf_counter_ns() - start) / 1_000_000
        if not report.passed:
            raise SystemExit("verifier failed during benchmark")
        checks = report.checks
        samples.append(elapsed_ms)
    return checks, statistics.median(samples), percentile(samples, 0.95), max(samples)


def main():
    with tempfile.TemporaryDirectory(prefix="newsroom-verify-bench-") as tmp:
        root = Path(tmp)
        build_valid(root)
        warm = verify(root)
        if not warm.passed:
            raise SystemExit("benchmark fixture did not pass verifier: " + " | ".join(warm.errors))

        failed_p95 = []
        for attempt in range(1, MAX_ATTEMPTS + 1):
            checks, p50, p95, max_v = benchmark_attempt(root)
            print(
                f"artifact verifier benchmark attempt {attempt}/{MAX_ATTEMPTS}: "
                f"{ITERATIONS} iterations, {checks} checks/run"
            )
            print(
                f"p50={p50:.3f}ms p95={p95:.3f}ms max={max_v:.3f}ms "
                f"budget={P95_BUDGET_MS:.1f}ms"
            )
            if p95 <= P95_BUDGET_MS:
                print("artifact verifier performance budget: PASS")
                return
            failed_p95.append(p95)
            print(
                f"performance attempt {attempt} exceeded budget: "
                f"p95 {p95:.3f}ms > {P95_BUDGET_MS:.1f}ms"
            )

        values = ", ".join(f"{value:.3f}ms" for value in failed_p95)
        raise SystemExit(
            f"performance budget exceeded in {MAX_ATTEMPTS} consecutive attempts: "
            f"p95 values [{values}] > {P95_BUDGET_MS:.1f}ms"
        )


if __name__ == "__main__":
    main()
