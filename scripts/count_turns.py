#!/usr/bin/env python3
"""Count model turns, calls, output tokens and estimated seconds per phase. Read-only measurement.

Inputs (one or more paths; each a run directory, events.jsonl, or calls.jsonl):
  events.jsonl  real run. turns = number of {"type":"turn_end"} lines (same rule as src/audit.rs:130);
                output tokens = sum(message.usage.output) over turn_end (measured). Each turn is
                assigned to a phase from the tools it called; a turn that calls no tool is "text".
  calls.jsonl   session simulation (no turn_end). Each line: tool, params, ms, started_at.
                If a line carries "turn_id" (or "turn"), turns are counted exactly by distinct id.
                Otherwise calls whose [started_at, started_at+ms] intervals overlap form one turn
                (estimate, marked "turns_kind": "estimated"). Output tokens are always estimated
                as 0.33 * len(json.dumps(params)).

Output: one JSON line per input with path, kind, turns, calls, out_tokens, out_tokens_kind,
turns_kind, seconds_est and a "phases" object (turns, calls, out_tokens, seconds per phase).

Seconds estimate per turn = first_token_s + out_tokens * ms_per_token / 1000 + tool seconds,
where tool seconds is the union of that turn's tool intervals (parallel overlap counted once).

Usage: count_turns.py [--first-token-s 5.0] [--ms-per-token 18.5] <events.jsonl|calls.jsonl|dir> ...
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from collections import Counter

PHASES = ("research", "compute", "editorial", "visual", "publication", "lieflat", "text")
EST_TOKENS_PER_PARAM_CHAR = 0.33

# Prefix rules, first match wins. Unlisted tools fall into "visual" only through the prefixes below;
# anything else is "research" (discovery / planning / meta tools).
_EXACT = {
    "duckdb_query": "compute",
    "record_claim": "compute",
    "newsroom_parallel_tasks": "compute",
    "newsroom_model_validate": "compute",
    "newsroom_editorial_discovery": "editorial",
    "newsroom_story_graph": "editorial",
    "newsroom_semantic_novelty": "editorial",
    "newsroom_visual_concepts": "editorial",
    "newsroom_asset_requirements": "editorial",
    "newsroom_reference_patterns": "editorial",
    "newsroom_expert_preference_record": "editorial",
    "newsroom_award_mode_status": "editorial",
    "newsroom_competition_preflight": "publication",
    "newsroom_portable_publication": "publication",
}
_PREFIX = (
    ("newsroom_lieflat_", "lieflat"),
    ("newsroom_publication_", "publication"),
    ("newsroom_viz_", "visual"),
    ("newsroom_explainer_", "visual"),
    ("newsroom_illustration_", "visual"),
    ("newsroom_infographic_", "visual"),
    ("newsroom_visual_", "visual"),
    ("newsroom_map_", "visual"),
    ("newsroom_basemap_", "visual"),
    ("newsroom_style_map", "visual"),
    ("newsroom_chart", "visual"),
    ("newsroom_network_", "visual"),
    ("newsroom_graph_", "visual"),
)


def phase_of(tool: str | None) -> str:
    if not tool:
        return "text"
    if tool in _EXACT:
        return _EXACT[tool]
    for prefix, phase in _PREFIX:
        if tool.startswith(prefix):
            return phase
    return "research"


def ts(value: str) -> float:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def merged_seconds(intervals: list[tuple[float, float]]) -> float:
    total = 0.0
    cur: list[float] | None = None
    for s, e in sorted(intervals):
        if cur is None or s > cur[1]:
            if cur is not None:
                total += cur[1] - cur[0]
            cur = [s, e]
        else:
            cur[1] = max(cur[1], e)
    if cur is not None:
        total += cur[1] - cur[0]
    return total


def read_jsonl(path: str):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def pick_phase(tools: list[str]) -> str:
    """Majority phase of a turn's tool calls; ties go to the earliest call. No tools -> text."""
    if not tools:
        return "text"
    phases = [phase_of(t) for t in tools]
    counts = Counter(phases)
    best = max(counts.values())
    return next(p for p in phases if counts[p] == best)


def finish(rows: list[dict], first_token_s: float, ms_per_token: float) -> dict:
    phases = {p: dict(turns=0, calls=0, out_tokens=0, seconds=0.0) for p in PHASES}
    for r in rows:
        secs = first_token_s + r["out_tokens"] * ms_per_token / 1000.0 + r["tool_s"]
        g = phases[r["phase"]]
        g["turns"] += 1
        g["calls"] += r["calls"]
        g["out_tokens"] += r["out_tokens"]
        g["seconds"] += secs
    for g in phases.values():
        g["seconds"] = round(g["seconds"], 1)
        g["out_tokens"] = int(round(g["out_tokens"]))
    return dict(
        turns=sum(g["turns"] for g in phases.values()),
        calls=sum(g["calls"] for g in phases.values()),
        out_tokens=sum(g["out_tokens"] for g in phases.values()),
        seconds_est=round(sum(g["seconds"] for g in phases.values()), 1),
        phases=phases,
    )


def count_real(path: str, first_token_s: float, ms_per_token: float) -> dict:
    starts: dict[str, float] = {}
    ends: dict[str, float] = {}
    turn_ends = []
    for e in read_jsonl(path):
        kind = e.get("type")
        stamp = e.get("_newsroom_recorded_at")
        if kind == "tool_execution_start" and stamp and e.get("toolCallId"):
            starts[e["toolCallId"]] = ts(stamp)
        elif kind == "tool_execution_end" and stamp and e.get("toolCallId"):
            ends[e["toolCallId"]] = ts(stamp)
        elif kind == "turn_end":
            turn_ends.append(e)
    rows = []
    for e in turn_ends:
        message = e.get("message") or {}
        calls = [c for c in message.get("content") or [] if c.get("type") == "toolCall"]
        intervals = [
            (starts[c["id"]], ends[c["id"]])
            for c in calls
            if c.get("id") in starts and c.get("id") in ends and ends[c["id"]] >= starts[c["id"]]
        ]
        rows.append(
            dict(
                phase=pick_phase([c.get("name") for c in calls]),
                calls=len(calls),
                out_tokens=(message.get("usage") or {}).get("output", 0) or 0,
                tool_s=merged_seconds(intervals),
            )
        )
    out = finish(rows, first_token_s, ms_per_token)
    out.update(kind="real", turns_kind="measured", out_tokens_kind="measured")
    return out


def count_sim(path: str, first_token_s: float, ms_per_token: float) -> dict:
    calls = []
    for e in read_jsonl(path):
        if not (e.get("tool") and e.get("started_at")):
            continue
        s = ts(e["started_at"])
        calls.append(
            dict(
                start=s,
                end=s + (e.get("ms") or 0) / 1000.0,
                tool=e["tool"],
                turn=e.get("turn_id", e.get("turn")),
                tokens=EST_TOKENS_PER_PARAM_CHAR * len(json.dumps(e.get("params"), ensure_ascii=False)),
            )
        )
    calls.sort(key=lambda c: c["start"])
    exact = bool(calls) and all(c["turn"] is not None for c in calls)
    groups: list[list[dict]] = []
    if exact:
        by_id: dict = {}
        for c in calls:
            by_id.setdefault(c["turn"], []).append(c)
        groups = list(by_id.values())
    else:
        end = None
        for c in calls:
            if end is None or c["start"] >= end:
                groups.append([c])
                end = c["end"]
            else:
                groups[-1].append(c)
                end = max(end, c["end"])
    rows = [
        dict(
            phase=pick_phase([c["tool"] for c in g]),
            calls=len(g),
            out_tokens=sum(c["tokens"] for c in g),
            tool_s=merged_seconds([(c["start"], c["end"]) for c in g]),
        )
        for g in groups
    ]
    out = finish(rows, first_token_s, ms_per_token)
    out.update(
        kind="session_simulation",
        turns_kind="exact" if exact else "estimated",
        out_tokens_kind="estimated",
    )
    return out


def expand(arg: str) -> list[str]:
    if os.path.isdir(arg):
        names = [n for n in ("events.jsonl", "calls.jsonl") if os.path.exists(os.path.join(arg, n))]
        return [os.path.join(arg, n) for n in names]
    return [arg]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    ap.add_argument("--first-token-s", type=float, default=5.0)
    ap.add_argument("--ms-per-token", type=float, default=18.5)
    ap.add_argument("paths", nargs="+")
    args = ap.parse_args(argv)
    for arg in args.paths:
        for path in expand(arg):
            fn = count_real if os.path.basename(path).startswith("events") else count_sim
            result = fn(path, args.first_token_s, args.ms_per_token)
            print(json.dumps(dict(path=path, **result), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
