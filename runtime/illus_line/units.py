"""The five unit pictograms of the line hero: wind turbine, dam (a cross-section: lake, stepped wall with a crest road, spill, pool), solar panel,
pylon and biomass pile. Each is drawn in the unit's own coordinates (x right, y up, both in fractions of its height h, the origin on the ground at
the unit's centre) from the proportions of line.json. A lit unit takes the page accent as its body fill (the one accent colour), an unlit one the pale paper; the lines are the ink
either way. Every point that is drawn also widens the unit's bounding box, so the geometry the tests read is the drawn geometry."""
import math


class U:
    """One unit being drawn: the pen, the place (cx, gy: the ground point in pixels), the height in pixels, lit or not."""
    def __init__(self, pen, reg, cx, gy, h, lit, acc, seed_i, woh=None, fn=None):
        self.woh = woh
        self.pen = pen; self.reg = reg; self.cx = cx; self.gy = gy; self.h = h; self.lit = lit; self.acc = acc; self.i = seed_i
        self.parts = []; self.box = [1e9, 1e9, -1e9, -1e9]
        lo, hi, k = reg["pen"]["main"]; self.w = min(max(h * k, lo), hi); self.wd = self.w * reg["pen"]["detail"]
        self.paper = "unit"; self.shift = reg["colour"]["fill_shift"] if lit else (0.0, 0.0)

    def P(self, x, y): return (self.cx + x * self.h, self.gy - y * self.h)
    def pts(self, fr): return [self.P(x, y) for x, y in fr]

    def seen(self, pts):
        for x, y in pts:
            b = self.box; b[0] = min(b[0], x); b[1] = min(b[1], y); b[2] = max(b[2], x); b[3] = max(b[3], y)

    def body(self, fr, role="body", ring=True, w=None):
        """A closed shape: its fill (accent if the unit is lit and the role is body, else paper) and its ink ring."""
        p = self.pts(fr); self.seen(p); fill = self.acc if (role == "body" and self.lit) else self.paper
        self.parts.append(self.pen.fill_path(p, fill, self.shift if fill == self.acc else (0.0, 0.0)))
        if ring: self.parts.append(self.pen.ring(p, w or self.w))

    def stroke(self, fr, w=None, alpha=1.0, amp=None):
        p = self.pts(fr); self.seen(p); self.parts.append(self.pen.line(p, w or self.w, alpha, amp))

    def hatch(self, fr, angle, gap):
        p = self.pts(fr); self.parts.append(self.pen.hatch(p, angle, gap * max(1.0, 0.012 * self.h / 1.2) , self.reg["pen"]["hatch_w"], self.reg["colour"]["hatch_alpha"]))

    def disc(self, cx, cy, r, role="body", n=14, ring=True, w=None):
        self.body([(cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)) for k in range(n)], role, ring, w)

    def arc(self, cx, cy, rx, ry, a0, a1, w=None, n=10):
        self.stroke([(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * k / n)), cy + ry * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)], w or self.wd)

    def wave(self, x0, x1, y, amp, n, w=None, per=8):
        m = max(2, n) * per; self.stroke([(x0 + (x1 - x0) * k / m, y + amp * math.sin(2 * math.pi * k / per)) for k in range(m + 1)], w or self.wd, amp=0.12)


def ground_tuft(u, x, s=0.03):
    u.stroke([(x - s, 0), (x - s * 0.4, s * 1.4)], u.wd); u.stroke([(x, 0), (x + s * 0.2, s * 1.8)], u.wd); u.stroke([(x + s, 0), (x + s * 0.5, s * 1.2)], u.wd)


def turbine(u, S):
    hub, L, bw = S["hub"], S["blade"], S["blade_w"]; tb, tt = S["tower_base"], S["tower_top"]
    u.body([(-tb, 0), (tb, 0), (tt, hub), (-tt, hub)])
    u.hatch([(tb * 0.1, 0), (tb, 0), (tt, hub), (tt * 0.1, hub)], 62, 4.0)
    u.body([(-tb * 2.2, 0), (tb * 2.2, 0), (tb * 1.6, 0.012), (-tb * 1.6, 0.012)], role="plain", w=u.wd)
    u.body([(-0.045, hub - 0.018), (0.035, hub - 0.018), (0.035, hub + 0.020), (-0.045, hub + 0.020)], w=u.w)
    ph = S["phases"][u.i % len(S["phases"])]
    for k in range(3):
        a = math.radians(90 + ph + 120 * k); dx, dy = math.cos(a), math.sin(a); nx, ny = -dy, dx; q = []
        prof = [(0.0, bw * 0.35), (0.18, bw * 0.8), (0.34, bw), (0.6, bw * 0.62), (0.85, bw * 0.28), (1.0, 0.0)]
        side1 = [(dx * L * t + nx * wv, hub + dy * L * t + ny * wv) for t, wv in prof]
        side2 = [(dx * L * t - nx * wv, hub + dy * L * t - ny * wv) for t, wv in prof[::-1]]
        u.body(side1 + side2[1:], w=u.w)
    u.disc(0.0, hub, 0.022, "plain")
    for x in (-tb * 3.4, tb * 3.0): ground_tuft(u, x, 0.025)


def solar(u, S):
    pt, wt, wb, lt, fr = S["panel_top"], S["panel_w_top"], S["panel_w_bot"], S["leg_top"], S["frame"]
    for x in (-0.5 * wb, 0.5 * wb):
        u.stroke([(x * 0.8, lt), (x * 0.95, 0.0)], u.w * 1.1)
    u.stroke([(-wb * 0.55, 0.0), (wb * 0.55, 0.0)], u.wd)
    u.stroke([(-wb * 0.3, 0.12), (wb * 0.3, 0.12)], u.wd)
    quad = [(-wb, lt), (wb, lt), (wt, pt), (-wt, pt)]
    u.body([(-wb, lt - fr), (wb, lt - fr), (wb, lt), (-wb, lt)], role="plain")
    u.body(quad)
    cols, rows = S["cols"], S["rows"]
    for c in range(1, cols):
        t = c / cols; u.stroke([(-wb + 2 * wb * t, lt), (-wt + 2 * wt * t, pt)], u.wd)
    for r in range(1, rows):
        t = r / rows; y = lt + (pt - lt) * t; xw = wb + (wt - wb) * t; u.stroke([(-xw, y), (xw, y)], u.wd)
    u.hatch([(-wb, lt), (-wb * 0.4, lt), (-wt * 0.4, pt), (-wt, pt)], 70, 4.5)


def pylon(u, S):
    bw, tw = S["base_w"], S["top_w"]; arms = S["arms"]; aw = S["arm_w"]; top = 1.0
    half = lambda y: bw + (tw - bw) * y / top
    u.stroke([(-bw, 0), (-tw, top)], u.w); u.stroke([(bw, 0), (tw, top)], u.w)
    u.stroke([(-tw, top), (0, top + 0.05)], u.wd * 1.2); u.stroke([(tw, top), (0, top + 0.05)], u.wd * 1.2)
    n = S["braces"]; ys = [0.02 + (arms[0] - 0.02) * k / n for k in range(n + 1)]
    for a, b in zip(ys, ys[1:]):
        u.stroke([(-half(a), a), (half(b), b)], u.wd * 1.2); u.stroke([(half(a), a), (-half(b), b)], u.wd * 1.2)
        u.stroke([(-half(b), b), (half(b), b)], u.wd * 1.2)
    for a, b in zip([arms[0], arms[1]], [arms[1], arms[2]]):
        u.stroke([(-half(a), a), (half(b), b)], u.wd * 1.2); u.stroke([(half(a), a), (-half(b), b)], u.wd * 1.2)
    for y, w in zip(arms, aw):
        u.stroke([(-w, y), (w, y)], u.w * 0.9)
        for sgn in (-1, 1):
            x = sgn * w; u.stroke([(x, y), (x, y - 0.045)], u.wd); u.disc(x, y - 0.062, 0.017, "body", n=8, ring=True, w=u.wd)
            e = sgn * 0.5 * 1.0; ex, ey = sgn * 0.26, y - 0.115
            u.stroke([(x, y - 0.08), (x + sgn * 0.08, y - 0.125), (ex, ey)], u.wd, amp=0.2)
    u.body([(-bw * 1.5, 0), (bw * 1.5, 0), (bw * 1.25, 0.018), (-bw * 1.25, 0.018)], role="plain", w=u.wd)
    # the lit body of a pylon is its lattice: fill the middle bay with the accent as a tall triangle behind the braces
    if u.lit:
        u.parts.insert(0, u.pen.fill_path(u.pts([(-bw, 0), (bw, 0), (tw, top), (-tw, top)]), u.acc, u.shift))


def biomass(u, S):
    rows = S["rows"]; ld = S["log_d"]; n = len(rows)
    d = 1.0 / (n * 0.866 + 0.134 + ld); r = d / 2; y0 = r
    pile_w = max(rows) * d
    # the pile's end-on logs, bottom row first; a row of two sits between the three of the row below
    for ri, cnt in enumerate(rows):
        y = y0 + ri * d * 0.866
        for k in range(cnt):
            x = (k - (cnt - 1) / 2) * d
            u.disc(x, y, r * 0.96, n=14)
            if r * u.h > S.get("ring_min", 7):
                for q in range(1, S["rings"] + 1):
                    rr = r * 0.96 * (1 - q / (S["rings"] + 1)) * 0.9; u.arc(x, y, rr, rr, 20 + 40 * q, 330 - 20 * q, u.wd)
                u.stroke([(x, y), (x + r * 0.5, y + r * 0.28)], u.wd * 0.8)
    # the side-on logs lie across the top: a rounded box with the end ring on its right side and bark ticks
    ytop = y0 + (n - 1) * d * 0.866 + r * 0.96 + ld * d * 0.5
    ln = S["log_len"] * d; k = S["top_logs"]
    for j in range(k):
        x0 = (j - (k - 1) / 2) * ln * 0.98 - ln / 2 + (ln * 0.0); x1 = x0 + ln; hh = ld * d * 0.5
        u.body([(x0, ytop - hh), (x1, ytop - hh), (x1 + hh * 0.35, ytop - hh * 0.5), (x1 + hh * 0.35, ytop + hh * 0.5), (x1, ytop + hh), (x0, ytop + hh), (x0 - hh * 0.2, ytop + hh * 0.4), (x0 - hh * 0.2, ytop - hh * 0.4)])
        u.arc(x1 + hh * 0.05, ytop, hh * 0.28, hh * 0.65, 0, 360, u.wd)
        for t in (0.25, 0.5, 0.75): u.stroke([(x0 + ln * t, ytop + hh * 0.25), (x0 + ln * t + hh * 0.5, ytop + hh * 0.35)], u.wd * 0.9, amp=0.2)
    u.stroke([(-pile_w * 0.5, 0.0), (pile_w * 0.5, 0.0)], u.wd)


def dam(u, S):
    """A cross-section of a concrete dam seen from the side: the lake on the left (hatched water, wave lines on its surface), the wall with a sloped back face,
    block joints and a road with a railing and a lamp along its crest, water leaping over the crest in arcs into a pool on the right. The wall is the lit body."""
    x_l = -0.5 * (u.woh or S["w_over_h"]); x_r = -x_l; W = x_r - x_l
    up = x_l + S["lake"] * W; base = S["wall_base"] * W; cw = S["crest_w"] * W
    ch = S["crest_h"]; wl = S["water_level"]
    u.stroke([(x_l, wl + 0.08), (x_l + 0.05, wl + 0.05), (x_l + 0.10, wl + 0.01), (x_l + 0.20, 0.45), (up - 0.16, 0.14), (up, 0.0)], u.wd, amp=0.4)
    u.hatch([(x_l + 0.11, wl), (up, wl), (up, 0.0), (up - 0.16, 0.0), (x_l + 0.23, 0.36)], 0, 3.4)
    for k, y in enumerate((wl, wl - 0.07, wl - 0.14)):
        x0 = x_l + 0.09 + 0.04 * k; u.wave(x0, up, y, 0.012, max(3, int((up - x0) / 0.07)), u.wd * 1.2)
    xb0 = up; xt0 = up + 0.015; xt1 = xt0 + cw; xb1 = xb0 + base
    u.body([(xb0, 0.0), (xt0, ch), (xt1, ch), (xb1, 0.0)])
    for k in range(1, 5):
        y = ch * k / 5; u.stroke([(xb0 + (xt0 - xb0) * y / ch + 0.012, y), (xb1 + (xt1 - xb1) * y / ch - 0.012, y)], u.wd, alpha=0.8, amp=0.3)
    u.hatch([(xb0 + 0.03, 0.02), (xt0 + 0.015, ch - 0.05), (xt1, ch - 0.06), (xt1 + (xb1 - xt1) * 0.4, 0.02)], 72, 4.6)
    ry = ch + 0.03
    u.body([(xt0 - 0.025, ch), (xt1 + 0.025, ch), (xt1 + 0.025, ry), (xt0 - 0.025, ry)], role="plain", w=u.wd * 1.3)
    for t in (0.0, 0.5, 1.0): u.stroke([(xt0 + (xt1 - xt0) * t, ry), (xt0 + (xt1 - xt0) * t, ry + 0.04)], u.wd)
    u.stroke([(xt0, ry + 0.04), (xt1, ry + 0.04)], u.wd)
    u.stroke([(xt0 + 0.01, ry), (xt0 + 0.01, ry + 0.13), (xt0 - 0.03, ry + 0.145)], u.wd * 1.2)
    # the spill: arcs of water leaving the crest on the downstream side and falling into the pool, with splash waves where they land
    x0 = xt1 + 0.01; y0 = ch - 0.015
    for k, (land, wt) in enumerate(((0.10, 1.5), (0.17, 1.1), (0.23, 0.9))):
        xe = xb1 + land; pts = [(x0 + (xe - x0) * (i / 16.0), y0 * (1 - (i / 16.0) ** 2.2) + 0.01) for i in range(17)]
        u.stroke(pts, u.wd * wt, amp=0.25)
    for k, y in enumerate((0.012, 0.045, 0.078)):
        u.wave(xb1 + 0.03 + 0.03 * k, x_r - 0.01, y, 0.011, max(2, int((x_r - xb1) / 0.06)), u.wd, per=8)
    u.stroke([(x_l - 0.02, 0.0), (x_r + 0.02, 0.0)], u.w)
    u.seen([u.P(x_l, 0)]); u.seen([u.P(x_r, 0)])


DRAW = {"turbine_unit": turbine, "solar_unit": solar, "pylon_unit": pylon, "biomass_unit": biomass, "dam_unit": dam}
