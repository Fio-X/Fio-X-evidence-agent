#!/usr/bin/env node
// K321: cross_calls.tool_allow is the per-tool list for queryDuckDb, recordClaimArtifact, validateSourceEvidence and replayComputationEvidence (today's static closure,
// shrink only). Checks: the real table is green; a call added from another visual tool is red (mutation proof on the real newsroom.ts); a list entry that no longer
// holds is stale; --write-baseline logic refuses additions and drops stale tools; the run-time record carries tool_allowed only for these functions and only with
// NEWSROOM_GROUP_CALL_REPORT on by default (off = "0" writes nothing; other lines are byte-identical to before); the checker recomputes it and exits 1 on a tool outside the list.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
const scratch = makeTestTmp("k321-");
const groupsJson = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
const known = groupsJson.cross_calls;
const NAMES = ["queryDuckDb", "queryDuckDbShadowRead", "recordClaimArtifact", "replayComputationEvidence", "validateSourceEvidence"]; // K335 added queryDuckDbShadowRead
const { analyze, compareToolAllow, shrinkBaseline } = await import(pathToFileURL(join(ROOT, "scripts/test_group_cross_calls.mjs")).href);
const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const readModule = (spec) => {
  const base = join(ROOT, "runtime/pi", spec);
  for (const candidate of [base, base.replace(/\.js$/, ".mjs"), base.replace(/\.js$/, ".ts")]) if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  return null;
};
const run = (text) => analyze({ src: text, groupsJson, readModule });

// 1. the table: exactly these four functions, each with a why and a non-empty list of real tools that are not knowledge tools
assert.deepEqual(Object.keys(known.tool_allow).sort(), NAMES, "tool_allow lists exactly the four class-C functions and the K335 shadow read");
for (const name of NAMES) {
  const row = known.tool_allow[name];
  assert.ok(known.functions[name], `${name} is a cross_calls function`);
  assert.match(row.why, name === "queryDuckDbShadowRead" ? /^K335 10-13 baseline = static closure today; shrink only/ : /^K321 10-13 baseline = static closure today; shrink only(\. K322 10-13: .+)?$/, `${name} says why`);
  assert.ok(row.tools.length > 0 && row.tools.every((t) => groupsJson.tools[t] && groupsJson.tools[t].group !== "knowledge"), `${name}: every listed tool exists and is outside the knowledge group`);
  assert.deepEqual([...row.tools].sort(), row.tools, `${name}: the list is sorted`);
}
const current = run(src);
assert.deepEqual(current.problems, [], "every tool is recognised");
assert.deepEqual(compareToolAllow(current, known), [], "the real table is green");
console.log("table -- PASS");

// 2. mutation proof: a visual tool outside the list gets a call to each function -> red, and only for that tool
const outsider = Object.keys(groupsJson.tools).find((t) => groupsJson.tools[t].group === "visual" && NAMES.every((n) => !known.tool_allow[n].tools.includes(t)) && new RegExp(`name: "${t}"`).test(src));
assert.ok(outsider, "fixture: a visual tool that is on no list");
const at = src.indexOf(`name: "${outsider}"`);
const exec = src.indexOf("async execute(", at);
const open = src.indexOf("{", src.indexOf(")", exec));
for (const name of NAMES) {
  const call = name === "queryDuckDb" ? 'await queryDuckDb("select 1");' : name === "recordClaimArtifact" ? "await recordClaimArtifact({});" : `await ${name}([]);`;
  const mutated = run(`${src.slice(0, open + 1)}\n      ${call}${src.slice(open + 1)}`);
  const red = compareToolAllow(mutated, known);
  assert.ok(red.some((m) => m.startsWith(`NEW tool reaches ${name}: ${outsider} (visual)`)), `${name} called from ${outsider} is red: ${red.slice(0, 3)}`);
  assert.ok(red.every((m) => !/tool_allow\.\w+: .* no longer/.test(m)), "nothing else turns stale");
}
console.log("mutation (extra tool) -- PASS");

// 3. the list may only shrink: a listed tool that stopped reaching the function is stale; the baseline writer drops it but never adds
const withGhost = { ...known, tool_allow: { ...known.tool_allow, queryDuckDb: { ...known.tool_allow.queryDuckDb, tools: [...known.tool_allow.queryDuckDb.tools, outsider] } } };
assert.ok(compareToolAllow(current, withGhost).some((m) => m.startsWith(`STALE tool_allow.queryDuckDb: ${outsider} no longer reaches it`)), "a listed tool that does not reach the function is stale");
const shrunk = shrinkBaseline(current, withGhost);
assert.ok(!shrunk.tool_allow.queryDuckDb.tools.includes(outsider), "--write-baseline drops it");
assert.deepEqual(shrunk.tool_allow.recordClaimArtifact, known.tool_allow.recordClaimArtifact, "the others stay as they are");
const dropped = { ...known, tool_allow: { ...known.tool_allow, queryDuckDb: { ...known.tool_allow.queryDuckDb, tools: known.tool_allow.queryDuckDb.tools.slice(1) } } };
assert.ok(compareToolAllow(current, dropped).some((m) => m.startsWith("NEW tool reaches queryDuckDb")), "a tool missing from the list is red");
assert.throws(() => shrinkBaseline(current, dropped), /only get shorter/, "--write-baseline refuses to add a tool to the list");
console.log("shrink only -- PASS");

// 4. run-time record (groups.mjs noteCrossCall) and the checker
const groups = await import(pathToFileURL(join(ROOT, "runtime/pi/groups.mjs")).href);
const visualListed = known.tool_allow.queryDuckDb.tools.find((t) => groupsJson.tools[t].group === "visual");
const knowledgeTool = Object.keys(groupsJson.tools).find((t) => groupsJson.tools[t].group === "knowledge");
const newRun = (name) => { const dir = join(scratch, name); mkdirSync(dir, { recursive: true }); process.env.NEWSROOM_ARTIFACT_DIR = dir; return dir; };
const rowsOf = (dir) => { const p = join(dir, "runtime/cross-call-report.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []; };
const note = (tool, name) => groups.runInTool(tool, () => groups.noteCrossCall(process.env.NEWSROOM_ARTIFACT_DIR, name));

// #64 step 1: the call report is on unless exactly "0"
process.env.NEWSROOM_GROUP_CALL_REPORT = "0";
let dir = newRun("off");
note(outsider, "queryDuckDb");
assert.deepEqual(rowsOf(dir), [], 'off ("0"): nothing is written');
for (const value of [undefined, "true", "", " 0", "00"]) {
  if (value === undefined) delete process.env.NEWSROOM_GROUP_CALL_REPORT; else process.env.NEWSROOM_GROUP_CALL_REPORT = value;
  dir = newRun(`on-${String(value).length}-${value}`);
  note(outsider, "queryDuckDb");
  assert.equal(rowsOf(dir).length, 1, `value ${JSON.stringify(value)}: the default is on, the call is written`);
}

process.env.NEWSROOM_GROUP_CALL_REPORT = "1";
dir = newRun("on");
note(visualListed, "queryDuckDb");
note(outsider, "queryDuckDb");
note(outsider, "recordClaimArtifact");
note(knowledgeTool, "queryDuckDb");
note(outsider, "stableId");
const rows = rowsOf(dir).map((l) => JSON.parse(l));
const pick = (tool, fn) => rows.find((r) => r.tool === tool && r.function === fn);
assert.equal(pick(visualListed, "queryDuckDb").tool_allowed, true, "a listed tool: true");
assert.equal(pick(outsider, "queryDuckDb").tool_allowed, false, "a tool outside the list: false");
assert.equal(pick(outsider, "recordClaimArtifact").tool_allowed, false, "recordClaimArtifact: false for the same tool");
assert.equal(pick(knowledgeTool, "queryDuckDb").tool_allowed, true, "the owning group is unaffected: true");
const plain = rowsOf(dir).find((l) => l.includes('"function":"stableId"'));
assert.equal(plain, JSON.stringify({ tool: outsider, tool_group: "visual", function: "stableId", callee_owner: null, declared: true }), "a function without a list: the line is exactly the old shape, byte for byte");
assert.deepEqual(Object.keys(pick(outsider, "queryDuckDb")), ["tool", "tool_group", "function", "callee_owner", "declared", "tool_allowed"], "the new field comes last");

const checker = (target) => spawnSync(process.execPath, [join(ROOT, "scripts/check_cross_call_report.mjs"), target, "--groups", join(ROOT, "runtime/pi/groups.json")], { encoding: "utf8" });
let result = checker(dir);
assert.equal(result.status, 1, "the checker fails on a tool outside the list");
assert.match(result.stdout, new RegExp(`NOT ALLOWED visual ${outsider} -> queryDuckDb`), "and names the tool and the function");
assert.match(result.stdout, new RegExp(`NOT ALLOWED visual ${outsider} -> recordClaimArtifact`));
assert.doesNotMatch(result.stdout, new RegExp(`NOT ALLOWED \\w+ ${visualListed} `), "a listed tool is not named");
assert.doesNotMatch(result.stdout, /NOT ALLOWED \w+ \w+ -> stableId/, "a function without a list is not judged");
// the written field is not trusted: a line that says tool_allowed true for an outside tool is still found
const forged = newRun("forged");
mkdirSync(join(forged, "runtime"), { recursive: true });
writeFileSync(join(forged, "runtime/cross-call-report.jsonl"), JSON.stringify({ tool: outsider, tool_group: "visual", function: "queryDuckDb", callee_owner: "knowledge", declared: true, tool_allowed: true }) + "\n");
assert.equal(checker(forged).status, 1, "a forged tool_allowed true does not help");
const clean = newRun("clean");
mkdirSync(join(clean, "runtime"), { recursive: true });
writeFileSync(join(clean, "runtime/cross-call-report.jsonl"), JSON.stringify({ tool: visualListed, tool_group: "visual", function: "queryDuckDb", callee_owner: "knowledge", declared: true, tool_allowed: true }) + "\n");
result = checker(clean);
assert.equal(result.status, 0, `a listed tool is green: ${result.stdout}`);
assert.match(result.stdout, /1 record\(s\), 0 undeclared pair\(s\), 0 tool-not-allowed pair\(s\)/);
console.log("run-time record and checker -- PASS");
console.log("K321 tool_allow -- PASS");
