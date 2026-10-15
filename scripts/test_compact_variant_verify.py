#!/usr/bin/env python3
"""Integrity-verifier tests for the visualization "compact" SVG variant.

A visualization manifest may list variants desktop/mobile/compact. A listed
compact variant needs the same existence/markup/size checks, a matching
manifest.hashes.compact_sha256 (fail closed), and a render QA binding through
viewports.compact.svg_sha256. Old desktop-only manifests keep passing.
Mirrors the Rust tests in src/verify.rs (compact_* / unknown_visualization_*).
"""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path

os.environ["NEWSROOM_REVIEW_SPLIT"] = "0"  # old-layout fixtures: state it, do not rely on the switch being unset
from selftest_evaluator import build_valid, write_json, write_text
from verify_artifact import load_json, verify


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def svg(label: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" role="img">'
        f"<title>Fixture {label}</title><desc>Accessible fixture chart ({label}) for integrity tests.</desc>"
        '<rect x="0" y="0" width="10" height="10" fill="#ccc"/></svg>\n'
    )


def qa_viewport(text: str):
    return {
        "svg_sha256": sha(text),
        "passed": True,
        "geometry": {"passed": True, "failures": [], "notes": [], "summary": {}},
        "contrast": {"passed": True, "failures": [], "unmeasured": []},
    }


def add_viz(root: Path, *, compact: bool = True, hashes: str = "ok", tweak=None):
    base = load_json(root / "visualizations" / "chart.json")
    comp_ref, data_hash = base["computation_ref"], base["data_hash"]
    plan_ref, lint_ref, manifest_ref = "visualizations/plans/cmp.json", "visualizations/lints/cmp.json", "visualizations/cmp.json"
    write_json(root / plan_ref, {"claim_id": "claim-valid", "chart_type": "bar", "title": "Fixture", "sql": "select 1"})
    write_json(root / lint_ref, {"passed": True, "plan_ref": plan_ref, "computation_ref": comp_ref, "data_hash": data_hash, "blockers": []})
    desktop, compact_text = svg("desktop"), svg("compact")
    write_text(root / "visualizations/cmp.svg", desktop)
    variants = {"desktop": "visualizations/cmp.svg"}
    viewports = {"desktop": qa_viewport(desktop)}
    manifest_hashes = {"desktop_sha256": sha(desktop)}
    if compact:
        write_text(root / "visualizations/cmp.compact.svg", compact_text)
        variants["compact"] = "visualizations/cmp.compact.svg"
        viewports["compact"] = qa_viewport(compact_text)
        manifest_hashes["compact_sha256"] = sha(compact_text)
    if hashes == "bad":
        manifest_hashes["compact_sha256"] = "0" * 64
    elif hashes == "missing":
        manifest_hashes.pop("compact_sha256", None)
    elif hashes == "none":
        manifest_hashes = {}
    write_json(root / "visualizations/qa/cmp.json", {
        "schema_version": "render-qa/1.0.0", "geometry_check_version": "0.1.0", "contrast_check_version": "1.0.0",
        "passed": True, "failure_count": 0, "viewports": viewports,
    })
    manifest = {
        "schema_version": "0.10.0", "plan_ref": plan_ref, "lint_ref": lint_ref, "computation_ref": comp_ref,
        "claim_id": "claim-valid", "data_hash": data_hash, "chart_type": "bar",
        "variants": variants, "render_qa_ref": "visualizations/qa/cmp.json",
    }
    if manifest_hashes:
        manifest["hashes"] = manifest_hashes
    if tweak:
        tweak(root, manifest)
    write_json(root / manifest_ref, manifest)
    write_json(root / "visualizations/critics/cmp.json", {"passed": True, "score": 98, "manifest_ref": manifest_ref})


def run(name, build, needle=None):
    with tempfile.TemporaryDirectory(prefix=f"newsroom-compact-{name}-") as tmp:
        root = Path(tmp)
        build_valid(root)
        build(root)
        report = verify(root)
        if needle is None:
            if not report.passed:
                raise SystemExit(f"FAIL: {name} expected to verify: {report.errors}")
            print(f"PASS: {name}")
            return
        if report.passed or not any(needle in e for e in report.errors):
            raise SystemExit(f"FAIL: {name} expected error containing {needle!r}: passed={report.passed} {report.errors}")
        print(f"PASS: {name} -> {[e for e in report.errors if needle in e][0]}")


def main() -> int:
    run("compact-desktop-with-qa-and-hashes-verifies", lambda r: add_viz(r))
    run("desktop-only-without-hashes-verifies", lambda r: add_viz(r, compact=False, hashes="none"))

    def tamper(root):
        add_viz(root)
        write_text(root / "visualizations/cmp.compact.svg", svg("tampered"))
    run("compact-tampered-after-qa-fails", tamper, "compact SVG hash does not match render_qa report")

    run("compact-hash-mismatch-fails", lambda r: add_viz(r, hashes="bad"), "compact hash mismatch")
    run("compact-without-compact-sha256-fails", lambda r: add_viz(r, hashes="missing"), "compact variant without hashes.compact_sha256")
    run(
        "compact-sha256-without-compact-variant-fails",
        lambda r: add_viz(r, compact=False, tweak=lambda root, m: m.setdefault("hashes", {}).update({"compact_sha256": "0" * 64})),
        "hashes.compact_sha256 without a compact variant",
    )
    run(
        "unknown-variant-key-fails",
        lambda r: add_viz(r, tweak=lambda root, m: m["variants"].update({"tablet": "visualizations/cmp.svg"})),
        "unknown variant",
    )

    def stale_qa(root):
        add_viz(root)
        qa_path = root / "visualizations/qa/cmp.json"
        qa = load_json(qa_path)
        qa["viewports"]["compact"]["svg_sha256"] = "f" * 64
        write_json(qa_path, qa)
    run("compact-stale-qa-hash-fails", stale_qa, "compact SVG hash does not match render_qa report")

    # A listed compact variant must be bound to render QA; none of these may be skipped silently.
    run("compact-without-render-qa-ref-fails", lambda r: add_viz(r, tweak=lambda root, m: m.pop("render_qa_ref")), "compact variant without a valid render_qa_ref")
    run("compact-with-invalid-render-qa-ref-fails", lambda r: add_viz(r, tweak=lambda root, m: m.update({"render_qa_ref": "elsewhere/cmp.json"})), "compact variant without a valid render_qa_ref")

    def missing_qa_file(root):
        add_viz(root)
        (root / "visualizations/qa/cmp.json").unlink()
    run("compact-with-missing-render-qa-file-fails", missing_qa_file, "render_qa report visualizations/qa/cmp.json does not exist")

    def qa_without_compact_viewport(root):
        add_viz(root)
        qa_path = root / "visualizations/qa/cmp.json"
        qa = load_json(qa_path)
        qa["viewports"].pop("compact")
        write_json(qa_path, qa)
    run("compact-with-qa-lacking-compact-viewport-fails", qa_without_compact_viewport, "missing viewports.compact.svg_sha256")

    print("compact variant verifier suite: PASS (12 cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
