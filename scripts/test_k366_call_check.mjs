#!/usr/bin/env node
// K366 (#66): NEWSROOM_GROUP_CALL_CHECK=1 (default off, exact "1") extends the call report (NEWSROOM_GROUP_CALL_REPORT) at run time, record only:
// tool_allow and tool_pin rows are judged per asking tool (declared=false when the tool is not on the row), and a call with no asking tool is recorded as
// requester "none". Checks: off (and the old switch alone) is byte-identical to before; on records the new lines; a mutated row (tool removed) turns a call
// declared=false; nothing is refused and the reply is unchanged; the checker counts the none rows without listing them as undeclared.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("k366-");
const list = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
const groups = await import(pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href);
const groupOf = (t) => list.tools[t].group;
const results = [];
const ok = (text) => results.push(text);
let seq = 0;
const newRun = () => { const dir = join(scratch, `run-${++seq}`); mkdirSync(dir, { recursive: true }); process.env.NEWSROOM_ARTIFACT_DIR = dir; return dir; };
const reportOf = (dir) => { const p = join(dir, "runtime/cross-call-report.jsonl"); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
const rowsOf = (dir) => reportOf(dir).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const checker = (dir) => spawnSync(process.execPath, [join(ROOT, "scripts/check_cross_call_report.mjs"), dir, "--groups", join(ROOT, "runtime/pi/groups.json")], { encoding: "utf8" });
const setSwitch = (report, check) => {
  for (const [name, value] of [["NEWSROOM_GROUP_CALL_REPORT", report], ["NEWSROOM_GROUP_CALL_CHECK", check]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
};
const wrap = (name, fn, dir) => groups.trackCrossCall(name, fn, () => dir);

// fixtures from the real table: one tool_allow row, one tool_pin row, each with a tool on it and a tool of another group off it
const ALLOW_FN = "queryDuckDb", allow = list.cross_calls.tool_allow[ALLOW_FN];
const onAllow = allow.tools[0];
const offAllow = Object.keys(list.tools).find((t) => groupOf(t) === "visual" && !allow.tools.includes(t) && list.cross_calls.functions[ALLOW_FN].groups.includes("visual"));
const PIN_KEY = "shadow.mjs::runShadow", pin = list.cross_calls.tool_pin[PIN_KEY];
const onPin = pin.tools[0];
const offPin = Object.keys(list.tools).find((t) => groupOf(t) !== pin.owner && !pin.tools.includes(t) && !(pin.runtime_only ?? []).includes(t));
assert.ok(onAllow && offAllow && onPin && offPin, "fixtures found");
assert.ok(list.cross_calls.imported[PIN_KEY] || list.cross_calls.modules[PIN_KEY], "fixture: the pin key is a table entry");
const reply = (x) => `reply:${x}`;

// 1. off: the function is returned as is and nothing is written, for every value but the exact "1"; the old switch alone writes what it always wrote
// #64 step 1: the call report itself is on unless exactly "0", so "off" pins CALL_REPORT=0 and varies the CALL_CHECK value
for (const value of [undefined, "true", "0", "", " 1", "2"]) {
  setSwitch("0", value);
  const dir = newRun();
  assert.equal(groups.callCheckEnabled(), false);
  assert.equal(wrap(ALLOW_FN, reply, dir), reply, `value ${JSON.stringify(value)}: not wrapped`);
  groups.runInTool(offAllow, () => reply(1));
  assert.equal(reportOf(dir), "", "nothing written");
}
for (const report of ["1", undefined]) {
  // "1" and the default (unset) are the same: the call report is on
  setSwitch(report, undefined);
  const dir = newRun();
  const fn = wrap(ALLOW_FN, reply, dir), pinFn = wrap(PIN_KEY, reply, dir);
  fn("none-asks"); pinFn("none-asks");
  groups.runInTool(offAllow, () => fn(1)); groups.runInTool(offPin, () => pinFn(1));
  const rows = rowsOf(dir);
  assert.deepEqual(rows.map((r) => r.function), [ALLOW_FN, PIN_KEY], "old switch: tool-less calls are not recorded");
  assert.equal(rows[0].tool_allowed, false, "old switch: tool_allow field as before");
  assert.ok(!("tool_allowed" in rows[1]), "old switch: no per-tool field for a tool_pin row");
  assert.ok(!rows.some((r) => "requester" in r));
}
ok('off: CALL_REPORT=0 and any CALL_CHECK value but exact 1 wrap nothing and write nothing; the call report alone (set to 1 or left at the default) records exactly what it did before');

// 2. on: per-tool judgement for tool_allow and tool_pin, none rows, reply unchanged, nothing refused
{
  setSwitch(undefined, "1");
  assert.equal(groups.callCheckEnabled(), true);
  assert.equal(groups.crossCallReportEnabled(), true, "the report machinery is on");
  const dir = newRun();
  const fn = wrap(ALLOW_FN, reply, dir), pinFn = wrap(PIN_KEY, reply, dir);
  assert.notEqual(fn, reply, "wrapped");
  assert.equal(fn("a"), reply("a"), "a tool-less call returns its reply");
  assert.equal(pinFn("a"), reply("a"));
  let r1, r2, r3, r4;
  groups.runInTool(onAllow, () => { r1 = fn(1); });
  groups.runInTool(offAllow, () => { r2 = fn(2); });
  groups.runInTool(onPin, () => { r3 = pinFn(3); });
  groups.runInTool(offPin, () => { r4 = pinFn(4); });
  assert.deepEqual([r1, r2, r3, r4], [reply(1), reply(2), reply(3), reply(4)], "replies unchanged, nothing refused");
  groups.runInTool(offAllow, () => fn(5)); // same pair again: one line only
  const rows = rowsOf(dir);
  assert.deepEqual(rows.map((r) => [r.tool ?? r.requester, r.function, r.declared, r.tool_allowed]), [
    ["none", ALLOW_FN, null, undefined],
    ["none", PIN_KEY, null, undefined],
    [onAllow, ALLOW_FN, true, true],
    [offAllow, ALLOW_FN, false, false],
    [onPin, PIN_KEY, true, true],
    [offPin, PIN_KEY, false, false],
  ], "none rows, on-row calls declared, off-row calls declared=false");
  assert.equal(rows[0].tool, null); assert.equal(rows[0].tool_group, null);
  const run = checker(dir);
  assert.equal(run.status, 1, "checker: off-row calls are found");
  assert.match(run.stdout, /NOT ALLOWED/);
  assert.ok(!/UNDECLARED null|no group/.test(run.stdout), "the none rows are not listed as undeclared");
  assert.match(run.stdout, /2 call\(s\) with no asking tool/);
  ok("on: tool_allow and tool_pin rows are judged per tool (off-row => declared=false); tool-less calls are requester none; replies unchanged; repeats not repeated");
}

// 3. mutation: take a tool off its row (a copy of the table) and the same call turns declared=false
{
  setSwitch(undefined, "1");
  for (const [fnName, tool, mutate] of [
    [ALLOW_FN, onAllow, (l) => { l.cross_calls.tool_allow[ALLOW_FN].tools = l.cross_calls.tool_allow[ALLOW_FN].tools.filter((t) => t !== onAllow); }],
    [PIN_KEY, onPin, (l) => { l.cross_calls.tool_pin[PIN_KEY].tools = l.cross_calls.tool_pin[PIN_KEY].tools.filter((t) => t !== onPin); l.cross_calls.tool_pin[PIN_KEY].runtime_only = []; }],
  ]) {
    const copy = structuredClone(list); mutate(copy);
    const restore = groups.__setEnforceHooksForTest({ groups: () => copy });
    try {
      const dir = newRun();
      groups.runInTool(tool, () => wrap(fnName, reply, dir)(1));
      const row = rowsOf(dir)[0];
      assert.equal(row.declared, false, `${fnName}: ${tool} removed from its row -> declared=false`);
      assert.equal(row.tool_allowed, false);
    } finally { restore(); }
    const dir = newRun();
    groups.runInTool(tool, () => wrap(fnName, reply, dir)(1));
    assert.equal(rowsOf(dir)[0].declared, true, `${fnName}: with the real table the same call is declared`);
  }
  ok("mutation: removing the tool from its tool_allow / tool_pin row turns the same call into declared=false");
}

// 4. the record never fails a call
{
  setSwitch(undefined, "1");
  const dir = newRun();
  writeFileSync(join(dir, "runtime"), "a file where the folder must go"); // mkdir fails
  let result;
  groups.runInTool(offAllow, () => { result = wrap(ALLOW_FN, reply, dir)(9); });
  assert.equal(result, reply(9));
  ok("on: a failing record write never reaches the call");
}

rmSync(scratch, { recursive: true, force: true });
console.log(results.map((r) => `ok - ${r}`).join("\n"));
