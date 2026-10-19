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
# after every attempt; the gate scales its limit by it. The old fixed P95_BUDGET_MS is printed as a reference only.
REFERENCE_RECORDS = 2000
REFERENCE_REPEATS = 15

# The gate: p95 must not exceed GATE_RATIO times the slower of the two reference timings, capped at GATE_CAP_MS so a
# slow or broken reference cannot lift the limit without bound. GATE_RATIO is a starting value taken from six observed
# CI pairs (largest p95 / reference 1.26); set it again from more runs if it proves too tight or too loose.
GATE_RATIO = 1.40
GATE_CAP_MS = 17.0


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
        "(machine-speed reference, printed only)"
    )


def gate_limit(before: float, after: float) -> float:
    """The gate limit in milliseconds: GATE_RATIO x the slower reference timing, never above GATE_CAP_MS."""
    return min(GATE_RATIO * reference_used(before, after), GATE_CAP_MS)


def gate_passes(p95: float, before: float, after: float) -> bool:
    return p95 <= gate_limit(before, after)


# gate_line is formatting only. The old fixed limit is shown as a reference and does not decide.
def gate_line(p95: float, before: float, after: float) -> str:
    """One line with the gate verdict and the old fixed limit's result as a reference."""
    new = "PASS" if gate_passes(p95, before, after) else "FAIL"
    old = "PASS" if p95 <= P95_BUDGET_MS else "FAIL"
    return (
        f"gate verdict: p95={p95:.3f}ms limit={gate_limit(before, after):.3f}ms "
        f"({GATE_RATIO:.2f}x reference used {reference_used(before, after):.3f}ms, cap {GATE_CAP_MS:.1f}ms) -> {new}; "
        f"reference only, fixed p95<={P95_BUDGET_MS:.1f}ms -> {old}"
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
            print(f"p50={p50:.3f}ms p95={p95:.3f}ms max={max_v:.3f}ms")
            print(reference_line(ref_before, ref_after))
            print(gate_line(p95, ref_before, ref_after))
            if gate_passes(p95, ref_before, ref_after):
                print("artifact verifier performance budget: PASS")
                return
            failed_p95.append((p95, gate_limit(ref_before, ref_after)))
            print(
                f"performance attempt {attempt} exceeded the limit: "
                f"p95 {p95:.3f}ms > {failed_p95[-1][1]:.3f}ms"
            )

        values = ", ".join(f"{value:.3f}ms (limit {limit:.3f}ms)" for value, limit in failed_p95)
        raise SystemExit(
            f"performance limit exceeded in {MAX_ATTEMPTS} consecutive attempts: p95 values [{values}]"
        )


if __name__ == "__main__":
    main()
