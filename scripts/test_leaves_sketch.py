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


def cell(place, period, quantity, value):
    return {"place": place, "period": period, "quantity": quantity, "value": value}


class Shapes(unittest.TestCase):
    def test_places_by_quantities_one_year(self):  # sample A's shape: places ranked by three quantities in one year
        pop = {"IND": 1450, "CHN": 1410, "USA": 340, "IDN": 280}
        gdp = {"IND": 3.9, "CHN": 18.7, "USA": 29.2, "IDN": 1.4}
        cells = [cell(p, "2024", "POP", v) for p, v in pop.items()] + [cell(p, "2024", "GDP", v) for p, v in gdp.items()]
        got = sketch.shape(cells)
        # pairs in the other order by GDP: IND-CHN, IND-USA, CHN-USA (the three pairs with IDN keep their order)
        self.assertEqual(got, {"places": 4, "periods": 1, "quantities": 2, "rank_flips": 3})
        self.assertEqual(sketch.candidates("Ranking", got), ["bars", "rank_lines"])
        same = cells[:4] + [cell(p, "2024", "GDP", v / 100) for p, v in pop.items()]
        self.assertEqual(sketch.shape(same)["rank_flips"], 0)

    def test_places_over_years(self):  # sample B's shape: one quantity over eleven years
        cells = [cell(p, str(2014 + i), "RATE", base + i * step) for p, base, step in (("DEU", 2.0, 0.1), ("FRA", 3.0, -0.2)) for i in range(11)]
        got = sketch.shape(cells)
        self.assertEqual(got, {"places": 2, "periods": 11, "quantities": 1, "rank_flips": 1})  # FRA above in 2014, below in 2024
        self.assertEqual(sketch.candidates("Change", got), ["line"])
        self.assertEqual(sketch.candidates("Change", sketch.shape([c for c in cells if c["period"] in ("2014", "2024")])), ["dumbbell"])

    def test_parts_of_a_whole(self):  # sample C's shape: one place's whole and its parts in one year
        parts = {"O4000XBIO": 75.6, "E7000": 40.3, "G3000": 33.9, "REST": 27.9}
        cells = [cell("EU27", "2024", c, v) for c, v in parts.items()]
        got = sketch.shape(cells, whole=[{"place": "EU27", "period": "2024", "value": 177.7}])
        self.assertEqual(got, {"places": 1, "periods": 1, "quantities": 4, "rank_flips": 0, "parts": 4, "parts_add_up": True})
        self.assertEqual(sketch.candidates("Composition", got), ["waterfall"])
        self.assertFalse(sketch.shape(cells, whole=[{"place": "EU27", "period": "2024", "value": 190.0}])["parts_add_up"])
        self.assertFalse(sketch.shape(cells, whole=[{"place": "EU27", "period": "2023", "value": 177.7}])["parts_add_up"])  # no whole that year
        self.assertFalse(sketch.shape(cells[:-1] + [cell("FRA", "2024", "REST", 1.0)],
                                      whole=[{"place": "EU27", "period": "2024", "value": 177.7}, {"place": "FRA", "period": "2024", "value": 1.0}])["parts_add_up"])  # parts missing
        self.assertNotIn("parts_add_up", sketch.shape(cells))  # no whole given: adding up unknown

    def test_a_cell_that_is_not_a_cell(self):
        for bad in ({"place": "DEU", "period": "2024", "value": 1.0}, cell("DEU", "2024", "X", "1.0"), cell("DEU", "2024", "X", True)):
            with self.assertRaises(ValueError):
                sketch.shape([bad])


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
