"""line layer: one line per series over its periods, in rankbar.py's layer style, with the rules of the old route's line chart
ported (runtime/pi/viz.mjs renderLine): the highlighted series in the accent and wider, drawn last, every other one a thinner
grey; a series breaks where a period is missing between its first and last; a sparse series (one with such a gap, or fewer
than knob marker_all points) is marked at every point, any other only the highlighted one at its two ends; each series named
at the right of the plot with its last value (layer 1's ledger entry), the labels' baselines spread so no two overlap and a
short leader drawn to a label moved off its point; the value axis from 0, its ticks layer 1's (fact:<key>.tick<i>,
next_facts::ticks) as hairlines with the printed tick at their left, the unit once beside the title; the period axis under the
plot, its labels layer 1's period entries, the first and the last always and one between only where it overlaps none kept.
Every printed number is a ledger entry printed with FX.entry; every name is the request's label marked with its name row.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.line, run.py leaf): {
  "title": segs, "unit": segs,                      # the unit is written once, in the head
  "series_kind": "place" | <kind>,                  # name rows: a series' name, name:zh_names:<kind>:<code> or a place's
  "series": [{"code": code,                         # one line per series, in layer 1's order (the leaf sorts nothing)
              "points": [series src, ...],          # its cells in period order; a cell's period is its src's
              "end_text": ledger src}],             # the last point's value as printed (layer 1's fact)
  "axis": {"ticks": [ledger src, ...],              # fact:<key>.tick<i>, ascending, each printed text a number
           "scale": number},                        # a tick's printed number is its raw value times scale (its format's)
  "periods": [ledger src, ...],                     # period:<table>:<period> of the period axis, in period order
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
The query form (what the registry declares for a block page, node-bindings.json nodes.line): with "q": {"table", "filter"?,
"by", "from"?, "to"?} a series that lists no points is the request's series cells of q's table at the filter and its code on
q's by-dimension, from..to, in period order; an axis that lists no ticks is the axis of the "peak" fact (a fact key; or the
data's "peak_of", {code_lc} read as each series' code in lowercase) of the series whose highest point is the highest drawn,
its ticks every fact:<peak>.tick<i> the ledger holds; no "periods" is every period:<q's table>:<period> entry the ledger
holds for a period a point has. The leaf picks which entries; it makes none.
Placement keeps texts off the lines by construction: the tick column left of the plot, the period axis under it, the end
labels in a band right of it (no line runs past the plot's right edge), the head above it; every text box is checked in
wbkit.Boxes (outside the picture or over another refuses).
Refuses: no series, a series twice, a series with fewer than two points, a point whose series the request lacks or whose
period is no year, quarter or month, two points of one series at one period or out of period order, a negative value (the
axis starts at 0), no tick, a tick whose text is no number or ticks not ascending, a period entry no point has, a highlight
that is no series, a digit in a literal word, a text that leaves the picture or overlaps another, end labels that cannot all
fit the plot's height, a board too narrow (plot under 240 px)."""
import re

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "line"
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), plot_h=(300, (160, 600, 10), "plot height in px"),
    line_w=(2.5, (1.5, 4, 0.5), "the highlighted line's width in px"), context_w=(1.5, (0.8, 2.5, 0.1), "every other line's width in px"),
    marker_all=(6, (2, 24, 1), "a series with fewer points than this is marked at every point"),
    highlight=("", None, "code of the series drawn in the accent; none = the first series"))

# the period axis and the query form live in wbkit (stacked_area reads them too, and a leaf imports no other leaf)
period_at, period_of, query_points, spread = K.period_at, K.period_of, K.query_points, K.spread


def of_code(template, code):
    """A fact key the registry writes once for every series (peak_of: "{code_lc}_peak"), read for one series' code as
    layer 1's facts_each names it ({code} the code, {code_lc} it in lowercase); none without a template."""
    return template.replace("{code_lc}", code.lower()).replace("{code}", code) if isinstance(template, str) else None


def peak_ticks(series):
    """The axis of the series whose highest point is the highest drawn: its "peak" fact's ticks as the ledger holds them
    (fact:<peak>.tick1, .tick2, ...; layer 1's next_facts::ticks). A top series naming no peak, or a peak with no tick in
    the ledger, refuses."""
    top = max(series, key=lambda s: max(v for _, v, _ in s["pts"]))
    key = top.get("peak")
    if not isinstance(key, str) or not key: raise Refused(f"line: series {top['code']} draws highest and names no peak fact for the axis")
    key = key.removeprefix("fact:")
    out, i = [], 1
    while f"fact:{key}.tick{i}" in (FX.LEDGER or {}):
        out.append(f"fact:{key}.tick{i}"); i += 1
    if not out: raise Refused(f"line: the ledger holds no tick of the axis to {key}")
    return out


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        series = [dict(s) for s in (d.get("series") or [])]
        if not series: raise Refused("line: the spec holds no series")
        codes = [s.get("code") for s in series]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"line: the series' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"line: the series {twice} come twice")
        f.kind = d.get("series_kind", "place")
        q = d.get("q")
        if q is not None and not (isinstance(q, dict) and isinstance(q.get("table"), str) and isinstance(q.get("by"), str)):
            raise Refused(f"line: the query {q!r} names no table and by-dimension")
        f.series = []
        for s in series:
            pts = s.get("points")
            if pts is None and q is not None: pts = query_points(q, s["code"])
            if not isinstance(pts, list) or len(pts) < 2: raise Refused(f"line: series {s['code']} has fewer than two points")
            out, seen = [], set()
            for src in pts:
                p = period_of(src); t, v = period_at(p), K.val(src)
                if p in seen: raise Refused(f"line: series {s['code']} has two points at {p}")
                if out and t <= out[-1][0]: raise Refused(f"line: series {s['code']}'s points are not in period order at {p}")
                if v < 0: raise Refused(f"line: series {s['code']} has a value below 0 at {p}; the axis starts at 0")
                seen.add(p); out.append((t, v, p))
            if not s.get("end_text"): raise Refused(f"line: series {s['code']} has no end_text (the ledger entry its last value prints from)")
            f.series.append(dict(code=s["code"], pts=out, end=K.ent(s["end_text"]), name=K.named(s["code"], f.kind), peak=s.get("peak") or of_code(d.get("peak_of"), s["code"])))
        hl = K.check_codes(NODE, k("highlight"), set(codes)) if k("highlight") else {codes[0]}
        if len(hl) > 1: raise Refused("line: highlight names one series")
        f.hl = next(iter(hl))
        # the step between two neighbouring periods (the smallest gap any series has): a longer gap breaks a line there
        gaps = [b[0] - a[0] for s in f.series for a, b in zip(s["pts"], s["pts"][1:])]
        f.step = min(gaps)
        for s in f.series:
            s["sparse"] = len(s["pts"]) < k("marker_all") or any(b[0] - a[0] > f.step * 1.5 for a, b in zip(s["pts"], s["pts"][1:]))
        axis = d.get("axis") or {}
        ticks = axis.get("ticks") or (peak_ticks(f.series) if q is not None and "ticks" not in axis else [])
        if not isinstance(ticks, list) or not ticks: raise Refused("line: the axis holds no tick (fact:<key>.tick<i>, layer 1's)")
        scale = axis.get("scale")
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not scale > 0: raise Refused(f"line: the axis scale {scale!r} is no number above 0")
        f.ticks = []
        for src in ticks:
            text = FX.text(src)
            try: raw = float(text.replace(",", "")) / scale
            except ValueError: raise Refused(f"line: the tick {text!r} ({src}) is no number")
            if f.ticks and raw <= f.ticks[-1][0]: raise Refused(f"line: the ticks are not ascending at {src}")
            f.ticks.append((raw, K.ent(src)))
        f.top = max([v for s in f.series for _, v, _ in s["pts"]] + [f.ticks[-1][0]])
        if f.top <= 0: raise Refused("line: every value is 0; a line over an axis from 0 needs one above it")
        times = {p: t for s in f.series for t, _, p in s["pts"]}
        f.periods = []
        listed = d.get("periods")
        if listed is None and q is not None:
            listed = [p for p in (f"period:{q['table']}:{p}" for p in sorted(times, key=lambda p: times[p])) if p in (FX.LEDGER or {})]
            if not listed: raise Refused(f"line: the ledger holds no period entry of {q['table']} for any point")
        for src in listed or []:
            if not isinstance(src, str) or not src.startswith("period:"): raise Refused(f"line: the period entry {src!r} is no period:<table>:<period>")
            p = src.rsplit(":", 1)[1]
            if p not in times: raise Refused(f"line: the period entry {src} names {p}, which no point has")
            f.periods.append((times[p], K.ent(src)))
        if [t for t, _ in f.periods] != sorted({t for t, _ in f.periods}): raise Refused("line: the period entries are not in period order, or one comes twice")
        f.t0, f.t1 = min(times.values()), max(times.values())
        size = f.size
        f.tick_w = max(tw(e[1], size) for _, e in f.ticks) + 8
        f.label_w = max(tw(s["name"][1] + " " + s["end"][1], size) for s in f.series) + 14
        f.x0, f.x1 = 8 + f.tick_w, f.W - 8 - f.label_w
        if f.x1 - f.x0 < 240: raise Refused("line: the board is too narrow for the ticks, the plot and the end labels (plot under 240 px)")
        f.dropped, f.H = [], 0

    def x(f, t):
        return f.x0 + (f.x1 - f.x0) * ((t - f.t0) / (f.t1 - f.t0) if f.t1 > f.t0 else 0.5)


def cl_line(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    top = 22 + size * 2.2
    bottom = top + f.k("plot_h")
    yv = lambda v: bottom - (bottom - top) * v / f.top
    # the value axis: a hairline per tick across the plot, its printed number at the left; the baseline at 0 in ink
    for raw, (svg_t, text) in f.ticks:
        y = yv(raw)
        o.append(K.line(f.x0, y, f.x1, y))
        o.append(K.txt(B, f.x0 - 6, y + size * 0.35, size, "var(--t-sec)", svg_t, tw(text, size), anchor="end", tag=f"tick {text}"))
    o.append(K.line(f.x0, bottom, f.x1, bottom, stroke="var(--t-title)", w=0.8, op=1))
    # the period axis: first and last always, one between where it overlaps none kept (a dropped label is no data dropped)
    ly = bottom + size * 1.5
    kept, boxes = [], []
    order = f.periods[:1] + f.periods[-1:] + f.periods[1:-1] if len(f.periods) > 1 else f.periods
    for t, (svg_p, text) in order:
        x, w = f.x(t), tw(text, size)
        b = (x - w / 2, ly - size * 0.8, x + w / 2, ly + size * 0.25)
        if any(b[0] < a[2] + 6 and a[0] < b[2] + 6 for a in boxes): continue
        boxes.append(b); kept.append((t, svg_p, text))
    for t, svg_p, text in sorted(kept, key=lambda e: e[0]):
        x = f.x(t)
        o.append(K.line(x, bottom, x, bottom + 4, stroke="var(--t-title)", w=0.8, op=1))
        o.append(K.txt(B, x, ly, size, "var(--t-sec)", svg_p, tw(text, size), anchor="middle", tag=f"period {text}"))
    # the lines: the grey ones first, the highlighted one last (on top)
    lines = sorted(f.series, key=lambda s: s["code"] == f.hl)
    for s in lines:
        hot = s["code"] == f.hl
        stroke = "var(--accent)" if hot else "var(--t-sec)"
        wd, op = (f.k("line_w"), 1) if hot else (f.k("context_w"), 0.6)
        run = [s["pts"][0]]
        for a, b in zip(s["pts"], s["pts"][1:]):
            if b[0] - a[0] > f.step * 1.5:  # a missing period: the line breaks there
                if len(run) > 1: o.append(_poly(f, run, yv, stroke, wd, op, s["code"]))
                run = []
            run.append(b)
        if len(run) > 1: o.append(_poly(f, run, yv, stroke, wd, op, s["code"]))
        marks = s["pts"] if s["sparse"] else (s["pts"][:1] + s["pts"][-1:] if hot else [])
        r = 2.8 if hot else 2
        for t, v, _ in marks:
            o.append(f'<circle cx="{f.x(t):.1f}" cy="{yv(v):.1f}" r="{r}" fill="{stroke}" fill-opacity="{op}" data-code="{esc(s["code"])}"/>')
    # the end labels: name and last value right of the plot, spread so none overlaps another
    ends = sorted(f.series, key=lambda s: yv(s["pts"][-1][1]))
    want = [yv(s["pts"][-1][1]) + size * 0.35 for s in ends]
    got = spread(want, top + size * 0.8, bottom + size * 0.35, size * 1.3)
    if got is None: raise Refused(f"line: the {len(ends)} end labels do not fit the plot's height; fewer series or a taller plot")
    lx = f.x1 + 10
    for s, y, y_want in zip(ends, got, want):
        hot = s["code"] == f.hl
        fill = "var(--accent)" if hot else "var(--t-body)"
        (nm_svg, nm), (val_svg, val) = s["name"], s["end"]
        t_last, v_last, _ = s["pts"][-1]
        if abs(y - y_want) > 2 or f.x(t_last) < f.x1 - 0.5:  # moved off its point, or the series ends early: a leader to it
            o.append(K.line(f.x(t_last) + 3, yv(v_last), lx - 3, y - size * 0.35, stroke=fill, w=0.6, op=0.8))
        o.append(K.txt(B, lx, y, size, fill, nm_svg + " " + val_svg, tw(nm + " " + val, size), weight=700 if hot else 400, tag=f"end {s['code']}"))
    y = ly + size * 0.5
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"line: lines is {lns!r}; lines is a list of segment lists")
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


def _poly(f, run, yv, stroke, wd, op, code):
    pts = " ".join(f"{f.x(t):.1f},{yv(v):.1f}" for t, v, _ in run)
    return (f'<polyline points="{pts}" fill="none" stroke="{stroke}" stroke-width="{wd}" stroke-opacity="{op}" '
            f'stroke-linejoin="round" stroke-linecap="round" data-code="{esc(code)}"/>')


LINE_LAYERS = dict(line=(cl_line, None))
LINE_SVG = ["line"]


def draw(h):
    f = Frame(h)
    inner = cl_line(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "line"), f.W, f.H
