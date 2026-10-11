// P4 (NEWSROOM_SPEED_FIRST_TRY_TEXT): text only. FT1-FT13: the added sentences are the only difference, every wrong call is still refused.
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
const ENV_KEYS = ["NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_MOBILE_PAGES", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_FIRST_TRY_TEXT", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH", "NEWSROOM_SPEED_REPORT_ALL"];
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

const SW = "NEWSROOM_SPEED_FIRST_TRY_TEXT";
const results = [];
const ok = async (name, f) => { await f(); results.push(name); console.log(`  ok  ${name}`); };
const ENV_BASE = { NEWSROOM_MOBILE_PAGES: "0", NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" };
const withSwitch = async (value) => { const tools = await registerFor({ env: { ...ENV_BASE, ...(value === undefined ? {} : { [SW]: value }) } }); tools.switchValue = value; return tools; };
const useSwitch = (tools) => { if (tools.switchValue === undefined) delete process.env[SW]; else process.env[SW] = tools.switchValue; };
const off = await withSwitch(undefined);
const on = await withSwitch("1");
const NAMES = ["newsroom_update_plan", "newsroom_viz_plan", "newsroom_infographic_plan"];
const DERIVED = ["newsroom_viz_chain"]; // copies newsroom_viz_plan's properties, so it carries the same added claim sentence
// every description string of a tool, in walk order, with the path it sits at
const descriptions = (tool) => { const out = []; const walk = (node, path) => { if (!node || typeof node !== "object") return; if (typeof node.description === "string") out.push([path, node.description]); for (const [k, v] of Object.entries(node)) if (k !== "description") walk(v, `${path}/${k}`); }; walk(tool.parameters, ""); out.unshift(["tool", tool.description]); return out; };
const stripped = (tool) => JSON.stringify(tool.parameters, (k, v) => (k === "description" ? undefined : v));
const bytes = (t) => Buffer.byteLength(t);
const deltas = (name) => { const a = new Map(descriptions(off.get(name))), b = new Map(descriptions(on.get(name))); const out = []; for (const [path, text] of b) { const before = a.get(path); if (before !== text) { assert.ok(before === undefined ? true : text.startsWith(before), `${name}${path}: on text starts with the off text`); out.push({ path, added: bytes(text) - bytes(before ?? "") , text: before === undefined ? text : text.slice(before.length) }); } } return out; };
const heroPlan = (hero, mutate) => {
  const plan = pagePlan({ withQuestion: true });
  plan.modules.push({ id: "hero", type: "hero_stat", span: "third", label: "Largest regional value", claim_id: "c-bound", story_node_ids: ["n-change"], story_role: "evidence", ...hero });
  plan.mobile_module_order = [...plan.mobile_module_order, "hero"];
  return mutate ? mutate(plan) : plan;
};
const attempt = async (tools, plan) => { useSwitch(tools); const art = freshRun("ft"); try { await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, plan)); return { art, message: null }; } catch (e) { return { art, message: String(e.message) }; } };
const planCount = (art) => { try { return readdirSync(join(art, "infographics/plans")).length; } catch { return 0; } };
const sum = (name) => deltas(name).reduce((n, d) => n + d.added, 0);

await ok("FT1 update_plan: status gets a description; the schema (types, enum, required) is byte-identical without descriptions", async () => {
  const d = deltas("newsroom_update_plan");
  assert.equal(d.length, 1);
  assert.equal(d[0].added, 67);
  assert.equal(stripped(on.get("newsroom_update_plan")), stripped(off.get("newsroom_update_plan")));
});
await ok("FT2 update_plan: the t1 call (three steps with no status) is refused with the switch off and on, same issues", async () => {
  const call = { goal: "g", steps: [{ id: "s1", action: "a" }, { id: "s2", action: "b" }, { id: "s3", action: "c" }] };
  const a = checkSchema(off.get("newsroom_update_plan").parameters, call), b = checkSchema(on.get("newsroom_update_plan").parameters, call);
  assert.ok(a.length >= 3 && a.some((m) => /status/.test(m)));
  assert.deepEqual(b, a);
});
await ok("FT3 viz claim: the number-word claim (t3) is refused with the same error with the switch off and on; the claim description gains 136 B", async () => {
  const { fillClaimTemplate } = await import(pathToFileURL(COPY_WITH).href + "?v=ft3");
  const rows = [{ year: 1900, n: 1 }];
  const attemptClaim = (tools) => { useSwitch(tools); try { fillClaimTemplate("十个最热年份中最早的一年距平 {max.n}", rows, ["n"]); return null; } catch (e) { return String(e.message); } };
  const a = attemptClaim(off), b = attemptClaim(on);
  assert.match(a ?? "", /number word/);
  assert.equal(b, a);
  const d = deltas("newsroom_viz_plan");
  assert.equal(d.length, 1);
  assert.match(d[0].path, /claim$/);
  assert.equal(d[0].added, 136);
});
await ok("FT4 plan descriptions: reader_question 60 B, visual_thesis 60 B, project_id 46 B, and nothing else about the plan's schema moves", async () => {
  const d = deltas("newsroom_infographic_plan").filter((x) => !/value_from/.test(x.path));
  assert.deepEqual(d.map((x) => x.added).sort((x, y) => x - y), [46, 60, 60]);
  assert.equal(stripped(on.get("newsroom_infographic_plan")), stripped(off.get("newsroom_infographic_plan")));
});
await ok("FT5 plan schema: the t10 call (reader_question, visual_thesis, project_id omitted) is refused with the same issues off and on", async () => {
  const full = pagePlan({ withQuestion: false });
  delete full.editorial_grammar.project_id;
  const a = checkSchema(off.get("newsroom_infographic_plan").parameters, full), b = checkSchema(on.get("newsroom_infographic_plan").parameters, full);
  assert.ok(a.some((m) => /reader_question/.test(m)) && a.some((m) => /project_id/.test(m)), a.join("|"));
  assert.deepEqual(b, a);
});
await ok("FT6 value_from: 142 B added in two sentences (30 + 112); the text starts with the off text", async () => {
  const d = deltas("newsroom_infographic_plan").filter((x) => /value_from/.test(x.path));
  assert.equal(d.length, 1);
  assert.equal(d[0].added, 142);
  assert.equal(d[0].text, " Required for every hero_stat. A year or a range of years counts as a typed number; if the claim has no placeholder for it, reword without it.");
});
await ok("FT7 the added tool text totals 578 B across the three tools; the tools and their order are the same", async () => {
  assert.deepEqual([...on.keys()], [...off.keys()]);
  assert.equal(NAMES.reduce((n, name) => n + sum(name), 0) + bytes("; if the claim has no placeholder for it, reword without the number"), 578);
  for (const name of off.keys()) if (!NAMES.includes(name) && !DERIVED.includes(name)) assert.equal(JSON.stringify([on.get(name).description, on.get(name).parameters, on.get(name).promptGuidelines]), JSON.stringify([off.get(name).description, off.get(name).parameters, off.get(name).promptGuidelines]), name);
  for (const name of NAMES) assert.equal(JSON.stringify(on.get(name).promptGuidelines), JSON.stringify(off.get(name).promptGuidelines), name);
});
await ok("FT8 switch: only exactly '1' turns the text on", async () => {
  const base = JSON.stringify(NAMES.map((name) => [off.get(name).description, off.get(name).parameters]));
  for (const value of ["true", "0", "", "2", "on"]) {
    const t = await withSwitch(value);
    assert.equal(JSON.stringify(NAMES.map((name) => [t.get(name).description, t.get(name).parameters])), base, value);
  }
});
await ok("FT9 t11: a hero with no value_from is refused with the same message off and on, nothing written", async () => {
  const a = await attempt(off, heroPlan({ value: "9" })), b = await attempt(on, heroPlan({ value: "9" }));
  assert.match(a.message ?? "", /HERO_VALUE_FROM_REQUIRED/);
  assert.equal(b.message?.split(b.art).join("<art>"), a.message?.split(a.art).join("<art>"));
  assert.equal(planCount(a.art) + planCount(b.art), 0);
});
await ok("FT10 t12: a year in the hero label is refused off and on; the on message is the off message plus the added clause", async () => {
  const hero = { value_from: "{max.value}", label: "2024年 largest value" };
  const a = await attempt(off, heroPlan(hero)), b = await attempt(on, heroPlan(hero));
  assert.match(a.message ?? "", /HERO_TYPED_NUMBER.*label has a typed number/);
  assert.equal(b.message, `${a.message}; if the claim has no placeholder for it, reword without the number`);
  assert.equal(planCount(a.art) + planCount(b.art), 0);
});
await ok("FT11 t13: a year range in the hero detail is refused off and on, same code, same added clause", async () => {
  const hero = { value_from: "{max.value}", detail: "1951至1980年平均" };
  const a = await attempt(off, heroPlan(hero)), b = await attempt(on, heroPlan(hero));
  assert.match(a.message ?? "", /HERO_TYPED_NUMBER.*detail has a typed number/);
  assert.equal(b.message, `${a.message}; if the claim has no placeholder for it, reword without the number`);
  assert.equal(planCount(a.art) + planCount(b.art), 0);
});
await ok("FT12 the number-word refusal for a hero text carries no added clause; only the digit refusal does", async () => {
  const hero = { value_from: "{max.value}", detail: "Top five regions" };
  const a = await attempt(off, heroPlan(hero)), b = await attempt(on, heroPlan(hero));
  assert.match(a.message ?? "", /HERO_TYPED_NUMBER.*number word/);
  assert.equal(b.message?.split(b.art).join("<art>"), a.message?.split(a.art).join("<art>"));
});
await ok("FT13 a correct page is stored identically with the switch off and on", async () => {
  const a = await attempt(off, heroPlan({ value_from: "{max.value}" }));
  const b = await attempt(on, heroPlan({ value_from: "{max.value}" }));
  assert.equal(a.message, null);
  assert.equal(b.message, null);
  assert.deepEqual(readdirSync(join(b.art, "infographics/plans")), readdirSync(join(a.art, "infographics/plans")));
});
console.log(`first-try text: ${results.length} checks -- PASS`);
