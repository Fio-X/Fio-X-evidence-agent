"""Bake: one page laid out once in headless Chrome, its layout scripts run and then dropped, so the page keeps only the
renderer's ready script. One JSON line in {"html", "ready", "width"}, one line out {"html", "ms"} or {"error"}.
The page is opened from a local file with every host unresolvable and, while it bakes, a content policy that blocks every
request it would make; each blocked request is left on the page as a mark and any mark is an error, never let through.
Once laid out, the page's text is checked where Chrome put it (QA below: out of its svg, over another text, on a line, over a
box edge), html layers included; any finding is an error, but for the two the line rule lets through (LINE_RULE).
Layer 1 compares the texts before and after (next_leaf::bake)."""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile, time
from html import unescape as html_unescape

D = os.path.dirname(os.path.abspath(__file__))
FLAGS = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
         "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
         "--disable-domain-reliability", "--disable-client-side-phishing-detection", "--no-pings", "--metrics-recording-only",
         "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=2000",
         # no keychain: inside a sandbox the real one cannot be reached and Chrome's teardown hangs on it (exit 2 after the
         # page is out); the bake stores no password either way
         "--use-mock-keychain", "--password-store=basic"]
# Put first on the page while it bakes, taken off after: no request leaves the page, and each one it tried is marked.
GUARD = ('<meta data-bake="1" http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; '
         "style-src 'unsafe-inline'; img-src data:; font-src data:\">"
         '<script data-bake="1">document.addEventListener("securitypolicyviolation",function(e){var m=document.createElement("meta");'
         'm.setAttribute("data-bake-asked",e.blockedURI||"?");document.documentElement.appendChild(m);});</script>')
CHARSET = '<meta charset="utf-8">'
# The layout checks, run on the laid-out page before its scripts are dropped; each is the research prototype's own check,
# its criteria unchanged, pinned by sha256 so an edit to one is a bake error, not a quieter check:
#   qa.js: gas-1027 qa.js (226ea0d3...), byte for byte: svg text out of its svg, text over text in one svg, html notes over notes.
#   qa-layers.js: gas-1027 qa-layers.js (b4d7bb13...), only its "does not fit" message put in English: text over text across
#     layers, html texts too, text on a route or flow line, a layer's left-over names.
#   text-line-clash.js: lib-bakeoff-1028 text-line-clash.js (130b7d0f...), byte for byte: a text on a data line, or straddling
#     the edge of a filled box, in any svg (a grid line is not a finding).
#   text-line-hits.js: the same hit test kept per hit (which element, its layer and data-line, the text's data-on); its counts
#     must equal text-line-clash.js's, svg by svg, or the bake fails, so the rule below reads the checker's own hits. Then
#     qa-layers.js's line test kept per path, the same way: its findings must equal qa-layers.js's line findings one for one.
QA = {"qa.js": "226ea0d3d9c9897f9e51c113de2af2fdb95c40f99f01515dc3018c2e9becc218",
      "qa-layers.js": "3fa54e3d6cf17818d3042bb2b6e31dbbb7ed7d5f2a268547e6417aee24a2f26d",
      "text-line-clash.js": "130b7d0fa07d606b9115b587a89516a7b078a970735d7294227acae68f220ef4",
      "text-line-hits.js": "34a93b56c7ce40783bb7d904cfc99306cdabb8e6a67e97e0143aa881fa826563"}
BASE = "map.base"  # the base map's layer: its borders and coastlines are background (the sea box's edge is not)

def own(h):
    """The text is on its own line: the text's data-on names the line's data-line."""
    return h["on"] != "" and h["on"] == h["line"]

def let_through(h):
    """LINE_RULE: a line hit is let through when the line is drawn in the base map's layer, or is the text's own line; every
    other text on a data line, and every text on a box edge, the base map's included, stays a finding."""
    return h["kind"] == "line" and (h["el_layer"] == BASE or own(h))

def line_findings(clash, hits, layers):
    """The line findings left after LINE_RULE: the checker's counts and the per-hit counts must agree svg by svg; then each
    text with a hit the rule does not let through; then qa-layers.js's findings, its per-path line hits matched one for one, a
    line finding dropped only when every path it stands for is the text's own line."""
    paths, hits = hits["paths"], hits["svgs"]
    if [(c["svg"], c["text_on_data_line"], c["text_straddles_rect_edge"]) for c in clash] != \
       [(h["svg"], h["text_on_data_line"], h["text_straddles_rect_edge"]) for h in hits]:
        raise ValueError("the per-hit line check does not count as text-line-clash.js does")
    out = []
    for h in hits:
        bad = [x for x in h["hits"] if not let_through(x)]
        for t in dict.fromkeys(x["text"] for x in bad):
            what = sorted({x["el"] + " (" + x["el_layer"] + (" edge" if x["kind"] == "edge" else "") + ")" for x in bad if x["text"] == t})
            out.append(f"line: svg{h['svg']}: {t} x " + ", ".join(what))
    keys = {}
    for x in paths: keys.setdefault((x["text_layer"], x["text"], x["el_layer"]), []).append(x)
    owned = {}
    for (tl, t, pl), xs in keys.items(): owned.setdefault(f"{tl} × {pl} line: {t[:14]}", []).append(all(own(x) for x in xs))
    said = [s for s in layers if re.fullmatch(r"\S+ × \S+ line: .*", s, re.S)]
    if sorted(said) != sorted(s for s, v in owned.items() for _ in v):
        raise ValueError("the per-path line check does not find what qa-layers.js finds")
    for s in layers:
        if s in owned and owned[s].pop(0): continue
        out.append("layers: " + s)
    return out

def checks():
    """The checks as one script put on the page with the guard: after load and the page's own timers, each finding is left
    as a mark, and a last mark says the checks ran."""
    src = {}
    for name, sha in QA.items():
        with open(os.path.join(D, name), "rb") as f: b = f.read()
        if hashlib.sha256(b).hexdigest() != sha: raise ValueError(f"the layout check {name} is not the pinned one")
        src[name] = b.decode("utf-8").strip()
    put = 'var m=document.createElement("meta");m.setAttribute(k,v);document.documentElement.appendChild(m)'
    return ('<script data-bake="1">addEventListener("load",function(){setTimeout(function(){var f=[],add=function(s){f.push(s)};'
            f'var mark=function(k,v){{{put}}};'
            f'try{{var r=({src["qa.js"]})();if(r!=="clean")r.split("\\n").forEach(function(s){{add("qa: "+s)}})}}catch(e){{add("qa: failed: "+e)}}'
            f'try{{var r=({src["qa-layers.js"]})();if(r!=="clean")r.split("\\n").forEach(function(s){{mark("data-bake-layers",s)}})}}catch(e){{add("layers: failed: "+e)}}'
            f'try{{mark("data-bake-lines",({src["text-line-clash.js"]})())}}catch(e){{add("line: failed: "+e)}}'
            f'try{{mark("data-bake-hits",({src["text-line-hits.js"]})())}}catch(e){{add("line hits: failed: "+e)}}'
            'f.forEach(function(s){mark("data-bake-qa",s)});mark("data-bake-qa-ran","1")},1500)})</script>')

def chrome(env=None):
    """An installed Chrome or Chromium: CHROMIUM_BIN, then PATH, then the usual install places. Copied from the old route's
    runtime/browser/browser_qa.py resolve_chromium_executable (frozen, to be removed), so the bake does not import it."""
    env = os.environ if env is None else env
    explicit = str(env.get("CHROMIUM_BIN", "")).strip()
    if explicit:
        p = os.path.expanduser(explicit)
        return p if os.path.isfile(p) and os.access(p, os.X_OK) else None
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"):
        found = shutil.which(name, path=env.get("PATH"))
        if found: return found
    for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
              "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
              "/opt/google/chrome/google-chrome", "/snap/bin/chromium"):
        if os.path.isfile(p) and os.access(p, os.X_OK): return p
    return None

def sandboxed():
    """Whether this process already runs inside an OS sandbox (macOS: sandbox_check on its own pid). Chrome's own sandbox cannot
    start inside one (it exits 133 there), so only then does the bake start Chrome without it: the outer sandbox still holds
    Chrome, and the guard (no host resolves, every request blocked) and the layout checks are the same. Not macOS, or the
    check not found: False, so Chrome keeps its sandbox and, inside one, fails to start (an error, never a quieter bake)."""
    if sys.platform != "darwin": return False
    try:
        import ctypes
        check = ctypes.CDLL("/usr/lib/libSystem.B.dylib").sandbox_check
        check.restype, check.argtypes = ctypes.c_int, [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        return check(os.getpid(), None, 0) != 0  # SANDBOX_FILTER_NONE: is the process sandboxed at all
    except (OSError, AttributeError): return False

def command(exe, tmp, page, width, inside=None):
    """Chrome's command line for one bake: FLAGS, a fresh profile in the bake's folder, the window, the page; with
    --no-sandbox only when this process is already inside an OS sandbox (`inside`, sandboxed() when not given)."""
    inside = sandboxed() if inside is None else inside
    return [exe, *FLAGS, *(["--no-sandbox"] if inside else []), f"--user-data-dir={os.path.join(tmp, 'profile')}",
            f"--window-size={int(width)},900", "--dump-dom", "file://" + page]

def bake(req):
    exe = chrome()
    if not exe: return {"error": "no Chrome or Chromium to lay the page out in"}
    with tempfile.TemporaryDirectory(prefix="bake-") as tmp:
        page, html = os.path.join(tmp, "page.html"), req["html"]
        at = html.find(CHARSET) + len(CHARSET) if CHARSET in html else (15 if html[:15].lower() == "<!doctype html>" else 0)
        with open(page, "w", encoding="utf-8") as f: f.write(html[:at] + GUARD + checks() + html[at:])
        t0 = time.perf_counter()
        run = subprocess.run(command(exe, tmp, page, req.get("width", 1440)), capture_output=True, timeout=30)
        ms = round((time.perf_counter() - t0) * 1000)
        if run.returncode != 0 or not run.stdout.strip(): return {"error": f"Chrome exited {run.returncode} with no page"}
    dom = run.stdout.decode("utf-8")
    asked = re.findall(r'data-bake-asked="([^"]*)"', dom)
    if asked: return {"error": "the page asked for " + ", ".join(sorted(set(asked))[:5])}
    if not re.search(r'<meta data-bake="1"[^>]*>', dom): return {"error": "the bake guard is not on the laid-out page"}
    if 'data-bake-qa-ran="1"' not in dom: return {"error": "the layout checks did not run on the laid-out page"}
    got = lambda k: [html_unescape(x) for x in re.findall(f'<meta {k}="([^"]*)">', dom)]
    found, lines, hits = got("data-bake-qa"), got("data-bake-lines"), got("data-bake-hits")
    if len(lines) == 1 and len(hits) == 1:
        try: found += line_findings(json.loads(lines[0]), json.loads(hits[0]), got("data-bake-layers"))
        except ValueError as e: return {"error": str(e)}
    elif not found: return {"error": "the line checks left no result on the laid-out page"}
    if found: return {"error": f"the laid-out page has {len(found)} layout finding(s): " + "; ".join(found[:6])}
    dom = re.sub(r'<meta data-bake-(?:qa-ran|lines|hits|layers)="[^"]*">', "", dom)
    dom = re.sub(r'<meta data-bake="1"[^>]*>', "", dom, count=1)
    kept = re.sub(r"<script\b[^>]*>(.*?)</script>", lambda m: m.group(0) if m.group(1) == req["ready"] else "", dom, flags=re.S)
    lead = "<!doctype html>" if req["html"].lstrip()[:15].lower() == "<!doctype html>" else ""
    return {"html": lead + kept, "ms": ms}

if __name__ == "__main__":
    for line in sys.stdin:
        try: out = bake(json.loads(line))
        except Exception as e: out = {"error": f"{type(e).__name__}: {e}"}
        print(json.dumps(out, ensure_ascii=False), flush=True)
