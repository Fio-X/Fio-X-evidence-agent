#!/usr/bin/env python3
"""NEWSROOM_VISION_VETO_ONLY (K250, default on; only the exact "0" turns it off): scripts/verify_artifact.py re-derives every vision critic record.

The model's passed=true is never read as proof: a record fails when its score is missing or below 80, a rubric item is missing or below 60, or a
blocker is listed (an explicit passed=false fails too). Every linked record counts, and a review must exist. Mirrors src/verify.rs
infographic_vision_veto_only_* and publication_lineage_vision_veto_only. Off, the same files verify exactly as before.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid
from test_integrity_adversarial import add_valid_publication, load_json, write_json
from verify_artifact import verify

RUBRIC = {key: 90 for key in ("hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness")}
PASS = {"kind": "image_aware_model", "schema_version": "0.2.0", "manifest_ref": "infographics/x.json", "passed": True, "score": 92, "rubric": RUBRIC, "issues": []}
FAILED = "failed by an image-aware vision critic"
NONE = "image-aware vision critic"


def errors(root: Path, value: str | None) -> list[str]:
    os.environ.pop("NEWSROOM_VISION_VETO_ONLY", None)
    if value is not None:
        os.environ["NEWSROOM_VISION_VETO_ONLY"] = value
    try:
        return list(verify(root).errors)
    finally:
        os.environ.pop("NEWSROOM_VISION_VETO_ONLY", None)


def case(records: dict[str, dict]):
    tmp = tempfile.TemporaryDirectory(prefix="vision-veto-only-")
    root = Path(tmp.name)
    build_valid(root)
    add_valid_publication(root)
    manifest = load_json(root / "infographics" / "x.json")
    manifest["visual_review_required"] = True
    write_json(root / "infographics" / "x.json", manifest)
    (root / "infographics" / "vision-critics").mkdir(parents=True, exist_ok=True)
    for name, record in records.items():
        write_json(root / "infographics" / "vision-critics" / f"{name}.json", record)
    return tmp, root


def failures(root: Path, value: str | None) -> list[str]:
    return [e for e in errors(root, value) if FAILED in e]


def main() -> None:
    # a clean pass: no veto either way, and a missing `passed` is not read
    for label, record in [("model pass", PASS), ("no passed field", {k: v for k, v in PASS.items() if k != "passed"})]:
        tmp, root = case({"a": record})
        with tmp:
            assert failures(root, "1") == [], f"{label}: {failures(root, '1')}"
    print("PASS clean record: no veto; passed is not read")

    # hand-written: passed=true, score 80, keys complete, one item at 50
    low = {**PASS, "score": 80, "rubric": {**RUBRIC, "typography": 50}}
    tmp, root = case({"a": low})
    with tmp:
        off, on = errors(root, "0"), errors(root, None)
        assert not any(FAILED in e for e in off), f"off reads passed as before: {off}"
        assert sum(FAILED in e for e in on) == 2, f"on: infographic and publication both reject: {on}"
        for value in ["1", "true", " 0", ""]:
            assert errors(root, value) == on, f"on for {value!r}"
    print("PASS hand-written passed=true, score 80, rubric item 50: rejected by default, unchanged with \"0\"")

    # a missing rubric key, a missing score, a blocker, an explicit passed=false
    broken = {"missing key": {**PASS, "rubric": {k: v for k, v in RUBRIC.items() if k != "legibility"}}, "no score": {**PASS, "score": None}, "score 79": {**PASS, "score": 79}, "blocker": {**PASS, "issues": [{"severity": "blocker"}]}, "passed false": {**PASS, "passed": False}}
    for label, record in broken.items():
        tmp, root = case({"a": record})
        with tmp:
            assert len(failures(root, "1")) == 2, f"{label}: {failures(root, '1')}"
    print("PASS missing key, no score, 79, blocker, passed=false all reject (5 cases)")

    # two records, one fails
    tmp, root = case({"a": PASS, "b": {**PASS, "score": 40}})
    with tmp:
        assert len(failures(root, "1")) == 2, failures(root, "1")
    print("PASS one passing and one failing record: rejected")

    # no record at all
    tmp, root = case({})
    with tmp:
        on = errors(root, "1")
        assert any("requires image-aware vision critic" in e for e in on) and any("has no image-aware vision critic" in e for e in on), on
    print("PASS no record: rejected")
    print("5 checks passed")


if __name__ == "__main__":
    main()
