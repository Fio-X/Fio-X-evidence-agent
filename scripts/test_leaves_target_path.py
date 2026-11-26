"""Self-test of the target path leaf (runtime/leaves_py/target_path.py) on two data shapes with test-only values, ledger
texts and words (layer 1 writes the real ones: the first and last value its facts, each run a projection fact, the target
and its year, the gap, each tick next_facts::ticks):
  - an EU share-of-renewables shape: the EU's share 2005-2024 in percent (20 years), three paces carried to 2030, a target
    of 42.5% above them all, ticks every 10 points;
  - a World Bank shape: one economy's tonnes per head 2010-2022 (13 years), two paces carried to 2035, a target of 4.0
    below them, ticks every 2.
Checks: every digit sits inside a marked ledger run; one accent (the past line and its two end dots); every pace's line
and the dotted way to the target start at the last point and end at the target period; the bracket runs from the target
to the pace nearest it; the labels right of the target do not overlap (wbkit.Boxes) and none leaves the picture; the
refusals keep the leaf's rules. With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_target_path.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import run  # noqa: E402
import target_path  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
EU_VALS = [10.2, 10.8, 11.7, 12.6, 13.9, 14.4, 14.5, 15.7, 16.7, 17.5, 17.8, 18.0, 18.4, 18.9, 19.9, 22.0, 21.9, 23.0, 24.1, 24.6]
WB_VALS = [8.6, 8.8, 8.7, 8.5, 8.4, 8.0, 7.9, 7.8, 7.9, 7.6, 7.0, 7.3, 7.1]


def shape(table, code, dims, years, vals, fmt, runs, target, ticks, title, unit, gap):
    rows, pts = [], []
    for y, v in zip(years, vals):
        s = f"series:{table}/{code}:{y}:OBS_VALUE"
        rows.append({"src": s, "table": table, "dims": dims, "time": y, "value": v})
        rows.append({"src": f"period:{table}:{y}", "text": y})
        pts.append(s)
    rows += [{"src": f"fact:{code.lower()}_first", "text": fmt(vals[0])}, {"src": f"fact:{code.lower()}_last", "text": fmt(vals[-1])}]
    rows += [{"src": f"fact:proj_{code.lower()}_{i}", "text": fmt(v)} for i, (v, _) in enumerate(runs, 1)]
    rows += [{"src": f"fact:target_{code.lower()}", "text": fmt(target[1])}, {"src": f"fact:target_{code.lower()}.t.y", "text": target[0]},
             {"src": f"fact:gap_{code.lower()}", "text": f"{abs(target[1] - runs[0][0]):.1f}"}]
    rows += [{"src": f"fact:{code.lower()}.tick{i}", "text": fmt(v)} for i, v in enumerate(ticks, 1)]
    data = dict(title=W(title), unit=W(unit),
                series={"code": code, "points": pts, "start_text": f"fact:{code.lower()}_first", "end_text": f"fact:{code.lower()}_last"},
                target={"year": f"fact:target_{code.lower()}.t.y", "text": f"fact:target_{code.lower()}", "label": W("目标")},
                runs=[{"text": f"fact:proj_{code.lower()}_{i}", "label": W(w)} for i, (_, w) in enumerate(runs, 1)],
                axis={"ticks": [f"fact:{code.lower()}.tick{i}" for i in range(1, len(ticks) + 1)], "scale": 1},
                periods=[f"period:{table}:{y}" for y in years],
                gap_label=[{"w": gap}, {"src": f"fact:gap_{code.lower()}"}],
                footnote=W("情景：把过去的速度画成直线，不是预测"))
    return rows, data


def eu():
    return shape("nrg_ind_ren", "EU27_2020", {"nrg_bal": "REN", "geo": "EU27_2020"}, [str(y) for y in range(2005, 2025)], EU_VALS,
                 lambda v: f"{v:.1f}%", [(33.6, "每年都像最好的一年"), (31.0, "照近五年速度"), (29.2, "照过去平均速度")],
                 ("2030", 42.5), [0, 10, 20, 30, 40, 50], "照现在的速度到不了目标", "占最终能源消费的百分比", "还差 ")


def wb():
    return shape("EN.GHG.CO2.PC.CE.AR5", "DEU", {"country": "DEU"}, [str(y) for y in range(2010, 2023)], WB_VALS,
                 lambda v: f"{v:.1f}", [(5.6, "照近五年降速"), (6.2, "照长期平均降速")],
                 ("2035", 4.0), [0, 2, 4, 6, 8, 10], "人均排放离目标多远", "吨二氧化碳／人", "差 ")


def up_low():  # a low start far under a target far above: the past line climbs and every pace fans out from the last point
    return shape("nrg_ind_ren", "EU27_2020", {"geo": "EU27_2020"}, [str(y) for y in range(2015, 2025)], [3.1, 3.6, 4.4, 5.1, 5.3, 6.4, 7.4, 8.2, 8.8, 9.6],
                 lambda v: f"{v:.1f}%", [(21.0, "最快的一年"), (15.5, "照近五年速度"), (12.0, "照过去平均速度")],
                 ("2035", 60.0), [10, 20, 30, 40, 50, 60], "照现在的速度到不了目标", "占最终能源消费的百分比", "还差 ")


def reaches():  # the fastest pace passes the target: no gap, no bracket
    rows, data = shape("nrg_ind_ren", "EU27_2020", {"geo": "EU27_2020"}, [str(y) for y in range(2012, 2025)],
                       [18.0, 18.4, 19.1, 19.6, 20.2, 21.0, 21.5, 22.4, 23.1, 24.2, 25.0, 25.6, 26.2],
                       lambda v: f"{v:.1f}%", [(41.0, "最快的一年"), (33.0, "照近五年速度")], ("2030", 36.0), [10, 20, 30, 40], "最快的速度到得了", "占最终能源消费的百分比", "")
    data.pop("gap_label")
    return rows, data


def falls():  # a high start falling toward a target under it: the paces and the dotted line fan downward
    return shape("EN.GHG.CO2.PC.CE.AR5", "DEU", {"country": "DEU"}, [str(y) for y in range(2008, 2023)],
                 [41.0, 39.5, 38.0, 37.2, 35.8, 34.1, 33.4, 31.9, 31.0, 29.2, 27.6, 27.0, 26.1, 25.4, 24.8],
                 lambda v: f"{v:.1f}", [(15.0, "照近五年降速"), (19.5, "照长期平均降速")], ("2035", 8.0), [10, 20, 30, 40, 50], "离目标多远", "吨二氧化碳／人", "差 ")


SHAPES = {"eu": eu(), "wb": wb()}
# the shapes the value labels are held to as well (a start label and an end label stand clear of every line)
EXTRA = {"up_low": up_low(), "reaches": reaches(), "falls": falls()}


def draw(data, rows, **style):
    K.setup(rows, {}, run.tables)
    return target_path.draw({"data": data, "style": {"target_path": style}})


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


def lines(svg, part):
    return [tuple(float(v) for v in m) for m in re.findall(r'<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"[^>]*data-part="' + part + '"', svg)]


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = {}
        for name, (rows, data) in SHAPES.items():
            cls.out[name] = draw(data, rows)
            if os.environ.get("LEAF_SVG_DIR"):
                os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
                svg, w, h = cls.out[name]
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"target_path-{name}.svg"), "w", encoding="utf-8") as fh:
                    fh.write(themed(svg, w, h))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        for name, (svg, _, _) in self.out.items():
            self.assertEqual(check_svg(svg), [], name)

    def test_one_accent(self):
        for name, (svg, _, _) in self.out.items():
            self.assertEqual(svg.count("var(--accent)"), 3, name)  # the line and its two end dots
            self.assertNotIn("#", svg, name)

    def test_the_paces_run_from_the_last_point_to_the_target_period(self):
        for name, (svg, _, _) in self.out.items():
            last = re.search(r'<polyline points="([^"]+)"', svg).group(1).split()[-1]
            lx, ly = (float(v) for v in last.split(","))
            runs, needed = lines(svg, "run"), lines(svg, "needed")
            self.assertEqual(len(runs), len(SHAPES[name][1]["runs"]), name)
            gx = needed[0][2]
            for x1, y1, x2, _ in runs + needed:
                self.assertEqual((round(x1, 1), round(y1, 1), round(x2, 1)), (round(lx, 1), round(ly, 1), round(gx, 1)), name)

    def test_the_bracket_runs_from_the_target_to_the_nearest_pace(self):
        for name, (svg, _, _) in self.out.items():
            m = re.search(r'<path d="M[^ ]+ ([^ ]+) h 8 V ([^ ]+) h -8"[^>]*data-part="gap"', svg)
            ty = float(re.search(r'<circle cx="[^"]+" cy="([^"]+)"[^>]*data-part="target"', svg).group(1))
            ends = [float(v) for v in re.findall(r'<circle cx="[^"]+" cy="([^"]+)"[^>]*data-part="run-end"', svg)]
            self.assertEqual(float(m.group(1)), ty, name)
            self.assertEqual(float(m.group(2)), min(ends, key=lambda y: abs(y - ty)), name)

    def test_the_first_and_last_value_stand_clear_of_every_line(self):
        """The page's text-on-line check (bake.py) refuses a text a line passes through: the two values by the past line's ends
        are boxes none of the polyline, the dotted and the dashed lines, the hairlines, the axis or the target's ring crosses,
        on every shape and at three picture widths (the story puts this chart in a 716 px column)."""
        def seen(svg):
            segs = []
            for m in re.finditer(r'<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"', svg):
                a = [float(v) for v in m.groups()]; segs.append(((a[0], a[1]), (a[2], a[3])))
            pts = [tuple(float(v) for v in p.split(",")) for p in re.search(r'<polyline points="([^"]+)"', svg).group(1).split()]
            segs += list(zip(pts, pts[1:]))
            cx, cy = (float(v) for v in re.search(r'<circle cx="([^"]+)" cy="([^"]+)"[^>]*data-part="target"', svg).groups())
            segs += [((cx - 7, cy - 7), (cx + 7, cy - 7)), ((cx + 7, cy - 7), (cx + 7, cy + 7)), ((cx + 7, cy + 7), (cx - 7, cy + 7)), ((cx - 7, cy + 7), (cx - 7, cy - 7))]
            return segs
        for name, (rows, data) in {**SHAPES, **EXTRA}.items():
            for width in (1140, 716, 552):
                svg, _, _ = draw(data, rows, width=width)
                segs = seen(svg)
                values = re.findall(r'<text x="([^"]+)" y="([^"]+)" font-size="14" text-anchor="middle"[^>]*stroke="var\(--bg\)"[^>]*>(.*?)</text>', svg)
                self.assertEqual(len(values), 2, (name, width))
                for x, y, inner in values:
                    w = K.tw(re.sub(r"<[^>]+>", "", inner), 14)
                    x0, x1, y0, y1 = float(x) - w / 2, float(x) + w / 2, float(y) - 13, float(y) + 4
                    for (ax, ay), (bx, by) in segs:
                        n = max(1, int(max(abs(bx - ax), abs(by - ay))))
                        for i in range(n + 1):
                            px, py = ax + (bx - ax) * i / n, ay + (by - ay) * i / n
                            self.assertFalse(x0 < px < x1 and y0 < py < y1, f"{name} {width}: a line passes through {re.sub('<[^>]+>', '', inner)} at {px:.0f},{py:.0f}")

    def test_the_extra_shapes_draw_every_digit_as_a_marked_ledger_run(self):
        for name, (rows, data) in EXTRA.items():
            self.assertEqual(check_svg(draw(data, rows)[0]), [], name)

    def test_its_rules(self):
        rows, data = SHAPES["eu"]
        d = json.loads(json.dumps(data))

        def refused(data, rows=rows, **style):
            with self.assertRaises(Refused) as e:
                draw(data, rows, **style)
            return str(e.exception)
        s = d["series"]
        self.assertIn("fewer than two points", refused({**d, "series": {**s, "points": s["points"][:1]}}))
        self.assertIn("period order", refused({**d, "series": {**s, "points": s["points"][::-1]}}))
        self.assertIn("no run", refused({**d, "runs": []}))
        self.assertIn("not after", refused({**d, "target": {**d["target"], "year": "period:nrg_ind_ren:2010"}}))
        self.assertIn("not ascending", refused({**d, "axis": {"ticks": d["axis"]["ticks"][::-1], "scale": 1}}))
        reach = [dict(r, text="45.0%") if r["src"] == "fact:proj_eu27_2020_1" else r for r in rows]
        self.assertIn("no gap", refused(d, rows=reach))
        self.assertIn("which no point has", refused({**d, "periods": ["period:nrg_ind_ren:2030"]},
                                                     rows=rows + [{"src": "period:nrg_ind_ren:2030", "text": "2030"}]))
        self.assertIn("is no number", refused({**d, "runs": [{"text": "period:nrg_ind_ren:x", "label": W("无")}]},
                                              rows=rows + [{"src": "period:nrg_ind_ren:x", "text": "很多"}]))
        many = {**d, "runs": d["runs"] * 6}
        self.assertIn("do not fit", refused(many, plot_h=160))
        self.assertIn("digit", refused({**d, "gap_label": W("还差 8.9")}))
        self.assertIn("too narrow", refused({**d, "runs": [{**d["runs"][0], "label": W("一种非常非常长的速度说法" * 3)}]}, width=480))


if __name__ == "__main__":
    unittest.main()
