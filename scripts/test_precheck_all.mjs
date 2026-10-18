// V233 (NEWSROOM_SPEED_PRECHECK_ALL): a refused plan call also lists every other pre-draw problem that can still be checked.
// Real plan tool on a temp artifact root (fixtures from test_hero_value_tool_path.mjs). Offline.
// (the typebox/compile stub below is only used by the shared tree builder: of the real
// Compile cannot be checked here (see the report); the wiring, the order of the checks and the fail-closed path are.
import "./location_backing_pin.mjs";
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
import { INFOGRAPHIC_STORY_ROLES, VISUAL_GRAMMAR_FORMS } from "../runtime/pi/infographic.mjs";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_KEYS = ["NEWSROOM_TOOL_PROFILE", "NEWSROOM_PHASE", "NEWSROOM_SPEED_INLINE_CLAIM", "NEWSROOM_SPEED_CHAIN_VIZ", "NEWSROOM_SPEED_ATOMIC_ARTIFACT", "NEWSROOM_SPEED_CHAIN_INFOGRAPHIC", "NEWSROOM_SPEED_PLAN_PATCH", "NEWSROOM_SPEED_CHAIN_PATCH", "NEWSROOM_SPEED_PRECHECK_ALL"];
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
function makeTree(withCompile, { hideLintTool = false } = {}) {
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
  let source = stripTypeScriptTypes(readFileSync(join(TREE, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" });
  if (hideLintTool) { // this copy never puts the visual lint command in the registry the chain calls through
    const needle = "registeredTools.set(name, tool);";
    assert.equal(source.split(needle).length, 2, "one registry write to patch");
    source = source.replace(needle, 'if (name !== "newsroom_infographic_lint") registeredTools.set(name, tool);');
  }
  writeFileSync(COPY, source);
  return COPY;
}
const COPY_WITH = makeTree(true);
const COPY_WITHOUT = makeTree(false);
const COPY_NO_LINT_TOOL = makeTree(true, { hideLintTool: true });
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
const withSwitch = async (value) => { const tools = await registerFor({ env: { ...ENV_BASE, ...(value === undefined ? {} : { NEWSROOM_SPEED_PRECHECK_ALL: value }) } }); tools.switchValue = value; return tools; };
const useSwitch = (tools) => { if (tools.switchValue === undefined) delete process.env.NEWSROOM_SPEED_PRECHECK_ALL; else process.env.NEWSROOM_SPEED_PRECHECK_ALL = tools.switchValue; };
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

const lines = (message) => String(message).split("\n");
const otherCount = (message) => Number(/Other problems found by running every pre-draw check that can still run \((\d+);/.exec(message)?.[1] ?? 0);
const stored = (art) => planCount(art);

await ok("switch: off and on list the same tools with the same text; only exactly '1' turns it on", async () => {
  assert.deepEqual([...on.keys()], [...off.keys()]);
  for (const name of off.keys()) assert.equal(JSON.stringify([on.get(name).description, on.get(name).parameters, on.get(name).promptGuidelines]), JSON.stringify([off.get(name).description, off.get(name).parameters, off.get(name).promptGuidelines]), name);
  const bad = heroPlan(GOOD, (p) => { p.modules[3].story_node_ids = ["n-ghost"]; p.modules[0].claim_ids = ["c-nope"]; return p; });
  const base = await attempt(off, bad);
  assert.ok(base.message);
  for (const value of ["true", "0", "", "2"]) assert.equal((await attempt(await withSwitch(value), bad)).message, base.message, value);
});

await ok("independent problems: unknown story node, unverified claim and a typed hero number are all listed; off reports one", async () => {
  const plan = heroPlan({ label: "Top 5 regions", value_from: "{max.value}" }, (p) => { p.modules[3].story_node_ids = ["n-ghost"]; p.modules[0].claim_ids = ["c-nope"]; return p; });
  const a = await attempt(off, plan);
  const b = await attempt(on, plan);
  assert.ok(a.message && b.message);
  assert.ok(b.message.startsWith(a.message), "the first problem's text is unchanged");
  for (const code of codes(a.message)) assert.ok(codes(b.message).includes(code), `${code} lost`);
  assert.match(b.message, /references unknown story node 'n-ghost'/);
  assert.match(b.message, /references unverified claim 'c-nope'/);
  assert.ok(otherCount(b.message) >= 2);
  assert.equal(stored(a.art) + stored(b.art), 0);
  assert.ok(b.message.length > a.message.length);
});

await ok("every wrong call refused with the switch off is refused with it on, with the same first message", async () => {
  const wrong = {
    "typed hero number": heroPlan({ label: "Top 5 regions", value_from: "{max.value}" }),
    "unknown story node": heroPlan(GOOD, (p) => { p.modules[3].story_node_ids = ["n-ghost"]; return p; }),
    "unverified claim": heroPlan(GOOD, (p) => { p.modules[0].claim_ids = ["c-nope"]; return p; }),
    "unknown story_role": heroPlan(GOOD, (p) => { p.modules[3].story_role = "closing"; return p; }),
    "draft visual": null,
  };
  for (const [name, plan] of Object.entries(wrong)) {
    if (!plan) continue;
    const a = await attempt(off, plan);
    const b = await attempt(on, plan);
    assert.ok(a.message, `${name}: refused with the switch off`);
    assert.ok(b.message, `${name}: refused with the switch on`);
    assert.ok(b.message.startsWith(a.message), `${name}: first message unchanged`);
    for (const code of codes(a.message)) assert.ok(codes(b.message).includes(code), `${name}: ${code} lost`);
    assert.equal(stored(b.art), 0, name);
  }
  const draft = freshRun("ra-draft", { draft: { trend: true } });
  for (const tools of [off, on]) {
    useSwitch(tools);
    freshRun("ra-draft2", { draft: { trend: true } });
    const message = await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, heroPlan(GOOD))).then(() => null, (e) => String(e.message));
    assert.match(message ?? "", /DRAFT\/non-publishable/);
  }
});

await ok("a call accepted today stays accepted: grammar against chart type is a page-lint blocker, not a plan refusal", async () => {
  const plan = heroPlan(GOOD, (p) => { p.modules[1].visual_grammar = "rank"; return p; });
  const a = await attempt(off, plan);
  const b = await attempt(on, plan);
  assert.equal(a.message, null);
  assert.equal(b.message, null);
  assert.equal(readdirSync(join(a.art, "infographics/plans"))[0], readdirSync(join(b.art, "infographics/plans"))[0]);
});

await ok("grammar against chart type: the lint blocker is listed with the grammar's allowed chart types and the grammars that allow the chart type", async () => {
  const plan = heroPlan(GOOD, (p) => { p.modules[1].visual_grammar = "rank"; p.modules[3].story_node_ids = ["n-ghost"]; return p; });
  const b = await attempt(on, plan);
  assert.match(b.message, /grammar 'rank' is incompatible with chart_type 'sankey'/);
  const allowedForms = [...VISUAL_GRAMMAR_FORMS.rank].join(", ");
  assert.ok(b.message.includes(`chart_type values allowed for visual_grammar 'rank': ${allowedForms}`), "the set comes from VISUAL_GRAMMAR_FORMS");
  const carriers = Object.entries(VISUAL_GRAMMAR_FORMS).filter(([, set]) => set.has("sankey")).map(([name]) => name).join(", ");
  assert.ok(b.message.includes(`visual_grammar values that allow chart_type 'sankey': ${carriers}`));
  assert.match(b.message, /\[page lint\]/);
});

await ok("grammar the selected editorial grammar set does not support: the supported set and the registry ids that carry it are named", async () => {
  const registry = JSON.parse(readFileSync(join(ROOT, "config/editorial-grammar-registry.json"), "utf8"));
  const plan = heroPlan(GOOD, (p) => { p.modules[3].story_node_ids = ["n-ghost"]; p.modules[2].visual_grammar = "uncertainty"; return p; });
  const b = await attempt(on, plan);
  assert.match(b.message, /grammar\.visual_mode_incompatible/);
  const carriers = registry.grammars.filter((g) => (g.compatible_visual_grammars ?? []).includes("uncertainty")).map((g) => g.id).join(", ");
  assert.equal(carriers, "", "fixture: no registry grammar lists it");
  assert.ok(b.message.includes("no editorial grammar in the registry lists visual_grammar 'uncertainty' as compatible"));
  const { allowedValueHints } = await import(join(ROOT, "runtime/pi/contract_text.mjs"));
  const hints = allowedValueHints("module visual grammar 'rank' is unsupported by the selected editorial grammar set", { registry, selectedGrammarIds: ["THEN_NOW"] });
  assert.ok(hints.some((h) => h.startsWith("editorial grammar ids whose compatible_visual_grammars include 'rank': ")));
  assert.match(b.message, /visual_grammar values the selected editorial grammar set supports: /);
});

await ok("unknown enum value: the allowed set is named, taken from the check's own constant", async () => {
  const plan = heroPlan(GOOD, (p) => { p.modules[3].story_role = "closing"; return p; });
  const a = await attempt(off, plan);
  const b = await attempt(on, plan);
  assert.match(a.message, /unsupported story_role 'closing'/);
  assert.ok(b.message.startsWith(a.message));
  assert.ok(b.message.includes(`story_role values allowed: ${INFOGRAPHIC_STORY_ROLES.join(", ")}`));
});

await ok("a check that cannot run is listed as not checked, never as passed", async () => {
  const plan = heroPlan(GOOD, (p) => { p.modules[3].story_node_ids = ["n-ghost"]; return p; });
  useSwitch(on);
  const art = freshRun("ra-nc");
  rmSync(join(art, "editorial/story-graphs/migration.json"));
  const message = await on.get("newsroom_infographic_plan").execute("p", keyOrder(on, plan)).then(() => null, (e) => String(e.message));
  assert.match(message, /Not checked \(an earlier problem stops these from running; this is not a pass\):/);
  assert.match(message, /StoryGraph checks \(passed, reader_question, visual_thesis, story nodes\): the StoryGraph could not be read/);
  assert.ok(!/story graph.*passed\b/i.test(message.split("Not checked")[0].split("\n").filter((l) => /^\d+\./.test(l)).join("\n")), "no problem line claims a pass");
  assert.equal(stored(art), 0);
});

await ok("a plan without problems is stored identically with the switch off and on", async () => {
  const a = await attempt(off, heroPlan(GOOD));
  const artB = freshRun("ra-ok");
  useSwitch(on);
  const res = await on.get("newsroom_infographic_plan").execute("p", keyOrder(on, heroPlan(GOOD)));
  assert.equal(a.message, null);
  assert.equal(stored(a.art), 1);
  assert.equal(readdirSync(join(artB, "infographics/plans"))[0], readdirSync(join(a.art, "infographics/plans"))[0]);
  assert.equal(res.details.planRef.split("/").pop(), readdirSync(join(a.art, "infographics/plans"))[0]);
});

await ok("unknown visual_grammar: the plan refusal names the allowed grammars from the check's own list", async () => {
  const plan = heroPlan(GOOD, (p) => { p.modules[1].visual_grammar = "nonsense"; return p; });
  const a = await attempt(off, plan);
  const b = await attempt(on, plan);
  assert.ok(a.message && b.message.startsWith(a.message));
  const { INFOGRAPHIC_VISUAL_GRAMMARS } = await import(join(ROOT, "runtime/pi/infographic.mjs"));
  assert.ok(b.message.includes(`visual_grammar values allowed: ${INFOGRAPHIC_VISUAL_GRAMMARS.join(", ")}`));
});

// The off-table call refusal (NEWSROOM_GROUP_CALL_REFUSE and _ALL) is on by default. This chain section is about the page-lint blockers a stop also lists, and the chain tool
// (an agent-group tool) reaches the visual group's lint internals directly, which the default-on refusal refuses. The old value of both switches is stated here for this one
// section ("0", the value this section ran with before the refusal became the default); the next check pins the default behaviour so the refusal stays visible.
const REFUSAL_KEYS = ["NEWSROOM_GROUP_CALL_REFUSE", "NEWSROOM_GROUP_CALL_REFUSE_ALL"];
const withRefusals = async (value, fn) => {
  const saved = Object.fromEntries(REFUSAL_KEYS.map((k) => [k, process.env[k]]));
  for (const k of REFUSAL_KEYS) { if (value === undefined) delete process.env[k]; else process.env[k] = value; }
  try { return await fn(); } finally { for (const k of REFUSAL_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
await ok("page chain: a claim/manifest stop also lists the page lint blockers the chain never reached; same stop code, off unchanged", () => withRefusals("0", async () => {
  const CHAIN_ENV = { ...ENV_BASE, NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1" };
  const mk = async (value) => { const t = await registerFor({ env: { ...CHAIN_ENV, ...(value === undefined ? {} : { NEWSROOM_SPEED_PRECHECK_ALL: value }) } }); t.switchValue = value; return t; };
  const chainOff = await mk(undefined), chainOn = await mk("1");
  assert.ok(chainOff.get("newsroom_infographic_chain"));
  const plan = pagePlan({ withQuestion: true, moduleClaims: { map: ["c-flow"] } });
  plan.modules[1].visual_grammar = "rank"; // also a page-lint blocker
  const run = async (tools) => { useSwitch(tools); const art = freshRun("ra-chain", { manifestClaim: { map: "c-map" } }); const r = await tools.get("newsroom_infographic_chain").execute("c", keyOrder(tools, plan)); return { art, r }; };
  const a = await run(chainOff);
  const b = await run(chainOn);
  assert.equal(a.r.details.stopCode, "CLAIM_MANIFEST_MISMATCH");
  assert.equal(b.r.details.stopCode, "CLAIM_MANIFEST_MISMATCH");
  assert.ok(b.r.details.stopMessage.startsWith(a.r.details.stopMessage));
  assert.match(b.r.details.stopMessage, /\[page lint\] visual 'flow' grammar 'rank' is incompatible with chart_type 'sankey'/);
  assert.match(b.r.details.stopMessage, /Not checked \(the stop prevents these from running; this is not a pass\):\n- render, critic and preview/);
  assert.ok(!/page lint/.test(a.r.details.stopMessage));
  assert.equal(a.r.details.chainStatus, b.r.details.chainStatus);
}));

const withStopVia = async (value, fn) => {
  const saved = process.env.NEWSROOM_CHAIN_STOP_VIA_VISUAL;
  if (value === undefined) delete process.env.NEWSROOM_CHAIN_STOP_VIA_VISUAL; else process.env.NEWSROOM_CHAIN_STOP_VIA_VISUAL = value;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.NEWSROOM_CHAIN_STOP_VIA_VISUAL; else process.env.NEWSROOM_CHAIN_STOP_VIA_VISUAL = saved; }
};
const readJsonl = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const stopRun = async (label, copy = COPY_WITH) => {
  const tools = await registerFor({ env: { ...ENV_BASE, NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", NEWSROOM_SPEED_PRECHECK_ALL: "1" } }, { copy });
  tools.switchValue = "1"; useSwitch(tools);
  const plan = pagePlan({ withQuestion: true, moduleClaims: { map: ["c-flow"] } });
  plan.modules[1].visual_grammar = "rank";
  const art = freshRun(label, { manifestClaim: { map: "c-map" } });
  const r = await tools.get("newsroom_infographic_chain").execute("c", keyOrder(tools, plan));
  return { r, art };
};
await ok("page chain with the default call refusal: the stop path's call into the visual lint internals is refused and recorded, so the page-lint line is missing and the gap stays visible", () => withRefusals(undefined, () => withStopVia("0", async () => {
  const tools = await registerFor({ env: { ...ENV_BASE, NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", NEWSROOM_SPEED_PRECHECK_ALL: "1" } });
  tools.switchValue = "1"; useSwitch(tools);
  const plan = pagePlan({ withQuestion: true, moduleClaims: { map: ["c-flow"] } });
  plan.modules[1].visual_grammar = "rank";
  const art = freshRun("ra-chain-refused", { manifestClaim: { map: "c-map" } });
  const r = await tools.get("newsroom_infographic_chain").execute("c", keyOrder(tools, plan));
  assert.equal(r.details.stopCode, "CLAIM_MANIFEST_MISMATCH", "the stop itself is unchanged");
  assert.ok(!/\[page lint\]/.test(r.details.stopMessage), "the refused page lint adds no line to the stop message");
  const log = join(art, "runtime/boundary-refusals.jsonl");
  const refusals = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const mine = refusals.filter((x) => x.tool === "newsroom_infographic_chain" && x.kind === "cross_call" && /is not on the tool_pin row of computation_rows\.mjs::recordedInputState/.test(String(x.reason ?? x.message ?? "")));
  assert.equal(mine.length, 1, `exactly one recorded refusal of the chain's page-lint call into computation_rows.mjs::recordedInputState (refusals: ${refusals.map((x) => `${x.tool}:${String(x.reason ?? "").slice(0, 80)}`).join(" | ") || "none"})`);
})));

await ok("page chain stop path, default (NEWSROOM_CHAIN_STOP_VIA_VISUAL unset): the page lint is asked of the visual lint command, its lines are back, and no refusal is recorded for the chain", () => withRefusals(undefined, () => withStopVia(undefined, async () => {
  const { r, art } = await stopRun("ra-chain-via-visual");
  assert.equal(r.details.stopCode, "CLAIM_MANIFEST_MISMATCH", "the stop itself is unchanged");
  assert.match(r.details.stopMessage, /\[page lint\] visual 'flow' grammar 'rank' is incompatible with chart_type 'sankey'/);
  assert.match(r.details.stopMessage, /Not checked \(the stop prevents these from running; this is not a pass\):\n- render, critic and preview/);
  assert.ok(!/page lint: it could not run/.test(r.details.stopMessage), "the lint ran");
  const refusals = readJsonl(join(art, "runtime/boundary-refusals.jsonl")).filter((x) => x.tool === "newsroom_infographic_chain" && x.kind === "cross_call");
  assert.equal(refusals.length, 0, `no recorded refusal of the chain (${refusals.map((x) => String(x.reason ?? "").slice(0, 80)).join(" | ")})`);
  // the lint internals were reached under the visual lint command's identity, which the pin row lists
  const calls = readJsonl(join(art, "runtime/cross-call-report.jsonl"));
  const viaLint = calls.filter((x) => x.tool === "newsroom_infographic_lint" && x.tool_group === "visual" && x.function === "computation_rows.mjs::recordedInputState");
  assert.ok(viaLint.length >= 1, "recordedInputState was reached by newsroom_infographic_lint (visual)");
  assert.ok(viaLint.every((x) => x.tool_allowed !== false), "and the pin row lists that tool");
  assert.equal(calls.filter((x) => x.tool === "newsroom_infographic_chain" && x.function === "computation_rows.mjs::recordedInputState").length, 0, "the chain itself no longer reaches it");
  // the one extra write: the lint command's own record, in infographics/lints/ (never publications/)
  const lints = readdirSync(join(art, "infographics/lints")).filter((f) => f.endsWith(".json"));
  assert.equal(lints.length, 1, "one lint file written by the lint command");
  assert.ok(!existsSync(join(art, "publications")) || readdirSync(join(art, "publications")).length === 0, "nothing under publications/");
})));

await ok("page chain stop path, switch \"0\": the stop text is the one the default refusal gave before, and nothing extra is written", () => withRefusals(undefined, () => withStopVia("0", async () => {
  const { r, art } = await stopRun("ra-chain-via-visual-off");
  assert.equal(r.details.stopCode, "CLAIM_MANIFEST_MISMATCH");
  assert.ok(!/\[page lint\]/.test(r.details.stopMessage));
  assert.match(r.details.stopMessage, /- page lint: it could not run on this plan \(boundary: newsroom_infographic_chain/);
  assert.ok(!existsSync(join(art, "infographics/lints")) || readdirSync(join(art, "infographics/lints")).length === 0, "no lint file on the old path");
  const again = await stopRun("ra-chain-via-visual-off-2");
  assert.equal(again.r.details.stopMessage, r.details.stopMessage, "stable");
})));

await ok("page chain stop path, switch on but the visual lint command not registered: one visible line, one chain event, and no direct call into the lint internals", () => withRefusals(undefined, () => withStopVia(undefined, async () => {
  const { r, art } = await stopRun("ra-chain-no-lint-tool", COPY_NO_LINT_TOOL);
  assert.equal(r.details.stopCode, "CLAIM_MANIFEST_MISMATCH", "the stop itself is unchanged");
  assert.match(r.details.stopMessage, /\[page lint\] unavailable: newsroom_infographic_lint not registered/);
  assert.ok(!/\[page lint\] visual /.test(r.details.stopMessage), "no blocker line: the lint did not run");
  assert.ok(!/page lint: it could not run/.test(r.details.stopMessage), "and not the could-not-run line a refused direct call gives");
  const refusals = readJsonl(join(art, "runtime/boundary-refusals.jsonl")).filter((x) => x.tool === "newsroom_infographic_chain");
  assert.equal(refusals.length, 0, "no refused direct call was attempted");
  const calls = readJsonl(join(art, "runtime/cross-call-report.jsonl"));
  assert.equal(calls.filter((x) => x.function === "lintInfographicPlan" && x.tool === "newsroom_infographic_chain").length, 0, "lintInfographicPlan was not called from the chain");
  assert.ok(!existsSync(join(art, "infographics/lints")) || readdirSync(join(art, "infographics/lints")).length === 0, "no lint file");
  const events = readJsonl(join(art, "runtime/tool-chain-events.jsonl"));
  assert.ok(events.some((e) => e.toolName === "newsroom_infographic_lint" && e.isError === true && e.error === "newsroom_infographic_lint not registered"), `the event is recorded (files: ${readdirSync(join(art, "runtime")).join(",")})`);
})));
console.log(`precheck all: ${results.length} checks -- PASS`);
