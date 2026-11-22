"""gap_axis layer: the whole argument on one value axis, in line.py's layer style: where the subject is now (a filled dot
in the accent, its value large above the axis and its words below), where each projected pace lands (grey dots, each
with its value and words on a leader, above or below the axis), the target (a hollow dot in ink, its value large above
and its words below), a grey band from now to the mark that gets furthest toward the target, and a dashed box from that
mark to the target: the gap, named under it. The target may lie above or below now (a share to raise, an emission to cut);
the gap is drawn only where no mark reaches the target.
Every printed number is a ledger entry printed with FX.entry; every word comes with the request as segments.

hero.data (the data shape this leaf eats; run.py leaf): {
  "title": segs, "unit": segs,                      # the unit is written once, in the head
  "axis": {"ticks": [ledger src, ...],              # ascending, each printed text a number; the axis runs first..last tick
           "scale": number},                        # a printed number is its raw value times scale (its format's)
  "now": {"text": ledger src, "at": series src?,    # where the subject is: its value as printed; its place from the cell
          "label": segs},                           # when "at" is given, else from the printed number
  "marks": [{"text": ledger src, "label": segs}],   # each projected pace's value at the target period (layer 1's facts)
  "target": {"text": ledger src, "label": segs},    # the target value as printed and its words
  "gap_label": segs?,                               # the gap's words (a {"src"} segment prints the gap's own fact)
  "lines": [segs, ...]?, "footnote": segs?}         # layer 1's lines under the picture, one line each
segs: as wbkit.segs reads them; series src: a cell of the request's rows (geometry only); ledger src: a row {"src", "text"}.
needs I4 facts (derived numbers this leaf reads and never computes; placeholder key names): proj_<code>_<year> (each mark: a
pace carried on to the target year), target_<code> (the target value), gap_<code> (the gap, when gap_label prints it).
needs new wording: none fixed; the gap's name, each mark's words ("at the past average pace", ...) and the now/target
words come from the data as segments.
Placement: the tick labels under the axis; every other text tried row by row, nearest the axis first (marks above, then
below, alternately), and taken at the first row where it overlaps no text and no leader; every box is checked again in
wbkit.Boxes.
Refuses: fewer than two ticks, a tick whose text is no number or ticks not ascending, a value text that is no number, a
point off the axis, a target at the now point, a gap_label where a mark reaches the target, a label that finds no free row
within knob levels, a digit in a literal word, a text that leaves the picture or overlaps another, a board too narrow
(axis under 240 px)."""
import re

import wbkit as K  # the shared drawing kit; run.py's folder is on the path (a node reads no file: one import, no path set-up)

FX, prod, Refused, esc, tw = K.FX, K.prod, K.Refused, K.esc, K.tw

NODE = "gap_axis"
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), big_size=(22, (14, 32, 1), "size px of the now and target values"),
    dot_r=(5, (3, 8, 0.5), "a mark's dot radius px (now and target are drawn larger)"),
    band_h=(14, (8, 24, 1), "height px of the band and of the gap box on the axis"),
    levels=(3, (1, 5, 1), "label rows tried on each side of the axis before refusing"))

NUM = re.compile(r"[-−]?[0-9][0-9,]*(?:\.[0-9]+)?%?")


def number(src, scale, what):
    """The raw value a ledger entry prints (its number over the format's scale); a text that is no number refuses."""
    text = FX.text(src).strip()
    if not NUM.fullmatch(text): raise Refused(f"gap_axis: {what} {text!r} ({src}) is no number")
    return float(text.replace(",", "").replace("−", "-").rstrip("%")) / scale


def pieces(v, what, bold_src=None):
    """[(text, src or None, bold)] of an optional bold value then the words' segments (wbkit.segs checks them)."""
    out = [(FX.text(bold_src), bold_src, True), (" ", None, False)] if bold_src else []
    return out + [(t, s, False) for t, s in K.segs(v, what)]


def inline(B, ps, x, y, size, fill, anchor="middle", weight=400, tag="text", style=""):
    """One <text> of pieces: an entry marked with its src (bold where asked), words escaped; its box checked in B."""
    inner = "".join((f'<tspan font-weight="700">{FX.entry(s, "tspan", None) if s else esc(t)}</tspan>' if b else
                     FX.entry(s, "tspan", None) if s else esc(t)) for t, s, b in ps)
    return K.txt(B, x, y, size, fill, inner, tw("".join(t for t, _, _ in ps), size), anchor=anchor, weight=weight, tag=tag, style=style)


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size, f.W = d, k, k("size"), k("width")
        axis = d.get("axis") or {}
        scale = axis.get("scale")
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not scale > 0: raise Refused(f"gap_axis: the axis scale {scale!r} is no number above 0")
        ticks = axis.get("ticks")
        if not isinstance(ticks, list) or len(ticks) < 2: raise Refused("gap_axis: the axis holds fewer than two ticks (its ends)")
        f.ticks = []
        for src in ticks:
            raw = number(src, scale, "the tick")
            if f.ticks and raw <= f.ticks[-1][0]: raise Refused(f"gap_axis: the ticks are not ascending at {src}")
            f.ticks.append((raw, K.ent(src)))
        f.lo, f.hi = f.ticks[0][0], f.ticks[-1][0]

        def point(p, what):
            if not isinstance(p, dict) or not p.get("text"): raise Refused(f"gap_axis: {what} names no text (the ledger entry its value prints from)")
            v = K.val(p["at"]) if p.get("at") is not None else number(p["text"], scale, f"{what}'s value")
            if not f.lo <= v <= f.hi: raise Refused(f"gap_axis: {what} at {v:g} is off the axis {f.lo:g}..{f.hi:g}")
            K.segs(p.get("label"), f"{what}'s label")
            return dict(v=v, text=p["text"], label=p["label"], what=what)
        f.now = point(d.get("now"), "now")
        f.target = point(d.get("target"), "the target")
        marks = d.get("marks") or []
        if not isinstance(marks, list): raise Refused(f"gap_axis: marks is {marks!r}; marks is a list")
        f.marks = [point(m, f"mark {i + 1}") for i, m in enumerate(marks)]
        f.dir = 1 if f.target["v"] > f.now["v"] else -1 if f.target["v"] < f.now["v"] else 0
        if f.dir == 0: raise Refused("gap_axis: the target is at the now point; there is no way to draw")
        # the mark that gets furthest toward the target; the gap runs from it (or from now) to the target
        f.far = max(f.marks, key=lambda m: (m["v"] - f.now["v"]) * f.dir) if f.marks else None
        reach = [m["what"] for m in f.marks if (m["v"] - f.target["v"]) * f.dir >= 0]
        f.gap = None if reach else ((f.far or f.now)["v"], f.target["v"])
        if reach and d.get("gap_label"): raise Refused(f"gap_axis: {reach[0]} reaches the target; there is no gap for gap_label to name")
        f.x0, f.x1 = 24.0, f.W - 24.0
        if f.x1 - f.x0 < 240: raise Refused("gap_axis: the board is too narrow (axis under 240 px)")
        f.H = 0

    def x(f, v):
        return f.x0 + (f.x1 - f.x0) * (v - f.lo) / (f.hi - f.lo)


def _plan(f):
    """Rows for every text but the ticks, relative to the axis at y 0: [(key, pieces, x, baseline, size, weight, leader)]
    where leader is (x, y_from, y_to) or None. A text goes to the first row (nearest the axis first) where its box overlaps
    no placed box and no placed leader, and its leader crosses no placed box."""
    size, big, W = f.size, f.k("big_size"), f.W
    r_big = f.k("dot_r") + 3
    above0 = -(f.k("band_h") / 2 + 6)                       # the baseline of the nearest row above the axis
    below0 = f.k("band_h") / 2 + 4 + size * 1.1 + size * 0.25 + 8 + size * 0.8  # under the tick labels
    step = size * 1.5
    boxes, leaders, out = [], [], []
    for raw, (_, text) in f.ticks:  # the tick labels' row under the axis (cl_gap_axis draws them there)
        w, ty = tw(text, size), f.k("band_h") / 2 + 4 + size * 1.1
        boxes.append((f.x(raw) - w / 2, ty - size * 0.8, f.x(raw) + w / 2, ty + size * 0.25))

    def box(x, y, w, s, anchor="middle"):
        x0 = x - w / 2 if anchor == "middle" else x
        return (x0, y - s * 0.8, x0 + w, y + s * 0.25)

    def free(b, ld):
        for a in boxes:
            if b[0] < a[2] + 6 and a[0] < b[2] + 6 and b[1] < a[3] + 2 and a[1] < b[3] + 2: return False
        for lx, ya, yb in leaders:
            if b[0] - 2 < lx < b[2] + 2 and min(ya, yb) < b[3] and b[1] < max(ya, yb): return False
        if ld:
            lx, ya, yb = ld
            for a in boxes:
                if a[0] - 2 < lx < a[2] + 2 and min(ya, yb) < a[3] and a[1] < max(ya, yb): return False
        return True

    def place(key, ps, xv, s, weight, sides, dot, lead=True):
        w = tw("".join(t for t, _, _ in ps), s)
        x = min(max(xv, 8 + w / 2), W - 8 - w / 2)  # kept inside the picture; the leader still starts at the point
        tries = [(side, j) for j in range(f.k("levels")) for side in sides]
        for side, j in tries:
            if side == "up":
                base = above0 - j * step - (s - size) * 0.25  # the box's foot on the row's foot, whatever the size
                b = box(x, base, w, s)
                ld = (xv, -dot, b[3] + 1)
            else:
                base = below0 + j * step
                b = box(x, base, w, s)
                ld = (xv, dot, b[1] - 1)
            if not lead or ld[2] * (1 if side == "down" else -1) <= ld[1] * (1 if side == "down" else -1) + 4: ld = None
            if not free(b, ld): continue
            boxes.append(b)
            if ld: leaders.append(ld)
            out.append((key, ps, x, base, s, weight, ld)); return
        raise Refused(f"gap_axis: {key} finds no free row within {f.k('levels')} rows of the axis; fewer marks or a wider board")

    for p in (f.now, f.target):  # the two ends: the value large above, the words below
        xv = f.x(p["v"])
        place(f"{p['what']} value", [(FX.text(p["text"]), p["text"], False)], xv, big, 900, ("up",), r_big)
    for p in (f.now, f.target):
        place(f"{p['what']} label", pieces(p["label"], f"{p['what']}'s label"), f.x(p["v"]), size, 400, ("down",), r_big, lead=False)
    if f.gap and f.d.get("gap_label"):
        place("the gap label", pieces(f.d["gap_label"], "gap_label"), (f.x(f.gap[0]) + f.x(f.gap[1])) / 2, size, 700, ("down",), f.k("band_h") / 2, lead=False)
    for m in sorted(f.marks, key=lambda m: m["v"]):
        place(f"{m['what']}", pieces(m["label"], f"{m['what']}'s label", m["text"]), f.x(m["v"]), size, 400, ("up", "down"), f.k("dot_r"))
    return out


def cl_gap_axis(f, occ):
    d, size, W = f.d, f.size, f.W
    B = K.Boxes(W, 10 ** 6); o = [K.head(B, d["title"], d["unit"], size, f.k("title_size"))]
    plan = _plan(f)
    top_rel = min(base - s * 0.8 for _, _, _, base, s, _, _ in plan)
    ya = 22 + size * 1.2 + 8 - top_rel
    bh, r = f.k("band_h"), f.k("dot_r")
    # the axis and its ticks; the tick labels under it
    o.append(K.line(f.x0, ya, f.x1, ya, stroke="var(--bar)", w=2, op=1))
    for raw, (svg_t, text) in f.ticks:
        x = f.x(raw)
        o.append(K.line(x, ya - 4, x, ya + 4, stroke="var(--bar)", w=1.2, op=1))
        o.append(K.txt(B, x, ya + bh / 2 + 4 + size * 1.1, size, "var(--t-sec)", svg_t, tw(text, size), anchor="middle", tag=f"tick {text}"))
    # the band from now to the furthest mark, then the gap box from there to the target
    if f.far is not None:
        a, b = sorted((f.x(f.now["v"]), f.x(f.far["v"])))
        o.append(f'<rect x="{a:.1f}" y="{ya - bh / 2:.1f}" width="{b - a:.1f}" height="{bh}" fill="var(--bar)" fill-opacity="0.55" data-part="band"/>')
    if f.gap:
        a, b = sorted(f.x(v) for v in f.gap)
        o.append(f'<rect x="{a:.1f}" y="{ya - bh / 2:.1f}" width="{b - a:.1f}" height="{bh}" fill="none" stroke="var(--t-title)" '
                 f'stroke-width="1.2" stroke-dasharray="3 3" data-part="gap"/>')
    # leaders, then the dots: marks grey, now filled in the accent, the target hollow in ink
    for _, _, _, _, _, _, ld in plan:
        if ld: o.append(K.line(ld[0], ya + ld[1], ld[0], ya + ld[2], stroke="var(--t-sec)", w=0.8, op=0.8))
    for m in f.marks:
        o.append(f'<circle cx="{f.x(m["v"]):.1f}" cy="{ya:.1f}" r="{r}" fill="var(--t-sec)" data-part="mark"/>')
    o.append(f'<circle cx="{f.x(f.target["v"]):.1f}" cy="{ya:.1f}" r="{r + 3}" fill="var(--bg)" stroke="var(--t-title)" stroke-width="2.6" data-part="target"/>')
    o.append(f'<circle cx="{f.x(f.now["v"]):.1f}" cy="{ya:.1f}" r="{r + 3}" fill="var(--accent)" stroke="var(--accent)" stroke-width="2.6" data-part="now"/>')
    serif = f' font-family="{K.SERIF}"'
    for key, ps, x, base, s, weight, _ in plan:
        fill = ("var(--accent)" if key.startswith("now value") else "var(--t-title)" if key.endswith("value") or key == "the gap label"
                else "var(--t-body)")
        o.append(inline(B, ps, x, ya + base, s, fill, weight=weight, tag=key, style=serif if key.endswith("value") else ""))
    y = max(b[3] for b, _ in B.b) + size * 0.4
    lns = d.get("lines") or []
    if not isinstance(lns, list): raise Refused(f"gap_axis: lines is {lns!r}; lines is a list of segment lists")
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


GAP_AXIS_LAYERS = dict(gap_axis=(cl_gap_axis, None))
GAP_AXIS_SVG = ["gap_axis"]


def draw(h):
    f = Frame(h)
    inner = cl_gap_axis(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "gap_axis"), f.W, f.H
