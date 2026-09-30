#!/usr/bin/env python3
import argparse
import base64
import json
import re
from pathlib import Path

MAX_SVG_BYTES = 5_000_000

# Same wide/CJK code point ranges as isWideChar in runtime/pi/viz.mjs (which
# runtime/pi/infographic.mjs reuses via `import { isWideChar } from
# "./viz.mjs"` rather than redefining them). cairosvg is a cairo toy font
# face: it only ever looks at the first family in a font-family list and has
# no per-glyph fallback, so a page whose text falls in these ranges - and
# whose renderer wrote font-family="Arial, Helvetica, sans-serif" - rasterizes
# as tofu boxes there even though Chrome (what readers and browser QA use)
# renders it correctly by falling back per glyph. There is no shared source
# for this pattern across the JS/Python boundary, so keep the two definitions
# in sync by hand if isWideChar's ranges ever change.
CJK_WIDE_RE = re.compile(
    "[⺀-⿿　-〿぀-ヿㇰ-ㇿ"
    "㐀-䶿一-鿿ꥠ-꥿가-힯"
    "豈-﫿＀-￯]"
)


def has_cjk_or_wide_text(svg_text: str) -> bool:
    return CJK_WIDE_RE.search(svg_text) is not None


def rasterize_with_cairo(src: Path, dst: Path, width: int) -> None:
    import cairosvg
    cairosvg.svg2png(url=str(src), write_to=str(dst), output_width=width)


def rasterize_with_chrome(src: Path, dst: Path, width: int) -> None:
    # Imported lazily, and only from the sibling module materialized right
    # next to this script (src/runtime.rs puts rasterize_svg.py and
    # browser_qa.py in the same runtime/ directory), so a Latin-only preview
    # never needs playwright, Chrome, or even browser_qa.py's own stdlib-only
    # imports at all.
    from browser_qa import resolve_chromium_executable, drop_root_if_needed
    try:
        from playwright.sync_api import sync_playwright
    except (ImportError, ModuleNotFoundError):
        raise SystemExit("preview needs Chrome for CJK text: playwright_dependency_unavailable")
    chromium = resolve_chromium_executable()
    if not chromium:
        raise SystemExit("preview needs Chrome for CJK text: chromium_executable_unavailable")
    security = drop_root_if_needed(dst.parent)
    launch_args = ["--disable-gpu"]
    if not security["sandbox"]:
        launch_args.append("--no-sandbox")
    # A data: URI (not a file:// URL) so Chrome's handling of this SVG never
    # depends on local-file access policy. The <img> is scaled by CSS width
    # alone, so its rendered height comes from the SVG's own intrinsic
    # aspect ratio (viewBox, when there is no explicit width/height) - the
    # same signal cairosvg's output_width uses - and a zero-margin body plus
    # a viewport exactly `width` wide means the full-page screenshot below is
    # exactly the image, at exactly the requested width, with no letterboxing
    # or horizontal scroll to worry about.
    data_uri = "data:image/svg+xml;base64," + base64.b64encode(src.read_bytes()).decode("ascii")
    html = (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        "<style>html,body{margin:0;padding:0;background:#ffffff;}"
        f"img{{display:block;width:{width}px;height:auto;}}</style></head>"
        f"<body><img id=\"preview\" src=\"{data_uri}\"></body></html>"
    )
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chromium, headless=True, args=launch_args)
        try:
            page = browser.new_page(viewport={"width": width, "height": 100}, device_scale_factor=1)
            page.set_content(html, wait_until="load")
            page.wait_for_function(
                "() => { const el = document.getElementById('preview'); return !!el && el.complete && el.naturalWidth > 0; }",
                timeout=20_000,
            )
            page.wait_for_timeout(200)
            page.screenshot(path=str(dst), full_page=True)
        finally:
            browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Rasterize a trusted newsroom SVG to PNG for visual review")
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--width", type=int, required=True)
    args = parser.parse_args()
    src = Path(args.input).resolve()
    dst = Path(args.output).resolve()
    if args.width < 320 or args.width > 1800:
        raise SystemExit("width must be between 320 and 1800")
    if not src.is_file():
        raise SystemExit("input SVG does not exist")
    if src.stat().st_size > MAX_SVG_BYTES:
        raise SystemExit("input SVG exceeds 5 MB")
    dst.parent.mkdir(parents=True, exist_ok=True)
    svg_text = src.read_text(encoding="utf-8")
    if has_cjk_or_wide_text(svg_text):
        rasterize_with_chrome(src, dst, args.width)
        engine = "chrome-playwright"
    else:
        rasterize_with_cairo(src, dst, args.width)
        engine = "cairosvg"
    if not dst.is_file() or dst.stat().st_size == 0:
        raise SystemExit("rasterizer did not produce a PNG")
    print(json.dumps({"engine": engine}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
