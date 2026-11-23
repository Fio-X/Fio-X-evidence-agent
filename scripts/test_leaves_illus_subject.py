"""Self-test of the opening picture's subject (runtime/leaves_py/findings.py illus_*): compose's lead section carries
`picture: {"subject": ...}` built from the rows the angle's own leaf reads, and the illustration child (run_hero.resolve) takes it.
  - for the angles that have a subject (path, need, rank, ends, members, movers, overtake, tiles, map, pace, groups, chain): the subject
    validates through run_hero.resolve (family renewable_share, the angle as lead), every member / year value is the row's own value
    at the page's year (the value format's scale applied), the declared count is the lit count recomputed from the emitted rows,
    the rule's reference is the line the section draws (target, whole, mean) and no family or measure key is given;
  - the angles left out (spread: its rows are changes, the picture draws levels) and the shapes a threshold is missing for (members
    with no target and no whole) carry no `picture`; a non-lead section never carries one.
Run: python3 -I -B scripts/test_leaves_illus_subject.py"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "runtime", "leaves_py"))
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_hero"))
import test_story_findings as SF  # noqa: E402
import findings as FN  # noqa: E402
import run_hero as RH  # noqa: E402

SCALE = 1.0   # the test formats' value scale (FMT_DEFS x)


def lead_of(composed):
    return next(s for s in composed["sections"] if s.get("title"))


def compose_lead(req, angle):
    other = "rank" if angle != "rank" else "ends"
    composed = FN.compose({**req, "picks": [angle, other]})
    return composed, lead_of(composed)


def rows_at(req, year):
    """{code: value} of the main table at a year, from the request's own rows."""
    m = req["main"]
    return {r["dims"][m["by"]]: float(r["value"]) for r in req["rows"]
            if r["table"] == m["table"] and r["time"] == year and all(r["dims"].get(k) == v for k, v in (m.get("filter") or {}).items())}


def resolve(angle, subject):
    """The subject through the illustration child's own resolution (no render): a refusal raises."""
    return RH.resolve({"family": "renewable_share", "lead": angle, "width": 1140, "subject": subject}, renderer="line")


class Subject(unittest.TestCase):
    def check_members(self, subject, truth, ctx):
        got = {m["code"]: m["value"] for m in subject["members"]}
        self.assertEqual(sorted(got), sorted(truth), ctx)
        for c, v in got.items(): self.assertAlmostEqual(v, truth[c] * SCALE, places=6, msg=(ctx, c))

    def lit_count(self, subject):
        rule = subject["rule"]
        pred = (lambda v: v < rule["ref"]) if rule["op"] == "lt" else (lambda v: v >= rule["ref"])
        return sum(1 for m in subject["members"] if pred(m["value"]))

    def emitted(self, req, angle, ctx):
        composed, lead = compose_lead(req, angle)
        self.assertEqual(lead["id"], angle, ctx)
        self.assertIn("picture", lead, (ctx, angle))
        self.assertEqual(list(lead["picture"]), ["subject"], ctx)
        sub = lead["picture"]["subject"]
        self.assertNotIn("family", lead["picture"]); self.assertNotIn("measure", sub)   # the angles know no measure key
        self.assertEqual([s["id"] for s in composed["sections"] if "picture" in s], [angle], ctx)   # the lead's alone
        resolve(angle, sub)
        return composed, sub

    def test_path_and_need_take_the_whole_first_now_and_the_target(self):
        req, _ = SF.eu_request()
        for angle in ("path", "need"):
            composed, sub = self.emitted(req, angle, "eu")
            p = sub["path"]
            whole = {r["time"]: float(r["value"]) for r in req["rows"] if r["dims"].get("geo") == "EU27_2020" and r["table"] == "nrg_ind_ren"}
            ys = FN.run_years(whole)
            self.assertAlmostEqual(p["from"], whole[ys[0]], places=6); self.assertAlmostEqual(p["now"], whole[ys[-1]], places=6)
            self.assertAlmostEqual(p["goal"], 42.5, places=6)
            self.assertEqual(composed["facts"]["goal"]["time"], "2030")

    def test_rank_takes_the_members_values_the_leaf_prints_at_the_page_year(self):
        for mk in (SF.eu_request, SF.eu27_request):
            req, _ = mk()
            composed, sub = self.emitted(req, "rank", mk.__name__)
            self.assertNotIn("rule", sub)
            members = [m for m in req["main"]["members"]]
            self.check_members(sub, {c: v for c, v in rows_at(req, "2024").items() if c in members}, mk.__name__)
            # the leaf's own rows hold the same ledger rows
            src = {r["src"]: float(r["value"]) for r in req["rows"]}
            leaf = {r["code"]: src[r["value"]] for r in composed["leaves"]["rankbar"]["rows"] if r["code"] != "EU27_2020"}
            for m in sub["members"]: self.assertAlmostEqual(m["value"], leaf[m["code"]] * SCALE, places=6)

    def test_ends_take_the_members_at_the_last_year(self):
        req, _ = SF.eu_request()
        _, sub = self.emitted(req, "ends", "eu")
        self.check_members(sub, {c: v for c, v in rows_at(req, "2024").items() if c in req["main"]["members"]}, "eu")
        self.assertNotIn("rule", sub)

    def test_members_movers_overtake_tiles_and_map_light_the_members_under_the_target(self):
        req, _ = SF.eu27_request()
        target = 42.5
        for angle in ("members", "movers", "overtake", "tiles", "map"):
            composed, sub = self.emitted(req, angle, angle)
            self.assertEqual(sub["rule"], {"op": "lt", "ref": target}, angle)
            truth = {c: v for c, v in rows_at(req, "2024").items() if c in sub_codes(sub)}
            self.check_members(sub, truth, angle)
            self.assertNotIn("EU27_2020", sub_codes(sub))
            lit = self.lit_count(sub)
            self.assertEqual(sub["declared"], {"count": lit, "total": len(sub["members"])}, angle)
            self.assertTrue(0 < lit < len(sub["members"]))

    def test_the_whole_is_the_line_when_there_is_no_target(self):
        req, _ = SF.eu27_request()
        req = {**req, "target": None}
        req = {**req, "rows": [r for r in req["rows"] if r["table"] != "targets"]}
        composed, sub = self.emitted(req, "members", "no target")
        whole = rows_at(req, "2024")["EU27_2020"]
        self.assertAlmostEqual(sub["rule"]["ref"], whole * SCALE, places=6)
        self.assertEqual(sub["declared"]["count"], self.lit_count(sub))

    def test_members_with_no_line_carry_no_subject(self):
        req, _ = SF.eu27_plain()   # no whole, no target
        composed, lead = compose_lead(req, "members")
        self.assertEqual(lead["id"], "members"); self.assertNotIn("picture", lead)
        self.assertFalse(any("picture" in s for s in composed["sections"]))

    def test_spread_carries_no_subject(self):
        req, _ = SF.eu_request()
        composed, lead = compose_lead(req, "spread")
        self.assertEqual(lead["id"], "spread"); self.assertNotIn("picture", lead)
        self.assertFalse(any("picture" in s for s in composed["sections"]))

    def test_pace_is_the_members_mean_a_year_with_the_years_after_the_split_lit(self):
        for mk in (SF.eu27_plain, SF.wb24_request):
            req, _ = mk(SF.ASKED["pace"])
            composed, sub = self.emitted(req, "pace", mk.__name__)
            by = req["main"]["by"]; tab = req["main"]["table"]
            members = req["main"].get("members") or sorted({r["dims"][by] for r in req["rows"]})
            years = sorted({r["time"] for r in req["rows"] if r["table"] == tab}, key=int)
            truth = {y: sum(rows_at(req, y)[c] for c in members) / len(members) for y in years}
            got = {str(p["t"]): p["value"] for p in sub["series"]}
            self.assertEqual(sorted(got, key=int), years[-len(got):], mk.__name__)
            for y, v in got.items(): self.assertAlmostEqual(v, truth[y] * SCALE, places=6, msg=(mk.__name__, y))
            self.assertEqual(sub["split"], int(composed["facts"]["pc_to"]["time"]))
            lit = sum(1 for p in sub["series"] if p["t"] >= sub["split"])
            self.assertEqual(sub["declared"], {"count": lit, "total": len(sub["series"])})

    def test_groups_are_the_highest_and_the_lowest_group_against_the_mean(self):
        req, _ = SF.eu27_plain(SF.ASKED["groups"])
        composed, sub = self.emitted(req, "groups", "groups")
        at = rows_at(req, "2024")
        self.assertEqual(len(sub["groups"]), 2)
        names = {g["id"]: g["name_zh"] for g in req["groups"]["groups"]}
        kept = {g["id"]: [c for c in g["members"] if c in at] for g in req["groups"]["groups"] if len(g["members"]) >= FN.GROUP_MEMBERS}
        pool = [c for cs in kept.values() for c in cs]
        self.assertAlmostEqual(sub["rule"]["ref"], sum(at[c] for c in pool) / len(pool) * SCALE, places=6)
        means = {gid: sum(at[c] for c in cs) / len(cs) for gid, cs in kept.items()}
        self.assertEqual([g["key"] for g in sub["groups"]], [max(means, key=lambda g: (means[g], g)), min(means, key=lambda g: (means[g], g))])
        total = 0
        for g in sub["groups"]:
            self.assertEqual(g["name"], names[g["key"]])
            self.check_members({"members": g["members"]}, {c: at[c] for c in kept[g["key"]]}, g["key"])
            lit = sum(1 for m in g["members"] if m["value"] >= sub["rule"]["ref"])
            self.assertEqual(sub["declared"]["groups"][g["key"]], {"count": lit, "total": len(g["members"])})
            total += lit
        self.assertTrue(0 < total < sum(len(g["members"]) for g in sub["groups"]))

    def test_chain_is_the_whole_over_the_shared_years_lit_from_the_year_it_moved_most(self):
        req, _ = SF.eu_chain_request()
        composed, sub = self.emitted(req, "chain", "chain")
        whole = {r["time"]: float(r["value"]) for r in req["rows"] if r["dims"].get("geo") == "EU27_2020" and r["table"] == "nrg_ind_ren"}
        got = {str(p["t"]): p["value"] for p in sub["series"]}
        self.assertEqual(sorted(got), ["2019", "2020", "2021", "2022", "2023", "2024"])
        for y, v in got.items(): self.assertAlmostEqual(v, whole[y] * SCALE, places=6)
        self.assertEqual(sub["split"], int(composed["facts"]["band_y"]["time"]))   # the shaded band's year: 2022, where the tables together moved most
        self.assertEqual(sub["split"], 2022)
        self.assertEqual(sub["declared"], {"count": 3, "total": 6})

    def test_every_lead_that_carries_a_subject_resolves_on_every_shape(self):
        seen = set()
        shapes = [SF.eu_request(), SF.eu27_request(), SF.eu27_plain(SF.ASKED["none"]), SF.eu_chain_request(), SF.wb_request(), SF.wb12_request(), SF.wb24_request()]
        for req, _ in shapes:
            for c in FN.candidates(req)[1]:
                composed, lead = compose_lead(req, c["id"])
                if lead["id"] != c["id"]: continue   # the arc may reorder; only a lead is tested
                if "picture" in lead:
                    resolve(c["id"], lead["picture"]["subject"]); seen.add(c["id"])
                self.assertEqual([s["id"] for s in composed["sections"] if "picture" in s], [c["id"]] if "picture" in lead else [])
        self.assertTrue({"path", "need", "rank", "ends", "members", "pace", "groups"} <= seen, seen)


def sub_codes(sub):
    return [m["code"] for m in sub["members"]]


if __name__ == "__main__":
    unittest.main()
