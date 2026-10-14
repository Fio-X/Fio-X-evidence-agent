#!/usr/bin/env python3
"""Run every scripts/test_* file that CI does not already name and that is not excluded.

Usage: run_all_script_tests.py [--list] [--timeout SECONDS]
  --list        print what would run and the counts, run nothing.
  --known-red   run only the known-red entries (for a continue-on-error CI step that reports them).

A file counts as already run when .github/workflows/ci.yml names it. Excluded files live in
ci/test-exclusions.txt, one `path | category | reason` line each. The step is meant to run with
NEWSROOM_REQUIRE_NO_SKIP=1 and NEWS_BIN pointing at the built debug binary.
"""
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CI_YML = ROOT / ".github" / "workflows" / "ci.yml"
EXCLUSIONS = ROOT / "ci" / "test-exclusions.txt"
CATEGORIES = ("known-red", "local-only", "needs-built-binary")
# These tests take the binary as argv[1]; the rest read NEWS_BIN or find the debug build themselves.
ARGV_BINARY = {
    "test_compose_answer.py", "test_env_loading.py", "test_interactive_cli.py",
    "test_output_location.py", "test_plan_progress.py", "test_rpc_waits.py",
}
INTERPRETERS = {".mjs": ["node"], ".py": ["python3"], ".sh": ["bash"]}


def all_tests(root=ROOT):
    return sorted(p.relative_to(root).as_posix() for p in (root / "scripts").glob("test_*")
                  if p.suffix in INTERPRETERS)


def named_in_ci(root=ROOT):
    text = "\n".join(l for l in (root / ".github" / "workflows" / "ci.yml").read_text().splitlines()
                     if not l.lstrip().startswith("#"))
    return set(re.findall(r"scripts/test_[A-Za-z0-9_]+\.(?:mjs|py|sh)", text))


def read_exclusions(root=ROOT):
    entries, problems = {}, []
    for n, line in enumerate((root / "ci" / "test-exclusions.txt").read_text().splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = [x.strip() for x in line.split("|", 2)]
        if len(parts) != 3 or not all(parts):
            problems.append(f"line {n}: need `path | category | reason`")
            continue
        path, category, reason = parts
        if category not in CATEGORIES:
            problems.append(f"line {n}: unknown category {category!r}")
        if category == "known-red" and not re.search(r"\bK\d+", reason):
            problems.append(f"line {n}: known-red must name a board item (K<number>)")
        if path in entries:
            problems.append(f"line {n}: {path} listed twice")
        entries[path] = (category, reason)
    return entries, problems


def plan(root=ROOT):
    tests, named = all_tests(root), named_in_ci(root)
    excluded, problems = read_exclusions(root)
    to_run = [t for t in tests if t not in named and t not in excluded]
    return tests, named, excluded, to_run, problems


def main(argv):
    tests, named, excluded, to_run, problems = plan()
    if problems:
        print("\n".join(problems))
        return 2
    if "--known-red" in argv:
        to_run = [t for t in tests if t in excluded and excluded[t][0] == "known-red"]
    by_cat = {c: sum(1 for v in excluded.values() if v[0] == c) for c in CATEGORIES}
    print(f"total={len(tests)} named_in_ci={len(named & set(tests))} run_here={len(to_run)} "
          f"excluded={len(excluded)} {by_cat}")
    if "--list" in argv:
        print("\n".join(to_run))
        return 0
    timeout = int(argv[argv.index("--timeout") + 1]) if "--timeout" in argv else 600
    binary = os.environ.get("NEWS_BIN") or str(ROOT / "target" / "debug" / "news")
    binary = str(Path(binary).resolve())
    env = dict(os.environ, NEWS_BIN=binary, NEWSROOM_REQUIRE_NO_SKIP="1")
    # World-map mode is off by default and changes the plan tool's definition, which several tests pin
    # byte for byte. The tests that need it set it themselves; ci.yml sets it on the steps that name it.
    env.pop("NEWSROOM_MAP_WORLD", None)
    failed = []
    for t in to_run:
        cmd = INTERPRETERS[Path(t).suffix] + [t]
        if Path(t).name in ARGV_BINARY:
            cmd.append(binary)
        start = time.time()
        try:
            rc = subprocess.run(cmd, cwd=ROOT, env=env, timeout=timeout,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            out, code = rc.stdout, rc.returncode
        except subprocess.TimeoutExpired as e:
            out, code = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""), "timeout"
        status = "PASS" if code == 0 else "FAIL"
        print(f"{status} {t} ({time.time() - start:.1f}s)", flush=True)
        if code != 0:
            failed.append(t)
            print("\n".join(out.splitlines()[-30:]), flush=True)
    print(f"ran={len(to_run)} failed={len(failed)}")
    for t in failed:
        print(f"FAILED {t}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
