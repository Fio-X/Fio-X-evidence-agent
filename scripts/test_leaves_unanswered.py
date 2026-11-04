"""Self-test of the page's unanswered lines (runtime/leaves_py/scmp.py unanswered): one line for each asked quantity that
no offered table holds, named from the record's own zh and tagged with its id; none for a quantity with an offered table,
none for a page with no asked record; a record with no id or name, or a name holding a digit, refuses.
Run: python3 -I -B scripts/test_leaves_unanswered.py"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
import facts as FX  # noqa: E402
import scmp  # noqa: E402
from words import WORDS  # noqa: E402


class Unanswered(unittest.TestCase):
    def test_a_quantity_no_offered_table_holds_gets_its_line(self):
        spec = {"asked": [
            {"id": "renewable_share", "zh": "可再生能源占比", "offered": ["sdg_07_40"]},
            {"id": "gdp_pc", "zh": "人均GDP", "offered": []},
        ]}
        got = scmp.unanswered(spec)
        self.assertEqual(got.count('<p class="unanswered"'), 1, got)
        self.assertIn('data-asked="gdp_pc"', got)
        self.assertIn(WORDS["page.note.unanswered_half"].format(v="人均GDP"), got)
        self.assertNotIn("可再生能源占比", got)

    def test_no_record_or_every_quantity_offered_gives_no_line(self):
        self.assertEqual(scmp.unanswered({}), "")
        self.assertEqual(scmp.unanswered({"asked": []}), "")
        self.assertEqual(scmp.unanswered({"asked": [{"id": "asylum", "zh": "庇护申请", "offered": ["migr_asyappctza"]}]}), "")

    def test_the_name_is_the_records_and_escaped(self):
        got = scmp.unanswered({"asked": [{"id": "x", "zh": "<b>甲</b>", "offered": []}]})
        self.assertIn("&lt;b&gt;甲&lt;/b&gt;", got)
        self.assertNotIn("<b>", got)

    def test_a_bad_record_refuses(self):
        for a in ({"zh": "人口", "offered": []}, {"id": "p", "offered": []}, {"id": "p", "zh": " ", "offered": []},
                  {"id": "p", "zh": "65岁以上人口", "offered": []}, "pop"):
            with self.assertRaises(FX.Refused, msg=repr(a)):
                scmp.unanswered({"asked": [a]})

    def test_the_word_has_one_placeholder_and_no_digit(self):
        w = WORDS["page.note.unanswered_half"]
        self.assertEqual(w.count("{v}"), 1)
        self.assertFalse(FX.digit(w.replace("{v}", "")))


if __name__ == "__main__":
    unittest.main()
