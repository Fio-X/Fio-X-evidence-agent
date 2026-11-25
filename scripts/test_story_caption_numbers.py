"""A program scan of the line under the opening picture (story.py opening_caption), drawn by the real page child: for an unemployment-rate
page (a people-topic shape, the lead 10.5%) and a 25.0% one, every number in the caption's text sits in a span whose data-src is a fact:
reference, that reference is the one fact the lead section's headline prints (its share), the span prints the same text as that fact's
other spans on the page, and no other digit is anywhere in the caption (the words, the name, the markup's text). Uses the page builder of
scripts/test_story_opening_caption.py.
Run: python3 -I -B scripts/test_story_caption_numbers.py"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_story_opening_caption import RATE_NAMES, captions, page  # noqa: E402
from test_story_proportion import rate_request  # noqa: E402

NUMBER = re.compile(r"[0-9]+(?:[.,][0-9]+)*")
SPAN = re.compile(r'<span data-src="([^"]*)">([^<]*)</span>')


def scan(caption, headline_fact, html):
    """Why the caption's numbers are not all the headline's share fact; [] when they are."""
    off = []
    srcs = [m.group(1) for m in SPAN.finditer(caption) if NUMBER.search(m.group(2))]
    if srcs != [f"fact:{headline_fact}"]: off.append(f"numbered spans {srcs}, want only fact:{headline_fact}")
    for src, text in SPAN.findall(caption):
        if not src.startswith(("fact:", "name:")): off.append(f"span {src!r} is neither a fact nor a name")
        if src.startswith("name:") and NUMBER.search(text): off.append(f"a name prints a number: {text!r}")
    rest = re.sub(r"<[^>]+>", "", SPAN.sub(lambda m: "" if m.group(1).startswith("fact:") else m.group(2), caption))
    if NUMBER.search(rest): off.append(f"a number outside a fact span: {rest!r}")
    if html:      # the same fact printed elsewhere on the page (the lead section's headline) prints the same text
        printed = {t for s, t in SPAN.findall(caption) if s == f"fact:{headline_fact}"}
        elsewhere = {t for s, t in SPAN.findall(html.replace(caption, "", 1)) if s == f"fact:{headline_fact}"}
        if not elsewhere: off.append(f"fact:{headline_fact} is printed nowhere else on the page")
        elif printed - elsewhere: off.append(f"the caption prints {printed} for the fact, the page {elsewhere}")
    return off


class CaptionNumbers(unittest.TestCase):
    def test_every_number_in_the_caption_is_the_headline_s_share_fact(self):
        for top in (10.5, 25.0):
            comp, html = page(rate_request(top), RATE_NAMES, ["rank", "ends"], {"illus_hero": "people.proportion"})
            num = comp["sections"][2]["title"].rsplit("{", 1)[1].rstrip("}")
            self.assertIn(num, comp["facts"], top)
            got = captions(html)
            self.assertEqual(len(got), 1, top)
            self.assertEqual(scan(got[0], num, html), [], (top, got[0]))
            self.assertTrue(NUMBER.search(got[0]), top)        # the scan saw a number at all

    def test_the_scan_catches_a_stray_number(self):
        ok = '红色的人按<span data-src="name:zh_names:geo:ES">西班牙</span> <span data-src="fact:hi">10.5%</span> 的失业率画'
        self.assertEqual(scan(ok, "hi", ""), [])
        self.assertTrue(scan(ok.replace("的失业率", "的 27 国失业率"), "hi", ""))                       # a digit in the words
        self.assertTrue(scan(ok.replace('data-src="fact:hi"', 'data-src="fact:lo"'), "hi", ""))         # another fact
        self.assertTrue(scan(ok.replace("西班牙", "西班牙 2"), "hi", ""))                                  # a digit in a name
        self.assertTrue(scan(ok + ' <span data-src="fact:n">27</span>', "hi", ""))                        # a second number


if __name__ == "__main__":
    unittest.main()
