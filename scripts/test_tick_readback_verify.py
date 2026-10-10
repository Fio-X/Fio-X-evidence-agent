#!/usr/bin/env python3
"""Tests for the Python tick / value-label read-back (NEWSROOM_QA_TICK_READBACK=1) in verify_artifact.py.

Reads the same scripts/fixtures/tick_readback/cases.json as the JS and Rust tests: every correct sample has 0
failures, every tamper is red with the named rule, an uncovered chart type is reported "uncovered" (never a pass),
and the switch matrix (unset, 0, empty, yes, " 1", on) leaves verify() output untouched.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid, write_json, write_text
from verify_artifact import load_json, verify, verify_tick_readback_from_svg

DIR = Path(__file__).resolve().parent / "fixtures" / "tick_readback"
FIXTURES = json.loads((DIR / "fixtures.json").read_text(encoding="utf-8"))
CASES = json.loads((DIR / "cases.json").read_text(encoding="utf-8"))


def build(case: dict):
    f = FIXTURES[case["fixture"]]
    svg = (DIR / f["file"]).read_text(encoding="utf-8")
    for edit in case.get("edits", []):
        assert edit["find"] in svg, f"{case['name']}: edit target not found: {edit['find']}"
        svg = svg.replace(edit["find"], edit["replace"], 1)
    rows = list(f["rows"]) + ([case["rows_extra"]] if case.get("rows_extra") else [])
    ctx = {"chart_type": f["chart_type"], "rows": rows, "category_field": f["category_field"], "value_field": f["value_field"], "series_field": f.get("series_field"), "period_field": f.get("period_field"), "unit": f.get("unit"), "language": f.get("language")}
    ctx.update(case.get("ctx", {}))
    for key in case.get("ctx_drop", []):
        ctx.pop(key, None)
    return svg, ctx


def run_cases() -> int:
    for case in CASES:
        svg, ctx = build(case)
        status, failures = verify_tick_readback_from_svg(svg, ctx)
        rules = [rule for rule, _ in failures]
        if case["expect"] == "green":
            assert not failures, f"{case['name']}: {failures}"
        elif case["expect"] == "uncovered":
            assert status == "uncovered" and not failures, case["name"]
        else:
            assert case["rule"] in rules, f"{case['name']}: expected {case['rule']}, got {rules}"
    return len(CASES)


def add_bar_chart(root: Path, svg_text: str, f: dict):
    base = load_json(root / "visualizations" / "chart.json")
    comp_ref = base["computation_ref"]
    comp = load_json(root / comp_ref)
    comp["rows"] = f["rows"]
    write_json(root / comp_ref, comp)
    plan_ref, lint_ref, manifest_ref = "visualizations/plans/bar.json", "visualizations/lints/bar.json", "visualizations/bar.json"
    desktop_ref = "visualizations/bar.svg"
    write_json(root / plan_ref, {"claim_id": "claim-valid", "chart_type": f["chart_type"], "category_field": f["category_field"], "value_field": f["value_field"], **({"series_field": f["series_field"]} if f.get("series_field") else {}), **({"period_field": f["period_field"]} if f.get("period_field") else {}), "sql": "select 1"})
    write_json(root / lint_ref, {"passed": True, "plan_ref": plan_ref, "computation_ref": comp_ref, "data_hash": base["data_hash"], "blockers": []})
    write_text(root / desktop_ref, svg_text)
    write_json(root / manifest_ref, {"schema_version": "0.10.0", "plan_ref": plan_ref, "lint_ref": lint_ref, "computation_ref": comp_ref, "claim_id": "claim-valid", "data_hash": base["data_hash"], "chart_type": f["chart_type"], "variants": {"desktop": desktop_ref}})
    write_json(root / "visualizations/critics/bar.json", {"passed": True, "score": 98, "manifest_ref": manifest_ref})


def verify_tree(case: dict, switch, chart_type=None):
    old = os.environ.get("NEWSROOM_QA_TICK_READBACK")
    if switch is None:
        os.environ.pop("NEWSROOM_QA_TICK_READBACK", None)
    else:
        os.environ["NEWSROOM_QA_TICK_READBACK"] = switch
    try:
        with tempfile.TemporaryDirectory(prefix="newsroom-tick-readback-") as tmp:
            root = Path(tmp)
            build_valid(root)
            svg, _ctx = build(case)
            f = dict(FIXTURES[case["fixture"]])
            if chart_type:
                f["chart_type"] = chart_type
            add_bar_chart(root, svg, f)
            report = verify(root)
            return list(report.errors), list(report.warnings), report.checks
    finally:
        if old is None:
            os.environ.pop("NEWSROOM_QA_TICK_READBACK", None)
        else:
            os.environ["NEWSROOM_QA_TICK_READBACK"] = old


def run_wiring():
    green = CASES[0]
    red = next(c for c in CASES if c["name"].startswith("t1 tick text 500万 -> 5000万 (A)"))
    base_errors, _, base_checks = verify_tree(green, None)
    # off: every other switch value gives exactly the unset result, even for a tampered chart
    red_unset = verify_tree(red, None)
    for value in ("0", "", "yes", " 1", "on"):
        assert verify_tree(red, value) == red_unset, f"switch {value!r} changed verify() output"
    # on, correct chart: no extra error; tampered chart: red with the rule named
    on_green_errors, _, on_checks = verify_tree(green, "1")
    assert on_green_errors == base_errors, on_green_errors
    on_red_errors, _, _ = verify_tree(red, "1")
    assert any("tick read-back tick_text" in e for e in on_red_errors), on_red_errors
    # an uncovered chart type is recorded as a warning, never as a passed check
    _, warnings, _ = verify_tree(green, "1", chart_type="line")
    assert any("tick read-back not covered for chart type line" in w for w in warnings), warnings
    _, warnings_off, _ = verify_tree(green, None, chart_type="line")
    assert not any("tick read-back" in w for w in warnings_off)


if __name__ == "__main__":
    count = run_cases()
    run_wiring()
    print(f"ok test_tick_readback_verify: {count} cases + verify() wiring and switch matrix")
