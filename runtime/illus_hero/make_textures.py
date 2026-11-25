"""Writes the two paper textures of the opening picture (assets/crumple.jpg and assets/tooth.jpg) from seeded noise: no third-party material.
Run: python3 make_textures.py [out dir]   (default: the assets folder next to this file). The output is the same on every run.
hero_node.py reads them as grey fields: crumple (1440x560) is high-passed at a large radius and lightly blurred, so what counts is its
mid-scale unevenness and creases; tooth (2880x1120) is high-passed at a small radius, so what counts is its fine, slightly horizontal grain."""
import os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi


def norm(a):
    return (a - a.mean()) / a.std()


def crumple(w=1440, h=560, seed=11):
    r = np.random.RandomState(seed)
    f = sum(wt * norm(ndi.gaussian_filter(r.normal(0, 1, (h, w)), s, mode="wrap")) for wt, s in ((0.55, 40), (0.8, 16), (0.5, 7)))
    ridge = 1.0 - np.abs(norm(ndi.gaussian_filter(r.normal(0, 1, (h, w)), 9, mode="wrap")))     # creases: thin bright ridges where the smooth noise crosses zero
    f = norm(f) + 1.3 * norm(ridge)
    return norm(f)


def tooth(w=2880, h=1120, seed=23):
    r = np.random.RandomState(seed)
    fine = norm(ndi.gaussian_filter(r.normal(0, 1, (h, w)), (0.7, 1.6), mode="wrap"))           # fibres lie slightly along x
    mid = norm(ndi.gaussian_filter(r.normal(0, 1, (h, w)), (2.2, 5.0), mode="wrap"))
    return norm(fine + 0.5 * mid)


def to_jpeg(f, path, lo=70, hi=186, q=88):
    g = np.clip(128 + 38 * np.clip(f, -3, 3) / 3 * 1.0, 0, 255)
    g = np.clip(lo + (g - g.min()) / (g.max() - g.min()) * (hi - lo), 0, 255).astype(np.uint8)
    Image.fromarray(g, "L").convert("RGB").save(path, "JPEG", quality=q)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
    to_jpeg(crumple(), os.path.join(out, "crumple.jpg"))
    to_jpeg(tooth(), os.path.join(out, "tooth.jpg"))
