"""Self-test of the dot-strip leaf (runtime/leaves_py/dot_strip.py) on two data shapes, with test-only ledger texts and words
(layer 1 writes the real ones: each row's values, the target, the simple averages and the ticks are its facts):
  - members x years: the 27 members' renewables share (a fetched table's rows, 2005 and 2025 copied as they are), one period
    row and two (the earlier a ghost row joined to the later), with the registered target and the members' simple average as rules;
  - group rows: the same members at 2025 in four sub-regions of the UN M49 standard (one member placed in no sub-region of the
    four is left out), one row per group, each group's simple average a tick, one member named.
Checks: one dot a member at its value's place; the lead dots in the accent and every other dot grey; the leaders' labels beside
their leaders and no two texts over each other; the target dashed and the average solid, each with its words; the average's
fixed word; the ghost row hollow and joined; every digit inside a marked ledger run; the refusals keep the leaf's rules; the
file holds no topic word. With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_dot_strip.py"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LEAVES = os.path.join(ROOT, "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import dot_strip  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402
from words import WORDS  # noqa: E402

W = lambda t: [{"w": t}]
# nrg_ind_ren, nrg_bal REN, unit PC: the members' rows at 2005 and 2025 (2025 provisional), as fetched
REN = {"AT": (24.353, 44.2), "BE": (2.325, 14.9), "BG": (9.173, 22.7), "CY": (3.131, 21.5), "CZ": (7.113, 19.1), "DE": (7.167, 23.9),
       "DK": (15.955, 48.2), "EE": (17.478, 42.3), "EL": (7.277, 26.9), "ES": (8.444, 26.0), "FI": (28.814, 53.0), "FR": (9.272, 23.9),
       "HR": (23.691, 28.5), "HU": (6.931, 19.6), "IE": (2.822, 17.2), "IT": (7.549, 20.5), "LT": (16.768, 38.5), "LU": (1.402, 20.2),
       "LV": (32.264, 46.3), "MT": (0.123, 18.8), "NL": (2.478, 22.7), "PL": (6.867, 18.7), "PT": (19.523, 36.7), "RO": (17.571, 25.6),
       "SE": (39.982, 65.4), "SI": (19.809, 25.4), "SK": (6.36, 16.3)}
NAMES = {"AT": "Austria", "BE": "Belgium", "BG": "Bulgaria", "CY": "Cyprus", "CZ": "Czechia", "DE": "Germany", "DK": "Denmark", "EE": "Estonia",
         "EL": "Greece", "ES": "Spain", "FI": "Finland", "FR": "France", "HR": "Croatia", "HU": "Hungary", "IE": "Ireland", "IT": "Italy",
         "LT": "Lithuania", "LU": "Luxembourg", "LV": "Latvia", "MT": "Malta", "NL": "Netherlands", "PL": "Poland", "PT": "Portugal",
         "RO": "Romania", "SE": "Sweden", "SI": "Slovenia", "SK": "Slovakia"}
# UN M49 sub-regions of the members (the knowledge group's table; Cyprus is in Western Asia and left out here)
M49 = {"west": ["AT", "BE", "DE", "FR", "LU", "NL"], "east": ["BG", "CZ", "HU", "PL", "RO", "SK"],
       "north": ["DK", "EE", "FI", "IE", "LT", "LV", "SE"], "south": ["ES", "EL", "HR", "IT", "MT", "PT", "SI"]}
GROUP_WORDS = {"west": "Western Europe", "east": "Eastern Europe", "north": "Northern Europe", "south": "Southern Europe"}
T = "nrg_ind_ren"


def cell(c, y, v): return {"src": f"series:{T}/{c}:{y}:OBS_VALUE", "table": T, "dims": {"geo": c}, "time": y, "value": v}


def strip(periods=2, refs=True, lead=None, codes=None):
    """The members x years shape: rows, data, names."""
    codes = codes or list(REN)
    rows, out = [], []
    for c in codes:
        b, a = REN[c]
        rows += [cell(c, "2005", b), cell(c, "2025", a), {"src": f"fact:v25_{c.lower()}", "text": f"{a:.1f}"}, {"src": f"fact:v05_{c.lower()}", "text": f"{b:.1f}"}]
        r = {"code": c, "a": f"series:{T}/{c}:2025:OBS_VALUE", "a_text": f"fact:v25_{c.lower()}"}
        if periods == 2: r.update(b=f"series:{T}/{c}:2005:OBS_VALUE", b_text=f"fact:v05_{c.lower()}")
        out.append(r)
    mean = sum(REN[c][1] for c in codes) / len(codes)
    rows += [{"src": f"period:{T}:2005", "text": "2005"}, {"src": f"period:{T}:2025", "text": "2025"},
             {"src": "fact:target", "text": "42.5"}, {"src": "fact:mean25", "text": f"{mean:.1f}"}]
    rows += [{"src": f"fact:tick{v}", "text": str(v)} for v in (0, 20, 40, 60)]
    rows += [{"src": K.name_row(c, "place"), "text": NAMES[c]} for c in codes]
    data = {"title": W("Renewables share"), "unit": W("percent"), "rows": out,
            "periods": [f"period:{T}:2005", f"period:{T}:2025"] if periods == 2 else [f"period:{T}:2025"],
            "ticks": [f"fact:tick{v}" for v in (0, 20, 40, 60)], "footnote": W("The average is the simple average of the members, not weighted by consumption")}
    if refs: data["refs"] = [{"kind": "target", "text": "fact:target", "label": W("Target")}, {"kind": "mean", "text": "fact:mean25"}]
    if lead is not None: data["lead"] = lead
    return rows, data, {c: NAMES[c] for c in codes}


def grouped():
    """The group-rows shape: the members at 2025, one row per M49 sub-region, each group's simple average."""
    rows, out, groups = [], [], []
    for g, codes in M49.items():
        for c in codes:
            a = REN[c][1]
            rows += [cell(c, "2025", a), {"src": f"fact:v25_{c.lower()}", "text": f"{a:.1f}"}]
            out.append({"code": c, "a": f"series:{T}/{c}:2025:OBS_VALUE", "a_text": f"fact:v25_{c.lower()}", "group": g})
        rows.append({"src": f"fact:mean_{g}", "text": f"{sum(REN[c][1] for c in codes) / len(codes):.1f}"})
        groups.append({"id": g, "label": W(GROUP_WORDS[g]), "mean": f"fact:mean_{g}"})
    rows += [{"src": f"period:{T}:2025", "text": "2025"}, {"src": "fact:target", "text": "42.5"}]
    codes = [c for cs in M49.values() for c in cs]
    rows += [{"src": K.name_row(c, "place"), "text": NAMES[c]} for c in codes]
    data = {"title": W("Renewables share"), "unit": W("percent"), "rows": out, "periods": [f"period:{T}:2025"], "groups": groups,
            "refs": [{"kind": "target", "text": "fact:target", "label": W("Target")}], "lead": ["IE", "SE"],
            "footnote": W("A group average is the simple average of its members")}
    return rows, data, {c: NAMES[c] for c in codes}


def draw(shape, **style):
    rows, data, names = shape
    K.setup(rows, names, run.tables)
    return dot_strip.draw({"data": data, "style": {"dot_strip": style}})


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


def dots(svg, period=None):
    """{code: (cx, attrs)} of the later dots (or the earlier ones)."""
    out = {}
    for m in re.finditer(r'<circle cx="([0-9.]+)" cy="([0-9.]+)"([^>]*)data-code="([A-Z]+)"( data-period="earlier")?/>', svg):
        if bool(m.group(5)) == (period == "earlier"): out[m.group(4)] = (float(m.group(1)), float(m.group(2)), m.group(3))
    return out


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = {"one": draw(strip(periods=1)), "two": draw(strip(periods=2), periods=2), "two_narrow": draw(strip(periods=2), periods=2, width=560),
                   "groups": draw(grouped(), lead_set="given")}
        if os.environ.get("LEAF_SVG_DIR"):
            os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
            for n, (svg, w, h) in cls.out.items():
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"dot_strip-{n}.svg"), "w", encoding="utf-8") as fh: fh.write(themed(svg, w, h))

    def test_every_digit_is_a_marked_ledger_run(self):
        for n, (svg, _, _) in self.out.items(): self.assertEqual(check_svg(svg), [], n)

    def test_one_dot_a_member_at_its_value(self):
        for n in ("one", "two", "two_narrow"):
            got = dots(self.out[n][0])
            self.assertEqual(set(got), set(REN), n)
            order = sorted(REN, key=lambda c: (REN[c][1], c))
            xs = [got[c][0] for c in order]
            self.assertEqual(xs, sorted(xs), n)   # position = value
            self.assertEqual(len({got[c][1] for c in REN}), 1, n)   # one row

    def test_the_lead_dots_are_the_accent_and_every_other_dot_grey(self):
        lead = {"SE", "FI", "DK", "BE", "SK", "IE"}   # the three highest and the three lowest at 2025
        for n in ("one", "two"):
            got = dots(self.out[n][0])
            self.assertEqual({c for c, (_, _, a) in got.items() if "var(--accent)" in a}, lead, n)
            for c in set(REN) - lead: self.assertIn('fill="var(--t-sec)"', got[c][2])
            self.assertEqual(len(re.findall(r'data-leader="lead ', self.out[n][0])), 6, n)

    def test_the_target_is_dashed_and_the_average_solid_each_with_its_words(self):
        for n in ("one", "two", "two_narrow"):
            svg = self.out[n][0]
            self.assertRegex(svg, r'stroke-dasharray="5 4" data-ref="target"')
            mean = re.findall(r'<line [^>]*data-ref="mean"[^>]*/>', svg)
            self.assertEqual(len(mean), 1 if n == "one" else 2, n)   # with two period rows the average's rule breaks over the earlier row
            self.assertTrue(all("dasharray" not in m for m in mean), n)
            self.assertIn(WORDS["dot.mean"], svg)
            self.assertIn('data-src="fact:mean25"', svg); self.assertIn('data-src="fact:target"', svg)
            self.assertNotIn("\u6b27\u76df", svg)   # the whole's name: the average is never called the whole
            # the target rule stands at 42.5 on the dots' scale: between Estonia (42.3) and Austria (44.2)
            x = float(re.search(r'<line x1="([0-9.]+)"[^>]*data-ref="target"', svg).group(1))
            got = dots(svg)
            self.assertLess(got["EE"][0], x); self.assertLess(x, got["AT"][0])

    def test_the_ghost_row_is_hollow_above_and_joined(self):
        svg = self.out["two"][0]
        early, late = dots(svg, "earlier"), dots(svg)
        self.assertEqual(set(early), set(REN))
        for c in REN:
            self.assertIn('fill="none"', early[c][2]); self.assertLess(early[c][1], late[c][1])
        self.assertEqual(len(re.findall(r"data-join=", svg)), 27)
        off = draw(strip(periods=2), periods=2, ghost_period="off")[0]
        self.assertEqual(re.findall(r"data-join=", off), [])
        self.assertTrue(all('fill="none"' not in a for _, _, a in dots(off, "earlier").values()))
        # a lead label prints the earlier value, then the later one
        self.assertRegex(svg, r'data-src="fact:v05_se">40\.0</tspan></tspan><tspan[^>]*> → </tspan><tspan[^>]*><tspan data-src="fact:v25_se">65\.4')

    def test_group_rows_each_with_its_average_tick(self):
        svg = self.out["groups"][0]
        got = dots(svg)
        self.assertEqual(set(got), {c for cs in M49.values() for c in cs})
        rows_y = [got[cs[0]][1] for cs in M49.values()]
        self.assertEqual(rows_y, sorted(rows_y)); self.assertEqual(len(set(rows_y)), 4)
        for g, cs in M49.items():
            self.assertEqual({got[c][1] for c in cs}, {got[cs[0]][1]}, g)
            self.assertIn(f'data-mean="{g}"', svg); self.assertIn(f'data-src="fact:mean_{g}"', svg)
        self.assertIn(WORDS["dot.group_mean"], svg)
        self.assertEqual({c for c, (_, _, a) in got.items() if "var(--accent)" in a}, {"IE", "SE"})

    def test_a_narrower_board_still_holds_every_label(self):
        svg, w, h = self.out["two_narrow"]
        self.assertEqual(w, 560); self.assertTrue(svg.startswith(f'<svg class="dot_strip" viewBox="0 0 560 {h}"'))

    def test_the_lead_set_knob(self):
        svg = draw(strip(periods=1), lead_set="top", lead_k=2)[0]
        self.assertEqual({c for c, (_, _, a) in dots(svg).items() if "var(--accent)" in a}, {"SE", "FI"})
        svg = draw(strip(periods=1, lead=["MT", "LU"]), lead_set="given")[0]
        self.assertEqual({c for c, (_, _, a) in dots(svg).items() if "var(--accent)" in a}, {"MT", "LU"})
        svg = draw(strip(periods=1), refs="target")[0]
        self.assertIn('data-ref="target"', svg); self.assertNotIn('data-ref="mean"', svg)


class Rules(unittest.TestCase):
    def refuse(self, want, edit=None, shape=None, **style):
        rows, data, names = shape or strip(periods=1)
        if edit: edit(data, rows)
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, want):
            dot_strip.draw({"data": data, "style": {"dot_strip": style}})

    def test_its_refusals(self):
        self.refuse("fewer than 4 rows", lambda d, r: d.__setitem__("rows", d["rows"][:3]))
        self.refuse("come twice", lambda d, r: d["rows"].append(dict(d["rows"][0])))
        self.refuse("are not codes", lambda d, r: d["rows"][0].__setitem__("code", "no good"))
        self.refuse("is not a series of the request", lambda d, r: d["rows"][0].__setitem__("a", f"series:{T}/ZZ:2025:OBS_VALUE"))
        self.refuse("lacks its value's ledger entry", lambda d, r: d["rows"][0].pop("a_text"))
        self.refuse("lacks its earlier cell", lambda d, r: d["rows"][0].pop("b"), shape=strip(periods=2), periods=2)
        self.refuse("is not its row's period", lambda d, r: d.__setitem__("periods", [f"period:{T}:2005"]))
        # a lead code that is no row
        self.refuse("lead names \\['ZZ'\\], no row", lambda d, r: d.__setitem__("lead", ["SE", "ZZ"]), lead_set="given")
        self.refuse("lead_set is 'both', not given", lambda d, r: d.__setitem__("lead", ["SE"]))
        # a ref with no ledger text, a target with no words, a mean the leaf would have to name otherwise, a mean that is no average
        self.refuse("names no text", lambda d, r: d["refs"][0].pop("text"))
        self.refuse("names no text", lambda d, r: d["refs"][1].__setitem__("text", ""))
        self.refuse("is not in the request's ledger", lambda d, r: d["refs"][0].__setitem__("text", "fact:nowhere"))
        self.refuse("label is not a list of segments", lambda d, r: d["refs"][0].pop("label"))
        self.refuse("the mean ref takes no label", lambda d, r: d["refs"][1].__setitem__("label", W("Average")))
        self.refuse("not the simple average", lambda d, r: d["refs"][1].__setitem__("text", "fact:target"))
        self.refuse("is of no kind", lambda d, r: d["refs"][0].__setitem__("kind", "median"))
        self.refuse("the whole ref names no cell", lambda d, r: d["refs"].append({"kind": "whole", "text": "fact:target", "label": W("Whole")}))
        self.refuse("a digit", lambda d, r: d.__setitem__("footnote", W("27 members")))
        self.refuse("no knob", dots=1)
        self.refuse("off its range", width=300)
        # groups
        self.refuse("takes no groups", shape=grouped(), lead_set="given", periods=2)
        self.refuse("in no group", lambda d, r: d["rows"][0].__setitem__("group", "nowhere"), shape=grouped(), lead_set="given")
        self.refuse("group south's mean prints", lambda d, r: d["groups"][3].__setitem__("mean", "fact:mean_north"), shape=grouped(), lead_set="given")

    def test_overlapping_labels_are_refused(self):
        # every member named, one tier a side: the labels of the crowded middle cannot all find a free place
        self.refuse("finds no free tier", lambda d, r: d.__setitem__("lead", list(REN)[:12]), lead_set="given", levels=1)

    def test_too_narrow_is_refused(self):
        # the width's floor is 480 px: the plot falls under 240 px when the row labels are long
        rows, data, names = grouped()
        data["groups"][0]["label"] = W("A group whose name runs on and on and on and on and on and on and on")
        K.setup(rows, names, run.tables)
        with self.assertRaisesRegex(Refused, "too narrow"):
            dot_strip.draw({"data": data, "style": {"dot_strip": {"width": 480, "lead_set": "given"}}})

    def test_the_file_holds_no_topic_word(self):
        with open(os.path.join(LEAVES, "dot_strip.py"), encoding="utf-8") as fh: src = fh.read().lower()
        for w in ("renewable", "solar", "wind", "energy", "eurostat", "\u6b27\u76df", "\u80fd\u6e90", "\u53ef\u518d\u751f"):
            self.assertNotIn(w, src, w)
        self.assertEqual(WORDS["dot.mean"], "\u6210\u5458\u56fd\u7b80\u5355\u5e73\u5747")   # the members' simple average, as decided


if __name__ == "__main__":
    unittest.main()
