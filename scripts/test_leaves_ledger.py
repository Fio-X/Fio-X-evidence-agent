"""Self-test of the ring leaf's ledger printing (runtime/leaves_py/facts.py): with a ledger, a text's fact placeholders print
the entry as given, marked with its src; a src the request lacks refuses instead of formatting a number; a record's cell
names the request row it came from. Run: python3 -I scripts/test_leaves_ledger.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "leaves_py"))
import facts as FX  # noqa: E402
import run  # noqa: E402

SPEC = {"fmts": {"m": {"scale": 0.01, "dec": 0, "suffix": " 亿"}, "time": {"prefix": "截至"}}}
F = {"ru": {"v": 15500.0, "t": "2022-09", "fmt": "m"}}


class Ledger(unittest.TestCase):
    def tearDown(self):
        FX.LEDGER = None

    def test_without_a_ledger_the_prototype_formats(self):
        self.assertEqual(FX.fill(SPEC, F, "{ru}，{ru.t}"), '<b class="n">155 亿</b>，截至2022 年 9 月')

    def test_placeholders_print_the_entry_with_its_src(self):
        FX.LEDGER = {"fact:ru": "155 亿立方米", "fact:ru.n": "155", "fact:ru.t": "截至2022 年 9 月"}
        self.assertEqual(
            FX.fill(SPEC, F, "{ru}，{ru.n}，{ru.t}"),
            '<b class="n" data-src="fact:ru">155 亿立方米</b>，<b class="n" data-src="fact:ru.n">155</b>，'
            '<span data-src="fact:ru.t">截至2022 年 9 月</span>',
        )

    def test_the_entry_text_is_escaped(self):
        FX.LEDGER = {"fact:ru": "<1>"}
        self.assertEqual(FX.entry("fact:ru", "tspan", None), '<tspan data-src="fact:ru">&lt;1&gt;</tspan>')

    def test_a_missing_src_refuses(self):
        FX.LEDGER = {"fact:ru": "155 亿立方米"}
        with self.assertRaises(FX.Refused) as e:
            FX.fill(SPEC, F, "{ru.n}")
        self.assertEqual(str(e.exception), "fact:ru.n is not in the request's ledger")
        with self.assertRaises(FX.Refused):
            FX.text("period:imp:2021")

    def test_a_record_cell_names_its_request_row(self):
        T = run.tables([
            {"src": "record:ev.csv/0", "table": "ev.csv", "dims": {"date": "2022-09-26"}, "time": "", "value": ""},
            {"src": "series:imp/RU:2022:OBS_VALUE", "table": "imp", "dims": {"partner": "RU"}, "time": "2022", "value": "1"},
            {"src": "fact:ru", "text": "155 亿立方米"},
        ])
        self.assertEqual(FX.cell_src(T["ev.csv"][0]), "record:ev.csv/0")
        self.assertEqual(T["imp"][0], {"partner": "RU", "TIME_PERIOD": "2022", "OBS_VALUE": "1"})
        self.assertEqual(FX.cell_src(T["imp"][0]), "series:imp/RU:2022:OBS_VALUE")


if __name__ == "__main__":
    unittest.main()
