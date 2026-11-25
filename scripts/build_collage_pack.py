"""Builds the engraving cut-out pack of the opening picture's collage renderer (runtime/illus_hero/collage): pack.bin, pack.json,
LICENSES.tsv and the two licence text copies. Run once at ingest time, never at run time (the renderer itself reads the pack with the
standard library only and does no pixel work).

Rerun:  python3 -I -B scripts/build_collage_pack.py <cutouts-dir> [out-dir]
  <cutouts-dir>: the folder of the cut-outs (index.tsv; <id>.png, an RGBA cut-out whose three colour channels are the engraving's grey and
                 whose alpha is the figure's outline; <id>_mask.png, an 8-bit mask of the figure's clothing), plus the Met Open Access
                 README (LICENCE-met-openaccess-README.txt) and the CC0 1.0 legal code (LICENSE-CC0-1.0-legalcode.txt).
  [out-dir]:     default runtime/illus_hero/collage next to this script.
Needs Pillow, numpy and scipy (an ingest-time environment, not the run's). The output is the same on every run for the same input.

What it writes, per figure (the single full-length figures of Miguel Gamborino's street-cries series, The Metropolitan Museum of Art,
CC0; the five pieces marked unusable below are left out), in three size tiers (l, m, s: at most 480, 240 and 120 px high):
  lines: the engraving as ink over transparency (grey + alpha PNG: the grey a fixed ink, the alpha the line darkness times the outline,
         in 32 levels), so the paper between the lines is transparent and whatever lies under it (paper or the accent) shows through;
  sil:   the figure's outline, 1-bit (the paper-coloured block that hides the figures behind it is cut by it);
  cloth: the clothing, 1-bit (softened as the reference picture softened it), for the figures whose clothing mask is usable.
Shared pieces: the paper (a smooth JPEG with the vignette), the grain (a JPEG used as a mask over the whole picture) and the foot shadow
(a soft ellipse PNG), all three generated from seeded noise or geometry, no third-party material.
pack.json indexes every piece (id, figure, tier, kind, offset, len, sha256, w, h, foot_y, facing, red_ok) and every figure (its red_ok,
clothing solidity and share, and a 16x40 occupancy grid of its outline and its clothing, which the renderer uses to keep the accent
figures' clothing in view)."""
import csv
import hashlib
import io
import json
import os
import shutil
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

UNUSABLE = {"856582_1", "856578_3", "856581_1", "856580_3", "856576_1"}       # cut badly (limbs lost or two figures merged)
RED_UNSUITABLE = {"856582_2", "856592_2"}   # the clothing mask reaches the face (a load carried above the head makes the outline taller)
TIERS = (("l", 480), ("m", 240), ("s", 120))
LEVELS = 32                 # alpha levels of a lines piece
INK = 42                    # the grey of the engraving lines
GRID = (16, 40)             # occupancy grid of a figure (columns, rows)
W, H = 1440, 560
PAPER = np.array([236, 230, 220], float)
GRAIN_OPACITY = 0.12        # the grain mask's full value; the renderer paints the grain at this opacity
CLOTH_SOFT = 3.0            # the reference picture's clothing softening (gaussian sigma at the large tier, then a 0.5 cut)
RED_OK = 0.42               # a figure's clothing solidity at or above this: its clothing reads as one block of colour
CLOTH_SHARE = (0.08, 0.9)   # a clothing mask covering less or more of the outline than this is not usable
MET = "https://www.metmuseum.org/art/collection/search/"
CC0 = "https://creativecommons.org/publicdomain/zero/1.0/"


def png(im):
    b = io.BytesIO(); im.save(b, "PNG", optimize=True); return b.getvalue()


def jpeg(im, q):
    b = io.BytesIO(); im.save(b, "JPEG", quality=q, optimize=True, progressive=False); return b.getvalue()


def solidity(cloth, sil):
    """How much the clothing reads as one block (the reference picture's measure, at a 300 px height): the largest connected part's share of
    its bounding box, times its share of all clothing, times the clothing's share of the outline up to 0.45."""
    lab, n = ndi.label(cloth)
    if n == 0: return 0.0
    sz = ndi.sum(cloth, lab, range(1, n + 1)); big = lab == (int(np.argmax(sz)) + 1)
    ys, xs = np.nonzero(big); bb = (ys.max() - ys.min() + 1) * (xs.max() - xs.min() + 1)
    return float((big.sum() / bb) * (sz.max() / sz.sum()) * min(1.0, cloth.sum() / max(1, sil.sum()) / 0.45))


def grid_hex(mask):
    """A boolean mask as the 16x40 occupancy grid (a cell is set when over half of it is set), row-major bits packed into hex."""
    gw, gh = GRID; im = Image.fromarray((mask * 255).astype(np.uint8)).resize((gw, gh), Image.BOX)
    bits = (np.asarray(im) > 127).astype(np.uint8).ravel()
    return np.packbits(bits).tobytes().hex()


def figure_pieces(src, pid):
    """The pieces of one figure in its three tiers, and its figure entry (red_ok: a usable clothing mask that reads as one block and stays off the face)."""
    im = Image.open(os.path.join(src, f"{pid}.png")).convert("RGBA"); cm = Image.open(os.path.join(src, f"{pid}_mask.png")).convert("L")
    out = []; info = {}
    for tier, cap in TIERS:
        h = min(cap, im.height); w = max(1, round(im.width * h / im.height))
        r = im.resize((w, h), Image.LANCZOS); c = cm.resize((w, h), Image.LANCZOS)
        g = np.asarray(r.getchannel("R")) / 255.0; a = np.asarray(r.getchannel("A")) / 255.0
        al = np.round(np.clip((1 - g) * a, 0, 1) * (LEVELS - 1)) / (LEVELS - 1)
        lines = Image.fromarray(np.stack([np.full(al.shape, INK, np.uint8), (al * 255).round().astype(np.uint8)], -1), "LA")
        sil = a > 0.5
        if tier == "l":
            cloth = (ndi.gaussian_filter((np.asarray(c) / 255.0), CLOTH_SOFT) > 0.5) & sil
            big_cloth = cloth
            share = float(cloth.sum() / max(1, sil.sum()))
            s300 = 300 / h
            sz = (max(1, round(w * s300)), 300)
            sil300 = np.asarray(Image.fromarray((sil * 255).astype(np.uint8)).resize(sz, Image.LANCZOS)) > 127
            cl300 = np.asarray(Image.fromarray((cloth * 255).astype(np.uint8)).resize(sz, Image.LANCZOS)) > 127
            sol = solidity(cl300, sil300)
            usable = CLOTH_SHARE[0] <= share <= CLOTH_SHARE[1]
            red_ok = bool(usable and sol >= RED_OK and pid[len("met_gam_"):] not in RED_UNSUITABLE)
            info = dict(solidity=round(sol, 4), cloth_share=round(share, 4), usable=usable, red_ok=red_ok,
                        grid={"w": GRID[0], "h": GRID[1], "sil": grid_hex(sil), "cloth": grid_hex(cloth)})
        else:
            cloth = (np.asarray(Image.fromarray((big_cloth * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)) > 127) & sil
        rows = np.nonzero(sil.any(axis=1))[0]; foot = int(rows.max()) if len(rows) else h - 1
        out.append((tier, "lines", png(lines), w, h, foot))
        out.append((tier, "sil", png(Image.fromarray((sil * 255).astype(np.uint8)).convert("1")), w, h, foot))
        if info["usable"]: out.append((tier, "cloth", png(Image.fromarray((cloth * 255).astype(np.uint8)).convert("1")), w, h, foot))
    return out, info


def shared_pieces():
    """The paper, the grain and the foot shadow: seeded noise and geometry (the reference picture's paper tone, vignette, lower shade and grain)."""
    rng = np.random.default_rng(2)
    yy, xx = np.mgrid[0:H, 0:W]
    v = 1 - 0.06 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    v = v * (1 - 0.05 * np.clip((yy - 200) / 350, 0, 1))
    blob = ndi.gaussian_filter(rng.normal(0, 1, (H, W)), 2.5); blob = blob / blob.std()
    base = PAPER[None, None, :] * v[..., None] + (0.5 * 7.0 * blob)[..., None]
    base = base / (1 - 0.035)                       # the grain darkens by 0.035 on average; the paper under it is that much lighter
    paper = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).resize((W // 2, H // 2), Image.LANCZOS)
    fine = ndi.gaussian_filter(rng.normal(0, 1, (H // 2, W // 2)), 0.6); fine = fine / fine.std()
    a = np.clip(0.035 + 0.027 * fine, 0, GRAIN_OPACITY)
    grain = Image.fromarray((a / GRAIN_OPACITY * 255).round().astype(np.uint8), "L")
    sw, sh = 64, 12
    ys, xs = np.mgrid[0:sh * 2, 0:sw * 2]
    shd = np.clip(1 - (((xs + 0.5 - sw) / sw) ** 2 + ((ys + 0.5 - sh) / sh) ** 2), 0, 1) * 0.26
    shadow = Image.fromarray(np.stack([np.zeros(shd.shape, np.uint8), (shd * 255).round().astype(np.uint8)], -1), "LA")
    return [("paper", jpeg(paper, 82), W // 2, H // 2), ("grain", jpeg(grain, 80), W // 2, H // 2), ("shadow", png(shadow), sw * 2, sh * 2)]


def main():
    if len(sys.argv) < 2 or not os.path.isdir(sys.argv[1]):
        sys.exit("usage: python3 -I -B scripts/build_collage_pack.py <cutouts-dir> [out-dir]  (the cut-outs folder is required)")
    src = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "illus_hero", "collage")
    os.makedirs(out_dir, exist_ok=True)
    rows = [r for r in csv.DictReader(open(os.path.join(src, "index.tsv"), encoding="utf-8"), delimiter="\t")
            if r["id"].startswith("met_gam_") and r["id"][len("met_gam_"):] not in UNUSABLE]
    rows.sort(key=lambda r: r["id"])
    blob = bytearray(); pieces = []; figures = []

    def add(pid, figure, tier, kind, data, w, h, foot, facing, red_ok):
        pieces.append(dict(id=pid, figure=figure, tier=tier, kind=kind, offset=len(blob), len=len(data), sha256=hashlib.sha256(data).hexdigest(),
                           w=w, h=h, foot_y=foot, facing=facing, red_ok=red_ok))
        blob.extend(data)

    for kind, data, w, h in shared_pieces(): add(kind, None, None, kind, data, w, h, None, None, False)
    for r in rows:
        ps, info = figure_pieces(src, r["id"])
        facing = r.get("facing") or "n/a"
        figures.append(dict(id=r["id"], facing=facing, red_ok=info["red_ok"], usable=info["usable"], solidity=info["solidity"],
                            cloth_share=info["cloth_share"], grid=info["grid"]))
        for tier, kind, data, w, h, foot in ps: add(f"{r['id']}.{tier}.{kind}", r["id"], tier, kind, data, w, h, foot, facing, info["red_ok"])
    data = bytes(blob)
    open(os.path.join(out_dir, "pack.bin"), "wb").write(data)
    index = dict(version=1, set="gamborino", doc="Index of pack.bin (built by scripts/build_collage_pack.py; see its header). Each piece is a PNG or JPEG at "
                 "[offset, offset+len) of pack.bin; tiers l, m, s are at most 480, 240, 120 px high; lines = ink over transparency, sil = the outline (1 bit), "
                 "cloth = the clothing (1 bit). The grain is a mask painted at grain_opacity.",
                 bin_bytes=len(data), bin_sha256=hashlib.sha256(data).hexdigest(), tiers={t: c for t, c in TIERS}, ink=INK, grain_opacity=GRAIN_OPACITY,
                 paper="#f5eee4", figures=figures, pieces=pieces)
    text = json.dumps(index, separators=(",", ":")).replace('},{"id"', '},\n{"id"')      # one figure or piece per line
    open(os.path.join(out_dir, "pack.json"), "w", encoding="utf-8").write(text + "\n")
    with open(os.path.join(out_dir, "LICENSES.tsv"), "w", encoding="utf-8", newline="") as f:
        wr = csv.writer(f, delimiter="\t", lineterminator="\n")
        wr.writerow(["id", "museum", "object_id", "accession", "author", "date", "licence_url", "source_url", "notes"])
        for r in rows:
            wr.writerow([r["id"], r["museum"], r["object_id"], r["accession"], r["author"], r["date"], CC0, MET + r["object_id"],
                         "single figure cut from the museum's Open Access image (isPublicDomain=true); text of the terms: LICENCE-met-openaccess-README.txt, LICENSE-CC0-1.0-legalcode.txt"])
        for kind in ("paper", "grain", "shadow"):
            wr.writerow([kind, "-", "-", "-", "-", "-", CC0, "-", "generated by scripts/build_collage_pack.py (seeded noise or geometry); no third-party material"])
    for name in ("LICENCE-met-openaccess-README.txt", "LICENSE-CC0-1.0-legalcode.txt"):
        shutil.copyfile(os.path.join(src, name), os.path.join(out_dir, name))
    by_kind = {}
    for p in pieces: by_kind[p["kind"]] = by_kind.get(p["kind"], 0) + p["len"]
    print(f"figures {len(figures)}  red_ok {sum(f['red_ok'] for f in figures)}  usable {sum(f['usable'] for f in figures)}")
    print(f"pack.bin {len(data)} B  largest piece {max(p['len'] for p in pieces)} B  by kind {by_kind}")
    print(f"pack.json {os.path.getsize(os.path.join(out_dir, 'pack.json'))} B")


if __name__ == "__main__":
    main()
