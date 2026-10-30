"""Self-test of how the bake starts Chrome (runtime/leaves_py/bake.py command, sandboxed): Chrome keeps its own sandbox
unless this process is already inside an OS sandbox, and only then is it started with --no-sandbox; every other flag, the
guard among them, is the same both ways. On macOS a child started under sandbox-exec finds itself sandboxed. With a Chrome
installed, the page-width check bakes two small pages: a text past the page's box and a page with no box both fail; and the
type check measures each text's size as rendered and its contrast with what is drawn under it, returned as the bake's "type".
Run: python3 -I -B scripts/test_bake_sandbox.py"""
import os
import shutil
import subprocess
import sys
import unittest
from unittest import mock

LEAVES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime", "leaves_py")
sys.path.insert(0, LEAVES)
import bake  # noqa: E402

ASK = f"import sys; sys.path.insert(0, {LEAVES!r}); import bake; print(bake.sandboxed())"


class Command(unittest.TestCase):
    def test_outside_a_sandbox_chrome_keeps_its_own(self):
        cmd = bake.command("/c", "/t", "/t/page.html", 1440, inside=False)
        self.assertNotIn("--no-sandbox", cmd)
        self.assertEqual(cmd, ["/c", *bake.FLAGS, "--user-data-dir=/t/profile", "--window-size=1440,900", "--dump-dom", "file:///t/page.html"])

    def test_inside_a_sandbox_only_no_sandbox_is_added(self):
        out, inside = (bake.command("/c", "/t", "/t/page.html", 1440, inside=v) for v in (False, True))
        self.assertEqual(inside.count("--no-sandbox"), 1)
        self.assertEqual([a for a in inside if a != "--no-sandbox"], out)
        self.assertIn("--host-resolver-rules=MAP * ~NOTFOUND", inside)

    def test_chrome_never_reaches_for_the_keychain_either_way(self):
        # inside a sandbox the real keychain hangs Chrome's teardown (exit 2 after the page is out)
        for v in (False, True):
            cmd = bake.command("/c", "/t", "/t/page.html", 1440, inside=v)
            self.assertIn("--use-mock-keychain", cmd)
            self.assertIn("--password-store=basic", cmd)

    def test_a_failing_check_is_no_sandbox_and_chrome_keeps_its_own(self):
        if sys.platform != "darwin": self.skipTest("sandbox_check is macOS only")
        for code, inside in ((-1, False), (0, False), (1, True)):
            self.assertIs(bake.sandboxed(lambda *a, c=code: c), inside, code)
        real = bake.sandboxed
        with mock.patch.object(bake, "sandboxed", lambda: real(lambda *a: -1)):
            self.assertNotIn("--no-sandbox", bake.command("/c", "/t", "/t/page.html", 1440))

    def test_not_given_it_asks_sandboxed(self):
        self.assertEqual("--no-sandbox" in bake.command("/c", "/t", "/t/p.html", 900), bake.sandboxed())


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("sandbox-exec"), "sandbox-exec is macOS only")
class Sandboxed(unittest.TestCase):
    def ask(self, *pre):
        run = subprocess.run([*pre, sys.executable, "-I", "-B", "-c", ASK], capture_output=True, text=True, timeout=30)
        self.assertEqual(run.returncode, 0, run.stderr)
        return run.stdout.strip()

    def test_a_child_under_sandbox_exec_is_sandboxed(self):
        self.assertEqual(self.ask("sandbox-exec", "-p", "(version 1)(allow default)"), "True")

    def test_a_plain_child_is_as_sandboxed_as_this_process(self):
        # outside any sandbox this is the False case; inside one (a stand-in's) a plain child inherits it
        self.assertEqual(self.ask(), str(bake.sandboxed()))


@unittest.skipUnless(bake.chrome(), "no Chrome to bake in")
class PageWidth(unittest.TestCase):
    def baked(self, body):
        return bake.bake({"html": f'<!doctype html><meta charset="utf-8"><style>.pg{{width:400px;padding:0 20px}}</style>{body}', "ready": "", "width": 800})

    def test_a_text_inside_the_page_bakes(self):
        self.assertIn("html", self.baked('<div class="pg"><p>标题 12</p></div>'))

    def test_a_text_past_the_page_fails(self):
        got = self.baked('<div class="pg"><p style="white-space:nowrap;font-size:40px">3,261 百万立方米 3,261 百万立方米</p></div>')
        self.assertIn("page: past the page: 3,261", got.get("error", ""))

    def test_a_page_with_no_page_box_fails_instead_of_passing(self):
        got = self.baked('<div class="main"><p>标题</p></div>')
        self.assertIn("page: no page box (.pg) to check the width against", got.get("error", ""))


@unittest.skipUnless(bake.chrome(), "no Chrome to bake in")
class TypeContrast(unittest.TestCase):
    def typed(self, body):
        got = bake.bake({"html": f'<!doctype html><meta charset="utf-8"><body style="margin:0"><div class="pg" style="width:1200px">{body}</div></body>', "ready": "", "width": 1440})
        self.assertIn("type", got, got.get("error"))
        self.assertNotIn("data-bake", got["html"])
        return got["type"]

    def test_black_text_on_white_is_measured_and_passes(self):
        got = self.typed('<p style="font-size:16px;color:#000">标题</p>')
        self.assertEqual(got, {"min_font_px": 16, "min_contrast_body": 21, "min_contrast_large": None, "texts": 1, "unmeasured": 0, "below": []})

    def test_small_and_pale_texts_are_listed_with_their_layer(self):
        # each value as reported, rounded down to two decimals (#777 on white is 4.478:1)
        got = self.typed('<div data-layer="notes"><p style="font-size:10px">小字</p><p style="font-size:14px;color:#777">灰字</p>'
                         '<h1 style="font-size:30px;color:#bbb">大标题</h1></div>')
        self.assertEqual((got["min_font_px"], got["min_contrast_body"], got["min_contrast_large"], got["texts"]), (10, 4.47, 1.91, 3))
        self.assertEqual(got["below"], ["小字 10px 21:1 notes", "灰字 14px 4.47:1 notes", "大标题 30px 1.91:1 notes"])

    def test_svg_text_is_sized_as_rendered_and_read_against_the_shape_under_it(self):
        # the viewBox halves every size; the dark text sits on the dark box, the halo text on its own white stroke
        got = self.typed('<svg width="600" height="300" viewBox="0 0 1200 600" data-layer="map"><rect width="1200" height="600" fill="#123456"/>'
                         '<text x="20" y="60" font-size="28" fill="#fff">白字</text><text x="20" y="160" font-size="28" fill="#1a3a5a">暗字</text>'
                         '<text x="20" y="260" font-size="40" fill="#000" stroke="#fff" stroke-width="6" paint-order="stroke">晕</text></svg>')
        self.assertEqual((got["min_font_px"], got["min_contrast_body"], got["texts"]), (14, 1.08, 3))
        self.assertEqual(got["below"], ["暗字 14px 1.08:1 map"])

    def test_hidden_texts_are_not_measured_and_a_low_one_is_scrolled_to(self):
        got = self.typed('<p style="display:none;font-size:8px">藏</p><p style="visibility:hidden;font-size:8px">藏</p>'
                         '<p style="opacity:0;font-size:8px">藏</p><div style="height:2000px"></div><p style="color:#999;background:#eee">底部</p>')
        self.assertEqual((got["texts"], got["below"]), (1, ["底部 16px 2.45:1 -"]))

    def test_what_it_reports_is_rounded_down_never_up_to_a_floor(self):
        # #777 on white is 4.478:1: reported 4.47, under the 4.5 floor, never rounded up; and a 10.995 px text is 10.99 px
        got = self.typed('<p style="font-size:14px;color:#777">灰字</p><p style="font-size:10.995px">小字</p>')
        self.assertEqual((got["min_font_px"], got["min_contrast_body"], got["unmeasured"]), (10.99, 4.47, 0))
        self.assertEqual(got["below"], ["灰字 14px 4.47:1 -", "小字 10.99px 21:1 -"])

    def test_a_text_whose_contrast_cannot_be_read_is_counted_unmeasured_not_read_against_the_page(self):
        # each text here is measured for size and counted unmeasured for contrast, never read against the white page:
        # an svg text filled by a gradient, one over a pattern-filled box, one over an svg image, one over a use, an html
        # text over an image and one over a background image, an outline-only svg text, and a ::before text
        png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        got = self.typed(
            '<svg width="600" height="500" data-layer="map"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/>'
            '<stop offset="1" stop-color="#444"/></linearGradient><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse">'
            '<rect width="2" height="2" fill="#000"/></pattern><rect id="r" width="200" height="40" fill="#123"/></defs>'
            '<text x="10" y="30" font-size="16" fill="url(#g)">渐变</text>'
            '<rect x="0" y="50" width="200" height="40" fill="url(#p)"/><text x="10" y="80" font-size="16" fill="#000">花纹</text>'
            f'<image x="0" y="100" width="200" height="40" href="{png}" preserveAspectRatio="none"/><text x="10" y="130" font-size="16" fill="#000">图像</text>'
            '<use href="#r" x="0" y="150"/><text x="10" y="180" font-size="16" fill="#000">引用</text>'
            '<text x="10" y="230" font-size="16" fill="none" stroke="#000" stroke-width="1">描边</text></svg>'
            f'<div style="position:relative;height:40px"><img src="{png}" style="position:absolute;left:0;top:0;width:200px;height:40px">'
            '<p style="position:relative;margin:0;font-size:16px;color:#000">照片</p></div>'
            f'<p style="font-size:16px;color:#000;background-image:url({png})">底图</p>'
            '<style>.n::before{content:"注";font-size:12px}</style><p class="n" style="font-size:16px;color:#000">正文</p>')
        self.assertEqual((got["texts"], got["unmeasured"]), (9, 8), got)
        self.assertEqual(got["min_contrast_body"], 21, got)  # only the one plain text (正文) is read
        self.assertEqual([b.split(" unmeasured ")[1] if " unmeasured " in b else b for b in got["below"]], [
            "(fill by url()) map", "(no colour known under it) map", "(no colour known under it) map",
            "(no colour known under it) map", "(outline only) map", "(no colour known under it) -", "(no colour known under it) -",
            "(::before text) -"], got)

    def test_a_type_check_with_no_result_is_a_bake_error(self):
        with mock.patch.object(bake, "TYPE", bake.TYPE + ("missing",)):
            got = bake.bake({"html": '<!doctype html><meta charset="utf-8"><div class="pg"><p>标题</p></div>', "ready": "", "width": 800})
        self.assertEqual(got, {"error": "the type check left no result on the laid-out page"})


if __name__ == "__main__":
    unittest.main()
