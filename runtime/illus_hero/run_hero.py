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
import copy, json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
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


def resolve(inp):
    if inp.get("subject") is not None: return compose_subject(inp)
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


def unit_item(fn, x, y, size, lit, mark=None, yaw=0.0, z=28.0):
    it = {"part": fn, "kind": "at_ground", "fn": fn, "at": [round(x, 2), round(y, 2)], "dz": -0.3, "args": {"size": round(size, 3), "lit": bool(lit)}}
    if mark: it["mark"] = {"z": f"{z * size:.1f}", "rise": TOPICS["layout"]["mark_rise"]}; it["hero"] = True
    return it


def layout_tally(unit, subject, topic):
    L = TOPICS["layout"]; ms = members_of(subject); lit = lit_codes(subject); n = len(ms)
    ordered = sorted(ms, key=lambda m: (m["code"] not in lit, -m["value"], m["code"]))   # the lit ones first, so the count reads as a run
    rows = 1 if n <= L["rows_at"][0] else 2 if n <= L["rows_at"][1] else 3; cols = -(-n // rows)
    x0, x1 = L["x"]; step = min(36.0, (x1 - x0) / (cols + 0.5)); size = min(max(step / 22.0, L["min_size"]), L["max_size"]) * TOPICS["scenes"][topic]["tally_k"]; left = -step * cols / 2; items = []
    for i, m in enumerate(ordered):
        r, c = divmod(i, cols); on = m["code"] in lit
        items.append(unit_item(unit, left + step * (c + 0.5) + step * 0.34 * (r % 3), L["y0"] + L["row_dy"] * r, size * (1.0 if on else L["unlit_k"]), on, mark=on and i == len(lit) - 1))
    return items, dict(layout=f"tally-{rows}x{cols}", objects=n, lit=len(lit))


def layout_pair(unit, subject, topic=None):
    L = TOPICS["layout"]["pair"]; ms = members_of(subject); val = {m["code"]: m["value"] for m in ms}
    order = sorted(val, key=lambda c: (-val[c], c)); hi, lo = order[0], order[-1]
    if val[hi] <= 0 or val[lo] < 0 or val[hi] == val[lo]: refuse("subject: a pair needs a highest above the lowest, both positive")
    big = L["hi_size"]; small = max(big * val[lo] / val[hi], L["floor"] * big)
    items = [unit_item(unit, L["hi_x"], L["y"], big, True, mark=True), unit_item(unit, L["lo_x"], L["y"], small, False)]
    rest = order[1:-1][:L["back_max"]]; x0, x1 = TOPICS["layout"]["x"]
    for i, c in enumerate(rest): items.append(unit_item(unit, x0 + (x1 - x0) * (i + 0.5) / len(rest), L["back_y"], max(L["back_size"] * val[c] / val[hi], L["back_floor"]), False))
    return items, dict(layout=f"pair-{len(rest)}", objects=len(items), lit=1)


def layout_rank(unit, subject, topic=None):
    L = TOPICS["layout"]["rank"]; ms = members_of(subject); val = {m["code"]: m["value"] for m in ms}
    order = sorted(val, key=lambda c: (-val[c], c))
    if len(order) > L["max"]: order = order[:L["max"] // 2] + order[-(L["max"] - L["max"] // 2):]
    top = val[order[0]]
    if top <= 0: refuse("subject: a ranking needs a highest above 0")
    x0, x1 = TOPICS["layout"]["x"]; step = (x1 - x0) / len(order); items = []
    for i, c in enumerate(order): items.append(unit_item(unit, x0 + step * (i + 0.5), L["y"], max(L["size"] * max(val[c], 0) / top, L["floor"]), i == 0, mark=i == 0))
    return items, dict(layout=f"rank-{len(order)}", objects=len(order), lit=1)


def layout_path(unit, subject, topic=None):
    L = TOPICS["layout"]["path"]; p = subject.get("path") or {}
    a, b, c = (number(p.get(k), f"subject.path.{k}") for k in ("from", "now", "goal"))
    if c == a: refuse("subject.path: the goal is the start")
    frac = min(max((b - a) / (c - a), 0.0), 1.0); k = L["milestones"]; passed = int(frac * k + 1e-9)
    x0, x1 = L["x"]; s0, s1 = L["size"]; items = []
    for i in range(k):
        items.append(unit_item(unit, x0 + (x1 - x0) * i / (k - 1), L["y"], s0 + (s1 - s0) * i / (k - 1), i < passed, mark=passed > 0 and i == passed - 1))
    items.append({"part": "target_flag", "kind": "at_ground", "fn": "target_flag", "at": list(L["flag_at"]), "dz": -0.3, "args": {"height": 34, "cloth": 14, "wave": 0.18, "yaw": 0}})
    items.append({"part": "track", "kind": "track", "args": {"points": [[x0 - 40, L["track_y"]], [-60, L["track_y"] - 2], [60, L["track_y"] - 2], [x1 + 40, L["track_y"]]], "width": 7}})
    return items, dict(layout=f"path-{passed}of{k}", objects=k, lit=passed)


def layout_series(unit, subject, topic=None):
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
    x0, x1 = TOPICS["layout"]["x"]; step = (x1 - x0) / len(ys); items = []
    for i, y in enumerate(ys):
        on = y["t"] >= split; items.append(unit_item(unit, x0 + step * (i + 0.5), L["y"], max(L["size"] * max(y["value"], 0) / top, L["floor"]), on, mark=y["t"] == split))
    return items, dict(layout=f"series-{len(ys)}-{len(lit)}", objects=len(ys), lit=len(lit))


LAYOUTS = {"tally": layout_tally, "series": layout_series, "pair": layout_pair, "rank": layout_rank, "path": layout_path}


def compose_subject(inp):
    """(scene, ground, accent, composition knobs) of a request with a subject: the topic (family), the layout (the lead angle's kind),
    the units placed from the finding's rows. Same signature of a composition (scene id, objects, lit, layout) for the same input."""
    sub = inp["subject"]
    if not isinstance(sub, dict): refuse("subject: an object required")
    topic = topic_of(inp.get("family")); sc = TOPICS["scenes"][topic]
    lead = inp.get("lead"); kind = sub.get("kind") or TOPICS["angle_kinds"].get(lead)
    if kind not in LAYOUTS: refuse(f"subject: the layout {kind!r} (lead {lead!r}) is none of {'|'.join(LAYOUTS)}")
    items, comp = LAYOUTS[kind](sc["unit"], sub, topic)
    for it in items:   # the leader mark stands as high over a unit as the topic's unit is tall
        if "mark" in it: it["mark"]["z"] = f"{sc['mark_z'] * it['args']['size']:.1f}"
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
    cam = copy.deepcopy(TOPICS["cameras"].get(kind, TOPICS["cameras"]["default"])); mirror = c["reading_order"] == "right_to_left"
    for it in items:
        if "mark" in it: it["mark"] = {"at": list(it["at"]), "z": float(it["mark"]["z"]), "rise": it["mark"]["rise"]}
    if mirror:
        items = [mirror_item(i) for i in items]; cam["loc"][0] = -cam["loc"][0]; cam["target"][0] = -cam["target"][0]
    r = REG["input"]["render"]
    scene = dict(w=r["w"], h=r["h"], mirror=mirror, relief=c["relief"], items=items, shadow=REG["contact_shadow"], camera=cam, hero=dict(at=[0, 0], yaw=0.0, focus_local=[0, 0, 0]),
                 scene=f"{topic}.{kind}", composition=dict(scene=f"{topic}.{kind}", **comp))
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
    post_path = os.path.join(work, "post.json"); json.dump(dict(out=work, palette=pal, accent=acc, smoke=c["smoke"], seed=c["seed"], raster_scale=1), open(post_path, "w"))
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


def serve():
    line = sys.stdin.readline()
    try:
        inp = json.loads(line)
        if not isinstance(inp, dict): raise Refused("the request is not an object")
        with tempfile.TemporaryDirectory(prefix="illus-hero-") as work:
            svg, w, h, secs, name, comp = build(inp, work)
        reply = {"svg": svg, "w": w, "h": h, "dropped": [], "scene": name, "seconds": secs, **({"composition": comp} if comp else {})}
    except Refused as e: reply = {"refused": [str(e)]}
    except Unavailable as e: reply = {"unavailable": str(e)}
    except json.JSONDecodeError as e: reply = {"refused": [f"the request is not JSON: {e}"]}
    sys.stdout.write(json.dumps(reply) + "\n"); sys.stdout.flush()


if __name__ == "__main__":
    serve()
