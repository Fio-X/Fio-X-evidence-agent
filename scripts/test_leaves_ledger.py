"""Self-test of the ring leaf's ledger printing (runtime/leaves_py/facts.py): with a ledger, a text's fact placeholders print
the entry as given, marked with its src; a src the request lacks refuses instead of formatting a number; a record's cell
names the request row it came from. Run: python3 -I scripts/test_leaves_ledger.py"""
import io
import os
import re
import sys
import tokenize
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "leaves_py"))
import facts as FX  # noqa: E402
import prod  # noqa: E402
import run  # noqa: E402
import words  # noqa: E402

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
        with self.assertRaises(FX.Refused) as e:
            FX.cell_src(dict(T["ev.csv"][0]))  # a copy of the cell, not the one the request row built
        self.assertEqual(str(e.exception), "a record cell that no request row built")

    def test_a_family_at_another_year_than_the_map_refuses(self):
        spec = {"hero": {"data": {"t0": "2021", "t1": "2024", "legend_fact": "big", "label_fact": "lab"}},
                "facts": {"big": {"each": "partner", "time": "2021"}, "lab": {"each": "partner", "time": "2024"}}}
        run.fact_times(spec)
        spec["facts"]["lab"]["time"] = "2023"
        with self.assertRaises(FX.Refused) as e:
            run.fact_times(spec)
        self.assertEqual(str(e.exception), "map: the label_fact family lab is at 2023, the map's t1 is 2024")
        spec["facts"]["lab"]["time"] = "2024"; spec["facts"]["big"]["time"] = "2024"
        with self.assertRaises(FX.Refused) as e:
            run.fact_times(spec)
        self.assertEqual(str(e.exception), "map: the legend_fact family big is at 2024, the map's t0 is 2021")


class Words(unittest.TestCase):
    LEAVES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "leaves_py")
    CJK = re.compile(r"[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]")

    def test_no_leaf_writes_a_word_of_its_own(self):
        """Every CJK string in the leaves' code: only the recipe's kind name, which moves with the recipe's kind names."""
        found = []
        for f in sorted(os.listdir(self.LEAVES)):
            if not f.endswith(".py"): continue
            with open(os.path.join(self.LEAVES, f), "rb") as fh:
                for t in tokenize.tokenize(io.BytesIO(fh.read()).readline):
                    if t.type in (tokenize.STRING, getattr(tokenize, "FSTRING_MIDDLE", -1)) and self.CJK.search(t.string):
                        found.append((f, t.string))
        self.assertEqual(found, [("prod.py", '"\u7ed3\u8bba"')])

    def test_the_word_table_fills_its_placeholders(self):
        self.assertEqual(words.word("date.ymd", y=2022, m=9, d=26), "2022 \u5e74 9 \u6708 26 \u65e5")
        self.assertEqual(FX.tlabel("2024-S1"), "2024 \u5e74\u4e0a\u534a\u5e74")

    def test_a_topic_word_the_request_does_not_give_refuses(self):
        with self.assertRaises(FX.Refused) as e:
            prod.hub_name({})
        self.assertEqual(str(e.exception), "map: the map names no hub_name")
        with self.assertRaises(FX.Refused) as e:
            prod.need({"unit": ""}, "unit")
        self.assertEqual(str(e.exception), "the module names no unit")
        prod.NAMES = {"DE": "x"}
        self.assertEqual((prod.geo_name("DE"), prod.geo_name("NO")), ("x", "NO"))
        prod.NAMES = {}

    def test_members_come_from_the_request(self):
        with self.assertRaises(FX.Refused) as e:
            FX.members()
        self.assertEqual(str(e.exception), "the request gives no members")
        FX.MEMBERS = ["DE", "FR"]
        try:
            self.assertEqual(FX.members(), ["DE", "FR"])
        finally:
            FX.MEMBERS = None


if __name__ == "__main__":
    unittest.main()
