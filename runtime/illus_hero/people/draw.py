"""The people version of the story hero (pure SVG, no Blender, no raster): draw(resolved, cols) -> {"svg": ..., "inner": ..., ...}.
`resolved` is what runtime/illus_hero/run_hero.py resolve(request, renderer="people") returns (scene, palette, accent, composition knobs): the scene
(energy.path|rank|series|tally ...), its units in order, each one lit or not (the lit count is what the rows give, recomputed by resolve, never typed
here), the omission mark of a long ranking. One unit is one baked people figure (people.json, see its credit). This module places and paints; it makes
no number and no word. Only <g> and <path> are written, every colour a hex: a lit figure in the page's palette, an unlit one in pale greys.
`cols` = {"--accent": hex, "--bar": hex, "--t-title": hex}: the page's own tokens, resolved by the caller."""
import colorsys
import json
import math
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REG = json.load(open(os.path.join(HERE, "people.json")))
CW, CH = REG["canvas"]["w"], REG["canvas"]["h"]
FIG = REG["figures"]
ORDER = [k for k in REG["order"] if k in FIG]
SINGLE = ("path", "series", "rank")
ROWS = ("tally",)
KINDS = SINGLE + ROWS


def rgb(h): h = h.lstrip("#"); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
def hex_of(c): return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(v)))) for v in c)
def hls(c): h, l, s = colorsys.rgb_to_hls(*(v / 255 for v in c)); return h * 360, l, s
def from_hls(h, l, s): return tuple(v * 255 for v in colorsys.hls_to_rgb((h % 360) / 360, max(0.0, min(1.0, l)), max(0.0, min(1.0, s))))
def hdiff(a, b): return (a - b + 180) % 360 - 180
def chroma(c): return max(c) - min(c)
def lum(c): return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def is_skin(c):
    r, g, b = c
    return r > g > b and 0.18 < (r - b) / max(r, 1) < 0.62 and 60 < lum(c) < 200 and chroma(c) < 110


def palette_of(primary, cols):
    H = REG["harmony"]; ph, pl, ps = hls(rgb(primary))
    return {"primary": hls(rgb(primary)), "secondary": (ph + H["secondary_hue"], pl, ps), "accent": hls(rgb(cols["--accent"])), "neutral": hls(rgb(cols["--bar"]))}


def lit_map(fills, pal):
    """fill hex -> hex for a lit figure (see people.json harmony)."""
    H = REG["harmony"]; mapping = {}; chromatic = []; dark = []
    for f, area in fills.items():
        c = rgb(f); h, l, s = hls(c)
        if is_skin(c) or (0.02 < h / 360 < 0.12 and 0.2 < s < 0.7 and 0.15 < l < 0.75): mapping[f] = f; continue
        if chroma(c) < 30 or s < 0.12 or l > H["light_above"]:
            nh = pal["neutral"][0]; mapping[f] = hex_of(from_hls(nh, l, min(s, 0.10) * 0.5 + 0.03)) if l > H["dark_below"] else f; continue
        if l < H["dark_below"]: dark.append((f, area, h, l, s)); continue
        chromatic.append((f, area, h, l, s))
    chromatic.sort(key=lambda t: t[2]); fams = []
    for t in chromatic:
        if fams and abs(hdiff(t[2], fams[-1][-1][2])) < H["hue_gap"]: fams[-1].append(t)
        else: fams.append([t])
    if len(fams) > 1 and abs(hdiff(fams[0][0][2], fams[-1][-1][2])) < H["hue_gap"]: fams[0] = fams.pop() + fams[0]
    fams.sort(key=lambda fam: -sum(t[1] for t in fam)); meta = []
    for fam, role in zip(fams, ["primary", "secondary"] + ["accent"] * 10):
        fh = math.degrees(math.atan2(sum(t[1] * math.sin(math.radians(t[2])) for t in fam), sum(t[1] * math.cos(math.radians(t[2])) for t in fam))) % 360
        ph, pl, ps = pal[role]
        for f, a, h, l, s in fam: mapping[f] = hex_of(from_hls(ph + H["hue_keep"] * hdiff(h, fh), l + (pl - l) * H["l_pull"], min(H["s_cap"], s + (ps - s) * H["s_pull"])))
        meta.append((fh, ph, ps))
    for f, a, h, l, s in dark:
        best = min(meta, key=lambda m: abs(hdiff(h, m[0])), default=None)
        mapping[f] = hex_of(from_hls(best[1] + H["hue_keep"] * hdiff(h, best[0]), l, s + (best[2] - s) * H["s_pull"])) if best and abs(hdiff(h, best[0])) < H["hue_gap"] else f
    return mapping


def unlit_map(fills, pal):
    U = REG["unlit"]; nh = pal["neutral"][0]
    return {f: hex_of(from_hls(nh, U["l_base"] + U["l_span"] * hls(rgb(f))[1], U["s"])) for f in fills}


def figure_svg(name, cx, gy, h, lit, mapping):
    f = FIG[name]; k = h / f["h"]
    body = "".join(f'<path fill="{mapping[p["fill"]]}" d="{p["d"]}"/>' for p in f["pieces"])
    return f'<g transform="translate({cx:.2f},{gy:.2f}) scale({k:.5f})">{body}</g>', (cx - f["w"] * k / 2, gy - h, cx + f["w"] * k / 2, gy)


def woh(name): return FIG[name]["w"] / FIG[name]["h"]


def place_single(units, kind, comp, gy, cut, ch):
    K = REG["kinds"][kind]; x0, x1 = K["x"]; units = sorted(units, key=lambda i: i["at"][0]); mx = max(i["args"]["size"] for i in units)
    rel = [i["args"]["size"] / mx for i in units]; names = [ORDER[n % len(ORDER)] for n in range(len(units))]
    slot = K.get("slot", 0) if comp.get("omitted") else 0
    H = (x1 - x0 - slot) / sum(woh(n) * r * (1 + K["gap"]) for n, r in zip(names, rel)); H = min(H, K["height_frac"] * ch, gy - (REG["mark"]["rise"] * ch + REG["mark"]["r"] + 10))
    ws = [woh(n) * r * H * (1 + K["gap"]) for n, r in zip(names, rel)]; total = sum(ws) + slot; cur = (x0 + x1) / 2 - total / 2; out = []; gc = None
    for k, (it, n, w, r) in enumerate(zip(units, names, ws, rel)):
        out.append((it, n, cur + w / 2, H * r)); cur += w
        if cut is not None and k == cut - 1: gc = cur + slot / 2; cur += slot
    return out, gc


def place_rows(units, gy_front_k, ch):
    K = REG["kinds"]["tally"]; xs = K["x_scale"]; rows = sorted({i["at"][1] for i in units}); mx = max(i["args"]["size"] for i in units)
    order = sorted(units, key=lambda i: (i["at"][1], i["at"][0])); name_of = {id(i): ORDER[n % len(ORDER)] for n, i in enumerate(order)}
    cells = []
    for y in rows:
        row = sorted([i for i in units if i["at"][1] == y], key=lambda i: i["at"][0]); d = [(b["at"][0] - a["at"][0]) * xs for a, b in zip(row, row[1:])]; d = [v for v in d if v > 0]
        cells.append(min(d) if d else 160.0)
    cell = max(min(cells), K["cell_min"]); out = []
    for ri, y in enumerate(rows):
        row = sorted([i for i in units if i["at"][1] == y], key=lambda i: i["at"][0]); gy = gy_front_k * ch - ri * K["row_gap"] * ch; dk = K["depth"][min(ri, len(K["depth"]) - 1)]
        hs = [cell * 1.55 * dk * (i["args"]["size"] / mx) * K["fill"] for i in row]; cxs = [CW / 2 + i["at"][0] * xs for i in row]; f = 1.0
        for a in range(len(row) - 1):
            wa = woh(name_of[id(row[a])]) * hs[a]; wb = woh(name_of[id(row[a + 1])]) * hs[a + 1]
            if (b := cxs[a + 1] - cxs[a]) > 0 and (wa + wb) / 2 > b * 0.97: f = min(f, b * 0.97 * 2 / (wa + wb))
        for it, cx, h in zip(row, cxs, hs): out.append((it, name_of[id(it)], cx, h * f, gy, ri))
    return out


def poly(pts): return "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z"
def disc(cx, cy, r, n=12): return [(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n)]


def draw(resolved, cols, primary):
    t0 = time.time(); scene, _pal, _acc, _c = resolved; comp = scene["composition"]; kind = scene["scene"].split(".")[1]
    items = scene["items"]; units = [i for i in items if "lit" in i.get("args", {})]
    ch = REG["kinds"].get(kind, {}).get("canvas_h", CH)
    pal = palette_of(primary, cols); acc = cols["--accent"]; bar = cols["--bar"]; ink = cols["--t-title"]
    lit_maps = {n: lit_map(FIG[n]["fills"], pal) for n in ORDER}; unlit_maps = {n: unlit_map(FIG[n]["fills"], pal) for n in ORDER}
    parts = []; placed = []; omitted_at = None; G = REG["ground"]
    if kind in SINGLE:
        gy = G["y_single"] * ch; cut = None
        el = [i for i in items if i.get("fn") == "ellipsis_mark"]
        if el: cut = sum(1 for i in units if i["at"][0] < el[0]["at"][0])
        row, gc = place_single(units, kind, comp, gy, cut, ch); placed = [(it, n, cx, gy, h, 0) for it, n, cx, h in row]
        K = REG["kinds"][kind]; xr = (K.get("flag_at", K["x"][1]) + 60) if kind == "path" else K["x"][1] + 20
        parts.append(f'<path d="M{K["x"][0] - 30:.1f} {gy:.1f}L{xr:.1f} {gy:.1f}" fill="none" stroke="{bar}" stroke-width="{G["width"]}"/>')
        if kind == "path":
            fx = K["flag_at"]; fh = K["flag_h"] * ch
            parts.append(f'<path d="M{fx:.1f} {gy:.1f}L{fx:.1f} {gy - fh:.1f}" fill="none" stroke="{ink}" stroke-width="2.4"/>')
            parts.append(f'<path fill="{acc}" d="{poly([(fx, gy - fh), (fx + 0.34 * fh, gy - fh * 0.88), (fx + 0.30 * fh, gy - fh * 0.76), (fx + 0.36 * fh, gy - fh * 0.64), (fx, gy - fh * 0.58)])}"/>')
        if gc is not None: omitted_at = (gc, gy, max(p[4] for p in placed))
    elif kind in ROWS:
        K = REG["kinds"][kind]; rows = place_rows(units, K["ground_front"], ch); placed = [(it, n, cx, gy, h, ri) for it, n, cx, h, gy, ri in rows]
        for ri in sorted({p[5] for p in placed}, reverse=True):
            mem = [p for p in placed if p[5] == ri]; gy = mem[0][3]
            parts.append(f'<path d="M{min(p[2] for p in mem) - 60:.1f} {gy:.1f}L{max(p[2] for p in mem) + 60:.1f} {gy:.1f}" fill="none" stroke="{bar}" stroke-width="{G["width"] * K["depth"][min(ri, len(K["depth"]) - 1)]:.2f}"/>')
    else:
        raise ValueError(f"people: the {kind!r} layout is not drawn here")
    out_units = []; marks = []
    for it, n, cx, gy, h, ri in sorted(placed, key=lambda p: (-p[5], p[2])):
        lit = bool(it["args"]["lit"]); svg, box = figure_svg(n, cx, gy, h, lit, lit_maps[n] if lit else unlit_maps[n]); parts.append(svg)
        out_units.append(dict(fn=it["fn"], figure=n, lit=lit, row=ri, bbox=[round(v, 1) for v in box], ground=round(gy, 1), h=round(h, 1)))
        if "mark" in it: marks.append((cx, box[1]))
    M = REG["mark"]
    for cx, top in marks:
        y = top - M["rise"] * ch
        parts.append(f'<path d="M{cx:.1f} {top - 6:.1f}L{cx:.1f} {y + M["r"]:.1f}" fill="none" stroke="{ink}" stroke-width="1.6"/>'); parts.append(f'<path fill="{acc}" d="{poly(disc(cx, y, M["r"]))}"/>')
    if omitted_at:
        O = REG["omission"]; cx, gy, hmax = omitted_at; y = gy - hmax * O["y"]
        for k in (-1, 0, 1): parts.append(f'<path fill="{ink}" d="{poly(disc(cx + k * O["r"] * O["gap"], y, O["r"], 10))}"/>')
    inner = "".join(parts); svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CW} {ch}" width="{CW}" height="{ch}">{inner}</svg>'
    top = min(u["bbox"][1] for u in out_units); bot = max(u["bbox"][3] for u in out_units)
    return {"svg": svg, "inner": inner, "w": CW, "h": ch, "scene": scene["scene"], "composition": comp, "omitted": comp.get("omitted", 0), "units": out_units,
            "unit_fraction": round((bot - top) / ch, 3), "seconds": round(time.time() - t0, 2)}
