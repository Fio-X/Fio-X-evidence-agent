#!/usr/bin/env python3
import csv
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
IR = ROOT / "fixtures" / "migration" / "story-ir"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


for schema_name, artifact_name in [
    ("evidence-ledger.schema.json", "evidence-ledger.json"),
    ("fact-graph.schema.json", "fact-graph.json"),
    ("claim-graph.schema.json", "claim-graph.json"),
    ("story-graph.schema.json", "story-graph.json"),
    ("editorial-grammar-selection.schema.json", "editorial-grammar-selection.json"),
    ("infographic-spec.schema.json", "infographic-spec.json"),
]:
    schema = load(ROOT / "schemas" / schema_name)
    errors = list(Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER).iter_errors(load(IR / artifact_name)))
    assert not errors, f"{artifact_name}: {errors}"

ledger = load(IR / "evidence-ledger.json")
for artifact in ledger["derived_artifacts"]:
    path = ROOT / artifact["ref"]
    assert path.is_file() and digest(path) == artifact["sha256"]
assert any("not global totals" in guard for guard in ledger["semantic_guards"])
assert any("not physical routes" in guard for guard in ledger["semantic_guards"])

with (IR / "yearly-top30-summary.csv").open(encoding="utf-8", newline="") as handle:
    summaries = list(csv.DictReader(handle))
assert [int(row["year"]) for row in summaries] == [1990, 2000, 2010, 2020, 2023]
assert summaries[0]["highest_ranked_route"] == "IRN-AFG"
assert summaries[-1]["highest_ranked_route"] == "VEN-COL"
assert all(row["selection_scope"] == "top_30_routes_within_year" for row in summaries)

fact_graph = load(IR / "fact-graph.json")
assert len(fact_graph["relations"]) == 150
assert all(quantity["origin"] in {"source_extraction", "database", "calculation", "measurement"} for quantity in fact_graph["quantities"])
assert all(calculation["replay_status"] == "passed" for calculation in fact_graph["calculations"])
claim_graph = load(IR / "claim-graph.json")
assert all(claim["support_status"] == "supported" for claim in claim_graph["claims"])
assert all("global total" not in claim["statement"].lower() for claim in claim_graph["claims"])

if len(sys.argv) == 2:
    natural_earth = Path(sys.argv[1])
    with tempfile.TemporaryDirectory() as directory:
        rebuilt = Path(directory)
        subprocess.run([
            sys.executable, str(ROOT / "scripts" / "build_migration_story_ir.py"),
            str(ROOT / "fixtures" / "migration" / "deep-learning-human-migration-top-corridors.csv"),
            str(natural_earth), str(rebuilt),
        ], check=True)
        for expected in sorted(IR.iterdir()):
            assert (rebuilt / expected.name).read_bytes() == expected.read_bytes(), f"non-deterministic story IR: {expected.name}"

print("migration story IR: PASS")
