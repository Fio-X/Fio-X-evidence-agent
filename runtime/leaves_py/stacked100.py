"""stacked100 layer: one 100% stacked bar per place, its parts (a few groups of one dimension's leaves) left to right, in
rankbar.py's layer style, with the rules of the old route's stacked_bar_100 ported (runtime/pi/viz.mjs renderStackedBar100):
the highlighted part first and in the accent, the others in greys of distinct lightness so no two neighbours share a fill; a
part's names once, centred over its own segment of the first bar when every one fits there, else one key line above the bars;
by default only the highlighted part's share printed, in a column past the bars' 100% end (values highlight_column), or each
segment's share inside it where it fits (values in_bar); a part with no value above zero draws no segment. Every printed
number is a ledger entry printed with FX.entry; every name is the request's label marked with its name row.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.stacked100, run.py leaf): {
  "title": segs, "unit": segs,                      # the unit is written once, in the head
  "bar_kind": "place", "part_kind": <kind>,         # name rows: a bar's place, a part's name:zh_names:<kind>:<code>
  "parts": [code, ...],                             # the parts in layer 1's order (two or more, each once)
  "bars": [{"code": code,                           # one bar per place, in layer 1's order (the leaf sorts nothing)
            "total": series src,                    # the place's total row: the bar's 100%
            "total_text": ledger src?,              # the total printed in a column before the bar (every bar or none)
            "cells": {part: [series src, ...]},     # the leaf rows of each part the request holds: each cell's own
                                                    # width is its value over the total; no part's value is computed here
            "share_text": {part: ledger src}}],     # the printed share of each part drawn (layer 1's fact)
  "empty": [{"bar": code, "part": code}]?,          # a part of a bar with no row at all: no segment, back in
                                                    # Frame.dropped as ("<bar>:<part>", "no row")
  "zero": [{"bar": code, "part": code,              # a part of a bar whose every row is 0, declared by layer 1 (which
            "cells": [series src, ...]}]?,          # says it in a line): no segment and no drop; each cell must be 0
  "total_head": segs?,                              # the total column's head, when the bars print their totals
  "others": {"head": segs, "codes": [code, ...]}?,  # the places left out of the bars, named under the picture in the
                                                    # order given (layer 1's), each by its label
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
A part whose every cell is 0 and that layer 1 did not declare zero draws no segment and goes back in Frame.dropped as
("<bar>:<part>", "zero"); a declared zero draws none and is no drop.
Conservation (refuses): a bar's cells, laid end to end, end off its total by more than knob tol of the total (a leaf left out,
or one counted twice).
Colours: --accent the highlighted part, GREYS the others in turn (lightest, mid, light violet: CIE L* 84, 61, 72, each 10 or more
from the others and from HL_DARK, so the rest stays lighter than the highlighted part, and none the empty track's --empty,
L* 91, which reads as no data), --t-title ink, --t-sec the lines, --bg the gaps between segments and an in-bar share's ink
on the dark grey (--t-dark on the others). Each segment names the part it draws (data-code), so the
page's accent check knows the accent's entity.
Subject (_subject): where the core's comparison of the highlighted part's share (knobs.comparisons) names a first that is a
bar drawing that part, only that bar's highlighted segment takes the accent; every other bar's takes HL_DARK (a neutral mid
grey, L* 50: darker than every grey above and 11 or more from each, well lighter than the ink), the subject's name alone is bold, the share column's head is
ink, and the highlighted part's name is followed by the word table's paren around accent.subject (which names the subject
by its name row as the colour's). With no such first (no comparison from the core), every bar's highlighted part takes the
accent.
Note (_share_note): one line under the bars, the place first on the highlighted part's share above the second (data-cmp next,
in g[data-notes]), only where the shares' ledger values order the first two strictly and print them apart and the core's
comparison (knobs.comparisons) names the same two, with the scope phrase where its set is scoped; else none.
Refuses: no bars, fewer than two parts, a part twice, a bar twice, a negative cell, a cell whose series the request lacks, a
drawn part with no share_text, a part in none of cells, empty and zero, a zero cell that is not 0 or a zero also empty, a highlight that is no part, a digit in a literal word, a text
that leaves the picture or overlaps another, a board too narrow (plot under 160 px), an others line over 3 lines."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
from wbkit import FX, prod, Refused, esc, tw
import words as WD

NODE = "stacked100"
# The others' greys: --seq-5 (teal, L* 61.3), #c8d2d4 (pale teal, L* 83.5, 7 off --empty's 91: a big share in the empty
# track's grey reads as no data) and #b1aec8 (violet grey, L* 72.1). Two teals of 11 L* apart read as one (q3 stand-ins,
# twice), so the middle one leaves the teal: every pair is 10 or more apart in L* and 18 or more in CIE76 dE, and none is
# saturated (HSL saturation 0.19 at most beside the page check's 0.25), so the accent stays the one hue. tokens.css
# stays as every other page has it.
GREYS = ["#c8d2d4", "var(--seq-5)", "#b1aec8"]
# The highlighted part of every bar but the subject's: neutral, L* 50, between the ink (16) and the greys (61 and up), so the
# accent's one segment stays the page's focus. No token sits there and tokens.css stays as every other page has it; #767676
# carries white text at 4.5:1 (WCAG AA), hence its place in DARK.
HL_DARK = "#767676"
DARK = {HL_DARK}  # the greys an in-bar share is printed on in --bg, not --t-dark
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), bar_h=(18, (12, 30, 1), "bar height in px"),
    pitch=(26, (18, 44, 1), "distance between two bars' tops in px"), label_pad=(4, (2, 10, 1), "px between an in-bar text and its segment's edges"),
    highlight=("", None, "code of the part drawn first and in the accent; none = the first part"),
    values=("highlight_column", ("highlight_column", "in_bar"), "the highlighted part's share in a column past the bars, or each share inside its segment"),
    tol=(1e-5, (0, 0.001, 1e-6), "conservation tolerance, as a share of a bar's total"))


def _codes(v, what):
    if not isinstance(v, list) or not v or not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in v):
        raise Refused(f"stacked100: {what} is {v!r}; a list of codes, for example ['fossil', 'renewable']")
    twice = sorted({c for c in v if v.count(c) > 1})
    if twice: raise Refused(f"stacked100: {what} names {twice} twice")
    return list(v)


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        parts = _codes(d.get("parts"), "parts")
        if len(parts) < 2: raise Refused("stacked100: a composition holds two parts or more")
        bars = [dict(b) for b in (d.get("bars") or [])]
        if not bars: raise Refused("stacked100: the spec holds no bars")
        _codes([b.get("code") for b in bars], "the bars' codes")
        hl = K.check_codes(NODE, k("highlight"), set(parts)) if k("highlight") else {parts[0]}
        if len(hl) > 1: raise Refused("stacked100: highlight names one part")
        f.hl = next(iter(hl))
        f.order = [f.hl] + [p for p in parts if p != f.hl]  # the highlighted part first, the others in layer 1's order
        f.fill = {f.hl: "var(--accent)", **{p: GREYS[i % len(GREYS)] for i, p in enumerate(p for p in f.order if p != f.hl)}}
        empty = d.get("empty") or []
        if not isinstance(empty, list) or not all(isinstance(e, dict) and set(e) == {"bar", "part"} for e in empty):
            raise Refused(f"stacked100: empty is {empty!r}; a list of {{'bar': code, 'part': code}}")
        none = {(e["bar"], e["part"]) for e in empty}
        zero = d.get("zero") or []
        if not isinstance(zero, list) or not all(isinstance(z, dict) and set(z) == {"bar", "part", "cells"} for z in zero):
            raise Refused(f"stacked100: zero is {zero!r}; a list of {{'bar': code, 'part': code, 'cells': [series src]}}")
        zeros = {(z["bar"], z["part"]) for z in zero}
        if zeros & none: raise Refused(f"stacked100: {sorted(zeros & none)} are both empty and zero; no row is no zero")
        for z in zero:
            if not isinstance(z["cells"], list) or not z["cells"]: raise Refused(f"stacked100: zero {z['bar']}:{z['part']} names no cell")
            if any(K.val(c) != 0 for c in z["cells"]): raise Refused(f"stacked100: zero {z['bar']}:{z['part']} has a cell that is not 0")
        f.dropped, f.rows = [], []
        tol = k("tol")
        for b in bars:
            code, cells = b["code"], b.get("cells") or {}
            total = K.val(b.get("total"))
            if total <= 0: raise Refused(f"stacked100: bar {code}'s total is {total}; a 100% bar needs a total above zero")
            off = sorted(set(cells) - set(parts))
            if off: raise Refused(f"stacked100: bar {code} has cells of {off}, which are no parts")
            segs, end = [], 0.0
            for p in f.order:
                if (code, p) in zeros:
                    if p in cells: raise Refused(f"stacked100: zero names {code}:{p}, which has cells")
                    continue  # declared 0 by layer 1 and said under the picture: data, not a drop
                if (code, p) in none:
                    if p in cells: raise Refused(f"stacked100: empty names {code}:{p}, which has cells")
                    f.dropped.append((f"{code}:{p}", "no row")); continue
                if p not in cells or not isinstance(cells[p], list) or not cells[p]:
                    raise Refused(f"stacked100: bar {code} has no cells of part {p}; a part with no row is named in empty")
                vals = [K.val(s) for s in cells[p]]
                if any(v < 0 for v in vals): raise Refused(f"stacked100: bar {code} part {p} has a negative cell; a share cannot be drawn")
                if not any(v > 0 for v in vals):
                    f.dropped.append((f"{code}:{p}", "zero")); continue
                if p not in (b.get("share_text") or {}): raise Refused(f"stacked100: bar {code} part {p} has no share_text (the ledger entry its share prints from)")
                K.ent(b["share_text"][p])
                # the segment runs from where the previous one ended, each cell its own value over the bar's total
                x0 = end
                for v in vals: end += v / total
                segs.append((p, x0, end))
            if not segs: raise Refused(f"stacked100: bar {code} draws no segment")
            if abs(end - 1.0) > tol: raise Refused(f"stacked100: bar {code}'s cells end at {end:.6f} of its total, not 1 (tolerance {tol:g})")
            tt = K.ent(b["total_text"]) if b.get("total_text") else None
            f.rows.append(dict(code=code, segs=segs, share=b.get("share_text") or {}, total=tt, name=K.named(code, d.get("bar_kind", "place"))))
        with_total = [r["total"] is not None for r in f.rows]
        if any(with_total) and not all(with_total): raise Refused("stacked100: total_text is on some bars only; every bar prints its total or none")
        f.totals = all(with_total)
        if f.totals and not d.get("total_head"): raise Refused("stacked100: the bars print their totals and total_head is missing")
        f.part_kind = K.need(d, "part_kind")
        f.part_names = {p: K.named(p, f.part_kind) for p in parts}
        f.subject = _subject(f)
        if f.subject:  # one accent segment; the others' highlighted part in the dark grey, its name saying which is red
            f.fill[f.hl] = HL_DARK
            segs = [{"name": f.hl, "kind": f.part_kind}] + K._finding_word("paren", v=K._finding_word(
                "accent.subject", name=[{"name": f.subject, "kind": d.get("bar_kind", "place")}]))
            f.part_names[f.hl] = (K.finding_html(segs), K.finding_plain(segs))
        f.name_w = max(tw(r["name"][1], f.size) for r in f.rows) + 14
        f.column = k("values") == "highlight_column"
        if f.column:
            texts = [K.ent(r["share"][f.hl])[1] for r in f.rows if f.hl in r["share"] and any(s[0] == f.hl for s in r["segs"])]
            f.col_w = max([tw(K.named(f.hl, f.part_kind)[1], f.size)] + [tw(t, f.size) for t in texts]) + 14
        else:
            f.col_w = 0
        f.tot_w = (max([tw(K.plain(d["total_head"], "total head"), f.size)] + [tw(r["total"][1], f.size) for r in f.rows]) + 14) if f.totals else 0
        f.x0, f.x1 = 8 + f.name_w + f.tot_w, f.W - 8 - f.col_w
        if f.x1 - f.x0 < 160: raise Refused("stacked100: the board is too narrow for the names, the bars and the share column (plot under 160 px)")
        f.H = 0


def _subject(f):
    """The bar whose highlighted segment alone takes the accent: the first of the core's comparison of the highlighted part's
    share (wbkit.compared), where it is a bar that draws that part; else None."""
    c = next((K.compared(r["share"][f.hl]) for r in f.rows if r["share"].get(f.hl) and K.compared(r["share"][f.hl])), None)
    first = c and c.get("first")
    return first if any(r["code"] == first and any(s[0] == f.hl for s in r["segs"]) for r in f.rows) else None


def _share_note(f):
    """(segs, (relation, a_src, b_src)) of the note under the bars, or None (no note; the page is drawn all the same): the
    place first on the highlighted part's share above the second (wbkit.finding_side_top over the bars, each share's value
    the number of its fact's bare ledger entry, never a sum of cells), the second above every place after it, each printing
    differently. Only where every bar draws that part (none empty or zero), three bars or more, each from its own share
    entry; and only where the core's comparison of that share (wbkit.compared: the set the page check judges over, the
    request's other codes computed alike) names the same first and second, its scope phrase leading where it is scoped."""
    nodes = []
    for r in f.rows:
        src = r["share"].get(f.hl)
        if not src or not any(s[0] == f.hl for s in r["segs"]): return None
        try: nodes.append((r["code"], float(FX.text(src.removesuffix(".r").removesuffix(".n") + ".n").replace(",", "")), src))
        except (Refused, ValueError): return None
    top = K.finding_side_top(nodes) if len(nodes) >= 3 and len({n[2] for n in nodes}) == len(nodes) else None
    if not top: return None
    (a, _, a_src), (b, _, b_src) = top
    c = K.compared(a_src)  # the core's first and second must be these two; a scoped set says its scope (the word table's)
    if not c or (c.get("first"), c.get("second")) != (a, b) or (c.get("scoped") and K.FINDING_WORDS["scope"] not in WD.WORDS): return None
    nm = lambda c: {"name": c, "kind": f.d.get("bar_kind", "place")}
    pause = WD.WORDS[K.FINDING_WORDS["above"]][:1]  # the pause the above word opens with, after the scope phrase too
    scope = K._finding_word(K.FINDING_WORDS["scope"]) + [{"w": pause}] if c.get("scoped") else []
    segs = scope + [nm(a), {"w": " "}, {"src": a_src, "bold": True}] + K._finding_word(K.FINDING_WORDS["above"]) + \
        K._finding_word(K.FINDING_WORDS["paren"], v=[nm(b), {"w": " "}, {"src": b_src, "bold": True}])
    return segs, (K.FINDING_RELATION["note"], a_src, b_src)


def _px(f, at):
    return round(f.x0 + (f.x1 - f.x0) * at, 2)


def cl_stacked100(f, occ):
    d, size, W = f.d, f.size, f.W
    bh, pitch, pad = f.k("bar_h"), f.k("pitch"), f.k("label_pad")
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    y = 22 + size * 1.6
    first = {p: (_px(f, a), _px(f, b)) for p, a, b in f.rows[0]["segs"]}
    # the parts' names over the first bar when each fits its own segment there, else one key line (wrapping) above the bars
    fits = all(p in first and tw(f.part_names[p][1], size) + 2 * pad <= first[p][1] - first[p][0] for p in f.order)
    if fits:
        y += size
        for p in f.order:
            a, b = first[p]; nm_svg, nm = f.part_names[p]
            o.append(K.txt(B, (a + b) / 2, y, size, "var(--t-title)", nm_svg, tw(nm, size), anchor="middle",
                           weight=700 if p == f.hl else 400, tag=f"part {p}"))
    else:
        x, y = f.x0, y + size
        for p in f.order:
            nm_svg, nm = f.part_names[p]; wd = size + 4 + tw(nm, size)
            if x > f.x0 and x + wd > f.x1: x, y = f.x0, y + size * 1.5
            o.append(f'<rect x="{x:.1f}" y="{y - size * 0.75:.1f}" width="{size * 0.8:.1f}" height="{size * 0.8:.1f}" fill="{f.fill[p]}"/>')
            o.append(K.txt(B, x + size + 4, y, size, "var(--t-title)", nm_svg, tw(nm, size), weight=700 if p == f.hl else 400, tag=f"key {p}"))
            x += wd + 14
    if f.totals:
        head = K.segs(d["total_head"], "total head")
        hsvg = "".join(FX.entry(sg, "tspan", None) if sg else esc(t) for t, sg in head)
        o.append(K.txt(B, f.x0 - 8, y, size, "var(--t-sec)", hsvg, tw(K.plain(d["total_head"], "total head"), size), anchor="end", tag="total head"))
    if f.column:
        nm_svg, nm = K.named(f.hl, f.part_kind)
        o.append(K.txt(B, W - 8, y, size, "var(--t-title)" if f.subject else "var(--accent)", nm_svg, tw(nm, size), anchor="end",
                       weight=700, tag="column head"))
    top = y + 8
    bottom = top + (len(f.rows) - 1) * pitch + bh
    for q in (0.25, 0.5, 0.75):  # quarter lines under the bars; no tick prints a number of its own
        o.append(K.line(_px(f, q), top - 2, _px(f, q), bottom + 2))
    for i, r in enumerate(f.rows):
        y0 = top + i * pitch; yc = y0 + bh / 2 + size * 0.35
        o.append(K.txt(B, f.x0 - 6 - f.tot_w, yc, size, "var(--t-title)", r["name"][0], tw(r["name"][1], size), anchor="end",
                       weight=700 if f.subject in (None, r["code"]) else 400, tag=f"name {r['code']}"))
        if f.totals:
            o.append(K.txt(B, f.x0 - 8, yc, size, "var(--t-title)", r["total"][0], tw(r["total"][1], size), anchor="end", tag=f"total {r['code']}"))
        last = len(r["segs"]) - 1
        for j, (p, a, b) in enumerate(r["segs"]):
            xa, xb = _px(f, a), (f.x1 if j == last else _px(f, b))  # the last segment ends exactly at the 100% end
            fill = "var(--accent)" if p == f.hl and r["code"] == f.subject else f.fill[p]
            o.append(f'<rect x="{xa:.2f}" y="{y0:.1f}" width="{max(xb - xa, 0.0):.2f}" height="{bh}" fill="{fill}" stroke="var(--bg)" stroke-width="1" data-part="{esc(r["code"])}:{esc(p)}" data-code="{esc(p)}"/>')
            if not f.column:
                t = K.ent(r["share"][p]); w = tw(t[1], size)
                if w + 2 * pad <= xb - xa:
                    ink = "var(--bg)" if fill == "var(--accent)" or fill in DARK else "var(--t-dark)"
                    o.append(K.txt(B, (xa + xb) / 2, yc, size, ink, t[0], w, anchor="middle", tag=f"share {r['code']} {p}"))
        if f.column and any(s[0] == f.hl for s in r["segs"]):
            t = K.ent(r["share"][f.hl])
            o.append(K.txt(B, W - 8, yc, size, "var(--t-title)", t[0], tw(t[1], size), anchor="end", tag=f"share {r['code']}"))
    y = bottom + 6
    note = _share_note(f)
    if note:  # one short note under the bars, marked for the page's comparison check (data-cmp)
        segs, (rel, a_src, b_src) = note; y += size * 1.5
        mark = f' data-cmp="{rel}" data-a="{esc(a_src)}" data-b="{esc(b_src)}"'
        o.append('<g data-notes="share">' + K.txt(B, 8, y, size, "var(--t-title)", K.finding_html(segs), tw(K.finding_plain(segs), size),
                                                   tag="note", style=mark) + "</g>")
    others = d.get("others")
    if others:
        codes = _codes(others.get("codes"), "others.codes")
        head = K.segs(others.get("head"), "others head")
        line = [("".join(FX.entry(s, "tspan", None) if s else esc(t) for t, s in head), K.plain(others["head"], "others head"))]
        w_line, rows, sep = tw(line[0][1], size), [], WD.WORDS["list.sep"]
        for i, c in enumerate(codes):
            nm_svg, nm = K.named(c, d.get("bar_kind", "place"))
            piece = (nm_svg + (esc(sep) if i < len(codes) - 1 else ""), nm + (sep if i < len(codes) - 1 else ""))
            if w_line + tw(piece[1], size) > W - 16 and line: rows.append(line); line, w_line = [], 0.0
            line.append(piece); w_line += tw(piece[1], size)
        rows.append(line)
        if len(rows) > 3: raise Refused(f"stacked100: the places left out take {len(rows)} lines, 3 allowed")
        for ln in rows:
            y += size * 1.5
            o.append(K.txt(B, 8, y, size, "var(--t-sec)", "".join(p[0] for p in ln), sum(tw(p[1], size) for p in ln), tag="others"))
    lines = d.get("lines") or []
    if not isinstance(lines, list): raise Refused(f"stacked100: lines is {lines!r}; lines is a list of segment lists")
    for i, ln in enumerate(lines):
        y += size * 1.5
        o.append(K.words(B, ln, f"line {i + 1}", 8, y, size, "var(--t-sec)", max_w=W - 16)[0])
    if d.get("footnote"):
        y += size * 1.5
        o.append(K.words(B, d["footnote"], "footnote", 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


STACKED100_LAYERS = dict(stacked100=(cl_stacked100, None))
STACKED100_SVG = ["stacked100"]


def draw(h):
    f = Frame(h)
    inner = cl_stacked100(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "stacked100"), f.W, f.H
