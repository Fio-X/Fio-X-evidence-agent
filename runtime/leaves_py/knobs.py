"""Writes knobs.json, the leaf registry layer 1 reads (src/next_leaf.rs, include_str!): every leaf node with its knobs as
prod.KNOBS (scmp's included) states them, whether it reserves room before the others draw, each group's layers in order,
and where each legacy node reads its older keys. A word knob also takes the words the prototype's own pages set
(page_knobs.json, each with its page and key); a page number off its range or step stops the writer instead of widening it.
KNOBS and the pages stay the sources: scripts/test_leaves_knobs.py fails when the file is stale, and a knob whose kind is
not plain (three numbers, a word among words, or a comma list of codes with no options and an empty default) stops the
writer instead of being guessed.
Run: python3 -I -B runtime/leaves_py/knobs.py [--pages <the prototype's page folder>]"""
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bubbles
import leader_notes
import prod
import rankbar
import run
import sankey
import scmp
import section_head
import stacked100
import line
import rank_lines
import dumbbell
import waterfall
import waffle
import stacked_area
import gap_axis
import winners_losers
import event_chain
import target_path
import pair_bars
import thesis_claims
import risk_notes
import small_multiples
import member_map
import change_dots
import rank_slope
import tile_map
import story

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "knobs.json")
PAGE_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "page_knobs.json")
# The prototype's pages with a hero, whose knob values the registry takes.
PAGES = ("page-gas-ring.json", "page-gas-scmp.json", "page-gas-scmp2.json")
# Where in the hero each legacy node reads its older keys (prod.knob's cfg): frame gets the hero (scmp.py, run.py),
# base the map's cfg, which is {**hero.data, style} (scmp.py MapFrame, prod.ml_base and the inset's sea).
READS = {"frame": [], "base": ["data"]}
# The page recipes, each a page's outermost composite node, in the order layer 1 tries them (src/next_run.rs leaf_page):
# the layers its page draws (its group's, bottom first; a ring page has no event records yet), the shape conditions its
# tables must meet, in the order they are checked (src/next_run.rs SHAPE_CONDITIONS), the charts the charts step must have
# drawn its main as (none: the shape alone decides), the program's picks over the shape and the claims (src/next_run.rs
# PICK_RULES), the few knobs it exposes, its page's time window (the two picks it runs between; none: each layer its own),
# the pairs of its layers that print the same measure by design (same_measure; none: no two may, src/next_run.rs
# page_checks), whether its page has a slot for the illustration strip (strip; none: no slot, layer 1 asks for no
# strip and holds the page to none; run.STRIP_SLOT names the pages that place one), and, on a column frame page, its main
# layer (main: the picture the page is built around, run.MAIN; none: the page is no column frame page).
RECIPES = [
    dict(name="scmp", layers=["map", "strip", "bignums", "notes"],
         eats=["annual", "years_2", "hub_origin", "one_unit", "others_single", "monthly_companion"], charts=[],
         picks=["change_focus"], exposes=[], window=["t0", "t1"], relation="Flow"),
    dict(name="ring", layers=["map", "ring", "callouts", "legend", "inset"],
         eats=["annual", "years_2", "hub_origin", "one_unit", "others_single", "monthly_companion"], charts=[],
         picks=["change_focus"], exposes=["frame.gap_dir", "frame.title_in", "ring.months", "ring.color", "names.font"],
         relation="Flow"),
    # a composition across places: one 100% bar per place of the main's sum-input fetch (its groups' input codes, the top
    # places by total, layer 1's cut), each bar's total printed beside it; before change and column, which would read the
    # main's totals alone, and only for a main the program fetched sum inputs for (composition_groups)
    # one place's whole and its parts (a block of a table its blocks share, next_run.rs composition_groups' one bar), as
    # steps that walk the whole: the sketch compare's pick over the one 100% bar (sketch.json: position 4 + the lead marked
    # 2 against length 3 + 2 - 1, the reader comparing segments), so it is tried first; the same rows and declaration as
    # composition's (node-bindings.json waterfall declares_as stacked100). Two places or more are not one whole: composition
    # only a block of a many-block page draws it (blocks_only, owner 11-16 08:4x item 10): a short page of one place's parts
    # keeps its 100% bar (composition)
    dict(name="composition_steps", layers=["waterfall"], eats=["annual", "one_unit", "composition_groups", "one_whole"], charts=[],
         picks=[], exposes=[], main="waterfall", blocks_only=True, relation="Composition"),
    dict(name="composition", layers=["stacked100"], eats=["annual", "one_unit", "composition_groups"], charts=[], picks=[],
         exposes=[], main="stacked100", relation="Composition"),
    # a long page of sections (the sample page's shape: an opening picture, the thesis, the one-axis answer, sections each with its
    # kicker, conclusion title, text and one picture, the notes under it): the leaves are story.STORY_LAYERS and the sections, their
    # titles and texts are the request's (spec.sections), so the page is tried first for a request that carries a target (has_target:
    # a row the page runs to), before the one-line page of the same table. Layers print from the sections the flow writes.
    # With no target row (pj004-23, 11-23) the page is still tried first, without has_target, behind the minimums of "without": the
    # arcs that need no target ("happened", "lagging", findings.py ARCS) tell three findings of different kinds (a lead, the
    # finding its arc needs, one more), and the comparisons that say who lags (rank, members, map, findings.py MAP_MIN) need a
    # field of eight members at least; a smaller field or fewer findings goes on to the ordinary page
    dict(name="page_story", layers=list(story.STORY_LAYERS), eats=["annual", "years_2", "one_place", "one_unit", "last_year", "two_ends", "has_target"],
         without=dict(condition="has_target", members=8, findings=3, relations=["Ranking"],
                      why="with no target: three findings of different kinds make an arc, eight members at least say who lags; a table step that kept a ranking (who lags, how far apart) holds the same years, so the arcs read it too"),
         charts=[], picks=[], exposes=[], strip=True, opening=True, relation="Change"),
    # one country over the years (a table whose one place holds every row, the shape's two ends: one_country, two_ends): its line
    # from the earlier end to the later, its highest point the axis; the dek its own rise or fall between the two ends (owner
    # 11-14 16:0x item 2's line leaf; round 16: v3, r2v14, r2v17, r2v18 asked one place's change and had no page)
    dict(name="one_line", layers=["line"], eats=["annual", "one_freq", "years_2", "one_country", "one_unit", "last_year", "two_ends"],
         charts=["line"], picks=["changed"], exposes=[], main="line", relation="Change"),
    # two ends of a ten-year table: each place's change from t0 to t1 as signed bars (bars.measure change, set by layer 1),
    # and their notes, no map (11-22: readers took a map of the level at t1 for the change); a table of one year has no two
    # ends and goes on to column. It answers the Change relation (relation): a table step that kept another relation for the
    # main table (a ranking of the last year) goes on to column
    dict(name="change", layers=["bars", "leader_notes"],
         eats=["annual", "years_2", "one_place", "one_unit", "last_year", "two_ends"],
         charts=["choropleth", "horizontal_bar", "dumbbell", "line"], picks=["changed", "claim_marks"], exposes=[], strip=True,
         main="bars", relation="Change"),
    # the same two ends as signed bars alone, no notes (owner 11-19 23:1x, for a place with no map point: an aggregate,
    # World Bank's regions and the world, the EU). Since change's notes stand at its bars (11-22), change takes those
    # places too and comes first, so no page reaches this recipe; it stays registered, a fallback
    dict(name="change_bars", layers=["bars"], eats=["annual", "years_2", "one_place", "one_unit", "last_year", "two_ends"],
         charts=["horizontal_bar", "dumbbell", "line"], picks=["changed", "claim_marks"], exposes=[], strip=True, main="bars",
         relation="Change"),
    # one period across places: a year, or the half year or month most places have a value at (one_freq, last_year)
    # (11-13, v5 item 2: no map: it drew the bars' own values at their year; the notes point at the bars, run.bar_notes)
    dict(name="column", layers=["bars", "leader_notes"], eats=["one_freq", "one_place", "one_unit", "last_year"],
         charts=["choropleth", "horizontal_bar"], picks=["ranked", "claim_marks"], exposes=[], strip=True, main="bars",
         relation="Ranking"),
    # the same period across places as the bars alone, no notes (for a place with no map point: an aggregate the question
    # names beside countries, the EU). Since column's notes stand at its bars (11-22), column takes those places too and
    # comes first, so no page reaches this recipe; it stays registered, a fallback
    dict(name="ranked_bars", layers=["bars"], eats=["one_freq", "one_place", "one_unit", "last_year"],
         charts=["horizontal_bar"], picks=["ranked", "claim_marks"], exposes=[], strip=True, main="bars", relation="Ranking"),
    # a flow between two dimensions of one table (the registry's official pair, one unit) as a sankey across the column
    # page, under the page's header and over its source line; no notes yet (the column page's notes point at a map)
    dict(name="flow", layers=["sankey"], eats=["official_flow", "one_unit"], charts=[], picks=[], exposes=[], main="sankey",
         relation="Flow"),
    # the places' standing on every quantity of a many-block page whose blocks all rank places (名次对照; owner 11-14 16:0x
    # items 1 and 5): one column of ranks per block's table, a line per place the first block ranked. It eats blocks, so
    # layer 1 tries it only for the page over the blocks (src/next_run.rs leaf_request of_blocks) and no other page tries it
    dict(name="block_ranks", layers=["rank_lines"], eats=["one_freq", "one_place", "one_unit", "last_year", "blocks"], charts=[],
         picks=["ranked"], exposes=[], main="rank_lines", relation="Ranking"),
]
# The data relations a recipe declares it answers (recipes[].relation), by the names of src/shape_registry.rs RELATIONS: a
# recipe is passed over when the table step kept another for the main table, so a page never answers a relation the table
# step did not keep (a change asked is never drawn as a ranking); every recipe declares one (recipes), and a kept relation
# no recipe of the data's shape answers stops the page (src/next_run.rs leaf_request) rather than drawing another.
RELATIONS = ("Flow", "Composition", "Map", "Change", "Ranking", "Distribution")
# The shape conditions each node of a recipe needs its tables to meet; a recipe's conditions hold every one its layers'
# nodes need.
EATS = dict(map=["hub_origin", "one_unit"], ring=["monthly_companion"], callouts=[], legend=[], inset=[],
            bars=["one_place", "one_unit", "last_year"], bignums=["one_unit"], notes=["hub_origin", "one_unit"],
            strip=["monthly_companion"], section_head=[], rankbar=["annual", "one_place", "one_unit", "last_year"],
            bubbles=["one_place", "one_unit", "last_year"], bubble_key=["one_place", "one_unit", "last_year"],
            leader_notes=["one_unit"], sankey=["official_flow", "one_unit"], stacked100=["annual", "one_unit", "composition_groups"],
            line=["one_freq", "one_unit"], rank_lines=["one_freq", "one_place"],
            dumbbell=["annual", "years_2", "one_place", "one_unit", "two_ends"],
            waterfall=["annual", "one_unit", "composition_groups"],
            waffle=["annual", "one_unit", "composition_groups"], stacked_area=["one_freq", "one_unit", "composition_groups"],
            gap_axis=["annual", "one_unit"], winners_losers=["one_unit"], event_chain=[], target_path=["annual", "one_unit"], pair_bars=["one_unit"], thesis_claims=[], risk_notes=[], small_multiples=["annual", "one_unit"], member_map=["annual", "one_unit"], change_dots=["annual", "one_unit"], rank_slope=["annual", "one_unit"], tile_map=["annual", "one_unit"])
# The nodes whose dropped items are short notes (a note with no free place, beside the picture, not a mark of it): a page
# goes on without some of them, each kept in its ledger, when no more than a third of the layer's notes are dropped and none
# is the note of a place its headline names (user 11-05 10:2x (b)); a dropped item of any other node (a label on the main
# picture) still stops the page. Written into knobs.json as each recipe's "short_notes" (the layer and where in the page spec its
# notes are listed, a JSON pointer: its leaf data's key), so the flow reads the recipe, never a node name. Data, not a switch.
SHORT_NOTES = dict(leader_notes="notes")
# The nodes a node brings with it: every recipe that draws the node draws these right after it, in this order (a key to its
# marks), so no recipe can draw the marks without them; a recipe that names one itself refuses.
WITH = dict(bubbles=["bubble_key"])
# Which layers each page recipe binds external (P4a): the page tree core's bindings (runtime/page_tree/node-bindings.json
# "recipes") name them, each a layer of the recipe whose node the core binds external, and they are written into knobs.json
# as the recipe's "external"; the flow then declares them through the visual group's page tree generator and the leaf draws
# them from the geometry the core checked (run.py placed_layer). Every other layer of a recipe prints only from what the
# others put (PRINTS_ONLY); the flow fills none itself (P6), so a layer that is neither refuses here. Data, not a switch.
# The layers that put nothing into a page's request: each prints from what the recipe's other layers put.
PRINTS_ONLY = ["callouts", "legend", "inset", "bubble_key", *story.STORY_LAYERS]   # story: its sections are the request's (spec.sections)
BINDINGS_OF_CORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "page_tree", "node-bindings.json")
# What a shape condition reads that an earlier one writes (src/next_run.rs): each list is one need, met by any condition in
# it standing before. A recipe that names the condition names one of each need first, or the condition can only refuse.
NEEDS = dict(monthly_companion=[["hub_origin"], ["one_unit"]], others_single=[["hub_origin", "one_place"]],
             last_year=[["one_place", "one_country"]], two_ends=[["last_year"]])


def num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def knob(node, name, t):
    default, choices, what = t
    if choices is None:  # a comma list of codes: the leaf checks each against what it draws (wbkit.knob, check_codes)
        if default == "":
            return dict(name=name, default=default, codes=True, what=what)
        raise SystemExit(f"{node}.{name}: {t!r} is a list of codes whose default is not empty")
    if num(default) and len(choices) == 3 and all(map(num, choices)):
        lo, hi, step = choices
        if not (lo <= default <= hi and step > 0):
            raise SystemExit(f"{node}.{name}: {t!r} is no range (it needs min <= default <= max and a step above 0)")
        return dict(name=name, default=default, min=lo, max=hi, step=step, what=what)
    if isinstance(default, str) and choices and all(isinstance(c, str) for c in choices) and default in choices:
        return dict(name=name, default=default, options=list(choices), what=what)
    raise SystemExit(f"{node}.{name}: {t!r} is neither a range (three numbers), a word among words nor a list of codes")


def page_values(folder):
    """Every knob value the prototype's pages set: hero.style, and each legacy node's keys where that node reads them."""
    out = []
    for f in PAGES:
        h = json.load(open(os.path.join(folder, f), encoding="utf-8"))["hero"]
        for node, kv in sorted(h.get("style", {}).items()):
            out += [dict(node=node, knob=k, value=v, at=f"{f} hero.style.{node}.{k}") for k, v in sorted(kv.items())]
        for node, path in sorted(READS.items()):
            cfg = h
            for p in path: cfg = cfg.get(p, {})
            out += [dict(node=node, knob=k, value=cfg[k], at=f"{f} hero.{'.'.join(path + [k])}") for k in prod.KNOBS[node] if k in cfg]
    return out


def take(nodes, pages):
    """The pages' values into the registry: a word joins its knob's options with where it was set; a number must be on
    its knob's range and step already."""
    for v in pages:
        k = next((k for k in nodes.get(v["node"], {}).get("knobs", []) if k["name"] == v["knob"]), None)
        if k is None:
            raise SystemExit(f"{v['at']}: no knob {v['node']}.{v['knob']} in KNOBS")
        if "options" in k and isinstance(v["value"], str):
            if v["value"] not in k["options"] or v["value"] in k.get("pages", {}):
                k.setdefault("pages", {}).setdefault(v["value"], []).append(v["at"])
                k["options"] += [v["value"]] * (v["value"] not in k["options"])
            continue
        n = (v["value"] - k["min"]) / k["step"] if "step" in k and num(v["value"]) else None
        if n is None or not (k["min"] <= v["value"] <= k["max"] and abs(n - round(n)) < 1e-6):
            raise SystemExit(f"{v['at']}: {v['value']!r} is off {v['node']}.{v['knob']} {({x: k[x] for x in k if x not in ('name', 'what')})}")


def table():
    columns = run.KINDS["column"][0]  # the column page's own layers and the chart leaves over its frame (run.LEAF_LAYERS)
    groups = dict(map=list(prod.MAP_ORDER), ring=list(scmp.RING_LAYERS), charts=list(prod.CHARTS), column=list(columns),
                  change=list(run.KINDS["change"][0]), flow=list(run.KINDS["flow"][0]), composition=list(run.KINDS["composition"][0]),
                  ranked_bars=list(run.KINDS["ranked_bars"][0]), change_bars=list(run.KINDS["change_bars"][0]), block_ranks=list(run.KINDS["block_ranks"][0]),
                  composition_steps=list(run.KINDS["composition_steps"][0]), one_line=list(run.KINDS["one_line"][0]), page_story=list(run.KINDS["page_story"][0]),
                  scmp=list(scmp.SCMP_LAYERS))
    reserve = {}
    for reg in (prod.MAP_LAYERS, scmp.RING_LAYERS, columns, scmp.SCMP_LAYERS):
        for n, (_, r) in reg.items():
            if reserve.setdefault(n, r is not None) != (r is not None):
                raise SystemExit(f"{n}: reserves in one group and not in another")
    names = sorted(set(prod.KNOBS) | {n for g in groups.values() for n in g})
    nodes = {n: dict(reserve=reserve.get(n, False), knobs=[knob(n, k, t) for k, t in prod.KNOBS.get(n, {}).items()]) for n in names}
    if set(READS) != set(prod.LEGACY):
        raise SystemExit(f"READS names {sorted(READS)}, prod.LEGACY {sorted(prod.LEGACY)}")
    take(nodes, json.load(open(PAGE_OUT, encoding="utf-8")))
    for n, eats in EATS.items():
        nodes[n]["eats"] = list(eats)
    core = json.load(open(BINDINGS_OF_CORE, encoding="utf-8"))
    core_external = {n for n, e in core["nodes"].items() if e.get("binding") == "external"}
    if not core_external <= set(nodes):
        raise SystemExit(f"the page tree core binds {sorted(core_external - set(nodes))} external, no registered node")
    out = recipes(nodes, groups)
    for name, layers in core.get("recipes", {}).items():
        r = next((r for r in out if r["name"] == name), None)
        if r is None or not layers or not set(layers) <= set(r["layers"]) or not set(layers) <= core_external:
            raise SystemExit(f"recipes.{name} {layers!r}: a recipe binds external some of its own layers whose node the core binds external")
        r["external"] = list(layers)
        # the external layers the core lays out in a view frame: the flow gives their declaration the map points and extent
        view = [l for l in layers if core["frames"].get(core["nodes"][l].get("frame"), {}).get("kind") == "view"]
        if view: r["points"] = view
    for r in out:
        none_left(r)
        notes = [dict(layer=l, at=f"/hero/leaves/{l}/{SHORT_NOTES[l]}") for l in r["layers"] if l in SHORT_NOTES]
        if notes: r["short_notes"] = notes
    return dict(nodes=nodes, groups=groups, legacy=READS, recipes=out)


def none_left(r):
    """Every layer of a recipe is either asked of the visual group (external) or prints only: none is left to a fill."""
    left = [l for l in r["layers"] if l not in r.get("external", []) and l not in PRINTS_ONLY]
    if left:
        raise SystemExit(f"recipes.{r['name']}: layers {left} are neither bound external (node-bindings.json recipes) nor PRINTS_ONLY")


def recipes(nodes, groups):
    """RECIPES as checked, each with the nodes its layers bring (WITH) after them: each layer one its group holds and its node
    states what it eats, every condition a layer's node needs among the recipe's own, each condition after what it reads (NEEDS),
    each exposed knob one its node has, and each same_measure pair two of its own layers, a strip slot declared exactly where
    its page places one (run.STRIP_SLOT), and a main layer declared exactly as its page's (run.MAIN), one of its own layers."""
    out = []
    for r in RECIPES:
        brought = [n for l in r["layers"] for n in WITH.get(l, [])]
        if set(brought) & set(r["layers"]):
            raise SystemExit(f"{r['name']}: names {sorted(set(brought) & set(r['layers']))}, which its layers bring (WITH)")
        r = dict(r, layers=[n for l in r["layers"] for n in [l, *WITH.get(l, [])]])
        for i, e in enumerate(r["eats"]):
            for need in NEEDS.get(e, []):
                if not set(need) & set(r["eats"][:i]):
                    raise SystemExit(f"{r['name']}: {e} reads what {' or '.join(need)} writes; name it before {e}")
        for n in r["layers"]:
            if n not in groups.get(r["name"], []):
                raise SystemExit(f"{r['name']}: the group holds no layer {n}")
            if n not in EATS:
                raise SystemExit(f"{r['name']}: node {n} states no shape it eats (EATS)")
            if set(EATS[n]) - set(r["eats"]):
                raise SystemExit(f"{r['name']}: node {n} eats {sorted(set(EATS[n]) - set(r['eats']))}, the recipe does not")
        w = r.get("without")
        if w is not None and (set(w) != {"condition", "members", "findings", "relations", "why"} or w["condition"] not in r["eats"]
                              or not isinstance(w["relations"], list) or not set(w["relations"]) <= set(RELATIONS) - {r.get("relation")}
                              or not all(isinstance(w[k], int) and not isinstance(w[k], bool) and w[k] >= 1 for k in ("members", "findings"))
                              or not isinstance(w["why"], str) or not w["why"].strip()):
            raise SystemExit(f"{r['name']}: without {w!r}; one of its eats as condition, members and findings whole numbers of 1 or more, and why")
        if r.get("relation") not in RELATIONS:
            raise SystemExit(f"{r['name']}: relation {r.get('relation')!r}; one of {RELATIONS}, the one its page answers")
        if r.get("blocks_only", False) not in (True, False) or (r.get("blocks_only") and "blocks" in r["eats"]):
            raise SystemExit(f"{r['name']}: blocks_only {r.get('blocks_only')!r}; true or false, and a page over the blocks is no block")
        if r.get("window", []) not in ([], ["t0", "t1"]):
            raise SystemExit(f"{r['name']}: window {r['window']!r}; the one window is ['t0', 't1']")
        if r.get("window") and "change_focus" not in r["picks"]:
            raise SystemExit(f"{r['name']}: its window runs between t0 and t1, which only change_focus picks")
        for e in r["exposes"]:
            node, _, k = e.partition(".")
            if not any(x["name"] == k for x in nodes.get(node, {}).get("knobs", [])):
                raise SystemExit(f"{r['name']}: exposes {e}, no such knob")
        for pair in r.get("same_measure", []):
            if len(pair) != 2 or pair[0] == pair[1] or not set(pair) <= set(r["layers"]):
                raise SystemExit(f"{r['name']}: same_measure {pair!r}; a pair is two of its own layers")
        if r.get("strip", False) not in (True, False) or r.get("strip", False) != (r["name"] in run.STRIP_SLOT):
            raise SystemExit(f"{r['name']}: strip {r.get('strip')!r}; its page {'places' if r['name'] in run.STRIP_SLOT else 'has no slot for'} the strip (run.STRIP_SLOT)")
        if r.get("opening", False) not in (True, False) or r.get("opening", False) != (r["name"] in run.OPENING_SLOT):
            raise SystemExit(f"{r['name']}: opening {r.get('opening')!r}; its page {'places' if r['name'] in run.OPENING_SLOT else 'has no slot for'} an opening picture (run.OPENING_SLOT)")
        if r.get("main") != run.MAIN.get(r["name"]) or ("main" in r and r["main"] not in r["layers"]):
            raise SystemExit(f"{r['name']}: main {r.get('main')!r}; its page's main layer is {run.MAIN.get(r['name'])!r} (run.MAIN), one of its layers")
        out.append(r)
    return out


def text():
    return json.dumps(table(), ensure_ascii=False, indent=1) + "\n"


if __name__ == "__main__":
    if sys.argv[1:2] == ["--pages"]:
        open(PAGE_OUT, "w", encoding="utf-8").write(json.dumps(page_values(sys.argv[2]), ensure_ascii=False, indent=1) + "\n")
    open(OUT, "w", encoding="utf-8").write(text())
