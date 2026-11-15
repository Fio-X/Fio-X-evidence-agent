"""Self-test of the sketch compare's choices (runtime/leaves_py/sketch.py, sketch.json) on the three sample shapes and the
short shapes beside them: each block's candidates by its relation and its data's hard conditions, the fixed score, and the
pick (one winner, or a tie the model breaks). Every node sketch.json registers is a leaf the runner draws.
Run: python3 -I -B scripts/test_leaves_sketch.py"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
import run  # noqa: E402
import sketch  # noqa: E402

DRAWN = {"lead_marked": True, "label_crowded": 0}


class Candidates(unittest.TestCase):
    def test_sample_a_rank_compare_lists_the_bars_and_the_rank_lines(self):
        a = {"periods": 1, "quantities": 3, "rank_flips": 2, "places": 10}
        self.assertEqual(sketch.candidates("Ranking", a), ["bars", "rank_lines"])
        self.assertEqual(sketch.candidates("Ranking", {**a, "rank_flips": 0}), ["bars"])  # no rank changes: no rank lines
        self.assertEqual(sketch.candidates("Ranking", {**a, "quantities": 1}), ["bars"])

    def test_sample_b_threshold_over_time_lists_the_line(self):
        self.assertEqual(sketch.candidates("Threshold", {"periods": 11, "places": 10}), ["line"])
        self.assertEqual(sketch.candidates("Threshold", {"periods": 1, "places": 10}), [])

    def test_sample_c_one_whole_lists_the_waterfall_and_the_waffle_by_its_parts(self):
        c = {"periods": 1, "places": 1, "parts": 4, "parts_add_up": True}
        self.assertEqual(sketch.candidates("Composition", c), ["waterfall"])  # four parts: past the waffle's three
        self.assertEqual(sketch.candidates("Composition", {**c, "parts": 3}), ["waterfall", "waffle"])
        self.assertEqual(sketch.candidates("Composition", {**c, "parts_add_up": False}), [])  # parts that do not add back
        self.assertEqual(sketch.candidates("Composition", {**c, "places": 8}), ["stacked100"])
        self.assertEqual(sketch.candidates("Composition", {**c, "periods": 10, "parts": 4}), ["stacked_area"])
        self.assertEqual(sketch.candidates("Flow", {}), ["sankey"])

    def test_change_by_its_periods(self):
        self.assertEqual(sketch.candidates("Change", {"periods": 2, "places": 6}), ["dumbbell"])
        self.assertEqual(sketch.candidates("Change", {"periods": 11, "places": 6}), ["line"])

    def test_a_condition_the_shape_does_not_show_is_not_met(self):
        self.assertEqual(sketch.candidates("Ranking", {"periods": 1, "quantities": 3}), ["bars"])  # rank flips unknown
        self.assertEqual(sketch.candidates("Composition", {"periods": 1, "places": 1, "parts": 3}), [])  # adding up unknown
        self.assertEqual(sketch.candidates("Nothing", {"periods": 1}), [])

    def test_at_most_three_the_strongest_encodings_kept(self):
        old = dict(sketch.DATA["nodes"])
        try:
            for i, enc in enumerate(["area", "position", "length", "color"]):
                sketch.DATA["nodes"][f"t{i}"] = {"relations": ["Test"], "encoding": enc, "needs": {}}
            self.assertEqual(sketch.candidates("Test", {}), ["t0", "t1", "t2"])  # color (0) is dropped, the order kept
        finally:
            sketch.DATA["nodes"].clear(); sketch.DATA["nodes"].update(old)


class Scores(unittest.TestCase):
    def test_the_fixed_score(self):
        self.assertEqual(sketch.score("rank_lines", DRAWN), 4 + 2)
        self.assertEqual(sketch.score("bars", DRAWN), 3 + 2)
        self.assertEqual(sketch.score("stacked100", DRAWN), 3 + 2 - 1)  # the reader compares segments
        self.assertEqual(sketch.score("waffle", {"lead_marked": False, "label_crowded": 2}), 1 - 2)

    def test_the_pick(self):
        a = {n: sketch.score(n, DRAWN) for n in sketch.candidates("Ranking", {"periods": 1, "quantities": 3, "rank_flips": 2})}
        self.assertEqual(sketch.best(a), ["rank_lines"])
        self.assertEqual(sketch.best({"waterfall": 6, "stacked_area": 6, "waffle": 3}), ["waterfall", "stacked_area"])  # a tie: the model picks
        self.assertEqual(sketch.best({}), [])

    def test_its_refusals(self):
        with self.assertRaises(ValueError):
            sketch.score("pie", DRAWN)
        for bad in (None, {"lead_marked": 1, "label_crowded": 0}, {"lead_marked": True, "label_crowded": -1}, {"lead_marked": True, "label_crowded": True}):
            with self.assertRaises(ValueError):
                sketch.score("bars", bad)
        with self.assertRaises(ValueError):
            sketch.meets({"colour_min": 1}, {})

    def test_every_registered_node_is_a_leaf_the_runner_draws(self):
        drawable = set(run.LEAF_LAYERS) | {"bars"}  # bars: the column page's own layer (column.COLUMN_LAYERS)
        self.assertEqual(sorted(set(sketch.DATA["nodes"]) - drawable), [])
        self.assertTrue(all(v["encoding"] in sketch.DATA["weights"] for v in sketch.DATA["nodes"].values()))


if __name__ == "__main__":
    unittest.main()
