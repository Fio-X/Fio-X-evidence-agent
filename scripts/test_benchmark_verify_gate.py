#!/usr/bin/env python3
"""The verifier benchmark gates on a machine-scaled limit (1.40 x slower reference, cap 17 ms); the old fixed 15.0 ms result is printed as a reference only.

The pairs below are synthetic (reference, p95) timings in the range seen on hosted runners; nothing here runs the verifier.
Every mutant of benchmark_verify.py must turn the check red.
"""
from __future__ import annotations

import importlib.util
import io
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

import benchmark_verify as real

SOURCE = Path(real.__file__).read_text(encoding="utf-8")


def run_main(bv, ref: float, p95: float) -> tuple[str, str]:
    """Run bv.main() with a fixed reference and a fixed p95; return (outcome, printed text)."""
    saved = bv.reference_ms, bv.benchmark_attempt
    bv.reference_ms = lambda scratch: ref
    bv.benchmark_attempt = lambda root: (5, 1.0, p95, p95 + 1.0)
    out = io.StringIO()
    try:
        with redirect_stdout(out):
            try:
                bv.main()
                outcome = "pass"
            except SystemExit:
                outcome = "exit"
    finally:
        bv.reference_ms, bv.benchmark_attempt = saved
    return outcome, out.getvalue()


def check(bv) -> None:
    # The old fixed value stays as the reference, and the attempt and iteration counts are untouched.
    assert bv.P95_BUDGET_MS == 15.0 and bv.MAX_ATTEMPTS == 3 and bv.ITERATIONS == 400
    assert bv.GATE_RATIO == 1.40 and bv.GATE_CAP_MS == 17.0

    def verdict(before, after, p95):
        return bv.gate_passes(p95, before, after)

    # Slow hosted runner (reference near 11.9 ms): the usual readings pass, a 20% slowdown does not.
    assert verdict(11.94, 11.94, 14.73), "slow machine, usual p95"
    assert verdict(11.73, 11.73, 15.14), "slow machine, the p95 that failed the old gate on #216"
    assert not verdict(11.94, 11.94, 14.73 * 1.2), "slow machine, 1.2x slower"
    # Fast runner (reference near 6.3 ms): the usual reading passes, 1.5x slower does not.
    assert verdict(6.35, 6.35, 6.99), "fast machine, usual p95"
    assert not verdict(6.35, 6.35, 6.99 * 1.5), "fast machine, 1.5x slower"
    # A mid-speed machine just above the ratio (11.5 / 8.0 = 1.4375).
    assert not verdict(8.0, 8.0, 11.5), "ratio 1.4375 is above 1.40"
    assert verdict(8.0, 8.0, 11.1), "ratio 1.3875 is below 1.40"
    # The slower of the two references counts, in either order.
    assert verdict(6.0, 12.0, 15.0), "after is the slower reference"
    assert verdict(12.0, 6.0, 15.0), "before is the slower reference"
    assert not verdict(6.0, 12.0, 17.0), "slower reference 12.0 gives 16.8, not 17.0"
    # The cap: a very slow reference cannot lift the limit past 17.0 ms.
    assert bv.gate_limit(20.0, 20.0) == 17.0
    assert verdict(20.0, 20.0, 16.9) and not verdict(20.0, 20.0, 17.5), "cap"
    assert abs(bv.gate_limit(10.0, 10.0) - 14.0) < 1e-9
    # The limit itself passes; a hair above does not.
    limit = bv.gate_limit(9.0, 9.0)
    assert bv.gate_passes(limit, 9.0, 9.0) and not bv.gate_passes(limit + 0.001, 9.0, 9.0), "boundary"

    # The cases the gate was changed for.
    assert verdict(11.5, 11.5, 15.06), "slow machine: p95 15.06 over the old 15.0 limit passes (limit 16.1)"
    assert not verdict(10.0, 10.0, 14.4), "a real 10% regression (ratio 1.44) fails"
    assert not verdict(13.0, 13.0, 17.5), "the cap holds: ref 13 gives 18.2 uncapped, 17.5 fails"
    assert verdict(13.0, 13.0, 17.0), "the cap itself passes"

    # The printed line: gate verdict and the old fixed result side by side.
    line = bv.gate_line(15.14, 11.73, 11.73)
    assert line == (
        "gate verdict: p95=15.140ms limit=16.422ms (1.40x reference used 11.730ms, cap 17.0ms) -> PASS; "
        "reference only, fixed p95<=15.0ms -> FAIL"
    ), line
    assert bv.gate_line(15.0, 11.73, 11.73).endswith("reference only, fixed p95<=15.0ms -> PASS")
    line = bv.gate_line(11.5, 8.0, 8.0)
    assert line.endswith("-> FAIL; reference only, fixed p95<=15.0ms -> PASS"), line

    # The gate decides, in every attempt. Gate PASS with the old value FAIL: a passing run, printed once.
    outcome, text = run_main(bv, 11.73, 15.14)
    assert outcome == "pass", "the machine-scaled gate passes this run"
    assert text.count("-> PASS; reference only, fixed p95<=15.0ms -> FAIL") == 1, text
    assert "artifact verifier performance budget: PASS" in text
    # Gate FAIL with the old value PASS: a failed run, three attempts, each printed.
    outcome, text = run_main(bv, 5.0, 14.0)
    assert outcome == "exit", "the gate must fail a run the old fixed limit would pass"
    assert text.count("-> FAIL; reference only, fixed p95<=15.0ms -> PASS") == 3, text
    assert "attempt 3/3" in text and "artifact verifier performance budget: PASS" not in text
    lines = run_main(bv, 11.73, 15.14)[1].splitlines()
    assert lines[1].startswith("p50=") and "budget=" not in lines[1], lines[1]
    assert lines[2].startswith("reference before="), lines[2]
    assert lines[3].startswith("gate verdict:"), lines[3]
    assert lines[4] == "artifact verifier performance budget: PASS", lines[4]


def load_mutant(source: str, directory: Path):
    path = directory / "benchmark_verify_mutant.py"
    path.write_text(source, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("benchmark_verify_mutant", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LIMIT = "min(GATE_RATIO * reference_used(before, after), GATE_CAP_MS)"
MUTANTS = [
    ("M1 ratio 1.40 -> 1.60", "GATE_RATIO = 1.40", "GATE_RATIO = 1.60"),
    ("M2 ratio 1.40 -> 1.20", "GATE_RATIO = 1.40", "GATE_RATIO = 1.20"),
    ("M3 cap 17.0 -> 20.0", "GATE_CAP_MS = 17.0", "GATE_CAP_MS = 20.0"),
    ("M4 cap 17.0 -> 15.0", "GATE_CAP_MS = 17.0", "GATE_CAP_MS = 15.0"),
    ("M5 no cap", LIMIT, "GATE_RATIO * reference_used(before, after)"),
    ("M6 min of the two references", LIMIT, "min(GATE_RATIO * min(before, after), GATE_CAP_MS)"),
    ("M7 only the before reference", LIMIT, "min(GATE_RATIO * before, GATE_CAP_MS)"),
    ("M8 only the after reference", LIMIT, "min(GATE_RATIO * after, GATE_CAP_MS)"),
    ("M9 < instead of <=", "return p95 <= gate_limit(before, after)", "return p95 < gate_limit(before, after)"),
    ("M10 gate always passes", "return p95 <= gate_limit(before, after)", "return True"),
    (
        "M11 the gate follows the old fixed limit",
        "            if gate_passes(p95, ref_before, ref_after):\n",
        "            if p95 <= P95_BUDGET_MS:\n",
    ),
    ("M12 gate line not printed", "            print(gate_line(p95, ref_before, ref_after))\n", ""),
    (
        "M13 old result wrong in the line",
        'old = "PASS" if p95 <= P95_BUDGET_MS else "FAIL"',
        'old = "PASS" if p95 < P95_BUDGET_MS else "FAIL"',
    ),
    ("M14 gate line printed before the reference line", "            print(reference_line(ref_before, ref_after))\n            print(gate_line(p95, ref_before, ref_after))\n",
     "            print(gate_line(p95, ref_before, ref_after))\n            print(reference_line(ref_before, ref_after))\n"),
    ("M15 attempt count 3 -> 1", "MAX_ATTEMPTS = 3", "MAX_ATTEMPTS = 1"),
    ("M16 iterations 400 -> 200", "ITERATIONS = 400", "ITERATIONS = 200"),
]


def main() -> None:
    check(real)
    with tempfile.TemporaryDirectory() as tmp:
        for name, old, new in MUTANTS:
            assert SOURCE.count(old) == 1, f"{name}: the text to mutate must occur exactly once"
            mutant = load_mutant(SOURCE.replace(old, new), Path(tmp))
            try:
                check(mutant)
            except AssertionError:
                print(f"caught: {name}")
                continue
            raise SystemExit(f"mutation not caught: {name}")
    print("benchmark verify gate: PASS")


if __name__ == "__main__":
    main()
