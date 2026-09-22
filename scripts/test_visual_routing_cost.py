#!/usr/bin/env python3
"""Report prompt-byte and selected-profile tool-count deltas for fixed cases."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from test_visual_routing_matrix import CASES, ROOT


def main() -> None:
    prompt = ROOT / "src" / "prompt.rs"
    registry = json.loads((ROOT / "config/tool-registry.json").read_text(encoding="utf-8"))
    direct = {profile: {tool["name"] for tool in registry["tools"] if profile in tool.get("profiles", [])} for profile in ("visual", "visual-story", "investigate")}
    inherited = {"visual-story": {"visual"}}
    effective = {profile: set(names) for profile, names in direct.items()}
    for profile, parents in inherited.items():
        for parent in parents:
            effective[profile].update(direct[parent])
    counts = {profile: len(names) for profile, names in effective.items()}
    harness = r'''
#[path = "PROMPT_PATH"]
mod prompt;
fn main() {
    for arg in std::env::args().skip(1) {
        let base = prompt::investigation_with_classifier(&arg, &[], false);
        let split = prompt::investigation_with_classifier(&arg, &[], true);
        let b = prompt::is_complex_visual_request(&arg);
        let s = prompt::is_complex_visual_request_split(&arg);
        println!("{}\t{}\t{}\t{}\t{}", arg, base.len(), split.len(), b, s);
    }
}
'''.replace("PROMPT_PATH", str(prompt))
    with tempfile.TemporaryDirectory(prefix="r5-05-cost-") as td:
        source, binary = Path(td) / "harness.rs", Path(td) / "harness"
        source.write_text(harness, encoding="utf-8")
        subprocess.run(["rustc", "--edition", "2021", str(source), "-o", str(binary)], cwd=ROOT, check=True, capture_output=True, text=True)
        completed = subprocess.run([str(binary), *(goal for _, goal in CASES)], cwd=ROOT, check=True, capture_output=True, text=True)
    rows = []
    visual_terms = ("chart", "plot", "graph", "visual", "infographic", "dashboard", "map", "sankey", "svg", "png", "html", "图", "地图", "桑基")
    for (label, goal), line in zip(CASES, completed.stdout.splitlines()):
        _, baseline_bytes, split_bytes, baseline_complex, split_complex = line.split("\t")
        visual = any(term in goal.lower() for term in visual_terms)
        baseline_profile = "visual-story" if baseline_complex == "true" else ("visual" if visual else "investigate")
        split_profile = "visual-story" if split_complex == "true" else ("visual" if visual else "investigate")
        rows.append({"label": label, "goal": goal, "baseline_prompt_bytes": int(baseline_bytes), "split_prompt_bytes": int(split_bytes), "baseline_profile": baseline_profile, "split_profile": split_profile, "baseline_tool_count": counts[baseline_profile], "split_tool_count": counts[split_profile]})
    changed = [row for row in rows if row["baseline_profile"] != row["split_profile"]]
    assert len(rows) >= 20
    assert changed
    print(json.dumps({"status": "PASS", "case_count": len(rows), "changed_route_count": len(changed), "profile_tool_counts": counts, "changed_routes": changed, "all_cases": rows}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
