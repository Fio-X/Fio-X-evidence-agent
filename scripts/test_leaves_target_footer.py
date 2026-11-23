"""A legal target's source line in the leaf footer (I16): the line next_targets gives (targets.json: publisher_zh + source_zh)
holds digits only inside source_ref, and the footer takes source_ref as a reference id the way it takes a table id (spec.refs,
which layer 1 fills from the spec's table ids), so a page may print it. Without the reference the footer refuses the digits.
Run: python3 -I -B scripts/test_leaves_target_footer.py"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
import facts as FX  # noqa: E402
import scmp  # noqa: E402

with open(os.path.join(HERE, "..", "runtime", "pi", "assets", "targets.json"), encoding="utf-8") as f:
    TARGETS = json.load(f)["targets"]


def line(t):
    return f"{t['publisher_zh']} {t['source_zh']}"


class TargetFooter(unittest.TestCase):
    def setUp(self):
        FX.LEDGER = {"x": "1"}  # a leaf's page: the footer marks references and refuses any other digit

    def tearDown(self):
        FX.LEDGER = None

    def test_each_target_line_prints_with_its_reference_marked(self):
        for t in TARGETS:
            html = scmp.footer({"source": ["欧盟统计局 nrg_ind_ren", line(t)], "refs": ["nrg_ind_ren", t["source_ref"]]})
            self.assertIn(f'<span data-ref="">{t["source_ref"]}</span>', html, t["id"])
            self.assertIn(f'<span data-ref="">nrg_ind_ren</span>', html)

    def test_without_the_reference_the_footer_refuses_the_digits(self):
        for t in TARGETS:
            with self.assertRaises(FX.Refused, msg=t["id"]):
                scmp.footer({"source": ["欧盟统计局 nrg_ind_ren", line(t)], "refs": ["nrg_ind_ren"]})

    def test_the_line_ends_with_its_reference_and_holds_no_other_digit(self):
        for t in TARGETS:
            self.assertTrue(line(t).endswith(t["source_ref"]), t["id"])
            self.assertFalse(any(c.isnumeric() for c in line(t)[: -len(t["source_ref"])]), t["id"])

    def test_a_character_that_runs_into_the_reference_is_refused(self):
        t = TARGETS[1]  # the reference ends in a word character (款): a word right after it is not a mark
        with self.assertRaises(FX.Refused):
            scmp.footer({"source": [line(t) + "与欧盟统计局"], "refs": [t["source_ref"]]})
        # a separator after it is
        scmp.footer({"source": [line(t) + "，目标"], "refs": [t["source_ref"]]})

    def test_an_empty_or_padded_reference_is_refused_not_printed_as_empty_marks(self):
        # an empty id matches between any two separators: the page would print empty marks and stop at the page check
        for bad in ("", " ", " nrg_ind_ren", "nrg_ind_ren ", None, 7):
            with self.assertRaises(FX.Refused, msg=repr(bad)):
                scmp.footer({"source": ["欧盟统计局 nrg_ind_ren"], "refs": ["nrg_ind_ren", bad]})
        with self.assertRaises(FX.Refused):
            scmp.footer({"source": ["欧盟统计局 nrg_ind_ren"], "refs": "nrg_ind_ren"})
        # no refs at all is the table-free footer, as before
        scmp.footer({"source": ["欧盟统计局 nrg_ind_ren"], "refs": []})

    def test_a_table_the_request_holds_no_row_of_is_a_reference_only_and_a_fact_over_it_still_stops(self):
        # the law's clause is a spec table with no rows (the page's notes no longer read the target): loading the page's tables
        # does not stop on it, and a fact that does read it still refuses
        FX.TABLES = {"t": [{"geo": "DE", "TIME_PERIOD": "2024", "OBS_VALUE": "1"}]}
        try:
            spec = {"tables": {"t": {"id": "t"}, "targets_ren": {"id": "2023/2413"}}}
            self.assertEqual(sorted(FX.load(spec)), ["t"])
            with self.assertRaises(KeyError):
                FX._rows(FX.load(spec), {"table": "targets_ren"})
        finally:
            FX.TABLES = None


if __name__ == "__main__":
    unittest.main()
