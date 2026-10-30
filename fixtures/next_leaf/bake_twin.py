"""Test bake for src/next_leaf.rs: drops every script but the ready one like runtime/leaves_py/bake.py, without a browser;
a page holding "<!--tamper-->" comes back with its first 4 changed to 5 or, holding "<!--fail-->", as an error. Its "type" is
what bake.py's type check gives a plain page, every text at or above the floors (one text counted per text between tags)."""
import json, re, sys

def typed(page):
    texts = len([t for t in re.findall(r">([^<]*)<", re.sub(r"<script\b[^>]*>.*?</script>", "", page, flags=re.S)) if t.strip()])
    return {"min_font_px": 12 if texts else None, "min_contrast_body": 12.63 if texts else None, "min_contrast_large": None,
            "texts": texts, "unmeasured": 0, "below": []}

for line in sys.stdin:
    req = json.loads(line)
    page = re.sub(r"<script\b[^>]*>(.*?)</script>", lambda m: m.group(0) if m.group(1) == req["ready"] else "", req["html"], flags=re.S)
    if "<!--tamper-->" in page: page = page.replace("4", "5", 1)
    out = {"error": "the page asked for http://x/"} if "<!--fail-->" in page else {"html": page.replace("<g>", '<g><path d="M0 0"/>'), "ms": 1, "type": typed(page)}
    print(json.dumps(out, ensure_ascii=False), flush=True)
