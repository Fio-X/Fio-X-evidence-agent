"""Tests for estimate.py: the formula, the sequential verdict, the per-run enumeration, and one mutant per rule (each must turn the checks red).
Run: python3 -I -W ignore scripts/measure/test_estimate.py"""
import contextlib
import datetime
import importlib.util
import io
import json
import math
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
SOURCE = os.path.join(HERE, "estimate.py")
UTC = datetime.timezone.utc


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def checks(E, case):
    """Every rule, written against a module E (the real one or a mutant); `case` is a unittest case for the assertions."""
    eq = case.assertEqual
    eq(E.CONSTANTS, (6.6, 89, 2.95, 115, 155, 135))
    # formula
    eq(E.estimated_seconds(10, 0, 0), 10)
    case.assertAlmostEqual(E.estimated_seconds(10, 5, 0), 10 + 5 * 6.6)
    case.assertAlmostEqual(E.estimated_seconds(10, 0, 2.95 * 89), 11)
    case.assertAlmostEqual(E.estimated_seconds(0, 3, 590), 3 * 6.6 + (590 / 2.95) / 89)
    for bad in (None, True, -1, math.nan, math.inf, "3"):
        eq(E.estimated_seconds(bad, 1, 1), None)
        eq(E.estimated_seconds(1, bad, 1), None)
        eq(E.estimated_seconds(1, 1, bad), None)
    eq(E.estimated_seconds(1, 1.5, 1), None)
    # sequential verdict
    table = [([100, 100, 116], "INCOMPLETE"), ([115, 115, 115], "PASS"), ([116, 100, 100, 135, 136], "FAIL"), ([116, 100, 100, 135], "INCOMPLETE"),
             ([116, 100, 100, 136], "FAIL"), ([200], "FAIL"), ([100, 100, 100, 200], "FAIL"), ([100, 100], "INCOMPLETE"), ([], "INCOMPLETE"),
             ([100, 100, 100, 116], "PASS"), ([100, 100, 100, 155], "PASS"), ([100, 100, 100, 100, 156], "FAIL"), ([100, 100, 100, None], "INCOMPLETE"),
             ([None, 100, 100], "INCOMPLETE"), ([200, None], "FAIL"), ([155, 100, 100], "FAIL"), ([100, 100, 116, 135, 135], "PASS"),
             ([135, 135, 135, 135, 135], "PASS"), ([116, 135, 135, 135, 136], "FAIL"), ([116, 100, 100, 135, None], "INCOMPLETE"),
             ([100, 100, 100, 100, 100, 100], "PASS"), ([100, 100, 100, 100, 100, 200], "FAIL"), ([100, 100, 100, 100, 100, None], "INCOMPLETE"),
             ([100] * 19 + [156], "FAIL"), ([116, 100, 100, 100, 100, 100, 100, 100], "PASS"), ([116, 100, 100, 100, 100, 100, 100, 136], "FAIL"),
             ([116, 100, 100, 100, 135], "PASS"), ([100, 100, 100, 100, 100, 100, 100, None], "INCOMPLETE")]
    for values, want in table:
        eq(E.sequential_verdict(values), want, values)
    eq(E.sequential_verdict([115, 115, 115, 155]), "PASS")  # exactly 115 and exactly 155 are not over
    eq(E.sequential_verdict([155]), "INCOMPLETE")  # 155 itself does not trip rule 1
    eq(E.sequential_verdict([None, None, None]), "INCOMPLETE")
    # self-report
    eq(E.selfreport_check(100, None), "INCOMPLETE")
    eq(E.selfreport_check(None, 100), "INCOMPLETE")
    eq(E.selfreport_check(110, 100), "OK")
    eq(E.selfreport_check(111, 100), "RED")
    eq(E.selfreport_check(89, 100), "RED")
    eq(E.selfreport_check(90, 100), "OK")
    eq(E.selfreport_check(100, 0), "INCOMPLETE")
    eq(E.selfreport_check(100, True), "INCOMPLETE")
    # max reply
    eq(E.max_reply_check(100, 100), "PASS")
    eq(E.max_reply_check(99, 100), "PASS")
    eq(E.max_reply_check(101, 100), "FAIL")
    eq(E.max_reply_check(None, 100), "INCOMPLETE")
    eq(E.max_reply_check(100, None), "INCOMPLETE")
    eq(E.max_reply_check(0, 0), "PASS")
    eq(E.max_reply_check(True, 100), "INCOMPLETE")
    # report: ordering, extra, missing start time, ties
    t = lambda m: datetime.datetime(2026, 10, 19, 10, m, tzinfo=UTC)
    run = lambda i, m, e: {"id": i, "started_at": None if m is None else t(m), "estimated_seconds": e}
    r = E.build_report([run("c", 3, 100), run("a", 1, 100), run("b", 2, 100)])
    eq([x["id"] for x in r["runs"]], ["a", "b", "c"])  # by start time, not by name
    eq((r["verdict"], r["runs_total"], r["order_problem"]), ("PASS", 3, None))
    r = E.build_report([run("z", 1, 100), run("y", 2, 100), run("x", 3, 100)])
    eq([x["id"] for x in r["runs"]], ["z", "y", "x"])
    r = E.build_report([run(str(i), i, 100) for i in range(8)])
    eq((r["runs_total"], [x["extra"] for x in r["runs"]]), (8, [False] * 5 + [True] * 3))
    r = E.build_report([run("a", 1, 100), run("b", 2, 100), run("c", 3, 100), run("d", 4, 100), run("e", 5, 100), run("f", 6, None)])
    eq(r["verdict"], "INCOMPLETE")  # an extra run without measures is not skipped
    r = E.build_report([run("a", 1, 100), run("b", 2, 100), run("c", 3, 100), run("d", 4, 100), run("e", 5, 100), run("f", 6, 156)])
    eq(r["verdict"], "FAIL")
    r = E.build_report([run("a", 1, 100), run("b", None, 100), run("c", 3, 100)])
    eq((r["verdict"], bool(r["order_problem"])), ("INCOMPLETE", True))
    r = E.build_report([run("a", 1, 100), run("b", 1, 100), run("c", 3, 100)])
    eq((r["verdict"], bool(r["order_problem"])), ("INCOMPLETE", True))
    r = E.build_report([run("a", 1, 100), run("b", 2, 100), run("c", 3, 100)])
    eq(tuple(r), E.FIELDS)
    eq(E.FIELDS, ("advisory", "constants", "runs_total", "runs", "order_problem", "verdict", "self_report"))
    case.assertIn("not recalibrated", r["advisory"])
    eq(tuple(r["runs"][0]), ("id", "started_at", "estimated_seconds", "extra"))


def make_run(root, name, counts=None, stamps=None, events=True):
    folder = os.path.join(root, name)
    os.makedirs(folder)
    if counts is not None:
        with open(os.path.join(folder, "counts.json"), "w") as h:
            json.dump(counts, h)
    if stamps is not None:
        run = os.path.join(folder, "T", "out", "r1")
        os.makedirs(run)
        with open(os.path.join(run, "events.jsonl"), "w") as h:
            for s in stamps:
                h.write(json.dumps({"type": "x", "_newsroom_recorded_at": s} if s else {"type": "x"}) + "\n")


class TestEstimate(unittest.TestCase):
    def test_rules(self):
        checks(load(SOURCE, "estimate_real"), self)

    def test_enumeration_takes_every_folder_and_reads_the_product_stamp(self):
        E = load(SOURCE, "estimate_enum")
        tmp = tempfile.mkdtemp(prefix="est")
        self.addCleanup(shutil.rmtree, tmp, True)
        good = {"program_s": 10, "round_trips": 5, "model_written_bytes": 0}
        make_run(tmp, "r1", good, ["2026-10-19T10:00:00.000Z"])
        make_run(tmp, "r2", good, ["2026-10-19T09:00:00.000Z", "2026-10-19T11:00:00Z"])
        make_run(tmp, "r3", {"program_s": None, "round_trips": 5, "model_written_bytes": 0}, ["2026-10-19T12:00:00Z"])
        make_run(tmp, "r4", None, None)  # no counts.json and no events: still a run
        make_run(tmp, ".hidden", good, ["2026-10-19T08:00:00Z"])
        with open(os.path.join(tmp, "stray.txt"), "w") as h:
            h.write("x")
        runs = E.enumerate_runs(tmp)
        self.assertEqual([r["id"] for r in runs], ["r1", "r2", "r3", "r4"])
        self.assertAlmostEqual(runs[0]["estimated_seconds"], 10 + 5 * 6.6)
        self.assertEqual(runs[1]["started_at"], datetime.datetime(2026, 10, 19, 9, tzinfo=UTC))  # the first stamp in file order
        self.assertIsNone(runs[2]["estimated_seconds"])  # program_s None: INCOMPLETE, not 0
        self.assertEqual((runs[3]["estimated_seconds"], runs[3]["started_at"]), (None, None))
        self.assertEqual(E.build_report(runs)["verdict"], "INCOMPLETE")
        self.assertEqual(E.build_report(runs)["runs_total"], 4)

    def test_a_counts_file_from_before_round_trips_existed_has_no_estimate(self):
        E = load(SOURCE, "estimate_old")
        tmp = tempfile.mkdtemp(prefix="est")
        self.addCleanup(shutil.rmtree, tmp, True)
        make_run(tmp, "old", {"program_s": 10, "turns": 5, "model_written_bytes": 0}, ["2026-10-19T10:00:00Z"])
        self.assertIsNone(E.enumerate_runs(tmp)[0]["estimated_seconds"])

    def test_main_prints_everything_and_always_exits_zero(self):
        E = load(SOURCE, "estimate_main")
        tmp = tempfile.mkdtemp(prefix="est")
        self.addCleanup(shutil.rmtree, tmp, True)
        for i in range(7):
            make_run(tmp, f"r{i}", {"program_s": 400, "round_trips": 5, "model_written_bytes": 0}, [f"2026-10-19T10:0{i}:00Z"])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = E.main([tmp])
        text = out.getvalue()
        self.assertEqual(code, 0)  # FAIL is printed, never an exit code
        self.assertIn("runs: 7", text)
        self.assertEqual(text.count("| extra"), 2)
        self.assertIn("advisory only", text)
        self.assertIn("sequential verdict (advisory): FAIL", text)
        self.assertEqual(json.loads(text.strip().splitlines()[-1])["runs_total"], 7)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(E.main([]), 2)
            self.assertEqual(E.main([os.path.join(tmp, "nope")]), 2)

    def test_build_counts_fields(self):
        import measure_lib as L
        tmp = tempfile.mkdtemp(prefix="est")
        self.addCleanup(shutil.rmtree, tmp, True)
        relay = os.path.join(tmp, "relay")
        os.makedirs(relay)
        for n, reply in ((1, {"text": "a"}), (2, {"text": "a longer reply than the first one"}), (3, {"text": "b"})):
            for kind, body in (("req", {"messages": []}), ("reply", reply)):
                with open(os.path.join(relay, f"{kind}-{n}.json"), "w") as h:
                    json.dump(body, h)
        c = L.relay_counts(relay)
        sizes = [len(json.dumps({"text": t}, ensure_ascii=False)) for t in ("a", "a longer reply than the first one", "b")]
        self.assertEqual((c["round_trips"], c["round_trips"] == c["turns"], c["max_reply_bytes"]), (3, True, max(sizes)))
        self.assertLess(c["max_reply_bytes"], c["model_written_bytes"])  # the largest, not the sum
        os.remove(os.path.join(relay, "reply-2.json"))
        self.assertIsNone(L.relay_counts(relay)["max_reply_bytes"])  # a missing reply: None, not a number
        for n in (1, 3):
            os.remove(os.path.join(relay, f"reply-{n}.json"))
        self.assertIsNone(L.relay_counts(relay)["max_reply_bytes"])  # no reply file at all: None, not 0
        empty = os.path.join(tmp, "empty")
        os.makedirs(empty)
        self.assertEqual((L.relay_counts(empty)["round_trips"], L.relay_counts(empty)["max_reply_bytes"]), (0, None))

    def test_the_audit_expectation_file_is_not_touched_by_this_change(self):
        # build_counts only gains keys; the audit text is made from run folders, so the fixture bytes must not move
        root = os.path.dirname(os.path.dirname(HERE))
        fixture = os.path.join(HERE, "fixtures", "audit_expected.txt")
        if not os.path.isfile(fixture):
            self.skipTest("no audit_expected.txt fixture in this tree")
        import subprocess
        out = subprocess.run(["git", "-C", root, "diff", "--quiet", "--", fixture])
        self.assertEqual(out.returncode, 0, "audit_expected.txt differs from the committed copy")


MUTANTS = [
    ("trip constant", "TRIP_S, TOKENS_PER_S, BYTES_PER_TOKEN, PASS_FIRST3, FAIL_ABOVE, PASS_ALL5 = 6.6,", "TRIP_S, TOKENS_PER_S, BYTES_PER_TOKEN, PASS_FIRST3, FAIL_ABOVE, PASS_ALL5 = 6.5,"),
    ("tokens per second", "= 6.6, 89,", "= 6.6, 90,"),
    ("bytes per token", "89, 2.95,", "89, 3.0,"),
    ("first-3 limit", "2.95, 115,", "2.95, 116,"),
    ("fail limit", "115, 155,", "115, 156,"),
    ("five-run limit", "155, 135\n", "155, 136\n"),
    ("fail check uses >=", "any(v > FAIL_ABOVE for v in known)", "any(v >= FAIL_ABOVE for v in known)"),
    ("first-3 check uses <", "all(v <= PASS_FIRST3 for v in values[:3])", "all(v < PASS_FIRST3 for v in values[:3])"),
    ("five-run check uses >=", "any(v > PASS_ALL5 for v in values)", "any(v >= PASS_ALL5 for v in values)"),
    ("fail rule moved after the None rule", '    known = [v for v in values if _number(v)]\n    if any(v > FAIL_ABOVE for v in known):\n        return "FAIL"\n    if len(known) != len(values) or len(values) < 3:\n        return "INCOMPLETE"',
     '    known = [v for v in values if _number(v)]\n    if len(known) != len(values) or len(values) < 3:\n        return "INCOMPLETE"\n    if any(v > FAIL_ABOVE for v in known):\n        return "FAIL"'),
    ("None ignored", "if len(known) != len(values) or len(values) < 3:", "if len(known) < 3:"),
    ("fewer than 3 passes", "or len(values) < 3:", "or len(values) < 1:"),
    ("only the first five runs are looked at", "def sequential_verdict(values):\n", "def sequential_verdict(values):\n    values = values[:5]\n"),
    ("extra runs with no measures are dropped", "    verdict = \"INCOMPLETE\" if problem else sequential_verdict([r[\"estimated_seconds\"] for r in ordered])",
     "    verdict = \"INCOMPLETE\" if problem else sequential_verdict([r[\"estimated_seconds\"] for r in ordered if r[\"estimated_seconds\"] is not None or not r[\"extra\"]])"),
    ("none counted as zero", "known = [v for v in values if _number(v)]", "values = [0 if v is None else v for v in values]\n    known = [v for v in values if _number(v)]"),
    ("five all-below rule looks at the last two only", "any(v > PASS_ALL5 for v in values)", "any(v > PASS_ALL5 for v in values[-2:])"),
    ("fewer than five all-below passes", 'return "PASS" if len(values) >= 5 else "INCOMPLETE"', 'return "PASS"'),
    ("short list with a value over 135 stays incomplete", "    if any(v > PASS_ALL5 for v in values):\n        return \"FAIL\"\n", "    if len(values) >= 5 and any(v > PASS_ALL5 for v in values):\n        return \"FAIL\"\n"),
    ("program_s missing counts as 0", "if not (_number(program_s) and _number(round_trips)", "program_s = 0 if program_s is None else program_s\n    if not (_number(program_s) and _number(round_trips)"),
    ("round trips plus one", "round_trips * TRIP_S + (output_bytes", "(round_trips + 1) * TRIP_S + (output_bytes"),
    ("round trips not whole accepted", " or round_trips != int(round_trips)", ""),
    ("bool accepted as a number", "return not isinstance(x, bool) and isinstance(x, (int, float))", "return isinstance(x, (int, float))"),
    ("negative accepted", "math.isfinite(x) and x >= 0", "math.isfinite(x)"),
    ("self-report tolerance 20%", "SELF_REPORT_TOLERANCE = 0.10", "SELF_REPORT_TOLERANCE = 0.20"),
    ("self-report >= instead of >", "/ selfreported_s > SELF_REPORT_TOLERANCE", "/ selfreported_s >= SELF_REPORT_TOLERANCE"),
    ("missing self-report passes", 'if not (_number(program_s) and _number(selfreported_s)) or selfreported_s == 0:\n        return "INCOMPLETE"', 'if not _number(program_s) or selfreported_s == 0:\n        return "INCOMPLETE"\n    if selfreported_s is None:\n        return "OK"'),
    ("max reply < instead of <=", 'return "PASS" if tested <= reference else "FAIL"', 'return "PASS" if tested < reference else "FAIL"'),
    ("max reply missing passes", "if not (_number(tested) and _number(reference)):\n        return \"INCOMPLETE\"", "if tested is None or reference is None:\n        return \"PASS\"\n    if not (_number(tested) and _number(reference)):\n        return \"INCOMPLETE\""),
    ("missing start time sorted as zero", '    if any(r["started_at"] is None for r in runs):', '    runs = [dict(r, started_at=r["started_at"] or datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)) for r in runs]\n    if any(r["started_at"] is None for r in runs):'),
    ("tied start times sorted by name", '    elif len({r["started_at"] for r in runs}) != len(runs):', '    elif False:'),
    ("order by folder name", 'sorted(runs, key=lambda r: r["started_at"])', 'sorted(runs, key=lambda r: r["id"])'),
    ("extra marker moved", '"extra": i >= 5', '"extra": i >= 6'),
    ("no extra marker", '"extra": i >= 5', '"extra": False'),
    ("a folder without counts is skipped", '        counts = counts if isinstance(counts, dict) else {}\n', '        if not isinstance(counts, dict):\n            continue\n'),
    ("hidden folders counted", 'if name.startswith(".") or not os.path.isdir(folder):', 'if not os.path.isdir(folder):'),
    ("old turns used for round trips", 'counts.get("round_trips")', 'counts.get("round_trips", counts.get("turns"))'),
    ("last stamp instead of first", '                return _parse_stamp(stamp)\n    return None', '                last = stamp\n    return _parse_stamp(last) if "last" in dir() else None'),
    ("verdict becomes an exit code", "    return 0\n\n\nif __name__", '    return 0 if report["verdict"] != "FAIL" else 1\n\n\nif __name__'),
    ("a field is renamed", '"runs_total", "runs"', '"runs_count", "runs"'),
    ("advisory wording dropped", "constants not recalibrated", "constants fine"),
]


class TestMutants(unittest.TestCase):
    def test_every_mutant_turns_a_check_red(self):
        with open(SOURCE, encoding="utf-8") as handle:
            source = handle.read()
        tmp = tempfile.mkdtemp(prefix="estmut")
        self.addCleanup(shutil.rmtree, tmp, True)
        survived = []
        for i, (name, old, new) in enumerate(MUTANTS):
            self.assertEqual(source.count(old), 1, f"mutant {name!r}: the text to change must occur exactly once")
            path = os.path.join(tmp, f"estimate_mut{i}.py")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(source.replace(old, new))
            red = False
            try:
                mod = load(path, f"estimate_mut{i}")
                case = unittest.TestCase()
                checks(mod, case)
                with contextlib.redirect_stdout(io.StringIO()):
                    tmpd = tempfile.mkdtemp(prefix="estm")
                    try:
                        for n in range(7):
                            make_run(tmpd, f"r{n}", {"program_s": 400, "round_trips": 5, "model_written_bytes": 0}, [f"2026-10-19T10:0{n}:00Z"])
                        if mod.main([tmpd]) != 0:
                            red = True
                        make_run(tmpd, "hidden_missing", None, None)
                        make_run(tmpd, ".dot", {"program_s": 1, "round_trips": 1, "model_written_bytes": 0}, ["2026-10-19T09:00:00Z"])
                        ids = [r["id"] for r in mod.enumerate_runs(tmpd)]
                        if ".dot" in ids or "hidden_missing" not in ids:
                            red = True
                        old_dir = tempfile.mkdtemp(prefix="estold")
                        try:
                            make_run(old_dir, "old", {"program_s": 10, "turns": 5, "model_written_bytes": 0}, ["2026-10-19T10:00:00Z"])
                            if mod.enumerate_runs(old_dir)[0]["estimated_seconds"] is not None:
                                red = True
                            make_run(old_dir, "two", {"program_s": 1, "round_trips": 1, "model_written_bytes": 0}, ["2026-10-19T10:00:00Z", "2026-10-19T11:00:00Z"])
                            make_run(old_dir, "three", {"program_s": 1, "round_trips": 1, "model_written_bytes": 0}, ["2026-10-19T08:00:00Z", "2026-10-19T12:00:00Z"])
                            by_id = {r["id"]: r for r in mod.enumerate_runs(old_dir)}
                            if by_id["three"]["started_at"] != datetime.datetime(2026, 10, 19, 8, tzinfo=UTC):
                                red = True
                        finally:
                            shutil.rmtree(old_dir, True)
                    finally:
                        shutil.rmtree(tmpd, True)
            except Exception:  # noqa: BLE001 -- any failure of a check (assertion or crash) counts as red
                red = True
            if not red:
                survived.append(name)
        self.assertEqual(survived, [], "mutants that did not turn anything red")
        self.assertGreaterEqual(len(MUTANTS), 38)


if __name__ == "__main__":
    unittest.main()
