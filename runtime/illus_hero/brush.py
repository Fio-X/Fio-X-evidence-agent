"""Pen model for styles C and D (Python, numpy + shapely only, seeded => deterministic).
stroke(): a polyline -> a filled outline whose width follows a pressure profile (taper in, taper out, slow wobble), points jittered by smooth noise.
hatch(): parallel (and optional cross) strokes clipped to a region, each with its own length/angle/gap jitter.
ring_strokes(): a closed outline drawn as 1-3 overlapping strokes that overshoot a little, like a hand-inked contour."""
import math
import numpy as np
from shapely.geometry import LineString, Polygon, MultiLineString


def smooth_noise(rng, n, k=7):
    a = rng.normal(0, 1, n + 2 * k)
    ker = np.hanning(2 * k + 1); ker /= ker.sum()
    return np.convolve(a, ker, mode="same")[k:-k]


def resample(pts, step=2.6):
    pts = np.array(pts, float)
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    if d[-1] < 1e-6: return pts[:1]
    n = max(2, int(d[-1] / step) + 1)
    t = np.linspace(0, d[-1], n)
    return np.c_[np.interp(t, d, pts[:, 0]), np.interp(t, d, pts[:, 1])]


def stroke(pts, w, rng, jitter=0.6, t_in=0.18, t_out=0.3, floor=0.28, wob=0.22):
    p = resample(pts)
    n = len(p)
    if n < 2: return ""
    tg = np.gradient(p, axis=0); ln = np.hypot(*tg.T); ln[ln == 0] = 1
    nr = np.c_[-tg[:, 1] / ln, tg[:, 0] / ln]
    p = p + nr * (smooth_noise(rng, n) * jitter)[:, None]
    t = np.linspace(0, 1, n)
    prof = np.clip(np.minimum(t / max(t_in, 1e-3), (1 - t) / max(t_out, 1e-3)), 0, 1) ** 0.6
    ww = w * (floor + (1 - floor) * prof) * (1 + wob * smooth_noise(rng, n, 5))
    ww = np.maximum(ww, 0.15)
    L = p + nr * (ww / 2)[:, None]; R = p - nr * (ww / 2)[:, None]
    q = np.vstack([L, R[::-1]])
    return "M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in q) + "Z"


def ring_strokes(pts, w, rng, seg=(80, 150), over=5.0, jitter=0.7):
    p = resample(list(pts) + [pts[0]], 2.0)
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    total = d[-1]; out = []
    s = rng.uniform(0, total); pos = 0.0
    while pos < total - 1:
        ln = rng.uniform(*seg)
        a, b = pos, min(total, pos + ln + 3)
        if total - b < 25: b = total + over
        idx = [(s + u) % total for u in np.arange(a, b, 2.0)]
        q = np.c_[np.interp(idx, d, p[:, 0]), np.interp(idx, d, p[:, 1])]
        if len(q) >= 2: out.append(stroke(q, w * rng.uniform(0.85, 1.2), rng, jitter, 0.12, 0.25, 0.4))
        pos = b - 3
        if b >= total: break
    return out


def hatch(poly, angle, gap, rng, w=0.9, cross=False, cross_angle=68, cross_frac=0.55, shrink=1.2, gap_jit=0.25, cut=0.18):
    P = Polygon(poly).buffer(-shrink)
    if P.is_empty: return []
    out = []
    minx, miny, maxx, maxy = P.bounds
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2; R = math.hypot(maxx - minx, maxy - miny) / 2 + 4

    def pass_(ang, region, g):
        a = math.radians(ang); dx, dy = math.cos(a), math.sin(a); nx, ny = -dy, dx
        res = []; o = -R
        while o < R:
            c = (cx + nx * o, cy + ny * o)
            ls = LineString([(c[0] - dx * R, c[1] - dy * R), (c[0] + dx * R, c[1] + dy * R)])
            it = ls.intersection(region)
            segs = [] if it.is_empty else (list(it.geoms) if hasattr(it, "geoms") else [it])
            for sg in segs:
                if sg.geom_type != "LineString" or sg.length < 2.5: continue
                (x0, y0), (x1, y1) = sg.coords[0], sg.coords[-1]
                L = math.hypot(x1 - x0, y1 - y0); k0 = rng.uniform(0, cut) * L; k1 = rng.uniform(0, cut) * L
                ux, uy = (x1 - x0) / L, (y1 - y0) / L
                a0 = (x0 + ux * k0, y0 + uy * k0); a1 = (x1 - ux * k1, y1 - uy * k1)
                tw = math.radians(rng.normal(0, 2.0)); mx, my = (a0[0] + a1[0]) / 2, (a0[1] + a1[1]) / 2
                rr = lambda q: (mx + (q[0] - mx) * math.cos(tw) - (q[1] - my) * math.sin(tw), my + (q[0] - mx) * math.sin(tw) + (q[1] - my) * math.cos(tw))
                res.append(stroke([rr(a0), rr(a1)], w * rng.uniform(0.7, 1.25), rng, 0.25, 0.3, 0.55, 0.15, 0.3))
            o += g * (1 + rng.uniform(-gap_jit, gap_jit))
        return res
    out += pass_(angle, P, gap)
    if cross:
        # second direction only where the shade is deepest: the part of the region nearest its lower edge
        mid = miny + (maxy - miny) * (1 - cross_frac)
        sub = P.intersection(Polygon([(minx - 5, mid), (maxx + 5, mid), (maxx + 5, maxy + 5), (minx - 5, maxy + 5)]))
        if not sub.is_empty: out += pass_(angle + cross_angle, sub, gap * 1.15)
    return out
