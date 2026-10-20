#!/usr/bin/env python3
"""Tests of measure_lib.py and run_audit.py on synthetic folders (no real run, no provider, no network).

Each rule has a mutant: the same check body is run with one function of the library replaced, and must fail.
The audit text of a synthetic pair is compared with fixtures/audit_expected.txt, which was made once with the audit script as it was
before its rename (see make_audit_expected.py); the tests never regenerate it.
Run: python3 -I scripts/measure/test_measure_lib.py   (the audit tests need Pillow and numpy and say so when they are missing)"""
import hashlib
import json
import os
import sys
import tempfile
import unittest
import warnings
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I does not add the script folder
import measure_lib as L  # noqa: E402
import test_support as S  # noqa: E402

warnings.simplefilter("ignore", ResourceWarning)  # the audit script leaves files for the interpreter to close
try:
    import numpy  # noqa: F401
    import PIL  # noqa: F401
    HAVE_IMAGE_LIBS = True
except ImportError:
    HAVE_IMAGE_LIBS = False


def mutant(test, case, name, replacement):
    """The check body must pass as is and fail with `name` of the library replaced."""
    test(case)
    with mock.patch.object(L, name, replacement):
        try:
            test(case)
        except AssertionError:
            return
    raise AssertionError(f"mutant not caught: {name}")


class Case(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()


def body_relay_counts(case):
    relay = os.path.join(case.tmp, "relay")
    S.make_relay(
        relay,
        [[{"role": "user", "content": "q"}],
         [{"role": "user", "content": "q"}, {"role": "assistant", "content": [S.tool_use("u1", "a_lint"), S.tool_use("u2", "other")]},
          {"role": "user", "content": [S.tool_result("u1", True), S.tool_result("u2")]}]],
        [{"tool_calls": [{"name": "a_lint"}, {"name": "other"}], "text": "x"}, {"error": "injected"}])
    c = L.relay_counts(relay)
    case.assertEqual((c["turns"], c["injected_error_replies"], c["tool_calls"], c["is_error_last_request"]), (1, 1, 2, 1))
    case.assertEqual(c["tool_calls_by_tool"], {"a_lint": 1, "other": 1})
    expected = len(json.dumps({"text": "x", "tool_calls": [{"name": "a_lint"}, {"name": "other"}]}, ensure_ascii=False).encode("utf-8"))
    expected += len(json.dumps({}, ensure_ascii=False).encode("utf-8"))
    case.assertEqual(c["model_written_bytes"], expected)


def body_deny(case):
    run = os.path.join(case.tmp, "run")
    for rel in ("data/a.csv", "data/story.md", "data/private/x.csv", "computations/prompt.txt", "maps/m.json"):
        S.write(run, rel, rel)
    rows = {d: [r for r, _ in rows] for d, rows in L.hash_lists(run).items()}
    case.assertEqual(rows["data"], ["data/a.csv"])
    case.assertEqual(rows["computations"], [])
    case.assertEqual(rows["maps"], ["maps/m.json"])
    case.assertTrue(L.is_denied("x/config.json") and L.is_denied("home/y") and not L.is_denied("data/a.csv"))


def body_check_tools(case):
    for name in ("x_lint", "x_critic", "x_validate", "x_preview", "x_render", "x_qa", "x_preflight", "x_ocr_check", "newsroom_infographic_vision_critic"):
        case.assertTrue(L.is_check_tool(name), name)
    case.assertFalse(L.is_check_tool("newsroom_write_page"))
    counts = {"tool_calls_by_tool": {"a_lint": 2, "other": 5}, "chain_inner_tool_runs": {"b_qa": 3, "plain": 1}, "events_by_type": {"completion_gate": 1, L.COMPLETION_SKIP: 4}}
    case.assertEqual(dict(L.check_runs(counts)), {"a_lint": 2, "b_qa": 3, "event:completion_gate": 1})


def body_completion(case):
    case.assertTrue(L.completion_reached({"news_exit": 0, "final_result": "exited"}))
    for bad in ({"news_exit": 1, "final_result": "exited"}, {"news_exit": 2, "final_result": "exited"}, {"news_exit": 0, "final_result": "stalled"}, {}):
        case.assertFalse(L.completion_reached(bad), bad)


def body_refused_by_tool(case):
    relay = os.path.join(case.tmp, "relay")
    S.make_relay(relay, [[{"role": "assistant", "content": [S.tool_use("u1", "a_lint"), S.tool_use("u2", "b_qa")]},
                          {"role": "user", "content": [S.tool_result("u1", True), S.tool_result("u2", False), S.tool_result("zz", True)]}]], [None])
    case.assertEqual(L.refused_by_tool(relay), {"?": 1, "a_lint": 1})


def body_run_counts(case):
    run = os.path.join(case.tmp, "run")
    S.write(run, "events.jsonl", "\n".join([json.dumps({"type": "a", "secret": "x"}), "not json", json.dumps({"type": "a"}), json.dumps(["list"]),
                                            json.dumps({"type": "newsroom_rpc_metrics", "tool_profile": "visual-story"})]))
    S.write(run, "runtime/tool-chain-events.jsonl", json.dumps({"type": "tool_execution_end", "toolName": "x_qa"}) + "\n")
    S.write(run, "runtime/boundary-refusals.jsonl", json.dumps({"kind": "k1", "detail": "text"}) + "\n" + json.dumps({"kind": "k1"}) + "\n")
    c = L.run_counts(run)
    case.assertEqual(c["events_by_type"], {"a": 2, "newsroom_rpc_metrics": 1})
    case.assertEqual((c["chain_events_by_type"], c["chain_inner_tool_runs"], c["boundary_refusals_by_kind"]), ({"tool_execution_end": 1}, {"x_qa": 1}, {"k1": 2}))
    case.assertEqual(c["event_files_missing"], [])
    empty = os.path.join(case.tmp, "empty")
    os.makedirs(empty)
    c = L.run_counts(empty)
    case.assertEqual((c["boundary_refusals_by_kind"], c["event_files_missing"]), ({}, ["events.jsonl", "runtime/tool-chain-events.jsonl"]))
    case.assertTrue(L.profile_recorded(run))
    case.assertFalse(L.profile_recorded(run, "other-profile") or L.profile_recorded(empty) or L.profile_recorded(None))


def body_sha_compare(case):
    a, b = os.path.join(case.tmp, "a"), os.path.join(case.tmp, "b")
    for root, text in ((a, "one"), (b, "one")):
        S.write(root, "data/d.csv", text)
    S.write(a, "computations/c.json", "x")
    S.write(b, "computations/c.json", "y")
    out = L.sha_compare(a, b)
    case.assertTrue(out["data"]["equal"])
    case.assertEqual((out["computations"]["equal"], out["computations"]["a_only_sha"], out["computations"]["b_only_sha"]), (False, 1, 1))
    S.write(b, "data/d.csv", "two")
    case.assertFalse(L.sha_compare(a, b)["data"]["equal"])
    case.assertEqual(L.sha_file(os.path.join(a, "data/d.csv")), hashlib.sha256(b"one").hexdigest())


class TestCounts(Case):
    def test_relay_counts(self):
        body_relay_counts(self)

    def test_relay_counts_mutants(self):
        with mock.patch.object(L.json, "dumps", lambda *a, **k: "{}"):
            with self.assertRaises(AssertionError):
                body_relay_counts(self)

    def test_run_counts_keep_only_the_named_fields(self):
        body_run_counts(self)

    def test_refused_by_tool(self):
        body_refused_by_tool(self)

    def test_check_tools_and_check_runs(self):
        body_check_tools(self)
        with mock.patch.object(L, "CHECK_SUFFIX", ("_lint",)):
            with self.assertRaises(AssertionError):
                body_check_tools(self)

    def test_completion_reached(self):
        body_completion(self)
        mutant(body_completion, self, "completion_reached", lambda c: c.get("news_exit") in (0, 1))

    def test_request_key_names_returns_names_only(self):
        relay = os.path.join(self.tmp, "relay")
        S.make_relay(relay, [[{"role": "user", "content": "SECRET-VALUE"}]], [None])
        names = L.request_key_names(relay, 1, "tools")
        self.assertEqual(names, {"name", "input_schema", "properties", "alpha", "beta"})
        self.assertFalse(any("SECRET" in n for n in names))


class TestRelaySummary(Case):
    def test_summary_is_read_through_the_relay_script_of_the_repo(self):
        relay = os.path.join(self.tmp, "relay")
        os.makedirs(relay)
        rows = [{"relay_started_at": 0.0},
                {"n": 1, "received": 1.0, "request_written": 1.5, "reply_read": 4.5, "response_sent": 5.0},
                {"n": 2, "received": 6.0, "request_written": 6.5, "reply_read": 8.5, "response_sent": 9.0}]
        S.write(relay, "timing.jsonl", "\n".join(json.dumps(r) for r in rows) + "\n")
        script = os.path.join(HERE, "..", "standin_relay.py")
        got = L.relay_summary(script, relay)
        self.assertEqual((got["requests"], got["standin_wait_s"], got["between_turns_s"], got["relay_overhead_s"]), (2, 5.0, 1.0, 2.0))
        with self.assertRaises(RuntimeError):
            L.relay_summary(script, os.path.join(self.tmp, "missing"))


class TestProgramShare(Case):
    def counts_with(self, summary):
        arm = os.path.join(self.tmp, "arm-%d" % len(os.listdir(self.tmp)))
        os.makedirs(os.path.join(arm, "relay"))
        os.makedirs(os.path.join(arm, "T", "out"))
        with mock.patch.object(L, "relay_summary", return_value=summary):
            return L.build_counts(arm, "unused", 100.0)

    def test_program_share_is_wall_minus_stand_in_wait(self):
        c = self.counts_with({"standin_wait_s": 30.0, "between_turns_s": 1.0, "relay_overhead_s": 9.0})
        self.assertEqual((c["program_s"], c["measurement_status"]), (70.0, "COMPLETE"))  # relay overhead is not subtracted

    def test_a_missing_or_unusable_wait_is_incomplete_not_a_crash_and_not_zero(self):
        for summary in ({}, {"standin_wait_s": None}, {"standin_wait_s": "7"}, {"standin_wait_s": True}, {"standin_wait_s": float("nan")}, {"standin_wait_s": -1}):
            c = self.counts_with(summary)
            self.assertIsNone(c["program_s"], summary)
            self.assertEqual(c["measurement_status"], "INCOMPLETE", summary)
            self.assertIn("INCOMPLETE", L.table_line("x", {**c, "turns": 1, "tool_calls": 0, "model_written_bytes": 0, "is_error_last_request": 0, "wall_s": 100.0}))


class TestReadLimits(Case):
    def test_denied_names_are_not_hashed(self):
        body_deny(self)
        mutant(body_deny, self, "is_denied", lambda rel: False)

    def test_sha_compare(self):
        body_sha_compare(self)
        mutant(body_sha_compare, self, "sha_file", lambda path: "0" * 64)


@unittest.skipUnless(HAVE_IMAGE_LIBS, "SKIPPED: audit cases need Pillow and numpy")
class TestAudit(Case):
    def audit(self, label="case"):
        saved, replay = S.make_audit_pair(self.tmp)
        return L.run_audit(label, saved, replay)

    def test_audit_text_matches_the_text_made_before_the_rename(self):
        with open(os.path.join(HERE, "fixtures", "audit_expected.txt"), encoding="utf-8") as handle:
            expected = handle.read()
        self.assertEqual(self.audit(), expected)

    def test_a_changed_audit_script_changes_the_text(self):
        # Mutant of the audit itself: the same fixture through a copy whose cmp wording differs must not equal the committed text.
        copy_dir = os.path.join(self.tmp, "copy")
        os.makedirs(copy_dir)
        with open(os.path.join(HERE, "run_audit.py"), encoding="utf-8") as handle:
            code = handle.read()
        self.assertIn("byte-identical after normalising", code)
        with open(os.path.join(copy_dir, "run_audit.py"), "w", encoding="utf-8") as handle:
            handle.write(code.replace("byte-identical after normalising", "changed"))
        with mock.patch.object(L, "HERE", copy_dir):
            changed = self.audit()
        with open(os.path.join(HERE, "fixtures", "audit_expected.txt"), encoding="utf-8") as handle:
            self.assertNotEqual(changed, handle.read())

    def test_the_audit_is_found_by_its_new_name_and_has_no_old_name(self):
        self.assertTrue(os.path.isfile(os.path.join(HERE, "run_audit.py")))
        self.assertEqual(sorted(f for f in os.listdir(HERE) if f.endswith("audit.py")), ["run_audit.py"])
        self.assertTrue(self.audit().startswith("== case:"))
        with mock.patch.object(L, "HERE", os.path.join(self.tmp, "nowhere")):
            self.assertTrue(self.audit().startswith("AUDIT FAILED"))

    def test_the_audit_cannot_open_denied_names(self):
        saved, replay = S.make_audit_pair(self.tmp)
        S.write(saved, "maps/story.md", "secret")
        S.write(replay, "maps/story.md", "other")
        text = L.run_audit("case", saved, replay)
        self.assertNotIn("story", text)
        with mock.patch.object(L, "is_denied", lambda rel: False):
            self.assertNotEqual(L.run_audit("case", saved, replay), text)


if __name__ == "__main__":
    unittest.main(warnings="ignore", verbosity=2)
