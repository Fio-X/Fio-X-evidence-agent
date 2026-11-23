"""dot_strip layer: every member's value on one value axis as a dot (position = value), in change_dots.py's layer style. It
answers "where does each member stand among all of them": the whole field at a glance, a chosen few named on leaders, and the
benchmarks drawn inside the picture (the target as a dashed rule, the members' simple average or the whole as a thin solid
rule, each with its words and value written at the rule's top). With two period rows the earlier period is a second row of
hollow dots above the later one, each joined to its later dot by a thin line, so the field's movement reads. With groups each
group is a row of its own (its members as dots, its own simple average a short tick with its value).
One accent: the lead dots (the ones named on leaders) and their joins; every other dot grey; the rules in ink. Every printed
number is a ledger entry printed with FX.entry; every name is the request's label marked with its name row; the leaf's one
fixed word names the members' simple average (dot.mean), never the whole: the caveat that it is unweighted is the data's
footnote line, which the leaf prints as given.

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs, "unit": segs,                      # the measure's name and unit, once, in the head
  "name_kind": "place" | <kind>?,                   # how a row's name is looked up (default place)
  "rows": [{"code": code,                           # a member; its name is the request's label for the code
            "a": series src, "a_text": ledger src,  # its cell at the later period (geometry) and its value as printed
            "b": series src?, "b_text": ledger src?,   # its cell at the earlier period (knob periods 2 only)
            "group": id?}],                         # its group's id (with "groups" only)
  "periods": [ledger src, ...],                     # period:<table>:<period> of each drawn row, earlier first (1 or 2 entries)
  "groups": [{"id": id, "label": segs, "mean": ledger src?}]?,   # one row per group, top to bottom; its simple average as printed
  "refs": [{"kind": "target" | "mean" | "whole",    # the target (dashed), the members' simple average, the whole's value
            "text": ledger src,                     # the value as printed (and, for a target, where the rule stands)
            "at": series src?,                      # a whole's cell (required for kind whole)
            "label": segs?}]?,                      # the words over the rule (target and whole; a mean takes none: dot.mean)
  "lead": [code, ...]?,                             # the rows named on leaders (knob lead_set given)
  "ticks": [ledger src, ...]?, "scale": number?,    # an axis under the strip: each tick's text a number, printed = raw * scale
  "omit": segs?, "footnote": segs?}                 # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): each row's value at each drawn
period; the target's value; the members' simple average (op mean over the rows' cells; the leaf checks the printed mean is
the simple average of the rows it draws, to the printed places); each group's simple average; the axis ticks.
needs new wording: dot.mean (the members' simple average), dot.group_mean (a group's own average).
Placement: the lead labels are tried tier by tier, nearest the strip first (one period: alternately below and above the strip
in value order; two periods: below the later row; groups: above each group's row), each beside its vertical leader on the side
knob leader_side gives, and taken at the first tier where its box overlaps no text, no dot row, no leader and no rule, and its
leader crosses no text; then the rules' words in rows over everything. Every box is checked again in wbkit.Boxes.
Refuses: fewer than four rows, a row twice, a code that is no code, a row that lacks a ledger entry, rows on other periods, a
period entry that is not a drawn row's, a lead code that is no row or more than LEAD_MAX leads, a lead list with lead_set not
given, a ref of no known kind or with no ledger text, a target or whole with no label, a mean with a label or whose printed
value is not the rows' simple average, a whole with no cell, groups with two period rows, a row in no group, a group with no
row, a tick or a ref text that is no number, a label that finds no free tier within knob levels, a digit in a literal word, a
text that leaves the picture or overlaps another, a board too narrow (plot under 240 px)."""
import re

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw
word = K.WD.word   # the word table, through the kit (dot.mean, dot.group_mean)

NODE = "dot_strip"
ROWS_MIN = 4
LEAD_MAX = 12
KINDS = ("target", "mean", "whole")
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"),
    row=(40, (24, 80, 1), "distance between the two period rows, or two group rows, in px"),
    dot_r=(4.5, (2.5, 7, 0.5), "dot radius px"),
    periods=(1, (1, 2, 1), "period rows drawn: 1 the later period only, 2 the earlier period as a second row above it"),
    ghost_period=("on", ("on", "off"), "with two period rows: on draws the earlier dots hollow, each joined to its later dot by a thin line; off draws them grey with no join"),
    refs=("all", ("all", "target", "mean", "none"), "the reference marks drawn: every one the data gives, the target only, the members' average only, or none"),
    lead_set=("both", ("top", "bottom", "both", "given"), "the dots named on leaders: the k highest, the k lowest, both, or the data's lead list"),
    lead_k=(3, (1, 6, 1), "k of lead_set top, bottom and both"),
    leader_side=("auto", ("auto", "left", "right", "alternate"), "the side of its leader a label stands on: auto left on the axis's upper half and right on its lower half, or always left, always right, or turn about"),
    levels=(4, (1, 8, 1), "label tiers tried on each side of the strip before refusing"))

NUM = re.compile(r"[-−]?[0-9][0-9,]*(?:\.([0-9]+))?%?")


def number(src, scale, what):
    """(raw value, half a unit of its last printed place in raw terms) of a ledger entry printing a number; no number refuses."""
    text = FX.text(src).strip()
    m = NUM.fullmatch(text)
    if not m: raise Refused(f"dot_strip: {what} {text!r} ({src}) is no number")
    places = len(m.group(1) or "")
    return float(text.replace(",", "").replace("−", "-").rstrip("%")) / scale, 0.5 * 10 ** -places / scale


def averaged(src, vals, scale, what):
    """The simple average of vals, checked against the ledger text that prints it (to its printed places)."""
    mean = sum(vals) / len(vals)
    got, half = number(src, scale, what)
    if abs(got - mean) > half + 1e-9: raise Refused(f"dot_strip: {what} prints {FX.text(src)!r}, not the simple average {mean:.4g} of its {len(vals)} rows")
    return mean


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W, f.r = d, k, k("size"), k("width"), k("dot_r")
        K.segs(d.get("title"), "title"); K.segs(d.get("unit"), "unit")
        kind = d.get("name_kind", "place")
        scale = d.get("scale", 1)
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not scale > 0: raise Refused(f"dot_strip: the scale {scale!r} is no number above 0")
        f.two = k("periods") == 2
        if f.two and d.get("groups") is not None: raise Refused("dot_strip: groups draw one period row; knob periods 2 takes no groups")
        rows = d.get("rows")
        if not isinstance(rows, list) or len(rows) < ROWS_MIN: raise Refused(f"dot_strip: the spec holds fewer than {ROWS_MIN} rows")
        codes = [r.get("code") if isinstance(r, dict) else None for r in rows]
        if not all(isinstance(c, str) and K.CODE.fullmatch(c) for c in codes): raise Refused(f"dot_strip: the rows' codes {codes!r} are not codes")
        twice = sorted({c for c in codes if codes.count(c) > 1})
        if twice: raise Refused(f"dot_strip: the rows {twice} come twice")
        f.rows, pa, pb = [], set(), set()
        for r in rows:
            if not r.get("a_text"): raise Refused(f"dot_strip: row {r['code']} lacks its value's ledger entry")
            row = dict(code=r["code"], a=K.val(r.get("a")), at=K.ent(r["a_text"]), name=K.named(r["code"], kind), group=r.get("group"))
            pa.add(K.period_of(r["a"]))
            if f.two:
                if not r.get("b") or not r.get("b_text"): raise Refused(f"dot_strip: row {r['code']} lacks its earlier cell or its ledger entry (two period rows)")
                row.update(b=K.val(r["b"]), bt=K.ent(r["b_text"]))
                if K.period_of(r["b"]) == K.period_of(r["a"]): raise Refused(f"dot_strip: row {r['code']}'s two cells are at one period")
                pb.add(K.period_of(r["b"]))
            f.rows.append(row)
        if len(pa) != 1 or len(pb) > 1: raise Refused("dot_strip: the rows are on other periods than the first row's")
        held = sorted(pb) + sorted(pa)
        per = d.get("periods")
        if not isinstance(per, list) or len(per) != len(held): raise Refused(f"dot_strip: the rows need {len(held)} period entries, earlier first")
        for src, p in zip(per, held):
            if not isinstance(src, str) or not src.startswith("period:"): raise Refused(f"dot_strip: the period entry {src!r} is no period:<table>:<period>")
            if src.rsplit(":", 1)[1] != p: raise Refused(f"dot_strip: the period entry {src} is not its row's period {p}")
        f.periods = [K.ent(src) for src in per]
        # groups: one row each, in the data's order
        f.groups = None
        if d.get("groups") is not None:
            gs = d["groups"]
            if not isinstance(gs, list) or len(gs) < 2: raise Refused("dot_strip: groups is a list of two groups or more")
            ids = [g.get("id") if isinstance(g, dict) else None for g in gs]
            if not all(isinstance(i, str) and K.CODE.fullmatch(i) for i in ids) or len(set(ids)) != len(ids): raise Refused(f"dot_strip: the groups' ids {ids!r} are not distinct codes")
            lost = [r["code"] for r in f.rows if r["group"] not in ids]
            if lost: raise Refused(f"dot_strip: the rows {lost} are in no group")
            f.groups = []
            for g in gs:
                K.segs(g.get("label"), f"group {g['id']}'s label")
                vals = [r["a"] for r in f.rows if r["group"] == g["id"]]
                if not vals: raise Refused(f"dot_strip: group {g['id']} holds no row")
                mean = averaged(g["mean"], vals, scale, f"group {g['id']}'s mean") if g.get("mean") else None
                f.groups.append(dict(id=g["id"], label=g["label"], mean=mean, mt=K.ent(g["mean"]) if g.get("mean") else None))
        elif any(r["group"] is not None for r in f.rows): raise Refused("dot_strip: a row names a group and the data holds no groups")
        # the reference marks
        f.refs = []
        show = k("refs")
        refs = d.get("refs") or []
        if not isinstance(refs, list): raise Refused("dot_strip: refs is a list")
        for i, rf in enumerate(refs):
            if not isinstance(rf, dict) or rf.get("kind") not in KINDS: raise Refused(f"dot_strip: ref {i + 1} is of no kind of {list(KINDS)}")
            kd = rf["kind"]
            if not rf.get("text"): raise Refused(f"dot_strip: ref {i + 1} ({kd}) names no text (the ledger entry its value prints from)")
            if kd == "mean":
                if rf.get("label") is not None: raise Refused("dot_strip: the mean ref takes no label; the leaf names it (the members' simple average)")
                v = averaged(rf["text"], [r["a"] for r in f.rows], scale, "the mean ref")
            else:
                K.segs(rf.get("label"), f"ref {i + 1} ({kd})'s label")
                if kd == "whole":
                    if not rf.get("at"): raise Refused("dot_strip: the whole ref names no cell (at)")
                    v = K.val(rf["at"])
                else: v = number(rf["text"], scale, f"ref {i + 1} (target)")[0]
            if show == "all" or show == kd: f.refs.append(dict(kind=kd, v=v, text=rf["text"], label=rf.get("label")))
        # the axis ticks
        f.ticks = []
        for src in d.get("ticks") or []:
            v = number(src, scale, "the tick")[0]
            if f.ticks and v <= f.ticks[-1][0]: raise Refused(f"dot_strip: the ticks are not ascending at {src}")
            f.ticks.append((v, K.ent(src)))
        # the lead set
        lead, how, kk = d.get("lead"), k("lead_set"), int(k("lead_k"))
        if lead is not None:
            if how != "given": raise Refused(f"dot_strip: the data gives a lead list and knob lead_set is {how!r}, not given")
            if not isinstance(lead, list) or not all(isinstance(c, str) for c in lead) or len(set(lead)) != len(lead): raise Refused("dot_strip: lead is a list of distinct codes")
            bad = [c for c in lead if c not in codes]
            if bad: raise Refused(f"dot_strip: lead names {bad}, no row")
        else:
            order = [r["code"] for r in sorted(f.rows, key=lambda r: (-r["a"], r["code"]))]
            lead = (order[:kk] if how in ("top", "both") else []) + (order[-kk:] if how in ("bottom", "both") else [])
            lead = list(dict.fromkeys(lead))
        if len(lead) > LEAD_MAX: raise Refused(f"dot_strip: {len(lead)} leads; at most {LEAD_MAX}")
        f.lead = set(lead)
        # the value scale: from 0 when the lowest is at most half the highest, else over the values' own range
        vals = [r["a"] for r in f.rows] + [r["b"] for r in f.rows if f.two] + [rf["v"] for rf in f.refs] + [t[0] for t in f.ticks]
        lo, hi = min(vals), max(vals)
        f.base = 0.0 if 0 <= lo <= hi / 2 else lo - 0.05 * ((hi - lo) or abs(lo) or 1)
        f.top = hi + 0.02 * ((hi - f.base) or 1)
        size = f.size
        lw = [tw(t, size) for _, t in f.periods] if f.groups is None else [tw(K.plain(g["label"], "group"), size) for g in f.groups]
        f.lab_w = max(lw)
        f.x0 = 8 + f.lab_w + 14 + f.r
        f.x1 = f.W - 8 - f.r
        if f.x1 - f.x0 < 240: raise Refused("dot_strip: the board is too narrow for the row labels and the strip (plot under 240 px)")
        f.H = 0

    def x(f, v):
        return f.x0 + (f.x1 - f.x0) * (v - f.base) / (f.top - f.base)


def overlaps(a, b, pad=2.0):
    return a[0] < b[2] + pad and b[0] < a[2] + pad and a[1] < b[3] + pad and b[1] < a[3] + pad


def crosses(seg, box):
    x, y0, y1 = seg
    lo, hi = min(y0, y1), max(y0, y1)
    return box[0] - 1 < x < box[2] + 1 and lo < box[3] and box[1] < hi


def _plan(f):
    """Every label's place relative to the first row at y 0: (labels, rows' y). A label is (tag, pieces, x, baseline, anchor,
    leader (x, y_from, y_to) or None); pieces are (svg, text, weight, fill)."""
    size, r, pitch = f.size, f.r, f.k("row")
    nrow = len(f.groups) if f.groups else 2 if f.two else 1
    ys = [i * pitch for i in range(nrow)]
    bands = [(f.x0 - r - 1, y - r - 1, f.x1 + r + 1, y + r + 1) for y in ys]   # the dot rows: no label over them
    lines = [(f.x(rf["v"]), -10 ** 6, ys[-1] + r + 3) for rf in f.refs]        # the rules run from their words down through every row
    boxes, out, step = [], [], size * 1.45
    side_of = f.k("leader_side")

    def sides_of(xv, n):
        if side_of == "auto": return ("end", "start") if xv > (f.x0 + f.x1) / 2 else ("start", "end")
        if side_of == "alternate": return ("end",) if n % 2 else ("start",)
        return ("end",) if side_of == "left" else ("start",)

    def nested(items):
        """The order the labels of one row side are placed in, nearest tier first: a label standing left of its leader after
        the ones whose leaders stand left of it, one standing right after the ones right of it, so no later leader runs
        through an earlier label."""
        return sorted(items, key=lambda it: (sides_of(it[2], it[3])[0] == "start", it[2] if sides_of(it[2], it[3])[0] == "end" else -it[2]))

    def place(tag, ps, xv, n, y_row, up, reach):
        w = tw("".join(t for _, t, _, _ in ps), size)
        sides = sides_of(xv, n)
        for anchor, t in ((a, t) for a in sides for t in range(int(f.k("levels")))):   # its side first, every tier; then the other side
            base = (y_row - reach - 6 - t * step - size * 0.25) if up else (y_row + reach + 6 + t * step + size * 0.8)
            ly = base - size * 0.3
            lead = (xv, y_row + (-reach - 1 if up else reach + 1), ly)
            x = xv + 4 if anchor == "start" else xv - 4
            x0 = x if anchor == "start" else x - w
            b = (x0, base - size * 0.8, x0 + w, base + size * 0.25)
            if b[0] < 0 or b[2] > f.W: continue
            if any(overlaps(b, o) for o in boxes + bands): continue
            if any(crosses(s, b) for s in lines): continue
            if any(crosses(lead, o) for o in boxes + bands): continue
            boxes.append(b); lines.append(lead)
            out.append((tag, ps, x, base, anchor, lead)); return
        raise Refused(f"dot_strip: {tag} finds no free tier within {f.k('levels')} tiers of its row; fewer leads, more levels or a wider board")

    def pieces(row):
        nm_svg, nm = row["name"]
        ps = [(nm_svg, nm, 700, "var(--t-title)"), (" ", " ", 400, "var(--t-body)")]
        if f.two: ps += [(row["bt"][0], row["bt"][1], 400, "var(--t-sec)"), (" → ", " → ", 400, "var(--t-sec)")]
        return ps + [(row["at"][0], row["at"][1], 700, "var(--accent)")]

    leads = sorted((rw for rw in f.rows if rw["code"] in f.lead), key=lambda rw: (-rw["a"], rw["code"]))
    if f.groups:
        gy = {g["id"]: ys[i] for i, g in enumerate(f.groups)}
        for i, g in enumerate(f.groups):   # each group's average first (its tick stands in the row), then its leads
            if g["mean"] is not None:
                ps = [(esc(word("dot.group_mean")), word("dot.group_mean"), 400, "var(--t-sec)"), (" ", " ", 400, "var(--t-sec)"), (g["mt"][0], g["mt"][1], 700, "var(--t-title)")]
                place(f"group {g['id']} mean", ps, f.x(g["mean"]), 0, ys[i], False, r + 4)
        for g in f.groups:
            items = [(f"lead {rw['code']}", pieces(rw), f.x(rw["a"]), n) for n, rw in enumerate(leads) if rw["group"] == g["id"]]
            for it in nested(items): place(*it, gy[g["id"]], True, r)
    else:
        # one period: in value order alternately below and above the strip; two: all below the later row
        items = [(f"lead {rw['code']}", pieces(rw), f.x(rw["a"]), n) for n, rw in enumerate(leads)]
        for up in (False, True):
            for it in nested([it for it in items if (it[3] % 2 == 1 and not f.two) == up]): place(*it, ys[0] if up else ys[-1], up, r)
    # the rules' words: over everything placed, each in the first free row going up
    top = min([b[1] for b in boxes] + [ys[0] - r]) - 6
    ref_boxes = []
    for i, rf in enumerate(sorted(f.refs, key=lambda rf: rf["v"])):
        lab = [(esc(word("dot.mean")), word("dot.mean"), 400, "var(--t-body)")] if rf["kind"] == "mean" else \
              [(FX.entry(s, "tspan", None) if s else esc(t), t, 400, "var(--t-body)") for t, s in K.segs(rf["label"], f"ref {rf['kind']}'s label")]
        ps = lab + [(" ", " ", 400, "var(--t-body)"), (K.ent(rf["text"])[0], FX.text(rf["text"]), 700, "var(--t-title)")]
        w = tw("".join(t for _, t, _, _ in ps), size)
        xv = f.x(rf["v"])
        anchor = "middle" if f.x0 - 8 + w / 2 <= xv <= f.W - 8 - w / 2 else "start" if xv < f.W / 2 else "end"
        x0 = xv - w / 2 if anchor == "middle" else xv if anchor == "start" else xv - w
        for t in range(8):
            base = top - t * step - size * 0.25
            b = (x0, base - size * 0.8, x0 + w, base + size * 0.25)
            if not any(overlaps(b, o) for o in ref_boxes) and not any(crosses((f.x(o["v"]), -10 ** 6, 10 ** 6), b) for o in f.refs if o is not rf):
                ref_boxes.append(b); rf["base"] = base; break
        else: raise Refused(f"dot_strip: the {rf['kind']} rule's words find no free row")
        out.append((f"ref {rf['kind']}", ps, xv if anchor == "middle" else x0 if anchor == "start" else x0 + w, rf["base"], anchor, None))
    return out, ys


def inline(B, ps, x, y, size, anchor, tag):
    inner = "".join(f'<tspan font-weight="{wt}" fill="{fill}">{svg}</tspan>' for svg, _, wt, fill in ps)
    return K.txt(B, x, y, size, "var(--t-body)", inner, tw("".join(t for _, t, _, _ in ps), size), anchor=anchor, tag=tag)


def cl_dot_strip(f, occ):
    d, size, W, r = f.d, f.size, f.W, f.r
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    plan, ys = _plan(f)
    top_rel = min([base - size * 0.8 for _, _, _, base, _, _ in plan] + [ys[0] - r])
    y0 = 22 + size * 1.2 + 10 - top_rel   # the first row's y on the picture
    Y = lambda y: y0 + y
    bottom = max([base + size * 0.25 for _, _, _, base, _, _ in plan] + [ys[-1] + r])
    # the row labels left of the rows: the periods, or the groups' words
    for i, y in enumerate(ys):
        if f.groups:
            o.append(K.words(B, f.groups[i]["label"], f"group {f.groups[i]['id']}", f.x0 - r - 12, Y(y) + size * 0.35, size, "var(--t-title)", anchor="end", weight=700)[0])
        else:
            svg_t, text = f.periods[i]
            o.append(K.txt(B, f.x0 - r - 12, Y(y) + size * 0.35, size, "var(--t-title)" if i == len(ys) - 1 else "var(--t-sec)", svg_t, tw(text, size),
                           anchor="end", weight=700, tag=f"period {text}"))
        o.append(K.line(f.x0 - r, Y(y), f.x1 + r, Y(y), stroke="var(--bar)", w=1, op=1))
    # the rules: from their words down through every row; the target dashed, the average and the whole solid thin
    for rf in f.refs:
        xv = f.x(rf["v"])
        dash = ' stroke-dasharray="5 4"' if rf["kind"] == "target" else ""
        # an average or a whole is the later period's: with two period rows its rule breaks over the earlier row
        y_a, y_b = Y(rf["base"]) + size * 0.25 + 3, Y(ys[-1]) + r + 3
        spans = [(y_a, Y(ys[0]) - r - 3), (Y(ys[0]) + r + 3, y_b)] if f.two and rf["kind"] != "target" else [(y_a, y_b)]
        for ya, yb in spans:
            o.append(f'<line x1="{xv:.1f}" y1="{ya:.1f}" x2="{xv:.1f}" y2="{yb:.1f}" stroke="var(--t-title)" '
                     f'stroke-width="{1.4 if rf["kind"] == "target" else 1}"{dash} data-rule="{rf["kind"]}"/>')
    # the group averages: a short tick in ink across the row
    for i, g in enumerate(f.groups or []):
        if g["mean"] is not None:
            xv = f.x(g["mean"])
            o.append(f'<line x1="{xv:.1f}" y1="{Y(ys[i]) - r - 4:.1f}" x2="{xv:.1f}" y2="{Y(ys[i]) + r + 4:.1f}" stroke="var(--t-title)" stroke-width="2" data-mean="{esc(g["id"])}"/>')
    # the earlier row's joins and dots, then the later dots (grey first, the lead dots over them)
    ghost = f.two and f.k("ghost_period") == "on"
    rows = sorted(f.rows, key=lambda rw: (rw["code"] in f.lead, rw["code"]))
    if f.two:
        for rw in rows:
            hot = rw["code"] in f.lead
            xb, xa = f.x(rw["b"]), f.x(rw["a"])
            if ghost:
                o.append(f'<line x1="{xb:.1f}" y1="{Y(ys[0]) + r:.1f}" x2="{xa:.1f}" y2="{Y(ys[1]) - r:.1f}" stroke="{"var(--accent)" if hot else "var(--t-sec)"}" '
                         f'stroke-width="{1.2 if hot else 0.7}" stroke-opacity="{1 if hot else 0.45}" data-join="{esc(rw["code"])}"/>')
                o.append(f'<circle cx="{xb:.1f}" cy="{Y(ys[0]):.1f}" r="{r}" fill="none" stroke="{"var(--accent)" if hot else "var(--t-sec)"}" stroke-width="1.2" '
                         f'data-code="{esc(rw["code"])}" data-period="earlier"/>')
            else:
                o.append(f'<circle cx="{xb:.1f}" cy="{Y(ys[0]):.1f}" r="{r}" fill="var(--t-sec)" fill-opacity="0.35" data-code="{esc(rw["code"])}" data-period="earlier"/>')
    gy = {g["id"]: ys[i] for i, g in enumerate(f.groups)} if f.groups else {}
    for rw in rows:
        hot = rw["code"] in f.lead
        y = gy.get(rw["group"], ys[-1])
        fill = 'fill="var(--accent)"' if hot else 'fill="var(--t-sec)" fill-opacity="0.5"'
        o.append(f'<circle cx="{f.x(rw["a"]):.1f}" cy="{Y(y):.1f}" r="{r}" {fill} stroke="var(--bg)" stroke-width="0.8" data-code="{esc(rw["code"])}"/>')
    # the leaders, then the labels
    for tag, ps, x, base, anchor, ld in plan:
        if ld:
            o.append(f'<line x1="{ld[0]:.1f}" y1="{Y(ld[1]):.1f}" x2="{ld[0]:.1f}" y2="{Y(ld[2]):.1f}" stroke="var(--t-sec)" stroke-width="0.8" data-leader="{esc(tag)}"/>')
        o.append(inline(B, ps, x, Y(base), size, anchor, tag))
    y = Y(bottom)
    if f.ticks:   # the axis under everything: a hairline, its ticks and their numbers
        ya = y + 8
        o.append(K.line(f.x0, ya, f.x1, ya, stroke="var(--bar)", w=1, op=1))
        for v, (svg_t, text) in f.ticks:
            xv = f.x(v)
            o.append(K.line(xv, ya, xv, ya + 4, stroke="var(--bar)", w=1, op=1))
            o.append(K.txt(B, xv, ya + 6 + size * 0.8, size, "var(--t-sec)", svg_t, tw(text, size), anchor="middle", tag=f"tick {text}"))
        y = ya + 6 + size
    for key in ("omit", "footnote"):
        if d.get(key):
            y += size * 1.5
            o.append(K.words(B, d[key], key, 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)[0])
    f.H = int(y + 12); B.h = f.H
    for (x0, y0_, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


DOT_STRIP_LAYERS = dict(dot_strip=(cl_dot_strip, None))
DOT_STRIP_SVG = ["dot_strip"]


def draw(h):
    f = Frame(h)
    inner = cl_dot_strip(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "dot_strip"), f.W, f.H
