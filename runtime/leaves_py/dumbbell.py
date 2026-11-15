"""dumbbell layer (哑铃图, owner 11-14 16:0x item 2): each place's value at two periods as two dots on one row, joined by a
line, in rankbar.py's layer style; the old route's dumbbell (runtime/pi/viz.mjs renderDumbbell: a row per place, the name at
the left, a connector between the start and end dots, a key naming which dot is which period) under the new route's
rules: one accent only (the start dot hollow grey, the end dot filled ink, the highlighted row's connector and end dot in
the accent), no gridline under a text (the value axis is a baseline with short ticks under the rows), the start value
printed left of the row's left dot and the end value right of its right dot, so no value sits on a line. Every printed
number is a ledger entry printed with FX.entry; every name is the request's label marked with its name row.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.dumbbell, run.py leaf): {
  "title": segs, "unit": segs,                      # the unit is written once, in the head
  "series_kind": "place" | <kind>,                  # name rows: a row's name, name:zh_names:<kind>:<code> or a place's
  "rows": [{"code": code,                           # one row per place, top down in layer 1's order (the leaf sorts nothing)
            "a": series src, "b": series src,       # its cells at the start and the end period (geometry only)
            "a_text": ledger src, "b_text": ledger src}],  # the two values as printed (layer 1's facts)
  "periods": [ledger src, ledger src],              # period:<table>:<period> of the start and the end, for the key
  "axis": {"ticks": [ledger src, ...],              # fact:<key>.tick<i>, ascending, each printed text a number
           "scale": number},                        # a tick's printed number is its raw value times scale (its format's)
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
Refuses: no rows, a row twice, a cell the request lacks, a start and end cell of one row at one period, a negative value
(the axis starts at 0), not two period entries, a period entry no row's cell has, no tick, a tick whose text is no number
or ticks not ascending, a highlight that is no row, a digit in a literal word, a text that leaves the picture or overlaps
another, a board too narrow (plot under 240 px)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
from wbkit import FX, prod, Refused, esc, tw

NODE = "dumbbell"
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), row=(30, (22, 48, 1), "distance between two rows in px"),
    dot_r=(5, (3, 8, 0.5), "dot radius px"), line_w=(3, (1.5, 6, 0.5), "connector width px"),
    highlight=("", None, "code of the row drawn in the accent; none = the first row"))


def period_of(src):
    """The period a series src names (series:<table>/<codes>:<period>:<column>)."""
    parts = src.rsplit(":", 2) if isinstance(src, str) else []
    if len(parts) != 3 or not src.startswith("series:"): raise Refused(f"dumbbell: {src!r} is no series src")
    return parts[1]


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        rows = d.get("rows") or []
        if not rows: raise Refused("dumbbell: the spec holds no rows")
        codes = [r.get("code") for r in rows]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"dumbbell: the rows' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"dumbbell: the rows {twice} come twice")
        f.kind = d.get("series_kind", "place")
        f.rows, pa, pb = [], set(), set()
        for r in rows:
            a, b = K.val(r.get("a")), K.val(r.get("b"))
            if a < 0 or b < 0: raise Refused(f"dumbbell: row {r['code']} has a value below 0; the axis starts at 0")
            if period_of(r["a"]) == period_of(r["b"]): raise Refused(f"dumbbell: row {r['code']}'s two cells are at one period")
            if not r.get("a_text") or not r.get("b_text"): raise Refused(f"dumbbell: row {r['code']} lacks a value's ledger entry")
            pa.add(period_of(r["a"])); pb.add(period_of(r["b"]))
            f.rows.append(dict(code=r["code"], a=a, b=b, at=K.ent(r["a_text"]), bt=K.ent(r["b_text"]), name=K.named(r["code"], f.kind)))
        per = d.get("periods") or []
        if not isinstance(per, list) or len(per) != 2: raise Refused("dumbbell: the key needs the start and the end period entries")
        for src, held in zip(per, (pa, pb)):
            if not isinstance(src, str) or not src.startswith("period:"): raise Refused(f"dumbbell: the period entry {src!r} is no period:<table>:<period>")
            if src.rsplit(":", 1)[1] not in held: raise Refused(f"dumbbell: the period entry {src} names a period no row's cell has")
        f.periods = [K.ent(src) for src in per]
        hl = K.check_codes(NODE, k("highlight"), set(codes)) if k("highlight") else {codes[0]}
        if len(hl) > 1: raise Refused("dumbbell: highlight names one row")
        f.hl = next(iter(hl))
        axis = d.get("axis") or {}
        ticks = axis.get("ticks") or []
        if not isinstance(ticks, list) or not ticks: raise Refused("dumbbell: the axis holds no tick (fact:<key>.tick<i>, layer 1's)")
        scale = axis.get("scale")
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not scale > 0: raise Refused(f"dumbbell: the axis scale {scale!r} is no number above 0")
        f.ticks = []
        for src in ticks:
            text = FX.text(src)
            try: raw = float(text.replace(",", "")) / scale
            except ValueError: raise Refused(f"dumbbell: the tick {text!r} ({src}) is no number")
            if f.ticks and raw <= f.ticks[-1][0]: raise Refused(f"dumbbell: the ticks are not ascending at {src}")
            f.ticks.append((raw, K.ent(src)))
        f.top = max([v for r in f.rows for v in (r["a"], r["b"])] + [f.ticks[-1][0]])
        if f.top <= 0: raise Refused("dumbbell: every value is 0; a dot over an axis from 0 needs one above it")
        size = f.size
        name_w = max(tw(r["name"][1], size) for r in f.rows)
        val_w = max(tw(t, size) for r in f.rows for _, t in (r["at"], r["bt"]))
        f.x0 = 8 + name_w + 12 + val_w + 8 + k("dot_r")   # names, then room for a start value left of a dot at 0
        f.x1 = f.W - 8 - val_w - 8 - k("dot_r")           # room for an end value right of a dot at the top
        if f.x1 - f.x0 < 240: raise Refused("dumbbell: the board is too narrow for the names, the values and the plot (plot under 240 px)")
        f.name_x = 8 + name_w

    def x(f, v):
        return f.x0 + (f.x1 - f.x0) * v / f.top


def cl_dumbbell(f, occ):
    d, size, W, r0 = f.d, f.size, f.W, f.k("dot_r")
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    # the key: a hollow grey dot names the start period, a filled one the end
    ky = 22 + size * 2.0
    (a_svg, a_txt), (b_svg, b_txt) = f.periods
    kx = f.x0
    o.append(f'<circle cx="{kx:.1f}" cy="{ky - size * 0.35:.1f}" r="{r0}" fill="var(--bg)" stroke="var(--t-sec)" stroke-width="1.5"/>')
    o.append(K.txt(B, kx + r0 + 5, ky, size, "var(--t-sec)", a_svg, tw(a_txt, size), tag="key start"))
    kx2 = kx + r0 + 5 + tw(a_txt, size) + 18
    o.append(f'<circle cx="{kx2:.1f}" cy="{ky - size * 0.35:.1f}" r="{r0}" fill="var(--t-title)"/>')
    o.append(K.txt(B, kx2 + r0 + 5, ky, size, "var(--t-sec)", b_svg, tw(b_txt, size), tag="key end"))
    top = ky + size * 1.6
    pitch = f.k("row")
    # the rows: name, connector (grey; the highlight's in the accent), the start dot hollow, the end dot filled
    for i, r in enumerate(f.rows):
        hot = r["code"] == f.hl
        y = top + pitch * (i + 0.5)
        xa, xb = f.x(r["a"]), f.x(r["b"])
        ink = "var(--accent)" if hot else "var(--t-title)"
        nm_svg, nm = r["name"]
        o.append(K.txt(B, f.name_x, y + size * 0.35, size, "var(--accent)" if hot else "var(--t-body)", nm_svg, tw(nm, size), anchor="end",
                       weight=700 if hot else 400, tag=f"name {r['code']}"))
        o.append(f'<line x1="{xa:.1f}" y1="{y:.1f}" x2="{xb:.1f}" y2="{y:.1f}" stroke="{"var(--accent)" if hot else "var(--bar)"}" '
                 f'stroke-width="{f.k("line_w")}" stroke-linecap="round" data-code="{esc(r["code"])}"/>')
        o.append(f'<circle cx="{xa:.1f}" cy="{y:.1f}" r="{r0}" fill="var(--bg)" stroke="var(--t-sec)" stroke-width="1.5" data-code="{esc(r["code"])}"/>')
        o.append(f'<circle cx="{xb:.1f}" cy="{y:.1f}" r="{r0}" fill="{ink}" data-code="{esc(r["code"])}"/>')
        # the values: the left dot's left of it, the right dot's right of it (the start's or the end's, wherever each lies)
        (l_svg, l_txt), (r_svg, r_txt) = (r["at"], r["bt"]) if xa <= xb else (r["bt"], r["at"])
        lx, rx = min(xa, xb) - r0 - 5, max(xa, xb) + r0 + 5
        o.append(K.txt(B, lx, y + size * 0.35, size, "var(--t-sec)", l_svg, tw(l_txt, size), anchor="end", tag=f"value {r['code']} left"))
        o.append(K.txt(B, rx, y + size * 0.35, size, ink if hot else "var(--t-body)", r_svg, tw(r_txt, size), weight=700 if hot else 400,
                       tag=f"value {r['code']} right"))
    # the value axis: a baseline under the rows with a short tick and its printed number per tick, 0 at the plot's left
    base = top + pitch * len(f.rows) + 4
    o.append(K.line(f.x0, base, f.x1, base, stroke="var(--t-title)", w=0.8, op=1))
    for raw, (svg_t, text) in f.ticks:
        x = f.x(raw)
        o.append(K.line(x, base, x, base + 4, stroke="var(--t-title)", w=0.8, op=1))
        o.append(K.txt(B, x, base + 4 + size * 1.1, size, "var(--t-sec)", svg_t, tw(text, size), anchor="middle", tag=f"tick {text}"))
    y = base + 4 + size * 1.6
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"dumbbell: lines is {lns!r}; lines is a list of segment lists")
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


DUMBBELL_LAYERS = dict(dumbbell=(cl_dumbbell, None))
DUMBBELL_SVG = ["dumbbell"]


def draw(h):
    f = Frame(h)
    inner = cl_dumbbell(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "dumbbell"), f.W, f.H
