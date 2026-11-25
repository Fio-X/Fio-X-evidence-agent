"""The collage drawing of the opening picture (run_hero.py build_collage; node.json topics.collage_renderer and the composition knobs whose
renderers are [collage]): N engraving cut-outs (pack.bin, indexed by pack.json, built once by scripts/build_collage_pack.py) in one queue
on a whole sheet of paper. The queue's front figure is the hero, large in the left-front third, the darkest and clearest figure; the rest
of the queue stands right behind it and recedes up and to the right, near-large to far-small in one continuous sweep, every figure by
one depth rule. K of the N wear the accent on their clothing under the engraving lines; the hero is the front-most of the K. Standard
library only and no pixel work: the picture is layered SVG over the 1440x560 frame, every raster a PNG or JPEG data URL taken from the
pack as it is.

Layers, back to front: the paper (<image>, one sheet: no ground band); then per figure, farthest first: its soft foot shadow (<image>), a
block cut to its outline (a <path> under a <mask> of the 1-bit outline: the queue's in queue_fill grey, the hero's in the paper at hero_fill),
for an accent figure an accent block cut to its clothing (a <path> under a <mask> of the 1-bit clothing), and its lines (<image>: ink over
transparency, so the block or the accent shows between the lines; the queue's at queue_ink, its accent figures' at red_ink, the hero's at
full ink); last the grain (a
<path> under a <mask> of the grain JPEG). Place and size come only from an outer <g transform="translate(x,y)"> and the <image> width and
height, as the page's hero check (next_leaf.rs hero_faults) allows.

Only the figures with a hand-set clothing mask wear the accent (pack.json red_ok, read as it is); when K is more than there are, they come
round again in the same seeded order (composition: red_repeats), never two of the same in one group and no figure more than max_uses times in
the picture (composition: uses_max); K over max_uses x the masked figures is a PackError (unavailable). The accent places follow one spread
rule for every K (accent_places; composition: red_rule, red_adjacent). Behind the queue, right after the paper, the backdrop (far_slots;
composition: far, far_ids, far_pieces, far_layers): layers of pale figures, each paler and smaller than the one in front, their ends fading into
the paper, no figure twice in a layer; they are not among the N. An accent figure's lines lie over its accent at red_ink, once; the queue's accent at queue_red_opacity, the hero's full.

Same request, same bytes: the figures and their places come from random.Random seeded with the sha256 of the canonical JSON of the sorted
member codes (for a proportion its share), K, N, the width, the knobs and the pack's sha256; no clock, no hash(), no unseeded random."""
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


def tone(paper, level):
    """The paper colour darkened to `level` (1 = the paper): the queue's blocks stay in the paper's own warm grey."""
    return "#" + "".join(f"{max(0, min(255, round(int(paper[i:i + 2], 16) * level))):02x}" for i in (1, 3, 5))


def seed_of(codes, k, n, width, knobs, pack_sha):
    canon = json.dumps({"codes": sorted(codes), "k": k, "n": n, "width": width, "knobs": knobs, "pack": pack_sha}, sort_keys=True, separators=(",", ":"))
    return int(hashlib.sha256(canon.encode("utf-8")).hexdigest(), 16)


def depth_rule(kn):
    """(the hero's foot (x, y), the far end's foot (x, y), hy): every figure's feet lie on the line from the hero's feet to the far end's, and its
    height is hy(foot y) = k x (foot y - yh), the one linear depth rule through the hero (hero_h at hero_foot) and the far end (queue_far_h at
    queue_far_foot)."""
    hH, fH = kn["hero_h"] * CH, kn["queue_far_h"] * CH
    h0 = (kn["hero_x"] * CW, kn["hero_foot"] * CH); f0 = (kn["queue_far_x"] * CW, kn["queue_far_foot"] * CH)
    k = (hH - fH) / (h0[1] - f0[1]); yh = h0[1] - hH / k
    return h0, f0, (lambda y: k * (y - yh))


def queue_slots(q, kn, cfg):
    """The q queue places behind the hero, near to far: (height, centre x, foot y). The first stands queue_gap x the hero's height right of
    the hero; each next one a spacing factor x the mean width of the two further on, the factor the largest on fac (bisected) that keeps the
    last centre at or left of the far end."""
    Q = cfg["queue"]; asp = Q["aspect"]; (hx, hy0), (fx, fy), hy = depth_rule(kn)
    yp = lambda x: hy0 - (hy0 - fy) * (x - hx) / (fx - hx)
    first = hx + kn["queue_gap"] * kn["hero_h"] * CH

    def build(fac):
        sl = []; cx = first
        for _ in range(q):
            y = yp(cx); h = hy(y); sl.append((h, cx, y))
            cx = cx + fac * 0.5 * asp * (h + hy(yp(cx + Q["probe"])))
        return sl
    lo, hi = Q["fac"]
    for _ in range(25):
        f = (lo + hi) / 2
        if q and build(f)[-1][1] > fx: hi = f
        else: lo = f
    return build(lo)


def accent_places(kq, q, sl, cfg):
    """The queue places (0 = nearest) whose figures wear the accent (kq of them; the hero is not in the queue): one rule for every K (no share
    threshold, so K / N just under or over any line gives the same kind of picture): the kq places spread evenly over a run of candidate places,
    the first run of these that holds at least 2 x kq places (so no two accent figures stand side by side: a grey figure between every two),
    else the widest: (1) the clear places (not place 0, which touches the hero, nor the last; at least red_min_h high), (2) every place but 0,
    (3) every place. Returns the flags near to far ('r' accent, 'g' grey)."""
    if kq <= 0: return "g" * q
    runs = [[i for i in range(1, q - 1) if sl[i][0] >= cfg["red_min_h"]], list(range(1, q)), list(range(q))]
    cand = next((c for c in runs if len(c) >= 2 * kq), runs[-1])
    red = set(cand[(2 * j + 1) * len(cand) // (2 * kq)] for j in range(kq))
    return "".join("r" if i in red else "g" for i in range(q))


def far_counts(n, cfg):
    """How many far figures each layer draws for a picture of n figures: per_figure x n x ramp, the ramp rising from 0 at n = ramp[0] to 1 at
    n = ramp[1] (so no backdrop for a short queue, and no jump at any n), shared over the layers in the ratio of their n (largest remainder).
    The far crowd never outnumbers per_figure x the counted figures, so the queue stays what the eye counts."""
    F = cfg["far"]; a, b = F["ramp"]; total = round(F["per_figure"] * n * max(0.0, min(1.0, (n - a) / (b - a))))
    w = [L["n"] for L in F["layers"]]; raw = [total * x / sum(w) for x in w]; out = [int(r) for r in raw]
    for i in sorted(range(len(w)), key=lambda i: (out[i] - raw[i], i))[:total - sum(out)]: out[i] += 1
    return out


def far_slots(layer, rng):
    """One layer of the far view (collage_renderer.far.layers): its n places (height, centre x, foot y, end fade), spread evenly over x[0]..x[1]
    of the width with a seeded jitter of the spacing, the height and the foot (so no row has one straight foot line); the end fade falls from
    1 to 0 over the outer `edge` share of the span, so a layer's ends dissolve into the paper."""
    x0, x1 = layer["x"][0] * CW, layer["x"][1] * CW; n = layer["n"]; dx = (x1 - x0) / n; out = []
    for j in range(n):
        x = x0 + (j + 0.5) * dx + (rng.random() - 0.5) * layer["jitter"] * dx
        h = layer["h"] * CH * (1 + (rng.random() - 0.5) * layer["jitter"] * 0.5)
        y = layer["foot"] * CH + (rng.random() - 0.5) * layer["foot_jitter"] * h
        e = max(0.0, min(1.0, (x - x0) / (layer["edge"] * (x1 - x0)), (x1 - x) / (layer["edge"] * (x1 - x0))))
        out.append((h, x, y, e * e * (3 - 2 * e)))
    return out


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


def draw(codes, k, n, width, accent, cfg, kn):
    """{"inner": the layered svg over the 1440x560 frame, "composition": ...}. codes: the members' codes (only their sorted set seeds the
    picture); k of n figures wear the accent, the front-most of them the hero; width: the page width the picture is drawn at (it picks the
    size tier of each figure: the smallest whose height is at least the figure's drawn height); accent: #rrggbb; cfg: collage_renderer;
    kn: the collage knobs, resolved and checked (run_hero.collage_knobs)."""
    index, _ = pack()
    rng = random.Random(seed_of(codes, k, n, width, kn, index["bin_sha256"]))
    figs = {f["id"]: f for f in index["figures"] if f["usable"]}
    order = sorted(figs); rng.shuffle(order)
    if n > len(order): raise PackError(f"collage: {n} figures asked, the pack holds {len(order)}")
    masked = sum(1 for f in figs.values() if f["red_ok"]); cap = cfg["max_uses"]
    if k and not masked: raise PackError("collage: the pack holds no figure with a clothing mask")
    if k > cap * masked: raise PackError(f"collage: {k} accent figures asked, the pack's {masked} masked figures may stand at most {cap} times each")
    by_id = {p["id"]: p for p in index["pieces"]}
    scale = width / float(CW); tiers = sorted(index["tiers"].items(), key=lambda t: t[1])
    hero = None
    if k >= 1:     # the hero: the first red_ok figure whose clothing reads as one strong block, else the first red_ok one
        ok = [f for f in order if figs[f]["red_ok"]]
        hero = next((f for f in ok if figs[f]["solidity"] >= cfg["hero_solidity"]), ok[0])
        order.remove(hero)
    q = n - (1 if hero else 0)
    sl = queue_slots(q, kn, cfg)
    flags = accent_places(k - 1, q, sl, cfg) if hero else "g" * q

    def tier_of(h):
        return next((t for t, cap in tiers if cap >= h * scale), tiers[-1][0])

    def box_of(h, x, y, fid):
        t = tier_of(h); p = by_id[f"{fid}.{t}.lines"]       # a cut-out is cropped to its outline: its height is the figure's
        w = h * p["w"] / p["h"]
        return (x - w / 2, y - h, w, h), t
    plain = [f for f in order if not figs[f]["red_ok"]] + [f for f in order if figs[f]["red_ok"]][::-1]   # the grey places take the figures whose clothing reads worst first
    chosen = [None] * q
    for i in range(q):
        if flags[i] == "g": chosen[i] = plain.pop(0)
    uses = {}
    for f in [hero] + chosen:
        if f: uses[f] = uses.get(f, 0) + 1
    reds = [f for f in order if figs[f]["red_ok"] and f not in uses] + [f for f in order if figs[f]["red_ok"] and f in uses]   # the accent figures' turn order
    pool = [f for f in reds if uses.get(f, 0) < cap]; recent = []
    # the hero stands in front of everything; the queue's accent figures are chosen front to back against what stands in front of them
    hh = kn["hero_h"] * CH; (hx, hy), _, _ = depth_rule(kn)
    cover = Cover(cfg["cover_cell"]); seen = {}
    if hero:
        g = figs[hero]["grid"]; cover.paint(box_of(hh, hx, hy, hero)[0], grid_bits(g["sil"], g["w"], g["h"]), g["w"], g["h"])
    draw_order = sorted(range(q), key=lambda i: (sl[i][2], -i))
    for i in reversed(draw_order):
        h, x, y = sl[i]
        if chosen[i] is None:
            if not pool:          # more accent figures than masked ones: they come round again, none twice within one group, none more than max_uses times
                left = [f for f in reds + [hero] if uses.get(f, 0) < cap]
                pool = [f for f in left if f not in recent[-cfg["group"]:]] or left
            best = None
            spare_red = [f for f in reds if f not in pool and uses.get(f, 0) < cap and f not in recent[-cfg["group"]:]]   # when the turn order has none in view, any other masked figure
            for fid in pool + spare_red:
                g = figs[fid]["grid"]; box, _ = box_of(h, x, y, fid)
                v, tot = cover.visible(box, grid_bits(g["cloth"], g["w"], g["h"]), g["w"], g["h"])
                if tot and v >= cfg["red_visible"]: best = (v, fid); break
                if best is None or v > best[0]: best = (v, fid)
            chosen[i] = best[1]; pool.remove(best[1]) if best[1] in pool else None; recent.append(best[1]); seen[i] = round(best[0], 3); uses[best[1]] = uses.get(best[1], 0) + 1
        g = figs[chosen[i]]["grid"]
        cover.paint(box_of(h, x, y, chosen[i])[0], grid_bits(g["sil"], g["w"], g["h"]), g["w"], g["h"])
    paper = index["paper"]; fl = cfg["far_light"]
    out = [f'<image href="{href("paper")}" width="{CW}" height="{CH}" preserveAspectRatio="none"/>']
    shadow = href("shadow"); used = []

    def figure(tag, fid, h, x, y, red, fill, ink):
        (x0, y0, w, hh_), t = box_of(h, x, y, fid); used.append(f"{fid}.{t}")
        sw = w * cfg["shadow"]["w"]; sh = max(cfg["shadow"]["min_h"], h * cfg["shadow"]["h"])
        out.append(f'<g transform="translate({num(x - sw / 2)},{num(y - sh)})"><image href="{shadow}" width="{num(sw)}" height="{num(2 * sh)}" preserveAspectRatio="none"/></g>')
        box = f'M0 0H{num(w)}V{num(hh_)}H0Z'; size = f'width="{num(w)}" height="{num(hh_)}" preserveAspectRatio="none"'
        parts = [f'<g transform="translate({num(x0)},{num(y0)})"><defs><mask id="clg-s{tag}"><image href="{href(f"{fid}.{t}.sil")}" {size}/></mask>']
        if red: parts.append(f'<mask id="clg-c{tag}"><image href="{href(f"{fid}.{t}.cloth")}" {size}/></mask>')
        parts.append(f'</defs><path d="{box}" fill="{fill}" mask="url(#clg-s{tag})"/>')
        if red: parts.append(f'<path d="{box}" fill="{accent}" mask="url(#clg-c{tag})"' + (f' opacity="{num(red)}"' if red < 1 else "") + '/>')      # the accent under the lines
        lines = href(f"{fid}.{t}.lines")
        parts.append(f'<g opacity="{num(ink)}"><image href="{lines}" {size}/></g>')
        parts.append('</g>')
        out.append("".join(parts))
        return (x0, y0, w, hh_)
    # the far view (collage_renderer.far): layers far to near, each paler and smaller than the one in front of it, its ends dissolving into the
    # paper; within a layer no figure twice, across the picture none more than max_uses times (the least drawn first); no accent, not among the N
    F = cfg["far"]; far_used = []; far_ids = []; far_layers = []; j = 0

    def far_layer(L):
        nonlocal j
        mine = set(); cnt = 0
        for h, x, y, e in far_slots(L, rng):
            fid = min((f for f in order if uses.get(f, 0) < cap and f not in mine), key=lambda f: (uses.get(f, 0), order.index(f)), default=None)
            if fid is None or e <= 0.02: continue
            mine.add(fid); uses[fid] = uses.get(fid, 0) + 1; far_ids.append(fid); cnt += 1
            (x0, y0, w, hb), t = box_of(h, x, y, fid); far_used.append(f"{fid}.{t}")
            size = f'width="{num(w)}" height="{num(hb)}" preserveAspectRatio="none"'
            out.append(f'<g transform="translate({num(x0)},{num(y0)})"><defs><mask id="clg-f{j}"><image href="{href(f"{fid}.{t}.sil")}" {size}/></mask></defs>'
                       f'<path d="M0 0H{num(w)}V{num(hb)}H0Z" fill="{tone(paper, 1 - (1 - L["fill"]) * e)}" mask="url(#clg-f{j})"/>'
                       f'<g opacity="{num(L["ink"] * e)}"><image href="{href(f"{fid}.{t}.lines")}" {size}/></g></g>'); j += 1
        far_layers.append(cnt)
    for L, m in zip(F["layers"], far_counts(n, cfg)):
        if m: far_layer(dict(L, n=m))
    qfill = tone(paper, kn["queue_fill"])
    for j, i in enumerate(draw_order):
        h, x, y = sl[i]
        r = flags[i] == "r"      # an accent figure's lines at red_ink, never faded with distance: the engraving stays legible over the accent
        figure(str(j), chosen[i], h, x, y, cfg["queue_red_opacity"] if r else 0, qfill, cfg["red_ink"] if r else kn["queue_ink"] * (fl[0] + fl[1] * min(1.0, h / fl[2])))
    hero_box = figure("h", hero, hh, hx, hy, True, tone(paper, cfg["hero_fill"]), 1.0) if hero else None
    out.append(f'<defs><mask id="clg-grain"><image href="{href("grain")}" width="{CW}" height="{CH}" preserveAspectRatio="none"/></mask></defs>'
               f'<path d="M0 0H{CW}V{CH}H0Z" fill="#000000" opacity="{num(index["grain_opacity"])}" mask="url(#clg-grain)"/>')
    comp = dict(layout=f"collage-{k}of{n}", objects=n, lit=k, omitted=0, queue=q, queue_flags=flags, pieces=used,
                hero=hero, hero_h=round(hh / CH, 4) if hero else None, hero_foot=round(hy, 2) if hero else None,
                hero_box=[round(v, 2) for v in hero_box] if hero else None, queue_feet=[round(s[2], 2) for s in sl],
                queue_heights=[round(s[0], 2) for s in sl], queue_x=[round(s[1], 2) for s in sl], queue_ids=list(chosen),
                red=sorted([chosen[i] for i in range(q) if flags[i] == "r"] + ([hero] if hero else [])),
                red_visible_min=min(seen.values()) if seen else None)
    comp["red_repeats"] = len(comp["red"]) - len(set(comp["red"]))
    comp.update(red_rule="spread", red_adjacent=sum(1 for a, b in zip(flags, flags[1:]) if a == b == "r"), red_ok_count=masked, max_uses=cap,
                uses_max=max(uses.values()) if uses else 0, far=len(far_ids), far_ids=far_ids, far_pieces=far_used, far_layers=far_layers)
    return {"inner": "".join(out), "composition": comp}
