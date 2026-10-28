"""Self-test of the leaf registry (runtime/leaves_py/knobs.json): it is what runtime/leaves_py/knobs.py writes from the
prototype's KNOBS today, and the writer stops on a knob whose kind it would have to guess.
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


if __name__ == "__main__":
    unittest.main()
