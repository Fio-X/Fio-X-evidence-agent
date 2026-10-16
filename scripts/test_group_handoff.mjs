#!/usr/bin/env node
// The hand-off is always on (a leftover NEWSROOM_GROUP_HANDOFF value is ignored): the claim record, the computation records and the query-row tables a visual tool needs are
// saved by the knowledge group's writer. The files stay byte-identical; with the boundary report on, those writes are listed under the
// knowledge writer (the asking tool stays visible as requested_by) and none of them is cross-group.
// Needs duckdb for the real viz_plan / viz_lint calls. Loads a type-stripped copy of runtime/pi/newsroom.ts. No provider, no network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "group-boundary-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_") || name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; // the off-table call refusal is on by default; this test is about something else, so both are pinned off
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_DUCKDB_BIN"]) delete process.env[name];
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
  process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; // the off-table call refusal is on by default; this test is about something else, so both are pinned off
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

// 1. no value of the removed switch changes anything: "0" included, every value gives the same files and hands the records over
const base = await planAndLint({});
const baseFiles = snapshot(base.dir);
const baseReport = reportOf((await planAndLint({ NEWSROOM_GROUP_BOUNDARY: "1" })).dir); // no leftover value: the writers each record are the reference
for (const value of [undefined, "0", "1", "true", "on", "", " 0", "00", "false"]) {
  const env = { NEWSROOM_GROUP_BOUNDARY: "1" };
  if (value !== undefined) env.NEWSROOM_GROUP_HANDOFF = value;
  const other = await planAndLint(env);
  assert.deepEqual(snapshot(other.dir), baseFiles, `value ${JSON.stringify(value)}: same files`);
  const r = reportOf(other.dir);
  assert.deepEqual(r.records, baseReport.records, `value ${JSON.stringify(value)}: every write is attributed to the same writer as with no value`);
  assert.deepEqual(r.totals, baseReport.totals, `value ${JSON.stringify(value)}: the same totals as with no value`);
  assert.ok(r.totals.handed_to_knowledge >= 3, `value ${JSON.stringify(value)}: the hand-off stays on (${JSON.stringify(r.totals)})`);
  assert.equal(find(r, { tool: "newsroom_viz_plan", kind: "evidence", status: "cross_group" }).length, 0, `value ${JSON.stringify(value)}: the claim record is not cross-group`);
  assert.equal(find(r, { tool: "newsroom_viz_lint", kind: "evidence", status: "cross_group" }).length, 0, `value ${JSON.stringify(value)}: the computation record is not cross-group`);
}
check('hand-off: no value of the removed NEWSROOM_GROUP_HANDOFF, "0" included, changes the files or stops the hand-off; none is cross-group');

// 2. on: the same files, byte for byte
const on = await planAndLint({});
assert.deepEqual(snapshot(on.dir), baseFiles, "hand-off on: the same files with the same content");
assert.ok(Object.keys(baseFiles).some((f) => f === "claims.jsonl") && Object.keys(baseFiles).some((f) => f.startsWith("computations/")), "the fixture does write a claim and a computation record");
check("on: claims.jsonl, computation records and every other file are byte-identical");

const rb = reportOf((await planAndLint({ NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_HANDOFF: "0" })).dir); // a leftover "0": the same number of writes as below
// 3. the report: written by the knowledge group, 0 cross-group for these records, the asking tool stays visible
const after = await planAndLint({ NEWSROOM_GROUP_BOUNDARY: "1" });
const ra = reportOf(after.dir);
const evidence = ra.records.filter((r) => r.kind === "evidence");
assert.ok(evidence.length > 0 && evidence.every((r) => r.status === "ok" && r.tool === "knowledge_writer" && r.tool_group === "knowledge"), JSON.stringify(evidence));
assert.ok(evidence.some((r) => r.requested_by === "newsroom_viz_plan" && r.examples.includes("claims.jsonl")), "the claim record: requested by viz_plan, written by the knowledge group");
assert.ok(evidence.some((r) => r.requested_by === "newsroom_viz_lint" && r.examples.some((p) => p.startsWith("computations/"))), "the computation record: requested by viz_lint, written by the knowledge group");
assert.equal(ra.records.filter((r) => r.kind === "evidence" && r.status === "cross_group").length, 0, "0 cross-group evidence writes");
assert.ok(ra.totals.handed_to_knowledge >= 3, JSON.stringify(ra.totals));
assert.equal(ra.totals.writes, rb.totals.writes, "the number of writes is the same");
assert.equal(ra.complete, false);
assert.ok(ra.not_traced.length >= 4, "what is not traced is still listed");
check("both on: the claim record, the computation records and the query rows are written by the knowledge group; 0 cross-group; same write count");

// 5. the query-rows table, and a bad ref is refused by the writer
{
  // #64 step 3: the writer's content check is on by default, so the table must be the rows of a real computation record (made by the program's own plan and lint)
  const story = await planAndLint({ NEWSROOM_GROUP_BOUNDARY: "1" });
  process.env.NEWSROOM_ARTIFACT_DIR = story.dir;
  const computation = walk(join(story.dir, "computations")).sort()[0];
  const tableRef = `runtime/query-rows/${computation.split("/").pop()}`;
  const tableRows = JSON.parse(readFileSync(computation, "utf8")).rows;
  rmSync(join(story.dir, tableRef), { force: true });
  groups.resetBoundaryReport();
  register({ NEWSROOM_GROUP_BOUNDARY: "1" });
  await groups.runInTool("newsroom_viz_render", () => mod.__saveQueryRowsForTest(tableRef, tableRows));
  const rows = find(reportOf(story.dir), { kind: "evidence", requested_by: "newsroom_viz_render" }); // the plan and lint of the same story are in the report too
  assert.ok(rows.length === 1 && rows[0].status === "ok" && rows[0].tool === "knowledge_writer" && rows[0].requested_by === "newsroom_viz_render", JSON.stringify(rows));
  assert.equal(readFileSync(join(story.dir, tableRef), "utf8"), JSON.stringify(tableRows, null, 2) + "\n");
  const writer = (await import(pathToFileURL(join(tree, "runtime/pi/knowledge_writer.mjs")).href)).knowledgeWriter({ writeArtifactIfAbsent: async () => "x", recordClaimArtifact: async () => ({}) });
  assert.throws(() => writer.writeComputation("visualizations/x.json", {}), /KNOWLEDGE_WRITER_REF/);
  assert.throws(() => writer.writeQueryRows("computations/../x.json", []), /KNOWLEDGE_WRITER_REF/);
}
check("query rows: written by the knowledge group; the writer refuses a ref outside its own folders");
console.log(`PASS group hand-off (${results.length} checks)`);
