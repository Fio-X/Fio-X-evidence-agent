"""change_dots layer: each member's value at two periods as two dots on one row joined by a line, the rows ordered by change
(the largest rise on top, the largest fall at the bottom), in small_multiples.py's layer style. It answers "who moved most":
the line's length is the change, its direction (the filled end dot right or left of the hollow start dot) the sign. One shared
value scale for every row; the start value is printed left of the row's left dot and the end value right of its right dot, so no
value sits on a line and no row has an axis number of its own (the picture holds no axis number: both ends of every row are
printed). One accent: the rows the data names (data "accent", at most two); the row of the whole (data "ref") is drawn bold in
ink. A picture of many members keeps the largest rises and the largest falls (layer 1 chooses the members, the leaf draws the
rows it is given); the words that say others are not drawn are the data's own line (data "omit"). Every printed number is a ledger
entry printed with FX.entry; every name is the request's label marked with its name row.

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs, "unit": segs,                      # the measure's name and unit, once, in the head
  "name_kind": "place" | <kind>?,                   # how a row's name is looked up (default place)
  "rows": [{"code": code,                           # a member (or the whole); its name is the request's label for the code
            "a": series src, "b": series src,       # its cells at the start and the end period (geometry only)
            "a_text": ledger src, "b_text": ledger src}],   # its two values as printed
  "periods": [ledger src, ledger src],              # period:<table>:<period> entries of the start and the end, for the key
  "accent": [code, ...]?,                           # rows drawn in the accent (at most two)
  "ref": code?,                                     # the row of the whole, drawn bold in ink
  "omit": segs?, "footnote": segs?}                 # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): each row's two values.
needs new wording: none fixed; the names, the key's words and the lines come from the data as segments.
Refuses: fewer than four rows, a row twice, a code that is no code, a row whose two cells are at one period or lack a ledger
entry, rows on other periods than the first row's, a period entry that is not the start's or the end's, an accent that is no row
or more than two, a ref that is no row, two cells of one row equal for every row (nothing moved), a digit in a literal word, a
text that leaves the picture or overlaps another, a board too narrow (plot under 200 px)."""
import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "change_dots"
ROWS_MIN = 4
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), row=(22, (18, 48, 1), "distance between two rows in px"),
    dot_r=(4.5, (3, 8, 0.5), "dot radius px"), line_w=(3, (1.5, 6, 0.5), "connector width px"),
    sort=("change", ("change", "given"), "row order: the change from the start to the end, largest rise first, or as given"))


def period_pair(src):
    """The period a series src names (series:<table>/<codes>:<period>:<column>)."""
    return K.period_of(src)


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        K.segs(d.get("title"), "title"); K.segs(d.get("unit"), "unit")
        kind = d.get("name_kind", "place")
        rows = d.get("rows")
        if not isinstance(rows, list) or len(rows) < ROWS_MIN: raise Refused(f"change_dots: the spec holds fewer than {ROWS_MIN} rows")
        codes = [r.get("code") if isinstance(r, dict) else None for r in rows]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"change_dots: the rows' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"change_dots: the rows {twice} come twice")
        f.rows, pa, pb = [], set(), set()
        for r in rows:
            a, b = K.val(r.get("a")), K.val(r.get("b"))
            if period_pair(r["a"]) == period_pair(r["b"]): raise Refused(f"change_dots: row {r['code']}'s two cells are at one period")
            if not r.get("a_text") or not r.get("b_text"): raise Refused(f"change_dots: row {r['code']} lacks a value's ledger entry")
            pa.add(period_pair(r["a"])); pb.add(period_pair(r["b"]))
            f.rows.append(dict(code=r["code"], a=a, b=b, at=K.ent(r["a_text"]), bt=K.ent(r["b_text"]), name=K.named(r["code"], kind)))
        if len(pa) != 1 or len(pb) != 1: raise Refused("change_dots: the rows are on other periods than the first row's")
        if all(r["a"] == r["b"] for r in f.rows): raise Refused("change_dots: no row moved between the two periods")
        per = d.get("periods")
        if not isinstance(per, list) or len(per) != 2: raise Refused("change_dots: the key needs the start and the end period entries")
        for src, held in zip(per, (pa, pb)):
            if not isinstance(src, str) or not src.startswith("period:"): raise Refused(f"change_dots: the period entry {src!r} is no period:<table>:<period>")
            if src.rsplit(":", 1)[1] not in held: raise Refused(f"change_dots: the period entry {src} names a period no row's cell has")
        f.periods = [K.ent(src) for src in per]
        acc = d.get("accent") or []
        if not isinstance(acc, list) or len(acc) > 2 or not all(isinstance(a, str) for a in acc): raise Refused("change_dots: accent is a list of at most two codes")
        if any(a not in codes for a in acc): raise Refused(f"change_dots: accent names {[a for a in acc if a not in codes]}, no row")
        f.acc = set(acc)
        f.ref = d.get("ref")
        if f.ref is not None and f.ref not in codes: raise Refused(f"change_dots: ref {f.ref!r} is no row")
        if k("sort") == "change": f.rows.sort(key=lambda r: (-(r["b"] - r["a"]), r["code"]))
        vals = [v for r in f.rows for v in (r["a"], r["b"])]
        f.lo_v, f.hi_v = min(vals), max(vals)
        zero = f.lo_v >= 0 and f.lo_v <= f.hi_v / 2   # a scale from 0 when the lowest is at most half the highest, else over the values' own range
        f.base = 0.0 if zero else f.lo_v - 0.05 * ((f.hi_v - f.lo_v) or abs(f.lo_v) or 1)
        if f.hi_v <= f.base: f.hi_v = f.base + 1
        size = f.size
        name_w = max(tw(r["name"][1], size) for r in f.rows)
        val_w = max(tw(t, size) for r in f.rows for _, t in (r["at"], r["bt"]))
        r0 = k("dot_r")
        f.x0 = 8 + name_w + 12 + val_w + 8 + r0       # names, then room for the start value left of a dot at the scale's foot
        f.x1 = f.W - 8 - val_w - 8 - r0               # room for an end value right of a dot at its top
        if f.x1 - f.x0 < 200: raise Refused("change_dots: the board is too narrow for the names, the values and the plot (plot under 200 px)")
        f.name_x = 8 + name_w
        f.H = 0

    def x(f, v):
        return f.x0 + (f.x1 - f.x0) * (v - f.base) / (f.hi_v - f.base)


def cl_change_dots(f, occ):
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
    top = ky + size * 1.5
    pitch = f.k("row")
    for i, r in enumerate(f.rows):
        hot, whole = r["code"] in f.acc, r["code"] == f.ref
        y = top + pitch * (i + 0.5)
        xa, xb = f.x(r["a"]), f.x(r["b"])
        ink = "var(--accent)" if hot else "var(--t-title)"
        nm_svg, nm = r["name"]
        o.append(K.txt(B, f.name_x, y + size * 0.35, size, "var(--accent)" if hot else "var(--t-title)" if whole else "var(--t-body)", nm_svg, tw(nm, size),
                       anchor="end", weight=700 if hot or whole else 400, tag=f"name {r['code']}"))
        o.append(f'<line x1="{xa:.1f}" y1="{y:.1f}" x2="{xb:.1f}" y2="{y:.1f}" stroke="{"var(--accent)" if hot else "var(--t-body)" if whole else "var(--bar)"}" '
                 f'stroke-width="{f.k("line_w")}" stroke-linecap="round" data-code="{esc(r["code"])}"/>')
        o.append(f'<circle cx="{xa:.1f}" cy="{y:.1f}" r="{r0}" fill="var(--bg)" stroke="var(--t-sec)" stroke-width="1.5" data-code="{esc(r["code"])}"/>')
        o.append(f'<circle cx="{xb:.1f}" cy="{y:.1f}" r="{r0}" fill="{ink}" data-code="{esc(r["code"])}"/>')
        # the values: the left dot's left of it, the right dot's right of it
        (l_svg, l_txt), (r_svg, r_txt) = (r["at"], r["bt"]) if xa <= xb else (r["bt"], r["at"])
        lx, rx = min(xa, xb) - r0 - 5, max(xa, xb) + r0 + 5
        o.append(K.txt(B, lx, y + size * 0.35, size, "var(--t-sec)", l_svg, tw(l_txt, size), anchor="end", tag=f"value {r['code']} left"))
        o.append(K.txt(B, rx, y + size * 0.35, size, ink if hot else "var(--t-body)", r_svg, tw(r_txt, size), weight=700 if hot or whole else 400,
                       tag=f"value {r['code']} right"))
    y = top + pitch * len(f.rows)
    for key, what, italic in (("omit", "omit", True), ("footnote", "footnote", True)):
        if d.get(key):
            y += size * 1.5
            o.append(K.words(B, d[key], what, 8, y, size, "var(--t-sec)", italic=italic, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


CHANGE_DOTS_LAYERS = dict(change_dots=(cl_change_dots, None))
CHANGE_DOTS_SVG = ["change_dots"]


def draw(h):
    f = Frame(h)
    inner = cl_change_dots(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "change_dots"), f.W, f.H
