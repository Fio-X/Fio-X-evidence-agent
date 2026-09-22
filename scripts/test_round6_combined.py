#!/usr/bin/env python3
"""Combined round-6 A/B harness for the three opt-in R5 mechanisms."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str]) -> object:
    completed = subprocess.run(
        command,
        cwd=ROOT,
        env=os.environ.copy(),
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    return json.loads(completed.stdout)


def main() -> None:
    budget = run(["node", "scripts/test_tool_result_budget_integration.mjs"])
    phase = run(["node", "scripts/test_phase_runtime_surface.mjs"])
    routing = run(["python3", "scripts/test_visual_routing_matrix.py"])
    cost = run(["python3", "scripts/test_visual_routing_cost.py"])

    rows = {row["label"]: row for row in phase["rows"]}
    canonical = {
        "visual-story-all": (47, 40355),
        "visual-story-discover": (7, 1860),
        "visual-story-verify": (7, 2670),
        "visual-story-design": (25, 22594),
    }
    for label, (count, _) in canonical.items():
        assert rows[label]["effective_tool_count"] == count, (label, rows[label])

    assert budget["reduction_ratio"] >= 0.75
    assert routing["case_count"] == 24
    assert routing["routing_changes"] == 9
    assert {row["label"] for row in routing["changes"]} == {
        "single Sankey", "Sankey HTML", "mobile chart", "dashboard",
        "Chinese mobile", "Chinese Sankey", "map + Sankey + trend",
        "map + Sankey + trend mobile", "four modules",
    }
    assert any(row["label"] == "mobile chart" and not row["split"] for row in routing["changes"])
    assert any(row["label"] == "map + Sankey + trend" and row["split"] for row in routing["changes"])
    assert not any(row["label"] == "single Sankey" and row["split"] for row in routing["changes"])
    assert all(
        row["split_profile"] != "visual-story"
        for row in cost["changed_routes"]
        if row["label"] == "mobile chart"
    )

    source = (ROOT / "runtime/pi/newsroom.ts").read_text(encoding="utf-8")
    for marker in ("requireVerifiedClaim", "assertEvidenceBackedStatus", "newsroom_publication_qa"):
        assert marker in source, marker

    result = {
        "status": "PASS",
        "ab": {
            "baseline_model_visible_bytes": budget["baseline_model_visible_bytes"],
            "combined_model_visible_bytes": budget["budgeted_model_visible_bytes"],
            "reduction_ratio": budget["reduction_ratio"],
            "default_behavior_opt_in": budget["default_behavior_opt_in"],
        },
        "phase": {
            "profiles": [
                {
                    "label": label,
                    "phase": rows[label]["phase"],
                    "effective_tool_count": rows[label]["effective_tool_count"],
                    "schema_bytes": rows[label]["schema_bytes"],
                    "canonical_schema_bytes": canonical[label][1],
                    "schema_delta_bytes": rows[label]["schema_bytes"] - canonical[label][1],
                }
                for label in canonical
            ],
            "canonical_inheritance": True,
        },
        "routing": {
            "case_count": routing["case_count"],
            "routing_changes": routing["routing_changes"],
            "delivery_only_reduced": True,
            "true_multi_module_retained": True,
        },
        "gates": {
            "evidence_completion_publication_markers_present": True,
            "browser_qa_marker_present": True,
        },
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "FAIL", "error": str(error)}), file=sys.stderr)
        raise
