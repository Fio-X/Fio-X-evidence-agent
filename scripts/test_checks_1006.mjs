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
import { critiqueInfographic, trimmedSvgInfo } from "../runtime/pi/infographic.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

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

// ---------------------------------------------------------------- K102 NEWSROOM_PAGE_QA_NESTED_CLIP
const CLIP = "NEWSROOM_PAGE_QA_NESTED_CLIP", TRIM = "NEWSROOM_PAGE_TRIM_TEXT_SAFE";
// The V218 fixture (scripts/test_render_1006.mjs): an end-anchored "80%" tick whose ink starts left of the old trim.
const chart = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><text x="30.9" y="20" text-anchor="end" font-size="12">80%</text><line x1="40" y1="14" x2="390" y2="14" stroke="#ccc" stroke-width="1"/><polyline points="40,100 200,60 390,30" fill="none" stroke="#333" stroke-width="2"/></svg>`;
// The page embeds a chart the way embedVisual does: a nested svg at the module box, viewBox = the trimmed region, xMinYMin meet.
function page(svg, trimEnv, boxW = 400) {
  const info = withEnv(TRIM, trimEnv, () => trimmedSvgInfo(svg));
  const targetH = boxW * (info.height / info.width);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600"><rect x="0" y="0" width="800" height="600" fill="#fff"/><svg data-role="infographic-visual" data-module-id="m1" x="60" y="100" width="${boxW}" height="${targetH}" viewBox="${info.minX} ${info.minY} ${info.width} ${info.height}" preserveAspectRatio="xMinYMin meet">${info.inner}</svg></svg>`;
}
const rules = (svg, env) => withEnv(CLIP, env, () => checkSvgGeometry(svg).failures);
const offPage = page(chart, undefined), onPage = page(chart, "1");
assert.deepEqual(rules(offPage, undefined).map((f) => f.rule), [], "switch off, trim off: today the page QA passes the cut-off label");
assert.deepEqual(rules(offPage, "0").map((f) => f.rule), [], "any value other than \"1\" is off");
const hit = rules(offPage, "1");
assert.deepEqual(hit.map((f) => f.rule), ["text_outside_nested_svg"], "switch on, trim off: the cut-off label is reported");
assert.match(hit[0].message, /"80%"/, "the report names the label");
assert.deepEqual(rules(onPage, "1").map((f) => f.rule), [], "switch on, trim fix on: nothing reported");
assert.deepEqual(rules(onPage, undefined).map((f) => f.rule), [], "switch off, trim fix on: nothing reported");
// The switch does not change any other finding.
assert.deepEqual(checkSvgGeometry(offPage).failures, withEnv(CLIP, "1", () => checkSvgGeometry(offPage).failures.filter((f) => f.rule !== "text_outside_nested_svg")), "the other findings are the same with the switch on");
// A text well inside a nested svg, and a page with no nested svg, are untouched.
assert.deepEqual(rules(page(chart.replace('x="30.9"', 'x="60"'), "1"), "1"), [], "label inside the box: no report");
const flat = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><text x="30" y="20" font-size="12">80%</text></svg>`;
assert.equal(rules(flat, "1").length, 0, "no nested svg: nothing to add");
console.log(`K102: off-trim page reports ${hit.length} (${hit[0].message.slice(0, 120)}...)`);

// ---------------------------------------------------------------- K103 NEWSROOM_PAGE_MODULE_ORDER_CHECK
const ORDER = "NEWSROOM_PAGE_MODULE_ORDER_CHECK";
// Synthetic pages: the critique reads the placed boxes and the plan order (modules numbered 01, 02, 03 in plan order).
const planModules = (extra = []) => [
  { id: "a", type: "visual", emphasis: "primary" }, { id: "b", type: "visual", emphasis: "primary" }, { id: "c", type: "text", emphasis: "primary" }, ...extra,
];
const box = (id, x, y, w = 600, h = 300) => ({ id, module: { id }, x, y, w, h });
const composedWith = (boxes, extra = {}) => ({ svg: `<svg data-viewport="desktop"><g data-role="infographic-visual"/>Sources and methods</svg>`, width: 1440, height: 2000, boxes, ...extra });
const specFor = (schema_version, modules) => ({ schema_version, title: "t", dek: "d", alt: "a page", modules, quality_target: "editorial" });
const orderIssues = (schema_version, modules, boxes, env, extra) => withEnv(ORDER, env, () => critiqueInfographic(specFor(schema_version, modules), { desktop: composedWith(boxes, extra) }).issues.filter((i) => i.code === "module_ordinal_out_of_order"));
const wrong = [box("b", 40, 100), box("a", 40, 500), box("c", 40, 900)];      // top to bottom: 02, 01, 03
const right = [box("a", 40, 100), box("b", 40, 500), box("c", 40, 900)];      // 01, 02, 03
for (const version of ["1.5.0", "1.0.0"]) {
  const hit = orderIssues(version, planModules(), wrong, "1");
  assert.equal(hit.length, 1, `${version}: page laid out 02, 01, 03 gives one warning`);
  assert.equal(hit[0].severity, "warning", `${version}: it is a warning, not a blocker`);
  assert.deepEqual([hit[0].modules, hit[0].ordinals], [["b", "a"], [2, 1]], `${version}: it names the two modules and their numbers`);
  assert.deepEqual(orderIssues(version, planModules(), right, "1"), [], `${version}: in-order page: no warning`);
  assert.deepEqual(orderIssues(version, planModules(), wrong, undefined), [], `${version}: switch off: no warning`);
  assert.deepEqual(orderIssues(version, planModules(), wrong, "0"), [], `${version}: any value other than "1" is off`);
  const withSwitch = withEnv(ORDER, "1", () => critiqueInfographic(specFor(version, planModules()), { desktop: composedWith(wrong) }));
  const without = critiqueInfographic(specFor(version, planModules()), { desktop: composedWith(wrong) });
  assert.equal(withSwitch.passed, without.passed, `${version}: passed is unchanged`);
  assert.equal(withSwitch.score, without.score, `${version}: score is unchanged`);
  assert.deepEqual(withSwitch.issues.filter((i) => i.code !== "module_ordinal_out_of_order"), without.issues, `${version}: no other issue changes`);
}
// Reading order inside a row is left to right; a row is boxes whose tops are within 4 px.
assert.deepEqual(orderIssues("1.5.0", planModules(), [box("a", 40, 100, 400), box("b", 520, 102, 400), box("c", 40, 600)], "1"), [], "two numbers side by side, left to right: no warning");
assert.equal(orderIssues("1.5.0", planModules(), [box("b", 520, 100, 400), box("a", 40, 102, 400), box("c", 40, 600)], "1").length, 0, "the same row listed in any order is sorted left to right");
assert.equal(orderIssues("1.5.0", planModules(), [box("a", 520, 100, 400), box("b", 40, 102, 400), box("c", 40, 600)], "1").length, 1, "02 left of 01 in one row: one warning");
// Modules that print no number do not take part: a section header, a hero stat, a hero visual and a decorative illustration.
const extras = [{ id: "h", type: "section_header" }, { id: "s", type: "hero_stat" }, { id: "v", type: "visual", emphasis: "hero" }, { id: "d", type: "illustration" }];
const mixed = [box("h", 40, 20), box("s", 40, 60), box("v", 40, 100), box("a", 40, 400), box("d", 40, 700), box("b", 40, 1000), box("c", 40, 1300)];
assert.deepEqual(orderIssues("1.5.0", planModules(extras), mixed, "1", { decorative_module_ids: ["d"] }), [], "unnumbered modules are ignored");
console.log("K103: wrong order warns once, in-order page and switch off do not, passed/score unchanged");
console.log("ok");
