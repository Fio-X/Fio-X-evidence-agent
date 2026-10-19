// NEWSROOM_REFUSAL_FIELDS: a refused chart plan carries, next to its text, the field path, the rule and the allowed values or range.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TYPEBOX = `
const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`;
const TREE = makeTestTmp("refusal-fields-");
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
const COPY_HEAD = join(TREE, "runtime/pi/newsroom.head-copy.mjs");
writeFileSync(COPY_HEAD, stripTypeScriptTypes(headSource, { mode: "strip" }));

let n = 0;
async function load(file, env) {
  for (const k of Object.keys(process.env)) if (k.startsWith("NEWSROOM_") && k !== "NEWSROOM_ARTIFACT_DIR") delete process.env[k];
  process.env.NEWSROOM_GROUP_CALL_REFUSE = "0"; process.env.NEWSROOM_GROUP_CALL_REFUSE_ALL = "0"; // the off-table call refusal is on by default; this test is about something else, so both are pinned off
  process.env.NEWSROOM_REVIEW_SPLIT = "0"; // the review split is on by default and moves the render-QA line into the critic; this test compares the draw tool's own text, so the old layout is pinned
  process.env.NEWSROOM_TOOL_PROFILE = "full";
  process.env.NEWSROOM_SYMBOL_MAP = "0"; // symbol_map is on by default and gives the focus_place refusal a field (observed: focus_place); the closed set below is the one without the chart, so it is pinned off
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === null) delete process.env[k]; // null: leave the switch unset (its default)
  const tools = new Map();
  const mod = await import(`${pathToFileURL(file).href}?v=${++n}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
const listing = (art) => Object.fromEntries(walk(art).map((f) => relative(art, f)).sort().map((f) => [f, sha(readFileSync(f.startsWith("/") ? f : join(art, f)))]));

// ---- one artifact root with a verified claim, shared by every call (refusals must leave it unchanged) -----------------------
const art = join(makeTestTmp("refusal-fields-art-"), "run");
for (const d of ["data", "sources", "computations", "runtime/query-rows", "visualizations/plans", "visualizations/lints", "visualizations/critics", "editorial/story-graphs"]) mkdirSync(join(art, d), { recursive: true });
cpSync(join(ROOT, "config"), join(art, "config"), { recursive: true });
process.env.NEWSROOM_ARTIFACT_DIR = art;
const csv = Buffer.from("region,amount\nn,4\ns,9\nw,6\n");
const data = `data/${sha(csv)}.csv`;
writeFileSync(join(art, data), csv);
writeFileSync(join(art, `${data}.meta.json`), JSON.stringify({ file: data, sha256: sha(csv), bytes: csv.length, label: "fixture" }));
const setup = await load(COPY_HEAD, { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "" });
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
// refusal kind -> [params, env, expected field, expected rule]
const CASES = {
  "invalid plan: decimals (not a schema property, so no field)": [{ ...good, decimals: 9 }, {}, null, "VALUE_RULE", { min: 0, max: 3 }],
  "invalid plan: unsupported visual_family": [{ ...good, visual_family: "nope" }, {}, "visual_family", "UNSUPPORTED_VALUE", null],
  "invalid plan: required field missing": [noCategory, {}, "category_field", "REQUIRED", null],
  "invalid plan: x_scale": [{ ...good, x_scale: "sqrt" }, {}, "x_scale", "VALUE_RULE", { values: ["linear", "log"] }],
  "module without story binding": [{ ...good, delivery_role: "infographic_module" }, {}, "story_graph_ref", "INFOGRAPHIC_MODULE_BINDING_REQUIRED", null],
  "semantic declaration required": [{ ...good, reader_task: "ranking" }, {}, "measure_semantics", "SEMANTIC_DECLARATION_REQUIRED", null],
  "chart type held": [{ ...good, chart_type: "geo_flow_map" }, { NEWSROOM_HELD_CHART_TYPES: "1" }, "chart_type", "CHART_TYPE_HELD", null],
  "plan value held": [{ ...good, visual_family: "hierarchy" }, { NEWSROOM_HELD_CHART_TYPES: "1" }, "visual_family", "PLAN_VALUE_HELD", null],
  "grammar block": [{ ...ranked, chart_type: "line", x_field: "region", category_field: undefined }, {}, "chart_type", "EDITORIAL_GRAMMAR_BLOCKED", "list"],
};
const LINE = "\n[refusal] ";
const call = async (tools, params, env) => {
  const root = join(makeTestTmp("refusal-fields-run-"), "run");
  cpSync(art, root, { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = root;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try { await tools.get("newsroom_viz_plan").execute("t", JSON.parse(JSON.stringify(params))); return { ok: true }; }
  catch (e) { return { ok: false, message: String(e.message).split(root).join("<root>"), refusal: e.refusal }; }
  finally { for (const k of Object.keys(env)) delete process.env[k]; process.env.NEWSROOM_ARTIFACT_DIR = art; }
};
let failures = 0;
const ok = async (name, fn) => { try { await fn(); console.log(`ok - ${name}`); } catch (e) { failures++; console.log(`not ok - ${name}\n  ${String(e.message).split("\n").join("\n  ")}`); } };

const on = await load(COPY_HEAD, {});
const off = await load(COPY_HEAD, { NEWSROOM_REFUSAL_FIELDS: "0" });
for (const [name, [params, env, field, rule, allowed]] of Object.entries(CASES)) {
  await ok(`${name}: the refusal carries the field, the rule and the allowed values`, async () => {
    const a = await call(on, params, env);
    assert.equal(a.ok, false, "the call is refused");
    assert.ok(Array.isArray(a.refusal) && a.refusal.length, "error.refusal is a non-empty list");
    const hit = a.refusal.find((item) => item.rule === rule && item.field === field);
    assert.ok(hit, `no entry with field ${field} and rule ${rule}: ${JSON.stringify(a.refusal)}`);
    if (allowed === "list") assert.ok(hit.allowed?.values?.length, "allowed values named");
    else if (allowed) assert.deepEqual(hit.allowed, allowed);
    const at = a.message.lastIndexOf(LINE);
    assert.ok(at > 0, "the text ends with a [refusal] line");
    assert.deepEqual(JSON.parse(a.message.slice(at + LINE.length)), { refusals: a.refusal }, "the line holds the same list");
  });
  await ok(`${name}: with the switch "0" the text is byte-identical and carries nothing`, async () => {
    const a = await call(on, params, env);
    const b = await call(off, params, env);
    assert.equal(b.ok, false);
    assert.equal(b.refusal, undefined, "no refusal property");
    assert.ok(!b.message.includes("[refusal]"), "no refusal line");
    assert.equal(a.message.slice(0, a.message.lastIndexOf(LINE)), b.message, "the text before the line equals the off text");
  });
}
// symbol_map is on by default: the plan tool then has the focus_place property, and a refusal about it names that field (the pinned-off closed set above never sees it)
const onSymbol = await load(COPY_HEAD, { NEWSROOM_SYMBOL_MAP: null });
await ok("symbol map on (default): a refused focus_place carries the field focus_place and the rule", async () => {
  assert.ok("focus_place" in onSymbol.get("newsroom_viz_plan").parameters.properties, "the property exists with the symbol map on");
  assert.ok(!("focus_place" in on.get("newsroom_viz_plan").parameters.properties), "and not with it pinned off");
  const a = await call(onSymbol, { ...good, focus_place: "x".repeat(81) }, {});
  assert.equal(a.ok, false, "an 81-character focus_place is refused");
  assert.ok(Array.isArray(a.refusal) && a.refusal.length, `error.refusal is a non-empty list: ${a.message}`);
  assert.ok(a.refusal.some((item) => item.field === "focus_place"), `no entry with field focus_place: ${JSON.stringify(a.refusal)}`);
});
await ok("an accepted plan is untouched", async () => {
  process.env.NEWSROOM_ARTIFACT_DIR = art;
  const a = await call(on, good, {});
  assert.equal(a.ok, true);
});
await ok("a cancelled call is not turned into a refusal", async () => {
  const ac = new AbortController(); ac.abort();
  const root = join(makeTestTmp("refusal-fields-run-"), "run");
  cpSync(art, root, { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = root;
  try { await on.get("newsroom_viz_plan").execute("t", { ...good, decimals: 9 }, ac.signal); assert.fail("expected a throw"); }
  catch (e) { assert.equal(e.refusal, undefined); assert.ok(!String(e.message).includes("[refusal]")); }
  finally { process.env.NEWSROOM_ARTIFACT_DIR = art; }
});

// ---- closed set: every refusal template the plan path can throw, with the entry it must give -----------------------------------------
// The templates are read out of the sources (the functions the plan path calls); `${...}` becomes a sample word. A new or reworded
// template has no row in the table and fails here, so a change of wording shows up as a test change, not as a silent null.
const known = new Set(Object.keys(on.get("newsroom_viz_plan").parameters.properties));
if (process.env.DUMP_KNOWN) { console.log([...known].sort().join(" ")); process.exit(0); }
const parserSource = headSource.slice(headSource.indexOf("const REFUSAL_CODE"), headSource.indexOf("const REFUSAL_LINE_PREFIX"));
const parse = new Function(`${stripTypeScriptTypes(parserSource, { mode: "strip" })}; return refusalFieldsOf;`)();
function literalAt(src, i) {
  const q = src[i]; if (!`"'\``.includes(q)) return null;
  let j = i + 1, depth = 0, out = "";
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { out += src[j] + src[j + 1]; j += 2; continue; }
    if (q === "`" && c === "$" && src[j + 1] === "{") { let d = 1; let k = j + 2; while (k < src.length && d) { if (src[k] === "{") d++; else if (src[k] === "}") d--; k++; } out += "${…}"; j = k; continue; }
    if (c === q) return { text: out, end: j + 1 };
    out += c; j++;
  }
  return null;
}
function sinks(src, re) {
  const found = [], other = [];
  for (const m of src.matchAll(re)) {
    let i = m.index + m[0].length; while (/\s/.test(src[i])) i++;
    const lit = literalAt(src, i);
    const line = src.slice(0, m.index).split("\n").length;
    if (lit) found.push({ line, text: lit.text }); else other.push({ line, head: src.slice(i, i + 60).replace(/\n/g, " ") });
  }
  return { found, other };
}
function body(src, name) {
  const re = new RegExp(`(?:)?(?:async )?function ${name}\\(`);
  const m = re.exec(src); if (!m) throw new Error("no function " + name);
  let i = src.indexOf("{", src.indexOf(")", m.index)); // body brace (params may hold defaults; fine here)
  let d = 0, k = i;
  for (; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (!d) break; } }
  return src.slice(m.index, k + 1);
}

const SRC = { "viz.mjs": ["validateVizSpec"], "render_styles.mjs": ["renderStyleErrors"], "story_forms.mjs": ["waveFieldErrors", "toneErrors", "storyChartErrors"],
  "editorial_semantics.mjs": ["evaluateVisualSemantics"], "measure_semantics.mjs": null, "editorial_grammar.mjs": null,
  "newsroom.ts": ["assertPlanValuesNotHeld", "assertChartTypeNotHeld", "assertEditorialGrammarOffered", "validateReadOnlySql"] };
const templates = [];
for (const [file, fns] of Object.entries(SRC)) {
  const src = readFileSync(join(ROOT, "runtime/pi", file), "utf8");
  let text = fns ? fns.map((name) => body(src, name)).join("\n") : src;
  if (file === "newsroom.ts") { // the plan tool's own checks: from its first check to the point where the collected refusals are thrown
    const a = headSource.indexOf("assertChartTypeNotHeld(rawParams.chart_type);"), z = headSource.indexOf("throwCollected();", a);
    text += "\n" + headSource.slice(a, z);
  }
  const a = sinks(text, /errors\.push\(|throw new Error\(|new Error\(|return \[/g);
  for (const hit of a.found) templates.push({ file, text: hit.text });
}
// the sample: ${...} -> a plain lowercase word, escapes undone. A plan-validation message (no CODE prefix, from the spec checks) is thrown inside
// "Invalid visualization plan: ...", so it is parsed in that wrapper.
const sample = (t) => t.replace(/\[\$\{…\}\]/g, "[0]").replace(/\$\{…\}/g, "x").replace(/\\(["'`\\])/g, "$1");
const WRAPPED = new Set(["viz.mjs", "render_styles.mjs", "story_forms.mjs"]);
const table = {};
for (const { file, text } of templates) {
  const message = sample(text);
  const thrown = !/^[A-Z][A-Z0-9_]{3,}: /.test(message) && WRAPPED.has(file) ? `Invalid visualization plan: ${message}` : message;
  table[message] = parse(thrown, known);
}
const GOLDEN = join(ROOT, "fixtures/refusal-fields/templates.json");
const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => (a < b ? -1 : 1)));
if (process.argv.includes("--write")) { mkdirSync(join(ROOT, "fixtures/refusal-fields"), { recursive: true }); writeFileSync(GOLDEN, `${JSON.stringify(sorted, null, 1)}\n`); console.log(`wrote ${Object.keys(sorted).length} templates`); }
await ok("every refusal template of the plan path has its expected field, rule and allowed values (closed set)", async () => {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  const added = Object.keys(sorted).filter((key) => !(key in golden)), gone = Object.keys(golden).filter((key) => !(key in sorted));
  assert.deepEqual({ added, gone }, { added: [], gone: [] }, "a template was added, removed or reworded: check its field and rule, then regenerate with --write");
  for (const key of Object.keys(sorted)) assert.deepEqual(sorted[key], golden[key], `entry changed for: ${key}`);
});
await ok("a prose lead word is never taken for a field", async () => {
  for (const prose of ["chart must be one of a, b", "data is required for X", "value must be a number", "Invalid visualization plan: row must be an object"]) {
    for (const item of parse(prose, known)) assert.equal(item.field, null, prose);
  }
  assert.equal(parse("x_scale must be linear or log", known)[0].field, "x_scale", "a schema property still counts");
  assert.equal(parse("claim_spec.relation must be X", known)[0].field, "claim_spec.relation", "a dotted path counts by its first segment");
});
await ok("a combined refusal gives one entry per problem; continuation lines add none", async () => {
  const text = "x_scale must be linear or log\nAlso refused in this call (2 more independent problems; no claim or plan was recorded):\n(2) CHART_TYPE_HELD: chart_type 'X' is not available; choose another chart_type.\n(3) Invalid visualization plan: y_scale must be linear or log; language must be 'en' or 'zh'\nSend only the change: tool patch_of=ref";
  assert.deepEqual(parse(text, known).map((item) => [item.field, item.rule]), [["x_scale", "VALUE_RULE"], ["chart_type", "CHART_TYPE_HELD"], ["y_scale", "VALUE_RULE"], ["language", "VALUE_RULE"]]);
  assert.deepEqual(parse("READER_TASK_INVALID: reader_task 'z' is not a reader task; set it to exactly one of a, b, c, and set claim_spec", known)[0].allowed, { values: ["a", "b", "c"] }, "the list stops at 'and'");
});
await ok("a system error that is not a plan refusal gets no entry", async () => {
  for (const text of ["Failed to read the data file", "Unexpected token in JSON", "ENOENT: no such file", "Send only the change: tool patch_of=ref"]) assert.deepEqual(parse(text, known), [], text);
});
await ok("the field is checked against the tool's own parameters, not a fixed list", async () => {
  assert.equal(parse("x_scale must be linear or log", new Set([]))[0].field, null);
});
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
