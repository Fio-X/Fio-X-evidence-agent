#!/usr/bin/env python3
"""The record `news review` writes is accepted by the Python reader (verify_artifact.program_review_ok); edited, stale or foreign records are not."""
import json, tempfile
from pathlib import Path
from verify_artifact import program_review_ok

golden = json.loads((Path(__file__).parent / "fixtures" / "review_record_golden.json").read_text())
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / "editorial" / "human-reviews").mkdir(parents=True)
    def save(name, record):
        (root / "editorial" / "human-reviews" / name).write_text(json.dumps(record, ensure_ascii=False))
        return f"editorial/human-reviews/{name}"
    base, cand = golden["baseline_ref"], golden["candidate_ref"]
    assert program_review_ok(root, save("g.json", golden), base, cand), "a command-made record counts"
    assert program_review_ok(root, save("e.json", {**golden, "preference": "baseline"}), base, cand) is None, "hand-edited"
    assert program_review_ok(root, save("s.json", golden), base, cand[:-1] + "c") is None, "stale (changed candidate)"
    assert program_review_ok(root, save("m.json", {**golden, "saved_by": "model"}), base, cand) is None
print("review command record (Python reader): ok")
