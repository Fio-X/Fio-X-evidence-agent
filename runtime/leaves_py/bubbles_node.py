"""The map circles' external node (P4a-2): the bubbles' layout moved out of bubbles.py
(Frame's radius loop, nudge, cl_bubbles's label search) into a node that reads one request line and answers one line,
operation for operation as the leaf does it today, so the leaf that draws the reply prints what it printed before.

In (the core's request; every number the core's or the leaf ground's, nothing read from a file):
  {"node": "bubbles", "frame": {"w", "h", "top", "inset"},
   "marks": [{"id": "<code>", "item": i, "value": v, "pin": [x, y]}]      in the core's order (largest value first,
                                                                           ties in ranked order), pin = K3 view point
   "scale": {"r_max", "r_min", "step", "floor", "max_overlaps"}, "nudge": {"most", "gap"},
   "texts": [{"id": "<code>", "w_name", "w_value"}]                        the label subset (K7), in its order
   "labels": {"size", "gap", "sep", "reach", "land_cost"},
   "ground": {"land": {band: [[x0, x1], ...]}}}                           the leaf's own land rows (given, unchecked)
Out: {"marks": {"<code>": circle, "<code>/dot": circle, "<code>/leader": line}, "texts": {"<code>": {x, y, anchor}},
      "dropped": ["<code>", ...]}  (texts in the order placed); when even the floor overlaps, the circles at the floor and
      every label dropped (the core's K6 checks the pairs and the leaf stops the page in its own words). It never refuses.
The ground's band keys come as JSON strings; they are read back as the leaf's whole band numbers. It reads nothing else
and writes nothing else; the core checks every number it sends (B0, B1, K4-K9).
"""
import json
import math

DOT_R = 1.6
BELOW_GAP = 0.3
LAND_STEP = 6


def lens(a, b):
    d = math.hypot(a["_xy"][0] - b["_xy"][0], a["_xy"][1] - b["_xy"][1]); r1, r2 = a["_r"], b["_r"]
    if d >= r1 + r2: return 0.0
    if d <= abs(r1 - r2): return math.pi * min(r1, r2) ** 2
    p = r1 * r1 * math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1)) + r2 * r2 * math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2))
    return p - 0.5 * math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2))


def nudge(items, most, gap):
    if most <= 0: return
    for _ in range(40):
        moved = False
        for a in range(len(items)):
            for b in range(a + 1, len(items)):
                p, q = items[a], items[b]; dx, dy = q["_xy"][0] - p["_xy"][0], q["_xy"][1] - p["_xy"][1]; d = math.hypot(dx, dy)
                short = p["_r"] + q["_r"] + gap - d
                if short <= 0.05: continue
                ux, uy = (dx / d, dy / d) if d > 1e-9 else (1.0, 0.0)
                for i, sgn in ((p, -1), (q, 1)):
                    x, y = i["_xy"][0] + sgn * ux * short / 2, i["_xy"][1] + sgn * uy * short / 2
                    off = math.hypot(x - i["_at"][0], y - i["_at"][1])
                    if off > most: x, y = i["_at"][0] + (x - i["_at"][0]) * most / off, i["_at"][1] + (y - i["_at"][1]) * most / off
                    if math.hypot(x - i["_xy"][0], y - i["_xy"][1]) > 0.01: moved = True
                    i["_xy"] = (x, y)
        if not moved: break


def on_land(rows, b, pad=2):
    if not rows: return False
    for r in range(math.floor((b[1] - pad) / LAND_STEP), math.floor((b[3] + pad) / LAND_STEP) + 1):
        if any(x0 < b[2] + pad and x1 > b[0] - pad for x0, x1 in rows.get(r, ())): return True
    return False


def crosses(a, b, c, d):
    def side(p, q, r): return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    def on(p, q, r): return min(p[0], q[0]) - 1e-9 <= r[0] <= max(p[0], q[0]) + 1e-9 and min(p[1], q[1]) - 1e-9 <= r[1] <= max(p[1], q[1]) + 1e-9
    d1, d2, d3, d4 = side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 and d2 and d3 and d4: return True
    return any(abs(v) < 1e-9 and on(p, q, r) for v, p, q, r in ((d1, c, d, a), (d2, c, d, b), (d3, a, b, c), (d4, a, b, d)))


def reply(req):
    fr, sc, nu, lb = req["frame"], req["scale"], req["nudge"], req["labels"]
    W, H, top, e = fr["w"], fr["h"], fr["top"], fr["inset"]
    items = [{"code": m["id"], "_v": m["value"], "pin": tuple(m["pin"])} for m in req["marks"]]
    mx = max(i["_v"] for i in items) or 1.0; r_max = sc["r_max"]
    while True:  # bubbles.Frame: at r_max, a step smaller each round down to the floor
        for i in items: i["_r"] = max(sc["r_min"], r_max * math.sqrt(i["_v"] / mx)); i["_at"] = i["_xy"] = i["pin"]
        nudge(items, nu["most"], nu["gap"])
        over = [1 for a in range(len(items)) for b in range(a + 1, len(items))
                if lens(items[a], items[b]) > 0.5 * math.pi * min(items[a]["_r"], items[b]["_r"]) ** 2]
        if len(over) <= sc["max_overlaps"]: break
        if r_max - sc["step"] < sc["floor"]:  # even at the floor: the circles as they stand, no label (the core stops in the leaf's words)
            marks = {i["code"]: {"shape": "circle", "cx": i["_xy"][0], "cy": i["_xy"][1], "r": i["_r"]} for i in items}
            for i in items:
                if math.dist(i["_xy"], i["_at"]) > 0.5: marks[i["code"] + "/dot"] = {"shape": "circle", "cx": i["_at"][0], "cy": i["_at"][1], "r": DOT_R}
            return {"marks": marks, "texts": {}, "dropped": [t["id"] for t in req["texts"]]}
        r_max -= sc["step"]
    marks, texts, dropped = {}, {}, []
    for i in items: marks[i["code"]] = {"shape": "circle", "cx": i["_xy"][0], "cy": i["_xy"][1], "r": i["_r"]}
    dots = []
    for i in items:
        if math.dist(i["_xy"], i["_at"]) > 0.5:
            x, y = i["_at"]; dots.append((x, y, DOT_R)); marks[i["code"] + "/dot"] = {"shape": "circle", "cx": x, "cy": y, "r": DOT_R}
    sz, gap, sep, reach = lb["size"], lb["gap"], lb["sep"], lb["reach"]
    boxes, leads, segs = [], [], []  # boxes: the label texts' boxes as wbkit.Boxes holds them ((x0, y0, x1, y1), tag)
    if e:
        corners = [(e, e), (W - e, e), (W - e, H - e), (e, H - e), (e, e)]
        leads.extend((a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n) for a, b in zip(corners, corners[1:]) for n in [max(1, math.ceil(math.dist(a, b) / 4))] for t in range(n + 1))
    width = {t["id"]: (t["w_name"], t["w_value"]) for t in req["texts"]}
    by = {i["code"]: i for i in items}

    def free(bx):
        if bx[0] < 2 or bx[2] > W - 2 or bx[1] < top - 4 or bx[3] > H - 2: return False
        if any(bx[0] < b[0][2] + sep and b[0][0] < bx[2] + sep and bx[1] < b[0][3] + sep / 2 and b[0][1] < bx[3] + sep / 2 for b in boxes): return False
        if any(bx[0] - 1 < px < bx[2] + 1 and bx[1] - 1 < py < bx[3] + 1 for px, py in leads): return False
        rings = [(*j["_xy"], j["_r"]) for j in items] + dots
        return not any(math.hypot(max(bx[0] - x, 0, x - bx[2]), max(bx[1] - y, 0, y - bx[3])) < r + gap for x, y, r in rings)

    mid = (W / 2, (top + H) / 2)

    def inward(i, c, s_):
        dx, dy = (mid[0] - i["_xy"][0]) / (W / 2), (mid[1] - i["_xy"][1]) / max((H - top) / 2, 1)
        return c * dx + s_ * dy

    def beside(i):
        x, y = i["_xy"]; r = i["_r"]; g = gap + 1
        return [("start", x + r + g, y - sz * 0.2), ("end", x - r - g, y - sz * 0.2), ("middle", x, y - r - g - sz * 1.65), ("middle", x, y + r + g + sz * 0.8)]

    def out(i):
        x, y = i["_xy"]; r = i["_r"]
        for d in range(16, int(reach) + 1, 8):
            for n in range(16):
                c, s_ = math.cos(math.pi * n / 8), math.sin(math.pi * n / 8); px, py = x + (r + d) * c, y + (r + d) * s_
                anchor = "start" if c > 0.3 else "end" if c < -0.3 else "middle"
                tp = py + sz * BELOW_GAP if s_ > 0.3 else py - sz * 2.45 if s_ < -0.3 else py - sz * 1.2
                yield anchor, px, tp + sz * 0.8, ((x + r * c, y + r * s_), (px, py))

    def unit(lead):
        (ax, ay), (bx_, by_) = lead; n = math.hypot(bx_ - ax, by_ - ay) or 1.0
        return (bx_ - ax) / n, (by_ - ay) / n

    def clear_lead(i, a, b):
        n = max(2, math.ceil(math.dist(a, b) / 2)); pts = [(a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n) for t in range(n + 1)]
        if any(math.dist(p, j["_xy"]) < j["_r"] + 1 for p in pts for j in items if j is not i): return None
        if any(math.dist(p, d[:2]) < d[2] + 1 for p in pts for d in dots if math.dist(d[:2], i["_at"]) > 0.5): return None
        if any(crosses(a, b, *s) for s in segs): return None
        if any(bb[0][0] - 1 < p[0] < bb[0][2] + 1 and bb[0][1] - 1 < p[1] < bb[0][3] + 1 for p in pts for bb in boxes): return None
        return pts

    def box(i, anchor, tx, ty):
        wmax = max(*width[i["code"]])
        x0 = tx if anchor == "start" else tx - wmax if anchor == "end" else tx - wmax / 2
        return (x0, ty - sz * 0.8, x0 + wmax, ty + sz * 1.65)

    def label(i, anchor, tx, ty, lead=None, pts=()):
        if lead:
            leads.extend(pts); segs.append(lead)
            marks[i["code"] + "/leader"] = {"shape": "line", "x1": lead[0][0], "y1": lead[0][1], "x2": lead[1][0], "y2": lead[1][1]}
        wn, wv = width[i["code"]]
        for w, y in ((wn, ty), (wv, ty + sz * 1.4)):  # wbkit.txt's box of each line, as Boxes keeps it
            x0 = tx if anchor == "start" else tx - w if anchor == "end" else tx - w / 2
            boxes.append(((x0, y - sz * 0.8, x0 + w, y + sz * 0.25), i["code"]))
        texts[i["code"]] = {"x": tx, "y": ty, "anchor": anchor}

    wanted = [by[t["id"]] for t in req["texts"]]; out_ = []
    for i in wanted:
        for anchor, tx, ty in beside(i):
            if free(box(i, anchor, tx, ty)): label(i, anchor, tx, ty); break
        else: out_.append(i)
    ground = {int(r): spans for r, spans in req["ground"]["land"].items()}
    for i in out_:
        found = sorted(((round(math.dist(*lead) + (lb["land_cost"] if on_land(ground, bx) else 0), 6), -inward(i, *unit(lead)), anchor, tx, ty, bx, lead)
                        for anchor, tx, ty, lead in out(i) for bx in [box(i, anchor, tx, ty)] if free(bx)), key=lambda c: c[:2])
        for _, _, anchor, tx, ty, bx, lead in found:
            pts = clear_lead(i, *lead)
            if pts is not None: label(i, anchor, tx, ty, lead, pts); break
        else: dropped.append(i["code"])
    order = {i["code"]: n for n, i in enumerate(wanted)}
    dropped.sort(key=order.get)
    return {"marks": marks, "texts": texts, "dropped": dropped}


def main():
    line = input()  # the one request line on stdin (no module of the host is imported)
    print(json.dumps(reply(json.loads(line))), flush=True)


if __name__ == "__main__":
    main()
