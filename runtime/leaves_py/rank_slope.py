"""rank_slope layer: every place's rank at two periods as two dots, each pair joined by a line (a slope chart: the start
ranks in a column on the left, the end ranks in a column on the right, the highest at the top), in change_dots.py's layer style.
It answers "who overtook whom": a line that runs down the picture's page is a place that fell behind, one that runs up a place
that passed others, and where two lines cross the two places swapped. The ranks are the places' values, highest first, at each
period; the leaf works them out from the series cells (geometry) and refuses a printed rank that is not the one the cells give,
so a rank on the page is a rank of the numbers. Places that tie share their rank number and keep a row of their own (by code).
Each end prints "<rank> <name>": the rank a ledger entry (the first layer's position fact), the name the request's label marked
with its name row. One accent: the rows the data names (data "accent", at most three); the row of the whole (data "ref") is drawn
bold in ink; every other line is a thin grey one. A line is a stroke, never under a text: the labels stand left of the left dots
and right of the right dots. Every printed number is a ledger entry printed with FX.entry.

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs, "unit": segs,                      # what is ranked, once, in the head
  "name_kind": "place" | <kind>?,                   # how a row's name is looked up (default place)
  "rows": [{"code": code,                           # a place (or the whole); its name is the request's label for the code
            "a": series src, "b": series src,       # its cells at the start and the end period (geometry only)
            "a_rank": ledger src, "b_rank": ledger src}],   # its rank at each period as printed (layer 1's position facts)
  "periods": [ledger src, ledger src],              # period:<table>:<period> entries of the start and the end, for the key
  "accent": [code, ...]?,                           # rows drawn in the accent (at most three)
  "accent_only": [code, ...]?,                      # of those, the ones that keep the accent colour; the others keep their
                                                    # label and stand over the plain lines, drawn plain (wbkit.accent_only)
  "ref": code?,                                     # the row of the whole, drawn bold in ink
  "footnote": segs?}                                # layer 1's line under the picture
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): each row's rank at the two periods
(op position over every place of the table, so the rows are all of them).
needs new wording: none fixed; the names, the key's words and the line come from the data as segments.
Refuses: fewer than four rows, a row twice, a code that is no code, a row whose two cells are at one period or lack a rank entry,
rows on other periods than the first row's, a printed rank that is not a whole number or not the rank the cells give, a period
entry that is not the start's or the end's, an accent that is no row or more than three, a ref that is no row, every place
holding the same rank at both periods (nothing overtook), a digit in a literal word, a text that leaves the picture or overlaps
another, a board too narrow (plot under 120 px)."""
import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "rank_slope"
ROWS_MIN = 4
DENSE = 15   # more rows than this: only the marked rows and the two ends of each column keep a label, the other lines are faint
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), row=(20, (16, 40, 1), "distance between two rows in px"),
    dot_r=(3, (2, 6, 0.5), "dot radius px"), line_w=(1.2, (0.8, 3, 0.1), "a plain line's width in px"),
    mark_w=(2.6, (1.5, 5, 0.1), "an accent line's width in px"))


def whole_number(src, what):
    """A printed rank as an integer; text that is no whole number refuses."""
    t = FX.text(src)
    if not t.isdigit(): raise Refused(f"rank_slope: {what}'s rank {t!r} ({src}) is no whole number")
    return int(t)


def ranks(vals):
    """{code: rank} highest first, a tie sharing the place (1 and the number of codes above it), as the first layer's position fact does."""
    return {c: 1 + sum(1 for w in vals.values() if w > v) for c, v in vals.items()}


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        K.segs(d.get("title"), "title"); K.segs(d.get("unit"), "unit")
        kind = d.get("name_kind", "place")
        rows = d.get("rows")
        if not isinstance(rows, list) or len(rows) < ROWS_MIN: raise Refused(f"rank_slope: the spec holds fewer than {ROWS_MIN} rows")
        codes = [r.get("code") if isinstance(r, dict) else None for r in rows]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"rank_slope: the rows' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"rank_slope: the rows {twice} come twice")
        f.rows, pa, pb = [], set(), set()
        for r in rows:
            va, vb = K.val(r.get("a")), K.val(r.get("b"))
            if K.period_of(r["a"]) == K.period_of(r["b"]): raise Refused(f"rank_slope: row {r['code']}'s two cells are at one period")
            if not r.get("a_rank") or not r.get("b_rank"): raise Refused(f"rank_slope: row {r['code']} lacks a rank's ledger entry")
            pa.add(K.period_of(r["a"])); pb.add(K.period_of(r["b"]))
            f.rows.append(dict(code=r["code"], va=va, vb=vb, ra=whole_number(r["a_rank"], r["code"]), rb=whole_number(r["b_rank"], r["code"]),
                               at=K.ent(r["a_rank"]), bt=K.ent(r["b_rank"]), name=K.named(r["code"], kind)))
        if len(pa) != 1 or len(pb) != 1: raise Refused("rank_slope: the rows are on other periods than the first row's")
        for side, key, vkey in (("start", "ra", "va"), ("end", "rb", "vb")):
            own = ranks({r["code"]: r[vkey] for r in f.rows})
            for r in f.rows:
                if r[key] != own[r["code"]]: raise Refused(f"rank_slope: row {r['code']}'s printed {side} rank {r[key]} is not the rank its cell gives ({own[r['code']]})")
        if all(r["ra"] == r["rb"] for r in f.rows): raise Refused("rank_slope: every place holds the same rank at both periods")
        per = d.get("periods")
        if not isinstance(per, list) or len(per) != 2: raise Refused("rank_slope: the key needs the start and the end period entries")
        for src, held in zip(per, (pa, pb)):
            if not isinstance(src, str) or not src.startswith("period:"): raise Refused(f"rank_slope: the period entry {src!r} is no period:<table>:<period>")
            if src.rsplit(":", 1)[1] not in held: raise Refused(f"rank_slope: the period entry {src} names a period no row's cell has")
        f.periods = [K.ent(src) for src in per]
        acc = d.get("accent") or []
        if not isinstance(acc, list) or len(acc) > 3 or not all(isinstance(a, str) for a in acc): raise Refused("rank_slope: accent is a list of at most three codes")
        if any(a not in codes for a in acc): raise Refused(f"rank_slope: accent names {[a for a in acc if a not in codes]}, no row")
        f.acc = set(acc)
        f.hot = K.accent_only("rank_slope", d, acc)
        f.ref = d.get("ref")
        if f.ref is not None and f.ref not in codes: raise Refused(f"rank_slope: ref {f.ref!r} is no row")
        # each column's order: by value (the rank), a tie by code, one row of its own to each place
        for key, vkey, slot in (("ra", "va", "sa"), ("rb", "vb", "sb")):
            for i, r in enumerate(sorted(f.rows, key=lambda r: (-r[vkey], r["code"]))): r[slot] = i
        size = f.size
        n = len(f.rows)
        f.dense = n > DENSE
        for r in f.rows:   # a dense chart names only what the data marks and the top and the bottom of either column
            r["lab"] = (not f.dense) or r["code"] in f.acc or r["code"] == f.ref or r["sa"] in (0, n - 1) or r["sb"] in (0, n - 1)
        f.lw = max(tw(r["name"][1], size) + tw(t, size) + 6 for r in f.rows if r["lab"] for t in (r["at"][1], r["bt"][1]))   # a label: rank, a space, the name
        f.x0 = 8 + f.lw + 10 + k("dot_r")
        f.x1 = f.W - 8 - f.lw - 10 - k("dot_r")
        if f.x1 - f.x0 < 120: raise Refused("rank_slope: the board is too narrow for the labels and the lines (plot under 120 px)")
        f.H = 0


def cl_rank_slope(f, occ):
    d, size, W, r0 = f.d, f.size, f.W, f.k("dot_r")
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    ky = 22 + size * 2.0
    (a_svg, a_txt), (b_svg, b_txt) = f.periods
    # the key: each column's period over it
    o.append(K.txt(B, f.x0 - r0 - 10, ky, size, "var(--t-sec)", a_svg, tw(a_txt, size), anchor="end", weight=700, tag="key start"))
    o.append(K.txt(B, f.x1 + r0 + 10, ky, size, "var(--t-sec)", b_svg, tw(b_txt, size), weight=700, tag="key end"))
    top = ky + size * 1.2
    pitch = f.k("row")
    yo = lambda slot: top + pitch * (slot + 0.5)
    ordered = sorted(f.rows, key=lambda r: (r["code"] in f.acc or r["code"] == f.ref, r["code"]))   # plain lines first, the marked ones over them
    for r in ordered:
        hot, whole = r["code"] in f.hot, r["code"] == f.ref
        ya, yb = yo(r["sa"]), yo(r["sb"])
        ink = "var(--accent)" if hot else "var(--t-title)" if whole else "var(--t-sec)"
        faint = f.dense and not (hot or whole or r["lab"])   # a middle line of a dense chart: a faint grey stroke
        op = 1 if hot or whole else 0.18 if faint else 0.6
        dim = ' fill-opacity="0.3"' if faint else ""
        o.append(f'<line x1="{f.x0:.1f}" y1="{ya:.1f}" x2="{f.x1:.1f}" y2="{yb:.1f}" stroke="{ink}" '
                 f'stroke-width="{f.k("mark_w") if hot or whole else f.k("line_w")}" stroke-opacity="{op}" stroke-linecap="round" '
                 f'data-code="{esc(r["code"])}"/>')
        o.append(f'<circle cx="{f.x0:.1f}" cy="{ya:.1f}" r="{r0}" fill="{ink}"{dim} data-code="{esc(r["code"])}"/>')
        o.append(f'<circle cx="{f.x1:.1f}" cy="{yb:.1f}" r="{r0}" fill="{ink}"{dim} data-code="{esc(r["code"])}"/>')
    for r in f.rows:
        if not r["lab"]: continue
        hot, whole = r["code"] in f.hot, r["code"] == f.ref
        fill = "var(--accent)" if hot else "var(--t-title)" if whole else "var(--t-body)"
        wt = 700 if hot or whole else 400
        nm_svg, nm = r["name"]
        (ra_svg, ra_t), (rb_svg, rb_t) = r["at"], r["bt"]
        ya, yb = yo(r["sa"]), yo(r["sb"])
        xl, xr = f.x0 - r0 - 8, f.x1 + r0 + 8
        # the start label, right-aligned against the left dots: the name, then the rank beside the dots; the end label mirrored
        o.append(K.txt(B, xl, ya + size * 0.35, size, fill, ra_svg, tw(ra_t, size), anchor="end", weight=wt, tag=f"start rank {r['code']}"))
        o.append(K.txt(B, xl - tw(ra_t, size) - 6, ya + size * 0.35, size, fill, nm_svg, tw(nm, size), anchor="end", weight=wt, tag=f"start name {r['code']}"))
        o.append(K.txt(B, xr, yb + size * 0.35, size, fill, rb_svg, tw(rb_t, size), weight=wt, tag=f"end rank {r['code']}"))
        o.append(K.txt(B, xr + tw(rb_t, size) + 6, yb + size * 0.35, size, fill, nm_svg, tw(nm, size), weight=wt, tag=f"end name {r['code']}"))
    y = top + pitch * len(f.rows)
    if d.get("footnote"):
        y += size * 1.5
        o.append(K.words(B, d["footnote"], "footnote", 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1), tag in B.b:
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


RANK_SLOPE_LAYERS = dict(rank_slope=(cl_rank_slope, None))
RANK_SLOPE_SVG = ["rank_slope"]


def draw(h):
    f = Frame(h)
    inner = cl_rank_slope(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "rank_slope"), f.W, f.H
