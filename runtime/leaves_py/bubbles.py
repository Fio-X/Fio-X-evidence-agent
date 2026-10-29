"""bubbles layer: proportional circles on a land map: circle AREA is proportional to the value, the biggest top-N circles carry their name
and the ledger's number, the rest stay bare, in column.py's layer style. Land comes from geo.NE (the
Natural Earth admin-0 file run.py sets from the request's shapes).
hero.data: {"title": segs, "unit": segs, "name_kind": "place"|<kind>, "box": [lon0, lat0, lon1, lat1]? (extent=box),
  "ext": [lon0, lat0, lon1, lat1]? (projection=view), "items": [{"code", "value": series src, "value_text": src, "lonlat": [lon, lat]}]}      # the place's point comes from the first layer
projection=view draws in the picture's shared frame (mapkit.View over data.ext, the frame leader_notes draws in, its width the
width knob), with no title band (the page heads the panel) and the land clipped to the frame; title and unit are then not read.
Every circle and every label box is claimed in the Occ (layer "bubbles"), so the layers over it keep clear of them.
Label places are tried right, left, above, below of the circle; a top-N label that fits nowhere (clear of every circle and every other label) is left off and listed in Frame.unlabeled, never put on a circle.
Colours: --accent circles, --t-dark at low opacity the land, --bg its outline, --t-title / --t-sec the labels.
Refuses: no items, an item outside the extent or without a lon/lat point, a negative value, highlight naming a non-item, more pairs of
circles overlapping by over half the smaller one than max_overlaps (default 0), no Natural Earth file, extent=box without a valid box,
a missing name or ledger entry, a digit in a literal, a knob off its range."""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
from wbkit import FX, prod, Refused, esc, tw
import geo
import mapkit as MK

prod.KNOBS["bubbles"] = dict(
    projection=("equal_earth", ("equal_earth", "equirect", "view"), "projection; view: the picture's shared frame over data.ext (mapkit.View)"), extent=("world", ("world", "box"), "world or the data's box"),
    r_max=(28, (12, 80, 2), "largest circle radius px; a world map at 1100 wide should stay at 28 or less"), r_min=(3, (2, 8, 0.5), "smallest circle radius px"),
    label_top=(8, (0, 12, 1), "circles that carry a name and number"), size=(13, (13, 16, 0.5), "label size px"),
    title_size=(16, (12, 22, 1), "chart name size px"), simplify=(3, (1, 8, 1), "keep every n-th point of a coastline"),
    opacity=(0.85, (0.5, 1.0, 0.05), "circle opacity"), highlight=("", None, "comma list of codes in bold"),
    max_overlaps=(0, (0, 20, 1), "pairs of circles that may overlap by more than half the smaller (more refuses)"),
    width=(1140, (320, 1400, 10), "picture width in px"))
NODE = "bubbles"
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
        mx = max(i["_v"] for i in items) or 1.0
        for i in items: i["_r"] = max(k("r_min"), k("r_max") * math.sqrt(i["_v"] / mx)); i["_xy"] = f.xy(*i["lonlat"])
        items.sort(key=lambda i: -i["_v"])
        f.over = [[items[a]["code"], items[b]["code"]] for a in range(len(items)) for b in range(a + 1, len(items))
                  if lens(items[a], items[b]) > 0.5 * math.pi * min(items[a]["_r"], items[b]["_r"]) ** 2]
        if len(f.over) > k("max_overlaps"):
            raise Refused(f"bubbles: {len(f.over)} pairs of circles overlap by more than half the smaller one ({', '.join('/'.join(p) for p in f.over[:6])}), max_overlaps is {k('max_overlaps')}; "
                          "use extent=box with data.box on the crowded region, a smaller r_max, or a map of that region")
        f.items, f.unlabeled = items, []


def land(f):
    shp = geo.NE
    if not shp or not os.path.exists(shp): raise Refused("bubbles: the request names no Natural Earth file")
    box, st, d = f.box, int(f.k("simplify")), []
    with open(shp, encoding="utf-8") as fh: features = json.load(fh)["features"]
    for ft in features:
        g = ft["geometry"]
        if not g: continue
        for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]] if g["type"] == "Polygon" else []):
            ring = poly[0]
            if max(p[1] for p in ring) < box[1] or min(p[1] for p in ring) > box[3] or max(p[0] for p in ring) < box[0] or min(p[0] for p in ring) > box[2]: continue
            clamp = (lambda lo, la: (lo, la)) if f.v else (lambda lo, la: (max(box[0], min(box[2], lo)), max(box[1], min(box[3], la))))  # the view clips instead
            d.append("M" + "L".join("%.1f %.1f" % f.xy(*clamp(lo, la)) for lo, la in ring[::st] + [ring[-1]]) + "Z")
    return "".join(d)


def cl_bubbles(f, occ):
    d, k, W, H, sz = f.d, f.k, f.W, f.H, f.size; B = K.Boxes(W, H); o = [] if f.v else [K.head(B, d["title"], d["unit"], sz + 1, k("title_size"))]
    path = f'<path d="{land(f)}" fill="var(--t-dark)" fill-opacity="0.28" stroke="var(--bg)" stroke-width="0.4"/>'
    o.append(MK.clipped(f.v, path, "bubblesframe") if f.v else path)
    for i in f.items:  # biggest first, so the small ones stay visible on top
        occ.add((i["_xy"][0] - i["_r"], i["_xy"][1] - i["_r"], i["_xy"][0] + i["_r"], i["_xy"][1] + i["_r"]), "bubbles")
        o.append(f'<circle cx="{i["_xy"][0]:.1f}" cy="{i["_xy"][1]:.1f}" r="{i["_r"]:.1f}" fill="var(--accent)" fill-opacity="{k("opacity")}" data-code="{esc(i["code"])}"/>')
    f.unlabeled, f.label_boxes = [], []
    for i in f.items[: int(k("label_top"))]:
        x, y = i["_xy"]; r = i["_r"]; vt = K.ent(i["value_text"]); nm = i["_n"][1]; wmax = max(tw(nm, sz), tw(vt[1], sz))
        for anchor, tx, ty in [("start", x + r + 4, y - sz * 0.2), ("end", x - r - 4, y - sz * 0.2), ("middle", x, y - r - 3 - sz * 1.65), ("middle", x, y + r + sz + 4)]:
            x0 = tx if anchor == "start" else tx - wmax if anchor == "end" else tx - wmax / 2
            bx = (x0, ty - sz * 0.8, x0 + wmax, ty + sz * 1.65)
            if bx[0] < 2 or bx[2] > W - 2 or bx[1] < f.top - 4 or bx[3] > H - 2: continue
            if any(bx[0] < b[0][2] + 2 and b[0][0] < bx[2] + 2 and bx[1] < b[0][3] + 1 and b[0][1] < bx[3] + 1 for b in B.b): continue
            if any(math.hypot(max(bx[0] - j["_xy"][0], 0, j["_xy"][0] - bx[2]), max(bx[1] - j["_xy"][1], 0, j["_xy"][1] - bx[3])) < j["_r"] + 1 for j in f.items if j is not i): continue  # a label never sits on ANY other circle, small ones included
            f.label_boxes.append((i["code"], bx)); occ.add(bx, "bubbles")
            o.append(K.txt(B, tx, ty, sz, "var(--t-title)", i["_n"][0], tw(nm, sz), anchor=anchor, weight=700 if i["code"] in f.hl else 400, tag=f"name {i['code']}"))
            o.append(K.txt(B, tx, ty + sz * 1.4, sz, "var(--t-sec)", vt[0], tw(vt[1], sz), anchor=anchor, tag=f"value {i['code']}"))
            break
        else:
            f.unlabeled.append(i["code"])
    return "".join(o)


BUBBLES_LAYERS = dict(bubbles=(cl_bubbles, None))
BUBBLES_SVG = ["bubbles"]


def draw(h):
    f = Frame(h)
    return K.svg(cl_bubbles(f, prod.Occ()), f.W, f.H, "bubbles"), f.W, f.H
