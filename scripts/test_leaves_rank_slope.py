"""Self-test of the rank-slope leaf (runtime/leaves_py/rank_slope.py) on two data shapes with test-only values, ledger texts and
words (layer 1 writes the real ones: each place's two ranks the position facts):
  - an EU shape: nine members and the whole, a share at 2005 and 2024 (places swap);
  - a World Bank shape: six economies, tonnes per head at 2010 and 2022 (one pair ties at the end).
Checks: one line a place from its rank at the start (left) to its rank at the end (right), the highest at the top of each column;
a place that rose runs up the picture, one that fell runs down; a tie shares its rank number and keeps a row of its own; each end
prints "<rank> <name>" with the rank a ledger entry the cells give (a rank that is not the cells' refuses); the accent lines in the
accent over the plain ones, the whole's bold; no label is crossed by a line; every digit inside a marked ledger run; the refusals
keep the leaf's rules; the file holds no topic word. With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_rank_slope.py"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LEAVES = os.path.join(ROOT, "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import rank_slope  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
EU = {"SE": (40.5, 66.0), "FI": (28.9, 52.0), "AT": (24.0, 40.0), "DE": (7.0, 22.0), "FR": (9.5, 24.0), "PL": (7.0, 17.0),
      "NL": (2.5, 17.0), "MT": (6.0, 5.0), "LU": (1.5, 12.0), "EU27_2020": (10.2, 24.6)}
EU_NAMES = {"SE": "瑞典", "FI": "芬兰", "AT": "奥地利", "DE": "德国", "FR": "法国", "PL": "波兰", "NL": "荷兰", "MT": "马耳他", "LU": "卢森堡", "EU27_2020": "欧盟"}
WB = {"USA": (17.0, 13.4), "DEU": (9.5, 7.1), "CHN": (6.5, 8.3), "IND": (1.4, 2.1), "BRA": (2.2, 2.1), "ZAF": (8.8, 7.0)}   # BRA and IND tie at the end
WB_NAMES = {"USA": "美国", "DEU": "德国", "CHN": "中国", "IND": "印度", "BRA": "巴西", "ZAF": "南非"}


def ranks(vals, i):
    return {c: 1 + sum(1 for w in vals.values() if w[i] > v[i]) for c, v in vals.items()}


def build(table, values, names, y0, y1, accent, ref=None):
    r0, r1 = ranks(values, 0), ranks(values, 1)
    rows, out = [], []
    for c, (a, b) in values.items():
        for y, v in ((y0, a), (y1, b)):
            rows.append({"src": f"series:{table}/{c}:{y}:OBS_VALUE", "table": table, "dims": {"geo": c}, "time": y, "value": v})
        rows += [{"src": f"fact:ot_a_{c.lower()}", "text": str(r0[c])}, {"src": f"fact:ot_b_{c.lower()}", "text": str(r1[c])}]
        out.append({"code": c, "a": f"series:{table}/{c}:{y0}:OBS_VALUE", "b": f"series:{table}/{c}:{y1}:OBS_VALUE",
                    "a_rank": f"fact:ot_a_{c.lower()}", "b_rank": f"fact:ot_b_{c.lower()}"})
    rows += [{"src": f"period:{table}:{y0}", "text": y0}, {"src": f"period:{table}:{y1}", "text": y1}]
    rows += [{"src": K.name_row(c, "place"), "text": n} for c, n in names.items()]
    data = {"title": W("占比"), "unit": W("百分比"), "name_kind": "place", "rows": out, "periods": [f"period:{table}:{y0}", f"period:{table}:{y1}"],
            "accent": accent, "footnote": W("名次按各年的值从高到低排")}
    if ref: data["ref"] = ref
    return rows, data, names


def eu(): return build("t", EU, EU_NAMES, "2005", "2024", ["DE", "MT"], "EU27_2020")
def wb(): return build("t", WB, WB_NAMES, "2010", "2022", ["CHN"])


def draw(shape, **style):
    rows, data, names = shape
    K.setup(rows, names, run.tables)
    return rank_slope.draw({"data": data, "style": {"rank_slope": style}})


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


def lines_of(svg):
    """{code: (x1, y1, x2, y2)} of every place's line."""
    return {m.group(5): tuple(float(m.group(i)) for i in range(1, 5)) for m in re.finditer(
        r'<line x1="([0-9.]+)" y1="([0-9.]+)" x2="([0-9.]+)" y2="([0-9.]+)"[^>]*data-code="([A-Z0-9_]+)"', svg)}


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vals = {"eu": EU, "wb": WB}
        cls.out = {"eu": draw(eu()), "wb": draw(wb())}
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            for n, (svg, w, h) in cls.out.items():
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"rank_slope-{n}.svg"), "w", encoding="utf-8") as fh: fh.write(themed(svg, w, h))

    def test_every_digit_is_a_marked_ledger_run(self):
        for n, (svg, _, _) in self.out.items(): self.assertEqual(check_svg(svg), [], n)

    def test_a_place_that_rose_runs_up_one_that_fell_runs_down_and_the_highest_stands_on_top(self):
        for n, vals in self.vals.items():
            ln = lines_of(self.out[n][0])
            self.assertEqual(sorted(ln), sorted(vals), n)
            r0, r1 = ranks(vals, 0), ranks(vals, 1)
            tied = {c for c in vals for d in vals if d != c and (r0[c] == r0[d] or r1[c] == r1[d])}   # a tie keeps a row each: its line may stay level
            for c in vals:
                x1, y1, x2, y2 = ln[c]
                if r1[c] < r0[c] and c not in tied: self.assertLess(y2, y1, (n, c))
                if r1[c] > r0[c] and c not in tied: self.assertGreater(y2, y1, (n, c))
            top = min(ln, key=lambda c: ln[c][1])
            self.assertEqual(r0[top], 1, n)
            self.assertEqual(r1[min(ln, key=lambda c: ln[c][3])], 1, n)

    def test_places_that_tie_share_a_rank_number_and_keep_a_row_each(self):
        svg = self.out["wb"][0]
        ln = lines_of(svg)
        self.assertEqual(ranks(WB, 1)["BRA"], ranks(WB, 1)["IND"])
        self.assertNotEqual(ln["BRA"][3], ln["IND"][3])
        self.assertEqual(len({v[3] for v in ln.values()}), len(WB))

    def test_each_end_prints_the_rank_and_the_name_and_no_line_crosses_a_label(self):
        for n, vals in self.vals.items():
            svg = self.out[n][0]
            for c in vals:
                for side in ("a", "b"): self.assertIn(f'data-src="fact:ot_{side}_{c.lower()}"', svg)
            ln = lines_of(svg)
            x0, x1 = min(v[0] for v in ln.values()), max(v[2] for v in ln.values())
            top, bottom = min(min(v[1], v[3]) for v in ln.values()) - 8, max(max(v[1], v[3]) for v in ln.values()) + 8
            for m in re.finditer(r'<text x="([0-9.]+)" y="([0-9.]+)"[^>]*text-anchor="(start|end)"', svg):
                x, y, anchor = float(m.group(1)), float(m.group(2)), m.group(3)
                if not top <= y <= bottom: continue   # the head, the key and the footnote stand over and under the lines
                # a label stands wholly outside the span the lines cover
                if anchor == "end": self.assertLess(x, x0 + 1, n)
                else: self.assertGreater(x, x1 - 1, (n, x))

    def test_the_accent_lines_over_the_plain_ones_and_the_whole_bold(self):
        svg = self.out["eu"][0]
        for c in ("DE", "MT"): self.assertRegex(svg, rf'<line [^>]*stroke="var\(--accent\)"[^>]*data-code="{c}"')
        self.assertRegex(svg, r'<line [^>]*stroke="var\(--t-title\)"[^>]*data-code="EU27_2020"')
        first_accent = svg.index('stroke="var(--accent)"'); last_plain = svg.rindex('stroke="var(--t-sec)"')
        self.assertLess(last_plain, first_accent)   # drawn first: the plain lines


def dense(n, y0, y1, accent, ref=None):
    """n places with distinct values at both periods whose order differs (test-only values): more rows than the dense line."""
    vals = {f"P{i:02d}": (100.0 - i * 3.1, 50.0 + ((i * 7) % n) * 2.3) for i in range(n)}
    return build("t", vals, {c: f"地{c[1:]}" for c in vals}, y0, y1, accent, ref), vals


class DenseChart(unittest.TestCase):
    """More than DENSE rows: names for the marked rows and the top and the bottom of each column only; the other lines faint."""
    CASES = {"twenty-seven": (27, "2005", "2024", ["P05", "P20"], "P13"), "twenty": (20, "2010", "2022", ["P03"], None)}

    def test_the_middle_lines_fade_and_only_the_marked_and_the_column_ends_are_named(self):
        for name, (n, y0, y1, acc, ref) in self.CASES.items():
            shape, vals = dense(n, y0, y1, acc, ref)
            svg = draw(shape)[0]
            self.assertEqual(check_svg(svg), [], name)
            r0, r1 = ranks(vals, 0), ranks(vals, 1)
            want = set(acc) | ({ref} if ref else set()) | {c for c in vals if r0[c] in (1, n) or r1[c] in (1, n)}
            named = {m.group(1) for m in re.finditer(r'data-src="fact:ot_[ab]_(p\d\d)"', svg)}
            self.assertEqual({c.lower() for c in want}, named, name)
            self.assertLess(len(named), n, name)
            for c in vals:
                op = float(re.search(rf'<line [^>]*stroke-opacity="([0-9.]+)"[^>]*data-code="{c}"', svg).group(1))
                if c in want: self.assertGreaterEqual(op, 0.6, (name, c))
                else: self.assertLessEqual(op, 0.2, (name, c))
            for c in acc: self.assertRegex(svg, rf'<line [^>]*stroke="var\(--accent\)"[^>]*data-code="{c}"')

    def test_a_chart_at_the_line_keeps_every_name(self):
        shape, vals = dense(15, "2005", "2024", ["P02"])
        svg = draw(shape)[0]
        self.assertEqual(len(set(re.findall(r'data-src="fact:ot_a_(p\d\d)"', svg))), 15)
        self.assertNotIn('stroke-opacity="0.18"', svg)


class Rules(unittest.TestCase):
    def refuse(self, want, edit=None, **style):
        rows, data, names = eu()
        if edit: edit(data, rows)
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, want):
            rank_slope.draw({"data": data, "style": {"rank_slope": style}})

    def test_its_refusals(self):
        self.refuse("fewer than 4 rows", lambda d, r: d.__setitem__("rows", d["rows"][:3]))
        self.refuse("come twice", lambda d, r: d["rows"].append(dict(d["rows"][0])))
        self.refuse("are not codes", lambda d, r: d["rows"][0].__setitem__("code", "no good"))
        self.refuse("is not a series of the request", lambda d, r: d["rows"][0].__setitem__("a", "series:t/ZZ:2005:OBS_VALUE"))
        self.refuse("at one period", lambda d, r: d["rows"][0].__setitem__("b", d["rows"][0]["a"]))
        self.refuse("lacks a rank's ledger entry", lambda d, r: d["rows"][0].pop("b_rank"))
        self.refuse("is no whole number", lambda d, r: r.append({"src": "fact:ot_x", "text": "3.5"}) or d["rows"][0].__setitem__("a_rank", "fact:ot_x"))
        self.refuse("is not the rank its cell gives", lambda d, r: [r.__setitem__(i, {**x, "text": "9"}) for i, x in enumerate(r) if x["src"] == "fact:ot_b_se"])
        self.refuse("needs the start and the end period entries", lambda d, r: d.__setitem__("periods", d["periods"][:1]))
        self.refuse("names a period no row's cell has", lambda d, r: d.__setitem__("periods", ["period:t:2005", "period:t:2005"]))
        self.refuse("accent is a list of at most three", lambda d, r: d.__setitem__("accent", ["SE", "FI", "AT", "DE"]))
        self.refuse("no row", lambda d, r: d.__setitem__("accent", ["ZZ"]))
        self.refuse("is no row", lambda d, r: d.__setitem__("ref", "ZZ"))
        self.refuse("a digit", lambda d, r: d.__setitem__("footnote", W("共 9 行")))
        self.refuse("off its range", width=300)

    def test_nobody_overtook_is_refused(self):
        same = {c: (v[0], v[0] * 1.5) for c, v in EU.items()}   # every value scales alike: the order never changes
        rows, data, names = build("t", same, EU_NAMES, "2005", "2024", [])
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, "same rank at both periods"):
            rank_slope.draw({"data": data, "style": {}})

    def test_the_file_holds_no_topic_word(self):
        with open(os.path.join(LEAVES, "rank_slope.py"), encoding="utf-8") as fh: src = fh.read().lower()
        for w in ("gas", "coal", "solar", "wind", "russia", "energy", "oil", "nuclear", "eurostat", "世界银行", "欧盟", "能源"):
            self.assertNotIn(w, src, w)


if __name__ == "__main__":
    unittest.main()
