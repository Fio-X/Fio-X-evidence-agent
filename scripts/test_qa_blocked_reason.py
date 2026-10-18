#!/usr/bin/env python3
"""K796/K807: browser QA says why a module was blocked, and changes nothing else; the page is not touched.

When a module's draw code throws, the page (unchanged) marks it data-blocked="runtime" and writes "Module fallback: <message>" into
the module's detail line. browser_qa.py reads that line for runtime-blocked modules only, strips the prefix, keeps the first line,
removes paths and cuts it to 160 characters, then copies it into the blocked_modules entry and the viewport's blocked_reasons
list. The verdict, the check id and every other byte of a report are what they were: a passing page's report is byte-identical to
the one the previous browser_qa.py wrote, and a blocked page fails the same check with the same id prefix.

Runs browser_qa.main() in-process against a fake Playwright and a fake clock, so no browser is started."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("K796_BASE_REF", "ab2f9bf635015308ff4ce8368927b72e6430654a")
DIMS = {"style_profile": "analytical_precision", "sw": 1440, "cw": 1440, "modules": [{"id": "m1", "left": 0, "right": 1200}],
        "blocked": [], "plotly": [], "webgl_error": False, "font_status": "loaded", "accessibility_errors": []}
CURRENT = {"dims": DIMS}


class FakePage:
    def on(self, *_a): pass
    def set_content(self, *_a, **_k): pass
    def wait_for_function(self, *_a, **_k): pass
    def wait_for_timeout(self, *_a): pass
    def evaluate(self, *_a): return CURRENT["dims"]
    def screenshot(self, path, **_k): Path(path).write_bytes(b"png")
    def close(self): pass


class FakeBrowser:
    def new_page(self, **_k): return FakePage()
    def close(self): pass


class FakePlaywright:
    chromium = types.SimpleNamespace(launch=lambda **_k: FakeBrowser())
    def __enter__(self): return self
    def __exit__(self, *_a): return False


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.time = types.SimpleNamespace(perf_counter=lambda: 0.0)
    return module


def run_qa(module, tmp: Path, name: str, dims: dict):
    CURRENT["dims"] = dims
    case = tmp / name
    case.mkdir()
    html = case / "index.html"
    html.write_bytes(b"<!doctype html>" + b" " * 100)
    spec = case / "spec.json"
    spec.write_text(json.dumps({"delivery": {"breakpoints": [1440]}, "interaction": {"replay": []}}))
    out = case / "qa"
    sys.argv = ["browser_qa.py", "--html", str(html), "--spec", str(spec), "--output", str(out)]
    code = 0
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            module.main()
    except SystemExit as exc:
        code = exc.code
    raw = (out / "browser-qa.json").read_bytes()
    return code, raw, json.loads(raw)


def blocked(detail: str, kind: str = "runtime", module_id: str = "m1") -> dict:
    return {**DIMS, "blocked": [module_id], "blocked_why": [{"id": module_id, "kind": kind, "detail": detail}]}


def fb(message: str) -> str:
    return "Module fallback: " + message


def main() -> None:
    assert (ROOT / "runtime/pi/browser_qa.py").read_bytes() == (ROOT / "runtime/browser/browser_qa.py").read_bytes()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        pkg, api = types.ModuleType("playwright"), types.ModuleType("playwright.sync_api")
        api.sync_playwright = FakePlaywright
        sys.modules["playwright"], sys.modules["playwright.sync_api"] = pkg, api
        chromium = tmp / "fake-chromium"
        chromium.write_text("#!/bin/sh\nexit 0\n")
        chromium.chmod(0o755)
        os.environ["CHROMIUM_BIN"] = str(chromium)
        base_src = tmp / "base_browser_qa.py"
        base_src.write_bytes(subprocess.run(["git", "show", f"{BASE}:runtime/pi/browser_qa.py"], cwd=ROOT, check=True, capture_output=True).stdout)
        new = load(ROOT / "runtime/pi/browser_qa.py", "qa_new")
        old = load(base_src, "qa_old")

        # 1. a passing page: byte-identical report, no new key.
        c_new, raw_new, rep = run_qa(new, tmp, "pass-new", DIMS)
        c_old, raw_old, _ = run_qa(old, tmp, "pass-old", DIMS)
        assert c_new == c_old == 0 and rep["status"] == "PASS"
        assert raw_new == raw_old, "a passing page's QA report must not change"
        assert "blocked_reasons" not in json.dumps(rep)

        # 2. a module whose draw threw: the same check fails, now with the reason.
        reason = "TypeError: Cannot read properties of undefined (reading 'links')"
        c_new, _, rep = run_qa(new, tmp, "blocked-new", blocked(fb(reason)))
        c_old, _, rep_old = run_qa(old, tmp, "blocked-old", blocked(fb(reason)))
        assert c_new == c_old == 2 and rep["status"] == rep_old["status"] == "FAIL"
        old_entry = [e for e in rep_old["errors"] if e.startswith("blocked_modules:")]
        entry = [e for e in rep["errors"] if e.startswith("blocked_modules:")]
        assert old_entry == ["blocked_modules:1440:m1"] and len(entry) == 1, (old_entry, entry)
        assert entry[0].startswith("blocked_modules:1440:m1") and reason in entry[0], entry
        assert [e for e in rep["errors"] if not e.startswith("blocked_modules:")] == [e for e in rep_old["errors"] if not e.startswith("blocked_modules:")]
        assert rep["viewports"][0]["blocked_modules"] == ["m1"]
        assert rep["viewports"][0]["blocked_reasons"] == [{"module_id": "m1", "reason": "runtime: " + reason}]

        # 3. a long reason is cut; control characters and line breaks never reach the entry.
        c_new, _, rep = run_qa(new, tmp, "long", blocked(fb("Error: " + "x" * 400 + "\nat file:///a/b/c.mjs:1:2")))
        why = rep["viewports"][0]["blocked_reasons"][0]["reason"]
        assert why.startswith("runtime: Error: x") and len(why) - len("runtime: ") == 160 and "\n" not in why, len(why)
        c_new, _, rep = run_qa(new, tmp, "ctl", blocked(fb("Error: a\tb\r\nc")))
        assert rep["viewports"][0]["blocked_reasons"][0]["reason"] == "runtime: Error: a b"

        # 3b. paths are removed; a detail line the page did not write (no prefix) or a non-runtime kind gives only the fixed word.
        c_new, _, rep = run_qa(new, tmp, "path", blocked(fb("Cannot load /Users/x/run/a.mjs now (at b.mjs:3:4)")))
        assert rep["viewports"][0]["blocked_reasons"][0]["reason"] == "runtime: Cannot load <path> now (at <path>", rep["viewports"][0]["blocked_reasons"]
        c_new, _, rep = run_qa(new, tmp, "slash1", blocked(fb("Cannot open /etc and /x.mjs, also a/b stays")))
        assert rep["viewports"][0]["blocked_reasons"][0]["reason"] == "runtime: Cannot open <path> and <path> also a/b stays", rep["viewports"][0]["blocked_reasons"]
        c_new, _, rep = run_qa(new, tmp, "noprefix", blocked("some other text"))
        assert rep["viewports"][0]["blocked_reasons"] == [{"module_id": "m1", "reason": "runtime"}]
        c_new, _, rep = run_qa(new, tmp, "webgl-detail", blocked(fb("leak"), kind="webgl"))
        assert rep["viewports"][0]["blocked_reasons"] == [{"module_id": "m1", "reason": "webgl"}]

        # 4. another data-blocked value gives its own fixed word; a module without a reason still fails the same way.
        c_new, _, rep = run_qa(new, tmp, "other", blocked("", kind="webgl"))
        assert c_new == 2 and rep["viewports"][0]["blocked_reasons"] == [{"module_id": "m1", "reason": "webgl"}]
        c_new, _, rep = run_qa(new, tmp, "bare", {**DIMS, "blocked": ["m1"]})
        assert c_new == 2 and [e for e in rep["errors"] if e.startswith("blocked_modules:")] == ["blocked_modules:1440:m1"]
        assert "blocked_reasons" not in rep["viewports"][0]
    print("test_qa_blocked_reason: ok")


if __name__ == "__main__":
    main()
