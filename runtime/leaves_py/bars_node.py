"""The bars' external node (P4a): one bar per item down a rows frame, by the column page's own arithmetic (column.py cl_bars
as it was: each bar from the plot's left edge, its width the value over the largest times the plot's width, divided then
multiplied; its row at top + i * row, the bar inset 3 px from the row's top; the name 8 px left of the bars, right-aligned;
the value 6 px after the bar's end), so the leaf that prints the numbers it sends back prints what it printed before.

In, one line: the core's request (src/next_tree.rs issue): {"node", "frame": {"w", "h"}, "plot", "rows": {"x0", "lw", "bw",
"top", "row", "inset"}, "encode", "marks": [{"id", "shape", "item", "value"}], "texts": [{"id", "w", "h", "size", "near"}]}.
Out, one line: {"marks": {id: {"shape": "rect", "x", "y", "w", "h"}}, "texts": {id: {"x", "y", "anchor"}}}, or
{"refused": "no_room"} when there is no value above 0 to scale by. It reads nothing else and writes nothing else; the core
checks every number it sends (B0-B7)."""
import json

NAME_GAP, VALUE_GAP = 8, 6  # the name's right edge before the bars, the value's start after its bar's end (cl_bars)


def reply(req):
    r = req["rows"]
    x0, lw, bw, top, row, inset = r["x0"], r["lw"], r["bw"], r["top"], r["row"], r["inset"]
    left = x0 + lw  # as cl_bars: lw = f.x0 + f.lw
    marks = req["marks"]
    mx = max((m["value"] for m in marks), default=0)
    if not mx > 0:
        return {"refused": "no_room"}
    out, texts = {}, {}
    for m in marks:
        i = m["item"]
        y, w = top + i * row, m["value"] / mx * bw
        mid = y + row / 2
        out[m["id"]] = {"shape": "rect", "x": left, "y": y + inset, "w": w, "h": row - 2 * inset}
        texts[f"{m['id']}/label"] = {"x": left - NAME_GAP, "y": mid, "anchor": "end"}
        texts[f"{m['id']}/value_text"] = {"x": left + w + VALUE_GAP, "y": mid, "anchor": "start"}
    issued = {t["id"] for t in req["texts"]}
    return {"marks": out, "texts": {k: v for k, v in texts.items() if k in issued}}


def main():
    line = input()  # the one request line on stdin (no module of the host is imported)
    print(json.dumps(reply(json.loads(line))), flush=True)


if __name__ == "__main__":
    main()
