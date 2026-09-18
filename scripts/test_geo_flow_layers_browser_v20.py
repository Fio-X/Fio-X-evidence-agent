#!/usr/bin/env python3
"""Browser QA for the self-contained layered cartographic-flow evaluation."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    html = Path(args.html).resolve()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    external: list[str] = []
    viewports = []
    screenshots = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_BIN", "/usr/bin/chromium"),
            headless=True,
            args=["--disable-gpu"],
        )
        for width in (390, 768, 1280):
            print(f"browser-qa viewport {width}", flush=True)
            context = browser.new_context(
                viewport={"width": width, "height": 900},
                device_scale_factor=1,
                reduced_motion="reduce",
            )
            page = context.new_page()
            page.on("console", lambda msg: errors.append(f"console:{msg.type}:{msg.text}") if msg.type == "error" else None)
            page.on("pageerror", lambda exc: errors.append(f"pageerror:{exc}"))
            page.on("request", lambda req: external.append(req.url) if req.url.startswith(("http://", "https://")) else None)
            page.goto(html.as_uri(), wait_until="load")
            page.wait_for_function("window.__GEO_FLOW_READY === true", timeout=10000)
            page.wait_for_timeout(100)
            if page.locator(".layer-tab").count() != 3:
                errors.append(f"tabs:{width}")
            if page.locator('.flow-layer:not([hidden])').count() != 1:
                errors.append(f"active_layer_count:{width}")
            if page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 2"):
                errors.append(f"overflow:{width}")
            if page.locator('[data-role="cartographic-basemap"]').count() < 1:
                errors.append(f"basemap:{width}")
            if page.locator('[data-role="cartographic-hit"]').count() < 1:
                errors.append(f"route_hit_target:{width}")
            if page.locator('[data-role="flow-link"]').count() < 1:
                errors.append(f"sankey:{width}")
            screenshot = out / f"layered-flow-{width}.png"
            page.screenshot(path=str(screenshot), full_page=True)
            screenshots.append({"width": width, "path": screenshot.name, "sha256": sha(screenshot)})
            viewports.append({"width": width, "scroll_width": page.evaluate("document.documentElement.scrollWidth"), "client_width": page.evaluate("document.documentElement.clientWidth"), "active_layer": page.locator('.flow-layer:not([hidden])').get_attribute("data-layer-id")})
            page.close()
            context.close()

        context = browser.new_context(viewport={"width": 1280, "height": 900}, reduced_motion="reduce")
        print("browser-qa interaction replay", flush=True)
        page = context.new_page()
        page.goto(html.as_uri(), wait_until="load")
        page.wait_for_function("window.__GEO_FLOW_READY === true", timeout=10000)
        page.locator('[data-layer-target="logistics"]').click()
        if page.locator('.flow-layer:not([hidden])').get_attribute("data-layer-id") != "logistics":
            errors.append("tab_switch:logistics")
        route = page.locator('.flow-layer:not([hidden]) [data-role="cartographic-hit"], .flow-layer:not([hidden]) [data-role="flow-hit"]').first
        route.focus()
        if not route.evaluate("el => el.classList.contains('is-active')"):
            errors.append("route_focus:not_active")
        route.click()
        if "Pinned:" not in page.locator("#focus-status").inner_text():
            errors.append("route_pin:missing_status")
        page.keyboard.press("Escape")
        if "Hover a route" not in page.locator("#focus-status").inner_text():
            errors.append("route_escape:not_released")
        page.close()
        context.close()
        print("browser-qa closing", flush=True)
        browser.close()
    external = sorted(set(external))
    if external:
        errors.append("external_requests_detected")
    report = {"schema_version": "0.1.0", "status": "PASS" if not errors else "FAIL", "html_sha256": sha(html), "viewports": viewports, "screenshots": screenshots, "external_requests": external, "errors": errors, "reduced_motion": True}
    (out / "browser-qa.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())
