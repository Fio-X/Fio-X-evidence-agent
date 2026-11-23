"""The illustration node's child (the visual group's IllusHero request runs it: src/next_visual.rs illus_hero).
One JSON line in, one line out, as leaves_js/illus_strip.cjs:
  in : {"tags": [wind|solar|hydro|coal|gas|grid, ...], "hero": "wind"|"gas", "width": 600..2000, "ground": "warm"|"cool"|{dark,mid,light,line}, "accent": "#rrggbb",
        "lead": story angle?, "composition": {focus_scale, reading_order, relief, smoke, seed}?, "parts": {part_id: {knob: value}}?}
        (anything node.json declares as a knob; unknown names and out-of-range values are refused). "lead" is the page's lead finding, one of
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
    family's tone for the scene's story arc (node.json stories.arc_grounds), so a lagging story and a story on time do not share one ground."""
    g = inp.get("ground", c["ground"])
    if sc is None or not isinstance(g, str): return pal
    return REG["stories"]["arc_grounds"][sc["arc"]][g]


def mark_of(it, args):
    """A leader mark over a placed part: its foot (the part's own place unless the mark names one) and its height over the ground, an
    expression over the part's final arguments, so a part made taller by a knob keeps its mark on top."""
    m = it.get("mark")
    if m is None: return None
    at = m.get("at") or it.get("at") or [args["cx"], args["cy"]]
    return {"at": list(at), "z": float(eval(str(m["z"]), {"__builtins__": {}}, dict(args))), "rise": m["rise"]}


def resolve(inp):
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
    return out, float(width), h, secs, scene["scene"]


def serve():
    line = sys.stdin.readline()
    try:
        inp = json.loads(line)
        if not isinstance(inp, dict): raise Refused("the request is not an object")
        with tempfile.TemporaryDirectory(prefix="illus-hero-") as work:
            svg, w, h, secs, name = build(inp, work)
        reply = {"svg": svg, "w": w, "h": h, "dropped": [], "scene": name, "seconds": secs}
    except Refused as e: reply = {"refused": [str(e)]}
    except Unavailable as e: reply = {"unavailable": str(e)}
    except json.JSONDecodeError as e: reply = {"refused": [f"the request is not JSON: {e}"]}
    sys.stdout.write(json.dumps(reply) + "\n"); sys.stdout.flush()


if __name__ == "__main__":
    serve()
