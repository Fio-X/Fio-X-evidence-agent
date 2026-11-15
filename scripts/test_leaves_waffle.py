"""Self-test of the waffle leaf (runtime/leaves_py/waffle.py): a whole of three parts and a rest, test-only values, ledger
texts and names (layer 1 writes the real ones: each share its fact, the rest its rest fact, each name a reviewed name row).
Checks: the leaf draws every digit inside a marked ledger run; the grid holds exactly 100 squares, each part's count its
share by the largest remainder (no count a whole square or more off its share); one accent only (the highlighted part's
squares and swatch); the parts fill in order from the top left; the counting rule on its own; the refusals keep the leaf's
rules. With LEAF_SVG_DIR set, the themed svg is kept there. Run: python3 -I -B scripts/test_leaves_waffle.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import run  # noqa: E402
import waffle  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
TABLE = "nrg_bal_c"
KIND = "siec_group"
WHOLE, PARTS, REST = 177.7, {"O4000XBIO": 75.6, "E7000": 40.3, "G3000": 33.9}, {"RA000": 17.2, "H8000": 10.7}
NAMES = {"O4000XBIO": "石油", "E7000": "电力", "G3000": "天然气"}  # test-only names


def src(code):
    return f"series:{TABLE}/{code}:2024:OBS_VALUE"


def build(parts=PARTS, rest=REST, whole=WHOLE):
    rows = [{"src": src("TOTAL"), "table": TABLE, "dims": {"siec": "TOTAL"}, "time": "2024", "value": whole}]
    items = []
    for c, v in {**parts, **rest}.items():
        rows.append({"src": src(c), "table": TABLE, "dims": {"siec": c}, "time": "2024", "value": v})
    for c, v in parts.items():
        rows.append({"src": f"fact:share.{c}", "text": f"{100 * v / whole:.1f}%"})
        items.append({"code": c, "value": src(c), "text": f"fact:share.{c}"})
    rows.append({"src": "fact:share.rest", "text": f"{100 * sum(rest.values()) / whole:.1f}%"})
    data = dict(title=W("最终能源消费的构成"), part_kind=KIND, whole=src("TOTAL"), parts=items,
                rest={"name": W("其余"), "cells": [src(c) for c in rest], "text": "fact:share.rest"}, footnote=W("每格代表总量的百分之一"))
    return rows, data


ROWS, DATA = build()


def hero(data, **style):
    return {"data": data, "style": {"waffle": style}}


def draw(h, rows=ROWS, names=NAMES):
    K.setup(rows, names, run.tables)
    return waffle.draw(h)


def check_svg(svg):
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def squares(svg):
    return [(float(m.group(1)), float(m.group(2)), m.group(3), m.group(4))
            for m in re.finditer(r'<rect x="([^"]+)" y="([^"]+)" width="[^"]+" height="[^"]+" fill="([^"]+)" data-code="([^"]+)"/>', svg)]


def themed(svg, w, h):
    css = ("<style>svg{--accent:#c93f2b;--t-title:#292928;--t-dark:#1f1e1d;--t-body:#4d4d4d;--t-sec:#707070;--bar:#c9c9c9;--empty:#e5e5e5;--bg:#fff;"
           + K.page_vars("#c93f2b") + "}</style>")
    return svg.replace(">", f">{css}<rect width='{w}' height='{h}' fill='#fff'/>", 1)


class Picture(unittest.TestCase):
    def setUp(self):
        self.svg, self.w, self.h = draw(hero(DATA, highlight="E7000"))
        if os.environ.get("LEAF_SVG_DIR"):
            with open(os.path.join(os.environ["LEAF_SVG_DIR"], "waffle.svg"), "w", encoding="utf-8") as fh:
                fh.write(themed(self.svg, self.w, self.h))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        self.assertEqual(check_svg(self.svg), [])

    def test_a_hundred_squares_each_part_its_share(self):
        sq = squares(self.svg)
        self.assertEqual(len(sq), 100)
        total = sum(PARTS.values()) + sum(REST.values())
        for code, v in [*PARTS.items(), ("rest", sum(REST.values()))]:
            n = sum(1 for s in sq if s[3] == code)
            self.assertLess(abs(n - 100 * v / total), 1, code)

    def test_one_accent_and_the_parts_fill_in_order(self):
        sq = squares(self.svg)
        self.assertEqual({s[3] for s in sq if s[2] == "var(--accent)"}, {"E7000"})
        order = []
        for s in sq:  # drawn row by row from the top left
            if not order or order[-1] != s[3]: order.append(s[3])
        self.assertEqual(order, list(PARTS) + ["rest"])

    def test_counts(self):
        self.assertEqual(waffle.counts([1, 1, 1], 3), [34, 33, 33])
        self.assertEqual(sum(waffle.counts([0.333, 0.333, 0.334], 1)), 100)
        self.assertEqual(waffle.counts([50, 50], 100), [50, 50])
        self.assertEqual(waffle.counts([99.6, 0.4], 100), [100, 0])

    def test_its_rules(self):
        d = json.loads(json.dumps(DATA))

        def refused(data, rows=ROWS, **style):
            with self.assertRaises(Refused) as e:
                draw(hero(data, **style), rows)
            return str(e.exception)
        self.assertIn("no part", refused({**d, "parts": []}))
        self.assertIn("twice", refused({**d, "parts": d["parts"] + d["parts"][:1]}))
        self.assertIn("add back to the whole", refused({k: v for k, v in d.items() if k != "rest"}))
        rows, more = build(whole=WHOLE + 5)
        self.assertIn("add back to the whole", refused(more, rows=rows))
        self.assertIn("not a series of the request", refused({**d, "whole": src("XX")}))
        neg = [dict(r, value=-1.0) if r.get("src") == src("G3000") else r for r in ROWS]
        self.assertIn("below 0", refused(d, rows=neg))
        extra = {**d, "parts": d["parts"] + [{"code": "RA000", "value": src("RA000"), "text": "fact:share.rest"}],
                 "rest": dict(d["rest"], cells=[src("H8000")])}
        rows4 = ROWS + [{"src": "name:zh_names:siec_group:RA000", "text": "可再生能源"}]
        self.assertIn("steps", refused(extra, rows=rows4))
        self.assertIn("part_kind", refused({**d, "part_kind": ""}))
        self.assertIn("highlight", refused(d, highlight="XX") + "highlight")
        self.assertIn("digit", refused({**d, "title": W("2024 年能源")}))
        self.assertIn("too narrow", refused(d, width=480, cell=36))


if __name__ == "__main__":
    unittest.main()
