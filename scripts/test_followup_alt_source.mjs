// NEWSROOM_FOLLOWUP_SAME_SETTINGS=1: a follow-up (`news continue`) hands Pi the
// same speed and merge switches as the first question. The user's condition is
// that a follow-up still checks the chart's alt text and source note, so under
// exactly that environment (every speed switch on, listed below; the Rust tests
// in continue_investigation show the follow-up now passing them):
//  1. a chart call with no source note and no recorded origin is refused,
//  2. a chart call with an alt text under the minimum length is refused,
//  3. the same calls with a source note and a long enough alt are accepted, so
//     the refusals are the checks and not a broken setup.
// Needs duckdb; skipped without it. No provider or network access.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "followup-alt-source-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_")) delete process.env[name];
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_DUCKDB_BIN"]) delete process.env[name];
if (spawnSync("duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT") {
  // NEWSROOM_REQUIRE_NO_SKIP=1 (exact): a run that must skip nothing fails here instead of passing silently.
  console.log("SKIP: duckdb binary not found; the follow-up alt-text and source-note checks did not run");
  process.exit(process.env.NEWSROOM_REQUIRE_NO_SKIP === "1" ? 1 : 0);
}

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
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}),
  Literal: (v) => ({ const: v }),
  Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }),
  Union: (anyOf) => ({ anyOf }),
  Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }),
};
`;

async function loadTree(label, source = ROOT) {
  const dir = mkdtempSync(join(scratch, `tree-${label}-`));
  cpSync(join(source, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(source, "config"), join(dir, "config"), { recursive: true });
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  return { mod: await import(join(pi, "newsroom.test-copy.mjs")), dir };
}
function register(mod, env) {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const renewable = readFileSync(join(ROOT, "fixtures/world-bank-renewable-latest.csv"));
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
function investigation(label, { csv = renewable, name } = {}) {
  const dir = join(scratch, label);
  const sha = sha256(csv);
  mkdirSync(join(dir, "data"), { recursive: true });
  const file = name ?? `${sha}.csv`;
  writeFileSync(join(dir, "data", file), csv);
  writeFileSync(join(dir, "data", `${file}.meta.json`), `${JSON.stringify({ bytes: csv.length, file: `data/${file}`, schema_version: "0.7.0", sha256: sha }, null, 2)}\n`);
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  return { dir, dataRef: `data/${file}` };
}
function writeOrigin(dir, file, fields) {
  mkdirSync(join(dir, "data", "origins"), { recursive: true });
  const origin = { schema_version: "0.7.0", origin: "download", file, ...fields };
  writeFileSync(join(dir, "data", "origins", `${sha256(JSON.stringify(origin))}.json`), `${JSON.stringify(origin, null, 2)}\n`);
}
const shape =
{
    csv: renewable,
    origin: { final_url: "https://ourworldindata.org/grapher/renewable-share.csv", source_label: "Renewable energy consumption share" },
    sql: (ref) => `SELECT country, year, renewable_energy_consumption_pct, country || ' (' || year || ')' AS country_with_year\nFROM '${ref}'\nORDER BY renewable_energy_consumption_pct DESC, country`,
    kind: "comparative",
    template: "Among the African countries in the data, {max.renewable_energy_consumption_pct.country} has the highest renewable energy consumption share at {max.renewable_energy_consumption_pct}% ({max.renewable_energy_consumption_pct.year} data) and {min.renewable_energy_consumption_pct.country} the lowest at {min.renewable_energy_consumption_pct}% ({min.renewable_energy_consumption_pct.year} data).",
    text: "Among the African countries in the data, Congo, Dem. Rep. has the highest renewable energy consumption share at 96.3% (2021 data) and Mauritania the lowest at 19.6% (2022 data).",
    sourceNote: "ourworldindata.org: Renewable energy consumption share",
    plan: {
      reader_task: "ranking", chart_type: "horizontal_bar", complexity_budget: "low", title: "Renewable energy consumption share by country",
      note: "Reference years differ by country (2021 or 2022) and are shown in the labels.", unit: "%", category_field: "country_with_year", value_field: "renewable_energy_consumption_pct", sort: "desc",
      measure_semantics: [{ id: "renewable_pct", field: "renewable_energy_consumption_pct", phenomenon: "renewable energy consumption share", unit: "%", measure_kind: "share", temporal_basis: { type: "point_in_time" }, observation_status: "observed" }],
      claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "renewable_pct", measure_ids: ["renewable_pct"] },
      annotations: [{ type: "reference_line", text: "Half", value: 50 }],
    },
  }
;


// The speed switches a follow-up hands Pi when NEWSROOM_FOLLOWUP_SAME_SETTINGS=1
// and the first question had them all on.
const FOLLOWUP_ENV = {
  NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined,
  NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_DUCKDB_BIN: undefined, NEWSROOM_CLAIM_SQL_LINT: undefined,
  NEWSROOM_SPEED_PARALLEL_HINTS: "1", NEWSROOM_SPEED_COMPUTE_BATCH: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1",
  NEWSROOM_SPEED_CHAIN_INFOGRAPHIC: "1", NEWSROOM_SPEED_PREFLIGHT: "1", NEWSROOM_SPEED_PLAN_EDIT: "1", NEWSROOM_SPEED_INLINE_CLAIM: "1",
  NEWSROOM_SPEED_PLAN_PATCH: "1", NEWSROOM_SPEED_CHAIN_PATCH: "1", NEWSROOM_SPEED_REPORT_ALL: "1", NEWSROOM_SPEED_FILL_COPIED_REFS: "1",
  NEWSROOM_SPEED_FIRST_TRY_TEXT: "1", NEWSROOM_SPEED_PLAN_PROGRESS: "1",
};

const { mod } = await loadTree("current");
const { relative } = await import("node:path");
const tools = register(mod, FOLLOWUP_ENV);
const takeaway = shape.text;
const longAlt = `${shape.plan.title}. ${shape.text}`;

// Classic path: the claim is recorded first, then the chart call carries its id.
async function chartCall(label, spec, { origin = true } = {}) {
  const story = investigation(label, { csv: shape.csv });
  if (origin) writeOrigin(story.dir, story.dataRef, shape.origin);
  const shown = await tools.get("duckdb_query").execute("q", { sql: shape.sql(story.dataRef) });
  const rc = await tools.get("record_claim").execute("rc", { claim: shape.text, claim_kind: shape.kind, status: "supported", source_refs: [story.dataRef], computation_refs: [relative(story.dir, shown.details.path)] });
  const claimId = rc.details.claimId;
  const plan = { ...shape.plan, sql: shape.sql(story.dataRef), claim_id: claimId, takeaway, alt: longAlt, source_note: shape.sourceNote, ...spec };
  plan.claim_spec = { ...plan.claim_spec, claim_id: claimId };
  plan.annotations = plan.annotations.map((annotation) => ({ ...annotation, claim_id: claimId }));
  for (const key of Object.keys(spec)) if (spec[key] === undefined) delete plan[key];
  try { return { ok: true, out: await tools.get("newsroom_viz_chain").execute("c", plan) }; } catch (error) { return { ok: false, message: String(error.message) }; }
}
// Everything a stopped chain reports: the stop message and each step's blockers or error.
const whyStopped = (r) => (r.ok ? JSON.stringify([r.out.details.stopMessage, r.out.details.steps.map((step) => step.details?.blockers ?? step.details?.error ?? null)]) : r.message);
const stopped = (r) => (r.ok ? [r.out.details.chainStatus, r.out.details.stopCode, r.out.details.stopMessage] : ["THROWN", r.message]);

// 3. Setup works: alt long enough and a source note -> the chain completes.
{
  const good = await chartCall("good", {});
  assert.equal(good.ok && good.out.details.chainStatus, "COMPLETE", String(stopped(good)));
}
// 2. Alt text under the minimum length is refused.
{
  const bad = await chartCall("short-alt", { alt: "Too short." });
  assert.notEqual(bad.ok && bad.out.details.chainStatus, "COMPLETE", "a 10-character alt text must not complete");
  assert.match(whyStopped(bad), /Alt description must be at least \d+ characters/, `refusal names the alt text: ${whyStopped(bad)}`);
}
// 1a. Classic path: no source note -> refused.
{
  const bad = await chartCall("no-source", { source_note: undefined });
  assert.notEqual(bad.ok && bad.out.details.chainStatus, "COMPLETE", "a chart without a source note must not complete");
  assert.match(whyStopped(bad), /Missing required field 'source_note'|Source attribution is required/, `refusal names the source note: ${whyStopped(bad)}`);
}
// 1b. Inline-claim path (the switch the follow-up now carries): no origin record and no source note -> refused, nothing recorded.
{
  const story = investigation("inline-no-origin", { csv: shape.csv });
  await assert.rejects(
    () => tools.get("newsroom_viz_chain").execute("i", { ...shape.plan, sql: shape.sql(story.dataRef), claim: shape.template, claim_kind: shape.kind }),
    /INLINE_CLAIM_SOURCE_NOTE_REQUIRED: source_note is required here/,
  );
}
console.log("ok: under the follow-up's speed switches the alt text and the source note are still checked");
