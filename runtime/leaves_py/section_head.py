"""section_head layer: a section's head: a number word, the one-sentence headline and an intro card, in column.py's
layer style (the page head stays scmp.page_head). Words are SEGMENTS (wbkit.segs): literals without a digit
and ledger entries; the leaf holds no topic word.
hero.data: {"no": segs?, "headline": segs, "card": segs?}   segs = [{"w": ..} | {"src": ..} | {"word": key}]
Colours: the page's variables (--accent the number word, --t-title the headline, --t-title as the card's ground with --t-dark ink).
Refuses: no headline, a headline past title_lines, a card past dek_lines, a digit in a literal, a plain source string, a knob off its range."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
from wbkit import FX, prod, Refused, esc, tw

prod.KNOBS["section_head"] = dict(
    head_size=(28, (20, 44, 2), "section headline size px"), dek_size=(15, (12, 20, 1), "dek / card size px"),
    kicker_size=(12, (10, 14, 1), "number-word size px"), title_lines=(3, (1, 4, 1), "lines a headline may take"),
    dek_lines=(4, (1, 6, 1), "lines a card may take"), serif=("on", ("on", "off"), "serif headline"),
    align=("left", ("left", "center"), "alignment"), width=(1140, (320, 1400, 10), "picture width in px"))
NODE = "section_head"


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.W = d, k, k("width")
        if not d.get("headline"): raise Refused("section_head: the head has no headline")
        ctr = k("align") == "center"
        f.ctr, f.x0, f.anchor, f.maxw = ctr, f.W / 2 if ctr else 8, "middle" if ctr else "start", f.W - 16
        ks = k("kicker_size") + 2; hs = k("head_size"); ds = k("dek_size"); y = 14
        f.no_y = None
        if d.get("no"):
            K.segs(d["no"], "no"); f.no_y = y + ks; y += ks * 1.5
        f.hs, f.hy = hs, y + hs
        n = len(K.lay(K.segs(d["headline"], "headline"), hs, f.maxw))
        if n > k("title_lines"): raise Refused(f"section_head: the headline takes {n} lines, title_lines is {k('title_lines')}")
        y += hs + (n - 1) * hs * 1.2 + 14
        f.card = None
        if d.get("card"):
            cw = min(f.maxw, 560)
            m = len(K.lay(K.segs(d["card"], "card"), ds, cw - 28))
            if m > k("dek_lines"): raise Refused(f"section_head: the card takes {m} lines, dek_lines is {k('dek_lines')}")
            ch = (m - 1) * ds * 1.55 + ds + 28
            f.card = (f.x0 - cw / 2 if ctr else 8, y, cw, ch); y += ch + 12
        f.H = int(y + 6)


def cl_section_head(f, occ):
    d, k, B = f.d, f.k, K.Boxes(f.W, f.H); o = []
    if f.no_y is not None:
        o.append(K.words(B, d["no"], "no", f.x0, f.no_y, k("kicker_size") + 2, "var(--accent)", anchor=f.anchor, weight=700)[0])
    o.append(K.words(B, d["headline"], "headline", f.x0, f.hy, f.hs, "var(--t-title)", anchor=f.anchor, weight=700, serif=k("serif") == "on",
                     max_w=f.maxw, line_h=f.hs * 1.2, max_lines=k("title_lines"))[0])
    if f.card:
        cx, cy, cw, ch = f.card; ds = k("dek_size")
        o.append(f'<rect x="{cx:.1f}" y="{cy:.1f}" width="{cw:.1f}" height="{ch:.1f}" fill="var(--t-title)"/>')
        o.append(K.words(B, d["card"], "card", cx + 14, cy + 14 + ds, ds, "var(--t-dark)", max_w=cw - 28, line_h=ds * 1.55, max_lines=k("dek_lines"))[0])
    return "".join(o)


SECTION_HEAD_LAYERS = dict(section_head=(cl_section_head, None))
SECTION_HEAD_SVG = ["section_head"]


def draw(h):
    f = Frame(h)
    return K.svg(cl_section_head(f, prod.Occ()), f.W, f.H, "section_head"), f.W, f.H
