#!/usr/bin/env python3
"""Fake-Rust check of NEWSROOM_FOLLOWUP_SAME_SETTINGS (the switch that keeps a follow-up's tool list equal to the first question's).

`news continue` builds its own PiConfig; with the switch unset the speed switches are left out of the child's environment, so
NEWSROOM_SPEED_CHAIN_VIZ never reaches the runtime and newsroom_viz_chain is not registered on the follow-up turn. On (exactly "1")
the follow-up's first request offers the same tool names as the first question's. Local stand-in relay on 127.0.0.1, no provider.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_rust_agent import FakeRust, inventory_reply, plan_reply, run_folder  # noqa: E402

SWITCH = "NEWSROOM_FOLLOWUP_SAME_SETTINGS"
BOTH_TURNS = {"NEWSROOM_SPEED_ATOMIC_ARTIFACT": "1", "NEWSROOM_SPEED_CHAIN_VIZ": "1"}
CHAIN = "newsroom_viz_chain"


def script(n, body):
    return {1: plan_reply(), 2: inventory_reply(), 3: {"text": "First answer."}}.get(n, {"text": "Follow-up answer."})


def tool_names(request):
    return sorted(tool["name"] for tool in request["tools"])


def scenario(value):
    """Returns (first turn's tool names, follow-up's first-request tool names)."""
    with FakeRust(script) as fake:
        out = fake.work / "o"
        first = fake.news(["investigate", "--out", str(out), "make a data report"], **BOTH_TURNS)
        run = run_folder(out)
        requests = fake.requests()
        assert len(requests) == 3, (len(requests), first.stderr[-1500:])
        extra = dict(BOTH_TURNS)
        if value is not None:
            extra[SWITCH] = value
        second = fake.news(["continue", str(run), "Which source did the numbers come from?"], **extra)
        later = fake.requests()[len(requests):]
        assert later, second.stderr[-1500:]
        return tool_names(requests[0]), tool_names(later[0])


first, follow = scenario("1")
assert CHAIN in first, first
assert follow == first, (sorted(set(first) ^ set(follow)))

for value in [None, "0", "true", "yes", "", " 1", "01"]:
    first, follow = scenario(value)
    assert CHAIN in first and CHAIN not in follow, (value, sorted(set(first) ^ set(follow)))
    assert sorted(set(first) - set(follow)) == [CHAIN], (value, sorted(set(first) ^ set(follow)))

print("rust follow-up same tools: PASS")
