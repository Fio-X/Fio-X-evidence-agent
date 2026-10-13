#!/usr/bin/env python3
"""Fake-Rust version of test_investigate_exit_codes.py (1012zi step 2): NEWSROOM_AGENT=rust against the local stand-in relay.

A run that ends without a chart is completed but NOT VERIFIED (exit 1, verdict line last, verification.json written); a provider failure is
exit 2 with the class shown and no raw provider text; `verify` and usage errors keep their codes. No provider, no network beyond 127.0.0.1.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_rust_agent import FakeRust, inventory_reply, last_line, plan_reply, run_folder  # noqa: E402

RAW = "MOCK-RAW-PROVIDER-TEXT"


def happy(n, body):
    return {1: plan_reply(), 2: inventory_reply()}.get(n, {"text": "Fake answer: nothing was investigated."})


def auth_error(n, body):
    return {"error": {"status": 401, "type": "authentication_error", "message": RAW}}


with FakeRust(happy) as fake:
    out = fake.work / "happy"
    done = fake.news(["investigate", "--out", str(out), "make a data report"])
    assert done.returncode == 1, (done.returncode, done.stderr[-2000:])
    assert last_line(done).startswith("NOT VERIFIED: "), last_line(done)
    run = run_folder(out)
    assert (run / "verification.json").is_file() and (run / "agent-session" / "session.jsonl").is_file()
    bad = fake.news(["verify", str(run)])
    assert bad.returncode == 1 and last_line(bad).startswith("NOT VERIFIED: "), (bad.returncode, last_line(bad))
    missing = fake.news(["verify", str(fake.work / "no-such-dir")])
    assert missing.returncode == 2 and last_line(missing).startswith("NOT VERIFIED: "), (missing.returncode, last_line(missing))
    usage = fake.news(["investigate", "--no-such-flag"])
    assert usage.returncode == 2, usage.returncode

with FakeRust(auth_error) as fake:
    failed = fake.news(["investigate", "--out", str(fake.work / "failed"), "provider failure"])
    assert failed.returncode == 2, (failed.returncode, failed.stderr[-2000:])
    assert "provider_authentication_failed" in failed.stderr, failed.stderr[-2000:]
    assert RAW not in failed.stdout + failed.stderr
    assert last_line(failed) == "NOT VERIFIED: run failed before verification", last_line(failed)
    events = (run_folder(fake.work / "failed") / "events.jsonl").read_text()
    assert RAW not in events
    assert len([l for l in events.splitlines() if '"newsroom_rpc_failure"' in l]) == 1

print("rust investigate exit codes: PASS")
