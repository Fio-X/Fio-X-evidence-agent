#!/usr/bin/env node
// Compact (8-of-12-column) chart variant through the REAL tools: newsroom_viz_plan/lint/render/critic
// (duckdb) write the .compact.svg + manifest hashes + render-QA hash; the real page tools
// (newsroom_infographic_plan/lint/render) bind to them. Loads a type-stripped copy of newsroom.ts.
// Pages are desktop-only. Needs the duckdb binary.
import "./location_backing_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { assessStoryGraph } = await import(join(ROOT, "runtime/pi/story_graph.mjs"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

if (spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") {
  console.log("duckdb binary not found; cannot exercise the real tools");
  process.exit(1);
}

// ---- harness (same shape as test_viz_chain_runtime.mjs / test_infographic_chain_runtime.mjs) ----
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
const treeDir = makeTestTmp("compact-rt-tree-");
cpSync(join(ROOT, "runtime"), join(treeDir, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(treeDir, "config"), { recursive: true });
stub(treeDir, "typebox", TYPEBOX);
stub(treeDir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const copy = join(treeDir, "runtime", "pi", "newsroom.test-copy.mjs");
writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(copy);

for (const [k, v] of Object.entries({ NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_SPEED_CHAIN_VIZ: undefined, NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: undefined })) {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
const tools = new Map();
mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
const run = (name, params) => tools.get(name).execute(`t-${name}`, params);

// ---- fixtures ----
const CSV = ["country,year,share", "Chad,2022,70.0", "Guinea,2022,66.6", "Liberia,2022,92.8", "Niger,2021,79.6", "Nigeria,2021,80.3", "Zambia,2021,83.0"].join("\n") + "\n";
const SQL = "SELECT country, share FROM 'data/africa.csv' ORDER BY share DESC";
const csvSha = sha256(CSV);
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
const readerQuestion = "How did the geography and scale of estimated international migration flows change?";
const visualThesis = "A route-led world view connects changing corridors to regional composition and long-run change.";
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#fafafa"/><path d="M5 30L95 30" stroke="#111"/><circle cx="75" cy="30" r="5"/></svg>';
const chartPlan = (chartType, claimId) => ({
  reader_task: "sequence", title: "Renewable share by country", alt: "A chart of renewable energy share across several African countries.",
  takeaway: "Liberia has the highest renewable share of the countries shown.", source_note: "fixture", sql: SQL, unit: "%", chart_type: chartType,
  category_field: "country", value_field: "share", highlight_values: [], annotations: [], claim_id: claimId,
});

// A run directory holding: the page fixture (map/sankey hand-written manifests), plus the page's third visual
// ("trend") rendered by the real viz tools as `chartType`. Claim c-trend is bound to that chart's computation.
async function freshPage(label, chartType = "horizontal_bar") {
  const art = join(makeTestTmp(`compact-rt-${label}-`), "run");
  for (const d of ["visualizations/plans", "visualizations/lints", "visualizations/critics", "computations", "data", "sources", "editorial/story-graphs", "editorial/discovery", "editorial/concepts", "editorial/novelty", "editorial/assets", "infographics/plans", "infographics/lints", "runtime"]) mkdirSync(join(art, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  writeFileSync(join(art, "data", "africa.csv"), CSV);
  writeFileSync(join(art, "data", "africa.meta.json"), JSON.stringify({ file: "africa.csv", sha256: csvSha }));
  writeFileSync(join(art, "claims.jsonl"), "");
  process.env.NEWSROOM_ARTIFACT_DIR = art;

  // fixture computation for the hand-written visuals/claims
  const fcsv = "region,value\nA,1\nB,2\n";
  const fsha = sha256(fcsv);
  writeFileSync(join(art, "data", "x.csv"), fcsv);
  writeFileSync(join(art, "data", "x.meta.json"), JSON.stringify({ file: "x.csv", sha256: fsha }));
  const computation = { schema_version: "0.7.0", sql: "SELECT region, value FROM 'data/x.csv' ORDER BY region", input_snapshot_hash: fsha, input_fingerprints: [`data:x.csv:${fsha}`], read_inputs: [{ path: "data/x.csv", sha256: fsha }], input_binding: "source_bound", result_hash: fsha, rows: [{ region: "A", value: 1 }, { region: "B", value: 2 }] };
  const fixtureComp = `computations/${sha256(JSON.stringify(computation))}.json`;
  writeFileSync(join(art, fixtureComp), JSON.stringify(computation));

  // the real chart's computation + claim
  const query = await run("duckdb_query", { sql: SQL });
  const realComp = query.details.path.startsWith("/") ? relative(art, query.details.path) : query.details.path;
  const claim = (claim_id, comp) => JSON.stringify({ claim_id, status: "verified", source_refs: [claim_id === "c-trend" ? "data/africa.csv" : "data/x.csv"], computation_refs: [comp], verification });
  writeFileSync(join(art, "claims.jsonl"), `${[claim("c-map", fixtureComp), claim("c-flow", fixtureComp), claim("c-trend", realComp), claim("c-outcome", fixtureComp)].join("\n")}\n`);
  for (const [id, chart_type, claim_id] of [["map", "geo_flow_map", "c-map"], ["sankey", "sankey", "c-flow"]]) {
    writeFileSync(join(art, `visualizations/${id}.svg`), svg);
    writeFileSync(join(art, `visualizations/${id}.json`), JSON.stringify({ chart_type, claim_id, computation_ref: fixtureComp, source_note: "Gaskin and Abel model estimates, 1990-2023", verification_mode: "verified", artifact_status: "VERIFIED", publishable: true, variants: { desktop: `visualizations/${id}.svg` } }));
    writeFileSync(join(art, `visualizations/critics/${id}.json`), JSON.stringify({ passed: true, score: 90, manifest_ref: `visualizations/${id}.json` }));
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

  const chart = await renderChart(chartType, "c-trend");
  // the page module reads the chart's critic from the standard critics dir
  return { art, ...chart };
}

// plan -> lint -> render -> critic by hand, returning every artifact path and the critic outcome.
async function renderChart(chartType, claimId, { expectCritic = true } = {}) {
  const art = process.env.NEWSROOM_ARTIFACT_DIR;
  const plan = await run("newsroom_viz_plan", chartPlan(chartType, claimId));
  assert.ok(plan.details.planRef, `viz plan: ${plan.content[0].text.slice(0, 300)}`);
  const lint = await run("newsroom_viz_lint", { plan_ref: plan.details.planRef });
  assert.equal(lint.details.passed, true, `viz lint: ${lint.content[0].text.slice(0, 400)}`);
  const render = await run("newsroom_viz_render", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
  assert.equal(render.details.renderQaPassed, true, `viz render: ${render.content[0].text.slice(0, 400)}`);
  const manifestRef = render.details.manifestRef;
  const criticArgs = { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef, manifest_ref: manifestRef };
  const critic = expectCritic ? await run("newsroom_viz_critic", criticArgs) : null;
  const manifest = JSON.parse(readFileSync(join(art, manifestRef), "utf8"));
  return { plan, lint, render, critic, criticArgs, manifestRef, manifest };
}
const criticOutcome = async (args) => {
  try { const res = await run("newsroom_viz_critic", args); return { threw: false, passed: res.details.passed, text: res.content[0].text }; }
  catch (error) { return { threw: true, text: String(error.message) }; }
};
const isRejected = (o) => o.threw || o.passed === false;

const failures = [];
const quantitative = { quantity_kind: "estimated_flow", mark_semantics: "flow_width", scale_type: "linear", baseline_policy: "not_applicable", uncertainty_disclosed: true, disclosure: "Mean estimates are shown; standard deviation is available in the source data." };
// Page plan. `trendScene` chooses where the chart sits: "anchor8" (hero_sidecar_stack anchor, 8 columns) or "sidecar4"
// (a 4-column sidecar of a hero_sidecar_stack scene anchored by the map; the map itself is then also blocked, only the trend blocker is asserted).
function pagePlan({ manifestRef, criticRef, trendScene = "anchor8" }) {
  const editorial_grammar = {
    project_id: "migration", primary: "ROUTE_SPINE", supporting: ["THEN_NOW", "SCALE_TRANSLATOR"],
    available_renderer_capabilities: ["svg", "canvas2d"],
    evidence_features: ["origin_destination_relation", "verified_locations", "comparable_timepoints", "quantity", "human_scale_reference"],
    cognitive_goals: ["ORIENT", "ZOOM", "MEASURE", "COMPARE", "CONSEQUENCE"],
  };
  const scenes = trendScene === "anchor8"
    ? [
      { id: "orient", pattern: "hero_with_rail", anchor_module_id: "map", sidecar_module_ids: ["flow"], primary_cognitive_goal: "ORIENT", hero_object_id: "route-a", supporting_claim_ids: ["c-map", "c-flow"], scene_budget: { max_supporting_objects: 1, max_annotations: 2, max_claims: 2 } },
      { id: "compare", pattern: "hero_sidecar_stack", anchor_module_id: "trend", sidecar_module_ids: ["resolution"], primary_cognitive_goal: "COMPARE", hero_object_id: "trend", supporting_claim_ids: ["c-trend", "c-outcome"], scene_budget: { max_supporting_objects: 1, max_annotations: 1, max_claims: 2 } },
    ]
    : [
      { id: "orient", pattern: "hero_sidecar_stack", anchor_module_id: "map", sidecar_module_ids: ["trend"], primary_cognitive_goal: "ORIENT", hero_object_id: "route-a", supporting_claim_ids: ["c-map", "c-trend"], scene_budget: { max_supporting_objects: 1, max_annotations: 2, max_claims: 2 } },
      { id: "compare", pattern: "hero_with_rail", anchor_module_id: "flow", sidecar_module_ids: ["resolution"], primary_cognitive_goal: "COMPARE", hero_object_id: "regional-links", supporting_claim_ids: ["c-flow", "c-outcome"], scene_budget: { max_supporting_objects: 1, max_annotations: 1, max_claims: 2 } },
  ];
  return {
    title: "The routes moved", dek: "A route-led account of changing estimated migration flows.",
    alt: "A world route map, regional Sankey and trend view explain changes in model-estimated international migration flows.",
    layout: "feature", complexity_budget: "medium", intent: "Explain changing migration geography without confusing estimated flows and stocks.",
    primary_message: "The geography and scale of estimated routes changed together.",
    story_graph_ref: "editorial/story-graphs/migration.json", story_arc: "question_answer", audience: "general", quality_target: "publishable", competition_profile: "editorial",
    editorial_discovery_ref: "editorial/discovery/migration.json", visual_concept_ref: "editorial/concepts/migration.json", selected_concept_id: "route-spine",
    novelty_ref: "editorial/novelty/migration.json", asset_plan_ref: "editorial/assets/migration.json", editorial_grammar,
    mobile_module_order: ["map", "flow", "trend", "resolution"],
    scene_graph: { schema_version: "0.2.0", scenes },
    modules: [
      { id: "map", type: "visual", span: "full", manifest_ref: "visualizations/map.json", critic_ref: "visualizations/critics/map.json", visual_grammar: "spatial", story_node_ids: ["n-map"], story_role: "hook", priority: 1, emphasis: "hero", claim_set: ["c-map"], graphic_object_ids: ["route-a"], annotations: [{ id: "map-note", target_object_id: "route-a", text: "A model-estimated route, not an observed journey.", claim_id: "c-map" }], visual_channels: [{ channel: "size", field: "estimated_flow_mean", role: "quantitative" }, { channel: "connection", field: "origin_destination", role: "identity" }], quantitative_encoding: quantitative },
      { id: "flow", type: "visual", span: "full", manifest_ref: "visualizations/sankey.json", critic_ref: "visualizations/critics/sankey.json", visual_grammar: "flow", story_node_ids: ["n-composition"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: ["c-flow"], graphic_object_ids: ["regional-links"], visual_channels: [{ channel: "length", field: "estimated_flow_mean", role: "quantitative" }, { channel: "connection", field: "region_pair", role: "identity" }], quantitative_encoding: quantitative },
      { id: "trend", type: "visual", span: "full", label: "Share by country", manifest_ref: manifestRef, critic_ref: criticRef, visual_grammar: "rank", story_node_ids: ["n-change"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: ["c-trend"], graphic_object_ids: ["trend-line"], visual_channels: [{ channel: "position", field: "share", role: "quantitative" }, { channel: "color", field: "country", role: "categorical" }], quantitative_encoding: { ...quantitative, mark_semantics: "length", baseline_policy: "zero" } },
      { id: "resolution", type: "text", span: "third", body: "The result is a changed route system, not a direct reading of migrant-stock differences.", claim_ids: ["c-outcome"], claim_set: ["c-outcome"], story_node_ids: ["n-change"], story_role: "resolution", priority: 2, emphasis: "support" },
    ],
    reader_question: readerQuestion, visual_thesis: visualThesis,
  };
}
const criticRefOf = (c) => c.critic.details.criticRef;
async function pageLint(planParams) {
  const plan = await run("newsroom_infographic_plan", planParams);
  const lint = await run("newsroom_infographic_lint", { plan_ref: plan.details.planRef });
  return { plan, lint };
}
const compactPath = (art, manifest) => join(art, manifest.variants.compact);
const flipByte = (file) => { const text = readFileSync(file, "utf8"); writeFileSync(file, text.replace("<svg", "<svg data-tampered=\"1\""), "utf8"); assert.notEqual(readFileSync(file, "utf8"), text); };

// ---- 1. real tools write a consistent compact variant ----
{
  const { art, manifest, render, critic, manifestRef } = await freshPage("s1");
  assert.ok(manifest.variants.compact, "manifest.variants.compact present");
  assert.match(manifest.variants.compact, /\.compact\.svg$/);
  assert.ok(!manifest.variants.mobile, "mobile pages are off: no mobile variant");
  const file = compactPath(art, manifest);
  assert.ok(existsSync(file), "compact svg written to disk");
  const fileSha = sha256(readFileSync(file, "utf8"));
  assert.equal(manifest.hashes.compact_sha256, fileSha, "hashes.compact_sha256 == sha256(file)");
  assert.equal(manifest.hashes.desktop_sha256, sha256(readFileSync(join(art, manifest.variants.desktop), "utf8")));
  // the manifest carries no render-QA ref, the critic record that passed it does
  const qaRef = JSON.parse(readFileSync(join(art, criticRefOf({ critic })), "utf8")).render_qa_ref;
  assert.ok(!("render_qa_ref" in manifest) && !("render_qa" in manifest), "the manifest carries no render-QA record");
  assert.ok(qaRef, "the critic carries a render-QA ref");
  const qa = JSON.parse(readFileSync(join(art, qaRef), "utf8"));
  assert.equal(qa.viewports.compact.passed, true, "render QA compact viewport passed");
  assert.equal(qa.viewports.compact.svg_sha256, fileSha, "render QA covers the same compact bytes");
  assert.equal(render.details.renderQaPassed, true);
  assert.equal(critic.details.passed, true, `critic must pass: ${critic.content[0].text.slice(0, 300)}`);
  void manifestRef;
  console.log("PASS 1 real tools: compact svg + manifest hashes + render-QA hash agree; critic passes");
}

// ---- 2. tamper the compact svg after render ----
{
  const { art, manifest, criticArgs } = await freshPage("s2");
  flipByte(compactPath(art, manifest));
  const outcome = await criticOutcome(criticArgs);
  assert.ok(isRejected(outcome), "critic must not pass a tampered compact svg");
  // the critic recomputes the render-QA record from the tampered bytes; it collides with the record already stored under that key
  assert.match(outcome.text, /^Immutable artifact collision: existing bytes differ at visualizations\/qa\/[0-9a-f]{64}\.json$/);
  // The page path must refuse it too: a page plan can be written (it reads only manifests) but lint must not pass.
  // fresh page whose critic exists, then tamper
  const page = await freshPage("s2b");
  flipByte(compactPath(page.art, page.manifest));
  const params = pagePlan({ manifestRef: page.manifestRef, criticRef: criticRefOf(page) });
  let lintBlocked = false;
  try {
    const { lint } = await pageLint(params);
    lintBlocked = lint.details.passed === false;
  } catch (error) {
    lintBlocked = /compact SVG does not match/i.test(String(error.message));
    assert.match(String(error.message), /compact SVG does not match its recorded hash and render QA report/);
  }
  assert.ok(lintBlocked, "page lint must not pass with a tampered compact svg");
  console.log("PASS 2 tamper after render: critic rejects (Compact visualization SVG ... hash); page lint rejects via loadInfographicAssets");
}

// ---- 3. tamper after page lint ----
{
  const page = await freshPage("s3");
  const params = pagePlan({ manifestRef: page.manifestRef, criticRef: criticRefOf(page) });
  const { plan, lint } = await pageLint(params);
  assert.equal(lint.details.passed, true, `page lint should pass for a compact bar in the 8-col anchor: ${(lint.details.blockers ?? []).join(" | ")}`);
  const lintJson = JSON.parse(readFileSync(join(page.art, lint.details.lintRef), "utf8"));
  assert.equal(lintJson.asset_hashes[page.manifestRef].compact_sha256, page.manifest.hashes.compact_sha256, "lint recorded the compact hash");
  // untampered render works (control), then tamper
  flipByte(compactPath(page.art, page.manifest));
  await assert.rejects(() => run("newsroom_infographic_render", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef }), /changed after infographic lint|compact SVG does not match/);
  console.log("PASS 3 tamper after lint: infographic render refuses (changed after infographic lint / hash mismatch)");
}
try { // control: untampered page renders
  const page = await freshPage("s3c");
  const { plan, lint } = await pageLint(pagePlan({ manifestRef: page.manifestRef, criticRef: criticRefOf(page) }));
  assert.equal(lint.details.passed, true);
  const render = await run("newsroom_infographic_render", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
  assert.ok(render.details.manifestRef, `untampered page renders: ${render.content[0].text.slice(0, 600)}`);
  console.log("PASS 3b control: untampered compact page renders");
} catch (error) {
  failures.push(`3b control (untampered compact page must render): ${error.message.split("\n").slice(0, 3).join(" / ")}`);
  console.log("FAIL 3b control: untampered compact page does not render");
}

// ---- 4. 8-column page lint rule ----
{
  const ok = await freshPage("s4a", "horizontal_bar");
  const { lint } = await pageLint(pagePlan({ manifestRef: ok.manifestRef, criticRef: criticRefOf(ok) }));
  assert.equal(lint.details.passed, true, `horizontal_bar in 8-col anchor must pass: ${(lint.details.blockers ?? []).join(" | ")}`);
  assert.ok(!lint.details.blockers.some((b) => /no compact chart variant/.test(b)));

  const dot = await freshPage("s4b", "dot");
  assert.ok(!dot.manifest.variants.compact, "dot chart has no compact variant");
  const dotLint = (await pageLint(pagePlan({ manifestRef: dot.manifestRef, criticRef: criticRefOf(dot) }))).lint;
  assert.equal(dotLint.details.passed, false);
  assert.ok(dotLint.details.blockers.some((b) => /visual 'trend' gets only 8 of 12 columns/.test(b) && /no compact chart variant/.test(b)), `expected the 8-col blocker, got: ${dotLint.details.blockers.join(" | ")}`);

  const side = await freshPage("s4c", "horizontal_bar");
  assert.ok(side.manifest.variants.compact);
  const sideLint = (await pageLint(pagePlan({ manifestRef: side.manifestRef, criticRef: criticRefOf(side), trendScene: "sidecar4" }))).lint;
  assert.equal(sideLint.details.passed, false);
  assert.ok(sideLint.details.blockers.some((b) => /visual 'trend' gets only 4 of 12 columns/.test(b)), `expected the 4-col blocker, got: ${sideLint.details.blockers.join(" | ")}`);
  console.log("PASS 4 page lint: bar passes in 8-col anchor; dot blocked (no compact variant); compact bar in a 4-col sidecar stays blocked");
}

// ---- 5. manifest hashes removed / changed on disk ----
{
  for (const [label, mutate] of [
    ["hashes removed", (m) => { delete m.hashes; }],
    ["compact_sha256 removed", (m) => { delete m.hashes.compact_sha256; }],
    ["compact_sha256 changed", (m) => { m.hashes.compact_sha256 = "0".repeat(64); }],
  ]) {
    const page = await freshPage(`s5-${label.replace(/\W+/g, "_")}`);
    const manifestFile = join(page.art, page.manifestRef);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    mutate(manifest);
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const outcome = await criticOutcome(page.criticArgs);
    assert.ok(isRejected(outcome), `${label}: critic must reject (${outcome.text.slice(0, 200)})`);
    assert.match(outcome.text, /Compact visualization SVG|manifest|hash/i, label);
  }
  console.log("PASS 5 manifest with compact variant but hashes removed/changed: critic rejects");
}
// ---- 6. #222: with NEWSROOM_QA_TICK_READBACK=1 the compact picture is read back through the real page-level call (render + critic) ----
{
  const readBackOf = async (label) => {
    const { art, manifest, critic } = await freshPage(label);
    const qaRef = JSON.parse(readFileSync(join(art, criticRefOf({ critic })), "utf8")).render_qa_ref;
    return JSON.parse(readFileSync(join(art, qaRef), "utf8")).viewports;
  };
  const prev = process.env.NEWSROOM_QA_TICK_READBACK;
  try {
    delete process.env.NEWSROOM_QA_TICK_READBACK;
    const off = await readBackOf("s6off");
    assert.equal(off.compact.tick_readback, undefined, "switch off: the compact viewport has no tick_readback");
    assert.equal(off.desktop.tick_readback, undefined, "switch off: the desktop viewport has no tick_readback");
    process.env.NEWSROOM_QA_TICK_READBACK = "1";
    const on = await readBackOf("s6on");
    assert.equal(on.desktop.tick_readback?.passed, true, "switch on: desktop read back and passed");
    assert.equal(on.compact.tick_readback?.status, "covered", "switch on: the compact viewport is read back");
    assert.equal(on.compact.tick_readback?.passed, true, "switch on: the compact read-back passes on the real picture");
    assert.equal(on.compact.passed, true);
    console.log("PASS 6 real render + critic: switch on reads back the compact picture, off leaves the report as before");
  } catch (error) {
    failures.push(`6: ${String(error?.message ?? error).split("\n")[0]}`);
  } finally {
    if (prev === undefined) delete process.env.NEWSROOM_QA_TICK_READBACK; else process.env.NEWSROOM_QA_TICK_READBACK = prev;
  }
}
if (failures.length) {
  console.error(`compact variant runtime: ${failures.length} FAILURE(S)\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("compact variant runtime: ALL PASS");
