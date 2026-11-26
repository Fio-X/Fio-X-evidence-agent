"""winners_losers layer: the winners and the losers of one shift, side by side, in line.py's layer style: two columns, the rising
one first, each under its title on a thick rule; a row per measure: its words (up to two lines), then its value before,
an arrow, its value after (bold) and, at the right, the change as the request words it. The rising column's rule and
after-values in the accent, the falling one's in ink (knob accent: which column takes it, or none). A row's two values
must print a rise in the rising column and a fall in the falling one: the leaf reads the direction off the printed
numbers and refuses a row in the wrong column.
Every printed number is a ledger entry printed with FX.entry; every word comes with the request as segments.

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs?,                                   # the picture's name, if any (the section usually names it)
  "up":   {"title": segs, "rows": [row, ...]},      # the measures that rose, in layer 1's order
  "down": {"title": segs, "rows": [row, ...]},      # the measures that fell
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
row: {"label": segs,                                # the measure's words, its unit and its periods (period entries as {"src"})
      "a": ledger src, "b": ledger src,             # its value before and after as printed (each text a number)
      "change": segs?}                              # the change as printed: a ratio or a difference fact and its words
segs: as wbkit.segs reads them; ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): ratio_<row> (after over
before, "x times"), cut_<row> / rise_<row> (the change in percent or points), each with its own ledger entry.
needs new wording: none fixed; the column titles ("rising", "falling") come from the data as segments.
Refuses: a column with no rows, a value text that is no number, a row in the rising column that does not rise or in the
falling column that does not fall, a label over two lines, a digit in a literal word, a text that leaves the picture or
overlaps another, a board too narrow (a column under 300 px)."""
import re

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "winners_losers"
prod.KNOBS[NODE] = dict(
    size=(13, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name and column title size px"),
    value_size=(18, (12, 26, 1), "before and after value size px"), width=(1140, (480, 1400, 10), "picture width in px"),
    gutter=(48, (24, 96, 4), "space between the two columns in px"),
    accent=("up", ("up", "down", "none"), "the column whose rule and after-values take the accent"))

NUM = re.compile(r"[-−]?[0-9][0-9,]*(?:\.[0-9]+)?%?")


def number(src, what):
    """The number a ledger entry prints; a text that is no number refuses."""
    text = FX.text(src).strip()
    if not NUM.fullmatch(text): raise Refused(f"winners_losers: {what} {text!r} ({src}) is no number")
    return float(text.replace(",", "").replace("−", "-").rstrip("%"))


def pieces(v, what):
    return [(t, s) for t, s in K.segs(v, what)]


def inline(B, ps, x, y, size, fill, anchor="start", weight=400, tag="text"):
    """One <text> of (text, src) pieces: an entry marked with its src, words escaped; its box checked in B."""
    inner = "".join(FX.entry(s, "tspan", None) if s else esc(t) for t, s in ps)
    return K.txt(B, x, y, size, fill, inner, tw("".join(t for t, _ in ps), size), anchor=anchor, weight=weight, tag=tag)


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        f.col_w = (f.W - 16 - k("gutter")) / 2
        if f.col_w < 300: raise Refused("winners_losers: the board is too narrow (a column under 300 px)")
        f.cols = []
        for side, sign in (("up", 1), ("down", -1)):
            c = d.get(side)
            if not isinstance(c, dict) or not isinstance(c.get("rows"), list) or not c["rows"]: raise Refused(f"winners_losers: the {side} column holds no rows")
            K.segs(c.get("title"), f"the {side} column's title")
            rows = []
            for i, r in enumerate(c["rows"]):
                what = f"{side} row {i + 1}"
                if not isinstance(r, dict) or not r.get("a") or not r.get("b"): raise Refused(f"winners_losers: {what} lacks a value's ledger entry (a, b)")
                a, b = number(r["a"], f"{what}'s before"), number(r["b"], f"{what}'s after")
                if (b - a) * sign <= 0: raise Refused(f"winners_losers: {what} goes from {FX.text(r['a'])} to {FX.text(r['b'])}; it does not {'rise' if sign > 0 else 'fall'}")
                K.segs(r.get("label"), f"{what}'s label")
                if r.get("change") is not None: K.segs(r["change"], f"{what}'s change")
                rows.append(dict(r, what=what))
            f.cols.append(dict(side=side, title=c["title"], rows=rows))
        f.H = 0


def _arrow(x0, x1, y, stroke):
    return (f'<path d="M{x0:.1f} {y:.1f} H{x1:.1f} M{x1 - 5:.1f} {y - 4:.1f} L{x1:.1f} {y:.1f} L{x1 - 5:.1f} {y + 4:.1f}" fill="none" '
            f'stroke="{stroke}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>')


def cl_winners_losers(f, occ):
    d, size, W, vs = f.d, f.size, f.W, f.k("value_size")
    B = K.Boxes(W, 10 ** 6); o = []
    ts = f.k("title_size")
    y0 = 22
    if d.get("title"):
        o.append(K.words(B, d["title"], "title", 8, y0, ts, "var(--t-title)", weight=700, max_w=W - 16)[0])
        y0 += ts * 1.8
    bottoms = []
    for j, c in enumerate(f.cols):
        x0 = 8 + j * (f.col_w + f.k("gutter"))
        x1 = x0 + f.col_w
        hot = f.k("accent") == c["side"]
        ink = "var(--accent)" if hot else "var(--t-title)"
        o.append(K.words(B, c["title"], f"{c['side']} title", x0, y0, ts, ink, weight=700, max_w=f.col_w)[0])
        o.append(f'<rect x="{x0:.1f}" y="{y0 + ts * 0.45:.1f}" width="{f.col_w:.1f}" height="3" fill="{ink}" data-part="rule {c["side"]}"/>')
        y = y0 + ts * 0.45 + 3 + size * 1.6
        for r in c["rows"]:
            svg_l, _, n = K.words(B, r["label"], f"{r['what']} label", x0, y, size, "var(--t-body)", max_w=f.col_w, max_lines=2)
            o.append(svg_l)
            y += size * 1.3 * (n - 1) + vs * 1.35
            a_t, b_t = FX.text(r["a"]), FX.text(r["b"])
            aw, bw = tw(a_t, vs), tw(b_t, vs)
            o.append(K.txt(B, x0, y, vs, "var(--t-sec)", FX.entry(r["a"], "tspan", None), aw, tag=f"{r['what']} before"))
            ax0 = x0 + aw + 8
            o.append(_arrow(ax0, ax0 + 22, y - vs * 0.32, "var(--t-sec)"))
            o.append(K.txt(B, ax0 + 30, y, vs, ink, FX.entry(r["b"], "tspan", None), bw, weight=700, tag=f"{r['what']} after"))
            if r.get("change"):
                ps = pieces(r["change"], f"{r['what']}'s change")
                o.append(inline(B, ps, x1, y, size, "var(--t-title)", anchor="end", weight=700, tag=f"{r['what']} change"))
            y += size * 0.9
            o.append(K.line(x0, y, x1, y, stroke="var(--t-sec)", w=0.6, op=0.35))
            y += size * 1.6
        bottoms.append(y)
    y = max(bottoms) - size * 0.6
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"winners_losers: lines is {lns!r}; lines is a list of segment lists")
    for i, ln in enumerate(lns):
        y += size * 1.5
        o.append(K.words(B, ln, f"line {i + 1}", 8, y, size, "var(--t-sec)", max_w=W - 16)[0])
    if d.get("footnote"):
        y += size * 1.5
        o.append(K.words(B, d["footnote"], "footnote", 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0_, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


WINNERS_LOSERS_LAYERS = dict(winners_losers=(cl_winners_losers, None))
WINNERS_LOSERS_SVG = ["winners_losers"]


def draw(h):
    f = Frame(h)
    inner = cl_winners_losers(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "winners_losers"), f.W, f.H
