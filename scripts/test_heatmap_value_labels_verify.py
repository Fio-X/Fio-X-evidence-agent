#!/usr/bin/env python3
"""Integrity-verifier tests for the heatmap value_labels re-derivation (NEWSROOM_HEATMAP_VALUE_LABELS=1).

Mirrors test_choropleth_value_labels_verify.py: a heatmap whose render_qa report CLAIMS a passing value_labels proof
must have that proof re-derived from the SVG on disk (scripts/verify_artifact.py verify_heatmap_labels_from_svg,
mirroring src/verify.rs). Switch off (unset, "0", "true", ""): nothing changes. No claim: nothing to re-derive.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid, write_json, write_text
from test_choropleth_value_labels_verify import make_render_qa_report
from verify_artifact import load_json, verify

CELL = '<rect data-role="heatmap-cell" data-x="2020" data-y="A" data-value="66.6" x="10" y="10" width="40" height="30" fill="#ccc"/>'
LABEL = '<text data-role="heatmap-cell-value" data-x="2020" data-y="A" x="30" y="25" text-anchor="middle" font-size="12">66.6</text>'


def svg(label: str = LABEL, cell: str = CELL) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" role="img"><title>Fixture heatmap</title>'
        f"<desc>Accessible fixture heatmap for integrity tests.</desc>{cell}{label}</svg>\n"
    )


def add_heatmap(root: Path, svg_text: str, *, claims_passed: bool = True):
    base = load_json(root / "visualizations" / "chart.json")
    plan_ref, lint_ref, manifest_ref = "visualizations/plans/heat.json", "visualizations/lints/heat.json", "visualizations/heat.json"
    desktop_ref, mobile_ref, qa_ref = "visualizations/heat.svg", "visualizations/heat.mobile.svg", "visualizations/qa/heat.json"
    write_json(root / plan_ref, {"claim_id": "claim-valid", "chart_type": "heatmap", "title": "Fixture heatmap", "sql": "select 1"})
    write_json(root / lint_ref, {"passed": True, "plan_ref": plan_ref, "computation_ref": base["computation_ref"], "data_hash": base["data_hash"], "blockers": []})
    write_text(root / desktop_ref, svg_text)
    write_text(root / mobile_ref, svg_text)
    write_json(root / qa_ref, make_render_qa_report(svg_text, svg_text, value_labels_passed=claims_passed, include_value_labels=True))
    write_json(root / manifest_ref, {
        "schema_version": "0.10.0", "plan_ref": plan_ref, "lint_ref": lint_ref, "computation_ref": base["computation_ref"],
        "claim_id": "claim-valid", "data_hash": base["data_hash"], "chart_type": "heatmap",
        "variants": {"desktop": desktop_ref, "mobile": mobile_ref},
    })
    write_json(root / "visualizations/critics/heat.json", {"passed": True, "score": 98, "manifest_ref": manifest_ref, "render_qa_ref": qa_ref})


def run(name: str, svg_text: str, switch, expect_needle, claims_passed: bool = True):
    old = os.environ.get("NEWSROOM_HEATMAP_VALUE_LABELS")
    if switch is None:
        os.environ.pop("NEWSROOM_HEATMAP_VALUE_LABELS", None)
    else:
        os.environ["NEWSROOM_HEATMAP_VALUE_LABELS"] = switch
    try:
        with tempfile.TemporaryDirectory(prefix=f"newsroom-heatmap-{name}-") as tmp:
            root = Path(tmp)
            build_valid(root)
            add_heatmap(root, svg_text, claims_passed=claims_passed)
            report = verify(root)
    finally:
        if old is None:
            os.environ.pop("NEWSROOM_HEATMAP_VALUE_LABELS", None)
        else:
            os.environ["NEWSROOM_HEATMAP_VALUE_LABELS"] = old
    if expect_needle is None:
        if not report.passed:
            raise SystemExit(f"FAIL: {name} expected to verify: {report.errors}")
    else:
        if report.passed or not any(expect_needle in e for e in report.errors):
            raise SystemExit(f"FAIL: {name} expected an error containing '{expect_needle}': {report.errors}")
    print(f"PASS: {name}")


def main() -> int:
    needle = "independent value-labels re-derivation failed"
    run("heatmap-real-labels-verify-switch-on", svg(), "1", None)
    run("heatmap-label-missing-but-claimed-fails-switch-on", svg(label=""), "1", needle)
    run("heatmap-wrong-number-claimed-fails-switch-on", svg(label=LABEL.replace(">66.6<", ">12.3<")), "1", needle)
    run("heatmap-small-font-claimed-fails-switch-on", svg(label=LABEL.replace('font-size="12"', 'font-size="9"')), "1", needle)
    run("heatmap-label-outside-cell-claimed-fails-switch-on", svg(label=LABEL.replace('x="30"', 'x="90"')), "1", needle)
    run("heatmap-no-claim-nothing-to-rederive", svg(label=""), "1", None, claims_passed=False)
    for off in (None, "0", "true", ""):
        run(f"heatmap-label-missing-switch-off-{off!r}-unchanged", svg(label=""), off, None)
    print("heatmap value_labels verifier suite: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
