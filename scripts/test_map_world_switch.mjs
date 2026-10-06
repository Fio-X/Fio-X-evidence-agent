#!/usr/bin/env node
// World mode (map_extent) is behind NEWSROOM_MAP_WORLD, off by default; only the exact string "1" turns it on.
//   off: map_extent is absent from the plan and chain tool definitions (schema, description, snippet and guidelines),
//        and validate and lint refuse any spec that sets it with MAP_EXTENT_DISABLED;
//   on:  the field is in both schemas and the spec is accepted as before.
// Runs the real newsroom.ts (type-stripped). No provider, relay or network call.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { lintVizSpec, validateVizSpec } = await import(join(ROOT, "runtime/pi/viz.mjs"));
// ---- temp dirs: removed when the process exits (KEEP_TMP=1 keeps them for debugging) ------------------------------------
const TEMP_DIRS = [];
const tempDir = (label) => { const dir = mkdtempSync(join(tmpdir(), `editorial-hints-${label}-`)); TEMP_DIRS.push(dir); return dir; };
process.on("exit", () => { if (process.env.KEEP_TMP !== "1") for (const dir of TEMP_DIRS) { try { rmSync(dir, { recursive: true, force: true }); } catch {} } });

// ---- loader: one type-stripped copy of the runtime per newsroom.ts source -------------------------------------------
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
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};`;
// Every variant gets its own copy of the code (runtime/pi/*.mjs, so no module instance is shared between variants). The big
// read-only data (the skill bundle, vendored libraries, images, web assets: about 36 of the 39 MB) is linked, not copied.
const LINKED_IN_PI = new Set(["visual_skill_bundle.mjs", "vendor", "assets"]);
const loadTree = (label, source) => {
  const dir = tempDir(`tree-${label}`);
  mkdirSync(join(dir, "runtime/pi"), { recursive: true });
  for (const entry of readdirSync(join(ROOT, "runtime"))) if (entry !== "pi") symlinkSync(join(ROOT, "runtime", entry), join(dir, "runtime", entry));
  for (const entry of readdirSync(join(ROOT, "runtime/pi"))) {
    const [from, to] = [join(ROOT, "runtime/pi", entry), join(dir, "runtime/pi", entry)];
    if (LINKED_IN_PI.has(entry)) symlinkSync(from, to); else cpSync(from, to, { recursive: true });
  }
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const copy = join(dir, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(copy, stripTypeScriptTypes(source ?? readFileSync(join(dir, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  return import(copy);
};

const mod = await loadTree("main");
const SWITCH = "NEWSROOM_MAP_WORLD";
const register = (value) => {
  if (value === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = value;
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  process.env.NEWSROOM_SPEED_CHAIN_VIZ = "1"; // the chain tool exists only with these two switches
  process.env.NEWSROOM_SPEED_ATOMIC_ARTIFACT = "1";
  delete process.env.NEWSROOM_PHASE;
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
};
const WHERE = ["newsroom_viz_plan", "newsroom_viz_chain"];
const spec = {
  schema_version: "0.9.0", takeaway: "t", title: "World", subtitle: "synthetic", alt: "A synthetic world map used to check the world-mode switch.",
  source_note: "synthetic fixture", claim_id: "claim-world", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, language: "zh",
  verification_mode: "draft", reader_task: "spatial", chart_type: "choropleth", category_field: "c", value_field: "v", category_names: "iso3", unit: "%",
};
const refusals = (s) => [...validateVizSpec(s), ...lintVizSpec(s, [{ c: "USA", v: 1 }], {}).blockers].filter((m) => m.startsWith("MAP_EXTENT_DISABLED"));

// off: unset, and every value that is not exactly "1"
for (const value of [undefined, "", "0", "true", "yes", "on", " 1", "1 ", "11"]) {
  const tools = register(value);
  for (const name of WHERE) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} registered`);
    assert.ok(!("map_extent" in tool.parameters.properties), `${name}: no map_extent in the schema (${JSON.stringify(value)})`);
    assert.ok(!JSON.stringify({ d: tool.description, s: tool.promptSnippet, g: tool.promptGuidelines, p: tool.parameters }).includes("map_extent"), `${name}: map_extent appears nowhere in the definition (${JSON.stringify(value)})`);
  }
  if (value === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = value;
  assert.equal(refusals({ ...spec, map_extent: "world" }).length >= 2, true, `validate and lint refuse map_extent (${JSON.stringify(value)})`);
  const found = validateVizSpec({ ...spec, map_extent: "world" }).find((m) => m.startsWith("MAP_EXTENT_DISABLED"));
  assert.match(found, /default map/);
  assert.match(found, /ranked bar/);
  assert.equal(validateVizSpec({ ...spec, chart_type: "horizontal_bar", map_extent: "world" }).filter((m) => m.startsWith("MAP_EXTENT_DISABLED")).length, 1, "refused on any chart type");
  assert.deepEqual(refusals(spec), [], "a spec without map_extent is untouched");
}
// on: exactly "1"
{
  const tools = register("1");
  for (const name of WHERE) {
    const field = tools.get(name).parameters.properties.map_extent;
    assert.ok(field, `${name}: map_extent present with the switch on`);
    assert.deepEqual(field.enum, ["world"]);
  }
  assert.deepEqual(refusals({ ...spec, map_extent: "world" }), [], "accepted with the switch on");
  assert.ok(validateVizSpec({ ...spec, map_extent: "flat" }).some((m) => m.includes("map_extent must be 'world'")), "the value check still applies");
}
delete process.env[SWITCH];
console.log("map world switch: all checks passed");
