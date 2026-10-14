#!/usr/bin/env python3
"""`news interactive` under the group switches, in two arms. Both run the stand-in session of test_interactive_cli.py (local mock agent, no provider).

Enforce arm (all five switches on, enforcing): the session starts, imports data, answers, follows up and stops the visual gate with 0 refusals.
Observe arm (HANDOFF + HANDOFF_OBSERVE + ENFORCE + TOOLS): the program records every hand-off write, and each of the four interactive writers (data import,
verification record, materialize, run bundle) must be used by interactive with every one of its interactive records declared in the table.

Needs: the hand-off table lists interactive for run_bundle_writer, materialize_writer, knowledge_writer (data import) and
verification_writer, each as a measured pair (K389b: seen in a HANDOFF+OBSERVE+ENFORCE+TOOLS stand-in session).
usage: test_interactive_groups_on.py [news-binary]
"""
import json
import os
import subprocess
import sys
from pathlib import Path
from tmp_helper import make_test_tmp  # removed at exit, even after a failed assert

root = Path(__file__).resolve().parents[1]
binary = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("NEWS_BIN") or root / "target/release/news").resolve()
transcript = Path(make_test_tmp(prefix="interactive-groups-on-")) / "session.txt"
env = {k: v for k, v in os.environ.items() if not k.startswith("NEWSROOM_GROUP_")}
for name in ("HANDOFF", "ENFORCE", "TOOLS", "CALL_REPORT", "CALL_CHECK"):
    env[f"NEWSROOM_GROUP_{name}"] = "1"
env["INTERACTIVE_TRANSCRIPT"] = str(transcript)
done = subprocess.run(
    [sys.executable, str(root / "scripts/test_interactive_cli.py"), str(binary)],
    cwd=root, env=env, capture_output=True, text=True, timeout=300,
)
text = done.stdout + done.stderr
session = transcript.read_text(encoding="utf-8") if transcript.exists() else ""
refused = [line for line in session.splitlines() if "may not" in line or "could not run" in line]
assert not refused, f"{len(refused)} refusal line(s) in the session: {refused[:3]}"
assert "VERIFIED" in session, "the session never reached its verification line"
assert "may not" not in text, f"a write was refused under the five switches: {text[-1500:]}"
assert done.returncode == 0, f"interactive session failed under the five switches (rc={done.returncode}): {text[-1500:]}"
assert "interactive CLI: PASS" in done.stdout, done.stdout[-500:]
print("interactive under five-on: PASS (0 refusals)")

# ---- observe arm: each interactive writer is used, and its table entry is declared ----------------------------------------------
# Enforcing only shows a table entry that is missing as a refusal in the session text. In observe mode the program records every
# hand-off (runtime/handoff-observed.jsonl: writer, group, requested_by, command, path, decision), so an entry that is unused or
# was removed shows up here too: a writer with no record from interactive, or with any interactive record that is not "listed".
INTERACTIVE_WRITERS = ("knowledge_writer", "verification_writer", "materialize_writer", "run_bundle_writer")  # data import, verification record, materialize, run bundle


def interactive_rows(records, writer):
    return [r for r in records if r.get("writer") == writer and "interactive" in (r.get("requested_by"), r.get("command"))]


def writers_not_used(records, writers=INTERACTIVE_WRITERS):
    """Why each writer failed: never used by interactive, or an interactive record is not declared. Empty when all are used and every interactive record is listed."""
    problems = []
    for writer in writers:
        mine = interactive_rows(records, writer)
        if not mine:
            problems.append(f"{writer}: no hand-off from interactive was recorded")
            continue
        unlisted = [r for r in mine if r.get("decision") != "listed"]
        if unlisted:
            seen = sorted({str(r.get("decision")) for r in unlisted})
            where = sorted({str(r.get("path")) for r in unlisted})[:3]
            problems.append(f"{writer}: used by interactive but not declared in the table ({len(unlisted)} of {len(mine)} records, decision {seen}, path {where})")
    return problems


def selfcheck(records):
    """The check must see each failure kind: on copies of the real records, a writer with no rows, a writer with all its interactive rows unlisted, and a writer
    with one interactive row unlisted (its other rows stay listed) must each be reported alone, by name, with the right reason."""
    assert not writers_not_used(records), writers_not_used(records)
    for writer in INTERACTIVE_WRITERS:
        problems = writers_not_used([r for r in records if r.get("writer") != writer])
        assert len(problems) == 1 and problems[0].startswith(f"{writer}:") and "no hand-off" in problems[0], f"dropping {writer} gave {problems}"
        mine = interactive_rows(records, writer)
        assert mine, f"{writer} has no interactive rows to change"
        all_unlisted = [dict(r, decision="unlisted") if r in mine else r for r in records]
        problems = writers_not_used(all_unlisted)
        assert len(problems) == 1 and problems[0].startswith(f"{writer}:") and "not declared" in problems[0], f"unlisting all of {writer} gave {problems}"
        one_unlisted = [dict(r, decision="unlisted") if r is mine[0] else r for r in records]
        problems = writers_not_used(one_unlisted)
        assert len(problems) == 1 and problems[0].startswith(f"{writer}:") and "not declared" in problems[0], f"unlisting one row of {writer} gave {problems}"


observed = transcript.parent / "observed.jsonl"
observe_env = {k: v for k, v in os.environ.items() if not k.startswith("NEWSROOM_GROUP_")}
for name in ("HANDOFF", "HANDOFF_OBSERVE", "ENFORCE", "TOOLS"):
    observe_env[f"NEWSROOM_GROUP_{name}"] = "1"
observe_env["INTERACTIVE_OBSERVED"] = str(observed)
second = subprocess.run(
    [sys.executable, str(root / "scripts/test_interactive_cli.py"), str(binary)],
    cwd=root, env=observe_env, capture_output=True, text=True, timeout=300,
)
assert second.returncode == 0, f"interactive session failed in observe mode (rc={second.returncode}): {(second.stdout + second.stderr)[-1500:]}"
lines = [line for line in (observed.read_text(encoding="utf-8") if observed.exists() else "").splitlines() if line.strip()]
assert lines, "observe mode recorded no hand-off at all (runtime/handoff-observed.jsonl is missing or empty)"
records = [json.loads(line) for line in lines]
problems = writers_not_used(records)
assert not problems, "interactive writers not used or not all declared: " + "; ".join(problems)
selfcheck(records)
counts = {w: sum(1 for r in records if r.get("writer") == w and "interactive" in (r.get("requested_by"), r.get("command"))) for w in INTERACTIVE_WRITERS}
print(f"interactive observe arm: PASS (each writer used, every interactive record declared: {counts})")
