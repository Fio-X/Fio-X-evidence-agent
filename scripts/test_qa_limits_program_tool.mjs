#!/usr/bin/env node
// NEWSROOM_QA_LIMITS_PROGRAM (on unless exactly "0") through the REAL newsroom_publication_plan tool (a type-stripped copy of newsroom.ts):
// on, the tool has no breakpoints, max_initial_bytes or max_ready_ms parameter, its guideline says the program sets them, and a call that still
// passes one is refused with a message that names the field (checked before anything is read, so the call needs no run folder);
// at "0", the old schema is back and the same call is not refused for that reason. Needs no provider and no duckdb.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const tree = mkdtempSync(join(tmpdir(), "qa-limits-tool-"));
cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
stub(tree, "typebox", `const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`);
stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const copy = join(tree, "runtime", "pi", "newsroom.test-copy.mjs");
writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(copy);
const { validationFailure } = await import(join(tree, "runtime", "pi", "tool_host_schema.mjs"));


const FIELDS = ["breakpoints", "max_initial_bytes", "max_ready_ms"];
const VALUE = { breakpoints: [1440], max_initial_bytes: 20_000_000, max_ready_ms: 30_000 };
async function toolWith(switchValue) {
  for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_")) delete process.env[key];
  Object.assign(process.env, { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" });
  if (switchValue !== undefined) process.env.NEWSROOM_QA_LIMITS_PROGRAM = switchValue;
  const art = join(mkdtempSync(join(tmpdir(), "qa-limits-run-")), "run");
  mkdirSync(art, { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  const tool = tools.get("newsroom_publication_plan");
  assert.ok(tool, "newsroom_publication_plan is registered");
  return tool;
}
const call = async (tool, extra) => {
  try { await tool.execute("t", { infographic_plan_ref: "infographics/plans/none.json", ...extra }); return ""; } catch (error) { return String(error?.message ?? error); }
};

// default (unset) and any value but "0": the three fields are gone from the schema and the guideline says why
for (const value of [undefined, "1", "", "true", "00"]) {
  const tool = await toolWith(value);
  const props = Object.keys(tool.parameters.properties);
  for (const field of FIELDS) assert.ok(!props.includes(field), `${JSON.stringify(value)}: ${field} is not a parameter`);
  assert.ok(props.includes("packaging") && props.includes("static_fallback") && props.includes("modules"), `${JSON.stringify(value)}: the other parameters stay`);
  assert.ok(tool.promptGuidelines.some((g) => /program sets the browser-check width/.test(g)), `${JSON.stringify(value)}: the guideline names who sets them`);
  assert.ok(!tool.promptGuidelines.some((g) => /Omit breakpoints for the desktop-only default/.test(g)), `${JSON.stringify(value)}: the old guideline is gone`);
  // one test per removed field: a call that passes it is refused and the message names it
  for (const field of FIELDS) {
    const message = await call(tool, { [field]: VALUE[field] });
    assert.match(message, /no longer takes/, `${JSON.stringify(value)} ${field}: refused (${message.slice(0, 160)})`);
    assert.ok(message.includes(field), `${JSON.stringify(value)} ${field}: the message names the field`);
    for (const other of FIELDS.filter((f) => f !== field)) assert.ok(!message.includes(other), `${JSON.stringify(value)} ${field}: the message names only the field passed`);
  }
  // the tool host (convert, then validate) neither rejects nor strips a removed field, so it reaches execute and is refused there;
  // a null is read as "not passed" by the host's own conversion (optional null dropped), so it never reaches execute
  const raw = { infographic_plan_ref: "infographics/plans/none.json", modules: [], ...VALUE };
  const hosted = validationFailure("newsroom_publication_plan", tool.parameters, raw);
  for (const field of FIELDS) assert.ok(!(hosted.text ?? "").includes(`${field}:`), `${JSON.stringify(value)} ${field}: the host does not reject it (${(hosted.text ?? "").slice(0, 120)})`);
  const converted = (await import(join(tree, "runtime", "pi", "tool_host_schema.mjs"))).convert(tool.parameters, raw);
  for (const field of FIELDS) assert.deepEqual(converted[field], VALUE[field], `${JSON.stringify(value)} ${field}: the host passes it through unchanged`);
  const nulled = (await import(join(tree, "runtime", "pi", "tool_host_schema.mjs"))).convert(tool.parameters, { ...raw, breakpoints: null });
  assert.ok(!("breakpoints" in nulled), `${JSON.stringify(value)}: a null optional field is dropped by the host before execute`);
  const all = await call(tool, VALUE);
  for (const field of FIELDS) assert.ok(all.includes(field), `all three passed: ${field} is named`);
  // a call without them is not refused for that reason (it fails later, on the plan it cannot read)
  assert.ok(!/no longer takes/.test(await call(tool, {})), `${JSON.stringify(value)}: a call without the fields is not refused for them`);
}

// exactly "0": the old schema, the old guideline, and the same call is not refused for these fields
const old = await toolWith("0");
const oldProps = Object.keys(old.parameters.properties);
for (const field of FIELDS) assert.ok(oldProps.includes(field), `"0": ${field} is a parameter again`);
assert.ok(old.promptGuidelines.some((g) => /Omit breakpoints for the desktop-only default/.test(g)), '"0": the old guideline is back');
for (const field of FIELDS) assert.ok(!/no longer takes/.test(await call(old, { [field]: VALUE[field] })), `"0": ${field} is not refused for being passed`);
console.log("PASS qa limits program through the real publication plan tool");
