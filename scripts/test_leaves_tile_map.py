"""Self-test of the tile map leaf (runtime/leaves_py/tile_map.py) on two data shapes with test-only values, ledger texts and words
(layer 1 writes the real ones: each member's value its fact, the points from the attributes table):
  - an EU shape: all twenty-seven members (the interior points geo.PT holds);
  - a World Bank shape: twelve economies (their iso3 label points from the attributes table).
Checks: one tile a member, all the same size, each on a place of its own; the tiles keep the members' directions (a member north of
another is not drawn below it by more than the grid's slack: the order of the points' latitudes and longitudes shows in the order of
the tiles' rows and columns for far-apart pairs); the same members always make the same grid; the fill is one of five steps that never
falls as the value rises, the lowest and the highest in the first and the last step; every tile prints the name and the value, the
legend's ends the lowest and the highest; text on the darkest step is white, on the others ink; every digit inside a marked ledger
run; the assignment solves a small matrix as brute force does; the refusals keep the leaf's rules; the file holds no topic word.
With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_tile_map.py"""
import itertools
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LEAVES = os.path.join(ROOT, "runtime", "leaves_py")
ASSETS = os.path.join(ROOT, "runtime", "pi", "assets")
sys.path.insert(0, LEAVES)
import geo  # noqa: E402
import run  # noqa: E402
import tile_map  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
EU_VALUES = {"SE": 65.8, "LV": 43.5, "FI": 52.3, "AT": 39.5, "PT": 34.6, "DK": 44.4, "EE": 41.4, "LT": 31.5, "HR": 31.2, "SI": 25.8, "RO": 24.6, "ES": 25.4,
             "FR": 24.3, "EL": 24.4, "BG": 20.5, "DE": 21.4, "IT": 20.4, "SK": 16.8, "PL": 16.6, "CZ": 18.1, "HU": 16.2, "BE": 14.5, "IE": 17.4, "CY": 20.1,
             "LU": 12.5, "MT": 14.5, "NL": 16.9}
EU_NAMES = {"SE": "瑞典", "LV": "拉脱维亚", "FI": "芬兰", "AT": "奥地利", "PT": "葡萄牙", "DK": "丹麦", "EE": "爱沙尼亚", "LT": "立陶宛", "HR": "克罗地亚",
            "SI": "斯洛文尼亚", "RO": "罗马尼亚", "ES": "西班牙", "FR": "法国", "EL": "希腊", "BG": "保加利亚", "DE": "德国", "IT": "意大利", "SK": "斯洛伐克",
            "PL": "波兰", "CZ": "捷克", "HU": "匈牙利", "BE": "比利时", "IE": "爱尔兰", "CY": "塞浦路斯", "LU": "卢森堡", "MT": "马耳他", "NL": "荷兰"}
WB_VALUES = {"USA": 14.2, "DEU": 7.6, "CHN": 8.0, "IND": 2.1, "BRA": 2.4, "ZAF": 6.8, "JPN": 7.8, "AUS": 14.5, "CAN": 14.1, "FRA": 4.5, "GBR": 4.5, "IDN": 2.7}
WB_NAMES = {"USA": "美国", "DEU": "德国", "CHN": "中国", "IND": "印度", "BRA": "巴西", "ZAF": "南非", "JPN": "日本", "AUS": "澳大利亚", "CAN": "加拿大",
            "FRA": "法国", "GBR": "英国", "IDN": "印度尼西亚"}


def attribute_points(codes):
    with open(os.path.join(ASSETS, "naturalearth-admin0-50m-attributes.json"), encoding="utf-8") as fh: feats = json.load(fh)["features"]
    by = {x["iso3"]: x for x in feats if x["iso3"] == x["adm0_a3"]}
    return {c: list(by[c]["label"]) for c in codes}


def build(table, values, names, points, year="2024"):
    rows, cells = [], []
    order = sorted(values, key=lambda c: (-values[c], c))
    for c, v in values.items():
        src = f"series:{table}/{c}:{year}:OBS_VALUE"
        rows += [{"src": src, "table": table, "dims": {"geo": c}, "time": year, "value": v}, {"src": f"fact:tl_{c.lower()}", "text": f"{v:.1f}"}]
        cells.append({"code": c, "at": points[c], "value": src, "text": f"fact:tl_{c.lower()}"})
    rows += [{"src": K.name_row(c, "place"), "text": n} for c, n in names.items()]
    data = {"title": W("占比"), "unit": W("百分比"), "name_kind": "place", "cells": cells,
            "ends": {"lo": f"fact:tl_{order[-1].lower()}", "hi": f"fact:tl_{order[0].lower()}"}, "footnote": W("颜色分五档")}
    return rows, data, names


def eu(): return build("t", EU_VALUES, EU_NAMES, {c: list(geo.PT[c]) for c in EU_VALUES})
def wb(): return build("t", WB_VALUES, WB_NAMES, attribute_points(WB_VALUES))


def draw(shape, **style):
    rows, data, names = shape
    K.setup(rows, names, run.tables)
    return tile_map.draw({"data": data, "style": {"tile_map": style}})


def check_svg(svg):
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def themed(svg, w, h):
    css = ("<style>svg{--accent:#c93f2b;--t-title:#292928;--t-dark:#1f1e1d;--t-body:#4d4d4d;--t-sec:#707070;--bar:#c9c9c9;--empty:#e5e5e5;--bg:#fff;--rule:#ececec;"
           + K.page_vars("#c93f2b") + "}</style>")
    return svg.replace(">", f">{css}<rect width='{w}' height='{h}' fill='#fff'/>", 1)


def tiles_of(svg):
    """{code: (x, y, w, h, step)} of every tile."""
    return {m.group(5): (float(m.group(1)), float(m.group(2)), float(m.group(3)), float(m.group(4)), int(m.group(6))) for m in re.finditer(
        r'<rect x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)" rx="2" fill="[^"]+" data-code="([A-Z0-9]+)" data-step="(\d)"', svg)}


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vals = {"eu": EU_VALUES, "wb": WB_VALUES}
        cls.out = {"eu": draw(eu()), "wb": draw(wb())}
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            for n, (svg, w, h) in cls.out.items():
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"tile_map-{n}.svg"), "w", encoding="utf-8") as fh: fh.write(themed(svg, w, h))

    def test_every_digit_is_a_marked_ledger_run(self):
        for n, (svg, _, _) in self.out.items(): self.assertEqual(check_svg(svg), [], n)

    def test_one_tile_a_member_all_one_size_each_on_a_place_of_its_own(self):
        for n, vals in self.vals.items():
            tl = tiles_of(self.out[n][0])
            self.assertEqual(sorted(tl), sorted(vals), n)
            self.assertEqual(len({(t[2], t[3]) for t in tl.values()}), 1, n)
            self.assertEqual(len({(t[0], t[1]) for t in tl.values()}), len(vals), n)

    def test_the_tiles_keep_the_directions_of_members_far_apart(self):
        tl = tiles_of(self.out["eu"][0])
        pts = {c: geo.PT[c] for c in EU_VALUES}
        far = 14.0   # degrees: a pair this far apart on an axis keeps its order on the grid
        for a, b in itertools.permutations(EU_VALUES, 2):
            if pts[a][1] - pts[b][1] > far: self.assertLess(tl[a][1], tl[b][1] + 0.5, (a, "is north of", b))
            if pts[a][0] - pts[b][0] > far: self.assertLess(tl[b][0], tl[a][0] + 0.5, (a, "is east of", b))
        tw_ = tiles_of(self.out["wb"][0])
        wp = attribute_points(WB_VALUES)
        for a, b in itertools.permutations(WB_VALUES, 2):
            if wp[a][1] - wp[b][1] > 30: self.assertLess(tw_[a][1], tw_[b][1] + 0.5, (a, "is north of", b))
            if wp[a][0] - wp[b][0] > 60: self.assertLess(tw_[b][0], tw_[a][0] + 0.5, (a, "is east of", b))

    def test_the_same_members_always_make_the_same_grid(self):
        self.assertEqual(draw(eu())[0], self.out["eu"][0])
        rows, data, names = eu(); data["cells"].reverse()
        K.setup(rows, names, run.tables)
        self.assertEqual(tile_map.draw({"data": data, "style": {}})[0], self.out["eu"][0])

    def test_the_step_never_falls_as_the_value_rises_and_the_ends_take_the_first_and_the_last(self):
        for n, vals in self.vals.items():
            tl = tiles_of(self.out[n][0])
            order = sorted(vals, key=lambda c: vals[c])
            self.assertEqual([tl[c][4] for c in order], sorted(tl[c][4] for c in order), n)
            self.assertEqual((tl[order[0]][4], tl[order[-1]][4]), (0, 4), n)

    def test_every_tile_prints_the_name_and_the_value_and_the_legend_ends_are_the_extremes(self):
        for n, vals in self.vals.items():
            svg = self.out[n][0]
            for c in vals: self.assertEqual(svg.count(f'data-src="fact:tl_{c.lower()}"') >= 1, True, (n, c))
            order = sorted(vals, key=lambda c: (-vals[c], c))
            self.assertEqual(svg.count(f'data-src="fact:tl_{order[0].lower()}"'), 2, n)   # its tile and the legend's high end
            self.assertEqual(svg.count(f'data-src="fact:tl_{order[-1].lower()}"'), 2, n)
            self.assertEqual(len(re.findall(r'data-part="legend"', svg)), 5)

    def test_text_on_the_darkest_step_is_white_and_on_the_others_ink(self):
        svg = self.out["eu"][0]
        top = max(EU_VALUES, key=lambda c: EU_VALUES[c])
        self.assertRegex(svg, rf'fill="var\(--bg\)" font-weight="700"><tspan data-src="name:zh_names:place:{top}"|fill="var\(--bg\)" font-weight="700"><tspan data-src="[^"]*{top}[^"]*"')
        self.assertIn('fill="var(--t-dark)"', svg)

    def test_the_picture_is_one_svg_of_its_width(self):
        for n, (svg, w, h) in self.out.items():
            self.assertEqual(w, 1140); self.assertTrue(svg.startswith(f'<svg class="tile_map" viewBox="0 0 1140 {h}"'))


class Assignment(unittest.TestCase):
    def test_the_assignment_is_the_least_cost_one(self):
        import random
        rnd = random.Random(7)
        for n, m in ((3, 3), (4, 6), (5, 5), (3, 7)):
            cost = [[rnd.random() for _ in range(m)] for _ in range(n)]
            got = tile_map.assign(cost)
            best = min(sum(cost[i][p[i]] for i in range(n)) for p in itertools.permutations(range(m), n))
            self.assertAlmostEqual(sum(cost[i][j] for i, j in enumerate(got)), best, places=9)
            self.assertEqual(len(set(got)), n)


class Rules(unittest.TestCase):
    def refuse(self, want, edit=None, **style):
        rows, data, names = eu()
        if edit: edit(data, rows)
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, want):
            tile_map.draw({"data": data, "style": {"tile_map": style}})

    def test_with_accent_only_the_steps_are_one_grey_and_only_the_listed_members_red(self):
        """A story page gives accent_only (the members the section's headline names): the members fill by GREY_RAMP's steps, the listed
        ones in the accent, the legend's steps grey with one accent swatch; none listed, no red at all; the texts are the same."""
        for n, (rows, data, names) in {"eu": eu(), "wb": wb()}.items():
            first = sorted(c["code"] for c in data["cells"])[0]
            for only in ([first], []):
                svg = draw((rows, {**data, "accent_only": only}, names))[0]
                fills = {m[1]: m[0] for m in re.findall(r'<(?:path|rect) [^>]*?fill="([^"]+)"[^>]*data-code="([A-Z0-9]+)"', svg)}
                self.assertEqual({c for c, f in fills.items() if "--accent" in f}, set(only), (n, only))
                self.assertLessEqual({f for c, f in fills.items() if c not in only}, set(K.GREY_RAMP), (n, only))
                self.assertEqual(re.findall(r'<rect [^>]*fill="([^"]+)" data-part="legend"/>', svg), K.GREY_RAMP, (n, only))
                self.assertEqual(len(re.findall(r'fill="var\(--accent\)" data-part="legend named"', svg)), len(only), (n, only))
                self.assertEqual(check_svg(svg), [], (n, only))
                plain = draw((rows, data, names))[0]
                self.assertEqual([t for t in re.findall(r"<tspan[^>]*>([^<]*)</tspan>", svg) if t != K.plain([{"word": "map.legend.named"}], "k")],
                                 re.findall(r"<tspan[^>]*>([^<]*)</tspan>", plain), (n, only))

    def test_its_refusals(self):
        self.refuse("fewer than 4 cells", lambda d, r: d.__setitem__("cells", d["cells"][:3]))
        self.refuse("come twice", lambda d, r: d["cells"].append(dict(d["cells"][0])))
        self.refuse("are not codes", lambda d, r: d["cells"][0].__setitem__("code", "no good"))
        self.refuse("no \\[lon, lat\\]", lambda d, r: d["cells"][0].__setitem__("at", [200, 10]))
        self.refuse("lie at one point", lambda d, r: d["cells"][1].__setitem__("at", d["cells"][0]["at"]))
        self.refuse("is not a series of the request", lambda d, r: d["cells"][0].__setitem__("value", "series:t/ZZ:2024:OBS_VALUE"))
        self.refuse("has no value text", lambda d, r: d["cells"][0].pop("text"))
        self.refuse("ends needs", lambda d, r: d.pop("ends"))
        self.refuse("is not the text of the member", lambda d, r: d["ends"].__setitem__("hi", d["ends"]["lo"]))
        self.refuse("a digit", lambda d, r: d.__setitem__("footnote", W("共 5 档")))
        self.refuse("a name is too wide for its tile", max_w=60)
        self.refuse("off its range", width=200)

    def test_one_value_for_every_member_is_refused(self):
        rows, data, names = eu()
        rows = [dict(r, value=5.0) if r["src"].startswith("series:") else r for r in rows]
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, "one value"):
            tile_map.draw({"data": data, "style": {}})

    def test_the_file_holds_no_topic_word(self):
        with open(os.path.join(LEAVES, "tile_map.py"), encoding="utf-8") as fh: src = fh.read().lower()
        for w in ("gas", "coal", "solar", "wind", "russia", "energy", "oil", "nuclear", "eurostat", "世界银行", "欧盟", "能源"):
            self.assertNotIn(w, src, w)


if __name__ == "__main__":
    unittest.main()
