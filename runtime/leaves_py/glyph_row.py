"""glyph_row layer: a row of at most fifteen shapes (circles, or half discs standing on one base line) whose AREA is the value, in
change_dots.py's layer style. It answers "how much bigger" without an axis: a glyph's diameter is max_d times the square root of its
value over the largest (the value itself never sets a length), so twice the value is twice the ink. A value of zero draws a point.
The value is printed inside its glyph when the text fits there (wbkit.tw), else right under it; the names stand under the row. One
accent: the item the data names (data "accent", one code) or the one the accent_one knob picks (the largest, the smallest, a code,
or none); every other glyph is grey. An optional reference (data "ref": the whole or the target) is an outlined ghost glyph of its
own area at the row's end, its words from the data. The leaf recomputes every size from the cited values and refuses a spec whose
hand-set size (an item's "d") gives another area ratio than the values do. Every printed number is a ledger entry printed with
FX.entry; every name is the request's label marked with its name row, or the data's own segments.

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs, "unit": segs,                      # the measure's name and unit, once, in the head
  "name_kind": "place" | <kind>?,                   # how an item's name is looked up from its code (default place)
  "items": [{"code": code,                          # an item (a member or a group); its id, and its name unless "name" is given
             "name": segs?,                         # the item's name as segments (else the request's label for the code)
             "value": series src | fact src,        # its value (geometry only): a cell of the request's rows, or a derived
                                                    # fact's bare number in the ledger (fact:<k>.n)
             "text": ledger src,                    # its value as printed
             "d": number?}],                        # a hand-set diameter (px at max_d): checked against the values, never drawn
  "scale": number?,                                 # a printed number is the value times scale (default 1)
  "ref": {"value": src, "text": ledger src, "label": segs}?,   # the reference drawn as an outlined ghost glyph
  "accent": code?,                                  # the item drawn in the accent (at most one)
  "omit": segs?, "footnote": segs?}                 # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): each item's value as printed
(a group's value is a derived fact, e.g. a mean over the group's members, its bare number as fact:<k>.n), the reference's value.
needs new wording: none fixed; the names, the reference's words and the lines come from the data as segments.
Refuses: fewer than two items or more than fifteen, an item twice, a code that is no code, an item without a value or a printed
text, a value src that is neither a series of the request nor a fact whose ledger text is a number, a negative value, every value
zero, a printed text that is no number or not the value (as rounded), a hand-set size whose area ratio is not the values', the
smallest glyph under six px across (the values too skewed for area), an accent that is no item or more than one, a value that
must print inside and does not fit, a row too wide for the board, a digit in a literal word, a text that leaves the picture or
overlaps another."""
import math
import re

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "glyph_row"
ITEMS_MIN, ITEMS_MAX = 2, 15
MIN_D = 6.0      # the smallest glyph a reader still compares (px across); a value of zero draws a point instead
POINT_R = 1.6
TOL = 0.01       # the relative slack of a hand-set size's area ratio against the values'
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (360, 1400, 10), "picture width in px"),
    shape=("circle", ("circle", "semicircle"), "the glyph: a circle, or a half disc standing on the base line"),
    max_d=(110, (40, 220, 2), "diameter px of the largest glyph (the largest value, or the reference when it is larger)"),
    accent_one=("", None, "the one glyph in the accent: empty = the data's accent; max, min, none, or an item's code"),
    value_inside=("auto", ("auto", "inside", "below"), "where a value prints: inside when it fits else below, always inside (refuses), always below"),
    gap=(16, (6, 48, 1), "space px between two glyphs' slots"),
    sort=("given", ("given", "value"), "item order: as given, or by value with the largest first"))

NUM = re.compile(r"[-−]?[0-9][0-9,]*(?:\.([0-9]+))?%?")


def printed(text):
    """(number, decimals) of a printed value text; None when the text is no plain number."""
    m = NUM.fullmatch(text.strip())
    if not m: return None
    return float(text.strip().replace(",", "").replace("−", "-").rstrip("%")), len(m.group(1) or "")


def value_of(src, what):
    """An item's value: a series cell of the request (wbkit.val), or a fact whose ledger text is a plain number (the derived fact's bare number)."""
    if isinstance(src, str) and src.startswith("series:"): return K.val(src)
    if isinstance(src, str) and src.startswith("fact:"):
        p = printed(FX.text(src))
        if p is None: raise Refused(f"glyph_row: {what}'s value {src} prints {FX.text(src)!r}, no number")
        return p[0]
    raise Refused(f"glyph_row: {what}'s value {src!r} is neither a series of the request nor a fact")


def check_text(src, v, scale, what):
    """The printed text is the value (times scale) as rounded to its own decimals; anything else refuses."""
    t = FX.text(src); p = printed(t)
    if p is None: raise Refused(f"glyph_row: {what}'s printed value {t!r} ({src}) is no number")
    n, dec = p
    if abs(n - v * scale) > 0.5 * 10 ** -dec + 1e-9 * max(1.0, abs(v * scale)):
        raise Refused(f"glyph_row: {what} prints {t!r} ({src}), its value is {v * scale:g}")


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        K.segs(d.get("title"), "title"); K.segs(d.get("unit"), "unit")
        kind = d.get("name_kind", "place")
        items = d.get("items")
        if not isinstance(items, list) or not ITEMS_MIN <= len(items) <= ITEMS_MAX:
            raise Refused(f"glyph_row: the spec holds {len(items) if isinstance(items, list) else 'no'} items; it draws {ITEMS_MIN} to {ITEMS_MAX}")
        codes = [i.get("code") if isinstance(i, dict) else None for i in items]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"glyph_row: the items' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"glyph_row: the items {twice} come twice")
        scale = d.get("scale", 1)
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not scale > 0: raise Refused(f"glyph_row: scale {scale!r} is no number above 0")
        f.items = []
        for it in items:
            c = it["code"]
            if not it.get("value") or not it.get("text"): raise Refused(f"glyph_row: item {c} lacks a value or its printed text")
            v = value_of(it["value"], f"item {c}")
            if not math.isfinite(v) or v < 0: raise Refused(f"glyph_row: item {c}'s value {v:g} is negative; an area holds no negative value")
            check_text(it["text"], v, scale, f"item {c}")
            if "name" in it:
                K.segs(it["name"], f"item {c}'s name"); nm = (None, K.plain(it["name"], f"item {c}'s name"))
            else: nm = K.named(c, kind)
            f.items.append(dict(code=c, v=v, t=K.ent(it["text"]), name=nm, segs=it.get("name"), hand=it.get("d")))
        f.ref = None
        ref = d.get("ref")
        if ref is not None:
            if not isinstance(ref, dict) or not ref.get("value") or not ref.get("text") or not ref.get("label"):
                raise Refused("glyph_row: ref needs its value, its printed text and its label")
            rv = value_of(ref["value"], "the reference")
            if not math.isfinite(rv) or rv < 0: raise Refused(f"glyph_row: the reference's value {rv:g} is negative")
            check_text(ref["text"], rv, scale, "the reference")
            K.segs(ref["label"], "the reference's label")
            f.ref = dict(code="ref", v=rv, t=K.ent(ref["text"]), name=(None, K.plain(ref["label"], "the reference's label")), segs=ref["label"], hand=None)
        everything = f.items + ([f.ref] if f.ref else [])
        f.v_max = max(i["v"] for i in everything)
        if f.v_max <= 0: raise Refused("glyph_row: every value is zero; there is no area to compare")
        # the accent: the knob's pick over the data's
        acc = d.get("accent")
        if isinstance(acc, list):
            if len(acc) > 1: raise Refused("glyph_row: accent names more than one item; one glyph takes the accent")
            acc = acc[0] if acc else None
        if acc is not None and acc not in codes: raise Refused(f"glyph_row: accent names {acc!r}, no item")
        pick = k("accent_one")
        if pick == "max": acc = max(f.items, key=lambda i: (i["v"], i["code"]))["code"]
        elif pick == "min": acc = min(f.items, key=lambda i: (i["v"], i["code"]))["code"]
        elif pick == "none": acc = None
        elif pick:
            if pick not in codes: raise Refused(f"glyph_row: knob accent_one names {pick!r}, no item")
            acc = pick
        f.acc = acc
        if k("sort") == "value": f.items.sort(key=lambda i: (-i["v"], i["code"]))
        # hand-set sizes: each must give the values' area ratio at max_d
        md = k("max_d")
        for i in f.items:
            if i["hand"] is None: continue
            hd = i["hand"]
            if isinstance(hd, bool) or not isinstance(hd, (int, float)) or hd < 0: raise Refused(f"glyph_row: item {i['code']}'s size {hd!r} is no diameter")
            got, want = (hd / md) ** 2, i["v"] / f.v_max
            if abs(got - want) > TOL * max(want, 1e-9) and abs(hd - md * math.sqrt(want)) > 0.5:
                raise Refused(f"glyph_row: item {i['code']}'s hand-set size {hd:g} px gives an area {got:.3f} of the largest, the cited values give {want:.3f}; "
                              "sizes are worked out from the values")
        # the smallest glyph: under MIN_D px the values are too skewed to compare by area
        pos = [i["v"] for i in everything if i["v"] > 0]
        small = md * math.sqrt(min(pos) / f.v_max)
        if small < MIN_D:
            raise Refused(f"glyph_row: the smallest glyph would be {small:.1f} px across (under {MIN_D:g} px): the largest value is "
                          f"{f.v_max / min(pos):.0f} times the smallest, too skewed for an area; bars or a log scale read it")
        f.D, f.stagger = f.fit(md)
        f.slots = f.layout(f.D, f.stagger)[1]
        f.H = 0

    def dia(f, i, D):
        return D * math.sqrt(i["v"] / f.v_max)

    def inside_fits(f, i, D):
        """Whether the value's text fits inside the glyph with a little room: a circle's text box centred; a half disc's on its base."""
        r = f.dia(i, D) / 2 - 1.5
        w, h = tw(i["t"][1], f.size) + 4, f.size * 1.05
        if r <= 0: return False
        if f.k("shape") == "circle": return (w / 2) ** 2 + (h / 2) ** 2 <= r * r
        return (w / 2) ** 2 + (h + 3) ** 2 <= r * r

    def layout(f, D, stagger):
        """(right edge, [(item, diameter, inside?, centre x)]) of the row at a largest diameter D, left to right from x 8; the reference
        stands last, a gap further off. A slot is as wide as its glyph and its value printed under it; a name is as wide as its slot,
        or, with the names staggered on two lines, clear of the name two slots back (the one on its line)."""
        mode, size, gap, out = f.k("value_inside"), f.size, f.k("gap"), []
        right = 8.0 - gap
        for n, i in enumerate(f.items + ([f.ref] if f.ref else [])):
            dd = f.dia(i, D)
            ins = mode != "below" and i["v"] > 0 and f.inside_fits(i, D)
            if mode == "inside" and not ins:
                raise Refused(f"glyph_row: the value {i['t'][1]!r} of {i['code']} does not fit inside its {dd:.0f} px glyph (knob value_inside is inside)")
            nw = tw(i["name"][1], size)
            w = max(dd, 0 if ins else tw(i["t"][1], size), 0 if stagger else nw)
            cx = right + gap + (gap if i is f.ref else 0) + w / 2
            cx = max(cx, 8 + nw / 2)
            if stagger and n >= 2:
                j = out[n - 2]; cx = max(cx, j[3] + (tw(j[0]["name"][1], size) + nw) / 2 + gap / 2)
            right = max(cx + w / 2, cx + nw / 2) if not stagger else cx + w / 2
            out.append((i, dd, ins, cx))
        edge = max(max(cx + max(dd, tw(i["name"][1], size), 0 if ins else tw(i["t"][1], size)) / 2 for i, dd, ins, cx in out), right)
        return edge, out

    def fit(f, md):
        """(largest diameter at most max_d whose row fits the board, names staggered?): the names on one line unless staggering
        them on two lets the glyphs be a fifth larger or more."""
        room = f.W - 8
        def best(stagger):
            if f.layout(md, stagger)[0] <= room: return md
            lo, hi = 0.0, md
            for _ in range(40):
                mid = (lo + hi) / 2
                if f.layout(mid, stagger)[0] <= room: lo = mid
                else: hi = mid
            return lo if f.layout(lo, stagger)[0] <= room else 0.0
        plain = best(False)
        st = best(True) if plain < md else 0.0
        D, stagger = (plain, False) if plain >= 0.8 * st else (st, True)
        if D * math.sqrt(min(i["v"] for i in f.items + ([f.ref] if f.ref else []) if i["v"] > 0) / f.v_max) < MIN_D:
            raise Refused(f"glyph_row: the row of {len(f.items)} glyphs with their names does not fit the {f.W:.0f} px board; fewer items or a wider picture")
        return D, stagger


def glyph(shape, cx, base, dd, fill, stroke, code, dash=False):
    """One glyph standing on the base line: a circle, or a half disc (flat side down); its area is the value's."""
    r = dd / 2
    st = f' stroke="{stroke}" stroke-width="1.2"' + (' stroke-dasharray="4 3"' if dash else "") if stroke else ""
    if shape == "circle":
        return f'<circle cx="{cx:.2f}" cy="{base - r:.2f}" r="{r:.3f}" fill="{fill}"{st} data-code="{esc(code)}" data-glyph="circle"/>'
    return (f'<path d="M{cx - r:.2f},{base:.2f} A{r:.3f},{r:.3f} 0 0 1 {cx + r:.2f},{base:.2f} Z" fill="{fill}"{st} '
            f'data-code="{esc(code)}" data-glyph="semicircle" data-r="{r:.3f}"/>')


def cl_glyph_row(f, occ):
    d, size, W, shape = f.d, f.size, f.W, f.k("shape")
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    tall = f.D if shape == "circle" else f.D / 2
    base = 22 + size * 1.6 + tall
    below = any(not ins for i, dd, ins, _ in f.slots)
    y1 = base + 6 + size                     # the first line under the base line: the values printed below (when any), else the names
    yn = y1 + size * 1.4 if below else y1    # the names' line (the odd items' one line lower when the names are staggered)
    for n, (i, dd, ins, cx) in enumerate(f.slots):
        whole = i is f.ref
        hot = i["code"] == f.acc and not whole
        fill = "none" if whole else "var(--accent)" if hot else "var(--bar)"
        if i["v"] == 0:
            o.append(f'<circle cx="{cx:.2f}" cy="{base - POINT_R:.2f}" r="{POINT_R}" fill="var(--t-sec)" data-code="{esc(i["code"])}" data-glyph="point"/>')
        else:
            o.append(glyph(shape, cx, base, dd, fill, "var(--t-sec)" if whole else None, i["code"], dash=whole))
        t_svg, t_txt = i["t"]
        if ins:
            ty = base - dd / 2 + size * 0.35 if shape == "circle" else base - 3 - size * 0.25
            ink = "var(--t-sec)" if whole else "var(--bg)" if hot else "var(--t-dark)"
            o.append(K.txt(B, cx, ty, size, ink, t_svg, tw(t_txt, size), anchor="middle", weight=700, tag=f"value {i['code']} inside"))
        else:
            o.append(K.txt(B, cx, y1, size, "var(--accent)" if hot else "var(--t-sec)" if whole else "var(--t-body)", t_svg, tw(t_txt, size),
                           anchor="middle", weight=700, tag=f"value {i['code']} below"))
        ink = "var(--accent)" if hot else "var(--t-sec)" if whole else "var(--t-body)"
        ny = yn + size * 1.4 * (f.stagger and n % 2)
        if i["segs"] is not None:
            o.append(K.words(B, i["segs"], f"name {i['code']}", cx, ny, size, ink, anchor="middle", weight=700 if hot else 400, italic=whole)[0])
        else:
            nm_svg, nm = i["name"]
            o.append(K.txt(B, cx, ny, size, ink, nm_svg, tw(nm, size), anchor="middle", weight=700 if hot else 400, tag=f"name {i['code']}"))
    # the leaf's own recount: every drawn glyph's area over the largest's is its value over the largest value
    for i, dd, _, _ in f.slots:
        if i["v"] > 0 and abs((dd / f.D) ** 2 - i["v"] / f.v_max) > 1e-9: raise Refused(f"glyph_row: glyph {i['code']}'s area is not its value's share")
    y = yn + size * 1.4 * (f.stagger and len(f.slots) > 1)
    for n, key in enumerate(k for k in ("omit", "footnote") if d.get(k)):
        y += size * (2.0 if n == 0 else 1.5)
        o.append(K.words(B, d[key], key, 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1_), tag in B.b:  # the final height: every text inside the picture
        if y1_ > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


GLYPH_ROW_LAYERS = dict(glyph_row=(cl_glyph_row, None))
GLYPH_ROW_SVG = ["glyph_row"]


def draw(h):
    f = Frame(h)
    inner = cl_glyph_row(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "glyph_row"), f.W, f.H
