#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "ci-evidence" / "local-backend-benchmark-baseline.json"
POLICY = ROOT / "config" / "backend-routing-thresholds.json"

bench = json.loads(BENCH.read_text())
policy = json.loads(POLICY.read_text())
rows = {row["name"]: row for row in bench["rows"]}
required = {
    "metadata_local_first", "metadata_portable_stat",
    "text_conversion_local_first", "text_plain_portable",
    "image_probe_local_first", "sqlite_local_first",
    "hash_local_first", "hash_portable_crypto",
    "local_search", "http_curl", "http_node_fetch",
}
missing = sorted(required - rows.keys())
assert not missing, f"missing benchmark rows: {missing}"
assert bench["provenance"]["samples"] >= 10
assert bench["provenance"]["runner"] == "macos-26"
assert bench["provenance"]["architecture"] == "arm64"
assert policy["basis"]["mandatory_speedup_threshold"] is None

for row in rows.values():
    assert row["backend"]
    assert 0 <= row["min_ms"] <= row["p50_ms"] <= row["p95_ms"] <= row["max_ms"]

for name, route in policy["routes"].items():
    if route.get("semantic_equivalence") is True:
        preferred = rows[route["preferred_row"]]
        alternative = rows[route["alternative_row"]]
        assert preferred["backend"] == route["preferred_backend"], name
        assert preferred["p95_ms"] < alternative["p50_ms"], (
            f"{name}: latency distributions no longer support a clear preference: "
            f"preferred p95={preferred['p95_ms']} alternative p50={alternative['p50_ms']}"
        )
        assert route["decision"] == "clear_latency_preference"

metadata = policy["routes"]["basic_file_metadata"]
assert metadata["semantic_equivalence"] == "conditional"
assert rows[metadata["preferred_row"]]["p95_ms"] < rows[metadata["alternative_row"]]["p50_ms"]
assert "mdls" in metadata["capability_guard"]

for name in ["text_read_or_conversion", "local_search", "image_probe", "sqlite_readonly"]:
    route = policy["routes"][name]
    assert route["semantic_equivalence"] is False
    assert "preferred_row" not in route and "alternative_row" not in route

print(json.dumps({
    "status": "PASS",
    "benchmark_rows": len(rows),
    "samples": bench["provenance"]["samples"],
    "clear_latency_preferences": ["hash_sha256", "http_fetch"],
    "conditional_semantic_routes": ["basic_file_metadata"],
    "non_equivalent_routes": ["text_read_or_conversion", "local_search", "image_probe", "sqlite_readonly"],
}, indent=2))
