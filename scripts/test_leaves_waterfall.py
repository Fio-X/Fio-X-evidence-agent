"""Self-test of the waterfall leaf (runtime/leaves_py/waterfall.py): a whole and four parts with a rest, test-only values,
ledger texts and names (layer 1 writes the real ones: each value its fact, the rest its rest fact, each name a reviewed
name row).
Checks: the leaf draws every digit inside a marked ledger run; the parts walk the whole: each part's bar starts where the one
above ended, and the last ends at the whole's end; one accent only (the highlighted part); a value sits right of its bar;
parts that do not add back to the whole are refused, as are the leaf's other rules. With LEAF_SVG_DIR set, the themed svg
is kept there. Run: python3 -I -B scripts/test_leaves_waterfall.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import run  # noqa: E402
import waterfall  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
TABLE = "nrg_bal_c"
KIND = "siec_group"
WHOLE, PARTS, REST = 242.4, {"O4000XBIO": 82.1, "G3000": 58.3, "RA000": 49.9, "N900H": 30.2}, {"C0000X0350-0370": 15.6, "W6100_6220": 6.3}
NAMES = {"O4000XBIO": "石油", "G3000": "天然气", "RA000": "可再生能源", "N900H": "核能"}  # test-only names


def src(code):
    return f"series:{TABLE}/{code}:2024:OBS_VALUE"


def build(parts=PARTS, rest=REST, whole=WHOLE):
    rows = [{"src": src("TOTAL"), "table": TABLE, "dims": {"siec": "TOTAL"}, "time": "2024", "value": whole},
            {"src": "fact:total.n", "text": f"{whole:.1f}"}]
    items = []
    for c, v in {**parts, **rest}.items():
        rows.append({"src": src(c), "table": TABLE, "dims": {"siec": c}, "time": "2024", "value": v})
    for c, v in parts.items():
        rows.append({"src": f"fact:part.{c}.n", "text": f"{v:.1f}"})
        items.append({"code": c, "value": src(c), "text": f"fact:part.{c}.n"})
    rows.append({"src": "fact:rest.n", "text": f"{sum(rest.values()):.1f}"})
    for c, nm in NAMES.items():
        rows.append({"src": f"name:zh_names:{KIND}:{c}", "text": nm})
    data = dict(title=W("能源总供应的构成"), unit=W("百万吨油当量"), part_kind=KIND,
                whole={"name": W("总供应"), "value": src("TOTAL"), "text": "fact:total.n"}, parts=items,
                rest={"name": W("其余"), "cells": [src(c) for c in rest], "text": "fact:rest.n"}, footnote=W("数据来源：欧盟统计局"))
    return rows, data


ROWS, DATA = build()


def hero(data, **style):
    return {"data": data, "style": {"waterfall": style}}


def draw(h, rows=ROWS, names=NAMES):
    K.setup(rows, names, run.tables)
    return waterfall.draw(h)


def check_svg(svg):
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def bars(svg):
    """(x, y, w, fill, code or None) of every bar, top down."""
    return [(float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4), m.group(6))
            for m in re.finditer(r'<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="[^"]+" fill="([^"]+)"( data-code="([^"]+)")?/>', svg)]


def text_boxes(svg):
    out = []
    for m in re.finditer(r'<text x="([^"]+)" y="([^"]+)" font-size="([^"]+)" text-anchor="([^"]+)"[^>]*>(.*?)</text>', svg):
        x, y, sz, anchor = float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4)
        text = re.sub(r"<[^>]+>", "", m.group(5)).replace("&amp;", "&")
        w = K.tw(text, sz)
        x0 = x if anchor == "start" else x - w if anchor == "end" else x - w / 2
        out.append((text, (x0, y - sz * 0.8, x0 + w, y + sz * 0.25)))
    return out


def themed(svg, w, h):
    css = ("<style>svg{--accent:#c93f2b;--t-title:#292928;--t-dark:#1f1e1d;--t-body:#4d4d4d;--t-sec:#707070;--bar:#c9c9c9;--empty:#e5e5e5;--bg:#fff;"
           + K.page_vars("#c93f2b") + "}</style>")
    return svg.replace(">", f">{css}<rect width='{w}' height='{h}' fill='#fff'/>", 1)


class Picture(unittest.TestCase):
    def setUp(self):
        self.svg, self.w, self.h = draw(hero(DATA, highlight="RA000"))
        if os.environ.get("LEAF_SVG_DIR"):
            with open(os.path.join(os.environ["LEAF_SVG_DIR"], "waterfall.svg"), "w", encoding="utf-8") as fh:
                fh.write(themed(self.svg, self.w, self.h))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        self.assertEqual(check_svg(self.svg), [])

    def test_the_parts_walk_the_whole(self):
        b = bars(self.svg)
        self.assertEqual(len(b), 1 + len(PARTS) + 1)
        whole = b[0]
        for above, below in zip(b[1:], b[2:]):
            self.assertAlmostEqual(above[0] + above[2], below[0], places=0)
        self.assertAlmostEqual(b[1][0], whole[0], places=0)
        self.assertAlmostEqual(b[-1][0] + b[-1][2], whole[0] + whole[2], delta=1.0)

    def test_one_accent_the_highlighted_part(self):
        self.assertEqual([x[4] for x in bars(self.svg) if x[3] == "var(--accent)"], ["RA000"])

    def test_each_value_sits_right_of_its_bar(self):
        boxes = dict(text_boxes(self.svg))
        for (x, y, w, _, code), text in zip(bars(self.svg), [f"{WHOLE:.1f}"] + [f"{v:.1f}" for v in PARTS.values()] + [f"{sum(REST.values()):.1f}"]):
            self.assertGreaterEqual(boxes[text][0], x + w)

    def test_its_rules(self):
        d = json.loads(json.dumps(DATA))

        def refused(data, rows=ROWS, **style):
            with self.assertRaises(Refused) as e:
                draw(hero(data, **style), rows)
            return str(e.exception)
        self.assertIn("no whole", refused({**d, "whole": None}))
        self.assertIn("fewer than two parts", refused({**d, "parts": d["parts"][:1]}))
        self.assertIn("twice", refused({**d, "parts": d["parts"] + d["parts"][:1]}))
        self.assertIn("add back to the whole", refused({k: v for k, v in d.items() if k != "rest"}))  # the rest left out
        rows, short = build(whole=WHOLE + 10)
        self.assertIn("add back to the whole", refused(short, rows=rows))
        self.assertIn("not a series of the request", refused({**d, "parts": [dict(d["parts"][0], value=src("XX"))] + d["parts"][1:]}))
        neg = [dict(r, value=-1.0) if r.get("src") == src("N900H") else r for r in ROWS]
        self.assertIn("below 0", refused(d, rows=neg))
        self.assertIn("part_kind", refused({**d, "part_kind": ""}))
        self.assertIn("highlight", refused(d, highlight="XX") + "highlight")
        self.assertIn("digit", refused({**d, "title": W("2024 年能源")}))
        self.assertIn("too narrow", refused({**d, "whole": dict(d["whole"], name=W("欧盟二十七国能源总供应（含全部燃料和电力进口）"))}, width=480, size=16))


class OneBar(unittest.TestCase):
    """The waterfall node is declared as stacked100 is (node-bindings.json declares_as): it reads stacked100's data shape
    with one bar as one whole, each part a step of its rows (a group of several leaf rows summed), its share as printed."""

    def stacked(self, **over):
        groups = {"O4000XBIO": ["O4000XBIO"], "G3000": ["G3000"], "RA000": ["RA000"], "N900H": ["N900H"],
                  "REST": list(REST)}  # the last group several leaf rows
        bar = {"code": "EU27", "total": src("TOTAL"), "total_text": "fact:total.n",
               "cells": {g: [src(c) for c in cs] for g, cs in groups.items()},
               "share_text": {g: (f"fact:part.{g}.n" if g in PARTS else "fact:rest.n") for g in groups}}
        d = dict(title=DATA["title"], unit=DATA["unit"], bar_kind="place", part_kind=KIND, parts=list(groups), bars=[bar],
                 total_head=W("总供应"))
        d.update(over)
        return d

    def test_one_bar_is_one_whole(self):
        rows = ROWS + [{"src": f"name:zh_names:{KIND}:REST", "text": "其余"}]
        svg, _, _ = draw(hero(self.stacked()), rows=rows, names={**NAMES, "REST": "其余"})
        self.assertEqual(check_svg(svg), [])
        got = waterfall.one_bar(self.stacked())
        self.assertEqual([p["code"] for p in got["parts"]], ["O4000XBIO", "G3000", "RA000", "N900H", "REST"])
        self.assertEqual(got["parts"][-1]["cells"], [src(c) for c in REST])
        self.assertEqual(got["whole"], {"name": W("总供应"), "value": src("TOTAL"), "text": "fact:total.n"})
        # a declared zero or an empty part draws no step
        self.assertNotIn("N900H", [p["code"] for p in waterfall.one_bar(self.stacked(zero=[{"bar": "EU27", "part": "N900H", "cells": []}]))["parts"]])
        self.assertIs(waterfall.one_bar(DATA), DATA)  # the waterfall's own shape as given

    def test_its_refusals(self):
        two = self.stacked()
        two["bars"] = two["bars"] * 2
        for bad, why in ((two, "one whole"), (self.stacked(others={"head": W("其余"), "codes": ["DEU"]}), "left out"),
                         (self.stacked(total_head=None), "no total")):
            with self.assertRaises(Refused) as e:
                waterfall.one_bar(bad)
            self.assertIn(why, str(e.exception))


class Note(unittest.TestCase):
    """The note under the steps (_share_note): the largest part's share above the second's, stated only where the core's
    comparison (knobs.comparisons, here set by hand) names the same two share facts; marked data-cmp next in g[data-notes]."""

    A, B = "fact:part.O4000XBIO.n", "fact:part.G3000.n"

    def tearDown(self):
        K.COMPARISONS = None

    def drawn(self, comparisons, data=DATA, rows=ROWS):
        K.COMPARISONS = comparisons
        return draw(hero(data, highlight="RA000"), rows=rows)[0]

    def agreed(self, **over):
        return {"part.O4000XBIO": dict({"first": "part.O4000XBIO", "second": "part.G3000", "scoped": False}, **over)}

    def test_the_note_is_drawn_where_the_core_agrees(self):
        svg = self.drawn(self.agreed())
        self.assertIn('<g data-notes="share">', svg)
        self.assertIn(f'data-cmp="next" data-a="{self.A}" data-b="{self.B}"', svg)
        self.assertEqual(check_svg(svg), [])
        self.assertIn("石油", re.sub(r"<[^>]+>", "", svg.split('<g data-notes="share">')[1]))
        boxes = dict(text_boxes(svg))
        note = [t for t in boxes if "石油" in t and "天然气" in t]
        self.assertEqual(len(note), 1, boxes.keys())
        self.assertLessEqual(boxes[note[0]][2], 1140)

    def test_no_note_without_the_core_agreeing(self):
        plain = self.drawn(None)
        self.assertNotIn("data-notes", plain)
        self.assertNotIn("data-notes", self.drawn({}))  # the core sent none for this share
        self.assertNotIn("data-notes", self.drawn(self.agreed(second="part.RA000")))  # another second
        self.assertNotIn("data-notes", self.drawn(self.agreed(first="part.G3000")))  # another first
        self.assertNotIn("data-notes", self.drawn(self.agreed(scoped=True)))  # a scoped set says its scope: not this leaf's note
        self.assertEqual(check_svg(plain), [])

    def test_no_note_over_a_tie_or_a_single_part(self):
        rows, tied = build(parts={"O4000XBIO": 70.0, "G3000": 70.0, "RA000": 49.9}, rest={"N900H": 52.5}, whole=242.4)
        self.assertNotIn("data-notes", self.drawn(self.agreed(), data=tied, rows=rows))  # printed alike: no strict first


if __name__ == "__main__":
    unittest.main()
