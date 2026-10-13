#!/usr/bin/env node
// NEWSROOM_FLOW_MAPS_BACK=1 (default off; acts only with NEWSROOM_HELD_CHART_TYPES=1): cartographic_flow_map leaves the held list
// everywhere it is read; geo_flow_map (fails render QA on all three flow topics), hierarchy_tree and trajectory_profile stay held.
// geo_edges is offered again because cartographic_flow_map's default data_topology is geo_edges (newsroom.ts plan defaults).
//  1. Off (unset, 0, true, yes, "", " 1", 01), and on without the hold: tool definitions of every profile are byte-identical to the base (1296164).
//  2. On: cartographic_flow_map is in the plan and chain enums and accepted (no CHART_TYPE_HELD); geo_flow_map, hierarchy_tree and trajectory_profile
//     are still refused by plan, lint, render.
//  3. On: geo_edges is offered again, hierarchy values stay refused (PLAN_VALUE_HELD); the strict-grammar refusal lists cartographic_flow_map for flow
//     and geography but never a held type; the wording and hints say "cartographic flow map" (the name the plan accepts, so no retry on geo_flow_map)
//     and never name geo_flow_map, hierarchy_tree or trajectory_profile.
//  Without the base history (a shallow clone) the byte comparison prints SKIP; NEWSROOM_REQUIRE_NO_SKIP=1 turns that SKIP into a failure.
//  4. The difference between base+hold and on is exactly those enum entries, values and sentences, shown path by path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = "17740c7";
// read before tools() clears every NEWSROOM_ variable from the environment
const REQUIRE_NO_SKIP = process.env.NEWSROOM_REQUIRE_NO_SKIP === "1";
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
  Object.assign(process.env, { NEWSROOM_ARTIFACT_DIR: artifacts, NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" }, env);
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

// ---- 2 and 3: on --------------------------------------------------------------------------------------------------------
const HOLD = { NEWSROOM_HELD_CHART_TYPES: "1" }, BACK = { ...HOLD, NEWSROOM_FLOW_MAPS_BACK: "1" };
for (const hints of [{}, { NEWSROOM_SPEED_RULE_HINTS: "1" }]) {
  const on = await tools(current, { NEWSROOM_TOOL_PROFILE: "full", ...BACK, ...hints });
  for (const name of ["newsroom_viz_plan", "newsroom_viz_chain"]) {
    const props = on.get(name).parameters.properties;
    for (const t of FLOW) assert.ok(props.chart_type.enum.includes(t), `${name}: ${t} offered`);
    for (const t of STAY) assert.ok(!props.chart_type.enum.includes(t), `${name}: ${t} still held`);
    assert.ok(props.data_topology.enum.includes("geo_edges"), `${name}: geo_edges offered again`);
    assert.ok(!props.data_topology.enum.includes("hierarchy") && !props.visual_family.enum.includes("hierarchy"), `${name}: hierarchy values stay held`);
  }
  const text = JSON.stringify([...on.values()].map((t) => [t.description, t.promptGuidelines, t.parameters])).replace(/"enum":\[[^\]]*\]/g, "");
  for (const t of STAY) assert.ok(!text.includes(t), `no mention of ${t} outside enums${JSON.stringify(hints)}`);
  const plan = on.get("newsroom_viz_plan");
  assert.ok(plan.description.includes("spatial flows") && !plan.description.includes("hierarch"), "description names spatial flows, no hierarchies");
  assert.ok(plan.promptGuidelines.some((s) => s.includes("cartographic flow map, adjacency matrix, timeline") && !s.includes("geographic flow map")), "guideline names the cartographic flow map, not geo_flow_map or the hierarchy tree");
  if (hints.NEWSROOM_SPEED_RULE_HINTS) assert.ok(JSON.stringify(plan.parameters).includes("flow sankey/alluvial/parallel_sets/cartographic_flow_map;") && !JSON.stringify(plan.parameters).includes("geo_flow_map/"), "rule hint names cartographic_flow_map only");
  // refusals: held pair refused by plan, lint and render; the flow maps are not refused (they fail later, on missing data, not as held)
  const refused = (t) => new RegExp(`^CHART_TYPE_HELD: chart_type '${t}' is not available`);
  mkdirSync(join(artifacts, "visualizations/plans"), { recursive: true });
  for (const t of [...STAY, ...FLOW]) {
    const file = `visualizations/plans/p-${t}.json`;
    writeFileSync(join(artifacts, file), JSON.stringify({ chart_type: t, sql: "SELECT 1" }));
    for (const [label, run] of [["plan", () => plan.execute("t", { chart_type: t, sql: "SELECT 1" })], ["lint", () => on.get("newsroom_viz_lint").execute("t", { plan_ref: file })], ["render", () => on.get("newsroom_viz_render").execute("t", { plan_ref: file, lint_ref: "visualizations/lints/none.json" })]]) {
      const message = await run().then(() => "", (e) => String(e.message));
      if (STAY.includes(t)) assert.match(message, refused(t), `${label} refuses ${t}`);
      else assert.ok(!/CHART_TYPE_HELD|PLAN_VALUE_HELD/.test(message), `${label} accepts ${t} past the hold (${message.slice(0, 80)})`);
    }
  }
  for (const [field, value] of [["visual_family", "hierarchy"], ["data_topology", "hierarchy"]]) {
    await assert.rejects(() => plan.execute("t", { chart_type: "horizontal_bar", sql: "SELECT 1", [field]: value }), (e) => e.message === `PLAN_VALUE_HELD: ${field} '${value}' is not available; choose another ${field}.`, `${field}=${value} still refused`);
  }
  const geo = await plan.execute("t", { chart_type: "horizontal_bar", sql: "SELECT 1", data_topology: "geo_edges" }).then(() => "", (e) => String(e.message));
  assert.ok(!/PLAN_VALUE_HELD/.test(geo), "geo_edges is no longer a held value");
}
// the strict-grammar refusal is built in module-private code: read it from the source
{
  const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.ok(src.includes("allowed.filter((form) => !isHeldChartType(form))"), "the blocked message filters by isHeldChartType, which the switch updates");
  assert.match(src, /const FLOW_MAP_TYPES: readonly string\[\] = \["cartographic_flow_map"\];/, "exactly cartographic_flow_map leaves the list");
}

// ---- 1: off is byte-identical to the base; 4: the exact difference ----------------------------------------------------------------
const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", BASE, "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
if (archive.status !== 0) {
  console.log(`SKIP flow-maps-back: ${BASE} history unavailable, so the byte comparison with it did not run`);
  if (REQUIRE_NO_SKIP) throw new Error("skipped check under NEWSROOM_REQUIRE_NO_SKIP=1");
} else {
  const bdir = mkdtempSync(join(scratch, "base-"));
  writeFileSync(join(bdir, "b.tar"), archive.stdout);
  assert.equal(spawnSync("tar", ["-xf", join(bdir, "b.tar"), "-C", bdir]).status, 0);
  const base = await load(bdir);
  let compared = 0;
  for (const profile of PROFILES) for (const hints of [{}, { NEWSROOM_SPEED_RULE_HINTS: "1" }]) for (const hold of [{}, HOLD]) {
    const env = { NEWSROOM_TOOL_PROFILE: profile, ...hold, ...hints };
    const was = JSON.stringify(plain(await tools(base, env)));
    for (const v of [undefined, "0", "true", "yes", "", " 1", "01"]) {
      assert.equal(JSON.stringify(plain(await tools(current, { ...env, ...(v === undefined ? {} : { NEWSROOM_FLOW_MAPS_BACK: v }) }))), was, `${profile} ${JSON.stringify(Object.keys({ ...hold, ...hints }))} switch=${JSON.stringify(v)}: byte-identical to ${BASE}`);
    }
    if (!hold.NEWSROOM_HELD_CHART_TYPES) assert.equal(JSON.stringify(plain(await tools(current, { ...env, NEWSROOM_FLOW_MAPS_BACK: "1" }))), was, `${profile}: on without the hold changes nothing`);
    compared += 1;
  }
  // exact difference, base+hold vs on, plan tool in the full profile
  for (const hints of [{}, { NEWSROOM_SPEED_RULE_HINTS: "1" }]) {
    const before = plain(await tools(base, { NEWSROOM_TOOL_PROFILE: "full", ...HOLD, ...hints }));
    const after = plain(await tools(current, { NEWSROOM_TOOL_PROFILE: "full", ...BACK, ...hints }));
    const changes = diff(before, after);
    const paths = changes.map((c) => c.path);
    const allowed = /^\/newsroom_viz_(plan|chain)\/(parameters\/properties\/(chart_type|data_topology|claim_spec\/[^/]*)(\/enum)?|description|promptGuidelines\/\d+|parameters\/properties\/[a-z_]+\/description)/;
    for (const c of changes) assert.match(c.path, allowed, `only the planned places change (${c.path})`);
    assert.ok(paths.some((p) => /chart_type\/enum$/.test(p)) && paths.some((p) => /data_topology\/enum$/.test(p)), "the enums change");
    for (const c of changes.filter((c) => /chart_type\/enum$/.test(c.path))) assert.deepEqual(c.after.filter((t) => !c.before.includes(t)), FLOW, "chart_type enum gains exactly cartographic_flow_map");
    for (const c of changes.filter((c) => /data_topology\/enum$/.test(c.path))) assert.deepEqual(c.after.filter((t) => !c.before.includes(t)), ["geo_edges"], "data_topology enum gains exactly geo_edges");
    if (compared) console.log(`difference ${JSON.stringify(Object.keys(hints))}: ${changes.length} places`);
  }
  console.log(`ok: off byte-identical to ${BASE} (${compared} profile/switch sets x 7 values)`);
}
console.log("flow maps back: ok");
