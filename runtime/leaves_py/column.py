"""The column page's leaf nodes (knobs.py RECIPES column): the big numbers, an html layer in the page's header, and one bar
per ranked place, an svg layer that is the page's picture; both over one frame (ColumnFrame). With a map panel (the hero's
leaves.bubbles) the hero is two columns in one panel: the map (MAP_W wide, the map leaves' shared frame) on the left, the
bars on the right of it (MAP_GAP after), each drawn where the panel places it. A column page prints from a
ledger only: every number is an entry (facts.entry), the bars' values the family hero.data.family (<family>.<code>), the
big numbers the facts hero.data names (hi, lo, gap, times), each name the request's label marked with its name row. Raw
row values drive the bars' lengths only. With the knob bars.measure change (a page with two ends, hero.data.t0 and year) each
bar is its place's change between the two years, a signed bar from 0, its value the family member with its unit."""
import html, os, re, sys, unicodedata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts as FX
import prod
from words import word


PAGE_W, MAP_W, MAP_GAP = 1140, 560, 40  # the hero's width, the map panel's width beside the bars and the gap between them


class ColumnFrame:
    """What the column layers share: the ranked places (layer 1's order, kept as given) with their raw values at the year,
    the marked ones, and the panel's size: the page's width and the taller of the bars' rows and the map (`mv`, the map
    leaves' mapkit.View, when the page has one: the bars then start at x0 after it, bw wide). A place with no row at the
    year, a value below 0 or none above it refuses: the bars start at 0. With bars.measure change each value is the place's
    change from hero.data.t0 to the year (the later row less the earlier): a place with no row at either, or no place that
    changed, refuses."""
    def __init__(f, c, h, mv=None):
        if FX.LEDGER is None: raise FX.Refused("column: the page prints from a ledger only")
        d = h["data"]; K = lambda k: prod.knob(h, "bars", k)
        f.c, f.h, f.d = c, h, d
        f.table = d.get("table") or next(iter(c.spec["tables"]))
        by, year = prod.need(d, "by"), str(prod.need(d, "year"))
        f.change = K("measure") == "change"
        at = lambda t: {r[by]: float(r["OBS_VALUE"]) for r in c.T[f.table] if r["TIME_PERIOD"] == t and by in r}
        ends = [str(prod.need(d, "t0")), year] if f.change else [year]
        rows = {t: at(t) for t in ends}
        for t in ends:
            off = [k for k in d["ranked"] if k not in rows[t]]
            if off: raise FX.Refused(f"bars: no row at {t} for {', '.join(off)}")
        f.vals = [(k, rows[year][k] - rows[ends[0]][k] if f.change else rows[year][k]) for k in d["ranked"]]
        if f.change:
            if not f.vals or all(v == 0 for _, v in f.vals): raise FX.Refused("bars: no place changed between the two years")
        elif not f.vals or min(v for _, v in f.vals) < 0 or max(v for _, v in f.vals) <= 0:
            raise FX.Refused("bars: the values are not all 0 or more with one above 0")
        f.year, f.marks, f.size, f.rh = year, set(d.get("marks") or []), K("size"), K("row")
        f.mv, f.W = mv, PAGE_W
        f.x0 = mv.W + MAP_GAP if mv else 0; f.bw = f.W - f.x0
        f.lw = max(prod.tw(prod.NAME(k), f.size) for k, _ in f.vals) + 12  # the names' column, right-aligned to the bars
        f.vw = max(prod.tw(FX.text(val_src(d, k, f.change)), f.size) for k, _ in f.vals) + 8  # room after the longest bar for its value
        f.top = K("top")
        f.bh = f.top + f.rh * len(f.vals) + 4
        f.H = max(f.bh, mv.H if mv else 0)


def val_src(d, code, change=False):
    """The ledger entry a bar's value prints: the family's member's bare number, under the unit line; a change with its own
    unit (percentage points of a share), which the unit line does not name."""
    return f"fact:{prod.need(d, 'family')}.{code}" + ("" if change else ".n")


def html_named(code):
    """A place's name in html, marked with its name row (as prod.named marks it in svg)."""
    return f'<span data-src="{html.escape(prod.name_src(code))}">{html.escape(prod.NAME(code))}</span>'


def cl_bars(f, occ):
    """One bar per ranked place, largest first: the name before it, the value after it; a marked place in the accent. Drawn
    from x0, where the panel places the bars. With bars.measure change: cl_change_bars."""
    if f.change: return cl_change_bars(f)
    o, mx, bw, lw = [], max(v for _, v in f.vals), f.bw - f.lw - f.vw, f.x0 + f.lw
    o.append(f'<line x1="{lw:.1f}" x2="{lw:.1f}" y1="{f.top}" y2="{f.top + f.rh * len(f.vals)}" stroke="var(--t-sec)" stroke-width="0.8"/>')
    for i, (k, v) in enumerate(f.vals):
        y, w, hi = f.top + i * f.rh, v / mx * bw, k in f.marks
        ink, weight = ("var(--t-title)", 700) if hi else ("var(--t-body)", 400)
        mid = y + f.rh / 2
        o.append(f'<text x="{lw - 8:.1f}" y="{mid:.1f}" text-anchor="end" dominant-baseline="middle" font-size="{f.size}" fill="{ink}" font-weight="{weight}">{prod.named(k)}</text>'
                 f'<rect x="{lw:.1f}" y="{y + 3:.1f}" width="{w:.1f}" height="{f.rh - 6}" fill="{"var(--accent)" if hi else "var(--bar)"}"/>'
                 f'<text x="{lw + w + 6:.1f}" y="{mid:.1f}" dominant-baseline="middle" font-size="{f.size}" fill="{"var(--accent)" if hi else "var(--t-sec)"}" font-weight="{weight}">{FX.entry(val_src(f.d, k), "tspan", None)}</text>')
    return "".join(o)


# A change bar's colour by its sign, the page's fall and rise colours (as prod's flow lines and halos); no change, the bar's.
RISE, FALL = "var(--accent2)", "var(--accent)"


def cl_change_bars(f):
    """One signed bar per ranked place in layer 1's order (by its change, the largest rise first): from a zero line, a rise
    to the right in the rise colour, a fall to the left in the fall colour, each bar's length its change on one scale; the
    name before the bars, the value past each bar's end (on its side of the zero line); a marked place's name and value in
    bold. The scale leaves room for a value on each side a bar runs to."""
    o, lo, hi = [], min(0.0, min(v for _, v in f.vals)), max(0.0, max(v for _, v in f.vals))
    neg, pos = (f.vw if lo < 0 else 0), (f.vw if hi > 0 else 0)
    left, lw = f.x0 + f.lw + neg, f.x0 + f.lw
    bw = f.bw - f.lw - neg - pos
    z = left + -lo / (hi - lo) * bw
    o.append(f'<line x1="{z:.1f}" x2="{z:.1f}" y1="{f.top}" y2="{f.top + f.rh * len(f.vals)}" stroke="var(--t-sec)" stroke-width="0.8"/>')
    for i, (k, v) in enumerate(f.vals):
        y, w, hi_ = f.top + i * f.rh, abs(v) / (hi - lo) * bw, k in f.marks
        ink, weight = ("var(--t-title)", 700) if hi_ else ("var(--t-body)", 400)
        mid, x = y + f.rh / 2, z if v >= 0 else z - w
        tx, anchor = (z + w + 6, "start") if v >= 0 else (z - w - 6, "end")
        o.append(f'<text x="{lw - 8:.1f}" y="{mid:.1f}" text-anchor="end" dominant-baseline="middle" font-size="{f.size}" fill="{ink}" font-weight="{weight}">{prod.named(k)}</text>'
                 f'<rect x="{x:.1f}" y="{y + 3:.1f}" width="{w:.1f}" height="{f.rh - 6}" fill="{RISE if v > 0 else FALL if v < 0 else "var(--bar)"}"/>'
                 f'<text x="{tx:.1f}" y="{mid:.1f}" text-anchor="{anchor}" dominant-baseline="middle" font-size="{f.size}" fill="{ink if hi_ else "var(--t-sec)"}" font-weight="{weight}">{FX.entry(val_src(f.d, k, True), "tspan", None)}</text>')
    return "".join(o)


prod.KNOBS["bars"] = dict(row=(24, (16, 40, 1), "row height of one bar"), size=(13, (9, 18, 0.5), "font size of the names and values"),
                          top=(6, (0, 40, 1), "space above the first bar"),
                          measure=("level", ("level", "change"), "what a bar is: the place's level at the year, or its change from t0"))


prod.KNOBS["bignums"] = dict(size=(36, (28, 64, 2), "number size in px"), label_lines=(2, (1, 3, 1), "lines a label may take; more refuses"),
                             align=("left", ("left", "center"), "alignment of the numbers"),
                             min=(22, (14, 40, 2), "smallest number size a cell may shrink to before its unit wraps"),
                             width=(560, (240, 720, 10), "width of the big numbers' box beside the title"),
                             cols=(2, (1, 3, 1), "cells in a row"))
BN_PAD, BN_GAP = 22, 24  # the box's left padding (after its rule) and the gap between two cells, as CSS sets them


def trend(c, key):
    """The word ending for the change fact key, picked by the program from its sign, never by the request: ".fall" below 0,
    ".rise" above it, ".flat" when it prints as 0 (0, -0.0, or a change its ledger entry rounds to 0). A value that is no
    finite number refuses."""
    v = c.F[key]["v"]
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")): raise FX.Refused(f"{key}: the change {v!r} is no number")
    shown = FX.text(f"fact:{key}.n") if FX.LEDGER is not None else str(v)
    if v == 0 or not any(unicodedata.digit(ch, 0) for ch in shown): return ".flat"  # every digit it prints is a 0, in any script
    return ".fall" if v < 0 else ".rise"


def bignum_cells(f):
    """The (fact key, label html) cells: hero.data.bignums when the request gives it (1-6 items {fact, label}), else the column page's
    four (hi, lo, gap, times). A label is words only: {"word": key, ...fills} from the word table, each fill a place's code
    ("name", printed with its name row) or a ledger entry ({"src": ...}, printed marked); any other fill, a plain string or a
    label with a digit refuses (a number prints from its fact entry only). A fall or rise word is the program's: "by_sign"
    names the item's own fact and picks the ending (trend); a key that already ends in one refuses."""
    d, c = f.d, f.c
    place = lambda k: c.spec["facts"][d[k]]["filter"][d["by"]]
    items = d.get("bignums")
    if items is None:
        return [(d["hi"], word("column.hi", name=html_named(place("hi")))), (d["lo"], word("column.lo", name=html_named(place("lo")))),
                (d["gap"], word("column.gap")), (d["times"], word("column.times"))]
    if not isinstance(items, list) or not 1 <= len(items) <= 6: raise FX.Refused(f"bignums: {len(items) if isinstance(items, list) else items!r} items; 1 to 6 are drawn")
    out = []
    for i, it in enumerate(items):
        lab = it.get("label")
        if not isinstance(lab, dict) or "word" not in lab: raise FX.Refused(f"bignums: item {i} label is not a word-table key")
        if it.get("fact") not in c.F: raise FX.Refused(f"bignums: item {i} names no fact the page has")
        key = lab["word"]
        if re.search(r"\.(fall|rise|flat)$", key): raise FX.Refused(f"bignums: item {i} names its own fall or rise word {key}; by_sign picks it")
        if "by_sign" in lab:  # the word for a fall or a rise, by the sign of the item's own fact (a change prints without one)
            if lab["by_sign"] != it["fact"]: raise FX.Refused(f"bignums: item {i} signs by {lab['by_sign']!r}, not its own fact {it['fact']}")
            key += trend(c, it["fact"])
        fills = {}
        for k, v in lab.items():
            if k in ("word", "by_sign"): continue
            if k == "name" and isinstance(v, str) and v in prod.NAMES: fills[k] = html_named(v)
            elif isinstance(v, dict) and list(v) == ["src"] and isinstance(v["src"], str): fills[k] = FX.entry(v["src"], "span", None)
            else: raise FX.Refused(f"bignums: item {i} fills {k} with neither a place the request names nor a ledger entry")
        text = word(key, **fills)
        if FX.digit(re.sub(r"<(\w+)[^>]*data-src[^>]*>[^<]*</\1>|<[^>]+>", "", text)): raise FX.Refused(f"bignums: item {i} label holds a digit")
        out.append((it["fact"], text))
    return out


def bignum_fit(text, cell, K):
    """The size a big number prints at in a cell `cell` px wide: the knob's size, stepped down to its min until the text fits
    (prod.tw); still too wide at the min, its unit wraps under the number (each part after a space must fit then), and a part
    too wide even so refuses. Returns (size, wraps)."""
    size = K("size")
    while size > K("min") and prod.tw(text, size) > cell: size -= 2
    if prod.tw(text, size) <= cell: return size, False
    wide = max(text.split(), key=lambda p: prod.tw(p, size))
    if prod.tw(wide, size) > cell: raise FX.Refused(f"bignums: {text!r} does not fit a {cell:.0f} px cell at {size} px, its unit wrapped")
    return size, True


def cl_bignums(f, occ):
    """The big numbers beside the title: each a fact the request names (hero.data.bignums, else hi, lo, gap, times), printed from its
    ledger entry, in a box `width` px wide with `cols` cells a row; each number at the largest size up to `size` that keeps it in its
    cell (bignum_fit), so none runs past the page. The size, the label lines and the alignment are knobs."""
    c, K = f.c, lambda k: prod.knob(f.h, "bignums", k)
    cells = bignum_cells(f)
    off = [k for k, lab in cells if len(re.sub(r"<[^>]+>", "", lab)) > K("label_lines") * 22]
    if off: raise FX.Refused(f"bignums: the label of {off[0]} is longer than {K('label_lines')} lines")
    cols = min(K("cols"), len(cells)); cell = (K("width") - BN_PAD - (cols - 1) * BN_GAP) / cols
    st = f' style="width:{K("width")}px;grid-template-columns:repeat({cols},1fr);text-align:{K("align")}"'
    out = []
    for k, lab in cells:
        v = c.t("{" + k + "}"); size, wraps = bignum_fit(html.unescape(re.sub(r"<[^>]+>", "", v)), cell, K)
        out.append(f'<div class="bn"><div class="bv" style="font-size:{size}px;line-height:1.2{";white-space:normal" if wraps else ""}">{v}</div><div class="bl">{lab}</div></div>')
    return f'<div class="bns"{st}>' + "".join(out) + "</div>"


# name -> (draw, reserve); svg layers go into the picture, html layers sit in the page around it
COLUMN_LAYERS = dict(bignums=(cl_bignums, None), bars=(cl_bars, None))
COLUMN_SVG = ["bars"]


def column_shell(f, bars, unit, pic=""):
    """The column hero around its drawn bars: the unit and year line over the picture's svg, led by the page's scope when the
    hero names one (hero.scope: the aggregate's code, its name printed from the request's labels and marked with its name
    row, and the fact counting the places drawn, its number printed from the ledger; the words the word table's
    column.scope; a code the labels do not name prints no scope, never a raw word); with a map panel, the map's
    svg (`pic`, its layers; class cmap, as the page css places a .map absolutely) on the left and the bars' beside it, its
    viewBox starting at x0 so each text stands where the panel placed it."""
    year = word("date.y", y=FX.entry(f"period:{f.table}:{f.year}", "span", None))
    if f.change: year = word("column.change_years", a=FX.entry(f"period:{f.table}:{prod.need(f.d, 't0')}", "span", None), b=year)
    sc = f.h.get("scope")
    if sc and sc.get("code") in prod.NAMES: unit = word("column.scope", place=prod.named(sc["code"]), n=FX.entry(f"fact:{sc['count']}.n", "span", None)) + unit
    bars = f'<svg class="bars" viewBox="{f.x0} 0 {f.bw} {f.bh:.0f}" width="{f.bw}" height="{f.bh:.0f}">{bars}</svg>'
    if f.mv: bars = f'<div class="cm"><svg class="cmap" viewBox="0 0 {f.mv.W} {f.mv.H}" width="{f.mv.W}" height="{f.mv.H}">{pic}</svg>{bars}</div>'
    return f'<div class="hero column"><div class="cu">{unit}{word("list.sep")}{year}</div>{bars}</div>'


def strip_shell(svg, w, h):
    """The illustration strip under the hero: layer 1's strip (line art in the page's ink and accent, no text) in its own
    svg, as wide as the hero, hidden from a screen reader (it says nothing the page does not)."""
    return (f'<div class="illus-strip" aria-hidden="true"><svg viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}">'
            f'<g data-layer="illus_strip">{svg}</g></svg></div>')


# The header's second column is as wide as the big numbers' box (bignums.width), which sizes each number to its cell.
CSS = """.illus-strip{width:1140px;margin:0 0 24px}.illus-strip svg{display:block}""" + """.hero.column{position:relative;width:1140px;margin:8px 0 30px}.hero.column .cu{font:400 12px/17px var(--sans);color:var(--t-sec);margin-bottom:6px}""" + \
    ".hero.column .cm{display:flex;gap:%dpx;align-items:flex-start}.hero.column .cm svg{flex:none}" % MAP_GAP  # the map, the gap, the bars
