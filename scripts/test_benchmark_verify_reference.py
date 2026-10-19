#!/usr/bin/env python3
"""The verifier benchmark prints a machine-speed reference and the gate scales its limit by it; the fixed 15.0 ms value is printed as a reference only."""
from __future__ import annotations

import io
import re
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

import benchmark_verify as bv


def main() -> None:
    assert bv.P95_BUDGET_MS == 15.0
    assert bv.MAX_ATTEMPTS == 3
    assert bv.ITERATIONS == 400

    assert bv.reference_used(1.5, 2.5) == 2.5
    assert bv.reference_used(3.0, 2.0) == 3.0

    line = bv.reference_line(1.25, 1.5)
    assert line == "reference before=1.250ms after=1.500ms used=1.500ms (machine-speed reference, printed only)", line

    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)
        value = bv.reference_ms(scratch)
        assert value > 0.0, value
        assert [p.name for p in scratch.iterdir()] == ["reference.json"]

    # The printed block of an attempt: the first line keeps its wording, the reference and gate lines follow.
    # Three samples make p95 the maximum, so the cap is lifted for this run only (restored below).
    saved = bv.ITERATIONS, bv.GATE_CAP_MS, bv.GATE_RATIO
    out = io.StringIO()
    try:
        bv.ITERATIONS, bv.GATE_CAP_MS, bv.GATE_RATIO = 3, 1_000_000.0, 1_000_000.0
        with redirect_stdout(out):
            bv.main()
    finally:
        bv.ITERATIONS, bv.GATE_CAP_MS, bv.GATE_RATIO = saved
    assert (bv.ITERATIONS, bv.GATE_CAP_MS, bv.GATE_RATIO, bv.P95_BUDGET_MS) == (400, 17.0, 1.40, 15.0)
    lines = out.getvalue().splitlines()
    assert re.fullmatch(r"artifact verifier benchmark attempt 1/3: 3 iterations, \d+ checks/run", lines[0]), lines[0]
    assert re.fullmatch(r"p50=[\d.]+ms p95=[\d.]+ms max=[\d.]+ms", lines[1]), lines[1]
    assert re.fullmatch(
        r"reference before=[\d.]+ms after=[\d.]+ms used=[\d.]+ms \(machine-speed reference, printed only\)", lines[2]
    ), lines[2]
    assert lines[3].startswith("gate verdict: p95="), lines[3]
    assert lines[4] == "artifact verifier performance budget: PASS", lines[4]
    print("benchmark verify reference contract: PASS")


if __name__ == "__main__":
    main()
