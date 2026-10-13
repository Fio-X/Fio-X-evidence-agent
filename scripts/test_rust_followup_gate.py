#!/usr/bin/env python3
"""Fake-Rust version of test_followup_completion_gate.py: NEWSROOM_FOLLOWUP_COMPLETION_GATE under NEWSROOM_AGENT=rust, local stand-in relay.

On (exactly "1"): a complex visual follow-up whose tool chain stays incomplete is sent back twice with the completion-gate correction, then the
run ends not verified with a non-zero exit, and the round's verification record says so. Off: one request, no correction, nothing recorded
apart, as before. No provider, no network beyond 127.0.0.1.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_rust_agent import FakeRust, inventory_reply, plan_reply, run_folder  # noqa: E402

COMPLEX = "做一张南华早报（SCMP）风格的中文信息长图：一带一路倡议到2017年的进展，要有地图，数字必须来自可核实的数据。"
PLANTED = '{"passed": true, "marker": "planted-pass"}\n'
SWITCH = "NEWSROOM_FOLLOWUP_COMPLETION_GATE"
SAME_GAPS = "NEWSROOM_SPEED_COMPLETION_SAME_GAPS"


def script(n, body):
    return {1: plan_reply(), 2: inventory_reply(), 3: {"text": "First answer."}}.get(n, {"text": "Follow-up answer, no chain."})


def scenario(switch, same_gaps=None):
    """First question (simple), a planted passing verification, then one complex visual follow-up; returns what the follow-up did."""
    with FakeRust(script) as fake:
        out = fake.work / "o"
        first = fake.news(["investigate", "--out", str(out), "make a data report"])
        run = run_folder(out)
        asked = len(fake.requests())
        assert asked == 3, (asked, first.stderr[-1500:])
        (run / "verification.json").write_text(PLANTED)
        extra = {SWITCH: switch} if switch is not None else {}
        if same_gaps is not None:
            extra[SAME_GAPS] = same_gaps
        second = fake.news(["continue", str(run), COMPLEX], **extra)
        requests = fake.requests()[asked:]
        texts = [json.dumps(r["messages"][-1], ensure_ascii=False) for r in requests]
        ver = json.loads((run / "verification.json").read_text())
        rounds = sorted(p.name for p in (run / "verification-rounds").glob("*.json")) if (run / "verification-rounds").exists() else []
        kept = (run / "verification-rounds" / "round-1.json").read_text() if "round-1.json" in rounds else None
        events = []
        for path in run.glob("events.jsonl"):
            events = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        scenario.skips = [e for e in events if e.get("type") == "completion_retry_skipped"]
        return second, texts, ver, rounds, kept


# A. on: the follow-up is sent back twice (the first question's correction text), then fails and says so.
second, texts, ver, rounds, kept = scenario("1")
assert len(texts) == 3, ([t[:100] for t in texts], second.stderr[-1500:])
assert "System completion gate attempt 1/2 found unfinished required work" in texts[1], texts[1][:300]
assert "System completion gate attempt 2/2 found unfinished required work" in texts[2], texts[2][:300]
assert "required complex-visual gate did not pass: newsroom_infographic_plan" in texts[1], texts[1][:400]
assert second.returncode != 0 and "visual delivery incomplete" in second.stdout + second.stderr, (second.returncode, second.stderr[-800:])
assert ver["passed"] is False and ver["round_status"] == "not_verified" and ver["stage"] == "completion_gate", ver
assert ver["previous_round_file"] == "verification-rounds/round-1.json" and kept == PLANTED, (ver, rounds)

# B. off (unset, and every value that is not exactly "1"): one request, no correction, nothing recorded apart.
for value in [None, "0", "true", "yes", "", " 1", "01"]:
    second, texts, ver, rounds, kept = scenario(value)
    assert len(texts) == 1 and "System completion gate" not in texts[0], (value, [t[:100] for t in texts])
    assert rounds == [] and "round_status" not in ver and ver.get("marker") != "planted-pass", (value, rounds, ver)

# C. NEWSROOM_SPEED_COMPLETION_SAME_GAPS exactly "1" (K349 ON variant). Every OFF assertion above is unchanged. The follow-up here is text-only (no tool call),
# so the second completion attempt is not sent: exactly 2 requests, one completion_retry_skipped event, and the same failure text, exit code and status as off.
off_second, off_texts, off_ver, off_rounds, off_kept = scenario("1")
assert len(off_texts) == 3 and scenario.skips == [], ([t[:100] for t in off_texts], scenario.skips)
second, texts, ver, rounds, kept = scenario("1", same_gaps="1")
assert len(texts) == 2, ([t[:100] for t in texts], second.stderr[-1500:])
assert "System completion gate attempt 1/2 found unfinished required work" in texts[1], texts[1][:300]
assert not any("attempt 2/2" in t for t in texts)
assert len(scenario.skips) == 1 and scenario.skips[0]["attempt"] == 2 and scenario.skips[0]["reason"] == "same_gaps_no_tool_call" and scenario.skips[0]["gaps"], scenario.skips
assert second.returncode == off_second.returncode != 0, (second.returncode, off_second.returncode)
assert "visual delivery incomplete" in second.stdout + second.stderr and "visual delivery incomplete" in off_second.stdout + off_second.stderr
assert {k: v for k, v in ver.items() if k != "verified_at"} == {k: v for k, v in off_ver.items() if k != "verified_at"} and ver["passed"] is False and ver["round_status"] == "not_verified" and ver["stage"] == "completion_gate", (ver, off_ver)
assert ver["previous_round_file"] == "verification-rounds/round-1.json" and kept == PLANTED and rounds == off_rounds, (ver, rounds)

# D. values that are not exactly "1" are off for the new switch: three requests, no skip event.
for value in ["0", "true", "yes", "", " 1", "01"]:
    second, texts, ver, rounds, kept = scenario("1", same_gaps=value)
    assert len(texts) == 3 and scenario.skips == [], (value, len(texts), scenario.skips)

# E. the follow-up gate itself off: the new switch changes nothing.
second, texts, ver, rounds, kept = scenario(None, same_gaps="1")
assert len(texts) == 1 and rounds == [] and scenario.skips == [], (len(texts), rounds, scenario.skips)

print("rust follow-up completion gate: PASS")
