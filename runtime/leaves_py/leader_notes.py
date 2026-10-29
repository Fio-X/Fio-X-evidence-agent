"""leader_notes layer: short notes set at the side of the map, each with a thin leader to its point on the map, kept clear of every box and line in
the Occ. Ported from the second-layer node runtime/nodes/leader_notes.mjs to column.py's layer style. WHAT THE TREE ALREADY HAS and this does not copy:
scmp.sq_notes / rl_callouts make the hero's callouts as html columns (stacked by a browser script, one fixed column on each side of the picture, from the
gas page's own facts); this layer places svg notes inside the picture from the request's own rows and checks the placement in the Occ, so a note can
never sit on a flow line or a label another layer claimed. Reused: prod.Occ (hit, on_line), prod.tw, mapkit.View (the frame flow_lines also uses).
hero.data: {"ext": [lon0, lat0, lon1, lat1], "hub": {"lonlat": [lon, lat]}?, "name_kind": "place"|<kind>,
  "notes": [{"at": [lon, lat] | "hub", "name": code?, "text": segs?, "value_text": src?}]}     # at least a name or text; made by the program, never typed
A note is one short line: its name (the request's label, marked with its name row) and/or its words (segments: literals without a digit, {"word": key},
{"src": entry}), then value_text in bold, a ledger entry (the number). Nothing else is printed.
Colours: --t-title the note, --t-sec the leader, --accent the highlighted note, --bg the text halo. Notes sit at the left or right edge
(side auto: the side of the picture the point is on, then the other), then inward from it while the note stays on that side of its point; a note slides from its point's height down and up in half-line steps until its box is free and its leader keeps
3 px off every claimed box but the ones its own point lies in (the circle a bubbles layer claimed for that place: the leader ends on what it points at). Over a
map that set occ.land (bubbles in the shared frame) a note first looks for a place in the sea, off every land shape, and only then anywhere free;
a note with no free place, or past label_count, is dropped and listed in Frame.dropped as (id, why), the id its name code (note<i>, its place in the
request from 1, when it has none); the layer still draws (run.py sends the list back for layer 1 to keep in the page's ledger), unless every note was
dropped (Frame.drew_none), which run.py refuses.
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
STEP = 24  # px a note moves inward from the picture's edge when the edge has no place for it


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
            parts, wd, plain = [], 0.0, ""
            if n.get("name"): nm = K.named(n["name"], kind); parts.append(nm[0]); wd += tw(nm[1], size); plain += nm[1]
            if n.get("text"):
                inner, w_, p_ = MK.inline(n["text"], size, f"note {i + 1} text"); parts.append(inner); wd += w_ + (size * 0.3 if parts[:-1] else 0); plain += p_
            if n.get("value_text"):  # the number last, bold (a bold glyph runs about 6% wider than tw's estimate)
                val = K.ent(n["value_text"]); parts.append(f'<tspan font-weight="700">{val[0]}</tspan>'); wd += tw(val[1], size) * 1.06 + (size * 0.3 if parts[:-1] else 0)
            n["_inner"], n["_w"] = " ".join(parts), wd
            if wd > f.W / 2: raise Refused(f"leader_notes: note {i + 1} is wider than half the picture at {size} px")
        f.hl = K.check_codes(NODE, k("highlight"), {n["name"] for n in notes if n.get("name")}) if k("highlight") else set()
        f.pal, f.side = k("palette"), k("side"); f.notes = notes; f.dropped = []; f.drew_none = False


def cl_leader_notes(f, occ):
    k, W, H, size = f.k, f.W, f.H, f.size; B = K.Boxes(W, H); o = ['<g data-node="leader_notes">']; f.dropped = []
    lead, margin, land = size * 1.4, 8, getattr(occ, "land", None)
    items = sorted(f.notes, key=lambda n: (n["_pt"][1], str(n.get("name")))); keep, rest = items[: int(k("label_count"))], items[int(k("label_count")):]
    f.dropped += [(n["_id"], "past label_count") for n in rest]
    acc = lambda n: f.pal == "grey_accent" and n.get("name") in f.hl

    def xs(side, pt, w1):
        """Where a note on that side may stand: at the picture's edge, then inward in STEP px steps while it stays wholly on
        that side of its point."""
        if side == "left": return [margin] + [margin + STEP * i for i in range(1, int(W / STEP)) if margin + STEP * i + w1 < pt[0] - 12]
        return [W - margin] + [W - margin - STEP * i for i in range(1, int(W / STEP)) if W - margin - STEP * i - w1 > pt[0] + 12]

    def place(n, sea):
        """The first free one-line place for the note (sea: off the land too), or None."""
        pt = n["_pt"]; w1 = n["_w"]
        sides = [f.side] if f.side != "auto" else ["left", "right"] if pt[0] < W / 2 else ["right", "left"]
        for side, x in [(sd, x) for sd in sides for x in xs(sd, pt, w1)]:  # auto: the point's own side first, then the other
            anchor = "start" if side == "left" else "end"
            y0 = max(size + 2, min(H - lead, pt[1]))
            for j in range(80):  # from the point's height, half a line down, then up, then a line down ...
                y = y0 + lead / 2 * ((j + 1) // 2) * (1 if j % 2 else -1)
                x0 = x if anchor == "start" else x - w1
                b1 = (x0, y - size * 0.9, x0 + w1, y + size * 0.25)
                if not (b1[0] >= 0 and b1[1] >= 0 and b1[2] <= W and b1[3] <= H): continue
                if occ.hit(b1, pad=(1, 1)) or occ.on_line(b1, pad=1) or (sea and MK.on_land(land, b1)): continue
                edge = (b1[2] + 3 if side == "left" else b1[0] - 3, (b1[1] + b1[3]) / 2)
                # the leader walks from the note to the point at 2 px steps: it keeps 3 px off every claimed box but its own point's
                steps = max(1, math.ceil(math.dist(edge, pt) / 2)); own = [q for q in occ.boxes if q[0] <= pt[0] <= q[2] and q[1] <= pt[1] <= q[3]]
                at = lambda i: (edge[0] + (pt[0] - edge[0]) * i / steps, edge[1] + (pt[1] - edge[1]) * i / steps)
                if any(math.dist(at(i), pt) > 10 and any(at(i)[0] - 3 < q[2] and at(i)[0] + 3 > q[0] and at(i)[1] - 3 < q[3] and at(i)[1] + 3 > q[1]
                                                         for q in occ.boxes if q not in own) for i in range(steps + 1)): continue
                return x, anchor, y, b1, edge
        return None

    for n in keep:
        spot = (land and place(n, True)) or place(n, False)
        if not spot: f.dropped.append((n["_id"], "no free place for the note")); continue
        pt = n["_pt"]; x, anchor, y, b1, edge = spot
        o.append(f'<line x1="{edge[0]:.1f}" y1="{edge[1]:.1f}" x2="{pt[0]:.1f}" y2="{pt[1]:.1f}" stroke="var(--t-sec)" stroke-width="0.8"/><circle cx="{pt[0]:.1f}" cy="{pt[1]:.1f}" r="2.5" fill="var(--t-title)"/>')
        halo = ' stroke="var(--bg)" stroke-width="3" paint-order="stroke"'
        o.append(K.txt(B, x, y, size, "var(--accent)" if acc(n) else "var(--t-title)", n["_inner"], n["_w"], anchor=anchor, weight=400, tag=f"note {n.get('name') or n.get('text')}", style=halo))
        occ.add(b1, "notes")
        steps = max(2, math.ceil(math.dist(edge, pt) / 4)); occ.add_line([(edge[0] + (pt[0] - edge[0]) * i / steps, edge[1] + (pt[1] - edge[1]) * i / steps) for i in range(steps + 1)], "notes", "leader")
    o.append("</g>")
    f.drew_none = len(f.dropped) == len(f.notes)
    return "".join(o)


LEADER_NOTES_LAYERS = dict(leader_notes=(cl_leader_notes, None))
LEADER_NOTES_SVG = ["leader_notes"]


def draw(h, occ=None):
    f = Frame(h)
    return K.svg(cl_leader_notes(f, occ or prod.Occ()), f.W, f.H, "leader_notes"), f.W, f.H
