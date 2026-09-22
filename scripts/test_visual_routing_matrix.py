#!/usr/bin/env python3
"""Fixed routing matrix for the opt-in complex-visual classifier split."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROMPT = ROOT / "src" / "prompt.rs"
CASES = [
    ("plain summary", "summarize the source"),
    ("single chart", "make a chart"),
    ("single map", "make a map"),
    ("single trend", "make a trend chart"),
    ("single Sankey", "interactive Sankey"),
    ("Sankey HTML", "interactive Sankey self-contained HTML"),
    ("mobile chart", "mobile self-contained HTML single chart"),
    ("desktop PNG", "single chart desktop PNG"),
    ("dashboard", "interactive dashboard"),
    ("infographic", "make an infographic"),
    ("data report", "data report infographic"),
    ("visual essay", "visual essay",),
    ("scrollytelling", "scrollytelling map"),
    ("explicit multi module", "multi-module infographic"),
    ("Chinese mobile", "制作移动端自包含 HTML 单图"),
    ("Chinese Sankey", "制作交互桑基图"),
    ("Chinese multi", "制作多模块信息图"),
    ("map + Sankey", "map and Sankey"),
    ("map + trend", "map and trend"),
    ("Sankey + trend", "Sankey and trend"),
    ("map + Sankey + trend", "map, Sankey, and trend"),
    ("map + Sankey + trend mobile", "mobile map, Sankey, and trend"),
    ("four modules", "map, Sankey, trend, and network"),
    ("comparison only", "compare two charts"),
]
EXPECTED_CHANGED_LABELS = {
    "single Sankey", "Sankey HTML", "mobile chart", "dashboard",
    "Chinese mobile", "Chinese Sankey", "map + Sankey + trend",
    "map + Sankey + trend mobile", "four modules",
}


def main() -> None:
    harness = r'''
#[path = "PROMPT_PATH"]
mod prompt;
fn main() {
    for arg in std::env::args().skip(1) {
        println!("{}\t{}\t{}", arg, prompt::is_complex_visual_request(&arg), prompt::is_complex_visual_request_split(&arg));
    }
}
'''.replace("PROMPT_PATH", str(PROMPT))
    with tempfile.TemporaryDirectory(prefix="r5-05-routing-") as td:
        source, binary = Path(td) / "harness.rs", Path(td) / "harness"
        source.write_text(harness, encoding="utf-8")
        subprocess.run(["rustc", "--edition", "2021", str(source), "-o", str(binary)], cwd=ROOT, check=True, capture_output=True, text=True)
        completed = subprocess.run([str(binary), *(goal for _, goal in CASES)], cwd=ROOT, check=True, capture_output=True, text=True)
    observed = []
    for (label, goal), line in zip(CASES, completed.stdout.splitlines()):
        _, baseline, split = line.split("\t")
        observed.append({"label": label, "goal": goal, "baseline": baseline == "true", "split": split == "true"})
    changes = [row for row in observed if row["baseline"] != row["split"]]
    assert len(observed) == 24
    assert len(changes) == 9
    assert {row["label"] for row in changes} == EXPECTED_CHANGED_LABELS
    assert all(row["baseline"] and not row["split"] for row in changes if row["label"] in {"single Sankey", "Sankey HTML", "mobile chart", "dashboard", "Chinese mobile", "Chinese Sankey"})
    assert all(not row["baseline"] and row["split"] for row in changes if row["label"] in {"map + Sankey + trend", "map + Sankey + trend mobile", "four modules"})
    print(json.dumps({"status": "PASS", "case_count": len(observed), "routing_changes": len(changes), "changes": changes}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
