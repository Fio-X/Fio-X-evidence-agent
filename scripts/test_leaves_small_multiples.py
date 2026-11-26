"""Self-test of the small-multiples leaf (runtime/leaves_py/small_multiples.py) on two data shapes with test-only values, ledger
texts and words (layer 1 writes the real ones: each member's last value its fact, each period an entry):
  - an EU shape: nine members 2005-2024 in percent, the whole as a pale line and a target above most of them as a dashed level,
    the best and the worst member in the accent;
  - a World Bank shape: six economies' tonnes per head 2010-2022, no whole and no target, one value below 0 so the shared
    scale runs over the cells' range, not from 0.
Checks: one cell per member, in the knob's order (by last value, by change, as given), the first max_cells kept; one shared
value scale (equal values sit at the same height in every cell, the target's level the same in every cell); the whole's line
behind each cell; the accent cells' marks; every digit inside a marked ledger run; the refusals keep the leaf's rules; the
file holds no topic word. With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_small_multiples.py"""
import math
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import run  # noqa: E402
import small_multiples  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
EU_YEARS = [str(y) for y in range(2005, 2025)]
EU_START = {"SE": (40.0, 0.9), "FI": (28.0, 0.8), "AT": (24.0, 0.5), "DE": (7.0, 0.8), "FR": (9.5, 0.6), "PL": (7.0, 0.5),
            "NL": (2.5, 0.85), "MT": (6.0, -0.1), "LU": (5.0, -0.05)}
EU_NAMES = {"SE": "瑞典", "FI": "芬兰", "AT": "奥地利", "DE": "德国", "FR": "法国", "PL": "波兰", "NL": "荷兰", "MT": "马耳他", "LU": "卢森堡",
            "EU27_2020": "欧盟"}
WB_START = {"USA": (17.0, -0.3), "DEU": (9.5, -0.2), "CHN": (6.5, 0.15), "IND": (1.4, 0.06), "BRA": (2.2, 0.01), "ZAF": (8.8, -0.15)}
WB_NAMES = {"USA": "美国", "DEU": "德国", "CHN": "中国", "IND": "印度", "BRA": "巴西", "ZAF": "南非"}


def build(table, years, start, names, dec, whole=None, target=None, shift=0.0):
    """(rows, data): a cell a code, its last value a fact entry, the periods an entry each."""
    rows, cells = [], []
    for c, (a, p) in start.items():
        vals = [round(a + p * i + shift + 0.3 * math.sin(i), 3) for i in range(len(years))]
        pts = []
        for y, v in zip(years, vals):
            s = f"series:{table}/{c}:{y}:OBS_VALUE"
            rows.append({"src": s, "table": table, "dims": {"geo": c}, "time": y, "value": v}); pts.append(s)
        rows.append({"src": f"fact:sm_{c.lower()}", "text": f"{vals[-1]:.{dec}f}"})
        cells.append({"code": c, "points": pts, "last_text": f"fact:sm_{c.lower()}"})
    rows += [{"src": f"period:{table}:{years[0]}", "text": years[0]}, {"src": f"period:{table}:{years[-1]}", "text": years[-1]}]
    rows += [{"src": K.name_row(c, "place"), "text": n} for c, n in names.items()]
    data = {"title": W("占比"), "unit": W("百分比"), "name_kind": "place", "cells": cells,
            "periods": [f"period:{table}:{years[0]}", f"period:{table}:{years[-1]}"], "footnote": W("各格共用同一条纵轴")}
    if whole:
        pts = []
        for i, y in enumerate(years):
            s = f"series:{table}/{whole}:{y}:OBS_VALUE"
            rows.append({"src": s, "table": table, "dims": {"geo": whole}, "time": y, "value": 10 + i * 0.7}); pts.append(s)
        data["ref"] = {"code": whole, "points": pts, "label": [{"name": whole}, {"w": "（淡线）"}]}
    if target:
        rows.append({"src": "fact:goal", "text": f"{target:.1f}"})
        data["target"] = {"text": "fact:goal", "scale": 1, "label": [{"w": "目标 "}, {"src": "fact:goal"}]}
    return rows, data


def eu():
    rows, data = build("nrg_ind_ren", EU_YEARS, EU_START, EU_NAMES, 1, whole="EU27_2020", target=42.5)
    data["accent"] = ["SE", "MT"]
    return rows, data, EU_NAMES


def wb():
    rows, data = build("EN.GHG.CO2.PC", [str(y) for y in range(2010, 2023)], WB_START, WB_NAMES, 2, shift=-1.5)
    return rows, data, WB_NAMES


def draw(shape, **style):
    rows, data, names = shape
    K.setup(rows, names, run.tables)
    return small_multiples.draw({"data": data, "style": {"small_multiples": style}})


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


def cell_lines(svg):
    """{code: [(x, y)]} of each cell's own polyline."""
    out = {}
    for m in re.finditer(r'<polyline points="([^"]+)"[^>]*data-code="([^"]+)"', svg):
        out[m.group(2)] = [tuple(float(v) for v in p.split(",")) for p in m.group(1).split()]
    return out


def order(svg):
    return list(cell_lines(svg))


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shapes = {"eu": eu(), "wb": wb()}
        cls.out = {n: draw(s) for n, s in cls.shapes.items()}
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            for n, (svg, w, h) in cls.out.items():
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"small_multiples-{n}.svg"), "w", encoding="utf-8") as fh: fh.write(themed(svg, w, h))

    def test_every_digit_is_a_marked_ledger_run(self):
        for n, (svg, _, _) in self.out.items(): self.assertEqual(check_svg(svg), [], n)

    def test_one_cell_a_member_and_twelve_at_most(self):
        self.assertEqual(len(cell_lines(self.out["eu"][0])), 9)
        self.assertEqual(len(cell_lines(self.out["wb"][0])), 6)
        rows, data, names = eu()
        start = {f"M{i:02d}": (5.0 + i, 0.2 * i) for i in range(15)}
        r2, d2 = build("t", EU_YEARS, start, {c: c for c in start}, 1)
        K.setup(r2, {c: c for c in start}, run.tables)
        svg = small_multiples.draw({"data": d2, "style": {}})[0]
        self.assertEqual(len(cell_lines(svg)), 12)  # max_cells' default
        svg = small_multiples.draw({"data": d2, "style": {"small_multiples": {"max_cells": 6}}})[0]
        self.assertEqual(order(svg), [f"M{i:02d}" for i in (14, 13, 12, 11, 10, 9)])  # the highest last values first

    def test_the_order_is_a_knob(self):
        last = lambda c: next(r["value"] for r in self.shapes["eu"][0] if r["src"] == f"series:nrg_ind_ren/{c}:2024:OBS_VALUE")
        first = lambda c: next(r["value"] for r in self.shapes["eu"][0] if r["src"] == f"series:nrg_ind_ren/{c}:2005:OBS_VALUE")
        self.assertEqual(order(self.out["eu"][0]), sorted(EU_START, key=lambda c: (-last(c), c)))
        svg = draw(self.shapes["eu"], sort="change")[0]
        self.assertEqual(order(svg), sorted(EU_START, key=lambda c: (-(last(c) - first(c)), c)))
        svg = draw(self.shapes["eu"], sort="given")[0]
        self.assertEqual(sorted(order(svg)), sorted(EU_START))

    def test_one_value_scale_for_every_cell(self):
        """Equal values sit at one height above each cell's baseline; the target's level is the same in every cell."""
        svg = self.out["eu"][0]
        lines = cell_lines(svg)
        rows = self.shapes["eu"][0]
        # a cell's pixels per unit: its highest and lowest point's heights over their values (the same in every cell on one scale)
        per_unit = []
        for c, l in lines.items():
            vals = [next(r["value"] for r in rows if r["src"] == f"series:nrg_ind_ren/{c}:{yr}:OBS_VALUE") for yr in EU_YEARS]
            hi_i, lo_i = vals.index(max(vals)), vals.index(min(vals))
            per_unit.append((l[lo_i][1] - l[hi_i][1]) / (max(vals) - min(vals)))
        self.assertLess(max(per_unit) - min(per_unit), 0.03 * max(per_unit), per_unit)  # one scale (the y values are printed to 0.1 px)
        targets = re.findall(r'<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="[\d.]+" stroke="var\(--t-sec\)" stroke-width="1.2" stroke-dasharray="4 3" '
                             r'stroke-opacity="0.7" data-part="target"', svg)
        self.assertEqual(len(targets), 9)
        self.assertEqual(len(re.findall(r'data-part="ref"', svg)), 9)  # the whole's line behind each cell

    def test_zero_base_only_when_no_value_is_below_zero(self):
        """The EU shape (nothing below 0, the lowest under half the highest) starts its scale at 0; the WB shape holds a value below
        0 and runs over the cells' own range, a little below its lowest."""
        for name, zero in (("eu", True), ("wb", False)):
            rows, data, names = self.shapes[name]
            K.setup(rows, names, run.tables)
            fr = small_multiples.Frame({"data": data, "style": {}})
            if zero: self.assertEqual(fr.base, 0.0)
            else:
                self.assertLess(fr.lo_v, 0)
                self.assertLess(fr.base, fr.lo_v)

    def test_the_accent_cells_alone_in_the_accent(self):
        svg = self.out["eu"][0]
        acc = re.findall(r'<polyline [^>]*stroke="var\(--accent\)"[^>]*data-code="([A-Z]+)"', svg)
        self.assertEqual(sorted(acc), ["MT", "SE"])
        self.assertNotIn("var(--accent)", self.out["wb"][0])  # no accent named, none drawn

    def test_names_and_last_values_are_ledger_runs(self):
        svg = self.out["eu"][0]
        for c in EU_START:
            self.assertIn(f'data-src="{K.name_row(c, "place")}"', svg)
            self.assertIn(f'data-src="fact:sm_{c.lower()}"', svg)
        self.assertIn('data-src="fact:goal"', svg)


class Columns(unittest.TestCase):
    def test_auto_columns_leave_the_last_row_full_or_nearly(self):
        got = {n: small_multiples.auto_cols(n, 1140, 22, 150) for n in (4, 5, 6, 7, 8, 9, 10, 11, 12)}
        self.assertEqual(got, {4: 4, 5: 5, 6: 3, 7: 4, 8: 4, 9: 3, 10: 5, 11: 4, 12: 4})
        # a narrow board takes the counts it can: 4 cells of 150 px or more need 700 px
        self.assertEqual(small_multiples.auto_cols(9, 600, 22, 150), 3)
        self.assertEqual(small_multiples.auto_cols(12, 600, 22, 150), 3)

    def test_the_default_is_auto_and_a_given_count_is_kept(self):
        rows, data, names = eu()
        K.setup(rows, names, run.tables)
        self.assertEqual(small_multiples.Frame({"data": data, "style": {}}).cols, 3)  # nine cells: three rows of three
        self.assertEqual(small_multiples.Frame({"data": data, "style": {"small_multiples": {"cols": 4}}}).cols, 4)


class Rules(unittest.TestCase):
    def refuse(self, want, edit=None, **style):
        rows, data, names = eu()
        if edit: edit(data, rows)
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, want):
            small_multiples.draw({"data": data, "style": {"small_multiples": style}})

    def test_its_refusals(self):
        self.refuse("fewer than 4 cells", lambda d, r: d.__setitem__("cells", d["cells"][:3]))
        self.refuse("come twice", lambda d, r: d["cells"].append(dict(d["cells"][0])))
        self.refuse("are not codes", lambda d, r: d["cells"][0].__setitem__("code", "no good"))
        self.refuse("fewer than two points", lambda d, r: d["cells"][0].__setitem__("points", d["cells"][0]["points"][:1]))
        self.refuse("other periods", lambda d, r: d["cells"][0].__setitem__("points", d["cells"][0]["points"][1:]))
        self.refuse("not in period order", lambda d, r: d["cells"][0]["points"].reverse())
        self.refuse("no last_text", lambda d, r: d["cells"][0].pop("last_text"))
        self.refuse("period entry", lambda d, r: d.__setitem__("periods", ["period:nrg_ind_ren:2006", "period:nrg_ind_ren:2024"]))
        self.refuse("is no code or is a cell", lambda d, r: d["ref"].__setitem__("code", "SE"))
        self.refuse("accent names", lambda d, r: d.__setitem__("accent", ["XX"]))
        self.refuse("at most two", lambda d, r: d.__setitem__("accent", ["SE", "MT", "FI"]))
        self.refuse("is no number", lambda d, r: [x.__setitem__("text", "不是数") for x in r if x["src"] == "fact:goal"])
        self.refuse("scale", lambda d, r: d["target"].__setitem__("scale", 0))
        self.refuse("a digit", lambda d, r: d.__setitem__("footnote", W("共 9 格")))
        self.refuse("too narrow", width=480, cols=6)
        self.refuse("is not one of", sort="rank")
        self.refuse("off its range", max_cells=13)

    def test_a_long_name_that_does_not_fit_its_head_refuses(self):
        def long_name(d, r):
            for x in r:
                if x["src"] == K.name_row("SE", "place"): x["text"] = "一个非常非常长的成员名字用来撑满格子的页头"
        rows, data, names = eu()
        long_name(data, rows)
        K.setup(rows, {**names, "SE": "一个非常非常长的成员名字用来撑满格子的页头"}, run.tables)
        with self.assertRaisesRegex(Refused, "overlap|leaves"):
            small_multiples.draw({"data": data, "style": {"small_multiples": {"cols": 5, "width": 900, "min_cell": 110}}})

    def test_the_file_holds_no_topic_word(self):
        with open(os.path.join(LEAVES, "small_multiples.py"), encoding="utf-8") as fh: src = fh.read().lower()
        for w in ("gas", "coal", "solar", "wind", "russia", "energy", "oil", "nuclear", "eurostat", "世界银行", "欧盟", "能源"):
            self.assertNotIn(w, src, w)


if __name__ == "__main__":
    unittest.main()
