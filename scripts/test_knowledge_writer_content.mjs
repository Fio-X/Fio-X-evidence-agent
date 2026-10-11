#!/usr/bin/env node
// K214 part B: with NEWSROOM_GROUP_ENFORCE=1 the hand-off writers check WHAT they are asked to write.
// knowledge_writer: a computation record must sit at its content address, its rows must hash to result_hash, and the SQL run again on the recorded
// inputs must give the same hash; a query-rows table must equal the rows of the computation it is named after. agent_record_writer: bookkeeping only,
// fixed fields and types. The decision records follow the program-records mode. Needs duckdb. Loads a type-stripped copy of runtime/pi/newsroom.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTestTmp } from "./tmp_helper.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = makeTestTmp("kw-content-");
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_") || name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_DUCKDB_BIN", "NEWSROOM_HIDE_LIEFLAT"]) delete process.env[name];
const results = [];
const check = (name) => results.push(name);

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
const tree = join(scratch, "tree");
cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
stub(tree, "typebox", TYPEBOX);
stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
writeFileSync(join(tree, "runtime/pi/newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(tree, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(pathToFileURL(join(tree, "runtime/pi/newsroom.test-copy.mjs")).href);
const groups = await import(pathToFileURL(join(tree, "runtime/pi/groups.mjs")).href);

const BASE_ENV = { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_INLINE_CLAIM: "1" };
function register(env = {}) {
  for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_GROUP_")) delete process.env[key];
  Object.assign(process.env, BASE_ENV, env);
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const REPORT = "runtime/group-boundary-report.json";
const reportOf = (dir) => JSON.parse(readFileSync(join(dir, REPORT), "utf8"));
const renewable = readFileSync(join(ROOT, "fixtures/world-bank-renewable-latest.csv"));
let seq = 0;
function investigation() {
  const dir = join(scratch, `inv-${++seq}`);
  const sha = sha256(renewable);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "data", `${sha}.csv`), renewable);
  writeFileSync(join(dir, "data", `${sha}.csv.meta.json`), `${JSON.stringify({ bytes: renewable.length, file: `data/${sha}.csv`, schema_version: "0.7.0", sha256: sha }, null, 2)}\n`);
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  groups.resetBoundaryReport();
  return { dir, ref: `data/${sha}.csv` };
}
const planParams = (ref, extra = {}) => ({
  reader_task: "ranking", chart_type: "horizontal_bar", complexity_budget: "low", title: "Renewable energy consumption share by country",
  note: "Reference years differ by country.", unit: "%", category_field: "country_with_year", value_field: "renewable_energy_consumption_pct", sort: "desc",
  measure_semantics: [{ id: "renewable_pct", field: "renewable_energy_consumption_pct", phenomenon: "renewable energy consumption share", unit: "%", measure_kind: "share", temporal_basis: { type: "point_in_time" }, observation_status: "observed" }],
  claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "renewable_pct", measure_ids: ["renewable_pct"] },
  source_note: "来源：测试数据",
  sql: `SELECT country, year, renewable_energy_consumption_pct, country || ' (' || year || ')' AS country_with_year\nFROM '${ref}'\nORDER BY renewable_energy_consumption_pct DESC, country`,
  claim: "Among the African countries in the data, {max.renewable_energy_consumption_pct.country} has the highest renewable energy consumption share at {max.renewable_energy_consumption_pct}% ({max.renewable_energy_consumption_pct.year} data) and {min.renewable_energy_consumption_pct.country} the lowest at {min.renewable_energy_consumption_pct}% ({min.renewable_energy_consumption_pct.year} data).",
  claim_kind: "comparative", ...extra,
});
const find = (report, where) => report.records.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
const strip = (text) => text.replace(/"(recorded_at|created_at|timestamp|updated_at)":\s*"[^"]*"/g, "").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "");
const snapshot = (dir) => Object.fromEntries(walk(dir).map((f) => relative(dir, f)).filter((f) => f !== REPORT).sort().map((f) => [f, strip(readFileSync(join(dir, f), "utf8"))]));
async function planAndLint(env) {
  const story = investigation();
  const tools = register(env);
  const out = await tools.get("newsroom_viz_plan").execute("c", planParams(story.ref));
  assert.ok(out.content[0].text.includes("Claim recorded: VERIFIED"), "the plan call works");
  const planRef = out.details?.plan_ref ?? out.details?.planRef ?? out.details?.visualization_plan ?? walk(join(story.dir, "visualizations")).map((f) => relative(story.dir, f)).find((f) => /plan.*\.json$/.test(f)) ?? walk(join(story.dir, "visualizations")).map((f) => relative(story.dir, f)).find((f) => f.endsWith(".json"));
  assert.ok(planRef, "found the recorded plan");
  await tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef, visualization_plan: planRef, plan: planRef });
  return story;
}
const kw = await import(pathToFileURL(join(tree, "runtime/pi/knowledge_writer.mjs")).href);
const ar = await import(pathToFileURL(join(tree, "runtime/pi/agent_record_writer.mjs")).href);
const refused = async (fn, re, what) => { try { await fn(); } catch (e) { assert.match(String(e?.message), re, what); return; } assert.fail(`${what}: not refused`); };
const inTool = (tool, fn) => groups.runInTool(tool, fn);

// 1. the real flow passes with the checks on and writes the same files as with the hand-off alone; time of both
const timed = async (env) => { const t0 = performance.now(); const story = await planAndLint(env); return { story, ms: performance.now() - t0 }; };
const handoffOnly = await timed({ NEWSROOM_GROUP_HANDOFF: "1" });
const checkedRun = await timed({ NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_ENFORCE: "1", NEWSROOM_GROUP_BOUNDARY: "1" });
assert.deepEqual(snapshot(checkedRun.story.dir), snapshot(handoffOnly.story.dir), "checks on: the same files");
const refusals = join(checkedRun.story.dir, "runtime/boundary-refusals.jsonl");
assert.ok(!existsSync(refusals), "checks on: nothing refused in the real flow");
const computations = walk(join(checkedRun.story.dir, "computations"));
assert.ok(computations.length > 0);
console.log(`  time: plan+lint with hand-off ${handoffOnly.ms.toFixed(0)} ms, with hand-off and content checks ${checkedRun.ms.toFixed(0)} ms (${computations.length} computation record(s), one duckdb replay each)`);
check("real plan + lint under ENFORCE: same files, nothing refused");

// 2. the computation check: each tampering is refused, the good record is not
const story = checkedRun.story;
process.env.NEWSROOM_ARTIFACT_DIR = story.dir;
register({ NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_ENFORCE: "1" });
const goodFile = computations[0];
const ref = relative(story.dir, goodFile);
const good = JSON.parse(readFileSync(goodFile, "utf8"));
await mod.__verifyComputationForTest(ref, good);
await refused(() => mod.__verifyComputationForTest(ref, { ...good, rows: [...good.rows, good.rows[0]] }), /stored rows do not match result_hash/, "rows changed");
await refused(() => mod.__verifyComputationForTest(ref.replace(/[0-9a-f]\.json$/, (c) => (c[0] === "0" ? "1" : "0") + ".json"), good), /content-addressed path does not match/, "wrong path");
await refused(() => mod.__verifyComputationForTest(ref, { ...good, result_hash: "x" }), /incomplete/, "no result hash");
await refused(() => mod.__verifyComputationForTest(ref, { ...good, rows: undefined }), /incomplete/, "no rows");
await refused(() => mod.__verifyComputationForTest(ref, null), /not an object/, "not an object");
// rows, hash and address all agree with each other, but the SQL does not give these rows: only the replay can catch it
{
  const { hashRows } = await import(pathToFileURL(join(tree, "runtime/pi/viz.mjs")).href);
  const { computationRelativePath } = await import(pathToFileURL(join(tree, "runtime/pi/provenance.mjs")).href);
  const rows = [{ fake: 1 }];
  const hash = hashRows(rows);
  const forged = { ...good, rows, result_hash: hash };
  const forgedRef = computationRelativePath(good.sql, good.input_snapshot_hash, hash);
  await refused(() => mod.__verifyComputationForTest(forgedRef, forged), /deterministic result changed/, "forged rows with a matching hash and address");
}
// rows, hash and address are right, but the recorded read inputs were changed: the re-derivation from the SQL catches it
await refused(() => mod.__verifyComputationForTest(ref, { ...good, read_inputs: [...(good.read_inputs ?? []), "sources/nothing.json"] }), /recorded read inputs do not match|PROVENANCE/, "read_inputs altered");
await refused(() => mod.__verifyComputationForTest(ref, { ...good, input_binding: "other" }), /recorded read inputs do not match|PROVENANCE/, "input_binding altered");
// one implementation: the claim replay and the writer's check both call replayRecordedComputation, and neither has its own copy of the steps
{
  const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  const body = (name) => src.slice(src.indexOf(`async function ${name}(`), src.indexOf("\n}\n", src.indexOf(`async function ${name}(`)));
  assert.match(body("replayComputationEvidence"), /replayRecordedComputation\(/, "the claim replay calls the shared function");
  assert.match(body("verifyComputationForWrite"), /replayRecordedComputation\(/, "the writer's check calls the shared function");
  for (const name of ["replayComputationEvidence", "verifyComputationForWrite"]) for (const step of ["hashRows(", "computationRelativePath(", "deriveInputsForSql(", "recordedInputState(", "queryDuckDb("]) assert.ok(!body(name).includes(step), `${name} has no copy of ${step}`);
  assert.equal((src.match(/computationRelativePath\(sql, inputSnapshotHash/g) ?? []).length, 1, "the content-address step exists once");
}
check("computation check: changed rows, wrong address, missing hash or rows, not an object, forged rows are refused; the real record passes");

// 3. through the writer: a refused record is not written; with the switch off the same record is written (no check)
{
  const bad = { ...good, rows: [...good.rows, good.rows[0]] };
  const badRef = ref.replace(/[0-9a-f]\.json$/, "e.json");
  await refused(() => inTool("newsroom_viz_lint", () => mod.__saveComputationForTest(badRef, bad)), /KNOWLEDGE_WRITER_CONTENT/, "writer refuses");
  assert.ok(!existsSync(join(story.dir, badRef)), "nothing written for a refused record");
  register({ NEWSROOM_GROUP_HANDOFF: "1" });
  await inTool("newsroom_viz_lint", () => mod.__saveComputationForTest(badRef, bad));
  assert.ok(existsSync(join(story.dir, badRef)), "switch off: no check, the record is written as before");
  rmSync(join(story.dir, badRef));
}
check("writer: a record that fails is not written; ENFORCE off writes it as before");

// 4. query rows: must be the rows of the named computation
{
  register({ NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_ENFORCE: "1" });
  const rowsRef = `runtime/query-rows/${ref.split("/").pop()}`;
  await mod.__verifyQueryRowsForTest(rowsRef, good.rows);
  await refused(() => mod.__verifyQueryRowsForTest(rowsRef, [...good.rows, good.rows[0]]), /not the rows/, "other rows");
  await refused(() => mod.__verifyQueryRowsForTest("runtime/query-rows/nothing.json", good.rows), /no computation record/, "unnamed table");
  await refused(() => mod.__verifyQueryRowsForTest(rowsRef, "x"), /not an array/, "not an array");
}
check("query rows: only the rows of the computation of the same name pass");

// 5. bookkeeping: fixed fields and types
{
  const evt = { type: "tool_execution_start", chain: "c", toolCallId: "i", toolName: "t", step: 1, args: {}, _newsroom_recorded_at: "now" };
  assert.equal(ar.chainEventProblem(evt), null);
  assert.match(ar.chainEventProblem({ ...evt, extra: 1 }), /not allowed/);
  assert.match(ar.chainEventProblem({ ...evt, chain: 5 }), /must be a string/);
  assert.match(ar.chainEventProblem({ type: "pass" }), /not allowed/);
  assert.match(ar.chainEventProblem("x"), /not an object/);
  const rejection = (tool) => ({ schema_version: "0.1.0", kind: "rejected_call", tool, params: {} });
  const rref = `infographics/plan-rejections/${"a".repeat(64)}.json`;
  assert.equal(ar.rejectionProblem(rref, rejection("newsroom_infographic_plan")), null);
  assert.match(ar.rejectionProblem(rref, rejection("newsroom_infographic_chain")), /does not belong/);
  assert.match(ar.rejectionProblem(rref.replace("a".repeat(64), "z"), rejection("newsroom_infographic_plan")), /file name/);
  assert.match(ar.rejectionProblem(rref, { ...rejection("newsroom_infographic_plan"), verdict: "pass" }), /not allowed/);
  // through the writer: refused with ENFORCE, passed through without
  const writes = [];
  const w = ar.agentRecordWriter({ writeArtifactIfAbsent: async (r) => writes.push(r), appendArtifact: async (r, e) => writes.push(e) });
  process.env.NEWSROOM_GROUP_ENFORCE = "1";
  assert.throws(() => w.appendChainEvent({ type: "pass" }), /AGENT_RECORD_WRITER_CONTENT/);
  assert.throws(() => w.writeRejection(rref, { ...rejection("newsroom_infographic_plan"), verdict: "pass" }), /AGENT_RECORD_WRITER_CONTENT/);
  assert.equal(writes.length, 0);
  delete process.env.NEWSROOM_GROUP_ENFORCE;
  w.appendChainEvent({ type: "pass" });
  assert.equal(writes.length, 1, "ENFORCE off: no check");
}
check("agent record writer: fixed fields and types, exact file name; off: no check");

// 6. decision records: ENFORCE turns the program-records mode on, so a pass the model supplies is not counted
{
  const art = await import(pathToFileURL(join(tree, "runtime/pi/art_direction.mjs")).href);
  for (const k of ["NEWSROOM_GROUP_ENFORCE", "NEWSROOM_GROUP_REVIEW_FROM_RECORDS", "NEWSROOM_MODEL_PASS_SELFREPORT"]) delete process.env[k];
  assert.equal(art.programRecordsMode(), false);
  process.env.NEWSROOM_GROUP_ENFORCE = "1";
  assert.equal(art.programRecordsMode(), true);
  delete process.env.NEWSROOM_GROUP_ENFORCE;
}
check("decision records: ENFORCE=1 turns the program-records mode on, off leaves it as it was");

// 7. the claim: the hand-off path and record_claim are the same function (static)
{
  const text = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.match(text, /recordClaimArtifact: \(input: any, signal\?: AbortSignal\) => recordClaimArtifact\(input, signal\)/, "the knowledge writer's claim store is recordClaimArtifact");
  assert.match(text, /const saveClaim = .*: recordClaimArtifact\(input, signal\)\)/, "the off path is recordClaimArtifact too");
  assert.equal((text.match(/async function recordClaimArtifact\(/g) ?? []).length, 1, "one claim store function");
}
check("claim: record_claim, the inline claim and the writer call one function, recordClaimArtifact");
console.log(`PASS knowledge writer content (${results.length} checks)`);
