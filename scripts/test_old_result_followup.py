#!/usr/bin/env python3
"""A follow-up question on a result written by the old runtime (1012zi step 3).

With NEWSROOM_AGENT=rust, `news continue` on a run folder without `agent-session/session.jsonl` (a session of the old runtime, an empty or
cleared `session/`, no session at all) prints one line and exits 3 before any child starts. A run folder with an `agent-session/`, and the
default (old) runtime, never show the line. No provider, no network.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("NEWS_BIN") or ROOT / "target" / "debug" / "news")
LINE = "这个结果是旧版本跑的，不能接着追问；请重新提问"

if not BINARY.is_file():
    raise SystemExit("build target/debug/news before running this check")


def run_folder(base: Path, name: str, old: bool, new: bool, empty_old: bool = False) -> Path:
    run = base / name
    run.mkdir()
    (run / "story.json").write_text(json.dumps({"id": name, "topic": "old topic"}))
    if old or empty_old:
        (run / "session").mkdir()
    if old:
        (run / "session" / "old.jsonl").write_text("{}\n")
    if new:
        (run / "agent-session").mkdir()
        (run / "agent-session" / "session.jsonl").write_text("")
    return run


def follow_up(run: Path, agent):
    env = {k: v for k, v in os.environ.items() if not k.startswith("NEWSROOM_")}
    if agent is not None:
        env["NEWSROOM_AGENT"] = agent
    return subprocess.run(
        [str(BINARY), "continue", "--pi-bin", "/nonexistent/pi", str(run), "and then?"],
        env=env, capture_output=True, text=True, timeout=60, cwd=run.parent)


with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp)
    # refused: only the old runtime's session, only an empty session/ (what a new run folder starts with), nothing at all
    for name, old, empty, new in (("old", True, False, False), ("empty-session", False, True, False), ("none", False, False, False)):
        refused = follow_up(run_folder(base, name, old=old, new=False, empty_old=empty), "rust")
        assert refused.returncode == 3, (name, refused.returncode, refused.stderr[-1500:])
        lines = [l for l in refused.stderr.splitlines() if LINE in l]
        assert len(lines) == 1, (name, refused.stderr[-1500:])
        assert "continuing:" not in refused.stderr and refused.stdout == "", (name, refused.stdout, refused.stderr[-1500:])

    # not refused: a folder with an agent-session (alone, or beside an old session/). The run goes on to start: "continuing:" is printed
    # right before the child is started.
    for name, old, new in (("new", False, True), ("both", True, True)):
        run = run_folder(base, name, old=old, new=new)
        other = follow_up(run, "rust")
        assert LINE not in other.stderr, (name, other.stderr[-1500:])
        assert "continuing: " in other.stderr, (name, other.stderr[-1500:])

    # the default and the explicit old runtime are untouched, whatever the folder holds
    old = run_folder(base, "old-for-pi", old=True, new=False)
    for agent in (None, "pi"):
        same = follow_up(old, agent)
        assert LINE not in same.stderr, (agent, same.stderr[-1500:])
        assert "continuing: " in same.stderr, (agent, same.stderr[-1500:])

print("ok: old-result follow-up")
