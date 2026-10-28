"""Writes knobs.json, the leaf registry layer 1 reads (src/next_leaf.rs, include_str!): every leaf node with its knobs as
prod.KNOBS (scmp's included) states them, whether it reserves room before the others draw, each group's layers in order,
and where each legacy node reads its older keys. A word knob also takes the words the prototype's own pages set
(page_knobs.json, each with its page and key); a page number off its range or step stops the writer instead of widening it.
KNOBS and the pages stay the sources: scripts/test_leaves_knobs.py fails when the file is stale, and a knob whose kind is
not plain (three numbers, or a word among words) stops the writer instead of being guessed.
Run: python3 -I -B runtime/leaves_py/knobs.py [--pages <the prototype's page folder>]"""
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prod
import scmp

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "knobs.json")
PAGE_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "page_knobs.json")
# The prototype's pages with a hero, whose knob values the registry takes.
PAGES = ("page-gas-ring.json", "page-gas-scmp.json", "page-gas-scmp2.json")
# Where in the hero each legacy node reads its older keys (prod.knob's cfg): frame gets the hero (scmp.py, run.py),
# base the map's cfg, which is {**hero.data, style} (scmp.py MapFrame, prod.ml_base and the inset's sea).
READS = {"frame": [], "base": ["data"]}


def num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def knob(node, name, t):
    default, choices, what = t
    if num(default) and len(choices) == 3 and all(map(num, choices)):
        lo, hi, step = choices
        if not (lo <= default <= hi and step > 0):
            raise SystemExit(f"{node}.{name}: {t!r} is no range (it needs min <= default <= max and a step above 0)")
        return dict(name=name, default=default, min=lo, max=hi, step=step, what=what)
    if isinstance(default, str) and choices and all(isinstance(c, str) for c in choices) and default in choices:
        return dict(name=name, default=default, options=list(choices), what=what)
    raise SystemExit(f"{node}.{name}: {t!r} is neither a range (three numbers) nor a word among words")


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
    groups = dict(map=list(prod.MAP_ORDER), ring=list(scmp.RING_LAYERS), charts=list(prod.CHARTS))
    reserve = {}
    for reg in (prod.MAP_LAYERS, scmp.RING_LAYERS):
        for n, (_, r) in reg.items():
            if reserve.setdefault(n, r is not None) != (r is not None):
                raise SystemExit(f"{n}: reserves in one group and not in another")
    names = sorted(set(prod.KNOBS) | {n for g in groups.values() for n in g})
    nodes = {n: dict(reserve=reserve.get(n, False), knobs=[knob(n, k, t) for k, t in prod.KNOBS.get(n, {}).items()]) for n in names}
    if set(READS) != set(prod.LEGACY):
        raise SystemExit(f"READS names {sorted(READS)}, prod.LEGACY {sorted(prod.LEGACY)}")
    take(nodes, json.load(open(PAGE_OUT, encoding="utf-8")))
    return dict(nodes=nodes, groups=groups, legacy=READS)


def text():
    return json.dumps(table(), ensure_ascii=False, indent=1) + "\n"


if __name__ == "__main__":
    if sys.argv[1:2] == ["--pages"]:
        open(PAGE_OUT, "w", encoding="utf-8").write(json.dumps(page_values(sys.argv[2]), ensure_ascii=False, indent=1) + "\n")
    open(OUT, "w", encoding="utf-8").write(text())
