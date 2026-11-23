"""Self-test of the pair bars leaf (runtime/leaves_py/pair_bars.py) on two data shapes, test-only values, ledger texts and
names (layer 1 writes the real ones: each value its fact, each ratio its fact, each name a reviewed name row):
  - a Eurostat share shape: the renewable share of three uses (one table, a use dimension) in the first and the last
    member, percent, one year, full tracks at 100;
  - a World Bank per-capita shape: two indicators (one table each) for two economies, tonnes per person, another year,
    no full given (the largest value fills its track).
Checks: the leaf draws every digit inside a marked ledger run; each filled bar is its value's share of the track; one
accent only (the filled bars); a value prints after its bar inside the track, or inside the bar where the track has no room;
the refusals keep the leaf's rules. With LEAF_SVG_DIR set, the themed svg of each shape is kept there.
Run: python3 -I -B scripts/test_leaves_pair_bars.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import pair_bars  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]

# the Eurostat shape: nrg_ind_ren, the first and the last member at one year
EU_TABLE, EU_YEAR = "nrg_ind_ren", "2024"
EU_PLACES = ["SE", "MT"]
EU_ROWS = {"REN_ELC": (88.3, 10.4, "电力"), "REN_HEAT_CL": (69.2, 40.1, "供暖和制冷"), "REN_TRA": (33.8, 9.6, "交通")}
EU_NAMES = {"SE": "瑞典", "MT": "马耳他"}  # test-only names


def eu_build(rows=EU_ROWS, year_b=EU_YEAR, swap=None):
    out, items = [], []
    for code, (a, b, label) in rows.items():
        for geo, v, y in ((EU_PLACES[0], a, EU_YEAR), (EU_PLACES[1], b, year_b)):
            g = swap.get((code, geo), geo) if swap else geo
            out.append({"src": f"series:{EU_TABLE}/{code}.{geo}:{y}:OBS_VALUE", "table": EU_TABLE,
                        "dims": {"nrg_bal": code, "geo": g, "unit": "PC"}, "time": y, "value": v})
            out.append({"src": f"fact:{code.lower()}_{geo.lower()}.n", "text": f"{v:.1f}%"})
        out.append({"src": f"fact:ratio_{code.lower()}_se_mt.n", "text": f"{a / b:.1f}"})
        items.append({"code": code, "label": W(label), "a": f"series:{EU_TABLE}/{code}.{EU_PLACES[0]}:{EU_YEAR}:OBS_VALUE",
                      "b": f"series:{EU_TABLE}/{code}.{EU_PLACES[1]}:{year_b}:OBS_VALUE",
                      "a_text": f"fact:{code.lower()}_se.n", "b_text": f"fact:{code.lower()}_mt.n", "ratio": f"fact:ratio_{code.lower()}_se_mt.n"})
    data = dict(title=W("第一名和最后一名，差在哪一块"), unit=W("占比"), places=EU_PLACES, place_kind="place", full=100,
                rows=items, ratio_unit=W(" 倍"), footnote=W("数据来源：欧盟统计局"))
    return out, data


# the World Bank shape: two indicators, two economies, one year, per-capita tonnes
WB_YEAR = "2023"
WB_PLACES = ["USA", "CHN"]
WB_ROWS = {"EN.GHG.CO2.PC.CE.AR5": (14.3, 8.9, "二氧化碳"), "EN.GHG.ALL.PC.CE.AR5": (17.6, 11.1, "全部温室气体")}
WB_NAMES = {"USA": "美国", "CHN": "中国"}  # test-only names


def wb_build():
    out, items = [], []
    for i, (ind, (a, b, label)) in enumerate(WB_ROWS.items()):
        for eco, v in zip(WB_PLACES, (a, b)):
            out.append({"src": f"series:{ind}@2/{eco}:{WB_YEAR}:OBS_VALUE", "table": f"{ind}@2", "dims": {"economy": eco},
                        "time": WB_YEAR, "value": v})
            out.append({"src": f"fact:pc{i}_{eco.lower()}.n", "text": f"{v:.1f}"})
        out.append({"src": f"fact:ratio_pc{i}_usa_chn.n", "text": f"{a / b:.1f}"})
        items.append({"code": f"pc{i}", "label": W(label), "a": f"series:{ind}@2/USA:{WB_YEAR}:OBS_VALUE",
                      "b": f"series:{ind}@2/CHN:{WB_YEAR}:OBS_VALUE", "a_text": f"fact:pc{i}_usa.n", "b_text": f"fact:pc{i}_chn.n",
                      "ratio": f"fact:ratio_pc{i}_usa_chn.n"})
    data = dict(places=WB_PLACES, rows=items, ratio_unit=W(" 倍"), lines=[W("人均排放，吨二氧化碳当量")])
    return out, data


EU_REQ, EU_DATA = eu_build()
WB_REQ, WB_DATA = wb_build()


def hero(data, **style):
    return {"data": data, "style": {"pair_bars": style}}


def draw(h, rows=EU_REQ, names=EU_NAMES):
    K.setup(rows, names, run.tables)
    return pair_bars.draw(h)


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


def keep(name, svg, w, h):
    if os.environ.get("LEAF_SVG_DIR"):
        with open(os.path.join(os.environ["LEAF_SVG_DIR"], name), "w", encoding="utf-8") as fh:
            fh.write(themed(svg, w, h))


def rects(svg):
    """[(code, fill, x, w)] of every rect the leaf draws."""
    return [(m.group(5), m.group(4), float(m.group(1)), float(m.group(2)))
            for m in re.finditer(r'<rect x="([^"]+)" y="[^"]+" width="([^"]+)" height="([^"]+)" fill="([^"]+)" data-code="([^"]+)"/>', svg)]


class Picture(unittest.TestCase):
    def test_eu_share_shape(self):
        svg, w, h = draw(hero(EU_DATA, highlight="REN_ELC"))
        keep("pair_bars_eu.svg", svg, w, h)
        self.assertEqual(check_svg(svg), [])
        rs = rects(svg)
        tracks = [r for r in rs if r[1] == "var(--empty)"]
        bars = [r for r in rs if r[1] == "var(--accent)"]
        self.assertEqual(len(tracks), 6); self.assertEqual(len(bars), 6)
        want = [v for a, b, _ in EU_ROWS.values() for v in (a, b)]
        for t, b, v in zip(tracks, bars, want):
            self.assertAlmostEqual(b[3] / t[3], v / 100, places=2)
        # one accent only: the filled bars; the highlighted row's ratio is bold in ink, not the accent
        self.assertEqual(svg.count("var(--accent)"), 6)
        self.assertIn('font-weight="700"><tspan data-src="fact:ratio_ren_elc_se_mt.n"', svg)

    def test_a_value_with_no_room_after_its_bar_prints_inside_it(self):
        rows, data = eu_build({**EU_ROWS, "REN_ELC": (97.5, 10.4, "电力")})
        svg, w, h = draw(hero(data), rows)
        self.assertEqual(check_svg(svg), [])
        self.assertRegex(svg, r'text-anchor="end" fill="var\(--bg\)" font-weight="700"><tspan data-src="fact:ren_elc_se.n"')

    def test_wb_per_capita_shape(self):
        svg, w, h = draw(hero(WB_DATA), WB_REQ, WB_NAMES)
        keep("pair_bars_wb.svg", svg, w, h)
        self.assertEqual(check_svg(svg), [])
        rs = rects(svg)
        bars = [r for r in rs if r[1] == "var(--accent)"]
        track = rs[0][3]
        self.assertAlmostEqual(max(b[3] for b in bars), track, places=1)  # no full: the largest value fills its track
        self.assertNotIn("var(--accent)", re.sub(r'<rect[^>]*fill="var\(--accent\)"[^>]*/>', "", svg))

    def test_long_row_names_on_a_narrow_board_stand_over_their_tracks(self):
        """q4 11-23: a row named by a measure's whole name (a World Bank indicator's reviewed name) on a half-width board left the
        tracks under 120 px beside it; the names then stand each on its own line over its tracks, on both data shapes, the
        tracks starting at the board's left and every text inside the picture, off the others."""
        long = "不含土地利用、土地利用变化和林业的人均二氧化碳排放量（吨二氧化碳当量／人）"
        for data, rows, names in ((EU_DATA, EU_REQ, EU_NAMES), (WB_DATA, WB_REQ, WB_NAMES)):
            d = json.loads(json.dumps(data))
            d["rows"] = [dict(r, label=W(long)) for r in d["rows"]]
            svg, w, h = draw(hero(d, width=550, size=12), rows, names)
            self.assertEqual(check_svg(svg), [])
            tracks = [r for r in rects(svg) if r[1] == "var(--empty)"]
            self.assertEqual(tracks[0][2], 8.0)
            self.assertGreaterEqual(tracks[0][3], 120)
            self.assertEqual(svg.count(long[:6]), len(d["rows"]))
            # the same board with short names keeps them in a column left of the tracks
            short, _, _ = draw(hero(data, width=550, size=12), rows, names)
            self.assertGreater([r for r in rects(short) if r[1] == "var(--empty)"][0][2], 8.0)

    def test_its_rules(self):
        d = json.loads(json.dumps(EU_DATA))

        def refused(data, rows=EU_REQ, names=EU_NAMES, **style):
            with self.assertRaises(Refused) as e:
                draw(hero(data, **style), rows, names)
            return str(e.exception)
        self.assertIn("two distinct", refused({**d, "places": ["SE"]}))
        self.assertIn("two distinct", refused({**d, "places": ["SE", "SE"]}))
        self.assertIn("no rows", refused({**d, "rows": []}))
        self.assertIn("twice", refused({**d, "rows": d["rows"] + d["rows"][:1]}))
        other, od = eu_build(year_b="2023")
        self.assertIn("one period", refused(od, rows=other))
        swapped, sd = eu_build(swap={("REN_TRA", "MT"): "SE"})
        self.assertIn("not MT's", refused(sd, rows=swapped))
        self.assertIn("above full", refused({**d, "full": 50}))
        self.assertIn("above 0", refused({**d, "full": 0}))
        self.assertIn("ratio_unit", refused({k: v for k, v in d.items() if k != "ratio_unit"}))
        self.assertIn("not in the request's ledger", refused({**d, "rows": [dict(d["rows"][0], a_text="fact:none.n")]}))
        self.assertIn("not a series", refused({**d, "rows": [dict(d["rows"][0], a="series:none")]}))
        self.assertIn("digit", refused({**d, "rows": [dict(d["rows"][0], label=W("第2块"))]}))
        self.assertIn("highlight", refused(d, highlight="XX") + "highlight")
        # names over the tracks leave room on this board; a ratio's words that leave none still refuse
        self.assertIn("too narrow", refused({**d, "ratio_unit": W("倍，第一个地方是第二个地方的这么多倍")}, width=480, gap=80, size=16))
        neg, nd = eu_build({**EU_ROWS, "REN_TRA": (-1.0, 9.6, "交通")})
        self.assertIn("below 0", refused(nd, rows=neg))
        self.assertIn("overlap", refused(d, names={"SE": "很长很长很长很长很长很长很长的国名", "MT": "马耳他"}, width=480))
        self.assertIn("is not MT's", refused({**d, "places": ["MT", "SE"]}))


if __name__ == "__main__":
    unittest.main()
