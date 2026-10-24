#!/usr/bin/env python3
"""The switch table does not grow: ci/switch-owners.json has at most CAP rows.

CAP is the row count the table had on the integration line c1f845ab (282). A train may not raise the count: a change that adds a switch row removes
one in the same train. After every train is merged, the train tool lowers CAP to the merged row count, so the number only goes down. Raising CAP needs
the owner's explicit approval; this test does not tell which rows are new, it only counts.

The check is a function, and the lines below the real check run it on in-memory copies of the table (a table one row over the cap, exactly at the cap,
and a cap one below the table's size) so a loosened comparison turns this test red."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
rows = json.loads((root / "ci/switch-owners.json").read_text(encoding="utf-8"))

CAP = 282


def check(table, cap):
    assert len(table) <= cap, f"the switch table has {len(table) - cap} row(s) over the cap: {len(table)} rows, cap {cap}"


check(rows, CAP)

# the check itself, on in-memory tables: one row over fails, exactly at the cap passes, a lowered cap below the table's size fails
filler = {"name": "NEWSROOM_FILLER", "owner": "agent", "purpose": "in-memory filler", "expiry": "remove", "default": "other", "status": "approved"}
at_cap = rows + [filler] * (CAP - len(rows))
assert len(at_cap) == CAP
check(at_cap, CAP)
for table, cap, why in ((at_cap + [filler], CAP, "one row over the cap"), (at_cap, CAP - 1, "the cap lowered below the table")):
    try:
        check(table, cap)
    except AssertionError:
        continue
    raise AssertionError(f"the cap check let this through: {why}")
print(f"switch row cap: PASS ({len(rows)} rows, cap {CAP})")
