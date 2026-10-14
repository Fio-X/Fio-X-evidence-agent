#!/usr/bin/env python3
"""NEWSROOM_VISION_VETO_REPORT_ONLY (default off; only the exact "1" turns it on): scripts/verify_artifact.py writes the image-aware vision veto into the
report's warnings instead of its errors. Only the vision score gates move (failed record, score below 80, rubric floor or key, blocker, no record);
the same artifacts must give identical errors for every other gate with the switch on and off. Mirrors src/verify.rs vision_check. Off, nothing changes.

The non-vision comparison replays the adversarial fixtures of test_integrity_adversarial.py (each mutated artifact, with and without a vision veto).
"""
from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

os.environ["NEWSROOM_VERIFY_STRICT_READERS"] = "1"  # as test_integrity_adversarial pins it
from selftest_evaluator import build_valid
import test_integrity_adversarial as adv
from test_integrity_adversarial import add_valid_publication, load_json, write_json
from verify_artifact import verify

SWITCH = "NEWSROOM_VISION_VETO_REPORT_ONLY"
RUBRIC = {key: 90 for key in ("hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness")}
PASS = {"kind": "image_aware_model", "schema_version": "0.2.0", "manifest_ref": "infographics/x.json", "passed": True, "score": 92, "rubric": RUBRIC, "issues": []}
# The messages the vision score gates write (verify_artifact.py); every other message is a non-vision gate.
VISION_GATE = re.compile(r"image-aware vision critic|requires image-aware vision critic|vision critic score below 80|vision critic contains blocker|vision critic missing rubric dimensions")
MARK = "vision veto (report only, not blocking)"


def verdict(root: Path, value: str | None):
    os.environ.pop(SWITCH, None)
    if value is not None:
        os.environ[SWITCH] = value
    try:
        report = verify(root)
        return list(report.errors), list(report.warnings), report.checks
    finally:
        os.environ.pop(SWITCH, None)


def case(records: dict[str, dict]):
    tmp = tempfile.TemporaryDirectory(prefix="vision-veto-report-only-")
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


def main() -> None:
    # 1. a clean record: nothing to report either way
    tmp, root = case({"a": PASS})
    with tmp:
        off, on = verdict(root, None), verdict(root, "1")
        assert not any(VISION_GATE.search(e) for e in off[0]) and off == on, (off, on)
        assert not any(MARK in w for w in on[1])
    print("PASS clean record: same errors, warnings and check count on and off, no veto text")

    # 2. vetoed shapes: refused when off, warning with score and reasons when on
    shapes = {
        "score 70": ({**PASS, "score": 70}, "score=70", "score_below_80"),
        "passed false": ({**PASS, "passed": False}, "score=92", "passed_false"),
        "blocker": ({**PASS, "issues": [{"severity": "blocker"}]}, "score=92", "blocker_issue"),
        "rubric item 50": ({**PASS, "score": 80, "rubric": {**RUBRIC, "typography": 50}}, "score=80", "rubric_typography_below_60"),
        "missing key": ({**PASS, "rubric": {k: v for k, v in RUBRIC.items() if k != "legibility"}}, "score=92", "rubric_legibility_missing"),
        "no score": ({**PASS, "score": None}, "score=null", "score_missing"),
    }
    for label, (record, score_text, reason) in shapes.items():
        tmp, root = case({"a": record})
        with tmp:
            off_errors, off_warnings, off_checks = verdict(root, None)
            on_errors, on_warnings, on_checks = verdict(root, "1")
            assert any(VISION_GATE.search(e) for e in off_errors), f"{label}: off must refuse: {off_errors}"
            assert not any(MARK in w for w in off_warnings), f"{label}: off writes no veto warning"
            assert not any(VISION_GATE.search(e) for e in on_errors), f"{label}: on must not block on vision: {on_errors}"
            assert on_errors == [e for e in off_errors if not VISION_GATE.search(e)], f"{label}: other errors differ"
            veto = [w for w in on_warnings if MARK in w]
            assert veto and any(score_text in w and reason in w for w in veto), f"{label}: {veto}"
            assert on_checks == off_checks, f"{label}: check count {on_checks} vs {off_checks}"
            for value in ("0", "true", "on", "", " 1"):
                assert verdict(root, value) == (off_errors, off_warnings, off_checks), f"{label}: only the exact 1 turns it on ({value!r})"
    print(f"PASS vetoed record ({len(shapes)} shapes): off refuses as before, on moves the verdict into warnings with score and reasons; other errors identical")

    # 3. one failing of two records, and no record at all
    tmp, root = case({"a": PASS, "b": {**PASS, "score": 40}})
    with tmp:
        on = verdict(root, "1")
        assert not any(VISION_GATE.search(e) for e in on[0]) and any("score=40" in w for w in on[1]), on
    tmp, root = case({})
    with tmp:
        off, on = verdict(root, None), verdict(root, "1")
        assert any("requires image-aware vision critic" in e for e in off[0]) and any("has no image-aware vision critic" in e for e in off[0]), off
        assert not any(VISION_GATE.search(e) for e in on[0]) and any("no vision critic record" in w for w in on[1]), on
    print("PASS one failing of two records and no record: reported when on, refused when off")

    # 4. replay of the adversarial fixtures: every non-vision gate gives the same errors on and off, with the vision veto present or not
    mutations = [
        ("dataset-tamper", adv.tamper_dataset), ("source-body-tamper", adv.tamper_source_body), ("computation-rows-tamper", adv.tamper_computation_rows),
        ("model-verified-claim-forgery", adv.forge_model_verified_claim), ("infographic-svg-hash-mismatch", adv.tamper_infographic_svg),
        ("infographic-missing-upstream-visual", adv.remove_infographic_upstream_visual), ("visual-revision-replay-tamper", adv.tamper_visual_revision_replay),
        ("competition-preflight-recompute-tamper", adv.tamper_competition_preflight), ("publication-html-tamper", adv.tamper_publication_html),
        ("publication-missing-qa", adv.remove_publication_qa), ("publication-failing-qa", adv.fail_publication_qa),
        ("publication-qa-screenshot-tamper", adv.tamper_publication_qa_screenshot), ("publication-breakpoint-mismatch", adv.mismatch_publication_breakpoints),
        ("infographic-1-4-0-without-passing-critic", adv.infographic_1_4_0_without_passing_critic),
        ("publication-infographic-upstream-critic-failed", adv.publication_infographic_upstream_critic_failed),
        ("publication-infographic-upstream-rejected", adv.publication_infographic_upstream_rejected),
        ("delivered-artifact-orphan-svg", adv.set_primary_artifact_to_orphan_svg), ("run-metric-negative-duration", adv.tamper_run_metrics),
    ]
    compared = vetoed_compared = 0
    for name, mutate in mutations:
        for veto in (False, True):
            with tempfile.TemporaryDirectory(prefix=f"vision-veto-report-only-{name}-") as tmp:
                root = Path(tmp)
                build_valid(root)
                mutate(root)
                score_file = root / "infographics" / "vision-critics" / "page.json"
                if veto and score_file.is_file():
                    adv.set_infographic_vision_score(root, 70)
                    vetoed_compared += 1
                off_errors, _w, off_checks = verdict(root, None)
                on_errors, _w2, on_checks = verdict(root, "1")
                assert on_errors == [e for e in off_errors if not VISION_GATE.search(e)], f"{name} (veto={veto}): non-vision errors differ\n off={off_errors}\n on={on_errors}"
                assert on_checks == off_checks, f"{name}: check count"
                compared += 1
    print(f"PASS adversarial fixtures replayed ({compared} runs, {vetoed_compared} with a vetoed vision record): errors of every non-vision gate identical on and off")

    # 5. the competition preflight is not a publication gate here and keeps its own vision floor (recomputed from the record), switch on or off
    from verify_artifact import recompute_competition_machine_pass, COMPETITION_POLICY_FLOORS
    profile = next(iter(COMPETITION_POLICY_FLOORS))
    results = []
    for value in (None, "1"):
        os.environ.pop(SWITCH, None)
        if value:
            os.environ[SWITCH] = value
        try:
            results.append(recompute_competition_machine_pass(profile, {"passed": True}, {"passed": False, "score": 50, "rubric": {}}, []))
        finally:
            os.environ.pop(SWITCH, None)
    assert results[0] == results[1] and results[0][0] is False, results
    print("PASS competition recompute unchanged by the switch")
    print("5 checks passed")


if __name__ == "__main__":
    main()
