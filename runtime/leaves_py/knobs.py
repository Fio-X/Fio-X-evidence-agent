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
         picks=["change_focus"], exposes=[], window=["t0", "t1"]),
    dict(name="ring", layers=["map", "ring", "callouts", "legend", "inset"],
         eats=["annual", "years_2", "hub_origin", "one_unit", "others_single", "monthly_companion"], charts=[],
         picks=["change_focus"], exposes=["frame.gap_dir", "frame.title_in", "ring.months", "ring.color", "names.font"]),
    # a composition across places: one 100% bar per place of the main's sum-input fetch (its groups' input codes, the top
    # places by total, layer 1's cut), each bar's total printed beside it; before change and column, which would read the
    # main's totals alone, and only for a main the program fetched sum inputs for (composition_groups)
    dict(name="composition", layers=["stacked100"], eats=["annual", "one_unit", "composition_groups"], charts=[], picks=[],
         exposes=[], main="stacked100"),
    # two ends of a ten-year table: each place's change from t0 to t1 as signed bars (bars.measure change, set by layer 1),
    # the map its level at t1; a table of one year has no two ends and goes on to column
    dict(name="change", layers=["bubbles", "bars", "leader_notes"],
         eats=["annual", "years_2", "one_place", "one_unit", "last_year", "two_ends"],
         charts=["choropleth", "horizontal_bar", "dumbbell", "line"], picks=["changed", "claim_marks"], exposes=[], strip=True,
         main="bars"),
    dict(name="column", layers=["bars", "bubbles", "leader_notes"], eats=["annual", "one_place", "one_unit", "last_year"],
         charts=["choropleth", "horizontal_bar"], picks=["ranked", "claim_marks"], exposes=[],
         # TODO(item 5): goes once the map (bubbles) shows other values than the bars (src/next_leaf.rs leaves)
         same_measure=[["bars", "bubbles"]], strip=True, main="bars"),
    # a flow between two dimensions of one table (the registry's official pair, one unit) as a sankey across the column
    # page, under the page's header and over its source line; no notes yet (the column page's notes point at a map)
    dict(name="flow", layers=["sankey"], eats=["official_flow", "one_unit"], charts=[], picks=[], exposes=[], main="sankey"),
]
# The shape conditions each node of a recipe needs its tables to meet; a recipe's conditions hold every one its layers'
# nodes need.
EATS = dict(map=["hub_origin", "one_unit"], ring=["monthly_companion"], callouts=[], legend=[], inset=[],
            bars=["annual", "one_place", "one_unit", "last_year"], bignums=["one_unit"], notes=["hub_origin", "one_unit"],
            strip=["monthly_companion"], section_head=[], rankbar=["annual", "one_place", "one_unit", "last_year"],
            bubbles=["annual", "one_place", "one_unit", "last_year"], bubble_key=["annual", "one_place", "one_unit", "last_year"],
            leader_notes=["one_unit"], sankey=["official_flow", "one_unit"], stacked100=["annual", "one_unit", "composition_groups"])
# The nodes a node brings with it: every recipe that draws the node draws these right after it, in this order (a key to its
# marks), so no recipe can draw the marks without them; a recipe that names one itself refuses.
WITH = dict(bubbles=["bubble_key"])
# What a shape condition reads that an earlier one writes (src/next_run.rs): each list is one need, met by any condition in
# it standing before. A recipe that names the condition names one of each need first, or the condition can only refuse.
NEEDS = dict(monthly_companion=[["hub_origin"], ["one_unit"]], others_single=[["hub_origin", "one_place"]],
             last_year=[["one_place"]], two_ends=[["last_year"]])


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
    return dict(nodes=nodes, groups=groups, legacy=READS, recipes=recipes(nodes, groups))


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
