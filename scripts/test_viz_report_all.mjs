// NEWSROOM_SPEED_VIZ_REPORT_ALL=1: newsroom_viz_plan lists every independent problem in one refusal.
// Differential: the same case table runs against the recorded outputs of newsroom.ts before the switch (scripts/fixtures/base_records/viz_report_all_base_outputs.json,
// made once with BASE_RECORD_OUT=1 VIZ_REPORT_BASE_NEWSROOM_TS=<the earlier newsroom.ts> node scripts/test_viz_report_all.mjs; normal runs never read the history), against the head with
// the switch off, and against the head with it on. Verdict (accepted / refused) must agree in all three; off must equal the baseline's message
// exactly; on must start with the baseline's message (the first problem keeps its text) and may only add independent problems. A refused call
// must not run SQL or write anything (artifact root listing unchanged), and a refusal never records the inline claim.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lossless, poolDefinitions, readRecord, recordPath, recordSource, recording, unpoolDefinitions, writeRecord } from "./lib_base_record.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_REF = "the recorded baseline";
const RECORD = "viz_report_all_base_outputs";
const RECORDING = recording();
const baseRecord = RECORDING ? null : readRecord(RECORD, ["fixture", "results", "definitions"]);
const recorded = { fixture: {}, results: {}, definitions: {} };
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`;
const TREE = makeTestTmp("viz-report-all-");
const stub = (name, source) => {
  mkdirSync(join(TREE, "node_modules", name), { recursive: true });
  writeFileSync(join(TREE, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(TREE, "node_modules", name, "index.js"), source);
};
stub("typebox", TYPEBOX);
stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
cpSync(join(ROOT, "runtime"), join(TREE, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(TREE, "config"), { recursive: true });
const headSource = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
const baseSource = RECORDING ? recordSource("VIZ_REPORT_BASE_NEWSROOM_TS") : null;
const COPY_BASE = join(TREE, "runtime/pi/newsroom.base-copy.mjs");
const COPY_HEAD = join(TREE, "runtime/pi/newsroom.head-copy.mjs");
if (RECORDING) writeFileSync(COPY_BASE, stripTypeScriptTypes(baseSource, { mode: "strip" }));
writeFileSync(COPY_HEAD, stripTypeScriptTypes(headSource, { mode: "strip" }));

let n = 0;
async function load(file, env) {
  for (const k of Object.keys(process.env)) if (k.startsWith("NEWSROOM_") && k !== "NEWSROOM_ARTIFACT_DIR") delete process.env[k];
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  Object.assign(process.env, env);
  const tools = new Map();
  const mod = await import(`${pathToFileURL(file).href}?v=${++n}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const listing = (art) => Object.fromEntries(walk(art).map((f) => relative(art, f)).sort().map((f) => [f, sha(readFileSync(f.startsWith("/") ? f : join(art, f)))]));

// ---- one artifact root with a verified claim, shared by every call (refusals must leave it unchanged) -----------------------
const art = join(makeTestTmp("viz-report-all-art-"), "run");
for (const d of ["data", "sources", "computations", "runtime/query-rows", "visualizations/plans", "visualizations/lints", "visualizations/critics", "editorial/story-graphs"]) mkdirSync(join(art, d), { recursive: true });
cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
const csv = Buffer.from("region,amount\nn,4\ns,9\nw,6\n");
const data = `data/${sha(csv)}.csv`;
writeFileSync(join(art, data), csv);
writeFileSync(join(art, `${data}.meta.json`), JSON.stringify({ file: data, sha256: sha(csv), bytes: csv.length, label: "fixture" }));
const SQL = `SELECT region, amount FROM read_csv_auto('${data}')`;
// The fixture claim and the query snapshot the older module wrote are recorded files (root as <art>), written back here; record mode makes them with the older module.
const ART_TOKEN = "<art>";
if (RECORDING) {
  const before = new Set(walk(art).map((f) => relative(art, f)));
  const setup = await load(COPY_BASE, { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "" });
  const q = await setup.get("duckdb_query").execute("q", { sql: SQL });
  await setup.get("record_claim").execute("c", { claim: "Amounts by region", claim_kind: "quantitative", status: "supported", source_refs: [data], computation_refs: [relative(art, q.details.path)] });
  for (const f of walk(art).map((f) => relative(art, f)).sort()) {
    if (before.has(f) || f.startsWith("config/")) continue;
    const text = readFileSync(join(art, f), "utf8");
    assert.ok(Buffer.from(text, "utf8").equals(readFileSync(join(art, f))), `${f}: the fixture file is not utf8 text`);
    // the one wall-clock value in the fixture is fixed, on disk too, so the record is the same every time it is made and the older module's calls see what the test restores
    const fixed = text.replace(/("[a-z_]+_at":")\d{4}-\d\d-\d\dT[\d:.]+Z(")/g, "$11970-01-01T00:00:00.000Z$2");
    if (fixed !== text) writeFileSync(join(art, f), fixed);
    recorded.fixture[f] = fixed.split(art).join(ART_TOKEN);
  }
}
const fixture = RECORDING ? recorded.fixture : baseRecord.fixture;
if (!RECORDING) for (const [f, text] of Object.entries(fixture)) { mkdirSync(dirname(join(art, f)), { recursive: true }); writeFileSync(join(art, f), text.split(ART_TOKEN).join(art)); }
assert.ok(fixture["claims.jsonl"], "the fixture holds the claim file");
const claimId = readFileSync(join(art, "claims.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1).claim_id;
assert.ok(claimId, "fixture claim recorded");
// a story graph that exists but has not passed, and one that has passed with node n1
writeFileSync(join(art, "editorial/story-graphs/open.json"), JSON.stringify({ passed: false, nodes: [{ id: "n1" }] }));
writeFileSync(join(art, "editorial/story-graphs/ok.json"), JSON.stringify({ passed: true, nodes: [{ id: "n1" }] }));

const good = {
  reader_task: "sequence", title: "Amounts by region", alt: "A horizontal bar chart of the amount recorded for each region in the fixture data.",
  takeaway: "Regions differ in amount.", source_note: "fixture", subtitle: "fixture", unit: "units", visual_family: "statistical", data_topology: "tabular",
  chart_type: "horizontal_bar", category_field: "region", value_field: "amount", sort: "desc", highlight_values: [], annotations: [], sql: SQL, claim_id: claimId,
};
const ms = [{ id: "amt", field: "amount", phenomenon: "amount by region", unit: "units", measure_kind: "level", temporal_basis: { type: "point_in_time" }, observation_status: "observed" }];
const ranked = { ...good, reader_task: "ranking", measure_semantics: ms, claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "amt", measure_ids: ["amt"], claim_id: claimId } };
const { category_field, ...noCategory } = good;
const module_ = { delivery_role: "infographic_module" };
const CASES = {
  "valid plain plan": good,
  "valid ranking plan with declarations": ranked,
  "rule 5 alone: horizontal_bar without category_field": noCategory,
  "sql write refused alone": { ...good, sql: "DELETE FROM x" },
  "sql write + rule 5": { ...noCategory, sql: "DELETE FROM x" },
  "rule 2 alone: module without story graph": { ...good, ...module_ },
  "rule 2 + rule 5": { ...noCategory, ...module_ },
  "unreadable story graph + rule 5": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/missing.json", story_node_ids: ["n1"] },
  "story graph not passed + rule 5": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/open.json", story_node_ids: ["n1"] },
  "unknown story node + rule 5": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/ok.json", story_node_ids: ["zz"] },
  "story binding fine, rule 5 only": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/ok.json", story_node_ids: ["n1"] },
  "declaration required alone (ranking without semantics)": { ...good, reader_task: "ranking" },
  "declaration required + rule 5": { ...noCategory, reader_task: "ranking" },
  "declaration required + story binding + rule 5": { ...noCategory, reader_task: "ranking", ...module_ },
  "rule 3 alone: target_measure is a field name": { ...ranked, claim_spec: { ...ranked.claim_spec, target_measure: "amount" } },
  "rule 3 + rule 5": { ...noCategory, ...ranked, category_field: undefined, claim_spec: { ...ranked.claim_spec, target_measure: "amount" } },
  "rule 4 alone: claim_spec.claim_id empty": { ...ranked, claim_spec: { ...ranked.claim_spec, claim_id: "" } },
  "rule 4 + rule 5": { ...ranked, category_field: undefined, claim_spec: { ...ranked.claim_spec, claim_id: "" } },
  "rule 4 + story binding + rule 5": { ...ranked, category_field: undefined, ...module_, claim_spec: { ...ranked.claim_spec, claim_id: "" } },
  "grammar block alone: rank claim on a line chart": { ...ranked, chart_type: "line", x_field: "region", category_field: undefined },
  "claim_id differs from the plan's, plus rule 5": { ...ranked, category_field: undefined, claim_spec: { ...ranked.claim_spec, claim_id: "other" } },
  "unknown claim_id (lookup) alone": { ...good, claim_id: "no-such-claim" },
  "unknown claim_id + rule 5 (lookup comes last)": { ...noCategory, claim_id: "no-such-claim" },
  "whitespace claim_id": { ...good, claim_id: "  " },
  "draft plan (no claim_id) valid": { ...good, claim_id: undefined },
  "draft plan + rule 5": { ...noCategory, claim_id: undefined },
};
// A fresh copy of the fixture root per call, so every variant starts from the same state and its side effects can be compared exactly.
const NORM_DROP = /(_at|timestamp|elapsed_ms|duration_ms)$/;
const dropTimes = (k, v) => (NORM_DROP.test(k) ? undefined : v);
const norm = (buf) => {
  try { return JSON.stringify(JSON.parse(buf), dropTimes); } catch { /* not one JSON document */ }
  try { return String(buf).trim().split("\n").map((line) => JSON.stringify(JSON.parse(line), dropTimes)).join("\n"); } catch { return sha(buf); } // JSON lines (claims.jsonl)
};
const trace = (root) => Object.fromEntries(walk(root).map((f) => relative(root, f)).sort().map((f) => [f, norm(readFileSync(join(root, f)))]));
const run = async (tools, params, flag, { env = {}, signal, tool = "newsroom_viz_plan", times = 1 } = {}) => {
  if (flag === undefined) delete process.env.NEWSROOM_SPEED_VIZ_REPORT_ALL; else process.env.NEWSROOM_SPEED_VIZ_REPORT_ALL = flag; // read at call time, so set it per call
  const root = join(makeTestTmp("viz-report-all-run-"), "run");
  cpSync(art, root, { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = root;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const before = trace(root);
  let out;
  for (let i = 0; i < times; i++) {
    try { const res = await tools.get(tool).execute("t", JSON.parse(JSON.stringify(params)), signal); out = { ok: true, text: res.content[0].text }; }
    catch (e) { out = { ok: false, message: String(e?.message ?? e), name: e?.name, code: e?.code }; }
  }
  const after = trace(root);
  for (const k of Object.keys(env)) delete process.env[k];
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort();
  const unroot = (t) => (typeof t === "string" ? t.split(root).join("<root>").split(art).join(ART_TOKEN) : t); // the per-call root's path is in some messages
  return { ...out, message: unroot(out.message), text: unroot(out.text), changed, written: Object.fromEntries(changed.map((f) => [f, unroot(after[f])])) };
};
// What the earlier code did for one call: run live in record mode (and store it), read from the record otherwise. Only undefined-valued keys may be dropped by JSON.
const baseRun = async (key, tools, params, flag, opts) => {
  if (!RECORDING) { assert.ok(baseRecord.results[key], `the record holds ${key}`); return baseRecord.results[key]; }
  assert.ok(!(key in recorded.results), `${key}: recorded twice`);
  const res = await run(tools, params, flag, opts);
  lossless(Object.fromEntries(Object.entries(res).filter(([, v]) => v !== undefined)), key);
  return (recorded.results[key] = Object.fromEntries(Object.entries(res).filter(([, v]) => v !== undefined)));
};
const base = RECORDING ? await load(COPY_BASE, {}) : null;
const off = await load(COPY_HEAD, {});
const on = off; // the switch is read when the tool runs, so one registration serves both
const CHAIN_ENV = { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_INLINE_CLAIM: "1" };
const baseChain = RECORDING ? await load(COPY_BASE, CHAIN_ENV) : null;
const headChain = await load(COPY_HEAD, CHAIN_ENV);
let refused = 0, accepted = 0, multi = 0, traced = 0;
// One differential: verdict, first error (text, class, code), side-effect trace (the files each variant wrote, with their normalized content), and for acceptance the written plan.
async function differential(name, params, { sets = { base, head: off }, ...opts } = {}) {
  const b = await baseRun(name, sets.base, params, undefined, opts);
  const o = await run(sets.head, params, undefined, opts);
  const r = await run(sets.head, params, "1", opts);
  assert.equal(o.ok, b.ok, `${name}: switch off verdict differs from ${BASELINE_REF}`);
  assert.equal(r.ok, b.ok, `${name}: switch on verdict differs from ${BASELINE_REF}`);
  // same preparation effects as the old code: the same files with the same content, accepted or refused (the inline path queries and may write query-rows)
  for (const [label, x] of [["off", o], ["on", r]]) { assert.deepEqual(x.written, b.written, `${name}: ${label} side effects differ from ${BASELINE_REF}`); traced++; }
  if (b.ok) {
    accepted++;
    assert.equal(o.text, b.text, `${name}: switch off result differs`); assert.equal(r.text, b.text, `${name}: switch on result differs for an accepted call`);
    return { b, o, r };
  }
  refused++;
  assert.equal(o.message, b.message, `${name}: switch off message differs from ${BASELINE_REF}`);
  assert.equal(o.name, b.name); assert.equal(o.code, b.code);
  assert.ok(r.message.startsWith(b.message), `${name}: first problem lost its text.\n baseline: ${b.message.slice(0, 200)}\n on: ${r.message.slice(0, 200)}`);
  assert.equal(r.name, b.name, `${name}: first problem lost its class`); assert.equal(r.code, b.code, `${name}: first problem lost its code`);
  // a refusal records no plan and no claim beyond what the old code wrote
  assert.ok(!r.changed.some((f) => f.startsWith("visualizations/plans/")), `${name}: a refusal wrote a plan`);
  if (!params.claim) assert.deepEqual(r.changed.filter((f) => f === "claims.jsonl"), [], `${name}: a refusal wrote a claim`);
  for (const bad of ["0", "", "true"]) { const x = await run(sets.head, params, bad, opts); assert.equal(x.message, b.message, `${name}: a non-"1" value changed the message`); }
  if (r.message !== b.message) { multi++; assert.match(r.message, /\nAlso refused in this call \(\d+ more independent problems?; no claim or plan was recorded[^)]*\):\n\(2\) /); }
  console.log(`  ${name}: ${r.message === b.message ? "one problem, same text" : `${r.message.split("\n").length - 2} more listed`}`);
  return { b, o, r };
}
for (const [name, params] of Object.entries(CASES)) await differential(name, params);
// ---- more inputs: malformed declarations, map defaults, K110 on and off, abort, the inline path and the chain ----
const EXTRA = {
  "malformed measures (entry without fields)": { ...ranked, measure_semantics: [{ id: "amt" }] },
  "malformed measures + rule 5": { ...noCategory, ...ranked, category_field: undefined, measure_semantics: [{ id: "amt" }] },
  "unknown measure id in measure_ids": { ...ranked, claim_spec: { ...ranked.claim_spec, measure_ids: ["nope"] } },
  "unknown target_measure + claim_id mismatch + rule 5": { ...ranked, category_field: undefined, claim_spec: { ...ranked.claim_spec, target_measure: "zz", claim_id: "other" } },
  "empty claim_id string (draft)": { ...good, claim_id: "" },
  "empty claim_id + rule 5": { ...noCategory, claim_id: "" },
  "legacy declaration (reader_task sequence, no claim_spec) + rule 5": { ...noCategory, reader_task: "sequence" },
  "draft with a claim_spec id that differs": { ...ranked, claim_id: undefined, claim_spec: { ...ranked.claim_spec, claim_id: "other" } },
  "incompatible grammar + rule 5": { ...ranked, chart_type: "line", x_field: "region", category_field: undefined },
  "map defaults: cartographic_flow_map with missing fields": { ...good, chart_type: "cartographic_flow_map" },
  "map defaults + sql write": { ...good, chart_type: "cartographic_flow_map", sql: "DELETE FROM x" },
  "map defaults + declaration required + story binding": { ...good, chart_type: "cartographic_flow_map", reader_task: "ranking", ...module_ },
  "story node ids empty array": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/ok.json", story_node_ids: [] },
  "story graph ref outside the story-graph folder": { ...noCategory, ...module_, story_graph_ref: "../claims.jsonl", story_node_ids: ["n1"] },
  "story graph malformed json": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/bad.json", story_node_ids: ["n1"] },
  "story graph without nodes + rule 5": { ...noCategory, ...module_, story_graph_ref: "editorial/story-graphs/nonodes.json", story_node_ids: ["n1"] },
};
writeFileSync(join(art, "editorial/story-graphs/bad.json"), "{not json");
writeFileSync(join(art, "editorial/story-graphs/nonodes.json"), JSON.stringify({ passed: true }));
for (const [name, params] of Object.entries(EXTRA)) await differential(name, params);
// K110: a scatter pairing, switch on and off, with declarations missing, unpaired and paired, and a missing axis
const scatter = { ...good, chart_type: "scatter", category_field: undefined, x_field: "amount", y_field: "amount", reader_task: "relationship" };
const K110 = { NEWSROOM_SCATTER_PAIRED_MEASURES: "1" };
const scatterMs = [{ ...ms[0], id: "xm", field: "amount" }, { ...ms[0], id: "ym", field: "amount" }];
const scatterSpec = { relation: "relationship", reader_task: "relationship", target_measure: "ym", measure_ids: ["xm", "ym"], claim_id: claimId };
const SCATTERS = {
  "scatter without declarations": scatter,
  "scatter, declared, one measure only": { ...scatter, measure_semantics: [scatterMs[0]], claim_spec: { ...scatterSpec, measure_ids: ["xm"], target_measure: "xm" } },
  "scatter, two measures on one field": { ...scatter, measure_semantics: scatterMs, claim_spec: scatterSpec },
  "scatter, missing y axis": { ...scatter, y_field: undefined, measure_semantics: scatterMs, claim_spec: scatterSpec },
  "scatter, claim_id mismatch": { ...scatter, measure_semantics: scatterMs, claim_spec: { ...scatterSpec, claim_id: "other" } },
};
for (const [name, params] of Object.entries(SCATTERS)) for (const [label, env] of [["K110 off", {}], ["K110 on", K110]]) await differential(`${name} (${label})`, params, { env });
// a cancelled call: the first problem is rethrown as it was (an abort is not listed as a validation message)
{
  const ac = new AbortController(); ac.abort();
  const { r } = await differential("aborted signal + rule 5", noCategory, { signal: ac.signal });
  assert.ok(!/Also refused/.test(r.message), "an aborted call listed more problems");
}
// a cancel in the middle of collection: the abort rethrows at once and replaces the earlier collected error (current behaviour, not a validation message)
{
  const sqlAndRule5 = { ...noCategory, sql: "DELETE FROM x" };
  const first = (await run(off, sqlAndRule5, "1")).message;
  assert.match(first, /\nAlso refused in this call/, "the fixture must collect two problems without an abort");
  let reads = 0;
  const lateAbort = { get aborted() { reads++; return reads > 1; } }; // clean on the first check, aborted when the second failure is kept
  const r = await run(off, sqlAndRule5, "1", { signal: lateAbort });
  assert.equal(r.ok, false);
  assert.ok(!/Also refused/.test(r.message), "an abort in the middle still listed the earlier problem");
  assert.notEqual(r.message, first.split("\nAlso refused")[0], "the abort did not replace the earlier collected error");
}
// the inline claim path: the preparation (query, claim text) runs once, before the checks, as before; the claim and plan are recorded only after every check passed
const TEMPLATE = "Region {max.amount.region} has the largest amount at {max.amount} units and {min.amount.region} the smallest at {min.amount} units.";
const { claim_id: _drop, takeaway: _t, alt: _a, ...inlineBase } = good;
const inline = { ...inlineBase, claim: TEMPLATE, claim_kind: "comparative" };
const INLINE_CASES = {
  "inline: valid": inline,
  "inline: valid preparation, then rule 5": { ...inline, category_field: undefined },
  "inline: valid preparation, then story binding + rule 5": { ...inline, category_field: undefined, ...module_ },
  "inline: valid preparation, then declaration required": { ...inline, reader_task: "ranking" },
  "inline: template with typed digits refused in preparation": { ...inline, claim: "Region n has 9 units." },
  "inline: no source evidence refused in preparation": { ...inline, sql: "SELECT 'n' AS region, 4 AS amount" },
  "inline: claim and claim_id together": { ...inline, claim_id: claimId },
  "inline: claim_kind without claim": { ...good, claim_kind: "comparative" },
  "inline: claim_spec with the claim id of its own, plus a rule 5": { ...inline, category_field: undefined, ranked: undefined, claim_spec: { relation: "rank", reader_task: "ranking", claim_id: "x" } },
  "inline: ranking with the runtime's claim id": { ...inline, reader_task: "ranking", measure_semantics: ms, claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "amt", measure_ids: ["amt"] } },
  "inline: ranking with an unknown target_measure and rule 5": { ...inline, category_field: undefined, reader_task: "ranking", measure_semantics: ms, claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "amount", measure_ids: ["amt"] } },
};
// INLINE_CLAIM on with an existing claim_id: alt and source_note stay required (validateVizSpec), on every arm
for (const [name, params] of Object.entries({ "inline on, claim_id given, no alt": { ...good, alt: undefined }, "inline on, claim_id given, no source_note": { ...good, source_note: undefined } })) {
  const o = await run(headChain, params, undefined, { env: CHAIN_ENV }), r = await run(headChain, params, "1", { env: CHAIN_ENV });
  assert.equal(o.ok, false, `${name}: accepted`); assert.equal(r.ok, false, `${name}: accepted with the list-all switch`);
  assert.deepEqual(r.changed.filter((f) => /plans?\//.test(f)), [], `${name}: a plan was written`);
}
for (const [name, params] of Object.entries(INLINE_CASES)) await differential(name, params, { sets: { base: baseChain, head: headChain }, env: CHAIN_ENV });
// a duplicate claim is reused: the second call of the same inline plan gives the same verdict and the same files as the old code
await differential("inline: the same plan twice (the claim is reused)", inline, { sets: { base: baseChain, head: headChain }, env: CHAIN_ENV, times: 2 });
// the chain: the same refusals reach the model through newsroom_viz_chain's plan step; the chain stops there, nothing later runs
{
  const stopMessage = (text) => /\(STEP_ERROR\): ([\s\S]*?)\nCompleted steps:/.exec(text)?.[1];
  for (const [name, params, fixed] of [["rule 5", noCategory], ["story binding + rule 5", { ...noCategory, ...module_ }], ["sql write + rule 5", { ...noCategory, sql: "DELETE FROM x" }], ["rule 4 + rule 5", CASES["rule 4 + rule 5"]], ["valid", good], ["inline + rule 5", { ...inline, category_field: undefined }]]) {
    const b = await baseRun(`chain: ${name}`, baseChain, params, undefined, { env: CHAIN_ENV, tool: "newsroom_viz_chain" });
    const o = await run(headChain, params, undefined, { env: CHAIN_ENV, tool: "newsroom_viz_chain" });
    const r = await run(headChain, params, "1", { env: CHAIN_ENV, tool: "newsroom_viz_chain" });
    assert.equal(o.ok, b.ok, `chain ${name}: off verdict`); assert.equal(r.ok, b.ok, `chain ${name}: on verdict`);
    if (b.ok) { assert.equal(o.text, b.text, `chain ${name}: off text`); if (/STOPPED/.test(b.text)) { const first = stopMessage(b.text); assert.ok(first, `chain ${name}: stop message found`); assert.ok(r.text.includes(first), `chain ${name}: first problem lost`); assert.equal(stopMessage(o.text), first); } }
    assert.deepEqual(o.written, b.written, `chain ${name}: off side effects`);
    // the chain's own event log records the plan step's error text, which is the longer list when the switch is on; every other file is the same
    const { "runtime/tool-chain-events.jsonl": logOn, ...writtenOn } = r.written, { "runtime/tool-chain-events.jsonl": logBase, ...writtenBase } = b.written;
    assert.deepEqual(writtenOn, writtenBase, `chain ${name}: on side effects`); assert.equal(Boolean(logOn), Boolean(logBase), `chain ${name}: event log presence`);
    if (b.ok && /STOPPED/.test(b.text)) assert.ok(!/## newsroom_viz_lint/.test(r.text), `chain ${name}: a step after the plan ran`);
    traced += 2;
  }
}
// the cases the switch exists for must list more than one problem, and the ones whose checks depend on each other must not
const msg = async (name) => (await run(on, CASES[name], "1")).message ?? "";
assert.match(await msg("rule 2 + rule 5"), /INFOGRAPHIC_MODULE_BINDING_REQUIRED[\s\S]*\(2\) Invalid visualization plan: .*category_field/);
assert.match(await msg("unreadable story graph + rule 5"), /\(2\) Invalid visualization plan: .*category_field/);
assert.match(await msg("sql write + rule 5"), /\(2\) Invalid visualization plan:/);
assert.match(await msg("declaration required + story binding + rule 5"), /SEMANTIC_DECLARATION_REQUIRED|INFOGRAPHIC_MODULE_BINDING_REQUIRED/);
assert.match(await msg("rule 3 + rule 5"), /\(2\) Invalid visualization plan:/);
assert.match(await msg("rule 4 + rule 5"), /claim_spec\.claim_id[\s\S]*\(2\) Invalid visualization plan:/);
// dependent checks are skipped when the check they read failed: no claim_id compare after a declaration or target_measure failure
assert.ok(!/claim_spec\.claim_id/.test(await msg("rule 3 + rule 5")), "claim_id compare ran although the semantic gate failed");
assert.ok(!/claim_spec\.claim_id/.test(await msg("declaration required + rule 5")), "claim_id compare ran although the declaration was missing");
// the claim lookup runs last: an unknown claim_id is listed only when nothing else is wrong
assert.ok(!/\(2\)/.test(await msg("unknown claim_id + rule 5 (lookup comes last)")), "the claim lookup was listed with other problems");
assert.ok(multi >= 8, `only ${multi} multi-problem cases`);
console.log(`PASS viz_plan report-all: ${refused} refused and ${accepted} accepted cases agree with ${BASELINE_REF} (off: identical text; on: first problem unchanged, ${multi} list more; ${traced} side-effect traces equal the baseline's; a refusal wrote no plan and no claim)`);

// ---- tool definitions: both switches off = byte-identical to the baseline; RULE_HINTS on = descriptions only; VIZ_REPORT_ALL changes no definition ----
{
  const PROFILES = ["investigate", "visual", "visual-story", "publication", "competition", "full"];
  const defs = async (file, env, profile) => {
    delete process.env.NEWSROOM_SPEED_VIZ_REPORT_ALL;
    const tools = await load(file, { ...env, NEWSROOM_TOOL_PROFILE: profile });
    return new Map([...tools].map(([name, t]) => [name, JSON.stringify(t)]));
  };
  const recordedDefs = {};
  const recordedPool = RECORDING ? null : baseRecord.definitions;
  // The earlier definitions: live in record mode (stored as parsed definitions; each must print back to the same text), the record otherwise.
  const baseDefsOf = async (profile, env, key) => {
    if (!RECORDING) return new Map([...unpoolDefinitions(recordedPool, key)].map(([name, def]) => [name, JSON.stringify(def)]));
    const live = await defs(COPY_BASE, env, profile);
    recordedDefs[key] = [...live].map(([name, text]) => { assert.equal(JSON.stringify(JSON.parse(text)), text, `${key}/${name}: the definition is not unchanged by JSON`); return [name, JSON.parse(text)]; });
    return live;
  };
  const stripDescriptions = (text) => JSON.stringify(JSON.parse(text), (k, v) => (k === "description" ? undefined : v));
  let tools = 0, changedByHints = new Set();
  for (const profile of PROFILES) {
    const baseDefs = await baseDefsOf(profile, {}, `off:${profile}`);
    const offDefs = await defs(COPY_HEAD, {}, profile);
    assert.deepEqual([...offDefs.keys()], [...baseDefs.keys()], `${profile}: same tools in the same order`);
    for (const [name, text] of baseDefs) assert.equal(offDefs.get(name), text, `${profile}/${name}: switches off, definition differs from ${BASELINE_REF}`);
    tools += baseDefs.size;
    const reportAll = await defs(COPY_HEAD, { NEWSROOM_SPEED_VIZ_REPORT_ALL: "1" }, profile);
    for (const [name, text] of baseDefs) assert.equal(reportAll.get(name), text, `${profile}/${name}: VIZ_REPORT_ALL changed a definition`);
    const hints = await defs(COPY_HEAD, { NEWSROOM_SPEED_RULE_HINTS: "1" }, profile);
    const hintsBase = await baseDefsOf(profile, { NEWSROOM_SPEED_RULE_HINTS: "1" }, `hints:${profile}`);
    for (const [name, text] of hintsBase) {
      const now = JSON.parse(hints.get(name)), was = JSON.parse(text), off = JSON.parse(baseDefs.get(name));
      assert.deepEqual(JSON.parse(stripDescriptions(hints.get(name))), JSON.parse(stripDescriptions(baseDefs.get(name))), `${profile}/${name}: RULE_HINTS on changed more than descriptions (enum, required, min/max)`);
      assert.equal(JSON.stringify(now.promptGuidelines), JSON.stringify(off.promptGuidelines), `${profile}/${name}: RULE_HINTS changed the guidelines`);
      if (hints.get(name) !== text) changedByHints.add(name);
    }
  }
  const planDesc = async (env, ...path) => path.reduce((o, k) => o?.[k], (await load(COPY_HEAD, { ...env, NEWSROOM_TOOL_PROFILE: "full" })).get("newsroom_viz_plan").parameters.properties)?.description ?? "";
  const hintsOn = { NEWSROOM_SPEED_RULE_HINTS: "1" };
  assert.ok(!/trend/.test(await planDesc(hintsOn, "claim_spec", "properties", "reader_task")), "the contradictory example is still there with RULE_HINTS on");
  assert.match(await planDesc(hintsOn, "claim_spec", "properties", "reader_task"), /part_to_whole/);
  assert.match(await planDesc({}, "claim_spec", "properties", "reader_task"), /trend/, "off keeps the old text");
  assert.match(await planDesc(hintsOn, "story_graph_ref"), /infographic_module/);
  assert.match(await planDesc(hintsOn, "story_node_ids"), /infographic_module/);
  assert.match(await planDesc(hintsOn, "story_graph_ref"), /passed narrative closure/);
  assert.match(await planDesc(hintsOn, "claim_spec", "properties", "target_measure"), /Optional\. When given.*measure_semantics\[\]\.id/);
  assert.ok(!/field name/.test(await planDesc(hintsOn, "claim_spec", "properties", "target_measure")), "a valid measure id may be spelled like a field");
  assert.match(await planDesc(hintsOn, "claim_spec", "properties", "claim_id"), /claim_spec is declared and the plan is verified.*present and equal to claim_id.*draft plan it is compared only when both/);
  assert.match(await planDesc(hintsOn, "category_field"), /present and nonempty/);
  const bindingHint = await planDesc(hintsOn, "claim_id");
  assert.match(bindingHint, /shared compatible evidence/); assert.match(bindingHint, /permitted computation relation/); assert.match(bindingHint, /no CTE, JOIN/); assert.ok(!/same hashes/.test(bindingHint)); assert.match(bindingHint, /read_json\('computations/); assert.match(bindingHint, /never reword the claim/);
  const enumText = await planDesc(hintsOn, "claim_spec", "properties", "reader_task");
  assert.ok(!/…|\.\.\./.test(enumText), "the enum is written out in full");
  for (const v of (await load(COPY_HEAD, { NEWSROOM_TOOL_PROFILE: "full" })).get("newsroom_viz_plan").parameters.properties.reader_task.enum) assert.ok(enumText.includes(v), `${v} missing from the written-out enum`);
  console.log(`PASS tool definitions: ${tools} definitions over ${PROFILES.length} profiles are byte-identical to ${BASELINE_REF} with the switches off and with VIZ_REPORT_ALL on; RULE_HINTS on changes only descriptions (${[...changedByHints].join(", ")}), and the claim_spec.reader_task example no longer lists a value outside the enum`);
  if (RECORDING) {
    recorded.definitions = poolDefinitions(recordedDefs);
    writeRecord(RECORD, { newsroom_ts_sha256: sha(baseSource), ...recorded });
    console.log(`wrote ${recordPath(RECORD)}`);
  }
}
