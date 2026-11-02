"""The bars' external node (P4a, signed since P4a-2): one bar per item down a rows frame, by the column page's own arithmetic
(column.py cl_change_bars, operation for operation: a zero line z between the room the value texts need on each side a bar
runs to, each bar's length its value's size over the span from the lowest (or 0) to the highest (or 0), right of z for a
value of 0 or more, left of it below 0; its row at top + i * row, the bar inset from the row's top and bottom; the name 8 px
before the bars' column, right-aligned; the value 6 px past the bar's end on its side). On values of 0 or more this is the
level bars' arithmetic bit for bit (cl_bars as it was), so the leaf that prints the numbers it sends back prints what it
printed before.

In, one line: the core's request (src/next_tree.rs issue): {"node", "frame": {"w", "h"}, "plot", "rows": {"x0", "lw", "vw",
"bw" (the whole width after x0), "top", "row", "inset"}, "encode", "marks": [{"id", "shape", "item", "value"}], "texts":
[{"id", "w", "h", "size", ...}]}.
Out, one line: {"marks": {id: {"shape": "rect", "x", "y", "w", "h"}}, "texts": {id: {"x", "y", "anchor"}}}, or
{"refused": "no_room"} when every value is 0 (no span to scale by). It reads nothing else and writes nothing else; the core
checks every number it sends (B0-B7, K2, K11)."""
import json

NAME_GAP, VALUE_GAP = 8, 6  # the name's right edge before the bars' column, the value's start past its bar's end


def reply(req):
    r = req["rows"]
    x0, lw, vw, whole, top, row, inset = r["x0"], r["lw"], r["vw"], r["bw"], r["top"], r["row"], r["inset"]
    marks = req["marks"]
    if not marks:
        return {"refused": "no_room"}
    lo, hi = min(0.0, min(m["value"] for m in marks)), max(0.0, max(m["value"] for m in marks))
    if not hi - lo > 0:
        return {"refused": "no_room"}
    neg, pos = (vw if lo < 0 else 0), (vw if hi > 0 else 0)
    left, names = x0 + lw + neg, x0 + lw  # as cl_change_bars: left, lw = f.x0 + f.lw + neg, f.x0 + f.lw
    bw = whole - lw - neg - pos
    z = left + -lo / (hi - lo) * bw
    out, texts = {}, {}
    for m in marks:
        i, v = m["item"], m["value"]
        y, w = top + i * row, abs(v) / (hi - lo) * bw
        mid, x = y + row / 2, z if v >= 0 else z - w
        tx, anchor = (z + w + VALUE_GAP, "start") if v >= 0 else (z - w - VALUE_GAP, "end")
        out[m["id"]] = {"shape": "rect", "x": x, "y": y + inset, "w": w, "h": row - 2 * inset}
        texts[f"{m['id']}/label"] = {"x": names - NAME_GAP, "y": mid, "anchor": "end"}
        texts[f"{m['id']}/value_text"] = {"x": tx, "y": mid, "anchor": anchor}
    issued = {t["id"] for t in req["texts"]}
    return {"marks": out, "texts": {k: v for k, v in texts.items() if k in issued}}


def main():
    line = input()  # the one request line on stdin (no module of the host is imported)
    print(json.dumps(reply(json.loads(line))), flush=True)


if __name__ == "__main__":
    main()
