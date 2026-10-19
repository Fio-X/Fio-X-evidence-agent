#!/usr/bin/env node
// NEWSROOM_FLOW_EXTENT_HINT=1 (exact "1", default off): the extent_mode plan field says to leave it out so the program picks the extent from the
// data, and to write world only when the story needs the whole world. Off (unset, 0, true, yes, "", " 1", 01): tool definitions of every profile
// are byte-identical to the commit before this switch. On: the only difference is that one description (shown path by path) in the plan and chain tools; the enum
// and the extent thresholds (AUTO_EXTENT_MAX_LON/LAT in viz.mjs) are untouched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withoutApprovedIllustration, withoutApprovedLieflat, loadPinPatches } from "./lib_pin_patch.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = "aa76a4c"; // the commit before this switch (it already holds NEWSROOM_FLOW_MAPS_BACK, which 46c3624 lacks)
const scratch = mkdtempSync(join(tmpdir(), "flow-back-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const TYPEBOX = `const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`;
let n = 0;
async function load(source) {
  const dir = mkdtempSync(join(scratch, "tree-"));
  cpSync(join(source, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(source, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const file = join(dir, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(file, stripTypeScriptTypes(readFileSync(join(dir, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  return file;
}
const artifacts = mkdtempSync(join(scratch, "art-"));
async function tools(file, env = {}) {
  for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_")) delete process.env[key];
  Object.assign(process.env, { NEWSROOM_ARTIFACT_DIR: artifacts, NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SYMBOL_MAP: "0" /* symbol_map is on by default and adds a chart type, so the old-baseline comparison pins it off */ }, env);
  const out = new Map();
  const mod = await import(`${pathToFileURL(file).href}?v=${++n}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => out.set(tool.name, tool) : () => {}) }));
  return out;
}
const plain = (map) => Object.fromEntries([...map].map(([k, t]) => [k, JSON.parse(JSON.stringify({ ...t, execute: undefined }))]));
function diff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const flat = (v) => Array.isArray(v) && v.every((x) => typeof x === "string") && path.endsWith("/enum");
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b) && !(flat(a) && flat(b))) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => diff(a[key], b[key], `${path}/${key}`));
  }
  return [{ path, before: a, after: b }];
}
const FLOW = ["cartographic_flow_map"], STAY = ["hierarchy_tree", "trajectory_profile", "geo_flow_map"];
const PROFILES = ["investigate", "visual", "visual-story", "publication", "competition", "full"];
const current = await load(ROOT);
const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", BASE, "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
if (archive.status !== 0) { console.log(`SKIP ${BASE} history unavailable; the byte comparison is skipped`); if (process.env.NEWSROOM_REQUIRE_NO_SKIP === "1") throw new Error(`${BASE} history is missing and the run requires none to be skipped`); process.exit(process.env.NEWSROOM_REQUIRE_NO_SKIP === "1" ? 1 : 0); }
const bdir = mkdtempSync(join(scratch, "base-"));
writeFileSync(join(bdir, "b.tar"), archive.stdout);
assert.equal(spawnSync("tar", ["-xf", join(bdir, "b.tar"), "-C", bdir]).status, 0);
const base = await load(bdir);
let compared = 0;
// Off differs from the base only by the approved description changes listed in the pin list (exact old and new text).
const pins = loadPinPatches("flow_extent_hint", { baseline: BASE });
for (const profile of PROFILES) for (const extra of [{}, { NEWSROOM_HELD_CHART_TYPES: "1", NEWSROOM_FLOW_MAPS_BACK: "1" }, { NEWSROOM_SPEED_RULE_HINTS: "1" }]) {
  const env = { NEWSROOM_TOOL_PROFILE: profile, ...extra };
  // K190 reworded one string under NEWSROOM_FLOW_MAPS_BACK=1 ("geographic" -> "cartographic" flow map); that is the only difference allowed from the base
  const baseText = JSON.stringify(plain(withoutApprovedIllustration(withoutApprovedLieflat(await tools(base, env), profile), { ...process.env, ...env })));
  const was = extra.NEWSROOM_FLOW_MAPS_BACK === "1" ? baseText.split("chord, geographic flow map, adjacency matrix, timeline").join("chord, cartographic flow map, adjacency matrix, timeline") : baseText;
  for (const v of [undefined, "0", "true", "yes", "", " 1", "01", "11"]) {
    pins.check(new Map(Object.entries(JSON.parse(was))), await tools(current, { ...env, ...(v === undefined ? {} : { NEWSROOM_FLOW_EXTENT_HINT: v }) }), `${profile} ${JSON.stringify(extra)} NEWSROOM_FLOW_EXTENT_HINT=${JSON.stringify(v)} against ${BASE}`);
    compared++;
  }
  const on = plain(await tools(current, { ...env, NEWSROOM_FLOW_EXTENT_HINT: "1" }));
  const off = plain(await tools(current, env));
  const changes = diff(off, on);
  for (const c of changes) assert.match(c.path, /^\/newsroom_viz_(plan|chain)\/parameters\/properties\/extent_mode\/description$/, `unexpected difference at ${c.path}`);
  const plan = on.newsroom_viz_plan?.parameters?.properties?.extent_mode;
  if (plan) {
    assert.deepEqual(plan.enum, ["world", "data"], "the enum is untouched");
    assert.match(plan.description, /Leave this out/);
    assert.match(plan.description, /program picks the extent from the data/);
    assert.match(plan.description, /world only when the story needs the whole world/);
    assert.ok(changes.some((c) => c.path.startsWith("/newsroom_viz_plan/")), `${profile}: the plan tool carries the hint`);
  }
}
pins.finish();
// the thresholds are not changed
const viz = readFileSync(join(ROOT, "runtime/pi/viz.mjs"), "utf8"), baseViz = readFileSync(join(bdir, "runtime/pi/viz.mjs"), "utf8");
for (const name of ["AUTO_EXTENT_MAX_LON", "AUTO_EXTENT_MAX_LAT"]) assert.equal(viz.match(new RegExp(`${name}\\s*=\\s*[\\d.]+`))?.[0], baseViz.match(new RegExp(`${name}\\s*=\\s*[\\d.]+`))?.[0], `${name} unchanged`);
console.log("flow extent hint: ok", { compared });
