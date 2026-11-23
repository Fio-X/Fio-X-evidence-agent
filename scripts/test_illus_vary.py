"""The opening illustration follows the page's topic and its finding (runtime/illus_hero: node.json topics, run_hero.py compose_subject), without
Blender: the topic comes from the measure family id (no question text is read) and each topic has its own unit and scene, an unknown family
falls back to the neutral topic; the layout comes from the lead angle (tally, pair, rank, path, series); the number of lit units is recomputed
from the finding's rows and the picture is refused when the declared count (a ledger entry) is not the recomputed one; the five story
questions st1..st5 (rows read from their runs, kept in fixtures/illus-vary-specs.json) give five different compositions.
Run: python3 -I -B scripts/test_illus_vary.py"""
import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
HERO = os.path.join(ROOT, "runtime", "illus_hero")
sys.path.insert(0, HERO)
import run_hero as R  # noqa: E402

SPECS = json.load(open(os.path.join(ROOT, "fixtures", "illus-vary-specs.json")))
FAMILIES = json.load(open(os.path.join(ROOT, "runtime", "pi", "assets", "measure-families.json")))["families"]
STRIP = json.load(open(os.path.join(ROOT, "runtime", "leaves_js", "pieces-energy.json")))
T = R.REG["topics"]
CODES = list("ABCDEFGHIJ")
VALUES = [9, 8, 7, 6, 5, 4, 3, 2, 1.5, 1]


def req(spec_name=None, **over):
    sp = SPECS[spec_name] if spec_name else {}
    r = {"family": sp.get("family"), "lead": sp.get("lead"), "width": 1140, "ground": "warm", "subject": sp.get("subject")}
    r.update(over)
    return {k: v for k, v in r.items() if v is not None}


def tally(rule, declared=None, flags=None, family="co2"):
    ms = [{"code": c, "value": v} for c, v in zip(CODES, VALUES)]
    if flags:
        for m, f in zip(ms, flags): m["flag"] = f
    sub = {"members": ms, "rule": rule}
    if declared: sub["declared"] = declared
    return {"family": family, "lead": "members", "width": 1140, "subject": sub}


def sig(r):
    c = R.resolve(r)[0]["composition"]
    return (c["scene"], c["objects"], c["layout"], c["lit"])


class CountDiscipline(unittest.TestCase):
    def test_the_lit_count_is_recomputed_from_the_rows(self):
        s, *_ = R.resolve(tally({"op": "ge", "ref": 5}, {"count": 5, "total": 10}))
        lit = [i for i in s["items"] if i["args"].get("lit")]
        self.assertEqual(len(lit), 5); self.assertEqual(s["composition"]["lit"], 5); self.assertEqual(s["composition"]["objects"], 10)
        self.assertEqual(sum(1 for i in s["items"] if i.get("fn") == "stack_unit"), 10)

    def test_a_declared_count_that_is_not_the_rows_count_is_refused(self):
        with self.assertRaisesRegex(R.Refused, "declared.count 6 is not the 5"): R.resolve(tally({"op": "ge", "ref": 5}, {"count": 6, "total": 10}))
        with self.assertRaisesRegex(R.Refused, "declared.total 9 is not the 10"): R.resolve(tally({"op": "ge", "ref": 5}, {"count": 5, "total": 9}))

    def test_a_member_flag_that_is_not_the_rule_is_refused(self):
        ok = [v >= 5 for v in VALUES]
        R.resolve(tally({"op": "ge", "ref": 5}, flags=ok))
        bad = list(ok); bad[0] = False
        with self.assertRaisesRegex(R.Refused, "flag of A"): R.resolve(tally({"op": "ge", "ref": 5}, flags=bad))

    def test_the_rule_ops_and_ranks(self):
        self.assertEqual(sig(tally({"op": "gt", "ref": 5}))[3], 4); self.assertEqual(sig(tally({"op": "lt", "ref": 5}))[3], 5)
        self.assertEqual(sig(tally({"op": "top", "k": 3}))[3], 3); self.assertEqual(sig(tally({"op": "bottom", "k": 2}))[3], 2)
        for rule, why in (({"op": "top", "k": 10}, "k"), ({"op": "wiggle", "ref": 1}, "op"), ({"op": "ge", "ref": "5"}, "no number")):
            with self.assertRaisesRegex(R.Refused, why): R.resolve(tally(rule))

    def test_a_cut_inside_a_tie_is_refused(self):
        r = tally({"op": "top", "k": 2}); r["subject"]["members"][2]["value"] = 8
        with self.assertRaisesRegex(R.Refused, "tie"): R.resolve(r)

    def test_members_are_checked(self):
        r = tally({"op": "ge", "ref": 5}); r["subject"]["members"][1]["code"] = "A"
        with self.assertRaisesRegex(R.Refused, "twice"): R.resolve(r)
        r = tally({"op": "ge", "ref": 5}); r["subject"]["members"] = r["subject"]["members"][:2]
        with self.assertRaisesRegex(R.Refused, "members"): R.resolve(r)
        r = tally({"op": "ge", "ref": 5}); r["subject"]["members"][0]["value"] = True
        with self.assertRaisesRegex(R.Refused, "no number"): R.resolve(r)

    def test_the_series_count_is_recomputed_too(self):
        s = SPECS["st3"]; r = req("st3")
        self.assertEqual(sig(r)[3], 4)
        bad = json.loads(json.dumps(r)); bad["subject"]["declared"]["count"] = 3
        with self.assertRaisesRegex(R.Refused, "declared.count 3 is not the 4 years"): R.resolve(bad)
        bad = json.loads(json.dumps(r)); bad["subject"]["split"] = 2016; del bad["subject"]["declared"]
        with self.assertRaisesRegex(R.Refused, "split"): R.resolve(bad)

    def test_the_path_milestones_follow_the_numbers(self):
        a = req("st1"); b = json.loads(json.dumps(a)); b["subject"]["path"]["now"] = 40.0
        self.assertEqual(sig(a)[3], 3); self.assertEqual(sig(b)[3], 8)   # (40 - 17.978) / (42.5 - 17.978) = 0.898 of ten
        flags = [i["args"]["lit"] for i in R.resolve(a)[0]["items"] if i.get("fn") == "turbine_unit"]
        self.assertEqual(flags, [True] * 3 + [False] * 7)
        b["subject"]["path"]["goal"] = 17.978
        with self.assertRaisesRegex(R.Refused, "goal is the start"): R.resolve(b)

    def test_a_spec_without_its_rows_is_refused(self):
        with self.assertRaisesRegex(R.Refused, "layout"): R.resolve({"family": "co2", "lead": "weather", "width": 1140, "subject": {"members": []}})
        with self.assertRaisesRegex(R.Refused, "members"): R.resolve({"family": "co2", "lead": "rank", "width": 1140, "subject": {}})
        with self.assertRaisesRegex(R.Refused, "rule"): R.resolve({"family": "co2", "lead": "members", "width": 1140, "subject": {"members": [{"code": c, "value": v} for c, v in zip(CODES, VALUES)]}})


class TopicScenes(unittest.TestCase):
    def test_every_family_has_a_topic_and_every_topic_a_scene(self):
        ids = {f["id"] for f in FAMILIES}
        self.assertEqual(ids - set(T["families"]), set(), "a measure family the hero cannot place")
        self.assertEqual(set(T["families"]) - ids, set(), "a family id that does not exist")
        for topic in set(T["families"].values()) | {T["neutral"]}: self.assertIn(topic, T["scenes"], topic)

    def test_at_least_five_topics_with_their_own_units(self):
        used = {R.topic_of(f) for f in T["families"]}
        self.assertTrue({"energy", "emissions", "people", "trade", "migration"} <= used)
        units = {T["scenes"][t]["unit"] for t in used | {T["neutral"]}}
        self.assertEqual(len(units), len(used | {T["neutral"]}), "every topic draws its own unit")

    def test_unknown_family_falls_back_to_the_neutral_scene(self):
        for fam in (None, "no_such_family", 5):
            self.assertEqual(R.topic_of(fam), "neutral")
        s, *_ = R.resolve(req("neutral_rank")); self.assertEqual(s["composition"]["scene"], "neutral.rank")
        self.assertEqual({i["fn"] for i in s["items"]}, {"cairn_unit"})

    def test_each_topic_draws_its_own_unit_and_filler_parts(self):
        import parts as P
        seen = {}
        for name, want in (("st4", "turbine_unit"), ("em_tally", "stack_unit"), ("pop_tally", "figure_unit"), ("trade_tally", "container_unit"), ("mig_path", "waypoint_unit")):
            s, *_ = R.resolve(req(name)); fns = {i["fn"] for i in s["items"] if i["kind"] == "at_ground"}
            self.assertIn(want, fns, name); seen[name] = s["composition"]["scene"]
            for fn in fns: self.assertTrue(callable(getattr(P, fn)), fn)
        self.assertEqual(len(set(seen.values())), 5, seen)
        for sc in T["scenes"].values():
            for f in sc["filler"]: self.assertTrue(callable(getattr(P, f["fn"])), f["fn"])

    def test_the_unit_parts_group_a_lit_unit_in_the_accent_group(self):
        import parts as P
        for fn in ("turbine_unit", "stack_unit", "figure_unit", "container_unit", "waypoint_unit", "cairn_unit"):
            on, off = getattr(P, fn)(size=1.0, lit=True), getattr(P, fn)(size=1.0, lit=False)
            self.assertIn("lit", {m.group for m in on}, fn); self.assertNotIn("lit", {m.group for m in off}, fn)
            self.assertTrue(all(m.v and m.f for m in on + off), fn)
        src = open(os.path.join(HERO, "scene_node.py")).read()
        self.assertRegex(src, r'"thing": \(') ; self.assertRegex(src, r'"lit": \(')

    def test_accents_are_the_topics_own_unless_given(self):
        a = R.resolve(req("em_tally"))[2]; b = R.resolve(req("st4"))[2]; c = R.resolve(req("st4", accent="#123456"))[2]
        self.assertEqual(b, "#1a9a6c"); self.assertNotEqual(a, b); self.assertEqual(c, "#123456")

    def test_the_strip_and_the_hero_share_one_family_map(self):
        self.assertEqual(STRIP["strip_topics"]["families"], T["families"]); self.assertEqual(STRIP["strip_topics"]["neutral"], T["neutral"])

    def test_the_mark_stands_on_the_boundary_unit(self):
        s, *_ = R.resolve(req("st4")); marked = [i for i in s["items"] if "mark" in i]
        self.assertEqual(len(marked), 1); self.assertTrue(marked[0]["args"]["lit"])
        lit = [i for i in s["items"] if i["args"].get("lit")]; self.assertEqual(len(lit), 22)

    def test_mirror_flips_the_picture(self):
        a = R.resolve(req("st5"))[0]; b = R.resolve(req("st5", composition={"reading_order": "right_to_left"}))[0]
        self.assertEqual([i["at"][0] for i in a["items"]], [-i["at"][0] for i in b["items"]])


def groups_req(**dec):
    mk = lambda key, vals: {"key": key, "name": f"Group {key}", "members": [{"code": f"{key}{i}", "value": v} for i, v in enumerate(vals)]}
    sub = {"groups": [mk("N", (9, 8, 7, 6, 2, 1)), mk("S", (9, 3, 2, 1, 1))], "rule": {"op": "ge", "ref": 5}, "declared": {"groups": {"N": {"count": 4, "total": 6}, "S": {"count": 1, "total": 5}}}}
    for k, v in dec.items(): sub["declared"]["groups"][k] = v
    return {"family": "co2", "lead": "groups", "width": 1140, "subject": sub}


class Groups(unittest.TestCase):
    def test_two_panels_each_with_its_own_recomputed_count(self):
        s, *_ = R.resolve(groups_req()); c = s["composition"]
        self.assertEqual([(g["key"], g["name"], g["lit"], g["total"]) for g in c["groups"]], [("N", "Group N", 4, 6), ("S", "Group S", 1, 5)])
        self.assertEqual((c["lit"], c["objects"]), (5, 11)); self.assertEqual(c["layout"], "groups-4of6+1of5")
        units = [i for i in s["items"] if "lit" in i.get("args", {})]; self.assertEqual(sum(1 for i in units if i["args"]["lit"]), 5)
        left = [i for i in units if i["at"][0] < 0]; right = [i for i in units if i["at"][0] > 0]
        self.assertEqual((len(left), len(right), sum(i["args"]["lit"] for i in left), sum(i["args"]["lit"] for i in right)), (6, 5, 4, 1))
        self.assertEqual(sum(1 for i in s["items"] if i["fn"] == "plinth"), 2, "each panel on its own slab")

    def test_each_groups_declared_count_is_refused_when_it_is_not_the_rows(self):
        with self.assertRaisesRegex(R.Refused, "declared.count 5 is not the 4"): R.resolve(groups_req(N={"count": 5, "total": 6}))
        with self.assertRaisesRegex(R.Refused, "declared.count 2 is not the 1"): R.resolve(groups_req(S={"count": 2, "total": 5}))
        with self.assertRaisesRegex(R.Refused, "declared.total 4 is not the 5"): R.resolve(groups_req(S={"count": 1, "total": 4}))

    def test_a_group_finding_needs_two_distinct_groups_and_no_shared_member(self):
        r = groups_req(); r["subject"]["groups"] = r["subject"]["groups"][:1]
        with self.assertRaisesRegex(R.Refused, "two groups"): R.resolve(r)
        r = groups_req(); r["subject"]["groups"][1]["key"] = "N"
        with self.assertRaisesRegex(R.Refused, "own key"): R.resolve(r)
        r = groups_req(); r["subject"]["groups"][1]["members"][0]["code"] = "N0"
        with self.assertRaisesRegex(R.Refused, "two groups"): R.resolve(r)

    def test_the_north_south_story_draws_two_groups_with_the_m49_names(self):
        s, *_ = R.resolve(req("st5")); c = s["composition"]
        self.assertEqual(c["scene"].split(".")[1], "groups"); self.assertEqual([g["name"] for g in c["groups"]], ["Northern Europe", "Southern Europe"])
        self.assertEqual([(g["lit"], g["total"]) for g in c["groups"]], [(6, 7), (3, 7)])
        m49 = json.load(open(os.path.join(ROOT, "runtime", "pi", "assets", "m49-regions.json")))["regions"]
        self.assertEqual({g["key"]: g["name"] for g in c["groups"]}, {k: m49[k]["name_en"] for k in ("154", "039")}, "the names are the M49 data's")


class EnergyObjects(unittest.TestCase):
    ENERGY = ("en_solar", "en_hydro", "en_grid", "en_biomass", "st4")

    def objs(self, r): return tuple(R.resolve(r)[0]["composition"]["units"])

    def test_a_different_finding_subject_in_energy_draws_a_different_object_set(self):
        sets = {n: self.objs(req(n)) for n in self.ENERGY}
        self.assertEqual(sets["en_solar"], ("solar_unit",)); self.assertEqual(sets["en_hydro"], ("dam_unit",))
        self.assertEqual(sets["en_grid"], ("pylon_unit",)); self.assertEqual(sets["en_biomass"], ("biomass_unit",))
        self.assertEqual(len(set(sets.values())), 5, sets)
        self.assertEqual(set(sets["st4"]), {"turbine_unit", "solar_unit", "dam_unit", "biomass_unit", "pylon_unit"}, "a share of renewables is a mix")

    def test_the_family_decides_when_no_measure_key_is_given(self):
        base = req("st4"); base["subject"] = {k: v for k, v in base["subject"].items() if k != "measure"}
        got = {f: self.objs({**base, "family": f}) for f in ("installed_capacity", "electricity_price", "electricity_mix", "renewable_share")}
        self.assertEqual(got["installed_capacity"], ("turbine_unit",)); self.assertEqual(got["electricity_price"], ("pylon_unit",))
        self.assertEqual(got["electricity_mix"], got["renewable_share"]); self.assertGreater(len(got["renewable_share"]), 1)
        self.assertEqual(self.objs({**base, "subject": {**base["subject"], "measure": "hydro"}}), ("dam_unit",), "the measure key beats the family")

    def test_the_mix_follows_the_layout_and_the_five_story_questions_draw_five_object_sets(self):
        sets = {n: self.objs(req(n)) for n in ("st1", "st2", "st3", "st4", "st5")}
        self.assertEqual(sets["st1"], ("turbine_unit",)); self.assertEqual(sets["st2"], ("dam_unit",)); self.assertEqual(sets["st3"], ("biomass_unit",))
        self.assertEqual(len(set(sets["st4"])), 5); self.assertEqual(sets["st5"], ("solar_unit",))
        self.assertEqual(len({sets[n] for n in ("st1", "st2", "st3", "st4", "st5")}), 5)

    def test_an_unknown_measure_key_is_refused(self):
        r = req("st4"); r["subject"] = {**r["subject"], "measure": "tidal"}
        with self.assertRaisesRegex(R.Refused, "tidal"): R.resolve(r)

    def test_other_topics_keep_their_one_unit(self):
        self.assertEqual(self.objs(req("em_tally")), ("stack_unit",)); self.assertEqual(self.objs(req("pop_tally")), ("figure_unit",))

    def test_the_mapping_is_data_and_every_object_is_a_part(self):
        import parts as P
        ob = T["scenes"]["energy"]["objects"]
        fns = set(ob["measure"].values()) | {f for l in ob["mix"].values() for f in l}
        for fn in fns: self.assertTrue(callable(getattr(P, fn)), fn); self.assertIn(fn, T["units"], fn)
        for key in ob["family"].values(): self.assertTrue(key == "mix" or key in ob["measure"], key)
        self.assertEqual(set(ob["mix"]), set(R.LAYOUTS))
        self.assertEqual(set(T["cameras"]) - {"default"}, {"tally", "groups"}); self.assertTrue(set(ob["family"]) <= set(T["families"]))
        for fn, u in T["units"].items(): self.assertTrue(u["mark_z"] > 0 and 0.3 < u["k"] <= 1 and 0.3 < u["tally_k"] <= 1 and 0.3 < u["row_k"] <= 1 and 0.5 <= u["groups_k"] <= 2, fn)
        src = open(os.path.join(HERO, "scene_node.py")).read()
        for fn in T["units"]: self.assertIn(f'"{fn}": "size"', src, f"{fn} casts no shadow: scene_node SHADOW_H")


class Figures(unittest.TestCase):
    def test_a_person_is_a_stick_figure_whose_lit_one_raises_the_arms(self):
        import parts as P
        on, off = P.figure_unit(size=1.0, lit=True)[0], P.figure_unit(size=1.0, lit=False)[0]
        self.assertEqual((on.group, off.group), ("lit", "thing"))
        top = lambda m: max(v[2] for v in m.v)
        self.assertGreater(top(on), top(off) - 1e-9); self.assertGreater(on.bounds()[0][1] - on.bounds()[0][0], off.bounds()[0][1] - off.bounds()[0][0], "arms up are wider than arms down")
        self.assertLess(on.bounds()[1][1] - on.bounds()[1][0], 0.3 * 28, "a flat pictogram, not a pin")
        self.assertGreater(len(on.v), 80, "head, torso, two arms, two legs")


class Compositions(unittest.TestCase):
    NAMES = ("st1", "st2", "st3", "st4", "st5")

    def test_any_two_of_the_five_story_questions_differ(self):
        sigs = {n: sig(req(n)) for n in self.NAMES}
        for i, a in enumerate(self.NAMES):
            for b in self.NAMES[i + 1:]: self.assertNotEqual(sigs[a][:3], sigs[b][:3], f"{a} and {b} share a composition {sigs[a]}")
        self.assertEqual(len({s[0] for s in sigs.values()}), 5, "five questions, five scene ids")
        self.assertEqual({n: sigs[n][0].split(".")[1] for n in self.NAMES}, {"st1": "path", "st2": "rank", "st3": "series", "st4": "tally", "st5": "groups"})

    def test_the_same_rows_under_another_finding_or_topic_compose_differently(self):
        base = req("st4"); pair = req("st4", lead="ends"); rank = req("st4", lead="rank"); other = req("st4", family="co2")
        for r in (pair, rank): r["subject"] = {"members": base["subject"]["members"]}
        s = {sig(base)[:3], sig(pair)[:3], sig(rank)[:3], sig(other)[:3]}
        self.assertEqual(len(s), 4)

    def test_the_same_input_gives_the_same_scene(self):
        for n in SPECS: self.assertEqual(R.resolve(req(n))[0], R.resolve(req(n))[0], n)

    def test_the_lead_decides_the_kind(self):
        for angle, kind in T["angle_kinds"].items():
            self.assertIn(kind, R.LAYOUTS, angle); self.assertIn(angle, R.REG["stories"]["angles"], angle)
        self.assertEqual(set(T["kind_arcs"]), set(R.LAYOUTS))

    def test_the_pair_sizes_follow_the_values(self):
        near = {"family": "co2", "lead": "ends", "width": 1140, "subject": {"members": [{"code": c, "value": v} for c, v in zip("ABCD", (10, 8, 7, 6))]}}
        p = R.resolve(near)[0]["items"]; self.assertAlmostEqual(p[1]["args"]["size"] / p[0]["args"]["size"], 0.6, places=3)   # above the floor: exact

    def test_every_spec_composes(self):
        for n, sp in SPECS.items(): self.assertTrue(sig(req(n)), n)

    def test_the_old_request_without_a_subject_is_unchanged(self):
        s, *_ = R.resolve({"tags": ["wind", "grid"], "hero": "wind", "width": 1140, "ground": "warm", "accent": "#1a9a6c", "lead": "rank"})
        self.assertEqual(s["scene"], "lineup"); self.assertNotIn("composition", s)


if __name__ == "__main__":
    unittest.main()
