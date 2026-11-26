"""event_chain layer: a chain of events told as small panels linked left to right, in line.py's layer style: each panel one
measure's series (a line or bars) on the same span of periods, its name and unit over it, its first and last value
printed beside their points (the last bold; above, or under a point, or higher, where the line or a taller bar runs through the room above), its first and last period under it; between two neighbouring panels a grey
chevron band, and under the gap the link's words (what led from one to the next); the chosen period (the event) shaded in
every panel, named once in a key over the panels. One accent: the highlighted panel's series; the others in ink grey.
Each panel has its own value scale (from 0 unless the request says not); the panels share the time scale so the shaded
period lines up across them. The chain says only what came after what (the words must not claim a cause the data cannot).
Every printed number is a ledger entry printed with FX.entry; every word comes with the request as segments.

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs?,                                   # the picture's name, if any
  "panels": [{"code": code,                         # left to right, in layer 1's order (data-code; the knob highlight names one)
              "title": segs, "unit": segs,          # the measure's name (up to two lines) and unit
              "kind": "line" | "bar",
              "zero": bool?,                        # the value scale from 0 (default true; a bar panel always)
              "points": [series src, ...],          # its cells in period order (geometry only)
              "first_text": ledger src, "last_text": ledger src,  # the first and last value as printed
              "periods": [ledger src, ledger src],  # period:<table>:<period> of the first and the last point
              "link": segs?}],                      # the words under the band to the next panel (none on the last)
  "band": {"from": period, "to": period, "label": segs}?,  # the event period shaded in every panel (from..to, as the
                                                    # series srcs write periods; never printed) and its words in the key
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): add_<code>_<year> (a yearly
addition read off a stock, when a panel draws one), share_<code>_<period> (a part over its whole, when a panel draws a
share the table does not hold), cut_<code> / ratio_<code> (a change the link words print), each with its ledger entry.
needs new wording: none fixed; every panel's name, unit and link and the band's words come from the data as segments.
Refuses: fewer than two panels, a panel twice, a kind that is neither line nor bar, a panel with fewer than two points,
points out of period order or twice at one period, a value below 0 on a scale from 0, a period entry that is not the
panel's first or last point's, a link on the last panel, a band whose period no panel spans, a highlight that is no
panel, a title over two lines, a digit in a literal word, a text that leaves the picture or overlaps another, a board too
narrow (a panel under knob min_panel px)."""

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "event_chain"
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    panel_title_size=(14, (11, 18, 0.5), "a panel's name size px"), width=(1140, (480, 1400, 10), "picture width in px"),
    plot_h=(110, (60, 240, 5), "a panel's plot height in px"), gap=(44, (28, 96, 2), "space between two panels in px (the band's)"),
    min_panel=(150, (110, 300, 10), "the narrowest panel drawn; a narrower board refuses"),
    line_w=(2.5, (1.5, 4, 0.5), "a line panel's line width in px"),
    highlight=("", None, "code of the panel drawn in the accent; none = the first panel"))


def inline(B, ps, x, y, size, fill, anchor="start", weight=400, tag="text"):
    """One <text> of (text, src) pieces: an entry marked with its src, words escaped; its box checked in B."""
    inner = "".join(FX.entry(s, "tspan", None) if s else esc(t) for t, s in ps)
    return K.txt(B, x, y, size, fill, inner, tw("".join(t for t, _ in ps), size), anchor=anchor, weight=weight, tag=tag)


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        panels = d.get("panels")
        if not isinstance(panels, list) or len(panels) < 2: raise Refused("event_chain: the spec holds fewer than two panels")
        codes = [p.get("code") if isinstance(p, dict) else None for p in panels]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"event_chain: the panels' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"event_chain: the panels {twice} come twice")
        f.panels = []
        for i, p in enumerate(panels):
            c = p["code"]
            kind = p.get("kind")
            if kind not in ("line", "bar"): raise Refused(f"event_chain: panel {c}'s kind {kind!r} is neither line nor bar")
            pts = p.get("points")
            if not isinstance(pts, list) or len(pts) < 2: raise Refused(f"event_chain: panel {c} has fewer than two points")
            out, seen = [], set()
            for src in pts:
                per = K.period_of(src); t, v = K.period_at(per), K.val(src)
                if per in seen: raise Refused(f"event_chain: panel {c} has two points at {per}")
                if out and t <= out[-1][0]: raise Refused(f"event_chain: panel {c}'s points are not in period order at {per}")
                seen.add(per); out.append((t, v, per))
            zero = kind == "bar" or p.get("zero", True) is not False
            if zero and min(v for _, v, _ in out) < 0: raise Refused(f"event_chain: panel {c} has a value below 0 on a scale from 0")
            for key in ("first_text", "last_text"):
                if not p.get(key): raise Refused(f"event_chain: panel {c} has no {key} (the ledger entry its value prints from)")
                FX.text(p[key])
            per = p.get("periods")
            if not isinstance(per, list) or len(per) != 2: raise Refused(f"event_chain: panel {c} needs its first and last period entries")
            for src, want in zip(per, (out[0][2], out[-1][2])):
                if not isinstance(src, str) or not src.startswith("period:") or src.rsplit(":", 1)[1] != want:
                    raise Refused(f"event_chain: panel {c}'s period entry {src!r} is not its point's period {want}")
            if p.get("link") is not None:
                if i == len(panels) - 1: raise Refused(f"event_chain: the last panel {c} has a link; there is no panel after it")
                K.segs(p["link"], f"panel {c}'s link")
            K.segs(p.get("title"), f"panel {c}'s title"); K.segs(p.get("unit"), f"panel {c}'s unit")
            f.panels.append(dict(p, kind=kind, pts=out, zero=zero, per=[K.ent(s) for s in per]))
        hl = K.check_codes(NODE, k("highlight"), set(codes)) if k("highlight") else {codes[0]}
        if len(hl) > 1: raise Refused("event_chain: highlight names one panel")
        f.hl = next(iter(hl))
        times = [t for p in f.panels for t, _, _ in p["pts"]]
        gaps = [b[0] - a[0] for p in f.panels for a, b in zip(p["pts"], p["pts"][1:])]
        f.step = min(gaps)
        f.t0, f.t1 = min(times) - f.step / 2, max(times) + f.step / 2
        band = d.get("band")
        f.band = None
        if band is not None:
            if not isinstance(band, dict): raise Refused(f"event_chain: the band {band!r} names no from, to and label")
            a, b = K.period_at(str(band.get("from"))), K.period_at(str(band.get("to")))
            if b < a: raise Refused("event_chain: the band ends before it starts")
            if b < min(times) or a > max(times): raise Refused("event_chain: the band's period lies outside every panel's span")
            K.segs(band.get("label"), "the band's label")
            f.band = (max(a - f.step / 2, f.t0), min(b + f.step / 2, f.t1), band["label"])
        n = len(f.panels)
        f.pw = (f.W - 16 - (n - 1) * k("gap")) / n
        if f.pw < k("min_panel"): raise Refused(f"event_chain: the board is too narrow for {n} panels (a panel under {k('min_panel')} px)")
        f.H = 0

    def px(f, i):
        return 8 + i * (f.pw + f.k("gap"))

    def x(f, i, t):
        pad = 6
        return f.px(i) + pad + (f.pw - 2 * pad) * (t - f.t0) / (f.t1 - f.t0)


def cl_event_chain(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = []
    ts, pts_ = f.k("title_size"), f.k("panel_title_size")
    y = 22
    if d.get("title"):
        o.append(K.words(B, d["title"], "title", 8, y, ts, "var(--t-title)", weight=700, max_w=W - 16)[0])
        y += ts * 1.6
    if f.band:  # the key: a shaded swatch and the band's words, once over the panels
        o.append(f'<rect x="8" y="{y - size * 0.85:.1f}" width="{size * 1.4:.1f}" height="{size:.1f}" fill="var(--empty)"/>')
        o.append(K.words(B, f.band[2], "the band's label", 8 + size * 1.8, y, size, "var(--t-sec)", max_w=W - 30)[0])
        y += size * 1.8
    # the panels' heads: every name gets the same room (the most lines any takes), so the plots line up
    n_lines = max(len(K.lay(K.segs(p["title"], "title"), pts_, f.pw)) for p in f.panels)
    if n_lines > 2: raise Refused("event_chain: a panel's name takes more than two lines at this size")
    head_y = y + pts_ * 0.2
    unit_y = head_y + pts_ * 1.3 * (n_lines - 1) + size * 1.45
    top = unit_y + size * 0.25 + size * 1.9      # room for a value printed above the highest point
    bottom = top + f.k("plot_h")
    for i, p in enumerate(f.panels):
        x0 = f.px(i)
        hot = p["code"] == f.hl
        ink = "var(--accent)" if hot else "var(--t-sec)"
        o.append(K.words(B, p["title"], f"panel {p['code']} title", x0, head_y, pts_, "var(--t-title)", weight=700, max_w=f.pw, max_lines=2)[0])
        o.append(K.words(B, p["unit"], f"panel {p['code']} unit", x0, unit_y, size, "var(--t-sec)", italic=True, max_w=f.pw)[0])
        if f.band:
            a, b = f.x(i, f.band[0]), f.x(i, f.band[1])
            o.append(f'<rect x="{a:.1f}" y="{top - size * 1.2:.1f}" width="{b - a:.1f}" height="{bottom - top + size * 1.2:.1f}" fill="var(--empty)" data-part="band"/>')
        vals = [v for _, v, _ in p["pts"]]
        lo = 0.0 if p["zero"] else min(vals) - 0.15 * (max(vals) - min(vals) or abs(min(vals)) or 1)
        hi = max(vals) if max(vals) > lo else lo + 1
        yv = lambda v: bottom - (bottom - top) * (v - lo) / (hi - lo)
        o.append(K.line(x0, bottom, x0 + f.pw, bottom, stroke="var(--t-title)", w=0.8, op=1))
        if p["kind"] == "bar":
            bw = (f.x(i, f.step) - f.x(i, 0)) * 0.56
            for t, v, _ in p["pts"]:
                o.append(f'<rect x="{f.x(i, t) - bw / 2:.1f}" y="{yv(v):.1f}" width="{bw:.1f}" height="{bottom - yv(v):.1f}" fill="{ink}" data-code="{esc(p["code"])}"/>')
        else:
            line = " ".join(f"{f.x(i, t):.1f},{yv(v):.1f}" for t, v, _ in p["pts"])
            o.append(f'<polyline points="{line}" fill="none" stroke="{ink}" stroke-width="{f.k("line_w")}" stroke-linejoin="round" '
                     f'stroke-linecap="round" data-code="{esc(p["code"])}"/>')
            for t, v, _ in (p["pts"][0], p["pts"][-1]):
                o.append(f'<circle cx="{f.x(i, t):.1f}" cy="{yv(v):.1f}" r="3" fill="{ink}" data-code="{esc(p["code"])}"/>')
        # the first and last value beside their points, kept inside the panel: above the point, or under it when the line (or a taller
        # bar) runs through the room above (the side the series leaves free; both taken, the one it covers less, its halo over the rest)
        pxy = [(f.x(i, t), yv(v)) for t, v, _ in p["pts"]]
        bw = (f.x(i, f.step) - f.x(i, 0)) * 0.56

        def covered(x0_, y0_, x1_, y1_):
            """How many 1 px samples of the series (its line, or its bars) the box holds."""
            if p["kind"] == "bar":
                return sum(100 for x, y in pxy if x - bw / 2 < x1_ and x + bw / 2 > x0_ and y < y1_ and bottom > y0_)
            n = 0
            for (xa, ya), (xb, yb) in zip(pxy, pxy[1:]):
                m = max(1, int(abs(xb - xa)))
                n += sum(1 for k in range(m + 1) if x0_ <= xa + (xb - xa) * k / m <= x1_ and y0_ - 1.5 <= ya + (yb - ya) * k / m <= y1_ + 1.5)
            return n

        for (t, v, _), src, wt, side in ((p["pts"][0], p["first_text"], 400, "first"), (p["pts"][-1], p["last_text"], 700, "last")):
            text = FX.text(src); w = tw(text, size)
            xx = min(max(f.x(i, t), x0 + w / 2), x0 + f.pw - w / 2)
            spots = [yv(v) - 7]
            if yv(v) + 7 + size * 1.05 <= bottom - 2: spots.append(yv(v) + 7 + size * 0.8)  # under the point, clear of the baseline
            # higher up, in the room over the plot, where neither side of the point is free (a line climbing steeply from it)
            spots += [yv(v) - 7 - j * size * 0.5 for j in range(1, 8) if yv(v) - 7 - j * size * 0.5 - size * 0.8 >= top - size * 1.5]
            ty = min(spots, key=lambda yy: (covered(xx - w / 2, yy - size * 0.8, xx + w / 2, yy + size * 0.25) > 0, spots.index(yy)))  # the first free
            if covered(xx - w / 2, ty - size * 0.8, xx + w / 2, ty + size * 0.25):  # none free: the one it covers least, its halo over the rest
                ty = min(spots, key=lambda yy: (covered(xx - w / 2, yy - size * 0.8, xx + w / 2, yy + size * 0.25), spots.index(yy)))
            o.append(K.txt(B, xx, ty, size, "var(--t-title)" if wt == 700 else "var(--t-body)", FX.entry(src, "tspan", None), w,
                           anchor="middle", weight=wt, tag=f"panel {p['code']} {side} value",
                           style=' stroke="var(--bg)" stroke-width="4" paint-order="stroke"'))  # a halo where the line runs by
        # the first and last period under the baseline
        (a_svg, a_t), (b_svg, b_t) = p["per"]
        o.append(K.txt(B, x0, bottom + size * 1.3, size, "var(--t-sec)", a_svg, tw(a_t, size), tag=f"panel {p['code']} first period"))
        o.append(K.txt(B, x0 + f.pw, bottom + size * 1.3, size, "var(--t-sec)", b_svg, tw(b_t, size), anchor="end", tag=f"panel {p['code']} last period"))
        if i < len(f.panels) - 1:  # the chevron band to the next panel, at the plot's middle
            g0, g1 = x0 + f.pw + 6, x0 + f.pw + f.k("gap") - 6
            ym, hh, tip = (top + bottom) / 2, min(28, f.k("plot_h") / 3), min(10, (g1 - g0) / 3)
            o.append(f'<polygon points="{g0:.1f},{ym - hh / 2:.1f} {g1 - tip:.1f},{ym - hh / 2:.1f} {g1:.1f},{ym:.1f} {g1 - tip:.1f},{ym + hh / 2:.1f} '
                     f'{g0:.1f},{ym + hh / 2:.1f} {g0 + tip:.1f},{ym:.1f}" fill="var(--bar)" data-part="link-band"/>')
    # the links' words under the panels, each centred under its band, as wide as a panel and its gap
    y = bottom + size * 1.3
    ly = y + size * 1.7
    used = 0
    for i, p in enumerate(f.panels[:-1]):
        if not p.get("link"): continue
        cx = f.px(i) + f.pw + f.k("gap") / 2
        svg_l, _, nl = K.words(B, p["link"], f"panel {p['code']} link", cx, ly, size, "var(--t-title)", anchor="middle", weight=700,
                               max_w=f.pw + f.k("gap") - 16, max_lines=2)
        o.append(svg_l); used = max(used, nl)
    y = ly + size * 1.3 * (used - 1) + size * 0.4 if used else y
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"event_chain: lines is {lns!r}; lines is a list of segment lists")
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


EVENT_CHAIN_LAYERS = dict(event_chain=(cl_event_chain, None))
EVENT_CHAIN_SVG = ["event_chain"]


def draw(h):
    f = Frame(h)
    inner = cl_event_chain(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "event_chain"), f.W, f.H
