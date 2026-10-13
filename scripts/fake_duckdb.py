#!/usr/bin/env python3
"""Protocol-only DuckDB CLI shim for replay smoke tests. Never used for live qualification."""
import json, os, sys
mode = os.environ.get("FAKE_DUCKDB_MODE", "match")
if mode == "error":
    print("synthetic DuckDB failure", file=sys.stderr)
    raise SystemExit(7)
rows = [{"country": "A", "value": 15208319.706770007}, {"country": "B", "value": -0.280294}, {"country": "C", "value": 23747.0703125}]
if mode == "mismatch":
    rows[1]["value"] = 999
if mode in {"null", "nan", "inf", "neginf"}:
    rows[1]["value"] = None
text = json.dumps(rows, separators=(",", ":"))
# DuckDB's -json prints a SQL NULL as null and a non-finite DOUBLE as a bare NaN / Infinity / -Infinity token.
bare = {"nan": "NaN", "inf": "Infinity", "neginf": "-Infinity"}
if mode in bare:
    text = text.replace('"value":null', '"value":' + bare[mode])
print(text)
