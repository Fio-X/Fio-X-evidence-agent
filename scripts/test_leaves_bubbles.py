"""Self-test of the bubbles leaf (runtime/leaves_py/bubbles.py) on the Natural Earth land (runtime/pi/assets): a dispersed world
set draws (test-only values), a crowded European set (World Bank 65+ share, scripts/fixtures/data_prepare/worldbank/q5.json)
refuses at max_overlaps 0 and draws when allowed; each point is the place's Natural Earth label point; names from the
project's reviewed zh names. Each svg reads back with no `bad`, every digit sits inside a marked ledger run, no label sits on
any circle or on another label (one that fits nowhere is listed in Frame.unlabeled, never moved onto a circle), and the
refusals keep the leaf's rules. Run: python3 -I -B scripts/test_leaves_bubbles.py"""
import json
import math
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
import bubbles  # noqa: E402
import geo  # noqa: E402
import prod  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

ASSETS = os.path.join(HERE, "..", "runtime", "pi", "assets")
SHP = os.path.join(ASSETS, "naturalearth-admin0-50m.geojson")
ZH3 = {e["iso3"]: e["zh"] for e in json.load(open(os.path.join(ASSETS, "economy-names.json"), encoding="utf-8"))["economies"]}
POINT = {f["iso3"]: f["label"] for f in json.load(open(os.path.join(ASSETS, "naturalearth-admin0-50m-attributes.json"), encoding="utf-8"))["features"]}
WB = json.load(open(os.path.join(HERE, "fixtures", "data_prepare", "worldbank", "q5.json"), encoding="utf-8"))[1]
W = lambda t: [{"w": t}]


def check_svg(svg):
    """What is wrong with a drawn svg: texts the read-back cannot place, none at all, a digit outside a marked ledger run."""
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def value_set(values, year, dec, unit):
    rows, items = [{"src": "fact:pc", "text": unit}], []
    for c, v in values.items():
        rows += [{"src": f"series:T/{c}:{year}:OBS_VALUE", "table": "T", "dims": {"k": c}, "time": year, "value": v},
                 {"src": f"fact:v.{c}", "text": f"{v:,.{dec}f}"}]
        items.append(dict(code=c, value=f"series:T/{c}:{year}:OBS_VALUE", value_text=f"fact:v.{c}", lonlat=POINT[c]))
    return rows, items, {c: ZH3[c] for c in values}


WORLD = dict(zip("CHN BRA IND RUS AUS USA VNM GRL".split(), [44, 21, 6.9, 3.8, 5.7, 1.9, 3.5, 1.5]))  # test-only values
W_ROWS, W_ITEMS, W_LABELS = value_set(WORLD, "2024", 1, "百万吨")
W_DATA = dict(title=W("储量（测试数）"), unit=[{"w": "单位："}, {"src": "fact:pc"}], items=W_ITEMS)
EU = {c: next(x["value"] for x in WB if x["countryiso3code"] == c and x["date"] == "2025") for c in "MCO JPN PRI ITA PRT GRC FIN DEU".split()}
E_ROWS, E_ITEMS, E_LABELS = value_set(EU, "2025", 1, "%")
E_DATA = dict(title=W("老龄人口占比"), unit=[{"w": "占总人口 "}, {"src": "fact:pc"}], items=E_ITEMS)


def hero(data, **style):
    return {"data": data, "style": {"bubbles": style}}


def setup(rows, labels, shapes=SHP):
    K.setup(rows, labels, run.tables)
    geo.NE = shapes


def gap(b, j):
    """The distance from a label box to circle j's centre."""
    x, y = j["_xy"]
    return math.hypot(max(b[0] - x, 0, x - b[2]), max(b[1] - y, 0, y - b[3]))


class Bubbles(unittest.TestCase):
    def test_a_world_set_draws(self):
        setup(W_ROWS, W_LABELS)
        svg, _, _ = bubbles.draw(hero(W_DATA, highlight="CHN"))
        self.assertEqual(check_svg(svg), [])
        self.assertEqual(svg.count("<circle"), 8)

    def test_a_crowded_set_refuses_unless_allowed(self):
        setup(E_ROWS, E_LABELS)
        with self.assertRaises(Refused) as e:
            bubbles.draw(hero(E_DATA, nudge=0))
        self.assertIn("overlap by more than half", str(e.exception))
        svg, _, _ = bubbles.draw(hero(E_DATA, nudge=0, max_overlaps=20))
        self.assertEqual(check_svg(svg), [])

    def test_overlapping_circles_are_nudged_apart_within_reach_and_keep_a_dot_at_their_point(self):
        # the crowded set: nudging (the default nudge) moves each circle at most nudge px off its point, leaves less of the
        # circles overlapping than no nudge does, and every moved circle has a dot drawn at its true point
        setup(E_ROWS, E_LABELS)
        overlaps = lambda f: sum(bubbles.lens(a, b) for x, a in enumerate(f.items) for b in f.items[x + 1:])
        still = bubbles.Frame(hero(E_DATA, nudge=0, max_overlaps=20)); f = bubbles.Frame(hero(E_DATA, max_overlaps=20))
        most = bubbles.prod.KNOBS["bubbles"]["nudge"][0]
        self.assertLess(overlaps(f), overlaps(still))
        moved = [i for i in f.items if math.dist(i["_xy"], i["_at"]) > 0.5]
        self.assertTrue(moved)
        self.assertTrue(all(math.dist(i["_xy"], i["_at"]) <= most + 1e-6 for i in f.items))
        svg = bubbles.cl_bubbles(f, prod.Occ())
        self.assertEqual(sorted(re.findall(r'data-at="([A-Z]+)"', svg)), sorted(i["code"] for i in moved))
        self.assertEqual(check_svg(svg), [])

    def test_no_label_sits_on_a_circle_or_another_label(self):
        for tag, rows, labels, data in (("world", W_ROWS, W_LABELS, W_DATA), ("crowded", E_ROWS, E_LABELS, E_DATA)):
            with self.subTest(tag):
                setup(rows, labels)
                f = bubbles.Frame(hero(data, max_overlaps=20))
                bubbles.cl_bubbles(f, prod.Occ())
                self.assertTrue(f.label_boxes)
                self.assertEqual(len(f.label_boxes) + len(f.unlabeled), min(len(f.items), bubbles.prod.KNOBS["bubbles"]["label_top"][0]))
                self.assertEqual(f.dropped, [(c, "no free place for the label") for c in f.unlabeled])  # reported, not silent
                for code, b in f.label_boxes:
                    self.assertEqual([j["code"] for j in f.items if gap(b, j) < j["_r"]], [], code)
                for i, (c1, a) in enumerate(f.label_boxes):
                    for c2, b in f.label_boxes[i + 1:]:
                        self.assertFalse(a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3], f"{c1}/{c2}")

    def test_the_refusals(self):
        neg = [dict(r, value=-1.0) if "/CHN:" in r["src"] else r for r in W_ROWS]
        for tag, h, rows, labels, shapes, why in [
            ("no-shapes", hero(W_DATA), W_ROWS, W_LABELS, None, "Natural Earth"),
            ("no-point", hero(dict(W_DATA, items=[dict(W_ITEMS[0], lonlat=None)] + W_ITEMS[1:])), W_ROWS, W_LABELS, SHP, "lon/lat"),
            ("negative", hero(W_DATA), neg, W_LABELS, SHP, "negative"),
            ("outside-box", hero(dict(W_DATA, box=[-20, 30, 40, 70]), extent="box"), W_ROWS, W_LABELS, SHP, "outside the extent"),
            ("box-missing", hero(W_DATA, extent="box"), W_ROWS, W_LABELS, SHP, "data.box"),
            ("unknown-highlight", hero(W_DATA, highlight="XXX"), W_ROWS, W_LABELS, SHP, "codes the request does not hold"),
            ("no-name", hero(W_DATA), W_ROWS, {k: v for k, v in W_LABELS.items() if k != "CHN"}, SHP, "CHN"),
            ("unit-as-string", hero(dict(W_DATA, unit="fact:pc")), W_ROWS, W_LABELS, SHP, "given as a ledger source"),
            ("no-items", hero(dict(W_DATA, items=[])), W_ROWS, W_LABELS, SHP, "no items"),
            ("not-a-series", hero(dict(W_DATA, items=[dict(W_ITEMS[0], value="series:T/ZZZ:2024:OBS_VALUE")])), W_ROWS, W_LABELS, SHP,
             "not a series of the request"),
        ]:
            with self.subTest(tag), self.assertRaises(Refused) as e:
                setup(rows, labels, shapes)
                bubbles.draw(h)
            self.assertIn(why, str(e.exception), tag)



# layer 1's map extent for a column page (src/next_run.rs map_extent), as it computes it: the points' box, past each side as
# far as the circle nearest it needs for its label beside it (radius, label_gap + 1, the wider of name and number, the
# hairline inset + 2) and above or below it (radius, label_gap + 1, the label's two lines, inset + 2), MAP_PAD degrees at
# least; px to degrees through the shared frame (mapkit.View, column.MAP_W wide), grown until it holds
RS = open(os.path.join(HERE, "..", "src", "next_run.rs"), encoding="utf-8").read()
RS_CONST = {k: float(v) for k, v in re.findall(r"^const (MAP_PAD|MAP_W_PX|BUBBLE_R_MAX_PX|BUBBLE_R_MIN_PX|BUBBLE_LABEL_PX|BUBBLE_LABEL_GAP_PX|MAP_INSET_PX): f64 = ([\d.]+);", RS, re.M)}


def layer1_extent(points, labels, dec):
    """points {code: [lon, lat]}, labels {code: (value, name)}: the extent layer 1 gives the map leaves."""
    c = RS_CONST; W, sz = c["MAP_W_PX"], c["BUBBLE_LABEL_PX"]; vmax = max([v for v, _ in labels.values()] + [0.0])
    room = []
    for code, p in points.items():
        v, name = labels[code]; r = max(c["BUBBLE_R_MAX_PX"] * math.sqrt(max(v, 0) / vmax), c["BUBBLE_R_MIN_PX"]) if vmax > 0 else c["BUBBLE_R_MIN_PX"]
        w = max(prod.tw(name, sz), prod.tw(f"{v:,.{dec}f}", sz)); g, e = c["BUBBLE_LABEL_GAP_PX"] + 1, c["MAP_INSET_PX"] + 2
        room.append((p, r + g + w + e, r + g + 2.45 * sz + e))
    lo0, la0 = min(p[0] for p in points.values()), min(p[1] for p in points.values())
    lo1, la1 = max(p[0] for p in points.values()), max(p[1] for p in points.values())
    clamp = lambda x: [max(x[0], -180), max(x[1], -90), min(x[2], 180), min(x[3], 90)]
    pad = c["MAP_PAD"]; ext = clamp([lo0 - pad, la0 - pad, lo1 + pad, la1 + pad])
    for _ in range(64):
        xp = W / (ext[2] - ext[0]); yp = xp / max(math.cos(math.radians((ext[1] + ext[3]) / 2 + 2)), 0.05)
        side = lambda far, px, k: max([pad] + [q[k] / px - far(q[0]) for q in room])
        nxt = clamp([min(ext[0], lo0 - side(lambda p: p[0] - lo0, xp, 1)), min(ext[1], la0 - side(lambda p: p[1] - la0, yp, 2)),
                     max(ext[2], lo1 + side(lambda p: lo1 - p[0], xp, 1)), max(ext[3], la1 + side(lambda p: la1 - p[1], yp, 2))])
        moved = any(abs(a - b) > 1e-9 for a, b in zip(nxt, ext)); ext = nxt
        if not moved: break
    return ext


def map_set(values, dec, point_of, names):
    """A column page's map leaf input for values {code: v}: the rows, the items (each at its Natural Earth label point) and names."""
    rows, items = [], []
    for c, v in values.items():
        rows += [{"src": f"series:T/{c}:2025:OBS_VALUE", "table": "T", "dims": {"k": c}, "time": "2025", "value": v},
                 {"src": f"fact:v.{c}", "text": f"{v:,.{dec}f}"}]
        items.append(dict(code=c, value=f"series:T/{c}:2025:OBS_VALUE", value_text=f"fact:v.{c}", lonlat=point_of(c)))
    return rows, items, {c: names[c] for c in values}


def box_pad(items, pad=4.0):
    """The extent layer 1 gave before: the points' box, a fixed pad of degrees past it."""
    lo, la = [i["lonlat"][0] for i in items], [i["lonlat"][1] for i in items]
    return [min(lo) - pad, min(la) - pad, max(lo) + pad, max(la) + pad]


# the q5 change page's world map (test-only values as its page printed them): China's label found no place on the old extent
Q5 = dict(USA=18.39, CHN=14.90, BRA=11.48, IDN=7.54, IND=7.38, BGD=6.67, PAK=4.36, NGA=3.07)
# an EU table (iso2 codes, test-only values): Cyprus the biggest on the box's east and south edges, Portugal on its west,
# Finland on its north
EU2 = dict(CY=31.0, PT=24.6, FI=23.9, DK=20.8, ES=20.6, EE=21.0, MT=20.1, RO=19.8, IE=15.4, LU=15.0)
NAMES2 = json.load(open(os.path.join(ASSETS, "economy-names.json"), encoding="utf-8"))["economies"]
ISO3 = {e["iso2"]: e["iso3"] for e in NAMES2}
ZH2 = {e["iso2"]: e["zh"] for e in NAMES2}


class MapExtent(unittest.TestCase):
    def draw(self, values, dec, point_of, names, ext=None, **style):
        rows, items, labels = map_set(values, dec, point_of, names)
        setup(rows, labels)
        ext = ext or layer1_extent({i["code"]: i["lonlat"] for i in items}, {c: (v, labels[c]) for c, v in values.items()}, dec)
        f = bubbles.Frame({"data": {"items": items, "ext": ext}, "style": {"bubbles": {**run.MAP_STYLE["bubbles"], **style}}})
        svg = bubbles.cl_bubbles(f, prod.Occ())
        self.assertEqual(check_svg(svg), [])
        return f, items

    def test_layer_1_draws_the_map_the_leaf_draws(self):
        # the frame layer 1 measures its labels' room in is the column page's map panel as the leaf draws it: its width, and
        # the bubbles' radius scale, label size, label gap and inset as run.MAP_STYLE leaves them
        import column
        style, knob = run.MAP_STYLE["bubbles"], lambda k: prod.KNOBS["bubbles"][k][0]
        self.assertEqual(set(RS_CONST), {"MAP_PAD", "MAP_W_PX", "BUBBLE_R_MAX_PX", "BUBBLE_R_MIN_PX", "BUBBLE_LABEL_PX", "BUBBLE_LABEL_GAP_PX", "MAP_INSET_PX"})
        self.assertEqual((style["projection"], style["width"]), ("view", column.MAP_W))
        self.assertEqual(RS_CONST["MAP_W_PX"], column.MAP_W)
        for rs, k in (("BUBBLE_R_MAX_PX", "r_max"), ("BUBBLE_R_MIN_PX", "r_min"), ("BUBBLE_LABEL_PX", "size"), ("BUBBLE_LABEL_GAP_PX", "label_gap"), ("MAP_INSET_PX", "inset")):
            self.assertNotIn(k, style, k)
            self.assertEqual(RS_CONST[rs], knob(k), k)

    def test_a_world_tables_edge_circles_keep_their_labels(self):
        # every circle labelled on the extent layer 1 gives, China's beside it on the box's east edge among them; on the old
        # extent (a fixed 4 degrees past the box: some 11 px here) China's label found no place
        f, items = self.draw(Q5, 2, POINT.get, ZH3)
        self.assertEqual(f.dropped, [])
        self.assertEqual(sorted(c for c, _ in f.label_boxes), sorted(Q5))
        f, _ = self.draw(Q5, 2, POINT.get, ZH3, ext=box_pad(items))
        self.assertEqual(f.dropped, [("CHN", "no free place for the label")])

    def test_an_eu_tables_edge_circles_keep_their_labels(self):
        f, _ = self.draw(EU2, 1, lambda c: POINT[ISO3[c]], ZH2)
        self.assertEqual(f.dropped, [])
        self.assertEqual(sorted(c for c, _ in f.label_boxes), sorted(EU2))

    def test_a_map_whose_labels_fit_keeps_the_old_extent(self):
        # a small box (four EU countries, as layer 1's column page test): 4 degrees already hold every label, so the extent is
        # the old one to the bit
        pts = {c: POINT[ISO3[c]] for c in ("SE", "DE", "FR", "BE")}
        labels = {"SE": (65.4, "名SE"), "BE": (14.9, "名BE"), "DE": (30.25, "名DE"), "FR": (20.0, "名FR")}
        self.assertEqual(layer1_extent(pts, labels, 2), box_pad([{"lonlat": p} for p in pts.values()]))

    def test_of_leader_places_that_cost_the_same_the_one_toward_the_frames_centre_is_taken(self):
        # one labelled circle right of the frame's centre, small circles on its four sides' label places: its label goes out
        # on a leader, and of the clear places 16 px off (all over the land, the same cost) it takes one toward the centre
        # (red before: there the tie went by float noise, to the place down and right, away from the centre)
        at = {"CHN": [30, 10], "IND": [33.21, 9.79], "PAK": [26.79, 9.79], "BGD": [30, 13.0], "NPL": [30, 7.0]}
        f, _ = self.draw(dict(CHN=14.9, IND=0.3, PAK=0.3, BGD=0.3, NPL=0.3), 2, at.get, ZH3, ext=[0, 0, 40, 20], label_top=1)
        self.assertEqual(f.dropped, [])
        (code, bx), = f.label_boxes
        c = next(i for i in f.items if i["code"] == code)
        self.assertLess(bx[2], c["_xy"][0])  # the label ends left of the circle's centre, toward the frame's middle


def colour(hexs):
    return [int(hexs[k:k + 2], 16) / 255 for k in (1, 3, 5)]


def luminance(rgb):
    """WCAG 2 relative luminance of an sRGB colour (channels 0..1)."""
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


class Contrast(unittest.TestCase):
    def test_a_labels_number_keeps_wcag_aa_on_the_land_and_on_the_page_ground(self):
        # the page's colours: tokens.css under the page's own :root (scmp.PAGE_ROOT, its ground); the land is --t-dark at the
        # leaf's LAND_OPACITY over that ground, as the browser blends it
        import scmp
        root = {}
        for css in (open(os.path.join(HERE, "..", "runtime", "leaves_py", "tokens.css"), encoding="utf-8").read(), scmp.PAGE_ROOT):
            root.update(re.findall(r"(--[\w-]+):(#[0-9a-fA-F]{6})", css))
        ground, dark = colour(root["--bg"]), colour(root["--t-dark"])
        land = [bubbles.LAND_OPACITY * d + (1 - bubbles.LAND_OPACITY) * g for d, g in zip(dark, ground)]
        ink = colour(root[bubbles.VALUE_INK])
        self.assertGreaterEqual(contrast(ink, land), 4.5)
        self.assertGreaterEqual(contrast(ink, ground), 4.5)
        self.assertGreaterEqual(contrast(colour(root["--t-sec"]), ground), 4.5)  # the grey it replaces keeps AA on the ground,
        self.assertLess(contrast(colour(root["--t-sec"]), land), 4.5)  # but not on the land
        # and the drawn labels' numbers use it
        setup(W_ROWS, W_LABELS)
        svg, _, _ = bubbles.draw(hero(W_DATA))
        fills = set(re.findall(r'<text[^>]*fill="([^"]+)"[^>]*><tspan data-src="fact:v\.', svg))
        self.assertEqual(fills, {f"var({bubbles.VALUE_INK})"})

    def test_every_text_ink_of_a_leaf_page_keeps_wcag_aa_on_the_page_ground_and_on_white(self):
        # the inks a leaf page sets text in (title, body, dek, secondary, the page's accent), from tokens.css under the page's
        # own :root (scmp.PAGE_ROOT), and prod.page's own accent (prod.PAGE_ROOT): each at least 4.5:1 (WCAG 2 SC 1.4.3, body text) on the
        # ground and on #fff, the same floor layer 1 holds a baked page's measured text to
        import scmp
        root = {}
        for css in (open(os.path.join(HERE, "..", "runtime", "leaves_py", "tokens.css"), encoding="utf-8").read(), scmp.PAGE_ROOT):
            root.update(re.findall(r"(--[\w-]+):(#[0-9a-fA-F]{6})", css))
        inks = {k: root[k] for k in ("--t-title", "--t-body", "--t-dek", "--t-sec", "--accent")}
        inks["prod.page --accent"] = dict(re.findall(r"(--[\w-]+):(#[0-9a-fA-F]{6})", prod.PAGE_ROOT))["--accent"]
        for name, ink in inks.items():
            for ground in (root["--bg"], "#ffffff"):
                self.assertGreaterEqual(contrast(colour(ink), colour(ground)), 4.5, f"{name} {ink} on {ground}")

    # The knobs of the map, ring and scmp groups (knobs.json) that set a text's colour, and where that text sits: a map text on
    # the map's fills, an html one beside the picture on the page ground; and the knobs named like a colour or a size that set
    # no text, each with what it sets instead. A new knob of these groups with such a name is neither until it is listed.
    TEXT_INKS = {("names", "ink"): "map", ("route_names", "ink"): "map", ("cities", "ink"): "map", ("callouts", "ink"): "page"}
    NOT_TEXT = {("edge", "ink"): "the edge arrows' stroke", ("inset", "ink"): "the inset's flow lines",
                ("ring", "color"): "the ring band's fill", ("labels", "fit"): "how the labels fit, not a size"}
    TEXT_SIZES = {("names", "size"), ("route_names", "size"), ("cities", "size"), ("inset", "size"), ("labels", "size"),
                  ("legend", "size"), ("ring", "year_size"), ("ring", "mark_size"), ("callouts", "head"), ("callouts", "body"),
                  ("bignums", "size")}
    OTHER_SIZES = {("bignums", "min"): "the big number's smallest size before its unit wraps"}

    def knob_table(self):
        table = json.load(open(os.path.join(HERE, "..", "runtime", "leaves_py", "knobs.json"), encoding="utf-8"))
        groups = table["groups"]
        nodes = sorted({n for g in ("map", "ring", "scmp") for n in groups[g]})
        return table, {(n, k["name"]): k for n in nodes for k in table["nodes"].get(n, {}).get("knobs", [])}

    def test_every_text_ink_knob_of_the_map_ring_and_scmp_pages_keeps_wcag_aa_where_its_text_sits(self):
        # each text-colour knob's default and every option (a page may pick any), resolved from tokens.css under the page's
        # own :root (scmp.PAGE_ROOT): at least 4.5:1 (WCAG 2 SC 1.4.3, body text) on the page ground and on #fff, and a map
        # text also on each default fill of the base map it is drawn over (sea, land, member states); the same floor layer 1
        # holds a baked page's measured text to
        import scmp
        root = {}
        for css in (open(os.path.join(HERE, "..", "runtime", "leaves_py", "tokens.css"), encoding="utf-8").read(), scmp.PAGE_ROOT):
            root.update(re.findall(r"(--[\w-]+):(#[0-9a-fA-F]{6})", css))
        table, knobs = self.knob_table()
        base = {k["name"]: k["default"] for k in table["nodes"]["base"]["knobs"]}
        grounds = {"page": [root["--bg"], "#ffffff"], "map": [root["--bg"], "#ffffff", base["sea"], base["land"], base["member"]]}
        named = {key for key in knobs if key[1] in ("ink", "color", "colour") or "fill" in key[1]}
        self.assertEqual(named - set(self.NOT_TEXT), set(self.TEXT_INKS), "a colour knob of these groups is listed as text or not")
        for key, where in self.TEXT_INKS.items():
            k = knobs[key]
            for ink in dict.fromkeys([k["default"], *k["options"]]):
                hexs = root[re.fullmatch(r"var\((--[\w-]+)\)", ink).group(1)] if ink.startswith("var(") else ink
                for ground in grounds[where]:
                    self.assertGreaterEqual(contrast(colour(hexs), colour(ground)), 4.5, f"{key} {ink} on {ground}")
        # the names' grey keeps its hue: the same warm grey family as the one it replaces
        self.assertEqual(knobs[("names", "ink")]["default"], prod.MAP_GREY)

    def test_every_text_size_knob_of_the_map_ring_and_scmp_pages_defaults_to_the_type_floor(self):
        # the page check's smallest text, 11 px at 1440 wide (src/next_run.rs TYPE_FLOOR_PX); these pages draw their svg at
        # one user unit a px, so a size knob's default is the size the check measures
        _, knobs = self.knob_table()
        named = {key for key in knobs if "size" in key[1] or key[1] in ("head", "body")}
        self.assertEqual(named, self.TEXT_SIZES, "a size knob of these groups is listed as a text size")
        for key in sorted(self.TEXT_SIZES | set(self.OTHER_SIZES)):
            self.assertGreaterEqual(knobs[key]["default"], 11, f"{key}")

    def test_the_source_line_is_set_at_the_labels_floor_in_body_ink_and_the_page_ends_close_under_it(self):
        # a leaf page's shell (scmp.shell: the ring, column and scmp pages): the footer's rule that wins (the last in the page's
        # css) sets the source line at the labels' smallest size (the low end of the bars' and the map labels' size knobs) in an
        # ink that keeps WCAG AA (4.5:1) on the page ground, the page's bottom padding is at most 20 px, and the source text is
        # printed as the spec gives it
        import rankbar, scmp
        src = "Eurostat sdg_07_40 「Share of renewable energy in gross final energy consumption by sector」"
        html = scmp.shell(None, {"source": src, "refs": ["sdg_07_40"]}, "<div class=hero></div>")
        css = re.search(r"<style>(.*)</style>", html, re.S).group(1)
        rule = lambda sel, prop: [m for r in re.findall(r"(?:^|})\s*" + sel + r"\{([^}]*)\}", css) for m in re.findall(prop, r)]
        sizes = rule("footer", r"font(?:-size)?:[^;]*?(\d+)px")
        self.assertEqual(float(sizes[-1]), min(prod.KNOBS["rankbar"]["size"][1][0], prod.KNOBS["bubbles"]["size"][1][0]))
        ink = rule("footer", r"color:var\((--[\w-]+)\)")[-1]
        root = {}
        for c in (open(os.path.join(HERE, "..", "runtime", "leaves_py", "tokens.css"), encoding="utf-8").read(), scmp.PAGE_ROOT):
            root.update(re.findall(r"(--[\w-]+):(#[0-9a-fA-F]{6})", c))
        self.assertGreaterEqual(contrast(colour(root[ink]), colour(root["--bg"])), 4.5, ink)
        self.assertLessEqual(int(rule(r"\.pg", r"padding-bottom:(\d+)px")[-1]), 20)
        self.assertIn(prod.esc(src), re.sub(r"<[^>]+>", "", re.search(r"<footer>(.*)</footer>", html).group(1)))


if __name__ == "__main__":
    unittest.main()
