"""The collage drawing of the opening picture (run_hero.py build_collage; node.json topics.collage_renderer): N engraving cut-outs (pack.bin,
indexed by pack.json, built once by scripts/build_collage_pack.py) standing in a queue that recedes in perspective over grey paper, K of them
with their clothing in the accent under the engraving lines. Standard library only and no pixel work: the picture is layered SVG over the
1440x560 frame, every raster a PNG or JPEG data URL taken from the pack as it is.

Layers, back to front: the paper (<image>); then per figure, farthest first: its foot shadow (<image>), a paper-coloured block cut to its
outline (a <path> under a <mask> of the 1-bit outline), for an accent figure an accent block cut to its clothing (a <path> under a <mask>
of the 1-bit clothing), and its lines (<image>: ink over transparency, so the paper or the accent shows between the lines); last the grain
(a <path> under a <mask> of the grain JPEG). Place and size come only from an outer <g transform="translate(x,y)"> and the <image> width and
height, as the page's hero check (next_leaf.rs hero_faults) allows.

Same request, same bytes: the queue order, the figures and the accent slots come from random.Random seeded with the sha256 of the canonical
JSON of the sorted member codes, K, N, the width and the pack's sha256; no clock, no hash(), no unseeded random."""
import base64
import hashlib
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
CW, CH = 1440, 560
_PACK = {}


class PackError(Exception): pass


def pack():
    """(index, bytes) of the pack, read once."""
    if not _PACK:
        try:
            with open(os.path.join(HERE, "pack.json"), encoding="utf-8") as f: index = json.load(f)
            with open(os.path.join(HERE, "pack.bin"), "rb") as f: data = f.read()
        except (OSError, ValueError) as e:
            raise PackError(f"collage: the pack cannot be read: {e}")
        if len(data) != index.get("bin_bytes"): raise PackError("collage: pack.bin is not the size pack.json gives")
        _PACK.update(index=index, bin=data, by_id={p["id"]: p for p in index["pieces"]})
    return _PACK["index"], _PACK["bin"]


def piece_bytes(pid):
    """A piece's bytes, checked against its sha256 in the index (a damaged pack is refused, not drawn)."""
    _, data = pack(); p = _PACK["by_id"].get(pid)
    if p is None: raise PackError(f"collage: the pack has no piece {pid}")
    b = data[p["offset"]:p["offset"] + p["len"]]
    if hashlib.sha256(b).hexdigest() != p["sha256"]: raise PackError(f"collage: piece {pid} does not match its sha256")
    return b


def href(pid):
    b = piece_bytes(pid)
    kind = "png" if b[:8] == b"\x89PNG\r\n\x1a\n" else "jpeg" if b[:2] == b"\xff\xd8" else None
    if kind is None: raise PackError(f"collage: piece {pid} is neither PNG nor JPEG")
    return f"data:image/{kind};base64," + base64.b64encode(b).decode("ascii")


def num(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def seed_of(codes, k, n, width, pack_sha):
    canon = json.dumps({"codes": sorted(codes), "k": k, "n": n, "width": width, "pack": pack_sha}, sort_keys=True, separators=(",", ":"))
    return int(hashlib.sha256(canon.encode("utf-8")).hexdigest(), 16)


def queue_slots(q, cfg):
    """The q queue places, front to back: (height, centre x, foot y), one depth rule for every figure (height = height_k x (foot y - horizon y)),
    the feet on the line from `from` to `to`; the spacing factor is the largest on fac (bisected) that keeps the last centre at or left of fit_x."""
    Q = cfg["queue"]; (x0, y0), (xe, ye) = Q["from"], Q["to"]; asp = Q["aspect"]
    hy = lambda y: cfg["height_k"] * (y - cfg["horizon_y"])
    yp = lambda x: y0 - (y0 - ye) * (x - x0) / (xe - x0)

    def build(fac):
        sl = []; x = x0
        for _ in range(q):
            h = hy(yp(x)); cx = x + asp * h * 0.5; y = yp(cx); h = hy(y)
            sl.append((h, cx, y)); nxt = asp * hy(yp(cx + Q["probe"]))
            x = cx + fac * 0.5 * (asp * h + nxt)
        return sl
    lo, hi = Q["fac"]
    for _ in range(25):
        f = (lo + hi) / 2
        if build(f)[-1][1] > Q["fit_x"]: hi = f
        else: lo = f
    return build(lo)


def slots_of(n, cfg):
    """The n places: the queue (front to back) and then the foreground group (n // per_foreground of its places, at most all, spread)."""
    F = cfg["foreground"]; f = min(len(F["at"]), n // F["per"])
    q = n - f; sl = [(h, x, y, "queue") for h, x, y in queue_slots(q, cfg)]
    for j in range(f):
        x, y = F["at"][(2 * j + 1) * len(F["at"]) // (2 * f)]
        sl.append((cfg["height_k"] * (y - cfg["horizon_y"]), x, y, "front"))
    return sl, q


def accent_slots(k, n, q, sl, cfg, left):
    """The k places whose figures wear the accent: spread evenly over the clear places of the queue (not its first and last figure, at least
    red_min_h high, and right edge, at the queue's aspect, left of `left`, the foreground group's left edge, so no accent figure stands hidden
    behind that group); when k is more than those, then the queue's first figure, the foreground group, the other queue places and its last figure."""
    asp = cfg["queue"]["aspect"]
    clear = [i for i in range(1, q - 1) if sl[i][0] >= cfg["red_min_h"] and sl[i][1] + asp * sl[i][0] / 2 < left]
    if k <= len(clear): return [clear[(2 * j + 1) * len(clear) // (2 * k)] for j in range(k)]
    rest = []
    for i in [0] + list(range(q, n)) + list(range(1, q - 1)) + [q - 1]:
        if i not in clear and i not in rest: rest.append(i)
    return clear + rest[:k - len(clear)]


def grid_bits(hexs, gw, gh):
    b = bytes.fromhex(hexs); return [bool(b[i >> 3] >> (7 - (i & 7)) & 1) for i in range(gw * gh)]


class Cover:
    """A coarse occupancy of the frame (cells of `cell` px): which cells the figures already placed in front hide."""
    def __init__(self, cell):
        self.cell = cell; self.cols = -(-CW // cell); self.rows = -(-CH // cell); self.on = bytearray(self.cols * self.rows)

    def cells(self, box, bits, gw, gh):
        x0, y0, w, h = box; c = self.cell
        for cy in range(max(0, int(y0 // c)), min(self.rows, int((y0 + h) // c) + 1)):
            v = ((cy + 0.5) * c - y0) / h
            if not 0 <= v < 1: continue
            for cx in range(max(0, int(x0 // c)), min(self.cols, int((x0 + w) // c) + 1)):
                u = ((cx + 0.5) * c - x0) / w
                if 0 <= u < 1 and bits[int(v * gh) * gw + int(u * gw)]: yield cy * self.cols + cx

    def paint(self, box, bits, gw, gh):
        for i in self.cells(box, bits, gw, gh): self.on[i] = 1

    def visible(self, box, bits, gw, gh):
        """(the share of the given cells no figure in front hides, how many cells)"""
        tot = vis = 0
        for i in self.cells(box, bits, gw, gh):
            tot += 1; vis += not self.on[i]
        return (vis / tot if tot else 0.0), tot


def draw(codes, k, n, width, accent, cfg):
    """{"inner": the layered svg over the 1440x560 frame, "composition": ..., "red": the accent figures' ids}. codes: the members' codes (only
    their sorted set seeds the picture); k of n figures wear the accent; width: the page width the picture is drawn at (it picks the size tier
    of each figure: the smallest whose height is at least the figure's drawn height); accent: #rrggbb."""
    index, _ = pack()
    rng = random.Random(seed_of(codes, k, n, width, index["bin_sha256"]))
    figs = {f["id"]: f for f in index["figures"] if f["usable"]}
    order = sorted(figs); rng.shuffle(order)
    if n > len(order): raise PackError(f"collage: {n} figures asked, the pack holds {len(order)}")
    sl, q = slots_of(n, cfg)
    by_id = {p["id"]: p for p in index["pieces"]}
    scale = width / float(CW); tiers = sorted(index["tiers"].items(), key=lambda t: t[1])

    def tier_of(h):
        return next((t for t, cap in tiers if cap >= h * scale), tiers[-1][0])

    def box_of(i, fid):
        h, x, y, _ = sl[i]; t = tier_of(h); p = by_id[f"{fid}.{t}.lines"]     # a cut-out is cropped to its outline: its height is the figure's
        w = h * p["w"] / p["h"]
        return (x - w / 2, y - h, w, h), t
    plain = [f for f in order if not figs[f]["red_ok"]] + [f for f in order if figs[f]["red_ok"]][::-1]   # the plain places take the figures whose clothing reads worst first
    chosen = [None] * n
    for i in range(q, n): chosen[i] = plain.pop(0)       # the foreground group first: its left edge bounds the queue's clear places
    left = min((box_of(i, chosen[i])[0][0] for i in range(q, n)), default=float("inf"))
    red = set(accent_slots(k, n, q, sl, cfg, left))
    for i in sorted(red, reverse=True):
        if chosen[i] is not None: plain.insert(0, chosen[i]); chosen[i] = None        # a foreground place that wears the accent gives its figure back
    for i in range(q):
        if i not in red: chosen[i] = plain.pop(0)
    taken = set(f for f in chosen if f)
    pool = [f for f in order if figs[f]["red_ok"] and f not in taken]
    # draw order: farthest first (the foot higher up), ties by place; the accent figures are chosen front to back against what stands in front
    draw_order = sorted(range(n), key=lambda i: (sl[i][2], i))
    cover = Cover(cfg["cover_cell"]); gw, gh = 16, 40; seen = {}
    for i in reversed(draw_order):
        if chosen[i] is None:
            best = None
            for fid in pool:
                g = figs[fid]["grid"]; box, _ = box_of(i, fid)
                v, tot = cover.visible(box, grid_bits(g["cloth"], g["w"], g["h"]), g["w"], g["h"])
                if tot and v >= cfg["red_visible"]: best = (v, fid); break
                if best is None or v > best[0]: best = (v, fid)
            chosen[i] = best[1]; pool.remove(best[1]); seen[i] = round(best[0], 3)
        g = figs[chosen[i]]["grid"]; gw, gh = g["w"], g["h"]
        cover.paint(box_of(i, chosen[i])[0], grid_bits(g["sil"], gw, gh), gw, gh)
    paper = index["paper"]; ink_k = cfg["far_light"]
    out = [f'<image href="{href("paper")}" width="{CW}" height="{CH}" preserveAspectRatio="none"/>']
    shadow = href("shadow"); used = []
    for j, i in enumerate(draw_order):
        fid = chosen[i]; (x0, y0, w, h), t = box_of(i, fid); used.append(f"{fid}.{t}")
        H = sl[i][0]; sw = w * cfg["shadow"]["w"]; sh = max(cfg["shadow"]["min_h"], H * cfg["shadow"]["h"])
        out.append(f'<g transform="translate({num(x0 + w / 2 - sw / 2)},{num(sl[i][2] - sh)})"><image href="{shadow}" width="{num(sw)}" height="{num(2 * sh)}" preserveAspectRatio="none"/></g>')
        box = f'M0 0H{num(w)}V{num(h)}H0Z'; size = f'width="{num(w)}" height="{num(h)}" preserveAspectRatio="none"'
        parts = [f'<g transform="translate({num(x0)},{num(y0)})"><defs><mask id="clg-s{j}"><image href="{href(f"{fid}.{t}.sil")}" {size}/></mask>']
        if i in red: parts.append(f'<mask id="clg-c{j}"><image href="{href(f"{fid}.{t}.cloth")}" {size}/></mask>')
        parts.append(f'</defs><path d="{box}" fill="{paper}" mask="url(#clg-s{j})"/>')
        if i in red: parts.append(f'<path d="{box}" fill="{accent}" mask="url(#clg-c{j})"/>')
        light = ink_k[0] + ink_k[1] * min(1.0, H / ink_k[2])        # far figures lighter (the reference picture's rule)
        parts.append(f'<g opacity="{num(light)}"><image href="{href(f"{fid}.{t}.lines")}" {size}/></g></g>')
        out.append("".join(parts))
    out.append(f'<defs><mask id="clg-grain"><image href="{href("grain")}" width="{CW}" height="{CH}" preserveAspectRatio="none"/></mask></defs>'
               f'<path d="M0 0H{CW}V{CH}H0Z" fill="#000000" opacity="{num(index["grain_opacity"])}" mask="url(#clg-grain)"/>')
    comp = dict(layout=f"collage-{k}of{n}", objects=n, lit=k, omitted=0, queue=q, foreground=n - q, pieces=used,
                red=sorted(chosen[i] for i in red), red_visible_min=min(seen.values()) if seen else None)
    return {"inner": "".join(out), "composition": comp, "red": [chosen[i] for i in sorted(red)]}
