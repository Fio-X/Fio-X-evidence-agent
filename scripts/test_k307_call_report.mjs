#!/usr/bin/env node
// K307: NEWSROOM_GROUP_CALL_REPORT=1 records which tool group reaches which cross_calls function at run time (report only), and
// scripts/check_cross_call_report.mjs reconciles the record against groups.json. Checks: off writes nothing and rebinds nothing; a declared call is
// recorded as declared; an undeclared one and a call by a dynamically built function name are found; a gated function (assertCrossCall) is recorded;
// the record never throws into the call; the newsroom.ts rebind list equals the function declarations of cross_calls.functions; the checker's exit codes.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("k307-");
const list = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
const toolOf = (group) => Object.keys(list.tools).find((t) => list.tools[t].group === group);
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];

const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `const OPT="__optional";const mk=(b)=>(o={})=>({...b,...(o&&typeof o==="object"&&!Array.isArray(o)?o:{})});
export const Type={String:mk({type:"string"}),Number:mk({type:"number"}),Integer:mk({type:"integer"}),Boolean:mk({type:"boolean"}),Any:()=>({}),Null:()=>({type:"null"}),Unknown:()=>({}),Literal:(v)=>({const:v}),Optional:(s)=>({...s,[OPT]:true}),Array:(i,o={})=>({type:"array",items:i,...o}),Union:(a)=>({anyOf:a}),Record:()=>({type:"object"}),Object:(p={},o={})=>({type:"object",properties:p,required:Object.keys(p).filter((k)=>!p[k][OPT]),...o})};`;

const tree = join(scratch, "tree");
cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
stub(tree, "typebox", TYPEBOX);
stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const srcText = readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8");
// a probe that looks a function up by a name built at run time: the kind of call the static test cannot see
writeFileSync(join(tree, "runtime/pi/newsroom.ts"), `${srcText}\nexport const __probe = (name: string) => ({ stableId, clampInt, textResult, queryDuckDb } as any)[name];\n`);
const copy = join(tree, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const groups = await import(pathToFileURL(join(tree, "runtime/pi/groups.mjs")).href);

// load the module under a given switch value (the rebinding happens at load time)
let seq = 0;
const load = async (value) => {
  if (value === undefined) delete process.env.NEWSROOM_GROUP_CALL_REPORT; else process.env.NEWSROOM_GROUP_CALL_REPORT = value;
  const again = join(tree, `runtime/pi/newsroom.test-copy-${++seq}.mjs`);
  writeFileSync(again, readFileSync(copy, "utf8"));
  return import(pathToFileURL(again).href);
};
const newRun = (name) => { const dir = join(scratch, name); mkdirSync(dir, { recursive: true }); process.env.NEWSROOM_ARTIFACT_DIR = dir; return dir; };
const reportOf = (dir) => { const p = join(dir, "runtime/cross-call-report.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const checker = (target) => spawnSync(process.execPath, [join(ROOT, "scripts/check_cross_call_report.mjs"), target, "--groups", join(ROOT, "runtime/pi/groups.json")], { encoding: "utf8" });
const results = [];
const ok = (text) => results.push(text);
const visualTool = toolOf("visual"), systemTool = toolOf("system"), knowledgeTool = toolOf("knowledge");
assert.ok(list.cross_calls.functions.stableId.groups.includes("visual") && !list.cross_calls.functions.stableId.groups.includes("system"), "fixture: stableId is declared for visual, not system");

// 1. off (unset and any value but the exact "1"): nothing rebound, nothing written
for (const value of [undefined, "true", "0", "", " 1", "2"]) {
  const mod = await load(value);
  const dir = newRun(`off-${seq}`);
  assert.notEqual(mod.__probe("stableId").name, "tracked", `value ${JSON.stringify(value)}: the function is not wrapped`);
  groups.runInTool(systemTool, () => { try { mod.__probe("stableId")("x"); } catch { /* the call itself is not the point */ } });
  assert.deepEqual(reportOf(dir), [], `value ${JSON.stringify(value)}: nothing is written`);
  assert.ok(!existsSync(join(dir, "runtime")), "no runtime folder is created");
}
ok("off: any value but exact 1 rebinds nothing and writes nothing");

// 2. on: declared call is recorded as declared, undeclared and dynamically named calls are found
{
  process.env.NEWSROOM_GROUP_CALL_REPORT = "1";
  const mod = await load("1");
  const dir = newRun("on");
  assert.equal(mod.__probe("stableId").name, "tracked", "on: the function is wrapped");
  const before = mod.__probe("stableId")("x"); // no tool is asking: not recorded, same result
  assert.deepEqual(reportOf(dir), [], "a tool-less call (a command, the program) is not recorded");
  let declaredResult;
  groups.runInTool(visualTool, () => { declaredResult = mod.__probe("stableId")("x"); });
  assert.equal(declaredResult, before, "the reply is unchanged");
  groups.runInTool(visualTool, () => mod.__probe("stableId")("y")); // same pair again: one line only
  let rows = reportOf(dir);
  assert.deepEqual(rows.map((r) => [r.tool, r.tool_group, r.function, r.declared]), [[visualTool, "visual", "stableId", true]], "declared pair: one line, declared");
  assert.equal(checker(dir).status, 0, "checker: declared only -> exit 0");
  const dyn = ["stable", "Id"].join(""); // built at run time: no static name scan sees this
  groups.runInTool(systemTool, () => mod.__probe(dyn)("z"));
  groups.runInTool(systemTool, () => mod.__probe("clampInt")(5, 1, 9, 3));
  rows = reportOf(dir);
  assert.deepEqual(rows.filter((r) => r.declared === false).map((r) => [r.tool_group, r.function]), [["system", "stableId"], ["system", "clampInt"]], "undeclared pairs are recorded as such");
  const run = checker(dir);
  assert.equal(run.status, 1, "checker: an undeclared pair -> exit 1");
  assert.match(run.stdout, /UNDECLARED system -> stableId/);
  assert.match(run.stdout, /UNDECLARED system -> clampInt/);
  assert.ok(!/visual -> stableId/.test(run.stdout), "the declared pair is not listed");
  ok("on: a declared cross call is recorded (no finding); an undeclared one and a dynamic-name one are found; reply unchanged; repeat calls not repeated");

  // gated function: recorded through assertCrossCall (owner knowledge); a knowledge tool is declared
  await groups.runInTool(systemTool, async () => { try { await mod.__probe("queryDuckDb")("select 1", undefined, undefined); } catch { /* may fail for other reasons */ } });
  await groups.runInTool(knowledgeTool, async () => { try { await mod.__probe("queryDuckDb")("select 1", undefined, undefined); } catch { /* same */ } });
  rows = reportOf(dir).filter((r) => r.function === "queryDuckDb");
  assert.deepEqual(rows.map((r) => [r.tool_group, r.callee_owner, r.declared]), [["system", "knowledge", false], ["knowledge", "knowledge", true]], "gated entry: recorded, owner knowledge");
  assert.equal(groups.crossCallReportEnabled(), true);
  ok("on: a gated knowledge entry function is recorded through assertCrossCall; a knowledge caller is declared");
}

// 3. the record never fails a call: an unwritable report path is swallowed
{
  const mod = await load("1");
  const dir = newRun("blocked");
  writeFileSync(join(dir, "runtime"), "a file where the folder must go"); // mkdir fails
  let result;
  groups.runInTool(systemTool, () => { result = mod.__probe("stableId")("q"); });
  assert.equal(typeof result, "string", "the call still returns its reply");
  ok("on: a failing record write never reaches the call");
}

// 4. the rebind list in newsroom.ts equals the function declarations of cross_calls.functions that are not gated
{
  const block = srcText.slice(srcText.indexOf("if (crossCallReportEnabled()) {"));
  const listed = [...block.slice(0, block.indexOf("\n}\n")).matchAll(/^ {2}(\w+) = trackCrossCall\("(\w+)", \1, rootBeforeRebind\);$/gm)].map((m) => m[1]);
  const expected = Object.keys(list.cross_calls.functions).filter((n) => new RegExp(`^(async\\s+)?function\\*?\\s+${n}\\b`, "m").test(srcText) && !list.cross_calls.gated.includes(n));
  assert.deepEqual([...listed].sort(), [...expected].sort(), "rebind list = non-gated function declarations of cross_calls.functions");
  assert.ok(listed.length > 60);
  ok(`the rebind list covers all ${listed.length} non-gated function declarations; the rest (const) are listed as not traced in the report`);
}

// 5. checker exit codes
{
  assert.equal(checker(join(scratch, "no-such-run")).status, 2, "unreadable report -> exit 2");
  const bad = join(scratch, "bad.jsonl"); writeFileSync(bad, "not json\n");
  assert.equal(checker(bad).status, 2, "a damaged line -> exit 2");
  const odd = join(scratch, "odd.jsonl"); writeFileSync(odd, JSON.stringify({ tool: visualTool, function: "noSuchFunction" }) + "\n" + JSON.stringify({ tool: "no_such_tool", function: "stableId" }) + "\n");
  const run = checker(odd);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /not in cross_calls/); assert.match(run.stdout, /no group in groups.json/);
  ok("checker: exit 2 for an unreadable or damaged report, 1 for unknown function/tool");
}

rmSync(scratch, { recursive: true, force: true });
console.log(results.map((r) => `ok - ${r}`).join("\n"));
