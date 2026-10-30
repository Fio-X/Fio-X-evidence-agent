"""Self-test of the leader_notes leaf (runtime/leaves_py/leader_notes.py) and of the column page's map panel (bubbles in the
shared view under leader_notes, run.py MAP_STYLE): the EU27 at their Natural Earth label points (runtime/pi/assets), test-only
values and ledger texts (the first layer writes the real ones), names from the project's reviewed zh names. Both leaves draw
on ONE Occ, bubbles first. Checks: run.drawn reads every text back, no digit outside a marked ledger run, only page colour
variables, note font >= 16, each note one line ending in its bold number, in the sea when that costs less and over the land
only off every circle and label (one with no room anywhere is dropped and named), its leader straight or with one bend, no
note box on a circle or label the bubbles claimed (but its own point's), every EU
circle labelled, no leader crossing another, no label or leader over a nudged circle's true-point dot, a blocked side gives
way to the other; the column page lays the map beside the bars in one panel; a crowded map (the EU-27, a
note each) still draws and its reply names exactly the notes it dropped, while one that drops every note refuses; and every
refusal in the leaf's header. With LEAF_SVG_DIR set the svgs are kept there; else they go to a temporary folder that is removed.
Run: python3 -I -B scripts/test_leaves_leader_notes.py"""
import json
import os
import re
import subprocess
import sys
import tempfile
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


def leaders(svg):
    """Every leader drawn, as its points: a <line> (a bubble label's) and a <polyline> (a note's, straight or with one bend)."""
    return [[tuple(map(float, m[:2])), tuple(map(float, m[2:]))] for m in re.findall(r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', svg)] + \
           [[tuple(map(float, p.split(","))) for p in m.split()] for m in re.findall(r'<polyline points="([^"]+)"', svg)]


def segs(svg):
    """Every straight piece of every leader, as (x1, y1, x2, y2)."""
    return [(*a, *b) for path in leaders(svg) for a, b in zip(path, path[1:])]


def setup(rows=ROWS, labels=ZH2):
    K.setup(rows, labels, run.tables)
    geo.NE = SHP


def style(**nst):
    return {"bubbles": dict(run.MAP_STYLE["bubbles"]), "leader_notes": {**run.MAP_STYLE["leader_notes"], **nst}}


def pair(d=D, occ=None, **nst):
    """bubbles in the shared view, then leader_notes, on one Occ: (bubbles' frame, notes' frame, the svg inner, the Occ)."""
    setup(); occ = occ or prod.Occ()
    fb = bubbles.Frame({"data": dict(items=ITEMS, ext=d.get("ext", EXT)), "style": style()}); sb = bubbles.cl_bubbles(fb, occ)
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
        fb, fn, svg, occ = pair()
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
            svg = bubbles.cl_bubbles(bubbles.Frame({"data": dict(items=items, ext=EXT), "style": style()}), occ)
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
        # the EU-27 with the default knobs: all 27 circles carry their name and number; the dot a nudged circle keeps at its
        # true point is claimed in the Occ, and no label box and no leader drawn passes over it (but the leader of its own circle)
        setup(); occ = prod.Occ(); f = bubbles.Frame({"data": dict(items=ITEMS, ext=EXT), "style": style()}); svg = bubbles.cl_bubbles(f, occ)
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


def column_lines(leaves):
    """A column page's size and layer lines with the map panel's leaves, as layer 1 sends them (next_run bubbles_fill and
    leader_notes_fill; the ledger as next_facts makes it)."""
    rows = [r for r in ROWS if r["src"].startswith("series:")]
    ledger = {**{f"fact:val.{c}.n": str(v) for c, v in VALUES.items()}, **{r["src"]: r["text"] for r in ROWS if "text" in r}, "period:t:2023": "2023"}
    ranked = sorted(VALUES, key=lambda c: -VALUES[c])
    spec = {"title": "标题", "dek": "导语", "kicker": "栏目", "source": "t", "refs": ["t"], "tables": {"t": {"id": "t"}},
            "facts": {"val": {"each": "geo", "table": "t", "time": "2023", "fmt": "pc"}}, "fmts": {"pc": {"scale": 1, "dec": 1, "suffix": "%"}, "time": {}},
            "hero": {"unit": "单位：%", "data": {"chart": "bars", "by": "geo", "year": "2023", "family": "val", "ranked": ranked, "marks": []}, "leaves": leaves}}
    knobs = {"spec": spec, "labels": ZH2, "shapes": SHP}
    rows = rows + [{"src": k, "text": v} for k, v in ledger.items()]
    line = lambda **kv: json.dumps({"node": "column", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows, "knobs": knobs, **kv}, ensure_ascii=False)
    return [line(phase="size"), line(layer="bars"), line(layer="bubbles"), line(layer="leader_notes")]


def child(lines):
    out = subprocess.run([sys.executable, "-I", "-B", os.path.join(LEAVES, "run.py")], input="\n".join(lines) + "\n", capture_output=True, text=True, check=True).stdout
    return [json.loads(l) for l in out.splitlines()]


class ColumnMap(unittest.TestCase):
    def test_the_map_panel_stands_beside_the_bars_in_one_panel(self):
        lines = column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": D})
        size, bars, bub, notes = child(lines)
        self.assertEqual((bub.get("refused"), notes.get("refused")), (None, None))
        x0 = 560 + 40
        self.assertEqual(size["w"], 1140)
        self.assertGreater(size["h"], 24 * len(VALUES))  # the taller of the map and the bars
        self.assertTrue(all(t["x"] >= x0 for t in bars["texts"] if t["anchor"] != "end") and all(t["x"] > x0 for t in bars["texts"]))
        self.assertTrue(all(t["x"] <= 560 for t in bub["texts"] + notes["texts"]))
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubbles": bub["svg"], "leader_notes": notes["svg"]}})])[4]
        html = page["html"]
        self.assertRegex(html, r'<svg class="cmap"[^>]*><g data-layer="bubbles">.*</g><g data-layer="leader_notes">.*</g></svg><svg class="bars pub-chart"')
        self.assertRegex(html, rf'class="bars pub-chart"[^>]*viewBox="{x0} 0 540 ')
        self.assertEqual(run.placeholders(html), [])

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
        size, bars, bub, got = child(lines)
        self.assertNotIn("refused", got)
        drawn = {p.split(":")[-1] for t in got["texts"] for p in t["src"].split("+") if p.startswith("name:")}
        dropped = {d["id"]: d["why"] for d in got["dropped"]}
        self.assertEqual(len(got["dropped"]), len(dropped))  # no id twice
        self.assertEqual((set(VALUES), drawn & set(dropped)), (drawn | set(dropped), set()))  # each note drawn or named, not both
        self.assertEqual(sum(w == "past label_count" for w in dropped.values()), len(VALUES) - 12)
        self.assertTrue({c for c, w in dropped.items() if w == "no free place for the note"})  # the crowded centre leaves some
        setup(); f = LN.Frame({"data": dict(D, notes=notes), "style": style(label_count=12, note_size=22)}); occ = prod.Occ()
        bubbles.cl_bubbles(bubbles.Frame({"data": dict(items=ITEMS, ext=EXT), "style": style()}), occ); LN.cl_leader_notes(f, occ)
        self.assertEqual([{"id": c, "why": w} for c, w in f.dropped], got["dropped"])
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubbles": bub["svg"], "leader_notes": got["svg"]}})])[4]
        self.assertNotIn("refused", page)
        self.assertIn('data-layer="leader_notes"', page["html"])

    def test_crowded_bubbles_still_draw_and_say_exactly_which_labels_they_dropped(self):
        # the EU-27 bubbles with label_top 12 and no leaders (reach 0): every circle drawn, and each of the twelve labels
        # drawn or named in the reply's dropped list (the leaf's Frame.dropped), never both, never silently left off
        def styled(line):
            req = json.loads(line); req["knobs"]["spec"]["hero"]["style"] = {"bubbles": {"label_top": 12, "reach": 0}}
            return json.dumps(req, ensure_ascii=False)
        got = child([styled(l) for l in column_lines({"bubbles": dict(items=ITEMS, ext=EXT)})])[2]
        self.assertNotIn("refused", got)
        self.assertEqual(got["svg"].count("<circle") - got["svg"].count("data-at="), len(VALUES))  # the dots of nudged circles aside
        labelled = {t["src"].split(":")[-1] for t in got["texts"] if t["src"].startswith("name:")}
        dropped = {d["id"]: d["why"] for d in got["dropped"]}
        self.assertTrue(dropped, "the crowded centre leaves a label with no place")
        self.assertEqual(set(dropped.values()), {"no free place for the label"})
        top = sorted(VALUES, key=lambda c: -VALUES[c])[:12]
        self.assertEqual((labelled | set(dropped), labelled & set(dropped)), (set(top), set()))
        setup(); f = bubbles.Frame({"data": dict(items=ITEMS, ext=EXT), "style": {**style(), "bubbles": {**style()["bubbles"], "label_top": 12, "reach": 0}}})
        bubbles.cl_bubbles(f, prod.Occ())
        self.assertEqual([{"id": c, "why": w} for c, w in f.dropped], got["dropped"])
        # with leaders (the default reach) the same crowded set labels more circles, each label still clear of every circle
        # and joined to its own by a leader that starts on that circle's edge
        setup(); g = bubbles.Frame({"data": dict(items=ITEMS, ext=EXT), "style": style()}); svg = bubbles.cl_bubbles(g, prod.Occ())
        self.assertLess(len(g.dropped), len(f.dropped))
        lines = [tuple(map(float, m)) for m in re.findall(r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', svg)]
        self.assertTrue(lines)
        for x1, y1, _, _ in lines:
            self.assertTrue(any(abs(((x1 - j["_xy"][0]) ** 2 + (y1 - j["_xy"][1]) ** 2) ** 0.5 - j["_r"]) < 0.2 for j in g.items), (x1, y1))
        for code, b in g.label_boxes:
            self.assertEqual([j["code"] for j in g.items if ((max(b[0] - j["_xy"][0], 0, j["_xy"][0] - b[2])) ** 2 + (max(b[1] - j["_xy"][1], 0, j["_xy"][1] - b[3])) ** 2) ** 0.5 < j["_r"]], [], code)

    def test_the_eu_map_labels_most_circles_close_first_then_out_on_short_leaders(self):
        # the EU-27 in the shared frame with the default knobs: the top label_top circles are each labelled or dropped; a label
        # beside its circle has no leader, one set out has a leader from its own circle's edge no longer than reach
        setup(); occ = prod.Occ(); f = bubbles.Frame({"data": dict(items=ITEMS, ext=EXT), "style": style()}); svg = bubbles.cl_bubbles(f, occ)
        top, reach = (bubbles.prod.KNOBS["bubbles"][k][0] for k in ("label_top", "reach"))
        self.assertEqual(len(f.label_boxes) + len(f.dropped), min(top, len(ITEMS)))
        self.assertGreater(len(f.label_boxes), 12)
        lines = [tuple(map(float, m)) for m in re.findall(r'<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"', svg)]
        self.assertLess(len(lines), len(f.label_boxes))  # most labels sit beside their circles
        for x1, y1, x2, y2 in lines:
            self.assertLessEqual(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5, reach + 0.5)
            self.assertTrue(any(abs(((x1 - c[0]) ** 2 + (y1 - c[1]) ** 2) ** 0.5 - c[2]) < 0.2 for c in occ.circles))

    def test_the_land_stops_inside_the_frame_on_a_hairline_and_the_margin_is_open_room(self):
        # the inset (default) clips the land to a rect inside the picture, drawn as a hairline; the land the notes keep off
        # (occ.land) lies inside it, so the margin is open room; inset 0 clips at the picture's own edge, with no hairline
        setup(); occ = prod.Occ(); f = bubbles.Frame({"data": dict(items=ITEMS, ext=EXT), "style": style()}); svg = bubbles.cl_bubbles(f, occ)
        e = bubbles.prod.KNOBS["bubbles"]["inset"][0]
        self.assertIn(f'<clipPath id="bubblesframe"><rect x="{e}" y="{e}" width="{f.W - 2 * e}" height="{f.H - 2 * e}"/>', svg)
        self.assertIn(f'<rect x="{e}" y="{e}" width="{f.W - 2 * e}" height="{f.H - 2 * e}" fill="none"', svg)
        spans = [(r, a, b) for r, row in occ.land.items() for a, b in row]
        self.assertTrue(spans)
        self.assertTrue(all(e <= a <= b <= f.W - e and e <= (r + 0.5) * MK.LAND_STEP <= f.H - e for r, a, b in spans))
        self.assertFalse(MK.on_land(occ.land, (0, 0, f.W, e - 3), pad=0))
        st = style(); st["bubbles"]["inset"] = 0; svg0 = bubbles.cl_bubbles(bubbles.Frame({"data": dict(items=ITEMS, ext=EXT), "style": st}), prod.Occ())
        self.assertIn('<rect x="0" y="0"', svg0)
        self.assertNotIn('fill="none" stroke="var(--t-sec)"', svg0)

    def test_a_layer_that_drops_every_note_is_drawn_empty_and_the_page_goes_out(self):
        # label_count 0 (the hero's style): both notes past it. The layer is drawn, empty, its reply names both notes as
        # dropped (layer 1 keeps them in the page's ledger), and the page is made with the empty layer in it
        def styled(line):
            req = json.loads(line); req["knobs"]["spec"]["hero"]["style"] = {"leader_notes": {"label_count": 0}}
            return json.dumps(req, ensure_ascii=False)
        lines = [styled(l) for l in column_lines({"bubbles": dict(items=ITEMS, ext=EXT), "leader_notes": D})]
        size, bars, bub, got = child(lines)
        self.assertNotIn("refused", got)
        self.assertEqual((got["svg"], got["texts"]), ('<g data-node="leader_notes"></g>', []))
        self.assertEqual(got["dropped"], [{"id": "SE", "why": "past label_count"}, {"id": "LU", "why": "past label_count"}])
        page = child(lines + [json.dumps({"phase": "page", "layers": {"bars": bars["svg"], "bubbles": bub["svg"], "leader_notes": got["svg"]}})])[4]
        self.assertNotIn("refused", page)
        self.assertIn('<g data-layer="leader_notes"><g data-node="leader_notes"></g></g>', page["html"])


if __name__ == "__main__":
    unittest.main()
