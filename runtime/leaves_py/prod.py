"""Step 4 (production): fill the sketch's grid with real charts. One chart function per module kind (registry);
data comes from declared queries over the tables, numbers from facts.py. No topic-specific code: names and
points come from places.json, line art from illus.py."""
import csv, html, json, math, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import facts as FX
import geo, illus
from words import word

PL = json.load(open(os.path.join(FX.D, "places.json")))
NAMES = {}  # code -> name, from the request's labels (run.py sets them); places.json gives points only
def NAME(c):
    """A place's name from the request's labels; a code the labels do not name refuses the layer."""
    if c not in NAMES: raise FX.Refused(f"the request labels no name for {c}")
    return NAMES[c]
geo_name = NAME
def need(d, k):
    """A module's topic word (a unit, a name, a year) the request must give: none refuses the layer. A unit is the
    caption as the chart prints it, as given (the request writes any lead such as the unit word itself)."""
    if not d.get(k): raise FX.Refused(f"the module names no {k}")
    return d[k]
def hub_name(d):
    """The map's hub name: a knob layer 1 fills from the labels; none refuses the layer."""
    if not d.get("hub_name"): raise FX.Refused("map: the map names no hub_name")
    return d["hub_name"]
def name_src(c):
    """The name row a place's name is read from, as layer 1 reads the labels (next_run leaf_labels): iso2 for a two-letter
    code, else iso3; LABEL_SRC (src/next_ledger.rs) first."""
    return f"name:zh_names:{'iso2' if len(c) == 2 else 'iso3'}:{c}"
def named(c):
    """A place's name as printed, escaped: with a ledger in a tspan marked with its name row (name_src), so layer 1 reads
    where every name on the panel comes from; without one the bare name."""
    return esc(NAME(c)) if FX.LEDGER is None else f'<tspan data-src="{esc(name_src(c))}">{esc(NAME(c))}</tspan>'
def hub_named(d):
    """The hub name as printed: with a ledger it must be the label of the hub the map's rows are read at (q.filter.geo),
    and is marked with that name row; without one the bare name."""
    nm = hub_name(d)
    if FX.LEDGER is None: return esc(nm)
    c = ((d.get("q") or {}).get("filter") or {}).get("geo")
    if not c or NAMES.get(c) != nm: raise FX.Refused(f"map: the hub name {nm!r} is not the label of the map's hub {c}")
    return named(c)
COLW, GAP = 1140 / 12 - 30 * 11 / 12, 30  # 12-column grid of the 1140px content box

def esc(s): return html.escape(str(s))
def is_place(k): return k in PL and len(PL[k]) > 1  # aggregates such as "not specified" have a name but no point

def ranked(ser, d, t0, t1):
    """The sources a map or slope draws. A list in d["top"] is the ranking the request made (Rust ranks once), kept as given;
    a code in it with no map point refuses. A count (the hand pages) takes the places by the larger of their t0 and t1 values."""
    top = d["top"]
    if isinstance(top, list):
        off = [k for k in top if not is_place(k)]
        if off: raise FX.Refused(f"top: {', '.join(off)} has no map point")
        return list(top)
    return sorted([k for k in ser if is_place(k)], key=lambda k: -max(ser[k].get(t0, 0), ser[k].get(t1, 0)))[:top]

def series(T, q):
    """{by-value: {time: value}} for a declared query; not_eu drops EU members and the TOTAL row of the by-dimension."""
    out = {}
    for r in FX._rows(T, q):
        k = r[q["by"]] if q.get("by") else "_"
        if q.get("not_eu") and (k in FX.members() or k == "TOTAL"): continue
        out.setdefault(k, {})[r["TIME_PERIOD"]] = float(r["OBS_VALUE"])
    return out

class Ctx:
    def __init__(s, spec):
        s.spec, s.T = spec, FX.load(spec); s.F = FX.compute(spec, s.T)
    def n(s, v, key="bcm"):  # format a raw value with one of the page's formats
        return FX.fmt(s.spec, {"v": v, "fmt": key})
    def t(s, text): return FX.fill(s.spec, s.F, text)

def at_edge(pl, ext):
    """Point of a place; an off-map source ('edge' in places.json) enters where its line to the frame centre crosses the frame."""
    lo, la = pl[1], pl[2]
    if len(pl) > 3 and not (ext[0] <= lo <= ext[2] and ext[1] <= la <= ext[3]):
        cx, cy = (ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2; t = 1.0
        for v, c_, lo_, hi_ in ((lo, cx, ext[0], ext[2]), (la, cy, ext[1], ext[3])):
            if v < lo_: t = min(t, (c_ - lo_) / (c_ - v))
            if v > hi_: t = min(t, (hi_ - c_) / (v - c_))
        lo, la = cx + (lo - cx) * t, cy + (la - cy) * t
    return lo, la

def inside_box(x, y, W, H, e=16):
    """A point outside a W x H picture moved along its line to the centre until it is e inside the frame, as a round picture
    pulls a source in to just inside its circle: the line still leaves towards the place, and nothing is drawn past the frame."""
    cx, cy = W / 2, H / 2; t = 1.0
    for v, c_, hi in ((x, cx, W), (y, cy, H)):
        if v < e: t = min(t, (c_ - e) / (c_ - v))
        if v > hi - e: t = min(t, (hi - e - c_) / (v - c_))
    return cx + (x - cx) * t, cy + (y - cy) * t

EXT = (-42, 20, 60, 72)  # lon0, lat0, lon1, lat1 of the Europe-and-neighbours frame
def proj(W, H, ext=EXT):
    """Equirectangular projection at mid-latitude scale; shared by the map and any layout that points at places on it."""
    lon0, lat0, lon1, lat1 = ext; k = math.cos(math.radians((lat0 + lat1) / 2 + 2))
    s = min(W / ((lon1 - lon0) * k), H / (lat1 - lat0))
    return lambda lo, la: ((lo - lon0) * k * s, (lat1 - la) * s)

# ---------- charts ----------
# ---------- layered pictures ----------
# A complex picture is a stack of layers, as in an image editor: each layer is one function that draws one kind of thing
# (base map, routes, names, flows, labels, legend) on a shared frame, so one layer can be redone and checked alone.
# Layers that place text register the boxes it takes in a shared occupancy table; layers above read it and keep clear.
# Reservations (room a higher layer will need) are made before anything is drawn.
# Node knobs: node -> {knob: (default, choices or (lo, hi, step), what it does)}. A page overrides any of them under
# "style": {node: {knob: value}}; the preview (nodes.py) builds its sliders and menus from this table.
KNOBS = {}
def knob(cfg, node, k):  # style first; nodes in LEGACY also read the older top-level config key of the same name
    st = cfg.get("style", {}).get(node, {})
    return st[k] if k in st else cfg[k] if node in LEGACY and k in cfg else KNOBS[node][k][0]
LEGACY = {"base", "frame"}
def inset_note(v):
    """The inset's caption for its note knob; a value the knob does not list refuses the layer."""
    if v not in KNOBS["inset"]["note"][1]: raise FX.Refused(f"inset: note {v!r} is not one of {', '.join(KNOBS['inset']['note'][1])}")
    return word("inset.note." + v)
def halo_words(d):
    """What the two halo colours mean; the default names the default fall and rise colours, and a focus on the default
    colours names its country, so a module that sets a colour must give its own words."""
    if d.get("words"): return d["words"]
    # a focus on the default colours (accent against ink) is named by the request's label for its code
    if d.get("focus") and not any(k in d for k in ("fall", "rise", "other")): return word("halo.focus", name=named(d["focus"]))
    if any(k in d for k in ("fall", "rise", "focus", "other")): raise FX.Refused("map legend: the module sets its colours but gives no words for them")
    return word("halo.words")

def tw(s, size): return sum(size if ord(ch) > 0x2e7f else 0.58 * size for ch in s)  # rough text width: CJK full, Latin about half

class Occ:
    """Occupancy table shared by the layers of one picture: boxes (labels) and points sampled along lines, each with its layer."""
    def __init__(s): s.boxes, s.pts = [], []
    def add(s, b, layer): s.boxes.append((*b, layer))
    def add_line(s, pts, layer, tag=None): s.pts += [(x, y, layer, tag) for x, y in pts]  # tag: whose line it is
    def hit(s, b, pad=(0, 0), only=None, but=()):
        px, py = pad
        return any(b[0] < q[2] + px and b[2] > q[0] - px and b[1] < q[3] + py and b[3] > q[1] - py for q in s.boxes if (only is None or q[4] in only) and q[4] not in but)
    def on_line(s, b, pad=1, only=None, rot=None, own=None):
        """A line point inside the box; rot = (cx, cy, w, h, deg) tests the turned text box itself instead of its bounds."""
        if rot:
            cx, cy, w, h, deg = rot; ca, sa = math.cos(math.radians(deg)), math.sin(math.radians(deg))
            return any(abs((x - cx) * ca + (y - cy) * sa) < w / 2 + pad and abs(-(x - cx) * sa + (y - cy) * ca) < h / 2 + pad for x, y, l, t in s.pts if (only is None or l in only) and (own is None or t != own))
        return any(b[0] - pad < x < b[2] + pad and b[1] - pad < y < b[3] + pad for x, y, l, t in s.pts if (only is None or l in only) and (own is None or t != own))

def place(m, occ, x, y, w, h, gap, order=("R", "L", "U", "D"), but=(), own=None):
    """A free box for a w×h label beside the point (x, y): tries the sides in order; free = can be seen, touches no box
    (except layers in but) and no line. Returns (box, side) or (None, None)."""
    at = dict(R=(x + gap, y - h / 2, x + gap + w, y + h / 2), L=(x - gap - w, y - h / 2, x - gap, y + h / 2),
              U=(x - w / 2, y - gap - h, x + w / 2, y - gap), D=(x - w / 2, y + gap, x + w / 2, y + gap + h),
              UL=(x - gap - w, y - gap - h, x - gap, y - gap), UR=(x + gap, y - gap - h, x + gap + w, y - gap),
              DL=(x - gap - w, y + gap, x - gap, y + gap + h), DR=(x + gap, y + gap, x + gap + w, y + gap + h))
    for sd in order:
        b = at[sd]
        if m.inside(b) and not occ.hit(b, pad=(2, 1), but=but) and not occ.on_line(b, pad=1, own=own): return b, sd
    return None, None

class MapFrame:
    """What every map layer shares: the projection, the ranked sources, member outlines, the hub, line widths and colours."""
    def __init__(m, c, d, W, H):
        m.c, m.d, m.W, m.H = c, d, W, H
        m.ser = series(c.T, d["q"]); m.t0, m.t1 = d["t0"], d["t1"]; m.fk = d.get("fmt", "bcm")
        m.top = ranked(m.ser, d, m.t0, m.t1)
        m.ext = tuple(d.get("ext", EXT)); m.P = proj(W, H, m.ext)
        fs, own = geo.features(); member = {i: k for k, i in own.items()}; m.land, m.mrings = [], []  # member outlines in picture space, where lines may stop at the border
        lon0, lat0, lon1, lat1 = m.ext; P = m.P
        for i, f in enumerate(fs):
            d_ = []
            for poly in geo._rings(f["geometry"]):
                for ring in poly:
                    if not any(lon0 - 8 < x < lon1 + 8 and lat0 - 8 < y < lat1 + 8 for x, y in ring): continue
                    d_.append("M" + "L".join(f"{P(x, y)[0]:.1f},{P(x, y)[1]:.1f}" for x, y in ring) + "Z")
                    if i in member: m.mrings.append([P(x, y) for x, y in ring])
            if d_: m.land.append(("".join(d_), i in member))
        m.hx, m.hy = P(*d["hub"])
        m.claims = [((x - 5, y - 5, x + 5, y + 5), "events") for x, y in (P(*p) for p in d.get("ev_at", []))]  # event points the picture above draws here
        m.routes = [r for r in FX.records(d["routes"]) if r["partner"] in m.top] if d.get("routes") else []
        m.routed = {r["partner"] for r in m.routes}  # a source with routes is drawn by them instead of by a flow line
        m.rgeo = [(r, cr(P, r["points"])) for r in m.routes]
        m.mx = max(max(v.values()) for k_, v in m.ser.items() if k_ in m.top) or 1
        m.bund, m.bp = bundles(m)
    def off(m, k):  # the source lies outside the picture and is drawn from where it enters
        pl = PL[k]; return len(pl) > 3 and not (m.ext[0] <= pl[1] <= m.ext[2] and m.ext[1] <= pl[2] <= m.ext[3])
    def at(m, k):  # off-map sources sit at the frame edge; on a round picture, just inside the circle; a bundle shares one point
        if k in getattr(m, "bp", {}): return m.bp[k]
        x, y = m.P(*at_edge(PL[k], m.ext))
        if not m.d.get("round"): return inside_box(x, y, m.W, m.H) if m.d.get("square") else (x, y)
        cx, cy, R = m.W / 2, m.H / 2, min(m.W, m.H) / 2 - 16; r = math.dist((x, y), (cx, cy))
        return (x, y) if r <= R else (cx + (x - cx) * R / r, cy + (y - cy) * R / r)
    def inside(m, b, e=4):  # the box can be seen: inside the frame, and inside the circle when the picture is round
        if b[0] < e or b[1] < e or b[2] > m.W - e or b[3] > m.H - e: return False
        R = min(m.W, m.H) / 2 - e
        return not m.d.get("round") or all(math.dist((x, y), (m.W / 2, m.H / 2)) < R for x in (b[0], b[2]) for y in (b[1], b[3]))
    def wid(m, v): return max(1.2, m.d.get("wmax", 34) * v / m.mx)
    def col(m, k):
        d = m.d; a, b = m.ser[k].get(m.t0, 0), m.ser[k].get(m.t1, 0)
        return (("var(--accent)" if k == d["focus"] else d.get("other", "var(--t-title)")) if d.get("focus")  # one protagonist in the accent, the rest in ink
                else d.get("fall", "var(--accent)") if b < a else d.get("rise", "var(--accent2)"))
    def terms(m):
        if not m.d.get("terminals"): return []
        return [m.P(float(r["lon"]), float(r["lat"])) for r in FX.records(m.d["terminals"])]
    def order(m): return sorted(m.top, key=lambda k_: -m.ser[k_].get(m.t0, 0))

def ml_base(m, occ):
    d, W, H, K = m.d, m.W, m.H, lambda k: knob(m.d, "base", k); fd = K("fade")
    o = [f'<circle cx="{W / 2}" cy="{H / 2}" r="{min(W, H) / 2}" fill="{K("sea")}"/>' if d.get("round") else f'<rect width="{W}" height="{H}" fill="{K("sea")}"/>']  # a round picture shows only the sea inside its circle
    if fd:
        o.append(f'<defs><filter id="fb"><feGaussianBlur stdDeviation="{fd / 2}"/></filter><mask id="fm"><rect x="{fd}" y="{fd}" width="{W - 2 * fd}" height="{H - 2 * fd}" fill="#fff" filter="url(#fb)"/></mask></defs><g mask="url(#fm)">')
    for p, mem in m.land: o.append(f'<path d="{p}" fill="{K("member") if mem else K("land")}" stroke="{K("border")}" stroke-width="{K("bw")}"/>')
    if fd: o.append("</g>")
    return "".join(o)

def cr(P, points):
    """A route through its waypoints as Catmull-Rom cubics: [(p0, c1, c2, p1)], in picture space."""
    q = [P(*map(float, xy.split())) for xy in points.split(";")]
    return [(q[i], (q[i][0] + (q[i + 1][0] - q[max(i - 1, 0)][0]) / 6, q[i][1] + (q[i + 1][1] - q[max(i - 1, 0)][1]) / 6),
             (q[i + 1][0] - (q[min(i + 2, len(q) - 1)][0] - q[i][0]) / 6, q[i + 1][1] - (q[min(i + 2, len(q) - 1)][1] - q[i][1]) / 6), q[i + 1]) for i in range(len(q) - 1)]

def samples(segs, n=10):
    """Points along the cubics, n per segment, ends included."""
    out = [segs[0][0]]
    for p0, c1, c2, p1 in segs:
        for k in range(1, n + 1):
            t = k / n; u = 1 - t
            out.append((u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p1[0], u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p1[1]))
    return out

KNOBS["base"] = dict(sea=("#eef3f6", ("#eef3f6", "#ffffff", "#f8f6f3", "#e9eef2"), "sea"), land=("#f7f7f4", ("#f7f7f4", "#ffffff", "#efede8"), "land"),
                     member=("#d9dcd6", ("#d9dcd6", "#efebe5", "#e6e1d8", "#ffffff"), "member states"), border=("#fff", ("#fff", "#c9c5bd", "#dedad3"), "border color"),
                     bw=(0.5, (0, 2, 0.1), "border width"), fade=(0, (0, 60, 2), "fade at the four edges"))

def ml_routes_reserve(m, occ):  # every route line and terminal is claimed before any name is placed
    for r, segs in m.rgeo: occ.add_line(samples(segs), "routes", r["partner"])
    for x, y in m.terms(): occ.add((x - 4, y - 4, x + 4, y + 4), "routes")

def ml_routes(m, occ):
    """Real pipeline routes from a sourced table: line style by status (solid in use, beaded dots stopped), the protagonist's
    in the accent; LNG terminals as hollow rings without names (the legend says what they are). Names: route_names."""
    d, o, K = m.d, [], lambda k: knob(m.d, "routes", k)
    for r, segs in m.rgeo:
        path = f"M{segs[0][0][0]:.1f},{segs[0][0][1]:.1f}" + "".join(f" C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p1[0]:.1f},{p1[1]:.1f}" for p0, c1, c2, p1 in segs)
        col = "var(--accent)" if r["partner"] == d.get("focus") else d.get("other", "var(--t-title)")
        live = r["status"] == "operating"; end = segs[-1][3]
        on = f' data-line="src:{esc(r["partner"])}"'  # the source's own line: its name and label may sit on it (the line rule's data-on)
        o.append(f'<path{on} d="{path}" fill="none" stroke="{col}" stroke-width="{K("live_w") if live else K("dead_w")}" stroke-linecap="round" stroke-linejoin="round"{"" if live else f" stroke-dasharray=\"0.1 {K("dead_gap")}\""}/>'
                 f'<circle{on} cx="{end[0]:.1f}" cy="{end[1]:.1f}" r="{K("end_r")}" fill="#fff" stroke="{col}" stroke-width="1.2"/>')
    for x, y in m.terms():
        o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.2" fill="#fff" stroke="var(--t-title)" stroke-width="1"/><circle cx="{x:.1f}" cy="{y:.1f}" r="1" fill="var(--t-title)"/>')
    return "".join(o)
KNOBS["routes"] = dict(live_w=(2, (0.5, 6, 0.1), "line width of pipelines in use"), dead_w=(2.8, (0.5, 6, 0.1), "dot size of halted pipelines"), dead_gap=(4.2, (1, 10, 0.1), "dot spacing of halted pipelines"), end_r=(3, (0, 8, 0.5), "radius of the end circle"))

def ml_route_names(m, occ):
    """One name per route, set beside (or along) its own line where it touches no line, terminal or other name and can be
    seen; tried at the middle first, then further out. A name with no free spot is left out, or set anyway if drop = force."""
    d, o, K = m.d, [], lambda k: knob(m.d, "route_names", k)
    sz, gap = K("size"), K("gap"); left = []
    for r, segs in m.rgeo:
        nm = r["name_zh"]; w, h = tw(nm, sz), sz + 2; pts = samples(segs, 16)
        L = [0]; [L.append(L[-1] + math.dist(pts[i - 1], pts[i])) for i in range(1, len(pts))]
        cands = []
        for fr in (0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88):
            i = min(range(len(pts)), key=lambda j: abs(L[j] - fr * L[-1])); i0, i1 = max(i - 1, 0), min(i + 1, len(pts) - 1)
            tx, ty = pts[i1][0] - pts[i0][0], pts[i1][1] - pts[i0][1]; tl = math.hypot(tx, ty) or 1; tx, ty = tx / tl, ty / tl
            for sgn in (-1, 1):  # the side away from the map's middle first, then the other
                nx, ny = -ty * sgn, tx * sgn
                if K("mode") == "along":
                    deg = math.degrees(math.atan2(ty, tx)); deg = deg - 180 if deg > 90 else deg + 180 if deg <= -90 else deg
                    cx_, cy_ = pts[i][0] + nx * (gap + h / 2), pts[i][1] + ny * (gap + h / 2)
                    ca, sa = abs(math.cos(math.radians(deg))), abs(math.sin(math.radians(deg))); hw, hh = (w * ca + h * sa) / 2, (w * sa + h * ca) / 2
                else:
                    deg = 0; hw, hh = w / 2, h / 2
                    cx_, cy_ = pts[i][0] + nx * gap + (hw if nx > 0.3 else -hw if nx < -0.3 else 0), pts[i][1] + ny * gap + (hh if ny > 0.3 else -hh if ny < -0.3 else 0)
                cands.append(((cx_ - hw, cy_ - hh, cx_ + hw, cy_ + hh), cx_, cy_, deg))
        ok = [c_ for c_ in cands if m.inside(c_[0]) and not occ.hit(c_[0], pad=(2, 2)) and not occ.on_line(c_[0], pad=1, rot=(c_[1], c_[2], w, h, c_[3]) if c_[3] else None)]
        pick = ok[0] if ok else cands[0] if K("drop") == "force" else None
        if not pick: left.append(nm); continue
        b, x, y, deg = pick; occ.add(b, "route_names")
        o.append(f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="middle" dominant-baseline="central" font-size="{sz}"{" font-style=\"italic\"" if K("italic") == "yes" else ""} fill="{K("ink")}" stroke="{d.get("sea", "#fff")}" stroke-width="{K("halo")}" paint-order="stroke"{f" transform=\"rotate({deg:.1f} {x:.1f} {y:.1f})\"" if deg else ""} data-on="src:{esc(r["partner"])}"{FX.name_mark(r)}>{esc(nm)}</text>')
    return "".join(o) + (f'<g data-left="{esc("|".join(left))}"></g>' if left else "")  # names with no free spot, for the layer check
KNOBS["route_names"] = dict(size=(10, (7, 16, 0.5), "font size"), italic=("yes", ("yes", "no"), "italic"), mode=("beside", ("beside", "along"), "placement: level beside the line / along the line"),
                            gap=(3, (0, 14, 0.5), "distance from the line"), ink=("var(--t-sec)", ("var(--t-sec)", "var(--t-title)", "#9a968e"), "color"),
                            halo=(2.5, (0, 6, 0.5), "halo width"), drop=("skip", ("skip", "force"), "when it does not fit: skip / write anyway"))

def ml_cities(m, occ):
    """Cities from a sourced table (data "cities"): a small dot and the name, biggest first, capitals only unless told
    otherwise; the name tries right, left, above, below its dot and keeps clear of lines, other names and the frame."""
    d, o, K = m.d, [], lambda k: knob(m.d, "cities", k)
    if not d.get("cities"): return ""
    sz, dot, n = K("size"), K("dot"), 0
    for r in FX.records(d["cities"]):
        if n >= K("count"): break
        if K("which") == "capitals" and r["kind"] != "Admin-0 capital": continue
        if float(r["pop"] or 0) < K("min_pop") * 1e4: continue
        x, y = m.P(float(r["lon"]), float(r["lat"])); nm = r["name_zh"]; w, h = tw(nm, sz), sz + 1
        db = (x - dot - 1, y - dot - 1, x + dot + 1, y + dot + 1)
        if not m.inside(db) or occ.hit(db) or occ.on_line(db, pad=1): continue
        b, _ = place(m, occ, x, y, w, h, dot + 2)
        if not b: continue
        occ.add(db, "cities"); occ.add(b, "cities"); n += 1
        o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{dot}" fill="{K("ink")}"/><text x="{b[0]:.1f}" y="{b[3] - 2:.1f}" font-size="{sz}" fill="{K("ink")}"{FX.name_mark(r)}>{esc(nm)}</text>')
    return "".join(o)
KNOBS["cities"] = dict(count=(12, (0, 40, 1), "at most this many"), which=("capitals", ("capitals", "all"), "capitals only / all"), min_pop=(0, (0, 500, 10), "minimum population (10,000s)"),
                       size=(10, (7, 14, 0.5), "font size"), dot=(1.8, (0.5, 4, 0.1), "dot size"), ink=("var(--t-body)", ("var(--t-body)", "var(--t-sec)", "var(--t-title)"), "color"))

def ml_names(m, occ):
    """Place names on the base map (small grey type), kept clear of each other, of every box registered so far and, unless
    lines = cross, of the route lines; only where they can be seen."""
    d, P, o, K = m.d, m.P, [], lambda k: knob(m.d, "names", k)
    if not d.get("names"): return ""
    lon0, lat0, lon1, lat1 = m.ext; sz, tr = K("size"), K("track")
    for code, (lo, la) in list(geo.PT.items()) + [(k, PL[k][1:3]) for k in PL if is_place(k) and len(PL[k]) == 3]:
        if code in m.top or not (lon0 < lo < lon1 and lat0 < la < lat1) or (math.dist(P(lo, la), (m.hx, m.hy)) < K("hub_clear") and d.get("stop") != "border") or any(math.dist(P(lo, la), P(*q)) < 28 for q in d.get("avoid", [])): continue
        if code not in NAMES: continue  # the base map names only the places the request labels
        x, y = P(lo, la); nm = NAME(code); w = tw(nm, sz) + tr * len(nm)
        b = (x - w / 2, y - sz + 1.5, x + w / 2, y + 3)
        if not m.inside(b) or occ.hit(b, pad=(K("pad_x"), K("pad_y"))) or (K("lines") == "avoid" and occ.on_line(b, pad=2)): continue
        occ.add(b, "names"); o.append(f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="middle" font-size="{sz}" letter-spacing="{tr}" fill="{K("ink")}"{' font-family="var(--serif)"' if K("font") == "serif" else ""}>{named(code)}</text>')
    return "".join(o)
KNOBS["names"] = dict(size=(10.5, (7, 18, 0.5), "font size"), track=(2, (0, 8, 0.5), "letter spacing"), ink=("#9a968e", ("#9a968e", "#b5b1a9", "var(--t-sec)"), "color"),
                      font=("sans", ("sans", "serif"), "typeface: sans / serif"), pad_x=(6, (0, 20, 1), "horizontal padding"), pad_y=(4, (0, 16, 1), "vertical padding"),
                      hub_clear=(70, (0, 160, 5), "keep clear around the hub"), lines=("avoid", ("avoid", "cross"), "over lines: avoid / may cross"))

def bundles(m):
    """Off-map sources that enter the picture within edge.join px of each other become one bundle, as a far place gets one
    arrow at the frame edge instead of lines piling up there: {leader: members}, {member: shared entry point}."""
    j = knob(m.d, "edge", "join")
    if not j: return {}, {}
    cx, cy = m.W / 2, m.H / 2; v = lambda k: m.ser[k].get(m.t0, 0) + m.ser[k].get(m.t1, 0)
    ks = sorted((k for k in m.order() if k not in m.routed and m.off(k)), key=lambda k: math.atan2(m.at(k)[1] - cy, m.at(k)[0] - cx))
    groups = []
    for k in ks:
        if groups and math.dist(m.at(k), m.at(groups[-1][-1])) < j: groups[-1].append(k)
        else: groups.append([k])
    bund, bp = {}, {}
    for g in groups:
        if len(g) < 2: continue
        g.sort(key=lambda k: -v(k)); tw_ = sum(v(k) for k in g) or 1
        x, y = sum(m.at(k)[0] * v(k) for k in g) / tw_, sum(m.at(k)[1] * v(k) for k in g) / tw_
        if m.d.get("round"):  # back out to the circle the members sat on
            R = min(m.W, m.H) / 2 - 16; r = math.dist((x, y), (cx, cy)) or 1; x, y = cx + (x - cx) * R / r, cy + (y - cy) * R / r
        bund[g[0]] = g; bp.update({k: (x, y) for k in g})
    return bund, bp
KNOBS["edge"] = dict(join=(0, (0, 120, 2), "merge far sources closer than this into one bundle (0 = never)"), arrow=(14, (0, 30, 1), "edge arrow length"),
                     ink=("var(--t-sec)", ("var(--t-sec)", "var(--t-title)", "#b5b1a9"), "arrow color"))

def flow_geo(m):
    """Each source line without routes, once per picture: (source, start, control, end, arrow svg, t0 value, t1 value, colour).
    Into the hub, or with stop=border ending at the first member border with an arrow."""
    if hasattr(m, "_flows"): return m._flows
    d, out = m.d, []; hx, hy = m.hx, m.hy
    for k_ in m.order():
        if k_ in m.routed or (k_ in m.bp and k_ not in m.bund): continue  # a bundle is drawn once, by its largest member
        sx, sy = m.at(k_)
        bend = d.get("bend", 0.18) * (-1 if d.get("mirror") and sx > hx else 1)  # mirror: bands left and right of the hub bow outwards alike, so they do not swirl
        cx, cy = (sx + hx) / 2 + (hy - sy) * bend, (sy + hy) / 2 - (hx - sx) * bend
        ex, ey = hx, hy; arrow = ""
        a, b = m.ser[k_].get(m.t0, 0), m.ser[k_].get(m.t1, 0); col = m.col(k_)
        if k_ in m.bund:  # the bundle's line is as wide as all its members together
            g = m.bund[k_]; a, b = sum(m.ser[k].get(m.t0, 0) for k in g), sum(m.ser[k].get(m.t1, 0) for k in g)
            col = "var(--accent)" if d.get("focus") in g else col
        if d.get("stop") == "border":  # the line ends where it first enters a member state, with an arrowhead, instead of all meeting in one point
            B = lambda t: ((1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * hx, (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * hy)
            first = lambda: next((i / 120 for i in range(1, 121) if any(geo._inside(B(i / 120), r) for r in m.mrings)), 1.0)
            t = first(); cx2, cy2 = 2 * (sx + hx) / 2 - cx, 2 * (sy + hy) / 2 - cy; c1 = (cx, cy); cx, cy = cx2, cy2
            if first() <= t: cx, cy = c1  # bow the way that runs longer before it meets a member state (over sea rather than across a neighbour)
            else: t = first()
            cx, cy = sx + t * (cx - sx), sy + t * (cy - sy); ex, ey = B(t)  # de Casteljau: the first part of the same curve
            ang = math.atan2(ey - cy, ex - cx); aw = max(4.5, m.wid(b) * 0.9)
            arrow = f'<path d="M{ex + math.cos(ang) * aw:.1f},{ey + math.sin(ang) * aw:.1f} L{ex + math.cos(ang + 2.5) * aw * 1.3:.1f},{ey + math.sin(ang + 2.5) * aw * 1.3:.1f} L{ex + math.cos(ang - 2.5) * aw * 1.3:.1f},{ey + math.sin(ang - 2.5) * aw * 1.3:.1f}Z" fill="{col}"/>'
        out.append((k_, (sx, sy), (cx, cy), (ex, ey), arrow, a, b, col))
    m._flows = out
    return out

def ml_flows_reserve(m, occ):  # the flow lines (both edges of a wide one) and the hub name are claimed before any name is placed
    for k_, (sx, sy), (cx, cy), (ex, ey), _, a, b, _ in flow_geo(m):
        w = max(m.wid(b), m.wid(a) if m.d.get("halo", True) else 0) / 2; pts = []
        n = max(40, int((math.dist((sx, sy), (cx, cy)) + math.dist((cx, cy), (ex, ey))) / 4))  # a sample every 4 px or closer, so no label slips between two
        for i in range(n + 1):
            t = i / n; x, y = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * ex, (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * ey
            dx, dy = 2 * (1 - t) * (cx - sx) + 2 * t * (ex - cx), 2 * (1 - t) * (cy - sy) + 2 * t * (ey - cy); l = math.hypot(dx, dy) or 1
            pts += [(x, y), (x - dy / l * w, y + dx / l * w), (x + dy / l * w, y - dx / l * w)]
        occ.add_line(pts, "flows", k_)
    if m.d.get("stop") != "border":
        hx, hy = m.hx, m.hy; nm = hub_name(m.d); w = tw(nm, 13)
        for gap in (12, 22, 34, 48):  # below left as before, else the first side no line crosses, a little further out each round
            b, _ = place(m, occ, hx, hy, w, 16, gap, order=("DL", "L", "UL", "U", "UR", "R", "DR", "D"))
            if b: break
        m._hubname = b or (hx - 12 - w, hy + 12, hx - 12, hy + 28)
        occ.add((hx - 8, hy - 8, hx + 8, hy + 8), "flows"); occ.add(m._hubname, "flows")

def ml_flows(m, occ):
    d, o = m.d, []; hx, hy = m.hx, m.hy
    for k_, (sx, sy), (cx, cy), (ex, ey), arrow, a, b, col in flow_geo(m):
        path = f"M{sx:.1f},{sy:.1f} Q{cx:.1f},{cy:.1f} {ex:.1f},{ey:.1f}"; on = f' data-line="src:{esc(k_)}"'
        o.append((f'<path{on} d="{path}" fill="none" stroke="#c9c9c9" stroke-opacity="0.55" stroke-width="{m.wid(a):.1f}" stroke-linecap="round"/>' if d.get("halo", True) else "") +
                 f'<path{on} d="{path}" fill="none" stroke="{col}" stroke-opacity="0.9" stroke-width="{m.wid(b):.1f}" stroke-linecap="round"/>' + arrow)
    if d.get("stop") != "border": o.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="7" fill="var(--t-title)"/><text x="{m._hubname[2]:.1f}" y="{m._hubname[3] - 2:.1f}" text-anchor="end" font-size="13" font-weight="700" fill="var(--t-title)" stroke="{d.get("sea", "#fff")}" stroke-width="4" paint-order="stroke">{hub_named(d)}</text>')
    return "".join(o)

def ml_edge(m, occ):
    """A short arrow outwards where an off-map source (or a bundle of them) enters: the place lies beyond the frame."""
    L = knob(m.d, "edge", "arrow"); ink = knob(m.d, "edge", "ink")
    if not knob(m.d, "edge", "join") or not L: return ""
    cx, cy, o, seen = m.W / 2, m.H / 2, [], set()
    for k in m.order():
        if k in m.routed or not m.off(k) or m.at(k) in seen: continue
        x, y = m.at(k); seen.add((x, y)); r = math.dist((x, y), (cx, cy)) or 1; ux, uy = (x - cx) / r, (y - cy) / r
        ex, ey = x + ux * L, y + uy * L; a = math.atan2(uy, ux)
        o.append(f'<line x1="{x + ux * 3:.1f}" y1="{y + uy * 3:.1f}" x2="{ex:.1f}" y2="{ey:.1f}" stroke="{ink}" stroke-width="1"/>'
                 f'<path d="M{ex + math.cos(a) * 4:.1f},{ey + math.sin(a) * 4:.1f} L{ex + math.cos(a + 2.4) * 4:.1f},{ey + math.sin(a + 2.4) * 4:.1f} L{ex + math.cos(a - 2.4) * 4:.1f},{ey + math.sin(a - 2.4) * 4:.1f}Z" fill="{ink}"/>')
    return "".join(o)

def inset_geom(m, w):
    """Box of the locator inset: every ranked source with a place, the hub and the main map's extent; None when every source is on the map."""
    far = [k for k in m.top if len(PL.get(k, [])) > 2 and m.off(k)]
    if not far: return None
    d = m.d; pts = [tuple(PL[k][1:3]) for k in m.top if len(PL.get(k, [])) > 2] + [tuple(d["hub"]), m.ext[:2], m.ext[2:]]
    lo0, la0 = min(p[0] for p in pts) - 6, min(p[1] for p in pts) - 5; lo1, la1 = max(p[0] for p in pts) + 6, max(p[1] for p in pts) + 5
    k_ = math.cos(math.radians((la0 + la1) / 2)); h = min(w * 0.9, w * (la1 - la0) / ((lo1 - lo0) * k_))
    return far, (lo0, la0, lo1, la1), k_, min(w / ((lo1 - lo0) * k_), h / (la1 - la0)), h

def inset_svg(m, g, x0, y0, w, note_below=False, soft=None):
    """Draw the inset at (x0, y0): pale land, the main map's extent as a dashed frame, one thin line per source to the hub
    (the protagonist in the accent), names of the far sources only (their numbers are on the main map). soft = colour of a
    feathered patch under it, so it sits on the map without a box."""
    far, (lo0, la0, lo1, la1), k_, s_, h = g; d = m.d; K = lambda k: knob(d, "inset", k); uid = f"{x0:.0f}{y0:.0f}"
    P = lambda lo, la: (x0 + (lo - lo0) * k_ * s_, y0 + (la1 - la) * s_)
    land = []
    for ft in geo.features()[0]:
        for poly in geo._rings(ft["geometry"]):
            r = poly[0]
            if len(r) < 4 or not any(lo0 < x < lo1 and la0 < y < la1 for x, y in r): continue
            land.append("M" + "L".join(f"{P(x, y)[0]:.1f},{P(x, y)[1]:.1f}" for x, y in r[::3]) + "Z")
    (ex0, ey0), (ex1, ey1) = P(m.ext[0], m.ext[3]), P(m.ext[2], m.ext[1]); hx, hy = P(*d["hub"])
    o = []
    if soft: o.append(f'<defs><filter id="ib{uid}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="{K("feather")}"/></filter></defs>'
                      f'<rect x="{x0 - 6}" y="{y0 - 20}" width="{w + 12}" height="{h + 30:.1f}" fill="{soft}" filter="url(#ib{uid})"/>')
    o += [(f'<defs><mask id="ic{uid}"><rect x="{x0 + 8}" y="{y0 + 6}" width="{w - 16}" height="{h - 12:.1f}" fill="#fff" filter="url(#ib{uid})"/></mask></defs><g mask="url(#ic{uid})">' if soft else  # on the map: land fades out, no box
           f'<defs><clipPath id="ic{uid}"><rect x="{x0}" y="{y0}" width="{w}" height="{h:.1f}"/></clipPath></defs><g clip-path="url(#ic{uid})">'),
          f'<path d="{"".join(land)}" fill="{K("land")}"/></g>',  # only the land is faded or cut; lines and names stay whole
          f'<rect x="{ex0:.1f}" y="{ey0:.1f}" width="{ex1 - ex0:.1f}" height="{ey1 - ey0:.1f}" fill="none" stroke="var(--t-sec)" stroke-width="0.7" stroke-dasharray="2 2"/>']
    mx = max(m.ser[k].get(m.t1, 0) for k in m.top) or 1; boxes = []
    ink = [(x, y, "frame") for t in range(0, 101) for x, y in ((ex0 + (ex1 - ex0) * t / 100, ey0), (ex0 + (ex1 - ex0) * t / 100, ey1), (ex0, ey0 + (ey1 - ey0) * t / 100), (ex1, ey0 + (ey1 - ey0) * t / 100))]
    ink += [(hx, hy, "hub")]  # what a name must keep off: the frame's edge, the hub, every line but its own (sampled below)
    for k in m.top:
        if len(PL.get(k, [])) < 3: continue
        sx, sy = P(*PL[k][1:3]); col = "var(--accent)" if k == d.get("focus") else K("ink")
        cx, cy = (sx + hx) / 2 + (hy - sy) * 0.15, (sy + hy) / 2 - (hx - sx) * 0.15
        ink += [((1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * hx, (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * hy, k) for t in (i / 80 for i in range(81))]
        o.append(f'<path data-line="src:{esc(k)}" d="M{sx:.1f},{sy:.1f} Q{cx:.1f},{cy:.1f} {hx:.1f},{hy:.1f}" fill="none" stroke="{col}" stroke-width="{0.6 + K("line") * m.ser[k].get(m.t1, 0) / mx:.1f}" stroke-opacity="0.8"/>')
        if k in far: o.append(f'<circle cx="{sx:.1f}" cy="{sy:.1f}" r="1.8" fill="{col}"/>')
    o.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="2.5" fill="var(--t-title)"/>')
    sz = K("size")
    for k in far:
        sx, sy = P(*PL[k][1:3]); n = NAME(k); t = tw(n, sz)
        for b in ((sx + 4, sy - sz / 2, sx + 4 + t, sy + sz / 2), (sx - 4 - t, sy - sz / 2, sx - 4, sy + sz / 2), (sx - t / 2, sy - 4 - sz, sx + t / 2, sy - 4), (sx - t / 2, sy + 4, sx + t / 2, sy + 4 + sz),
                  (sx + 3, sy - 3 - sz, sx + 3 + t, sy - 3), (sx + 3, sy + 3, sx + 3 + t, sy + 3 + sz), (sx - 3 - t, sy - 3 - sz, sx - 3, sy - 3), (sx - 3 - t, sy + 3, sx - 3, sy + 3 + sz)):
            e = 8 if soft else 0  # on the map the land fades, so a name may run a little past the edge
            if b[0] >= x0 - e and b[2] <= x0 + w + e and b[1] >= y0 - e and b[3] <= y0 + h + e and not any(b[0] < q[2] and q[0] < b[2] and b[1] < q[3] and q[1] < b[3] for q in boxes) \
               and not any(b[0] - 3 < x < b[2] + 3 and b[1] - 3 < y < b[3] + 3 for x, y, t in ink if t != k): break
        else: continue
        boxes.append(b)
        o.append(f'<text data-on="src:{esc(k)}" x="{b[0]:.1f}" y="{b[3] - 1.5:.1f}" font-size="{sz}" fill="var(--t-body)" stroke="{soft or "var(--bg)"}" stroke-width="2.5" paint-order="stroke">{named(k)}</text>')
    o.append(f'<text x="{x0}" y="{y0 + h + 12:.1f}" font-size="10.5" fill="var(--t-sec)">{esc(inset_note(K("note")))}</text>' if note_below else
             f'<text x="{x0}" y="{y0 - 5:.1f}" font-size="10.5" fill="var(--t-sec)">{esc(inset_note(K("note")))}</text>')
    return "".join(o)

def ml_inset(m, occ):
    """The Long March gives the part of the main map it does not use to the locator map: the inset is set inside the picture,
    in the emptiest room that touches no line, name, label or event point, furthest from the hub; else the ring puts it in a corner."""
    d = m.d
    if not d.get("round") or knob(d, "inset", "show") != "auto" or d.get("_gapdir") is not None: return ""  # title in the gap: the inset joins it there
    w = knob(d, "inset", "w_in"); g = inset_geom(m, w)
    if not g: return ""
    h = g[-1]; ev = [m.P(*p) for p in d.get("ev_at", [])]; best = None
    for y in range(0, int(m.H - h), 10):
        for x in range(0, int(m.W - w), 10):
            b = (x, y - 16, x + w, y + h)
            if not m.inside(b, 6) or occ.hit(b, pad=(6, 6)) or occ.on_line(b, pad=6) or any(b[0] - 8 < px < b[2] + 8 and b[1] - 8 < py < b[3] + 8 for px, py in ev): continue
            sc = math.dist(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), (m.hx, m.hy))
            if not best or sc > best[0]: best = (sc, x, y)
    if not best: return f'<g data-left="{word("inset.left")}"></g>'
    _, x, y = best; occ.add((x, y - 16, x + w, y + h), "inset")
    if "_ret" in d: d["_ret"]["inset"] = True
    return inset_svg(m, g, x, y, w, soft=knob(d, "base", "sea"))

KNOBS["inset"] = dict(show=("auto", ("auto", "corner", "off"), "inset: auto looks for empty space in the main map first, corner puts it in a corner outside the ring"), corner=("auto", ("auto", "bl", "br", "tl", "tr"), "which corner"),
                           w_in=(190, (120, 300, 10), "width when placed inside the main map"), width=(250, (140, 360, 10), "width"), below_legend=(130, (40, 260, 5), "distance below the legend"), land=("#e4e0d8", ("#e4e0d8", "#ece9e3", "#d6d1c8"), "land color"),
                           ink=("var(--t-title)", ("var(--t-title)", "var(--t-sec)"), "line color"), line=(2.4, (0, 6, 0.2), "extra width of the thickest line"),
                           size=(10, (8, 14, 0.5), "place-name font size"), feather=(7, (0, 20, 1), "edge fade when placed inside the main map"), note=("frame", ("frame", "locator"), "caption, a word-table key: inset.note.<key>"))

def ml_labels_reserve(m, occ):  # room for the line-end labels, claimed before the names are placed
    for k in m.top:
        if k in m.bp and k not in m.bund: continue
        x, y = m.at(k); e = (knob(m.d, "labels", "size") + 3) * (len(m.bund.get(k, [k])) - 1)  # a bundle's block is taller
        occ.add((x - 80, y - 14 - e, x + 80, y + 10 + e), "labels_room")

def lead(bx, sd):  # where a label's leader meets its box on side sd
    return (bx[0] - 1, (bx[1] + bx[3]) / 2) if sd == "R" else (bx[2] + 1, (bx[1] + bx[3]) / 2) if sd == "L" else ((bx[0] + bx[2]) / 2, bx[3] + 1 if sd == "U" else bx[1] - 1) if len(sd) == 1 else (bx[2] if sd[1] == "L" else bx[0], bx[3] if sd[0] == "U" else bx[1])

def seg_pts(p, q, n=24): return [(p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n) for j in range(1, n)]

def ml_labels(m, occ):
    """Source labels at the line ends: 'short' = name and bare number (a callout layout), True = name, value and change."""
    d, c, W, o = m.d, m.c, m.W, []; hx = m.hx
    fam = d.get("label_fact")  # with a ledger, the family of value facts (one per member at t1) the short labels print
    src = lambda k: f"fact:{fam}.{k}.n"
    if FX.LEDGER is not None and d.get("labels") == "short" and not fam: raise FX.Refused("map labels: the map names no label_fact family")
    for k_ in m.order() if d.get("labels") == "short" else []:
        if k_ in d.get("skip", []) or (k_ in m.bp and k_ not in m.bund): continue
        sx, sy = m.at(k_); sz = knob(d, "labels", "size"); ks = m.bund.get(k_, [k_])
        rows = [(NAME(k), FX.fmt(c.spec, {"v": m.ser[k].get(m.t1, 0), "fmt": m.fk}, bare=True) if FX.LEDGER is None else FX.text(src(k))) for k in ks]
        nb = rows[0][1]; est = max(sz * (len(n_) + 1) + 7 * sz / 12 * len(v_) for n_, v_ in rows); lh = sz + 3
        anc = "end" if sx < hx or sx + 7 + est > W else "start"; dx = -7 if anc == "end" else 7; ty = sy + 4
        if knob(d, "labels", "fit") == "free":  # find a free side (round pictures, crowded ends) instead of the fixed one
            bw, bh = max(tw(n_ + " " + v_, sz) for n_, v_ in rows), sz + 2 + lh * (len(rows) - 1)
            for g in (7, 18, 30, 44, 60, 80, 100):  # close to the line end first; further out with a short leader when it is crowded
                order = ("L", "R", "U", "D", "UL", "DL", "UR", "DR") if anc == "end" else ("R", "L", "U", "D", "UR", "DR", "UL", "DL")
                if m.off(k_):  # entering at the edge, beyond the end is outside: inward and off the line, its own line included
                    ix, iy = ("L" if sx > m.W / 2 else "R"), ("U" if sy > m.H / 2 else "D")
                    order = (iy + ix, ("D" if iy == "U" else "U") + ix, ix, iy, ("D" if iy == "U" else "U"))
                for own in ((None, k_) if k_ in m.routed and not m.off(k_) else (None if m.off(k_) else k_,)):  # routes fan out from their end: they block first, then the label may sit on its own
                    bx, sd = place(m, occ, sx, sy, bw, bh, g, order, but={"labels_room"}, own=own)
                    if bx and g > 7 and any(q[0] - 1 < x < q[2] + 1 and q[1] - 1 < y < q[3] + 1 for x, y in seg_pts((sx, sy), lead(bx, sd)) for q in occ.boxes
                                            if q[4] != "labels_room" and not (q[0] <= sx <= q[2] and q[1] <= sy <= q[3])): bx = None  # its leader crosses a name (a mark at the line end itself, where every leader starts, does not count)
                    if bx: break
                if bx: break
            if bx and g > 7:
                lx, ly = lead(bx, sd)
                o.append(f'<line x1="{sx:.1f}" y1="{sy:.1f}" x2="{lx:.1f}" y2="{ly:.1f}" stroke="var(--t-sec)" stroke-width="0.6"/>')
            if bx:
                occ.add(bx, "labels"); ty = bx[1] + sz - 1
                anc, dx = ("start", bx[0] - sx) if sd[-1] == "R" else ("end", bx[2] - sx) if sd[-1] == "L" else ("middle", 0)
        if len(rows) > 1 and ty == sy + 4: ty = sy + 4 - lh * (len(rows) - 1) / 2  # fixed side: centre the block on the line end
        for i, (n_, v_) in enumerate(rows):
            o.append(f'<text data-on="src:{esc(ks[i])}" x="{sx + dx:.1f}" y="{ty + i * lh:.1f}" text-anchor="{anc}" font-size="{sz}" fill="var(--t-title)" stroke="{d.get("sea", "#fff")}" stroke-width="3" paint-order="stroke">{named(ks[i])} <tspan font-weight="{knob(d, "labels", "weight")}">{v_ if FX.LEDGER is None else FX.entry(src(ks[i]), "tspan", None)}</tspan></text>')
    for k_ in m.order() if d.get("labels", True) is True else []:
        sx, sy = m.at(k_); a, b = m.ser[k_].get(m.t0, 0), m.ser[k_].get(m.t1, 0); edge = k_ not in m.routed and len(PL[k_]) > 3
        col = None if k_ in m.routed else m.col(k_)
        ch = (b / a - 1) if a else None
        tail = "" if ch is None else word("paren", v=f'{"+" if ch >= 0 else "−"}{abs(ch) * 100:.0f}%')
        est = 13 * (len(c.n(b, m.fk)) + len(tail)) * 0.8  # rough label width: flip to the left when it would leave the map
        anc = "end" if sx < hx or sx + 10 + est > W else "start"; dx = -10 if anc == "end" else 10
        if edge: anc, dx = ("start", 4) if sx < W * 0.3 else ("middle", 0)
        ty = sy - 22 if edge and sx < W * 0.3 else sy + 22 if edge else sy - 4
        o.append(f'<text x="{sx + dx:.1f}" y="{ty:.1f}" text-anchor="{anc}" font-size="13" fill="var(--t-title)"><tspan font-weight="700">{named(k_)}{" →" if edge and sx < W * 0.5 else ""}</tspan></text>'
                 f'<text class="v" x="{sx + dx:.1f}" y="{ty + 16:.1f}" text-anchor="{anc}" font-size="13" fill="{col}" font-weight="700">{c.n(b, m.fk)}<tspan fill="var(--t-sec)" font-weight="400">{tail}</tspan></text>')
    return "".join(o)

KNOBS["labels"] = dict(size=(12, (8, 18, 0.5), "font size of line-end labels"), weight=(700, (400, 900, 100), "number weight"), fit=("fixed", ("fixed", "free"), "placement: fixed side / find free space"))

def ml_legend(m, occ):
    """What the two band layers mean, with a real value for scale; a page that says it in words turns halo off."""
    d, c, t0, t1 = m.d, m.c, m.t0, m.t1
    if not d.get("halo", True): return ""
    big = max(m.top, key=lambda k_: m.ser[k_].get(t0, 0)); v = m.ser[big][t0]
    y0, y1, val = t0, t1, c.n(v, m.fk)
    if FX.LEDGER is not None:  # the years the map's table covers and the largest member's value at t0, from the ledger
        if not d.get("legend_fact"): raise FX.Refused("map legend: the map names no legend_fact family")
        if not all(len(t) == 4 and t.isdigit() for t in (t0, t1)): raise FX.Refused("map legend: t0 and t1 are not years")
        y0, y1 = (FX.entry(f"period:{d['q']['table']}:{t}", "tspan", None) for t in (t0, t1))
        lf = d["legend_fact"]  # a bare number with its unit written after it, as fill() prints {key}
        val = FX.entry(f"fact:{lf}.{big}.n", "tspan", None) + esc(FX.unit(c.spec, c.spec["facts"][lf]))
    l0, l1 = word("halo.t0", y=y0, name=named(big), val=val), word("halo.t1", y=y1, words=halo_words(d))
    bw = max(290, 72 + max(tw(re.sub(r"<[^>]+>", "", html.unescape(t)), 12) for t in (l0, l1)) + 12)  # the box holds its longest line
    return (f'<g transform="translate(16,16)"><rect width="{bw:.0f}" height="62" fill="#fff" fill-opacity="0.85"/>'
            f'<line x1="12" x2="60" y1="20" y2="20" stroke="#c9c9c9" stroke-width="{m.wid(v):.1f}" stroke-opacity="0.55"/>'
            f'<text x="72" y="25" font-size="12" fill="var(--t-body)">{l0}</text>'
            f'<line x1="12" x2="36" y1="46" y2="46" stroke="{"var(--accent)" if d.get("focus") else d.get("fall", "var(--accent)")}" stroke-width="5"/><line x1="36" x2="60" y1="46" y2="46" stroke="{d.get("other", "var(--t-title)") if d.get("focus") else d.get("rise", "var(--accent2)")}" stroke-width="5"/>'
            f'<text x="72" y="51" font-size="12" fill="var(--t-body)">{l1}</text></g>')

# name -> (draw, reserve); a picture's "layers" list picks and orders them, bottom first
MAP_LAYERS = dict(base=(ml_base, None), routes=(ml_routes, ml_routes_reserve), route_names=(ml_route_names, None), cities=(ml_cities, None), names=(ml_names, None), flows=(ml_flows, ml_flows_reserve), labels=(ml_labels, ml_labels_reserve), legend=(ml_legend, None), edge=(ml_edge, None), inset=(ml_inset, None))
MAP_ORDER = ["base", "routes", "route_names", "cities", "names", "flows", "edge", "labels", "inset", "legend"]

def layered(frame, reg, order, wrap=None, out=None):
    """Draw the layers bottom first on one frame and one occupancy table. wrap(name, svg) may tag each layer for preview;
    out, a dict, receives each layer's own drawing so a layer can be saved, compared and checked alone."""
    occ = Occ()
    for b, layer in getattr(frame, "claims", []): occ.add(b, layer)  # what the frame's owner draws over it, claimed before any layer
    for n in order:
        if reg[n][1]: reg[n][1](frame, occ)
    parts = []
    for n in order:
        s = reg[n][0](frame, occ)
        if out is not None: out[n] = s
        parts.append(wrap(n, s) if wrap and s else s)
    return "".join(parts), occ

def flowmap(c, d, W, H=600, wrap=None, out=None):
    """Base map + routes + names + one line per source + labels + legend, as map layers (MAP_LAYERS)."""
    body, _ = layered(MapFrame(c, d, W, H), MAP_LAYERS, d.get("layers", MAP_ORDER), wrap, out)
    return f'<svg viewBox="0 0 {W} {H}" width="100%" role="img">{body}</svg>'

def slope(c, d, W, H=310):
    ser = series(c.T, d["q"]); t0, t1 = d["t0"], d["t1"]
    top = ranked(ser, d, t0, t1)
    mx = max(max(ser[k].get(t0, 0), ser[k].get(t1, 0)) for k in top)
    x0, x1, mt, mb = 70, W - 110, 34, 26
    py = lambda v: mt + (1 - v / mx) * (H - mt - mb)
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img">',
         f'<text x="{x0}" y="16" text-anchor="middle" font-size="13" fill="var(--t-sec)">{t0}</text><text x="{x1}" y="16" text-anchor="middle" font-size="13" fill="var(--t-sec)">{t1}</text>',
         f'<line x1="{x0}" x2="{x0}" y1="{mt - 6}" y2="{H - mb}" stroke="#e5e5e5"/><line x1="{x1}" x2="{x1}" y1="{mt - 6}" y2="{H - mb}" stroke="#e5e5e5"/>']
    left, right = [], []
    for k in top:
        a, b = ser[k].get(t0, 0), ser[k].get(t1, 0); col = "var(--accent)" if b < a else "var(--accent2)"
        o.append(f'<line x1="{x0}" x2="{x1}" y1="{py(a):.1f}" y2="{py(b):.1f}" stroke="{col}" stroke-width="2.5"/>'
                 f'<circle cx="{x0}" cy="{py(a):.1f}" r="4" fill="{col}"/><circle cx="{x1}" cy="{py(b):.1f}" r="4" fill="{col}"/>')
        left.append([py(a), f"{c.n(a, 'bcm0')}", col]); right.append([py(b), f"{NAME(k)} {c.n(b, 'bcm0')}", col])
    for side, x, anc in ((left, x0 - 8, "end"), (right, x1 + 8, "start")):
        side.sort()
        for i in range(1, len(side)):
            if side[i][0] - side[i - 1][0] < 15: side[i][0] = side[i - 1][0] + 15
        for y, txt, col in side:
            o.append(f'<text class="v" x="{x}" y="{y + 4:.1f}" text-anchor="{anc}" font-size="12" fill="{col}" font-weight="600">{esc(txt)}</text>')
    o.append(f'<text x="{W - 4}" y="{H - 4}" text-anchor="end" font-size="11" fill="var(--t-sec)">{esc(need(d, "unit"))}</text></svg>')
    return "".join(o)

def ledger(c, d, W, H=None):
    ser = series(c.T, d["q"]); t0, t1 = d["t0"], d["t1"]
    rk = sorted(ser, key=lambda k: -ser[k].get(t1, 0))
    rest = [k for k in rk[d["skip"]:] if ser[k].get(t1, 0) > 0]
    tot = sum(ser[k].get(t1, 0) for k in rk)
    shown = [k for k in rest if k in PL and len(PL[k][0]) and not k.endswith("_OTH") and k != "NSP" and ser[k].get(t1, 0) >= d.get("min", 0)]
    fold = [k for k in rest if k not in shown]
    rows = []
    for k in shown:
        a, b = ser[k].get(t0, 0), ser[k].get(t1, 0)
        ch = word("new") if not a else f'{"+" if b >= a else "−"}{abs(b / a - 1) * 100:.0f}%'
        rows.append(f'<div class="lr"><span>{esc(NAME(k))}</span><span class="v">{c.n(b)}</span><em>{ch}</em></div>')
    fv = sum(ser[k].get(t1, 0) for k in fold)
    rows.append(f'<div class="lr"><span>{word("fold", n=len(fold))}</span><span class="v">{c.n(fv)}</span><em></em></div>')
    share = sum(ser[k].get(t1, 0) for k in rest) / tot
    return (f'<div class="ledger2"><div class="lh"><span>{word("ledger.src")}</span><span>{word("date.y", y=t1)}</span><span>{word("ledger.vs", t=t0)}</span></div>{"".join(rows)}'
            f'<div class="lr sum"><span>{word("ledger.sum")}</span><span class="v">{c.n(sum(ser[k].get(t1, 0) for k in rest))}</span><em>{word("share.of", of=esc(need(d, "share_of")), v=f"{share * 100:.0f}")}</em></div></div>')

def stack_area(c, d, W, H=240):
    ser = series(c.T, d["q"]); order = d["order"]
    times = sorted({t for k in order for t in ser.get(k, {})})
    full = [t for t in times if all(t in ser.get(k, {}) for k in order)]
    start = times[0]  # first month after which no run of 2+ missing months remains
    for i, t in enumerate(times):
        if t in full and all(not (times[j] not in full and j + 1 < len(times) and times[j + 1] not in full) for j in range(i, len(times))): start = t; break
    times = [t for t in times if t >= start]
    miss = [t for t in times if t not in full]
    cols = {order[0]: "var(--accent)", order[1]: "var(--accent2)", order[2]: "#9fb8da"}
    greys = ["#cfcfcf", "#dadada", "#c4c4c4", "#e2e2e2", "#d4d4d4"]
    tot = [sum(ser.get(k, {}).get(t, 0) for k in order) for t in times]
    mx = max(tot); ml, mr, mt, mb = 44, 150, 16, 26
    px = lambda i: ml + i / (len(times) - 1) * (W - ml - mr)
    py = lambda v: mt + (1 - v / mx) * (H - mt - mb)
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img">']
    for g in (0.25, 0.5, 0.75, 1):
        o.append(f'<line x1="{ml}" x2="{W - mr}" y1="{py(mx * g):.1f}" y2="{py(mx * g):.1f}" stroke="#eee"/><text x="{ml - 6}" y="{py(mx * g) + 4:.1f}" text-anchor="end" font-size="11" fill="var(--t-sec)">{c.n(mx * g, "bcm0")}</text>')
    base = [0] * len(times); mids = {}
    runs, cur = [], []
    for i, t in enumerate(times):
        if t in miss:
            if cur: runs.append(cur); cur = []
        else: cur.append(i)
    if cur: runs.append(cur)
    for j, k in enumerate(order):  # first in order sits at the bottom
        top = [base[i] + ser.get(k, {}).get(t, 0) for i, t in enumerate(times)]
        for run in runs:  # a missing month breaks the area instead of dropping to zero
            pts = " ".join(f"{px(i):.1f},{py(top[i]):.1f}" for i in run) + " " + " ".join(f"{px(i):.1f},{py(base[i]):.1f}" for i in reversed(run))
            o.append(f'<polygon points="{pts}" fill="{cols.get(k, greys[j % 5])}" stroke="#fff" stroke-width="0.4"/>')
        mids[k] = (base[-1] + top[-1]) / 2; base = top
    for t in miss:
        i = times.index(t)
        o.append(f'<text x="{px(i):.1f}" y="{H - mb - 4}" text-anchor="middle" font-size="10" fill="var(--t-sec)">{word("missing")} {FX.tlabel(t)}</text>')
    last = []
    for k in order:
        if k in cols: last.append([py(mids[k]), k])
    last.append([py(base[-1]) + 8, "_g"])
    last.sort()
    for i in range(1, len(last)):
        if last[i][0] - last[i - 1][0] < 16: last[i][0] = last[i - 1][0] + 16
    for y, k in last:
        txt = NAME(k) if k != "_g" else word("rest.n", n=len([x for x in order if x not in cols]))
        o.append(f'<text x="{W - mr + 8}" y="{y + 4:.1f}" font-size="12" fill="{cols.get(k, "var(--t-sec)")}" font-weight="{600 if k in cols else 400}">{esc(txt)}</text>')
    pk = c.F[d["mark"]]; i = times.index(pk["t"]); y = py(pk["v"])
    o.append(f'<line x1="{px(i):.1f}" x2="{px(i):.1f}" y1="{y:.1f}" y2="{mt + 2}" stroke="var(--t-title)" stroke-width="0.8"/>'
             f'<text x="{px(i) + 6:.1f}" y="{mt + 10}" font-size="12" fill="var(--t-title)">{word("peak", name=esc(need(d, "mark_name")))}{FX.tlabel(pk["t"])} {c.n(pk["v"])}</text>')
    av = c.F[d["avg"]]; ya = py(av["v"]); ay = need(d, "avg_year"); i0 = times.index(f"{ay}-01"); i1 = times.index(f"{ay}-12")
    o.append(f'<line x1="{px(i0):.1f}" x2="{px(i1):.1f}" y1="{ya:.1f}" y2="{ya:.1f}" stroke="var(--t-title)" stroke-dasharray="3 2"/>'
             f'<text x="{px(i1) + 4:.1f}" y="{ya - 4:.1f}" font-size="12" fill="var(--t-title)">{word("avg.month", y=ay, v=c.n(av["v"]), n=av["n"])}</text>')
    for yr in sorted({t[:4] for t in times}):
        if yr + "-01" in times: o.append(f'<text x="{px(times.index(yr + "-01")):.1f}" y="{H - 8}" font-size="11" fill="var(--t-sec)">{yr}</text>')
    o.append(f'<text x="{W - mr + 8}" y="{H - 8}" font-size="11" fill="var(--t-sec)">{esc(need(d, "unit"))}</text></svg>')
    return "".join(o)

def profile(c, d, W, H=220):
    """One series as a single-hue filled profile (SCMP elevation-strip style): a pale area for the context total behind it,
    no grid, notes written on the profile at the times of declared facts; a missing period breaks the fill."""
    one = series(c.T, d["q"]); one = {t: sum(v.get(t, 0) for v in one.values()) for t in {t for v in one.values() for t in v}}
    tot = series(c.T, d["total"]) if d.get("total") else {}
    tot = {t: sum(v.get(t, 0) for v in tot.values()) for t in {t for v in tot.values() for t in v}}
    times = sorted(t for t in one if t >= d.get("from", ""))
    if d.get("to"): times = [t for t in times if t <= d["to"]]
    allt = []  # every period between first and last, so gaps show
    y, m = int(times[0][:4]), int(times[0][5:])
    while f"{y}-{m:02d}" <= times[-1]: allt.append(f"{y}-{m:02d}"); y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    mx = max([one[t] for t in times] + [tot.get(t, 0) for t in times]); ml, mr, mt, mb = 4, 4, 54, 24
    px = lambda i: ml + i / (len(allt) - 1) * (W - ml - mr); py = lambda v: mt + (1 - v / mx) * (H - mt - mb)
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img">']
    def fill(src, col, op):
        run = []
        for i, t in enumerate(allt + [None]):
            if t in src and t in times: run.append(i); continue
            if len(run) > 1:
                pts = " ".join(f"{px(j):.1f},{py(src[allt[j]]):.1f}" for j in run)
                o.append(f'<polygon points="{px(run[0]):.1f},{py(0):.1f} {pts} {px(run[-1]):.1f},{py(0):.1f}" fill="{col}" fill-opacity="{op}"/>')
            run = []
    if tot: fill(tot, "var(--accent)", 0.16)
    fill(one, "var(--accent)", 0.95)
    o.append(f'<line x1="{ml}" x2="{W - mr}" y1="{py(0):.1f}" y2="{py(0):.1f}" stroke="var(--t-title)" stroke-width="0.8"/>')
    for t in allt:
        if t.endswith("-01"): o.append(f'<line x1="{px(allt.index(t)):.1f}" x2="{px(allt.index(t)):.1f}" y1="{py(0):.1f}" y2="{py(0) + 4:.1f}" stroke="var(--t-title)"/><text x="{px(allt.index(t)) + 3:.1f}" y="{H - 6}" font-size="11" fill="var(--t-sec)">{t[:4] if FX.LEDGER is None else FX.entry(f"period:{d['q']['table']}:{t[:4]}", "tspan", None)}</text>')
        if t not in one and times[0] < t < times[-1]:
            if FX.LEDGER is None: o.append(f'<text x="{px(allt.index(t)):.1f}" y="{py(0) - 4:.1f}" text-anchor="middle" font-size="10" fill="var(--t-sec)">{word("missing")}</text>')
            else: o.append(f'<line x1="{px(allt.index(t)):.1f}" x2="{px(allt.index(t)):.1f}" y1="{mt:.1f}" y2="{py(0):.1f}" stroke="var(--t-sec)" stroke-width="0.6" stroke-dasharray="2 2"/>')  # said in words beside the strip (a word has no ledger entry to mark it in svg)
    ends = {}  # label row -> right end of the last label in it
    for mk in d["marks"]:  # a note on the profile: leader from the value (a fact, or an event's month) up to a label row
        if "key" in mk: f = c.F[mk["key"]]; t = f.get("t") or mk["at"]; v = f["v"]
        else: t = mk["date"][:7]; v = one.get(t, 0)
        i = allt.index(t); x, yv = px(i), py(v)
        anc = "end" if x > W - 160 else "start"; dx = -4 if anc == "end" else 4
        wl = 12.5 * len(re.sub(r"<[^>]+>|\{[^}]+\}", "xxxx", mk["l"])) * (1 if anc == "start" else -1)
        row = next((r for r in (14, 30, 46) if (x if anc == "start" else x + wl) > ends.get(r, -999) + 8), 46)
        ends[row] = x + wl if anc == "start" else x
        o.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{yv:.1f}" y2="{row + 4}" stroke="var(--t-title)" stroke-width="0.7"/><circle cx="{x:.1f}" cy="{yv:.1f}" r="2.2" fill="var(--t-title)"/>'
                 f'<text x="{x + dx:.1f}" y="{row}" text-anchor="{anc}" font-size="12" fill="var(--t-title)">{svg_marks(FX.fill(c.spec, c.F, mk["l"]))}</text>')
    if d.get("legend"): o.append(f'<text x="{W - mr}" y="{H - 6}" text-anchor="end" font-size="11" fill="var(--t-sec)">{esc(d["legend"])}</text>')
    o.append("</svg>")
    return "".join(o)

def svg_marks(s):
    """A filled text's marks as svg tspans: a number bold; with a ledger each entry (b or span, marked with its src) a tspan
    that keeps its src, so the text's sources read back."""
    s = s.replace('<b class="n">', '<tspan font-weight="700">')
    if FX.LEDGER is not None: s = re.sub(r"<span\b", "<tspan", s.replace('<b class="n" ', '<tspan font-weight="700" ')).replace("</span>", "</tspan>")
    return s.replace("</b>", "</tspan>")

def events(d):
    """Rows of a sourced events table (date, label_zh, kind, source_name, source_url), kept to the page's range."""
    rows = list(FX.records(d["events"]))
    return [r for r in rows if d.get("from", "") <= r["date"] <= d.get("to", "9999") and (not d.get("kinds") or r["kind"] in d["kinds"])]

def timeline(c, d, W, H=None):
    """Thin context strip (SCMP 'Historical context'): one axis, a tick per event, each label in the lowest free row above
    the axis, reading right of its tick or, if that is taken, left of it; events of the focus kind in the accent, the rest in ink."""
    ev = events(d); y0, y1 = int(d["from"][:4]), int(d.get("to", ev[-1]["date"])[:4]) + 1
    t2x = lambda s: 6 + ((int(s[:4]) - y0) * 12 + int(s[5:7] or 1) - 1 + (int(s[8:10] or 15) - 1) / 31) / ((y1 - y0) * 12) * (W - 12)
    taken, rows = {}, []  # row -> occupied [left, right] spans
    free = lambda k, l, r: l >= 0 and r <= W and all(r + 8 < a or l > b + 8 for a, b in taken.get(k, []))
    for r in ev:
        x = t2x(r["date"]); wl = 12 * len(r["label_zh"]) + 6
        fwd = next(((k, x, x + wl, "start") for k in range(6) if free(k, x, x + wl)), None)
        back = next(((k, x - wl, x, "end") for k in range(6) if free(k, x - wl, x)), None)
        spot = back if back and (not fwd or back[0] < fwd[0]) else fwd
        if not spot: continue  # no room: the event stays in the table, not on the strip
        taken.setdefault(spot[0], []).append(spot[1:3]); rows.append((x, spot[0], spot[3], r))
    nr = max(k for _, k, _, _ in rows) + 1; top = 17 * nr + 8; H = top + 30
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img">', f'<rect x="6" y="{top - 3}" width="{W - 12}" height="4" fill="#d8d5cf"/>']
    for y in range(y0, y1 + 1):
        x = t2x(f"{y}-01-01"); o.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{top}" y2="{top + 6}" stroke="var(--t-title)"/>')
        if y < y1: o.append(f'<text x="{x + 3:.1f}" y="{top + 20}" font-size="11" fill="var(--t-sec)">{y}</text>')
    for x, k, anc, r in rows:
        focus = r["kind"] == d.get("focus_kind"); col = "var(--accent)" if focus else "var(--t-title)"; ly = top - 8 - 17 * k
        o.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{ly + 3}" y2="{top - 3}" stroke="{col}" stroke-width="0.7"{"" if focus else " stroke-dasharray=\'1.5 1.5\'"}/>'
                 f'<text x="{x + (3 if anc == "start" else -3):.1f}" y="{ly}" text-anchor="{anc}" font-size="12" fill="{col}"><title>{esc(r["source_name"])}</title>{esc(r["label_zh"])}</text>')
    o.append("</svg>")
    return "".join(o)

def minimaps(c, d, W, H=None):
    num, den = series(c.T, d["num"]), series(c.T, d["den"])
    w = (W - 16) / 2; parts = []
    for t in d["times"]:
        vals = {g: num.get(g, {}).get(t, 0) / den[g][t] for g in FX.members() if den.get(g, {}).get(t)}
        top = sorted(vals, key=vals.get, reverse=True)[:3]
        notes = [(g, f'{geo_name(g)} <tspan font-weight="700">{vals[g] * 100:.0f}%</tspan>') for g in top if vals[g] > 0]
        m = geo.choropleth(vals, None, scale=0.01, dec=0, unit="%", W=int(w), H=int(w * 0.85), notes=notes, vmin=0, vmax=1, read=word("date.y", y=t))
        parts.append(f'<div>{m}</div>')
    return f'<div class="mini">{"".join(parts)}</div><div class="note">{esc(d.get("note", ""))}</div>'

def bars(c, d, W, H=240):
    s = series(c.T, d["q"])["_"]; ts = sorted(s); mx = max(s.values())
    ml, mt, mb = 6, 30, 26; bw = (W - ml * 2) / len(ts)
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img">']
    for i, t in enumerate(ts):
        h = s[t] / mx * (H - mt - mb); x = ml + i * bw; hi = t in d["mark"]
        o.append(f'<rect x="{x + 3:.1f}" y="{H - mb - h:.1f}" width="{bw - 6:.1f}" height="{h:.1f}" fill="{"var(--accent2)" if hi else "var(--bar)"}"/>')
        if hi: o.append(f'<text class="v" x="{x + bw / 2:.1f}" y="{H - mb - h - 6:.1f}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--t-title)">{c.n(s[t], d.get("fmt", "bcm0"))}</text>')
        if i % 3 == 0 or hi: o.append(f'<text x="{x + bw / 2:.1f}" y="{H - 8}" text-anchor="middle" font-size="11" fill="var(--t-sec)">{t[2:] if not hi else t}</text>')
    o.append(f'<text x="{W}" y="12" text-anchor="end" font-size="11" fill="var(--t-sec)">{esc(need(d, "unit"))}</text></svg>')
    return "".join(o)

def step(c, d, W, H=240):
    s = series(c.T, d["q"])["_"]; ts = sorted(s); mx = max(s.values()) * 1.15
    ml, mr, mt, mb = 8, 8, 20, 26; sw = (W - ml - mr) / len(ts)
    py = lambda v: mt + (1 - v / mx) * (H - mt - mb)
    pts = []
    for i, t in enumerate(ts): pts += [f"{ml + i * sw:.1f},{py(s[t]):.1f}", f"{ml + (i + 1) * sw:.1f},{py(s[t]):.1f}"]
    o = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img"><line x1="{ml}" x2="{W - mr}" y1="{H - mb}" y2="{H - mb}" stroke="var(--t-sec)"/>',
         f'<polyline points="{" ".join(pts)}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>']
    for key in d["mark"]:
        f = c.F[key]; t = f.get("t") or f["src"]["time"]; i = ts.index(t); x = ml + (i + 0.5) * sw
        o.append(f'<circle cx="{x:.1f}" cy="{py(f["v"]):.1f}" r="4" fill="var(--accent)"/>'
                 f'<text class="v" x="{x:.1f}" y="{py(f["v"]) + (22 if key == d["mark"][0] else -10):.1f}" text-anchor="{"start" if i < len(ts) / 2 else "end"}" font-size="12" font-weight="700" fill="var(--accent)">{FX.fmt(c.spec, f)}</text>')
    for yr in sorted({t[:4] for t in ts}):
        if yr + "-S1" in ts and int(yr) % 2 == 1: o.append(f'<text x="{ml + ts.index(yr + "-S1") * sw:.1f}" y="{H - 8}" font-size="11" fill="var(--t-sec)">{yr}</text>')
    o.append(f'<text x="{W}" y="12" text-anchor="end" font-size="11" fill="var(--t-sec)">{esc(need(d, "unit"))}</text></svg>')
    return "".join(o)

def illus_(c, d, W, H=300):
    return illus.scene([(a["art"], c.t(a["note"]), c.t(a["sub"])) for a in d["art"]], W, H)

def text(c, d, W, H=None):
    return f'<p class="concl">{c.t(d["text"])}</p>'

CHARTS = dict(flowmap=flowmap, profile=profile, timeline=timeline, slope=slope, ledger=ledger, stack_area=stack_area, minimaps=minimaps, bars=bars, step=step, illus=illus_, text=text)

def width(area):
    _, c0, _, c1 = [int(x) for x in area.split("/")]
    n = c1 - c0; return round(n * COLW + (n - 1) * GAP)

def page(spec):
    spec["fmts"]["bcm0"] = {"scale": 0.01, "dec": 0}
    c = Ctx(spec); mods = []
    for i, m in enumerate(spec["modules"]):
        body = CHARTS[m["data"]["chart"]](c, m["data"], width(m["area"]))
        cls = "mod" + (" big" if m.get("big") else "") + (" end" if m["kind"] == "结论" else "")
        mods.append(f'<section class="{cls}" style="grid-area:{m["area"]}"><div class="tag"><span class="no">{"①②③④⑤⑥⑦⑧⑨"[i]}</span>{m["name"]}</div>'
                    f'<div class="wh">{c.t(m["h"])}</div>{body}</section>')
    css = open(os.path.join(FX.D, "tokens.css")).read() + ":root{--accent:#d8452f;--accent2:#3f6fb5;--bar:#d6d6d6}" + CSS
    return (f'<!doctype html><html lang="zh"><meta charset="utf-8"><title>{word("page.title")}</title><style>{css}</style><body><div class="pg">'
            f'<header><div class="kicker">{esc(spec["kicker"])}</div><h1>{c.t(spec["title"])}</h1><p class="dek">{c.t(spec["dek"])}</p></header>'
            f'<div class="grid">{"".join(mods)}</div>'
            f'<footer>{word("footer.source", v=esc(spec["source"]))}{esc(spec.get("note", ""))}</footer></div></body></html>')

CSS = """.pg{width:1180px;margin:0 auto;padding:40px 20px}
header{max-width:1000px;margin-bottom:22px}header h1{font-size:44px;line-height:56px}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:28px 30px;align-items:start}
.mod{border-top:2px solid var(--t-title);padding-top:8px}.mod.big{border-top-width:5px}
.tag{font:600 14px/20px var(--sans);color:var(--t-sec)}.no{color:var(--accent);font-size:18px;margin-right:6px}
.wh{font:600 17px/26px var(--sans);color:var(--t-title);margin:4px 0 10px}b.n{color:var(--accent)}
.card{max-width:none;margin:0}.card h3{display:none}.mini{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.note{font-size:12px;color:var(--t-sec);margin-top:4px}
.ledger2{font-size:13px;line-height:22px}.lh,.lr{display:grid;grid-template-columns:1fr 96px 110px;border-bottom:1px solid var(--rule)}
.lh{color:var(--t-sec);font-size:12px}.lr .v{text-align:right;padding-right:10px;font-variant-numeric:tabular-nums;color:var(--t-title)}
.lr em{font-style:normal;color:var(--t-sec);text-align:right}.lr.sum{font-weight:600;border-top:1px solid var(--t-title)}.lr.sum em{font-weight:400}
.concl{font:600 19px/32px var(--serif);color:var(--t-title);margin:0}
footer{margin-top:28px;border-top:1px solid var(--rule);padding-top:10px;font-size:12px;color:var(--t-sec)}"""

if __name__ == "__main__":
    spec = json.load(open(os.path.join(FX.D, sys.argv[1])))
    open(os.path.join(FX.D, "page-" + sys.argv[1].replace("page-", "").replace(".json", ".html")), "w").write(page(spec))
