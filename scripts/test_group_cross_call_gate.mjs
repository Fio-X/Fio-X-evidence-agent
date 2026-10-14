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
import { BoundaryRefusal, CALL_REPORT_PATH, REFUSAL_LOG_PATH, assertCrossCall, assertGroupToolsSwitches, callRefuseEnabled, callRefuseNoToolEnabled, crossCallProblem, runInTool, trackCrossCall } from "../runtime/pi/groups.mjs";
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
delete process.env.NEWSROOM_GROUP_ENFORCE;
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
const keys = ["NEWSROOM_GROUP_ENFORCE", "NEWSROOM_GROUP_CALL_CHECK", "NEWSROOM_GROUP_CALL_REFUSE"];
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const setEnv = (e) => keys.forEach((k) => (e[k] === undefined ? delete process.env[k] : (process.env[k] = e[k])));
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
  for (const v of [undefined, "", "0", "true", "yes", " 1", "11"]) {
    setEnv({ NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "1", NEWSROOM_GROUP_CALL_REFUSE: v });
    assert.equal(callRefuseEnabled(), false, `value ${JSON.stringify(v)} is off`);
    assert.equal(runInTool(pinOff, () => assertCrossCall(rootR, "duckDbRun")), undefined, `value ${JSON.stringify(v)}: no refusal`);
  }
  assert.ok(!existsSync(join(rootR, REFUSAL_LOG_PATH)), "refuse off: nothing refused, nothing logged");
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
  for (const e of [{ NEWSROOM_GROUP_CALL_REFUSE: "1" }, { NEWSROOM_GROUP_CALL_REFUSE: "1", NEWSROOM_GROUP_ENFORCE: "1" }, { NEWSROOM_GROUP_CALL_REFUSE: "1", NEWSROOM_GROUP_CALL_CHECK: "1" }]) {
    setEnv(e);
    assert.throws(() => assertGroupToolsSwitches(), /GROUP_CALL_REFUSE_NEEDS_ENFORCE_AND_CHECK/, `chain: ${Object.keys(e).join("+")}`);
  }
  setEnv({ NEWSROOM_GROUP_CALL_REFUSE: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_CALL_CHECK: "1" });
  assertGroupToolsSwitches();
  setEnv({});
  assertGroupToolsSwitches();
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
const noToolKeys = ["NEWSROOM_GROUP_CALL_REFUSE_NOTOOL", "NEWSROOM_ARTIFACT_DIR"];
const savedNT = Object.fromEntries([...keys, ...noToolKeys].map((k) => [k, process.env[k]]));
const setAll = (e) => [...keys, ...noToolKeys].forEach((k) => (e[k] === undefined ? delete process.env[k] : (process.env[k] = e[k])));
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
  setAll({ ...base, NEWSROOM_GROUP_CALL_REFUSE: undefined, NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assert.equal(assertCrossCall(rootN, "queryDuckDb"), undefined, "NOTOOL without REFUSE: a tool-less call passes");
  // the chain: NOTOOL needs REFUSE
  setAll({ NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assert.throws(() => assertGroupToolsSwitches(), /GROUP_CALL_REFUSE_NOTOOL_NEEDS_REFUSE/);
  setAll({ ...base, NEWSROOM_GROUP_CALL_REFUSE_NOTOOL: "1" });
  assertGroupToolsSwitches();
} finally { setAll(savedNT); rmSync(rootN, { recursive: true, force: true }); }

console.log("group cross-call gate -- PASS");
