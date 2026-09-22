#!/usr/bin/env python3
"""Regression tests for browser QA startup failures and executable discovery."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime" / "browser"))
import browser_qa  # noqa: E402


def main() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        fake = root / "fake-chromium"
        fake.write_text("#!/bin/sh\nexit 0\n")
        fake.chmod(0o755)
        assert browser_qa.resolve_chromium_executable({"CHROMIUM_BIN": str(fake)}) == str(fake)
        assert browser_qa.resolve_chromium_executable({"CHROMIUM_BIN": str(root / "missing")}) is None
        path_fake = root / "chromium"
        path_fake.write_text("#!/bin/sh\nexit 0\n")
        path_fake.chmod(0o755)
        assert browser_qa.resolve_chromium_executable({"PATH": str(root)}) == str(path_fake)

        out = root / "failure"
        out.mkdir()
        browser_qa.write_startup_failure(out, "cpu", "playwright_dependency_unavailable")
        report = json.loads((out / "browser-qa.json").read_text())
        assert report["status"] == "FAIL"
        assert "playwright_dependency_unavailable" in report["errors"]

        html = root / "index.html"
        html.write_text("<!doctype html>")
        spec = root / "spec.json"
        spec.write_text(json.dumps({"delivery": {"breakpoints": [390]}}))
        output = root / "subprocess-failure"
        proc = subprocess.run(
            [sys.executable, "-S", str(ROOT / "runtime" / "browser" / "browser_qa.py"), "--html", str(html), "--spec", str(spec), "--output", str(output)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"},
        )
        assert proc.returncode == 2, (proc.stdout, proc.stderr)
        report = json.loads((output / "browser-qa.json").read_text())
        assert report["status"] == "FAIL"
        assert "playwright_dependency_unavailable" in report["errors"]

        fake_playwright = root / "playwright"
        fake_playwright.mkdir()
        (fake_playwright / "__init__.py").write_text("")
        (fake_playwright / "sync_api.py").write_text("def sync_playwright():\n    return None\n")
        path_output = root / "path-failure"
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        env.update({"PYTHONPATH": str(root), "CHROMIUM_BIN": str(root / "does-not-exist")})
        proc = subprocess.run(
            [sys.executable, "-S", str(ROOT / "runtime" / "browser" / "browser_qa.py"), "--html", str(html), "--spec", str(spec), "--output", str(path_output)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            env=env,
        )
        assert proc.returncode == 2, (proc.stdout, proc.stderr)
        report = json.loads((path_output / "browser-qa.json").read_text())
        assert report["status"] == "FAIL"
        assert "chromium_executable_unavailable" in report["errors"]
    print("browser QA bootstrap: PASS")


if __name__ == "__main__":
    main()
