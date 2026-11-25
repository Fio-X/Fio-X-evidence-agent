"""Self-test of the opening illustration's child (runtime/illus_hero/run_hero.py): the request is validated against the registry
(node.json) and resolved into a scene without Blender; two topics (a renewables story with a wind hero, a gas story with a valve
hero) resolve to different part lists, cameras and focus points; a wrong request is refused in words (unknown tag or knob, a hero
without its tag, a value outside its range, a bad width); a missing Blender answers `unavailable`, never an error; with Blender
installed (skipped otherwise) one picture is drawn end to end and holds only the shapes a hero may hold, inside the deadline.
Run: python3 -I -B scripts/test_illus_hero.py"""
import io
import json
import os
import re
import sys
import unittest
from xml.dom import minidom

HERE = os.path.dirname(os.path.abspath(__file__))
HERO = os.path.join(HERE, "..", "runtime", "illus_hero")
sys.path.insert(0, HERO)
import run_hero as R  # noqa: E402

RENEW = {"tags": ["wind", "solar", "hydro", "coal", "grid"], "hero": "wind", "width": 1140, "ground": "warm", "accent": "#1a9a6c"}
GAS = {"tags": ["gas", "grid", "coal"], "hero": "gas", "width": 1140, "ground": "cool", "accent": "#d9822b", "composition": {"relief": 0.5}}


def parts(scene): return [i["part"] for i in scene["items"]]


class Resolve(unittest.TestCase):
    def test_two_topics_two_scenes(self):
        a, pal_a, acc_a, _ = R.resolve(RENEW); b, pal_b, acc_b, _ = R.resolve(GAS)
        self.assertEqual(parts(a)[-1], "hero_turbine"); self.assertEqual(parts(b)[-1], "gas_valve_hero")
        self.assertIn("arch_dam", parts(a)); self.assertNotIn("arch_dam", parts(b)); self.assertNotIn("solar_array", parts(b)); self.assertNotIn("wind_turbine", parts(b))
        self.assertIn("coal_plant", parts(b)); self.assertIn("pylon", parts(b))
        self.assertNotEqual(pal_a, pal_b); self.assertEqual((acc_a, acc_b), ("#1a9a6c", "#d9822b"))
        self.assertEqual(b["relief"], 0.5); self.assertEqual(a["w"], 2880)
        self.assertEqual(len(a["hero"]["focus_local"]), 3)

    def test_focus_scale_scales_the_hero_only(self):
        big, *_ = R.resolve({**RENEW, "composition": {"focus_scale": 1.3}}); one, *_ = R.resolve(RENEW)
        hb, ho = big["items"][-1]["args"], one["items"][-1]["args"]
        self.assertAlmostEqual(hb["height"], ho["height"] * 1.3); self.assertEqual(big["items"][0], one["items"][0])

    def test_mirror_flips_x_and_yaw(self):
        m, *_ = R.resolve({**RENEW, "composition": {"reading_order": "right_to_left"}}); o, *_ = R.resolve(RENEW)
        self.assertTrue(m["mirror"]); self.assertEqual(m["camera"]["loc"][0], -o["camera"]["loc"][0])
        mp = next(i for i in m["items"] if i["part"] == "pylon"); op = next(i for i in o["items"] if i["part"] == "pylon")
        self.assertEqual(mp["at"][0], -op["at"][0]); self.assertEqual(mp["args"]["yaw"], -op["args"]["yaw"])
        mr = next(i for i in m["items"] if i["part"] == "reservoir")["args"]; orr = next(i for i in o["items"] if i["part"] == "reservoir")["args"]
        self.assertEqual((mr["x0"], mr["x1"]), (-orr["x1"], -orr["x0"]))

    def test_part_knob_override_is_taken_and_clamped(self):
        s, *_ = R.resolve({**RENEW, "parts": {"solar_array": {"rows": 2}}})
        self.assertEqual(next(i for i in s["items"] if i["part"] == "solar_array")["args"]["rows"], 2)
        with self.assertRaises(R.Refused): R.resolve({**RENEW, "parts": {"solar_array": {"rows": 40}}})

    def test_no_lead_keeps_the_panorama(self):
        a, *_ = R.resolve(RENEW); self.assertEqual(a["scene"], "panorama")

    def test_each_lead_has_its_own_scene(self):
        """The same table under different lead findings: a different hero place, camera or part list each time, and the same
        input gives the same scene twice (nothing random)."""
        seen = {}
        for lead, scene in R.REG["stories"]["angles"].items():
            s, *_ = R.resolve({**RENEW, "lead": lead}); again, *_ = R.resolve({**RENEW, "lead": lead})
            self.assertEqual(s, again); self.assertEqual(s["scene"], scene)
            key = json.dumps([s["camera"], s["hero"], parts(s)], sort_keys=True)
            seen.setdefault(scene, key); self.assertEqual(seen[scene], key)
        self.assertEqual(len(set(seen.values())), len(seen))
        self.assertGreaterEqual(len(seen), 5)

    def test_scene_heroes_and_parts(self):
        road, *_ = R.resolve({**RENEW, "lead": "path"}); rank, *_ = R.resolve({**RENEW, "lead": "rank"}); chain, *_ = R.resolve({**RENEW, "lead": "chain"})
        self.assertEqual(parts(road)[-1], "target_flag"); self.assertIn("track", parts(road)); self.assertIn("pylon", parts(road))
        self.assertEqual(road["items"][-1]["args"]["split"], "hero")
        self.assertEqual(parts(rank)[-1], "hero_turbine"); self.assertEqual(set(parts(rank)), {"wind_turbine", "hero_turbine", "track"})   # the row stands on one baseline
        self.assertEqual(set(parts(chain)), {"coal_plant", "pylon", "solar_array", "hero_turbine", "track"})   # the stations along one track
        need, *_ = R.resolve({**RENEW, "lead": "need"}); self.assertIn("target_flag", parts(need)[:-1])

    def test_a_scene_the_tags_cannot_hold_keeps_the_panorama(self):
        g, *_ = R.resolve({**GAS, "lead": "rank"}); self.assertEqual(g["scene"], "panorama"); self.assertEqual(parts(g)[-1], "gas_valve_hero")
        road, *_ = R.resolve({**GAS, "lead": "path"}); self.assertEqual(road["scene"], "road")   # the gas tables have a grid: the marker is no topic's
        name, _, why = R.pick_scene({**GAS, "lead": "rank"}, GAS["tags"]); self.assertEqual(name, "panorama"); self.assertIn("wind", why)

    def test_the_relief_a_request_gives_beats_the_scene(self):
        s, *_ = R.resolve({**RENEW, "lead": "rank"}); self.assertEqual(s["relief"], R.REG["scenes"]["lineup"]["relief"])
        s, *_ = R.resolve({**RENEW, "lead": "rank", "composition": {"relief": 1.2}}); self.assertEqual(s["relief"], 1.2)

    def test_mirror_flips_a_track(self):
        m, *_ = R.resolve({**RENEW, "lead": "path", "composition": {"reading_order": "right_to_left"}}); o, *_ = R.resolve({**RENEW, "lead": "path"})
        mt = next(i for i in m["items"] if i["part"] == "track")["args"]["points"]; ot = next(i for i in o["items"] if i["part"] == "track")["args"]["points"]
        self.assertEqual(mt, [[-x, y] for x, y in ot])

    def test_the_three_newer_angles_open_on_their_own_scenes_in_the_lagging_arc(self):
        """movers (who changed most) climbs the steps, overtake (who passed whom) lines the members up, tiles (one tile per member) lays out
        the atlas; each gives the same scene twice, keeps its leader dots, and all three are drawn on the lagging arc's ground."""
        want = {"movers": "steps", "overtake": "lineup", "tiles": "atlas"}
        with open(os.path.join(HERE, "..", "runtime", "leaves_py", "findings.py")) as f: src = f.read()
        arc_of = eval(re.search(r"^ARC_OF = (\{.*?\})\n", src, re.M | re.S).group(1))
        for lead, scene in want.items():
            s, *_ = R.resolve({**RENEW, "lead": lead}); again, *_ = R.resolve({**RENEW, "lead": lead})
            self.assertEqual(s, again); self.assertEqual(s["scene"], scene, lead)
            self.assertGreaterEqual(len([i for i in s["items"] if i.get("mark")]), 2, lead)
            self.assertEqual(arc_of[lead], "lagging")
        A = R.REG["stories"]["arc_grounds"]; pal = lambda lead: R.resolve({**RENEW, "lead": lead})[1]
        for lead in want: self.assertEqual(pal(lead), A["lagging"]["warm"], lead)   # the steps scene is the on-time story's too, but the movers' ground is the lagging one
        self.assertEqual(pal("need"), A["in_time"]["warm"])
        # every angle's ground arc (its own, else its scene's) is the arc the findings give the angle
        for lead, scene in R.REG["stories"]["angles"].items():
            self.assertEqual(R.REG["stories"].get("angle_arcs", {}).get(lead, R.REG["scenes"][scene]["arc"]), arc_of[lead], lead)

    def test_every_story_angle_has_a_scene(self):
        """The angles the findings child names (findings.py ANGLES) are the angles the registry maps, so no lead the flow sends is refused."""
        with open(os.path.join(HERE, "..", "runtime", "leaves_py", "findings.py")) as f: src = f.read()
        names = re.search(r"^ANGLES = \[(.*)\]$", src, re.M).group(1)
        self.assertEqual(sorted(n.strip()[len("angle_"):] for n in names.split(",")), sorted(R.REG["stories"]["angles"]))
        for scene in R.REG["stories"]["angles"].values(): self.assertIn(scene, R.REG["scenes"])

    def test_each_story_arc_has_its_own_ground(self):
        """The arc of the lead's scene picks the ground's tone inside the named family: scenes of one arc share it, the three arcs differ,
        the panorama keeps the plain palette, cool stays cool, and colours a request gives stand as given under any scene."""
        A = R.REG["stories"]["arc_grounds"]; pal = lambda inp: R.resolve(inp)[1]
        happened, in_time, lagging = pal({**RENEW, "lead": "chain"}), pal({**RENEW, "lead": "path"}), pal({**RENEW, "lead": "rank"})
        self.assertEqual(len({json.dumps(x, sort_keys=True) for x in (happened, in_time, lagging)}), 3)
        self.assertEqual((happened, in_time, lagging), (A["happened"]["warm"], A["in_time"]["warm"], A["lagging"]["warm"]))
        self.assertEqual(pal({**RENEW, "lead": "need"}), in_time)
        for lead in ("spread", "ends", "members", "map", "movers", "overtake", "tiles"): self.assertEqual(pal({**RENEW, "lead": lead}), lagging)
        self.assertEqual(pal(RENEW), R.REG["palettes"]["warm"]); self.assertEqual(pal({k: v for k, v in RENEW.items() if k != "ground"}), R.REG["palettes"]["warm"])
        self.assertEqual(pal({**RENEW, "lead": "chain", "ground": "cool"}), A["happened"]["cool"])
        g = {"dark": [20, 30, 40], "mid": [60, 80, 90], "light": [120, 140, 150], "line": [5, 10, 15]}
        self.assertEqual(pal({**RENEW, "lead": "chain", "ground": g}), g)

    def test_arc_grounds_are_complete_and_readable(self):
        """Every scene names an arc with a warm and a cool ground; on each, the ink line reads on the ground (contrast 3:1 or more over
        the mid tone, WCAG relative luminance), the tones run dark < mid < light, and no arc is the old deep brown."""
        A = R.REG["stories"]["arc_grounds"]
        lum = lambda c: sum(k * ((v / 255) / 12.92 if v / 255 <= 0.04045 else ((v / 255 + 0.055) / 1.055) ** 2.4) for k, v in zip((0.2126, 0.7152, 0.0722), c))
        for name, sc in R.REG["scenes"].items(): self.assertIn(sc.get("arc"), A, name)
        for arc, fams in A.items():
            self.assertEqual(set(fams), {"warm", "cool"})
            for fam, p in fams.items():
                self.assertEqual(set(p), {"dark", "mid", "light", "line"})
                self.assertLess(lum(p["dark"]), lum(p["mid"])); self.assertLess(lum(p["mid"]), lum(p["light"]))
                self.assertGreaterEqual((lum(p["mid"]) + 0.05) / (lum(p["line"]) + 0.05), 3.0, (arc, fam))
                self.assertNotEqual(p["mid"], R.REG["palettes"]["warm"]["mid"])

    def test_marks_sit_on_their_parts(self):
        """A leader mark stands over its part (its foot is the part's place), its height follows the part's knobs, it mirrors with the
        reading order, and the panorama draws none; every scene marks its hero or at least two parts, so the reading order has dots."""
        for lead in R.REG["stories"]["angles"]:
            s, *_ = R.resolve({**RENEW, "lead": lead}); ms = [i for i in s["items"] if i.get("mark")]
            self.assertGreaterEqual(len(ms), 2, lead)
            for i in ms:
                self.assertEqual(set(i["mark"]), {"at", "z", "rise"}); self.assertGreater(i["mark"]["z"], 0); self.assertTrue(10 <= i["mark"]["rise"] <= 80)
                if "at" in i: self.assertEqual(i["mark"]["at"], i["at"])
        pano, *_ = R.resolve(RENEW); self.assertFalse([i for i in pano["items"] if i.get("mark")])
        one, *_ = R.resolve({**RENEW, "lead": "chain"}); big, *_ = R.resolve({**RENEW, "lead": "chain", "composition": {"focus_scale": 1.3}})
        self.assertGreater(big["items"][-1]["mark"]["z"], one["items"][-1]["mark"]["z"])
        m, *_ = R.resolve({**RENEW, "lead": "map", "composition": {"reading_order": "right_to_left"}}); o, *_ = R.resolve({**RENEW, "lead": "map"})
        self.assertEqual([i["mark"]["at"] for i in m["items"] if i.get("mark")], [[-i["mark"]["at"][0], i["mark"]["at"][1]] for i in o["items"] if i.get("mark")])

    def test_steps_scene_is_a_stair(self):
        """The steps scene stands its turbines on stone steps that rise left to right, the marker's step the tallest; a step's knob outside
        its range is refused."""
        s, *_ = R.resolve({**RENEW, "lead": "need"}); steps = [i for i in s["items"] if i["part"] == "plinth"]
        self.assertGreaterEqual(len(steps), 5)
        xs = [i["at"][0] for i in steps]; hs = [i["args"]["height"] for i in steps]
        self.assertEqual(xs, sorted(xs)); self.assertEqual(hs, sorted(hs)); self.assertEqual(s["shadow"], R.REG["contact_shadow"])
        with self.assertRaises(R.Refused): R.resolve({**RENEW, "lead": "need", "parts": {"plinth": {"height": 90}}})

    def test_ground_can_be_given_as_colours(self):
        g = {"dark": [20, 30, 40], "mid": [60, 80, 90], "light": [120, 140, 150], "line": [5, 10, 15]}
        _, pal, *_ = R.resolve({**RENEW, "ground": g}); self.assertEqual(pal, g)


class Refusals(unittest.TestCase):
    def refused(self, inp, *words):
        with self.assertRaises(R.Refused) as c: R.resolve(inp)
        for w in words: self.assertIn(w, str(c.exception))

    def test_unknown_tag(self): self.refused({**RENEW, "tags": ["wind", "nuclear"]}, "nuclear")
    def test_no_tags(self): self.refused({**RENEW, "tags": []}, "tags")
    def test_hero_needs_its_tag(self): self.refused({**RENEW, "tags": ["coal"]}, "needs tag wind")
    def test_unknown_composition_knob(self): self.refused({**RENEW, "composition": {"wobble": 1}}, "wobble")
    def test_unknown_part_and_knob(self):
        self.refused({**RENEW, "parts": {"moon": {}}}, "moon"); self.refused({**RENEW, "parts": {"pylon": {"colour": 1}}}, "colour")
    def test_out_of_range(self): self.refused({**RENEW, "composition": {"focus_scale": 2.5}}, "focus_scale")
    def test_unknown_lead(self): self.refused({**RENEW, "lead": "weather"}, "weather", "no story angle")
    def test_bad_ground_and_accent(self):
        self.refused({**RENEW, "ground": "green"}, "ground"); self.refused({**RENEW, "accent": "green"}, "accent")
    def test_width(self):
        for w in (None, 100, 5000, 1140.5, True, 1140.5e3):
            with self.assertRaises(R.Refused): R.build({**RENEW, "width": w}, "/nonexistent")


class Protocol(unittest.TestCase):
    def ask(self, inp):
        old = sys.stdin, sys.stdout
        sys.stdin, sys.stdout = io.StringIO(json.dumps(inp) + "\n"), io.StringIO()
        try: R.serve(); return json.loads(sys.stdout.getvalue())
        finally: sys.stdin, sys.stdout = old

    def test_refused_reply(self):
        r = self.ask({**RENEW, "tags": ["nuclear"]}); self.assertEqual(list(r), ["refused"]); self.assertIn("nuclear", r["refused"][0])

    def test_not_json_is_refused(self):
        old = sys.stdin, sys.stdout; sys.stdin, sys.stdout = io.StringIO("not json\n"), io.StringIO()
        try: R.serve(); r = json.loads(sys.stdout.getvalue())
        finally: sys.stdin, sys.stdout = old
        self.assertIn("refused", r)

    def test_no_blender_is_unavailable_not_an_error(self):
        was = R.blender_path
        def none(): raise R.Unavailable("Blender is not installed")
        R.blender_path = none
        try: r = self.ask(RENEW)
        finally: R.blender_path = was
        self.assertEqual(r, {"unavailable": "Blender is not installed"})

    def test_a_slow_blender_is_unavailable(self):
        was, was_path = R.run, R.blender_path
        def slow(cmd, deadline): raise R.Unavailable(f"{os.path.basename(cmd[0])} took longer than {deadline:.0f} s")
        R.run = slow
        R.blender_path = lambda: "/nonexistent/Blender"      # a machine with no Blender (CI) still reaches the slow run
        try: r = self.ask(RENEW)
        finally: R.run, R.blender_path = was, was_path
        self.assertIn("took longer", r.get("unavailable", ""))


@unittest.skipUnless(R.blender_path.__call__ and any(os.path.isfile(p) for p in ("/Applications/Blender.app/Contents/MacOS/Blender", os.environ.get("BLENDER") or "")), "Blender is not installed")
class EndToEnd(unittest.TestCase):
    ALLOWED = {"g", "path", "image", "defs", "linearGradient", "stop", "mask"}

    def draw(self, inp):
        import time
        t = time.time(); r = Protocol().ask(inp); self.assertIn("svg", r, r); self.assertLess(time.time() - t, 60)
        return r

    def check(self, r, width):
        self.assertEqual(r["w"], float(width)); self.assertLess(len(r["svg"]), 4 * 1024 * 1024)
        self.assertNotIn("<text", r["svg"]); self.assertNotIn("<script", r["svg"]); self.assertNotRegex(r["svg"], r"https?:|on[a-z]+=\"")
        doc = minidom.parseString(f'<svg xmlns="http://www.w3.org/2000/svg">{r["svg"]}</svg>')
        names = {e.tagName for e in doc.getElementsByTagName("*")} - {"svg"}
        self.assertLessEqual(names, self.ALLOWED); self.assertTrue(r["svg"].startswith('<g transform="scale('))
        # the program's hero gate (src/next_leaf.rs) takes a path's d only of digits, space, comma, point, minus, e and the commands
        # M C L Q T Z H V (either case): an arc command (a leader dot drawn with one) stops the page, as st1 did on 11-23
        for d in re.findall(r'<path d="([^"]*)"', r["svg"]): self.assertRegex(d, r"^[0-9 ,.\-eEMCLQTZHVmclqtzhv]*$")

    def test_renewables_picture(self): self.check(self.draw(RENEW), 1140)
    def test_gas_picture(self): self.check(self.draw(GAS), 1140)

    def test_three_more_leads_three_more_pictures(self):
        """The stair, the pair and the atlas are drawn end to end too: shapes only (no text element), each its own picture, a leader
        line's dot (four curves, no arc command) in each, inside the deadline."""
        seen = set()
        for lead, scene in (("need", "steps"), ("ends", "pair"), ("map", "atlas")):
            r = self.draw({**RENEW, "lead": lead}); self.check(r, 1140); self.assertEqual(r["scene"], scene)
            self.assertRegex(r["svg"], r'd="M[0-9.,]+C[0-9.,]+C'); self.assertLess(r["seconds"]["total"], R.TOTAL_DEADLINE); seen.add(r["svg"])
        self.assertEqual(len(seen), 3)

    def test_a_picture_bound_to_the_finding_is_drawn_and_a_wrong_count_is_not(self):
        """A subject (rows, rule, declared count) is drawn end to end in its topic's scene and keeps the gate's shapes; the same rows with a
        declared count that is not the recomputed one are refused before Blender starts. (scripts/test_illus_vary.py holds the rest.)"""
        ms = [{"code": c, "value": v} for c, v in zip("ABCDEFGHIJ", (9, 8, 7, 6, 5, 4, 3, 2, 1.5, 1))]
        sub = {"members": ms, "rule": {"op": "ge", "ref": 5}, "declared": {"count": 5, "total": 10}}
        r = self.draw({"family": "co2", "lead": "members", "width": 1140, "ground": "warm", "subject": sub}); self.check(r, 1140)
        self.assertEqual(r["scene"], "emissions.tally"); self.assertEqual(r["composition"]["lit"], 5); self.assertEqual(r["composition"]["objects"], 10)
        bad = Protocol().ask({"family": "co2", "lead": "members", "width": 1140, "subject": {**sub, "declared": {"count": 6, "total": 10}}})
        self.assertIn("refused", bad); self.assertIn("declared.count 6", bad["refused"][0])

    def test_two_leads_two_pictures(self):
        a, b = self.draw({**RENEW, "lead": "path"}), self.draw({**RENEW, "lead": "chain"})
        self.check(a, 1140); self.check(b, 1140); self.assertEqual((a["scene"], b["scene"]), ("road", "sequence")); self.assertNotEqual(a["svg"], b["svg"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
