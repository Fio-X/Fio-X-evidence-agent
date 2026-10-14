#!/usr/bin/env python3
"""Every scripts/test_* file is either named in ci.yml, run by the CI runner, or excluded with a
reason. Also pins the runner step (no-skip env, debug binary) and the macOS full-depth checkout,
and proves with mutations in a temp copy that each rule goes red when broken."""
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import run_all_script_tests as runner  # noqa: E402

BASE_NAMED_FLOOR = 167  # tests ci.yml named before the all-tests runner; CI may only run more


def problems_for(root):
    out = []
    tests, named, excluded, to_run, bad = runner.plan(root)
    out += bad
    for path in excluded:
        if path not in tests:
            out.append(f"exclusion names a missing file: {path}")
        if path in named:
            out.append(f"excluded but also named in ci.yml: {path}")
    for t in tests:
        if t not in named and t not in excluded and t not in to_run:
            out.append(f"uncovered: {t}")
    if len(named & set(tests)) < BASE_NAMED_FLOOR:
        out.append(f"ci.yml names fewer tests than the floor {BASE_NAMED_FLOOR}")
    yml = (root / ".github" / "workflows" / "ci.yml").read_text()
    m = re.search(r"- name: Remaining script tests[^\n]*\n(?P<body>(?:        .*\n|      #.*\n)+)", yml)
    if not m:
        out.append("ci.yml has no 'Remaining script tests' step")
    else:
        body = m.group("body")
        if 'NEWSROOM_REQUIRE_NO_SKIP: "1"' not in body:
            out.append("runner step does not set NEWSROOM_REQUIRE_NO_SKIP to 1")
        if "run: python3 scripts/run_all_script_tests.py" not in body:
            out.append("runner step does not call run_all_script_tests.py")
    k = re.search(r"- name: Known-red script tests[^\n]*\n(?P<body>(?:        .*\n)+)", yml)
    if not k:
        out.append("ci.yml has no 'Known-red script tests' step")
    else:
        if "continue-on-error: true" not in k.group("body"):
            out.append("known-red step is not continue-on-error")
        if "run_all_script_tests.py --known-red" not in k.group("body"):
            out.append("known-red step does not call the runner with --known-red")
        if 'NEWSROOM_REQUIRE_NO_SKIP: "1"' not in k.group("body"):
            out.append("known-red step does not set NEWSROOM_REQUIRE_NO_SKIP to 1")
    mac = yml.split("macos-native-contracts:", 1)[-1]
    if not re.search(r"actions/checkout@v4\s+with:\s+fetch-depth: 0", mac):
        out.append("macOS job checkout is not fetch-depth: 0")
    ms = re.search(r"- name: macOS-native result-budget[^\n]*\n(?P<body>(?:        .*\n|          .*\n)+)", mac)
    if not ms or 'NEWSROOM_REQUIRE_NO_SKIP: "1"' not in ms.group("body").split("run: |")[0]:
        out.append("macOS test step does not set NEWSROOM_REQUIRE_NO_SKIP to 1")
    for must in ("scripts/test_local_sqlite_safety.mjs", "scripts/test_duckdb_bundled_ext.mjs"):
        if must not in mac:
            out.append(f"macOS job no longer runs {must}")
    return out


def copy_tree():
    tmp = Path(tempfile.mkdtemp(prefix="ci-covers-"))
    (tmp / ".github" / "workflows").mkdir(parents=True)
    shutil.copy(ROOT / ".github/workflows/ci.yml", tmp / ".github/workflows/ci.yml")
    shutil.copytree(ROOT / "ci", tmp / "ci")
    (tmp / "scripts").mkdir()
    for p in (ROOT / "scripts").glob("test_*"):
        (tmp / "scripts" / p.name).write_text("")
    return tmp


def mutate(name, fn, expect):
    tmp = copy_tree()
    try:
        fn(tmp)
        got = problems_for(tmp)
        if not any(expect in g for g in got):
            raise SystemExit(f"mutation {name!r} did not go red (wanted {expect!r}, got {got[:3]})")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"ok mutation: {name}")


def edit(path, fn):
    return lambda tmp: (tmp / path).write_text(fn((tmp / path).read_text()))


def main():
    real = problems_for(ROOT)
    if real:
        print("\n".join(real))
        raise SystemExit(1)
    tests, named, excluded, to_run, _ = runner.plan()
    print(f"ok coverage: total={len(tests)} named={len(named & set(tests))} "
          f"run_by_runner={len(to_run)} excluded={len(excluded)}")
    # an unlisted new file is picked up by the runner; it must not be reported uncovered
    tmp = copy_tree()
    (tmp / "scripts/test_zz_new.mjs").write_text("")
    assert "scripts/test_zz_new.mjs" in runner.plan(tmp)[3]
    shutil.rmtree(tmp, ignore_errors=True)
    print("ok mutation: new test file joins the runner list")
    ex = "ci/test-exclusions.txt"
    mutate("exclusion without a reason", edit(ex, lambda s: s.replace(
        "| local-only | needs a local venv and an external spreadsheet converter", "| local-only |")),
        "need `path | category | reason`")
    mutate("unknown category", edit(ex, lambda s: s.replace("| local-only |", "| whatever |", 1)),
           "unknown category")
    mutate("known-red without board item", edit(ex, lambda s: s.replace("K323/K326", "somewhere", 1)),
           "known-red must name a board item")
    mutate("exclusion of a missing file", edit(ex, lambda s: s + "scripts/test_nope.py | local-only | x\n"),
           "missing file")
    mutate("excluded but named in ci.yml", edit(ex, lambda s: s + "scripts/test_local_result_budget.mjs | local-only | x\n"),
           "also named in ci.yml")
    mutate("runner step loses the no-skip env", edit(".github/workflows/ci.yml",
           lambda s: s.replace('NEWSROOM_REQUIRE_NO_SKIP: "1"\n          NEWS_BIN', 'NEWS_BIN')),
           "NEWSROOM_REQUIRE_NO_SKIP")
    mutate("known-red step loses continue-on-error", edit(".github/workflows/ci.yml",
           lambda s: s.replace("        continue-on-error: true\n", "")), "not continue-on-error")
    mutate("known-red step removed", edit(".github/workflows/ci.yml",
           lambda s: s.replace("Known-red script tests", "Other")), "no 'Known-red script tests'")
    mutate("macOS step loses no-skip", edit(".github/workflows/ci.yml",
           lambda s: s.replace('          NEWSROOM_REQUIRE_NO_SKIP: "1" # a skipped', "          X: 1 # a skipped")),
           "macOS test step")
    mutate("macOS job drops the sqlite test", edit(".github/workflows/ci.yml",
           lambda s: s.replace("node scripts/test_local_sqlite_safety.mjs\n", "")), "no longer runs")
    mutate("runner step removed", edit(".github/workflows/ci.yml",
           lambda s: s.replace("Remaining script tests", "Something else")), "no 'Remaining script tests'")
    mutate("macOS job back to shallow checkout", edit(".github/workflows/ci.yml",
           lambda s: s.replace("fetch-depth: 0 # the byte", "# the byte")), "macOS job checkout")
    mutate("ci.yml named tests drop under the floor", edit(".github/workflows/ci.yml",
           lambda s: re.sub(r"node scripts/test_[a-z0-9_]+\.mjs", "true", s)), "floor")
    print("PASS test_ci_covers_all_tests")


main()
