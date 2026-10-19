// NEWSROOM_SPEED_REFS_BLOCK2 (default off): what the switch changes in the tool definitions, in every tool profile.
//  - off, or any value other than exactly "1": every definition is byte-identical (test_tool_defs_unchanged.mjs pins them to the base golden);
//  - on: only newsroom_infographic_vision_critic and newsroom_publication_qa differ, each by exactly one appended guideline and the dropped `required` names;
//  - newsroom_publication_plan is byte-identical on and off, also with its own copy switch on (row 8 is not part of this block).
// Offline; the same typebox stand-in and type-stripped tree as test_tool_defs_unchanged.mjs.
import assert from "node:assert/strict";
import { makeTestTmp } from "./tmp_helper.mjs";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SWITCH = "NEWSROOM_SPEED_REFS_BLOCK2";
const PROFILES = ["investigate", "visual", "publication", "visual-story", "competition", "full"];
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
const TREE = makeTestTmp("refs-block2-defs-");
cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
stub(TREE, "typebox", TYPEBOX);
stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));

const KEYS = ["name", "label", "description", "promptSnippet", "promptGuidelines", "parameters"];
const SWITCHES = [SWITCH, "NEWSROOM_SPEED_FILL_PUBLICATION_COPIED", "NEWSROOM_PHASE", "NEWSROOM_LEAN_GATES"];
let n = 0;
const defs = async (profile, env) => {
  for (const k of SWITCHES) delete process.env[k];
  process.env.NEWSROOM_TOOL_PROFILE = profile;
  Object.assign(process.env, env);
  const out = {};
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++n}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => { out[tool.name] = JSON.parse(JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, tool[k] ?? null])))); } : () => {}) }));
  for (const k of SWITCHES) delete process.env[k];
  return out;
};

const VISION = { name: "newsroom_infographic_vision_critic", dropped: ["preview_ref", "deterministic_critic_ref"], bytes: 207, guideline: "deterministic_critic_ref and preview_ref may be omitted when exactly one deterministic critic and one preview are bound to manifest_ref; the runtime copies them verbatim and never overrides a value you give." };
const QA = { name: "newsroom_publication_qa", dropped: ["plan_ref"], bytes: 148, guideline: "plan_ref may be omitted; the runtime reads it from the plan_ref recorded in the manifest named by manifest_ref and never overrides a value you give." };
for (const { guideline, bytes } of [VISION, QA]) assert.equal(Buffer.byteLength(guideline, "utf8"), bytes, "the model-visible sentence has the signed size");

const seen = new Set();
for (const profile of PROFILES) {
  const off = await defs(profile, {});
  for (const value of ["0", "", "true", "on", "2"]) assert.deepEqual(await defs(profile, { [SWITCH]: value }), off, `${profile}: ${SWITCH}=${JSON.stringify(value)} is not exactly "1": nothing changes`);
  const on = await defs(profile, { [SWITCH]: "1" });
  assert.deepEqual(Object.keys(on), Object.keys(off), `${profile}: the same tools are offered`);
  for (const name of Object.keys(off)) {
    const spec = [VISION, QA].find((t) => t.name === name);
    if (!spec) { assert.deepEqual(on[name], off[name], `${profile} ${name}: untouched with the switch on`); continue; }
    seen.add(name);
    const a = off[name], b = on[name];
    assert.deepEqual(b.promptGuidelines, [...(a.promptGuidelines ?? []), spec.guideline], `${profile} ${name}: exactly one guideline appended after the existing ones`);
    assert.deepEqual(a.parameters.required.filter((k) => !b.parameters.required.includes(k)), spec.dropped, `${profile} ${name}: exactly these names stop being required`);
    assert.deepEqual(b.parameters.required, a.parameters.required.filter((k) => !spec.dropped.includes(k)), `${profile} ${name}: nothing else is dropped or reordered`);
    const strip = (d) => ({ ...d, promptGuidelines: null, parameters: { ...d.parameters, required: null, properties: Object.fromEntries(Object.entries(d.parameters.properties).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => f !== "__optional"))])) } });
    assert.deepEqual(strip(b), strip(a), `${profile} ${name}: label, description, snippet and every property schema are the same`);
  }
  // row 8 is not in this block: the publication plan is identical on and off, also with its own copy switch on (and that switch's sentence is the only guideline it adds)
  if (off.newsroom_publication_plan) {
    for (const extra of [{}, { NEWSROOM_SPEED_FILL_PUBLICATION_COPIED: "1" }]) {
      const a = (await defs(profile, extra)).newsroom_publication_plan, b = (await defs(profile, { ...extra, [SWITCH]: "1" })).newsroom_publication_plan;
      assert.equal(JSON.stringify(b), JSON.stringify(a), `${profile}: newsroom_publication_plan is byte-identical with the switch on and off (${Object.keys(extra).length ? "its copy switch on" : "its copy switch off"})`);
    }
  }
}
assert.deepEqual([...seen].sort(), [QA.name, VISION.name].sort(), "both tools were exercised in some profile");
console.log("refs block 2 tool definitions: off and non-\"1\" values identical; on changes only vision_critic and publication_qa by one guideline and the dropped required names; publication_plan identical -- PASS");
