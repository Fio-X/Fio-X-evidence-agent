#!/usr/bin/env python3
"""Fake-Rust version of test_output_location.py (1012zi step 2): where a run on the Rust agent writes its folder, NEWSROOM_AGENT=rust.

Without --out the root is `.newsroom/artifacts` under the current directory and is reported as output_root=; --confirm-output without a terminal
refuses before the model is asked; an explicit --out is used as given. No provider, no network beyond 127.0.0.1.
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_rust_agent import FakeRust, inventory_reply, plan_reply  # noqa: E402


def script(n, body):
    return {1: plan_reply(), 2: inventory_reply()}.get(n, {"text": "Fake answer."})


with FakeRust(script) as fake:
    cwd = fake.work  # already canonical (resolved)
    root = cwd / ".newsroom" / "artifacts"
    refused = fake.news(["investigate", "--confirm-output", "confirmation should fail closed"], stdin=subprocess.DEVNULL)
    assert refused.returncode == 2, (refused.returncode, refused.stderr[-1500:])
    assert "--confirm-output requires an interactive terminal" in refused.stderr
    assert not fake.requests(), "the model was asked before the confirmation was refused"

    default = fake.news(["investigate", "current directory output"])
    assert default.returncode in (0, 1), (default.returncode, default.stderr[-1500:])
    runs = [p for p in root.iterdir() if p.is_dir()]
    assert len(runs) == 1 and (runs[0] / "story.json").is_file(), runs
    assert f"output_root={root}" in default.stderr, default.stderr[-1500:]

    explicit = fake.work / "chosen"
    given = fake.news(["investigate", "--out", str(explicit), "explicit output"])
    assert given.returncode in (0, 1), (given.returncode, given.stderr[-1500:])
    assert [p for p in explicit.iterdir() if p.is_dir() and p.name != "runtime"], "nothing under the explicit --out"
    assert len([p for p in root.iterdir() if p.is_dir()]) == 1, "the explicit run also wrote under the default root"

print("rust output location: PASS")
