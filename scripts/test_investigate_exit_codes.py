#!/usr/bin/env python3
"""Exit codes and verdict line of `news investigate` / `news continue`.

0 = VERIFIED, 1 = completed but NOT VERIFIED, 2 = error before a verdict
(including a provider failure after partial streamed text and clap usage errors).
Uses the scripted mock Pi only; no provider or network access.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target" / "debug" / "news"
MOCK = ROOT / "scripts" / "mock_pi.py"
RAW = "MOCK-RAW-PROVIDER-TEXT"

if not BINARY.is_file():
    raise SystemExit("build target/debug/news before running this check")


def run(args, extra_env=None, cwd=None):
    env = os.environ.copy()
    env.update({
        "NEWSROOM_RPC_STARTUP_MS": "10000",
        "NEWSROOM_RPC_IDLE_MS": "8000",
        "NEWSROOM_RPC_FINISH_MS": "8000",
        "NEWSROOM_RPC_TOTAL_MS": "30000",
    })
    env.update(extra_env or {})
    return subprocess.run([str(BINARY), *args], cwd=cwd or ROOT, env=env,
                          capture_output=True, text=True, timeout=60)


def last_line(result):
    lines = [line for line in result.stderr.splitlines() if line.strip()]
    return lines[-1] if lines else ""


def artifact_of(out):
    dirs = [p for p in Path(out).iterdir() if p.is_dir()]
    assert len(dirs) == 1, dirs
    return dirs[0]


with tempfile.TemporaryDirectory(prefix="news-exit-codes-") as tmp:
    tmp = Path(tmp)

    # (d) happy path: exit 0 and VERIFIED; continue too.
    out = tmp / "happy"
    ok = run(["investigate", "--pi-bin", str(MOCK), "--out", str(out), "happy path"])
    assert ok.returncode == 0, ok.stderr[-2000:]
    assert last_line(ok) == "VERIFIED", last_line(ok)
    artifact = artifact_of(out)
    cont = run(["continue", "--pi-bin", str(MOCK), str(artifact), "follow up"])
    assert cont.returncode == 0, cont.stderr[-2000:]
    assert last_line(cont) == "VERIFIED", last_line(cont)

    # (c) artifact failing integrity: exit 1, NOT VERIFIED line. The mock
    # writes a valid artifact at startup, so corrupt one evidence file afterwards
    # via a wrapper that damages claims.jsonl before the run settles.
    wrapper = tmp / "corrupting_pi.py"
    wrapper.write_text(
        "#!/usr/bin/env python3\n"
        "import os, runpy, sys\n"
        "from pathlib import Path\n"
        "import atexit\n"
        f"mock = {str(MOCK)!r}\n"
        "def damage():\n"
        "    root = Path(os.environ['NEWSROOM_ARTIFACT_DIR'])\n"
        "    claims = root / 'claims.jsonl'\n"
        "    if claims.exists():\n"
        "        claims.write_text('{not json\\n', encoding='utf-8')\n"
        "atexit.register(damage)\n"
        "sys.argv[0] = mock\n"
        "runpy.run_path(mock, run_name='__main__')\n",
        encoding="utf-8")
    wrapper.chmod(0o755)
    out = tmp / "corrupt"
    bad = run(["investigate", "--pi-bin", str(wrapper), "--out", str(out), "integrity failure"])
    assert bad.returncode == 1, (bad.returncode, bad.stderr[-2000:])
    assert last_line(bad).startswith("NOT VERIFIED: "), last_line(bad)
    assert (artifact_of(out) / "verification.json").is_file()

    # (a) provider error after partial text: exit 2, class shown, no raw text.
    for scenario in ("provider_error_after_text", "provider_error_no_text"):
        out = tmp / scenario
        failed = run(["investigate", "--pi-bin", str(MOCK), "--out", str(out), "provider failure"],
                     {"MOCK_PI_SCENARIO": scenario})
        combined = failed.stdout + failed.stderr
        assert failed.returncode == 2, (scenario, failed.returncode, failed.stderr[-2000:])
        assert "provider_timeout" in failed.stderr, failed.stderr[-2000:]
        assert RAW not in combined, scenario
        artifact = artifact_of(out)
        assert RAW not in (artifact / "events.jsonl").read_text(encoding="utf-8")
        answer = (artifact / "answer.md").read_text(encoding="utf-8")
        assert "Investigation failed" in answer and RAW not in answer
        if scenario == "provider_error_after_text":
            assert "Partial output" in answer and "Mock investigation completed" in answer
        failures = [json.loads(line) for line in (artifact / "events.jsonl").read_text().splitlines()
                    if '"newsroom_rpc_failure"' in line]
        assert len(failures) == 1, failures
        failure = failures[0]
        assert failure["class"] == "provider_timeout" and failure["http_status"] == 504, failure
        assert failure["events_received"] > 0 and failure["bytes_received"] > 0, failure
        assert failure["failed_turn_context_tokens"] == 51000, failure
        assert "[agent] rpc_failure class=provider_timeout" in failed.stderr

    # verify: VERIFIED 0, NOT VERIFIED 1, missing directory 2.
    good = run(["verify", str(artifact_of(tmp / "happy"))])
    assert good.returncode == 0 and last_line(good) == "VERIFIED", good.stderr
    bad_verify = run(["verify", str(artifact_of(tmp / "corrupt"))])
    assert bad_verify.returncode == 1, bad_verify.returncode
    assert last_line(bad_verify).startswith("NOT VERIFIED: "), last_line(bad_verify)
    missing = run(["verify", str(tmp / "no-such-dir")])
    assert missing.returncode == 2, (missing.returncode, missing.stderr)
    assert last_line(missing).startswith("NOT VERIFIED: "), last_line(missing)

    # (b) same for continue (existing artifact from the happy run).
    artifact = artifact_of(tmp / "happy")
    cont_fail = run(["continue", "--pi-bin", str(MOCK), str(artifact), "follow up again"],
                    {"MOCK_PI_SCENARIO": "provider_error_after_text"})
    assert cont_fail.returncode == 2, cont_fail.stderr[-2000:]
    assert "provider_timeout" in cont_fail.stderr
    assert RAW not in cont_fail.stdout + cont_fail.stderr

    # Usage error: clap exits 2.
    usage = run(["investigate", "--no-such-flag"])
    assert usage.returncode == 2, usage.returncode

print("investigate exit codes: PASS")
