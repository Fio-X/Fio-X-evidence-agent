#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(os.environ.get("NEWSROOM_T18_OUT", "ci-evidence"))
OUT.mkdir(parents=True, exist_ok=True)
JSON_OUT = OUT / "t18-browser-capability.json"
PNG_OUT = OUT / "t18-browser-capability.png"
HTML_OUT = OUT / "t18-browser-capability.html"
DRIVER_LOG = OUT / "t18-chromedriver.log"
PORT = int(os.environ.get("NEWSROOM_CHROMEDRIVER_PORT", "9515"))
BASE = f"http://127.0.0.1:{PORT}"


def request(method: str, path: str, payload=None, timeout=10):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_ready(seconds=15):
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        try:
            status = request("GET", "/status", timeout=2)
            if status.get("value", {}).get("ready") is True:
                return status
        except Exception as exc:
            last = exc
        time.sleep(0.25)
    raise RuntimeError(f"chromedriver did not become ready: {last}")


def png_dimensions(data: bytes):
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError("screenshot is not a PNG")
    return struct.unpack(">II", data[16:24])


def classify_webgl(probe: dict) -> str:
    if not probe.get("webgl"):
        return "UNAVAILABLE"
    renderer = str(probe.get("webgl_renderer") or "").lower()
    vendor = str(probe.get("webgl_vendor") or "").lower()
    joined = renderer + " " + vendor
    if any(token in joined for token in ("swiftshader", "llvmpipe", "software rasterizer")):
        return "SOFTWARE_WEBGL"
    return "ACCELERATED_WEBGL"


def main() -> int:
    if platform.system() != "Darwin":
        raise SystemExit("T18 browser capability probe is intended for macOS")
    chromedriver = shutil.which("chromedriver")
    if not chromedriver:
        raise SystemExit("chromedriver is not installed")
    chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if not Path(chrome).is_file():
        raise SystemExit(f"Google Chrome not found at {chrome}")

    html = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>T18 browser capability probe</title>
<style>body{font:18px -apple-system,BlinkMacSystemFont,sans-serif;margin:32px;color:#111}article{max-width:900px;margin:auto}svg,canvas{display:block;margin:18px 0;border:1px solid #ddd}.source{font-size:14px;color:#555}</style></head>
<body><article><h1>Browser qualification capability probe</h1><p>CPU rendering and WebGL capability are recorded independently.</p>
<svg width="720" height="180" role="img" aria-label="Deterministic bar chart"><rect x="40" y="100" width="120" height="60"/><rect x="200" y="60" width="120" height="100"/><rect x="360" y="30" width="120" height="130"/></svg>
<canvas id="cpu" width="720" height="180" aria-label="Canvas CPU probe"></canvas><canvas id="gpu" width="64" height="64"></canvas>
<p class="source">Synthetic local fixture; no external requests.</p></article>
<script>const c=document.getElementById('cpu'),ctx=c.getContext('2d');ctx.fillStyle='#222';ctx.fillRect(30,30,220,90);ctx.fillStyle='#fff';ctx.font='24px sans-serif';ctx.fillText('CPU visual PASS probe',45,82);</script></body></html>"""
    HTML_OUT.write_text(html, encoding="utf-8")
    data_url = "data:text/html;charset=utf-8," + urllib.parse.quote(html)

    with DRIVER_LOG.open("wb") as log:
        driver = subprocess.Popen([chromedriver, f"--port={PORT}"], stdout=log, stderr=subprocess.STDOUT)
        session_id = None
        try:
            driver_status = wait_ready()
            created = request("POST", "/session", {
                "capabilities": {"alwaysMatch": {
                    "browserName": "chrome",
                    "goog:chromeOptions": {"args": [
                        "--headless=new",
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--window-size=1280,800",
                        "--enable-webgl",
                        "--ignore-gpu-blocklist"
                    ]}
                }}
            }, timeout=30)
            value = created.get("value", {})
            session_id = value.get("sessionId") or created.get("sessionId")
            if not session_id:
                raise RuntimeError(f"failed to create Chrome session: {created}")
            request("POST", f"/session/{session_id}/url", {"url": data_url}, timeout=20)
            time.sleep(0.5)
            script = r"""
const cpu=document.getElementById('cpu');
const cpu2d=!!cpu.getContext('2d');
const gpu=document.getElementById('gpu');
const gl=gpu.getContext('webgl2') || gpu.getContext('webgl');
let renderer=null,vendor=null,version=null;
if(gl){
  version=gl.getParameter(gl.VERSION);
  const ext=gl.getExtension('WEBGL_debug_renderer_info');
  renderer=ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  vendor=ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
}
return {canvas2d:cpu2d,webgl:!!gl,webgl_renderer:renderer,webgl_vendor:vendor,webgl_version:version,user_agent:navigator.userAgent,device_pixel_ratio:window.devicePixelRatio,title:document.title};
"""
            probe = request("POST", f"/session/{session_id}/execute/sync", {"script": script, "args": []}, timeout=10).get("value", {})
            shot64 = request("GET", f"/session/{session_id}/screenshot", timeout=20).get("value")
            if not isinstance(shot64, str):
                raise RuntimeError("ChromeDriver did not return screenshot data")
            shot = base64.b64decode(shot64)
            width, height = png_dimensions(shot)
            PNG_OUT.write_bytes(shot)
            digest = hashlib.sha256(shot).hexdigest()
            cpu_pass = bool(probe.get("canvas2d")) and width >= 1000 and height >= 600 and len(shot) > 10000
            webgl_status = classify_webgl(probe)
            result = {
                "schema_version": "1.0.0",
                "scope": "hosted_macos_browser_capability_probe",
                "full_release_rc_status": "BLOCKED_PENDING_FULL_RELEASE_TREE",
                "platform": platform.platform(),
                "machine": platform.machine(),
                "browser_suite_status": "PASS" if cpu_pass else "FAIL",
                "cpu_visual_lane": {
                    "status": "PASS" if cpu_pass else "FAIL",
                    "canvas_2d": bool(probe.get("canvas2d")),
                    "screenshot": str(PNG_OUT),
                    "screenshot_width": width,
                    "screenshot_height": height,
                    "screenshot_bytes": len(shot),
                    "screenshot_sha256": digest
                },
                "gpu_webgl": {
                    "status": webgl_status,
                    "webgl_context": bool(probe.get("webgl")),
                    "renderer": probe.get("webgl_renderer"),
                    "vendor": probe.get("webgl_vendor"),
                    "version": probe.get("webgl_version"),
                    "note": "ACCELERATED_WEBGL records browser-reported acceleration only; SOFTWARE_WEBGL and UNAVAILABLE are never converted to PASS."
                },
                "browser": {
                    "user_agent": probe.get("user_agent"),
                    "title": probe.get("title"),
                    "device_pixel_ratio": probe.get("device_pixel_ratio"),
                    "chromedriver_ready": bool(driver_status.get("value", {}).get("ready"))
                },
                "external_network_required": False,
                "artifacts": [str(JSON_OUT), str(PNG_OUT), str(HTML_OUT), str(DRIVER_LOG)]
            }
            JSON_OUT.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(json.dumps(result, indent=2, sort_keys=True))
            return 0 if cpu_pass else 2
        finally:
            if session_id:
                try:
                    request("DELETE", f"/session/{session_id}", timeout=5)
                except Exception:
                    pass
            driver.terminate()
            try:
                driver.wait(timeout=5)
            except subprocess.TimeoutExpired:
                driver.kill()


if __name__ == "__main__":
    raise SystemExit(main())
