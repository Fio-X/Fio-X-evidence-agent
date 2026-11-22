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
        d = {"n": {"scale": 1, "dec": 0, "suffix": ""}, **FMT_DEFS, **req.get("chain_fmts", {})}[f["fmt"]]
        rows.append({"src": f"fact:{k}", "text": f"{f['v'] * d['scale']:,.{d['dec']}f}{d['suffix']}"})
        rows.append({"src": f"fact:{k}.n", "text": f"{f['v'] * d['scale']:,.{d['dec']}f}"})  # the bare number a placeholder prints
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
        if layer == "bignums": continue  # html, drawn by the page child (test_header_*)
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
        self.assertEqual(sorted(c["id"] for c in cands), ["ends", "members", "need", "path", "rank", "spread"])
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
        self.assertEqual({d["angle"]: d["why"] for d in dropped}, {"path": "no target row", "need": "no target row", "chain": "the request's chain holds fewer than 2 tables"})
        self.assertEqual(sorted(c["id"] for c in cands), ["ends", "members", "rank", "spread"])
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
        self.assertEqual((chain["layer"], chain["why"]["band"]), ("event_chain", "2022"))
        self.assertTrue(0 < chain["score"] <= 1)
        composed, facts, drawn = draw_all(self, req, names, ["path", "chain"])
        self.assertEqual([s["layer"] for s in composed["sections"]], ["bignums", "thesis_claims", "target_path", "event_chain", "risk_notes"])
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
        title = composed["sections"][3]["title"]
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
            spec = {"title": "t", "kicker": "k", "dek": "d", "source": "s", "refs": [], "facts": composed["facts"], "sections": composed["sections"],
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
        composed, facts, drawn = draw_all(self, req, names, ["rank", "path", "spread"])
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

    def _page(self, req, names, picks):
        """The composed page drawn by the real child: (composed, facts, {layer: its svg or html}, the page's html)."""
        import json, subprocess
        composed = FN.compose({**req, "picks": picks})
        rows, facts = ledger(req, composed, names)
        spec = {"title": "t", "kicker": "k", "dek": "d", "source": "s", "refs": [], "facts": composed["facts"], "sections": composed["sections"],
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
        bodies = {n: g.get("svg") or g.get("html") for n, g in zip(layers, got[1:])}
        last = go(lines + [json.dumps({"phase": "page", "layers": bodies, "sizes": {}}, ensure_ascii=False)])[-1]
        self.assertFalse(last.get("refused"), last)
        return composed, facts, bodies, last["html"]

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
        composed, facts, big, _ = self._header_page(req, names, ["spread", "ends"])
        items = composed["leaves"]["bignums"]["bignums"]
        self.assertEqual([i["fact"] for i in items], ["b_now", "b_change", "b_ratio"])
        self.assertEqual(items[1]["label"]["word"], "story.big.rose")
        self.assertAlmostEqual(facts["b_change"]["v"], 24.6 - 10.2, places=6)  # the larger value less the smaller
        self.assertAlmostEqual(facts["b_ratio"]["v"], facts["b_hi"]["v"] / facts["b_lo"]["v"], places=6)
        self.assertEqual(items[2]["label"]["name"], "SE")  # the highest member

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
        composed = FN.compose({**req, "rows": down, "picks": ["spread", "ends"]})
        self.assertEqual(composed["leaves"]["bignums"]["bignums"][1]["label"]["word"], "story.big.fell")
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
        composed, facts, svg, page_html = self._members_page(req, names, ["members", "path"])
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
        composed = FN.compose({**req, "rows": up, "picks": ["members", "path"]})
        self.assertIn("只涨了", next(x for x in composed["sections"] if x["id"] == "members")["title"])
        down = [dict(r, value=round(r["value"] - 1.0 * (int(r["time"]) - 2005), 3)) if r["dims"].get("geo") != "EU27_2020" else r for r in req["rows"]]
        composed = FN.compose({**req, "rows": down, "picks": ["members", "path"]})
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
        composed = FN.compose({**big, "picks": ["members", "path"]})
        cells = [c["code"] for c in composed["leaves"]["small_multiples"]["cells"]]
        self.assertEqual(len(cells), 12)
        last = {c: next(r["value"] for r in rows if r["dims"].get("geo") == c and r["time"] == "2024") for c in members}
        order = sorted(members, key=lambda c: (-last[c], c))
        self.assertEqual(sorted(cells), sorted(order[:6] + order[-6:]))

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
        spec = {"title": "t", "kicker": "k", "dek": "d", "source": "s", "refs": [], "facts": composed["facts"], "sections": composed["sections"],
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
        self.assertEqual(sorted(c["id"] for c in out[0]["candidates"]), ["ends", "members", "need", "path", "rank", "spread"])
        self.assertIn("not JSON", out[1]["refused"][0])
        self.assertEqual([s["layer"] for s in out[2]["knobs"]["spec"]["sections"]], ["bignums", "thesis_claims", "target_path", "gap_axis", "risk_notes"])
        self.assertEqual(sorted(out[2]["knobs"]["spec"]["hero"]["leaves"]), ["bignums", "gap_axis", "risk_notes", "target_path", "thesis_claims"])
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
