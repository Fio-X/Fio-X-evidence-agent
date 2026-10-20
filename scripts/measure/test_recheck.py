"""Self-test of recheck_computations.py. Fake `news` and `duckdb` scripts test the parsing and the stop rules on synthetic run folders;
two more cases run the real product and a real DuckDB on a known-good archive and are skipped unless all three are given:
RECHECK_NEWS=<news binary> RECHECK_DUCKDB=<duckdb binary> RECHECK_ARCHIVE=<archive folder> python3 -I -W ignore test_recheck.py
Without them the output ends with a SKIPPED line: the real recompute path is then not covered (CI does not run it)."""
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
import contextlib
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import recheck_computations as R  # noqa: E402

ARCH = os.environ.get("RECHECK_ARCHIVE", "")
NEWS = os.environ.get("RECHECK_NEWS", "")
REAL_DUCK = os.environ.get("RECHECK_DUCKDB", "")
REAL = bool(NEWS and REAL_DUCK and ARCH and os.path.isfile(NEWS) and os.path.isfile(REAL_DUCK) and os.path.isdir(os.path.join(ARCH, "computations")))
SKIP_REAL = "real recompute cases need RECHECK_NEWS, RECHECK_DUCKDB and RECHECK_ARCHIVE"
_TOOLS = tempfile.mkdtemp(prefix="recheck-tools-")
DUCK = os.path.join(_TOOLS, "duckdb")  # a stand-in that only answers `-version`; the real one is REAL_DUCK
with open(DUCK, "w") as _f:
    _f.write("#!/bin/sh\necho v1.0.0 stand-in\n")
os.chmod(DUCK, 0o755)


def fake_news(d, text):
    p = os.path.join(d, "news")
    open(p, "w").write("#!/bin/sh\ncat <<'EOT'\n" + text + "\nEOT\n")
    os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
    return p


def synthetic_run(d, n=3):
    run = os.path.join(d, "run")
    os.makedirs(os.path.join(run, "computations"))
    for i in range(n):
        json.dump({"sql": f"select {i}", "input_snapshot_hash": "h", "input_binding": "b", "result_hash": f"r{i}", "rows": []},
                  open(os.path.join(run, "computations", f"{i:02d}{'a' * 62}.json"), "w"))
    return run


class T(unittest.TestCase):
    def classify_with(self, text):
        with tempfile.TemporaryDirectory() as d:
            run = synthetic_run(d)
            tmp = os.path.join(d, "t"); os.makedirs(tmp)
            return R.classify(run, fake_news(d, text), DUCK, tmp), sorted(os.listdir(os.path.join(run, "computations")))

    def test_all_same(self):
        (st, note), _ = self.classify_with("artifact integrity: PASS\nSQL recompute: PASS\nrecompute checks: 9")
        self.assertEqual((set(st.values()), note), ({"same"}, ""))

    def test_different_and_could_not_run(self):
        with tempfile.TemporaryDirectory() as d:
            run = synthetic_run(d)
            names = sorted(os.listdir(os.path.join(run, "computations")))
            text = ("artifact integrity: PASS\nSQL recompute: FAIL\n"
                    f"FAIL  recompute rows mismatch: /x/computations/{names[0]}\n"
                    f"FAIL  recompute result_hash mismatch: /x/computations/{names[0]}\n"
                    f"FAIL  DuckDB recompute failed for /x/computations/{names[1]}: boom")
            tmp = os.path.join(d, "t"); os.makedirs(tmp)
            st, _ = R.classify(run, fake_news(d, text), DUCK, tmp)
            self.assertEqual([st[n] for n in names], ["different", "could-not-run", "same"])

    def test_integrity_fail_or_no_recompute_means_could_not_run(self):
        for text in ("artifact integrity: FAIL\nFAIL  something", "artifact integrity: PASS"):
            (st, note), _ = self.classify_with(text)
            self.assertEqual(set(st.values()), {"could-not-run"})
            self.assertTrue(note)

    def test_failure_naming_no_file_never_leaves_same(self):
        (st, note), _ = self.classify_with("artifact integrity: PASS\nSQL recompute: FAIL\nFAIL  recompute requires at least one stored computation")
        self.assertEqual(set(st.values()), {"could-not-run"})

    def test_pairing_and_no_text_printed(self):
        with tempfile.TemporaryDirectory() as d:
            a = synthetic_run(os.path.join(d, "a") if os.makedirs(os.path.join(d, "a")) is None else d, 3)
            b_root = os.path.join(d, "b"); os.makedirs(b_root)
            b = synthetic_run(b_root, 3)
            c = json.load(open(os.path.join(b, "computations", sorted(os.listdir(os.path.join(b, "computations")))[0])))
            # b file 0: same key, other result hash -> paired-different; b file 1 other SQL -> unpaired
            p0 = os.path.join(b, "computations", sorted(os.listdir(os.path.join(b, "computations")))[0])
            c["result_hash"] = "other"; json.dump(c, open(p0, "w"))
            p1 = os.path.join(b, "computations", sorted(os.listdir(os.path.join(b, "computations")))[1])
            c1 = json.load(open(p1)); c1["sql"] = "select 99"; json.dump(c1, open(p1, "w"))
            pr = R.pairing(a, b)
            self.assertEqual({k: pr[k] for k in ("paired_same", "paired_different", "unpaired_a", "unpaired_b")}, {"paired_same": 1, "paired_different": 1, "unpaired_a": 1, "unpaired_b": 1})
            buf = io.StringIO()
            with redirect_stdout(buf):
                R.report("A", {"x.json": "same"})
            self.assertNotIn("select", buf.getvalue())

    def test_bad_input(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(R.main(["--run", "/nonexistent", "--news-bin", "/x", "--duckdb-bin", DUCK, "--tmp", "/tmp", "--canary-dir", "/x"]), 4)

    def test_canary_dir_is_required_and_has_no_default(self):
        with tempfile.TemporaryDirectory() as d:
            err = io.StringIO()
            with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as cm:
                R.main(["--run", d, "--news-bin", "/x", "--duckdb-bin", DUCK, "--tmp", d])
            self.assertEqual(cm.exception.code, 2)
            self.assertIn("--canary-dir", err.getvalue())
        self.assertFalse(hasattr(R, "CANARY_DIR"))

    @unittest.skipUnless(REAL, SKIP_REAL)
    def test_real_product_on_a_known_good_archive_all_same(self):
        with tempfile.TemporaryDirectory() as d:
            ok, per_file, note = R.canary(NEWS, REAL_DUCK, d, ARCH)
            self.assertEqual((ok, note), (True, ""))
            st, note = R.classify(ARCH, NEWS, REAL_DUCK, d, per_file=per_file)
            self.assertEqual((set(st.values()), note), ({"same"}, ""))
            self.assertEqual(len(st), len(os.listdir(os.path.join(ARCH, "computations"))))

    @unittest.skipUnless(REAL, SKIP_REAL)
    def test_real_product_tampered_rows_are_not_called_same(self):
        with tempfile.TemporaryDirectory() as d:
            run = os.path.join(d, "r"); shutil.copytree(ARCH, run, symlinks=True)
            p = os.path.join(run, "computations", sorted(os.listdir(os.path.join(run, "computations")))[0])
            c = json.load(open(p)); c["rows"] = c["rows"] + [c["rows"][0]]; json.dump(c, open(p, "w"))
            tmp = os.path.join(d, "t"); os.makedirs(tmp)
            st, _ = R.classify(run, NEWS, REAL_DUCK, tmp, per_file=3)
            self.assertNotIn("same", set(st.values()))

    def tamper_aware_news(self, d):
        """A stand-in product: PASS unless a stored computation contains the word TAMPERED, then a rows mismatch for that file."""
        p = os.path.join(d, "tnews")
        open(p, "w").write('#!/bin/sh\nn=$(ls "$2/computations" | wc -l | tr -d " ")\necho "artifact integrity: PASS"\n'
                           'bad=$(grep -l TAMPERED "$2"/computations/*.json)\n'
                           'if [ -z "$bad" ]; then echo "SQL recompute: PASS"; else echo "SQL recompute: FAIL"; for f in $bad; do echo "FAIL  recompute rows mismatch: $f"; done; fi\n'
                           'echo "recompute checks: $((1 + 2 * n))"\n')
        os.chmod(p, 0o755)
        return p

    def test_synthetic_untouched_run_is_same_and_tampered_run_is_not(self):
        with tempfile.TemporaryDirectory() as d:
            run = synthetic_run(d); tmp = os.path.join(d, "t"); os.makedirs(tmp)
            news = self.tamper_aware_news(d)
            st, note = R.classify(run, news, DUCK, tmp, per_file=2)                     # positive control: nothing changed
            self.assertEqual((set(st.values()), note), ({"same"}, ""))
            p = os.path.join(run, "computations", sorted(os.listdir(os.path.join(run, "computations")))[0])
            c = json.load(open(p)); c["rows"] = [{"v": "TAMPERED"}]; json.dump(c, open(p, "w"))
            st, _ = R.classify(run, news, DUCK, tmp, per_file=2)
            self.assertEqual(sorted(st.values()), ["different", "same", "same"])
            self.assertNotIn("same", [st[sorted(st)[0]]])

    # ---- one test per fix -------------------------------------------------------------------------------------------
    def counting_news(self, d, verdict="PASS", extra=""):
        p = os.path.join(d, "cnews-" + verdict + str(abs(hash(extra)) % 10 ** 6))
        open(p, "w").write('#!/bin/sh\nn=$(ls "$2/computations" | wc -l | tr -d " ")\necho "artifact integrity: PASS"\necho "SQL recompute: ' + verdict
                           + '"\necho "recompute checks: $((1 + 2 * n))"\ncat <<\'EOT\'\n' + extra + '\nEOT\n')
        os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
        return p

    def canary_dir(self, d):
        c = os.path.join(d, "canary"); os.makedirs(os.path.join(c, "computations"))
        json.dump({"sql": "select 1", "rows": [], "result_hash": "x"}, open(os.path.join(c, "computations", "k.json"), "w"))
        return c

    def test_fix1_preflight_canary_and_env_problem_exit_code(self):
        ok, version, note = R.preflight(DUCK)
        self.assertTrue(ok, note)
        self.assertTrue(version.startswith("v"))
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(R.preflight(os.path.join(d, "none"))[0])          # not a file
            bad = os.path.join(d, "duck"); open(bad, "w").write("#!/bin/sh\nexit 3\n"); os.chmod(bad, 0o755)
            self.assertFalse(R.preflight(bad)[0])                              # -version exits non-zero
            run = synthetic_run(d); tmp = os.path.join(d, "t"); os.makedirs(tmp)
            news, canary = self.counting_news(d), self.canary_dir(d)
            base = ["--run", run, "--news-bin", news, "--tmp", tmp, "--canary-dir", canary]
            buf = io.StringIO()
            with redirect_stdout(buf):
                self.assertEqual(R.main(base + ["--duckdb-bin", os.path.join(d, "none")]), R.ENV_PROBLEM_EXIT)
            self.assertIn("ENV-PROBLEM", buf.getvalue())
            self.assertEqual(R.ENV_PROBLEM_EXIT, 5)
            buf = io.StringIO()                                                # canary fails (the product says FAIL for the known-good archive)
            with redirect_stdout(buf):
                self.assertEqual(R.main(["--run", run, "--news-bin", self.counting_news(d, "FAIL"), "--tmp", tmp, "--canary-dir", canary, "--duckdb-bin", DUCK]), 5)
            self.assertIn("ENV-PROBLEM canary", buf.getvalue())
            buf = io.StringIO()                                                # canary archive missing
            with redirect_stdout(buf):
                self.assertEqual(R.main(["--run", run, "--news-bin", news, "--tmp", tmp, "--canary-dir", os.path.join(d, "gone"), "--duckdb-bin", DUCK]), 5)
            buf = io.StringIO()                                                # all good: exit 0
            with redirect_stdout(buf):
                self.assertEqual(R.main(base + ["--duckdb-bin", DUCK]), 0)

    def test_fix1_reasons_and_env_problem_is_never_a_bad_file(self):
        with tempfile.TemporaryDirectory() as d:
            run = synthetic_run(d); names = sorted(os.listdir(os.path.join(run, "computations")))
            tmp = os.path.join(d, "t"); os.makedirs(tmp); canary = self.canary_dir(d)
            every = "\n".join(f"FAIL  failed to execute DuckDB for /x/computations/{n}: boom" for n in names)
            rec = R.recheck_run(run, self.counting_news(d, "FAIL", every), DUCK, tmp, canary)
            self.assertTrue(rec["env_problem"] and rec["note"].startswith("ENV-PROBLEM canary"), rec["note"])  # the canary uses the same news: also FAIL-less path
            # a news that is fine on the canary but fails to execute on every file of the run
            p = os.path.join(d, "mixed")
            open(p, "w").write('#!/bin/sh\necho "artifact integrity: PASS"\nif ls "$2/computations" | grep -q "^k.json"; then echo "SQL recompute: PASS"; echo "recompute checks: 3"; else echo "SQL recompute: FAIL"; echo "recompute checks: 1"\ncat <<\'EOT\'\n' + every + '\nEOT\nfi\n')
            os.chmod(p, 0o755)
            canary_copy = canary
            rec = R.recheck_run(run, p, DUCK, tmp, canary_copy)
            self.assertEqual(rec["reasons"], {"failed-to-execute": 3})
            self.assertTrue(rec["env_problem"])
            # a real "different" file beside the failures: a bad file, not the environment
            diff = f"FAIL  recompute rows mismatch: /x/computations/{names[0]}\nFAIL  DuckDB recompute failed for /x/computations/{names[1]}: syntax\nFAIL  failed to execute DuckDB for /x/computations/{names[2]}: boom"
            open(p, "w").write('#!/bin/sh\necho "artifact integrity: PASS"\nif ls "$2/computations" | grep -q "^k.json"; then echo "SQL recompute: PASS"; echo "recompute checks: 3"; else echo "SQL recompute: FAIL"; echo "recompute checks: 1"\ncat <<\'EOT\'\n' + diff + '\nEOT\nfi\n')
            rec = R.recheck_run(run, p, DUCK, tmp, canary_copy)
            self.assertFalse(rec["env_problem"])
            self.assertEqual((rec["counts"]["different"], rec["counts"]["could-not-run"], rec["reasons"]), (1, 2, {"duckdb-error": 1, "failed-to-execute": 1}))

    def test_fix2_rows_hash_is_part_of_the_pairing(self):
        with tempfile.TemporaryDirectory() as d:
            ra, rb = os.path.join(d, "a"), os.path.join(d, "b")
            for r, rows in ((ra, [{"x": 1}]), (rb, [{"x": 2}])):
                os.makedirs(os.path.join(r, "computations"))
                json.dump({"sql": "select 1", "input_snapshot_hash": "h", "input_binding": "b", "result_hash": "same-hash", "rows": rows}, open(os.path.join(r, "computations", "c.json"), "w"))
            pr = R.pairing(ra, rb)
            self.assertEqual((pr["paired_same"], pr["paired_different"]), (0, 1))   # same result_hash, other stored rows: different
            self.assertNotIn("x", json.dumps(R.rows_hash({"rows": [{"x": 1}]})))   # a hash, never the rows
            self.assertEqual(len(R.rows_hash({"rows": [1]})), 64)

    def test_fix3_same_needs_positive_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            run = synthetic_run(d); tmp = os.path.join(d, "t"); os.makedirs(tmp)
            good = "artifact integrity: PASS\nSQL recompute: PASS\nrecompute checks: 7"           # 1 + 2 x 3 files
            st, note = R.classify(run, fake_news(d, good), DUCK, tmp, per_file=2)
            self.assertEqual((set(st.values()), note), ({"same"}, ""))
            st, note = R.classify(run, fake_news(d, good.replace("7", "6")), DUCK, tmp, per_file=2)  # PASS but a wrong count
            self.assertEqual(set(st.values()), {"could-not-run"}); self.assertIn("check count", note)
            st, note = R.classify(run, fake_news(d, "artifact integrity: PASS\nSQL recompute: FAIL\nrecompute checks: 7"), DUCK, tmp, per_file=2)  # FAIL, no file marked
            self.assertEqual(set(st.values()), {"could-not-run"}); self.assertIn("no file was marked", note)

    def test_fix4_sorted_keys_file_counts_and_none(self):
        base = {"sql": "s", "input_snapshot_hash": "h"}
        self.assertEqual(R.pair_key({**base, "input_binding": {"a": 1, "b": 2}}), R.pair_key({**base, "input_binding": {"b": 2, "a": 1}}))
        self.assertNotEqual(R.pair_key({**base, "input_binding": {"a": 1}}), R.pair_key({**base, "input_binding": {"a": 2}}))
        self.assertEqual(R.pair_key(base), R.pair_key({**base, "input_binding": "None"}))   # a missing field is the text "None"
        with tempfile.TemporaryDirectory() as d:
            ra, rb = os.path.join(d, "a"), os.path.join(d, "b")
            for r, names in ((ra, ("c1", "c2")), (rb, ("c1",))):                        # two files, one key, on side A
                os.makedirs(os.path.join(r, "computations"))
                for n in names:
                    json.dump({"sql": "s", "input_snapshot_hash": "h", "input_binding": "b", "result_hash": "r", "rows": []}, open(os.path.join(r, "computations", n + ".json"), "w"))
            pr = R.pairing(ra, rb)
            self.assertEqual((pr["files_a"], pr["keys_a"], pr["files_b"], pr["keys_b"], pr["unit"]), (2, 1, 1, 1, "keys"))
        self.assertIn("None", R.__doc__)
        self.assertIn("KEYS", R.__doc__)

    def test_fix5_prints_the_duckdb_version(self):
        with tempfile.TemporaryDirectory() as d:
            run = synthetic_run(d); tmp = os.path.join(d, "t"); os.makedirs(tmp)
            buf = io.StringIO()
            with redirect_stdout(buf):
                R.main(["--run", run, "--news-bin", self.counting_news(d), "--tmp", tmp, "--canary-dir", self.canary_dir(d), "--duckdb-bin", DUCK])
            self.assertRegex(buf.getvalue(), r"DuckDB version: v\d")
            rec = R.recheck_run(run, self.counting_news(d), DUCK, tmp, self.canary_dir(d) if False else os.path.join(d, "canary"))
            self.assertRegex(rec["duckdb_version"], r"^v\d")


if __name__ == "__main__":
    res = unittest.main(verbosity=1, exit=False).result
    skipped = sum(1 for t, why in res.skipped if why == SKIP_REAL)
    if skipped:
        print(f"SKIPPED: {skipped} recompute cases (no real news/DuckDB/archive given)")
    shutil.rmtree(_TOOLS, ignore_errors=True)
    sys.exit(0 if res.wasSuccessful() else 1)
