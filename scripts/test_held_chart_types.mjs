#!/usr/bin/env node
// Four chart types are held back from the model while their renders are fixed: hierarchy_tree, geo_flow_map,
// cartographic_flow_map and trajectory_profile. Their renderers stay; only the model's list (the plan and chain
// chart_type enum), the plan's wording and the three tools' input change. This test pins that.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HELD_CHART_TYPES, HELD_CHART_TYPE_EDITS, HELD_PLAN_VALUES, revertHeldChartTypes } from "./lib_held_chart_types_baseline.mjs";
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from "../runtime/pi/cartography.mjs";
import { lintVizSpec, renderVizBundle } from "../runtime/pi/viz.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALL = HELD_CHART_TYPE_EDITS.enum.before;
const KEPT = ALL.filter((type) => !HELD_CHART_TYPES.includes(type));
assert.equal(ALL.length, 28);
assert.equal(KEPT.length, 24);

// ---- tool registration with stand-ins for the two packages, as test_viz_plan_schema.mjs does --------------------------
const tree = mkdtempSync(join(tmpdir(), "held-types-"));
cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
const stub = (name, source) => {
  mkdirSync(join(tree, "node_modules", name), { recursive: true });
  writeFileSync(join(tree, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tree, "node_modules", name, "index.js"), source);
};
stub("typebox", `const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`);
stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(tree, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));

let imports = 0;
async function tools(env = {}) {
  for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_")) delete process.env[key];
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  Object.assign(process.env, env);
  const out = new Map();
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++imports}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => out.set(tool.name, tool) : () => {}) }));
  return out;
}

const artifacts = mkdtempSync(join(tmpdir(), "held-types-artifacts-"));
const listing = () => readdirSync(artifacts, { recursive: true }).sort().join("\n");
const withChain = { NEWSROOM_ARTIFACT_DIR: artifacts, NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" };
const on = await tools({ ...withChain, NEWSROOM_SPEED_RULE_HINTS: "1" });
const off = await tools(withChain);

// ---- 1. the enums -------------------------------------------------------------------------------------------------------
for (const [label, set] of [["hints off", off], ["hints on", on]]) {
  const plan = set.get("newsroom_viz_plan"), chain = set.get("newsroom_viz_chain");
  assert.ok(plan && chain, `${label}: plan and chain are registered`);
  assert.deepEqual(plan.parameters.properties.chart_type.enum, KEPT, `${label}: plan enum keeps the other 24 in order`);
  assert.deepEqual(chain.parameters.properties.chart_type.enum, KEPT, `${label}: chain enum keeps the other 24 in order`);
}
const planOff = off.get("newsroom_viz_plan");
assert.ok(planOff.description.includes("Supports statistical charts plus flows, networks, temporal structures, choropleth maps and explanatory process graphics."));
assert.ok(!/hierarch|spatial flows/.test(planOff.description.split("Supports")[1]), "plan description no longer names hierarchies or spatial flows");
const guideline = planOff.promptGuidelines.find((text) => text.includes("topology-aware form"));
assert.ok(guideline.includes("such as Sankey, parallel sets, chord, adjacency matrix, timeline, or process schematic. Do not force"), "the guideline names only forms the model can choose");
const schemaText = (tool) => JSON.stringify(tool.parameters);
assert.ok(schemaText(on.get("newsroom_viz_plan")).includes("flow sankey/alluvial/parallel_sets; geography choropleth; network"), "rule hint: flow and geography");
assert.ok(schemaText(on.get("newsroom_viz_chain")).includes("flow sankey/alluvial/parallel_sets; geography choropleth; network"), "rule hint in the chain too");
assert.ok(!schemaText(off.get("newsroom_viz_plan")).includes("geography choropleth"), "rule hint is absent when the hints are off");
for (const set of [on, off]) for (const name of ["newsroom_viz_plan", "newsroom_viz_chain"]) {
  const text = schemaText(set.get(name)).replace(/"enum":\[[^\]]*\]/g, "");
  assert.ok(!HELD_CHART_TYPES.some((type) => text.includes(type)), `${name}: no held type outside the enums`);
}

// ---- 2. the refusal -------------------------------------------------------------------------------------------------------
const before = listing();
const refusal = (type) => new RegExp(`^CHART_TYPE_HELD: chart_type '${type}' is not available; choose another chart_type\\.$`);
for (const type of HELD_CHART_TYPES) {
  await assert.rejects(() => off.get("newsroom_viz_plan").execute("t", { chart_type: type, sql: "SELECT 1" }), (error) => refusal(type).test(error.message), `plan refuses ${type}`);
  mkdirSync(join(artifacts, "visualizations/plans"), { recursive: true });
  const planFile = `visualizations/plans/held-${type}.json`;
  writeFileSync(join(artifacts, planFile), JSON.stringify({ chart_type: type, sql: "SELECT 1" }));
  const withPlan = listing();
  await assert.rejects(() => off.get("newsroom_viz_lint").execute("t", { plan_ref: planFile }), (error) => refusal(type).test(error.message), `lint refuses ${type}`);
  await assert.rejects(() => off.get("newsroom_viz_render").execute("t", { plan_ref: planFile, lint_ref: "visualizations/lints/none.json" }), (error) => refusal(type).test(error.message), `render refuses ${type}`);
  assert.equal(listing(), withPlan, `${type}: lint and render wrote nothing`);
}
assert.equal(listing().split("\n").filter((name) => !name.startsWith("visualizations/plans")).join("\n").replace(/^visualizations$/m, ""), before.replace(/^visualizations$/m, ""), "nothing but the plan files this test wrote is in the artifact directory");
// What the chain says when its plan step is refused is reported, not asserted; it must carry the refusal's type only.
const chainRefusal = await off.get("newsroom_viz_chain").execute("t", { chart_type: "hierarchy_tree", sql: "SELECT 1" }).then((value) => JSON.stringify(value), (error) => String(error.message));
assert.ok(!/item|K\d+|\/Users|\/tmp/.test(chainRefusal), "the chain's refusal carries no ids or paths");

// ---- 2b. plan values that fit only held chart types ---------------------------------------------------------------------------
{
  const PLAN_ENUMS = HELD_CHART_TYPE_EDITS.planEnums;
  // viz.mjs's own lint says which chart types a value fits: a mismatch is the blocker "<field> '<value>' does not match chart_type".
  const fits = (field, value) => ALL.filter((type) => {
    const result = lintVizSpec({ chart_type: type, [field]: value }, [], { verified_claim_ids: [] });
    return !(result.blockers ?? []).some((message) => String(message).includes(`${field} '${value}' does not match chart_type`));
  });
  for (const [field, entry] of Object.entries(PLAN_ENUMS)) {
    for (const value of entry.before) {
      const types = fits(field, value);
      const held = HELD_PLAN_VALUES[field].includes(value);
      if (held) {
        assert.ok(types.length > 0 && types.every((type) => HELD_CHART_TYPES.includes(type)), `${field} '${value}' fits only held types (${types})`);
      } else {
        assert.ok(types.some((type) => !HELD_CHART_TYPES.includes(type)), `${field} '${value}' still fits an available type (${types})`);
      }
    }
    for (const [label, set] of [["hints off", off], ["hints on", on]]) for (const name of ["newsroom_viz_plan", "newsroom_viz_chain"]) {
      assert.deepEqual(set.get(name).parameters.properties[field].enum, entry.after, `${label}: ${name} ${field} enum without the held values`);
    }
  }
  assert.deepEqual(HELD_PLAN_VALUES, { visual_family: ["hierarchy"], data_topology: ["hierarchy", "geo_edges"] });
  const listingBefore = listing();
  for (const [field, value] of [["visual_family", "hierarchy"], ["data_topology", "hierarchy"], ["data_topology", "geo_edges"]]) {
    await assert.rejects(() => off.get("newsroom_viz_plan").execute("t", { chart_type: "horizontal_bar", sql: "SELECT 1", [field]: value }), (error) => error.message === `PLAN_VALUE_HELD: ${field} '${value}' is not available; choose another ${field}.`, `plan refuses ${field}=${value} before planning`);
    const planFile = `visualizations/plans/held-value-${field}-${value}.json`;
    writeFileSync(join(artifacts, planFile), JSON.stringify({ chart_type: "horizontal_bar", sql: "SELECT 1", [field]: value }));
    const withPlan = listing();
    await assert.rejects(() => off.get("newsroom_viz_lint").execute("t", { plan_ref: planFile }), (error) => /^PLAN_VALUE_HELD: /.test(error.message), `lint refuses ${field}=${value}`);
    await assert.rejects(() => off.get("newsroom_viz_render").execute("t", { plan_ref: planFile, lint_ref: "visualizations/lints/none.json" }), (error) => /^PLAN_VALUE_HELD: /.test(error.message), `render refuses ${field}=${value}`);
    assert.equal(listing(), withPlan, `${field}=${value}: lint and render wrote nothing`);
  }
  assert.ok(listing().split("\n").every((name) => !name.startsWith("visualizations/lints") && !name.startsWith("visualizations/renders")), "no lint or render artifact from a held plan value");
  void listingBefore;
}

// ---- 3. the strict-grammar message ------------------------------------------------------------------------------------------
for (const relation of ["flow", "geography"]) {
  const message = await off.get("newsroom_viz_plan").execute("t", { chart_type: "heatmap", sql: "SELECT 1" }).then(() => "", (error) => error.message);
  assert.ok(!message.includes(relation) || !HELD_CHART_TYPES.some((type) => message.includes(type)), "no held type in the plan's early errors");
}
{
  // assertEditorialGrammar is module-private: exercise the message through the source it is built from.
  const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.ok(source.includes("requires one of ${allowed.filter((form) => !isHeldChartType(form)).join(\", \")}; got"), "the blocked message filters held types");
  assert.match(source, /const STRICT_GRAMMAR_FORMS[^]*?flow: \["sankey", "alluvial", "parallel_sets", "geo_flow_map", "cartographic_flow_map"\],\n  geography: \["geo_flow_map", "cartographic_flow_map", "choropleth"\]/, "STRICT_GRAMMAR_FORMS is unchanged");
}

// ---- 4. the renderers still render their fixtures byte for byte --------------------------------------------------------------
const record = JSON.parse(readFileSync(join(ROOT, "fixtures/v16-movement/adsb-dal1812-sampled.json"), "utf8"));
const points = record.points;
const mapRows = [{ source: "Observed coverage begins", target: "MSP / ground", value: 1, trajectory_points: JSON.stringify(points) }];
const mapSpec = { schema_version: "1.1.0", reader_task: "spatial", visual_family: "spatial", data_topology: "geo_edges", chart_type: "cartographic_flow_map", title: "Trajectory benchmark", subtitle: "Observed path with a preserved gap", alt: "Benchmark observed trajectory.", source_note: "xoolive/traffic readsb fixture.", note: "Observed geometry with source gap.", claim_id: "claim-bench-v16", sql: "fixture", unit: "trajectory", source_field: "source", target_field: "target", value_field: "value", geometry_semantics: "observed_trajectory", geometry_crs: "EPSG:4326", projection: "natural_earth_1", basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, route_provenance_note: "xoolive/traffic readsb public sample", trajectory_points_field: "trajectory_points", extent_mode: "data", extent_padding_ratio: 0.16, reference_path: "great_circle", locator_inset: true, aggregation_policy: "none", direct_labels: true, annotations: [] };
const profileSpec = { schema_version: "1.1.0", reader_task: "change", visual_family: "temporal", data_topology: "tabular", chart_type: "trajectory_profile", title: "Profile benchmark", subtitle: "Altitude and speed share elapsed time", alt: "Benchmark trajectory profile.", source_note: "xoolive/traffic readsb public sample.", note: "Observed samples.", claim_id: "claim-bench-v16", sql: "fixture", unit: "trajectory state", x_field: "elapsed_min", altitude_field: "altitude_ft", speed_field: "ground_speed_kt", segment_field: "segment", altitude_unit: "ft", speed_unit: "kt", annotations: [] };
const profileRows = points.map((p) => ({ elapsed_min: p.elapsed_s / 60, altitude_ft: p.altitude_ft, ground_speed_kt: p.ground_speed_kt, segment: p.segment }));
const fixture = (path) => JSON.parse(readFileSync(join(ROOT, "fixtures", path), "utf8"));
const rendered = {
  hierarchy_tree: fixture("complex/hierarchy.json"),
  geo_flow_map: fixture("spatial-explanatory/geo-flow-map.json"),
  cartographic_flow_map: { spec: mapSpec, rows: mapRows },
  trajectory_profile: { spec: profileSpec, rows: profileRows },
};
// SHA-256 of desktop + mobile, recorded at a5f56b3 (the renderers are untouched).
const PINNED = {
  hierarchy_tree: "38a91f29e926a74045d0a7fa07bf68394f55a85798d791d3af96bde1c431a77b",
  geo_flow_map: "4a65e6faccb88cc087ef093764d48402cc7faf294d31cf936906f303e66f0488",
  cartographic_flow_map: "22ab254690a454ec12e766b13d3f99e4f8869aa4e44ddb7511f27eddb0467579",
  trajectory_profile: "654e0b56bf33fed91c24cfdb926f13d4479f2956ac108d32e53fea951ebf2334",
};
for (const [type, { spec, rows }] of Object.entries(rendered)) {
  const bundle = renderVizBundle(spec, rows);
  assert.equal(spec.chart_type, type);
  assert.equal(createHash("sha256").update(bundle.desktop).update(bundle.mobile ?? "").digest("hex"), PINNED[type], `${type}: renderer output is byte-identical to a5f56b3`);
}

// ---- 5. the baseline helper is strict -----------------------------------------------------------------------------------------
const planNow = on.get("newsroom_viz_plan"), chainNow = on.get("newsroom_viz_chain");
const planOld = revertHeldChartTypes(planNow), chainOld = revertHeldChartTypes(chainNow);
assert.deepEqual(planOld.parameters.properties.chart_type.enum, ALL, "reverting restores the plan enum");
assert.deepEqual(chainOld.parameters.properties.chart_type.enum, ALL, "reverting restores the chain enum");
assert.ok(planOld.description.includes("hierarchies, temporal structures, spatial flows"), "reverting restores the plan description");
assert.ok(planOld.promptGuidelines.some((text) => text.includes("geographic flow map, adjacency matrix, hierarchy tree")), "reverting restores the guideline");
assert.ok(schemaText(planOld).includes("geography geo_flow_map/cartographic_flow_map/choropleth"), "reverting restores the rule hint");
assert.throws(() => revertHeldChartTypes(planOld), /held chart types: newsroom_viz_plan carries the declared edit 'enum' 0 time/, "a surface without the edits is refused");
assert.throws(() => revertHeldChartTypes(chainOld), /held chart types: newsroom_viz_chain carries the declared edit 'enum' 0 time/, "a chain without the edits is refused");
assert.throws(() => revertHeldChartTypes({ ...planNow, description: planNow.description + " " + HELD_CHART_TYPE_EDITS.description[0].after }), /'description: plan tool' 2 time\(s\), expected 1/, "an extra copy of the description edit is refused");
assert.throws(() => revertHeldChartTypes({ ...planNow, promptGuidelines: [...planNow.promptGuidelines, HELD_CHART_TYPE_EDITS.guidelines[0].after] }), /'guideline: topology-aware forms' 2 time\(s\), expected 1/, "an extra copy of the guideline edit is refused");
assert.throws(() => revertHeldChartTypes({ ...chainNow, description: chainNow.description + " " + HELD_CHART_TYPE_EDITS.description[0].after }), /'description: plan tool' 1 time\(s\), expected 0/, "the chain must not carry the plan's description edit");
assert.throws(() => revertHeldChartTypes({ ...planNow, parameters: { ...planNow.parameters, extra: [...KEPT] } }), /'enum' 2 time\(s\), expected 1/, "an extra copy of the enum edit is refused");
assert.equal(revertHeldChartTypes({ name: "other_tool", parameters: {} }).name, "other_tool", "other tools are returned as they are");
console.log("held chart types: ok");
