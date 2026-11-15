"""waffle layer (owner 11-14 16:0x item 2: written anew, only the chart's idea borrowed): one whole as a grid of
100 squares, each part taking as many squares as its share of the whole in hundredths, in rankbar.py's layer style. The
squares are counted by the largest remainder (each part its whole hundredths, then the parts with the largest leftover
fractions one more each until the 100 are used), so the grid always holds exactly 100 and no part's count is off its share
by a whole square or more; the counts are geometry only, never printed. The parts fill the grid row by row from the top
left in layer 1's order; a key beside the grid names each part with its share as printed (layer 1's fact). One accent only
(the highlighted part); the others in grey steps; the rest of the whole (when layer 1 gives it) in the lightest grey.
Every printed number is a ledger entry printed with FX.entry; every name is the request's label marked with its name row.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.waffle, run.py leaf): {
  "title": segs, "unit"?: segs,                     # the head (the unit, when given, once beside the title)
  "part_kind": <kind>,                              # name rows of the parts: name:zh_names:<kind>:<code>
  "whole": series src,                              # the whole's cell (geometry only)
  "parts": [{"code": code, "value": series src, "text": ledger src}],   # its parts in order, each share as printed
  "rest": {"name": segs, "cells": [series src, ...], "text": ledger src}?,  # what the listed parts leave (layer 1's rest)
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
Refuses: no whole or one not above 0, no part, a part twice, a cell the request lacks, a value below 0, parts that do not
add back to the whole within tol, more parts than grey steps, a highlight that is no part, a digit in a literal word, a
text that leaves the picture or overlaps another, a board too narrow for the grid and its key."""

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "waffle"
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), cell=(22, (12, 36, 1), "a square's side in px"),
    gap=(3, (1, 6, 0.5), "space between two squares in px"),
    tol=(0.005, (0.0, 0.02, 0.001), "how far the parts' sum may be from the whole, as a share of it"),
    highlight=("", None, "code of the part drawn in the accent; none = the first part"))

GREYS = ["var(--t-sec)", "var(--bar)", "var(--empty)"]  # the other parts, darkest first; the rest after them in the lightest


def counts(values, total, n=100):
    """Squares per value: each its whole share of n, then one more to the largest leftover fractions (ties: the earlier),
    until exactly n are used."""
    exact = [v / total * n for v in values]
    out = [int(e) for e in exact]
    left = n - sum(out)
    order = sorted(range(len(values)), key=lambda i: (-(exact[i] - out[i]), i))
    for i in order[:left]:
        out[i] += 1
    return out


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        whole = K.val(d.get("whole"))
        if whole <= 0: raise Refused("waffle: the whole is not above 0")
        parts = d.get("parts") or []
        if not parts: raise Refused("waffle: the spec holds no part")
        codes = [p.get("code") for p in parts]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"waffle: the parts' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"waffle: the parts {twice} come twice")
        kind = d.get("part_kind")
        if not isinstance(kind, str) or not kind: raise Refused("waffle: the spec names no part_kind (the parts' name rows)")
        hl = K.check_codes(NODE, k("highlight"), set(codes)) if k("highlight") else {codes[0]}
        if len(hl) > 1: raise Refused("waffle: highlight names one part")
        f.hl = next(iter(hl))
        others = [c for c in codes if c != f.hl]
        if len(others) > len(GREYS) - 1: raise Refused(f"waffle: {len(parts)} parts, more than the {len(GREYS)} steps one accent and its greys can tell apart; fewer parts and a rest")
        f.items = []
        for p in parts:
            v = K.val(p.get("value"))
            if v < 0: raise Refused(f"waffle: part {p['code']} is below 0")
            if not p.get("text"): raise Refused(f"waffle: part {p['code']} has no text (its ledger entry)")
            fill = "var(--accent)" if p["code"] == f.hl else GREYS[others.index(p["code"])]
            f.items.append(dict(code=p["code"], v=v, t=K.ent(p["text"]), name=K.named(p["code"], kind), fill=fill))
        r = d.get("rest")
        if r is not None:
            if not isinstance(r, dict) or not r.get("name") or not r.get("text") or not r.get("cells"): raise Refused("waffle: the rest names no name, cells and text")
            v = sum(K.val(c) for c in r["cells"])
            if v < 0: raise Refused("waffle: the rest is below 0")
            f.items.append(dict(code=None, v=v, t=K.ent(r["text"]), name=None, words=r["name"], fill=GREYS[-1]))
        total = sum(i["v"] for i in f.items)
        if abs(total - whole) > k("tol") * whole:
            raise Refused(f"waffle: the parts add up to {total:g}, the whole is {whole:g} (more than tol apart); a waffle needs parts that add back to the whole")
        for i, c in zip(f.items, counts([i["v"] for i in f.items], total)):
            i["n"] = c
        side = 10 * k("cell") + 9 * k("gap")
        said = lambda segs: "".join(s.get("w") or (FX.text(s["src"]) if s.get("src") else "") for s in segs)
        key_w = max(tw((i["name"][1] if i["name"] else said(i["words"])) + "  " + i["t"][1], f.size) for i in f.items) + 24
        if 8 + side + 24 + key_w > f.W - 8: raise Refused("waffle: the board is too narrow for the grid and its key")
        f.side = side


def cl_waffle(f, occ):
    d, size, W = f.d, f.size, f.W
    cell, gap = f.k("cell"), f.k("gap")
    B = K.Boxes(W, 10 ** 6)
    if d.get("unit"):
        o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    else:
        o = [K.words(B, d["title"], "title", 8, 22, f.k("title_size"), "var(--t-title)", weight=700)[0]]
    top = 22 + size * 2.2
    # the grid: row by row from the top left, the parts in order, each its count of squares
    fills = [i for i in f.items for _ in range(i["n"])]
    for s, it in enumerate(fills):
        row, col = divmod(s, 10)
        x, y = 8 + col * (cell + gap), top + row * (cell + gap)
        dc = f' data-code="{esc(it["code"])}"' if it["code"] else ' data-code="rest"'
        o.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{cell}" height="{cell}" fill="{it["fill"]}"{dc}/>')
    # the key: a swatch, the name and the share as printed, one line per part
    kx, ky = 8 + f.side + 24, top + size
    for i, it in enumerate(f.items):
        y = ky + i * size * 1.8
        hot = it["code"] == f.hl
        o.append(f'<rect x="{kx:.1f}" y="{y - size * 0.8:.1f}" width="{size}" height="{size}" fill="{it["fill"]}"/>')
        val_svg, val = it["t"]
        if it["name"]:
            nm_svg, nm = it["name"]
            o.append(K.txt(B, kx + size + 8, y, size, "var(--accent)" if hot else "var(--t-body)", nm_svg + "  " + val_svg, tw(nm + "  " + val, size),
                           weight=700 if hot else 400, tag=f"key {it['code']}"))
        else:
            svg, box, _ = K.words(B, it["words"], "key rest", kx + size + 8, y, size, "var(--t-body)")
            o.append(svg)
            o.append(K.txt(B, box[2] + tw("  ", size), y, size, "var(--t-body)", val_svg, tw(val, size), tag="key rest value"))
    y = max(top + f.side, ky + len(f.items) * size * 1.8) + size * 0.4
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"waffle: lines is {lns!r}; lines is a list of segment lists")
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


WAFFLE_LAYERS = dict(waffle=(cl_waffle, None))
WAFFLE_SVG = ["waffle"]


def draw(h):
    f = Frame(h)
    inner = cl_waffle(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "waffle"), f.W, f.H
