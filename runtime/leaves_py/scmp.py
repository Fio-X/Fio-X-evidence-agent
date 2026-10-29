"""Hero layout (SCMP print-page style): one big picture takes about half
the page, short callouts sit in columns on both sides with leaders to the place they talk about, big numerals
in the margin, one full-width profile strip, then a short row of small modules. Charts come from prod.CHARTS;
numbers only from facts. A page config may name a "base" config whose tables, formats and facts it reuses."""
import json, math, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import column
import facts as FX
import prod
from words import word

SIDE, GUT = 176, 12  # callout column width and the gap between a column and the picture

def load(name):
    spec = json.load(open(os.path.join(FX.D, name)))
    if "base" in spec:
        base = json.load(open(os.path.join(FX.D, spec["base"])))
        for k in ("question", "kicker", "source", "tables", "fmts"): spec.setdefault(k, base[k])
        spec["facts"] = {**base["facts"], **spec.get("facts", {})}
    return spec

def anchor(at, ext):
    """A callout points at a place code from places.json or at an explicit [lon, lat]; off-map sources at the frame edge."""
    return tuple(at) if not isinstance(at, str) else prod.at_edge(prod.PL[at], ext)

def hero(c, h):
    W = 1140; MW = W - 2 * (SIDE + GUT)
    lon0, lat0, lon1, lat1 = h["data"].get("ext", prod.EXT)
    MH = round(MW * (lat1 - lat0) / ((lon1 - lon0) * math.cos(math.radians((lat0 + lat1) / 2 + 2))))  # picture keeps the frame's aspect
    P = prod.proj(MW, MH, (lon0, lat0, lon1, lat1)); ox = SIDE + GUT
    body = prod.CHARTS[h["data"]["chart"]](c, {"labels": False, **h["data"], "avoid": [anchor(n["at"], (lon0, lat0, lon1, lat1)) for n in h["notes"]]}, MW, MH)
    boxes = []
    for n in h["notes"]:
        x, y = P(*anchor(n["at"], (lon0, lat0, lon1, lat1))); x += ox
        side = "I" if n.get("in") else n.get("side") or ("L" if x < ox + MW / 2 else "R")
        ix, iy = P(*n["in"]) if n.get("in") else (0, 0)  # a note set inside the picture, in an empty part of the map
        txt = c.t(n.get("t", "")); head, date = n.get("h", ""), ""
        if "ev" in n:  # an event callout: name and date come from the sourced events table, the body from facts
            r = next(r for r in prod.events({"events": c.spec["events"]}) if r["date"] == n["ev"])
            head = head or r["label_zh"]; date = word("date.ymd", y=int(r["date"][:4]), m=int(r["date"][5:7]), d=int(r["date"][8:10]))
        boxes.append(f'<div class="co {side}{" f" if n.get("f") else ""}" data-ax="{x:.1f}" data-ay="{y:.1f}" data-iy="{iy:.1f}" style="{"left:0" if side == "L" else f"left:{W - SIDE}px" if side == "R" else f"left:{ix + ox:.1f}px"};width:{SIDE - 10 if side == "I" else SIDE}px">'
                     f'<div class="ch">{c.t(head)}</div>{f"<div class=cd>{date}</div>" if date else ""}{f"<div class=ct>{txt}</div>" if txt else ""}</div>')
    unit = f'<div class="hu">{c.t(h["unit"])}</div>' if h.get("unit") else ""
    return (f'<div class="hero" data-mh="{MH}" data-side="{SIDE}" style="height:{MH}px">{unit}<div class="map" style="left:{ox}px;width:{MW}px">{body}</div>'
            f'<svg class="leads" viewBox="0 0 {W} {MH}" width="{W}" height="{MH}"></svg>{"".join(boxes)}</div><script>{STACK}</script>')

def months(a, b):
    y, m, out = int(a[:4]), int(a[5:7]), []
    while f"{y}-{m:02d}" <= b: out.append(f"{y}-{m:02d}"); y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out

class RingFrame:
    """What every ring layer shares: centre, radii (map, calendar track, band start, band limit), the month angles and the
    map's projection in page space. Radii: R0 map edge, RC calendar track, R1 band start, RO band outer limit."""
    def __init__(f, c, h):
        K = lambda k: prod.knob(h, "frame", k)
        f.c, f.h = c, h; f.W, f.R0 = 1140, K("r"); f.DEP = K("depth"); f.GAP0 = K("gap")  # map radius, ring depth, gap left open (degrees)
        f.GD = h.get("_gapdir", GAPDIR.get(K("gap_dir"), -90))  # centre of the gap: top, or a corner the map does not use
        rd = h["ring"]; sum_ = lambda s: {t: sum(v.get(t, 0) for v in s.values()) for t in {t for v in s.values() for t in v}}
        f.one = sum_(prod.series(f.c.T, rd["q"])); f.tot = sum_(prod.series(c.T, rd["total"])) if rd.get("total") else {}
        f.ms = months(rd["from"], rd.get("to", max(f.one))); f.n = len(f.ms)
        f.mx = max([f.one.get(t, 0) for t in f.ms] + [f.tot.get(t, 0) for t in f.ms]) or 1
        f.cx, f.cy = f.W / 2, K("top_room") + f.R0 + f.DEP + 30
        f.RC = f.R0 + 4; f.R1 = f.R0 + K("band_off"); f.RO = f.R1 + f.DEP
        f.ext = tuple(h["data"].get("ext", prod.EXT)); f.S = 2 * f.R0; P = prod.proj(f.S, f.S, f.ext)
        f.P = lambda lo, la: (lambda x, y: (x + f.cx - f.R0, y + f.cy - f.R0))(*P(lo, la))
        f.H = f.cy + f.RO + 40
        notes = {nn["ev"]: nn for nn in h.get("notes", []) if "ev" in nn}
        f.events = [(r, f.t2a(r["date"]), notes.get(r["date"], {})) for r in (prod.events({"events": c.spec["events"], "from": f.ms[0], "to": f.ms[-1] + "-31"}) if c.spec.get("events") else [])]
        f.events = [e for e in f.events if e[1] is not None]
    def ang(f, i): return math.radians(f.GD + f.GAP0 / 2 + (360 - f.GAP0) * i / f.n)  # start of month i
    def pt(f, a, r): return (f.cx + r * math.cos(a), f.cy + r * math.sin(a))
    def t2a(f, d):  # a date inside the ring's months -> angle
        i = f.ms.index(d[:7]) if d[:7] in f.ms else None
        return None if i is None else f.ang(i + (int(d[8:10] or 15) - 1) / 31)

prod.KNOBS["frame"] = dict(r=(300, (160, 400, 5), "map radius (the whole figure scales with it)"), depth=(58, (10, 120, 2), "deepest band"), gap=(24, (0, 90, 2), "gap at the top (degrees)"),
                           top_room=(20, (0, 200, 5), "space above"), band_off=(30, (8, 60, 1), "band distance from the map"),
                           gap_dir=("top", ("top", "auto", "ne", "nw", "se", "sw"), "gap direction (auto = emptiest diagonal of the main map)"),
                           title_in=("off", ("off", "on"), "set the title and legend in the gap corner"), gap_fade=(0.85, (0, 1, 0.05), "map fade on the gap side"), callout_h=(58, (30, 120, 2), "estimated callout height (used to pick the gap)"))
GAPDIR = dict(top=-90, ne=-45, nw=-135, se=45, sw=135)
BACKDROP = {"cities", "names", "inset", "labels_room"}  # background that gives way; data lines and labels do not

def empty_corner(c, h):
    """Where to leave the calendar open: the Long March leaves it open where the map is empty and sets the title, the legend
    and the locator map there. Score per direction = what lies in that outer sector of the map (lines, labels; names and
    cities give way) + how far the callouts would run past the ring when stacked on their sides. 'top' keeps the title above."""
    f = RingFrame(c, h); md = {"labels": False, **h["data"], "round": True, "style": h.get("style", {})}
    m = prod.MapFrame(c, md, f.S, f.S); _, occ = prod.layered(m, prod.MAP_LAYERS, md.get("layers", prod.MAP_ORDER))
    R = f.S / 2; score = {}; per = prod.knob(h, "frame", "callout_h")
    for k, a in GAPDIR.items():
        def inside(x, y):
            dx, dy = x - R, y - R; r = math.hypot(dx, dy); d = (math.degrees(math.atan2(dy, dx)) - a + 180) % 360 - 180
            return r > 0.35 * R and abs(d) < 45
        g = RingFrame(c, {**h, "_gapdir": a}); over = 0
        for side in (1, -1):
            for up in (True, False):
                ys = sorted(g.pt(e[1], g.RO)[1] for e in g.events if (math.cos(e[1]) >= 0) == (side > 0) and (math.sin(e[1]) < 0) == up)
                if ys: over += max(0, len(ys) * per - ((ys[-1] - 0) if up else (g.H - ys[0])))
        score[k] = sum(1 for x, y, *_ in occ.pts if inside(x, y)) + 20 * sum(1 for b in occ.boxes if b[4] not in BACKDROP and inside((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) + over
    return GAPDIR[min(score, key=score.get)]

def rl_map(f, occ):
    """The map, clipped to the circle; its own layers (prod.MAP_LAYERS) are drawn inside it, tagged map.<name> when wrapped."""
    md = f.h["data"]; cx, cy, R0, S = f.cx, f.cy, f.R0, f.S
    kw = {"wrap": (lambda n, s: f'<g data-layer="map.{n}">{s}</g>') if f.wrap else None, "out": f.mapout} if md["chart"] == "flowmap" else {}
    ev = [anchor(nn["at"], f.ext) for _, _, nn in f.events if nn.get("at")]  # where the event wedges land: the inset keeps off them
    body = prod.CHARTS[md["chart"]](f.c, {"labels": False, **md, "round": True, "style": f.h.get("style", {}), "_ret": f.ret, "ev_at": ev, "_gapdir": f.GD if prod.knob(f.h, "frame", "title_in") == "on" else None}, S, S, **kw)
    body = body.replace('<svg viewBox=', f'<svg x="{cx - R0}" y="{cy - R0}" width="{S}" height="{S}" viewBox=', 1).replace(' width="100%"', "", 1)
    fade = ""
    if f.h.get("_title") and prod.knob(f.h, "frame", "gap_fade"):  # the map dissolves where the title stands, as the Long March's does under its headline
        a = math.radians(f.GD); sp = math.radians(f.GAP0 / 2 + 20); r_ = R0 * 1.3
        fade = (f'<defs><filter id="gf" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{R0 * 0.12:.0f}"/></filter></defs>'
                f'<path d="M{cx + R0 * 0.45 * math.cos(a):.1f},{cy + R0 * 0.45 * math.sin(a):.1f} L{cx + r_ * math.cos(a - sp):.1f},{cy + r_ * math.sin(a - sp):.1f} L{cx + r_ * math.cos(a + sp):.1f},{cy + r_ * math.sin(a + sp):.1f}Z" fill="var(--bg)" fill-opacity="{prod.knob(f.h, "frame", "gap_fade")}" filter="url(#gf)"/>')
    edge = (lambda a0, a1: f'<path d="M{cx + R0 * math.cos(a0):.1f},{cy + R0 * math.sin(a0):.1f} A{R0},{R0} 0 1 1 {cx + R0 * math.cos(a1):.1f},{cy + R0 * math.sin(a1):.1f}" fill="none" stroke="#c9c5bd" stroke-width="0.8"/>')(f.ang(0), f.ang(f.n)) if fade else f'<circle cx="{cx}" cy="{cy}" r="{R0}" fill="none" stroke="#c9c5bd" stroke-width="0.8"/>'
    return f'<defs><clipPath id="rc"><circle cx="{cx}" cy="{cy}" r="{R0}"/></clipPath></defs><g clip-path="url(#rc)">{body}{fade}</g>{edge}'

def seg(p, q, n=12): return [(p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n) for j in range(n + 1)]
def rotdeg(a): return (lambda deg: deg + (180 if 90 < deg % 360 < 270 else 0))(math.degrees(a) + 90)  # as rot() turns a text along the circle
def rbox(x, y, w, h, deg, about=None):
    """The upright box of a w×h text turned by deg: anchored at its start (x, y), or centred on (x, y) turned by about."""
    d = math.radians(deg if about is None else about); ca, sa = abs(math.cos(d)), abs(math.sin(d))
    if about is None: x, y = x + w / 2 * math.cos(d), y + w / 2 * math.sin(d)
    hw, hh = (w * ca + h * sa) / 2, (w * sa + h * ca) / 2
    return (x - hw, y - hh, x + hw, y + hh)
def gapped(f, r, boxes, pad=3):
    """An arc of the ring at radius r, open at the gap like the calendar, left out where it would cross any of the boxes."""
    n = 720; on = []
    for j in range(n + 1):
        x, y = f.pt(f.ang(0) + (f.ang(f.n) - f.ang(0)) * j / n, r)
        on.append(not any(b[0] - pad < x < b[2] + pad and b[1] - pad < y < b[3] + pad for b in boxes))
    d, j = "", 0
    while j <= n:
        if not on[j]: j += 1; continue
        k = j
        while k < n and on[k + 1]: k += 1
        if k > j:
            a0, a1 = f.ang(0) + (f.ang(f.n) - f.ang(0)) * j / n, f.ang(0) + (f.ang(f.n) - f.ang(0)) * k / n; (x0, y0), (x1, y1) = f.pt(a0, r), f.pt(a1, r)
            d += f"M{x0:.1f},{y0:.1f} A{r},{r} 0 {1 if a1 - a0 > math.pi else 0} 1 {x1:.1f},{y1:.1f} "
        j = k + 1
    return d.strip()

def rl_ring(f, occ):
    """The calendar ring: faint guides, the stepped band (depth = the month's value), the calendar track, values on the band."""
    c, cx, cy, ms, pt, ang, RC, R1, RO, DEP, mx = f.c, f.cx, f.cy, f.ms, f.pt, f.ang, f.RC, f.R1, f.RO, f.DEP, f.mx; K = lambda k: prod.knob(f.h, "ring", k)
    rot = lambda a, x, y: (lambda deg: f"rotate({deg + (180 if 90 < deg % 360 < 270 else 0):.1f} {x:.1f} {y:.1f})")(math.degrees(a) + 90)  # text along the circle, never upside down
    arc = lambda r: (lambda a0, a1: f'M{pt(a0, r)[0]:.1f},{pt(a0, r)[1]:.1f} A{r},{r} 0 {1 if a1 - a0 > math.pi else 0} 1 {pt(a1, r)[0]:.1f},{pt(a1, r)[1]:.1f}')(ang(0), ang(f.n))
    o = []
    def band(v):  # stepped band: each month an arc at its own depth, steps radial, so the edge reads as a calendar, not a zigzag
        d, prev = "", None
        for i, t in enumerate(ms + [None]):
            if t in v:
                r = R1 + DEP * v[t] / mx; a0, a1 = ang(i), ang(i + 1)
                (x0, y0), (x1, y1) = pt(a0, r), pt(a1, r)
                d += (f"M{pt(a0, R1)[0]:.1f},{pt(a0, R1)[1]:.1f} L" if prev is None else "L") + f"{x0:.1f},{y0:.1f} A{r:.1f},{r:.1f} 0 0 1 {x1:.1f},{y1:.1f} "
                prev = prev if prev is not None else i
            elif prev is not None:  # close the run along the inner edge
                (x0, y0), (x1, y1) = pt(ang(i), R1), pt(ang(prev), R1)
                d += f"L{x0:.1f},{y0:.1f} A{R1},{R1} 0 {1 if ang(i) - ang(prev) > math.pi else 0} 0 {x1:.1f},{y1:.1f}Z "; prev = None
        return d
    o.append(f'<path d="{band(f.one)}" fill="{K("color")}"/>')
    if f.tot:  # the context total as one thin stepped line over the band, not a second fill
        o.append(f'<path d="{band(f.tot)}" fill="none" stroke="var(--t-sec)" stroke-width="0.8" stroke-dasharray="2 2"/>')
    occ.add_line([pt(ang(0) + (ang(f.n) - ang(0)) * j / 720, f.R0) for j in range(721)], "map.edge")  # the map's edge circle
    for i, t in enumerate(ms):  # every tick is claimed before a year is placed; a January tick is its year's own line
        occ.add_line(seg(pt(ang(i), RC), pt(ang(i), RC + (K("tick_year") if t.endswith("-01") else K("tick")))), "ring", f"year:{t[:4]}" if t.endswith("-01") else None)
    for r, a, nn in f.events:  # and the events layer's date ticks and leads (rl_events), drawn above
        occ.add_line(seg(pt(a, RC - 2), pt(a, RC + 14)) + seg(pt(a, RC + 15), pt(a, f.RO + 26), 40), "events")
    for i, t in enumerate(ms):  # calendar inside the band: a tick a month, longer on January, the year written along the track
        a = ang(i); big = t.endswith("-01")
        x0, y0 = pt(a, RC); x1, y1 = pt(a, RC + (K("tick_year") if big else K("tick")))
        on = f' data-line="year:{t[:4]}"' if big else ""  # the year is written on its own January tick (the line rule's data-on)
        o.append(f'<line{on} x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" stroke="var(--t-sec)" stroke-width="{1.1 if big else 0.5}"/>')
        if big:  # beside its tick, clear of the map's edge (RC + 13 touched it); the first spot no other tick, event or edge crosses
            yw, yh = prod.tw(t[:4], K("year_size")), K("year_size") * 1.2
            for da in (1.2, 1.8, 0.7, 2.4, 3.0, 0.2, -0.8, -1.8, -2.8):
                xl, yl = pt(ang(i + da), RC + 18); deg = rotdeg(ang(i + da)); b = rbox(xl, yl, yw, yh, deg)
                if not occ.on_line(b, pad=1.5, own=f"year:{t[:4]}"): break
            o.append(f'<text data-on="year:{t[:4]}" x="{xl:.1f}" y="{yl:.1f}" font-size="{K("year_size")}" font-style="italic" fill="var(--t-sec)" text-anchor="start" dominant-baseline="middle" transform="{rot(ang(i + da), xl, yl)}">{t[:4] if FX.LEDGER is None else FX.entry(f"period:{f.h['ring']['q']['table']}:{t[:4]}", "tspan", None)}</text>')
        if t not in f.one:
            xl, yl = pt(ang(i + 0.5), R1 + 8); o.append(f'<text x="{xl:.1f}" y="{yl:.1f}" font-size="10" fill="var(--t-sec)" text-anchor="middle" dominant-baseline="middle">{word("missing")}</text>')
    knock = [inset_spot(f)[-1]] if inset_spot(f) else []  # the inset (drawn above) is left clear
    for mk in f.h["ring"].get("marks", []):  # values written just outside the band at their month, rotated with it, in ink
        fa = c.F[mk["key"]]; a = f.t2a(fa["t"] + "-15") if fa.get("t") else None
        if a is None: continue
        xl, yl = pt(a, R1 + DEP * fa["v"] / mx + 9); mw, mh = prod.tw(FX.fmt(c.spec, fa, bare=True), K("mark_size")), K("mark_size") * 1.2
        knock.append(rbox(xl + mw / 2 * math.cos(a), yl + mw / 2 * math.sin(a), mw, mh, None, math.degrees(a)))
        o.append(f'<line x1="{pt(a, R1 + DEP * fa["v"] / mx)[0]:.1f}" y1="{pt(a, R1 + DEP * fa["v"] / mx)[1]:.1f}" x2="{pt(a, R1 + DEP * fa["v"] / mx + 4)[0]:.1f}" y2="{pt(a, R1 + DEP * fa["v"] / mx + 4)[1]:.1f}" stroke="var(--t-title)" stroke-width="0.8"/>'
                 f'<text x="{xl:.1f}" y="{yl:.1f}" font-size="{K("mark_size")}" font-weight="700" fill="var(--t-title)" text-anchor="{"start" if math.cos(a) >= 0 else "end"}" dominant-baseline="middle" stroke="var(--bg)" stroke-width="3" paint-order="stroke" transform="rotate({math.degrees(a) + (0 if math.cos(a) >= 0 else 180):.1f} {xl:.1f} {yl:.1f})">{FX.fmt(c.spec, fa, bare=True) if FX.LEDGER is None else FX.entry(f"fact:{mk['key']}.n", "tspan", None)}</text>')
    gd = [f'<path d="{d_}" fill="none" stroke="#dedad3" stroke-width="0.5"/>' for k in range(K("guides")) for d_ in [gapped(f, RO + 6 + 4 * k, knock)] if d_]
    return "".join(gd + o)  # faint guides beyond the band, open at the gap like the calendar, and broken where a value or the inset stands

prod.KNOBS["ring"] = dict(color=("var(--ring, #e6765f)", ("var(--ring, #e6765f)", "#d8452f", "#c9a28e", "#8fa7b8"), "band color"), guides=(3, (0, 8, 1), "number of thin outer guide lines"),
                          tick=(6, (0, 20, 1), "month tick length"), tick_year=(12, (0, 30, 1), "January tick length"), year_size=(10.5, (7, 16, 0.5), "year font size"), mark_size=(11, (8, 18, 0.5), "font size of numbers on the ring"),
                          years=(5, (2, 10, 1), "years of the annual main the page is fetched for, ending at its last year (layer 1 reads it)"),
                          months=(60, (24, 120, 1), "months the ring spans, ending at the monthly twin's last month (layer 1 reads it)"))

def rl_events(f, occ):
    """Each event: a dark tick on the calendar at its date, a pale wedge from there to its place, a dotted lead outwards."""
    o, pt, RC, RO, K = [], f.pt, f.RC, f.RO, lambda k: prod.knob(f.h, "events", k); ww = K("wedge_w")
    for r, a, nn in f.events:
        ox, oy = pt(a, RO + 26)
        o.append(f'<line x1="{pt(a, RC - 2)[0]:.1f}" y1="{pt(a, RC - 2)[1]:.1f}" x2="{pt(a, RC + 14)[0]:.1f}" y2="{pt(a, RC + 14)[1]:.1f}" stroke="var(--t-title)" stroke-width="{K("tick_w")}"/>')
        if nn.get("at"):  # a pale wedge from the date to the place, as the Long March does
            mx_, my_ = f.P(*anchor(nn["at"], f.ext))
            (ax, ay), (bx, by) = pt(a - ww, RC), pt(a + ww, RC)
            o.append(f'<path d="M{ax:.1f},{ay:.1f} L{bx:.1f},{by:.1f} L{mx_:.1f},{my_:.1f}Z" fill="var(--accent)" fill-opacity="{K("wedge_op")}"/><circle cx="{mx_:.1f}" cy="{my_:.1f}" r="2.6" fill="#fff" stroke="var(--accent)" stroke-width="1"/>')
        x0, y0 = pt(a, RC + 15)
        o.append(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{ox:.1f}" y2="{oy:.1f}" stroke="var(--t-title)" stroke-width="0.6" stroke-dasharray="{K("lead")}"/>')
    return "".join(o)
prod.KNOBS["events"] = dict(tick_w=(2, (0, 5, 0.5), "width of the black date line"), wedge_w=(0.012, (0, 0.06, 0.002), "wedge width (radians)"), wedge_op=(0.1, (0, 0.5, 0.02), "wedge opacity"),
                            lead=("1 2", ("1 2", "2 2", "0.6 1.6", "none"), "leader line dash pattern"))

def rl_callouts(f, occ):
    """Dated callouts outside the ring (HTML, stacked in the browser by RING): bar, bold name, italic date, grey body."""
    c, o, K = f.c, [], lambda k: prod.knob(f.h, "callouts", k)
    for r, a, nn in f.events:
        ox, oy = f.pt(a, f.RO + K("out"))
        side = "R" if math.cos(a) >= 0 else "L"; notes = f.h.get("notes", [])
        i = next((i for i, n in enumerate(notes) if n is nn), None)  # a note's wording prints from layer 1's segments, as the dek
        txt = FX.worded(c.spec, c.F, f"notes.{i}", nn["t"]) if nn.get("t") and i is not None else c.t(nn.get("t", ""))
        if FX.LEDGER is None: date = word("date.ymd", y=int(r["date"][:4]), m=int(r["date"][5:7]), d=int(r["date"][8:10]))
        else:  # the date's parts from the ledger, each marked with the record's cell
            p = lambda part: FX.entry(f"{FX.cell_src(r)}:date.{part}", "span", None)
            date = word("date.ymd", y=p("y"), m=p("m"), d=p("d"))
        o.append(f'<div class="rc {side}" data-px="{ox:.1f}" data-py="{oy:.1f}" data-cx="{f.cx}" data-cy="{f.cy}" data-ro="{f.RO + K("clear"):.0f}"><div class="hd"><div class="ch">{prod.esc(nn.get("h") or r["label_zh"])}</div>'
                 f'<div class="cd">{date}</div></div>{f"<div class=ct>{txt}</div>" if txt else ""}</div>')
    css = "".join(rule.format(v=K(k)) for k, rule in CALLOUT_CSS.items() if K(k) != prod.KNOBS["callouts"][k][0])  # only what a page changed
    gap = f'<i hidden class="rcgap" data-g="{K("gap")}"></i>' if K("gap") != prod.KNOBS["callouts"]["gap"][0] else ""
    return (f"<style>{css}</style>" if css else "") + gap + "".join(o)
prod.KNOBS["callouts"] = dict(out=(26, (6, 80, 1), "callout distance from the band"), clear=(22, (0, 60, 1), "minimum callout distance from the ring"), gap=(6, (0, 30, 1), "spacing between stacked callouts"),
                              width=(170, (110, 260, 5), "width"), head=(13, (10, 18, 0.5), "heading font size"), body=(12, (9, 15, 0.5), "body font size"),
                              bar=(2, (0, 5, 0.5), "vertical bar width"), ink=("var(--t-sec)", ("var(--t-sec)", "var(--t-body)", "var(--t-title)"), "body color"))
CALLOUT_CSS = dict(width=".hero.ring .rc{{width:{v}px}}", head=".hero.ring .rc .ch{{font-size:{v}px}}", body=".hero.ring .rc{{font-size:{v}px}}",
                   bar=".hero.ring .rc .hd{{border-width:{v}px}}", ink=".hero.ring .rc .ct{{color:{v}}}")

def rl_legend(f, occ):
    K = lambda k: prod.knob(f.h, "legend", k); css = "".join(r.format(v=K(k)) for k, r in LEGEND_CSS.items() if K(k) != prod.KNOBS["legend"][k][0])
    return (f"<style>{css}</style>" if css else "") + (f'<div class="hu">{FX.worded(f.c.spec, f.c.F, "unit", f.h["unit"])}</div>' if f.h.get("unit") else "")
prod.KNOBS["legend"] = dict(width=(280, (160, 420, 10), "legend width"), size=(12, (9, 15, 0.5), "legend font size"), side=("right", ("right", "left"), "which side"))
LEGEND_CSS = dict(width=".hero.ring .hu{{width:{v}px}}", size=".hero.ring .hu{{font-size:{v}px}}", side=".hero.ring .hu{{right:auto;left:0}}")

def gap_inset(f):
    """The locator inset that stands in the title's column when the title is in the ring's gap: the map at w_in width."""
    md = f.h["data"]; m = prod.MapFrame(f.c, {**md, "round": True, "style": f.h.get("style", {})}, f.S, f.S)
    w = prod.knob(f.h, "inset", "w_in"); g = prod.inset_geom(m, w) if md["chart"] == "flowmap" and prod.knob(f.h, "inset", "show") != "off" else None
    return f'<svg class="ins" width="{w}" height="{g[-1] + 18:.0f}" viewBox="0 -16 {w} {g[-1] + 18:.0f}">{prod.inset_svg(m, g, 0, 0, w)}</svg>' if g else ""

def inset_spot(f):
    """The corner the locator inset takes outside the ring (rl_inset), worked out once: the map below is drawn by then, so
    f.ret says whether it found room for the inset inside; the ring asks first, to leave the inset clear."""
    if hasattr(f, "_ins"): return f._ins
    f._ins = None; md = f.h["data"]
    if f.h.get("_title") or md["chart"] != "flowmap" or prod.knob(f.h, "inset", "show") == "off": return
    if f.ret.get("inset"): return
    m = prod.MapFrame(f.c, {**md, "round": True, "style": f.h.get("style", {})}, f.S, f.S)
    w = prod.knob(f.h, "inset", "width"); g = prod.inset_geom(m, w)
    if not g: return
    quad = {q: sum(1 for _, a, _ in f.events if (math.sin(a) < 0) == (q[0] == "t") and (math.cos(a) < 0) == (q[1] == "l")) for q in ("br", "bl", "tr", "tl")}
    K = lambda k: prod.knob(f.h, "inset", k); corner = K("corner") if K("corner") != "auto" else min(quad, key=quad.get)  # the corner with the fewest callouts
    lg = ("r" if prod.knob(f.h, "legend", "side") == "right" else "l") if f.h.get("unit") else None
    h = g[-1]; x0 = 8 if corner[1] == "l" else f.W - w - 8; y0 = (K("below_legend") if corner[1] == lg else 22) if corner[0] == "t" else f.H - h - 8
    f._ins = (m, g, x0, y0, w, corner, (x0, y0 - 18, x0 + w, y0 + h + 14)); return f._ins

def rl_inset(f, occ):
    """Locator inset in the corner its reserve took (rl_inset_reserve); with the title in the gap it stands in the title's
    column instead (gap_inset), which the page places there."""
    if f.h.get("_title"): return gap_inset(f)
    if not inset_spot(f): return ""
    m, g, x0, y0, w, corner, box = f._ins; occ.add(box, "inset")
    return prod.inset_svg(m, g, x0, y0, w, note_below=corner[0] == "t")

# name -> (draw, reserve); svg layers go into the picture, html layers sit over it
RING_LAYERS = dict(map=(rl_map, None), ring=(rl_ring, None), events=(rl_events, None), callouts=(rl_callouts, None), legend=(rl_legend, None), inset=(rl_inset, None))
RING_SVG = ["map", "ring", "events", "inset"]  # legend and callouts are html over the picture

def ring(c, h, wrap=False, out=None):
    """SCMP Long March hero: a round map inside a calendar ring, every sourced event hung at its date outside the ring.
    Drawn as layers (RING_LAYERS; the map's own MAP_LAYERS inside "map") over one shared frame. wrap tags each layer with
    data-layer for single-layer preview; out receives each layer's drawing so it can be saved and compared on its own."""
    f = RingFrame(c, h); W, H = f.W, f.H; f.wrap, f.mapout = wrap, ({} if out is not None else None); f.ret = {}
    g = (lambda n, s: f'<g data-layer="{n}">{s}</g>') if wrap else None
    dv = (lambda n, s: f'<div data-layer="{n}">{s}</div>') if wrap else None
    pic = [n for n in RING_SVG if not (n == "inset" and h.get("_title"))]  # with the title in the gap the inset stands in its column
    svg, occ = prod.layered(f, RING_LAYERS, pic, g, out)
    lg, _ = prod.layered(f, RING_LAYERS, ["legend"], dv, out)
    co, _ = prod.layered(f, RING_LAYERS, ["callouts"], dv, out)
    if out is not None: out.update({f"map.{k}": v for k, v in f.mapout.items()})
    ins = gap_inset(f) if h.get("_title") else ""
    if ins and out is not None: out["inset"] = ins
    return ring_shell(f, svg, lg, co, ins, wrap)

def ring_shell(f, svg, lg, co, ins, wrap):
    """The ring hero around its drawn layers: the picture's svg, the legend and callouts over it, and with the title in
    the gap the title column (title, standfirst, legend and the inset `ins`) in the open corner."""
    W, H, h = f.W, f.H, f.h
    if h.get("_title"):  # the title, standfirst and legend stand together in the open corner, over the part of the map it does not use
        a = math.radians(f.GD); pos = ("right:0" if math.cos(a) > 0 else "left:0") + (";top:0" if math.sin(a) < 0 else ";bottom:0")
        lg = f'<div class="gapcol {"R" if math.cos(a) > 0 else "L"}" style="{pos}">{h["_title"]}<div class="lgrow">{lg}{ins}</div></div>'
    return (f'<div class="hero ring" data-h="{H:.0f}" style="height:{H:.0f}px">{lg}<svg class="leads" viewBox="0 0 {W} {H:.0f}" width="{W}" height="{H:.0f}">{svg}</svg>'
            f'<svg class="ll"{' data-layer="callouts"' if wrap else ""} viewBox="0 0 {W} {H:.0f}" width="{W}" height="{H:.0f}"></svg>{co}</div><script>{RING}</script>')

# Ring callouts: each sits just outside its date, on the outer side; per side, boxes above the ring's middle are pushed up and
# boxes below it pushed down (away from the middle, where the ring is widest), so none slides back over the ring.
RING = """(()=>{const h=document.currentScript.previousElementSibling,svg=h.querySelector('.ll');let out='',H=+h.dataset.h,T=0;const G=+((h.querySelector('.rcgap')||{dataset:{g:6}}).dataset.g);
for(const side of['L','R'])for(const up of[true,false]){const bs=[...h.querySelectorAll('.rc.'+side)].filter(b=>(+b.dataset.py<+b.dataset.cy)==up).sort((a,b)=>up?b.dataset.py-a.dataset.py:a.dataset.py-b.dataset.py);let lim=up?1e9:-1e9;
 for(const b of bs){const w=b.offsetWidth,hh=b.offsetHeight,px=+b.dataset.px,py=+b.dataset.py;let y=py-8;if(up)y=Math.min(y,lim-hh-G);else y=Math.max(y,lim+G);b.style.top=y+'px';
  const cx=+b.dataset.cx,cy=+b.dataset.cy,ro=+b.dataset.ro,dy=Math.max(0,Math.max(y,Math.min(cy,y+hh))-cy,cy-Math.min(y+hh,Math.max(cy,y))),hw=dy<ro?Math.sqrt(ro*ro-dy*dy):0;
  const x=side=='R'?Math.max(px+4,cx+hw):Math.min(px-w-4,cx-hw-w);b.style.left=x+'px';lim=up?y:y+hh;T=Math.min(T,y);H=Math.max(H,y+hh+10);
  const bx=side=='R'?x-2:x+w+2,by=y+9;if(Math.abs(by-py)>1||Math.abs(bx-px)>1)out+=`<path d="M${px},${py} L${bx},${by}" fill="none" stroke="var(--t-title)" stroke-width="0.6" stroke-dasharray="1 2"/>`;}}
if(T<0){for(const e of h.querySelectorAll('.rc'))e.style.top=(parseFloat(e.style.top)-T)+'px';for(const s of h.querySelectorAll('svg'))s.style.top=(-T)+'px';H-=T;}
h.style.height=H+'px';svg.innerHTML=out;})();"""

# Callouts are stacked in the browser so real text heights are used: each column in anchor order, a box starts
# level with its anchor or below the previous box; if a column runs past the picture it is moved up; then leaders.
STACK = """(()=>{const h=document.currentScript.previousElementSibling,W=h.offsetWidth,S=+h.dataset.side,svg=h.querySelector('.leads');
const lead=(x0,y0,x1,y1)=>{const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=Math.sign(x1-x0),sy=Math.sign(y1-y0);  // newspaper leader: level, then one 45° run into the point
 const m=dx>dy?`H${x1-sx*dy}`:`L${x0+sx*dx},${y1-sy*dx}`;  // too steep for that: 45° first, then straight up or down
 return `<path d="M${x0},${y0} ${m} L${x1},${y1}" fill="none" stroke="#8f8b84" stroke-width="0.7"/><circle cx="${x1}" cy="${y1}" r="2.4" fill="#fff" stroke="var(--t-title)" stroke-width="1"/>`;};
let H=+h.dataset.mh,top0=(h.querySelector('.hu')||{offsetHeight:0}).offsetHeight,out='';
for(const side of['L','R']){const bs=[...h.querySelectorAll('.co.'+side)].sort((a,b)=>a.dataset.ay-b.dataset.ay);let t=side=='L'?top0:0;
 for(const b of bs){const y=Math.max(t,b.dataset.ay-11);b.style.top=y+'px';t=y+b.offsetHeight+7;}
 const over=t-7-H;if(over>0){const room=bs.length?parseFloat(bs[0].style.top)-(side=='L'?top0:0):0;const up=Math.min(over,room);for(const b of bs)b.style.top=(parseFloat(b.style.top)-up)+'px';H=Math.max(H,t-7-up);}
 for(const b of bs){const ey=parseFloat(b.style.top)+10,ex=side=='L'?S+2:W-S-2,el=ex+(side=='L'?10:-10);
  out+=lead(ex,ey,+b.dataset.ax,+b.dataset.ay);}}
const grp={};for(const b of h.querySelectorAll('.co.I')){const k=b.style.left+'|'+b.dataset.iy;let t=grp[k]??+b.dataset.iy;b.style.top=t+'px';grp[k]=t+b.offsetHeight+9;
 const L=parseFloat(b.style.left),T=parseFloat(b.style.top),ax=+b.dataset.ax,ay=+b.dataset.ay,sx=ax<L?L-3:Math.min(Math.max(ax,L),L+b.offsetWidth),sy=ax<L?T+10:T+b.offsetHeight+2;
 out+=lead(sx,sy,ax,ay);}
h.style.height=H+'px';svg.setAttribute('height',H);svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.innerHTML=out;})();"""

def page(spec, wrap=False, out=None):
    spec["fmts"]["bcm0"] = {"scale": 0.01, "dec": 0}
    c = prod.Ctx(spec)
    nums = "".join(f'<div class="bn"><div class="bv">{c.t(b["v"])}</div><div class="bl">{c.t(b["l"])}</div></div>' for b in spec.get("bignums", []))
    sec = lambda m, W: (f'<div class="sh"><span class="no">{m["name"]}</span>{c.t(m["h"])}</div>' if m.get("h") else "") + prod.CHARTS[m["data"]["chart"]](c, {"events": spec.get("events"), **m["data"]}, W)
    top = f'<section class="tl">{sec(spec["top"], 1140)}</section>' if spec.get("top") else ""
    band = f'<section class="band">{sec(spec["band"], 1140)}</section>' if spec.get("band") else ""
    st = spec.get("strip")
    strip = "" if not st else (f'<section class="strip"><div class="sh"><span class="no">{st["name"]}</span>{c.t(st["h"])}</div>'
             f'{prod.CHARTS[st["data"]["chart"]](c, {"events": spec.get("events"), **st["data"]}, 1140, st.get("H", 230))}{f"<div class=note>{prod.esc(st.get("note", ""))}</div>" if st.get("note") else ""}</section>')
    row = "".join(f'<section class="sm" style="grid-column:span {m["cols"]}"><div class="sh"><span class="no">{m["name"]}</span>{c.t(m["h"])}</div>'
                  f'{prod.CHARTS[m["data"]["chart"]](c, m["data"], prod.width(f"1 / 1 / 2 / {1 + m["cols"]}"))}</section>' for m in spec.get("row", []))
    head = page_head(c, spec, nums)
    hero_ = spec["hero"]
    if "ring" in hero_ and prod.knob(hero_, "frame", "gap_dir") == "auto": hero_ = {**hero_, "_gapdir": empty_corner(c, hero_)}
    tin = title_in(hero_)
    return shell(c, spec, top + ("" if tin else head) + (ring(c, {**hero_, "_title": head} if tin else hero_, wrap, out) if "ring" in hero_ else hero(c, hero_)) + band + strip + (f"<div class=row>{row}</div>" if row else ""))

def page_head(c, spec, nums="", box=None):
    """The page's header: kicker, title, standfirst and the big numbers beside them (`box`: their box as a layer drew it)."""
    box = box if box is not None else f"<div class=bns>{nums}</div>" if nums else ""
    return (f'<header class="hh{" lb" if box and box.startswith("<div data-layer=") else "" if box else " solo"}"><div><div class="kicker">{prod.esc(spec["kicker"])}</div><h1>{c.t(spec["title"])}</h1><p class="dek">{FX.worded(spec, c.F, "dek", spec["dek"])}</p></div>'
            f'{box}</header>')

def title_in(hero_):
    """The title stands in the ring's open corner, unless the corner is at the top (then it stays above)."""
    return "ring" in hero_ and prod.knob(hero_, "frame", "title_in") == "on" and hero_.get("_gapdir", GAPDIR.get(prod.knob(hero_, "frame", "gap_dir"))) != -90

def shell(c, spec, body, more=""):
    """The whole page around its sections: styles (`more` after the page's own), the end line and the footer with the sources."""
    css = open(os.path.join(FX.D, "tokens.css")).read() + ":root{--accent:#d8452f;--accent2:#6b6b6b;--bar:#d6d6d6;--bg:#f8f6f3}" + prod.CSS + CSS + more
    return (f'<!doctype html><html lang="zh"><meta charset="utf-8"><title>{word("page.title")}</title><style>{css}</style><body><div class="pg">'
            f'{body}{f"<p class=end>{c.t(spec["end"])}</p>" if spec.get("end") else ""}'
            f'{footer(spec)}</div></body></html>')

def footer(spec):
    """The sources. With a ledger (a leaf's page) each table id of the source that spec.refs names is a data-ref mark, each
    event source the entry of the first record that names it, and the events file's path is not printed; a digit left
    outside the marks, in the source or the note, refuses."""
    note = prod.esc(spec.get("note", ""))
    if FX.LEDGER is None:
        evsrc = word("list.sep").join(sorted({r["source_name"] for r in prod.events({"events": spec["events"]})})) if spec.get("events") else ""
        return f'<footer>{word("footer.source", v=prod.esc(spec["source"]))}{word("footer.events", v=prod.esc(evsrc), f=prod.esc(spec["events"])) if evsrc else ""}{note}</footer>'
    src, refs = prod.esc(spec["source"]), sorted(spec.get("refs") or [], key=len, reverse=True)
    if refs: src = re.sub(r"(?<![\w.])(" + "|".join(map(re.escape, refs)) + r")(?![\w.])", r'<span data-ref="">\1</span>', src)
    if FX.digit(re.sub(r'<span data-ref="">[^<]*</span>', "", src)): raise FX.Refused("footer: the source holds a digit outside the table ids spec.refs names")
    if FX.digit(note): raise FX.Refused("footer: the note holds a digit")
    first = {}
    for r in prod.events({"events": spec["events"]}) if spec.get("events") else []: first.setdefault(r["source_name"], r)
    ev = word("list.sep").join(FX.entry(f"{FX.cell_src(first[n])}:source_name", "span", None) for n in sorted(first))
    return f'<footer>{word("footer.source", v=src)}{word("footer.events.rows", v=ev) if ev else ""}{note}</footer>'

CSS = """body{background:var(--bg)}
.hh{display:grid;grid-template-columns:1fr 330px;gap:40px;max-width:none;align-items:end;margin-bottom:18px}
.hh h1{font:900 58px/70px var(--serif);color:var(--t-title);margin:6px 0 12px}.hh h1 b.n{color:var(--accent)}
.hh .dek{font:400 16px/27px var(--serif);color:var(--t-dek);max-width:720px;margin:0}
.bns{display:grid;grid-template-columns:1fr 1fr;gap:18px 24px;border-left:1px solid var(--t-sec);padding-left:22px}
.bv{font:300 46px/52px var(--serif);color:var(--t-title);white-space:nowrap}.bv small{font-size:18px;margin-left:4px}.bv b.n{font-weight:300;color:var(--accent)}
.bl{font:400 12px/17px var(--sans);color:var(--t-sec)}.bl b.n{color:var(--t-sec);font-weight:400}.bns .bl span{color:var(--t-title)}
.hh.lb{grid-template-columns:1fr auto}
.hero{position:relative;width:1140px;margin:8px 0 30px}.hu{position:absolute;left:0;top:0;width:240px;z-index:2;font:400 12px/17px var(--sans);color:var(--t-sec);padding-bottom:10px}.hero .map{position:absolute;top:0}
.leads{position:absolute;left:0;top:0;pointer-events:none}
.co{position:absolute;font:400 12px/16px var(--sans);color:var(--t-body)}.co.R{text-align:left}.co.I{background:rgba(255,255,255,.88);padding:2px 4px}
.ch{font:700 13px/19px var(--sans);color:var(--t-title)}.co b.n{color:var(--t-title);font-weight:700}.co.f b.n,.co.f .ch{color:var(--accent)}
.cd{font:italic 400 12px/16px var(--sans);color:var(--t-sec)}.tl{margin:0 0 26px}.tl .sh,.band .sh{font-size:14px}.band{margin:0 0 30px}
.hh.solo{grid-template-columns:1fr 520px;gap:48px}.hh.solo .dek{font-size:15px;line-height:25px}
.sh{font:600 16px/24px var(--sans);color:var(--t-title);margin-bottom:8px}.sh .no{color:var(--accent);margin-right:10px;font-weight:700}
.strip{margin-bottom:30px}.row{display:grid;grid-template-columns:repeat(12,1fr);gap:30px;align-items:start}
.hero.ring .hu{width:280px;left:auto;right:0}.gapcol{position:absolute;width:430px;z-index:2}.gapcol.R{text-align:right}.gapcol .hh{display:block;margin:0 0 14px}.gapcol .hh h1{font-size:50px;line-height:58px}
.gapcol .dek{font-size:14px;line-height:22px}.gapcol .hu{position:static;width:auto;max-width:220px;text-align:left}
.gapcol .lgrow{display:flex;gap:16px;align-items:flex-start}.gapcol.R .lgrow{justify-content:flex-end}.rc{position:absolute;width:170px;font:400 12px/16px var(--sans);color:var(--t-body)}.rc.L{text-align:right}.rc .hd{border-left:2px solid var(--t-title);padding-left:6px;margin-bottom:3px}.rc.L .hd{border-left:0;border-right:2px solid var(--t-title);padding:0 6px 0 0}
.rc .ct{color:var(--t-sec)}.rc b.n{color:var(--t-title)}.rc .cd{font-weight:600}
.row .inote b.n{color:var(--accent)}.end{font:600 20px/34px var(--serif);color:var(--t-title);margin:30px 0 0;max-width:900px}"""

class SquareFrame:
    """What the scmp page's layers share (knobs.py RECIPES scmp): the hero's map frame as hero() lays it out (the picture
    between the two note columns, its height from the map's extent, its projection), the notes the request lists, and the
    strip under the hero. One panel holds both pictures, the strip below the hero (SY), so layer 1 checks every text of
    either against the others. An scmp page prints from a ledger only."""
    def __init__(f, c, h):
        if FX.LEDGER is None: raise FX.Refused("scmp: the page prints from a ledger only")
        f.c, f.h, f.d = c, h, h["data"]
        f.W = 1140; f.MW = f.W - 2 * (SIDE + GUT); f.ox = SIDE + GUT
        if not f.d.get("ext"): raise FX.Refused("scmp: the request gives the map no extent (hero.data.ext)")
        f.ext = tuple(f.d["ext"]); lon0, lat0, lon1, lat1 = f.ext
        f.MH = round(f.MW * (lat1 - lat0) / ((lon1 - lon0) * math.cos(math.radians((lat0 + lat1) / 2 + 2))))  # as hero()
        f.P = prod.proj(f.MW, f.MH, f.ext)
        f.notes = h.get("notes") or []
        f.st = h.get("strip"); f.SH = prod.knob(h, "strip", "height") if f.st else 0
        f.SY = f.MH + prod.knob(h, "strip", "gap") if f.st else f.MH
        f.H = f.SY + f.SH
        f.wrap, f.mapout = True, {}  # the map's own layers always tagged map.<name>: the bake's line rule reads the base map by it

    def anchor(f, n):
        """A note's point on the page: its place (places.json, off-map ones at the frame edge) or the hub, projected."""
        at = f.d["hub"] if n.get("hub") else anchor(n["code"], f.ext)
        x, y = prod.inside_box(*f.P(*at), f.MW, f.MH)  # where the map's line for it starts (MapFrame.at on a square picture)
        return x + f.ox, y

def sq_map(f, occ):
    """The flow map in the hero's frame (prod.flowmap, its own layers inside, tagged map.<name> when wrapped), keeping clear of
    the notes' points as hero() does."""
    kw = {"wrap": (lambda n, s: f'<g data-layer="map.{n}">{s}</g>') if f.wrap else None, "out": f.mapout}
    avoid = [tuple(f.d["hub"]) if n.get("hub") else anchor(n["code"], f.ext) for n in f.notes]
    body = prod.CHARTS[f.d["chart"]](f.c, {"labels": False, **f.d, "square": True, "avoid": avoid, "style": f.h.get("style", {})}, f.MW, f.MH, **kw)
    return body.replace('<svg viewBox=', f'<svg x="{f.ox}" y="0" width="{f.MW}" height="{f.MH}" viewBox=', 1).replace(' width="100%"', "", 1).replace(' role="img"', "", 1)

def sq_notes(f, occ):
    """One short note per place the request lists (hero.notes, made by the program, never written by hand): its name and its
    two years' values, then by how much it changed (from a value above 0 only) and its share at the later year; the hub's
    note its total. Words from the word table, numbers each a ledger entry; stacked in the browser by STACK, leaders to
    the point."""
    c, d, o = f.c, f.d, []
    yr = FX.entry(f"period:{d['q']['table']}:{d['t1']}", "span", None)
    for n in f.notes:
        x, y = f.anchor(n)
        name = prod.hub_named(d) if n.get("hub") else html_named(n["code"])
        head = word("scmp.note.total" if n.get("hub") else "scmp.note.h", name=name, a=FX.entry(f"fact:{n['a']}.n"), b=FX.entry(f"fact:{n['b']}.n"))
        body = []
        if n.get("ch"):  # the fall, rise or flat word by the change's own sign (column.trend); flat prints no number
            tr = column.trend(c, n["ch"]); body.append(word("scmp.note" + tr) if tr == ".flat" else word("scmp.note" + tr, v=c.t("{" + n["ch"] + "}")))
        if n.get("share"): body.append(word("scmp.note.share", y=yr, v=c.t("{" + n["share"] + "}")))
        txt = word("list.sep").join(body)
        side = "L" if x < f.ox + f.MW / 2 else "R"
        o.append(f'<div class="co {side}{" f" if n.get("f") else ""}" data-ax="{x:.1f}" data-ay="{y:.1f}" data-iy="0" style="{"left:0" if side == "L" else f"left:{f.W - SIDE}px"};width:{SIDE}px">'
                 f'<div class="ch">{head}</div>{f"<div class=ct>{txt}</div>" if txt else ""}</div>')
    return "".join(o)

def html_named(code):
    """A place's name in html, marked with its name row (as prod.named marks it in svg)."""
    return f'<span data-src="{prod.esc(prod.name_src(code))}">{prod.esc(prod.NAME(code))}</span>'

def sq_strip(f, occ):
    """The strip under the hero: one place's months as a profile (prod.profile), its marks the facts hero.strip names, each
    written from the word table with its numbers as ledger entries; drawn in the panel below the hero (SY)."""
    st = f.st
    if not st: return ""
    marks = [{"key": m["key"], "l": word(m["word"], t="{" + m["key"] + ".t}", v="{" + m["key"] + ".n}")} for m in st["marks"]]
    body = prod.CHARTS["profile"](f.c, {**st, "marks": marks}, f.W, f.SH)
    return body.replace('<svg viewBox=', f'<svg x="0" y="{f.SY}" width="{f.W}" height="{f.SH}" viewBox=', 1).replace(' width="100%"', "", 1).replace(' role="img"', "", 1)

prod.KNOBS["strip"] = dict(height=(230, (160, 320, 10), "strip height"), gap=(80, (40, 160, 10), "room between the hero and the strip (its heading)"),
                           months=(48, (24, 120, 1), "most months the strip spans, ending at the page window's last month (layer 1 reads it)"))

def sq_bignums(f, occ):
    """The big numbers beside the title: the items hero.data.bignums lists (column.bignum_cells), drawn as the column page draws them."""
    return column.cl_bignums(f, occ)

# name -> (draw, reserve); svg layers go into the pictures, html layers sit in the page around them
SCMP_LAYERS = dict(map=(sq_map, None), strip=(sq_strip, None), bignums=(sq_bignums, None), notes=(sq_notes, None))
SCMP_SVG = ["map", "strip"]

def scmp_shell(f, pic, notes, unit):
    """The scmp hero around its drawn map and notes (as hero() lays them out: the picture between the note columns, the notes
    stacked by STACK with leaders), the unit line over the left column."""
    u = f'<div class="hu">{unit}</div>' if unit else ""
    return (f'<div class="hero scmp" data-mh="{f.MH}" data-side="{SIDE}" style="height:{f.MH}px">{u}'
            f'<svg class="pic" viewBox="0 0 {f.W} {f.MH}" width="{f.W}" height="{f.MH}">{pic}</svg>'
            f'<svg class="leads" viewBox="0 0 {f.W} {f.MH}" width="{f.W}" height="{f.MH}"></svg>{notes}</div><script>{STACK}</script>')

def strip_shell(f, strip):
    """The strip's section: its heading (the place's name from the word table), then its svg, whose view starts at SY so the
    layer's panel coordinates land in it."""
    head = word("scmp.strip.h", name=html_named(f.st["q"]["filter"][f.st["q"]["by"]]))
    one = {t for v in prod.series(f.c.T, f.st["q"]).values() for t in v if f.st["from"] <= t <= f.st.get("to", "9999")}
    if one and any(t not in one for t in months(min(one), max(one))): head += f'<span class="gapw">{word("scmp.strip.gap")}</span>'  # the profile's dashed months
    return (f'<section class="strip"><div class="sh"><span class="no">{word("scmp.strip.no")}</span>{head}</div>'
            f'<svg class="prof" viewBox="0 {f.SY} {f.W} {f.SH}" width="{f.W}" height="{f.SH}">{strip}</svg></section>')

SCMP_CSS = """.hero.scmp .pic{position:absolute;left:0;top:0}.hero.scmp .hu{width:{side}px}.strip .gapw{font:400 12px/17px var(--sans);color:var(--t-sec);margin-left:14px}""".replace("{side}", str(SIDE))

# Single-layer preview (page.layers.html?only=routes,names): layers not named are hidden; a name shows its sub-layers
# ("map" shows map.*) and its parent ("map.routes" keeps the map's clip and outline).
ONLY = """(()=>{const q=new URLSearchParams(location.search).get('only');if(!q)return;const k=q.split(',').flatMap(x=>x.includes('.')?[x]:[x,'map.'+x]);
for(const e of document.querySelectorAll('[data-layer]')){const n=e.dataset.layer;
 if(!k.some(x=>x==n||n.startsWith(x+'.')||x.startsWith(n+'.')))e.style.display='none';}})();"""

def save_layers(stem, out):
    """Each layer's drawing to layers/<stem>/, with a sha256 manifest; returns the layers that changed since the last save."""
    import hashlib
    d = os.path.join(FX.D, "layers", os.path.basename(stem)); os.makedirs(d, exist_ok=True); mf = os.path.join(d, "manifest.json")
    old = json.load(open(mf)) if os.path.exists(mf) else {}
    new = {n: hashlib.sha256(v.encode()).hexdigest() for n, v in out.items()}
    for n, v in out.items(): open(os.path.join(d, n + (".html" if n in ("callouts", "legend") else ".svg")), "w").write(v)
    json.dump(new, open(mf, "w"), indent=1)
    return [n for n in new if old.get(n) != new[n]] + [n + " (gone)" for n in old if n not in new]

if __name__ == "__main__":
    name = sys.argv[1]; stem = name.replace(".json", "")
    open(os.path.join(FX.D, stem + ".html"), "w").write(page(load(name)))
    if "--layers" in sys.argv:  # also save each layer and write the tagged preview page
        out = {}; html = page(load(name), True, out)
        open(os.path.join(FX.D, stem + ".layers.html"), "w").write(html.replace("</body>", f"<script>{ONLY}</script></body>", 1))
        print("changed layers:", ", ".join(save_layers(stem, out)) or "none")
