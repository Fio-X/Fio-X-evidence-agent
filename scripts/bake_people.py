"""Bake flat-colour people SVGs into the registry the people hero reads (runtime/illus_hero/people/people.json).

python3 -I scripts/bake_people.py OUT.json ID=path/to/figure.svg [ID=...]

The originals are never stored in the repository. This tool reads them from the paths it is given and writes only baked shapes: every
group transform applied to the points, every command turned into absolute M / L / C / Z (arcs, quadratics, smooth curves and polygons become
cubics and lines), no fill-rule (evenodd shapes get their holes wound the other way, so the default non-zero rule draws the same picture),
colours kept as hex. That is the grammar a hero may draw (a <g> and a <path d fill>), nothing else. Origin of a figure: its feet centre, y up is
negative. stdlib only."""
import json
import math
import re
import sys
import xml.etree.ElementTree as ET

NUM = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")


def mat_mul(a, b):
    return (a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5])


def parse_transform(s):
    m = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", s or ""):
        v = [float(x) for x in NUM.findall(args)]
        if name == "translate": t = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0.0)
        elif name == "scale": t = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            a = math.radians(v[0]); c, s_ = math.cos(a), math.sin(a); t = (c, s_, -s_, c, 0, 0)
            if len(v) == 3: t = mat_mul(mat_mul((1, 0, 0, 1, v[1], v[2]), t), (1, 0, 0, 1, -v[1], -v[2]))
        elif name == "matrix": t = tuple(v[:6])
        else: raise ValueError("transform " + name)
        m = mat_mul(m, t)
    return m


def apply(m, p): return (m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5])


def arc_to_cubics(x1, y1, rx, ry, phi, fa, fs, x2, y2):
    if rx == 0 or ry == 0 or (x1, y1) == (x2, y2): return [("L", x2, y2)]
    phi = math.radians(phi); c, s = math.cos(phi), math.sin(phi); rx, ry = abs(rx), abs(ry)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2; x1p, y1p = c * dx + s * dy, -s * dx + c * dy
    lam = x1p ** 2 / rx ** 2 + y1p ** 2 / ry ** 2
    if lam > 1: rx *= math.sqrt(lam); ry *= math.sqrt(lam)
    num = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2; den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    co = (math.sqrt(max(0.0, num / den)) if den else 0.0) * (-1 if fa == fs else 1)
    cxp, cyp = co * rx * y1p / ry, -co * ry * x1p / rx; cx, cy = c * cxp - s * cyp + (x1 + x2) / 2, s * cxp + c * cyp + (y1 + y2) / 2
    ang = lambda ux, uy, vx, vy: math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry); dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not fs and dt > 0: dt -= 2 * math.pi
    elif fs and dt < 0: dt += 2 * math.pi
    n = max(1, int(math.ceil(abs(dt) / (math.pi / 2)))); d = dt / n; out = []; k = 4 / 3 * math.tan(d / 4)
    for i in range(n):
        a0, a1 = t1 + i * d, t1 + (i + 1) * d
        p = lambda a: (cx + rx * math.cos(a) * c - ry * math.sin(a) * s, cy + rx * math.cos(a) * s + ry * math.sin(a) * c)
        dv = lambda a: (-rx * math.sin(a) * c - ry * math.cos(a) * s, -rx * math.sin(a) * s + ry * math.cos(a) * c)
        P0, P1 = p(a0), p(a1); D0, D1 = dv(a0), dv(a1)
        out.append(("C", P0[0] + k * D0[0], P0[1] + k * D0[1], P1[0] - k * D1[0], P1[1] - k * D1[1], P1[0], P1[1]))
    return out


def parse_d(d):
    """path data -> list of subpaths, each a list of ('M',x,y) ('L',x,y) ('C',x1,y1,x2,y2,x,y) ('Z',), all absolute."""
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|" + NUM.pattern, d); i = 0; cur = (0.0, 0.0); start = cur; cmd = None; subs = []; sub = None; last_c = None; last_q = None

    def nums(n):
        nonlocal i
        v = [float(x) for x in toks[i:i + n]]; i += n; return v
    while i < len(toks):
        if re.match(r"[A-Za-z]", toks[i]): cmd = toks[i]; i += 1
        rel = cmd.islower(); C = cmd.upper(); ox, oy = cur if rel else (0.0, 0.0)
        if C == "Z":
            if sub is not None: sub.append(("Z",)); subs.append(sub); sub = None
            cur = start; last_c = last_q = None; continue
        if C == "M":
            x, y = nums(2); cur = (x + ox, y + oy); start = cur
            if sub: subs.append(sub)
            sub = [("M",) + cur]; cmd = "l" if rel else "L"; last_c = last_q = None; continue
        if sub is None: sub = [("M",) + cur]
        if C == "L": x, y = nums(2); cur = (x + ox, y + oy); sub.append(("L",) + cur); last_c = last_q = None
        elif C == "H": (x,) = nums(1); cur = (x + ox, cur[1]); sub.append(("L",) + cur); last_c = last_q = None
        elif C == "V": (y,) = nums(1); cur = (cur[0], y + oy); sub.append(("L",) + cur); last_c = last_q = None
        elif C == "C":
            a, b, c, e, x, y = nums(6); p1 = (a + ox, b + oy); p2 = (c + ox, e + oy); cur = (x + ox, y + oy); sub.append(("C",) + p1 + p2 + cur); last_c = p2; last_q = None
        elif C == "S":
            c, e, x, y = nums(4); p1 = (2 * cur[0] - last_c[0], 2 * cur[1] - last_c[1]) if last_c else cur; p2 = (c + ox, e + oy); cur = (x + ox, y + oy); sub.append(("C",) + p1 + p2 + cur); last_c = p2; last_q = None
        elif C in "QT":
            if C == "Q": a, b, x, y = nums(4); q = (a + ox, b + oy)
            else: x, y = nums(2); q = (2 * cur[0] - last_q[0], 2 * cur[1] - last_q[1]) if last_q else cur
            e = (x + ox, y + oy); p1 = (cur[0] + 2 / 3 * (q[0] - cur[0]), cur[1] + 2 / 3 * (q[1] - cur[1])); p2 = (e[0] + 2 / 3 * (q[0] - e[0]), e[1] + 2 / 3 * (q[1] - e[1]))
            sub.append(("C",) + p1 + p2 + e); cur = e; last_q = q; last_c = None
        elif C == "A":
            rx, ry, ph, fa, fs, x, y = nums(7); e = (x + ox, y + oy); sub.extend(arc_to_cubics(cur[0], cur[1], rx, ry, ph, int(fa), int(fs), e[0], e[1])); cur = e; last_c = last_q = None
    if sub: subs.append(sub)
    return subs


def shape_subs(el):
    t = el.tag.split("}")[-1]
    if t == "path": return parse_d(el.get("d") or "")
    if t in ("polygon", "polyline"):
        v = [float(x) for x in NUM.findall(el.get("points") or "")]; p = list(zip(v[0::2], v[1::2]))
        return [[("M",) + p[0]] + [("L",) + q for q in p[1:]] + [("Z",)]] if len(p) >= 3 else []
    if t == "rect":
        x, y, w, h = (float(el.get(k) or 0) for k in ("x", "y", "width", "height")); return [[("M", x, y), ("L", x + w, y), ("L", x + w, y + h), ("L", x, y + h), ("Z",)]]
    if t in ("circle", "ellipse"):
        cx, cy = float(el.get("cx") or 0), float(el.get("cy") or 0); rx = float(el.get("rx") or el.get("r") or 0); ry = float(el.get("ry") or el.get("r") or 0); k = 0.5523
        return [[("M", cx + rx, cy), ("C", cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry), ("C", cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy), ("C", cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry), ("C", cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy), ("Z",)]]
    return None


def transform_sub(sub, m):
    out = []
    for s in sub:
        if s[0] == "Z": out.append(s)
        else:
            pts = [apply(m, (s[k], s[k + 1])) for k in range(1, len(s), 2)]; out.append((s[0],) + tuple(v for p in pts for v in p))
    return out


def flat(sub, n=8):
    pts = []; cur = None
    for s in sub:
        if s[0] == "M": cur = (s[1], s[2]); pts.append(cur)
        elif s[0] == "L": cur = (s[1], s[2]); pts.append(cur)
        elif s[0] == "C":
            p0 = cur; p1 = (s[1], s[2]); p2 = (s[3], s[4]); p3 = (s[5], s[6])
            for k in range(1, n + 1):
                t = k / n; u = 1 - t; pts.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0], u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
            cur = p3
    return pts


def sarea(p): return 0.5 * sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))


def pip(pt, poly):
    x, y = pt; c = False
    for i in range(len(poly)):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % len(poly)]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax: c = not c
    return c


def reverse_sub(sub):
    pts = []; cur = None
    for s in sub:
        if s[0] == "M": cur = (s[1], s[2]); pts.append(("M", cur))
        elif s[0] == "L": pts.append(("L", (s[1], s[2]))); cur = (s[1], s[2])
        elif s[0] == "C": pts.append(("C", (s[1], s[2]), (s[3], s[4]), (s[5], s[6]))); cur = (s[5], s[6])
    ends = [p[-1] for p in pts]; out = [("M",) + ends[-1]]
    for k in range(len(pts) - 1, 0, -1):
        seg = pts[k]; to = ends[k - 1]
        if seg[0] == "L": out.append(("L",) + to)
        else: out.append(("C",) + seg[2] + seg[1] + to)
    out.append(("Z",)); return out


def wind_for_nonzero(subs, evenodd):
    """evenodd shapes: a subpath nested inside an odd number of larger ones is wound against its outer, so non-zero draws the same."""
    if not evenodd or len(subs) < 2: return subs
    fl = [flat(s) for s in subs]; ar = [abs(sarea(f)) for f in fl]; out = []
    for i, s in enumerate(subs):
        depth = sum(1 for j in range(len(subs)) if j != i and ar[j] > ar[i] and len(fl[j]) > 2 and pip(fl[i][0], fl[j]))
        want_positive = depth % 2 == 0
        out.append(s if (sarea(fl[i]) > 0) == want_positive else reverse_sub(s))
    return out


def fmt(v): return ("%.2f" % v).rstrip("0").rstrip(".") if abs(v) > 1e-9 else "0"


def d_of(subs): return "".join("".join((s[0] if s[0] == "Z" else s[0] + " ".join(fmt(v) for v in s[1:])) for s in sub) for sub in subs)


def bake_one(path):
    root = ET.parse(path).getroot(); shapes = []

    def walk(el, m, fill, evenodd):
        t = el.tag.split("}")[-1]
        m = mat_mul(m, parse_transform(el.get("transform"))); fill = el.get("fill") or fill; evenodd = (el.get("fill-rule") == "evenodd") if el.get("fill-rule") else evenodd
        subs = shape_subs(el) if t in ("path", "polygon", "polyline", "rect", "circle", "ellipse") else None
        if subs is not None:
            if fill and fill != "none" and re.fullmatch(r"#[0-9a-fA-F]{6}", fill):
                subs = [transform_sub(s, m) for s in subs if s]; subs = wind_for_nonzero(subs, evenodd)
                shapes.append((fill.lower(), subs))
        for ch in el:
            if ch.tag.split("}")[-1] not in ("defs", "title", "desc", "style"): walk(ch, m, fill, evenodd)
    walk(root, (1, 0, 0, 1, 0, 0), None, False)
    pts = [p for _, subs in shapes for sub in subs for p in flat(sub)]
    x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts); y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
    cx = (x0 + x1) / 2; base = [(fill, [transform_sub(s, (1, 0, 0, 1, -cx, -y1)) for s in subs]) for fill, subs in shapes]
    areas = {}; pieces = []
    for fill, subs in base:
        a = abs(sum(sarea(flat(s)) for s in subs)); areas[fill] = areas.get(fill, 0.0) + a; pieces.append({"fill": fill, "d": d_of(subs)})
    return {"w": round(x1 - x0, 2), "h": round(y1 - y0, 2), "fills": {k: round(v, 1) for k, v in areas.items()}, "pieces": pieces}


def main():
    out, items = sys.argv[1], sys.argv[2:]
    figs = {}
    for it in items:
        name, p = it.split("=", 1); figs[name] = bake_one(p)
    reg = json.load(open(out)) if len(sys.argv) > 1 and __import__("os").path.exists(out) else {}
    reg["figures"] = figs
    json.dump(reg, open(out, "w"), indent=1)
    for k, v in figs.items(): print(k, "pieces", len(v["pieces"]), "bytes", sum(len(p["d"]) for p in v["pieces"]), "aspect", round(v["w"] / v["h"], 3))


if __name__ == "__main__":
    main()
