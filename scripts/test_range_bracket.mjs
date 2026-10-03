#!/usr/bin/env node
// Covers the range_bracket viz-spec annotation end to end (validateVizSpec
// shape checks, lintVizSpec chart-type/domain/count/overlap blockers, the
// renderer's reserved-right-margin bracket+label draw and its interaction
// with category_names) plus CJK widow control in wrapText, the other
// reader-facing fix landed alongside it.
import assert from "node:assert/strict";
import { chartNameDisplay, validateVizSpec, lintVizSpec, renderVizSvg, wrapText } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const BASE = {
  schema_version: "0.7.0",
  reader_task: "ranking",
  verification_mode: "draft", // no claim store in this standalone test; annotations only require claim_id outside draft mode
  takeaway: "Eight economies draw at least 70% of final energy consumption from renewables.",
  title: "Renewable energy share, selected economies",
  alt: "Horizontal bar chart ranking ten economies by renewable energy consumption share.",
  source_note: "World Bank",
  claim_id: "range-bracket-claim",
  sql: "SELECT 1",
  unit: "%",
  direct_labels: true,
  annotations: [],
  highlight_values: [],
  category_field: "country",
  value_field: "pct",
};

// Ten real World Bank English country names (never translated by this
// test - the model must always pass these through verbatim), sorted here
// by descending pct like the renderer's own default row order.
const ROWS = [
  { country: "Congo, Dem. Rep.", pct: 96 },
  { country: "Liberia", pct: 94 },
  { country: "Zambia", pct: 89 },
  { country: "Nigeria", pct: 84 },
  { country: "Niger", pct: 79 },
  { country: "Sierra Leone", pct: 76 },
  { country: "Congo, Rep.", pct: 72 },
  { country: "Chad", pct: 71 },
  { country: "Ghana", pct: 45 },
  { country: "Kenya", pct: 38 },
];

function spec(overrides = {}) {
  return { ...BASE, chart_type: "horizontal_bar", ...overrides };
}
function bracket(overrides = {}) {
  return { type: "range_bracket", match_field: "country", match_value: "Congo, Dem. Rep.", end_match_value: "Chad", text: "8 countries draw at least 70%", ...overrides };
}
function rangeBracketBlockers(theSpec, rows = ROWS) {
  return lintVizSpec(theSpec, rows, {}).blockers.filter((b) => b.includes("range_bracket"));
}
function qaFailures(qa) {
  return qa.viewports.desktop.geometry.failures.concat(qa.viewports.desktop.contrast.failures);
}

// -- validateVizSpec: shape --
assert.deepEqual(
  validateVizSpec(spec({ annotations: [{ type: "range_bracket", match_field: "country", match_value: "Chad", text: "x" }] })),
  ["annotations[0] range_bracket requires match_field, match_value and end_match_value"],
);
assert.deepEqual(validateVizSpec(spec({ annotations: [bracket({ tone: "bold" })] })), ["annotations[0] range_bracket tone must be 'accent' when set"]);
assert.deepEqual(validateVizSpec(spec({ annotations: [bracket()] })), [], "a well-formed range_bracket has no shape errors");
assert.deepEqual(validateVizSpec(spec({ annotations: [bracket({ tone: "accent" })] })), [], "tone:'accent' is valid");

// -- lintVizSpec: chart_type blockers (only horizontal_bar and plain dot) --
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "dumbbell", start_field: "pct", end_field: "pct", annotations: [bracket()] })), ["annotations[0] range_bracket is not supported on chart_type 'dumbbell'"]);
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "line", x_field: "country", value_field: "pct", annotations: [bracket()] })), ["annotations[0] range_bracket is not supported on chart_type 'line'"]);
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "diverging_bar", annotations: [bracket()] })), ["annotations[0] range_bracket is not supported on chart_type 'diverging_bar'"]);
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "dot", annotations: [bracket()] })), [], "plain (ungrouped) dot is allowed");
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "dot", series_field: "pct", annotations: [bracket()] })), ["annotations[0] range_bracket is not supported when series_field is set (grouped dot layout)"]);

// -- lintVizSpec: match_field/match_value/end_match_value --
assert.deepEqual(rangeBracketBlockers(spec({ annotations: [bracket({ match_field: "pct" })] })), ["annotations[0] range_bracket match_field must equal category_field"]);
assert.deepEqual(rangeBracketBlockers(spec({ annotations: [bracket({ match_value: "Nowhere, Fictional" })] })), ["annotations[0] range_bracket match_value 'Nowhere, Fictional' was not found in 'country'"]);
assert.deepEqual(rangeBracketBlockers(spec({ annotations: [bracket({ end_match_value: "Nowhere, Fictional" })] })), ["annotations[0] range_bracket end_match_value 'Nowhere, Fictional' was not found in 'country'"]);

// -- lintVizSpec: at most 2, and no overlap (three genuinely non-
// overlapping ranges, so only the count blocker fires) --
assert.deepEqual(
  rangeBracketBlockers(spec({
    annotations: [
      bracket({ match_value: "Congo, Dem. Rep.", end_match_value: "Liberia", text: "a" }),
      bracket({ match_value: "Zambia", end_match_value: "Nigeria", text: "b" }),
      bracket({ match_value: "Niger", end_match_value: "Sierra Leone", text: "c" }),
    ],
  })),
  ["Visualization has 3 range_bracket annotations; maximum is 2"],
);
assert.deepEqual(
  rangeBracketBlockers(spec({ annotations: [bracket({ match_value: "Congo, Dem. Rep.", end_match_value: "Nigeria", text: "a" }), bracket({ match_value: "Niger", end_match_value: "Sierra Leone", text: "b" })] })),
  [],
  "two adjacent, non-overlapping brackets are allowed",
);
assert.deepEqual(
  rangeBracketBlockers(spec({ annotations: [bracket({ match_value: "Congo, Dem. Rep.", end_match_value: "Nigeria", text: "a" }), bracket({ match_value: "Zambia", end_match_value: "Niger", text: "b" })] })),
  ["range_bracket annotations must not overlap"],
  "ranges [0,3] and [2,4] share rows 2-3",
);

// -- valid case: renders, passes render QA, exactly one bracket path, and
// the reserved margin shrinks the plot's own right edge rather than
// growing the canvas (viewBox width unchanged) --
{
  const s = spec({ annotations: [bracket()] });
  assert.deepEqual(rangeBracketBlockers(s), []);
  const svg = renderVizSvg(s, ROWS);
  const qa = runRenderQa({ desktop: svg });
  assert.ok(qa.passed && qa.failure_count === 0, `range_bracket render QA failed: ${JSON.stringify(qaFailures(qa))}`);
  assert.equal((svg.match(/data-role="range-bracket"/g) || []).length, 1);
  assert.match(svg, /viewBox="0 0 1040 /);
}

// -- viewBox width is identical whether or not a range_bracket is present:
// a chart with no range_bracket must render exactly as it did before this
// feature existed (matching reference_line's own "only when present"
// convention for its margin) --
{
  const withBracket = renderVizSvg(spec({ annotations: [bracket()] }), ROWS);
  const withoutBracket = renderVizSvg(spec({ annotations: [] }), ROWS);
  const widthOf = (svg) => /viewBox="0 0 (\d+) /.exec(svg)[1];
  assert.equal(widthOf(withBracket), widthOf(withoutBracket));
  assert.equal((withoutBracket.match(/data-role="range-bracket"/g) || []).length, 0);
}

// -- two brackets: independent, non-overlapping spans; default and accent
// tone both draw and pass render QA; tone actually changes the stroke
// colour (never the same colour twice) --
{
  const s = spec({
    annotations: [
      bracket({ match_value: "Congo, Dem. Rep.", end_match_value: "Nigeria", text: "Top four" }),
      bracket({ match_value: "Niger", end_match_value: "Chad", text: "Next four, still above 70%", tone: "accent" }),
    ],
  });
  assert.deepEqual(rangeBracketBlockers(s), []);
  const svg = renderVizSvg(s, ROWS);
  const qa = runRenderQa({ desktop: svg });
  assert.ok(qa.passed && qa.failure_count === 0, `two-bracket render QA failed: ${JSON.stringify(qaFailures(qa))}`);
  const strokes = [...svg.matchAll(/<path data-role="range-bracket" d="[^"]+" fill="none" stroke="(#[0-9a-fA-F]+)"/g)].map((m) => m[1]);
  assert.equal(strokes.length, 2);
  assert.notEqual(strokes[0], strokes[1], "tone:'accent' must draw a visibly different line colour than the default tone");
}

// -- defence in depth: diverging_bar shares renderHorizontal with
// horizontal_bar, but lintVizSpec already blocks range_bracket there; the
// renderer must never draw a bracket for it even if a caller bypassed
// lint, so an existing diverging_bar chart's geometry can never regress --
{
  const s = spec({ chart_type: "diverging_bar", annotations: [bracket()] });
  assert.deepEqual(rangeBracketBlockers(s), ["annotations[0] range_bracket is not supported on chart_type 'diverging_bar'"]);
  const svg = renderVizSvg(s, ROWS);
  assert.equal((svg.match(/data-role="range-bracket"/g) || []).length, 0, "renderHorizontal must not draw a bracket for diverging_bar even when lint is bypassed");
}

// -- category_names + zh + range_bracket together: match_value/
// end_match_value stay the raw World Bank English names the model wrote
// (never translated by the model); the rendered category labels show the
// vendored zh name; the raw English name never appears as visible text --
{
  const s = spec({
    language: "zh",
    category_names: "worldbank",
    title: "可再生能源占比最高的经济体",
    annotations: [{ type: "range_bracket", match_field: "country", match_value: "Congo, Dem. Rep.", end_match_value: "Chad", text: "八个经济体占比超过七成", claim_id: "x" }],
  });
  assert.deepEqual(rangeBracketBlockers(s), [], "lint matches on the raw World Bank name, not the zh display name");
  const svg = renderVizSvg(s, ROWS);
  const qa = runRenderQa({ desktop: svg });
  assert.ok(qa.passed && qa.failure_count === 0, `zh + category_names range_bracket render QA failed: ${JSON.stringify(qaFailures(qa))}`);
  assert.match(svg, /刚果（金）/, "the category axis must show the vendored zh name (not a model-authored translation)");
  assert.ok(!svg.includes("Congo, Dem. Rep."), "the raw World Bank English name must not appear as chart text once category_names replaces it");
  assert.equal((svg.match(/data-role="range-bracket"/g) || []).length, 1);
}

// -- category_names lint: unmapped value blocker, up to 5 shown --
{
  const badRows = [...ROWS, { country: "Neverland", pct: 5 }];
  const lint = lintVizSpec(spec({ category_names: "worldbank" }), badRows, {});
  assert.ok(
    lint.blockers.includes("category_names='worldbank' cannot resolve 1 value(s) in 'country' (e.g. 'Neverland'); use the exact World Bank English name instead of translating it yourself"),
    JSON.stringify(lint.blockers),
  );
}

// -- category_names auto-resolution (diagnosis P6): when category_names is
// unset and every name value matches the World Bank English name table (or,
// failing that, the ISO3 table) verbatim, lint resolves it that way, records
// the mode used in the lint report, and the renderers show the localized
// name; values that do not all match keep the advisory warning and stay
// untouched; a declared category_names is never overridden --
{
  const zhTitle = "可再生能源占比最高的经济体";
  const auto = lintVizSpec(spec({ language: "zh", title: zhTitle }), ROWS, {});
  assert.deepEqual(auto.category_names_resolution, { field: "country", mode: "worldbank", source: "auto", values: ROWS.length });
  assert.ok(!auto.warnings.some((w) => w.includes("contain no CJK characters")), JSON.stringify(auto.warnings));
  const autoSvg = renderVizSvg(spec({ language: "zh", title: zhTitle }), ROWS);
  assert.match(autoSvg, /刚果（金）/);
  assert.equal(autoSvg, renderVizSvg(spec({ language: "zh", title: zhTitle, category_names: "worldbank" }), ROWS), "auto resolution must render exactly like the declared mode");

  const iso3Rows = ROWS.map((r, i) => ({ ...r, country: ["COD", "CHN", "BRA", "IND", "USA", "NGA", "KEN", "EGY", "FRA", "DEU", "JPN", "MEX"][i % 12] }));
  const iso3Auto = lintVizSpec(spec({ language: "zh", title: zhTitle }), iso3Rows.slice(0, 5), {});
  assert.equal(iso3Auto.category_names_resolution?.mode, "iso3", JSON.stringify(iso3Auto.category_names_resolution));

  // Mostly recognizable names (9 of 10) with one that is not: nothing is re-labelled, and the zh chart is blocked rather
  // than printing English names to a Chinese reader. The advisory warning below is for columns that are not
  // recognizable at all.
  const mixed = ROWS.map((r, i) => (i === 0 ? { ...r, country: "Neverland" } : r));
  const unresolved = lintVizSpec(spec({ language: "zh", title: zhTitle }), mixed, {});
  assert.equal(unresolved.category_names_resolution, undefined);
  assert.ok(
    unresolved.blockers.includes("zh chart's 'country' values match exact World Bank English names (best mode 'worldbank': 9 of 10 distinct values, e.g. 'Liberia', 'Zambia', 'Nigeria') and none contains CJK characters, so readers would see English names; select the ISO3 code column as the name field and set category_names='iso3' (category_names='worldbank' also resolves these exact names); filter aggregate rows (OWID_*, regions, income groups) out in SQL; never translate a name yourself"),
    JSON.stringify(unresolved.blockers),
  );
  assert.ok(!unresolved.warnings.some((w) => w.includes("contain no CJK characters")), "the blocker replaces the advisory warning for a recognizable column");
  assert.ok(!/刚果（金）/.test(renderVizSvg(spec({ language: "zh", title: zhTitle }), mixed)), "partially unresolvable names must not be re-labelled");

  // Non-economy categories (companies, provinces ...) are left alone: no resolution, no blocker, only the advisory warning.
  const companies = ROWS.map((r, i) => ({ ...r, country: `Acme Group ${i}` }));
  const nonEconomy = lintVizSpec(spec({ language: "zh", title: zhTitle }), companies, {});
  assert.equal(nonEconomy.category_names_resolution, undefined);
  assert.equal(nonEconomy.blockers.length, lintVizSpec(spec({ language: "zh", title: zhTitle }), companies, {}).blockers.length);
  assert.ok(!nonEconomy.blockers.some((b) => b.includes("values match")), JSON.stringify(nonEconomy.blockers));
  assert.ok(
    nonEconomy.warnings.includes("zh chart's 'country' values contain no CJK characters; consider setting category_names to show localized names instead of the raw World Bank English text"),
    JSON.stringify(nonEconomy.warnings),
  );

  // Values alone are not a signal: same-named states / people must not be
  // translated, and the lint warns that the values match World Bank names.
  const warnRe = /values all match World Bank names.*declare category_names explicitly/;
  for (const [field, names] of [["state", ["Georgia", "Chad"]], ["name", ["Georgia", "Jordan"]]]) {
    const r = names.map((v, i) => ({ ...ROWS[i], [field]: v }));
    const sp = spec({ language: "zh", title: "US states count comparison", category_field: field });
    const l = lintVizSpec(sp, r, {});
    assert.equal(l.category_names_resolution, undefined, field);
    assert.ok(l.warnings.some((w) => warnRe.test(w) && w.includes(`'${field}'`)), JSON.stringify(l.warnings));
    // A column that reads as economies but whose name does not say so is still blocked on a zh chart, and the blocker
    // adds that these may not be economies at all, in which case they need Chinese labels.
    assert.ok(
      l.blockers.some((b) => b.startsWith(`zh chart's '${field}' values match exact World Bank English names`) && b.endsWith("; never translate a name yourself; if these values are not economies or currencies, label them in Chinese instead")),
      JSON.stringify(l.blockers),
    );
    const svg = renderVizSvg(sp, r);
    assert.ok(!/格鲁吉亚|乍得|约旦/.test(svg), `${field}: must not be translated`);
  }
  {
    const l = lintVizSpec(spec({ language: "zh", title: zhTitle }), ROWS, {});
    assert.ok(!l.warnings.some((w) => warnRe.test(w)), "signal field must not warn");
    assert.ok(!l.blockers.some((b) => b.startsWith("zh chart's")), "a signalled field is auto-resolved, not blocked");
    const r = iso3Rows.slice(0, 5).map((x) => ({ ...x, iso3: x.country }));
    const l2 = lintVizSpec(spec({ language: "zh", title: zhTitle, category_field: "iso3" }), r, {});
    assert.equal(l2.category_names_resolution?.mode, "iso3", JSON.stringify(l2));
    assert.ok(!l2.warnings.some((w) => warnRe.test(w)));
    const l3 = lintVizSpec(spec({ language: "zh", title: zhTitle }), companies, {});
    assert.ok(!l3.warnings.some((w) => warnRe.test(w)), "non-matching values must not warn");
  }

  // A declared mode is never overridden or recorded as auto.
  const declared = lintVizSpec(spec({ language: "zh", title: zhTitle, category_names: "worldbank" }), ROWS, {});
  assert.equal(declared.category_names_resolution, undefined);
}

// -- highlight_values still match the raw World Bank name even when
// category_names is set and the visible label is the zh name --
{
  const s = spec({ language: "zh", category_names: "worldbank", title: "可再生能源占比最高的经济体", highlight_values: ["Congo, Dem. Rep."] });
  const svg = renderVizSvg(s, ROWS);
  assert.match(svg, /刚果（金）/);
}

console.log("range_bracket: PASS");

// ---------------------------------------------------------------------
// zh name-field lint (zh-naming-policy-1003, rules 2, 4, 8 and 9 plus the iso2 and iso4217 modes). A zh chart whose name
// column holds no CJK characters, declares no category_names and is mostly made of economy names, economy codes or
// currency codes would print English names or raw codes to a Chinese reader, so lint blocks it and says which column to
// select, which mode to set, to filter aggregate rows in SQL and never to translate a name by hand. Columns that are not
// recognizable at all keep the older advisory warning.
// ---------------------------------------------------------------------
{
  const ZH_TITLE = "可再生能源占比最高的经济体";
  const zhSpec = (overrides = {}) => spec({ language: "zh", title: ZH_TITLE, ...overrides });
  const rowsOf = (field, values) => values.map((value, i) => ({ [field]: value, pct: 90 - i }));
  const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  // The draft-mode and claim-id blockers/warnings belong to the surrounding scaffold, not to naming.
  const nameBlockers = (l) => l.blockers.filter((b) => b.startsWith("zh chart's") || b.startsWith("category_names"));
  const NOT_NAMES_TAIL = "; if these values are not economies or currencies, label them in Chinese instead";
  const SQL_FILTER = "filter aggregate rows (OWID_*, regions, income groups) out in SQL; never translate a name yourself";

  // The category_names enum has four modes, and nothing else validates.
  assert.deepEqual(validateVizSpec(spec({ category_names: "iso2" })), []);
  assert.deepEqual(validateVizSpec(spec({ category_names: "iso4217" })), []);
  for (const bad of ["iso5", "ISO3", "iso_3", ""]) {
    assert.deepEqual(validateVizSpec(spec({ category_names: bad })), ["category_names must be one of worldbank, iso3, iso2, iso4217"], bad);
  }

  // --- ISO3 codes in a column whose name does not say economy ---
  const iso3Rows = rowsOf("code", ["COD", "CHN", "BRA", "IND", "USA"]);
  {
    const l = lintVizSpec(zhSpec({ category_field: "code" }), iso3Rows, {});
    assert.deepEqual(nameBlockers(l), [`zh chart's 'code' values match ISO3 codes (best mode 'iso3': 5 of 5 distinct values, e.g. 'COD', 'CHN', 'BRA') and none contains CJK characters, so readers would see raw codes; select the ISO3 code column as the name field and set category_names='iso3'; ${SQL_FILTER}${NOT_NAMES_TAIL}`]);
    assert.equal(l.category_names_resolution, undefined, "an unsignalled column is never auto-resolved");
    // Declaring the mode lifts the blocker and the page shows Chinese names.
    const declared = zhSpec({ category_field: "code", category_names: "iso3" });
    assert.deepEqual(nameBlockers(lintVizSpec(declared, iso3Rows, {})), []);
    const shown = texts(renderVizSvg(declared, iso3Rows));
    for (const zh of ["刚果（金）", "中国", "巴西", "印度", "美国"]) assert.ok(shown.includes(zh), `${zh} in ${JSON.stringify(shown)}`);
    assert.ok(!shown.some((t) => /^(COD|CHN|BRA|IND|USA)$/.test(t)), "no raw ISO3 code may reach a zh page");
    // A signalled column resolves on its own, and renders exactly like the declared mode.
    const signalled = zhSpec({ category_field: "iso3" });
    const signalledRows = iso3Rows.map((r) => ({ iso3: r.code, pct: r.pct }));
    const auto = lintVizSpec(signalled, signalledRows, {});
    assert.deepEqual(auto.category_names_resolution, { field: "iso3", mode: "iso3", source: "auto", values: 5 });
    assert.deepEqual(nameBlockers(auto), []);
    assert.equal(renderVizSvg(signalled, signalledRows), renderVizSvg(zhSpec({ category_field: "iso3", category_names: "iso3" }), signalledRows));
    // An English page keeps the English name from the same table.
    const en = texts(renderVizSvg(spec({ title: "Renewable share", category_field: "code", category_names: "iso3" }), iso3Rows));
    assert.ok(en.includes("Congo, Dem. Rep.") && en.includes("United States"), JSON.stringify(en));
  }

  // --- ISO 3166-1 alpha-2 codes: explicit only, never auto-resolved ---
  const geoRows = rowsOf("geo", ["DE", "FR", "IT", "EL", "UK"]);
  {
    const l = lintVizSpec(zhSpec({ category_field: "geo" }), geoRows, {});
    assert.deepEqual(nameBlockers(l), [`zh chart's 'geo' values match ISO 3166-1 alpha-2 codes (best mode 'iso2': 5 of 5 distinct values, e.g. 'DE', 'FR', 'IT') and none contains CJK characters, so readers would see raw codes; select the ISO2 code column as the name field and set category_names='iso2'; ${SQL_FILTER}${NOT_NAMES_TAIL}`]);
    // Even a column called iso2 or country is not auto-resolved to iso2: the blocker asks for the declaration.
    for (const field of ["iso2", "country"]) {
      const named = lintVizSpec(zhSpec({ category_field: field }), rowsOf(field, ["DE", "FR", "IT"]), {});
      assert.equal(named.category_names_resolution, undefined, field);
      assert.equal(nameBlockers(named).length, 1, field);
      assert.ok(nameBlockers(named)[0].includes("(best mode 'iso2': 3 of 3 distinct values"), nameBlockers(named)[0]);
    }
    // Declared: EL (Greece) and UK (United Kingdom) are the Eurostat spellings and resolve like GR and GB.
    const declared = zhSpec({ category_field: "geo", category_names: "iso2" });
    assert.deepEqual(nameBlockers(lintVizSpec(declared, geoRows, {})), []);
    const shown = texts(renderVizSvg(declared, geoRows));
    for (const zh of ["德国", "法国", "意大利", "希腊", "英国"]) assert.ok(shown.includes(zh), `${zh} in ${JSON.stringify(shown)}`);
    assert.ok(!shown.some((t) => /^(DE|FR|IT|EL|UK)$/.test(t)), "no raw ISO2 code may reach a zh page");
    assert.equal(renderVizSvg(declared, geoRows), renderVizSvg(zhSpec({ category_field: "geo", category_names: "iso2" }), rowsOf("geo", ["DE", "FR", "IT", "GR", "GB"])), "EL and UK render exactly like GR and GB");
    // Aggregates are not economies: they stay unresolved, and the blocker says to filter them in SQL.
    const withAggregates = [...geoRows, { geo: "EU27_2020", pct: 50 }, { geo: "EA20", pct: 40 }];
    assert.deepEqual(nameBlockers(lintVizSpec(declared, withAggregates, {})), ["category_names='iso2' cannot resolve 2 value(s) in 'geo' (e.g. 'EU27_2020', 'EA20'); use the exact ISO 3166-1 alpha-2 economy code (filter aggregate rows such as EU27_2020 or EA20 out in SQL) instead of translating it yourself"]);
    assert.ok(nameBlockers(lintVizSpec(zhSpec({ category_field: "geo" }), withAggregates, {}))[0].includes("(best mode 'iso2': 5 of 7 distinct values"));
    // The match is exact and case-sensitive.
    assert.deepEqual(nameBlockers(lintVizSpec(zhSpec({ category_field: "geo", category_names: "iso2" }), rowsOf("geo", ["DE", "gr"]), {})), ["category_names='iso2' cannot resolve 1 value(s) in 'geo' (e.g. 'gr'); use the exact ISO 3166-1 alpha-2 economy code (filter aggregate rows such as EU27_2020 or EA20 out in SQL) instead of translating it yourself"]);
  }

  // --- ISO 4217 currency codes ---
  const currencyRows = rowsOf("currency", ["TRY", "GBP", "USD", "JPY", "CNY"]);
  {
    const spec1 = zhSpec({ category_field: "currency" });
    const auto = lintVizSpec(spec1, currencyRows, {});
    assert.deepEqual(auto.category_names_resolution, { field: "currency", mode: "iso4217", source: "auto", values: 5 });
    assert.deepEqual(nameBlockers(auto), []);
    const shown = texts(renderVizSvg(spec1, currencyRows));
    for (const zh of ["土耳其里拉", "英镑", "美元", "日元", "人民币"]) assert.ok(shown.includes(zh), `${zh} in ${JSON.stringify(shown)}`);
    assert.ok(!shown.some((t) => /^(TRY|GBP|USD|JPY|CNY)$/.test(t)), "no bare currency code may reach a zh page");
    assert.equal(renderVizSvg(spec1, currencyRows), renderVizSvg(zhSpec({ category_field: "currency", category_names: "iso4217" }), currencyRows), "auto resolution renders exactly like the declared mode");
    // The English name comes from the same table (CLDR English), on an English page too.
    const en = texts(renderVizSvg(spec({ title: "Currency strength", category_field: "currency" }), currencyRows));
    assert.ok(en.includes("Turkish Lira") && en.includes("US Dollar"), JSON.stringify(en));
    // An unsignalled column is not auto-resolved: blocked on a zh page, with the advisory warning kept.
    const codeRows = currencyRows.map((r) => ({ code: r.currency, pct: r.pct }));
    const blocked = lintVizSpec(zhSpec({ category_field: "code" }), codeRows, {});
    assert.deepEqual(nameBlockers(blocked), [`zh chart's 'code' values match ISO 4217 currency codes (best mode 'iso4217': 5 of 5 distinct values, e.g. 'TRY', 'GBP', 'USD') and none contains CJK characters, so readers would see bare currency codes; select the ISO 4217 currency code column as the name field and set category_names='iso4217'; ${SQL_FILTER}${NOT_NAMES_TAIL}`]);
    assert.ok(blocked.warnings.includes("category field 'code' values all match ISO 4217 currency codes, but the field name does not say they are currencies, so names are not auto-resolved; if they are currencies, declare category_names explicitly"), JSON.stringify(blocked.warnings));
    assert.deepEqual(nameBlockers(lintVizSpec(zhSpec({ category_field: "code", category_names: "iso4217" }), codeRows, {})), []);
    // A code that is not an ISO 4217 currency is named, never translated or guessed.
    assert.deepEqual(nameBlockers(lintVizSpec(zhSpec({ category_field: "currency", category_names: "iso4217" }), rowsOf("currency", ["TRY", "GBP", "QQQ"]), {})), ["category_names='iso4217' cannot resolve 1 value(s) in 'currency' (e.g. 'QQQ'); use the exact ISO 4217 currency code instead of translating it yourself"]);
  }

  // --- BTN, MKD and SLE are both ISO3 economy codes and ISO 4217 currency codes ---
  {
    const tie = ["BTN", "MKD", "SLE"];
    // A signalled field name decides the tie.
    const asCountry = lintVizSpec(zhSpec({ category_field: "country" }), rowsOf("country", tie), {});
    assert.deepEqual(asCountry.category_names_resolution, { field: "country", mode: "iso3", source: "auto", values: 3 });
    const asCurrency = lintVizSpec(zhSpec({ category_field: "currency" }), rowsOf("currency", tie), {});
    assert.deepEqual(asCurrency.category_names_resolution, { field: "currency", mode: "iso4217", source: "auto", values: 3 });
    assert.deepEqual(texts(renderVizSvg(zhSpec({ category_field: "country" }), rowsOf("country", tie))).filter((t) => /[一-鿿]/.test(t) && !t.includes("可再生") && !t.includes("数据来源")), ["不丹", "北马其顿", "塞拉利昂"]);
    assert.deepEqual(texts(renderVizSvg(zhSpec({ category_field: "currency" }), rowsOf("currency", tie))).filter((t) => /[一-鿿]/.test(t) && !t.includes("可再生") && !t.includes("数据来源")), ["不丹努尔特鲁姆", "马其顿第纳尔", "塞拉利昂新利昂"]);
    // On the blocker path (one value that neither table knows) the best mode follows the field name too.
    const withUnknown = [...tie, "ZZZ"];
    const bestMode = (field) => nameBlockers(lintVizSpec(zhSpec({ category_field: field }), rowsOf(field, withUnknown), {}))[0];
    assert.ok(bestMode("country").includes("(best mode 'iso3': 3 of 4 distinct values") && !bestMode("country").endsWith(NOT_NAMES_TAIL), bestMode("country"));
    assert.ok(bestMode("currency").includes("(best mode 'iso4217': 3 of 4 distinct values") && !bestMode("currency").endsWith(NOT_NAMES_TAIL), bestMode("currency"));
    // With no signal at all the fixed order applies (economies first) and the blocker adds the hedge.
    assert.ok(bestMode("code").includes("(best mode 'iso3': 3 of 4 distinct values") && bestMode("code").endsWith(NOT_NAMES_TAIL), bestMode("code"));
  }

  // --- Where the blocker does not apply ---
  {
    // An English page may show codes or names as it likes.
    const en = lintVizSpec(spec({ title: "Ranking", category_field: "code" }), iso3Rows, {});
    assert.deepEqual(nameBlockers(en), []);
    // One CJK value is enough to say the author is labelling by hand.
    const labelled = lintVizSpec(zhSpec({ category_field: "code" }), rowsOf("code", ["德国", "FR", "IT"]), {});
    assert.deepEqual(nameBlockers(labelled), []);
    assert.ok(!labelled.warnings.some((w) => w.includes("contain no CJK characters")), JSON.stringify(labelled.warnings));
    // A declared category_names never gets the undeclared blocker (it has its own unmapped-value blocker above).
    assert.deepEqual(nameBlockers(lintVizSpec(zhSpec({ category_field: "code", category_names: "worldbank" }), rowsOf("code", ["Chad", "Ghana"]), {})), []);
    // Choropleth owns its own name blockers; the zh name-field blocker never fires on it.
    const choropleth = lintVizSpec(zhSpec({ chart_type: "choropleth", category_field: "country" }), rowsOf("country", ["United States", "China", "Chad"]), {});
    assert.ok(!choropleth.blockers.some((b) => b.startsWith("zh chart's")), JSON.stringify(choropleth.blockers));
  }

  // --- Thresholds: at least two recognizable values and at least half of the distinct ones ---
  {
    const lint = (values) => lintVizSpec(zhSpec({ category_field: "code" }), rowsOf("code", values), {});
    const advisory = "zh chart's 'code' values contain no CJK characters; consider setting category_names to show localized names instead of the raw World Bank English text";
    const fewer = lint(["USA", "CHN", "Acme", "Globex", "Initech"]);
    assert.deepEqual(nameBlockers(fewer), [], "2 of 5 is below half");
    assert.ok(fewer.warnings.includes(advisory), JSON.stringify(fewer.warnings));
    const half = lint(["USA", "CHN", "Acme", "Globex"]);
    assert.equal(nameBlockers(half).length, 1, "exactly half blocks");
    assert.ok(nameBlockers(half)[0].includes("(best mode 'iso3': 2 of 4 distinct values, e.g. 'USA', 'CHN')"), nameBlockers(half)[0]);
    const single = lint(["USA", "USA", "USA"]);
    assert.deepEqual(nameBlockers(single), [], "one distinct value is not a column of names");
    assert.ok(single.warnings.includes(advisory), JSON.stringify(single.warnings));
    const one = lint(["USA", "Acme"]);
    assert.deepEqual(nameBlockers(one), [], "one recognizable value out of two is not enough, even though it is half");
    assert.ok(one.warnings.includes(advisory), JSON.stringify(one.warnings));
    assert.equal(nameBlockers(lint(["USA", "CHN"])).length, 1, "two recognizable values out of two block");
    // Values are trimmed and de-duplicated before they are counted.
    const padded = lint([" USA", "USA", "CHN", "Acme", "Globex"]);
    assert.ok(nameBlockers(padded)[0]?.includes("(best mode 'iso3': 2 of 4 distinct values"), JSON.stringify(nameBlockers(padded)));
  }

  // --- Chart types that print names in a field other than category_field ---
  {
    const scatter = (overrides = {}) => zhSpec({ chart_type: "scatter", reader_task: "correlation", x_field: "x", y_field: "y", category_field: undefined, value_field: undefined, ...overrides });
    const points = (field, values) => values.map((value, i) => ({ [field]: value, x: i + 1, y: (i + 1) * 2 }));
    assert.deepEqual(nameBlockers(lintVizSpec(scatter({ label_field: "code", category_names: "iso3" }), points("code", ["USA", "CHN", "TCD"]), {})), []);
    assert.deepEqual(nameBlockers(lintVizSpec(scatter({ label_field: "code", category_names: "iso3" }), points("code", ["USA", "CHN", "ZZZ"]), {})), ["category_names='iso3' cannot resolve 1 value(s) in 'code' (e.g. 'ZZZ'); use the exact ISO3 economy/aggregate code (filter other aggregate rows such as OWID_* regions and income groups out in SQL) instead of translating it yourself"]);
    assert.deepEqual(nameBlockers(lintVizSpec(scatter({ category_names: "iso3" }), points("code", ["USA", "CHN"]), {})), ["category_names on chart_type 'scatter' needs label_field (the column whose values are the point names)"]);
    const auto = lintVizSpec(scatter({ label_field: "country" }), points("country", ["United States", "China", "Chad"]), {});
    assert.deepEqual(auto.category_names_resolution, { field: "country", mode: "worldbank", source: "auto", values: 3 });
    assert.deepEqual(nameBlockers(auto), []);
    const unsignalled = nameBlockers(lintVizSpec(scatter({ label_field: "label" }), points("label", ["United States", "China", "Chad"]), {}));
    assert.equal(unsignalled.length, 1);
    assert.ok(unsignalled[0].startsWith("zh chart's 'label' values match exact World Bank English names"), unsignalled[0]);
    // Other chart types still refuse category_names.
    assert.deepEqual(nameBlockers(lintVizSpec(zhSpec({ chart_type: "heatmap", reader_task: "pattern", x_field: "a", y_field: "b", value_field: "v", category_field: undefined, category_names: "iso3" }), [{ a: 1, b: "x", v: 2 }], {})), ["category_names is not supported on chart_type 'heatmap'"]);

    // Sankey and alluvial name their nodes in source_field and target_field, with optional origin:/destination: prefixes.
    const flow = (overrides = {}) => zhSpec({ chart_type: "sankey", reader_task: "flow", title: "资金流向", category_field: undefined, source_field: "from", target_field: "to", value_field: "v", ...overrides });
    const flows = [{ from: "origin:CHN", to: "destination:USA", v: 3 }, { from: "origin:USA", to: "destination:CHN", v: 2 }, { from: "origin:IND", to: "destination:USA", v: 1 }];
    assert.deepEqual(nameBlockers(lintVizSpec(flow({ category_names: "iso3" }), flows, {})), []);
    const shown = texts(renderVizSvg(flow({ category_names: "iso3" }), flows));
    for (const zh of ["中国", "美国", "印度"]) assert.ok(shown.includes(zh), `${zh} in ${JSON.stringify(shown)}`);
    assert.ok(!shown.some((t) => /CHN|USA|IND|origin:|destination:/.test(t)), JSON.stringify(shown));
    const undeclared = lintVizSpec(flow(), flows, {});
    assert.equal(undeclared.category_names_resolution, undefined, "node fields are never auto-resolved");
    assert.deepEqual(nameBlockers(undeclared), [`zh chart's 'from' and 'to' values match ISO3 codes (best mode 'iso3': 3 of 3 distinct values, e.g. 'CHN', 'USA', 'IND') and none contains CJK characters, so readers would see raw codes; select the ISO3 code columns as the name fields and set category_names='iso3'; ${SQL_FILTER}${NOT_NAMES_TAIL}`]);
    const named = [{ from: "United States", to: "China", v: 3 }, { from: "Chad", to: "Japan", v: 2 }];
    const namedBlockers = nameBlockers(lintVizSpec(flow(), named, {}));
    assert.equal(namedBlockers.length, 1);
    assert.ok(namedBlockers[0].startsWith("zh chart's 'from' and 'to' values match exact World Bank English names (best mode 'worldbank': 4 of 4 distinct values"), namedBlockers[0]);
    assert.ok(namedBlockers[0].includes("select the ISO3 code columns as the name fields"), namedBlockers[0]);
    assert.deepEqual(nameBlockers(lintVizSpec(flow({ category_names: "worldbank" }), named, {})), []);
    assert.deepEqual(texts(renderVizSvg(flow({ category_names: "worldbank" }), named)).filter((t) => /[一-鿿]/.test(t) && !t.includes("资金") && !t.includes("数据来源")), ["美国", "乍得", "中国", "日本"]);
    // An English page keeps the English names.
    const enShown = texts(renderVizSvg(flow({ language: "en", title: "Flows", category_names: "iso3" }), flows));
    assert.ok(enShown.includes("China") && enShown.includes("United States") && enShown.includes("India"), JSON.stringify(enShown));
    // Alluvial uses the same fields and the same rule.
    const alluvial = (overrides = {}) => flow({ chart_type: "alluvial", ...overrides });
    assert.deepEqual(nameBlockers(lintVizSpec(alluvial({ category_names: "iso3" }), flows, {})), []);
    assert.equal(nameBlockers(lintVizSpec(alluvial(), flows, {})).length, 1);
    assert.ok(!texts(renderVizSvg(alluvial({ category_names: "iso3" }), flows)).some((t) => /CHN|USA|IND|origin:|destination:/.test(t)));
  }

  // --- Policy rule 4: a list with Hong Kong, Macao or Taiwan says 国家和地区 (or 经济体), never a bare 国家 ---
  {
    const warningsFor = (overrides, values, field = "iso") => lintVizSpec(zhSpec({ category_names: "iso3", category_field: field, ...overrides }), rowsOf(field, values), {}).warnings.filter((w) => w.startsWith("zh chart lists"));
    const hk = ["USA", "HKG", "TWN"];
    assert.deepEqual(warningsFor({ title: "国家排名" }, hk), ["zh chart lists 中国香港 (HKG), 中国台湾 (TWN), but its title says 国家 without 和地区; write 国家和地区 (or 经济体) instead of a bare 国家 (zh naming policy rule 4)"]);
    assert.deepEqual(warningsFor({ title: "经济体排名", subtitle: "国家排名" }, ["USA", "MAC"]), ["zh chart lists 中国澳门 (MAC), but its subtitle says 国家 without 和地区; write 国家和地区 (or 经济体) instead of a bare 国家 (zh naming policy rule 4)"]);
    assert.deepEqual(warningsFor({ title: "国家排名", subtitle: "各国家的数值" }, ["USA", "HKG", "MAC", "TWN"]), ["zh chart lists 中国香港 (HKG), 中国澳门 (MAC), 中国台湾 (TWN), but its title and subtitle say 国家 without 和地区; write 国家和地区 (or 经济体) instead of a bare 国家 (zh naming policy rule 4)"]);
    assert.deepEqual(warningsFor({ title: "国家和地区排名" }, hk), [], "国家和地区 is the wording the policy asks for");
    assert.deepEqual(warningsFor({ title: "经济体排名" }, hk), [], "经济体 is the other accepted wording");
    assert.deepEqual(warningsFor({ title: "国家与经济体排名" }, hk), [], "a title that says 国家 next to 经济体 already covers the regions");
    assert.deepEqual(warningsFor({ title: "国家排名" }, ["USA", "CHN", "FRA"]), [], "no special region in the list, nothing to say");
    assert.deepEqual(warningsFor({ title: "各地区排名" }, hk), [], "a title that never says 国家 is not touched");
    assert.deepEqual(lintVizSpec(spec({ title: "Country ranking", category_names: "iso3", category_field: "iso" }), rowsOf("iso", hk), {}).warnings.filter((w) => w.startsWith("zh chart lists")), [], "English pages are not checked");
    // The warning follows the resolved names whichever mode produced them.
    assert.equal(warningsFor({ title: "国家排名", category_names: "iso2" }, ["US", "HK", "TW"]).length, 1);
    assert.equal(warningsFor({ title: "国家排名", category_names: "worldbank", category_field: "country" }, ["United States", "Hong Kong SAR, China"], "country").length, 1);
    assert.deepEqual(warningsFor({ title: "国家排名", category_names: "iso4217", category_field: "currency" }, ["TRY", "HKD"], "currency"), [], "a currency list is not a list of economies");
    // It is a warning, never a blocker.
    assert.deepEqual(nameBlockers(lintVizSpec(zhSpec({ title: "国家排名", category_names: "iso3", category_field: "iso" }), rowsOf("iso", hk), {})), []);
  }
}

console.log("zh name-field lint: PASS");

// ---------------------------------------------------------------------
// chartNameDisplay (zh-naming-policy-1003): the lookup newsroom.ts's inline claim fill uses to write a place or currency
// name the way the chart itself prints it. It answers with the table, mode and fields that lint and the renderers use,
// never translates anything, and is null for a chart that prints no localized name. What the claim fill does with it is
// tested in test_page_inline_claim.mjs (which needs DuckDB); this part runs without it.
// ---------------------------------------------------------------------
{
  const ZH_TITLE = "可再生能源占比最高的经济体";
  const zh = (overrides = {}) => spec({ language: "zh", title: ZH_TITLE, ...overrides });
  const rowsOf = (field, values) => values.map((value, i) => ({ [field]: value, pct: 90 - i }));
  const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  const codes = rowsOf("code", ["USA", "CHN", "HKG"]);

  // --- No localized name: not a zh chart, no mode, a type or a field that names nothing ---
  assert.equal(chartNameDisplay(spec({ category_field: "code", category_names: "iso3" }), codes), null, "no language is English");
  assert.equal(chartNameDisplay(zh({ language: "en", category_field: "code", category_names: "iso3" }), codes), null, "an English chart");
  assert.equal(chartNameDisplay(zh({ category_field: "code" }), codes), null, "a field that does not say economy resolves no mode");
  assert.equal(chartNameDisplay(zh({ category_field: "company" }), rowsOf("company", ["Acme", "Globex"])), null, "values that are not economies resolve no mode");
  assert.equal(chartNameDisplay(zh({ category_field: "country" }), rowsOf("country", ["United States", "Acme"])), null, "one value the table cannot resolve keeps the chart unresolved");
  assert.equal(chartNameDisplay(zh({ chart_type: "heatmap", reader_task: "relationship", x_field: "a", y_field: "b", value_field: "v", category_field: undefined, category_names: "iso3" }), codes), null, "a chart type with no name fields");
  assert.equal(chartNameDisplay(zh({ chart_type: "scatter", reader_task: "correlation", x_field: "x", y_field: "y", category_field: undefined, value_field: undefined, category_names: "iso3" }), codes), null, "a scatter without label_field names nothing");
  assert.equal(chartNameDisplay(zh({ category_field: undefined, category_names: "iso3" }), codes), null, "no name field set");

  // --- The mode: a declared category_names, else the one auto-resolution picks ---
  const explicit = chartNameDisplay(zh({ category_field: "code", category_names: "iso3" }), codes);
  assert.deepEqual([explicit?.mode, explicit?.fields], ["iso3", ["code"]]);
  assert.deepEqual(["USA", "CHN", "HKG"].map((v) => explicit.display("code", v)), ["美国", "中国", "中国香港"]);
  const wb = ["United States", "Hong Kong SAR, China", "Chad"];
  const auto = chartNameDisplay(zh({ category_field: "country" }), rowsOf("country", wb));
  assert.deepEqual([auto?.mode, auto?.fields], ["worldbank", ["country"]]);
  assert.deepEqual(wb.map((v) => auto.display("country", v)), ["美国", "中国香港", "乍得"]);
  const currency = chartNameDisplay(zh({ category_field: "currency" }), rowsOf("currency", ["TRY", "GBP", "JPY"]));
  assert.equal(currency?.mode, "iso4217");
  assert.deepEqual([currency.mode, currency.fields, currency.display("currency", "TRY"), currency.display("currency", "GBP"), currency.display("currency", "JPY")], ["iso4217", ["currency"], "土耳其里拉", "英镑", "日元"]);
  const declared = chartNameDisplay(zh({ category_field: "country", category_names: "iso3" }), rowsOf("country", wb));
  assert.equal(declared?.mode, "iso3", "a declared mode is never replaced by the auto-resolved one");
  assert.deepEqual(wb.map((v) => declared.display("country", v)), [null, null, null], "English names are not ISO3 codes, so the chart (and the claim) keep them as they are");
  const iso2 = chartNameDisplay(zh({ category_field: "geo", category_names: "iso2" }), rowsOf("geo", ["DE", "EL", "UK"]));
  assert.equal(iso2?.mode, "iso2");
  assert.deepEqual(["DE", "EL", "UK"].map((v) => iso2.display("geo", v)), ["德国", "希腊", "英国"], "Eurostat's EL and UK resolve like GR and GB");
  assert.equal(chartNameDisplay(zh({ category_field: "geo" }), rowsOf("geo", ["DE", "FR", "IT"])), null, "ISO2 is explicit-only: an undeclared column resolves no mode");
  assert.equal(chartNameDisplay(zh({ category_field: "iso2" }), rowsOf("iso2", ["DE", "FR", "IT"])), null, "even a column named iso2 is not auto-resolved");

  // --- display(): an exact table match on a name field, nothing else ---
  assert.equal(explicit.display("code", " USA "), "美国", "values are trimmed, as the renderer trims them");
  for (const [column, value] of [["code", "usa"], ["code", "Atlantis"], ["code", ""], ["code", "840"], ["code", 840], ["code", null], ["code", undefined], ["pct", "USA"], ["other", "USA"]]) {
    assert.equal(explicit.display(column, value), null, `${column} = ${JSON.stringify(value)}: not localized`);
  }

  // --- Fields: the columns each chart type localizes ---
  const fieldsOf = (overrides) => chartNameDisplay(zh({ category_names: "iso3", ...overrides }), [])?.fields;
  for (const [chart_type, overrides, fields] of [
    ["horizontal_bar", {}, ["country"]], ["dot", {}, ["country"]], ["dumbbell", {}, ["country"]], ["slope", {}, ["country"]],
    ["diverging_bar", {}, ["country"]], ["waffle", {}, ["country"]], ["treemap", {}, ["country"]], ["choropleth", {}, ["country"]],
    ["small_multiples", { facet_field: "geo" }, ["geo"]], ["multi_line", { series_field: "entity" }, ["entity"]], ["scatter", { label_field: "code" }, ["code"]],
    ["sankey", { source_field: "from", target_field: "to" }, ["from", "to"]], ["alluvial", { source_field: "from", target_field: "to" }, ["from", "to"]],
    ["sankey", { source_field: "from" }, ["from"]],
  ]) assert.deepEqual(fieldsOf({ chart_type, ...overrides }), fields, `${chart_type} ${JSON.stringify(overrides)}`);
  assert.equal(chartNameDisplay(zh({ chart_type: "sankey", category_names: "iso3" }), []), null, "a sankey with no source_field or target_field names nothing");
  // A node id is localized without its internal origin:/destination: prefix.
  const flow = chartNameDisplay(zh({ chart_type: "sankey", reader_task: "flow", category_field: undefined, source_field: "from", target_field: "to", value_field: "v", category_names: "iso3" }), []);
  assert.deepEqual([flow.display("from", "origin:CHN"), flow.display("to", "destination:USA"), flow.display("to", "USA"), flow.display("v", "CHN")], ["中国", "美国", "美国", null]);

  // --- Parity: whatever the lookup says a chart prints, the renderer prints ---
  // For every chart type that localizes names (scatter excluded: its point labels are drawn by the branch that adds them,
  // which calls resolveEconomyDisplayName(row[label_field], category_names, lang) with the same field), each raw value of
  // each name field shows its display() text in the SVG and never as the raw code.
  const geo = ["USA", "CHN", "HKG", "BRA"];
  const bars = geo.map((value, i) => ({ geo: value, pct: 40 - i * 5, pct_before: 30 - i * 3 }));
  const panels = geo.slice(0, 3).flatMap((value) => [2019, 2020, 2021].map((year) => ({ geo: value, year, pct: year - 2000 })));
  const series = ["CHN", "WLD", "HKG"].flatMap((value) => [2019, 2020, 2021].map((year) => ({ geo: value, year, pct: year - 2000 + value.length })));
  const flows = [{ from: "origin:CHN", to: "destination:USA", v: 3 }, { from: "origin:USA", to: "destination:HKG", v: 2 }, { from: "origin:BRA", to: "destination:USA", v: 1 }];
  const FLOW = { reader_task: "flow", category_field: undefined, source_field: "from", target_field: "to", value_field: "v" };
  for (const [chart_type, overrides, rows] of [
    ["horizontal_bar", {}, bars],
    ["dot", {}, bars],
    ["dumbbell", { reader_task: "comparison", start_field: "pct_before", end_field: "pct", value_field: undefined }, bars],
    ["slope", { reader_task: "change", start_field: "pct_before", end_field: "pct", start_label: "2010", end_label: "2020", value_field: undefined }, bars],
    ["diverging_bar", { reader_task: "comparison" }, bars.map((row, i) => ({ ...row, pct: i % 2 ? -row.pct : row.pct }))],
    ["waffle", { reader_task: "part_to_whole" }, bars.slice(0, 3).map((row, i) => ({ ...row, pct: [50, 30, 20][i] }))],
    ["treemap", { reader_task: "part_to_whole" }, bars],
    ["small_multiples", { reader_task: "change", facet_field: "geo", x_field: "year", value_field: "pct", category_field: undefined, panel_mark: "line" }, panels],
    ["multi_line", { reader_task: "change", series_field: "geo", x_field: "year", value_field: "pct", category_field: undefined, highlight_values: ["CHN", "WLD", "HKG"] }, series],
    ["sankey", FLOW, flows],
    ["alluvial", FLOW, flows],
  ]) {
    const chart = zh({ chart_type, category_field: "geo", category_names: "iso3", ...overrides });
    const names = chartNameDisplay(chart, rows);
    const shown = texts(renderVizSvg(chart, rows));
    let checked = 0;
    for (const field of names.fields) {
      for (const raw of new Set(rows.map((row) => row[field]))) {
        const name = names.display(field, raw);
        assert.ok(name, `${chart_type}: ${field} = ${raw} resolves`);
        assert.ok(shown.some((t) => t.includes(name)), `${chart_type}: ${name} (${raw}) is drawn: ${JSON.stringify(shown)}`);
        assert.ok(!shown.some((t) => t.includes(String(raw).replace(/^(origin|destination):/, ""))), `${chart_type}: ${raw} is not drawn raw: ${JSON.stringify(shown)}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 3, `${chart_type}: at least three names were compared`);
  }
}

console.log("chartNameDisplay: PASS");

// ---------------------------------------------------------------------
// CJK widow control (wrapText's internal controlWidow step): a wrapped
// block whose last line would hold exactly one wide (CJK) character -
// optionally plus trailing kinsoku punctuation glued to it - is
// rebalanced by moving one wide character down from the previous line,
// unless that would leave the previous line with fewer than two wide
// characters of its own. Character order and kinsoku merging are always
// preserved (lines.join("") always reproduces the input exactly); Latin
// text has no wide character to find, so it is always left untouched.
// ---------------------------------------------------------------------

// A plain widow: 5 wide chars greedily pack 4 into line 1 (8 units, at
// the maxChars=8 budget), leaving a lone 5th on line 2; rebalanced to 3+2
// so neither line holds fewer than two.
{
  const lines = wrapText("一二三四五", 8);
  assert.deepEqual(lines, ["一二三", "四五"]);
  assert.equal(lines.join(""), "一二三四五");
}

// A widow with trailing kinsoku punctuation glued to it ("五。" can never
// be split across a line break, and "。" can never start a line): still
// rebalanced, and the punctuation moves down still attached to its
// character.
{
  const lines = wrapText("一二三四五。", 8);
  assert.deepEqual(lines, ["一二三", "四五。"]);
  assert.equal(lines.join(""), "一二三四五。");
}

// Guard: rebalancing would leave the previous line with only one wide
// character, so a genuine widow is left as-is rather than trading one
// orphan for another.
{
  const lines = wrapText("一二三", 4);
  assert.deepEqual(lines, ["一二", "三"]);
}

// Not a widow at all (the last line already holds two wide characters):
// untouched.
{
  const lines = wrapText("一二三四五六", 8);
  assert.deepEqual(lines, ["一二三四", "五六"]);
}

// The previous line ends with a kinsoku pair ("丙，"): the whole pair moves
// down, so the comma never starts the last line.
{
  const lines = wrapText("甲乙丙，丁", 8);
  assert.deepEqual(lines, ["甲乙", "丙，丁"]);
}

// The previous line ends with an opening bracket glued to its character
// ("（丙"): the pair moves down together, so the previous line never ends
// with "（".
{
  const lines = wrapText("甲乙（丙丁", 8);
  assert.deepEqual(lines, ["甲乙", "（丙丁"]);
}

// An author's space before a CJK character is kept, the same as a space
// before a Latin word: "11 国中有 8 国" must not come out as "11国中有 8国".
assert.deepEqual(wrapText("11 国中有 8 国", 40), ["11 国中有 8 国"]);
assert.deepEqual(wrapText("6 国为 2021 年", 40), ["6 国为 2021 年"]);

// Latin-only input can never trigger widow control (no code point is
// ever "wide"), even when the greedy wrap happens to leave a single
// short word alone on the last line.
{
  const lines = wrapText("Alpha bravo charlie delta echo foxtrot golf", 10);
  assert.ok(lines.length >= 2, lines);
  assert.equal(lines.at(-1), "golf", "a lone final word on the last line is never pulled into the previous line");
  assert.equal(lines.join(" "), "Alpha bravo charlie delta echo foxtrot golf");
}

console.log("CJK widow control: PASS");
