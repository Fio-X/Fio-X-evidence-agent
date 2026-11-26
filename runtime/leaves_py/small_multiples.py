"""small_multiples layer: one small line chart a member, in a grid, every chart on the same value axis and the same span of
periods, in line.py's layer style. Each cell: the member's name (bold, at the left of its head) and its last value (bold, at
the right), its line over the grid's shared scale with a dot at the end; the whole (when the request has one) as a pale line
behind every cell, and the target (when it has one) as a pale dashed level, both named once in a key over the grid; the first
and last period under the cells that have none below them. One accent: the cells the data names (data "accent"); the others in
ink. The cells' order is a knob (by last value, by change over the span, or as given); the number of cells is a knob too
(6..12, the first ones in that order). The value scale is shared and runs from 0 when no value (the whole's and the target
included) is below 0 and the lowest is at most half the highest, else over the cells' own range; a cell's own scale would make
a flat member look as steep as a climbing one, so none has one. Every printed number is a ledger entry printed with FX.entry;
every word comes with the request as segments; the picture holds no axis number (the unit says what the shared axis measures).

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs, "unit": segs,                      # the measure's name and unit, once, in the head
  "name_kind": "place" | <kind>?,                   # how a cell's name is looked up (default place)
  "cells": [{"code": code,                          # a member; its name is the request's label for the code
             "points": [series src, ...],           # its cells in period order (geometry only), the same periods in every cell
             "last_text": ledger src}],             # its last value as printed
  "periods": [ledger src, ledger src],              # period:<table>:<period> entries of the first and the last point
  "ref": {"code": code, "points": [series src, ...], "label": segs}?,   # the whole: the same periods as the cells
  "target": {"text": ledger src, "scale": number, "label": segs}?,       # the target's value as printed, over the format's scale
  "accent": [code, ...]?,                           # cells drawn in the accent (at most two)
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): the last value of each member,
and the target's value when the key prints it; each with its ledger entry.
needs new wording: none fixed; the names, the key's words and the notes come from the data as segments.
Refuses: fewer than four cells, a cell twice, a code that is no code, a cell with fewer than two points or points out of
period order or twice at one period, cells (or the whole) on different periods, a period entry that is not the first or last
point's, a value below 0 on a scale from 0, a ref that is a cell, an accent that is no cell, a target text that is no number,
a name that does not fit its head (name and last value overlap), a digit in a literal word, a text that leaves the picture or
overlaps another, a board too narrow (a cell under knob min_cell px)."""
import math

import target_path as TP
import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "small_multiples"
CELLS_MIN = 4
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), cols=(0, (0, 6, 1), "cells in a row; 0 = the count 3 to 6 that leaves the fewest empty places in the last row (4 on a tie)"),
    plot_h=(64, (40, 160, 4), "a cell's plot height in px"), max_cells=(12, (6, 12, 1), "cells drawn, the first of the order"),
    sort=("value", ("value", "change", "given"), "cell order: the last value high to low, the change over the span, or as given"),
    line_w=(1.8, (1, 3.5, 0.1), "a cell's line width in px"), gap=(22, (10, 48, 2), "space between two cells in px"),
    min_cell=(150, (110, 300, 10), "the narrowest cell drawn; a narrower board refuses"))


def series_of(src_list, what):
    """[(time, value, period)] of a list of series srcs in period order; fewer than two points, a period twice or out of order refuses."""
    if not isinstance(src_list, list) or len(src_list) < 2: raise Refused(f"small_multiples: {what} has fewer than two points")
    out, seen = [], set()
    for src in src_list:
        per = K.period_of(src); t, v = K.period_at(per), K.val(src)
        if per in seen: raise Refused(f"small_multiples: {what} has two points at {per}")
        if out and t <= out[-1][0]: raise Refused(f"small_multiples: {what}'s points are not in period order at {per}")
        seen.add(per); out.append((t, v, per))
    return out


def auto_cols(n, W, gap, min_cell):
    """The cells in a row (3 to 6, as many as keep each cell min_cell wide) that leave the fewest empty places in the last row; a tie
    takes the count nearest 4; none wide enough: the narrowest board's count, which the width check then refuses."""
    ok = [c for c in range(3, 7) if (W - 16 - (c - 1) * gap) / c >= min_cell and c <= max(n, 3)] or [3]
    return min(ok, key=lambda c: (-n % c if n >= c else c, abs(c - 4)))


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        kind = d.get("name_kind", "place")
        cells = d.get("cells")
        if not isinstance(cells, list) or len(cells) < CELLS_MIN: raise Refused(f"small_multiples: the spec holds fewer than {CELLS_MIN} cells")
        codes = [c.get("code") if isinstance(c, dict) else None for c in cells]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"small_multiples: the cells' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"small_multiples: the cells {twice} come twice")
        K.segs(d.get("title"), "title"); K.segs(d.get("unit"), "unit")
        f.cells = []
        for c in cells:
            pts = series_of(c.get("points"), f"cell {c['code']}")
            if not c.get("last_text"): raise Refused(f"small_multiples: cell {c['code']} has no last_text (the ledger entry its last value prints from)")
            FX.text(c["last_text"])
            f.cells.append(dict(c, pts=pts, _n=K.named(c["code"], kind)))
        span = [p for _, _, p in f.cells[0]["pts"]]
        for c in f.cells:
            if [p for _, _, p in c["pts"]] != span: raise Refused(f"small_multiples: cell {c['code']} is on other periods than the first cell's")
        per = d.get("periods")
        if not isinstance(per, list) or len(per) != 2: raise Refused("small_multiples: periods needs the first and the last period entries")
        for src, want in zip(per, (span[0], span[-1])):
            if not isinstance(src, str) or not src.startswith("period:") or src.rsplit(":", 1)[1] != want:
                raise Refused(f"small_multiples: the period entry {src!r} is not the cells' period {want}")
        f.per = [K.ent(s) for s in per]
        f.t0, f.t1 = f.cells[0]["pts"][0][0], f.cells[0]["pts"][-1][0]
        # the order, then the cells kept
        by = k("sort")
        if by == "value": f.cells.sort(key=lambda c: (-c["pts"][-1][1], c["code"]))
        elif by == "change": f.cells.sort(key=lambda c: (-(c["pts"][-1][1] - c["pts"][0][1]), c["code"]))
        f.cells = f.cells[:int(k("max_cells"))]
        if len(f.cells) < CELLS_MIN: raise Refused(f"small_multiples: knob max_cells keeps fewer than {CELLS_MIN} cells")
        keep = {c["code"] for c in f.cells}
        acc = d.get("accent") or []
        if not isinstance(acc, list) or len(acc) > 2 or not all(isinstance(a, str) for a in acc): raise Refused("small_multiples: accent is a list of at most two codes")
        f.acc = {a for a in acc if a in keep}
        if any(a not in codes for a in acc): raise Refused(f"small_multiples: accent names {[a for a in acc if a not in codes]}, no cell")
        # the whole and the target
        f.ref = None
        ref = d.get("ref")
        if ref is not None:
            rc = ref.get("code") if isinstance(ref, dict) else None
            if not isinstance(rc, str) or not K.CODE.fullmatch(rc) or rc in codes: raise Refused(f"small_multiples: the ref's code {rc!r} is no code or is a cell")
            rp = series_of(ref.get("points"), "the ref")
            if [p for _, _, p in rp] != span: raise Refused("small_multiples: the ref is on other periods than the cells")
            K.segs(ref.get("label"), "the ref's label")
            f.ref = dict(ref, pts=rp)
        f.target = None
        tg = d.get("target")
        if tg is not None:
            scale = tg.get("scale") if isinstance(tg, dict) else None
            if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not scale > 0: raise Refused(f"small_multiples: the target's scale {scale!r} is no number above 0")
            K.segs(tg.get("label"), "the target's label")
            f.target = dict(tg, v=TP.number(tg["text"], scale, "the target"))
        vals = [v for c in f.cells for _, v, _ in c["pts"]] + ([v for _, v, _ in f.ref["pts"]] if f.ref else []) + ([f.target["v"]] if f.target else [])
        f.lo_v, f.hi_v = min(vals), max(vals)
        zero = f.lo_v >= 0 and f.lo_v <= f.hi_v / 2
        f.base = 0.0 if zero else f.lo_v - 0.1 * ((f.hi_v - f.lo_v) or abs(f.lo_v) or 1)
        if f.hi_v <= f.base: f.hi_v = f.base + 1
        n = len(f.cells)
        f.cols = min(int(k("cols")), n) if k("cols") else auto_cols(n, f.W, k("gap"), k("min_cell"))
        f.cw = (f.W - 16 - (f.cols - 1) * k("gap")) / f.cols
        if f.cw < k("min_cell"): raise Refused(f"small_multiples: the board is too narrow for {f.cols} cells in a row (a cell under {k('min_cell')} px)")
        f.H = 0

    def x(f, col, t):
        return 8 + col * (f.cw + f.k("gap")) + 4 + (f.cw - 8) * (t - f.t0) / (f.t1 - f.t0)


def cl_small_multiples(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = []
    ph, gap = f.k("plot_h"), f.k("gap")
    o.append(K.head(B, d["title"], d["unit"], size, f.k("title_size")))
    y = 22 + size * 1.9
    key_x = 8
    if f.ref or f.target:  # the key: a pale line and the whole's words, a dashed level and the target's words
        if f.ref:
            o.append(K.line(key_x, y - size * 0.3, key_x + size * 2, y - size * 0.3, stroke="var(--t-sec)", w=2, op=0.55))
            svg_l, tb, _ = K.words(B, f.ref["label"], "the ref's label", key_x + size * 2.5, y, size, "var(--t-sec)", max_w=W / 2 - 40)
            o.append(svg_l); key_x = tb[2] + size * 1.6
        if f.target:
            o.append(f'<line x1="{key_x:.1f}" y1="{y - size * 0.3:.1f}" x2="{key_x + size * 2:.1f}" y2="{y - size * 0.3:.1f}" stroke="var(--t-sec)" stroke-width="1.2" stroke-dasharray="4 3" stroke-opacity="0.7"/>')
            o.append(K.words(B, f.target["label"], "the target's label", key_x + size * 2.5, y, size, "var(--t-sec)", max_w=W - key_x - size * 3 - 8)[0])
        y += size * 1.2
    head_h = size * 1.7
    row_h = head_h + ph + size * 1.7 + 10
    n, cols = len(f.cells), f.cols
    rows = math.ceil(n / cols)
    yv = lambda top, v: top + ph - ph * (v - f.base) / (f.hi_v - f.base)
    for i, c in enumerate(f.cells):
        r, col = divmod(i, cols)
        x0 = 8 + col * (f.cw + gap)
        y0 = y + r * row_h
        hot = c["code"] in f.acc
        # the head: the name at the left, the last value at the right
        base_y = y0 + size * 1.05
        lt = FX.text(c["last_text"]); lw = tw(lt, size)
        o.append(K.txt(B, x0 + f.cw, base_y, size, "var(--accent)" if hot else "var(--t-title)", FX.entry(c["last_text"], "tspan", None), lw,
                       anchor="end", weight=700, tag=f"cell {c['code']} last value"))
        o.append(K.txt(B, x0, base_y, size, "var(--t-title)", c["_n"][0], tw(c["_n"][1], size), weight=700, tag=f"cell {c['code']} name"))
        top = y0 + head_h
        bottom = top + ph
        o.append(K.line(x0, bottom, x0 + f.cw, bottom, stroke="var(--t-title)", w=0.8, op=1))
        if f.target:
            ty = yv(top, f.target["v"])
            o.append(f'<line x1="{x0:.1f}" y1="{ty:.1f}" x2="{x0 + f.cw:.1f}" y2="{ty:.1f}" stroke="var(--t-sec)" stroke-width="1.2" '
                     f'stroke-dasharray="4 3" stroke-opacity="0.7" data-part="target"/>')
        if f.ref:
            line = " ".join(f"{f.x(col, t):.1f},{yv(top, v):.1f}" for t, v, _ in f.ref["pts"])
            o.append(f'<polyline points="{line}" fill="none" stroke="var(--t-sec)" stroke-opacity="0.55" stroke-width="2" stroke-linejoin="round" '
                     f'stroke-linecap="round" data-part="ref"/>')
        ink = "var(--accent)" if hot else "var(--t-body)"
        line = " ".join(f"{f.x(col, t):.1f},{yv(top, v):.1f}" for t, v, _ in c["pts"])
        o.append(f'<polyline points="{line}" fill="none" stroke="{ink}" stroke-width="{f.k("line_w")}" stroke-linejoin="round" '
                 f'stroke-linecap="round" data-code="{esc(c["code"])}"/>')
        t, v, _ = c["pts"][-1]
        o.append(f'<circle cx="{f.x(col, t):.1f}" cy="{yv(top, v):.1f}" r="3" fill="{ink}" data-code="{esc(c["code"])}"/>')
        # the first and the last period under a cell with no cell below it
        if i + cols >= n:
            (a_svg, a_t), (b_svg, b_t) = f.per
            o.append(K.txt(B, x0, bottom + size * 1.3, size, "var(--t-sec)", a_svg, tw(a_t, size), tag=f"cell {c['code']} first period"))
            o.append(K.txt(B, x0 + f.cw, bottom + size * 1.3, size, "var(--t-sec)", b_svg, tw(b_t, size), anchor="end", tag=f"cell {c['code']} last period"))
    y += rows * row_h
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"small_multiples: lines is {lns!r}; lines is a list of segment lists")
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


SMALL_MULTIPLES_LAYERS = dict(small_multiples=(cl_small_multiples, None))
SMALL_MULTIPLES_SVG = ["small_multiples"]


def draw(h):
    f = Frame(h)
    inner = cl_small_multiples(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "small_multiples"), f.W, f.H
