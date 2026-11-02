#!/usr/bin/env python3
"""Every stop condition of the map circles and the bars on a column and a change page (P4a-2 M8, design 11.2) ends the page
where and in the words it did before the two layers were external: scripts/fixtures/p4a2/stops.json holds each case's leaf
input after its condition is set (rows, ledger, names, hero), its end measured on the leaf before P4a-2 (want: stage, words),
the external layers the generator asks for it (asked; src/next_tree_gen.rs leaf_stops holds the same, its Rust test reads this
file) and the placed geometry the core hands an asked layer (placed). Here the repo's leaf draws it as the leaf child does
(the panel first, "size: " on its refusal; then layer by layer in the recipe's order, "<layer>: " on the first refusal), every
layer bound external drawn by run.layer_fn from placed geometry or, with none, refused after its own input half. Also: a
leaf handed placed.floor stops in the leaf's own overlap words, and a circles layer with no placed geometry and a sound input
refuses for the missing geometry.
Run: python3 -I -B scripts/test_leaf_stops_p4a2.py      exit 0 when all hold."""
import json, os, sys
from types import SimpleNamespace as NS

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "runtime", "leaves_py"))
import column  # noqa: E402
import facts as FX  # noqa: E402
import geo  # noqa: E402
import prod  # noqa: E402
import run  # noqa: E402
import wbkit  # noqa: E402

ORDER = {"column": ["bars", "bubbles"], "change": ["bubbles", "bars"]}
SHAPES = os.path.join(REPO, "runtime", "pi", "assets", "naturalearth-admin0-50m.geojson")


def setup(c):
    rows = list(c["rows"]) + [{"src": k, "text": v} for k, v in c["ledger"].items()]
    FX.TABLES = run.tables(rows); FX.LEDGER = {r["src"]: r["text"] for r in rows if "text" in r} or None
    prod.NAMES = dict(c["names"]); geo.NE = SHAPES; FX.SEGS = None
    wbkit.read_values()


def page_end(c, placed=None):
    """(stage, why) of the leaf page, as next_leaf's drawn() and run.py word it; ("published", None) when both layers draw."""
    rec = c["recipe"]
    stop = lambda stage, why: (stage, f"the {rec} leaf page stopped at {stage}: {why}")
    setup(c)
    h = json.loads(json.dumps(c["hero"]))
    try:
        f = column.ColumnFrame(NS(T=FX.TABLES, spec={"tables": {c["table"]: {}}}), h, run.map_view(h))
    except FX.Refused as e:
        return stop("draw", f"size: {e}")
    occ = prod.Occ()
    knobs = {"external": ORDER[rec], "placed": c["placed"] if placed is None else placed}
    for name in ORDER[rec]:
        run.DROPPED.clear(); run.SCALE.clear()
        try:
            run.layer_fn(run.KINDS[rec][0], name, knobs)(f, occ)
        except FX.Refused as e:
            return stop("draw", f"{name}: {e}")
    return ("published", None)


def main():
    fx = json.load(open(os.path.join(REPO, "scripts", "fixtures", "p4a2", "stops.json"), encoding="utf-8"))["cases"]
    fails, n = [], 0
    for c in fx:
        n += 1
        want = tuple(c["want"])
        if want[0] != "draw":  # a stop before the leaf (the flow's or the core's): nothing of the leaf's to run
            continue
        got = page_end(c)
        if got != want:
            fails.append(f"{c['id']} {c['recipe']}: {got} != {want}")
    # a floor reply stops in the leaf's own overlap words; with no placed geometry a sound input refuses for the missing one
    b6 = next(c for c in fx if c["id"] == "B6" and c["recipe"] == "column")
    if "floor" not in b6["placed"].get("bubbles", {}):
        fails.append("B6 column: the core's placed geometry holds no floor")
    sound = next(c for c in fx if c["id"] == "B1" and c["recipe"] == "column")
    sound = {**sound, "hero": json.loads(json.dumps(sound["hero"]))}
    for i in sound["hero"]["leaves"]["bubbles"]["items"]:
        if i["value"] == "series:nope":
            i["value"] = next(r["src"] for r in sound["rows"] if r.get("dims", {}).get(sound["place"]) == i["code"]
                              and str(r.get("time")) == str(sound["hero"]["data"]["year"]))
    got = page_end(sound, {k: v for k, v in sound["placed"].items() if k != "bubbles"})
    if not (got[0] == "draw" and got[1].endswith("bubbles: the recipe binds bubbles external and the request gives no placed geometry for it")):
        fails.append(f"a sound input with no placed circles: {got}")
    print(f"leaf stops (P4a-2): {n} stop fixtures, {sum(c['want'][0] == 'draw' for c in fx)} at the leaf; "
          + ("all as before" if not fails else f"{len(fails)} FAIL: {fails[:4]}"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
