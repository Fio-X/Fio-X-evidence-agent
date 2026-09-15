#!/usr/bin/env python3
"""Protocol-only DuckDB CLI shim for replay smoke tests. Never used for live qualification."""
import json, os, sys
mode = os.environ.get("FAKE_DUCKDB_MODE", "match")
if mode == "error":
    print("synthetic DuckDB failure", file=sys.stderr)
    raise SystemExit(7)
rows = [{"country": "A", "value": 1}, {"country": "B", "value": 2}]
if mode == "mismatch":
    rows[1]["value"] = 999
print(json.dumps(rows, separators=(",", ":")))
