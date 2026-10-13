#!/usr/bin/env python3
"""NEWSROOM_LEAN_GATES (K258): verify_artifact.py accepts a 1.4/1.5 page plan without the concept set, the selected concept and the asset plan
only when the page manifest records lean_gates: true. The record is the only thing that matters; the environment variable is not read here.
Each case differs from the clean fixture by one change, so a refusal is attributable to it."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid
from test_integrity_adversarial import add_valid_publication, load_json, write_json
from verify_artifact import verify

FIELDS = ["visual_concept_ref", "selected_concept_id", "asset_plan_ref", "novelty_ref"]


def case(drop: list[str], lean, point_to_missing: str | None = None) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="lean-verify-") as tmp:
        root = Path(tmp)
        build_valid(root)
        add_valid_publication(root)
        plan = load_json(root / "infographics" / "plans" / "x.json")
        for field in drop:
            plan.pop(field)
        if point_to_missing:
            plan[point_to_missing] = {"asset_plan_ref": "editorial/assets/not-there.json", "novelty_ref": "editorial/novelty/not-there.json"}.get(point_to_missing, "editorial/concepts/not-there.json")
        write_json(root / "infographics" / "plans" / "x.json", plan)
        if lean is not None:
            manifest = load_json(root / "infographics" / "x.json")
            manifest["lean_gates"] = lean
            write_json(root / "infographics" / "x.json", manifest)
        return list(verify(root).errors)


ROOT = Path(__file__).resolve().parent.parent
BOARD = json.loads((ROOT / "fixtures" / "lean-gates" / "storyboard-4-panel-plan.json").read_text(encoding="utf-8"))


def js_derived_scene_graph(plan: dict) -> dict:
    """The graph runtime/pi/storyboard.mjs derives from the plan's panels (node reads the plan on stdin)."""
    code = ('import { deriveSceneGraphFromPanels } from "./runtime/pi/storyboard.mjs";'
            'let s = ""; for await (const c of process.stdin) s += c;'
            'const r = deriveSceneGraphFromPanels(JSON.parse(s)); if (!r.scene_graph) throw new Error(r.errors.join("; "));'
            'process.stdout.write(JSON.stringify(r.scene_graph));')
    out = subprocess.run(["node", "--input-type=module", "-e", code], input=json.dumps(plan), capture_output=True, text=True, cwd=ROOT, check=True)
    return json.loads(out.stdout)


def board_case(scene_graph, lean, edit=None) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="lean-board-") as tmp:
        root = Path(tmp)
        build_valid(root)
        add_valid_publication(root)
        plan = load_json(root / "infographics" / "plans" / "x.json")
        plan["modules"] = json.loads(json.dumps(BOARD["modules"]))
        if scene_graph is not None:
            plan["scene_graph"] = json.loads(json.dumps(scene_graph))
        if edit:
            edit(plan)
        write_json(root / "infographics" / "plans" / "x.json", plan)
        manifest = load_json(root / "infographics" / "x.json")
        manifest["lean_gates"] = lean
        write_json(root / "infographics" / "x.json", manifest)
        return list(verify(root).errors)


def scene_graph_checks() -> None:
    bare = {k: v for k, v in BOARD.items() if k != "scene_graph"}
    from verify_artifact import derive_scene_graph
    py, errors = derive_scene_graph(bare)
    js = js_derived_scene_graph(bare)
    assert not errors and py == js, f"python and runtime derive the same scene graph: {py} vs {js}"
    print("PASS python and runtime derive the same scene graph from the 4-panel stand-in page")
    errs = board_case(js, True)
    assert errs == [], f"lean page with the derived graph verifies: {errs}"
    print("PASS lean 4-panel page with the derived scene graph verifies")
    errs = board_case(None, True)
    assert any("no scene_graph" in e for e in errs), f"lean page with no scene graph is refused: {errs}"
    print("PASS lean page with no scene graph is refused")
    errs = board_case(BOARD["scene_graph"], True)
    assert any("does not match" in e for e in errs), f"lean page with a hand-written scene graph is refused: {errs}"
    print("PASS lean page with a scene graph the panels do not give is refused")
    def other_goal(plan): plan["scene_graph"]["scenes"][0]["primary_cognitive_goal"] = "ZOOM"
    errs = board_case(js, True, other_goal)
    assert any("does not match" in e for e in errs), f"a changed goal is refused: {errs}"
    def dropped_scene(plan): plan["scene_graph"]["scenes"].pop()
    errs = board_case(js, True, dropped_scene)
    assert any("does not match" in e for e in errs), f"a missing scene is refused: {errs}"
    print("PASS a changed goal and a dropped scene are refused")
    def edited(plan): plan["scene_graph"]["scenes"][0]["pattern"] = "hero_sidecar_stack"
    errs = board_case(js, True, edited)
    assert errs == [], f"pattern is a plan-edit field, so it is not compared: {errs}"
    print("PASS a recorded-edit field (pattern) differing is not a mismatch")
    for lean in (None, False):
        errs = board_case(BOARD["scene_graph"], lean)
        assert not any("scene_graph" in e or "scene graph" in e for e in errs), f"no lean record: the model's own scene graph is as before: {errs}"
    print("PASS without a lean record a written scene graph is judged as before")
    def no_chart(plan):
        for m in plan["modules"]:
            if m.get("type") == "visual": m["type"] = "hero_stat"
    errs = board_case(js, True, no_chart)
    assert any("cannot be derived" in e for e in errs), f"lean page whose panels give no scene is refused: {errs}"
    print("PASS lean page whose panels give no scene is refused")


def main() -> None:
    clean = case([], None)
    assert clean == [], f"the clean fixture verifies: {clean}"
    print("PASS clean 1.4 page with every ref verifies")
    assert case([], True) == [], "lean record on a page that has every ref is harmless"
    print("PASS lean record with every ref present verifies")
    for field in FIELDS:
        for lean in (None, False, "true", 1):
            errs = case([field], lean)
            assert any(field in e for e in errs), f"{field} missing, lean_gates={lean!r}: must be refused, got {errs}"
        print(f"PASS {field} missing without a (true) lean record is refused")
        errs = case([field], True)
        assert errs == [], f"{field} missing with lean_gates true: {errs}"
        print(f"PASS {field} missing with lean_gates true verifies")
    errs = case(FIELDS, True)
    assert errs == [], f"all four missing with lean_gates true: {errs}"
    print("PASS all four missing with lean_gates true verifies")
    for field in ("visual_concept_ref", "asset_plan_ref", "novelty_ref"):
        errs = case([], True, point_to_missing=field)
        assert any("missing" in e and field in e for e in errs), f"lean does not excuse a ref that points nowhere: {errs}"
    print("PASS lean does not excuse a ref that names a missing file")
    scene_graph_checks()
    print("lean gates verify: PASS")


if __name__ == "__main__":
    main()
