#!/usr/bin/env python3
"""The verifier benchmark prints a shadow verdict (1.40 x slower reference, cap 17 ms) next to the old gate and never lets it decide.

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
    # The old gate and the attempt count are untouched.
    assert bv.P95_BUDGET_MS == 15.0 and bv.MAX_ATTEMPTS == 3
    assert bv.SHADOW_RATIO == 1.40 and bv.SHADOW_CAP_MS == 17.0

    def verdict(before, after, p95):
        return bv.shadow_passes(p95, before, after)

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
    assert bv.shadow_limit(20.0, 20.0) == 17.0
    assert verdict(20.0, 20.0, 16.9) and not verdict(20.0, 20.0, 17.5), "cap"
    assert abs(bv.shadow_limit(10.0, 10.0) - 14.0) < 1e-9
    # The limit itself passes; a hair above does not.
    limit = bv.shadow_limit(9.0, 9.0)
    assert bv.shadow_passes(limit, 9.0, 9.0) and not bv.shadow_passes(limit + 0.001, 9.0, 9.0), "boundary"

    # The printed line: new and old verdict side by side.
    line = bv.shadow_line(15.14, 11.73, 11.73)
    assert line == (
        "shadow verdict (printed only): p95=15.140ms limit=16.422ms (1.40x reference used 11.730ms, cap 17.0ms) -> PASS; "
        "old gate p95<=15.0ms -> FAIL"
    ), line
    assert bv.shadow_line(15.0, 11.73, 11.73).endswith("old gate p95<=15.0ms -> PASS"), "old gate passes at exactly 15.0"
    line = bv.shadow_line(11.5, 8.0, 8.0)
    assert line.endswith("-> WOULD FAIL; old gate p95<=15.0ms -> PASS"), line

    # The old gate decides. Shadow PASS with old FAIL: still a failed run, in every attempt.
    outcome, text = run_main(bv, 11.73, 15.14)
    assert outcome == "exit", "the old gate must still fail this run"
    assert text.count("-> PASS; old gate p95<=15.0ms -> FAIL") == 3, text
    assert "artifact verifier performance budget: PASS" not in text
    # Shadow WOULD FAIL with old PASS: still a passing run.
    outcome, text = run_main(bv, 5.0, 14.0)
    assert outcome == "pass", "the shadow must not fail a run the old gate passes"
    lines = text.splitlines()
    assert lines[2].startswith("reference before="), lines[2]
    assert lines[3].endswith("-> WOULD FAIL; old gate p95<=15.0ms -> PASS"), lines[3]
    assert lines[4] == "artifact verifier performance budget: PASS", lines[4]


def load_mutant(source: str, directory: Path):
    path = directory / "benchmark_verify_mutant.py"
    path.write_text(source, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("benchmark_verify_mutant", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LIMIT = "min(SHADOW_RATIO * reference_used(before, after), SHADOW_CAP_MS)"
MUTANTS = [
    ("M1 ratio 1.40 -> 1.60", "SHADOW_RATIO = 1.40", "SHADOW_RATIO = 1.60"),
    ("M2 ratio 1.40 -> 1.20", "SHADOW_RATIO = 1.40", "SHADOW_RATIO = 1.20"),
    ("M3 cap 17.0 -> 20.0", "SHADOW_CAP_MS = 17.0", "SHADOW_CAP_MS = 20.0"),
    ("M4 cap 17.0 -> 15.0", "SHADOW_CAP_MS = 17.0", "SHADOW_CAP_MS = 15.0"),
    ("M5 no cap", LIMIT, "SHADOW_RATIO * reference_used(before, after)"),
    ("M6 min of the two references", LIMIT, "min(SHADOW_RATIO * min(before, after), SHADOW_CAP_MS)"),
    ("M7 only the before reference", LIMIT, "min(SHADOW_RATIO * before, SHADOW_CAP_MS)"),
    ("M8 only the after reference", LIMIT, "min(SHADOW_RATIO * after, SHADOW_CAP_MS)"),
    ("M9 < instead of <=", "return p95 <= shadow_limit(before, after)", "return p95 < shadow_limit(before, after)"),
    ("M10 shadow always passes", "return p95 <= shadow_limit(before, after)", "return True"),
    (
        "M11 the gate follows the shadow",
        "            if p95 <= P95_BUDGET_MS:\n",
        "            if shadow_passes(p95, ref_before, ref_after):\n",
    ),
    ("M12 shadow line not printed", "            print(shadow_line(p95, ref_before, ref_after))\n", ""),
    (
        "M13 old verdict wrong in the line",
        'old = "PASS" if p95 <= P95_BUDGET_MS else "FAIL"',
        'old = "PASS" if p95 < P95_BUDGET_MS else "FAIL"',
    ),
    ("M14 shadow line printed before the reference line", "            print(reference_line(ref_before, ref_after))\n            print(shadow_line(p95, ref_before, ref_after))\n",
     "            print(shadow_line(p95, ref_before, ref_after))\n            print(reference_line(ref_before, ref_after))\n"),
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
    print("benchmark verify shadow verdict: PASS")


if __name__ == "__main__":
    main()
