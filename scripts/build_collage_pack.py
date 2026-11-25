"""Builds the engraving cut-out pack of the opening picture's collage renderer (runtime/illus_hero/collage): pack.bin, pack.json,
LICENSES.tsv and the two licence text copies. Run once at ingest time, never at run time (the renderer itself reads the pack with the
standard library only and does no pixel work).

Rerun:  python3 -I -B scripts/build_collage_pack.py <cutouts-dir> [out-dir]
  <cutouts-dir>: the folder of the cut-outs (index.tsv; <id>.png, an RGBA cut-out whose three colour channels are the engraving's grey and
                 whose alpha is the figure's outline), plus the Met Open Access README (LICENCE-met-openaccess-README.txt) and the CC0 1.0
                 legal code (LICENSE-CC0-1.0-legalcode.txt).
  [out-dir]:     default runtime/illus_hero/collage next to this script.
Needs Pillow, numpy and scipy (an ingest-time environment, not the run's). The output is the same on every run for the same input.

What it writes, per figure (the single full-length figures of Miguel Gamborino's street-cries series, The Metropolitan Museum of Art,
CC0; the four pieces marked unusable below are left out), in three size tiers (l, m, s: at most 480, 240 and 120 px high):
  lines: the engraving as ink over transparency (grey + alpha PNG: the grey a fixed ink, the alpha the line darkness times the outline,
         in 32 levels), so the paper between the lines is transparent and whatever lies under it (paper or the accent) shows through;
  sil:   the figure's outline, 1-bit (the paper-coloured block that hides the figures behind it is cut by it);
  cloth: the clothing, 1-bit, only for the figures in CLOTH: a hand-set polygon per figure (drawn by eye over the engraving at a 520 px
         height, the same method as the reference study's masks), minus its cuts (held baskets, scales, jugs, a hand on the chest),
         intersected with the outline (closed and its holes filled) and opened once. It starts at the shoulders and follows them, stays off the face, the hands, the
         feet and anything held. Only these figures are red_ok (may wear the accent); a figure without a hand-set mask never does. A mask
         whose top edge is one horizontal line (flat_top) stops the build.
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
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

UNUSABLE = {"856582_1", "856578_3", "856580_3", "856576_1"}       # cut badly (limbs lost or two figures merged)
# The clothing polygons, (x, y) at the cut-out's 520 px high view (x from its left edge), and the cuts taken out of them (held objects,
# hands). The first three are the reference study's own masks; the rest were drawn the same way and checked by eye over the engraving.
CLOTH = {
    "856581_1": dict(poly=[(48, 104), (62, 94), (88, 82), (112, 84), (132, 100), (152, 128), (150, 160), (142, 176), (148, 260), (148, 478), (28, 478), (30, 300), (40, 260), (48, 200)],
                     cut=[[(80, 226), (104, 232), (107, 262), (101, 292), (88, 297), (80, 262)]]),
    "856583_1": dict(poly=[(62, 138), (100, 112), (150, 100), (175, 98), (200, 108), (238, 150), (246, 186), (236, 200), (200, 204), (190, 260), (206, 330), (214, 500), (72, 500), (76, 330), (78, 240), (68, 190), (58, 160)],
                     cut=[]),
    "856584_1": dict(poly=[(100, 125), (110, 96), (140, 84), (165, 78), (190, 80), (215, 92), (236, 112), (248, 150), (255, 185), (240, 200), (250, 300), (248, 440), (215, 452), (140, 452), (128, 300), (125, 215), (108, 198)],
                     cut=[]),
    "856578_0": dict(poly=[(88, 150), (110, 132), (140, 118), (165, 112), (190, 112), (215, 118), (232, 130), (236, 180), (270, 200), (292, 215), (296, 250), (300, 320), (290, 420), (292, 500), (105, 500), (110, 400), (105, 330), (92, 300), (110, 240), (125, 200), (120, 185), (95, 185), (86, 170)],
                     cut=[]),
    "856587_1": dict(poly=[(55, 100), (75, 92), (130, 92), (150, 110), (175, 150), (190, 190), (180, 215), (165, 300), (178, 470), (170, 488), (40, 490), (25, 480), (42, 390), (50, 305), (40, 215), (35, 160)],
                     cut=[[(10, 240), (25, 215), (60, 205), (100, 202), (140, 205), (170, 215), (178, 240), (165, 275), (140, 300), (90, 305), (40, 298), (15, 270)]]),
    "856590_0": dict(poly=[(70, 135), (100, 125), (130, 128), (160, 125), (190, 140), (225, 150), (238, 180), (240, 250), (232, 290), (212, 300), (205, 340), (205, 380), (200, 480), (185, 495), (80, 495), (75, 420), (72, 340), (85, 320), (100, 300), (60, 240), (30, 200), (30, 160), (50, 150)],
                     cut=[[(15, 280), (30, 262), (70, 250), (95, 235), (118, 250), (115, 290), (105, 330), (70, 345), (30, 338), (15, 310)], [(200, 395), (215, 375), (240, 372), (258, 395), (258, 470), (245, 498), (205, 498), (198, 460)]]),
    "856586_1": dict(poly=[(40, 140), (60, 115), (90, 108), (150, 110), (175, 120), (205, 140), (225, 170), (250, 215), (255, 240), (240, 370), (230, 440), (215, 500), (60, 500), (40, 440), (30, 330), (35, 220)],
                     cut=[[(105, 235), (140, 225), (200, 225), (250, 235), (330, 255), (350, 300), (325, 345), (260, 365), (180, 368), (125, 350), (105, 310)]]),
    "856592_1": dict(poly=[(125, 120), (150, 105), (175, 100), (225, 100), (240, 115), (250, 160), (235, 210), (225, 260), (222, 330), (215, 480), (190, 492), (80, 492), (70, 420), (65, 330), (75, 300), (120, 285), (140, 240), (135, 170)],
                     cut=[[(98, 322), (110, 305), (140, 300), (172, 305), (180, 322), (170, 345), (140, 355), (108, 348)]]),
    "856589_1": dict(poly=[(175, 100), (210, 92), (240, 105), (265, 125), (275, 160), (268, 210), (255, 240), (262, 300), (278, 420), (292, 500), (165, 505), (145, 420), (135, 300), (128, 290), (130, 245), (160, 200), (170, 140)],
                     cut=[[(0, 170), (40, 150), (120, 140), (190, 140), (215, 160), (218, 200), (205, 235), (150, 248), (60, 245), (0, 215)]]),
    "856576_0": dict(poly=[(70, 135), (100, 115), (130, 105), (165, 100), (200, 110), (230, 130), (240, 160), (250, 200), (300, 200), (300, 480), (80, 485), (75, 400), (85, 300), (95, 230), (60, 215), (45, 222), (40, 200), (50, 170)],
                     cut=[[(196, 215), (212, 198), (258, 193), (300, 205), (302, 262), (292, 330), (252, 342), (214, 336), (198, 300)]]),
    "856591_1": dict(poly=[(140, 150), (170, 130), (195, 108), (230, 105), (260, 115), (290, 125), (312, 150), (315, 195), (330, 240), (330, 340), (305, 420), (300, 505), (130, 505), (130, 420), (140, 300), (140, 220), (130, 195), (125, 165)],
                     cut=[[(238, 250), (255, 222), (300, 212), (355, 225), (368, 260), (345, 300), (330, 335), (290, 345), (255, 335), (240, 300)]]),
    "856584_0": dict(poly=[(70, 145), (85, 115), (105, 100), (135, 98), (160, 105), (195, 125), (225, 235), (225, 440), (95, 445), (85, 420), (80, 330), (85, 250), (95, 190), (70, 185), (62, 165)],
                     cut=[[(150, 130), (165, 110), (200, 100), (240, 105), (265, 125), (270, 170), (255, 210), (220, 228), (175, 228), (152, 205)]]),
    "856583_3": dict(poly=[(5, 175), (25, 135), (50, 115), (72, 106), (132, 108), (165, 118), (185, 140), (195, 175), (195, 240), (185, 270), (160, 265), (165, 300), (160, 420), (135, 430), (115, 420), (110, 380), (100, 380), (95, 430), (65, 440), (45, 420), (45, 300), (40, 260), (20, 240), (5, 200)],
                     cut=[[(78, 100), (132, 100), (128, 250), (96, 250)], [(85, 175), (135, 175), (135, 225), (85, 225)]]),
    "857973_1": dict(poly=[(80, 110), (110, 100), (140, 100), (170, 110), (190, 150), (212, 175), (212, 215), (205, 235), (170, 250), (140, 265), (150, 330), (180, 335), (200, 420), (210, 505), (40, 505), (50, 420), (60, 330), (65, 250), (60, 200), (75, 150)],
                     cut=[[(118, 272), (130, 242), (160, 217), (210, 205), (260, 215), (277, 245), (272, 300), (242, 332), (180, 337), (135, 322)]]),
    "856579_1": dict(poly=[(105, 105), (125, 95), (160, 95), (185, 110), (210, 140), (212, 200), (195, 225), (200, 300), (200, 420), (195, 505), (30, 505), (35, 420), (45, 300), (60, 230), (105, 225), (110, 180)],
                     cut=[[(0, 140), (15, 110), (40, 95), (60, 82), (95, 82), (108, 98), (112, 150), (106, 200), (96, 220), (60, 222), (20, 207), (0, 182)]]),
}
TIERS = (("l", 480), ("m", 240), ("s", 120))
LEVELS = 32                 # alpha levels of a lines piece
INK = 42                    # the grey of the engraving lines
GRID = (16, 40)             # occupancy grid of a figure (columns, rows)
W, H = 1440, 560
PAPER = np.array([236, 230, 220], float)
GRAIN_OPACITY = 0.12        # the grain mask's full value; the renderer paints the grain at this opacity
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


def flat_top(cl, tol=0.015, share=0.5):
    """Whether a clothing mask's top edge is one horizontal line: over `share` of its columns start within tol x its height of the commonest
    start row (scripts/test_illus_collage.py holds every red_ok mask to the same test)."""
    h = cl.shape[0]; cols = np.nonzero(cl.any(axis=0))[0]
    if len(cols) == 0: return True
    t = np.argmax(cl[:, cols], axis=0); mode = np.bincount(t).argmax()
    return float(np.mean(np.abs(t - mode) <= tol * h)) > share


def cloth_mask(pid, a):
    """The clothing of one figure from its hand-set polygon (CLOTH; a: the cut-out's alpha): the polygon minus its cuts, inside the outline
    (closed, its holes filled), opened once; None for a figure without one."""
    v = CLOTH.get(pid[len("met_gam_"):])
    if v is None: return None
    h, w = a.shape; s = h / 520.0
    m = Image.new("L", (w, h), 0); d = ImageDraw.Draw(m)
    d.polygon([(x * s, y * s) for x, y in v["poly"]], fill=255)
    for c in v["cut"]: d.polygon([(x * s, y * s) for x, y in c], fill=0)
    pm = np.asarray(m) > 127
    body = ndi.binary_fill_holes(ndi.binary_closing(a > 0.5, iterations=max(4, h // 40)))
    cl = pm & body                       # the light parts of a garment the cut left open (inside or at its edge) are still the garment: no holes
    cl = ndi.binary_opening(cl, iterations=1)
    if flat_top(cl): raise SystemExit(f"{pid}: the clothing polygon's top edge is one horizontal line")
    return cl


def figure_pieces(src, pid):
    """The pieces of one figure in its three tiers, and its figure entry (red_ok: it has a hand-set clothing mask, CLOTH)."""
    im = Image.open(os.path.join(src, f"{pid}.png")).convert("RGBA")
    full = cloth_mask(pid, np.asarray(im.getchannel("A")) / 255.0)
    cm = Image.fromarray((full * 255).astype(np.uint8)) if full is not None else None
    out = []; info = {}
    for tier, cap in TIERS:
        h = min(cap, im.height); w = max(1, round(im.width * h / im.height))
        r = im.resize((w, h), Image.LANCZOS)
        g = np.asarray(r.getchannel("R")) / 255.0; a = np.asarray(r.getchannel("A")) / 255.0
        al = np.round(np.clip((1 - g) * a, 0, 1) * (LEVELS - 1)) / (LEVELS - 1)
        lines = Image.fromarray(np.stack([np.full(al.shape, INK, np.uint8), (al * 255).round().astype(np.uint8)], -1), "LA")
        sil = a > 0.5
        if tier == "l":
            cloth = np.asarray(cm.resize((w, h), Image.LANCZOS)) > 127 if cm is not None else np.zeros_like(sil)     # not cut by sil: its filled holes stay
            big_cloth = cloth
            share = float(cloth.sum() / max(1, sil.sum()))
            s300 = 300 / h
            sz = (max(1, round(w * s300)), 300)
            sil300 = np.asarray(Image.fromarray((sil * 255).astype(np.uint8)).resize(sz, Image.LANCZOS)) > 127
            cl300 = np.asarray(Image.fromarray((cloth * 255).astype(np.uint8)).resize(sz, Image.LANCZOS)) > 127
            sol = solidity(cl300, sil300)
            red_ok = cm is not None
            info = dict(solidity=round(sol, 4), cloth_share=round(share, 4), usable=True, red_ok=red_ok,
                        grid={"w": GRID[0], "h": GRID[1], "sil": grid_hex(sil), "cloth": grid_hex(cloth)})
        else:
            cloth = np.asarray(Image.fromarray((big_cloth * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)) > 127
        rows = np.nonzero(sil.any(axis=1))[0]; foot = int(rows.max()) if len(rows) else h - 1
        out.append((tier, "lines", png(lines), w, h, foot))
        out.append((tier, "sil", png(Image.fromarray((sil * 255).astype(np.uint8)).convert("1")), w, h, foot))
        if info["red_ok"]: out.append((tier, "cloth", png(Image.fromarray((cloth * 255).astype(np.uint8)).convert("1")), w, h, foot))
    return out, info


def shared_pieces():
    """The paper, the grain and the foot shadow: seeded noise and geometry (the reference picture's paper tone, vignette, lower shade and grain)."""
    rng = np.random.default_rng(2)
    yy, xx = np.mgrid[0:H, 0:W]
    v = 1 - 0.06 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    v = v * (1 - 0.05 * np.clip((yy - 200) / 350, 0, 1))
    blob = ndi.gaussian_filter(rng.normal(0, 1, (H, W)), 2.5); blob = blob / blob.std()
    base = PAPER[None, None, :] * v[..., None] + (0.25 * 7.0 * blob)[..., None]
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
    missing = sorted(set(CLOTH) - {r["id"][len("met_gam_"):] for r in rows})
    if missing: sys.exit(f"clothing polygons for figures not in the pack: {missing}")
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
