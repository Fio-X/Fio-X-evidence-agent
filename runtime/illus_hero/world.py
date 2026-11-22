"""The q1 world as plain functions (no bpy): terrain height and the layout numbers. Units are metres-ish; +y is away from the camera."""
import math

DAM_Y = 205.0
DX = -38.0  # the dam and its valley sit left of the middle; wind and pylons take the right
MOUNTS = [(-64, 222, 68, 40, 70), (66, 230, 72, 40, 70), (0, 300, 78, 150, 38), (-150, 150, 30, 40, 60), (150, 140, 26, 45, 60)]  # x, y, amp, sx, sy
RIDGE = (10, 95, 15, 130, 22)  # the low ridge that carries the turbines
FLAT = (-60, 34, 58, 32)       # cx, cy, hx, hy: the levelled field under the solar array


def g(x, y, cx, cy, a, sx, sy): return a * math.exp(-((x - cx) / sx) ** 2 - ((y - cy) / sy) ** 2)


def height(x, y):
    h = 3.0 + 0.045 * (y + 40) + 2.0 * math.sin(x / 31 + 0.7) * math.cos(y / 27) + 1.2 * math.sin(x / 13 - y / 17)
    h += g(x, y, *RIDGE)
    mt = 0.0
    for m in MOUNTS: mt += g(x - DX, y, *m)
    h += mt
    crag = min(1.0, mt / 25.0)   # crags only on the mountains
    h += crag * (5.0 * math.sin(x / 7.0 + 1.0) * math.sin(y / 9.0) + 3.5 * math.sin(x / 4.3 + y / 5.1) + 2.5 * math.sin(x / 2.9 - y / 3.7))
    # the river valley below the dam: a shallow channel along x ~ 0 that widens towards the camera
    if y < DAM_Y + 8:
        w = 12 + 0.12 * (DAM_Y - y); cut = 9.0 * math.exp(-((x - DX - 4 * math.sin(y / 38)) / w) ** 2) * min(1.0, (DAM_Y + 8 - y) / 12) * max(0.0, 1 - (DAM_Y - y) / 170)
        h -= cut
    # levelled solar field
    fx, fy, hx, hy = FLAT
    m = max(0.0, 1 - max(abs(x - fx) / hx, abs(y - fy) / hy) ** 4)
    return h * (1 - m) + (4.2 + 0.02 * y) * m


def smooth(x, y, k=2): return height(x, y)
