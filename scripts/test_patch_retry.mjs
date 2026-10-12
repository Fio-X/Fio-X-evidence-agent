// P2 (NEWSROOM_SPEED_PLAN_PATCH / NEWSROOM_SPEED_CHAIN_PATCH): after a refusal, send only the change.
// Unit cases for the RFC 6902 applier, then the real plan and chain tools on a temp artifact root (fixtures from
// test_hero_value_tool_path.mjs). Offline. `typebox/compile` is a test-only stub built on checkSchema: the strictness of the real
// Compile cannot be checked here (see the report); the wiring, the order of the checks and the fail-closed path are.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_KEYS = ["NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_MOBILE_PAGES", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH"];
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const { applyJsonPatch, PatchError, sha256Of } = await import(join(ROOT, "runtime/pi/patch_retry.mjs"));
const { checkSchema } = await import(join(ROOT, "runtime/pi/tool_chain.mjs"));
// ---- loader: one type-stripped copy of the runtime, a fresh module instance per configuration -----------
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
// One type-stripped copy of the runtime per tree. withCompile=false leaves typebox/compile out (it can only be missing there).
function makeTree(withCompile) {
  const TREE = makeTestTmp("patch-tree-");
  cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
  stub(TREE, "typebox", TYPEBOX);
  if (withCompile) {
    writeFileSync(join(TREE, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: { ".": "./index.js", "./compile": "./compile.js" } }));
    writeFileSync(join(TREE, "node_modules", "typebox", "compile.js"), `import { checkSchema } from ${JSON.stringify(pathToFileURL(join(ROOT, "runtime/pi/tool_chain.mjs")).href)};
export const Compile = (schema) => ({ Check: (v) => checkSchema(schema, v).length === 0, Errors: (v) => checkSchema(schema, v).map((message) => ({ instancePath: "", message })) });\n`);
  }
  stub(TREE, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const COPY = join(TREE, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  return COPY;
}
const COPY_WITH = makeTree(true);
const COPY_WITHOUT = makeTree(false);
const { assessStoryGraph } = await import(join(ROOT, "runtime/pi/story_graph.mjs"));

let loadN = 0;
async function registerFor(cfg, { copy = COPY_WITH, profile = "full" } = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NEWSROOM_TOOL_PROFILE = profile;
  delete process.env.NEWSROOM_PHASE;
  for (const [k, v] of Object.entries(cfg.env)) process.env[k] = v;
  const tools = new Map();
  const mod = await import(`${pathToFileURL(copy).href}?v=${++loadN}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const readerQuestion = "How did the geography and scale of estimated international migration flows change?";
const visualThesis = "A route-led world view connects changing corridors to regional composition and long-run change.";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#fafafa"/><path d="M5 30L95 30" stroke="#111"/><circle cx="75" cy="30" r="5"/></svg>';
const VIZ = [["map", "geo_flow_map", "c-map"], ["sankey", "sankey", "c-flow"], ["trend", "line", "c-trend"]];
// verbatim from test_plan_edit_runtime.mjs: a full artifact root with verified claims, a computation, charts and editorial files
function freshRun(label, { manifestClaim = {}, criticPassed = {}, draft = {}, verifiedOnly = null } = {}) {
  const art = join(makeTestTmp(`planedit-${label}-`), "run");
  for (const d of ["visualizations/critics", "editorial/story-graphs", "editorial/discovery", "editorial/concepts", "editorial/novelty", "editorial/assets", "infographics/plans", "infographics/lints", "infographics/previews", "runtime"]) mkdirSync(join(art, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  cpSync(join(ROOT, "runtime", "pi", "rasterize_svg.py"), join(art, "runtime", "rasterize_svg.py"));
  // Claim-to-chart binding gate: the charts and the claims must come out of one recorded
  // computation that reads a real data/ file (the fixture used to carry no computation at all).
  mkdirSync(join(art, "data"), { recursive: true });
  mkdirSync(join(art, "computations"), { recursive: true });
  const csv = "region,value\nA,1\nB,2\n";
  const csvSha = createHash("sha256").update(csv).digest("hex");
  writeFileSync(join(art, "data", "x.csv"), csv);
  writeFileSync(join(art, "data", "x.meta.json"), JSON.stringify({ file: "x.csv", sha256: csvSha }));
  const computation = { schema_version: "0.7.0", sql: "SELECT region, value FROM 'data/x.csv' ORDER BY region", input_snapshot_hash: csvSha, input_fingerprints: [`data:x.csv:${csvSha}`], read_inputs: [{ path: "data/x.csv", sha256: csvSha }], input_binding: "source_bound", result_hash: csvSha, rows: [{ region: "A", value: 1, delta: 9, year: 2017 }, { region: "B", value: 2, delta: -9, year: 2018 }] };
  const computationRef = `computations/${createHash("sha256").update(JSON.stringify(computation)).digest("hex")}.json`;
  writeFileSync(join(art, computationRef), JSON.stringify(computation));
  const tie = { ...computation, rows: [{ region: "A", value: 9 }, { region: "B", value: 9 }] };
  const tieRef = `computations/${createHash("sha256").update(JSON.stringify(tie)).digest("hex")}.json`;
  writeFileSync(join(art, tieRef), JSON.stringify(tie));
  // c-outcome and c-trend are record_claim claims (no bindings) whose text states the number; c-inline is an inline claim.
  const texts = { "c-outcome": "Region B has the largest value, 2 units, and a change of +9 in the first year.", "c-trend": "Region B reached 2 on the value trend.", "c-rose": "Region B rose to 2 million.", "c-thou": "Region B holds 1,2 units." };
  const inlineClaim = (template, text) => ({ claim: text, claim_template: template, claim_bindings: [{ placeholder: "{max.value}", column: "value", row_index: 1, value: 2, text: "2" }], recorded_by: "newsroom_viz_plan" });
  const regionBinding = { placeholder: "{max.value.region}", column: "region", row_index: 1, value: "B", text: "B" };
  const withRegion = (claim) => ({ ...claim, claim_bindings: [...claim.claim_bindings, regionBinding] });
  // Claims the system bound (claim_bindings): the only ones a hero may use. c-outcome, c-rose and c-thou stay unbound (record_claim).
  const inlines = {
    "c-bound": withRegion(inlineClaim("Region {max.value.region} has the largest value, {max.value} units.", "Region B has the largest value, 2 units.")),
    "c-trend": withRegion(inlineClaim("Region {max.value.region} reached {max.value} on the value trend.", "Region B reached 2 on the value trend.")),
    "c-million": inlineClaim("Output reached {max.value} million tonnes.", "Output reached 2 million tonnes."),
    "c-times": inlineClaim("It is {max.value} 3 times larger.", "It is 2 3 times larger."),
    "c-yi": inlineClaim("Reserves reached {max.value}亿美元 in total.", "Reserves reached 2亿美元 in total."),
    "c-pct": inlineClaim("The share is {max.value}% of the total.", "The share is 2% of the total."),
    "c-pct-sp": inlineClaim("The share is {max.value} % of the total.", "The share is 2 % of the total."),
    "c-pct-sp2": inlineClaim("The share is {max.value}  % of the total.", "The share is 2  % of the total."),
    "c-pct-nbsp": inlineClaim("The share is {max.value}\u00a0% of the total.", "The share is 2\u00a0% of the total."),
    "c-pct-nl": inlineClaim("The share is {max.value}\n% of the total.", "The share is 2\n% of the total."),
    "c-mil-sp2": inlineClaim("Output reached {max.value}  million tonnes.", "Output reached 2  million tonnes."),
    "c-yi-sp": inlineClaim("Reserves reached {max.value} 亿美元 in total.", "Reserves reached 2 亿美元 in total."),
  };
  const inlineTemplate = "The top value is {max.value}% in {max.value.region} in {max.value.year}.";
  const inline = { claim: "The top value is 2% in B in 2018.", claim_template: inlineTemplate, claim_bindings: [
    { placeholder: "{max.value}", column: "value", row_index: 1, value: 2, text: "2" },
    { placeholder: "{max.value.region}", column: "region", row_index: 1, value: "B", text: "B" },
    { placeholder: "{max.value.year}", column: "year", row_index: 1, value: 2018, text: "2018" }], recorded_by: "newsroom_viz_plan" };
  const claims = ["c-map", "c-flow", "c-trend", "c-outcome", "c-inline", "c-rose", "c-thou", "c-million", "c-times", "c-bound", "c-yi", "c-pct", "c-pct-sp", "c-pct-sp2", "c-pct-nbsp", "c-pct-nl", "c-mil-sp2", "c-yi-sp", "c-tie"].filter((id) => !verifiedOnly || verifiedOnly.includes(id)).map((claim_id) => JSON.stringify({ claim_id, status: "verified", source_refs: ["data/x.csv"], computation_refs: [computationRef], verification, ...(texts[claim_id] ? { claim: texts[claim_id] } : {}), ...(claim_id === "c-tie" ? { claim: "Region A has 9 and region B has 9.", computation_refs: [tieRef] } : {}), ...(claim_id === "c-inline" ? inline : {}), ...(inlines[claim_id] ?? {}) }));
  writeFileSync(join(art, "claims.jsonl"), `${claims.join("\n")}\n`);
  for (const [id, chart_type, claim_id] of VIZ) {
    writeFileSync(join(art, `visualizations/${id}.svg`), svg);
    writeFileSync(join(art, `visualizations/${id}.mobile.svg`), svg);
    writeFileSync(join(art, `visualizations/${id}.json`), JSON.stringify({
      chart_type, claim_id: manifestClaim[id] ?? claim_id, computation_ref: computationRef, ...(id === "trend" ? { plan_ref: "visualizations/plans/trend.json" } : {}), source_note: "Gaskin and Abel model estimates, 1990-2023",
      verification_mode: "verified", artifact_status: draft[id] ? "DRAFT" : "VERIFIED", publishable: draft[id] ? false : true,
      variants: { desktop: `visualizations/${id}.svg`, mobile: `visualizations/${id}.mobile.svg` },
    }));
    writeFileSync(join(art, `visualizations/critics/${id}.json`), JSON.stringify({ passed: criticPassed[id] ?? true, score: 90, manifest_ref: `visualizations/${id}.json` }));
  }
  mkdirSync(join(art, "visualizations/plans"), { recursive: true });
  writeFileSync(join(art, "visualizations/plans/trend.json"), JSON.stringify({ measure_semantics: [{ id: "m-value", field: "value", phenomenon: "volume", unit: "t", measure_kind: "mass", temporal_basis: { type: "period" } }] }));
  const graph = assessStoryGraph({
    story_id: "migration", reader_question: readerQuestion, visual_thesis: visualThesis,
    nodes: [
      { id: "n-map", kind: "evidence", summary: "Estimated corridors form a changing world geography.", explanatory_dimension: "spatial", claim_ids: ["c-map"] },
      { id: "n-composition", kind: "evidence", summary: "Regional composition concentrates and disperses over time.", explanatory_dimension: "distribution", claim_ids: ["c-flow"] },
      { id: "n-change", kind: "outcome", summary: "The route system changes in scale and destination structure.", explanatory_dimension: "trend", claim_ids: ["c-trend", "c-outcome"] },
    ],
    edges: [{ from: "n-map", to: "n-composition", relation: "explains" }, { from: "n-composition", to: "n-change", relation: "precedes" }],
    entry_node_ids: ["n-map"], answer_node_ids: ["n-change"],
  });
  writeFileSync(join(art, "editorial/story-graphs/migration.json"), JSON.stringify(graph));
  writeFileSync(join(art, "editorial/discovery/migration.json"), JSON.stringify({ decision: "CONTINUE" }));
  writeFileSync(join(art, "editorial/concepts/migration.json"), JSON.stringify({ finalists: ["route-spine"], discovery_ref: "editorial/discovery/migration.json" }));
  writeFileSync(join(art, "editorial/novelty/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", passed: true }));
  writeFileSync(join(art, "editorial/assets/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", concept_id: "route-spine", decision: "CONTINUE" }));
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  return art;
}

const pageRoot = (label) => freshRun(label);

const quantitative = { quantity_kind: "estimated_flow", mark_semantics: "flow_width", scale_type: "linear", baseline_policy: "not_applicable", uncertainty_disclosed: true, disclosure: "Mean estimates are shown; standard deviation is available in the source data." };
// The model's page plan; reader_question / visual_thesis are left out unless asked for.
function pagePlan({ withQuestion = false, moduleClaims = {}, readerQuestionOverride } = {}) {
  const editorial_grammar = {
    project_id: "migration", primary: "ROUTE_SPINE", supporting: ["THEN_NOW", "SCALE_TRANSLATOR"],
    available_renderer_capabilities: ["svg", "canvas2d"],
    evidence_features: ["origin_destination_relation", "verified_locations", "comparable_timepoints", "quantity", "human_scale_reference"],
    cognitive_goals: ["ORIENT", "ZOOM", "MEASURE", "COMPARE", "CONSEQUENCE"],
  };
  const plan = {
    title: "The routes moved", dek: "A route-led account of changing estimated migration flows.",
    alt: "A world route map, regional Sankey and trend view explain changes in model-estimated international migration flows.",
    layout: "feature", complexity_budget: "medium", intent: "Explain changing migration geography without confusing estimated flows and stocks.",
    primary_message: "The geography and scale of estimated routes changed together.",
    story_graph_ref: "editorial/story-graphs/migration.json", story_arc: "question_answer", audience: "general", quality_target: "publishable", competition_profile: "editorial",
    editorial_discovery_ref: "editorial/discovery/migration.json", visual_concept_ref: "editorial/concepts/migration.json", selected_concept_id: "route-spine",
    novelty_ref: "editorial/novelty/migration.json", asset_plan_ref: "editorial/assets/migration.json", editorial_grammar,
    mobile_module_order: ["map", "flow", "trend", "resolution"],
    scene_graph: { schema_version: "0.2.0", scenes: [
      { id: "orient", pattern: "hero_with_rail", anchor_module_id: "map", sidecar_module_ids: ["flow"], primary_cognitive_goal: "ORIENT", hero_object_id: "route-a", supporting_claim_ids: ["c-map", "c-flow"], scene_budget: { max_supporting_objects: 1, max_annotations: 2, max_claims: 2 } },
      { id: "compare", pattern: "hero_with_rail", anchor_module_id: "trend", sidecar_module_ids: ["resolution"], primary_cognitive_goal: "COMPARE", hero_object_id: "trend", supporting_claim_ids: ["c-trend", "c-outcome"], scene_budget: { max_supporting_objects: 1, max_annotations: 1, max_claims: 2 } },
    ] },
    modules: [
      { id: "map", type: "visual", span: "full", manifest_ref: "visualizations/map.json", critic_ref: "visualizations/critics/map.json", ...(moduleClaims.map ? { claim_ids: moduleClaims.map } : {}), visual_grammar: "spatial", story_node_ids: ["n-map"], story_role: "hook", priority: 1, emphasis: "hero", claim_set: ["c-map"], graphic_object_ids: ["route-a"], annotations: [{ id: "map-note", target_object_id: "route-a", text: "A model-estimated route, not an observed journey.", claim_id: "c-map" }], visual_channels: [{ channel: "size", field: "estimated_flow_mean", role: "quantitative" }, { channel: "connection", field: "origin_destination", role: "identity" }], quantitative_encoding: quantitative },
      { id: "flow", type: "visual", span: "full", manifest_ref: "visualizations/sankey.json", critic_ref: "visualizations/critics/sankey.json", visual_grammar: "flow", story_node_ids: ["n-composition"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: ["c-flow"], graphic_object_ids: ["regional-links"], visual_channels: [{ channel: "length", field: "estimated_flow_mean", role: "quantitative" }, { channel: "connection", field: "region_pair", role: "identity" }], quantitative_encoding: quantitative },
      { id: "trend", type: "visual", span: "full", manifest_ref: "visualizations/trend.json", critic_ref: "visualizations/critics/trend.json", visual_grammar: "trend", story_node_ids: ["n-change"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: ["c-trend"], graphic_object_ids: ["trend-line"], visual_channels: [{ channel: "position", field: "estimated_flow_mean", role: "quantitative" }, { channel: "color", field: "year", role: "categorical" }], quantitative_encoding: { ...quantitative, mark_semantics: "position" } },
      { id: "resolution", type: "text", span: "third", body: "The result is a changed route system, not a direct reading of migrant-stock differences.", claim_ids: ["c-outcome"], claim_set: ["c-outcome"], story_node_ids: ["n-change"], story_role: "resolution", priority: 2, emphasis: "support" },
    ],
  };
  // Appended last, where the chain's fill puts them: the plan hash depends on key order.
  return withQuestion ? { ...plan, reader_question: readerQuestionOverride ?? readerQuestion, visual_thesis: visualThesis } : plan;
}

const keyOrder = (tools, plan) => { const keys = Object.keys(tools.get("newsroom_infographic_plan").parameters.properties); return Object.fromEntries([...keys.filter((k) => k in plan), ...Object.keys(plan).filter((k) => !keys.includes(k))].map((k) => [k, plan[k]])); };
const results = [];
const ok = async (name, f) => { await f(); results.push(name); console.log(`  ok  ${name}`); };
const code = (re) => re;
const rejectsWith = async (promise, re, label) => { let error; try { await promise; } catch (e) { error = e; } must(error && re.test(String(error.message)), `${label}: expected /${re.source}/, got ${error ? error.message.slice(0, 300) : "success"}`); return String(error.message); };

// ---- unit: the applier ----
await ok("applier: add, replace, remove, test on a copy; the base is never changed", async () => {
  const base = { a: { b: 1 }, l: [1, 2], s: "x" };
  const copy = JSON.stringify(base);
  const out = applyJsonPatch(base, [{ op: "test", path: "/a/b", value: 1 }, { op: "replace", path: "/a/b", value: 2 }, { op: "add", path: "/a/c", value: [3] }, { op: "remove", path: "/s" }]);
  assert.deepEqual(out, { a: { b: 2, c: [3] }, l: [1, 2] });
  assert.equal(JSON.stringify(base), copy);
});
await ok("applier: all or nothing, test guards before array ops, no prototype paths, op limit", async () => {
  const base = { l: [1, 2], a: { b: 1 } };
  const fails = (ops, re) => assert.throws(() => applyJsonPatch(base, ops), re);
  fails([{ op: "replace", path: "/a/b", value: 5 }, { op: "test", path: "/a/b", value: 1 }], /PATCH_TEST_FAILED/);
  fails([{ op: "test", path: "/zz", value: 1 }], /PATCH_TEST_FAILED/);
  fails([{ op: "add", path: "/l/-", value: 3 }], /PATCH_ARRAY_UNGUARDED/);
  fails([{ op: "remove", path: "/l/0" }], /PATCH_ARRAY_UNGUARDED/);
  fails([{ op: "replace", path: "/l/0", value: 9 }], /PATCH_ARRAY_UNGUARDED/);
  fails([{ op: "test", path: "/l/1", value: 2 }, { op: "remove", path: "/l/0" }], /PATCH_ARRAY_UNGUARDED/);
  fails([{ op: "remove", path: "/zz" }], /PATCH_INVALID/);
  fails([{ op: "replace", path: "/zz", value: 1 }], /PATCH_INVALID/);
  fails([{ op: "add", path: "/__proto__/x", value: 1 }], /PATCH_INVALID/);
  fails([{ op: "add", path: "/a/constructor", value: 1 }], /PATCH_INVALID/);
  fails([{ op: "add", path: "a/b", value: 1 }], /PATCH_INVALID/);
  fails([{ op: "move", path: "/a", value: 1 }], /PATCH_INVALID/);
  fails([{ op: "add", path: "/a/x" }], /PATCH_INVALID/);
  fails([], /PATCH_INVALID/);
  fails(Array.from({ length: 25 }, () => ({ op: "add", path: "/q", value: 1 })), /PATCH_INVALID/);
  assert.deepEqual(applyJsonPatch(base, [{ op: "test", path: "/l", value: [1, 2] }, { op: "add", path: "/l/-", value: 3 }]).l, [1, 2, 3]);
  assert.equal(JSON.stringify(base), '{"l":[1,2],"a":{"b":1}}');
  assert.equal(sha256Of({ b: 1, a: 2 }), sha256Of({ a: 2, b: 1 }), "the key is canonical");
});

// ---- real tools ----
const ENV_BASE = { NEWSROOM_MOBILE_PAGES: "0", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" };
const HINT = /\nSend only the change: (newsroom_infographic_(?:plan|chain)_patch) patch_of=(infographics\/(?:plan|chain)-rejections\/[0-9a-f]{64}\.json)$/;
const heroPlan = (hero, { question = true, extra } = {}) => {
  const plan = pagePlan({ withQuestion: question });
  plan.modules.push({ id: "hero", type: "hero_stat", span: "third", label: "Largest regional value", claim_id: "c-bound", story_node_ids: ["n-change"], story_role: "evidence", ...hero });
  plan.mobile_module_order = [...plan.mobile_module_order, "hero"];
  return extra ? extra(plan) : plan;
};
const GOOD_HERO = { value_from: "{max.value}" };
const heroAt = 4;
const heroPath = (field) => `/modules/${heroAt}/${field}`;
// The wrong calls (the three hero problems G1 hit, plus the claim and story-node ones) and the patch that fixes each.
const CASES = [
  { name: "W1 hero without value_from", hero: { value: "9" }, re: /HERO_VALUE_FROM_REQUIRED/, bad: [{ op: "remove", path: heroPath("value") }, { op: "add", path: heroPath("value_from"), value: "{first.value}" }], fix: [{ op: "remove", path: heroPath("value") }, { op: "add", path: heroPath("value_from"), value: "{max.value}" }] },
  { name: "W2 typed number in the hero detail", hero: { ...GOOD_HERO, detail: "Forecast for 2099" }, re: /HERO_TYPED_NUMBER.*detail/, bad: [{ op: "replace", path: heroPath("detail"), value: "Forecast for 2098" }], fix: [{ op: "replace", path: heroPath("detail"), value: "Forecast for the period" }] },
  { name: "W3 number word in the hero label", hero: { ...GOOD_HERO, label: "Two-thirds of output" }, re: /HERO_TYPED_NUMBER.*label.*number word/, bad: [{ op: "replace", path: heroPath("label"), value: "Top five regions" }], fix: [{ op: "replace", path: heroPath("label"), value: "Largest regional value" }] },
  { name: "W4 unknown story node", hero: GOOD_HERO, mutate: (plan) => { plan.modules[3].story_node_ids = ["n-bogus"]; return plan; }, re: /references unknown story node 'n-bogus'/, bad: [{ op: "test", path: "/modules/3/story_node_ids/0", value: "n-bogus" }, { op: "replace", path: "/modules/3/story_node_ids/0", value: "n-other" }], fix: [{ op: "test", path: "/modules/3/story_node_ids/0", value: "n-bogus" }, { op: "replace", path: "/modules/3/story_node_ids/0", value: "n-change" }] },
  { name: "W5 unverified claim", hero: { ...GOOD_HERO, claim_id: "c-nope" }, re: /HERO_CLAIM_NOT_VERIFIED/, bad: [{ op: "replace", path: heroPath("claim_id"), value: "c-nope2" }], fix: [{ op: "replace", path: heroPath("claim_id"), value: "c-bound" }] },
];
const wrongPlan = (c, { question }) => { const plan = heroPlan(c.hero, { question }); return c.mutate ? c.mutate(plan) : plan; };
const listing = (art, rel) => { try { return readdirSync(join(art, rel)); } catch { return []; } };
const planDirs = (art) => ({ plans: listing(art, "infographics/plans"), rejections: listing(art, "infographics/plan-rejections"), patches: listing(art, "infographics/plan-patches") });

const planOff = await registerFor({ env: ENV_BASE });
const planOn = await registerFor({ env: { ...ENV_BASE, NEWSROOM_SPEED_PLAN_PATCH: "1" } });
await ok("plan patch switch: off adds nothing; on adds only newsroom_infographic_plan_patch; only exactly '1'", async () => {
  assert.ok(!planOff.has("newsroom_infographic_plan_patch") && planOn.has("newsroom_infographic_plan_patch"));
  assert.deepEqual([...planOn.keys()].filter((n) => n !== "newsroom_infographic_plan_patch").sort(), [...planOff.keys()].sort());
  for (const name of planOff.keys()) assert.equal(JSON.stringify([planOn.get(name).description, planOn.get(name).parameters, planOn.get(name).promptGuidelines]), JSON.stringify([planOff.get(name).description, planOff.get(name).parameters, planOff.get(name).promptGuidelines]), name);
  for (const value of ["true", "0", "", "2"]) assert.ok(!(await registerFor({ env: { ...ENV_BASE, NEWSROOM_SPEED_PLAN_PATCH: value } })).has("newsroom_infographic_plan_patch"), value);
  assert.ok(!(await registerFor({ env: { NEWSROOM_SPEED_PLAN_PATCH: "1" } })).has("newsroom_infographic_plan_patch"), "no atomic writes, no patch tool");
  const noPlan = await registerFor({ env: { ...ENV_BASE, NEWSROOM_SPEED_PLAN_PATCH: "1" } }, { profile: "investigate" });
  assert.ok(!noPlan.has("newsroom_infographic_plan") && !noPlan.has("newsroom_infographic_plan_patch"), "no plan tool in this profile -> no patch tool");
});

for (const c of CASES) {
  await ok(`plan ${c.name}: refused as before (off), refused with the same text plus one line (on), raw params kept, patch fixes it`, async () => {
    // off
    let art = freshRun("plan-off");
    const offMsg = await rejectsWith(planOff.get("newsroom_infographic_plan").execute("o", keyOrder(planOff, wrongPlan(c, { question: true }))), c.re, "off");
    assert.ok(!HINT.test(offMsg), "no hint with the switch off");
    assert.deepEqual(planDirs(art), { plans: [], rejections: [], patches: [] });
    // on
    art = freshRun("plan-on");
    const raw = keyOrder(planOn, wrongPlan(c, { question: true }));
    const rawJson = JSON.stringify(raw);
    const onMsg = await rejectsWith(planOn.get("newsroom_infographic_plan").execute("n", raw), c.re, "on");
    assert.equal(JSON.stringify(raw), rawJson, "the call's params are not changed");
    const hint = HINT.exec(onMsg);
    must(hint, `no hint in: ${onMsg.slice(-200)}`);
    assert.equal(onMsg.slice(0, hint.index), offMsg, "on keeps the off refusal text unchanged");
    assert.equal(hint[2], `infographics/plan-rejections/${sha256Of(JSON.parse(rawJson))}.json`);
    const kept = JSON.parse(readFileSync(join(art, hint[2]), "utf8"));
    assert.deepEqual(kept.params, JSON.parse(rawJson), "raw params, before any fill");
    assert.deepEqual(planDirs(art).plans, [], "a refused plan is still not written");
    // a patch that does not fix it is refused with the same check
    await rejectsWith(planOn.get("newsroom_infographic_plan_patch").execute("p0", { patch_of: hint[2], patch: c.bad }), /HERO_|unknown story node/, "unfixed patch");
    assert.deepEqual(planDirs(art).plans, []);
    // the fix
    const patched = await planOn.get("newsroom_infographic_plan_patch").execute("p1", { patch_of: hint[2], patch: c.fix });
    assert.ok(patched.details.planRef, JSON.stringify(patched).slice(0, 300));
    // same plan as the full call with the same change
    const art2 = freshRun("plan-full");
    const full = await planOff.get("newsroom_infographic_plan").execute("f", applyJsonPatch(JSON.parse(rawJson), c.fix));
    assert.equal(patched.details.planRef, full.details.planRef, "patched plan == full re-send");
    assert.deepEqual(planDirs(art).plans, [patched.details.planRef.split("/").pop()]);
    assert.equal(planDirs(art).patches.length, 2, "one audit record per patch that passed the strict schema check");
    void art2;
  });
}

// ---- plan: the patch tool's own refusals ----
await ok("plan patch refusals: unknown base, base of a call that passed, failing test, schema, bad path; nothing written", async () => {
  const art = freshRun("plan-misc");
  const patchTool = planOn.get("newsroom_infographic_plan_patch");
  const raw = keyOrder(planOn, wrongPlan(CASES[0], { question: true }));
  const msg = await rejectsWith(planOn.get("newsroom_infographic_plan").execute("n", raw), /HERO_VALUE_FROM_REQUIRED/, "first");
  const ref = HINT.exec(msg)[2];
  const before = JSON.stringify(planDirs(art));
  const sha = ref.split("/").pop().replace(".json", "");
  await rejectsWith(patchTool.execute("a", { patch_of: `infographics/plan-rejections/${"0".repeat(64)}.json`, patch: [{ op: "remove", path: "/title" }] }), /PATCH_BASE_NOT_FOUND/, "unknown sha");
  await rejectsWith(patchTool.execute("a", { patch_of: "../../claims.jsonl", patch: [{ op: "remove", path: "/title" }] }), /PATCH_BASE_NOT_FOUND/, "path in patch_of");
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "test", path: heroPath("value"), value: "not-9" }, { op: "remove", path: heroPath("value") }] }), /PATCH_TEST_FAILED/, "test op");
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "remove", path: "/title" }] }), /PATCH_SCHEMA_REJECTED.*title is required/, "required field removed");
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "replace", path: "/title", value: 5 }] }), /PATCH_SCHEMA_REJECTED.*title must be of type string/, "type");
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "remove", path: "/nope/x" }] }), /PATCH_INVALID/, "path outside the params");
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "add", path: "/modules/-", value: {} }] }), /PATCH_ARRAY_UNGUARDED/, "unguarded array op");
  assert.equal(JSON.stringify(planDirs(art)), before, "no plan, no patch record, no new rejection");
  assert.deepEqual(JSON.parse(readFileSync(join(art, ref), "utf8")).params, JSON.parse(JSON.stringify(raw)), "the kept base is untouched");
  // a call that passes keeps nothing, so a patch of it has no base
  const good = heroPlan(GOOD_HERO);
  const passed = await planOn.get("newsroom_infographic_plan").execute("g", keyOrder(planOn, good));
  assert.ok(passed.details.planRef);
  assert.deepEqual(planDirs(art).rejections, [sha + ".json"], "success stores no rejection");
  await rejectsWith(patchTool.execute("a", { patch_of: `infographics/plan-rejections/${sha256Of(JSON.parse(JSON.stringify(keyOrder(planOn, good))))}.json`, patch: [{ op: "remove", path: "/title" }] }), /PATCH_BASE_NOT_FOUND/, "base of a passed call");
});
await ok("plan patch fails closed when typebox/compile cannot be loaded (PATCH_SCHEMA_UNAVAILABLE); the plan tool itself is unaffected", async () => {
  const tools = await registerFor({ env: { ...ENV_BASE, NEWSROOM_SPEED_PLAN_PATCH: "1" } }, { copy: COPY_WITHOUT });
  const art = freshRun("plan-nocompile");
  const msg = await rejectsWith(tools.get("newsroom_infographic_plan").execute("n", keyOrder(tools, wrongPlan(CASES[0], { question: true }))), /HERO_VALUE_FROM_REQUIRED/, "first");
  await rejectsWith(tools.get("newsroom_infographic_plan_patch").execute("p", { patch_of: HINT.exec(msg)[2], patch: CASES[0].fix }), /PATCH_SCHEMA_UNAVAILABLE/, "no compile");
  assert.deepEqual(planDirs(art).plans, []);
  assert.deepEqual(planDirs(art).patches, []);
});

// ---- chain ----
const stubDir = makeTestTmp("patch-raster-");
writeFileSync(join(stubDir, "fixed.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]));
writeFileSync(join(stubDir, "python-stub.sh"), `#!/bin/sh\ncp "${join(stubDir, "fixed.png")}" "$3"\necho '{"engine":"test-stub"}'\n`);
chmodSync(join(stubDir, "python-stub.sh"), 0o755);
process.env.NEWSROOM_PYTHON_BIN = join(stubDir, "python-stub.sh");
const duckdbMissing = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT";
const CH = { ...ENV_BASE, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1" };
const chainOff = await registerFor({ env: CH });
const chainOn = await registerFor({ env: { ...CH, NEWSROOM_SPEED_CHAIN_PATCH: "1" } });
const chainDirs = (art) => ({ rejections: listing(art, "infographics/chain-rejections"), patches: listing(art, "infographics/chain-patches"), plans: listing(art, "infographics/plans"), lints: listing(art, "infographics/lints") });
await ok("chain patch switch: off adds nothing; on adds only newsroom_infographic_chain_patch; needs the chain; only exactly '1'", async () => {
  assert.ok(chainOff.has("newsroom_infographic_chain") && !chainOff.has("newsroom_infographic_chain_patch") && chainOn.has("newsroom_infographic_chain_patch"));
  assert.deepEqual([...chainOn.keys()].filter((n) => n !== "newsroom_infographic_chain_patch").sort(), [...chainOff.keys()].sort());
  for (const name of chainOff.keys()) assert.equal(JSON.stringify([chainOn.get(name).description, chainOn.get(name).parameters, chainOn.get(name).promptGuidelines]), JSON.stringify([chainOff.get(name).description, chainOff.get(name).parameters, chainOff.get(name).promptGuidelines]), name);
  for (const value of ["true", "0", ""]) assert.ok(!(await registerFor({ env: { ...CH, NEWSROOM_SPEED_CHAIN_PATCH: value } })).has("newsroom_infographic_chain_patch"), value);
  assert.ok(!(await registerFor({ env: { ...ENV_BASE, NEWSROOM_SPEED_CHAIN_PATCH: "1" } })).has("newsroom_infographic_chain_patch"), "no chain, no chain patch");
  assert.ok(!(await registerFor({ env: { ...CH, NEWSROOM_SPEED_CHAIN_PATCH: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "0" } })).has("newsroom_infographic_chain_patch"), "no atomic writes, no chain, no chain patch");
  const both = await registerFor({ env: { ...CH, NEWSROOM_SPEED_CHAIN_PATCH: "1", NEWSROOM_SPEED_PLAN_PATCH: "1" } });
  assert.ok(both.has("newsroom_infographic_plan_patch") && both.has("newsroom_infographic_chain_patch"));
});
const chainSteps = (res) => res.details.steps.map((s) => s.tool);
for (const c of CASES) {
  await ok(`chain ${c.name}: refused as before (off), same text plus one line (on), raw params kept before the fill, patch fixes it`, async () => {
    let art = freshRun("chain-off");
    const offMsg = await rejectsWith(chainOff.get("newsroom_infographic_chain").execute("o", wrongPlan(c, { question: false })), c.re, "off");
    assert.ok(!HINT.test(offMsg));
    assert.deepEqual(chainDirs(art).rejections, []);
    art = freshRun("chain-on");
    const raw = wrongPlan(c, { question: false });
    const rawJson = JSON.stringify(raw);
    const onMsg = await rejectsWith(chainOn.get("newsroom_infographic_chain").execute("n", raw), c.re, "on");
    assert.equal(JSON.stringify(raw), rawJson);
    const hint = HINT.exec(onMsg);
    must(hint && hint[1] === "newsroom_infographic_chain_patch" && hint[2].startsWith("infographics/chain-rejections/"), onMsg.slice(-200));
    assert.equal(onMsg.slice(0, hint.index), offMsg);
    const kept = JSON.parse(readFileSync(join(art, hint[2]), "utf8"));
    assert.deepEqual(kept.params, JSON.parse(rawJson));
    assert.ok(!("reader_question" in kept.params), "stored before the story-graph fill");
    await rejectsWith(chainOn.get("newsroom_infographic_chain_patch").execute("p0", { patch_of: hint[2], patch: c.bad }), /HERO_|unknown story node/, "unfixed patch");
    const patched = await chainOn.get("newsroom_infographic_chain_patch").execute("p1", { patch_of: hint[2], patch: c.fix });
    // the same chain result as a full re-send of the same change
    freshRun("chain-full");
    const full = await chainOff.get("newsroom_infographic_chain").execute("f", applyJsonPatch(JSON.parse(rawJson), c.fix));
    assert.equal(patched.details.chainStatus, full.details.chainStatus);
    assert.equal(patched.details.stopCode, full.details.stopCode);
    assert.equal(patched.details.planRef, full.details.planRef);
    assert.deepEqual(chainSteps(patched), chainSteps(full));
    if (!duckdbMissing) assert.equal(patched.details.chainStatus, "COMPLETE", String(patched.content[0].text).slice(0, 400));
    assert.equal(chainDirs(art).patches.length, 2);
  });
}
await ok("chain W6 manifest bound to another claim: STOPPED result carries the hint; a patch that drops the module's claim moves past that stop", async () => {
  const mismatch = { moduleClaims: { map: ["c-map"] } };
  let art = freshRun("chain-w6off", { manifestClaim: { map: "c-flow" } });
  const offRes = await chainOff.get("newsroom_infographic_chain").execute("o", pagePlan(mismatch));
  assert.equal(offRes.details.stopCode, "CLAIM_MANIFEST_MISMATCH");
  assert.ok(!HINT.test(offRes.content[0].text));
  art = freshRun("chain-w6on", { manifestClaim: { map: "c-flow" } });
  const onRes = await chainOn.get("newsroom_infographic_chain").execute("n", pagePlan(mismatch));
  assert.equal(onRes.details.stopCode, "CLAIM_MANIFEST_MISMATCH");
  const hint = HINT.exec(onRes.content[0].text);
  must(hint, "hint on a STOPPED result");
  assert.equal(onRes.content[0].text.slice(0, hint.index), offRes.content[0].text);
  assert.equal(JSON.stringify({ ...onRes, content: undefined }), JSON.stringify({ ...offRes, content: undefined }), "details are identical");
  assert.deepEqual(JSON.parse(readFileSync(join(art, hint[2]), "utf8")).params, JSON.parse(JSON.stringify(pagePlan(mismatch))));
  const patched = await chainOn.get("newsroom_infographic_chain_patch").execute("p", { patch_of: hint[2], patch: [{ op: "remove", path: "/modules/0/claim_ids" }] });
  assert.notEqual(patched.details.stopCode, "CLAIM_MANIFEST_MISMATCH");
  assert.ok(!(patched.details.chainStatus === "STOPPED" && patched.details.stopCode === undefined));
});
await ok("chain P1-P5: the fix completes the chain; a field the first try never sent; base of a passed call; failing test; bad paths", async () => {
  const c = CASES[0];
  const art = freshRun("chain-p");
  const patchTool = chainOn.get("newsroom_infographic_chain_patch");
  const first = wrongPlan(c, { question: false });
  delete first.quality_target; // the first try never sent it
  const msg = await rejectsWith(chainOn.get("newsroom_infographic_chain").execute("n", first), c.re, "first");
  const ref = HINT.exec(msg)[2];
  const sha = ref.split("/").pop().replace(".json", "");
  // P4, P5: refused, nothing written
  const before = JSON.stringify(chainDirs(art));
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "test", path: heroPath("value"), value: "not-9" }, { op: "remove", path: heroPath("value") }] }), /PATCH_TEST_FAILED/, "P4");
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "remove", path: "/nope/x" }] }), /PATCH_INVALID/, "P5 outside");
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "remove", path: "/title" }] }), /PATCH_SCHEMA_REJECTED.*title is required/, "P5 required");
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "add", path: "/modules/-", value: {} }] }), /PATCH_ARRAY_UNGUARDED/, "array");
  assert.equal(JSON.stringify(chainDirs(art)), before);
  // P1 + P2: the fix and an added field in one patch equal a full re-send
  const ops = [...c.fix, { op: "add", path: "/quality_target", value: "publishable" }];
  const patched = await patchTool.execute("p", { patch_of: ref, patch: ops });
  freshRun("chain-p-full");
  const full = await chainOff.get("newsroom_infographic_chain").execute("f", applyJsonPatch(JSON.parse(JSON.stringify(first)), ops));
  assert.equal(patched.details.chainStatus, full.details.chainStatus);
  assert.equal(patched.details.planRef, full.details.planRef);
  assert.deepEqual(chainSteps(patched), chainSteps(full));
  if (!duckdbMissing) assert.equal(patched.details.chainStatus, "COMPLETE");
  // P3: a call that passed left no base
  const art3 = freshRun("chain-p3");
  const good = pagePlan();
  const done = await chainOn.get("newsroom_infographic_chain").execute("g", good);
  if (!duckdbMissing) assert.equal(done.details.chainStatus, "COMPLETE");
  assert.deepEqual(chainDirs(art3).rejections, [], "success stores nothing");
  await rejectsWith(patchTool.execute("a", { patch_of: `infographics/chain-rejections/${sha256Of(JSON.parse(JSON.stringify(good)))}.json`, patch: [{ op: "remove", path: "/title" }] }), /PATCH_BASE_NOT_FOUND/, "P3");
  await rejectsWith(patchTool.execute("a", { patch_of: ref, patch: [{ op: "remove", path: "/title" }] }), /PATCH_BASE_NOT_FOUND|PATCH_SCHEMA_REJECTED/, "other run's base");
});
await ok("chain patch fails closed without typebox/compile (PATCH_SCHEMA_UNAVAILABLE)", async () => {
  const tools = await registerFor({ env: { ...CH, NEWSROOM_SPEED_CHAIN_PATCH: "1" } }, { copy: COPY_WITHOUT });
  const art = freshRun("chain-nocompile");
  const msg = await rejectsWith(tools.get("newsroom_infographic_chain").execute("n", wrongPlan(CASES[0], { question: false })), /HERO_VALUE_FROM_REQUIRED/, "first");
  await rejectsWith(tools.get("newsroom_infographic_chain_patch").execute("p", { patch_of: HINT.exec(msg)[2], patch: CASES[0].fix }), /PATCH_SCHEMA_UNAVAILABLE/, "no compile");
  assert.deepEqual(chainDirs(art).plans, []);
});
console.log(`patch retry: ${results.length} checks -- PASS${duckdbMissing ? " (duckdb missing: COMPLETE not asserted)" : ""}`);
