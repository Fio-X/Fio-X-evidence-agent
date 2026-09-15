#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "scripts" / "mock_pi.py"


def run_once(artifact: Path, resume: bool):
    env = os.environ.copy()
    env["NEWSROOM_ARTIFACT_DIR"] = str(artifact)
    args = [str(MOCK), "--mode", "rpc"]
    if resume:
        args.append("-c")
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
    assert proc.stdin and proc.stdout
    proc.stdin.write(json.dumps({"id": "p", "type": "prompt", "message": "smoke"}) + "\n")
    proc.stdin.flush()
    events = []
    while True:
        line = proc.stdout.readline()
        assert line, "mock Pi ended before agent_settled"
        event = json.loads(line)
        events.append(event)
        if event.get("type") == "agent_settled":
            break
    proc.stdin.write(json.dumps({"id": "t", "type": "get_last_assistant_text"}) + "\n")
    proc.stdin.write(json.dumps({"id": "s", "type": "get_session_stats"}) + "\n")
    proc.stdin.flush()
    responses = [json.loads(proc.stdout.readline()), json.loads(proc.stdout.readline())]
    proc.stdin.close()
    proc.wait(timeout=5)
    assert proc.returncode == 0
    return events, responses


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="newsroom-mock-pi-") as tmp:
        root = Path(tmp)
        events, responses = run_once(root, False)
        assert any(e.get("type") == "tool_execution_end" and e.get("toolName") == "fetch_url" and e.get("isError") is True for e in events)
        assert any(e.get("type") == "tool_execution_end" and e.get("toolName") == "duckdb_query" and e.get("isError") is False for e in events)
        stats = next(r for r in responses if r.get("command") == "get_session_stats")
        assert stats["data"]["userMessages"] == 1
        assert (root / "visualizations" / "mock.svg").is_file()
        assert (root / "visualizations" / "mock.mobile.svg").is_file()

        resume_events, resume_responses = run_once(root, True)
        assert any(e.get("type") == "tool_execution_end" and e.get("toolName") == "newsroom_update_plan" and e.get("isError") is False for e in resume_events)
        resume_stats = next(r for r in resume_responses if r.get("command") == "get_session_stats")
        assert resume_stats["data"]["userMessages"] == 2
        plan = json.loads((root / "plan.json").read_text())
        assert plan["revision"] == 3

    print("mock Pi RPC smoke: PASS")
    print("failure event -> successful capability recovery -> resume stats: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
