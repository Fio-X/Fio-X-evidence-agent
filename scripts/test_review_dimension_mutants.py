#!/usr/bin/env python3
"""The runtime-side dimension/dedup rules are pinned by test_review_from_records.mjs; each one-time text change of the runtime copy must turn it red,
and the unchanged copy must stay green (so a red is not an import error)."""
import os, subprocess, sys, tempfile
from pathlib import Path
here = Path(__file__).parent
def run(mutate):
    with tempfile.TemporaryDirectory() as tmp:
        env = {**os.environ, "TMPDIR": tmp}
        env.pop("REVIEW_MUTATE", None)
        if mutate: env["REVIEW_MUTATE"] = mutate
        return subprocess.run(["node", str(here / "test_review_from_records.mjs")], env=env, capture_output=True, text=True)
assert run(None).returncode == 0, "control must be green"
for name in ("no_dimension_exclusion", "take_last", "no_dedup"):
    r = run(name)
    assert r.returncode != 0, f"mutant {name} must make the runtime review test red"
    assert "mutation anchor" not in r.stderr, f"mutant {name}: anchor missing"
print("review dimension mutants (runtime): ok")
