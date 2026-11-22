"""Self-test of the thesis leaf (runtime/leaves_py/thesis_claims.py) on two data shapes, test-only ledger texts and words (layer 1
writes the real ones: each number its fact, the words from the request):
  - a Eurostat renewables page: three claims, each number a share or a yearly pace in percentage points, bodies citing
    two more entries each;
  - a World Bank ageing page: two claims over a few economies, a share and a count of years, one body only.
Checks: the leaf draws every digit inside a marked ledger run; one accent only (the claims' numbers); the blocks stack (each
claim's lead under the one before, the section at the right of its lead's line); the refusals keep the leaf's rules.
With LEAF_SVG_DIR set, the themed svg of each shape is kept there.
Run: python3 -I -B scripts/test_leaves_thesis.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import run  # noqa: E402
import thesis_claims  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
S = lambda s: {"src": s}

EU_LEDGER = {"fact:elc_rise.n": "+28.4", "fact:pv_add_2019.n": "16.0", "fact:pv_add_2024.n": "65.5",
             "fact:rate_ren_heat_cl.n": "0.9", "fact:rate_ren_tra.n": "0.6", "fact:proj_ren_best_2030.n": "39.3%",
             "fact:target_2030.n": "42.5%", "period:nrg_ind_ren:2024": "2024"}
EU_DATA = dict(
    answer=W("电力在变，整体太慢：照现在的路，欧盟到不了它给自己定的目标。"),
    claims=[dict(num="fact:elc_rise.n", head=W("电力在变。"),
                 body=[{"w": "光伏年新增装机从 "}, S("fact:pv_add_2019.n"), {"w": " 吉瓦增到 "}, S("fact:pv_add_2024.n"), {"w": " 吉瓦。"}],
                 section=W("见一、二")),
            dict(num="fact:rate_ren_heat_cl.n", head=W("整体太慢。"),
                 body=[{"w": "供暖和制冷、交通近五年每年只涨 "}, S("fact:rate_ren_heat_cl.n"), {"w": " 和 "}, S("fact:rate_ren_tra.n"),
                       {"w": " 个百分点。"}], section=W("见三")),
            dict(num="fact:proj_ren_best_2030.n", head=W("照现在的路到不了。"),
                 body=[{"w": "最快的一年年年重演，也只到 "}, S("fact:proj_ren_best_2030.n"), {"w": "，目标是 "}, S("fact:target_2030.n"), {"w": "。"}],
                 section=W("见四"))],
    footnote=W("数字的出处见各节"))

WB_LEDGER = {"fact:jpn_65_2025.n": "29.8%", "fact:kor_years_14_20.n": "7", "fact:kor_65_2025.n": "20.6%"}
WB_DATA = dict(
    answer=W("老得最快的不是最老的国家"),
    claims=[dict(num="fact:jpn_65_2025.n", head=W("日本仍是最老的。"), section=W("见图一")),
            dict(num="fact:kor_years_14_20.n", head=W("韩国走完同一段路只用了几年。"),
                 body=[{"w": "老年人口占比到了 "}, S("fact:kor_65_2025.n"), {"w": "。"}], section=W("见图二"))])


def rows_of(ledger):
    return [{"src": k, "text": v} for k, v in ledger.items()]


def hero(data, **style):
    return {"data": data, "style": {"thesis_claims": style}}


def draw(h, ledger=EU_LEDGER):
    K.setup(rows_of(ledger), {}, run.tables)
    return thesis_claims.draw(h)


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


def ys(svg, src):
    """The y of the text that prints the ledger entry `src` first."""
    m = re.search(r'<text[^>]* y="([^"]+)"[^>]*>(?:(?!</text>).)*data-src="' + re.escape(src) + '"', svg)
    return float(m.group(1))


class Picture(unittest.TestCase):
    def test_eu_shape(self):
        svg, w, h = draw(hero(EU_DATA))
        keep("thesis_eu.svg", svg, w, h)
        self.assertEqual(check_svg(svg), [])
        # one accent only: the three numbers
        self.assertEqual(svg.count("var(--accent)"), 3)
        nums = [ys(svg, c["num"]) for c in EU_DATA["claims"]]
        self.assertEqual(nums, sorted(nums))
        self.assertGreater(min(b - a for a, b in zip(nums, nums[1:])), 15 * 1.5 * 2)  # each block holds its lead and its body
        # each section at the right edge of its lead's line
        self.assertEqual(len(re.findall(rf'<text x="{w - 8:.1f}" y="[^"]+" font-size="12" text-anchor="end"', svg)), 3)

    def test_wb_shape_two_claims_one_with_no_body(self):
        svg, w, h = draw(hero(WB_DATA, width=640), WB_LEDGER)
        keep("thesis_wb.svg", svg, w, h)
        self.assertEqual(check_svg(svg), [])
        self.assertEqual(svg.count("var(--accent)"), 2)
        self.assertLess(h, draw(hero(EU_DATA, width=640))[2])

    def test_its_rules(self):
        d = json.loads(json.dumps(EU_DATA))

        def refused(data, ledger=EU_LEDGER, **style):
            with self.assertRaises(Refused) as e:
                draw(hero(data, **style), ledger)
            return str(e.exception)
        # a page whose headline is its answer gives none: the claims alone, from the top, and shorter than with one
        bare = {k: v for k, v in d.items() if k != "answer"}
        svg, w, h = draw(hero(bare))
        self.assertEqual(check_svg(svg), [])
        self.assertLess(h, draw(hero(d))[2])
        self.assertEqual(draw(hero({**d, "answer": []}))[2], h)
        self.assertIn("two to four", refused({**d, "claims": d["claims"][:1]}))
        self.assertIn("two to four", refused({**d, "claims": d["claims"] * 2}))
        for key in ("num", "head", "section"):
            self.assertIn(f"has no {key}", refused({**d, "claims": [{k: v for k, v in c.items() if k != key} for c in d["claims"]]}))
        self.assertIn("not in the request's ledger", refused({**d, "claims": [dict(d["claims"][0], num="fact:none.n")] + d["claims"][1:]}))
        self.assertIn("holds no digit", refused(d, ledger={**EU_LEDGER, "fact:elc_rise.n": "多"}))
        self.assertIn("digit", refused({**d, "claims": [dict(d["claims"][0], head=W("第1条"))] + d["claims"][1:]}))
        self.assertIn("lines", refused({**d, "answer": W("很长的答案" * 30)}))
        self.assertIn("lines", refused(d, width=400, body_lines=1))
        self.assertIn("too narrow", refused(d, width=400, num_size=48, size=11))
        self.assertIn("overlap", refused({**d, "claims": [dict(d["claims"][0], section=W("见第一节和第二节以及后面几节" * 2))] + d["claims"][1:]},
                                         width=400))


if __name__ == "__main__":
    unittest.main()
