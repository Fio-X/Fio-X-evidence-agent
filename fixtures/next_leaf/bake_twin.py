"""Test bake for src/next_leaf.rs: drops every script but the ready one like runtime/leaves_py/bake.py, without a browser;
a page holding "<!--tamper-->" comes back with its first 4 changed to 5 or, holding "<!--fail-->", as an error."""
import json, re, sys

for line in sys.stdin:
    req = json.loads(line)
    page = re.sub(r"<script\b[^>]*>(.*?)</script>", lambda m: m.group(0) if m.group(1) == req["ready"] else "", req["html"], flags=re.S)
    if "<!--tamper-->" in page: page = page.replace("4", "5", 1)
    out = {"error": "the page asked for http://x/"} if "<!--fail-->" in page else {"html": page.replace("<g>", '<g><path d="M0 0"/>'), "ms": 1}
    print(json.dumps(out, ensure_ascii=False), flush=True)
