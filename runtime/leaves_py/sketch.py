"""The sketch compare's choices (owner 11-14 16:0x item 1; works/complex-card/design.md), data in sketch.json: which chart leaves
may draw a block's main picture, and which of the drawn candidates wins. Pure: it reads the block's data shape and what each
drawn candidate reported, never a question's words, and makes no number that is printed.

candidates(relation, shape) -> [node, ...]: the leaves registered for the block's relation whose hard conditions the
  shape meets, in sketch.json's order, at most MOST (the highest encoding weights first when more are left, ties in order).
  shape: {"periods": n, "quantities": n, "rank_flips": n, "parts_add_up": bool, "parts": n, "places": n}; a condition
  whose key the shape lacks is not met (a candidate is listed only on what the data shows, never on a guess).
score(node, drawn) -> int: the fixed score of a drawn candidate: its encoding's weight, the bonus when the lead reading
  is one mark of it (drawn["lead_marked"]), a penalty when its reader must subtract or compare areas (the node's own
  reader_subtracts) and one per label it had to crowd (drawn["label_crowded"], a count).
shape(cells, whole=None, tol=0.005) -> the shape candidates() reads, counted from a block's cells (never printed):
  cells [{"place": code, "period": str, "quantity": code, "value": number}], whole [{"place", "period", "value"}] or None.
  places, periods, quantities: the distinct members; rank_flips: the place pairs whose order differs between the first
  and the last quantity (at the last period) when there are two quantities or more, else between the first and the last
  period (Kendall's discordant pairs; a place missing from either side is left out); parts and parts_add_up only when
  a whole is given: the quantities are its parts, adding up when every place and period's parts are within tol of
  its whole (a place and period with no whole, or a part missing, does not add up).
best(scores) -> [node, ...]: the highest-scoring nodes of {node: score}, in their given order; one is the main picture,
  several tie and the model picks among them by number (none: no candidate passed its checks).
Refuses (ValueError): a relation no node is registered for is no error (no candidates); a node sketch.json does not
  register, or a drawn report that is not {"lead_marked": bool, "label_crowded": n >= 0}, is."""
import json

DATA = {}  # sketch.json's content, given by the caller with use(): a second-layer node reads no file (node-file-reads-pinned.json)


def use(text):
    """Take sketch.json's text (the caller reads the file) as the registered nodes, weights, bonus and penalty."""
    data = json.loads(text)
    if not isinstance(data, dict) or not {"nodes", "weights", "bonus", "penalty"} <= set(data): raise ValueError("sketch: the text is not sketch.json's shape")
    DATA.clear(); DATA.update(data)

MOST = 3  # the design's 2-3 candidates a block draws

# each need: the shape key it reads and how the value must stand to it
NEEDS = {
    "periods_min": ("periods", lambda v, n: v >= n), "periods_max": ("periods", lambda v, n: v <= n),
    "periods_exact": ("periods", lambda v, n: v == n), "quantities_min": ("quantities", lambda v, n: v >= n),
    "rank_flips_min": ("rank_flips", lambda v, n: v >= n), "parts_add_up": ("parts_add_up", lambda v, n: v is n),
    "parts_min": ("parts", lambda v, n: v >= n), "parts_max": ("parts", lambda v, n: v <= n),
    "places_min": ("places", lambda v, n: v >= n), "places_max": ("places", lambda v, n: v <= n),
}


def meets(needs, shape):
    for need, n in needs.items():
        if need not in NEEDS: raise ValueError(f"sketch.json: no need {need}")
        key, ok = NEEDS[need]
        if key not in shape or shape[key] is None or not ok(shape[key], n): return False
    return True


def candidates(relation, shape):
    nodes = DATA["nodes"]
    out = [k for k, v in nodes.items() if relation in v["relations"] and meets(v.get("needs", {}), shape)]
    if len(out) <= MOST: return out
    keep = sorted(out, key=lambda k: -DATA["weights"][nodes[k]["encoding"]])[:MOST]
    return [k for k in out if k in keep]


def score(node, drawn):
    v = DATA["nodes"].get(node)
    if v is None: raise ValueError(f"sketch: {node} is no node sketch.json registers")
    if not isinstance(drawn, dict) or not isinstance(drawn.get("lead_marked"), bool) or not isinstance(drawn.get("label_crowded"), int) \
            or isinstance(drawn.get("label_crowded"), bool) or drawn["label_crowded"] < 0:
        raise ValueError(f"sketch: {node}'s drawn report {drawn!r} is not {{lead_marked: bool, label_crowded: n >= 0}}")
    s = DATA["weights"][v["encoding"]]
    s += DATA["bonus"]["lead_marked"] if drawn["lead_marked"] else 0
    s += DATA["penalty"]["reader_subtracts"] if v.get("reader_subtracts") else 0
    s += DATA["penalty"]["label_crowded"] * drawn["label_crowded"]
    return s


def discordant(a, b):
    """Place pairs ordered one way by a and the other by b (ties on either side are no flip); a, b: {place: value}."""
    both = sorted(set(a) & set(b))
    return sum(1 for i, p in enumerate(both) for q in both[i + 1:] if (a[p] - a[q]) * (b[p] - b[q]) < 0)


def shape(cells, whole=None, tol=0.005):
    for c in cells:
        if not isinstance(c, dict) or not {"place", "period", "quantity", "value"} <= set(c) or isinstance(c["value"], bool) \
                or not isinstance(c["value"], (int, float)):
            raise ValueError(f"sketch: a cell {c!r} is not {{place, period, quantity, value: number}}")
    order = lambda key: list(dict.fromkeys(c[key] for c in cells))
    places, periods, quantities = order("place"), sorted(order("period")), order("quantity")
    at = lambda q, t: {c["place"]: c["value"] for c in cells if c["quantity"] == q and c["period"] == t}
    out = {"places": len(places), "periods": len(periods), "quantities": len(quantities), "rank_flips": 0}
    if len(quantities) >= 2:
        out["rank_flips"] = discordant(at(quantities[0], periods[-1]), at(quantities[-1], periods[-1]))
    elif len(periods) >= 2:
        out["rank_flips"] = discordant(at(quantities[0], periods[0]), at(quantities[0], periods[-1]))
    if whole is not None:
        wh = {(w["place"], w["period"]): w["value"] for w in whole}
        out["parts"] = len(quantities)
        sums = {}
        for c in cells:
            sums.setdefault((c["place"], c["period"]), []).append(c["value"])
        out["parts_add_up"] = bool(sums) and all(
            k in wh and len(v) == len(quantities) and abs(sum(v) - wh[k]) <= tol * abs(wh[k]) for k, v in sums.items())
    return out


def best(scores):
    if not scores: return []
    top = max(scores.values())
    return [k for k, v in scores.items() if v == top]
