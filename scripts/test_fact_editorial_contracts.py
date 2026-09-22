#!/usr/bin/env python3
import copy
import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
HASH = "a" * 64


def validator(name):
    schema = json.loads((ROOT / "schemas" / name).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


fact_graph = {
    "schema_version": "0.1.0",
    "fact_graph_id": "migration-demo",
    "entities": [{"id": "country-a", "kind": "country", "label": "Country A", "evidence_ids": ["ev-stock"]}],
    "relations": [{"id": "od-a-b", "subject_id": "country-a", "predicate": "migrant_stock_destination", "object_id": "country-b", "time_ids": ["t-2020"], "evidence_ids": ["ev-stock"]}],
    "quantities": [
        {"id": "q-stock", "phenomenon": "international_migrant_stock", "value": 1200, "unit": "persons", "origin": "source_extraction", "entity_ids": ["country-a"], "time_ids": ["t-2020"], "scale_id": "national", "evidence_ids": ["ev-stock"]},
        {"id": "q-share", "phenomenon": "share_of_stock", "value": 0.12, "unit": "ratio", "origin": "calculation", "calculation_id": "calc-share", "evidence_ids": ["ev-stock"]}
    ],
    "processes": [],
    "locations": [{"id": "country-b", "label": "Country B", "geometry_semantics": "administrative_area", "evidence_ids": ["ev-stock"]}],
    "time": [{"id": "t-2020", "kind": "year", "start": "2020-01-01", "end": "2020-12-31", "label": "2020"}],
    "scale": [{"id": "national", "level": "national", "denominator": "resident population"}],
    "evidence": [{"id": "ev-stock", "source_ref": "sources/migrant-stock.csv", "source_sha256": HASH, "extraction_method": "structured_import", "extraction_status": "passed", "retrieved_at": "2026-09-19T00:00:00Z"}],
    "calculations": [{"id": "calc-share", "operation": "stock divided by total", "input_fact_ids": ["q-stock"], "code_ref": "sql/share.sql", "result_sha256": HASH, "replay_status": "passed"}],
    "uncertainty": []
}
fact_validator = validator("fact-graph.schema.json")
assert not list(fact_validator.iter_errors(fact_graph))
bad_fact = copy.deepcopy(fact_graph)
bad_fact["quantities"][0]["origin"] = "llm_inference"
assert list(fact_validator.iter_errors(bad_fact)), "LLM-authored quantity origin was accepted"

claim_graph = {
    "schema_version": "0.1.0", "claim_graph_id": "migration-claims", "fact_graph_ref": "facts/migration.json",
    "claims": [{"id": "claim-share", "statement": "Country A accounts for 12% of the selected stock total.", "kind": "quantitative", "fact_ids": ["q-share"], "evidence_ids": ["ev-stock"], "calculation_ids": ["calc-share"], "support_status": "supported"}],
    "edges": []
}
claim_validator = validator("claim-graph.schema.json")
assert not list(claim_validator.iter_errors(claim_graph))
bad_claim = copy.deepcopy(claim_graph)
del bad_claim["claims"][0]["calculation_ids"]
assert list(claim_validator.iter_errors(bad_claim)), "quantitative claim without calculation was accepted"

signature = {
    "schema_version": "0.1.0", "signature_id": "sig-share", "source": {"id": "ev-stock", "sha256": HASH},
    "facts": [{"id": "q-share", "sha256": HASH}], "calculations": [{"id": "calc-share", "sha256": HASH}],
    "claims": [{"id": "claim-share", "sha256": HASH}],
    "graphic_objects": [{"id": "bubble-a", "claim_ids": ["claim-share"], "fact_ids": ["q-share"], "sha256": HASH}],
    "render_targets": [{"id": "desktop", "graphic_object_ids": ["bubble-a"], "artifact_ref": "index.html#bubble-a", "sha256": HASH}],
    "verification": {"authority": "system", "source_resolved": True, "extraction_passed": True, "computation_replayed": True, "claim_supported": True, "publishable": True, "rule_id": "verification.source+extraction+computation+claim.v1"}
}
signature_validator = validator("fact-signature.schema.json")
assert not list(signature_validator.iter_errors(signature))
bad_signature = copy.deepcopy(signature)
bad_signature["verification"]["authority"] = "model"
assert list(signature_validator.iter_errors(bad_signature)), "model verification authority was accepted"

selection = {
    "schema_version": "0.1.0", "project_id": "migration-story", "primary": "ROUTE_SPINE", "supporting": ["THEN_NOW", "SCALE_TRANSLATOR"],
    "available_renderer_capabilities": ["svg", "canvas2d"],
    "evidence_features": ["origin_destination_relation", "verified_locations", "comparable_timepoints", "quantity", "human_scale_reference"],
    "cognitive_goals": ["ORIENT", "ZOOM", "MEASURE", "COMPARE", "CONSEQUENCE"],
    "candidates": [
        {"grammar": "ROUTE_SPINE", "hard_constraints_passed": True, "renderer_capability_passed": True, "soft_score": 1, "reason_codes": ["evidence_requirements_met"]},
        {"grammar": "THEN_NOW", "hard_constraints_passed": True, "renderer_capability_passed": True, "soft_score": 0.8, "reason_codes": ["evidence_requirements_met"]},
        {"grammar": "SCALE_TRANSLATOR", "hard_constraints_passed": True, "renderer_capability_passed": True, "soft_score": 0.7, "reason_codes": ["evidence_requirements_met"]}
    ],
    "selected": "ROUTE_SPINE",
    "decision_log": [{"stage": "final_selection", "grammar": "ROUTE_SPINE", "outcome": "select", "reason_code": "highest_eligible_score"}]
}
selection_validator = validator("editorial-grammar-selection.schema.json")
assert not list(selection_validator.iter_errors(selection))
bad_selection = copy.deepcopy(selection)
bad_selection["supporting"].append("SPECIMEN_GRID")
assert list(selection_validator.iter_errors(bad_selection)), "more than two supporting grammars were accepted"

registry = json.loads((ROOT / "config" / "editorial-grammar-registry.json").read_text(encoding="utf-8"))
assert [row["id"] for row in registry["grammars"]] == ["CUTAWAY", "SCALE_TRANSLATOR", "MECHANISM_FLOW", "SPECIMEN_GRID", "THEN_NOW", "ROUTE_SPINE"]
print("fact and editorial contract schemas: PASS")
