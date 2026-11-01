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
    changed, refuses.
    The page's main layer is its recipe's (run.MAIN): the bars, or a chart leaf of run.LEAF_LAYERS drawn across the page in
    the bars' place, which reads only hero.data's year (and table) for the unit and year line; its picture's size is the
    leaf's own, settled by sized once the leaf has drawn (a leaf settles its height while it draws). Such a page has no map
    panel (the map stands beside the bars)."""
    def __init__(f, c, h, mv=None, main="bars"):
        if FX.LEDGER is None: raise FX.Refused("column: the page prints from a ledger only")
        d = h["data"]; K = lambda k: prod.knob(h, "bars", k)
        f.c, f.h, f.d, f.main = c, h, d, main
        f.table = d.get("table") or next(iter(c.spec["tables"]))
        if main != "bars":
            if mv: raise FX.Refused(f"column: the map panel stands beside the bars; a {main} page has none")
            f.year, f.change, f.marks, f.mv, f.W, f.x0 = str(prod.need(d, "year")), False, set(), None, PAGE_W, 0
            f.focus, f.noted, f.map_h = set(), set(), 0  # the accent marks bars only: a main leaf's page has no focus
            f.bw = f.bh = f.H = None
            return
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
        f.focus, f.noted = set(focus(h)), set(noted(h))
        off = sorted(f.focus - set(d["ranked"]))
        if off: raise FX.Refused(f"column: the accent names {', '.join(off)}, no place the page ranks")
        f.mv, f.W = mv, PAGE_W
        f.map_h = mv.H if mv else 0  # the map's svg height: the map's, or more when the bubbles' key stands under it (bubbles.cl_bubble_key)
        f.x0 = mv.W + MAP_GAP if mv else 0; f.bw = f.W - f.x0
        f.lw = max(prod.tw(prod.NAME(k), f.size) for k, _ in f.vals) + 12  # the names' column, right-aligned to the bars
        f.vw = max(prod.tw(FX.text(val_src(d, k, f.change)), f.size) for k, _ in f.vals) + 8  # room after the longest bar for its value
        f.top = K("top")
        f.bh = f.top + f.rh * len(f.vals) + 4
        f.H = max(f.bh, mv.H if mv else 0)

    def sized(f, w, h):
        """The main leaf's picture size (its Frame's W and H): the panel's height, and the svg the page places it in; a
        picture wider than the page refuses."""
        if w > f.W: raise FX.Refused(f"column: the {f.main} picture is {w} px wide, the page {f.W}")
        f.bw, f.bh = w, h; f.H = h


def focus(h):
    """The page's focus, the one place its accent marks in the bars and on the map: the place the page's dek names, as layer 1
    gives it (hero.data.accent: the dek finding's subject); none when it gives none, as with the frame's dek, which names no
    place. The program's, never a model's: every other bar and circle takes the page's greys."""
    a = (h.get("data") or {}).get("accent")
    return [a] if isinstance(a, str) and a else []


def noted(h):
    """The other places the map's leader notes name (the extremes the program put a note at, hero.leaves.leader_notes) besides
    the focus, in their order: each keeps its note, its bar and circle in the dark grey NOTED, never the accent."""
    notes = ((h.get("leaves") or {}).get("leader_notes") or {}).get("notes") or []
    named = [n["name"] for n in notes if isinstance(n, dict) and isinstance(n.get("name"), str)]
    return [c for c in dict.fromkeys(named) if c not in focus(h)]


def val_src(d, code, change=False):
    """The ledger entry a bar's value prints: the family's member's bare number, under the unit line; a change with its own
    unit (percentage points of a share), which the unit line does not name."""
    return f"fact:{prod.need(d, 'family')}.{code}" + ("" if change else ".n")


def html_named(code):
    """A place's name in html, marked with its name row (as prod.named marks it in svg)."""
    return f'<span data-src="{html.escape(prod.name_src(code))}">{html.escape(prod.NAME(code))}</span>'


def cl_bars(f, occ):
    """The bars a page lays out itself: the change bars (bars.measure change, cl_change_bars). A level page's bars are laid
    out by the bars node and drawn from the core's placed geometry (cl_bars_placed, the column recipe's external bars);
    asked here, they refuse."""
    if not f.change: raise FX.Refused("bars: a level page's bars are drawn from their placed geometry only (cl_bars_placed)")
    return cl_change_bars(f)


def cl_bars_placed(f, occ, placed):
    """The bars where the core placed them (knobs.placed.bars: the external bars node's reply, every number checked by the
    core, B0-B7): one item per ranked place in the core's order, its bar (mark x, y, w, h) and its texts (in the core's
    order: the name, then the value, each at its x, y). Printed in cl_bars's own words, number for number: the axis at the
    bars' left edge, the name before the bar and the value after it, a marked place's in bold, the focus's bar in the
    accent and a noted one's in the dark grey; the name is the place's (prod.named), the value the ledger entry the core
    names (its src, through FX.entry). Nothing is laid out here; an item with no bar or with other texts refuses."""
    items = placed.get("items") if isinstance(placed, dict) else None
    if not items: raise FX.Refused("bars: the placed geometry holds no item")
    o = []
    for i, it in enumerate(items):
        m, texts = it.get("mark") or {}, it.get("texts") or []
        if not all(isinstance(m.get(k), (int, float)) for k in ("x", "y", "w", "h")):
            raise FX.Refused(f"bars: placed item {i} has no bar x, y, w, h")
        if [t.get("name") for t in texts] != ["label", "value_text"] or not isinstance(texts[1].get("src"), str):
            raise FX.Refused(f"bars: placed item {i} has not the name and the value (with its src) as its texts")
        if i == 0:
            o.append(f'<line x1="{m["x"]:.1f}" x2="{m["x"]:.1f}" y1="{f.top}" y2="{f.top + f.rh * len(items)}" stroke="var(--t-sec)" stroke-width="0.8"/>')
        k, (lab, val) = it.get("code"), texts
        hi = k in f.marks
        ink, weight = ("var(--t-title)", 700) if hi else ("var(--t-body)", 400)
        o.append(f'<text x="{lab["x"]:.1f}" y="{lab["y"]:.1f}" text-anchor="end" dominant-baseline="middle" font-size="{f.size}" fill="{ink}" font-weight="{weight}">{prod.named(k)}</text>'
                 f'<rect x="{m["x"]:.1f}" y="{m["y"]:.1f}" width="{m["w"]:.1f}" height="{m["h"]}" fill="{FOCUS if k in f.focus else NOTED if k in f.noted else "var(--bar)"}"/>'
                 f'<text x="{val["x"]:.1f}" y="{val["y"]:.1f}" dominant-baseline="middle" font-size="{f.size}" fill="{ink if hi else "var(--t-sec)"}" font-weight="{weight}">{FX.entry(val["src"], "tspan", None)}</text>')
    return "".join(o)


# A bar of the page's focus (focus): the accent, which marks nothing else on the page; the legend line (accent_key) says so. A
# bar of another place the notes name (noted): a dark grey of the page's, darker than any other bar's. A change bar out of
# both by its sign, two of the page's greys: a rise the darker, a fall the bars' own; no change, the bar's.
FOCUS, NOTED = "var(--accent)", "var(--t-body)"
RISE, FALL = "var(--accent2)", "var(--bar)"


def cl_change_bars(f):
    """One signed bar per ranked place in layer 1's order (by its change, the largest rise first): from a zero line, a rise
    to the right in the rise colour, a fall to the left in the fall colour (a bar of the page's focus in the accent, one the
    notes name besides it in the dark grey, either way),
    each bar's length its change on one scale; the name before the bars, the value past each bar's end (on its side of the zero
    line); a marked place's name and value in bold. The scale leaves room for a value on each side a bar runs to."""
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
                 f'<rect x="{x:.1f}" y="{y + 3:.1f}" width="{w:.1f}" height="{f.rh - 6}" fill="{FOCUS if k in f.focus else NOTED if k in f.noted else RISE if v > 0 else FALL if v < 0 else "var(--bar)"}"/>'
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


def column_shell(f, bars, unit, pic="", main="bars"):
    """The column hero around its drawn bars: the unit and year line over the picture's svg, led by the page's scope when the
    hero names one (hero.scope: the aggregate's code, its name printed from the request's labels and marked with its name
    row, and the fact counting the places drawn, its number printed from the ledger; the words the word table's
    column.scope; a code the labels do not name prints no scope, never a raw word); with a map panel, the map's
    svg (`pic`, its layers; class cmap, as the page css places a .map absolutely) on the left and the bars' beside it, its
    viewBox starting at x0 so each text stands where the panel placed it. The picture's svg is classed by the page's main layer
    (`main`, the bars or the leaf in their place); a main leaf heads itself with its unit, so with no hero unit the line is
    its year only. After the year, when the page has a focus, the line that says what the accent means (accent_key)."""
    year = word("date.y", y=FX.entry(f"period:{f.table}:{f.year}", "span", None))
    if f.change: year = word("column.change_years", a=FX.entry(f"period:{f.table}:{prod.need(f.d, 't0')}", "span", None), b=year)
    sc = f.h.get("scope")
    if sc and sc.get("code") in prod.NAMES: unit = word("column.scope", place=prod.named(sc["code"]), n=FX.entry(f"fact:{sc['count']}.n", "span", None)) + unit
    bars = f'<svg class="{main}" viewBox="{f.x0} 0 {f.bw} {f.bh:.0f}" width="{f.bw}" height="{f.bh:.0f}">{bars}</svg>'
    if f.mv: bars = f'<div class="cm"><svg class="cmap" viewBox="0 0 {f.mv.W} {f.map_h}" width="{f.mv.W}" height="{f.map_h}">{pic}</svg>{bars}</div>'
    line = year if main != "bars" and not unit else f'{unit}{word("list.sep")}{year}'
    return f'<div class="hero column"><div class="cu">{line}{accent_key(f)}</div>{bars}</div>'


def accent_key(f):
    """The legend line of the accent, on a page with a focus (focus): a swatch in the accent, then the word table's column.accent
    (words only: the accent marks the place the dek names); none without a focus, where nothing is in the accent."""
    if not f.focus: return ""
    if FX.digit(word("column.accent")): raise FX.Refused("column: the accent's legend holds a digit")
    return f'<span class="ak">{word("column.accent")}</span>'


def strip_shell(svg, w, h):
    """The illustration strip under the hero: layer 1's strip (line art in the page's ink and accent, no text) in its own
    svg, as wide as the hero, hidden from a screen reader (it says nothing the page does not)."""
    return (f'<div class="illus-strip" aria-hidden="true"><svg viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}">'
            f'<g data-layer="illus_strip">{svg}</g></svg></div>')


# The header's second column is as wide as the big numbers' box (bignums.width), which sizes each number to its cell. Then the
# map, the gap and the bars; the accent's legend line (accent_key) after the year, its swatch in the accent.
CSS = """.illus-strip{width:1140px;margin:0 0 24px}.illus-strip svg{display:block}""" + """.hero.column{position:relative;width:1140px;margin:8px 0 30px}.hero.column .cu{font:400 12px/17px var(--sans);color:var(--t-sec);margin-bottom:6px}""" + \
    ".hero.column .cm{display:flex;gap:%dpx;align-items:flex-start}.hero.column .cm svg{flex:none}" % MAP_GAP + \
    ".hero.column .ak{margin-left:16px;color:var(--t-body)}.hero.column .ak::before{content:'';display:inline-block;width:9px;height:9px;margin-right:5px;background:var(--accent);vertical-align:0}"
