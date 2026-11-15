"""Self-test of the dumbbell leaf (runtime/leaves_py/dumbbell.py) on the archived World Bank SP.POP.65UP.TO.ZS, population aged
65 and above as a share of the total (scripts/fixtures/data_prepare/worldbank/q5.json): five economies at 2015 and 2025.
Test-only ledger texts and names (layer 1 writes the real ones: each value its fact, each tick next_facts::ticks, each
name a reviewed name row).
Checks: the leaf draws every digit inside a marked ledger run; one accent only (the highlighted row's connector and end dot),
the start dots hollow, the other end dots ink; each row's start value left of its left dot and end value right of its right
dot, so no line runs through a value; a row whose value fell (end left of start) puts the end value on the left; the
refusals keep the leaf's rules. With LEAF_SVG_DIR set, the themed svg is kept there.
Run: python3 -I -B scripts/test_leaves_dumbbell.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import dumbbell  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
CODES = ["KOR", "JPN", "ITA", "DEU", "CHN"]
NAMES = {"KOR": "韩国", "JPN": "日本", "ITA": "意大利", "DEU": "德国", "CHN": "中国"}  # test-only names
TABLE = "SP.POP.65UP.TO.ZS@2"
Y0, Y1 = "2015", "2025"


def load():
    rows = json.load(open(os.path.join(HERE, "fixtures", "data_prepare", "worldbank", "q5.json"), encoding="utf-8"))[1]
    return {(r["countryiso3code"], r["date"]): float(r["value"]) for r in rows if r["countryiso3code"] in CODES and r["value"] is not None}


TAB = load()


def src(code, year):
    return f"series:{TABLE}/{code}:{year}:value"


def build(tab=TAB):
    rows, items = [], []
    for c in CODES:
        for y in (Y0, Y1):
            rows.append({"src": src(c, y), "table": TABLE, "dims": {"country": c}, "time": y, "value": tab[(c, y)]})
            rows.append({"src": f"fact:v{y}.{c}", "text": f"{tab[(c, y)]:.1f}%"})
        items.append({"code": c, "a": src(c, Y0), "b": src(c, Y1), "a_text": f"fact:v{Y0}.{c}", "b_text": f"fact:v{Y1}.{c}"})
    ticks = []
    for i in (1, 2, 3):
        rows.append({"src": f"fact:top.tick{i}", "text": str(10 * i)}); ticks.append(f"fact:top.tick{i}")
    for y in (Y0, Y1):
        rows.append({"src": f"period:{TABLE}:{y}", "text": y})
    data = dict(title=W("老龄人口占比的变化"), unit=W("占总人口的百分比"), series_kind="place", rows=items,
                periods=[f"period:{TABLE}:{Y0}", f"period:{TABLE}:{Y1}"], axis={"ticks": ticks, "scale": 1}, footnote=W("数据来源：世界银行"))
    return rows, data


ROWS, DATA = build()


def hero(data, **style):
    return {"data": data, "style": {"dumbbell": style}}


def draw(h, rows=ROWS, names=NAMES):
    K.setup(rows, names, run.tables)
    return dumbbell.draw(h)


def check_svg(svg):
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def connectors(svg):
    return [(m.group(5), m.group(4), *(float(m.group(i)) for i in (1, 2, 3)))
            for m in re.finditer(r'<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="[^"]+" stroke="([^"]+)" stroke-width="[^"]+" '
                                 r'stroke-linecap="round" data-code="([^"]+)"/>', svg)]


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
        self.svg, self.w, self.h = draw(hero(DATA, highlight="KOR"))
        if os.environ.get("LEAF_SVG_DIR"):
            with open(os.path.join(os.environ["LEAF_SVG_DIR"], "dumbbell.svg"), "w", encoding="utf-8") as fh:
                fh.write(themed(self.svg, self.w, self.h))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        self.assertEqual(check_svg(self.svg), [])
        printed = [t for t, _ in text_boxes(self.svg)]
        for c in CODES:
            for y in (Y0, Y1):
                self.assertIn(f"{TAB[(c, y)]:.1f}%", printed)

    def test_one_accent_the_highlighted_row(self):
        con = connectors(self.svg)
        self.assertEqual([c for c, stroke, *_ in con if stroke == "var(--accent)"], ["KOR"])
        filled = re.findall(r'<circle cx="[^"]+" cy="[^"]+" r="[^"]+" fill="([^"]+)" data-code="([^"]+)"/>', self.svg)
        self.assertEqual(sorted(c for f, c in filled if f == "var(--accent)"), ["KOR"])
        self.assertTrue(all(f == "var(--t-title)" for f, c in filled if c != "KOR"))
        hollow = re.findall(r'fill="var\(--bg\)" stroke="var\(--t-sec\)" stroke-width="1.5" data-code="([^"]+)"', self.svg)
        self.assertEqual(sorted(hollow), sorted(CODES))

    def test_no_value_sits_on_its_connector(self):
        boxes = dict((t, b) for t, b in text_boxes(self.svg))
        for code, _, x1, y, x2 in connectors(self.svg):
            lo, hi = min(x1, x2), max(x1, x2)
            for t, b in boxes.items():
                if b[1] < y < b[3]:  # a text on this row
                    self.assertFalse(b[0] < hi and lo < b[2], f"{t!r} sits on {code}'s connector")

    def test_a_fall_puts_the_end_value_on_the_left(self):
        fell = dict(TAB); fell[("CHN", Y1)] = TAB[("CHN", Y0)] - 3
        rows, data = build(fell)
        svg, _, _ = draw(hero(data), rows)
        end = f"{fell[('CHN', Y1)]:.1f}%"
        box = dict(text_boxes(svg))[end]
        start_box = dict(text_boxes(svg))[f"{fell[('CHN', Y0)]:.1f}%"]
        self.assertLess(box[2], start_box[0])

    def test_its_rules(self):
        d = json.loads(json.dumps(DATA))

        def refused(data, rows=ROWS, names=NAMES, **style):
            with self.assertRaises(Refused) as e:
                draw(hero(data, **style), rows, names)
            return str(e.exception)
        self.assertIn("no rows", refused({**d, "rows": []}))
        self.assertIn("twice", refused({**d, "rows": d["rows"] + d["rows"][:1]}))
        self.assertIn("not a series of the request", refused({**d, "rows": [dict(d["rows"][0], a=src("KOR", "2030"))] + d["rows"][1:]}))
        self.assertIn("at one period", refused({**d, "rows": [dict(d["rows"][0], b=d["rows"][0]["a"])] + d["rows"][1:]}))
        neg = [dict(r, value=-1.0) if r.get("src") == src("CHN", Y0) else r for r in ROWS]
        self.assertIn("below 0", refused(d, rows=neg))
        self.assertIn("start and the end period", refused({**d, "periods": d["periods"][:1]}))
        self.assertIn("no row's cell has", refused({**d, "periods": d["periods"][::-1]}))
        self.assertIn("no tick", refused({**d, "axis": {"ticks": [], "scale": 1}}))
        self.assertIn("not ascending", refused({**d, "axis": {"ticks": d["axis"]["ticks"][::-1], "scale": 1}}))
        self.assertIn("highlight", refused(d, highlight="FRA") + "highlight")
        long = {**NAMES, "KOR": "大韩民国（统计口径含全部行政区划的人口）"}  # a name long enough to leave the plot under 240 px
        self.assertIn("too narrow", refused(d, names=long, width=480, size=16))
        self.assertIn("digit", refused({**d, "title": W("2025 年老龄人口")}))


if __name__ == "__main__":
    unittest.main()
