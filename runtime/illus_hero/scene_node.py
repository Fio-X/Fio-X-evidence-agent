"""Config-driven Blender scene for the illustration node.   Blender -b -P scene_node.py -- <scene.json>
scene.json is written by run_node.py (from the input JSON + node.json); this file contains no layout numbers of its own.
Passes and the Freestyle stroke hook are the same as scene_q1.py (shade.png, ids.png, lines.png, strokes.json, hub.json, ids.json).
Every standing part casts a thin shadow wedge on the terrain (contact_shadow), and the parts a scene marks get their projected tops in marks.json (leader lines)."""
import sys, os, math, json, time
import bpy

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import parts as P, world as Wd
from mesh import Mesh

CFG = json.load(open(sys.argv[sys.argv.index("--") + 1]))
RW, RH = CFG["w"], CFG["h"]; OUT = CFG["out"]; os.makedirs(OUT, exist_ok=True)
GROUP_ID = {"coal": (0.7, 0.35, 0.0), "hero_body": (1.0, 1.0, 0.0), "hero_blade": (0.0, 1.0, 0.2), "shadow": (0.35, 0.35, 0.35), "terrain": (0.62, 0.62, 0.62), "water": (0.0, 0.0, 1.0),
            "spill": (0.0, 0.8, 1.0), "pylon": (1.0, 0.0, 0.0), "wind": (0.0, 1.0, 0.0), "solar": (0.0, 1.0, 0.5), "hydro": (0.5, 1.0, 0.0), "track": (0.45, 0.0, 0.85)}
MX = -1.0 if CFG.get("mirror") else 1.0          # reading order: mirror the whole world left-right
RELIEF = CFG.get("relief", 1.0)                   # terrain height multiplier
HT = lambda x, y: RELIEF * Wd.height(MX * x, y)   # ground height in (mirrored) scene coordinates
G = lambda x, y: HT(x, y)


def move(meshes, x, y, z):
    for m in meshes: m.v = [(a + x, b + y, c + z) for a, b, c in m.v]
    return meshes


def contact_shadow(x, y, h):
    """A standing part's cast shadow on the ground (group shadow): a thin wedge from its foot away from the light, `h` tall parts cast
    longer ones, laid on the terrain so it never floats; CFG["shadow"] gives its length, width and direction (node.json contact_shadow)."""
    c = CFG.get("shadow")
    if not c or h <= 0: return []
    dx, dy = c["dir"]; L = c["len"] * h; w = c["w"] * h; n = 8; V = []; F = []
    nx, ny = -dy, dx
    for i in range(n + 1):
        t = i / n; hw = w * (1 - 0.75 * t) + 0.6; px, py = x + dx * L * t, y + dy * L * t
        for s in (-1, 1): V.append((px + s * nx * hw, py + s * ny * hw, G(px + s * nx * hw, py + s * ny * hw) + 0.3))
        if i: F.append((2 * i - 2, 2 * i, 2 * i + 1, 2 * i - 1))
    m = Mesh("cast", "shadow"); m.add(V, F, outward=False); return [m]


SHADOW_H = {"wind_turbine": "height", "hero_turbine": "height", "target_flag": "height", "pylon": "height"}


def build_world():
    meshes = []; chain = []
    meshes += P.terrain(HT, -190, 190, -110, 340, cell=4.5)
    for it in CFG["items"]:
        k, a = it["kind"], it.get("args", {}); fn = getattr(P, it["fn"]) if "fn" in it else None
        if k == "reservoir": meshes += P.reservoir(a["level"], a["x0"], a["x1"], a["y0"], a["y1"])
        elif k == "dam": meshes += P.arch_dam(MX * Wd.DX, Wd.DAM_Y, G(MX * Wd.DX, Wd.DAM_Y) - 1.5, **a)
        elif k == "coal": meshes += fn(base_z=G(a["cx"], a["cy"]) - 0.5, **a)
        elif k == "gas_pipe": meshes += P.gas_pipe(ground=HT, **a)
        elif k == "track": meshes += P.track(ground=HT, **a)
        elif k == "at_ground":
            x, y = it["at"]; meshes += move(fn(**a), x, y, G(x, y) + it.get("dz", -0.3))
            if it["fn"] in SHADOW_H: meshes += contact_shadow(x, y, a.get(SHADOW_H[it["fn"]], 0) * (0.5 if it["fn"] == "target_flag" else 1.0))
        elif k == "pylon":
            x, y = it["at"]; ms, an = fn(**a); meshes += move(ms, x, y, G(x, y) - 0.5); meshes += contact_shadow(x, y, 0.6 * a.get("height", 34)); chain.append([(p[0] + x, p[1] + y, p[2] + G(x, y) - 0.5) for p in an])
    for a0, a1 in zip(chain, chain[1:]):
        for p, q in zip(a0, a1): meshes += P.wires(p, q, sag=2.2)
    return meshes


def to_blender(meshes):
    colls = {n: bpy.data.collections.new(n) for n in ("objs", "terrain", "hero", "coal")}
    for c in colls.values(): bpy.context.scene.collection.children.link(c)
    objs = []
    for m in meshes:
        me = bpy.data.meshes.new(m.name); me.from_pydata(m.v, [], m.f); me.update()
        ob = bpy.data.objects.new(m.name, me); ob["grp"] = m.group
        for p in me.polygons: p.use_smooth = bool(m.smooth)
        if m.subsurf:
            md = ob.modifiers.new("sub", "SUBSURF"); md.levels = m.subsurf; md.render_levels = m.subsurf
        colls["terrain" if m.group == "terrain" else "hero" if m.group.startswith("hero") else "coal" if m.group == "coal" else "objs"].objects.link(ob); objs.append(ob)
    return colls, objs


def camera():
    from mathutils import Vector
    c = CFG["camera"]; cam = bpy.data.cameras.new("cam"); cam.lens = c["lens"]; cam.sensor_fit = "HORIZONTAL"; cam.sensor_width = 36.0; cam.clip_end = 2000
    ob = bpy.data.objects.new("cam", cam); bpy.context.scene.collection.objects.link(ob); ob.location = c["loc"]
    ob.rotation_euler = (Vector(c["target"]) - Vector(c["loc"])).to_track_quat("-Z", "Y").to_euler(); bpy.context.scene.camera = ob


def focus_pixel():
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector
    h = CFG["hero"]; yaw = math.radians(h["yaw"]); lx, ly, lz = h["focus_local"]
    x, y = h["at"]; wx = x + lx * math.cos(yaw) - ly * math.sin(yaw); wy = y + lx * math.sin(yaw) + ly * math.cos(yaw); wz = G(x, y) - 0.3 + lz
    bpy.context.view_layer.update()
    c = world_to_camera_view(bpy.context.scene, bpy.context.scene.camera, Vector((wx, wy, wz)))
    json.dump({"x": c.x * RW, "y": (1 - c.y) * RH, "w": RW, "h": RH}, open(os.path.join(OUT, "hub.json"), "w"))


def mark_pixels():
    """Where each part's leader mark stands in the picture: the projected top of the part (foot + its mark height), and how far the
    leader rises from there (px at the 1440 frame); marks.json, read by the painting, in the order the parts were placed."""
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector
    out = []
    for it in CFG["items"]:
        m = it.get("mark")
        if not m: continue
        x, y = m["at"]; c = world_to_camera_view(bpy.context.scene, bpy.context.scene.camera, Vector((x, y, G(x, y) + m["z"])))
        out.append({"x": c.x * RW, "y": (1 - c.y) * RH, "rise": m["rise"], "hero": bool(it.get("hero")), "depth": c.z})
    json.dump({"w": RW, "h": RH, "marks": out}, open(os.path.join(OUT, "marks.json"), "w"))


def render(sc, name):
    sc.render.filepath = os.path.join(OUT, name); t = time.time(); bpy.ops.render.render(write_still=True); return round(time.time() - t, 1)


STROKES, CUR = [], {"ls": None}


def hook_freestyle():
    import freestyle.types as T
    import parameter_editor as pe

    class Dump(T.StrokeShader):
        def shade(self, stroke):
            pts = []
            for sv in stroke:
                p = sv.point; th = sv.attribute.thickness; q = sv.point_3d
                pts.append((round(p.x, 2), round(p.y, 2), round(th[0] + th[1], 2), round(q.x, 2), round(q.y, 2), round(q.z, 2)))
            STROKES.append({"ls": CUR["ls"], "pts": pts})

    class Ops:
        def __getattr__(self, n): return getattr(T.Operators, n)
        @staticmethod
        def create(pred, shaders): T.Operators.create(pred, list(shaders) + [Dump()])

    orig = pe.process
    def process(layer_name, lineset_name): CUR["ls"] = lineset_name; return orig(layer_name, lineset_name)
    pe.Operators = Ops(); pe.process = process


def main():
    t0 = time.time(); bpy.ops.wm.read_factory_settings(use_empty=True)
    meshes = build_world(); colls, objs = to_blender(meshes); camera()
    sc = bpy.context.scene; sc.render.engine = "BLENDER_WORKBENCH"; sc.render.resolution_x, sc.render.resolution_y = RW, RH; sc.render.resolution_percentage = 100
    sc.view_settings.view_transform = "Standard"; sc.view_settings.look = "None"; sc.world = bpy.data.worlds.new("w"); sc.world.color = (1, 1, 1)
    sc.render.image_settings.file_format = "PNG"; sc.render.image_settings.color_mode = "RGB"
    focus_pixel(); mark_pixels(); secs = {}
    sh = sc.display.shading; sh.light = "STUDIO"; sh.color_type = "SINGLE"; sh.single_color = (1, 1, 1); sh.show_shadows = True; sh.shadow_intensity = 0.6
    sh.show_object_outline = False; sh.show_cavity = False; sc.display.render_aa = "8"; sc.render.use_freestyle = False; sc.display.light_direction = (0.55, -0.35, -0.75)
    secs["shade"] = render(sc, "shade.png")
    sh.light = "FLAT"; sh.color_type = "OBJECT"; sh.show_shadows = False; sc.display.render_aa = "OFF"
    for ob in objs: ob.color = (*GROUP_ID[ob["grp"]], 1.0)
    srgb = lambda c: 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
    json.dump({k: [round(srgb(c) * 255) for c in v] for k, v in GROUP_ID.items()}, open(os.path.join(OUT, "ids.json"), "w"))
    secs["ids"] = render(sc, "ids.png")
    sh.color_type = "SINGLE"; sh.single_color = (1, 1, 1); sc.display.render_aa = "8"; sc.render.use_freestyle = True; sc.render.line_thickness_mode = "ABSOLUTE"; sc.render.line_thickness = 1.0
    vl = bpy.context.view_layer; vl.use_freestyle = True; fs = vl.freestyle_settings; fs.crease_angle = math.radians(118)
    for ls in list(fs.linesets): fs.linesets.remove(ls)
    def lineset(name, coll, sil, crease, th):
        ls = fs.linesets.new(name); ls.select_by_collection = True; ls.collection = coll; ls.select_silhouette = sil; ls.select_border = sil; ls.select_crease = crease
        ls.select_by_visibility = True; ls.visibility = "VISIBLE"; ls.select_by_edge_types = True; ls.select_external_contour = False; ls.select_contour = False
        st = bpy.data.linestyles.new(name); ls.linestyle = st; st.color = (0, 0, 0); st.thickness = th
    lineset("hero_out", colls["hero"], True, False, 6.0); lineset("hero_in", colls["hero"], False, True, 3.0); lineset("bg", colls["objs"], True, True, 1.4)
    lineset("terrain", colls["terrain"], True, False, 1.4); lineset("coal", colls["coal"], True, True, 1.0)
    hook_freestyle(); secs["lines"] = render(sc, "lines")
    json.dump({"w": RW, "h": RH, "strokes": STROKES}, open(os.path.join(OUT, "strokes.json"), "w"))
    secs["total_incl_build"] = round(time.time() - t0, 1); json.dump(secs, open(os.path.join(OUT, "seconds.json"), "w"))
    json.dump([[m.name, m.group, len(m.v), len(m.f)] for m in meshes], open(os.path.join(OUT, "parts.json"), "w")); print("RENDER_SECONDS", secs)


main()
