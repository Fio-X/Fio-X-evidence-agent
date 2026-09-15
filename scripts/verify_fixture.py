#!/usr/bin/env python3
"""Dependency-free sanity checks for the offline World Bank fixture."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixtures" / "world-bank-renewable-latest.csv"


def main() -> int:
    with FIXTURE.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    assert len(rows) == 11, f"expected 11 rows, got {len(rows)}"
    years = sorted({int(row["year"]) for row in rows})
    assert years == [2021, 2022], f"fixture should expose mixed-year risk, got {years}"

    ranked = sorted(
        rows,
        key=lambda row: float(row["renewable_energy_consumption_pct"]),
        reverse=True,
    )
    assert ranked[0]["country"] == "Congo, Dem. Rep."
    assert abs(float(ranked[0]["renewable_energy_consumption_pct"]) - 96.30) < 1e-9

    counts = {year: sum(int(row["year"]) == year for row in rows) for year in years}
    print(f"fixture: {FIXTURE}")
    print(f"rows: {len(rows)}")
    print(f"reference years: {years}")
    print(f"rows by year: {counts}")
    print(f"naive top row: {ranked[0]['country']} ({ranked[0]['year']}, {ranked[0]['renewable_energy_consumption_pct']}%)")
    print("PASS: fixture is valid and preserves the intended mixed-year comparability trap")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, OSError, ValueError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
