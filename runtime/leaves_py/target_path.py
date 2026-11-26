"""target_path layer: the path so far and where each pace carried on would land, in line.py's layer style: the subject's
past series as one line in the accent (its first and last value printed by their points, above where nothing passes, else at
the nearest place clear of every line: value_spot), from its last point a
dotted ink line to the target and one dashed grey line per projected pace, each straight to the target period; the
target a hollow dot in ink; right of the target period a column of labels (the target's and each pace's value and words,
spread so none overlaps another, a leader to one moved off its point) and a bracket from the target to the pace nearest
it, with the gap's words beside it. The target may lie above or below the paces (a share to raise, an emission to cut);
the bracket and the gap words are drawn only where no pace reaches the target.
The value axis from 0 (line.py's: hairlines, the printed tick at their left, the unit once in the head); the period axis
under the plot: the request's period entries, the first and the last always and one between where it overlaps none kept,
and the target's period entry at the target.
Every printed number is a ledger entry printed with FX.entry; every word comes with the request as segments.

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs, "unit": segs,                      # the unit is written once, in the head
  "series": {"code": code,                          # the subject (data-code only; its name, if any, is in the words)
             "points": [series src, ...],           # its cells in period order (geometry only)
             "start_text": ledger src, "end_text": ledger src},  # the first and last value as printed
  "target": {"year": ledger src,                    # the target period as printed (a year, quarter or month text)
             "text": ledger src, "label": segs},    # the target value as printed and its words
  "runs": [{"text": ledger src, "label": segs}],    # each pace's value at the target period (layer 1's facts), its words
  "axis": {"ticks": [ledger src, ...], "scale": number},  # ascending, each printed text a number, from 0 up
  "periods": [ledger src, ...],                     # period:<table>:<period> entries of the past series' points
  "gap_label": segs?,                               # the gap's words (a {"src"} segment prints the gap's own fact)
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): rate_<code> (a pace, when the
words print it), proj_<code>_<year> (each run: the series carried on at that pace to the target year), target_<code> with
its period (the target value and year), gap_<code> (the gap, when gap_label prints it), cross_<code>_<target> (the first
year a pace reaches the target, when the words print it).
needs new wording: none fixed; the target's, each pace's and the gap's words come from the data as segments.
Refuses: fewer than two points, points out of period order or twice at one period, a value below 0, no run, a target
period that is not after the last point, a value text that is no number, no tick or ticks not ascending or a tick text
that is no number, a period entry no point has, a gap_label where a run reaches the target, labels that cannot all fit
the plot's height, a digit in a literal word, a text that leaves the picture or overlaps another, a board too narrow (plot
under 240 px)."""
import math
import re

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "target_path"
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), plot_h=(320, (160, 600, 10), "plot height in px"),
    end_size=(14, (11, 20, 0.5), "size px of the first and last value of the past line"),
    line_w=(3, (1.5, 5, 0.5), "the past line's width in px"), run_w=(1.6, (0.8, 3, 0.1), "a pace's dashed line width in px"))

NUM = re.compile(r"[-−]?[0-9][0-9,]*(?:\.[0-9]+)?%?")


def number(src, scale, what):
    """The raw value a ledger entry prints (its number over the format's scale); a text that is no number refuses."""
    text = FX.text(src).strip()
    if not NUM.fullmatch(text): raise Refused(f"target_path: {what} {text!r} ({src}) is no number")
    return float(text.replace(",", "").replace("−", "-").rstrip("%")) / scale


def pieces(v, what, bold_src=None):
    """[(text, src or None, bold)] of an optional bold value then the words' segments (wbkit.segs checks them)."""
    out = [(FX.text(bold_src), bold_src, True), (" ", None, False)] if bold_src else []
    return out + [(t, s, False) for t, s in K.segs(v, what)]


def inline(B, ps, x, y, size, fill, anchor="start", weight=400, tag="text", style=""):
    """One <text> of pieces: an entry marked with its src (bold where asked), words escaped; its box checked in B."""
    inner = "".join((f'<tspan font-weight="700">{FX.entry(s, "tspan", None) if s else esc(t)}</tspan>' if b else
                     FX.entry(s, "tspan", None) if s else esc(t)) for t, s, b in ps)
    return K.txt(B, x, y, size, fill, inner, tw("".join(t for t, _, _ in ps), size), anchor=anchor, weight=weight, tag=tag, style=style)


HALO = ' stroke="var(--bg)" stroke-width="4" paint-order="stroke"'

def crosses(box, pts, half):
    """A stroke (the polyline `pts`, half its width `half`) comes within the box (x0, y0, x1, y1): sampled along each segment as
    the page's text-on-line check samples it (1.5 px steps)."""
    x0, y0, x1, y1 = box[0] - half, box[1] - half, box[2] + half, box[3] + half
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        n = max(1, int(max(abs(bx - ax), abs(by - ay)) / 1.5))
        for i in range(n + 1):
            x, y = ax + (bx - ax) * i / n, ay + (by - ay) * i / n
            if x0 < x < x1 and y0 < y < y1: return True
    return False


def value_spot(B, px, py, w, size, lo, hi, vlo, vhi, hard, soft):
    """Where the value printed by the point (px, py) stands: (centre x, baseline) of the nearest place to the point whose box
    is clear of every stroke in `hard` (the past line, the dotted and the dashed lines, the hairlines, the axis, the target's
    ring) and, where one is, of `soft` too (dots) and over no text already in B. The first try is centred just above the point;
    then a grid of places within 85 px of the point, nearest first (above before below, centred before aside), inside the plot,
    then out over the ticks' column as far as the picture's edge; always within the heights vlo to vhi (the plot's). None clear of the hard ones: the first try."""
    box = lambda bx, yb: (bx, yb - size * 0.95, bx + w, yb + size * 0.3)
    def free(bx, yb):
        x0, y0, x1, y1 = bx - 2, yb - size * 0.8 - 2, bx + w + 2, yb + size * 0.25 + 2
        return not any(x0 < a[2] and a[0] < x1 and y0 < a[3] and a[1] < y1 for a, _ in B.b)
    first = (min(max(px - w / 2, lo), hi - w), py - 10)
    for room in (lo, 4):
        left = lambda bx: min(max(bx, room), hi - w)
        near = []
        for yb in range(int(py) - 90, int(py) + 110, 2):
            for bx in range(int(px - w - 80), int(px + 81), 4):
                bx = left(bx); x0, y0, x1, y1 = box(bx, yb)
                d = math.hypot(max(x0 - px, 0, px - x1), max(y0 - py, 0, py - y1))
                if 5.5 <= d <= 85 and vlo <= y0 and y1 <= vhi: near.append((d + (3 if yb > py else 0) + abs(bx + w / 2 - px) * 0.01, bx, yb))
        for strokes in (hard + soft, hard):
            for bx, yb in ([first] if room == lo else []) + [(bx, yb) for _, bx, yb in sorted(near)]:
                if free(bx, yb) and not any(crosses(box(bx, yb), pts, half) for pts, half in strokes): return bx + w / 2, yb
    return first[0] + w / 2, first[1]


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        s = d.get("series")
        if not isinstance(s, dict) or not isinstance(s.get("code"), str) or not K.CODE.fullmatch(s["code"]): raise Refused("target_path: the series names no code")
        f.code = s["code"]
        pts = s.get("points")
        if not isinstance(pts, list) or len(pts) < 2: raise Refused("target_path: the series has fewer than two points")
        f.pts, seen = [], set()
        for src in pts:
            p = K.period_of(src); t, v = K.period_at(p), K.val(src)
            if p in seen: raise Refused(f"target_path: the series has two points at {p}")
            if f.pts and t <= f.pts[-1][0]: raise Refused(f"target_path: the points are not in period order at {p}")
            if v < 0: raise Refused(f"target_path: a value below 0 at {p}; the axis starts at 0")
            seen.add(p); f.pts.append((t, v, p))
        for key in ("start_text", "end_text"):
            if not s.get(key): raise Refused(f"target_path: the series has no {key} (the ledger entry its value prints from)")
        f.start, f.end = s["start_text"], s["end_text"]
        FX.text(f.start), FX.text(f.end)
        axis = d.get("axis") or {}
        scale = axis.get("scale")
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not scale > 0: raise Refused(f"target_path: the axis scale {scale!r} is no number above 0")
        ticks = axis.get("ticks")
        if not isinstance(ticks, list) or not ticks: raise Refused("target_path: the axis holds no tick (fact:<key>.tick<i>, layer 1's)")
        f.ticks = []
        for src in ticks:
            raw = number(src, scale, "the tick")
            if f.ticks and raw <= f.ticks[-1][0]: raise Refused(f"target_path: the ticks are not ascending at {src}")
            f.ticks.append((raw, K.ent(src)))
        tg = d.get("target")
        if not isinstance(tg, dict) or not tg.get("year") or not tg.get("text"): raise Refused("target_path: the target names no year and text (ledger entries)")
        f.t_year = K.period_at(FX.text(tg["year"]).strip())
        if f.t_year <= f.pts[-1][0]: raise Refused("target_path: the target period is not after the series' last point")
        f.target = dict(v=number(tg["text"], scale, "the target"), text=tg["text"], label=tg.get("label"), year=tg["year"])
        K.segs(f.target["label"], "the target's label")
        runs = d.get("runs")
        if not isinstance(runs, list) or not runs: raise Refused("target_path: the spec holds no run (a pace carried to the target)")
        f.runs = []
        for i, r in enumerate(runs):
            if not isinstance(r, dict) or not r.get("text"): raise Refused(f"target_path: run {i + 1} names no text")
            K.segs(r.get("label"), f"run {i + 1}'s label")
            f.runs.append(dict(v=number(r["text"], scale, f"run {i + 1}"), text=r["text"], label=r["label"], what=f"run {i + 1}"))
        if min([f.target["v"]] + [r["v"] for r in f.runs]) < 0: raise Refused("target_path: a value below 0; the axis starts at 0")
        last = f.pts[-1][1]
        f.dir = 1 if f.target["v"] > last else -1 if f.target["v"] < last else 0
        reach = [r["what"] for r in f.runs if f.dir == 0 or (r["v"] - f.target["v"]) * f.dir >= 0]
        if reach and d.get("gap_label"): raise Refused(f"target_path: {reach[0]} reaches the target; there is no gap for gap_label to name")
        f.near = None if reach else max(f.runs, key=lambda r: (r["v"] - last) * f.dir)
        f.top = max([v for _, v, _ in f.pts] + [r["v"] for r in f.runs] + [f.target["v"], f.ticks[-1][0]])
        if f.top <= 0: raise Refused("target_path: every value is 0; a line over an axis from 0 needs one above it")
        times = {p: t for t, _, p in f.pts}
        f.periods = []
        for src in d.get("periods") or []:
            if not isinstance(src, str) or not src.startswith("period:"): raise Refused(f"target_path: the period entry {src!r} is no period:<table>:<period>")
            p = src.rsplit(":", 1)[1]
            if p not in times: raise Refused(f"target_path: the period entry {src} names {p}, which no point has")
            f.periods.append((times[p], K.ent(src)))
        size = f.size
        f.labels = [dict(key="the target", v=f.target["v"], ps=pieces(f.target["label"], "the target's label", f.target["text"]), weight=400)]
        f.labels += [dict(key=r["what"], v=r["v"], ps=pieces(r["label"], f"{r['what']}'s label", r["text"]), weight=400) for r in f.runs]
        if f.near and d.get("gap_label"):
            f.labels.append(dict(key="the gap label", v=(f.target["v"] + f.near["v"]) / 2, ps=pieces(d["gap_label"], "gap_label"), weight=700))
        f.tick_w = max(tw(e[1], size) for _, e in f.ticks) + 8
        f.label_w = max(tw("".join(t for t, _, _ in lb["ps"]), size) for lb in f.labels)
        f.x0, f.x1 = 8 + f.tick_w, f.W - 8 - f.label_w - 34
        if f.x1 - f.x0 < 240: raise Refused("target_path: the board is too narrow for the ticks, the plot and the labels (plot under 240 px)")
        f.t0, f.H = f.pts[0][0], 0

    def x(f, t):
        return f.x0 + (f.x1 - f.x0) * (t - f.t0) / (f.t_year - f.t0)


def cl_target_path(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    es = f.k("end_size")
    top = 22 + size * 1.4 + es * 1.6
    bottom = top + f.k("plot_h")
    yv = lambda v: bottom - (bottom - top) * v / f.top
    for raw, (svg_t, text) in f.ticks:  # the value axis: a hairline per tick across the plot, its number at the left
        y = yv(raw)
        o.append(K.line(f.x0, y, f.x1, y))
        o.append(K.txt(B, f.x0 - 6, y + size * 0.35, size, "var(--t-sec)", svg_t, tw(text, size), anchor="end", tag=f"tick {text}"))
    o.append(K.line(f.x0, bottom, f.x1, bottom, stroke="var(--t-title)", w=0.8, op=1))
    # the period axis: the target's period and the first and last of the series always, one between where it overlaps none kept
    ly = bottom + size * 1.5
    tgt = (f.t_year, K.ent(f.target["year"]))
    order = [tgt] + (f.periods[:1] + f.periods[-1:] + f.periods[1:-1] if len(f.periods) > 1 else f.periods)
    kept, boxes = [], []
    for t, (svg_p, text) in order:
        x, w = f.x(t), tw(text, size)
        b = (x - w / 2, x + w / 2)
        if any(b[0] < a[1] + 6 and a[0] < b[1] + 6 for a in boxes): continue
        boxes.append(b); kept.append((t, svg_p, text))
    for t, svg_p, text in sorted(kept, key=lambda e: e[0]):
        x = f.x(t)
        o.append(K.line(x, bottom, x, bottom + 4, stroke="var(--t-title)", w=0.8, op=1))
        o.append(K.txt(B, x, ly, size, "var(--t-sec)", svg_p, tw(text, size), anchor="middle", weight=700 if t == f.t_year else 400, tag=f"period {text}"))
    # from the last point: the dotted way to the target, then each pace dashed in grey (the furthest the darkest)
    lt, lv, _ = f.pts[-1]
    gx = f.x(f.t_year)
    o.append(f'<line x1="{f.x(lt):.1f}" y1="{yv(lv):.1f}" x2="{gx:.1f}" y2="{yv(f.target["v"]):.1f}" stroke="var(--t-title)" stroke-width="1.2" '
             f'stroke-dasharray="2 4" data-part="needed"/>')
    for i, r in enumerate(f.runs):
        wd = f.k("run_w") + 0.4 * i
        o.append(f'<line x1="{f.x(lt):.1f}" y1="{yv(lv):.1f}" x2="{gx:.1f}" y2="{yv(r["v"]):.1f}" stroke="var(--t-sec)" stroke-width="{wd:.1f}" '
                 f'stroke-dasharray="6 5" data-part="run"/>')
        o.append(f'<circle cx="{gx:.1f}" cy="{yv(r["v"]):.1f}" r="4.5" fill="var(--t-sec)" data-part="run-end"/>')
    pts = " ".join(f"{f.x(t):.1f},{yv(v):.1f}" for t, v, _ in f.pts)
    o.append(f'<polyline points="{pts}" fill="none" stroke="var(--accent)" stroke-width="{f.k("line_w")}" stroke-linejoin="round" '
             f'stroke-linecap="round" data-code="{esc(f.code)}"/>')
    # the past line's first and last value, by their points: a place clear of every line (value_spot)
    hard = [([(f.x(t), yv(v)) for t, v, _ in f.pts], f.k("line_w") / 2), ([(f.x(lt), yv(lv)), (gx, yv(f.target["v"]))], 0.6),
            ([(f.x0, bottom), (f.x1, bottom)], 0.4)]
    hard += [([(f.x(lt), yv(lv)), (gx, yv(r["v"]))], (f.k("run_w") + 0.4 * i) / 2) for i, r in enumerate(f.runs)]
    ty = yv(f.target["v"])
    hard.append(([(gx + 7.2 * math.cos(a / 8 * math.pi), ty + 7.2 * math.sin(a / 8 * math.pi)) for a in range(17)], 0.5))
    hard += [([(f.x0, yv(raw)), (f.x1, yv(raw))], 0.3) for raw, _ in f.ticks]  # the page's line check counts a hairline too
    soft = [([(cx - 5, cy), (cx + 5, cy)], 5) for cx, cy in [(gx, yv(r["v"])) for r in f.runs] + [(f.x(t), yv(v)) for t, v, _ in (f.pts[0], f.pts[-1])]]
    for (t, v, _), src, wt in ((f.pts[0], f.start, 400), (f.pts[-1], f.end, 700)):
        x, y = f.x(t), yv(v)
        o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4.5" fill="var(--accent)" data-code="{esc(f.code)}"/>')
        text = FX.text(src); w = tw(text, es)
        xx, yy = value_spot(B, x, y, w, es, f.x0, f.x1, top - es * 1.2, bottom, hard, soft)
        o.append(K.txt(B, xx, yy, es, "var(--t-title)", FX.entry(src, "tspan", None), w, anchor="middle", weight=wt,
                       tag=f"value {text}", style=HALO))
    o.append(f'<circle cx="{gx:.1f}" cy="{yv(f.target["v"]):.1f}" r="6" fill="var(--bg)" stroke="var(--t-title)" stroke-width="2.4" data-part="target"/>')
    # the label column right of the target period, spread so none overlaps another
    lbs = sorted(f.labels, key=lambda lb: yv(lb["v"]))
    want = [yv(lb["v"]) + size * 0.35 for lb in lbs]
    got = K.spread(want, top + size * 0.8, bottom + size * 0.35, size * 1.5)
    if got is None: raise Refused(f"target_path: the {len(lbs)} labels do not fit the plot's height; fewer runs or a taller plot")
    lx = gx + 30
    if f.near:  # the bracket from the target to the nearest pace
        ya, yb = yv(f.target["v"]), yv(f.near["v"])
        o.append(f'<path d="M{gx + 10:.1f} {ya:.1f} h 8 V {yb:.1f} h -8" fill="none" stroke="var(--t-title)" stroke-width="1.3" data-part="gap"/>')
    for lb, y, y_want in zip(lbs, got, want):
        gap = lb["key"] == "the gap label"
        if not gap and abs(y - y_want) > 2:
            o.append(K.line(gx + 6, yv(lb["v"]), lx - 3, y - size * 0.35, stroke="var(--t-sec)", w=0.6, op=0.8))
        fill = "var(--t-title)" if gap or lb["key"] == "the target" else "var(--t-body)"
        o.append(inline(B, lb["ps"], lx, y, size, fill, weight=lb["weight"], tag=lb["key"]))
    y = ly + size * 0.5
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"target_path: lines is {lns!r}; lines is a list of segment lists")
    for i, ln in enumerate(lns):
        y += size * 1.5
        o.append(K.words(B, ln, f"line {i + 1}", 8, y, size, "var(--t-sec)", max_w=W - 16)[0])
    if d.get("footnote"):
        y += size * 1.5
        o.append(K.words(B, d["footnote"], "footnote", 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


TARGET_PATH_LAYERS = dict(target_path=(cl_target_path, None))
TARGET_PATH_SVG = ["target_path"]


def draw(h):
    f = Frame(h)
    inner = cl_target_path(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "target_path"), f.W, f.H
