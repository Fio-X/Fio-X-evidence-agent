"""Second-layer leaf child for a page's panel (src/next_leaf.rs runs it, one child per panel, one JSON line per layer): the
ring hero, the column page (column.py, with the chart leaves of LEAF_LAYERS over its frame, its main layer the recipe's
MAIN) or the scmp page (scmp.py SCMP_LAYERS), by the page recipe each line names ("node").

First, when layer 1 leaves the panel's height to the child: {"phase": "size", "panel", "rows", "knobs"} -> {"w", "h"}, the
panel the ring frame lays out (layer 1 checks every text against it).
In, per line: {"phase": "reserve"|absent, "node", "layer", "panel": {"w", "h", "frame"}, "rows", "knobs", "occ"}.
Out, per line: {"svg"} for the picture's layers or {"html"} for the ones laid out in the browser (legend, callouts). The
ring frame and the occupancy table stay in this child across the panel's lines.
Last, the page: {"phase": "page", "layers": {layer: what it drew}} -> {"html"}, the whole page (header, the ring hero
around the given layers, each tagged data-layer, footer) in the frame the layers were drawn in; a section no leaf layer
draws yet (top, band, strip, row, big numbers) refuses the page instead of being drawn here. A page line before any
layer line refuses, and so does a page that still holds a {placeholder} anywhere (a script's ${...} passes). The hero
carries the hooks the browser check reads (runtime/pi/browser_qa.py): HOOKS.

rows: one row shape, the one next_facts::recheck reads, so every src a leaf prints is one the recheck can recompute:
  {"src": "series:<table>/<codes>:<time>:OBS_VALUE", "table", "dims": {...}, "time", "value"}  a cell of a data table;
  {"src": "fact:<key>[.n|.t|.tick<i>]", "text"}                                                 a ledger entry to print;
  {"src": "period:<table>:<year>", "text"}, {"src": "record:<table>/<row>:<column>.y|.m|.d", "text"}  the same, for a
  year the table covers and the parts of a record's date. A family member's key is <family>.<code>.
Records of a sourced list (routes, terminals, cities, events) use the same shape with every column in dims, time and
value empty, src "record:<table>/<row>". Raw values drive geometry only; a digit printed from them is the page number
check's to refuse.
knobs: {"spec": the page config the prototype reads (tables, fmts, facts, hero, refs: the source's table ids), "shapes": the
Natural Earth file, "segs": layer 1's segments of the dek and the hero's unit (facts.worded)}.

A layer prints a ledger entry as given, marked with its src (facts.entry); a src the request lacks refuses the layer
({"refused": [...]}). Printing sites moved so far: the fact placeholders of every text ({key}, {key.n}, {key.t}), the
ring's marks and years, the map's short labels (the family the map's label_fact names) and the callouts' dates; the
others still format their own numbers until the next commits move them."""
import json, os, re, sys
from html.parser import HTMLParser
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts as FX
import bubbles
import column
import geo
import leader_notes
import mapkit
import prod
import rankbar
import sankey
import scmp
import stacked100
import section_head
import wbkit
from words import word


def tables(rows):
    """The prototype's tables (csv-shaped dicts, file order) rebuilt from the request's rows."""
    T = {}; FX.SRCS = {}
    for r in rows:
        if "table" not in r: continue
        cell = dict(r["dims"])
        if r["src"].startswith("series:"): cell.update(TIME_PERIOD=r["time"], OBS_VALUE=r["value"])
        T.setdefault(r["table"], []).append(cell); FX.SRCS[id(cell)] = r["src"]
    return T


def fact_times(spec):
    """With a ledger the map's legend prints its t0 year beside the legend_fact family's value and its short labels print the
    label_fact family: each family's declared time must be that year, or a right number prints under the wrong year."""
    d = spec["hero"]["data"]
    for fam, t in (("legend_fact", "t0"), ("label_fact", "t1")):
        if not d.get(fam): continue
        got = spec["facts"].get(d[fam], {}).get("time")
        if str(got) != str(d[t]): raise FX.Refused(f"map: the {fam} family {d[fam]} is at {got}, the map's {t} is {d[t]}")


# What the layer being drawn dropped ({"id", "why"} each: a place's code where the leaf has one), which main() sends back with
# its reply; layer 1 (next_leaf take) keeps it on the panel and the flow writes it into the page's ledger.
DROPPED = []
# The radius scale the layer drew its circles at (bubbles Frame.r_used) and how many knob steps under its r_max that is, which
# main() sends back with its reply as r_used and r_steps, with the circles lifted to r_min on that scale (bubbles Frame.r_min_codes:
# their areas no longer keep to it) as r_min_lifted and r_min_codes; layer 1 keeps all four on the panel and the flow writes them into the page's event.
SCALE = {}
# The size of the picture each leaf layer drew last (its Frame's W and H, None where it has none): a column page's main
# leaf's is the panel's (main_size).
DREW = {}
# The finding each leaf layer drew last (its Frame's finding, wbkit.two_sided; None where it has none): a column page's
# main leaf's makes the page's headline (column_page).
FOUND = {}
# B11: the words a title's claim is read by (the page line's claim_words, from the visual group's check vocabulary,
# next_ledger.rs CLAIM_WORDS); None (a core that sends none): no title is read for a claim, the page as before.
CLAIM_WORDS = None


def leaf_frame(Frame, f, key, fixed=None, by_hero=None):
    """A chart leaf's own Frame over the hero's leaves.<key> (refusing a hero that names none), with the hero's style
    (`fixed` over it, then `by_hero`'s), and the series values read from the request's tables (wbkit.read_values)."""
    d = (f.h.get("leaves") or {}).get(key)
    if d is None: raise FX.Refused(f"the hero names no leaves.{key}")
    wbkit.read_values()
    st = dict(f.h.get("style", {}))
    for node, kv in [*(fixed or {}).items(), *(by_hero(f.h) if by_hero else {}).items()]: st[node] = {**st.get(node, {}), **kv}
    return Frame({"data": d, "style": st})


def leaf_records(fr, key):
    """What a chart leaf's Frame drew, as main() sends it back: its size, finding, what it dropped and its radius scale."""
    DREW[key] = (getattr(fr, "W", None), getattr(fr, "H", None))
    FOUND[key] = getattr(fr, "finding", None)
    dropped = getattr(fr, "dropped", None) or []
    DROPPED.extend({"id": str(c), "why": why} for c, why in dropped)
    if getattr(fr, "r_used", None) is not None:
        SCALE.update(r_used=fr.r_used, r_steps=round((fr.k("r_max") - fr.r_used) / prod.KNOBS[key]["r_max"][1][2]),
                     r_min_lifted=len(fr.r_min_codes), r_min_codes=list(fr.r_min_codes))


def leaf(Frame, cl, key, fixed=None, by_hero=None):
    """A chart leaf (wbkit's style) as a layer of a recipe's frame: its own Frame over the hero's leaves.<key> as its data,
    with the hero's style (`fixed`, {node: {knob: value}}, over it: what the recipe's layout sets; then `by_hero`'s, the knobs
    the program reads off the hero itself, as the page's focus), and the series values read from the request's tables
    (wbkit.read_values). A hero that names no leaves.<key> refuses the layer. What the leaf could
    not place (its Frame.dropped, (id, why) each) does not stop the layer: it goes back in DROPPED, even when that is all it
    was given (the layer is drawn empty, and the page still goes out with every dropped item in its ledger)."""
    def draw(f, occ):
        fr = leaf_frame(Frame, f, key, fixed, by_hero); out = cl(fr, occ)
        leaf_records(fr, key)
        return out
    return draw, None


# The map panel of a column page (column.MAP_W wide): its leaves draw in one shared frame (mapkit.View over the hero's
# leaves.bubbles.ext), the bubbles first, so the notes over them keep clear of every circle and label they claimed. The bars
# beside the map print every value, so the map names only its two ends and the biggest, MAP_LABELS in all, label_sep apart.
MAP_LABELS = 12
MAP_STYLE = {"bubbles": {"projection": "view", "width": column.MAP_W, "label_top": MAP_LABELS, "label_sep": 8}, "leader_notes": {"width": column.MAP_W}}
# The key to the circles comes with the bubbles (knobs.py WITH), drawn after them and before the notes, which keep clear of it.
MAP_LAYERS = ["bubbles", "bubble_key", "leader_notes"]
def notes_first(h):
    """The leader notes laid out first when the plain order leaves one of them with no place: the page's focus
    (column.focus), the place its headline names."""
    return {"leader_notes": {"first": ",".join(column.focus(h))}}


# The map layer drawn from another's leaves: the key reads the bubbles' entry.
MAP_LEAVES = {"bubble_key": "bubbles"}


def focus_style(h):
    """The bubbles' highlight: the page's focus (column.focus) that the map draws a circle for, in the accent, as its bars; and
    their noted: the other places the notes name (column.noted), in the dark grey, as their bars."""
    drawn = {i.get("code") for i in ((h.get("leaves") or {}).get("bubbles") or {}).get("items") or [] if isinstance(i, dict)}
    return {"bubbles": {"highlight": ",".join(c for c in column.focus(h) if c in drawn),
                        "noted": ",".join(c for c in column.noted(h) if c in drawn)}}


def bubble_key(f, occ):
    """The key to the map's circles (bubbles.cl_bubble_key) over the panel's frame; a key it could not place goes back in
    DROPPED, the layer drawn empty."""
    out = bubbles.cl_bubble_key(f, occ)
    DROPPED.extend({"id": c, "why": why} for c, why in f.key_dropped)
    return out


# The chart leaves a column page's frame holds beside its own layers, and which of them are svg.
LEAF_LAYERS = dict(section_head=leaf(section_head.Frame, section_head.cl_section_head, "section_head"),
                   rankbar=leaf(rankbar.Frame, rankbar.cl_rankbar, "rankbar"),
                   bubbles=leaf(bubbles.Laid, bubbles.cl_bubbles, "bubbles", MAP_STYLE, focus_style),
                   bubble_key=(bubble_key, None),
                   leader_notes=leaf(leader_notes.Frame, leader_notes.cl_leader_notes, "leader_notes", MAP_STYLE, notes_first),
                   sankey=leaf(sankey.Frame, sankey.cl_sankey, "sankey"),
                   stacked100=leaf(stacked100.Frame, stacked100.cl_stacked100, "stacked100"))
LEAF_SVG = (section_head.SECTION_HEAD_SVG + rankbar.RANKBAR_SVG + bubbles.BUBBLES_SVG + leader_notes.LEADER_NOTES_SVG + sankey.SANKEY_SVG
            + stacked100.STACKED100_SVG)


# The page recipes this child draws: each one's layers (name -> (draw, reserve)) and which of them are svg.
# The page recipes whose page places the illustration strip layer 1 gives it (column_page; the ring and scmp pages have no
# slot and refuse one): knobs.py declares the slot on exactly these recipes, which layer 1 asks a strip for.
STRIP_SLOT = ("column", "change")
# The main layer of each page recipe the column frame draws, the picture the page is built around (column_page; knobs.py
# copies it into the recipe as `main`): the bars, or a chart leaf of LEAF_LAYERS in their place, across the page.
MAIN = dict(column="bars", change="bars", flow="sankey", composition="stacked100")
# The recipes a column page draws: column, change (its bars the places' change between two years, bars.measure), and flow
# (a sankey across the page, its main).
COLUMN_KINDS = tuple(MAIN)
KINDS = dict(ring=(scmp.RING_LAYERS, scmp.RING_SVG), **{k: ({**column.COLUMN_LAYERS, **LEAF_LAYERS}, column.COLUMN_SVG + LEAF_SVG) for k in COLUMN_KINDS},
             scmp=(scmp.SCMP_LAYERS, scmp.SCMP_SVG))


def bubbles_frame(f):
    """The bubbles' input half over the panel's hero (bubbles.Frame: the view, the items, their values, names, ledger entries
    and points, each refusal in its own words), as the bubbles leaf reads it under MAP_STYLE and the page's focus."""
    return leaf_frame(bubbles.Frame, f, "bubbles", MAP_STYLE, focus_style)


def bubbles_placed(f, occ, g):
    """The bubbles drawn from the core's placed geometry (bubbles.cl_bubbles_placed), with the leaf's records as before."""
    fr = bubbles_frame(f); out = bubbles.cl_bubbles_placed(fr, occ, g)
    leaf_records(fr, "bubbles")
    return out


# The layers a leaf draws from the geometry the core placed and checked (knobs.placed[layer], src/next_tree.rs node_draw),
# by layer: the ones a page recipe may bind external. The bars draw level or change bars by the panel's measure.
PLACED_LAYERS = dict(bars=lambda f, occ, g: column.cl_change_bars_placed(f, g) if f.change else column.cl_bars_placed(f, occ, g),
                     bubbles=bubbles_placed)
# What a layer drawn from placed geometry reads of its own input (P4a-2): run before refusing a missing geometry, so a
# layer whose input is off refuses in its own words, as before it was external. The bars read the panel's (ColumnFrame).
INPUT_HALF = dict(bubbles=bubbles_frame)
# The ground phase: what the leaf gives an external node to choose among places the core holds equally good (the map
# circles' land rows), by layer; never checked, never a number on the page.
GROUND = dict(bubbles=lambda h: bubbles.ground(leaf_frame_hh(h, "bubbles", MAP_STYLE, focus_style)))


def leaf_frame_hh(h, key, fixed, by_hero):
    """The {data, style} a chart leaf's Frame reads, over a hero (leaf_frame's, with no panel)."""
    d = (h.get("leaves") or {}).get(key)
    if d is None: raise FX.Refused(f"the hero names no leaves.{key}")
    st = dict(h.get("style", {}))
    for node, kv in [*(fixed or {}).items(), *(by_hero(h) if by_hero else {}).items()]: st[node] = {**st.get(node, {}), **kv}
    return {"data": d, "style": st}


def layer_fn(layers, name, knobs):
    """What draws layer `name` of a panel, by its recipe's external layers (knobs.external, the visual group's copy of the
    recipe's list in knobs.json; data, not a switch): a layer bound external is drawn only from its placed geometry
    (PLACED_LAYERS), and with none it refuses, never falling back to the leaf's own layout; a layer not bound external
    that comes with placed geometry refuses; any other is the recipe's own leaf."""
    ext, placed = knobs.get("external") or [], knobs.get("placed") or {}
    if name in ext:
        if name not in PLACED_LAYERS: raise FX.Refused(f"the recipe binds {name} external and no leaf draws it from placed geometry")
        g = placed.get(name)
        # the core's generator found the leaf stops on this layer as drawn its own way (a stop layer 1 makes on its texts):
        # drawn so, to stop in today's words; the drawn check refuses it should the page go on
        if isinstance(g, dict) and list(g) == ["leaf_stop"]: return layers[name][0]
        if not isinstance(g, dict):
            def none(f, occ):
                if name in INPUT_HALF: INPUT_HALF[name](f)  # its own words first
                raise FX.Refused(f"the recipe binds {name} external and the request gives no placed geometry for it")
            return none
        return lambda f, occ: PLACED_LAYERS[name](f, occ, g)
    if name in placed: raise FX.Refused(f"placed geometry for {name}, which the recipe does not bind external")
    return layers[name][0]


class Panel:
    """What one panel's lines share: the context, the recipe's frame and the occupancy table, built on the first line."""
    def __init__(p, req):
        p.node = req.get("node")
        if p.node not in KINDS: raise FX.Refused(f"no page recipe {p.node}; e.g. one of {'|'.join(KINDS)}")
        k = req["knobs"]; spec = k["spec"]; FX.TABLES = tables(req["rows"]); geo.NE = k.get("shapes"); prod.NAMES = k.get("labels") or {}
        p.raw = [r for r in req["rows"] if isinstance(r.get("dims"), dict)]  # B11: the request's series rows, a claim's values
        FX.MEMBERS = list(k["members"]) if k.get("members") else None
        FX.LEDGER = {r["src"]: r["text"] for r in req["rows"] if "text" in r} or None; FX.SEGS = k.get("segs")
        wbkit.COMPARISONS = dict(k["comparisons"]) if isinstance(k.get("comparisons"), dict) else None
        if FX.LEDGER is not None: fact_times(spec)
        spec["fmts"]["bcm0"] = {"scale": 0.01, "dec": 0}  # as scmp.page sets it
        c = prod.Ctx(spec); h = spec["hero"]
        p.c, p.spec, p.occ = c, spec, prod.Occ()
        if p.node in COLUMN_KINDS:
            p.f = column.ColumnFrame(c, h, map_view(h), MAIN[p.node])
            if MAIN[p.node] != "bars": p.f.sized(*main_size(p.f, MAIN[p.node]))
            # the room under the map the bubbles' key may stand in (bubbles.key_room); the map's svg grows into it only when the key does
            if p.f.mv: p.f.H = max(p.f.H, p.f.mv.H + bubbles.key_room(p.f))
            return
        if k.get("shapes") is None: raise FX.Refused(f"the {p.node} page's request gives no shapes")
        if p.node == "scmp":
            p.f = scmp.SquareFrame(c, h); return
        if prod.knob(h, "frame", "gap_dir") == "auto": h = {**h, "_gapdir": scmp.empty_corner(c, h)}
        if scmp.title_in(h): h = {**h, "_title": scmp.page_head(c, spec)}
        # each layer tagged (data-layer) unless a preview asks for it bare: the page phase places and checks tagged layers
        p.f = scmp.RingFrame(c, h); p.f.wrap, p.f.mapout, p.f.ret = k.get("wrap", True), {}, {}


def main_size(f, main):
    """A column page's main leaf drawn once to measure it: its picture's size (DREW), which the leaf settles while it draws
    and the panel takes before any layer line; what it drops is sent when its own layer line draws it."""
    LEAF_LAYERS[main][0](f, prod.Occ()); DROPPED.clear()
    return DREW[main]


def map_view(h):
    """The column page's map panel, when its hero has leaves.bubbles: the frame its map leaves share (MAP_STYLE); a hero
    whose leader notes name another extent than the bubbles' (two projections under one picture), or that has leader notes
    and no bubbles, refuses."""
    lv = h.get("leaves") or {}
    if "bubbles" not in lv:
        if "leader_notes" in lv: raise FX.Refused("column: the leader notes point at the bubbles' map, and the hero has none")
        return None
    if "leader_notes" in lv and lv["leader_notes"].get("ext") != lv["bubbles"].get("ext"):
        raise FX.Refused("column: the leader notes and the bubbles name two extents; the map panel has one frame")
    return mapkit.View({"data": lv["bubbles"], "style": MAP_STYLE}, "bubbles")


class Texts(HTMLParser):
    """The texts an svg layer draws, as layer 1 reads them back (next_leaf drawn_texts): each <text>'s data-src, or else
    its inner elements' joined by "+", and its words; with where it stands (its groups' translates and its nested svgs'
    x, y and viewBox scale applied), its size, anchor, baseline and turn, for layer 1's overlap and line checks. A transform
    or a nested svg it cannot place is said in `bad`."""
    def __init__(s):
        super().__init__(convert_charrefs=True)
        s.out, s.off, s.cur, s.bad = [], [(1.0, 0.0, 0.0)], None, []  # off: (scale, dx, dy) a point inside maps by

    def nested(s, a):
        """A nested <svg>'s (scale, dx, dy) inside its parent: placed at x, y, its viewBox fitted into width x height as the
        default preserveAspectRatio (xMidYMid meet) fits it; one it cannot place is said in `bad` and adds nothing."""
        def num(k, d):  # absent: d; a plain number: it; anything else (10%, 1.2.3) cannot be placed: None
            if a.get(k) is None: return d
            try: return float(a[k]) if re.fullmatch(r"\s*[-+]?(\d+\.?\d*|\.\d+)\s*", a[k]) else None
            except ValueError: return None
        x, y = num("x", 0.0), num("y", 0.0)
        if x is None or y is None:
            s.bad.append(f"a nested svg {a!r} the texts report cannot place"); return 1.0, 0.0, 0.0
        if "viewbox" not in a: return 1.0, x, y  # the parser gives attribute names lower-case
        vb = re.split(r"[\s,]+", a["viewbox"].strip()); w, h = num("width", None), num("height", None)
        if len(vb) != 4 or w is None or h is None or (a.get("preserveaspectratio") or "xMidYMid meet").split() not in (["xMidYMid"], ["xMidYMid", "meet"]):
            s.bad.append(f"a nested svg {a!r} the texts report cannot place"); return 1.0, 0.0, 0.0
        try: vx, vy, vw, vh = map(float, vb)
        except ValueError: s.bad.append(f"a nested svg viewBox {a['viewbox']!r} the texts report cannot place"); return 1.0, 0.0, 0.0
        if vw <= 0 or vh <= 0: s.bad.append(f"a nested svg viewBox {a['viewbox']!r} the texts report cannot place"); return 1.0, 0.0, 0.0
        k = min(w / vw, h / vh)
        return k, x + (w - vw * k) / 2 - vx * k, y + (h - vh * k) / 2 - vy * k

    def push(s, k, dx, dy):
        sc, tx, ty = s.off[-1]; s.off.append((sc * k, tx + sc * dx, ty + sc * dy))

    def handle_starttag(s, tag, attrs):
        a = dict(attrs)
        if s.cur is not None:
            if a.get("data-src"): s.cur["inner"].append(a["data-src"])
        elif tag == "g":
            t = a.get("transform") or ""; m = re.fullmatch(r"\s*translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)\s*", t)
            if t and not m: s.bad.append(f"a group transform {t!r} the texts report cannot place")
            s.push(1.0, *((float(m[1]), float(m[2])) if m else (0.0, 0.0)))
        elif tag == "svg": s.push(*s.nested(a))
        elif tag == "text":
            x, y = float(a["x"]), float(a["y"]); sc, dx, dy = s.off[-1]; deg = 0.0; t = a.get("transform") or ""
            m = re.fullmatch(r"\s*rotate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+))?\s*\)\s*", t)
            if t and not m: s.bad.append(f"a text transform {t!r} the texts report cannot place")
            elif m:
                deg = float(m[1])
                if m[2] is not None and (abs(float(m[2]) - x) > 0.05 or abs(float(m[3]) - y) > 0.05):
                    s.bad.append(f"a text turned about ({m[2]}, {m[3]}), not where it stands ({x}, {y})")
            size = a.get("font-size")
            s.cur = dict(src=a.get("data-src"), inner=[], words="", x=sc * x + dx, y=sc * y + dy, rot=deg,
                         size=sc * float(size.removesuffix("px")) if size else None, anchor=a.get("text-anchor") or "start",
                         baseline=a.get("dominant-baseline") or "")

    def handle_startendtag(s, tag, attrs):
        if tag not in ("g", "svg"): s.handle_starttag(tag, attrs)

    def handle_endtag(s, tag):
        if tag == "text" and s.cur is not None:
            c, s.cur = s.cur, None
            s.out.append(dict(src=c["src"] if c["src"] is not None else "+".join(c["inner"]), text=c["words"], x=c["x"],
                              y=c["y"], size=c["size"], anchor=c["anchor"], baseline=c["baseline"], rot=c["rot"]))
        elif tag in ("g", "svg") and s.cur is None and len(s.off) > 1: s.off.pop()

    def handle_data(s, d):
        if s.cur is not None: s.cur["words"] += d


def drawn(svg):
    """An svg layer's texts as drawn, or the transforms they cannot be placed under."""
    p = Texts(); p.feed(svg); p.close()
    return p.out, p.bad


NOT_LEAF = ("top", "band", "strip", "row", "bignums")


def page(panel, got, sizes=None):
    """The whole page around the layers the panel drew (`got`, layer -> svg or html), as scmp.page lays it out; a column
    page as column_page lays it out, with the pieces another child drew (`sizes`, layer -> [w, h]) among its layers."""
    if panel.node in COLUMN_KINDS: return column_page(panel, got, sizes or {})
    if panel.node == "scmp": return scmp_page(panel, got)
    f, spec = panel.f, panel.spec; tin = bool(f.h.get("_title"))
    # the events layer only for a page with sourced events (a ring of a table's months alone has none to hang)
    pic = [n for n in scmp.RING_SVG if not (n == "inset" and tin) and (n != "events" or spec.get("events"))]
    need = pic + ["legend", "callouts"] + (["inset"] if tin else [])
    off = [f"page: {k} is not drawn by a leaf layer yet" for k in NOT_LEAF if spec.get(k)]
    off += [f"page: no layer {n}" for n in need if not isinstance(got.get(n), str)]
    off += [f"page: {n} is no layer the page places" for n in got if n not in need]
    if not f.wrap: off.append("page: the layers were drawn without data-layer (knobs.wrap)")
    if off: return {"refused": off}
    tag = lambda el, n: f'<{el} data-layer="{n}">{got[n]}</{el}>' if got[n] else ""  # as prod.layered wraps a drawn layer
    ins = got["inset"] if tin else ""  # the title-in inset is placed bare in the title column; it is tagged on its own root element
    if ins and not re.match(r"<\w", ins): return {"refused": ["page: the inset has no root element to tag"]}
    ins = re.sub(r"^<(\w+)", r'<\1 data-layer="inset"', ins, count=1)
    hero = hooked(scmp.ring_shell(f, "".join(tag("g", n) for n in pic), tag("div", "legend"), tag("div", "callouts"), ins, True), panel.c, spec)
    if isinstance(hero, list): return {"refused": hero}
    html = scmp.shell(panel.c, spec, ("" if tin else scmp.page_head(panel.c, spec)) + hero)
    left = placeholders(html)
    return {"refused": [f"page: the page still holds the placeholder {k}" for k in left]} if left else {"html": html}


def column_page(panel, got, sizes):
    """The column page around its layers: the header (with the big numbers beside the title when its recipe draws bignums,
    their box tagged; the title alone across the whole page when not: wide), then under the unit and year line the map panel
    (its layers in one svg, each tagged, when the hero has one) and the bars' picture beside it, or the main leaf's across
    the page in their place (the recipe's main, MAIN); the browser check's hooks as the ring's (column_hooks). Under the hero, above the footer, the illustration strip when layer 1 gives one
    (illus_strip, its size in `sizes`): line art only, in its own svg, hidden from a screen reader."""
    f, spec = panel.f, panel.spec
    need = (["bignums"] if "bignums" in got else []) + [f.main] + (["illus_strip"] if "illus_strip" in got else [])
    if f.mv: need += [n for n in MAP_LAYERS if MAP_LEAVES.get(n, n) in (f.h.get("leaves") or {})]
    off = [f"page: {k} is not drawn by a leaf layer yet" for k in NOT_LEAF if spec.get(k)]
    off += [f"page: no layer {n}" for n in need if not isinstance(got.get(n), str)]
    off += [f"page: {n} is no layer the page places" for n in got if n not in need]
    if not off and "bignums" in got and not re.match(r"<\w", got["bignums"]): off.append("page: the big numbers have no root element to tag")
    wh = sizes.get("illus_strip")
    if "illus_strip" in got and not (isinstance(wh, list) and len(wh) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in wh)):
        off.append("page: the illustration strip comes with no size [w, h]")
    if off: return {"refused": off}
    box = re.sub(r"^<(\w+)", r'<\1 data-layer="bignums"', got["bignums"], count=1) if "bignums" in got else None
    found, said, dek = FOUND.get(f.main), spec, None  # the chart's label and long description keep the text step's words, as before
    if found:
        spec, why = headline(spec, found, got[f.main], panel.raw, CLAIM_WORDS)
        if why: return {"refused": why}
        dek = spec.pop("_dek", None)
    unit = FX.worded(spec, panel.c.F, "unit", spec["hero"]["unit"]) if spec["hero"].get("unit") else ""
    pic = "".join(f'<g data-layer="{n}">{got[n]}</g>' for n in MAP_LAYERS if n in need)
    hero = hooked(column.column_shell(f, f'<g data-layer="{f.main}">{got[f.main]}</g>', unit, pic, f.main), panel.c, said, column_hooks(f.main))
    if isinstance(hero, list): return {"refused": hero}
    strip = column.strip_shell(got["illus_strip"], *wh) if "illus_strip" in got else ""
    head = scmp.page_head(panel.c, spec, box=box, wide=box is None)
    if dek is not None: head = re.sub(r'<p class="dek">.*?</p>', lambda m: f'<p class="dek">{dek}</p>', head, count=1, flags=re.S)
    html = scmp.shell(panel.c, spec, head + hero + strip, column.CSS)
    left = placeholders(html)
    return {"refused": [f"page: the page still holds the placeholder {k}" for k in left]} if left else {"html": html}


def headline(spec, found, svg, raw=(), words=None):
    """The page's title from its main leaf's finding (P5, wbkit.two_sided), as layer 1's title_and_kicker does with a
    headline: the finding's headline is the title, the title the text step gave the kicker (the kicker kept when that title
    holds a digit or a placeholder, which a chart label cannot). Refuses when the main picture's accent marks (data-code
    in the accent) are not exactly the finding's subject, or the headline does not name the subject by its name row."""
    acc = set(re.findall(r'fill="var\(--accent\)"[^>]*data-code="([^"]+)"', svg))
    if acc != {found["subject"]}: return spec, [f"page: the accent marks {sorted(acc)}, the headline's subject is {found['subject']}"]
    if not any(s.get("name") == found["subject"] for s in found["headline"]):
        return spec, [f"page: the headline does not name its subject {found['subject']}"]
    claim = title_claim(spec.get("title"), found, spec, raw, words)
    if claim:  # B11: the text step's title is the h1, its claim marked; the finding with its numbers is the dek
        rel, a, b = found["dek_cmp"]
        dek = f'<span data-cmp="{rel}" data-a="{wbkit.esc(a)}" data-b="{wbkit.esc(b)}">' + wbkit.finding_html(found["dek"], "span") + "</span>"
        return {**spec, "title": claim, "_dek": dek}, None  # _dek: the page's dek html, column_page takes it out
    old = str(spec.get("title") or "")
    kick = old if old.strip() and not re.search(r"[{}0-9\uff10-\uff19]", old) else spec.get("kicker")
    rel, a, b = found["cmp"]  # the set it ranks in is the page check's to derive; a next names the second it is above
    mark = f'<span data-cmp="{rel}" data-a="{wbkit.esc(a)}"' + (f' data-b="{wbkit.esc(b)}"' if rel != "max" else "") + ">"
    return {**spec, "title": mark + wbkit.finding_html(found["headline"], "span") + "</span>", "kicker": kick}, None


def _value(q, raw):
    """A value fact's number as its definition reads the request rows (op value: the rows of its table and time whose dims
    hold its filter's codes, summed), the way the visual group computes it; None for any other op."""
    if not isinstance(q, dict) or q.get("op") != "value" or not isinstance(q.get("filter"), dict): return None
    want = {d: set(v) if isinstance(v, list) else {v} for d, v in q["filter"].items()}
    return sum(float(r["value"]) for r in raw if r.get("table") == q.get("table") and r.get("time") == q.get("time")
               and all(r["dims"].get(d) in cs for d, cs in want.items()))


def _family(k, facts):
    """The page check's comparison set of a value fact (next_ledger.rs family): op value, same table, time and format, a filter
    over the same one dimension."""
    same = lambda q: (q.get("op"), q.get("table"), q.get("time"), q.get("fmt"), tuple(sorted(q["filter"])))
    one = lambda q: isinstance(q, dict) and q.get("op") == "value" and isinstance(q.get("filter"), dict) and len(q["filter"]) == 1
    return sorted(o for o, q in facts.items() if one(q) and one(facts[k]) and same(q) == same(facts[k]))


def title_claim(title, found, spec, raw, words):
    """B11: the text step's title kept as the page's h1 when it states a claim the data hold, else None (the finding's
    headline stays the title, as before). Program rules over the model's words, the claim read from the data, never from
    the model: the title names, by a name row's text or its first two characters, either one node of the picture (a node
    claim: max over its fact's family, as the page check derives it) or one source and one target (a flow claim: its row
    the max of every request row of its table and time, and its drawn cell above every other cell); a name two codes share,
    a merged member, a digit or a {placeholder} gives no claim. Its words outside the names hold a max word, a verb that makes
    it a conclusion and no off word (`words`, the page line's claim_words). The h1: the title with each name marked by its
    row (a two-character name printed whole), in a span stating the claim (data-claim max, data-a the fact or row)."""
    sh = found.get("shape"); facts = spec.get("facts") or {}
    if not (words and sh and isinstance(title, str) and title.strip()) or FX.digit(title) or re.search(r"[{}]", title): return None
    alias = {}
    for j, (kind, named, small) in enumerate(sh["sides"]):
        for c in named + small:
            row = wbkit.name_row(c, kind)
            if row not in (FX.LEDGER or {}): continue
            nm = FX.text(row)
            for al in {nm} | ({nm[:2]} if len(nm) > 2 else set()): alias.setdefault(al, set()).add((j, c, c in named, row, nm))
    hits, taken = [], [False] * len(title)
    for al in sorted(alias, key=len, reverse=True):
        for m in re.finditer(re.escape(al), title):
            if any(taken[m.start():m.end()]): continue
            if len(alias[al]) > 1: return None
            hits.append((m.start(), m.end(), next(iter(alias[al]))))
            taken[m.start():m.end()] = [True] * (m.end() - m.start())
    named = sorted({(h[2][0], h[2][1], h[2][2]) for h in hits})
    if not named or not all(n[2] for n in named): return None
    bare = "".join(ch for i, ch in enumerate(title) if not taken[i])
    if not any(w in bare for w in words["max"]) or any(w in bare for w in words["off"]) or not any(w in bare for w in words["verb"]): return None
    if len(named) == 1:  # a node: the fact whose filter is its one code, max over its family
        (j, c, _), = named; dim = sh["sides"][j][0]
        k = next((o for o, q in facts.items() if isinstance(q, dict) and q.get("op") == "value" and q.get("filter") == {dim: c}), None)
        fam = _family(k, facts) if k else []
        if len(fam) < 2: return None
        v = {o: _value(facts[o], raw) for o in fam}
        if not all(v[k] > v[o] for o in fam if o != k): return None
        cmp = wbkit.compared(f"fact:{k}")  # the core's own set (other codes of the rows in it) holds it first, unscoped
        if wbkit.COMPARISONS is not None and (cmp is None or cmp.get("scoped") or cmp.get("first") != c): return None
        a = f"fact:{k}"
    elif len(named) == 2 and {n[0] for n in named} == {0, 1}:  # a flow: its row over every row of its table and time
        s_, t_ = (n[1] for n in sorted(named))
        src = next((fl["value"] for fl in sh["flows"] if fl["source"] == s_ and fl["target"] == t_), None)
        me = next((r for r in raw if r.get("src") == src), None)
        if me is None: return None
        same = [r for r in raw if r.get("table") == me.get("table") and r.get("time") == me.get("time")]
        cells = sh["cells"]
        if not all(float(me["value"]) > float(r["value"]) for r in same if r is not me): return None
        if not all(cells.get((s_, t_), 0) > v for key, v in cells.items() if key != (s_, t_)): return None
        a = src
    else: return None
    out, at = [], 0
    for st, en, (_, _, _, row, nm) in sorted(hits):
        out.append(wbkit.esc(title[at:st])); out.append(f'<span data-src="{wbkit.esc(row)}">{wbkit.esc(nm)}</span>'); at = en
    out.append(wbkit.esc(title[at:]))
    return f'<span data-claim="max" data-a="{wbkit.esc(a)}">' + "".join(out) + "</span>"


def scmp_page(panel, got):
    """The scmp page around its layers, as scmp.page lays a hero page out: the header with the big numbers beside the title
    (bignums, its box tagged), the hero (the map between the note columns, the notes over it, the unit line), then the strip
    when the request has one; the browser check's hooks as the ring's (SCMP_HOOKS)."""
    f, spec, c = panel.f, panel.spec, panel.c
    need = [n for n in scmp.SCMP_LAYERS if n != "strip" or f.st]
    off = [f"page: {k} is not drawn by a leaf layer yet" for k in NOT_LEAF if spec.get(k)]
    off += [f"page: no layer {n}" for n in need if not isinstance(got.get(n), str)]
    off += [f"page: {n} is no layer the page places" for n in got if n not in need]
    if not off and not re.match(r"<\w", got["bignums"]): off.append("page: the big numbers have no root element to tag")
    if off: return {"refused": off}
    box = re.sub(r"^<(\w+)", r'<\1 data-layer="bignums"', got["bignums"], count=1)
    h = spec["hero"]; unit = FX.worded(spec, c.F, "unit", h["unit"]) if h.get("unit") else ""
    hero = hooked(scmp.scmp_shell(f, f'<g data-layer="map">{got["map"]}</g>', f'<div data-layer="notes">{got["notes"]}</div>', unit), c, spec, SCMP_HOOKS)
    if isinstance(hero, list): return {"refused": hero}
    strip = scmp.strip_shell(f, f'<g data-layer="strip">{got["strip"]}</g>') if f.st else ""
    html = scmp.shell(c, spec, scmp.page_head(c, spec, box=box) + hero + strip, scmp.SCMP_CSS)
    left = placeholders(html)
    return {"refused": [f"page: the page still holds the placeholder {k}" for k in left]} if left else {"html": html}


def placeholders(html):
    """Every {key} left anywhere on the page, its scripts and styles included (the layout script writes into the page);
    only a script's ${...} template brace passes."""
    return sorted(set(re.findall(r"(?<!\$)\{[A-Za-z_][\w.]*\}", html)))


# The browser check's module and accessibility hooks (browser_qa.py inspect_page): the ring hero is the page's one module
# (.pub-visual with a data-module-id), its picture svg the module's chart (.pub-chart: role img, an aria-label, a long
# description by aria-describedby, focusable). Each is added at one place and nowhere else, so the parity check can drop
# exactly these and compare the rest with the prototype byte for byte. The long description is the title filled through
# the ledger (c.t, its numbers marked like the h1's); an attribute cannot carry a mark, so the label is words only
# (chart.label around the kicker) and refuses a digit or a "{".
HOOKS = (('<div class="hero ring"', '<div class="hero ring pub-visual" data-module-id="ring"'),
         ('<svg class="leads"', '<svg class="leads pub-chart" role="img" aria-label="{label}" aria-describedby="desc-ring" tabindex="0"'),
         ('</div><script>', '<p id="desc-ring" hidden>{desc}</p></div><script>'))


# The column page's hooks, as the ring's: its hero the module, its main layer's svg (the bars', or the leaf's in their place)
# the chart.
def column_hooks(main="bars"):
    return (('<div class="hero column"', '<div class="hero column pub-visual" data-module-id="column"'),
            (f'<svg class="{main}"', f'<svg class="{main} pub-chart" role="img" aria-label="{{label}}" aria-describedby="desc-column" tabindex="0"'),
            ('</svg></div>', '</svg><p id="desc-column" hidden>{desc}</p></div>'))


# The scmp page's hooks, as the ring's: its hero the module, the map's svg the chart.
SCMP_HOOKS = (('<div class="hero scmp"', '<div class="hero scmp pub-visual" data-module-id="scmp"'),
              ('<svg class="pic"', '<svg class="pic pub-chart" role="img" aria-label="{label}" aria-describedby="desc-scmp" tabindex="0"'),
              ('<svg class="leads"', '<p id="desc-scmp" hidden>{desc}</p><svg class="leads"'))


def hooked(hero, c, spec, hooks=HOOKS):
    off = [f"page: the hero has {hero.count(a)} of {a!r}, not one" for a, _ in hooks if hero.count(a) != 1]
    if not re.sub(r"<[^>]*>", "", str(spec.get("title") or "")).strip(): off.append("page: the page has no title to name its chart")
    kick = str(spec.get("kicker") or "").strip()
    label = prod.esc(word("chart.label", v=kick)) if kick else ""
    if not kick: off.append("page: the page has no kicker to label its chart")
    elif re.search(r"[{}0-9\uff10-\uff19]", kick): off.append(f"page: the chart label holds a digit or a placeholder: {kick!r}")
    if off: return off
    for a, b in hooks: hero = hero.replace(a, b.replace("{label}", label).replace("{desc}", c.t(spec["title"])), 1)
    return hero


def main():
    panel, off, node = None, None, None
    for line in sys.stdin:
        req = json.loads(line)
        node = req.get("node", node)  # the page line names none: the panel's
        layers, svgs = KINDS.get(node, ({}, []))
        if req.get("phase") == "ground":  # before any panel: the ground an external node is given (GROUND)
            try:
                FX.TABLES = tables(req.get("rows") or []); geo.NE = (req.get("knobs") or {}).get("shapes")
                out = {"land": GROUND[req["layer"]](req["knobs"]["spec"]["hero"])}
            except KeyError as e: out = {"refused": [f"ground: no ground for {e}"]}
            except FX.Refused as e: out = {"refused": [f"ground: {e}"]}
            print(json.dumps(out), flush=True); continue
        if req.get("phase") == "page" and not (panel or off):
            print(json.dumps({"refused": ["page: the page line came before any layer line"]}), flush=True); continue
        if not (panel or off):
            try: panel = Panel(req)
            except FX.Refused as e: off = e  # the frame lays the map out to find its empty corner: every layer of the panel refuses
            except Exception as e: off = FX.Refused(f"the panel failed: {type(e).__name__} {e}")  # said, not a child that exits
        name = req.get("layer")
        if req.get("phase") == "size": out = {"refused": [f"size: {off}"]} if off else {"w": panel.f.W, "h": panel.f.H}
        elif req.get("phase") == "page":
            global CLAIM_WORDS
            CLAIM_WORDS = req.get("claim_words")
            if off: out = {"refused": [f"page: {off}"]}
            else:
                try: out = page(panel, req.get("layers") or {}, req.get("sizes") or {})
                except FX.Refused as e: out = {"refused": [f"page: {e}"]}
        elif name not in layers: out = {"error": f"no {node} layer {name}"}
        elif off: out = {"refused": [f"{name}: {off}"]}
        elif req.get("phase") == "reserve":
            fn = layers[name][1]
            try:
                if fn: fn(panel.f, panel.occ)
                out = {}
            except FX.Refused as e: out = {"refused": [f"{name}: {e}"]}
        else:
            try:
                DROPPED.clear(); SCALE.clear()
                s = layer_fn(layers, name, req.get("knobs") or {})(panel.f, panel.occ)
                out = {"svg" if name in svgs else "html": s}
                if DROPPED: out["dropped"] = list(DROPPED)
                out.update(SCALE)
                if name in svgs:  # what it drew, read back as layer 1 reads it, for its checks
                    out["texts"], bad = drawn(s)
                    if bad: out = {"refused": [f"{name}: {b}" for b in bad]}
                if name == "map": out["sub"] = panel.f.mapout  # the map's own layers, for the layer-by-layer parity check
            except FX.Refused as e: out = {"refused": [f"{name}: {e}"]}
            except Exception as e: out = {"refused": [f"{name}: the layer failed: {type(e).__name__} {e}"]}
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
