#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
versions = json.loads((ROOT / "versions.json").read_text(encoding="utf-8"))

def must(ok, message):
    if not ok:
        raise SystemExit("release baseline mismatch: " + message)

cargo = (ROOT / "Cargo.toml").read_text(encoding="utf-8")
rust = (ROOT / "rust-toolchain.toml").read_text(encoding="utf-8")
ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
schema = json.loads((ROOT / "schemas/newsroom-viz-spec.schema.json").read_text(encoding="utf-8"))
artifact_schema = json.loads((ROOT / "schemas/news-artifact.schema.json").read_text(encoding="utf-8"))
infographic_schema = json.loads((ROOT / "schemas/infographic-spec.schema.json").read_text(encoding="utf-8"))
story_graph_schema = json.loads((ROOT / "schemas/story-graph.schema.json").read_text(encoding="utf-8"))

must(re.search(r'^version\s*=\s*"' + re.escape(versions["release"]) + r'"', cargo, re.M), "Cargo package version")
must(f'channel = "{versions["rust"]}"' in rust, "Rust toolchain pin")
must(f"node-version: '{versions['node_for_pi']}'" in ci, "CI Node baseline")
viz_version = versions.get("newsroom_viz_spec", versions["release"])
artifact_version = versions.get("news_artifact_schema", versions["release"])
viz_schema_version = schema.get("properties", {}).get("schema_version", {})
allowed_viz_versions = set(viz_schema_version.get("enum", []))
if "const" in viz_schema_version:
    allowed_viz_versions.add(viz_schema_version["const"])
must(viz_version in allowed_viz_versions, "NewsroomVizSpec version")
must(artifact_schema.get("properties", {}).get("schema_version", {}).get("const") == artifact_version, "News artifact schema version")
infographic_version = versions.get("infographic_spec")
must(bool(infographic_version), "InfographicSpec version declared")
infographic_schema_version = infographic_schema.get("properties", {}).get("schema_version", {})
allowed_infographic_versions = set(infographic_schema_version.get("enum", []))
if "const" in infographic_schema_version:
    allowed_infographic_versions.add(infographic_schema_version["const"])
must(infographic_version in allowed_infographic_versions, "InfographicSpec version")
story_graph_version = versions.get("story_graph")
must(bool(story_graph_version), "StoryGraph version declared")
must(story_graph_schema.get("properties", {}).get("schema_version", {}).get("const") == story_graph_version, "StoryGraph version")


live_ci = (ROOT / ".github/workflows/live-qualification.yml").read_text(encoding="utf-8")
dockerfile = (ROOT / "Dockerfile.live").read_text(encoding="utf-8")
must(f"@earendil-works/pi-coding-agent@{versions['pi_coding_agent']}" in ci, "CI Pi pin")
must(f"duckdb-cli=={versions['duckdb']}" in ci, "CI DuckDB pin")
must(f"CairoSVG=={versions['cairosvg']}" in ci, "CI CairoSVG pin")
must("doctor --strict --json" in ci and "verify /tmp/newsroom-recompute-real --recompute" in ci, "CI live runtime acceptance")
must(f"node:{versions['node_for_pi']}-bookworm-slim" in dockerfile, "Docker Node baseline")
must(f"ARG RUST_VERSION={versions['rust']}" in dockerfile, "Docker Rust pin")
must(f"ARG PI_VERSION={versions['pi_coding_agent']}" in dockerfile, "Docker Pi pin")
must(f"ARG DUCKDB_VERSION={versions['duckdb']}" in dockerfile, "Docker DuckDB pin")
must(f"CairoSVG==${{CAIROSVG_VERSION}}" in dockerfile, "Docker CairoSVG install")
must(f"ARG CAIROSVG_VERSION={versions['cairosvg']}" in dockerfile, "Docker CairoSVG pin")
must(
    "workflow_dispatch" in live_ci
    and "agentic_trials.py --trials 3" in live_ci
    and ".newsroom/agentic-trials" in live_ci
    and "integration_qualification.sh" in live_ci,
    "manual repeated-agentic and integration qualification workflows",
)

print("release baseline: PASS")
for key in ("release", "news_artifact_schema", "newsroom_viz_spec", "infographic_spec", "story_graph", "rust", "node_for_pi", "pi_coding_agent", "duckdb", "cairosvg", "python_ci"):
    print(f"{key}: {versions[key]}")
