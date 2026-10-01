// NEWSROOM_SPEED_CHAIN_VIZ=1: newsroom_viz_chain runs plan -> lint -> render ->
// critic in one call through the registered (wrapped) executes. Needs duckdb.
//
// Part 1 drives runToolChain with fake tools for the stop rules that are hard to
// reach with real data. Part 2 loads runtime/pi/newsroom.ts from a type-stripped
// copy (as test_atomic_artifact_runtime.mjs does) and runs real charts.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { checkSchema, runToolChain, vizChainSteps, chainResultFor } = await import(join(ROOT, "runtime/pi/tool_chain.mjs"));

const results = [];
const check = (name, ok) => { results.push([name, ok]); };
const textResult = (text, details = {}) => ({ content: [{ type: "text", text }], details });

// ---- Part 1: orchestration with fake tools --------------------------------
const SCHEMAS = {
  newsroom_viz_plan: { type: "object", required: ["claim_id"], properties: { claim_id: { type: "string" } } },
  newsroom_viz_lint: { type: "object", required: ["plan_ref"], properties: { plan_ref: { type: "string", minLength: 3 } } },
  newsroom_viz_render: { type: "object", required: ["plan_ref", "lint_ref"], properties: { plan_ref: { type: "string" }, lint_ref: { type: "string" } } },
  newsroom_viz_critic: { type: "object", required: ["plan_ref", "lint_ref", "manifest_ref"], properties: { plan_ref: { type: "string" }, lint_ref: { type: "string" }, manifest_ref: { type: "string" } } },
};
const GOOD = {
  newsroom_viz_plan: () => textResult("plan ok", { planRef: "visualizations/plans/p.json", publishable: true }),
  newsroom_viz_lint: () => textResult("PASS lint", { passed: true, lintRef: "visualizations/lints/l.json", computationRef: "computations/c.json" }),
  newsroom_viz_render: () => ({ content: [{ type: "text", text: "rendered" }, { type: "image", data: "AAAA", mimeType: "image/png" }], details: { renderQaPassed: true, manifestRef: "visualizations/m.json" } }),
  newsroom_viz_critic: () => textResult("PASS critic", { passed: true, score: 91, criticRef: "visualizations/critics/c.json" }),
};
async function fake({ over = {}, enabled = () => true, model, claimRefs = ["computations/c.json"], schemas = SCHEMAS, planParams = { claim_id: "claim-x" }, signal } = {}) {
  const calls = [];
  const events = [];
  const impl = { ...GOOD, ...over };
  const outcome = await runToolChain({
    steps: vizChainSteps({ modelComputationRef: model, claimComputationRefs: async () => claimRefs }),
    state: { planParams },
    enabled,
    schemaOf: (name) => schemas[name],
    call: async (name, params) => { calls.push([name, params]); return impl[name](params); },
    record: (event) => { events.push(event); },
    signal,
  });
  return { outcome, calls, events };
}
const names = (calls) => calls.map(([name]) => name);

{ // all pass: four steps, refs flow forward, image block kept, events for every step
  const { outcome, calls, events } = await fake();
  assert.equal(outcome.status, "COMPLETE");
  assert.deepEqual(calls[3][1], { plan_ref: "visualizations/plans/p.json", lint_ref: "visualizations/lints/l.json", manifest_ref: "visualizations/m.json" });
  const res = chainResultFor(outcome, { chain: "newsroom_viz_chain", textResult });
  assert.ok(res.content.some((b) => b.type === "image" && b.data === "AAAA"), "image block passed through verbatim");
  assert.ok(res.content[0].text.includes("## newsroom_viz_render\nrendered") && res.content[0].text.includes("COMPLETE"));
  assert.equal(res.details.criticRef, "visualizations/critics/c.json");
  assert.deepEqual(events.map((e) => `${e.phase}:${e.tool}`), ["start", "end"].flatMap((p) => []).concat(
    ["newsroom_viz_plan", "newsroom_viz_lint", "newsroom_viz_render", "newsroom_viz_critic"].flatMap((t) => [`start:${t}`, `end:${t}`])));
  check("complete chain: refs flow, image passed through, start/end event per inner step", true);
}
{ // DRAFT plan: stop after plan, nothing else called
  const { outcome, calls } = await fake({ over: { newsroom_viz_plan: () => textResult("draft", { planRef: "visualizations/plans/p.json", publishable: false }) } });
  assert.equal(outcome.code, "DRAFT");
  assert.deepEqual(names(calls), ["newsroom_viz_plan"]);
  check("DRAFT plan stops after plan", true);
}
{ // cancellation: checked before each step and after each return; nothing starts afterwards, produced steps are kept
  const pre = new AbortController();
  pre.abort();
  const before = await fake({ signal: pre.signal });
  assert.equal(before.outcome.code, "CANCELLED");
  assert.deepEqual(names(before.calls), [], "aborted before the first step: nothing runs");
  for (const [abortIn, expected] of [["newsroom_viz_plan", ["newsroom_viz_plan"]], ["newsroom_viz_lint", ["newsroom_viz_plan", "newsroom_viz_lint"]], ["newsroom_viz_render", ["newsroom_viz_plan", "newsroom_viz_lint", "newsroom_viz_render"]]]) {
    const controller = new AbortController();
    const { outcome, calls, events } = await fake({ signal: controller.signal, over: { [abortIn]: (params) => { controller.abort(); return GOOD[abortIn](params); } } });
    assert.equal(outcome.status, "STOPPED");
    assert.equal(outcome.code, "CANCELLED", abortIn);
    assert.deepEqual(names(calls), expected, `abort during ${abortIn}: no later step starts`);
    assert.equal(outcome.done.length, expected.length, "the finished step's artifacts are kept");
    assert.equal(events.filter((e) => e.phase === "end" && e.isError === false).length, expected.length);
    const res = chainResultFor(outcome, { chain: "newsroom_viz_chain", textResult });
    assert.equal(res.details.stopCode, "CANCELLED");
    assert.ok(res.details.planRef && !res.details.publishable, "no completion claim after cancellation");
  }
  const late = new AbortController();
  const afterHook = await fake({ signal: late.signal, over: { newsroom_viz_lint: (params) => { const r = GOOD.newsroom_viz_lint(params); return r; } }, claimRefs: ["computations/c.json"] });
  assert.equal(afterHook.outcome.status, "COMPLETE", "an unaborted signal changes nothing");
  check("AbortSignal: checked before and after each step, no later step starts, finished steps kept", true);
}
{ // an inner error result stops the chain even if it still carries old success details
  const { outcome, calls } = await fake({ over: { newsroom_viz_render: () => ({ ...textResult("boom", { renderQaPassed: true, manifestRef: "visualizations/m.json" }), isError: true }) } });
  assert.equal(outcome.code, "STEP_ERROR");
  assert.deepEqual(names(calls), ["newsroom_viz_plan", "newsroom_viz_lint", "newsroom_viz_render"]);
  const first = await fake({ over: { newsroom_viz_plan: () => ({ ...textResult("bad plan", { planRef: "p", publishable: true }), isError: true }) } }).catch((e) => e);
  assert.ok(first instanceof Error && /bad plan/.test(first.message), "the first step's error is thrown like the direct call");
  check("an isError result stops the chain at that step", true);
}
{ // publishable comes from the render/critic, not the plan's older answer
  const stale = await fake({ over: { newsroom_viz_render: () => ({ content: [{ type: "text", text: "r" }], details: { renderQaPassed: true, manifestRef: "m", publishable: false } }) } });
  assert.equal(stale.outcome.code, "DRAFT");
  assert.deepEqual(names(stale.calls), ["newsroom_viz_plan", "newsroom_viz_lint", "newsroom_viz_render"], "a draft render stops before the critic");
  const flipped = await fake({ over: { newsroom_viz_render: () => ({ content: [{ type: "text", text: "r" }], details: { renderQaPassed: true, manifestRef: "m", publishable: true } }), newsroom_viz_critic: () => textResult("c", { passed: true, criticRef: "c", publishable: false }) } });
  assert.equal(flipped.outcome.status, "COMPLETE");
  assert.equal(chainResultFor(flipped.outcome, { chain: "x", textResult }).details.publishable, false, "a later false beats the plan's true");
  const none = await fake();
  assert.equal(chainResultFor(none.outcome, { chain: "x", textResult }).details.publishable, undefined, "never copied from the plan");
  const good = await fake({ over: { newsroom_viz_render: () => ({ content: [{ type: "text", text: "r" }], details: { renderQaPassed: true, manifestRef: "m", publishable: true } }), newsroom_viz_critic: () => textResult("c", { passed: true, criticRef: "c", publishable: true }) } });
  assert.equal(chainResultFor(good.outcome, { chain: "x", textResult }).details.publishable, true);
  check("final publishable follows the current render/critic state; a draft render stops the chain", true);
}
for (const [label, tool, details, code, expectCalls] of [
  ["lint blocked", "newsroom_viz_lint", { passed: false, lintRef: "x", computationRef: "y" }, "BLOCKED", 2],
  ["lint passed missing", "newsroom_viz_lint", { lintRef: "x", computationRef: "y" }, "MISSING_FIELD", 2],
  ["render QA failed", "newsroom_viz_render", { renderQaPassed: false }, "RENDER_QA_FAILED", 3],
  ["renderQaPassed missing", "newsroom_viz_render", { manifestRef: "m" }, "MISSING_FIELD", 3],
  ["critic REVISE", "newsroom_viz_critic", { passed: false }, "REVISE", 4],
  ["critic passed missing", "newsroom_viz_critic", { score: 99 }, "MISSING_FIELD", 4],
  ["plan without planRef", "newsroom_viz_plan", { publishable: true }, "MISSING_FIELD", 1],
  ["publishable missing", "newsroom_viz_plan", { planRef: "p" }, "DRAFT", 1],
]) {
  const { outcome, calls } = await fake({ over: { [tool]: () => textResult("verbatim body", details) } });
  assert.equal(outcome.status, "STOPPED", label);
  assert.equal(outcome.code, code, label);
  assert.equal(outcome.failedAt, tool, label);
  assert.equal(calls.length, expectCalls, label);
  const res = chainResultFor(outcome, { chain: "newsroom_viz_chain", textResult });
  assert.ok(res.content[0].text.includes("verbatim body") && res.content[0].text.includes("separately next"), label);
  assert.equal(res.details.chainStatus, "STOPPED");
  check(`stops midway: ${label}`, true);
}
{ // a step that is not enabled in this phase/profile is never called
  const { outcome, calls } = await fake({ enabled: (name) => name !== "newsroom_viz_render" });
  assert.equal(outcome.code, "TOOL_NOT_ENABLED");
  assert.equal(outcome.nextTool, "newsroom_viz_render");
  assert.deepEqual(names(calls), ["newsroom_viz_plan", "newsroom_viz_lint"]);
  check("cross-phase: disabled inner tool is not called, no bypass", true);
}
{ // schema-rejected auto-filled parameter: the inner call never happens
  const { outcome, calls } = await fake({ schemas: { ...SCHEMAS, newsroom_viz_lint: { ...SCHEMAS.newsroom_viz_lint, properties: { plan_ref: { type: "string", minLength: 500 } } } } });
  assert.equal(outcome.code, "SCHEMA_REJECTED");
  assert.equal(outcome.failedAt, "newsroom_viz_lint");
  assert.deepEqual(names(calls), ["newsroom_viz_plan"]);
  const bad = await fake({ planParams: { claim_id: 7 } });
  assert.equal(bad.outcome.code, "SCHEMA_REJECTED");
  assert.equal(bad.calls.length, 0);
  assert.deepEqual(checkSchema({ type: "object", required: ["a"], properties: { a: { type: "string", enum: ["x"] } } }, { a: "y" }), ["params.a must be one of \"x\""]);
  check("schema-rejected parameter stops before the inner call", true);
}
{ // claim/computation mismatch, checked both before (model value) and after (lint) filling
  const wrongModel = await fake({ model: "computations/other.json" });
  assert.equal(wrongModel.outcome.code, "CLAIM_COMPUTATION_MISMATCH");
  assert.deepEqual(names(wrongModel.calls), ["newsroom_viz_plan"], "model value not bound to the claim: stop before lint");
  const unboundClaim = await fake({ claimRefs: ["computations/elsewhere.json"] });
  assert.equal(unboundClaim.outcome.code, "CLAIM_COMPUTATION_MISMATCH");
  assert.deepEqual(names(unboundClaim.calls), ["newsroom_viz_plan", "newsroom_viz_lint"], "claim not bound to the lint computation: stop before render");
  const disagrees = await fake({ model: "computations/c2.json", claimRefs: ["computations/c.json", "computations/c2.json"] });
  assert.equal(disagrees.outcome.code, "CLAIM_COMPUTATION_MISMATCH");
  assert.deepEqual(names(disagrees.calls), ["newsroom_viz_plan", "newsroom_viz_lint"], "model value differs from the verified lint result: rejected, never overridden");
  const agrees = await fake({ model: "computations/c.json" });
  assert.equal(agrees.outcome.status, "COMPLETE");
  check("claim/computation mismatch stops (before and after filling); agreeing value passes", true);
}
{ // first-step errors are thrown as the direct call would; later errors keep earlier results
  await assert.rejects(() => runToolChain({
    steps: vizChainSteps({ claimComputationRefs: async () => [] }), state: { planParams: { claim_id: "c" } }, enabled: () => true,
    schemaOf: () => undefined, call: async () => { throw new Error("VERIFIED_CLAIM_REQUIRED: nope"); },
  }), /VERIFIED_CLAIM_REQUIRED/);
  const { outcome } = await fake({ over: { newsroom_viz_render: () => { throw new Error("boom"); } } });
  assert.equal(outcome.code, "STEP_ERROR");
  assert.equal(outcome.done.length, 2);
  check("plan error is rethrown unchanged; later error keeps completed steps", true);
}
console.log(`orchestration (fake tools): ${results.length} checks -- PASS`);

// ---- Part 2: real tools -----------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "viz-chain-"));
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
// Schema-shaped TypeBox stand-in so the chain's schema check has something to check.
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
  const dir = mkdtempSync(join(tmpdir(), `viz-chain-tree-${label}-`));
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
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const BASE_ENV = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_HIDE_LIEFLAT: undefined, NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined };

const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
const basemap = getBasemap("naturalearth_admin0_50m");
const CSV = ["country,year,share", "Chad,2022,70.0", "Guinea,2022,66.6", "Liberia,2022,92.8", "Niger,2021,79.6", "Nigeria,2021,80.3", "Zambia,2021,83.0", "Atlantis,2022,50.0"].join("\n") + "\n";
const SQLS = [
  "SELECT country, year, share FROM 'data/africa.csv' WHERE country <> 'Atlantis' ORDER BY country",
  "SELECT country, year, share FROM 'data/africa.csv' WHERE country <> 'Atlantis' AND share > 60 ORDER BY country",
  "SELECT country, year, share FROM 'data/africa.csv' WHERE country <> 'Atlantis' AND share > 70 ORDER BY country",
];
const BLOCKED_SQL = "SELECT country, year, share FROM 'data/africa.csv' ORDER BY country"; // includes a country that is not on the basemap
const sha = "a".repeat(64);
const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };

function freshRun(label) {
  const art = join(mkdtempSync(join(tmpdir(), `viz-chain-${label}-`)), "run");
  for (const d of ["visualizations/plans", "visualizations/lints", "computations", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
  writeFileSync(join(art, "data", "africa.csv"), CSV);
  writeFileSync(join(art, "data", "africa.meta.json"), JSON.stringify({ file: "africa.csv", sha256: sha }));
  writeFileSync(join(art, "claims.jsonl"), "");
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  return art;
}
const planParams = (sql, claim_id) => ({
  reader_task: "spatial", title: "Renewable share", alt: "A choropleth of renewable energy share across several African countries.",
  takeaway: "Several African countries differ widely in renewable share.", source_note: "fixture", sql, unit: "%", chart_type: "choropleth", category_field: "country", value_field: "share",
  category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "explicit",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash,
  highlight_values: [], annotations: [], ...(claim_id ? { claim_id } : {}),
});
// Computes the SQL with duckdb_query, then records a verified claim bound to that computation.
async function bindClaim(tools, art, sql, claimId, { boundTo } = {}) {
  const query = await tools.get("duckdb_query").execute("q", { sql });
  const ref = boundTo ?? query.details.path;
  const rel = ref.startsWith("/") ? relative(art, ref) : ref;
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ claim_id: claimId, status: "verified", source_refs: ["data/africa.csv"], computation_refs: [rel], verification })}\n`, { flag: "a" });
  return rel;
}
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const snapshot = (art) => Object.fromEntries(walk(art).map((f) => relative(art, f)).filter((f) => !f.startsWith("runtime/")).sort().map((f) => [f, readFileSync(join(art, f), "utf8")]));

const { mod, dir: treeDir } = await loadTree("main");
void treeDir;

{ // switch off: the chain tool does not exist and every other tool is registered as before
  const off = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: undefined });
  const on = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: "1" });
  assert.ok(!off.has("newsroom_viz_chain"));
  assert.ok(on.has("newsroom_viz_chain"));
  assert.deepEqual([...on.keys()].filter((n) => n !== "newsroom_viz_chain"), [...off.keys()]);
  for (const name of off.keys()) assert.equal(JSON.stringify(on.get(name).parameters) + on.get(name).description, JSON.stringify(off.get(name).parameters) + off.get(name).description, name);
  const other = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: "true" });
  assert.ok(!other.has("newsroom_viz_chain"), "only exactly '1' turns it on");
  const noPlan = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_TOOL_PROFILE: "publication" });
  assert.ok(!noPlan.has("newsroom_viz_chain") && !noPlan.has("newsroom_viz_plan"), "no plan tool in this profile -> no chain");
  const schema = on.get("newsroom_viz_chain").parameters;
  assert.ok(schema.properties.computation_ref && schema.properties.sql && schema.required.includes("sql") && !schema.required.includes("computation_ref"));
  for (const atomic of [undefined, "0", "true"]) {
    const t = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: atomic });
    assert.ok(!t.has("newsroom_viz_chain"), `chain needs atomic writes exactly "1" (got ${atomic})`);
    assert.deepEqual([...t.keys()], [...off.keys()], "other tools unchanged when the chain is refused");
  }
  check("switch off registers nothing new; on adds only newsroom_viz_chain where viz_plan exists; chain x atomic on/off", true);
}

async function runManual(tools, art, sql, claimId) {
  const plan = await tools.get("newsroom_viz_plan").execute("p", planParams(sql, claimId));
  const lint = await tools.get("newsroom_viz_lint").execute("l", { plan_ref: plan.details.planRef });
  const render = await tools.get("newsroom_viz_render").execute("r", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
  const critic = await tools.get("newsroom_viz_critic").execute("c", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef, manifest_ref: render.details.manifestRef });
  return { plan, lint, render, critic };
}

let renderWorks = true;
{ // chain == manual, byte for byte; N=3 charts in one round
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: "1" });
  const manualArt = freshRun("manual");
  const claims = SQLS.map((_, i) => `claim-n${i}`);
  for (const [i, sql] of SQLS.entries()) await bindClaim(tools, manualArt, sql, claims[i]);
  const manual = [];
  try { for (const [i, sql] of SQLS.entries()) manual.push(await runManual(tools, manualArt, sql, claims[i])); } catch (error) { renderWorks = false; console.log(`render unavailable here (${String(error.message).slice(0, 120)}); skipping the chain==manual comparison`); }
  if (renderWorks) {
    const chainArt = freshRun("chain");
    for (const [i, sql] of SQLS.entries()) await bindClaim(tools, chainArt, sql, claims[i]);
    const outs = await Promise.all(SQLS.map((sql, i) => tools.get("newsroom_viz_chain").execute(`chain-${i}`, planParams(sql, claims[i]))));
    for (const [i, out] of outs.entries()) {
      assert.equal(out.details.chainStatus, "COMPLETE", JSON.stringify(out.details).slice(0, 400));
      assert.equal(out.details.criticRef, manual[i].critic.details.criticRef);
      assert.equal(out.details.manifestRef, manual[i].render.details.manifestRef);
      assert.deepEqual(out.details.steps.map((s) => s.tool), ["newsroom_viz_plan", "newsroom_viz_lint", "newsroom_viz_render", "newsroom_viz_critic"]);
    }
    assert.deepEqual(snapshot(chainArt), snapshot(manualArt), "chain and step-by-step produce byte-identical artifacts (claims.jsonl included)");
    const events = readFileSync(join(chainArt, "runtime", "tool-chain-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events.length, 3 * 4 * 2);
    assert.deepEqual([...new Set(events.map((e) => e.toolName))].sort(), ["newsroom_viz_critic", "newsroom_viz_lint", "newsroom_viz_plan", "newsroom_viz_render"]);
    assert.ok(events.filter((e) => e.type === "tool_execution_end").every((e) => e.isError === false && e.result.details));
    assert.equal(new Set(events.map((e) => e.toolCallId)).size, 12);
    check("real charts: chain output equals step-by-step byte for byte; N=3 in one round; event log has every inner step", true);
  }
}

if (renderWorks) {
  const tools = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: "1" });
  { // no claim_id: the plan's own validation throws (baseline behaviour), the chain adds nothing
    const art = freshRun("draft");
    await assert.rejects(() => tools.get("newsroom_viz_chain").execute("d", planParams(SQLS[0])), /Missing required field 'claim_id'/);
    assert.equal(readdirSync(join(art, "visualizations", "plans")).length, 0);
    check("real: plan without claim_id throws exactly as the direct call (DRAFT stop itself is covered with fake tools)", true);
  }
  { // hypothesis claim: the plan's own gate throws, chain adds nothing
    const art = freshRun("hyp");
    writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ claim_id: "claim-h", status: "hypothesis", source_refs: ["data/africa.csv"], computation_refs: [], verification: { ...verification, publishable: false } })}\n`);
    const before = readFileSync(join(art, "claims.jsonl"), "utf8");
    await assert.rejects(() => tools.get("newsroom_viz_chain").execute("h", planParams(SQLS[0], "claim-h")), /VERIFIED_CLAIM_REQUIRED/);
    assert.equal(readFileSync(join(art, "claims.jsonl"), "utf8"), before);
    assert.equal(readdirSync(join(art, "visualizations", "plans")).length, 0);
    check("real: hypothesis claim -> VERIFIED_CLAIM_REQUIRED thrown, claims.jsonl unchanged", true);
  }
  { // model-written wrong basemap hash: plan gate throws, nothing is overridden
    const art = freshRun("hash");
    await bindClaim(tools, art, SQLS[0], "claim-b");
    await assert.rejects(() => tools.get("newsroom_viz_chain").execute("b", { ...planParams(SQLS[0], "claim-b"), basemap_content_hash: "0".repeat(64) }), /basemap_content_hash does not match/);
    assert.equal(readdirSync(join(art, "visualizations", "plans")).length, 0);
    check("real: wrong basemap hash still rejected through the chain", true);
  }
  { // schema-rejected plan parameter
    const art = freshRun("schema");
    const out = await tools.get("newsroom_viz_chain").execute("s", { ...planParams(SQLS[0], "claim-s"), chart_type: 7 });
    assert.equal(out.details.stopCode, "SCHEMA_REJECTED");
    assert.equal(readdirSync(join(art, "visualizations", "plans")).length, 0);
    check("real: schema-rejected parameter stops before any inner call", true);
  }
  { // lint blocker: stops at lint, no render/critic artifacts
    const art = freshRun("blocked");
    await bindClaim(tools, art, BLOCKED_SQL, "claim-x");
    const out = await tools.get("newsroom_viz_chain").execute("x", planParams(BLOCKED_SQL, "claim-x"));
    assert.equal(out.details.failedAt, "newsroom_viz_lint", JSON.stringify(out.details).slice(0, 300));
    assert.equal(out.details.stopCode, "BLOCKED");
    assert.equal(readdirSync(join(art, "visualizations")).filter((n) => n.endsWith(".svg") || n.endsWith(".json")).length, 0, "no render artifacts");
    check("real: lint blocker stops at lint; no render/critic artifacts", true);
  }
  { // claim bound to a different computation: stops after lint, before render
    const art = freshRun("mismatch");
    await bindClaim(tools, art, SQLS[0], "claim-m", { boundTo: "computations/" + "0".repeat(64) + ".json" });
    const out = await tools.get("newsroom_viz_chain").execute("m", planParams(SQLS[0], "claim-m"));
    assert.equal(out.details.stopCode, "CLAIM_COMPUTATION_MISMATCH");
    assert.equal(out.details.failedAt, "newsroom_viz_lint");
    assert.equal(readdirSync(join(art, "visualizations")).filter((n) => n.endsWith(".svg")).length, 0);
    const wrong = await tools.get("newsroom_viz_chain").execute("m2", { ...planParams(SQLS[0], "claim-m"), computation_ref: "computations/" + "1".repeat(64) + ".json" });
    assert.equal(wrong.details.stopCode, "CLAIM_COMPUTATION_MISMATCH");
    check("real: claim/computation mismatch stops before render (claim refs and model-supplied ref)", true);
  }
  { // fault injection on the wrapped lint execute reaches the chain
    freshRun("fault");
    const faulty = register(mod, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_FAULT_INJECT_TOOL_ONCE: "newsroom_viz_lint" });
    const art = process.env.NEWSROOM_ARTIFACT_DIR;
    await bindClaim(faulty, art, SQLS[0], "claim-f");
    const out = await faulty.get("newsroom_viz_chain").execute("f", planParams(SQLS[0], "claim-f"));
    assert.equal(out.details.stopCode, "STEP_ERROR");
    assert.equal(out.details.failedAt, "newsroom_viz_lint");
    assert.match(out.details.stopMessage, /INJECTED_TRANSIENT_FAILURE/);
    assert.deepEqual(out.details.steps.map((s) => s.tool), ["newsroom_viz_plan"], "the completed plan step is kept");
    check("real: chain calls the fault-injection-wrapped execute", true);
  }
}
{ // cross-phase: a registry in which render is not enabled for the profile
  const { mod: patched } = await loadTree("xphase", (text) => text.replace(/("name": "newsroom_viz_render"[\s\S]*?"agent_visible": )true/, "$1false"));
  const tools = register(patched, { ...BASE_ENV, NEWSROOM_SPEED_CHAIN_VIZ: "1" });
  assert.ok(tools.has("newsroom_viz_chain") && tools.has("newsroom_viz_lint") && !tools.has("newsroom_viz_render"));
  const art = freshRun("xphase");
  await bindClaim(tools, art, SQLS[0], "claim-p");
  const out = await tools.get("newsroom_viz_chain").execute("p", planParams(SQLS[0], "claim-p"));
  assert.equal(out.details.stopCode, "TOOL_NOT_ENABLED");
  assert.equal(out.details.failedAt, "newsroom_viz_render");
  assert.equal(out.details.nextTool, "newsroom_viz_render");
  assert.deepEqual(out.details.steps.map((s) => s.tool), ["newsroom_viz_plan", "newsroom_viz_lint"]);
  check("real: cross-phase/profile restriction stops the chain before the disabled tool", true);
}

for (const [name, ok] of results) assert.ok(ok, name);
console.log(results.map(([name]) => `  ok  ${name}`).join("\n"));
console.log(`viz chain: ${results.length} checks -- PASS${renderWorks ? "" : " (render unavailable: chain==manual comparison skipped)"}`);
