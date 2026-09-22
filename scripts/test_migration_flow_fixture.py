#!/usr/bin/env python3
import csv
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "fixtures" / "migration"
FIXTURE = FIXTURE_DIR / "deep-learning-human-migration-top-corridors.csv"
SOURCE = json.loads((FIXTURE_DIR / "SOURCE.json").read_text(encoding="utf-8"))


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


assert sha256(FIXTURE) == SOURCE["transformation"]["fixture_sha256"]
with FIXTURE.open(encoding="utf-8", newline="") as handle:
    rows = list(csv.DictReader(handle))
assert len(rows) == 150
assert sorted({int(row["year"]) for row in rows}) == [1990, 2000, 2010, 2020, 2023]
assert all(row["estimate_semantics"] == "model_estimated_annual_origin_destination_flow" for row in rows)
assert all(row["origin_iso3"] != row["destination_iso3"] for row in rows)
for year in [1990, 2000, 2010, 2020, 2023]:
    annual = [row for row in rows if int(row["year"]) == year]
    assert [int(row["rank_within_year"]) for row in annual] == list(range(1, 31))
    assert [float(row["estimated_flow_mean"]) for row in annual] == sorted(
        [float(row["estimated_flow_mean"]) for row in annual], reverse=True
    )

if len(sys.argv) == 3:
    flows, lookup = map(Path, sys.argv[1:])
    expected = {row["path"]: row["sha256"] for row in SOURCE["upstream"]["files"]}
    assert sha256(flows) == expected["Estimates/flows.nc"]
    assert sha256(lookup) == expected["Data/Iso_code_lookup.csv"]
    with tempfile.TemporaryDirectory() as directory:
        rebuilt = Path(directory) / "fixture.csv"
        subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build_migration_flow_fixture.py"), str(flows), str(lookup), str(rebuilt)],
            check=True,
        )
        assert rebuilt.read_bytes() == FIXTURE.read_bytes(), "rebuilt fixture differs byte-for-byte"

print("migration flow fixture: PASS")
