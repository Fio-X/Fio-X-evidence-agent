#!/usr/bin/env python3
"""Regression test for the infographic revision-binding check in
verify_artifact.py against a vision-critic-rejected source manifest.

Commit 3ddcbbb moves a manifest whose vision critic returned passed:false
from infographics/<key>.json to infographics/rejected/<key>/manifest.json,
next to a copy of the critic report and a rejection.json audit record
({reason, critic_ref, manifest_ref}) - see rejectCriticizedManifest in
runtime/pi/newsroom.ts. A revision built from that same failing vision
critique (newsroom_infographic_revise) still names the moved manifest via
vision_critic_ref -> vision.manifest_ref, but the old verify_artifact.py
revision check only ever looked for that manifest at its original top-level
path, so it failed with a bare "No such file" once the manifest moved -
even though the revision's binding to its source is otherwise intact.

This builds a fully valid artifact (selftest_evaluator.build_valid, which
already contains one infographic revision whose vision critic's source
manifest happens to still be a live top-level page), then reproduces the
rejection by hand exactly the way rejectCriticizedManifest does it: move the
source manifest under infographics/rejected/<key>/, drop a rejection.json
that binds it back to the exact vision critic that rejected it, and delete
the top-level copy. The revision itself is untouched - only where its
source manifest now lives changes - so this fails on the pre-fix verifier
and must pass after it.
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid, write_json
from verify_artifact import load_json, verify

MANIFEST_REF = "infographics/page-before.json"
VISION_CRITIC_REF = "infographics/vision-critics/page-before.json"
REJECTED_KEY = "page-before"  # Path(MANIFEST_REF).stem


def reject_source_manifest(root: Path) -> None:
    rejected_dir = root / "infographics" / "rejected" / REJECTED_KEY
    rejected_dir.mkdir(parents=True)
    manifest_path = root / MANIFEST_REF
    write_json(rejected_dir / "manifest.json", load_json(manifest_path))
    # rejectCriticizedManifest copies the critic that actually rejected the
    # manifest - for a vision-critic rejection that is the vision critic
    # itself, not the (still-passing) deterministic critic.
    shutil.copyfile(root / VISION_CRITIC_REF, rejected_dir / "critic.json")
    write_json(rejected_dir / "rejection.json", {
        "reason": "critic_failed",
        "critic_ref": VISION_CRITIC_REF,
        "manifest_ref": MANIFEST_REF,
    })
    manifest_path.unlink()
    # story.json's evidence.infographics is a flat inventory of files this
    # session claims to have produced, checked for literal existence
    # (verify_artifact.py's story-evidence scan) independently of the
    # revision/rejection machinery under test here. Point it at the
    # manifest's new location so that unrelated, already-covered check does
    # not mask the one this test exists to exercise.
    rejected_manifest_ref = f"infographics/rejected/{REJECTED_KEY}/manifest.json"
    story = load_json(root / "story.json")
    story["evidence"]["infographics"] = [rejected_manifest_ref if ref == MANIFEST_REF else ref for ref in story["evidence"]["infographics"]]
    write_json(root / "story.json", story)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="newsroom-revision-rejected-") as tmp:
        root = Path(tmp)
        build_valid(root)
        baseline = verify(root)
        if not baseline.passed:
            raise SystemExit(f"baseline fixture is unexpectedly invalid: {baseline.errors}")
        assert (root / MANIFEST_REF).is_file(), "precondition: fixture's revision source manifest starts at the top level"

        reject_source_manifest(root)
        assert not (root / MANIFEST_REF).is_file(), "precondition: the source manifest must no longer be at the top level"

        report = verify(root)
        broken_binding = [e for e in report.errors if "revision" in e and "infographics/revisions/page.json" in e]
        if broken_binding:
            raise SystemExit(f"FAIL: revision check did not resolve the rejected manifest: {broken_binding}")
        if not report.passed:
            raise SystemExit(f"FAIL: rejecting the source manifest introduced unrelated failures: {report.errors}")
        print("infographic revision check resolves a vision-critic-rejected source manifest: PASS")


if __name__ == "__main__":
    main()
