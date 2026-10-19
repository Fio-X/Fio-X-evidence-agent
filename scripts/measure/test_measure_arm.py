#!/usr/bin/env python3
"""measure_arm tests. Synthetic relay/run folders, a fake `news` that talks to this repository's stand-in relay, a stand-in DuckDB that only answers
`-version`. No real run folder, no provider, no real news. Run: python3 -I scripts/measure/test_measure_arm.py"""
import contextlib
import glob
import io
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from test_arm_support import Base, MARK, PLANTED, RUN_A, REPLIES_A, tc  # noqa: E402,F401
import measure_arm as MA  # noqa: E402
import measure_lib as L  # noqa: E402

QUICK = {"requests": 1, "files": {"data/d.csv": "1"}}
COMMON = lambda t: ["--topic", "demo", "--arm", "A", "--binary", t.fake, "--commit", "1" * 40, "--sandbox", "none", "--frozen", t.frozen,
                    "--child-path", "/usr/bin:/bin", "--duckdb-bin", t.duck, "--canary-dir", t.canary, "--question-file", "/x"]


class TestCounts(Base):
    def test_arm_a_counts_env_deny_and_files(self):
        out, rc = self.run_arm("A", RUN_A, REPLIES_A, extra=["--virtual-env", "/venv", "--dyld-fallback-dir", "/lib"])
        self.assertEqual(rc, 0, self.stdout)
        c = self.counts(out)
        self.assertEqual((c["turns"], c["injected_error_replies"], c["tool_calls"]), (4, 0, 4))
        self.assertEqual(c["tool_calls_by_tool"], {"newsroom_infographic_lint": 2, "newsroom_viz_critic": 1, "write_file": 1})
        want = sum(len(json.dumps({k: r[k] for k in ("thinking", "text", "tool_calls") if k in r}, ensure_ascii=False).encode()) for r in REPLIES_A)
        self.assertEqual(c["model_written_bytes"], want)
        self.assertEqual(c["events_by_type"], {"completion_retry": 2, "tool_execution_end": 1, "turn_start": 4})
        self.assertEqual(c["boundary_refusals_by_kind"], {"k_one": 1})
        self.assertAlmostEqual(c["program_s"], c["wall_s"] - c["standin_wait_s"], places=2)
        h = json.load(open(os.path.join(out, "harness.json")))
        self.assertEqual((h["switches_set_to_1"], h["NEWSROOM_AGENT_REAL"], h["final_result"]), ([], "unset", "exited"))
        self.assertTrue(h["relay_copy_is_repo_default"])
        self.assertTrue(h["self_test_only"])  # --sandbox none is recorded as a self-test, so a comparison can refuse to count it
        self.assertEqual(h["sandbox"], "none")
        env = json.load(open(os.path.join(out, "T", "env-seen.json")))
        added = {"LC_CTYPE", "__CF_USER_TEXT_ENCODING"}  # added by python / macOS, not by the harness
        self.assertEqual(sorted(set(env["names"]) - added), sorted(["HOME", "PATH", "TMPDIR", "VIRTUAL_ENV", "DYLD_FALLBACK_LIBRARY_PATH", "NEWSROOM_AGENT",
                                                                     "NEWSROOM_AGENT_LOCAL_URL", "NEWSROOM_RPC_IDLE_MS", "NEWSROOM_ARTIFACTS_DIR", "NEWSROOM_DOWNLOAD_FROZEN"]))
        run = L.find_run(out)
        self.assertTrue(os.path.isfile(os.path.join(run, "frozen-downloads", "d.csv")))
        for rel in PLANTED:  # planted files exist, were never opened, and their content is in no output
            self.assertTrue(os.path.exists(os.path.join(run, rel)), rel)
        for path in self.opened:
            if isinstance(path, str) and path.startswith(run + os.sep):
                self.assertFalse(L.is_denied(os.path.relpath(path, run)), path)
        self.assertTrue(any(isinstance(p, str) and p.endswith("events.jsonl") for p in self.opened), "positive control: the guard sees opens")
        self.no_secret_in_outputs(out)
        self.assertNotIn(MARK, json.dumps(c))

    def test_home_is_inside_the_attempt_and_no_config_path_is_passed(self):
        env = MA.child_env("/a", 1, [], "/usr/bin")
        self.assertEqual(env["HOME"], "/a/tm/home")
        for name in ("XDG_CONFIG_HOME", "NEWSROOM_ENV_FILE", "VIRTUAL_ENV", "DYLD_FALLBACK_LIBRARY_PATH"):
            self.assertNotIn(name, env)

    def test_arm_b_c3_switches_and_recipes(self):
        out, rc = self.run_arm("B", QUICK, [{"text": "x"}])
        self.assertEqual(rc, 0)
        env = json.load(open(os.path.join(out, "T", "env-seen.json")))["newsroom"]
        self.assertEqual(sorted(env), sorted(["NEWSROOM_AGENT", "NEWSROOM_DOWNLOAD_FROZEN", "NEWSROOM_RPC_IDLE_MS", *MA.ARM_B]))
        self.assertTrue(all(env[k] == "1" for k in MA.ARM_B))
        self.assertFalse(json.load(open(os.path.join(out, "harness.json")))["contains_recipes_change"])
        out, rc = self.run_arm("B", QUICK, [{"text": "x"}], extra=["--with-recipes"])
        env = json.load(open(os.path.join(out, "T", "env-seen.json")))["newsroom"]
        self.assertEqual(env.get(MA.ROW8), "1")
        out, rc = self.run_arm("C3", QUICK, [{"text": "x"}])
        env = json.load(open(os.path.join(out, "T", "env-seen.json")))["newsroom"]
        self.assertEqual(sorted(env), sorted(["NEWSROOM_AGENT", "NEWSROOM_DOWNLOAD_FROZEN", "NEWSROOM_RPC_IDLE_MS", "NEWSROOM_CONCEPT_COUNT_3"]))

    def test_every_arm_switch_is_a_row_of_the_switch_table(self):
        known = MA.switch_table_names()
        for name in MA.ARM_B + [MA.ROW8] + MA.ARM_C3:
            self.assertIn(name, known)

    def test_stray_newsroom_variable_does_not_reach_the_child_and_unlisted_names_are_not_kept(self):
        with mock.patch.dict(os.environ, {"NEWSROOM_X_PRIVATE_NAME": "1", "NEWSROOM_SPEED_PREFLIGHT": "1"}):  # the second would turn a switch on by inheritance
            out, rc = self.run_arm("A", QUICK, [{"text": "x"}])
        self.assertEqual(rc, 0)
        seen = json.load(open(os.path.join(out, "T", "env-seen.json")))
        self.assertNotIn("NEWSROOM_X_PRIVATE_NAME", seen["names"])
        self.assertNotIn("NEWSROOM_SPEED_PREFLIGHT", seen["names"])
        h = json.load(open(os.path.join(out, "harness.json")))
        self.assertEqual(h["newsroom_names_in_parent_not_passed"], ["NEWSROOM_SPEED_PREFLIGHT"])
        self.assertEqual(h["newsroom_unlisted_names_in_parent_count"], 1)
        self.assertNotIn("NEWSROOM_X_PRIVATE_NAME", json.dumps(h))

    def test_arm_r_reads_the_line_by_script(self):
        lf = os.path.join(self.tmp, "r-list.md")
        open(lf, "w").write("a\nb\nNEWSROOM_R_ONE=1 NEWSROOM_R_TWO=1\nd\n")
        names, line_sha, file_sha = MA.read_arm_r(lf, 3)
        self.assertEqual(names, ["NEWSROOM_R_ONE", "NEWSROOM_R_TWO"])
        self.assertEqual(MA.switches_for("R", False, names), names)
        for bad in ("NEWSROOM_R_ONE=0", "NEWSROOM_R_ONE=1 EVIL=1", "NEWSROOM_R_ONE=1 NEWSROOM_R_ONE=1", ""):
            open(lf, "w").write("a\nb\n" + bad + "\n")
            with self.assertRaises(ValueError):
                MA.read_arm_r(lf, 3)
        with contextlib.redirect_stdout(io.StringIO()):  # a line number past the end is refused, nothing guessed
            rc = MA.main(COMMON(self)[:3] + ["R"] + COMMON(self)[4:] + ["--out", os.path.join(self.tmp, "rr"), "--r-list-file", lf, "--r-list-line", "37", "--question-file", lf])
        self.assertEqual(rc, 4)

    def test_missing_required_argument_refuses_with_exit_4_and_a_fixed_message(self):
        flags = {"--topic": 1, "--arm": 1, "--binary": 1, "--commit": 1, "--out": 1, "--question-file": 1, "--frozen": 1, "--child-path": 1, "--duckdb-bin": 1,
                 "--canary-dir": 1, "--sandbox": 1}
        full = ["--topic", "demo", "--arm", "A", "--binary", self.fake, "--commit", "1" * 40, "--out", os.path.join(self.tmp, "m-out"), "--question-file", "/x",
                "--frozen", self.frozen, "--child-path", "/usr/bin", "--duckdb-bin", self.duck, "--canary-dir", self.canary, "--sandbox", "none"]
        for flag in flags:
            i = full.index(flag)
            argv = full[:i] + full[i + 2:]
            with contextlib.redirect_stdout(io.StringIO()) as buf:
                rc = MA.main(argv)
            self.assertEqual(rc, 4, flag)
            self.assertIn("refused: missing required argument", buf.getvalue(), flag)
            self.assertIn(flag, buf.getvalue())
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "m-out")))

    def test_refuses_provider_variables_and_bad_input(self):
        for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "NEWSROOM_AGENT_REAL", "SOME_PROXY", "MY_SECRET_X", "DB_PASSWORD", "SESSION_COOKIE", "SOME_API_URL"):
            with mock.patch.dict(os.environ, {name: "x"}):
                out = os.path.join(self.tmp, "refused-" + name)
                with contextlib.redirect_stdout(io.StringIO()) as buf:
                    rc = MA.main(["--topic", "demo", "--arm", "A", "--out", out])
                self.assertEqual(rc, 4, name)
                self.assertFalse(os.path.exists(out))
                self.assertNotIn("x\n", buf.getvalue().replace(name, ""))
        with mock.patch.dict(os.environ, {"CLAUDE_CODE_MESSAGING_TOKEN": "x"}):
            self.assertEqual(MA.provider_variables(os.environ), [])
        base = COMMON(self)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(MA.main(base[:7] + ["abc"] + base[8:] + ["--out", os.path.join(self.tmp, "o1")]), 4)  # commit not 40 hex
            self.assertEqual(MA.main(base[:5] + ["/nonexistent"] + base[6:] + ["--out", os.path.join(self.tmp, "o2")]), 4)
            os.makedirs(os.path.join(self.tmp, "o3"))
            self.assertEqual(MA.main(base + ["--out", os.path.join(self.tmp, "o3")]), 4)
        shell = subprocess.run(["zsh", os.path.join(HERE, "measure-arm.sh"), "demo", "A", self.fake, os.path.join(self.tmp, "o4"), "--commit", "1" * 40],
                               capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", "ANTHROPIC_API_KEY": "x"})
        self.assertEqual(shell.returncode, 4)
        self.assertIn("refused", shell.stdout)
        self.assertNotIn("=x", shell.stdout)
        for name in ("DB_PASSWORD", "SESSION_COOKIE", "SOME_API_URL"):  # the shell wrapper's list matches the python one
            shell = subprocess.run(["zsh", os.path.join(HERE, "measure-arm.sh"), "demo", "A", self.fake, os.path.join(self.tmp, "o5"), "--commit", "1" * 40],
                                   capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", name: "x"})
            self.assertEqual(shell.returncode, 4, name)
            self.assertIn("present: " + name, shell.stdout, name)  # refused by the wrapper itself, not only by the python layer

    def test_loopback_probe_on_real_sockets(self):
        import socket
        srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
        cli = socket.create_connection(srv.getsockname())
        try:
            self.assertTrue(MA.loopback_only(os.getpid()))
        finally:
            cli.close(); srv.close()

    def test_probe_fails_closed_when_lsof_cannot_run(self):
        self.assertIsNone(MA.loopback_only(os.getpid(), "/nonexistent/lsof"))
        bad = os.path.join(self.tmp, "lsof-bad")
        open(bad, "w").write("#!/bin/sh\nexit 7\n")
        os.chmod(bad, 0o755)
        self.assertIsNone(MA.loopback_only(os.getpid(), bad))
        with contextlib.redirect_stdout(io.StringIO()) as buf:  # the start itself is refused
            rc = MA.main(COMMON(self) + ["--out", os.path.join(self.tmp, "lsof-out"), "--lsof-bin", "/nonexistent/lsof", "--question-file", bad])
        self.assertEqual(rc, 4)
        self.assertIn("probe", buf.getvalue())

    def test_a_probe_that_fails_while_running_stops_the_run(self):
        out, rc = self.run_arm("A", {"requests": 1, "sleep_s": 30, "files": {"data/d.csv": "1"}}, [{"text": "x"}], probe="error")
        self.assertEqual(rc, 2)
        self.assertEqual(json.load(open(os.path.join(out, "harness.json")))["final_result"], "probe_failed")


class TestStall(Base):
    def test_stall_then_retry_keeps_folder(self):
        marker = os.path.join(self.tmp, f"marker-{time.time_ns()}")
        plan = {"requests": 3, "stall_marker": marker, "stall_after": 2, "files": {"data/d.csv": "1"}}
        out, rc = self.run_arm("A", plan, [tc("write_file"), tc("write_file"), {"text": "x"}], stall_minutes=0.05)
        self.assertEqual(rc, 0, self.stdout)
        h = json.load(open(os.path.join(out, "harness.json")))
        self.assertEqual([a["result"] for a in h["attempts"]], ["stalled", "exited"])
        self.assertTrue(os.path.isdir(os.path.join(out, "attempt-1.STALLED", "relay")))
        self.assertEqual((self.counts(out)["turns"], self.counts(out)["attempt"]), (3, 2))

    def test_stall_twice_stops(self):
        plan = {"requests": 3, "stall_marker": "always", "stall_after": 1, "files": {"data/d.csv": "1"}}
        out, rc = self.run_arm("A", plan, [tc("write_file"), {"text": "x"}], stall_minutes=0.05)
        self.assertEqual(rc, 2)
        self.assertEqual(json.load(open(os.path.join(out, "harness.json")))["final_result"], "stalled_twice")
        self.assertTrue(os.path.isdir(os.path.join(out, "attempt-1.STALLED")) and os.path.isdir(os.path.join(out, "attempt-2.STALLED")))
        self.assertIn("STOP", self.stdout)

    def test_waiting_for_the_stand_in_is_not_a_stall(self):
        plan = {"requests": 2, "files": {"data/d.csv": "1"}}
        slow = [tc("write_file"), {"text": "x"}]
        out = os.path.join(self.tmp, "slowwin")
        qf = os.path.join(self.tmp, "slowq.txt"); open(qf, "w").write(json.dumps(plan))
        stop = threading.Event()

        def late(out_root):
            while not stop.is_set():
                for view in glob.glob(os.path.join(out_root, "attempt-[0-9]", "relay", "req-*.view.md")):
                    n = int(os.path.basename(view).split("-")[1].split(".")[0])
                    path = os.path.join(os.path.dirname(view), f"reply-{n}.json")
                    if not os.path.exists(path):
                        time.sleep(5)  # longer than the 3 s stall limit
                        json.dump(slow[n - 1], open(path + ".tmp", "w")); os.rename(path + ".tmp", path)
                time.sleep(0.1)
        t = threading.Thread(target=late, args=(out,), daemon=True); t.start()
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                rc = MA.main(["--topic", "demo", "--arm", "A", "--binary", self.fake, "--commit", "1" * 40, "--out", out, "--sandbox", "none", "--frozen", self.frozen,
                              "--question-file", qf, "--stall-minutes", "0.05", "--probe", "ok", "--canary-dir", self.canary, "--child-path", "/usr/bin:/bin", "--duckdb-bin", self.duck])
        finally:
            stop.set(); t.join(5)
        self.assertEqual(rc, 0)
        self.assertEqual([a["result"] for a in json.load(open(os.path.join(out, "harness.json")))["attempts"]], ["exited"])

    def test_provider_probe_stops_and_reports(self):
        out, rc = self.run_arm("A", {"requests": 1, "sleep_s": 30, "files": {"data/d.csv": "1"}}, [{"text": "x"}], probe="fail")
        self.assertEqual(rc, 2)
        h = json.load(open(os.path.join(out, "harness.json")))
        self.assertEqual(h["final_result"], "provider_request")
        self.assertTrue(h["provider_signs"])
        self.assertEqual(json.load(open(os.path.join(out, "stops.json")))[0]["rule"], "provider_request")


if __name__ == "__main__":
    unittest.main()
