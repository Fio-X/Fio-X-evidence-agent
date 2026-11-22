"""Reusable low-poly parts (pure python, see mesh.py). Every part is a function returning a list of Mesh objects, built around a local origin
(ground point under the part, z up, +y away from the viewer; yaw turns it about z). Knobs are keyword arguments with defaults and ranges:
  wind_turbine(height=40 [20..80], blade_len=22 [8..45], rotor_deg=0 [0..120], yaw=0 [-90..90])
  arch_dam(width=60 [30..120], height=26 [10..60], base_t=9, crest_t=3.2, arc_deg=70 [30..110], level=...)    (place with a terrain-sampled base)
  solar_array(rows=5 [1..12], cols=12 [1..30], tilt=28 [10..45], pitch_x=3.1, pitch_y=5.2, scale=1 [0.5..4: illustration exaggeration])
  pylon(height=34 [15..60], arm_w=7 [3..12], yaw=0)       and  wires(p0, p1, sag=...)
  terrain(height_fn, x0, x1, y0, y1, cell=4)
Groups (what the ID layer paints): wind, solar, hydro (renewable: green in the final drawing) | pylon, terrain, water, spill (not green)."""
import math
from mesh import Mesh, box, frustum, loft, tube, rot_z, rot_y, rot_x, matmul, mulv, add3


def wind_turbine(height=40.0, blade_len=22.0, rotor_deg=0.0, yaw=0.0, name="turbine", split=None, chord_k=1.35):
    """split="hero": returns [body, blades] as two meshes with groups hero_body / hero_blade (so the drawing can colour the blades only)."""
    H = height; m = Mesh(name, "wind"); L = blade_len; blades_m = Mesh(name + "_blades", "wind") if split else m
    m.merge(frustum((0, 0, 0), 0.042 * H, 0.024 * H, H, n=10))
    m.merge(box((0, 1.1, H + 0.2), (0.06 * H + 1.2, 0.17 * H + 1.8, 0.05 * H + 1.2)))
    hub_y = -0.085 * H - 0.4
    m.merge(frustum((0, 0, 0), 0.032 * H, 0.0, 0.07 * H, n=8, rot=matmul(rot_x(90), ((1, 0, 0), (0, 1, 0), (0, 0, 1)))), loc=(0, hub_y + 0.9, H + 0.3))
    # blades: along +z, chord along x, thickness along y, twisted about their own axis, then spun about the rotor axis (y)
    stations = [(0.00, 0.050, 0.080, 16), (0.12, 0.125, 0.060, 13), (0.35, 0.095, 0.040, 8), (0.65, 0.060, 0.026, 4), (1.00, 0.020, 0.012, 0)]
    for k in range(3):
        rings = []
        for t, chord, thick, tw in stations:
            c = chord * L * chord_k / 2; th = max(thick * L / 2, 0.18); a = math.radians(tw)
            pts = []
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                x, y = sx * c, sy * th
                pts.append((x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a), 0.9 + t * L))
            rings.append(pts)
        b = loft(rings)
        blades_m.merge(b, rot=rot_y(rotor_deg + 120 * k), loc=(0, hub_y, H + 0.3))
    if split:
        ob = Mesh(name + "_body", split + "_body"); ob.merge(m, rot=rot_z(yaw)); ol = Mesh(name + "_blades", split + "_blade"); ol.merge(blades_m, rot=rot_z(yaw)); return [ob, ol]
    out = Mesh(name, "wind"); out.merge(m, rot=rot_z(yaw)); return [out]


def _orient(m, faces_with_dir):
    """Add faces to m, each flipped (if needed) so its normal points along its wanted direction."""
    from mesh import face_normal
    out = []
    for f, want in faces_with_dir:
        n = face_normal([m.v[i] for i in f])
        out.append(f if sum(n[k] * want[k] for k in range(3)) >= 0 else tuple(reversed(f)))
    m.f += out


def arch_dam(cx, cy, base_z, height=26.0, width=60.0, base_t=9.0, crest_t=3.2, arc_deg=70.0, name="dam"):
    """Arch dam convex towards +y (the reservoir). Returns [dam, spillway_flow]. (cx, cy) = crown point of the upstream face at the foot.
    The arc's centre of curvature lies downstream (-y), so the upstream face has radius R and the downstream face R - thickness."""
    a = math.radians(arc_deg / 2); R = (width / 2) / math.sin(a)
    centre = (cx, cy - R)
    levels, segs = 7, 14
    P = lambda th, z, r: (centre[0] + r * math.sin(th), centre[1] + r * math.cos(th), z)
    radial = lambda p: (p[0] - centre[0], p[1] - centre[1], 0.0)
    d = Mesh(name, "hydro"); n = segs + 1
    for k in range(levels):
        u = k / (levels - 1); z = base_z + height * u; t = base_t + (crest_t - base_t) * u ** 0.8
        d.v += [P(-a + 2 * a * j / segs, z, R) for j in range(n)] + [P(-a + 2 * a * j / segs, z, R - t) for j in range(n)]
    ix = lambda k, side, j: k * 2 * n + side * n + j
    fw = []
    for k in range(levels - 1):
        for j in range(segs):
            q = (ix(k, 0, j), ix(k, 0, j + 1), ix(k + 1, 0, j + 1), ix(k + 1, 0, j)); fw.append((q, radial(d.v[q[0]])))
            q = (ix(k, 1, j), ix(k, 1, j + 1), ix(k + 1, 1, j + 1), ix(k + 1, 1, j)); r = radial(d.v[q[0]]); fw.append((q, (-r[0], -r[1], 0.0)))
    top = levels - 1
    for j in range(segs): fw.append(((ix(top, 0, j), ix(top, 1, j), ix(top, 1, j + 1), ix(top, 0, j + 1)), (0, 0, 1)))
    for sj, sgn in ((0, -1), (segs, 1)):
        tang = (math.cos(sgn * a) * sgn, -math.sin(sgn * a) * sgn, 0.0)
        for k in range(levels - 1): fw.append(((ix(k, 0, sj), ix(k, 1, sj), ix(k + 1, 1, sj), ix(k + 1, 0, sj)), (sgn, 0, 0)))
    _orient(d, fw)
    for j in range(1, segs, 2):   # spillway gate piers along the crest
        th = -a + 2 * a * j / segs; pc = P(th, base_z + height + 0.8, R - crest_t * 0.5)
        d.merge(box((0, 0, 0), (2.6, 1.3, 1.6), rot=rot_z(-math.degrees(th))), loc=pc)
    # spillway flow: a ribbon down the middle of the downstream face, widening at the foot
    sp = Mesh("spill", "spill"); z0, z1 = base_z + height * 0.93, base_z + 0.3
    for i in range(9):
        t = i / 8; z = z0 + (z1 - z0) * t
        th = crest_t + (base_t - crest_t) * t ** 0.8; w = 2.4 + 5.0 * t ** 1.5; r = R - th - 0.3 - 4.0 * t ** 3
        sp.v += [(centre[0] - w / 2, centre[1] + r, z), (centre[0] + w / 2, centre[1] + r, z)]
    _orient(sp, [((i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2), (0, -1, 0.3)) for i in range(8)])
    return [d, sp]


def solar_array(rows=5, cols=12, tilt=28.0, pitch_x=3.1, pitch_y=5.2, scale=1.0, name="solar"):
    """Rows of tilted panels on low posts; local origin = centre of the first row's start; rows run along +x, successive rows go +y."""
    m = Mesh(name, "solar")
    pw, pd, th = 2.5, 1.7, 0.09
    for r in range(rows):
        for c in range(cols):
            x = (c - (cols - 1) / 2) * pitch_x; y = r * pitch_y
            rot = rot_x(tilt)  # faces the viewer (-y), high edge at the back (+y)
            m.merge(box((0, 0, 0), (pw, pd, th)), rot=rot, loc=(x, y, 0.9 + 0.5 * pd * math.sin(math.radians(tilt))))
            m.merge(box((0, 0, 0), (0.12, 0.12, 0.9 + pd * math.sin(math.radians(tilt)))), loc=(x - pw * 0.28, y + 0.1, (0.9 + pd * math.sin(math.radians(tilt))) / 2))
            m.merge(box((0, 0, 0), (0.12, 0.12, 0.9)), loc=(x + pw * 0.28, y - 0.4 * pd * math.cos(math.radians(tilt)), 0.45))
    sh = Mesh(name + "_shadow", "shadow")
    for r in range(rows):
        y = r * pitch_y; x0 = -(cols - 1) / 2 * pitch_x - pw / 2; x1 = (cols - 1) / 2 * pitch_x + pw / 2
        sh.add([(x0 + 1.0, y - 3.4, 0.4), (x1 + 1.0, y - 3.4, 0.4), (x1, y + 0.3, 0.4), (x0, y + 0.3, 0.4)], [(0, 1, 2, 3)], outward=False)
        sh.f[-1] = (sh.f[-1][0], sh.f[-1][1], sh.f[-1][2], sh.f[-1][3])
    m.v = [(x * scale, y * scale, z * scale) for x, y, z in m.v]
    sh.v = [(x * scale, y * scale, z) for x, y, z in sh.v]
    return [m, sh]


def pylon(height=34.0, arm_w=7.0, yaw=0.0, name="pylon"):
    """Lattice transmission tower: 4 tapering legs, X bracing in 5 bays, two cross-arms with insulator strings. Returns the tower and the wire anchor points."""
    m = Mesh(name, "pylon"); H = height; w0, w1 = 0.11 * H, 0.03 * H
    leg = lambda z, s: [(sx * (w0 + (w1 - w0) * z / H * 0.9) / 2 * s, sy * (w0 + (w1 - w0) * z / H * 0.9) / 2 * s, z) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    bays = 5
    for b in range(bays + 1):
        z = H * 0.82 * b / bays; r = leg(z, 1)
        for i in range(4): m.merge(tube(r[i], r[(i + 1) % 4], 0.07 * 1.2))
        if b < bays:
            z2 = H * 0.82 * (b + 1) / bays; r2 = leg(z2, 1)
            for i in range(4):
                m.merge(tube(r[i], r2[i], 0.16)); m.merge(tube(r[i], r2[(i + 1) % 4], 0.07)); m.merge(tube(r[(i + 1) % 4], r2[i], 0.07))
    top = leg(H * 0.82, 1); peak = (0, 0, H)
    for p in top: m.merge(tube(p, peak, 0.12))
    anchors = []
    for az, aw in ((H * 0.60, arm_w), (H * 0.80, arm_w * 0.78)):
        zc = az; m.merge(tube((-aw, 0, zc), (aw, 0, zc), 0.14)); m.merge(tube((-aw, 0, zc), (0, 0, zc + 3.2), 0.07)); m.merge(tube((aw, 0, zc), (0, 0, zc + 3.2), 0.07))
        for sx in (-1, 1):
            m.merge(tube((sx * aw, 0, zc), (sx * aw, 0, zc - 2.0), 0.16)); anchors.append((sx * aw, 0, zc - 2.0))
    out = Mesh(name, "pylon"); out.merge(m, rot=rot_z(yaw)); return [out], [mulv(rot_z(yaw), a) for a in anchors]


def wires(p0, p1, sag=2.5, r=0.16, segs=14, name="wire"):
    m = Mesh(name, "pylon"); pts = []
    for i in range(segs + 1):
        t = i / segs; pts.append((p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t - 4 * sag * t * (1 - t)))
    for a, b in zip(pts, pts[1:]): m.merge(tube(a, b, r, 4))
    return [m]


def terrain(fn, x0, x1, y0, y1, cell=4.0, name="terrain"):
    """Low-poly heightfield: a grid of triangles (diagonals alternate) over [x0,x1]x[y0,y1]; flat-shaded in the render."""
    nx = int((x1 - x0) / cell); ny = int((y1 - y0) / cell)
    V = [(x0 + i * cell, y0 + j * cell, fn(x0 + i * cell, y0 + j * cell)) for j in range(ny + 1) for i in range(nx + 1)]
    F = []
    ix = lambda i, j: j * (nx + 1) + i
    for j in range(ny):
        for i in range(nx):
            a, b, c, d = ix(i, j), ix(i + 1, j), ix(i + 1, j + 1), ix(i, j + 1)
            if (i + j) % 2: F += [(a, b, c), (a, c, d)]
            else: F += [(a, b, d), (b, c, d)]
    m = Mesh(name, "terrain"); m.add(V, F, outward=False); return [m]


def reservoir(level, x0, x1, y0, y1, name="reservoir"):
    m = Mesh(name, "water"); m.add([(x0, y0, level), (x1, y0, level), (x1, y1, level), (x0, y1, level)], [(0, 1, 2, 3)], outward=False); return [m]


def _ring(rx, ry, z, n=20, p=2.0, cx=0.0, cy=0.0, tw=0.0):
    """A superellipse section (|x/rx|^p + |y/ry|^p = 1) in the plane z, rotated by tw degrees about z; p=2 ellipse, larger = boxier."""
    pts = []; a = math.radians(tw)
    for j in range(n):
        t = 2 * math.pi * j / n; c, s = math.cos(t), math.sin(t)
        x = rx * math.copysign(abs(c) ** (2 / p), c); y = ry * math.copysign(abs(s) ** (2 / p), s)
        pts.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a), z))
    return pts


def hero_turbine(height=40.0, blade_len=26.0, rotor_deg=0.0, yaw=0.0, pitch=9.0, chord_k=2.3, name="hero"):
    """Organic wind turbine for the cover drawing (smooth-shaded, subdivision-surface meshes): tower with flange rings, a door and a plinth;
    nacelle shell with seam bands and vents; spinner (nose cone); three blades with airfoil sections, round roots and twist along the length.
    Local frame as wind_turbine: origin at the tower foot, rotor axis along -y. Returns meshes with groups hero_body / hero_blade."""
    H = height; r0, r1 = 0.052 * H, 0.030 * H
    body = Mesh(name + "_tower", "hero_body"); body.smooth = True
    zs = [0, 0.04 * H, 0.5 * H, H - 0.02 * H]
    rings = [_ring(r0 * 1.0, r0 * 1.0, 0.0, 24), _ring(r0, r0, 0.8, 24)]
    for k in range(1, 15):
        t = k / 14; rr = r0 + (r1 - r0) * t; rings.append(_ring(rr, rr, 0.8 + (H - 0.8) * t, 24))
    body.merge(loft(rings)); 
    fit = Mesh(name + "_fittings", "hero_body")
    for fz in (0.30 * H, 0.58 * H, 0.84 * H):   # flange rings
        t = fz / H; rr = (r0 + (r1 - r0) * t) * 1.07; fit.merge(loft([_ring(rr, rr, fz - 0.28, 24), _ring(rr, rr, fz + 0.28, 24)]))
    fit.merge(box((0, -(r0 - 0.05), 1.3 + 0.0), (1.5, 0.35, 2.4)))   # access door on the side facing the viewer
    fit.merge(box((0, -(r0 - 0.02), 1.3), (1.1, 0.4, 2.0)))
    fit.merge(frustum((0, 0, 0), r0 * 1.55, r0 * 1.25, 0.9, n=24))   # plinth
    # nacelle shell: y runs front (-) to rear (+); superellipse sections, rounded at the rear
    nac = Mesh(name + "_nacelle", "hero_body"); nac.smooth = True; nac.subsurf = 2
    ny = [(-3.9, 1.55, 1.5), (-2.5, 1.95, 1.9), (0.0, 2.15, 2.05), (3.0, 2.1, 1.95), (5.4, 1.7, 1.55), (6.6, 0.9, 0.85)]
    cz = H + 0.6
    nac.merge(loft([[(px, yy, cz + py) for (px, py, _) in _ring(rx, rz, 0.0, 16, 2.6)] for (yy, rx, rz) in ny]))
    # spinner (nose cone)
    spin = Mesh(name + "_spinner", "hero_body"); spin.smooth = True; spin.subsurf = 2
    sy = [(-3.8, 1.55), (-4.7, 1.62), (-6.0, 1.3), (-7.4, 0.62), (-8.3, 0.12)]
    spin.merge(loft([[(px, yy, cz + py) for (px, py, _) in _ring(rr, rr, 0.0, 16)] for (yy, rr) in sy]))
    for sy_ in (-3.6, 2.2):   # seam bands on the shell
        fit.merge(loft([[(px, sy_ - 0.1, cz + py) for (px, py, _) in _ring(2.0 if sy_ > 0 else 1.7, 1.95 if sy_ > 0 else 1.65, 0.0, 16, 2.6)],
                        [(px, sy_ + 0.1, cz + py) for (px, py, _) in _ring(2.0 if sy_ > 0 else 1.7, 1.95 if sy_ > 0 else 1.65, 0.0, 16, 2.6)]]))
    for i in range(6):   # cooling vents on the top
        fit.merge(box((-1.2 + i * 0.48, 3.4, cz + 2.0), (0.14, 1.6, 0.14)))
    # blades
    blade = Mesh(name + "_blades", "hero_blade"); blade.smooth = True; blade.subsurf = 2
    L = blade_len; hub_y = -4.1
    st = [(0.0, 0.62, 0.62, 0), (0.06, 0.78, 0.7, 6), (0.16, 1.55, 0.55, 14), (0.35, 1.28, 0.42, 9), (0.62, 0.92, 0.30, 4), (0.85, 0.62, 0.20, 1.5), (0.97, 0.36, 0.11, 0), (1.0, 0.16, 0.06, 0)]
    for k in range(3):
        rings = []
        for t, c, th, tw in st:
            n = 18; pts = []; c = c * (chord_k if t > 0.08 else 1.0); th = th * (1 + 0.6 * (chord_k - 1) if t > 0.08 else 1.0)
            for j in range(n):
                u = 2 * math.pi * j / n; cu, su = math.cos(u), math.sin(u)
                x = (c / 2) * cu; y = (th / 2) * su * (1.0 + 0.22 * cu) + 0.07 * c * (1 - cu * cu) * (1 if t > 0.1 else 0)   # airfoil: thick near the leading edge, cambered
                a = math.radians(tw + pitch * (1 - t) * 0.5)
                pts.append((x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a), 1.0 + t * L))
            rings.append(pts)
        b = loft(rings); blade.merge(b, rot=rot_y(rotor_deg + 120 * k), loc=(0, hub_y, cz))
    out = []
    for m in (body, fit, nac, spin, blade):
        o = Mesh(m.name, m.group); o.smooth, o.subsurf = m.smooth, m.subsurf; o.merge(m, rot=rot_z(yaw)); out.append(o)
    return out


def coal_plant(cx=0.0, cy=0.0, base_z=0.0, towers=2, chimney_h=70.0, yaw=0.0, scale=1.0, name="coal"):
    """Old coal power station, drawn as light background lines: hyperboloid cooling towers, one tall chimney, boiler house, turbine hall, conveyor, small stacks.
    Knobs: towers 2 [1..4], chimney_h 70 [40..110]. Everything is built around the plant's own origin, then yawed and moved to (cx, cy, base_z). Group coal."""
    m = Mesh(name, "coal")
    for i in range(towers):
        x = -26 + i * 30; H = 44.0; rb = 12.0
        rings = []
        for k in range(13):
            t = k / 12; z = H * t; r = rb * math.sqrt(1 + ((t - 0.72) / 0.62) ** 2) * 0.62 + 2.0
            rings.append(_ring(r, r, z, 22))
        m.merge(loft(rings), loc=(x, 0, 0))
    m.merge(frustum((8, -2, 0), 3.4, 1.9, chimney_h, n=14))
    m.merge(frustum((8, -2, chimney_h - 5), 2.5, 2.5, 1.0, n=14))   # the red-white bands of the real chimney show as rings
    m.merge(box((24, 10, 15), (22, 18, 30)))
    m.merge(box((24, -12, 8), (34, 14, 16)))
    m.merge(box((38, 0, 5), (10, 36, 10)))
    m.merge(tube((12, 4, 28), (-4, 26, 3), 0.7, 4))   # conveyor
    for dx in (14, 20, 28): m.merge(frustum((dx, 12, 30), 1.0, 0.8, 9.0, n=8))
    m.v = [(x * scale, y * scale, z * scale) for x, y, z in m.v]
    out = Mesh(name, "coal"); out.merge(m, rot=rot_z(yaw), loc=(cx, cy, base_z)); return [out]


def gas_pipe(x0, y0, x1, y1, ground, lift=2.6, r=1.3, supports=12.0, valves=(0.42,), name="gas"):
    """Natural-gas pipeline section on low supports, with flange rings every ~14 m and gate valves (body, bonnet, stem, hand wheel).
    ground(x, y) -> terrain height; the pipe keeps a straight line `lift` above the highest ground under it. valves = positions along the run (0..1). Group coal (drawn pale with the plant)."""
    m = Mesh(name, "coal"); n = max(2, int(math.hypot(x1 - x0, y1 - y0) / supports))
    zs = [ground(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]; zp = max(zs) + lift
    pts = [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]
    L = math.hypot(x1 - x0, y1 - y0); ux, uy = (x1 - x0) / L, (y1 - y0) / L
    m.merge(tube((x0, y0, zp), (x1, y1, zp), r, 10))
    for (x, y), z in zip(pts, zs):   # supports: two posts and a saddle
        m.merge(box((x, y, (z + zp - r) / 2), (0.9, 0.9, zp - r - z)))
        m.merge(box((x, y, zp - r - 0.2), (2.2, 2.2, 0.5)))
    for k in range(1, int(L / 14)):   # flange rings
        t = k * 14 / L; x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        m.merge(tube((x - ux * 0.35, y - uy * 0.35, zp), (x + ux * 0.35, y + uy * 0.35, zp), r * 1.55, 10))
    for v in valves:
        x, y = x0 + (x1 - x0) * v, y0 + (y1 - y0) * v
        m.merge(box((x, y, zp), (3.4, 3.4, 3.4)))                        # valve body
        m.merge(tube((x, y, zp + 1.5), (x, y, zp + 5.2), 0.45, 8))       # stem
        m.merge(frustum((x, y, zp + 1.3), 1.5, 1.2, 0.9, n=10))          # bonnet
        ring = [[(x + c * math.cos(a), y + c * math.sin(a), zp + 5.6 + h) for a in [2 * math.pi * j / 14 for j in range(14)]] for c, h in ((2.2, 0.0), (2.2, 0.35))]
        m.merge(loft(ring))                                               # hand wheel
        m.merge(tube((x - 2.2, y, zp + 5.8), (x + 2.2, y, zp + 5.8), 0.18, 4)); m.merge(tube((x, y - 2.2, zp + 5.8), (x, y + 2.2, zp + 5.8), 0.18, 4))
    return [m]


def gas_valve_hero(length=100.0, r=3.2, lift=4.0, valve_at=0.55, yaw=0.0, tilt=58.0, name="gasvalve"):
    """Close-up hero for a gas story: a thick pipeline run with flange rings and one gate valve. Returns [pipe (group hero_body), valve (group hero_blade = the accent part)].
    Local frame: the pipe runs along x from -length/2 to +length/2 at height `lift` above the ground point (origin)."""
    pipe = Mesh(name + "_pipe", "hero_body"); pipe.smooth = True
    ring = lambda x, rr, n=20: [(x, rr * math.cos(2 * math.pi * j / n), lift + rr * math.sin(2 * math.pi * j / n)) for j in range(n)]
    pipe.merge(loft([ring(-length / 2 + i * length / 20, r) for i in range(21)]))
    fit = Mesh(name + "_fit", "hero_body")
    for k in range(1, 6):   # flange rings
        x = -length / 2 + k * length / 6; fit.merge(loft([ring(x - 0.7, r * 1.35), ring(x + 0.7, r * 1.35)]))
    for k in range(0, 6):   # saddles and posts
        x = -length / 2 + (k + 0.5) * length / 6; fit.merge(box((x, 0, lift / 2 - r * 0.5), (2.4, 2.8 * r * 0.6, lift - r)))
        fit.merge(box((x, 0, lift - r - 0.3), (3.0, 3.6, 0.7)))
    pipe.merge(fit)
    valve = Mesh(name + "_valve", "hero_blade"); valve.smooth = True; valve.subsurf = 1
    vx = -length / 2 + valve_at * length; zc = lift
    valve.merge(box((vx, 0, zc), (r * 2.4, r * 2.4, r * 2.4)))
    valve.merge(frustum((vx, 0, zc + r * 1.1), r * 1.0, r * 0.75, r * 0.9, n=16))
    valve.merge(tube((vx, 0, zc + r * 1.9), (vx, 0, zc + r * 4.6), r * 0.22, 10))
    tl = math.radians(tilt); u = (1.0, 0.0, 0.0); vv = (0.0, math.cos(tl), math.sin(tl)); nn = (0.0, -math.sin(tl), math.cos(tl)); c0 = (vx, 0.0, zc + r * 4.8); R = r * 2.1
    pt = lambda a, h, rad=R: tuple(c0[k] + rad * (math.cos(a) * u[k] + math.sin(a) * vv[k]) + h * nn[k] for k in range(3))
    for j in range(24): valve.merge(tube(pt(2 * math.pi * j / 24, 0.0), pt(2 * math.pi * (j + 1) / 24, 0.0), r * 0.2, 6))   # hand-wheel rim (a ring, tilted towards the viewer, -y)
    valve.merge(tube(pt(0, -r * 0.3, 0.0), pt(0, r * 0.3, 0.0), r * 0.42, 10))   # hub
    for ang in (0, 60, 120): valve.merge(tube(pt(math.radians(ang), 0.0), pt(math.radians(ang + 180), 0.0), r * 0.14, 6))
    valve.merge(tube((vx, 0, zc + r * 4.5), c0, r * 0.3, 8))
    out = []
    for m in (pipe, valve):
        o = Mesh(m.name, m.group); o.smooth, o.subsurf = m.smooth, m.subsurf; o.merge(m, rot=rot_z(yaw)); out.append(o)
    return out
