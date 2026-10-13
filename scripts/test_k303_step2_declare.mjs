#!/usr/bin/env node
// K303 step 2: NEWSROOM_FIRST_TRY_DECLARE=1 (exact "1", default off) adds, to an EDITORIAL_GRAMMAR_BLOCKED for a chart that fits no relation, which declarations go with which reader_task. Off: unchanged.
// Run: node scripts/test_k303_step2_declare.mjs
import { makeTestTmp } from "./tmp_helper.mjs";
import { withoutRunTraces } from "./lib_run_traces.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}),
  Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }),
  Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};
`;
// One copy of runtime/ and config/ with the two Pi packages stubbed. Importing the test copy
// with a different query string gives a fresh newsroom.ts instance (fresh module-level state).
const treeDir = makeTestTmp("fast-fail-tree-");
cpSync(join(ROOT, "runtime"), join(treeDir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(treeDir, "config"), { recursive: true });
stub(treeDir, "typebox", TYPEBOX);
stub(treeDir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const testCopy = join(treeDir, "runtime", "pi", "newsroom.test-copy.mjs");
writeFileSync(testCopy, stripTypeScriptTypes(readFileSync(join(treeDir, "runtime", "pi", "newsroom.ts"), "utf8"), { mode: "strip" }));
let instance = 0;
async function freshTools(extraEnv = {}) {
  const mod = await import(`${pathToFileURL(testCopy).href}?instance=${++instance}`);
  const env = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_HIDE_LIEFLAT: undefined, NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_MOBILE_PAGES: undefined, ...extraEnv };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const artifact = join(makeTestTmp("k303-declare-"), "run");
mkdirSync(artifact, { recursive: true });
const SWITCH = "NEWSROOM_FIRST_TRY_DECLARE";
const blockFor = async (relation, chart, on) => {
  const tools = await freshTools({ NEWSROOM_ARTIFACT_DIR: artifact, [SWITCH]: on });
  const plan = tools.get("newsroom_viz_plan");
  const params = {
    sql: "select 'A' as category, 1 as value", chart_type: chart, reader_task: "comparison", title: "Exports by partner", takeaway: "A leads.",
    category_field: "category", value_field: "value",
    measure_semantics: [{ id: "m1", phenomenon: "exports", unit: "USD", measure_kind: "level" }],
    claim_spec: { relation, reader_task: "comparison", target_measure: "m1" },
  };
  try { await plan.execute("id", params); } catch (error) { return error.message; }
  return null;
};
const LEGACY_NONE = "EDITORIAL_GRAMMAR_BLOCKED: relation 'rank' requires one of horizontal_bar, dot; got 'treemap'; treemap fits: no relation in the strict grammar";
const LEGACY_SOME = "EDITORIAL_GRAMMAR_BLOCKED: relation 'rank' requires one of horizontal_bar, dot; got 'small_multiples'; small_multiples fits: comparison, trend, anomaly";
for (const off of [undefined, "0", "true", " 1"]) {
  ok(await blockFor("rank", "treemap", off) === LEGACY_NONE, `off (${JSON.stringify(off)}): treemap refusal byte for byte`);
  ok(await blockFor("rank", "small_multiples", off) === LEGACY_SOME, `off (${JSON.stringify(off)}): small_multiples refusal byte for byte`);
}
const on = await blockFor("rank", "treemap", "1");
ok(on.startsWith(LEGACY_NONE), "on: the legacy refusal comes first, unchanged");
ok(/Your reader_task 'comparison' takes both declarations: measure_semantics \(id, phenomenon, unit, measure_kind\) and claim_spec \(relation, reader_task, target_measure\)/.test(on), "on: names the declarations the chosen reader_task takes");
ok(/without claim_spec is refused/.test(on), "on: states the pairing rule");
// the hint never teaches a way around the declaration check by switching task
ok(!/sequence|neither|outside|instead|switch|change (the )?reader_task|another reader_task|different reader_task|for example/i.test(on.slice(LEGACY_NONE.length)), "on: no 'pick another task to skip the declarations' wording");
ok(await blockFor("rank", "small_multiples", "1") === LEGACY_SOME, "on: a chart that fits some relation keeps the legacy text exactly");
// K308 items 1-2: heatmap / diverging_bar notes, same switch, text only
{
  const HM = "EDITORIAL_GRAMMAR_BLOCKED: relation 'trend' requires one of line, multi_line, small_multiples; got 'heatmap'; heatmap fits: no relation in the strict grammar";
  const DV = "EDITORIAL_GRAMMAR_BLOCKED: relation 'rank' requires one of horizontal_bar, dot; got 'diverging_bar'; diverging_bar fits: anomaly";
  for (const off of [undefined, "0", "true", " 1"]) {
    ok(await blockFor("trend", "heatmap", off) === HM, `off (${JSON.stringify(off)}): heatmap refusal byte for byte`);
    ok(await blockFor("rank", "diverging_bar", off) === DV, `off (${JSON.stringify(off)}): diverging_bar refusal byte for byte`);
  }
  const hm = await blockFor("trend", "heatmap", "1");
  ok(hm.startsWith(HM), "on: heatmap legacy text first");
  ok(/accepted under relation 'distribution' only/.test(hm) && /trend needs line, multi_line or small_multiples/.test(hm) && /change needs dumbbell or slope/.test(hm), "on: heatmap note names distribution and what trend/change need");
  const dv = await blockFor("rank", "diverging_bar", "1");
  ok(dv.startsWith(DV), "on: diverging_bar legacy text first");
  ok(/horizontal_bar under relation 'rank', or diverging_bar under relation 'anomaly'/.test(dv), "on: diverging_bar note");
  ok(!/EDITORIAL_GRAMMAR_BLOCKED/.test(String(await blockFor("anomaly", "diverging_bar", "1"))), "on: grammar still accepts diverging_bar under anomaly (table unchanged)");
  ok(await blockFor("change", "heatmap", "1") !== null && await blockFor("trend", "heatmap", "1") !== null, "on: heatmap still refused under change/trend");
}
// the rule the text quotes is the live one
const srcText = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
ok(/SEMANTIC_REQUIRED_READER_TASKS = new Set\(\["ranking", "comparison", "change", "distribution", "correlation", "part_to_whole"\]\)/.test(srcText), "the six reader_tasks quoted are the ones in force");
console.log(`K303 step 2 declare: PASS (${checks} checks)`);
