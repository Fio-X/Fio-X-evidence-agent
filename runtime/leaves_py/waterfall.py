"""waterfall layer (owner 11-14 16:0x item 2: written anew, only the chart's idea borrowed): a whole and the parts it is
made of, top down, in rankbar.py's layer style. The first row is the whole as one bar from 0; each later row is one part,
a bar starting where the part before it ended, so the parts walk the whole's length from left to right and the last one
ends at the whole's end; a thin dashed connector joins each step's end to the next step's start. The parts must add up to
the whole (owner: a waterfall is not drawn when the parts do not add back to the total): their sum may differ from the
whole by at most `tol` of it, else the leaf refuses; the rest of the whole the listed parts leave is its own last row only
when layer 1 gives it (a rest fact), never made up here. One accent only (the highlighted part); every other part grey.
Every printed number is a ledger entry printed with FX.entry; every name is the request's label marked with its name row.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.waterfall, run.py leaf): {
  "title": segs, "unit": segs,                      # the unit is written once, in the head
  "part_kind": <kind>,                              # name rows of the parts: name:zh_names:<kind>:<code>
  "whole": {"name": segs, "value": series src, "text": ledger src},  # the whole's row (its bar from 0)
  "parts": [{"code": code, "value": series src, "text": ledger src}],  # top down, in layer 1's order (the leaf sorts nothing);
                                                    # "cells": [series src, ...] in place of value: a part of several rows
  # or stacked100's shape with one bar (one_bar: the waterfall node is declared as stacked100 is)
  "rest": {"name": segs, "cells": [series src, ...], "text": ledger src}?,  # what the listed parts leave (layer 1's rest fact)
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
Note (_share_note): one line under the steps, the largest part's share above the second's (data-cmp next, in g[data-notes]), only where
the shares' ledger values order the first two strictly and print them apart and the core's comparison (knobs.comparisons) names the
same two share facts as first and second; else none. It uses the word table's existing words.
Refuses: no whole, fewer than two parts, a part twice, a cell the request lacks, a value below 0, parts that do not add up to
the whole within tol, a highlight that is no part, a digit in a literal word, a text that leaves the picture or overlaps
another, a board too narrow (plot under 240 px)."""

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "waterfall"
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), bar_h=(18, (12, 30, 1), "bar height in px"),
    pitch=(28, (18, 44, 1), "distance between two bars' tops in px"),
    tol=(0.005, (0.0, 0.02, 0.001), "how far the parts' sum may be from the whole, as a share of it"),
    highlight=("", None, "code of the part drawn in the accent; none = the first part"))


def one_bar(d):
    """stacked100's data shape (stacked100.py hero.data) with one bar, read as one whole: the waterfall node is declared as
    stacked100 is (node-bindings.json declares_as), the same rows and checks. The bar's total is the whole, named by the
    total's head (its name row) and printed by its total text; each part the bar draws is a step of its cells, its share as
    printed its text; a part with no row or a declared zero (layer 1 says it in a line) draws no step and adds nothing.
    Anything else is the data shape as given."""
    if "bars" not in d: return d
    bars = d.get("bars") or []
    if len(bars) != 1: raise Refused(f"waterfall: {len(bars)} bars; one whole is one place's (two places or more: stacked100)")
    if (d.get("others") or {}).get("codes"): raise Refused("waterfall: places left out beside one whole; a waterfall draws one place")
    b = bars[0]
    if not d.get("total_head") or not b.get("total_text"): raise Refused("waterfall: the bar names or prints no total (its whole)")
    gone = {e.get("part") for e in d.get("empty") or []} | {z.get("part") for z in d.get("zero") or []}
    parts = []
    for c in d.get("parts") or []:
        if c in gone: continue
        cells, text = (b.get("cells") or {}).get(c), (b.get("share_text") or {}).get(c)
        if not cells or not text: raise Refused(f"waterfall: part {c} has no cells or no printed share")
        parts.append({"code": c, "cells": cells, "text": text})
    out = {k: d[k] for k in ("title", "unit", "part_kind", "lines", "footnote") if k in d}
    out.update(whole={"name": d["total_head"], "value": b["total"], "text": b["total_text"]}, parts=parts)
    return out


class Frame:
    def __init__(f, h):
        h = dict(h, data=one_bar(h["data"]))
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        w = d.get("whole")
        if not isinstance(w, dict) or not w.get("name") or not w.get("text"): raise Refused("waterfall: the spec holds no whole (name, value, text)")
        f.whole = K.val(w.get("value"))
        if f.whole <= 0: raise Refused("waterfall: the whole is not above 0")
        f.whole_t = K.ent(w["text"])
        parts = d.get("parts") or []
        if len(parts) < 2: raise Refused("waterfall: the spec holds fewer than two parts")
        codes = [p.get("code") for p in parts]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"waterfall: the parts' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"waterfall: the parts {twice} come twice")
        kind = d.get("part_kind")
        if not isinstance(kind, str) or not kind: raise Refused("waterfall: the spec names no part_kind (the parts' name rows)")
        f.parts = []
        for p in parts:
            cells = p.get("cells")
            if cells is not None and (not isinstance(cells, list) or not cells): raise Refused(f"waterfall: part {p.get('code')}'s cells are not a list of cells")
            v = sum(K.val(c) for c in cells) if cells is not None else K.val(p.get("value"))  # a part of several rows: their sum
            if v < 0: raise Refused(f"waterfall: part {p['code']} is below 0")
            if not p.get("text"): raise Refused(f"waterfall: part {p['code']} has no text (its ledger entry)")
            f.parts.append(dict(code=p["code"], v=v, t=K.ent(p["text"]), src=p["text"], name=K.named(p["code"], kind)))
        f.rest = None
        r = d.get("rest")
        if r is not None:
            if not isinstance(r, dict) or not r.get("name") or not r.get("text") or not r.get("cells"): raise Refused("waterfall: the rest names no name, cells and text")
            v = sum(K.val(c) for c in r["cells"])
            if v < 0: raise Refused("waterfall: the rest is below 0")
            f.rest = dict(v=v, t=K.ent(r["text"]), name=r["name"])
        total = sum(p["v"] for p in f.parts) + (f.rest["v"] if f.rest else 0)
        if abs(total - f.whole) > k("tol") * f.whole:
            raise Refused(f"waterfall: the parts add up to {total:g}, the whole is {f.whole:g} (more than tol apart); a waterfall needs parts that add back to the whole")
        hl = K.check_codes(NODE, k("highlight"), set(codes)) if k("highlight") else {codes[0]}
        if len(hl) > 1: raise Refused("waterfall: highlight names one part")
        f.hl = next(iter(hl))
        size = f.size
        said = lambda segs: "".join(s.get("w") or (FX.text(s["src"]) if s.get("src") else "") for s in segs)  # as printed
        name_w = max([tw(p["name"][1], size) for p in f.parts] + [tw(said(w["name"]), size)] + ([tw(said(f.rest["name"]), size)] if f.rest else []))
        val_w = max(tw(t, size) for _, t in [f.whole_t] + [p["t"] for p in f.parts] + ([f.rest["t"]] if f.rest else []))
        f.x0 = 8 + name_w + 12
        f.x1 = f.W - 8 - val_w - 8
        if f.x1 - f.x0 < 240: raise Refused("waterfall: the board is too narrow for the names, the values and the bars (plot under 240 px)")
        f.name_x, f.wd = 8 + name_w, w

    def x(f, v):
        return f.x0 + (f.x1 - f.x0) * v / max(f.whole, sum(p["v"] for p in f.parts) + (f.rest["v"] if f.rest else 0))


def _key(src):
    """The fact key a ledger src prints (fact:<k>, its .n or .r part)."""
    k = src.removeprefix("fact:")
    return k[:-2] if k.endswith((".n", ".r")) else k


def _share_note(f):
    """(segs, (relation, a_src, b_src)) of the note under the steps, or None (no note; the page is drawn all the same): the
    largest part's share above the second's (wbkit.finding_side_top over the parts, each share's value the number of its
    fact's bare ledger entry, never a sum of cells), each printing differently, at least two parts, each from its own share
    entry; and only where the core's comparison of that share (wbkit.compared) names the same two facts as first and second
    (the parts of one whole are compared by their facts: the core's set is the parts and the rest they leave). The words are
    the word table's own (the note column's above and paren); a note that does not fit the width is left out."""
    nodes = []
    for p in f.parts:
        try: nodes.append((p["code"], float(FX.text(p["src"].removesuffix(".r").removesuffix(".n") + ".n").replace(",", "")), p["src"]))
        except (Refused, ValueError): return None
    top = K.finding_side_top(nodes) if len(nodes) >= 2 and len({n[2] for n in nodes}) == len(nodes) else None
    if not top: return None
    (a, _, a_src), (b, _, b_src) = top
    c = K.compared(a_src)
    if not c or c.get("scoped") or (c.get("first"), c.get("second")) != (_key(a_src), _key(b_src)): return None
    kind = f.d["part_kind"]
    nm = lambda code: {"name": code, "kind": kind}
    segs = [nm(a), {"w": " "}, {"src": a_src, "bold": True}] + K._finding_word(K.FINDING_WORDS["above"]) + \
        K._finding_word(K.FINDING_WORDS["paren"], v=[nm(b), {"w": " "}, {"src": b_src, "bold": True}])
    if tw(K.finding_plain(segs), f.size) > f.W - 16: return None
    return segs, (K.FINDING_RELATION["note"], a_src, b_src)


def cl_waterfall(f, occ):
    d, size, W = f.d, f.size, f.W
    bh, pitch = f.k("bar_h"), f.k("pitch")
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    top = 22 + size * 2.2
    rows = [("whole", f.wd["name"], 0.0, f.whole, f.whole_t, "var(--t-title)", None)]
    at = 0.0
    for p in f.parts:
        hot = p["code"] == f.hl
        rows.append((p["code"], p["name"], at, p["v"], p["t"], "var(--accent)" if hot else "var(--bar)", p["code"]))
        at += p["v"]
    if f.rest:
        rows.append(("rest", f.rest["name"], at, f.rest["v"], f.rest["t"], "var(--empty)", None))
    prev_end = None
    for i, (key, name, start, v, (val_svg, val_txt), fill, code) in enumerate(rows):
        y = top + i * pitch
        mid = y + bh / 2 + size * 0.35
        hot = code == f.hl
        tag = f"name {key}"
        if isinstance(name, tuple):  # a part: its name row
            nm_svg, nm = name
            o.append(K.txt(B, f.name_x, mid, size, "var(--accent)" if hot else "var(--t-body)", nm_svg, tw(nm, size), anchor="end", weight=700 if hot else 400, tag=tag))
        else:  # the whole's or the rest's own words
            o.append(K.words(B, name, tag, f.name_x, mid, size, "var(--t-body)", anchor="end", weight=700 if key == "whole" else 400)[0])
        x0, x1 = f.x(start), f.x(start + v)
        dc = f' data-code="{esc(code)}"' if code else ""
        o.append(f'<rect x="{x0:.1f}" y="{y:.1f}" width="{max(x1 - x0, 0.5):.1f}" height="{bh}" fill="{fill}"{dc}/>')
        if prev_end is not None:  # the dashed step from the bar above's end down to this bar's start
            o.append(f'<line x1="{prev_end:.1f}" y1="{y - pitch + bh:.1f}" x2="{prev_end:.1f}" y2="{y:.1f}" stroke="var(--t-sec)" stroke-width="0.8" stroke-dasharray="2 2"/>')
        prev_end = x1 if key != "whole" else f.x0
        o.append(K.txt(B, x1 + 6, mid, size, "var(--accent)" if hot else "var(--t-body)", val_svg, tw(val_txt, size), weight=700 if hot or key == "whole" else 400,
                       tag=f"value {key}"))
    y = top + len(rows) * pitch + size * 0.4
    note = _share_note(f)
    if note:  # one short note under the steps, marked for the page's comparison check (data-cmp)
        segs, (rel, a_src, b_src) = note; y += size * 1.5
        mark = f' data-cmp="{rel}" data-a="{esc(a_src)}" data-b="{esc(b_src)}"'
        o.append('<g data-notes="share">' + K.txt(B, 8, y, size, "var(--t-title)", K.finding_html(segs), tw(K.finding_plain(segs), size),
                                                   tag="note", style=mark) + "</g>")
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"waterfall: lines is {lns!r}; lines is a list of segment lists")
    for i, ln in enumerate(lns):
        y += size * 1.5
        o.append(K.words(B, ln, f"line {i + 1}", 8, y, size, "var(--t-sec)", max_w=W - 16)[0])
    if d.get("footnote"):
        y += size * 1.5
        o.append(K.words(B, d["footnote"], "footnote", 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


WATERFALL_LAYERS = dict(waterfall=(cl_waterfall, None))
WATERFALL_SVG = ["waterfall"]


def draw(h):
    f = Frame(h)
    inner = cl_waterfall(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "waterfall"), f.W, f.H
