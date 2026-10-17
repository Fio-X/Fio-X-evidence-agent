#!/usr/bin/env node
// NEWSROOM_QA_NO_EMPTY_PASS (on unless exactly "0") through the REAL newsroom_viz_render tool (a type-stripped copy of newsroom.ts, duckdb):
// an all-zero chart is refused and the text the model reads names the cause and the two ways out (renderQaFailureText);
// a chart with one non-zero value renders; switch off, the all-zero chart renders as before. Needs the duckdb binary.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
if (spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") {
  console.log("duckdb binary not found; cannot exercise the real tools");
  process.exit(1);
}
const { ALL_ZERO_MESSAGE } = await import(join(ROOT, "runtime/pi/render_qa.mjs"));
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
const tree = mkdtempSync(join(tmpdir(), "qa-zero-tool-"));
cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
stub(tree, "typebox", `const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`);
stub(tree, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const copy = join(tree, "runtime", "pi", "newsroom.test-copy.mjs");
writeFileSync(copy, stripTypeScriptTypes(readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const mod = await import(copy);

let n = 0;
async function renderWith(csvRows, switchValue, kind = "bar") {
  for (const key of Object.keys(process.env)) if (key.startsWith("NEWSROOM_")) delete process.env[key];
  Object.assign(process.env, { NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1" });
  if (switchValue !== undefined) process.env.NEWSROOM_QA_NO_EMPTY_PASS = switchValue;
  const art = join(mkdtempSync(join(tmpdir(), `qa-zero-run${++n}-`)), "run");
  for (const d of ["visualizations/plans", "visualizations/lints", "visualizations/critics", "computations", "data", "sources"]) mkdirSync(join(art, d), { recursive: true });
  cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
  const csv = kind === "heatmap" ? `country,fuel,share\n${csvRows.map(([c, f, v]) => `${c},${f},${v}`).join("\n")}\n` : `country,share\n${csvRows.map(([c, v]) => `${c},${v}`).join("\n")}\n`;
  writeFileSync(join(art, "data", "t.csv"), csv);
  writeFileSync(join(art, "data", "t.meta.json"), JSON.stringify({ file: "t.csv", sha256: createHash("sha256").update(csv).digest("hex") }));
  writeFileSync(join(art, "claims.jsonl"), "");
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  const run = (name, params) => tools.get(name).execute(`t-${name}`, params);
  const SQL = kind === "heatmap" ? "SELECT country, fuel, share FROM 'data/t.csv' ORDER BY country, fuel" : "SELECT country, share FROM 'data/t.csv' ORDER BY country";
  const query = await run("duckdb_query", { sql: SQL });
  const comp = query.details.path.startsWith("/") ? relative(art, query.details.path) : query.details.path;
  const verification = { authority: "system", rule_id: "verification.source+extraction+computation+claim.v1", source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true, publishable: true };
  writeFileSync(join(art, "claims.jsonl"), `${JSON.stringify({ claim_id: "c1", status: "verified", source_refs: ["data/t.csv"], computation_refs: [comp], verification })}\n`);
  const plan = await run("newsroom_viz_plan", {
    reader_task: "sequence", title: "Share by country", alt: "A bar chart of a share across four countries.", takeaway: "The shares of the four countries are shown.",
    source_note: "fixture", sql: SQL, claim_id: "c1", unit: "%", chart_type: "horizontal_bar",
    ...(kind === "heatmap" ? { chart_type: "heatmap", x_field: "fuel", y_field: "country", value_field: "share", decimals: 1 } : { category_field: "country", value_field: "share" }),
    highlight_values: [], annotations: [],
  });
  assert.ok(plan.details?.planRef, `plan: ${plan.content[0].text.slice(0, 300)}`);
  const lint = await run("newsroom_viz_lint", { plan_ref: plan.details.planRef });
  assert.ok(lint.details?.lintRef, `lint: ${lint.content[0].text.slice(0, 300)}`);
  try {
    const render = await run("newsroom_viz_render", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
    return { text: render.content[0].text, passed: render.details.renderQaPassed };
  } catch (error) { return { text: String(error.message), passed: false, threw: true }; }
}
const zero = [["A", 0], ["B", 0], ["C", 0], ["D", 0]];
const mixed = [["A", 0], ["B", 0], ["C", 3], ["D", 0]];

const on = await renderWith(zero, "1");
assert.equal(on.passed, false, `all zero, switch on: refused (${on.text.slice(0, 200)})`);
assert.ok(on.text.includes("qa_all_values_zero"), "the failure is named in the text the model reads");
assert.ok(on.text.includes(ALL_ZERO_MESSAGE), "the two ways out replace the generic advice");
assert.ok(!on.text.includes("shorter labels, fewer categories"), "the generic advice is gone for an all-zero chart");

const some = await renderWith(mixed, "1");
assert.equal(some.passed, true, `one non-zero value, switch on: renders (${some.text.slice(0, 200)})`);
assert.ok(!some.text.includes("qa_all_values_zero"));

// default (variable unset) and any value but "0": the same refusal as "1"
for (const value of [undefined, "true", ""]) {
  const d = await renderWith(zero, value);
  assert.equal(d.passed, false, `switch ${JSON.stringify(value)}: all zero is refused`);
  assert.ok(d.text.includes("qa_all_values_zero") && d.text.includes(ALL_ZERO_MESSAGE), `switch ${JSON.stringify(value)}: the all-zero text is shown`);
  assert.equal((await renderWith(mixed, value)).passed, true, `switch ${JSON.stringify(value)}: one non-zero value renders`);
}
// exactly "0": the old behaviour, no all-zero text
const off = await renderWith(zero, "0");
assert.ok(!off.text.includes("qa_all_values_zero") && !off.text.includes(ALL_ZERO_MESSAGE), 'switch "0": no all-zero text');
// heatmap with the cell proof off (the default): the cells have no role, and the tool hands the check the chart type so they are not an empty pass
const heat = ["甲国", "乙国", "丙国"].flatMap((c, i) => ["煤", "气", "水", "风"].map((f, j) => [c, f, 5 + i * 7 + j * 3]));
const heatOn = await renderWith(heat, "1", "heatmap");
assert.equal(heatOn.passed, true, `heatmap, switch on, proof off: renders (${heatOn.text.slice(0, 300)})`);
const heatOff = await renderWith(heat, "0", "heatmap");
assert.equal(heatOff.passed, true, "heatmap, switch at \"0\": renders as before");
const heatDefault = await renderWith(heat, undefined, "heatmap");
assert.equal(heatDefault.passed, true, `heatmap, default: renders (${heatDefault.text.slice(0, 300)})`);
const heatZero = await renderWith(heat.map(([c, f]) => [c, f, 0]), "1", "heatmap");
assert.equal(heatZero.passed, false, "an all-zero heatmap is refused");
assert.ok(heatZero.text.includes("qa_all_values_zero"));
console.log("PASS qa all-zero through the real render tool");
