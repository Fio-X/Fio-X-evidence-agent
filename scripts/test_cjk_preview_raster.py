#!/usr/bin/env python3
"""Regression tests for the CJK/wide-script preview rasterizer.

cairosvg is a cairo toy font face: it only ever looks at the first family
in a font-family list and has no per-glyph fallback, so a page whose text
contains CJK/wide characters - and whose renderer wrote
font-family="Arial, Helvetica, sans-serif", as viz.mjs and infographic.mjs
do - rasterizes as tofu boxes there even though Chrome (what readers and
browser QA actually use) renders it correctly by falling back per glyph.
runtime/pi/rasterize_svg.py now detects that case (same code point ranges
as viz.mjs's isWideChar) and rasterizes it with Chrome through Playwright
instead, failing clearly with no PNG when Playwright or Chrome is missing
rather than silently handing the vision critic a misleading image.

Three cases, matching the task's own test list:
  1. A Latin SVG still goes through cairosvg, unchanged.
  2. A CJK SVG with no Playwright available gives a clear failure and no
     PNG. This uses `-S` (skips the `site` module, so nothing in
     site-packages - including any pip-installed playwright - is
     importable) so the case is deterministic in any environment, exactly
     like scripts/test_browser_qa_bootstrap.py's own
     playwright_dependency_unavailable case. A second variant reuses that
     same file's fake-playwright/CHROMIUM_BIN technique to force
     chromium_executable_unavailable instead.
  3. A CJK SVG with a real Playwright + Chrome available gives a Chrome PNG
     of the right width that is not boxes - proven by two different CJK
     strings rendering to different PNG bytes, since boxes all look the
     same. This case is skipped (not failed) where Playwright or Chrome is
     not available to the interpreter running this test, e.g. CI's Linux
     job, which installs CairoSVG but not Playwright (see ci.yml).
"""
from __future__ import annotations

import os
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RASTERIZER = ROOT / "runtime" / "pi" / "rasterize_svg.py"
LATIN_FIXTURE = ROOT / "fixtures" / "infographic" / "magazine-regression.svg"

CJK_SVG_A = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 400" role="img"><title>fixture</title><desc>fixture</desc><rect width="900" height="400" fill="#ffffff"/><text x="60" y="120" font-family="Arial, Helvetica, sans-serif" font-size="48" font-weight="700" fill="#1d2329">中文测试甲组</text><text x="60" y="220" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="#1d2329">这一行用来验证字形渲染是否正确。</text></svg>'
CJK_SVG_B = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 400" role="img"><title>fixture</title><desc>fixture</desc><rect width="900" height="400" fill="#ffffff"/><text x="60" y="120" font-family="Arial, Helvetica, sans-serif" font-size="48" font-weight="700" fill="#1d2329">日本語表示乙組</text><text x="60" y="220" font-family="Arial, Helvetica, sans-serif" font-size="28" fill="#1d2329">另一段完全不同的文字内容用于对比。</text></svg>'


def png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"not a PNG: {path}")
    return struct.unpack(">II", data[16:24])


def rasterize(svg: Path, png: Path, width: int, env: dict | None = None, extra_args: list[str] | None = None) -> subprocess.CompletedProcess:
    args = [sys.executable, *(extra_args or []), str(RASTERIZER), str(svg), str(png), "--width", str(width)]
    return subprocess.run(args, capture_output=True, text=True, cwd=ROOT, env=env)


def case_latin_unchanged() -> None:
    with tempfile.TemporaryDirectory(prefix="cjk-preview-latin-") as tmp:
        png = Path(tmp) / "out.png"
        t0 = time.perf_counter()
        proc = rasterize(LATIN_FIXTURE, png, 900)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        if proc.returncode != 0:
            raise SystemExit(f"FAIL: Latin SVG rasterization failed: {proc.stderr}")
        if '"engine": "cairosvg"' not in proc.stdout:
            raise SystemExit(f"FAIL: Latin SVG did not report the cairosvg engine: {proc.stdout!r}")
        w, h = png_dimensions(png)
        if w != 900:
            raise SystemExit(f"FAIL: Latin PNG width {w} != 900")
        print(f"Latin SVG -> cairosvg: PASS ({elapsed_ms:.1f} ms, {w}x{h})")


def case_cjk_without_playwright_import() -> None:
    # -S disables the site module, so nothing in site-packages - including a
    # pip-installed playwright, if this interpreter happens to have one - is
    # importable. This makes the case deterministic in any environment,
    # exactly like test_browser_qa_bootstrap.py's own
    # playwright_dependency_unavailable subprocess-failure case.
    with tempfile.TemporaryDirectory(prefix="cjk-preview-nopw-") as tmp:
        svg = Path(tmp) / "cjk.svg"
        svg.write_text(CJK_SVG_A, encoding="utf-8")
        png = Path(tmp) / "out.png"
        proc = rasterize(svg, png, 900, extra_args=["-S"])
        if proc.returncode == 0:
            raise SystemExit("FAIL: CJK SVG rasterized without Playwright available")
        if "preview needs Chrome for CJK text: playwright_dependency_unavailable" not in proc.stderr:
            raise SystemExit(f"FAIL: unexpected failure message: {proc.stderr!r}")
        if png.exists():
            raise SystemExit("FAIL: a PNG was written despite the missing-Playwright failure")
        print("CJK SVG, Playwright unavailable -> clear failure, no PNG: PASS")


def case_cjk_without_chromium() -> None:
    # A working (stub) playwright import that never reaches a real browser
    # launch, plus an explicit CHROMIUM_BIN that does not resolve to a real
    # executable - resolve_chromium_executable returns None unconditionally
    # in that case, regardless of what is actually on PATH - forces
    # chromium_executable_unavailable deterministically. Same technique as
    # test_browser_qa_bootstrap.py's path-failure case.
    with tempfile.TemporaryDirectory(prefix="cjk-preview-nochrome-") as tmp:
        root = Path(tmp)
        svg = root / "cjk.svg"
        svg.write_text(CJK_SVG_A, encoding="utf-8")
        png = root / "out.png"
        fake_playwright = root / "playwright"
        fake_playwright.mkdir()
        (fake_playwright / "__init__.py").write_text("")
        (fake_playwright / "sync_api.py").write_text("def sync_playwright():\n    raise AssertionError('must not reach chromium launch')\n")
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        env.update({"PYTHONPATH": str(root), "CHROMIUM_BIN": str(root / "does-not-exist")})
        proc = rasterize(svg, png, 900, env=env)
        if proc.returncode == 0:
            raise SystemExit("FAIL: CJK SVG rasterized without a resolvable Chromium")
        if "preview needs Chrome for CJK text: chromium_executable_unavailable" not in proc.stderr:
            raise SystemExit(f"FAIL: unexpected failure message: {proc.stderr!r}")
        if png.exists():
            raise SystemExit("FAIL: a PNG was written despite the missing-Chromium failure")
        print("CJK SVG, Chromium unavailable -> clear failure, no PNG: PASS")


def chrome_available() -> bool:
    try:
        import playwright  # noqa: F401
    except ImportError:
        return False
    sys.path.insert(0, str(ROOT / "runtime" / "pi"))
    from browser_qa import resolve_chromium_executable
    return resolve_chromium_executable() is not None


def case_cjk_with_chrome() -> None:
    if not chrome_available():
        print("CJK SVG, real Chrome render: SKIP (this interpreter has no Playwright/Chrome)")
        return
    with tempfile.TemporaryDirectory(prefix="cjk-preview-chrome-") as tmp:
        root = Path(tmp)
        svg_a, svg_b = root / "a.svg", root / "b.svg"
        svg_a.write_text(CJK_SVG_A, encoding="utf-8")
        svg_b.write_text(CJK_SVG_B, encoding="utf-8")
        png_a, png_b = root / "a.png", root / "b.png"
        t0 = time.perf_counter()
        proc_a = rasterize(svg_a, png_a, 900)
        elapsed_a_ms = (time.perf_counter() - t0) * 1000
        if proc_a.returncode != 0:
            raise SystemExit(f"FAIL: CJK SVG A did not rasterize with Chrome available: {proc_a.stderr}")
        if '"engine": "chrome-playwright"' not in proc_a.stdout:
            raise SystemExit(f"FAIL: CJK SVG A did not report the chrome-playwright engine: {proc_a.stdout!r}")
        t0 = time.perf_counter()
        proc_b = rasterize(svg_b, png_b, 900)
        elapsed_b_ms = (time.perf_counter() - t0) * 1000
        if proc_b.returncode != 0:
            raise SystemExit(f"FAIL: CJK SVG B did not rasterize with Chrome available: {proc_b.stderr}")
        w_a, h_a = png_dimensions(png_a)
        w_b, h_b = png_dimensions(png_b)
        if w_a != 900 or w_b != 900:
            raise SystemExit(f"FAIL: Chrome PNG width mismatch: {w_a}, {w_b} != 900")
        # The one property tofu boxes cannot have: two different CJK strings
        # must render to different pixels. Boxes all look the same, so equal
        # bytes here would mean the glyphs never actually rendered.
        if png_a.read_bytes() == png_b.read_bytes():
            raise SystemExit("FAIL: two different CJK strings rendered identical PNG bytes (looks like tofu boxes)")
        print(f"CJK SVG, real Chrome render: PASS ({w_a}x{h_a}, A={elapsed_a_ms:.1f} ms, B={elapsed_b_ms:.1f} ms)")


def main() -> None:
    if not RASTERIZER.is_file():
        raise SystemExit(f"missing rasterizer: {RASTERIZER}")
    if not LATIN_FIXTURE.is_file():
        raise SystemExit(f"missing Latin fixture: {LATIN_FIXTURE}")
    case_latin_unchanged()
    case_cjk_without_playwright_import()
    case_cjk_without_chromium()
    case_cjk_with_chrome()
    print("CJK preview raster test: PASS")


if __name__ == "__main__":
    main()
