"""Self-test of the gap axis leaf (runtime/leaves_py/gap_axis.py) on two data shapes with test-only values, ledger texts and
words (layer 1 writes the real ones: the now value its fact, each mark a projection fact, the target and the gap facts,
each tick next_facts::ticks):
  - an EU share-of-renewables shape: a share in percent to raise, now 24.6%, three paces carried to the target year, a
    target of 42.5%, the axis 20%..45%;
  - a World Bank shape: tonnes per head to cut, now 14.9, two paces, a target of 8.0 below them, the axis 6..16, a mark's
    words naming an economy by its name row.
Checks: every digit sits inside a marked ledger run; one accent (the now dot and the now value); the gap box runs from the
mark furthest toward the target to the target, and the band from now to that mark; no two texts overlap (wbkit.Boxes, and
here again); the refusals keep the leaf's rules. With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_gap_axis.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import gap_axis  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]


def eu():
    """The EU shape: rows (the now cell and the ledger texts) and the spec."""
    rows = [{"src": "series:nrg_ind_ren/REN.EU27_2020:2024:OBS_VALUE", "table": "nrg_ind_ren", "dims": {"nrg_bal": "REN", "geo": "EU27_2020"},
             "time": "2024", "value": 24.55},
            {"src": "fact:ren_eu_2024", "text": "24.6%"}, {"src": "fact:proj_avg_2030", "text": "29.2%"},
            {"src": "fact:proj_recent_2030", "text": "31.0%"}, {"src": "fact:proj_best_2030", "text": "33.6%"},
            {"src": "fact:target_eu", "text": "42.5%"}, {"src": "fact:gap_eu", "text": "8.9"},
            {"src": "period:nrg_ind_ren:2024", "text": "2024"}, {"src": "fact:target_eu.t.y", "text": "2030"}]
    rows += [{"src": f"fact:ren.tick{i}", "text": f"{v}%"} for i, v in enumerate(range(20, 50, 5), 1)]
    data = dict(title=W("还差多少：欧盟可再生能源占比"), unit=W("占最终能源消费的百分比"),
                axis={"ticks": [f"fact:ren.tick{i}" for i in range(1, 7)], "scale": 1},
                now={"text": "fact:ren_eu_2024", "at": "series:nrg_ind_ren/REN.EU27_2020:2024:OBS_VALUE",
                     "label": [{"src": "period:nrg_ind_ren:2024"}, {"w": " 年实际"}]},
                marks=[{"text": "fact:proj_avg_2030", "label": W("照过去平均速度")},
                       {"text": "fact:proj_recent_2030", "label": W("照近五年速度")},
                       {"text": "fact:proj_best_2030", "label": W("每年都像最好的一年")}],
                target={"text": "fact:target_eu", "label": [{"src": "fact:target_eu.t.y"}, {"w": " 年法定目标"}]},
                gap_label=[{"w": "缺口 "}, {"src": "fact:gap_eu"}, {"w": " 个百分点"}],
                footnote=W("数据来源：欧盟统计局；三种速度均为情景，不是预测"))
    return rows, data, {}


def wb():
    """The World Bank shape: a quantity per head to cut; the target lies below now and below every mark."""
    rows = [{"src": "fact:co2pc_usa_2022", "text": "14.9"}, {"src": "fact:proj_usa_avg_2035", "text": "12.1"},
            {"src": "fact:proj_usa_recent_2035", "text": "11.3"}, {"src": "fact:target_usa", "text": "8.0"},
            {"src": "name:zh_names:iso3:USA", "text": "美国"}]
    rows += [{"src": f"fact:co2.tick{i}", "text": str(v)} for i, v in enumerate(range(6, 18, 2), 1)]
    data = dict(title=W("人均排放要降到哪里"), unit=W("吨二氧化碳／人"),
                axis={"ticks": [f"fact:co2.tick{i}" for i in range(1, 7)], "scale": 1},
                now={"text": "fact:co2pc_usa_2022", "label": [{"name": "USA", "kind": "place"}, {"w": " 现在"}]},
                marks=[{"text": "fact:proj_usa_avg_2035", "label": W("照长期平均降速")},
                       {"text": "fact:proj_usa_recent_2035", "label": W("照近十年降速")}],
                target={"text": "fact:target_usa", "label": W("承诺目标")},
                gap_label=W("还差的一段"))
    return rows, data, {"USA": "美国"}


SHAPES = {"eu": eu(), "wb": wb()}


def hero(data, **style):
    return {"data": data, "style": {"gap_axis": style}}


def draw(data, rows, names, **style):
    K.setup(rows, names, run.tables)
    return gap_axis.draw(hero(data, **style))


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


def rect(svg, part):
    m = re.search(r'<rect x="([^"]+)" y="[^"]+" width="([^"]+)"[^>]*data-part="' + part + '"', svg)
    return (float(m.group(1)), float(m.group(1)) + float(m.group(2))) if m else None


def cx(svg, part):
    return [float(v) for v in re.findall(r'<circle cx="([^"]+)"[^>]*data-part="' + part + '"', svg)]


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = {}
        for name, (rows, data, names) in SHAPES.items():
            svg, w, h = draw(data, rows, names)
            cls.out[name] = (svg, w, h)
            if os.environ.get("LEAF_SVG_DIR"):
                os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"gap_axis-{name}.svg"), "w", encoding="utf-8") as fh:
                    fh.write(themed(svg, w, h))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        for name, (svg, _, _) in self.out.items():
            self.assertEqual(check_svg(svg), [], name)

    def test_one_accent(self):
        for name, (svg, _, _) in self.out.items():
            self.assertEqual(svg.count("var(--accent)"), 3, name)  # the now dot (fill and stroke) and the now value
            self.assertNotIn("#", re.sub(r'data-src="[^"]*"', "", svg), name)  # no colour named: the page's variables only

    def test_band_and_gap_run_to_the_furthest_mark_and_the_target(self):
        for name, (svg, _, _) in self.out.items():
            now, = cx(svg, "now"); target, = cx(svg, "target"); marks = cx(svg, "mark")
            far = max(marks) if target > now else min(marks)
            self.assertEqual(rect(svg, "band"), tuple(sorted((round(now, 1), round(far, 1)))), name)
            self.assertEqual(rect(svg, "gap"), tuple(sorted((round(far, 1), round(target, 1)))), name)

    def test_no_two_texts_overlap(self):
        for name, (svg, _, _) in self.out.items():
            got, _ = run.drawn(svg)
            self.assertTrue(got, name)
        # wbkit.Boxes refuses an overlap while drawing; a tight board must refuse rather than overlap
        rows, data, names = SHAPES["eu"]
        many = dict(data, marks=data["marks"] + [{"text": "fact:proj_avg_2030", "label": W("又一种很长很长很长的速度说法")}] * 3)
        with self.assertRaises(Refused) as e:
            draw(many, rows, names, width=480, levels=1)
        self.assertIn("no free row", str(e.exception))

    def test_its_rules(self):
        rows, data, names = SHAPES["eu"]
        d = json.loads(json.dumps(data))

        def refused(data, rows=rows, **style):
            with self.assertRaises(Refused) as e:
                draw(data, rows, names, **style)
            return str(e.exception)
        self.assertIn("fewer than two ticks", refused({**d, "axis": {"ticks": d["axis"]["ticks"][:1], "scale": 1}}))
        self.assertIn("not ascending", refused({**d, "axis": {"ticks": d["axis"]["ticks"][::-1], "scale": 1}}))
        self.assertIn("off the axis", refused({**d, "axis": {"ticks": d["axis"]["ticks"][:4], "scale": 1}}))
        self.assertIn("is no number", refused({**d, "target": {**d["target"], "text": "period:nrg_ind_ren:2024x"}},
                                              rows=rows + [{"src": "period:nrg_ind_ren:2024x", "text": "二〇三〇"}]))
        reach = [dict(r, text="45.0%") if r["src"] == "fact:proj_best_2030" else r for r in rows]
        self.assertIn("no gap", refused(d, rows=reach))
        same = {**d, "target": {**d["target"], "text": "fact:ren_eu_2024"}, "now": {**d["now"], "at": None}}
        self.assertIn("at the now point", refused(same))
        self.assertIn("not in the request's ledger", refused({**d, "marks": [{"text": "fact:nope", "label": W("无")}]}))
        self.assertIn("digit", refused({**d, "gap_label": W("差 8.9 个百分点")}))
        self.assertIn("no knob", refused(d, colour="green"))
        self.assertIn("off its range", refused(d, size=9))

    def test_a_mark_past_the_target_draws_no_gap(self):
        rows, data, names = SHAPES["eu"]
        reach = [dict(r, text="44.0%") if r["src"] == "fact:proj_best_2030" else r for r in rows]
        svg, _, _ = draw({k: v for k, v in data.items() if k != "gap_label"}, reach, names)
        self.assertIsNone(rect(svg, "gap"))
        self.assertEqual(check_svg(svg), [])


if __name__ == "__main__":
    unittest.main()
