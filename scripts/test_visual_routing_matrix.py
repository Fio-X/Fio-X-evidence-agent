#!/usr/bin/env python3
"""Deterministic A/B matrix for the opt-in complex-visual classifier split."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROMPT = ROOT / "src" / "prompt.rs"

CASES = [
    ("plain summary", "summarize the source", False, False),
    ("single chart", "make a chart", False, False),
    ("single map", "make a map", False, False),
    ("single trend", "make a trend chart", False, False),
    ("single Sankey", "interactive Sankey", True, False),
    ("Sankey HTML", "interactive Sankey self-contained HTML", True, False),
    ("mobile chart", "mobile self-contained HTML single chart", True, False),
    ("desktop PNG", "single chart desktop PNG", False, False),
    ("dashboard", "interactive dashboard", True, False),
    ("infographic", "make an infographic", False, False),
    ("data report", "data report infographic", False, False),
    ("visual essay", "visual essay", True, True),
    ("scrollytelling", "scrollytelling map", True, True),
    ("explicit multi module", "multi-module infographic", True, True),
    ("Chinese mobile", "制作移动端自包含 HTML 单图", True, False),
    ("Chinese Sankey", "制作交互桑基图", True, False),
    ("Chinese multi", "制作多模块信息图", True, True),
    ("map + Sankey", "map and Sankey", False, False),
    ("map + trend", "map and trend", False, False),
    ("Sankey + trend", "Sankey and trend", False, False),
    ("map + Sankey + trend", "map, Sankey, and trend", False, True),
    ("map + Sankey + trend mobile", "mobile map, Sankey, and trend", False, True),
    ("four modules", "map, Sankey, trend, and network", False, True),
    ("comparison only", "compare two charts", False, False),
]


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
    with tempfile.TemporaryDirectory(prefix="r4-09-routing-") as td:
        td_path = Path(td)
        source = td_path / "harness.rs"
        binary = td_path / "harness"
        source.write_text(harness, encoding="utf-8")
        subprocess.run(
            ["rustc", "--edition", "2021", str(source), "-o", str(binary)],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        completed = subprocess.run(
            [str(binary), *(case[1] for case in CASES)],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )

    observed = []
    for (label, goal, baseline_expected, split_expected), line in zip(CASES, completed.stdout.splitlines()):
        _, baseline, split = line.split("\t")
        row = {
            "label": label,
            "goal": goal,
            "baseline": baseline == "true",
            "split": split == "true",
            "baseline_expected": baseline_expected,
            "split_expected": split_expected,
        }
        assert row["baseline"] == baseline_expected, row
        assert row["split"] == split_expected, row
        observed.append(row)

    changes = [row for row in observed if row["baseline"] != row["split"]]
    assert any(row["label"] == "mobile chart" for row in changes)
    assert any(row["label"] == "map + Sankey + trend" and row["split"] for row in observed)
    assert not any(row["label"] == "single Sankey" and row["split"] for row in observed)
    print(json.dumps({
        "status": "PASS",
        "case_count": len(observed),
        "baseline_visual_story_candidates": sum(row["baseline"] for row in observed),
        "split_visual_story_candidates": sum(row["split"] for row in observed),
        "routing_changes": len(changes),
        "changes": changes,
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
