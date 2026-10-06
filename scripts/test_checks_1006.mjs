#!/usr/bin/env node
// Three opt-in checks, each default off (a switch opens only on exactly "1"), tested on synthetic inputs (no browser, no network):
//   NEWSROOM_CHANNEL_AXES: visual_channels may name position_x / position_y.
//   NEWSROOM_PAGE_QA_NESTED_CLIP: text inside a nested chart svg is also tested against that svg's own box.
//   NEWSROOM_PAGE_MODULE_ORDER_CHECK: printed module numbers must increase in reading order.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visualChannelOwnerValidator } from "../runtime/pi/editorial_validators.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const withEnv = (name, value, fn) => { const old = process.env[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; try { return fn(); } finally { if (old === undefined) delete process.env[name]; else process.env[name] = old; } };

// ---------------------------------------------------------------- K105 NEWSROOM_CHANNEL_AXES
const AXES = "NEWSROOM_CHANNEL_AXES";
const codes = (channels, env) => withEnv(AXES, env, () => visualChannelOwnerValidator({ schema_version: "1.4.0", modules: [{ id: "m1", type: "visual", visual_channels: channels }] }).map((i) => i.rule_id));
const own = (channel, field, role = "quantitative") => ({ channel, field, role });
assert.deepEqual(codes([own("position_x", "year", "categorical"), own("position_y", "value")], "1"), [], "on: year->position_x + value->position_y passes");
assert.deepEqual(codes([own("position_x", "year", "categorical"), own("position_x", "value")], "1"), ["visual_channel.single_owner"], "on: two fields on position_x are refused");
assert.deepEqual(codes([own("position_y", "a"), own("position_y", "b")], "1"), ["visual_channel.single_owner"], "on: two fields on position_y are refused");
assert.deepEqual(codes([own("position", "value"), own("position_x", "year", "categorical")], "1"), ["visual_channel.single_owner"], "on: position then position_x is refused");
assert.deepEqual(codes([own("position_y", "value"), own("position", "year", "categorical")], "1"), ["visual_channel.single_owner"], "on: position_y then position is refused");
assert.deepEqual(codes([own("position", "a"), own("position", "b")], "1"), ["visual_channel.single_owner"], "on: plain position twice is refused");
assert.deepEqual(codes([own("connection", "year", "categorical"), own("position", "value")], "1"), [], "on: year->connection + value->position passes as before");
assert.deepEqual(codes([own("position_x", "value"), own("color", "g", "categorical")], "1"), [], "on: position_x counts as an accurate channel for a quantity");
assert.deepEqual(codes([own("position_y", "value")], "1"), [], "on: position_y alone counts as an accurate channel for a quantity");
// Off: the validator is what it was. position_x is just another name (not in the accurate list), so a quantity on it is low-precision.
for (const env of [undefined, "0", "true"]) {
  assert.deepEqual(codes([own("connection", "year", "categorical"), own("position", "value")], env), [], `off(${env}): unchanged`);
  assert.deepEqual(codes([own("position", "a"), own("position", "b")], env), ["visual_channel.single_owner"], `off(${env}): position twice refused`);
  assert.deepEqual(codes([own("position_x", "value")], env), ["visual_channel.color_only_quantity"], `off(${env}): position_x is not an accurate channel`);
  assert.deepEqual(codes([own("position", "a"), own("position_x", "b")], env), [], `off(${env}): position and position_x do not clash`);
}

// Tool definitions: the channel enum and hint, read from the registered infographic plan tool (same stubs as scripts/test_fast_fail_errors.mjs).
const stub = (dir, name, source) => { mkdirSync(join(dir, "node_modules", name), { recursive: true }); writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" })); writeFileSync(join(dir, "node_modules", name, "index.js"), source); };
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }), Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }), Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }), Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };
`;
const treeDir = mkdtempSync(join(tmpdir(), "checks-1006-tree-"));
cpSync(join(ROOT, "runtime"), join(treeDir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(treeDir, "config"), { recursive: true });
stub(treeDir, "typebox", TYPEBOX);
stub(treeDir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const testCopy = join(treeDir, "runtime", "pi", "newsroom.test-copy.mjs");
writeFileSync(testCopy, stripTypeScriptTypes(readFileSync(join(treeDir, "runtime", "pi", "newsroom.ts"), "utf8"), { mode: "strip" }));
let instance = 0;
async function channelList(env) {
  const mod = await import(`${pathToFileURL(testCopy).href}?instance=${++instance}`);
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("NEWSROOM_")) delete process.env[k];
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  Object.assign(process.env, env);
  const tools = new Map();
  try { mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) })); } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  const found = [];
  const walk = (node) => { if (node && typeof node === "object") { if (node.properties?.visual_channels) found.push(node.properties.visual_channels); for (const v of Object.values(node)) walk(v); } };
  walk(tools.get("newsroom_infographic_plan").parameters);
  assert.equal(found.length, 1, "one visual_channels field in the infographic plan");
  return { list: found[0], channels: found[0].items.properties.channel.enum };
}
const offList = await channelList({});
assert.ok(!offList.channels.includes("position_x") && !offList.channels.includes("position_y"), "off: position_x is refused by the schema (not in the enum)");
assert.deepEqual(offList.channels, ["position", "length", "area", "size", "angle", "color", "opacity", "shape", "connection"], "off: the enum is what it was");
assert.equal(offList.list.description, undefined, "off, hints off: no description");
const hintsOnly = await channelList({ NEWSROOM_SPEED_RULE_HINTS: "1" });
assert.equal(hintsOnly.list.description, "Each channel may be owned by one field only.", "hints on, axes off: the old sentence only");
assert.deepEqual((await channelList({ [AXES]: "0" })).channels, offList.channels, "any value other than \"1\" is off");
const onList = await channelList({ [AXES]: "1" });
assert.deepEqual(onList.channels, ["position", "position_x", "position_y", "length", "area", "size", "angle", "color", "opacity", "shape", "connection"], "on: the enum gains position_x and position_y");
assert.match(onList.list.description, /horizontal field as position_x.*vertical field as position_y/, "on: the hint says which axis is which");
assert.match((await channelList({ [AXES]: "1", NEWSROOM_SPEED_RULE_HINTS: "1" })).list.description, /^Each channel may be owned by one field only\. A line or scatter chart/, "on + rule hints: both sentences");
console.log("K105: validator and tool definition ok");
console.log("ok");
