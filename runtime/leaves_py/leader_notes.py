"""leader_notes layer: short notes set at the side of the map, each with a thin leader to its point on the map, kept clear of every box and line in
the Occ. Ported from the second-layer node runtime/nodes/leader_notes.mjs to column.py's layer style. WHAT THE TREE ALREADY HAS and this does not copy:
scmp.sq_notes / rl_callouts make the hero's callouts as html columns (stacked by a browser script, one fixed column on each side of the picture, from the
gas page's own facts); this layer places svg notes inside the picture from the request's own rows and checks the placement in the Occ, so a note can
never sit on a flow line or a label another layer claimed. Reused: prod.Occ (hit, on_line), prod.tw, mapkit.View (the frame flow_lines also uses).
hero.data: {"ext": [lon0, lat0, lon1, lat1], "hub": {"lonlat": [lon, lat]}?, "name_kind": "place"|<kind>,
  "notes": [{"at": [lon, lat] | "hub", "name": code?, "text": segs?, "value_text": src?}]}     # at least a name or text; made by the program, never typed
A note is one short line: its name (the request's label, marked with its name row) and/or its words (segments: literals without a digit, {"word": key},
{"src": entry}), then value_text in bold, a ledger entry (the number). Nothing else is printed.
Colours: --t-title the note, --t-sec the leader, --accent the highlighted note, --bg the text halo. A note is tried on a STEP px grid across the whole
picture (side left or right: only at that edge); of the free boxes (off every claimed box and line) with a clear leader it takes the cheapest:
the leader's length, plus LAND_COST px when the box sits over the land (occ.land, set by bubbles in the shared frame; the sea or the open margin
is preferred, and a note over the land keeps its halo and stays off every circle, label and line) and BEND_COST px for a bend. The leader runs
from the box's nearest side (or an end or a corner) straight, or with one right-angle bend (across, then down or up; or the other way), and keeps
3 px off every claimed box and 2 px off every circle (occ.circles) but the ones its own point lies in (it ends on what it points at), and LEAD_GAP
px off every other leader drawn (it crosses none). Measured on the q1 and q6 column pages (replayed offline): sea only and straight kept 1 of
their 4 notes, the bend alone 2, the land alone 3, both 4 (the sea first, whatever the length, gave a 400 px leader round the map);
a note with no free place, or past label_count, is dropped and listed in Frame.dropped as (id, why), the id its name code (note<i>, its place in the
request from 1, when it has none); the layer still draws, empty when every note was dropped (run.py sends the list back for layer 1 to keep in
the page's ledger).
Refuses: no notes, a note without a name or text, a point that is not [lon, lat] (or "hub" without a hub), a note under 16 px (note_size min), a note wider than
half the picture, a missing label or ledger entry, a digit in a literal, a knob off its range."""
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
    highlight=("", None, "name code of the note drawn in the accent"), width=(1140, (400, 1400, 10), "picture width px"))
NODE = "leader_notes"
MAX_ROWS = 400
STEP = 24  # px between the places a note is tried at across the picture
LEAD_GAP = 3  # px a note's leader keeps off every other leader's points (sampled at 4 px at most: a crossing comes within 3 px)
LAND_COST = 80  # px a note over the land costs against one in the sea or the open margin
BEND_COST = 40  # px a leader's bend costs against a straight one
TRIES = 600  # leaders walked per note, cheapest first: a crowded picture stays within the layer's deadline (next_leaf LAYER_DEADLINE)


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.h, f.d, f.k = h, d, k; f.v = v = MK.View(h, NODE); f.W, f.H = v.W, v.H; f.size = size = k("note_size")
        notes = [dict(n) for n in (d.get("notes") or [])]
        if not notes: raise Refused("leader_notes: the request holds no notes")
        if len(notes) > MAX_ROWS: raise Refused(f"leader_notes: at most {MAX_ROWS} notes, got {len(notes)}")
        kind = d.get("name_kind", "place")
        for i, n in enumerate(notes):
            n["_id"] = n.get("name") or f"note{i + 1}"; at = n.get("at")
            if at == "hub":
                if v.hub is None: raise Refused(f"leader_notes: note {i + 1} points at the hub and the request gives none")
                at = v.hub
            n["_pt"] = v.at(v.lonlat(at, f"leader_notes: note {i + 1}"))  # a place beyond the frame is pointed at where its flow line enters (found by pagecheck: the raw point lay outside the picture)
            if not n.get("name") and not n.get("text"): raise Refused(f"leader_notes: note {i + 1} has neither a name nor words")
            parts, wd, plain = [], 0.0, []
            if n.get("name"): nm = K.named(n["name"], kind); parts.append(nm[0]); wd += tw(nm[1], size); plain.append(nm[1])
            if n.get("text"):
                inner, w_, p_ = MK.inline(n["text"], size, f"note {i + 1} text"); parts.append(inner); wd += w_ + (size * 0.3 if parts[:-1] else 0); plain.append(p_)
            if n.get("value_text"):  # the number last, bold (a bold glyph runs about 6% wider than tw's estimate)
                val = K.ent(n["value_text"]); parts.append(f'<tspan font-weight="700">{val[0]}</tspan>'); wd += tw(val[1], size) * 1.06 + (size * 0.3 if parts[:-1] else 0); plain.append(val[1])
            # never narrower than layer 1 reads the line back (the whole text, its spaces included, by the same width rule)
            n["_inner"], n["_w"] = " ".join(parts), max(wd, tw(" ".join(plain), size))
            wd = n["_w"]
            if wd > f.W / 2: raise Refused(f"leader_notes: note {i + 1} is wider than half the picture at {size} px")
        f.hl = K.check_codes(NODE, k("highlight"), {n["name"] for n in notes if n.get("name")}) if k("highlight") else set()
        f.pal, f.side = k("palette"), k("side"); f.notes = notes; f.dropped = []


def cl_leader_notes(f, occ):
    k, W, H, size = f.k, f.W, f.H, f.size; B = K.Boxes(W, H); o = ['<g data-node="leader_notes">']; f.dropped = []
    lead, margin, land = size * 1.4, 8, getattr(occ, "land", None)
    items = sorted(f.notes, key=lambda n: (n["_pt"][1], str(n.get("name")))); keep, rest = items[: int(k("label_count"))], items[int(k("label_count")):]
    f.dropped += [(n["_id"], "past label_count") for n in rest]
    acc = lambda n: f.pal == "grey_accent" and n.get("name") in f.hl

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
        LEAD_GAP px off every other leader (`cells`)."""
        steps = max(1, math.ceil(math.dist(edge, end) / 2))
        for i in range(steps + 1):
            a = (edge[0] + (end[0] - edge[0]) * i / steps, edge[1] + (end[1] - edge[1]) * i / steps)
            if math.dist(a, pt) <= 10: continue
            if any(a[0] - 3 < q[2] and a[0] + 3 > q[0] and a[1] - 3 < q[3] and a[1] + 3 > q[1] for q in boxes): return False
            if any(math.dist(a, c[:2]) < c[2] + 2 for c in rings): return False
            cx, cy = int(a[0] // LEAD_GAP), int(a[1] // LEAD_GAP)
            if any(math.dist(a, q) < LEAD_GAP for gx in (cx - 1, cx, cx + 1) for gy in (cy - 1, cy, cy + 1) for q in cells.get((gx, gy), ())): return False
        return True

    def place(n):
        """The note's place: of every free one-line box (side auto: anywhere in the picture on a STEP px grid; left or right: at
        that edge), the one whose clear leader (straight or with one bend) costs least (its
        length, LAND_COST over the land, BEND_COST a bend); the leader is returned as its points, note end first. None when no box has one."""
        pt = n["_pt"]; w1 = n["_w"]; found = []
        x0s = [margin] if f.side == "left" else [W - margin - w1] if f.side == "right" else \
            sorted({*(margin + STEP * i for i in range(int((W - 2 * margin - w1) / STEP) + 1)), W - margin - w1})
        y = size + 2
        while y + size * 0.25 <= H:
            for x0 in x0s:
                b1 = (x0, y - size * 0.9, x0 + w1, y + size * 0.25)
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
        for low, b1, y, edge in sorted(found, key=lambda c: c[0])[:TRIES]:
            if best and low >= best[0]: break
            # straight, or one right-angle bend at the point's column or at its row
            for path in ([edge, pt], [edge, (pt[0], edge[1]), pt], [edge, (edge[0], pt[1]), pt]):
                cost = low - math.dist(edge, pt) + sum(math.dist(a, b) for a, b in zip(path, path[1:])) + BEND_COST * (len(path) - 2)
                if (not best or cost < best[0]) and all(lead_clear(a, b, pt, boxes, rings, cells) for a, b in zip(path, path[1:])):
                    best = (cost, b1, y, path)
        if not best: return None
        _, b1, y, path = best
        anchor = "end" if (b1[0] + b1[2]) / 2 > W / 2 else "start"  # a note right of the middle keeps to its right edge
        return (b1[2] if anchor == "end" else b1[0]), anchor, y, b1, path

    for n in keep:
        spot = place(n)
        if not spot: f.dropped.append((n["_id"], "no free place for the note")); continue
        pt = n["_pt"]; x, anchor, y, b1, path = spot
        o.append(f'<polyline points="{" ".join(f"{p[0]:.1f},{p[1]:.1f}" for p in path)}" fill="none" stroke="var(--t-sec)" stroke-width="0.8"/><circle cx="{pt[0]:.1f}" cy="{pt[1]:.1f}" r="2.5" fill="var(--t-title)"/>')
        halo = ' stroke="var(--bg)" stroke-width="3" paint-order="stroke"'
        o.append(K.txt(B, x, y, size, "var(--accent)" if acc(n) else "var(--t-title)", n["_inner"], n["_w"], anchor=anchor, weight=400, tag=f"note {n.get('name') or n.get('text')}", style=halo))
        occ.add(b1, "notes")
        for a, b in zip(path, path[1:]):
            steps = max(2, math.ceil(math.dist(a, b) / 4)); occ.add_line([(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps) for i in range(steps + 1)], "notes", "leader")
    o.append("</g>")
    return "".join(o)


LEADER_NOTES_LAYERS = dict(leader_notes=(cl_leader_notes, None))
LEADER_NOTES_SVG = ["leader_notes"]


def draw(h, occ=None):
    f = Frame(h)
    return K.svg(cl_leader_notes(f, occ or prod.Occ()), f.W, f.H, "leader_notes"), f.W, f.H
