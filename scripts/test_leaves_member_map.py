"""Self-test of the member map leaf (runtime/leaves_py/member_map.py) on two data shapes with test-only values, ledger texts and
words (layer 1 writes the real ones: each called-out member's value its fact, the points from the attributes table):
  - an EU shape: nine members (the interior points geo.PT holds), a call-out for the highest and the lowest three;
  - a World Bank shape: eight economies (their iso3 label points from the attributes table), the same call-outs.
Checks: every member's country is filled in one of five steps and a higher value never has a lower step; the legend ends are the
lowest and the highest members' value texts; the call-outs are the cells with a value text, a leader and a dot each, on the side
their point lies; every digit sits inside a marked ledger run; the refusals keep the leaf's rules; the file holds no topic word.
With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_member_map.py"""
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
import member_map  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

SHAPES = os.path.join(ASSETS, "naturalearth-admin0-50m.geojson")
W = lambda t: [{"w": t}]
EU_VALUES = {"SE": 57.3, "FI": 43.4, "AT": 33.5, "DE": 22.4, "FR": 21.1, "PL": 16.7, "NL": 18.9, "MT": 4.3, "LU": 4.2}
EU_NAMES = {"SE": "瑞典", "FI": "芬兰", "AT": "奥地利", "DE": "德国", "FR": "法国", "PL": "波兰", "NL": "荷兰", "MT": "马耳他", "LU": "卢森堡"}
WB_VALUES = {"USA": 13.4, "DEU": 7.1, "CHN": 8.3, "IND": 2.1, "BRA": 2.3, "ZAF": 7.0, "JPN": 8.5, "AUS": 14.9}
WB_NAMES = {"USA": "美国", "DEU": "德国", "CHN": "中国", "IND": "印度", "BRA": "巴西", "ZAF": "南非", "JPN": "日本", "AUS": "澳大利亚"}


def attribute_points(codes):
    with open(os.path.join(ASSETS, "naturalearth-admin0-50m-attributes.json"), encoding="utf-8") as fh: feats = json.load(fh)["features"]
    by = {x["iso3"]: x for x in feats if x["iso3"] == x["adm0_a3"]}  # the mainland's entry, not an island territory's under the same iso3
    return {c: list(by[c]["label"]) for c in codes}


def build(table, values, names, points, called=3, year="2024"):
    rows, cells = [], []
    order = sorted(values, key=lambda c: (-values[c], c))
    shown = set(order[:called] + order[-called:])
    for c, v in values.items():
        src = f"series:{table}/{c}:{year}:OBS_VALUE"
        rows.append({"src": src, "table": table, "dims": {"geo": c}, "time": year, "value": v})
        cell = {"code": c, "at": points[c], "value": src}
        if c in shown:
            rows.append({"src": f"fact:mp_{c.lower()}", "text": f"{v:.1f}"}); cell["text"] = f"fact:mp_{c.lower()}"
        cells.append(cell)
    rows += [{"src": K.name_row(c, "place"), "text": n} for c, n in names.items()]
    data = {"title": W("占比"), "unit": W("百分比"), "name_kind": "place", "cells": cells,
            "ends": {"lo": f"fact:mp_{order[-1].lower()}", "hi": f"fact:mp_{order[0].lower()}"}, "footnote": W("颜色分五档")}
    return rows, data, names


def eu():
    return build("t", EU_VALUES, EU_NAMES, {c: list(geo.PT[c]) for c in EU_VALUES})


def wb():
    return build("t", WB_VALUES, WB_NAMES, attribute_points(WB_VALUES))


def draw(shape, **style):
    rows, data, names = shape
    geo.NE = SHAPES
    K.setup(rows, names, run.tables)
    return member_map.draw({"data": data, "style": {"member_map": style}})


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


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shapes = {"eu": eu(), "wb": wb()}
        cls.out = {n: draw(s) for n, s in cls.shapes.items()}
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            for n, (svg, w, h) in cls.out.items():
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"member_map-{n}.svg"), "w", encoding="utf-8") as fh: fh.write(themed(svg, w, h))

    def test_every_digit_is_a_marked_ledger_run(self):
        for n, (svg, _, _) in self.out.items(): self.assertEqual(check_svg(svg), [], n)

    def test_each_member_is_filled_in_a_step_that_never_falls_as_its_value_rises(self):
        for n, vals in (("eu", EU_VALUES), ("wb", WB_VALUES)):
            svg = self.out[n][0]
            steps = {m.group(1): int(m.group(2)) for m in re.finditer(r'<path [^>]*data-code="([A-Z]+)" data-step="(\d)"', svg)}
            self.assertEqual(sorted(steps), sorted(vals), n)
            order = sorted(vals, key=lambda c: vals[c])
            self.assertEqual([steps[c] for c in order], sorted(steps[c] for c in order), n)
            self.assertEqual((steps[order[0]], steps[order[-1]]), (0, 4), n)

    def test_call_outs_are_the_cells_with_a_text_and_the_legend_ends_are_the_extremes(self):
        for n, vals in (("eu", EU_VALUES), ("wb", WB_VALUES)):
            svg = self.out[n][0]
            order = sorted(vals, key=lambda c: (-vals[c], c))
            shown = order[:3] + order[-3:]
            for c in vals:
                self.assertEqual(f'data-src="fact:mp_{c.lower()}"' in svg, c in shown, (n, c))
            self.assertEqual(len(re.findall(r'data-part="leader"', svg)), 6)
            self.assertEqual(len(re.findall(r'data-part="legend"', svg)), 5)
            # the legend's two ends print the lowest and the highest values
            self.assertIn(f'data-src="fact:mp_{order[0].lower()}"', svg); self.assertIn(f'data-src="fact:mp_{order[-1].lower()}"', svg)

    def test_the_picture_is_one_map_in_one_svg_of_its_width(self):
        for n, (svg, w, h) in self.out.items():
            self.assertEqual(w, 1140); self.assertGreater(h, 300); self.assertTrue(svg.startswith(f'<svg class="member_map" viewBox="0 0 1140 {h}"'))


class Rules(unittest.TestCase):
    def refuse(self, want, edit=None, shapes=SHAPES, **style):
        rows, data, names = eu()
        if edit: edit(data, rows)
        geo.NE = shapes
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, want):
            member_map.draw({"data": data, "style": {"member_map": style}})

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
        self.refuse("lies inside no country", lambda d, r: d["cells"][0].__setitem__("at", [-30.0, 40.0]))
        self.refuse("lie in one country", lambda d, r: d["cells"][1].__setitem__("at", d["cells"][0]["at"]))
        self.refuse("no Natural Earth file", shapes=None)
        self.refuse("is not a series of the request", lambda d, r: d["cells"][0].__setitem__("value", "series:t/ZZ:2024:OBS_VALUE"))
        self.refuse("ends needs", lambda d, r: d.pop("ends"))
        self.refuse("is not the text of the member", lambda d, r: d["ends"].__setitem__("hi", d["ends"]["lo"]))
        self.refuse("a digit", lambda d, r: d.__setitem__("footnote", W("共 5 档")))
        self.refuse("off its range", width=400)

    def test_the_file_holds_no_topic_word(self):
        with open(os.path.join(LEAVES, "member_map.py"), encoding="utf-8") as fh: src = fh.read().lower()
        for w in ("gas", "coal", "solar", "wind", "russia", "energy", "oil", "nuclear", "eurostat", "世界银行", "欧盟", "能源"):
            self.assertNotIn(w, src, w)


if __name__ == "__main__":
    unittest.main()
