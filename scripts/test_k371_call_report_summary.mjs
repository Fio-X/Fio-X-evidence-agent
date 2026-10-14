#!/usr/bin/env node
// K371: fixture test for scripts/summarize_cross_call_report.mjs. The fixture run folder holds a report with every row shape, plus a decoy file that must
// not be read (it is made unreadable); the summary must print the counts and sections, exit 0, and leave the folder unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "summarize_cross_call_report.mjs");
const tmp = mkdtempSync(join(tmpdir(), "k371-"));
try {
  const run = join(tmp, "run");
  mkdirSync(join(run, "runtime"), { recursive: true });
  mkdirSync(join(run, "data"));
  const rows = [
    { tool: "chart", tool_group: "visual", function: "queryDuckDb", callee_owner: "knowledge", declared: true, tool_allowed: true },
    { tool: "foo", tool_group: "visual", function: "queryDuckDb", callee_owner: "knowledge", declared: false, tool_allowed: false },
    { tool: "chart", tool_group: "visual", function: "saveThing", callee_owner: null, declared: null },
    { tool: "chart", tool_group: "visual", function: "evidence_gate::check", callee_owner: "knowledge", declared: false, tool_allowed: false },
    { tool: "chart", tool_group: "visual", function: "other", callee_owner: "visual", declared: true },
    { tool: null, tool_group: null, requester: "none", function: "runShadow", callee_owner: "shadow", declared: null },
  ];
  writeFileSync(join(run, "runtime/cross-call-report.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const decoy = join(run, "data/secret.txt");
  writeFileSync(decoy, "do not read");
  chmodSync(decoy, 0o000);
  const before = JSON.stringify([readdirSync(run), readdirSync(join(run, "runtime")), statSync(join(run, "runtime/cross-call-report.jsonl")).mtimeMs]);
  const res = spawnSync(process.execPath, [SCRIPT, run], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout;
  assert.match(out, /6 row\(s\)/);
  assert.match(out, /chart: declared 2, undeclared 1, not in table 1, no asking tool 0/);
  assert.match(out, /foo: declared 0, undeclared 1, not in table 0, no asking tool 0/);
  assert.match(out, /\(none\): declared 0, undeclared 0, not in table 0, no asking tool 1/);
  assert.match(out, /TOTAL: declared 2, undeclared 2, not in table 1, no asking tool 1/);
  assert.match(out, /DECLARED=FALSE \(2\)\n  foo \[visual\] -> queryDuckDb \(owner knowledge\) \[tool not on its list\]\n  chart \[visual\] -> evidence_gate::check/);
  assert.match(out, /REQUESTER=NONE \(1\)\n  runShadow \(owner shadow\)/);
  assert.match(out, /TOOL_ALLOW \/ TOOL_PIN VERDICTS \(3: 1 allowed, 2 not allowed\)/);
  assert.match(out, /NOT ALLOWED foo \[visual\] -> queryDuckDb/);
  assert.equal(JSON.stringify([readdirSync(run), readdirSync(join(run, "runtime")), statSync(join(run, "runtime/cross-call-report.jsonl")).mtimeMs]), before, "the run folder is unchanged");
  // a report file path works too; a missing or broken report exits 2
  assert.equal(spawnSync(process.execPath, [SCRIPT, join(run, "runtime/cross-call-report.jsonl")], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, join(tmp, "nope")], { encoding: "utf8" }).status, 2);
  writeFileSync(join(tmp, "bad.jsonl"), "{}\nnot json\n");
  assert.equal(spawnSync(process.execPath, [SCRIPT, join(tmp, "bad.jsonl")], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2);
  // mutation: an undeclared row dropped from the report changes the count
  writeFileSync(join(tmp, "m.jsonl"), rows.filter((r) => r.declared !== false).map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.match(spawnSync(process.execPath, [SCRIPT, join(tmp, "m.jsonl")], { encoding: "utf8" }).stdout, /DECLARED=FALSE \(0\)/);
  chmodSync(decoy, 0o600);
  console.log("PASS test_k371_call_report_summary");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
