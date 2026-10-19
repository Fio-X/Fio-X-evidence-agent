#!/usr/bin/env python3
"""Reader side of `news review --dimension`: a record with a dimension is not a vote on the total preference, and one reviewer counts once
(the earliest record by file name). Mutants (SRC_ROOT copy with one text change) must make this go red."""
import json, os, sys, tempfile
from pathlib import Path
here = Path(__file__).parent
sys.path.insert(0, os.environ.get("SRC_ROOT") or str(here))
from verify_artifact import editorial_hash, replay_program_preference

golden = json.loads((here / "fixtures" / "review_record_golden.json").read_text())
base, cand = golden["baseline_ref"], golden["candidate_ref"]

def make(**over):
    body = {k: v for k, v in golden.items() if k != "content_hash"}
    body.update(over)
    body = {k: v for k, v in body.items() if v is not None}
    body["content_hash"] = editorial_hash(body)
    return body

def status(records):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp); d = root / "editorial" / "human-reviews"; d.mkdir(parents=True)
        refs = []
        for name, rec in records:
            (d / name).write_text(json.dumps(rec, ensure_ascii=False)); refs.append(f"editorial/human-reviews/{name}")
        return replay_program_preference(root, {"baseline_ref": base, "candidate_ref": cand, "review_record_refs": refs})

H = lambda c: c * 16
def total(i, who, pref): return (f"{i}.json", make(reviewer_id_hash=H(who), preference=pref))
assert status([total(1, "a", "candidate"), total(2, "b", "candidate"), total(3, "c", "candidate")])[0] == "PASS"
# five dimension records from one reviewer are not five votes, and not a vote at all
dims = [(f"d{i}.json", make(reviewer_id_hash=H("a"), preference="candidate", dimension=f"dim{i}")) for i in range(5)]
assert status(dims)[2] == 0, "dimension records are not counted"
assert status(dims + [total(1, "b", "candidate"), total(2, "c", "candidate")])[0] == "PENDING"
# same reviewer three times is still pending
assert status([total(1, "a", "candidate"), total(2, "a", "candidate"), total(3, "a", "candidate")])[0] == "PENDING"
# contradictory records from one reviewer: only the earliest counts
s = status([total(1, "a", "candidate"), total(2, "a", "baseline"), total(3, "b", "candidate"), total(4, "c", "candidate")])
assert s == ("PASS", 1.0, 3), s
s = status([total(2, "a", "baseline"), total(1, "a", "candidate"), total(3, "b", "candidate"), total(4, "c", "candidate")])
assert s == ("PASS", 1.0, 3), s
print("review dimension reader (Python): ok")
