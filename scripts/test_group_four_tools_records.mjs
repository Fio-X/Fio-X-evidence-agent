#!/usr/bin/env node
// The four tools that #62 lists as having no recording behind them for the cross_calls.tool_pin row of computation_rows.mjs::recordedInputState:
// newsroom_infographic_edit, newsroom_award_mode_status, newsroom_competition_preflight and newsroom_publication_render. Each is run on a real fixture with the call
// report on (the default), and its own rows must show the call into recordedInputState. The call report is record only: nothing here turns a refusal on.
// Mutants (each in a throwaway copy of the runtime): a tool's route into the lint chain is cut, so its rows are missing and the test is red.
// The off path: with NEWSROOM_GROUP_CALL_REPORT=0 the four tools return the same text and details and the run folder is the same, apart from the report file.
// No provider, no network; the page rasterizer and browser check are the same stubs test_speed_switch_gates.mjs uses.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("four-tools-records-");
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

// ---- one run of the four tools over a throwaway copy of the runtime --------------------------------------------------------------------------------------
const FOUR = ["newsroom_infographic_edit", "newsroom_award_mode_status", "newsroom_competition_preflight", "newsroom_publication_render"];
const PIN = "computation_rows.mjs::recordedInputState";
const REPORT = "runtime/cross-call-report.jsonl";
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
let treeSeq = 0;
async function exercise({ mutate = {}, report = "1" } = {}) {
  const tree = join(scratch, `tree-${++treeSeq}`);
  mkdirSync(tree, { recursive: true });
  cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
  cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
  stub(tree, "typebox", TYPEBOX);
  stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  let source = readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8");
  for (const [from, to] of Object.entries(mutate)) { assert.ok(source.includes(from), `the mutation target moved: ${from.slice(0, 70)}`); source = source.replace(from, to); }
  const copy = join(tree, "runtime/pi/newsroom.test-copy.mjs");
  writeFileSync(copy, stripTypeScriptTypes(source, { mode: "strip" }));
  for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_GROUP_") || name.startsWith("NEWSROOM_SPEED_") || name === "NEWSROOM_MOBILE_PAGES") delete process.env[name];
  if (report === "0") process.env.NEWSROOM_GROUP_CALL_REPORT = "0";
  Object.assign(process.env, { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_SPEED_PLAN_EDIT: "1", NEWSROOM_PUBLICATION_EMBED_PAGE: "1", NEWSROOM_TEST_QA_MODE: "pass" });
  const art = freshRun("four");
  const tools = new Map();
  const mod = await import(`${pathToFileURL(copy).href}?v=${treeSeq}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  for (const name of [...FOUR, "newsroom_publication_plan"]) must(tools.has(name), `${name} is not registered here`);
  const page = await runPage(tools);
  const manifest = JSON.parse(readFileSync(join(art, page.manifestRef), "utf8"));
  const out = {};
  const run = async (name, params) => {
    const before = existsSync(join(art, REPORT)) ? readFileSync(join(art, REPORT), "utf8").split("\n").filter(Boolean).length : 0;
    const res = await attempt(tools.get(name), params);
    out[name] = { text: res.error ?? res.content?.[0]?.text, details: res.details ?? null, failed: Boolean(res.error), from: before };
    return res;
  };
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
  const rows = existsSync(join(art, REPORT)) ? readFileSync(join(art, REPORT), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const files = Object.fromEntries(walk(art).map((f) => relative(art, f)).filter((f) => f !== REPORT).sort().map((f) => [f, sha(readFileSync(join(art, f)))]));
  return { rows, out, files };
}
const reaches = (rows, tool) => rows.some((r) => r.tool === tool && r.function === PIN);

// ---- 1. each of the four, run for real, has its own rows into the pinned function ------------------------------------------------------------------------------
const base = await exercise();
for (const name of FOUR) {
  assert.ok(base.out[name].failed === false || base.out[name].text, `${name} ran`);
  assert.ok(reaches(base.rows, name), `${name} must have a ${PIN} row (rows: ${base.rows.filter((r) => r.tool === name).map((r) => r.function).join(", ") || "none"}; result: ${String(base.out[name].text).slice(0, 160)})`);
  check(`${name}: the run records its own call into ${PIN}`);
}

// ---- 2. mutants: cut each tool's route into the lint chain; its row disappears, the others stay ------------------------------------------------------------------
const mutants = {
  newsroom_infographic_edit: { "const before = new Set<string>((await lintInfographicPlan(sourcePlan)).lint.blockers.map(String));\n      const after = (await lintInfographicPlan(proposed)).lint.blockers.map(String);": "const before = new Set<string>([]);\n      const after: string[] = [];" },
  newsroom_award_mode_status: { 'await assertPageLintCurrent(await readManifestOrRejected("infographics", params.page_ref, "infographics/"));': 'await readManifestOrRejected("infographics", params.page_ref, "infographics/");' },
  newsroom_competition_preflight: { "      await assertPageLintCurrent(manifest);\n      const assets = await loadInfographicAssets(spec);\n      const result = evaluateCompetitionProfile": "      const assets = await loadInfographicAssets(spec);\n      const result = evaluateCompetitionProfile" },
  newsroom_publication_render: { "const { manifestRef } = await resolveEmbeddedPage(String(binding.ref), String(spec.infographic_plan_ref));": "const manifestRef = String(binding.manifest_ref);" },
};
for (const [name, mutate] of Object.entries(mutants)) {
  const run = await exercise({ mutate });
  assert.ok(!reaches(run.rows, name), `mutant must turn ${name} red: its row into ${PIN} is still there`);
  for (const other of FOUR.filter((n) => n !== name)) assert.ok(reaches(run.rows, other), `the mutant for ${name} must not touch ${other}`);
  check(`mutation: the route of ${name} cut -> its row is gone (red), the other three keep theirs`);
}

// ---- 3. the off path: with the report off the four tools say the same thing and leave the same run folder, apart from the report file itself ----------------------
const off = await exercise({ report: "0" });
assert.equal(off.rows.length, 0, "report off: no report file");
for (const name of FOUR) {
  assert.equal(off.out[name].text, base.out[name].text, `${name}: same text with the report off`);
  assert.deepEqual(off.out[name].details, base.out[name].details, `${name}: same details with the report off`);
}
assert.deepEqual(Object.keys(off.files), Object.keys(base.files), "same files in the run folder");
for (const [file, hash] of Object.entries(base.files)) assert.equal(off.files[file], hash, `same bytes: ${file}`);
check("off path: with the call report off the four tools return the same text and details and the run folder is byte-identical apart from the report file");

for (const name of results) console.log(`  ok  ${name}`);
console.log(`group four tools records: PASS (${results.length} checks)`);
