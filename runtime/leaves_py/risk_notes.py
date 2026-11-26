"""risk_notes layer: the short list under the page of what its numbers do not tell the reader (a scenario is no forecast,
a sequence no cause, a figure provisional): an optional kicker, the list's title in bold, then one item per caveat, each
behind a small round bullet in the secondary ink and wrapped in the body ink to a few lines. Every word comes in the
request as segs, every number in them is a ledger entry printed with FX.entry; the leaf holds no word of its own.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.risk_notes, run.py leaf): {
  "kicker": segs?,                                  # a short word over the title
  "title": segs,                                    # the list's title
  "items": [segs, ...],                             # one to six caveats, in layer 1's order; their numbers ledger srcs
  "footnote": segs?}                                # a line under the list
segs: as wbkit.segs reads them; ledger src: a row {"src", "text"}.
needs I4 facts: none of its own (a caveat's number, such as the latest year with every series final, is a ledger entry the
request names, period:<table>:<period> or fact:<k>).
needs new wording: the kicker, the title and every caveat come from the request.
Placement stacks by construction: the kicker, the title, then each item under the one before, its bullet at the left of its
first line; every text box is checked in wbkit.Boxes (outside the picture or over another refuses).
Refuses: no title, no items or more than six, an item that is no segment list, a digit in a literal word, a src the ledger
lacks, an item longer than knob item_lines lines, a title longer than one line, a text that leaves the picture or
overlaps another."""

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "risk_notes"
prod.KNOBS[NODE] = dict(
    size=(14, (11, 18, 0.5), "item size px (11 is the page floor)"), title_size=(18, (13, 26, 1), "title size px"),
    width=(640, (360, 1400, 10), "picture width in px"),
    item_lines=(3, (1, 5, 1), "lines an item may take; more refuses"),
    item_gap=(8, (2, 20, 1), "space between two items in px"),
    bullet=(2.5, (1.5, 4, 0.5), "a bullet's radius in px"))

MAX_ITEMS = 6  # a short list: more caveats than this belong in the page's text, not under it


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        if not d.get("title"): raise Refused("risk_notes: the spec holds no title")
        items = d.get("items")
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_ITEMS:
            raise Refused(f"risk_notes: {len(items) if isinstance(items, list) else items!r} items; one to {MAX_ITEMS} are drawn")
        for i, it in enumerate(items): K.segs(it, f"item {i + 1}")
        for key in ("kicker", "title", "footnote"):
            if d.get(key): K.segs(d[key], key)
        f.items, f.H = items, 0


def cl_risk_notes(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = []
    tsz = f.k("title_size")
    y = 4
    if d.get("kicker"):
        y += size
        o.append(K.words(B, d["kicker"], "kicker", 8, y, size, "var(--t-sec)", weight=700, max_w=W - 16)[0])
        y += size * 0.5
    y += tsz
    o.append(K.words(B, d["title"], "title", 8, y, tsz, "var(--t-title)", weight=700, serif=True, max_w=W - 16)[0])
    y += tsz * 0.6
    lh, r, x = size * 1.6, f.k("bullet"), 8 + 16
    for i, it in enumerate(f.items):
        y += size * 1.2
        o.append(f'<circle cx="{8 + r + 2:.1f}" cy="{y - size * 0.35:.1f}" r="{r}" fill="var(--t-sec)"/>')
        svg, _, n = K.words(B, it, f"item {i + 1}", x, y, size, "var(--t-body)", max_w=W - 8 - x, line_h=lh, max_lines=f.k("item_lines"))
        o.append(svg)
        y += lh * (n - 1) + f.k("item_gap")
    if d.get("footnote"):
        y += size * 1.4
        o.append(K.words(B, d["footnote"], "footnote", 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


RISK_NOTES_LAYERS = dict(risk_notes=(cl_risk_notes, None))
RISK_NOTES_SVG = ["risk_notes"]


def draw(h):
    f = Frame(h)
    inner = cl_risk_notes(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "risk_notes"), f.W, f.H
