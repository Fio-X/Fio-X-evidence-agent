"""Self-test of the optional marks over a column page's placed bars (runtime/leaves_py/column.py bar_extras,
cl_bar_extras): reference lines at ledger-given values (hero.data.refs) and per-row projection ticks (hero.data.proj),
through run.py as layer 1 runs it, the bars bound external and placed by the bars node (test_leaf_placed.placed_lines).
Two data shapes, test-only values, ledger texts and names:
  - a Eurostat share shape: 27 members' renewable share at one year (a level page), the whole's level as a dashed line
    and a target as a solid one, a projection tick on the rows the ledger gives one;
  - a World Bank change shape: five economies' change in a per-capita value between two years (a change page, signed
    bars), the world's change as one dashed line.
Checks: every digit drawn is inside a marked ledger run; a line stands at its value on the bars' own scale; no line runs
through a name or a value (each line breaks where one stands across it); the labels stand under the bars inside the
picture, which grows by the label line only; a page that names neither mark is drawn as before (test_leaf_placed and
test_leaves_ledger hold it byte for byte); the refusals keep the marks' rules. With LEAF_SVG_DIR set, the themed svg of
each shape is kept there.
Run: python3 -I -B scripts/test_leaves_bars_marks.py"""
import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
sys.path.insert(0, HERE)
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402
from test_leaf_placed import placed_lines  # noqa: E402

W = lambda t: [{"w": t}]
EU = ["SE", "FI", "DK", "LV", "EE", "PT", "AT", "LT", "HR", "RO", "SI", "EL", "ES", "FR", "DE", "BG", "IT", "CZ", "PL", "SK",
      "HU", "NL", "CY", "LU", "IE", "BE", "MT"]
EU_VALS = [62.8, 52.1, 44.9, 43.2, 41.5, 35.2, 34.1, 32.3, 29.3, 25.8, 25.0, 24.7, 24.6, 22.3, 21.9, 21.5, 19.6, 18.6, 17.0,
           16.8, 16.1, 16.6, 15.4, 14.4, 15.3, 14.3, 15.1]
EU_NAMES = dict(zip(EU, ["瑞典", "芬兰", "丹麦", "拉脱维亚", "爱沙尼亚", "葡萄牙", "奥地利", "立陶宛", "克罗地亚", "罗马尼亚", "斯洛文尼亚",
                         "希腊", "西班牙", "法国", "德国", "保加利亚", "意大利", "捷克", "波兰", "斯洛伐克", "匈牙利", "荷兰", "塞浦路斯",
                         "卢森堡", "爱尔兰", "比利时", "马耳他"]))  # test-only names
EU_PROJ = {"FR": 27.9, "DE": 30.5, "PL": 21.4, "BE": 19.8, "IE": 20.9}  # test-only projected levels, each off its row's texts


def eu_lines(refs=None, proj=None, extra_ledger=None):
    rows = [{"src": f"series:nrg_ind_ren/REN.{g}:2024:OBS_VALUE", "table": "nrg_ind_ren", "dims": {"nrg_bal": "REN", "geo": g},
             "time": "2024", "value": v} for g, v in zip(EU, EU_VALS)]
    ledger = {f"fact:val.{g}.n": f"{v:.1f}" for g, v in zip(EU, EU_VALS)}
    ledger.update({"period:nrg_ind_ren:2024": "2024", "fact:eu.n": "24.5", "fact:target_2030.n": "42.5"})
    ledger.update({f"fact:proj_{g.lower()}_2030.n": f"{v:.1f}" for g, v in EU_PROJ.items()})
    ledger.update(extra_ledger or {})
    data = {"chart": "bars", "by": "geo", "year": "2024", "family": "val", "ranked": EU, "marks": []}
    if refs is not None: data["refs"] = refs
    if proj is not None: data["proj"] = proj
    spec = {"title": "标题", "dek": "导语", "kicker": "栏目", "source": "nrg_ind_ren", "refs": ["nrg_ind_ren"],
            "tables": {"nrg_ind_ren": {"id": "nrg_ind_ren"}}, "facts": {"val": {"each": "geo", "table": "nrg_ind_ren", "time": "2024", "fmt": "pc"}},
            "fmts": {"pc": {"scale": 1, "dec": 1}, "time": {}}, "hero": {"unit": "单位：%", "data": data}}
    return lines("ranked_bars", spec, rows, ledger, EU_NAMES)


EU_REFS = [{"src": "fact:eu.n", "label": W("欧盟整体")}, {"src": "fact:target_2030.n", "label": W("目标"), "solid": True}]
EU_PROJ_DATA = {"of": {g: f"fact:proj_{g.lower()}_2030.n" for g in EU_PROJ}, "label": W("按近五年速度推到目标年（情景）")}

WB = ["IND", "CHN", "VNM", "IDN", "BRA"]
WB_ENDS = {"IND": (1.6, 2.7), "CHN": (8.0, 12.6), "VNM": (2.6, 4.3), "IDN": (3.3, 4.9), "BRA": (8.8, 8.6)}  # thousand USD, test-only
WB_NAMES = {"IND": "印度", "CHN": "中国", "VNM": "越南", "IDN": "印度尼西亚", "BRA": "巴西"}


def wb_lines(refs=None):
    rows = [{"src": f"series:NY.GDP.PCAP.KD@2/{g}:{t}:OBS_VALUE", "table": "NY.GDP.PCAP.KD@2", "dims": {"economy": g}, "time": t, "value": v}
            for g, (a, b) in WB_ENDS.items() for t, v in (("2015", a), ("2025", b))]
    by = sorted(WB, key=lambda g: WB_ENDS[g][0] - WB_ENDS[g][1])
    ledger = {f"fact:val.{g}": f"{b - a:+.1f} 千美元" for g, (a, b) in WB_ENDS.items()}
    ledger.update({"period:NY.GDP.PCAP.KD@2:2015": "2015", "period:NY.GDP.PCAP.KD@2:2025": "2025", "fact:wld_change.n": "1.9"})
    data = {"chart": "bars", "by": "economy", "t0": "2015", "year": "2025", "family": "val", "ranked": by, "marks": []}
    if refs is not None: data["refs"] = refs
    spec = {"title": "标题", "dek": "导语", "kicker": "栏目", "source": "wb", "refs": ["wb"], "tables": {"NY.GDP.PCAP.KD@2": {"id": "x"}},
            "facts": {"val": {"each": "economy", "table": "NY.GDP.PCAP.KD@2", "time": "2025", "fmt": "k"}},
            "fmts": {"k": {"scale": 1, "dec": 1}, "time": {}},
            "hero": {"unit": "单位：千美元", "style": {"bars": {"measure": "change"}}, "data": data}}
    return lines("change", spec, rows, ledger, WB_NAMES)


def lines(node, spec, rows, ledger, names):
    rows = rows + [{"src": k, "text": v} for k, v in ledger.items()]
    knobs = {"spec": spec, "labels": names}
    line = lambda **kv: json.dumps({"node": node, "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows, "knobs": knobs, **kv},
                                   ensure_ascii=False)
    raw = [line(phase="size"), line(layer="bars")]
    try: out = placed_lines(raw)
    except Refused: return raw  # a frame that refuses: the child says so on the bars' line
    if node != "change": return out
    fixed = []  # a change page's placed bars carry the core's axis, the zero line: a rise's left edge, a fall's right edge
    for ln in out:
        r = json.loads(ln); g = r["knobs"]["placed"]["bars"]
        m = next(it["mark"] for it in g["items"] if WB_ENDS[it["code"]][1] >= WB_ENDS[it["code"]][0])
        g["axis"] = {"x": m["x"]}
        for it in g["items"]: it["texts"][1]["src"] = f"fact:val.{it['code']}"  # a change prints with its unit (column.val_src)
        fixed.append(json.dumps(r, ensure_ascii=False))
    return fixed


def child(ls):
    out = subprocess.run([sys.executable, "-I", "-B", os.path.join(LEAVES, "run.py")], input="\n".join(ls) + "\n",
                         capture_output=True, text=True, check=True).stdout
    return [json.loads(l) for l in out.splitlines()]


def themed(svg, w, h):
    css = ("<style>svg{--accent:#c93f2b;--accent2:#5b6b73;--t-title:#292928;--t-dark:#1f1e1d;--t-body:#4d4d4d;--t-sec:#707070;--bar:#c9c9c9;--empty:#e5e5e5;--bg:#fff;--rule:#ececec;"
           + K.page_vars("#c93f2b") + "}</style>")
    return (f'<svg viewBox="0 0 {w} {h:.0f}" width="{w}" height="{h:.0f}" xmlns="http://www.w3.org/2000/svg">{css}'
            f"<rect width='{w}' height='{h}' fill='#fff'/><g font-family='PingFang SC,sans-serif'>{svg}</g></svg>")


def keep(name, svg, w, h):
    if os.environ.get("LEAF_SVG_DIR"):
        with open(os.path.join(os.environ["LEAF_SVG_DIR"], name), "w", encoding="utf-8") as fh:
            fh.write(themed(svg, w, h))


def digits_marked(svg):
    return not re.search(r"\d", re.sub(r"<(\w+)[^>]*data-src[^>]*>[^<]*</\1>|<[^>]*>", "", svg))


def ref_lines(svg, src):
    """[(x, y1, y2)] of the line pieces drawn for the ledger entry src."""
    return [(float(m[1]), float(m[2]), float(m[3])) for m in
            re.finditer(r'<line x1="([^"]+)" x2="[^"]+" y1="([^"]+)" y2="([^"]+)"[^>]*data-src="' + re.escape(src) + '"', svg)]


def bars_of(svg):
    """{x, w} of the bars in drawing order."""
    return [(float(m[1]), float(m[2])) for m in re.finditer(r'<rect x="([^"]+)" y="[^"]+" width="([^"]+)"', svg)]


class Marks(unittest.TestCase):
    def assert_off_texts(self, svg, texts, src, size=13):
        for x, a, b in ref_lines(svg, src):
            for t in texts:
                if t["y"] is None: continue
                w = len(t["text"]) * size  # a generous box: every char as wide as a CJK one
                x0, x1 = (t["x"] - w, t["x"]) if t["anchor"] == "end" else (t["x"], t["x"] + w)
                if t["anchor"] == "start" and x0 - 2 <= x <= x0 + K.tw(t["text"], size) * 1.06 + 4 or \
                        t["anchor"] == "end" and t["x"] - K.tw(t["text"], size) * 1.06 - 4 <= x <= t["x"] + 2:
                    self.assertFalse(a < t["y"] + size * 0.5 and t["y"] - size * 0.5 < b, f"{src} runs through {t['text']!r}")

    def test_eu_level_page_with_two_references_and_projections(self):
        size, bars = child(eu_lines(EU_REFS, EU_PROJ_DATA))
        psize, plain = child(eu_lines())
        self.assertNotIn("refused", bars, bars.get("refused"))
        keep("bars_marks_eu.svg", bars["svg"], size["w"], size["h"])
        self.assertEqual(size["h"], psize["h"] + 13 * 2)  # the label line only
        svg = bars["svg"]
        self.assertTrue(digits_marked(svg))
        self.assertTrue(svg.startswith(plain["svg"]))  # the bars themselves as before; the marks after them
        # a line at its value on the bars' scale: (x - zero) / value is a bar's width over its value
        (x0, w0) = bars_of(svg)[0]
        for src, v in (("fact:eu.n", 24.5), ("fact:target_2030.n", 42.5)):
            xs = {round(x, 1) for x, _, _ in ref_lines(svg, src)}
            self.assertEqual(len(xs), 1)
            self.assertAlmostEqual((xs.pop() - x0) / v, w0 / EU_VALS[0], places=1)
        self.assertGreater(len(ref_lines(svg, "fact:eu.n")), 1)  # broken where a value stands across it
        for src in ("fact:eu.n", "fact:target_2030.n"): self.assert_off_texts(svg, bars["texts"], src)
        self.assertIn('stroke-dasharray="4 3" data-src="fact:eu.n"', svg)
        self.assertNotIn('stroke-dasharray="4 3" data-src="fact:target_2030.n"', svg)
        ticks = [t for g in EU_PROJ for t in ref_lines(svg, f"fact:proj_{g.lower()}_2030.n")]
        self.assertEqual(len(ticks), len(EU_PROJ))
        labels = [t for t in bars["texts"] if t["src"] in ("fact:eu.n", "fact:target_2030.n")]
        self.assertEqual(len(labels), 2)
        self.assertTrue(all(0 <= t["x"] <= 1140 and t["y"] <= size["h"] for t in bars["texts"]))

    def test_wb_change_page_with_one_reference(self):
        size, bars = child(wb_lines([{"src": "fact:wld_change.n", "label": W("世界平均")}]))
        self.assertNotIn("refused", bars, bars.get("refused"))
        keep("bars_marks_wb.svg", bars["svg"], size["w"], size["h"])
        svg = bars["svg"]
        self.assertTrue(digits_marked(svg))
        self.assertEqual(len({x for x, _, _ in ref_lines(svg, "fact:wld_change.n")}), 1)
        self.assert_off_texts(svg, bars["texts"], "fact:wld_change.n")

    def test_its_rules(self):
        def refused(ls):
            got = child(ls)[1]
            self.assertIn("refused", got, "drawn, not refused")
            return " ".join(got["refused"])
        self.assertIn("one to 2", refused(eu_lines(EU_REFS + EU_REFS[:1])))
        self.assertIn("no ledger entry", refused(eu_lines([{"label": W("欧盟整体")}])))
        self.assertIn("not in the request's ledger", refused(eu_lines([{"src": "fact:none.n", "label": W("欧盟整体")}])))
        self.assertIn("no bare number", refused(eu_lines(EU_REFS, extra_ledger={"fact:eu.n": "24.5%"})))
        self.assertIn("off the bars' span", refused(eu_lines([{"src": "fact:big.n", "label": W("上限")}], extra_ledger={"fact:big.n": "99"})))
        self.assertIn("digit", refused(eu_lines([{"src": "fact:eu.n", "label": W("欧盟27国")}])))
        self.assertIn("scale", refused(eu_lines([{"src": "fact:eu.n", "label": W("欧盟整体"), "scale": 0}])))
        self.assertIn("no place the page ranks", refused(eu_lines(proj={"of": {"XX": "fact:eu.n"}, "label": W("推算")})))
        self.assertIn("no row's projection", refused(eu_lines(proj={"of": {}, "label": W("推算")})))
        self.assertIn("falls on its row's name or value",
                      refused(eu_lines(proj={"of": {"SE": "fact:p.n"}, "label": W("推算")}, extra_ledger={"fact:p.n": "64.0"})))
        self.assertIn("overlap", refused(eu_lines([{"src": "fact:eu.n", "label": W("欧盟整体")},
                                                   {"src": "fact:e2.n", "label": W("另一条")}], extra_ledger={"fact:e2.n": "25.5"})))


if __name__ == "__main__":
    unittest.main()
