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
import story  # noqa: E402
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
        elif op in ("minus", "times", "plus"):
            a, b = get(q["a"]), get(q["b"])
            f.update(v={"minus": a["v"] - b["v"], "plus": a["v"] + b["v"]}.get(op) if op != "times" else a["v"] / b["v"])
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
        elif op == "count":   # under a line (below, no b): each member's own value of a at the time under it; every member needs its row
            assert "below" in q and "b" not in q, k
            at = {r["dims"][q["by"]]: r["value"] for r in sel(q["a"]) if r["time"] == q["time"]}
            assert all(c in at for c in members), f"{k}: a member has no row of a"
            f.update(v=sum(1 for c in members if at[c] < q["below"]))
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


def draw_all(test, req, names, picks, extra=()):
    composed = FN.compose({**req, "picks": picks})
    rows, facts = ledger(req, composed, names)
    rows += list(extra)   # more ledger entries the page's request holds (a unit's name entry)
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
        self.assertEqual(sorted(c["id"] for c in cands), ["below", "ends", "members", "movers", "need", "overtake", "pace", "path", "rank", "spread"])
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
                                                                  "pace": "every member changed pace the same way and a pace is below 0 (no picture stands)", "groups": "the request gives no groups of the members",
                                                                  "below": "fewer than 8 members at the last year they share"})
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

    def _note_words(self, cand):
        """Each short note's words as one string (the placeholders left as they stand)."""
        return ["".join(seg.get("w", "") if "w" in seg else "{" + str(seg) + "}" for seg in n["text"]) for n in cand["anns"]]

    def test_the_rank_notes_say_how_many_times_the_whole_or_the_highest_on_two_shapes(self):
        req, _ = eu_request()
        _, cands, _ = FN.candidates(req)
        rank = next(c for c in cands if c["id"] == "rank")
        f = rank["facts"]
        self.assertEqual((f["t_hi"]["op"], f["t_hi"]["a"], f["t_hi"]["b"]), ("times", f"r_{rank['about'][0].lower()}", "r_eu27_2020"))
        # the lowest is below the whole: the whole as a multiple of it (a ratio above 1), never the lowest as 0.6 times the whole
        self.assertEqual((f["t_lo"]["a"], f["t_lo"]["b"]), ("r_eu27_2020", f"r_{rank['about'][1].lower()}"))
        segs = rank["anns"][1]["text"]
        i = next(k for k, g in enumerate(segs) if g.get("w", "").endswith("相差，"))
        self.assertEqual([g.get("name") or g.get("w") or g.get("src") for g in segs[i + 1:]],
                         ["EU27_2020", "是", rank["about"][1], "的 ", "fact:t_lo", " 倍"])   # the whole is N times the lowest, never the lowest 0.6 times the whole
        self.assertTrue(all("倍" in w for w in self._note_words(rank)), self._note_words(rank))
        req, _ = wb_request()
        _, cands, _ = FN.candidates(req)
        rank = next(c for c in cands if c["id"] == "rank")
        hi, lo = rank["about"]
        self.assertEqual((rank["facts"]["t_lo"]["a"], rank["facts"]["t_lo"]["b"]), (f"r_{hi.lower()}", f"r_{lo.lower()}"))
        self.assertNotIn("t_hi", rank["facts"])
        self.assertIn("倍", self._note_words(rank)[0])

    def test_a_note_with_no_plain_ratio_keeps_its_old_words(self):
        f = {}
        q = type("Q", (), {"fmts": {"times": "n1"}})()
        self.assertTrue(FN.ratio(q, f, "x", "a", "b", 6.0, 2.0)); self.assertEqual(f["x"]["op"], "times")
        for va, vb in ((6.0, 0.0), (6.0, -1.0), (-1.0, 2.0)):
            g = {}
            self.assertFalse(FN.ratio(q, g, "x", "a", "b", va, vb)); self.assertEqual(g, {})
        # flip: the smaller one `a` below `b` is written the other way round (b over a), and only where the smaller is above 0
        g = {}
        self.assertTrue(FN.ratio(q, g, "x", "a", "b", 2.0, 6.0, flip=True)); self.assertEqual((g["x"]["a"], g["x"]["b"]), ("b", "a"))
        g = {}
        self.assertFalse(FN.ratio(q, g, "x", "a", "b", 0.0, 6.0, flip=True)); self.assertEqual(g, {})

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
                                        "knobs": {"spec": spec, "labels": names, "shapes": SHAPES, "members": members}, **kv}, ensure_ascii=False)
        # the members layer 1 gives every page (next_run story_page: knobs.members, the story input's): a count reads them
        members = req["main"].get("members") or sorted({r["dims"][req["main"]["by"]] for r in req["rows"] if r["table"] == req["main"]["table"]})
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
                ranked = any(s_["layer"] in ("rankbar", "rank_slope") for s_ in composed["sections"])   # the lagging line speaks of ranks only with a section of ranks
                self.assertEqual(end, FN.WD.WORDS["story.end.happened_plain" if arc == "happened" else "story.end.lagging" if ranked else "story.end.lagging_level"])
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
        self.assertEqual(sorted(c["id"] for c in out[0]["candidates"]), ["below", "ends", "members", "movers", "need", "overtake", "pace", "path", "rank", "spread"])
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
            # the movers' extra part (the members at both years on one axis, dot_strip) shows what the movers' own dots show (each
            # member at the first and the last year): one question is answered once, so it goes
            self.assertEqual([x["layer"] for x in composed["sections"]], ["bignums", "thesis_claims", "change_dots", "rank_slope", "tile_map", "risk_notes"])
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
        """The groups' glyph row has the members' mean as its ghost glyph, labelled with the words for the members' simple mean (story.ref.mean); its dot strip draws
        the mean with the leaf's own word (dot.mean, the same words) and the target labelled '<place>', '<year>', then the words for the year's overall target, from the request's
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

    LEADS = ("pace", "groups", "movers", "overtake", "tiles", "members", "rank", "below")

    @staticmethod
    def unchecked(q):
        """A count layer 1 cannot recompute: any n, or a count that is not one under a line (op count, below, no b: layer 1 counts the
        members whose own value is under it, from the rows)."""
        return q.get("op") == "n" or (q.get("op") == "count" and not ("below" in q and "b" not in q))

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
                for k in big: self.assertFalse(self.unchecked(composed["facts"][k]), (lead, k))   # no unchecked count opens a page
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
                self.assertFalse([k for k, v in composed["facts"].items() if self.unchecked(v)], (mk.__name__, lead))
                self.assertNotIn("count", composed["leaves"].get("unit_grid", {}))
                for s_ in composed["sections"]:
                    if s_.get("title"): self.assertIn(f'data-module-id="{s_["id"]}"', page_html, (mk.__name__, lead, s_["id"]))
                seen |= set(layers)
        self.assertTrue({"glyph_row", "dot_strip", "unit_grid"} <= seen, seen)

    # ---------------------------------------------------------------- the page as baked: every lead angle, both shapes, a delta format with unit words

    @staticmethod
    def with_delta(req, level_words=False):
        """The request with a difference format whose unit is words after the number (the way the real runs' fmts print a pace:
        0.7 followed by the words for percentage points): a pace and a change print with the unit, a cell of a winners_losers row must still be a plain number."""
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



# ---------------------------------------------------------------- one question a block, five blocks at most, a lead's names

DATA_OFF = ("bignums", "thesis_claims", "risk_notes")

def accent_marks_by_section(page_html):
    """{section id: (the codes its h2 names, the codes of the marks drawn in the accent there)}: a mark is any rect, circle, path or
    polygon with a data-code filled or stroked with the accent; the pair bars' "main" bars are left out (they name their entity by
    the column above them, not by a code)."""
    out = {}
    for sid, body in re.findall(r'<section class="sec" data-id="([a-z0-9_]+)"[^>]*>((?:(?!</section>).)*)</section>', page_html, re.S):
        h2 = re.search(r"<h2\b[^>]*>(.*?)</h2>", body, re.S)
        named = set(re.findall(r'data-src="name:[^"]*:([^":]+)"', h2[1])) if h2 else set()
        marks = {m for m in re.findall(r'<(?:rect|circle|path|polygon|line|polyline) [^>]*?(?:fill|stroke)="var\(--accent\)"[^>]*?data-code="([^"]+)"', body)}
        marks |= {m for m in re.findall(r'<(?:rect|circle|path|polygon|line|polyline) [^>]*?data-code="([^"]+)"[^>]*?(?:fill|stroke)="var\(--accent\)"', body)}
        out[sid] = (named, marks - {"main"})
    return out


class GlyphAccentIsTheNamed(unittest.TestCase):
    """A story page's glyph row (the group means, the two paces) draws its glyph in the accent only when the section's headline names
    its code ({name.<code>}); a group's or a period's glyph has a name of its own words, no name row, so it is drawn in the bar's grey.
    Over every section of the page, each code drawn in the accent is one the section's headline names. On a Eurostat percent shape
    and a World Bank shape for the groups angle, on the Eurostat shape for the pace angle (the World Bank shape draws no pace glyphs)."""
    CASES = (("eu groups", lambda: eu27_plain(ASKED["groups"]), ["groups", "rank"]),
             ("wb groups", lambda: wb24_request(ASKED["groups"]), ["groups", "ends"]),
             ("eu pace", lambda: eu27_plain(ASKED["pace"]), ["pace", "rank"]))

    def test_the_glyph_rows_accent_is_dropped_and_every_red_code_is_named(self):
        seen = set()
        for what, mk, picks in self.CASES:
            req, names = mk()
            composed = FN.compose({**req, "picks": picks})
            if "glyph_row" not in composed["leaves"]: continue
            self.assertIsNotNone(composed["leaves"]["glyph_row"].get("accent"), what)        # the composed leaf marks one glyph
            given = story.accent_only({"sections": composed["sections"], "hero": {"leaves": composed["leaves"]}})
            self.assertEqual(given["glyph_row"]["accent"], [], what)                          # its headline names no item's code
            page_html = Findings._page(self, req, names, picks)[3]
            secs = accent_marks_by_section(page_html)
            gsec = next(x["id"] for x in composed["sections"] if x["layer"] == "glyph_row")
            body = re.search(r'<section class="sec" data-id="' + gsec + r'"[^>]*>((?:(?!</section>).)*)</section>', page_html, re.S)[1]
            self.assertNotIn('data-glyph="circle"', re.sub(r'<circle [^>]*fill="var\(--bar\)"[^>]*data-glyph="circle"/>|<circle [^>]*fill="none"[^>]*/>', "", body), what)
            for sid, (named, marks) in secs.items(): self.assertLessEqual(marks, named, (what, sid))
            seen.add(what)
        self.assertEqual(seen, {c[0] for c in self.CASES}, seen)


def percent(mk):
    """A shape's request with its value format printing a percent sign (the Eurostat share pages' format)."""
    def go(*a):
        req, names = mk(*a)
        return {**req, "fmt_defs": {**req["fmt_defs"], "x": {**req["fmt_defs"]["x"], "suffix": "%"}}}, names
    return go


class LowestOfGroupAndMoversHeadline(unittest.TestCase):
    """The groups section's note on the widest group's lowest member sets it against that group's own simple mean (the gap in points
    on a percent measure, the mean as a multiple of it on any other unit), a fact recomputed from the rows; the movers' headline says
    with its verb which way the biggest mover went (rose to ..., rose most / fell to ..., fell most). A Eurostat percent shape and a
    World Bank value shape each."""

    def test_the_lowest_of_the_widest_group_is_set_against_its_mean(self):
        seen = set()
        for mk, kind in ((percent(eu27_plain), "pp"), (wb24_request, "x")):
            req, names = mk(ASKED["groups"])
            composed, facts, _ = draw_all(self, req, names, ["groups", "rank"])
            note = next(n for n in composed["leaves"]["glyph_row"]["notes"] if n["num"] == "fact:gp_vlo")
            words = "".join(x.get("w", "") for x in note["text"])
            self.assertTrue(("比" in words and "低" in words) if kind == "pp" else "倍" in words, (kind, note))
            self.assertIn("平均", words, kind)
            ref = next(x["src"][5:] for x in note["text"] if x.get("src", "").startswith("fact:gp_") and x["src"] != "fact:gp_vlo")
            d = next(x["src"][5:] for x in note["text"] if x.get("src", "").startswith("fact:vs_"))
            # the widest group's mean is the reference: its lowest member is below it; the number is the gap or the multiple, from the rows
            self.assertLess(facts["gp_vlo"]["v"], facts[ref]["v"], kind)
            want = facts[ref]["v"] - facts["gp_vlo"]["v"] if kind == "pp" else facts[ref]["v"] / facts["gp_vlo"]["v"]
            self.assertAlmostEqual(facts[d]["v"], want, places=6)
            self.assertEqual(composed["facts"][d]["op"], "minus" if kind == "pp" else "times", kind)
            seen.add(kind)
        self.assertEqual(seen, {"pp", "x"})

    def test_the_movers_headline_says_which_way_with_its_verb(self):
        seen = set()
        for mk in (percent(eu27_request), wb12_request):
            req, names = mk()
            composed, facts, _ = draw_all(self, req, names, ["movers", "overtake"])
            title = json.dumps(composed["title"], ensure_ascii=False)   # the lead section's headline is the page's
            big = composed["leaves"]["change_dots"]["accent"][0]
            up = facts["mv_dbig"]["v"] > 0
            self.assertIn("升到" if up else "降到", title, mk)
            self.assertIn("升得最多" if up else "降得最多", title, mk)
            self.assertNotIn("变到", title, mk)
            self.assertIn(big, title, mk)
            seen.add(up)
        self.assertEqual(seen, {True, False})   # one shape's biggest mover rose, the other's fell


def with_whole(mk, whole, name, scale=None):
    """A shape's request given a whole series: `scale` times the members' simple mean each year (None: the members' mean itself)."""
    def go(*a):
        req, names = mk(*a)
        main, by = req["main"], req["main"]["by"]
        mine = [r for r in req["rows"] if r["table"] == main["table"] and r["dims"][by] != main.get("whole")]
        years = sorted({r["time"] for r in mine})
        rows = [r for r in req["rows"] if not (r["table"] == main["table"] and r["dims"][by] == main.get("whole"))]
        for y in years:
            vs = [float(r["value"]) for r in mine if r["time"] == y]
            v = sum(vs) / len(vs) * (scale or 1.0)
            rows.append({**row(main["table"], main.get("filter", {}), by, whole, int(y), v), "value": v})
        members = main.get("members") or sorted({r["dims"][by] for r in mine})
        return {**req, "rows": rows, "main": {**main, "whole": whole, "members": members}}, {**names, whole: name}
    return go


def flipped_eu27():
    """The twenty-seven with every path reversed (most fall) but one member that rises: the members' mean falls."""
    fl = {c: (b, a) for c, (a, b) in EU27.items()}
    fl[sorted(fl)[0]] = (5.0, 9.0)
    return eu27_request(fl)


class MoverNotesCompare(unittest.TestCase):
    """The movers section's notes on a Eurostat percent shape and a World Bank value shape. The whole's note sets the whole's change
    against the members' mean change: more or less the same way by N (op minus of the two sizes), or, when the mean went the other
    way, the mean's own change; the plain note where the gap prints 0. A mover's note whose members' mean went the other way says the
    mean's change the other way, never a multiple of it. Each stated number is recomputed from the rows."""

    def notes(self, mk):
        req, names = mk()
        composed, facts, _ = draw_all(self, req, names, ["movers", "overtake"])
        at = {}
        for r in req["rows"]:
            if r["table"] == req["main"]["table"]: at.setdefault(r["dims"][req["main"]["by"]], {})[r["time"]] = float(r["value"])
        y0, y1 = (composed["leaves"]["change_dots"]["periods"][i].split(":")[-1] for i in (0, 1))
        whole = req["main"].get("whole")
        ms = [c for c in at if c != whole]
        mch = sum(at[c][y1] - at[c][y0] for c in ms) / len(ms)
        words = {n["num"]: "".join(x.get("w", "") for x in n["text"]) for n in composed["leaves"]["change_dots"]["notes"]}
        srcs = {n["num"]: [x["src"][5:] for x in n["text"] if "src" in x] for n in composed["leaves"]["change_dots"]["notes"]}
        return composed, facts, at, (y0, y1), whole, mch, words, srcs

    def test_the_whole_is_set_against_the_members_mean_change(self):
        seen = set()
        for mk, want in ((percent(eu27_request), "less"), (with_whole(wb12_request, "WLD", "世界", 1.3), None),
                         (with_whole(lambda: percent(flipped_eu27)(), "EU27_2020", "欧盟", 1.0), "plain"),
                         (lambda: percent(flipped_eu27)(), "opp")):
            composed, facts, at, (y0, y1), whole, mch, words, srcs = self.notes(mk)
            w, wd = words["fact:mv_dw"], at[whole][y1] - at[whole][y0]
            if want == "plain":   # the whole is the members' mean: the gap prints 0, the old words stand
                self.assertEqual(w, re.sub(r"\{[^}]*\}", "", FN.WD.WORDS["story.note.mv.whole_up" if wd > 0 else "story.note.mv.whole_down"])); seen.add(want); continue
            self.assertIn("平均", w); self.assertTrue("比" in w or "反而" in w, w)
            if (wd > 0) != (mch > 0):
                self.assertIn("反而", w); self.assertAlmostEqual(facts[srcs["fact:mv_dw"][0]]["v"], abs(mch), places=6); seen.add("opp")
                continue
            gap = abs(wd) - abs(mch)
            self.assertIn("多" if gap > 0 else "少", w)
            self.assertAlmostEqual(facts["mv_gw"]["v"], abs(gap), places=6)
            self.assertAlmostEqual(facts[srcs["fact:mv_dw"][0]]["v"], abs(mch), places=6)
            self.assertEqual(composed["facts"]["mv_gw"]["op"], "minus")
            seen.add("more" if gap > 0 else "less")
        self.assertEqual(seen, {"less", "more", "plain", "opp"})

    def test_a_mover_whose_mean_went_the_other_way_gets_no_multiple(self):
        seen = set()
        for mk in (wb12_request, lambda: percent(flipped_eu27)(), percent(eu27_request)):
            composed, facts, at, (y0, y1), whole, mch, words, srcs = self.notes(mk)
            for num in ("fact:mv_do", "fact:mv_dl"):
                if num not in words: continue
                code = next(x["name"] for n in composed["leaves"]["change_dots"]["notes"] if n["num"] == num for x in n["text"] if "name" in x)
                up = at[code][y1] > at[code][y0]
                if up != (mch > 0):
                    self.assertNotIn("倍", words[num]); self.assertIn("反而", words[num]); self.assertIn("平均", words[num])
                    self.assertAlmostEqual(facts[srcs[num][0]]["v"], abs(mch), places=6)
                    seen.add("opp")
                else:
                    seen.add("same")
        self.assertEqual(seen, {"opp", "same"})



def blocks(composed):
    """The page's data blocks: the sections with a data leaf (not the numbers, the thesis or the notes)."""
    return [s_ for s_ in composed["sections"] if s_["layer"] not in DATA_OFF]


def eu27_whole_no_target(question=""):
    """The twenty-seven members and the whole, no target row: the line of the "which ones" finding is the whole's value."""
    req, names = eu27_plain(question, whole=True)
    req = {k: v for k, v in req.items() if k != "target"}
    return {**req, "rows": [r for r in req["rows"] if r["table"] != "targets"]}, names


class PageBlocks(unittest.TestCase):
    SHAPES = (lambda question="": eu27_plain(question, whole=True), eu27_plain, wb24_request)

    def placed_shows(self, req, picks):
        """Every placed part's shows (the picks' own sections and their extra parts), as place_leaves leaves them."""
        _, cands, _ = FN.candidates(req)
        by_id = {c["id"]: c for c in cands}
        _, picks2, _ = FN.plan_arc(picks, cands)
        out, placed, why = FN.place_leaves(picks2, by_id, cands)
        return out, [p.get("shows") for i in out for p in [placed[i][0], *placed[i][1]]], why

    def test_same_question_compares_the_declarations_only(self):
        a = [{"measure": "t|k=v", "when": "2024", "shape": "rank"}]
        self.assertTrue(FN.same_question(a, [{"measure": "t|k=v", "when": "2024", "shape": "rank"}, {"measure": "t|k=v", "when": "2005-2024", "shape": "change"}]))
        for other in ({"measure": "t|k=v", "when": "2023", "shape": "rank"}, {"measure": "u", "when": "2024", "shape": "rank"},
                      {"measure": "t|k=v", "when": "2024", "shape": "map"}):
            self.assertFalse(FN.same_question(a, [other]), other)
        self.assertFalse(FN.same_question(None, a))
        with self.assertRaisesRegex(FN.Refused, "no shape"):
            FN.Req(eu27_plain()[0]).shows("2024", "a_chart_name")

    def test_one_ranking_a_page_on_two_shapes(self):
        """The members' ranking at the last year was drawn three times (rankbar, the unit grid of the rank and ends findings, the
        dot strip's later row): each block declares what it shows, and two that share an entry keep the first (the lead's)."""
        for mk in self.SHAPES:
            req, names = mk()
            for picks in (["rank", "movers", "ends"], ["ends", "rank", "overtake"], ["movers", "overtake", "rank"]):
                out, shows, _ = self.placed_shows(req, picks)
                for i, a in enumerate(shows):
                    for b in shows[i + 1:]: self.assertFalse(FN.same_question(a, b), (picks, a, b))
                composed, _, _ = draw_all(self, req, names, picks)
                layers = [s_["layer"] for s_ in blocks(composed)]
                self.assertIn("rankbar", layers, picks)
                self.assertNotIn("unit_grid", layers, picks)        # the rank's and the ends' grid show the rankbar's ranking
                self.assertNotIn("dot_strip", layers, picks)        # the strip shows the movers' change and the ranking again

    def test_the_lead_keeps_its_block_and_the_same_question_later_goes(self):
        for mk in self.SHAPES:
            req, names = mk(ASKED["none"])
            got = FN.compose({**req, "picks": ["below", "rank", "movers"]})
            ids = [s_["id"] for s_ in blocks(got)]
            self.assertEqual(ids[0], "below")
            self.assertNotIn("rank", ids)                       # its ranking is the lead's grid's question
            self.assertIn("rank dropped", got["arc"]["why"])
            self.assertGreaterEqual(len([i for i in ids if i in FN.ARC_OF]), 2)   # a page still tells two picks at least

    def test_at_most_five_blocks(self):
        import itertools
        for mk in self.SHAPES:
            req, _ = mk()
            ids = [c["id"] for c in FN.candidates(req)[1]]
            n = 0
            for picks in itertools.permutations(ids, 4):
                if n >= 60: break
                n += 1
                got = FN.compose({**req, "picks": list(picks)})
                self.assertLessEqual(len(blocks(got)), FN.MAX_BLOCKS, picks)
                self.assertGreaterEqual(len([s_ for s_ in blocks(got) if s_["id"] in FN.ARC_OF]), 2, picks)
            self.assertEqual(n, 60)

    def test_a_blank_unit_grid_is_not_drawn(self):
        """A grid none of whose glyphs is lit says nothing: it is not placed, and the page stands on its other blocks."""
        for mk in (eu27_plain, wb24_request):
            req, names = mk()
            _, cands, _ = FN.candidates(req)
            by_id = {c["id"]: c for c in cands}
            grid = next(m for m in by_id["ends"].get("more", []) if m["layer"] == "unit_grid")
            out, placed, _ = FN.place_leaves(["ends", "movers"], by_id, cands)
            self.assertIn("unit_grid", [m["layer"] for m in placed["ends"][1]], mk.__name__)
            grid["data"] = {**grid["data"], "members": [{**m, "flag": False} for m in grid["data"]["members"]]}
            self.assertTrue(FN.blank(grid))
            out, placed, _ = FN.place_leaves(["ends", "movers"], by_id, cands)
            self.assertEqual(out, ["ends", "movers"])
            self.assertNotIn("unit_grid", [m["layer"] for p in out for m in [placed[p][0], *placed[p][1]]])

    def test_a_crowded_strip_names_the_lead_findings_members_only(self):
        """A dot strip of more than twenty points (twenty-five members here) names only the members the lead finding is about; one
        of twenty or fewer keeps its own names."""
        few = {c: v for c, v in list(EU27.items())[:25]}
        for mk, crowded in ((lambda: eu27_request(few), True), (eu_request, False)):
            req, names = mk()
            ids = {c["id"] for c in FN.candidates(req)[1]}
            self.assertIn("overtake", ids)
            composed, _, drawn = draw_all(self, req, names, ["overtake", "pace"])
            strip = composed["leaves"].get("dot_strip")
            self.assertIsNotNone(strip, mk)
            lead = next(c for c in FN.candidates(req)[1] if c["id"] == "overtake")
            if crowded:
                self.assertEqual(len(strip["rows"]), 25)
                self.assertEqual(strip["lead"], FN.spaced(FN.Req(req), strip["rows"], lead["about"]))
                self.assertTrue(strip["lead"] and set(strip["lead"]) <= set(lead["about"]))
                self.assertEqual(composed["style"]["dot_strip"]["lead_set"], "given")
            else:
                self.assertLessEqual(len(strip["rows"]), FN.LABEL_ALL_MAX)
                self.assertEqual(strip["lead"], lead["data"]["accent"])   # its own pair (the riser and the faller)
            self.assertEqual(len(re.findall(r'data-leader="lead ', str(drawn["dot_strip"]))), len(strip["lead"]))
        # with the "which countries" finding leading, the groups' strip of twenty-seven names its members under the line
        req, names = eu27_plain(ASKED["none"])
        composed, _, drawn = draw_all(self, req, names, ["below", "groups"])
        below = next(c for c in FN.candidates(req)[1] if c["id"] == "below")
        strip = composed["leaves"]["dot_strip"]
        self.assertTrue(strip["lead"] and set(strip["lead"]) <= set(below["about"]), strip["lead"])
        self.assertEqual(strip["lead"][0], below["about"][0])   # the lowest member under the line is named first

    def test_which_countries_names_them_and_counts_them_from_facts(self):
        """A question that asks which countries (which countries ... are holding back) leads with the members under the line: their count a fact layer 1
        counts from the rows (op count under a line), their names the request's name rows, never typed; on three shapes (a target, a
        whole with no target, neither)."""
        kinds = set()
        for mk in (eu27_request, eu27_whole_no_target, eu27_plain, wb24_request):
            req, names = mk()
            req = {**req, "question": ASKED["none"]}
            _, cands, _ = FN.candidates(req)
            self.assertEqual(cands[0]["id"], "below", mk)
            self.assertTrue(cands[0]["why"]["asked"])
            composed, facts, drawn = draw_all(self, req, names, ["below", "ends"])
            q = composed["facts"]["bl_n"]
            self.assertEqual((q["op"], "b" in q), ("count", False))
            # the count recomputed from the rows: the members whose own value that year is under the line
            y = q["time"]
            at = {r["dims"][req["main"]["by"]]: float(r["value"]) for r in req["rows"] if r["table"] == req["main"]["table"] and r["time"] == y}
            members = req["main"].get("members") or sorted(at)
            under = sorted(c for c in members if at[c] < q["below"])
            self.assertEqual(facts["bl_n"]["v"], len(under))
            # the grid lights the same members, and the title names the lowest of them by their name rows
            grid = composed["leaves"]["unit_grid"]
            self.assertEqual(sorted(m["code"] for m in grid["members"] if m["flag"]), under)
            named = re.findall(r"\{name\.([A-Z0-9_]+)\}", composed["title"])
            lowest = sorted(under, key=lambda c: (at[c], c))[:FN.BELOW_NAMES]
            self.assertEqual([c for c in named if c in lowest], lowest)
            self.assertTrue(composed["title"].startswith("{bl_n} "), composed["title"])
            self.assertNotRegex(re.sub(r"\{[^}]+\}", "", composed["title"]), r"[0-9]")   # no number typed
            kinds.add(cands[0]["why"]["line"])
        self.assertEqual(kinds, {"goal", "whole", "mean"})
        # a question that does not ask which ones does not raise it
        for mk in (eu27_plain, wb24_request):
            req, _ = mk(ASKED["pace"])
            c = next(x for x in FN.candidates(req)[1] if x["id"] == "below")
            self.assertIsNone(c["why"]["asked"])


def accent_codes(svg):
    """The members a drawn svg marks in the accent: a shape filled or stroked with it (its data-code or data-join; a key's glyph is
    no member), and a text in it whose run is a name row."""
    codes = set()
    for tag in re.findall(r"<(?:rect|circle|line|path|polyline|polygon|g)\b[^>]*>", svg):
        m = re.search(r'data-(?:code|join)="([^"]+)"', tag)
        if m and not m[1].startswith("key-") and re.search(r'\b(?:fill|stroke)="var\(--accent\)"', tag): codes.add(m[1])
    for t in re.findall(r'<text\b[^>]*fill="var\(--accent\)"[^>]*>(.*?)</text>', svg, re.S):
        codes.update(re.findall(r'data-src="name:[^"]*:([^":]+)"', t))
    return codes


def colourless(svg):
    """A drawn svg with its colours, strokes' widths and opacities and the texts' weights taken out: what the accent does not touch."""
    return re.sub(r'\s(?:fill|stroke|stroke-width|stroke-opacity|fill-opacity|font-weight)="[^"]*"', "", svg)


class AccentIsWhatTheHeadlineNames(unittest.TestCase):
    """The page's legend says red is what a section's headline names: on a titled section a leaf that marks members (story.ACCENT_ONLY)
    draws in the accent only those its title names ({name.<code>}); the others it marked keep their labels, numbers, places and
    order in its plain look, and a section whose marks the headline names already is drawn as it was, byte for byte."""

    def draw(self, req, names, picks, sid):
        """(section, its leaf's svg as the composed data draws it, as the story page draws it, the codes the title names)."""
        composed = FN.compose({**req, "picks": picks})
        rows, _ = ledger(req, composed, names)
        K.setup(rows, names, run.tables)
        sec = next(s for s in composed["sections"] if s["id"] == sid)
        layer = sec["layer"]
        style = {layer: dict(composed.get("style", {}).get(layer, {}))}
        given = story.accent_only({"sections": composed["sections"], "hero": {"leaves": composed["leaves"]}})
        mod = __import__(layer)
        out = []
        for data in (composed["leaves"][layer], given[layer]):
            svg = mod.draw({"data": data, "style": style})
            out.append(svg[0] if isinstance(svg, tuple) else svg)
        self.assertEqual(composed["leaves"][layer].get("accent_only"), None)   # the composed data is not changed
        return sec, out[0], out[1], set(story.headline_names(sec["title"]))

    def narrowed(self, req, names, picks, sid, before, after):
        sec, old, new, named = self.draw(req, names, picks, sid)
        self.assertEqual(accent_codes(old), before, sid)                      # the shape: members the headline does not name in the accent
        self.assertEqual(accent_codes(new), after, sid)
        self.assertLessEqual(accent_codes(new), named, sid)
        self.assertEqual(accent_codes(new), accent_codes(old) & named, sid)   # the named ones keep it
        self.assertEqual(story.printed(new), story.printed(old), sid)         # the same numbers, names and periods, in the same order
        self.assertEqual(colourless(new), colourless(old), sid)               # nothing but the colours moves
        return old, new

    def test_the_movers_keep_the_accent_on_the_member_the_title_names(self):
        req, names = eu27_request()
        self.narrowed(req, names, ["movers", "overtake", "tiles"], "movers", {"DK", "RO"}, {"DK"})
        req, names = wb12_request()
        self.narrowed(req, names, ["movers", "overtake", "tiles"], "movers", {"USA", "CHN"}, {"USA"})

    def test_the_grid_keeps_the_accent_on_the_lit_members_the_title_names(self):
        req, names = wb12_request()
        _, new = self.narrowed(req, names, ["overtake", "below"], "below", {"BRA", "FRA", "GBR", "IDN", "IND", "ZAF"}, {"BRA", "FRA", "GBR", "IDN", "IND"})
        self.assertIn('data-code="ZAF" data-lit="1"', new)   # still lit, in ink

    def test_the_overtake_drops_the_accent_from_a_faller_the_title_does_not_name(self):
        """The title names the riser and the one it passed; the accent was on the riser and the one that fell most (another member)."""
        req, names = eu27_request()
        sec, *_ = self.draw(req, names, ["movers", "overtake", "tiles"], "overtake")
        self.assertEqual(set(story.headline_names(sec["title"])), {"DK", "LV"})
        sec, old, new, named = self.draw(req, names, ["movers", "overtake", "tiles"], "overtake")
        self.assertEqual(accent_codes(old), {"DK", "PL"})
        self.assertEqual(accent_codes(new), {"DK", "LV"})                    # the riser and the one it passed: both ends of the title's sentence
        self.assertEqual(accent_codes(new), named)
        self.assertIn(">波兰<", old); self.assertIn(">波兰<", new)          # the faller is still named by its rows

    def test_the_strip_leads_the_title_does_not_name_lose_the_accent_and_keep_their_labels(self):
        req, names = wb24_request()
        _, new = self.narrowed(req, names, ["overtake", "ends"], "overtake_dot_strip", {"CHN", "CHE", "NLD"}, set())
        for c in ("CHN", "CHE", "NLD"): self.assertIn(f'data-leader="lead {c}"', new)

    def test_a_rank_whose_title_names_both_ends_draws_both_in_the_accent(self):
        """"Highest ... lowest" in one headline: both rows are red (before, only the highest or the whole)."""
        for mk, picks in ((wb12_request, ["overtake", "rank"]), (wb24_request, ["overtake", "rank"]), (eu_request, ["path", "rank"])):
            req, names = mk()
            composed = FN.compose({**req, "picks": picks})
            sec = next(x for x in composed["sections"] if x["layer"] == "rankbar")
            named = set(story.headline_names(sec["title"]))
            rows = {r["code"] for r in composed["leaves"]["rankbar"]["rows"]}
            given = story.accent_only({"sections": composed["sections"], "hero": {"leaves": composed["leaves"]}})
            was = composed["leaves"]["rankbar"]["highlight"]
            self.assertGreater(len(named & rows), 1, mk.__name__)
            self.assertEqual(set(story.rank_style({"leaves": given})["rankbar"]["highlight_row"].split(",")), (named & rows) | {was}, mk.__name__)
            rows_, _ = ledger(req, composed, names)
            K.setup(rows_, names, run.tables)
            import rankbar
            svg = rankbar.draw({"data": given["rankbar"], "style": {"rankbar": story.rank_style({"leaves": given})["rankbar"]}})
            svg = svg[0] if isinstance(svg, tuple) else svg
            self.assertEqual(len(re.findall(r'<rect [^>]*fill="var\(--accent\)"', svg)), len((named & rows) | {was}), mk.__name__)   # a red bar each

    def test_a_slope_chart_draws_both_rows_its_title_names_in_the_accent(self):
        req, names = eu27_request()
        _, old, new, named = self.draw(req, names, ["movers", "overtake", "tiles"], "overtake")
        self.assertEqual(accent_codes(new), named)
        self.assertEqual(named, {"DK", "LV"})
        self.assertLessEqual(accent_codes(old) & named, accent_codes(new))

    def test_the_dot_strip_lead_limit_story_keeps_is_the_strips_own(self):
        import dot_strip
        self.assertEqual(story.DOT_LEAD_MAX, dot_strip.LEAD_MAX)
        data = {"rows": [{"code": c} for c in "ABCDEFGHIJKLMNOP"], "lead": list("ABCDEFGHIJKL")}
        spec = {"sections": [{"id": "s", "layer": "dot_strip", "title": "x {name.M} {name.N}"}], "hero": {"leaves": {"dot_strip": data}}}
        self.assertEqual(story.accent_only(spec)["dot_strip"]["lead"], list("ABCDEFGHIJKL"))   # the limit stays: the findings' list stands
        spec["hero"]["leaves"]["dot_strip"] = {**data, "lead": list("ABC")}
        got = story.accent_only(spec)["dot_strip"]
        self.assertEqual((got["lead"], got["accent_only"]), (list("ABCMN"), ["M", "N"]))        # a named row of the strip is led and in the accent

    def marks_of(self, svg, code, name):
        """Every element of a drawn svg that is the member's: its shapes and joins (data-code, data-join), its leaders (data-leader),
        and each <text> that prints its name."""
        own = re.findall(rf'<(?:rect|circle|line|path|polyline|polygon|g)\b[^>]*data-(?:code|join|leader)="(?:lead )?{code}"[^>]*>', svg)
        texts = [t for t in re.findall(r"<text\b[^>]*>.*?</text>", svg, re.S) if f">{name}<" in t]
        return own, texts

    def test_a_member_out_of_the_accent_keeps_its_label_leader_and_mark_in_the_plain_colour(self):
        """The leaves that keep their marked list (story.ACCENT_ONLY), where a narrowed list would drop a label, a leader or a lit
        glyph: the member taken out of the accent has the same shapes, leader and name texts before and after, only their colours,
        widths, opacities and weights differ, and none is in the accent after."""
        for mk, picks, sid, code, kinds in ((wb24_request, ["overtake", "ends"], "overtake_dot_strip", "CHE", ("circle", "line", "text")),
                                            (eu27_request, ["movers", "overtake", "tiles"], "overtake", "PL", ("line", "circle", "text")),
                                            (wb12_request, ["overtake", "below"], "below", "ZAF", ("rect", "text"))):
            req, names = mk()
            sec, old, new, named = self.draw(req, names, picks, sid)
            self.assertIn(sec["layer"], story.ACCENT_ONLY)
            self.assertNotIn(code, named)
            o_own, o_txt = self.marks_of(old, code, names[code])
            n_own, n_txt = self.marks_of(new, code, names[code])
            for k in kinds: self.assertTrue(any(x.startswith(f"<{k}") for x in o_own + o_txt), (sid, k))
            if sec["layer"] == "dot_strip": self.assertTrue(any("data-leader" in x for x in n_own), sid)   # its leader is still drawn
            # a slope chart gives a member the headline names a label of its own, so the chart's board and the dots move a little: its shapes are compared without their places
            flat = (lambda x: re.sub(r' (cx|cy|x|y|x1|x2|y1|y2|d|points|transform)="[^"]*"', "", colourless(x))) if sec["layer"] == "rank_slope" else colourless
            self.assertEqual([flat(x) for x in n_own], [flat(x) for x in o_own], sid)
            self.assertEqual([flat(x) for x in n_txt], [flat(x) for x in o_txt], sid)
            self.assertTrue(any("var(--accent)" in x for x in o_own + o_txt), sid)
            self.assertFalse(any("var(--accent)" in x for x in n_own + n_txt), sid)

    def test_a_section_whose_marks_the_title_names_is_drawn_as_it_was(self):
        for mk, picks, sid in ((eu_request, ["movers", "overtake"], "overtake"), (wb24_request, ["groups", "rank"], "groups_dot_strip"),
                               (wb12_request, ["overtake", "members"], "members")):
            req, names = mk()
            sec, old, new, named = self.draw(req, names, picks, sid)
            self.assertTrue(accent_codes(old) and accent_codes(old) <= named, (sid, accent_codes(old), named))
            self.assertEqual(new, old, sid)

    def test_no_section_of_any_two_picks_draws_in_the_accent_a_member_its_title_does_not_name(self):
        """Every ordered pair of candidates on four shapes, each titled section that marks members: its accent is within its title's names."""
        n = 0
        for mk in (eu_request, wb_request, eu27_request, wb24_request):
            req, names = mk()
            ids = [c["id"] for c in FN.candidates(req)[1]]
            for a in ids:
                for b in ids:
                    if a == b: continue
                    try: composed = FN.compose({**req, "picks": [a, b]})
                    except FN.Refused: continue
                    rows, _ = ledger(req, composed, names)
                    K.setup(rows, names, run.tables)
                    given = story.accent_only({"sections": composed["sections"], "hero": {"leaves": composed["leaves"]}})
                    for s in composed["sections"]:
                        if s["layer"] not in story.ACCENT_ONLY + story.ACCENT_DATA or not s.get("title"): continue
                        svg = __import__(s["layer"]).draw({"data": given[s["layer"]], "style": {s["layer"]: dict(composed.get("style", {}).get(s["layer"], {}))}})
                        svg = svg[0] if isinstance(svg, tuple) else svg
                        self.assertLessEqual(accent_codes(svg), set(story.headline_names(s["title"])), (mk.__name__, a, b, s["id"]))
                        n += 1
        self.assertGreater(n, 50)

    def test_the_page_child_draws_each_section_s_accent_within_its_h2_names(self):
        """Through the real child (run.py): each titled section's svg on the page marks in the accent only members its h2 names by
        their name rows; the grid's legend swatch is ink when a lit glyph its headline does not name is drawn in ink."""
        for mk, picks in ((eu27_request, ["movers", "overtake", "tiles"]), (wb12_request, ["below", "overtake", "members"])):
            req, names = mk()
            composed, _, _, page_html = Findings._page(self, req, names, picks)
            n = 0
            for sid, body in re.findall(r'<section class="sec" data-id="([a-z0-9_]+)"[^>]*>(.*?)</section>', page_html, re.S):
                h2 = re.search(r"<h2\b[^>]*>(.*?)</h2>", body, re.S)
                svg = re.search(r"<svg\b.*?</svg>", body, re.S)
                if not h2 or not svg: continue
                named = set(re.findall(r'data-src="name:[^"]*:([^":]+)"', h2[1]))
                self.assertLessEqual(accent_codes(svg[0]), named, (mk.__name__, sid))
                n += 1
            self.assertGreaterEqual(n, 3, mk.__name__)
            if "unit_grid" in composed["leaves"]:
                self.assertIn('<span class="sw ink"></span><span data-word="grid.legend">', page_html)


class NotesStandAgainstAReference(unittest.TestCase):
    """A short note that only gave a last value ("the best trend's member, its last value") says where that value stands against a
    reference row of the page: a percent measure by the gap in percentage points (op minus), any other unit by the multiple (op times);
    every number a fact; with no reference row, or where the two print alike, the note stays as it was."""

    def pct(self, req):
        defs = {**req["fmt_defs"], "x": {"scale": 1, "dec": 1, "suffix": "%"}, "pp": {"scale": 1, "dec": 1, "suffix": " 个百分点"}}
        return {**req, "fmt_defs": defs, "fmts": {**req["fmts"], "delta": "pp"}}

    def notes(self, req, picks, sid, names=None):
        """(the composed page, the evaluated facts, the notes of section `sid`)."""
        composed = FN.compose({**req, "picks": picks})
        sec = next(x for x in composed["sections"] if x["id"] == sid)
        _, facts = ledger(req, composed, names or EU_NAMES)
        return composed, facts, composed["leaves"][sec["layer"]]["notes"]

    def words(self, note):
        return "".join(x.get("w", "") for x in note["text"])

    def test_the_members_notes_say_the_gap_in_points_on_a_percent_measure(self):
        req, _ = eu_request()
        composed, facts, notes = self.notes(self.pct(req), ["path", "members"], "members")
        self.assertEqual(composed["facts"]["sm_w"].get("op", "value"), "value")   # a whole row: the reference is the whole, not the mean
        self.assertEqual(len(notes), 2)
        for n, who in zip(notes, ("sm_se", "sm_mt")):
            self.assertEqual(n["num"], f"fact:{who}")
            src = [x["src"] for x in n["text"] if "src" in x]
            self.assertEqual(src[0], "fact:sm_w"); name = src[1][5:]
            f = facts[name]
            self.assertEqual((composed["facts"][name]["op"], composed["facts"][name]["fmt"]), ("minus", "pp"))
            self.assertAlmostEqual(f["v"], abs(facts[who]["v"] - facts["sm_w"]["v"]), places=6)
            self.assertGreater(f["v"], 0)
            self.assertTrue(self.words(n).endswith("高 ") or self.words(n).endswith("低 "), self.words(n))
            self.assertEqual("高" if facts[who]["v"] > facts["sm_w"]["v"] else "低", self.words(n)[-2])

    def test_the_members_notes_say_the_multiple_on_any_other_unit(self):
        req, _ = eu_request()
        composed, facts, notes = self.notes(req, ["path", "members"], "members")
        for n, who in zip(notes, ("sm_se", "sm_mt")):
            name = [x["src"] for x in n["text"] if "src" in x][1][5:]
            f = facts[name]
            self.assertEqual((composed["facts"][name]["op"], composed["facts"][name]["fmt"]), ("times", "times"))
            big, small = sorted((facts[who]["v"], facts["sm_w"]["v"]), reverse=True)
            self.assertAlmostEqual(f["v"], big / small, places=6)
            self.assertGreater(f["v"], 1)
            self.assertTrue(self.words(n).endswith(" 倍"), self.words(n))
            # the larger is the one the sentence starts from: the member itself, else the reference ("... is it N times")
            self.assertEqual(facts[who]["v"] > facts["sm_w"]["v"], "是它的" not in self.words(n))

    def test_with_no_whole_the_notes_stand_against_the_members_simple_mean(self):
        req, _ = wb_request()
        for r, op in ((req, "times"), (self.pct(req), "minus")):
            composed, facts, notes = self.notes(r, ["members", "spread"], "members", WB_NAMES)
            ref = composed["facts"]["sm_w"]
            self.assertEqual(ref["op"], "mean")
            codes = ref["filter"]["country"]
            self.assertGreaterEqual(len(codes), 3)
            self.assertEqual(len(notes), 2)
            for n in notes:
                self.assertEqual(self.words(n).count("各国平均（不加权"), 1, self.words(n))     # named for what it is, never the whole or the EU
                self.assertFalse({"欧盟", "整体"} & {x.get("name") for x in n["text"]} | ({"欧盟", "整体"} if "整体" in self.words(n) else set()))
                srcs = [x["src"] for x in n["text"] if "src" in x]
                self.assertEqual(srcs[0], "fact:sm_w")
                self.assertEqual(composed["facts"][srcs[1][5:]]["op"], op)
                self.assertEqual(composed["facts"][srcs[1][5:]]["b" if op == "minus" else "b"] in ("sm_w",) or composed["facts"][srcs[1][5:]]["a"] == "sm_w", True)

    def test_a_gap_between_two_percentages_is_in_points_on_the_rank(self):
        for mk, picks in ((wb12_request, ["overtake", "rank"]), (eu_request, ["path", "rank"])):
            req, names = mk()
            for r, want in ((self.pct(req), "pp"), (req, req["fmts"]["value"])):
                composed = FN.compose({**req, **r, "picks": picks})
                gaps = {k: v for k, v in composed["facts"].items() if k.startswith("g_")}
                self.assertTrue(gaps, mk.__name__)
                self.assertEqual({v["fmt"] for v in gaps.values()}, {want}, mk.__name__)

    def test_the_rank_column_of_a_percent_gap_is_the_number_alone_under_a_head_in_points(self):
        import rankbar
        for mk, picks in ((wb12_request, ["overtake", "rank"]), (eu_request, ["path", "rank"])):
            req, names = mk()
            for r, pct in ((self.pct(req), True), (req, False)):
                composed = FN.compose({**req, **r, "picks": picks})
                data = composed["leaves"]["rankbar"]
                head = "".join(x.get("w", "") for x in data["share_head"])
                self.assertEqual(head.endswith("（个百分点）"), pct, (mk.__name__, head))
                cells = {x["code"]: x for x in data["rows"]}
                self.assertEqual({x["share_text"].endswith(".n") for x in cells.values()}, {pct})
                self.assertEqual([c for c, x in cells.items() if x.get("share_none")], [data["highlight"]])   # the row the column is measured from has no cell
                rows_, _ = ledger({**req, **r}, composed, names)
                K.setup(rows_, names, run.tables)
                svg = rankbar.draw({"data": data, "style": {"rankbar": {"highlight_row": data["highlight"]}}})
                svg = svg[0] if isinstance(svg, tuple) else svg
                shares = re.findall(r'data-src="fact:g_([a-z0-9_]+?)(?:\.n)?"', svg)
                self.assertEqual(len(shares), len(cells) - 1)
                self.assertNotIn(f"g_{data['highlight'].lower()}", shares)

    def test_the_overtake_notes_name_the_ranks_it_started_and_ended_on(self):
        req, names = eu27_request()
        composed, facts, notes = self.notes(req, ["movers", "overtake", "tiles"], "overtake", names)
        got = {n["num"]: n for n in notes}
        for num, verb in (("fact:ot_fall", "掉到"), ("fact:ot_rise", "升到")):
            n = got[num]
            srcs = [x["src"] for x in n["text"] if "src" in x]
            words = self.words(n)
            self.assertIn(f"从第 ", words); self.assertIn(verb, words)
            a, b = (composed["facts"][x[5:]] for x in srcs[:2])   # a third, the multiple of the average move, when the note has one (ChangeNotes)
            self.assertEqual(srcs[2:], [f"fact:k_{num[5:]}"] if len(srcs) > 2 else [])
            self.assertEqual((a["op"], b["op"]), ("position", "position"))          # the ranks are the position facts the rows print
            self.assertEqual(sorted({a["time"], b["time"]}), sorted({composed["facts"][srcs[0][5:]]["time"], composed["facts"][srcs[1][5:]]["time"]}))
            diff = facts[num[5:]]["v"]
            self.assertEqual(abs(facts[srcs[0][5:]]["v"] - facts[srcs[1][5:]]["v"]), abs(diff))   # the note's own number is the gap of the two ranks it names

    def test_a_gap_that_prints_as_nothing_keeps_the_plain_note(self):
        req, _ = eu_request()
        req = self.pct(req)
        last = max(r["time"] for r in req["rows"] if r["dims"].get("geo") == "SE" and r["table"] == req["main"]["table"])
        # the whole's last value is the best member's, to the printed place
        top = next(r["value"] for r in req["rows"] if r["dims"].get("geo") == "SE" and r["time"] == last and r["table"] == req["main"]["table"])
        rows = [dict(r, value=top) if r["dims"].get("geo") == "EU27_2020" and r["time"] == last and r["table"] == req["main"]["table"] else r for r in req["rows"]]
        composed, _, notes = self.notes({**req, "rows": rows}, ["members", "rank"], "members")
        self.assertEqual(self.words(notes[0]), "走势最好的，末年的值")
        self.assertNotIn("vs_hi", composed["facts"])

    def stands_against_the_lowest(self, req, names, picks, sid, word, key, both):
        composed, facts, notes = self.notes(req, picks, sid, names)
        hit = [n for n in notes if word in self.words(n)]
        self.assertEqual(len(hit), 1, [self.words(n) for n in notes])
        self.assertIn("最低的", self.words(hit[0]))
        f = composed["facts"][key]
        self.assertIn(f["op"], ("minus", "times"))
        self.assertGreater(facts[key]["v"], 0 if f["op"] == "minus" else 1)
        self.assertEqual(f["op"], "minus" if both else "times")

    def test_the_map_note_stands_against_the_lowest(self):
        req, names = eu_chain_request()
        req = {**req, "points": {c: list(geo.PT[c]) for c in EU_MEMBERS}}
        self.stands_against_the_lowest(req, names, ["map", "rank"], "map", "第二高的", "vs_second", False)
        self.stands_against_the_lowest(self.pct(req), names, ["map", "rank"], "map", "第二高的", "vs_second", True)

    def test_the_tile_note_stands_against_the_lowest(self):
        req, names = eu27_request()
        self.stands_against_the_lowest(req, names, ["path", "tiles"], "tiles", "整体的值", "vs_whole", False)
        self.stands_against_the_lowest(self.pct(req), names, ["path", "tiles"], "tiles", "整体的值", "vs_whole", True)


class ClosingSpeaksOfRanksOnlyWithRanks(unittest.TestCase):
    """The lagging arc's closing line says "ranks only tell this year's place": a page with no section of ranks (the rank bar, the
    overtake slope) says the same of the levels; a page with one keeps the line about ranks. On two data shapes."""

    def end(self, mk, picks):
        req, names = mk()
        return FN.compose({**req, "picks": picks})

    def test_the_closing_line_follows_the_sections(self):
        for mk in (eu27_plain, wb24_request):
            for picks, ranked in ((["below", "ends", "movers"], False), (["ends", "groups", "movers"], False), (["rank", "ends", "movers"], True),
                                  (["ends", "overtake", "movers"], True)):
                composed = self.end(mk, picks)
                self.assertEqual(composed["arc"]["id"], "lagging", (mk.__name__, picks))
                want = FN.WD.WORDS["story.end.lagging" if ranked else "story.end.lagging_level"]
                self.assertEqual(re.sub(r"\{[^}]*\}", "", composed["end"]), want, (mk.__name__, picks))
                self.assertEqual("名次" in composed["end"], ranked, (mk.__name__, picks))


class NoNoteSaysItTwice(unittest.TestCase):
    """The same note (the same number, by what it computes, and the same words) stands once on the page, in the first section that has it:
    the highest over the lowest is said by the two-ends section and again by the map's range; the later one goes. A note that differs stays."""

    def notes(self, req, picks):
        c = FN.compose({**req, "picks": picks})
        return {l: [n["num"] for n in d.get("notes", [])] for l, d in c["leaves"].items() if isinstance(d, dict) and d.get("notes")}

    def test_the_ends_note_is_not_said_again_by_the_map(self):
        from test_story_findings import eu27_request
        for mk in (eu27_plain, lambda: eu27_plain(whole=True), eu27_request):
            req, _ = mk()
            both = self.notes(req, ["below", "ends", "map"])
            self.assertIn("fact:d_hl", both["pair_bars"])
            self.assertNotIn("fact:mrange", both["member_map"])      # the map's range is the ends' difference in the same words
            self.assertIn("fact:mp_fi", both["member_map"])          # the map's other note says something else and stays
            one = self.notes(req, ["below", "map", "movers"])
            self.assertIn("fact:mrange", one["member_map"])          # with no ends section before it the map's note stands

    def test_no_two_notes_of_a_page_say_the_same(self):
        for mk in (eu27_plain, lambda: eu27_plain(whole=True), eu_request, wb24_request):
            req, _ = mk()
            for picks in (["below", "ends", "map"], ["ends", "rank", "movers"], ["rank", "ends", "tiles"], ["ends", "members", "overtake"]):
                try: composed = FN.compose({**req, "picks": picks})
                except FN.Refused: continue
                nums = [n["num"] for d in composed["leaves"].values() if isinstance(d, dict) for n in d.get("notes", [])]
                self.assertEqual(len(nums), len(set(nums)), (picks, nums))


class UnitNameHoldsADigit(unittest.TestCase):
    """A unit whose short name holds a digit (a chain-linked volume's base year) comes to the child as the unit table's name entry
    (words.unit_src), never as typed words: every leaf that prints the unit prints that entry, marked with its src, and no digit is
    left in a word. A digit in the unit words with no such entry is still refused."""

    SRC = "name:unit_short_zh:CLV20_EUR_HAB"
    NAME = "欧元/人（2020年不变价）"

    def req(self):
        req, names = eu27_plain(whole=True)
        return {**req, "words": {"measure": "人均国内生产总值", "unit": self.NAME, "unit_src": self.SRC}}, names

    def test_a_digit_in_the_unit_words_alone_is_refused(self):
        req, _ = self.req()
        with self.assertRaisesRegex(FN.Refused, "digit"):
            FN.candidates({**req, "words": {"measure": "人均国内生产总值", "unit": self.NAME}})
        with self.assertRaisesRegex(FN.Refused, "digit"):
            FN.candidates({**req, "words": {"measure": "前20国", "unit": "欧元/人", "unit_src": self.SRC}})
        with self.assertRaisesRegex(FN.Refused, "name:unit_short_zh"):
            FN.candidates({**req, "words": {"measure": "人均国内生产总值", "unit": "欧元/人", "unit_src": "fact:a.n"}})

    def test_every_leaf_prints_the_unit_as_the_name_entry(self):
        req, names = self.req()
        seen = 0
        for picks in (["rank", "movers", "ends"], ["ends", "rank", "overtake"], ["path", "members", "below"]):
            try:
                composed, _, drawn = draw_all(self, req, names, picks, extra=[{"src": self.SRC, "text": self.NAME}])
            except FN.Refused:
                continue
            for layer, data in composed["leaves"].items():
                if isinstance(data, dict) and "unit" in data:
                    self.assertEqual(data["unit"], [{"src": self.SRC}], layer)
                    self.assertIn(f'data-src="{self.SRC}"', str(drawn[layer]), layer)
                    seen += 1
        self.assertGreater(seen, 3)

    def test_a_unit_with_no_digit_still_goes_as_words(self):
        req, names = eu27_plain(whole=True)
        composed, _, _ = draw_all(self, req, names, ["rank", "movers", "ends"])
        units = [d["unit"] for d in composed["leaves"].values() if isinstance(d, dict) and "unit" in d]
        self.assertTrue(units and all(u == [{"w": req["words"]["unit"]}] for u in units), units)
# ---------------------------------------------------------------- the change notes against the members' average change

def linear_request(table, by, ends, y0, y1, whole=None, fixed=None, text=False):
    """A request whose places go in a straight line from their first value to their last (test-only values, no noise): ends is
    {code: (first, last)}; `text` gives the values as the source's decimal text (the World Bank shape)."""
    fixed = fixed or {}
    rows = []
    for c, (a, b) in ends.items():
        for y in range(y0, y1 + 1):
            v = round(a + (b - a) * (y - y0) / (y1 - y0), 6)
            r = row(table, fixed, by, c, y, v)
            rows.append({**r, "value": f"{v:.2f}"} if text else r)
    main = {"table": table, "by": by, "filter": fixed, **({"whole": whole} if whole else {})}
    if whole: main["members"] = [c for c in ends if c != whole]
    return {"rows": rows, "main": main, "fmts": FMTS, "fmt_defs": FMT_DEFS, "words": {"measure": "人均二氧化碳排放", "unit": "吨／人"}}


WB_T = "EN.GHG.CO2.PC.CE.AR5"
# most rose (the mean change is above 0): the far end of the order fell (no multiple of an average that rose), the member that led at the
# start rose more than the average (the multiple of it)
WB_MOST_ROSE = {"USA": (16.0, 17.0), "CHN": (5.0, 9.0), "IND": (1.0, 2.0), "BRA": (2.0, 2.5), "IDN": (1.5, 2.6), "DEU": (10.0, 8.0),
                "JPN": (9.0, 9.5), "ZAF": (8.0, 7.5)}
# one fell far, the rest rose and the mean rose: the far end is the one that rose most
WB_ONE_FELL = {"USA": (20.0, 10.0), "CHN": (5.0, 9.0), "IND": (1.0, 2.0), "BRA": (2.0, 2.5), "IDN": (1.5, 2.6), "JPN": (9.0, 9.5),
               "DEU": (8.0, 10.0), "ZAF": (6.0, 9.0)}
# the changes sum to 0: the mean did not move
WB_FLAT_MEAN = {"USA": (17.0, 18.0), "DEU": (9.0, 8.0), "CHN": (6.0, 8.0), "IND": (4.0, 2.0), "BRA": (2.5, 3.0), "ZAF": (8.5, 8.0)}
WB_NAMES_ALL = {**WB12_NAMES, "IDN": "印度尼西亚"}


class ChangeNotes(unittest.TestCase):
    """The change notes (spread, movers, overtake) say how many times the members' average change the mover's change is, from facts:
    the average a mean fact over the same members (the mean at the last year less the mean at the first; the rank's, the places' moves
    summed over the bottom place's rank), the multiple a times fact; with no average to stand on (fewer than three members, a mean of 0,
    one that went the other way) the note is the old sentence byte for byte and declares no fact for it."""

    def notes(self, req, picks, sid, names):
        composed = FN.compose({**req, "picks": picks})
        sec = next(x for x in composed["sections"] if x["id"] == sid)
        _, facts = ledger(req, composed, names)
        return composed, facts, {n["num"][5:]: n for n in composed["leaves"][sec["layer"]]["notes"]}

    def words(self, note):
        return "".join(x.get("w", "") for x in note["text"])

    def at(self, req, code, year):
        return next(float(r["value"]) for r in req["rows"] if r["dims"].get(req["main"]["by"]) == code and r["time"] == str(year) and r["table"] == req["main"]["table"])

    def has_k(self, note, num, facts, want):
        """The note ends with its multiple, the fact k_<num> (op times), worth `want`."""
        srcs = [x["src"] for x in note["text"] if "src" in x]
        self.assertEqual(srcs[-1], f"fact:k_{num}", self.words(note))
        self.assertTrue(self.words(note).endswith(" 倍"), self.words(note))
        self.assertAlmostEqual(facts[f"k_{num}"]["v"], want, places=6)

    def test_the_rank_notes_are_set_against_the_average_rank_move_on_a_percent_shape(self):
        for req, names in (eu27_request(), (NotesStandAgainstAReference.pct(None, eu27_request()[0]), EU27_NAMES)):
            composed, facts, notes = self.notes(req, ["movers", "overtake", "tiles"], "overtake", names)
            places = [*EU27, "EU27_2020"]
            v0, v1 = ({c: self.at(req, c, y) for c in places} for y in (2005, 2024))
            rank = lambda v: {c: 1 + sum(1 for w in v.values() if w > v[c]) for c in v}
            r0, r1 = rank(v0), rank(v1)
            move = sum(abs(r0[c] - r1[c]) for c in places) / len(places)   # the average rank move, every place of the slope (the whole among them)
            for num, word in (("ot_fall", "story.note.ot.fall_ref"), ("ot_rise", "story.note.ot.rise_ref")):
                n = notes[num]
                self.assertEqual(n["text"], FN.ST(word, c=next(x["name"] for x in n["text"] if "name" in x), a=n["text"][3]["src"][5:], b=n["text"][5]["src"][5:], k=f"k_{num}"))
                self.assertTrue(self.words(n).endswith("，是平均名次变动的  倍"), self.words(n))
                self.has_k(n, num, facts, facts[num]["v"] / move)
                self.assertGreater(facts[f"k_{num}"]["v"], 1)
            # the average is the summed moves over a position fact worth the number of places (the bottom place's rank), no count of places
            avg = composed["facts"]["ot_avg"]
            self.assertEqual(avg["op"], "times"); self.assertEqual(composed["facts"][avg["b"]]["op"], "position")
            self.assertEqual(facts[avg["b"]]["v"], len(places))
            self.assertEqual({q.get("op") for q in composed["facts"].values()} & {"n", "count"}, set())
            self.assertAlmostEqual(facts["ot_avg"]["v"], move, places=9)

    def test_the_value_notes_are_set_against_the_average_change_on_a_world_bank_shape(self):
        # the spread: the mean fell, so the one that fell most is set against it and the one that rose most keeps its old words
        req, names = wb_request()
        composed, facts, notes = self.notes(req, ["spread", "ends"], "spread", names)
        ch = {c: self.at(req, c, 2022) - self.at(req, c, 2010) for c in WB}
        mean = sum(ch.values()) / len(ch)
        self.assertLess(mean, 0)
        self.assertEqual(notes["d_usa"]["text"], FN.ST("story.note.spread.fall_ref", c="USA", k="k_d_usa"))
        self.has_k(notes["d_usa"], "d_usa", facts, ch["USA"] / mean)
        self.assertEqual(composed["facts"]["sp_mch"], {"op": "minus", "a": "sp_m1", "b": "sp_m0", "fmt": "x"})
        self.assertEqual((composed["facts"]["sp_m0"]["op"], composed["facts"]["sp_m0"]["filter"]["country"]), ("mean", sorted(WB)))
        self.assertEqual(notes["d_chn"], FN.note("d_chn", "story.note.spread.rise_opp", c="CHN", m="sp_mdn"))   # opposite sign: the mean fell
        self.assertAlmostEqual(facts["sp_mdn"]["v"], -mean, places=9)
        self.assertNotIn("k_d_chn", composed["facts"])
        # the movers: the far end fell while the mean rose (no multiple: the note says the mean rose, by its own change); the member
        # that led at the start rose more than the mean
        req = linear_request(WB_T, "country", WB_MOST_ROSE, 2010, 2022, text=True)
        composed, facts, notes = self.notes(req, ["movers", "ends"], "movers", WB_NAMES_ALL)
        ch = {c: b - a for c, (a, b) in WB_MOST_ROSE.items()}; mean = sum(ch.values()) / len(ch)
        self.assertEqual(notes["mv_do"], FN.note("mv_do", "story.note.mv.down_most_opp", c="DEU", m="mv_mup"))
        self.assertAlmostEqual(facts["mv_mup"]["v"], mean, places=9)
        self.assertNotIn("k_mv_do", composed["facts"])
        self.assertEqual(notes["mv_dl"]["text"], FN.ST("story.note.mv.lead_up_ref", c="USA", k="k_mv_dl"))
        self.has_k(notes["mv_dl"], "mv_dl", facts, ch["USA"] / mean)
        self.assertEqual(composed["facts"]["k_mv_dl"], {"op": "times", "a": "mv_dl", "b": "mv_mup", "fmt": "times"})
        # one fell far and the mean rose: the one that rose most, k times the mean rise
        req = linear_request(WB_T, "country", WB_ONE_FELL, 2010, 2022, text=True)
        composed, facts, notes = self.notes(req, ["movers", "ends"], "movers", WB_NAMES_ALL)
        ch = {c: b - a for c, (a, b) in WB_ONE_FELL.items()}; mean = sum(ch.values()) / len(ch)
        self.assertEqual(notes["mv_do"]["text"], FN.ST("story.note.mv.up_most_ref", c="CHN", k="k_mv_do"))
        self.has_k(notes["mv_do"], "mv_do", facts, ch["CHN"] / mean)

    def test_the_smallest_mover_says_the_average_is_k_times_it(self):
        """All rose: the far end rose least, and the larger (the average) is the one said to be N times (the level notes' rule)."""
        req, names = eu27_request()
        composed, facts, notes = self.notes(req, ["movers", "tiles"], "movers", names)
        ch = {c: self.at(req, c, 2024) - self.at(req, c, 2005) for c in EU27}; mean = sum(ch.values()) / len(ch)
        lo = min(ch, key=lambda c: (ch[c], c))
        self.assertEqual(notes["mv_do"]["text"], FN.ST("story.note.mv.up_least_ref_lo", c=lo, k="k_mv_do"))
        self.has_k(notes["mv_do"], "mv_do", facts, mean / ch[lo])
        self.assertEqual(composed["facts"]["k_mv_do"], {"op": "times", "a": "mv_mup", "b": "mv_do", "fmt": "times"})

    def test_a_spread_end_whose_mean_went_the_other_way_says_so(self):
        """The spread's rise and fall notes when the members' mean change went the other way: no multiple, the mean's own change that
        way (sp_mch when it rose, sp_mdn when it fell), recomputed from the rows; on a World Bank value shape (the mean rose, the
        biggest fall is told) and a Eurostat percent shape (the mean fell, the biggest rise is told)."""
        fell = {"AA": (50.0, 40.0), "BB": (45.0, 48.0), "CC": (40.0, 30.0), "DD": (35.0, 25.0), "EE": (30.0, 33.0), "FF": (20.0, 12.0), "GG": (10.0, 11.0)}
        names = {"AA": "甲", "BB": "乙", "CC": "丙", "DD": "丁", "EE": "戊", "FF": "己", "GG": "庚"}
        seen = set()
        for req, nm, y0, y1 in ((linear_request(WB_T, "country", WB_MOST_ROSE, 2010, 2022, text=True), WB_NAMES_ALL, 2010, 2022),
                                (NotesStandAgainstAReference.pct(None, linear_request("nrg_ind_ren", "geo", fell, 2005, 2024, fixed={"nrg_bal": "REN"})), names, 2005, 2024)):
            composed, facts, notes = self.notes(req, ["spread", "ends"], "spread", nm)
            codes = {r["dims"][req["main"]["by"]] for r in req["rows"]}
            ch = {c: self.at(req, c, y1) - self.at(req, c, y0) for c in codes}
            mean = sum(ch.values()) / len(ch)
            for num, n in notes.items():
                c = num[2:].upper()
                if ch[c] * mean >= 0: continue
                self.assertNotIn("倍", self.words(n), num); self.assertIn("反而", self.words(n), num); self.assertIn("平均", self.words(n), num)
                m = "sp_mch" if mean > 0 else "sp_mdn"
                self.assertEqual(n, FN.note(num, "story.note.spread.rise_opp" if ch[c] > 0 else "story.note.spread.fall_opp", c=c, m=m))
                self.assertAlmostEqual(facts[m]["v"], abs(mean), places=6)
                seen.add("rise" if ch[c] > 0 else "fall")
        self.assertEqual(seen, {"rise", "fall"})

    def test_a_mean_that_did_not_move_keeps_the_old_sentences(self):
        req = linear_request(WB_T, "country", WB_FLAT_MEAN, 2010, 2022, text=True)
        self.assertEqual(sum(b - a for a, b in WB_FLAT_MEAN.values()), 0)
        for picks, sid, olds in ((["spread", "ends"], "spread", {"d_chn": ("story.note.spread.rise", "CHN"), "d_ind": ("story.note.spread.fall", "IND")}),
                                 (["movers", "ends"], "movers", None)):
            composed, facts, notes = self.notes(req, picks, sid, WB_NAMES_ALL)
            self.assertFalse([k for k in composed["facts"] if k.startswith(("k_", "sp_m", "mv_m"))], sid)
            for num, n in notes.items():
                self.assertNotIn("倍", self.words(n), (sid, num))
            for num, (word, c) in (olds or {}).items():
                self.assertEqual(notes[num], FN.note(num, word, c=c))

    def test_a_rank_tied_at_the_bottom_both_years_keeps_the_old_sentences(self):
        ends = {"AA": (50.0, 40.0), "BB": (45.0, 48.0), "CC": (40.0, 30.0), "DD": (35.0, 52.0), "EE": (30.0, 33.0), "FF": (5.0, 6.0), "GG": (5.0, 6.0)}
        names = {"AA": "甲", "BB": "乙", "CC": "丙", "DD": "丁", "EE": "戊", "FF": "己", "GG": "庚"}
        req = linear_request("nrg_ind_ren", "geo", ends, 2005, 2024, fixed={"nrg_bal": "REN"})
        composed, facts, notes = self.notes(req, ["overtake", "ends"], "overtake", names)
        self.assertEqual(notes["ot_fall"], FN.note("ot_fall", "story.note.ot.fall", c="AA", a="ot_a_aa", b="ot_b_aa"))
        self.assertFalse([k for k in composed["facts"] if k.startswith(("k_", "ot_avg", "ot_s", "ot_m_"))])
        # the same with the bottom alone at the last year: the average stands on its rank there
        req = linear_request("nrg_ind_ren", "geo", {**ends, "GG": (5.0, 5.5)}, 2005, 2024, fixed={"nrg_bal": "REN"})
        composed, facts, notes = self.notes(req, ["overtake", "ends"], "overtake", names)
        self.assertEqual(composed["facts"]["ot_avg"]["b"], "ot_b_gg"); self.assertEqual(facts["ot_b_gg"]["v"], len(ends))
        self.assertIn("k_ot_fall", composed["facts"])

    def test_to_average_falls_back_with_fewer_than_three_members_a_zero_mean_or_the_other_way(self):
        q = FN.Req(wb_request()[0])
        base, avg = "story.note.mv.up_most", {"m": {"op": "minus", "a": "x1", "b": "x0", "fmt": "x"}}
        plain = FN.note("d", base, c="CHN")
        for n, d, mean in ((2, 4.0, 1.0), (3, 4.0, 0.0), (3, 4.0, 1e-12), (3, 4.0, -1.0), (3, 1.04, 1.0)):   # the last prints 1.0 times: says nothing
            f = {}
            self.assertEqual(FN.to_average(q, f, base, "d", d, mean, "m", avg, n, c="CHN"), plain, (n, d, mean))
            self.assertEqual(f, {}, (n, d, mean))   # no number made for it
        f = {}
        got = FN.to_average(q, f, base, "d", 4.0, 1.0, "m", avg, 3, c="CHN")
        self.assertEqual(got, FN.note("d", base + "_ref", c="CHN", k="k_d"))
        self.assertEqual(f, {**avg, "k_d": {"op": "times", "a": "d", "b": "m", "fmt": "times"}})
        # a variant the word table does not hold (the largest rise is never below the average): the old words
        f = {}
        self.assertEqual(FN.to_average(q, f, base, "d", 1.0, 4.0, "m", avg, 3, c="CHN"), plain); self.assertEqual(f, {})

    def test_the_notes_print_only_facts_and_fit_their_box_on_the_page(self):
        """Drawn by the real page child on both shapes: every digit of a note is a ledger entry of a fact the page declares, and each note's
        words, laid at the width the layout gives them (the column less the card's padding, rule, gap and number), fit it in three lines."""
        cases = ((eu27_request(), ["movers", "overtake", "tiles"]),
                 ((linear_request(WB_T, "country", WB_MOST_ROSE, 2010, 2022, text=True), WB_NAMES_ALL), ["movers", "spread", "ends"]),
                 (wb_request(), ["spread", "ends"]))
        seen = 0
        for (req, names), picks in cases:
            composed, facts, _, page = Findings._page(self, req, names, picks)
            for sec in re.findall(r'<section class="sec".*?</section>', page, re.S):
                col = re.search(r'<div class="col" style="width:(\d+)px">', sec)
                for item in re.findall(r'<li class="note">(.*?)</li>', sec, re.S):
                    for src in re.findall(r'data-src="fact:([a-z0-9_]+?)(?:\.n)?"', item): self.assertIn(src, composed["facts"])
                    self.assertFalse(re.search(r"[0-9]", re.sub(r"<[^>]+>", "", re.sub(r'<span data-src="[^"]*">[^<]*</span>', "", item))), item)
                    num, txt = (re.sub(r"<[^>]+>", "", x) for x in re.match(r'<b class="n">(.*?)</b><span class="nt">(.*)</span>$', item, re.S).groups())
                    w = (int(col.group(1)) if col else story.PAGE_W - 640 - 36) - 28 - 3 - 12 - K.tw(num, 16)
                    lines = K.lay([(txt, None)], 14, w)
                    self.assertLessEqual(len(lines), 3, txt)
                    self.assertTrue(all(sum(K.tw(u, 14) for u, _ in ln) <= w + 14 for ln in lines), txt)   # a line past the box by under one glyph is its closing mark
                    seen += "倍" in txt
        self.assertGreaterEqual(seen, 4)


# ---------------------------------------------------------------- the superlative headlines carry a verb

# The page-good judge's verb list (works/pagegood-1031/pagegood.py, VERB), copied: a headline holds one of these words, the places' names taken out
JUDGE_VERB = ['增', '降', '升', '超', '高于', '低于', '居首', '集中', '占', '达', '成为', '领先', '多于', '少于', '减少', '增加', '下降', '上升', '是', '比', '领跑', '垫底']
SUPERLATIVE_TITLES = {"story.rank.title_top": ["{n:hi}", "{f:rhi}", "{n:lo}", "{f:rlo}"],
                      **{f"story.map.title_{s}": ["{y:y1}", "{n:hi}", "{f:mhi}", "{n:lo}", "{f:mlo}"] for s in ("plain", "east", "west", "north", "south")},
                      **{f"story.tl.title_{s}": ["{y:y1}", "{n:hi}", "{f:thi}", "{n:lo}", "{f:tlo}"] for s in ("plain", "east", "west", "north", "south")}}


class SuperlativeTitles(unittest.TestCase):
    """The headlines that name the highest and the lowest ("X 最高，达 N；Y 最低，只有 N") hold a verb of the judge's list once the places'
    names are taken out, on a Eurostat percent shape and a World Bank shape with units; their slots are the same facts as before."""

    def has_verb(self, text, names):
        for n in sorted(names, key=len, reverse=True): text = text.replace(n, "")
        return [w for w in JUDGE_VERB if w in text]

    def test_every_superlative_title_key_keeps_its_slots_and_reads_with_a_verb(self):
        samples = ((("瑞典", "比利时"), ("65.4%", "14.9%")), (("美国", "尼日利亚"), ("13.6 吨二氧化碳当量/人", "0.6 吨二氧化碳当量/人")))
        for key, slots in SUPERLATIVE_TITLES.items():
            text = FN.WD.WORDS[key]
            self.assertEqual(re.findall(r"\{[fynlg]:\w+\}", text), slots, key)   # the numbers are the same facts
            for (hi, lo), (vhi, vlo) in samples:
                out = text.replace("{y:y1}", "2024 年")
                for slot, v in zip([x for x in slots if x[1] in "fn"], (hi, vhi, lo, vlo)): out = out.replace(slot, v, 1)
                self.assertNotIn("{", out, key)
                self.assertTrue(self.has_verb(out, (hi, lo)), (key, out))

    def headline(self, req, names, picks):
        """The page's headline (the lead's title) with its placeholders printed from the ledger as the page prints them."""
        composed = FN.compose({**req, "picks": picks})
        rows, facts = ledger(req, composed, names)
        entry = {r["src"]: r.get("text") for r in rows if "src" in r}
        def fill(m):
            k = m.group(1)
            if k.startswith("name."): return names[k[5:]]
            if k.endswith(".t"): return entry[f"fact:{k[:-2]}.t.y"] + " 年"
            self.assertIn(k, composed["facts"]); return entry[f"fact:{k}"]
        return re.sub(r"\{([^}]+)\}", fill, composed["title"])

    def test_the_rank_map_and_tile_headlines_hold_a_verb_on_two_shapes(self):
        eu, eu_names = eu27_request()
        eu = NotesStandAgainstAReference.pct(None, eu)
        no_whole = {**eu, "rows": [r for r in eu["rows"] if r["dims"].get("geo") != "EU27_2020"], "main": {k: v for k, v in eu["main"].items() if k != "whole"}}
        wb, wb_names = wb12_request()
        seen = set()
        for req, names in ((eu, eu_names), (no_whole, eu_names), (wb, wb_names)):
            for picks in (["rank", "tiles"], ["map", "rank"], ["tiles", "rank"]):
                if picks[0] not in {c["id"] for c in FN.candidates(req)[1]}: continue
                h1 = self.headline(req, names, picks)
                if "是第" in h1:   # the rank with a whole leads with where the whole stands (story.rank.title): a verb before its number too
                    self.assertRegex(h1, r"^欧盟在 2024 年是第 [0-9]+ 名，[^，]+最高、[^，]+最低$"); self.assertTrue(self.has_verb(h1, names.values()), h1)
                    seen.add(("rank_whole", True)); continue
                self.assertTrue(self.has_verb(h1, names.values()), h1)
                self.assertRegex(h1, r"达 [0-9]"); self.assertRegex(h1, r"只有 [0-9]")
                seen.add((picks[0], "%" in h1))
        self.assertTrue({("rank_whole", True), ("rank", True), ("rank", False), ("map", True), ("map", False), ("tiles", True), ("tiles", False)} <= seen, seen)

    # the headlines as they were before the verbs (commit 011035b3), byte for byte: what a lowest of 0 or below keeps
    OLD = {"story.rank.title_top": "{n:hi}最高，{f:rhi}；{n:lo}最低，{f:rlo}",
           **{f"story.map.title_{s}": "{y:y1}，{n:hi}最高，{f:mhi}；{n:lo}最低，{f:mlo}" + t
              for s, t in (("plain", ""), ("east", "；东边的偏高"), ("west", "；西边的偏高"), ("north", "；北边的偏高"), ("south", "；南边的偏高"))},
           **{f"story.tl.title_{s}": "{y:y1}，" + h + "最高的{n:hi}，{f:thi}；最低的{n:lo}，{f:tlo}"
              for s, h in (("plain", ""), ("north", "北边的偏高："), ("south", "南边的偏高："), ("east", "东边的偏高："), ("west", "西边的偏高："))}}

    def as_title(self, text, prefix, hi, lo):
        """A headline template as the page's wording with the angle's binding (hi, lo, their value facts <prefix><code>, the year of hi's)."""
        k = lambda c: f"{prefix}{c.lower()}"
        out = text.replace("{y:y1}", "{%s.t}" % k(hi)).replace("{n:hi}", "{name.%s}" % hi).replace("{n:lo}", "{name.%s}" % lo)
        return re.sub(r"\{f:\w+(hi|lo)\}", lambda m: "{%s}" % k(hi if m.group(1) == "hi" else lo), out)

    def test_the_old_words_are_kept_as_the_no_verb_variants(self):
        for key, text in self.OLD.items():
            self.assertEqual(FN.WD.WORDS[f"{key}_nov"], text, key)
            self.assertEqual(re.findall(r"\{[fyn]:\w+\}", FN.WD.WORDS[key]), re.findall(r"\{[fyn]:\w+\}", text), key)

    def test_a_lowest_of_zero_or_below_keeps_the_old_headline_on_two_shapes(self):
        eu, eu_names = eu27_request()
        eu = NotesStandAgainstAReference.pct(None, eu)
        eu = {**eu, "rows": [r for r in eu["rows"] if r["dims"].get("geo") != "EU27_2020"], "main": {k: v for k, v in eu["main"].items() if k != "whole"}}
        wb, wb_names = wb12_request()
        family = {"rank": ("story.rank.title_top", "r_"), "map": ("story.map.title_", "mp_"), "tiles": ("story.tl.title_", "tl_")}
        seen = set()
        for req, names, low, last in ((eu, eu_names, "LU", "2024"), (wb, wb_names, "IND", "2022")):
            text = isinstance(req["rows"][0]["value"], str)
            for v in (None, 0.0, -1.5):   # as it is (every value above 0), a lowest of 0, a lowest below 0
                rows = req["rows"] if v is None else [dict(r, value=(f"{v:.2f}" if text else v)) if r["dims"].get(req["main"]["by"]) == low and r["time"] == last else r for r in req["rows"]]
                r = {**req, "rows": rows}
                ids = {c["id"] for c in FN.candidates(r)[1]}
                if v is not None and v < 0: self.assertNotIn("rank", ids)   # the rank draws bars: a value below 0 drops it
                for lead in ("rank", "map", "tiles"):
                    if lead not in ids: continue
                    title = FN.compose({**r, "picks": [lead, next(i for i in ("ends", "movers", "tiles", "map") if i in ids and i != lead)]})["title"]   # the ends need the lowest above 0
                    hi, lo = re.findall(r"\{name\.(\w+)\}", title)[:2]
                    if v is not None: self.assertEqual(lo, low)
                    head, prefix = family[lead]
                    keys = [k for k in self.OLD if k.startswith(head)]
                    want = {self.as_title((self.OLD[k] if v is not None else FN.WD.WORDS[k]), prefix, hi, lo) for k in keys}
                    self.assertIn(title, want, (lead, v))
                    self.assertEqual("达 " in title or "只有 " in title, v is None, (lead, v, title))
                    seen.add((lead, v, text))
        for lead in ("map", "tiles"):
            self.assertTrue({(lead, v, t) for v in (None, 0.0, -1.5) for t in (False, True)} <= seen, (lead, seen))
        self.assertTrue({("rank", v, t) for v in (None, 0.0) for t in (False, True)} <= seen, seen)


if __name__ == "__main__":
    unittest.main()
