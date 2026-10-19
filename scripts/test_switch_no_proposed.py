#!/usr/bin/env python3
"""Completion criterion 7: no row in ci/switch-owners.json is still "proposed" unless its name is listed in PROPOSED_ALLOWED below.

PROPOSED_ALLOWED is a name lock, like DEFAULT_ON and REMOVAL in test_switch_off_ratchet.py: it is empty today, and a change that needs a row to
stay proposed has to add the name here, which is a visible one-line diff that needs the owner's signature. Every listed name must be a row that
is proposed right now (a name listed ahead of its row turns the test red, so nobody can pre-sign a row). The lock guards against unintended
changes; a change that edits this set and the table in the same pull request is stopped by review and the owner's signature, not by this test.

Usage: test_switch_no_proposed.py [TABLE.json [ALLOWED_JSON_LIST]]   (default: ci/switch-owners.json and PROPOSED_ALLOWED; the arguments exist so the
mutant runs below can point at a changed copy and a changed name list)"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]

# Names whose rows may stay "proposed". Empty on purpose; adding a name needs the owner's signature.
PROPOSED_ALLOWED = set()


def not_approved(rows):
    return {row.get("name"): row.get("status") for row in rows if row.get("status") != "approved"}


def check(path, allowed):
    left = not_approved(json.loads(Path(path).read_text(encoding="utf-8")))
    problems = [f"{name} ({status!r}) is not approved and not in PROPOSED_ALLOWED" for name, status in sorted(left.items(), key=str) if name not in allowed]
    problems += [f"{name} is in PROPOSED_ALLOWED but is not a proposed row" for name in sorted(allowed - set(left))]
    if problems:
        print("switch table: " + "; ".join(problems), file=sys.stderr)
        return 1
    return 0


if len(sys.argv) > 1:
    sys.exit(check(sys.argv[1], set(json.loads(sys.argv[2])) if len(sys.argv) > 2 else PROPOSED_ALLOWED))

table = root / "ci/switch-owners.json"
rows = json.loads(table.read_text(encoding="utf-8"))
assert rows, "the switch table is empty"
if check(table, PROPOSED_ALLOWED):
    sys.exit(1)

this = str(Path(__file__).resolve())
first_ok = next(i for i, row in enumerate(rows) if row.get("status") == "approved")
ok_name = rows[first_ok]["name"]
new_row = {"name": "NEWSROOM_MUTANT", "owner": "TBD", "purpose": "x", "expiry": "TBD", "default": "off", "status": "proposed"}
other_row = dict(new_row, name="NEWSROOM_MUTANT_TWO")
# (label, rows, allowed names, name that must appear on stderr or None, expected exit code)
cases = [
    ("an approved row set to proposed", [dict(r, status="proposed") if i == first_ok else r for i, r in enumerate(rows)], [], ok_name, 1),
    ("a new proposed row added", rows + [new_row], [], new_row["name"], 1),
    ("an odd status word", rows[:-1] + [dict(rows[-1], status="Approved ")], [], rows[-1]["name"], 1),
    ("an allowed name that is an approved row (pre-signed)", rows, [ok_name], ok_name, 1),
    ("an allowed name that is not in the table at all", rows, ["NEWSROOM_NOT_THERE"], "NEWSROOM_NOT_THERE", 1),
    ("a listed proposed row passes, the unlisted one beside it does not", rows + [new_row, other_row], [new_row["name"]], other_row["name"], 1),
    ("a listed proposed row passes", rows + [new_row], [new_row["name"]], None, 0),
    ("the unchanged table with no names", rows, [], None, 0),
]
with tempfile.TemporaryDirectory() as tmp:
    for label, mutated, allowed, name, want in cases:
        copy = Path(tmp) / "t.json"
        copy.write_text(json.dumps(mutated), encoding="utf-8")
        run = subprocess.run([sys.executable, "-I", this, str(copy), json.dumps(allowed)], capture_output=True, text=True)
        # A red case must name the row on stderr, so bad JSON or a crash (also exit 1) cannot pass for a catch; a green case must be silent.
        assert run.returncode == want, f"case not as expected (exit {run.returncode}, wanted {want}): {label}: {run.stderr[-200:]}"
        assert (name in run.stderr) if name else run.stderr == "", f"stderr does not match the case: {label}: {run.stderr[-200:]}"
    # Bad JSON is not a catch: it must fail without naming any row.
    bad = Path(tmp) / "bad.json"
    bad.write_text("{", encoding="utf-8")
    run = subprocess.run([sys.executable, "-I", this, str(bad)], capture_output=True, text=True)
    assert run.returncode != 0 and "NEWSROOM_" not in run.stderr, "bad JSON must fail without naming a row"
print(f"switch table has no unlisted proposed row: PASS ({len(rows)} rows, {len(PROPOSED_ALLOWED)} allowed, {len(cases)} cases + bad JSON)")
