"""Self-test of how the bake starts Chrome (runtime/leaves_py/bake.py command, sandboxed): Chrome keeps its own sandbox
unless this process is already inside an OS sandbox, and only then is it started with --no-sandbox; every other flag, the
guard among them, is the same both ways. On macOS a child started under sandbox-exec finds itself sandboxed.
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


if __name__ == "__main__":
    unittest.main()
