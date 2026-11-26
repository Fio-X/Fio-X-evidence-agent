"""Self-test of the change-dots leaf (runtime/leaves_py/change_dots.py) on two data shapes with test-only values, ledger texts and
words (layer 1 writes the real ones: each row's two values their facts):
  - an EU shape: nine members and the whole, a share at 2005 and 2024 (everyone rises, one falls back);
  - a World Bank shape: six economies, tonnes per head at 2010 and 2022 (most fall).
Checks: one row a place, ordered by change from the largest rise down (the whole where its change puts it); the start dot hollow and
the end dot filled; the accent rows in the accent and the whole's row bold; the start value left of the left dot and the end value
right of the right dot whichever way a row went; every digit inside a marked ledger run; the refusals keep the leaf's rules; the
file holds no topic word. With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_change_dots.py"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LEAVES = os.path.join(ROOT, "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import change_dots  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
EU = {"SE": (40.5, 66.0), "FI": (28.9, 52.0), "AT": (24.0, 40.0), "DE": (7.0, 22.0), "FR": (9.5, 24.0), "PL": (7.0, 17.0),
      "NL": (2.5, 17.0), "MT": (6.0, 5.0), "LU": (1.5, 12.0), "EU27_2020": (10.2, 24.6)}
EU_NAMES = {"SE": "瑞典", "FI": "芬兰", "AT": "奥地利", "DE": "德国", "FR": "法国", "PL": "波兰", "NL": "荷兰", "MT": "马耳他", "LU": "卢森堡", "EU27_2020": "欧盟"}
WB = {"USA": (17.0, 13.4), "DEU": (9.5, 7.1), "CHN": (6.5, 8.3), "IND": (1.4, 2.1), "BRA": (2.2, 2.3), "ZAF": (8.8, 7.0)}
WB_NAMES = {"USA": "美国", "DEU": "德国", "CHN": "中国", "IND": "印度", "BRA": "巴西", "ZAF": "南非"}


def build(table, values, names, y0, y1, accent, ref=None):
    rows, out = [], []
    for c, (a, b) in values.items():
        for y, v in ((y0, a), (y1, b)):
            rows.append({"src": f"series:{table}/{c}:{y}:OBS_VALUE", "table": table, "dims": {"geo": c}, "time": y, "value": v})
        rows += [{"src": f"fact:mv_a_{c.lower()}", "text": f"{a:.1f}"}, {"src": f"fact:mv_b_{c.lower()}", "text": f"{b:.1f}"}]
        out.append({"code": c, "a": f"series:{table}/{c}:{y0}:OBS_VALUE", "b": f"series:{table}/{c}:{y1}:OBS_VALUE",
                    "a_text": f"fact:mv_a_{c.lower()}", "b_text": f"fact:mv_b_{c.lower()}"})
    rows += [{"src": f"period:{table}:{y0}", "text": y0}, {"src": f"period:{table}:{y1}", "text": y1}]
    rows += [{"src": K.name_row(c, "place"), "text": n} for c, n in names.items()]
    data = {"title": W("占比"), "unit": W("百分比"), "name_kind": "place", "rows": out, "periods": [f"period:{table}:{y0}", f"period:{table}:{y1}"],
            "accent": accent, "footnote": W("按变化从大到小排开")}
    if ref: data["ref"] = ref
    return rows, data, names


def eu(): return build("t", EU, EU_NAMES, "2005", "2024", ["SE", "MT"], "EU27_2020")
def wb(): return build("t", WB, WB_NAMES, "2010", "2022", ["USA", "CHN"])


def draw(shape, **style):
    rows, data, names = shape
    K.setup(rows, names, run.tables)
    return change_dots.draw({"data": data, "style": {"change_dots": style}})


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
        cls.vals = {"eu": EU, "wb": WB}
        cls.out = {"eu": draw(eu()), "wb": draw(wb())}
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            for n, (svg, w, h) in cls.out.items():
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"change_dots-{n}.svg"), "w", encoding="utf-8") as fh: fh.write(themed(svg, w, h))

    def test_every_digit_is_a_marked_ledger_run(self):
        for n, (svg, _, _) in self.out.items(): self.assertEqual(check_svg(svg), [], n)

    def test_one_row_a_place_ordered_by_change_from_the_largest_rise(self):
        for n, vals in self.vals.items():
            svg = self.out[n][0]
            order = re.findall(r'<line [^>]*data-code="([A-Z0-9_]+)"', svg)
            want = sorted(vals, key=lambda c: (-(vals[c][1] - vals[c][0]), c))
            self.assertEqual(order, want, n)

    def test_the_start_dot_is_hollow_the_end_dot_filled_and_the_values_stand_outside_the_dots(self):
        for n, vals in self.vals.items():
            svg = self.out[n][0]
            for c, (a, b) in vals.items():
                dots = re.findall(rf'<circle cx="([0-9.]+)" cy="[0-9.]+" r="[0-9.]+" fill="([^"]+)"[^>]*data-code="{c}"', svg)
                self.assertEqual(len(dots), 2, (n, c))
                (xa, fa), (xb, fb) = dots
                self.assertEqual(fa, "var(--bg)"); self.assertNotEqual(fb, "var(--bg)")
                self.assertEqual(float(xa) < float(xb), a < b, (n, c))
                # the printed start value stands left of the left dot, the end value right of the right dot
                left = re.search(rf'<text x="([0-9.]+)"[^>]*text-anchor="end"[^>]*><tspan data-src="fact:mv_{"a" if a < b else "b"}_{c.lower()}"', svg)
                self.assertIsNotNone(left, (n, c)); self.assertLess(float(left.group(1)), min(float(xa), float(xb)), (n, c))
                right = re.search(rf'<text x="([0-9.]+)"[^>]*text-anchor="start"[^>]*><tspan data-src="fact:mv_{"b" if a < b else "a"}_{c.lower()}"', svg)
                self.assertIsNotNone(right, (n, c)); self.assertGreater(float(right.group(1)), max(float(xa), float(xb)), (n, c))

    def test_the_accent_rows_and_the_whole_are_marked(self):
        svg = self.out["eu"][0]
        for c in ("SE", "MT"): self.assertRegex(svg, rf'<line [^>]*stroke="var\(--accent\)"[^>]*data-code="{c}"')
        self.assertRegex(svg, r'<line [^>]*stroke="var\(--t-body\)"[^>]*data-code="EU27_2020"')
        self.assertNotRegex(self.out["wb"][0], r'stroke="var\(--t-body\)"[^>]*data-code=')

    def test_the_picture_is_one_svg_of_its_width(self):
        for n, (svg, w, h) in self.out.items():
            self.assertEqual(w, 1140); self.assertTrue(svg.startswith(f'<svg class="change_dots" viewBox="0 0 1140 {h}"'))
            self.assertGreater(h, 150)


class Rules(unittest.TestCase):
    def refuse(self, want, edit=None, **style):
        rows, data, names = eu()
        if edit: edit(data, rows)
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, want):
            change_dots.draw({"data": data, "style": {"change_dots": style}})

    def test_its_refusals(self):
        self.refuse("fewer than 4 rows", lambda d, r: d.__setitem__("rows", d["rows"][:3]))
        self.refuse("come twice", lambda d, r: d["rows"].append(dict(d["rows"][0])))
        self.refuse("are not codes", lambda d, r: d["rows"][0].__setitem__("code", "no good"))
        self.refuse("is not a series of the request", lambda d, r: d["rows"][0].__setitem__("a", "series:t/ZZ:2005:OBS_VALUE"))
        self.refuse("at one period", lambda d, r: d["rows"][0].__setitem__("b", d["rows"][0]["a"]))
        self.refuse("lacks a value's ledger entry", lambda d, r: d["rows"][0].pop("b_text"))
        self.refuse("other periods than the first row's", lambda d, r: d["rows"][1].__setitem__("a", d["rows"][1]["a"].replace("2005", "2006")) or r.append({"src": "series:t/FI:2006:OBS_VALUE", "table": "t", "dims": {"geo": "FI"}, "time": "2006", "value": 3.0}))
        self.refuse("needs the start and the end period entries", lambda d, r: d.__setitem__("periods", d["periods"][:1]))
        self.refuse("names a period no row's cell has", lambda d, r: d.__setitem__("periods", ["period:t:2005", "period:t:2005"]))
        self.refuse("accent is a list of at most two", lambda d, r: d.__setitem__("accent", ["SE", "FI", "AT"]))
        self.refuse("no row", lambda d, r: d.__setitem__("accent", ["ZZ"]))
        self.refuse("is no row", lambda d, r: d.__setitem__("ref", "ZZ"))
        self.refuse("a digit", lambda d, r: d.__setitem__("footnote", W("共 9 行")))
        self.refuse("off its range", width=300)
        self.refuse("no knob", dots=1)

    def test_nothing_moved_is_refused(self):
        rows, data, names = build("t", {c: (v[0], v[0]) for c, v in EU.items()}, EU_NAMES, "2005", "2024", [])
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, "no row moved"):
            change_dots.draw({"data": data, "style": {}})

    def test_the_given_order_is_a_knob(self):
        svg = draw(eu(), sort="given")[0]
        self.assertEqual(re.findall(r'<line [^>]*data-code="([A-Z0-9_]+)"', svg), list(EU))

    def test_the_file_holds_no_topic_word(self):
        with open(os.path.join(LEAVES, "change_dots.py"), encoding="utf-8") as fh: src = fh.read().lower()
        for w in ("gas", "coal", "solar", "wind", "russia", "energy", "oil", "nuclear", "eurostat", "世界银行", "欧盟", "能源"):
            self.assertNotIn(w, src, w)


if __name__ == "__main__":
    unittest.main()
