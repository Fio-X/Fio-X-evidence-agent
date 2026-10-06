// NEWSROOM_SPEED_INLINE_CLAIM=1: on the page path a chart's claim is passed to
// newsroom_viz_chain (or newsroom_viz_plan) as a template with every number
// written as a placeholder. The runtime runs the plan SQL, fills the
// placeholders from its rows, records the claim through record_claim's own
// gates, binds the claim_id to the chart and continues the chain. Needs duckdb.
//
//  1. fillClaimTemplate over data shapes (time series, ranking, share, count,
//     by-country values) and its refusals (no rows, ambiguous rows, missing
//     column, typed digits); on a zh chart a place or currency name is the
//     name the chart prints, with the raw value kept in the binding.
//  2. Source note and alt helpers.
//  3. Switch off: tool surface, descriptions and schemas equal the page line's
//     a4d4cb0 (from git; skipped when history is unavailable); record_claim's
//     output and record are unchanged with the switch off and on.
//  4. Inline flows on five data shapes (three English, two zh whose names the
//     runtime localizes): one verified claim with its template and bindings,
//     the chart bound to it, takeaway and alt written from it, the chain
//     completes; retry reuses the claim; parallel identical claims record once.
//  5. Refusals record nothing and refuse the way the original entry point does;
//     a localized name never lets a claim through that its raw value would not.
//  6. Downstream: story graph, page plan and page lint accept a chain-recorded
//     claim_id exactly as they accept one from record_claim, and still refuse
//     unverified ones.
//
// Loads runtime/pi/newsroom.ts from a type-stripped copy, like
// test_viz_chain_runtime.mjs. No provider or network access is involved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { revertNameLocalization } from "./lib_name_localization_baseline.mjs";
import { FORM_FIELDS, FORM_GUIDELINE, formWiringMask, maskFor } from "./lib_viz_form_wiring.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = "a4d4cb0";
const scratch = mkdtempSync(join(tmpdir(), "page-inline-claim-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
// The run's own environment decides nothing: every switch is set explicitly below.
for (const name of Object.keys(process.env)) if (name.startsWith("NEWSROOM_SPEED_")) delete process.env[name];
for (const name of ["NEWSROOM_PHASE", "NEWSROOM_FAULT_INJECT_TOOL_ONCE", "NEWSROOM_DUCKDB_BIN", "NEWSROOM_MOBILE_PAGES", "NEWSROOM_SHADOW_CHECKS", "NEWSROOM_HIDE_LIEFLAT"]) delete process.env[name];

const results = [];
const check = (name) => { results.push(name); };

// ---- Harness ---------------------------------------------------------------
const stub = (dir, name, source) => {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", name, "index.js"), source);
};
// Schema-shaped TypeBox stand-in so the chain's schema check has something to check.
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
// A type-stripped copy of runtime/pi/newsroom.ts from a checkout of `source`
// (this tree, or the baseline's archive) with stand-ins for the two packages.
// `patchTree(dir)` may change the copy (never the checkout) before it is loaded.
async function loadTree(label, source = ROOT, patchRegistry = null, patchTree = null) {
  const dir = mkdtempSync(join(scratch, `tree-${label}-`));
  cpSync(join(source, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(source, "config"), join(dir, "config"), { recursive: true });
  if (patchTree) patchTree(dir);
  stub(dir, "typebox", TYPEBOX);
  stub(dir, "@earendil-works/pi-ai", "export const StringEnum = (values, opts = {}) => ({ type: 'string', enum: [...values], ...opts });\n");
  const pi = join(dir, "runtime", "pi");
  if (patchRegistry) writeFileSync(join(pi, "tool_registry.mjs"), patchRegistry(readFileSync(join(pi, "tool_registry.mjs"), "utf8")));
  writeFileSync(join(pi, "newsroom.test-copy.mjs"), stripTypeScriptTypes(readFileSync(join(pi, "newsroom.ts"), "utf8"), { mode: "strip" }));
  return { mod: await import(join(pi, "newsroom.test-copy.mjs")), dir };
}
function baselineSource() {
  const dir = mkdtempSync(join(scratch, "baseline-"));
  const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", BASELINE, "runtime", "config"], { maxBuffer: 512 * 1024 * 1024 });
  if (archive.status !== 0) return null;
  writeFileSync(join(dir, "baseline.tar"), archive.stdout);
  return spawnSync("tar", ["-xf", join(dir, "baseline.tar"), "-C", dir]).status === 0 ? dir : null;
}
// Tools read the environment when they run, and descriptions, schemas and
// guidelines when they register, so the environment is set right before use.
function register(mod, env) {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const tools = new Map();
  mod.default(new Proxy({}, { get: (_, key) => (key === "registerTool" ? (tool) => tools.set(tool.name, tool) : () => {}) }));
  return tools;
}
// NEWSROOM_HERO_VALUE_GATE=0: the hero value gate is on by default now; this test compares with a4d4cb0, which has the old typed-hero path.
const BASE_ENV = {
  NEWSROOM_HERO_VALUE_GATE: "0", NEWSROOM_TOOL_PROFILE: "full", NEWSROOM_PHASE: undefined, NEWSROOM_HIDE_LIEFLAT: undefined, NEWSROOM_FAULT_INJECT_TOOL_ONCE: undefined, NEWSROOM_DUCKDB_BIN: undefined,
  NEWSROOM_SPEED_ATOMIC_ARTIFACT: "1", NEWSROOM_SPEED_CHAIN_VIZ: "1", NEWSROOM_SPEED_INLINE_CLAIM: undefined, NEWSROOM_CLAIM_SQL_LINT: undefined,
};
const ON_ENV = { ...BASE_ENV, NEWSROOM_SPEED_INLINE_CLAIM: "1" };
// fix/page-top-1003 adds three one-sentence guidelines on purpose: duckdb_query (relative windows) and newsroom_infographic_plan (page top,
// hero label). With the hero value gate off (NEWSROOM_HERO_VALUE_GATE=0, the old typed-hero path, which this test sets) they are the only difference
// from the older commit, so exactly those three sentences are masked here; everything else is still compared byte for byte.
const PAGE_TOP_SENTENCES = [/^A relative window such as /, /^The first content module after the title and dek is /, /^A hero_stat label names the subject, the measure and the period/];
const withoutPageTopSentences = (guidelines) => (Array.isArray(guidelines) ? guidelines.filter((entry) => !PAGE_TOP_SENTENCES.some((re) => re.test(String(entry)))) : guidelines);

const { mod, dir: treeDir } = await loadTree("current");
const { fillClaimTemplate, inlineSourceNote } = mod;
// The same module instance newsroom.ts imports, so the lookup the fill gets is the one the chart uses.
const { chartNameDisplay } = await import(join(treeDir, "runtime/pi/viz.mjs"));

// ---- 1. The template filler over data shapes --------------------------------
const rejects = (template, pattern, rows, measures = []) => assert.throws(() => fillClaimTemplate(template, rows, measures), (error) => {
  assert.match(error.message, /^CLAIM_TEMPLATE_ERROR: /);
  assert.match(error.message, pattern);
  return true;
}, template);
{
  const rows = [
    { country: "Chad", year: 2022, share: 70, ratio: 0.1234, big: 1234.5678, code: "TD", maybe: null, text_num: "12" },
    { country: "Congo, Dem. Rep.", year: 2021, share: 96.3, ratio: -0.05, big: -12.34, code: "CD", maybe: null, text_num: "3.5" },
    { country: "Mauritania", year: 2022, share: 19.6, ratio: 0.5, big: 0, code: "MR", maybe: null, text_num: null },
  ];
  const fill = (template) => fillClaimTemplate(template, rows).text;
  // Selectors: first/last row, numeric extreme, another column of the extreme row, a keyed lookup.
  assert.equal(fill("{first.country} to {last.country}"), "Chad to Mauritania");
  assert.equal(fill("{max.share} and {min.share}"), "96.3 and 19.6");
  assert.equal(fill("{max.share.country} ({max.share.year}); {min.share.country} ({min.share.year})"), "Congo, Dem. Rep. (2021); Mauritania (2022)");
  assert.equal(fill("{share@country=Chad} {year@code=CD} {country@year=2021}"), "70 2021 Congo, Dem. Rep.");
  assert.equal(fill("{ max.share . country }"), "Congo, Dem. Rep.", "spaces inside the braces are ignored");
  // Default formatting: integers as-is, |v| >= 1 one decimal, below 1 two significant digits; |N fixes the decimals.
  assert.equal(fill("{first.ratio} {ratio@code=CD} {first.big} {big@code=CD} {last.big} {first.share}"), "0.12 -0.05 1234.6 -12.3 0 70");
  assert.equal(fill("{first.big|2} {first.share|1} {last.ratio|3} {max.share|0} {first.ratio|4}"), "1234.57 70.0 0.500 96 0.1234");
  // Numeric text (as DuckDB prints HUGEINT) counts for extremes; nulls are skipped.
  assert.equal(fill("{max.text_num} {min.text_num} {max.text_num|1}"), "12 3.5 12.0");
  assert.deepEqual(fillClaimTemplate("No numbers here.", rows), { text: "No numbers here.", bindings: [] });
  // Text values lose control characters and are clipped to 80 characters.
  assert.equal(fillClaimTemplate("{first.name}", [{ name: `Evil\u0007\nName ${"x".repeat(100)}` }]).text, `Evil Name ${"x".repeat(70)}`);
  // Bindings name the column, row and raw value behind each placeholder.
  assert.deepEqual(fillClaimTemplate("{max.share.country} at {max.share|1}%", rows).bindings, [
    { placeholder: "{max.share.country}", column: "country", row_index: 1, value: "Congo, Dem. Rep.", text: "Congo, Dem. Rep." },
    { placeholder: "{max.share|1}", column: "share", row_index: 1, value: 96.3, text: "96.3" },
  ]);
  rejects("{median.share}", /\{median\.share\} is not a placeholder; use \{first\.col\}/, rows);
  rejects("{share}", /\{share\} names a column but not a row: write \{first\.share\}, \{last\.share\}, \{max\.share\}, \{min\.share\} or \{share@key=value\}/, rows);
  rejects("{first.share.country}", /is not a placeholder/, rows);
  rejects("{max.renewable}", /the SQL result has no column 'renewable'; result columns: country, year, share, ratio, big, code, maybe, text_num\. Alias columns in the SQL/, rows);
  rejects("{first.share-x}", /'share-x' is not a simple column name; alias the column in the SQL/, rows);
  rejects("{share@country=Atlantis}", /no result row has country = Atlantis; country values: Chad, Congo, Dem\. Rep\., Mauritania/, rows);
  rejects("{share@country=}", /name the country value after =/, rows);
  rejects("{max.maybe}", /column 'maybe' holds only null values/, rows);
  rejects("{max.country}", /column 'country' holds a non-numeric value \("Chad"\), so it has no max/, rows);
  rejects("{first.maybe}", /selects a null value \(row 0\)/, rows);
  rejects("{first.share|5}", /the \|N suffix takes 0 to 4 decimals/, rows);
  rejects("{first.country|1}", /the \|N suffix applies only to numbers/, rows);
  rejects("{first.share", /unmatched \{ or \}/, rows);
  rejects("first.share}", /unmatched \{ or \}/, rows);
  rejects("   ", /the claim is empty/, rows);

  // With the plan's value columns, max and min rank only those: {max.year} reads
  // as the year of the maximum but would select the latest year.
  const measured = (template) => fillClaimTemplate(template, rows, ["share"]).text;
  assert.equal(measured("{max.share.year} {min.share.country} {first.year} {last.year}"), "2021 Mauritania 2022 2022");
  rejects("{max.year}", /\{max\.year\}: max and min rank a measure column of this plan \(share\), and year is not one\. For the year of the row with the highest share, write \{max\.share\.year\}/, rows, ["share"]);
  rejects("{year@share=max.share}", /for the year of the row with the highest share, write \{max\.share\.year\}/, rows, ["share"]);
  rejects("{share|1}", /\{share\|1\} names a column but not a row: write \{first\.share\|1\}, \{last\.share\|1\}, \{max\.share\|1\}, \{min\.share\|1\} or \{share@key=value\|1\}/, rows, ["share"]);
  assert.equal(fillClaimTemplate("{max.year}", rows, ["missing"]).text, "2022", "value columns missing from the result restrict nothing");
  check("filler: selectors, formatting, bindings, grammar errors, measure-only extremes");
}
{ // Typed numbers: every digit run outside a placeholder is refused, years included.
  const rows = [{ year: 2020, rate: 5 }, { year: 2021, rate: 6 }];
  for (const [template, near] of [
    ["The rate was 5% in {first.year}.", "5%"],
    ["The rate fell in 2021 to {last.rate}%.", "in 2021"],
    ["Among 11 countries {first.rate} led.", "11"],
    ["The rate was five or 5.5 percent, {first.rate}.", "5.5"],
    ["Rate ٣٤ (Arabic-Indic digits) is {first.rate}.", "٣٤"],
    ["Rate {first.rate} and 7th place.", "7"],
    ["Rate {first.rate} after covid19 hit (lower-case name).", "covid19"],
    ["Rate {first.rate} for the ABC123 series.", "ABC123"],
  ]) rejects(template, new RegExp(`has a typed number \\(near "[^"]*${near.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), rows);
  // A short digit run inside an uppercase-led Latin name is a name, not a quantity.
  for (const [template, expected] of [["The G7 and G20 members: {first.rate}.", "The G7 and G20 members: 5."], ["CO2 fell to {last.rate}.", "CO2 fell to 6."], ["H5N1 cases: {first.rate}.", "H5N1 cases: 5."]]) {
    assert.equal(fillClaimTemplate(template, rows).text, expected);
  }
  check("filler: typed numbers and years are refused; short names such as G7 and CO2 are not numbers");
}
{ // Data shapes: time series, ranking, share, count, by-country values.
  const series = [[2019, 3.2, null], [2020, 8.1, 4.9], [2021, 5.4, -2.7], [2022, 3.7, -1.7], [2023, 3.6, -0.1]].map(([year, rate, change]) => ({ year, rate, change }));
  assert.equal(
    fillClaimTemplate("The rate rose from {first.rate|1}% in {first.year} to {max.rate|1}% in {max.rate.year}, then fell to {last.rate|1}% in {last.year}; it fell by {last.rate_drop|1} points over the last year.", series.map((row, i) => ({ ...row, rate_drop: i ? series[i - 1].rate - row.rate : null })), ["rate"]).text,
    "The rate rose from 3.2% in 2019 to 8.1% in 2020, then fell to 3.6% in 2023; it fell by 0.1 points over the last year.",
  );
  assert.equal(fillClaimTemplate("The latest year, {last.year}, changed {last.change|1} points on the year before.", series, ["rate"]).text, "The latest year, 2023, changed -0.1 points on the year before.");
  rejects("{first.change}", /selects a null value \(row 0\)/, series, ["rate"]);
  rejects("{last.change_total}", /no column 'change_total'/, series, ["rate"]);
  const ranking = [["Alpha", 1, 91.5], ["Beta", 2, 80.25], ["Gamma", 3, 80.25], ["Delta", 4, 12]].map(([name, rank, score]) => ({ name, rank, score }));
  assert.equal(fillClaimTemplate("{first.name} leads with {first.score|1}; {name@rank=2} is second at {score@rank=2|2}; {last.name} is last with {last.score}.", ranking, ["score"]).text, "Alpha leads with 91.5; Beta is second at 80.25; Delta is last with 12.");
  rejects("{max.score.name}", /4 rows tie for the highest score \(row_index 0, 1, 2, 3\), so name of "the" max row is ambiguous/, ranking.map((row) => ({ ...row, score: 91.5 })), ["score"]);
  rejects("{name@score=80.25}", /2 result rows have score = 80\.25 \(row_index 1, 2\), so the lookup names no single row/, ranking, ["score"]);
  const share = [["Rent", 31.2], ["Food", 12.8], ["Other", 56]].map(([segment, share_pct]) => ({ segment, share_pct }));
  assert.equal(fillClaimTemplate("{max.share_pct.segment} takes {max.share_pct|1}% of the total and {min.share_pct.segment} {min.share_pct|1}%.", share, ["share_pct"]).text, "Other takes 56.0% of the total and Food 12.8%.");
  const counts = [["Open", 12], ["Closed", 140], ["Pending", 7]].map(([status, n]) => ({ status, n }));
  assert.equal(fillClaimTemplate("{max.n.status} has {max.n} cases ({n@status=Pending} pending).", counts, ["n"]).text, "Closed has 140 cases (7 pending).");
  const byCountry = [["KEN", "Kenya", 51.2], ["UGA", "Uganda", 80.1], ["TZA", "Tanzania", 80.1], ["RWA", "Rwanda", 12]].map(([iso3, name, value]) => ({ iso3, name, value }));
  assert.equal(fillClaimTemplate("{name@iso3=KEN} stands at {value@iso3=KEN|1}; the range is {min.value|1} to {max.value|1}.", byCountry, ["value"]).text, "Kenya stands at 51.2; the range is 12.0 to 80.1.");
  rejects("{max.value.name}", /2 rows tie for the highest value \(row_index 1, 2\), so name of "the" max row is ambiguous/, byCountry, ["value"]);
  assert.equal(fillClaimTemplate("The highest value, {max.value|1}, is shared.", byCountry, ["value"]).text, "The highest value, 80.1, is shared.", "a tied extreme VALUE is not ambiguous");
  // Refusals that must be the template error and never a guess.
  rejects("{first.rate}", /the plan SQL returned no rows/, []);
  rejects("{first.rate}", /the plan SQL returned no rows/, undefined);
  rejects("{max.rate.country}", /no column 'country'; result columns: year, rate, change/, series, ["rate"]);
  rejects("{rate@year=2030}", /no result row has year = 2030; year values: 2019, 2020, 2021, 2022, 2023/, series, ["rate"]);
  rejects("{rate@year=2020}", /2 result rows have year = 2020 \(row_index 0, 1\), so the lookup names no single row/, [{ year: 2020, rate: 1 }, { year: 2020, rate: 2 }]);
  check("filler: time series, ranking, share, count and by-country shapes; no rows, ties, duplicate keys and missing columns are refused");
}
{ // A zh chart prints a place or currency name as its localized name and its claim says the same name: chartNameDisplay is the
  // chart's own lookup. The binding keeps the raw cell (value) and the raw text beside the name; numbers, other columns, values
  // the table does not know and every English chart are filled exactly as before.
  const zhPlan = (over = {}) => ({ language: "zh", reader_task: "ranking", chart_type: "horizontal_bar", title: "各经济体可再生能源占比", category_field: "code", value_field: "share", category_names: "iso3", ...over });
  const rows = [
    { code: "KEN", year: 2022, share: 88.2, other: "KEN" },
    { code: " USA ", year: 2021, share: 50.5, other: "USA" },
    { code: "HKG", year: 2022, share: 11.3, other: "HKG" },
  ];
  const lookup = chartNameDisplay(zhPlan(), rows);
  assert.equal(lookup?.mode, "iso3");
  const fill = (template, rowset = rows, names = lookup, measures = ["share"]) => fillClaimTemplate(template, rowset, measures, names);
  const FIVE = ["placeholder", "column", "row_index", "value", "text"];
  const SEVEN = [...FIVE, "raw_text", "category_names"];
  const keysOf = (filled) => filled.bindings.map((binding) => Object.keys(binding).join());
  // Every selector form prints the name and keeps the raw cell, as the database returned it, beside it.
  assert.equal(fill("{first.code}、{last.code}、{max.share.code}、{min.share.code}").text, "肯尼亚、中国香港、肯尼亚、中国香港");
  assert.deepEqual(fill("{max.share.code}").bindings, [{ placeholder: "{max.share.code}", column: "code", row_index: 0, value: "KEN", text: "肯尼亚", raw_text: "KEN", category_names: "iso3" }]);
  assert.deepEqual(fill("{code@share=50.5}").bindings, [{ placeholder: "{code@share=50.5}", column: "code", row_index: 1, value: " USA ", text: "美国", raw_text: "USA", category_names: "iso3" }], "a padded cell is still the raw value; raw_text is the formatted one");
  assert.deepEqual(fill("{first.code}、{code@share=50.5}").bindings.map((binding) => Object.keys(binding)), [SEVEN, SEVEN]);
  // Numbers, years, columns that are not the chart's name field and lookups by raw key are filled as before: five keys, no raw_text.
  const plain = fill("{max.share}%（{max.share.year}）{share@code=KEN}、{max.share.other}");
  assert.equal(plain.text, "88.2%（2022）88.2、KEN");
  assert.deepEqual(plain.bindings.map((binding) => Object.keys(binding)), Array(4).fill(FIVE));
  assert.throws(() => fill("{share@code=肯尼亚}"), /no result row has code = 肯尼亚; code values: KEN, /, "the localized name is not a lookup key; the raw value is");
  assert.throws(() => fill("{first.code|1}"), /the \|N suffix applies only to numbers/, "a name column still takes no |N");
  // |N formats a number, so it never takes a name, even where a lookup would know one for a cell that is numeric text.
  const numeric = fillClaimTemplate("{first.code|1} / {first.code}", [{ code: "840" }], [], { mode: "iso3", display: () => "美国" });
  assert.deepEqual(numeric.bindings.map((binding) => [binding.text, Object.keys(binding).length]), [["840.0", 5], ["美国", 7]]);
  // A value the table does not know, or one that is not text, is printed as it is (the chart prints it as it is).
  const odd = [{ code: "Atlantis", share: 3 }, { code: "usa", share: 2 }, { code: 840, share: 1 }];
  const oddFill = fill("{first.code}/{code@share=2}/{last.code}", odd, chartNameDisplay(zhPlan(), odd));
  assert.equal(oddFill.text, "Atlantis/usa/840");
  assert.deepEqual(oddFill.bindings.map((binding) => binding.value), ["Atlantis", "usa", 840]);
  assert.deepEqual(oddFill.bindings.map((binding) => Object.keys(binding)), Array(3).fill(FIVE));
  // Auto-resolved names, no category_names declared: an ISO 4217 currency field and a World Bank country field.
  const fx = [{ currency: "TRY", rate: 36.5 }, { currency: "GBP", rate: 0.8 }, { currency: "JPY", rate: 160.2 }];
  const fxNames = chartNameDisplay(zhPlan({ category_field: "currency", value_field: "rate", category_names: undefined }), fx);
  assert.equal(fxNames?.mode, "iso4217");
  const fxFill = fill("欧元兑{max.rate.currency}最高，兑{min.rate.currency}最低，{first.currency}", fx, fxNames, ["rate"]);
  assert.equal(fxFill.text, "欧元兑日元最高，兑英镑最低，土耳其里拉");
  assert.deepEqual(fxFill.bindings.map((binding) => [binding.value, binding.text, binding.raw_text, binding.category_names]), [["JPY", "日元", "JPY", "iso4217"], ["GBP", "英镑", "GBP", "iso4217"], ["TRY", "土耳其里拉", "TRY", "iso4217"]]);
  const wb = [{ country: "United States", v: 3 }, { country: "Hong Kong SAR, China", v: 2 }, { country: "Chad", v: 1 }];
  const wbNames = chartNameDisplay(zhPlan({ category_field: "country", value_field: "v", category_names: undefined }), wb);
  assert.equal(wbNames?.mode, "worldbank");
  const wbFill = fill("{max.v.country}、{country@v=2}、{min.v.country}", wb, wbNames, ["v"]);
  assert.equal(wbFill.text, "美国、中国香港、乍得");
  assert.deepEqual(wbFill.bindings.map((binding) => [binding.value, binding.raw_text, binding.category_names]), [["United States", "United States", "worldbank"], ["Hong Kong SAR, China", "Hong Kong SAR, China", "worldbank"], ["Chad", "Chad", "worldbank"]]);
  // An English chart localizes nothing; no lookup and a null lookup fill the same; a template with no name is filled alike either way.
  assert.equal(chartNameDisplay(zhPlan({ language: "en" }), rows), null);
  const english = fillClaimTemplate("{max.share.code} leads at {max.share}%.", rows, ["share"]);
  assert.equal(english.text, "KEN leads at 88.2%.");
  assert.deepEqual(english, fillClaimTemplate("{max.share.code} leads at {max.share}%.", rows, ["share"], null));
  assert.deepEqual(keysOf(english), Array(2).fill(FIVE.join()));
  const numbersOnly = "{max.share}%（{max.share.year}年）至{min.share}%";
  assert.deepEqual(fill(numbersOnly), fillClaimTemplate(numbersOnly, rows, ["share"]));
  check("filler on a zh chart: name placeholders print the chart's own localized name (iso3, auto iso4217, auto World Bank) with the raw cell and text kept in the binding; numbers, other columns, unknown or non-text values, lookups by raw key and English charts are filled as before; |N on a name is still refused");
}

// ---- Investigation fixtures -------------------------------------------------
const renewable = readFileSync(join(ROOT, "fixtures/world-bank-renewable-latest.csv"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// A fresh investigation seeded the way `news investigate --data` seeds it:
// the data file is named by its content hash, with its meta record.
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
// A download record for a data file, as download_data writes it.
function writeOrigin(dir, file, fields) {
  mkdirSync(join(dir, "data", "origins"), { recursive: true });
  const origin = { schema_version: "0.7.0", origin: "download", file, ...fields };
  writeFileSync(join(dir, "data", "origins", `${sha256(JSON.stringify(origin))}.json`), `${JSON.stringify(origin, null, 2)}\n`);
}
const claimLines = (dir) => (existsSync(join(dir, "claims.jsonl")) ? readFileSync(join(dir, "claims.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);
// Everything a plan call may record: claims, plans, charts, computations and
// their query-row cache. (The chain's own timestamped event log is not one.)
const recorded = (dir) => [...(existsSync(join(dir, "claims.jsonl")) ? ["claims.jsonl"] : []), ...["visualizations", "computations", "runtime/query-rows"].flatMap((child) => walk(join(dir, child)).map((f) => relative(dir, f)))].sort();

// ---- 2. Source note ---------------------------------------------------------
{
  const dir = join(scratch, "source-notes");
  mkdirSync(dir, { recursive: true });
  process.env.NEWSROOM_ARTIFACT_DIR = dir;
  assert.equal(await inlineSourceNote(["data/a.csv"]), null, "no origins directory");
  writeOrigin(dir, "data/a.csv", { final_url: "https://ourworldindata.org/grapher/a.csv" });
  writeOrigin(dir, "data/a.csv", { final_url: "https://ourworldindata.org/grapher/a.csv?v=2", source_label: "Share of \u0007electricity\nfrom renewables" });
  writeOrigin(dir, "data/b.csv", { final_url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=UNRATE", series_title: "Unemployment Rate" });
  writeOrigin(dir, "data/c.csv", { requested_url: "https://www.example.org/api/x" });
  writeOrigin(dir, "data/d.csv", { final_url: "https://api.example.net/v2/x", source_label: "L".repeat(200) });
  writeOrigin(dir, "data/e.csv", { final_url: "https://stats.example.gov/generator?x", source_label: "CPI annual rate", series_title: "ignored" });
  assert.equal(await inlineSourceNote(["data/a.csv", "computations/x.json"]), "ourworldindata.org: Share of electricity from renewables", "the labelled record wins; control characters are dropped");
  assert.equal(await inlineSourceNote(["data/b.csv"]), "fred.stlouisfed.org: Unemployment Rate");
  assert.equal(await inlineSourceNote(["data/c.csv"]), "example.org", "host alone without a label; www. is dropped");
  assert.equal(await inlineSourceNote(["data/e.csv"]), "stats.example.gov: CPI annual rate");
  assert.equal(await inlineSourceNote(["data/d.csv"]), `api.example.net: ${"L".repeat(160 - "api.example.net: ".length)}`, "clipped to 160 characters");
  assert.equal(await inlineSourceNote(["data/b.csv", "data/c.csv"]), "fred.stlouisfed.org: Unemployment Rate; example.org");
  assert.equal(await inlineSourceNote(["data/z.csv", "sources/s.json"]), null, "no origin record, no note");
  writeOrigin(dir, "data/h.csv", { final_url: "https://ourworldindata.org/grapher/h.csv", source_label: "Inflation of consumer prices \u2014 Annual changes in the cost of a basket of goods. [unit: %]" });
  assert.equal(await inlineSourceNote(["data/h.csv"]), "ourworldindata.org: Inflation of consumer prices", "the series name, without its description or unit");
  writeOrigin(dir, "data/f.csv", { origin: "local_file", original_filename: "my-data.csv", sha256: "f" });
  assert.equal(await inlineSourceNote(["data/f.csv"]), "User-supplied file my-data.csv", "a local import names its file");
  writeOrigin(dir, "data/g.csv", { origin: "local_file" });
  assert.equal(await inlineSourceNote(["data/g.csv"]), null, "a local import without a name");
  check("source note: host and series label of the download record, the name of a supplied file, nothing when no origin names the file");
}

// ---- 3. Switch off: the page line's tool surface is unchanged ----------------
// Two intended differences from the page line, both only in viz_plan and viz_chain. measure_semantics is the full schema again (the page
// line registers a weaker duplicate). strip_plot, stacked_bar_100 and mirrored_bar are wired into the plan path: three chart_type values,
// fourteen fields, three guideline sentences (scripts/lib_viz_form_wiring.mjs removes exactly those). Mask only these here;
// test_viz_plan_schema.mjs asserts the full measure_semantics schema and the form wiring itself.
const maskMeasureSemantics = (name, parameters) => (["newsroom_viz_plan", "newsroom_viz_chain"].includes(name) && parameters?.properties?.measure_semantics ? { ...parameters, properties: { ...parameters.properties, measure_semantics: "masked" } } : parameters);
// The other declared difference from the page line: the category_names enum and wording on newsroom_viz_plan and
// newsroom_viz_chain, and two viz_plan guideline sentences (zh-names-1003). `current: true` puts the old wording back with
// revertNameLocalization, which refuses a surface that lacks exactly those edits; the form wiring is masked by maskFor (forms-1003).
// Everything else is still compared byte for byte.
// The second and third intended differences (fast-fail-1003): item 3, one explanatory_dimension vocabulary (semantic novelty and the infographic
// plan take every story-graph value) and item 4 (one guidance clause on the infographic plan's quantity_kind). Only the enum of that field and
// that one description are masked, in the baseline and in the current tree alike. It is a loud failure if either field moves.
const maskApprovedChanges = (name, parameters) => {
  if (!["newsroom_semantic_novelty", "newsroom_infographic_plan"].includes(name)) return parameters;
  const masked = JSON.parse(JSON.stringify(parameters));
  const module = masked?.properties?.modules?.items?.properties;
  assert.ok(Array.isArray(module?.explanatory_dimension?.enum), `${name} keeps its explanatory_dimension enum`);
  module.explanatory_dimension.enum = "masked";
  if (name === "newsroom_infographic_plan") {
    const kind = module?.quantitative_encoding?.properties?.quantity_kind;
    assert.ok(Array.isArray(kind?.enum), `${name} keeps its quantity_kind enum`);
    kind.description = "masked";
  }
  return masked;
};
const surface = (tools, { current = false } = {}) => [...tools.entries()].map(([name, tool]) => {
  const t = current ? revertNameLocalization(tool) : tool;
  return [name, JSON.stringify({ label: t.label, description: t.description, promptSnippet: t.promptSnippet, promptGuidelines: withoutPageTopSentences(t.promptGuidelines), parameters: maskApprovedChanges(name, maskMeasureSemantics(name, t.parameters)) }, maskFor(name))];
});
const baselineDir = baselineSource();
const baseline = baselineDir ? (await loadTree("baseline", baselineDir)).mod : null;
if (!baseline) console.log(`git history for ${BASELINE} is unavailable; skipping the comparison with the page line`);
const PROFILES = ["full", "investigate", "competition", "visual", "visual-story", "publication"];
const PHASES = [undefined, "design", "verify", "verify,design"];
if (baseline) {
  let compared = 0;
  const same = (label, env, current = mod) => {
    const [a, b] = [surface(register(baseline, env)), surface(register(current, env), { current: true })];
    assert.deepEqual(b.map(([n]) => n), a.map(([n]) => n), `${label}: tool list`);
    for (const [i, [name, json]] of a.entries()) assert.equal(b[i][1], json, `${label}: ${name} definition changed`);
    compared += a.length;
  };
  for (const profile of PROFILES) {
    for (const phase of PHASES) {
      const base = { ...BASE_ENV, NEWSROOM_TOOL_PROFILE: profile, NEWSROOM_PHASE: phase };
      // Off: unset, anything but exactly "1", with the chain and atomic writes on or off.
      for (const inline of [undefined, "", "0", "true", "yes", "01", "1 "]) same(`${profile}/${phase}/inline=${JSON.stringify(inline)}`, { ...base, NEWSROOM_SPEED_INLINE_CLAIM: inline });
      // "1" alone does nothing: it needs the chain and atomic writes, both exactly "1".
      same(`${profile}/${phase}/no chain`, { ...base, NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_CHAIN_VIZ: undefined });
      same(`${profile}/${phase}/chain true`, { ...base, NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_CHAIN_VIZ: "true" });
      for (const atomic of [undefined, "0", "true"]) same(`${profile}/${phase}/atomic=${atomic}`, { ...base, NEWSROOM_SPEED_INLINE_CLAIM: "1", NEWSROOM_SPEED_ATOMIC_ARTIFACT: atomic });
    }
  }
  // A phase or profile that hides record_claim or duckdb_query is not bypassed.
  for (const [profile, phase] of [["full", "design"], ["full", "verify"], ["publication", undefined], ["full", "design,publish"]]) same(`${profile}/${phase}: record_claim or duckdb_query hidden`, { ...BASE_ENV, NEWSROOM_TOOL_PROFILE: profile, NEWSROOM_PHASE: phase, NEWSROOM_SPEED_INLINE_CLAIM: "1" });
  check(`switch off or unavailable: ${compared} tool definitions (list, label, description, guidelines, schema) equal ${BASELINE} across ${PROFILES.length} profiles x ${PHASES.length} phases`);
  {
    // The declared name-localization edits are real (the current surface differs from the page line's) and the revert is
    // strict (it refuses a surface that does not carry them), so neither a reverted change nor a spread one passes quietly.
    const [old, now] = [register(baseline, { ...BASE_ENV }), register(mod, { ...BASE_ENV })];
    for (const name of ["newsroom_viz_plan", "newsroom_viz_chain"]) {
      assert.notEqual(JSON.stringify(now.get(name).parameters), JSON.stringify(old.get(name).parameters), `${name}: the category_names edit is present in the current surface`);
      assert.throws(() => revertNameLocalization(old.get(name)), /name localization: .* carries the declared edit/, `${name}: a surface without the edits is refused`);
    }
    assert.notDeepEqual(now.get("newsroom_viz_plan").promptGuidelines, old.get("newsroom_viz_plan").promptGuidelines, "the two viz_plan guideline edits are present");
    check("name localization: the declared category_names edits are present on viz_plan and viz_chain, and reverting a surface that lacks them is refused");
  }

  // On: exactly newsroom_viz_plan, record_claim (one guideline) and newsroom_viz_chain differ.
  for (const profile of ["full", "investigate", "competition", "visual", "visual-story"]) {
    for (const phase of [undefined, "verify,design"]) {
      const env = { ...ON_ENV, NEWSROOM_TOOL_PROFILE: profile, NEWSROOM_PHASE: phase };
      const [before, after] = [register(baseline, { ...env, NEWSROOM_SPEED_INLINE_CLAIM: undefined }), register(mod, env)];
      assert.deepEqual([...after.keys()], [...before.keys()], `${profile}/${phase}: same tools in the same order`);
      const changed = [...after.keys()].filter((name) => JSON.stringify([after.get(name).description, withoutPageTopSentences(after.get(name).promptGuidelines), maskApprovedChanges(name, after.get(name).parameters)]) !== JSON.stringify([before.get(name).description, withoutPageTopSentences(before.get(name).promptGuidelines), maskApprovedChanges(name, before.get(name).parameters)]));
      assert.deepEqual(changed.sort(), ["newsroom_viz_chain", "newsroom_viz_plan", "record_claim"], `${profile}/${phase}: only these tools change`);
      const [plan0, plan1, rc0, rc1, chain1] = [before.get("newsroom_viz_plan"), revertNameLocalization(after.get("newsroom_viz_plan")), before.get("record_claim"), after.get("record_claim"), revertNameLocalization(after.get("newsroom_viz_chain"))];
      // record_claim: same description and schema, one more guideline.
      assert.equal(rc1.description, rc0.description);
      assert.deepEqual(rc1.parameters, rc0.parameters);
      assert.deepEqual(rc1.promptGuidelines.slice(0, rc0.promptGuidelines.length), rc0.promptGuidelines);
      assert.equal(rc1.promptGuidelines.length, rc0.promptGuidelines.length + 1);
      assert.match(rc1.promptGuidelines.at(-1), /^A claim that belongs to one chart is not recorded here: pass claim and claim_kind to newsroom_viz_chain/);
      // newsroom_viz_plan: claim, claim_kind and claim_caveat follow claim_id; takeaway, alt and source_note become optional.
      // The form wiring (fourteen more properties, three more chart_type values, a longer category_names description) is not what the switch
      // changes: compare without it, and require the fourteen fields in the plan and, in the same order, in the chain.
      const unwired = (value) => JSON.parse(JSON.stringify(value, formWiringMask));
      const keys0 = Object.keys(plan0.parameters.properties);
      const keys1 = Object.keys(plan1.parameters.properties).filter((key) => !FORM_FIELDS.includes(key));
      assert.deepEqual(FORM_FIELDS.filter((key) => !(key in plan1.parameters.properties)), [], "the plan registers every form field");
      assert.deepEqual(keys1, keys0.flatMap((key) => (key === "claim_id" ? [key, "claim", "claim_kind", "claim_caveat"] : [key])), "the shared properties keep their order");
      for (const key of keys0) if (!["takeaway", "alt", "source_note", "measure_semantics"].includes(key)) assert.deepEqual(unwired(plan1.parameters.properties[key]), unwired(plan0.parameters.properties[key]), `${key} is unchanged`);
      assert.deepEqual(plan1.parameters.required, plan0.parameters.required.filter((key) => !["takeaway", "alt", "source_note"].includes(key)));
      for (const key of ["claim", "claim_kind", "claim_caveat", "takeaway", "alt", "source_note"]) assert.ok(plan1.parameters.properties[key].__optional, `${key} is optional`);
      assert.deepEqual(plan1.parameters.properties.claim_kind.enum, rc1.parameters.properties.claim_kind.enum, "the same claim kinds as record_claim");
      assert.match(plan1.parameters.properties.claim.description, /\{max\.col\.other\}/);
      const guidelines1 = plan1.promptGuidelines.filter((line) => !FORM_GUIDELINE.test(line));
      assert.deepEqual(guidelines1.slice(0, plan0.promptGuidelines.length), plan0.promptGuidelines);
      assert.match(guidelines1.at(-1), /^To bind a claim to a chart without a separate record_claim turn, pass claim and claim_kind instead of claim_id/);
      assert.match(guidelines1.at(-1), /Write a place or currency name in a claim as a placeholder on the chart's name column \(for example \{max\.value\.country\}\); on a zh chart the runtime prints its localized name, so never type one\. Pass claim or claim_id, never both\.$/);
      // The chain takes the plan's parameters, so it takes the claim too.
      assert.deepEqual(Object.keys(chain1.parameters.properties).filter((key) => !FORM_FIELDS.includes(key)), [...keys1, "computation_ref"]);
      assert.deepEqual(Object.keys(chain1.parameters.properties).filter((key) => FORM_FIELDS.includes(key)), Object.keys(plan1.parameters.properties).filter((key) => FORM_FIELDS.includes(key)), "the chain takes the plan's form fields in the same order");
      assert.deepEqual(chain1.parameters.required, plan1.parameters.required);
      assert.match(chain1.description, /With claim and claim_kind instead of claim_id/);
    }
  }
  check("switch on: only newsroom_viz_plan (claim, claim_kind, claim_caveat; takeaway, alt, source_note optional), record_claim (one guideline) and newsroom_viz_chain change");
}

// ---- 4. Inline flows over five data shapes ----------------------------------
const { getBasemap } = await import(join(ROOT, "runtime/pi/basemap_registry.mjs"));
const basemap = getBasemap("naturalearth_admin0_50m");
const missingDependency = spawnSync(process.env.NEWSROOM_DUCKDB_BIN || "duckdb", ["--version"], { stdio: "ignore" }).error?.code === "ENOENT" ? "duckdb binary not found" : null;
if (missingDependency) console.log(`${missingDependency}; skipping the flow, refusal and downstream checks`);

const RECORD_KEYS = ["schema_version", "claim_id", "recorded_at", "claim", "claim_kind", "requested_status", "status", "verification", "claim_support", "source_refs", "computation_refs", "caveat"];
const INLINE_ONLY_KEYS = ["claim_template", "claim_bindings", "recorded_by"];
const gistemp = readFileSync(join(ROOT, "fixtures/realdata/nasa-gistemp-1980-2025.csv"));
const africa = Buffer.from(["country,year,share", "Chad,2022,70.0", "Guinea,2022,66.6", "Liberia,2022,92.8", "Niger,2021,79.6", "Nigeria,2021,80.3", "Zambia,2021,83.0", "Atlantis,2022,50.0"].join("\n") + "\n");
// Minimal CSV reader (quoted fields) so the expected numbers do not come from the runtime.
const csvRows = (buffer) => {
  const [head, ...lines] = buffer.toString("utf8").trim().split("\n").map((line) => [...line.matchAll(/"([^"]*)"|([^,]+)/g)].map((m) => m[1] ?? m[2]));
  return lines.map((cells) => Object.fromEntries(head.map((name, i) => [name, Number.isFinite(Number(cells[i])) ? Number(cells[i]) : cells[i]])));
};

const SHAPES = {
  ranking: {
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
  },
  "time series": {
    csv: gistemp,
    origin: { final_url: "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv", series_title: "Global temperature anomaly [unit: degrees Celsius]" },
    sql: (ref) => `SELECT year, anomaly_c FROM '${ref}' ORDER BY year`,
    kind: "descriptive",
    template: "The global temperature anomaly rose from {first.anomaly_c|2}\u00b0C in {first.year} to {last.anomaly_c|2}\u00b0C in {last.year}, and the highest annual value in the series was {max.anomaly_c|2}\u00b0C in {max.anomaly_c.year}.",
    text: "The global temperature anomaly rose from 0.26\u00b0C in 1980 to 1.19\u00b0C in 2025, and the highest annual value in the series was 1.29\u00b0C in 2024.",
    sourceNote: "data.giss.nasa.gov: Global temperature anomaly",
    plan: {
      reader_task: "change", chart_type: "line", title: "Global temperature anomaly", unit: "\u00b0C", x_field: "year", value_field: "anomaly_c",
      measure_semantics: [{ id: "anomaly", field: "anomaly_c", phenomenon: "global temperature anomaly", unit: "\u00b0C", measure_kind: "level", temporal_basis: { type: "annual_average" }, observation_status: "observed" }],
      claim_spec: { relation: "trend", reader_task: "change", target_measure: "anomaly", measure_ids: ["anomaly"] },
    },
  },
  "by-country values": {
    csv: africa, name: "africa.csv",
    origin: null,
    sql: (ref) => `SELECT country, year, share FROM '${ref}' WHERE country <> 'Atlantis' ORDER BY country`,
    kind: "descriptive",
    template: "Renewable share across the mapped countries runs from {min.share}% in {min.share.country} ({min.share.year} data) to {max.share}% in {max.share.country} ({max.share.year} data).",
    text: "Renewable share across the mapped countries runs from 66.6% in Guinea (2022 data) to 92.8% in Liberia (2022 data).",
    sourceNote: "Source: fixture",
    plan: {
      reader_task: "spatial", chart_type: "choropleth", title: "Renewable share", unit: "%", category_field: "country", value_field: "share", category_names: "worldbank",
      reference_period_field: "year", mixed_period_strategy: "explicit", basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash,
      highlight_values: [], annotations: [], source_note: "Source: fixture",
    },
  },
  // Two zh charts whose name field the runtime localizes: the claim says the names the chart prints, the binding keeps the raw codes.
  "zh economies": {
    csv: Buffer.from(["code,year,share", "HKG,2022,11.3", "KEN,2022,88.2", "CHN,2022,30.1", "BRA,2021,52.4", "NOR,2022,74.8"].join("\n") + "\n"), name: "economies.csv",
    origin: null,
    sql: (ref) => `SELECT code, year, share FROM '${ref}' ORDER BY share DESC, code`,
    kind: "comparative",
    template: "{max.share.code}的可再生能源占比最高，为{max.share}%（{max.share.year}年数据），{min.share.code}最低，为{min.share}%（{min.share.year}年数据）。",
    text: "肯尼亚的可再生能源占比最高，为88.2%（2022年数据），中国香港最低，为11.3%（2022年数据）。",
    sourceNote: "来源：测试数据",
    shown: ["肯尼亚", "挪威", "巴西", "中国", "中国香港"], raw: ["KEN", "NOR", "BRA", "CHN", "HKG"],
    plan: {
      language: "zh", reader_task: "ranking", chart_type: "horizontal_bar", complexity_budget: "low", title: "各经济体可再生能源占比", unit: "%", category_field: "code", value_field: "share", category_names: "iso3", sort: "desc",
      measure_semantics: [{ id: "renewable_pct", field: "share", phenomenon: "可再生能源占比", unit: "%", measure_kind: "share", temporal_basis: { type: "point_in_time" }, observation_status: "observed" }],
      claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "renewable_pct", measure_ids: ["renewable_pct"] },
      source_note: "来源：测试数据",
    },
  },
  "zh currencies": {
    csv: Buffer.from(["currency,rate", "TRY,36.5", "GBP,0.8", "JPY,160.2", "CHF,0.9", "USD,1.1"].join("\n") + "\n"), name: "fx.csv",
    origin: null,
    sql: (ref) => `SELECT currency, rate FROM '${ref}' ORDER BY rate DESC, currency`,
    kind: "comparative",
    template: "欧元兑{max.rate.currency}的汇率最高，为{max.rate|1}，兑{min.rate.currency}最低，为{min.rate|1}。",
    text: "欧元兑日元的汇率最高，为160.2，兑英镑最低，为0.8。",
    sourceNote: "来源：测试数据",
    shown: ["日元", "土耳其里拉", "美元", "瑞士法郎", "英镑"], raw: ["JPY", "TRY", "USD", "CHF", "GBP"],
    plan: {
      language: "zh", reader_task: "ranking", chart_type: "horizontal_bar", complexity_budget: "low", title: "欧元兑各货币汇率", unit: "每欧元兑换量", category_field: "currency", value_field: "rate", sort: "desc",
      measure_semantics: [{ id: "fx_rate", field: "rate", phenomenon: "欧元兑各货币汇率", unit: "每欧元兑换量", measure_kind: "price", temporal_basis: { type: "point_in_time" }, observation_status: "observed" }],
      claim_spec: { relation: "rank", reader_task: "ranking", target_measure: "fx_rate", measure_ids: ["fx_rate"] },
      source_note: "来源：测试数据",
    },
  },
};
const planOf = (shape, dataRef, extra = {}) => ({ ...shape.plan, sql: shape.sql(dataRef), ...extra });
const inlineParams = (shape, dataRef, extra = {}) => planOf(shape, dataRef, { claim: shape.template, claim_kind: shape.kind, ...extra });
const specOf = (dir, planRef) => JSON.parse(readFileSync(join(dir, planRef), "utf8"));
const runChain = (tools, params, id = "chain") => tools.get("newsroom_viz_chain").execute(id, params);
// Everything the chain wrote except what is timestamped; the claim ledger is compared separately.
const snapshot = (dir) => Object.fromEntries(walk(dir).map((f) => relative(dir, f)).filter((f) => f !== "runtime/tool-chain-events.jsonl" && f !== "claims.jsonl").sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const withoutTime = ({ recorded_at, ...record }) => record;

// The numbers each shape's claim must show, from the CSV with no runtime code in between.
const ORACLE = {
  ranking: (rows) => { const by = (f) => rows.reduce((a, b) => (f(b, a) ? b : a)); const hi = by((b, a) => b.renewable_energy_consumption_pct > a.renewable_energy_consumption_pct), lo = by((b, a) => b.renewable_energy_consumption_pct < a.renewable_energy_consumption_pct); return [hi.country, hi.renewable_energy_consumption_pct, hi.year, lo.country, lo.renewable_energy_consumption_pct, lo.year]; },
  "time series": (rows) => { const hi = rows.reduce((a, b) => (b.anomaly_c > a.anomaly_c ? b : a)); return [rows[0].anomaly_c, rows[0].year, rows.at(-1).anomaly_c, rows.at(-1).year, hi.anomaly_c, hi.year]; },
  "by-country values": (rows) => { const mapped = rows.filter((r) => r.country !== "Atlantis"); const hi = mapped.reduce((a, b) => (b.share > a.share ? b : a)), lo = mapped.reduce((a, b) => (b.share < a.share ? b : a)); return [lo.share, lo.country, lo.year, hi.share, hi.country, hi.year]; },
  "zh economies": (rows) => { const hi = rows.reduce((a, b) => (b.share > a.share ? b : a)), lo = rows.reduce((a, b) => (b.share < a.share ? b : a)); return [hi.code, hi.share, hi.year, lo.code, lo.share, lo.year]; },
  "zh currencies": (rows) => { const hi = rows.reduce((a, b) => (b.rate > a.rate ? b : a)), lo = rows.reduce((a, b) => (b.rate < a.rate ? b : a)); return [hi.currency, hi.rate, lo.currency, lo.rate]; },
};
const BINDINGS = {
  ranking: [["country", 0, "Congo, Dem. Rep.", "Congo, Dem. Rep."], ["renewable_energy_consumption_pct", 0, 96.3, "96.3"], ["year", 0, 2021, "2021"], ["country", 10, "Mauritania", "Mauritania"], ["renewable_energy_consumption_pct", 10, 19.6, "19.6"], ["year", 10, 2022, "2022"]],
  "time series": [["anomaly_c", 0, 0.26, "0.26"], ["year", 0, 1980, "1980"], ["anomaly_c", 45, 1.19, "1.19"], ["year", 45, 2025, "2025"], ["anomaly_c", 44, 1.29, "1.29"], ["year", 44, 2024, "2024"]],
  "by-country values": [["share", 1, 66.6, "66.6"], ["country", 1, "Guinea", "Guinea"], ["year", 1, 2022, "2022"], ["share", 2, 92.8, "92.8"], ["country", 2, "Liberia", "Liberia"], ["year", 2, 2022, "2022"]],
  // [column, row, raw value, text shown] and, for a localized name, [raw text, table mode] after them.
  "zh economies": [["code", 0, "KEN", "肯尼亚", "KEN", "iso3"], ["share", 0, 88.2, "88.2"], ["year", 0, 2022, "2022"], ["code", 4, "HKG", "中国香港", "HKG", "iso3"], ["share", 4, 11.3, "11.3"], ["year", 4, 2022, "2022"]],
  "zh currencies": [["currency", 0, "JPY", "日元", "JPY", "iso4217"], ["rate", 0, 160.2, "160.2"], ["currency", 4, "GBP", "英镑", "GBP", "iso4217"], ["rate", 4, 0.8, "0.8"]],
};
const slug = (label) => label.replace(/\W+/g, "-");
const seed = (label, shape) => {
  const story = investigation(label, { csv: shape.csv, name: shape.name });
  if (shape.origin) writeOrigin(story.dir, story.dataRef, shape.origin);
  return story;
};
// The classic way for the same decision: duckdb_query, record_claim with the filled text, then the
// chain with claim_id and the chart text the inline run wrote (same keys in the same order).
async function classicRun(label, shape, claimText, inlineSpec, env, { extra = {}, tree = mod, story: given = null } = {}) {
  const story = given ?? seed(label, shape);
  const tools = register(tree, env);
  const shown = await tools.get("duckdb_query").execute("q", { sql: shape.sql(story.dataRef) });
  const recordedClaim = await tools.get("record_claim").execute("rc", { claim: claimText, claim_kind: shape.kind, status: "supported", source_refs: [story.dataRef], computation_refs: [relative(story.dir, shown.details.path)] });
  const claimId = recordedClaim.details.claimId;
  const plan = planOf(shape, story.dataRef, { claim_id: claimId, takeaway: inlineSpec.takeaway, alt: inlineSpec.alt, source_note: inlineSpec.source_note, ...extra });
  if (plan.claim_spec) plan.claim_spec = { ...plan.claim_spec, claim_id: claimId };
  if (plan.annotations) plan.annotations = plan.annotations.map((annotation) => ({ ...annotation, claim_id: claimId }));
  return { story, claimId, out: await runChain(tools, plan, "c1") };
}

if (!missingDependency) {
  const flows = {};
  for (const [label, shape] of Object.entries(SHAPES)) {
    const story = seed(`inline-${slug(label)}`, shape);
    const tools = register(mod, ON_ENV);
    const out = await runChain(tools, inlineParams(shape, story.dataRef), "i1");
    assert.equal(out.details.chainStatus, "COMPLETE", `${label}: ${out.details.stopCode} ${out.details.stopMessage}`);
    assert.deepEqual(out.details.steps.map((step) => step.tool), ["newsroom_viz_plan", "newsroom_viz_lint", "newsroom_viz_render", "newsroom_viz_critic"]);
    // One verified claim line, with the template and the row each number was read from.
    const claims = claimLines(story.dir);
    assert.equal(claims.length, 1, `${label}: one claim line`);
    const [claim] = claims;
    assert.deepEqual(Object.keys(claim), [...RECORD_KEYS, ...INLINE_ONLY_KEYS], `${label}: record_claim's record plus the template, bindings and origin`);
    assert.match(claim.claim_id, /^claim-[0-9a-f]{16}$/);
    assert.equal(claim.claim, shape.text);
    assert.deepEqual([claim.claim_kind, claim.requested_status, claim.status, claim.caveat], [shape.kind, "supported", "verified", null]);
    assert.deepEqual([claim.verification.authority, claim.verification.publishable, claim.verification.claim_supported, claim.verification.computation_replayed], ["system", true, true, true]);
    assert.deepEqual(claim.source_refs, [story.dataRef]);
    assert.equal(claim.computation_refs.length, 1);
    assert.equal(claim.claim_template, shape.template);
    assert.equal(claim.recorded_by, "newsroom_viz_plan");
    assert.deepEqual(claim.claim_bindings.map((b) => [b.column, b.row_index, b.value, b.text, ...(b.raw_text === undefined ? [] : [b.raw_text, b.category_names])]), BINDINGS[label], `${label}: bindings`);
    for (const b of claim.claim_bindings) assert.deepEqual(Object.keys(b), ["placeholder", "column", "row_index", "value", "text", ...(b.raw_text === undefined ? [] : ["raw_text", "category_names"])], `${label}: ${b.placeholder} keys`);
    assert.deepEqual(claim.claim_bindings.map((b) => b.value), ORACLE[label](csvRows(shape.csv)), `${label}: every bound value is the CSV's own`);
    const computation = JSON.parse(readFileSync(join(story.dir, claim.computation_refs[0]), "utf8"));
    for (const b of claim.claim_bindings) assert.equal(computation.rows[b.row_index][b.column], b.value, `${label}: ${b.column}[${b.row_index}] is the SQL row's value`);
    // The chart is bound to that claim; its text is written from the claim; no inline field is stored.
    const planStep = out.details.steps[0];
    assert.deepEqual(planStep.details.claim, { claimId: claim.claim_id, text: shape.text });
    assert.ok(out.content[0].text.includes(`## newsroom_viz_plan\nClaim recorded: VERIFIED by system replay\nclaim_id: ${claim.claim_id}\nClaim: ${shape.text}\nChart text: takeaway and alt were written from this claim.\nVisualization plan recorded.`));
    const spec = specOf(story.dir, planStep.details.planRef);
    assert.deepEqual([spec.verification_mode, spec.publishable, spec.claim_id], ["verified", true, claim.claim_id]);
    assert.deepEqual(spec.verification, claim.verification);
    if (spec.claim_spec) assert.equal(spec.claim_spec.claim_id, claim.claim_id);
    for (const annotation of spec.annotations) assert.equal(annotation.claim_id, claim.claim_id);
    for (const key of ["claim", "claim_kind", "claim_caveat"]) assert.ok(!(key in spec), `${label}: ${key} is not stored in the plan`);
    assert.equal(spec.takeaway, shape.text);
    assert.equal(spec.alt, `${shape.plan.title}. ${shape.text}`);
    assert.equal(spec.source_note, shape.sourceNote);
    const manifest = JSON.parse(readFileSync(join(story.dir, out.details.manifestRef), "utf8"));
    assert.equal(manifest.claim_id, claim.claim_id);
    for (const ref of Object.values(manifest.variants)) {
      const svg = readFileSync(join(story.dir, ref), "utf8");
      assert.equal(svg.match(/<desc id="viz-desc(?:-mobile)?">([^<]*)<\/desc>/)?.[1]?.replaceAll("&amp;", "&"), spec.alt, `${label}: ${ref} describes the claim`);
      assert.doesNotMatch(svg, /\{(first|last|max|min)\./, `${label}: ${ref} shows no placeholder`);
      if (shape.shown) {
        // The chart prints the names its claim says: every row's localized name is a text node, no raw code is, and each name
        // the claim shows in place of a raw value is one of the chart's own text nodes.
        const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
        for (const name of shape.shown) assert.ok(texts.includes(name), `${label}: ${ref} prints ${name}`);
        for (const code of shape.raw) assert.ok(!texts.some((text) => new RegExp(`\\b${code}\\b`).test(text)), `${label}: ${ref} prints no raw ${code}`);
        for (const b of claim.claim_bindings) if (b.raw_text !== undefined) assert.ok(texts.includes(b.text), `${label}: the claim's ${b.text} is a name the chart prints`);
      }
    }
    flows[label] = { story, claim, out, spec, tools };
    // The same decision made the classic way: same claim_id, same artifacts, same ledger line.
    const classic = await classicRun(`classic-${slug(label)}`, shape, shape.text, spec, ON_ENV);
    assert.equal(classic.claimId, claim.claim_id, `${label}: the claim_id is the one duckdb_query + record_claim give`);
    assert.equal(classic.out.details.chainStatus, "COMPLETE");
    assert.deepEqual(snapshot(classic.story.dir), snapshot(story.dir), `${label}: plan, lint, render, critic and computation artifacts equal the classic flow's`);
    const [classicClaim] = claimLines(classic.story.dir);
    const { claim_template, claim_bindings, recorded_by, ...base } = claim;
    assert.deepEqual(Object.keys(classicClaim), Object.keys(base));
    assert.deepEqual(withoutTime(classicClaim), withoutTime(base), `${label}: the ledger line is record_claim's, plus three fields`);
    // And with the switch off, the classic flow is the same again.
    const off = await classicRun(`classic-off-${slug(label)}`, shape, shape.text, spec, BASE_ENV);
    assert.deepEqual(snapshot(off.story.dir), snapshot(classic.story.dir), `${label}: the classic flow is unchanged by the switch`);
    assert.deepEqual(claimLines(off.story.dir).map(withoutTime), claimLines(classic.story.dir).map(withoutTime));
    assert.deepEqual(off.out.content.map((block) => block.text), classic.out.content.map((block) => block.text), `${label}: the classic chain output is unchanged by the switch`);
  }
  check("inline flows (ranking, time series, by-country values, and two zh charts whose names the runtime localizes): one verified claim with template and row bindings (raw code and shown name for a localized name), chart bound and written from it and printing the claim's names, chain COMPLETE; artifacts and ledger line equal the classic duckdb_query + record_claim flow's; classic flow unchanged by the switch");
  void flows;
}

// ---- 4b. Retries, reuse and parallel calls ----------------------------------
if (!missingDependency) {
  const shape = SHAPES.ranking;
  const REUSED = "Claim recorded: VERIFIED by system replay (this identical claim was already recorded and verified; no new claim line)\nclaim_id: ";
  { // an identical retry reuses the verified claim
    const story = seed("retry-identical", shape);
    const tools = register(mod, ON_ENV);
    const first = await runChain(tools, inlineParams(shape, story.dataRef), "r1");
    const again = await runChain(tools, inlineParams(shape, story.dataRef), "r2");
    assert.deepEqual([first.details.chainStatus, again.details.chainStatus], ["COMPLETE", "COMPLETE"]);
    assert.equal(claimLines(story.dir).length, 1, "no duplicate claim line");
    assert.ok(!first.content[0].text.includes("no new claim line") && again.content[0].text.includes(REUSED + claimLines(story.dir)[0].claim_id));
    assert.equal(again.details.criticRef, first.details.criticRef);
  }
  { // after a critic REVISE the retry reuses the claim: still one line
    const story = seed("retry-revise", shape);
    const tools = register(mod, ON_ENV);
    const crowded = inlineParams(shape, story.dataRef, {
      complexity_budget: "exploratory",
      title: "Renewable energy consumption share by country: the latest available reading for every African country in the World Bank extract",
      subtitle: "Share of total final energy consumption that comes from renewable sources, by country, in the most recent year the World Bank series reports for it; reference years differ between countries and are shown beside each name.",
      highlight_values: ["Chad (2022)", "Congo, Dem. Rep. (2021)", "Liberia (2022)", "Niger (2021)", "Zambia (2021)"],
      annotations: [20, 40, 60, 80, 90].map((value) => ({ type: "reference_line", text: `Line ${value / 10}`, value })),
    });
    const revise = await runChain(tools, crowded, "v1");
    assert.equal(revise.details.stopCode, "REVISE", `${revise.details.stopCode} ${revise.details.stopMessage}`);
    assert.equal(revise.details.failedAt, "newsroom_viz_critic");
    assert.deepEqual(revise.details.steps.map((step) => step.tool), ["newsroom_viz_plan", "newsroom_viz_lint", "newsroom_viz_render", "newsroom_viz_critic"]);
    const [claim] = claimLines(story.dir);
    assert.equal(claimLines(story.dir).length, 1);
    assert.equal(revise.details.steps[0].details.claim.claimId, claim.claim_id);
    const retry = await runChain(tools, inlineParams(shape, story.dataRef), "v2");
    assert.equal(retry.details.chainStatus, "COMPLETE", `${retry.details.stopCode} ${retry.details.stopMessage}`);
    assert.equal(retry.details.steps[0].details.claim.claimId, claim.claim_id);
    assert.ok(retry.content[0].text.includes(REUSED + claim.claim_id));
    assert.equal(claimLines(story.dir).length, 1, "the retry after a critic REVISE appends no claim line");
  }
  { // the same claim with another claim_kind or caveat is refused, not recorded twice
    const story = seed("reuse-mismatch", shape);
    const tools = register(mod, ON_ENV);
    await runChain(tools, inlineParams(shape, story.dataRef), "m1");
    const before = { files: recorded(story.dir), claims: readFileSync(join(story.dir, "claims.jsonl"), "utf8") };
    for (const extra of [{ claim_kind: "descriptive" }, { claim_caveat: "Reference years differ." }]) {
      await assert.rejects(runChain(tools, inlineParams(shape, story.dataRef, extra), "m2"), /^Error: INLINE_CLAIM_REUSE_MISMATCH: this claim \(claim-[0-9a-f]{16}\) is already recorded and verified with a different claim_kind or caveat/);
      assert.deepEqual(recorded(story.dir), before.files, "nothing new is written");
      assert.equal(readFileSync(join(story.dir, "claims.jsonl"), "utf8"), before.claims);
    }
  }
  { // chart text is the runtime's: a takeaway that copies the template and an alt with typed numbers are replaced
    const story = seed("chart-text", shape);
    const tools = register(mod, ON_ENV);
    const out = await runChain(tools, inlineParams(shape, story.dataRef, { takeaway: shape.template, alt: "Congo, Dem. Rep. leads at 97.0% and Mauritania trails at 20.1%.", source_note: "Source: user-supplied dataset" }), "t1");
    assert.equal(out.details.chainStatus, "COMPLETE");
    const spec = specOf(story.dir, out.details.steps[0].details.planRef);
    assert.deepEqual([spec.takeaway, spec.alt, spec.source_note], [shape.text, `${shape.plan.title}. ${shape.text}`, "Source: user-supplied dataset"], "a passed source_note is kept; takeaway and alt are the claim's");
    const manifest = JSON.parse(readFileSync(join(story.dir, out.details.manifestRef), "utf8"));
    for (const ref of Object.values(manifest.variants)) assert.doesNotMatch(readFileSync(join(story.dir, ref), "utf8"), /\{(first|last|max|min)\.|97\.0%|20\.1%/, `${ref} shows no placeholder or typed number`);
    assert.equal(claimLines(story.dir)[0].claim, shape.text, "the ledger holds the filled claim, never the typed text");
  }
  { // parallel calls of one assistant message carrying the same claim record it once
    const story = seed("parallel", shape);
    const tools = register(mod, ON_ENV);
    const dot = inlineParams(shape, story.dataRef, { chart_type: "dot", title: "Renewable energy consumption share, dot plot" });
    const outs = await Promise.all([runChain(tools, inlineParams(shape, story.dataRef), "p1"), runChain(tools, dot, "p2")]);
    assert.deepEqual(outs.map((out) => out.details.chainStatus), ["COMPLETE", "COMPLETE"], outs.map((out) => `${out.details.stopCode} ${out.details.stopMessage}`).join(" | "));
    assert.equal(claimLines(story.dir).length, 1, "one claim line for two charts");
    const ids = outs.map((out) => out.details.steps[0].details.claim.claimId);
    assert.equal(ids[0], ids[1]);
    assert.equal(outs.filter((out) => out.content[0].text.includes("no new claim line")).length, 1, "exactly one of the two found the claim already recorded");
    assert.equal(new Set(outs.map((out) => out.details.manifestRef)).size, 2, "two different charts");
  }
  check("retries and reuse: identical retry and retry after a critic REVISE append no claim line; another claim_kind or caveat is refused with nothing written; typed takeaway/alt are replaced; parallel identical claims record once");
}

// ---- 5. Refusals -------------------------------------------------------------
// A refused call throws what the entry point throws and records nothing: no
// claim line, no computation, no plan. Where an original entry point refuses
// the same input, the text asserted is that entry point's own.
if (!missingDependency) {
  const shape = SHAPES.ranking;
  const col = "renewable_energy_consumption_pct";
  let refusals = 0;
  const callWith = (tools, name, params, signal) => tools.get(name).execute(`call-${refusals}`, params, signal);
  const failure = async (promise) => { try { await promise; } catch (error) { return String(error.message); } throw new Error("expected a refusal"); };
  async function refused(label, build, expected, { s = shape, env = ON_ENV, signal, tool = "newsroom_viz_chain", tree = mod } = {}) {
    refusals += 1;
    const story = seed(`refused-${refusals}`, s);
    const tools = register(tree, env);
    await assert.rejects(() => callWith(tools, tool, build(story, s), signal), typeof expected === "string" ? { message: expected } : expected, label);
    assert.deepEqual(recorded(story.dir), [], `${label}: nothing is recorded`);
    return story;
  }
  // A schema violation never reaches the plan step: the chain stops before it, with nothing recorded.
  async function schemaStopped(label, build, pattern, { s = shape } = {}) {
    refusals += 1;
    const story = seed(`refused-${refusals}`, s);
    const out = await callWith(register(mod, ON_ENV), "newsroom_viz_chain", build(story, s));
    assert.deepEqual([out.details.chainStatus, out.details.stopCode, out.details.failedAt], ["STOPPED", "SCHEMA_REJECTED", "newsroom_viz_plan"], `${label}: ${out.details.stopMessage}`);
    assert.match(out.details.stopMessage, pattern, label);
    assert.deepEqual(recorded(story.dir), [], `${label}: nothing is recorded`);
  }
  const inline = (extra) => (story, s) => inlineParams(s, story.dataRef, extra);
  const withClaim = (claim) => inline({ claim });
  const E = (code, rest = "") => new RegExp(`^Error: ${code}: ${rest}`);
  const use = (story) => { process.env.NEWSROOM_ARTIFACT_DIR = story.dir; };
  const settle = async (run) => { try { return { ok: true, value: await run() }; } catch (error) { return { ok: false, value: String(error.message) }; } };
  const stopOf = (out) => [out.details.chainStatus, out.details.stopCode, out.details.failedAt, out.details.stopMessage];
  const listing = (dir) => walk(dir).sort().map((f) => [relative(dir, f), sha256(readFileSync(f))]);
  // The classic plan for a claim already recorded: the same chart, bound by claim_id.
  const withId = (s, story, id) => {
    const params = planOf(s, story.dataRef, { claim_id: id, takeaway: s.text, alt: `${s.plan.title}. ${s.text}`, source_note: s.sourceNote });
    if (params.claim_spec) params.claim_spec = { ...params.claim_spec, claim_id: id };
    if (params.annotations) params.annotations = params.annotations.map((annotation) => ({ ...annotation, claim_id: id }));
    return params;
  };

  { // numbers typed into the claim are refused, whether or not they agree with the rows
    const typed = (digits) => new RegExp(`^Error: CLAIM_TEMPLATE_ERROR: the claim has a typed number \\(near "[^"]*${digits}[^"]*"\\); every number, years included, must be a placeholder so that no number is transcribed`);
    const yearHole = `{max.${col}.year}`;
    for (const [label, claim, digits] of [
      ["numbers that agree with the rows", shape.text, "96"],
      ["a number that disagrees with the rows", shape.text.replace("96.3", "97.0"), "97"],
      ["one number typed among placeholders", shape.template.replace(`{max.${col}}`, "96.3"), "96"],
      ["a typed year", shape.template.replace(yearHole, "2021"), "2021"],
      ["a typed count", shape.template.replace("Among the African", "Among the 11 African"), "11"],
      ["full-width digits", shape.template.replace(yearHole, "\uff12\uff10\uff12\uff11"), "\uff12\uff10\uff12\uff11"],
      ["Arabic-Indic digits", shape.template.replace(yearHole, "\u0662\u0660\u0662\u0661"), "\u0662\u0660\u0662\u0661"],
    ]) await refused(`typed: ${label}`, withClaim(claim), typed(digits));
    check("refused, nothing recorded: typed numbers (agreeing, disagreeing, a year, a count, full-width and Arabic-Indic digits)");
  }

  { // a number written in words is refused like a typed one, and the whole tree stays as it was
    const words = (near) => new RegExp(`^Error: CLAIM_TEMPLATE_ERROR: the claim has a number word \\(near "[^"]*${near}[^"]*"\\); a number written in words is still a number no row backs`);
    for (const [label, claim, near] of [
      ["Chinese count word", shape.template.replace("Among the African", "Among the 十个 African"), "十个"],
      ["English count word", shape.template.replace("Among the African", "Among the ten African"), "ten"],
      ["a fraction", shape.template.replace("Among the African", "Two-thirds of the African"), "Two-thirds"],
    ]) {
      refusals += 1;
      const story = seed(`refused-${refusals}`, shape);
      // the chain's own event log notes the refusal; every other file must be untouched
      const tree = () => listing(story.dir).filter(([file]) => file !== "runtime/tool-chain-events.jsonl");
      const before = tree();
      const tools = register(mod, ON_ENV);
      await assert.rejects(() => callWith(tools, "newsroom_viz_chain", inline({ claim })(story, shape)), words(near), label);
      assert.deepEqual(tree(), before, `${label}: the tree is unchanged`);
      assert.deepEqual(recorded(story.dir), [], `${label}: nothing is recorded`);
    }
    check("refused, nothing recorded, tree unchanged: number words (Chinese count, English count, fraction)");
  }

  { // forged refs nested inside claim_spec and annotations are never taken from the call
    const probe = async (label, extra) => {
      refusals += 1;
      const story = seed(`nested-${refusals}`, shape);
      const out = await settle(() => callWith(register(mod, ON_ENV), "newsroom_viz_plan", inlineParams(shape, story.dataRef, extra)));
      const claim = claimLines(story.dir)[0];
      return { label, out, story, claim };
    };
    const forgedId = "claim-0123456789abcdef";
    const a = await probe("annotation with a foreign claim_id", { annotations: [{ type: "reference_line", text: "Half", value: 50, claim_id: forgedId }] });
    const b = await probe("claim_spec with a foreign claim_id and refs", { claim_spec: { relation: "rank", reader_task: "ranking", target_measure: col, measure_ids: [col], claim_id: forgedId, source_refs: ["data/forged.csv"], computation_refs: ["computations/forged.json"], verified: true } });
    for (const r of [a, b]) {
      if (r.out.ok) {
        const spec = specOf(r.story.dir, r.out.value.details.planRef);
        const ids = [spec.claim_id, spec.claim_spec?.claim_id, ...(spec.annotations ?? []).map((x) => x.claim_id)].filter(Boolean);
        assert.ok(ids.every((id) => id === r.claim.claim_id), `${r.label}: every claim id in the plan is the one recorded (${ids.join(", ")})`);
        assert.ok(!JSON.stringify(spec).includes("forged"), `${r.label}: no forged ref reached the plan`);
      } else {
        assert.deepEqual(recorded(r.story.dir), [], `${r.label}: refused (${r.out.value.slice(0, 90)}) and nothing recorded`);
      }
    }
    check("nested forged refs: an annotation's or claim_spec's foreign claim_id, source_refs, computation_refs are refused or replaced by the recorded claim, never kept");
  }

  { // claim SQL lint and template direction on the inline path (NEWSROOM_CLAIM_SQL_LINT=1)
    const top = `The top reading is {max.${col}}.`; // the fixture's own template pairs max with 'lowest' in one clause, which the direction rule refuses
    const LINT_ENV = { ...ON_ENV, NEWSROOM_CLAIM_SQL_LINT: "1" };
    await refused("lint: constant in the plan SQL", (story) => inlineParams(shape, story.dataRef, { claim: top, sql: `SELECT country, year, 50.0 AS ${col}, country AS country_with_year FROM '${story.dataRef}'` }), E("CLAIM_SQL_CONSTANT", "the select-list expression 50 \\(AS "), { env: LINT_ENV });
    await refused("lint: a number as a string", (story) => inlineParams(shape, story.dataRef, { claim: top, sql: `SELECT country, year, '50' AS ${col}, country AS country_with_year FROM '${story.dataRef}'` }), E("CLAIM_SQL_CONSTANT"), { env: LINT_ENV });
    await refused("lint: VALUES joined to the data", (story) => inlineParams(shape, story.dataRef, { claim: top, sql: `SELECT d.country, d.year, v.x AS ${col}, d.country AS country_with_year FROM '${story.dataRef}' d, (VALUES (50)) v(x)` }), E("CLAIM_SQL_CONSTANT"), { env: LINT_ENV });
    await refused("lint: max placeholder beside 'lowest'", withClaim(`The lowest reading is {max.${col}}.`), E("CLAIM_TEMPLATE_DIRECTION", ".*puts a max placeholder next to .*a word for the lowest value"), { env: LINT_ENV });
    await refused("lint: min placeholder beside 最高", withClaim(`最高的是{min.${col}.country}。`), E("CLAIM_TEMPLATE_DIRECTION", ".*puts a min placeholder next to .*a word for the highest value"), { env: LINT_ENV });
    check("inline path, NEWSROOM_CLAIM_SQL_LINT=1: typed number, string number, VALUES, max beside 'lowest', min beside 最高 are refused with nothing recorded");
  }

  { // placeholders that name no single row, or no row, or no column
    const T = (detail) => new RegExp(`^Error: CLAIM_TEMPLATE_ERROR: [^\\n]*${detail}`);
    const constantMeasure = (story) => `SELECT country, year, 50.0 AS ${col}, country AS country_with_year FROM '${story.dataRef}'`;
    for (const [label, claim, detail, extra] of [
      ["an ambiguous lookup (five rows share the year)", `The reading is {${col}@year=2022}.`, "5 result rows have year = 2022 \\(row_index [0-9, ]+\\), so the lookup names no single row"],
      ["a lookup of a date no row has", `The reading is {${col}@year=2030}.`, "no result row has year = 2030; year values: 2021, 2022"],
      ["a column the SQL does not return", `{max.${col}.nation} leads.`, `no column 'nation'; result columns: country, year, ${col}, country_with_year`],
      ["max over a column that is not a plan measure", "The latest reading is {max.year}.", `max and min rank a measure column of this plan \\(${col}\\), and year is not one`],
      ["a rank with tied rows", `{max.${col}.country} leads.`, `[0-9]+ rows tie for the highest ${col} \\(row_index 0, 1`, { sql: "tie" }],
      ["an unknown placeholder form", `The median is {median.${col}}.`, "is not a placeholder; use "],
      ["a column that is not a row", `The share is {${col}}.`, "names a column but not a row"],
      ["an unmatched brace", `{max.${col}.country has the highest share.`, "the claim has an unmatched \\{ or \\}"],
      ["a SQL that returns no rows", `{max.${col}.country} leads.`, "the plan SQL returned no rows, so no placeholder can be filled", { sql: "empty" }],
    ]) {
      await refused(`rows: ${label}`, (story, s) => inlineParams(s, story.dataRef, { claim, ...(extra?.sql === "tie" ? { sql: constantMeasure(story) } : {}), ...(extra?.sql === "empty" ? { sql: `SELECT country, year, ${col}, country AS country_with_year FROM '${story.dataRef}' WHERE country = 'Nowhere'` } : {}) }), T(detail));
    }
    check("refused, nothing recorded: ambiguous lookup, absent date, missing column, max over a non-measure, ties, unknown form, bare column, unmatched brace, no rows");
  }

  { // the shape of the call: claim or claim_id, a kind, no fields the runtime writes
    await refused("claim with claim_id", inline({ claim_id: "claim-0123456789abcdef" }), E("INLINE_CLAIM_EXCLUSIVE", "pass claim to record the claim in this call, or claim_id for a claim already recorded with record_claim, not both"));
    await refused("no claim_kind", (story, s) => { const p = inlineParams(s, story.dataRef); delete p.claim_kind; return p; }, E("INLINE_CLAIM_KIND_REQUIRED", "claim_kind is required with claim \\(one of descriptive, quantitative, comparative, causal, mechanistic, predictive, uncertainty\\)"));
    await schemaStopped("unknown claim_kind", inline({ claim_kind: "proven" }), /params\.claim_kind/);
    await refused("unknown claim_kind, plan tool", inline({ claim_kind: "proven" }), E("INLINE_CLAIM_KIND_INVALID", "claim_kind must be one of "), { tool: "newsroom_viz_plan" });
    await refused("claim_kind without claim", (story, s) => { const p = inlineParams(s, story.dataRef); delete p.claim; return p; }, E("INLINE_CLAIM_REQUIRED", "claim_kind applies only together with claim"));
    await refused("claim_caveat without claim", (story, s) => { const p = inlineParams(s, story.dataRef, { claim_caveat: "Reference years differ." }); delete p.claim; delete p.claim_kind; return p; }, E("INLINE_CLAIM_REQUIRED", "claim_caveat applies only together with claim"));
    await refused("empty claim", withClaim("   "), E("INLINE_CLAIM_REQUIRED", "claim must be a non-empty sentence"));
    await schemaStopped("claim that is not text", withClaim(96.3), /params\.claim/);
    await refused("claim that is not text, plan tool", withClaim(96.3), E("INLINE_CLAIM_REQUIRED", "claim must be a non-empty sentence"), { tool: "newsroom_viz_plan" });
    await schemaStopped("caveat that is not text", inline({ claim_caveat: 5 }), /params\.claim_caveat/);
    await refused("caveat that is not text, plan tool", inline({ claim_caveat: 5 }), E("INLINE_CLAIM_CAVEAT_INVALID", "claim_caveat must be text"), { tool: "newsroom_viz_plan" });
    // model-supplied verification, publication, status, pass and hash fields are never taken
    const hostile = { verification: { authority: "model", publishable: true, claim_supported: true }, publishable: true, status: "verified", passed: true, verified: true, artifact_status: "VERIFIED", verification_mode: "draft", content_hash: "0".repeat(64), claim_hash: "0".repeat(64), source_refs: ["data/x.csv"], computation_refs: ["computations/x.json"], claim_support: { passed: true }, critic_passed: true };
    for (const [field, value] of Object.entries(hostile)) {
      await refused(`injected ${field}`, inline({ [field]: value }), E("INLINE_CLAIM_FIELD_NOT_ACCEPTED", `${field} is not a newsroom_viz_plan parameter; verification, publishable, status, passed, hash and artifact fields are written by the runtime and never taken from a call`));
    }
    await refused("injected fields together", inline({ verification: hostile.verification, publishable: true, status: "verified", passed: true }), E("INLINE_CLAIM_FIELD_NOT_ACCEPTED", "verification, publishable, status, passed are not a newsroom_viz_plan parameter"));
    await refused("injected field through the plan tool", inline({ publishable: true }), E("INLINE_CLAIM_FIELD_NOT_ACCEPTED", "publishable is not a newsroom_viz_plan parameter"), { tool: "newsroom_viz_plan" });
    check("refused, nothing recorded: claim with claim_id, missing or unknown claim_kind, kind/caveat without claim, empty or non-text claim, non-text caveat, and thirteen injected verification/status/hash fields");
  }

  { // evidence: the SQL must read a data or source file; wording the runtime cannot verify
    const values = "SELECT * FROM (VALUES ('Atlantis', 2022, 99.0)) AS t(country, year, renewable_energy_consumption_pct)";
    const write = "CREATE TABLE t AS SELECT 1 AS x";
    const original = { values: null, write: null };
    { // the original entry point's own refusal texts
      const story = seed("evidence-originals", shape);
      const tools = register(mod, ON_ENV);
      original.values = await failure(tools.get("duckdb_query").execute("q", { sql: values }));
      original.write = await failure(tools.get("duckdb_query").execute("q", { sql: write }));
      assert.match(original.values, /^SYNTHETIC_DATA_BLOCKED: EVIDENCE_REQUIRED/);
      assert.match(original.write, /^Only read-only analytical SQL is allowed/);
      assert.deepEqual(recorded(story.dir), []);
    }
    await refused("VALUES rows", inline({ sql: values }), `${original.values}`);
    await refused("write statement", inline({ sql: write }), original.write);
    await refused("literal SELECT that reads no file", inline({ sql: `SELECT 'Atlantis' AS country, 2022 AS year, 99.0 AS ${col}` }), E("INLINE_CLAIM_EVIDENCE_REQUIRED", "the plan SQL must read a downloaded or supplied data file \\(data/\\.\\.\\.\\) or a source snapshot \\(sources/\\.\\.\\.\\), so the claim has source evidence"));
    await refused("SQL reading a file outside data/ and sources/", inline({ sql: "SELECT * FROM read_csv('/etc/hosts')" }), E("INLINE_CLAIM_EVIDENCE_REQUIRED"));
    await refused("causal wording", withClaim(`{max.${col}.country} leads because of its hydropower.`), E("INLINE_CLAIM_NOT_VERIFIED", "the runtime would not verify this claim; claim_support reasons: claim_contains_unbound_causal_or_motive_language\\. No claim and no visualization plan were recorded"));
    await refused("claim_kind causal", inline({ claim_kind: "causal" }), E("INLINE_CLAIM_NOT_VERIFIED", "the runtime would not verify this claim; claim_support reasons: claim_kind_requires_external_support_review\\. No claim and no visualization plan were recorded"));
    const noOrigin = SHAPES["by-country values"];
    await refused("no source_note and no origin record", (story, s) => { const p = inlineParams(s, story.dataRef); delete p.source_note; return p; }, E("INLINE_CLAIM_SOURCE_NOTE_REQUIRED", "source_note is required here because no publisher host or series label is recorded"), { s: noOrigin });
    check("refused, nothing recorded: VALUES rows and a write statement with duckdb_query's own text, a literal SELECT, a file outside data/ and sources/, causal wording or kind, no source note without an origin record");
  }
  { // after the fact: an SVG or data file altered, a critic verdict carried to another chart
    const story = seed("after-the-fact", shape);
    const tools = register(mod, ON_ENV);
    const out = await runChain(tools, inlineParams(shape, story.dataRef), "a1");
    assert.equal(out.details.chainStatus, "COMPLETE");
    const refs = { plan_ref: out.details.steps[0].details.planRef, lint_ref: out.details.steps[1].details.lintRef, manifest_ref: out.details.manifestRef };
    const manifest = JSON.parse(readFileSync(join(story.dir, refs.manifest_ref), "utf8"));
    const classic = await classicRun("after-the-fact-classic", shape, shape.text, specOf(story.dir, refs.plan_ref), ON_ENV);
    const critic = (params) => callWith(tools, "newsroom_viz_critic", params);
    use(story);

    // The SVG altered after the render: the critic refuses, nothing is written.
    for (const [variant, pattern] of [
      ["desktop", /^Error: Desktop visualization SVG does not match its manifest hash; re-render the visualization$/],
      ["compact", /^Error: Compact visualization SVG does not match its manifest hash and render QA report; re-render the visualization$/],
    ]) {
      const file = join(story.dir, manifest.variants[variant]);
      const original = readFileSync(file);
      const altered = Buffer.from(original.toString("utf8").replace(/96\.3/g, "97.0"));
      assert.ok(!altered.equals(original), `${variant}: the SVG shows the number the test alters`);
      writeFileSync(file, altered);
      const before = listing(story.dir);
      await assert.rejects(critic(refs), pattern, `${variant} SVG altered`);
      assert.deepEqual(listing(story.dir), before, `${variant}: the refused critic writes nothing`);
      writeFileSync(file, original);
    }
    assert.equal((await critic(refs)).details.criticRef, out.details.criticRef, "with the bytes restored the critic gives the chain's own verdict");

    // A critic call that carries one chart's manifest or lint to another chart's plan is refused.
    const dot = await runChain(tools, inlineParams(shape, story.dataRef, { chart_type: "dot", title: "Renewable energy consumption share, dot plot" }), "a2");
    assert.equal(dot.details.chainStatus, "COMPLETE");
    assert.equal(claimLines(story.dir).length, 1, "the second chart reuses the claim");
    const dotRefs = { plan_ref: dot.details.steps[0].details.planRef, lint_ref: dot.details.steps[1].details.lintRef, manifest_ref: dot.details.manifestRef };
    assert.notEqual(dotRefs.manifest_ref, refs.manifest_ref);
    const carried = listing(story.dir);
    await assert.rejects(critic({ ...dotRefs, manifest_ref: refs.manifest_ref }), /^Error: Visualization manifest is not linked to the supplied plan and lint artifacts$/, "chart A's manifest with chart B's plan and lint");
    await assert.rejects(critic({ ...dotRefs, lint_ref: refs.lint_ref }), /^Error: Lint artifact does not belong to the supplied visualization plan$/, "chart A's lint with chart B's plan");
    await assert.rejects(critic({ ...dotRefs, plan_ref: refs.plan_ref }), /^Error: Lint artifact does not belong to the supplied visualization plan$/, "chart A's plan with chart B's lint");
    assert.deepEqual(listing(story.dir), carried, "the refused critic calls write nothing");

    // The data file altered after the claim was recorded, by as many bytes as it had (a size check would not notice).
    const dataFile = join(story.dir, story.dataRef);
    const originalData = readFileSync(dataFile);
    const alteredData = Buffer.from(originalData.toString("utf8").replace("96.30", "97.00"));
    assert.ok(!alteredData.equals(originalData) && alteredData.length === originalData.length);
    const [claim] = claimLines(story.dir);
    writeFileSync(dataFile, alteredData);
    const kept = listing(story.dir);
    await assert.rejects(callWith(tools, "record_claim", { claim: claim.claim, claim_kind: claim.claim_kind, status: "supported", source_refs: claim.source_refs, computation_refs: claim.computation_refs }), /^Error: INVALID_SOURCE_EVIDENCE: data bytes do not match their record \(file name hash differs from the bytes\): data\//, "the altered file is refused against its content-addressed hash before the computation replays");
    assert.deepEqual(listing(story.dir), kept, "the refused record_claim writes nothing");
    const lintAltered = await callWith(tools, "newsroom_viz_lint", { plan_ref: refs.plan_ref });
    assert.equal(lintAltered.details.passed, false, "the chart's lint is blocked once its data changed");
    assert.match(lintAltered.details.blockers.join("\n"), /claim_id 'claim-[0-9a-f]{16}' is not bound to this chart's computation/);
    // The classic flow's chart is blocked the same way.
    use(classic.story);
    writeFileSync(join(classic.story.dir, classic.story.dataRef), alteredData);
    const lintClassic = await callWith(tools, "newsroom_viz_lint", { plan_ref: classic.out.details.steps[0].details.planRef });
    assert.deepEqual([lintClassic.details.passed, lintClassic.details.blockers], [lintAltered.details.passed, lintAltered.details.blockers]);
    // A new call on the altered file is judged by the same gates in both flows: both record the claim the altered
    // rows give or both refuse it with one message (the Rust verifier is what compares a data file's hash).
    use(story);
    const again = await settle(async () => { await runChain(tools, inlineParams(shape, story.dataRef), "a3"); return claimLines(story.dir).map((line) => line.claim_id); });
    use(classic.story);
    const classicAgain = await settle(async () => {
      const shown = await callWith(tools, "duckdb_query", { sql: shape.sql(classic.story.dataRef) });
      await callWith(tools, "record_claim", { claim: again.ok ? claimLines(story.dir).at(-1).claim : shape.text, claim_kind: shape.kind, status: "supported", source_refs: [classic.story.dataRef], computation_refs: [relative(classic.story.dir, shown.details.path)] });
      return claimLines(classic.story.dir).map((line) => line.claim_id);
    });
    assert.deepEqual(again, classicAgain, "inline and classic judge the altered file alike");
    check("refused, nothing written: desktop or compact SVG altered after the render (critic), a critic call carrying another chart's manifest or lint, record_claim replay on altered data; the old chart's lint is blocked like the classic flow's; the altered file is judged alike by both flows");
  }

  { // a tool the phase or profile disables is not bypassed
    const off = (name) => (text) => text.replace(new RegExp(`("name": "${name}"[\\s\\S]*?"agent_visible": )true`), "$1false");
    { // render disabled: the chain stops before it, the claim stays recorded once
      const { mod: noRender } = await loadTree("no-render", ROOT, off("newsroom_viz_render"));
      const story = seed("render-disabled", shape);
      const tools = register(noRender, ON_ENV);
      assert.ok(!tools.has("newsroom_viz_render"));
      const stopped = await runChain(tools, inlineParams(shape, story.dataRef), "f1");
      assert.deepEqual(stopOf(stopped).slice(0, 3), ["STOPPED", "TOOL_NOT_ENABLED", "newsroom_viz_render"]);
      assert.deepEqual(stopped.details.steps.map((step) => step.tool), ["newsroom_viz_plan", "newsroom_viz_lint"]);
      assert.equal(claimLines(story.dir).length, 1, "the claim is recorded once, by the plan step that ran");
      assert.ok(!recorded(story.dir).some((file) => /^visualizations\/[0-9a-f]{64}\./.test(file)), "nothing was rendered");
      const again = await runChain(tools, inlineParams(shape, story.dataRef), "f2");
      assert.equal(again.details.stopCode, "TOOL_NOT_ENABLED");
      assert.equal(claimLines(story.dir).length, 1, "the retry reuses the claim");
      const classic = await classicRun("render-disabled-classic", shape, shape.text, specOf(story.dir, stopped.details.steps[0].details.planRef), ON_ENV, { tree: noRender });
      assert.deepEqual(stopOf(classic.out), stopOf(stopped), "the classic flow stops at the same place with the same message");
    }
    { // plan disabled: no chain and no inline claim, the surface is the page line's
      const { mod: noPlan } = await loadTree("no-plan", ROOT, off("newsroom_viz_plan"));
      const planless = register(noPlan, ON_ENV);
      assert.ok(!planless.has("newsroom_viz_plan") && !planless.has("newsroom_viz_chain"));
      if (baseline) {
        const { mod: noPlanBaseline } = await loadTree("no-plan-baseline", baselineDir, off("newsroom_viz_plan"));
        assert.deepEqual(surface(planless), surface(register(noPlanBaseline, BASE_ENV)));
      }
    }
    // Design only: record_claim and duckdb_query are hidden, so the call is the page line's own.
    if (baseline) {
      const env = { ...ON_ENV, NEWSROOM_PHASE: "design" };
      const [a, b] = [seed("design-only-a", shape), seed("design-only-b", shape)];
      use(a);
      const mine = await runChain(register(mod, env), inlineParams(shape, a.dataRef), "p1");
      use(b);
      const page = await runChain(register(baseline, { ...env, NEWSROOM_SPEED_INLINE_CLAIM: undefined }), inlineParams(shape, b.dataRef), "p1");
      assert.deepEqual(stopOf(mine), stopOf(page), "an inline-shaped call is refused exactly as the page line refuses it");
      assert.equal(mine.details.stopCode, "SCHEMA_REJECTED");
      assert.deepEqual([recorded(a.dir), recorded(b.dir)], [[], []]);
    }
    // Verify only: no chart tools at all.
    const verifying = register(mod, { ...ON_ENV, NEWSROOM_PHASE: "verify" });
    assert.ok(!verifying.has("newsroom_viz_chain") && !verifying.has("newsroom_viz_plan") && verifying.has("record_claim") && verifying.has("duckdb_query"));
    check("disabled tools: render disabled stops the chain before it with the claim recorded once and the classic flow's own message; plan disabled and design-only or verify-only phases leave the page line's surface and refusals");
  }

  { // cancellation
    const wrapper = join(scratch, "slow-duckdb.sh");
    writeFileSync(wrapper, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(wrapper, 0o755);
    const pre = new AbortController();
    pre.abort();
    { // before anything ran: the chain stops before the plan step, as the classic chain does
      const [a, b] = [seed("cancel-pre-a", shape), seed("cancel-pre-b", shape)];
      use(a);
      const chained = await callWith(register(mod, ON_ENV), "newsroom_viz_chain", inlineParams(shape, a.dataRef), pre.signal);
      use(b);
      const classic = await callWith(register(mod, BASE_ENV), "newsroom_viz_chain", withId(shape, b, "claim-0123456789abcdef"), pre.signal);
      assert.deepEqual(stopOf(chained), stopOf(classic));
      assert.deepEqual([chained.details.stopCode, chained.details.steps], ["CANCELLED", []]);
      assert.deepEqual([recorded(a.dir), recorded(b.dir)], [[], []]);
    }
    const ABORTED = E("INLINE_CLAIM_ABORTED", "the call was cancelled; no claim and no visualization plan were recorded");
    await refused("a plan call cancelled before it starts", inline({}), ABORTED, { tool: "newsroom_viz_plan", signal: pre.signal });
    for (const tool of ["newsroom_viz_chain", "newsroom_viz_plan"]) { // while the SQL runs
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 300);
      await refused(`cancelled while the SQL runs (${tool})`, inline({}), ABORTED, { tool, env: { ...ON_ENV, NEWSROOM_DUCKDB_BIN: wrapper }, signal: controller.signal });
      assert.ok(Date.now() - started < 10000, "the SQL process is stopped, not waited for");
    }
    { // the original entry point is cancelled the same way and records nothing
      const story = seed("cancel-duckdb", shape);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      await assert.rejects(callWith(register(mod, { ...BASE_ENV, NEWSROOM_DUCKDB_BIN: wrapper }), "duckdb_query", { sql: shape.sql(story.dataRef) }, controller.signal), /Process cancelled/);
      assert.deepEqual(recorded(story.dir), []);
    }
    // Between steps: what ran is kept, the claim is recorded once, the retry reuses it.
    for (const [after, steps] of [["newsroom_viz_plan", ["newsroom_viz_plan"]], ["newsroom_viz_lint", ["newsroom_viz_plan", "newsroom_viz_lint"]]]) {
      const story = seed(`cancel-after-${after}`, shape);
      const tools = register(mod, ON_ENV);
      const controller = new AbortController();
      const target = tools.get(after);
      const original = target.execute.bind(target);
      target.execute = async (...args) => { const result = await original(...args); controller.abort(); return result; };
      const stopped = await callWith(tools, "newsroom_viz_chain", inlineParams(shape, story.dataRef), controller.signal);
      assert.deepEqual(stopOf(stopped).slice(0, 3), ["STOPPED", "CANCELLED", after]);
      assert.deepEqual(stopped.details.steps.map((step) => step.tool), steps);
      assert.equal(claimLines(story.dir).length, 1, "the claim is recorded once");
      assert.ok(!recorded(story.dir).some((file) => /^visualizations\/[0-9a-f]{64}\./.test(file)), "no chart was rendered");
      target.execute = original;
      const retry = await callWith(tools, "newsroom_viz_chain", inlineParams(shape, story.dataRef));
      assert.equal(retry.details.chainStatus, "COMPLETE");
      assert.ok(retry.content[0].text.includes("no new claim line"), "the retry reuses the recorded claim");
      assert.equal(claimLines(story.dir).length, 1);
    }
    check("cancellation: before the call, while the SQL runs (process stopped, nothing recorded), and after the plan or lint step (claim recorded once and reused by the retry)");
  }

  { // wrong unit, stale references and injected fields on the classic path: the same refusals with the switch on and off
    const clash = { ...shape, plan: { ...shape.plan,
      measure_semantics: [...shape.plan.measure_semantics, { id: "reporting_year", field: "year", phenomenon: "number of reporting years", unit: "count", measure_kind: "count", temporal_basis: { type: "point_in_time" }, observation_status: "observed" }],
      claim_spec: { ...shape.plan.claim_spec, measure_ids: ["renewable_pct", "reporting_year"] } } };
    const classicClash = await failure(classicRun("unit-clash-classic", clash, clash.text, { takeaway: clash.text, alt: `${clash.plan.title}. ${clash.text}`, source_note: clash.sourceNote }, ON_ENV));
    assert.match(classicClash, /^SEMANTIC_COMPARISON_BLOCKED: .*"unit_mismatch"/);
    await refused("two measures with different units in one claim", inline({}), classicClash, { s: clash });
    await refused("two measures with different units, plan tool", inline({}), classicClash, { s: clash, tool: "newsroom_viz_plan" });

    { // a computation_ref hint that is neither the chart's computation nor one its SQL read
      const stale = `computations/${"0".repeat(64)}.json`;
      const story = seed("stale-hint", shape);
      const stopped = await runChain(register(mod, ON_ENV), inlineParams(shape, story.dataRef, { computation_ref: stale }), "s1");
      assert.deepEqual(stopOf(stopped).slice(0, 3), ["STOPPED", "CLAIM_COMPUTATION_MISMATCH", "newsroom_viz_lint"]);
      assert.equal(claimLines(story.dir).length, 1, "the claim is recorded; the stop is at lint, as in the classic flow");
      const classic = await classicRun("stale-hint-classic", shape, shape.text, specOf(story.dir, stopped.details.steps[0].details.planRef), ON_ENV, { extra: { computation_ref: stale } });
      assert.deepEqual(stopOf(classic.out), stopOf(stopped));
    }

    const causalText = "Hydropower explains why Congo, Dem. Rep. leads.";
    const outcomes = {};
    for (const [label, env] of [["on", ON_ENV], ["off", BASE_ENV]]) {
      const story = seed(`classic-${label}`, shape);
      const tools = register(mod, env);
      // An id no record has, and the id of a record the runtime did not verify, whatever the call asked for.
      const unknown = await failure(callWith(tools, "newsroom_viz_chain", withId(shape, story, "claim-0123456789abcdef")));
      assert.equal(unknown, "VERIFIED_CLAIM_REQUIRED: claim_id 'claim-0123456789abcdef' is not a verified recorded claim");
      const shown = await callWith(tools, "duckdb_query", { sql: shape.sql(story.dataRef) });
      const causal = await callWith(tools, "record_claim", { claim: causalText, claim_kind: "causal", status: "verified", verified: true, publishable: true, verification: { authority: "model", publishable: true }, source_refs: [story.dataRef], computation_refs: [relative(story.dir, shown.details.path)] });
      const [line] = claimLines(story.dir);
      assert.deepEqual([line.verification.authority, line.verification.claim_supported, line.verification.publishable], ["system", false, false], "a causal claim stays unpublishable whatever the call said");
      const unverified = await failure(callWith(tools, "newsroom_viz_chain", withId(shape, story, causal.details.claimId)));
      assert.equal(unverified, `VERIFIED_CLAIM_REQUIRED: claim_id '${causal.details.claimId}' is not a verified recorded claim`);
      // Fields a call injects into a draft plan reach the plan file as on the page line, and nothing downstream takes them.
      const injected = planOf(shape, story.dataRef, { takeaway: "x".repeat(30), alt: "y".repeat(30), source_note: "zzz", verification_mode: "draft", annotations: [], publishable: true, artifact_status: "VERIFIED", verification: { authority: "model", publishable: true, claim_supported: true }, passed: true, content_hash: "0".repeat(64) });
      const plan = await callWith(tools, "newsroom_viz_plan", injected);
      const lint = await callWith(tools, "newsroom_viz_lint", { plan_ref: plan.details.planRef });
      const lintRecord = JSON.parse(readFileSync(join(story.dir, lint.details.lintRef), "utf8"));
      const render = await callWith(tools, "newsroom_viz_render", { plan_ref: plan.details.planRef, lint_ref: lint.details.lintRef });
      const manifest = JSON.parse(readFileSync(join(story.dir, render.details.manifestRef), "utf8"));
      assert.deepEqual([plan.details.verificationMode, plan.details.publishable], ["draft", false]);
      assert.deepEqual([lintRecord.publishable, lintRecord.artifact_status], [false, "DRAFT"], "lint recomputes it");
      assert.deepEqual([manifest.publishable, manifest.artifact_status, manifest.verification.authority, manifest.verification.publishable], [false, "DRAFT", "system", false], "render recomputes it");
      const chained = await runChain(tools, injected, "h1");
      assert.deepEqual(stopOf(chained).slice(0, 3), ["STOPPED", "DRAFT", "newsroom_viz_plan"], "the chain does not render a draft");
      outcomes[label] = { unknown, causal: withoutTime(line), unverified, plan: plan.details, planFile: specOf(story.dir, plan.details.planRef), lint: [lint.details.passed, lintRecord], manifest, chain: stopOf(chained) };
    }
    assert.deepEqual(outcomes.on, outcomes.off, "on the classic path the switch changes none of it");
    check("wrong unit (two measures, one claim) refused with the classic message and nothing recorded; stale computation_ref stops at lint like the classic flow; unknown or unverified claim_id and injected verification fields behave the same with the switch on and off");
  }

  { // A localized name is how a raw value is shown, never a different claim: the claim-support rule reads the text the claim shows
    // AND the text with the raw values, so a name swap neither lets a refused claim through nor refuses one the raw text allows.
    // No code in the shipped table reads as a refused word and no name contains one, so a copy of the tree gets two stand-ins:
    // the alias WAR (for USA, shown as 美国) and a made-up economy ZZA shown as 冲突岛. The checkout's table is never changed.
    const patchNames = (dir) => {
      const file = join(dir, "runtime/pi/assets/economy-names.json");
      const asset = JSON.parse(readFileSync(file, "utf8"));
      asset.economies.push({ iso3: "ZZA", iso2: "QZ", wb_name: "Zedland", zh: "冲突岛", zh_source: "cldr" });
      asset.aliases.push({ mode: "iso3", alias: "WAR", target: "USA", source: "test only: a code whose raw text the claim-support rule refuses" });
      writeFileSync(file, `${JSON.stringify(asset, null, 2)}\n`);
    };
    const { mod: patched, dir: patchedDir } = await loadTree("patched-names", ROOT, null, patchNames);
    const { economyEntryFor: standIn } = await import(join(patchedDir, "runtime/pi/economy_names.mjs"));
    const { economyEntryFor: shipped } = await import(join(treeDir, "runtime/pi/economy_names.mjs"));
    const { evaluateClaimSupport } = await import(join(treeDir, "runtime/pi/evidence_gate.mjs"));
    assert.deepEqual([standIn("WAR", "iso3")?.zh, standIn("ZZA", "iso3")?.zh], ["美国", "冲突岛"], "the stand-ins exist in the patched copy");
    assert.deepEqual([shipped("WAR", "iso3"), shipped("ZZA", "iso3")], [null, null], "and not in the checkout's table");
    const verdict = (text) => evaluateClaimSupport({ requested_status: "supported", claim_kind: "comparative", claim: text }).passed;
    assert.deepEqual([verdict("美国的可再生能源占比最高，为90%。"), verdict("WAR的可再生能源占比最高，为90%。")], [true, false], "WAR: the shown text passes the rule, the raw one does not");
    assert.deepEqual([verdict("ZZA的可再生能源占比最高，为90%。"), verdict("冲突岛的可再生能源占比最高，为90%。")], [true, false], "ZZA: the raw text passes the rule, the shown one does not");
    const zh = SHAPES["zh economies"];
    const codes = (rows) => ({ ...zh, csv: Buffer.from(["code,year,share", ...rows].join("\n") + "\n"), name: "codes.csv" });
    const [warShape, zzaShape] = [codes(["WAR,2022,90.0", "KEN,2022,10.0"]), codes(["ZZA,2022,90.0", "KEN,2022,10.0"])];
    const top = "{max.share.code}的可再生能源占比最高，为{max.share}%。";
    const bottom = "{min.share.code}的可再生能源占比最低，为{min.share}%。";
    const REFUSED = E("INLINE_CLAIM_NOT_VERIFIED", "the runtime would not verify this claim; claim_support reasons: claim_contains_unbound_causal_or_motive_language\\. No claim and no visualization plan were recorded");
    await refused("raw value refused, shown name allowed (WAR shown as 美国)", withClaim(top), REFUSED, { s: warShape, tree: patched });
    await refused("shown name refused, raw value allowed (ZZA shown as 冲突岛)", withClaim(top), REFUSED, { s: zzaShape, tree: patched });
    // The same data and tree with the other row selected: the refusals are about the row the claim names, nothing else.
    for (const [label, shape] of [["WAR", warShape], ["ZZA", zzaShape]]) {
      const story = seed(`names-control-${label}`, shape);
      const out = await runChain(register(patched, ON_ENV), inlineParams(shape, story.dataRef, { claim: bottom }), `names-${label}`);
      assert.equal(out.details.chainStatus, "COMPLETE", `${label}: ${out.details.stopCode} ${out.details.stopMessage}`);
      const [claim] = claimLines(story.dir);
      assert.equal(claim.claim, "肯尼亚的可再生能源占比最低，为10%。");
      assert.deepEqual(claim.claim_bindings.map((b) => [b.value, b.text, b.raw_text, b.category_names]), [["KEN", "肯尼亚", "KEN", "iso3"], [10, "10", undefined, undefined]]);
    }
    check("a localized name never changes what the claim-support rule decides: a claim whose raw value trips it is refused though the shown name passes, and the reverse, each with nothing recorded; the other row of the same data completes");
  }
}

// ---- 6. Downstream: story graph, page plan and page lint ---------------------
// The page tools take the claim_id a chain recorded exactly as they take one that
// duckdb_query + record_claim recorded, and they refuse what they always refused:
// unknown or unverified ids, a critic of another chart, a DRAFT chart, a module
// citing another chart's claim.
if (!missingDependency) {
  const names = ["ranking", "time series", "by-country values"];
  const KEY = { ranking: "rank", "time series": "trend", "by-country values": "map" };
  // One investigation per flow holding all three data files, so one page stands on the three charts.
  const charts = async (label, how, specs = null) => {
    const stories = Object.fromEntries(names.map((name) => [name, seed(label, SHAPES[name])]));
    const dir = stories[names[0]].dir;
    const made = {};
    for (const name of names) {
      const shape = SHAPES[name];
      process.env.NEWSROOM_ARTIFACT_DIR = dir;
      let chain;
      if (how === "inline") chain = await runChain(register(mod, ON_ENV), inlineParams(shape, stories[name].dataRef), `page-${slug(name)}`);
      else ({ out: chain } = await classicRun(label, shape, shape.text, specs[KEY[name]].spec, ON_ENV, { story: stories[name] }));
      assert.equal(chain.details.chainStatus, "COMPLETE", `${label} ${name}: ${chain.details.stopCode} ${chain.details.stopMessage}`);
      const spec = specOf(dir, chain.details.steps[0].details.planRef);
      made[KEY[name]] = { manifestRef: chain.details.manifestRef, criticRef: chain.details.criticRef, claimId: spec.claim_id, spec };
    }
    return { dir, made, refs: Object.fromEntries(names.map((name) => [name, stories[name].dataRef])) };
  };
  const readerQuestion = "Where is renewable energy use highest, how does it vary across the mapped countries, and how far has global temperature moved?";
  const visualThesis = "A ranked comparison, a country map and a long-run line give three views of one question without sharing an axis.";
  const graphParams = (ids, over = {}) => ({
    story_id: "page", reader_question: readerQuestion, visual_thesis: visualThesis,
    nodes: [
      { id: "n-map", kind: "evidence", summary: "Renewable share differs across the mapped countries.", explanatory_dimension: "spatial", claim_ids: [ids.map] },
      { id: "n-rank", kind: "evidence", summary: "A ranking shows the leaders and the laggards.", explanatory_dimension: "rank", claim_ids: [ids.rank] },
      { id: "n-trend", kind: "outcome", summary: "The temperature anomaly has risen over the long run.", explanatory_dimension: "trend", claim_ids: [ids.trend] },
    ],
    edges: [{ from: "n-map", to: "n-rank", relation: "explains" }, { from: "n-rank", to: "n-trend", relation: "precedes" }],
    entry_node_ids: ["n-map"], answer_node_ids: ["n-trend"], ...over,
  });
  // Editorial-stage artifacts the page plan reads, written the way test_infographic_chain_runtime.mjs
  // writes them (they carry no data and no claim), and the grammar registry it loads from the root.
  const editorial = (dir) => {
    cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
    for (const child of ["discovery", "concepts", "novelty", "assets"]) mkdirSync(join(dir, "editorial", child), { recursive: true });
    writeFileSync(join(dir, "editorial/discovery/page.json"), JSON.stringify({ decision: "CONTINUE" }));
    writeFileSync(join(dir, "editorial/concepts/page.json"), JSON.stringify({ finalists: ["layered-page"] }));
    writeFileSync(join(dir, "editorial/novelty/page.json"), JSON.stringify({ concept_ref: "editorial/concepts/page.json", passed: true }));
    writeFileSync(join(dir, "editorial/assets/page.json"), JSON.stringify({ concept_ref: "editorial/concepts/page.json", concept_id: "layered-page", decision: "CONTINUE" }));
  };
  const encoding = (kind, mark, baseline) => ({ quantity_kind: kind, mark_semantics: mark, scale_type: "linear", baseline_policy: baseline, uncertainty_disclosed: false });
  const pageParams = (ids, made, graphRef, over = {}) => ({
    title: "Three views of one question", dek: "A ranking, a map and a trend line, each standing on its own verified claim.",
    alt: "A ranked bar chart, a country map and a line chart, each bound to its own claim.", layout: "feature", complexity_budget: "medium",
    intent: "Show three charts that each stand on a claim whose numbers were read from the chart's own rows.",
    primary_message: "Each chart carries its own verified claim.",
    reader_question: readerQuestion, visual_thesis: visualThesis,
    story_graph_ref: graphRef, story_arc: "question_answer", audience: "general", quality_target: "publishable", competition_profile: "editorial",
    editorial_discovery_ref: "editorial/discovery/page.json", visual_concept_ref: "editorial/concepts/page.json", selected_concept_id: "layered-page",
    novelty_ref: "editorial/novelty/page.json", asset_plan_ref: "editorial/assets/page.json",
    editorial_grammar: {
      project_id: "page", primary: "THEMATIC_MAP", supporting: ["THEN_NOW", "SPECIMEN_GRID"], available_renderer_capabilities: ["svg", "canvas2d"],
      evidence_features: ["spatial_structure", "quantity", "comparable_timepoints", "comparable_entities"],
      cognitive_goals: ["ORIENT", "MEASURE", "COMPARE"],
    },
    mobile_module_order: ["map", "rank", "trend", "resolution"],
    scene_graph: { schema_version: "0.2.0", scenes: [
      { id: "orient", pattern: "hero_with_rail", anchor_module_id: "map", sidecar_module_ids: ["rank"], primary_cognitive_goal: "ORIENT", hero_object_id: "map-countries", supporting_claim_ids: [ids.map, ids.rank], scene_budget: { max_supporting_objects: 1, max_annotations: 2, max_claims: 2 } },
      { id: "compare", pattern: "hero_with_rail", anchor_module_id: "trend", sidecar_module_ids: ["resolution"], primary_cognitive_goal: "COMPARE", hero_object_id: "trend-line", supporting_claim_ids: [ids.trend], scene_budget: { max_supporting_objects: 1, max_annotations: 1, max_claims: 1 } },
    ] },
    modules: [
      { id: "map", type: "visual", span: "full", manifest_ref: made.map.manifestRef, critic_ref: made.map.criticRef, visual_grammar: "spatial", story_node_ids: ["n-map"], story_role: "hook", priority: 1, emphasis: "hero", claim_set: [ids.map], graphic_object_ids: ["map-countries"], annotations: [{ id: "map-note", target_object_id: "map-countries", text: "Countries without data are left unshaded.", claim_id: ids.map }], visual_channels: [{ channel: "color", field: "share", role: "quantitative" }, { channel: "position", field: "country", role: "identity" }], quantitative_encoding: encoding("share", "color", "not_applicable") },
      { id: "rank", type: "visual", span: "full", manifest_ref: made.rank.manifestRef, critic_ref: made.rank.criticRef, visual_grammar: "rank", story_node_ids: ["n-rank"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: [ids.rank], graphic_object_ids: ["rank-bars"], visual_channels: [{ channel: "length", field: "renewable_energy_consumption_pct", role: "quantitative" }, { channel: "position", field: "country_with_year", role: "categorical" }], quantitative_encoding: encoding("share", "length", "zero") },
      { id: "trend", type: "visual", span: "full", manifest_ref: made.trend.manifestRef, critic_ref: made.trend.criticRef, visual_grammar: "trend", story_node_ids: ["n-trend"], story_role: "evidence", priority: 2, emphasis: "primary", claim_set: [ids.trend], graphic_object_ids: ["trend-line"], annotations: [], visual_channels: [{ channel: "position", field: "anomaly_c", role: "quantitative" }, { channel: "color", field: "year", role: "categorical" }], quantitative_encoding: encoding("index", "position", "not_applicable") },
      { id: "resolution", type: "text", span: "third", body: "Each chart stands on its own claim, so the page never mixes their scales.", claim_ids: [ids.trend], claim_set: [ids.trend], story_node_ids: ["n-trend"], story_role: "resolution", priority: 2, emphasis: "support" },
    ],
    ...over,
  });
  const inlineSide = await charts("page-inline", "inline");
  const classicSide = await charts("page-classic", "classic", inlineSide.made);
  const ids = (side) => Object.fromEntries(Object.entries(side.made).map(([key, value]) => [key, value.claimId]));
  assert.deepEqual(ids(classicSide), ids(inlineSide), "both flows record the same three claim ids");
  // The page tools over one flow's root.
  const failure = async (promise) => { try { await promise; } catch (error) { return String(error.message); } throw new Error("expected a refusal"); };
  const pageTools = (side) => { process.env.NEWSROOM_ARTIFACT_DIR = side.dir; return register(mod, ON_ENV); };
  const graphOn = async (side, over = {}) => {
    const out = await pageTools(side).get("newsroom_story_graph").execute("g", graphParams(ids(side), over));
    return { out, ref: out.content[0].text.match(/Artifact: (\S+)/)[1] };
  };
  const planOn = (side, graphRef, tweak = () => {}) => {
    const params = pageParams(ids(side), side.made, graphRef);
    tweak(params);
    return pageTools(side).get("newsroom_infographic_plan").execute("p", params);
  };
  const lintOn = (side, planRef) => pageTools(side).get("newsroom_infographic_lint").execute("l", { plan_ref: planRef });
  const moduleOf = (params, id) => params.modules.find((module) => module.id === id);
  const pageFiles = (dir) => ["editorial/story-graphs", "infographics"].flatMap((child) => walk(join(dir, child)).map((f) => relative(dir, f))).sort();
  const sides = { inline: inlineSide, classic: classicSide };
  const accepted = {};
  for (const [label, side] of Object.entries(sides)) {
    editorial(side.dir);
    const graph = await graphOn(side);
    assert.match(graph.out.content[0].text, /^PASS: visual story graph/, `${label}: the story graph takes the three claims`);
    const plan = await planOn(side, graph.ref);
    const lint = await lintOn(side, plan.details.planRef);
    assert.match(lint.content[0].text, /^PASS: infographic lint\nLint: \S+\nBlockers: none/, `${label}: the page lint passes`);
    accepted[label] = { graph, plan, lint };
  }
  assert.deepEqual(accepted.inline.graph.out.content, accepted.classic.graph.out.content, "story graph output equal");
  assert.deepEqual(accepted.inline.plan.content, accepted.classic.plan.content, "page plan output equal");
  assert.deepEqual(accepted.inline.plan.details, accepted.classic.plan.details);
  assert.deepEqual(accepted.inline.lint.content, accepted.classic.lint.content, "page lint output equal");
  assert.deepEqual(accepted.inline.lint.details, accepted.classic.lint.details);
  assert.deepEqual(snapshot(inlineSide.dir), snapshot(classicSide.dir), "story graph, page plan and lint files, with every chart file under them, are byte-equal");
  const planFile = specOf(inlineSide.dir, accepted.inline.plan.details.planRef);
  const graphFile = JSON.parse(readFileSync(join(inlineSide.dir, accepted.inline.graph.ref), "utf8"));
  for (const key of ["map", "rank", "trend"]) {
    const module = moduleOf(planFile, key);
    assert.deepEqual([module.manifest_ref, module.critic_ref, module.claim_set], [inlineSide.made[key].manifestRef, inlineSide.made[key].criticRef, [inlineSide.made[key].claimId]], `${key}: the page stands on the chain's own manifest, critic and claim`);
    const manifest = JSON.parse(readFileSync(join(inlineSide.dir, module.manifest_ref), "utf8"));
    assert.deepEqual([manifest.claim_id, manifest.publishable, manifest.artifact_status], [inlineSide.made[key].claimId, true, "VERIFIED"]);
  }
  assert.deepEqual(graphFile.nodes.map((node) => node.claim_ids[0]), [ids(inlineSide).map, ids(inlineSide).rank, ids(inlineSide).trend]);
  // The ledger: the same three lines, the inline ones carrying three audit fields more.
  const inlineLines = claimLines(inlineSide.dir), classicLines = claimLines(classicSide.dir);
  assert.deepEqual([inlineLines.length, classicLines.length], [3, 3]);
  for (const [index, line] of inlineLines.entries()) {
    const { claim_template, claim_bindings, recorded_by, ...base } = line;
    assert.deepEqual(withoutTime(classicLines[index]), withoutTime(base), `claim line ${index}`);
    assert.equal(recorded_by, "newsroom_viz_plan");
  }

  // What the page tools refused before they still refuse, the same way over a chain-recorded claim.
  const UNKNOWN = "claim-0123456789abcdef";
  const refusals = {};
  for (const [label, side] of Object.entries(sides)) {
    process.env.NEWSROOM_ARTIFACT_DIR = side.dir;
    const tools = register(mod, ON_ENV);
    const graph = accepted[label].graph.ref;
    // A claim the runtime recorded but did not verify (causal kind), through record_claim on this root.
    const shown = await tools.get("duckdb_query").execute("q", { sql: SHAPES.ranking.sql(side.refs.ranking) });
    const causal = await tools.get("record_claim").execute("rc", { claim: "Hydropower explains why Congo, Dem. Rep. leads.", claim_kind: "causal", status: "verified", verified: true, publishable: true, source_refs: [side.refs.ranking], computation_refs: [relative(side.dir, shown.details.path)] });
    const causalId = causal.details.claimId;
    // A draft chart made with the separate tools, with its own critic.
    const draftParams = planOf(SHAPES["time series"], side.refs["time series"], { takeaway: "x".repeat(30), alt: "y".repeat(30), source_note: "zzz", verification_mode: "draft" });
    const draftPlan = await tools.get("newsroom_viz_plan").execute("dp", draftParams);
    const draftLint = await tools.get("newsroom_viz_lint").execute("dl", { plan_ref: draftPlan.details.planRef });
    const draftRender = await tools.get("newsroom_viz_render").execute("dr", { plan_ref: draftPlan.details.planRef, lint_ref: draftLint.details.lintRef });
    const draftCritic = await tools.get("newsroom_viz_critic").execute("dc", { plan_ref: draftPlan.details.planRef, lint_ref: draftLint.details.lintRef, manifest_ref: draftRender.details.manifestRef });
    const before = pageFiles(side.dir);
    const graphErrors = {
      unknown: await failure(graphOn(side, { nodes: graphParams(ids(side)).nodes.map((node) => (node.id === "n-map" ? { ...node, claim_ids: [UNKNOWN] } : node)) })),
      unverified: await failure(graphOn(side, { nodes: graphParams(ids(side)).nodes.map((node) => (node.id === "n-rank" ? { ...node, claim_ids: [causalId] } : node)) })),
    };
    const planErrors = {
      unknown: await failure(planOn(side, graph, (p) => { moduleOf(p, "resolution").claim_ids = [UNKNOWN]; })),
      unverified: await failure(planOn(side, graph, (p) => { moduleOf(p, "rank").claim_ids = [causalId]; })),
      otherCritic: await failure(planOn(side, graph, (p) => { moduleOf(p, "rank").critic_ref = side.made.trend.criticRef; })),
      draft: await failure(planOn(side, graph, (p) => { moduleOf(p, "rank").manifest_ref = draftRender.details.manifestRef; moduleOf(p, "rank").critic_ref = draftCritic.details.criticRef; })),
    };
    assert.deepEqual(pageFiles(side.dir), before, `${label}: a refused story graph or page plan writes nothing`);
    // A module citing another chart's claim: the plan takes it (the claim is verified), the page lint blocks it.
    const crossPlan = await planOn(side, graph, (p) => { moduleOf(p, "rank").claim_set = [side.made.trend.claimId]; });
    const crossLint = await lintOn(side, crossPlan.details.planRef);
    refusals[label] = { graphErrors, planErrors, cross: { lint: crossLint.content[0].text.replace(/Lint: \S+/, "Lint: <ref>"), passed: crossLint.details.passed }, ids: { causalId } };
  }
  assert.deepEqual(refusals.inline, refusals.classic, "every page-level refusal is the same over a chain-recorded claim as over a record_claim one");
  const r = refusals.inline;
  assert.equal(r.graphErrors.unknown, `Story node 'n-map' references unverified claim '${UNKNOWN}'`);
  assert.equal(r.graphErrors.unverified, `Story node 'n-rank' references unverified claim '${r.ids.causalId}'`);
  assert.equal(r.planErrors.unknown, `Infographic module 'resolution' references unverified claim '${UNKNOWN}'`);
  assert.equal(r.planErrors.unverified, `Infographic module 'rank' references unverified claim '${r.ids.causalId}'`);
  assert.equal(r.planErrors.otherCritic, "Visual module 'rank' critic does not match its manifest");
  assert.match(r.planErrors.draft, /^Visual module 'rank' cannot use a DRAFT\/non-publishable visualization manifest/);
  assert.equal(r.cross.passed, false);
  assert.match(r.cross.lint, /^BLOCKED: infographic lint/);
  assert.match(r.cross.lint, /visual 'rank' claim '[^']+' is not bound to the visual's own computation: none of the claim's computations reads a data\/ or sources\/ file that this chart's SQL reads/);
  check("downstream: story graph, page plan and page lint take the three chain-recorded claims exactly as record_claim's (byte-equal artifacts); unknown or unverified claim ids, another chart's critic, a DRAFT chart are refused alike; a module citing another chart's claim is blocked by the page lint");
}

console.log(results.map((name) => `  ok  ${name}`).join("\n"));
console.log(`page inline claim: ${results.length} checks -- PASS`);
