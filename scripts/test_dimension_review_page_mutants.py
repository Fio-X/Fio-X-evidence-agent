#!/usr/bin/env python3
"""One-time text changes of scripts/build_dimension_review.mjs: each must turn test_dimension_review_page.mjs red on the expected assertion; the
unchanged builder (BUILDER pointing at an identical copy) must stay green, so a red is not an import error."""
import os, subprocess, tempfile
from pathlib import Path
here = Path(__file__).parent
src = (here / "build_dimension_review.mjs").read_text()
MUTANTS = {
    "alt_names_the_side": ('alt="图 A"', 'alt="图 ${sideOf.A}"', "no side-identifying word"),
    "file_keeps_the_real_name": ("files[side] = `${side.toLowerCase()}${ext}`", "files[side] = `${which}${ext}`", "no side-identifying word"),
    "key_inside_the_folder": ("const keyPath = `${path.resolve(outDir)}.key.json`", "const keyPath = path.join(outDir, 'key.json')", "neutral file names only"),
    "side_not_mapped_back": ("(v === 'tie' ? 'tie' : SIDE[v])", "(v === 'tie' ? 'tie' : v)", "side mapped back"),
    "commands_before_all_answers": ("if (answers.some((a) => a === null))", "if (false)", "no commands until all six"),
    "fixed_order": ("const salt = seed ?? crypto.randomBytes(16).toString('hex');", "const salt = 'fixed';", "both sides turn up as A"),
    "total_gets_a_dimension": ("(DIMS[i] ? ' --dimension ' + DIMS[i] : '')", "(' --dimension ' + (DIMS[i] || 'chart_choice'))", "the total has no --dimension"),
}
def run(text):
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "builder.mjs"; copy.write_text(text)
        return subprocess.run(["node", str(here / "test_dimension_review_page.mjs")], env={**os.environ, "BUILDER": str(copy), "TMPDIR": tmp}, capture_output=True, text=True)
r = run(src); assert r.returncode == 0, "control must be green: " + r.stderr[-300:]
for name, (old, new, expect) in MUTANTS.items():
    assert src.count(old) == 1, f"mutation anchor must occur exactly once: {name}"
    r = run(src.replace(old, new))
    assert r.returncode != 0 and expect in r.stderr, f"mutant {name} must go red on {expect!r}: rc={r.returncode} {r.stderr[-400:]}"
print("dimension review page mutants: ok")
