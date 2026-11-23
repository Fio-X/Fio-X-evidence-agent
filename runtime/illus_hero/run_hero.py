"""The illustration node's child (the visual group's IllusHero request runs it: src/next_visual.rs illus_hero).
One JSON line in, one line out, as leaves_js/illus_strip.cjs:
  in : {"tags": [wind|solar|hydro|coal|gas|grid, ...], "hero": "wind"|"gas", "width": 600..2000, "ground": "warm"|"cool"|{dark,mid,light,line}, "accent": "#rrggbb",
        "lead": story angle?, "composition": {focus_scale, reading_order, relief, smoke, seed}?, "parts": {part_id: {knob: value}}?}
        (anything node.json declares as a knob; unknown names and out-of-range values are refused). Two optional fields bind the picture to the page's
        finding and its topic (node.json topics): "family" (the measure family id of the page's table) and "subject" ({"members": [{"code", "value"}], "rule": {"op", "ref"|"k"},
        "declared": {"count", "total"}, "path": {"from", "now", "goal"}}: the lead finding's own rows). With a subject the picture is composed from it (compose_subject) and
        the tags are not needed; the lit count is recomputed from the rows and refused when it is not the declared one. "lead" is the page's lead finding, one of
        node.json stories.angles; it picks the scene, so a story's opening picture follows its story, not its table (pick_scene).
        Under a scene a named ground (warm, cool) takes the tone of the scene's story arc (stories.arc_grounds: happened, in_time, lagging); given colours stand as given.
  out: {"svg": the picture's markup (no outer svg, no text; one <g transform="scale(k)"> over the 1440x560 viewBox), "w", "h", "dropped": [], "scene": name,
        "seconds": {stage: s}}
       | {"refused": [why, ...]}                       the input is wrong (the caller's fault)
       | {"unavailable": why}                          Blender or a python package is missing, or it took too long (the caller falls back to the page-bottom strip)
Parts, layout slots, heroes, palettes and knob ranges are data in node.json (the registry); this file validates the input against it, resolves it into a scene (scene.json), runs
scene_node.py under Blender (headless, three passes) and hero_node.py (the painting), and returns the svg. It makes no number and no word: the picture is only shapes."""
import copy, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)      # (python -I puts no script directory on the path)
import frame as FR  # noqa: E402
REG = json.load(open(os.path.join(HERE, "node.json")))
TAG_ORDER = ["hydro", "solar", "wind", "coal", "gas", "grid"]
BLENDER_DEADLINE = 40.0     # seconds for the Blender process; the whole picture must be back inside 55 s (the caller's deadline is 60)
TOTAL_DEADLINE = 55.0
WIDTH = (600, 2000)


class Refused(Exception): pass
class Unavailable(Exception): pass


def refuse(msg): raise Refused(msg)


def check_range(label, v, spec):
    if "min" in spec and not (spec["min"] <= v <= spec["max"]): refuse(f"{label}={v} outside [{spec['min']}, {spec['max']}]")


def validate(inp):
    known = set(t for p in REG["parts"] for t in p["tags"])
    tags = inp.get("tags")
    if not isinstance(tags, list) or not tags: refuse("tags: non-empty list required")
    bad = [t for t in tags if t not in known]
    if bad: refuse(f"unknown tags {bad}; known: {sorted(known)}")
    ck = REG["composition_knobs"]; comp = dict(inp.get("composition", {}))
    if "hero" in inp: comp["hero"] = inp["hero"]
    for k in comp:
        if k not in ck: refuse(f"unknown composition knob {k}; known: {list(ck)}")
    c = {k: spec.get("default") for k, spec in ck.items()}; c.update(comp)
    if c["hero"] not in ck["hero"]["values"]: refuse(f"hero must be one of {ck['hero']['values']}")
    hero = REG["heroes"][c["hero"]]
    if hero["needs_tag"] not in tags: refuse(f"hero {c['hero']} needs tag {hero['needs_tag']} in tags")
    for k in ("focus_scale", "relief"): check_range(k, c[k], ck[k])
    if c["reading_order"] not in ck["reading_order"]["values"]: refuse("reading_order must be left_to_right or right_to_left")
    g = inp.get("ground", c["ground"])
    if isinstance(g, str):
        if g not in REG["palettes"]: refuse(f"ground {g} not in {list(REG['palettes'])}")
        pal = REG["palettes"][g]
    else:
        if set(g) != {"dark", "mid", "light", "line"}: refuse("ground colours need dark, mid, light, line")
        pal = g
    acc = inp.get("accent", c["accent"])
    if not (isinstance(acc, str) and len(acc) == 7 and acc[0] == "#" and all(ch in "0123456789abcdefABCDEF" for ch in acc[1:])): refuse("accent must be #rrggbb")
    lead = inp.get("lead")
    if lead is not None and lead not in REG["stories"]["angles"]: refuse(f"lead {lead!r} is no story angle; known: {sorted(REG['stories']['angles'])}")
    pid = {p["id"]: p for p in REG["parts"]}; over = inp.get("parts", {})
    for part, kn in over.items():
        if part not in pid: refuse(f"unknown part {part}")
        for k, v in kn.items():
            spec = pid[part]["knobs"].get(k) or refuse(f"part {part} has no knob {k}")
            if isinstance(v, (int, float)): check_range(f"{part}.{k}", v, spec)
    return tags, c, pal, acc, over


def mirror_item(it):
    a = it.get("args", {})
    if "at" in it: it["at"] = [-it["at"][0], it["at"][1]]
    if "yaw" in a: a["yaw"] = -a["yaw"]
    if "cx" in a: a["cx"] = -a["cx"]
    if "points" in a: a["points"] = [[-x, y] for x, y in a["points"]]   # a track: every point mirrors
    if "at" in it.get("mark", {}): it["mark"]["at"] = [-it["mark"]["at"][0], it["mark"]["at"][1]]
    if it["kind"] == "reservoir": a["x0"], a["x1"] = -a["x1"], -a["x0"]      # a span: its ends swap
    elif "x0" in a and "x1" in a: a["x0"], a["x1"] = -a["x0"], -a["x1"]      # a pipe: both ends mirror
    return it


def pick_scene(inp, tags):
    """The scene the lead finding asks for (name, its block), or the panorama (block None), and why: no lead, a scene that needs a tag the
    request lacks, or a scene hero whose tag the request lacks keeps the panorama. Only the request's own fields decide it."""
    lead = inp.get("lead")
    if lead is None: return "panorama", None, "no lead finding"
    name = REG["stories"]["angles"][lead]; sc = REG["scenes"][name]
    miss = [t for t in sc.get("needs_tags", []) if t not in tags]
    if miss: return "panorama", None, f"the {name} scene needs {miss}"
    need = REG["heroes"][sc["hero"]["name"]]["needs_tag"]
    if need is not None and need not in tags: return "panorama", None, f"the {name} scene's hero needs {need}"
    return name, sc, f"lead {lead}"


def ground_palette(inp, c, pal, sc):
    """The ground colours: given colours stand as given; a named family (warm, cool) is the panorama's palette, or, under a scene, that
    family's tone for the lead's story arc (the scene's own unless stories.angle_arcs names another; stories.arc_grounds), so a lagging story and a story on time do not share one ground."""
    g = inp.get("ground", c["ground"])
    if sc is None or not isinstance(g, str): return pal
    return REG["stories"]["arc_grounds"][REG["stories"].get("angle_arcs", {}).get(inp.get("lead"), sc["arc"])][g]


def mark_of(it, args):
    """A leader mark over a placed part: its foot (the part's own place unless the mark names one) and its height over the ground, an
    expression over the part's final arguments, so a part made taller by a knob keeps its mark on top."""
    m = it.get("mark")
    if m is None: return None
    at = m.get("at") or it.get("at") or [args["cx"], args["cy"]]
    return {"at": list(at), "z": float(eval(str(m["z"]), {"__builtins__": {}}, dict(args))), "rise": m["rise"]}


def resolve(inp, renderer="3d"):
    if inp.get("subject") is not None: return compose_subject(inp, renderer)
    tags, c, pal, acc, over = validate(inp)
    name, sc, _ = pick_scene(inp, tags)
    pal = ground_palette(inp, c, pal, sc)
    mirror = c["reading_order"] == "right_to_left"; items = []
    if sc is not None and "relief" not in inp.get("composition", {}): c = {**c, "relief": sc["relief"]}
    placed = [(t, it) for t in TAG_ORDER if t in tags for it in (REG["slots"] if sc is None else sc["slots"]).get(t, [])]
    placed += [(None, it) for it in (sc or {}).get("always", [])]
    for _, it in placed:
        it = copy.deepcopy(it); it.setdefault("args", {}).update(over.get(it["part"], {}))
        items.append(it)
    h = REG["heroes"][c["hero"] if sc is None else sc["hero"]["name"]]
    if sc is not None:   # the scene places, sizes and frames its hero
        h = {**h, **{k: v for k, v in sc["hero"].items() if k in ("at", "dz", "camera", "mark")}, "args": {**h.get("args", {}), **sc["hero"].get("args", {})}}
    hp = next(p for p in REG["parts"] if p["id"] == h["part"])
    args = {k: s["default"] for k, s in hp["knobs"].items()}; args.update(h.get("args", {})); args.update(over.get(h["part"], {}))
    for k in h["scale_args"]: args[k] = args[k] * c["focus_scale"]
    focus = [eval(e, {"__builtins__": {}}, dict(args)) for e in h["focus_local"]]
    items.append({"part": h["part"], "kind": "at_ground", "fn": h["part"], "at": list(h["at"]), "dz": h["dz"], "args": args, "hero": True, **({"mark": dict(h["mark"])} if "mark" in h else {})})
    for it in items:
        if "mark" in it: it["mark"] = mark_of(it, it["args"])
    cam = copy.deepcopy(h["camera"]); yaw = args.get(h["yaw_arg"], 0.0); at = list(h["at"])
    if mirror:
        items = [mirror_item(i) for i in items]; at[0] = -at[0]; yaw = -yaw
        cam["loc"][0] = -cam["loc"][0]; cam["target"][0] = -cam["target"][0]
    r = REG["input"]["render"]
    return dict(w=r["w"], h=r["h"], mirror=mirror, relief=c["relief"], items=items, shadow=REG["contact_shadow"], camera=cam, hero=dict(at=at, yaw=yaw, focus_local=focus), scene=name), pal, acc, c




# ---------------------------------------------------------------- the picture that shows the finding's value (topics, node.json)
OPS = {"ge": lambda v, t: v >= t, "gt": lambda v, t: v > t, "le": lambda v, t: v <= t, "lt": lambda v, t: v < t}
RANKED = ("bottom", "top")
TOPICS = REG["topics"]


def topic_of(family):
    """The topic of a measure family id: its entry of topics.families, the neutral topic for a family not listed (or none)."""
    return TOPICS["families"].get(family, TOPICS["neutral"]) if isinstance(family, str) else TOPICS["neutral"]


def number(v, what):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or abs(v) == float("inf"): refuse(f"{what}: {v!r} is no number")
    return float(v)


def members_of(subject, lo=3, hi=60):
    ms = subject.get("members")
    if not isinstance(ms, list) or not lo <= len(ms) <= hi: refuse(f"subject.members: {lo} to {hi} members required")
    seen = set()
    for m in ms:
        if not isinstance(m, dict) or not isinstance(m.get("code"), str) or not m["code"]: refuse("subject.members: each member needs a code")
        if m["code"] in seen: refuse(f"subject.members: {m['code']} twice")
        seen.add(m["code"]); number(m.get("value"), f"member {m['code']} value")
    return ms


def lit_codes(subject):
    """The codes the subject's rule holds for, recomputed from the members' values: a threshold (ge, gt, le, lt) or the k highest
    / lowest (a cut inside a tie refuses). A member's own flag, when given, must be the rule's, and the declared count and total
    (the numbers the page prints, ledger entries) must be the ones the rows give: a picture whose lit units are not the printed
    count is not drawn."""
    ms = members_of(subject); rule = subject.get("rule")
    if not isinstance(rule, dict) or rule.get("op") not in (*OPS, *RANKED): refuse(f"subject.rule: op is none of {'|'.join((*OPS, *RANKED))}")
    val = {m["code"]: float(m["value"]) for m in ms}
    if rule["op"] in OPS:
        t = number(rule.get("ref"), "subject.rule.ref"); lit = {c for c, v in val.items() if OPS[rule["op"]](v, t)}
    else:
        k = rule.get("k")
        if isinstance(k, bool) or not isinstance(k, int) or not 1 <= k <= len(ms) - 1: refuse(f"subject.rule.k: {k!r} is not a whole number on 1..{len(ms) - 1}")
        order = sorted(val, key=lambda c: (val[c], c), reverse=rule["op"] == "top")
        if val[order[k - 1]] == val[order[k]]: refuse("subject.rule: the cut falls inside a tie")
        lit = set(order[:k])
    for m in ms:
        if "flag" in m and bool(m["flag"]) != (m["code"] in lit): refuse(f"subject.members: the flag of {m['code']} is not the one the rule gives")
    dec = subject.get("declared") or {}
    if "count" in dec and dec["count"] != len(lit): refuse(f"subject.declared.count {dec['count']!r} is not the {len(lit)} members the rule holds for")
    if "total" in dec and dec["total"] != len(ms): refuse(f"subject.declared.total {dec['total']!r} is not the {len(ms)} members given")
    return lit


def unit_item(fn, x, y, size, lit, mark=None, dz=-0.3, kk="row_k", depth=None):
    """One unit on the ground: its part, place and size (the unit's own footprint factor k applied), lit or not; the mark is the leader
    line over the boundary unit, as high as that unit is tall."""
    u = TOPICS["units"][fn]; size = size * u["k"] * u[kk]
    it = {"part": fn, "kind": "at_ground", "fn": fn, "at": [round(x, 2), round(y, 2)], "dz": dz, "args": {"size": round(size, 3), "lit": bool(lit)}}
    if depth is not None and u.get("depth_groups"): it["args"]["depth"] = min(int(depth), 2)      # the row a crowd figure stands in (its paint group)
    if mark: it["mark"] = {"z": f"{u['mark_z'] * size:.1f}", "rise": TOPICS["layout"]["mark_rise"]}; it["hero"] = True
    return it


def row_ys(U, y0, rows, camera):
    """The ground depth of each row. A unit with persp_rows widens the spacing of the rows that stand further from the camera by the inverse
    of their perspective scale (the depth of the row before over the depth of the first row, the camera's own numbers), so the back rows,
    drawn smaller, do not close up on each other and on the front row; other units keep an even spacing."""
    L = TOPICS["layout"]; dy = L["row_dy"] * U.get("row_dy_k", 1.0); ys = [y0]
    for r in range(1, rows):
        k = FR.depth_of(camera, 0.0, ys[-1]) / FR.depth_of(camera, 0.0, y0) if U.get("persp_rows") and camera else 1.0
        ys.append(ys[-1] + dy * k)
    return ys


def grid(units, ordered, lit, x0, x1, y0, size_of, dz=-0.3, mark_last=True, rows=None, kk="tally_k", camera=None):
    """The members in rows over x0..x1 (the lit first), a unit each: the unit of position i is units[i % len(units)]; (items, rows, cols)."""
    L = TOPICS["layout"]; n = len(ordered)
    rows = rows or (1 if n <= L["rows_at"][0] else 2 if n <= L["rows_at"][1] else 3); cols = -(-n // rows)
    U = TOPICS["units"][units[0]]      # a unit may set its own row spacing and stagger (people: rows far enough apart, each row half a step off the one before)
    step = min(36.0, (x1 - x0) / (cols + 0.5)); size = size_of(step); left = (x0 + x1) / 2 - step * cols / 2; items = []; ys = row_ys(U, y0, rows, camera)
    nl = sum(1 for m in ordered if m["code"] in lit)
    for i, m in enumerate(ordered):
        r, c = divmod(i, cols); on = m["code"] in lit; fn = units[i % len(units)]
        u = TOPICS["units"][fn]; sz = size * (1.0 if on else U.get("unlit_k", L["unlit_k"]))
        if "body_w" in u: sz = min(sz, step / ((1 + u.get("gap", 0.1)) * u["body_w"] * u["k"] * u[kk]))      # a unit with a registered width stands clear of its neighbour
        items.append(unit_item(fn, left + step * (c + 0.5) + step * U.get("stagger", 0.34) * (r % U.get("stagger_rows", 3)), ys[r], sz, on, mark=mark_last and on and i == nl - 1, dz=dz, kk=kk, depth=r))
    return items, rows, cols


def order_members(ms, lit): return sorted(ms, key=lambda m: (m["code"] not in lit, -m["value"], m["code"]))   # the lit ones first, so the count reads as a run


def layout_tally(units, subject, topic, renderer="3d"):
    L = TOPICS["layout"]; ms = members_of(subject); lit = lit_codes(subject)
    items, rows, cols = grid(units, order_members(ms, lit), lit, *L["x"], L["y0"], lambda step: min(max(step / 22.0, L["min_size"]), L["max_size"]), camera=TOPICS["cameras"]["tally"])
    return items, dict(layout=f"tally-{rows}x{cols}", objects=len(ms), lit=len(lit), omitted=0)


def layout_groups(units, subject, topic, renderer="3d"):
    """Two groups side by side, each on its own slab, each its own members and its own lit count (the same rule over each group's rows,
    each declared count recomputed and refused like the single tally's); the groups' names are the caller's data, echoed back."""
    L = TOPICS["layout"]; G = L["groups"]; gs = subject.get("groups")
    if not isinstance(gs, list) or len(gs) != 2: refuse("subject.groups: two groups required")
    keys = [g.get("key") for g in gs]
    if not all(isinstance(k, str) and k for k in keys) or keys[0] == keys[1]: refuse("subject.groups: each group needs its own key")
    seen = set(); items = []; out = []
    dec = (subject.get("declared") or {}).get("groups") or {}
    for g, (x0, x1) in zip(gs, G["x"]):
        sub = {"members": g.get("members"), "rule": subject.get("rule"), "declared": dec.get(g["key"])}
        ms = members_of(sub, lo=2, hi=30); lit = lit_codes(sub)
        for m in ms:
            if m["code"] in seen: refuse(f"subject.groups: {m['code']} is in two groups")
            seen.add(m["code"])
        its, rows, cols = grid(units, order_members(ms, lit), lit, x0, x1, L["y0"], lambda step: min(max(step / 22.0, L["min_size"]), L["max_size"]), dz=G["slab"]["h"] - 0.3, mark_last=False, rows=TOPICS["units"][units[0]].get("groups_rows", G["rows"]), kk="groups_k", camera=TOPICS["cameras"]["groups"])
        items += its
        w = x1 - x0 + G["slab"]["pad"] * 0.8; depth = L["row_dy"] * (rows - 1) + 22 + G["slab"]["pad"]
        items.append({"part": "plinth", "kind": "at_ground", "fn": "plinth", "at": [round((x0 + x1) / 2 + L["row_dy"] * 0.17 * (rows - 1), 2), round(L["y0"] + L["row_dy"] * (rows - 1) / 2, 2)], "dz": -0.3,
                      "args": {"height": G["slab"]["h"], "width": round(w, 1), "depth": round(depth, 1)}})
        out.append(dict(key=g["key"], name=g.get("name"), lit=len(lit), total=len(ms)))
    return items, dict(layout="groups-" + "+".join(f"{o['lit']}of{o['total']}" for o in out), objects=sum(o["total"] for o in out), lit=sum(o["lit"] for o in out), groups=out, omitted=0)


def layout_pair(units, subject, topic=None, renderer="3d"):
    unit = units[0]
    L = TOPICS["layout"]["pair"]; ms = members_of(subject); val = {m["code"]: m["value"] for m in ms}
    order = sorted(val, key=lambda c: (-val[c], c)); hi, lo = order[0], order[-1]
    if val[hi] <= 0 or val[lo] < 0 or val[hi] == val[lo]: refuse("subject: a pair needs a highest above the lowest, both positive")
    big = L["hi_size"]; small = max(big * val[lo] / val[hi], L["floor"] * big)
    items = [unit_item(unit, L["hi_x"], L["y"], big, True, mark=True), unit_item(unit, L["lo_x"], L["y"], small, False)]
    rest = order[1:-1][:L["back_max"]]; x0, x1 = TOPICS["layout"]["x"]
    for i, c in enumerate(rest): items.append(unit_item(unit, x0 + (x1 - x0) * (i + 0.5) / len(rest), L["back_y"], max(L["back_size"] * val[c] / val[hi], L["back_floor"]), False))
    return items, dict(layout=f"pair-{len(rest)}", objects=len(items), lit=1, omitted=0)


def row_slots(U, ratios, x0, x1, cap, floor, gap_after=None, gap_w=0.0):
    """One row of units, each as large as its ratio (value over the highest) times `big`, side by side over x0..x1; (sizes, centres).
    A unit of a registered body width (body_w, scene units at size 1; gap: clear space as a share of it) gets a slot as wide as itself and
    `big` is the largest that fits the row (the small ones close up, the big ones are as big as the row allows, never over cap); a unit
    without a width gets an even slot at the cap. `gap_after`: the index after which a slot of gap_w scene units is left (the omission mark);
    (sizes, centres, the centre of that slot or None)."""
    n = len(ratios); room = (x1 - x0) - (gap_w if gap_after is not None else 0.0)
    if "body_w" not in U:
        step = room / n; sizes = [max(cap * r, floor) for r in ratios]; w = [step] * n
    else:
        big = cap; bw = U["body_w"] * (1 + U.get("gap", 0.1))
        for _ in range(8):
            sizes = [max(big * r, floor) for r in ratios]; need = sum(s * bw for s in sizes)
            if need <= room + 1e-6: break
            big *= room / need
        w = [s * bw for s in sizes]; x0 += (room - sum(w)) / 2        # a row that is not full is centred
    xs = []; cur = x0; gc = None
    for i in range(n):
        xs.append(cur + w[i] / 2); cur += w[i]
        if gap_after is not None and i == gap_after - 1: gc = cur + gap_w / 2; cur += gap_w
    return sizes, xs, gc


def layout_rank(units, subject, topic=None, renderer="3d"):
    """The members by value, each unit as large as its value (against the highest); a unit that is wide shows only the ends of the ranking
    (rank_ends of them for the renderer: the head and the tail), and the place where the middle is left out holds the omission mark; `omitted` is the
    number of members the request had and the picture does not draw (the page prints its own caption from it)."""
    unit = units[0]
    L = TOPICS["layout"]["rank"]; ms = members_of(subject); val = {m["code"]: m["value"] for m in ms}
    order = sorted(val, key=lambda c: (-val[c], c))
    U = TOPICS["units"][unit]; head, tail = U.get("rank_ends", L["ends"])[renderer]; cut = None
    if len(order) > head + tail: cut = head; order = order[:head] + order[-tail:]
    omitted = len(ms) - len(order); top = val[order[0]]
    if top <= 0: refuse("subject: a ranking needs a highest above 0")
    x0, x1 = L.get("x", TOPICS["layout"]["x"]); O = TOPICS["omitted"]
    sizes, xs, gc = row_slots(U, [max(val[c], 0) / top for c in order], x0, x1, L["size"], L["floor"], cut if omitted else None, O["slot"])
    items = [unit_item(unit, xs[i], L["y"], sizes[i], i == 0, mark=i == 0) for i in range(len(order))]
    if omitted:
        near = (sizes[cut - 1] + sizes[cut]) / 2 * U["mark_z"]
        items.append({"part": "ellipsis_mark", "kind": "at_ground", "fn": "ellipsis_mark", "at": [round(gc, 2), L["y"]], "dz": -0.3,
                      "args": {"r": round(min(O["r_frac"] * near, 0.45 * O["slot"] / (1 + O["gap"])), 2), "gap": O["gap"], "z": round(O["z_frac"] * near, 2)}})      # the three dots (6r + 2r wide) stay inside the slot
    return items, dict(layout=f"rank-{len(order)}", objects=len(order), lit=1, omitted=omitted)


def layout_path(units, subject, topic=None, renderer="3d"):
    unit = units[0]
    L = TOPICS["layout"]["path"]; p = subject.get("path") or {}
    a, b, c = (number(p.get(k), f"subject.path.{k}") for k in ("from", "now", "goal"))
    if c == a: refuse("subject.path: the goal is the start")
    frac = min(max((b - a) / (c - a), 0.0), 1.0); k = L["milestones"]; passed = int(frac * k + 1e-9)
    x0, x1 = L["x"]; s0, s1 = L["size"]; items = []
    for i in range(k):
        items.append(unit_item(unit, x0 + (x1 - x0) * i / (k - 1), L["y"], s0 + (s1 - s0) * i / (k - 1), i < passed, mark=passed > 0 and i == passed - 1))
    items.append({"part": "target_flag", "kind": "at_ground", "fn": "target_flag", "at": list(L["flag_at"]), "dz": -0.3, "args": {"height": 34, "cloth": 14, "wave": 0.18, "yaw": 0}})
    items.append({"part": "track", "kind": "track", "args": {"points": [[x0 - 40, L["track_y"]], [-60, L["track_y"] - 2], [60, L["track_y"] - 2], [x1 + 40, L["track_y"]]], "width": 7}})
    return items, dict(layout=f"path-{passed}of{k}", objects=k, lit=passed, omitted=0)


def layout_series(units, subject, topic=None, renderer="3d"):
    unit = units[0]
    """The years in order, each unit as tall as its year's value; the years from the split year on are lit (the declared count is refused
    when it is not the number of those years)."""
    L = TOPICS["layout"]["series"]; ys = subject.get("series")
    if not isinstance(ys, list) or not L["min"] <= len(ys) <= L["max"]: refuse(f"subject.series: {L['min']} to {L['max']} years required")
    for y in ys:
        if not isinstance(y, dict) or isinstance(y.get("t"), bool) or not isinstance(y.get("t"), int): refuse("subject.series: each year needs a whole-number t")
        number(y.get("value"), f"year {y.get('t')} value")
    if len({y["t"] for y in ys}) != len(ys): refuse("subject.series: a year twice")
    split = subject.get("split")
    if isinstance(split, bool) or not isinstance(split, int): refuse("subject.split: a whole-number year required")
    ys = sorted(ys, key=lambda y: y["t"]); lit = [y["t"] for y in ys if y["t"] >= split]
    dec = subject.get("declared") or {}
    if "count" in dec and dec["count"] != len(lit): refuse(f"subject.declared.count {dec['count']!r} is not the {len(lit)} years from {split} on")
    if "total" in dec and dec["total"] != len(ys): refuse(f"subject.declared.total {dec['total']!r} is not the {len(ys)} years given")
    if not lit or len(lit) == len(ys): refuse("subject.split: it must leave years before it and from it on")
    top = max(y["value"] for y in ys)
    if top <= 0: refuse("subject.series: the highest value must be above 0")
    x0, x1 = L.get("x", TOPICS["layout"]["x"]); sizes, xs, _ = row_slots(TOPICS["units"][unit], [max(y["value"], 0) / top for y in ys], x0, x1, L["size"], L["floor"]); items = []
    for i, y in enumerate(ys):
        on = y["t"] >= split; items.append(unit_item(unit, xs[i], L["y"], sizes[i], on, mark=y["t"] == split))
    return items, dict(layout=f"series-{len(ys)}-{len(lit)}", objects=len(ys), lit=len(lit), omitted=0)


LAYOUTS = {"tally": layout_tally, "groups": layout_groups, "series": layout_series, "pair": layout_pair, "rank": layout_rank, "path": layout_path}


def pick_units(topic, family, sub, kind):
    """The units the finding draws: the topic's one unit, or, where the scene has objects (energy), the one the finding's measure key (subject.measure)
    or else the family's entry names; a mix is the layout's list. A measure key the scene does not list is refused."""
    sc = TOPICS["scenes"][topic]; ob = sc.get("objects")
    if ob is None: return [sc["unit"]]
    m = sub.get("measure"); key = m if m is not None else ob["family"].get(family, ob["default"])
    if key == "mix": return list(ob["mix"][kind])
    if key not in ob["measure"]: refuse(f"subject.measure {key!r} is none of {'|'.join(ob['measure'])}|mix")
    return [ob["measure"][key]]


def compose_subject(inp, renderer="3d"):
    """(scene, ground, accent, composition knobs) of a request with a subject: the topic (family), the layout (the lead angle's kind),
    the units placed from the finding's rows. Same signature of a composition (scene id, objects, lit, layout) for the same input."""
    sub = inp["subject"]
    if not isinstance(sub, dict): refuse("subject: an object required")
    topic = topic_of(inp.get("family")); sc = TOPICS["scenes"][topic]
    lead = inp.get("lead"); kind = sub.get("kind") or TOPICS["angle_kinds"].get(lead)
    if "groups" in sub and kind in ("tally", "pair"): kind = "groups"      # a finding about groups draws the groups
    if kind not in LAYOUTS: refuse(f"subject: the layout {kind!r} (lead {lead!r}) is none of {'|'.join(LAYOUTS)}")
    units = pick_units(topic, inp.get("family"), sub, kind)
    items, comp = LAYOUTS[kind](units, sub, topic, renderer); comp["units"] = sorted({i["fn"] for i in items if i.get("fn", "") in units})
    items += [{"part": f["fn"], "kind": "at_ground", "fn": f["fn"], "at": list(f["at"]), "dz": -0.3, "args": dict(f.get("args", {}))} for f in sc["filler"]]
    ck = REG["composition_knobs"]; comp_in = dict(inp.get("composition", {}))
    for k in comp_in:
        if k not in ck: refuse(f"unknown composition knob {k}; known: {list(ck)}")
    c = {k: s.get("default") for k, s in ck.items()}; c.update(comp_in); c["relief"] = comp_in.get("relief", sc["relief"]); check_range("relief", c["relief"], ck["relief"])
    if c["reading_order"] not in ck["reading_order"]["values"]: refuse("reading_order must be left_to_right or right_to_left")
    g = inp.get("ground", c["ground"])
    if isinstance(g, str):
        if g not in REG["palettes"]: refuse(f"ground {g} not in {list(REG['palettes'])}")
        pal = REG["stories"]["arc_grounds"][TOPICS["kind_arcs"][kind]][g]
    else:
        if set(g) != {"dark", "mid", "light", "line"}: refuse("ground colours need dark, mid, light, line")
        pal = g
    acc = inp.get("accent", sc["accent"])
    if not (isinstance(acc, str) and len(acc) == 7 and acc[0] == "#" and all(ch in "0123456789abcdefABCDEF" for ch in acc[1:])): refuse("accent must be #rrggbb")
    fs = None
    if "figure_style" in sc:
        fs = inp.get("people_style", sc["figure_style"]["default"])
        if fs not in sc["figure_style"]["values"]: refuse(f"people_style {fs!r} is none of {'|'.join(sc['figure_style']['values'])}")
    elif "people_style" in inp: refuse(f"people_style: the {topic} topic draws no people")
    cam = copy.deepcopy(TOPICS["cameras"][TOPICS["units"][units[0]]["camera"]] if kind not in ("tally", "groups") and "camera" in TOPICS["units"][units[0]] else TOPICS["cameras"].get(kind, TOPICS["cameras"]["default"])); mirror = c["reading_order"] == "right_to_left"
    for it in items:
        if "mark" in it: it["mark"] = {"at": list(it["at"]), "z": float(it["mark"]["z"]), "rise": it["mark"]["rise"]}
    if mirror:
        items = [mirror_item(i) for i in items]; cam["loc"][0] = -cam["loc"][0]; cam["target"][0] = -cam["target"][0]
    r = REG["input"]["render"]
    scene = dict(w=r["w"], h=r["h"], mirror=mirror, relief=c["relief"], items=items, shadow=None if fs else REG["contact_shadow"], camera=cam, hero=dict(at=[0, 0], yaw=0.0, focus_local=[0, 0, 0]),
                 scene=f"{topic}.{kind}", composition=dict(scene=f"{topic}.{kind}", **({"figure_style": fs} if fs else {}), **comp), figure_style=fs)
    return scene, pal, acc, c


def blender_path():
    for p in (os.environ.get("BLENDER"), "/Applications/Blender.app/Contents/MacOS/Blender", shutil.which("blender")):
        if p and os.path.isfile(p) and os.access(p, os.X_OK): return p
    raise Unavailable("Blender is not installed (looked at /Applications/Blender.app and PATH)")


def check_packages():
    try:
        import numpy, scipy, shapely, PIL, contourpy  # noqa: F401
    except ImportError as e:
        raise Unavailable(f"python package missing for the painting: {e.name}")


def run(cmd, deadline):
    t = time.time()
    try: p = subprocess.run(cmd, capture_output=True, text=True, timeout=deadline)
    except subprocess.TimeoutExpired: raise Unavailable(f"{os.path.basename(cmd[0])} took longer than {deadline:.0f} s")
    if p.returncode: raise Unavailable(f"{os.path.basename(cmd[0])} failed: {(p.stdout + p.stderr)[-300:]}")
    return round(time.time() - t, 1)


def build(inp, work):
    """The picture for one input, its files under `work`; (svg markup, w, h, seconds)."""
    t0 = time.time(); width = inp.get("width")
    if isinstance(width, float) and width.is_integer(): width = int(width)      # the caller sends a JSON number: 1140.0
    if isinstance(width, bool) or not isinstance(width, int) or not WIDTH[0] <= width <= WIDTH[1]: refuse(f"width: {width!r} is not a whole number on {WIDTH[0]}..{WIDTH[1]}")
    scene, pal, acc, c = resolve(inp)
    blender = blender_path(); check_packages()
    scene["out"] = work; scene_path = os.path.join(work, "scene.json"); json.dump(scene, open(scene_path, "w"))
    post_path = os.path.join(work, "post.json"); json.dump(dict(out=work, palette=pal, accent=acc, smoke=c["smoke"], seed=c["seed"], raster_scale=1, figure_style=scene.get("figure_style")), open(post_path, "w"))
    secs = {}
    secs["blender"] = run([blender, "-b", "-P", os.path.join(HERE, "scene_node.py"), "--", scene_path], BLENDER_DEADLINE)
    left = TOTAL_DEADLINE - (time.time() - t0)
    if left < 8: raise Unavailable("Blender left no time for the painting")
    secs["paint"] = run([sys.executable, "-I", "-B", os.path.join(HERE, "hero_node.py"), post_path], left)
    svg = open(os.path.join(work, "hero.svg")).read()
    a, b = svg.index(">") + 1, svg.rindex("</svg>")
    k = width / 1440.0; h = round(560 * k, 2)
    out = f'<g transform="scale({k:.5f})">{svg[a:b]}</g>'
    secs["total"] = round(time.time() - t0, 1)
    return out, float(width), h, secs, scene["scene"], scene.get("composition")


def renderer_of(inp):
    """The drawing a request gets by default: the registry's scenes.<topic>.renderer of the request's topic (line or 3d); a request without a subject
    (the tags-and-hero scene) is the 3D path's own."""
    if inp.get("subject") is None: return "3d"
    return TOPICS["scenes"][topic_of(inp.get("family"))]["renderer"]


def page_colours(names):
    """{variable: hex} of the page palette's own tokens (runtime/leaves_py/tokens.css, next to this folder in the run's runtime): a
    hero may paint in hex only (the page's own check), so the line drawing's colour variables are resolved here, once, from the
    palette the page itself uses. A name the palette lacks, or holds in no hex, is refused: no colour of the child's own."""
    css = open(os.path.join(HERE, "..", "leaves_py", "tokens.css"), encoding="utf-8").read(); got = {}
    for n in names:
        m = re.search(re.escape(n) + r":\s*#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])", css)
        if not m: refuse(f"the page palette has no hex colour for {n}")
        h = m.group(1).lower(); got[n] = "#" + (h if len(h) == 6 else "".join(c * 2 for c in h))
    return got


def build_line(inp):
    """The same reply the 3D path gives, drawn by runtime/illus_hero/line (pure SVG in the page's colour variables, no Blender). The composition is
    resolve's own (renderer 'line': the ranking's head and tail of the registry); a layout or a unit the line drawing does not draw is `unavailable` (the page's strip stands in), a wrong request is refused, nothing is sent to 3D."""
    t0 = time.time(); width = inp.get("width")
    if isinstance(width, float) and width.is_integer(): width = int(width)
    if isinstance(width, bool) or not isinstance(width, int) or not WIDTH[0] <= width <= WIDTH[1]: refuse(f"width: {width!r} is not a whole number on {WIDTH[0]}..{WIDTH[1]}")
    resolved = resolve(inp, renderer="line")
    sys.path.insert(0, os.path.join(HERE, "line"))
    import draw as LD
    kind = resolved[0]["scene"].split(".")[1]
    if kind not in LD.REG["kinds"]: raise Unavailable(f"line: the {kind!r} layout is not drawn by the line renderer")     # the page's strip stands in
    miss = sorted({i["fn"] for i in resolved[0]["items"] if "lit" in i.get("args", {}) and i["fn"] not in LD.UN.DRAW})
    if miss: raise Unavailable(f"line: no line drawing for {', '.join(miss)}")
    d = LD.draw(resolved)
    inner = d["inner"]; cols = page_colours(sorted(set(re.findall(r"var\((--[a-z0-9-]+)\)", inner))))
    inner = re.sub(r"var\((--[a-z0-9-]+)\)", lambda m: cols[m.group(1)], inner)
    k = width / float(LD.CW); h = round(LD.CH * k, 2)
    return f'<g transform="scale({k:.5f})">{inner}</g>', float(width), h, {"line": d["seconds"], "total": round(time.time() - t0, 2)}, d["scene"], d["composition"]


def build_people(inp):
    """The same reply the line path gives, drawn by runtime/illus_hero/people: the composition is resolve's own (renderer 'people'); a layout the
    people drawing does not place is `unavailable` (the page's strip stands in), a wrong request is refused. Colours: the page's own tokens
    (accent, bar, title ink) resolved to hex here, the lit figures' primary is the topic's accent from the registry."""
    t0 = time.time(); width = inp.get("width")
    if isinstance(width, float) and width.is_integer(): width = int(width)
    if isinstance(width, bool) or not isinstance(width, int) or not WIDTH[0] <= width <= WIDTH[1]: refuse(f"width: {width!r} is not a whole number on {WIDTH[0]}..{WIDTH[1]}")
    resolved = resolve(inp, renderer="people")
    sys.path.insert(0, os.path.join(HERE, "people"))
    import draw as PD
    kind = resolved[0]["scene"].split(".")[1]
    if kind not in PD.KINDS: raise Unavailable(f"people: the {kind!r} layout is not drawn by the people renderer")      # the page's strip stands in
    topic = topic_of(inp.get("family")); primary = TOPICS["scenes"][topic]["accent"]
    d = PD.draw(resolved, page_colours(["--accent", "--bar", "--t-title"]), primary)
    k = width / float(PD.CW); h = round(d["h"] * k, 2)
    return f'<g transform="scale({k:.5f})">{d["inner"]}</g>', float(width), h, {"people": d["seconds"], "total": round(time.time() - t0, 2)}, d["scene"], d["composition"]


def serve():
    line = sys.stdin.readline()
    try:
        inp = json.loads(line)
        if not isinstance(inp, dict): raise Refused("the request is not an object")
        if renderer_of(inp) == "line": svg, w, h, secs, name, comp = build_line(inp)
        elif renderer_of(inp) == "people": svg, w, h, secs, name, comp = build_people(inp)
        else:
            with tempfile.TemporaryDirectory(prefix="illus-hero-") as work:
                svg, w, h, secs, name, comp = build(inp, work)
        reply = {"svg": svg, "w": w, "h": h, "dropped": [], "scene": name, "seconds": secs, **({"composition": comp, "omitted": comp.get("omitted", 0), "omitted_label_key": TOPICS["omitted"]["label_key"]} if comp else {})}
    except Refused as e: reply = {"refused": [str(e)]}
    except Unavailable as e: reply = {"unavailable": str(e)}
    except json.JSONDecodeError as e: reply = {"refused": [f"the request is not JSON: {e}"]}
    sys.stdout.write(json.dumps(reply) + "\n"); sys.stdout.flush()


if __name__ == "__main__":
    serve()
