#!/usr/bin/env python3
"""Tests for replay_ratchet.py: fake +1 request, fake -1 check run, equal, fewer requests with more checks, update and hand-edit."""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)
import replay_ratchet as rr  # noqa: E402
import test_support as S  # noqa: E402

BASELINE = os.path.join(ROOT, "ci", "replay-ratchet-baseline.json")
LOCK = os.path.join(ROOT, "ci", "replay-ratchet.lock")

BASE = {"us": {"requests": 48, "checks": {"newsroom_page_lint": 3, "newsroom_viz_critic": 2}}}


def now(requests=48, **checks):
    c = {"newsroom_page_lint": 3, "newsroom_viz_critic": 2}
    c.update(checks)
    return {"us": {"requests": requests, "checks": c}}


class Ratchet(unittest.TestCase):
    def test_plus_one_request_fails(self):
        _, bad = rr.compare(BASE, now(requests=49))
        self.assertEqual([b[:2] for b in bad], [("us", "requests")])

    def test_minus_one_check_run_fails(self):
        _, bad = rr.compare(BASE, now(newsroom_viz_critic=1))
        self.assertEqual([b[:2] for b in bad], [("us", "newsroom_viz_critic")])

    def test_equal_passes(self):
        self.assertEqual(rr.compare(BASE, now())[1], [])

    def test_fewer_requests_more_checks_passes(self):
        self.assertEqual(rr.compare(BASE, now(requests=40, newsroom_page_lint=5))[1], [])

    def test_check_kind_vanishing_fails(self):
        n = now()
        del n["us"]["checks"]["newsroom_viz_critic"]
        self.assertEqual([b[1] for b in rr.compare(BASE, n)[1]], ["newsroom_viz_critic"])

    def test_missing_archive_fails(self):
        self.assertEqual(rr.compare(BASE, {})[1][0][:2], ("us", "archive"))

    def test_tightened_only_allowed_direction(self):
        t = rr.tightened(BASE, now(requests=40, newsroom_page_lint=5, newsroom_viz_critic=2))
        self.assertEqual(t["us"], {"requests": 40, "checks": {"newsroom_page_lint": 5, "newsroom_viz_critic": 2}})


class Files(unittest.TestCase):
    def test_baseline_roundtrip_and_hand_edit_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "b.json")
            rr.write_baseline(p, "x", BASE)
            self.assertEqual(rr.load_baseline(p)["archives"], BASE)
            data = json.load(open(p))
            data["archives"]["us"]["requests"] = 99
            json.dump(data, open(p, "w"))
            with self.assertRaises(SystemExit):
                rr.load_baseline(p)

    def test_failed_update_leaves_baseline(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "b.json")
            rr.write_baseline(p, "x", BASE)
            before = open(p).read()
            orig = rr.count_arm
            rr.count_arm = lambda folder: now(requests=49)["us"]
            try:
                self.assertEqual(rr.main(["--baseline", p, "--arm", "us=/x", "--update"]), 1)
            finally:
                rr.count_arm = orig
            self.assertEqual(open(p).read(), before)

    def test_init_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "b.json")
            rr.write_baseline(p, "x", BASE)
            orig = rr.count_arm
            rr.count_arm = lambda folder: BASE["us"]
            try:
                with self.assertRaises(SystemExit):
                    rr.main(["--baseline", p, "--arm", "us=/x", "--init"])
            finally:
                rr.count_arm = orig


class Lock(unittest.TestCase):
    def test_the_committed_baseline_matches_its_lock_and_its_own_digest(self):
        ok, message = rr.check_lock(BASELINE, LOCK)
        self.assertTrue(ok, message)
        data = rr.load_baseline(BASELINE)
        self.assertEqual(len(data["archives"]), 5)
        self.assertEqual(len(open(LOCK).read().strip()), 64)

    def copies(self, d):
        b, k = os.path.join(d, "b.json"), os.path.join(d, "b.lock")
        shutil.copy(BASELINE, b)
        shutil.copy(LOCK, k)
        return b, k

    def test_any_change_to_the_baseline_file_breaks_the_lock(self):
        with tempfile.TemporaryDirectory() as d:
            b, k = self.copies(d)
            self.assertTrue(rr.check_lock(b, k)[0])
            data = rr.load_baseline(b)
            name = sorted(data["archives"])[0]
            data["archives"][name]["requests"] += 1
            rr.write_baseline(b, data["label"], data["archives"])  # a valid file with a valid digest, so only the lock can catch it
            rr.load_baseline(b)
            self.assertFalse(rr.check_lock(b, k)[0])
            with open(b, "a") as h:                                  # a byte appended
                h.write(" ")
            self.assertFalse(rr.check_lock(b, k)[0])

    def test_missing_lock_or_baseline_fails(self):
        with tempfile.TemporaryDirectory() as d:
            b, k = self.copies(d)
            os.remove(k)
            self.assertFalse(rr.check_lock(b, k)[0])
            b2, k2 = self.copies(os.path.join(d, "x") if os.makedirs(os.path.join(d, "x")) is None else d)
            os.remove(b2)
            self.assertFalse(rr.check_lock(b2, k2)[0])

    def test_check_lock_command_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            b, k = self.copies(d)
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(rr.main(["--baseline", b, "--check-lock", k]), 0)
            self.assertIn("LOCK OK", out.getvalue())
            open(k, "w").write("0" * 64 + "\n")
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(rr.main(["--baseline", b, "--check-lock", k]), 1)
            self.assertIn("LOCK FAIL", out.getvalue())

    def test_update_never_writes_the_lock(self):
        with tempfile.TemporaryDirectory() as d:
            b, k = self.copies(d)
            lock_before = open(k).read()
            data = rr.load_baseline(b)
            name = sorted(data["archives"])[0]
            better = dict(data["archives"][name], requests=data["archives"][name]["requests"] - 1)
            orig = rr.count_arm
            rr.count_arm = lambda folder: better if folder == "/" + name else data["archives"][folder[1:]]
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    arms = [x for n in sorted(data["archives"]) for x in ("--arm", f"{n}=/{n}")]
                    self.assertEqual(rr.main(["--baseline", b, *arms, "--update"]), 0)
            finally:
                rr.count_arm = orig
            self.assertEqual(rr.load_baseline(b)["archives"][name]["requests"], better["requests"])  # the baseline did tighten
            self.assertEqual(open(k).read(), lock_before)                                            # the lock did not move
            self.assertFalse(rr.check_lock(b, k)[0])                                                 # so the signed lock now disagrees

    def test_init_and_update_refuse_a_lock_path_as_the_baseline(self):
        with tempfile.TemporaryDirectory() as d:
            _, k = self.copies(d)
            for flag in ("--init", "--update"):
                with self.assertRaises(SystemExit):
                    rr.main(["--baseline", k, "--arm", "x=/x", flag])
            self.assertEqual(open(k).read().strip(), open(LOCK).read().strip())


class CountArm(unittest.TestCase):
    def test_counts_requests_and_check_runs_of_a_synthetic_arm(self):
        with tempfile.TemporaryDirectory() as d:
            relay = os.path.join(d, "relay")
            os.makedirs(relay)
            S.make_relay(relay, [[{"role": "user", "content": "q"}]] * 3,
                         [{"tool_calls": [{"name": "newsroom_page_lint"}]}, {"tool_calls": [{"name": "write_file"}]}, {"text": "done"}])
            S.write(d, "T/out/run1/events.jsonl", json.dumps({"type": "agent_start"}) + "\n")
            got = rr.count_arm(d)
            self.assertEqual(got, {"requests": 3, "checks": {"newsroom_page_lint": 1}})
            os.remove(os.path.join(relay, "reply-1.json"))
            self.assertEqual(rr.count_arm(d)["checks"], {})            # the count follows the reply files
            shutil.rmtree(os.path.join(d, "T", "out", "run1"))
            with self.assertRaises(SystemExit):
                rr.count_arm(d)                                        # no run folder: refused, not zero


if __name__ == "__main__":
    unittest.main()
