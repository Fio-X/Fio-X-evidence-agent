// NEWSROOM_SPEED_PREFLIGHT=1: derivable page-stage references are filled only
// when exactly one existing artifact is bound to what the call already names, and
// every unmet precondition is listed at once. Part 1 drives preflight.mjs with a
// fake artifact reader; part 2 runs the real page tools on a hand-written fixture.
// Set BASELINE_NEWSROOM_TS to a pre-change newsroom.ts to also compare switch-off
// output with it.
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { fillPlanRefs, fillStageRefs, inSchemaOrder, planPrerequisiteIssues, preflightError, renderPrerequisiteIssues } = await import(join(ROOT, "runtime/pi/preflight.mjs"));
const { assessStoryGraph } = await import(join(ROOT, "runtime/pi/story_graph.mjs"));

const results = [];
const check = (name) => { results.push(name); };

// ---- Part 1: preflight.mjs with a fake artifact reader --------------------------
function fakeIo(files, { verified = ["c1"] } = {}) {
  return {
    list: async (dir) => Object.keys(files).filter((ref) => ref.startsWith(dir) && !ref.slice(dir.length).includes("/")).sort(),
    read: async (ref) => { if (!(ref in files)) throw new Error(`ENOENT ${ref}`); return files[ref]; },
    manifest: async (_dir, ref) => { if (!(ref in files)) throw new Error(`ENOENT ${ref}`); return files[ref]; },
    verified: async () => new Set(verified),
  };
}
const FILES = {
  "editorial/story-graphs/g.json": { passed: true, reader_question: "Q?", visual_thesis: "T.", nodes: [{ id: "n1" }] },
  "editorial/discovery/d.json": { decision: "CONTINUE" },
  "editorial/concepts/k.json": { finalists: ["a"], discovery_ref: "editorial/discovery/d.json" },
  "editorial/novelty/n.json": { concept_ref: "editorial/concepts/k.json", passed: true },
  "editorial/assets/s.json": { concept_ref: "editorial/concepts/k.json", concept_id: "a", decision: "CONTINUE" },
  "visualizations/m.json": { claim_id: "c1", publishable: true },
  "visualizations/critics/c.json": { passed: true, manifest_ref: "visualizations/m.json" },
};
const BASE = { story_graph_ref: "editorial/story-graphs/g.json", selected_concept_id: "a", modules: [{ id: "v", type: "visual", manifest_ref: "visualizations/m.json", claim_ids: ["c1"], story_node_ids: ["n1"] }] };
{ // exactly one candidate everywhere: every derivable field is filled; the rest is untouched
  const state = await fillPlanRefs(BASE, fakeIo(FILES));
  assert.deepEqual(state.params, { ...BASE, reader_question: "Q?", visual_thesis: "T.", visual_concept_ref: "editorial/concepts/k.json", editorial_discovery_ref: "editorial/discovery/d.json", novelty_ref: "editorial/novelty/n.json", asset_plan_ref: "editorial/assets/s.json", modules: [{ id: "v", type: "visual", manifest_ref: "visualizations/m.json", critic_ref: "visualizations/critics/c.json", claim_ids: ["c1"], story_node_ids: ["n1"] }] });
  assert.deepEqual(state.unresolved, {});
  assert.deepEqual(Object.keys(state.params.modules[0]), ["id", "type", "manifest_ref", "critic_ref", "claim_ids", "story_node_ids"], "critic_ref lands right after manifest_ref");
  assert.deepEqual(await planPrerequisiteIssues(state.params, fakeIo(FILES), state.unresolved), []);
  check("unit: a single bound artifact fills every derivable reference; claim_ids and story nodes are copied through untouched");
}
{ // values the model gave are never read, replaced or "corrected"
  const given = { ...BASE, reader_question: "Other?", visual_thesis: "Other.", visual_concept_ref: "editorial/concepts/WRONG.json", novelty_ref: "editorial/novelty/WRONG.json", asset_plan_ref: "editorial/assets/WRONG.json", editorial_discovery_ref: "editorial/discovery/WRONG.json", modules: [{ ...BASE.modules[0], critic_ref: "visualizations/critics/WRONG.json" }] };
  const state = await fillPlanRefs(given, fakeIo(FILES));
  assert.deepEqual(state.params, given);
  assert.deepEqual(state.filled, []);
  const issues = await planPrerequisiteIssues(state.params, fakeIo(FILES), {});
  assert.ok(issues.some((i) => /reader_question must exactly match/.test(i)) && issues.some((i) => /visual_thesis must exactly match/.test(i)));
  assert.ok(issues.some((i) => /WRONG/.test(i)), issues.join("\n"));
  assert.ok(issues.length >= 6, "every wrong reference is reported, not just the first");
  check("unit: explicit values are kept as given and every wrong one is reported together");
}
{ // ambiguity and absence: nothing is filled, the reason names the candidates or the missing step
  const twice = { ...FILES, "editorial/novelty/n2.json": { concept_ref: "editorial/concepts/k.json", passed: true }, "visualizations/critics/c2.json": { passed: true, manifest_ref: "visualizations/m.json" } };
  const two = await fillPlanRefs(BASE, fakeIo(twice));
  assert.equal(two.params.novelty_ref, undefined);
  assert.match(two.unresolved.novelty_ref, /2 candidates \(editorial\/novelty\/n\.json, editorial\/novelty\/n2\.json\)/);
  assert.equal(two.params.modules[0].critic_ref, undefined);
  assert.match(two.unresolved["modules[v].critic_ref"], /2 passing critics/);
  const { "editorial/novelty/n.json": _n, "visualizations/critics/c.json": _c, ...fewer } = FILES;
  const none = await fillPlanRefs(BASE, fakeIo(fewer));
  assert.match(none.unresolved.novelty_ref, /call newsroom_semantic_novelty first/);
  assert.match(none.unresolved["modules[v].critic_ref"], /no passing critic/);
  const failed = await fillPlanRefs(BASE, fakeIo({ ...FILES, "visualizations/critics/c.json": { passed: false, manifest_ref: "visualizations/m.json" } }));
  assert.equal(failed.params.modules[0].critic_ref, undefined, "a critic that did not pass is never a candidate");
  const noSelected = await fillPlanRefs({ ...BASE, selected_concept_id: undefined }, fakeIo(FILES));
  assert.equal(noSelected.params.visual_concept_ref, undefined);
  assert.match(noSelected.unresolved.visual_concept_ref, /selected_concept_id is needed/);
  const stale = await fillPlanRefs(BASE, fakeIo({ ...FILES, "editorial/discovery/d.json": { decision: "RESEARCH_MORE" } }));
  assert.equal(stale.params.visual_concept_ref, undefined, "a concept set whose discovery did not say CONTINUE is not a candidate");
  check("unit: zero or several candidates are never filled; failed critics and non-CONTINUE discovery are not candidates; selected_concept_id is never invented");
}
{ // one aggregated error lists every unmet precondition
  const broken = { ...FILES, "editorial/story-graphs/g.json": { ...FILES["editorial/story-graphs/g.json"], passed: false }, "visualizations/m.json": { claim_id: "c2", publishable: false } };
  delete broken["editorial/novelty/n.json"];
  const params = { ...BASE, reader_question: "Q?", visual_thesis: "T.", modules: [{ ...BASE.modules[0], critic_ref: "visualizations/critics/c.json", claim_ids: ["c1", "cX"], story_node_ids: ["n1", "nope"] }] };
  const state = await fillPlanRefs(params, fakeIo(broken));
  const issues = await planPrerequisiteIssues(state.params, fakeIo(broken), state.unresolved);
  const text = preflightError("newsroom_infographic_plan", issues).message;
  for (const expected of [/StoryGraph has blocking/, /unknown story node 'nope'/, /unverified claim 'cX'/, /novelty_ref is missing and could not be derived/, /DRAFT ?\/ ?non-publishable/, /manifest references unverified claim 'c2'/]) assert.match(text, expected);
  assert.match(text, /^Preflight found \d+ unmet preconditions for newsroom_infographic_plan/);
  check("unit: six independent problems come back in one error, each with what to call next");
}
{ // an explicitly named lint that is no longer current is listed (C1)
  const files = { "infographics/plans/p.json": { modules: [] }, "infographics/lints/l.json": { plan_ref: "infographics/plans/p.json", passed: true, blockers: [] } };
  const params = { plan_ref: "infographics/plans/p.json", lint_ref: "infographics/lints/l.json" };
  const stale = { ...fakeIo(files), lintCurrent: async () => false };
  assert.match((await renderPrerequisiteIssues(params, stale, {})).join("|"), /LINT_STALE/);
  const fresh = { ...fakeIo(files), lintCurrent: async () => true };
  assert.deepEqual(await renderPrerequisiteIssues(params, fresh, {}), []);
  check("unit: an explicit stale lint_ref is listed as LINT_STALE; a current one is not");
}
{ // stage fills: render, critic and preview
  const stage = { ...FILES, "infographics/lints/l.json": { plan_ref: "infographics/plans/p.json", passed: true, blockers: [] }, "infographics/m1.json": { plan_ref: "infographics/plans/p.json", lint_ref: "infographics/lints/l.json", variants: { desktop: "x" } }, "infographics/critics/k.json": { manifest_ref: "infographics/m1.json", passed: true }, "infographics/plans/p.json": { modules: [] } };
  const io = fakeIo(stage);
  assert.equal((await fillStageRefs("newsroom_infographic_render", { plan_ref: "infographics/plans/p.json" }, io)).params.lint_ref, "infographics/lints/l.json");
  const critic = await fillStageRefs("newsroom_infographic_critic", { plan_ref: "infographics/plans/p.json" }, io);
  assert.equal(critic.params.lint_ref, "infographics/lints/l.json");
  assert.equal(critic.params.manifest_ref, "infographics/m1.json");
  assert.equal((await fillStageRefs("newsroom_infographic_preview", { manifest_ref: "infographics/m1.json" }, io)).params.critic_ref, "infographics/critics/k.json");
  const blocked = await fillStageRefs("newsroom_infographic_render", { plan_ref: "infographics/plans/p.json" }, fakeIo({ ...stage, "infographics/lints/l.json": { plan_ref: "infographics/plans/p.json", passed: false, blockers: ["x"] } }));
  assert.equal(blocked.params.lint_ref, undefined);
  assert.match(blocked.unresolved.lint_ref, /call newsroom_infographic_lint first/);
  const other = await fillStageRefs("newsroom_infographic_render", { plan_ref: "infographics/plans/p.json" }, fakeIo({ ...stage, "infographics/lints/l.json": { plan_ref: "infographics/plans/OTHER.json", passed: true, blockers: [] } }));
  assert.equal(other.params.lint_ref, undefined, "a lint of another plan is never a candidate");
  const given = await fillStageRefs("newsroom_infographic_render", { plan_ref: "infographics/plans/p.json", lint_ref: "infographics/lints/WRONG.json" }, io);
  assert.equal(given.params.lint_ref, "infographics/lints/WRONG.json");
  assert.match((await renderPrerequisiteIssues(given.params, io, given.unresolved)).join("|"), /WRONG.json' cannot be read/);
  assert.deepEqual(inSchemaOrder({ b: 1, z: 3, a: 2 }, ["a", "b", "c"]), { a: 2, b: 1, z: 3 });
  check("unit: render, critic and preview references derive only from a passing artifact bound to the previous reference");
}
{ // an explicitly passed empty value is a value: never replaced, left for the validators
  for (const empty of ["", null]) {
    const state = await fillPlanRefs({ ...BASE, reader_question: empty, visual_thesis: empty, visual_concept_ref: empty, editorial_discovery_ref: empty, novelty_ref: empty, asset_plan_ref: empty }, fakeIo(FILES));
    for (const field of ["reader_question", "visual_thesis", "visual_concept_ref", "editorial_discovery_ref", "novelty_ref", "asset_plan_ref"]) assert.equal(state.params[field], empty, `${field}: ${JSON.stringify(empty)} is kept`);
    assert.deepEqual(state.filled.filter((f) => !f.startsWith("modules[")), [], "no top-level field is filled");
  }
  const stage = await fillStageRefs("newsroom_infographic_render", { plan_ref: "infographics/plans/p.json", lint_ref: "" }, fakeIo({ "infographics/lints/l.json": { plan_ref: "infographics/plans/p.json", passed: true, blockers: [] } }));
  assert.equal(stage.params.lint_ref, "", "an empty lint_ref is not derived");
  const blank = await fillPlanRefs({ ...BASE, modules: [{ ...BASE.modules[0], critic_ref: "" }] }, fakeIo(FILES));
  assert.equal(blank.params.modules[0].critic_ref, "", "an empty critic_ref is not derived");
  check("unit: an explicit empty string or null is never filled (only an omitted field is)");
}
{ // a critic bound to a rejected / unreadable manifest is not a candidate
  const files = { ...FILES };
  const io = { ...fakeIo(files), manifest: async (_dir, ref) => { if (ref === "visualizations/m.json") throw new Error("REJECTED: moved to visualizations/rejected/m/"); return files[ref]; } };
  const state = await fillPlanRefs({ ...BASE, modules: [{ ...BASE.modules[0] }] }, io);
  assert.equal(state.params.modules[0].critic_ref, undefined);
  assert.match(state.unresolved["modules[v].critic_ref"], /REJECTED/);
  check("unit: a passing critic whose manifest is rejected is not a fill candidate");
}
console.log(`unit (fake reader): ${results.length} checks -- PASS`);

// ---- Part 2: real tools ------------------------------------------------------
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
  const dir = makeTestTmp(`preflight-tree-${label}-`);
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
  const art = join(makeTestTmp(`preflight-${label}-`), "run");
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
  const stubDir = makeTestTmp("preflight-raster-");
  writeFileSync(join(stubDir, "fixed.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]));
  const bin = join(stubDir, "python-stub.sh");
  writeFileSync(bin, `#!/bin/sh\ncp "${join(stubDir, "fixed.png")}" "$3"\necho '{"engine":"test-stub"}'\n`);
  chmodSync(bin, 0o755);
  process.env.NEWSROOM_PYTHON_BIN = bin;
}
// Part 2 runs the real page tools. The rasterizer stub keeps it independent of CairoSVG/Chrome.
const SIX = ["reader_question", "visual_thesis", "editorial_discovery_ref", "visual_concept_ref", "novelty_ref", "asset_plan_ref"];
const { mod } = await loadTree("main");
const PREFLIGHT = "NEWSROOM_SPEED_PREFLIGHT";
let baselineTools = null;
const registerWith = (on) => register(mod, { ...BASE_ENV, [PREFLIGHT]: on ? "1" : undefined });
const slim = (tool) => JSON.stringify({ parameters: tool.parameters, description: tool.description, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines });
const message = (error) => String(error?.message ?? error);
const attempt = async (tool, params) => { try { return await tool.execute("t", params); } catch (error) { return { error: message(error) }; } };
const STAGE_TOOLS = ["newsroom_infographic_plan", "newsroom_infographic_render", "newsroom_infographic_critic", "newsroom_infographic_preview"];

{ // registration: only the four page-stage tools differ, only by optional derived references and one guideline
  const off = registerWith(false);
  const on = registerWith(true);
  assert.deepEqual([...on.keys()].sort(), [...off.keys()].sort(), "no tool is added or removed");
  const changed = [...off.keys()].filter((name) => slim(on.get(name)) !== slim(off.get(name))).sort();
  assert.deepEqual(changed, [...STAGE_TOOLS].sort());
  const plan = { off: off.get("newsroom_infographic_plan").parameters, on: on.get("newsroom_infographic_plan").parameters };
  assert.deepEqual(plan.off.required.filter((k) => !plan.on.required.includes(k)).sort(), [...SIX].sort(), "exactly the six derivable fields stop being required");
  for (const key of ["selected_concept_id", "story_graph_ref", "modules", "scene_graph", "editorial_grammar"]) assert.ok(plan.on.required.includes(key), `${key} stays required`);
  const stripOptional = (schema) => JSON.stringify(schema, (k, v) => (k === "__optional" ? undefined : v));
  assert.deepEqual(Object.keys(plan.on.properties), Object.keys(plan.off.properties), "same property order");
  for (const [tool, fields] of [["newsroom_infographic_render", ["lint_ref"]], ["newsroom_infographic_critic", ["lint_ref", "manifest_ref"]], ["newsroom_infographic_preview", ["critic_ref"]]]) {
    const o = off.get(tool).parameters, n = on.get(tool).parameters;
    assert.deepEqual(o.required.filter((k) => !n.required.includes(k)).sort(), [...fields].sort(), tool);
    assert.equal(stripOptional(o.properties), stripOptional(n.properties), `${tool}: types unchanged`);
  }
  for (const tool of STAGE_TOOLS) assert.equal(on.get(tool).description, off.get(tool).description);
  assert.ok(STAGE_TOOLS.every((tool) => (on.get(tool).promptGuidelines ?? []).length === (off.get(tool).promptGuidelines ?? []).length + 1));
  check("registration: switch on changes only the four page-stage tools (derivable references optional, one added guideline); nothing else");
  const exact = register(mod, { ...BASE_ENV, [PREFLIGHT]: "true" });
  assert.equal(slim(exact.get("newsroom_infographic_plan")), slim(off.get("newsroom_infographic_plan")), "only exactly '1' turns it on");
  if (process.env.BASELINE_NEWSROOM_TS) {
    const { mod: baseline } = await loadTree("baseline", undefined, readFileSync(process.env.BASELINE_NEWSROOM_TS, "utf8"));
    const base = register(baseline, { ...BASE_ENV, [PREFLIGHT]: undefined });
    baselineTools = base;
    assert.deepEqual([...off.keys()].sort(), [...base.keys()].sort());
    for (const name of base.keys()) assert.equal(slim(off.get(name)), slim(base.get(name)), `switch off == baseline: ${name}`);
    check("baseline: with the switch off every tool's schema, description and guidelines equal the pre-change newsroom.ts");
  }
}

const missingDependency = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT" ? "duckdb binary not found" : null;
const realWorks = !missingDependency;
if (missingDependency) console.log(`${missingDependency}; skipping the real-tool checks`);

const planTool = () => registeredPlan.get("newsroom_infographic_plan");
let registeredPlan = registerWith(true);
const schemaOrdered = (plan) => inSchemaOrder(plan, Object.keys(registeredPlan.get("newsroom_infographic_plan").parameters.properties));
const explicitPlan = () => schemaOrdered(pagePlan({ withQuestion: true }));
function omittedPlan() {
  const plan = pagePlan();
  for (const key of SIX) delete plan[key];
  plan.modules = plan.modules.map(({ critic_ref, ...rest }) => rest);
  return plan;
}
async function pipeline(tools, plan, { omit = false } = {}) {
  const p = await tools.get("newsroom_infographic_plan").execute("p", plan);
  const lint = await tools.get("newsroom_infographic_lint").execute("l", { plan_ref: p.details.planRef });
  if (lint.details.passed !== true) throw new Error(`fixture lint blocked: ${lint.details.blockers.join(" | ")}`);
  const render = await tools.get("newsroom_infographic_render").execute("r", omit ? { plan_ref: p.details.planRef } : { plan_ref: p.details.planRef, lint_ref: lint.details.lintRef });
  const critic = await tools.get("newsroom_infographic_critic").execute("c", omit ? { plan_ref: p.details.planRef } : { plan_ref: p.details.planRef, lint_ref: lint.details.lintRef, manifest_ref: render.details.manifestRef });
  const preview = await tools.get("newsroom_infographic_preview").execute("v", omit ? { manifest_ref: render.details.manifestRef } : { manifest_ref: render.details.manifestRef, critic_ref: critic.details.criticRef });
  return { p, lint, render, critic, preview };
}

if (realWorks) {
  { // omitting every derivable reference yields exactly the artifacts the fully explicit calls produce
    registeredPlan = registerWith(false);
    const offArt = freshRun("eq-off");
    const offRun = await pipeline(registeredPlan, explicitPlan());
    if (baselineTools) {
      const baseArt = freshRun("eq-base");
      await pipeline(baselineTools, explicitPlan());
      assert.deepEqual(snapshot(offArt), snapshot(baseArt), "switch off == pre-change code, byte for byte");
      check("baseline: a full explicit page run with the switch off writes the same bytes as the pre-change newsroom.ts");
    }
    registeredPlan = registerWith(true);
    const onArt = freshRun("eq-on");
    const onRun = await pipeline(registeredPlan, explicitPlan());
    assert.deepEqual(snapshot(onArt), snapshot(offArt), "explicit calls: switch on == off, byte for byte");
    const filledArt = freshRun("eq-filled");
    const claimsBefore = readFileSync(join(filledArt, "claims.jsonl"), "utf8");
    const filledRun = await pipeline(registeredPlan, omittedPlan(), { omit: true });
    for (const key of ["p", "lint", "render", "critic", "preview"]) assert.deepEqual(filledRun[key].details, onRun[key].details, key);
    assert.deepEqual(snapshot(filledArt), snapshot(onArt), "omitted references: byte-identical artifacts to the explicit run");
    assert.equal(readFileSync(join(filledArt, "claims.jsonl"), "utf8"), claimsBefore);
    const plan = JSON.parse(readFileSync(join(filledArt, filledRun.p.details.planRef), "utf8"));
    assert.equal(plan.reader_question, readerQuestion);
    assert.equal(plan.visual_concept_ref, "editorial/concepts/migration.json");
    assert.equal(plan.modules[0].critic_ref, "visualizations/critics/map.json");
    assert.equal(offRun.p.details.planRef, filledRun.p.details.planRef);
    check("real: switch on, explicit calls == switch off byte for byte; omitting six plan fields, module critics, lint/manifest/critic refs gives the identical artifacts; claims.jsonl untouched");
  }

  const reject = async (label, art, plan, expectation, { notWritten = true } = {}) => {
    const out = await attempt(registeredPlan.get("newsroom_infographic_plan"), plan);
    assert.ok(out.error, `${label}: must be rejected`);
    for (const pattern of [].concat(expectation)) assert.match(out.error, pattern, label);
    if (notWritten) assert.deepEqual(readdirSync(join(art, "infographics/plans")), [], `${label}: no plan written`);
    return out.error;
  };
  { // must-fail: values the model gives are never overridden
    const art = freshRun("m-explicit");
    await reject("wrong question", art, { ...omittedPlan(), reader_question: "Something else?" }, /reader_question must exactly match/);
    const wrong = omittedPlan();
    wrong.modules[1] = { ...wrong.modules[1], critic_ref: "visualizations/critics/map.json" };
    await reject("wrong critic", art, wrong, /critic does not match its manifest_ref/);
    await reject("wrong novelty", art, { ...omittedPlan(), novelty_ref: "editorial/novelty/nope.json" }, /novelty_ref|nope\.json/);
    await reject("wrong concept", art, { ...omittedPlan(), visual_concept_ref: "editorial/concepts/nope.json" }, /nope\.json/);
    check("real must-fail: a wrong reader_question, critic_ref, novelty_ref or visual_concept_ref is rejected with nothing written, never replaced by the derivable one");
  }
  { // must-fail: ambiguity is never resolved by guessing
    const art = freshRun("m-ambig");
    writeFileSync(join(art, "editorial/concepts/other.json"), JSON.stringify({ finalists: ["route-spine"], discovery_ref: "editorial/discovery/migration.json" }));
    await reject("two concept sets", art, omittedPlan(), [/visual_concept_ref is missing and could not be derived: 2 candidates/, /editorial\/concepts\/migration\.json/, /editorial\/concepts\/other\.json/]);
    writeFileSync(join(art, "visualizations/critics/map2.json"), JSON.stringify({ passed: true, score: 91, manifest_ref: "visualizations/map.json" }));
    await reject("two critics", art, omittedPlan(), /module 'map'.*critic_ref.*2 passing critics/s);
    check("real must-fail: two candidate concept sets or two passing critics are listed, not guessed");
  }
  { // must-fail: nothing to derive from
    const art = freshRun("m-none");
    writeFileSync(join(art, "editorial/novelty/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", passed: false }));
    await reject("failed novelty", art, omittedPlan(), /novelty_ref is missing and could not be derived: no passing editorial\/novelty artifact.*newsroom_semantic_novelty/);
    writeFileSync(join(art, "visualizations/critics/trend.json"), JSON.stringify({ passed: false, score: 10, manifest_ref: "visualizations/trend.json" }));
    await reject("failed critic", art, omittedPlan(), /module 'trend'.*no passing critic is bound/s);
    writeFileSync(join(art, "editorial/assets/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", concept_id: "route-spine", decision: "RESEARCH_MORE" }));
    await reject("asset plan not CONTINUE", art, omittedPlan(), /asset_plan_ref is missing and could not be derived/);
    check("real must-fail: a failed novelty report, a failed critic or a non-CONTINUE asset plan is never a candidate");
  }
  { // must-fail: the evidence gates still hold
    const art = freshRun("m-gates", { draft: { trend: true } });
    await reject("draft manifest", art, omittedPlan(), /DRAFT \/ non-publishable visualization; no critic is filled for it/);
    const art2 = freshRun("m-claim");
    writeFileSync(join(art2, "claims.jsonl"), readFileSync(join(art2, "claims.jsonl"), "utf8").split("\n").filter((line) => line && !line.includes("c-outcome")).join("\n") + "\n");
    await reject("unverified claim", art2, omittedPlan(), /module 'resolution' references unverified claim 'c-outcome'/);
    const art3 = freshRun("m-final");
    await reject("not a finalist", art3, { ...omittedPlan(), selected_concept_id: "not-a-finalist" }, /visual_concept_ref is missing and could not be derived: no editorial\/concepts artifact lists 'not-a-finalist' as a finalist/);
    await reject("selected_concept_id never invented", art3, (() => { const p = omittedPlan(); delete p.selected_concept_id; return p; })(), [/selected_concept_id is required/, /selected_concept_id is needed to find the concept set/]);
    check("real must-fail: a DRAFT manifest, an unverified claim, a non-finalist and a missing selected_concept_id are all rejected under the switch");
  }
  { // claims, story nodes and claim ids are never filled; the original error text is kept
    const art = freshRun("m-copy");
    const plan = omittedPlan();
    plan.modules = plan.modules.map((m) => (m.id === "resolution" ? (({ claim_ids, ...rest }) => rest)(m) : m.id === "map" ? (({ story_node_ids, ...rest }) => rest)(m) : m));
    const error = await reject("claim ids and story nodes", art, plan, [/module 'map' requires story_node_ids in InfographicSpec 1\.4\+/, /text module 'resolution' requires claim_ids/]);
    registerWith(false);
    const direct = await attempt(planTool(), { ...plan, reader_question: readerQuestion, visual_thesis: visualThesis, editorial_discovery_ref: "editorial/discovery/migration.json", visual_concept_ref: "editorial/concepts/migration.json", novelty_ref: "editorial/novelty/migration.json", asset_plan_ref: "editorial/assets/migration.json", modules: plan.modules.map((m) => (m.type === "visual" ? { ...m, critic_ref: `visualizations/critics/${m.manifest_ref.split("/")[1]}` } : m)) });
    assert.match(direct.error, /module 'map' requires story_node_ids in InfographicSpec 1\.4\+; text module 'resolution' requires claim_ids/);
    registeredPlan = registerWith(true);
    check("real must-fail: story_node_ids and claim_ids are never filled; the switch-off error names the same problems");
  }
  { // everything wrong at once is one error
    const art = freshRun("m-all", { draft: { sankey: true } });
    writeFileSync(join(art, "editorial/novelty/migration.json"), JSON.stringify({ concept_ref: "editorial/concepts/migration.json", passed: false }));
    writeFileSync(join(art, "claims.jsonl"), readFileSync(join(art, "claims.jsonl"), "utf8").split("\n").filter((line) => line && !line.includes("c-flow")).join("\n") + "\n");
    const plan = omittedPlan();
    plan.modules = plan.modules.map((m) => (m.id === "resolution" ? { ...m, story_node_ids: ["n-change", "n-ghost"] } : m));
    const error = await reject("aggregate", art, plan, [/^Preflight found \d+ unmet preconditions for newsroom_infographic_plan/, /novelty_ref is missing and could not be derived/, /unknown story node 'n-ghost'/, /DRAFT \/ non-publishable visualization; no critic is filled for it/]);
    assert.ok((error.match(/^\d+\. /gm) ?? []).length >= 3);
    check("real must-fail: a failed novelty report, an unknown story node and a DRAFT manifest (no critic filled for it) come back together in one numbered error");
  }
  { // render / critic / preview
    const art = freshRun("m-stage");
    const run = await pipeline(registeredPlan, explicitPlan());
    const planRef = run.p.details.planRef;
    const render = registeredPlan.get("newsroom_infographic_render");
    const otherPlan = { ...explicitPlan(), title: "Another page" };
    const second = await registeredPlan.get("newsroom_infographic_plan").execute("p2", otherPlan);
    const secondLint = await registeredPlan.get("newsroom_infographic_lint").execute("l2", { plan_ref: second.details.planRef });
    assert.equal((await attempt(render, { plan_ref: planRef, lint_ref: secondLint.details.lintRef })).error.includes("does not belong to the supplied plan"), true, "a lint of another plan is rejected, not swapped");
    const twin = join(art, "infographics/lints/twin.json");
    writeFileSync(twin, readFileSync(join(art, run.lint.details.lintRef)));
    const ambiguous = await attempt(render, { plan_ref: planRef });
    assert.match(ambiguous.error, /lint_ref is missing and could not be derived: 2 candidates/);
    const noLint = await attempt(render, { plan_ref: second.details.planRef.replace(/.$/, "0") });
    assert.ok(noLint.error);
    const critic = registeredPlan.get("newsroom_infographic_critic");
    const needsLint = await attempt(critic, { plan_ref: planRef });
    assert.match(needsLint.error, /lint_ref is missing and could not be derived: 2 candidates/);
    const preview = registeredPlan.get("newsroom_infographic_preview");
    const missingCritic = await attempt(preview, { manifest_ref: "infographics/does-not-exist.json" });
    assert.match(missingCritic.error, /critic_ref is missing and could not be derived: no passing deterministic infographic critic/);
    const sibling = join(art, "infographics/critics/twin.json");
    writeFileSync(sibling, readFileSync(join(art, run.critic.details.criticRef)));
    const twoCritics = await attempt(preview, { manifest_ref: run.render.details.manifestRef });
    assert.match(twoCritics.error, /critic_ref is missing and could not be derived: 2 candidates/);
    check("real must-fail: render/critic/preview reject a lint of another plan, and list two lints or two critics instead of choosing");
  }
  { // an explicit empty value is rejected by the original validator, not replaced; stale and rejected artifacts are not candidates
    const art = freshRun("m-empty");
    for (const [field, value] of [["reader_question", ""], ["visual_thesis", ""], ["visual_concept_ref", ""], ["novelty_ref", ""], ["reader_question", null], ["asset_plan_ref", null]]) {
      const plan = pagePlan({ withQuestion: true });
      plan[field] = value;
      const out = await attempt(registeredPlan.get("newsroom_infographic_plan"), schemaOrdered(plan));
      assert.ok(out.error, `${field}=${JSON.stringify(value)} must be rejected with the switch on`);
      assert.deepEqual(readdirSync(join(art, "infographics/plans")), [], "nothing written");
    }
    registeredPlan = registerWith(false);
    const off = await attempt(registeredPlan.get("newsroom_infographic_plan"), schemaOrdered({ ...pagePlan({ withQuestion: true }), reader_question: "" }));
    registeredPlan = registerWith(true);
    assert.ok(off.error, "and the switch-off tool rejects it too");
    const planRef = (await registeredPlan.get("newsroom_infographic_plan").execute("p", explicitPlan())).details.planRef;
    const emptyLint = await attempt(registeredPlan.get("newsroom_infographic_render"), { plan_ref: planRef, lint_ref: "" });
    assert.ok(emptyLint.error && !/derived/.test(emptyLint.error) || /cannot be read/.test(emptyLint.error), "an empty lint_ref is not derived");
    // a lint that is stale (an upstream chart changed after it) is not a candidate
    const lint = await registeredPlan.get("newsroom_infographic_lint").execute("l", { plan_ref: planRef });
    assert.equal(lint.details.passed, true);
    writeFileSync(join(art, "visualizations/map.svg"), svg.replace("#fafafa", "#eeeeee"));
    const stale = await attempt(registeredPlan.get("newsroom_infographic_render"), { plan_ref: planRef });
    assert.match(stale.error, /lint_ref is missing and could not be derived: no passing infographic lint is bound/);
    writeFileSync(join(art, "visualizations/map.svg"), svg);
    // an old passing critic whose manifest has since been rejected is not a candidate
    const rejectedKey = "trend";
    const manifestText = readFileSync(join(art, `visualizations/${rejectedKey}.json`), "utf8");
    rmSync(join(art, `visualizations/${rejectedKey}.json`));
    mkdirSync(join(art, `visualizations/rejected/${rejectedKey}`), { recursive: true });
    writeFileSync(join(art, `visualizations/rejected/${rejectedKey}/rejection.json`), JSON.stringify({ reason: "critic_failed", critic_ref: `visualizations/critics/${rejectedKey}.json` }));
    const outRejected = await attempt(registeredPlan.get("newsroom_infographic_plan"), omittedPlan());
    assert.ok(outRejected.error);
    assert.match(outRejected.error, /modules\[trend\]\.critic_ref.*REJECTED|REJECTED.*trend/s);
    assert.deepEqual(readdirSync(join(art, "infographics/plans")), [planRef.split("/").pop()], "no new plan written");
    void manifestText;
    check("real must-fail: explicit \"\" and null are rejected (not replaced); a stale lint and a passing critic of a rejected manifest are never candidates");
  }
  { // switch off: omitting a reference fails the way the pre-change tool does
    registeredPlan = registerWith(false);
    const art = freshRun("m-off");
    const planOut = await attempt(registeredPlan.get("newsroom_infographic_plan"), omittedPlan());
    assert.ok(planOut.error && !/Preflight/.test(planOut.error));
    const run = await pipeline(registeredPlan, explicitPlan());
    const renderOut = await attempt(registeredPlan.get("newsroom_infographic_render"), { plan_ref: run.p.details.planRef });
    assert.ok(renderOut.error && !/Preflight/.test(renderOut.error));
    assert.ok(existsSync(join(art, run.render.details.manifestRef)));
    registeredPlan = registerWith(true);
    check("real: switch off, omitted references fail as before (no preflight text, nothing filled)");
  }
}

for (const name of results) assert.ok(name);
console.log(results.map((name) => `  ok  ${name}`).join("\n"));
console.log(`preflight: ${results.length} checks -- PASS${realWorks ? "" : " (duckdb unavailable: real checks skipped)"}`);
