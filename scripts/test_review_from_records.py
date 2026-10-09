#!/usr/bin/env python3
"""Verifier replay of program-computed review status (records with status_source = program_review_records).
Old records (no status_source) keep the unchanged path; see test_editorial_verifier_v14.py."""
from __future__ import annotations
import json, tempfile
from pathlib import Path
from selftest_evaluator import build_valid
from verify_artifact import verify, editorial_hash
from test_editorial_verifier_v14 import install, write, with_hash

SRC = "program_review_records"
BASE, CAND = "baseline.png", "candidate.png"


def review_record(i, preference="candidate", **over):
    body = {"schema_version": "0.1.0", "kind": "program_saved_review", "saved_by": "program", "baseline_ref": BASE, "candidate_ref": CAND,
            "reviewer_id_hash": f"{i:016x}", "preference": preference}
    body.update(over)
    return with_hash(body)


def preference(refs, status, share, counts_total, record_refs, counted=False):
    item = {"schema_version": json.loads(refs["p"].read_text())["schema_version"], "kind": "expert_pairwise_preference", "baseline_ref": BASE, "candidate_ref": CAND,
            "minimum_reviewers": 3, "candidate_threshold": 0.7, "reviews": [], "counts": {"candidate": 0, "baseline": 0, "tie": 0, "total": counts_total},
            "candidate_decisive_share": share, "status": status, "human_evidence_required": True, "status_source": SRC,
            "review_record_refs": sorted(record_refs), "model_reported_reviews": {"count": 5, "counted": counted}}
    return item


def program_pref(root, refs, n_records, status=None, share=None, listed_extra=()):
    recs = []
    for i in range(n_records):
        ref = f"editorial/human-reviews/r{i}.json"; write(root / ref, review_record(i + 1)); recs.append(ref)
    item = preference(refs, status or ("PASS" if n_records >= 3 else "PENDING"), share if share is not None else (1.0 if n_records else 0.0), n_records, recs + list(listed_extra))
    item["reviews"] = [{"reviewer_id_hash": f"{i + 1:016x}", "qualified": True, "preference": "candidate"} for i in range(n_records)]
    item["counts"]["candidate"] = n_records
    write(refs["p"], with_hash(item))
    return recs


def set_award(refs, pref_status, count):
    run = json.loads(refs["r"].read_text()); run.pop("content_hash")
    run["status_source"] = SRC; run["preference_status"] = pref_status; run["metrics"]["human_review_count"] = count
    run["status"] = {"PASS": "PASS", "FAIL": "FAIL"}.get(pref_status, "READY_FOR_HUMAN")
    write(refs["r"], with_hash(run))


def case(name, setup, expect_pass):
    with tempfile.TemporaryDirectory(prefix=f"newsroom-rfr-{name}-") as tmp:
        root = Path(tmp); build_valid(root); refs = install(root)
        if not verify(root).passed: raise SystemExit(f"baseline invalid {name}")
        setup(root, refs)
        rep = verify(root)
        if rep.passed != expect_pass:
            raise SystemExit(f"FAIL {name}: expected {'pass' if expect_pass else 'fail'}; errors={rep.errors[:3]}")
        print(f"PASS {name} -> {'verified' if expect_pass else rep.errors[0]}")


def real_three(root, refs):
    program_pref(root, refs, 3)
    # the award record's preference_ref must point at the program preference record
    run = json.loads(refs["r"].read_text()); run.pop("content_hash"); run["refs"]["preference_ref"] = "editorial/preferences/a.json"; write(refs["r"], with_hash(run))
    set_award(refs, "PASS", 3)

def no_records_pending(root, refs):
    program_pref(root, refs, 0)
    run = json.loads(refs["r"].read_text()); run.pop("content_hash"); run["refs"]["preference_ref"] = None; write(refs["r"], with_hash(run))
    set_award(refs, "PENDING", 0)

def forged_pass_no_records(root, refs):
    program_pref(root, refs, 0, status="PASS", share=1.0)  # stored PASS, no program record behind it
def forged_pass_two_records(root, refs):
    program_pref(root, refs, 2, status="PASS", share=1.0)
def model_review_counted(root, refs):
    recs = program_pref(root, refs, 3)
    item = json.loads(refs["p"].read_text()); item.pop("content_hash"); item["model_reported_reviews"]["counted"] = True; write(refs["p"], with_hash(item))
def forged_record_hash(root, refs):
    real_three(root, refs)
    p = root / "editorial/human-reviews/r0.json"; o = json.loads(p.read_text()); o["preference"] = "baseline"; write(p, o)  # hash no longer matches
def listed_ref_missing(root, refs):
    program_pref(root, refs, 3, listed_extra=["editorial/human-reviews/ghost.json"])
def award_pass_without_program_pref(root, refs):
    no_records_pending(root, refs)
    run = json.loads(refs["r"].read_text()); run.pop("content_hash"); run["preference_status"] = "PASS"; run["status"] = "PASS"; run["metrics"]["human_review_count"] = 3; write(refs["r"], with_hash(run))


if __name__ == "__main__":
    case("program-pass-with-3-records", real_three, True)
    case("program-pending-no-records", no_records_pending, True)
    for name, fn in [("forged-pass-no-records", forged_pass_no_records), ("forged-pass-two-records", forged_pass_two_records),
                     ("model-reviews-counted", model_review_counted), ("forged-review-record-hash", forged_record_hash),
                     ("listed-record-missing", listed_ref_missing), ("award-pass-without-program-preference", award_pass_without_program_pref)]:
        case(name, fn, False)
    print("program-computed review replay: PASS (8 cases)")
