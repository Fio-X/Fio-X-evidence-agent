"""rankbar layer: a single-colour rank bar per row: name, bar, the number at the bar's tail, a share column, a last other row, in
column.py's layer style. The bar is drawn from the same series cell the printed number is the ledger text of.
hero.data: {"title": segs, "unit": segs, "share_head": segs?, "name_kind": "place"|<kind>,
  "rows": [{"code", "value": series src, "value_text": src, "share_text": src?}],
  "other_row": {"name": segs, "value": series src, "value_text": src, "share_text": src?}?,      # for rows merged past max_rows
  "omit": segs?}                  # the words of the line that stands where rows are left out (a long rank folds only when these are given)
A rank of more than fold_over rows with `omit` given folds to fold_to rows: the highest fold_to - 6, the highlighted row, the lowest
5, a line of the omit words where the rows are not next to each other (the rows kept are still the ledger's rows, in their order).
Colours: --accent the highlighted row (or every bar when none is named, as before), --t-sec the others, --t-title ink.
Refuses: no rows, a negative value, share_text missing while show_share is on, highlight_row not a row, rows merged and no other_row,
other_row's series not the merged rows' sum (1e-6), a board too narrow (bar under 80 px), a missing name, a digit in a literal."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
from wbkit import FX, prod, Refused, esc, tw

prod.KNOBS["rankbar"] = dict(
    size=(13, (13, 16, 0.5), "label size px"), title_size=(16, (12, 22, 1), "chart name size px"), row_h=(28, (20, 44, 1), "row height px"),
    max_rows=(0, (0, 40, 1), "rows kept (0 = all); the rest merge into the last other row (needs other_row)"),
    fold_over=(20, (0, 80, 1), "a rank of more rows than this folds when the spec gives omit words (0 = never)"),
    fold_to=(16, (8, 40, 1), "rows a folded rank keeps: the highest ones, the highlighted row and the lowest 5"),
    sort=("value", ("value", "name", "given"), "row order"), show_share=("on", ("on", "off"), "share column at the right"),
    highlight_row=("", None, "row code drawn in the accent, the others grey"), width=(1140, (240, 1400, 10), "picture width in px"))
NODE = "rankbar"
REL = 1e-6
FOLD_TAIL = 5  # the lowest rows a folded rank keeps


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.W, f.size, f.rh = d, k, k("width"), k("size"), k("row_h")
        kind = d.get("name_kind", "place")
        rows = [dict(r) for r in (d.get("rows") or [])]
        if not rows: raise Refused("rankbar: the spec holds no rows")
        share = k("show_share") == "on"
        for r in rows:
            r["_n"] = K.named(r["code"], kind); r["_v"] = K.val(r["value"]); K.ent(r["value_text"])
            if share and not r.get("share_text"): raise Refused(f"rankbar: row {r['code']} has no share_text and show_share is on")
            if r["_v"] < 0: raise Refused(f"rankbar: row {r['code']} is negative; a bar cannot be drawn")
        f.hl = K.check_codes(NODE, k("highlight_row"), {r["code"] for r in rows}) if k("highlight_row") else set()
        if len(f.hl) > 1: raise Refused("rankbar: highlight_row names one row")
        rows.sort(key=(lambda r: r["_n"][1]) if k("sort") == "name" else (lambda r: 0) if k("sort") == "given" else (lambda r: -r["_v"]))
        if k("max_rows") and len(rows) > k("max_rows"):
            rest, rows = rows[int(k("max_rows")):], rows[: int(k("max_rows"))]
            o = d.get("other_row")
            if not o: raise Refused("rankbar: rows were merged into the other row and the spec gives no other_row")
            ov = K.val(o["value"])
            if abs(ov - sum(r["_v"] for r in rest)) > REL * max(abs(ov), 1.0): raise Refused(f"rankbar: other_row's series {ov} is not the merged rows' sum {sum(r['_v'] for r in rest)}")
            K.ent(o["value_text"])
            if share and not o.get("share_text"): raise Refused("rankbar: other_row has no share_text")
            rows.append(dict(code="_other", _nsegs=o["name"], _n=("", K.plain(o["name"], "other name")), value_text=o["value_text"], share_text=o.get("share_text"), _v=ov))
        f.omit, f.gaps = None, set()
        if not k("max_rows") and d.get("omit") and k("fold_over") and len(rows) > k("fold_over"):
            f.omit = K.plain(d["omit"], "omit words")
            tail, head = FOLD_TAIL, max(1, int(k("fold_to")) - FOLD_TAIL - 1)
            keep = [i for i, r in enumerate(rows) if i < head or i >= len(rows) - tail or r["code"] in f.hl]
            f.gaps = {n for n in range(1, len(keep)) if keep[n] != keep[n - 1] + 1}  # a line stands before the kept row n
            rows = [rows[i] for i in keep]
        f.rows, f.share = rows, share
        f.name_w = max(tw(r["_n"][1], f.size) for r in rows) + 14
        tail_w = max(tw(K.ent(r["value_text"])[1], f.size) for r in rows) + 10
        share_w = (max(tw(K.ent(r["share_text"])[1], f.size) for r in rows) + 12) if share else 0
        f.bar_w = f.W - f.name_w - tail_w - share_w - 20
        if f.bar_w < 80: raise Refused("rankbar: the board is too narrow for the bar and the columns")
        f.oh = round(f.rh * 0.75)
        f.H = int(54 + f.rh * len(rows) + f.oh * len(f.gaps) + 14)


def cl_rankbar(f, occ):
    d, size, rh, W = f.d, f.size, f.rh, f.W; B = K.Boxes(W, f.H); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    if f.share and d.get("share_head"): o.append(K.words(B, d["share_head"], "share_head", W - 8, 46, size, "var(--t-sec)", anchor="end")[0])
    mx = max(r["_v"] for r in f.rows) or 1.0
    y0 = 54 - rh
    for n, r in enumerate(f.rows):
        if n in f.gaps:  # rows left out: a line of the omit words, in the bar column
            y0 += rh; yc = y0 + f.oh / 2 + 4; y0 += f.oh - rh
            o.append(K.line(8, y0 + rh, W - 8, y0 + rh))
            o.append(K.words(B, d["omit"], "omit", f.name_w + 8, yc, size, "var(--t-sec)", italic=True)[0])
        y0 += rh; yc = y0 + rh / 2 + 4
        o.append(K.line(8, y0 + rh, W - 8, y0 + rh))
        if r["code"] == "_other": o.append(K.words(B, r["_nsegs"], "other name", f.name_w - 6, yc, size, "var(--t-title)", anchor="end", weight=700)[0])
        else: o.append(K.txt(B, f.name_w - 6, yc, size, "var(--t-title)", r["_n"][0], tw(r["_n"][1], size), anchor="end", weight=700, tag=f"name {r['code']}"))
        bw = r["_v"] / mx * f.bar_w
        acc = r["code"] in f.hl or not f.hl
        o.append(f'<rect x="{f.name_w + 8:.1f}" y="{y0 + 5:.1f}" width="{bw:.1f}" height="{rh - 10}" fill="{"var(--accent)" if acc else "var(--t-sec)"}"/>')
        t = K.ent(r["value_text"]); o.append(K.txt(B, f.name_w + 8 + bw + 6, yc, size, "var(--t-title)", t[0], tw(t[1], size), tag=f"value {r['code']}"))
        if f.share:
            t = K.ent(r["share_text"]); o.append(K.txt(B, W - 8, yc, size, "var(--t-sec)", t[0], tw(t[1], size), anchor="end", tag=f"share {r['code']}"))
    return "".join(o)


RANKBAR_LAYERS = dict(rankbar=(cl_rankbar, None))
RANKBAR_SVG = ["rankbar"]


def draw(h):
    f = Frame(h)
    return K.svg(cl_rankbar(f, prod.Occ()), f.W, f.H, "rankbar"), f.W, f.H
