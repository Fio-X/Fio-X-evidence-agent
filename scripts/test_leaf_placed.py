#!/usr/bin/env python3
"""Who draws a layer (runtime/leaves_py/run.py layer_fn, P4a S5): a layer the page recipe binds external (knobs.external) is
drawn only from the geometry the core placed (knobs.placed), and a layer that is not bound external is the recipe's own leaf.
  1 a column page's bars bound external with no placed geometry refuse; nothing falls back to the leaf's own layout;
  2 with placed geometry they are drawn from it, even with bars.measure change in the style: the change layout and the
    level layout are stubs that raise, and neither is called;
  3 a change page's bars (not bound external) that come with placed geometry refuse;
  5 the bubbles of a column page and of a change page are drawn by today's leaf, unchanged;
  6 on the 14 column pages of the replay list (scripts/fixtures/p4a/column-bars.json), the bars layer cl_bars_placed draws
    from the bars node's reply (runtime/leaves_py/bars_node.py, through one JSON round trip as it travels) is byte for byte
    the layer cl_bars drew from the same input before the level layout left it (frozen: column-bars-svg.json).
Run: python3 -I -B scripts/test_leaf_placed.py      exit 0 when all hold."""
import json, os, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "runtime", "leaves_py"))
import bars_node  # noqa: E402
import column  # noqa: E402
import facts as FX  # noqa: E402
import prod  # noqa: E402
import run  # noqa: E402

FAILS = []
PAGE_W, SIZE, TOP, ROW = 1140, 13, 6, 24


def jrt(v):
    return json.loads(json.dumps(v))


class Frame:
    """The column frame's fields cl_bars reads, for one page of the fixture (its codes made up, its names and values its own)."""
    def __init__(f, page):
        codes = [f"C{i:02d}" for i in range(len(page["names"]))]
        prod.NAMES = dict(zip(codes, page["names"]))
        f.d = {"family": "val"}
        FX.LEDGER = {**{column.val_src(f.d, k): t for k, t in zip(codes, page["values_text"])},
                     **{prod.name_src(k): n for k, n in zip(codes, page["names"])}}
        f.change, f.vals, f.size, f.rh, f.top, f.x0 = False, list(zip(codes, page["values"])), SIZE, ROW, TOP, page["x0"]
        f.marks, f.focus, f.noted = {codes[1]}, {codes[0]}, {codes[-1]}
        f.bw = PAGE_W - f.x0
        f.lw = max(prod.tw(n, SIZE) for n in page["names"]) + 12
        f.vw = max(prod.tw(v, SIZE) for v in page["values_text"]) + 8


def placed_of(f):
    """What the core writes into knobs.placed.bars from the node's reply: per item its code, its bar and its texts in the
    core's order (the name, the value with its ledger src)."""
    req = jrt({"node": "bars", "rows": {"x0": f.x0, "lw": f.lw, "bw": f.bw - f.lw - f.vw, "top": TOP, "row": ROW, "inset": 3},
               "marks": [{"id": f"bars/{i}", "shape": "rect", "item": i, "value": v} for i, (_, v) in enumerate(f.vals)],
               "texts": [{"id": f"bars/{i}/{n}"} for i in range(len(f.vals)) for n in ("label", "value_text")]})
    out = jrt(bars_node.reply(req))
    items = []
    for i, (k, _) in enumerate(f.vals):
        mark = {a: b for a, b in out["marks"][f"bars/{i}"].items() if a != "shape"}
        texts = [{**out["texts"][f"bars/{i}/label"], "name": "label", "src": k},
                 {**out["texts"][f"bars/{i}/value_text"], "name": "value_text", "src": column.val_src(f.d, k)}]
        items.append({"code": k, "mark": mark, "texts": texts})
    return jrt({"items": items})


def refuses(fn, words, what):
    try:
        fn()
    except FX.Refused as e:
        if words not in str(e): FAILS.append(f"{what}: refused for another reason: {e}")
        return
    FAILS.append(f"{what}: not refused")


def main():
    pages = json.load(open(os.path.join(REPO, "scripts", "fixtures", "p4a", "column-bars.json"), encoding="utf-8"))["pages"]
    col_layers, chg_layers = run.KINDS["column"][0], run.KINDS["change"][0]
    f = Frame(pages[0])
    g = placed_of(f)
    # 1
    refuses(lambda: run.layer_fn(col_layers, "bars", {"external": ["bars"]}), "no placed geometry", "1 bars external, no placed")
    # 2: the old layouts raise if called; the placed one draws
    def stub(*_a, **_k): raise AssertionError("an old bars layout was called")
    saved = (column.cl_change_bars, column.COLUMN_LAYERS["bars"], col_layers["bars"])
    column.cl_change_bars, column.COLUMN_LAYERS["bars"], col_layers["bars"] = stub, (stub, None), (stub, None)
    try:
        f.change = True  # bars.measure change in the style
        svg = run.layer_fn(col_layers, "bars", {"external": ["bars"], "placed": {"bars": g}})(f, prod.Occ())
        if svg.count("<rect ") != len(f.vals): FAILS.append(f"2 placed bars: {svg.count('<rect ')} bars drawn, {len(f.vals)} placed")
    except AssertionError as e: FAILS.append(f"2 placed bars with measure change: {e}")
    finally:
        column.cl_change_bars, column.COLUMN_LAYERS["bars"], col_layers["bars"] = saved
        f.change = False
    # 3
    refuses(lambda: run.layer_fn(chg_layers, "bars", {"external": [], "placed": {"bars": g}}), "does not bind external", "3 change bars with placed")
    # 5
    for layers, rec in ((col_layers, "column"), (chg_layers, "change")):
        if run.layer_fn(layers, "bubbles", {"external": ["bars"] if rec == "column" else []}) is not run.LEAF_LAYERS["bubbles"][0]:
            FAILS.append(f"5 the {rec} page's bubbles are not today's leaf")
    # 6: against the layer today's cl_bars drew, frozen (column-bars-svg.json; P4A_FREEZE=1 writes it from the live cl_bars,
    # which is equal to it while the level layout is there)
    frozen_path = os.path.join(REPO, "scripts", "fixtures", "p4a", "column-bars-svg.json")
    if os.environ.get("P4A_FREEZE") == "1":
        svgs = {p["sha"]: column.cl_bars(Frame(p), prod.Occ()) for p in pages}
        with open(frozen_path, "w", encoding="utf-8") as out:
            json.dump(svgs, out, ensure_ascii=False, indent=1)
            out.write("\n")
    frozen = json.load(open(frozen_path, encoding="utf-8"))
    same = 0
    for page in pages:
        f = Frame(page)
        today = frozen[page["sha"]]
        placed = run.layer_fn(col_layers, "bars", {"external": ["bars"], "placed": {"bars": placed_of(f)}})(f, prod.Occ())
        if placed == today: same += 1
        else:
            at = next((i for i, (a, b) in enumerate(zip(placed, today)) if a != b), min(len(placed), len(today)))
            FAILS.append(f"6 {page['sha']}: the placed bars differ from cl_bars at {at}: {placed[at - 40:at + 40]!r} vs {today[at - 40:at + 40]!r}")
    print(f"leaf placed: cases 1, 2, 3, 5 and 14 column pages ({same} byte for byte); "
          + ("all hold" if not FAILS else f"{len(FAILS)} FAIL: {FAILS[:3]}"))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
