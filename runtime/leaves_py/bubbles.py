"""bubbles layer: proportional circles on a land map: circle AREA is proportional to the value, the biggest top-N circles carry their name
and the ledger's number, the rest stay bare, in column.py's layer style. Land comes from geo.NE (the
Natural Earth admin-0 file run.py sets from the request's shapes).
hero.data: {"title": segs, "unit": segs, "name_kind": "place"|<kind>, "box": [lon0, lat0, lon1, lat1]? (extent=box),
  "ext": [lon0, lat0, lon1, lat1]? (projection=view), "items": [{"code", "value": series src, "value_text": src, "lonlat": [lon, lat]}]}      # the place's point comes from the first layer
projection=view draws in the picture's shared frame (mapkit.View over data.ext, the frame leader_notes draws in, its width the
width knob), with no title band (the page heads the panel) and the land clipped to a rect inset px inside the frame, on a hairline;
title and unit are then not read.
Every circle and every label box is claimed in the Occ (layer "bubbles"), so the layers over it keep clear of them; in the shared frame the land
it drew is set as occ.land (mapkit.land_rows), so notes over it can keep to the sea.
Circles that overlap are nudged apart (nudge px at most, circle_gap px between them); one moved off its point keeps a dot at the true point,
claimed in the Occ and kept clear by every label and leader like a circle.
Label places are tried right, left, above, below of the circle for every labelled circle first (biggest first), so a crowded centre's labels stay
close; the rest go out in free room on a thin leader from the circle's edge (sixteen directions, up to reach px), each at the cheapest clear place (the
leader's length, land_cost px more over the land in the shared frame; of places that cost the same, the one toward the frame's centre first, so a
circle on the frame's edge looks inward), its leader crossing no other leader; every place keeps label_gap px clear of every circle. A top-N label that fits nowhere is left off and listed in
Frame.unlabeled, never put on a circle, and in Frame.dropped
(code, "no free place for the label"), which run.py sends back so layer 1 keeps it in the page's ledger.
Colours: --accent the page's focus (the highlight knob: the circles the page's notes name, their names in bold), CIRCLE_INK every
other circle, --t-dark at LAND_OPACITY the land, --bg its outline, --t-title the labels' names and numbers (VALUE_INK).
Circles drawn at r_max that still overlap by over half the smaller one in more pairs than max_overlaps (default 0) after the nudge are
drawn smaller: r_max a knob step (2 px) less each round, down to the knob's floor (12), every radius (still by area), the nudge and the
overlaps again; the scale drawn is Frame.r_used (r_max when that held), the one any legend or note of the circles' size must read: the
layer leaves it in the Occ (occ.scale) for the key drawn after it (bubble_key below), which every page drawing the bubbles draws with them.
Refuses: no items, an item outside the extent or without a lon/lat point, a negative value, highlight naming a non-item, more pairs of
circles overlapping by over half the smaller one than max_overlaps even at the floor ("even at r_max 12"), no Natural Earth file, extent=box without a valid box,
a missing name or ledger entry, a digit in a literal, a knob off its range."""
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
from wbkit import FX, prod, Refused, esc, tw
import geo
import mapkit as MK

prod.KNOBS["bubbles"] = dict(
    projection=("equal_earth", ("equal_earth", "equirect", "view"), "projection; view: the picture's shared frame over data.ext (mapkit.View)"), extent=("world", ("world", "box"), "world or the data's box"),
    r_max=(22, (12, 80, 2), "the radius scale: the largest circle's radius px (the others by area); a world map at 1100 wide should stay at 28 or less"), r_min=(3, (2, 8, 0.5), "smallest circle radius px"),
    label_top=(60, (0, 60, 1), "circles that carry a name and number (the biggest first; one that fits nowhere is dropped and listed); 60: every circle of a map up to 60"), size=(13, (13, 16, 0.5), "label size px"),
    label_gap=(4, (1, 12, 1), "px a label keeps clear of every circle and of its own"),
    label_sep=(2, (2, 16, 1), "px a label keeps clear of every other label side by side (half that above and below)"),
    nudge=(6, (0, 16, 1), "px a circle may move off its point to clear its neighbours; a moved circle keeps a dot at its true point"),
    circle_gap=(1, (0, 6, 1), "px nudging keeps between neighbouring circles"),
    reach=(96, (0, 200, 8), "longest leader px from a circle to a label set off it; 0: no leaders"),
    land_cost=(60, (0, 400, 10), "px of leader a label set off its circle over the land costs: open room off the map's shapes comes first"),
    title_size=(16, (12, 22, 1), "chart name size px"), simplify=(3, (1, 8, 1), "keep every n-th point of a coastline"),
    opacity=(0.85, (0.5, 1.0, 0.05), "circle opacity"), highlight=("", None, "comma list of codes in the accent, their names in bold: the page's focus"),
    max_overlaps=(0, (0, 20, 1), "pairs of circles that may overlap by more than half the smaller (more refuses)"),
    width=(1140, (320, 1400, 10), "picture width in px"),
    inset=(12, (0, 40, 2), "projection view: px the land stops inside the picture's edge, on a hairline frame, so it is not cut by the panel"))
NODE = "bubbles"
# The land: --t-dark at this opacity over the page ground. A label's number is VALUE_INK, which keeps WCAG AA (4.5:1) on both
# the land and the ground (scripts/test_leaves_bubbles.py computes it from tokens.css and scmp.PAGE_ROOT); --t-sec keeps it on
# the ground only, not on the land.
LAND_OPACITY = 0.28
VALUE_INK = "--t-title"
# A circle not in the page's focus: a grey of the page's ramp, so the accent marks the focus alone (a page keeps its accent to one
# meaning); at the circles' opacity it stands out from the land under it.
CIRCLE_INK = "--t-sec"
DOT_R = 1.6  # the dot at a nudged circle's true point
BELOW_GAP = 0.3  # of the label size: a label set below its leader starts this far under the leader's end (a 13 px name's glyph box
# reaches about 0.26 of its size above the box tw lays out; the page's line check, 2 px in from that glyph box, would meet the leader)
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
TOP = 36


def equal_earth(lon, lat):
    l, p = math.radians(lon), math.radians(lat)
    t = math.asin(math.sqrt(3) / 2 * math.sin(p))
    return (2 * math.sqrt(3) * l * math.cos(t) / (3 * (A1 + 3 * A2 * t ** 2 + 7 * A3 * t ** 6 + 9 * A4 * t ** 8)), t * (A1 + A2 * t ** 2 + A3 * t ** 6 + A4 * t ** 8))


def equirect(lon, lat):
    return math.radians(lon), math.radians(lat)


def lens(a, b):
    """The overlap area of two circles (dicts with _xy and _r)."""
    d = math.hypot(a["_xy"][0] - b["_xy"][0], a["_xy"][1] - b["_xy"][1]); r1, r2 = a["_r"], b["_r"]
    if d >= r1 + r2: return 0.0
    if d <= abs(r1 - r2): return math.pi * min(r1, r2) ** 2
    p = r1 * r1 * math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1)) + r2 * r2 * math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
    return p - 0.5 * math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.W, f.size, f.v = d, k, k("width"), k("size"), None
        if k("projection") == "view":  # the shared frame: every map leaf of the picture projects data.ext the same way
            f.v = v = MK.View(h, NODE); box = f.box = list(v.ext); f.W, f.H, f.top, f.xy = v.W, v.H, 0, v.P
        else:
            proj = equal_earth if k("projection") == "equal_earth" else equirect
            box = d.get("box") if k("extent") == "box" else [-180, -58, 180, 84]
            if not (isinstance(box, list) and len(box) == 4 and box[0] < box[2] and box[1] < box[3]): raise Refused("bubbles: extent=box needs data.box [lon0, lat0, lon1, lat1]")
            pts = [proj(lo, la) for lo in [box[0] + (box[2] - box[0]) * i / 40 for i in range(41)] for la in (box[1], box[3])] + \
                  [proj(lo, la) for lo in (box[0], box[2]) for la in [box[1] + (box[3] - box[1]) * i / 40 for i in range(41)]]
            x0, x1, y0, y1 = min(p[0] for p in pts), max(p[0] for p in pts), min(p[1] for p in pts), max(p[1] for p in pts)
            sc = (f.W - 16) / (x1 - x0)
            f.box, f.H, f.top = box, int(TOP + (y1 - y0) * sc + 14), TOP
            f.xy = lambda lon, lat: (8 + (proj(lon, lat)[0] - x0) * sc, TOP + (y1 - proj(lon, lat)[1]) * sc)
        items = [dict(i) for i in (d.get("items") or [])]
        if not items: raise Refused("bubbles: the spec holds no items")
        kind = d.get("name_kind", "place")
        for i in items:
            i["_v"] = K.val(i["value"]); i["_n"] = K.named(i["code"], kind); K.ent(i["value_text"])
            if i["_v"] < 0: raise Refused(f"bubbles: {i['code']} is negative; a circle area cannot show it")
            ll = i.get("lonlat")
            if not (isinstance(ll, list) and len(ll) == 2 and -180 <= ll[0] <= 180 and -90 <= ll[1] <= 90): raise Refused(f"bubbles: {i['code']} has no lon/lat point")
            if not (box[0] <= ll[0] <= box[2] and box[1] <= ll[1] <= box[3]): raise Refused(f"bubbles: {i['code']} lies outside the extent")
        f.hl = K.check_codes(NODE, k("highlight"), {i["code"] for i in items}) if k("highlight") else set()
        mx = max(i["_v"] for i in items) or 1.0; r_max = k("r_max"); low, _, step = prod.KNOBS[NODE]["r_max"][1]
        while True:  # at r_max, and only when that refuses, a step smaller each round down to the knob's floor: every radius, the nudge and the overlaps again
            for i in items: i["_r"] = max(k("r_min"), r_max * math.sqrt(i["_v"] / mx)); i["_at"] = i["_xy"] = f.xy(*i["lonlat"])
            items.sort(key=lambda i: -i["_v"])
            nudge(items, k("nudge"), k("circle_gap"))
            f.over = [[items[a]["code"], items[b]["code"]] for a in range(len(items)) for b in range(a + 1, len(items))
                      if lens(items[a], items[b]) > 0.5 * math.pi * min(items[a]["_r"], items[b]["_r"]) ** 2]
            if len(f.over) <= k("max_overlaps"): break
            if r_max - step < low:
                raise Refused(f"bubbles: {len(f.over)} pairs of circles overlap by more than half the smaller one ({', '.join('/'.join(p) for p in f.over[:6])}) even at r_max {r_max:g}, max_overlaps is {k('max_overlaps')}; "
                              "use extent=box with data.box on the crowded region or a map of that region")
            r_max -= step
        f.r_used = r_max  # the radius scale drawn (the largest circle's radius px): what a size legend or note about the circles reads, not the knob
        # the circles drawn at r_min, not by area: their area-true radius on that scale is under it (more of them as the scale steps down)
        f.r_min_codes = sorted(str(i["code"]) for i in items if r_max * math.sqrt(i["_v"] / mx) < k("r_min"))
        f.items, f.unlabeled, f.dropped = items, [], []


def nudge(items, most, gap):
    """Circles that overlap move apart along the line between their centres, each at most `most` px off its true point
    (_at); _xy is where it is drawn. Equal shares per pair, a few rounds; what still overlaps stays (max_overlaps reads it)."""
    if most <= 0: return
    for _ in range(40):
        moved = False
        for a in range(len(items)):
            for b in range(a + 1, len(items)):
                p, q = items[a], items[b]; dx, dy = q["_xy"][0] - p["_xy"][0], q["_xy"][1] - p["_xy"][1]; d = math.hypot(dx, dy)
                short = p["_r"] + q["_r"] + gap - d
                if short <= 0.05: continue
                ux, uy = (dx / d, dy / d) if d > 1e-9 else (1.0, 0.0)
                for i, sgn in ((p, -1), (q, 1)):
                    x, y = i["_xy"][0] + sgn * ux * short / 2, i["_xy"][1] + sgn * uy * short / 2
                    off = math.hypot(x - i["_at"][0], y - i["_at"][1])
                    if off > most: x, y = i["_at"][0] + (x - i["_at"][0]) * most / off, i["_at"][1] + (y - i["_at"][1]) * most / off
                    if math.hypot(x - i["_xy"][0], y - i["_xy"][1]) > 0.01: moved = True
                    i["_xy"] = (x, y)
        if not moved: break


def land(f):
    """The land path of the picture, and its rings in picture px (what occ.land is made of)."""
    shp = geo.NE
    if not shp or not os.path.exists(shp): raise Refused("bubbles: the request names no Natural Earth file")
    box, st, d, rings = f.box, int(f.k("simplify")), [], []
    with open(shp, encoding="utf-8") as fh: features = json.load(fh)["features"]
    for ft in features:
        g = ft["geometry"]
        if not g: continue
        for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]] if g["type"] == "Polygon" else []):
            ring = poly[0]
            if max(p[1] for p in ring) < box[1] or min(p[1] for p in ring) > box[3] or max(p[0] for p in ring) < box[0] or min(p[0] for p in ring) > box[2]: continue
            clamp = (lambda lo, la: (lo, la)) if f.v else (lambda lo, la: (max(box[0], min(box[2], lo)), max(box[1], min(box[3], la))))  # the view clips instead
            pts = [f.xy(*clamp(lo, la)) for lo, la in ring[::st] + [ring[-1]]]; rings.append(pts)
            d.append("M" + "L".join("%.1f %.1f" % p for p in pts) + "Z")
    return "".join(d), rings


def cl_bubbles(f, occ):
    d, k, W, H, sz = f.d, f.k, f.W, f.H, f.size; B = K.Boxes(W, H); o = [] if f.v else [K.head(B, d["title"], d["unit"], sz + 1, k("title_size"))]
    shape, rings = land(f)
    path = f'<path d="{shape}" fill="var(--t-dark)" fill-opacity="{LAND_OPACITY}" stroke="var(--bg)" stroke-width="0.4"/>'
    e = k("inset") if f.v else 0
    if f.v: occ.land = MK.land_rows(rings, (e, e, W - e, H - e))  # the shared frame: the notes over this map keep off its land
    # what the key to the circles reads (bubble_key): the scale drawn, each circle drawn by its area (not lifted to r_min), largest
    # first, as (code, value, radius, its ledger entry), the picture's size and the rect the land is drawn in
    occ.scale = dict(r_used=f.r_used, W=W, H=H, rect=(e, e, W - e, H - e) if f.v else (0, f.top, W, H),
                     circles=[(i["code"], i["_v"], i["_r"], i["value_text"]) for i in f.items if str(i["code"]) not in f.r_min_codes])
    o.append(MK.clipped(f.v, path, "bubblesframe", e) if f.v else path)
    for i in f.items:  # biggest first, so the small ones stay visible on top
        sq = (i["_xy"][0] - i["_r"], i["_xy"][1] - i["_r"], i["_xy"][0] + i["_r"], i["_xy"][1] + i["_r"]); occ.add(sq, "bubbles")
        if not hasattr(occ, "circles"): occ.circles = []
        occ.circles.append((i["_xy"][0], i["_xy"][1], i["_r"], sq))  # the circle itself, for a leader that may pass its square's corner
        ink = "--accent" if i["code"] in f.hl else CIRCLE_INK
        o.append(f'<circle cx="{i["_xy"][0]:.1f}" cy="{i["_xy"][1]:.1f}" r="{i["_r"]:.1f}" fill="var({ink})" fill-opacity="{k("opacity")}" data-code="{esc(i["code"])}"/>')
    dots = []  # a circle nudged off its point keeps a dot where the place is; no label, leader or note may cover it
    for i in f.items:
        if math.dist(i["_xy"], i["_at"]) > 0.5:
            x, y = i["_at"]; dots.append((x, y, DOT_R)); occ.add((x - DOT_R, y - DOT_R, x + DOT_R, y + DOT_R), "bubbles")
            o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{DOT_R}" fill="var(--t-title)" data-at="{esc(i["code"])}"/>')
    f.unlabeled, f.label_boxes, f.dropped = [], [], []
    gap, sep, reach, halo = k("label_gap"), k("label_sep"), k("reach"), ' stroke="var(--bg)" stroke-width="3" paint-order="stroke"'
    leads = []  # the points of every leader drawn (and of the land's hairline frame), which no label may sit on
    segs = []  # every leader drawn, as (a, b): no other leader may cross it
    if e:  # the hairline is a line the page's checks read: notes and labels keep off it
        corners = [(e, e), (W - e, e), (W - e, H - e), (e, H - e), (e, e)]
        fr = [(a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n) for a, b in zip(corners, corners[1:]) for n in [max(1, math.ceil(math.dist(a, b) / 4))] for t in range(n + 1)]
        leads.extend(fr); occ.add_line(fr, "bubbles", "frame")

    def free(bx, i):
        """A label box inside the picture, clear of every label drawn, every leader and every circle by label_gap (its own too)."""
        if bx[0] < 2 or bx[2] > W - 2 or bx[1] < f.top - 4 or bx[3] > H - 2: return False
        if any(bx[0] < b[0][2] + sep and b[0][0] < bx[2] + sep and bx[1] < b[0][3] + sep / 2 and b[0][1] < bx[3] + sep / 2 for b in B.b): return False
        if any(bx[0] - 1 < px < bx[2] + 1 and bx[1] - 1 < py < bx[3] + 1 for px, py in leads): return False
        rings = [(*j["_xy"], j["_r"]) for j in f.items] + dots
        return not any(math.hypot(max(bx[0] - x, 0, x - bx[2]), max(bx[1] - y, 0, y - bx[3])) < r + gap for x, y, r in rings)

    mid = (W / 2, (f.top + H) / 2)  # the frame's centre: a label looks toward it first

    def inward(i, c, s_):
        """How far the direction (c, s_) from circle i points toward the frame's centre (each axis by the frame's half size)."""
        dx, dy = (mid[0] - i["_xy"][0]) / (W / 2), (mid[1] - i["_xy"][1]) / max((H - f.top) / 2, 1)
        return c * dx + s_ * dy

    def beside(i):
        """(anchor, tx, ty) beside the circle, label_gap + 1 px off it: right, left, above, below. (Taking the side toward the
        frame's centre first here drops labels of a crowded centre: the EU-27 with every circle labelled loses one.)"""
        x, y = i["_xy"]; r = i["_r"]; g = gap + 1
        return [("start", x + r + g, y - sz * 0.2), ("end", x - r - g, y - sz * 0.2), ("middle", x, y - r - g - sz * 1.65), ("middle", x, y + r + g + sz * 0.8)]

    def out(i):
        """(anchor, tx, ty, leader) out in free room: sixteen directions, 16 px past the circle's edge to reach, each with a
        leader from the edge to the label."""
        x, y = i["_xy"]; r = i["_r"]
        for d in range(16, int(reach) + 1, 8):
            for n in range(16):
                c, s_ = math.cos(math.pi * n / 8), math.sin(math.pi * n / 8); px, py = x + (r + d) * c, y + (r + d) * s_
                anchor = "start" if c > 0.3 else "end" if c < -0.3 else "middle"
                # the box's top: below (BELOW_GAP under the leader's end, as the browser's glyph box reaches above the name's em box), above,
                # or level with the point
                top = py + sz * BELOW_GAP if s_ > 0.3 else py - sz * 2.45 if s_ < -0.3 else py - sz * 1.2
                yield anchor, px, top + sz * 0.8, ((x + r * c, y + r * s_), (px, py))

    def unit(lead):
        """The unit direction of a leader (from the circle's edge to the label)."""
        (ax, ay), (bx_, by_) = lead; n = math.hypot(bx_ - ax, by_ - ay) or 1.0
        return (bx_ - ax) / n, (by_ - ay) / n

    def clear_lead(i, a, b):
        """A leader that crosses no other circle, no true-point dot, no label drawn and no other leader."""
        n = max(2, math.ceil(math.dist(a, b) / 2)); pts = [(a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n) for t in range(n + 1)]
        if any(math.dist(p, j["_xy"]) < j["_r"] + 1 for p in pts for j in f.items if j is not i): return None
        if any(math.dist(p, d[:2]) < d[2] + 1 for p in pts for d in dots if math.dist(d[:2], i["_at"]) > 0.5): return None
        if any(MK.crosses(a, b, *s) for s in segs): return None
        if any(bb[0][0] - 1 < p[0] < bb[0][2] + 1 and bb[0][1] - 1 < p[1] < bb[0][3] + 1 for p in pts for bb in B.b): return None
        return pts

    def box(i, anchor, tx, ty):
        wmax = max(tw(i["_n"][1], sz), tw(K.ent(i["value_text"])[1], sz))
        x0 = tx if anchor == "start" else tx - wmax if anchor == "end" else tx - wmax / 2
        return (x0, ty - sz * 0.8, x0 + wmax, ty + sz * 1.65)

    def label(i, anchor, tx, ty, bx, lead=None, pts=()):
        vt = K.ent(i["value_text"]); nm = i["_n"][1]
        if lead:
            (ax, ay), (bx_, by_) = lead
            o.append(f'<line x1="{ax:.1f}" y1="{ay:.1f}" x2="{bx_:.1f}" y2="{by_:.1f}" stroke="var(--t-sec)" stroke-width="0.8"/>')
            leads.extend(pts); segs.append(lead); occ.add_line(list(pts), "bubbles", "leader")
        f.label_boxes.append((i["code"], bx)); occ.add(bx, "bubbles")
        o.append(K.txt(B, tx, ty, sz, "var(--t-title)", i["_n"][0], tw(nm, sz), anchor=anchor, weight=700 if i["code"] in f.hl else 400, tag=f"name {i['code']}", style=halo))
        o.append(K.txt(B, tx, ty + sz * 1.4, sz, f"var({VALUE_INK})", vt[0], tw(vt[1], sz), anchor=anchor, tag=f"value {i['code']}", style=halo))

    # first every label that fits beside its circle (biggest first), so a crowded centre's own labels stay close; then the
    # rest out on leaders, each the cheapest clear place (its leader's length, a place over the land counting land_cost px
    # more, so open room off the map's shapes comes first); what fits nowhere is dropped and listed
    # the biggest and the smallest go first, as the page's story names the two ends; then the rest by size
    ends = f.items[:1] + f.items[-1:] if len(f.items) > 1 else f.items[:1]
    wanted = (ends + [i for i in f.items if i not in ends])[: int(k("label_top"))]; out_ = []
    for i in wanted:
        for anchor, tx, ty in beside(i):
            bx = box(i, anchor, tx, ty)
            if free(bx, i): label(i, anchor, tx, ty, bx); break
        else: out_.append(i)
    ground = getattr(occ, "land", None) if f.v else None
    for i in out_:
        # equal costs: the place toward the frame's centre first
        found = sorted(((round(math.dist(*lead) + (k("land_cost") if MK.on_land(ground, bx) else 0), 6), -inward(i, *unit(lead)), anchor, tx, ty, bx, lead)
                        for anchor, tx, ty, lead in out(i) for bx in [box(i, anchor, tx, ty)] if free(bx, i)), key=lambda c: c[:2])
        for _, _, anchor, tx, ty, bx, lead in found:
            pts = clear_lead(i, *lead)
            if pts is not None: label(i, anchor, tx, ty, bx, lead, pts); break
        else:
            f.unlabeled.append(i["code"]); f.dropped.append((i["code"], "no free place for the label"))
    order = {i["code"]: n for n, i in enumerate(wanted)}
    f.unlabeled.sort(key=order.get); f.dropped.sort(key=lambda c: order[c[0]])
    return "".join(o)


# bubble_key: the key to the circles, drawn right after the bubbles on every page that draws them (knobs.py WITH). Its words, the
# word table's bubble_key.area: what a circle's area is (hero.leaves.bubbles.measure, the measure's own name as layer 1 gives it,
# segments; without one, or one that takes more than KEY_LINES lines of `width`, bubble_key.area_any) at the map's year (the
# panel's period entry, kept on one line with its word); under them up to `count` reference circles side by side on one bottom
# line, each drawn at the radius one of the map's circles was drawn at by its area (occ.scale, never a lifted one) and labelled
# under it with that circle's own ledger entry and the unit its family prints with (facts.unit): the largest, then the ones
# nearest a quarter and a sixteenth of its area, one within KEY_SAME px of a radius kept left out. No number is the key's own.
# Where: in the land's rect, KEY_GAP inside it, the first free box (off every box and line the Occ holds) of the corners, then along
# the top and bottom edges and the sides (KEY_STEP px apart), a box off the land before one over it; on its own ground (--bg), so
# its words keep their contrast over the land. With no free box there, under the map, in the room the panel keeps for it
# (key_room, run.Panel; the panel's map_h then grows to hold it); with no such room the key is dropped and named ("key", "no free
# place for the key"). The box is claimed in the Occ (layer bubble_key), so the leader notes drawn after it keep clear of it.
# Reads: the panel's frame f (its hero h, the table and year its map is drawn at, the page spec c.spec, its height H and map_h) and
# occ.scale; a key with no bubbles drawn before it refuses.
prod.KNOBS["bubble_key"] = dict(
    size=(12, (11, 16, 0.5), "key text size px"),
    count=(3, (1, 3, 1), "reference circles at most: the largest, then the ones nearest a quarter and a sixteenth of its area"),
    width=(220, (120, 400, 10), "widest line of the key's words px; longer words wrap"))
KEY = "bubble_key"
KEY_LINES = 3  # lines the key's words may take with the measure's name (more: the words without it)
KEY_PAD = 8  # px of the key's own ground around what it draws
KEY_GAP = 6  # px between the key's words and its circles, a circle and its value, two circles, and the key and the land's rect
KEY_LINE = 1.35  # em between the baselines of the key's lines
KEY_STEP = 24  # px between the places along an edge the key is tried at
KEY_SAME = 2  # px: a reference circle within this of one kept would read as the same size


def word_units(key, **fills):
    """The word table's entry for key as break units (each a list of (text, src)): its literals and each {placeholder}'s segments
    broken as wbkit.units_of breaks words, a placeholder given as ("one", segments) kept whole on one line; a unit starting with a
    mark the language never starts a line with joins the one before. A placeholder given none refuses, as words.word does."""
    out = []
    for part in re.split(r"(\{\w+\})", K.WD.WORDS[key]):
        if not re.fullmatch(r"\{\w+\}", part):
            got = [(u, None) for u in K.units_of(part)]
        elif part[1:-1] not in fills: raise Refused(f"the word {key} is given no {part[1:-1]}")
        else:
            whole, sg = fills[part[1:-1]]
            sg = K.segs(sg, KEY)
            got = [sg] if whole else [(u, s) for t, s in sg for u in ([t] if s else K.units_of(t))]
        for u in [g if isinstance(g, list) else [g] for g in got]:
            if out and u[0][0][:1] in K.NO_LINE_START: out[-1] = out[-1] + u
            else: out.append(u)
    return out


def lay_units(units, size, max_w):
    """Lines of break units, each line as many as fit max_w px (a unit's trailing space not counted at a line's end)."""
    lines, line, cur = [], [], 0.0
    for u in units:
        t = "".join(x for x, _ in u)
        if line and cur + tw(t.rstrip(), size) > max_w: lines.append(line); line, cur = [], 0.0
        line += u; cur += tw(t, size)
    return lines + [line] * bool(line)


def key_lines(f):
    """The key's words in lines at the width knob: bubble_key.area with the measure the bubbles' entry names, or bubble_key.area_any
    without one or when that takes more than KEY_LINES lines; the year (date.y over the map's period entry) on one line."""
    h = f.h; d = (h.get("leaves") or {}).get("bubbles") or {}
    sz, width = K.knob(h, KEY, "size"), K.knob(h, KEY, "width")
    if K.WD.WORDS["date.y"].count("{y}") != 1 or not K.WD.WORDS["date.y"].startswith("{y}"): raise Refused("bubble_key: the word date.y does not start with its year")
    year = (True, [{"src": f"period:{f.table}:{f.year}"}, *[{"w": w} for w in K.WD.WORDS["date.y"].split("{y}") if w]])
    lines = lay_units(word_units("bubble_key.area", m=(False, d["measure"]), y=year), sz, width) if d.get("measure") else None
    return lines if lines and len(lines) <= KEY_LINES else lay_units(word_units("bubble_key.area_any", y=year), sz, width)


def key_room(f):
    """The height the key takes at most under the map, KEY_GAP over it: its words, the circles up to the bubbles' r_max (the scale
    drawn is never larger) and a line of values under them. The panel keeps it (run.Panel), so a key no free box on the map
    holds still has its place."""
    sz = K.knob(f.h, KEY, "size")
    return KEY_GAP + KEY_PAD * 2 + len(key_lines(f)) * sz * KEY_LINE + KEY_GAP + 2 * K.knob(f.h, NODE, "r_max") + KEY_GAP + sz * 1.05


def unit_of(spec, src):
    """The unit a family member's bare entry (fact:<family>.<code>.n) prints with, as facts.fill writes it after a bare number;
    none for any other entry, or a unit holding a digit (a number prints from the ledger only)."""
    m = re.fullmatch(r"fact:([a-z0-9_]+)\.[^.]+\.n", str(src))
    q = (spec.get("facts") or {}).get(m[1]) if m else None
    u = FX.unit(spec, q) if isinstance(q, dict) and "fmt" in q else ""
    return "" if K.has_digit(u) else u


def key_refs(circles, count):
    """The reference circles of the key (occ.scale's, largest first): the largest, then for a quarter and a sixteenth of its area
    the circle nearest it by radius, each once and none within KEY_SAME px of a radius kept; largest first."""
    if not circles: return []
    top = circles[0]; out = [top]
    for frac in (0.25, 0.0625)[: int(count) - 1]:
        left = [c for c in circles if all(abs(c[2] - o[2]) >= KEY_SAME for o in out)]
        if left: out.append(min(left, key=lambda c: abs(c[2] - top[2] * math.sqrt(frac))))
    return sorted(out, key=lambda c: -c[2])


def cl_bubble_key(f, occ):
    sc = getattr(occ, "scale", None)
    if sc is None: raise Refused("bubble_key: no bubbles layer drew before it")
    sz, lines = K.knob(f.h, KEY, "size"), key_lines(f)
    refs = key_refs(sc["circles"], K.knob(f.h, KEY, "count"))
    f.key_dropped, empty = [], f'<g data-node="{KEY}"></g>'
    if not refs:
        f.key_dropped.append(("key", "no circle drawn by its area")); return empty
    spec = f.c.spec
    vals = [(c, FX.entry(c[3], "tspan", None) + esc(unit_of(spec, c[3])), FX.text(c[3]) + unit_of(spec, c[3])) for c in refs]
    slots = [max(2 * c[2], tw(p, sz)) for c, _, p in vals]  # each circle's column: its circle or its value, the wider
    R, words_h = refs[0][2], len(lines) * sz * KEY_LINE
    plain = lambda ln: "".join(t for t, _ in ln).rstrip()
    bw = KEY_PAD * 2 + max(max(tw(plain(ln), sz) for ln in lines), sum(slots) + KEY_GAP * (len(slots) - 1))
    bh = KEY_PAD * 2 + words_h + KEY_GAP + 2 * R + KEY_GAP + sz * 1.05
    x0, y0, x1, y1 = sc["rect"]; g = KEY_GAP
    xs = [x0 + g, x1 - g - bw]; ys = [y1 - g - bh, y0 + g]
    along = lambda a, b: [a + KEY_STEP * n for n in range(1, int((b - a) // KEY_STEP) + 1)]
    tries = [(x, y) for y in ys for x in xs] + [(x, y) for y in ys for x in along(xs[0], xs[1])] + [(x, y) for x in xs for y in along(ys[1], ys[0])]
    boxes = [(x, y, x + bw, y + bh) for x, y in tries if x >= x0 + g - 0.01 and y >= y0 + g - 0.01 and x + bw <= x1 - g + 0.01 and y + bh <= y1 - g + 0.01]
    free = [b for b in boxes if not occ.hit(b, pad=(4, 4)) and not occ.on_line(b, pad=3)]
    land = getattr(occ, "land", None)
    box = next((b for b in free if not MK.on_land(land, b)), free[0] if free else None)
    H = getattr(f, "H", sc["H"])
    if box is None and H - sc["H"] >= g + bh - 0.01:  # nowhere free on the map: under it, in the room the panel keeps there
        box = (x0, sc["H"] + g, x0 + bw, sc["H"] + g + bh); f.map_h = max(getattr(f, "map_h", sc["H"]), math.ceil(box[3]))
    if box is None:
        f.key_dropped.append(("key", "no free place for the key")); return empty
    occ.add(box, KEY)
    B = K.Boxes(sc["W"], max(H, sc["H"])); x, y = box[0] + KEY_PAD, box[1] + KEY_PAD
    o = [f'<rect x="{box[0]:.1f}" y="{box[1]:.1f}" width="{bw:.1f}" height="{bh:.1f}" fill="var(--bg)"/>']
    for n, ln in enumerate(lines):
        inner = "".join(FX.entry(s, "tspan", None) if s else esc(t) for t, s in ln)
        o.append(K.txt(B, x, y + sz * 0.8 + n * sz * KEY_LINE, sz, "var(--t-body)", inner, tw(plain(ln), sz), tag=f"key line {n + 1}"))
    yb = y + words_h + KEY_GAP + 2 * R  # the circles' one bottom line
    for (c, inner, p), w in zip(vals, slots):
        o.append(f'<circle cx="{x + w / 2:.1f}" cy="{yb - c[2]:.1f}" r="{c[2]:.1f}" fill="none" stroke="var(--t-sec)" stroke-width="0.8"/>')
        o.append(K.txt(B, x + w / 2, yb + KEY_GAP + sz * 0.8, sz, f"var({VALUE_INK})", inner, tw(p, sz), anchor="middle", tag=f"key value {c[0]}"))
        x += w + KEY_GAP
    return f'<g data-node="{KEY}">' + "".join(o) + "</g>"


BUBBLES_LAYERS = dict(bubbles=(cl_bubbles, None))
BUBBLES_SVG = ["bubbles", "bubble_key"]


def draw(h):
    f = Frame(h)
    return K.svg(cl_bubbles(f, prod.Occ()), f.W, f.H, "bubbles"), f.W, f.H
