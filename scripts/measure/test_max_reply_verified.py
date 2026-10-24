#!/usr/bin/env python3
"""Tests for the two report-only numbers in compare_runs (--single and the A/B lines): the largest single model reply and the program's verified-checks count.
Synthetic folders only. Each mutant (the old or a looser behaviour) is applied in a temp copy of this folder and this file re-runs there; it must go red.
Run: python3 -I scripts/measure/test_max_reply_verified.py"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compare_runs  # noqa: E402
import estimate as E  # noqa: E402
import measure_lib as L  # noqa: E402
from test_support import make_relay, write_json  # noqa: E402

GOOD_RECORD = {"checks": 304, "passed": True, "integrity": {"checks": 285, "passed": True}, "recompute": {"checks": 19, "passed": True}}


def reply(size):
    return {"text": "x" * size}


def arm(root, replies, record=None, counts=None):
    """One arm folder: relay with the replies, a run folder with an optional verification.json, an optional counts.json."""
    requests = [[{"role": "user", "content": "q"}] for _ in replies]
    make_relay(os.path.join(root, "relay"), requests, replies)
    run = os.path.join(root, "T", "out", "run-x")
    os.makedirs(run)
    write_json(run, "events.jsonl", {})
    if record is not None:
        write_json(run, "verification.json", record)
    if counts is not None:
        write_json(root, "counts.json", counts)
    return root, run


class Checks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def folder(self, name, *a, **k):
        return arm(os.path.join(self.tmp, name), *a, **k)

    def test_max_reply_is_the_largest_reply_in_bytes(self):
        d, _ = self.folder("a", [reply(10), reply(300), reply(50)])
        got = L.max_reply(d)
        self.assertEqual(got, L.relay_counts(os.path.join(d, "relay"))["max_reply_bytes"])
        sizes = [len(json.dumps({"text": "x" * n}).encode()) for n in (10, 300, 50)]
        self.assertEqual(got, max(sizes))

    def test_max_reply_is_missing_when_the_replies_have_a_gap_and_never_guessed(self):
        d, _ = self.folder("gap", [reply(10), None, reply(50)])
        self.assertIsNone(L.max_reply(d))
        self.assertIsNone(L.max_reply(os.path.join(self.tmp, "no-such-arm")))
        self.assertEqual(L.max_reply(d, {"max_reply_bytes": 77}), 77)

    def test_verified_checks_count_only_a_passed_program_record(self):
        _, run = self.folder("ok", [reply(1)], GOOD_RECORD)
        self.assertEqual(L.program_check_count(run), {"program_checks_counted": 304, "check_record_status": "counted"})
        for name, record in (("top", {**GOOD_RECORD, "passed": False}), ("topnull", {**GOOD_RECORD, "passed": None}), ("topstr", {**GOOD_RECORD, "passed": "true"}),
                             ("part", {**GOOD_RECORD, "recompute": {"checks": 19, "passed": False}})):
            _, run = self.folder(name, [reply(1)], record)
            self.assertEqual(L.program_check_count(run), {"program_checks_counted": 0, "check_record_status": "not_passed"}, name)

    def test_verified_checks_are_missing_for_an_absent_or_malformed_record(self):
        _, run = self.folder("none", [reply(1)])
        self.assertEqual(L.program_check_count(run), {"program_checks_counted": None, "check_record_status": "missing"})
        self.assertEqual(L.program_check_count(None)["check_record_status"], "missing")
        for name, record in (("neg", {**GOOD_RECORD, "checks": -1}), ("bool", {**GOOD_RECORD, "checks": True}), ("float", {**GOOD_RECORD, "checks": 2.5}),
                             ("nokey", {"passed": True})):
            _, run = self.folder(name, [reply(1)], record)
            self.assertEqual(L.program_check_count(run)["check_record_status"], "missing", name)
        _, run = self.folder("broken", [reply(1)])
        with open(os.path.join(run, "verification.json"), "w") as handle:
            handle.write("{not json")
        self.assertEqual(L.program_check_count(run)["check_record_status"], "missing")

    def test_model_written_claims_do_not_make_a_count(self):
        # claims.jsonl and story.json are model-side files and deny-listed: a planted "verified" record there changes nothing
        _, run = self.folder("claims", [reply(1)])
        write_json(run, "claims.jsonl", {"status": "verified", "verification": {"authority": "model"}})
        write_json(run, "story.json", {"verified": 99, "checks": 99, "passed": True})
        self.assertEqual(L.program_check_count(run)["check_record_status"], "missing")

    def run_single(self, d):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = compare_runs.main(["--single", d])
        return rc, buf.getvalue()

    def test_single_prints_both_numbers_and_still_runs_without_counts_json(self):
        d, _ = self.folder("s", [reply(10), reply(300)], GOOD_RECORD, {"news_exit": 0, "final_result": "exited"})
        _, out = self.run_single(d)
        size = L.max_reply(d)
        self.assertIn(f"max single reply {size} bytes (about {round(size / E.BYTES_PER_TOKEN)} tokens, estimated)", out)
        self.assertIn("program checks counted (checks the program ran, not conclusions) 304 (report-only)", out)
        d, _ = self.folder("s2", [reply(10)], None)
        rc, out = self.run_single(d)  # no counts.json and no verification.json: both say missing, no crash
        self.assertEqual(rc, 1)
        self.assertIn("program checks counted (checks the program ran, not conclusions) missing", out)
        d, _ = self.folder("s3", [reply(1)], {**GOOD_RECORD, "passed": False}, {"news_exit": 0, "final_result": "exited"})
        self.assertIn("program checks counted (checks the program ran, not conclusions) 0 (the program's record is not passed)", self.run_single(d)[1])

    def test_an_unfinished_run_marks_its_largest_reply_and_a_finished_one_does_not(self):
        done, _ = self.folder("done", [reply(10), reply(300)], GOOD_RECORD, {"news_exit": 0, "final_result": "exited"})
        stopped, _ = self.folder("stopped", [reply(10), reply(300)], GOOD_RECORD, {"news_exit": 2, "final_result": "exited"})
        self.assertNotIn("run not completed", self.run_single(done)[1])
        self.assertIn("bytes (about", self.run_single(stopped)[1].split("run not completed")[0])
        self.assertIn("estimated) [run not completed]", self.run_single(stopped)[1])
        self.assertEqual(compare_runs.reply_text(5, False).endswith("[run not completed]"), True)
        self.assertEqual(compare_runs.reply_text(None, False), "missing")  # nothing to label when there is no number
        self.assertNotIn("not completed", compare_runs.reply_text(5, True))

    def test_the_count_is_named_as_program_checks_not_conclusions(self):
        d, _ = self.folder("named", [reply(10)], GOOD_RECORD, {"news_exit": 0, "final_result": "exited"})
        out = self.run_single(d)[1]
        self.assertIn("program checks counted (checks the program ran, not conclusions)", out)
        self.assertNotIn("verified", out)

    def test_the_numbers_never_change_the_exit_code(self):
        for record in (GOOD_RECORD, None, {**GOOD_RECORD, "passed": False}):
            d, run = self.folder("x" + str(id(record)), [reply(5)], record, {"news_exit": 0, "final_result": "exited"})
            with open(os.path.join(run, "events.jsonl"), "w") as handle:
                handle.write(json.dumps({"type": "newsroom_rpc_metrics", "tool_profile": "visual-story"}) + "\n")
            write_json(d, "harness.json", {"self_test_only": False, "sandbox_sha256": "cd" * 32})
            self.assertEqual(self.run_single(d)[0], 0)

    def test_the_ab_lines_say_how_the_two_arms_compare(self):
        a, _ = self.folder("A", [reply(100), reply(200)], GOOD_RECORD)
        small, _ = self.folder("small", [reply(100), reply(150)], GOOD_RECORD)
        big, _ = self.folder("big", [reply(100), reply(900)], {**GOOD_RECORD, "passed": False})
        self.assertEqual(E.max_reply_check(L.max_reply(small), L.max_reply(a)), "PASS")
        self.assertEqual(E.max_reply_check(L.max_reply(big), L.max_reply(a)), "FAIL")
        self.assertEqual(E.max_reply_check(L.max_reply(a), L.max_reply(a)), "PASS")  # equal passes
        self.assertEqual(E.max_reply_check(None, L.max_reply(a)), "INCOMPLETE")
        self.assertEqual(L.program_check_count(os.path.join(big, "T", "out", "run-x"))["program_checks_counted"], 0)
        text = compare_runs.program_checks_text(L.program_check_count(os.path.join(a, "T", "out", "run-x")))
        self.assertEqual(text, "304")
        self.assertEqual(compare_runs.reply_text(None), "missing")


# (name, file, old, new): the old or a looser behaviour; each must turn Checks red when this file re-runs against the changed copy
MUTANTS = [
    ("unfinished run not marked", "compare_runs.py", '("" if completed else " [run not completed]")', '""'),
    ("finished run marked too", "compare_runs.py", '("" if completed else " [run not completed]")', '" [run not completed]"'),
    ("count called verified again", "compare_runs.py", "program checks counted (checks the program ran, not conclusions) {program_checks_text(L.program_check_count(run))}", "verified checks {program_checks_text(L.program_check_count(run))}"),
    ("count even when not passed", "measure_lib.py", 'if record.get("passed") is not True or any(', 'if record.get("passed") is False or any('),
    ("a part that did not pass is ignored", "measure_lib.py", 'any(part.get("passed") is False for part in parts)', 'False'),
    ("truthy passed counts", "measure_lib.py", 'record.get("passed") is not True', 'not record.get("passed")'),
    ("missing record counted as zero", "measure_lib.py", 'return {"program_checks_counted": None, "check_record_status": "missing"}\n    try:',
     'return {"program_checks_counted": 0, "check_record_status": "counted"}\n    try:'),
    ("bool counts as a number", "measure_lib.py", "isinstance(checks, bool) or not isinstance(checks, int) or checks < 0", "not isinstance(checks, int) or checks < 0"),
    ("negative count accepted", "measure_lib.py", "or checks < 0:", ":"),
    ("claims file read instead", "measure_lib.py", 'VERIFICATION_FILE = "verification.json"', 'VERIFICATION_FILE = "claims.jsonl"'),
    ("max reply is the sum", "measure_lib.py", "biggest = size if biggest is None else max(biggest, size)", "biggest = size if biggest is None else biggest + size"),
    ("max reply guessed on a gap", "measure_lib.py", '"max_reply_bytes": biggest if trips is not None else None', '"max_reply_bytes": biggest or 0'),
    ("counts.json value ignored type", "measure_lib.py", "isinstance(value, int) and not isinstance(value, bool) and value >= 0", "True"),
    ("single stops printing max reply", "compare_runs.py", 'print(f"max single reply {reply_text(L.max_reply(folder, c), L.completion_reached(c))}; ', 'print(f"; '),
    ("single stops printing verified", "compare_runs.py", "program checks counted (checks the program ran, not conclusions) {program_checks_text(L.program_check_count(run))} (report-only)\")", "\")"),
    ("token estimate off", "compare_runs.py", "round(size / E.BYTES_PER_TOKEN)", "round(size / 4)"),
    ("single needs counts.json again", "compare_runs.py", "counts.json\"), encoding=\"utf-8\") as handle:\n            data = json.load(handle)\n    except (OSError, ValueError):\n        return {}", "counts.json\"), encoding=\"utf-8\") as handle:\n            data = json.load(handle)\n    except (OSError, ValueError):\n        raise"),
    ("not passed shown as missing", "compare_runs.py", '"not_passed": "0 (the program\'s record is not passed)"', '"not_passed": "missing"'),
    ("missing reply shown as zero", "compare_runs.py", '    if size is None:\n        return "missing"', '    if size is None:\n        return "0 bytes"'),
    ("a lower max reply fails", "estimate.py", "return \"PASS\" if tested <= reference else \"FAIL\"", "return \"PASS\" if tested < reference else \"FAIL\""),
]


class TestMutants(unittest.TestCase):
    def test_every_mutant_turns_a_check_red(self):
        if os.environ.get("K_MUTANT"):
            self.skipTest("inside a mutant copy")
        survived = []
        for i, (name, rel, old, new) in enumerate(MUTANTS):
            copy = tempfile.mkdtemp(prefix=f"mrvmut{i}-")
            try:
                for f in os.listdir(HERE):
                    if f.endswith(".py"):
                        shutil.copy(os.path.join(HERE, f), copy)
                path = os.path.join(copy, rel)
                text = open(path, encoding="utf-8").read()
                self.assertEqual(text.count(old), 1, f"mutant {name!r}: the text to change must occur exactly once")
                open(path, "w", encoding="utf-8").write(text.replace(old, new))
                env = dict(os.environ, K_MUTANT="1")
                done = subprocess.run([sys.executable, "-I", os.path.join(copy, "test_max_reply_verified.py"), "Checks"], capture_output=True, text=True, env=env, timeout=120)
                if done.returncode == 0:
                    survived.append(name)
            finally:
                shutil.rmtree(copy, True)
        self.assertEqual(survived, [], "mutants that did not turn anything red")
        self.assertGreaterEqual(len(MUTANTS), 17)


if __name__ == "__main__":
    unittest.main()
