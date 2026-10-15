// NEWSROOM_REVIEW_SPLIT=1 end to end on the page tools: plan -> lint -> render -> critic -> preview, with the real tools.
// Passing run: the draw step writes no render-QA record, the critic does, and its report equals the one the default layout's draw step wrote.
// Failing runs: a manifest a draw step stamped with render_qa is refused by the critic; a failing critic moves the manifest to rejected/
// through the hand-off writer. When K244_E2E_OUT is set the passing runs are copied there for the Rust verify test (verify::tests::review_split_e2e_dir).
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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { assessStoryGraph } = await import(join(ROOT, "runtime/pi/story_graph.mjs"));
const results = [];
const check = (name) => { results.push(name); };
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
const snapshot = (art) => Object.fromEntries(withoutRunTraces(art, walk(art).map((f) => relative(art, f)), { chain: true, label: "snapshot" }).filter((f) => !f.startsWith("config/")).sort().map((f) => [f, readFileSync(join(art, f)).toString("base64")]));

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

const missingDependency = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT" ? "duckdb binary not found" : null;
if (missingDependency) console.log(`${missingDependency}; skipping the real-tool checks`);
else {
  const rubric = Object.fromEntries(["hierarchy", "legibility", "composition", "visual_coherence", "typography", "source_legibility", "responsive_quality", "illustration_integration", "color_contrast", "editorial_distinctiveness"].map((k) => [k, 90]));
  const vision = (art, m, passed) => tools.get("newsroom_infographic_vision_critic").execute("vc", {
    manifest_ref: m.render.details.manifestRef, preview_ref: m.preview.details.previewRef, deterministic_critic_ref: m.critic.details.criticRef,
    passed, score: passed ? 90 : 40, confidence: 0.8, rubric: passed ? rubric : { ...rubric, hierarchy: 40 }, issues: [], patches: [],
  });
  const out = process.env.K244_E2E_OUT;
  const keep = (art, name) => { if (out) cpSync(art, join(out, name), { recursive: true }); };
  const run = async (label, split) => {
    if (split) process.env.NEWSROOM_REVIEW_SPLIT = "1"; else delete process.env.NEWSROOM_REVIEW_SPLIT;
    const art = freshRun(label);
    return { art, m: await manual(pagePlan({ withQuestion: true })) };
  };

  // default layout: the draw step writes the QA report and stamps the manifest
  const off = await run("off", false);
  const offManifest = JSON.parse(readFileSync(join(off.art, off.m.render.details.manifestRef), "utf8"));
  assert.ok(offManifest.render_qa_ref && offManifest.render_qa);
  const offReport = readFileSync(join(off.art, offManifest.render_qa_ref), "utf8");
  assert.equal(off.m.critic.details.render_qa_ref, undefined);
  check("default off: the draw step writes the QA report and stamps the manifest (as before)");

  // switch on: step by step, so the state between render and critic can be looked at
  process.env.NEWSROOM_REVIEW_SPLIT = "1";
  const art = freshRun("on");
  const plan = await tools.get("newsroom_infographic_plan").execute("p", pagePlan({ withQuestion: true }));
  const lint = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: plan.details.planRef });
  const render = await tools.get("newsroom_infographic_render").execute("r", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
  const manifest = JSON.parse(readFileSync(join(art, render.details.manifestRef), "utf8"));
  assert.ok(!("render_qa_ref" in manifest) && !("render_qa" in manifest), "the draw step stamps no render-QA record");
  assert.ok(!existsSync(join(art, "infographics/qa")), "the draw step writes nothing under qa/");
  assert.equal(render.details.renderQaRef, undefined);
  assert.ok(!render.content[0].text.includes("infographics/qa/") && /in memory/.test(render.content[0].text));
  assert.equal(render.details.renderQaPassed, true);
  check("on: render stamps no render_qa on the manifest, writes no qa file, names none in text or details");
  const critic = await tools.get("newsroom_infographic_critic").execute("c", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef, manifest_ref: render.details.manifestRef });
  const criticRecord = JSON.parse(readFileSync(join(art, critic.details.criticRef), "utf8"));
  assert.equal(criticRecord.passed, true);
  assert.match(criticRecord.render_qa_ref, /^infographics\/qa\/[0-9a-f]{64}\.json$/);
  assert.equal(readFileSync(join(art, criticRecord.render_qa_ref), "utf8"), offReport, "the critic's recomputed report equals the draw step's report in the default layout");
  check("on: the critic writes infographics/qa/<key>.json and names it as render_qa_ref; the report equals the default layout's, byte for byte");
  const preview = await tools.get("newsroom_infographic_preview").execute("v", { manifest_ref: render.details.manifestRef, critic_ref: critic.details.criticRef });
  const onRun = { plan, lint, render, critic, preview };
  const pass = await vision(art, onRun, true);
  assert.equal(pass.details.passed, true, JSON.stringify(pass.details).slice(0, 400));
  assert.ok(!existsSync(join(art, "infographics/rejected")));
  keep(art, "pass");
  check("on: a passing run reaches a passing vision critic; nothing moved to rejected/");

  // must-fail: the critic record loses its render_qa_ref -> the verifier has no QA report to read (copy of the passing run, so the passing folder stays intact)
  if (out) {
    cpSync(art, join(out, "noref"), { recursive: true });
    const cp = join(out, "noref", critic.details.criticRef);
    const { render_qa_ref: _gone, ...rest } = JSON.parse(readFileSync(cp, "utf8"));
    writeFileSync(cp, JSON.stringify(rest));
    check("on, must-fail (verify side): a critic record without render_qa_ref leaves the verifier no report; see verify::tests::review_split_e2e_dir");
  }

  // must-fail: a manifest a draw step stamped with render_qa is refused by the critic
  const stamped = await run("stamped", true);
  const mpath = join(stamped.art, stamped.m.render.details.manifestRef);
  const sm = JSON.parse(readFileSync(mpath, "utf8"));
  writeFileSync(mpath, JSON.stringify({ ...sm, render_qa_ref: offManifest.render_qa_ref, render_qa: offManifest.render_qa }));
  await assert.rejects(() => tools.get("newsroom_infographic_critic").execute("c", { plan_ref: stamped.m.plan.details.planRef, lint_ref: stamped.m.lint.details.lintRef, manifest_ref: stamped.m.render.details.manifestRef }), /written by the draw step/);
  keep(stamped.art, "stamped");
  check("on, must-fail: a manifest carrying a draw-written render_qa is refused by the critic");

  // must-fail: a failing vision critic moves the manifest to rejected/ through the hand-off writer
  const bad = await run("revise", true);
  const revise = await vision(bad.art, bad.m, false);
  assert.equal(revise.details.passed, false);
  assert.ok(revise.details.rejectedManifestRef && existsSync(join(bad.art, revise.details.rejectedManifestRef)));
  assert.ok(!existsSync(join(bad.art, bad.m.render.details.manifestRef)), "the draw manifest is gone from infographics/");
  keep(bad.art, "revised");
  check("on, must-fail: a vision REVISE moves the manifest to rejected/ (writer), the failing record stays");
  delete process.env.NEWSROOM_REVIEW_SPLIT;
}
for (const name of results) assert.ok(name);
console.log(results.map((name) => `  ok  ${name}`).join("\n"));
console.log(`review split infographic: ${results.length} checks -- PASS${missingDependency ? " (duckdb unavailable: real checks skipped)" : ""}`);
