"""Self-test of the ring leaf's ledger printing (runtime/leaves_py/facts.py): with a ledger, a text's fact placeholders print
the entry as given, marked with its src; a src the request lacks refuses instead of formatting a number; a record's cell
names the request row it came from. Run: python3 -I scripts/test_leaves_ledger.py"""
import io
import json
import os
import re
import subprocess
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

    def test_placeholders_print_bare_entries_and_write_the_words(self):
        """Only bare numbers are entries: {ru} is fact:ru.n with the unit written after it, {ru.t} the period's year and
        month each marked, the prefix and the 年／月 words written by the leaf; no digit sits outside a mark."""
        FX.LEDGER = {"fact:ru.n": "155", "fact:ru.t.y": "2022", "fact:ru.t.m": "9"}
        got = FX.fill(SPEC, F, "{ru}，{ru.n}，{ru.t}")
        self.assertEqual(
            got,
            '<b class="n"><span data-src="fact:ru.n">155</span> 亿</b>，<b class="n" data-src="fact:ru.n">155</b>，'
            '截至<span data-src="fact:ru.t.y">2022</span> 年 <span data-src="fact:ru.t.m">9</span> 月',
        )
        self.assertFalse(re.search(r"\d", re.sub(r"<[^>]*>[^<]*</[^>]*>|<[^>]*>", "", got)))  # marked runs, then tags, dropped
        FX.LEDGER = {"fact:ru.t.y": "2022", "fact:ru.t.h": "1"}
        self.assertEqual(FX.fill(SPEC, {"ru": {**F["ru"], "t": "2022-S1"}}, "{ru.t}"), '截至<span data-src="fact:ru.t.y">2022</span> 年上半年')
        FX.LEDGER = {"fact:ru.t.y": "2022"}
        self.assertEqual(FX.fill(SPEC, F, "{ru.t}"), '截至<span data-src="fact:ru.t.y">2022</span> 年')
        with self.assertRaises(FX.Refused):
            FX.fill(SPEC, F, "{ru}")  # the old non-bare entry is not asked for, and without fact:ru.n the layer refuses

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


class Page(unittest.TestCase):
    def test_a_placeholder_left_anywhere_refuses_and_only_a_template_brace_passes(self):
        """bus122: a {key} in text, an attribute, a style or a script (the layout script writes into the page) is found;
        a script's ${px} is not."""
        self.assertEqual(run.placeholders('<p title="{a}">{b.t}</p><style>x{c}</style><script>s.innerHTML=`{zz}${px}`</script>'),
                         ["{a}", "{b.t}", "{c}", "{zz}"])
        self.assertEqual(run.placeholders('<script>o+=`<path d="M${px},${py}"/>`;</script><style>a{color:red}</style>'), [])


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
        try:
            self.assertEqual(prod.NAME("DE"), "x")
            for c in ("NO", "TOTAL", "_g"):  # NO has a name in places.json; that name is not used
                with self.assertRaises(FX.Refused) as e:
                    prod.NAME(c)
                self.assertEqual(str(e.exception), f"the request labels no name for {c}")
        finally:
            prod.NAMES = {}

    def test_a_knob_value_or_colour_without_its_words_refuses(self):
        self.assertEqual(prod.inset_note("frame"), words.word("inset.note.frame"))
        with self.assertRaises(FX.Refused) as e:
            prod.inset_note("box")
        self.assertEqual(str(e.exception), "inset: note 'box' is not one of frame, locator")
        self.assertEqual(prod.halo_words({}), words.word("halo.words"))
        self.assertEqual(prod.halo_words({"rise": "#36c", "words": "w"}), "w")
        for d in ({"fall": "#36c"}, {"focus": "SY", "other": "#999"}, {"other": "#999", "words": ""}):
            with self.assertRaises(FX.Refused) as e:
                prod.halo_words(d)
            self.assertEqual(str(e.exception), "map legend: the module sets its colours but gives no words for them")
        # a focus on the default colours is named by the request's label for it, and refuses without one
        with self.assertRaises(FX.Refused) as e:
            prod.halo_words({"focus": "SY"})
        self.assertEqual(str(e.exception), "the request labels no name for SY")
        prod.NAMES = {"SY": "叙利亚"}
        try:
            self.assertEqual(prod.halo_words({"focus": "SY"}), words.word("halo.focus", name="叙利亚"))
        finally:
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



class Child(unittest.TestCase):
    def test_a_keyed_spec_computes_each_derived_fact_after_what_it_reads(self):
        facts = {"gap": {"op": "minus", "a": "hi", "b": "lo"}, "hi": {}, "lo": {}, "x": {"op": "times", "a": "gap", "b": "hi"},
                 "y": {"op": "share", "a": "none", "b": "hi"}}
        self.assertEqual(FX.ordered(facts), ["hi", "lo", "gap", "x", "y"])
        # a spec already in order keeps it
        self.assertEqual(FX.ordered({"a": {}, "b": {"op": "share", "a": "a", "b": "a"}, "c": {}}), ["a", "b", "c"])

    def test_an_svg_layer_reports_the_texts_it_draws_as_layer_1_reads_them(self):
        svg = ('<g data-layer="legend"><g transform="translate(16,16)"><text x="72" y="25" font-size="12">浅色 '
               '<b data-src="period:t:2015">2015</b> &amp; <tspan data-src="fact:a.n">1</tspan></text></g></g>'
               '<text x="5" y="6" font-size="10" text-anchor="middle" dominant-baseline="central" transform="rotate(30 5 6)" '
               'data-src="name:x">俄</text>')
        texts, bad = run.drawn(svg)
        self.assertEqual(bad, [])
        self.assertEqual(texts, [
            dict(src="period:t:2015+fact:a.n", text="浅色 2015 & 1", x=88.0, y=41.0, size=12.0, anchor="start", baseline="", rot=0.0),
            dict(src="name:x", text="俄", x=5.0, y=6.0, size=10.0, anchor="middle", baseline="central", rot=30.0)])
        for svg, why in [('<g transform="scale(2)"><text x="1" y="1" font-size="9">z</text></g>', "a group transform 'scale(2)'"),
                         ('<text x="1" y="1" font-size="9" transform="rotate(10 4 4)">z</text>', "a text turned about (4, 4)")]:
            self.assertTrue(run.drawn(svg)[1][0].startswith(why), svg)

    def test_a_text_in_a_nested_svg_stands_where_the_svg_places_it(self):
        # as scmp.rl_map places the map: a nested svg at the circle's corner, its viewBox the map's own size
        ring = lambda vb, wh, inner: (f'<g clip-path="url(#rc)"><svg x="270" y="40" {wh} viewBox="{vb}" role="img">{inner}</svg></g>'
                                      '<text x="1" y="2" font-size="9" data-src="name:b">外</text>')
        name = '<g data-layer="map.names"><g transform="translate(5,5)"><text x="10" y="20" font-size="10" data-src="name:a">德国</text></g></g>'
        for vb, wh, at in [("0 0 600 600", 'width="600" height="600"', (285.0, 65.0, 10.0)),
                           ("0 0 300 300", 'width="600" height="600"', (300.0, 90.0, 20.0)),  # scaled 2
                           ("0 0 300 300", 'width="600" height="300"', (435.0, 65.0, 10.0)),  # fitted, centred across
                           ("-10 0 600 600", 'width="600" height="600"', (295.0, 65.0, 10.0))]:
            texts, bad = run.drawn(ring(vb, wh, name))
            self.assertEqual(bad, [])
            self.assertEqual([(t["x"], t["y"], t["size"]) for t in texts], [at, (1.0, 2.0, 9.0)], vb)
        texts, bad = run.drawn('<svg x="3" y="4"><text x="1" y="1" font-size="9" data-src="name:a">z</text></svg>')
        self.assertEqual((bad, texts[0]["x"], texts[0]["y"]), ([], 4.0, 5.0))
        for wh in ('width="100%" height="600"', 'width="600" height="600" preserveAspectRatio="none"'):
            self.assertTrue(run.drawn(ring("0 0 600 600", wh, name))[1][0].startswith("a nested svg"), wh)
        # an x or y that is no plain number is said, never read as 0 nor raised (e3 14:03)
        for xy in ('x="10%" y="5"', 'x="1.2.3" y="5"', 'x="3" y="."', 'x="3" y="5" width="1.2.3" height="9" viewBox="0 0 9 9"',
                   'x="3" y="5" width="9" height="9" viewBox="0 0 9 9.9.9"'):
            texts, bad = run.drawn(f'<svg {xy}><text x="1" y="1" font-size="9" data-src="name:a">z</text></svg>')
            self.assertTrue(bad and bad[0].startswith("a nested svg"), xy)

    def test_with_a_ledger_a_place_name_is_marked_with_its_name_row(self):
        prod.NAMES = {"DE": "德国", "EU27_2020": "欧盟"}
        try:
            self.assertEqual(prod.named("DE"), "德国")  # without a ledger, the bare name
            FX.LEDGER = {}
            self.assertEqual(prod.named("DE"), '<tspan data-src="name:zh_names:iso2:DE">德国</tspan>')
            hub = {"hub_name": "欧盟", "q": {"filter": {"geo": "EU27_2020"}}}
            self.assertEqual(prod.hub_named(hub), '<tspan data-src="name:zh_names:iso3:EU27_2020">欧盟</tspan>')
            texts, _ = run.drawn(f'<text x="1" y="1" font-size="9">{prod.hub_named(hub)}</text>')
            self.assertEqual((texts[0]["src"], texts[0]["text"]), ("name:zh_names:iso3:EU27_2020", "欧盟"))
            for d in ({**hub, "hub_name": "欧元区"}, {"hub_name": "欧盟"}):
                with self.assertRaises(FX.Refused) as e:
                    prod.hub_named(d)
                self.assertTrue(str(e.exception).startswith("map: the hub name"), e.exception)
        finally:
            prod.NAMES, FX.LEDGER = {}, None


def column_request(values=(("SE", "65.4"), ("DE", "30.25"), ("BE", "14.9")), ledger=None):
    """A column page's lines as layer 1 sends them (next_run bars_fill and bignums_fill; ledger as next_facts makes it)."""
    rows = [{"src": f"series:sdg/A.PC.{g}:2025:OBS_VALUE", "table": "sdg", "dims": {"freq": "A", "unit": "PC", "geo": g},
             "time": "2025", "value": v} for g, v in values]
    at = lambda g: {"table": "sdg", "filter": {"geo": g}, "time": "2025", "fmt": "pc"}
    spec = {"title": "标题", "dek": "导语", "kicker": "栏目", "source": "sdg", "refs": ["sdg"], "tables": {"sdg": {"id": "sdg"}},
            "facts": {"val": {"each": "geo", "table": "sdg", "time": "2025", "fmt": "pc"}, "hi": at("SE"), "lo": at("BE"),
                      "gap": {"op": "minus", "a": "hi", "b": "lo", "fmt": "pp"}, "times": {"op": "times", "a": "hi", "b": "lo", "fmt": "times"}},
            "fmts": {"pc": {"scale": 1, "dec": 2, "suffix": "%"}, "pp": {"scale": 1, "dec": 2, "suffix": " 个百分点"}, "times": {"scale": 1, "dec": 1, "suffix": "倍"}, "time": {}},
            "hero": {"unit": "单位：%", "data": {"chart": "bars", "by": "geo", "year": "2025", "family": "val",
                                                "ranked": [g for g, _ in values], "marks": ["BE"], "hi": "hi", "lo": "lo", "gap": "gap", "times": "times"}}}
    if ledger is None:
        ledger = {f"fact:val.{g}.n": v for g, v in values}
        ledger.update({"fact:hi.n": "65.40", "fact:lo.n": "14.90", "fact:gap.n": "50.50", "fact:times.n": "4.4", "period:sdg:2025": "2025"})
    knobs = {"spec": spec, "labels": {"SE": "瑞典", "DE": "德国", "BE": "比利时"}}
    rows = rows + [{"src": k, "text": v} for k, v in ledger.items()]
    line = lambda **kv: json.dumps({"node": "column", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows, "knobs": knobs, **kv},
                                   ensure_ascii=False)
    return [line(phase="size"), line(layer="bignums"), line(layer="bars")]


def child(lines):
    """run.py as layer 1 runs it: one reply per line."""
    out = subprocess.run([sys.executable, "-I", "-B", os.path.join(Words.LEAVES, "run.py")], input="\n".join(lines) + "\n",
                         capture_output=True, text=True, check=True).stdout
    return [json.loads(l) for l in out.splitlines()]


class Column(unittest.TestCase):
    def test_a_column_page_sizes_draws_both_layers_from_the_ledger_and_lays_the_page_out(self):
        size, nums, bars = child(column_request())
        self.assertEqual(size["w"], 1140)
        self.assertEqual(size["h"], 6 + 24 * 3 + 4)
        self.assertEqual(set(nums), {"html"})
        for src in ("fact:hi.n", "fact:lo.n", "fact:gap.n", "fact:times.n", "name:zh_names:iso2:SE", "name:zh_names:iso2:BE"):
            self.assertIn(f'data-src="{src}"', nums["html"])
        self.assertEqual([(t["src"], t["text"]) for t in bars["texts"]],
                         [("name:zh_names:iso2:SE", "瑞典"), ("fact:val.SE.n", "65.4"), ("name:zh_names:iso2:DE", "德国"),
                          ("fact:val.DE.n", "30.25"), ("name:zh_names:iso2:BE", "比利时"), ("fact:val.BE.n", "14.9")])
        self.assertTrue(all(0 <= t["x"] <= 1140 and 0 <= t["y"] <= size["h"] for t in bars["texts"]))
        # every digit drawn is inside a mark
        self.assertFalse(re.search(r"\d", re.sub(r"<(\w+)[^>]*data-src[^>]*>[^<]*</\1>|<[^>]*>", "", nums["html"] + bars["svg"])))
        page = child(column_request()[:3] + [json.dumps({"phase": "page", "layers": {"bignums": nums["html"], "bars": bars["svg"]}})])[3]
        html = page["html"]
        self.assertIn(nums["html"].replace('<div class="bns"', '<div data-layer="bignums" class="bns"', 1), html)
        self.assertIn(f'<g data-layer="bars">{bars["svg"]}</g>', html)
        self.assertIn('data-module-id="column"', html)
        self.assertIn('<span data-src="period:sdg:2025">2025</span>', html)
        self.assertEqual(run.placeholders(html), [])

    def test_a_column_page_refuses_what_it_cannot_print_or_draw(self):
        for values, ledger, why in [
            ((("SE", "65.4"), ("BE", "-1")), None, "bars: the values are not all 0 or more"),
            ((("SE", "65.4"), ("BE", "14.9")), {"fact:val.SE.n": "65.4"}, "fact:val.BE.n is not in the request's ledger"),
        ]:
            got = child(column_request(values, ledger)[:1])[0]
            self.assertTrue(got["refused"][0].startswith(f"size: {why}"), got)
        lines = column_request()
        bad = json.loads(lines[0]); bad["node"] = "pie"
        self.assertEqual(child([json.dumps(bad)])[0]["refused"], ["size: no page recipe pie; e.g. one of ring|column|scmp"])
        page = child(lines[:2] + [json.dumps({"phase": "page", "layers": {"bignums": "x"}})])[2]
        self.assertEqual(page["refused"], ["page: no layer bars"])

    def test_the_big_numbers_print_the_items_given_and_a_label_with_a_digit_refuses(self):
        def nums(items):
            line = json.loads(column_request()[1]); line["knobs"]["spec"]["hero"]["data"]["bignums"] = items
            return child([json.dumps(line, ensure_ascii=False)])[0]
        got = nums([{"fact": "hi", "label": {"word": "column.hi", "name": "SE"}},
                    {"fact": "gap", "label": {"word": "scmp.bn.ch", "name": "BE", "by_sign": "gap"}}])
        for src in ("fact:hi.n", "fact:gap.n", "name:zh_names:iso2:SE", "name:zh_names:iso2:BE"):
            self.assertIn(f'data-src="{src}"', got["html"])
        self.assertIn(words.word("scmp.bn.ch.rise", name="").removeprefix("："), got["html"].replace("</span>", ""))
        got = nums([{"fact": "hi", "label": {"word": "date.y", "y": {"src": "period:sdg:2025"}}}])  # a ledger entry fills, marked
        self.assertIn('<span data-src="period:sdg:2025">2025</span>', got["html"])
        neither = "fills {} with neither a place the request names nor a ledger entry"
        for items, why in [
            ([{"fact": "hi", "label": {"word": "date.y", "y": "2025"}}], neither.format("y")),  # a digit no ledger entry marks
            ([{"fact": "hi", "label": {"word": "scmp.note.share", "y": "去年", "v": "三成"}}], neither.format("y")),  # Chinese numerals are no Nd
            ([{"fact": "hi", "label": {"word": "scmp.note.share", "y": {"src": "period:sdg:2025"}, "v": "<b>翻倍</b>"}}], neither.format("v")),  # html
            ([{"fact": "hi", "label": {"word": "scmp.bn.ch", "name": "XX", "by_sign": "hi"}}], neither.format("name")),  # a code with no name
            ([{"fact": "hi", "label": "最高 65.4%"}], "label is not a word-table key"),
            ([{"fact": "nope", "label": {"word": "column.gap"}}], "names no fact the page has"),
            ([{"fact": "hi", "label": {"word": "column.gap", "by_sign": "nope"}}], "signs by 'nope', not its own fact hi"),
            ([{"fact": "hi", "label": {"word": "scmp.bn.tot", "by_sign": "gap"}}], "signs by 'gap', not its own fact hi"),
            ([{"fact": "gap", "label": {"word": "scmp.bn.tot.fall"}}], "names its own fall or rise word scmp.bn.tot.fall; by_sign picks it"),
            ([{"fact": "gap", "label": {"word": "scmp.bn.tot.flat"}}], "names its own fall or rise word scmp.bn.tot.flat; by_sign picks it"),
        ]:
            self.assertEqual(nums(items)["refused"], [f"bignums: bignums: item 0 {why}"], items)
        self.assertEqual(nums([])["refused"], ["bignums: bignums: 0 items; 1 to 6 are drawn"])
        self.assertEqual(nums([{"fact": "hi", "label": {"word": "column.hi"}}])["refused"], ["bignums: the word column.hi is given no name"])

    def test_a_change_that_prints_as_0_is_flat_and_the_sign_is_the_programs(self):
        def label(gap_n):
            lines = column_request()
            line = json.loads(lines[1]); line["knobs"]["spec"]["hero"]["data"]["bignums"] = [{"fact": "gap", "label": {"word": "scmp.bn.tot", "by_sign": "gap"}}]
            line["knobs"]["spec"]["facts"]["gap"] = {"op": "minus", "a": "hi", "b": "hi2", "fmt": "pp"}
            line["knobs"]["spec"]["facts"]["hi2"] = {"table": "sdg", "filter": {"geo": "SE"}, "time": "2025", "fmt": "pc"}
            line["rows"] = [r for r in line["rows"] if r.get("src") != "fact:gap.n"] + [{"src": "fact:gap.n", "text": gap_n}]
            return child([json.dumps(line, ensure_ascii=False)])[0]["html"]
        html = label("0.00")  # hi - hi: 0, so neither a fall nor a rise
        self.assertIn(words.word("scmp.bn.tot.flat"), html)
        self.assertNotIn(words.word("scmp.bn.tot.rise"), html)

    def test_the_trend_reads_digits_of_any_script_and_refuses_what_is_no_number(self):
        import column  # noqa: E402
        c = type("C", (), {})()
        FX.LEDGER = {}
        try:
            for v, shown, want in [(1.2, "１.２", ".rise"), (-0.004, "０", ".flat"), (-0.3, "٠.٣", ".fall"), (0.0, "0", ".flat"), (-0.0, "0.00", ".flat")]:
                c.F = {"k": {"v": v}}; FX.LEDGER["fact:k.n"] = shown
                self.assertEqual(column.trend(c, "k"), want, (v, shown))
            for v in (True, False, float("nan"), float("inf"), "3"):
                c.F = {"k": {"v": v}}
                with self.assertRaisesRegex(FX.Refused, "is no number"):
                    column.trend(c, "k")
        finally:
            FX.LEDGER = None

    def test_an_scmp_frame_without_an_extent_and_a_profile_legend_with_a_ledger_refuse(self):
        FX.LEDGER = {"fact:x.n": "1"}
        try:
            with self.assertRaisesRegex(FX.Refused, r"scmp: the request gives the map no extent"):
                run.scmp.SquareFrame(None, {"data": {"chart": "flowmap"}})
            with self.assertRaisesRegex(FX.Refused, r"profile: a legend is free words"):
                prod.profile(None, {"legend": "图例 3 种"}, 100)
        finally:
            FX.LEDGER = None


if __name__ == "__main__":
    unittest.main()
