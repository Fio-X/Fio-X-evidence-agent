"""With a ledger, a leaf prints every number from it: a row value exactly on a half (2.675 at two places, which binary
float rounding prints 2.67 and the ledger's exact decimal rounding, GB/T 8170, prints 2.68) goes through prod.py's
Ctx.n, step(), timeline() and profile(), and step() and profile() print the ledger's text marked with its src; Ctx.n (a raw value, no entry)
and timeline() (free-word years) refuse; nothing prints a number of its own. Run: python3 -I scripts/test_leaves_ledger_half.py"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "leaves_py"))
import facts as FX  # noqa: E402
import prod  # noqa: E402

HALF = "2.675"  # float 2.67499999999999982236431605997495353221893310546875
LEDGER_TEXT = "2.68"  # next_facts::fixed_exact on 2675/1000 at 2 places: the tie goes to the even digit 8


def spec(times):
    return {
        "tables": {"t": {}},
        "facts": {"a": {"table": "t", "time": times[0], "fmt": "k"}},
        "fmts": {"k": {"dec": 2}, "time": {}},
    }


def rows(times):
    return {"t": [{"TIME_PERIOD": t, "OBS_VALUE": HALF if i == 0 else "1.5"} for i, t in enumerate(times)]}


def marked_out(svg):
    """The page's visible text with every ledger-marked run (an element carrying data-src) dropped, then the tags."""
    svg = re.sub(r"<(\w+)[^>]*data-src=[^>]*>[^<]*</\1>", "", svg)
    svg = re.sub(r"<title>.*?</title>", "", svg)
    return re.sub(r"<[^>]*>", "", svg)


class LedgerHalf(unittest.TestCase):
    def setUp(self):
        self.times = ["2024-01", "2024-02", "2024-03"]
        FX.TABLES = rows(self.times)
        FX.LEDGER = {"fact:a.n": LEDGER_TEXT, "fact:a.t.y": "2024", "fact:a.t.m": "1", "period:t:2024": "2024"}
        self.c = prod.Ctx(spec(self.times))

    def tearDown(self):
        FX.TABLES = None
        FX.LEDGER = None

    def test_the_row_is_exactly_on_a_half(self):
        self.assertEqual(self.c.F["a"]["v"], 2.675)
        self.assertEqual(f'{self.c.F["a"]["v"]:.2f}', "2.67", "binary rounding: the case the ledger prints otherwise")

    def test_ctx_n_prints_no_number_of_its_own(self):
        """A raw value has no ledger entry: with a ledger Ctx.n refuses; without one the prototype formats as before."""
        with self.assertRaises(FX.Refused):
            self.c.n(self.c.F["a"]["v"], "k")
        FX.LEDGER = None
        self.assertEqual(self.c.n(self.c.F["a"]["v"], "k"), "2.67")

    def test_step_prints_the_mark_from_the_ledger(self):
        svg = prod.step(self.c, {"q": {"table": "t"}, "mark": ["a"], "unit": "x"}, 400)
        self.assertIn(f'<tspan data-src="fact:a.n">{LEDGER_TEXT}</tspan>', svg)
        self.assertNotIn("2.67", svg)
        self.assertFalse(re.search(r"\d", marked_out(svg)), marked_out(svg))

    def test_timeline_prints_no_number_off_the_ledger(self):
        FX.TABLES["ev"] = [{"date": "2024-01-15", "label_zh": "事件", "kind": "k", "source_name": "s"}]
        d = {"from": "2024-01", "to": "2024-03", "events": "ev"}
        with self.assertRaises(FX.Refused):
            prod.timeline(self.c, d, 400)  # its years are free words: with a ledger nothing could mark them
        FX.LEDGER = None
        self.assertIn(">2024<", prod.timeline(self.c, d, 400))

    def test_profile_prints_the_note_from_the_ledger(self):
        d = {"q": {"table": "t"}, "marks": [{"key": "a", "at": "2024-01", "l": "{a}"}]}
        svg = prod.profile(self.c, d, 400)
        self.assertIn(f'data-src="fact:a.n">{LEDGER_TEXT}<', svg)
        self.assertNotIn("2.67", svg)


if __name__ == "__main__":
    unittest.main()
