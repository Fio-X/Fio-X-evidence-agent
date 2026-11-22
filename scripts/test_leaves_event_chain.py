"""Self-test of the chain leaf (runtime/leaves_py/event_chain.py) on two data shapes with test-only values, ledger texts and
words (layer 1 writes the real ones: each first and last value its fact, each period an entry):
  - an EU energy shape: four panels 2019-2024 (gas from Russia in bars, the household power price as a line not from 0,
    yearly solar additions in bars, coal's share of power as a line), 2022 shaded, three links;
  - a World Bank shape: three panels of per-head values for one economy over 2015-2022 (income, energy use, tonnes of
    CO2), 2020 shaded, two links, one of them naming the economy by its name row.
Checks: every digit sits inside a marked ledger run; one accent (the highlighted panel's marks); the shaded period lines
up across the panels (same offset in each); one chevron band between each two neighbours; a line panel not from 0 uses
its own range; the refusals keep the leaf's rules. With LEAF_SVG_DIR set, the themed svgs are kept there.
Run: python3 -I -B scripts/test_leaves_chain.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import event_chain  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]


def panel(rows, table, code, years, vals, fmt, kind, title, unit, link=None, zero=True, dims=None):
    pts = []
    for y, v in zip(years, vals):
        s = f"series:{table}/{code}:{y}:OBS_VALUE"
        rows.append({"src": s, "table": table, "dims": dims or {"code": code}, "time": y, "value": v})
        pts.append(s)
    for y in (years[0], years[-1]):
        if not any(r["src"] == f"period:{table}:{y}" for r in rows): rows.append({"src": f"period:{table}:{y}", "text": y})
    rows += [{"src": f"fact:{code.lower()}_first", "text": fmt(vals[0])}, {"src": f"fact:{code.lower()}_last", "text": fmt(vals[-1])}]
    p = dict(code=code, title=W(title), unit=W(unit), kind=kind, points=pts, first_text=f"fact:{code.lower()}_first",
             last_text=f"fact:{code.lower()}_last", periods=[f"period:{table}:{years[0]}", f"period:{table}:{years[-1]}"], zero=zero)
    if link is not None: p["link"] = link
    return p


def eu():
    rows, ys = [], [str(y) for y in range(2019, 2025)]
    rows += [{"src": "fact:cut_ru", "text": "65%"}, {"src": "period:nrg_ti_gas:2022", "text": "2022"}]
    panels = [
        panel(rows, "nrg_ti_gas", "RU", ys, [166, 152, 150, 80, 43, 52], lambda v: f"{v:.0f}", "bar", "从俄罗斯进口的天然气", "十亿立方米／年",
              link=[{"w": "俄气少了 "}, {"src": "fact:cut_ru"}, {"w": "，电价随之上涨"}]),
        panel(rows, "nrg_pc_204", "PRICE", ys, [0.216, 0.213, 0.237, 0.284, 0.289, 0.288], lambda v: f"{v:.2f}", "line", "家庭电价", "欧元／千瓦时，含税",
              link=W("光伏装机加速"), zero=False),
        panel(rows, "nrg_inf_epcrw", "RA420", ys, [16, 19, 28, 40, 56, 65], lambda v: f"{v:.0f}", "bar", "光伏新增装机", "吉瓦／年",
              link=W("煤电占比回落")),
        panel(rows, "nrg_bal_peh", "COAL", ys, [15.2, 13.0, 14.6, 16.4, 12.3, 10.3], lambda v: f"{v:.1f}%", "line", "煤电占发电量", "百分比"),
    ]
    data = dict(title=W("一条事件链：从俄气到光伏"), panels=panels,
                band={"from": "2022", "to": "2022", "label": [{"src": "period:nrg_ti_gas:2022"}, {"w": " 年：俄气锐减"}]},
                footnote=W("图中只呈现时间上的先后，不代表每一环都由上一环单独造成"))
    return rows, data, {}


def wb():
    rows, ys = [], [str(y) for y in range(2015, 2023)]
    rows += [{"src": "name:zh_names:iso3:IND", "text": "印度"}]
    panels = [
        panel(rows, "NY.GDP.PCAP.CD", "GDP", ys, [1590, 1714, 1958, 1974, 2050, 1913, 2250, 2367], lambda v: f"{v:,.0f}", "line",
              "人均收入", "美元", link=[{"name": "IND", "kind": "place"}, {"w": " 收入回升，用能随之增加"}], zero=False),
        panel(rows, "EG.USE.PCAP.KG.OE", "ENERGY", ys, [552, 565, 590, 615, 630, 595, 640, 660], lambda v: f"{v:.0f}", "bar",
              "人均能源使用", "千克油当量", link=W("排放跟着走")),
        panel(rows, "EN.GHG.CO2.PC", "CO2", ys, [1.7, 1.7, 1.8, 1.9, 1.9, 1.8, 1.9, 2.0], lambda v: f"{v:.1f}", "line", "人均二氧化碳排放", "吨"),
    ]
    data = dict(panels=panels, band={"from": "2020", "to": "2020", "label": W("疫情那一年")})
    return rows, data, {"IND": "印度"}


SHAPES = {"eu": eu(), "wb": wb()}


def draw(data, rows, names, **style):
    K.setup(rows, names, run.tables)
    return event_chain.draw({"data": data, "style": {"event_chain": style}})


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


class Picture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = {}
        for name, (rows, data, names) in SHAPES.items():
            style = {"highlight": "RA420"} if name == "eu" else {}
            cls.out[name] = draw(data, rows, names, **style)
            if os.environ.get("LEAF_SVG_DIR"):
                os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
                svg, w, h = cls.out[name]
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"event_event_chain-{name}.svg"), "w", encoding="utf-8") as fh:
                    fh.write(themed(svg, w, h))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        for name, (svg, _, _) in self.out.items():
            self.assertEqual(check_svg(svg), [], name)

    def test_one_accent_on_the_highlighted_panel(self):
        for name, (svg, _, _) in self.out.items():
            hot = {m for m in re.findall(r'(?:fill|stroke)="var\(--accent\)"[^>]*data-code="([^"]+)"', svg)}
            self.assertEqual(hot, {"RA420"} if name == "eu" else {"GDP"}, name)
            self.assertNotIn("#", svg, name)

    def test_the_band_lines_up_and_the_links_sit_between(self):
        for name, (svg, _, _) in self.out.items():
            n = len(SHAPES[name][1]["panels"])
            xs = [float(v) for v in re.findall(r'<rect x="([^"]+)"[^>]*data-part="band"', svg)]
            self.assertEqual(len(xs), n, name)
            steps = [b - a for a, b in zip(xs, xs[1:])]
            self.assertLess(max(steps) - min(steps), 0.15, name)  # one panel pitch apart (to the printed 0.1 px): the same period in every panel
            self.assertEqual(svg.count('data-part="link-band"'), n - 1, name)

    def test_a_line_not_from_zero_uses_its_own_range(self):
        svg = self.out["eu"][0]
        ys = [float(p.split(",")[1]) for p in re.search(r'<polyline points="([^"]+)"[^>]*data-code="PRICE"', svg).group(1).split()]
        self.assertGreater(max(ys) - min(ys), 60)  # the price's small rise fills most of the plot's height

    def test_the_first_and_last_values_keep_off_the_line(self):
        """A value printed beside its point stands above it, or under it where the line (or a taller bar) runs through the
        room above (or higher where neither side is free): no 1 px sample of a line sits inside a first or last value's box, in the
        two shapes and in a panel that climbs steeply from its first point, whose first value then goes higher than the usual 7 px."""
        rows, ys = [], [str(y) for y in range(2015, 2023)]
        steep = [panel(rows, "t", "STEEP", ys, [10, 55, 70, 80, 88, 94, 98, 100], lambda v: f"{v:.0f}", "line", "a steep climb", "u", zero=True),
                 panel(rows, "t", "FLAT", ys, [5, 6, 5, 6, 5, 6, 5, 6], lambda v: f"{v:.0f}", "line", "a flat one", "u", zero=False)]
        out = dict(self.out, steep=draw(dict(panels=steep), rows, {}))
        for name, (svg, _, _) in out.items():
            texts, bad = run.drawn(svg)
            self.assertEqual(bad, [], name)
            lines = {m.group(2): [tuple(map(float, q.split(","))) for q in m.group(1).split()]
                     for m in re.finditer(r'<polyline points="([^"]+)"[^>]*data-code="([^"]+)"', svg)}
            boxes = [(t["x"] - K.tw(t["text"], t["size"]) / 2, t["y"] - t["size"] * 0.8, t["x"] + K.tw(t["text"], t["size"]) / 2, t["y"] + t["size"] * 0.25, t)
                     for t in texts if t["src"] and re.search(r"_(first|last)$", t["src"])]
            self.assertTrue(boxes, name)
            for x0, y0, x1, y1, t in boxes:
                for pts in lines.values():
                    for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
                        m = max(1, int(abs(xb - xa)))
                        hit = [k for k in range(m + 1) if x0 <= xa + (xb - xa) * k / m <= x1 and y0 - 1.5 <= ya + (yb - ya) * k / m <= y1 + 1.5]
                        self.assertEqual(hit, [], f"{name}: {t['src']} sits on a line")
        svg = out["steep"][0]
        first = re.search(r'<polyline points="([0-9.]+),([0-9.]+) ', svg)
        t = next(t for t in run.drawn(svg)[0] if t["src"] == "fact:steep_first")
        self.assertLess(t["y"], float(first.group(2)) - 7)  # the line climbs from this point to the baseline's side: no room under it, so higher than the usual 7 px above

    def test_its_rules(self):
        rows, data, names = SHAPES["eu"]
        d = json.loads(json.dumps(data))

        def refused(data, rows=rows, **style):
            with self.assertRaises(Refused) as e:
                draw(data, rows, names, **style)
            return str(e.exception)
        p = d["panels"]
        self.assertIn("fewer than two panels", refused({**d, "panels": p[:1]}))
        self.assertIn("twice", refused({**d, "panels": p + p[:1]}))
        self.assertIn("neither line nor bar", refused({**d, "panels": [dict(p[0], kind="pie")] + p[1:]}))
        self.assertIn("fewer than two points", refused({**d, "panels": [dict(p[0], points=p[0]["points"][:1])] + p[1:]}))
        self.assertIn("period order", refused({**d, "panels": [dict(p[0], points=p[0]["points"][::-1])] + p[1:]}))
        self.assertIn("is not its point's period", refused({**d, "panels": [dict(p[0], periods=p[0]["periods"][::-1])] + p[1:]}))
        self.assertIn("no panel after it", refused({**d, "panels": p[:-1] + [dict(p[-1], link=W("再往后"))]}))
        self.assertIn("outside every panel", refused({**d, "band": {"from": "2030", "to": "2031", "label": W("以后")}}))
        neg = [dict(r, value=-1.0) if r.get("src") == p[0]["points"][2] else r for r in rows]
        self.assertIn("below 0", refused(d, rows=neg))
        self.assertIn("too narrow", refused(d, width=480))
        self.assertIn("more than two lines", refused({**d, "panels": [dict(p[0], title=W("一个非常非常长的面板名字" * 3))] + p[1:]}))
        self.assertIn("digit", refused({**d, "panels": [dict(p[0], link=W("少了 65%"))] + p[1:]}))
        self.assertIn("does not hold", refused(d, highlight="XX"))


if __name__ == "__main__":
    unittest.main()
