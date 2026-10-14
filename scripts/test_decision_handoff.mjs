#!/usr/bin/env node
// NEWSROOM_GROUP_HANDOFF=1 also hands the three decision records (expert preference, award status, competition preflight) to the agent group's
// writer. The files stay byte-identical. A record whose status the model supplies is never counted as fine, even when the owning group wrote it.
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


const DECISIONS = [["newsroom_expert_preference_record", "editorial/preferences/p.json"], ["newsroom_award_mode_status", "editorial/award-runs/a.json"], ["newsroom_competition_preflight", "infographics/competition-preflight/c.json"]];
const where = (report, tool) => report.records.filter((r) => (r.requested_by ?? r.tool) === tool);
async function writeAll(env) {
  register(env);
  const { dir } = investigation();
  for (const [tool, ref] of DECISIONS) await groups.runInTool(tool, () => mod.__saveDecisionForTest(ref, { tool }));
  return { dir, report: reportOf(dir) };
}
const hashes = ["a1b2c3d4e5f60718", "b1b2c3d4e5f60718", "c1b2c3d4e5f60718"];
const pref = { baseline_ref: "b.png", candidate_ref: "c.png", reviews: hashes.map((reviewer_id_hash) => ({ reviewer_id_hash, qualified: true, preference: "candidate" })) };

// 1. the defect: each tool writing its record itself (hand-off turned off with "0") is cross-group
{
  const { report } = await writeAll({ NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_HANDOFF: "0" });
  for (const [tool] of DECISIONS) {
    const rec = where(report, tool);
    assert.equal(rec.length, 1, tool);
    assert.equal(rec[0].status, "cross_group", `${tool} writing its own decision record is cross-group`);
    assert.equal(rec[0].requested_by, undefined);
  }
}
check("with the hand-off turned off (=0), each of the three tools writing its decision record itself is cross-group");

// 2. hand-off on, review switch off: the model-supplied pass is flagged and not counted as ok; the preflight (program-computed) is ok
{
  const { report } = await writeAll({ NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_HANDOFF: "1" });
  for (const tool of ["newsroom_expert_preference_record", "newsroom_award_mode_status"]) {
    const rec = where(report, tool)[0];
    assert.equal(rec.tool, "decision_writer");
    assert.equal(rec.status, "model_supplied_pass", `${tool}: handing the file over must not launder a model-supplied pass`);
    assert.equal(rec.model_supplied_pass, true);
    assert.notEqual(rec.status, "ok");
  }
  const pf = where(report, "newsroom_competition_preflight")[0];
  assert.deepEqual([pf.tool, pf.tool_group, pf.status, pf.requested_by], ["decision_writer", "agent", "ok", "newsroom_competition_preflight"]);
  assert.equal(report.totals.model_supplied_pass, 2);
  assert.equal(report.totals.cross_group, 0);
  assert.equal(report.totals.ok + report.totals.model_supplied_pass, report.totals.writes);
  assert.match(report.summary, /2 with a model-supplied pass/);
}
check("hand-off on, review switch off: preference and award records are listed as model_supplied_pass (not ok); the preflight is ok");

// 2b. #64 step 1: with nothing set the hand-off is on (same as =1)
{
  const { report } = await writeAll({ NEWSROOM_GROUP_BOUNDARY: "1" });
  for (const [tool] of DECISIONS) assert.equal(where(report, tool)[0].tool, "decision_writer", `${tool}: the default hands the record to decision_writer`);
  assert.equal(report.totals.cross_group, 0);
}
check("default (nothing set): the three decision records go through decision_writer");

// 3. both on: the status is program-computed, so the records count as ok and are tagged
{
  const { report } = await writeAll({ NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_REVIEW_FROM_RECORDS: "1" });
  for (const tool of ["newsroom_expert_preference_record", "newsroom_award_mode_status"]) {
    const rec = where(report, tool)[0];
    assert.deepEqual([rec.status, rec.status_computed_by_program, rec.model_supplied_pass], ["ok", true, undefined], tool);
  }
  assert.equal(report.totals.cross_group, 0);
  assert.equal(report.totals.model_supplied_pass, undefined);
}
check("hand-off and review switch on: program-computed status, records ok and tagged status_computed_by_program");

// 4. a ref outside the three folders is refused by the writer
{
  register({ NEWSROOM_GROUP_HANDOFF: "1" });
  investigation();
  for (const ref of ["claims.jsonl", "computations/x.json", "editorial/discovery/x.json", "editorial/preferences/../x.json", "infographics/plan-rejections/x.json"]) {
    assert.throws(() => mod.__saveDecisionForTest(ref, {}), /DECISION_WRITER_REF/, ref);
  }
}
check("the decision writer refuses refs outside the three decision folders (the vision critic is not handed over)");

// 5. the real preference tool: same file, byte for byte, with or without the hand-off
{
  const out = [];
  for (const env of [{ NEWSROOM_GROUP_HANDOFF: "0" }, {}, { NEWSROOM_GROUP_HANDOFF: "1" }]) {
    const tools = register(env);
    const { dir } = investigation();
    const r = await tools.get("newsroom_expert_preference_record").execute("t", pref);
    const rel = /Artifact: (\S+)/.exec(r.content[0].text)[1];
    out.push([rel, readFileSync(join(dir, rel), "utf8"), r.content[0].text]);
  }
  assert.deepEqual(out[0], out[1]);
  assert.deepEqual(out[1], out[2]);
}
check("the preference tool's file and result are byte-identical with the hand-off off (=0), unset (default on) or on");

// 6. the vision critic's record stays model_quality_verdict even with every switch on
{
  register({ NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_REVIEW_FROM_RECORDS: "1" });
  const { dir } = investigation();
  await groups.runInTool("newsroom_infographic_vision_critic", () => mod.__writeArtifactIfAbsentForTest("infographics/vision-critics/c.json", {}));
  const rec = reportOf(dir).records[0];
  assert.deepEqual([rec.status, rec.tool], ["model_quality_verdict", "newsroom_infographic_vision_critic"]);
}
check("the vision critic's record stays listed apart as model_quality_verdict");

// 7. the real call sites: the award-status and preflight tools reach the writer too. Running them needs real page manifests and lints, so
// this reads their registrations: each of the three tools saves its record with saveDecision and has no direct artifact write of its own.
{
  const source = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  const blockOf = (tool) => {
    const start = source.indexOf(`name: "${tool}"`);
    assert.ok(start > 0, `${tool} is registered`);
    const next = source.indexOf("registerScopedTool(pi, {", start);
    return source.slice(start, next < 0 ? undefined : next);
  };
  for (const [tool, folder] of [["newsroom_expert_preference_record", "editorial/preferences/"], ["newsroom_award_mode_status", "editorial/award-runs/"], ["newsroom_competition_preflight", "infographics/competition-preflight/"]]) {
    const block = blockOf(tool);
    assert.equal((block.match(/\bsaveDecision\(/g) ?? []).length, 1, `${tool} saves its record once, through saveDecision`);
    assert.ok(block.includes(folder), `${tool} writes under ${folder}`);
    assert.ok(!/\bwriteArtifactIfAbsent\(/.test(block), `${tool} must not write an artifact itself`);
  }
  // No other tool writes into the three decision folders by itself.
  const direct = [...source.matchAll(/writeArtifactIfAbsent\(([^)]*)\)/g)].filter((m) => /editorial\/(preferences|award-runs)\/|competition-preflight\//.test(m[0] + source.slice(Math.max(0, m.index - 200), m.index)) && /`(editorial\/(preferences|award-runs)|infographics\/competition-preflight)\//.test(source.slice(Math.max(0, m.index - 200), m.index)));
  assert.deepEqual(direct.map((m) => m[0]), [], "nothing else writes a decision record directly");
}
check("the award-status and preflight tools (and the preference tool) save their records only through the decision writer's saveDecision");

// 8. one run with both writers: the hand-off counts of the two groups are separate and never added together
{
  const tools = register({ NEWSROOM_GROUP_BOUNDARY: "1", NEWSROOM_GROUP_HANDOFF: "1", NEWSROOM_GROUP_REVIEW_FROM_RECORDS: "1" });
  const { dir } = investigation();
  for (const n of [1, 2, 3]) await groups.runInTool("newsroom_viz_render", () => mod.__saveQueryRowsForTest(`runtime/query-rows/mix-${n}.json`, [{ a: n }]));
  for (const [tool, ref] of DECISIONS) await groups.runInTool(tool, () => mod.__saveDecisionForTest(ref, { tool }));
  const report = reportOf(dir);
  // Records are aggregated by tool and kind, each with a count.
  const written = (tool) => report.records.filter((r) => r.tool === tool).reduce((sum, r) => sum + (r.count ?? 0), 0);
  assert.equal(written("knowledge_writer"), 3);
  assert.equal(written("decision_writer"), 3);
  assert.equal(report.totals.handed_to_knowledge, 3, "three knowledge hand-offs, not six");
  assert.equal(report.totals.handed_to_agent, 3, "three decision hand-offs");
  assert.equal(report.totals.writes, 6);
  assert.equal(report.totals.cross_group, 0);
  void tools;
}
check("a run with three knowledge and three decision hand-offs reports 3 and 3, never 6 for either group");

console.log(`decision hand-off: PASS (${results.length} checks)`);
for (const name of results) console.log(`  - ${name}`);
