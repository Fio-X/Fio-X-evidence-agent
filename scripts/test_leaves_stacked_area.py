"""Self-test of the stacked area leaf (runtime/leaves_py/stacked_area.py): three parts of a whole over seven years, test-only
values, ledger texts and names (layer 1 writes the real ones: each end value its fact, each tick next_facts::ticks over
the parts' summed peak, each name a reviewed name row).
Checks: the leaf draws every digit inside a marked ledger run; the bands stack: each band's lower edge is the upper edge of
the one below and the top band's upper edge is the whole at every period; one accent only (the highlighted band); no tick
line crosses a band (ticks are short marks left of the plot); the refusals keep the leaf's rules (a hole in one part, an
axis below the stacked top, too many parts). With LEAF_SVG_DIR set, the themed svg is kept there.
Run: python3 -I -B scripts/test_leaves_stacked_area.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import run  # noqa: E402
import stacked_area  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
TABLE = "nrg_bal_c"
KIND = "siec_group"
YEARS = [str(y) for y in range(2018, 2025)]
PARTS = {"O4000XBIO": [90, 88, 80, 84, 83, 82, 81], "G3000": [60, 61, 58, 60, 55, 56, 58], "RA000": [35, 38, 41, 43, 45, 48, 50]}
NAMES = {"O4000XBIO": "石油", "G3000": "天然气", "RA000": "可再生能源"}  # test-only names


def src(code, y):
    return f"series:{TABLE}/{code}:{y}:OBS_VALUE"


def build(parts=PARTS, years=YEARS, skip=(), ticks=(50, 100, 150, 200)):
    rows, items = [], []
    for c, vals in parts.items():
        for y, v in zip(years, vals):
            if (c, y) in skip: continue
            rows.append({"src": src(c, y), "table": TABLE, "dims": {"siec": c, "geo": "EU27_2020"}, "time": y, "value": v})
        rows.append({"src": f"fact:{c.lower()}_end", "text": f"{vals[-1]:.1f}"})
        items.append({"code": c, "end_text": f"fact:{c.lower()}_end"})
    for i, t in enumerate(ticks, 1):
        rows.append({"src": f"fact:top.tick{i}", "text": str(t)})
    for y in years:
        rows.append({"src": f"period:{TABLE}:{y}", "text": y})
    data = dict(title=W("能源供应的构成变化"), unit=W("百万吨油当量"), part_kind=KIND,
                q={"table": TABLE, "by": "siec", "filter": {"geo": "EU27_2020"}}, parts=items, axis={"of": "top", "scale": 1},
                footnote=W("数据来源：欧盟统计局"))
    return rows, data


ROWS, DATA = build()


def hero(data, **style):
    return {"data": data, "style": {"stacked_area": style}}


def draw(h, rows=ROWS, names=NAMES):
    K.setup(rows, names, run.tables)
    return stacked_area.draw(h)


def check_svg(svg):
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def bands(svg):
    """(code, fill, upper [(x, y)], lower [(x, y)] left to right) of every band, bottom up."""
    out = []
    for m in re.finditer(r'<polygon points="([^"]+)" fill="([^"]+)"[^>]*data-code="([^"]+)"/>', svg):
        pts = [tuple(float(v) for v in p.split(",")) for p in m.group(1).split()]
        n = len(pts) // 2
        out.append((m.group(3), m.group(2), pts[:n], pts[n:][::-1]))
    return out


def themed(svg, w, h):
    css = ("<style>svg{--accent:#c93f2b;--t-title:#292928;--t-dark:#1f1e1d;--t-body:#4d4d4d;--t-sec:#707070;--bar:#c9c9c9;--empty:#e5e5e5;--bg:#fff;--rule:#ececec;"
           + K.page_vars("#c93f2b") + "}</style>")
    return svg.replace(">", f">{css}<rect width='{w}' height='{h}' fill='#fff'/>", 1)


class Picture(unittest.TestCase):
    def setUp(self):
        self.svg, self.w, self.h = draw(hero(DATA, highlight="RA000"))
        if os.environ.get("LEAF_SVG_DIR"):
            with open(os.path.join(os.environ["LEAF_SVG_DIR"], "stacked_area.svg"), "w", encoding="utf-8") as fh:
                fh.write(themed(self.svg, self.w, self.h))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        self.assertEqual(check_svg(self.svg), [])

    def test_the_bands_stack_to_the_whole(self):
        b = bands(self.svg)
        self.assertEqual([x[0] for x in b], list(PARTS))
        for below, above in zip(b, b[1:]):
            self.assertEqual([round(y, 1) for _, y in below[2]], [round(y, 1) for _, y in above[3]])
        # the top edge over the baseline is the whole at each period, on one scale
        base = b[0][3][0][1]
        heights = [base - y for _, y in b[-1][2]]
        wholes = [sum(v[i] for v in PARTS.values()) for i in range(len(YEARS))]
        ratios = [h / w for h, w in zip(heights, wholes)]
        self.assertLess(max(ratios) - min(ratios), 0.01)

    def test_one_accent_and_no_tick_line_across_the_bands(self):
        self.assertEqual([x[0] for x in bands(self.svg) if x[1] == "var(--accent)"], ["RA000"])
        x0 = min(p[0] for x in bands(self.svg) for p in x[2])
        for m in re.finditer(r'<line x1="([^"]+)" y1="[^"]+" x2="([^"]+)" y2="[^"]+" stroke="var\(--t-title\)"', self.svg):
            a, c = float(m.group(1)), float(m.group(2))
            self.assertTrue(c <= x0 + 0.5 or a == c or a >= x0 - 0.5, "a tick line runs into the plot")

    def test_its_rules(self):
        d = json.loads(json.dumps(DATA))

        def refused(data, rows=ROWS, **style):
            with self.assertRaises(Refused) as e:
                draw(hero(data, **style), rows)
            return str(e.exception)
        self.assertIn("fewer than two parts", refused({**d, "parts": d["parts"][:1]}))
        self.assertIn("twice", refused({**d, "parts": d["parts"] + d["parts"][:1]}))
        holed, _ = build(skip={("G3000", "2021")})
        self.assertIn("hole", refused(d, rows=holed))
        low, _ = build(ticks=(50, 100))
        self.assertIn("below the stacked top", refused(d, rows=low))
        self.assertIn("no tick", refused({**d, "axis": {"of": "none", "scale": 1}}))
        neg = [dict(r, value=-1.0) if r.get("src") == src("G3000", "2020") else r for r in ROWS]
        self.assertIn("below 0", refused(d, rows=neg))
        more = {f"P{i}": [10] * len(YEARS) for i in range(6)}
        rows6, d6 = build(parts=more, ticks=(20, 40, 60))
        self.assertIn("greys", refused(d6, rows=rows6))
        self.assertIn("part_kind", refused({**d, "part_kind": ""}))
        self.assertIn("highlight", refused(d, highlight="XX") + "highlight")
        self.assertIn("digit", refused({**d, "title": W("2024 年能源")}))
        no_periods = [r for r in ROWS if not r["src"].startswith("period:")]
        self.assertIn("no period entry", refused(d, rows=no_periods))


if __name__ == "__main__":
    unittest.main()
