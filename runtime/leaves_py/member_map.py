"""member_map layer: a map in which every member the data places is filled by its value, in line.py's layer style: the
countries' outlines in light grey (the request's Natural Earth file, geo.NE), each member's country filled in one of five
steps of the accent (lowest to highest of the members drawn; equal bins over that range), a legend of the five steps with
the lowest and the highest value printed at its ends, and a short call-out for each member that carries a value text: a dot
at its point, a leader to the left or right margin, its name and its value. A member is matched to the country whose outline
holds its point. The map keeps the frame's aspect: the extent is the members' points with a margin, never wider than the globe.
Every printed number is a ledger entry printed with FX.entry; every word comes with the request as segments or is a name
row; the picture holds no number of its own (the bins' edges are not printed: the legend names its two ends only).

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs, "unit": segs,                      # the measure's name and unit, once, in the head
  "name_kind": "place" | <kind>?,                   # how a name is looked up (default place)
  "cells": [{"code": code,                          # a member; its name is the request's label for the code
             "at": [lon, lat],                      # one point inside the member's country (layer 1 reads it from the attributes table)
             "value": series src,                   # its value (geometry only: the colour step)
             "text": ledger src?}],                 # its value as printed; the member gets a call-out only with one
  "ends": {"lo": ledger src, "hi": ledger src},     # the lowest and the highest member's value as printed (the legend's ends)
  "footnote": segs?}                                # layer 1's line under the picture
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): each called-out member's value.
needs new wording: none fixed; the names, the head and the footnote come from the data as segments.
Refuses: fewer than four cells, a cell twice, a code that is no code, a point off the globe, a point inside no country (or two
cells in one country), no Natural Earth file, a value that is no series cell, a call-out with no value text, ends that are no
ledger entries or are not the lowest and the highest called-out values' texts of a member, a call-out column too full for the
picture's height, a digit in a literal word, a text that leaves the picture or overlaps another, a board too narrow (under 480 px)."""
import math

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "member_map"
CELLS_MIN = 4
BINS = 5
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), margin=(150, (100, 260, 10), "width of each call-out column in px"),
    simplify=(2, (1, 8, 1), "keep every n-th point of a coastline"), line_h=(40, (30, 70, 2), "distance between two call-outs in px"),
    max_h=(0.6, (0.3, 1.0, 0.05), "the map's tallest height as a share of the picture's width"))
def features():
    """The Natural Earth features the request names (geo.NE), read by geo's own reader (the one file read of the map code)."""
    import geo as G
    if not G.NE: raise Refused("member_map: the request names no Natural Earth file")
    try: return G.features()[0]
    except OSError: raise Refused("member_map: the request names no Natural Earth file")


def polys(g):
    if not g: return []
    return g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]] if g["type"] == "Polygon" else []


def inside(pt, ring):
    x, y = pt; c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c


def owner(pt, fs):
    """The index of the feature one of whose outer rings holds the point, else None."""
    for i, f in enumerate(fs):
        for poly in polys(f["geometry"]):
            ring = poly[0]
            if min(p[0] for p in ring) <= pt[0] <= max(p[0] for p in ring) and min(p[1] for p in ring) <= pt[1] <= max(p[1] for p in ring) and inside(pt, ring):
                return i
    return None


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        kind = d.get("name_kind", "place")
        K.segs(d.get("title"), "title"); K.segs(d.get("unit"), "unit")
        cells = d.get("cells")
        if not isinstance(cells, list) or len(cells) < CELLS_MIN: raise Refused(f"member_map: the spec holds fewer than {CELLS_MIN} cells")
        codes = [c.get("code") if isinstance(c, dict) else None for c in cells]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"member_map: the cells' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"member_map: the cells {twice} come twice")
        fs = features()
        f.cells, owned = [], {}
        for c in cells:
            at = c.get("at")
            if not (isinstance(at, list) and len(at) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in at) and -180 <= at[0] <= 180 and -90 <= at[1] <= 90):
                raise Refused(f"member_map: cell {c['code']}'s point {at!r} is no [lon, lat] on the globe")
            i = owner(tuple(at), fs)
            if i is None: raise Refused(f"member_map: cell {c['code']}'s point {at} lies inside no country of the map")
            if i in owned: raise Refused(f"member_map: cells {owned[i]} and {c['code']} lie in one country")
            owned[i] = c["code"]
            v = K.val(c.get("value"))
            if c.get("text") is not None: FX.text(c["text"])
            f.cells.append(dict(c, _i=i, _v=v, _n=K.named(c["code"], kind), at=tuple(at)))
        f.lo_v, f.hi_v = min(c["_v"] for c in f.cells), max(c["_v"] for c in f.cells)
        ends = d.get("ends")
        if not (isinstance(ends, dict) and ends.get("lo") and ends.get("hi")): raise Refused("member_map: ends needs the lowest's and the highest's value entries")
        for key in ("lo", "hi"): FX.text(ends[key])
        for key, v in (("lo", f.lo_v), ("hi", f.hi_v)):
            if not any(c.get("text") == ends[key] and c["_v"] == v for c in f.cells):
                raise Refused(f"member_map: the {key} end {ends[key]!r} is not the text of the member holding the {key}est value")
        f.called = [c for c in f.cells if c.get("text")]
        if f.W < 480: raise Refused("member_map: the board is too narrow")
        f.margin = min(k("margin"), 0.2 * f.W) if f.called else 0
        lons = [c["at"][0] for c in f.cells]; lats = [c["at"][1] for c in f.cells]
        pad_x, pad_y = max(4.0, 0.12 * (max(lons) - min(lons))), max(3.0, 0.12 * (max(lats) - min(lats)))
        lon0, lon1 = max(-180.0, min(lons) - pad_x), min(180.0, max(lons) + pad_x)
        lat0, lat1 = max(-85.0, min(lats) - pad_y), min(85.0, max(lats) + pad_y)
        if lon1 - lon0 < 30: mid = (lon0 + lon1) / 2; lon0, lon1 = mid - 15, mid + 15
        if lat1 - lat0 < 20: mid = (lat0 + lat1) / 2; lat0, lat1 = mid - 10, mid + 10
        f.ext = (lon0, lat0, max(lon1, lon0 + 1), min(85.0, lat1))
        f.kx = math.cos(math.radians((f.ext[1] + f.ext[3]) / 2))
        f.mw = f.W - 2 * f.margin                      # the room for the map between the call-out columns
        # one scale for both axes: the room's width, or the height cap (the picture is never taller than the knob's share of its width)
        f.s = min(f.mw / ((f.ext[2] - f.ext[0]) * f.kx), f.k("max_h") * f.W / (f.ext[3] - f.ext[1]))
        f.dw = (f.ext[2] - f.ext[0]) * f.kx * f.s       # the map's drawn width, centred in the room
        f.ox = f.margin + (f.mw - f.dw) / 2
        f.mh = (f.ext[3] - f.ext[1]) * f.s
        f.top = 22 + f.size * 4.2                       # the head and the legend over the map
        left = [c for c in f.called if f.xy(c)[0] < f.W / 2]; right = [c for c in f.called if f.xy(c)[0] >= f.W / 2]
        need = max(len(left), len(right)) * k("line_h") + 12
        f.mh = max(f.mh, need)
        f.H = 0

    def xy(f, c):
        lon, lat = c["at"] if isinstance(c, dict) else c
        return f.ox + (lon - f.ext[0]) * f.kx * f.s, f.top + (f.ext[3] - lat) * f.s


def cl_member_map(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size + 1, f.k("title_size"))]
    ramp = [f"color-mix(in srgb, var(--accent) {p}%, #eeeeec)" for p in (10, 30, 52, 76)] + ["var(--accent)"]
    span = (f.hi_v - f.lo_v) or 1.0
    step = lambda v: max(0, min(BINS - 1, int((v - f.lo_v) / span * BINS)))
    by = {c["_i"]: c for c in f.cells}
    fs = features(); st = int(f.k("simplify")); lon0, lat0, lon1, lat1 = f.ext
    x0, y0 = f.ox, f.top
    land, filled = [], []
    for i, ft in enumerate(fs):
        parts = []
        for poly in polys(ft["geometry"]):
            ring = poly[0]
            if max(p[0] for p in ring) < lon0 or min(p[0] for p in ring) > lon1 or max(p[1] for p in ring) < lat0 or min(p[1] for p in ring) > lat1: continue
            pts = [f.xy((max(lon0 - 2, min(lon1 + 2, lo)), max(lat0 - 2, min(lat1 + 2, la)))) for lo, la in ring[::st] + [ring[-1]]]
            parts.append("M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z")
        if not parts: continue
        dpath = "".join(parts)
        if i in by: filled.append((i, dpath))
        else: land.append(dpath)
    o.append(f'<clipPath id="mm-clip"><rect x="{x0:.1f}" y="{y0:.1f}" width="{f.dw:.1f}" height="{f.mh:.1f}"/></clipPath>')
    o.append(f'<g clip-path="url(#mm-clip)"><rect x="{x0:.1f}" y="{y0:.1f}" width="{f.dw:.1f}" height="{f.mh:.1f}" fill="var(--bg)"/>'
             f'<path d="{"".join(land)}" fill="var(--empty)" stroke="var(--bg)" stroke-width="0.5" data-part="land"/>')
    for i, dpath in filled:
        c = by[i]
        o.append(f'<path d="{dpath}" fill="{ramp[step(c["_v"])]}" stroke="var(--bg)" stroke-width="0.6" data-code="{esc(c["code"])}" data-step="{step(c["_v"])}"/>')
    o.append("</g>")
    # the legend: five steps, the lowest value at the left end and the highest at the right, over the map's top-left
    ly = 22 + size * 1.9
    lo_t, hi_t = K.ent(d["ends"]["lo"]), K.ent(d["ends"]["hi"])
    sw = 28; lx = 8
    o.append(K.txt(B, lx, ly + size * 0.8, size, "var(--t-sec)", lo_t[0], tw(lo_t[1], size), tag="legend low"))
    sx = lx + tw(lo_t[1], size) + 8
    for b in range(BINS): o.append(f'<rect x="{sx + b * sw:.1f}" y="{ly - 2:.1f}" width="{sw}" height="{size}" fill="{ramp[b]}" data-part="legend"/>')
    o.append(K.txt(B, sx + BINS * sw + 8, ly + size * 0.8, size, "var(--t-sec)", hi_t[0], tw(hi_t[1], size), tag="legend high"))
    # the call-outs: each side's labels in the order of their points' heights, spread so none overlaps; a leader from the dot
    gap = f.k("line_h")
    for side in ("L", "R"):
        group = sorted([c for c in f.called if (f.xy(c)[0] < W / 2) == (side == "L")], key=lambda c: f.xy(c)[1])
        prev = f.top - gap + 8
        placed = []
        for c in group:
            px, py = f.xy(c); ty = max(py, prev + gap); prev = ty; placed.append((c, px, py, ty))
        over = placed[-1][3] - (f.top + f.mh - 14) if placed else 0
        if over > 0:  # pushed past the bottom: move the whole column up by what it overshoots, as far as the top allows
            placed = [(c, px, py, ty - over) for c, px, py, ty in placed]
        for c, px, py, ty in placed:
            if ty < f.top - 4: raise Refused(f"member_map: the {len(group)} call-outs on the {'left' if side == 'L' else 'right'} do not fit the map's height")
            tx = f.ox - 10 if side == "L" else f.ox + f.dw + 10   # the columns stand against the map's own edges
            ex = tx + 4 if side == "L" else tx - 4
            o.append(f'<path d="M{px:.1f},{py:.1f} L{ex:.1f},{ty:.1f}" stroke="var(--t-title)" stroke-width="0.8" fill="none" stroke-opacity="0.7" data-part="leader"/>'
                     f'<circle cx="{px:.1f}" cy="{py:.1f}" r="3" fill="var(--t-title)" data-code="{esc(c["code"])}"/>')
            t = K.ent(c["text"])
            nm_w, v_w = tw(c["_n"][1], size), tw(t[1], size + 1)
            anchor = "end" if side == "L" else "start"
            o.append(K.txt(B, tx, ty, size, "var(--t-title)", c["_n"][0], nm_w, anchor=anchor, weight=700, tag=f"call-out {c['code']} name"))
            o.append(K.txt(B, tx, ty + size * 1.3, size + 1, "var(--t-title)", t[0], v_w, anchor=anchor, tag=f"call-out {c['code']} value"))
    y = f.top + f.mh + 8
    if d.get("footnote"):
        y += size * 1.2
        o.append(K.words(B, d["footnote"], "footnote", 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 10); B.h = f.H
    for (bx0, by0, bx1, by1), tag in B.b:
        if by1 > f.H + 0.5 or bx0 < -0.5 or bx1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


MEMBER_MAP_LAYERS = dict(member_map=(cl_member_map, None))
MEMBER_MAP_SVG = ["member_map"]


def draw(h):
    f = Frame(h)
    inner = cl_member_map(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "member_map"), f.W, f.H
