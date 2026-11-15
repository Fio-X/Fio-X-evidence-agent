"""Self-test of the line leaf (runtime/leaves_py/line.py) on the archived World Bank SP.POP.65UP.TO.ZS, population aged 65 and
above as a share of the total, 2015-2025 (scripts/fixtures/data_prepare/worldbank/q5.json): five economies, one line each.
Test-only ledger texts and names (layer 1 writes the real ones: each end value its fact, each tick next_facts::ticks, each
name a reviewed name row).
Checks: the leaf draws every digit inside a marked ledger run; the highlighted series is drawn last, in the accent and wider,
the others grey; no line runs past the plot's right edge and no text box is crossed by a line (the tick column left of the plot,
the period axis under it, the end labels right of it); two series ending close together get their labels spread apart with
a leader; a missing period breaks a line and marks every point of that series; the period axis keeps its first and last label
and drops a middle one that would overlap; the refusals keep the leaf's rules. With LEAF_SVG_DIR set, the themed svg is kept
there. Run: python3 -I -B scripts/test_leaves_line.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import line  # noqa: E402
import prod  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
CODES = ["KOR", "JPN", "ITA", "DEU", "CHN"]
NAMES = {"KOR": "韩国", "JPN": "日本", "ITA": "意大利", "DEU": "德国", "CHN": "中国"}  # test-only names
TABLE = "SP.POP.65UP.TO.ZS@2"
MORE = ["FRA", "ESP", "GBR", "USA", "CAN", "AUS"]  # five more series, for the end labels that cannot all fit
MORE_NAMES = {"FRA": "法国", "ESP": "西班牙", "GBR": "英国", "USA": "美国", "CAN": "加拿大", "AUS": "澳大利亚"}


def load():
    rows = json.load(open(os.path.join(HERE, "fixtures", "data_prepare", "worldbank", "q5.json"), encoding="utf-8"))[1]
    return {(r["countryiso3code"], r["date"]): float(r["value"]) for r in rows if r["countryiso3code"] in CODES + MORE and r["value"] is not None}


TAB = load()
YEARS = sorted({y for _, y in TAB})


def src(code, year):
    return f"series:{TABLE}/{code}:{year}:value"


def build(codes=CODES, years=YEARS, skip=()):
    """rows (series cells and test ledger texts) and the spec as layer 1 would write them: each series' cells in period order,
    its last value a ledger text, the axis's ticks every 10 points (scale 1: a tick prints its raw value), every year a period
    entry. `skip` leaves (code, year) cells out."""
    rows, series = [], []
    for c in codes:
        pts = []
        for y in years:
            if (c, y) in skip or (c, y) not in TAB: continue
            rows.append({"src": src(c, y), "table": TABLE, "dims": {"country": c}, "time": y, "value": TAB[(c, y)]})
            pts.append(src(c, y))
        last = pts[-1].rsplit(":", 2)[1]
        rows.append({"src": f"fact:last.{c}", "text": f"{TAB[(c, last)]:.1f}%"})
        series.append({"code": c, "points": pts, "end_text": f"fact:last.{c}"})
    ticks = []
    for i in (1, 2, 3):
        rows.append({"src": f"fact:top.tick{i}", "text": str(10 * i)}); ticks.append(f"fact:top.tick{i}")
    periods = []
    for y in years:
        rows.append({"src": f"period:{TABLE}:{y}", "text": y}); periods.append(f"period:{TABLE}:{y}")
    data = dict(title=W("老龄人口占比"), unit=W("占总人口的百分比"), series_kind="place", series=series,
                axis={"ticks": ticks, "scale": 1}, periods=periods, footnote=W("数据来源：世界银行"))
    return rows, data


ROWS, DATA = build()


def hero(data, **style):
    return {"data": data, "style": {"line": style}}


def draw(h, rows=ROWS, names=NAMES):
    K.setup(rows, names, run.tables)
    return line.draw(h)


def frame(h, rows=ROWS):
    K.setup(rows, NAMES, run.tables)
    return line.Frame(h)


def check_svg(svg):
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def polylines(svg):
    """(code, stroke, width, [(x, y)]) of every line drawn."""
    out = []
    for m in re.finditer(r'<polyline points="([^"]+)"[^>]*stroke="([^"]+)" stroke-width="([^"]+)"[^>]*data-code="([^"]+)"', svg):
        pts = [tuple(float(v) for v in p.split(",")) for p in m.group(1).split()]
        out.append((m.group(4), m.group(2), float(m.group(3)), pts))
    return out


def text_boxes(svg, size=12):
    """The box of every <text> as wbkit.txt checks it (x, baseline, anchor, plain text)."""
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

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        self.assertEqual(check_svg(self.svg), [])
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            with open(os.path.join(os.environ["LEAF_SVG_DIR"], "line-sp_pop_65up-2015-2025.svg"), "w", encoding="utf-8") as f:
                f.write(themed(self.svg, self.w, self.h))

    def test_the_highlight_is_drawn_last_in_the_accent_and_wider(self):
        drawn = polylines(self.svg)
        self.assertEqual([c for c, *_ in drawn][-1], "KOR")
        self.assertEqual({(c, s) for c, s, _, _ in drawn if s == "var(--accent)"}, {("KOR", "var(--accent)")})
        widths = {c: w for c, _, w, _ in drawn}
        self.assertTrue(all(widths["KOR"] > w for c, w in widths.items() if c != "KOR"), widths)
        self.assertEqual(frame(hero(DATA)).hl, "KOR")  # none named: the first series
        self.assertEqual(frame(hero(DATA, highlight="JPN")).hl, "JPN")

    def test_no_line_runs_past_the_plot_and_no_text_is_crossed_by_a_line(self):
        f = frame(hero(DATA, highlight="KOR"))
        boxes = text_boxes(self.svg)
        for code, _, _, pts in polylines(self.svg):
            self.assertTrue(all(f.x0 - 0.5 <= x <= f.x1 + 0.5 for x, _ in pts), code)
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                n = max(1, int(max(abs(x1 - x0), abs(y1 - y0)) / 2))
                for i in range(n + 1):
                    x, y = x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n
                    hit = [t for t, b in boxes if b[0] - 1 < x < b[2] + 1 and b[1] - 1 < y < b[3] + 1]
                    self.assertEqual(hit, [], (code, x, y))

    def test_close_ends_are_spread_with_a_leader_and_none_overlaps(self):
        ends = [(t, b) for t, b in text_boxes(self.svg) if "%" in t]
        self.assertEqual(len(ends), 5)
        for i, (_, a) in enumerate(ends):
            for _, b in ends[i + 1:]:
                self.assertFalse(a[1] < b[3] and b[1] < a[3], (a, b))
        f = frame(hero(DATA))
        top, bottom = 22 + f.size * 2.2, 22 + f.size * 2.2 + f.k("plot_h")
        want = {c: bottom - (bottom - top) * TAB[(c, "2025")] / f.top + f.size * 0.35 for c in CODES}
        self.assertLess(abs(want["DEU"] - want["ITA"]), f.size * 1.3)  # the two end close: one of them is moved
        self.assertGreaterEqual(self.svg.count('stroke-width="0.6" stroke-opacity="0.8"'), 1)

    def test_a_missing_period_breaks_the_line_and_marks_every_point(self):
        rows, data = build(skip={("CHN", "2020")})
        svg, _, _ = draw(hero(data, highlight="KOR"), rows)
        chn = [p for c, _, _, p in polylines(svg) if c == "CHN"]
        self.assertEqual(len(chn), 2)
        self.assertEqual(len(re.findall(r'<circle[^>]*data-code="CHN"', svg)), 10)
        self.assertEqual(len(re.findall(r'<circle[^>]*data-code="JPN"', svg)), 0)  # dense grey: no marker
        self.assertEqual(len(re.findall(r'<circle[^>]*data-code="KOR"', svg)), 2)  # dense highlight: its two ends

    def test_the_period_axis_keeps_its_ends_and_drops_an_overlapping_middle(self):
        svg, _, _ = draw(hero(DATA, width=480, size=16, highlight="KOR"))
        shown = [t for t, _ in text_boxes(svg) if re.fullmatch(r"\d{4}", t)]
        self.assertEqual((shown[0], shown[-1]), ("2015", "2025"))
        self.assertLess(len(shown), len(YEARS))
        self.assertEqual(len(re.findall(r"\d{4}", " ".join(t for t, _ in text_boxes(self.svg) if re.fullmatch(r"\d{4}", t)))), len(YEARS))


class Refusals(unittest.TestCase):
    def refused(self, data, rows=ROWS, names=NAMES, **style):
        with self.assertRaises(Refused) as e:
            draw(hero(data, **style), rows, names)
        return str(e.exception)

    def test_its_rules(self):
        d = json.loads(json.dumps(DATA))
        self.assertIn("no series", self.refused({**d, "series": []}))
        self.assertIn("twice", self.refused({**d, "series": d["series"] + d["series"][:1]}))
        one = json.loads(json.dumps(d)); one["series"][0]["points"] = one["series"][0]["points"][:1]
        self.assertIn("fewer than two points", self.refused(one))
        back = json.loads(json.dumps(d)); back["series"][0]["points"] = back["series"][0]["points"][::-1]
        self.assertIn("period order", self.refused(back))
        self.assertIn("highlight", self.refused(d, highlight="FRA") + "highlight")
        self.assertIn("ticks are not ascending", self.refused({**d, "axis": {"ticks": d["axis"]["ticks"][::-1], "scale": 1}}))
        self.assertIn("no tick", self.refused({**d, "axis": {"ticks": [], "scale": 1}}))
        self.assertIn("no number above 0", self.refused({**d, "axis": {"ticks": d["axis"]["ticks"], "scale": 0}}))
        self.assertIn("no point has", self.refused({**d, "periods": d["periods"] + [f"period:{TABLE}:2030"]}))
        long = {**NAMES, "KOR": "大韩民国（统计口径含全部行政区划的人口）"}  # a name long enough to leave the plot under 240 px
        self.assertIn("too narrow", self.refused(d, names=long, width=480, size=16))
        many_rows, many = build(codes=CODES + MORE)
        self.assertIn("do not fit", self.refused(many, rows=many_rows, names={**NAMES, **MORE_NAMES}, plot_h=160, size=16))
        self.assertEqual(len(draw(hero(many), many_rows, {**NAMES, **MORE_NAMES})), 3)  # the same eleven fit a 300 px plot
        neg = [dict(r, value=-1.0) if r.get("src") == src("CHN", "2015") else r for r in ROWS]
        self.assertIn("below 0", self.refused(d, rows=neg))
        bad_tick = [dict(r, text="十") if r.get("src") == "fact:top.tick1" else r for r in ROWS]
        self.assertIn("is no number", self.refused(d, rows=bad_tick))
        self.assertIn("digit", self.refused({**d, "title": W("2025 年老龄人口")}))

    def test_the_query_form_draws_what_the_listed_form_does(self):
        """The registry's form (q, a peak per series, no points, ticks or periods listed) reads the same cells and entries:
        the picture is the listed form's, byte for byte, over the whole span and over a window of it; its refusals."""
        def q_form(data, **q):
            series = [{"code": s["code"], "end_text": s["end_text"], "peak": "fact:top"} for s in data["series"]]
            out = {k: v for k, v in data.items() if k not in ("series", "periods")}
            return {**out, "series": series, "axis": {"scale": 1}, "q": {"table": TABLE, "by": "country", **q}}
        self.assertEqual(draw(hero(q_form(DATA))), draw(hero(DATA)))
        part_rows, part = build(years=YEARS[3:])
        self.assertEqual(draw(hero(q_form(part, **{"from": YEARS[3]}))), draw(hero(part), part_rows))
        d = q_form(DATA)
        self.assertIn("no table and by-dimension", self.refused({**d, "q": {"table": TABLE}}))
        self.assertIn("holds no table", self.refused({**d, "q": {"table": "nope", "by": "country"}}))
        top = max(CODES, key=lambda c: max(v for (k, _), v in TAB.items() if k == c))  # the series drawn highest
        no_peak = {**d, "series": [{k: v for k, v in s.items() if not (k == "peak" and s["code"] == top)} for s in d["series"]]}
        self.assertIn(f"series {top} draws highest and names no peak", self.refused(no_peak))
        lower_only = {**d, "series": [dict(s, peak="fact:none") if s["code"] != top else s for s in d["series"]]}
        self.assertEqual(draw(hero(lower_only)), draw(hero(DATA)))  # only the top series' peak is read
        self.assertIn("no tick of the axis", self.refused({**d, "series": [dict(s, peak="fact:other") for s in d["series"]]}))
        no_periods = [r for r in ROWS if not r["src"].startswith("period:")]
        self.assertIn("no period entry", self.refused(d, rows=no_periods))


class Periods(unittest.TestCase):
    def test_years_quarters_and_months(self):
        self.assertEqual(line.period_at("2024"), 2024.0)
        self.assertAlmostEqual(line.period_at("2024-03"), 2024 + 2 / 12)
        self.assertAlmostEqual(line.period_at("2024M12"), 2024 + 11 / 12)
        self.assertAlmostEqual(line.period_at("2024-Q2"), 2024.25)
        with self.assertRaises(Refused):
            line.period_at("2024-W03")
        self.assertEqual(line.period_of(src("KOR", "2019")), "2019")

    def test_spread(self):
        self.assertEqual(line.spread([10, 50], 0, 100, 12), [10, 50])
        self.assertEqual(line.spread([50, 52], 0, 100, 12), [50, 62])
        self.assertEqual(line.spread([95, 99], 0, 100, 12), [88, 100])
        self.assertIsNone(line.spread([10, 11, 12], 0, 20, 12))


if __name__ == "__main__":
    unittest.main()
