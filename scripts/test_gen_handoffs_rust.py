#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "gen_handoffs_rust.py")
GROUPS = os.path.join(HERE, "..", "runtime", "pi", "groups.json")


def line(writer, group, command, decision, path="data/a.csv"):
    return {"side": "rust-command", "writer": writer, "group": group, "command": command,
            "requested_by": command, "path": path, "decision": decision}


def write_run(base, name, records):
    run = os.path.join(base, name, "runtime")
    os.makedirs(run)
    with open(os.path.join(run, "handoff-observed.jsonl"), "w") as handle:
        for rec in records:
            handle.write(json.dumps(rec) + "\n")
    return os.path.join(base, name)


class GenHandoffs(unittest.TestCase):
    def run_script(self, base, args):
        out = os.path.join(base, "proposal.json")
        proc = subprocess.run([sys.executable, SCRIPT, *args, "--out", out], capture_output=True, text=True)
        return proc, out

    def test_union_over_runs(self):
        with tempfile.TemporaryDirectory() as base:
            a = write_run(base, "a", [
                line("knowledge_writer", "knowledge", "investigate", "listed"),
                line("knowledge_writer", "knowledge", "ask", "unlisted"),
                line("knowledge_writer", "knowledge", "ask", "not_owned", "answer.md"),
            ])
            b = write_run(base, "b", [
                line("knowledge_writer", "knowledge", "interactive", "unlisted"),
                line("knowledge_writer", "knowledge", "investigate", "listed"),
                line("run_bundle_writer", "system", "investigate-v2", "unlisted", "."),
            ])
            proc, out = self.run_script(base, [a, os.path.join(b, "runtime", "handoff-observed.jsonl")])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            got = json.load(open(out))
            rows = {(r["writer"], r["group"]): r for r in got["rust"]}
            self.assertEqual(set(rows), {("knowledge_writer", "knowledge"), ("run_bundle_writer", "system")})
            k = rows[("knowledge_writer", "knowledge")]
            self.assertEqual(k["commands"], ["ask", "interactive", "investigate"])
            self.assertEqual(k["seen"], {"ask": 1, "interactive": 1, "investigate": 2})
            self.assertEqual(k["not_measured"], [])
            self.assertEqual(k["as"], "as_data_import")  # kept from the current table
            self.assertEqual(rows[("run_bundle_writer", "system")]["commands"], ["investigate-v2"])
            self.assertEqual(got["refused_not_owned"], [
                {"writer": "knowledge_writer", "group": "knowledge", "command": "ask", "count": 1}])
            self.assertIn({"writer": "knowledge_writer", "group": "knowledge", "command": "ask"}, got["not_in_current"])
            self.assertIn({"writer": "verification_writer", "group": "knowledge", "command": "continue"}, got["not_seen"])
            # same input, same bytes
            first = open(out).read()
            proc, out2 = self.run_script(base, [os.path.join(base, "b"), os.path.join(base, "a")])
            self.assertEqual(first, open(out2).read())

    def test_an_out_folder_reads_its_own_log_and_each_run_folders(self):
        with tempfile.TemporaryDirectory() as base:
            out = write_run(base, "out", [line("run_bundle_writer", "system", "investigate-v2", "unlisted", "")])
            write_run(out, "run1", [line("materialize_writer", "system", "investigate-v2", "unlisted", "runtime/")])
            proc, target = self.run_script(base, [out])
            self.assertEqual(proc.returncode, 0, proc.stderr)
            got = json.load(open(target))
            self.assertEqual([r["writer"] for r in got["rust"]], ["materialize_writer", "run_bundle_writer"])

    def test_refuses_to_overwrite_groups_json(self):
        with tempfile.TemporaryDirectory() as base:
            a = write_run(base, "a", [line("knowledge_writer", "knowledge", "investigate", "listed")])
            before = open(GROUPS).read()
            for target in (GROUPS, os.path.join(base, "groups.json")):
                proc = subprocess.run([sys.executable, SCRIPT, a, "--out", target], capture_output=True, text=True)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn("refusing", proc.stderr)
            self.assertEqual(before, open(GROUPS).read())
            self.assertFalse(os.path.exists(os.path.join(base, "groups.json")))


if __name__ == "__main__":
    unittest.main()
