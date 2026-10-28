"""Test leaf for src/next_leaf.rs, the Python twin of echo.mjs: replies with what its knobs say, or hangs or exits."""
import html, json, sys

for line in sys.stdin:
    req = json.loads(line)
    k = req.get("knobs") or {}
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
