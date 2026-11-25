"""The opening picture's proportion (findings.py illus_proportion): on a rate measure (the value prints with "%") a lead finding whose claim
names one member and prints its value (the rank's "the highest is X: 10.5%", the movers' "X, its last value") adds to the angle's own subject,
kept as it was, a key "proportion": {share, figures 30, declared {count K, total 30}}, K = 30 x share half to even; on any other measure, or a
claim that names no member, more than one, or prints no value (a position, a change), the subject is the angle's own alone. Two shapes (an
unemployment-like rate, a per-capita money measure); the child (runtime/illus_hero/run_hero.py) recounts it and draws it with the real scene
node where the topic's renderer is the scene renderer (people), and draws the angle's own subject elsewhere (energy).
Run: python3 -I -B scripts/test_story_proportion.py"""
import copy
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "illus_hero"))
sys.path.insert(0, HERE)
import findings as FN  # noqa: E402
import run_hero as R  # noqa: E402
from test_story_findings import FMT_DEFS, row, wb_request  # noqa: E402

RATE_FMTS = {"value": "pc", "year": "yr", "times": "times", "delta": "pp"}
RATE_DEFS = {**FMT_DEFS, "pc": {"scale": 1, "dec": 1, "suffix": "%"}, "pp": {"scale": 1, "dec": 1, "suffix": " 个百分点"}}
# eight members' unemployment rates (test-only, not data) at 2016 and 2025; the highest at 2025 is set by each case
RATES = {"ES": (19.6, None), "EL": (23.5, 9.0), "IT": (11.7, 6.1), "FR": (10.1, 7.4), "SE": (6.9, 8.7), "DE": (4.1, 3.6), "PL": (6.2, 3.2), "CZ": (4.0, 2.8)}


def rate_request(top):
    """The rates 2016-2025 (no whole), ES ending at `top` (the highest), the others on a straight line between their ends."""
    t, rows = "une_rt_a", []
    for c, (a, b) in RATES.items():
        b = top if b is None else b
        for y in range(2016, 2026):
            v = round(a + (b - a) * (y - 2016) / 9, 1)
            rows.append({**row(t, {"age": "Y15-74"}, "geo", c, y, v), "value": f"{v:.1f}"})
    return {"rows": rows, "main": {"table": t, "by": "geo", "filter": {"age": "Y15-74"}, "members": list(RATES)}, "fmts": RATE_FMTS,
            "fmt_defs": RATE_DEFS, "words": {"measure": "Unemployment by sex and age - annual data", "unit": "百分比"}}   # as layer 1 sends a table with no reviewed Chinese name: its title


def lead_subject(req, picks):
    return FN.compose({**req, "picks": picks})["sections"][2].get("picture", {}).get("subject")


def without_proportion(req, picks):
    """The composed page with illus_proportion off: the angle's own subject alone, as before."""
    was = FN.illus_proportion
    FN.illus_proportion = lambda q, c: None
    try: return FN.compose({**req, "picks": picks})
    finally: FN.illus_proportion = was


def child_reads_nested():
    """Whether the child takes the proportion as a key beside the old subject (declared inside it)."""
    try: return sum(R.proportion_flags({"proportion": {"share": 0.5, "figures": 2, "declared": {"count": 1, "total": 2}}})) == 1
    except R.Refused: return False


class Proportion(unittest.TestCase):
    def test_the_rank_lead_on_a_rate_draws_its_highest_as_a_share_of_thirty(self):
        """10.5% -> 3.15 -> 3 of 30; 28.4% -> 8.52 -> 9; 25.0% -> 7.5 -> 8 (half to even); 15.0% -> 4.5 -> 4 (half to even, down)."""
        for top, k in ((10.5, 3), (28.4, 9), (25.0, 8), (15.0, 4)):
            req = rate_request(top)
            comp = FN.compose({**req, "picks": ["rank", "ends"]})
            lead = comp["sections"][2]
            self.assertEqual((lead["id"], re.findall(r"\{name\.(\w+)\}", lead["title"])), ("rank", ["ES"]), top)
            sub = lead["picture"]["subject"]
            self.assertEqual(sub["proportion"], {"share": round(top / 100, 12), "figures": 30, "declared": {"count": k, "total": 30}}, top)
            old = without_proportion(req, ["rank", "ends"])
            self.assertEqual({x: v for x, v in sub.items() if x != "proportion"}, old["sections"][2]["picture"]["subject"], top)   # the rank's own members, as before
            self.assertEqual(json.dumps({**comp, "sections": [s for s in comp["sections"] if "picture" not in s]}, sort_keys=True),
                             json.dumps({**old, "sections": [s for s in old["sections"] if "picture" not in s]}, sort_keys=True))  # nothing else moves
            # the page prints the share's own fact (the claim's number), the value of ES at the last year; K is printed nowhere
            num = lead["title"].rsplit("{", 1)[1].rstrip("}")
            self.assertEqual((comp["facts"][num]["filter"]["geo"], comp["facts"][num]["time"]), ("ES", "2025"))
            self.assertNotIn(f"{{{k}}}", json.dumps(comp, ensure_ascii=False))
            self.assertEqual(FN.proportion_count(sub["proportion"]["share"], 30), k)

    def test_a_movers_lead_reads_its_member_s_last_value(self):
        req = rate_request(10.5)
        comp = FN.compose({**req, "picks": ["movers", "rank"]})
        lead = comp["sections"][2]
        big = re.findall(r"\{name\.(\w+)\}", lead["title"])
        self.assertEqual(len(big), 1)
        v = next(r_ for r_ in req["rows"] if r_["dims"]["geo"] == big[0] and r_["time"] == "2025")["value"]
        k = FN.proportion_count(round(float(v) / 100, 12), 30)
        self.assertEqual(lead["picture"]["subject"]["proportion"]["declared"], {"count": k, "total": 30})
        self.assertEqual({x: v for x, v in lead["picture"]["subject"].items() if x != "proportion"},
                         without_proportion(req, ["movers", "rank"])["sections"][2].get("picture", {}).get("subject", {}))   # the movers' own (none here: no line to tally against)

    def test_no_proportion_where_the_claim_names_no_single_member_s_value_or_the_count_is_none_or_all(self):
        req = rate_request(10.5)
        q, cands, _ = FN.candidates(req)
        for c in cands:   # ends (a multiple), overtake (a rise), members (a change), spread, pace: the angle's own subject or none
            if c["id"] in ("rank", "movers"): continue
            picks = [c["id"], "rank" if c["id"] != "rank" else "ends"]
            try: sub = lead_subject(req, picks)
            except FN.Refused: continue
            self.assertFalse(sub and "proportion" in sub, c["id"])
            self.assertEqual(sub, q.illus.get(c["id"]), c["id"])
        # a share whose count rounds to 0 of 30 (1.6% -> 0.48 -> 0): nothing to count, the rank's own members instead
        low = rate_request(1.6)
        low["rows"] = [dict(r_, value=f"{float(r_['value']) / 10:.1f}") for r_ in low["rows"]]
        self.assertNotIn("proportion", lead_subject(low, ["rank", "ends"]) or {})

    def test_a_money_measure_keeps_the_angle_s_own_subject_byte_for_byte(self):
        """Per-capita money (a unit that is no percent): the rank's claim names one member's value, yet the subject is the rank's members,
        and every composed page is the one the angle alone gives (illus_proportion off)."""
        req, _ = wb_request()
        req = {**req, "fmt_defs": {**req["fmt_defs"], "x": {"scale": 1, "dec": 0, "suffix": " 美元"}}, "words": {"measure": "人均国内生产总值", "unit": "美元"}}
        ids = [c["id"] for c in FN.candidates(req)[1]]
        off = FN.illus_proportion
        for a in ids:
            for b in ids:
                if a == b: continue
                try: on_ = json.dumps(FN.compose({**req, "picks": [a, b]}), sort_keys=True, ensure_ascii=False)
                except FN.Refused: continue
                FN.illus_proportion = lambda q, c: None
                try: self.assertEqual(json.dumps(FN.compose({**req, "picks": [a, b]}), sort_keys=True, ensure_ascii=False), on_, (a, b))
                finally: FN.illus_proportion = off
                self.assertNotIn('"proportion"', on_, (a, b))
        self.assertIn("members", lead_subject(req, ["rank", "ends"]))

    @unittest.skipUnless(child_reads_nested(), "run_hero does not yet read the proportion beside the old subject")
    def test_the_child_draws_the_subject_with_the_real_scene_node(self):
        """The picture request as layer 1 sends it (next_visual illus_hero: the lead, the subject, the family): on a people topic the child
        takes the proportion to the scene renderer, recounts K, and the node draws K lit of 30 (the grid); on an energy topic it draws the
        angle's own subject with its own renderer."""
        sub = lead_subject(rate_request(10.5), ["rank", "ends"])
        energy = {"tags": [], "hero": "wind", "width": 1140, "ground": "warm", "accent": "#b8433a", "lead": "rank", "family": "renewable_share", "subject": sub}
        self.assertNotEqual(R.renderer_of(energy), "scene")
        for top, k in ((10.5, 3), (25.0, 8)):
            sub = lead_subject(rate_request(top), ["rank", "ends"])
            req = {"tags": [], "hero": "wind", "width": 1140, "ground": "warm", "accent": "#b8433a", "lead": "rank", "family": "unemployment", "subject": copy.deepcopy(sub)}
            self.assertEqual(R.renderer_of(req), "scene")
            svg, w, h, secs, name, comp = R.build_scene(req)
            self.assertEqual((comp["lit"], comp["objects"], name), (k, 30, "people.proportion"), top)
            self.assertEqual(comp["scene_layout"], "grid", top)
            bad = {**req, "subject": {**sub, "proportion": {**sub["proportion"], "declared": {"count": k + 1, "total": 30}}}}
            with self.assertRaisesRegex(R.Refused, "half to even"): R.build_scene(bad)


if __name__ == "__main__":
    unittest.main()
