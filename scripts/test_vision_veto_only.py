#!/usr/bin/env python3
"""NEWSROOM_MODEL_PASS_SELFREPORT=1 (K98, exact "1", default off): scripts/verify_artifact.py lets the image-aware critic only veto.

Differential: the same artifact verifies with the switch off and on; on adds exactly the veto errors and nothing else, and adds none while
every linked vision critic passes. Mirrors src/verify.rs infographic_selfreport_vision_veto_only.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from selftest_evaluator import build_valid
from test_integrity_adversarial import add_valid_publication, load_json, write_json
from verify_artifact import verify

PASS = {"kind": "image_aware_model", "schema_version": "0.2.0", "manifest_ref": "infographics/x.json", "passed": True, "score": 92, "issues": []}


def errors(root: Path, value: str | None) -> list[str]:
    os.environ.pop("NEWSROOM_MODEL_PASS_SELFREPORT", None)
    if value is not None:
        os.environ["NEWSROOM_MODEL_PASS_SELFREPORT"] = value
    try:
        return list(verify(root).errors)
    finally:
        os.environ.pop("NEWSROOM_MODEL_PASS_SELFREPORT", None)


def case(second: dict | None) -> tuple[list[str], list[str]]:
    with tempfile.TemporaryDirectory(prefix="vision-veto-") as tmp:
        root = Path(tmp)
        build_valid(root)
        add_valid_publication(root)
        manifest = load_json(root / "infographics" / "x.json")
        manifest["visual_review_required"] = True
        write_json(root / "infographics" / "x.json", manifest)
        (root / "infographics" / "vision-critics").mkdir(parents=True, exist_ok=True)
        write_json(root / "infographics" / "vision-critics" / "a.json", PASS)
        if second is not None:
            write_json(root / "infographics" / "vision-critics" / "b.json", {**PASS, **second})
        off = errors(root, None)
        for value in ["true", "0", " 1", ""]:
            assert errors(root, value) == off, f"off for {value!r}"
        return off, errors(root, "1")


def main() -> None:
    off, on = case(None)
    assert on == off, f"only passing critics: on must equal off\n{on}\n{off}"
    print("PASS only passing vision critics: on == off (4 non-1 values == unset)")
    for label, second in [("failed", {"passed": False}), ("score below 80", {"score": 60}), ("no score", {"score": None}), ("blocker", {"issues": [{"severity": "blocker"}]})]:
        off, on = case(second)
        added = [e for e in on if e not in off]
        assert all(e in on for e in off), f"{label}: on keeps every off error"
        assert len(added) == 2 and all("vetoed by an image-aware vision critic" in e for e in added), f"{label}: {added}"
        print(f"PASS {label}: on adds exactly the infographic and publication veto")
    print("5 checks passed")


if __name__ == "__main__":
    main()
