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
        was = R.run
        def slow(cmd, deadline): raise R.Unavailable(f"{os.path.basename(cmd[0])} took longer than {deadline:.0f} s")
        R.run = slow
        try: r = self.ask(RENEW)
        finally: R.run = was
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

    def test_renewables_picture(self): self.check(self.draw(RENEW), 1140)
    def test_gas_picture(self): self.check(self.draw(GAS), 1140)


if __name__ == "__main__":
    unittest.main(verbosity=1)
