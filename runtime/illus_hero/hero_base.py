"""Shared helpers of the hero painting (labels from the ids pass, mask -> polygons, ink pen, hatch axis); pure numpy/scipy/shapely."""
import base64, io, json, math, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
import contourpy
from shapely.geometry import Polygon
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import brush as BR

HERE = os.path.dirname(os.path.abspath(__file__)); IN = os.path.join(HERE, "out", "v2")
W, H = 1440, 560
GREEN = "#1a9a6c"
PALETTES = {  # ground dark / mid / light (RGB), line colour on that ground
    "warm": dict(dark=(86, 48, 38), mid=(132, 80, 60), light=(168, 110, 84), line=(48, 26, 20)),
    "cool": dict(dark=(36, 54, 68), mid=(62, 88, 104), light=(98, 126, 140), line=(14, 26, 36))}
BODY = dict(base=(196, 206, 211), dark=(104, 122, 136), light=(232, 238, 240))   # pale cool grey, like the hands in the SCMP cover
BLADE = dict(base=(26, 154, 108), dark=(14, 100, 74), light=(128, 208, 176))     # #1a9a6c and its steps
WID = dict(hero_out=7.0, hero_in=3.4, bg=(1.5, 0.9), terrain=(1.5, 0.9))       # px at 1440 wide (hero_out 0.49 % of the width)
D_NEAR, D_FAR = 90.0, 420.0
OFFSET = (-5.0, 4.0); SEED = 11
rng = np.random.RandomState(SEED)
hexc = lambda c: "#%02x%02x%02x" % tuple(int(round(v)) for v in c)
mix = lambda a, b, t: tuple(x + (y - x) * t for x, y in zip(a, b))


def load_labels():
    a = np.asarray(Image.open(os.path.join(IN, "ids.png")).convert("RGB").resize((W, H), Image.NEAREST)).astype(int)
    cols = json.load(open(os.path.join(IN, "ids.json"))); names = list(cols); C = np.array([cols[n] for n in names])
    lab = (((a[:, :, None, :] - C[None, None, :, :]) ** 2).sum(-1)).argmin(-1)
    return names, np.where((a == 255).all(-1), -1, lab)


def to_geom(mask, simplify=0.8, min_area=40):
    m = np.pad(mask.astype(float), 1); geom = None
    for ring in contourpy.contour_generator(z=m).lines(0.5):
        if len(ring) < 4: continue
        p = Polygon(ring - 1.0).buffer(0)
        if p.is_empty or p.area < min_area: continue
        geom = p if geom is None else geom.symmetric_difference(p)
    return None if geom is None or geom.is_empty else geom.simplify(simplify)


def polys(g): return [] if g is None else ([g] if g.geom_type == "Polygon" else [p for p in g.geoms if p.geom_type == "Polygon"])


def wobble(ring, amp, k=9):
    p = np.array(ring); n = len(p)
    return p if n < 6 else p + np.c_[BR.smooth_noise(rng, n, k) * amp, BR.smooth_noise(rng, n, k) * amp]


def pd(poly, off=(0, 0), amp=0.0):
    d = []
    for ring in [poly.exterior] + list(poly.interiors):
        q = wobble(ring.coords[:-1], amp) if amp else np.array(ring.coords[:-1])
        d.append("M" + "L".join(f"{x + off[0]:.1f},{y + off[1]:.1f}" for x, y in q) + "Z")
    return "".join(d)


def ink_stroke(pts, widths, jit, tin=14.0, tout=22.0):
    xy = np.array(pts); p = BR.resample(pts, 2.2); n = len(p)
    if n < 3: return ""
    d0 = np.r_[0, np.cumsum(np.hypot(*np.diff(xy, axis=0).T))]; d1 = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    w = np.interp(d1 / (d1[-1] or 1) * d0[-1], d0, widths)
    tg = np.gradient(p, axis=0); ln = np.hypot(*tg.T); ln[ln == 0] = 1; nr = np.c_[-tg[:, 1] / ln, tg[:, 0] / ln]
    p = p + nr * (BR.smooth_noise(rng, n) * jit)[:, None]; L = d1[-1]
    tap = np.clip(np.minimum(d1 / min(tin, L * 0.4 + 1e-6), (L - d1) / min(tout, L * 0.5 + 1e-6)), 0, 1) ** 0.6
    w = np.maximum(w * (0.3 + 0.7 * tap) * (1 + 0.2 * BR.smooth_noise(rng, n, 5)), 0.4)
    q = np.vstack([p + nr * (w / 2)[:, None], (p - nr * (w / 2)[:, None])[::-1]])
    return "M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in q) + "Z"


def component_axis(mask):
    ys, xs = np.nonzero(mask)
    if len(xs) < 10: return 90.0
    c = np.cov(np.c_[xs, ys].T); w, v = np.linalg.eigh(c); ax = v[:, 1]
    return math.degrees(math.atan2(ax[1], ax[0]))


MOT = ndi.gaussian_filter(np.random.RandomState(8).normal(0, 1, (H, W)), 6); MOT /= MOT.std()


