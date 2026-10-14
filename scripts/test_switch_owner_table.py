#!/usr/bin/env python3
"""Every NEWSROOM_* switch read by product code has one row in config/switch-owners.json, and every row has code."""
import json
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
table_path = root / "config/switch-owners.json"
# Product code only: tests, vendored bundles and the table itself do not define a switch.
EXCLUDE = (":!runtime/pi/vendor", ":!runtime/pi/visual_skill_bundle.mjs", ":!runtime/web/vendor", ":!scripts/test_*", ":!config/switch-owners.json")
SCOPE = ("src", "runtime", "config", "contracts", "schemas", "ci", ".github", "scripts")

found = set()
text = subprocess.run(["git", "grep", "-h", "-o", "-E", "NEWSROOM_[A-Z0-9_]+", "--", *SCOPE, *EXCLUDE], cwd=root, capture_output=True, text=True, check=True).stdout
for name in text.split():
    if not name.endswith("_"):  # NEWSROOM_RPC_ and the like are name prefixes built in code, not switches
        found.add(name)

rows = json.loads(table_path.read_text(encoding="utf-8"))
names = [row["name"] for row in rows]
assert len(names) == len(set(names)), f"duplicate rows: {sorted(n for n in set(names) if names.count(n) > 1)}"
for row in rows:
    assert set(row) == {"name", "owner", "purpose", "expiry", "default"}, row
    assert all(isinstance(row[k], str) and row[k] for k in row), row
    assert row["expiry"] in ("permanent", "TBD") or re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["expiry"]), row
missing = sorted(found - set(names))
stale = sorted(set(names) - found)
assert not missing, f"switches in code without a row: {missing}"
assert not stale, f"rows without a switch in code: {stale}"
print(f"switch owner table: PASS ({len(rows)} rows, {sum(r['owner'] == 'TBD' for r in rows)} owner TBD, {sum(r['expiry'] == 'TBD' for r in rows)} expiry TBD)")
