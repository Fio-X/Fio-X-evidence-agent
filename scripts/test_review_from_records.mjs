#!/usr/bin/env node
// NEWSROOM_GROUP_REVIEW_FROM_RECORDS=1 (exact "1", default off): a review pass counts only from review records the program saved itself.
// Reviews the model reports in a tool call are kept visible but never counted; no record means 待评审 (PENDING), never PASS.
// Loads a type-stripped copy of runtime/pi/newsroom.ts. No provider, no network.
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

const BASE_ENV = { NEWSROOM_HERO_VALUE_GATE: "0", NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_INLINE_CLAIM: "1" };
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

const art = await import(pathToFileURL(join(tree, "runtime/pi/art_direction.mjs")).href);
const hashes = ["a1b2c3d4e5f60718", "b1b2c3d4e5f60718", "c1b2c3d4e5f60718"];
const modelReviews = hashes.map((reviewer_id_hash) => ({ reviewer_id_hash, qualified: true, preference: "candidate" }));
const pref = (extra = {}) => ({ baseline_ref: "baseline.png", candidate_ref: "candidate.png", reviews: modelReviews, ...extra });
const run = async (tools, params) => (await tools.get("newsroom_expert_preference_record").execute("t", params));
const savedPreference = (dir, text) => JSON.parse(readFileSync(join(dir, /Artifact: (\S+)/.exec(text)[1]), "utf8"));
const textOf = (r) => r.content[0].text;
const programReview = (i, over = {}) => {
  const body = { schema_version: "0.1.0", kind: "program_saved_review", saved_by: "program", baseline_ref: "baseline.png", candidate_ref: "candidate.png", reviewer_id_hash: hashes[i], preference: "candidate", ...over };
  return { ...body, content_hash: art.artDirectionHash(body) };
};
const saveReviews = (dir, records) => {
  mkdirSync(join(dir, "editorial/human-reviews"), { recursive: true });
  records.forEach((rec, i) => writeFileSync(join(dir, `editorial/human-reviews/r${i}.json`), JSON.stringify(rec)));
};

// 1. switch off (and any value but exact "1"): the model's reviews still count, as today
for (const value of [undefined, "true", "on", "0", "", " 1", "01"]) {
  const tools = register(value === undefined ? {} : { NEWSROOM_GROUP_REVIEW_FROM_RECORDS: value });
  const { dir } = investigation();
  const r = await run(tools, pref());
  assert.match(textOf(r), /^PASS: expert pairwise preference/, `off (${value}) must keep today's behaviour`);
  const saved = savedPreference(dir, textOf(r));
  assert.equal(saved.status, "PASS");
  assert.ok(!("status_source" in saved) && !("status_display" in saved), "off: record shape unchanged");
}
check("off: model reviews count as today, record shape unchanged");

// 2. on: the defect (a model-supplied qualified:true review) no longer gives PASS
{
  const tools = register({ NEWSROOM_GROUP_REVIEW_FROM_RECORDS: "1" });
  const { dir } = investigation();
  const r = await run(tools, pref());
  assert.doesNotMatch(textOf(r), /^PASS/, "model-supplied qualified:true reviews must not give PASS");
  assert.match(textOf(r), /^PENDING \(待评审\): expert pairwise preference/);
  const saved = savedPreference(dir, textOf(r));
  assert.equal(saved.status, "PENDING");
  assert.equal(saved.status_display, "待评审");
  assert.equal(saved.counts.total, 0);
  assert.deepEqual(saved.model_reported_reviews, { count: 3, counted: false });
}
check("on: model-supplied qualified:true reviews give 待评审, not PASS");

// 3. on: records the program saved itself do count (and only those that verify)
{
  const tools = register({ NEWSROOM_GROUP_REVIEW_FROM_RECORDS: "1" });
  const { dir } = investigation();
  saveReviews(dir, hashes.map((_, i) => programReview(i)));
  const r = await run(tools, pref({ reviews: [] }));
  const saved = savedPreference(dir, textOf(r));
  assert.equal(saved.status, "PASS");
  assert.equal(saved.status_source, "program_review_records");
  assert.equal(saved.counts.total, 3);
  assert.equal(saved.review_record_refs.length, 3);
  // a tampered record, a record for another pair, and a record not marked as saved by the program do not count
  const bad = [{ ...programReview(0), preference: "baseline" }, programReview(1, { baseline_ref: "other.png" }), programReview(2, { saved_by: "model" })];
  saveReviews(dir, bad);
  const r2 = await run(tools, pref());
  const saved2 = savedPreference(dir, textOf(r2));
  assert.equal(saved2.status, "PENDING");
  assert.equal(saved2.counts.total, 0);
}
check("on: only intact program-saved records count; tampered / foreign / unmarked records do not");

// 4. award status: the model's preference_status and human_review_count are ignored
{
  const input = { discovery_ref: "d", concepts_ref: "c", asset_plan_ref: "a", novelty_ref: "n", page_ref: "p", preference_status: "PASS",
    metrics: { concepts_generated: 10, concepts_killed: 6, prototype_count: 3, raster_revision_count: 2, human_review_count: 9 } };
  const old = art.summarizeAwardMode(input);
  assert.equal(old.status, "PASS", "off: the model's PASS still decides, as today");
  const none = art.summarizeAwardMode(input, { programPreference: null });
  assert.notEqual(none.status, "PASS", "no program record: a model preference_status:PASS must not give PASS");
  assert.equal(none.status, "READY_FOR_HUMAN");
  assert.equal(none.preference_status, "PENDING");
  assert.equal(none.status_display, "待评审");
  assert.equal(none.metrics.human_review_count, 0);
  assert.equal(none.claim_mismatch, true);
  assert.deepEqual(none.claimed, { preference_status: "PASS", human_review_count: 9 });
  const real = art.summarizeAwardMode({ ...input, metrics: { ...input.metrics, human_review_count: 3 } }, { programPreference: { status: "PASS", review_count: 3 } });
  assert.equal(real.status, "PASS");
  assert.equal(real.claim_mismatch, false);
}
check("on: award status ignores the model's preference_status and review count, records any mismatch");

// 5. tool definitions (names, descriptions, parameters) are identical with the switches on or off
{
  const defs = (env) => JSON.stringify([...register(env)].map(([name, tool]) => [name, tool.description, tool.parameters]));
  assert.equal(defs({ NEWSROOM_GROUP_REVIEW_FROM_RECORDS: "1", NEWSROOM_GROUP_HANDOFF: "1" }), defs({}));
}
check("tool definitions are identical with the review and hand-off switches on");

// 6. boundary report: still listed as cross-group (not counted as fixed), but no longer tagged as a model-supplied pass
for (const [value, tag] of [[undefined, "model_supplied_pass"], ["1", "status_computed_by_program"]]) {
  const tools = register({ NEWSROOM_GROUP_BOUNDARY: "1", ...(value ? { NEWSROOM_GROUP_REVIEW_FROM_RECORDS: value } : {}) });
  const { dir } = investigation();
  await run(tools, pref());
  const rec = reportOf(dir).records.find((r) => r.tool === "newsroom_expert_preference_record");
  assert.equal(rec.status, "cross_group");
  assert.equal(rec[tag], true, `${tag} on the preference record (switch ${value ?? "off"})`);
  assert.equal(rec[tag === "model_supplied_pass" ? "status_computed_by_program" : "model_supplied_pass"], undefined);
}
check("boundary report: the preference record stays cross-group; tagged model_supplied_pass when off, status_computed_by_program when on");

console.log(`review-from-records: PASS (${results.length} checks)`);
for (const name of results) console.log(`  - ${name}`);
