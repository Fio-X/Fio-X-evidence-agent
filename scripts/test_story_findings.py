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
import math
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
import findings as FN  # noqa: E402
import run  # noqa: E402
import wbkit as K  # noqa: E402

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
    return {**req, "rows": rows, "chain": chain}, names


def wb_request():
    t = "EN.GHG.CO2.PC.CE.AR5"
    # the knowledge group gives a value as the source's decimal text: this shape's rows hold it so
    rows = [{**row(t, {}, "country", c, y, a + p * (y - 2010)), "value": f"{a + p * (y - 2010):.2f}"} for c, (a, p) in WB.items()
            for y in range(2010, 2023)]
    return {"rows": rows, "main": {"table": t, "by": "country"}, "fmts": FMTS, "fmt_defs": FMT_DEFS,
            "words": {"measure": "人均二氧化碳排放", "unit": "吨／人"}}, WB_NAMES


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
        d = FMT_DEFS[f["fmt"]]
        rows.append({"src": f"fact:{k}", "text": f"{f['v'] * d['scale']:,.{d['dec']}f}{d['suffix']}"})
        if "t" in f: rows.append({"src": f"fact:{k}.t.y", "text": f["t"]})
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
        mod = __import__(layer)
        svg = mod.draw({"data": data, "style": {layer: {}}})
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
        self.assertEqual([d["angle"] for d in dropped], ["chain"])  # the request carries no chain
        self.assertEqual(sorted(c["id"] for c in cands), ["ends", "need", "path", "spread"])
        self.assertEqual([c["score"] for c in cands], sorted((c["score"] for c in cands), reverse=True))
        path = next(c for c in cands if c["id"] == "path")
        self.assertEqual(path["title"][0], ("w", "就算每年都像 "))  # even the best year falls short of 42.5
        composed, facts, drawn = draw_all(self, req, names, ["path", "need", "spread"])
        self.assertLess(facts["p_best"]["v"], facts["goal"]["v"])
        self.assertEqual(facts["best"]["t"], "2020")
        self.assertEqual([s["layer"] for s in composed["sections"]],
                         ["thesis_claims", "target_path", "gap_axis", "winners_losers", "risk_notes"])
        self.assertEqual(set(drawn), {"thesis_claims", "target_path", "gap_axis", "winners_losers", "risk_notes"})

    def test_wb_no_target_drops_path_and_need(self):
        req, names = wb_request()
        _, cands, dropped = FN.candidates(req)
        self.assertEqual({d["angle"]: d["why"] for d in dropped}, {"path": "no target row", "need": "no target row", "chain": "the request's chain holds fewer than 2 tables"})
        self.assertEqual(sorted(c["id"] for c in cands), ["ends", "spread"])
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
        self.assertEqual(dropped, [])
        chain = next(c for c in cands if c["id"] == "chain")
        self.assertEqual((chain["layer"], chain["why"]["band"]), ("event_chain", "2020"))
        self.assertTrue(0 < chain["score"] <= 1)
        composed, facts, drawn = draw_all(self, req, names, ["path", "chain"])
        self.assertEqual([s["layer"] for s in composed["sections"]], ["thesis_claims", "target_path", "event_chain", "risk_notes"])
        data = composed["leaves"]["event_chain"]
        self.assertEqual([(p["code"], p["kind"], p["zero"], "link" in p) for p in data["panels"]],
                         [("c1", "bar", True, True), ("c2", "line", False, True), ("c3", "bar", True, False)])
        self.assertEqual([len(p["points"]) for p in data["panels"]], [6, 6, 6])
        self.assertEqual((data["band"]["from"], data["band"]["to"]), ("2020", "2020"))
        # the title's number is the whole's step in 2020, the larger value less the smaller (19.9 -> 22.0)
        self.assertAlmostEqual(facts["m_step"]["v"], 22.0 - 19.9, places=6)
        self.assertEqual(facts["band_y"]["t"], "2020")
        self.assertEqual((facts["c1_first"]["t"], facts["c1_last"]["t"]), ("2019", "2024"))
        title = composed["sections"][2]["title"]
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
        self.assertEqual(why({**req, "main": {**req["main"], "whole": None}}), "no whole to date the event by")
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
        self.assertEqual(sorted(c["id"] for c in out[0]["candidates"]), ["ends", "need", "path", "spread"])
        self.assertIn("not JSON", out[1]["refused"][0])
        self.assertEqual([s["layer"] for s in out[2]["knobs"]["spec"]["sections"]], ["thesis_claims", "target_path", "gap_axis", "risk_notes"])
        self.assertEqual(sorted(out[2]["knobs"]["spec"]["hero"]["leaves"]), ["gap_axis", "risk_notes", "target_path", "thesis_claims"])
        # the child gives the spec's facts, sections and leaf data only: rows, formats and names are layer 1's
        self.assertEqual(list(out[2]), ["knobs"])
        self.assertEqual(list(out[2]["knobs"]), ["spec"])
        self.assertEqual(sorted(out[2]["knobs"]["spec"]), ["facts", "hero", "sections"])

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


if __name__ == "__main__":
    unittest.main()
