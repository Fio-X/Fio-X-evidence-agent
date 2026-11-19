#!/usr/bin/env python3
"""`news verify <run-dir> --json`: one JSON object on stdout that restates what verification.json says; exit codes unchanged.

The complete run dir is made the way test_investigate_exit_codes.py makes its happy run (the scripted mock Pi, no provider, no network);
its end-of-run line must be VERIFIED. The same dir is then copied and broken (claims.jsonl made unreadable) in a temp copy.
For each dir this checks: stdout is exactly one JSON object, its passed/checks/errors equal the fields of verification.json, they equal
what the text mode prints, the exit code (0 verified, 1 not verified, 2 no such dir) and the VERIFIED / NOT VERIFIED line agree with
`passed`. VERIFY_JSON_RUN_DIR=<a stored run dir> adds that dir (copied first; the original is never written).

Run: python3 scripts/test_verify_json.py   (NEWS_BIN=<path> to use a given binary; default target/debug/news)
"""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("NEWS_BIN") or ROOT / "target" / "debug" / "news")
MOCK = ROOT / "scripts" / "mock_pi.py"

if not BINARY.is_file():
    raise SystemExit("build target/debug/news (or set NEWS_BIN) before running this check")


def news(args):
    env = os.environ.copy()
    env.update({"NEWSROOM_AGENT": "pi", "NEWSROOM_RPC_STARTUP_MS": "10000", "NEWSROOM_RPC_IDLE_MS": "8000",
                "NEWSROOM_RPC_FINISH_MS": "8000", "NEWSROOM_RPC_TOTAL_MS": "30000"})
    return subprocess.run([str(BINARY), *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)


def last_line(result):
    lines = [line for line in result.stderr.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def check_dir(label, run_dir, want_passed):
    """Verify `run_dir` in both modes and compare. Returns the JSON object."""
    as_json = news(["verify", str(run_dir), "--json"])
    record = json.loads((run_dir / "verification.json").read_text(encoding="utf-8"))  # written by the --json run itself
    # stdout is one JSON object and nothing else
    assert as_json.stdout.endswith("\n") and as_json.stdout.count("\n") == 1, (label, as_json.stdout[:300])
    out = json.loads(as_json.stdout)
    assert isinstance(out, dict), (label, out)
    assert out["passed"] is want_passed and record["passed"] is want_passed, (label, out["passed"], record["passed"])
    assert as_json.returncode == (0 if want_passed else 1), (label, as_json.returncode, as_json.stderr[-500:])
    if want_passed:
        assert last_line(as_json) == "VERIFIED", (label, last_line(as_json))
    else:
        assert last_line(as_json).startswith("NOT VERIFIED: "), (label, last_line(as_json))
    # the fields are the ones verification.json has
    assert out["checks"] == record["checks"], (label, out["checks"], record["checks"])
    assert out["integrity"] == record["integrity"], (label, out["integrity"], record["integrity"])
    recompute = record.get("recompute")
    expected_errors = list(record["integrity"]["errors"]) + (list(recompute["errors"]) if recompute else [])
    assert out["errors"] == expected_errors, (label, out["errors"], expected_errors)
    assert (out["recompute"] is None) == (recompute is None), (label, out["recompute"], recompute)
    assert Path(out["report"]).name == "verification.json", (label, out["report"])
    assert bool(out["errors"]) == (not want_passed), (label, out["errors"])
    # the text mode on the same dir says the same
    text = news(["verify", str(run_dir)])
    assert text.returncode == as_json.returncode and last_line(text) == last_line(as_json), (label, text.returncode, last_line(text))
    fails = [line[len("FAIL  "):] for line in text.stdout.splitlines() if line.startswith("FAIL  ")]
    assert fails == out["errors"], (label, fails, out["errors"])
    assert f"integrity checks: {out['integrity']['checks']}" in text.stdout.splitlines(), label
    return out


def artifact_of(out):
    dirs = [p for p in Path(out).iterdir() if p.is_dir()]
    assert len(dirs) == 1, dirs
    return dirs[0]


with tempfile.TemporaryDirectory(prefix="news-verify-json-") as tmp:
    tmp = Path(tmp)

    # the complete run: its own end-of-run verdict is VERIFIED and exit 0
    made = news(["investigate", "--pi-bin", str(MOCK), "--out", str(tmp / "happy"), "happy path"])
    assert made.returncode == 0 and last_line(made) == "VERIFIED", (made.returncode, made.stderr[-1500:])
    happy = artifact_of(tmp / "happy")
    good = check_dir("complete run", happy, True)
    assert good["errors"] == [] and good["checks"] > 0, good

    # the same dir, broken in a copy: the end-of-run check would say NOT VERIFIED, so must this
    broken = tmp / "broken"
    shutil.copytree(happy, broken)
    (broken / "claims.jsonl").write_text("{not json\n", encoding="utf-8")
    bad = check_dir("broken copy", broken, False)
    assert bad["errors"], bad
    assert bad["integrity"]["passed"] is False and bad["recompute"] is None, bad

    # a dir that is not there: usage error 2, nothing on stdout
    missing = news(["verify", str(tmp / "no-such-dir"), "--json"])
    assert missing.returncode == 2 and missing.stdout == "", (missing.returncode, missing.stdout[:200])
    assert last_line(missing).startswith("NOT VERIFIED: "), last_line(missing)

    # an optional stored run dir; whatever it verifies as, JSON and text must agree
    stored = os.environ.get("VERIFY_JSON_RUN_DIR")
    if stored:
        copy = tmp / "stored"
        shutil.copytree(stored, copy)
        probe = news(["verify", str(copy)])
        check_dir("stored run dir", copy, probe.returncode == 0)

print("verify --json: PASS")
