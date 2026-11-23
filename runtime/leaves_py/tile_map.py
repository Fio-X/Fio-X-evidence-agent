"""tile_map layer: a map in which every member is one tile of the same size, laid on a grid so that the tiles keep their
neighbours' directions (north stays above, east to the right), each tile filled by its value in one of five steps of the accent,
in member_map.py's layer style. A small country is as big as a large one: the picture answers "north or south, east or west"
for members whose outlines a map would make invisible. The grid is worked out here from the members' points (one [lon, lat] a
member, inside its country; the request's "points", the same the map leaf reads): the points are projected with the cosine of
the middle latitude, stretched over a grid whose columns and rows are the ones that keep every tile nearest its point (the
count of empty places is the other thing counted), and the members are assigned to the grid's places by the assignment that
makes the squared distances least (Hungarian method; a tie is broken by code, so the same members always make the same grid).
A tile prints the member's name and its value; the text on a tile is the ink on a light fill and white on the darkest step.
One legend: the five steps with the lowest value printed at its left end and the highest at its right. Every printed number
is a ledger entry printed with FX.entry; every name is the request's label marked with its name row; the picture holds no
number of its own (the steps' edges are not printed).

hero.data (the data shape this leaf eats; on a story page, the hero's leaves.tile_map, run.py leaf): {
  "title": segs, "unit": segs,                      # the measure's name and unit, once, in the head
  "name_kind": "place" | <kind>?,                   # how a name is looked up (default place)
  "cells": [{"code": code,                          # a member; its name is the request's label for the code
             "at": [lon, lat],                      # one point inside the member's country (layer 1 reads it from the attributes table)
             "value": series src,                   # its value (geometry only: the colour step)
             "text": ledger src}],                  # its value as printed, in its tile
  "ends": {"lo": ledger src, "hi": ledger src},     # the lowest and the highest member's value as printed (the legend's ends)
  "footnote": segs?}                                # layer 1's line under the picture
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): each member's value.
needs new wording: none fixed; the names, the head and the footnote come from the data as segments.
Refuses: fewer than four cells, a cell twice, a code that is no code, a point off the globe, two cells at one point, a value that
is no series cell, a cell with no value text, ends that are no ledger entries or are not the lowest and the highest members'
texts, every member holding one value, a name too wide for its tile, a digit in a literal word, a text that leaves the picture
or overlaps another, a board too narrow (under 300 px)."""
import math

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "tile_map"
CELLS_MIN = 4
BINS = 5
EMPTY_COST = 0.05      # what the empty places of a grid cost, per member, against the mean squared distance (as a share of the points' own extent) a member sits from its place
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (300, 1400, 10), "picture width in px"), gap=(3, (1, 8, 1), "space between two tiles in px"),
    tile_h=(44, (36, 80, 2), "a tile's height in px"), max_w=(84, (60, 200, 2), "the widest a tile is drawn in px"))


def assign(cost):
    """The assignment of rows to columns (rows <= columns) of least total cost, as the column of each row (the Hungarian method,
    shortest augmenting paths); the same matrix always gives the same answer."""
    n, m = len(cost), len(cost[0])
    inf = float("inf")
    u, v, p, way = [0.0] * (n + 1), [0.0] * (m + 1), [0] * (m + 1), [0] * (m + 1)
    for i in range(1, n + 1):
        p[0] = i; j0 = 0
        minv, used = [inf] * (m + 1), [False] * (m + 1)
        while True:
            used[j0] = True
            i0, delta, j1 = p[j0], inf, 0
            for j in range(1, m + 1):
                if used[j]: continue
                cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                if cur < minv[j]: minv[j], way[j] = cur, j0
                if minv[j] < delta: delta, j1 = minv[j], j
            for j in range(m + 1):
                if used[j]: u[p[j]] += delta; v[j] -= delta
                else: minv[j] -= delta
            j0 = j1
            if p[j0] == 0: break
        while True:
            j1 = way[j0]; p[j0] = p[j1]; j0 = j1
            if j0 == 0: break
    out = [0] * n
    for j in range(1, m + 1):
        if p[j]: out[p[j] - 1] = j - 1
    return out


def grid_for(points, room, max_w, th, gap):
    """(columns, rows, [(col, row) of each point]) of the grid that keeps the tiles nearest their points: the points projected with the
    cosine of the middle latitude and stretched over the grid; the columns and rows searched are those holding every point whose
    drawn shape (tiles at most max_w wide in `room` px, th high, gap between) is within 0.4 to 2.6 times the points' own (a tile is wider than high); the least mean
    squared distance, as a share of the points' extent, plus EMPTY_COST a member's share of empty places (so a finer grid is no better
    for being finer), the shape nearest the points' as the tie-break. A tie among the points is broken by their order (the caller sorts them by code)."""
    n = len(points)
    lats = [p[1] for p in points]
    kx = math.cos(math.radians((min(lats) + max(lats)) / 2))
    xs, ys = [p[0] * kx for p in points], [-p[1] for p in points]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    sx, sy = (x1 - x0) or 1.0, (y1 - y0) or 1.0
    best = None
    for cols in range(2, n + 1):
        for rows in range(2, n + 1):
            if cols * rows < n or cols * rows > 2 * n + 2: continue
            tile_w = min(max_w, (room - (cols - 1) * gap) / cols)
            if tile_w < 20: continue
            shape = (cols * (tile_w + gap)) / (rows * (th + gap)) / (sx / sy)
            if not 0.4 <= shape <= 2.6: continue
            gx = [(x - x0) / sx * (cols - 1) for x in xs]; gy = [(y - y0) / sy * (rows - 1) for y in ys]
            cost = [[((gx[i] - c) / (cols - 1)) ** 2 + ((gy[i] - r) / (rows - 1)) ** 2 for r in range(rows) for c in range(cols)] for i in range(n)]
            pick = assign(cost)
            total = sum(cost[i][j] for i, j in enumerate(pick)) / n
            key = (round(total + EMPTY_COST * (cols * rows - n) / n, 6), abs(math.log(shape)))
            if best is None or key < best[0]: best = (key, cols, rows, [(j % cols, j // cols) for j in pick])
    if best is None: raise Refused(f"tile_map: no grid of {n} tiles keeps the points' shape")
    return best[1], best[2], best[3]


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        kind = d.get("name_kind", "place")
        K.segs(d.get("title"), "title"); K.segs(d.get("unit"), "unit")
        cells = d.get("cells")
        if not isinstance(cells, list) or len(cells) < CELLS_MIN: raise Refused(f"tile_map: the spec holds fewer than {CELLS_MIN} cells")
        codes = [c.get("code") if isinstance(c, dict) else None for c in cells]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"tile_map: the cells' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"tile_map: the cells {twice} come twice")
        f.cells = []
        for c in sorted(cells, key=lambda c: c["code"]):
            at = c.get("at")
            if not (isinstance(at, list) and len(at) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in at) and -180 <= at[0] <= 180 and -90 <= at[1] <= 90):
                raise Refused(f"tile_map: cell {c['code']}'s point {at!r} is no [lon, lat] on the globe")
            if not c.get("text"): raise Refused(f"tile_map: cell {c['code']} has no value text (the ledger entry its tile prints)")
            FX.text(c["text"])
            f.cells.append(dict(c, _v=K.val(c.get("value")), _n=K.named(c["code"], kind), at=tuple(at)))
        pts = [c["at"] for c in f.cells]
        if len(set(pts)) != len(pts): raise Refused("tile_map: two cells lie at one point")
        f.lo_v, f.hi_v = min(c["_v"] for c in f.cells), max(c["_v"] for c in f.cells)
        if f.hi_v == f.lo_v: raise Refused("tile_map: every member holds one value (nothing to fill by)")
        ends = d.get("ends")
        if not (isinstance(ends, dict) and ends.get("lo") and ends.get("hi")): raise Refused("tile_map: ends needs the lowest's and the highest's value entries")
        for key in ("lo", "hi"): FX.text(ends[key])
        for key, v in (("lo", f.lo_v), ("hi", f.hi_v)):
            if not any(c.get("text") == ends[key] and c["_v"] == v for c in f.cells):
                raise Refused(f"tile_map: the {key} end {ends[key]!r} is not the text of the member holding the {key}est value")
        if f.W < 300: raise Refused("tile_map: the board is too narrow")
        gap, th = k("gap"), k("tile_h")
        f.cols, f.rows, f.at = grid_for(pts, f.W - 16, k("max_w"), th, gap)
        f.tw = min(k("max_w"), (f.W - 16 - (f.cols - 1) * gap) / f.cols)
        f.th = th
        need = max(tw(c["_n"][1], f.size) for c in f.cells) + 8
        if f.tw < need: raise Refused(f"tile_map: a name is too wide for its tile ({need:.0f} px wanted, {f.tw:.0f} px a tile)")
        f.ox = (f.W - (f.cols * f.tw + (f.cols - 1) * gap)) / 2
        f.H = 0


def cl_tile_map(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size + 1, f.k("title_size"))]
    ramp = [f"color-mix(in srgb, var(--accent) {p}%, #eeeeec)" for p in (10, 28, 46, 64)] + ["var(--accent)"]
    span = f.hi_v - f.lo_v
    step = lambda v: max(0, min(BINS - 1, int((v - f.lo_v) / span * BINS)))
    ly = 22 + size * 1.9
    lo_t, hi_t = K.ent(d["ends"]["lo"]), K.ent(d["ends"]["hi"])
    sw = 28; lx = 8
    o.append(K.txt(B, lx, ly + size * 0.8, size, "var(--t-sec)", lo_t[0], tw(lo_t[1], size), tag="legend low"))
    sx = lx + tw(lo_t[1], size) + 8
    for b in range(BINS): o.append(f'<rect x="{sx + b * sw:.1f}" y="{ly - 2:.1f}" width="{sw}" height="{size}" fill="{ramp[b]}" data-part="legend"/>')
    o.append(K.txt(B, sx + BINS * sw + 8, ly + size * 0.8, size, "var(--t-sec)", hi_t[0], tw(hi_t[1], size), tag="legend high"))
    top = ly + size * 2.2
    gap = f.k("gap")
    for c, (col, row) in zip(f.cells, f.at):
        s = step(c["_v"])
        x, y = f.ox + col * (f.tw + gap), top + row * (f.th + gap)
        o.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{f.tw:.1f}" height="{f.th}" rx="2" fill="{ramp[s]}" data-code="{esc(c["code"])}" data-step="{s}"/>')
        ink = "var(--bg)" if s == BINS - 1 else "var(--t-dark)"
        t_svg, t_txt = K.ent(c["text"])
        cx = x + f.tw / 2
        o.append(K.txt(B, cx, y + f.th * 0.42, size, ink, c["_n"][0], tw(c["_n"][1], size), anchor="middle", weight=700, tag=f"tile {c['code']} name"))
        o.append(K.txt(B, cx, y + f.th * 0.8, size, ink, t_svg, tw(t_txt, size), anchor="middle", tag=f"tile {c['code']} value"))
    y = top + f.rows * (f.th + gap) + 4
    if d.get("footnote"):
        y += size * 1.2
        o.append(K.words(B, d["footnote"], "footnote", 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 10); B.h = f.H
    for (bx0, by0, bx1, by1), tag in B.b:
        if by1 > f.H + 0.5 or bx0 < -0.5 or bx1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


TILE_MAP_LAYERS = dict(tile_map=(cl_tile_map, None))
TILE_MAP_SVG = ["tile_map"]


def draw(h):
    f = Frame(h)
    inner = cl_tile_map(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "tile_map"), f.W, f.H
