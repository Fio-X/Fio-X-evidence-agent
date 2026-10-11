#!/usr/bin/env node
// NEWSROOM_MODEL_PASS_SELFREPORT=1 (K98, exact "1", default off): a pass, score or qualification the model reports is recorded as self_reported and never counts;
// only records the program saved itself do. Covers the expert-preference tool, the award-status tool and the image-aware (vision) critic record.
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
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_") || name.startsWith("NEWSROOM_GROUP_") || name === "NEWSROOM_MODEL_PASS_SELFREPORT") delete process.env[name];
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
  for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_GROUP_") || key === "NEWSROOM_MODEL_PASS_SELFREPORT") delete process.env[key];
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

const ON = { NEWSROOM_MODEL_PASS_SELFREPORT: "1" };
// 1. off (and any value but exact "1"): behaves as before, record shape unchanged
for (const value of [undefined, "true", "on", "0", "", " 1", "01"]) {
  const tools = register(value === undefined ? {} : { NEWSROOM_MODEL_PASS_SELFREPORT: value });
  const { dir } = investigation();
  const r = await run(tools, pref());
  assert.match(textOf(r), /^PASS: expert pairwise preference/, `off (${value}) keeps today's behaviour`);
  const saved = savedPreference(dir, textOf(r));
  assert.ok(!("status_source" in saved) && !("model_reported_reviews" in saved), "off: record shape unchanged");
}
{
  const input = { discovery_ref: "d", concepts_ref: "c", asset_plan_ref: "a", novelty_ref: "n", page_ref: "p", preference_status: "PASS", metrics: { concepts_generated: 10, concepts_killed: 6, prototype_count: 3, raster_revision_count: 2, human_review_count: 9 } };
  assert.equal(art.summarizeAwardMode(input).status, "PASS", "off: award status as today");
}
check("off: model reviews and preference_status count as today, record shape unchanged (7 non-1 values)");

// 2. on: a model-supplied qualified:true / passed review gives no PASS, and is recorded as self_reported
{
  const tools = register(ON);
  const { dir } = investigation();
  const r = await run(tools, pref());
  assert.doesNotMatch(textOf(r), /^PASS/, "model-supplied qualified:true reviews must not give PASS");
  const saved = savedPreference(dir, textOf(r));
  assert.equal(saved.status, "PENDING");
  assert.equal(saved.counts.total, 0);
  assert.equal(saved.model_reported_reviews.counted, false);
  assert.equal(saved.model_reported_reviews.self_reported, true);
  assert.equal(saved.model_reported_reviews.reviews.length, 3);
  assert.ok(saved.model_reported_reviews.reviews.every((review) => review.self_reported === true), "every model review marked self_reported");
}
check("on: model qualified:true reviews are recorded self_reported, not counted, status PENDING");

// 3. on: records the program saved itself still count
{
  const tools = register(ON);
  const { dir } = investigation();
  saveReviews(dir, hashes.map((_, i) => programReview(i)));
  const saved = savedPreference(dir, textOf(await run(tools, pref({ reviews: [] }))));
  assert.equal(saved.status, "PASS");
  assert.equal(saved.status_source, "program_review_records");
}
check("on: intact program-saved review records still count (the only way to PASS)");

// 4. award status: the model's preference_status is self_reported and ignored; no program record shows 缺程序证明, never PASS
{
  const input = { discovery_ref: "d", concepts_ref: "c", asset_plan_ref: "a", novelty_ref: "n", page_ref: "p", preference_status: "PASS", metrics: { concepts_generated: 10, concepts_killed: 6, prototype_count: 3, raster_revision_count: 2, human_review_count: 9 } };
  process.env.NEWSROOM_MODEL_PASS_SELFREPORT = "1";
  const none = art.summarizeAwardMode(input, { programPreference: null });
  assert.notEqual(none.status, "PASS");
  assert.equal(none.status_display, "缺程序证明");
  assert.equal(none.claimed.self_reported, true);
  assert.equal(none.claimed.preference_status, "PASS");
  const real = art.summarizeAwardMode(input, { programPreference: { status: "PASS", review_count: 3 } });
  assert.equal(real.status, "PASS", "a program record still gives PASS");
  delete process.env.NEWSROOM_MODEL_PASS_SELFREPORT;
}
check("on: award status ignores the model's PASS (self_reported), shows 缺程序证明; a program record still passes");

// 5. the award tool end to end: preference_ref is the model's own record (no program source) -> not PASS
{
  const tools = register(ON);
  const { dir } = investigation();
  mkdirSync(join(dir, "editorial/preferences"), { recursive: true });
  const forged = { kind: "expert_pairwise_preference", status: "PASS", counts: { total: 9 } };
  writeFileSync(join(dir, "editorial/preferences/forged.json"), JSON.stringify({ ...forged, content_hash: art.artDirectionHash(forged) }));
  // the tool reads discovery/concepts/page refs first, which this fixture does not build; the program side is the pure loader contract
  const result = art.summarizeAwardMode({ discovery_ref: "d", concepts_ref: "c", asset_plan_ref: "a", novelty_ref: "n", page_ref: "p", preference_ref: "editorial/preferences/forged.json", preference_status: "PASS", metrics: { concepts_generated: 10, concepts_killed: 6, prototype_count: 3, raster_revision_count: 2, human_review_count: 9 } }, { programPreference: null });
  assert.notEqual(result.status, "PASS");
  assert.ok(tools.has("newsroom_award_mode_status"));
}
check("on: a preference record without status_source program_review_records gives no PASS");

// 6. the vision critic record is marked self_reported only when on (gates unchanged, inventoried in the report)
{
  const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.match(src, /modelPassSelfReportEnabled\(\) \? \{ self_reported: true, passed_source: "model" \} : \{\}/);
}
check("vision critic record: self_reported + passed_source model added only under the switch");

// 7. tool definitions are identical with the switch on or off
{
  const defs = (env) => JSON.stringify([...register(env)].map(([name, tool]) => [name, tool.description, tool.parameters]));
  assert.equal(defs(ON), defs({}));
}
check("tool definitions identical with the switch on");

// 8. mutant guard: the pure function must really depend on program records when on (restoring "trust the model" would turn 2 and 4 red)
{
  process.env.NEWSROOM_MODEL_PASS_SELFREPORT = "1";
  const trusted = art.evaluateExpertPreference(pref());
  assert.equal(trusted.status, "PASS", "evaluateExpertPreference with no program records still counts the model list: the caller must pass programReviews");
  const guarded = art.evaluateExpertPreference(pref(), { programReviews: [] });
  assert.equal(guarded.status, "PENDING");
  delete process.env.NEWSROOM_MODEL_PASS_SELFREPORT;
  const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.equal((src.match(/programRecordsMode\(\)\s*\n?\s*\?/g) ?? []).length, 2, "both tools pick program mode through programRecordsMode()");
}
check("callers pass program records through programRecordsMode() in both tools");

console.log(`model-pass-selfreport: PASS (${results.length} checks)`);
for (const name of results) console.log(`  - ${name}`);
