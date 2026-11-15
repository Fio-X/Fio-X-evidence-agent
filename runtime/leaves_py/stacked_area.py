"""stacked_area layer (owner 11-14 16:0x item 2: written anew, only the chart's idea borrowed; not the prototype's
prod.stack_area, an html chart that formats its own numbers): a whole's parts over
time, each a band stacked on the ones below it, so the top edge is the whole, in rankbar.py's layer style and line.py's
time axis. The parts' cells are the request's own, read by line.py's query form (q: the table, the filter, the parts'
dimension, from..to); every part must hold every period the others hold (a band with a hole cannot be stacked: refused,
never filled). The value axis runs from 0 to the fact layer 1 names (axis.of: a peak of the parts' sum per period, the core's
peak over the filter of every part), its ticks the ledger's fact:<of>.tick<i>; the period axis is the ledger's
period:<table>:<period> entries the points have (line.py's rule). Each band is named at the right with its last value
(layer 1's fact), the labels spread so none overlaps another and a leader drawn to one moved off its band. One accent only
(the highlighted part's band); the others in grey steps, darkest at the bottom.
Every printed number is a ledger entry printed with FX.entry; every name is the request's label marked with its name row.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.stacked_area, run.py leaf): {
  "title": segs, "unit": segs,                      # the unit is written once, in the head
  "part_kind": <kind>,                              # name rows of the parts: name:zh_names:<kind>:<code>
  "q": {"table", "filter"?, "by", "from"?, "to"?},  # the parts' cells (line.py query_points)
  "parts": [{"code": code, "end_text": ledger src}],  # bottom up, in layer 1's order
  "axis": {"of": fact key, "scale": number},        # the axis's top fact (its ticks the ledger's) and its format's scale
  "lines": [segs, ...]?, "footnote": segs?}
Refuses: fewer than two parts, a part twice, a part with fewer than two points, parts that do not share their periods, a
value below 0, no tick of the axis, a tick whose text is no number or ticks not ascending, an axis below the stacked top
by more than half a tick, no period entry, more parts than grey steps, a highlight that is no part, a digit in a literal
word, a text that leaves the picture or overlaps another, end labels that cannot all fit, a board too narrow."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
from wbkit import FX, prod, Refused, esc, tw
import line as L

NODE = "stacked_area"
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), plot_h=(300, (160, 600, 10), "plot height in px"),
    highlight=("", None, "code of the part drawn in the accent; none = the first part"))

GREYS = ["var(--t-sec)", "var(--bar)", "var(--empty)", "var(--rule)"]  # bottom up, after the accent


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        q = d.get("q")
        if not (isinstance(q, dict) and isinstance(q.get("table"), str) and isinstance(q.get("by"), str)): raise Refused(f"stacked_area: the query {q!r} names no table and by-dimension")
        parts = d.get("parts") or []
        if len(parts) < 2: raise Refused("stacked_area: the spec holds fewer than two parts")
        codes = [p.get("code") for p in parts]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"stacked_area: the parts' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"stacked_area: the parts {twice} come twice")
        kind = d.get("part_kind")
        if not isinstance(kind, str) or not kind: raise Refused("stacked_area: the spec names no part_kind (the parts' name rows)")
        hl = K.check_codes(NODE, k("highlight"), set(codes)) if k("highlight") else {codes[0]}
        if len(hl) > 1: raise Refused("stacked_area: highlight names one part")
        f.hl = next(iter(hl))
        others = [c for c in codes if c != f.hl]
        if len(others) > len(GREYS): raise Refused(f"stacked_area: {len(parts)} parts, more than one accent and its {len(GREYS)} greys tell apart")
        f.parts, periods = [], None
        for p in parts:
            pts = L.query_points(q, p["code"])
            if len(pts) < 2: raise Refused(f"stacked_area: part {p['code']} has fewer than two points")
            vals = {}
            for src in pts:
                v = K.val(src)
                if v < 0: raise Refused(f"stacked_area: part {p['code']} is below 0 at {L.period_of(src)}")
                vals[L.period_of(src)] = v
            if periods is not None and set(vals) != periods:
                raise Refused(f"stacked_area: part {p['code']} does not hold the same periods as the parts before it; a band with a hole cannot be stacked")
            periods = set(vals)
            if not p.get("end_text"): raise Refused(f"stacked_area: part {p['code']} has no end_text (the ledger entry its last value prints from)")
            fill = "var(--accent)" if p["code"] == f.hl else GREYS[others.index(p["code"])]
            f.parts.append(dict(code=p["code"], vals=vals, end=K.ent(p["end_text"]), name=K.named(p["code"], kind), fill=fill))
        f.periods = sorted(periods, key=L.period_at)
        f.t = {p: L.period_at(p) for p in f.periods}
        f.tops = {p: sum(x["vals"][p] for x in f.parts) for p in f.periods}
        axis = d.get("axis") or {}
        key = str(axis.get("of") or "").removeprefix("fact:")
        if not key: raise Refused("stacked_area: the axis names no fact (axis.of)")
        ticks = []
        while f"fact:{key}.tick{len(ticks) + 1}" in (FX.LEDGER or {}): ticks.append(f"fact:{key}.tick{len(ticks) + 1}")
        if not ticks: raise Refused(f"stacked_area: the ledger holds no tick of the axis to {key}")
        scale = axis.get("scale")
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not scale > 0: raise Refused(f"stacked_area: the axis scale {scale!r} is no number above 0")
        f.ticks = []
        for src in ticks:
            text = FX.text(src)
            try: raw = float(text.replace(",", "")) / scale
            except ValueError: raise Refused(f"stacked_area: the tick {text!r} ({src}) is no number")
            if f.ticks and raw <= f.ticks[-1][0]: raise Refused(f"stacked_area: the ticks are not ascending at {src}")
            f.ticks.append((raw, K.ent(src)))
        step = f.ticks[0][0]
        if max(f.tops.values()) > f.ticks[-1][0] + step / 2 + 1e-9: raise Refused(f"stacked_area: the axis to {key} stops below the stacked top; the axis fact is not the parts' summed peak")
        f.top = max(list(f.tops.values()) + [f.ticks[-1][0]])
        f.pentries = [(f.t[p], K.ent(f"period:{q['table']}:{p}")) for p in f.periods if f"period:{q['table']}:{p}" in (FX.LEDGER or {})]
        if not f.pentries: raise Refused(f"stacked_area: the ledger holds no period entry of {q['table']} for any point")
        size = f.size
        f.tick_w = max(tw(e[1], size) for _, e in f.ticks) + 8
        end_w = max(tw(x["name"][1] + " " + x["end"][1], size) for x in f.parts)
        f.x0, f.x1 = 8 + f.tick_w, f.W - 8 - 14 - end_w
        if f.x1 - f.x0 < 240: raise Refused("stacked_area: the board is too narrow for the ticks, the plot and the end labels (plot under 240 px)")
        f.t0, f.t1 = f.t[f.periods[0]], f.t[f.periods[-1]]

    def x(f, t):
        return f.x0 + (f.x1 - f.x0) * (t - f.t0) / (f.t1 - f.t0)


def cl_stacked_area(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    top = 22 + size * 2.2
    bottom = top + f.k("plot_h")
    yv = lambda v: bottom - (bottom - top) * v / f.top
    # the bands, bottom up: each between the sum of the parts below it and that sum plus its own
    below = {p: 0.0 for p in f.periods}
    ends = []
    for x in f.parts:
        upper = [(f.x(f.t[p]), yv(below[p] + x["vals"][p])) for p in f.periods]
        lower = [(f.x(f.t[p]), yv(below[p])) for p in reversed(f.periods)]
        pts = " ".join(f"{a:.1f},{b:.1f}" for a, b in upper + lower)
        o.append(f'<polygon points="{pts}" fill="{x["fill"]}" stroke="var(--bg)" stroke-width="0.8" data-code="{esc(x["code"])}"/>')
        last = f.periods[-1]
        ends.append((yv(below[last] + x["vals"][last] / 2), x))
        for p in f.periods: below[p] += x["vals"][p]
    # the value axis: ticks left of the plot (a short tick each, no line across the bands), the baseline in ink
    for raw, (svg_t, text) in f.ticks:
        y = yv(raw)
        o.append(K.line(f.x0 - 4, y, f.x0, y, stroke="var(--t-title)", w=0.8, op=1))
        o.append(K.txt(B, f.x0 - 6, y + size * 0.35, size, "var(--t-sec)", svg_t, tw(text, size), anchor="end", tag=f"tick {text}"))
    o.append(K.line(f.x0, bottom, f.x1, bottom, stroke="var(--t-title)", w=0.8, op=1))
    # the period axis: first and last always, one between where it overlaps none kept (line.py's rule)
    ly = bottom + size * 1.5
    kept, boxes = [], []
    order = f.pentries[:1] + f.pentries[-1:] + f.pentries[1:-1] if len(f.pentries) > 1 else f.pentries
    for t, (svg_p, text) in order:
        xx, w = f.x(t), tw(text, size)
        b = (xx - w / 2, ly - size * 0.8, xx + w / 2, ly + size * 0.25)
        if any(b[0] < a[2] + 6 and a[0] < b[2] + 6 for a in boxes): continue
        boxes.append(b); kept.append((t, svg_p, text))
    for t, svg_p, text in sorted(kept, key=lambda e: e[0]):
        xx = f.x(t)
        o.append(K.line(xx, bottom, xx, bottom + 4, stroke="var(--t-title)", w=0.8, op=1))
        o.append(K.txt(B, xx, ly, size, "var(--t-sec)", svg_p, tw(text, size), anchor="middle", tag=f"period {text}"))
    # the end labels: each band named right of the plot at its last period's middle, spread so none overlaps
    ends.sort(key=lambda e: e[0])
    want = [y + size * 0.35 for y, _ in ends]
    got = L.spread(want, top + size * 0.8, bottom + size * 0.35, size * 1.3)
    if got is None: raise Refused(f"stacked_area: the {len(ends)} end labels do not fit the plot's height; fewer parts or a taller plot")
    lx = f.x1 + 14
    for (y_mid, x), y, y_want in zip(ends, got, want):
        hot = x["code"] == f.hl
        fill = "var(--accent)" if hot else "var(--t-body)"
        (nm_svg, nm), (val_svg, val) = x["name"], x["end"]
        if abs(y - y_want) > 2:
            o.append(K.line(f.x1 + 2, y_mid, lx - 3, y - size * 0.35, stroke=fill, w=0.6, op=0.8))
        o.append(K.txt(B, lx, y, size, fill, nm_svg + " " + val_svg, tw(nm + " " + val, size), weight=700 if hot else 400, tag=f"end {x['code']}"))
    y = ly + size * 0.5
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"stacked_area: lines is {lns!r}; lines is a list of segment lists")
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


STACKED_AREA_LAYERS = dict(stacked_area=(cl_stacked_area, None))
STACKED_AREA_SVG = ["stacked_area"]


def draw(h):
    f = Frame(h)
    inner = cl_stacked_area(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "stacked_area"), f.W, f.H
