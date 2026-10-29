"""Self-test of the section_head leaf (runtime/leaves_py/section_head.py) and of the word segments every chart leaf prints
through (wbkit.segs): a text-only head with a number word, a headline and an intro card (test-only ledger text). Each svg
reads back with no `bad`, every digit sits inside a marked ledger run, and the refusals keep the segment rules: no plain
source string, no digit in a literal, no unknown word or word with a placeholder; a closing mark never starts a line.
Run: python3 -I -B scripts/test_leaves_section_head.py"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "runtime", "leaves_py"))
import run  # noqa: E402
import section_head  # noqa: E402
import wbkit as K  # noqa: E402
from wbkit import Refused  # noqa: E402

W = lambda t: [{"w": t}]
ROWS = [{"src": "fact:no", "text": "1"}]


def check_svg(svg):
    """What is wrong with a drawn svg: texts the read-back cannot place, none at all, a digit outside a marked ledger run."""
    got, bad = run.drawn(svg)
    errs = [f"bad={bad}"] * bool(bad) + ["no texts"] * (not got)
    errs += [f"text {g['text']!r} holds a digit and names no src" for g in got if not g["src"] and re.search(r"[0-9０-９]", g["text"])]
    words = re.sub(r"<[^>]+>", "", re.sub(r'<tspan data-src="[^"]*">[^<]*</tspan>', "", svg))
    errs += [f"a digit outside a marked ledger run: {words[:80]!r}"] * bool(re.search(r"[0-9０-９]", words))
    return errs


def head(long=False):
    card = "从各领域的国别申请量看，中国在多数领域已经是第一，美国在多数领域排第二。这是一张导读卡，用来测试卡片换行。"
    return dict(no=[{"w": "专题 "}, {"src": "fact:no"}], headline=W("特许数，九个领域里中国独走"),
                card=W(card + ("再加一句话把它撑到三四行。" * 4 if long else "")))


def hero(data, **style):
    return {"data": data, "style": {"section_head": style}}


def draw(h):
    K.setup(ROWS, {}, run.tables)
    return section_head.draw(h)


class SectionHead(unittest.TestCase):
    def test_short_long_and_centred_heads_draw(self):
        for tag, h in [("short", hero(head(), dek_lines=6)), ("long", hero(head(True), dek_lines=6)),
                       ("center-narrow", hero(head(), align="center", width=640))]:
            with self.subTest(tag):
                svg, w, ht = draw(h)
                self.assertEqual(check_svg(svg), [])
                self.assertIn('data-src="fact:no"', svg)
                self.assertEqual(w, 640 if tag == "center-narrow" else 1140)

    def test_a_closing_mark_never_starts_a_line(self):
        for size in (15, 17, 20):
            for line in K.lay(K.segs(head(True)["card"], "card"), size, 300):
                self.assertNotIn(line[0][0][0], K.NO_LINE_START)

    def test_the_refusals(self):
        for tag, data, style, why in [
            ("bare-source-string", dict(head(), headline="fact:no"), {}, "given as a ledger source"),
            ("digit-in-literal", dict(head(), headline=W("2024年")), {}, "hold a digit"),
            ("fullwidth-digit", dict(head(), headline=W("第１名")), {}, "hold a digit"),
            ("word-with-placeholder", dict(head(), headline=[{"word": "date.y"}]), {}, "placeholder"),
            ("unknown-word", dict(head(), headline=[{"word": "nope"}]), {}, "no key"),
            ("two-kinds", dict(head(), headline=[{"w": "a", "src": "fact:no"}]), {}, "one of w, src, word"),
            ("entry-missing", dict(head(), no=[{"src": "fact:zz"}]), {}, "fact:zz"),
            ("no-headline", dict(head(), headline=None), {}, "no headline"),
            ("title-lines", head(), dict(title_lines=1, head_size=44, width=500), "title_lines"),
            ("card-lines", head(True), dict(dek_lines=2), "dek_lines"),
            ("knob-off-range", head(), dict(head_size=99), "off its range"),
            ("colour-knob-gone", head(), dict(card_fill="#123456"), "no knob"),
        ]:
            with self.subTest(tag), self.assertRaises(Refused) as e:
                draw(hero(data, **style))
            self.assertIn(why, str(e.exception), tag)


if __name__ == "__main__":
    unittest.main()
