"""How tall the drawn units stand in the picture, from the scene alone (no Blender): the placed unit meshes (parts.py) are carried through the
scene's own camera (loc, target, lens, the 36 mm sensor and the render aspect of scene_node.camera) onto the 1440x560 frame. Used by the tests
and the registry's size floor (node.json topics.size_floor), not by the painting."""
import math
import parts as P
import world as Wd


def _norm(v):
    n = math.sqrt(sum(a * a for a in v)) or 1.0
    return tuple(a / n for a in v)


def _cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def _dot(a, b): return sum(x * y for x, y in zip(a, b))


def projector(camera, w, h, view_h):
    """A function (x, y, z) -> (px_x, px_y) on the frame that is view_h pixels high, the way scene_node.camera frames the scene."""
    loc, tgt, lens = camera["loc"], camera["target"], camera["lens"]
    f = _norm(tuple(t - l for t, l in zip(tgt, loc))); right = _norm(_cross(f, (0, 0, 1))); up = _cross(right, f); k = lens / 36.0

    def proj(x, y, z):
        d = (x - loc[0], y - loc[1], z - loc[2]); zc = _dot(d, f)
        nx = 0.5 + k * _dot(d, right) / zc; ny = 0.5 + k * _dot(d, up) / zc * (w / h)
        return nx * view_h * w / h, (1 - ny) * view_h
    return proj


def unit_extent(scene, view_h=560.0, view_w=None):
    """(top, bottom, left, right) in frame pixels of all the placed units together (items that carry a lit flag: lit and unlit), their meshes
    projected, the ground under each from the world's height times the scene's relief; None when no unit is placed."""
    mx = -1.0 if scene.get("mirror") else 1.0; relief = scene.get("relief", 1.0)
    proj = projector(scene["camera"], scene["w"], scene["h"], view_h)
    ys, xs = [], []
    for it in scene["items"]:
        if it.get("kind") != "at_ground" or "lit" not in it.get("args", {}): continue
        x, y = it["at"]; z0 = relief * Wd.height(mx * x, y) + it.get("dz", -0.3)
        for m in getattr(P, it["fn"])(**it["args"]):
            if m.group in ("shadow",): continue
            for vx, vy, vz in m.v:
                px, py = proj(vx + x, vy + y, vz + z0); xs.append(px); ys.append(py)
    return (min(ys), max(ys), min(xs), max(xs)) if ys else None


def unit_height_fraction(scene, view_h=560.0):
    """The units' bounding-box height over the picture's height."""
    e = unit_extent(scene, view_h)
    return 0.0 if e is None else (e[1] - e[0]) / view_h


def depth_of(camera, x, y, z=0.0):
    """How far a ground point lies in front of the camera along its viewing axis (the perspective scale of an object there is 1 / this)."""
    loc, tgt = camera["loc"], camera["target"]; fw = _norm(tuple(t - l for t, l in zip(tgt, loc)))
    return _dot((x - loc[0], y - loc[1], z - loc[2]), fw)
