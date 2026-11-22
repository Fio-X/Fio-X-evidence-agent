"""Pure-python mesh builder (no bpy, no numpy): parts are built here, tested here, and handed to Blender only at the very end (scene_q1.py).
Z is up, +y points away from the viewer, +x to the right. A Mesh is verts [(x,y,z)], faces [(i,j,k,..)] with outward (CCW) winding, a group name."""
import math


class Mesh:
    def __init__(self, name, group):
        self.name, self.group, self.v, self.f = name, group, [], []
        self.smooth, self.subsurf = False, 0   # smooth shading / subdivision-surface levels, applied in Blender

    def add(self, verts, faces, outward=True):
        """Append a primitive; with outward=True every face is flipped, if needed, to point away from the primitive's centroid (convex-ish solids)."""
        n0 = len(self.v)
        if outward:
            c = [sum(p[i] for p in verts) / len(verts) for i in range(3)]
            fixed = []
            for f in faces:
                nrm = face_normal([verts[i] for i in f]); fc = [sum(verts[i][k] for i in f) / len(f) for k in range(3)]
                d = sum(nrm[k] * (fc[k] - c[k]) for k in range(3))
                fixed.append(tuple(reversed(f)) if d < 0 else tuple(f))
            faces = fixed
        self.v += verts
        self.f += [tuple(i + n0 for i in f) for f in faces]
        return self

    def merge(self, other, rot=None, loc=(0, 0, 0)):
        m = rot or ident()
        self.add([add3(mulv(m, p), loc) for p in other.v], other.f, outward=False)
        return self

    def bounds(self):
        return [(min(p[i] for p in self.v), max(p[i] for p in self.v)) for i in range(3)]


def add3(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def sub3(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def ident(): return ((1, 0, 0), (0, 1, 0), (0, 0, 1))
def mulv(m, p): return tuple(sum(m[r][c] * p[c] for c in range(3)) for r in range(3))
def matmul(a, b): return tuple(tuple(sum(a[r][k] * b[k][c] for k in range(3)) for c in range(3)) for r in range(3))
def rot_z(deg): a = math.radians(deg); c, s = math.cos(a), math.sin(a); return ((c, -s, 0), (s, c, 0), (0, 0, 1))
def rot_y(deg): a = math.radians(deg); c, s = math.cos(a), math.sin(a); return ((c, 0, s), (0, 1, 0), (-s, 0, c))
def rot_x(deg): a = math.radians(deg); c, s = math.cos(a), math.sin(a); return ((1, 0, 0), (0, c, -s), (0, s, c))


def face_normal(pts):
    n = (0.0, 0.0, 0.0)
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        n = (n[0] + (a[1] - b[1]) * (a[2] + b[2]), n[1] + (a[2] - b[2]) * (a[0] + b[0]), n[2] + (a[0] - b[0]) * (a[1] + b[1]))
    ln = math.sqrt(sum(x * x for x in n)) or 1
    return (n[0] / ln, n[1] / ln, n[2] / ln)


def box(center, size, rot=None):
    sx, sy, sz = (s / 2 for s in size)
    v = [(x * sx, y * sy, z * sz) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    if rot: v = [mulv(rot, p) for p in v]
    v = [add3(p, center) for p in v]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    m = Mesh("box", ""); m.add(v, f); return m


def frustum(base, r0, r1, h, n=8, rot=None, rot_phase=0.0):
    """Truncated cone with caps, axis +z from `base` (r1 = 0 gives a cone)."""
    v, f = [], []
    for i in range(n):
        a = 2 * math.pi * i / n + rot_phase; v.append((r0 * math.cos(a), r0 * math.sin(a), 0))
    for i in range(n):
        a = 2 * math.pi * i / n + rot_phase; v.append((r1 * math.cos(a), r1 * math.sin(a), h))
    for i in range(n): f.append((i, (i + 1) % n, n + (i + 1) % n, n + i))
    f.append(tuple(range(n))); f.append(tuple(range(n, 2 * n)))
    if rot: v = [mulv(rot, p) for p in v]
    v = [add3(p, base) for p in v]
    m = Mesh("frustum", ""); m.add(v, f); return m


def loft(rings, close_ends=True):
    """Rings: list of equal-length point lists (each ring ordered around the section). Faces join consecutive rings."""
    n = len(rings[0]); v = [p for r in rings for p in r]; f = []
    for k in range(len(rings) - 1):
        for i in range(n): f.append((k * n + i, k * n + (i + 1) % n, (k + 1) * n + (i + 1) % n, (k + 1) * n + i))
    if close_ends: f.append(tuple(range(n))); f.append(tuple(range((len(rings) - 1) * n, len(rings) * n)))
    m = Mesh("loft", ""); m.add(v, f); return m


def tube(p0, p1, r=0.1, n=4):
    """A thin straight prism from p0 to p1 (bars, wires)."""
    d = sub3(p1, p0); L = math.sqrt(sum(x * x for x in d)) or 1; d = tuple(x / L for x in d)
    ref = (0, 0, 1) if abs(d[2]) < 0.9 else (1, 0, 0)
    u = cross(d, ref); lu = math.sqrt(sum(x * x for x in u)) or 1; u = tuple(x / lu for x in u); w = cross(d, u)
    rings = [[tuple(p[k] + r * (math.cos(2 * math.pi * i / n) * u[k] + math.sin(2 * math.pi * i / n) * w[k]) for k in range(3)) for i in range(n)] for p in (p0, p1)]
    return loft(rings)
