"""EU choropleth card. Geometry: Natural Earth admin0 50m from the repo (outlines only, no names),
so each member is matched by one interior point (lon, lat) -> the feature that contains it."""
import json, math, os
from cards import fmt, esc
from words import word

NE = None  # the Natural Earth admin-0 file, set by the caller (run.py takes it from the request)
PT = dict(AT=(14.5, 47.5), BE=(4.6, 50.6), BG=(25.3, 42.7), HR=(16.0, 45.6), CY=(33.2, 35.0), CZ=(15.4, 49.8), DK=(9.2, 56.1),
          EE=(25.5, 58.7), FI=(26.0, 63.0), FR=(2.5, 46.8), DE=(10.4, 51.1), EL=(22.0, 39.5), HU=(19.4, 47.1), IE=(-8.0, 53.2),
          IT=(12.6, 42.8), LV=(24.9, 56.9), LT=(23.9, 55.3), LU=(6.1, 49.8), MT=(14.4, 35.9), NL=(5.6, 52.2), PL=(19.4, 52.1),
          PT=(-8.0, 39.6), RO=(25.0, 45.9), SK=(19.6, 48.7), SI=(14.8, 46.1), ES=(-3.7, 40.2), SE=(15.0, 62.0))
BOX = (-26.0, 34.0, 40.0, 71.5)  # lon0, lat0, lon1, lat1; the Atlantic strip on the left holds the callouts

def _rings(g):
    return [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]

def _inside(pt, ring):
    x, y = pt; c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c

_cache = {}
def features():
    if "f" not in _cache:
        fs = json.load(open(NE))["features"]
        own = {}
        for code, pt in PT.items():
            for i, f in enumerate(fs):
                if any(_inside(pt, poly[0]) for poly in _rings(f["geometry"])): own[code] = i; break
        _cache["f"] = (fs, own)
    return _cache["f"]

def choropleth(vals, hi, title="", scale=1, dec=1, unit="", W=660, H=560, notes=(), rings=None, ring_name="", ring_unit="", read="", vmin=None, vmax=None):
    """vals: {code: value}; hi: code to outline in the accent; notes: [(code, text)] leader-line callouts.
    Sequential grey-to-accent ramp in 5 equal bins; members without data are hatched-grey."""
    fs, own = features()
    lon0, lat0, lon1, lat1 = BOX; k = math.cos(math.radians(52))
    sx = W / ((lon1 - lon0) * k); sy = H / (lat1 - lat0); s = min(sx, sy)
    P = lambda lo, la: ((lo - lon0) * k * s, (lat1 - la) * s)
    def path(g):
        d = []
        for poly in _rings(g):
            for ring in poly:
                if not any(lon0 - 5 < x < lon1 + 5 and lat0 - 5 < y < lat1 + 5 for x, y in ring): continue
                d.append("M" + "L".join(f"{P(x, y)[0]:.1f},{P(x, y)[1]:.1f}" for x, y in ring) + "Z")
        return "".join(d)
    lo = min(vals.values()) if vmin is None else vmin  # a shared scale lets two small maps be compared
    hi_v = max(vals.values()) if vmax is None else vmax
    ramp = [f"color-mix(in srgb, var(--accent) {p}%, #eeeeec)" for p in (10, 30, 52, 76)] + ["var(--accent)"]
    bin_ = lambda v: max(0, min(4, int((v - lo) / ((hi_v - lo) or 1) * 5)))
    member = {i: c for c, i in own.items()}
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img"><rect width="{W}" height="{H}" fill="#f6f8fa"/>']
    for i, f in enumerate(fs):
        d = path(f["geometry"])
        if not d: continue
        c = member.get(i)
        fill = ramp[bin_(vals[c])] if c in vals else ("#e5e5e5" if c else "#fbfbfb")
        o.append(f'<path d="{d}" fill="{fill}" stroke="#fff" stroke-width="0.6"/>')
    if rings:  # second layer: a ring per member, area = size of the change; rises in accent2, falls dashed grey
        mx = max(abs(v) for v in rings.values()) or 1; R = 22
        for c, v in sorted(rings.items(), key=lambda t: -abs(t[1])):
            x, y = P(*PT[c]); r = max(1.5, R * math.sqrt(abs(v) / mx))
            o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="none" stroke="{"var(--accent2)" if v >= 0 else "#8a8a8a"}" stroke-width="1.6"{"" if v >= 0 else " stroke-dasharray=\"3 2\""}/>')
    if hi in own:
        o.append(f'<path d="{path(fs[own[hi]]["geometry"])}" fill="none" stroke="var(--t-title)" stroke-width="2"/>')
    # callouts: each side's labels sorted by the country's height, pushed apart, so leader lines do not cross
    placed, last = [], {"L": -99, "R": -99}
    for c, text in sorted(notes, key=lambda t: P(*PT[t[0]])[1]):
        x, y = P(*PT[c]); side = "R" if x > W * 0.62 else "L"
        ty = max(y - 4, last[side] + 30, 170 if side == "L" else 70); last[side] = ty
        placed.append((c, text, x, y, W - 8 if side == "R" else 8, ty))
    for c, text, x, y, tx, ty in placed:
        o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="var(--t-title)"/>'
                 f'<path d="M{x:.1f},{y:.1f} L{(tx - 10 if tx > W / 2 else tx + 10):.1f},{ty:.1f}" stroke="var(--t-title)" fill="none" stroke-width="0.8"/>'
                 f'<text class="v" x="{tx}" y="{ty + 4}" text-anchor="{"end" if tx > W / 2 else "start"}" font-size="13" fill="var(--t-title)">{text}</text>')
    # legend: 5 bins with their lower edges
    for b in range(5):
        o.append(f'<rect x="{12 + b * 36}" y="12" width="36" height="10" fill="{ramp[b]}"/>'
                 f'<text x="{12 + b * 36}" y="36" font-size="11" fill="var(--t-sec)">{fmt(lo + (hi_v - lo) * b / 5, scale, 0)}</text>')
    o.append(f'<text x="{12 + 5 * 36 + 4}" y="36" font-size="11" fill="var(--t-sec)">{fmt(hi_v, scale, 0)}{esc(unit)}</text>')
    y = 58
    if rings:  # ring legend: the largest change and half of it, labelled with real values
        mx = max(abs(v) for v in rings.values()) or 1
        for k, (frac, cx) in enumerate(((1, 34), (0.25, 84))):
            r = 22 * math.sqrt(frac)
            o.append(f'<circle cx="{cx}" cy="{y + 22}" r="{r:.1f}" fill="none" stroke="var(--accent2)" stroke-width="1.6"/>'
                     f'<text x="{cx}" y="{y + 60}" text-anchor="middle" font-size="11" fill="var(--t-sec)">{fmt(mx * frac, scale, dec)}</text>')
        o.append(f'<text x="112" y="{y + 18}" font-size="12" fill="var(--t-title)">{word("ring.name", v=esc(ring_name))}</text>'
                 f'<text x="112" y="{y + 34}" font-size="11" fill="var(--t-sec)">{word("paren", v=esc(ring_unit))}</text>')
        y += 76
    if read:
        o.append(f'<text x="12" y="{y + 10}" font-size="12" fill="var(--t-title)">{read}</text>')
    o.append('</svg>')
    return f'<div class="card"><h3>{esc(title)}</h3>{"".join(o)}</div>'
