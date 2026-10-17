#!/usr/bin/env python3
"""Microbenchmark the independent artifact integrity verifier."""
from __future__ import annotations

import hashlib
import json
import statistics
import tempfile
import time
from pathlib import Path

from selftest_evaluator import build_valid
from verify_artifact import verify

ITERATIONS = 400
MAX_ATTEMPTS = 3
P95_BUDGET_MS = 15.0

# Machine-speed reference: a fixed pure-Python workload that never calls the verifier. It is timed before and
# after every attempt and only printed; the gate below still compares p95 with P95_BUDGET_MS unchanged.
REFERENCE_RECORDS = 2000
REFERENCE_REPEATS = 15


def percentile(values, q):
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * q))))
    return ordered[idx]


def reference_once(scratch: Path) -> None:
    """One pass of the fixed workload: JSON round trip, hashing, sorting and a small file write and read."""
    records = [
        {"id": f"record-{i:04d}", "value": (i * 7919) % 1009, "label": "x" * (i % 17), "tags": [i % 3, i % 5, i % 7]}
        for i in range(REFERENCE_RECORDS)
    ]
    text = json.dumps(records, sort_keys=True, indent=2)
    parsed = json.loads(text)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    ordered = sorted(parsed, key=lambda r: (r["value"], r["id"]))
    path = scratch / "reference.json"
    path.write_text(json.dumps(ordered), encoding="utf-8")
    back = json.loads(path.read_text(encoding="utf-8"))
    if len(back) != REFERENCE_RECORDS or not digest:
        raise SystemExit("reference workload produced an unexpected result")


def reference_ms(scratch: Path) -> float:
    """Median time of the reference workload in milliseconds, after one untimed warm-up pass."""
    reference_once(scratch)
    samples = []
    for _ in range(REFERENCE_REPEATS):
        start = time.perf_counter_ns()
        reference_once(scratch)
        samples.append((time.perf_counter_ns() - start) / 1_000_000)
    return statistics.median(samples)


def reference_used(before: float, after: float) -> float:
    """The slower of the two reference timings."""
    return max(before, after)


def reference_line(before: float, after: float) -> str:
    return (
        f"reference before={before:.3f}ms after={after:.3f}ms used={reference_used(before, after):.3f}ms "
        f"(printed only, gate stays p95<={P95_BUDGET_MS:.1f}ms)"
    )


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
    with tempfile.TemporaryDirectory(prefix="newsroom-verify-bench-") as tmp, tempfile.TemporaryDirectory(
        prefix="newsroom-verify-bench-ref-"
    ) as scratch_tmp:
        root = Path(tmp)
        scratch = Path(scratch_tmp)
        build_valid(root)
        warm = verify(root)
        if not warm.passed:
            raise SystemExit("benchmark fixture did not pass verifier: " + " | ".join(warm.errors))

        failed_p95 = []
        for attempt in range(1, MAX_ATTEMPTS + 1):
            ref_before = reference_ms(scratch)
            checks, p50, p95, max_v = benchmark_attempt(root)
            ref_after = reference_ms(scratch)
            print(
                f"artifact verifier benchmark attempt {attempt}/{MAX_ATTEMPTS}: "
                f"{ITERATIONS} iterations, {checks} checks/run"
            )
            print(
                f"p50={p50:.3f}ms p95={p95:.3f}ms max={max_v:.3f}ms "
                f"budget={P95_BUDGET_MS:.1f}ms"
            )
            print(reference_line(ref_before, ref_after))
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
