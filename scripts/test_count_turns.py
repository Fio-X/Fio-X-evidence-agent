#!/usr/bin/env python3
"""Synthetic-event tests for scripts/count_turns.py (no real run logs)."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "count_turns.py"


def stamp(sec: float) -> str:
    return f"2026-01-01T00:{int(sec // 60):02d}:{sec % 60:06.3f}Z"


def run(path: Path, *extra: str) -> dict:
    out = subprocess.run([sys.executable, str(SCRIPT), *extra, str(path)], check=True, capture_output=True, text=True)
    lines = [json.loads(line) for line in out.stdout.splitlines()]
    assert len(lines) == 1
    return lines[0]


def write(path: Path, rows: list[dict]) -> Path:
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    return path


def turn_end(at: float, calls: list[tuple[str, str]], output: int) -> dict:
    return {
        "type": "turn_end",
        "_newsroom_recorded_at": stamp(at),
        "message": {
            "content": [{"type": "toolCall", "id": i, "name": n} for i, n in calls] or [{"type": "text", "text": "x"}],
            "usage": {"output": output},
        },
    }


def tool(kind: str, call_id: str, at: float) -> dict:
    return {"type": f"tool_execution_{kind}", "toolCallId": call_id, "_newsroom_recorded_at": stamp(at)}


def test_real_run(tmp: Path) -> None:
    events = [
        {"type": "turn_start"},
        tool("start", "a", 10),
        tool("start", "b", 12),  # overlaps a: union is 10..16 = 6s
        tool("end", "a", 14),
        tool("end", "b", 16),
        turn_end(17, [("a", "fetch_url"), ("b", "fetch_url")], 100),
        {"type": "message_update"},
        tool("start", "c", 20),
        tool("end", "c", 22),
        turn_end(23, [("c", "newsroom_lieflat_render")], 50),
        turn_end(30, [], 200),  # text-only turn
        turn_end(31, [("d", "duckdb_query"), ("e", "record_claim"), ("f", "fetch_url")], 10),
    ]
    got = run(write(tmp / "events.jsonl", events))
    assert got["kind"] == "real" and got["turns_kind"] == "measured" and got["out_tokens_kind"] == "measured"
    assert got["turns"] == 4 and got["calls"] == 6 and got["out_tokens"] == 360
    ph = got["phases"]
    assert (ph["research"]["turns"], ph["research"]["calls"]) == (1, 2)
    assert (ph["lieflat"]["turns"], ph["compute"]["turns"], ph["text"]["turns"]) == (1, 1, 1)  # majority phase
    assert sum(p["turns"] for p in ph.values()) == got["turns"]
    # research turn: 5.0 + 100*0.0185 + 6.0 (merged overlap) = 12.85
    assert abs(ph["research"]["seconds"] - 12.85) <= 0.05
    assert ph["lieflat"]["seconds"] == round(5.0 + 50 * 0.0185 + 2.0, 1)
    custom = run(tmp / "events.jsonl", "--first-token-s", "0", "--ms-per-token", "0")
    assert custom["phases"]["research"]["seconds"] == 6.0


def test_sim_estimated(tmp: Path) -> None:
    rows = [
        {"tool": "fetch_url", "params": {"u": "x"}, "ms": 4000, "started_at": stamp(0)},
        {"tool": "fetch_url", "params": {"u": "y"}, "ms": 1000, "started_at": stamp(1)},  # overlaps -> same turn
        {"tool": "duckdb_query", "params": {"q": "select 1"}, "ms": 500, "started_at": stamp(10)},
        {"note": "ignored line without tool"},
    ]
    got = run(write(tmp / "calls.jsonl", rows))
    assert got["kind"] == "session_simulation" and got["turns_kind"] == "estimated"
    assert got["out_tokens_kind"] == "estimated"
    assert got["turns"] == 2 and got["calls"] == 3
    assert got["phases"]["research"]["seconds"] == round(5.0 + got["phases"]["research"]["out_tokens"] * 0.0185 + 4.0, 1)


def test_sim_exact_turn_ids(tmp: Path) -> None:
    rows = [
        {"tool": "fetch_url", "params": {}, "ms": 100, "started_at": stamp(0), "turn_id": 1},
        {"tool": "fetch_url", "params": {}, "ms": 100, "started_at": stamp(50), "turn_id": 1},  # same id, apart in time
        {"tool": "newsroom_infographic_plan", "params": {}, "ms": 100, "started_at": stamp(60), "turn_id": 2},
    ]
    (tmp / "exact").mkdir()
    got = run(write(tmp / "exact" / "calls.jsonl", rows))
    assert got["turns_kind"] == "exact" and got["turns"] == 2
    assert got["phases"]["visual"]["turns"] == 1


def test_directory_and_empty(tmp: Path) -> None:
    d = tmp / "dir"
    d.mkdir()
    write(d / "events.jsonl", [turn_end(1, [], 1)])
    write(d / "calls.jsonl", [])
    out = subprocess.run([sys.executable, str(SCRIPT), str(d)], check=True, capture_output=True, text=True)
    kinds = sorted(json.loads(line)["kind"] for line in out.stdout.splitlines())
    assert kinds == ["real", "session_simulation"]


def main() -> None:
    for fn in (test_real_run, test_sim_estimated, test_sim_exact_turn_ids, test_directory_and_empty):
        with tempfile.TemporaryDirectory() as raw:
            fn(Path(raw))
    print(json.dumps({"status": "PASS"}))


if __name__ == "__main__":
    main()
