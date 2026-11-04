"""Self-test of the leader_notes leaf (runtime/leaves_py/leader_notes.py) and of the column page's map panel (bubbles in the
shared view under leader_notes, run.py MAP_STYLE): the EU27 at their Natural Earth label points (runtime/pi/assets), test-only
values and ledger texts (the first layer writes the real ones), names from the project's reviewed zh names. Both leaves draw
on ONE Occ, bubbles first. Checks: run.drawn reads every text back, no digit outside a marked ledger run, only page colour
variables, note font >= 16, each note one line ending in its bold number (one too wide for that on two, its bold number and
unit the second; one that fits one line drawn byte for byte as before; one too wide on two refused as before), in the sea when that costs less and over the land
only off every circle and label (one with no room anywhere is dropped and named), its leader straight or with one bend (two
only when no place has such a leader: the q6 page's walled-in Iraq, a room's door; a room without one, or past the layer's
two-bend checks, still drops it, named; each piece of it clear just where the forward walk against every box and circle
found it), no
note box on a circle or label the bubbles claimed (but its own point's), every EU
circle labelled, no leader crossing another, no label or leader over a nudged circle's true-point dot, a blocked side gives
way to the other; the column page lays the map beside the bars in one panel, the key to the circles (bubble_key) between the
bubbles and the notes and no key without the bubbles, the accent on the dek's place's circle and bar alone (layer 1's hero.data.accent, on a
level, a change and a bars-only page), the notes' other place in the dark grey, the unit line's legend for the accent, and the kicker in the ink; a crowded map (the EU-27, a
note each) still draws and its reply names exactly the notes it dropped, while one that drops every note refuses; and every
refusal in the leaf's header. With LEAF_SVG_DIR set the svgs are kept there; else they go to a temporary folder that is removed.
Run: python3 -I -B scripts/test_leaves_leader_notes.py"""
import hashlib
import json
import math
import os
import random
import re
import subprocess
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import bubbles  # noqa: E402
import geo  # noqa: E402
import leader_notes as LN  # noqa: E402
import mapkit as MK  # noqa: E402
import prod  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
sys.path.insert(0, HERE)
from test_leaf_placed import placed_lines  # noqa: E402
from wbkit import Refused  # noqa: E402

ASSETS = os.path.join(HERE, "..", "runtime", "pi", "assets")
SHP = os.path.join(ASSETS, "naturalearth-admin0-50m.geojson")
NAMES = json.load(open(os.path.join(ASSETS, "economy-names.json"), encoding="utf-8"))
ZH2 = {e["iso2"]: e["zh"] for e in NAMES["economies"]}; ZH2["EL"] = ZH2["GR"]
ISO3 = {e["iso2"]: e["iso3"] for e in NAMES["economies"]}; ISO3["EL"] = "GRC"
POINT = {f["iso3"]: f["label"] for f in json.load(open(os.path.join(ASSETS, "naturalearth-admin0-50m-attributes.json"), encoding="utf-8"))["features"]
         if f["iso3"] and f["adm0_a3"] == f["iso3"]}
VALUES = dict(SE=66.4, FI=50.8, DK=44.9, LV=43.2, EE=38.5, PT=35.2, AT=33.8, LT=31.9, HR=28.1, RO=25.8, SI=25.1, EL=25.3, ES=24.9, FR=22.2,
              DE=21.5, IT=19.6, BG=22.5, CZ=18.6, PL=16.6, SK=17.0, CY=20.2, NL=17.4, HU=15.2, MT=15.1, IE=15.3, BE=14.7, LU=11.6)  # test-only
ROWS, ITEMS = [], []
for c, v in VALUES.items():
    s = f"series:t/A.PC.{c}:2023:OBS_VALUE"
    ROWS += [{"src": s, "table": "t", "dims": {"freq": "A", "unit": "PC", "geo": c}, "time": "2023", "value": str(v)}, {"src": f"fact:val.{c}", "text": f"{v}%"}]
    ITEMS.append(dict(code=c, value=s, value_text=f"fact:val.{c}", lonlat=POINT[ISO3[c]]))
ROWS += [{"src": "fact:gap", "text": "54.8 个百分点"}, {"src": "fact:times", "text": "5.7倍"}]
EXT = [min(i["lonlat"][0] for i in ITEMS) - 4, min(i["lonlat"][1] for i in ITEMS) - 4, max(i["lonlat"][0] for i in ITEMS) + 4, max(i["lonlat"][1] for i in ITEMS) + 4]
NOTES = [dict(at=POINT["SWE"], name="SE", text=[{"word": "column.note.hi"}], value_text="fact:gap"),
         dict(at=POINT["LUX"], name="LU", text=[{"word": "column.note.lo"}], value_text="fact:times")]
D = dict(ext=EXT, notes=NOTES)
W = lambda t: [{"w": t}]
# a change page's note (a name, its judgement word, the change, whose ledger text carries a long unit): wider than half the map on one line
CHG = {"src": "fact:chg", "text": "1.55 吨二氧化碳当量/人"}  # test-only
WIDE = dict(at=POINT["DEU"], name="CN", text=[{"word": "column.note.rise_most"}], value_text="fact:chg")

# the q6 stand-in page (asylum applications to the EU by citizenship, 2025): its 20 values, their Natural Earth points and the map
# extent layer 1 made, test-only copies of that run's rows
Q6_VALUES = dict(AF=112310, BD=37350, CD=17675, CO=21715, EG=25310, ER=12570, GE=15130, GN=14275, HT=14050, IQ=12485, MA=20205, ML=19910,
                 PE=20150, PK=19250, SD=17375, SO=18340, SY=43290, TR=31010, UA=23935, VE=90950)
Q6_AT = dict(AF=(66.496586, 34.164262), BD=(89.684963, 24.214956), CD=(23.458829, -1.858167), CO=(-73.174347, 3.373111), EG=(29.445837, 26.186173),
             ER=(38.285566, 15.787401), GE=(43.735724, 41.870087), GN=(-10.016402, 10.618516), HT=(-72.224051, 19.263784), IQ=(43.26181, 33.09403),
             MA=(-7.187296, 31.650723), ML=(-2.038455, 18.692713), PE=(-72.90016, -12.976679), PK=(68.545632, 29.328389), SD=(29.260657, 16.330746),
             SO=(45.19238, 3.568925), SY=(38.277783, 35.006636), TR=(34.508268, 39.345388), UA=(32.140865, 49.724739), VE=(-64.599381, 7.182476))
Q6_EXT = [-106.38254019874816, -36.17038598855728, 124.13352937983866, 73.24131058195306]

# the q5 stand-in page (the share of the population aged 65 and over, its change from 2016 to 2025, the 8 most populous
# economies; the change recipe): its rows at both ends, the ledger texts its map and bars print and the map extent layer 1
# made (next_run map_extent over the run's points, the Natural Earth label points of POINT, and its values), test-only
# copies of that run's. Drawn from these the bubbles land on the run's page circle for circle (test below)
Q5_TABLE = "SP.POP.65UP.TO.ZS@2"
Q5_T1 = {'BGD': 6.66842350416686, 'BRA': 11.4803394567154, 'CHN': 14.9114314271952, 'IDN': 7.542769252795, 'IND': 7.37657146047502, 'NGA': 3.06953631021894, 'PAK': 4.36186248416949, 'USA': 18.387224828496}
Q5_T0 = {'BGD': 5.07223834276104, 'BRA': 8.26857395268557, 'CHN': 10.4907994645602, 'IDN': 6.14856356267664, 'IND': 5.64173085340436, 'NGA': 2.96529179502844, 'PAK': 3.85041862791259, 'USA': 14.6147285118987}
Q5_LEDGER = {"fact:chg.BGD": "1.6 个百分点", "fact:chg.BRA": "3.2 个百分点", "fact:chg.CHN": "4.4 个百分点", "fact:chg.IDN": "1.4 个百分点", "fact:chg.IND": "1.7 个百分点", "fact:chg.NGA": "0.1 个百分点",
             "fact:chg.PAK": "0.5 个百分点", "fact:chg.USA": "3.8 个百分点", "fact:val.BGD.n": "6.67", "fact:val.BRA.n": "11.48", "fact:val.CHN.n": "14.91", "fact:val.IDN.n": "7.54", "fact:val.IND.n": "7.38",
             "fact:val.NGA.n": "3.07", "fact:val.PAK.n": "4.36", "fact:val.USA.n": "18.39", "fact:vs_hi": "0.6 个百分点", "fact:vs_lo": "0.4 个百分点"}
Q5_EXT = [-138.42850923508217, -46.07161912408526, 152.92737452319972, 75.80983012867088]
ZH3 = {e["iso3"]: e["zh"] for e in NAMES["economies"]}

def leaders(svg):
    """Every leader drawn, as its points: a <line> (a bubble label's) and a <polyline> (a note's, straight or with one bend)."""
    return [[tuple(map(float, m[:2])), tuple(map(float, m[2:]))] for m in re.findall(r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', svg)] + \
           [[tuple(map(float, p.split(","))) for p in m.split()] for m in re.findall(r'<polyline points="([^"]+)"', svg)]


def segs(svg):
    """Every straight piece of every leader, as (x1, y1, x2, y2)."""
    return [(*a, *b) for path in leaders(svg) for a, b in zip(path, path[1:])]


def lead_old(edge, end, pt, boxes, rings, cells):
    """lead_clear as it was before it walked from the point end against what the piece's bounds reach: the forward walk, every
    sample point against every box and circle (the reference its answers are held to)."""
    steps = max(1, math.ceil(math.dist(edge, end) / 2))
    for i in range(steps + 1):
        a = (edge[0] + (end[0] - edge[0]) * i / steps, edge[1] + (end[1] - edge[1]) * i / steps)
        if math.dist(a, pt) <= 10: continue
        if any(a[0] - 3 < q[2] and a[0] + 3 > q[0] and a[1] - 3 < q[3] and a[1] + 3 > q[1] for q in boxes): return False
        if any(math.dist(a, c[:2]) < c[2] + 2 for c in rings): return False
        cx, cy = int(a[0] // LN.LEAD_GAP), int(a[1] // LN.LEAD_GAP)
        if any(math.dist(a, q) < LN.LEAD_GAP for gx in (cx - 1, cx, cx + 1) for gy in (cy - 1, cy, cy + 1) for q in cells.get((gx, gy), ())): return False
    return True


def setup(rows=ROWS, labels=ZH2):
    K.setup(rows, labels, run.tables)
    geo.NE = SHP


# the bubbles knobs that label every circle, side by side as tight as the leaf allows: the crowded map the notes must clear
FULL = {"label_top": 60, "label_sep": 2}


def style(full=False, **nst):
    return {"bubbles": {**run.MAP_STYLE["bubbles"], **(FULL if full else {})}, "leader_notes": {**run.MAP_STYLE["leader_notes"], **nst}}


def pair(d=D, occ=None, full=False, **nst):
    """bubbles in the shared view, then leader_notes, on one Occ: (bubbles' frame, notes' frame, the svg inner, the Occ)."""
    setup(); occ = occ or prod.Occ()
    fb = bubbles.Laid({"data": dict(items=ITEMS, ext=d.get("ext", EXT)), "style": style(full)}); sb = bubbles.cl_bubbles(fb, occ)
    fn = LN.Frame({"data": d, "style": style(**nst)}); sn = LN.cl_leader_notes(fn, occ)
    return fb, fn, sb + sn, occ


def check_svg(svg):
    got, bad = run.drawn(svg); errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    errs += [f"a colour literal {c}" for c in re.findall(r"#[0-9A-Fa-f]{3,8}\b", svg)]
    cols = set(re.findall(r'(?:stroke|fill)="([^"]+)"', svg)) - {"none", "var(--t-title)", "var(--accent)", "var(--t-sec)", "var(--bg)", "var(--t-dark)"}
    return errs + [f"colours beyond the page variables: {cols}"] * bool(cols)


class LeaderNotes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = None if os.environ.get("LEAF_SVG_DIR") else tempfile.TemporaryDirectory(prefix="leaf-svg-")
        cls.out = os.environ.get("LEAF_SVG_DIR") or cls.tmp.name

    @classmethod
    def tearDownClass(cls):
        if cls.tmp: cls.tmp.cleanup()

    def test_the_notes_draw_over_the_bubbles_clear_of_what_they_claimed(self):
        fb, fn, svg, occ = pair(full=True)
        with open(os.path.join(self.out, "eu-map-notes.svg"), "w", encoding="utf-8") as fh: fh.write(K.svg(svg, fb.W, fb.H, "map"))
        self.assertEqual(check_svg(svg), [])
        # one frame: the same size and projection; Luxembourg's note, in the crowded centre with every circle labelled, finds no
        # clear leader from the sea and sits over the land, off every circle and label, on a leader with one bend
        self.assertEqual((fn.dropped, (fn.W, fn.H)), ([], (fb.W, fb.H)))
        self.assertEqual(fn.v.P(*POINT["SWE"]), fb.xy(*POINT["SWE"]))
        sizes = [float(s) for s in re.findall(r'<text[^>]*font-size="([\d.]+)"', svg.split('data-node="leader_notes"')[1])]
        self.assertTrue(sizes and min(sizes) >= 16, sizes)
        claimed = [b for b in occ.boxes if b[4] == "bubbles"]; notes = [b for b in occ.boxes if b[4] == "notes"]
        self.assertEqual(len(notes), 2)  # Sweden's and Luxembourg's, one line each
        # each note ends in its number, bold; Sweden's sits in the sea (off every land shape the bubbles drew), Luxembourg's over it
        self.assertTrue(occ.land)
        self.assertEqual([MK.on_land(occ.land, n) for n in notes], [False, True])
        self.assertEqual(len(re.findall(r'<tspan font-weight="700"><tspan data-src="fact:(?:gap|times)"', svg)), 2)
        for n in notes:
            self.assertEqual([b[:4] for b in claimed if n[0] < b[2] and b[0] < n[2] and n[1] < b[3] and b[1] < n[3]], [], n)
        # each leader ends on its own point and crosses no claimed box but that point's own circle
        notes_svg = svg.split('data-node="leader_notes"')[1]  # the bubbles' own label leaders start on their circles
        paths = leaders(notes_svg)
        self.assertEqual(sorted(len(p) for p in paths), [2, 3])  # Sweden's straight, Luxembourg's with one bend
        for path in paths:
            px, py = path[-1]; own = [b for b in claimed if b[0] <= px <= b[2] and b[1] <= py <= b[3]]
            for (x1, y1), (x2, y2) in zip(path, path[1:]):
                for i in range(101):
                    x, y = x1 + (x2 - x1) * i / 100, y1 + (y2 - y1) * i / 100
                    if ((x - px) ** 2 + (y - py) ** 2) ** 0.5 <= 10: continue
                    self.assertEqual([b[:4] for b in claimed if b not in own and b[0] < x < b[2] and b[1] < y < b[3]], [], (x, y))

    def test_a_note_sits_in_the_sea_when_it_can_and_over_the_land_off_every_circle_and_label_else(self):
        # one note at each EU country in turn (Sweden's beside it, as the page has two): every note drawn is off every circle
        # and label the bubbles claimed, its leader (straight or with one bend) clear of every circle but its own; Sweden's
        # sits in the sea; an inland note with no clear leader from the sea sits over the land; the rest are dropped and named.
        # Before the land and the bend were tried, the crowded centre dropped most of its notes; now at most a few are
        placed, dropped, over = set(), set(), set()
        for c in VALUES:
            notes = [dict(at=POINT["SWE"], name="SE", text=[{"word": "column.note.hi"}], value_text="fact:gap")] * (c != "SE") + \
                    [dict(at=POINT[ISO3[c]], name=c, text=[{"word": "column.note.lo"}], value_text="fact:times")]
            fb, fn, svg, occ = pair(dict(D, notes=notes))
            boxes = [b for b in occ.boxes if b[4] == "notes"]
            claimed = [b for b in occ.boxes if b[4] == "bubbles"]
            for n in boxes:
                self.assertEqual([b[:4] for b in claimed if n[0] < b[2] and b[0] < n[2] and n[1] < b[3] and b[1] < n[3]], [], c)
            over |= {c for b in boxes[-1:] if c != "SE" and MK.on_land(occ.land, b)}
            if c != "SE" and "SE" not in {d for d, _ in fn.dropped}: self.assertFalse(MK.on_land(occ.land, boxes[0]), c)
            self.assertEqual(len(boxes) + len(fn.dropped), len(notes), c)
            self.assertEqual({w for _, w in fn.dropped} - {"no free place for the note"}, set(), c)
            (dropped if c in {d for d, _ in fn.dropped} else placed).add(c)
            for path in leaders(svg.split('data-node="leader_notes"')[1]):
                self.assertLessEqual(len(path), 3, c)  # straight or one bend
                px, py = path[-1]
                for (x1, y1), (x2, y2) in zip(path, path[1:]):
                    for t in range(101):
                        x, y = x1 + (x2 - x1) * t / 100, y1 + (y2 - y1) * t / 100
                        if ((x - px) ** 2 + (y - py) ** 2) ** 0.5 <= 10: continue
                        self.assertEqual([q[:3] for q in occ.circles if ((x - q[0]) ** 2 + (y - q[1]) ** 2) ** 0.5 < q[2] and ((px - q[0]) ** 2 + (py - q[1]) ** 2) ** 0.5 > q[2]], [], c)
        self.assertIn("SE", placed)
        self.assertTrue(over, "no note fell back to the land")
        self.assertLessEqual(len(dropped), 2, (placed, dropped))

    def test_no_leader_crosses_another(self):
        # the EU map with Sweden's and Belgium's notes (the q1 page's pair), and with a note at every country (label_count 12):
        # no two leaders drawn (the labels' and the notes') cross or meet, but at the circle a label's and a note's both end on
        be = [NOTES[0], dict(at=POINT["BEL"], name="BE", text=[{"word": "column.note.lo"}], value_text="fact:times")]
        every = [dict(at=POINT[ISO3[c]], name=c, value_text="fact:gap") for c in VALUES]
        for notes, nst in ((be, {}), (every, {"label_count": 12})):
            fb, fn, svg, occ = pair(dict(D, notes=notes), **nst)
            ls = segs(svg); self.assertTrue(ls)
            for a in range(len(ls)):
                for b in range(a + 1, len(ls)):
                    p, q = ls[a], ls[b]
                    if min(((p[2 * i] - q[2 * j]) ** 2 + (p[2 * i + 1] - q[2 * j + 1]) ** 2) ** 0.5 for i in (0, 1) for j in (0, 1)) < 30: continue  # one circle's two
                    self.assertFalse(MK.crosses(p[:2], p[2:], q[:2], q[2:]), (p, q))

    def test_no_label_glyph_meets_a_leader_as_the_page_check_reads_it(self):
        # the page's line check (text-line-hits.js) reads each text's glyph box (about 1.06 of its size above the baseline to
        # 0.27 below, tw wide), 2 px in, against every leader sampled at 1.5 px: on the EU map with Sweden's and Belgium's notes
        # and with the q1 page's own ordering (every circle labelled), no text meets a leader, its own included
        be = [NOTES[0], dict(at=POINT["BEL"], name="BE", text=[{"word": "column.note.lo"}], value_text="fact:times")]
        for vals in (VALUES, {c: VALUES[c] for c in VALUES if c not in ("SK", "HU")} | dict(HU=19.6, SK=16.3, CZ=19.1)):
            items = [dict(i, value=i["value"]) for i in ITEMS]
            rows = [dict(r, value=str(vals[r["dims"]["geo"]])) if "dims" in r else r for r in ROWS]
            K.setup(rows, ZH2, run.tables); geo.NE = SHP; occ = prod.Occ()
            svg = bubbles.cl_bubbles(bubbles.Laid({"data": dict(items=items, ext=EXT), "style": style()}), occ)
            svg += LN.cl_leader_notes(LN.Frame({"data": dict(D, notes=be), "style": style()}), occ)
            lines = segs(svg)
            for m in re.finditer(r'<text x="([\d.]+)" y="([\d.]+)" font-size="([\d.]+)" text-anchor="(\w+)"[^>]*>(.*?)</text>', svg):
                x, y, sz, an, inner = float(m[1]), float(m[2]), float(m[3]), m[4], re.sub(r"<[^>]+>", "", m[5])
                w = prod.tw(inner, sz); x0 = x if an == "start" else x - w if an == "end" else x - w / 2
                b = (x0 + 2, y - 1.06 * sz + 2, x0 + w - 2, y + 0.27 * sz - 2)
                for l in lines:
                    n = max(2, int(((l[2] - l[0]) ** 2 + (l[3] - l[1]) ** 2) ** 0.5 / 1.5))
                    self.assertFalse(any(b[0] < l[0] + (l[2] - l[0]) * t / n < b[2] and b[1] < l[1] + (l[3] - l[1]) * t / n < b[3] for t in range(n + 1)), (inner, l))
        setup()

    def test_every_eu_circle_is_labelled_and_no_label_or_leader_covers_a_true_point_dot(self):
        # the EU-27 with every circle asked for (FULL): all 27 circles carry their name and number; the dot a nudged circle keeps
        # at its true point is claimed in the Occ, and no label box and no leader drawn passes over it (but the leader of its own circle)
        setup(); occ = prod.Occ(); f = bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": style(True)}); svg = bubbles.cl_bubbles(f, occ)
        self.assertEqual((len(f.label_boxes), f.dropped), (len(ITEMS), []))
        dots = [(float(x), float(y), c) for x, y, c in re.findall(r'<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" fill="var\(--t-title\)" data-at="([A-Z]+)"', svg)]
        self.assertTrue(dots)
        for x, y, c in dots:
            self.assertTrue(any(q[4] == "bubbles" and max(abs(q[0] - x + bubbles.DOT_R), abs(q[1] - y + bubbles.DOT_R), abs(q[2] - x - bubbles.DOT_R), abs(q[3] - y - bubbles.DOT_R)) < 0.1 for q in occ.boxes), c)  # its own box
            self.assertEqual([k for k, b in f.label_boxes if b[0] - 1 < x < b[2] + 1 and b[1] - 1 < y < b[3] + 1], [], c)
        own = {i["code"]: i["_xy"] for i in f.items}
        for x1, y1, x2, y2 in [tuple(map(float, m)) for m in re.findall(r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', svg)]:
            for x, y, c in dots:
                if abs(((x1 - own[c][0]) ** 2 + (y1 - own[c][1]) ** 2) ** 0.5 - next(i["_r"] for i in f.items if i["code"] == c)) < 0.2: continue  # its own circle's
                for t in range(101):
                    px, py = x1 + (x2 - x1) * t / 100, y1 + (y2 - y1) * t / 100
                    self.assertGreater(((px - x) ** 2 + (py - y) ** 2) ** 0.5, bubbles.DOT_R, c)

    def test_a_blocked_side_gives_way_to_the_other(self):
        setup(); f = LN.Frame({"data": dict(D, notes=NOTES[:1]), "style": style()})
        occ = prod.Occ(); occ.add((f.W / 2, 0, f.W, f.H), "test")  # the right half taken: Sweden's own side
        svg = LN.cl_leader_notes(f, occ)
        self.assertEqual(f.dropped, [])
        self.assertIn('text-anchor="start"', svg)
        f = LN.Frame({"data": dict(D, notes=NOTES[:1]), "style": style(side="right")})
        LN.cl_leader_notes(f, occ)
        self.assertEqual(f.dropped, [("SE", "no free place for the note")])

    def leads_clear(self, occ, svg):
        """Every note leader in `svg` keeps off every box claimed in `occ` and every circle (but its own point's, within 10 px of
        the point) and crosses no other leader drawn."""
        paths = leaders(svg.split('data-node="leader_notes"')[1])
        for path in paths:
            px, py = path[-1]; own = [b for b in occ.boxes if b[0] <= px <= b[2] and b[1] <= py <= b[3]]
            for (x1, y1), (x2, y2) in zip(path, path[1:]):
                for t in range(101):
                    x, y = x1 + (x2 - x1) * t / 100, y1 + (y2 - y1) * t / 100
                    if ((x - px) ** 2 + (y - py) ** 2) ** 0.5 <= 10: continue
                    self.assertEqual([b[:5] for b in occ.boxes if b not in own and b[0] < x < b[2] and b[1] < y < b[3]], [], (x, y))
                    self.assertEqual([q[:3] for q in getattr(occ, "circles", []) if ((x - q[0]) ** 2 + (y - q[1]) ** 2) ** 0.5 < q[2] and ((px - q[0]) ** 2 + (py - q[1]) ** 2) ** 0.5 > q[2]], [], (x, y))
        ls = segs(svg)
        for a in range(len(ls)):
            for b in range(a + 1, len(ls)):
                p, q = ls[a], ls[b]
                if min(((p[2 * i] - q[2 * j]) ** 2 + (p[2 * i + 1] - q[2 * j + 1]) ** 2) ** 0.5 for i in (0, 1) for j in (0, 1)) < 30: continue  # one circle's two, or one leader's own pieces
                self.assertFalse(MK.crosses(p[:2], p[2:], q[:2], q[2:]), (p, q))
        return paths

    def q6(self):
        """The q6 stand-in page (asylum applications to the EU by citizenship, 2025; its 20 values, Natural Earth points and the
        map extent layer 1 made, copied from that run), bubbles then Afghanistan's and Iraq's notes on one Occ: (frame, svg, occ)."""
        v, at, ext = Q6_VALUES, Q6_AT, Q6_EXT
        ranked = sorted(v, key=lambda c: -v[c]); rows = [{"src": "fact:gap", "text": "99,825 人"}, {"src": "fact:times", "text": "9.0倍"}]
        for c in ranked:
            rows += [{"src": f"series:t/A.{c}:2025:OBS_VALUE", "table": "t", "dims": {"freq": "A", "citizen": c}, "time": "2025", "value": str(v[c])}, {"src": f"fact:val.{c}.n", "text": f"{v[c]:,}"}]
        items = [dict(code=c, value=f"series:t/A.{c}:2025:OBS_VALUE", value_text=f"fact:val.{c}.n", lonlat=list(at[c])) for c in ranked]
        notes = [dict(at=list(at["AF"]), name="AF", text=[{"word": "column.note.hi"}], value_text="fact:gap"), dict(at=list(at["IQ"]), name="IQ", text=[{"word": "column.note.lo"}], value_text="fact:times")]
        K.setup(rows, ZH2, run.tables); geo.NE = SHP; occ = prod.Occ()
        svg = bubbles.cl_bubbles(bubbles.Laid({"data": dict(items=items, ext=ext), "style": style()}), occ)
        f = LN.Frame({"data": dict(ext=ext, notes=notes), "style": style()}); svg += LN.cl_leader_notes(f, occ)
        setup()
        return f, svg, occ

    def test_a_note_walled_in_by_its_neighbours_takes_a_two_bend_leader(self):
        # the q6 page: Iraq's note, in the Iraq/Syria/Turkey/Georgia cluster, found no clear straight or one-bend leader from any
        # of its places and was dropped; now it takes the cheapest two-bend one, Afghanistan's stays as it was, and every leader
        # keeps off every box, circle and other leader
        f, svg, occ = self.q6()
        self.assertEqual((f.W, f.H, f.dropped, check_svg(svg)), (560, 284, [], []))
        paths = self.leads_clear(occ, svg)
        self.assertEqual(paths[0], [(451.5, 235.8), (451.5, 101.4), (420.0, 101.4)])  # Afghanistan's, one bend, as on the page
        iq = paths[1]; self.assertEqual((len(iq), iq[-1]), (4, (363.5, 104.1)))  # Iraq's: across, along, across, its middle run on the grid
        self.assertTrue(iq[0][1] == iq[1][1] and iq[1][0] == iq[2][0] and iq[2][1] == iq[3][1] and iq[1][0] % LN.GRID == 0, iq)
        # its number is the ledger's entry, bold, as every note's; each of its three runs is claimed in the Occ as a leader (sampled
        # 4 px apart at most), so a note or label after it keeps off it as off a straight one
        self.assertIn('<tspan font-weight="700"><tspan data-src="fact:times">9.0倍</tspan></tspan></text>', svg)
        mine = [(x, y) for x, y, l, t in occ.pts if (l, t) == ("notes", "leader")]
        for (x1, y1), (x2, y2) in zip(iq, iq[1:]):
            on = [p for p in mine if min(x1, x2) - 0.2 <= p[0] <= max(x1, x2) + 0.2 and min(y1, y2) - 0.2 <= p[1] <= max(y1, y2) + 0.2]
            self.assertGreaterEqual(len(on), math.dist((x1, y1), (x2, y2)) / 4, ((x1, y1), (x2, y2)))

    def test_a_note_past_the_layers_two_bend_checks_is_dropped_and_named_not_placed(self):
        # the layer's two-bend tests are one budget for all its notes: with none left, the q6 page's Iraq note (no straight or
        # one-bend leader) drops with the usual reason and is listed, Afghanistan's draws as before; with the default it is placed
        f0, svg0, _ = self.q6(); keep = LN.TWO_BEND_CHECKS
        try:
            LN.TWO_BEND_CHECKS = 0; f, svg, occ = self.q6()
        finally:
            LN.TWO_BEND_CHECKS = keep
        self.assertEqual((f.dropped, check_svg(svg)), ([("IQ", "no free place for the note")], []))
        self.assertEqual(self.leads_clear(occ, svg), [[(451.5, 235.8), (451.5, 101.4), (420.0, 101.4)]])  # Afghanistan's only, as on the page
        self.assertNotIn("fact:times", svg); self.assertEqual((f0.dropped, "fact:times" in svg0), ([], True))

    def test_a_note_in_a_walled_room_takes_two_bends_through_its_door_and_none_drops_without_one(self):
        # a note's point in a room of claimed boxes on the EU frame: a door in the roof (the way in: across to the door's column, down
        # it, across to the point under a shelf) and a door in the side (down to the door's row, across it, down to the point
        # beside a wall); no straight or one-bend leader clears either, so the note was dropped. Each now takes two bends through its
        # door. A room with no door still drops the note, named, and draws nothing
        def room(door):
            setup(); f = LN.Frame({"data": dict(D, notes=[dict(at=POINT["DEU"], name="DE", value_text="fact:gap")]), "style": style()})
            px, py = f.notes[0]["_pt"]; occ = prod.Occ(); X, Y = LN.GRID * round((px + 24) / LN.GRID), LN.GRID * round((py - 9) / LN.GRID)
            walls = dict(roof=[(px - 40, py - 34, px - 36, py + 12), (X + 6, py - 34, X + 10, py + 12), (px - 40, py + 8, X + 10, py + 12),
                               (px - 40, py - 34, X - 6, py - 30), (px - 40, py - 14, X - 6, py - 10)],
                         side=[(px - 12, Y - 20, px - 8, py + 34), (px - 12, Y - 20, px + 40, Y - 6), (px + 36, Y + 6, px + 40, py + 34),
                               (px + 10, Y + 6, px + 14, py + 34), (px - 12, py + 30, px + 40, py + 34)],
                         shut=[(px - 40, py - 34, px - 36, py + 12), (px + 36, py - 34, px + 40, py + 12), (px - 40, py + 8, px + 40, py + 12), (px - 40, py - 34, px + 40, py - 30)])[door]
            for b in walls: occ.add(b, "test")
            svg = LN.cl_leader_notes(f, occ)
            return f, svg, occ, (X, Y)
        for door, across in (("roof", True), ("side", False)):
            f, svg, occ, (X, Y) = room(door)
            self.assertEqual((f.dropped, check_svg(svg)), ([], []), door)
            [p] = self.leads_clear(occ, svg)
            self.assertEqual(len(p), 4, door)
            if across: self.assertTrue(p[0][1] == p[1][1] and p[1][0] == p[2][0] == X and p[2][1] == p[3][1], p)  # down the roof's door
            else: self.assertTrue(p[0][0] == p[1][0] and p[1][1] == p[2][1] == Y and p[2][0] == p[3][0], p)  # across the side's door
        f, svg, occ, _ = room("shut")
        self.assertEqual((f.dropped, svg), ([("DE", "no free place for the note")], '<g data-node="leader_notes"></g>'))

    def test_a_leader_piece_walked_from_its_point_against_what_its_bounds_reach_answers_as_the_forward_walk_against_all(self):
        # lead_clear walks a piece from its point end and tests a sample point only against the boxes and circles the piece's
        # bounds reach (widened 1 px past what a point keeps off): its answer is, piece by piece, the one the forward walk against
        # every box and circle gave (lead_old, the code before). The pieces: every one the layer asked of lead_clear on the q1, q6,
        # change, crowded, walled-room and 30-circle Europe pages, and seeded random maps' pieces: random, zero-length, short,
        # along a box's or circle's keep-off line or its widened bound (each side of it by 1e-9), through box corners, by the point
        new = types.FunctionType(next(c for c in LN.cl_leader_notes.__code__.co_consts if getattr(c, "co_name", "") == "lead_clear"), vars(LN))
        self.assertEqual(new.__code__.co_freevars, ())
        calls, held = [], {}
        def rec(frame, ev, _):
            if frame.f_code is new.__code__:  # called at each call; it returns None, so no frame is traced line by line
                l = frame.f_locals; calls.append((l["edge"], l["end"], l["pt"], *(held.setdefault(id(l[k]), l[k]) for k in ("boxes", "rings", "cells"))))
        iso2 = {v: k for k, v in ISO3.items()}; ext = [-25, 20, 60, 70]; rnd = random.Random(1)
        pick = sorted((c2, POINT[c3]) for c3, c2 in iso2.items() if c3 in POINT and c2 in ZH2 and ext[0] + 2 < POINT[c3][0] < ext[2] - 2 and ext[1] + 2 < POINT[c3][1] < ext[3] - 2)[:30]
        def europe():
            vals = {c: round(rnd.uniform(5, 60), 1) for c, _ in pick}; rows = [{"src": "fact:gap", "text": "54.8 个百分点"}]
            for c, _ in pick: rows += [{"src": f"series:t/A.{c}:2023:OBS_VALUE", "table": "t", "dims": {"geo": c}, "time": "2023", "value": str(vals[c])}, {"src": f"fact:v.{c}", "text": f"{vals[c]}%"}]
            K.setup(rows, ZH2, run.tables); geo.NE = SHP; occ = prod.Occ()
            items = [dict(code=c, value=f"series:t/A.{c}:2023:OBS_VALUE", value_text=f"fact:v.{c}", lonlat=list(p)) for c, p in pick]
            bubbles.cl_bubbles(bubbles.Laid({"data": dict(items=items, ext=ext), "style": {**style(), "bubbles": {**style()["bubbles"], "max_overlaps": 20}}}), occ)
            LN.cl_leader_notes(LN.Frame({"data": dict(ext=ext, notes=[dict(at=list(p), name=c, value_text="fact:gap") for c, p in pick]), "style": style()}), occ)
        every = [dict(at=POINT[ISO3[c]], name=c, value_text="fact:gap") for c in VALUES]
        sys.settrace(rec)
        try:
            pair(); self.q6(); pair(dict(D, notes=every), label_count=12, note_size=22); europe()
            setup(ROWS + [CHG]); occ = prod.Occ(); bubbles.cl_bubbles(bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": style()}), occ)
            LN.cl_leader_notes(LN.Frame({"data": dict(D, notes=[NOTES[0], WIDE]), "style": style()}), occ)
            self.test_a_note_in_a_walled_room_takes_two_bends_through_its_door_and_none_drops_without_one()
        finally:
            sys.settrace(None); setup()
        calls = calls[::5]; page = len(calls)  # every 5th the layer asked
        for m in range(8):  # seeded random maps
            boxes = []; rings = []; cells = {}
            for _ in range(rnd.randint(5, 60)):
                x, y = rnd.uniform(0, 600), rnd.uniform(0, 400); boxes.append((x, y, x + rnd.uniform(1, 80), y + rnd.uniform(1, 30), "t"))
            for _ in range(rnd.randint(3, 30)): rings.append((rnd.uniform(0, 600), rnd.uniform(0, 400), rnd.uniform(1, 30), None))
            for _ in range(rnd.randint(0, 80)):
                x, y = rnd.uniform(0, 600), rnd.uniform(0, 400); cells.setdefault((int(x // LN.LEAD_GAP), int(y // LN.LEAD_GAP)), []).append((x, y))
            pts = [(rnd.uniform(0, 600), rnd.uniform(0, 400)) for _ in range(30)]
            for _ in range(60):  # random, zero-length and short pieces, some ending at the point (as the layer's do), on the 6 px grid too
                pt = rnd.choice(pts); a = (rnd.uniform(0, 600), rnd.uniform(0, 400)); g = (6 * rnd.randint(0, 100), 6 * rnd.randint(0, 66))
                calls += [(a, pt, pt, boxes, rings, cells), (a, (rnd.uniform(0, 600), rnd.uniform(0, 400)), pt, boxes, rings, cells), (a, a, pt, boxes, rings, cells),
                          (a, (a[0] + rnd.uniform(-2, 2), a[1] + rnd.uniform(-2, 2)), pt, boxes, rings, cells), (g, (g[0], pt[1]), pt, boxes, rings, cells), ((g[0], pt[1]), pt, pt, boxes, rings, cells)]
            for q in boxes[:12]:  # along the 3 px keep-off line of each side and the widened bound (4 px), each side of it by 1e-9; through each corner
                pt = rnd.choice(pts)
                for d in (3, 4):
                    for e in (-1e-9, 0, 1e-9):
                        calls += [((q[2] + d + e, q[1] - 20), (q[2] + d + e, q[3] + 20), pt, boxes, rings, cells), ((q[0] - d - e, q[1] - 20), (q[0] - d - e, q[3] + 20), pt, boxes, rings, cells),
                                  ((q[0] - 20, q[3] + d + e), (q[2] + 20, q[3] + d + e), pt, boxes, rings, cells), ((q[0] - 20, q[1] - d - e), (q[2] + 20, q[1] - d - e), pt, boxes, rings, cells)]
                for cx, cy in ((q[0], q[1]), (q[2], q[1]), (q[0], q[3]), (q[2], q[3])):
                    calls += [((cx - 15, cy - 15), (cx + 15, cy + 15), pt, boxes, rings, cells), ((cx - 15, cy + 15), (cx + 15, cy - 15), pt, boxes, rings, cells), ((cx - 30, cy - 4), (cx + 4, cy + 30), pt, boxes, rings, cells)]
            for c in rings[:10]:  # along the r + 2 px keep-off line of each side and the widened bound (r + 3)
                pt = rnd.choice(pts)
                for d in (c[2] + 2, c[2] + 3):
                    for e in (-1e-9, 0, 1e-9):
                        calls += [((c[0] + d + e, c[1] - 40), (c[0] + d + e, c[1] + 40), pt, boxes, rings, cells), ((c[0] - d - e, c[1] - 40), (c[0] - d - e, c[1] + 40), pt, boxes, rings, cells),
                                  ((c[0] - 40, c[1] + d + e), (c[0] + 40, c[1] + d + e), pt, boxes, rings, cells), ((c[0] + d + e, c[1] + d + e), (c[0] + d + e + 9, c[1] + d + e + 9), pt, boxes, rings, cells)]
            for pt in pts[:10]:  # passing within 10 px of the point, through it, and on the 10 px skip's edge
                for d in (0, 5, 9.999, 10, 10.001, 12):
                    calls += [((pt[0] - 50, pt[1] + d), (pt[0] + 50, pt[1] + d), pt, boxes, rings, cells), ((pt[0] + d, pt[1] - 50), (pt[0] + d, pt[1]), pt, boxes, rings, cells)]
        got = [(new(*c), lead_old(*c)) for c in calls]
        self.assertEqual([i for i, (a, b) in enumerate(got) if a != b], [])
        n, yes = len(got), sum(a for a, _ in got)  # 14506 pieces (5542 from the pages), 4700 clear
        self.assertTrue(page > 3000 and n > 10000 and 0.1 < yes / n < 0.9, (page, n, yes))

    def q5(self, **knobs):
        """The q5 stand-in page's map (q5_lines: its 8 circles in the shared frame, the run's focus and noted), then China's and
        Nigeria's notes on one Occ, with LN's module knobs set as given for the draw: (frame, svg, occ)."""
        lines, hero = q5_lines(); req = json.loads(lines[0]); keep = {k: getattr(LN, k) for k in knobs}
        K.setup(req["rows"], req["knobs"]["labels"], run.tables); geo.NE = SHP; occ = prod.Occ()
        st = style(); st["bubbles"].update(run.focus_style(hero)["bubbles"])
        try:
            for k, v in knobs.items(): setattr(LN, k, v)
            svg = bubbles.cl_bubbles(bubbles.Laid({"data": hero["leaves"]["bubbles"], "style": st}), occ)
            f = LN.Frame({"data": hero["leaves"]["leader_notes"], "style": st}); svg += LN.cl_leader_notes(f, occ)
        finally:
            for k, v in keep.items(): setattr(LN, k, v)
            setup()
        return f, svg, occ

    def notes_clear(self, f, svg, occ):
        """Every note drawn: each line a marked text (layer 1 takes none without a source) at 16 px at least, within half the
        picture, starting with no closing mark; its box off every circle and every box the bubbles claimed; its leader ending
        on its own point; no glyph (as the page check reads it, 2 px in) on any leader. Returns the notes' texts."""
        part = svg.split('data-node="leader_notes"')[1]; texts = run.drawn(part)[0]
        self.assertEqual(check_svg(part), [])
        self.leads_clear(occ, svg)
        for t in texts:
            self.assertTrue(t["src"] and t["size"] >= 16 and t["text"][:1] not in K.NO_LINE_START, t)
            self.assertLessEqual(prod.tw(t["text"], t["size"]), f.W / 2, t)
        for b in [q for q in occ.boxes if q[4] == "notes"]:
            self.assertEqual([q[:4] for q in occ.boxes if q[4] == "bubbles" and b[0] < q[2] and q[0] < b[2] and b[1] < q[3] and q[1] < b[3]], [], b)
            self.assertEqual([c[:3] for c in occ.circles if math.hypot(max(b[0] - c[0], 0, c[0] - b[2]), max(b[1] - c[1], 0, c[1] - b[3])) < c[2]], [], b)
        pts = {n["_id"]: n["_pt"] for n in f.notes}
        ends = [p[-1] for p in leaders(part)]
        self.assertEqual(len(ends), len(pts) - len(f.dropped))
        for e in ends: self.assertTrue(any(math.dist(e, p) < 0.08 for p in pts.values()), e)
        for m in re.finditer(r'<text x="([\d.]+)" y="([\d.]+)" font-size="([\d.]+)" text-anchor="(\w+)"[^>]*>(.*?)</text>', part):
            x, y, sz, an, inner = float(m[1]), float(m[2]), float(m[3]), m[4], re.sub(r"<[^>]+>", "", m[5])
            w = prod.tw(inner, sz); x0 = x if an == "start" else x - w
            g = (x0 + 2, y - 1.06 * sz + 2, x0 + w - 2, y + 0.27 * sz - 2)
            for l in segs(svg):
                n = max(2, int(math.dist(l[:2], l[2:]) / 1.5))
                self.assertFalse(any(g[0] < l[0] + (l[2] - l[0]) * t / n < g[2] and g[1] < l[1] + (l[3] - l[1]) * t / n < g[3] for t in range(n + 1)), (inner, l))
        return texts

    def test_a_note_with_no_room_at_its_own_break_moves_the_break_to_another_phrase_the_q5_page(self):
        # the q5 page (a change page, 11-01): Nigeria's note (升幅最小，比倒数第二低 and its gap) is too wide for one line beside
        # the map, and on two at the break before its number (249 px) no free box had a clear leader: the page stopped on
        # notes_dropped (dropped:leader_notes:NGA, no free place for the note). With no other break (ALT_BREAKS 0) that is what
        # the layer still does, China's note as on the run's page. Now the break moves to the phrase boundary after the
        # comma (the comma stays above, as no line starts with it): 208 px, and the note places left of Nigeria's circle on a
        # straight leader, off every circle and label; China's note is drawn byte for byte as before
        f0, svg0, _ = self.q5(ALT_BREAKS=0)
        self.assertEqual(f0.dropped, [("NGA", "no free place for the note")])
        chn = [("name:zh_names:iso3:CHN", "中国 升幅最大，比第二名高", 449.3, 51.6), ("fact:vs_hi", "0.6 个百分点", 449.3, 73.2)]  # as the run's page drew them
        self.assertEqual([(t["src"], t["text"], t["x"], t["y"]) for t in run.drawn(svg0.split('data-node="leader_notes"')[1])[0]], chn)
        nga = next(n for n in f0.notes if n["_id"] == "NGA")
        self.assertGreater(nga["_w"], 240); self.assertEqual(len(nga["_lines"]), 2)  # its own layout: two lines, the break before the number
        f, svg, occ = self.q5()
        self.assertEqual(f.dropped, [])
        texts = self.notes_clear(f, svg, occ)
        self.assertEqual([(t["src"], t["text"]) for t in texts], [c[:2] for c in chn] + [("name:zh_names:iso3:NGA", "尼日利亚 升幅最小，"), ("fact:vs_lo", "比倒数第二低 0.4 个百分点")])
        self.assertEqual([(t["x"], t["y"]) for t in texts[:2]], [c[2:] for c in chn])
        self.assertAlmostEqual(texts[3]["y"] - texts[2]["y"], 16 * LN.LINE, delta=0.11)
        self.assertEqual(svg.split("</text>")[:2], svg0.split("</text>")[:2])  # China's note, its leader and both its lines
        box = [q for q in occ.boxes if q[4] == "notes"][1]
        self.assertLess(box[2] - box[0], nga["_w"] - 30)
        self.assertIn('<tspan font-weight="700"><tspan data-src="fact:vs_lo">0.4 个百分点</tspan></tspan></text>', svg)

    def test_a_crowded_column_map_note_breaks_between_its_name_and_number_when_one_line_has_no_room(self):
        # the EU column map with a note at every country (a name and a number each), 18 px, label_count 12: with no other break
        # Germany's and Belgium's notes find no free place; now Germany's, set on two lines (its name, then its bold number),
        # places off every circle and label, and Belgium's alone is dropped and named
        every = [dict(at=POINT[ISO3[c]], name=c, value_text="fact:gap") for c in VALUES]
        def draw(**knobs):
            keep = {k: getattr(LN, k) for k in knobs}
            try:
                for k, v in knobs.items(): setattr(LN, k, v)
                return pair(dict(D, notes=every), label_count=12, note_size=18)
            finally:
                for k, v in keep.items(): setattr(LN, k, v)
        no_place = lambda f: sorted(c for c, w in f.dropped if w == "no free place for the note")
        self.assertEqual(no_place(draw(ALT_BREAKS=0)[1]), ["BE", "DE"])
        fb, fn, svg, occ = draw()
        self.assertEqual(no_place(fn), ["BE"])
        texts = self.notes_clear(fn, svg, occ)
        de = [(t["src"], t["text"]) for t in texts if t["src"].endswith(":DE")]
        i = [t["src"] for t in texts].index("name:zh_names:iso2:DE")
        self.assertEqual((de, texts[i + 1]["src"], texts[i + 1]["text"]), ([("name:zh_names:iso2:DE", ZH2["DE"])], "fact:gap", "54.8 个百分点"))
        self.assertAlmostEqual(texts[i + 1]["y"] - texts[i]["y"], 18 * LN.LINE, delta=0.11)
        self.assertEqual(texts[i]["x"], texts[i + 1]["x"])

    def test_a_note_too_wide_for_one_line_sets_its_number_and_unit_on_a_second_line(self):
        # beside Sweden's note on the bubbles' map: the name and the word on the first line, the bold number with its unit (its
        # ledger entry, whole and marked) on the second, each within half the map, both at the box's edge; the one box claimed
        # holds both lines, off every circle, label and other note, and no leader meets either line's glyph box (2 px in, as the
        # page check reads it); the two lines' glyph boxes do not meet. Before the break the note refused (wider than half)
        setup(ROWS + [CHG]); occ = prod.Occ(); size = 16
        svg = bubbles.cl_bubbles(bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": style()}), occ)
        f = LN.Frame({"data": dict(D, notes=[NOTES[0], WIDE]), "style": style()}); svg += LN.cl_leader_notes(f, occ)
        setup()
        self.assertEqual((check_svg(svg), f.dropped), ([], []))
        head = f"{ZH2['CN']} {K.WD.WORDS['column.note.rise_most']}"
        self.assertGreater(prod.tw(f"{head} {CHG['text']}", size), f.W / 2)  # one line would not fit
        texts = run.drawn(svg.split('data-node="leader_notes"')[1])[0]
        a, b = [t for t in texts if "name:" in t["src"] and t["src"].endswith(":CN")] + [t for t in texts if t["src"] == "fact:chg"]
        self.assertEqual((a["text"], b["text"], a["anchor"], a["x"]), (head, CHG["text"], b["anchor"], b["x"]))
        self.assertAlmostEqual(b["y"] - a["y"], size * LN.LINE, delta=0.11)
        self.assertLessEqual(max(prod.tw(a["text"], size), prod.tw(b["text"], size) * 1.06), f.W / 2)
        self.assertIn(f'<tspan font-weight="700"><tspan data-src="fact:chg">{CHG["text"]}</tspan></tspan></text>', svg)
        self.assertLessEqual(a["y"] + 0.27 * size, b["y"] - 1.06 * size)
        notes = [q for q in occ.boxes if q[4] == "notes"]; box = next(q for q in notes if q[1] - 0.01 <= a["y"] - 0.9 * size and b["y"] + 0.25 * size <= q[3] + 0.01)
        glyphs = []
        for t, k in ((a, 1), (b, 1.06)):
            w = prod.tw(t["text"], size) * k; x0 = t["x"] if t["anchor"] == "start" else t["x"] - w
            self.assertTrue(box[0] - 0.01 <= x0 and x0 + w <= box[2] + 0.01, (t["text"], box))
            glyphs.append((x0 + 2, t["y"] - 1.06 * size + 2, x0 + w - 2, t["y"] + 0.27 * size - 2))
        for q in [q for q in occ.boxes if q[4] == "bubbles"] + [q for q in notes if q is not box]:
            self.assertFalse(box[0] < q[2] and q[0] < box[2] and box[1] < q[3] and q[1] < box[3], q)
        for l in segs(svg):
            n = max(2, int(((l[2] - l[0]) ** 2 + (l[3] - l[1]) ** 2) ** 0.5 / 1.5))
            for g in glyphs:
                self.assertFalse(any(g[0] < l[0] + (l[2] - l[0]) * t / n < g[2] and g[1] < l[1] + (l[3] - l[1]) * t / n < g[3] for t in range(n + 1)), l)
        # through the leaf runner as layer 1 calls it: no refusal, both lines read back with their sources, and the page draws
        def wide(line):
            req = json.loads(line); req["rows"].append(CHG); req["knobs"]["labels"] = ZH2
            if "leader_notes" in req["knobs"]["spec"]["hero"]["leaves"]: req["knobs"]["spec"]["hero"]["leaves"]["leader_notes"]["notes"] = [NOTES[0], WIDE]
            return json.dumps(req, ensure_ascii=False)
        lines = [wide(l) for l in column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": D})]
        size_, bars, bub, key, got = child(lines)
        self.assertNotIn("refused", got)
        self.assertEqual([t["text"] for t in got["texts"] if t["src"] == "fact:chg" or t["src"].endswith(":CN")], [head, CHG["text"]])
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubbles": bub["svg"], "bubble_key": key["svg"], "leader_notes": got["svg"]}})])[5]
        self.assertNotIn("refused", page)

    def world(self, kind, a, b, long=None):
        """Two notes (a rises most, b least) over a map's bubbles, on one Occ: the EU level map (eu), the q5 change page's 8
        economies (q5) or the q6 page's 20 citizenships (q6). LONG_LEAD at `long` (huge: top first only, as before B5).
        (each leader's length in drawing order, dropped)."""
        if kind == "eu":
            rows, labels, items, ext, at = ROWS, ZH2, ITEMS, EXT, {c: POINT[ISO3[c]] for c in VALUES}
            rows = rows + [{"src": "fact:gap", "text": "54.8 个百分点"}]
        elif kind == "q5":
            rows = [{"src": f"series:t/{c}:2025:value", "table": "t", "dims": {"country": c}, "time": "2025", "value": str(v)} for c, v in Q5_T1.items()]
            rows += [{"src": f"fact:val.{c}", "text": f"{v:.2f}%"} for c, v in Q5_T1.items()] + [{"src": "fact:gap", "text": "1.80 吨二氧化碳当量/人"}, {"src": "fact:times", "text": "1.43 吨二氧化碳当量/人"}]
            labels, ext, at = ZH3, Q5_EXT, {c: POINT[c] for c in Q5_T1}
            items = [dict(code=c, value=f"series:t/{c}:2025:value", value_text=f"fact:val.{c}", lonlat=at[c]) for c in Q5_T1]
        else:
            rows = [{"src": f"series:t/{c}:2025:value", "table": "t", "dims": {"citizen": c}, "time": "2025", "value": str(v)} for c, v in Q6_VALUES.items()]
            rows += [{"src": f"fact:val.{c}", "text": f"{v:,}"} for c, v in Q6_VALUES.items()] + [{"src": "fact:gap", "text": "99,825 人"}, {"src": "fact:times", "text": "9.0倍"}]
            labels, ext, at = ZH2, Q6_EXT, {c: list(Q6_AT[c]) for c in Q6_VALUES}
            items = [dict(code=c, value=f"series:t/{c}:2025:value", value_text=f"fact:val.{c}", lonlat=at[c]) for c in Q6_VALUES]
        notes = [dict(at=at[a], name=a, text=[{"word": "column.note.rise_most"}], value_text="fact:gap"),
                 dict(at=at[b], name=b, text=[{"word": "column.note.rise_least"}], value_text="fact:times")]
        was = LN.LONG_LEAD
        try:
            if long is not None: LN.LONG_LEAD = long
            K.setup(rows, labels, run.tables); geo.NE = SHP; occ = prod.Occ()
            bubbles.cl_bubbles(bubbles.Laid({"data": dict(items=items, ext=ext), "style": style()}), occ)
            fn = LN.Frame({"data": dict(ext=ext, notes=notes), "style": style()}); svg = LN.cl_leader_notes(fn, occ)
        finally:
            LN.LONG_LEAD = was
        self.assertEqual(check_svg(svg), [])
        return [round(sum(math.dist(p, q) for p, q in zip(x, x[1:]))) for x in leaders(svg)], fn.dropped

    def test_notes_placed_top_first_on_a_long_leader_are_tried_bottom_first_and_the_shorter_kept(self):
        # B5 (11-04): the q4 page's China note took a 243 px leader round the USA note placed above it (bottom first, 29). Three
        # data shapes: the EU level map, the q5 change page's 8 economies, the q6 page's 20 citizenships (world maps); each
        # pair's longest leader top first, then as drawn now (the drawing order is the order kept)
        for kind, a, b, before, now in [("eu", "HR", "BG", [129, 204], [19, 93]), ("q5", "BGD", "PAK", [13, 262], [23, 175]),
                                        ("q6", "CD", "PE", [41, 406], [23, 41]), ("q6", "BD", "SO", [109, 201], [44, 120])]:
            self.assertEqual(self.world(kind, a, b, long=10 ** 9), (before, []), (kind, a, b))
            self.assertEqual(self.world(kind, a, b), (now, []), (kind, a, b))
            self.assertLess(max(now), max(before))
        # a pair whose bottom-first order is no shorter keeps top first, as drawn before; one under LONG_LEAD is never re-laid
        for kind, a, b in [("q6", "CD", "GN"), ("eu", "SE", "LU")]:
            self.assertEqual(self.world(kind, a, b), self.world(kind, a, b, long=10 ** 9), (kind, a, b))

    def test_a_note_that_fits_one_line_draws_as_before(self):
        # the q1 page's notes (a name, a word, a number with a short unit) fit one line: the layer, drawn alone on an empty Occ,
        # is byte for byte the one drawn before the two-line break (its sha on the commit before it), one text per note
        setup(); svg = LN.draw({"data": D, "style": style()})[0]
        self.assertEqual((hashlib.sha256(svg.encode()).hexdigest(), svg.count("<text")), ("98a2a482ca787f8f00802d390fd2091906e511ba726c610eecaf6bef8db874fe", 2))

    def test_the_q1_and_change_pages_notes_over_the_bubbles_draw_as_before_two_bends(self):
        # over the EU bubbles: the q1 page's two notes, and a change page's (q4-style: a rise_most note on two lines beside
        # Sweden's); each found a straight or one-bend leader, so each layer is byte for byte the one drawn before two bends were
        # tried (its sha on the commit before them), nothing dropped
        for notes, rows, pin in (([NOTES[0], NOTES[1]], ROWS, "e9c8281fae2c6bba17f6f980ef8cc0df2408a9911cce1b263f0d489035c7531a"),
                                 ([NOTES[0], WIDE], ROWS + [CHG], "a3f79be867c910de50165963a89940e2e98f0f2f92f6cfeaad6698069f1ecc75")):
            setup(rows); occ = prod.Occ(); bubbles.cl_bubbles(bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": style()}), occ)
            f = LN.Frame({"data": dict(D, notes=notes), "style": style()}); svg = LN.cl_leader_notes(f, occ)
            self.assertEqual((hashlib.sha256(svg.encode()).hexdigest(), f.dropped), (pin, []))
        setup()

    def test_a_note_too_wide_on_two_lines_refuses_as_before(self):
        # the number's own line past half the map too: refused with the one-line message as before the break, its width and words
        too = dict(CHG, text="1.55 " + "吨二氧化碳当量" * 4 + "/人"); size = 16
        setup(ROWS + [too])
        with self.assertRaises(Refused) as e: LN.Frame({"data": dict(D, notes=[WIDE]), "style": style()})
        setup()
        name, word = ZH2["CN"], K.WD.WORDS["column.note.rise_most"]; plain = f"{name} {word} {too['text']}"
        wd = max(prod.tw(name, size) + size * 0.3 + prod.tw(word, size) + size * 0.3 + prod.tw(too["text"], size) * 1.06, prod.tw(plain, size))
        self.assertGreater(prod.tw(too["text"], size) * 1.06, run.column.MAP_W / 2)
        self.assertEqual(str(e.exception), f"leader_notes: note 1 is wider than half the picture at {size} px ({wd:.0f} px of {run.column.MAP_W / 2:.0f}, W {run.column.MAP_W}: '{plain}')")

    def test_the_refusals(self):
        for tag, d, nst, labels, why in [
            ("no-notes", dict(D, notes=[]), {}, ZH2, "no notes"),
            ("no-name-no-text", dict(D, notes=[dict(at=[10, 50])]), {}, ZH2, "neither a name nor words"),
            ("bad-point", dict(D, notes=[dict(at="x", text=W("甲"))]), {}, ZH2, "[lon, lat]"),
            ("hub-missing", dict(D, notes=[dict(at="hub", text=W("甲"))]), {}, ZH2, "gives none"),
            ("no-ext", {k: v for k, v in D.items() if k != "ext"}, {}, ZH2, "data.ext"),
            ("ext-off-globe", dict(D, ext=[-200, 20, 60, 72]), {}, ZH2, "data.ext"),
            ("size-14", D, {"note_size": 14}, ZH2, "off its range 16..22"),
            ("side-word", D, {"side": "top"}, ZH2, "not one of"),
            ("digit-literal", dict(D, notes=[dict(at=[10, 50], text=W("增长12%"))]), {}, ZH2, "hold a digit"),
            ("bare-string", dict(D, notes=[dict(at=[10, 50], text="fact:gap")]), {}, ZH2, "given as a ledger source"),
            ("missing-entry", dict(D, notes=[dict(at=[10, 50], text=[{"src": "fact:zz"}])]), {}, ZH2, "not in the request's ledger"),
            ("missing-value-text", dict(D, notes=[dict(at=[10, 50], name="SE", value_text="fact:zz")]), {}, ZH2, "not in the request's ledger"),
            ("no-name-label", D, {}, {k: v for k, v in ZH2.items() if k != "SE"}, "SE"),
            ("too-wide", dict(D, notes=[dict(at=[10, 50], text=W("很长的说明文字" * 30))]), {}, ZH2, "wider than half"),
            ("unknown-highlight", D, {"highlight": "ZZ"}, ZH2, "codes the request does not hold"),
            ("colour-knob", D, {"fill": "#fff"}, ZH2, "no knob"),
            ("word-placeholder", dict(D, notes=[dict(at=[10, 50], text=[{"word": "date.y"}])]), {}, ZH2, "placeholder"),
        ]:
            with self.subTest(tag), self.assertRaises(Refused) as e:
                setup(labels=labels); LN.Frame({"data": d, "style": style(**nst)})
            self.assertIn(why, str(e.exception), tag)
        with self.assertRaises(Refused) as e:
            setup([]); LN.Frame({"data": D, "style": style()})
        self.assertIn("ledger only", str(e.exception))


# A change page's earlier end (test-only): each place's value at 2016, so its change to 2023 is VALUES less this; SE rose most,
# LU fell most (changed's order), the others rose a little.
EARLIER = {c: round(v - (9.5 if c == "SE" else -3.25 if c == "LU" else 1.0 + i * 0.25), 2) for i, (c, v) in enumerate(VALUES.items())}


def column_lines(leaves, accent=None, change=False):
    """A column page's size and layer lines with the map panel's leaves, as layer 1 sends them in the column recipe's order (next_run
    bubbles_fill and leader_notes_fill; the key to the circles, which comes with the bubbles, between them; the ledger as next_facts
    makes it); the place layer 1 names as the page's accent (fill_of: the dek's) when given. A change page's (change): the bars
    each place's change from 2016 (EARLIER) to 2023, ranked by it (next_run change_bars_fill), the bars' measure change. A
    level page's bars are bound external and placed where the core places them (placed_lines)."""
    rows = [r for r in ROWS if r["src"].startswith("series:")]
    ledger = {**{f"fact:val.{c}.n": str(v) for c, v in VALUES.items()}, **{r["src"]: r["text"] for r in ROWS if "text" in r}, "period:t:2023": "2023"}
    ranked = sorted(VALUES, key=lambda c: -VALUES[c])
    data = {"chart": "bars", "by": "geo", "year": "2023", "family": "val", "ranked": ranked, "marks": [], **({"accent": accent} if accent else {})}
    hero = {"unit": "单位：%", "data": data, "leaves": leaves}
    if change:
        rows += [{"src": f"series:t/A.PC.{c}:2016:OBS_VALUE", "table": "t", "dims": {"freq": "A", "unit": "PC", "geo": c}, "time": "2016", "value": str(v)}
                 for c, v in EARLIER.items()]
        moved = {c: VALUES[c] - EARLIER[c] for c in VALUES}
        ledger.update({f"fact:chg.{c}": f"{d:.2f} 个百分点" for c, d in moved.items()})
        ledger["period:t:2016"] = "2016"
        data.update(t0="2016", family="chg", ranked=sorted(VALUES, key=lambda c: -moved[c]))
        hero["style"] = {"bars": {"measure": "change"}}
    spec = {"title": "标题", "dek": "导语", "kicker": "栏目", "source": "t", "refs": ["t"], "tables": {"t": {"id": "t"}},
            "facts": {"val": {"each": "geo", "table": "t", "time": "2023", "fmt": "pc"}}, "fmts": {"pc": {"scale": 1, "dec": 1, "suffix": "%"}, "time": {}},
            "hero": hero}
    knobs = {"spec": spec, "labels": ZH2, "shapes": SHP}
    rows = rows + [{"src": k, "text": v} for k, v in ledger.items()]
    line = lambda **kv: json.dumps({"node": "column", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows, "knobs": knobs, **kv}, ensure_ascii=False)
    lines = [line(phase="size"), line(layer="bars"), line(layer="bubbles"), line(layer="bubble_key"), line(layer="leader_notes")]
    if change:
        return lines
    try:
        return placed_lines(lines)
    except prod.FX.Refused:  # a page whose frame refuses goes as it is, to be refused at its size line
        return lines



def q6_lines(scoped):
    """The q6 stand-in page's column lines as layer 1 sent them (the run's 20 values ranked, their circles, the key, Afghanistan's and
    Iraq's notes, Afghanistan the dek's accent; the ledger's texts the run's): its note keys a cut's (scoped: next_run LEADER_NOTES,
    the run's table the top 20 citizenships) or the plain ones."""
    v = Q6_VALUES; ranked = sorted(v, key=lambda c: -v[c]); hi, lo = ("column.note.hi.scoped", "column.note.lo.scoped") if scoped else ("column.note.hi", "column.note.lo")
    rows = [{"src": f"series:t/A.{c}:2025:OBS_VALUE", "table": "t", "dims": {"freq": "A", "citizen": c}, "time": "2025", "value": str(v[c])} for c in ranked]
    ledger = {**{f"fact:val.{c}.n": f"{v[c]:,}" for c in ranked}, "fact:gap": "99,825 人", "fact:times": "9.0倍", "period:t:2025": "2025"}
    items = [dict(code=c, value=f"series:t/A.{c}:2025:OBS_VALUE", value_text=f"fact:val.{c}.n", lonlat=list(Q6_AT[c])) for c in ranked]
    notes = [dict(at=list(Q6_AT["AF"]), name="AF", text=[{"word": hi}], value_text="fact:gap"), dict(at=list(Q6_AT["IQ"]), name="IQ", text=[{"word": lo}], value_text="fact:times")]
    data = {"chart": "bars", "by": "citizen", "year": "2025", "family": "val", "ranked": ranked, "marks": [], "accent": "AF"}
    hero = {"unit": "单位：人", "data": data, "leaves": {"bubbles": dict(items=items, ext=Q6_EXT), "leader_notes": dict(ext=Q6_EXT, notes=notes)}}
    spec = {"title": "标题", "dek": "导语", "kicker": "栏目", "source": "t", "refs": ["t"], "tables": {"t": {"id": "t"}},
            "facts": {"val": {"each": "citizen", "table": "t", "time": "2025", "fmt": "per"}}, "fmts": {"per": {"scale": 1, "dec": 0, "suffix": " 人"}, "time": {}},
            "hero": hero}
    knobs = {"spec": spec, "labels": ZH2, "shapes": SHP}
    rows = rows + [{"src": k, "text": t} for k, t in ledger.items()]
    line = lambda **kv: json.dumps({"node": "column", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows, "knobs": knobs, **kv}, ensure_ascii=False)
    return placed_lines([line(phase="size"), line(layer="bars"), line(layer="bubbles"), line(layer="bubble_key"), line(layer="leader_notes")])

def q5_lines():
    """The q5 stand-in page's change-recipe lines as layer 1 sent them (next_run change_notes_fill): the bars each place's change
    2016 to 2025 ranked by it, a circle per place at its 2025 value, the key, and the two notes, each comparing its place with
    its neighbour (China's rise most, above the second by fact:vs_hi; Nigeria's least, below the one before it by fact:vs_lo),
    China the dek's accent. Returns (lines, hero)."""
    ranked = sorted(Q5_T1, key=lambda c: -(Q5_T1[c] - Q5_T0[c]))
    rows = [{"src": f"series:{Q5_TABLE}/{c}:{t}:value", "table": Q5_TABLE, "dims": {"country": c}, "time": t, "value": v[c]} for t, v in (("2025", Q5_T1), ("2016", Q5_T0)) for c in ranked]
    items = [dict(code=c, value=f"series:{Q5_TABLE}/{c}:2025:value", value_text=f"fact:val.{c}.n", lonlat=POINT[c]) for c in ranked]
    notes = [dict(at=POINT[ranked[0]], name=ranked[0], text=[{"word": "column.note.rise_most"}, {"word": "column.note.vs_next"}], value_text="fact:vs_hi"),
             dict(at=POINT[ranked[-1]], name=ranked[-1], text=[{"word": "column.note.rise_least"}, {"word": "column.note.vs_prev"}], value_text="fact:vs_lo")]
    data = {"chart": "bars", "by": "country", "year": "2025", "t0": "2016", "family": "chg", "ranked": ranked, "marks": [], "accent": ranked[0]}
    hero = {"unit": "单位：%", "data": data, "style": {"bars": {"measure": "change"}}, "leaves": {"bubbles": dict(items=items, ext=Q5_EXT), "leader_notes": dict(ext=Q5_EXT, notes=notes)}}
    spec = {"title": "标题", "dek": "导语", "kicker": "栏目", "source": "t", "refs": [Q5_TABLE], "tables": {Q5_TABLE: {"id": Q5_TABLE}},
            "facts": {"val": {"each": "country", "table": Q5_TABLE, "time": "2025", "fmt": "pc"}}, "fmts": {"pc": {"scale": 1, "dec": 2, "suffix": "%"}, "time": {}}, "hero": hero}
    knobs = {"spec": spec, "labels": {c: ZH3[c] for c in ranked}, "shapes": SHP}
    rows = rows + [{"src": k, "text": t} for k, t in {**Q5_LEDGER, f"period:{Q5_TABLE}:2016": "2016", f"period:{Q5_TABLE}:2025": "2025"}.items()]
    line = lambda **kv: json.dumps({"node": "change", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows, "knobs": knobs, **kv}, ensure_ascii=False)
    return [line(phase="size"), line(layer="bars"), line(layer="bubbles"), line(layer="bubble_key"), line(layer="leader_notes")], hero


def child(lines):
    out = subprocess.run([sys.executable, "-I", "-B", os.path.join(LEAVES, "run.py")], input="\n".join(lines) + "\n", capture_output=True, text=True, check=True).stdout
    return [json.loads(l) for l in out.splitlines()]


class ColumnMap(unittest.TestCase):
    def test_the_map_panel_stands_beside_the_bars_in_one_panel(self):
        lines = column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": D})
        size, bars, bub, key, notes = child(lines)
        self.assertEqual((bub.get("refused"), key.get("refused"), notes.get("refused")), (None, None, None))
        x0 = 560 + 40
        self.assertEqual(size["w"], 1140)
        self.assertGreater(size["h"], 24 * len(VALUES))  # the taller of the map and the bars
        self.assertTrue(all(t["x"] >= x0 for t in bars["texts"] if t["anchor"] != "end") and all(t["x"] > x0 for t in bars["texts"]))
        self.assertTrue(all(t["x"] <= 560 for t in bub["texts"] + key["texts"] + notes["texts"]))
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubbles": bub["svg"], "bubble_key": key["svg"], "leader_notes": notes["svg"]}})])[5]
        html = page["html"]
        self.assertRegex(html, r'<svg class="cmap"[^>]*><g data-layer="bubbles">.*</g><g data-layer="bubble_key">.*</g><g data-layer="leader_notes">.*</g></svg><svg class="bars pub-chart"')
        self.assertRegex(html, rf'class="bars pub-chart"[^>]*viewBox="{x0} 0 540 ')
        self.assertEqual(run.placeholders(html), [])

    def test_a_map_with_bubbles_gets_their_key_and_a_page_without_them_none(self):
        # with the bubbles the page places the key's layer between them and the notes, and the notes keep clear of its box; without
        # them (bars alone) the page places no key: one given refuses
        lines = column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": D})
        size, bars, bub, key, notes = child(lines)
        self.assertEqual([k for k in ("refused", "dropped") if k in key], [])
        self.assertTrue(key["texts"])
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubbles": bub["svg"], "leader_notes": notes["svg"]}})])[5]
        self.assertEqual(page["refused"], ["page: no layer bubble_key"])
        lines = column_lines({})[:2]
        size, bars = child(lines)
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubble_key": key["svg"]}})])[2]
        self.assertEqual(page["refused"], ["page: bubble_key is no layer the page places"])

    def page_of(self, lines):
        """The page the child draws over the column lines' layers (the map panel's when the hero has one)."""
        got = child(lines)
        layers = dict(zip(["bars", "bubbles", "bubble_key", "leader_notes"][: len(got) - 1], [g["svg"] for g in got[1:]]))
        self.assertEqual([g.get("refused") for g in got], [None] * len(got))
        return child(lines + [json.dumps({"phase": "page", "layers": layers})])[len(lines)]["html"]

    def marked(self, html, ink, ranked):
        """The circles (by code) and the bars (by their row's place) filled or stroked in `ink`, and how many elements are."""
        rh, top = prod.KNOBS["bars"]["row"][0], prod.KNOBS["bars"]["top"][0]
        circles = sorted(re.findall(rf'<circle [^>]*fill="var\({ink}\)"[^>]*data-code="(\w+)"', html))
        rows = sorted(round((float(y) - 3 - top) / rh) for y in re.findall(rf'<rect x="[\d.]+" y="([\d.]+)"[^>]*fill="var\({ink}\)"', html))
        return circles, [ranked[i] for i in rows]

    def test_the_accent_marks_only_the_dek_s_place_the_other_noted_place_takes_the_dark_grey_and_the_unit_line_says_so(self):
        # the q1-style page (its notes name SE and LU, the extremes) and the q4-style change page (its notes SE's largest rise and
        # LU's largest fall): layer 1 names SE, the dek's place, as the accent. In the page every element filled or stroked in the
        # accent is SE's: its circle and its bar; LU keeps its note, its circle and bar in the dark grey; the unit line ends in the
        # accent's legend, words only. The kicker's last rule in the page's css (the one that wins: same selector weight or more,
        # later) sets it in the title's ink, not the accent
        legend = lambda html: re.findall(r'<span class="ak(?: nk)?">([^<]*)</span>', (re.search(r'<div class="cu">((?:(?!</div>).)*)</div>', html) or [None, ""])[1])
        accent, noted = K.WD.WORDS["column.accent"], K.WD.WORDS["column.noted"]
        chg = [dict(at=POINT["SWE"], name="SE", text=[{"word": "column.note.rise_most"}], value_text="fact:chg.SE"),
               dict(at=POINT["LUX"], name="LU", text=[{"word": "column.note.fall_most"}], value_text="fact:chg.LU")]
        for change, notes in ((False, D), (True, dict(D, notes=chg))):
            lines = column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": notes}, accent="SE", change=change)
            ranked = json.loads(lines[0])["knobs"]["spec"]["hero"]["data"]["ranked"]
            html = self.page_of(lines)
            marked = re.findall(r'<(\w+)\b[^>]*(?:fill|stroke)="var\(--accent\)"[^>]*>', html)
            self.assertEqual(sorted(marked), ["circle", "rect"], change)
            self.assertEqual(self.marked(html, "--accent", ranked), (["SE"], ["SE"]), change)
            self.assertEqual(self.marked(html, "--t-body", ranked), (["LU"], ["LU"]), change)
            # B3 (11-04): the dark grey of the noted place is in the legend too, after the accent, its swatch in that grey
            self.assertEqual(legend(html), [accent, noted], change)
            self.assertIn(f'<span class="ak nk">{noted}</span>', html)
            self.assertFalse(re.search(r"[0-9０-９]", accent + noted))
            self.assertIn('data-src="fact:chg.LU"' if change else 'data-src="fact:times"', html)  # LU's note stays
        css = re.search(r"<style>(.*)</style>", html, re.S).group(1)
        rules = re.findall(r"(?:^|})\s*([^{}]*\.kicker)\{([^}]*)\}", css)
        self.assertEqual(rules[-1], (".hh .kicker", "color:var(--t-title)"))
        self.assertIn('<header class="hh', html)
        self.assertRegex(html, r'<header class="hh[^"]*"><div><div class="kicker">')
        # no accent from layer 1 (no finding and no claim): nothing in the accent and no legend; both noted places dark grey
        html = self.page_of(column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": D}))
        self.assertEqual(re.findall(r'(?:fill|stroke)="var\(--accent\)"', html), [])
        self.assertEqual(self.marked(html, "--t-body", sorted(VALUES, key=lambda c: -VALUES[c])), (["LU", "SE"], ["SE", "LU"]))
        self.assertEqual(legend(html), [noted])  # no accent, so no accent legend; the dark grey drawn, so its line

    def test_on_a_page_with_a_legend_the_bold_title_ink_names_are_exactly_the_accent_s_and_the_dark_grey_s(self):
        # B6 (11-04): the q1 stand-in read the bold title-ink names of layer 1's marks (Sweden, Belgium) as the dark grey the
        # legend gives the notes, whose place (Croatia) printed plain beside its dark bar. Two shapes: the q1-style change page
        # (notes on SE and LU, SE the accent) and the q6 level page (notes on AF and IQ, AF the accent), each with marks of
        # other places; then the bold names are the accent's and the noted place's, nothing else, and their bars those inks
        def with_marks(lines, marks):
            out = []
            for line in lines:
                d = json.loads(line); d["knobs"]["spec"]["hero"]["data"]["marks"] = marks; out.append(json.dumps(d, ensure_ascii=False))
            return out
        bold = lambda html: sorted(re.findall(r'<text [^>]*fill="var\(--t-title\)" font-weight="700"><tspan data-src="name:[^"]*:(\w+)">', html))
        chg = [dict(at=POINT["SWE"], name="SE", text=[{"word": "column.note.rise_most"}], value_text="fact:chg.SE"),
               dict(at=POINT["LUX"], name="LU", text=[{"word": "column.note.fall_most"}], value_text="fact:chg.LU")]
        q1 = column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": dict(D, notes=chg)}, accent="SE", change=True)
        for lines, marks, want in ((q1, ["DE", "BE", "SE"], ["LU", "SE"]), (q6_lines(False), ["VE", "SY", "AF"], ["AF", "IQ"])):
            ranked = json.loads(lines[0])["knobs"]["spec"]["hero"]["data"]["ranked"]
            html = self.page_of(with_marks(lines, marks))
            names = bold(html)
            self.assertEqual(sorted(set(names)), want, marks)
            accent, = (c for c in want if c in ("SE", "AF"))
            self.assertEqual(self.marked(html, "--accent", ranked)[1], [accent])
            self.assertEqual(self.marked(html, "--t-body", ranked)[1], [c for c in want if c != accent])
        # a page with no legend (no accent, no notes) keeps layer 1's marks bold, as before
        sys.path.insert(0, HERE); import test_leaves_ledger as TL
        got = TL.child(TL.column_request())
        layers = {n: g.get("svg") or g.get("html") for n, g in zip(["bignums", "bars"], got[1:])}
        html = TL.child(TL.column_request() + [json.dumps({"phase": "page", "layers": layers})])[-1]["html"]
        self.assertEqual(sorted(set(bold(html))), ["BE"])

    def test_a_change_note_that_compares_with_its_neighbour_prints_the_words_and_the_gap_entry(self):
        # next_run change_notes_fill: the first ranked place's note says it is above the second by a gap, the last's that it is
        # below the one before it, the gap a ledger entry (vs_hi, vs_lo) in bold after the words; both note words join with no
        # blank, and the note is set within half the map (on two lines when the one is too wide), never refused
        chg = [dict(at=POINT["SWE"], name="SE", text=[{"word": "column.note.rise_most"}, {"word": "column.note.vs_next"}], value_text="fact:vs_hi"),
               dict(at=POINT["LUX"], name="LU", text=[{"word": "column.note.fall_most"}, {"word": "column.note.vs_prev"}], value_text="fact:vs_lo")]
        gaps = {"fact:vs_hi": "2.3 个百分点", "fact:vs_lo": "0.4 个百分点"}
        lines = []
        for line in column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": dict(D, notes=chg)}, accent="SE", change=True):
            d = json.loads(line); d["rows"] = d["rows"] + [{"src": k, "text": v} for k, v in gaps.items()]; lines.append(json.dumps(d, ensure_ascii=False))
        html = self.page_of(lines)
        words = K.WD.WORDS
        self.assertNotRegex(words["column.note.vs_next"] + words["column.note.vs_prev"], r"[0-9０-９]")
        notes = re.search(r'<g data-layer="leader_notes">(.*?)</g>\s*</g>', html, re.S) or re.search(r'<g data-layer="leader_notes">(.*)', html, re.S)
        plain = re.sub(r"<[^>]+>", " ", notes.group(1))
        for name, w1, w2, k in (("SE", "column.note.rise_most", "column.note.vs_next", "fact:vs_hi"), ("LU", "column.note.fall_most", "column.note.vs_prev", "fact:vs_lo")):
            self.assertIn(words[w1] + words[w2], plain, name)
            self.assertIn(f'data-src="{k}"', html, name)

    def test_on_a_column_page_without_a_map_the_accent_marks_the_one_bar_and_the_legend_says_so(self):
        # bars alone (no map, no notes): the accent's place's bar alone in the accent, every other in the bars' grey; a place
        # layer 1 names the page does not rank refuses
        for change in (False, True):
            lines = column_lines({}, accent="LU", change=change)[:2]
            ranked = json.loads(lines[0])["knobs"]["spec"]["hero"]["data"]["ranked"]
            html = self.page_of(lines)
            self.assertEqual(self.marked(html, "--accent", ranked), ([], ["LU"]), change)
            self.assertEqual(self.marked(html, "--t-body", ranked), ([], []), change)
            self.assertIn(f'<span class="ak">{K.WD.WORDS["column.accent"]}</span></div>', html)
        self.assertEqual(child(column_lines({}, accent="CN")[:1])[0]["refused"], ["size: column: the accent names CN, no place the page ranks"])

    def test_the_scope_leads_the_unit_line_by_its_reviewed_name_and_the_counted_number(self):
        # hero.scope: the aggregate's code and the fact counting the places drawn. The name prints from the request's labels
        # (the reviewed name table), marked with its name row; the count from its ledger entry; the words from the word
        # table. A code the labels do not name prints no scope at all: only the unit and the year.
        def scoped(line, labels):
            req = json.loads(line); req["knobs"]["spec"]["hero"]["scope"] = {"code": "EU27_2020", "count": "drawn"}
            req["knobs"]["labels"] = labels; req["rows"].append({"src": "fact:drawn.n", "text": str(len(VALUES))})
            return json.dumps(req, ensure_ascii=False)
        for labels, unit in (({**ZH2, "EU27_2020": "欧盟"}, '<tspan data-src="name:zh_names:iso3:EU27_2020">欧盟</tspan> <span data-src="fact:drawn.n">27</span> 国　单位：%；'),
                             (ZH2, '单位：%；')):
            lines = [scoped(l, labels) for l in column_lines({})]
            size, bars = child(lines[:2])
            page = child(lines[:2] + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"]}})])[2]
            self.assertIn(f'<div class="cu">{unit}', page["html"])
            self.assertNotIn("德国和", page["html"])

    def test_two_extents_or_notes_without_bubbles_refuse(self):
        got = child(column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": dict(D, ext=[-20, 30, 40, 70])})[:1])[0]
        self.assertEqual(got["refused"], ["size: column: the leader notes and the bubbles name two extents; the map panel has one frame"])
        got = child(column_lines({"leader_notes": D})[:1])[0]
        self.assertEqual(got["refused"], ["size: column: the leader notes point at the bubbles' map, and the hero has none"])

    def test_a_crowded_map_still_draws_and_says_exactly_which_notes_it_dropped(self):
        # the EU-27 with one note per country (its name and a number), label_count 12 and note_size 22: fifteen past it, and of
        # the twelve the ones in the crowded centre with no free place; the layer and the page still draw, and the reply names each
        # dropped note by its code, once, with why: exactly the leaf's own list
        notes = [dict(at=POINT[ISO3[c]], name=c, value_text="fact:gap") for c in VALUES]
        def styled(line):
            req = json.loads(line); req["knobs"]["spec"]["hero"]["style"] = {"leader_notes": {"label_count": 12, "note_size": 22}}
            return json.dumps(req, ensure_ascii=False)
        lines = [styled(l) for l in column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": dict(D, notes=notes)})]
        size, bars, bub, key, got = child(lines)
        self.assertNotIn("refused", got)
        drawn = {p.split(":")[-1] for t in got["texts"] for p in t["src"].split("+") if p.startswith("name:")}
        dropped = {d["id"]: d["why"] for d in got["dropped"]}
        self.assertEqual(len(got["dropped"]), len(dropped))  # no id twice
        self.assertEqual((set(VALUES), drawn & set(dropped)), (drawn | set(dropped), set()))  # each note drawn or named, not both
        self.assertEqual(sum(w == "past label_count" for w in dropped.values()), len(VALUES) - 12)
        self.assertTrue({c for c, w in dropped.items() if w == "no free place for the note"})  # the crowded centre leaves some
        setup(); f = LN.Frame({"data": dict(D, notes=notes), "style": style(label_count=12, note_size=22)}); occ = prod.Occ()
        bubbles.cl_bubbles(bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": style()}), occ); LN.cl_leader_notes(f, occ)
        self.assertEqual([{"id": c, "why": w} for c, w in f.dropped], got["dropped"])
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubbles": bub["svg"], "bubble_key": key["svg"], "leader_notes": got["svg"]}})])[5]
        self.assertNotIn("refused", page)
        self.assertIn('data-layer="leader_notes"', page["html"])

    def test_crowded_bubbles_still_draw_and_say_exactly_which_labels_they_dropped(self):
        # the EU-27 bubbles of the column page with its largest labels (size 16) and no leaders (reach 0; the page fixes
        # label_top, the hero's style cannot raise it): every circle drawn, and each of the MAP_LABELS labels (the biggest and
        # the smallest, then by size) drawn or named in the reply's dropped list (the leaf's Frame.dropped), never both, never
        # silently left off
        crowd = {"reach": 0, "size": 16}
        def styled(line):
            req = json.loads(line); req["knobs"]["spec"]["hero"]["style"] = {"bubbles": crowd}
            return json.dumps(req, ensure_ascii=False)
        got = child([styled(l) for l in column_lines({"bubbles": dict(items=ITEMS, ext=EXT)})])[2]
        self.assertNotIn("refused", got)
        self.assertEqual(got["svg"].count("<circle") - got["svg"].count("data-at="), len(VALUES))  # the dots of nudged circles aside
        labelled = {t["src"].split(":")[-1] for t in got["texts"] if t["src"].startswith("name:")}
        dropped = {d["id"]: d["why"] for d in got["dropped"]}
        self.assertTrue(dropped, "the crowded centre leaves a label with no place")
        self.assertEqual(set(dropped.values()), {"no free place for the label"})
        by_size = sorted(VALUES, key=lambda c: -VALUES[c]); top = by_size[:1] + by_size[-1:] + by_size[1:run.MAP_LABELS - 1]
        self.assertEqual((labelled | set(dropped), labelled & set(dropped)), (set(top), set()))
        setup(); f = bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": {**style(), "bubbles": {**style()["bubbles"], **crowd}}})
        bubbles.cl_bubbles(f, prod.Occ())
        self.assertEqual([{"id": c, "why": w} for c, w in f.dropped], got["dropped"])
        # with leaders (the default reach) the same crowded set labels more circles, each label still clear of every circle
        # and joined to its own by a leader that starts on that circle's edge
        setup(); g = bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": style(True)}); svg = bubbles.cl_bubbles(g, prod.Occ())
        self.assertLess(len(g.dropped), len(f.dropped))
        lines = [tuple(map(float, m)) for m in re.findall(r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', svg)]
        self.assertTrue(lines)
        for x1, y1, _, _ in lines:
            self.assertTrue(any(abs(((x1 - j["_xy"][0]) ** 2 + (y1 - j["_xy"][1]) ** 2) ** 0.5 - j["_r"]) < 0.2 for j in g.items), (x1, y1))
        for code, b in g.label_boxes:
            self.assertEqual([j["code"] for j in g.items if ((max(b[0] - j["_xy"][0], 0, j["_xy"][0] - b[2])) ** 2 + (max(b[1] - j["_xy"][1], 0, j["_xy"][1] - b[3])) ** 2) ** 0.5 < j["_r"]], [], code)

    def test_the_eu_map_labels_most_circles_close_first_then_out_on_short_leaders(self):
        # the EU-27 in the column page's shared frame: its MAP_LABELS circles, the biggest and the smallest first, are each
        # labelled (none dropped: the bars beside it print the rest); a label beside its circle has no leader, one set out has a
        # leader from its own circle's edge no longer than reach
        setup(); occ = prod.Occ(); f = bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": style()}); svg = bubbles.cl_bubbles(f, occ)
        reach = bubbles.prod.KNOBS["bubbles"]["reach"][0]
        self.assertEqual((len(f.label_boxes), f.dropped), (run.MAP_LABELS, []))
        ends = {max(VALUES, key=VALUES.get), min(VALUES, key=VALUES.get)}
        self.assertLessEqual(ends, {c for c, _ in f.label_boxes})
        lines = [tuple(map(float, m)) for m in re.findall(r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', svg)]
        self.assertLess(len(lines), len(f.label_boxes))  # most labels sit beside their circles
        for x1, y1, x2, y2 in lines:
            self.assertLessEqual(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5, reach + 0.5)
            self.assertTrue(any(abs(((x1 - c[0]) ** 2 + (y1 - c[1]) ** 2) ** 0.5 - c[2]) < 0.2 for c in occ.circles))

    def test_the_land_stops_inside_the_frame_on_a_hairline_and_the_margin_is_open_room(self):
        # the inset (default) clips the land to a rect inside the picture, drawn as a hairline; the land the notes keep off
        # (occ.land) lies inside it, so the margin is open room; inset 0 clips at the picture's own edge, with no hairline
        setup(); occ = prod.Occ(); f = bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": style()}); svg = bubbles.cl_bubbles(f, occ)
        e = bubbles.prod.KNOBS["bubbles"]["inset"][0]
        self.assertIn(f'<clipPath id="bubblesframe"><rect x="{e}" y="{e}" width="{f.W - 2 * e}" height="{f.H - 2 * e}"/>', svg)
        self.assertIn(f'<rect x="{e}" y="{e}" width="{f.W - 2 * e}" height="{f.H - 2 * e}" fill="none"', svg)
        spans = [(r, a, b) for r, row in occ.land.items() for a, b in row]
        self.assertTrue(spans)
        self.assertTrue(all(e <= a <= b <= f.W - e and e <= (r + 0.5) * MK.LAND_STEP <= f.H - e for r, a, b in spans))
        self.assertFalse(MK.on_land(occ.land, (0, 0, f.W, e - 3), pad=0))
        st = style(); st["bubbles"]["inset"] = 0; svg0 = bubbles.cl_bubbles(bubbles.Laid({"data": dict(items=ITEMS, ext=EXT), "style": st}), prod.Occ())
        self.assertIn('<rect x="0" y="0"', svg0)
        self.assertNotIn('fill="none" stroke="var(--t-sec)"', svg0)

    def test_the_bubbles_reply_says_the_radius_scale_it_drew_and_how_many_steps_under_r_max(self):
        # through the leaf runner as layer 1 calls it: the bubbles layer's reply carries r_used (the scale drawn, Frame.r_used) and
        # r_steps (knob steps under the r_max asked); at the default 22 the EU-27 clear, 0 steps; asked 60 they overlap and are
        # drawn at 44, 8 steps of 2 under it; with them r_min_lifted and r_min_codes, the circles under r_min on that scale (none
        # here: the EU-27's least is 17% of the most); no other layer's reply carries any of the four
        for st, used, steps in (({}, 22, 0), ({"r_max": 60}, 44, 8)):
            def styled(line):
                req = json.loads(line)
                if st: req["knobs"]["spec"]["hero"]["style"] = {"bubbles": st}
                return json.dumps(req, ensure_ascii=False)
            size, bars, bub, key, notes = child([styled(l) for l in column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": D})])
            self.assertNotIn("refused", bub)
            self.assertEqual((bub["r_used"], bub["r_steps"]), (used, steps), st)
            lifted = sorted(c for c, v in VALUES.items() if used * math.sqrt(v / max(VALUES.values())) < prod.KNOBS["bubbles"]["r_min"][0])
            self.assertEqual((bub["r_min_lifted"], bub["r_min_codes"]), (len(lifted), lifted), st)
            self.assertEqual([k for g in (size, bars, key, notes) for k in ("r_used", "r_steps", "r_min_lifted", "r_min_codes") if k in g], [], st)

    def test_a_layer_that_drops_every_note_is_drawn_empty_and_the_page_goes_out(self):
        # label_count 0 (the hero's style): both notes past it. The layer is drawn, empty, its reply names both notes as
        # dropped (layer 1 keeps them in the page's ledger), and the page is made with the empty layer in it
        def styled(line):
            req = json.loads(line); req["knobs"]["spec"]["hero"]["style"] = {"leader_notes": {"label_count": 0}}
            return json.dumps(req, ensure_ascii=False)
        lines = [styled(l) for l in column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": D})]
        size, bars, bub, key, got = child(lines)
        self.assertNotIn("refused", got)
        self.assertEqual((got["svg"], got["texts"]), ('<g data-node="leader_notes"></g>', []))
        self.assertEqual(got["dropped"], [{"id": "SE", "why": "past label_count"}, {"id": "LU", "why": "past label_count"}])
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubbles": bub["svg"], "bubble_key": key["svg"], "leader_notes": got["svg"]}})])[5]
        self.assertNotIn("refused", page)
        self.assertIn('<g data-layer="leader_notes"><g data-node="leader_notes"></g></g>', page["html"])


    def test_the_q5_change_page_draws_both_notes_through_the_runner(self):
        # the q5 page's lines (q5_lines) through the leaf runner as layer 1 calls it: the bubbles draw the run's circles (their
        # centres and radii as on the run's page, so the input is the run's), the key stands under the map, and the notes'
        # reply, which named Nigeria's note as dropped (the page check notes_dropped stopped the page), now drops none: both
        # notes, each line marked; the page goes out
        lines, _ = q5_lines()
        size, bars, bub, key, notes = child(lines)
        self.assertEqual([g.get("refused") for g in (size, bars, bub, key, notes)], [None] * 5)
        self.assertEqual(re.findall(r'<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"[^>]*data-code="(\w+)"', bub["svg"]),
                         [("78.7", "72.8", "22.0", "USA"), ("471.8", "86.2", "19.8", "CHN"), ("170.8", "176.6", "17.4", "BRA"), ("461.9", "154.2", "14.1", "IDN"),
                          ("414.9", "109.1", "13.9", "IND"), ("442.5", "103.5", "13.2", "BGD"), ("396.0", "91.8", "10.7", "PAK"), ("280.5", "133.3", "9.0", "NGA")])
        self.assertNotIn("dropped", notes)
        self.assertEqual([(t["src"], t["text"]) for t in notes["texts"]],
                         [("name:zh_names:iso3:CHN", "中国 升幅最大，比第二名高"), ("fact:vs_hi", "0.6 个百分点"), ("name:zh_names:iso3:NGA", "尼日利亚 升幅最小，"), ("fact:vs_lo", "比倒数第二低 0.4 个百分点")])
        self.assertTrue(all(t["y"] - 1.06 * t["size"] >= 0 and t["y"] <= 245 for t in notes["texts"]))
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubbles": bub["svg"], "bubble_key": key["svg"], "leader_notes": notes["svg"]}})])[5]
        self.assertNotIn("refused", page)
        self.assertIn('data-src="fact:vs_lo"', page["html"])

    def test_a_cut_pages_scoped_notes_place_where_the_plain_ones_do(self):
        # the q6 page (a cut: its table the top 20 citizenships, so its notes say the lowest and the highest are the selection's),
        # through the leaf runner as layer 1 calls it: Iraq's note, walled in by Iraq, Syria, Turkey and Georgia, finds one free
        # place, top right, on a two-bend leader. Measured on this replay: the scoped words before (比所选各方中最低者高 and
        # 所选各方中最高者是它的, 307.5 and 286.4 px on one line, so each on two) dropped Iraq's note (no free place); Iraq's places
        # at 222.4 px and not at 238.4 (with 比所选中最低者高 beside it), the plain one at 206.4. So the scoped words are short:
        # Iraq's as wide as the plain one, Afghanistan's two glyphs wider (259.5 px, one line), and both notes place, scoped or
        # plain, each one line ending in its bold number, nothing dropped
        for scoped in (True, False):
            size, bars, bub, key, notes = child(q6_lines(scoped))
            self.assertEqual([g.get("refused") for g in (bars, bub, key, notes)], [None] * 4, scoped)
            self.assertNotIn("dropped", notes, scoped)
            hi, lo = (K.WD.WORDS[f"column.note.{e}{'.scoped' * scoped}"] for e in ("hi", "lo"))
            self.assertEqual([(t["src"], t["text"]) for t in notes["texts"]],
                             [("name:zh_names:iso2:AF+fact:gap", f"{ZH2['AF']} {hi} 99,825 人"), ("name:zh_names:iso2:IQ+fact:times", f"{ZH2['IQ']} {lo} 9.0倍")], scoped)
            self.assertEqual(len(re.findall(r'<tspan font-weight="700"><tspan data-src="fact:(?:gap|times)"', notes["svg"])), 2, scoped)
        # a cut's words name the selection (所选, as the dek's 所选各方中) and hold no digit
        for e in ("hi", "lo"):
            w = K.WD.WORDS[f"column.note.{e}.scoped"]
            self.assertIn("所选", w); self.assertFalse(re.search(r"[0-9０-９]", w), w)
        # the q1 shape (the EU-27, Sweden's and Luxembourg's notes) with a cut's keys: both notes place too
        sc = [dict(n, text=[{"word": n["text"][0]["word"] + ".scoped"}]) for n in NOTES]
        size, bars, bub, key, notes = child(column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": dict(D, notes=sc)}))
        self.assertEqual((notes.get("refused"), notes.get("dropped")), (None, None))
        self.assertEqual(sorted(t["src"] for t in notes["texts"]), ["name:zh_names:iso2:LU+fact:times", "name:zh_names:iso2:SE+fact:gap"])

if __name__ == "__main__":
    unittest.main()
