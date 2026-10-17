// NEWSROOM_SPEED_CHAIN_INFOGRAPHIC=1: newsroom_infographic_chain runs plan -> lint ->
// render -> deterministic critic -> preview in one call through the registered
// (wrapped) executes, and hands the image back to the model for the vision critic.
//
// Part 1 drives runToolChain with fake tools for every stop rule. Part 2 loads
// runtime/pi/newsroom.ts from a type-stripped copy and runs the real page tools on
// a fixture whose editorial artifacts, claims and chart manifests are written by hand.
import "./group_env_pin.mjs";
import { withoutRunTraces } from "./lib_run_traces.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT as CALL_REPORT, expectSameReports, callRows } from "./call_report_expect.mjs";

// Exact call-report rows (the report is always written now).
const INFOGRAPHIC_CHAIN_ONLY_ON = callRows([
  "newsroom_infographic_chain agent agentRecordSide - t",
  "newsroom_infographic_chain agent agent_record_writer.mjs::agentRecordWriter agent t",
  "newsroom_infographic_chain agent appendArtifact - t",
  "newsroom_infographic_chain agent artifactRoot - t",
  "newsroom_infographic_chain agent ensureParent - t",
  "newsroom_infographic_chain agent fillCopiedEnabled - t",
  "newsroom_infographic_chain agent fillStoryGraphRef - t",
  "newsroom_infographic_chain agent groups.mjs::asHandoffWriter system t",
  "newsroom_infographic_chain agent groups.mjs::readThroughStaging system t",
  "newsroom_infographic_chain agent groups.mjs::recordBoundaryWrite system t",
  "newsroom_infographic_chain agent groups.mjs::stagedWriteRoot system t",
  "newsroom_infographic_chain agent precheckAllEnabled - t",
  "newsroom_infographic_chain agent readArtifactJson - t",
  "newsroom_infographic_chain agent readManifestOrRejected - t",
  "newsroom_infographic_chain agent saveChainEvent - t",
  "newsroom_infographic_chain agent textResult - t",
  "newsroom_infographic_chain agent tool_phase_policy.mjs::toolEnabled agent t",
]);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { runToolChain, infographicChainSteps, chainResultFor } = await import(join(ROOT, "runtime/pi/tool_chain.mjs"));
const { assessStoryGraph } = await import(join(ROOT, "runtime/pi/story_graph.mjs"));

const results = [];
const check = (name) => { results.push(name); };
const textResult = (text, details = {}) => ({ content: [{ type: "text", text }], details });
const PAGE_TOOLS = ["newsroom_infographic_plan", "newsroom_infographic_lint", "newsroom_infographic_render", "newsroom_infographic_critic", "newsroom_infographic_preview"];

// ---- Part 1: orchestration with fake tools --------------------------------
const GOOD = {
  newsroom_infographic_plan: () => textResult("plan ok", { planRef: "infographics/plans/p.json" }),
  newsroom_infographic_lint: () => textResult("PASS lint", { passed: true, lintRef: "infographics/lints/l.json" }),
  newsroom_infographic_render: () => textResult("rendered", { renderQaPassed: true, manifestRef: "infographics/m.json" }),
  newsroom_infographic_critic: () => textResult("PASS critic", { passed: true, score: 88, criticRef: "infographics/critics/c.json" }),
  newsroom_infographic_preview: () => ({ content: [{ type: "text", text: "Observe" }, { type: "image", data: "AAAA", mimeType: "image/png" }], details: { previewRef: "infographics/previews/v.json" } }),
};
async function fake({ over = {}, enabled = () => true, mismatch = async () => null, schemas = {}, signal } = {}) {
  const calls = [];
  const events = [];
  const impl = { ...GOOD, ...over };
  const outcome = await runToolChain({
    steps: infographicChainSteps({ visualClaimMismatch: mismatch }),
    state: { planParams: { title: "t" } },
    enabled,
    schemaOf: (name) => schemas[name],
    call: async (name, params) => { calls.push([name, params]); return impl[name](params); },
    record: (event) => { events.push(event); },
    signal,
  });
  return { outcome, calls, events };
}
const names = (calls) => calls.map(([name]) => name);
const handoff = (state) => `Next: vision ${state.manifestRef} ${state.previewRef} ${state.criticRef}`;

{ // all pass: five steps, refs flow forward, image kept, hand-off names the three refs, no vision step
  const { outcome, calls, events } = await fake();
  assert.equal(outcome.status, "COMPLETE");
  assert.deepEqual(names(calls), PAGE_TOOLS);
  assert.deepEqual(calls[4][1], { manifest_ref: "infographics/m.json", critic_ref: "infographics/critics/c.json" });
  const res = chainResultFor(outcome, { chain: "newsroom_infographic_chain", textResult, handoff });
  assert.ok(res.content.some((b) => b.type === "image" && b.data === "AAAA"));
  assert.ok(res.content[0].text.includes("Next: vision infographics/m.json infographics/previews/v.json infographics/critics/c.json"));
  assert.equal(res.details.passed, true);
  assert.equal(res.details.score, 88);
  assert.equal(res.details.previewRef, "infographics/previews/v.json");
  assert.deepEqual(events.map((e) => `${e.phase}:${e.tool}`), PAGE_TOOLS.flatMap((t) => [`start:${t}`, `end:${t}`]));
  assert.ok(!names(calls).includes("newsroom_infographic_vision_critic"));
  check("complete chain: refs flow, image passed through, hand-off to the vision critic, event per step");
}
{ // cancellation: no step starts after it; finished steps and their refs are kept
  const pre = new AbortController();
  pre.abort();
  const before = await fake({ signal: pre.signal });
  assert.equal(before.outcome.code, "CANCELLED");
  assert.deepEqual(names(before.calls), []);
  for (let i = 0; i < PAGE_TOOLS.length - 1; i += 1) {
    const controller = new AbortController();
    const abortIn = PAGE_TOOLS[i];
    const { outcome, calls } = await fake({ signal: controller.signal, over: { [abortIn]: (params) => { controller.abort(); return GOOD[abortIn](params); } } });
    assert.equal(outcome.code, "CANCELLED", abortIn);
    assert.deepEqual(names(calls), PAGE_TOOLS.slice(0, i + 1), `abort during ${abortIn}`);
    assert.equal(outcome.done.length, i + 1);
    const res = chainResultFor(outcome, { chain: "newsroom_infographic_chain", textResult, handoff });
    assert.equal(res.details.stopCode, "CANCELLED");
    assert.ok(!res.content[0].text.includes("Next: vision"), "no hand-off after cancellation");
  }
  const afterHook = new AbortController();
  const mid = await fake({ signal: afterHook.signal, mismatch: async () => { afterHook.abort(); return null; } });
  assert.equal(mid.outcome.code, "CANCELLED", "abort during the claim check is honoured");
  assert.deepEqual(names(mid.calls), ["newsroom_infographic_plan"]);
  check("AbortSignal: checked before and after each step and the claim check; finished steps kept");
}
{ // an inner error result stops the chain; publishable is never copied from the plan
  const { outcome, calls } = await fake({ over: { newsroom_infographic_render: () => ({ ...textResult("boom", { renderQaPassed: true, manifestRef: "m" }), isError: true }) } });
  assert.equal(outcome.code, "STEP_ERROR");
  assert.deepEqual(names(calls), PAGE_TOOLS.slice(0, 3));
  const first = await fake({ over: { newsroom_infographic_plan: () => ({ ...textResult("bad plan", { planRef: "p" }), isError: true }) } }).catch((e) => e);
  assert.ok(first instanceof Error && /bad plan/.test(first.message));
  const done = await fake({ over: { newsroom_infographic_plan: () => textResult("p", { planRef: "p", publishable: true }) } });
  assert.equal(chainResultFor(done.outcome, { chain: "x", textResult }).details.publishable, undefined, "the plan's older publishable is not copied");
  check("an isError result stops the page chain; publishable is not copied from the plan");
}
for (const [label, tool, details, code, expectCalls] of [
  ["page plan DRAFT", "newsroom_infographic_plan", { planRef: "p", draft: true }, "DRAFT", 1],
  ["page plan not publishable", "newsroom_infographic_plan", { planRef: "p", publishable: false }, "DRAFT", 1],
  ["plan without planRef", "newsroom_infographic_plan", {}, "MISSING_FIELD", 1],
  ["page lint blocker", "newsroom_infographic_lint", { passed: false, lintRef: "x" }, "BLOCKED", 2],
  ["lint passed missing", "newsroom_infographic_lint", { lintRef: "x" }, "MISSING_FIELD", 2],
  ["render QA failed", "newsroom_infographic_render", { renderQaPassed: false }, "RENDER_QA_FAILED", 3],
  ["renderQaPassed missing", "newsroom_infographic_render", { manifestRef: "m" }, "MISSING_FIELD", 3],
  ["critic REVISE", "newsroom_infographic_critic", { passed: false }, "REVISE", 4],
  ["critic passed missing", "newsroom_infographic_critic", { score: 99, criticRef: "c" }, "MISSING_FIELD", 4],
  ["preview without previewRef", "newsroom_infographic_preview", {}, "MISSING_FIELD", 5],
]) {
  const { outcome, calls } = await fake({ over: { [tool]: () => textResult("verbatim body", details) } });
  assert.equal(outcome.status, "STOPPED", label);
  assert.equal(outcome.code, code, label);
  assert.equal(outcome.failedAt, tool, label);
  assert.equal(calls.length, expectCalls, label);
  const res = chainResultFor(outcome, { chain: "newsroom_infographic_chain", textResult, handoff });
  assert.ok(res.content[0].text.includes("verbatim body") && res.content[0].text.includes("separately next") && !res.content[0].text.includes("Next: vision"), label);
  check(`stops midway: ${label}`);
}
{ // a preview with no image block is a stop: the vision step would be blind
  const { outcome } = await fake({ over: { newsroom_infographic_preview: () => textResult("no picture", { previewRef: "v" }) } });
  assert.equal(outcome.code, "MISSING_FIELD");
  assert.match(outcome.message, /image content block/);
  check("preview without the image block stops the chain");
}
{ // a visual manifest that is not bound to its module's claim stops right after the plan
  const { outcome, calls } = await fake({ mismatch: async () => "visual module 'map' cites claim(s) c-a but its manifest m is bound to c-b" });
  assert.equal(outcome.code, "CLAIM_MANIFEST_MISMATCH");
  assert.equal(outcome.failedAt, "newsroom_infographic_plan");
  assert.deepEqual(names(calls), ["newsroom_infographic_plan"]);
  check("visual manifest/claim mismatch stops after the plan, before lint");
}
{ // not enabled in this phase/profile: never called
  const { outcome, calls } = await fake({ enabled: (name) => name !== "newsroom_infographic_render" });
  assert.equal(outcome.code, "TOOL_NOT_ENABLED");
  assert.equal(outcome.nextTool, "newsroom_infographic_render");
  assert.deepEqual(names(calls), PAGE_TOOLS.slice(0, 2));
  check("cross-phase: disabled inner tool is not called");
}
{ // first-step errors are thrown unchanged; later errors keep earlier results
  await assert.rejects(() => runToolChain({
    steps: infographicChainSteps({ visualClaimMismatch: async () => null }), state: { planParams: {} }, enabled: () => true,
    schemaOf: () => undefined, call: async () => { throw new Error("Infographic cannot proceed from a StoryGraph with blocking narrative-closure issues"); },
  }), /StoryGraph/);
  const { outcome } = await fake({ over: { newsroom_infographic_preview: () => { throw new Error("rasterizer missing"); } } });
  assert.equal(outcome.code, "STEP_ERROR");
  assert.equal(outcome.done.length, 4);
  check("plan error rethrown unchanged; later error keeps completed steps");
}
console.log(`orchestration (fake tools): ${results.length} checks -- PASS`);

// ---- Part 2: real tools -----------------------------------------------------
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
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}),
  Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }),
  Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};
`;
function loadTree(label, patchRegistry) {
  const dir = makeTestTmp(`ig-chain-tree-${label}-`);
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  if (patchRegistry) writeFileSync(join(pi, "tool_registry.mjs"), patchRegistry(readFileSync(join(pi, "tool_registry.mjs"), "utf8")));
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  return import(join(pi, "newsroom.test-copy.mjs")).then((mod) => ({ mod, dir }));
}
function register(mod, env) {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const BASE_ENV = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined };
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
// Run traces (the chain's timestamped event log, the boundary report) differ between a chain run and a manual run; lib_run_traces.mjs says which and checks them.
const snapshot = (art) => Object.fromEntries(withoutRunTraces(art, walk(art).map((f) => relative(art, f)).filter((f) => f !== CALL_REPORT), { chain: true, label: "snapshot" }).filter((f) => !f.startsWith("config/")).sort().map((f) => [f, readFileSync(join(art, f)).toString("base64")]));

const registry = JSON.parse(readFileSync(join(ROOT, "config/editorial-grammar-registry.json"), "utf8"));
void registry;
const readerQuestion = "How did the geography and scale of estimated international migration flows change?";
const visualThesis = "A route-led world view connects changing corridors to regional composition and long-run change.";
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#fafafa"/><path d="M5 30L95 30" stroke="#111"/><circle cx="75" cy="30" r="5"/></svg>';
const VIZ = [
  ["map", "geo_flow_map", "c-map"],
  ["sankey", "sankey", "c-flow"],
  ["trend", "line", "c-trend"],
];

// Writes everything the page plan reads from disk; `mutate` can bend one piece.
function freshRun(label, { manifestClaim = {}, criticPassed = {}, draft = {} } = {}) {
  const art = join(makeTestTmp(`ig-chain-${label}-`), "run");
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
  writeFileSync(join(art, "editorial/concepts/migration.json"), JSON.stringify({ finalists: ["route-spine"] }));
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

// The preview step shells out to python3 rasterize_svg.py (CairoSVG or Chrome). To keep this
// test independent of those, NEWSROOM_PYTHON_BIN points at a stub that writes a fixed PNG; only
// the rasterizer is replaced, every gate around it runs for real.
{
  const stubDir = makeTestTmp("ig-chain-raster-");
  writeFileSync(join(stubDir, "fixed.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]));
  const bin = join(stubDir, "python-stub.sh");
  writeFileSync(bin, `#!/bin/sh\ncp "${join(stubDir, "fixed.png")}" "$3"\necho '{"engine":"test-stub"}'\n`);
  chmodSync(bin, 0o755);
  process.env.NEWSROOM_PYTHON_BIN = bin;
}
const { mod } = await loadTree("main");
const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1" });
assert.ok(tools.has("newsroom_infographic_chain"));

async function manual(params) {
  const plan = await tools.get("newsroom_infographic_plan").execute("p", params);
  const lint = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: plan.details.planRef });
  if (lint.details.passed !== true) throw new Error(`fixture lint blocked: ${lint.details.blockers.join(" | ")}`);
  const render = await tools.get("newsroom_infographic_render").execute("r", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
  const critic = await tools.get("newsroom_infographic_critic").execute("c", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef, manifest_ref: render.details.manifestRef });
  const preview = await tools.get("newsroom_infographic_preview").execute("v", { manifest_ref: render.details.manifestRef, critic_ref: critic.details.criticRef });
  return { plan, lint, render, critic, preview };
}

{ // switch off: nothing new is registered; on: only the chain tool is added
  const off = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: undefined });
  const on = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1" });
  assert.ok(!off.has("newsroom_infographic_chain") && on.has("newsroom_infographic_chain"));
  assert.deepEqual([...on.keys()].filter((n) => n !== "newsroom_infographic_chain").sort(), [...off.keys()].sort());
  for (const name of off.keys()) assert.equal(JSON.stringify(on.get(name).parameters) + on.get(name).description, JSON.stringify(off.get(name).parameters) + off.get(name).description, name);
  assert.ok(!register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "true" }).has("newsroom_infographic_chain"), "only exactly '1' turns it on");
  const noPlan = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", NEWSROOM_TOOL_PROFILE: "investigate" });
  assert.ok(!noPlan.has("newsroom_infographic_plan") && !noPlan.has("newsroom_infographic_chain"), "no plan tool in this profile -> no chain");
  const schema = on.get("newsroom_infographic_chain").parameters;
  assert.ok(schema.properties.title && schema.required.includes("title") && !schema.required.includes("reader_question") && !schema.required.includes("visual_thesis"));
  assert.ok(schema.required.includes("story_graph_ref"));
  register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1" });
  for (const atomic of [undefined, "0", "true"]) {
    const t = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: atomic });
    assert.ok(!t.has("newsroom_infographic_chain"), `chain needs atomic writes exactly "1" (got ${atomic})`);
    assert.deepEqual([...t.keys()].sort(), [...off.keys()].sort(), "other tools unchanged when the chain is refused");
  }
  check("switch off registers nothing new; on adds only newsroom_infographic_chain; question/thesis optional; chain x atomic on/off");
}

// Skip the real-tool checks only when a dependency is explicitly absent
// (the duckdb binary cannot be started); any other failure is a real failure.
const missingDependency = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT" ? "duckdb binary not found" : null;
const previewWorks = !missingDependency;
if (missingDependency) console.log(`${missingDependency}; skipping the real-tool checks`);
if (previewWorks) { // chain == manual, byte for byte; the reader question and thesis are copied from the StoryGraph
  const manualArt = freshRun("manual");
  const m = await manual(pagePlan({ withQuestion: true }));
  {
    const chainArt = freshRun("chain");
    const out = await tools.get("newsroom_infographic_chain").execute("chain-0", pagePlan());
    assert.equal(out.details.chainStatus, "COMPLETE", JSON.stringify(out.details).slice(0, 600));
    assert.deepEqual(out.details.steps.map((s) => s.tool), PAGE_TOOLS);
    for (const [key, ref] of [["planRef", m.plan.details.planRef], ["lintRef", m.lint.details.lintRef], ["manifestRef", m.render.details.manifestRef], ["criticRef", m.critic.details.criticRef], ["previewRef", m.preview.details.previewRef]]) assert.equal(out.details[key], ref, key);
    assert.deepEqual(snapshot(chainArt), snapshot(manualArt), "chain and step-by-step produce byte-identical artifacts");
    expectSameReports(chainArt, manualArt, { onlyInA: INFOGRAPHIC_CHAIN_ONLY_ON }, "infographic_chain: chain vs step-by-step call report");
    // The shape src/audit.rs expands inner calls from (outer end event -> result.details), and
    // inner args/details equal to what the step-by-step calls carried.
    assert.equal(out.details.chain, "newsroom_infographic_chain");
    assert.deepEqual(out.details.steps[1].params, { plan_ref: m.plan.details.planRef });
    assert.deepEqual(out.details.steps[4].params, { manifest_ref: m.render.details.manifestRef, critic_ref: m.critic.details.criticRef });
    for (const [i, key] of ["plan", "lint", "render", "critic", "preview"].entries()) {
      const step = out.details.steps[i];
      assert.equal(step.tool, PAGE_TOOLS[i]);
      assert.equal(typeof step.params, "object");
      assert.deepEqual(step.details, m[key].details, `${key}: inner details equal the direct call's`);
    }
    const image = out.content.filter((b) => b.type === "image");
    assert.equal(image.length, 1);
    assert.deepEqual(image[0], m.preview.content.find((b) => b.type === "image"), "preview image passed through verbatim");
    assert.match(out.content[0].text, /newsroom_infographic_vision_critic with manifest_ref=/);
    assert.ok(!existsSync(join(chainArt, "infographics", "vision-critics")), "the chain never writes a vision critique");
    const events = readFileSync(join(chainArt, "runtime", "tool-chain-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => `${e.type}:${e.toolName}`), PAGE_TOOLS.flatMap((t) => [`tool_execution_start:${t}`, `tool_execution_end:${t}`]));
    const plan = JSON.parse(readFileSync(join(chainArt, out.details.planRef), "utf8"));
    assert.equal(plan.reader_question, readerQuestion);
    assert.equal(plan.visual_thesis, visualThesis);
    check("real: chain == manual byte for byte, question/thesis copied from the StoryGraph, image verbatim, events per step, no vision critique");
  }
}

if (previewWorks) {
  { // a question that differs from the StoryGraph's is not overridden: the plan step throws as a direct call would
    freshRun("badq");
    await assert.rejects(() => tools.get("newsroom_infographic_chain").execute("q", pagePlan({ withQuestion: true, readerQuestionOverride: "Something else?" })), /reader_question must exactly match StoryGraph/);
    check("real: a reader_question that differs from the StoryGraph is rejected, not overridden");
  }
  { // must-fail: page plan with a DRAFT visual manifest -> the plan step throws (first step), nothing else written
    const art = freshRun("draft", { draft: { trend: true } });
    await assert.rejects(() => tools.get("newsroom_infographic_chain").execute("d", pagePlan()), /DRAFT\/non-publishable visualization manifest/);
    assert.deepEqual(readdirSync(join(art, "infographics")).sort(), ["lints", "plans", "previews"].sort());
    assert.equal(readdirSync(join(art, "infographics/plans")).length, 0);
    check("real must-fail: DRAFT/non-publishable visual manifest -> plan throws, no page artifacts");
  }
  { // must-fail: a visual whose critic did not pass
    freshRun("badcritic", { criticPassed: { map: false } });
    await assert.rejects(() => tools.get("newsroom_infographic_chain").execute("bc", pagePlan()), /critic did not pass/);
    check("real must-fail: visual critic not passed -> plan throws");
  }
  { // must-fail: visual manifest bound to a different (verified) claim than the module cites
    const art = freshRun("mismatch", { manifestClaim: { map: "c-flow" } });
    const out = await tools.get("newsroom_infographic_chain").execute("mm", pagePlan({ moduleClaims: { map: ["c-map"] } }));
    assert.equal(out.details.chainStatus, "STOPPED");
    assert.equal(out.details.stopCode, "CLAIM_MANIFEST_MISMATCH");
    assert.deepEqual(out.details.steps.map((s) => s.tool), ["newsroom_infographic_plan"]);
    assert.deepEqual(readdirSync(join(art, "infographics/lints")), []);
    check("real must-fail: visual manifest bound to another claim than the module cites -> stop before lint");
  }
  { // must-fail: a visual manifest that is bound to no claim at all
    freshRun("noclaim", { manifestClaim: { map: "" } });
    const out = await tools.get("newsroom_infographic_chain").execute("nc", pagePlan());
    assert.equal(out.details.stopCode, "CLAIM_MANIFEST_MISMATCH");
    check("real must-fail: visual manifest with no claim binding -> stop before lint");
  }
  { // must-fail: page lint blocker -> stop at lint, no render/critic/preview artifacts
    const art = freshRun("lintblock");
    const plan = pagePlan();
    plan.modules.find((m) => m.id === "flow").span = "half"; // lint: a visual must be full width while mobile pages are off
    const direct = await (async () => {
      const p = await tools.get("newsroom_infographic_plan").execute("dp", { ...plan, reader_question: readerQuestion, visual_thesis: visualThesis });
      return tools.get("newsroom_infographic_lint").execute("dl", { plan_ref: p.details.planRef });
    })();
    assert.equal(direct.details.passed, false, "fixture must really block at lint");
    {
      const out = await tools.get("newsroom_infographic_chain").execute("lb", plan);
      assert.equal(out.details.stopCode, "BLOCKED");
      assert.equal(out.details.failedAt, "newsroom_infographic_lint");
      assert.equal(out.details.nextTool, "newsroom_infographic_lint");
      assert.deepEqual(out.details.steps.map((s) => s.tool), PAGE_TOOLS.slice(0, 2));
      assert.deepEqual(readdirSync(join(art, "infographics")).filter((n) => /\.(json|svg)$/.test(n)), []);
      assert.ok(!existsSync(join(art, "infographics/critics")) && !existsSync(join(art, "infographics/rejected")));
      assert.ok(out.content[0].text.includes("BLOCKED: infographic lint"));
      check("real must-fail: page lint blocker -> stop at lint, nothing rendered");
    }
  }
  { // must-fail: after a vision REVISE the same plan cannot be rendered again
    const art = freshRun("vision");
    const out = await tools.get("newsroom_infographic_chain").execute("v1", pagePlan());
    assert.equal(out.details.chainStatus, "COMPLETE");
    const revise = await tools.get("newsroom_infographic_vision_critic").execute("vc", {
      manifest_ref: out.details.manifestRef, preview_ref: out.details.previewRef, deterministic_critic_ref: out.details.criticRef,
      passed: false, score: 40, confidence: 0.8,
      rubric: Object.fromEntries(["hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness"].map((k) => [k, 40])),
      issues: [], patches: [],
    }).catch((error) => ({ error }));
    assert.ok(!revise.error, String(revise.error?.message));
    {
      assert.equal(revise.details.passed, false);
      assert.ok(revise.details.rejectedManifestRef, "REVISE moves the manifest to rejected/");
      const again = await tools.get("newsroom_infographic_chain").execute("v2", pagePlan());
      assert.equal(again.details.chainStatus, "STOPPED");
      assert.equal(again.details.failedAt, "newsroom_infographic_render");
      assert.equal(again.details.stopCode, "STEP_ERROR");
      assert.match(again.details.stopMessage, /REJECTED/);
      assert.ok(existsSync(join(art, revise.details.rejectedManifestRef)), "rejected evidence kept");
      check("real must-fail: vision REVISE -> manifest rejected; running the same plan again stops at render (REJECTED)");
    }
  }
  { // claims.jsonl is never touched by a chain run
    const art = freshRun("claims");
    const before = readFileSync(join(art, "claims.jsonl"), "utf8");
    await tools.get("newsroom_infographic_chain").execute("cl", pagePlan());
    assert.equal(readFileSync(join(art, "claims.jsonl"), "utf8"), before);
    check("real: claims.jsonl is byte-identical after a chain run");
  }
  { // fault injection and cross-phase: a registry with render hidden
    const { mod: patched } = await loadTree("xphase", (text) => text.replace(/("name": "newsroom_infographic_render"[\s\S]*?"agent_visible": )true/, "$1false"));
    const t = register(patched, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1" });
    assert.ok(t.has("newsroom_infographic_chain") && t.has("newsroom_infographic_lint") && !t.has("newsroom_infographic_render"));
    freshRun("xphase");
    const out = await t.get("newsroom_infographic_chain").execute("x", pagePlan());
    assert.equal(out.details.stopCode, "TOOL_NOT_ENABLED");
    assert.equal(out.details.failedAt, "newsroom_infographic_render");
    assert.deepEqual(out.details.steps.map((s) => s.tool), PAGE_TOOLS.slice(0, 2));
    check("real: cross-phase/profile restriction stops the chain before the disabled tool");
  }
}

for (const name of results) assert.ok(name);
console.log(results.map((name) => `  ok  ${name}`).join("\n"));
console.log(`infographic chain: ${results.length} checks -- PASS${previewWorks ? "" : " (duckdb unavailable: real checks skipped)"}`);
