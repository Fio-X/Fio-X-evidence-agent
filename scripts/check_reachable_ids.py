#!/usr/bin/env python3
"""Commit ids written in .github and scripts must be ones this history has.

usage: check_reachable_ids.py [--root DIR]   (run inside the checkout; exits 1 on a finding)

A. A 7-40 digit hex token that names a commit existing in this clone must be an ancestor of HEAD (a number that only an old, rewritten branch
   has is how CI came to read `git worktree add ... <id>` against a history without it). scripts/reachable_ids_allow.txt lists tokens kept on
   purpose, one per line (`#` starts a comment): comments that name a commit of a branch that is not part of this history.
B. A token in a git-reference position (a code or workflow line with git archive/show/worktree/diff/rev-parse/merge-base/log/checkout, or
   BASE/BASELINE = "<id>") must resolve to a commit in this clone, which catches the same mistake on a clean clone where the old ids do not exist.
Comment-only lines are exempt from B. Nothing here touches a product gate: it only stops a CI configuration error.
"""
import os
import re
import subprocess
import sys

TOKEN = re.compile(r"(?<![0-9A-Za-z_])[0-9a-f]{7,40}(?![0-9A-Za-z_])")
GIT_WORDS = re.compile(r"\bgit\b.*\b(archive|show|worktree|diff|rev-parse|merge-base|log|checkout|cat-file)\b|[\"']git[\"'].*[\"'](archive|show|worktree|diff|rev-parse|merge-base|log|checkout|cat-file)[\"']")
BASE_ASSIGN = re.compile(r"\bBASE(?:LINE)?(?:_SHA|_REF)?\s*[:=]\s*[\"']([0-9a-f]{7,40})[\"']")
ALLOW = "scripts/reachable_ids_allow.txt"


def git(*args, input=None):
    return subprocess.run(["git", *args], capture_output=True, text=True, input=input)


def comment_only(line):
    s = line.lstrip()
    return s.startswith(("//", "#", "*", "/*"))


def scan(root):
    files = git("ls-files", ".github", "scripts").stdout.split()
    found = []  # (path, lineno, token, in_reference_position)
    for path in files:
        full = os.path.join(root, path)
        if path == ALLOW or not os.path.isfile(full) or os.path.getsize(full) > 2_000_000:
            continue
        try:
            text = open(full, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            tokens = [t for t in TOKEN.findall(line) if any(c.isdigit() for c in t)]
            if not tokens:
                continue
            reference = not comment_only(line) and bool(GIT_WORDS.search(line) or BASE_ASSIGN.search(line))
            for token in tokens:
                found.append((path, number, token, reference))
    return found


def resolve(tokens):
    """token -> full sha of the commit it names, or None (missing, ambiguous, not a commit)."""
    tokens = sorted(set(tokens))
    out = git("cat-file", "--batch-check", input="".join(f"{t}^{{commit}}\n" for t in tokens)).stdout.splitlines()
    result = {}
    for token, row in zip(tokens, out):
        parts = row.split()
        result[token] = parts[0] if len(parts) == 3 and parts[1] == "commit" else None
    return result


def main(argv):
    root = os.getcwd()
    if "--root" in argv:
        root = argv[argv.index("--root") + 1]
        os.chdir(root)
    allow = set()
    if os.path.exists(ALLOW):
        for line in open(ALLOW, encoding="utf-8"):
            line = line.split("#", 1)[0].strip()
            if line:
                allow.add(line)
    found = scan(root)
    sha = resolve(t for _, _, t, _ in found)
    ancestor = {}
    problems = []
    for path, number, token, reference in found:
        full = sha[token]
        if full is not None:
            if full not in ancestor:
                ancestor[full] = git("merge-base", "--is-ancestor", full, "HEAD").returncode == 0
            if not ancestor[full] and token not in allow:
                problems.append(f"{path}:{number}: {token} is a commit of this clone but not an ancestor of HEAD")
        elif reference:
            problems.append(f"{path}:{number}: {token} is used as a git reference but is not a commit of this history")
    for problem in problems:
        print(problem)
    if problems:
        print(f"check_reachable_ids: {len(problems)} finding(s)")
        return 1
    print("check_reachable_ids: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
