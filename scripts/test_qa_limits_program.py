#!/usr/bin/env python3
"""K204: unless NEWSROOM_QA_LIMITS_PROGRAM is exactly "0", browser QA's page-size and
ready-time limits are the program's (newsroom_publication_plan's defaults: 8 MB
archive, 1.5 MB production, 8 s) and a value in the spec can only make them
stricter; the report records each limit and where it came from. At "0", the
report is byte-for-byte what it was.

Runs browser_qa.main() in-process against a fake Playwright and a fake clock, so no
browser is started and every report is byte-stable."""
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime" / "pi"))
import browser_qa  # noqa: E402

SWITCH = "NEWSROOM_QA_LIMITS_PROGRAM"
CLOCK = [0.0]
READY_S = [0.0]
DIMS = {"style_profile": "analytical_precision", "sw": 1440, "cw": 1440, "modules": [{"id": "m", "left": 0, "right": 1200}],
        "blocked": [], "plotly": [], "webgl_error": False, "font_status": "loaded", "accessibility_errors": []}


class FakePage:
    def on(self, *_a): pass
    def set_content(self, *_a, **_k): pass
    def wait_for_function(self, *_a, **_k): CLOCK[0] += READY_S[0]
    def wait_for_timeout(self, *_a): pass
    def evaluate(self, *_a): return DIMS
    def screenshot(self, path, **_k): Path(path).write_bytes(b"png")
    def close(self): pass


class FakeBrowser:
    def new_page(self, **_k): return FakePage()
    def close(self): pass


class FakePlaywright:
    chromium = types.SimpleNamespace(launch=lambda **_k: FakeBrowser())
    def __enter__(self): return self
    def __exit__(self, *_a): return False


def install_fakes(tmp: Path) -> None:
    pkg = types.ModuleType("playwright")
    api = types.ModuleType("playwright.sync_api")
    api.sync_playwright = FakePlaywright
    sys.modules["playwright"], sys.modules["playwright.sync_api"] = pkg, api
    chromium = tmp / "fake-chromium"
    chromium.write_text("#!/bin/sh\nexit 0\n")
    chromium.chmod(0o755)
    os.environ["CHROMIUM_BIN"] = str(chromium)
    browser_qa.time = types.SimpleNamespace(perf_counter=lambda: CLOCK[0])


def run_qa(tmp: Path, name: str, delivery: dict, page_bytes: int, ready_s: float, switch):
    """Returns (exit code, report bytes, report)."""
    case = tmp / name
    case.mkdir()
    html = case / "index.html"
    html.write_bytes(b"<!doctype html>" + b" " * (page_bytes - 15))
    spec = case / "spec.json"
    spec.write_text(json.dumps({"delivery": {"breakpoints": [1440], **delivery}, "interaction": {"replay": []}}))
    out = case / "qa"
    if switch is None:
        os.environ.pop(SWITCH, None)
    else:
        os.environ[SWITCH] = switch
    READY_S[0] = ready_s
    sys.argv = ["browser_qa.py", "--html", str(html), "--spec", str(spec), "--output", str(out)]
    code = 0
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            browser_qa.main()
    except SystemExit as exc:
        code = exc.code
    finally:
        os.environ.pop(SWITCH, None)
    raw = (out / "browser-qa.json").read_bytes()
    return code, raw, json.loads(raw)


def main() -> None:
    assert (ROOT / "runtime/pi/browser_qa.py").read_bytes() == (ROOT / "runtime/browser/browser_qa.py").read_bytes(), "the bundled browser_qa.py copy must match runtime/pi"
    # The QA defaults are the plan's defaults (newsroom_publication_plan fills these when the model leaves them out).
    ts = (ROOT / "runtime/pi/newsroom.ts").read_text()
    m = re.search(r'max_initial_bytes: params\.max_initial_bytes \?\? \(packaging === "archive" \? ([\d_]+) : ([\d_]+)\)', ts)
    r = re.search(r"max_ready_ms: params\.max_ready_ms \?\? ([\d_]+)", ts)
    assert m and r, "newsroom_publication_plan's delivery defaults moved; keep browser_qa.py's QA_DEFAULT_* in step"
    assert browser_qa.QA_DEFAULT_INITIAL_BYTES == {"archive": int(m.group(1).replace("_", "")), "production": int(m.group(2).replace("_", ""))}
    assert browser_qa.QA_DEFAULT_READY_MS == int(r.group(1).replace("_", ""))

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        install_fakes(tmp)
        wide = {"packaging": "archive", "max_initial_bytes": 20_000_000, "max_ready_ms": 30_000}

        # 1. the model asks for 20 MB and 30 s; the page is 9 MB and ready at 10 s.
        code, _, rep = run_qa(tmp, "wide-off", wide, 9_000_000, 10.0, "0")
        assert code == 0 and rep["status"] == "PASS", rep["errors"]
        assert rep["max_initial_bytes"] == 20_000_000 and rep["viewports"][0]["max_ready_ms"] == 30_000
        assert "limits" not in rep
        code, _, rep = run_qa(tmp, "wide-on", wide, 9_000_000, 10.0, "1")
        assert code == 2 and rep["status"] == "FAIL"
        assert "initial_bytes:9000000>8000000" in rep["errors"], rep["errors"]
        assert "ready_time:1440:10000.0>8000" in rep["errors"], rep["errors"]
        assert rep["max_initial_bytes"] == 8_000_000 and rep["viewports"][0]["max_ready_ms"] == 8_000
        assert rep["limits"] == {
            "max_initial_bytes": {"value": 8_000_000, "source": "default", "requested": 20_000_000, "default": 8_000_000},
            "max_ready_ms": {"value": 8_000, "source": "default", "requested": 30_000, "default": 8_000},
        }, rep["limits"]

        # 1b. default (variable unset) is the same as "1", byte for byte
        _, raw_on, _ = run_qa(tmp, "wide-on-again", wide, 9_000_000, 10.0, "1")
        code, raw_default, rep = run_qa(tmp, "wide-default", wide, 9_000_000, 10.0, None)
        assert code == 2 and rep["status"] == "FAIL" and raw_default == raw_on

        # 2. a stricter value is kept: 4 MB blocks a 5 MB page and passes a 3 MB one.
        strict = {"packaging": "archive", "max_initial_bytes": 4_000_000}
        code, _, rep = run_qa(tmp, "strict-on-5mb", strict, 5_000_000, 1.0, "1")
        assert code == 2 and "initial_bytes:5000000>4000000" in rep["errors"], rep["errors"]
        assert rep["limits"]["max_initial_bytes"] == {"value": 4_000_000, "source": "model_stricter", "requested": 4_000_000, "default": 8_000_000}
        assert rep["limits"]["max_ready_ms"] == {"value": 8_000, "source": "default", "requested": None, "default": 8_000}
        code, _, rep = run_qa(tmp, "strict-on-3mb", strict, 3_000_000, 1.0, "1")
        assert code == 0 and rep["status"] == "PASS" and rep["max_initial_bytes"] == 4_000_000, rep["errors"]

        # 3. production packaging: the plan's default is 1.5 MB, so the 3 MB the stored runs asked for is cut to it.
        prod = {"packaging": "production", "max_initial_bytes": 3_000_000, "max_ready_ms": 10_000}
        code, _, rep = run_qa(tmp, "prod-off", prod, 2_000_000, 1.0, "0")
        assert code == 0 and rep["max_initial_bytes"] == 3_000_000, rep["errors"]
        code, _, rep = run_qa(tmp, "prod-on", prod, 2_000_000, 1.0, "1")
        assert code == 2 and "initial_bytes:2000000>1500000" in rep["errors"], rep["errors"]
        assert rep["limits"]["max_initial_bytes"]["source"] == "default" and rep["limits"]["max_ready_ms"]["value"] == 8_000

        # 4. nothing in the spec: on uses the default (8 MB), "0" keeps the old 20 MB fallback.
        code, _, rep = run_qa(tmp, "none-on", {}, 9_000_000, 1.0, "1")
        assert code == 2 and "initial_bytes:9000000>8000000" in rep["errors"], rep["errors"]
        assert rep["limits"]["max_initial_bytes"] == {"value": 8_000_000, "source": "default", "requested": None, "default": 8_000_000}
        code, _, rep = run_qa(tmp, "none-off", {}, 9_000_000, 1.0, "0")
        assert code == 0 and rep["max_initial_bytes"] == 20_000_000 and "limits" not in rep, rep["errors"]

        # 5. only the exact "0" turns it off: unset and every other value give the "1" report, byte for byte.
        _, on_raw, _ = run_qa(tmp, "on-ref", wide, 9_000_000, 10.0, "1")
        for i, value in enumerate([None, "", "yes", " 1", "on", "1 ", "true", "00"]):
            _, raw, _ = run_qa(tmp, f"on-{i}", wide, 9_000_000, 10.0, value)
            # the report holds no paths, so the bytes compare directly
            assert raw == on_raw, f"{SWITCH}={value!r} changed the report"
        _, off_raw, _ = run_qa(tmp, "off-zero", wide, 9_000_000, 10.0, "0")
        assert off_raw != on_raw
    print("qa limits program: OK")


if __name__ == "__main__":
    main()
