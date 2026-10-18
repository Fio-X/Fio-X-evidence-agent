// NEWSROOM_VERIFIED_LOCATIONS_BACKED (default on, exactly "0" turns it off): a model's own verified_locations does not count toward a grammar.
// It counts only when every map module of the page has location evidence written by the program (checkLocationEvidence, locationProofFor).
// Real plan tool on a temp artifact root (fixtures from test_first_try_text.mjs). Offline. The fixture plan asks for ROUTE_SPINE on a self-report.
import "./location_backing_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { symlinkSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_KEYS = ["NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_FIRST_TRY_TEXT", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH", "NEWSROOM_SPEED_REPORT_ALL"];
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

const { buildLocationEvidence, locationEvidenceText } = await import(join(ROOT, "runtime/pi/location_evidence.mjs"));
const { locationProofFor } = await import(join(ROOT, "runtime/pi/location_proof.mjs"));
const { LOCATION_NOT_BACKED_NOTE, materializeEditorialGrammarSelection, materializeLeanEditorialGrammarSelection } = await import(join(ROOT, "runtime/pi/editorial_grammar.mjs"));
const SW = "NEWSROOM_VERIFIED_LOCATIONS_BACKED";
const results = [];
const ok = async (name, f) => { await f(); results.push(name); console.log(`  ok  ${name}`); };
const ENV_BASE = { NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" };
const tools = await registerFor({ env: ENV_BASE });
const setSwitch = (v) => { if (v === undefined) delete process.env[SW]; else process.env[SW] = v; };
const readPlan = (art) => { const dir = join(art, "infographics/plans"); const [f] = readdirSync(dir); return JSON.parse(readFileSync(join(dir, f), "utf8")); };
const REASON = "location_evidence_missing:verified_locations";
const reasons = (plan) => (plan.editorial_grammar?.decision_log ?? []).filter((r) => r.reason_code === REASON);
// A choropleth map manifest with program-written evidence for 5 rows (same rows as test_location_evidence.mjs).
const ROWS = ["NO", "NL", "BE", "US", "FR"].map((c, i) => ({ iso2: c, value: 100 - i }));
const SPEC = { chart_type: "choropleth", category_field: "iso2", category_names: "iso2" };
function backMap(art, { chart_type = "choropleth", evidence = buildLocationEvidence(ROWS, SPEC), tamper = false, ref = "visualizations/locations/map.json" } = {}) {
  const m = JSON.parse(readFileSync(join(art, "visualizations/map.json"), "utf8"));
  const { text, sha256 } = locationEvidenceText(evidence);
  mkdirSync(dirname(join(art, ref)), { recursive: true });
  writeFileSync(join(art, ref), tamper ? text.replace("FRA", "DEU") : text);
  writeFileSync(join(art, "visualizations/map.json"), JSON.stringify({ ...m, chart_type, row_count: ROWS.length, location_evidence_ref: ref, location_evidence_sha256: sha256 }));
}
const plan = (art) => tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, pagePlan({ withQuestion: true })));
const run = async (label, { before, sw } = {}) => {
  setSwitch(sw);
  const art = freshRun(label);
  if (before) before(art);
  try { const r = await plan(art); return { art, message: null, text: r.content?.[0]?.text ?? "" }; } catch (e) { return { art, message: String(e.message), text: "" }; }
};
const INELIGIBLE = /EDITORIAL_GRAMMAR_PRIMARY_INELIGIBLE.*ROUTE_SPINE/;

await ok("VL1 a self-reported verified_locations with no evidence is dropped: the eligibility check refuses ROUTE_SPINE", async () => {
  const r = await run("vl1");
  assert.match(r.message ?? "", INELIGIBLE);
  assert.match(r.message, /your reported verified_locations was dropped: it counts only when every map module of the page is a map rendered with location evidence in this run/, "the refusal says the report was dropped and what makes it count");
  assert.doesNotMatch(r.message, /\/(private|Users|tmp|var)\//, "no absolute path in the refusal");
});
await ok("VL2 the switch exactly \"0\" restores the old behaviour (the self-report is taken)", async () => {
  const r = await run("vl2", { sw: "0" });
  assert.equal(r.message, null);
  assert.equal(reasons(readPlan(r.art)).length, 0);
});
await ok("VL3 any other value than \"0\" keeps it on", async () => {
  for (const v of ["", "1", "false", "off"]) assert.match((await run("vl3", { sw: v })).message ?? "", INELIGIBLE, `value ${JSON.stringify(v)}`);
});
await ok("VL4 producer switch off (NEWSROOM_LOCATION_EVIDENCE unset): a real choropleth plan has no evidence file, nothing is backed", async () => {
  delete process.env.NEWSROOM_LOCATION_EVIDENCE;
  const r = await run("vl4", { before: (art) => { const m = JSON.parse(readFileSync(join(art, "visualizations/map.json"), "utf8")); writeFileSync(join(art, "visualizations/map.json"), JSON.stringify({ ...m, chart_type: "choropleth" })); } });
  assert.match(r.message ?? "", INELIGIBLE);
});
await ok("VL5 program-written evidence for the page's map backs the report: the plan is stored and the grammar keeps verified_locations", async () => {
  const r = await run("vl5", { before: (art) => backMap(art) });
  assert.equal(r.message, null);
  const p = readPlan(r.art);
  assert.ok(p.editorial_grammar.evidence_features.includes("verified_locations"));
  assert.equal(reasons(p).length, 0);
  assert.doesNotMatch(r.text, /location-evidence artifact/);
});
await ok("VL6 evidence that does not check out is not backing (hash mismatch, partly unmatched rows)", async () => {
  assert.match((await run("vl6a", { before: (art) => backMap(art, { tamper: true }) })).message ?? "", INELIGIBLE);
  // Each of the next two trips exactly one of the checks (row_count_mismatch / not_all_matched), so removing either check turns one of them red.
  const four = ROWS.slice(0, 4);
  assert.match((await run("vl6b", { before: (art) => backMap(art, { evidence: buildLocationEvidence([...four, { iso2: "ZZ", value: 1 }], SPEC) }) })).message ?? "", INELIGIBLE, "5 rows, one unmatched: only not_all_matched");
  assert.match((await run("vl6c", { before: (art) => backMap(art, { evidence: buildLocationEvidence([...ROWS, { iso2: "DE", value: 1 }], SPEC) }) })).message ?? "", INELIGIBLE, "6 rows all matched against a manifest of 5: only row_count_mismatch");
});
await ok("VL7 a map chart with no evidence is not backing: a coordinate map, and a choropleth without an evidence ref", async () => {
  assert.match((await run("vl7a", { before: (art) => backMap(art, { chart_type: "geo_flow_map" }) })).message ?? "", INELIGIBLE);
  const bare = await run("vl7b", { before: (art) => { const m = JSON.parse(readFileSync(join(art, "visualizations/map.json"), "utf8")); writeFileSync(join(art, "visualizations/map.json"), JSON.stringify({ ...m, chart_type: "choropleth", row_count: 5 })); } });
  assert.match(bare.message ?? "", INELIGIBLE);
});
await ok("VL8 evidence of another run is not counted: a ref that points outside this run's visualizations/locations/ proves nothing", async () => {
  const other = freshRun("vl8-other"); backMap(other);
  const r = await run("vl8", { before: (art) => backMap(art) });
  assert.equal(r.message, null); // control: this run's own evidence backs it
  const stolen = await run("vl8b", { before: (art) => { backMap(art); const m = JSON.parse(readFileSync(join(art, "visualizations/map.json"), "utf8")); writeFileSync(join(art, "visualizations/map.json"), JSON.stringify({ ...m, location_evidence_ref: `../../${other.split("/").slice(-2).join("/")}/visualizations/locations/map.json` })); } });
  assert.match(stolen.message ?? "", INELIGIBLE);
  const absolute = await run("vl8c", { before: (art) => { backMap(art); const m = JSON.parse(readFileSync(join(art, "visualizations/map.json"), "utf8")); writeFileSync(join(art, "visualizations/map.json"), JSON.stringify({ ...m, location_evidence_ref: join(other, "visualizations/locations/map.json") })); } });
  assert.match(absolute.message ?? "", INELIGIBLE);
});
await ok("VL13 a page with no map module that reports verified_locations proves nothing (locationProofFor needs at least one map)", async () => {
  assert.equal(locationProofFor([], {}), false);
  const trend = [{ id: "t", type: "visual", chart: "line" }, { id: "r", type: "text" }];
  assert.equal(locationProofFor(trend, { t: { chart_type: "line", ok: true } }), false);
  assert.equal(locationProofFor(trend, {}), false);
  assert.equal(locationProofFor([{ id: "m", type: "visual" }], { m: { chart_type: "choropleth", ok: true } }), true, "control: a checked choropleth counts");
});
await ok("VL14 an evidence ref inside this run but not under visualizations/locations/ is not backing", async () => {
  assert.match((await run("vl14", { before: (art) => backMap(art, { ref: "visualizations/other/map.json" }) })).message ?? "", INELIGIBLE);
  assert.match((await run("vl14b", { before: (art) => backMap(art, { ref: "data/map-evidence.json" }) })).message ?? "", INELIGIBLE);
});
await ok("VL15 evidence that names another basemap hash is not backing, even when the manifest hash matches the file", async () => {
  const forged = { ...buildLocationEvidence(ROWS, SPEC), basemap_content_hash: "0".repeat(64) };
  assert.match((await run("vl15", { before: (art) => backMap(art, { evidence: forged }) })).message ?? "", INELIGIBLE);
});
await ok("VL16 an unreadable or corrupt map manifest backs nothing (a missing file, and one that is not JSON)", async () => {
  assert.match((await run("vl16a", { before: (art) => { backMap(art); rmSync(join(art, "visualizations/map.json")); } })).message ?? "", INELIGIBLE);
  assert.match((await run("vl16b", { before: (art) => { backMap(art); writeFileSync(join(art, "visualizations/map.json"), "{ not json"); } })).message ?? "", INELIGIBLE);
});
await ok("VL17 a symlink under visualizations/locations/ that points outside the run backs nothing, even when the manifest hash matches the file", async () => {
  const outside = join(makeTestTmp("vl17-out-"), "evidence.json");
  const r = await run("vl17", { before: (art) => {
    backMap(art);
    const link = join(art, "visualizations/locations/map.json");
    writeFileSync(outside, readFileSync(link, "utf8"));
    rmSync(link); symlinkSync(outside, link);
  } });
  assert.match(r.message ?? "", INELIGIBLE);
  // control: the same bytes as a plain file back it (VL5)
});
await ok("VL18 the evidence ref must be the one written for this manifest: another key's file in locations/ is not backing", async () => {
  const r = await run("vl18", { before: (art) => backMap(art, { ref: "visualizations/locations/other.json" }) });
  assert.match(r.message ?? "", INELIGIBLE);
});
await ok("VL9 the drop is written down: a reject row in the decision log and the note in the tool result (unit level, both paths)", async () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "config/editorial-grammar-registry.json"), "utf8"));
  const input = { project_id: "m", primary: "THEN_NOW", supporting: [], available_renderer_capabilities: ["svg"], evidence_features: ["comparable_timepoints", "verified_locations"], cognitive_goals: ["ORIENT"] };
  const sel = materializeEditorialGrammarSelection(input, registry, { locationsProven: false });
  assert.ok(!sel.evidence_features.includes("verified_locations"));
  const row = sel.decision_log.find((r) => r.reason_code === REASON);
  assert.ok(row && row.outcome === "reject", "a reject row, not a silent drop");
  assert.ok(sel.decision_log.at(-1).stage === "final_selection", "the final row stays last");
  assert.match(LOCATION_NOT_BACKED_NOTE, /your reported verified_locations was dropped: it counts only when every map module of the page is a map rendered with location evidence in this run/);
  const kept = materializeEditorialGrammarSelection(input, registry, { locationsProven: true });
  assert.ok(kept.evidence_features.includes("verified_locations") && !kept.decision_log.some((r) => r.reason_code === REASON));
  const old = materializeEditorialGrammarSelection(input, registry, {});
  assert.ok(old.evidence_features.includes("verified_locations") && !old.decision_log.some((r) => r.reason_code === REASON));
});
await ok("VL10 lean path: reported_evidence_features is ignored for verified_locations too, and human_scale_reference is unchanged", async () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "config/editorial-grammar-registry.json"), "utf8"));
  const pp = pagePlan({ withQuestion: true });
  const input = { reported_evidence_features: ["verified_locations", "human_scale_reference"] };
  const spec = (locationsProven) => ({ modules: pp.modules, scene_graph: pp.scene_graph, chartTypes: { map: "geo_flow_map", flow: "sankey", trend: "line" }, story_graph_ref: pp.story_graph_ref, locationsProven });
  // The full page needs ROUTE_SPINE: with the report dropped the program-side check finds no legal combination (the existing refusal).
  assert.throws(() => materializeLeanEditorialGrammarSelection(input, spec(false), registry), /EDITORIAL_GRAMMAR_NO_LEGAL_COMBINATION.*your reported verified_locations was dropped: it counts only when every map module of the page is a map rendered with location evidence in this run/);
  // The lean-only schema text (the tool is registered without lean gates here, so read the source): it must not call verified_locations "places you checked".
  const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.ok(src.includes("A reported verified_locations is dropped: it counts only when every map module of the page is a map rendered with location evidence in this run"));
  assert.ok(!src.includes("places you checked"));
  const backed = materializeLeanEditorialGrammarSelection(input, spec(true), registry);
  assert.ok(backed.evidence_features.includes("verified_locations") && !backed.decision_log.some((r) => r.reason_code === REASON));
  const off = materializeLeanEditorialGrammarSelection(input, spec(undefined), registry);
  assert.ok(off.evidence_features.includes("verified_locations") && !off.decision_log.some((r) => r.reason_code === REASON));
  // A page that does not need it is stored, the report is dropped and written down; human_scale_reference is unchanged (V4).
  const small = { ...spec(false), modules: pp.modules.filter((m) => ["trend", "resolution"].includes(m.id)), scene_graph: { ...pp.scene_graph, scenes: pp.scene_graph.scenes.filter((sc) => sc.id === "compare") }, chartTypes: { trend: "line" } };
  const dropped = materializeLeanEditorialGrammarSelection(input, small, registry);
  assert.ok(!dropped.evidence_features.includes("verified_locations"));
  assert.ok(dropped.evidence_features.includes("human_scale_reference"), "V4: the other self-report is not tightened");
  const row = dropped.decision_log.find((r) => r.reason_code === REASON);
  assert.ok(row && row.outcome === "reject" && dropped.decision_log.indexOf(row) < dropped.decision_log.findIndex((r) => r.stage === "final_selection"), "the reject row sits before the final row");
  assert.ok(!materializeLeanEditorialGrammarSelection(input, { ...small, locationsProven: undefined }, registry).decision_log.some((r) => r.reason_code === REASON));
});
await ok("VL11 the plan tool result carries the note when the report was dropped (a page that does not need it is still stored)", async () => {
  setSwitch(undefined);
  const art = freshRun("vl11");
  const p = pagePlan({ withQuestion: true });
  p.editorial_grammar.primary = "THEN_NOW"; p.editorial_grammar.supporting = ["SCALE_TRANSLATOR"];
  const r = await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, p));
  assert.match(r.content[0].text, /Note: your reported verified_locations was dropped: it counts only when every map module of the page is a map rendered with location evidence in this run\./);
});
await ok("VL12 lean gates, tool level: the reported_evidence_features path is wired (dropped without evidence; switch 0 takes it)", async () => {
  process.env.NEWSROOM_LEAN_GATES = "1";
  try {
    // No primary asked for: the program picks a legal one, so the stored evidence_features show what counted.
    const leanPlan = () => { const p = pagePlan({ withQuestion: true }); p.editorial_grammar = { reported_evidence_features: ["verified_locations"] }; return p; };
    const go = async (label, before, sw) => { setSwitch(sw); const art = freshRun(label); before?.(art); try { await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, leanPlan())); return { art, message: null }; } catch (e) { return { art, message: String(e.message) }; } };
    const without = await go("vl12a");
    if (without.message === null) {
      const p = readPlan(without.art);
      assert.ok(!p.editorial_grammar.evidence_features.includes("verified_locations"));
      assert.equal(reasons(p).length, 1);
    } else assert.match(without.message, /EDITORIAL_GRAMMAR_/, without.message);
    // (No backed case here: the fixture page is a flow map + sankey + trend, and only a choropleth has evidence, so no legal combination exists for it;
    // the backed lean case is VL10 at unit level.)
    const old = await go("vl12c", undefined, "0");
    assert.equal(old.message, null, old.message ?? "");
    assert.ok(readPlan(old.art).editorial_grammar.evidence_features.includes("verified_locations"));
  } finally { delete process.env.NEWSROOM_LEAN_GATES; }
});
console.log(`verified_locations backed: ${results.length} checks -- PASS`);
