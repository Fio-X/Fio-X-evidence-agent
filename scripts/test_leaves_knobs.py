"""Self-test of the leaf registry (runtime/leaves_py/knobs.json): it is what runtime/leaves_py/knobs.py writes from the
prototype's KNOBS and pages today, and the writer stops on a knob whose kind it would have to guess or a page number
off its range.
Run: python3 -I -B scripts/test_leaves_knobs.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "leaves_py"))
import knobs  # noqa: E402


class Registry(unittest.TestCase):
    def test_the_file_is_what_the_writer_writes(self):
        with open(knobs.OUT, encoding="utf-8") as f:
            self.assertEqual(f.read(), knobs.text(), "knobs.json is stale: run python3 -I -B runtime/leaves_py/knobs.py")

    def test_a_knob_of_no_plain_kind_stops_the_writer(self):
        for t in [(2, ("a", "b"), "x"), ("a", (1, 2, 3), "x"), ("c", ("a", "b"), "x"), (True, (0, 1, 1), "x"),
                  (5, (0, 3, 1), "x"), (1, (0, 3, 0), "x"), (1, (3, 0, 1), "x"), ("DE", None, "x"), (0, None, "x")]:
            with self.assertRaises(SystemExit):
                knobs.knob("n", "k", t)
        self.assertEqual(knobs.knob("n", "k", ("", None, "x")), dict(name="k", default="", codes=True, what="x"))

    def test_each_legacy_node_says_where_it_reads(self):
        self.assertEqual(set(knobs.READS), set(knobs.prod.LEGACY))

    def test_a_page_word_joins_its_knob_with_its_source_and_a_page_number_must_fit(self):
        nodes = knobs.table()["nodes"]
        knobs.take(nodes, [dict(node="base", knob="sea", value="#010101", at="p.json hero.data.sea")])
        sea = next(k for k in nodes["base"]["knobs"] if k["name"] == "sea")
        self.assertEqual((sea["options"][-1], sea["pages"]["#010101"]), ("#010101", ["p.json hero.data.sea"]))
        for knob, value in [("bw", 2.5), ("bw", 0.55), ("bw", "#fff"), ("sea", 3), ("glow", 1)]:
            with self.assertRaises(SystemExit):
                knobs.take(nodes, [dict(node="base", knob=knob, value=value, at="p.json")])


    def test_a_recipe_holds_what_its_nodes_eat_and_exposes_only_real_knobs(self):
        t = knobs.table()
        self.assertEqual([r["name"] for r in t["recipes"]], ["scmp", "ring", "composition", "change", "column", "ranked_bars", "flow"])
        ring = next(r for r in knobs.RECIPES if r["name"] == "ring")
        for bad in [dict(ring, eats=["annual"]), dict(ring, layers=["map", "pie"]), dict(ring, exposes=["ring.glow"]),
                    dict(ring, same_measure=[["map", "pie"]]), dict(ring, same_measure=[["map", "map"]])]:
            with self.assertRaises(SystemExit):
                self._with(bad, t)

    def test_a_column_frame_recipe_declares_its_pages_main_layer(self):
        t = knobs.table()
        self.assertEqual({r["name"]: r.get("main") for r in t["recipes"]},
                         dict(scmp=None, ring=None, composition="stacked100", change="bars", column="bars", ranked_bars="bars", flow="sankey"))
        self.assertEqual(knobs.run.MAIN, dict(column="bars", change="bars", flow="sankey", composition="stacked100", ranked_bars="bars"))
        flow = next(r for r in knobs.RECIPES if r["name"] == "flow")
        ring = next(r for r in knobs.RECIPES if r["name"] == "ring")
        for bad in [dict(flow, main="bars"), {k: v for k, v in flow.items() if k != "main"}, dict(flow, layers=[]), dict(ring, main="map")]:
            with self.assertRaises(SystemExit) as e:
                self._with(bad, t)
            self.assertIn("main", str(e.exception))

    def test_a_shape_condition_comes_after_the_ones_it_reads(self):
        t = knobs.table()
        column = next(r for r in knobs.RECIPES if r["name"] == "column")
        self.assertEqual((column["layers"], t["groups"]["column"]),
                         (["bars", "bubbles", "leader_notes"], ["bignums", "bars", "section_head", "rankbar", "bubbles", "bubble_key", "leader_notes", "sankey", "stacked100"]))
        for eats in (["annual", "last_year", "one_place", "one_unit"], ["annual", "one_unit", "monthly_companion", "hub_origin"]):
            with self.assertRaises(SystemExit) as e:
                self._with(dict(column, layers=[], eats=eats), t)
            self.assertIn("name it before", str(e.exception))
        # two_ends reads the last year, which reads the place: named before it, or it can only refuse
        change = next(r for r in knobs.RECIPES if r["name"] == "change")
        self.assertEqual(change["eats"][-2:], ["last_year", "two_ends"])
        with self.assertRaises(SystemExit) as e:
            self._with(dict(change, layers=[], eats=["annual", "one_place", "two_ends", "last_year"]), t)
        self.assertIn("name it before", str(e.exception))

    def test_a_recipe_that_draws_the_bubbles_draws_their_key_right_after_them(self):
        # knobs.WITH: the key to the circles comes with the bubbles in every recipe that draws them (column and change), right
        # after them, and in none that does not (scmp, ring); it eats what the bubbles eat; a recipe naming it itself refuses
        t = knobs.table()
        layers = {r["name"]: r["layers"] for r in t["recipes"]}
        for name, ls in layers.items():
            if "bubbles" in ls: self.assertEqual(ls[ls.index("bubbles") + 1], "bubble_key", name)
            else: self.assertNotIn("bubble_key", ls, name)
        self.assertEqual((layers["column"], layers["change"]), (["bars", "bubbles", "bubble_key", "leader_notes"], ["bubbles", "bubble_key", "bars", "leader_notes"]))
        self.assertEqual((layers["scmp"], layers["ring"]), (["map", "strip", "bignums", "notes"], ["map", "ring", "callouts", "legend", "inset"]))
        self.assertEqual(t["nodes"]["bubble_key"]["eats"], t["nodes"]["bubbles"]["eats"])
        self.assertEqual([k["name"] for k in t["nodes"]["bubble_key"]["knobs"]], ["size", "count", "width"])
        column = next(r for r in knobs.RECIPES if r["name"] == "column")
        with self.assertRaises(SystemExit) as e:
            self._with(dict(column, layers=["bars", "bubbles", "bubble_key", "leader_notes"]), t)
        self.assertIn("which its layers bring (WITH)", str(e.exception))

    def test_every_layer_of_every_recipe_is_asked_or_prints_only(self):
        t = knobs.table()
        for r in t["recipes"]:
            knobs.none_left(r)
            print("recipe", r["name"], "external", r["external"], "prints only", [l for l in r["layers"] if l not in r["external"]])
        scmp = next(r for r in t["recipes"] if r["name"] == "scmp")
        with self.assertRaises(SystemExit) as e:
            knobs.none_left(dict(scmp, external=["strip", "bignums", "notes"]))
        self.assertIn("layers ['map'] are neither bound external", str(e.exception))

    def _with(self, recipe, t):
        saved = knobs.RECIPES[:]
        knobs.RECIPES[:] = [recipe]
        try:
            knobs.recipes(t["nodes"], t["groups"])
        finally:
            knobs.RECIPES[:] = saved


if __name__ == "__main__":
    unittest.main()
