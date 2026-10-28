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
                  (5, (0, 3, 1), "x"), (1, (0, 3, 0), "x"), (1, (3, 0, 1), "x")]:
            with self.assertRaises(SystemExit):
                knobs.knob("n", "k", t)

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


if __name__ == "__main__":
    unittest.main()
