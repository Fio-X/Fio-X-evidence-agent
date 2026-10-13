#!/usr/bin/env node
// K255: the infographic plan tool's modules limit. Off: maxItems 12 as before. NEWSROOM_STORYBOARD=1: STORYBOARD_MODULE_CAP (24), so a storyboard page of
// 5 to 8 panels (15 to 24 modules) is not refused by the tool-parameter check before validateInfographicSpec sees it.
// Run: node scripts/test_storyboard_module_cap.mjs   (a child process per switch state; the tool list is read from a type-stripped copy of newsroom.ts)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2];
if (!mode) {
  let out = "";
  for (const on of [false, true]) {
    const env = { ...process.env, NEWSROOM_TOOL_PROFILE: "full" };
    delete env.NEWSROOM_STORYBOARD;
    if (on) env.NEWSROOM_STORYBOARD = "1";
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), on ? "on" : "off"], { env, encoding: "utf8" });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    assert.equal(r.status, 0, `${on ? "on" : "off"} half failed`);
  }
  console.log("storyboard module cap PASS");
  process.exit(0);
}
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };

const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
// plain-JSON typebox stand-in: keeps every option given (same as test_tool_defs_unchanged.mjs)
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = {
  String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};`;
const TREE = makeTestTmp("storyboard-cap-tree-");
cpSync(join(HERE, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(HERE, "config"), join(TREE, "config"), { recursive: true });
stub(TREE, "typebox", TYPEBOX);
stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const tools = {};
const mod = await import(pathToFileURL(COPY).href);
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => { tools[tool.name] = tool; } : () => {}) }));
const modulesSchema = tools.newsroom_infographic_plan?.parameters?.properties?.modules;
ok(modulesSchema?.type === "array" && modulesSchema.minItems === 3, "the plan tool has a modules array");

const R = join(HERE, "runtime/pi/");
const { validateInfographicSpec } = await import(R + "infographic.mjs");
const sb = await import(R + "storyboard.mjs");
const KINDS = ["lead_in", "scale", "cause", "space", "compare", "basis", "lead_in", "scale"];
const board = (panels) => {
  const modules = [];
  for (let i = 0; i < panels; i++) {
    const n = i + 1;
    modules.push({ id: `p${n}`, type: "panel", panel_no: n, panel_kind: KINDS[i % KINDS.length], heading: "这一格只说一件事", body_module_id: `b${n}`, note_module_id: `n${n}`, story_node_ids: [`s${n}`], color_use: ["#d0746f", "ink"] });
    modules.push({ id: `b${n}`, type: i === 0 ? "hero_stat" : "visual", story_node_ids: [`s${n}`], manifest_ref: `m${n}`, visual_grammar: "trend", value: 1, label: "x", claim_id: "c1" });
    modules.push({ id: `n${n}`, type: "text", story_node_ids: [`s${n}`], body: "短注", claim_ids: ["c1"] });
  }
  return { schema_version: "1.5.0", language: "zh", color_legend: [{ color: "#d0746f", meaning_id: "synthetic" }], modules };
};
const capErrors = (spec) => validateInfographicSpec(spec).filter((e) => /cannot exceed/.test(e));

if (mode === "off") {
  ok(modulesSchema.maxItems === 12, `off: modules maxItems stays 12 (got ${modulesSchema.maxItems})`);
  ok(sb.storyboardEnabled() === false, "off: storyboard switch is off");
} else {
  ok(sb.storyboardEnabled() === true, "on: storyboard switch is on");
  ok(modulesSchema.maxItems === sb.STORYBOARD_MODULE_CAP && sb.STORYBOARD_MODULE_CAP === 24, `on: modules maxItems is STORYBOARD_MODULE_CAP (got ${modulesSchema.maxItems})`);
  for (const panels of [5, 6, 8]) {
    const spec = board(panels);
    ok(spec.modules.length <= modulesSchema.maxItems, `on: a ${panels}-panel page (${spec.modules.length} modules) is inside the tool limit`);
    ok(capErrors(spec).length === 0, `on: a ${panels}-panel page has no module-count error from validateInfographicSpec`);
  }
  const six = board(6);
  ok(six.modules.length === 18 && six.modules.length <= modulesSchema.maxItems && capErrors(six).length === 0, "on: the 18-module page passes the cap checks");
  ok(board(9).modules.length > modulesSchema.maxItems && capErrors(board(9)).length > 0, "on: 9 panels (27 modules) is still refused by both");
}
console.log(`storyboard module cap (${mode}) PASS checks=${checks}`);
