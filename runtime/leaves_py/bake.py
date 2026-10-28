"""Bake: one page laid out once in headless Chrome, its layout scripts run and then dropped, so the page keeps only the
renderer's ready script. One JSON line in {"html", "ready", "width"}, one line out {"html", "ms"} or {"error"}.
The page is opened from a local file with every host unresolvable and, while it bakes, a content policy that blocks every
request it would make; each blocked request is left on the page as a mark and any mark is an error, never let through.
Layer 1 compares the texts before and after (next_leaf::bake)."""
import importlib.util, json, os, re, subprocess, sys, tempfile, time

D = os.path.dirname(os.path.abspath(__file__))
FLAGS = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
         "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
         "--disable-domain-reliability", "--disable-client-side-phishing-detection", "--no-pings", "--metrics-recording-only",
         "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=2000"]
# Put first on the page while it bakes, taken off after: no request leaves the page, and each one it tried is marked.
GUARD = ('<meta data-bake="1" http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; '
         "style-src 'unsafe-inline'; img-src data:; font-src data:\">"
         '<script data-bake="1">document.addEventListener("securitypolicyviolation",function(e){var m=document.createElement("meta");'
         'm.setAttribute("data-bake-asked",e.blockedURI||"?");document.documentElement.appendChild(m);});</script>')
CHARSET = '<meta charset="utf-8">'

def chrome():
    """browser_qa.py's resolver (CHROMIUM_BIN, PATH, the usual install places), not a copy of it."""
    spec = importlib.util.spec_from_file_location("browser_qa", os.path.join(D, "..", "browser", "browser_qa.py"))
    assert spec and spec.loader
    qa = importlib.util.module_from_spec(spec); spec.loader.exec_module(qa)
    return qa.resolve_chromium_executable()

def bake(req):
    exe = chrome()
    if not exe: return {"error": "no Chrome or Chromium to lay the page out in"}
    with tempfile.TemporaryDirectory(prefix="bake-") as tmp:
        page, html = os.path.join(tmp, "page.html"), req["html"]
        at = html.find(CHARSET) + len(CHARSET) if CHARSET in html else (15 if html[:15].lower() == "<!doctype html>" else 0)
        with open(page, "w", encoding="utf-8") as f: f.write(html[:at] + GUARD + html[at:])
        t0 = time.perf_counter()
        run = subprocess.run([exe, *FLAGS, f"--user-data-dir={os.path.join(tmp, 'profile')}", f"--window-size={int(req.get('width', 1440))},900", "--dump-dom", "file://" + page],
                             capture_output=True, timeout=30)
        ms = round((time.perf_counter() - t0) * 1000)
        if run.returncode != 0 or not run.stdout.strip(): return {"error": f"Chrome exited {run.returncode} with no page"}
    dom = run.stdout.decode("utf-8")
    asked = re.findall(r'data-bake-asked="([^"]*)"', dom)
    if asked: return {"error": "the page asked for " + ", ".join(sorted(set(asked))[:5])}
    if not re.search(r'<meta data-bake="1"[^>]*>', dom): return {"error": "the bake guard is not on the laid-out page"}
    dom = re.sub(r'<meta data-bake="1"[^>]*>', "", dom, count=1)
    kept = re.sub(r"<script\b[^>]*>(.*?)</script>", lambda m: m.group(0) if m.group(1) == req["ready"] else "", dom, flags=re.S)
    lead = "<!doctype html>" if req["html"].lstrip()[:15].lower() == "<!doctype html>" else ""
    return {"html": lead + kept, "ms": ms}

if __name__ == "__main__":
    for line in sys.stdin:
        try: out = bake(json.loads(line))
        except Exception as e: out = {"error": f"{type(e).__name__}: {e}"}
        print(json.dumps(out, ensure_ascii=False), flush=True)
