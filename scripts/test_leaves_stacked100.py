"""Self-test of the 100% stacked bar leaf (runtime/leaves_py/stacked100.py) on the archived Eurostat nrg_bal_peh, gross electricity
production 2024, GWH (scripts/fixtures/data_prepare/nrg_bal_peh_GEP_2024.tsv: DE and EU27_2020 by fuel), its leaves in the four
groups estat-parts.tsv registers. Test-only ledger texts and names (layer 1 writes the real ones: each part's share is its
fact, each name a reviewed name row).
Checks: each bar's leaf cells laid end to end reach its TOTAL row; the leaf draws every digit inside a marked ledger run; the
highlighted part goes first in the accent and the others never share a neighbour's grey; a part whose cells are all 0 draws no
segment and goes back to layer 1 as dropped, and so does a part named empty; the last segment ends exactly at the 100% end; the
places left out are named under the picture in the order given; the in-bar shares print only where they fit; the refusals keep
the leaf's rules. With LEAF_SVG_DIR set, the themed svg is kept there. Run: python3 -I -B scripts/test_leaves_stacked100.py"""
import copy
import csv
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import prod  # noqa: E402
import run  # noqa: E402
import stacked100  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
GEOS = ["DE", "EU27_2020"]
NAMES = {"DE": "德国", "EU27_2020": "欧盟", "FR": "法国", "PL": "波兰",  # test-only names (layer 1 sends the reviewed ones)
         "fossil": "化石燃料", "renewable": "可再生能源", "other": "其他", "nuclear": "核能"}


def load():
    tab = {}
    path = os.path.join(HERE, "fixtures", "data_prepare", "nrg_bal_peh_GEP_2024.tsv")
    for r in csv.DictReader((l for l in open(path, encoding="utf-8") if not l.startswith("#")), delimiter="\t"):
        tab[(r["geo"], r["siec"])] = float(r["value"])
    return tab


def groups():
    """The registered groups of nrg_bal_peh's siec leaves, in the order the file first names each (next_params composition_groups)."""
    out = {}
    path = os.path.join(HERE, "..", "runtime", "pi", "assets", "estat-parts.tsv")
    for r in csv.DictReader(open(path, encoding="utf-8"), delimiter="\t"):
        if r["tables"] == "nrg_bal_peh" and r["dim"] == "siec" and r["level"] == "leaf":
            out.setdefault(r["group_en"], []).append(r["code"])
    return out


TAB, GROUPS = load(), groups()
PARTS = list(GROUPS)


def src(geo, code):
    return f"series:T/{geo}.{code}:2024:OBS_VALUE"


def build(geos=GEOS):
    """rows (series cells and test ledger texts) and the spec as layer 1 would write them: each bar's held leaf cells by part, its
    TOTAL row, each drawn part's share a ledger text (here formatted by the test; layer 1's fact on a page)."""
    rows, bars = [], []
    for g in geos:
        cells, share = {}, {}
        rows.append({"src": src(g, "TOTAL"), "table": "T", "dims": {"geo": g, "siec": "TOTAL"}, "time": "2024", "value": TAB[(g, "TOTAL")]})
        for p, leaves in GROUPS.items():
            held = [c for c in leaves if (g, c) in TAB]
            for c in held:
                rows.append({"src": src(g, c), "table": "T", "dims": {"geo": g, "siec": c}, "time": "2024", "value": TAB[(g, c)]})
            cells[p] = [src(g, c) for c in held]
            v = sum(TAB[(g, c)] for c in held)
            if v > 0:
                rows.append({"src": f"fact:share.{g}.{p}", "text": f"{100 * v / TAB[(g, 'TOTAL')]:.1f}%"}); share[p] = f"fact:share.{g}.{p}"
        bars.append({"code": g, "total": src(g, "TOTAL"), "cells": cells, "share_text": share})
    data = dict(title=W("各国发电结构"), unit=W("占发电量的比例"), bar_kind="place", part_kind="siec_group", parts=PARTS, bars=bars,
                others={"head": W("另有："), "codes": ["FR", "PL"]})
    return rows, data


ROWS, DATA = build()


def hero(data, **style):
    return {"data": data, "style": {"stacked100": style}}


def draw(h, rows=ROWS):
    K.setup(rows, NAMES, run.tables)
    return stacked100.draw(h)


def frame(h, rows=ROWS):
    K.setup(rows, NAMES, run.tables)
    return stacked100.Frame(h)


def check_svg(svg):
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def themed(svg, w, h):
    css = ("<style>svg{--accent:#c93f2b;--t-title:#292928;--t-dark:#1f1e1d;--t-body:#4d4d4d;--t-sec:#707070;--bar:#c9c9c9;--empty:#e5e5e5;--bg:#fff;"
           + K.page_vars("#c93f2b") + "}</style>")
    return svg.replace(">", f">{css}<rect width='{w}' height='{h}' fill='#fff'/>", 1)


class TableConservation(unittest.TestCase):
    """The archived table's own identity, independent of the leaf: the four groups' leaves sum to TOTAL (DE exactly, EU27_2020
    within 1e-5 of its total: its aggregate rows are rounded)."""
    def test_the_groups_add_up_to_the_total(self):
        self.assertEqual([(p, len(c)) for p, c in GROUPS.items()], [("fossil", 40), ("renewable", 18), ("other", 7), ("nuclear", 1)])
        for g in GEOS:
            total = TAB[(g, "TOTAL")]
            parts = [sum(TAB.get((g, c), 0.0) for c in GROUPS[p]) for p in PARTS]
            self.assertLessEqual(abs(sum(parts) - total), 1e-5 * total, (g, parts, total))


class Picture(unittest.TestCase):
    def setUp(self):
        self.svg, self.w, self.h = draw(hero(DATA))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        self.assertEqual(check_svg(self.svg), [])
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            with open(os.path.join(os.environ["LEAF_SVG_DIR"], "stacked100-nrg_bal_peh-2024.svg"), "w", encoding="utf-8") as f:
                f.write(themed(self.svg, self.w, self.h))

    def test_the_highlight_goes_first_in_the_accent_and_no_two_neighbours_share_a_grey(self):
        f = frame(hero(DATA, highlight="renewable"))
        self.assertEqual(f.order, ["renewable", "fossil", "other", "nuclear"])
        self.assertEqual(f.fill["renewable"], "var(--accent)")
        fills = [f.fill[p] for p in f.order]
        self.assertTrue(all(a != b for a, b in zip(fills, fills[1:])), fills)
        self.assertEqual(frame(hero(DATA)).order, PARTS)  # none named: the first part
        segs = re.findall(r'fill="([^"]+)" stroke="var\(--bg\)" stroke-width="1" data-part="DE:([a-z]+)"', draw(hero(DATA, highlight="renewable"))[0])
        self.assertEqual([p for _, p in segs], ["renewable", "fossil", "other"])
        self.assertEqual(segs[0][0], "var(--accent)")

    def test_a_zero_part_draws_no_segment_and_goes_back_to_layer_1_as_dropped(self):
        # nuclear heat has a row of 0 for DE in 2024: its part draws no segment and is said, never left out unsaid
        self.assertEqual(TAB[("DE", "N900H")], 0.0)
        self.assertEqual(frame(hero(DATA)).dropped, [("DE:nuclear", "zero")])
        self.assertNotIn('data-part="DE:nuclear"', self.svg)
        self.assertIn('data-part="EU27_2020:nuclear"', self.svg)

    def test_the_last_segment_ends_exactly_at_the_100_percent_end_and_each_bar_reaches_its_total(self):
        f = frame(hero(DATA))
        for r in f.rows:
            self.assertLessEqual(abs(r["segs"][-1][2] - 1.0), 1e-5, r["code"])
        for g in GEOS:
            ends = [float(x) + float(w) for x, w in re.findall(rf'<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="18" fill="[^"]+" stroke="var\(--bg\)" stroke-width="1" data-part="{g}:', self.svg)]
            self.assertAlmostEqual(max(ends), f.x1, places=1)

    def test_the_highlighted_share_is_printed_in_a_column_and_the_left_out_places_under_the_picture(self):
        got, _ = run.drawn(self.svg)
        srcs = [g["src"] for g in got if g["src"]]
        self.assertEqual([s for s in srcs if s.startswith("fact:share")], ["fact:share.DE.fossil", "fact:share.EU27_2020.fossil"])
        texts = [g["text"] for g in got]
        self.assertTrue(any(t.startswith("另有：法国") and "波兰" in t for t in texts), texts)
        self.assertLess(texts.index(next(t for t in texts if "法国" in t)), len(texts))

    def test_in_bar_shares_print_only_where_they_fit(self):
        svg, _, _ = draw(hero(DATA, values="in_bar"))
        self.assertEqual(check_svg(svg), [])
        got = [g["src"] for g in run.drawn(svg)[0] if g["src"] and g["src"].startswith("fact:share")]
        self.assertIn("fact:share.DE.renewable", got)
        self.assertNotIn("fact:share.DE.other", got)  # under 3% of the bar: no room inside its segment

    def test_a_part_named_empty_draws_nothing_and_is_dropped(self):
        data = copy.deepcopy(DATA)
        del data["bars"][0]["cells"]["nuclear"]
        data["empty"] = [{"bar": "DE", "part": "nuclear"}]
        self.assertEqual(frame(hero(data)).dropped, [("DE:nuclear", "no row")])
        self.assertEqual(draw(hero(data))[0], self.svg)


class Refusals(unittest.TestCase):
    def one(self, mutate, regex, **style):
        data, rows = copy.deepcopy(DATA), copy.deepcopy(ROWS); mutate(data, rows)
        with self.assertRaisesRegex(Refused, regex): draw(hero(data, **style), rows)

    def test_cells_that_do_not_reach_the_total(self):
        self.one(lambda d, rows: d["bars"][0]["cells"]["fossil"].pop(), "cells end at")
        self.one(lambda d, rows: d["bars"][1]["cells"]["fossil"].append(d["bars"][1]["cells"]["fossil"][0]), "cells end at")

    def test_a_negative_cell_or_a_total_of_zero(self):
        def neg(d, rows):
            for r in rows:
                if r.get("src") == d["bars"][0]["cells"]["fossil"][0]: r["value"] = -1.0
        self.one(neg, "negative")
        def zero(d, rows):
            for r in rows:
                if r.get("src") == d["bars"][0]["total"]: r["value"] = 0.0
        self.one(zero, "total above zero")

    def test_a_drawn_part_with_no_share_text(self):
        self.one(lambda d, rows: d["bars"][0]["share_text"].pop("fossil"), "no share_text")

    def test_a_part_with_no_cells_that_is_not_named_empty(self):
        self.one(lambda d, rows: d["bars"][0]["cells"].pop("other"), "no cells of part other")
        self.one(lambda d, rows: d.update(empty=[{"bar": "DE", "part": "fossil"}]), "which has cells")

    def test_parts_and_bars_that_are_not_lists_of_distinct_codes(self):
        self.one(lambda d, rows: d.update(parts=["fossil"]), "two parts or more")
        self.one(lambda d, rows: d.update(parts=PARTS + ["fossil"]), "twice")
        self.one(lambda d, rows: d["bars"].append(copy.deepcopy(d["bars"][0])), "twice")
        self.one(lambda d, rows: d["bars"][0]["cells"].update(coal=[]), "no parts")
        self.one(lambda d, rows: d.update(bars=[]), "no bars")

    def test_a_highlight_that_is_no_part(self):
        self.one(lambda d, rows: None, "codes the request does not hold", highlight="coal")
        self.one(lambda d, rows: None, "one part", highlight="fossil,other")

    def test_a_cell_whose_series_the_request_lacks(self):
        self.one(lambda d, rows: d["bars"][0]["cells"]["fossil"].append("series:T/none:2024:OBS_VALUE"), "not a series of the request")

    def test_a_literal_with_a_digit_a_name_the_request_lacks_and_knobs_off_range(self):
        self.one(lambda d, rows: d.update(title=W("各国 2024 年")), "digit")
        self.one(lambda d, rows: d["others"].update(codes=["IT"]), "labels no name for IT")
        self.one(lambda d, rows: None, "off its range", size=10)
        self.one(lambda d, rows: None, "no knob", colour="red")

    def test_too_narrow_a_picture_refuses(self):
        self.assertEqual(check_svg(draw(hero(DATA, width=480))[0]), [])
        K.setup(ROWS, {**NAMES, "DE": "德" * 24}, run.tables)
        with self.assertRaisesRegex(Refused, "too narrow"): stacked100.draw(hero(DATA, width=480))


class ColumnLeafLayer(unittest.TestCase):
    """run.py draws the leaf as a column page's layer, from the hero's leaves.stacked100, its drops sent back with the layer."""
    class Frame:
        def __init__(f, h):
            f.h = h

    def test_the_layer_draws_from_the_heros_leaves_entry_and_sends_its_drops(self):
        K.setup(ROWS, NAMES, run.tables)
        draw_, reserve = run.KINDS["column"][0]["stacked100"]
        self.assertIsNone(reserve)
        run.DROPPED.clear()
        inner = draw_(self.Frame({"leaves": {"stacked100": DATA}}), prod.Occ())
        self.assertEqual(check_svg(K.svg(inner, 1140, 400, "stacked100")), [])
        self.assertEqual(run.DROPPED, [{"id": "DE:nuclear", "why": "zero"}])
        self.assertIn("stacked100", run.KINDS["column"][1])


if __name__ == "__main__":
    unittest.main()
