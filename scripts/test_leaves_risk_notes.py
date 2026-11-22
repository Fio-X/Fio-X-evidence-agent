"""Self-test of the risk notes leaf (runtime/leaves_py/risk_notes.py) on two data shapes, test-only ledger texts and words
(layer 1 writes the real ones; the words come with the request):
  - a Eurostat renewables page: a kicker, a title and three caveats, one naming the latest year every series is final (a
    period entry) and one the target year;
  - a World Bank page: a title and two caveats, one naming how many economies lack the last year (a count fact).
Checks: the leaf draws every digit inside a marked ledger run; one bullet per item, each at its item's first line; no
accent (a caveat marks nothing); the items stack; the refusals keep the leaf's rules. With LEAF_SVG_DIR set, the themed
svg of each shape is kept there.
Run: python3 -I -B scripts/test_leaves_risk_notes.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import risk_notes  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
S = lambda s: {"src": s}

EU_LEDGER = {"period:nrg_ind_ren:2024": "2024", "fact:target_year.n": "2030"}
EU_DATA = dict(
    kicker=W("注意"), title=W("这页的数没有告诉你的"),
    items=[W("三种速度都是把过去的增速画成直线，不含今后的政策加码或倒退，是情景，不是预测。"),
           W("事件链只说明这些变化在时间上先后发生，不说明每一环都由上一环单独造成。"),
           [{"w": "「光伏成为单月最大电源」用的是月度初步数据，以后可能修订；"}, S("period:nrg_ind_ren:2024"),
            {"w": " 年是三块数据都齐全的最近一年，"}, S("fact:target_year.n"), {"w": " 年的位置是推算。"}]])

WB_LEDGER = {"fact:n_missing_last.n": "4", "period:SP.POP.65UP.TO.ZS@2:2025": "2025"}
WB_DATA = dict(
    title=W("这页的数没有告诉你的"),
    items=[[S("fact:n_missing_last.n"), {"w": " 个经济体缺最近一年的数，图里用的是它们最近有数的一年。"}],
           [S("period:SP.POP.65UP.TO.ZS@2:2025"), {"w": " 年的数是世界银行的估算，不是普查。"}]],
    footnote=W("数据来源：世界银行"))


def rows_of(ledger):
    return [{"src": k, "text": v} for k, v in ledger.items()]


def hero(data, **style):
    return {"data": data, "style": {"risk_notes": style}}


def draw(h, ledger=EU_LEDGER):
    K.setup(rows_of(ledger), {}, run.tables)
    return risk_notes.draw(h)


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


class Picture(unittest.TestCase):
    def test_eu_shape(self):
        svg, w, h = draw(hero(EU_DATA))
        keep("risk_notes_eu.svg", svg, w, h)
        self.assertEqual(check_svg(svg), [])
        self.assertNotIn("var(--accent)", svg)
        bullets = [float(m) for m in re.findall(r'<circle cx="[^"]+" cy="([^"]+)"', svg)]
        firsts = [float(m) for m in re.findall(r'<text x="24.0" y="([^"]+)"', svg)]
        self.assertEqual(len(bullets), 3); self.assertEqual(len(firsts), 3)
        for b, t in zip(bullets, firsts):
            self.assertAlmostEqual(t - b, 14 * 0.35, places=1)  # each bullet at its item's first line
        self.assertEqual(firsts, sorted(firsts))
        lines = [float(m) for m in re.findall(r'<tspan x="24.0" y="([^"]+)"', svg)]
        self.assertEqual(len(lines), 4)  # the last item wraps to a second line, under its first
        self.assertAlmostEqual(lines[3] - lines[2], 14 * 1.6, places=1)
        self.assertLess(lines[3], h - 12 + 0.5)

    def test_wb_shape(self):
        svg, w, h = draw(hero(WB_DATA, width=560, size=13), WB_LEDGER)
        keep("risk_notes_wb.svg", svg, w, h)
        self.assertEqual(check_svg(svg), [])
        self.assertEqual(len(re.findall("<circle", svg)), 2)

    def test_its_rules(self):
        d = json.loads(json.dumps(EU_DATA))

        def refused(data, ledger=EU_LEDGER, **style):
            with self.assertRaises(Refused) as e:
                draw(hero(data, **style), ledger)
            return str(e.exception)
        self.assertIn("no title", refused({**d, "title": []}))
        self.assertIn("one to 6", refused({**d, "items": []}))
        self.assertIn("one to 6", refused({**d, "items": d["items"] * 3}))
        self.assertIn("segments", refused({**d, "items": ["一句话"]}))
        self.assertIn("not a list of segments", refused({**d, "items": [[]]}))
        self.assertIn("digit", refused({**d, "items": [W("2024 年的数是初步的")]}))
        self.assertIn("not in the request's ledger", refused({**d, "items": [[S("fact:none.n")]]}))
        self.assertIn("lines", refused(d, width=360, item_lines=1))
        self.assertIn("lines", refused({**d, "title": W("这页的数没有告诉你的" * 6)}))
        self.assertIn("no knob", refused(d, colour="red"))


if __name__ == "__main__":
    unittest.main()
