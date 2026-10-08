#!/usr/bin/env python3
"""Latin-only previews fall back to the Chrome path when cairosvg is not installed."""
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("rasterize_svg", ROOT / "runtime" / "pi" / "rasterize_svg.py")
sys.path.insert(0, str(ROOT / "runtime" / "pi"))  # browser_qa.py sits next to rasterize_svg.py at run time
rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rs)

SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="1" y="5">Latin only</text></svg>'


def run_main(src: Path, dst: Path) -> str:
    out = io.StringIO()
    with mock.patch.object(sys, "argv", ["rasterize_svg.py", str(src), str(dst), "--width", "800"]), redirect_stdout(out):
        rs.main()
    return out.getvalue()


class RasterizeFallback(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.src = Path(self.tmp.name) / "a.svg"
        self.src.write_text(SVG, encoding="utf-8")
        self.dst = Path(self.tmp.name) / "out" / "a.png"

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_cairosvg_uses_chrome_path(self):
        calls = []

        def fake_chrome(src, dst, width, **kw):
            calls.append((width, kw))
            dst.write_bytes(b"png")

        # sys.modules[name] = None makes `import cairosvg` raise ImportError.
        with mock.patch.dict(sys.modules, {"cairosvg": None}), mock.patch.object(rs, "rasterize_with_chrome", fake_chrome):
            out = run_main(self.src, self.dst)
        self.assertEqual(len(calls), 1)
        self.assertEqual(json.loads(out)["engine"], "chrome-playwright")

    def test_missing_native_libcairo_uses_chrome_path(self):
        # cairosvg installed but libcairo missing: the import raises OSError.
        calls = []

        def fake_chrome(src, dst, width, **kw):
            calls.append(width)
            dst.write_bytes(b"png")

        real_import = __import__

        def guarded(name, *a, **k):
            if name == "cairosvg":
                raise OSError("no library called cairo-2 was found")
            return real_import(name, *a, **k)

        with mock.patch("builtins.__import__", guarded), mock.patch.object(rs, "rasterize_with_chrome", fake_chrome):
            out = run_main(self.src, self.dst)
        self.assertEqual(calls, [800])
        self.assertEqual(json.loads(out)["engine"], "chrome-playwright")

    def test_missing_cairosvg_and_chrome_fails_clearly(self):
        with mock.patch.dict(sys.modules, {"cairosvg": None, "playwright": None, "playwright.sync_api": None}):
            with self.assertRaises(SystemExit) as cm:
                run_main(self.src, self.dst)
        self.assertIn("preview needs Chrome", str(cm.exception))
        self.assertFalse(self.dst.exists())

    def test_cairosvg_present_is_unchanged(self):
        fake = mock.Mock()
        fake.svg2png.side_effect = lambda url, write_to, output_width: Path(write_to).write_bytes(b"png")
        chrome = mock.Mock()
        with mock.patch.dict(sys.modules, {"cairosvg": fake}), mock.patch.object(rs, "rasterize_with_chrome", chrome):
            out = run_main(self.src, self.dst)
        chrome.assert_not_called()
        self.assertEqual(json.loads(out)["engine"], "cairosvg")


if __name__ == "__main__":
    unittest.main()
