"""The line version of the story hero (pure SVG by code, no Blender, no raster): draw(resolved) -> {"svg": ..., ...}.
`resolved` is what runtime/illus_hero/run_hero.py resolve(request) returns, (scene, palette, accent, composition knobs), or the request itself (it is
resolved here): the scene (energy.path|rank|series|tally|groups), the units in their order, each one lit or not (the lit count is what the rows give,
recomputed by resolve, never typed here), the omission mark of a long ranking and its `omitted` count. This module places and draws; it makes no
number and no word (the picture holds no text). Proportions, pen and frames are the registry line.json next to this file."""
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import pen as PN  # noqa: E402
import units as UN  # noqa: E402

REG = json.load(open(os.path.join(HERE, "line.json")))
CW, CH = REG["canvas"]["w"], REG["canvas"]["h"]
COL = REG["colour"]


def _resolve(r):
    sys.path.insert(0, os.path.join(HERE, "..", "illus_hero"))
    import run_hero as R
    return R.resolve(r, renderer="line")


def catmull(pts, n=8):
    p = [pts[0]] + pts + [pts[-1]]; out = []
    for i in range(1, len(p) - 2):
        for k in range(n):
            t = k / n; t2 = t * t; t3 = t2 * t
            out.append(tuple(0.5 * ((2 * p[i][d]) + (-p[i - 1][d] + p[i + 1][d]) * t + (2 * p[i - 1][d] - 5 * p[i][d] + 4 * p[i + 1][d] - p[i + 2][d]) * t2 + (-p[i - 1][d] + 3 * p[i][d] - 3 * p[i + 1][d] + p[i + 2][d]) * t3) for d in (0, 1)))
    out.append(p[-2]); return out


def hills(parts, seed):
    G = REG["ground"]; ink = COL["ink"]
    for name, fill, hatch in (("ridge", "hill", True), ("ridge2", "paper", False)):
        pn = PN.Pen(seed + (1 if hatch else 2), REG["pen"], ink)
        pts = catmull([(x * CW, y * CH) for x, y in G[name]])
        poly = pts + [(CW, CH), (0, CH)]
        parts.append(pn.paint(f'M{"L".join(f"{x:.1f},{y:.1f}" for x, y in poly)}Z', fill))
        parts.append(pn.line(pts, 1.5, 0.8, amp=1.0))
        if hatch:      # light slanted ticks under the ridge, longer where the ground is higher
            x = 14.0
            while x < CW - 10:
                y = min(pts, key=lambda p: abs(p[0] - x))[1]; ln = 16 + 26 * ((math.sin(x * 0.021) + 1) / 2)
                parts.append(pn.line([(x, y + 10), (x - ln * 0.35, y + 10 + ln)], REG["pen"]["hatch_w"], 0.4, amp=0.3)); x += 13 + pn.r.uniform(-3, 4)


def ground_line(parts, pn, x0, x1, y, depth_k=1.0, ticks=True):
    parts.append(pn.line([(x0, y), (x1, y)], 1.6 * depth_k, 0.9, amp=0.9))
    if ticks:
        G = REG["ground"]; x = x0 + 6
        while x < x1 - 6:
            parts.append(pn.line([(x, y + 4 * depth_k), (x - G["tick_len"] * 0.5 * depth_k, y + (4 + G["tick_len"]) * depth_k)], REG["pen"]["hatch_w"], COL["hatch_alpha"], amp=0.2))
            x += G["tick_gap"] * (1 + pn.r.uniform(-0.3, 0.3))


def woh_of(fn, kind):
    """The unit's width over its height in a layout: its own, or the one the registry gives for that layout (a dam in a ranking is a narrower cut)."""
    S = REG["units"][fn]; return S.get(f"{kind}_w_over_h", S["w_over_h"])


def draw_unit(it, cx, gy, h, lit, acc, seed, idx, kind=None):
    S = REG["units"][it["fn"]]
    pn = PN.Pen(seed * 131 + idx, REG["pen"], COL["ink"])
    u = UN.U(pn, REG, cx, gy, h, lit, acc, idx, woh_of(it["fn"], kind))
    UN.DRAW[it["fn"]](u, S)
    return u


def mark(parts, pn, cx, top, acc):
    M = REG["mark"]; rise = M["rise"] * CH; y = top - rise
    parts.append(pn.line([(cx, top - 6), (cx, y + M["r"])], 1.4, 1.0, amp=0.3))
    p = [(cx + M["r"] * math.cos(2 * math.pi * k / 12), y + M["r"] * math.sin(2 * math.pi * k / 12)) for k in range(12)]
    parts.append(pn.fill_path(p, acc)); parts.append(pn.ring(p, 1.5))


def omission(parts, pn, cx, gy, hmax):
    O = REG["omission"]; y = gy - hmax * O["y"]
    for k in (-1, 0, 1):
        p = [(cx + k * O["r"] * O["gap"] + O["r"] * math.cos(2 * math.pi * j / 10), y + O["r"] * math.sin(2 * math.pi * j / 10)) for j in range(10)]
        parts.append(pn.fill_path(p, "ink")); parts.append(pn.ring(p, 1.2))


def flag(parts, pn, x, gy, acc_unused=None):
    F = REG["kinds"]["path"]; h = F["flag_h"] * CH
    parts.append(pn.line([(x, gy), (x, gy - h)], 2.2, 1.0, amp=0.5))
    p = [(x, gy - h), (x + 0.34 * h, gy - h * 0.9), (x + 0.30 * h, gy - h * 0.8), (x + 0.36 * h, gy - h * 0.7), (x, gy - h * 0.62)]
    parts.append(pn.fill_path(p, "unit")); parts.append(pn.ring(p, 1.8))
    parts.append(pn.line([(x - 12, gy), (x + 12, gy)], 2.0, 1.0, amp=0.2))


def place_single(units, kind, composition, gy):
    """One row in order: each unit as tall as its size against the largest of its kind, packed over the frame of its kind with the
    omission slot where the middle of a ranking is left out; (list of (item, cx, h, rel)), the slot centre or None."""
    K = REG["kinds"][kind]; x0, x1 = K["x"]; units = sorted(units, key=lambda i: i["at"][0])
    mx = {}
    for i in units: mx[i["fn"]] = max(mx.get(i["fn"], 0), i["args"]["size"])
    rel = [i["args"]["size"] / mx[i["fn"]] for i in units]
    woh = [woh_of(i["fn"], kind) for i in units]
    slot = K.get("slot", 0) if composition.get("omitted") else 0
    H = (x1 - x0 - slot) / sum(w * r * (1 + K["gap"]) for w, r in zip(woh, rel))
    H = min(H, K["top_frac"] * CH, gy - 36)
    ws = [w * r * H * (1 + K["gap"]) for w, r in zip(woh, rel)]
    cut = composition.get("cut"); total = sum(ws) + slot; cur = (x0 + x1) / 2 - total / 2; out = []; gc = None
    for k, (it, w, r) in enumerate(zip(units, ws, rel)):
        out.append((it, cur + w / 2, H * r, r)); cur += w
        if cut is not None and k == cut - 1: gc = cur + slot / 2; cur += slot
    return out, gc


def place_rows(units, kind, gy_front_k):
    """The units of a tally or a groups scene in the rows the scene put them in (front row = lowest depth), each unit's height from the row's cell
    width, its kind's norm_h, its size against the largest of its kind (the unlit are smaller) and the row's depth scale; a row whose neighbours would
    touch shrinks as a whole."""
    K = REG["kinds"][kind]; xs = K["x_scale"]; rows = sorted({i["at"][1] for i in units})
    mx = {}
    for i in units: mx[i["fn"]] = max(mx.get(i["fn"], 0), i["args"]["size"])
    out = []; cells = []
    for ri, y in enumerate(rows):
        row = sorted([i for i in units if i["at"][1] == y], key=lambda i: i["at"][0])
        dxs = [(b["at"][0] - a["at"][0]) * xs for a, b in zip(row, row[1:])]; dxs = [d for d in dxs if d > 0]
        cell = min(dxs) if dxs else 160.0; cells.append(cell)
    cell = max(min(cells), K.get("cell_min", 100) if kind == "tally" else 0)
    for ri, y in enumerate(rows):
        row = sorted([i for i in units if i["at"][1] == y], key=lambda i: i["at"][0])
        gy = gy_front_k * CH - ri * K["row_gap"] * CH; dk = K["depth"][min(ri, len(K["depth"]) - 1)]
        hs = []; cxs = []
        for i in row:
            r = i["args"]["size"] / mx[i["fn"]]; hs.append(REG["units"][i["fn"]]["norm_h"] * cell * dk * r * K.get("fill", 1.0)); cxs.append(CW / 2 + i["at"][0] * xs)
        f = 1.0
        for a in range(len(row) - 1):
            wa = REG["units"][row[a]["fn"]]["w_over_h"] * hs[a]; wb = REG["units"][row[a + 1]["fn"]]["w_over_h"] * hs[a + 1]
            if (b := cxs[a + 1] - cxs[a]) > 0 and (wa + wb) / 2 > b * 0.97: f = min(f, b * 0.97 * 2 / (wa + wb))
        for it, cx, h in zip(row, cxs, hs): out.append((it, cx, h * f, gy, ri, dk))
    return out


def draw(resolved, seed=7, annotate=False):
    t0 = time.time()
    if isinstance(resolved, dict): resolved = _resolve(resolved)
    scene, pal, _, c = resolved; acc = PN.ACC          # the lit units take the page accent whatever hex the 3D path was given
    comp = scene["composition"]; kind = scene["scene"].split(".")[1]
    items = scene["items"]; units = [i for i in items if i.get("fn") in UN.DRAW]
    parts = []
    hills(parts, seed)
    placed = []          # (item, cx, gy, h, row)
    gen = PN.Pen(seed + 3, REG["pen"], COL["ink"]); omitted_at = None; flag_x = None
    if kind in ("path", "series", "rank"):
        gy = REG["ground"]["y_single"] * CH
        cut = None
        el = [i for i in items if i.get("fn") == "ellipsis_mark"]
        if el:
            cut = sum(1 for i in units if i["at"][0] < el[0]["at"][0])
        cs = dict(comp); cs["cut"] = cut
        row, gc = place_single(units, kind, cs, gy)
        placed = [(it, cx, gy, h, 0) for it, cx, h, r in row]
        K = REG["kinds"][kind]
        ground_line(parts, gen, K["x"][0] - 30, (K.get("flag_at", K["x"][1]) + 60) if kind == "path" else K["x"][1] + 20, gy)
        if kind == "path":
            ground_line(parts, PN.Pen(seed + 5, REG["pen"], COL["ink"]), K["x"][0] - 30, K["flag_at"] + 60, gy + 16, 0.8, ticks=False)
            flag(parts, gen, K["flag_at"], gy)
        if gc is not None: omitted_at = (gc, gy, max(h for _, _, _, h, _ in placed))
    else:
        K = REG["kinds"][kind]; rows = place_rows(units, kind, K["ground_front"])
        placed = [(it, cx, gy, h, ri) for it, cx, h, gy, ri, dk in rows]
        if kind == "groups":      # each group stands on its own slab: a flat plate seen from above and the front, its edge hatched
            for side in (-1, 1):
                mem = [p for p in placed if (p[0]["at"][0] < 0) == (side < 0)]
                if not mem: continue
                pad = K["slab_pad"]; gyf = max(p[2] for p in mem); gyb = min(p[2] for p in mem)
                xl = min(p[1] - REG["units"][p[0]["fn"]]["w_over_h"] * p[3] / 2 for p in mem) - pad; xr = max(p[1] + REG["units"][p[0]["fn"]]["w_over_h"] * p[3] / 2 for p in mem) + pad
                wd = xr - xl; sk = K["slab_skew"] * wd; yf = gyf + 14; yb = gyb - 6
                pn = PN.Pen(seed + 40 + side, REG["pen"], COL["ink"]); t = K["slab_thick"]
                top = [(xl + sk, yb), (xr - sk, yb), (xr, yf), (xl, yf)]
                front = [(xl, yf), (xr, yf), (xr, yf + t), (xl, yf + t)]
                parts.append(pn.fill_path(top, "hill")); parts.append(pn.fill_path(front, "unit"))
                parts.append(pn.ring(top, 1.6)); parts.append(pn.ring(front, 1.4)); parts.append(pn.hatch(front, 60, 5, 0.8, 0.5))
        else:
            for ri in sorted({p[4] for p in placed}, reverse=True):
                mem = [p for p in placed if p[4] == ri]; gy = mem[0][2]; dk = K["depth"][min(ri, len(K["depth"]) - 1)]
                ground_line(parts, PN.Pen(seed + 60 + ri, REG["pen"], COL["ink"]), min(p[1] for p in mem) - 60, max(p[1] for p in mem) + 60, gy, dk * 0.8, ticks=ri == 0)
    out_units = []
    order = sorted(range(len(placed)), key=lambda k: (-placed[k][4], placed[k][1]))
    marks = []
    for n, k in enumerate(order):
        it, cx, gy, h, ri = placed[k]; lit = bool(it["args"]["lit"])
        u = draw_unit(it, cx, gy, h, lit, acc, seed, n, kind)
        parts.append((f'<g class="unit {"lit" if lit else "plain"}" data-fn="{it["fn"]}">' if annotate else "<g>") + "".join(u.parts) + "</g>")
        out_units.append(dict(fn=it["fn"], lit=lit, row=ri, bbox=[round(v, 1) for v in u.box], ground=round(gy, 1), h=round(h, 1)))
        if "mark" in it: marks.append((cx, u.box[1]))
    for cx, top in marks: mark(parts, PN.Pen(seed + 9, REG["pen"], COL["ink"]), cx, top, acc)
    if omitted_at: omission(parts, PN.Pen(seed + 11, REG["pen"], COL["ink"]), *omitted_at)
    inner = "".join(parts)
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CW} {CH}" width="{CW}" height="{CH}">{inner}</svg>'
    top = min(u["bbox"][1] for u in out_units); bot = max(u["bbox"][3] for u in out_units)
    return {"svg": svg, "inner": inner, "w": CW, "h": CH, "scene": scene["scene"], "composition": comp, "omitted": comp.get("omitted", 0), "units": out_units,
            "unit_fraction": round((bot - top) / CH, 3), "seconds": round(time.time() - t0, 2)}
