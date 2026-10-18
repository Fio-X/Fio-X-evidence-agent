#!/usr/bin/env node
// K655 (10-16, owner signed): one recorded call per gap of the call table, on fixtures, no provider and no network.
// Runs the tools that reach computation_rows.mjs::recordedInputState (and the chain's wrapped module functions) with the call report on, and prints
// per (tool, function) the row count. The refusals are pinned off here: this test is about what is recorded, not about refusing.
// No provider, no network; the page rasterizer and browser check are the same stubs test_speed_switch_gates.mjs uses.
import "./location_backing_pin.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("call-table-gaps-");
const { assessStoryGraph } = await import(join(ROOT, "runtime/pi/story_graph.mjs"));
const results = [];
const check = (name) => results.push(name);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const refOf = (res, ...names) => { for (const n of names) if (res?.details?.[n]) return res.details[n]; throw new Error(`no ${names.join("/")} in result: ${res?.error ?? JSON.stringify(res?.details ?? {}).slice(0, 200)}`); };
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const attempt = async (tool, params) => { try { return await tool.execute("t", params); } catch (e) { return { error: String(e?.message ?? e) }; } };

// ---- fixtures: a whole page pipeline (the same one test_speed_switch_gates.mjs runs; copied, not imported, because that file is a script) -------------
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
const readerQuestion = "How did the geography and scale of estimated international migration flows change?";
const visualThesis = "A route-led world view connects changing corridors to regional composition and long-run change.";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#fafafa"/><path d="M5 30L95 30" stroke="#111"/><circle cx="75" cy="30" r="5"/></svg>';
const VIZ = [["map", "geo_flow_map", "c-map"], ["sankey", "sankey", "c-flow"], ["trend", "line", "c-trend"]];
// verbatim from test_plan_edit_runtime.mjs: a full artifact root with verified claims, a computation, charts and editorial files
function freshRun(label, { manifestClaim = {}, criticPassed = {}, draft = {} } = {}) {
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
  const computation = { schema_version: "0.7.0", sql: "SELECT region, value FROM 'data/x.csv' ORDER BY region", input_snapshot_hash: csvSha, input_fingerprints: [`data:x.csv:${csvSha}`], read_inputs: [{ path: "data/x.csv", sha256: csvSha }], input_binding: "source_bound", result_hash: csvSha, rows: [{ region: "A", value: 1 }, { region: "B", value: 2 }] };
  const computationRef = `computations/${createHash("sha256").update(JSON.stringify(computation)).digest("hex")}.json`;
  writeFileSync(join(art, computationRef), JSON.stringify(computation));
  const claims = ["c-map", "c-flow", "c-trend", "c-outcome"].map((claim_id) => JSON.stringify({ claim_id, status: "verified", source_refs: ["data/x.csv"], computation_refs: [computationRef], verification }));
  writeFileSync(join(art, "claims.jsonl"), `${claims.join("\n")}\n`);
  for (const [id, chart_type, claim_id] of VIZ) {
    writeFileSync(join(art, `visualizations/${id}.svg`), svg);
    writeFileSync(join(art, `visualizations/${id}.mobile.svg`), svg);
    writeFileSync(join(art, `visualizations/${id}.json`), JSON.stringify({
      chart_type, claim_id: manifestClaim[id] ?? claim_id, computation_ref: computationRef, source_note: "Gaskin and Abel model estimates, 1990-2023",
      verification_mode: "verified", artifact_status: draft[id] ? "DRAFT" : "VERIFIED", publishable: draft[id] ? false : true,
      variants: { desktop: `visualizations/${id}.svg`, mobile: `visualizations/${id}.mobile.svg` },
    }));
    writeFileSync(join(art, `visualizations/critics/${id}.json`), JSON.stringify({ passed: criticPassed[id] ?? true, score: 90, manifest_ref: `visualizations/${id}.json` }));
  }
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
const RUBRIC = Object.fromEntries(["hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness"].map((k) => [k, 90]));
// plan -> lint -> render -> deterministic critic -> preview -> vision critic, all passing
async function runPage(tools, title) {
  const plan = pagePlan({ withQuestion: true });
  if (title) plan.title = title;
  const p = await tools.get("newsroom_infographic_plan").execute("p", keyOrder(tools, plan));
  const planRef = refOf(p, "planRef");
  const l = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: planRef });
  must(l.details.passed, `fixture lint failed: ${(l.details.blockers ?? []).join(" | ").slice(0, 200)}`);
  const lintRef = refOf(l, "lintRef");
  const r = await tools.get("newsroom_infographic_render").execute("r", { plan_ref: planRef, lint_ref: lintRef });
  const manifestRef = refOf(r, "manifestRef");
  const c = await tools.get("newsroom_infographic_critic").execute("c", { plan_ref: planRef, lint_ref: lintRef, manifest_ref: manifestRef });
  must(c.details.passed !== false, "fixture critic did not pass");
  const criticRef = refOf(c, "criticRef");
  const pv = await tools.get("newsroom_infographic_preview").execute("v", { manifest_ref: manifestRef, critic_ref: criticRef });
  const previewRef = refOf(pv, "previewRef");
  const v = await tools.get("newsroom_infographic_vision_critic").execute("vc", { manifest_ref: manifestRef, preview_ref: previewRef, deterministic_critic_ref: criticRef, passed: true, score: 90, confidence: 0.8, rubric: RUBRIC, issues: [], patches: [] });
  const visionRef = refOf(v, "criticRef", "visionCriticRef", "visionRef");
  return { planRef, lintRef, manifestRef, criticRef, previewRef, visionRef };
}
const STUB_DIR = makeTestTmp("four-tools-stub-");
writeFileSync(join(STUB_DIR, "fixed.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]));
writeFileSync(join(STUB_DIR, "python-stub.sh"), `#!/bin/sh
case "$1" in
*browser_qa.py)
  out=""; html=""
  while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; fi; if [ "$1" = "--html" ]; then html="$2"; fi; shift; done
  sha=$(shasum -a 256 "$html" | cut -d' ' -f1)
  case "$NEWSROOM_TEST_QA_MODE" in
    pass) printf '{"status":"PASS","profile":"cpu","html_sha256":"%s","viewports":[{"width":1280,"status":"PASS"}],"errors":[]}' "$sha" > "$out/browser-qa.json" ;;
    startup) printf '{"status":"FAIL","profile":"cpu","html_sha256":"%s","errors":["playwright is not installed"]}' "$sha" > "$out/browser-qa.json" ;;
    *) printf '{"status":"FAIL","profile":"cpu","html_sha256":"%s","viewports":[{"width":1280,"status":"FAIL"}],"errors":["text_overflow"]}' "$sha" > "$out/browser-qa.json" ;;
  esac
  exit 0 ;;
*) cp "${join(STUB_DIR, "fixed.png")}" "$3"; echo '{"engine":"test-stub"}' ;;
esac
`);
chmodSync(join(STUB_DIR, "python-stub.sh"), 0o755);
process.env.NEWSROOM_PYTHON_BIN = join(STUB_DIR, "python-stub.sh");

const PI_DIR = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim() + "/@earendil-works/pi-coding-agent";
const REAL_COMPILE = createRequire(join(PI_DIR, "package.json")).resolve("typebox/compile");
const PIN = "computation_rows.mjs::recordedInputState";
const REPORT = "runtime/cross-call-report.jsonl";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
let treeSeq = 0;
async function load(env, { refuse = process.env.GAPS_REFUSE === "1", drop = null } = {}) {
  const tree = join(scratch, `tree-${++treeSeq}`);
  mkdirSync(tree, { recursive: true });
  cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
  stub(tree, "typebox", TYPEBOX);
  writeFileSync(join(tree, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: { ".": "./index.js", "./compile": "./compile.js" } }));
  writeFileSync(join(tree, "node_modules", "typebox", "compile.js"), `export * from ${JSON.stringify(pathToFileURL(REAL_COMPILE).href)};\n`);
  stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  if (drop) { // remove one tool from the runtime_only list of the pin row, in this throwaway tree only
    const gp = join(tree, "runtime/pi/groups.json"); const g = JSON.parse(readFileSync(gp, "utf8")); const row = g.cross_calls.tool_pin[PIN];
    must(row.runtime_only.includes(drop), `${drop} is not on runtime_only`); row.runtime_only = row.runtime_only.filter((t) => t !== drop); writeFileSync(gp, JSON.stringify(g, null, 1) + "\n");
  }
  const copy = join(tree, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
  for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_") || name.startsWith("NEWSROOM_SPEED_")) delete process.env[name];
  // GAPS_REFUSE=1: leave the refusals at their default (on) to see which of these calls the table would refuse.
  if (!refuse) { process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; }
  Object.assign(process.env, { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_TEST_QA_MODE: "pass", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", ...env });
  return { copy, seq: treeSeq, tree };
}
async function register({ copy, seq }) {
  const tools = new Map();
  const mod = await import(`${pathToFileURL(copy).href}?v=${seq}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const rowsOf = (art) => (existsSync(join(art, REPORT)) ? readFileSync(join(art, REPORT), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const WATCH = ["computation_rows.mjs::recordedInputState", "evidence_gate.mjs::evaluateClaimSupport", "economy_names.mjs::economyEntryFor", "economy_names.mjs::resolveEconomyDisplayName", "economy_names.mjs::unmappedEconomyNameValues", "economy_names.mjs::usStatesEnabled"];
const refusals = (art) => { const f = join(art, "runtime/boundary-refusals.jsonl"); if (!existsSync(f)) return "refusals=0"; const r = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); const by = {}; for (const x of r) { const k = `${x.tool ?? x.requester ?? "?"}->${String(x.message ?? x.reason ?? Object.keys(x).join("|")).replace(/^boundary: /, "").slice(0, 150)}`; by[k] = (by[k] ?? 0) + 1; } return `refusals=${r.length} ${JSON.stringify(by)}`; };
const show = (label, art, tool) => { const r = rowsOf(art).filter((x) => x.tool === tool); const by = {}; for (const x of r) by[x.function] = (by[x.function] ?? 0) + 1; console.log(`GAPROW ${label}: tool=${tool} rows_total=${r.length} ` + WATCH.map((w) => `${w}=${by[w] ?? 0}`).join(" ") + " " + refusals(art)); return by; };

// ---- A. newsroom_infographic_chain (CHAIN_INFOGRAPHIC=1), a full pass and a claim/manifest stop with PRECHECK_ALL=1 (chainStopWithPageLint) ----------------------
{
  const l = await load({ NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1" });
  const art = freshRun("chain");
  const tools = await register(l);
  must(tools.has("newsroom_infographic_chain"), "chain not registered");
  const res = await attempt(tools.get("newsroom_infographic_chain"), keyOrder(tools, pagePlan({ withQuestion: true })));
  console.log("chain pass result:", res.error ? `ERROR ${String(res.error).slice(0, 120)}` : String(res.content?.[0]?.text).slice(0, 60));
  show("chain, full pass", art, "newsroom_infographic_chain");
}
{
  const l = await load({ NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", NEWSROOM_SPEED_PRECHECK_ALL: "1" });
  const art = freshRun("chainstop", { manifestClaim: { map: "c-flow" } });
  const tools = await register(l);
  const res = await attempt(tools.get("newsroom_infographic_chain"), keyOrder(tools, pagePlan({ withQuestion: true, moduleClaims: { map: ["c-map"] } })));
  console.log("chain stop result:", res.error ? `ERROR ${String(res.error).slice(0, 160)}` : String(res.content?.[0]?.text).slice(0, 100));
  show("chain, claim/manifest stop + precheck-all", art, "newsroom_infographic_chain");
}
// ---- B. the compact-setup trio (COMPACT_SETUP=1) -----------------------------------------------------------------------------------------------------------
{
  const l = await load({ NEWSROOM_SPEED_COMPACT_SETUP: "1" });
  const art = freshRun("compact");
  const tools = await register(l);
  const FRAMES = ["spatial", "temporal", "mechanism", "comparison", "human_scale", "object_scene", "progressive_reveal", "spatial"];
  const METAPHORS = ["a river map", "a clock face", "a pipe network", "a seesaw", "a village of 100", "a market stall", "a staircase", "a compass"];
  const COMMON = { reader_question: "Where do the rates stand?", editorial_premise: "Most rates are above the 2019 start.", surprise: "Only one is lower.", hero_evidence_refs: ["claim-1"], supporting_evidence_refs: ["claim-2"], asset_requirements: [{ kind: "verified_series", available: true, blocking: false }], media_mix: ["chart"], risk_flags: ["rate definitions differ"], reporting_gaps: [] };
  const concepts = Array.from({ length: 8 }, (_, i) => ({ concept_id: `c${i + 1}`, framing: FRAMES[i], visual_metaphor: METAPHORS[i], hero_scene: `${METAPHORS[i]} carrying the seven rates`, why_memorable: `The reader sees ${METAPHORS[i]} and remembers the one rate that fell.` }));
  const ref = (r) => String(r.content?.[0]?.text ?? "").match(/Artifact: (\S+)/)?.[1];
  const c = await attempt(tools.get("newsroom_visual_concepts"), { shared: COMMON, concepts });
  console.log("visual_concepts:", c.error ? `ERROR ${String(c.error).slice(0, 600)}` : "ok");
  show("compact, visual_concepts", art, "newsroom_visual_concepts");
  if (!c.error) {
    const stored = JSON.parse(readFileSync(join(art, ref(c)), "utf8"));
    const modules = [{ id: "m1", reader_question_id: "q1", claim_set: ["c-map"], new_information: "trend of seven rates", explanatory_dimension: "trend" }, { id: "m2", reader_question_id: "q2", claim_set: ["c-flow"], new_information: "start against end", explanatory_dimension: "comparison" }];
    const n = await attempt(tools.get("newsroom_semantic_novelty"), { modules, concept_ref: ref(c) });
    console.log("semantic_novelty:", n.error ? `ERROR ${String(n.error).slice(0, 700)}` : "ok");
    show("compact, semantic_novelty", art, "newsroom_semantic_novelty");
    const a = await attempt(tools.get("newsroom_asset_requirements"), { concept_id: stored.finalists[0], concept_ref: ref(c), requirements: [{ asset_class: "historical_series", status: "required", available: true, purpose: "series", source_refs: ["data/x.csv"] }] });
    console.log("asset_requirements:", a.error ? `ERROR ${String(a.error).slice(0, 160)}` : "ok");
    show("compact, asset_requirements", art, "newsroom_asset_requirements");
  }
}
// ---- C. newsroom_map_validate with a computation-sourced observation layer ----------------------------
async function mapCase({ refuse, drop } = {}) {
  const l = await load({}, { refuse, drop });
  const art = freshRun("map");
  const tools = await register(l);
  const csv = "id,place,lon,lat,mag\nq1,Real place,101.25,-6.5,5.5\n";
  const csvSha = sha256(csv);
  writeFileSync(join(art, "data", `${csvSha}.csv`), csv);
  writeFileSync(join(art, "data", `${csvSha}.csv.meta.json`), JSON.stringify({ sha256: csvSha, file: `data/${csvSha}.csv` }));
  const record = { schema_version: "0.7.0", sql: `SELECT place, lon, lat, mag FROM 'data/${csvSha}.csv'`, input_snapshot_hash: csvSha, input_fingerprints: [`data:${csvSha}.csv:${csvSha}`], read_inputs: [{ path: `data/${csvSha}.csv`, sha256: csvSha }], input_binding: "source_bound", result_hash: csvSha, rows: [{ place: "Real place", lon: 101.25, lat: -6.5, mag: 5.5 }] };
  const bytes = JSON.stringify(record);
  const compPath = `computations/${sha256(bytes)}.json`;
  writeFileSync(join(art, compPath), bytes);
  const mapSpec = { schema_version: "0.1.0", projection: "equirectangular", crs: "EPSG:4326", task: "regional", style_intent: "nature_scientific_map", basemap_id: "naturalearth_admin0_110m", extent: { west: 95, east: 116, south: -15, north: 0 }, scale: { enabled: true, unit: "km", length_km: 500 }, graticule: { lon_step: 5, lat_step: 5 }, layers: [{ id: "earthquakes", type: "observations", label: "Event", unit: "magnitude", uncertainty: "none", encoding: { color_scale: "restrained_green", show_colorbar: false }, source: { path: compPath, sha256: sha256(bytes), format: "rows", lon_field: "lon", lat_field: "lat", value_field: "mag", size_field: "mag", label_field: "place" } }] };
  const res = await attempt(tools.get("newsroom_map_validate"), { spec_json: JSON.stringify(mapSpec) });
  return { art, res };
}
{
  const { art, res } = await mapCase();
  console.log("map_validate:", res.error ? `ERROR ${String(res.error).slice(0, 200)}` : "ok");
  show("map_validate, computation-sourced layer", art, "newsroom_map_validate");
}

// ---- D. per-row proof under the default-on refusal (nothing pinned off): each of the five is refused without its row and passes with it ----------------------
const FIVE = ["newsroom_award_mode_status", "newsroom_competition_preflight", "newsroom_infographic_edit", "newsroom_map_validate", "newsroom_publication_render"];
const refusedBy = (res) => /not on the tool_pin row/.test(String(res?.error ?? ""));
async function fourCase({ drop } = {}) {
  const l = await load({ NEWSROOM_SPEED_PLAN_EDIT: "1", NEWSROOM_PUBLICATION_EMBED_PAGE: "1" }, { refuse: true, drop });
  const art = freshRun("four");
  const tools = await register(l);
  const page = await runPage(tools);
  const manifest = JSON.parse(readFileSync(join(art, page.manifestRef), "utf8"));
  const out = {};
  const run = async (name, params) => { const res = await attempt(tools.get(name), params); out[name] = { refused: refusedBy(res), text: String(res.error ?? res.content?.[0]?.text ?? "").slice(0, 160) }; return res; };
  await run("newsroom_infographic_edit", { plan_ref: page.planRef, ops: [{ scope: "module", id: "flow", field: "span", value: "half" }] });
  await run("newsroom_award_mode_status", { discovery_ref: "editorial/discovery/migration.json", concepts_ref: "editorial/concepts/migration.json", asset_plan_ref: "editorial/assets/migration.json", novelty_ref: "editorial/novelty/migration.json", page_ref: page.manifestRef });
  await run("newsroom_competition_preflight", { plan_ref: page.planRef, manifest_ref: page.manifestRef, deterministic_critic_ref: page.criticRef, vision_critic_ref: page.visionRef });
  const base = { infographic_plan_ref: page.planRef, story_graph_ref: "editorial/story-graphs/migration.json", reader_question: readerQuestion, visual_thesis: visualThesis, title: "Fixture publication", dek: "A fixture." };
  const modules = [
    { id: "page", type: "static_svg", story_node_ids: ["n-map"], explanatory_dimension: "spatial", asset_ref: manifest.variants.desktop, title: manifest.title ?? "Page", claim_ids: ["c-map"], accessibility_summary: "A page.", accessibility_long_description: "A page of the fixture.", width: "full" },
    { id: "t1", type: "text", story_node_ids: ["n-change"], explanatory_dimension: "trend", text: "Body t1." },
  ];
  const planned = await attempt(tools.get("newsroom_publication_plan"), { ...base, modules });
  must(!planned.error, `fixture: the publication plan was refused: ${String(planned.error).slice(0, 300)}`);
  await run("newsroom_publication_render", { plan_ref: planned.details.planRef });
  return out;
}
const proofs = {};
const sameTree = (a, b) => readFileSync(a, "utf8") === readFileSync(b, "utf8");
const ORIGINAL = readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8");
for (const tool of FIVE) {
  const withRow = tool === "newsroom_map_validate" ? { [tool]: refusedBy((await mapCase({ refuse: true })).res) } : Object.fromEntries(Object.entries(await fourCase()).map(([k, v]) => [k, v.refused]));
  const without = tool === "newsroom_map_validate" ? { [tool]: refusedBy((await mapCase({ refuse: true, drop: tool })).res) } : Object.fromEntries(Object.entries(await fourCase({ drop: tool })).map(([k, v]) => [k, v.refused]));
  must(withRow[tool] === false, `${tool} must pass with its row (refusals on)`);
  must(without[tool] === true, `${tool} must be refused when its row is removed (refusals on)`);
  proofs[tool] = { withRow: withRow[tool], withoutRow: without[tool], othersStillPass: Object.entries(without).filter(([k]) => k !== tool).every(([, v]) => v === false) };
  console.log(`PROOF ${tool}: refused_with_row=${withRow[tool]} refused_without_row=${without[tool]} others_unaffected=${proofs[tool].othersStillPass}`);
}
must(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8") === ORIGINAL, "the real groups.json was touched");
console.log("per-row proof: original groups.json byte-identical after every mutation (the mutations run on throwaway tree copies)");
console.log("call table gaps records: DONE");
