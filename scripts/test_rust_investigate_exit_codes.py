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

# #64 step 1: a switch turned off with exactly "0" is said once on stderr and in the run-metrics line; a default run says nothing
with FakeRust(happy) as fake:
    def metrics_of(out):
        files = list(run_folder(out).rglob("run-metrics.jsonl"))
        assert len(files) == 1, files
        return [json.loads(x) for x in files[0].read_text(encoding="utf-8").splitlines() if x.strip()]

    plain = fake.news(["investigate", "--out", str(fake.work / "metric-default"), "make a data report"])
    assert "group switch turned off" not in plain.stderr, plain.stderr[-500:]
    assert all("group_switches_off" not in m for m in metrics_of(fake.work / "metric-default"))
    off_run = fake.news(["investigate", "--out", str(fake.work / "metric-off"), "make a data report"], NEWSROOM_GROUP_CALL_REPORT="0", NEWSROOM_GROUP_CALL_REFUSE="0", NEWSROOM_GROUP_CALL_REFUSE_ALL="0")  # the off-table refusal is on by default and stops a run whose call report is off; this check is about the off-note, so both are "0"
    assert off_run.stderr.count("note: group switch turned off for this run: NEWSROOM_GROUP_CALL_REPORT") == 1, off_run.stderr[-500:]
    assert any(m.get("group_switches_off") == ["NEWSROOM_GROUP_CALL_REPORT"] for m in metrics_of(fake.work / "metric-off"))
    near = fake.news(["investigate", "--out", str(fake.work / "metric-near"), "make a data report"], NEWSROOM_GROUP_CALL_REPORT="false")
    assert "group switch turned off" not in near.stderr and all("group_switches_off" not in m for m in metrics_of(fake.work / "metric-near"))

# K373 (#64 step 1): the Rust agent stops at startup, before any run folder, only when the hand-off is exactly "0";
# unset and every other value mean on and do not stop it.
with FakeRust(happy) as fake:
    out = fake.work / "nohandoff-0"
    stopped = fake.news(["investigate", "--out", str(out), "make a data report"], NEWSROOM_GROUP_HANDOFF="0", NEWSROOM_GROUP_CALL_REFUSE="0", NEWSROOM_GROUP_CALL_REFUSE_ALL="0")  # the off-table refusal chain would stop this start-up first (it needs the hand-off); this check is about the hand-off message, so both are "0"
    assert stopped.returncode != 0 and "RUST_AGENT_NEEDS_HANDOFF" in stopped.stderr, (stopped.returncode, stopped.stderr[-500:])
    assert not out.exists()
    for value in ("", "true", " 0", "00", "false"):
        started = fake.news(["investigate", "--out", str(fake.work / f"handoff-{value or 'empty'}"), "make a data report"], NEWSROOM_GROUP_HANDOFF=value)
        assert "RUST_AGENT_NEEDS_HANDOFF" not in started.stderr, (value, started.stderr[-500:])
    verify_ok = fake.news(["verify", str(fake.work / "no-such-dir")], NEWSROOM_GROUP_HANDOFF="0")
    assert "RUST_AGENT_NEEDS_HANDOFF" not in verify_ok.stderr

# K381 (B2), moved by #64 step 4: TOOLS follows the refusal, so the start-up note now prints only for an explicit TOOLS=0 with the refusal on;
# it changes nothing else, and every other combination stays silent
NOTE = "NEWSROOM_GROUP_TOOLS=0 with the refusal"
with FakeRust(happy) as fake:
    gone = str(fake.work / "no-such-dir")
    plain = fake.news(["verify", gone])
    noted = fake.news(["verify", gone], NEWSROOM_GROUP_ENFORCE="1", NEWSROOM_GROUP_HANDOFF="1", NEWSROOM_GROUP_TOOLS="0")
    unset = fake.news(["verify", gone], NEWSROOM_GROUP_ENFORCE="1", NEWSROOM_GROUP_HANDOFF="1")
    both = fake.news(["verify", gone], NEWSROOM_GROUP_ENFORCE="1", NEWSROOM_GROUP_HANDOFF="1", NEWSROOM_GROUP_TOOLS="1")
    word = fake.news(["verify", gone], NEWSROOM_GROUP_ENFORCE="true")
    assert NOTE in noted.stderr and noted.returncode == plain.returncode == 2, (noted.returncode, noted.stderr[-300:])
    assert noted.stdout == plain.stdout and noted.stderr.replace(noted.stderr.splitlines()[0] + "\n", "", 1) == plain.stderr
    for quiet in (plain, unset, both, word):
        assert NOTE not in quiet.stderr, quiet.stderr[-300:]

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
