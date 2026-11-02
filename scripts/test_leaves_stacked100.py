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
import words as WD  # noqa: E402
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

    def test_each_segment_names_its_part_and_the_greys_step_apart_in_lightness(self):
        svg = draw(hero(DATA, highlight="fossil"))[0]
        marks = re.findall(r'fill="([^"]+)" stroke="var\(--bg\)" stroke-width="1" data-part="[A-Z0-9_]+:([a-z]+)" data-code="([a-z]+)"', svg)
        self.assertTrue(marks and all(p == c for _, p, c in marks), marks[:3])
        self.assertEqual({c for fill, _, c in marks if fill == "var(--accent)"}, {"fossil"})  # the accent's entity, for the page checks
        css = open(os.path.join(LEAVES, "tokens.css"), encoding="utf-8").read()

        def lstar(var):
            h = re.search(rf"{var[4:-1]}:#([0-9a-f]{{6}})", css).group(1)
            lin = [(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4) for c in (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))]
            return 116 * (0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]) ** (1 / 3) - 16
        three = [lstar(g) for g in stacked100.GREYS[:3]]  # a page of four parts (q3) uses the first three
        self.assertGreaterEqual(min(abs(a - b) for i, a in enumerate(three) for b in three[i + 1:]), 19.5, three)
        neighbours = [lstar(g) for g in stacked100.GREYS]
        self.assertGreaterEqual(min(abs(a - b) for a, b in zip(neighbours, neighbours[1:])), 14, neighbours)

    def test_each_bar_prints_its_total_from_the_ledger_in_a_column_or_none_does(self):
        rows = ROWS + [{"src": f"fact:total.{g}.n", "text": f"{TAB[(g, 'TOTAL')]:,.0f}"} for g in GEOS]
        data = dict(DATA, total_head=W("合计"), bars=[dict(b, total_text=f"fact:total.{b['code']}.n") for b in DATA["bars"]])
        svg = draw(hero(data), rows)[0]
        self.assertEqual(check_svg(svg), [])
        for g in GEOS:
            self.assertIn(f'data-src="fact:total.{g}.n"', svg)
        plain = frame(hero(DATA))
        self.assertEqual(frame(hero(data), rows).x0 > plain.x0, True)  # the column sits between the names and the bars
        some = dict(data, bars=[data["bars"][0]] + [{k: v for k, v in b.items() if k != "total_text"} for b in data["bars"][1:]])
        for bad, why in [(some, "some bars only"), ({k: v for k, v in data.items() if k != "total_head"}, "total_head is missing")]:
            with self.assertRaises(K.Refused) as e:
                frame(hero(bad), rows)
            self.assertIn(why, str(e.exception))

    def test_on_a_page_every_text_the_picture_draws_names_its_src_the_totals_head_included(self):
        # layer 1 refuses a panel text with no src (src/next_leaf.rs faults): the title, unit and the totals' head come as
        # name rows, the others head around a count fact, as stacked100_fill sends them
        names = [("name:frames:composition", "整体的构成"), ("name:unit_short_zh:GWH", "吉瓦时"),
                 ("name:zh_names:siec:TOTAL", "合计"), ("fact:comp_others.n", "2")]
        rows = ROWS + [{"src": f"fact:total.{g}.n", "text": f"{TAB[(g, 'TOTAL')]:,.0f}"} for g in GEOS] + [{"src": k, "text": t} for k, t in names]
        page = dict(DATA, title=[{"src": names[0][0]}], unit=[{"src": names[1][0]}], total_head=[{"src": names[2][0]}],
                    others={"head": [{"w": "其余 "}, {"src": names[3][0]}, {"w": " 个国家："}], "codes": ["FR", "PL"]},
                    bars=[dict(b, total_text=f"fact:total.{b['code']}.n") for b in DATA["bars"]])
        no_src = lambda svg: [g["text"] for g in run.drawn(svg)[0] if not g["src"]]
        self.assertEqual(no_src(draw(hero(page), rows)[0]), [])
        # a head of a literal word alone is a text with no src: the page refuses it
        self.assertEqual(no_src(draw(hero(dict(page, total_head=W("合计"))), rows)[0]), ["合计"])

    def test_a_part_layer_1_declares_zero_draws_no_segment_and_is_no_drop_but_only_when_its_cells_are_0(self):
        # DE's nuclear row is 0: layer 1 leaves it out of the cells and declares it zero with its row
        bars = [dict(b, cells={p: c for p, c in b["cells"].items() if not (b["code"] == "DE" and p == "nuclear")}) for b in DATA["bars"]]
        de = next(b for b in DATA["bars"] if b["code"] == "DE")
        data = dict(DATA, bars=bars, zero=[{"bar": "DE", "part": "nuclear", "cells": de["cells"]["nuclear"]}])
        f = frame(hero(data))
        self.assertEqual(f.dropped, [])
        svg = draw(hero(data))[0]
        self.assertNotIn('data-part="DE:nuclear"', svg)
        self.assertEqual(check_svg(svg), [])
        # a declared zero whose cell is not 0, a zero also named empty, or one that keeps its cells: refused
        fossil = de["cells"]["fossil"]
        for bad, why in [(dict(data, zero=[{"bar": "DE", "part": "nuclear", "cells": fossil}]), "not 0"),
                         (dict(data, empty=[{"bar": "DE", "part": "nuclear"}]), "both empty and zero"),
                         (dict(data, bars=DATA["bars"]), "which has cells")]:
            with self.assertRaises(Refused) as e:
                frame(hero(bad))
            self.assertIn(why, str(e.exception))
        # with no declaration the 0 part is a drop, as before
        self.assertEqual(frame(hero(dict(DATA))).dropped, [("DE:nuclear", "zero")])

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
        f = frame(hero(DATA, values="in_bar"))  # a share on a dark grey is printed in --bg, on a light one in --t-dark
        for p in f.order[1:]:
            m = re.search(rf'fill="([^"]+)"[^>]*><tspan data-src="fact:share\.DE\.{p}"', svg)
            if m: self.assertEqual(m.group(1), "var(--bg)" if f.fill[p] in stacked100.DARK else "var(--t-dark)", p)

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


def three(hl, shares):
    """Three bars (DE, EU27_2020 and FR, FR drawn from DE's cells) whose `hl` shares print and hold {place: (text, bare)} as
    test-only ledger entries (layer 1 writes a share fact's text and its bare .n entry); the rows and the hero."""
    rows = copy.deepcopy(ROWS) + [dict(r, src=r["src"].replace("/DE.", "/FR."), dims=dict(r["dims"], geo="FR"))
                                  for r in ROWS if r["src"].startswith("series:T/DE.")]
    rows += [{"src": r["src"].replace(".DE.", ".FR."), "text": r["text"]} for r in ROWS if r["src"].startswith("fact:share.DE.")]
    for g, (text, bare) in shares.items():
        rows += [{"src": f"fact:share.{g}.{hl}", "text": text}, {"src": f"fact:share.{g}.{hl}.n", "text": bare}]
    data = copy.deepcopy(DATA)
    fr = copy.deepcopy(data["bars"][0])
    fr.update(code="FR", total=src("FR", "TOTAL"), cells={p: [c.replace("/DE.", "/FR.") for c in cs] for p, cs in fr["cells"].items()},
              share_text={p: s.replace(".DE.", ".FR.") for p, s in fr["share_text"].items()})
    data["bars"].append(fr); data["others"]["codes"] = ["PL"]
    return rows, hero(data, highlight=hl)


class ShareNote(unittest.TestCase):
    """One note under the bars (P4b-5): the first place on the highlighted part's share above the second, ordered by the shares'
    ledger values, marked for the page check, and only where the core's comparison (wbkit.COMPARISONS, knobs.comparisons)
    names the same two; its scope phrase leading where the core's set is scoped. No note where the two tie, print alike, a bar
    does not draw the part, the core names other places or none, and the page is drawn all the same."""
    SHARES = {"DE": ("40%", "40"), "EU27_2020": ("55%", "55"), "FR": ("30%", "30")}

    def tearDown(self):
        K.COMPARISONS = {}

    def core(self, first, second, scoped=False, hl="fossil"):
        K.COMPARISONS = {f"share.{g}.{hl}": {"first": first, "second": second, "scoped": scoped} for g in ("DE", "EU27_2020", "FR")}

    def note(self, svg):
        m = re.search(r'<g data-notes="share"><text [^>]*data-cmp="next" data-a="([^"]+)" data-b="([^"]+)">(.*?)</text></g>', svg)
        return m and (m.group(1), m.group(2), re.sub(r"<[^>]+>", "", m.group(3)))

    def test_the_first_above_the_second_by_their_ledger_values_as_the_core_finds_them(self):
        rows, h = three("fossil", self.SHARES)
        self.core("EU27_2020", "DE")
        svg, _, _ = draw(h, rows)
        self.assertEqual(check_svg(svg), [])
        said = "欧盟 55%" + WD.WORDS["column.note.vs_next"] + WD.word("paren", v="德国 40%")
        self.assertEqual(self.note(svg), ("fact:share.EU27_2020.fossil", "fact:share.DE.fossil", said))
        self.core("EU27_2020", "DE", scoped=True)
        svg, _, _ = draw(h, rows)
        if "scope.within" in WD.WORDS:  # the scope phrase leads, in one piece, as the page check reads it
            self.assertEqual(self.note(svg)[2], WD.WORDS["scope.within"] + WD.WORDS["column.note.vs_next"][:1] + said)
            self.assertIn(WD.WORDS["scope.within"], svg)
        else:
            self.assertNotIn("data-notes", svg)

    def test_no_note_where_the_shares_tie_print_alike_a_bar_lacks_the_part_or_the_core_disagrees(self):
        cases = {"a tie at the top": ("fossil", {"DE": ("40%", "40"), "EU27_2020": ("40%", "40"), "FR": ("30%", "30")}, ("EU27_2020", "DE")),
                 "the second printed as the third": ("fossil", {"DE": ("40%", "40.2"), "EU27_2020": ("55%", "55"), "FR": ("40%", "39.9")}, ("EU27_2020", "DE")),
                 "a bar whose part is zero": ("nuclear", {"EU27_2020": ("23%", "23"), "FR": ("10%", "10")}, ("EU27_2020", "FR")),
                 "the core's first is a place the bars do not draw": ("fossil", self.SHARES, ("PT", "EU27_2020")),
                 "the core's second is another": ("fossil", self.SHARES, ("EU27_2020", "FR"))}
        for name, (hl, shares, (first, second)) in cases.items():
            rows, h = three(hl, shares)
            self.core(first, second, hl=hl)
            svg, _, _ = draw(h, rows)
            self.assertEqual(check_svg(svg), [], name)
            self.assertNotIn("data-notes", svg, name)
        K.COMPARISONS = {}
        rows, h = three("fossil", self.SHARES)
        self.assertNotIn("data-notes", draw(h, rows)[0])  # no comparison from the core: no note

    def test_a_two_sided_finding_keeps_to_the_cores_comparisons_where_it_sent_any(self):
        K.setup(copy.deepcopy(ROWS) + [{"src": f"fact:n.{c}.n", "text": t} for c, t in (("A", "50"), ("B", "30"), ("C", "20"))], NAMES, run.tables)
        sides = [("siec", [("A", 50.0, "fact:n.A.n"), ("B", 30.0, "fact:n.B.n"), ("C", 20.0, "fact:n.C.n")], 100.0)]
        for comparisons, found in [({}, True), ({"n.Z": {"first": "Z", "second": "Y", "scoped": False}}, False),
                                   ({"n.A": {"first": "A", "second": "B", "scoped": False}}, True),
                                   ({"n.A": {"first": "A", "second": "B", "scoped": True}}, False)]:
            K.COMPARISONS = comparisons
            self.assertEqual(K.two_sided(sides, []) is not None, found, comparisons)
        self.assertNotIn("data-notes", draw(hero(DATA))[0])  # two bars, and no bare entries: no note


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
