"""The pen of the line hero (pure Python, no numpy): wobbly ink strokes with a tapering width, a pale paper fill, light hatching.
Same language as the hero's brush (runtime/illus_hero/brush.py: stroke, ring_strokes, hatch) and the page-bottom strip's rough hand,
written without numpy so it runs in the plain interpreter. Seeded: the same seed draws the same picture. All numbers come from line.json (pen)."""
import json
import math
import os
import random

COL = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "line.json")))["colour"]
ACC = "acc"          # the fill name of the accent: the lit units' bodies and the mark


def _f(v): return f"{v:.1f}"


class Pen:
    def __init__(self, seed, P, ink):
        self.r = random.Random(seed); self.P = P; self.ink = ink

    def noise(self, amp):
        """A smooth noise over the arc length s: a few slow sines with random phases."""
        lo, hi = self.P["wave"]; comps = [(self.r.uniform(lo, hi) * (k + 1), self.r.uniform(0, 6.283), 1.0 / (k + 1)) for k in range(3)]
        norm = sum(c[2] for c in comps)
        return lambda s: amp * sum(a * math.sin(s * f + ph) for f, ph, a in comps) / norm

    @staticmethod
    def resample(pts, step):
        out = [pts[0]]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            d = math.hypot(x1 - x0, y1 - y0); n = max(1, int(d / step))
            for i in range(1, n + 1): out.append((x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n))
        return out

    def wobble(self, pts, amp=None):
        """The polyline resampled and pushed along its normals by the smooth noise (the hand is never straight)."""
        amp = self.P["wobble"] if amp is None else amp
        p = self.resample(pts, self.P["step"])
        if len(p) < 2 or amp <= 0: return p
        nz = self.noise(amp); s = 0.0; out = []
        for i, (x, y) in enumerate(p):
            a = p[max(i - 1, 0)]; b = p[min(i + 1, len(p) - 1)]
            dx, dy = b[0] - a[0], b[1] - a[1]; ln = math.hypot(dx, dy) or 1.0
            if i: s += math.hypot(x - p[i - 1][0], y - p[i - 1][1])
            n = nz(s); out.append((x - dy / ln * n, y + dx / ln * n))
        return out

    def ink_path(self, pts, w, t_in=0.15, t_out=0.25, floor=0.45):
        """A filled outline whose width follows a pressure profile (taper in, taper out, a slow swell)."""
        n = len(pts)
        if n < 2: return ""
        sw = self.noise(0.18); s = 0.0; L = []; R = []
        for i, (x, y) in enumerate(pts):
            a = pts[max(i - 1, 0)]; b = pts[min(i + 1, n - 1)]
            dx, dy = b[0] - a[0], b[1] - a[1]; ln = math.hypot(dx, dy) or 1.0
            if i: s += math.hypot(x - pts[i - 1][0], y - pts[i - 1][1])
            t = i / (n - 1); prof = max(0.0, min(1.0, min(t / t_in, (1 - t) / t_out))) ** 0.6
            ww = max(w * (floor + (1 - floor) * prof) * (1 + sw(s)), 0.3) / 2
            L.append((x - dy / ln * ww, y + dx / ln * ww)); R.append((x + dy / ln * ww, y - dx / ln * ww))
        q = L + R[::-1]
        return "M" + "L".join(f"{_f(x)},{_f(y)}" for x, y in q) + "Z"

    def line(self, pts, w, alpha=1.0, amp=None):
        p = self.wobble(pts, amp)
        d = self.ink_path(p, w)
        return f'<path d="{d}" fill="{self.ink}"{"" if alpha >= 1 else f" opacity=\"{alpha:.2f}\""}/>' if d else ""

    def ring(self, pts, w):
        """A closed outline drawn as one stroke that overshoots its start, and a fainter second pass from another corner."""
        n = len(pts); k = self.r.randrange(n); q = pts[k:] + pts[:k]; out = []
        a = q + [q[0]]; ov = self.P["overshoot"]
        dx, dy = q[1][0] - q[0][0], q[1][1] - q[0][1]; ln = math.hypot(dx, dy) or 1.0
        a.append((q[0][0] + dx / ln * ov, q[0][1] + dy / ln * ov))
        out.append(self.line(a, w))
        k2 = self.r.randrange(n); q2 = pts[k2:] + pts[:k2]
        out.append(self.line(q2 + [q2[0]], w * 0.6, self.P["second_alpha"], amp=self.P["wobble"] * 1.2))
        return "".join(out)

    def fill_path(self, pts, fill, shift=(0.0, 0.0)):
        """A closed pale or accent shape. fill: ACC (the page accent) or a tint name of line.json (the page paper under it, the ink over it at the
        tint's opacity), so the colours are the page's variables and nothing behind shows through."""
        p = self.wobble(pts + [pts[0]], self.P["wobble"] * 0.8)
        return self.paint("M" + "L".join(f"{_f(x + shift[0])},{_f(y + shift[1])}" for x, y in p) + "Z", fill)

    def paint(self, d, fill):
        if fill == ACC: return f'<path d="{d}" fill="{COL["accent"]}"/>'
        if fill == "ink": return f'<path d="{d}" fill="{self.ink}"/>'
        a = COL["tint"][fill]
        return f'<path d="{d}" fill="{COL["bg"]}"/>' + (f'<path d="{d}" fill="{self.ink}" opacity="{a:.2f}"/>' if a > 0 else "")

    def hatch(self, poly, angle, gap, w, alpha):
        """Parallel strokes clipped to a convex polygon, each a little off in length, angle and gap."""
        n = len(poly); cx = sum(x for x, _ in poly) / n; cy = sum(y for _, y in poly) / n
        R = max(math.hypot(x - cx, y - cy) for x, y in poly) + 4; a = math.radians(angle); dx, dy = math.cos(a), math.sin(a); nx, ny = -dy, dx
        sgn = 1 if sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n)) > 0 else -1
        out = []; o = -R
        while o < R:
            p0 = (cx + nx * o - dx * R, cy + ny * o - dy * R); d = (dx * 2 * R, dy * 2 * R); t0, t1 = 0.0, 1.0; ok = True
            for i in range(n):
                a_, b_ = poly[i], poly[(i + 1) % n]; ex, ey = b_[0] - a_[0], b_[1] - a_[1]
                nxx, nyy = -ey * sgn, ex * sgn                      # the inward normal of this edge
                num = (p0[0] - a_[0]) * nxx + (p0[1] - a_[1]) * nyy; den = d[0] * nxx + d[1] * nyy
                if abs(den) < 1e-9:
                    if num < 0: ok = False; break
                    continue
                t = -num / den
                if den > 0: t0 = max(t0, t)
                else: t1 = min(t1, t)
                if t0 >= t1: ok = False; break
            if ok:
                a0 = (p0[0] + d[0] * t0, p0[1] + d[1] * t0); a1 = (p0[0] + d[0] * t1, p0[1] + d[1] * t1)
                L = math.hypot(a1[0] - a0[0], a1[1] - a0[1])
                if L > 3.0:
                    k0 = self.r.uniform(0.04, 0.2); k1 = self.r.uniform(0.04, 0.2); ux, uy = (a1[0] - a0[0]) / L, (a1[1] - a0[1]) / L
                    b0 = (a0[0] + ux * L * k0, a0[1] + uy * L * k0); b1 = (a1[0] - ux * L * k1, a1[1] - uy * L * k1)
                    out.append(self.line([b0, b1], w * self.r.uniform(0.7, 1.2), alpha, amp=0.25))
            o += gap * (1 + self.r.uniform(-0.25, 0.25))
        return "".join(out)
