"""Self-test of the story findings node (runtime/leaves_py/findings.py) on two data shapes with test-only values and names:
  - an EU shape: a share in percent, the whole (EU27_2020) and eight members 2005-2024, a target of 42.5 in 2030 above every
    pace: all four angles stand, the path finds even the best year short;
  - a World Bank shape: six economies' tonnes per head 2010-2022 (iso3 codes, no whole, no target): the path and the need
    are dropped with why, the spread and the ends stand.
  - the chain angle (event_chain): the EU shape with three companion tables (a flow in bars, a price level in a line, a second
    flow) shares six years with the whole and the year the whole moved most (2020) is shaded across them; with one companion
    table, none, or no whole the angle is dropped with its why (a chain needs two tables and a whole).
Then each shape's picks are composed and every layer drawn by its own leaf over a ledger this test works out the way
next_facts does for the ops the node declares (value, per_year, line_at, step_max, reach_year, minus, times, group_change),
so a declared key the leaf reads and the facts lack, or a data shape the leaf refuses, fails here. Also: a pick that is no
candidate, one picked twice, a request with no format or a digit in its words is refused; candidates are ranked by score.
Run: python3 -I -B scripts/test_story_findings.py"""
import json
import math
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
sys.path.insert(0, HERE)  # a sibling test (python -I leaves the script's folder off the path)
import bake  # noqa: E402
import findings as FN  # noqa: E402
import geo  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402

SHAPES = os.path.join(HERE, "..", "runtime", "pi", "assets", "naturalearth-admin0-50m.geojson")
geo.NE = SHAPES  # the map leaf reads the countries' outlines from the request's shapes file

FMT_DEFS = {"x": {"scale": 1, "dec": 1, "suffix": ""}, "yr": {"scale": 1, "dec": 0, "suffix": ""},
            "times": {"scale": 1, "dec": 1, "suffix": ""}}
FMTS = {"value": "x", "year": "yr", "times": "times"}

EU_WHOLE = [10.2, 10.8, 11.7, 12.6, 13.9, 14.4, 14.5, 15.7, 16.7, 17.5, 17.8, 18.0, 18.4, 18.9, 19.9, 22.0, 21.9, 23.0, 24.1, 24.6]
# eight members: start level and pace a year (two fall)
EU_MEMBERS = {"SE": (40.0, 0.9), "FI": (28.0, 0.8), "AT": (24.0, 0.5), "DE": (7.0, 0.8), "FR": (9.5, 0.6), "PL": (7.0, 0.5),
              "NL": (2.5, 0.85), "MT": (6.0, -0.1), "LU": (5.0, -0.05)}
EU_NAMES = {"EU27_2020": "欧盟", "SE": "瑞典", "FI": "芬兰", "AT": "奥地利", "DE": "德国", "FR": "法国", "PL": "波兰",
            "NL": "荷兰", "MT": "马耳他", "LU": "卢森堡"}
WB = {"USA": (17.0, -0.3), "DEU": (9.5, -0.2), "CHN": (6.5, 0.15), "IND": (1.4, 0.06), "BRA": (2.2, 0.01), "ZAF": (8.8, -0.15)}
WB_NAMES = {"USA": "美国", "DEU": "德国", "CHN": "中国", "IND": "印度", "BRA": "巴西", "ZAF": "南非"}


def row(table, dims, code_dim, code, y, v):
    return {"src": f"series:{table}/{code}:{y}:OBS_VALUE", "table": table, "dims": {**dims, code_dim: code}, "time": str(y),
            "value": round(v, 3)}


def eu_request():
    t, fixed = "nrg_ind_ren", {"nrg_bal": "REN"}
    rows = [row(t, fixed, "geo", "EU27_2020", 2005 + i, v) for i, v in enumerate(EU_WHOLE)]
    for c, (a, p) in EU_MEMBERS.items():
        rows += [row(t, fixed, "geo", c, y, a + p * (y - 2005) + 0.3 * math.sin(y)) for y in range(2005, 2025)]
    rows.append({"src": "target:eu_res_2030", "table": "targets", "dims": {"geo": "EU27_2020", "target": "res_share"},
                 "time": "2030", "value": 42.5})
    return {"rows": rows, "main": {"table": t, "by": "geo", "whole": "EU27_2020", "filter": fixed,
                                   "members": [c for c in EU_MEMBERS]},
            "target": {"table": "targets", "filter": {"geo": "EU27_2020", "target": "res_share"}, "time": "2030"},
            "fmts": FMTS, "fmt_defs": FMT_DEFS, "words": {"measure": "可再生能源占比", "unit": "占最终能源消费的百分比"}}, EU_NAMES


def eu_chain_request():
    """The EU shape with three companion tables over 2019-2024 (the whole's biggest step is 2020: 19.9 -> 22.0)."""
    req, names = eu_request()
    ys = range(2019, 2025)
    rows = list(req["rows"])
    chain = []
    for table, dims, vals, words, kind in (
            ("nrg_ti_gas", {"partner": "RU"}, [166, 152, 150, 80, 43, 52], ("来自俄罗斯的天然气进口", "十亿立方米／年"), None),
            ("nrg_pc_204", {"price": "HH"}, [0.216, 0.213, 0.237, 0.284, 0.289, 0.288], ("家庭电价", "欧元／千瓦时"), "stock"),
            ("nrg_inf_epcrw", {"tech": "PV"}, [16, 19, 28, 40, 56, 65], ("光伏新增装机", "吉瓦／年"), None)):
        rows += [{"src": f"series:{table}/{'.'.join(dims.values())}:{y}:OBS_VALUE", "table": table, "dims": dims, "time": str(y), "value": v}
                 for y, v in zip(ys, vals)]
        chain.append({"table": table, "filter": dims, "words": {"measure": words[0], "unit": words[1]}, **({"kind": kind} if kind else {})})
    # the formats a chain item with no "fmt" takes by size: three a table, the unit suffix the flow gives (none here)
    fmts = {f"{c['table']}_d{d}": {"scale": 1, "dec": d, "suffix": ""} for c in chain for d in (0, 1, 2)}
    return {**req, "rows": rows, "chain": chain, "chain_fmts": fmts}, names


def wb_request():
    t = "EN.GHG.CO2.PC.CE.AR5"
    # the knowledge group gives a value as the source's decimal text: this shape's rows hold it so
    rows = [{**row(t, {}, "country", c, y, a + p * (y - 2010)), "value": f"{a + p * (y - 2010):.2f}"} for c, (a, p) in WB.items()
            for y in range(2010, 2023)]
    return {"rows": rows, "main": {"table": t, "by": "country"}, "fmts": FMTS, "fmt_defs": FMT_DEFS,
            "words": {"measure": "人均二氧化碳排放", "unit": "吨／人"}}, WB_NAMES


# ---------------------------------------------------------------- the three data-representation angles (movers, overtake, tiles)

EU27 = {  # test-only: a share in percent at 2005 and at 2024 (a bumpy path between), not data
    "SE": (40.5, 66.0), "LV": (32.3, 43.0), "FI": (28.9, 52.0), "AT": (24.0, 40.0), "PT": (19.5, 35.0), "DK": (16.0, 45.0), "EE": (17.5, 41.0),
    "LT": (17.0, 31.0), "HR": (23.0, 31.0), "SI": (16.0, 26.0), "RO": (17.0, 24.0), "ES": (8.0, 25.0), "FR": (9.5, 24.0), "EL": (7.0, 24.0),
    "BG": (9.5, 20.0), "DE": (7.0, 22.0), "IT": (7.5, 20.0), "SK": (6.0, 17.0), "PL": (7.0, 17.0), "CZ": (6.0, 18.0), "HU": (6.5, 16.0),
    "BE": (2.5, 14.0), "IE": (3.0, 17.0), "CY": (3.0, 20.0), "LU": (1.5, 12.0), "MT": (0.2, 15.0), "NL": (2.5, 17.0)}
EU27_NAMES = {"EU27_2020": "欧盟", "SE": "瑞典", "LV": "拉脱维亚", "FI": "芬兰", "AT": "奥地利", "PT": "葡萄牙", "DK": "丹麦", "EE": "爱沙尼亚", "LT": "立陶宛",
              "HR": "克罗地亚", "SI": "斯洛文尼亚", "RO": "罗马尼亚", "ES": "西班牙", "FR": "法国", "EL": "希腊", "BG": "保加利亚", "DE": "德国", "IT": "意大利",
              "SK": "斯洛伐克", "PL": "波兰", "CZ": "捷克", "HU": "匈牙利", "BE": "比利时", "IE": "爱尔兰", "CY": "塞浦路斯", "LU": "卢森堡", "MT": "马耳他", "NL": "荷兰"}
WB12 = {"USA": (19.5, 14.0), "DEU": (10.1, 7.6), "CHN": (5.0, 8.0), "IND": (1.1, 2.0), "BRA": (1.9, 2.3), "ZAF": (8.0, 6.7), "JPN": (9.8, 8.0),
        "AUS": (18.0, 14.5), "CAN": (17.5, 14.0), "FRA": (6.4, 4.4), "GBR": (8.8, 4.5), "IDN": (1.4, 2.8)}
WB12_NAMES = {"USA": "美国", "DEU": "德国", "CHN": "中国", "IND": "印度", "BRA": "巴西", "ZAF": "南非", "JPN": "日本", "AUS": "澳大利亚", "CAN": "加拿大",
              "FRA": "法国", "GBR": "英国", "IDN": "印度尼西亚"}


def eu27_request(members=None):
    """Twenty-seven members and the whole, 2005-2024, with the whole's target and the members' points."""
    import test_leaves_member_map as MM
    members = members or EU27
    t, fixed = "nrg_ind_ren", {"nrg_bal": "REN"}
    rows = [row(t, fixed, "geo", "EU27_2020", 2005 + i, 10.2 + (24.6 - 10.2) * i / 19) for i in range(20)]
    for c, (a, b) in members.items():
        rows += [row(t, fixed, "geo", c, y, a + (b - a) * (y - 2005) / 19 + 0.6 * math.sin((y - 2005) * 1.7 + len(c) * ord(c[0]))) for y in range(2005, 2025)]
    rows.append({"src": "target:eu_res_2030", "table": "targets", "dims": {"geo": "EU27_2020", "target": "res_share"}, "time": "2030", "value": 42.5})
    return {"rows": rows, "main": {"table": t, "by": "geo", "whole": "EU27_2020", "filter": fixed, "members": list(members)},
            "target": {"table": "targets", "filter": {"geo": "EU27_2020", "target": "res_share"}, "time": "2030"},
            "fmts": FMTS, "fmt_defs": FMT_DEFS, "words": {"measure": "可再生能源占比", "unit": "占最终能源消费的百分比"},
            "points": {c: list(geo.PT[c]) if c in geo.PT else [0.0, 0.0] for c in members}}, EU27_NAMES


def wb12_request():
    """Twelve economies, 2010-2022, no whole and no target, with the economies' points."""
    import test_leaves_member_map as MM
    t = "EN.GHG.CO2.PC.CE.AR5"
    rows = []
    for c, (a, b) in WB12.items():
        for y in range(2010, 2023):
            v = a + (b - a) * (y - 2010) / 12 + 0.15 * math.sin((y - 2010) * 2.1 + ord(c[1]))
            rows.append({**row(t, {}, "country", c, y, v), "value": f"{v:.2f}"})
    return {"rows": rows, "main": {"table": t, "by": "country"}, "fmts": FMTS, "fmt_defs": FMT_DEFS,
            "words": {"measure": "人均二氧化碳排放", "unit": "吨／人"}, "points": MM.attribute_points(list(WB12))}, WB12_NAMES


# ---------------------------------------------------------------- facts as next_facts works them out (the ops used here)

def compute(facts, rows, members):
    out = {}
    rows = [{**r, "value": float(r["value"])} for r in rows]

    def sel(q):
        return [r for r in rows if r["table"] == q["table"] and all(r["dims"].get(k) == (v if isinstance(v, str) else r["dims"].get(k))
                                                                     and (not isinstance(v, list) or r["dims"].get(k) in v)
                                                                     for k, v in (q.get("filter") or {}).items())]

    def get(k):
        if k in out: return out[k]
        q = facts[k]; op = q.get("op", "value"); f = {"fmt": q["fmt"]}
        if op == "value":
            at = [r for r in sel(q) if r["time"] == q["time"]]
            assert at, f"{k}: no row at {q['time']}"
            f.update(v=sum(r["value"] for r in at), t=q["time"])
        elif op in ("per_year", "cagr"):
            a, b = get(q["a"]), get(q["b"]); n = int(a["t"]) - int(b["t"]); assert n > 0, k
            f.update(v=(a["v"] - b["v"]) / n)
        elif op == "line_at":
            s, r = get(q["start"]), get(q["rate"])
            f.update(v=s["v"] + r["v"] * (int(q["at"]) - int(s["t"])), t=q["at"])
        elif op == "step_max":
            ser = sorted((r["time"], r["value"]) for r in sel(q) if q.get("from", "") <= r["time"] <= q.get("to", "9999"))
            steps = [(ser[i][1] - ser[i - 1][1], ser[i][0]) for i in range(1, len(ser)) if int(ser[i][0]) == int(ser[i - 1][0]) + 1]
            best = max(steps, key=lambda s: s[0]); f.update(v=best[0], t=best[1])
        elif op == "reach_year":
            s, r, g = get(q["start"]), get(q["rate"]), get(q["target"]); assert r["v"] > 0, k
            f.update(v=int(s["t"]) + math.ceil((g["v"] - s["v"]) / r["v"]))
        elif op in ("minus", "times"):
            a, b = get(q["a"]), get(q["b"])
            f.update(v=a["v"] - b["v"] if op == "minus" else a["v"] / b["v"])
        elif op == "position":
            rs = sel(q)
            at = {}
            for r in rs:
                if r["time"] == q["time"]: at[r["dims"][q["by"]]] = at.get(r["dims"][q["by"]], 0) + r["value"]
            f.update(v=1 + sum(1 for v in at.values() if v > at[q["code"]]))
        elif op == "mean":
            at = [r for r in sel(q) if r["time"].startswith(q["within"])]
            assert at, f"{k}: no row within {q['within']}"
            f.update(v=sum(r["value"] for r in at) / len(at), t=q.get("time"))
        elif op == "n":
            f.update(v=len({r["dims"][q["by"]] for r in sel(q) if r["time"] == q["time"]}))
        elif op == "group_change":
            rs = sel(q)
            val = lambda c, t: sum(r["value"] for r in rs if r["dims"][q["by"]] == c and r["time"] == t)
            ranked = sorted(members, key=lambda c: -val(c, q["from"]))
            grp = ranked[:q["k"]] if q["part"] == "top" else ranked[::-1][:q["k"]]
            f.update(v=sum(val(c, q["to"]) - val(c, q["from"]) for c in grp) / q["k"])
        else:
            raise AssertionError(f"{k}: the test knows no op {op}")
        out[k] = f
        return f

    for k in facts: get(k)
    return out


def ledger(req, composed, names):
    rows = list(req["rows"])
    members = req["main"].get("members") or sorted({r["dims"][req["main"]["by"]] for r in rows if r["table"] == req["main"]["table"]})
    facts = compute(composed["facts"], rows, members)
    for k, f in facts.items():
        d = {"n": {"scale": 1, "dec": 0, "suffix": ""}, **FMT_DEFS, **req.get("fmt_defs", {}), **req.get("chain_fmts", {})}[f["fmt"]]
        rows.append({"src": f"fact:{k}", "text": f"{f['v'] * d['scale']:,.{d['dec']}f}{d['suffix']}"})
        rows.append({"src": f"fact:{k}.n", "text": f"{f['v'] * d['scale']:,.{d['dec']}f}"})  # the bare number a placeholder prints
        # a year entry for what the first layer gives one: a value read at one year, and what carries its own year (the best step's, a line's)
        if "t" in f and composed["facts"][k].get("op", "value") in ("value", "step_max", "line_at"): rows.append({"src": f"fact:{k}.t.y", "text": f["t"]})
        if composed["facts"][k].get("axis"):
            rows += [{"src": f"fact:{k}.tick{i}", "text": f"{v:,.{d['dec']}f}"} for i, v in enumerate(FN.ticks(f["v"], d), 1)]
    for t in sorted({(r["table"], r["time"]) for r in req["rows"]}):
        rows.append({"src": f"period:{t[0]}:{t[1]}", "text": t[1]})
    for c, n in names.items():
        rows.append({"src": K.name_row(c, "place"), "text": n})
    return rows, facts


def draw_all(test, req, names, picks):
    composed = FN.compose({**req, "picks": picks})
    rows, facts = ledger(req, composed, names)
    K.setup(rows, names, run.tables)
    drawn = {}
    for layer, data in composed["leaves"].items():
        if layer == "bignums": continue  # html, drawn by the page child (test_header_*)
        mod = __import__(layer)
        svg = mod.draw({"data": data, "style": {layer: dict(composed.get("style", {}).get(layer, {}))}})
        svg = svg[0] if isinstance(svg, tuple) else svg
        words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", str(svg)))
        test.assertFalse(re.search(r"[0-9]", words), f"{layer}: a digit outside a ledger run: {words[:80]!r}")
        drawn[layer] = svg
    # every placeholder a title or text writes is a fact the page declares (or a name of the request)
    for s in composed["sections"]:
        for k in ("title", "text"):
            for ph in re.findall(r"\{([^}]+)\}", s.get(k) or ""):
                key = ph.split(".")[0]
                test.assertTrue(key == "name" and ph.split(".")[1] in names or key in facts, f"{s['id']} {k}: {{{ph}}} is no fact")
        if s.get("title"):
            test.assertRegex(s["title"], r"\{(?!name\.)[a-z_0-9]+\}", f"{s['id']}: the title prints no number")
    return composed, facts, drawn


class Findings(unittest.TestCase):
    def test_eu_all_angles_and_best_year_short(self):
        req, names = eu_request()
        _, cands, dropped = FN.candidates(req)
        # the request carries no chain, no points and no groups; its nine members' paces all bend one way (no slower column)
        self.assertEqual([d["angle"] for d in dropped], ["map", "tiles", "chain", "groups"])
        self.assertEqual(sorted(c["id"] for c in cands), ["ends", "members", "movers", "need", "overtake", "pace", "path", "rank", "spread"])
        self.assertEqual([c["score"] for c in cands], sorted((c["score"] for c in cands), reverse=True))
        path = next(c for c in cands if c["id"] == "path")
        self.assertEqual(path["title"][0], ("w", "就算每年都像 "))  # even the best year falls short of 42.5
        composed, facts, drawn = draw_all(self, req, names, ["path", "need", "spread"])
        self.assertLess(facts["p_best"]["v"], facts["goal"]["v"])
        self.assertEqual(facts["best"]["t"], "2020")
        self.assertEqual([s["layer"] for s in composed["sections"]],
                         ["bignums", "thesis_claims", "target_path", "gap_axis", "winners_losers", "risk_notes"])
        self.assertEqual(set(drawn), {"thesis_claims", "target_path", "gap_axis", "winners_losers", "risk_notes"})

    def test_wb_no_target_drops_path_and_need(self):
        req, names = wb_request()
        _, cands, dropped = FN.candidates(req)
        self.assertEqual({d["angle"]: d["why"] for d in dropped}, {"path": "no target row", "need": "no target row", "map": "the request gives no points for the members", "tiles": "the request gives no points for the members", "chain": "the request's chain holds fewer than 2 tables",
                                                                  "pace": "every member changed pace the same way and a pace is below 0 (no picture stands)", "groups": "the request gives no groups of the members"})
        self.assertEqual(sorted(c["id"] for c in cands), ["ends", "members", "movers", "overtake", "rank", "spread"])
        composed, facts, drawn = draw_all(self, req, names, ["ends", "spread"])
        self.assertEqual(composed["leaves"]["pair_bars"]["places"], ["USA", "IND"])
        self.assertAlmostEqual(facts["hi_lo"]["v"], (17.0 - 0.3 * 12) / (1.4 + 0.06 * 12), places=2)
        # the falling places are in the falling column, the rising in the rising one
        wl = composed["leaves"]["winners_losers"]
        self.assertEqual({r["label"][0]["name"] for r in wl["down"]["rows"]}, {"USA", "DEU", "ZAF"})
        self.assertNotIn("scenario", str(composed["leaves"].get("risk_notes")))

    def test_chain_three_tables_around_the_year_the_whole_moved_most(self):
        req, names = eu_chain_request()
        _, cands, dropped = FN.candidates(req)
        self.assertEqual([d["angle"] for d in dropped], ["map", "tiles", "groups"])
        chain = next(c for c in cands if c["id"] == "chain")
        self.assertEqual((chain["layer"], chain["why"]["band"]), ("event_chain", "2022"))
        self.assertTrue(0 < chain["score"] <= 1)
        composed, facts, drawn = draw_all(self, req, names, ["chain", "path"])
        self.assertEqual([s["layer"] for s in composed["sections"]], ["bignums", "thesis_claims", "event_chain", "target_path", "risk_notes"])
        data = composed["leaves"]["event_chain"]
        self.assertEqual([(p["code"], p["kind"], p["zero"], "link" in p) for p in data["panels"]],
                         [("c1", "bar", True, True), ("c2", "line", False, True), ("c3", "bar", True, False)])
        self.assertEqual([len(p["points"]) for p in data["panels"]], [6, 6, 6])
        self.assertEqual((data["band"]["from"], data["band"]["to"]), ("2022", "2022"))
        # the band is the year the tables together moved most, each step over its own range (2022: the gas, the price and the
        # panels' sum 1.43 against 0.69 in 2023); the title's number is the whole's own change that year, the larger value
        # less the smaller (21.9 -> 23.0), not the year the whole moved most (2020)
        self.assertAlmostEqual(facts["m_step"]["v"], 23.0 - 21.9, places=6)
        self.assertEqual(facts["band_y"]["t"], "2022")
        # the formats are taken by size: 1000 or more none, 10 or more one decimal place, under 10 two
        self.assertEqual([facts[f"c{i}_first"]["fmt"] for i in (1, 2, 3)], ["nrg_ti_gas_d1", "nrg_pc_204_d2", "nrg_inf_epcrw_d1"])
        self.assertEqual((facts["c1_first"]["t"], facts["c1_last"]["t"]), ("2019", "2024"))
        title = composed["title"]  # the chain leads: its title is the page's headline
        self.assertIn("{m_step}", title); self.assertIn("{band_y.t}", title)
        self.assertEqual(title.count("{"), 2)
        # one chart per leaf: the panels' words come from the request, the file writes no word of its own
        self.assertEqual("".join(x["w"] for x in data["panels"][0]["title"]), "来自俄罗斯的天然气进口")
        with self.assertRaisesRegex(FN.Refused, "chain"):
            FN.compose({**req, "chain": req["chain"][:1], "picks": ["path", "chain"]})

    def test_chain_dropped_when_it_cannot_be_told(self):
        req, _ = eu_chain_request()
        why = lambda r: {d["angle"]: d["why"] for d in FN.candidates(r)[2]}.get("chain")
        self.assertEqual(why({**req, "chain": req["chain"][:1]}), "the request's chain holds fewer than 2 tables")
        self.assertEqual(why({k: v for k, v in req.items() if k != "chain"}), "the request's chain holds fewer than 2 tables")
        self.assertEqual(why({**req, "main": {**req["main"], "whole": None}}), "no whole to print its change by")
        # a companion that shares too few years with the whole
        short = [dict(c) for c in req["chain"]]
        short[0] = dict(short[0], filter={"partner": "NO"})
        extra = [row("nrg_ti_gas", {"partner": "NO"}, "x", "a", y, 5.0) for y in (2023, 2024)]
        for r in extra: r["dims"] = {"partner": "NO"}
        self.assertRegex(why({**req, "chain": short, "rows": req["rows"] + extra}), "fewer than 4 years in a row")
        # two rows at one year at the filter are ambiguous, not summed
        dup = [dict(r, src=r["src"] + ":dup") for r in req["rows"] if r["table"] == "nrg_ti_gas" and r["time"] == "2021"]
        self.assertRegex(why({**req, "rows": req["rows"] + dup}), "two rows at 2021")
        bad = [dict(req["chain"][0], words={"measure": "俄气 2021", "unit": "x"}), req["chain"][1]]
        self.assertRegex(why({**req, "chain": bad}), "hold a digit")
        # an item's own kind overrides the default rule, and a flow with a value below 0 cannot be bars: a line on its own range
        self.assertIsNone(why({**req, "chain": [dict(req["chain"][0], kind="flow"), req["chain"][1]]}))
        down = [dict(r, value=r["value"] - 100) if r["table"] == "nrg_ti_gas" else r for r in req["rows"]]
        panels = FN.compose({**req, "rows": down, "picks": ["path", "chain"]})["leaves"]["event_chain"]["panels"]
        self.assertEqual((panels[0]["kind"], panels[0]["zero"]), ("line", False))

    def test_the_leaf_child_reads_the_program_operators_from_the_ledger(self):
        """A page_story request whose spec.facts holds per_year, line_at, step_max, reach_year, group_change and times is drawn by
        the real child: it reads those facts' values and periods from the request's ledger (layer 1 is the only one to work them
        out) and never stops at an operator it does not know. With no ledger it refuses, naming the operator; a page of the old
        operators is worked out here as before."""
        import json, subprocess
        import facts as FX
        for build, picks in ((eu_chain_request, ["path", "need", "spread", "chain"]), (eu_request, ["path", "need", "spread"])):
            req, names = build()
            composed = FN.compose({**req, "picks": picks})
            ops = {q.get("op") for q in composed["facts"].values()}
            self.assertTrue({"per_year", "line_at", "step_max", "group_change", "times"} <= ops, ops)
            rows, facts = ledger(req, composed, names)
            spec = {"title": composed["title"], "kicker": "k", "dek": composed["dek"], "end": composed["end"], "source": "s", "refs": [], "facts": composed["facts"], "sections": composed["sections"],
                    "tables": {t: {"id": t} for t in sorted({r["table"] for r in req["rows"]})}, "fmts": {**FMT_DEFS, "time": {}},
                    "hero": {"data": {}, "leaves": composed["leaves"]}}
            line = lambda **kv: json.dumps({"node": "page_story", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows,
                                            "knobs": {"spec": spec, "labels": names}, **kv}, ensure_ascii=False)
            layers = [s_["layer"] for s_ in composed["sections"]]
            lines = [line(phase="size")] + [line(layer=n) for n in layers]
            run_child = lambda ls: [json.loads(x) for x in subprocess.run([sys.executable, "-I", "-B", run.__file__], input="\n".join(ls) + "\n",
                                                                       capture_output=True, text=True, timeout=120, check=True).stdout.splitlines()]
            got = run_child(lines)
            self.assertFalse([g for g in got if "refused" in g or "error" in g], got)
            # layer 1 takes a size only when both sides are above 0 (next_leaf: "the panel w h is no size", st1 11-23)
            self.assertTrue(got[0]["w"] > 0 and got[0]["h"] > 0, got[0])
            last = run_child(lines + [json.dumps({"phase": "page", "layers": {n: g.get("svg") or g.get("html") for n, g in zip(layers, got[1:])}, "sizes": {}}, ensure_ascii=False)])[-1]
            self.assertIn("html", last, last)
            # a number a title prints through a program operator is the ledger's bare number
            self.assertIn(rows[[r["src"] for r in rows].index("fact:past.n")]["text"], last["html"])
        # facts.compute: no ledger -> refused, naming the operator; a ledger -> the ledger's value and period
        spec = {"facts": {"a": {"op": "per_year", "a": "x", "b": "y", "fmt": "x"}}}
        FX.LEDGER = None
        with self.assertRaisesRegex(FX.Refused, "per_year"):
            FX.compute(spec, {})
        FX.LEDGER = {"fact:a.n": "1,234.5", "fact:a.t.y": "2030"}
        try:
            self.assertEqual(FX.compute(spec, {})["a"], {"v": 1234.5, "fmt": "x", "src": "ledger(a)", "t": "2030"})
            FX.LEDGER = {}
            with self.assertRaisesRegex(FX.Refused, "not in the request's ledger"):
                FX.compute(spec, {})
        finally:
            FX.LEDGER = None

    def test_chain_formats_and_the_band_follow_the_rules(self):
        req, _ = eu_chain_request()
        fmts = lambda r: [FN.compose({**r, "picks": ["path", "chain"]})["facts"][f"c{i}_first"]["fmt"] for i in (1, 2, 3)]
        big = [dict(r, value=r["value"] * 100) if r["table"] == "nrg_ti_gas" else r for r in req["rows"]]
        self.assertEqual(fmts({**req, "rows": big})[0], "nrg_ti_gas_d0")          # 16 600 and more: no decimal place
        # an item's own fmt wins over the size rule; a fmt the request does not define refuses the angle
        own = [dict(req["chain"][0], fmt="x")] + req["chain"][1:]
        self.assertEqual(fmts({**req, "chain": own})[0], "x")
        why = lambda r: {d["angle"]: d["why"] for d in FN.candidates(r)[2]}.get("chain")
        self.assertRegex(why({k: v for k, v in req.items() if k != "chain_fmts"}), "chain_fmts does not define")
        self.assertIsNone(why({k: v for k, v in req.items() if k != "chain_fmts"} | {"chain": [dict(c, fmt="x") for c in req["chain"]]}))
        # a flow is bars at any number of years (the old cap of eight years is gone); a stock stays a line
        twelve = [r for r in req["rows"] if r["table"] not in ("nrg_ti_gas", "nrg_inf_epcrw", "nrg_pc_204")]
        for table, dims, base in (("nrg_ti_gas", {"partner": "RU"}, 100), ("nrg_inf_epcrw", {"tech": "PV"}, 20), ("nrg_pc_204", {"price": "HH"}, 0.2)):
            twelve += [{"src": f"series:{table}/{'.'.join(dims.values())}:{y}:OBS_VALUE", "table": table, "dims": dims, "time": str(y),
                        "value": base + base * ((y * 7) % 11) / 10} for y in range(2013, 2025)]
        panels = FN.compose({**req, "rows": twelve, "picks": ["path", "chain"]})["leaves"]["event_chain"]["panels"]
        self.assertEqual([(len(p["points"]), p["kind"]) for p in panels], [(12, "bar"), (12, "line"), (12, "bar")])
        # the band is the year of the largest summed steps over each table's range: a table that does not move adds nothing
        still = [dict(r, value=7.0) if r["table"] == "nrg_inf_epcrw" else r for r in req["rows"]]
        self.assertEqual(next(c for c in FN.candidates({**req, "rows": still})[1] if c["id"] == "chain")["why"]["band"], "2022")
        allstill = [dict(r, value=7.0) if r["table"] in ("nrg_inf_epcrw", "nrg_ti_gas", "nrg_pc_204") else r for r in req["rows"]]
        self.assertEqual(why({**req, "rows": allstill}), "no chain table moves over the shared years")

    def test_rank_with_the_whole_among_the_members(self):
        req, names = eu_request()
        _, cands, _ = FN.candidates(req)
        rank = next(c for c in cands if c["id"] == "rank")
        self.assertEqual(rank["layer"], "rankbar")
        composed, facts, drawn = draw_all(self, req, names, ["path", "rank", "spread"])
        data = composed["leaves"]["rankbar"]
        # the nine members and the whole, each row a fact of its own; the accent row is the whole's
        self.assertEqual(len(data["rows"]), 10)
        self.assertEqual(data["highlight"], "EU27_2020")
        self.assertEqual({r["code"] for r in data["rows"]}, set(EU_MEMBERS) | {"EU27_2020"})
        last = {c: a + p * 19 + 0.3 * math.sin(2024) for c, (a, p) in EU_MEMBERS.items()}
        above = sum(1 for v in last.values() if v > EU_WHOLE[-1])
        self.assertEqual(facts["pos"]["v"], 1 + above)  # position among the members and the whole itself
        self.assertAlmostEqual(facts["g_se"]["v"], facts["r_se"]["v"] - facts["r_eu27_2020"]["v"], places=6)
        self.assertAlmostEqual(facts["g_eu27_2020"]["v"], 0.0)
        self.assertIn("goal", facts)  # the target is said in the text (the leaf draws no line), a fact of the page
        sec = next(s_ for s_ in composed["sections"] if s_["layer"] == "rankbar")
        self.assertIn("{pos}", sec["title"]); self.assertIn("{goal}", sec["text"])
        self.assertEqual(sec["title"].count("{"), 5)  # whole, year, number, highest, lowest: every number a fact
        # the rows drawn from the highest down
        svg = drawn["rankbar"][0] if isinstance(drawn["rankbar"], tuple) else drawn["rankbar"]
        self.assertGreater(len(re.findall("<rect", svg)), 9)

    def test_rank_without_a_whole_ranks_the_members_from_the_highest(self):
        req, names = wb_request()
        composed, facts, drawn = draw_all(self, req, names, ["rank", "ends"])
        data = composed["leaves"]["rankbar"]
        self.assertEqual((len(data["rows"]), data["highlight"]), (6, "USA"))
        self.assertNotIn("pos", facts)
        self.assertAlmostEqual(facts["g_usa"]["v"], 0.0)  # measured from the highest
        self.assertTrue(all(facts[f"g_{c.lower()}"]["v"] <= 0 for c in WB))
        self.assertEqual(composed["leaves"]["rankbar"]["share_head"], FN.ST("story.rank.gap_top_head"))

    # ---------------------------------------------------------------- the header: three big numbers above the thesis

    def _page(self, req, names, picks, style=None, edit=None, refused=False):
        """The composed page drawn by the real child: (composed, facts, {layer: its svg or html}, the page's html); `style` is hero.style
        (the page layout's knobs)."""
        import json, subprocess
        composed = FN.compose({**req, "picks": picks})
        if edit: edit(composed)
        rows, facts = ledger(req, composed, names)
        spec = {"title": composed["title"], "kicker": "k", "dek": composed["dek"], "end": composed["end"], "source": "s", "refs": [], "facts": composed["facts"], "sections": composed["sections"],
                "tables": {t: {"id": t} for t in sorted({r["table"] for r in req["rows"]})}, "fmts": {**FMT_DEFS, "n": {"scale": 1, "dec": 0, "suffix": ""}, "time": {}},
                "hero": {"data": {}, "leaves": composed["leaves"], "style": {**composed.get("style", {}), **(style or {})}}}
        line = lambda **kv: json.dumps({"node": "page_story", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows,
                                        "knobs": {"spec": spec, "labels": names, "shapes": SHAPES}, **kv}, ensure_ascii=False)
        layers = [x["layer"] for x in composed["sections"]]
        lines = [line(phase="size")] + [line(layer=n) for n in layers]
        go = lambda ls: [json.loads(x) for x in subprocess.run([sys.executable, "-I", "-B", run.__file__], input="\n".join(ls) + "\n",
                                                               capture_output=True, text=True, timeout=120, check=True).stdout.splitlines()]
        got = go(lines)
        if refused: return [g for g in got if "refused" in g or "error" in g]  # what the child refused, for a test of a rule
        self.assertFalse([g for g in got if "refused" in g or "error" in g], got)
        self.assertTrue(got[0]["w"] > 0 and got[0]["h"] > 0, got[0])  # the size phase tells layer 1 a panel it can take
        bodies = {n: g.get("svg") or g.get("html") for n, g in zip(layers, got[1:])}
        self.size, self.replies = got[0], dict(zip(layers, got[1:]))
        self.words = {n: g["words"] for n, g in zip(layers, got[1:]) if "words" in g}  # what each story layer tells layer 1 of its overlay words
        # the first layer takes a text of an svg only with a src: every <text> of every svg layer has one (a word with no ledger entry is html over the picture)
        for n, g in zip(layers, got[1:]):
            if g.get("svg"):
                texts, bad = run.drawn(g["svg"])
                self.assertEqual(bad, [], n)
                self.assertEqual([x["text"] for x in texts if not x["src"]], [], f"{n}: texts with no src")
        last = go(lines + [json.dumps({"phase": "page", "layers": bodies, "sizes": {}}, ensure_ascii=False)])[-1]
        self.assertFalse(last.get("refused"), last)
        return composed, facts, bodies, last["html"]

    def _once(self, page_html):
        """The page's headline is a conclusion printed once: the h1 holds a marked ledger number, fits the headline's 100 characters, and
        no sentence of the page's words (cut at the full stop, 8 characters or more) stands twice, the h1's included."""
        h1 = re.search(r"<h1>(.*?)</h1>", page_html, re.S)[1]
        self.assertRegex(h1, r'data-src="fact:', "the headline prints no number of the ledger")
        flat = lambda x: re.sub(r"<[^>]+>", "", x)
        self.assertLessEqual(len(flat(h1)), 100)
        body = flat(re.sub(r"<(style|footer)\b.*?</\1>", "", page_html, flags=re.S))
        sentences = [x.strip() for x in re.split(r"[。\n]", body) if len(x.strip()) >= 8]
        twice = sorted({x for x in sentences if sentences.count(x) > 1})
        self.assertEqual(twice, [], "a sentence stands twice on the page")
        self.assertEqual(body.count(flat(h1)), 1, "the headline is printed again on the page")
        return flat(h1)

    def test_the_headline_is_the_lead_finding_once(self):
        """Two shapes of the lead: the best year falls short of the target (path 'short', need first or second), and the recent pace (target 30) or only the best year (33) gets there. The lead's conclusion is the page's h1 and its text the dek; the thesis block holds the claims alone and the lead's
        section is headed by its claim and number, so neither prints the headline's sentence again."""
        for target, picks, words in ((42.5, ["need", "path", "spread"], "每年得涨"), (42.5, ["path", "need"], "也只到"), (30.0, ["path", "spread"], "年能到"), (33.0, ["path", "spread"], "年才到目标")):
            req, names = eu_request()
            req["rows"] = [dict(r, value=target) if r["table"] == "targets" else r for r in req["rows"]]
            composed, facts, bodies, page_html = self._page(req, names, picks)
            h1 = self._once(page_html)
            self.assertIn(words, h1)
            lead = composed["sections"][2]
            self.assertEqual(lead["id"], picks[0])
            self.assertNotIn("text", lead)                      # the dek says it
            self.assertNotEqual(lead["title"], composed["title"])
            self.assertIn("：", lead["title"]); self.assertRegex(lead["title"], r"\{[a-z_0-9]+\}$")  # the claim's words, then its number
            self.assertNotIn("answer", composed["leaves"]["thesis_claims"])
            dek = re.search(r'<p class="dek">(.*?)</p>', page_html, re.S)[1]
            self.assertIn("data-src", dek)
            for other in composed["sections"][3:]:
                if other.get("title"): self.assertNotIn(other["title"], composed["title"])

    # ---------------------------------------------------------------- the arcs (i34): the first pick says how the page is told

    def _arc_request(self):
        req, names = eu_chain_request()
        req["chain"] = [req["chain"][0], req["chain"][2]]
        return req, names

    def test_the_first_pick_is_the_arc_and_the_arc_fixes_order_header_and_ending(self):
        """The same rows told three ways: the chain finding first is "happened", need or path first "in_time", a members' comparison
        first "lagging"; each gives its own headline, section order, header numbers and closing line."""
        req, names = self._arc_request()
        told = {}
        for arc, picks in (("happened", ["chain", "path"]), ("in_time", ["need", "path", "spread"]), ("lagging", ["rank", "spread", "path"])):
            composed, facts, bodies, page_html = self._page(req, names, picks)
            self.assertEqual(composed["arc"]["id"], arc, picks)
            h1 = self._once(page_html)
            end = re.search(r"<p class=end>(.*?)</p>", page_html, re.S)[1]
            self.assertRegex(end, r'data-src="fact:' if arc != "lagging" else r"名次只说明")
            told[arc] = (h1, [s["layer"] for s in composed["sections"]], [i["fact"] for i in composed["leaves"]["bignums"]["bignums"]],
                         re.sub(r"<[^>]+>", "", end))
        self.assertEqual(len({v[0] for v in told.values()}), 3)   # three headlines
        self.assertEqual(len({v[3] for v in told.values()}), 3)   # three closing lines
        self.assertEqual(len({tuple(v[2]) for v in told.values()}), 3)   # three headers
        self.assertEqual(told["happened"][2], ["b_now", "m_step"])
        self.assertEqual(told["in_time"][2], ["b_now", "b_gap", "b_end"])
        self.assertEqual(told["lagging"][2], ["b_hi", "b_lo", "b_ratio"])
        self.assertEqual(told["happened"][1][2:4], ["event_chain", "target_path"])     # the event, then the outlook last
        self.assertEqual(told["in_time"][1][2:5], ["gap_axis", "target_path", "winners_losers"])   # the need, the path, then who lags
        self.assertEqual(told["lagging"][1][2:4], ["rankbar", "winners_losers"])   # the comparisons first, the outlook last
        self.assertEqual(told["lagging"][1][-2], "target_path")

    def test_with_no_target_the_page_tells_the_happened_or_the_lagging_arc_and_says_no_target(self):
        """pj004-23: a request with no target row (the recipe went without has_target) on two data shapes, an EU shape with the
        whole and its chain, a World Bank shape of twelve economies with no whole: path and need are dropped (no target row), the
        rest stand; the chain first tells "happened", a comparison first "lagging"; the header, the notes, the sections and the
        closing line name no target, declare no goal fact and leave no placeholder empty, and the page is drawn by the real child."""
        eu, eu_names = self._arc_request()
        wb, wb_names = wb12_request()
        for req, names, told in ((eu, eu_names, (("happened", ["chain", "spread"]), ("lagging", ["rank", "spread", "chain"]))),
                                 (wb, wb_names, (("lagging", ["rank", "members", "overtake"]), ("lagging", ["spread", "ends"])))):
            req = {**req, "rows": [r for r in req["rows"] if not r["src"].startswith("target:")]}
            req.pop("target", None)
            _, cands, dropped = FN.candidates(req)
            ids = [c["id"] for c in cands]
            self.assertEqual({d["angle"]: d["why"] for d in dropped if d["angle"] in ("path", "need")},
                             {"path": "no target row", "need": "no target row"})
            self.assertGreaterEqual(len(ids), 3)
            for arc, picks in told:
                composed, facts, bodies, page_html = self._page(req, names, picks)
                self.assertEqual(composed["arc"]["id"], arc, picks)
                self.assertEqual(composed["arc"]["picks"][0], picks[0])
                self._once(page_html)
                self.assertNotIn("goal", composed["facts"])
                said = json.dumps({k: composed[k] for k in ("title", "dek", "end", "sections", "leaves")}, ensure_ascii=False)
                self.assertNotIn("目标", said)
                self.assertNotIn("目标", re.sub(r"<[^>]+>", "", page_html))
                for k in ("title", "dek", "end"):
                    self.assertTrue(composed[k].strip(), k)
                    self.assertNotRegex(composed[k], r"\{\s*\}", k)
                end = re.sub(r"<[^>]+>", "", re.search(r"<p class=end>(.*?)</p>", page_html, re.S)[1]).strip()
                self.assertEqual(end, FN.WD.WORDS["story.end.happened_plain" if arc == "happened" else "story.end.lagging"])
                big = [i["fact"] for i in composed["leaves"]["bignums"]["bignums"]]
                self.assertEqual(big, ["b_now", "m_step"] if arc == "happened" else ["b_hi", "b_lo", "b_ratio"])
                notes = composed["leaves"]["risk_notes"]["items"]
                self.assertTrue(notes and "情景" not in json.dumps(notes, ensure_ascii=False), notes)

    def test_the_ends_pair_draws_beside_the_rank_with_a_short_or_a_long_measure_name(self):
        """q4 11-23: the ends finding's row and both charts' heads are named by the measure's whole name; beside the rank (a pair,
        half the page wide) a World Bank indicator's reviewed name left the pair bars no track and the heads no room. The page now
        draws on both shapes: short names keep the rank and the ends paired; a name whose head runs past half the page takes
        each picture wider (story.plan), and the pair bars' row name stands over its tracks (pair_bars)."""
        long = "不含土地利用、土地利用变化和林业的人均二氧化碳排放量（吨二氧化碳当量／人）"
        eu, eu_names = eu_request()
        wb, wb_names = wb12_request()
        for req, names, paired in ((eu, eu_names, True), (wb, wb_names, True), ({**wb, "words": {**wb["words"], "measure": long}}, wb_names, False)):
            composed, facts, bodies, page_html = self._page(req, names, ["rank", "ends", "members"])
            self.assertEqual([s["layer"] for s in composed["sections"]][2:4], ["rankbar", "pair_bars"])
            self.assertEqual('data-layout="pair"' in page_html, paired)
            self.assertIn("pair_bars", bodies)

    def test_the_arc_takes_the_finding_it_needs_or_says_none_stands(self):
        req, names = self._arc_request()
        req["points"] = self._points(EU_MEMBERS)
        # a lead the arc cannot stand on alone: the best candidate of what it needs is added
        arc = lambda r, picks: FN.compose({**r, "picks": picks})["arc"]
        got = arc(req, ["chain", "spread"])
        self.assertEqual((got["id"], got["picks"][0], len(got["picks"])), ("happened", "chain", 3))
        self.assertTrue(set(got["picks"]) & {"path", "need"} and "added" in got["why"])
        got = arc(req, ["map", "ends"])
        self.assertEqual(got["id"], "lagging"); self.assertTrue(set(got["picks"]) & {"spread", "rank"})
        got = arc(req, ["path", "chain"])
        self.assertEqual(got["id"], "in_time"); self.assertEqual(got["picks"][0], "path"); self.assertEqual(len(got["picks"]), 3)
        # four picks: the last of the others makes room for it, the lead stays first
        got = arc(req, ["chain", "spread", "rank", "members"])
        self.assertEqual((got["picks"][0], len(got["picks"])), ("chain", 4))
        self.assertTrue(set(got["picks"]) & {"path", "need"})
        # a page that stands on its own keeps its picks, in the arc's order
        self.assertEqual(arc(req, ["path", "need", "spread"])["picks"], ["path", "need", "spread"])
        self.assertEqual(arc(req, ["rank", "spread"])["picks"], ["rank", "spread"])
        # a request with no target holds no path or need: the happened arc cannot be completed and says so, its picks kept
        notarget = {k: v for k, v in req.items() if k != "target"}
        got = arc(notarget, ["chain", "spread"])
        self.assertEqual((got["id"], got["picks"]), ("happened", ["chain", "spread"]))
        self.assertIn("holds none", got["why"])

    def test_the_arc_on_a_world_bank_shape_has_no_whole_and_leads_by_members(self):
        """The second shape: six economies, no whole and no target: only the lagging arc can stand; its header is the highest, the
        lowest and the ratio, its closing line words only."""
        req, names = wb_request()
        composed, facts, bodies, page_html = self._page(req, names, ["rank", "spread"])
        self.assertEqual(composed["arc"], {"id": "lagging", "picks": ["rank", "spread"], "why": None})
        self.assertEqual([i["fact"] for i in composed["leaves"]["bignums"]["bignums"]], ["b_hi", "b_lo", "b_ratio"])
        self._once(page_html)
        self.assertRegex(page_html, r"<p class=end>名次只说明这一年的位置")

    def _header_page(self, req, names, picks):
        """The composed page's header drawn by the real child: (composed, facts, the bignums html, the whole page's html)."""
        composed, facts, bodies, page_html = self._page(req, names, picks)
        big = bodies["bignums"]
        last = {"html": page_html}
        # every digit of the header sits in a marked ledger run, each item's number in a data-src mark of its own fact
        bare = re.sub(r"<[^>]+>", "", re.sub(r"<(span|tspan)[^>]*data-src=[^>]*>[^<]*</\1>", "", big))
        self.assertFalse(re.search(r"[0-9]", bare), bare)
        self.assertEqual(len(re.findall(r'class="bn"', big)), 3)
        self.assertIn('style="width:1140px;grid-template-columns:repeat(3,1fr)', big)  # the three numbers span the page
        self.assertIn("font-size:58px", big)  # the page title's size
        self.assertIn('class="bns"', last["html"])
        self.assertLess(last["html"].index('data-id="bignums"'), last["html"].index('data-id="thesis"'))
        return composed, facts, big, last["html"]

    def test_header_with_a_target_is_now_gap_and_the_fastest_pace_at_the_target_year(self):
        req, names = eu_request()
        composed, facts, big, _ = self._header_page(req, names, ["path", "need"])
        items = composed["leaves"]["bignums"]["bignums"]
        self.assertEqual([i["fact"] for i in items], ["b_now", "b_gap", "b_end"])
        self.assertEqual(composed["sections"][0], {"id": "bignums", "layer": "bignums"})
        self.assertAlmostEqual(facts["b_now"]["v"], 24.6); self.assertEqual(facts["b_now"]["t"], "2024")
        self.assertAlmostEqual(facts["b_gap"]["v"], 42.5 - 24.6, places=6)
        self.assertAlmostEqual(facts["b_end"]["v"], 24.6 + facts["b_best"]["v"] * (2030 - 2024), places=6)  # the best year's pace carried on
        for k in ("b_now", "b_gap", "b_end"): self.assertIn(f'data-src="fact:{k}', big)

    def test_header_of_a_whole_with_no_target_is_now_change_and_member_ratio(self):
        req, names = eu_request()
        req = {k: v for k, v in req.items() if k != "target"}
        # no arc given (the header asked alone): the whole's value, its change and the members' ratio
        facts_, items = FN.header(FN.Req(req))
        self.assertEqual([i["fact"] for i in items], ["b_now", "b_change", "b_ratio"])
        self.assertEqual(items[1]["label"]["word"], "story.big.rose")
        self.assertEqual(items[2]["label"]["name"], "SE")  # the highest member
        # the lagging arc's header (the page led by a spread finding): the highest member, the lowest and their ratio, whole or none
        composed, facts, big, _ = self._header_page(req, names, ["spread", "ends"])
        items = composed["leaves"]["bignums"]["bignums"]
        self.assertEqual([i["fact"] for i in items], ["b_hi", "b_lo", "b_ratio"])
        self.assertAlmostEqual(facts["b_ratio"]["v"], facts["b_hi"]["v"] / facts["b_lo"]["v"], places=6)
        self.assertEqual((items[0]["label"]["name"], items[1]["label"]["name"]), ("SE", "LU"))

    def test_header_of_six_economies_with_no_whole_is_highest_lowest_and_their_ratio(self):
        req, names = wb_request()
        composed, facts, big, _ = self._header_page(req, names, ["spread", "ends"])
        items = composed["leaves"]["bignums"]["bignums"]
        self.assertEqual([(i["fact"], i["label"].get("name")) for i in items], [("b_hi", "USA"), ("b_lo", "IND"), ("b_ratio", "USA")])
        self.assertAlmostEqual(facts["b_hi"]["v"], 13.4); self.assertAlmostEqual(facts["b_lo"]["v"], 2.12)
        self.assertNotIn("goal", facts)

    def test_header_falls_back_to_a_fall_and_is_left_out_with_under_two_numbers(self):
        req, names = eu_request()
        req = {k: v for k, v in req.items() if k != "target"}
        down = [dict(r, value=round(60 - r["value"], 3)) if r["dims"].get("geo") == "EU27_2020" else r for r in req["rows"]]
        self.assertEqual(FN.header(FN.Req({**req, "rows": down}))[1][1]["label"]["word"], "story.big.fell")
        one = {**req, "rows": [r for r in req["rows"] if r["dims"].get("geo") == "SE"], "main": {**req["main"], "whole": None, "members": ["SE"]}}
        self.assertIsNone(FN.header(FN.Req({**one, "picks": []})))

    # ---------------------------------------------------------------- the members angle: one small chart a member

    def _members_page(self, req, names, picks):
        """The page with the members section drawn by the real child; every digit of the grid in a marked ledger run."""
        composed, facts, bodies, page_html = self._page(req, names, picks)
        svg = bodies["small_multiples"]
        bare = re.sub(r"<[^>]+>", "", re.sub(r"<(span|tspan)[^>]*data-src=[^>]*>[^<]*</\1>", "", svg))
        self.assertFalse(re.search(r"[0-9]", bare), bare)
        self.assertIn('data-module-id="members"', page_html)
        self.assertRegex(page_html, r'<svg[^>]*pub-chart[^>]*aria-describedby="desc-members"')
        return composed, facts, svg, page_html

    def test_members_eu_nine_cells_with_the_whole_and_the_target(self):
        req, names = eu_request()
        composed, facts, svg, page_html = self._members_page(req, names, ["path", "members"])
        data = composed["leaves"]["small_multiples"]
        self.assertEqual(sorted(c["code"] for c in data["cells"]), sorted(EU_MEMBERS))
        self.assertEqual(data["accent"], ["SE", "MT"])  # the biggest rise and the one that fell
        self.assertEqual(data["ref"]["code"], "EU27_2020"); self.assertEqual(data["target"]["text"], "fact:goal")
        self.assertEqual(len(re.findall(r"<polyline [^>]*data-code=", svg)), 9)
        self.assertEqual(len(re.findall(r'data-part="ref"', svg)), 9)
        self.assertEqual(len(re.findall(r'data-part="target"', svg)), 9)
        # the title: the best member's rise and the worst's fall, each the larger value less the smaller (above 0)
        title = next(x for x in composed["sections"] if x["id"] == "members")["title"]
        self.assertIn("{dhi}", title); self.assertIn("{dlo}", title); self.assertIn("却降了", title)
        se = EU_MEMBERS["SE"]; mt = EU_MEMBERS["MT"]
        self.assertAlmostEqual(facts["dhi"]["v"], facts["sm_se"]["v"] - facts["sm0_se"]["v"], places=6)
        self.assertAlmostEqual(facts["dlo"]["v"], facts["sm0_mt"]["v"] - facts["sm_mt"]["v"], places=6)
        self.assertGreater(facts["dhi"]["v"], 0); self.assertGreater(facts["dlo"]["v"], 0)
        # the members' last values are facts, drawn by the cells
        for c in EU_MEMBERS: self.assertIn(f'data-src="fact:sm_{c.lower()}"', svg)

    def test_members_wb_six_economies_no_whole_no_target(self):
        req, names = wb_request()
        composed, facts, svg, _ = self._members_page(req, names, ["members", "spread"])
        data = composed["leaves"]["small_multiples"]
        self.assertEqual(len(data["cells"]), 6)
        self.assertNotIn("ref", data); self.assertNotIn("target", data)
        self.assertEqual(data["accent"], ["CHN", "USA"])
        self.assertNotIn("data-part=\"ref\"", svg); self.assertNotIn("data-part=\"target\"", svg)
        self.assertNotIn("goal", facts)

    def test_members_title_words_follow_the_signs(self):
        req, names = eu_request()
        up = [dict(r, value=round(r["value"] + 0.4 * (int(r["time"]) - 2005), 3)) if r["dims"].get("geo") in ("MT", "LU") else r for r in req["rows"]]
        composed = FN.compose({**req, "rows": up, "picks": ["path", "members"]})
        self.assertIn("只涨了", next(x for x in composed["sections"] if x["id"] == "members")["title"])
        down = [dict(r, value=round(r["value"] - 1.0 * (int(r["time"]) - 2005), 3)) if r["dims"].get("geo") != "EU27_2020" else r for r in req["rows"]]
        composed = FN.compose({**req, "rows": down, "picks": ["path", "members"]})
        self.assertIn("只降了", next(x for x in composed["sections"] if x["id"] == "members")["title"])

    def test_members_needs_six_members_and_five_years_and_a_difference(self):
        req, _ = wb_request()
        why = lambda r: {d["angle"]: d["why"] for d in FN.candidates(r)[2]}.get("members")
        few = {**req, "rows": [r for r in req["rows"] if r["dims"]["country"] in ("USA", "DEU", "CHN", "IND", "BRA")], "main": {**req["main"], "members": None}}
        self.assertEqual(why(few), "fewer than 6 members")
        short = {**req, "rows": [r for r in req["rows"] if int(r["time"]) >= 2019]}
        self.assertEqual(why(short), "the members share fewer than 5 years in a row")
        same = {**req, "rows": [dict(r, value=f"{5 + 0.1 * (int(r['time']) - 2010):.2f}") for r in req["rows"]]}
        self.assertEqual(why(same), "every member changed alike")

    def test_members_more_than_twelve_keep_the_highest_and_the_lowest_at_the_last_year(self):
        req, names = eu_request()
        t = req["main"]["table"]
        rows = list(req["rows"]); members = list(req["main"]["members"])
        for i in range(8):
            c = f"X{i}"; members.append(c)
            rows += [row(t, {"nrg_bal": "REN"}, "geo", c, y, 3.0 + 3.0 * i + 0.05 * i * (y - 2005)) for y in range(2005, 2025)]
        big = {**req, "rows": rows, "main": {**req["main"], "members": members}}
        composed = FN.compose({**big, "picks": ["path", "members"]})
        cells = [c["code"] for c in composed["leaves"]["small_multiples"]["cells"]]
        self.assertEqual(len(cells), 12)
        last = {c: next(r["value"] for r in rows if r["dims"].get("geo") == c and r["time"] == "2024") for c in members}
        order = sorted(members, key=lambda c: (-last[c], c))
        self.assertEqual(sorted(cells), sorted(order[:6] + order[-6:]))

    # ---------------------------------------------------------------- the map angle and the page's layout

    def _points(self, codes, eu=True):
        import test_leaves_member_map as MM
        return {c: list(geo.PT[c]) for c in codes} if eu else MM.attribute_points(codes)

    def _wb8(self):
        req, names = wb_request()
        rows = list(req["rows"])
        for c, (a, p_) in {"JPN": (9.0, -0.1), "AUS": (16.0, -0.2)}.items():
            rows += [{**row(req["main"]["table"], {}, "country", c, y, a + p_ * (y - 2010)), "value": f"{a + p_ * (y - 2010):.2f}"} for y in range(2010, 2023)]
        names = {**names, "JPN": "日本", "AUS": "澳大利亚"}
        return {**req, "rows": rows, "points": self._points(list(names), eu=False)}, names

    def test_map_eu_nine_members_filled_and_called_out(self):
        req, names = eu_request()
        req = {**req, "points": self._points(EU_MEMBERS)}
        _, cands, dropped = FN.candidates(req)
        mp = next(c for c in cands if c["id"] == "map")
        self.assertEqual(mp["layer"], "member_map"); self.assertEqual(mp["why"]["higher"], "east")  # the higher shares lie east in this shape: SE, FI, PL
        composed, facts, bodies, page_html = self._page(req, names, ["path", "map"])
        svg = bodies["member_map"]
        self.assertEqual(len(re.findall(r'<path [^>]*data-step=', svg)), 9)
        self.assertEqual(len(re.findall(r'data-part="leader"', svg)), 6)
        title = next(x for x in composed["sections"] if x["id"] == "map")["title"]
        self.assertIn("东边的偏高", title); self.assertIn("{mp_se}", title)
        self.assertEqual(len([k for k in composed["facts"] if k.startswith("mp_")]), 6)  # the highest and the lowest three
        bare = re.sub(r"<[^>]+>", "", re.sub(r"<(span|tspan)[^>]*data-src=[^>]*>[^<]*</\1>", "", svg))
        self.assertFalse(re.search(r"[0-9]", bare), bare)
        self.assertIn('data-module-id="map"', page_html)

    def test_map_eight_economies_on_the_world(self):
        req, names = self._wb8()
        mp = next(c for c in FN.candidates(req)[1] if c["id"] == "map")
        composed, facts, bodies, page_html = self._page(req, names, ["map", "spread"])
        svg = bodies["member_map"]
        self.assertEqual(len(re.findall(r'<path [^>]*data-step=', svg)), 8)
        self.assertEqual(len(composed["leaves"]["member_map"]["cells"]), 8)
        for key in ("mp_usa", "mp_ind"): self.assertIn(key, composed["facts"])
        self.assertIn("map", [x["id"] for x in composed["sections"]]); self.assertGreater(mp["score"], 0)

    def test_map_needs_points_for_eight_members_and_a_difference(self):
        req, _ = eu_request()
        why = lambda r: {d["angle"]: d["why"] for d in FN.candidates(r)[2]}.get("map")
        self.assertEqual(why(req), "the request gives no points for the members")
        seven = {c: list(geo.PT[c]) for c in list(EU_MEMBERS)[:7]}
        self.assertEqual(why({**req, "points": seven}), "fewer than 8 members with a point")
        flat = {**req, "points": self._points(EU_MEMBERS), "rows": [dict(r, value=5.0) if r["dims"].get("geo") in EU_MEMBERS else r for r in req["rows"]]}
        self.assertEqual(why(flat), "every member holds the same value")

    def test_map_title_says_which_side_is_higher(self):
        req, _ = eu_request()
        pts = self._points(EU_MEMBERS)
        east = {c: 10.0 + 2 * pts[c][0] for c in EU_MEMBERS}  # the value follows the longitude
        rows = [dict(r, value=round(east[r["dims"]["geo"]], 3)) if r["dims"].get("geo") in EU_MEMBERS else r for r in req["rows"]]
        composed = FN.compose({**req, "rows": rows, "points": pts, "picks": ["path", "map"]})
        self.assertIn("东边的偏高", next(x for x in composed["sections"] if x["id"] == "map")["title"])
        west = {c: 10.0 - 2 * pts[c][0] for c in EU_MEMBERS}
        rows = [dict(r, value=round(west[r["dims"]["geo"]], 3)) if r["dims"].get("geo") in EU_MEMBERS else r for r in req["rows"]]
        composed = FN.compose({**req, "rows": rows, "points": pts, "picks": ["path", "map"]})
        self.assertIn("西边的偏高", next(x for x in composed["sections"] if x["id"] == "map")["title"])

    def test_layout_side_stack_pair_and_the_knobs(self):
        import re as _re
        lay_of = lambda html: dict(_re.findall(r'data-id="([a-z_]+)" data-layout="([a-z]+)"', html))
        widths = lambda html: {m.group(1): int(m.group(2)) for m in _re.finditer(r'data-module-id="([a-z_]+)" data-layer="[a-z_]+"(?: style="[^"]*")?><svg[^>]*width="(\d+)"', html)}
        req, names = eu_chain_request()
        req["chain"] = [req["chain"][0], req["chain"][2]]
        _, _, _, page_html = self._page(req, names, ["path", "chain", "members", "spread"])
        lay = dict(_re.findall(r'data-id="([a-z_]+)" data-layout="([a-z]+)"', page_html))
        self.assertEqual(lay, {"bignums": "bare", "thesis": "bare", "legend": "bare", "path": "side", "chain": "stack", "members": "side", "spread": "side", "notes": "bare"})
        self.assertEqual(widths(page_html), {"path": 716, "chain": 1140, "members": 716, "spread": 716})  # 1140 - 36 - 388
        self.assertIn('style="--tw:388px;--gut:36px;height:', page_html)
        # two paired pictures share a row, half the page less half the gutter each
        wreq, wnames = wb_request()
        picks = ["spread", "rank", "ends", "members"]  # the lagging arc's order: the rank and the ends come one after the other
        _, _, _, page_html = self._page(wreq, wnames, picks)
        pair = {m[0]: (float(m[1]), float(m[2]), float(m[3])) for m in _re.findall(r'data-id="(ends|rank)" data-layout="pair" style="left:([\d.]+)px;top:([\d.]+)px;width:([\d.]+)px', page_html)}
        self.assertEqual(sorted(pair), ["ends", "rank"]); self.assertEqual(pair["rank"][0], 0); self.assertEqual(pair["ends"][0], 552 + 36)  # one row: the same top, the second a half and a gutter along
        self.assertEqual(pair["ends"][1], pair["rank"][1])
        self.assertEqual({k: v for k, v in widths(page_html).items() if k in ("ends", "rank")}, {"ends": 552, "rank": 552})
        # the knobs: stack puts every picture across the page, pair off keeps the two apart, a share moves the words' column
        _, _, _, stacked = self._page(wreq, wnames, picks, style={"story_layout": {"layout": "stack"}})
        self.assertEqual(set(_re.findall(r'data-id="[a-z_]+" data-layout="([a-z]+)"', stacked)), {"bare", "stack"})
        self.assertEqual(set(widths(stacked).values()), {1140})
        _, _, _, apart = self._page(wreq, wnames, picks, style={"story_layout": {"pair": "off", "text_share": 0.4}})
        self.assertEqual(lay_of(apart)["ends"], "side")
        self.assertEqual(widths(apart)["ends"], 1140 - round(1140 * 0.4) - 36)  # pair off: the ends go beside their words
        self.assertIn("--tw:456px", apart)
        self.assertEqual(lay_of(apart)["spread"], "stack")  # the winners and losers need 680 px: beside a wider words' column they go across the page

    # ---------------------------------------------------------------- the short notes and the legend

    def test_notes_are_the_sections_own_facts_two_a_chart_by_default(self):
        import re as _re
        req, names = eu_chain_request()
        req["chain"] = [req["chain"][0], req["chain"][2]]
        req["points"] = self._points(EU_MEMBERS)
        picks = ["path", "chain", "map", "members"]
        composed, facts, bodies, page_html = self._page(req, names, picks)
        sect = lambda sid: _re.search(rf'<section class="sec" data-id="{sid}" .*?</section>', page_html, _re.S).group(0)
        for sid in ("path", "chain", "map", "members"):
            notes = _re.findall(r'<li class="note"><b class="n"><span data-src="(fact:[a-z0-9_]+)">', sect(sid))
            self.assertEqual(len(notes), 2, sid)  # the knob's default
            data = composed["leaves"][{"path": "target_path", "chain": "event_chain", "map": "member_map", "members": "small_multiples"}[sid]]
            self.assertEqual(notes, [n["num"] for n in data["notes"][:2]], sid)
            for n in data["notes"]: self.assertIn(n["num"][5:], composed["facts"], (sid, n))  # a fact the page declares (the section's angle's)
        bare = _re.sub(r"<[^>]+>", "", _re.sub(r"<(span|tspan)[^>]*data-src=[^>]*>[^<]*</\1>", "", "".join(_re.findall(r'<ul class="notes".*?</ul>', page_html, _re.S))))
        self.assertFalse(_re.search(r"[0-9]", bare), bare)
        # the knobs: none, one, three (no section has a third that adds a number), the leader and the size
        _, _, _, none = self._page(req, names, picks, style={"story_layout": {"notes": 0}})
        self.assertNotIn('class="notes"', none)
        _, _, _, one = self._page(req, names, picks, style={"story_layout": {"notes": 1}})
        self.assertEqual(len(_re.findall(r'<li class="note">', one)), 4)
        _, _, _, three = self._page(req, names, picks, style={"story_layout": {"notes": 3, "lead": 48, "note_size": 16}})
        self.assertEqual(len(_re.findall(r'<li class="note">', three)), 2 + 2 + 2 + 2)  # each angle writes two notes
        self.assertIn("--lead:48px;--ns:16px", three)
        self.assertGreater(len(_re.findall(r'<li class="note">', page_html)), len(_re.findall(r'<li class="note">', one)))

    def _srcs(self, segs):
        return {x["src"] for x in segs if isinstance(x, dict) and "src" in x}

    def test_every_note_prints_a_number_its_title_and_text_do_not(self):
        """The notes of every angle, on the EU and the World Bank shapes: a note adds a ledger number its section's title and text
        do not print, and says what it is in words of its own."""
        import re as _re
        base = lambda src: _re.sub(r"\.(n|r)$", "", src)
        req, names = eu_chain_request()
        req["chain"] = [req["chain"][0], req["chain"][2]]
        req["points"] = self._points(EU_MEMBERS)
        wreq, wnames = self._wb8()
        seen = set()
        for r, picks in ((req, ["path", "need", "rank", "ends"]), (req, ["chain", "map", "members", "spread"]),
                         (wreq, ["map", "ends", "rank", "spread"]), (wreq, ["members", "rank"])):
            composed = FN.compose({**r, "picks": picks})
            for sec in composed["sections"]:
                data = composed["leaves"][sec["layer"]]
                if not sec.get("title"): continue
                printed = {base(x) for x in self._srcs(sec["title"]) | self._srcs(sec.get("text") or [])}
                for n in data.get("notes", []):
                    mine = {base(n["num"])} | {base(x) for x in self._srcs(n["text"])}
                    self.assertTrue(mine - printed, (sec["id"], n["num"], "says again what the title and the text print"))
                    self.assertIn(n["num"][5:], composed["facts"])
                    self.assertTrue(len(n["text"]) >= 1 and any("w" in x or "word" in x for x in n["text"]), (sec["id"], n["num"], "says nothing of what it is"))
                    seen.add(sec["id"])
        self.assertEqual(seen, {"path", "need", "rank", "ends", "chain", "map", "members", "spread"})

    def test_a_note_that_only_says_again_is_refused_by_the_page(self):
        req, names = eu_chain_request()
        def again(composed):  # the old rank note: the position the title already prints
            sec = next(x for x in composed["sections"] if x["id"] == "rank")
            data = composed["leaves"]["rankbar"]
            data["notes"] = [{"num": "fact:pos", "text": FN.ST("story.note.rank.hi", hi="SE", w="EU27_2020", rw="r_eu27_2020")}] + data["notes"]
        bad = self._page(req, names, ["path", "rank"], edit=again, refused=True)
        self.assertTrue(bad, "the page took a note that only says again")
        self.assertIn("already prints", str(bad[0])); self.assertIn("rankbar's note 1", str(bad[0]))
        # the notes the angles write now are no such note
        self.assertEqual(self._page(req, names, ["path", "rank"], refused=True), [])

    def _many(self, n, wb=False):
        """The EU shape with n members (the whole among them), or the world shape with n economies."""
        import random
        r = random.Random(5)
        old = (globals()["EU_MEMBERS"], globals()["EU_NAMES"], globals()["WB"], globals()["WB_NAMES"])
        try:
            if wb:
                globals()["WB"] = {f"W{i:02d}": (r.uniform(3, 18), r.uniform(-0.15, 0.2)) for i in range(n)}
                globals()["WB_NAMES"] = {c: f"经济{chr(0x4e00 + i)}" for i, c in enumerate(globals()["WB"])}
                return wb_request()
            globals()["EU_MEMBERS"] = {f"X{i:02d}": (r.uniform(8, 55), r.uniform(-0.1, 0.9)) for i in range(n)}
            globals()["EU_NAMES"] = {"EU27_2020": "欧盟", **{c: f"成员{chr(0x4e00 + i)}" for i, c in enumerate(globals()["EU_MEMBERS"])}}
            return eu_request()
        finally:
            globals()["EU_MEMBERS"], globals()["EU_NAMES"], globals()["WB"], globals()["WB_NAMES"] = old

    def test_a_long_rank_folds_on_the_page_and_a_short_one_does_not(self):
        import re as _re
        omit = "中间的成员未画出"
        rects = lambda html: len(_re.findall(r'<rect [^>]*fill="var\(--(?:accent|t-sec)\)"', _re.search(r'<svg class="rankbar.*?</svg>', html, _re.S).group(0)))
        def expect(req, composed):  # the rows a fold keeps and the lines between them, worked out from the rank's data
            d = composed["leaves"]["rankbar"]; val = {r["src"]: r["value"] for r in req["rows"]}
            order = sorted(d["rows"], key=lambda r: -float(val[r["value"]]))
            keep = [i for i, r in enumerate(order) if i < 10 or i >= len(order) - 5 or r["code"] == d["highlight"]]
            return len(keep), sum(1 for a, b in zip(keep, keep[1:]) if b != a + 1)
        for tag, n, wb in (("EU 26", 26, False), ("world 24", 24, True)):
            req, names = self._many(n, wb)
            composed, _, bodies, page_html = self._page(req, names, ["ends", "rank"] if wb else ["path", "rank"])
            self.assertEqual(len(composed["leaves"]["rankbar"]["rows"]), n + (0 if wb else 1), tag)  # the data keeps every member
            kept, lines = expect(req, composed)
            self.assertEqual((rects(page_html), page_html.count(omit)), (kept, lines), tag)
            self.assertTrue(kept in (15, 16) and lines >= 1, (tag, kept, lines))  # 10 + the highlighted row (unless one of the ten or the five) + 5
        req, names = self._many(19)  # 19 members and the whole: 20 rows, at most fold_over: every row stays
        _, _, _, page_html = self._page(req, names, ["path", "rank"])
        self.assertEqual((rects(page_html), page_html.count(omit)), (20, 0))
        req, names = self._many(20)  # 21 rows: folds
        composed, _, _, page_html = self._page(req, names, ["path", "rank"])
        self.assertEqual((rects(page_html), page_html.count(omit)), expect(req, composed))
        req, names = eu_request()  # the nine members of the shape: no fold
        _, _, _, page_html = self._page(req, names, ["path", "rank"])
        self.assertEqual((rects(page_html), page_html.count(omit)), (10, 0))

    def test_the_legend_follows_the_pictures_on_the_page(self):
        import re as _re
        req, names = eu_chain_request()
        req["chain"] = [req["chain"][0], req["chain"][2]]
        req["points"] = self._points(EU_MEMBERS)
        _, _, _, page_html = self._page(req, names, ["path", "chain", "map", "members"])
        leg = _re.search(r'<div class="legend"[^>]*>.*?</div></section>', page_html, _re.S).group(0)
        self.assertEqual(_re.findall(r'<span class="sw ([a-z]+)">', leg), ["accent", "dash", "pale", "ramp", "band"])  # in the pictures' order (the in-time arc's: path, members, map, chain)
        self.assertLess(page_html.index('data-id="thesis"'), page_html.index('data-id="legend"')); self.assertLess(page_html.index('data-id="legend"'), page_html.index('data-id="path"'))
        self.assertFalse(_re.search(r"[0-9]", _re.sub(r"<[^>]+>", "", leg)))
        _, _, _, off = self._page(req, names, ["path", "chain", "map", "members"], style={"story_layout": {"legend": "off"}})
        self.assertNotIn('data-id="legend"', off)

    def test_words_with_no_ledger_entry_are_html_over_the_picture(self):
        import re as _re
        req, names = eu_chain_request()
        req["chain"] = [req["chain"][0], req["chain"][2]]
        req["points"] = self._points(EU_MEMBERS)
        composed, _, bodies, page_html = self._page(req, names, ["path", "chain", "map", "members"])
        # one overlay in each picture that has such words and one over the text blocks, each span placed in the picture's pixels
        self.assertEqual(len(_re.findall(r'<div class="ov" style="width:\d+px;height:\d+px">', page_html)), 6)  # four charts, the thesis, the notes
        spans = _re.findall(r'<span style="left:[\d.]+px;top:[-\d.]+px;font-size:[\d.]+px;[^>]*>([^<]*)</span>', page_html)
        self.assertIn("可再生能源占比", spans); self.assertIn("随后", spans); self.assertIn("怎么读这一页", spans)
        self.assertFalse([x for x in spans if _re.search(r"[0-9]", x)], "a digit in a word over a picture")
        for n, body in bodies.items():  # none of those words is left in an svg
            if n != "bignums": self.assertNotIn(">随后<", body)
        self.assertIsNone(K.OVERLAY)  # the diversion is the story leaves' own: outside a story leaf's draw every text is a <text>

    def test_the_overlay_words_are_told_to_layer_1_as_the_page_lays_them(self):
        """Each story svg layer's reply holds `words`: the very lines the page puts over the picture (same place, size, text), none with a
        digit, in the texts' own terms; a layer that draws none says none."""
        import re as _re
        req, names = eu_chain_request()
        req["chain"] = [req["chain"][0], req["chain"][2]]
        req["points"] = self._points(EU_MEMBERS)
        composed, _, bodies, page_html = self._page(req, names, ["path", "chain", "map", "members"])
        told = [w for ws in self.words.values() for w in ws]
        self.assertGreater(len(told), 10)
        self.assertTrue(set(self.words) >= {"event_chain", "target_path"}, set(self.words))
        for w in told:
            self.assertEqual(set(w), {"text", "x", "y", "size", "anchor", "baseline", "rot"})
            self.assertFalse(_re.search(r"[0-9]", w["text"]), w)
            self.assertTrue(w["size"] > 0 and w["x"] >= 0 and w["y"] > 0, w)
        placed = _re.findall(r'<span style="left:([\d.]+)px;top:([-\d.]+)px;font-size:([\d.]+)px;[^>]*>([^<]*)</span>', page_html)
        # layer 1 is told the words at the page's coordinates (the layer's translate); the page puts them in the picture's own pixels
        at = {n: tuple(float(v) for v in _re.match(r'<g transform="translate\(([-\d.]+),([-\d.]+)\)">', bodies[n]).groups()) for n in self.words}
        as_page = lambda n, w: (f'{w["x"] - at[n][0]:.1f}', f'{w["y"] - at[n][1] - w["size"] * 0.88:.1f}', f'{w["size"]:g}', w["text"])
        self.assertEqual(sorted(as_page(n, w) for n, ws in self.words.items() for w in ws), sorted(placed))  # one to one with what the page puts over the pictures
        # the svgs themselves say no such word, and no <text> of theirs stands in for one
        for n, ws in self.words.items():
            left = {x["text"] for x in run.drawn(bodies[n])[0]}
            self.assertFalse(left & {w["text"] for w in ws}, n)

    def _layout_checked(self, page_html):
        """The size phase's layout, read back off the page and the replies: sections in disjoint boxes inside the page, each picture where its
        layer's translate puts it (the layer 1's coordinates), every text and word of every layer on the page and none over another."""
        import re as _re
        W, H = self.size["w"], self.size["h"]
        self.assertEqual(W, 1140); self.assertEqual(_re.search(r'class="story" style="[^"]*;height:([\d.]+)px', page_html)[1], f"{H:g}")
        boxes = {m[0]: tuple(float(v) for v in m[1:]) for m in _re.findall(r'<section class="sec" data-id="([a-z_]+)" data-layout="[a-z]+" style="left:([\d.]+)px;top:([\d.]+)px;width:([\d.]+)px;height:([\d.]+)px"', page_html)}
        self.assertGreaterEqual(len(boxes), 6)
        rect = lambda b: (b[0], b[1], b[0] + b[2], b[1] + b[3])
        hit = lambda a, b: a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]
        ids = sorted(boxes)
        for i, a in enumerate(ids):
            self.assertTrue(rect(boxes[a])[2] <= W + 0.01 and rect(boxes[a])[3] <= H + 0.01, (a, boxes[a], W, H))
            for b in ids[i + 1:]: self.assertFalse(hit(rect(boxes[a]), rect(boxes[b])), (a, b, boxes[a], boxes[b]))
        placed = 0
        for chunk in page_html.split('<section class="sec" data-id="')[1:]:
            sid = chunk[:chunk.index('"')]
            m = _re.search(r'data-layer="([a-z_]+)" style="left:([\d.]+)px;top:([\d.]+)px"><svg[^>]*width="([\d.]+)" height="([\d.]+)"', chunk)
            if not m: continue
            layer, fx, fy, w, h = m[1], float(m[2]), float(m[3]), float(m[4]), float(m[5])
            x0, y0 = boxes[sid][0] + fx, boxes[sid][1] + fy
            t = _re.match(r'<g transform="translate\(([-\d.]+),([-\d.]+)\)">', self.replies[layer]["svg"])
            self.assertEqual((float(t[1]), float(t[2])), (round(x0, 1), round(y0, 1)), layer)  # the layer reports where the page puts its picture
            self.assertTrue(fx + w <= boxes[sid][2] + 0.01 and fy + h <= boxes[sid][3] + 0.01, (sid, fx, fy, w, h, boxes[sid]))  # the picture is inside its box
            placed += 1
        self.assertGreaterEqual(placed, 4)
        for n, g in self.replies.items():  # the page holds each drawn svg byte for byte, once (the page check's rule), and draws nothing of its own in its svgs
            if g.get("svg"): self.assertEqual(page_html.count(g["svg"]), 1, n)
        for svg in _re.findall(r'<svg class="[a-z_]+[ "].*?</svg>', page_html, _re.S):
            rest = svg
            for g in self.replies.values():
                if g.get("svg"): rest = rest.replace(g["svg"], "")
            self.assertNotRegex(_re.sub(r"^<svg[^>]*>", "", rest), r"<(text|line|path|rect|circle)\b")
        for a in _re.findall(r'<svg\b[^>]*role="img"[^>]*>', page_html):  # every picture is named and described (the completion gate's text check)
            self.assertRegex(a, r'aria-label="[^"]+"', a)
            sid = _re.search(r'aria-describedby="([^"]+)"', a)
            self.assertTrue(sid, a)
            desc = _re.search(r'<p id="%s" hidden>(.*?)</p>' % _re.escape(sid[1]), page_html, _re.S)
            self.assertTrue(desc and desc[1].split("<", 1)[0].strip(), a)  # as the completion gate reads it: the words before the first tag
        # every text and word of every layer lies on the page and over no other: layer 1's rules, over the page
        items = []
        for n, g in self.replies.items():
            for t in (g.get("texts") or []) + (g.get("words") or []):
                sz = t["size"]; tw_ = K.tw(t["text"], sz); x = t["x"] - (tw_ if t["anchor"] == "end" else tw_ / 2 if t["anchor"] == "middle" else 0)
                items.append((n, t["text"], (x, t["y"] - sz * 0.8, x + tw_, t["y"] + sz * 0.25)))
        self.assertGreater(len(items), 40)
        for n, tx, b in items: self.assertTrue(-1 <= b[0] and b[2] <= W + 1 and -1 <= b[1] and b[3] <= H + 1, (n, tx, b))
        for i, (n1, t1, b1) in enumerate(items):
            for n2, t2, b2 in items[i + 1:]:
                if n1 != n2: self.assertFalse(hit(b1, b2), f"{n1} {t1!r} over {n2} {t2!r}")

    def test_the_layout_is_the_page_each_layer_reports_in_its_place(self):
        """Two data shapes: the EU chain page (side, stack, bare) and the world page (a pair row)."""
        req, names = eu_chain_request()
        req["chain"] = [req["chain"][0], req["chain"][2]]
        req["points"] = self._points(EU_MEMBERS)
        _, _, _, page_html = self._page(req, names, ["path", "chain", "map", "members"])
        self._layout_checked(page_html)
        wreq, wnames = self._wb8()
        _, _, _, page_html = self._page(wreq, wnames, ["map", "ends", "rank", "spread"])
        self.assertIn('data-layout="pair"', page_html)
        self._layout_checked(page_html)

    def test_rank_needs_five_members(self):
        req, _ = wb_request()
        few = {**req, "rows": [r for r in req["rows"] if r["dims"]["country"] in ("USA", "DEU", "CHN", "IND")], "main": {**req["main"], "members": None}}
        self.assertEqual({d["angle"]: d["why"] for d in FN.candidates(few)[2]}["rank"], "fewer than 5 members")

    def test_rank_page_draws_the_whole_in_the_accent(self):
        """Through the real child: the rank bar's accent row is the one its data names (story.rank_style)."""
        import json, subprocess
        req, names = eu_request()
        composed = FN.compose({**req, "picks": ["rank", "path"]})
        rows, facts = ledger(req, composed, names)
        spec = {"title": composed["title"], "kicker": "k", "dek": composed["dek"], "end": composed["end"], "source": "s", "refs": [], "facts": composed["facts"], "sections": composed["sections"],
                "tables": {t: {"id": t} for t in sorted({r["table"] for r in req["rows"]})}, "fmts": {**FMT_DEFS, "n": {"scale": 1, "dec": 0, "suffix": ""}, "time": {}},
                "hero": {"data": {}, "leaves": composed["leaves"]}}
        line = lambda **kv: json.dumps({"node": "page_story", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows,
                                        "knobs": {"spec": spec, "labels": names}, **kv}, ensure_ascii=False)
        layers = [x["layer"] for x in composed["sections"]]
        lines = [line(phase="size")] + [line(layer=n) for n in layers]
        go = lambda ls: [json.loads(x) for x in subprocess.run([sys.executable, "-I", "-B", run.__file__], input="\n".join(ls) + "\n",
                                                               capture_output=True, text=True, timeout=120, check=True).stdout.splitlines()]
        got = go(lines)
        self.assertFalse([g for g in got if "refused" in g or "error" in g], got)
        rank = got[1 + layers.index("rankbar")]["svg"]
        accents = re.findall(r'<rect [^>]*fill="var\(--accent\)"', rank)
        self.assertEqual(len(accents), 1)  # one accent bar: the whole's; the others grey
        last = go(lines + [json.dumps({"phase": "page", "layers": {n: g.get("svg") or g.get("html") for n, g in zip(layers, got[1:])}, "sizes": {}}, ensure_ascii=False)])[-1]
        self.assertIn("html", last, last)

    def test_refusals(self):
        req, _ = eu_request()
        for picks, why in ((["path", "nope"], "not a candidate"), (["path", "path"], "picked twice"), (["path"], "two to four")):
            with self.assertRaisesRegex(FN.Refused, why):
                FN.compose({**req, "picks": picks})
        with self.assertRaisesRegex(FN.Refused, "no times format"):
            FN.candidates({**req, "fmts": {"value": "x", "year": "yr"}})
        with self.assertRaisesRegex(FN.Refused, "digit"):
            FN.candidates({**req, "words": {"measure": "前20国", "unit": "%"}})

    def test_child_protocol(self):
        """A line in, a line out, as next_leaf's child protocol asks: two requests, two replies, a bad line refused."""
        import json, subprocess
        req, _ = eu_request()
        lines = json.dumps(req) + "\nnot json\n" + json.dumps({**req, "mode": "compose", "picks": ["path", "need"]}) + "\n"
        got = subprocess.run([sys.executable, "-I", "-B", FN.__file__], input=lines, capture_output=True, text=True, timeout=60)
        out = [json.loads(x) for x in got.stdout.splitlines()]
        self.assertEqual(len(out), 3)
        self.assertEqual(sorted(c["id"] for c in out[0]["candidates"]), ["ends", "members", "movers", "need", "overtake", "pace", "path", "rank", "spread"])
        self.assertIn("not JSON", out[1]["refused"][0])
        # the in-time arc needs a finding on who lags: the best of the members' comparisons is added (the spread, here)
        self.assertEqual([s["layer"] for s in out[2]["knobs"]["spec"]["sections"]], ["bignums", "thesis_claims", "target_path", "gap_axis", "winners_losers", "risk_notes"])
        self.assertEqual(sorted(out[2]["knobs"]["spec"]["hero"]["leaves"]), ["bignums", "gap_axis", "risk_notes", "target_path", "thesis_claims", "winners_losers"])
        # the child gives the spec's facts, sections, leaf data and headline words only: rows, formats and names are layer 1's
        self.assertEqual(list(out[2]), ["knobs"])
        self.assertEqual(list(out[2]["knobs"]), ["spec"])
        self.assertEqual(sorted(out[2]["knobs"]["spec"]), ["dek", "end", "facts", "hero", "sections", "title"])

    def test_differences_and_paces_take_the_delta_format(self):
        """A pace, a step or a gap of a share prints in its own format (points), a level or a projection in the value's."""
        req, _ = eu_request()
        defs = {**FMT_DEFS, "pp": {"scale": 1, "dec": 1, "suffix": " pp"}}
        page = FN.compose({**req, "fmts": {**FMTS, "delta": "pp"}, "fmt_defs": defs, "picks": ["path", "need", "spread"]})
        fmt = {k: q["fmt"] for k, q in page["facts"].items()}
        self.assertEqual({k for k, f in fmt.items() if f == "pp"} >= {"past", "recent", "best", "need", "gap_now", "lowg", "topg"}, True)
        self.assertEqual((fmt["now"], fmt["p_best"], fmt["goal"], fmt["need_x"]), ("x", "x", "x", "times"))
        # a year in a wording is {k.t} (it prints its own year word), in a segment the bare year then the table's year word
        self.assertNotIn("} 年", "".join(s.get("title", "") + s.get("text", "") for s in page["sections"]))
        self.assertIn({"word": "story.year"}, page["leaves"]["target_path"]["runs"][0]["label"])

    def test_ticks_as_next_facts(self):
        # next_facts ticks_step_in_the_printed_unit's cases: a top of 42.5 at one place steps by 10; 2 at no place by 1
        self.assertEqual(FN.ticks(42.5, {"dec": 1}), [10.0, 20.0, 30.0, 40.0])
        self.assertEqual(FN.ticks(2, {"dec": 0}), [1.0, 2.0])

    # ---------------------------------------------------------------- the three data-representation angles

    NEW = {"movers": "change_dots", "overtake": "rank_slope", "tiles": "tile_map"}

    def test_the_three_new_angles_stand_on_two_shapes_and_say_why(self):
        for name, mk in (("eu27", eu27_request), ("wb12", wb12_request)):
            req, _ = mk()
            _, cands, dropped = FN.candidates(req)
            by = {c["id"]: c for c in cands}
            for aid, layer in self.NEW.items():
                self.assertIn(aid, by, (name, aid, dropped))
                self.assertEqual(by[aid]["layer"], layer)
                self.assertTrue(0 < by[aid]["score"] <= 1, (name, aid))
                self.assertGreaterEqual(len(by[aid]["why"]), 3)
            self.assertEqual([c["score"] for c in cands], sorted((c["score"] for c in cands), reverse=True))
            self.assertLessEqual(len(cands), FN.TOP_K)
        # every angle names its own leaf: a page tells each at most once
        _, cands, _ = FN.candidates(eu27_request()[0])
        self.assertEqual(len({c["layer"] for c in cands}), len(cands))

    def test_movers_the_rows_the_accent_the_whole_and_the_notes(self):
        req, names = eu27_request()
        _, cands, _ = FN.candidates(req)
        mv = next(c for c in cands if c["id"] == "movers")
        ch = {c: b - a for c, (a, b) in ((c, (self._at(req, c, "2005"), self._at(req, c, "2024"))) for c in EU27)}
        big = max(ch, key=lambda c: (abs(ch[c]), c))
        self.assertEqual(mv["why"]["biggest"], big)
        data = mv["data"]
        self.assertEqual(data["accent"][0], big)
        self.assertEqual(data["ref"], "EU27_2020")
        codes = [r["code"] for r in data["rows"]]
        self.assertEqual(len(codes), FN.DOTS_MAX + 1)   # the 16 largest rises and falls, then the whole
        order = sorted(ch, key=lambda c: (-ch[c], c))
        self.assertEqual(codes[:-1], order[:8] + order[-8:])
        self.assertIn("omit", data)
        # nine members are all drawn and no line says some are left out
        small, _ = eu_request()
        s2 = next(c for c in FN.candidates(small)[1] if c["id"] == "movers")
        self.assertNotIn("omit", s2["data"]); self.assertEqual(len(s2["data"]["rows"]), 10)
        # the notes: the far end of the order and the whole's change, neither printed by the title
        self.assertEqual([n["num"] for n in mv["anns"]], ["fact:mv_do", "fact:mv_dw"])
        composed, facts, drawn = draw_all(self, req, names, ["movers", "tiles"])
        self.assertAlmostEqual(facts["mv_dw"]["v"], 24.6 - 10.2, places=2)
        self.assertGreater(facts["mv_do"]["v"], 0)
        # the rows keep the order of the change in the picture, the whole among them
        got = re.findall(r'<line [^>]*data-code="([A-Z0-9_]+)"', drawn["change_dots"])
        chw = {**ch, "EU27_2020": 24.6 - 10.2}
        self.assertEqual(got, sorted(got, key=lambda c: (-chw[c], c)))

    def _at(self, req, code, year):
        return next(float(r["value"]) for r in req["rows"] if r["dims"].get(req["main"]["by"]) == code and r["time"] == year and r["table"] == req["main"]["table"])

    def test_movers_without_a_whole_names_the_member_that_led_at_the_start(self):
        req, names = wb12_request()
        mv = next(c for c in FN.candidates(req)[1] if c["id"] == "movers")
        self.assertNotIn("ref", mv["data"])
        lead = max(WB12, key=lambda c: (self._at(req, c, "2010"), c))
        notes = [n["num"] for n in mv["anns"]]
        self.assertEqual(notes[0], "fact:mv_do")
        if lead not in mv["data"]["accent"]: self.assertEqual(notes, ["fact:mv_do", "fact:mv_dl"])
        composed, facts, drawn = draw_all(self, req, names, ["movers", "overtake"])
        self.assertTrue(all(v["v"] > 0 for k, v in facts.items() if k in ("mv_do", "mv_dl")))
        self.assertIn("降", FN.WD.WORDS["story.note.mv.down_most"])

    def test_movers_is_dropped_with_its_why(self):
        req, _ = eu27_request()
        why = lambda r: {d["angle"]: d["why"] for d in FN.candidates(r)[2]}.get("movers")
        few = {c: EU27[c] for c in list(EU27)[:5]}
        self.assertEqual(why(eu27_request(few)[0]), "fewer than 6 members")
        flat = {**req, "rows": [dict(r, value=5.0) if r["dims"].get("geo") in EU27 else r for r in req["rows"]]}
        self.assertIsNotNone(why(flat))
        still = eu27_request()[0]
        first = {r["dims"]["geo"]: r["value"] for r in still["rows"] if r["time"] == "2005" and r["table"] == "nrg_ind_ren"}
        still["rows"] = [dict(r, value=first[r["dims"]["geo"]]) if r["time"] == "2024" and r["table"] == "nrg_ind_ren" else r for r in still["rows"]]
        self.assertEqual(why(still), "no member moved")

    def test_overtake_ranks_are_the_tables_own_and_the_riser_passed_the_named_place(self):
        req, names = eu27_request()
        _, cands, _ = FN.candidates(req)
        ot = next(c for c in cands if c["id"] == "overtake")
        at0 = {c: self._at(req, c, "2005") for c in [*EU27, "EU27_2020"]}
        at1 = {c: self._at(req, c, "2024") for c in at0}
        rank = lambda v: {c: 1 + sum(1 for w in v.values() if w > v[c]) for c in v}
        r0, r1 = rank(at0), rank(at1)
        up, dn = ot["why"]["riser"], ot["why"]["faller"]
        self.assertEqual(ot["why"]["rose"], max(r0[c] - r1[c] for c in r0))
        self.assertEqual((r0[up] - r1[up], r1[dn] - r0[dn]), (ot["why"]["rose"], ot["why"]["fell"]))
        self.assertEqual(len(ot["data"]["rows"]), 28)
        composed, facts, drawn = draw_all(self, req, names, ["overtake", "tiles"])
        for c in at0:   # the printed ranks are the ledger's, which next_facts' position works out over every place of the table
            self.assertEqual(facts[f"ot_a_{c.lower()}"]["v"], r0[c], c); self.assertEqual(facts[f"ot_b_{c.lower()}"]["v"], r1[c], c)
        self.assertEqual(facts["ot_rise"]["v"], ot["why"]["rose"]); self.assertEqual(facts["ot_fall"]["v"], ot["why"]["fell"])
        title = composed["sections"][2]["title"]   # bignums, thesis, then the lead's own section
        over = re.search(r"\{name\.([A-Z0-9_]+)\}", ot["title"] and FN.wording(ot["title"]).split("超过了")[1]).group(1)
        self.assertTrue(at0[over] > at0[up] and at1[over] < at1[up], "the riser passed the place the title names")
        self.assertEqual(ot["data"]["accent"], [up, dn]); self.assertEqual(ot["data"]["ref"], "EU27_2020")

    def test_overtake_is_dropped_with_its_why(self):
        why = lambda r: {d["angle"]: d["why"] for d in FN.candidates(r)[2]}.get("overtake")
        req, _ = eu27_request()
        extra = {**req, "rows": req["rows"] + [row("nrg_ind_ren", {"nrg_bal": "REN"}, "geo", "NO", y, 70.0 + y - 2005) for y in range(2005, 2025)]}
        self.assertEqual(why(extra), "the table holds places the page does not name (a rank among them could not be printed)")
        # the same order at both years: nobody rose two ranks
        order = {c: (50.0 - i, 50.0 - i + 5.0) for i, c in enumerate(list(EU27)[:8])}
        self.assertEqual(why(eu27_request(order)[0]), "no place rose two ranks or more")
        few = {c: EU27[c] for c in list(EU27)[:3]}
        self.assertEqual(why(eu27_request(few)[0]), "fewer than 6 or more than 30 places")
        gap = eu27_request()[0]   # the whole has no value at the last year the members share
        gap["rows"] = [r for r in gap["rows"] if not (r["dims"].get("geo") == "EU27_2020" and r["time"] == "2024")]
        self.assertEqual(why(gap), "a place lacks a value at the first or the last year")

    def test_tiles_beat_the_map_in_a_crowd_and_lose_to_it_among_few(self):
        eu, _ = eu27_request(); wb, _ = wb12_request()
        score = lambda r, a: next(c for c in FN.candidates(r)[1] if c["id"] == a)
        t27, m27 = score(eu, "tiles"), score(eu, "map")
        self.assertGreater(t27["score"], m27["score"])
        self.assertEqual(t27["why"]["crowd"], 1.0)
        t12, m12 = score(wb, "tiles"), score(wb, "map")
        self.assertLess(t12["score"], m12["score"])
        self.assertAlmostEqual(t12["why"]["crowd"], 0.25, places=3)
        # the same size, surprise and sturdiness: only the crowd tells them apart
        for k in ("size", "surprise", "sturdy", "gradient", "higher"): self.assertEqual(t27["why"][k], m27["why"][k], k)

    def test_tiles_are_dropped_with_their_why(self):
        why = lambda r: {d["angle"]: d["why"] for d in FN.candidates(r)[2]}.get("tiles")
        eu, _ = eu27_request()
        nopt = {k: v for k, v in eu.items() if k != "points"}
        self.assertEqual(why(nopt), "the request gives no points for the members")
        self.assertEqual(why({**eu, "points": {c: eu["points"][c] for c in list(EU27)[:9]}}), "fewer than 10 members with a point")
        same = {**eu, "points": {c: eu["points"]["SE"] for c in EU27}}
        self.assertEqual(why(same), "two members share one point")
        flat = {**eu, "rows": [dict(r, value=5.0) if r["dims"].get("geo") in EU27 else r for r in eu["rows"]]}
        self.assertEqual(why(flat), "every member holds the same value")
        many = {f"X{i:02d}": (5.0 + i, 9.0 + i * 1.3) for i in range(41)}
        big = eu27_request(many)[0]
        big["points"] = {c: [-10.0 + i * 0.9, 36.0 + (i % 7) * 4.0] for i, c in enumerate(many)}
        self.assertEqual(why(big), "more than 40 members (the tiles would not fit one picture)")

    def test_the_three_new_charts_make_a_page_on_two_shapes(self):
        for mk in (eu27_request, wb12_request):
            req, names = mk()
            composed, facts, bodies, page_html = self._page(req, names, ["movers", "overtake", "tiles"])
            # the movers' extra part, the members at both years on one axis (dot_strip), after the three pictures
            self.assertEqual([x["layer"] for x in composed["sections"]], ["bignums", "thesis_claims", "change_dots", "rank_slope", "tile_map", "dot_strip", "risk_notes"])
            for sid in ("movers", "overtake", "tiles"): self.assertIn(f'data-module-id="{sid}"', page_html)
            for layer in ("change_dots", "rank_slope", "tile_map"):
                self.assertTrue(bodies[layer].startswith("<g transform="), layer)   # a picture the page places at its own position
            self._once(page_html)
            # each section's notes: two, the section's own facts
            for sid, layer in self.NEW.items():
                sec = re.search(rf'<section class="sec" data-id="{sid}" .*?</section>', page_html, re.S).group(0)
                n_notes = len(re.findall(r'<li class="note">', sec))   # two by default; with no whole the tiles have one and the movers one unless the member that led is neither end
                self.assertEqual(n_notes, 2 if mk is eu27_request else {"movers": 1, "overtake": 2, "tiles": 1}[sid], (sid, mk.__name__))
            self.assertIn('data-legend="story"', page_html)
            self.assertIn(FN.WD.WORDS["story.legend.map"], page_html)   # the tile map's colours are the map's: one legend line

    def test_a_rank_slope_that_prints_another_rank_than_its_cells_give_is_refused_by_the_child(self):
        req, names = wb12_request()
        def edit(composed):
            rows = composed["leaves"]["rank_slope"]["rows"]
            rows[0]["a_rank"], rows[1]["a_rank"] = rows[1]["a_rank"], rows[0]["a_rank"]
        bad = self._page(req, names, ["overtake", "movers"], edit=edit, refused=True)
        self.assertTrue(bad and "is not the rank its cell gives" in str(bad[0]), bad)

    def test_the_three_new_angles_lead_the_lagging_arc_and_stand_in_its_order(self):
        req, _ = eu27_request()
        for lead in ("movers", "overtake", "tiles"):
            got = FN.compose({**req, "picks": [lead, "tiles" if lead != "tiles" else "movers", "path"]})
            self.assertEqual(got["arc"]["id"], "lagging", lead)
            self.assertEqual(got["sections"][2]["id"], lead)
        got = FN.compose({**req, "picks": ["need", "tiles", "movers", "overtake"]})
        self.assertEqual(got["arc"]["id"], "in_time")
        self.assertEqual([x["id"] for x in got["sections"] if x["id"] in FN.ARC_ORDER["in_time"]], ["need", "movers", "overtake", "tiles"])

    def test_tiles_title_says_which_side_is_higher(self):
        req, _ = eu27_request()
        pts = req["points"]
        for axis, expect in ((0, "东边的偏高"), (1, "北边的偏高")):
            val = {c: 10.0 + 2 * pts[c][axis] for c in EU27}
            rows = [dict(r, value=round(val[r["dims"]["geo"]], 3)) if r["dims"].get("geo") in EU27 else r for r in req["rows"]]
            composed = FN.compose({**req, "rows": rows, "picks": ["path", "tiles"]})
            self.assertIn(expect, next(x for x in composed["sections"] if x["id"] == "tiles")["title"])
        val = {c: 10.0 - 2 * pts[c][0] for c in EU27}
        rows = [dict(r, value=round(val[r["dims"]["geo"]], 3)) if r["dims"].get("geo") in EU27 else r for r in req["rows"]]
        self.assertIn("西边的偏高", next(x for x in FN.compose({**req, "rows": rows, "picks": ["path", "tiles"]})["sections"] if x["id"] == "tiles")["title"])


# ---------------------------------------------------------------- two periods (pace) and named groups (groups)

M49 = json.load(open(os.path.join(HERE, "..", "runtime", "pi", "assets", "m49-regions.json"), encoding="utf-8"))
M49_OVER = json.load(open(os.path.join(HERE, "..", "runtime", "pi", "assets", "m49-overrides.json"), encoding="utf-8"))
ASKED = {"pace": "能源危机后欧盟可再生能源发展加快了吗", "groups": "欧盟南北可再生能源差距有多大", "none": "欧盟哪些国家拖了可再生能源的后腿"}
CAUSE = ("危机", "战争", "疫情", "因为", "导致")
# twenty-four economies over five continents (test-only values, not data): a level in 2005 and a pace before and after 2014
WB24 = {"USA": (19.0, -0.2, -0.4), "CAN": (17.0, -0.1, -0.3), "MEX": (4.0, 0.05, 0.3), "BRA": (2.0, 0.04, 0.35), "ARG": (4.2, 0.03, -0.05),
        "CHL": (3.8, 0.06, 0.4), "COL": (1.5, 0.02, 0.25), "PER": (1.3, 0.05, 0.02), "DEU": (10.0, -0.1, -0.25), "FRA": (6.2, -0.08, -0.15),
        "NLD": (10.5, -0.05, -0.3), "BEL": (10.0, -0.1, -0.2), "CHE": (5.5, -0.07, -0.12), "AUT": (8.5, -0.04, -0.18), "CHN": (4.5, 0.4, 0.15),
        "JPN": (9.5, -0.02, -0.15), "KOR": (10.0, 0.15, -0.05), "MNG": (6.0, 0.3, 0.2), "IND": (1.0, 0.06, 0.05), "PAK": (0.8, 0.02, 0.01),
        "BGD": (0.3, 0.03, 0.3), "LKA": (0.6, 0.02, 0.03), "NGA": (0.6, 0.0, -0.01), "GHA": (0.4, 0.01, 0.02)}


def m49_groups(codes):
    """The knowledge group's M49Groups as this test reads the asset (next_knowledge m49_groups does it in Rust, its own test there):
    Eurostat's EL is Greece, an override applies when the country stands alone in its sub-region among the codes."""
    by2 = {c["iso2"]: c for c in M49["countries"]}; by3 = {c["iso3"]: c for c in M49["countries"]}
    at = [(c, (by3.get(c) or by2.get({"EL": "GR"}.get(c, c)))["iso3"], (by3.get(c) or by2.get({"EL": "GR"}.get(c, c)))["sub_region"]) for c in codes]
    moved = []
    for o in M49_OVER["overrides"]:
        hit = [i for i, a in enumerate(at) if a[1] == o["iso3"]]
        if not hit: continue
        i = hit[0]; frm = at[i][2]
        if o.get("when_alone") and sum(1 for a in at if a[2] == frm) > 1: continue
        moved.append({"code": at[i][0], "from_zh": M49["regions"][frm]["name_zh"], "to_zh": M49["regions"][o["sub_region"]]["name_zh"]})
        at[i] = (at[i][0], at[i][1], o["sub_region"])
    subs = sorted({a[2] for a in at})
    return {"groups": [{"id": s_, "name_zh": M49["regions"][s_]["name_zh"], "members": [a[0] for a in at if a[2] == s_]} for s_ in subs], "moved": moved}


def eu27_plain(question="", whole=False):
    """The twenty-seven members with their groups and no target (the st3-st5 runs': no whole fetched), or with the whole."""
    req, names = eu27_request()
    if not whole:
        req = {k: v for k, v in req.items() if k != "target"}
        req["rows"] = [r for r in req["rows"] if r["dims"].get("geo") not in ("EU27_2020",) and r["table"] != "targets"]
        req["main"] = {k: v for k, v in req["main"].items() if k != "whole"}
    return {**req, "groups": m49_groups(req["main"]["members"]), "question": question}, names


def wb24_request(question=""):
    t = "EN.GHG.CO2.PC.CE.AR5"
    rows = []
    for c, (a, p0, p1) in WB24.items():
        for y in range(2005, 2023):
            v = a + p0 * (min(y, 2014) - 2005) + p1 * max(0, y - 2014) + 0.05 * math.sin(y + ord(c[0]))
            rows.append({**row(t, {}, "country", c, y, v), "value": f"{v:.2f}"})
    names = {c: c for c in WB24}
    return {"rows": rows, "main": {"table": t, "by": "country"}, "fmts": FMTS, "fmt_defs": FMT_DEFS,
            "words": {"measure": "人均二氧化碳排放", "unit": "吨／人"}, "groups": m49_groups(list(WB24)), "question": question}, names


WB24_NAMES = {"USA": "美国", "CAN": "加拿大", "MEX": "墨西哥", "BRA": "巴西", "ARG": "阿根廷", "CHL": "智利", "COL": "哥伦比亚", "PER": "秘鲁",
              "DEU": "德国", "FRA": "法国", "NLD": "荷兰", "BEL": "比利时", "CHE": "瑞士", "AUT": "奥地利", "CHN": "中国", "JPN": "日本", "KOR": "韩国",
              "MNG": "蒙古", "IND": "印度", "PAK": "巴基斯坦", "BGD": "孟加拉国", "LKA": "斯里兰卡", "NGA": "尼日利亚", "GHA": "加纳"}


def words_of(composed):
    """Every literal word a composed page holds (titles, texts, leaf segments)."""
    return json.dumps(composed, ensure_ascii=False)


class PaceAndGroups(unittest.TestCase):
    SHAPES = (eu27_plain, wb24_request)

    def cand(self, req, angle):
        q, cands, dropped = FN.candidates(req)
        return next((c for c in cands if c["id"] == angle), None), {d["angle"]: d["why"] for d in dropped}

    def test_pace_stands_on_two_shapes_and_names_the_split_by_its_year_alone(self):
        for mk in self.SHAPES:
            req, names = mk(ASKED["pace"])
            c, _ = self.cand(req, "pace")
            self.assertIsNotNone(c, mk.__name__)
            # the split: the year with the largest difference of the two paces, each window PACE_WIN years at least
            q = FN.Req(req)
            ys = FN.run_years({y: 1 for y in sorted(set.intersection(*(set(s_) for s_ in q.panel.values())))})
            m = {y: sum(q.panel[x][y][0] for x in q.panel) / len(q.panel) for y in ys}
            ok = [y for y in ys if int(y) - int(ys[0]) + 1 >= FN.PACE_WIN and int(ys[-1]) - int(y) + 1 >= FN.PACE_WIN]
            diff = lambda s_: abs((m[ys[-1]] - m[s_]) / (int(ys[-1]) - int(s_)) - (m[s_] - m[ys[0]]) / (int(s_) - int(ys[0])))
            best = max(ok, key=lambda y: (diff(y), -int(y)))
            self.assertEqual((c["why"]["from"], c["why"]["to"], c["why"]["event"]), (best, best, None))
            composed, facts, drawn = draw_all(self, req, names, ["pace", "rank"])
            self.assertIn("{pc_to.t}以后", composed["title"])
            for w in CAUSE: self.assertNotIn(w, words_of(composed), (mk.__name__, w))
            self.assertIn(FN.WD.WORDS["story.risk.pace_split"], words_of(composed["leaves"]["risk_notes"]))
            # the split years are facts of their own; the paces recompute from the rows the way the child read them
            self.assertEqual((composed["facts"]["pc_from"]["time"], composed["facts"]["pc_to"]["time"]), (best, best))
            self.assertAlmostEqual(facts["pc_a"]["v"], (m[best] - m[ys[0]]) / (int(best) - int(ys[0])), places=6)
            self.assertAlmostEqual(facts["pc_b"]["v"], (m[ys[-1]] - m[best]) / (int(ys[-1]) - int(best)), places=6)
            # no count of members is printed or declared (no op checks a member's two paces); the ratio only when both paces are above 0
            self.assertFalse([k for k, v in c["facts"].items() if v.get("op") in ("n", "count")], mk.__name__)
            self.assertNotIn("个成员国里", words_of(composed))
            if facts["pc_a"]["v"] > 0 and facts["pc_b"]["v"] > 0: self.assertAlmostEqual(facts["pc_x"]["v"], facts["pc_b"]["v"] / facts["pc_a"]["v"], places=6)
            else: self.assertNotIn("pc_x", facts)
            self.assertIn("winners_losers", drawn)

    def test_pace_with_an_event_splits_at_its_years_and_says_its_name(self):
        for mk in self.SHAPES:
            req, names = mk()
            ys = sorted({r["time"] for r in req["rows"]})
            ev = {"id": "test_event", "name_zh": "测试事件", "from": ys[6], "to": ys[7]}
            c, _ = self.cand({**req, "events": [ev]}, "pace")
            self.assertEqual((c["why"]["from"], c["why"]["to"], c["why"]["event"]), (ys[6], ys[7], "test_event"))
            composed, facts, _ = draw_all(self, {**req, "events": [ev]}, names, ["pace", "rank"])
            self.assertTrue(composed["title"].startswith("测试事件以后"), composed["title"])
            self.assertEqual((composed["facts"]["pc_from"]["time"], composed["facts"]["pc_to"]["time"]), (ys[6], ys[7]))
            self.assertIn("测试事件", words_of(composed["leaves"]["risk_notes"]))
            # an event outside the years, or one that leaves a window short, is passed over: the split is the data's again
            for far in ({**ev, "from": "1990", "to": "1991"}, {**ev, "from": ys[1], "to": ys[1]}):
                c2, _ = self.cand({**req, "events": [far]}, "pace")
                self.assertIsNone(c2["why"]["event"], far)
                self.assertNotIn("测试事件", words_of(FN.compose({**req, "events": [far], "picks": ["pace", "rank"]})))

    def test_pace_needs_eight_years_in_a_row(self):
        for mk in self.SHAPES:
            req, _ = mk()
            ys = sorted({r["time"] for r in req["rows"]})
            short = {**req, "rows": [r for r in req["rows"] if r["time"] in ys[-7:]]}
            c, why = self.cand(short, "pace")
            self.assertIsNone(c); self.assertIn("fewer than 8 years", why["pace"])

    def test_groups_by_m49_sub_region_with_cyprus_in_southern_europe_and_said_so(self):
        req, names = eu27_plain(ASKED["groups"])
        g = {x["name_zh"]: x["members"] for x in req["groups"]["groups"]}
        self.assertEqual(sorted(g), ["东欧", "北欧", "南欧", "西欧"])
        self.assertIn("EL", g["南欧"]); self.assertIn("CY", g["南欧"])   # EL is Greece; Cyprus placed by the override
        self.assertEqual(req["groups"]["moved"], [{"code": "CY", "from_zh": "西亚", "to_zh": "南欧"}])
        composed, facts, drawn = draw_all(self, req, names, ["groups", "rank"])
        self.assertEqual(composed["facts"]["gp_039"]["filter"]["geo"], sorted(g["南欧"]))
        notes = composed["leaves"]["risk_notes"]["items"]
        self.assertIn([{"name": "CY"}, {"w": "按联合国地理分区属"}, {"w": "西亚"}, {"w": "，本页归入"}, {"w": "南欧"}], notes)
        self.assertIn([{"w": FN.WD.WORDS["story.risk.simple_mean"]}], notes)
        # every number is a fact recomputed from the rows: each group's simple mean, the gap of the highest over the lowest
        at = {c: float(r["value"]) for r in req["rows"] for c in [r["dims"]["geo"]] if r["time"] == "2024"}
        means = {x["id"]: sum(at[c] for c in x["members"]) / len(x["members"]) for x in req["groups"]["groups"]}
        for gid, v in means.items(): self.assertAlmostEqual(facts[f"gp_{gid}"]["v"], v, places=6)
        self.assertAlmostEqual(facts["gp_gap"]["v"], max(means.values()) - min(means.values()), places=6)
        self.assertAlmostEqual(facts["gp_all"]["v"], sum(at.values()) / len(at), places=6)
        self.assertEqual([s_["layer"] for s_ in composed["sections"]][2:5], ["glyph_row", "rankbar", "dot_strip"])   # the means, the rank, then the members by group
        self.assertEqual([i["code"] for i in composed["leaves"]["glyph_row"]["items"]], sorted(means, key=lambda g: -means[g]))
        self.assertEqual([g["id"] for g in composed["leaves"]["dot_strip"]["groups"]], sorted(means, key=lambda g: -means[g]))
        self.assertTrue({"glyph_row", "dot_strip"} <= set(drawn))

    def test_groups_on_a_world_bank_shape_are_the_continents_sub_regions(self):
        req, names = wb24_request(ASKED["groups"])
        c, _ = self.cand(req, "groups")
        self.assertIsNotNone(c)
        composed, facts, _ = draw_all(self, req, names, ["groups", "ends"])
        kept = {x["id"] for x in req["groups"]["groups"] if len(x["members"]) >= FN.GROUP_MEMBERS}
        self.assertEqual({k[3:] for k in composed["facts"] if re.fullmatch(r"gp_\d{3}", k)}, kept)
        self.assertEqual(c["why"]["groups"], len(kept))
        left = sorted(x for g in req["groups"]["groups"] if len(g["members"]) < FN.GROUP_MEMBERS for x in g["members"])
        self.assertTrue(left, "the shape keeps a small group out")
        self.assertIn([{"name": x} if i % 2 == 0 else {"w": FN.WD.WORDS["story.join"]} for i, x in enumerate(sum(([l, None] for l in left), [])[:-1])][0], composed["leaves"]["risk_notes"]["items"][-2])
        self.assertEqual(req["groups"]["moved"], [])

    def test_groups_need_two_groups_of_three_members(self):
        for mk in self.SHAPES:
            req, _ = mk()
            members = sorted({x for g in req["groups"]["groups"] for x in g["members"]})
            one = {"groups": [{"id": "001", "name_zh": "甲组", "members": members}], "moved": []}
            c, why = self.cand({**req, "groups": one}, "groups")
            self.assertIsNone(c); self.assertIn("fewer than 2 groups", why["groups"])
            twos = {"groups": [{"id": f"{i:03d}", "name_zh": "甲组", "members": members[i:i + 2]} for i in range(0, len(members), 2)], "moved": []}
            c, why = self.cand({**req, "groups": twos}, "groups")
            self.assertIsNone(c); self.assertIn("fewer than 2 groups", why["groups"])
            c, why = self.cand({k: v for k, v in req.items() if k != "groups"}, "groups")
            self.assertIsNone(c); self.assertIn("no groups", why["groups"])

    def test_the_question_words_raise_the_finding_they_name(self):
        for mk in self.SHAPES:
            for asked, angle in (("pace", "pace"), ("groups", "groups")):
                req, _ = mk(ASKED[asked])
                _, cands, _ = FN.candidates(req)
                self.assertEqual(cands[0]["id"], angle, (mk.__name__, asked))
            req, _ = mk(ASKED["none"])
            _, cands, _ = FN.candidates(req)
            self.assertTrue(all(c["why"].get("asked") is None for c in cands if c["id"] in ("pace", "groups")))
            self.assertEqual(len(cands), len({c["id"] for c in cands}))

    def test_reference_labels_come_from_the_words_and_the_target_row(self):
        """The groups' glyph row has the members' mean as its ghost glyph, labelled 成员国简单平均 (story.ref.mean); its dot strip draws
        the mean with the leaf's own word (dot.mean, the same words) and the target labelled '<place> <year> 年整体目标' from the request's
        target row (EU27_2020 at 2030 here); a World Bank shape with no target has no target reference."""
        def say(segs, rows):
            led = {r["src"]: r["text"] for r in rows if "text" in r}
            out = []
            for s_ in segs:
                if "w" in s_: out.append(s_["w"])
                elif "src" in s_: out.append(led[s_["src"]])
                elif "word" in s_: out.append(FN.WD.WORDS[s_["word"]])
                else: out.append(led[K.name_row(s_["name"], "place")])
            return "".join(out)
        req, names = eu27_request()
        req = {**req, "groups": m49_groups(list(req["main"]["members"]))}
        composed = FN.compose({**req, "picks": ["groups", "rank"]})
        rows, _ = ledger(req, composed, names)
        self.assertEqual(say(composed["leaves"]["glyph_row"]["ref"]["label"], rows), "成员国简单平均")
        refs = {r["kind"]: r for r in composed["leaves"]["dot_strip"]["refs"]}
        self.assertNotIn("label", refs["mean"]); self.assertEqual(FN.WD.WORDS["dot.mean"], "成员国简单平均")
        self.assertEqual(say(refs["target"]["label"], rows), "欧盟 2030 年整体目标")
        n = 0
        for mk in (wb24_request, wb12_request):
            wreq, wnames = mk()
            wreq = {**wreq, "groups": m49_groups(sorted({r["dims"]["country"] for r in wreq["rows"]}))}
            c = next((x for x in FN.candidates(wreq)[1] if x["id"] == "groups"), None)
            if c is None: continue
            n += 1
            strip = next(m["data"] for m in [{"data": c["data"], "layer": c["layer"]}, *c.get("more", [])] if m["layer"] == "dot_strip")
            self.assertEqual([r["kind"] for r in strip["refs"]], ["mean"], mk.__name__)
            self.assertEqual(strip["legend"], "dot.legend_plain")   # the page's legend names no target either
        self.assertGreater(n, 0)

    LEADS = ("pace", "groups", "movers", "overtake", "tiles", "members", "rank")

    def test_each_lead_opens_with_its_own_numbers_on_one_table(self):
        """The big numbers over the page and the first section follow the lead (the first pick): on one table, each lead's three
        opening numbers are its own facts, no two leads open alike, and every number is a fact the page declares (EU 27 members
        and World Bank 24 economies)."""
        for mk in self.SHAPES:
            req, names = mk()
            ids = {c["id"] for c in FN.candidates(req)[1]}
            opened = {}
            for lead in (l for l in self.LEADS if l in ids):
                other = "ends" if lead != "ends" else "rank"
                composed = FN.compose({**req, "picks": [lead, other]})
                big = [i["fact"] for i in composed["leaves"]["bignums"]["bignums"]]
                self.assertEqual(len(big), 3, (mk.__name__, lead))
                self.assertTrue(all(k in composed["facts"] for k in big), (mk.__name__, lead, big))
                self.assertEqual([s_["id"] for s_ in composed["sections"] if s_.get("title")][0], lead)   # the first block is the lead's
                lead_facts = FN.candidates(req)[1]
                own = next(c for c in lead_facts if c["id"] == lead)
                if lead != "rank": self.assertTrue(set(big) <= set(own["facts"]), (mk.__name__, lead, big))   # its own facts
                for k in big: self.assertNotIn(composed["facts"][k].get("op"), ("n", "count"), (lead, k))   # no unchecked count opens a page
                opened[lead] = tuple(big)
            self.assertGreaterEqual(len(opened), 5, mk.__name__)
            self.assertEqual(len(set(opened.values())), len(opened), (mk.__name__, opened))

    def test_the_page_draws_every_section_of_each_lead_on_two_shapes(self):
        """Each lead with a second pick is composed and drawn by the real page child (every section's leaf, the page around them):
        the new leaves (glyph_row, dot_strip, unit_grid) where the angle and the data shape call them, the fallback leaf otherwise."""
        seen = set()
        for mk in self.SHAPES:
            req, names = mk()
            ids = {c["id"] for c in FN.candidates(req)[1]}
            for lead in (l for l in self.LEADS if l in ids):
                picks = [lead, "rank" if lead != "rank" else "groups"]
                composed, facts, bodies, page_html = Findings._page(self, req, names, picks)
                layers = [s_["layer"] for s_ in composed["sections"]]
                # no page prints a count layer 1 cannot recompute: no n or count fact, no unit grid count
                self.assertFalse([k for k, v in composed["facts"].items() if v.get("op") in ("n", "count")], (mk.__name__, lead))
                self.assertNotIn("count", composed["leaves"].get("unit_grid", {}))
                for s_ in composed["sections"]:
                    if s_.get("title"): self.assertIn(f'data-module-id="{s_["id"]}"', page_html, (mk.__name__, lead, s_["id"]))
                seen |= set(layers)
        self.assertTrue({"glyph_row", "dot_strip", "unit_grid"} <= seen, seen)

    # ---------------------------------------------------------------- the page as baked: every lead angle, both shapes, a delta format with unit words

    @staticmethod
    def with_delta(req, level_words=False):
        """The request with a difference format whose unit is words after the number (the way the real runs' fmts print a pace:
        "0.7 个百分点"): a pace and a change print with the unit, a cell of a winners_losers row must still be a plain number."""
        defs = {**req["fmt_defs"], "dlt": {"scale": 1, "dec": 1, "suffix": " 个百分点"}}
        if level_words: defs[req["fmts"]["value"]] = {**defs[req["fmts"]["value"]], "suffix": " 吨"}   # the level's own format with unit words too
        return {**req, "fmts": {**req["fmts"], "delta": "dlt"}, "fmt_defs": defs}

    def baked(self, req, names, picks, what):
        """The picks' page drawn by the real page child, then laid out and checked in Chrome (the bake's layout checks): none may find a
        text on a line, over another text or off the page."""
        if not bake.chrome(): self.skipTest("no Chrome or Chromium to lay the page out in")
        composed, facts, bodies, page_html = Findings._page(self, req, names, picks)
        got = bake.bake({"html": page_html, "ready": "", "width": 1140})
        self.assertNotIn("error", got, (what, picks, got.get("error")))
        return composed

    def test_the_baked_page_of_every_angle_on_three_shapes_and_the_failed_runs_picks(self):
        """Each lead angle (with a second pick) on an EU shape of 27 members with the whole and the target, the same with no whole, and a
        World Bank shape of 24 economies, each also with a delta format that carries unit words, is drawn by the page child and baked. The
        picks of the two failed stand-in runs ride along: need, rank, movers, overtake (the unit grid's leader through its row of names)
        and movers, overtake, pace, rank (a pace's cells as a plain number)."""
        shapes = (("eu27 whole", lambda: eu27_plain(whole=True)), ("eu27", eu27_plain), ("wb24", wb24_request))
        layers = set()
        for name, mk in shapes:
            for delta in (False, True):   # the test formats; a delta format that carries unit words
                req, names = mk()
                if mk is wb24_request: names = WB24_NAMES   # the page names the economies in words (the rank's label column is sized for them)
                if delta: req = self.with_delta(req)
                ids = {c["id"] for c in FN.candidates(req)[1]}
                runs = [[lead, "rank" if lead != "rank" else "groups"] for lead in self.LEADS + ("need", "path", "ends", "map") if lead in ids]
                runs += [p for p in (["need", "rank", "movers", "overtake"], ["movers", "overtake", "pace", "rank"], ["pace", "groups", "movers"]) if set(p) <= ids]
                self.assertGreaterEqual(len(runs), 6, (name, ids))
                for picks in runs:
                    layers |= {s_["layer"] for s_ in self.baked(req, names, picks, f"{name} delta={delta}")["sections"]}
        self.assertTrue({"winners_losers", "unit_grid", "glyph_row", "dot_strip"} <= layers, layers)

    def test_a_winners_losers_row_prints_a_plain_number_whatever_the_format_says(self):
        """The pace, groups and spread rows hand winners_losers cells that are plain numbers when the format carries unit words; the
        sentences (the rows' title) and the change cell keep the unit."""
        for mk in (eu27_plain, wb24_request):
            req, names = mk()
            req = self.with_delta(req, level_words=True)
            seen = set()
            for angle in ("pace", "groups", "spread"):
                cand = next((c for c in FN.candidates(req)[1] if c["id"] == angle), None)
                if not cand: continue
                wl = []
                def find(x):   # every winners_losers data the candidate holds (its leaf, a second section, the fallback)
                    if isinstance(x, dict):
                        if isinstance(x.get("up"), dict) and isinstance(x.get("down"), dict) and "rows" in x["up"]: wl.append(x)
                        else: [find(v) for v in x.values()]
                    elif isinstance(x, list): [find(v) for v in x]
                find(cand)
                for d in wl:
                    for r in d["up"]["rows"] + d["down"]["rows"]:
                        for k in ("a", "b"): self.assertTrue(r[k].endswith(".n"), (mk.__name__, angle, r))
                        self.assertFalse(r["change"][0]["src"].endswith(".n"))
                        seen.add(angle)
            self.assertIn("pace", seen, mk.__name__)
            self.assertIn("groups", seen, mk.__name__)

    def test_two_picks_on_one_leaf_keep_the_first_and_the_arcs(self):
        req, _ = eu27_plain()
        # groups and pace both draw glyph_row first: the later pick takes its fallback leaf (the members' rows), none goes
        got = FN.compose({**req, "picks": ["groups", "pace", "rank"]})
        self.assertEqual(got["arc"]["id"], "lagging")
        lay = {s_["id"]: s_["layer"] for s_ in got["sections"]}
        self.assertEqual((lay["groups"], lay["pace"], lay["rank"]), ("glyph_row", "winners_losers", "rankbar"))
        self.assertEqual(len(set(lay.values())), len(lay))
        got = FN.compose({**req, "picks": ["pace", "groups"]})
        self.assertEqual(got["arc"]["id"], "happened")
        self.assertEqual(len({s_["layer"] for s_ in got["sections"]}), len(got["sections"]))
        self.assertEqual((FN.ARC_OF["pace"], FN.ARC_OF["groups"]), ("happened", "lagging"))


if __name__ == "__main__":
    unittest.main()
