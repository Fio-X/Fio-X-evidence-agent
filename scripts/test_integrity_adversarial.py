#!/usr/bin/env python3
"""Adversarial integrity tests for content-addressed newsroom artifacts."""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid
from verify_artifact import verify


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
    ]
    for name, mutate in cases:
        must_fail(name, mutate)
    print(f"integrity adversarial suite: PASS ({len(cases)} cases)")


if __name__ == "__main__":
    main()
