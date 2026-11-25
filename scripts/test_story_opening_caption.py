"""The line under the opening picture (story.py opening_caption): when the picture child drew the lead's proportion (layer 1 passes the
child's scene name on, drawn_as.illus_hero "<topic>.proportion"), the page prints one line under the picture from the lead section's
picture.caption (findings.py: fixed words, the member by its name row, the claim's own fact, a slot for the measure's name, which the page
fills from its kicker: the request's measure words are the table's English title when it has no reviewed Chinese name, as on the real
unemployment page), every number a ledger entry and no digit or Latin letter in its words; with any other picture, none drawn, or no proportion (a money measure), the page is the one it was.
Run: python3 -I -B scripts/test_story_opening_caption.py"""
import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
sys.path.insert(0, HERE)
import findings as FN  # noqa: E402
import run  # noqa: E402
from test_story_findings import FMT_DEFS, SHAPES, ledger, wb_request  # noqa: E402
from test_story_proportion import rate_request  # noqa: E402

RATE_NAMES = {"ES": "西班牙", "EL": "希腊", "IT": "意大利", "FR": "法国", "SE": "瑞典", "DE": "德国", "PL": "波兰", "CZ": "捷克"}
HERO = '<g transform="scale(1)"><path d="M0 0L10 10" fill="#b8433a"/></g>'   # a stand-in for the picture child's markup


def money_request():
    req, names = wb_request()
    return {**req, "fmt_defs": {**req["fmt_defs"], "x": {"scale": 1, "dec": 0, "suffix": " 美元"}}, "words": {"measure": "人均国内生产总值", "unit": "美元"}}, names


def page(req, names, picks, drawn_as=None, hero=True, edit=None, kicker="失业率"):
    """(composed, the page's html) drawn by the real child, the opening picture given as layer 1 gives it (its svg and size) and, when
    `drawn_as` is given, the scene name layer 1 passes on."""
    composed = FN.compose({**req, "picks": picks})
    if edit: edit(composed)
    rows, _ = ledger(req, composed, names)
    spec = {"title": composed["title"], "kicker": kicker, "dek": composed["dek"], "end": composed["end"], "source": "s", "refs": [], "facts": composed["facts"],
            "sections": composed["sections"], "tables": {t: {"id": t} for t in sorted({r["table"] for r in req["rows"]})},
            "fmts": {**FMT_DEFS, **req["fmt_defs"], "n": {"scale": 1, "dec": 0, "suffix": ""}, "time": {}},
            "hero": {"data": {}, "leaves": composed["leaves"], "style": dict(composed.get("style", {}))}}
    members = req["main"].get("members") or sorted({r["dims"][req["main"]["by"]] for r in req["rows"] if r["table"] == req["main"]["table"]})
    line = lambda **kv: json.dumps({"node": "page_story", "panel": {"w": 1140, "h": 0, "frame": None}, "rows": rows,
                                    "knobs": {"spec": spec, "labels": names, "shapes": SHAPES, "members": members}, **kv}, ensure_ascii=False)
    layers = [x["layer"] for x in composed["sections"]]
    lines = [line(phase="size")] + [line(layer=n) for n in layers]
    go = lambda ls: [json.loads(x) for x in subprocess.run([sys.executable, "-I", "-B", run.__file__], input="\n".join(ls) + "\n",
                                                           capture_output=True, text=True, timeout=120, check=True).stdout.splitlines()]
    got = go(lines)
    assert not [g for g in got if "refused" in g or "error" in g], got
    bodies = {n: g.get("svg") or g.get("html") for n, g in zip(layers, got[1:])}
    ask = {"phase": "page", "layers": {**bodies, **({"illus_hero": HERO} if hero else {})}, "sizes": {"illus_hero": [1140, 400]} if hero else {}}
    if drawn_as is not None: ask["drawn_as"] = drawn_as
    last = go(lines + [json.dumps(ask, ensure_ascii=False)])[-1]
    assert not last.get("refused"), last
    return composed, last["html"]


def captions(html): return re.findall(r'<p class="opening-cap" data-cap="proportion">(.*?)</p>', html, re.S)


class OpeningCaption(unittest.TestCase):
    PROP = {"illus_hero": "people.proportion"}

    def test_the_composed_caption_is_the_member_the_claim_s_fact_and_the_measure(self):
        comp = FN.compose({**rate_request(10.5), "picks": ["rank", "ends"]})
        lead = comp["sections"][2]
        num = lead["title"].rsplit("{", 1)[1].rstrip("}")
        cap = lead["picture"]["caption"]
        self.assertEqual([g for g in cap if "name" in g], [{"name": "ES"}])
        self.assertEqual([g["src"] for g in cap if "src" in g], [f"fact:{num}"])          # the headline's own fact, the only number
        self.assertFalse(any(re.search(r"[0-9〇一二三四五六七八九十百千]", g.get("w", "")) for g in cap), cap)   # no digit or numeral word
        self.assertIn({"slot": "measure"}, cap)                                            # the measure's name: the page's kicker fills it
        self.assertNotIn("Unemployment", json.dumps(cap))                                   # never the request's English table title
        self.assertNotIn("caption", lead["picture"]["subject"])                             # the picture child gets the subject alone

    def test_a_drawn_proportion_prints_one_line_under_the_picture(self):
        for top in (10.5, 25.0):
            comp, html = page(rate_request(top), RATE_NAMES, ["rank", "ends"], self.PROP)
            got = captions(html)
            self.assertEqual(len(got), 1, top)
            num = comp["sections"][2]["title"].rsplit("{", 1)[1].rstrip("}")
            self.assertRegex(got[0], rf'<span data-src="fact:{num}">{re.escape(f"{top:.1f}%")}</span>')
            self.assertIn(">西班牙</span>", got[0])
            self.assertFalse(re.search(r"[0-9]", re.sub(r"<[^>]+>", "", re.sub(r'<span data-src="fact:[^"]*">[^<]*</span>', "", got[0]))), got[0])   # every digit a fact
            self.assertIn('<div class="opening"><svg aria-hidden="true" ', html)          # the picture hidden, the line read
            self.assertEqual(re.sub(r"<[^>]+>", "", got[0]), f"红色的人按西班牙 {top:.1f}% 的失业率画")
            self.assertFalse(re.search(r"[A-Za-z]", re.sub(r"<[^>]+>", "", got[0])), got[0])   # no Latin letter (the real run's leak)

    def test_a_kicker_with_no_chinese_name_gives_the_plain_word_for_a_share(self):
        for kick in ("Unemployment by sex and age - annual data", "失业率 2025", ""):
            got = captions(page(rate_request(10.5), RATE_NAMES, ["rank", "ends"], self.PROP, kicker=kick)[1])
            self.assertEqual([re.sub(r"<[^>]+>", "", g) for g in got], ["红色的人按西班牙 10.5% 的比例画"], kick)

    def test_the_layout_note_in_brackets_is_not_part_of_the_measure_name(self):
        for kick, name in (("失业率（最近时点排名）", "失业率"), ("失业率 (latest)", "失业率"), ("失业率（最近一年）", "失业率")):
            got = captions(page(rate_request(10.5), RATE_NAMES, ["rank", "ends"], self.PROP, kicker=kick)[1])
            self.assertEqual([re.sub(r"<[^>]+>", "", g) for g in got], [f"红色的人按西班牙 10.5% 的{name}画"], kick)
        for kick in ("（最近时点排名）", "Unemployment（最近）"):
            got = captions(page(rate_request(10.5), RATE_NAMES, ["rank", "ends"], self.PROP, kicker=kick)[1])
            self.assertEqual([re.sub(r"<[^>]+>", "", g) for g in got], ["红色的人按西班牙 10.5% 的比例画"], kick)

    def test_the_charts_head_the_measure_in_chinese_where_the_table_has_only_an_english_title(self):
        """The head of each chart was the English table title (the request's measure words); the page's Chinese name stands there."""
        req = rate_request(10.5)
        html = page(req, RATE_NAMES, ["rank", "ends"], kicker="失业率（最近时点排名）")[1]
        heads = re.findall(r'<svg[^>]*>', html)
        self.assertTrue(heads)
        body = re.sub(r"<[^>]+>", "", html)
        self.assertNotIn("Unemployment by sex", body)                       # no chart head, no row label in English (the page's source line here is "s")
        self.assertIn("失业率", body)
        # a Chinese measure name the findings child already had is left as it was
        zh = {**req, "words": {"measure": "失业率", "unit": "百分比"}}
        body_zh = re.sub(r"<[^>]+>", "", page(zh, RATE_NAMES, ["rank", "ends"], kicker="别的名字")[1])
        self.assertEqual(body_zh.count("别的名字"), 1)                       # only the kicker: the heads keep the Chinese name the findings child had
        self.assertGreaterEqual(body_zh.count("失业率"), 3)

    def test_what_stands_in_brackets_goes_with_the_brackets_nested_or_not(self):
        import story
        for given, want in (("a(b)c", "ac"), ("a(b(c)d)e", "ae"), ("x(y", "x"), ("no brackets", "no brackets"), ("p)q", "pq")):
            self.assertEqual(story.unbracketed(given), want, given)

    def test_no_line_with_another_picture_none_drawn_or_no_proportion(self):
        req = rate_request(10.5)
        _, plain = page(req, RATE_NAMES, ["rank", "ends"])                          # layer 1 passes no scene name (as today)
        self.assertEqual(captions(plain), [])
        self.assertIn('<div class="opening" aria-hidden="true">', plain)
        for other in ({"illus_hero": "energy.rank"}, {"illus_hero": "people.rank"}, {}):   # the old subject drawn, or nothing said
            self.assertEqual(page(req, RATE_NAMES, ["rank", "ends"], other)[1], plain, other)
        # the strip stood in (no opening picture): no line, whatever the scene name says
        self.assertEqual(captions(page(req, RATE_NAMES, ["rank", "ends"], self.PROP, hero=False)[1]), [])
        # a page whose lead section carries no caption is byte for byte the page with the proportion drawn and nothing said
        drop = lambda comp: comp["sections"][2]["picture"].pop("caption")
        self.assertEqual(page(req, RATE_NAMES, ["rank", "ends"], self.PROP, edit=drop)[1], plain)

    def test_a_money_measure_has_no_line(self):
        req, names = money_request()
        comp, html = page(req, names, ["rank", "ends"], self.PROP)
        self.assertNotIn("caption", json.dumps(comp["sections"], ensure_ascii=False))
        self.assertEqual(captions(html), [])
        self.assertEqual(page(req, names, ["rank", "ends"])[1], html)


if __name__ == "__main__":
    unittest.main()
