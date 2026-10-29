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
            bubbles.draw(hero(E_DATA))
        self.assertIn("overlap by more than half", str(e.exception))
        svg, _, _ = bubbles.draw(hero(E_DATA, max_overlaps=20))
        self.assertEqual(check_svg(svg), [])

    def test_no_label_sits_on_a_circle_or_another_label(self):
        for tag, rows, labels, data in (("world", W_ROWS, W_LABELS, W_DATA), ("crowded", E_ROWS, E_LABELS, E_DATA)):
            with self.subTest(tag):
                setup(rows, labels)
                f = bubbles.Frame(hero(data, max_overlaps=20))
                bubbles.cl_bubbles(f, prod.Occ())
                self.assertTrue(f.label_boxes)
                self.assertEqual(len(f.label_boxes) + len(f.unlabeled), min(len(f.items), 12))
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


if __name__ == "__main__":
    unittest.main()
