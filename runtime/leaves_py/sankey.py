"""sankey layer: one flow picture, two columns (sources on the left, destinations on the right), a band per flow as wide as its
value, in rankbar.py's layer style. Every width is read back from a series cell of the request; every printed number is a ledger
entry printed with FX.entry; names are the request's labels.

hero.data (the data shape this leaf eats; on a column frame page, the hero's leaves.sankey, run.py leaf): {
  "title": segs, "unit": segs,                      # the unit is written once, in the head, never on a node or a band
  "source_kind": "category", "target_kind": "category",     # name rows: name:zh_names:<kind>:<code> (a place: "place")
  "flows": [{"source": code, "target": code, "value": series src}],     # one row per flow, one unit, values >= 0; a code
                                                    # is a source or a target, never both; a zero flow is not drawn
                                                    # and goes back in Frame.dropped as ("<source>><target>", "zero")
  "node_text": {code: ledger src},                  # the printed value of every node that is not merged (source or target);
                                                    # a merged member needs none
  "totals": {"source": {code: series src}?, "target": {code: series src}?, "all": series src?}?,  # reported totals, checked
  "other_source": {"name": segs,                    # where layer 1 merged sources: the other node's name,
                   "members": [code, ...],          # the merged sources (two or more, each a source of the flows, once each),
                   "value": series src?,            # the merged node's value, a series the request holds (layer 1's sum of
                                                    # the members' flows, checked here); none: the members' flows are its
                                                    # value, as every node's (layer 1 fetched no such series),
                   "value_text": ledger src,        # its printed value,
                   "members_head": segs}?,          # and the words that lead the members' names under the picture
  "other_target": {...}?,                           # the same for destinations
  "empty": {"source": [code, ...]?, "target": [code, ...]?}?,   # the codes of a side layer 1 asked for and got no row of:
                                                    # no node, each back in Frame.dropped as (code, "no row"), never a
                                                    # zero node and never left out unsaid; a code of a flow refuses
  "footnote": segs?}                                # e.g. the rounding line, printed once under the picture
segs: a list of {"w": words} (no digit) and {"src": ledger src} pieces, as wbkit.segs reads them; series src:
"series:<table>/<codes>:<time>:OBS_VALUE", a cell of the request's rows (its value drives the geometry only); ledger src: a row
{"src", "text"} of the request (the text is printed as given, marked with its src).
Columns: the declaration is 2 (a flow goes source -> target; a code is one or the other). A third column (supply -> transformation
-> final) adds a "middle" list of nodes later; no code here holds the number of columns except COLUMNS.
Merging is layer 1's: it picks the nodes under the knob min_share (read by layer 1 only, src/next_run.rs; this leaf never reads
it) when two or more of a column qualify, computes their sum into the ledger and names them in other_<side>.members; this leaf
draws what it is given. The merged members are NAMED UNDER THE PICTURE (members_head + their names), never only in metadata.
Conservation (refuses): a reported node total or the grand total differs from the sum of its flows by more than knob tol times the
grand total; a merged node's series is not its members' sum (the same tolerance).
Colours: --accent the highlighted code's bands and node (else none), --bar the bands, --t-sec the nodes, --t-title ink.
Refuses: no flows, a negative value, a code on both sides, a node without node_text, a flow whose series the request lacks, an
other node with fewer than two members, a member twice or one no flow of its side has, a digit in a literal word, a text that
leaves the picture or overlaps another, a members line wider than the picture, a highlight that is not a drawn node's code."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbkit as K
from wbkit import FX, prod, Refused, esc, tw
import words as WD

NODE = "sankey"
COLUMNS = 2
prod.KNOBS[NODE] = dict(
    size=(12, (11, 16, 0.5), "label size px (11 is the page floor)"), title_size=(16, (12, 22, 1), "chart name size px"),
    width=(1140, (480, 1400, 10), "picture width in px"), height=(460, (240, 900, 10), "height of the two columns in px"),
    node_w=(14, (6, 30, 1), "node bar width in px"), node_gap=(10, (4, 30, 1), "gap between two nodes in px"),
    min_share=(0.03, (0, 0.2, 0.005), "a node under this share of the total merges into the other node (needs two); layer 1 merges"),
    hairline=(0.6, (0, 2, 0.1), "thinnest band drawn in px (geometry only; the data are not changed)"),
    highlight=("", None, "code of the one node whose bands are drawn in the accent; none = all grey"),
    tol=(1e-5, (0, 0.001, 1e-6), "conservation tolerance, as a share of the grand total"))


def _column(col, other, side):
    """The column's nodes [(code, total)] by value, largest first, and its merged members: the members other_<side> names
    (layer 1's pick) are replaced by one other node at the end, carrying their sum."""
    nodes = sorted(col.items(), key=lambda kv: (-kv[1], kv[0]))
    if not other:
        return nodes, []
    small = other.get("members")
    if not isinstance(small, list) or len(small) < 2 or not all(isinstance(c, str) for c in small):
        raise Refused(f"sankey: other_{side}.members is {small!r}; an other node merges two or more codes, for example ['P1000', 'S2000']")
    twice = sorted({c for c in small if small.count(c) > 1})
    if twice: raise Refused(f"sankey: other_{side}.members names {twice} twice")
    off = [c for c in small if c not in col]
    if off: raise Refused(f"sankey: other_{side}.members names {off}, which no flow has as its {side}")
    return [(c, v) for c, v in nodes if c not in small] + [("_other", sum(col[c] for c in small))], list(small)


class Frame:
    def __init__(f, h):
        d = h["data"]; k = lambda n: K.knob(h, NODE, n)
        f.d, f.k, f.size = d, k, k("size")
        f.W, f.colh = k("width"), k("height")
        flows = [dict(r) for r in (d.get("flows") or [])]
        if not flows: raise Refused("sankey: the spec holds no flows")
        for r in flows:
            for key in ("source", "target", "value"):
                if not isinstance(r.get(key), str) or not r[key]: raise Refused(f"sankey: a flow lacks {key}; for example {{'source': 'O4000XBIO', 'target': 'FC_IND_E', 'value': 'series:T/a:2024:OBS_VALUE'}}")
            r["_v"] = K.val(r["value"])
            if r["_v"] < 0: raise Refused(f"sankey: flow {r['source']} -> {r['target']} is negative; a band cannot be drawn")
        # a zero flow draws no band (and a code whose flows are all zero no node): each goes back to layer 1 as dropped
        # (run.py leaf, DROPPED), never left out unsaid
        f.dropped = [(f"{r['source']}>{r['target']}", "zero") for r in flows if r["_v"] == 0]
        coded = {r["source"] for r in flows} | {r["target"] for r in flows}
        for side, codes in (d.get("empty") or {}).items():
            if side not in ("source", "target") or not isinstance(codes, list) or not all(isinstance(c, str) and c for c in codes):
                raise Refused(f"sankey: empty.{side} is {codes!r}; empty names a side's codes with no row, for example {{'source': ['N900H']}}")
            flowing = sorted(set(codes) & coded)
            if flowing: raise Refused(f"sankey: empty.{side} names {flowing}, which a flow has")
            f.dropped += [(c, "no row") for c in codes]
        flows = [r for r in flows if r["_v"] > 0]
        if not flows: raise Refused("sankey: every flow is zero")
        src_codes, tgt_codes = {r["source"] for r in flows}, {r["target"] for r in flows}
        both = sorted(src_codes & tgt_codes)
        if both: raise Refused(f"sankey: {both} are both a source and a target; this leaf draws {COLUMNS} columns")
        f.grand = sum(r["_v"] for r in flows)
        by_s, by_t = {}, {}
        for r in flows:
            by_s[r["source"]] = by_s.get(r["source"], 0.0) + r["_v"]; by_t[r["target"]] = by_t.get(r["target"], 0.0) + r["_v"]
        tol = k("tol") * f.grand
        for side, col in (("source", by_s), ("target", by_t)):
            for code, src in ((d.get("totals") or {}).get(side) or {}).items():
                if code not in col: raise Refused(f"sankey: totals.{side} names {code}, which no flow has")
                if abs(K.val(src) - col[code]) > tol: raise Refused(f"sankey: the reported total of {side} {code} is {K.val(src)}, its flows sum to {col[code]} (tolerance {tol:g})")
        tot = (d.get("totals") or {}).get("all")
        if tot and abs(K.val(tot) - f.grand) > tol: raise Refused(f"sankey: the reported grand total is {K.val(tot)}, the flows sum to {f.grand}")
        f.src_nodes, f.src_small = _column(by_s, d.get("other_source"), "source")
        f.tgt_nodes, f.tgt_small = _column(by_t, d.get("other_target"), "target")
        f.other = {}
        for side, small, col in (("source", f.src_small, by_s), ("target", f.tgt_small, by_t)):
            if small:
                o = d[f"other_{side}"]; K.ent(o["value_text"])
                if "value" in o:  # a series layer 1 gave for the merged node is checked; none, the members' flows are its value
                    ov = K.val(o["value"])
                    if abs(ov - sum(col[c] for c in small)) > tol: raise Refused(f"sankey: other_{side}'s series {ov} is not the merged nodes' sum {sum(col[c] for c in small)}")
                f.other[side] = o
        merged = {**{c: "_other" for c in f.src_small}, **{c: "_other" for c in f.tgt_small}}
        cell = {}
        for r in flows:
            key = (merged.get(r["source"], r["source"]), merged.get(r["target"], r["target"]))
            cell[key] = cell.get(key, 0.0) + r["_v"]
        f.cells = cell  # (source node, target node) -> value; the merged nodes are "_other" on their side
        txt = d.get("node_text") or {}
        for code, _ in f.src_nodes + f.tgt_nodes:
            if code != "_other" and code not in txt: raise Refused(f"sankey: node {code} has no node_text (the ledger entry its value prints from)")
        for code, src in txt.items(): K.ent(src)
        known = {c for c, _ in f.src_nodes + f.tgt_nodes if c != "_other"}  # a merged member's bands are the other node's
        inside = sorted(set(str(k("highlight")).split(",")) & (set(f.src_small) | set(f.tgt_small)))
        if inside: raise Refused(f"sankey: highlight names {inside}, merged into the other node; one of {sorted(known)}")
        f.hl = K.check_codes(NODE, k("highlight"), known) if k("highlight") else set()
        if len(f.hl) > 1: raise Refused("sankey: highlight names one code")
        f.kinds = {"source": d.get("source_kind", "category"), "target": d.get("target_kind", "category")}
        f.names = {}
        for side, nodes, small in (("source", f.src_nodes, f.src_small), ("target", f.tgt_nodes, f.tgt_small)):
            for code, _ in nodes:
                if code != "_other": f.names[(side, code)] = K.named(code, f.kinds[side])
        f.top, f.H = 54, 0


def _label(f, side, code):
    """(inner svg, plain text) of a node's one-line label: its name and, after it, its value as a ledger entry."""
    if code == "_other":
        o = f.other[side]; nm = K.plain(o["name"], f"other_{side} name")
        segs = K.segs(o["name"], f"other_{side} name"); name_svg = "".join(FX.entry(s, "tspan", None) if s else esc(t) for t, s in segs)
        vt = K.ent(o["value_text"])
    else:
        name_svg, nm = f.names[(side, code)]; vt = K.ent(f.d["node_text"][code])
    return f'<tspan font-weight="700">{name_svg}</tspan> {vt[0]}', f"{nm} {vt[1]}"


def cl_sankey(f, occ):
    d, size, W = f.d, f.size, f.W
    nw, gap, hl = f.k("node_w"), f.k("node_gap"), f.k("hairline")
    labels = {(s, c): _label(f, s, c) for s, nodes in (("source", f.src_nodes), ("target", f.tgt_nodes)) for c, _ in nodes}
    lw = {s: max(tw(labels[(s, c)][1], size) for c, _ in nodes) + 10 for s, nodes in (("source", f.src_nodes), ("target", f.tgt_nodes))}
    x_src, x_tgt = 8 + lw["source"], W - 8 - lw["target"] - nw
    if x_tgt - (x_src + nw) < 160: raise Refused("sankey: the picture is too narrow for the labels and the bands (under 160 px between the columns)")
    n_max = max(len(f.src_nodes), len(f.tgt_nodes)); k_px = (f.colh - gap * (n_max - 1)) / f.grand
    if k_px <= 0: raise Refused("sankey: height is too small for the number of nodes; fewer nodes or a larger height")
    pos = {}  # (side, node) -> [y0, y1]
    for side, nodes in (("source", f.src_nodes), ("target", f.tgt_nodes)):
        y = f.top
        for c, v in nodes:
            pos[(side, c)] = [y, y + v * k_px]; y += v * k_px + gap
    B = K.Boxes(W, 0); o = []
    Hmax = f.top + f.colh + 14
    B.h = 10 ** 6  # the height is settled below; the boxes of this picture are checked against the final height afterwards
    o.append(K.head(B, d["title"], d["unit"], size, f.k("title_size")))
    # bands: a source's outgoing bands stacked in the order of the targets; a target's incoming in the order of the sources
    out_y = {c: pos[("source", c)][0] for c, _ in f.src_nodes}; in_y = {c: pos[("target", c)][0] for c, _ in f.tgt_nodes}
    s_rank = {c: i for i, (c, _) in enumerate(f.src_nodes)}; t_rank = {c: i for i, (c, _) in enumerate(f.tgt_nodes)}
    xm = (x_src + nw + x_tgt) / 2
    bands = []
    for (sc, tc), v in sorted(f.cells.items(), key=lambda kv: (s_rank[kv[0][0]], t_rank[kv[0][1]])):
        t = v * k_px; y0 = out_y[sc]; out_y[sc] += t; bands.append((sc, tc, v, t, y0))
    placed = []
    for sc, tc, v, t, y0 in sorted(bands, key=lambda b: (t_rank[b[1]], s_rank[b[0]])):
        y1 = in_y[tc]; in_y[tc] += t; placed.append((sc, tc, v, t, y0, y1))
    for sc, tc, v, t, y0, y1 in sorted(placed, key=lambda b: (s_rank[b[0]], t_rank[b[1]])):
        hot = bool(f.hl & {sc, tc})
        fill = "var(--accent)" if hot else "var(--bar)"; op = 0.7 if hot else 0.75
        x0, x1 = x_src + nw, x_tgt; a, b2 = y0, y0 + t; c, d2 = y1, y1 + t
        o.append(f'<path d="M{x0:.1f},{a:.2f} C{xm:.1f},{a:.2f} {xm:.1f},{c:.2f} {x1:.1f},{c:.2f} L{x1:.1f},{d2:.2f} C{xm:.1f},{d2:.2f} {xm:.1f},{b2:.2f} {x0:.1f},{b2:.2f} Z" '
                 f'fill="{fill}" fill-opacity="{op}" stroke="{fill if t < 2 else "var(--bg)"}" stroke-width="{hl if t < 2 else 0.8}" stroke-opacity="{op if t < 2 else 1}" data-flow="{esc(sc)}>{esc(tc)}"/>')
    for (side, c), (y0, y1) in pos.items():
        x = x_src if side == "source" else x_tgt
        hot = c in f.hl
        o.append(f'<rect x="{x:.1f}" y="{y0:.2f}" width="{nw}" height="{max(y1 - y0, hl):.2f}" fill="{"var(--accent)" if hot else "var(--t-sec)"}"/>')
        inner, plain = labels[(side, c)]; yc = (y0 + y1) / 2 + size * 0.35
        lx, anc = (x - 6, "end") if side == "source" else (x + nw + 6, "start")
        o.append(K.txt(B, lx, yc, size, "var(--t-title)", inner, tw(plain, size), anchor=anc, tag=f"{side} {c}"))
    y = Hmax
    for side, small in (("source", f.src_small), ("target", f.tgt_small)):
        if not small: continue
        spec = f.other[side]; head = K.segs(spec["members_head"], f"other_{side} members_head")
        names = [K.named(c, f.kinds[side]) for c in small]; sep = WD.WORDS["list.sep"]
        line, w_line, rows = [("".join(FX.entry(s, "tspan", None) if s else esc(t) for t, s in head), K.plain(spec["members_head"], "members_head"))], tw(K.plain(spec["members_head"], "members_head"), size), []
        for i, (nm_svg, nm) in enumerate(names):
            piece = (nm_svg + (esc(sep) if i < len(names) - 1 else ""), nm + (sep if i < len(names) - 1 else ""))
            if w_line + tw(piece[1], size) > W - 16 and len(line) > 1: rows.append(line); line, w_line = [], 0.0
            if tw(piece[1], size) > W - 16: raise Refused(f"sankey: the name {nm!r} is wider than the picture")
            line.append(piece); w_line += tw(piece[1], size)
        rows.append(line)
        if len(rows) > 3: raise Refused(f"sankey: the members of other_{side} take {len(rows)} lines, 3 allowed; a larger min_share or fewer small nodes")
        for ln in rows:
            y += size * 1.5
            o.append(K.txt(B, 8, y, size, "var(--t-sec)", "".join(p[0] for p in ln), sum(tw(p[1], size) for p in ln), tag=f"members {side}"))
    if d.get("footnote"):
        y += size * 1.5
        a, _, _ = K.words(B, d["footnote"], "footnote", 8, y, size, "var(--t-sec)", italic=True, max_w=W - 16)
        o.append(a)
    f.H = int(y + 12); B.h = f.H
    for (x0, y0, x1, y1), tag in B.b:  # the final height: every text inside the picture
        if y1 > f.H + 0.5 or x0 < -0.5 or x1 > W + 0.5: raise Refused(f"{tag}: the text leaves the {W:.0f}x{f.H:.0f} picture")
    return "".join(o)


SANKEY_LAYERS = dict(sankey=(cl_sankey, None))
SANKEY_SVG = ["sankey"]


def draw(h):
    f = Frame(h)
    inner = cl_sankey(f, prod.Occ())
    return K.svg(inner, f.W, f.H, "sankey"), f.W, f.H
