"""Illustration node, post-process:   python3 -I hero_node.py <scene.json>   (rt-py313)
Same painting code as hero5.py (v5 look), but nothing about the topic is fixed here: ground palette, accent colour (-> a 5-step ramp generated from one hex), smoke on/off and the output folder come from <scene.json>
(written by run_node.py). In : <out>/{strokes.json, shade.png, ids.png, ids.json, hub.json}   Out: <out>/hero.svg, <out>/hero-stats.json."""
import base64, io, json, math, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import hero_base as H2
from hero_base import BR, to_geom, polys, pd, ink_stroke, hexc, mix, W, H, PALETTES, GREEN
CFG = json.load(open(sys.argv[1])); H2.IN = CFG["out"]
import colorsys
rng = np.random.RandomState(CFG.get("seed", 21))


def accent_steps(hexcol):
    """One accent hex -> shadow / dark / base / light / hi + the warm reflected colour: hue drifts cooler in the shade and warmer in the light, as in the v5 green ramp."""
    r, g, b = (int(hexcol[i:i + 2], 16) / 255 for i in (1, 3, 5)); h, l, sat = colorsys.rgb_to_hls(r, g, b)
    mk = lambda dh, lk, sk: tuple(round(255 * c) for c in colorsys.hls_to_rgb((h + dh) % 1.0, min(max(l * lk if lk < 1 else l + (1 - l) * (lk - 1), 0), 1), min(sat * sk, 1)))
    return dict(shadow=mk(-0.045, 0.40, 0.95), dark=mk(-0.02, 0.68, 0.95), base=mk(0, 1.0, 1.0), light=mk(0.07, 1.30, 0.85), hi=mk(0.09, 1.70, 0.55))
ASSETS = os.path.join(HERE, "assets")
RASTER_SCALE = int(CFG.get("raster_scale", 1)); JPEG_Q = int(CFG.get("jpeg_quality", 80))   # the passes are made at 2x; the embedded rasters are kept at 1x (page weight) unless raster_scale is 2


def shrink(im):
    """The embedded raster at the viewBox size (raster_scale 1) or as made (2)."""
    return im if RASTER_SCALE == 2 else im.resize((W, H), Image.LANCZOS)

BLADE = accent_steps(CFG["accent"]); BLADE["warm"] = tuple(CFG["palette"]["light"])
BODY = dict(shadow=(82, 100, 120), dark=(128, 146, 160), base=(198, 207, 212), light=(232, 238, 238), hi=(250, 248, 240), warm=(190, 120, 92))
CUTS = (0.16, 0.36, 0.68, 0.90)       # quantiles of the shade inside a part: shadow | dark | base | light | highlight
OFFSET = (-4.0, 3.0)


def paper_field(name, size, lo_sigma=None):
    f = [x for x in os.listdir(ASSETS) if x.endswith(name)] if False else None
    path = os.path.join(ASSETS, name)
    im = Image.open(path).convert("L").resize(size, Image.LANCZOS); a = np.asarray(im).astype(float)
    return a


def ground_jpeg3(pal):
    h, w = H * 2, W * 2; r = np.random.RandomState(4)
    crumple = paper_field("crumple.jpg", (w, h)); crumple = (crumple - ndi.gaussian_filter(crumple, 80)); crumple = ndi.gaussian_filter(crumple, 2.0); crumple /= crumple.std()
    tooth = paper_field("tooth.jpg", (w, h)); tooth = tooth - ndi.gaussian_filter(tooth, 6); tooth /= tooth.std()
    blob1 = ndi.gaussian_filter(r.normal(0, 1, (h, w)), 110); blob1 /= blob1.std()
    blob2 = ndi.gaussian_filter(r.normal(0, 1, (h, w)), 34); blob2 /= blob2.std()
    grain = ndi.gaussian_filter(r.normal(0, 1, (h, w)), 0.9); grain /= grain.std()
    t = np.clip(0.5 + 0.10 * blob1 + 0.06 * blob2 + 0.075 * crumple + 0.05 * tooth + 0.018 * grain, 0, 1)
    d, m, l = (np.array(pal[k], float) for k in ("dark", "mid", "light"))
    lo = np.clip(t * 2, 0, 1)[..., None]; hi = np.clip(t * 2 - 1, 0, 1)[..., None]
    img = np.where(t[..., None] < 0.5, d + (m - d) * lo, m + (l - m) * hi)
    buf = io.BytesIO(); shrink(Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))).save(buf, "JPEG", quality=JPEG_Q); return base64.b64encode(buf.getvalue()).decode(), tooth, crumple


def wash_granulation(w, h):
    """Pigment granulation from a CC0 ink-wash scan (Cleveland Museum of Art 2022.151, dry-brush/): crop of the mountain washes, high-passed, tiled with flips to w x h."""
    a = Image.open(os.path.join(ASSETS, "wash.jpg")).convert("L")
    t = np.asarray(a).astype(float); t = t - ndi.gaussian_filter(t, 18); t /= t.std()
    reps_y, reps_x = -(-h // t.shape[0]), -(-w // t.shape[1]); rows = []
    for i in range(reps_y):
        row = [t[:, ::-1] if (i + j) % 2 else t for j in range(reps_x)]; rows.append(np.hstack(row)[:, :w] if i % 2 == 0 else np.hstack(row)[:, :w][::-1])
    return np.vstack(rows)[:h, :w]


def grain_layer(mask, tooth, crumple, pal):
    """RGBA raster over the hero: dark granulation where the tooth is high, ground-colour dry-brush gaps (long streaky holes) with alpha only inside the hero."""
    h, w = H * 2, W * 2; m2 = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)).astype(float) / 255
    r = np.random.RandomState(9)
    streak = ndi.gaussian_filter(r.normal(0, 1, (h, w)), (1.1, 30)); streak /= streak.std()
    gap = np.clip((streak - 1.45) * 1.6, 0, 1) * m2                  # dry-brush gaps: ground colour shows through
    gran = np.clip((tooth - 0.6) * 0.5, 0, 1) * m2 * 0.35 + np.clip((-crumple - 0.8) * 0.3, 0, 1) * m2 * 0.25
    wg = wash_granulation(w, h); dark_g = np.clip(-wg - 0.35, 0, 1) * 0.12 * m2; pale_g = np.clip(wg - 0.7, 0, 1) * 0.10 * m2
    g = np.array(pal["mid"], float); rgba = np.zeros((h, w, 4), np.uint8)
    base_rgb = np.where((gap > 0)[..., None], g, np.array([24, 20, 16]))
    a_dark = np.maximum(np.maximum(gap * 0.75, gran), dark_g)
    rgb = np.where((pale_g > a_dark)[..., None], np.array([255, 248, 236]), base_rgb)
    rgba[..., :3] = rgb; rgba[..., 3] = np.clip(np.maximum(a_dark, pale_g) * 255, 0, 255).astype(np.uint8)
    buf = io.BytesIO(); shrink(Image.fromarray(rgba, "RGBA")).save(buf, "PNG", optimize=True); return base64.b64encode(buf.getvalue()).decode()


def paint3(mask, shade, steps):
    out = []; L = ndi.gaussian_filter(shade, 1.2)
    lab_img, nlab = ndi.label(ndi.binary_closing(mask, iterations=2))
    for ci in range(1, nlab + 1):
        cm = lab_img == ci
        if cm.sum() < 300: continue
        v = np.sort(L[cm]); q = [v[min(int(c * len(v)), len(v) - 1)] for c in CUTS]
        for p in polys(to_geom(cm, 1.0, 60)): out.append(f'<path d="{pd(p, OFFSET, 1.3)}" fill="{hexc(steps["base"])}"/>')
        bands = ((L <= q[1], "dark", 0.95, 0.5), (L <= q[0], "shadow", 0.95, 0.65), (L >= q[2], "light", 0.92, 0.7), (L >= q[3], "hi", 0.92, 0.85))
        for sel, key, op, kk in bands:
            s = ndi.binary_opening(cm & sel, iterations=1)
            for p in polys(to_geom(s, 1.0, 40)): out.append(f'<path d="{pd(p, (OFFSET[0] * kk, OFFSET[1] * kk), 1.0)}" fill="{hexc(steps[key])}" opacity="{op}"/>')
        edge = ndi.distance_transform_edt(cm) < 7                     # reflected warm light on the underside, near the edge
        refl = cm & edge & (L <= q[1])
        for p in polys(to_geom(ndi.binary_opening(refl, iterations=1), 1.0, 30)): out.append(f'<path d="{pd(p, OFFSET, 1.0)}" fill="{hexc(steps["warm"])}" opacity="0.5"/>')
        hl = ndi.binary_opening(cm & (L >= q[3]), iterations=1); lab2, n2 = ndi.label(hl); hi = []
        for cj in range(1, n2 + 1):
            sub = lab2 == cj
            if sub.sum() < 60: continue
            ang = H2.component_axis(sub)
            for p in polys(to_geom(sub, 1.0, 30)): hi += BR.hatch(list(p.exterior.coords), ang, 5.5, rng, 2.2, shrink=1.0, cut=0.4, gap_jit=0.45)
        out.append(f'<path d="{"".join(hi)}" fill="#fff8ec" opacity="0.8"/>')
    return out


def ink_stroke_lf(pts, widths, tin, tout):
    """Pen stroke with LOW-frequency irregularity (a slow drift of the line, k=16 samples, about 2 px) plus a little fine wobble; width follows `widths` (already pulsing slowly)."""
    xy = np.array(pts); p = BR.resample(pts, 2.2); n = len(p)
    if n < 3: return ""
    d0 = np.r_[0, np.cumsum(np.hypot(*np.diff(xy, axis=0).T))]; d1 = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    w = np.interp(d1 / (d1[-1] or 1) * d0[-1], d0, widths)
    tg = np.gradient(p, axis=0); ln = np.hypot(*tg.T); ln[ln == 0] = 1; nr = np.c_[-tg[:, 1] / ln, tg[:, 0] / ln]
    p = p + nr * (BR.smooth_noise(rng, n, 16) * 2.6 + BR.smooth_noise(rng, n, 4) * 0.6)[:, None]; L = d1[-1]
    tap = np.clip(np.minimum(d1 / min(tin, L * 0.4 + 1e-6), (L - d1) / min(tout, L * 0.5 + 1e-6)), 0, 1) ** 0.6
    w = np.maximum(w * (0.3 + 0.7 * tap), 0.4)
    q = np.vstack([p + nr * (w / 2)[:, None], (p - nr * (w / 2)[:, None])[::-1]])
    return "M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in q) + "Z"


def dry_masks():
    """Dry-brush (kasure) masks for the hero outline: bristle-streak texture taken from the solid brush stroke of a CC0 Cleveland calligraphy scan (ink-line/CMA-2003-353), high-passed, thresholded into
    sparse gaps, tiled to the canvas; rotated per stroke direction class (h: horizontal, v: vertical, d: diagonal) so the streaks run along the stroke. White = ink stays, black = gap."""
    a = Image.open(os.path.join(ASSETS, "brush.jpg")).convert("L")
    t = np.asarray(a).astype(float); hp = t - ndi.gaussian_filter(t, 10); hp /= hp.std()
    gap = np.clip((hp - 0.55) * 0.9, 0, 1)                      # lighter-than-neighbourhood bristle lines become gaps
    out = {}
    for key, ang in (("v", 0), ("h", 90), ("d", 45)):
        g = ndi.rotate(gap, ang, reshape=False, order=1, mode="reflect")
        reps = (-(-H // g.shape[0]), -(-W // g.shape[1])); tile = np.tile(np.hstack([g, g[:, ::-1]]), (1, -(-reps[1] // 2)))
        tile = np.vstack([tile, tile[::-1]] * (-(-reps[0] // 2)))[:H, :W]
        m = np.clip(1 - tile * 1.0, 0, 1)
        buf = io.BytesIO(); Image.fromarray((m * 255).astype(np.uint8), "L").save(buf, "PNG", optimize=True); out[key] = base64.b64encode(buf.getvalue()).decode()
    return out


RAMP = [(0.0, BLADE["shadow"]), (0.28, BLADE["dark"]), (0.55, BLADE["base"]), (0.80, BLADE["light"]), (1.0, BLADE["hi"])]


def ramp(t):
    out = np.zeros(t.shape + (3,))
    for c in range(3): out[..., c] = np.interp(t, [p for p, _ in RAMP], [col[c] for _, col in RAMP])
    return out


def paint_blades(mask, shade, hub, pal):
    """Blades: (1) a smooth tone ramp from the Blender shade (rank-normalised inside the blades, blurred) mapped to the hue steps, printed 2x as RGBA, off-register,
    edge displaced by slow noise, warm ground-reflected light near the lower edge; (2) irregular dry-brush strokes that follow the blade (radial from the hub): random length, width and opacity,
    lighter strokes in the lit part, darker in the shadow part, a few white ones at the top of the lights."""
    h, w = H * 2, W * 2; cm = ndi.binary_closing(mask, iterations=2)
    L = ndi.gaussian_filter(shade, 4.0); v = np.sort(L[cm]); t = np.clip(np.interp(L, v, np.linspace(0, 1, len(v))), 0, 1)
    rgb = ramp(t)
    edge = np.clip(1 - ndi.distance_transform_edt(cm) / 9.0, 0, 1) * (1 - t) ** 1.0 * 0.45
    rgb = rgb * (1 - edge[..., None]) + np.array(BLADE["warm"]) * edge[..., None]
    big = np.asarray(Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)).astype(float)
    alpha = ndi.gaussian_filter(np.asarray(Image.fromarray((cm * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)).astype(float) / 255, 1.2)
    r = np.random.RandomState(5); dx = ndi.gaussian_filter(r.normal(0, 1, (h, w)), 24) * 60; dy = ndi.gaussian_filter(r.normal(0, 1, (h, w)), 24) * 60
    yy, xx = np.mgrid[0:h, 0:w]; sx = xx - dx + 2 * OFFSET[0]; sy = yy - dy + 2 * OFFSET[1]
    out = np.zeros((h, w, 4), np.uint8)
    for c in range(3): out[..., c] = np.clip(ndi.map_coordinates(big[..., c], [sy, sx], order=1, mode="nearest"), 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(ndi.map_coordinates(alpha, [sy, sx], order=1, mode="constant") * 255, 0, 255).astype(np.uint8)
    buf = io.BytesIO(); shrink(Image.fromarray(out, "RGBA")).save(buf, "PNG", optimize=True)
    layers = [f'<image href="data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}" width="{W}" height="{H}" preserveAspectRatio="none"/>']
    ys, xs = np.nonzero(cm); rr = np.random.RandomState(14); groups = {"light": [], "dark": [], "white": []}
    for _ in range(430):
        i = rr.randint(len(xs)); px, py = float(xs[i]), float(ys[i]); tt = t[int(py), int(px)]
        dxh, dyh = px - hub[0], py - hub[1]; n = math.hypot(dxh, dyh) or 1; a = math.atan2(dyh, dxh) + math.radians(rr.normal(0, 2.2)); u = (math.cos(a), math.sin(a))
        Ls = rr.uniform(25, 150); pts = [(px, py)]; x, y = px, py
        for _s in range(int(Ls / 3)):
            x += u[0] * 3; y += u[1] * 3
            if not (0 <= int(y) < H and 0 <= int(x) < W and cm[int(y), int(x)]): break
            pts.append((x, y))
        if len(pts) < 5: continue
        wd = np.full(len(pts), rr.uniform(1.0, 3.6)); pth = ink_stroke(pts, wd, 0.5, 8, 14)
        if not pth: continue
        key = "white" if (tt > 0.88 and rr.rand() < 0.5) else "light" if tt > 0.5 else "dark"
        groups[key].append(pth)
    tr = f'transform="translate({OFFSET[0] * .5:.1f},{OFFSET[1] * .5:.1f})"'
    layers.append(f'<path d="{"".join(groups["dark"])}" fill="{hexc(BLADE["shadow"])}" opacity="0.30" {tr}/><path d="{"".join(groups["light"])}" fill="{hexc(BLADE["hi"])}" opacity="0.38" {tr}/><path d="{"".join(groups["white"])}" fill="#fff8ec" opacity="0.72" {tr}/>')
    return layers


def build():
    pal = {k: tuple(v) for k, v in CFG["palette"].items()}; line = hexc(pal["line"]); IN = H2.IN
    names, lab = H2.load_labels(); idx = lambda n: names.index(n) if n in names else None
    shade = np.asarray(Image.open(os.path.join(IN, "shade.png")).convert("L").resize((W, H), Image.LANCZOS)).astype(float) / 255
    S = json.load(open(os.path.join(IN, "strokes.json"))); k = W / S["w"]
    gj, tooth, crumple = ground_jpeg3(pal)
    layers = [f'<defs><linearGradient id="wash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{hexc(pal["light"])}" stop-opacity="0.34"/><stop offset="0.75" stop-color="{hexc(pal["light"])}" stop-opacity="0"/></linearGradient></defs>',
              f'<image href="data:image/jpeg;base64,{gj}" width="{W}" height="{H}" preserveAspectRatio="none"/>']
    wash = []
    for g in ("terrain", "hydro", "water", "coal"):
        if idx(g) is None: continue
        wash += [f'<path d="{pd(p, (0, 0), 1.2)}"/>' for p in polys(to_geom(ndi.binary_opening(lab == idx(g), iterations=1), 1.5, 80))]
    layers.append(f'<g fill="url(#wash)">{"".join(wash)}</g>')
    if idx("shadow") is not None:
        sh = "".join(f'<path d="{pd(p, (0, 0), 0.8)}"/>' for p in polys(to_geom(lab == idx("shadow"), 1.0, 30)))
        layers.append(f'<g fill="{hexc(pal["dark"])}" opacity="0.5">{sh}</g>')
    bg = []
    for g, ang, gap, wd in (("hydro", 0, 6.0, 0.9), ("spill", 90, 3.0, 0.9), ("water", 0, 8.0, 0.7)):
        if idx(g) is None: continue
        for p in polys(to_geom(lab == idx(g), 1.0, 40)): bg += BR.hatch(list(p.exterior.coords), ang, gap, rng, wd, shrink=1.0, cut=0.35, gap_jit=0.4)
    layers.append(f'<path d="{"".join(bg)}" fill="{line}" opacity="0.6"/>')
    if idx("hydro") is not None:
        ol = "".join(f'<path d="{pd(p, (0, 0), 0.8)}"/>' for p in polys(to_geom(lab == idx("hydro"), 1.0, 40)))
        layers.append(f'<g fill="none" stroke="{line}" stroke-width="1.4" stroke-linejoin="round" opacity="0.8">{ol}</g>')
    HUB = json.load(open(os.path.join(IN, "hub.json"))); hero = []
    if idx("hero_body") is not None: hero += paint3(lab == idx("hero_body"), shade, BODY)
    if idx("hero_blade") is not None: hero += paint_blades(lab == idx("hero_blade"), shade, (HUB["x"] * W / HUB["w"], HUB["y"] * H / HUB["h"]), pal)
    layers += hero
    hm = (lab == idx("hero_body")) | (lab == idx("hero_blade"))
    layers.append(f'<image href="data:image/png;base64,{grain_layer(ndi.binary_dilation(hm, iterations=2), tooth, crumple, pal)}" width="{W}" height="{H}" preserveAspectRatio="none"/>')
    G = {"hero_out": [], "hero_in": [], "bg_far": [], "bg_near": [], "coal": []}; DIRS = {"h": [], "v": [], "d": []}
    widths = {"hero_out": [], "hero_in": [], "bg": [], "coal": []}
    for s in S["strokes"]:
        pts = s["pts"]
        if len(pts) < 2: continue
        xy = [(p[0] * k, (S["h"] - p[1]) * k) for p in pts]
        if sum(math.dist(a, b) for a, b in zip(xy, xy[1:])) < 4: continue
        d = np.array([-p[5] for p in pts]); t = np.clip((d - H2.D_NEAR) / (H2.D_FAR - H2.D_NEAR), 0, 1); ls = s["ls"]
        if ls in ("hero_out", "hero_in"):
            w = H2.WID[ls] * np.clip(1 + 0.40 * BR.smooth_noise(rng, len(pts), 10), 0.55, 1.5); widths[ls] += list(w)
            pth = ink_stroke_lf(xy, w, 26.0 if ls == "hero_out" else 14.0, 36.0 if ls == "hero_out" else 22.0)
            if not pth: continue
            if ls == "hero_in": G[ls].append(pth); continue
            dx, dy = xy[-1][0] - xy[0][0], xy[-1][1] - xy[0][1]; n = math.hypot(dx, dy) or 1
            DIRS["h" if abs(dx) / n > 0.8 else "v" if abs(dy) / n > 0.8 else "d"].append(pth)
        else:   # background and coal plant: one pass, 0.9-1.5 px, same strength
            near, far = H2.WID["bg"]; w = (near + (far - near) * t) * np.clip(1 + 0.2 * BR.smooth_noise(rng, len(pts), 3), 0.8, 1.2); widths["bg"] += list(w)
            pth = ink_stroke(xy, w, 0.9, 14, 22)
            if not pth: continue
            G["coal" if ls == "coal" else ("bg_far" if t.mean() > 0.5 else "bg_near")].append(pth)
    # smoke: one grey wisp from the chimney top (the only grey block in the picture)
    if CFG.get("smoke", True) and idx("coal") is not None:
        cm = lab == idx("coal"); ys_, xs_ = np.nonzero(cm)
        if len(ys_):
            y0 = ys_.min(); x0 = xs_[ys_ < y0 + 4].mean(); n = 36; c = []
            for i in range(n + 1):
                u = i / n; c.append((x0 + 150 * u + 16 * math.sin(3.4 * u), y0 - 6 - 80 * u, 8.0 + 70 * u ** 0.85))
            cc = np.array([(x, y) for x, y, _ in c]); ww = np.array([w for _, _, w in c]); tg = np.gradient(cc, axis=0); ln = np.hypot(*tg.T); nr = np.c_[-tg[:, 1] / ln, tg[:, 0] / ln]
            nz = BR.smooth_noise(rng, n + 1, 3) * 6.0
            Lp = cc + nr * (ww / 2 + nz)[:, None]; Rp = cc - nr * (ww / 2 - nz)[:, None]
            smoke = "M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in np.vstack([Lp, Rp[::-1]])) + "Z"
            layers.insert(len(layers), f'<path d="{smoke}" fill="#a8a29c" opacity="0.40"/>')
    layers.append(f'<path d="{"".join(G["coal"])}" fill="{line}" opacity="0.8"/>')
    layers.append(f'<path d="{"".join(G["bg_far"])}" fill="{line}" opacity="0.55"/><path d="{"".join(G["bg_near"])}" fill="{line}" opacity="0.88"/>')
    masks = dry_masks(); defs = "".join(f'<mask id="dry_{k_}" maskUnits="userSpaceOnUse" x="0" y="0" width="{W}" height="{H}"><image href="data:image/png;base64,{v_}" width="{W}" height="{H}" preserveAspectRatio="none"/></mask>' for k_, v_ in masks.items())
    layers.insert(0, f"<defs>{defs}</defs>")
    layers.append(f'<path d="{"".join(G["hero_in"])}" fill="#14100e"/>')
    layers.append("".join(f'<path d="{"".join(DIRS[k_])}" fill="#14100e" mask="url(#dry_{k_})"/>' for k_ in ("h", "v", "d")))
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">' + "".join(layers) + "</svg>"
    open(os.path.join(IN, "hero.svg"), "w").write(svg)
    ys, xs = np.nonzero(hm); allw = np.array(widths["hero_out"] + widths["hero_in"] + widths["bg"])
    st = dict(svg_kb=len(svg) // 1024, hero_mask_area_pct=round(float(hm.mean() * 100), 1), hero_bbox_area_pct=round(float((xs.max() - xs.min()) * (ys.max() - ys.min()) / (W * H) * 100), 1),
              pen_pct_of_w=dict(hero_out=round(H2.WID["hero_out"] / W * 100, 2), hero_in=round(H2.WID["hero_in"] / W * 100, 2), median_all_vertices=round(float(np.median(allw) / W * 100), 3)))
    json.dump(st, open(os.path.join(IN, "hero-stats.json"), "w"), indent=1); print(json.dumps(st))


if __name__ == "__main__":
    build()
