#!/usr/bin/env python3
"""The set of switches that can still be turned off does not grow, and five named refusal switches have a written removal trigger.

Rows with "default": "on" are the switches that can be turned off. That set is pinned here, so a new default-on switch turns this test red
until the owner signs a change to the list below. The five refusal switches that keep a "0" off value (named below; the test does not look for the "0" in code) must have expiry "remove" and the trigger
sentence at the end of their purpose (expiry only takes fixed words, see test_switch_owner_table.py); no other row may carry that sentence."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
rows = json.loads((root / "ci/switch-owners.json").read_text(encoding="utf-8"))
by_name = {row["name"]: row for row in rows}

DEFAULT_ON = {
    "NEWSROOM_GROUP_CALL_CHECK", "NEWSROOM_GROUP_CALL_REFUSE", "NEWSROOM_GROUP_CALL_REFUSE_ALL", "NEWSROOM_GROUP_ENFORCE",
    "NEWSROOM_GROUP_TOOLS", "NEWSROOM_REVIEW_SPLIT", "NEWSROOM_VERIFY_MAP_FOOTNOTES", "NEWSROOM_VISION_VETO_ONLY",
}
REMOVAL = {"NEWSROOM_GROUP_CALL_CHECK", "NEWSROOM_GROUP_CALL_REFUSE", "NEWSROOM_GROUP_CALL_REFUSE_ALL", "NEWSROOM_GROUP_ENFORCE", "NEWSROOM_GROUP_TOOLS"}
TRIGGER = 'Remove the "0" off value after the first verified real full-page run.'

on = {row["name"] for row in rows if row["default"] == "on"}
assert on == DEFAULT_ON, f"the set of default-on switches changed: added {sorted(on - DEFAULT_ON)}, removed {sorted(DEFAULT_ON - on)}"
for name in sorted(REMOVAL):
    row = by_name[name]
    assert row["expiry"] == "remove", f"{name}: expiry must be 'remove', is {row['expiry']!r}"
    assert row["purpose"].endswith(" " + TRIGGER) and len(row["purpose"]) > len(TRIGGER) + 1, f"{name}: purpose must end with the removal trigger"
carriers = {row["name"] for row in rows if TRIGGER in row["purpose"]}
assert carriers == REMOVAL, f"the removal trigger sits on the wrong rows: {sorted(carriers ^ REMOVAL)}"
print(f"switch off ratchet: PASS ({len(on)} default-on switches, {len(REMOVAL)} with a removal trigger)")
