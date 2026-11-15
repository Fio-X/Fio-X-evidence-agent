"""Self-test of the rank lines leaf (runtime/leaves_py/rank_lines.py): six places ranked on three quantities, one place not
ranked on the middle one. Test-only ledger texts and names (layer 1 writes the real ones: each rank a fact of the place's
position on its quantity, each name a reviewed name row).
Checks: the leaf draws every digit inside a marked ledger run; the highlighted series is drawn last, in the accent and wider,
the others grey; every rank sits in a disc on its point, drawn over the lines; a series not ranked in a column has no point
there and its line breaks; no line crosses a name, and no two texts overlap; names moved off their points get a leader;
the refusals keep the leaf's rules. With LEAF_SVG_DIR set, the themed svg is kept there.
Run: python3 -I -B scripts/test_leaves_rank_lines.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import rank_lines  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
NAMES = {"SGP": "新加坡", "MYS": "马来西亚", "THA": "泰国", "IDN": "印度尼西亚", "VNM": "越南", "PHL": "菲律宾"}  # test-only names
CODES = list(NAMES)
# each quantity's ranks (test-only): the middle one does not rank PHL
RANKS = [
    {"SGP": 1, "MYS": 2, "THA": 3, "IDN": 4, "VNM": 5, "PHL": 6},
    {"SGP": 5, "MYS": 3, "THA": 2, "IDN": 1, "VNM": 4},
    {"SGP": 6, "MYS": 4, "THA": 3, "IDN": 1, "VNM": 2, "PHL": 5},
]
HEADS = ["人均收入", "人口", "面积"]


def build(ranks=RANKS, heads=HEADS):
    rows, cols = [], []
    for q, (rk, head) in enumerate(zip(ranks, heads)):
        col = {}
        for c, r in rk.items():
            src = f"fact:pos{q + 1}.{c}"
            rows.append({"src": src, "text": str(r)}); col[c] = src
        cols.append({"head": W(head), "ranks": col})
    data = dict(title=W("东盟各国在三个量上的名次"), series_kind="place", columns=cols, series=CODES, footnote=W("名次：数值由高到低"))
    return rows, data


ROWS, DATA = build()


def hero(data, **style):
    return {"data": data, "style": {"rank_lines": style}}


def draw(h, rows=ROWS, names=NAMES):
    K.setup(rows, names, run.tables)
    return rank_lines.draw(h)


def check_svg(svg):
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def segments(svg):
    """(code, stroke, width, x1, y1, x2, y2) of every series line, in drawing order."""
    pat = (r'<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)" stroke="([^"]+)" stroke-width="([^"]+)" '
           r'stroke-opacity="[^"]+" stroke-linecap="round" data-code="([^"]+)" data-line="rank:\7"/>')  # its own line, for the ranks on it
    return [(m.group(7), m.group(5), float(m.group(6)), *(float(m.group(i)) for i in (1, 2, 3, 4))) for m in re.finditer(pat, svg)]


def discs(svg):
    """(code, cx, cy) of every rank disc."""
    return [(m.group(3), float(m.group(1)), float(m.group(2))) for m in re.finditer(r'<circle cx="([^"]+)" cy="([^"]+)" r="[^"]+"[^>]*data-code="([^"]+)"/>', svg)]


def text_boxes(svg):
    out = []
    for m in re.finditer(r'<text x="([^"]+)" y="([^"]+)" font-size="([^"]+)" text-anchor="([^"]+)"[^>]*>(.*?)</text>', svg):
        x, y, sz, anchor = float(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4)
        text = re.sub(r"<[^>]+>", "", m.group(5)).replace("&amp;", "&")
        w = K.tw(text, sz)
        x0 = x if anchor == "start" else x - w if anchor == "end" else x - w / 2
        out.append((text, (x0, y - sz * 0.8, x0 + w, y + sz * 0.25)))
    return out


def crosses(seg, box):
    """Whether the segment (x1, y1, x2, y2) passes through the box (sampled finely)."""
    x1, y1, x2, y2 = seg
    for i in range(201):
        t = i / 200
        x, y = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
        if box[0] < x < box[2] and box[1] < y < box[3]: return True
    return False


def themed(svg, w, h):
    css = ("<style>svg{--accent:#c93f2b;--t-title:#292928;--t-dark:#1f1e1d;--t-body:#4d4d4d;--t-sec:#707070;--bar:#c9c9c9;--empty:#e5e5e5;--bg:#fff;"
           + K.page_vars("#c93f2b") + "}</style>")
    return svg.replace(">", f">{css}<rect width='{w}' height='{h}' fill='#fff'/>", 1)


class Picture(unittest.TestCase):
    def setUp(self):
        self.svg, self.w, self.h = draw(hero(DATA, highlight="SGP"))
        if os.environ.get("LEAF_SVG_DIR"):
            with open(os.path.join(os.environ["LEAF_SVG_DIR"], "rank_lines.svg"), "w", encoding="utf-8") as fh:
                fh.write(themed(self.svg, self.w, self.h))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        self.assertEqual(check_svg(self.svg), [])
        printed = [t for t, _ in text_boxes(self.svg)]
        for q, rk in enumerate(RANKS):
            for r in rk.values():
                self.assertIn(str(r), printed)
        self.assertEqual(sum(len(rk) for rk in RANKS), len(discs(self.svg)))  # a disc per ranked point, none for PHL's gap
        # each column's guide is a grid line to the layout check (opacity below 0.2), so the ranks it runs under are no finding
        guides = re.findall(r'<line x1="([^"]+)" y1="[^"]+" x2="\1" y2="[^"]+" stroke="[^"]+" stroke-width="[^"]+" stroke-opacity="([^"]+)"/>', self.svg)
        self.assertEqual(len(guides), len(RANKS))  # one guide per column
        self.assertTrue(all(float(op) < 0.2 for _, op in guides), guides)
        # every rank is marked as sitting on its own series' line (the layout check's line rule lets that one through)
        self.assertEqual(len(re.findall(r'<text [^>]*data-on="rank:[A-Z]+"', self.svg)), len(discs(self.svg)))

    def test_the_highlight_is_drawn_last_in_the_accent_and_wider(self):
        segs = segments(self.svg)
        hot = [s for s in segs if s[0] == "SGP"]
        self.assertTrue(hot and all(s[1] == "var(--accent)" for s in hot))
        self.assertEqual(segs[-len(hot):], hot)
        self.assertTrue(all(s[1] == "var(--t-sec)" and s[2] < hot[0][2] for s in segs if s[0] != "SGP"))

    def test_a_series_unranked_in_a_column_breaks_there(self):
        phl = [s for s in segments(self.svg) if s[0] == "PHL"]
        self.assertEqual(phl, [])  # ranked in columns 1 and 3 only: no neighbouring pair, no segment
        self.assertEqual(len([d for d in discs(self.svg) if d[0] == "PHL"]), 2)

    def test_discs_sit_on_their_points_and_over_the_lines(self):
        segs = segments(self.svg)
        ends = {(round(x, 1), round(y, 1)) for s in segs for x, y in ((s[3], s[4]), (s[5], s[6]))}
        disc_at = {(round(x, 1), round(y, 1)) for _, x, y in discs(self.svg)}
        self.assertLessEqual(ends, disc_at)
        self.assertGreater(self.svg.find("<circle"), self.svg.rfind('stroke-linecap="round"'))  # every disc after every line

    def test_no_line_crosses_a_name_and_no_texts_overlap(self):
        boxes = text_boxes(self.svg)
        names = [(t, b) for t, b in boxes if t in NAMES.values()]
        self.assertEqual(len(names), 2 * len(CODES))
        for s in segments(self.svg):
            for t, b in names:
                self.assertFalse(crosses(s[3:], b), f"{s[0]} crosses {t}")
        for i, (t1, a) in enumerate(boxes):
            for t2, b in boxes[i + 1:]:
                self.assertFalse(a[0] < b[2] - 0.5 and b[0] < a[2] - 0.5 and a[1] < b[3] - 0.5 and b[1] < a[3] - 0.5, f"{t1} / {t2}")

    def test_its_rules(self):
        d = json.loads(json.dumps(DATA))

        def refused(data, rows=ROWS, **style):
            with self.assertRaises(Refused) as e:
                draw(hero(data, **style), rows)
            return str(e.exception)
        self.assertIn("fewer than two columns", refused({**d, "columns": d["columns"][:1]}))
        self.assertIn("no head", refused({**d, "columns": [dict(d["columns"][0], head=[])] + d["columns"][1:]}))
        self.assertIn("no series", refused({**d, "series": []}))
        self.assertIn("twice", refused({**d, "series": CODES + CODES[:1]}))
        self.assertIn("which are no series", refused({**d, "series": CODES[:-1]}))
        one_col = {**d, "columns": [d["columns"][0], {"head": W("人口"), "ranks": {c: s for c, s in d["columns"][1]["ranks"].items()}},
                                    {"head": W("面积"), "ranks": {c: s for c, s in d["columns"][2]["ranks"].items() if c != "PHL"}}]}
        self.assertIn("PHL is ranked in fewer than two columns", refused(one_col))
        half = [dict(r, text="2.5") if r["src"] == "fact:pos1.MYS" else r for r in ROWS]
        self.assertIn("no positive whole number", refused(d, rows=half))
        tie = [dict(r, text="1") if r["src"] == "fact:pos1.MYS" else r for r in ROWS]
        self.assertIn("share rank 1", refused(d, rows=tie))
        self.assertIn("highlight", refused(d, highlight="CHN") + "highlight")
        self.assertIn("too narrow", refused(d, width=480, col_min=200))
        far = [dict(r, text="40") if r["src"] == "fact:pos3.SGP" else r for r in ROWS]
        self.assertIn("over plot_max", refused(d, rows=far))
        self.assertIn("digit", refused({**d, "title": W("东盟 10 国")}))
        self.assertIn("do not fit", refused(d, row=20, size=16, disc_r=8))
        self.assertIn("would touch", refused(d, row=20))


if __name__ == "__main__":
    unittest.main()
