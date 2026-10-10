"""Test-only helper (not a test: the name does not match scripts/test_*.py). Makes scratch directories under
TMPDIR and removes them when the interpreter exits, including after an uncaught error.
NEWSROOM_TEST_KEEP_TMP=1 keeps them and prints each path."""
import atexit
import os
import shutil
import sys
import tempfile

_made = []


def _cleanup():
    for d in _made:
        if os.environ.get("NEWSROOM_TEST_KEEP_TMP") == "1":
            print(f"[test-tmp] kept {d}", file=sys.stderr)
        else:
            shutil.rmtree(d, ignore_errors=True)


atexit.register(_cleanup)


def make_test_tmp(prefix="newsroom-test-"):
    d = tempfile.mkdtemp(prefix=prefix)
    _made.append(d)
    return d
