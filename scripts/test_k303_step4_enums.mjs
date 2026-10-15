#!/usr/bin/env node
// K303 step 4: NEWSROOM_FIRST_TRY_ENUMS=1 (exact "1", default off) puts the allowed words of four enums in their descriptions. Off: the tool schemas are byte-identical.
// Run: node scripts/test_k303_step4_enums.mjs
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
  const env = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, ...extraEnv };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const SWITCH = "NEWSROOM_FIRST_TRY_ENUMS";
const schemaOf = async (on) => {
  const tools = await freshTools({ [SWITCH]: on });
  return new Map([...tools].map(([name, tool]) => [name, JSON.stringify(tool.parameters)]));
};
const base = await schemaOf(undefined);
for (const off of ["0", "true", " 1"]) {
  const other = await schemaOf(off);
  ok([...base].every(([name, text]) => other.get(name) === text) && base.size === other.size, `off (${JSON.stringify(off)}): every tool schema is byte-identical`);
}
const on = await schemaOf("1");
ok(on.size === base.size, "on: the same tools");
const changed = [...base].filter(([name, text]) => on.get(name) !== text).map(([name]) => name).sort();
ok(changed.length > 0 && changed.includes("newsroom_viz_plan"), `on: the tools that carry these fields change: ${changed}`);
// removing the descriptions from the on schemas gives back the off schemas: nothing but descriptions changed
const strip = (t) => t.replace(/,"description":"Exactly one of: [^"]*"/g, "").replace(/"description":"Exactly one of: [^"]*",/g, "");
for (const [name, text] of base) ok(strip(on.get(name)) === text, `on: ${name} differs from off only by the added descriptions`);
const viz = on.get("newsroom_viz_plan");
ok(viz.includes("Exactly one of: point_in_time, period, annual_average, rolling, structural, cumulative, timeless."), "on: temporal_basis.type lists its words");
const formTools = await freshTools({ [SWITCH]: "1", NEWSROOM_FORM_SKILL: "1" });
const formOff = await freshTools({ [SWITCH]: undefined, NEWSROOM_FORM_SKILL: "1" });
const formViz = JSON.stringify(formTools.get("newsroom_viz_plan").parameters);
ok(!JSON.stringify(formOff.get("newsroom_viz_plan").parameters).includes("Exactly one of: comparison"), "off: no class words");
ok(formViz.includes("Exactly one of: comparison, ranking, change, distribution, composition, relation, space, flow, big_number, table, one_sentence, diagram, vs_block."), "on: candidates class lists its words");
ok(viz.includes("Exactly one of: observed, estimate, forecast, target, capacity, scenario, modeled, reference."), "on: observation_status lists its words");
ok([...on.values()].some((t) => t.includes("Exactly one of: blocker, warning, nit.")), "on: severity lists its words");
console.log(`K303 step 4 enums: PASS (${checks} checks)`);
