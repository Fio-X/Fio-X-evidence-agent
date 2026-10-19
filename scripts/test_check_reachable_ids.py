#!/usr/bin/env python3
import os
import subprocess
import sys
import tempfile
import unittest

CHECK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check_reachable_ids.py")
# The dates are fixed so that every commit id below is the same on every run: a commit id depends on its time, and about 1 id in 1000 has a 7-character
# prefix of letters only, which the checker's has-a-digit rule skips (#231). setUp asserts that the two prefixes the tests name do contain a digit.
FIXED_DATE = "2026-01-01T00:00:00+0000"
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
       "GIT_AUTHOR_DATE": FIXED_DATE, "GIT_COMMITTER_DATE": FIXED_DATE}


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=ENV, capture_output=True, text=True, check=True).stdout.strip()


def commit(repo, files, message):
    for path, text in files.items():
        os.makedirs(os.path.dirname(os.path.join(repo, path)) or repo, exist_ok=True)
        open(os.path.join(repo, path), "w").write(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def check(repo):
    return subprocess.run([sys.executable, CHECK], cwd=repo, capture_output=True, text=True)


class ReachableIds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = self.tmp.name
        git(self.repo, "init", "-q", "-b", "main")
        self.first = commit(self.repo, {"scripts/a.txt": "x\n"}, "first")
        git(self.repo, "checkout", "-q", "-b", "old")
        self.old = commit(self.repo, {"scripts/b.txt": "y\n"}, "only on the old branch")
        git(self.repo, "checkout", "-q", "main")
        for name in ("first", "old"):
            self.assertTrue(any(ch.isdigit() for ch in getattr(self, name)[:7]), f"{name}[:7] is all letters, so the checker would skip it: {getattr(self, name)[:7]}")

    def tearDown(self):
        self.tmp.cleanup()

    def test_ancestor_and_reference_to_it_pass(self):
        commit(self.repo, {"scripts/t.mjs": f'const BASE = "{self.first[:7]}";\n'}, "uses an ancestor")
        out = check(self.repo)
        self.assertEqual(out.returncode, 0, out.stdout)

    def test_id_of_a_non_ancestor_commit_fails_even_in_a_comment(self):
        commit(self.repo, {".github/workflows/ci.yml": f"# base {self.old[:7]}\n"}, "names the old commit")
        out = check(self.repo)
        self.assertEqual(out.returncode, 1)
        self.assertIn(f"{self.old[:7]} is a commit of this clone but not an ancestor", out.stdout)

    def test_allowlist_keeps_a_comment_id(self):
        commit(self.repo, {"scripts/t.mjs": f"// see {self.old[:7]}\n", "scripts/reachable_ids_allow.txt": f"{self.old[:7]} # kept\n"}, "allowed")
        self.assertEqual(check(self.repo).returncode, 0)

    def test_a_reference_that_does_not_exist_fails_but_the_same_id_in_a_comment_does_not(self):
        # the fake ids are built here so that this file holds no id-like token itself
        in_comment, in_code = "1" + "234567", "abc" + "def1"
        commit(self.repo, {"scripts/t.mjs": f"// git show {in_comment}:x\nspawnSync('git', ['archive', '{in_code}', 'runtime'])\n"}, "dangling")
        out = check(self.repo)
        self.assertEqual(out.returncode, 1)
        self.assertIn(f"scripts/t.mjs:2: {in_code} is used as a git reference", out.stdout)
        self.assertNotIn(in_comment, out.stdout)

    def test_a_plain_hex_word_is_not_an_id(self):
        commit(self.repo, {"scripts/t.mjs": "const color = 'dead" + "beef';\nconst n = 20261012;\n"}, "words")
        self.assertEqual(check(self.repo).returncode, 0)


if __name__ == "__main__":
    unittest.main()
