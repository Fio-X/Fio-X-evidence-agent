"""Test leaf for src/next_leaf.rs, the Python twin of echo.mjs: replies with what its knobs say, or hangs or exits;
a page line gets the layers it was sent, the svg ones (`<g` first) in one <svg> and the html ones after it in a <body>, the first
changed as a layer's knobs.page_alter says."""
import html, json, re, sys

ROOT = r"^<(\w+)"
alter = None  # a layer's knobs.page_alter: how the page line changes the first layer it was sent (see changed)
COPY = "<g><text>24%</text></g>"  # a copy of a layer with its number changed


def changed(n, f):
    if alter in ("attr", "own", "other"):
        add = {"attr": ' class="x"', "own": f' data-layer="{n}"', "other": ' data-layer="zz"'}[alter]
        return re.sub(ROOT, lambda m: f"<{m.group(1)}{add}", f, count=1)
    return {"comment": f"<!--{f}-->{COPY}", "template": f"<template>{f}</template>", "twice": f + f, "extra": f + COPY,
            "drop": "", "wrap": f'<g data-layer="{n}">{f}</g>', "moved": f'<g transform="translate(400,0)">{f}</g>',
            "hidden": f'<g style="display:none">{f}</g>', "stranger": f'<g data-layer="zz">{f}</g>'}.get(alter, f)


for line in sys.stdin:
    req = json.loads(line)
    if req.get("phase") == "page":
        frags = [(changed(n, f) if i == 0 else f, f.startswith("<g")) for i, (n, f) in enumerate(req["layers"].items())]
        svg = [f for f, s in frags if s][::-1 if alter == "reverse" else 1]
        page = "<body><svg>" + "".join(svg) + "</svg>" + "".join(f for f, s in frags if not s) + "</body>"
        sys.stdout.write(json.dumps({"html": page}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        continue
    k = req.get("knobs") or {}
    alter = k.get("page_alter", alter)
    if k.get("hang"):
        continue
    if k.get("exit"):
        sys.exit(0)
    if req.get("phase") == "reserve":
        out = {"boxes": k.get("reserve_boxes", []), "lines": k.get("reserve_lines", []), "refused": []}
    else:
        esc = lambda s: html.escape(str(s), quote=True)
        seen = esc(json.dumps(req["panel"]["frame"], separators=(",", ":"), ensure_ascii=False)) if k.get("echo_frame") else ""
        occ = esc(json.dumps(req["occ"], separators=(",", ":"), ensure_ascii=False)) if k.get("echo_occ") else ""
        texts = "".join(f'<text data-src="{esc(t["src"])}">{esc(t["text"])}</text>' for t in k.get("texts", []))
        out = {"html": k["html"], "texts": k.get("texts", [])} if k.get("html") else {
            "svg": f'<g data-layer="{req["layer"]}">{seen}{occ}{k.get("extra_svg", texts)}</g>',
            "texts": k.get("texts", []), "lines": k.get("lines", [])}
        out.update(frame=k.get("frame"), refused=k.get("refused", []), dropped=k.get("dropped", []))
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()
