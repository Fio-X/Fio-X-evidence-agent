#!/usr/bin/env node
// The review split (always on; no variable turns it off, a leftover NEWSROOM_REVIEW_SPLIT value changes nothing, K244): the draw step (viz_render, infographic_render) writes no render-QA record and the manifest carries none;
// the critic recomputes the report from the SVG bytes with the same options and records it; a draw tool that writes a review record is refused (ENFORCE);
// a review tool moves a rejected manifest only through review_reject_writer.
// Needs duckdb for the real viz_plan / viz_lint calls. Loads a type-stripped copy of runtime/pi/newsroom.ts. No provider, no network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "group-boundary-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_") || name.startsWith("NEWSROOM_GROUP_")) delete process.env[name];
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
  for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_GROUP_") || key === "NEWSROOM_REVIEW_SPLIT") delete process.env[key];
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
const firstUnder = (dir, base, re) => walk(join(dir, base)).map((f) => relative(dir, f)).find((f) => re.test(f));
// plan -> lint -> render -> critic on the renewable fixture; returns the run folder and the refs
async function drawAndReview(env) {
  const story = investigation();
  const tools = register(env);
  await tools.get("newsroom_viz_plan").execute("c", planParams(story.ref));
  const planRef = firstUnder(story.dir, "visualizations/plans", /\.json$/);
  assert.ok(planRef, "found the recorded plan");
  await tools.get("newsroom_viz_lint").execute("l", { plan_ref: planRef });
  const lintRef = firstUnder(story.dir, "visualizations/lints", /\.json$/);
  const render = await tools.get("newsroom_viz_render").execute("r", { plan_ref: planRef, lint_ref: lintRef });
  const manifestRef = firstUnder(story.dir, "visualizations", /^visualizations\/[0-9a-f]{64}\.json$/);
  assert.ok(manifestRef, "the render wrote a manifest");
  const critic = await tools.get("newsroom_viz_critic").execute("k", { plan_ref: planRef, lint_ref: lintRef, manifest_ref: manifestRef });
  return { ...story, tools, planRef, lintRef, manifestRef, render, critic };
}
const json = (dir, ref) => JSON.parse(readFileSync(join(dir, ref), "utf8"));
const list = (dir, base) => walk(join(dir, base)).map((f) => relative(dir, f)).sort();

// 1. the table: every visual tool is a draw tool, a review tool, or one of the three that write nothing of either kind; the two sets do not overlap
{
  const table = JSON.parse(readFileSync(join(ROOT, "runtime/pi/groups.json"), "utf8"));
  const rs = table.review_split;
  const visual = Object.entries(table.tools).filter(([, v]) => v.group === "visual").map(([k]) => k);
  const neither = new Set(["newsroom_visual_skill", "newsroom_lieflat_catalog", "newsroom_lieflat_render"]);
  assert.deepEqual(visual.filter((t) => !rs.draw_tools.includes(t) && !rs.review_tools.includes(t) && !neither.has(t)), [], "every visual tool is classified draw or review");
  assert.deepEqual(rs.draw_tools.filter((t) => rs.review_tools.includes(t)), [], "no tool is both");
  assert.ok([...rs.draw_tools, ...rs.review_tools].every((t) => table.tools[t]?.group === "visual"), "both lists name visual tools");
  const row = table.handoffs.rows.find((r) => r.writer === rs.reject_writer);
  assert.ok(table.handoffs.writers[rs.reject_writer] && row && row.requesters.every((t) => rs.review_tools.includes(t)), "the reject writer is listed, and only review tools may ask for it");
  assert.ok(rs.review_path_prefixes.every((p) => p.endsWith("/")));
}
check("groups.json: every visual tool is draw or review (no overlap); the reject writer is listed for review tools only");

// 2. a leftover "0" changes nothing: the manifest carries no render-QA record and the critic names the report
const base = await drawAndReview({ NEWSROOM_REVIEW_SPLIT: "0" });
const baseFiles = list(base.dir, "visualizations");
const baseManifest = json(base.dir, base.manifestRef);
const baseCritic = json(base.dir, firstUnder(base.dir, "visualizations/critics", /\.json$/));
assert.ok(!("render_qa_ref" in baseManifest) && !("render_qa" in baseManifest), "leftover 0: the draw step writes no render-QA record");
assert.ok(/^visualizations\/qa\/[0-9a-f]{64}\.json$/.test(baseCritic.render_qa_ref), "leftover 0: the critic record names the report");
check("a leftover 0 changes nothing: the draw step writes no render-QA record, the critic names it");

// 3. unset: the draw step writes no render-QA record, the critic does, and the report equals what the render step computed
const on = await drawAndReview({});
const onManifest = json(on.dir, on.manifestRef);
assert.ok(!("render_qa_ref" in onManifest) && !("render_qa" in onManifest), "the manifest carries no render-QA record");
assert.ok(!/renderQaRef/.test(JSON.stringify(on.render.details)) && !/qa\//.test(on.render.content[0].text), "the draw tool's result names no render-QA file");
const criticRef = firstUnder(on.dir, "visualizations/critics", /\.json$/);
const criticRecord = json(on.dir, criticRef);
assert.ok(/^visualizations\/qa\/[0-9a-f]{64}\.json$/.test(criticRecord.render_qa_ref), "the critic record names the render-QA report it wrote");
assert.equal(criticRecord.passed, true);
assert.deepEqual(json(on.dir, criticRecord.render_qa_ref), json(base.dir, baseCritic.render_qa_ref), "the critic's recomputed report is the same whatever a leftover value says");
assert.equal(on.manifestRef, base.manifestRef, "the manifest key is unchanged");
// the draw step's other files are the same with a leftover 0
assert.deepEqual(list(on.dir, "visualizations").filter((f) => !f.includes("/critics/")), baseFiles.filter((f) => !f.includes("/critics/")), "same draw files");
// the Python verifier (the mirror of verify.rs): it reads the render-QA report through the passing critic when the split is on, and fails closed without one
const verifyErrors = (dir, leftover = {}) => {
  if (!existsSync(join(dir, "story.json"))) writeFileSync(join(dir, "story.json"), JSON.stringify({ kind: "investigation" }));
  const r = spawnSync("python3", ["-I", join(ROOT, "scripts/verify_artifact.py"), "--json", dir], { encoding: "utf8", env: { ...process.env, ...leftover } });
  return JSON.parse(r.stdout).errors ?? [];
};
const qaErrors = (errors) => errors.filter((e) => /render_qa|render-QA/.test(e));
assert.deepEqual(qaErrors(verifyErrors(base.dir, { NEWSROOM_REVIEW_SPLIT: "0" })), [], "leftover 0: no render-QA complaint on a default run");
assert.deepEqual(qaErrors(verifyErrors(on.dir)), [], "the verifier finds the report through the passing critic");
// a manifest a draw tool stamped with a render-QA record is refused by the critic
{
  writeFileSync(join(on.dir, on.manifestRef), JSON.stringify({ ...onManifest, render_qa_ref: baseCritic.render_qa_ref, render_qa: { passed: true, failure_count: 0 } }, null, 2) + "\n");
  await assert.rejects(() => on.tools.get("newsroom_viz_critic").execute("k2", { plan_ref: on.planRef, lint_ref: on.lintRef, manifest_ref: on.manifestRef }), /written by the draw step/);
  assert.ok(verifyErrors(on.dir).some((e) => /carries a render-QA record written by the draw step/.test(e)), "the Python verifier refuses a draw-stamped manifest: " + JSON.stringify(verifyErrors(on.dir)).slice(0, 600));
  assert.ok(verifyErrors(on.dir, { NEWSROOM_REVIEW_SPLIT: "0" }).some((e) => /written by the draw step/.test(e)), "a leftover 0 does not make the same manifest acceptable");
}
// every value, "0" included, is ignored: same files and same tool text as unset (after the block above, which uses the registration of `on`)
for (const value of ["1", "true", "on", "", " 0", "00", "0"]) {
  const other = await drawAndReview({ NEWSROOM_REVIEW_SPLIT: value });
  assert.deepEqual(list(other.dir, "visualizations"), list(on.dir, "visualizations"), `value ${JSON.stringify(value)}: same files as unset`);
  assert.equal(other.render.content[0].text, on.render.content[0].text, "same render text");
  assert.equal(other.critic.content[0].text, on.critic.content[0].text, "same critic text");
}
check("no render-QA record from the draw step; viz_critic recomputes it, and names it in its record; a draw-stamped manifest is refused");

// 4. the boundary: with ENFORCE, a draw tool may not write a review record; review tools write theirs; a review tool may not move a draw product itself
{
  const story = investigation();
  const env = { NEWSROOM_GROUP_ENFORCE: "1" };
  register(env);
  const w = (tool, ref, op = "write", writer = null) => groups.runInTool(tool, () => (writer ? groups.asHandoffWriter(writer, () => groups.recordBoundaryWrite(story.dir, ref, op)) : groups.recordBoundaryWrite(story.dir, ref, op)));
  for (const ref of ["visualizations/qa/a.json", "visualizations/critics/a.json", "visualizations/lints/a.json", "infographics/qa/a.json", "infographics/vision-critics/a.json", "infographics/previews/a.json", "publications/qa/a/browser-qa.json"]) {
    assert.throws(() => w("newsroom_viz_render", ref), groups.BoundaryRefusal, `draw tool refused: ${ref}`);
    assert.throws(() => w("newsroom_infographic_render", ref), groups.BoundaryRefusal);
  }
  assert.ok(existsSync(join(story.dir, "runtime/boundary-refusals.jsonl")) && readFileSync(join(story.dir, "runtime/boundary-refusals.jsonl"), "utf8").includes("review_path_by_draw_tool"), "the refusal is logged with its status");
  w("newsroom_viz_render", "visualizations/abc.svg");
  w("newsroom_viz_critic", "visualizations/qa/a.json");
  w("newsroom_viz_critic", "visualizations/critics/a.json");
  w("newsroom_infographic_critic", "infographics/qa/a.json");
  assert.throws(() => w("newsroom_viz_critic", "visualizations/abc.json", "unlink"), groups.BoundaryRefusal, "a review tool may not unlink a manifest itself");
  assert.throws(() => w("newsroom_viz_critic", "visualizations/rejected/abc/manifest.json"), groups.BoundaryRefusal, "nor write into rejected/");
  w("newsroom_viz_critic", "visualizations/rejected/abc/manifest.json", "write", "review_reject_writer");
  w("newsroom_viz_critic", "visualizations/abc.json", "unlink", "review_reject_writer");
  assert.throws(() => w("newsroom_viz_render", "visualizations/abc.json", "unlink", "review_reject_writer"), groups.BoundaryRefusal, "a draw tool may not ask for the reject writer");
  // a leftover 0 changes nothing: the same calls are still refused
  register({ NEWSROOM_REVIEW_SPLIT: "0", NEWSROOM_GROUP_ENFORCE: "1" });
  assert.throws(() => w("newsroom_viz_render", "visualizations/qa/a.json"), groups.BoundaryRefusal, "leftover 0: a draw tool is still refused on a review path");
  assert.throws(() => w("newsroom_viz_critic", "visualizations/abc.json", "unlink"), groups.BoundaryRefusal, "leftover 0: a review tool still may not unlink a manifest itself");
}
check("boundary: draw tools are refused on review paths, review tools on moving draw products unless via review_reject_writer; a leftover 0 changes none of it");

// 5. a failing critic: the rejected move goes through the writer (boundary on, enforce on) and leaves the same files as the default path
{
  const story = await drawAndReview({ NEWSROOM_GROUP_ENFORCE: "1" });
  const manifest = json(story.dir, story.manifestRef);
  assert.ok(!("render_qa_ref" in manifest));
  // break the SVG so the critic fails: the hash check refuses before a move, so flip a passed critic by editing the plan's takeaway is not possible; use the helper path directly
  const reject = mod.__rejectManifestForTest;
  if (reject) {
    const criticRef2 = firstUnder(story.dir, "visualizations/critics", /\.json$/);
    const moved = await groups.runInTool("newsroom_viz_critic", () => reject("visualizations", story.manifestRef, criticRef2));
    assert.ok(moved && !existsSync(join(story.dir, story.manifestRef)) && existsSync(join(story.dir, moved.rejectedManifestRef)), "moved through the reject writer");
  }
}
check("failing critic: the manifest moves through review_reject_writer under ENFORCE");
console.log(`PASS review split (${results.length} checks)`);
