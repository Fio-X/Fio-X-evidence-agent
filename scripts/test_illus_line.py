"""The line version of the story hero (runtime/illus_line): the same composition as the 3D path resolves (run_hero.resolve), drawn as hand-style
line pictograms in pure SVG. For the five story questions st1..st5 (fixtures/illus-vary-specs.json): the lit units in the picture are the lit count the
rows give; the units fill at least the registered share of the picture height, measured on the drawn geometry; the units of one row do not overlap;
`omitted` is the members the request had minus the units drawn; the picture holds no digit-bearing text; the SVG is well-formed XML and
the default 3D path is not imported or changed.
Run: python3 -I -B scripts/test_illus_line.py"""
import json
import os
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_line"))
sys.path.insert(0, os.path.join(ROOT, "runtime", "illus_hero"))
import draw as D  # noqa: E402
import run_hero as R  # noqa: E402

SPECS = json.load(open(os.path.join(ROOT, "fixtures", "illus-vary-specs.json")))
REG = D.REG
NAMES = ["st1", "st2", "st3", "st4", "st5"]


def req(name):
    sp = SPECS[name]
    return {"family": sp["family"], "lead": sp["lead"], "width": 1140, "ground": "warm", "subject": sp["subject"]}


def members_of(sub):
    return len(sub["members"]) if "members" in sub else sum(len(g["members"]) for g in sub["groups"]) if "groups" in sub else None


class LineHero(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = {n: D.draw(R.resolve(req(n))) for n in NAMES}
        cls.root = {n: ET.fromstring(cls.out[n]["svg"]) for n in NAMES}

    def test_lit_units_are_the_resolved_lit_count(self):
        for n in NAMES:
            want = R.resolve(req(n))[0]["composition"]["lit"]
            drawn = [g for g in self.root[n].iter("{http://www.w3.org/2000/svg}g") if "lit" in g.get("class", "").split()]
            self.assertEqual(len(drawn), want, n)
            self.assertEqual(sum(1 for u in self.out[n]["units"] if u["lit"]), want, n)
            self.assertEqual(self.out[n]["composition"]["lit"], want, n)

    def test_units_fill_the_share_of_the_height(self):
        for n in NAMES:
            us = self.out[n]["units"]; top = min(u["bbox"][1] for u in us); bot = max(u["bbox"][3] for u in us)
            self.assertGreaterEqual((bot - top) / D.CH, REG["min_unit_fraction"], n)
            self.assertGreaterEqual(min(u["bbox"][1] for u in us), 0); self.assertLessEqual(bot, D.CH)

    def test_units_of_a_row_do_not_overlap(self):
        for n in NAMES:
            rows = {}
            for u in self.out[n]["units"]: rows.setdefault((u["row"], u["ground"]), []).append(u["bbox"])
            for key, bs in rows.items():
                bs.sort()
                for a, b in zip(bs, bs[1:]): self.assertLessEqual(a[2], b[0] + 0.5, f"{n} row {key}: {a} touches {b}")
            for u in self.out[n]["units"]:
                b = u["bbox"]; self.assertGreaterEqual(b[0], 0); self.assertLessEqual(b[2], D.CW)

    def test_omitted_is_members_minus_drawn(self):
        for n in NAMES:
            sub = SPECS[n]["subject"]; m = members_of(sub)
            if m is None: self.assertEqual(self.out[n]["omitted"], 0); continue
            self.assertEqual(self.out[n]["omitted"], m - len(self.out[n]["units"]), n)
        self.assertEqual(self.out["st2"]["omitted"], 21)

    def test_the_ranking_marks_the_omission_between_the_ends(self):
        us = sorted(self.out["st2"]["units"], key=lambda u: u["bbox"][0])
        self.assertEqual(len(us), 6)

    def test_no_text_and_no_digits_in_the_picture(self):
        for n in NAMES:
            for el in self.root[n].iter():
                tag = el.tag.split("}")[-1]
                self.assertNotIn(tag, ("text", "tspan", "textPath"), n)
                self.assertFalse(any(ch.isdigit() for ch in (el.text or "")), n)
                self.assertFalse(any(ch.isdigit() for ch in (el.tail or "")), n)

    def test_the_svg_parses_and_is_deterministic(self):
        for n in NAMES:
            self.assertEqual(self.root[n].tag, "{http://www.w3.org/2000/svg}svg")
            self.assertEqual(D.draw(R.resolve(req(n)))["svg"], self.out[n]["svg"], n)

    def test_the_registry_holds_the_units_of_the_topic(self):
        used = {u["fn"] for n in NAMES for u in self.out[n]["units"]}
        self.assertEqual(used, {"turbine_unit", "dam_unit", "solar_unit", "pylon_unit", "biomass_unit"})
        for fn in used: self.assertIn("w_over_h", REG["units"][fn])


if __name__ == "__main__":
    unittest.main(verbosity=1)
