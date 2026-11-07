"""Self-test of the bubbles leaf (runtime/leaves_py/bubbles.py) on the Natural Earth land (runtime/pi/assets): a dispersed world
set draws (test-only values), a crowded European set (World Bank 65+ share, scripts/fixtures/data_prepare/worldbank/q5.json)
refuses at max_overlaps 0 (no nudge, even at the r_max floor) and draws when allowed; circles that overlap at r_max
are drawn on a smaller scale (r_used) until they clear, by area still, and maps that clear at r_max draw byte for byte as before; only the
focus circle takes the accent and the notes' other places the dark grey; the key drawn after the bubbles (bubble_key) names the measure and the map's year, its reference circles
the map's own at their radii and values, its box claimed off every circle and label, the measure's name left out only when its
line is wider in px than the map's rect; each point is the place's Natural Earth label point; names from the
project's reviewed zh names. Each svg reads back with no `bad`, every digit sits inside a marked ledger run, no label sits on
any circle or on another label (one that fits nowhere is listed in Frame.unlabeled, never moved onto a circle), and the
refusals keep the leaf's rules. Run: python3 -I -B scripts/test_leaves_bubbles.py"""
import hashlib
import json
import math
import os
import re
import sys
import types
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
        self.assertIn("even at r_max 12", str(e.exception))  # every smaller scale down to the knob's floor tried first
        svg, _, _ = bubbles.draw(hero(E_DATA, nudge=0, max_overlaps=20))
        self.assertEqual(check_svg(svg), [])

    def test_overlapping_circles_are_nudged_apart_within_reach_and_keep_a_dot_at_their_point(self):
        # the crowded set: nudging (the default nudge) moves each circle at most nudge px off its point, leaves less of the
        # circles overlapping than no nudge does, and every moved circle has a dot drawn at its true point
        setup(E_ROWS, E_LABELS)
        overlaps = lambda f: sum(bubbles.lens(a, b) for x, a in enumerate(f.items) for b in f.items[x + 1:])
        still = bubbles.Laid(hero(E_DATA, nudge=0, max_overlaps=20)); f = bubbles.Laid(hero(E_DATA, max_overlaps=20))
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
                f = bubbles.Laid(hero(data, max_overlaps=20))
                bubbles.cl_bubbles(f, prod.Occ())
                self.assertTrue(f.label_boxes)
                self.assertEqual(len(f.label_boxes) + len(f.unlabeled), min(len(f.items), bubbles.prod.KNOBS["bubbles"]["label_top"][0]))
                self.assertEqual(f.dropped, [(c, "no free place for the label") for c in f.unlabeled])  # reported, not silent
                for code, b in f.label_boxes:
                    self.assertEqual([j["code"] for j in f.items if gap(b, j) < j["_r"]], [], code)
                for i, (c1, a) in enumerate(f.label_boxes):
                    for c2, b in f.label_boxes[i + 1:]:
                        self.assertFalse(a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3], f"{c1}/{c2}")

    def test_a_value_below_0_is_an_outlined_circle_of_its_size(self):
        # 11-07 (round 2: s6, t7, n47 stopped on a circle below 0): drawn by its value's size, outlined, no longer a refusal
        neg = [dict(r, value=-r["value"]) if "/CHN:" in r["src"] else r for r in W_ROWS]
        setup(W_ROWS, W_LABELS, SHP); plain = bubbles.draw(hero(W_DATA))[0]
        setup(neg, W_LABELS, SHP); svg = bubbles.draw(hero(W_DATA))[0]
        r_of = lambda s, c: float(re.search(r'<circle [^>]*r="([0-9.]+)"[^>]*data-code="' + c + '"', s)[1])
        self.assertEqual(len(re.findall(r'data-sign="neg"', svg)), 1)
        # at the placed radius (the core's drawn-circle check compares r as printed) and its fill the ink at no opacity (the
        # accent's check reads fill); dashed, as its key circle is
        self.assertRegex(svg, r'<circle [^>]*fill="var\(--[a-z-]+\)" fill-opacity="0" [^>]*stroke-dasharray="3 2" data-code="CHN" data-sign="neg"')
        self.assertEqual(r_of(svg, "CHN"), r_of(plain, "CHN"))
        self.assertNotIn('data-sign="neg"', plain)

    def test_the_refusals(self):
        for tag, h, rows, labels, shapes, why in [
            ("no-shapes", hero(W_DATA), W_ROWS, W_LABELS, None, "Natural Earth"),
            ("no-point", hero(dict(W_DATA, items=[dict(W_ITEMS[0], lonlat=None)] + W_ITEMS[1:])), W_ROWS, W_LABELS, SHP, "lon/lat"),
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



# the visual group's map extent for a column page (src/next_tree_gen.rs extent_of, rule extent), as it computes it: the
# points' box, past each side as far as the circle nearest it needs for its label beside it (radius, label_gap + 1, the wider
# of name and number, the hairline inset + 2) and above or below it (radius, label_gap + 1, the label's two lines, inset +
# 2), the frame's pad degrees at least; px to degrees through the shared frame (mapkit.View, column.MAP_W wide), grown until
# it holds. Its numbers are the registry's (runtime/page_tree/node-bindings.json: the map_view frame, the bubbles' knobs and
# text size), under the names the flow's constants had.
_REG = json.load(open(os.path.join(HERE, "..", "runtime", "page_tree", "node-bindings.json"), encoding="utf-8"))
_FRAME, _CIRCLES = _REG["frames"]["map_view"], _REG["nodes"]["bubbles"]
RS_CONST = {"MAP_PAD": float(_FRAME["pad"]), "MAP_W_PX": float(_FRAME["w"]), "BUBBLE_R_MAX_PX": float(_CIRCLES["knobs"]["r_max"]),
            "BUBBLE_R_MIN_PX": float(_CIRCLES["knobs"]["r_min"]), "BUBBLE_LABEL_PX": float(_CIRCLES["texts"]["size"]),
            "BUBBLE_LABEL_GAP_PX": float(_CIRCLES["knobs"]["label_gap"]), "MAP_INSET_PX": float(_FRAME["inset"])}


def layer1_extent(points, labels, dec):
    """points {code: [lon, lat]}, labels {code: (value, name)}: the extent layer 1 gives the map leaves."""
    c = RS_CONST; W, sz = c["MAP_W_PX"], c["BUBBLE_LABEL_PX"]; vmax = max([abs(v) for v, _ in labels.values()] + [0.0])
    room = []
    for code, p in points.items():
        v, name = labels[code]; r = max(c["BUBBLE_R_MAX_PX"] * math.sqrt(abs(v) / vmax), c["BUBBLE_R_MIN_PX"]) if vmax > 0 else c["BUBBLE_R_MIN_PX"]
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


def edgeless(svg):
    """The svg with each circle's edge in the page ground (bubbles.CIRCLE_EDGE) taken out, exactly once per circle it marks."""
    edge = f' stroke="var(--bg)" stroke-width="{bubbles.CIRCLE_EDGE}" data-code='
    assert svg.count(edge) == svg.count(" data-code="), "a circle without its edge"
    return svg.replace(edge, " data-code=")


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
# the q6 stand-in page's map (asylum applicants to the EU by citizenship, 2025, the 20 its table kept; test-only copies of that
# run's values), iso2 codes
Q6 = dict(AF=112310, BD=37350, CD=17675, CO=21715, EG=25310, ER=12570, GE=15130, GN=14275, HT=14050, IQ=12485, MA=20205, ML=19910,
          PE=20150, PK=19250, SD=17375, SO=18340, SY=43290, TR=31010, UA=23935, VE=90950)


class MapExtent(unittest.TestCase):
    def draw(self, values, dec, point_of, names, ext=None, **style):
        rows, items, labels = map_set(values, dec, point_of, names)
        setup(rows, labels)
        ext = ext or layer1_extent({i["code"]: i["lonlat"] for i in items}, {c: (v, labels[c]) for c, v in values.items()}, dec)
        f = bubbles.Laid({"data": {"items": items, "ext": ext}, "style": {"bubbles": {**run.MAP_STYLE["bubbles"], **style}}})
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
        # every circle labelled on the extent layer 1 gives, China's beside it on the box's east edge among them, at the full
        # scale; on the old extent (a fixed 4 degrees past the box: some 11 px here) China's label found no place on the
        # node's first pass, and its retry (more leader angles, the circles a step smaller) places it at 20 px (11-07)
        f, items = self.draw(Q5, 2, POINT.get, ZH3)
        self.assertEqual((f.dropped, f.r_used), ([], 22))
        self.assertEqual(sorted(c for c, _ in f.label_boxes), sorted(Q5))
        f, _ = self.draw(Q5, 2, POINT.get, ZH3, ext=box_pad(items))
        self.assertEqual((f.dropped, f.r_used), ([], 20))
        self.assertEqual(sorted(c for c, _ in f.label_boxes), sorted(Q5))

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

    def test_circles_that_overlap_keep_an_edge_in_the_page_ground(self):
        # two map shapes whose circles still overlap on the scale drawn (by less than half the smaller, as the leaf allows): the
        # q5 page's eight 65+ shares (2025, Monaco, Italy, Greece and Portugal in one European cluster) and the q6 page's 20
        # asylum citizenships (2025, Turkey, Syria, Iraq and Georgia in one cluster). Overlapping circles of one grey read as one
        # blob (both stand-in image reviews said a reader cannot tell them apart): every circle is drawn biggest first with an
        # edge in the page ground (--bg, the land's own outline colour) at least CIRCLE_EDGE px, so each smaller circle on top
        # keeps its outline. Only the circles' stroke: their place, radius, fill and every label are as before (the pins below)
        for tag, values, dec, point_of, names in (("q5", EU, 2, POINT.get, ZH3), ("q6", Q6, 0, lambda c: POINT[ISO3[c]], ZH2)):
            rows, items, labels = map_set(values, dec, point_of, names); setup(rows, labels)
            ext = layer1_extent({i["code"]: i["lonlat"] for i in items}, {c: (v, labels[c]) for c, v in values.items()}, dec)
            f = bubbles.Laid({"data": {"items": items, "ext": ext}, "style": {"bubbles": dict(run.MAP_STYLE["bubbles"])}})
            svg = bubbles.cl_bubbles(f, prod.Occ())
            drawn = [(float(x), float(y), float(r), rest) for x, y, r, rest in re.findall(r'<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"([^>]*)data-code=', svg)]
            self.assertEqual(len(drawn), len(values), tag)
            over = [(a, b) for i, a in enumerate(drawn) for b in drawn[i + 1:] if math.dist(a[:2], b[:2]) < a[2] + b[2]]
            self.assertGreater(len(over), 0, f"{tag}: the shape has no overlapping circles to test")
            self.assertEqual([r for _, _, r, _ in drawn], sorted((r for _, _, r, _ in drawn), reverse=True), tag)
            for x, y, r, rest in drawn:
                edge = re.search(r'stroke="var\(--bg\)" stroke-width="([\d.]+)"', rest)
                self.assertTrue(edge and float(edge.group(1)) >= bubbles.CIRCLE_EDGE >= 1, f"{tag}: the circle at {x},{y} has no edge in the page ground: {rest!r}")

    def test_circles_that_overlap_at_r_max_are_drawn_smaller_until_they_clear(self):
        # the q5 stand-in page's map (the eight highest 65+ shares, 2025, as its table held them, at Natural Earth label points, on
        # layer 1's extent): at r_max 22 Monaco's and Italy's circles, 7.7 px apart, overlapped by 0.70 of the smaller even nudged
        # and the page stopped. Now the scale steps down to r_used 18, where none overlaps by half; every radius still by area
        q5 = dict(MCO=36.0110586578337, JPN=29.9940966737423, PRI=25.2728697076413, ITA=25.0981380733118, PRT=24.9426193763087,
                  GRC=24.3998585549859, FIN=24.2018896456272, DEU=23.7031981458429)  # test-only copies of the run's top 8
        # and on the world map (the default: equal earth, 1140 wide) the Low Countries, their neighbours and San Marino inside
        # Italy (the same table's 2025 shares): it steps to the knob's floor
        west = dict(LUX=15.8123957037476, BEL=20.9608828531757, DEU=23.7031981458429, FRA=22.5418906984086, NLD=20.8687702211484,
                    ITA=25.0981380733118, SMR=23.1484101571226)
        def column_map(values, **style):  # the column page's map panel on layer 1's extent
            rows, items, labels = map_set(values, 1, POINT.get, ZH3); setup(rows, labels)
            ext = layer1_extent({i["code"]: i["lonlat"] for i in items}, {c: (v, labels[c]) for c, v in values.items()}, 1)
            return bubbles.Laid({"data": {"items": items, "ext": ext}, "style": {"bubbles": {**run.MAP_STYLE["bubbles"], **style}}})
        def world_map(values, **style):
            rows, items, labels = value_set(values, "2025", 1, "%"); setup(rows, labels)
            return bubbles.Laid(hero(dict(E_DATA, items=items), **style))
        for draw, values, used in ((column_map, q5, 18), (world_map, west, 12)):
            fr = draw(values)
            self.assertEqual((fr.r_used, fr.over), (used, []))
            self.assertLessEqual(max(bubbles.lens(a, b) / (math.pi * min(a["_r"], b["_r"]) ** 2) for x, a in enumerate(fr.items) for b in fr.items[x + 1:]), 0.5)
            top = max(fr.items, key=lambda i: i["_v"]); self.assertAlmostEqual(top["_r"], used)
            for i in fr.items:
                self.assertAlmostEqual(i["_r"] / top["_r"], math.sqrt(values[i["code"]] / values[top["code"]]), places=9)
            self.assertEqual(check_svg(bubbles.cl_bubbles(fr, prod.Occ())), [])
        # with no nudge neither clears even at the floor: both still refuse, saying so
        for draw, values, pair in ((column_map, q5, "MCO/ITA"), (world_map, west, "ITA/SMR")):
            with self.assertRaises(Refused) as e: draw(values, nudge=0)
            self.assertIn(f"({pair}", str(e.exception)); self.assertIn("even at r_max 12", str(e.exception))

    def test_the_reply_names_the_circles_lifted_to_r_min_on_the_scale_drawn(self):
        # through the leaf runner as layer 1 calls it (run.LEAF_LAYERS: what main() adds to the bubbles reply): r_min_lifted and
        # r_min_codes are the circles whose area-true radius on the scale drawn, r_used * sqrt(v / max), is under r_min, drawn at
        # r_min and so off the scale by area. The q1-style EU-27 column map lifts none, at the default 22 and asked 60 (drawn at 40);
        # a test-only copy with four small shares lifts all four at 22, and asked 60 it is drawn at 40, where three are under r_min
        # (at 60 itself only Cyprus would be): the set grows as the scale steps down
        q1 = dict(SE=66.4, FI=50.8, DK=44.9, LV=43.2, EE=38.5, PT=35.2, AT=33.8, LT=31.9, HR=28.1, RO=25.8, SI=25.1, EL=25.3, ES=24.9, FR=22.2,
                  DE=21.5, IT=19.6, BG=22.5, CZ=18.6, PL=16.6, SK=17.0, CY=20.2, NL=17.4, HU=15.2, MT=15.1, IE=15.3, BE=14.7, LU=11.6)  # test-only
        small = dict(q1, LU=0.3, MT=0.25, CY=0.1, IE=0.9)  # test-only
        iso3, zh2, r_min = dict(ISO3, EL="GRC"), dict(ZH2, EL=ZH2["GR"]), prod.KNOBS["bubbles"]["r_min"][0]
        under = lambda values, r: sorted(c for c, v in values.items() if r * math.sqrt(v / max(values.values())) < r_min)
        def reply(values, **style):
            rows, items, labels = map_set(values, 1, lambda c: POINT[iso3[c]], zh2); setup(rows, labels)
            ext = layer1_extent({i["code"]: i["lonlat"] for i in items}, {c: (v, labels[c]) for c, v in values.items()}, 1)
            run.SCALE.clear()
            run.LEAF_LAYERS["bubbles"][0](types.SimpleNamespace(h={"leaves": {"bubbles": {"items": items, "ext": ext}}, "style": {"bubbles": style}}), prod.Occ())
            return dict(run.SCALE)
        for values, st, used, codes in ((q1, {}, 22, []), (q1, {"r_max": 60}, 40, []), (small, {}, 22, ["CY", "IE", "LU", "MT"]),
                                        (small, {"r_max": 60}, 40, ["CY", "LU", "MT"])):
            got = reply(values, **st)
            self.assertEqual((got["r_used"], got["r_min_lifted"], got["r_min_codes"]), (used, len(codes), codes), st)
            self.assertEqual(got["r_min_codes"], under(values, used), st)
        self.assertEqual(under(small, 60), ["CY"])
        # on the world map the Low Countries' set steps down to 12 (above): a test-only Luxembourg at 1.0, area-true 4.4 px at 22,
        # is under r_min at 12 and so lifted, and only there
        west = dict(LUX=1.0, BEL=20.9608828531757, DEU=23.7031981458429, FRA=22.5418906984086, NLD=20.8687702211484, ITA=25.0981380733118, SMR=23.1484101571226)
        rows, items, labels = value_set(west, "2025", 1, "%"); setup(rows, labels)
        fr = bubbles.Laid(hero(dict(E_DATA, items=items)))
        self.assertEqual((fr.r_used, fr.r_min_codes, under(west, 12), under(west, 22)), (12, ["LUX"], ["LUX"], []))

    def test_maps_that_clear_at_r_max_draw_as_before(self):
        # the EU table above, a q1-style EU-27 column map, the q5 change page's world map and the world set: each clears at r_max,
        # r_used is the knob's, and the layer is byte for byte the one drawn before the smaller scales were tried but for its circles'
        # fill (its sha then, with every circle out of the focus in CIRCLE_INK where it was in the accent) and the circles' edge in
        # the page ground (CIRCLE_EDGE, taken out before the sha: it is a stroke only, so the pins also hold every place, radius,
        # fill and label as they were before it)
        q1 = dict(SE=66.4, FI=50.8, DK=44.9, LV=43.2, EE=38.5, PT=35.2, AT=33.8, LT=31.9, HR=28.1, RO=25.8, SI=25.1, EL=25.3, ES=24.9, FR=22.2,
                  DE=21.5, IT=19.6, BG=22.5, CZ=18.6, PL=16.6, SK=17.0, CY=20.2, NL=17.4, HU=15.2, MT=15.1, IE=15.3, BE=14.7, LU=11.6)  # test-only
        iso3, zh2 = dict(ISO3, EL="GRC"), dict(ZH2, EL=ZH2["GR"])
        for tag, values, dec, point_of, names, pin in (
                ("eu", EU2, 1, lambda c: POINT[ISO3[c]], ZH2, "89d06d554f33aa65a5a05e652f78b99c714c284f609bc080212e5e078886bb40"),
                ("q1", q1, 1, lambda c: POINT[iso3[c]], zh2, "22f3ccee12660f3c215f676948c7729aa50c12f0837e36aa4e35f59638b3b550"),
                ("q5-world", Q5, 2, POINT.get, ZH3, "7f6b7bdb647beb2ae8c81caabec9173e41dff0645c211874e6440e02e2f85024")):
            rows, items, labels = map_set(values, dec, point_of, names); setup(rows, labels)
            ext = layer1_extent({i["code"]: i["lonlat"] for i in items}, {c: (v, labels[c]) for c, v in values.items()}, dec)
            f = bubbles.Laid({"data": {"items": items, "ext": ext}, "style": {"bubbles": dict(run.MAP_STYLE["bubbles"])}})
            self.assertEqual((f.r_used, hashlib.sha256(edgeless(bubbles.cl_bubbles(f, prod.Occ())).encode()).hexdigest(), f.dropped), (22, pin, []), tag)
        setup(W_ROWS, W_LABELS)
        self.assertEqual(hashlib.sha256(edgeless(bubbles.draw(hero(W_DATA, highlight="CHN"))[0]).encode()).hexdigest(), "256649e06393c4a99e9fecdc520ea52d76802183541bdf7e68cc53c632bf3251")


# The key's fixture: a q1-style EU-27 column map (test-only values), each circle's value printed bare from its family member
# (fact:val.<code>.n, as layer 1's bubbles_fill gives it) in a family whose format prints "%", the map's year a period entry.
KQ1 = dict(SE=66.4, FI=50.8, DK=44.9, LV=43.2, EE=38.5, PT=35.2, AT=33.8, LT=31.9, HR=28.1, RO=25.8, SI=25.1, EL=25.3, ES=24.9, FR=22.2,
           DE=21.5, IT=19.6, BG=22.5, CZ=18.6, PL=16.6, SK=17.0, CY=20.2, NL=17.4, HU=15.2, MT=15.1, IE=15.3, BE=14.7, LU=11.6)  # test-only
KSPEC = {"facts": {"val": {"each": "geo", "table": "T", "time": "2025", "fmt": "pc"}}, "fmts": {"pc": {"scale": 1, "dec": 1, "suffix": "%"}}}
# the measure as layer 1 gives it (next_run recipe_request): the table's reviewed name, one entry marked with its name row, its
# text in the page's ledger (knobs.named); the q1 table's name, longer than one line of the key
KNAME = {"src": "name:catalogue:T:title", "text": "可再生能源在最终能源消费总量中的占比（按部门）"}


def key_panel(measure=None, notes=(), panel_h=None, more=(), accent=None, **key_style):
    """The column page's map panel as run.py draws it: the bubbles (run.LEAF_LAYERS, the hero's focus the place layer 1 names as
    its accent, hero.data.accent, the other places its notes name noted), then the
    key over the panel's frame (table, year, spec, map view, height: the map's and the key's room under it, as run.Panel keeps it,
    or `panel_h`), on one Occ. Returns (panel, occ, bubbles svg)."""
    iso3, zh2 = dict(ISO3, EL="GRC"), dict(ZH2, EL=ZH2["GR"])
    rows, items = [{"src": "period:T:2025", "text": "2025"}, KNAME, *more], []
    for c, v in KQ1.items():
        rows += [{"src": f"series:T/{c}:2025:OBS_VALUE", "table": "T", "dims": {"geo": c}, "time": "2025", "value": v},
                 {"src": f"fact:val.{c}.n", "text": f"{v:.1f}"}]
        items.append(dict(code=c, value=f"series:T/{c}:2025:OBS_VALUE", value_text=f"fact:val.{c}.n", lonlat=POINT[iso3[c]]))
    setup(rows, {c: zh2[c] for c in KQ1})
    ext = layer1_extent({i["code"]: i["lonlat"] for i in items}, {c: (v, zh2[c]) for c, v in KQ1.items()}, 1)
    leaves = {"bubbles": dict(items=items, ext=ext, **({"measure": measure} if measure else {}))}
    if notes: leaves["leader_notes"] = {"ext": ext, "notes": [{"at": POINT[iso3[c]], "name": c} for c in notes]}
    h = {"leaves": leaves, "data": {"marks": [], **({"accent": accent} if accent else {})}, "style": {"bubble_key": key_style} if key_style else {}}
    mv = bubbles.MK.View({"data": leaves["bubbles"], "style": run.MAP_STYLE}, "bubbles"); mh = mv.H
    panel = types.SimpleNamespace(h=h, table="T", year="2025", c=types.SimpleNamespace(spec=KSPEC), mv=mv, H=mh, map_h=mh)
    panel.H = mh + bubbles.key_room(panel) if panel_h is None else panel_h  # as run.Panel keeps it under the map, unless given
    occ = prod.Occ(); svg = run.LEAF_LAYERS["bubbles"][0](panel, occ)
    return panel, occ, svg


class Key(unittest.TestCase):
    """The key to the circles (bubble_key), drawn after the bubbles over the column page's map panel."""
    MEASURE = [{"src": KNAME["src"]}]

    def draw_key(self, panel, occ):
        run.DROPPED.clear()
        return run.LEAF_LAYERS["bubble_key"][0](panel, occ)

    def test_the_key_names_the_measure_and_the_maps_year_and_its_circles_are_the_maps(self):
        panel, occ, map_svg = key_panel(self.MEASURE)
        svg = self.draw_key(panel, occ)
        self.assertEqual((check_svg(svg), run.DROPPED), ([], []))
        texts = run.drawn(svg)[0]
        words = [t for t in texts if not t["src"].startswith("fact:")]
        # the words: the word table's bubble_key.area, the measure's own name marked with its name row (whole: an entry prints
        # as its ledger gives it) and the year as date.y prints it, its digits the period entry the unit line prints; every line
        # holds a source, as layer 1 takes an svg text (next_leaf faults: "has no src"), and none is wider than the map's rect holds
        self.assertEqual("".join(t["text"] for t in words), K.WD.WORDS["bubble_key.area"].format(m=KNAME["text"], y=K.WD.WORDS["date.y"].format(y="2025")))
        self.assertEqual({p for t in words for p in t["src"].split("+")}, {KNAME["src"], "period:T:2025"})
        self.assertEqual([t["text"] for t in texts if not t["src"]], [])
        self.assertIn(f'<tspan data-src="{KNAME["src"]}">{KNAME["text"]}</tspan>', svg)
        most = panel.mv.W - 2 * (prod.KNOBS["bubbles"]["inset"][0] + bubbles.KEY_GAP + bubbles.KEY_PAD)
        self.assertTrue(all(prod.tw(t["text"], 12) <= most for t in words))
        # each value: the map circle's own ledger entry, then its family's unit; the largest the map's largest, at r_used
        values = [t for t in texts if t["src"].startswith("fact:")]
        self.assertEqual([(t["src"], t["text"]) for t in values][0], ("fact:val.SE.n", "66.4%"))
        self.assertTrue(all(t["text"] == FXT(t["src"]) + "%" for t in values))
        drawn = {c: float(r) for r, c in re.findall(r'<circle [^>]*r="([\d.]+)"[^>]*data-code="(\w+)"', map_svg)}
        refs = [float(r) for r in re.findall(r'<circle [^>]*r="([\d.]+)" fill="none"', svg)]
        self.assertEqual(len(refs), len(values))
        self.assertGreaterEqual(len(refs), 2)
        # each reference circle on its own map circle's visible edge (B3: an outline at the drawn radius read larger than
        # the filled circle, whose background edge covers half its width): the outline's outer edge is the fill's edge
        self.assertEqual(refs[0], round(bubbles.key_r(occ.scale["r_used"]), 1))
        for t, r in zip(values, refs):
            d = drawn[t["src"].split(".")[1]]
            self.assertEqual(r, round(bubbles.key_r(d), 1), t)
            self.assertLessEqual(r + bubbles.KEY_EDGE / 2, d - bubbles.CIRCLE_EDGE / 2 + 0.05, t)
        self.assertLessEqual(refs[0] + bubbles.KEY_EDGE / 2, max(drawn.values()) - bubbles.CIRCLE_EDGE / 2 + 0.05)
        # the largest drawn circle leads the key whatever order the circles were placed in
        shuffled = [("B", 2, 9.0, "b"), ("A", 9, 22.0, "a"), ("C", 1, 5.5, "c")]
        self.assertEqual([c[0] for c in bubbles.key_refs(shuffled, 3)], ["A", "B", "C"])
        # its box is claimed off every circle and label the bubbles claimed: inside the land's rect, or (this one: the q1 name on one
        # line takes the key wider than any free box on the EU map) under the map in the room the panel keeps, the map grown to it
        box = next(q for q in occ.boxes if q[4] == "bubble_key")
        x0, y0, x1, y1 = occ.scale["rect"]
        inside = x0 <= box[0] and y0 <= box[1] and box[2] <= x1 and box[3] <= y1
        self.assertTrue(inside or (box[1] > occ.scale["H"] and panel.map_h >= box[3] and box[3] <= panel.H), box)
        self.assertFalse(any(box[0] < q[2] and q[0] < box[2] and box[1] < q[3] and q[1] < box[3] for q in occ.boxes if q[4] == "bubbles"))

    def test_with_leader_notes_to_come_the_key_takes_the_room_under_the_map_first(self):
        # the notes drawn after the key need the map's free room (e5 11-07: the key in the map's one free box left the title's place no
        # spot for its note); without notes the key keeps the map's own free box
        panel, occ, _ = key_panel()  # without the measure's name the key is narrow enough for a free box on the EU map
        self.draw_key(panel, occ)
        alone = next(q for q in occ.boxes if q[4] == "bubble_key")
        self.assertLess(alone[3], panel.mv.H)
        panel, occ, _ = key_panel(notes=["DE", "FR"])
        self.draw_key(panel, occ)
        under = next(q for q in occ.boxes if q[4] == "bubble_key")
        self.assertGreaterEqual(under[1], panel.mv.H)
        self.assertLessEqual(under[3], panel.H + 0.01)
        # with no room kept under the map, the notes to come do not drop the key: the map's own free box still holds it
        panel, occ, _ = key_panel(notes=["DE", "FR"], panel_h=None)
        panel.H = panel.mv.H
        self.draw_key(panel, occ)
        self.assertTrue(any(q[4] == "bubble_key" for q in occ.boxes))

    def test_a_line_of_words_alone_joins_the_next_so_every_key_text_holds_a_source(self):
        # a measure given as words (no mark) wraps into a line with no entry in it: it joins the line after it, so no text of
        # the key reaches layer 1 without a source; with the width knob at its floor the same; and a measure too wide for the
        # map's rect on any line gives the words without it
        for measure, st in (([{"w": KNAME["text"]}], {}), ([{"w": KNAME["text"]}], {"width": 120}), (self.MEASURE, {"width": 120})):
            panel, occ, _ = key_panel(measure, **st)
            texts = run.drawn(self.draw_key(panel, occ))[0]
            self.assertEqual([t["text"] for t in texts if not t["src"]], [], (measure, st))
        panel, occ, _ = key_panel([{"src": "name:catalogue:T:wide"}], more=[{"src": "name:catalogue:T:wide", "text": KNAME["text"] * 3}])
        texts = run.drawn(self.draw_key(panel, occ))[0]
        self.assertEqual("".join(t["text"] for t in texts if not t["src"].startswith("fact:")),
                         K.WD.WORDS["bubble_key.area_any"].format(y=K.WD.WORDS["date.y"].format(y="2025")))

    def test_the_measure_falls_back_only_when_its_line_is_wider_than_the_maps_rect_whatever_its_characters(self):
        # the fallback is measured in px (prod.tw) against the map's rect, never by counting characters: a short name (nine
        # characters, as q4's measure) prints, and so does every name whose line (the words before it joined to it, as no line
        # of words alone is drawn, and the mark after it) still fits the rect; one wider gives the words without it
        src = "name:catalogue:T:n"
        def said(name):
            panel, occ, _ = key_panel([{"src": src}], more=[{"src": src, "text": name}])
            texts = run.drawn(self.draw_key(panel, occ))[0]
            most = panel.mv.W - 2 * (prod.KNOBS["bubbles"]["inset"][0] + bubbles.KEY_GAP + bubbles.KEY_PAD)
            return "".join(t["text"] for t in texts if not t["src"].startswith("fact:")), most
        year = K.WD.WORDS["date.y"].format(y="2025")
        area = lambda m: K.WD.WORDS["bubble_key.area"].format(m=m, y=year)
        self.assertEqual(said("人均二氧化碳排放量")[0], area("人均二氧化碳排放量"))
        most = said("")[1]
        line = lambda name: prod.tw(K.WD.WORDS["bubble_key.area"].split("{m}")[0] + name + "，", 12)
        widest = max(n for n in range(1, 80) if line("量" * n) <= most)
        self.assertGreater(widest, 30)  # far past any character count the key could hold at its width knob
        for n in (widest - 1, widest):
            self.assertEqual(said("量" * n)[0], area("量" * n), n)
        self.assertEqual(said("量" * (widest + 1))[0], K.WD.WORDS["bubble_key.area_any"].format(y=year))
        # a Latin name is measured as the page sets it, narrower than as many CJK characters: more of its characters fit
        latin = max(n for n in range(1, 120) if line("m" * n) <= most)
        self.assertGreater(latin, widest)
        self.assertEqual(said("m" * latin)[0], area("m" * latin))

    def test_without_a_measure_the_key_says_what_the_area_is_at_the_year(self):
        panel, occ, _ = key_panel()
        texts = run.drawn(self.draw_key(panel, occ))[0]
        self.assertEqual("".join(t["text"] for t in texts if not t["src"].startswith("fact:")),
                         K.WD.WORDS["bubble_key.area_any"].format(y=K.WD.WORDS["date.y"].format(y="2025")))
        # one reference circle when the knob asks for one
        panel, occ, _ = key_panel(count=1)
        self.assertEqual(self.draw_key(panel, occ).count('fill="none"'), 1)

    def test_with_no_free_box_on_the_map_the_key_goes_under_it_or_is_dropped_and_named(self):
        # the whole map claimed: in the room the panel keeps under the map (run.Panel) the key stands under it, the map growing to
        # hold it; with no room there (a panel of the map's height) it is dropped, named, and the layer drawn empty
        for taller in (True, False):
            panel, occ, _ = key_panel()
            if not taller: panel.H = panel.mv.H
            occ.add((0, 0, occ.scale["W"], occ.scale["H"]), "test")
            svg = self.draw_key(panel, occ)
            if taller:
                box = next(q for q in occ.boxes if q[4] == "bubble_key")
                self.assertGreater(box[1], occ.scale["H"])
                self.assertEqual((panel.map_h, run.DROPPED), (math.ceil(box[3]), []))
                self.assertEqual(check_svg(svg), [])
            else:
                self.assertEqual((svg, run.DROPPED), ('<g data-node="bubble_key"></g>', [{"id": "key", "why": "no free place for the key"}]))

    def test_a_key_with_no_bubbles_drawn_before_it_refuses(self):
        panel, _, _ = key_panel()
        with self.assertRaises(Refused) as e: self.draw_key(panel, prod.Occ())
        self.assertIn("no bubbles layer drew before it", str(e.exception))

    def test_only_the_focus_circle_takes_the_accent_and_the_other_noted_place_the_dark_grey(self):
        # the page's focus (the one place layer 1 names as its accent, the dek's) in the accent; the other place its notes name
        # in the dark grey, its name in bold as the focus'; every other circle in the grey. No accent given: none in the accent,
        # both noted places dark grey; no notes either, none in either
        circles = lambda svg, ink: sorted(re.findall(rf'<circle [^>]*fill="var\({ink}\)"[^>]*data-code="(\w+)"', svg))
        _, _, svg = key_panel(notes=("SE", "LU"), accent="SE")
        self.assertEqual((circles(svg, "--accent"), circles(svg, bubbles.NOTED_INK)), (["SE"], ["LU"]))
        self.assertEqual(len(circles(svg, bubbles.CIRCLE_INK)), len(KQ1) - 2)
        self.assertNotEqual(bubbles.NOTED_INK, bubbles.CIRCLE_INK)
        bold = re.findall(r'<text [^>]*font-weight="700"[^>]*><tspan data-src="name:[^"]*:(\w+)">', svg)
        self.assertEqual(sorted(bold), ["LU", "SE"])
        _, _, svg = key_panel(notes=("SE", "LU"))
        self.assertEqual((circles(svg, "--accent"), circles(svg, bubbles.NOTED_INK)), ([], ["LU", "SE"]))
        self.assertEqual(re.findall(r'(?:fill|stroke)="var\(--(?:accent|t-body)\)"', key_panel()[2]), [])
        # the noted knob names drawn codes only, as highlight does
        setup(W_ROWS, W_LABELS)
        with self.assertRaises(Refused) as e: bubbles.Laid(hero(W_DATA, noted="XXX"))
        self.assertIn("codes the request does not hold", str(e.exception))


FXT = lambda src: K.FX.text(src)


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
