// NEWSROOM_SPEED_PLAN_EDIT=1: newsroom_infographic_edit changes only layout
// fields of a stored page plan (module span/emphasis/priority/order, scene
// pattern/anchor/sidecars) and records the result through the registered plan
// tool, so every plan validation runs again; an edit that adds a lint blocker
// is refused. Set BASELINE_NEWSROOM_TS to a pre-change newsroom.ts to also
// compare switch-off output with it.
import "./location_backing_pin.mjs";
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
const { applyPlanEdits, planEditProjection, validatePlanEditOps, VISION_PATCH_FIELDS } = await import(join(ROOT, "runtime/pi/vision.mjs"));
const { materializeEditorialGrammarSelection } = await import(join(ROOT, "runtime/pi/editorial_grammar.mjs"));

const results = [];
const check = (name) => { results.push(name); };

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
function loadTree(label, patchRegistry, newsroomSource) {
  const dir = makeTestTmp(`planedit-tree-${label}-`);
  cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  if (patchRegistry) writeFileSync(join(pi, "tool_registry.mjs"), patchRegistry(readFileSync(join(pi, "tool_registry.mjs"), "utf8")));
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(newsroomSource ?? readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
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
// Only the chain's own timestamped event log differs between a chain run and a manual run.
const NONDETERMINISTIC = new Set(["runtime/tool-chain-events.jsonl"]);
const snapshot = (art) => Object.fromEntries(walk(art).map((f) => relative(art, f)).filter((f) => !NONDETERMINISTIC.has(f) && !f.startsWith("config/")).sort().map((f) => [f, readFileSync(join(art, f)).toString("base64")]));

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

// The preview step shells out to python3 rasterize_svg.py (CairoSVG or Chrome). To keep this
// test independent of those, NEWSROOM_PYTHON_BIN points at a stub that writes a fixed PNG; only
// the rasterizer is replaced, every gate around it runs for real.
{
  const stubDir = makeTestTmp("planedit-raster-");
  writeFileSync(join(stubDir, "fixed.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]));
  const bin = join(stubDir, "python-stub.sh");
  writeFileSync(bin, `#!/bin/sh\ncp "${join(stubDir, "fixed.png")}" "$3"\necho '{"engine":"test-stub"}'\n`);
  chmodSync(bin, 0o755);
  process.env.NEWSROOM_PYTHON_BIN = bin;
}

const { mod } = await loadTree("main");
const EDIT = "NEWSROOM_SPEED_PLAN_EDIT";
const registerWith = (on) => register(mod, { ...BASE_ENV, NEWSROOM_SPEED_PREFLIGHT: undefined, [EDIT]: on ? "1" : undefined });
const slim = (tool) => JSON.stringify({ parameters: tool.parameters, description: tool.description, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines });
const message = (error) => String(error?.message ?? error);
const attempt = async (tool, params, signal) => { try { return await tool.execute("t", params, signal); } catch (error) { return { error: message(error) }; } };
const EDIT_TOOL = "newsroom_infographic_edit";

// ---- Part 1: ops validation and the immutable projection (no tools) ---------
const sampleSpec = {
  schema_version: "1.5.0", title: "T", mobile_module_order: ["a", "b", "c"],
  scene_graph: { schema_version: "0.2.0", scenes: [{ id: "s1", pattern: "hero_with_rail", anchor_module_id: "a", sidecar_module_ids: ["b"], hero_object_id: "x", supporting_claim_ids: ["c1"], scene_budget: { max_supporting_objects: 1, max_annotations: 1, max_claims: 2 } }] },
  modules: [
    { id: "a", type: "visual", span: "full", priority: 1, emphasis: "hero", manifest_ref: "m", claim_ids: ["c1"] },
    { id: "b", type: "text", span: "third", priority: 2, emphasis: "secondary", body: "text", claim_ids: ["c1"] },
    { id: "c", type: "text", span: "third", priority: 3, emphasis: "support", body: "more", claim_ids: ["c1"] },
  ],
};
{
  assert.deepEqual(VISION_PATCH_FIELDS, ["span", "emphasis", "priority", "move_before", "mobile_move_before"], "the vision revise tool's fields are untouched");
  const okOps = [
    { scope: "module", id: "b", field: "span", value: "half" },
    { scope: "module", id: "c", field: "priority", value: 2 },
    { scope: "module", id: "c", field: "move_before", value: "b" },
    { scope: "module", id: "c", field: "mobile_move_before", value: "a" },
    { scope: "scene", id: "s1", field: "pattern", value: "hero_sidecar_stack" },
    { scope: "scene", id: "s1", field: "sidecar_module_ids", value: ["b", "c"] },
  ];
  const done = applyPlanEdits(sampleSpec, okOps);
  assert.equal(done.spec.modules.find((m) => m.id === "b").span, "half");
  assert.deepEqual(done.spec.modules.map((m) => m.id), ["a", "c", "b"]);
  assert.deepEqual(done.spec.mobile_module_order, ["c", "a", "b"]);
  assert.equal(done.spec.scene_graph.scenes[0].pattern, "hero_sidecar_stack");
  assert.equal(done.safety.evidence_fields_preserved, true);
  assert.equal(sampleSpec.modules[1].span, "third", "the source plan object is not mutated");
  const bad = (ops) => validatePlanEditOps(ops, sampleSpec).join(" | ");
  const must = (label, ops, pattern) => assert.match(bad(ops), pattern, label);
  must("empty", [], /non-empty/);
  must("too many", Array.from({ length: 13 }, (_, i) => ({ scope: "module", id: "b", field: "priority", value: 1 + (i % 5) })), /cannot exceed 12/);
  must("module copy", [{ scope: "module", id: "b", field: "body", value: "new" }], /field 'body' is not editable/);
  must("module claim_ids", [{ scope: "module", id: "b", field: "claim_ids", value: ["c9"] }], /field 'claim_ids' is not editable/);
  must("module story_node_ids", [{ scope: "module", id: "b", field: "story_node_ids", value: ["n"] }], /not editable/);
  must("module manifest_ref", [{ scope: "module", id: "a", field: "manifest_ref", value: "x" }], /not editable/);
  must("module visual_channels", [{ scope: "module", id: "a", field: "visual_channels", value: ["x"] }], /not editable/);
  must("module type", [{ scope: "module", id: "a", field: "type", value: "text" }], /not editable/);
  must("scene scene_budget", [{ scope: "scene", id: "s1", field: "scene_budget", value: ["x"] }], /not editable/);
  must("scene supporting_claim_ids", [{ scope: "scene", id: "s1", field: "supporting_claim_ids", value: ["c9"] }], /not editable/);
  must("scene hero_object_id", [{ scope: "scene", id: "s1", field: "hero_object_id", value: "y" }], /not editable/);
  must("module add/remove", [{ scope: "module", id: "a", field: "modules", value: [] }], /not editable/);
  must("scene field on a module", [{ scope: "module", id: "a", field: "pattern", value: "hero_with_rail" }], /not editable on a module/);
  must("module field on a scene", [{ scope: "scene", id: "s1", field: "span", value: "full" }], /not editable on a scene/);
  must("unknown module", [{ scope: "module", id: "zz", field: "span", value: "full" }], /unknown module 'zz'/);
  must("unknown scene", [{ scope: "scene", id: "zz", field: "pattern", value: "hero_with_rail" }], /unknown scene 'zz'/);
  must("unknown scope", [{ scope: "page", id: "a", field: "span", value: "full" }], /scope must be/);
  must("extra key", [{ scope: "module", id: "b", field: "span", value: "half", note: "x" }], /unsupported key/);
  must("bad span", [{ scope: "module", id: "b", field: "span", value: "wide" }], /invalid span/);
  must("bad emphasis", [{ scope: "module", id: "b", field: "emphasis", value: "loud" }], /invalid emphasis/);
  must("bad priority", [{ scope: "module", id: "b", field: "priority", value: 9 }], /priority must be/);
  must("move before itself", [{ scope: "module", id: "b", field: "move_before", value: "b" }], /before itself/);
  must("move before unknown", [{ scope: "module", id: "b", field: "move_before", value: "q" }], /existing module/);
  must("anchor unknown module", [{ scope: "scene", id: "s1", field: "anchor_module_id", value: "q" }], /existing module/);
  must("sidecar unknown module", [{ scope: "scene", id: "s1", field: "sidecar_module_ids", value: ["q"] }], /1-3 distinct existing/);
  must("sidecar duplicates", [{ scope: "scene", id: "s1", field: "sidecar_module_ids", value: ["b", "b"] }], /1-3 distinct existing/);
  must("sidecar empty", [{ scope: "scene", id: "s1", field: "sidecar_module_ids", value: [] }], /1-3 distinct existing/);
  must("bad pattern", [{ scope: "scene", id: "s1", field: "pattern", value: "mosaic" }], /invalid scene pattern/);
  must("duplicate edit", [{ scope: "module", id: "b", field: "span", value: "half" }, { scope: "module", id: "b", field: "span", value: "full" }], /duplicates an edit/);
  assert.throws(() => applyPlanEdits(sampleSpec, [{ scope: "module", id: "b", field: "body", value: "x" }]), /plan edit rejected/);
  // the projection hash: layout fields are outside it, evidence fields are inside it
  const base = JSON.stringify(planEditProjection(sampleSpec));
  const moved = structuredClone(sampleSpec);
  moved.scene_graph.scenes[0].pattern = "hero_sidecar_stack"; moved.scene_graph.scenes[0].anchor_module_id = "c"; moved.scene_graph.scenes[0].sidecar_module_ids = ["a"];
  moved.modules[1].span = "half"; moved.modules[1].priority = 5; moved.mobile_module_order = ["c", "b", "a"];
  assert.equal(JSON.stringify(planEditProjection(moved)), base, "layout edits stay outside the projection");
  for (const mutate of [(s) => { s.modules[1].body = "x"; }, (s) => { s.modules[1].claim_ids = ["c2"]; }, (s) => { s.scene_graph.scenes[0].scene_budget.max_claims = 9; }, (s) => { s.scene_graph.scenes[0].supporting_claim_ids = []; }, (s) => { s.scene_graph.scenes[0].hero_object_id = "z"; }, (s) => { s.modules.pop(); }, (s) => { s.title = "U"; }]) {
    const changed = structuredClone(sampleSpec);
    mutate(changed);
    assert.notEqual(JSON.stringify(planEditProjection(changed)), base, "evidence changes are inside the projection");
  }
  check("unit: allowed ops apply; every non-layout field, unknown id/scope/key, bad value, duplicate and oversize list is rejected; the projection hash separates layout from evidence");
}
console.log(`unit: ${results.length} checks -- PASS`);

// ---- Part 2: registration -----------------------------------------------------
{
  const off = registerWith(false);
  const on = registerWith(true);
  assert.ok(!off.has(EDIT_TOOL), "absent with the switch off");
  assert.deepEqual([...on.keys()].filter((name) => !off.has(name)), [EDIT_TOOL], "the switch adds exactly one tool");
  for (const name of off.keys()) assert.equal(slim(on.get(name)), slim(off.get(name)), `unchanged: ${name}`);
  const exact = register(mod, { ...BASE_ENV, [EDIT]: "true" });
  assert.ok(!exact.has(EDIT_TOOL), "only exactly '1' turns it on");
  const scoped = register(mod, { ...BASE_ENV, [EDIT]: "1", NEWSROOM_TOOL_PROFILE: "investigate" });
  assert.ok(!scoped.has(EDIT_TOOL) || scoped.has("newsroom_infographic_plan"), "never offered without the plan tool");
  const tool = on.get(EDIT_TOOL);
  assert.deepEqual(tool.parameters.required.sort(), ["ops", "plan_ref"]);
  check("registration: the switch adds only newsroom_infographic_edit; every other tool is unchanged; off or non-'1' leaves it absent");

  if (process.env.BASELINE_NEWSROOM_TS) {
    const { mod: baseline } = await loadTree("baseline", undefined, readFileSync(process.env.BASELINE_NEWSROOM_TS, "utf8"));
    const base = register(baseline, { ...BASE_ENV, NEWSROOM_SPEED_PREFLIGHT: undefined, [EDIT]: undefined });
    assert.deepEqual([...off.keys()].sort(), [...base.keys()].sort());
    for (const name of base.keys()) assert.equal(slim(off.get(name)), slim(base.get(name)), `switch off == baseline: ${name}`);
    check("baseline: with the switch off every tool's schema, description and guidelines equal the pre-change newsroom.ts");
  }
}

const missingDependency = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT" ? "duckdb binary not found" : null;
const realWorks = !missingDependency;
if (missingDependency) console.log(`${missingDependency}; skipping the real-tool checks`);

let tools = registerWith(true);
const keyOrder = (plan) => { const keys = Object.keys(tools.get("newsroom_infographic_plan").parameters.properties); return Object.fromEntries([...keys.filter((k) => k in plan), ...Object.keys(plan).filter((k) => !keys.includes(k))].map((k) => [k, plan[k]])); };
const explicitPlan = () => keyOrder(pagePlan({ withQuestion: true }));
const readJson = (art, ref) => JSON.parse(readFileSync(join(art, ref), "utf8"));
const fileCount = (art) => walk(art).length;
async function planRun(plan) {
  const p = await tools.get("newsroom_infographic_plan").execute("p", plan);
  return p.details.planRef;
}

if (realWorks) {
  { // the grammar materializer and a whole stored plan survive being fed back in
    const art = freshRun("idem");
    const planRef = await planRun(explicitPlan());
    const stored = readJson(art, planRef);
    const registryJson = JSON.parse(readFileSync(join(ROOT, "config/editorial-grammar-registry.json"), "utf8"));
    assert.deepEqual(materializeEditorialGrammarSelection(stored.editorial_grammar, registryJson), stored.editorial_grammar, "materialize(materialize(x)) == materialize(x)");
    const { content_hash, ...core } = stored;
    const again = await planRun(core);
    assert.equal(again, planRef, "feeding the stored plan back reproduces the same plan hash");
    assert.equal(readFileSync(join(art, again), "utf8"), readFileSync(join(art, planRef), "utf8"));
    const noop = await tools.get(EDIT_TOOL).execute("e", { plan_ref: planRef, ops: [{ scope: "module", id: "resolution", field: "span", value: stored.modules.find((m) => m.id === "resolution").span }] });
    assert.equal(noop.details.planRef, planRef);
    assert.equal(noop.details.unchanged, true);
    check("idempotence: materializeEditorialGrammarSelection is idempotent on its own output; an unchanged stored plan re-enters the plan tool with the same hash; a no-op edit returns the source plan");
  }

  { // a layout edit equals the direct plan call with the same content, and the whole pipeline continues from it
    const art = freshRun("happy");
    const sourceRef = await planRun(explicitPlan());
    const ops = [
      { scope: "module", id: "resolution", field: "emphasis", value: "primary" },
      { scope: "module", id: "resolution", field: "priority", value: 2 },
      { scope: "module", id: "resolution", field: "move_before", value: "trend" },
      { scope: "module", id: "trend", field: "mobile_move_before", value: "map" },
    ];
    const edited = await tools.get(EDIT_TOOL).execute("e", { plan_ref: sourceRef, ops });
    assert.notEqual(edited.details.planRef, sourceRef);
    assert.ok(readJson(art, edited.details.revisionRef).applied_edits.length === 4);
    assert.equal(readJson(art, edited.details.revisionRef).kind, "plan_edit");
    // the same content, sent as a whole plan to a fresh run
    const art2 = freshRun("happy-direct");
    const direct = pagePlan({ withQuestion: true });
    const resolution = direct.modules.find((m) => m.id === "resolution");
    resolution.emphasis = "primary"; resolution.priority = 2;
    direct.modules = [direct.modules[0], direct.modules[1], resolution, direct.modules[2]];
    direct.mobile_module_order = ["trend", "map", "flow", "resolution"];
    const directRef = await planRun(keyOrder(direct));
    assert.equal(edited.details.planRef, directRef, "same content -> same plan hash");
    assert.equal(readFileSync(join(art, edited.details.planRef), "utf8"), readFileSync(join(art2, directRef), "utf8"), "plan artifact is byte-identical to the direct call");
    // and the page pipeline accepts it
    const lint = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: edited.details.planRef });
    assert.equal(lint.details.passed, true);
    const render = await tools.get("newsroom_infographic_render").execute("r", { plan_ref: edited.details.planRef, lint_ref: lint.details.lintRef });
    assert.equal(render.details.renderQaPassed, true);
    check("real: a layout edit writes the same plan bytes as sending that plan whole, with a plan_edit audit record, and lint and render pass on it");
  }

  { // must-fail on the real tools: nothing is written when an edit is refused
    const art = freshRun("mustfail");
    const sourceRef = await planRun(explicitPlan());
    const edit = tools.get(EDIT_TOOL);
    const refused = async (label, ops, pattern, planRef = sourceRef, signal) => {
      const before = fileCount(art);
      const out = await attempt(edit, { plan_ref: planRef, ops }, signal);
      assert.ok(out.error, `${label}: must be refused`);
      assert.match(out.error, pattern, label);
      assert.equal(fileCount(art), before, `${label}: nothing written`);
    };
    // narrow-slot rule (infographic.mjs lint): with mobile pages off a visual must use span 'full' and get 12 columns in its scene
    await refused("visual span narrowed", [{ scope: "module", id: "flow", field: "span", value: "half" }], /Plan edit refused: it would add \d+ lint blocker.*visual 'flow' must use span 'full'/);
    await refused("scene pattern swap puts a visual in a narrow slot", [{ scope: "scene", id: "orient", field: "pattern", value: "hero_sidecar_stack" }], /Plan edit refused.*gets only \d+ of 12 columns in scene 'orient'/);
    await refused("a module in two scenes (plan validation)", [{ scope: "scene", id: "orient", field: "sidecar_module_ids", value: ["flow", "resolution"] }], /cannot belong to more than one scene/);
    // plan validators still judge the edited plan
    await refused("anchor and sidecar overlap", [{ scope: "scene", id: "orient", field: "anchor_module_id", value: "flow" }], /./);
    // unreadable / foreign plan references
    await refused("unknown plan", [{ scope: "module", id: "flow", field: "priority", value: 1 }], /./, "infographics/plans/nope.json");
    await refused("plan outside plans/", [{ scope: "module", id: "flow", field: "priority", value: 1 }], /./, "claims.jsonl");
    // cancellation is honoured before the plan is written
    const controller = new AbortController();
    controller.abort();
    await refused("cancelled", [{ scope: "module", id: "resolution", field: "priority", value: 2 }], /cancelled/, sourceRef, controller.signal);

    // cancellation that lands after the edit began: a signal that reports "aborted" from its Nth check on
    const abortOnCheck = (n) => { let reads = 0; return { get aborted() { reads += 1; return reads >= n; }, addEventListener() {}, removeEventListener() {} }; };
    const planCount = () => readdirSync(join(art, "infographics/plans")).length;
    const revisionCount = () => (existsSync(join(art, "infographics/plan-edits")) ? readdirSync(join(art, "infographics/plan-edits")).length : 0);
    const cancelOps = [{ scope: "module", id: "resolution", field: "priority", value: 3 }];
    const plansBefore = planCount();
    const revisionsBefore = revisionCount();
    // 2nd check is inside the plan tool, just before it writes the plan
    const midPlan = await attempt(edit, { plan_ref: sourceRef, ops: cancelOps }, abortOnCheck(2));
    assert.match(midPlan.error, /cancelled before the plan was written/);
    assert.equal(planCount(), plansBefore, "cancelled before the plan write: no new plan");
    assert.equal(revisionCount(), revisionsBefore, "and no revision record");
    // 3rd check is after the plan tool returned, just before the revision record
    const beforeRevision = await attempt(edit, { plan_ref: sourceRef, ops: cancelOps }, abortOnCheck(3));
    assert.match(beforeRevision.error, /cancelled before the revision record was written/);
    assert.equal(revisionCount(), revisionsBefore, "cancelled before the revision write: no revision record");
    // a call that is never cancelled still completes on the same input
    const done = await edit.execute("e", { plan_ref: sourceRef, ops: cancelOps }, abortOnCheck(1000));
    assert.ok(existsSync(join(art, done.details.revisionRef)));
    // the fields model output must never reach, rejected before anything reads the plan
    for (const [scope, id, field, value] of [["module", "resolution", "body", "x"], ["module", "resolution", "claim_ids", ["c-map"]], ["module", "resolution", "story_node_ids", ["n-map"]], ["module", "map", "manifest_ref", "visualizations/sankey.json"], ["module", "map", "visual_channels", ["x"]], ["scene", "orient", "scene_budget", ["x"]], ["scene", "orient", "supporting_claim_ids", ["c-trend"]], ["module", "map", "type", "text"], ["module", "ghost", "span", "full"], ["module", "map", "claim_id", "c-unverified"]]) {
      await refused(`${scope}.${field}`, [{ scope, id, field, value }], /plan edit rejected/);
    }
    // claims.jsonl never changes through an edit
    const claims = readFileSync(join(art, "claims.jsonl"), "utf8");
    await tools.get(EDIT_TOOL).execute("e", { plan_ref: sourceRef, ops: [{ scope: "module", id: "resolution", field: "priority", value: 2 }] });
    assert.equal(readFileSync(join(art, "claims.jsonl"), "utf8"), claims);
    check("real must-fail: narrowing a visual, swapping a scene pattern or sidecars into a narrow slot, an invalid scene, a foreign plan, cancellation, and every evidence/copy/budget field are refused with nothing written");
  }

  { // the use the tool is for: a plan that lint would block is fixed by a layout edit
    const art = freshRun("fixes");
    const narrow = pagePlan({ withQuestion: true });
    narrow.modules.find((m) => m.id === "flow").span = "half";
    const narrowRef = await planRun(keyOrder(narrow));
    const blocked = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: narrowRef });
    assert.equal(blocked.details.passed, false);
    const fixed = await tools.get(EDIT_TOOL).execute("e", { plan_ref: narrowRef, ops: [{ scope: "module", id: "flow", field: "span", value: "full" }] });
    assert.deepEqual(fixed.details.remainingLintBlockers, []);
    const lint = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: fixed.details.planRef });
    assert.equal(lint.details.passed, true);
    // an edit that leaves a pre-existing blocker alone is not refused for it
    const partial = await tools.get(EDIT_TOOL).execute("e", { plan_ref: narrowRef, ops: [{ scope: "module", id: "resolution", field: "priority", value: 2 }] });
    assert.equal(partial.details.remainingLintBlockers.length, 1);
    assert.ok(existsSync(join(art, partial.details.planRef)));
    check("real: an edit that fixes a lint blocker succeeds; an unrelated edit of a plan that already has one is not refused for it, and the blocker is reported");
  }

  { // a successful scene edit equals the direct plan call with the same content
    const art = freshRun("scene");
    const sourceRef = await planRun(explicitPlan());
    const edited = await tools.get(EDIT_TOOL).execute("e", { plan_ref: sourceRef, ops: [{ scope: "scene", id: "orient", field: "anchor_module_id", value: "flow" }, { scope: "scene", id: "orient", field: "sidecar_module_ids", value: ["map"] }] });
    assert.notEqual(edited.details.planRef, sourceRef);
    assert.equal(JSON.parse(readFileSync(join(art, edited.details.planRef), "utf8")).scene_graph.scenes[0].anchor_module_id, "flow");
    assert.equal(readJson(art, edited.details.revisionRef).applied_edits[0].scope, "scene");
    const art2 = freshRun("scene-direct");
    const direct = pagePlan({ withQuestion: true });
    direct.scene_graph.scenes[0].anchor_module_id = "flow"; direct.scene_graph.scenes[0].sidecar_module_ids = ["map"];
    const directRef = await planRun(keyOrder(direct));
    assert.equal(edited.details.planRef, directRef, "same content -> same plan hash");
    assert.equal(readFileSync(join(art, edited.details.planRef), "utf8"), readFileSync(join(art2, directRef), "utf8"), "plan artifact is byte-identical to the direct call");
    const lint = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: edited.details.planRef });
    assert.equal(lint.details.passed, true);
    check("real: a scene anchor/sidecar edit writes the same plan bytes as sending that plan whole, and lint passes on it");
  }
  { // residual blockers survive an edit, and render refuses the edited plan
    const art = freshRun("residual");
    const narrow = pagePlan({ withQuestion: true });
    narrow.modules.find((m) => m.id === "flow").span = "half";
    const narrowRef = await planRun(keyOrder(narrow));
    const partial = await tools.get(EDIT_TOOL).execute("e", { plan_ref: narrowRef, ops: [{ scope: "module", id: "resolution", field: "priority", value: 2 }] });
    assert.equal(partial.details.remainingLintBlockers.length, 1);
    const lint = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: partial.details.planRef });
    assert.equal(lint.details.passed, false);
    const render = await attempt(tools.get("newsroom_infographic_render"), { plan_ref: partial.details.planRef, lint_ref: lint.details.lintRef });
    assert.ok(render.error, "render must refuse an edited plan whose lint did not pass");
    assert.equal(existsSync(join(art, "infographics/manifests")) ? readdirSync(join(art, "infographics/manifests")).length : 0, 0, "no page manifest written");
    check("real must-fail: an edited plan that still has a lint blocker is refused by render (lint -> render gate is not bypassed)");
  }

  if (process.env.BASELINE_NEWSROOM_TS) { // switch off: the whole page run equals the pre-change code, byte for byte
    const { mod: baseline } = await loadTree("baseline-run", undefined, readFileSync(process.env.BASELINE_NEWSROOM_TS, "utf8"));
    const run = async (toolset) => {
      const p = await toolset.get("newsroom_infographic_plan").execute("p", explicitPlan());
      const lint = await toolset.get("newsroom_infographic_lint").execute("l", { plan_ref: p.details.planRef });
      const render = await toolset.get("newsroom_infographic_render").execute("r", { plan_ref: p.details.planRef, lint_ref: lint.details.lintRef });
      await toolset.get("newsroom_infographic_critic").execute("c", { plan_ref: p.details.planRef, lint_ref: lint.details.lintRef, manifest_ref: render.details.manifestRef });
    };
    const offArt = freshRun("sw-off");
    await run(registerWith(false));
    const onArt = freshRun("sw-on");
    await run(registerWith(true));
    const baseArt = freshRun("sw-base");
    await run(register(baseline, { ...BASE_ENV, NEWSROOM_SPEED_PREFLIGHT: undefined, [EDIT]: undefined }));
    assert.deepEqual(snapshot(offArt), snapshot(baseArt), "switch off == pre-change code");
    assert.deepEqual(snapshot(onArt), snapshot(baseArt), "switch on, edit tool unused == pre-change code");
    tools = registerWith(true);
    check("baseline: plan, lint, render and critic artifacts are byte-identical to the pre-change newsroom.ts with the switch off, and also with it on when the edit tool is not called");
  }
}

for (const name of results) assert.ok(name);
console.log(results.map((name) => `  ok  ${name}`).join("\n"));
console.log(`plan edit: ${results.length} checks -- PASS${realWorks ? "" : " (duckdb unavailable: real checks skipped)"}`);
