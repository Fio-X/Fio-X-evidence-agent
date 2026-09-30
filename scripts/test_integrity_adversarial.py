#!/usr/bin/env python3
"""Adversarial integrity tests for content-addressed newsroom artifacts."""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid
from verify_artifact import canonical_rows_json, verify


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def claim(root: Path):
    return json.loads((root / "claims.jsonl").read_text(encoding="utf-8"))


def set_claim(root: Path, value):
    (root / "claims.jsonl").write_text(json.dumps(value) + "\n", encoding="utf-8")


def must_fail(name, mutate):
    with tempfile.TemporaryDirectory(prefix=f"newsroom-integrity-{name}-") as tmp:
        root = Path(tmp)
        build_valid(root)
        baseline = verify(root)
        if not baseline.passed:
            raise SystemExit(f"baseline unexpectedly invalid for {name}: {baseline.errors}")
        mutate(root)
        report = verify(root)
        if report.passed:
            raise SystemExit(f"FAIL: adversarial case passed integrity verifier: {name}")
        print(f"PASS adversary: {name} -> {report.errors[0]}")


def tamper_dataset(root: Path):
    ref = claim(root)["source_refs"][1]
    with (root / ref).open("ab") as f:
        f.write(b"C,2024,999\n")


def tamper_source_body(root: Path):
    ref = claim(root)["source_refs"][0]
    source = load_json(root / ref)
    source["text"] = "tampered source body"
    write_json(root / ref, source)


def tamper_source_trust(root: Path):
    ref = claim(root)["source_refs"][0]
    source = load_json(root / ref)
    source["trust"] = "trusted"
    write_json(root / ref, source)

def tamper_computation_rows(root: Path):
    ref = claim(root)["computation_refs"][0]
    comp = load_json(root / ref)
    comp["rows"][0]["value"] = 999
    write_json(root / ref, comp)


def tamper_input_fingerprints(root: Path):
    ref = claim(root)["computation_refs"][0]
    comp = load_json(root / ref)
    comp["input_fingerprints"] = ["data:data/does-not-exist.csv:" + "0" * 64]
    write_json(root / ref, comp)

def rename_source_off_hash(root: Path):
    c = claim(root)
    old = c["source_refs"][0]
    new = "sources/not-content-addressed.json"
    shutil.move(root / old, root / new)
    c["source_refs"][0] = new
    set_claim(root, c)
    story = load_json(root / "story.json")
    story["evidence"]["sources"] = [new]
    write_json(root / "story.json", story)


def rename_computation_off_hash(root: Path):
    c = claim(root)
    old = c["computation_refs"][0]
    new = "computations/not-content-addressed.json"
    shutil.move(root / old, root / new)
    c["computation_refs"][0] = new
    set_claim(root, c)
    story = load_json(root / "story.json")
    story["evidence"]["computations"] = [new]
    write_json(root / "story.json", story)
    for path in (root / "visualizations").glob("*.json"):
        obj = load_json(path)
        if obj.get("computation_ref") == old:
            obj["computation_ref"] = new
            write_json(path, obj)
    for path in (root / "visualizations" / "lints").glob("*.json"):
        obj = load_json(path)
        if obj.get("computation_ref") == old:
            obj["computation_ref"] = new
            write_json(path, obj)


def remove_mobile_svg(root: Path):
    manifest = next(p for p in (root / "visualizations").glob("*.json") if "variants" in load_json(p))
    ref = load_json(manifest)["variants"]["mobile"]
    (root / ref).unlink()


def path_traversal_claim(root: Path):
    c = claim(root)
    c["source_refs"] = ["../outside.json"]
    set_claim(root, c)


def forge_model_verified_claim(root: Path):
    c = claim(root)
    c.pop("verification", None)
    c.pop("requested_status", None)
    c["status"] = "verified"
    set_claim(root, c)


def tamper_run_metrics(root: Path):
    rows = (root / "run-metrics.jsonl").read_text(encoding="utf-8").splitlines()
    first = json.loads(rows[0])
    first["duration_ms"] = -1
    rows[0] = json.dumps(first)
    (root / "run-metrics.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")


def tamper_infographic_svg(root: Path):
    manifest = next(p for p in (root / "infographics").glob("*.json") if load_json(p).get("schema_version") in {"1.0.0", "1.1.0", "1.2.0"} and "variants" in load_json(p))
    ref = load_json(manifest)["variants"]["desktop"]
    path = root / ref
    path.write_text(path.read_text(encoding="utf-8").replace("Magazine fixture", "Tampered magazine fixture", 1), encoding="utf-8")

def remove_infographic_upstream_visual(root: Path):
    manifest = next(p for p in (root / "infographics").glob("*.json") if load_json(p).get("schema_version") in {"1.0.0", "1.1.0", "1.2.0"} and "variants" in load_json(p))
    obj = load_json(manifest)
    obj["visual_manifest_refs"] = ["visualizations/DOES-NOT-EXIST.json", "visualizations/DOES-NOT-EXIST-2.json"]
    write_json(manifest, obj)


def infographic_zh_plan_with_english_strip(root: Path):
    # The plan says zh but the SVG (already rendered by build_valid's
    # baseline) still carries the English strip untouched - the source
    # strip's expected language is read from the hash-bound plan, never
    # inferred from "does the SVG contain some strip at all".
    manifest = next(p for p in (root / "infographics").glob("*.json") if load_json(p).get("schema_version") in {"1.0.0", "1.1.0", "1.2.0"} and "variants" in load_json(p))
    plan_path = root / load_json(manifest)["plan_ref"]
    plan = load_json(plan_path)
    plan["language"] = "zh"
    write_json(plan_path, plan)


def tamper_explanatory_svg(root: Path):
    manifest = next(p for p in (root / "visualizations" / "illustrations").glob("*.json") if load_json(p).get("schema_version") == "0.1.0" and "variants" in load_json(p))
    ref = load_json(manifest)["variants"]["desktop"]
    path = root / ref
    path.write_text(path.read_text(encoding="utf-8").replace("SCHEMATIC / NOT TO SCALE", "SCHEMATIC", 1), encoding="utf-8")

def remove_infographic_upstream_illustration(root: Path):
    manifest = next(p for p in (root / "infographics").glob("*.json") if load_json(p).get("schema_version") in {"1.0.0", "1.1.0", "1.2.0"} and "variants" in load_json(p))
    obj = load_json(manifest)
    obj["illustration_manifest_refs"] = ["visualizations/illustrations/DOES-NOT-EXIST.json"]
    write_json(manifest, obj)


def tamper_visual_revision_replay(root: Path):
    revision_path = root / "infographics" / "revisions" / "page.json"
    revision = load_json(revision_path)
    revision["applied_patches"][0]["value"] = "half"
    write_json(revision_path, revision)
    vision_path = root / revision["vision_critic_ref"]
    vision = load_json(vision_path)
    vision["patches"][0]["value"] = "half"
    write_json(vision_path, vision)


def tamper_competition_preflight(root: Path):
    path = root / "infographics" / "competition-preflight" / "page.json"
    preflight = load_json(path)
    preflight["machine_passed"] = False
    write_json(path, preflight)


def add_ungated_legacy_chart_manifest(root: Path):
    # Mirrors exactly what runtime/pi/newsroom.ts's legacy newsroom_chart
    # tool writes directly under visualizations/: no plan_ref, no
    # variants - a bypass of newsroom_viz_plan -> lint -> render, which
    # would otherwise never be linted, render-QA'd or critiqued.
    write_json(root / "visualizations" / "legacy-chart.json", {
        "schema_version": "0.7.0",
        "claim_id": "does-not-matter",
        "computation_ref": "computations/does-not-matter.json",
        "title": "Legacy chart",
        "chart_type": "bar",
        "sql": "select 1",
        "x_field": "x",
        "y_field": "y",
        "source_note": "Fixture",
        "svg": "visualizations/legacy-chart.svg",
    })
    (root / "visualizations" / "legacy-chart.svg").write_text("<svg></svg>", encoding="utf-8")


def add_valid_publication(root: Path) -> str:
    # Mirrors newsroom_publication_plan -> newsroom_publication_render ->
    # newsroom_publication_qa's on-disk shapes. Self-contained (its own
    # asset/infographic-plan refs) rather than reusing build_valid's own
    # fixtures, and uses an asset (bare SVG file) evidence binding instead
    # of a computation one so this helper never has to satisfy the
    # unrelated computations/*.json schema checked earlier in verify().
    # infographic_plan_ref binds to add_clean_1_4_0_infographic's own
    # plan_ref (infographics/plans/x.json), a top-level, non-rejected
    # infographic manifest with a real passing critic -
    # verify_publication_infographic_lineage requires that lineage, not
    # just a plan file on disk.
    for d in ("publications/plans", "publications/qa", "visualizations", "infographics/plans"):
        (root / d).mkdir(parents=True, exist_ok=True)
    (root / "visualizations" / "pub-asset.svg").write_text("<svg></svg>", encoding="utf-8")
    add_clean_1_4_0_infographic(root)
    plan = {
        "schema_version": "0.3.0",
        "infographic_plan_ref": "infographics/plans/x.json",
        "delivery": {"breakpoints": [1440]},
        "modules": [
            {"id": "m1", "evidence_binding": {"kind": "asset", "ref": "visualizations/pub-asset.svg"}},
        ],
    }
    write_json(root / "publications" / "plans" / "plan.json", plan)
    html = "<html>fixture</html>"
    key = hashlib.sha256(html.encode("utf-8")).hexdigest()
    (root / "publications" / key).mkdir(parents=True, exist_ok=True)
    (root / "publications" / key / "index.html").write_text(html, encoding="utf-8")
    write_json(root / "publications" / key / "manifest.json", {
        "plan_ref": "publications/plans/plan.json",
        "html_ref": f"publications/{key}/index.html",
        "html_sha256": key,
    })
    (root / "publications" / "qa" / "q1").mkdir(parents=True, exist_ok=True)
    shot_bytes = b"fake-screenshot-bytes"
    shot_sha = hashlib.sha256(shot_bytes).hexdigest()
    (root / "publications" / "qa" / "q1" / "publication-1440.png").write_bytes(shot_bytes)
    (root / "publications" / "qa" / "q1" / "archive.png").write_bytes(shot_bytes)
    write_json(root / "publications" / "qa" / "q1" / "browser-qa.json", {
        "html_sha256": key,
        "status": "PASS",
        "screenshots": [{"width": 1440, "path": "publication-1440.png", "sha256": shot_sha}],
        "archive_fallback": {"path": "archive.png", "sha256": shot_sha, "source_width": 1440},
    })
    return key


def tamper_publication_html(root: Path):
    key = add_valid_publication(root)
    (root / "publications" / key / "index.html").write_text("<html>tampered</html>", encoding="utf-8")


def remove_publication_qa(root: Path):
    add_valid_publication(root)
    shutil.rmtree(root / "publications" / "qa" / "q1")


def fail_publication_qa(root: Path):
    key = add_valid_publication(root)
    qa_path = root / "publications" / "qa" / "q1" / "browser-qa.json"
    qa = load_json(qa_path)
    qa["status"] = "FAIL"
    write_json(qa_path, qa)


def tamper_publication_qa_screenshot(root: Path):
    add_valid_publication(root)
    (root / "publications" / "qa" / "q1" / "publication-1440.png").write_bytes(b"tampered-bytes")


def mismatch_publication_breakpoints(root: Path):
    add_valid_publication(root)
    plan_path = root / "publications" / "plans" / "plan.json"
    plan = load_json(plan_path)
    plan["delivery"]["breakpoints"] = [768]
    write_json(plan_path, plan)


def add_portable_publication_without_qa(root: Path):
    # The portable path's own tool result says plainly "this does not
    # replace browser QA" - it must not verify without one either.
    key = add_valid_publication(root)
    shutil.rmtree(root / "publications" / "qa" / "q1")
    manifest_path = root / "publications" / key / "manifest.json"
    manifest = load_json(manifest_path)
    manifest["portable_fallback"] = True
    write_json(manifest_path, manifest)


def add_ungated_lieflat_chart_manifest(root: Path):
    # Mirrors runtime/pi/lieflat.mjs's chart mode: kind=lieflat_chart,
    # variants present (so it would not trip the generic
    # no-plan_ref/variants check), but desktop_qa/artifact_status are
    # renderer constants with no render_qa_ref, lint_ref or critic at all.
    (root / "visualizations" / "lieflat.svg").write_text("<svg></svg>", encoding="utf-8")
    write_json(root / "visualizations" / "lieflat.json", {
        "schema_version": "1.0.0",
        "kind": "lieflat_chart",
        "artifact_status": "VERIFIED",
        "variants": {"desktop": "visualizations/lieflat.svg"},
        "desktop_qa": "PASS",
    })


def add_lieflat_publication(root: Path):
    # Mirrors exactly what renderLieflatPublication's report mode writes:
    # no plan_ref at all (only infographic_plan_ref, itself pointing at a
    # Lieflat-kind plan under infographics/<key>/), and no
    # publications/qa/*/browser-qa.json - only a self-issued
    # publications/<key>/qa.json.
    html = "<html>lieflat</html>"
    key = hashlib.sha256(html.encode("utf-8")).hexdigest()
    (root / "publications" / key).mkdir(parents=True, exist_ok=True)
    (root / "publications" / key / "index.html").write_text(html, encoding="utf-8")
    write_json(root / "publications" / key / "qa.json", {
        "schema_version": "1.0.0",
        "kind": "publication_qa",
        "passed": True,
    })
    write_json(root / "publications" / key / "manifest.json", {
        "schema_version": "1.0.0",
        "kind": "lieflat_publication",
        "html_ref": f"publications/{key}/index.html",
        "html_sha256": key,
        "infographic_plan_ref": "infographics/lieflat-key/plan.json",
    })


def add_rejected_publication(root: Path):
    # Mirrors what the runtime moves a browser-QA-FAILed publication into:
    # publications/rejected/<k>/{index.html, manifest.json, assets/, a copy
    # of the QA report, rejection.json}. Deliberately given a nonsensical
    # html_sha256 - if this were ever mistakenly walked as a top-level
    # publication it would fail loudly, so a passing report using it is
    # proof the directory was skipped, not that it happened to pass.
    rejected_dir = root / "publications" / "rejected" / "deadbeef"
    (rejected_dir / "assets").mkdir(parents=True, exist_ok=True)
    (rejected_dir / "index.html").write_text("<html>rejected</html>", encoding="utf-8")
    write_json(rejected_dir / "manifest.json", {
        "html_ref": "publications/rejected/deadbeef/index.html",
        "html_sha256": "not-even-a-real-hash",
    })
    write_json(rejected_dir / "rejection.json", {"reason": "browser QA FAIL"})


def add_rejected_publication_beside_tampered_real_one(root: Path):
    key = add_valid_publication(root)
    add_rejected_publication(root)
    (root / "publications" / key / "index.html").write_text("<html>tampered</html>", encoding="utf-8")


def check_rejected_publication_does_not_block_verification():
    with tempfile.TemporaryDirectory(prefix="newsroom-integrity-rejected-pub-ok-") as tmp:
        root = Path(tmp)
        build_valid(root)
        add_valid_publication(root)
        add_rejected_publication(root)
        report = verify(root)
        if not report.passed:
            raise SystemExit(f"FAIL: a rejected publication must not block verification: {report.errors}")
        print("PASS control: rejected-publication-does-not-block-verification")


def set_primary_artifact(root: Path, value):
    story_path = root / "story.json"
    story = load_json(story_path)
    story.setdefault("delivery", {})["primary_artifact"] = value
    write_json(story_path, story)


def set_primary_artifact_to_orphan_svg(root: Path):
    (root / "visualizations").mkdir(parents=True, exist_ok=True)
    (root / "visualizations" / "orphan-primary.svg").write_text("<svg></svg>", encoding="utf-8")
    set_primary_artifact(root, "visualizations/orphan-primary.svg")


def set_primary_artifact_to_dangling_publication(root: Path):
    set_primary_artifact(root, "publications/nonexistent-key/index.html")


def set_primary_artifact_to_reserved_directory_name(root: Path):
    # Same shape a publications/<k>/index.html binding would have, but k is
    # a reserved directory name (qa/plans/rejected), not a real publication
    # key - even though a manifest with a matching html_ref exists there.
    (root / "publications" / "qa").mkdir(parents=True, exist_ok=True)
    write_json(root / "publications" / "qa" / "manifest.json", {"html_ref": "publications/qa/index.html"})
    set_primary_artifact(root, "publications/qa/index.html")


def set_primary_artifact_under_rejected(root: Path):
    add_rejected_publication(root)
    set_primary_artifact(root, "publications/rejected/deadbeef/index.html")


def check_primary_artifact_publication_binding_verifies():
    with tempfile.TemporaryDirectory(prefix="newsroom-integrity-primary-pub-ok-") as tmp:
        root = Path(tmp)
        build_valid(root)
        key = add_valid_publication(root)
        set_primary_artifact(root, f"publications/{key}/index.html")
        report = verify(root)
        if not report.passed:
            raise SystemExit(f"FAIL: primary_artifact backed by a matching publication manifest should verify: {report.errors}")
        print("PASS control: primary-artifact-publication-binding-verifies")


def check_primary_artifact_svg_variant_verifies():
    # Reuses build_valid's own already-passing top-level visualization
    # manifest rather than fabricating a new one, so this positive control
    # cannot be muddied by an unrelated visualization-gating failure.
    with tempfile.TemporaryDirectory(prefix="newsroom-integrity-primary-svg-ok-") as tmp:
        root = Path(tmp)
        build_valid(root)
        target = None
        for path in sorted((root / "visualizations").glob("*.json")):
            manifest = load_json(path)
            variants = manifest.get("variants")
            if isinstance(variants, dict) and variants.get("desktop"):
                target = variants["desktop"]
                break
        if target is None:
            raise SystemExit("FAIL: no top-level visualization manifest with a desktop variant found in the valid fixture")
        set_primary_artifact(root, target)
        report = verify(root)
        if not report.passed:
            raise SystemExit(f"FAIL: primary_artifact backed by an existing top-level manifest's variants should verify: {report.errors}")
        print("PASS control: primary-artifact-svg-variant-verifies")


def add_qa_report(root: Path, key_dir_name: str, html_sha256: str, status: str):
    dir_path = root / "publications" / "qa" / key_dir_name
    dir_path.mkdir(parents=True, exist_ok=True)
    shot_bytes = b"fake-screenshot-bytes"
    shot_sha = hashlib.sha256(shot_bytes).hexdigest()
    (dir_path / "publication-1440.png").write_bytes(shot_bytes)
    (dir_path / "archive.png").write_bytes(shot_bytes)
    write_json(dir_path / "browser-qa.json", {
        "html_sha256": html_sha256,
        "status": status,
        "screenshots": [{"width": 1440, "path": "publication-1440.png", "sha256": shot_sha}],
        "archive_fallback": {"path": "archive.png", "sha256": shot_sha, "source_width": 1440},
    })


def add_two_qa_reports(root: Path, first_name: str, first_status: str, second_name: str, second_status: str) -> None:
    key = add_valid_publication(root)
    shutil.rmtree(root / "publications" / "qa" / "q1")
    add_qa_report(root, first_name, key, first_status)
    add_qa_report(root, second_name, key, second_status)


def mismatch_qa_fail_sorts_first(root: Path):
    add_two_qa_reports(root, "a-fail", "FAIL", "b-pass", "PASS")


def mismatch_qa_pass_sorts_first(root: Path):
    add_two_qa_reports(root, "a-pass", "PASS", "b-fail", "FAIL")


def check_portable_publication_with_passing_qa_verifies():
    from selftest_evaluator import build_valid
    from verify_artifact import verify
    with tempfile.TemporaryDirectory(prefix="newsroom-integrity-portable-qa-pass-") as tmp:
        root = Path(tmp)
        build_valid(root)
        key = add_valid_publication(root)
        manifest_path = root / "publications" / key / "manifest.json"
        manifest = load_json(manifest_path)
        manifest["portable_fallback"] = True
        write_json(manifest_path, manifest)
        report = verify(root)
        if not report.passed:
            raise SystemExit(f"FAIL: portable publication with a linked passing QA report should verify: {report.errors}")
        print("PASS control: portable-publication-with-passing-qa-verifies")


def add_clean_1_4_0_infographic(root: Path) -> None:
    add_clean_1_4_0_infographic_with_language(root)


def add_clean_1_4_0_infographic_with_language(root: Path, language=None, strip: str = "SOURCES &amp; METHODS") -> None:
    # Self-contained (not reusing build_valid's own 1.2.0 magazine fixture)
    # so these F7 cases aren't entangled with that fixture's own baked-in
    # data-infographic-version="1.2.0" SVG markup, version-gated plan field
    # requirements, or (for the B3 language-keyed source-strip cases) its
    # revision-chain immutability checks this task did not ask to widen or
    # touch. Two draft (claim_id-exempt) visualizations satisfy
    # visual_manifest_refs' >=2 requirement without needing a full
    # verified claim/source/computation chain.
    empty_rows_hash = hashlib.sha256(canonical_rows_json([]).encode()).hexdigest()
    for n in (1, 2):
        svg_bytes = (
            '<svg xmlns="http://www.w3.org/2000/svg"><title>t</title><desc>d</desc>'
            + ("x" * 200) + f"chart {n}</svg>\n"
        ).encode()
        (root / f"visualizations/v{n}.svg").parent.mkdir(parents=True, exist_ok=True)
        (root / f"visualizations/v{n}.svg").write_bytes(svg_bytes)
        write_json(root / f"visualizations/plans/v{n}.json", {})
        write_json(root / f"computations/v{n}.json", {"sql": "select 1", "rows": [], "result_hash": empty_rows_hash})
        write_json(root / f"visualizations/lints/v{n}.json", {
            "passed": True,
            "plan_ref": f"visualizations/plans/v{n}.json",
            "computation_ref": f"computations/v{n}.json",
        })
        write_json(root / f"visualizations/critics/v{n}.json", {"manifest_ref": f"visualizations/v{n}.json", "passed": True})
        write_json(root / f"visualizations/v{n}.json", {
            "artifact_status": "DRAFT",
            "plan_ref": f"visualizations/plans/v{n}.json",
            "lint_ref": f"visualizations/lints/v{n}.json",
            "variants": {"desktop": f"visualizations/v{n}.svg"},
        })

    svg_desktop = (
        '<svg xmlns="http://www.w3.org/2000/svg" data-infographic-version="1.4.0">'
        "<title>t</title><desc>d</desc>" + ("x" * 500) + f"{strip}</svg>\n"
    ).encode()
    (root / "infographics").mkdir(parents=True, exist_ok=True)
    (root / "infographics/x.svg").write_bytes(svg_desktop)
    desktop_sha = hashlib.sha256(svg_desktop).hexdigest()
    plan = {"schema_version": "1.4.0"}
    if language is not None:
        plan["language"] = language
    write_json(root / "infographics/plans/x.json", plan)
    write_json(root / "infographics/lints/x.json", {"passed": True, "plan_ref": "infographics/plans/x.json"})
    write_json(root / "infographics/critics/x.json", {
        "manifest_ref": "infographics/x.json",
        "passed": True,
        "rubric": {k: 90 for k in (
            "impact_story_focus", "engagement", "clarity_information_flow", "effectiveness", "hierarchy",
            "editorial_rhythm", "inclusion_accessibility", "responsive_execution", "craft_geometry", "originality_variety",
        )},
    })
    write_json(root / "infographics/x.json", {
        "schema_version": "1.4.0",
        "plan_ref": "infographics/plans/x.json",
        "lint_ref": "infographics/lints/x.json",
        "variants": {"desktop": "infographics/x.svg"},
        "hashes": {"desktop_sha256": desktop_sha},
        "visual_manifest_refs": ["visualizations/v1.json", "visualizations/v2.json"],
    })


def infographic_1_4_0_without_passing_critic(root: Path):
    # Before F7, Python's version gate only recognized up to 1.3.0 and
    # silently skipped anything else, so a 1.4.0 page with no critic at all
    # used to verify clean even though infographic.mjs's own
    # INFOGRAPHIC_SCHEMA_VERSIONS accepts 1.4.0 and
    # newsroom_infographic_render copies schema_version straight from the
    # spec into the manifest.
    add_clean_1_4_0_infographic(root)
    (root / "infographics" / "critics" / "x.json").unlink()


def infographic_unsupported_schema_version(root: Path):
    add_clean_1_4_0_infographic(root)
    manifest_path = root / "infographics" / "x.json"
    manifest = load_json(manifest_path)
    manifest["schema_version"] = "1.9.0"
    write_json(manifest_path, manifest)


def infographic_missing_plan_ref(root: Path):
    add_clean_1_4_0_infographic(root)
    manifest_path = root / "infographics" / "x.json"
    manifest = load_json(manifest_path)
    del manifest["plan_ref"]
    write_json(manifest_path, manifest)


def check_clean_1_4_0_infographic_verifies():
    with tempfile.TemporaryDirectory(prefix="newsroom-integrity-infographic-1-4-0-ok-") as tmp:
        root = Path(tmp)
        build_valid(root)
        add_clean_1_4_0_infographic(root)
        report = verify(root)
        if not report.passed:
            raise SystemExit(f"FAIL: a clean 1.4.0 infographic should verify: {report.errors}")
        print("PASS control: clean-1-4-0-infographic-verifies")


def publication_infographic_upstream_rejected(root: Path):
    # The exact africa-01 dev-run shape verify_publication_infographic_lineage
    # closes: a publication bound to a plan whose only rendered page is no
    # longer a top-level manifest (e.g. moved to
    # infographics/rejected/<key>/ after a critic rejected it). Simulated
    # here by removing the top-level manifest add_valid_publication bound
    # to, leaving only the plan file - which still satisfies the
    # pre-existing "missing upstream infographic plan" check, so this
    # exercises the new lineage rule specifically, not the older one.
    add_valid_publication(root)
    (root / "infographics" / "x.json").unlink()


def publication_infographic_upstream_critic_failed(root: Path):
    add_valid_publication(root)
    critic_path = root / "infographics" / "critics" / "x.json"
    critic = load_json(critic_path)
    critic["passed"] = False
    write_json(critic_path, critic)


def publication_infographic_upstream_missing_vision_critic(root: Path):
    # visual_review_required is unconditionally true on every real rendered
    # infographic manifest (see newsroom_infographic_render); flip it on for
    # this otherwise-valid, vision-critic-free fixture to exercise the
    # vision-critic half of the lineage rule specifically.
    add_valid_publication(root)
    manifest_path = root / "infographics" / "x.json"
    manifest = load_json(manifest_path)
    manifest["visual_review_required"] = True
    write_json(manifest_path, manifest)


def check_publication_infographic_lineage_verifies():
    with tempfile.TemporaryDirectory(prefix="newsroom-integrity-pub-lineage-ok-") as tmp:
        root = Path(tmp)
        build_valid(root)
        add_valid_publication(root)
        report = verify(root)
        if not report.passed:
            raise SystemExit(f"FAIL: a publication bound to a top-level infographic manifest with a passing critic should verify: {report.errors}")
        print("PASS control: publication-infographic-lineage-verifies")


def check_infographic_en_unchanged_verifies():
    # An infographic with no language field (the runtime's own
    # params.language ?? "en" default) must keep verifying exactly as it
    # did before the B3 language-keyed source-strip check existed.
    with tempfile.TemporaryDirectory(prefix="newsroom-integrity-infographic-en-unchanged-ok-") as tmp:
        root = Path(tmp)
        build_valid(root)
        report = verify(root)
        if not report.passed:
            raise SystemExit(f"FAIL: an unlabeled (en-default) infographic should still verify: {report.errors}")
        print("PASS control: infographic-en-unchanged-verifies")


def check_infographic_zh_plan_with_zh_strip_verifies():
    # Self-contained fixture (see add_clean_1_4_0_infographic_with_language):
    # build_valid's own baseline infographic is one side of a revision pair,
    # so mutating its plan/SVG in place would collaterally break unrelated
    # revision-replay/immutable-projection checks that have nothing to do
    # with the source-strip rule this test targets.
    with tempfile.TemporaryDirectory(prefix="newsroom-integrity-infographic-zh-strip-ok-") as tmp:
        root = Path(tmp)
        build_valid(root)
        add_clean_1_4_0_infographic_with_language(root, language="zh", strip="资料来源与方法")
        report = verify(root)
        if not report.passed:
            raise SystemExit(f"FAIL: a zh-language infographic with the zh source strip should verify: {report.errors}")
        print("PASS control: infographic-zh-plan-with-zh-strip-verifies")


def main():
    cases = [
        ("dataset-hash-mismatch", tamper_dataset),
        ("source-content-hash-mismatch", tamper_source_body),
        ("source-trust-boundary-tamper", tamper_source_trust),
        ("computation-result-hash-mismatch", tamper_computation_rows),
        ("input-fingerprint-tamper", tamper_input_fingerprints),
        ("source-path-not-content-addressed", rename_source_off_hash),
        ("computation-path-not-content-addressed", rename_computation_off_hash),
        ("missing-mobile-svg", remove_mobile_svg),
        ("unsafe-claim-reference", path_traversal_claim),
        ("model-forged-verified-status", forge_model_verified_claim),
        ("invalid-run-metric", tamper_run_metrics),
        ("infographic-svg-hash-mismatch", tamper_infographic_svg),
        ("infographic-missing-upstream-visual", remove_infographic_upstream_visual),
        ("explanatory-svg-disclosure-or-hash-tamper", tamper_explanatory_svg),
        ("infographic-missing-upstream-illustration", remove_infographic_upstream_illustration),
        ("visual-revision-replay-tamper", tamper_visual_revision_replay),
        ("competition-preflight-recompute-tamper", tamper_competition_preflight),
        ("legacy-chart-bypass", add_ungated_legacy_chart_manifest),
        ("publication-html-tamper", tamper_publication_html),
        ("publication-missing-qa", remove_publication_qa),
        ("publication-failing-qa", fail_publication_qa),
        ("publication-qa-screenshot-tamper", tamper_publication_qa_screenshot),
        ("publication-breakpoint-mismatch", mismatch_publication_breakpoints),
        ("publication-portable-fallback-without-qa", add_portable_publication_without_qa),
        ("lieflat-chart-bypass", add_ungated_lieflat_chart_manifest),
        ("lieflat-publication-self-issued-qa", add_lieflat_publication),
        ("publication-rejected-sibling-still-checked", add_rejected_publication_beside_tampered_real_one),
        ("delivered-artifact-orphan-svg", set_primary_artifact_to_orphan_svg),
        ("delivered-artifact-dangling-publication", set_primary_artifact_to_dangling_publication),
        ("delivered-artifact-reserved-directory-name", set_primary_artifact_to_reserved_directory_name),
        ("delivered-artifact-under-rejected", set_primary_artifact_under_rejected),
        ("qa-fail-and-pass-fail-sorts-first", mismatch_qa_fail_sorts_first),
        ("qa-fail-and-pass-pass-sorts-first", mismatch_qa_pass_sorts_first),
        ("infographic-1-4-0-without-passing-critic", infographic_1_4_0_without_passing_critic),
        ("infographic-unsupported-schema-version", infographic_unsupported_schema_version),
        ("infographic-missing-plan-ref", infographic_missing_plan_ref),
        ("publication-infographic-upstream-rejected", publication_infographic_upstream_rejected),
        ("publication-infographic-upstream-critic-failed", publication_infographic_upstream_critic_failed),
        ("publication-infographic-upstream-missing-vision-critic", publication_infographic_upstream_missing_vision_critic),
        ("infographic-zh-plan-with-english-strip", infographic_zh_plan_with_english_strip),
    ]
    for name, mutate in cases:
        must_fail(name, mutate)
    print(f"integrity adversarial suite: PASS ({len(cases)} cases)")
    check_portable_publication_with_passing_qa_verifies()
    check_rejected_publication_does_not_block_verification()
    check_primary_artifact_publication_binding_verifies()
    check_primary_artifact_svg_variant_verifies()
    check_clean_1_4_0_infographic_verifies()
    check_publication_infographic_lineage_verifies()
    check_infographic_en_unchanged_verifies()
    check_infographic_zh_plan_with_zh_strip_verifies()


if __name__ == "__main__":
    main()
