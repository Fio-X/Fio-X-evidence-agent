"""Self-test of the shift leaf (runtime/leaves_py/winners_losers.py) on two data shapes with test-only ledger texts and words
(layer 1 writes the real ones: each before and after value its fact, each change a ratio or difference fact, each period
an entry):
  - an EU energy shape: two measures that rose (solar additions in GW, wind and solar's share of power in percent) and
    three that fell (gas from Russia, coal's share, power-sector emissions), periods printed from period entries;
  - a World Bank shape: per-head values for a few economies, names printed from their name rows, two rising (income per
    head) and two falling (tonnes per head), changes as differences.
Checks: every digit sits inside a marked ledger run; one accent (the rising column's rule and after-values; knob accent
moves it or turns it off); each column's rows keep the request's order; the refusals keep the leaf's rules (a row in the
wrong column, a value that is no number, an empty column, a long label). With LEAF_SVG_DIR set, the themed svgs are kept
there. Run: python3 -I -B scripts/test_leaves_shift.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LEAVES = os.path.join(HERE, "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import run  # noqa: E402
import winners_losers  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
P = lambda t, y: {"src": f"period:{t}:{y}"}


def eu():
    texts = {"fact:solar_add_2019": "16", "fact:solar_add_2024": "65", "fact:ratio_solar_add": "4.1",
             "fact:ws_2019": "17.6%", "fact:ws_2024": "28.9%",
             "fact:ru_gas_2021": "150", "fact:ru_gas_2024": "52", "fact:cut_ru_gas": "65%",
             "fact:coal_2022": "16.4%", "fact:coal_2024": "10.3%",
             "fact:ghg_power_2022": "1,027", "fact:ghg_power_2024": "811", "fact:cut_ghg_power": "21%"}
    rows = [{"src": k, "text": v} for k, v in texts.items()]
    rows += [{"src": f"period:{t}:{y}", "text": y} for t, ys in (("nrg_inf_epcrw", ("2019", "2024")), ("nrg_bal_peh", ("2019", "2022", "2024")),
                                                                     ("nrg_ti_gas", ("2021", "2024")), ("env_air_gge", ("2022", "2024"))) for y in ys]
    lab = lambda words, t, a, b: [{"w": words + "（"}, P(t, a), {"w": "→"}, P(t, b), {"w": "）"}]
    data = dict(
        up={"title": W("在涨的"), "rows": [
            {"label": lab("光伏年新增装机，吉瓦", "nrg_inf_epcrw", "2019", "2024"), "a": "fact:solar_add_2019", "b": "fact:solar_add_2024",
             "change": [{"src": "fact:ratio_solar_add"}, {"w": " 倍"}]},
            {"label": lab("风电和光伏占发电量", "nrg_bal_peh", "2019", "2024"), "a": "fact:ws_2019", "b": "fact:ws_2024"}]},
        down={"title": W("在跌的"), "rows": [
            {"label": lab("从俄罗斯进口的天然气，十亿立方米", "nrg_ti_gas", "2021", "2024"), "a": "fact:ru_gas_2021", "b": "fact:ru_gas_2024",
             "change": [{"w": "−"}, {"src": "fact:cut_ru_gas"}]},
            {"label": lab("煤电占发电量", "nrg_bal_peh", "2022", "2024"), "a": "fact:coal_2022", "b": "fact:coal_2024"},
            {"label": lab("发电和供热排放，百万吨", "env_air_gge", "2022", "2024"), "a": "fact:ghg_power_2022", "b": "fact:ghg_power_2024",
             "change": [{"w": "−"}, {"src": "fact:cut_ghg_power"}]}]},
        footnote=W("数据来源：欧盟统计局"))
    return rows, data, {}


def wb():
    names = {"IND": "印度", "VNM": "越南", "AUS": "澳大利亚", "CAN": "加拿大"}
    texts = {"fact:gdp_ind_2015": "1,590", "fact:gdp_ind_2023": "2,480", "fact:rise_gdp_ind": "890",
             "fact:gdp_vnm_2015": "2,580", "fact:gdp_vnm_2023": "4,350", "fact:rise_gdp_vnm": "1,770",
             "fact:co2_aus_2015": "16.8", "fact:co2_aus_2022": "14.9", "fact:cut_co2_aus": "1.9",
             "fact:co2_can_2015": "15.6", "fact:co2_can_2022": "14.3", "fact:cut_co2_can": "1.3"}
    rows = [{"src": k, "text": v} for k, v in texts.items()] + [{"src": f"name:zh_names:iso3:{c}", "text": n} for c, n in names.items()]
    rows += [{"src": f"period:{t}:{y}", "text": y} for t, ys in (("NY.GDP.PCAP.CD", ("2015", "2023")), ("EN.GHG.CO2.PC", ("2015", "2022"))) for y in ys]
    nm = lambda c, words, t, a, b: [{"name": c}, {"w": words + "（"}, P(t, a), {"w": "→"}, P(t, b), {"w": "）"}]
    data = dict(
        title=W("人均收入在涨，人均排放在降"),
        up={"title": W("人均收入，美元"), "rows": [
            {"label": nm("IND", "", "NY.GDP.PCAP.CD", "2015", "2023"), "a": "fact:gdp_ind_2015", "b": "fact:gdp_ind_2023",
             "change": [{"w": "多 "}, {"src": "fact:rise_gdp_ind"}]},
            {"label": nm("VNM", "", "NY.GDP.PCAP.CD", "2015", "2023"), "a": "fact:gdp_vnm_2015", "b": "fact:gdp_vnm_2023",
             "change": [{"w": "多 "}, {"src": "fact:rise_gdp_vnm"}]}]},
        down={"title": W("人均排放，吨"), "rows": [
            {"label": nm("AUS", "", "EN.GHG.CO2.PC", "2015", "2022"), "a": "fact:co2_aus_2015", "b": "fact:co2_aus_2022",
             "change": [{"w": "少 "}, {"src": "fact:cut_co2_aus"}]},
            {"label": nm("CAN", "", "EN.GHG.CO2.PC", "2015", "2022"), "a": "fact:co2_can_2015", "b": "fact:co2_can_2022",
             "change": [{"w": "少 "}, {"src": "fact:cut_co2_can"}]}]})
    return rows, data, names


SHAPES = {"eu": eu(), "wb": wb()}


def draw(data, rows, names, **style):
    K.setup(rows, names, run.tables)
    return winners_losers.draw({"data": data, "style": {"winners_losers": style}})


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
            cls.out[name] = draw(data, rows, names)
            if os.environ.get("LEAF_SVG_DIR"):
                os.makedirs(os.environ["LEAF_SVG_DIR"], exist_ok=True)
                svg, w, h = cls.out[name]
                with open(os.path.join(os.environ["LEAF_SVG_DIR"], f"winners_losers-{name}.svg"), "w", encoding="utf-8") as fh:
                    fh.write(themed(svg, w, h))

    def test_draws_and_every_digit_is_a_marked_ledger_run(self):
        for name, (svg, _, _) in self.out.items():
            self.assertEqual(check_svg(svg), [], name)

    def test_one_accent_on_the_chosen_column(self):
        for name, (svg, _, _) in self.out.items():
            ups = len(SHAPES[name][1]["up"]["rows"])
            self.assertEqual(svg.count("var(--accent)"), 2 + ups, name)  # the column title, its rule, each after-value
            self.assertIn('fill="var(--accent)" data-part="rule up"', svg)
            self.assertNotIn("#", svg, name)
        rows, data, names = SHAPES["eu"]
        self.assertIn('fill="var(--accent)" data-part="rule down"', draw(data, rows, names, accent="down")[0])
        self.assertNotIn("var(--accent)", draw(data, rows, names, accent="none")[0])

    def test_rows_keep_their_order(self):
        svg = self.out["eu"][0]
        srcs = re.findall(r'data-src="(fact:[a-z_]+_20\d\d)"', svg)
        self.assertEqual(srcs, ["fact:solar_add_2019", "fact:solar_add_2024", "fact:ws_2019", "fact:ws_2024", "fact:ru_gas_2021",
                                "fact:ru_gas_2024", "fact:coal_2022", "fact:coal_2024", "fact:ghg_power_2022", "fact:ghg_power_2024"])

    def test_its_rules(self):
        rows, data, names = SHAPES["eu"]
        d = json.loads(json.dumps(data))

        def refused(data, rows=rows, **style):
            with self.assertRaises(Refused) as e:
                draw(data, rows, names, **style)
            return str(e.exception)
        swapped = {**d, "up": {**d["up"], "rows": d["up"]["rows"] + d["down"]["rows"][:1]}}
        self.assertIn("does not rise", refused(swapped))
        self.assertIn("does not fall", refused({**d, "down": {**d["down"], "rows": d["up"]["rows"][:1]}}))
        self.assertIn("holds no rows", refused({**d, "down": {**d["down"], "rows": []}}))
        self.assertIn("is no number", refused(d, rows=[dict(r, text="很多") if r["src"] == "fact:coal_2022" else r for r in rows]))
        self.assertIn("lacks a value", refused({**d, "up": {**d["up"], "rows": [{"label": W("无"), "a": "fact:ws_2019"}]}}))
        self.assertIn("lines", refused({**d, "up": {**d["up"], "rows": [dict(d["up"]["rows"][0], label=W("很长的说明" * 30))]}}))
        self.assertIn("digit", refused({**d, "up": {**d["up"], "title": W("2024 在涨的")}}))
        self.assertIn("too narrow", refused(d, width=600))
        self.assertIn("not one of", refused(d, accent="green"))


if __name__ == "__main__":
    unittest.main()
