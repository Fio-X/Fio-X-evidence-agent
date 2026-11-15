"""Self-test of the rankbar leaf (runtime/leaves_py/rankbar.py) and of the column page's leaf layers (run.py LEAF_LAYERS):
a real ranking shape (scripts/fixtures/data_prepare/nrg_rank.csv, gross inland consumption by country, top 10 and the other
row; test-only ledger texts, the first layer writes the real ones; names from the project's reviewed zh names). Each svg
reads back with no `bad`, every digit sits inside a marked ledger run, and the refusals keep the leaf's rules. With
LEAF_SVG_DIR set the themed svgs are kept there; else they go to a temporary folder that is removed.
Run: python3 -I -B scripts/test_leaves_rankbar.py"""
import csv
import json
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
import prod  # noqa: E402
import rankbar  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

ASSETS = os.path.join(HERE, "..", "runtime", "pi", "assets")
ZH2 = {e["iso2"]: e["zh"] for e in json.load(open(os.path.join(ASSETS, "economy-names.json"), encoding="utf-8"))["economies"]}
ZH2["EL"] = ZH2["GR"]
W = lambda t: [{"w": t}]
fmt = lambda v: f"{v:,.0f}"


def series(key, v):
    return {"src": f"series:T/{key}:2023:OBS_VALUE", "table": "T", "dims": {"k": key}, "time": "2023", "value": v}


def check_svg(svg):
    """What is wrong with a drawn svg: texts the read-back cannot place, none at all, a digit outside a marked ledger run."""
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def themed(svg, w, h):
    css = ("<style>svg{--accent:#c93f2b;--t-title:#292928;--t-dark:#1f1e1d;--t-body:#4d4d4d;--t-sec:#707070;--bar:#d4d4d4;"
           "--empty:#e5e5e5;--bg:#fff;" + K.page_vars("#c93f2b") + "}</style>")
    return svg.replace(">", f">{css}<rect width='{w}' height='{h}' fill='#fff'/>", 1)


rows_in = [x for x in csv.DictReader(open(os.path.join(HERE, "fixtures", "data_prepare", "nrg_rank.csv"), encoding="utf-8"))
           if x["geo"] in ZH2 and x["OBS_VALUE"]]
TOT = {x["geo"]: float(x["OBS_VALUE"]) for x in rows_in}
GEOS = sorted(TOT, key=lambda g: -TOT[g])
GRAND = sum(TOT.values())
ROWS, ITEMS = [], []
for g in GEOS:
    ROWS += [series(g, TOT[g]), {"src": f"fact:v.{g}", "text": fmt(TOT[g])}, {"src": f"fact:s.{g}", "text": f"{TOT[g] / GRAND * 100:.1f}%"}]
    ITEMS.append(dict(code=g, value=f"series:T/{g}:2023:OBS_VALUE", value_text=f"fact:v.{g}", share_text=f"fact:s.{g}"))
REST = sum(TOT[g] for g in GEOS[10:])
ROWS += [series("rest", REST), {"src": "fact:v.rest", "text": fmt(REST)}, {"src": "fact:s.rest", "text": f"{REST / GRAND * 100:.1f}%"}]
DATA = dict(title=W("各国一次能源消费"), unit=W("太焦"), share_head=W("占比"), rows=ITEMS,
            other_row=dict(name=W("其他国家"), value="series:T/rest:2023:OBS_VALUE", value_text="fact:v.rest", share_text="fact:s.rest"))
LABELS = {g: ZH2[g] for g in GEOS}
NO_OTHER = {k: v for k, v in DATA.items() if k != "other_row"}


def hero(data, **style):
    return {"data": data, "style": {"rankbar": style}}


def draw(h, rows=ROWS, labels=LABELS):
    K.setup(rows, labels, run.tables)
    return rankbar.draw(h)


def mod_rows(fn):
    return [fn(r) if r["src"].startswith("series:") else r for r in ROWS]


class Rankbar(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = None if os.environ.get("LEAF_SVG_DIR") else tempfile.TemporaryDirectory(prefix="leaf-svg-")
        cls.out = os.environ.get("LEAF_SVG_DIR") or cls.tmp.name

    @classmethod
    def tearDownClass(cls):
        if cls.tmp: cls.tmp.cleanup()

    def good(self, tag, h):
        svg, w, ht = draw(h)
        with open(os.path.join(self.out, f"{tag}.svg"), "w", encoding="utf-8") as f:
            f.write(themed(svg, w, ht))
        self.assertEqual(check_svg(svg), [], tag)
        return svg

    def test_the_top_ten_and_the_other_row_draw(self):
        svg = self.good("rankbar-top10", hero(DATA, max_rows=10, highlight_row=GEOS[0]))
        self.assertEqual(svg.count("<rect"), 11)
        self.assertEqual(svg.count('fill="var(--accent)"'), 1)

    def test_every_row_draws_without_the_share_column(self):
        self.assertEqual(self.good("rankbar-all", hero(NO_OTHER, show_share="off")).count("<rect"), len(GEOS))

    def test_the_refusals(self):
        for tag, h, rows, labels, why in [
            ("knob-not-codes", hero(DATA, highlight_row='x"/><script>'), ROWS, LABELS, "comma list of codes"),
            ("unknown-highlight", hero(DATA, highlight_row="ZZ"), ROWS, LABELS, "codes the request does not hold"),
            ("no-other-row", hero(NO_OTHER, max_rows=10), ROWS, LABELS, "other_row"),
            ("other-sum-differs", hero(DATA, max_rows=10), mod_rows(lambda x: dict(x, value=x["value"] * 2) if "/rest:" in x["src"] else x),
             LABELS, "not the merged rows' sum"),
            ("no-share", hero(dict(DATA, rows=[dict(ITEMS[0], share_text=None)] + ITEMS[1:])), ROWS, LABELS, "no share_text"),
            ("negative", hero(DATA), mod_rows(lambda x: dict(x, value=-1.0) if f"/{GEOS[0]}:" in x["src"] else x), LABELS, "negative"),
            ("too-narrow", hero(DATA, width=240), ROWS, LABELS, "too narrow"),
            ("no-name", hero(DATA), ROWS, {k: v for k, v in LABELS.items() if k != GEOS[0]}, GEOS[0]),
            ("colour-knob-gone", hero(DATA, bar_fill="#123456"), ROWS, LABELS, "no knob"),
            ("title-as-string", hero(dict(DATA, title="fact:v.rest")), ROWS, LABELS, "given as a ledger source"),
            ("digit-in-literal", hero(dict(DATA, title=W("2023 年"))), ROWS, LABELS, "hold a digit"),
            ("no-rows", hero(dict(DATA, rows=[])), ROWS, LABELS, "no rows"),
        ]:
            with self.subTest(tag), self.assertRaises(Refused) as e:
                draw(h, rows, labels)
            self.assertIn(why, str(e.exception), tag)


class ColumnLeafLayers(unittest.TestCase):
    """run.py draws a chart leaf as a column page's layer: its data is the hero's leaves.<name>, its knobs the hero's style."""
    class Frame:
        def __init__(f, h):
            f.h = h

    def test_a_leaf_layer_draws_from_the_heros_leaves_entry(self):
        K.setup(ROWS, LABELS, run.tables)
        layers, svgs = run.KINDS["column"]
        self.assertEqual(list(layers), ["bignums", "bars", "section_head", "rankbar", "bubbles", "bubble_key", "leader_notes", "sankey", "stacked100", "line", "rank_lines", "dumbbell"])
        self.assertTrue({"bars", "section_head", "rankbar", "bubbles", "bubble_key", "leader_notes"} <= set(svgs))
        draw_, reserve = layers["rankbar"]
        self.assertIsNone(reserve)
        inner = draw_(self.Frame({"leaves": {"rankbar": DATA}, "style": {"rankbar": {"max_rows": 10}}}), prod.Occ())
        self.assertEqual(inner.count("<rect"), 11)
        self.assertEqual(check_svg(K.svg(inner, 1140, 400, "rankbar")), [])

    def test_a_hero_without_the_entry_or_a_ledger_refuses(self):
        K.setup(ROWS, LABELS, run.tables)
        draw_ = run.KINDS["column"][0]["rankbar"][0]
        with self.assertRaises(Refused) as e:
            draw_(self.Frame({"leaves": {"section_head": {}}}), prod.Occ())
        self.assertIn("names no leaves.rankbar", str(e.exception))
        saved, K.FX.LEDGER = K.FX.LEDGER, None
        try:
            with self.assertRaises(Refused) as e:
                draw_(self.Frame({"leaves": {"rankbar": DATA}}), prod.Occ())
            self.assertIn("from a ledger only", str(e.exception))
        finally:
            K.FX.LEDGER = saved


if __name__ == "__main__":
    unittest.main()
