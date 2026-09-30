#!/usr/bin/env python3
"""Integrity-verifier regression tests for the choropleth value_labels gate.

A choropleth's color channel is exempt from infographic lint's
color_only_quantity blocker (runtime/pi/editorial_validators.mjs) only when
its own render_qa report proves - independently, from the rendered SVG - that
every plotted region's value is shown as legible, complete, exact text
(runtime/pi/render_qa_labels.mjs). scripts/verify_artifact.py must enforce the
same rule from artifacts alone (mirroring src/verify.rs's
check_render_qa_ref extension): a choropleth visualization manifest missing
that proof, or whose proof does not match the SVG actually on disk, must fail
verification even though nothing else about it is wrong.

Builds on selftest_evaluator.build_valid's already-verified fixture tree and
adds one more visualization manifest (chart_type="choropleth") alongside it,
exactly the way add_ungated_legacy_chart_manifest (test_integrity_adversarial.py)
adds an extra manifest under visualizations/ to a valid baseline.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid, write_json, write_text
from verify_artifact import load_json, verify


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


CHOROPLETH_SVG_TEMPLATE = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" role="img">'
    "<title>Fixture choropleth</title>"
    "<desc>Accessible fixture choropleth map for integrity tests.</desc>"
    '<path data-role="choropleth-data" data-iso3="KEN" data-value="12" d="M0,0 L10,0 L10,10 Z" fill="#ccc"/>'
    '<text data-role="choropleth-label" data-iso3="KEN">Kenya</text>'
    '<text data-role="choropleth-label-value" data-iso3="KEN"><tspan>12</tspan></text>'
    '<path data-role="choropleth-context" d="M20,0 L30,0 L30,10 Z" fill="#d9dedb"/>'
    "</svg>\n"
)


def make_render_qa_report(desktop_svg: str, mobile_svg: str, value_labels_passed: bool = True, include_value_labels: bool = True):
    def viewport(svg_text: str):
        report = {
            "svg_sha256": sha(svg_text),
            "passed": True,
            "geometry": {"passed": True, "failures": [], "notes": [], "summary": {}},
            "contrast": {"passed": True, "failures": [], "unmeasured": []},
        }
        if include_value_labels:
            report["value_labels"] = {
                "passed": value_labels_passed,
                "checked": 1,
                "failures": [] if value_labels_passed else [{"rule": "value_label_missing", "message": "fixture failure"}],
            }
        return report

    return {
        "schema_version": "render-qa/1.0.0",
        "geometry_check_version": "0.1.0",
        "contrast_check_version": "1.0.0",
        "passed": True,
        "failure_count": 0,
        "viewports": {"desktop": viewport(desktop_svg), "mobile": viewport(mobile_svg)},
    }


def add_choropleth_visualization(root: Path, *, value_labels_passed: bool = True, include_value_labels: bool = True, include_render_qa_ref: bool = True):
    # Reuse build_valid's own already-content-addressed computation
    # (visualizations/chart.json's computation_ref/data_hash) rather than
    # fabricating a new one: this test is only about the choropleth
    # value_labels gate, not about re-deriving a fresh, correctly hashed
    # computation artifact from scratch.
    base_manifest = load_json(root / "visualizations" / "chart.json")
    comp_ref = base_manifest["computation_ref"]
    data_hash = base_manifest["data_hash"]

    plan_ref = "visualizations/plans/map.json"
    lint_ref = "visualizations/lints/map.json"
    manifest_ref = "visualizations/map.json"
    desktop_ref = "visualizations/map.svg"
    mobile_ref = "visualizations/map.mobile.svg"

    write_json(root / plan_ref, {"claim_id": "claim-valid", "chart_type": "choropleth", "title": "Fixture map", "sql": "select country,value"})
    write_json(root / lint_ref, {"passed": True, "plan_ref": plan_ref, "computation_ref": comp_ref, "data_hash": data_hash, "blockers": []})

    write_text(root / desktop_ref, CHOROPLETH_SVG_TEMPLATE)
    write_text(root / mobile_ref, CHOROPLETH_SVG_TEMPLATE)

    manifest = {
        "schema_version": "0.10.0",
        "plan_ref": plan_ref,
        "lint_ref": lint_ref,
        "computation_ref": comp_ref,
        "claim_id": "claim-valid",
        "data_hash": data_hash,
        "chart_type": "choropleth",
        "variants": {"desktop": desktop_ref, "mobile": mobile_ref},
    }
    if include_render_qa_ref:
        render_qa_ref = "visualizations/qa/map.json"
        write_json(
            root / render_qa_ref,
            make_render_qa_report(CHOROPLETH_SVG_TEMPLATE, CHOROPLETH_SVG_TEMPLATE, value_labels_passed, include_value_labels),
        )
        manifest["render_qa_ref"] = render_qa_ref
    write_json(root / manifest_ref, manifest)
    write_json(root / "visualizations/critics/map.json", {"passed": True, "score": 98, "manifest_ref": manifest_ref})
    return manifest_ref


def must_pass(name, build):
    with tempfile.TemporaryDirectory(prefix=f"newsroom-choropleth-{name}-") as tmp:
        root = Path(tmp)
        build_valid(root)
        build(root)
        report = verify(root)
        if not report.passed:
            raise SystemExit(f"FAIL: {name} expected to verify but did not: {report.errors}")
        print(f"PASS: {name}")


def must_fail(name, build, needle):
    with tempfile.TemporaryDirectory(prefix=f"newsroom-choropleth-{name}-") as tmp:
        root = Path(tmp)
        build_valid(root)
        build(root)
        report = verify(root)
        if report.passed:
            raise SystemExit(f"FAIL: {name} expected to fail verification but passed")
        if not any(needle in e for e in report.errors):
            raise SystemExit(f"FAIL: {name} did not produce expected error containing '{needle}': {report.errors}")
        print(f"PASS: {name} -> {[e for e in report.errors if needle in e][0]}")


def main() -> int:
    must_pass("choropleth-with-passing-value-labels-verifies", lambda root: add_choropleth_visualization(root))
    must_fail(
        "choropleth-missing-value-labels-fails",
        lambda root: add_choropleth_visualization(root, include_value_labels=False),
        "missing a passing value_labels check",
    )
    must_fail(
        "choropleth-failing-value-labels-fails",
        lambda root: add_choropleth_visualization(root, value_labels_passed=False),
        "missing a passing value_labels check",
    )
    must_fail(
        "choropleth-missing-render-qa-ref-fails",
        lambda root: add_choropleth_visualization(root, include_render_qa_ref=False),
        "missing or invalid render_qa_ref",
    )

    def tamper(root: Path):
        add_choropleth_visualization(root)
        path = root / "visualizations" / "map.svg"
        path.write_text(path.read_text(encoding="utf-8").replace("Kenya", "Tampered", 1), encoding="utf-8")

    must_fail("choropleth-tampered-svg-fails-hash-binding", tamper, "SVG hash does not match render_qa report")

    # Review fix 7: a render_qa report that is honestly, correctly
    # sha256-bound to the SVG on disk, and claims value_labels.passed:
    # true, must still fail full artifact verification when that SVG
    # genuinely has no value label for a plotted region - the exact case
    # hash-binding alone cannot catch (the hash matches; the report's own
    # boolean says everything is fine). This exercises
    # verify_choropleth_labels_from_svg's independent, from-scratch
    # re-derivation, wired into verify() itself, not just its unit tests.
    def label_missing_but_report_says_passed(root: Path):
        svg = CHOROPLETH_SVG_TEMPLATE.replace('<text data-role="choropleth-label-value" data-iso3="KEN"><tspan>12</tspan></text>', "")
        assert "choropleth-label-value" not in svg
        base_manifest = load_json(root / "visualizations" / "chart.json")
        comp_ref = base_manifest["computation_ref"]
        data_hash = base_manifest["data_hash"]
        plan_ref = "visualizations/plans/map.json"
        lint_ref = "visualizations/lints/map.json"
        manifest_ref = "visualizations/map.json"
        desktop_ref = "visualizations/map.svg"
        mobile_ref = "visualizations/map.mobile.svg"
        write_json(root / plan_ref, {"claim_id": "claim-valid", "chart_type": "choropleth", "title": "Fixture map", "sql": "select country,value"})
        write_json(root / lint_ref, {"passed": True, "plan_ref": plan_ref, "computation_ref": comp_ref, "data_hash": data_hash, "blockers": []})
        write_text(root / desktop_ref, svg)
        write_text(root / mobile_ref, svg)
        render_qa_ref = "visualizations/qa/map.json"
        write_json(root / render_qa_ref, make_render_qa_report(svg, svg, value_labels_passed=True, include_value_labels=True))
        write_json(root / manifest_ref, {
            "schema_version": "0.10.0",
            "plan_ref": plan_ref,
            "lint_ref": lint_ref,
            "computation_ref": comp_ref,
            "claim_id": "claim-valid",
            "data_hash": data_hash,
            "chart_type": "choropleth",
            "variants": {"desktop": desktop_ref, "mobile": mobile_ref},
            "render_qa_ref": render_qa_ref,
        })
        write_json(root / "visualizations/critics/map.json", {"passed": True, "score": 98, "manifest_ref": manifest_ref})

    must_fail(
        "choropleth-report-claims-passed-over-label-missing-svg-fails-independent-rederivation",
        label_missing_but_report_says_passed,
        "independent value-labels re-derivation failed",
    )

    print("choropleth value_labels verifier suite: PASS (6 cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
