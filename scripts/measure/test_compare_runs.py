#!/usr/bin/env python3
"""compare_runs tests: stop rules, check rules (literal default, coverage), the verdict, recheck and pairing stops, deny-list reads.
Arms are made by measure_arm.py with a fake product on synthetic folders. Run: python3 -I scripts/measure/test_compare_runs.py"""
import builtins
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_arm_support import Base, MARK, PLANTED, RUN_A, REPLIES_A, tc  # noqa: E402,F401
import compare_runs  # noqa: E402
import measure_arm as MA  # noqa: E402
import measure_lib as L  # noqa: E402
import recheck_computations as R  # noqa: E402

GOODSIDE = {"counts": {"files": 1, "same": 1, "different": 0, "could-not-run": 0}, "note": ""}
OKRE = {"a": GOODSIDE, "b": GOODSIDE, "pairing": {"paired_same": 1, "paired_different": 0, "unpaired_a": 0, "unpaired_b": 0}}


class TestStopRules(Base):
    def make(self, arm, plan, replies, sandboxed=True, **kw):
        out, rc = self.run_arm(arm, plan, replies, **kw)
        self.assertEqual(rc, 0, self.stdout)
        if sandboxed:  # the fake-product runs use no sandbox; these tests stand in for sandboxed runs, so the self-test mark is cleared
            path = os.path.join(out, "harness.json")
            harness = json.load(open(path))
            harness["self_test_only"] = False
            harness["sandbox_sha256"] = "ab" * 32
            json.dump(harness, open(path, "w"))
        return out

    def compare(self, a, b, arm="B"):
        buf, opened, real_open = io.StringIO(), [], builtins.open

        def spy(file, *args, **kw):
            opened.append(os.path.abspath(file) if isinstance(file, (str, os.PathLike)) else None)
            return real_open(file, *args, **kw)
        with contextlib.redirect_stdout(buf), mock.patch.object(builtins, "open", spy):
            rc = compare_runs.main(["--a", a, "--b", b, "--arm", arm])
        self.stdout = buf.getvalue()
        runs = [L.find_run(a) + os.sep, L.find_run(b) + os.sep]
        self.assertTrue(any(p and p.startswith(tuple(runs)) and p.endswith("i.html") for p in opened), "positive control: hashing opens run files")
        for p in opened:
            for run in runs:
                if p and p.startswith(run):
                    self.assertFalse(L.is_denied(os.path.relpath(p, run)), "opened a deny-listed file: " + os.path.relpath(p, run))
        return rc, json.load(open(os.path.join(b, "compare-vs-A.json")))

    def rules(self, doc):
        return sorted(s["rule"] for s in doc["stops"])

    def test_compare_end_to_end(self):
        a = self.make("A", RUN_A, REPLIES_A)
        # B good: fewer fields in request-1 tools (row 3 evidence), two completion skips (row 7 evidence), same checks, same data
        good = json.loads(json.dumps(RUN_A))
        good["tool_fields"] = []
        good["events"] = [{"type": "turn_start"}] * 4 + [{"type": "completion_retry_skipped"}, {"type": "completion_retry_skipped"}]
        good["refusals"] = [{"kind": "k_one"}]
        b = self.make("B", good, REPLIES_A)
        rc, doc = self.compare(a, b)
        self.assertEqual((rc, self.rules(doc)), (0, []), doc)
        self.assertTrue(doc["trim_field_evidence"])
        # report-only: the largest single reply and the program's verified count appear in the A/B output and the json, and move no exit code
        self.assertIn("max single reply: A ", self.stdout)
        self.assertIn("program checks counted (checks the program ran, not conclusions): A missing / other missing (report-only)", self.stdout)
        self.assertEqual(doc["max_reply_bytes"]["a"], doc["max_reply_bytes"]["other"])
        self.assertEqual(doc["max_reply_bytes"]["check"], "PASS")
        self.assertTrue(doc["max_reply_bytes"]["report_only"] and doc["program_checks_counted"]["report_only"])
        self.no_secret_in_outputs(b)
        # the audit text is stored, not printed
        self.assertTrue(os.path.exists(os.path.join(b, "compare-vs-A.audit.txt")))
        # row 3 evidence missing (fields still in B's tools)
        bad = json.loads(json.dumps(good)); bad["tool_fields"] = list(L.TRIM_FIELDS)
        rc, doc = self.compare(a, self.make("B", bad, REPLIES_A))
        self.assertEqual((rc, self.rules(doc)), (2, ["row3_evidence_missing"]))
        # arm-B refusal without counterpart + is_error without counterpart + data sha differs + a check ran fewer times
        bad = json.loads(json.dumps(good))
        bad["refusals"] = [{"kind": "k_one"}, {"kind": "k_new"}]
        bad["last_is_error"] = 1
        bad["files"]["data/d.csv"] = "different"
        bad["chain"] = [{"type": "tool_execution_end", "toolName": "newsroom_infographic_lint"}]
        rc, doc = self.compare(a, self.make("B", bad, REPLIES_A))
        self.assertEqual(rc, 2)
        self.assertEqual(self.rules(doc), sorted(["is_error_without_counterpart", "data_sha_differs", "check_ran_fewer", "check_ran_fewer"]), doc["stops"])
        self.assertEqual([r["rule"] for r in doc["reported"]], ["refusal_without_counterpart"])  # report-only now, in both modes
        # a computation whole-file sha difference alone is report-only now
        bad = json.loads(json.dumps(good)); bad["files"]["computations/c.json"] = "99"
        rc, doc = self.compare(a, self.make("B", bad, REPLIES_A))
        self.assertEqual((rc, self.rules(doc)), (0, []))
        self.assertFalse(doc["sha_compare"]["computations"]["equal"])
        self.assertTrue(doc["computation_sha_is_report_only"])
        # an infographics difference alone is NOT a stop (the page is for a reviewer's eye)
        bad = json.loads(json.dumps(good)); bad["files"]["infographics/i.html"] = "other page"
        rc, doc = self.compare(a, self.make("B", bad, REPLIES_A))
        self.assertEqual((rc, self.rules(doc)), (0, []))
        self.assertFalse(doc["sha_compare"]["infographics"]["equal"])
        # C3: rule 5 candidate only when nothing stops and no more turns / refusals
        rc, doc = self.compare(a, self.make("C3", json.loads(json.dumps(RUN_A)), REPLIES_A), "C3")
        self.assertEqual((rc, self.rules(doc)), (0, []))
        self.assertTrue(doc["verdict"]["fix_at_3_candidate"])
        self.assertNotIn("row3_evidence_missing", self.rules(doc))
        more = json.loads(json.dumps(RUN_A)); more["requests"] = 5
        rc, doc = self.compare(a, self.make("C3", more, REPLIES_A + [{"text": "x"}]), "C3")
        self.assertFalse(doc["verdict"]["no_more_turns"])
        self.assertFalse(doc["verdict"]["fix_at_3_candidate"])
        more = json.loads(json.dumps(RUN_A)); more["refusals"] = [{"kind": "k_one"}, {"kind": "k_one"}]
        rc, doc = self.compare(a, self.make("C3", more, REPLIES_A), "C3")
        self.assertEqual(self.rules(doc), [])  # the per-kind rise is no stop; the total rise (2 > 1) still fails the verdict
        self.assertEqual([r["rule"] for r in doc["reported"]], ["refusal_without_counterpart"])
        self.assertFalse(doc["verdict"]["no_more_refusals"])
        self.assertFalse(doc["verdict"]["fix_at_3_candidate"])

    def compare_rule(self, a, b, arm="B", rule="literal"):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = compare_runs.main(["--a", a, "--b", b, "--arm", arm, "--check-rule", rule])
        self.stdout = buf.getvalue()
        return rc, json.load(open(os.path.join(b, "compare-vs-A.json")))

    def test_self_test_arms_do_not_count(self):
        a = self.make("A", RUN_A, REPLIES_A)
        c3 = self.make("C3", json.loads(json.dumps(RUN_A)), REPLIES_A)
        rc, doc = self.compare_rule(a, c3, "C3")
        self.assertTrue(doc["counts_as_evidence"])
        self.assertTrue(doc["verdict"]["fix_at_3_candidate"])
        self.assertNotIn("DOES NOT COUNT", self.stdout)
        for which in ("a", "b"):  # either side marked self-test: not evidence, never a candidate
            a2 = self.make("A", RUN_A, REPLIES_A, sandboxed=which != "a")
            c2 = self.make("C3", json.loads(json.dumps(RUN_A)), REPLIES_A, sandboxed=which != "b")
            rc, doc = self.compare_rule(a2, c2, "C3")
            self.assertFalse(doc["counts_as_evidence"], which)
            self.assertFalse(doc["verdict"]["fix_at_3_candidate"], which)
            self.assertIn("DOES NOT COUNT", self.stdout)

    def test_evidence_fails_closed_on_missing_or_partial_harness_records(self):
        good = {"self_test_only": False, "sandbox_sha256": "ab" * 32}
        self.assertTrue(compare_runs.counts_as_evidence(good))
        for bad in ({}, {"self_test_only": False}, {"sandbox_sha256": "ab" * 32}, {"self_test_only": None, "sandbox_sha256": "ab" * 32},
                    {"self_test_only": 0, "sandbox_sha256": "ab" * 32}, {"self_test_only": "", "sandbox_sha256": "ab" * 32}, {"self_test_only": True, "sandbox_sha256": "ab" * 32},
                    {"self_test_only": False, "sandbox_sha256": None}, {"self_test_only": False, "sandbox_sha256": ""}, {"self_test_only": False, "sandbox_sha256": "short"}):
            self.assertFalse(compare_runs.counts_as_evidence(bad), bad)
        a = self.make("A", RUN_A, REPLIES_A)
        for label, mutate in (("harness file missing", lambda h: os.remove(h)),
                              ("key missing", lambda h: json.dump({"sandbox_sha256": "ab" * 32}, open(h, "w"))),
                              ("not an object", lambda h: json.dump([1], open(h, "w")))):
            for side in ("a", "b"):
                a2 = self.make("A", RUN_A, REPLIES_A)
                c2 = self.make("C3", json.loads(json.dumps(RUN_A)), REPLIES_A)
                mutate(os.path.join(a2 if side == "a" else c2, "harness.json"))
                rc, doc = self.compare_rule(a2, c2, "C3")  # a missing file on the B side is no crash either
                self.assertFalse(doc["counts_as_evidence"], (label, side))
                self.assertFalse(doc["verdict"]["fix_at_3_candidate"], (label, side))
                self.assertEqual(rc, compare_runs.NOT_EVIDENCE_EXIT, (label, side))
        self.assertEqual(self.compare_rule(a, self.make("C3", json.loads(json.dumps(RUN_A)), REPLIES_A), "C3")[0], 0)  # positive control

    def test_a_self_test_comparison_exits_non_zero_even_when_no_stop_fires(self):
        a = self.make("A", RUN_A, REPLIES_A, sandboxed=False)
        b = self.make("C3", json.loads(json.dumps(RUN_A)), REPLIES_A, sandboxed=False)
        rc, doc = self.compare_rule(a, b, "C3")
        self.assertEqual((self.rules(doc), rc), ([], compare_runs.NOT_EVIDENCE_EXIT))

    def test_single_does_not_pass_a_run_without_a_sandbox_record(self):
        self.assertEqual(self.run_single(self.single_folder(0, True)), 0)
        for harness in (None, {}, {"self_test_only": True, "sandbox_sha256": None}, {"self_test_only": False}):
            self.assertEqual(self.run_single(self.single_folder(0, True, harness=harness)), compare_runs.NOT_EVIDENCE_EXIT, harness)
            self.assertIn("DOES NOT COUNT", self.stdout)
        # a stop that already fails the run keeps its own code
        self.assertEqual(self.run_single(self.single_folder(2, True, harness=None)), 1)

    def test_c3_verdict_ignores_fewer_checks_and_per_kind_rise(self):
        a = self.make("A", RUN_A, REPLIES_A)
        few = json.loads(json.dumps(RUN_A))  # fewer check calls (no chain runs), every check passes, same turns, same refusals
        few["chain"] = [{"type": "chain_done"}]
        few["refusals"] = [{"kind": "k_other"}]  # a different kind, same total: the per-kind rise is only reported
        rc, doc = self.compare_rule(a, self.make("C3", few, REPLIES_A), "C3")
        self.assertIn("check_ran_fewer", self.rules(doc))               # literal still stops...
        self.assertTrue(doc["verdict"]["fix_at_3_candidate"])    # ...but the verdict follows the verdict rule
        self.assertEqual({s["rule"] for s in doc["verdict"]["other_signals"]}, {"check_ran_fewer", "refusal_without_counterpart"})
        self.assertIn("preview and page images: report-only", self.stdout)
        # a correctness stop (data sha) or a total refusal rise breaks the candidate
        bad = json.loads(json.dumps(few)); bad["files"]["data/d.csv"] = "different"
        rc, doc = self.compare_rule(a, self.make("C3", bad, REPLIES_A), "C3")
        self.assertFalse(doc["verdict"]["fix_at_3_candidate"])

    def test_no_argument_run_uses_the_literal_check_rule(self):
        a = self.make("A", RUN_A, REPLIES_A)
        few = json.loads(json.dumps(RUN_A)); few["tool_fields"] = []
        few["chain"] = [{"type": "tool_execution_end", "toolName": "newsroom_infographic_lint"}, {"type": "tool_execution_end", "toolName": "newsroom_viz_critic"}]
        b = self.make("B", few, REPLIES_A)
        with contextlib.redirect_stdout(io.StringIO()):
            rc = compare_runs.main(["--a", a, "--b", b, "--arm", "B"])  # no --check-rule
        doc = json.load(open(os.path.join(b, "compare-vs-A.json")))
        self.assertEqual((rc, doc["check_rule"]), (2, "literal"))
        self.assertIn("check_ran_fewer", self.rules(doc))

    def test_literal_is_unchanged_and_coverage_ignores_fewer_total_calls(self):
        a = self.make("A", RUN_A, REPLIES_A)
        few = json.loads(json.dumps(RUN_A)); few["tool_fields"] = []; few["chain"] = [{"type": "tool_execution_end", "toolName": "newsroom_infographic_lint"},
                                                                                       {"type": "tool_execution_end", "toolName": "newsroom_viz_critic"}]
        b = self.make("B", few, REPLIES_A)
        rc, doc = self.compare_rule(a, b, "B", "literal")
        self.assertEqual((rc, sorted(set(self.rules(doc)))), (2, ["check_ran_fewer"]))
        rc, doc = self.compare_rule(a, b, "B", "coverage")                # fewer total calls, the same tools ran: no stop
        self.assertEqual((rc, self.rules(doc)), (0, []), doc["stops"])
        self.assertEqual(doc["check_table"]["newsroom_infographic_lint"], {"calls_a": 4, "calls_b": 3, "refused_a": 0, "refused_b": 0})
        self.assertIn("check newsroom_infographic_lint: calls A 4 / other 3", self.stdout)

    def test_coverage_stops_on_a_tool_that_never_ran(self):
        a = self.make("A", RUN_A, REPLIES_A)
        none = json.loads(json.dumps(RUN_A)); none["tool_fields"] = []
        none["chain"] = [{"type": "tool_execution_end", "toolName": "newsroom_viz_critic"}]
        replies = [tc("newsroom_viz_critic"), tc("newsroom_viz_critic", "write_file"), tc("newsroom_viz_critic"), {"text": "done"}]  # lint never runs
        rc, doc = self.compare_rule(a, self.make("B", none, replies), "B", "coverage")
        self.assertEqual((rc, self.rules(doc)), (2, ["check_never_ran"]), doc["stops"])
        self.assertIn("newsroom_infographic_lint", doc["stops"][0]["detail"])

    def test_coverage_stops_when_completion_is_not_reached(self):
        a = self.make("A", RUN_A, REPLIES_A)
        good = json.loads(json.dumps(RUN_A)); good["tool_fields"] = []
        b = self.make("B", good, REPLIES_A)
        self.assertEqual(self.compare_rule(a, b, "B", "coverage")[1]["stops"], [])
        counts = json.load(open(os.path.join(b, "counts.json")))
        self.assertTrue(L.completion_reached(counts))                      # fake news exits 0 on its own
        counts["news_exit"] = 1                                           # completed but NOT VERIFIED
        json.dump(counts, open(os.path.join(b, "counts.json"), "w"))
        rc, doc = self.compare_rule(a, b, "B", "coverage")
        self.assertEqual((rc, self.rules(doc)), (2, ["completion_not_reached"]))
        rc, doc = self.compare_rule(a, b, "B", "literal")                  # literal does not look at completion
        self.assertEqual(self.rules(doc), [])
        # the is_error rise is no longer part of completion under coverage: reported, not a stop
        counts["news_exit"] = 0; json.dump(counts, open(os.path.join(b, "counts.json"), "w"))
        err = json.loads(json.dumps(good)); err["last_is_error"] = 1
        rc, doc = self.compare_rule(a, self.make("B", err, REPLIES_A), "B", "coverage")
        self.assertEqual((rc, self.rules(doc)), (0, []))
        self.assertIn("is_error_rise", [r["rule"] for r in doc["reported"]])
        rc, doc = self.compare_rule(a, self.make("B", err, REPLIES_A), "B", "literal")   # literal: unchanged, still a stop
        self.assertEqual(self.rules(doc), ["is_error_without_counterpart"])

    def test_c3_needs_a_completion_too(self):
        a = self.make("A", RUN_A, REPLIES_A)
        c3 = self.make("C3", RUN_A, REPLIES_A)
        self.assertTrue(self.compare_rule(a, c3, "C3")[1]["verdict"]["fix_at_3_candidate"])
        counts = json.load(open(os.path.join(a, "counts.json"))); counts["news_exit"] = 2
        json.dump(counts, open(os.path.join(a, "counts.json"), "w"))
        doc = self.compare_rule(a, c3, "C3")[1]
        self.assertFalse(doc["verdict"]["fix_at_3_candidate"])
        self.assertFalse(doc["verdict"]["completion_reached_a"])
        self.assertIn("A False / other True", self.stdout)

    def single_folder(self, exit_code, profile, result="exited", harness="sandboxed"):
        d = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
        if harness == "sandboxed":
            json.dump({"self_test_only": False, "sandbox_sha256": "cd" * 32}, open(os.path.join(d, "harness.json"), "w"))
        elif harness is not None:
            json.dump(harness, open(os.path.join(d, "harness.json"), "w"))
        json.dump({"news_exit": exit_code, "final_result": result}, open(os.path.join(d, "counts.json"), "w"))
        run = os.path.join(d, "T", "out", "run-x"); os.makedirs(run)
        with open(os.path.join(run, "events.jsonl"), "w") as h:
            h.write(json.dumps({"type": "agent_start"}) + "\n")
            h.write(json.dumps({"type": "newsroom_rpc_metrics", "tool_profile": "visual-story" if profile else "investigate"}) + "\n")
        return d

    def run_single(self, d):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = compare_runs.main(["--single", d])
        self.stdout = buf.getvalue()
        return rc

    def test_single_checks_completion_and_profile(self):
        self.assertEqual(self.run_single(self.single_folder(0, True)), 0)
        self.assertIn("profile recorded: yes", self.stdout)
        for code in (1, 2):
            self.assertEqual(self.run_single(self.single_folder(code, True)), 1)
            self.assertIn("completion_not_reached", self.stdout)
        self.assertEqual(self.run_single(self.single_folder(0, True, "stalled_twice")), 1)
        self.assertIn("completion_not_reached", self.stdout)
        self.assertEqual(self.run_single(self.single_folder(0, False)), 1)
        self.assertIn("profile_not_recorded", self.stdout)
        self.assertIn("profile recorded: no", self.stdout)

    def test_downloads_outside_frozen_are_counted_and_do_not_stop(self):
        fz = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
        json.dump({"entries": [{"url": "https://h/a"}]}, open(os.path.join(fz, "index.json"), "w"))
        relay = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
        def reply(n, urls):
            json.dump({"tool_calls": [{"name": "download_data", "arguments": {"url": u}} for u in urls] + [{"name": "news_search", "arguments": {"query": "q"}}]},
                      open(os.path.join(relay, f"reply-{n}.json"), "w"))
        reply(1, ["https://h/a"])
        self.assertEqual(MA.download_counts(relay, fz), {"downloads_total": 1, "downloads_outside_frozen": 0})
        reply(2, ["https://h/a", "https://h/b"])
        reply(3, ["https://h/c"])
        self.assertEqual(MA.download_counts(relay, fz), {"downloads_total": 4, "downloads_outside_frozen": 2})
        for outside in (0, 2):
            d = self.single_folder(0, True)
            c = json.load(open(os.path.join(d, "counts.json")))
            c.update({"downloads_total": 3, "downloads_outside_frozen": outside})
            json.dump(c, open(os.path.join(d, "counts.json"), "w"))
            self.assertEqual(self.run_single(d), 0)
            self.assertIn(f"downloads_total 3, downloads_outside_frozen {outside} (report-only)", self.stdout)

    def test_profile_is_read_from_events_jsonl(self):
        def run_with(rows, fname="events.jsonl"):
            d = tempfile.mkdtemp(dir=os.environ.get("TMPDIR"))
            with open(os.path.join(d, fname), "w") as h:
                for r in rows:
                    h.write(json.dumps(r) + "\n")
            return d
        self.assertTrue(L.profile_recorded(run_with([{"type": "newsroom_rpc_metrics", "tool_profile": "visual-story"}])))
        self.assertFalse(L.profile_recorded(run_with([{"type": "newsroom_rpc_metrics"}, {"type": "agent_start"}])))
        self.assertFalse(L.profile_recorded(run_with([{"type": "newsroom_rpc_metrics", "tool_profile": "investigate"}])))
        # the key on another event type, or in run-metrics.jsonl (the metrics file is not an event log), does not count
        self.assertFalse(L.profile_recorded(run_with([{"type": "agent_start", "tool_profile": "visual-story"}])))
        self.assertFalse(L.profile_recorded(run_with([{"tool_profile": "visual-story"}], "run-metrics.jsonl")))
        self.assertFalse(L.profile_recorded(None))

    def test_refused_by_tool_from_the_relay_structure_only(self):
        with tempfile.TemporaryDirectory() as d:
            msgs = [{"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "newsroom_infographic_lint", "input": {}},
                                                      {"type": "tool_use", "id": "t2", "name": "other", "input": {}}]},
                    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": True, "content": MARK},
                                                 {"type": "tool_result", "tool_use_id": "t2", "content": "ok"}]}]
            json.dump({"messages": msgs}, open(os.path.join(d, "req-1.json"), "w"))
            self.assertEqual(L.refused_by_tool(d), {"newsroom_infographic_lint": 1})
            self.assertNotIn(MARK, json.dumps(L.refused_by_tool(d)))

    def test_recheck_stops(self):
        a = {"tool_calls_by_tool": {}, "events_by_type": {}, "is_error_last_request": 0, "boundary_refusals_by_kind": {}}
        shas = {d: {"equal": True, "a_only_sha": 0, "b_only_sha": 0} for d in L.HASH_DIRS}
        rules = lambda **kw: sorted(s["rule"] for s in L.evaluate_stops(a, a, shas, True, **kw))
        self.assertEqual(rules(recheck=OKRE), [])
        # no recheck evidence at all, or for one side, is itself a stop: never a gap
        self.assertEqual(rules(), ["computation_recheck_missing"])
        self.assertEqual(rules(recheck={**OKRE, "b": None}), ["computation_recheck_missing"])
        self.assertEqual(rules(recheck={"a": GOODSIDE, "b": GOODSIDE}), ["computation_recheck_missing"])
        # a "different" file on either side, a "could-not-run" file, or a note stops
        for bad in ({"files": 2, "same": 1, "different": 1, "could-not-run": 0}, {"files": 2, "same": 1, "different": 0, "could-not-run": 1}):
            self.assertEqual(rules(recheck={**OKRE, "b": {"counts": bad, "note": ""}}), ["computation_recheck_not_same"])
            self.assertEqual(rules(recheck={**OKRE, "a": {"counts": bad, "note": ""}}), ["computation_recheck_not_same"])
        self.assertEqual(rules(recheck={**OKRE, "a": {"counts": GOODSIDE["counts"], "note": "integrity check failed"}}), ["computation_recheck_not_same"])
        # paired-different stops; unpaired does not
        self.assertEqual(rules(recheck={**OKRE, "pairing": {"paired_same": 0, "paired_different": 1, "unpaired_a": 0, "unpaired_b": 0}}), ["computation_paired_different"])
        self.assertEqual(rules(recheck={**OKRE, "pairing": {"paired_same": 1, "paired_different": 0, "unpaired_a": 3, "unpaired_b": 2}}), [])
        # data sha sets are still exact
        bad_shas = {**shas, "data": {"equal": False, "a_only_sha": 1, "b_only_sha": 0}}
        self.assertEqual(sorted(s["rule"] for s in L.evaluate_stops(a, a, bad_shas, True, recheck=OKRE)), ["data_sha_differs"])
        # whole-file computation sha is report-only
        rep_only = {**shas, "computations": {"equal": False, "a_only_sha": 2, "b_only_sha": 2}}
        self.assertEqual(L.evaluate_stops(a, a, rep_only, True, recheck=OKRE), [])

    def test_arm_run_recheck_end_to_end(self):
        run = {"requests": 1, "files": {"data/d.csv": "1", "computations/c.json": "2", "fake-verify.txt": "artifact integrity: PASS\nSQL recompute: FAIL\nFAIL  recompute rows mismatch: /x/computations/c.json"}}
        out, rc = self.run_arm("A", run, [{"text": "x"}])
        self.assertEqual(rc, 2, self.stdout)
        self.assertEqual(json.load(open(os.path.join(out, "stops.json")))[0]["rule"], "computation_recheck_not_same")
        rec = json.load(open(os.path.join(out, "recheck.json")))
        self.assertEqual((rec["counts"]["different"], rec["files"]), (1, {"c.json": "different"}))
        self.assertEqual(rec["news_binary_sha256"], json.load(open(os.path.join(out, "harness.json")))["binary_sha256"])
        self.assertEqual(rec["built_from_commit"], "1" * 40)
        self.assertFalse(os.path.exists(os.path.join(out, "recheck-tmp")))
        # integrity did not pass: nothing is "same"
        run["files"]["fake-verify.txt"] = "artifact integrity: FAIL\nFAIL  something"
        out, rc = self.run_arm("A", run, [{"text": "x"}])
        self.assertEqual(rc, 2)
        self.assertEqual(json.load(open(os.path.join(out, "recheck.json")))["counts"]["could-not-run"], 1)
        # all same: no stop
        del run["files"]["fake-verify.txt"]
        out, rc = self.run_arm("A", run, [{"text": "x"}])
        self.assertEqual(rc, 0)
        self.assertEqual(json.load(open(os.path.join(out, "stops.json"))), [])

    def test_compare_pairing_stop_and_missing_recheck(self):
        def comp(sql, rows_hash):
            return json.dumps({"sql": sql, "input_snapshot_hash": "h", "input_binding": "b", "result_hash": rows_hash, "rows": []})
        base = {"requests": 1, "tool_fields": list(L.TRIM_FIELDS), "files": {"data/d.csv": "1", "infographics/i.html": "page", "computations/c1.json": comp("select 1", "r1")}}

        def b_of(plan):  # side B carries none of the trimmed tool fields (positive control for row 3)
            p = json.loads(json.dumps(plan)); p["tool_fields"] = []
            return p
        a = self.make("A", base, [{"text": "x"}])
        same = self.make("B", b_of(base), [{"text": "x"}])
        rc, doc = self.compare(a, same)
        self.assertEqual((rc, self.rules(doc), doc["pairing"]["paired_same"]), (0, [], 1), doc)
        diff = b_of(base); diff["files"]["computations/c1.json"] = comp("select 1", "r-other")
        rc, doc = self.compare(a, self.make("B", diff, [{"text": "x"}]))
        self.assertEqual((rc, self.rules(doc), doc["pairing"]["paired_different"]), (2, ["computation_paired_different"], 1))
        other_sql = b_of(base); other_sql["files"]["computations/c1.json"] = comp("select 2", "r1")
        rc, doc = self.compare(a, self.make("B", other_sql, [{"text": "x"}]))
        self.assertEqual((rc, self.rules(doc), doc["pairing"]["unpaired_a"], doc["pairing"]["unpaired_b"]), (0, [], 1, 1))
        os.remove(os.path.join(same, "recheck.json"))
        rc, doc = self.compare(a, same)
        self.assertEqual((rc, self.rules(doc)), (2, ["computation_recheck_missing"]))

    def test_environment_problem_is_its_own_outcome(self):
        # (1) an environment problem (bad DuckDB path) is rc 5 and the stop rule is environment_problem, never computation_recheck_not_same
        run = {"requests": 1, "files": {"data/d.csv": "1", "computations/c.json": "{}"}}
        out, rc = self.run_arm("A", run, [{"text": "x"}], extra=["--duckdb-bin", "/nonexistent/duckdb"])
        self.assertEqual(rc, 5, self.stdout)
        self.assertIn("ENV-PROBLEM", self.stdout)
        self.assertEqual([s["rule"] for s in json.load(open(os.path.join(out, "stops.json")))], ["environment_problem"])
        rec = json.load(open(os.path.join(out, "recheck.json")))
        self.assertTrue(rec["env_problem"])
        # the compare step reads the same flag
        shas = {d: {"equal": True, "a_only_sha": 0, "b_only_sha": 0} for d in L.HASH_DIRS}
        a = {"tool_calls_by_tool": {}, "events_by_type": {}, "is_error_last_request": 0, "boundary_refusals_by_kind": {}}
        env = {"counts": GOODSIDE["counts"], "note": "ENV-PROBLEM canary: x", "env_problem": True}
        self.assertEqual([s["rule"] for s in L.evaluate_stops(a, a, shas, True, recheck={**OKRE, "b": env})], ["environment_problem"])

    def test_row7_skip_evidence_must_cover_the_gap(self):
        a = {"tool_calls_by_tool": {}, "events_by_type": {"completion_retry": 3}, "is_error_last_request": 0, "boundary_refusals_by_kind": {}}
        shas = {d: {"equal": True, "a_only_sha": 0, "b_only_sha": 0} for d in L.HASH_DIRS}
        b = {"tool_calls_by_tool": {}, "events_by_type": {"completion_retry": 1, L.COMPLETION_SKIP: 2}, "is_error_last_request": 0, "boundary_refusals_by_kind": {}}
        self.assertEqual(L.evaluate_stops(a, b, shas, True, recheck=OKRE), [])
        b["events_by_type"][L.COMPLETION_SKIP] = 1
        self.assertEqual([s["rule"] for s in L.evaluate_stops(a, b, shas, True, recheck=OKRE)], ["check_ran_fewer"])
        b["events_by_type"] = {"completion_retry": 1, L.COMPLETION_SKIP: 2}
        self.assertEqual([s["rule"] for s in L.evaluate_stops(a, b, shas, True, arm="C3", recheck=OKRE)], ["check_ran_fewer"], "C3 gets no row-7 exception")
        self.assertEqual([s["rule"] for s in L.evaluate_stops(a, b, shas, True, provider_seen=True, recheck=OKRE)], ["provider_request"])
        self.assertEqual([s["rule"] for s in L.evaluate_stops(a, b, shas, False, recheck=OKRE)], ["row3_evidence_missing"])
        # one skip event covers one missing run only
        a2 = {**a, "events_by_type": {"completion_a": 1, "completion_b": 1}}
        b2 = {**b, "events_by_type": {L.COMPLETION_SKIP: 1}}
        self.assertEqual([s["rule"] for s in L.evaluate_stops(a2, b2, shas, True, recheck=OKRE)], ["check_ran_fewer"])

    def test_deny_names(self):
        for rel in ("meta.json", "session.json", "claims.json", "story.md", "prompt.txt", "a/auth0.json", "conversation.md", "x/.env.local", "runtime/home-x/y"):
            self.assertTrue(L.is_denied(rel), rel)
        for rel in ("events.jsonl", "runtime/tool-chain-events.jsonl", "data/d.csv", "infographics/i.html", "answer.md"):
            self.assertFalse(L.is_denied(rel), rel)

    def test_wall_cap_and_missing_frozen(self):
        plan = {"requests": 1, "sleep_s": 60, "files": {"data/d.csv": "1"}}
        out, rc = self.run_arm("A", plan, [{"text": "x"}], extra=["--max-minutes", "0.05"], stall_minutes=5)
        self.assertEqual(rc, 2)
        self.assertEqual(json.load(open(os.path.join(out, "harness.json")))["final_result"], "wall_cap")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(MA.main(["--topic", "demo", "--arm", "A", "--binary", self.fake, "--commit", "1" * 40, "--out", os.path.join(self.tmp, "nf"),
                                      "--sandbox", "none", "--frozen", os.path.join(self.tmp, "nope")]), 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
