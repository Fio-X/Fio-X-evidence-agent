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


def clipped(v, inner, cid="mapframe"):
    """Geography (land, outlines) is drawn inside the picture's frame only: the group is clipped to the rect [0, 0, W, H], so nothing shows past the frame."""
    return f'<clipPath id="{cid}"><rect x="0" y="0" width="{v.W}" height="{v.H}"/></clipPath><g clip-path="url(#{cid})" data-frame="{v.W}x{v.H}">{inner}</g>'
