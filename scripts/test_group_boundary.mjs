// NEWSROOM_GROUP_BOUNDARY=1 (exact value; this switch only reports, NEWSROOM_GROUP_ENFORCE does the refusing): every artifact write made through newsroom.ts is recorded as (initiating tool, its group, artifact
// kind, owning group) in runtime/group-boundary-report.json. It only reports: nothing is refused and nothing else changes.
//
//  1. Switch off (or any value but "report"): no report file, and a write does exactly what it did.
//  2. Ownership: a tool writing its own group's artifact is ok; the pass/publication decision belongs to the agent group alone.
//  3. The three known cross-group writes are flagged, tagged with a plain name: viz_plan records a claim, viz_lint writes a
//     computation record, the query-rows helper writes a computation record. The sites where the model supplies a pass status carry model_supplied_pass.
//  4. A write that cannot be classified is 待查, never counted as fine; the report lists what it cannot see (not_traced).
//
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

// #64 step 1: this file was written for the hand-off off (its case 3 expects the three known cross-group writes to be flagged); the hand-off is now on by default, so the old arms spell it out
const BASE_ENV = { NEWSROOM_GROUP_HANDOFF: "0", NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_INLINE_CLAIM: "1" };
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

// ---- 1. Switch off: no report, same artifacts --------------------------------------------------------------------------------------
let withoutSwitch;
{
  const story = investigation();
  const tools = register();
  const out = await tools.get("newsroom_viz_plan").execute("c", planParams(story.ref));
  assert.ok(out.content[0].text.includes("Claim recorded: VERIFIED"), "the plan call works");
  assert.equal(existsSync(join(story.dir, REPORT)), false, "switch unset: no report file");
  withoutSwitch = Object.fromEntries(walk(story.dir).map((f) => relative(story.dir, f)).sort().map((f) => [f, readFileSync(join(story.dir, f), "utf8")]));
  for (const value of ["report", "true", "on", "REPORT", " 1", "01", "0", ""]) {
    const other = investigation();
    await register({ NEWSROOM_GROUP_BOUNDARY: value }).get("newsroom_viz_plan").execute("c", planParams(other.ref));
    assert.equal(existsSync(join(other.dir, REPORT)), false, `value ${JSON.stringify(value)}: no report file`);
  }
  check("switch off (unset or any value but exactly 1; report and true included): no report file");
}

// ---- 3. On: the three known cross-group writes, from real tool calls ------------------------------------------------------------------
{
  const story = investigation();
  const tools = register({ NEWSROOM_GROUP_BOUNDARY: "1" });
  const out = await tools.get("newsroom_viz_plan").execute("c", planParams(story.ref));
  assert.ok(out.content[0].text.includes("Claim recorded: VERIFIED"), "the plan call still works with the report on");
  const after = Object.fromEntries(walk(story.dir).map((f) => relative(story.dir, f)).filter((f) => f !== REPORT).sort().map((f) => [f, readFileSync(join(story.dir, f), "utf8")]));
  const strip = (text) => text.replace(/"(recorded_at|created_at|timestamp|updated_at)":\s*"[^"]*"/g, "").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "");
  assert.deepEqual(Object.keys(after), Object.keys(withoutSwitch), "the same files are written with the report on");
  for (const file of Object.keys(after)) assert.equal(strip(after[file]), strip(withoutSwitch[file]), `${file}: same content with the report on`);
  const report = reportOf(story.dir);
  const claim = find(report, { tool: "newsroom_viz_plan", kind: "evidence" });
  assert.ok(claim.some((r) => r.status === "cross_group" && r.known === "claim record" && r.examples.includes("claims.jsonl")), "viz_plan records a claim: cross-group");
  assert.ok(find(report, { tool: "newsroom_viz_plan", kind: "visual_spec" }).every((r) => r.status === "ok"), "viz_plan writes its own plan: ok");
  assert.equal(report.mode, "report");
  assert.match(report.summary, new RegExp(`${report.totals.to_check} 待查`), "the summary always shows the 待查 count");
  assert.equal(report.complete, false);
  assert.ok(report.not_traced.length >= 4 && report.not_traced.some((line) => /Rust-side/.test(line)), "the report lists what it cannot see");
  check("viz_plan: the claim record is cross-group (claim record); its own plan is ok; the artifacts written are unchanged");

  const planRef = out.details?.plan_ref ?? out.details?.planRef ?? out.details?.visualization_plan ?? walk(join(story.dir, "visualizations")).map((f) => relative(story.dir, f)).find((f) => /plan.*\.json$/.test(f));
  assert.ok(planRef, "found the recorded plan");
  const lint = await tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef, visualization_plan: planRef, plan: planRef });
  assert.ok(lint, "lint ran");
  const after2 = reportOf(story.dir);
  const computation = find(after2, { tool: "newsroom_viz_lint", kind: "evidence" });
  assert.ok(computation.some((r) => r.status === "cross_group" && r.known === "computation record" && r.examples.some((p) => p.startsWith("computations/"))), "viz_lint writes a computation record: cross-group");
  check("viz_lint: the computation record is cross-group (computation record)");
}

// ---- 3b. The new default (#64 step 1, hand-off on): the claim and its computation go through the knowledge writer, so nothing is cross-group ----------
{
  const story = investigation();
  const tools = register({ NEWSROOM_GROUP_BOUNDARY: "1" });
  delete process.env.NEWSROOM_GROUP_HANDOFF; // unset = the default, on
  const out = await tools.get("newsroom_viz_plan").execute("c", planParams(story.ref));
  assert.ok(out.content[0].text.includes("Claim recorded: VERIFIED"), "the plan call still works with the hand-off on by default");
  const report = reportOf(story.dir);
  assert.equal(report.totals.cross_group, 0, "hand-off on: no write is cross-group");
  assert.equal(report.totals.to_check, 0, "hand-off on: nothing is left to check");
  const written = find(report, { tool: "knowledge_writer", requested_by: "newsroom_viz_plan", kind: "evidence" });
  assert.ok(written.length >= 1 && written.every((r) => r.status === "ok" && r.owner === "knowledge"), "the claim and the computation are written by the knowledge writer, in the owning group");
  assert.ok(written.some((r) => r.examples.includes("claims.jsonl")), "the claim record goes through the knowledge writer");
  assert.ok(find(report, { tool: "newsroom_viz_plan", kind: "visual_spec" }).every((r) => r.status === "ok"), "viz_plan still writes its own plan: ok");
  check("hand-off on (the new default): viz_plan's claim and computation are written by the knowledge writer, none cross-group");
}

// ---- the query-rows helper (newsroom.ts, writeArtifactIfAbsent from a helper) ---------------------------------------------------------
{
  const story = investigation();
  register({ NEWSROOM_GROUP_BOUNDARY: "1" });
  await groups.runInTool("newsroom_viz_lint", () => mod.__writeArtifactIfAbsentForTest("runtime/query-rows/abc.json", { rows: [] }));
  const report = reportOf(story.dir);
  const rows = find(report, { tool: "newsroom_viz_lint", kind: "evidence" });
  assert.ok(rows.length === 1 && rows[0].status === "cross_group" && rows[0].known === "query-rows helper" && rows[0].op === "write_if_absent", JSON.stringify(rows));
  check("query-rows helper: a visual-group tool writing a query-rows table is cross-group (query-rows helper)");
}

// ---- 2 and 4. Ownership, the model-supplied-pass sites, 待查 ----------------------------------------------------------------------------------------
{
  const story = investigation();
  register({ NEWSROOM_GROUP_BOUNDARY: "1" });
  const write = (tool, path) => groups.runInTool(tool, () => mod.__writeArtifactIfAbsentForTest(path, { path }));
  await write("newsroom_update_plan", "plan.json");                              // agent -> project_state (agent): ok
  await write("record_claim", "claims.jsonl");                                    // knowledge -> evidence (knowledge): ok
  await write("newsroom_viz_plan", "visualizations/p.json");                      // visual -> visual_spec (visual): ok
  await write("newsroom_expert_preference_record", "editorial/preferences/p.json");        // visual-side tool writes a pass decision
  await write("newsroom_award_mode_status", "editorial/award-runs/a.json");
  await write("newsroom_infographic_vision_critic", "infographics/vision-critics/c.json");
  await write("newsroom_competition_preflight", "infographics/competition-preflight/p.json");
  await write("newsroom_update_plan", "editorial/award-runs/b.json");             // the agent group may write the decision: ok
  await write("newsroom_viz_plan", "somewhere/else.json");                        // no artifact kind: 待查
  await write("tool_that_is_not_listed", "plan.json");                            // unknown tool: 待查
  await mod.__writeArtifactIfAbsentForTest("plan2.json", {});                      // no initiating tool: 待查
  const report = reportOf(story.dir);
  const one = (where) => { const hit = find(report, where); assert.equal(hit.length, 1, JSON.stringify(where)); return hit[0]; };
  assert.equal(one({ tool: "newsroom_update_plan", kind: "project_state" }).status, "ok");
  assert.equal(one({ tool: "record_claim", kind: "evidence" }).status, "ok");
  assert.equal(one({ tool: "newsroom_viz_plan", kind: "visual_spec" }).status, "ok");
  const verdict = one({ tool: "newsroom_infographic_vision_critic", kind: "pass_decision" });
  assert.equal(verdict.status, "model_quality_verdict", "the vision critic's record is its own category, not a cross-group violation");
  assert.match(verdict.reason, /publication decision is computed by the program/);
  for (const tool of ["newsroom_expert_preference_record", "newsroom_award_mode_status"]) {
    const record = one({ tool, kind: "pass_decision" });
    assert.equal(record.status, "cross_group", tool);
    assert.equal(record.model_supplied_pass, true, `${tool} is a model-supplied-pass site`);
  }
  const preflight = one({ tool: "newsroom_competition_preflight", kind: "pass_decision" });
  assert.equal(preflight.status, "cross_group", "newsroom_competition_preflight writes a pass decision from outside the agent group");
  assert.equal(preflight.model_supplied_pass, undefined, "newsroom_competition_preflight carries no model_supplied_pass tag (the program computes its pass)");
  assert.equal(one({ tool: "newsroom_update_plan", kind: "pass_decision" }).status, "ok", "the agent group owns the decision");
  assert.deepEqual([one({ tool: "newsroom_viz_plan", kind: null }).status, one({ tool: "newsroom_viz_plan", kind: null }).reason], ["待查", "path matches no artifact kind"]);
  assert.deepEqual([one({ tool: "tool_that_is_not_listed" }).status, one({ tool: "tool_that_is_not_listed" }).reason], ["待查", "tool is not in groups.json"]);
  assert.deepEqual([one({ tool: null }).status, one({ tool: null }).reason], ["待查", "no initiating tool"]);
  assert.deepEqual(report.totals, { writes: 11, ok: 4, cross_group: 3, to_check: 3, model_quality_verdict: 1 });
  assert.equal(report.totals.ok + report.totals.cross_group + report.totals.to_check + report.totals.model_quality_verdict, report.totals.writes, "every write is counted once");
  assert.match(report.summary, /3 待查/, "the summary names the 待查 count");
  assert.doesNotMatch(report.summary, /0 violation|通过|pass(ed)?\b/i, "with 待查 above zero the summary never says 0 violations or passed");
  check("ownership: own-group writes ok, the agent group may write the pass decision, the other three may not (no right to write it)");
  check("model-supplied-pass sites (newsroom_expert_preference_record, newsroom_award_mode_status) are flagged cross-group with model_supplied_pass; the vision critic's record is listed as model_quality_verdict with its reason (outside the cross-group count); newsroom_competition_preflight is flagged without the tag");
  check("unclassifiable writes (no tool, unlisted tool, unknown path) are 待查 and counted apart, never ok");
}

// ---- reads are not writes (3.10) ------------------------------------------------------------------------------------------------------
{
  const story = investigation();
  register({ NEWSROOM_GROUP_BOUNDARY: "1" });
  writeFileSync(join(story.dir, "claims.jsonl"), "");
  await groups.runInTool("newsroom_viz_lint", () => mod.verifiedClaimIds());
  await groups.runInTool("newsroom_viz_lint", () => mod.verifiedClaimRecords());
  assert.equal(existsSync(join(story.dir, REPORT)), false, "a visual-group tool reading the claim ledger records nothing");
  check("reads are not reported: a visual-group tool reading claims.jsonl leaves no record and no report file");
}

// ---- it never refuses, never throws, and survives an unwritable report ----------------------------------------------------------------
{
  const story = investigation();
  register({ NEWSROOM_GROUP_BOUNDARY: "1" });
  mkdirSync(join(story.dir, REPORT), { recursive: true }); // a directory where the report file should go
  await groups.runInTool("newsroom_viz_lint", () => mod.__writeArtifactIfAbsentForTest("claims.jsonl", { ok: true }));
  assert.ok(existsSync(join(story.dir, "claims.jsonl")), "the write itself still happened when the report could not be written");
  check("the report never refuses or throws: an unwritable report file leaves the write untouched");
}
{ // A second process-level restart keeps the counts: the report file is read back.
  const story = investigation();
  register({ NEWSROOM_GROUP_BOUNDARY: "1" });
  await groups.runInTool("record_claim", () => mod.__writeArtifactIfAbsentForTest("claims.jsonl", { n: 1 }));
  groups.resetBoundaryReport();
  await groups.runInTool("record_claim", () => mod.__writeArtifactIfAbsentForTest("claims2.jsonl", { n: 2 }));
  const report = reportOf(story.dir);
  assert.equal(report.totals.writes, 2, "a new process adds to the earlier counts");
  check("the report accumulates across process restarts (read back from the file)");
}

for (const name of results) console.log(`  ok  ${name}`);
console.log(`group boundary: PASS (${results.length} checks)`);
process.exit(0);
