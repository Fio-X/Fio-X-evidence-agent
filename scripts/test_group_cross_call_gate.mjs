#!/usr/bin/env node
// K214 part C: the run-time gate for the knowledge entry functions (groups.json cross_calls.gated).
// With NEWSROOM_GROUP_ENFORCE=1 a gated function lets a knowledge tool through, lets a group through that its cross_calls line lists, and refuses
// every other tool, a tool without a group, and a table line that is missing. With the switch off it does nothing. A refusal is logged to
// runtime/boundary-refusals.jsonl. Also: every gated name is a line of the table and starts with its assertCrossCall in newsroom.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";
import { BoundaryRefusal, CALL_REPORT_PATH, REFUSAL_LOG_PATH, assertCrossCall, assertGroupToolsSwitches, callRefuseAllEnabled, callRefuseEnabled, callRefuseNoToolEnabled, crossCallProblem, runInTool, trackCrossCall } from "../runtime/pi/groups.mjs";
// Start from no group switches, whatever the caller has set: this test sets the ones it needs, and an inherited switch changes what it measures.
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const list = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
const table = list.cross_calls;
const toolOf = (group) => Object.keys(list.tools).find((t) => list.tools[t].group === group);

// every gated name: a table line, and the first statement of its function in newsroom.ts
const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
assert.ok(table.gated.length >= 5, "the gated list is not empty");
const gatedProblems = (t) => t.gated.flatMap((name) => [
  ...(t.functions[name] ? [] : [`${name} has no cross_calls line`]),
  ...(src.includes(`assertCrossCall(artifactRoot(), "${name}")`) ? [] : [`${name} does not start with its assertCrossCall`]),
]);
assert.deepEqual(gatedProblems(table), [], "every gated name has a cross_calls line and starts with its assertCrossCall");
// K343 mutation: a gated line removed by hand (what the baseline writer used to do) turns this red, one name at a time
for (const name of table.gated) {
  const without = { ...table, functions: Object.fromEntries(Object.entries(table.functions).filter(([key]) => key !== name)) };
  assert.deepEqual(gatedProblems(without), [`${name} has no cross_calls line`], `removing the ${name} line is red`);
}

// the decision
const knowledge = toolOf("knowledge"), visual = toolOf("visual"), system = toolOf("system");
assert.equal(crossCallProblem(list, "queryDuckDb", knowledge), null, "same group passes");
assert.equal(crossCallProblem(list, "queryDuckDb", null), null, "no asking tool (a command) passes");
assert.equal(crossCallProblem(list, "notGated", visual), null, "an ungated name passes");
assert.equal(crossCallProblem(list, "recordClaimArtifact", visual), null, "a listed group passes");
assert.match(crossCallProblem(list, "recordClaimArtifact", system) ?? "", /not listed/, "a group the line does not list is refused");
assert.match(crossCallProblem(list, "recordClaimArtifact", "no_such_tool") ?? "", /no group/, "a tool without a group is refused");
const trimmed = structuredClone(list);
trimmed.cross_calls.functions.recordClaimArtifact.groups = ["agent"];
assert.match(crossCallProblem(trimmed, "recordClaimArtifact", visual) ?? "", /not listed/, "taking a group off the line refuses it");
delete trimmed.cross_calls.functions.recordClaimArtifact;
assert.match(crossCallProblem(trimmed, "recordClaimArtifact", visual) ?? "", /not listed/, "a missing line refuses");

// the switch and the log
const root = makeTestTmp("cross-call-gate-");
// this part is about the group-level gate (the list of groups per function), not the per-tool rows: both call refusals (on by default, #66 step 2) are pinned "0" until it ends
process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0";
process.env.NEWSROOM_GROUP_ENFORCE = "0"; // #64 step 3: the refusal is on by default, the off path pins "0"
runInTool(system, () => assertCrossCall(root, "recordClaimArtifact"));
assert.ok(!existsSync(join(root, REFUSAL_LOG_PATH)), "switch off: nothing happens, nothing logged");
process.env.NEWSROOM_GROUP_ENFORCE = "1";
runInTool(visual, () => assertCrossCall(root, "recordClaimArtifact"));
assert.throws(() => runInTool(system, () => assertCrossCall(root, "recordClaimArtifact")), (e) => e instanceof BoundaryRefusal && e.detail.status === "cross_call_not_listed");
const logged = readFileSync(join(root, REFUSAL_LOG_PATH), "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(logged.length, 1);
assert.equal(logged[0].op, "cross_call");
assert.equal(logged[0].tool, system);
delete process.env.NEWSROOM_GROUP_ENFORCE;
delete process.env.NEWSROOM_GROUP_CALL_REFUSE; delete process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL;
rmSync(root, { recursive: true, force: true });

// ---- K381: NEWSROOM_GROUP_CALL_REFUSE=1 (default off, exact "1"; needs ENFORCE and CALL_CHECK): a tool off its tool_allow / tool_pin row is refused ----
const toolsOfGroupNot = (owner, listed) => Object.keys(list.tools).filter((t) => list.tools[t].group !== owner && !listed.includes(t));
const allowRow = table.tool_allow.queryDuckDb;
const offAllow = toolsOfGroupNot("knowledge", allowRow.tools).find((t) => (table.functions.queryDuckDb.groups ?? []).includes(list.tools[t].group));
assert.ok(offAllow, "there is a tool of a listed group that is not on the queryDuckDb tool_allow list");
assert.equal(crossCallProblem(list, "queryDuckDb", offAllow), null, "refuse off: a tool off the tool_allow list passes as before");
assert.equal(crossCallProblem(list, "queryDuckDb", offAllow, false), null, "refuse false is the same");
assert.match(crossCallProblem(list, "queryDuckDb", offAllow, true) ?? "", /tool_allow/, "refuse on: a tool off the tool_allow list is refused");
for (const t of allowRow.tools) assert.equal(crossCallProblem(list, "queryDuckDb", t, true), null, `refuse on: ${t} is on the list`);
assert.equal(crossCallProblem(list, "queryDuckDb", knowledge, true), null, "refuse on: the owning group passes");
assert.equal(crossCallProblem(list, "queryDuckDb", null, true), null, "refuse on: no asking tool still passes (that is its own switch)");
// the pin rows (class B): every row refuses a tool of another group that is on neither list, and lets the listed ones and the owner through
for (const [key, pin] of Object.entries(table.tool_pin)) {
  const listed = [...(pin.tools ?? []), ...(pin.runtime_only ?? [])];
  const off = toolsOfGroupNot(pin.owner, listed)[0];
  assert.ok(off, `${key}: a tool off the row exists`);
  assert.equal(crossCallProblem(list, key, off), crossCallProblem(list, key, off, false), `${key}: refuse off is the same as today`);
  if (!table.gated.includes(key)) assert.equal(crossCallProblem(list, key, off), null, `${key}: refuse off lets any tool through (not gated)`);
  assert.match(crossCallProblem(list, key, off, true) ?? "", /tool_pin|tool_allow|not listed/, `${key}: refuse on refuses a tool off the row`);
  for (const t of listed) assert.equal(crossCallProblem(list, key, t, true), null, `${key}: ${t} is on the row`);
}
// mutation on a copy of the table: dropping a tool from a row turns a pass into a refusal; dropping the row turns a refusal into a pass
const dropped = structuredClone(list);
const some = table.tool_pin["duckDbRun"].tools[0];
assert.equal(crossCallProblem(list, "duckDbRun", some, true), null);
dropped.cross_calls.tool_pin.duckDbRun.tools = dropped.cross_calls.tool_pin.duckDbRun.tools.filter((t) => t !== some);
if (list.tools[some].group !== "knowledge") assert.match(crossCallProblem(dropped, "duckDbRun", some, true) ?? "", /tool_pin/, "taking a tool off a row refuses it");
const rowless = structuredClone(list);
delete rowless.cross_calls.tool_pin.duckDbRun;
assert.equal(crossCallProblem(rowless, "duckDbRun", offAllow, true), null, "no row: nothing to judge");

// the entry points: every gated name and every tool_pin key is wrapped or asserts, so the refusal reaches it (A1)
const entryProblems = [];
for (const key of Object.keys(table.tool_pin)) {
  if (table.gated.includes(key)) { if (!src.includes(`assertCrossCall(artifactRoot(), "${key}")`)) entryProblems.push(`${key}: no assertCrossCall`); continue; }
  const file = key.includes("::") ? join(ROOT, "runtime/pi", key.split("::")[0]) : join(ROOT, "runtime/pi/newsroom.ts");
  const text = readFileSync(file, "utf8");
  const wrapped = key.includes("::") ? text.includes(`trackExport("${key}"`) : text.includes(`trackCrossCall("${key}"`);
  if (!wrapped) entryProblems.push(`${key}: not wrapped`);
}
assert.deepEqual(entryProblems, [], "every tool_pin key has its entry");

// the wrap with the refusal on: the call is recorded first, then refused; off, or with any value but "1", nothing changes
// #66 step 2: CALL_REFUSE and CALL_REFUSE_ALL are on unless exactly "0". This section is about CALL_REFUSE, so ALL is pinned "0" here unless a case names it.
const keys = ["NEWSROOM_GROUP_ENFORCE", "NEWSROOM_GROUP_CALL_CHECK", "NEWSROOM_GROUP_CALL_REFUSE", "NEWSROOM_GROUP_CALL_REFUSE_ALL"];
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const setEnv = (e) => { const all = { NEWSROOM_GROUP_CALL_REFUSE_ALL: "0", ...e }; keys.forEach((k) => (all[k] === undefined ? delete process.env[k] : (process.env[k] = all[k]))); };
const pinOff = toolsOfGroupNot(table.tool_pin.duckDbRun.owner, table.tool_pin.duckDbRun.tools)[0];
const rootR = makeTestTmp("call-refuse-");
// #64 step 1: the call report is on by default, so "the wrap returns the function itself" is the CALL_REPORT=0 state; the wrap decides when it is made
process.env.NEWSROOM_GROUP_CALL_REPORT = "0";
const sync = trackCrossCall("duckDbRun", () => "ran", () => rootR);
const asyncFn = trackCrossCall("duckDbRun", async () => "ran", () => rootR);
delete process.env.NEWSROOM_GROUP_CALL_REPORT;
assert.equal(trackCrossCall("duckDbRun", () => "ran", () => rootR).name, "tracked", "default: the call report is on, the wrap is a tracking function");
const readLines = (rel) => (existsSync(join(rootR, rel)) ? readFileSync(join(rootR, rel), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
try {
  // on unless exactly "0": only "0" is off; unset, "1", "", "true", "yes", " 0", "00" and the like are on
  setEnv({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "1", NEWSROOM_GROUP_CALL_REFUSE: "0" });
  assert.equal(callRefuseEnabled(), false, 'value "0" is off');
  assert.equal(runInTool(pinOff, () => assertCrossCall(rootR, "duckDbRun")), undefined, 'value "0": no refusal');
  assert.ok(!existsSync(join(rootR, REFUSAL_LOG_PATH)), "refuse off: nothing refused, nothing logged");
  for (const v of [undefined, "", "1", "true", "yes", " 0", "00", " 1", "11"]) {
    setEnv({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "1", NEWSROOM_GROUP_CALL_REFUSE: v });
    assert.equal(callRefuseEnabled(), true, `value ${JSON.stringify(v)} is on`);
    assert.throws(() => runInTool(pinOff, () => assertCrossCall(rootR, "duckDbRun")), BoundaryRefusal, `value ${JSON.stringify(v)}: refused`);
  }
  setEnv({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "1", NEWSROOM_GROUP_CALL_REFUSE: "1" });
  assert.equal(callRefuseEnabled(), true);
  const refusal = (e) => e instanceof BoundaryRefusal && e.detail.status === "cross_call_not_listed" && /tool_pin/.test(e.detail.reason);
  const syncOn = trackCrossCall("duckDbRun", () => "ran", () => rootR);
  const asyncOn = trackCrossCall("duckDbRun", async () => "ran", () => rootR);
  assert.throws(() => runInTool(pinOff, () => syncOn()), refusal, "a plain function throws the refusal");
  await assert.rejects(() => runInTool(pinOff, () => asyncOn()), refusal, "an async function rejects with it");
  assert.equal(runInTool(table.tool_pin.duckDbRun.tools[0], () => syncOn()), "ran", "a tool on the row still runs");
  const report = readLines(CALL_REPORT_PATH);
  const line = report.find((r) => r.tool === pinOff && r.function === "duckDbRun");
  assert.ok(line && line.declared === false && line.tool_allowed === false, "the refused call was recorded first, as undeclared");
  const refused = readLines(REFUSAL_LOG_PATH);
  assert.ok(refused.length >= 1 && refused.every((r) => r.op === "cross_call" && r.tool === pinOff), "the refusal is logged");
  // the startup chain: the refusal needs ENFORCE and CALL_CHECK, else the extension stops
  // (#64 steps 2 and 3: the check and the refusal are on unless exactly "0", so "missing" is spelled CALL_CHECK=0 or ENFORCE=0)
  for (const e of [{ NEWSROOM_GROUP_CALL_REFUSE: "1", NEWSROOM_GROUP_ENFORCE: "0" }, { NEWSROOM_GROUP_CALL_REFUSE: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "0" }, { NEWSROOM_GROUP_CALL_REFUSE: "1", NEWSROOM_GROUP_CALL_CHECK: "1", NEWSROOM_GROUP_ENFORCE: "0" }]) {
    setEnv(e);
    assert.throws(() => assertGroupToolsSwitches(), /GROUP_CALL_REFUSE_NEEDS_ENFORCE_AND_CHECK/, `chain: ${Object.keys(e).join("+")}`);
  }
  setEnv({ NEWSROOM_GROUP_CALL_REFUSE: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "1" });
  assertGroupToolsSwitches();
  setEnv({});
  assertGroupToolsSwitches();
  // by default (nothing set, both refusals on) an ENFORCE, CHECK or REPORT turned off stops at start-up and the message names the two switches to set to "0"; with both at "0" it starts
  for (const e of [{ NEWSROOM_GROUP_ENFORCE: "0" }, { NEWSROOM_GROUP_CALL_CHECK: "0" }, { NEWSROOM_GROUP_HANDOFF: "0" }]) {
    for (const k of Object.keys(e)) process.env[k] = e[k];
    delete process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL; delete process.env.NEWSROOM_GROUP_CALL_REFUSE;
    assert.throws(() => assertGroupToolsSwitches(), (err) => /^GROUP_CALL_REFUSE_NEEDS_ENFORCE_AND_CHECK/.test(err.message) && /NEWSROOM_GROUP_CALL_REFUSE=0/.test(err.message) && /NEWSROOM_GROUP_CALL_REFUSE_ALL=0/.test(err.message), `default stops: ${Object.keys(e).join("+")}`);
    process.env.NEWSROOM_GROUP_CALL_REFUSE = "0";
    assert.throws(() => assertGroupToolsSwitches(), /GROUP_CALL_REFUSE_ALL_NEEDS_ENFORCE_AND_CHECK/, `ALL alone stops: ${Object.keys(e).join("+")}`);
    process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0";
    assertGroupToolsSwitches();
    for (const k of Object.keys(e)) delete process.env[k];
    setEnv({});
  }
  assert.equal(runInTool(pinOff, () => sync()), "ran", "CALL_REPORT=0 and the rest off: the unwrapped function itself");
  assert.equal(sync.name === "tracked", false, "CALL_REPORT=0 and the rest off: the wrap returns the function itself");
  assert.equal(await runInTool(pinOff, () => asyncFn()), "ran");
} finally { setEnv(saved); rmSync(rootR, { recursive: true, force: true }); }


// ---- K381 A4: NEWSROOM_GROUP_CALL_REFUSE_NOTOOL=1 (its own switch, on top of CALL_REFUSE): a gated or tool_pin function with no asking tool is refused ----
assert.equal(crossCallProblem(list, "queryDuckDb", null, true), null, "noTool false: no asking tool passes");
assert.match(crossCallProblem(list, "queryDuckDb", null, true, true) ?? "", /no asking tool/, "noTool on: a gated name with no asking tool is refused");
assert.match(crossCallProblem(list, "duckDbRun", null, true, true) ?? "", /no asking tool/, "noTool on: a tool_pin key with no asking tool is refused");
assert.equal(crossCallProblem(list, "notGated", null, true, true), null, "noTool on: an ungated name still passes");
assert.equal(crossCallProblem(list, "queryDuckDb", knowledge, true, true), null, "noTool on: a tool still goes by its row");
const noToolKeys = ["NEWSROOM_GROUP_CALL_REFUSE_NOTOOL", "NEWSROOM_ARTIFACT_DIR"]; // keys already holds CALL_REFUSE_ALL; setAll pins it "0" like setEnv
const savedNT = Object.fromEntries([...keys, ...noToolKeys].map((k) => [k, process.env[k]]));
const setAll = (e) => { const all = { NEWSROOM_GROUP_CALL_REFUSE_ALL: "0", ...e }; [...keys, ...noToolKeys].forEach((k) => (all[k] === undefined ? delete process.env[k] : (process.env[k] = all[k]))); };
const rootN = makeTestTmp("call-notool-");
const linesOf = (rel) => (existsSync(join(rootN, rel)) ? readFileSync(join(rootN, rel), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const base = { NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "1", NEWSROOM_GROUP_CALL_REFUSE: "1", NEWSROOM_ARTIFACT_DIR: rootN };
try {
  for (const v of [undefined, "", "0", "true", " 1", "11"]) {
    setAll({ ...base, NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: v });
    assert.equal(callRefuseNoToolEnabled(), false, `value ${JSON.stringify(v)} is off`);
    assert.equal(assertCrossCall(rootN, "queryDuckDb"), undefined, `value ${JSON.stringify(v)}: a tool-less call passes`);
  }
  assert.ok(!existsSync(join(rootN, REFUSAL_LOG_PATH)), "NOTOOL off: nothing refused");
  setAll({ ...base, NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assert.throws(() => assertCrossCall(rootN, "queryDuckDb"), (e) => e instanceof BoundaryRefusal && e.detail.status === "cross_call_no_tool", "a tool-less call is refused");
  assert.ok(linesOf(CALL_REPORT_PATH).some((r) => r.requester === "none" && r.function === "queryDuckDb"), "recorded first (requester none)");
  assert.ok(linesOf(REFUSAL_LOG_PATH).some((r) => r.status === "cross_call_no_tool"), "and logged");
  // the asking tool survives timers and promises: a call made there is judged by its row, not as tool-less
  await runInTool(knowledge, () => new Promise((resolveDone, rejectDone) => setTimeout(() => Promise.resolve().then(() => { try { assertCrossCall(rootN, "queryDuckDb"); resolveDone(); } catch (e) { rejectDone(e); } }), 5)));
  // without the run folder (NEWSROOM_ARTIFACT_DIR unset) nothing is refused: the program cannot say where to record it
  setAll({ ...base, NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1", NEWSROOM_ARTIFACT_DIR: undefined });
  assert.equal(assertCrossCall(rootN, "knowledgeSide"), undefined, "no run folder: a tool-less call passes");
  // NOTOOL alone (REFUSE off) refuses nothing, even if the startup check were bypassed
  setAll({ ...base, NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assert.equal(assertCrossCall(rootN, "queryDuckDb"), undefined, "NOTOOL without REFUSE: a tool-less call passes");
  // the chain: NOTOOL needs REFUSE (on by default now, so "needs" is spelled both refusals at "0")
  setAll({ NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assert.throws(() => assertGroupToolsSwitches(), /GROUP_CALL_REFUSE_NOTOOL_NEEDS_REFUSE/);
  setAll({ NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assertGroupToolsSwitches(); // NOTOOL alone starts now: the refusal it sits on is on by default
  setAll({ ...base, NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assertGroupToolsSwitches();
} finally { setAll(savedNT); rmSync(rootN, { recursive: true, force: true }); }

// ---- #66 step 2: NEWSROOM_GROUP_CALL_REFUSE_ALL (on unless exactly "0"): every wrapped function with a row refuses a call from a group its row does not list ----
// A name with a row that is neither gated nor on a tool_pin row: a plain one and a `module::name` one (the 46 names that are not wrapped cannot be reached).
const rowOnlyPlain = Object.keys(table.functions).find((k) => !table.gated.includes(k) && !table.tool_pin[k] && !table.tool_allow[k] && table.functions[k].groups.length === 2 && table.functions[k].groups.includes("visual"));
const rowOnlyModule = Object.keys(table.imported).find((k) => k.includes("::") && !table.tool_pin[k] && table.imported[k].owner === "agent" && table.imported[k].groups.length === 1);
assert.ok(rowOnlyPlain && rowOnlyModule, "the table has a plain and a module row outside the gated and tool_pin names");
const NOROW = "aFunctionWithNoRowInTheTable";
assert.ok(!table.functions[NOROW] && !table.imported[NOROW] && !table.modules[NOROW]);
const rowOf = (key) => (key.includes("::") ? table.imported[key] : table.functions[key]);
const listedGroups = (key) => [...new Set([rowOf(key).owner ?? null, ...rowOf(key).groups])];
const offRowTool = (key) => Object.keys(list.tools).find((t) => !listedGroups(key).includes(list.tools[t].group));
const onRowTool = (key) => Object.keys(list.tools).find((t) => rowOf(key).groups.includes(list.tools[t].group));
for (const key of [rowOnlyPlain, rowOnlyModule]) {
  const off = offRowTool(key), on = onRowTool(key);
  assert.ok(off && on, `${key}: a tool off the row and a tool on it exist`);
  assert.equal(crossCallProblem(list, key, off, true), null, `${key}: REFUSE alone does not judge a row-only name`);
  assert.equal(crossCallProblem(list, key, off, true, true), null, `${key}: REFUSE and NOTOOL do not either`);
  assert.equal(crossCallProblem(list, key, off, true, false, false), null, `${key}: all false is the same as today`);
  assert.match(crossCallProblem(list, key, off, true, false, true) ?? "", /not listed in cross_calls/, `${key}: ALL refuses a tool of an unlisted group`);
  assert.equal(crossCallProblem(list, key, on, true, false, true), null, `${key}: ALL lets a listed group through`);
  assert.match(crossCallProblem(list, key, "no_such_tool", true, false, true) ?? "", /no group/, `${key}: ALL refuses a tool with no group`);
  assert.equal(crossCallProblem(list, key, null, true, true, true), null, `${key}: ALL never refuses a call with no asking tool, NOTOOL or not`);
}
assert.equal(crossCallProblem(list, NOROW, offRowTool(rowOnlyPlain), true, true, true), null, "ALL: a name with no row (declared: null) is never refused");
// the owner of a module row passes: the owning group is not in its own groups list
const ownerTool = Object.keys(list.tools).find((t) => list.tools[t].group === rowOf(rowOnlyModule).owner);
assert.ok(ownerTool && !rowOf(rowOnlyModule).groups.includes(list.tools[ownerTool].group));
assert.equal(crossCallProblem(list, rowOnlyModule, ownerTool, true, false, true), null, "ALL: the owner of a row passes");
// ALL does not change what the gated and pinned names do
for (const key of [...table.gated, ...Object.keys(table.tool_pin)]) for (const t of [knowledge, visual, system, null, "no_such_tool", offAllow]) for (const noTool of [false, true]) {
  assert.equal(crossCallProblem(list, key, t, true, noTool, true), crossCallProblem(list, key, t, true, noTool, false), `${key}/${t}/${noTool}: ALL leaves the 27 names as they are`);
}
// the table copy with the row removed or the group added: the decision follows the row
const rowless2 = structuredClone(list); delete rowless2.cross_calls.functions[rowOnlyPlain];
assert.equal(crossCallProblem(rowless2, rowOnlyPlain, offRowTool(rowOnlyPlain), true, false, true), null, "ALL: remove the row and nothing is judged");
const widened = structuredClone(list); widened.cross_calls.functions[rowOnlyPlain].groups.push(list.tools[offRowTool(rowOnlyPlain)].group);
assert.equal(crossCallProblem(widened, rowOnlyPlain, offRowTool(rowOnlyPlain), true, false, true), null, "ALL: list the group and it passes");

// the switch end to end: on unless exactly "0", the call recorded first, the same refusal and log, the wrap chosen when the module is loaded
const allKeys = [...keys, "NEWSROOM_GROUP_CALL_REFUSE_ALL", "NEWSROOM_GROUP_CALL_REFUSE_NOTOOL", "NEWSROOM_GROUP_CALL_REPORT", "NEWSROOM_ARTIFACT_DIR"];
const savedAll = Object.fromEntries(allKeys.map((k) => [k, process.env[k]]));
const setA = (e) => allKeys.forEach((k) => (e[k] === undefined ? delete process.env[k] : (process.env[k] = e[k])));
const ON = { NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "1", NEWSROOM_GROUP_CALL_REFUSE: "0" }; // this section is about ALL, so CALL_REFUSE (on by default) is pinned "0"
const offTool = offRowTool(rowOnlyPlain), onTool = onRowTool(rowOnlyPlain);
const filesOf = (dir) => ({ report: existsSync(join(dir, CALL_REPORT_PATH)) ? readFileSync(join(dir, CALL_REPORT_PATH), "utf8") : null, refusals: existsSync(join(dir, REFUSAL_LOG_PATH)) ? readFileSync(join(dir, REFUSAL_LOG_PATH), "utf8") : null });
const calls = (dir, fns) => { for (const [t, name, fn] of fns) { try { runInTool(t, () => fn(dir, name)); } catch { /* a refusal is read from the log */ } } };
try {
  // off: exactly "0" refuses nothing; every other value (unset, "", "true", "01", " 1", "11", "yes") is on and gives the same records as unset (byte for byte)
  {
    setA({ ...ON, NEWSROOM_GROUP_CALL_REFUSE_ALL: "0" });
    assert.equal(callRefuseAllEnabled(), false, 'value "0" is off');
    const dir0 = makeTestTmp("call-refuse-all-off-");
    const wrapped0 = trackCrossCall(rowOnlyPlain, () => "ran", () => dir0);
    assert.equal(runInTool(offTool, () => wrapped0()), "ran", 'value "0": an undeclared call to a row-only name runs');
    calls(dir0, [[offTool, rowOnlyModule, assertCrossCall], [onTool, rowOnlyModule, assertCrossCall], [offTool, NOROW, assertCrossCall]]);
    const got0 = filesOf(dir0);
    assert.equal(got0.refusals, null, 'value "0": nothing refused, nothing logged');
    const report0 = got0.report.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(report0.find((r) => r.tool === offTool && r.function === rowOnlyPlain)?.declared, false, 'value "0": the undeclared call is recorded as such');
    rmSync(dir0, { recursive: true, force: true });
  }
  const reference = [];
  for (const v of [undefined, "", "true", "01", " 1", "11", "yes", " 0", "00"]) {
    setA({ ...ON, NEWSROOM_GROUP_CALL_REFUSE_ALL: v });
    assert.equal(callRefuseAllEnabled(), true, `value ${JSON.stringify(v)} is on`);
    const dir = makeTestTmp("call-refuse-all-default-");
    const wrapped = trackCrossCall(rowOnlyPlain, () => "ran", () => dir);
    assert.throws(() => runInTool(offTool, () => wrapped()), BoundaryRefusal, `value ${JSON.stringify(v)}: an undeclared call to a row-only name is refused`);
    calls(dir, [[offTool, rowOnlyModule, assertCrossCall], [onTool, rowOnlyModule, assertCrossCall], [offTool, NOROW, assertCrossCall]]);
    const got = filesOf(dir);
    assert.ok(got.refusals !== null, `value ${JSON.stringify(v)}: the refusal is logged`);
    reference.push(got.report);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(reference.every((r) => r === reference[0]), "the call record is byte-identical for every value but exactly 0");

  // on: ALL alone (REFUSE "0") refuses the undeclared row-only calls, plain and module, records them first, logs the same way
  setA({ ...ON, NEWSROOM_GROUP_CALL_REFUSE_ALL: "1" });
  assert.equal(callRefuseAllEnabled(), true);
  assert.equal(callRefuseEnabled(), false, "ALL is not CALL_REFUSE; it implies it where the call is judged");
  const dir = makeTestTmp("call-refuse-all-on-");
  const wrappedOn = trackCrossCall(rowOnlyPlain, () => "ran", () => dir);
  const wrappedAsync = trackCrossCall(rowOnlyPlain, async () => "ran", () => dir);
  const refusedAll = (e) => e instanceof BoundaryRefusal && e.detail.status === "cross_call_not_listed" && /not listed in cross_calls/.test(e.detail.reason);
  assert.throws(() => runInTool(offTool, () => wrappedOn()), refusedAll, "an undeclared call to a row-only plain name is refused");
  await assert.rejects(() => runInTool(offTool, () => wrappedAsync()), refusedAll, "an async function rejects with it");
  assert.throws(() => runInTool(offRowTool(rowOnlyModule), () => assertCrossCall(dir, rowOnlyModule)), refusedAll, "an undeclared call to a row-only module name is refused");
  assert.equal(runInTool(onTool, () => wrappedOn()), "ran", "a declared call goes through with the switch on");
  assert.equal(runInTool(onTool, () => assertCrossCall(dir, rowOnlyPlain)), undefined);
  assert.equal(runInTool(offTool, () => assertCrossCall(dir, NOROW)), undefined, "a name with no row (declared: null) goes through");
  assert.equal(runInTool(offTool, () => assertCrossCall(dir, NOROW)), undefined);
  const lines = (rel) => readFileSync(join(dir, rel), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const first = lines(CALL_REPORT_PATH).find((r) => r.tool === offTool && r.function === rowOnlyPlain);
  assert.ok(first && first.declared === false, "the refused call was recorded first, as undeclared");
  assert.ok(lines(CALL_REPORT_PATH).some((r) => r.tool === offTool && r.function === NOROW && r.declared === null), "the no-row call is recorded with declared null");
  const log = lines(REFUSAL_LOG_PATH);
  assert.ok(log.length >= 3 && log.every((r) => r.op === "cross_call" && r.kind === "cross_call" && r.status === "cross_call_not_listed"), "the same refusal log as CALL_REFUSE writes");
  assert.ok(!log.some((r) => r.path === NOROW) && !log.some((r) => r.tool === onTool), "no declared and no row-less call in the log");
  // a tool-less call goes through (NOTOOL is a separate switch and never reaches a row-only name)
  setA({ ...ON, NEWSROOM_GROUP_CALL_REFUSE_ALL: "1", NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1", NEWSROOM_ARTIFACT_DIR: dir });
  assert.equal(assertCrossCall(dir, rowOnlyPlain), undefined, "ALL + NOTOOL: a tool-less call to a row-only name still passes");
  assert.throws(() => assertCrossCall(dir, "queryDuckDb"), (e) => e instanceof BoundaryRefusal && e.detail.status === "cross_call_no_tool", "ALL + NOTOOL: a gated name with no tool is refused as NOTOOL says");
  rmSync(dir, { recursive: true, force: true });

  // the wrap is chosen when it is made: made before the switch is set it only records
  setA({ ...ON, NEWSROOM_GROUP_CALL_REFUSE_ALL: "0" });
  const dirW = makeTestTmp("call-refuse-all-wrap-");
  const early = trackCrossCall(rowOnlyPlain, () => "ran", () => dirW);
  setA({ ...ON, NEWSROOM_GROUP_CALL_REFUSE_ALL: "1" });
  assert.equal(runInTool(offTool, () => early()), "ran", "a wrap made before the switch was set records only");
  assert.equal(existsSync(join(dirW, REFUSAL_LOG_PATH)), false);
  assert.throws(() => runInTool(offTool, () => trackCrossCall(rowOnlyPlain, () => "ran", () => dirW)()), refusedAll, "a wrap made after it refuses");
  rmSync(dirW, { recursive: true, force: true });

  // the start-up chain: ALL needs ENFORCE and CALL_CHECK (and so the report); NOTOOL accepts ALL as its prerequisite
  for (const e of [{ NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "1", NEWSROOM_GROUP_ENFORCE: "0" }, { NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "1", NEWSROOM_GROUP_CALL_CHECK: "1", NEWSROOM_GROUP_ENFORCE: "0" }, { NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "0" }, { NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_REPORT: "0" }]) {
    setA(e);
    assert.throws(() => assertGroupToolsSwitches(), /GROUP_CALL_REFUSE_ALL_NEEDS_ENFORCE_AND_CHECK/, `chain: ${Object.entries(e).map(([k, v]) => `${k.replace("NEWSROOM_GROUP_", "")}=${v}`).join(" ")}`);
  }
  setA({ ...ON, NEWSROOM_GROUP_CALL_REFUSE_ALL: "1" });
  assertGroupToolsSwitches();
  setA({ ...ON, NEWSROOM_GROUP_CALL_REFUSE_ALL: "1", NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assertGroupToolsSwitches();
  setA({ NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "0", NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assert.throws(() => assertGroupToolsSwitches(), /GROUP_CALL_REFUSE_NOTOOL_NEEDS_REFUSE/, "NOTOOL with both refusals at 0 still stops");
  setA({ NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assertGroupToolsSwitches(); // NOTOOL alone starts: the refusals are on by default
  setA({ NEWSROOM_GROUP_CALL_REFUSE_ALL: "0" });
  assertGroupToolsSwitches();

  // ---- the owner's acceptance (#66 step 2): an undeclared call outside the 27 gated names, through a function with a table row, from a group the row does not allow.
  // Recorded and refused with both switches unset; let through (still recorded) with both at "0"; the same call from a group the row allows is not refused.
  assert.ok(!table.gated.includes(rowOnlyPlain) && !table.tool_pin[rowOnlyPlain], "the function is outside the gated and tool_pin names");
  const accept = (env) => {
    setA(env);
    const dirA = makeTestTmp("call-refuse-accept-");
    const wrappedA = trackCrossCall(rowOnlyPlain, () => "ran", () => dirA);
    return { dirA, wrappedA };
  };
  {
    const { dirA, wrappedA } = accept({}); // nothing set: both refusals, ENFORCE, CHECK and the report all on by default
    assert.throws(() => runInTool(offTool, () => wrappedA()), refusedAll, "unset: the undeclared call is refused");
    const rec = readFileSync(join(dirA, CALL_REPORT_PATH), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.tool === offTool && r.function === rowOnlyPlain);
    assert.ok(rec && rec.declared === false, "unset: it is recorded as undeclared");
    assert.equal(runInTool(onTool, () => wrappedA()), "ran", "unset: the same call from an allowed group is not refused");
    rmSync(dirA, { recursive: true, force: true });
  }
  {
    const { dirA, wrappedA } = accept({ NEWSROOM_GROUP_CALL_REFUSE: "0", NEWSROOM_GROUP_CALL_REFUSE_ALL: "0" });
    assert.equal(runInTool(offTool, () => wrappedA()), "ran", 'both "0": the call is let through');
    const rec = readFileSync(join(dirA, CALL_REPORT_PATH), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.tool === offTool && r.function === rowOnlyPlain);
    assert.ok(rec && rec.declared === false, 'both "0": it is still recorded as undeclared');
    assert.equal(existsSync(join(dirA, REFUSAL_LOG_PATH)), false, 'both "0": nothing in the refusal log');
    rmSync(dirA, { recursive: true, force: true });
  }
} finally { setA(savedAll); }

console.log("group cross-call gate -- PASS");
