"""leader_notes layer: short notes set at the side of the map, each with a thin leader to its point on the map, kept clear of every box and line in
the Occ. Ported from the second-layer node runtime/nodes/leader_notes.mjs to column.py's layer style. WHAT THE TREE ALREADY HAS and this does not copy:
scmp.sq_notes / rl_callouts make the hero's callouts as html columns (stacked by a browser script, one fixed column on each side of the picture, from the
gas page's own facts); this layer places svg notes inside the picture from the request's own rows and checks the placement in the Occ, so a note can
never sit on a flow line or a label another layer claimed. Reused: prod.Occ (hit, on_line), prod.tw, mapkit.View (the frame flow_lines also uses).
hero.data: {"ext": [lon0, lat0, lon1, lat1], "hub": {"lonlat": [lon, lat]}?, "name_kind": "place"|<kind>,
  "notes": [{"at": [lon, lat] | "hub", "name": code?, "text": segs?, "value_text": src?}]}     # at least a name or text; made by the program, never typed
A note is one short line: its name (the request's label, marked with its name row) and/or its words (segments: literals without a digit, {"word": key},
{"src": entry}), then value_text in bold, a ledger entry (the number). Nothing else is printed. A note wider than half the picture on one line is
set on two at its one fixed break, the name and words above, the bold value_text below (each line's own width by the same rule, each within half
the picture; one box over both lines is placed and claimed, LINE em apart); a note without both, or still too wide, refuses.
Colours: --t-title the note, --t-sec the leader, --accent the highlighted note, --bg the text halo. A note is tried on a STEP px grid across the whole
picture (side left or right: only at that edge); of the free boxes (off every claimed box and line) with a clear leader it takes the cheapest:
the leader's length, plus LAND_COST px when the box sits over the land (occ.land, set by bubbles in the shared frame; the sea or the open margin
is preferred, and a note over the land keeps its halo and stays off every circle, label and line) and BEND_COST px for a bend. The leader runs
from the box's nearest side (or an end or a corner) straight, or with one right-angle bend (across, then down or up; or the other way), and keeps
3 px off every claimed box and 2 px off every circle (occ.circles) but the ones its own point lies in (it ends on what it points at), and LEAD_GAP
px off every other leader drawn (it crosses none); only a note none of whose places has such a leader tries two bends (across, along,
across, or the mirror, the middle run on a GRID px grid, 2 BEND_COST), while the layer's TWO_BEND_CHECKS last: one count for all its notes, each piece
charged its 2 px steps times what each is tested against (boxes, circles, 9 leader cells), never the clock. Measured (the layer alone, median of 3): a
two-bend budget per note only took the Europe sweep's 30 circles from 1.93 to 2.22 s and 60 from 1.34 to 1.91 (the deadline 2 s); shared, 1.97 and 1.37,
the same notes dropped as before two bends; a count of pieces alone could not hold both (200 left the walled room's door unfound, it walks 568 short
pieces; 500 cost the 60 circles 0.18 s), the charge does: the q6 page's Iraq takes 0.43 M, the room 0.33 M, the EU page's crossing test 1.2 M, a crowded map's first walled note spends
the 1.5 M; each piece then walked from its point end against only what its bounds reach (lead_clear, the same answers) took the 30
circles from 1.97 to 0.45 s, 50 from 0.72 to 0.11, the crowded EU map 2.49 to 0.63. Measured on the q1 and q6 column pages (replayed offline): sea only and straight kept 1 of
their 4 notes, the bend alone 2, the land alone 3, both 4 (the sea first, whatever the length, gave a 400 px leader round the map);
a note with no free place set as it is tries its other two-line breaks at a phrase boundary, narrowest first (breaks: the q5 change
page's Nigeria note, 249 px at the break before its number, placed at 208 px after its comma; the EU map's crowded 18 px notes kept
Germany's on two lines; no note of the q1, q6, change or crowded pages moved); a note with no free place in any of them (no
clear leader of up to two bends), or past label_count, is dropped and listed in Frame.dropped as (id, why), the id its name code (note<i>, its place in the
request from 1, when it has none); the layer still draws, empty when every note was dropped (run.py sends the list back for layer 1 to keep in
the page's ledger). The notes are placed top first, each against what those before it claimed; when that leaves a leader past
LONG_LEAD and drops none, they are placed bottom first too, and that order is kept when it drops none and its longest leader is shorter.
Refuses: no notes, a note without a name or text, a point that is not [lon, lat] (or "hub" without a hub), a note under 16 px (note_size min), a note wider than
half the picture (on two lines too), a missing label or ledger entry, a digit in a literal, a knob off its range."""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
import mapkit as MK
from wbkit import FX, prod, Refused, esc, tw

prod.KNOBS["leader_notes"] = dict(
    palette=("grey_accent", ("grey_accent", "mono"), "mono: the highlight is ink too"), label_count=(6, (0, 12, 1), "notes drawn (the rest are dropped and listed)"),
    note_size=(16, (16, 22, 1), "note size px; 16 at least"), side=("auto", ("auto", "left", "right"), "which edge the notes sit at"),
    highlight=("", None, "name code of the note drawn in the accent"),
    first=("", None, "name codes of the notes a page cannot lose (its focus): when the plain order leaves one with no place, they are laid out first; codes no note names are ignored"),
    width=(1140, (400, 1400, 10), "picture width px"))
NODE = "leader_notes"
MAX_ROWS = 400
STEP = 24  # px between the places a note is tried at across the picture
LEAD_GAP = 3  # px a note's leader keeps off every other leader's points (sampled at 4 px at most: a crossing comes within 3 px)
LAND_COST = 80  # px a note over the land costs against one in the sea or the open margin
BEND_COST = 40  # px a leader's bend costs against a straight one
LINE = 1.35  # em between a two-line note's baselines: the page check's glyph box (1.06 above, 0.27 below) of one line stays off the other's
LONG_LEAD = 120  # px of leader past which the notes, placed top first, are also tried bottom first (B5 11-04: the q4 page's China note took a 243 px leader round the USA note placed before it; bottom first, 29)
TRIES = 600  # leaders walked per note, cheapest first: a crowded picture stays within the layer's deadline (next_leaf LAYER_DEADLINE)
GRID = 6  # px between the columns (rows) a two-bend leader's middle run is tried at
TRIES2 = 600  # two-bend leader pieces walked per note at most (past its last runs, one per GRID column and row), when no straight or one-bend leader clears
ALT_BREAKS = 3  # other two-line layouts (breaks) a note with no free place tries, narrowest first, before it drops
TWO_BEND_CHECKS = 1_500_000  # point tests the whole layer's two-bend leaders may make, shared by every note (a piece costs its 2 px steps times the boxes, circles and 9 leader cells each is tested against): past it a note with no straight or one-bend leader drops (q6's Iraq takes 0.43 M; 1.5 M cost the 30-circle Europe map 0.04 s)


class Frame:
    def __init__(f, h, bars=None):
        """bars (a column page with no map, run.bar_notes): {"ends": {code: (x, y)}, "W", "H"}, the end of each bar's printed
        value in the bars' picture, which a note's name points at instead of its map point (its at is not read); a note whose
        name no bar draws refuses."""
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.h, f.d, f.k = h, d, k; f.size = size = k("note_size")
        if bars is None: f.v = v = MK.View(h, NODE); f.W, f.H = v.W, v.H
        else: f.v = v = None; f.W, f.H = bars["W"], bars["H"]
        notes = [dict(n) for n in (d.get("notes") or [])]
        if not notes: raise Refused("leader_notes: the request holds no notes")
        if len(notes) > MAX_ROWS: raise Refused(f"leader_notes: at most {MAX_ROWS} notes, got {len(notes)}")
        kind = d.get("name_kind", "place")
        for i, n in enumerate(notes):
            n["_id"] = n.get("name") or f"note{i + 1}"; at = n.get("at")
            if bars is not None:
                if n.get("name") not in bars["ends"]: raise Refused(f"leader_notes: note {i + 1} names {n.get('name')}, which no bar draws")
                n["_pt"] = tuple(bars["ends"][n["name"]])
            elif at == "hub":
                if v.hub is None: raise Refused(f"leader_notes: note {i + 1} points at the hub and the request gives none")
                at = v.hub
            if bars is None: n["_pt"] = v.at(v.lonlat(at, f"leader_notes: note {i + 1}"))  # a place beyond the frame is pointed at where its flow line enters (found by pagecheck: the raw point lay outside the picture)
            if not n.get("name") and not n.get("text"): raise Refused(f"leader_notes: note {i + 1} has neither a name nor words")
            parts, wd, plain, head = [], 0.0, [], 0.0
            if n.get("name"): nm = K.named(n["name"], kind); parts.append(nm[0]); wd += tw(nm[1], size); plain.append(nm[1])
            if n.get("text"):
                inner, w_, p_ = MK.inline(n["text"], size, f"note {i + 1} text"); parts.append(inner); wd += w_ + (size * 0.3 if parts[:-1] else 0); plain.append(p_)
            if n.get("value_text"):  # the number last, bold (a bold glyph runs about 6% wider than tw's estimate)
                head = wd; val = K.ent(n["value_text"]); parts.append(f'<tspan font-weight="700">{val[0]}</tspan>'); wd += tw(val[1], size) * 1.06 + (size * 0.3 if parts[:-1] else 0); plain.append(val[1])
            # never narrower than layer 1 reads the line back (the whole text, its spaces included, by the same width rule)
            n["_inner"], n["_w"], n["_lines"] = " ".join(parts), max(wd, tw(" ".join(plain), size)), None
            wd = n["_w"]
            if wd > f.W / 2 and n.get("value_text") and parts[:-1]:  # the one break: the name and words above, the bold number (its ledger entry, whole) below
                lines = [(" ".join(parts[:-1]), max(head, tw(" ".join(plain[:-1]), size))), (parts[-1], tw(val[1], size) * 1.06)]; w2 = max(w for _, w in lines)
                if w2 <= f.W / 2: n["_lines"], n["_w"], wd = lines, w2, w2
            if wd > f.W / 2: raise Refused(f"leader_notes: note {i + 1} is wider than half the picture at {size} px ({wd:.0f} px of {f.W / 2:.0f}, W {f.W}: '{' '.join(plain)}')")  # the words and widths recorded so a refused note can be read back
            n["_alts"] = breaks(nm if n.get("name") else None, K.segs(n["text"], f"note {i + 1} text") if n.get("text") else [], val if n.get("value_text") else None,
                                size, f.W / 2, [l for l, _ in n["_lines"] or [(n["_inner"], 0)]])
        f.hl = K.check_codes(NODE, k("highlight"), {n["name"] for n in notes if n.get("name")}) if k("highlight") else set()
        f.first = {c for c in str(k("first") or "").split(",") if c} & {n["name"] for n in notes if n.get("name")}
        f.pal, f.side = k("palette"), k("side"); f.notes = notes; f.dropped = []


def breaks(name, sg, val, size, half, default):
    """A note's other two-line layouts, tried in turn when its own one (one line, or two at the break before its number) has no
    free place: the break moved to another phrase boundary, as editorial CJK wrapping sets it (by phrase, not by glyph: BudouX;
    W3C clreq's line-start rule): after the name, between two of its word segments (each word or literal whole) or before the
    number, never inside the name, a word or a ledger entry, and no line starts with a closing mark (line.no_start: a segment's
    leading mark stays at the end of the line above, as wbkit.units_of keeps it). Each line keeps a marked text (the name, or a
    ledger entry: layer 1 takes no text without a source), so a note of a name and a number alone breaks between the two. Each
    line's width by the one-line rule (the parts a 0.3 em gap apart, the bold number 6% wider, never under tw of the whole
    line), each within `half`; `default`, the note's own lines (inner only), left out. [(lines, width)], the narrowest
    ALT_BREAKS first."""
    toks = [(name[0], name[1], 0, True)] if name else []  # (inner, plain, part: name 0, words 1, number 2, marked)
    for t, src in sg:
        if src: toks.append((FX.entry(src, "tspan", None), t, 1, True)); continue
        head = len(t) - len(t.lstrip(K.NO_LINE_START))  # a leading closing mark joins the words before it
        if head and toks and toks[-1][2] == 1: p = toks.pop(); toks.append((p[0] + esc(t[:head]), p[1] + t[:head], 1, p[3])); t = t[head:]
        if t: toks.append((esc(t), t, 1, False))
    if val: toks.append((f'<tspan font-weight="700">{val[0]}</tspan>', val[1], 2, True))

    def line(ts):
        parts = [p for p in ([t for t in ts if t[2] == j] for j in (0, 1, 2)) if p]
        plain = " ".join("".join(t[1] for t in p) for p in parts)
        w = sum(tw("".join(t[1] for t in p), size) * (1.06 if p[0][2] == 2 else 1) for p in parts) + size * 0.3 * (len(parts) - 1)
        return " ".join("".join(t[0] for t in p) for p in parts), max(w, tw(plain, size))
    out = []
    for j in range(1, len(toks)):
        a, b = toks[:j], toks[j:]
        if not (any(t[3] for t in a) and any(t[3] for t in b)) or b[0][1][:1] in K.NO_LINE_START or b[0][1][:1].isspace(): continue
        lines = [line(a), line(b)]; w = max(x for _, x in lines)
        if w <= half and [l for l, _ in lines] != default: out.append((w, j, lines))
    return [(lines, w) for w, _, lines in sorted(out)[:ALT_BREAKS]]


def cl_leader_notes(f, occ):
    k, W, H, size = f.k, f.W, f.H, f.size; o = ['<g data-node="leader_notes">']; f.dropped = []
    lead, margin, land = size * 1.4, 8, getattr(occ, "land", None)
    items = sorted(f.notes, key=lambda n: (n["_pt"][1], str(n.get("name")))); keep, rest = items[: int(k("label_count"))], items[int(k("label_count")):]
    f.dropped += [(n["_id"], "past label_count") for n in rest]
    acc = lambda n: f.pal == "grey_accent" and n.get("name") in f.hl
    left = TWO_BEND_CHECKS  # point tests the layer's two-bend leaders may still make, across all its notes

    # a circle a map layer drew (occ.circles: x, y, r and the box it claimed) is passed as the circle, not its square
    circles = getattr(occ, "circles", None) or []; squares = {c[3] for c in circles}

    def leader_cells():
        """Every leader's points drawn so far (occ lines tagged leader), in LEAD_GAP px cells."""
        g = {}
        for x, y, _, t in occ.pts:
            if t == "leader": g.setdefault((int(x // LEAD_GAP), int(y // LEAD_GAP)), []).append((x, y))
        return g

    def lead_clear(edge, end, pt, boxes, rings, cells):
        """One straight piece of the leader, from `edge` to `end`, walked at 2 px steps, keeps 3 px off every claimed box, 2 px off
        every circle (`boxes`, `rings`: those but the ones its own point `pt` lies in; the leader ends on what it points at) and
        LEAD_GAP px off every other leader (`cells`). The answer is all of its sample points', so they are walked from the point end
        (where the circles crowd, so a blocked piece stops within a few steps) and tested only against the boxes and circles the
        piece's own bounds reach, widened 1 px past the 3 (and r + 2) a point is kept off (a dropped one could meet no point: the
        same answer). Measured (the layer alone, median of 3): the Europe sweep's 30 circles from 1.97 to 0.45 s,
        67 from 0.80 to 0.13, the crowded EU map (12 notes of 22 px) 2.49 to 0.63, the q6 page 0.10 to 0.02."""
        steps = max(1, math.ceil(math.dist(edge, end) / 2))
        x0, x1, y0, y1 = min(edge[0], end[0]), max(edge[0], end[0]), min(edge[1], end[1]), max(edge[1], end[1])
        boxes = [q for q in boxes if q[0] < x1 + 4 and q[2] > x0 - 4 and q[1] < y1 + 4 and q[3] > y0 - 4]
        rings = [c for c in rings if x0 - c[2] - 3 <= c[0] <= x1 + c[2] + 3 and y0 - c[2] - 3 <= c[1] <= y1 + c[2] + 3]
        for i in range(steps, -1, -1):
            a = (edge[0] + (end[0] - edge[0]) * i / steps, edge[1] + (end[1] - edge[1]) * i / steps)
            if math.dist(a, pt) <= 10: continue
            if any(a[0] - 3 < q[2] and a[0] + 3 > q[0] and a[1] - 3 < q[3] and a[1] + 3 > q[1] for q in boxes): return False
            if any(math.dist(a, c[:2]) < c[2] + 2 for c in rings): return False
            cx, cy = int(a[0] // LEAD_GAP), int(a[1] // LEAD_GAP)
            if any(math.dist(a, q) < LEAD_GAP for gx in (cx - 1, cx, cx + 1) for gy in (cy - 1, cy, cy + 1) for q in cells.get((gx, gy), ())): return False
        return True

    def two_bends(pt, tried, boxes, rings, cells):
        """The cheapest clear leader with two right-angle bends from any of the `tried` boxes: across, along, across (its middle run at a
        GRID px column) or down, across, down (at a GRID px row), each run GRID px at least and off the note's own box, its cost as
        place's plus 2 BEND_COST. The last runs into the point are walked first, one per column and row; then the leaders through
        the clear ones, cheapest first, each piece walked once, TRIES2 pieces at most, while the layer's TWO_BEND_CHECKS last. (cost, b1, y, path) or None."""
        nonlocal left
        if left <= 0: return None  # the layer's two-bend checks are spent: the note drops
        seen = {}
        load = len(boxes) + len(rings) + 9  # the tests lead_clear makes at a step at most
        def clear(a, b):  # a piece walked is charged its tests at most against the layer's TWO_BEND_CHECKS; once they are spent none clears
            nonlocal left
            if (a, b) not in seen:
                left -= (math.ceil(math.dist(a, b) / 2) + 1) * load
                if left < 0: return False
                seen[(a, b)] = lead_clear(a, b, pt, boxes, rings, cells)
            return seen[(a, b)]
        def own(a, b, q):  # an axis-aligned run passes through the note's own box
            return max(a[0], b[0]) > q[0] and min(a[0], b[0]) < q[2] and max(a[1], b[1]) > q[1] and min(a[1], b[1]) < q[3]
        cols = [m for m in range(GRID, int(W) - GRID // 2, GRID) if abs(m - pt[0]) >= GRID and clear((m, pt[1]), pt)]
        rows = [m for m in range(GRID, int(H) - GRID // 2, GRID) if abs(m - pt[1]) >= GRID and clear((pt[0], m), pt)]
        if left <= 0: return None  # spent on the last runs
        paths = []
        for low, b1, y, (ex, ey) in tried:
            base = low - math.dist((ex, ey), pt) + 2 * BEND_COST
            paths += [(base + abs(m - ex) + abs(ey - pt[1]) + abs(pt[0] - m), len(paths) + i, b1, y, ((ex, ey), (m, ey), (m, pt[1]), pt)) for i, m in enumerate(c for c in cols if abs(c - ex) >= GRID)]
            paths += [(base + abs(m - ey) + abs(ex - pt[0]) + abs(pt[1] - m), len(paths) + i, b1, y, ((ex, ey), (ex, m), (pt[0], m), pt)) for i, m in enumerate(r for r in rows if abs(r - ey) >= GRID)]
        budget = len(seen) + TRIES2
        for cost, _, b1, y, path in sorted(paths):
            if len(seen) >= budget or left <= 0: break
            if not any(own(a, b, b1) for a, b in zip(path, path[1:])) and clear(path[1], path[2]) and clear(path[0], path[1]):
                return (cost, b1, y, list(path))
        return None

    def place(n, w1, lines):
        """The note's place, set as `lines` (None: one line) `w1` px wide: of every free box (one line, or both of a two-line note; side auto: anywhere in the picture on a STEP px grid; left or right: at
        that edge), the one whose clear leader (straight or with one bend) costs least (its
        length, LAND_COST over the land, BEND_COST a bend; two_bends when none has one); the leader is returned as its points, note end
        first. None when no box has one."""
        pt = n["_pt"]; found = []; dy = size * LINE * (len(lines) - 1) if lines else 0  # a two-line note's box reaches its second line
        x0s = [margin] if f.side == "left" else [W - margin - w1] if f.side == "right" else \
            sorted({*(margin + STEP * i for i in range(int((W - 2 * margin - w1) / STEP) + 1)), W - margin - w1})
        y = size + 2
        while y + size * 0.25 + dy <= H:
            for x0 in x0s:
                b1 = (x0, y - size * 0.9, x0 + w1, y + size * 0.25 + dy)
                if b1[0] < 0 or b1[2] > W or occ.hit(b1, pad=(1, 1)) or occ.on_line(b1, pad=1): continue
                near = (min(max(pt[0], b1[0] - 3), b1[2] + 3), min(max(pt[1], b1[1] - 3), b1[3] + 3))  # the box's nearest side
                if math.dist(near, pt) < 8: continue  # over its own point
                over = MK.on_land(land, b1)
                # the leader may leave from the nearest side, either end or a corner: a straight line from the nearest point
                # may run through a neighbour that one from a corner passes
                mid = (b1[1] + b1[3]) / 2
                for edge in {near, (b1[0] - 3, mid), (b1[2] + 3, mid), (b1[0], b1[3] + 3), (b1[2], b1[3] + 3), (b1[0], b1[1] - 3), (b1[2], b1[1] - 3)}:
                    found.append((math.dist(edge, pt) + LAND_COST * over, b1, y, edge))
            y += lead / 2
        boxes = [q for q in occ.boxes if not (q[0] <= pt[0] <= q[2] and q[1] <= pt[1] <= q[3]) and tuple(q[:4]) not in squares]
        rings = [c for c in circles if math.dist(c[:2], pt) > c[2]]; cells = leader_cells()
        best = None  # (cost, b1, y, path); a box's straight cost is the least any of its leaders can cost, so the walk stops past the best
        tried = sorted(found, key=lambda c: c[0])[:TRIES]
        for low, b1, y, edge in tried:
            if best and low >= best[0]: break
            # straight, or one right-angle bend at the point's column or at its row
            for path in ([edge, pt], [edge, (pt[0], edge[1]), pt], [edge, (edge[0], pt[1]), pt]):
                cost = low - math.dist(edge, pt) + sum(math.dist(a, b) for a, b in zip(path, path[1:])) + BEND_COST * (len(path) - 2)
                if (not best or cost < best[0]) and all(lead_clear(a, b, pt, boxes, rings, cells) for a, b in zip(path, path[1:])):
                    best = (cost, b1, y, path)
        if not best: best = two_bends(pt, tried, boxes, rings, cells)  # only where no straight or one-bend leader clears
        if not best: return None
        cost, b1, y, path = best
        anchor = "end" if (b1[0] + b1[2]) / 2 > W / 2 else "start"  # a note right of the middle keeps to its right edge
        return (b1[2] if anchor == "end" else b1[0]), anchor, y, b1, path, cost

    def lay(order):
        """The notes placed in `order`, each against what those before it claimed (added to occ): (svg parts, dropped, the
        leaders' total cost, the longest leader's length)."""
        B, o, dropped, total, longest = K.Boxes(W, H), [], [], 0.0, 0.0
        for n in order:
            # its own layout first; with no free place, its other two-line breaks (breaks), narrowest first
            for w1, lines in [(n["_w"], n["_lines"]), *((w, l) for l, w in n["_alts"])]:
                spot = place(n, w1, lines)
                if spot: break
            if not spot: dropped.append((n["_id"], "no free place for the note")); continue
            pt = n["_pt"]; x, anchor, y, b1, path, cost = spot
            total += cost; longest = max(longest, sum(math.dist(a, b) for a, b in zip(path, path[1:])))
            o.append(f'<polyline points="{" ".join(f"{p[0]:.1f},{p[1]:.1f}" for p in path)}" fill="none" stroke="var(--t-sec)" stroke-width="0.8"/><circle cx="{pt[0]:.1f}" cy="{pt[1]:.1f}" r="2.5" fill="var(--t-title)"/>')
            halo = ' stroke="var(--bg)" stroke-width="3" paint-order="stroke"'
            for j, (inner, w) in enumerate(lines or [(n["_inner"], n["_w"])]):  # each line at the box's edge, LINE em below the one above
                o.append(K.txt(B, x, y + size * LINE * j, size, "var(--accent)" if acc(n) else "var(--t-title)", inner, w, anchor=anchor, weight=400, tag=f"note {n.get('name') or n.get('text')}", style=halo))
            occ.add(b1, "notes")
            for a, b in zip(path, path[1:]):
                steps = max(2, math.ceil(math.dist(a, b) / 4)); occ.add_line([(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps) for i in range(steps + 1)], "notes", "leader")
        return o, dropped, total, longest

    # top first; when that drops a note, or leaves a leader past LONG_LEAD, bottom first too, against the same claims (occ as the
    # notes found it; the layer's two-bend budget shared), kept when it drops fewer, or as few and its longest leader is shorter
    # (the same: its leaders cost less in all). A note high up can take the one free place a lower one had (a short bars
    # picture's band under the bars): bottom first gives it back
    before = (occ.boxes[:], occ.pts[:])
    got = lay(keep)
    if len(keep) > 1 and (got[1] or got[3] > LONG_LEAD):
        after = (occ.boxes[:], occ.pts[:]); occ.boxes[:], occ.pts[:] = before
        other = lay(keep[::-1])
        if (len(other[1]), other[3], other[2]) >= (len(got[1]), got[3], got[2]): occ.boxes[:], occ.pts[:] = after
        else: got = other
    # a note the page cannot lose (knob first: its focus) left with no free place: the notes again with those first (each
    # group top first), against the same claims, kept when it drops fewer of them, then fewer in all; a page may let a
    # plain note go, never its focus's
    lost = lambda d: (sum(1 for i, _ in d if i in f.first), len(d))
    if len(keep) > 1 and lost(got[1])[0]:
        after = (occ.boxes[:], occ.pts[:]); occ.boxes[:], occ.pts[:] = before
        other = lay(sorted(keep, key=lambda n: n.get("name") not in f.first))
        if lost(other[1]) >= lost(got[1]): occ.boxes[:], occ.pts[:] = after
        else: got = other
    o += got[0]; f.dropped += got[1]
    o.append("</g>")
    return "".join(o)


LEADER_NOTES_LAYERS = dict(leader_notes=(cl_leader_notes, None))
LEADER_NOTES_SVG = ["leader_notes"]


def draw(h, occ=None):
    f = Frame(h)
    return K.svg(cl_leader_notes(f, occ or prod.Occ()), f.W, f.H, "leader_notes"), f.W, f.H
