"""pair_bars layer: two places side by side, one row per part (a use, a sector, a measure), each row two tracks, the
place's value filled in from the track's left in the accent, the rest of the track the page's empty grey, and at the
right the ratio between the two as layer 1 prints it. The two places' names head their columns; each row's name stands
left of the tracks; a value prints just past its bar's end inside the track, or inside the bar's end (in the ground
colour) where the track has no room after it. Every printed number is a ledger entry printed with FX.entry; every
place's name is the request's label marked with its name row; a row's name comes in the request as segs.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.pair_bars, run.py leaf): {
  "title": segs?, "unit": segs?,                    # an optional head: the chart name and its unit
  "places": [code, code],                           # the two places, left column first
  "place_kind": "place" | <kind>,                   # their name rows: a place's, or name:zh_names:<kind>:<code>
  "full": number?,                                  # a full track's value (100 for a share in percent; geometry only, never
                                                    # printed); none: the largest value drawn fills its track
  "rows": [{"code": code,                           # one row per part, top down in layer 1's order (the leaf sorts nothing)
            "label": segs,                          # the part's name as printed
            "a": series src, "b": series src,       # the two places' cells (geometry only), both at one period
            "a_text": ledger src, "b_text": ledger src,  # the two values as printed (layer 1's facts)
            "ratio": ledger src?}],                 # the first value over the second as printed (layer 1's fact)
  "ratio_unit": segs?,                              # the words after each ratio (a times word)
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts: ratio_<part>_<a>_<b> (the first place's value over the second's, per row: the leaf computes no ratio).
needs new wording: the times word after a ratio and every row's name come from the request (ratio_unit, label).
Placement keeps texts off the bars by construction: the row names in a column left of the tracks, the place names over
their columns, each value wholly inside its track (after its bar) or wholly inside its bar, the ratios in a column right
of the tracks; every text box is checked in wbkit.Boxes (outside the picture or over another refuses).
Refuses: not two distinct places, no rows, a row twice, a row whose cell the request lacks or whose cells are not both at
one period (one period for every row), a cell whose row names neither place or the other place, a value below 0 or
above full, a full that is no number above 0, a row with no value entry, a value that fits neither after its bar nor
inside it, a ratio with no ratio_unit, a highlight that is no row, a digit in a literal word, a text that leaves the
picture or overlaps another, a board too narrow (a track under 120 px)."""

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "pair_bars"
prod.KNOBS[NODE] = dict(
    size=(13, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    head_size=(15, (12, 20, 0.5), "the two places' names size px"),
    width=(880, (480, 1400, 10), "picture width in px"), row=(56, (32, 80, 1), "distance between two rows in px"),
    bar_h=(24, (16, 36, 1), "a track's height in px"), gap=(40, (16, 80, 2), "space between the two columns in px"),
    highlight=("", None, "code of the row whose ratio is bold; none = no row"))


def _cell_dims(src):
    """The dims of the request's row a series src names (FX.SRCS: each cell's src); a src the request lacks refuses."""
    for t in (FX.TABLES or {}).values():
        for c in t:
            if FX.SRCS.get(id(c)) == src: return c
    raise Refused(f"pair_bars: {src!r} is not a cell of the request")


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        places = d.get("places")
        if not (isinstance(places, list) and len(places) == 2 and all(isinstance(c, str) and K.CODE.fullmatch(c) for c in places)
                and places[0] != places[1]): raise Refused(f"pair_bars: places {places!r} is not two distinct codes")
        f.kind = d.get("place_kind", "place")
        if not isinstance(f.kind, str) or not f.kind: raise Refused("pair_bars: place_kind names no kind")
        f.places = [dict(code=c, name=K.named(c, f.kind)) for c in places]
        rows = d.get("rows") or []
        if not isinstance(rows, list) or not rows: raise Refused("pair_bars: the spec holds no rows")
        codes = [r.get("code") if isinstance(r, dict) else None for r in rows]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"pair_bars: the rows' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"pair_bars: the rows {twice} come twice")
        f.rows, periods = [], set()
        for r in rows:
            vals = []
            for side, own, other in (("a", places[0], places[1]), ("b", places[1], places[0])):
                src = r.get(side)
                v = K.val(src)
                dims = set(map(str, _cell_dims(src).values()))
                if own not in dims or other in dims: raise Refused(f"pair_bars: row {r['code']}'s {side} cell {src} is not {own}'s")
                if v < 0: raise Refused(f"pair_bars: row {r['code']} has a value below 0; a track starts at 0")
                if not r.get(side + "_text"): raise Refused(f"pair_bars: row {r['code']} lacks the ledger entry of its {side} value")
                periods.add(K.period_of(src)); vals.append(v)
            ratio = r.get("ratio")
            f.rows.append(dict(code=r["code"], label=r.get("label"), a=vals[0], b=vals[1], at=K.ent(r["a_text"]), bt=K.ent(r["b_text"]),
                               ratio=K.ent(ratio) if ratio else None))
            K.segs(r.get("label"), f"row {r['code']} label")
        if len(periods) != 1: raise Refused(f"pair_bars: the cells are at {sorted(periods)}; the two places are compared at one period")
        full = d.get("full")
        if full is None: full = max(max(r["a"], r["b"]) for r in f.rows)
        if isinstance(full, bool) or not isinstance(full, (int, float)) or not full > 0: raise Refused(f"pair_bars: full {full!r} is no number above 0")
        over = [r["code"] for r in f.rows if max(r["a"], r["b"]) > full]
        if over: raise Refused(f"pair_bars: rows {over} hold a value above full {full}")
        f.full = full
        f.unit = d.get("ratio_unit")
        if any(r["ratio"] for r in f.rows):
            if not f.unit: raise Refused("pair_bars: a row prints a ratio and the spec gives no ratio_unit (the words after it)")
            ru = K.plain(f.unit, "ratio_unit")
        else: ru = ""
        hl = K.check_codes(NODE, k("highlight"), set(codes)) if k("highlight") else set()
        if len(hl) > 1: raise Refused("pair_bars: highlight names one row")
        f.hl = next(iter(hl), None)
        size = f.size
        f.label_w = max(tw(K.plain(r["label"], "label"), size) for r in f.rows) + 14
        f.ratio_w = max([tw(r["ratio"][1] + ru, size) for r in f.rows if r["ratio"]] or [0])
        f.ratio_w = f.ratio_w + 14 if f.ratio_w else 0
        f.x0 = 8 + f.label_w
        f.track = (f.W - 8 - f.x0 - k("gap") - f.ratio_w) / 2
        if f.track < 120: raise Refused("pair_bars: the board is too narrow for the names, two tracks and the ratios (a track under 120 px)")
        f.xs = (f.x0, f.x0 + f.track + k("gap"))
        f.H = 0


def cl_pair_bars(f, occ):
    d, size, W, bh = f.d, f.size, f.W, f.k("bar_h")
    B = K.Boxes(W, 10 ** 6); o = []
    y = 22
    if d.get("title"):
        o.append(K.head(B, d["title"], d["unit"], size, f.k("title_size")) if d.get("unit") else
                 K.words(B, d["title"], "title", 8, y, f.k("title_size"), "var(--t-title)", weight=700)[0])
        y += f.k("title_size") * 1.8
    # the two places' names over their columns
    hs = f.k("head_size")
    for x, p in zip(f.xs, f.places):
        nm_svg, nm = p["name"]
        o.append(K.txt(B, x, y, hs, "var(--t-title)", nm_svg, tw(nm, hs), weight=700, tag=f"place {p['code']}"))
    top = y + hs * 0.6
    pitch = f.k("row")
    for i, r in enumerate(f.rows):
        ty = top + pitch * i + (pitch - bh) / 2
        base = ty + bh * 0.5 + size * 0.35
        o.append(K.words(B, r["label"], f"label {r['code']}", f.x0 - 14, base, size, "var(--t-body)", anchor="end")[0])
        for x, v, (v_svg, v_txt), side in zip(f.xs, (r["a"], r["b"]), (r["at"], r["bt"]), "ab"):
            fw = f.track * v / f.full
            vw = tw(v_txt, size)
            o.append(f'<rect x="{x:.1f}" y="{ty:.1f}" width="{f.track:.1f}" height="{bh}" fill="var(--empty)" data-code="{esc(r["code"])}"/>')
            o.append(f'<rect x="{x:.1f}" y="{ty:.1f}" width="{fw:.1f}" height="{bh}" fill="var(--accent)" data-code="{esc(r["code"])}"/>')
            if fw + 6 + vw + 4 <= f.track:  # after the bar, inside the track
                o.append(K.txt(B, x + fw + 6, base, size, "var(--t-title)", v_svg, vw, weight=700, tag=f"value {r['code']} {side}"))
            elif fw >= vw + 12:  # inside the bar's end, in the ground colour
                o.append(K.txt(B, x + fw - 6, base, size, "var(--bg)", v_svg, vw, anchor="end", weight=700, tag=f"value {r['code']} {side}"))
            else: raise Refused(f"pair_bars: row {r['code']}'s {side} value {v_txt!r} fits neither after its bar nor inside it; a wider board")
        if r["ratio"]:
            (r_svg, r_txt), hot = r["ratio"], r["code"] == f.hl
            unit_svg = "".join(FX.entry(s, "tspan", None) if s else esc(t) for t, s in K.segs(f.unit, "ratio_unit"))
            ru = K.plain(f.unit, "ratio_unit")
            o.append(K.txt(B, f.xs[1] + f.track + 14, base, size, "var(--t-title)" if hot else "var(--t-sec)", r_svg + unit_svg,
                           tw(r_txt + ru, size), weight=700 if hot else 400, tag=f"ratio {r['code']}"))
    y = top + pitch * len(f.rows)
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"pair_bars: lines is {lns!r}; lines is a list of segment lists")
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


PAIR_BARS_LAYERS = dict(pair_bars=(cl_pair_bars, None))
PAIR_BARS_SVG = ["pair_bars"]


def draw(h):
    f = Frame(h)
    inner = cl_pair_bars(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "pair_bars"), f.W, f.H
