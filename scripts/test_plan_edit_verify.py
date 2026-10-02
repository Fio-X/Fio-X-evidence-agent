#!/usr/bin/env python3
"""verify_artifact.py replays infographics/plan-edits/ (NEWSROOM_SPEED_PLAN_EDIT records).

A valid artifact plus a plan-edit record verifies; every tampering below must fail; a plan-edit
record left in the old infographics/revisions/ folder (vision-revision replay) still fails."""
from __future__ import annotations

import copy
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from selftest_evaluator import build_valid, write_json
from test_integrity_adversarial import add_valid_publication
from verify_artifact import canonical_json, infographic_plan_content_hash, plan_edit_immutable_hash, verify

SOURCE = "infographics/plans/pe-source.json"
REVISED = "infographics/plans/pe-revised.json"


def fixture(root: Path):
    build_valid(root)
    add_valid_publication(root)
    base = json.loads((root / "infographics" / "plans" / "page.json").read_text())
    base.pop("content_hash", None)
    base["scene_graph"] = {"scenes": [{"id": "s1", "pattern": "hero_sidecar_stack", "anchor_module_id": base["modules"][0]["id"], "sidecar_module_ids": [base["modules"][1]["id"]], "scene_budget": 2}]}
    return base


def edit_set(source: dict):
    a, b = source["modules"][0]["id"], source["modules"][1]["id"]
    ops = [
        {"scope": "module", "id": a, "field": "priority", "value": 2},
        {"scope": "module", "id": b, "field": "move_before", "value": a},
        {"scope": "scene", "id": "s1", "field": "pattern", "value": "hero_with_rail"},
    ]
    revised = copy.deepcopy(source)
    revised["modules"][0]["priority"] = 2
    revised["modules"] = [revised["modules"][1], revised["modules"][0]] + revised["modules"][2:]
    revised["scene_graph"]["scenes"][0]["pattern"] = "hero_with_rail"
    return ops, revised


def write_record(root: Path, source: dict, revised: dict, ops, folder="plan-edits", **override):
    for ref, plan in ((SOURCE, source), (REVISED, revised)):
        plan = {k: v for k, v in plan.items() if k != "content_hash"}
        write_json(root / ref, {**plan, "content_hash": infographic_plan_content_hash(plan)})
    record = {"schema_version": "0.2.0", "kind": "plan_edit", "source_plan_ref": SOURCE, "revised_plan_ref": REVISED, "applied_edits": ops,
              "remaining_lint_blockers": [], "safety": {"immutable_projection_sha256": plan_edit_immutable_hash(source), "evidence_fields_preserved": True,
              "editable_module_fields": ["span", "emphasis", "priority", "move_before", "mobile_move_before"], "editable_scene_fields": ["pattern", "anchor_module_id", "sidecar_module_ids"]}}
    record.update(override)
    write_json(root / "infographics" / folder / "pe.json", record)


def run(name: str, mutate, expect_pass: bool, expect_text: str | None = None, folder="plan-edits", **override):
    tmp = Path(tempfile.mkdtemp(prefix="plan-edit-verify-"))
    try:
        source = fixture(tmp)
        ops, revised = edit_set(source)
        ops, revised, source = mutate(ops, revised, source) if mutate else (ops, revised, source)
        write_record(tmp, source, revised, ops, folder=folder, **override)
        result = verify(tmp)
        assert result.passed is expect_pass, f"{name}: expected passed={expect_pass}, got {result.passed}: {result.errors[:4]}"
        if expect_text:
            assert any(expect_text in e for e in result.errors), f"{name}: no error containing {expect_text!r}: {result.errors[:4]}"
        print(f"  ok  {name}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def edited_text(ops, revised, source):
    for m in revised["modules"]:
        for key in ("body", "text", "headline", "title"):
            if isinstance(m.get(key), str):
                m[key] = m[key] + " (edited)"
                return ops, revised, source
    revised["headline"] = str(revised.get("headline", "")) + " (edited)"
    return ops, revised, source


def edited_claim(ops, revised, source):
    revised["modules"][0]["claim_ids"] = list(revised["modules"][0].get("claim_ids") or []) + ["claim-injected"]
    return ops, revised, source


def dropped_module(ops, revised, source):
    revised["modules"] = revised["modules"][:-1]
    return ops, revised, source


def added_module(ops, revised, source):
    extra = copy.deepcopy(revised["modules"][0]); extra["id"] = "m_added"
    revised["modules"] = revised["modules"] + [extra]
    return ops, revised, source


def unrecorded_layout_change(ops, revised, source):
    revised["modules"][-1]["span"] = "third" if revised["modules"][-1].get("span") != "third" else "half"
    return ops, revised, source


def scene_budget_change(ops, revised, source):
    revised["scene_graph"]["scenes"][0]["scene_budget"] = 9
    return ops, revised, source


def not_editable_op(ops, revised, source):
    ops.append({"scope": "module", "id": source["modules"][0]["id"], "field": "claim_ids", "value": ["x"]})
    return ops, revised, source


if __name__ == "__main__":
    run("a run with a plan edit verifies", None, True)
    run("revised plan changes a text module", edited_text, False, "does not equal")
    run("revised plan adds a claim id", edited_claim, False)
    run("revised plan drops a module", dropped_module, False, "module id set")
    run("revised plan adds a module", added_module, False, "module id set")
    run("layout change that is not in applied_edits", unrecorded_layout_change, False, "does not equal")
    run("scene budget changed", scene_budget_change, False)
    run("applied edit on a non-editable field", not_editable_op, False, "not editable")
    run("wrong schema_version", None, False, "schema_version mismatch", schema_version="0.1.0")
    run("wrong kind", None, False, "kind mismatch", kind="other")
    run("revised plan ref does not exist", None, False, "missing revised plan", revised_plan_ref="infographics/plans/nope.json")
    run("revised plan ref outside infographics/plans", None, False, "invalid revised plan ref", revised_plan_ref="infographics/previews/x.json")
    run("immutable projection hash mismatch", None, False, "immutable projection hash mismatch", safety={"immutable_projection_sha256": "0" * 64, "evidence_fields_preserved": True, "editable_module_fields": ["span", "emphasis", "priority", "move_before", "mobile_move_before"], "editable_scene_fields": ["pattern", "anchor_module_id", "sidecar_module_ids"]})
    run("plan-edit record in the old revisions folder still fails", None, False, "revision", folder="revisions")
    print("plan edit verify: PASS")
