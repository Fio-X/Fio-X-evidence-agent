"""Self-test of the unit-grid leaf (runtime/leaves_py/unit_grid.py) on two data shapes, the values the published rows hold, the
ledger texts and words test-only (layer 1 writes the real ones: the count, the threshold, each member's flag its facts):
  - an EU shape: the 27 members' share at 2025 (Eurostat nrg_ind_ren REN PC as fetched), lit when at or above a level of 42.5,
    in flag mode (cells and turbines) and in fill mode (each cell filled to value / 42.5);
  - a World Bank shape: eight economies' tonnes per head at 2024 (EN.GHG.CO2.PC.CE.AR5 as fetched), the five lowest lit.
Checks: one glyph a member; the lit glyphs are the ones the rule gives and their number is the printed count (the lit turbine
groups in the svg equal the count entry); the fill shares are value / reference, capped at full; the orders; names under every
glyph when they fit, else only under the lit ones; every digit inside a marked ledger run; the refusals keep the leaf's rules
(a printed count that differs, a flag that is not the rule over its cell, a member twice, too few members, names that overflow);
the file holds no topic word. With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_unit_grid.py"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LEAVES = os.path.join(ROOT, "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import unit_grid  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
# the fetched rows at 2025 (one decimal as published)
EU = {"AT": 44.2, "BE": 14.9, "BG": 22.7, "CY": 21.5, "CZ": 19.1, "DE": 23.9, "DK": 48.2, "EE": 42.3, "EL": 26.9, "ES": 26.0,
      "FI": 53.0, "FR": 23.9, "HR": 28.5, "HU": 19.6, "IE": 17.2, "IT": 20.5, "LT": 38.5, "LU": 20.2, "LV": 46.3, "MT": 18.8,
      "NL": 22.7, "PL": 18.7, "PT": 36.7, "RO": 25.6, "SE": 65.4, "SI": 25.4, "SK": 16.3}
LEVEL = 42.5
EU_LIT = {c for c, v in EU.items() if v >= LEVEL}          # AT DK FI LV SE
# the fetched rows at 2024 (rounded here to three places; the leaf reads the cells only for the rule)
WB = {"BGD": 0.716, "BRA": 2.318, "CHN": 9.315, "IND": 2.174, "IDN": 2.865, "NGA": 0.567, "PAK": 0.812, "USA": 13.624}
WB_NAMES = {"BGD": "Bangladesh", "BRA": "Brazil", "CHN": "China", "IND": "India", "IDN": "Indonesia", "NGA": "Nigeria", "PAK": "Pakistan", "USA": "United States"}
WB_LOW5 = set(sorted(WB, key=WB.get)[:5])


def build(table, vals, names, year, rule, count, mode="flag", flags=True, total=None, ref_text=None):
    rows, mem = [], []
    for c, v in vals.items():
        src = f"series:{table}/{c}:{year}:OBS_VALUE"
        rows.append({"src": src, "table": table, "dims": {"geo": c}, "time": year, "value": v})
        mem.append({"code": c, "value": src})
    rows += [{"src": K.name_row(c, "place"), "text": n} for c, n in names.items()]
    rows += [{"src": "fact:n_lit", "text": str(count)}, {"src": "fact:n_all", "text": str(len(vals))}, {"src": "period:t:" + year, "text": year}]
    if ref_text: rows.append({"src": "fact:level", "text": ref_text})
    data = {"title": W("Members at the level"), "unit": W("share"), "lead": W("One cell a member, lit when the rule holds"),
            "name_kind": "place", "mode": mode, "members": mem, "rule": rule,
            "count": {"src": "fact:n_lit", "words": [{"w": "of "}, {"src": "fact:n_all"}, {"w": " members, at "}, {"src": "period:t:" + year}]},
            "key": {"lit": W("the rule holds"), "unlit": W("the others")}, "footnote": W("As published")}
    if total: data["total"] = "fact:n_all"
    if mode == "fill": data["key"]["fill"] = [{"w": "full at "}, {"src": "fact:level"}]
    return rows, data, names, flags


def with_flags(shape, lit):
    rows, data, names, flags = shape
    if flags:
        for m in data["members"]: m["flag"] = m["code"] in lit
    return rows, data, names


def eu(mode="flag", count=len(EU_LIT)):
    return with_flags(build("nrg", EU, {c: c for c in EU}, "2025", {"op": "ge", "ref": "fact:level"}, count, mode, total=True, ref_text="42.5%"), EU_LIT)


def wb(count=5):
    return with_flags(build("co2", WB, WB_NAMES, "2024", {"op": "bottom", "k": 5}, count), WB_LOW5)


def draw(shape, **style):
    rows, data, names = shape
    K.setup(rows, names, run.tables)
    return unit_grid.draw({"data": data, "style": {"unit_grid": style}})


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


def glyphs(svg, kind):
    """[(code, lit)] of the grid's glyphs (not the key's), in drawn order."""
    return [(c, l == "1") for c, l in re.findall(rf'class="glyph {kind}[^"]*" (?:[^>]*?)data-code="([A-Z0-9_]+)" data-lit="([01])"', svg)]


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = {"eu_cell": draw(eu()), "eu_turbine": draw(eu(), glyph="turbine"), "eu_fill": draw(eu("fill")), "wb": draw(wb())}
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            for n, (svg, w, h) in cls.out.items():
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"unit_grid-{n}.svg"), "w", encoding="utf-8") as fh: fh.write(themed(svg, w, h))

    def test_every_digit_is_a_marked_ledger_run(self):
        for n, (svg, _, _) in self.out.items(): self.assertEqual(check_svg(svg), [], n)

    def test_one_glyph_a_member_and_the_lit_ones_are_the_rules(self):
        for n, vals, lit, kind in (("eu_cell", EU, EU_LIT, "cell"), ("eu_turbine", EU, EU_LIT, "turbine"), ("eu_fill", EU, EU_LIT, "cell"), ("wb", WB, WB_LOW5, "cell")):
            got = glyphs(self.out[n][0], kind)
            self.assertEqual(sorted(c for c, _ in got), sorted(vals), n)
            self.assertEqual({c for c, l in got if l}, lit, n)

    def test_the_lit_turbines_are_as_many_as_the_printed_count(self):
        svg = self.out["eu_turbine"][0]
        count = re.search(r'<tspan data-src="fact:n_lit">([0-9]+)</tspan>', svg)
        self.assertIsNotNone(count)
        lit = re.findall(r'<g class="glyph turbine" data-code="[A-Z0-9_]+" data-lit="1" fill="var\(--accent\)">', svg)
        self.assertEqual(len(lit), int(count.group(1)))
        self.assertEqual(len(re.findall(r'<g class="glyph turbine" data-code="[A-Z0-9_]+" data-lit="0" fill="var\(--bar\)">', svg)), len(EU) - len(EU_LIT))
        # a turbine is a tower, three blades and a hub
        one = re.search(r'<g class="glyph turbine" data-code="SE"[^>]*>(.*?)</g>', svg).group(1)
        self.assertEqual(one.count("<path"), 4); self.assertEqual(one.count("<circle"), 1)

    def test_the_fill_is_value_over_the_reference_capped_at_full(self):
        shares = dict(re.findall(r'class="glyph cell fill" data-code="([A-Z0-9_]+)" data-lit="[01]" data-share="([0-9.]+)"', self.out["eu_fill"][0]))
        self.assertEqual(set(shares), set(EU))
        for c, v in EU.items(): self.assertAlmostEqual(float(shares[c]), min(v / LEVEL, 1.0), places=3, msg=c)

    def test_the_orders(self):
        self.assertEqual([c for c, _ in glyphs(self.out["eu_cell"][0], "cell")], list(EU))
        svg = draw(eu(), sort="value")[0]
        self.assertEqual([c for c, _ in glyphs(svg, "cell")], sorted(EU, key=lambda c: (-EU[c], c)))
        svg = draw(wb(), sort="flag_first")[0]
        got = [c for c, _ in glyphs(svg, "cell")]
        self.assertEqual(set(got[:5]), WB_LOW5)

    def test_names_under_every_glyph_when_they_fit_else_only_the_lit(self):
        eu_names = re.findall(r'data-src="name:[^"]*:([A-Z0-9_]+)"', self.out["eu_cell"][0])
        self.assertEqual(sorted(eu_names), sorted(EU))
        wb_names = re.findall(r'data-src="name:[^"]*:([A-Z0-9_]+)"', self.out["wb"][0])
        self.assertEqual(set(wb_names), WB_LOW5)
        lit_only = re.findall(r'data-src="name:[^"]*:([A-Z0-9_]+)"', draw(eu(), show_names="lit")[0])
        self.assertEqual(set(lit_only), EU_LIT)

    def test_one_accent_and_none(self):
        svg = self.out["eu_cell"][0]
        self.assertEqual(len(re.findall(r'fill="var\(--accent\)" data-code="[A-Z]', svg)), len(EU_LIT))
        svg = draw(eu(), accent_when="none")[0]
        self.assertNotIn("var(--accent)", svg)


class Rules(unittest.TestCase):
    def refuse(self, want, shape=None, edit=None, **style):
        rows, data, names = shape or eu()
        if edit: edit(data, rows)
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, want):
            unit_grid.draw({"data": data, "style": {"unit_grid": style}})

    def test_a_printed_count_that_is_not_the_lit_cells_is_refused(self):
        self.refuse(r"printed count 6 \(fact:n_lit\) is not the number of lit cells the values give \(5\)", eu(count=6))
        self.refuse(r"printed count 4 .* \(5\)", wb(count=4))
        self.refuse("is no whole number", edit=lambda d, r: r.append({"src": "fact:n_txt", "text": "five"}) or d["count"].__setitem__("src", "fact:n_txt"))

    def test_a_flag_that_is_not_the_rule_over_its_cell_is_refused(self):
        self.refuse("member EE's flag True is not the rule over its cell", edit=lambda d, r: d["members"][7].__setitem__("flag", True))
        self.refuse("carries no flag", edit=lambda d, r: d["members"][0].pop("flag"))
        self.refuse("is no number", edit=lambda d, r: r.append({"src": "fact:lvl_txt", "text": "high"}) or d["rule"].__setitem__("ref", "fact:lvl_txt"))
        self.refuse("none of", edit=lambda d, r: d.__setitem__("rule", {"op": "about"}))
        self.refuse(r"k 8 is off 1\.\.7", wb(), edit=lambda d, r: d["rule"].__setitem__("k", 8))

    def test_a_cut_inside_a_tie_is_refused(self):
        vals = dict(WB); vals["IDN"] = vals["BRA"]   # the fifth and the sixth lowest hold one value
        shape = with_flags(build("co2", vals, WB_NAMES, "2024", {"op": "bottom", "k": 5}, 5), WB_LOW5)
        self.refuse("cut inside a tie", shape)

    def test_its_other_refusals(self):
        self.refuse("fewer than 8 members", edit=lambda d, r: d.__setitem__("members", d["members"][:7]))
        self.refuse("come twice", edit=lambda d, r: d["members"].append(dict(d["members"][0])))
        self.refuse("are not codes", edit=lambda d, r: d["members"][0].__setitem__("code", "no good"))
        self.refuse("is not a series of the request", edit=lambda d, r: d["members"][0].__setitem__("value", "series:nrg/ZZ:2025:OBS_VALUE"))
        self.refuse("printed total", edit=lambda d, r: r.__setitem__(next(i for i, x in enumerate(r) if x["src"] == "fact:n_all"), {"src": "fact:n_all", "text": "28"}))
        self.refuse("mode", edit=lambda d, r: d.__setitem__("mode", "dots"))
        self.refuse("flag mode only", eu("fill"), glyph="turbine")
        self.refuse("a digit", edit=lambda d, r: d.__setitem__("footnote", W("as of 2025")))
        self.refuse("wider than the board", width=300, cols=12)
        self.refuse("off its range", cols=40)
        self.refuse("no knob", dots=1)

    def test_names_that_overflow_are_refused(self):
        self.refuse("a name is wider than its column", wb(), show_names="all")
        long = {c: "A very long member name" for c in EU}
        self.refuse("overlap", build("nrg", EU, long, "2025", {"op": "ge", "ref": "fact:level"}, 5, ref_text="42.5%", flags=False)[:3],
                    edit=lambda d, r: [m.__setitem__("flag", m["code"] in EU_LIT) for m in d["members"]], show_names="lit", sort="flag_first")

    def test_the_file_holds_no_topic_word(self):
        with open(os.path.join(LEAVES, "unit_grid.py"), encoding="utf-8") as fh: src = fh.read().lower()
        for w in ("gas", "coal", "solar", "wind", "russia", "energy", "oil", "nuclear", "eurostat", "renewable", "\u4e16\u754c\u94f6\u884c", "\u6b27\u76df", "\u80fd\u6e90"):
            self.assertNotIn(w, src, w)


if __name__ == "__main__":
    unittest.main()
