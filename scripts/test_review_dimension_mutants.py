#!/usr/bin/env python3
"""Each dimension/dedup rule of the review readers is pinned by a test; a one-time text change of the reader must turn that test red on the expected
assertion, and the unchanged reader must stay green (so a red is not an import error). Python reader: test_review_dimension_reader.py against a copy of
verify_artifact.py (SRC_ROOT). Runtime reader: test_review_from_records.mjs against a type-stripped copy (REVIEW_MUTATE)."""
import os, subprocess, sys, tempfile
from pathlib import Path
here = Path(__file__).parent

def run_py(mutation):
    src = (here / "verify_artifact.py").read_text()
    with tempfile.TemporaryDirectory() as tmp:
        if mutation:
            old, new = mutation
            assert src.count(old) == 1, f"mutation anchor must occur exactly once: {old!r}"
            src = src.replace(old, new)
        # the copy lives next to the unchanged modules it imports
        copy = Path(tmp) / "src"; copy.mkdir()
        for f in here.glob("*.py"):
            if f.name != "verify_artifact.py": (copy / f.name).symlink_to(f)
        (copy / "verify_artifact.py").write_text(src)
        env = {**os.environ, "SRC_ROOT": str(copy), "TMPDIR": tmp}
        return subprocess.run([sys.executable, "-I", str(here / "test_review_dimension_reader.py")], env=env, capture_output=True, text=True)

def run_js(mutate):
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "TMPDIR": tmp}
        env.pop("REVIEW_MUTATE", None)
        if mutate: env["REVIEW_MUTATE"] = mutate
        return subprocess.run(["node", str(here / "test_review_from_records.mjs")], env=env, capture_output=True, text=True)

r = run_py(None); assert r.returncode == 0, "Python control must be green: " + r.stderr[-300:]
r = run_js(None); assert r.returncode == 0, "runtime control must be green: " + r.stderr[-300:]

PY = {
    "no_dimension_exclusion": (('    if "dimension" in record:\n        return None', '    if False:\n        return None'), "dimension records are not counted"),
    "null_dimension_counts": (('    if "dimension" in record:\n', '    if record.get("dimension") is not None:\n'), "null dimension is refused"),
    "take_last": (('for ref in sorted(item.get("review_record_refs") or []):', 'for ref in sorted(item.get("review_record_refs") or [], reverse=True):'), "dedup keeps the lowest file name"),
    "no_dedup": (('if r is not None and r["reviewer_id_hash"] not in seen:', 'if r is not None:'), "same reviewer x3 is pending"),
}
for name, (mutation, expect) in PY.items():
    r = run_py(mutation)
    assert r.returncode != 0 and expect in r.stderr, f"Python mutant {name} must go red on {expect!r}: rc={r.returncode} {r.stderr[-300:]}"
JS = {
    "no_dimension_exclusion": "dimension records are not votes",
    "take_last": "the record with the lowest file name is the one counted",
    "no_dedup": "one reviewer three times is one review",
}
for name, expect in JS.items():
    r = run_js(name)
    assert r.returncode != 0 and expect in r.stderr, f"runtime mutant {name} must go red on {expect!r}: rc={r.returncode} {r.stderr[-300:]}"
print("review dimension mutants (Python and runtime readers): ok")
