// P1 (NEWSROOM_SPEED_REPORT_ALL): the plan tool reports the independent hero and grammar problems in one refusal.
// Real plan tool on a temp artifact root (fixtures from test_hero_value_tool_path.mjs). Offline.
// (the typebox/compile stub below is only used by the shared tree builder: of the real
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
const ENV_KEYS = ["NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH", "NEWSROOM_SPEED_REPORT_ALL"];
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const { applyJsonPatch, PatchError, combinedError, sha256Of } = await import(join(ROOT, "runtime/pi/patch_retry.mjs"));
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
const ENV_BASE = {};
// The switch is read when a call runs, so every call sets the process env from the value its tool set was made with.
const withSwitch = async (value) => { const tools = await registerFor({ env: { ...ENV_BASE, ...(value === undefined ? {} : { NEWSROOM_SPEED_REPORT_ALL: value }) } }); tools.switchValue = value; return tools; };
const useSwitch = (tools) => { if (tools.switchValue === undefined) delete process.env.NEWSROOM_SPEED_REPORT_ALL; else process.env.NEWSROOM_SPEED_REPORT_ALL = tools.switchValue; };
const off = await withSwitch(undefined);
const on = await withSwitch("1");
const heroPlan = (hero, mutate) => {
  const plan = pagePlan({ withQuestion: true });
  plan.modules.push({ id: "hero", type: "hero_stat", span: "third", label: "Largest regional value", claim_id: "c-bound", story_node_ids: ["n-change"], story_role: "evidence", ...hero });
  plan.mobile_module_order = [...plan.mobile_module_order, "hero"];
  return mutate ? mutate(plan) : plan;
};
const GOOD = { value_from: "{max.value}" };
const attempt = async (tools, plan, { claims } = {}) => { useSwitch(tools); const art = freshRun("ra", { verifiedOnly: claims }); try { await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, plan)); return { art, message: null }; } catch (e) { return { art, message: String(e.message) }; } };
const codes = (message) => [...message.matchAll(/^([A-Z][A-Z0-9_]{3,}):/gm)].map((m) => m[1]);
const planCount = (art) => { try { return readdirSync(join(art, "infographics/plans")).length; } catch { return 0; } };

await ok("switch: off and on list the same tools with the same text; only exactly '1' turns it on", async () => {
  assert.deepEqual([...on.keys()], [...off.keys()]);
  for (const name of off.keys()) assert.equal(JSON.stringify([on.get(name).description, on.get(name).parameters, on.get(name).promptGuidelines]), JSON.stringify([off.get(name).description, off.get(name).parameters, off.get(name).promptGuidelines]), name);
  const bad = heroPlan({ detail: "Forecast for 2099" }, (plan) => { plan.modules[4].label = "Top 5 regions"; return plan; });
  const base = await attempt(off, bad);
  for (const value of ["true", "0", "", "2"]) {
    const t = await withSwitch(value);
    assert.equal((await attempt(t, bad)).message, base.message, value);
  }
});

// One case per hero site (the refusals of test_hero_value_tool_path.mjs), run with the switch off and on.
const SITES = [
  ["value_from required", { value: "9" }, /HERO_VALUE_FROM_REQUIRED/],
  ["placeholder of another column", { value_from: "{max.delta}" }, /HERO_PLACEHOLDER_UNBOUND/],
  ["another row", { value_from: "{first.value}" }, /HERO_PLACEHOLDER_UNBOUND/],
  ["typed value with value_from", { value_from: "{max.value}", value: "9" }, /HERO_VALUE_TYPED/],
  ["typed value in the detail", { value_from: "{max.value}", detail: "Forecast for 2099" }, /HERO_TYPED_NUMBER.*detail/],
  ["number word in the label", { value_from: "{max.value}", label: "Two-thirds of output" }, /HERO_TYPED_NUMBER.*label.*number word/],
  ["number word in the detail", { value_from: "{max.value}", detail: "Top five regions" }, /HERO_TYPED_NUMBER.*detail.*number word/],
  ["unit the claim does not show", { value_from: "{max.value}", unit: "万" }, /HERO_UNIT_NOT_ALLOWED/],
  ["unit on a measure with no unit", { value_from: "{max.value}", unit: "kg" }, /HERO_UNIT_NOT_ALLOWED/],
  ["unmatched brace in the label", { value_from: "{max.value}", label: "Largest {max.value" }, /HERO_TEMPLATE_INVALID/],
  ["claim not verified", { value_from: "{max.value}", claim_id: "c-nope" }, /HERO_CLAIM_NOT_VERIFIED/],
  ["claim without bindings", { value_from: "{max.value}", claim_id: "c-outcome" }, /HERO_/],
];
for (const [name, hero, re] of SITES) {
  await ok(`site ${name}: refused with the switch off and on; the on message starts with the off message; no plan written`, async () => {
    const a = await attempt(off, heroPlan(hero));
    const b = await attempt(on, heroPlan(hero));
    assert.ok(a.message && re.test(a.message), String(a.message).slice(0, 200));
    assert.ok(b.message && re.test(b.message), String(b.message).slice(0, 200));
    for (const code of codes(a.message)) assert.ok(codes(b.message).includes(code), `${code} lost`);
    assert.ok(b.message.startsWith(a.message), "the first problem's text is unchanged");
    assert.equal(planCount(a.art) + planCount(b.art), 0);
  });
}
await ok("t11: value_from missing plus a typed number in the label and in the detail: 1 problem off, 3 on", async () => {
  const hero = { label: "Top 5 regions", detail: "Up 12% since 2019" };
  const a = await attempt(off, heroPlan(hero));
  const b = await attempt(on, heroPlan(hero));
  assert.deepEqual(codes(a.message), ["HERO_VALUE_FROM_REQUIRED"]);
  assert.deepEqual(codes(b.message), ["HERO_VALUE_FROM_REQUIRED", "HERO_TYPED_NUMBER", "HERO_TYPED_NUMBER"]);
  assert.match(b.message, /label has a typed number/);
  assert.match(b.message, /detail has a typed number/);
  assert.ok(b.message.startsWith(a.message));
  assert.equal(planCount(b.art), 0);
});
await ok("a value problem plus a text problem: both reported; one problem alone is the off error", async () => {
  const hero = { value_from: "{max.value}", unit: "kg", detail: "Forecast for 2099" };
  const a = await attempt(off, heroPlan(hero));
  const b = await attempt(on, heroPlan(hero));
  assert.deepEqual(codes(a.message), ["HERO_UNIT_NOT_ALLOWED"]);
  assert.deepEqual(codes(b.message), ["HERO_UNIT_NOT_ALLOWED", "HERO_TYPED_NUMBER"]);
  const one = await attempt(on, heroPlan({ value_from: "{max.value}", detail: "Forecast for 2099" }));
  assert.deepEqual(codes(one.message), ["HERO_TYPED_NUMBER"]);
  assert.equal(one.message, (await attempt(off, heroPlan({ value_from: "{max.value}", detail: "Forecast for 2099" }))).message);
});
await ok("two hero modules, each with a problem: both reported", async () => {
  const plan = heroPlan({ label: "Top 5 regions", value_from: "{max.value}" }, (p) => { p.modules.push({ id: "hero2", type: "hero_stat", span: "third", label: "Second value", claim_id: "c-bound", story_node_ids: ["n-change"], story_role: "evidence", value: "9" }); p.mobile_module_order = [...p.mobile_module_order, "hero2"]; return p; });
  const a = await attempt(off, plan);
  const b = await attempt(on, plan);
  assert.equal(codes(a.message).length, 1);
  assert.deepEqual(codes(b.message), ["HERO_TYPED_NUMBER", "HERO_VALUE_FROM_REQUIRED"]);
  assert.match(b.message, /'hero'.*\n.*'hero2'/);
});
await ok("grammar build problem plus a hero problem: both reported; grammar alone is the off error", async () => {
  const unknownFeature = (p) => { p.editorial_grammar.evidence_features = [...p.editorial_grammar.evidence_features, "not_a_feature"]; return p; };
  const badPrimary = (p) => { p.editorial_grammar.primary = "NOT_A_GRAMMAR"; return p; };
  for (const [mutate, code] of [[unknownFeature, "EDITORIAL_GRAMMAR_EVIDENCE_FEATURE_UNKNOWN"], [badPrimary, "EDITORIAL_GRAMMAR_PRIMARY_INELIGIBLE"]]) {
    const aloneOff = await attempt(off, heroPlan(GOOD, mutate));
    const aloneOn = await attempt(on, heroPlan(GOOD, mutate));
    assert.deepEqual(codes(aloneOff.message), [code]);
    assert.equal(aloneOn.message, aloneOff.message, "grammar alone: the off error");
    const both = await attempt(on, heroPlan({ label: "Top 5 regions", value_from: "{max.value}" }, mutate));
    assert.deepEqual(codes(both.message), [code, "HERO_TYPED_NUMBER"]);
    const bothOff = await attempt(off, heroPlan({ label: "Top 5 regions", value_from: "{max.value}" }, mutate));
    assert.deepEqual(codes(bothOff.message), [code]);
    assert.equal(planCount(both.art), 0);
  }
});
await ok("a plan without problems is stored identically with the switch off and on", async () => {
  const a = await attempt(off, heroPlan(GOOD));
  const artB = freshRun("ra-ok");
  useSwitch(on);
  const res = await on.get("newsroom_infographic_plan").execute("p", keyOrder(on, heroPlan(GOOD)));
  assert.equal(a.message, null);
  assert.equal(planCount(a.art), 1);
  assert.equal(readdirSync(join(artB, "infographics/plans"))[0], res.details.planRef.split("/").pop());
  assert.equal(res.details.planRef.split("/").pop(), readdirSync(join(a.art, "infographics/plans"))[0]);
});
await ok("the combined error keeps the first problem's own properties and class", async () => {
  const first = Object.assign(new PatchError("PATCH_TEST_FAILED", "first"), { detail: { at: "/modules/0" } });
  const both = combinedError(first, "PATCH_TEST_FAILED: first\nHERO_TYPED_NUMBER: second");
  assert.ok(both instanceof PatchError && both instanceof Error);
  assert.equal(both.code, first.code);
  assert.equal(both.name, first.name);
  assert.deepEqual(both.detail, first.detail);
  assert.deepEqual(Object.keys(both), Object.keys(first));
  assert.equal(both.message, "PATCH_TEST_FAILED: first\nHERO_TYPED_NUMBER: second");
  assert.ok(both.stack.startsWith(`${first.name}: PATCH_TEST_FAILED: first\n`));
  const plain = Object.assign(new Error("EDITORIAL_GRAMMAR_PRIMARY_INELIGIBLE: x"), { code: "EDITORIAL_GRAMMAR_PRIMARY_INELIGIBLE" });
  assert.equal(combinedError(plain, "a\nb").code, "EDITORIAL_GRAMMAR_PRIMARY_INELIGIBLE");
  assert.equal(combinedError("not an error", "a\nb").message, "a\nb");
  // Through the real plan tool: two hero problems, and the thrown error is still an Error with the listed codes.
  const plan = heroPlan({ label: "Top 5 regions", value_from: "{max.value}" }, (p) => { p.modules.push({ id: "hero2", type: "hero_stat", span: "third", label: "Second value", claim_id: "c-bound", story_node_ids: ["n-change"], story_role: "evidence", value: "9" }); p.mobile_module_order = [...p.mobile_module_order, "hero2"]; return p; });
  useSwitch(on); freshRun("ra-p1");
  const thrown = await on.get("newsroom_infographic_plan").execute("p", keyOrder(on, plan)).then(() => null, (e) => e);
  assert.ok(thrown instanceof Error);
  assert.deepEqual(codes(thrown.message), ["HERO_TYPED_NUMBER", "HERO_VALUE_FROM_REQUIRED"]);
});
console.log(`report all: ${results.length} checks -- PASS`);
