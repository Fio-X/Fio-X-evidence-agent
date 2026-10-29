"""What the map leaves of one picture share (bubbles.py in its view projection, leader_notes.py): the picture's frame and projection (View), the segment line (inline) and
the sampling of lines for the collision book. Nothing here is a layer. The projection, off-map entry point, pull-in and free-box search are
prod.py's own (prod.proj, prod.at_edge, prod.inside_box, prod.place); View only gives them the shape they take (a `.inside(box)` and the size).
The frame is built from hero.data alone (ext, hub, the width knob), so every leaf of one picture computes the same projection and one Occ
(prod.Occ, passed to cl_<node>(frame, occ)) carries the boxes and lines from one leaf to the next."""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
from wbkit import FX, prod, Refused, esc, tw


class View:
    def __init__(v, h, node):
        d = h["data"]; v.W = K.knob(h, node, "width")
        ext = d.get("ext")
        if not (isinstance(ext, list) and len(ext) == 4 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in ext) and ext[0] < ext[2] and ext[1] < ext[3]
                and -180 <= ext[0] and ext[2] <= 180 and -90 <= ext[1] and ext[3] <= 90):
            raise Refused(f"{node}: data.ext must be [lon0, lat0, lon1, lat1] inside the globe")
        v.ext = tuple(ext); lon0, lat0, lon1, lat1 = v.ext
        v.H = round(v.W * (lat1 - lat0) / ((lon1 - lon0) * math.cos(math.radians((lat0 + lat1) / 2 + 2))))  # the picture keeps the frame's aspect (scmp.hero)
        v.P = prod.proj(v.W, v.H, v.ext)
        hub = d.get("hub")
        v.hub = hub["lonlat"] if isinstance(hub, dict) and "lonlat" in hub else hub if isinstance(hub, list) else None

    def lonlat(v, ll, what):
        if not (isinstance(ll, list) and len(ll) == 2 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in ll) and -180 <= ll[0] <= 180 and -90 <= ll[1] <= 90):
            raise Refused(f"{what} has no [lon, lat] point")
        return ll

    def off(v, ll): return not (v.ext[0] <= ll[0] <= v.ext[2] and v.ext[1] <= ll[1] <= v.ext[3])

    def at(v, ll):
        """The point of a place on the picture; a place beyond the frame enters at the frame's edge (prod.at_edge), pulled just inside (prod.inside_box)."""
        x, y = v.P(*prod.at_edge(("", ll[0], ll[1], 1), v.ext))
        return prod.inside_box(x, y, v.W, v.H) if v.off(ll) else (x, y)

    def inside(v, b, e=4): return not (b[0] < e or b[1] < e or b[2] > v.W - e or b[3] > v.H - e)  # prod.place asks for this


def inline(sg, size, what):
    """A segment list as the inner of ONE <text>: (inner, width, plain). Entries are marked tspans, literals are escaped words."""
    s = K.segs(sg, what)
    return "".join(FX.entry(src, "tspan", None) if src else esc(t) for t, src in s), tw("".join(t for t, _ in s), size), "".join(t for t, _ in s)


def sample(p, c, q, step=4.0):
    """Points of the quadratic curve p-c-q about `step` px apart, with the unit normal of each (for both edges of a wide line)."""
    n = max(2, math.ceil((math.dist(p, c) + math.dist(c, q)) / step)); out = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        x, y = u * u * p[0] + 2 * u * t * c[0] + t * t * q[0], u * u * p[1] + 2 * u * t * c[1] + t * t * q[1]
        dx, dy = 2 * u * (c[0] - p[0]) + 2 * t * (q[0] - c[0]), 2 * u * (c[1] - p[1]) + 2 * t * (q[1] - c[1]); ln = math.hypot(dx, dy) or 1
        out.append((x, y, -dy / ln, dx / ln))
    return out


def clipped(v, inner, cid="mapframe", inset=0):
    """Geography (land, outlines) is drawn inside the picture's frame only: the group is clipped to the rect [0, 0, W, H], so nothing shows past the frame.
    With an inset the rect stands that many px inside the picture on every side, a hairline (--t-sec) drawn on it: the land ends at a drawn edge with open
    room around it, not cut by the panel's own edge."""
    if not inset: return f'<clipPath id="{cid}"><rect x="0" y="0" width="{v.W}" height="{v.H}"/></clipPath><g clip-path="url(#{cid})" data-frame="{v.W}x{v.H}">{inner}</g>'
    w, h = v.W - 2 * inset, v.H - 2 * inset
    return (f'<clipPath id="{cid}"><rect x="{inset}" y="{inset}" width="{w}" height="{h}"/></clipPath><g clip-path="url(#{cid})" data-frame="{v.W}x{v.H}">{inner}</g>'
            f'<rect x="{inset}" y="{inset}" width="{w}" height="{h}" fill="none" stroke="var(--t-sec)" stroke-width="0.5"/>')


# The land a map leaf drew, as the layers over it read it (bubbles sets occ.land, leader_notes keeps its notes off it): for
# each LAND_STEP px band of the picture, the x spans its land rings cover at the band's middle.
LAND_STEP = 6


def land_rows(rings, clip=None):
    """The land spans by band of picture rings (each a list of (x, y), closed or not): each ring's crossings of a band's middle
    paired in x order (a ring's inside), the rings' spans kept side by side; with a clip [x0, y0, x1, y1] (the drawn land's
    rect) only what lies inside it."""
    rows = {}
    for ring in rings:
        xs = {}
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if y1 == y2: continue
            lo, hi = min(y1, y2), max(y1, y2)
            for r in range(math.ceil(lo / LAND_STEP - 0.5), math.ceil(hi / LAND_STEP - 0.5)):
                yc = (r + 0.5) * LAND_STEP
                xs.setdefault(r, []).append(x1 + (yc - y1) * (x2 - x1) / (y2 - y1))
        for r, cut in xs.items():
            cut.sort(); rows.setdefault(r, []).extend((cut[i], cut[i + 1]) for i in range(0, len(cut) - 1, 2))
    if clip:
        rows = {r: [(max(a, clip[0]), min(b, clip[2])) for a, b in spans if b > clip[0] and a < clip[2]]
                for r, spans in rows.items() if clip[1] <= (r + 0.5) * LAND_STEP <= clip[3]}
    return rows


def on_land(rows, b, pad=2):
    """Whether a box [x0, y0, x1, y1] (pad px around it) lies over any land span."""
    if not rows: return False
    for r in range(math.floor((b[1] - pad) / LAND_STEP), math.floor((b[3] + pad) / LAND_STEP) + 1):
        if any(x0 < b[2] + pad and x1 > b[0] - pad for x0, x1 in rows.get(r, ())): return True
    return False
