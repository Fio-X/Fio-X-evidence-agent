#!/usr/bin/env node
// #64 step 2: NEWSROOM_GROUP_CALL_CHECK is on unless exactly "0". It records, it never refuses. Checks, with the table's own rows as fixtures:
// 1. nothing set: the call report has the tool_allow / tool_pin rows and the requester-none rows.
// 2. a leftover NEWSROOM_GROUP_CALL_REPORT="0" (the switch is removed): ignored, the report and the check rows are written as with nothing set.
// 3. NEWSROOM_GROUP_CALL_CHECK="0": the report keeps what it recorded before step 2, the check rows are gone.
// 4. start-up: a leftover CALL_REPORT="0" does not stop the refusals (the old GROUP_CALL_REFUSE_NEEDS_REPORT stop is gone); the CALL_CHECK stop stays.
// The run-end line that names a switch turned off is made by the Rust side (artifact.rs) and tested there.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("call-check-default-");
const list = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
const clearSwitches = () => { for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name]; };
clearSwitches();
const groups = await import(pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href);
const groupOf = (t) => list.tools[t].group;
const results = [];
const ok = (text) => results.push(text);
let seq = 0;
const newRun = () => { const dir = join(scratch, `run-${++seq}`); mkdirSync(dir, { recursive: true }); process.env.NEWSROOM_ARTIFACT_DIR = dir; return dir; };
const reportPath = (dir) => join(dir, "runtime/cross-call-report.jsonl");
const rowsOf = (dir) => (existsSync(reportPath(dir)) ? readFileSync(reportPath(dir), "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// #66 step 2: both call refusals are on by default; this test is about the check's records ("it records, it never refuses"), so they are pinned "0" unless a case sets them
const setSwitches = (set) => { clearSwitches(); for (const [name, value] of Object.entries({ NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "0", ...set })) if (value !== undefined) process.env[name] = value; };
const REPORT = "NEWSROOM_GROUP_CALL_REPORT", CHECK = "NEWSROOM_GROUP_CALL_CHECK", REFUSE = "NEWSROOM_GROUP_CALL_REFUSE", ENFORCE = "NEWSROOM_GROUP_ENFORCE";
const reply = (x) => `reply:${x}`;
const wrap = (name, fn, dir) => groups.trackCrossCall(name, fn, () => dir);

// one tool_allow row and one tool_pin row from the real table, each with a tool on the row and a tool of another group off it
const ALLOW_FN = "queryDuckDb", allow = list.cross_calls.tool_allow[ALLOW_FN];
const onAllow = allow.tools[0];
const offAllow = Object.keys(list.tools).find((t) => groupOf(t) === "visual" && !allow.tools.includes(t) && list.cross_calls.functions[ALLOW_FN].groups.includes("visual"));
const PIN_KEY = "shadow.mjs::runShadow", pin = list.cross_calls.tool_pin[PIN_KEY];
const offPin = Object.keys(list.tools).find((t) => groupOf(t) !== pin.owner && !pin.tools.includes(t) && !(pin.runtime_only ?? []).includes(t));
assert.ok(onAllow && offAllow && pin.tools[0] && offPin, "fixtures found");

// one run through the same calls: a tool-less call of each, an off-row call of each, an on-row call of the allow row
const drive = (set) => {
  setSwitches(set);
  const dir = newRun();
  const fn = wrap(ALLOW_FN, reply, dir), pinFn = wrap(PIN_KEY, reply, dir);
  const replies = [fn(0), pinFn(0)];
  groups.runInTool(onAllow, () => replies.push(fn(1)));
  groups.runInTool(offAllow, () => replies.push(fn(2)));
  groups.runInTool(offPin, () => replies.push(pinFn(3)));
  assert.deepEqual(replies, [reply(0), reply(0), reply(1), reply(2), reply(3)], "replies unchanged, nothing refused");
  return dir;
};

// 1. nothing set: the check rows are there
{
  const dir = drive({});
  assert.equal(groups.callCheckEnabled(), true);
  const rows = rowsOf(dir);
  assert.ok(rows.some((r) => r.requester === "none" && r.function === ALLOW_FN), "a requester-none row for the tool_allow function");
  assert.ok(rows.some((r) => r.requester === "none" && r.function === PIN_KEY), "a requester-none row for the tool_pin function");
  assert.ok(rows.some((r) => r.tool === offAllow && r.function === ALLOW_FN && r.declared === false && r.tool_allowed === false), "an off-row tool_allow call is recorded as not declared");
  assert.ok(rows.some((r) => r.tool === offPin && r.function === PIN_KEY && r.declared === false), "an off-row tool_pin call is recorded as not declared");
  assert.ok(rows.some((r) => r.tool === onAllow && r.function === ALLOW_FN && r.declared === true), "an on-row call is declared");
  ok("nothing set: the report holds the tool_allow, tool_pin and requester-none rows, replies unchanged");
}

// 2. a leftover REPORT="0": ignored, the report and the check rows are written (whatever CALL_CHECK says about its own rows)
for (const extra of [{}, { [CHECK]: "1" }]) {
  const dir = drive({ [REPORT]: "0", ...extra });
  assert.equal(groups.callCheckEnabled(), true, `check rows on with ${JSON.stringify(extra)}`);
  const rows = rowsOf(dir);
  assert.ok(rows.some((r) => r.requester === "none" && r.function === ALLOW_FN), `the report and its check rows are written with ${JSON.stringify(extra)}`);
}
{
  const dir = drive({ [REPORT]: "0", [CHECK]: "0" });
  assert.equal(groups.callCheckEnabled(), false);
  assert.deepEqual(rowsOf(dir).map((r) => r.function), [ALLOW_FN, ALLOW_FN, PIN_KEY], "CALL_CHECK=0 keeps only the report's own rows; a leftover CALL_REPORT=0 does not remove them");
}
ok('a leftover CALL_REPORT="0" is ignored: the report file and the check rows are still written');

// 3. CHECK="0": the report keeps its old rows, the check rows are gone
{
  const dir = drive({ [CHECK]: "0" });
  assert.equal(groups.callCheckEnabled(), false);
  const rows = rowsOf(dir);
  // what the report wrote before step 2 (the old-switch-alone case of the K366 test): only calls with an asking tool, no pin judgement
  assert.deepEqual(rows.map((r) => r.function), [ALLOW_FN, ALLOW_FN, PIN_KEY], "only the rows the report always wrote");
  assert.ok(!rows.some((r) => "requester" in r), "no requester-none row");
  assert.ok(!rows.some((r) => r.function === PIN_KEY && "tool_allowed" in r), "no per-tool field on a tool_pin row");
  for (const other of ["", "false", " 0", "00", "no", "1"]) {
    setSwitches({ [CHECK]: other });
    assert.equal(groups.callCheckEnabled(), true, `CALL_CHECK=${JSON.stringify(other)}: only exactly "0" turns it off`);
  }
  ok('CALL_CHECK="0": the report is kept, the check rows are not recorded; only the exact value "0" counts');
}

// 4. start-up: the old report stop is gone; the check stop stays
{
  setSwitches({ [REFUSE]: "1", [REPORT]: "0", [ENFORCE]: "1" });
  groups.assertGroupToolsSwitches(); // a leftover report "0" does not stop it
  setSwitches({ [REFUSE]: "1", [REPORT]: "0" });
  groups.assertGroupToolsSwitches();
  setSwitches({ [REFUSE]: "1", [ENFORCE]: "1" });
  groups.assertGroupToolsSwitches();
  setSwitches({ [REFUSE]: "1", [ENFORCE]: "1", [REPORT]: "1", [CHECK]: "1" });
  groups.assertGroupToolsSwitches();
  setSwitches({ [REFUSE]: "1", [ENFORCE]: "1", [CHECK]: "0" });
  assert.throws(() => groups.assertGroupToolsSwitches(), /GROUP_CALL_REFUSE_NEEDS_ENFORCE_AND_CHECK/, "REFUSE still needs the check rows");
  setSwitches({ [REPORT]: "0" });
  groups.assertGroupToolsSwitches(); // both refusals at "0" starts
  // by default (REFUSE unset, so on) a leftover report "0" starts; the check "0" stops and names the two refusal switches
  setSwitches({ [REPORT]: "0", [REFUSE]: undefined, NEWSROOM_GROUP_CALL_REFUSE_ALL: undefined });
  groups.assertGroupToolsSwitches();
  setSwitches({ [CHECK]: "0", [REFUSE]: undefined, NEWSROOM_GROUP_CALL_REFUSE_ALL: undefined });
  assert.throws(() => groups.assertGroupToolsSwitches(), (e) => /^GROUP_CALL_REFUSE_NEEDS_ENFORCE_AND_CHECK/.test(e.message) && /NEWSROOM_GROUP_CALL_REFUSE=0/.test(e.message) && /NEWSROOM_GROUP_CALL_REFUSE_ALL=0/.test(e.message) && !/CALL_REPORT/.test(e.message));
  setSwitches({ [REPORT]: "0", [REFUSE]: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: undefined });
  groups.assertGroupToolsSwitches();
  ok('start-up: a leftover CALL_REPORT="0" never stops it; the CALL_CHECK stop stays and does not name CALL_REPORT');
}

rmSync(scratch, { recursive: true, force: true });
console.log(results.map((r) => `ok - ${r}`).join("\n"));
