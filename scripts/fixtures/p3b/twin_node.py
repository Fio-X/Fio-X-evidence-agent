"""A test-only twin of an external bars node (plan B): it reads one request line from the visual group's core (ids, values,
box sizes, the declared channels and scales over the core's plot box) and answers one line of geometry only, the way a JS
node would lay out bars. It sees no word and no reference. No registry lists it; the cargo test external_binding_twin lays it
over the bindings. An optional argument breaks the reply the way a fixture of scripts/fixtures/p3b does:
  g16   every bar drawn with one scale, 0.8 of the declared one
  g17a  the second and third bars' lengths swapped
  g18   the second and third bars' name labels swapped
"""
import json
import sys


def bars(req):
    x0, y0, x1, y1 = req["plot"]
    ms = req["marks"]
    items = []
    for m in ms:
        if m["item"] not in items:
            items.append(m["item"])
    marks = {m["id"]: {"shape": m["shape"]} for m in ms}
    for ch in req["encode"]:
        if ch["channel"] == "length_up":
            top = max(m["value"] for m in ms)
            for m in ms:
                h = (y1 - y0) * m["value"] / top
                marks[m["id"]].update(h=round(h, 3), y=round(y1 - h, 3))
        elif ch["channel"] == "band_x":
            step, pad = (x1 - x0) / len(items), ch["scale"]["padding"]
            for m in ms:
                k = items.index(m["item"])
                marks[m["id"]].update({ch["fields"][0]: round(x0 + k * step + step * pad / 2, 3), ch["fields"][1]: round(step * (1 - pad), 3)})
        else:
            raise SystemExit("twin: channel %s is not drawn here" % ch["channel"])
    texts = {}
    for i, m in marks.items():
        cx = round(m["x"] + m["w"] / 2, 3)
        texts[i + "/label"] = {"x": cx, "y": y1 + 14, "anchor": "middle"}
        texts[i + "/value_text"] = {"x": cx, "y": round(m["y"] - 4, 3), "anchor": "middle"}
    return {"marks": marks, "texts": texts}


def broken(reply, mode, base):
    m, t = reply["marks"], reply["texts"]
    if mode == "g16":
        for g in m.values():
            g["h"] = round(g["h"] * 0.8, 3)
            g["y"] = round(base - g["h"], 3)
    elif mode == "g17a":
        a, b = m["bars/1"], m["bars/2"]
        a["h"], b["h"], a["y"], b["y"] = b["h"], a["h"], b["y"], a["y"]
    elif mode == "g18":
        t["bars/1/label"], t["bars/2/label"] = t["bars/2/label"], t["bars/1/label"]
    elif mode:
        raise SystemExit("twin: no mode %s" % mode)
    return reply


def main():
    req = json.loads(sys.stdin.readline())
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    reply = broken(bars(req), mode, req["plot"][3])
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()


main()
