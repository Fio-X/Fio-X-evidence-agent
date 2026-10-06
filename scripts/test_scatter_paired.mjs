// K110: NEWSROOM_SCATTER_PAIRED_MEASURES=1 compares a scatter's two axes as a pair (same objects, same period, aggregation and
// temporal basis; units may differ). Off (anything but exactly "1") every call, refusal and tool definition is unchanged.
// Offline: the real newsroom.ts is loaded from a type-stripped copy and run on an empty artifact root in draft mode; the lint
// tests call lintVizSpec with literal rows. Run: node scripts/test_scatter_paired.mjs
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateVisualSemantics } from "../runtime/pi/editorial_semantics.mjs";
import { lintVizSpec, scatterPairBlockers } from "../runtime/pi/viz.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SWITCH = "NEWSROOM_SCATTER_PAIRED_MEASURES";
let passed = 0;
const must = (cond, msg) => { if (!cond) throw new Error(msg); passed += 1; };
const eq = (a, b, msg) => must(JSON.stringify(a) === JSON.stringify(b), `${msg}\n  got:  ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`);

// ---- loader -------------------------------------------------------------------------------------------
const tree = mkdtempSync(join(tmpdir(), "scatter-paired-"));
cpSync(join(ROOT, "runtime"), join(tree, "runtime"), { recursive: true });
cpSync(join(ROOT, "config"), join(tree, "config"), { recursive: true });
const stub = (name, source) => {
  mkdirSync(join(tree, "node_modules", name), { recursive: true });
  writeFileSync(join(tree, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(tree, "node_modules", name, "index.js"), source);
};
stub("typebox", `const OPT = "__optional";
const mk = (base) => (opts = {}) => ({ ...base, ...(opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {}) });
export const Type = { String: mk({ type: "string" }), Number: mk({ type: "number" }), Integer: mk({ type: "integer" }), Boolean: mk({ type: "boolean" }),
  Any: () => ({}), Null: () => ({ type: "null" }), Unknown: () => ({}), Literal: (v) => ({ const: v }), Optional: (s) => ({ ...s, [OPT]: true }),
  Array: (items, opts = {}) => ({ type: "array", items, ...opts }), Union: (anyOf) => ({ anyOf }), Record: () => ({ type: "object" }),
  Object: (props = {}, opts = {}) => ({ type: "object", properties: props, required: Object.keys(props).filter((k) => !props[k][OPT]), ...opts }) };`);
stub("@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
const COPY = join(tree, "runtime/pi/newsroom.test-copy.mjs");
writeFileSync(COPY, stripTypeScriptTypes(readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8"), { mode: "strip" }));
const artifacts = mkdtempSync(join(tmpdir(), "scatter-paired-root-"));
let instance = 0;
const CHAIN_ENV = { NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1" }; // the chain tool exists only with these two

async function load(switchValue) {
  for (const k of Object.keys(process.env)) if (k.startsWith("NEWSROOM_")) delete process.env[k];
  if (switchValue !== undefined) process.env[SWITCH] = switchValue;
  Object.assign(process.env, CHAIN_ENV);
  process.env.NEWSROOM_ARTIFACT_DIR = artifacts;
  process.env.NEWSROOM_TOOL_PROFILE = "visual-story";
  const tools = new Map();
  const mod = await import(`${pathToFileURL(COPY).href}?v=${++instance}`);
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
const TOOLS = { off: await load(undefined), on: await load("1") };
const callPlan = async (tools, params, switchValue) => {
  // the env is read at call time as well as at registration: set it the way the tools were registered
  for (const k of Object.keys(process.env)) if (k.startsWith("NEWSROOM_")) delete process.env[k];
  if (switchValue !== undefined) process.env[SWITCH] = switchValue;
  Object.assign(process.env, CHAIN_ENV);
  process.env.NEWSROOM_ARTIFACT_DIR = artifacts; process.env.NEWSROOM_TOOL_PROFILE = "visual-story";
  try {
    const r = await tools.get("newsroom_viz_plan").execute("t", structuredClone(params), undefined);
    const text = r.content.map((c) => c.text).join("\n");
    const ref = text.match(/Plan: (\S+)/)?.[1];
    const spec = ref ? JSON.parse(readFileSync(join(artifacts, ref), "utf8")) : null;
    return { ok: true, spec, text };
  } catch (e) { return { ok: false, error: String(e?.message ?? e), code: String(e?.message ?? e).split(":")[0] }; }
};
const plan = (params, on) => callPlan(on ? TOOLS.on : TOOLS.off, params, on ? "1" : undefined);

// ---- fixtures -----------------------------------------------------------------------------------------
const gdp = (o = {}) => ({ id: "gdp", field: "gdp", phenomenon: "GDP per capita", unit: "USD", measure_kind: "level", temporal_basis: { type: "point_in_time", date: "2022" }, observation_status: "observed", ...o });
const life = (o = {}) => ({ id: "life", field: "life", phenomenon: "Life expectancy at birth", unit: "years", measure_kind: "level", temporal_basis: { type: "point_in_time", date: "2022" }, observation_status: "observed", ...o });
const claim = (o = {}) => ({ relation: "relationship", reader_task: "relationship", measure_ids: ["gdp", "life"], ...o });
const base = (o = {}) => ({
  verification_mode: "draft", reader_task: "relationship", chart_type: "scatter", title: "GDP per capita and life expectancy", takeaway: "Richer countries live longer.",
  alt: "Scatter plot of GDP per capita against life expectancy, one point per country, 2022", source_note: "Source: test data",
  sql: "SELECT 'AAA' AS iso3, 2022 AS year, 1000.0 AS gdp, 70.0 AS life", unit: "USD", x_field: "gdp", y_field: "life",
  entity_field: "iso3", period_field: "year", measure_semantics: [gdp(), life()], claim_spec: claim(), ...o,
});

// ---- 1. switch values and tool definitions -----------------------------------------------------------------
const defs = (tools) => JSON.parse(JSON.stringify(Object.fromEntries([...tools].map(([name, t]) => [name, { description: t.description, parameters: t.parameters }]))));
for (const value of ["0", "true", "01", " 1", "1 ", "", "yes"]) {
  eq(defs(await load(value)), defs(TOOLS.off), `switch value ${JSON.stringify(value)} must leave the tool definitions unchanged`);
  const r = await callPlan(await load(value), base(), value);
  must(!r.ok && r.code === "SEMANTIC_COMPARISON_BLOCKED", `switch value ${JSON.stringify(value)} must not open the pairing (got ${r.code})`);
}
const diffPaths = (a, b, path = "") => {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffPaths(a[k], b[k], `${path}.${k}`));
  return [path];
};
eq(diffPaths(defs(TOOLS.off), defs(TOOLS.on)).sort(), ["newsroom_viz_chain", "newsroom_viz_plan"].flatMap((t) => [".entity_field", ".measure_semantics.description", ".period_field.description"].map((x) => `.${t}.parameters.properties${x}`)).sort(),
  "with the switch on only the measure_semantics sentence, the period_field description and the new entity_field may differ, on the plan and chain tools");
{
  const on = defs(TOOLS.on).newsroom_viz_plan.parameters.properties;
  must(on.measure_semantics.description.includes("one measure_semantics entry per axis") && on.entity_field.description.includes("unique across rows") && on.period_field.description.startsWith("mirrored_bar: optional field"), "the three texts are present and the mirrored_bar description is kept");
  must(!("entity_field" in defs(TOOLS.off).newsroom_viz_plan.parameters.properties), "off: no entity_field property");
}

// ---- 2. the plan step: table of calls, off against on -----------------------------------------------------------------
const cases = [
  // name, params, expected off, expected on  (an "ok" with a status, or a refusal code)
  ["honest pair, same period", base(), "SEMANTIC_COMPARISON_BLOCKED", "ok:PASS"],
  ["x observed, y estimate (topic 8)", base({ measure_semantics: [gdp(), life({ observation_status: "estimate" })] }), "SEMANTIC_COMPARISON_BLOCKED", "ok:CONTEXTUAL"],
  ["x for 2022, y for 2019", base({ measure_semantics: [gdp(), life({ temporal_basis: { type: "point_in_time", date: "2019" }, observation_status: "observed" })] }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["x observed, y forecast", base({ measure_semantics: [gdp(), life({ observation_status: "forecast" })] }), "SEMANTIC_COMPARISON_BLOCKED", "ok:CONTEXTUAL"],
  ["x a 2015-2020 mean, y a 2020 point", base({ measure_semantics: [gdp({ temporal_basis: { type: "annual_average", start: "2015", end: "2020" } }), life()] }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["aggregation differs", base({ measure_semantics: [gdp({ aggregation: "mean" }), life()] }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["correlation alias of the relation", base({ claim_spec: claim({ relation: "correlation" }) }), "SEMANTIC_COMPARISON_BLOCKED", "ok:PASS"],
  ["reversed axes in measure_ids", base({ claim_spec: claim({ measure_ids: ["life", "gdp"] }) }), "SEMANTIC_COMPARISON_BLOCKED", "ok:PASS"],
  ["no declarations at all", base({ measure_semantics: undefined, claim_spec: undefined }), "ok:NOT_DECLARED", "SEMANTIC_DECLARATION_REQUIRED"],
  ["empty measure_semantics", base({ measure_semantics: [] }), "ok:NOT_DECLARED", "SEMANTIC_DECLARATION_REQUIRED"],
  ["one measure declared (not paired: today's comparison)", base({ measure_semantics: [gdp()], claim_spec: claim({ measure_ids: ["gdp"] }) }), "ok:PASS", "ok:PASS"],
  ["same id twice", base({ measure_semantics: [gdp(), gdp()] }), "duplicate measure_semantics id: gdp", "duplicate measure_semantics id: gdp"],
  ["measure_ids repeat one id (not paired)", base({ claim_spec: claim({ measure_ids: ["gdp", "gdp"] }) }), "ok:PASS", "ok:PASS"],
  ["two ids become three after merging (target)", base({ measure_semantics: [gdp(), life(), gdp({ id: "pop", field: "pop", phenomenon: "Population", unit: "people" })], claim_spec: claim({ target_measure: "pop" }) }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["third declaration outside measure_ids (not paired)", base({ measure_semantics: [gdp(), life(), gdp({ id: "pop", field: "pop", phenomenon: "Population", unit: "people" })] }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["x_field equals y_field (not paired)", base({ y_field: "gdp" }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["declared fields are neither axis (not paired)", base({ measure_semantics: [gdp({ field: "a" }), life({ field: "b" })] }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["one declared field is the x axis only (not paired)", base({ measure_semantics: [gdp(), life({ field: "b" })] }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["two measures for the same axis (not paired)", base({ measure_semantics: [gdp(), life({ field: "gdp" })] }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ...["percent_change", "absolute_change", "percentage_point_change", "ratio"].map((metric) => [`derived_metric ${metric} (not paired)`, base({ claim_spec: claim({ derived_metric: metric, target_measure: "gdp", baseline_measure: "life" }) }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"]),
  ["relation comparison on a scatter (not paired)", base({ reader_task: "comparison", claim_spec: claim({ relation: "comparison", reader_task: "comparison" }) }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["same unit and phenomenon, not paired by field names", base({ measure_semantics: [gdp({ field: "a", unit: "u", phenomenon: "p" }), life({ field: "b", unit: "u", phenomenon: "p" })] }), "ok:PASS", "ok:PASS"],
  ["x_unit differs from the declaration", base({ x_unit: "EUR" }), "SEMANTIC_COMPARISON_BLOCKED", "SCATTER_AXIS_UNIT_MISMATCH"],
  ["y_unit differs from the declaration", base({ y_unit: "months" }), "SEMANTIC_COMPARISON_BLOCKED", "SCATTER_AXIS_UNIT_MISMATCH"],
  ["x_unit and y_unit equal the declarations", base({ x_unit: "USD", y_unit: "years" }), "SEMANTIC_COMPARISON_BLOCKED", "ok:PASS"],
  ["no entity_field", base({ entity_field: undefined }), "SEMANTIC_COMPARISON_BLOCKED", "SCATTER_PAIRING_FIELDS_REQUIRED"],
  ["no period_field", base({ period_field: undefined }), "SEMANTIC_COMPARISON_BLOCKED", "SCATTER_PAIRING_FIELDS_REQUIRED"],
  ["entity_field equals period_field", base({ period_field: "iso3" }), "SEMANTIC_COMPARISON_BLOCKED", "SCATTER_PAIRING_FIELDS_REQUIRED"],
  // non-scatter charts stay unchanged both ways
  ["bar comparing two units", base({ chart_type: "horizontal_bar", reader_task: "comparison", x_field: undefined, y_field: undefined, entity_field: undefined, period_field: undefined, category_field: "iso3", value_field: "gdp", claim_spec: claim({ relation: "comparison", reader_task: "comparison" }) }), "SEMANTIC_COMPARISON_BLOCKED", "SEMANTIC_COMPARISON_BLOCKED"],
  ["non-scatter relationship without declarations", base({ chart_type: "node_link", measure_semantics: undefined, claim_spec: undefined, x_field: undefined, y_field: undefined, source_field: "a", target_field: "b" }), "*", "*"],
];
const outcome = (r) => (r.ok ? `ok:${r.spec.semantic_gate.status}` : r.code);
for (const [name, params, wantOff, wantOn] of cases) {
  const off = await plan(params, false), on = await plan(params, true);
  if (wantOff === "*") { must(outcome(off) === outcome(on), `${name}: a non-scatter call must come out the same off and on (${outcome(off)} / ${outcome(on)})`); continue; }
  must(outcome(off) === wantOff || (!off.ok && off.error.startsWith(wantOff)), `${name}: off expected ${wantOff}, got ${outcome(off)} ${off.error ?? ""}`.slice(0, 400));
  must(outcome(on) === wantOn || (!on.ok && on.error.startsWith(wantOn)), `${name}: on expected ${wantOn}, got ${outcome(on)} ${on.error ?? ""}`.slice(0, 400));
}
{
  // refusals carry the field or unit to change
  const unit = await plan(base({ x_unit: "EUR" }), true);
  must(unit.error.includes("'EUR'") && unit.error.includes("'USD'") && unit.error.includes("x axis"), "the unit refusal names the given and the declared unit");
  const blocked = await plan(base({ measure_semantics: [gdp(), life({ temporal_basis: { type: "point_in_time", date: "2019" } })] }), true);
  must(blocked.error.includes("period_mismatch") && !blocked.error.includes("unit_mismatch") && !blocked.error.includes("phenomenon_mismatch"), "a paired block names only the period, not unit or phenomenon");
  // a paired plan stores the pairing, each axis's unit and the two fields
  const ok = await plan(base(), true);
  eq([ok.spec.x_unit, ok.spec.y_unit, ok.spec.semantic_gate.scatter_pair, ok.spec.entity_field, ok.spec.period_field], ["USD", "years", { x_measure: "gdp", y_measure: "life", x_field: "gdp", y_field: "life" }, "iso3", "year"], "the stored plan carries the pairing");
  const off = await plan(base({ measure_semantics: [gdp({ unit: "u", phenomenon: "p" }), life({ unit: "u", phenomenon: "p" })] }), false);
  must(off.ok && !("scatter_pair" in off.spec.semantic_gate) && off.spec.x_unit === undefined, "off: no pairing, no filled units, the spec as before");
}

// ---- 3. the chain tool refuses with the same code as the direct tool -------------------------------------------------
for (const [name, params] of [["period mismatch", base({ measure_semantics: [gdp(), life({ temporal_basis: { type: "point_in_time", date: "2019" } })] })], ["no declarations", base({ measure_semantics: undefined, claim_spec: undefined })], ["x_unit differs", base({ x_unit: "EUR" })], ["no entity_field", base({ entity_field: undefined })]]) {
  const direct = await plan(params, true);
  for (const k of Object.keys(process.env)) if (k.startsWith("NEWSROOM_")) delete process.env[k];
  process.env[SWITCH] = "1"; Object.assign(process.env, CHAIN_ENV); process.env.NEWSROOM_ARTIFACT_DIR = artifacts; process.env.NEWSROOM_TOOL_PROFILE = "visual-story";
  let chained;
  try { const r = await TOOLS.on.get("newsroom_viz_chain").execute("t", JSON.parse(JSON.stringify(params)), undefined, undefined, undefined); chained = r.content.map((c) => c.text).join("\n"); } catch (e) { chained = String(e?.message ?? e); }
  must(!direct.ok && chained.includes(direct.error.split(":")[0]), `${name}: the chain must stop with the direct tool's code ${direct.code}: ${chained.slice(0, 700)}`);
}

// ---- 4. the lint: rows of a paired scatter ----------------------------------------------------------------------
const pairedSpec = (await plan(base(), true)).spec;
const rows = (n = 5, o = {}) => Array.from({ length: n }, (_, i) => ({ iso3: `C${i}`, year: 2022, gdp: 1000 * (i + 1), life: 60 + i, ...o }));
const blockers = (spec, data) => scatterPairBlockers(spec, data);
eq(blockers(pairedSpec, rows()), [], "legal pair: different units, one object per row, one period");
must(lintVizSpec(pairedSpec, rows(), {}).blockers.every((b) => !/Scatter pairing/.test(b)), "lintVizSpec adds no pairing blocker for good rows");
must(lintVizSpec(pairedSpec, rows(3, { year: 2019 }), {}).blockers.some((b) => /rows' period is '2019'/.test(b)), "lintVizSpec reaches the pairing check and names the rows' period");
{
  const r = blockers(pairedSpec, rows(3).map((row, i) => (i === 1 ? { ...row, iso3: "C0" } : row)));
  must(r.length === 1 && /repeats 'C0'/.test(r[0]), "one object in several rows is refused");
  must(blockers(pairedSpec, [...rows(3), ...rows(3)]).some((b) => /repeats/.test(b)), "duplicate join rows are refused");
  must(blockers(pairedSpec, rows(3).map((row, i) => (i === 0 ? { ...row, iso3: "" } : row))).some((b) => /entity_field 'iso3' is empty in 1 of 3/.test(b)), "an empty object name is refused");
  must(blockers(pairedSpec, rows(3).map((row, i) => (i === 0 ? { ...row, year: null } : row))).some((b) => /period_field 'year' is empty in 1 of 3/.test(b)), "a one-sided empty period is refused");
  must(blockers(pairedSpec, rows(3).map((row, i) => ({ ...row, year: i ? 2022 : 2021 }))).some((b) => /holds 2 periods \('2021', '2022'\)/.test(b)), "two periods in the rows are refused");
  must(blockers(pairedSpec, rows(3).map(({ year, ...row }) => row)).some((b) => /Field 'year' \(period_field\) is absent/.test(b)), "an absent period column is refused");
  must(blockers(pairedSpec, rows(3).map(({ iso3, ...row }) => row)).some((b) => /Field 'iso3' \(entity_field\) is absent/.test(b)), "an absent entity column is refused");
  must(blockers({ ...pairedSpec, entity_field: undefined }, rows()).some((b) => /requires entity_field/.test(b)), "a stored plan without entity_field is refused at lint");
  must(blockers(pairedSpec, rows(3, { year: "2022-06-30" })).some((b) => /rows' period is '2022-06-30'/.test(b)), "a declared year against a different row date is refused, naming the row value");
}
{
  // declared period against the rows: date, start/end, ranges, fake and reversed dates
  const spec = (xb, yb) => ({ ...pairedSpec, semantic_gate: { ...pairedSpec.semantic_gate, measures: [{ ...pairedSpec.semantic_gate.measures[0], temporal_basis: xb }, { ...pairedSpec.semantic_gate.measures[1], temporal_basis: yb }] } });
  const pt = (date) => ({ type: "point_in_time", date, start: null, end: null });
  eq(blockers(spec(pt("2022"), pt("2022")), rows(3)), [], "declared 2022 equals the rows' 2022");
  eq(blockers(spec(pt("2022-12-31"), pt("2022")), rows(3)), [], "a declared date inside the rows' year is accepted");
  must(blockers(spec(pt("2019"), pt("2022")), rows(3)).some((b) => /x axis \(measure 'gdp'\) declares 2019/.test(b)), "x declared for another year");
  must(blockers(spec(pt("2022"), pt("2019")), rows(3)).some((b) => /y axis \(measure 'life'\) declares 2019/.test(b)), "y declared for another year");
  must(blockers(spec(pt("2022-13-45"), pt("2022")), rows(3, { year: 2022 })).length === 0, "a fake date inside the right year passes: the check reads the rows, not the calendar (limit, see report)");
  const range = (start, end) => ({ type: "period", date: null, start, end });
  eq(blockers(spec(range("2015", "2020"), range("2015", "2020")), rows(3, { year: "2015-2020" })), [], "a range declared as start/end matches a rows' label of the same range");
  must(blockers(spec(range("2015", "2020"), pt("2022")), rows(3)).some((b) => /x axis/.test(b)), "a range declared against rows' single year 2022 is refused");
  must(blockers(spec(range("2020", "2015"), range("2020", "2015")), rows(3, { year: "2015-2020" })).some((b) => /starts after it ends|start after end/.test(b)), "a reversed range is refused");
}
{
  // log scale, missing values and zeros keep their refusals; a mixed-currency axis is not caught
  const logSpec = { ...pairedSpec, x_scale: "log" };
  must(lintVizSpec(logSpec, rows(3, { gdp: 0 }), {}).blockers.some((b) => /Log x_scale requires positive values/.test(b)), "log zero is still refused");
  must(lintVizSpec(logSpec, rows(3).map((row, i) => (i ? row : { ...row, gdp: -5 })), {}).blockers.some((b) => /Log x_scale requires positive values/.test(b)), "log negative is still refused");
  must(lintVizSpec(pairedSpec, rows(3).map((row, i) => (i ? row : { ...row, life: null })), {}).blockers.some((b) => /Scatter y_field 'life' must be numeric/.test(b)), "an empty y value is still refused");
  eq(blockers(pairedSpec, rows(4).map((row, i) => ({ ...row, gdp: i < 2 ? row.gdp : row.gdp * 0.0001 }))), [], "GAP: a mixed price base or currency inside one axis is not caught");
}
{
  // a plan made without the pairing has no pairing blockers: the lint is unchanged
  const unpaired = (await plan(base({ measure_semantics: [gdp({ unit: "u", phenomenon: "p" }), life({ unit: "u", phenomenon: "p" })] }), false)).spec;
  must(lintVizSpec(unpaired, [...rows(3), ...rows(3)], {}).blockers.every((b) => !/Scatter pairing/.test(b)), "no marker, no pairing blockers");
}
// ---- 5. the generated copies are in sync with their sources -------------------------------------------------------------
for (const name of ["measure_semantics.mjs", "editorial_semantics.mjs"]) {
  const src = readFileSync(join(ROOT, "runtime/visual", name), "utf8"), out = readFileSync(join(ROOT, "runtime/pi", name), "utf8");
  must(out === `// Generated from runtime/visual/${name}. Do not edit by hand.\n${src}`, `${name}: runtime/pi copy must be the generated copy of runtime/visual`);
}
// ---- 6. the evaluator reads no environment, and the compiler path passes no option ----------------------------------------
{
  const input = { measure_semantics: [gdp(), life()], claim_spec: claim() };
  process.env[SWITCH] = "1";
  must(evaluateVisualSemantics(input).status === "BLOCK" && !evaluateVisualSemantics(input).scatter_pair, "evaluateVisualSemantics without an option ignores the switch");
  delete process.env[SWITCH];
  must(!/process\.env/.test(readFileSync(join(ROOT, "runtime/visual/editorial_semantics.mjs"), "utf8") + readFileSync(join(ROOT, "runtime/visual/measure_semantics.mjs"), "utf8")), "the visual sources read no environment");
  must(/evaluateVisualSemantics\(recipe\)/.test(readFileSync(join(ROOT, "runtime/visual/visual_compiler_v2.mjs"), "utf8")), "the visual compiler still calls it without an option");
  const withOpt = evaluateVisualSemantics(input, { scatterPair: { chart_type: "scatter", x_field: "gdp", y_field: "life" } });
  eq([withOpt.status, withOpt.scatter_pair.x_measure], ["PASS", "gdp"], "with the option the pair is compared");
  eq(evaluateVisualSemantics(input, { scatterPair: { chart_type: "horizontal_bar", x_field: "gdp", y_field: "life" } }).status, "BLOCK", "another chart_type gets today's comparison");
}
console.log(`PASS test_scatter_paired (${passed} checks)`);
