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
    "copies_swapped": ("fs.copyFileSync(source[sideOf[side]], path.join(outDir, files[side]))", "fs.copyFileSync(source[sideOf[side === 'A' ? 'B' : 'A']], path.join(outDir, files[side]))", "each copied file is the source the mapping names"),
    "key_sides_fixed": ("sides: sideOf }", "sides: { A: 'baseline', B: 'candidate' } }", "the key file and the page's mapping agree"),
    "no_path_rules": ("throw new Error(`${rel}: give a path inside the run folder, without .. or a leading /`);", "{}", "refuses an absolute path"),
    "no_symlink_check": ("?.isSymbolicLink()) throw", "?.isSymbolicLink() && false) throw", "refuses a symbolic link"),
    "no_extension_check": ("if (path.extname(baseline).toLowerCase() !== path.extname(candidate).toLowerCase()) throw", "if (false) throw", "refuses different extensions"),
    "no_empty_folder_check": ("if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw", "if (false) throw", "refuses a non-empty output folder"),
    "titles_swapped": ("['informativeness', '信息量:谁让人学到的东西更多'],\n  ['chart_choice', '图表选择:谁选的图表更合适'],", "['informativeness', '图表选择:谁选的图表更合适'],\n  ['chart_choice', '信息量:谁让人学到的东西更多'],", "title matches its id"),
    "run_not_resolved": ("  run = path.resolve(run);", "  run = run;", "a relative run folder is resolved"),
    "second_script_block": ("<title>盲评</title>", "<title>盲评</title><script>var extra = 1;</script>", "the page has exactly one <script"),
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
