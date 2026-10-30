"""Self-test of the sankey leaf (runtime/leaves_py/sankey.py) and of the flow page (run.py MAIN: a column frame page whose main
layer is the sankey) on the archived Eurostat nrg_bal_s, Germany 2024, KTOE (scripts/fixtures/data_prepare/nrg_bal_s_DE_2024.tsv:
final energy consumption by fuel and by sector). Test-only ledger texts, names and merges (layer 1 writes the real ones: it picks
the nodes under min_share, sums them into the ledger and names them in other_<side>.members).
Checks: sector totals = the final-consumption total = the fuels' sum (the table's own conservation); the leaf draws the picture with
every digit inside a marked ledger run; the given members merge and are named under the picture; the unit is written once; every
label is at least 11 px; the refusals keep the leaf's rules (a node total that does not match its flows, a merged series that is
not the members' sum, an other node of fewer than two members, a member twice or unknown, a negative flow, a code on both sides, a
node with no text, a highlight that is no drawn code, a knob off its range); the flow page sizes its panel by the drawn sankey and
lays it out across the column page with the year line and the footer, and refuses leader notes. With LEAF_SVG_DIR set, the themed
svg is kept there. Run: python3 -I -B scripts/test_leaves_sankey.py"""
import copy
import csv
import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import prod  # noqa: E402
import run  # noqa: E402
import sankey  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
fmt = lambda v: f"{v:,.0f}"
SECTORS = ["FC_IND_E", "FC_TRA_E", "FC_OTH_CP_E", "FC_OTH_HH_E", "FC_OTH_AF_E", "FC_OTH_FISH_E", "FC_OTH_NSP_E"]
NAMES = {  # test-only names (the reviewed names come from the first layer's name rows)
    "O4000XBIO": "石油及石油产品", "G3000": "天然气", "E7000": "电力", "RA000": "可再生能源和生物燃料", "H8000": "区域供热",
    "C0000X0350-0370": "硬煤", "C0350-0370": "褐煤", "W6100_6220": "非可再生废物", "P1000": "泥炭", "S2000": "油页岩", "N900H": "核热",
    "FC_IND_E": "工业", "FC_TRA_E": "交通运输", "FC_OTH_CP_E": "商业和公共服务", "FC_OTH_HH_E": "居民家庭",
    "FC_OTH_AF_E": "农林业", "FC_OTH_FISH_E": "渔业", "FC_OTH_NSP_E": "其他未列明"}


def load():
    tab = {}
    path = os.path.join(HERE, "fixtures", "data_prepare", "nrg_bal_s_DE_2024.tsv")
    for r in csv.DictReader((l for l in open(path, encoding="utf-8") if not l.startswith("#")), delimiter="\t"):
        tab[(r["nrg_bal"], r["siec"])] = float(r["value"])
    return tab


TAB = load()
FUELS = sorted({s for (b, s) in TAB if b == "FC_E" and s != "TOTAL"})
SHARE = prod.KNOBS["sankey"]["min_share"][0]


def series(key, v):
    return {"src": f"series:T/{key}:2024:OBS_VALUE", "table": "T", "dims": {"k": key}, "time": "2024", "value": v}


def build():
    """rows (series cells and test ledger texts) and the spec for the picture as the first layer would write them: the nodes
    under min_share merged when two or more of a column qualify, their sum a series and a ledger text, their codes the members."""
    rows, flows, node_text, totals = [], [], {}, {"source": {}, "target": {}}
    for b in SECTORS:
        for s in FUELS:
            v = TAB.get((b, s), 0.0)
            if v > 0:
                key = f"{s}.{b}"; rows.append(series(key, v)); flows.append(dict(source=s, target=b, value=f"series:T/{key}:2024:OBS_VALUE"))
    by_s, by_t = {}, {}
    for r in flows:
        v = [x for x in rows if x["src"] == r["value"]][0]["value"]; by_s[r["source"]] = by_s.get(r["source"], 0) + v; by_t[r["target"]] = by_t.get(r["target"], 0) + v
    for code, v in {**by_s, **by_t}.items(): rows.append({"src": f"fact:n.{code}", "text": fmt(v)}); node_text[code] = f"fact:n.{code}"
    for s in by_s:  # the reported total of a fuel: the table's FC_E row of that fuel
        rows.append(series(f"tot.{s}", TAB[("FC_E", s)])); totals["source"][s] = f"series:T/tot.{s}:2024:OBS_VALUE"
    for b in by_t:  # the reported total of a sector: its TOTAL row
        rows.append(series(f"tot.{b}", TAB[(b, "TOTAL")])); totals["target"][b] = f"series:T/tot.{b}:2024:OBS_VALUE"
    rows.append(series("all", TAB[("FC_E", "TOTAL")])); totals["all"] = "series:T/all:2024:OBS_VALUE"
    grand = sum(by_s.values())
    small_s = sorted(c for c, v in by_s.items() if v / grand < SHARE); small_t = sorted(c for c, v in by_t.items() if v / grand < SHARE)
    data = dict(title=W("德国最终能源消费：从燃料到部门"), unit=W("千吨油当量"), flows=flows, node_text=node_text, totals=totals,
                footnote=W("各项之和与合计的差来自四舍五入。"))
    for side, small, col in (("source", small_s, by_s), ("target", small_t, by_t)):
        if len(small) >= 2:
            sv = sum(col[c] for c in small); rows += [series(f"other.{side}", sv), {"src": f"fact:o.{side}", "text": fmt(sv)}]
            data[f"other_{side}"] = dict(name=W("其他燃料" if side == "source" else "其他部门"), members=list(small),
                                         value=f"series:T/other.{side}:2024:OBS_VALUE", value_text=f"fact:o.{side}",
                                         members_head=W("其他燃料包括：" if side == "source" else "其他部门包括："))
    return rows, data, by_s, by_t, small_s, small_t


ROWS, DATA, BY_S, BY_T, SMALL_S, SMALL_T = build()


def hero(data, **style):
    return {"data": data, "style": {"sankey": style}}


def draw(h, rows=ROWS):
    K.setup(rows, NAMES, run.tables)
    return sankey.draw(h)


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
    """The archived table's own identity, independent of the leaf: sectors = FC_E = fuels (rounding 0.001 per cell)."""
    def test_sector_sum_equals_final_consumption_equals_fuel_sum(self):
        fc = TAB[("FC_E", "TOTAL")]
        sectors = sum(TAB[(b, "TOTAL")] for b in SECTORS); fuels = sum(TAB[("FC_E", s)] for s in FUELS)
        cells = sum(v for (b, s), v in TAB.items() if b in SECTORS and s != "TOTAL")
        for name, v in (("sectors", sectors), ("fuels", fuels), ("cells", cells)):
            self.assertLess(abs(v - fc), 1e-5 * fc, f"{name} {v} vs FC_E {fc}")


class Picture(unittest.TestCase):
    def setUp(self):
        self.svg, self.w, self.h = draw(hero(DATA))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        self.assertEqual(check_svg(self.svg), [])
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            with open(os.path.join(os.environ["LEAF_SVG_DIR"], "sankey-nrg_bal_s-DE-2024.svg"), "w", encoding="utf-8") as f:
                f.write(themed(self.svg, self.w, self.h))

    def test_the_given_members_merge_and_are_named_under_the_picture(self):
        self.assertTrue(len(SMALL_S) >= 2 and len(SMALL_T) >= 2, (SMALL_S, SMALL_T))
        got, _ = run.drawn(self.svg)
        texts = " ".join(g["text"] for g in got)
        for c in SMALL_S + SMALL_T: self.assertIn(NAMES[c], texts, f"the merged member {c} is not named")
        self.assertIn("其他燃料", texts); self.assertIn("其他部门", texts)
        self.assertEqual(self.svg.count('data-flow="'), len(set((("_other" if s in SMALL_S else s), ("_other" if t in SMALL_T else t))
                                                                  for s, t in [(r["source"], r["target"]) for r in DATA["flows"]])))
        self.assertEqual(self.svg.count("<rect"), len(BY_S) - len(SMALL_S) + 1 + len(BY_T) - len(SMALL_T) + 1)

    def test_the_leaf_merges_nothing_itself_whatever_min_share_says(self):
        for share in (0, 0.2):
            self.assertEqual(draw(hero(DATA, min_share=share))[0], self.svg, share)
        sources = {k: v for k, v in DATA.items() if k != "other_source"}  # the fuels unmerged (the tiny sectors' labels would overlap)
        for share in (0, 0.2):
            svg, _, _ = draw(hero(sources, min_share=share, height=900))
            self.assertEqual(check_svg(svg), [])
            self.assertEqual(svg.count("<rect"), len(BY_S) + len(BY_T) - len(SMALL_T) + 1, share)
            self.assertNotIn("其他燃料", " ".join(g["text"] for g in run.drawn(svg)[0]))

    def test_the_unit_is_written_once_and_every_label_is_at_least_11px(self):
        got, _ = run.drawn(self.svg)
        self.assertEqual(sum(g["text"].count("千吨油当量") for g in got), 1)
        sizes = [float(x) for x in re.findall(r'font-size="([\d.]+)"', self.svg)]
        self.assertTrue(sizes and min(sizes) >= 11, sizes)

    def test_highlight_draws_one_codes_bands_in_the_accent(self):
        svg, _, _ = draw(hero(DATA, highlight="G3000"))
        self.assertEqual(check_svg(svg), [])
        n = len(re.findall(r'data-flow="G3000>[^"]*"', svg))
        self.assertGreater(n, 0)
        self.assertEqual(len(re.findall(r'fill="var\(--accent\)" fill-opacity="0\.7"', svg)), n)


class Refusals(unittest.TestCase):
    def one(self, mutate, regex, **style):
        data, rows = copy.deepcopy(DATA), copy.deepcopy(ROWS); mutate(data, rows)
        with self.assertRaisesRegex(Refused, regex): draw(hero(data, **style), rows)

    def test_a_node_total_that_does_not_match_its_flows(self):
        def m(d, rows):
            for r in rows:
                if r["src"] == "series:T/tot.G3000:2024:OBS_VALUE": r["value"] += 5000
        self.one(m, "reported total of source G3000")

    def test_the_grand_total_that_does_not_match(self):
        def m(d, rows):
            for r in rows:
                if r["src"] == "series:T/all:2024:OBS_VALUE": r["value"] += 5000
        self.one(m, "grand total")

    def test_a_merged_series_that_is_not_the_members_sum(self):
        def m(d, rows):
            for r in rows:
                if r["src"] == "series:T/other.source:2024:OBS_VALUE": r["value"] += 500
        self.one(m, "other_source's series")
        self.one(lambda d, rows: d["other_source"]["members"].pop(), "other_source's series")  # a member left out

    def test_an_other_node_of_fewer_than_two_members_twice_or_unknown(self):
        self.one(lambda d, rows: d["other_target"].update(members=SMALL_T[:1]), "two or more codes")
        self.one(lambda d, rows: d["other_target"].pop("members"), "two or more codes")
        self.one(lambda d, rows: d["other_target"]["members"].append(SMALL_T[0]), "twice")
        self.one(lambda d, rows: d["other_target"]["members"].append("G3000"), "no flow has as its target")

    def test_a_merged_member_still_needs_no_text_and_a_drawn_node_does(self):
        def m(d, rows):
            for c in SMALL_S: d["node_text"].pop(c)
        data, rows = copy.deepcopy(DATA), copy.deepcopy(ROWS); m(data, rows)
        self.assertEqual(check_svg(draw(hero(data), rows)[0]), [])
        self.one(lambda d, rows: d["node_text"].pop("G3000"), "node G3000 has no node_text")

    def test_a_negative_flow(self):
        def m(d, rows):
            for r in rows:
                if r["src"] == d["flows"][0]["value"]: r["value"] = -1.0
        self.one(m, "negative")

    def test_a_code_on_both_sides(self):
        self.one(lambda d, rows: d["flows"].append(dict(source="FC_IND_E", target="E7000", value=d["flows"][0]["value"])), "both a source and a target")

    def test_a_highlight_that_is_no_drawn_code(self):
        self.one(lambda d, rows: None, "NOPE.*codes the request does not hold", highlight="NOPE")
        self.one(lambda d, rows: None, "merged into the other node", highlight=SMALL_S[0])

    def test_a_literal_with_a_digit(self):
        self.one(lambda d, rows: d.update(title=W("德国 2024 年")), "digit")

    def test_knobs_off_range_or_unknown(self):
        self.one(lambda d, rows: None, "off its range", size=10)
        self.one(lambda d, rows: None, "no knob", colour="red")

    def test_a_flow_whose_series_the_request_lacks(self):
        self.one(lambda d, rows: d["flows"][0].update(value="series:T/none:2024:OBS_VALUE"), "not a series of the request")

    def test_too_small_a_picture_refuses_rather_than_overlapping(self):
        self.one(lambda d, rows: None, "too narrow|overlap|leaves|too small", width=480, height=240)


def flow_request(leaves=None, style=None):
    """A flow page's lines as layer 1 sends them: the column frame with the sankey its main (run.MAIN), the sankey's data the
    hero's leaves.sankey, the year line's table and year hero.data."""
    spec = {"title": "标题", "dek": "导语", "kicker": "栏目", "source": "T", "refs": ["T"], "tables": {"T": {"id": "nrg_bal_s"}},
            "facts": {}, "fmts": {"time": {}},
            "hero": {"data": {"table": "T", "year": "2024"}, "leaves": leaves or {"sankey": DATA}, "style": style or {}}}
    rows = ROWS + [{"src": "period:T:2024", "text": "2024"}]
    knobs = {"spec": spec, "labels": NAMES}
    line = lambda **kv: json.dumps({"node": "flow", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows, "knobs": knobs, **kv},
                                   ensure_ascii=False)
    return [line(phase="size"), line(layer="sankey")]


def child(lines):
    """run.py as layer 1 runs it: one reply per line."""
    out = subprocess.run([sys.executable, "-I", "-B", os.path.join(LEAVES, "run.py")], input="\n".join(lines) + "\n",
                         capture_output=True, text=True, check=True).stdout
    return [json.loads(l) for l in out.splitlines()]


class FlowPage(unittest.TestCase):
    def test_the_flow_page_sizes_its_panel_by_the_sankey_and_lays_it_out_across_the_column_page(self):
        lines = flow_request()
        size, pic = child(lines)
        _, w, h = draw(hero(DATA))
        self.assertEqual((size["w"], size["h"]), (1140, h))
        self.assertEqual(check_svg(pic["svg"]), [])
        self.assertTrue(all(0 <= t["x"] <= w and 0 <= t["y"] <= h for t in pic["texts"]))
        html = child(lines + [json.dumps({"phase": "page", "layers": {"sankey": pic["svg"]}})])[-1]["html"]
        self.assertIn(f'<svg class="sankey pub-chart" role="img" aria-label="', html)
        self.assertIn(f'viewBox="0 0 {w} {h}" width="{w}" height="{h}"><g data-layer="sankey">{pic["svg"]}</g></svg>', html)
        self.assertIn('data-module-id="column"', html)
        self.assertIn('<div class="cu"><span data-src="period:T:2024">2024</span> 年</div>', html)  # no hero unit: the year only
        self.assertIn("<footer", html)
        self.assertNotIn('data-layer="bars"', html)
        self.assertEqual(run.placeholders(html), [])

    def test_the_flow_page_refuses_notes_a_layer_it_lacks_and_a_picture_wider_than_the_page(self):
        lines = flow_request()
        self.assertEqual(child(lines[:1] + [json.dumps({"phase": "page", "layers": {}})])[1]["refused"], ["page: no layer sankey"])
        self.assertEqual(child(lines[:1] + [json.dumps({"phase": "page", "layers": {"sankey": "", "bars": ""}})])[1]["refused"],
                         ["page: bars is no layer the page places"])
        notes = child(flow_request({"sankey": DATA, "leader_notes": {"notes": []}})[:1])[0]
        self.assertEqual(notes["refused"], ["size: column: the leader notes point at the bubbles' map, and the hero has none"])
        wide = child(flow_request(style={"sankey": {"width": 1400}})[:1])[0]
        self.assertEqual(wide["refused"], ["size: column: the sankey picture is 1400 px wide, the page 1140"])
        bad = child(flow_request({"sankey": {**DATA, "flows": []}})[:1])[0]
        self.assertEqual(bad["refused"], ["size: sankey: the spec holds no flows"])


if __name__ == "__main__":
    unittest.main()
