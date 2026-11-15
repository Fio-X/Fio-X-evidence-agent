"""rank_lines layer (owner 11-14 16:0x item 2): the places' ranks on two or more quantities side by side, one
column per quantity, one line per place through its rank in each column, in rankbar.py's layer style; the old route's rank
slope (runtime/pi/viz.mjs renderRankSlope: two columns, rank 1 at the top, a line per place, the highlighted one in the
accent and wider) carried over to any number of columns. Each rank is printed inside a small disc on its point, so no rank
sits on a line; each place is named left of the first column and right of the last, its labels' baselines spread so no two
overlap and a short leader drawn to a label moved off its point. Every printed rank is a ledger entry (layer 1's fact of
the place's position on that quantity, printed with FX.entry); every name is the request's label marked with its name row.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.rank_lines, run.py leaf): {
  "title": segs,                                    # the chart's name
  "series_kind": "place" | <kind>,                  # name rows: a series' name, name:zh_names:<kind>:<code> or a place's
  "columns": [{"head": segs,                        # one column per quantity, left to right (its name)
               "ranks": {code: ledger src}}],       # each place's rank there as printed (a positive whole number); a
                                                    # place with none is not ranked on that quantity (its line breaks)
  "series": [code, ...],                            # one line per place, in layer 1's order (the leaf sorts nothing)
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; ledger src: a row {"src", "text"}.
Placement keeps texts off the lines by construction: the ranks in discs over the points (the disc covers the line under
it), the names in a band left of the first column and right of the last, the column heads above the plot; every text box
is checked in wbkit.Boxes (outside the picture or over another refuses).
Refuses: fewer than two columns, a column with no head, no series, a series twice, a series ranked in fewer than two
columns, a rank whose text is no positive whole number, two series at one rank in one column, a rank naming a place that
is no series, a highlight that is no series, a digit in a literal word, a text that leaves the picture or overlaps
another, names that cannot all fit beside a column, neighbouring discs that would touch, a plot taller than plot_max, a board too narrow (columns closer than
col_min px)."""
import re

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "rank_lines"
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), row=(30, (20, 48, 1), "distance between two ranks in px"),
    plot_max=(600, (200, 900, 10), "the tallest the plot may be in px"), col_min=(140, (80, 400, 10), "the least distance between two columns in px"),
    disc_r=(10, (8, 16, 0.5), "radius of the disc a rank is printed in, px"),
    line_w=(2.5, (1.5, 4, 0.5), "the highlighted line's width in px"), context_w=(1.5, (0.8, 2.5, 0.1), "every other line's width in px"),
    highlight=("", None, "code of the series drawn in the accent; none = the first series"))

WHOLE = re.compile(r"[1-9][0-9]*")


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        cols = d.get("columns") or []
        if not isinstance(cols, list) or len(cols) < 2: raise Refused("rank_lines: the spec holds fewer than two columns")
        codes = d.get("series") or []
        if not codes: raise Refused("rank_lines: the spec holds no series")
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"rank_lines: the series' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"rank_lines: the series {twice} come twice")
        f.kind = d.get("series_kind", "place")
        f.cols = []
        for i, c in enumerate(cols):
            if not isinstance(c, dict) or not c.get("head"): raise Refused(f"rank_lines: column {i + 1} has no head")
            ranks = c.get("ranks") or {}
            stray = sorted(set(ranks) - set(codes))
            if stray: raise Refused(f"rank_lines: column {i + 1} ranks {stray}, which are no series")
            got, seen = {}, {}
            for code, src in ranks.items():
                text = FX.text(src)
                if not WHOLE.fullmatch(text): raise Refused(f"rank_lines: the rank {text!r} ({src}) is no positive whole number")
                r = int(text)
                if r in seen: raise Refused(f"rank_lines: {seen[r]} and {code} share rank {r} in column {i + 1}")
                seen[r] = code; got[code] = (r, K.ent(src))
            f.cols.append(dict(head=c["head"], ranks=got))
        for code in codes:
            if sum(code in c["ranks"] for c in f.cols) < 2: raise Refused(f"rank_lines: series {code} is ranked in fewer than two columns")
        f.series = [dict(code=c, name=K.named(c, f.kind)) for c in codes]
        hl = K.check_codes(NODE, k("highlight"), set(codes)) if k("highlight") else {codes[0]}
        if len(hl) > 1: raise Refused("rank_lines: highlight names one series")
        f.hl = next(iter(hl))
        f.top_rank = min(r for c in f.cols for r, _ in c["ranks"].values())
        f.low_rank = max(r for c in f.cols for r, _ in c["ranks"].values())
        if k("row") < 2 * k("disc_r") + 2: raise Refused("rank_lines: two neighbouring ranks' discs would touch; a larger row or a smaller disc_r")
        f.plot_h = (f.low_rank - f.top_rank) * k("row")
        if f.plot_h > k("plot_max"): raise Refused(f"rank_lines: ranks {f.top_rank}-{f.low_rank} need a {f.plot_h:.0f} px plot, over plot_max; fewer ranks or a smaller row")
        size = f.size
        # the name bands: the widest name (with its leader's room) left of the first column and right of the last
        f.name_w = max(tw(s["name"][1], size) for s in f.series) + 16
        f.x0, f.x1 = f.name_w + k("disc_r") + 8, f.W - f.name_w - k("disc_r") - 8
        if (f.x1 - f.x0) / (len(f.cols) - 1) < k("col_min"): raise Refused(f"rank_lines: the board is too narrow for {len(f.cols)} columns (under col_min px apart)")

    def x(f, i):
        return f.x0 + (f.x1 - f.x0) * i / (len(f.cols) - 1)


def spread(want, lo, hi, gap):
    """Baselines as near the wanted ones as they can be, in the same order, each `gap` or more below the one before and all
    within [lo, hi]; None when they cannot all fit (line.py's rule)."""
    if not want: return []
    if (len(want) - 1) * gap > hi - lo + 1e-9: return None
    out = []
    for y in want:
        out.append(max(min(max(y, lo), hi), out[-1] + gap if out else lo))
    out[-1] = min(out[-1], hi)
    for i in range(len(out) - 2, -1, -1):
        out[i] = min(out[i], out[i + 1] - gap)
    return out if out[0] >= lo - 1e-9 else None


GUIDE_OP = 0.15  # the column guide's opacity: a grid line under the ranks, never a data line


def cl_rank_lines(f, occ):
    d, size, W, r = f.d, f.size, f.W, f.k("disc_r")
    B = K.Boxes(W, 10 ** 6)
    o = [K.words(B, d["title"], "title", 8, 22, f.k("title_size"), "var(--t-title)", weight=700)[0]]
    head_y = 22 + size * 2.4
    top = head_y + size * 1.2 + r
    yr = lambda rank: top + (rank - f.top_rank) * f.k("row")
    for i, c in enumerate(f.cols):  # the column heads, each centred over its column, and a hairline down the plot
        o.append(K.words(B, c["head"], f"column {i + 1}", f.x(i), head_y, size, "var(--t-sec)", anchor="middle", weight=700)[0])
        # a guide under every rank of the column: faint as a grid line is (the layout check's grid, opacity below 0.2)
        o.append(K.line(f.x(i), top - r, f.x(i), yr(f.low_rank) + r, op=GUIDE_OP))
    # the lines: the grey ones first, the highlighted one last (on top); a column a series is not ranked in breaks it
    for s in sorted(f.series, key=lambda s: s["code"] == f.hl):
        hot = s["code"] == f.hl
        stroke = "var(--accent)" if hot else "var(--t-sec)"
        wd, op = (f.k("line_w"), 1) if hot else (f.k("context_w"), 0.6)
        pts = [(i, c["ranks"][s["code"]][0]) if s["code"] in c["ranks"] else None for i, c in enumerate(f.cols)]
        for a, b in zip(pts, pts[1:]):
            if a and b:
                o.append(f'<line x1="{f.x(a[0]):.1f}" y1="{yr(a[1]):.1f}" x2="{f.x(b[0]):.1f}" y2="{yr(b[1]):.1f}" stroke="{stroke}" '
                         f'stroke-width="{wd}" stroke-opacity="{op}" stroke-linecap="round" data-code="{esc(s["code"])}" data-line="rank:{esc(s["code"])}"/>')
    # the ranks: a disc on each point (over the lines), the rank printed in it
    for s in sorted(f.series, key=lambda s: s["code"] == f.hl):
        hot = s["code"] == f.hl
        for i, c in enumerate(f.cols):
            if s["code"] not in c["ranks"]: continue
            rank, (svg_t, text) = c["ranks"][s["code"]]
            w = tw(text, size - 1)
            if w > 2 * r - 2: raise Refused(f"rank_lines: the rank {text} is wider than its disc; a larger disc_r")
            x, y = f.x(i), yr(rank)
            o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="{"var(--accent)" if hot else "var(--bg)"}" '
                     f'stroke="{"var(--accent)" if hot else "var(--t-sec)"}" stroke-width="1" data-code="{esc(s["code"])}"/>')
            # the rank sits on its own series' line (the line rule's data-on); another series' line over it stays a finding
            o.append(K.txt(B, x, y + (size - 1) * 0.35, size - 1, "#fff" if hot else "var(--t-body)", svg_t, w, anchor="middle",
                           weight=700 if hot else 400, tag=f"rank {s['code']} column {i + 1}", style=f' data-on="rank:{esc(s["code"])}"'))
    # the names: left of the first column a series is ranked in, right of the last, spread so none overlaps another
    for side in ("left", "right"):
        ends = []
        for s in f.series:
            idx = [i for i, c in enumerate(f.cols) if s["code"] in c["ranks"]]
            i = idx[0] if side == "left" else idx[-1]
            ends.append((yr(f.cols[i]["ranks"][s["code"]][0]), i, s))
        ends.sort(key=lambda e: e[0])
        want = [y + size * 0.35 for y, _, _ in ends]
        got = spread(want, top - r + size * 0.8, yr(f.low_rank) + r, size * 1.3)
        if got is None: raise Refused(f"rank_lines: the {len(ends)} names do not fit beside the columns; fewer series or a larger row")
        for (y_pt, i, s), y, y_want in zip(ends, got, want):
            hot = s["code"] == f.hl
            fill = "var(--accent)" if hot else "var(--t-body)"
            nm_svg, nm = s["name"]
            edge = f.x(0) - r - 6 if side == "left" else f.x(len(f.cols) - 1) + r + 6
            if abs(y - y_want) > 2 or (side == "left" and i > 0) or (side == "right" and i < len(f.cols) - 1):
                xp = f.x(i) + (-r if side == "left" else r)
                o.append(K.line(xp, y_pt, edge + (2 if side == "left" else -2), y - size * 0.35, stroke=fill, w=0.6, op=0.8))
            o.append(K.txt(B, edge, y, size, fill, nm_svg, tw(nm, size), anchor="end" if side == "left" else "start",
                           weight=700 if hot else 400, tag=f"name {s['code']} {side}"))
    y = yr(f.low_rank) + r + size * 0.6
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"rank_lines: lines is {lns!r}; lines is a list of segment lists")
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


RANK_LINES_LAYERS = dict(rank_lines=(cl_rank_lines, None))
RANK_LINES_SVG = ["rank_lines"]


def draw(h):
    f = Frame(h)
    inner = cl_rank_lines(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "rank_lines"), f.W, f.H
