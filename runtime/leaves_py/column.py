"""The column page's leaf nodes (knobs.py RECIPES column): the big numbers, an html layer in the page's header, and one bar
per ranked place, an svg layer that is the page's picture; both over one frame (ColumnFrame). A column page prints from a
ledger only: every number is an entry (facts.entry), the bars' values the family hero.data.family (<family>.<code>), the
big numbers the facts hero.data names (hi, lo, gap, times), each name the request's label marked with its name row. Raw
row values drive the bars' lengths only."""
import html, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts as FX
import prod
from words import word


class ColumnFrame:
    """What the column layers share: the ranked places (layer 1's order, kept as given) with their raw values at the year,
    the marked ones, and the picture's size (the page's width, the rows' height). A place with no row at the year, a value
    below 0 or none above it refuses: the bars start at 0."""
    def __init__(f, c, h):
        if FX.LEDGER is None: raise FX.Refused("column: the page prints from a ledger only")
        d = h["data"]; K = lambda k: prod.knob(h, "bars", k)
        f.c, f.h, f.d = c, h, d
        f.table = d.get("table") or next(iter(c.spec["tables"]))
        by, year = prod.need(d, "by"), str(prod.need(d, "year"))
        at = {r[by]: float(r["OBS_VALUE"]) for r in c.T[f.table] if r["TIME_PERIOD"] == year and by in r}
        off = [k for k in d["ranked"] if k not in at]
        if off: raise FX.Refused(f"bars: no row at {year} for {', '.join(off)}")
        f.vals = [(k, at[k]) for k in d["ranked"]]
        if not f.vals or min(v for _, v in f.vals) < 0 or max(v for _, v in f.vals) <= 0:
            raise FX.Refused("bars: the values are not all 0 or more with one above 0")
        f.year, f.marks, f.size, f.rh = year, set(d.get("marks") or []), K("size"), K("row")
        f.W = 1140
        f.lw = max(prod.tw(prod.NAME(k), f.size) for k, _ in f.vals) + 12  # the names' column, right-aligned to the bars
        f.vw = max(prod.tw(FX.text(val_src(d, k)), f.size) for k, _ in f.vals) + 8  # room after the longest bar for its value
        f.top = K("top")
        f.H = f.top + f.rh * len(f.vals) + 4


def val_src(d, code):
    """The ledger entry a bar's value prints: the family's member's bare number."""
    return f"fact:{prod.need(d, 'family')}.{code}.n"


def html_named(code):
    """A place's name in html, marked with its name row (as prod.named marks it in svg)."""
    return f'<span data-src="{html.escape(prod.name_src(code))}">{html.escape(prod.NAME(code))}</span>'


def cl_bars(f, occ):
    """One bar per ranked place, largest first: the name before it, the value after it; a marked place in the accent."""
    o, mx, bw = [], max(v for _, v in f.vals), f.W - f.lw - f.vw
    o.append(f'<line x1="{f.lw:.1f}" x2="{f.lw:.1f}" y1="{f.top}" y2="{f.top + f.rh * len(f.vals)}" stroke="var(--t-sec)" stroke-width="0.8"/>')
    for i, (k, v) in enumerate(f.vals):
        y, w, hi = f.top + i * f.rh, v / mx * bw, k in f.marks
        ink, weight = ("var(--t-title)", 700) if hi else ("var(--t-body)", 400)
        mid = y + f.rh / 2
        o.append(f'<text x="{f.lw - 8:.1f}" y="{mid:.1f}" text-anchor="end" dominant-baseline="middle" font-size="{f.size}" fill="{ink}" font-weight="{weight}">{prod.named(k)}</text>'
                 f'<rect x="{f.lw:.1f}" y="{y + 3:.1f}" width="{w:.1f}" height="{f.rh - 6}" fill="{"var(--accent)" if hi else "var(--bar)"}"/>'
                 f'<text x="{f.lw + w + 6:.1f}" y="{mid:.1f}" dominant-baseline="middle" font-size="{f.size}" fill="{"var(--accent)" if hi else "var(--t-sec)"}" font-weight="{weight}">{FX.entry(val_src(f.d, k), "tspan", None)}</text>')
    return "".join(o)


prod.KNOBS["bars"] = dict(row=(24, (16, 40, 1), "row height of one bar"), size=(13, (9, 18, 0.5), "font size of the names and values"),
                          top=(6, (0, 40, 1), "space above the first bar"))


prod.KNOBS["bignums"] = dict(size=(36, (28, 64, 2), "number size in px"), label_lines=(2, (1, 3, 1), "lines a label may take; more refuses"),
                             align=("left", ("left", "center"), "alignment of the numbers"))


def trend(c, key):
    """The word ending for the change fact key, picked by the program from its sign, never by the request: ".fall" below 0,
    ".rise" above it, ".flat" when it prints as 0 (0, -0.0, or a change its ledger entry rounds to 0). A value that is no
    finite number refuses."""
    v = c.F[key]["v"]
    if not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")): raise FX.Refused(f"{key}: the change {v!r} is no number")
    shown = FX.text(f"fact:{key}.n") if FX.LEDGER is not None else str(v)
    if v == 0 or not re.sub(r"[^1-9]", "", shown): return ".flat"
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


def cl_bignums(f, occ):
    """The big numbers beside the title: each a fact the request names (hero.data.bignums, else hi, lo, gap, times), printed from its
    ledger entry; the size, the label lines and the alignment are knobs."""
    c, K = f.c, lambda k: prod.knob(f.h, "bignums", k)
    cells = bignum_cells(f)
    off = [k for k, lab in cells if len(re.sub(r"<[^>]+>", "", lab)) > K("label_lines") * 22]
    if off: raise FX.Refused(f"bignums: the label of {off[0]} is longer than {K('label_lines')} lines")
    st = f' style="--bn:{K("size")}px;text-align:{K("align")}"'
    return f'<div class="bns"{st}>' + "".join(f'<div class="bn"><div class="bv">{c.t("{" + k + "}")}</div><div class="bl">{lab}</div></div>' for k, lab in cells) + "</div>"


# name -> (draw, reserve); svg layers go into the picture, html layers sit in the page around it
COLUMN_LAYERS = dict(bignums=(cl_bignums, None), bars=(cl_bars, None))
COLUMN_SVG = ["bars"]


def column_shell(f, bars, unit):
    """The column hero around its drawn bars: the unit and year line over the picture's svg."""
    year = word("date.y", y=FX.entry(f"period:{f.table}:{f.year}", "span", None))
    return (f'<div class="hero column"><div class="cu">{unit}{word("list.sep")}{year}</div>'
            f'<svg class="bars" viewBox="0 0 {f.W} {f.H:.0f}" width="{f.W}" height="{f.H:.0f}">{bars}</svg></div>')


# The header gives the big numbers room for a unit in words (a gap in percentage points), so none runs past the page.
CSS = """.hero.column{position:relative;width:1140px;margin:8px 0 30px}.hero.column .cu{font:400 12px/17px var(--sans);color:var(--t-sec);margin-bottom:6px}
.hh{grid-template-columns:1fr 560px}.bns .bv{font-size:var(--bn,36px);line-height:1.2}.bns .bl span{color:var(--t-title)}"""
