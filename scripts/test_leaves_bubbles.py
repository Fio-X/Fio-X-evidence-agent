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
