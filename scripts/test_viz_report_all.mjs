// NEWSROOM_SPEED_VIZ_REPORT_ALL=1: newsroom_viz_plan lists every independent problem in one refusal.
// Differential: the same case table runs against newsroom.ts at the baseline commit (83de204, the code before the switch), against the head with
// the switch off, and against the head with it on. Verdict (accepted / refused) must agree in all three; off must equal the baseline's message
// exactly; on must start with the baseline's message (the first problem keeps its text) and may only add independent problems. A refused call
// must not run SQL or write anything (artifact root listing unchanged), and a refusal never records the inline claim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_REF = process.env.VIZ_REPORT_ALL_BASE_REF || "83de204";
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`;
const TREE = mkdtempSync(join(tmpdir(), "viz-report-all-"));
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
const baseSource = execFileSync("git", ["show", `${BASELINE_REF}:runtime/pi/newsroom.ts`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
const COPY_BASE = join(TREE, "runtime/pi/newsroom.base-copy.mjs");
const COPY_HEAD = join(TREE, "runtime/pi/newsroom.head-copy.mjs");
writeFileSync(COPY_BASE, stripTypeScriptTypes(baseSource, { mode: "strip" }));
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
const art = join(mkdtempSync(join(tmpdir(), "viz-report-all-art-")), "run");
for (const d of ["data", "sources", "computations", "runtime/query-rows", "visualizations/plans", "visualizations/lints", "visualizations/critics", "editorial/story-graphs"]) mkdirSync(join(art, d), { recursive: true });
cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
const csv = Buffer.from("region,amount\nn,4\ns,9\nw,6\n");
const data = `data/${sha(csv)}.csv`;
writeFileSync(join(art, data), csv);
writeFileSync(join(art, `${data}.meta.json`), JSON.stringify({ file: data, sha256: sha(csv), bytes: csv.length, label: "fixture" }));
const setup = await load(COPY_BASE, { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "" });
const SQL = `SELECT region, amount FROM read_csv_auto('${data}')`;
const q = await setup.get("duckdb_query").execute("q", { sql: SQL });
await setup.get("record_claim").execute("c", { claim: "Amounts by region", claim_kind: "quantitative", status: "supported", source_refs: [data], computation_refs: [relative(art, q.details.path)] });
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
const run = async (tools, params, flag) => {
  if (flag === undefined) delete process.env.NEWSROOM_SPEED_VIZ_REPORT_ALL; else process.env.NEWSROOM_SPEED_VIZ_REPORT_ALL = flag; // read at call time, so set it per call
  const before = listing(art);
  const sqlRowsBefore = readdirSync(join(art, "runtime/query-rows")).length;
  let out;
  try { const res = await tools.get("newsroom_viz_plan").execute("t", structuredClone(JSON.parse(JSON.stringify(params)))); out = { ok: true, text: res.content[0].text }; } catch (e) { out = { ok: false, message: String(e?.message ?? e), name: e?.name, code: e?.code }; }
  const after = listing(art);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]);
  return { ...out, changed, newSqlRows: readdirSync(join(art, "runtime/query-rows")).length - sqlRowsBefore };
};
const base = await load(COPY_BASE, {});
const off = await load(COPY_HEAD, {});
const on = off; // the switch is read when the tool runs, so one registration serves both
let refused = 0, accepted = 0, multi = 0;
for (const [name, params] of Object.entries(CASES)) {
  // accepted calls write a plan, so each variant runs on its own copy of the root only when accepted; compare refusals and the first acceptance
  const b = await run(base, params);
  const o = await run(off, params);
  const r = await run(on, params, "1");
  assert.equal(o.ok, b.ok, `${name}: switch off verdict differs from ${BASELINE_REF}`);
  assert.equal(r.ok, b.ok, `${name}: switch on verdict differs from ${BASELINE_REF}`);
  if (b.ok) {
    accepted++;
    assert.match(o.text, /Visualization plan recorded/); assert.match(r.text, /Visualization plan recorded/);
    continue;
  }
  refused++;
  assert.equal(o.message, b.message, `${name}: switch off message differs from ${BASELINE_REF}`);
  assert.equal(o.name, b.name); assert.equal(o.code, b.code);
  assert.ok(r.message.startsWith(b.message), `${name}: first problem lost its text.\n baseline: ${b.message.slice(0, 200)}\n on: ${r.message.slice(0, 200)}`);
  assert.equal(r.name, b.name, `${name}: first problem lost its class`); assert.equal(r.code, b.code, `${name}: first problem lost its code`);
  for (const [label, x] of [["baseline", b], ["off", o], ["on", r]]) {
    assert.deepEqual(x.changed, [], `${name}: ${label} refusal wrote ${x.changed.slice(0, 3).join(", ")}`);
    assert.equal(x.newSqlRows, 0, `${name}: ${label} refusal ran SQL`);
  }
  for (const bad of ["0", "", "true"]) { const x = await run(off, params, bad); assert.equal(x.message, b.message, `${name}: a non-"1" value changed the message`); }
  if (r.message !== b.message) { multi++; assert.match(r.message, /\nAlso refused in this call \(\d+ more independent problems?; nothing was recorded\):\n\(2\) /); }
  console.log(`  ${name}: ${r.message === b.message ? "one problem, same text" : `${r.message.split("\n").length - 2} more listed`}`);
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
console.log(`PASS viz_plan report-all: ${refused} refused and ${accepted} accepted cases agree with ${BASELINE_REF} (off: identical text; on: first problem unchanged, ${multi} list more; refusals ran no SQL and wrote nothing)`);

// ---- tool definitions: both switches off = byte-identical to the baseline; RULE_HINTS on = descriptions only; VIZ_REPORT_ALL changes no definition ----
{
  const PROFILES = ["investigate", "visual", "visual-story", "publication", "competition", "full"];
  const defs = async (file, env, profile) => {
    delete process.env.NEWSROOM_SPEED_VIZ_REPORT_ALL;
    const tools = await load(file, { ...env, NEWSROOM_TOOL_PROFILE: profile });
    return new Map([...tools].map(([name, t]) => [name, JSON.stringify(t)]));
  };
  const stripDescriptions = (text) => JSON.stringify(JSON.parse(text), (k, v) => (k === "description" ? undefined : v));
  let tools = 0, changedByHints = new Set();
  for (const profile of PROFILES) {
    const baseDefs = await defs(COPY_BASE, {}, profile);
    const offDefs = await defs(COPY_HEAD, {}, profile);
    assert.deepEqual([...offDefs.keys()], [...baseDefs.keys()], `${profile}: same tools in the same order`);
    for (const [name, text] of baseDefs) assert.equal(offDefs.get(name), text, `${profile}/${name}: switches off, definition differs from ${BASELINE_REF}`);
    tools += baseDefs.size;
    const reportAll = await defs(COPY_HEAD, { NEWSROOM_SPEED_VIZ_REPORT_ALL: "1" }, profile);
    for (const [name, text] of baseDefs) assert.equal(reportAll.get(name), text, `${profile}/${name}: VIZ_REPORT_ALL changed a definition`);
    const hints = await defs(COPY_HEAD, { NEWSROOM_SPEED_RULE_HINTS: "1" }, profile);
    const hintsBase = await defs(COPY_BASE, { NEWSROOM_SPEED_RULE_HINTS: "1" }, profile);
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
  assert.match(await planDesc(hintsOn, "claim_spec", "properties", "target_measure"), /measure_semantics entry/);
  assert.match(await planDesc(hintsOn, "claim_spec", "properties", "claim_id"), /plan's claim_id/);
  assert.match(await planDesc(hintsOn, "category_field"), /Required by chart_type/);
  assert.match(await planDesc(hintsOn, "claim_id"), /this chart's own query/);
  console.log(`PASS tool definitions: ${tools} definitions over ${PROFILES.length} profiles are byte-identical to ${BASELINE_REF} with the switches off and with VIZ_REPORT_ALL on; RULE_HINTS on changes only descriptions (${[...changedByHints].join(", ")}), and the claim_spec.reader_task example no longer lists a value outside the enum`);
}
