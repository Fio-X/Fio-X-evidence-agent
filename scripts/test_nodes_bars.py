#!/usr/bin/env python3
"""The bars' external node (runtime/leaves_py/bars_node.py, P4a S3) prints what the column page's leaf printed: on the 14
column pages of the replay list (scripts/fixtures/p4a/column-bars.json, from their published bars layers) the node's reply to
the core's request, printed as cl_bars prints it ('{:.1f}'), equals every number of the page (the axis, each name, bar x
and width, value), the widths measured by the leaf's own rule (prod.tw) on the page's own strings and every number through
one JSON round trip, as it travels. It refuses with no value above 0, and answers only the texts it was issued.
Run: python3 -I -B scripts/test_nodes_bars.py      exit 0 when all hold."""
import json, os, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "runtime", "leaves_py"))
import bars_node  # noqa: E402
import prod  # noqa: E402

PAGE_W, SIZE, TOP, ROW, INSET = 1140, 13, 6, 24, 3
FAILS = []


def jrt(v):
    return json.loads(json.dumps(v))


def request(page):
    """The core's request for a page, as next_tree.rs issue and rows_frame write it (lw, bw by the leaf's arithmetic)."""
    lw = max(prod.tw(n, SIZE) for n in page["names"]) + 12
    vw = max(prod.tw(v, SIZE) for v in page["values_text"]) + 8
    bw = (PAGE_W - page["x0"]) - lw - vw
    marks = [{"id": f"bars/{i}", "shape": "rect", "item": i, "value": v} for i, v in enumerate(page["values"])]
    texts = [{"id": f"bars/{i}/{f}"} for i in range(len(marks)) for f in ("label", "value_text")]
    return jrt({"node": "bars", "rows": {"x0": page["x0"], "lw": lw, "bw": bw, "top": TOP, "row": ROW, "inset": INSET},
                "marks": marks, "texts": texts})


def main():
    pages = json.load(open(os.path.join(REPO, "scripts", "fixtures", "p4a", "column-bars.json"), encoding="utf-8"))["pages"]
    for page in pages:
        req = request(page)
        out = jrt(bars_node.reply(req))
        left = req["rows"]["x0"] + req["rows"]["lw"]
        printed = [f"{left:.1f}"]
        for m in req["marks"]:
            r, lab, val = out["marks"][m["id"]], out["texts"][m["id"] + "/label"], out["texts"][m["id"] + "/value_text"]
            printed += [f"{lab['x']:.1f}", f"{r['x']:.1f}", f"{r['w']:.1f}", f"{val['x']:.1f}"]
            if (r["h"], f"{r['y']:.1f}", lab["anchor"], val["anchor"]) != (18, f"{TOP + m['item'] * ROW + 3:.1f}", "end", "start"):
                FAILS.append(f"{page['sha']} {m['id']}: row geometry {r} {lab} {val}")
        if printed != page["printed"]:
            bad = [(i, a, b) for i, (a, b) in enumerate(zip(printed, page["printed"])) if a != b]
            FAILS.append(f"{page['sha']}: {len(bad)} numbers print otherwise, first {bad[:3]}")
    zero = request(pages[0])
    for m in zero["marks"]:
        m["value"] = 0
    if bars_node.reply(zero) != {"refused": "no_room"}:
        FAILS.append("no value above 0: not refused")
    few = request(pages[0])
    few["texts"] = few["texts"][:1]
    if list(bars_node.reply(few)["texts"]) != ["bars/0/label"]:
        FAILS.append("answers texts it was not issued")
    print(f"bars node: {len(pages)} column pages, {sum(len(p['values']) for p in pages)} bars; "
          + ("all print as the page" if not FAILS else f"{len(FAILS)} FAIL: {FAILS[:3]}"))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
