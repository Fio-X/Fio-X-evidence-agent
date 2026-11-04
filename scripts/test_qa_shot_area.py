#!/usr/bin/env python3
"""B5: browser QA's screenshot is the page, no taller than its content. A page shorter than the 900 px window is clipped
at its own foot (no empty window bottom in the picture); a page as tall as the window or taller is shot whole; a page
whose height cannot be read is shot whole as before. Both copies of browser_qa.py say the same."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Page:
    def __init__(self, h): self.h = h
    def evaluate(self, *_a): return self.h


def load(rel):
    spec = importlib.util.spec_from_file_location("qa_" + rel.replace("/", "_"), ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    for rel in ["runtime/pi/browser_qa.py", "runtime/browser/browser_qa.py"]:
        qa = load(rel)
        assert qa.shot_area(Page(664), 1440) == {"full_page": True, "clip": {"x": 0, "y": 0, "width": 1440, "height": 664}}, rel
        for h in [900, 1308, 0, None, {"sw": 1440}]:
            assert qa.shot_area(Page(h), 1440) == {"full_page": True}, (rel, h)
    assert (ROOT / "runtime/pi/browser_qa.py").read_bytes() == (ROOT / "runtime/browser/browser_qa.py").read_bytes()
    print("test_qa_shot_area: ok")


if __name__ == "__main__":
    sys.exit(main())
