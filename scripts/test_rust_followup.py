#!/usr/bin/env python3
"""Fake-Rust version of the follow-up tests (1012zi step 2): `news continue` on a run the Rust agent wrote, NEWSROOM_AGENT=rust, local stand-in relay.

The follow-up resumes the run's own agent-session (its history is sent to the model ahead of the new question, new records are appended
after it), the run folder is the same one, and the question reaches the model. A folder written by the old runtime is covered by
test_old_result_followup.py. No provider, no network beyond 127.0.0.1.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_rust_agent import FakeRust, inventory_reply, plan_reply, run_folder  # noqa: E402

FIRST = "First answer text of the original run."
FOLLOW = "Follow-up answer text."
QUESTION = "and what about the year 2020?"


def script(n, body):
    return {1: plan_reply(), 2: inventory_reply(), 3: {"text": FIRST}}.get(n, {"text": FOLLOW})


with FakeRust(script) as fake:
    out = fake.work / "o"
    first = fake.news(["investigate", "--out", str(out), "make a data report"])
    run = run_folder(out)
    session = run / "agent-session" / "session.jsonl"
    before = session.read_text().count("\n")
    asked = len(fake.requests())
    assert asked == 3 and before > 3, (asked, before, first.stderr[-1500:])

    second = fake.news(["continue", str(run), QUESTION])
    assert second.returncode in (0, 1), (second.returncode, second.stderr[-2000:])
    assert "continuing: " in second.stderr and str(run) in second.stderr
    requests = fake.requests()
    assert len(requests) > asked, "the follow-up asked the model nothing"
    messages = requests[asked]["messages"]
    text = json.dumps(messages, ensure_ascii=False)
    assert FIRST in text, "the history of the original run was not sent"
    assert QUESTION in json.dumps(messages[-1], ensure_ascii=False), "the question is not the last message"
    assert messages[-1]["role"] == "user"
    after = session.read_text().count("\n")
    assert after > before, (before, after)
    assert FOLLOW in session.read_text()
    assert [p for p in out.iterdir() if p.is_dir() and p.name != "runtime"] == [run], "the follow-up made a new run folder"

print("rust follow-up: PASS")
