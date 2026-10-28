"""Writes knobs.json, the leaf registry layer 1 reads (src/next_leaf.rs, include_str!): every leaf node with its knobs as
prod.KNOBS (scmp's included) states them, whether it reserves room before the others draw, and each group's layers in
order. KNOBS stays the one source: scripts/test_leaves_knobs.py fails when the file is stale, and a knob whose kind is not
plain (three numbers, or a word among words) stops the writer instead of being guessed.
Run: python3 -I -B runtime/leaves_py/knobs.py"""
import json
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prod
import scmp

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "knobs.json")


def num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def knob(node, name, t):
    default, choices, what = t
    if num(default) and len(choices) == 3 and all(map(num, choices)):
        lo, hi, step = choices
        return dict(name=name, default=default, min=lo, max=hi, step=step, what=what)
    if isinstance(default, str) and choices and all(isinstance(c, str) for c in choices) and default in choices:
        return dict(name=name, default=default, options=list(choices), what=what)
    raise SystemExit(f"{node}.{name}: {t!r} is neither a range (three numbers) nor a word among words")


def table():
    groups = dict(map=list(prod.MAP_ORDER), ring=list(scmp.RING_LAYERS), charts=list(prod.CHARTS))
    reserve = {}
    for reg in (prod.MAP_LAYERS, scmp.RING_LAYERS):
        for n, (_, r) in reg.items():
            if reserve.setdefault(n, r is not None) != (r is not None):
                raise SystemExit(f"{n}: reserves in one group and not in another")
    names = sorted(set(prod.KNOBS) | {n for g in groups.values() for n in g})
    nodes = {n: dict(reserve=reserve.get(n, False), knobs=[knob(n, k, t) for k, t in prod.KNOBS.get(n, {}).items()]) for n in names}
    return dict(nodes=nodes, groups=groups, legacy=sorted(prod.LEGACY))


def text():
    return json.dumps(table(), ensure_ascii=False, indent=1) + "\n"


if __name__ == "__main__":
    open(OUT, "w", encoding="utf-8").write(text())
