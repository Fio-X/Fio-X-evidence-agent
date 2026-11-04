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
        # with no finding (knob finding=none) layer 1's highlight is the accent, as before the finding came in
        svg, _, _ = draw(hero(DATA, highlight="G3000", finding="none"))
        self.assertEqual(check_svg(svg), [])
        n = len(re.findall(r'data-flow="G3000>[^"]*"', svg))
        self.assertGreater(n, 0)
        self.assertEqual(len(re.findall(r'fill="var\(--accent\)" fill-opacity="0\.7"', svg)), n)
        self.assertNotIn("data-notes", svg)
        # with a finding the accent is its subject: a highlight naming another node refuses, naming the subject draws alike
        with self.assertRaisesRegex(Refused, "is not the finding's subject"):
            draw(hero(DATA, highlight="G3000"))
        self.assertEqual(draw(hero(DATA, highlight="O4000XBIO"))[0], self.svg)

    def test_a_sides_note_ends_on_its_largest_nodes_share_of_the_side_when_layer_1_gives_one(self):
        # B1 (11-04: five of six stand-ins found the notes said no why): a side's note at its largest node ends on how much of
        # the side it holds, a share fact layer 1 declares over the rows (node_share); with no share for a node the note is as
        # before. Two data shapes: fuels into sectors (a merged node), groups into countries (none)
        def sides(*cols, share=True):
            rows = [{"src": f"fact:t.{c}", "text": t} for col in cols for c, _, t in col]
            rows += [{"src": f"fact:s.{c}", "text": f"{round(100 * v / sum(x for _, x, _ in col))}%"} for col in cols for c, v, _ in col]
            rows += [{"src": f"fact:whole.{j}", "text": f"{sum(x for _, x, _ in col):.0f}"} for j, col in enumerate(cols)]
            K.setup(rows, {}, run.tables)
            return [("k", [(c, v, f"fact:t.{c}", f"fact:s.{c}" if share and c != "_other" else None) for c, v, _ in col], sum(v for _, v, _ in col)) for col in cols]
        words = sankey.SHARE_WORDS
        txt = lambda segs: "".join(s["w"] if "w" in s else K.FX.text(s["src"]) if "src" in s else "" for s in segs)  # names aside
        fuels = [("A", 60.0, "60"), ("B", 30.0, "30"), ("C", 5.0, "5"), ("_other", 5.0, "5")]
        sectors = [("H", 52.0, "52"), ("T", 30.0, "30"), ("I", 18.0, "18")]
        whole = ["fact:whole.0", "fact:whole.1"]
        f = K.two_sided(sides(fuels, sectors), [], words, whole)
        for n, j in zip(f["notes"], (0, 1)):
            last = n["segs"][-1]
            self.assertEqual((last.get("src"), last.get("bold")), (f"fact:s.{n['code']}", True))
            self.assertIn(K.WD.WORDS[words[j]].split("{t}")[0], txt(n["segs"]))
        self.assertEqual(txt(f["notes"][0]["segs"]).rsplit("，", 1)[1], "占全部来源（100）的60%")
        # no share for a node, or no whole for its side (layer 1 found the side not whole): the note is as before
        for plain in (K.two_sided(sides(fuels, sectors, share=False), [], words, whole), K.two_sided(sides(fuels, sectors), [], words, [None, None])):
            self.assertTrue(all(not s.get("src", "").startswith(("fact:s.", "fact:whole.")) for n in plain["notes"] for s in n["segs"]))
        groups = [("REN", 912.0, "912"), ("FOS", 700.0, "700"), ("NUC", 388.0, "388")]
        geos = [("DE", 600.0, "600"), ("FR", 480.0, "480"), ("ES", 420.0, "420")]
        f = K.two_sided(sides(groups, geos), [], words, whole)
        self.assertEqual([txt(n["segs"]).rsplit("，", 1)[1] for n in f["notes"]], ["占全部来源（2000）的46%", "占全部去向（1500）的40%"])
        # the headline is untouched: the share is the notes' alone
        self.assertFalse(any(s.get("src", "").startswith("fact:s.") for s in f["headline"]))

    def test_a_side_claims_only_what_the_page_check_holds_over_its_whole_set(self):
        # the page check derives each side's set from the fact definitions, the merged node in it: a side claims (headline
        # max, note next) only when its first is above every node and its second above every node after it, both printing
        # differently; two data shapes, each side failing either way and the finding moving or going
        def sides(*cols):
            rows = [{"src": f"fact:t.{c}", "text": t} for col in cols for c, _, t in col]
            K.setup(rows, {}, run.tables)
            return [("k", [(c, v, f"fact:t.{c}") for c, v, _ in col], sum(v for _, v, _ in col)) for col in cols]
        fuels = [("A", 60.0, "60"), ("B", 6.0, "6"), ("C", 5.0, "5"), ("_other", 8.7, "8.7")]  # three merged at 2.9% above B
        sectors = [("H", 52.0, "52"), ("T", 49.0, "49"), ("I", 48.0, "48"), ("_other", 3.0, "3")]
        self.assertIsNone(K.finding_side_top(sides(fuels)[0][1]))
        f = K.two_sided(sides(fuels, sectors), [])
        self.assertEqual((f["side"], f["subject"], [n["code"] for n in f["notes"]]), (1, "H", ["H"]))
        alike = [("H", 52.0, "52"), ("T", 49.01, "49.0"), ("I", 49.0, "49.0"), ("_other", 3.0, "3")]  # second prints as third
        self.assertIsNone(K.finding_side_top(sides(alike)[0][1]))
        self.assertIsNone(K.two_sided(sides(fuels, alike), []))
        # a second shape, no merged node: groups into countries
        groups = [("REN", 912.0, "912"), ("FOS", 700.0, "700"), ("NUC", 690.0, "690")]  # second above third, printing apart
        geos = [("DE", 500.0, "500"), ("FR", 480.0, "480"), ("ES", 480.0, "480")]  # second prints as third
        self.assertEqual([n[0] for n in K.finding_side_top(sides(groups)[0][1])], ["REN", "FOS"])
        self.assertIsNone(K.finding_side_top(sides(geos)[0][1]))
        f = K.two_sided(sides(groups, geos), [])
        self.assertEqual((f["subject"], [n["code"] for n in f["notes"]]), ("REN", ["REN"]))
        self.assertIsNone(K.finding_side_top(sides([("A", 5.0, "5"), ("_other", 9.0, "9"), ("B", 1.0, "1")])[0][1]))
        # the drawn finding over this file's data holds over each side's whole set
        K.setup(ROWS, NAMES, run.tables)
        fr = sankey.Frame(hero(DATA))
        for side, nodes in (("source", fr.src_nodes), ("target", fr.tgt_nodes)):
            got = K.finding_side_top([(c, v, fr.other[side]["value_text"] if c == "_other" else DATA["node_text"][c]) for c, v in nodes])
            if got and any(n["code"] == got[0][0] for n in fr.finding["notes"]):
                self.assertTrue(all(got[1][1] > v for c, v in nodes if c not in (got[0][0], got[1][0])))

    def test_the_finding_marks_its_subject_and_notes_each_side(self):
        f = sankey.Frame(hero(DATA))
        self.assertEqual(f.finding["subject"], "O4000XBIO")
        self.assertEqual(re.findall(r'fill="var\(--accent\)" data-code="([^"]+)"', self.svg), ["O4000XBIO"])
        notes = re.search(r'<g data-notes="finding">.*?</g>', self.svg, re.S).group(0)
        marks = re.findall(r'data-cmp="next" data-a="([^"]+)" data-b="([^"]+)"', notes)
        self.assertEqual(len(marks), len(f.finding["notes"]))
        self.assertEqual(len(re.findall(r"<text\b", notes)), len(marks))
        for a, b in marks:
            self.assertIn(f'data-src="{a}"', notes); self.assertIn(f'data-src="{b}"', notes)
        self.assertEqual(draw(hero(DATA, finding="none"))[0].count("data-code="), 0)


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

    def test_a_merged_node_without_a_series_takes_its_members_flows(self):
        # layer 1 fetched no row of the merged node's sum: without a series, the members' flows are its value, as every
        # node's, and the picture is the one drawn with the series; its printed value is still a ledger entry
        data = copy.deepcopy(DATA)
        for side in ("source", "target"): del data[f"other_{side}"]["value"]
        self.assertEqual(draw(hero(data))[0], draw(hero(DATA))[0])
        data["other_source"]["value_text"] = "fact:none"
        with self.assertRaises(Refused): draw(hero(data))

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


def flow_request(leaves=None, style=None, base=None):
    """A flow page's lines as layer 1 sends them: the column frame with the sankey its main (run.MAIN), the sankey's data the
    hero's leaves.sankey, the year line's table and year hero.data."""
    spec = {"title": "标题", "dek": "导语", "kicker": "栏目", "source": "T", "refs": ["T"], "tables": {"T": {"id": "nrg_bal_s"}},
            "facts": {}, "fmts": {"time": {}},
            "hero": {"data": {"table": "T", "year": "2024"}, "leaves": leaves or {"sankey": DATA}, "style": style or {}}}
    rows = (base or ROWS) + [{"src": "period:T:2024", "text": "2024"}]
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

    def test_the_finding_s_headline_is_the_page_title_and_the_text_step_s_title_its_kicker(self):
        # the page's title and the text step's recorded title part here: the text step's title stays on the page as the
        # kicker (kept as the kicker only when it holds no digit or placeholder), the h1 the finding's marked headline
        def page(lines):
            pic = child(lines)[1]
            return child(lines + [json.dumps({"phase": "page", "layers": {"sankey": pic["svg"]}})])[-1]["html"]
        lines = flow_request()
        spec = json.loads(lines[0])["knobs"]["spec"]
        html = page(lines)
        head = re.search(r'<div class="kicker">(.*?)</div><h1>(.*?)</h1>', html, re.S)
        self.assertEqual(head.group(1), spec["title"])
        # 11-04: the headline names the second it is above, with its value (data-cmp next, the page check's relation)
        self.assertTrue(head.group(2).startswith('<span data-cmp="next" data-a="fact:n.O4000XBIO" data-b="fact:n.G3000">'), head.group(2))
        self.assertRegex(head.group(2), r'data-src="name:[^"]*:O4000XBIO"')
        self.assertIn(K.WD.WORDS["column.note.vs_next"], head.group(2))
        self.assertRegex(head.group(2), r'（<span data-src="name:[^"]*:G3000">[^<]+</span> <b class="n"><span data-src="fact:n.G3000">')
        self.assertFalse(re.sub(r"<[^>]+>", "", head.group(2)).endswith(K.WD.WORDS["column.note.vs_next"]))
        # no finding: the text step's title is the h1 and its kicker stays, as before
        plain = page(flow_request(style={"sankey": {"finding": "none"}}))
        self.assertIn(f'<div class="kicker">{spec["kicker"]}</div><h1>{spec["title"]}</h1>', plain)
        self.assertNotIn("data-cmp", plain)
        # the chart's long description (aria-describedby) and label stay the text step's words, plain text, as without a
        # finding: the gate reads the described-by text up to its first tag
        desc = lambda h: re.search(r'<p id="desc-column" hidden>(.*?)</p>', h, re.S).group(1)
        label = lambda h: re.search(r'aria-label="([^"]*)" aria-describedby="desc-column"', h).group(1)
        self.assertEqual(desc(html), desc(plain))
        self.assertEqual(desc(html), spec["title"])
        self.assertNotIn("<", desc(html))
        self.assertTrue(desc(html).split("<")[0].strip())
        self.assertEqual(label(html), label(plain))
        # a title holding a placeholder is no kicker: the kicker is kept
        found = sankey.Frame(hero(DATA)).finding
        held, why = run.headline(dict(spec, title="{lead} T"), found, draw(hero(DATA))[0])
        self.assertIsNone(why)
        self.assertEqual(held["kicker"], spec["kicker"])

    def test_the_headline_names_the_second_on_either_side(self):
        # two data shapes: the subject on the first side (sources) and on the second (destinations); either way the
        # headline is the subject, its value, the above word and the second of its own side with its value (next a, b)
        rows = [{"src": f"fact:{k}", "text": t} for k, t in (("a", "10"), ("b", "5"), ("c", "1"), ("x", "30"), ("y", "2"))]
        K.setup(rows, {"A": "甲", "B": "乙", "C": "丙", "X": "戊", "Y": "己"}, run.tables)
        first = [("A", 10.0, "fact:a"), ("B", 5.0, "fact:b"), ("C", 1.0, "fact:c")]
        second = [("X", 30.0, "fact:x"), ("Y", 2.0, "fact:y")]
        for sums, subject, other in (((11.0, 300.0), ("A", "fact:a"), ("B", "fact:b")), ((300.0, 32.0), ("X", "fact:x"), ("Y", "fact:y"))):
            got = K.two_sided([("place", first, sums[0]), ("place", second, sums[1])], [])
            self.assertEqual((got["subject"], got["cmp"]), (subject[0], ("next", subject[1], other[1])), sums)
            names = [s["name"] for s in got["headline"] if "name" in s]
            srcs = [s["src"] for s in got["headline"] if "src" in s]
            self.assertEqual((names, srcs), ([subject[0], other[0]], [subject[1], other[1]]), sums)
            self.assertEqual(got["headline"], got["dek"])
        K.setup(ROWS, NAMES, run.tables)

    def test_a_zero_flow_is_drawn_as_no_band_and_goes_back_to_layer_1_as_dropped(self):
        # the reported totals hold the zeroed flow's old value, so they are left out here (conservation has its own tests)
        data = {k: v for k, v in DATA.items() if k != "totals"}
        flow = next(r for r in data["flows"] if r["source"] not in SMALL_S and r["target"] not in SMALL_T)
        rows = copy.deepcopy(ROWS)
        for r in rows:
            if r["src"] == flow["value"]: r["value"] = 0.0
        K.setup(ROWS, NAMES, run.tables)
        self.assertEqual(sankey.Frame(hero(data)).dropped, [])
        K.setup(rows, NAMES, run.tables)
        self.assertEqual(sankey.Frame(hero(data)).dropped, [(f"{flow['source']}>{flow['target']}", "zero")])
        size, pic = child(flow_request(leaves={"sankey": data}, base=rows))
        self.assertEqual(pic["dropped"], [{"id": f"{flow['source']}>{flow['target']}", "why": "zero"}])
        self.assertNotIn("dropped", child(flow_request())[1])

    def test_layer_1_s_lines_print_under_the_picture_one_line_each_every_digit_a_ledger_entry(self):
        rows = ROWS + [{"src": "fact:z.n", "text": "37"}, {"src": "fact:u.n", "text": "1"}]
        lines = [[{"w": "另有 "}, {"src": "fact:z.n"}, {"w": " 个组合为零"}], [{"w": "另有 "}, {"src": "fact:u.n"}, {"w": " 个组合在数据中没有记录"}]]
        svg, _, h = draw(hero(dict(DATA, lines=lines)), rows)
        self.assertEqual(check_svg(svg), [])
        self.assertIn('<tspan data-src="fact:z.n">37</tspan> 个组合为零', svg)
        self.assertGreater(h, draw(hero(DATA))[2])
        for bad, regex in (("x", "lines is"), ([[{"w": "2 个"}]], "digit"), ([[{"w": "长" * 200}]], "line 1 takes")):
            with self.assertRaisesRegex(Refused, regex): draw(hero(dict(DATA, lines=bad)), rows)

    def test_a_code_with_no_row_is_no_node_and_goes_back_to_layer_1_as_dropped(self):
        # nuclear heat has no final-use row in the archived table: layer 1 names it empty, the leaf draws no node for it
        self.assertNotIn("N900H", {r["source"] for r in DATA["flows"]})
        data = dict(DATA, empty={"source": ["N900H"]})
        K.setup(ROWS, NAMES, run.tables)
        self.assertEqual(sankey.Frame(hero(data)).dropped, [("N900H", "no row")])
        svg, _, _ = draw(hero(data))
        self.assertEqual(svg, draw(hero(DATA))[0])  # nothing drawn for it
        size, pic = child(flow_request(leaves={"sankey": data}))
        self.assertEqual(pic["dropped"], [{"id": "N900H", "why": "no row"}])
        # a code of a flow is no empty code; a side or a list that is none refuses
        for empty, regex in (({"source": ["G3000"]}, "which a flow has"), ({"middle": ["N900H"]}, "empty.middle"),
                             ({"target": "N900H"}, "empty.target")):
            with self.assertRaisesRegex(Refused, regex): sankey.Frame(hero(dict(DATA, empty=empty)))

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
