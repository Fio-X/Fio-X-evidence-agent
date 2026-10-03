#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { CHOROPLETH_BASEMAP_ID } from "../runtime/pi/choropleth.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";

const choroplethBasemap = getBasemap(CHOROPLETH_BASEMAP_ID);

const complexBase = {
  schema_version: "0.8.0",
  takeaway: "Snapshot fixture",
  title: "Snapshot fixture",
  alt: "Stable synthetic newsroom visualization used for SVG regression snapshot testing.",
  source_note: "Synthetic snapshot fixture",
  claim_id: "snapshot-claim",
  sql: "SELECT 1",
  unit: "units",
  complexity_budget: "medium",
  annotations: [],
  highlight_values: [],
};

const base = {
  schema_version: "0.7.0",
  reader_task: "comparison",
  takeaway: "Snapshot fixture",
  title: "Snapshot fixture",
  alt: "Stable synthetic newsroom visualization used for SVG regression snapshot testing.",
  source_note: "Synthetic snapshot fixture",
  claim_id: "snapshot-claim",
  sql: "SELECT 1",
  unit: "%",
  direct_labels: true,
  annotations: [],
  highlight_values: [],
};

const cases = {
  dumbbell: [
    { ...base, chart_type: "dumbbell", category_field: "c", start_field: "a", end_field: "b", highlight_values: ["B"] },
    [{ c: "A", a: 20, b: 35 }, { c: "B", a: 42, b: 61 }, { c: "C", a: 55, b: 49 }],
  ],
  multi_line: [
    { ...base, reader_task: "change", chart_type: "multi_line", x_field: "year", value_field: "value", series_field: "series", highlight_values: ["A"] },
    ["A", "B", "C"].flatMap((series, s) => [2021, 2022, 2023, 2024].map((year, i) => ({ series, year, value: 20 + s * 10 + i * (3 + s) }))),
  ],
  heatmap: [
    { ...base, reader_task: "distribution", chart_type: "heatmap", x_field: "x", y_field: "y", value_field: "value" },
    ["North", "South", "West"].flatMap((y, yi) => ["2022", "2023", "2024"].map((x, xi) => ({ x, y, value: 10 + yi * 9 + xi * 5 }))),
  ],
  // B2: reference_line annotations, one per supported chart_type/panel shape,
  // covering every desktop+mobile renderer pair the fix touched.
  horizontal_bar_reference_line: [
    { ...base, chart_type: "horizontal_bar", category_field: "c", value_field: "v", annotations: [{ type: "reference_line", text: "Target: 30", value: 30, claim_id: "snapshot-claim" }] },
    [{ c: "A", v: 42 }, { c: "B", v: 31 }, { c: "C", v: 18 }, { c: "D", v: 9 }],
  ],
  dot_grouped_reference_line: [
    { ...base, chart_type: "dot", category_field: "c", value_field: "v", series_field: "s", annotations: [{ type: "reference_line", text: "Target: 120", value: 120, claim_id: "snapshot-claim" }] },
    [{ c: "Jan", s: "2025", v: 100 }, { c: "Jan", s: "2026", v: 130 }, { c: "Feb", s: "2025", v: 110 }, { c: "Feb", s: "2026", v: 140 }],
  ],
  dumbbell_reference_line: [
    { ...base, chart_type: "dumbbell", category_field: "c", start_field: "a", end_field: "b", annotations: [{ type: "reference_line", text: "Target: 45", value: 45, claim_id: "snapshot-claim" }] },
    [{ c: "A", a: 20, b: 35 }, { c: "B", a: 42, b: 61 }, { c: "C", a: 55, b: 49 }],
  ],
  small_multiples_dot_reference_line: [
    { ...base, chart_type: "small_multiples", panel_mark: "dot", facet_field: "f", x_field: "c", value_field: "v", annotations: [{ type: "reference_line", text: "Target: 100", value: 100, claim_id: "snapshot-claim" }] },
    ["North", "South"].flatMap((f) => ["A", "B", "C"].map((c, i) => ({ f, c, v: 60 + i * 30 }))),
  ],
  small_multiples_line_reference_line: [
    { ...base, chart_type: "small_multiples", facet_field: "f", x_field: "year", value_field: "v", annotations: [{ type: "reference_line", text: "Target: 50", value: 50, claim_id: "snapshot-claim" }] },
    ["North", "South"].flatMap((f) => [2021, 2022, 2023].map((year, i) => ({ f, year, v: 30 + i * 12 }))),
  ],
  // B1: language: "zh" localizes note/source prefixes and other
  // renderer-added strings using existing CJK wrapping.
  horizontal_bar_zh: [
    { ...base, chart_type: "horizontal_bar", category_field: "c", value_field: "v", language: "zh", title: "快照测试图表", note: "仅用于回归测试", annotations: [] },
    [{ c: "甲", v: 42 }, { c: "乙", v: 31 }, { c: "丙", v: 18 }],
  ],
  // G1: percentage waffle - one 10x10 grid per row, reference_period_field
  // rendered as a small muted tspan, and a highlighted row's numeral.
  waffle: [
    { ...base, reader_task: "part_to_whole", chart_type: "waffle", category_field: "c", value_field: "v", reference_period_field: "year", highlight_values: ["B"] },
    [{ c: "A", v: 24, year: 2023 }, { c: "B", v: 61, year: 2023 }, { c: "C", v: 88, year: 2023 }],
  ],
  // E: range_bracket annotation - reserves a right margin only when present
  // and draws a bracket spanning the first-to-last matched row.
  horizontal_bar_range_bracket: [
    { ...base, chart_type: "horizontal_bar", category_field: "c", value_field: "v", annotations: [{ type: "range_bracket", match_field: "c", match_value: "A", end_match_value: "C", text: "Top three, snapshot fixture", claim_id: "snapshot-claim" }] },
    [{ c: "A", v: 42 }, { c: "B", v: 31 }, { c: "C", v: 24 }, { c: "D", v: 9 }],
  ],
  // E: range_bracket (accent tone) on a plain (ungrouped) dot chart,
  // combined with category_names ("worldbank" -> vendored zh name) on a
  // zh-language chart - the densest supported combination of this task's
  // features in one snapshot.
  dot_range_bracket_category_names_zh: [
    {
      ...base, chart_type: "dot", category_field: "country", value_field: "v", language: "zh", category_names: "worldbank",
      title: "快照测试：可再生能源占比", note: "仅用于回归测试",
      annotations: [{ type: "range_bracket", match_field: "country", match_value: "Congo, Dem. Rep.", end_match_value: "Zambia", text: "三个经济体占比最高", claim_id: "snapshot-claim" }],
    },
    [{ country: "Congo, Dem. Rep.", v: 96 }, { country: "Liberia", v: 94 }, { country: "Zambia", v: 89 }, { country: "Ghana", v: 45 }],
  ],
  // G3: treemap - squarified part-to-whole area encoding, one dominant tile
  // plus a highlighted mid tile, and a group_field one-level grouping so
  // the legend + group-boundary strokes are exercised in the snapshot too.
  treemap: [
    { ...base, reader_task: "part_to_whole", chart_type: "treemap", category_field: "c", value_field: "v", group_field: "g", highlight_values: ["B"] },
    [{ c: "A", v: 42, g: "X" }, { c: "B", v: 31, g: "X" }, { c: "C", v: 18, g: "Y" }, { c: "D", v: 9, g: "Y" }],
  ],
  // G2: choropleth - Natural Earth basemap join via category_names, 5-class
  // sequential ramp, and the locator inset.
  choropleth: [
    {
      ...base, reader_task: "spatial", chart_type: "choropleth", category_field: "country", value_field: "v", category_names: "worldbank",
      basemap_id: choroplethBasemap.id, basemap_source_url: choroplethBasemap.source_url, basemap_license: choroplethBasemap.license, basemap_content_hash: choroplethBasemap.content_hash,
    },
    [{ country: "Chad", v: 70.0 }, { country: "Guinea", v: 66.6 }, { country: "Liberia", v: 92.8 }, { country: "Nigeria", v: 80.3 }, { country: "Zambia", v: 83.0 }],
  ],
  // Names the chart is not told about stay as they are. Each case below holds
  // values the vendored name tables could localize (World Bank names, ISO3,
  // ISO2 and ISO 4217 codes), but the spec sets no category_names and the
  // column fails the auto-resolution test: its field name says nothing about
  // economies or currencies, or one of its values is unknown to the table, or
  // its code type (ISO2) is explicit-only. The renderer must print the values
  // as they are, byte for byte as before the tables grew (the digests below
  // were taken at the commit before them and are unchanged).
  horizontal_bar_zh_country_field_partial_match: [
    { ...base, chart_type: "horizontal_bar", category_field: "country", value_field: "v", language: "zh", title: "快照测试图表", note: "仅用于回归测试" },
    [{ country: "Kenya", v: 42 }, { country: "Norway", v: 31 }, { country: "Brazil", v: 24 }, { country: "Atlantis", v: 9 }],
  ],
  horizontal_bar_zh_iso3_codes_unsignalled_field: [
    { ...base, chart_type: "horizontal_bar", category_field: "c", value_field: "v", language: "zh", title: "快照测试图表", note: "仅用于回归测试" },
    [{ c: "KEN", v: 42 }, { c: "NOR", v: 31 }, { c: "BRA", v: 24 }, { c: "CHN", v: 9 }],
  ],
  horizontal_bar_zh_currency_codes_unsignalled_field: [
    { ...base, chart_type: "horizontal_bar", category_field: "code", value_field: "v", language: "zh", title: "快照测试图表", note: "仅用于回归测试" },
    [{ code: "TRY", v: 42 }, { code: "GBP", v: 31 }, { code: "JPY", v: 24 }, { code: "USD", v: 9 }],
  ],
  horizontal_bar_zh_iso2_codes_country_field: [
    { ...base, chart_type: "horizontal_bar", category_field: "country", value_field: "v", language: "zh", title: "快照测试图表", note: "仅用于回归测试" },
    [{ country: "KE", v: 42 }, { country: "NO", v: 31 }, { country: "BR", v: 24 }, { country: "CN", v: 9 }],
  ],
  horizontal_bar_zh_currency_field_partial_match: [
    { ...base, chart_type: "horizontal_bar", category_field: "currency", value_field: "v", language: "zh", title: "快照测试图表", note: "仅用于回归测试" },
    [{ currency: "USD", v: 42 }, { currency: "EUR", v: 31 }, { currency: "Basket", v: 24 }],
  ],
  horizontal_bar_en_plain_names: [
    { ...base, chart_type: "horizontal_bar", category_field: "region", value_field: "v" },
    [{ region: "Northern Europe", v: 42 }, { region: "Southern Europe", v: 31 }, { region: "Eastern Europe", v: 24 }],
  ],
  // An English chart keeps the World Bank English names, auto-resolved or
  // declared (two of the declared names, Hong Kong and the DRC, have a zh override).
  horizontal_bar_en_worldbank_names_auto: [
    { ...base, chart_type: "horizontal_bar", category_field: "country", value_field: "v" },
    [{ country: "Kenya", v: 42 }, { country: "Norway", v: 31 }, { country: "Brazil", v: 24 }],
  ],
  horizontal_bar_en_worldbank_names_declared: [
    { ...base, chart_type: "horizontal_bar", category_field: "country", value_field: "v", category_names: "worldbank" },
    [{ country: "Kenya", v: 42 }, { country: "Norway", v: 31 }, { country: "Hong Kong SAR, China", v: 24 }, { country: "Congo, Dem. Rep.", v: 9 }],
  ],
  // Chart types whose name fields the viz-spec guidance now lists: a scatter
  // label_field, a multi_line series_field and sankey nodes, with no
  // category_names, print their values as they are. (The sankey source column
  // is named iso3 and holds only ISO3 codes: flow charts are explicit-only, so
  // even a perfect match is not auto-resolved. The scatter and multi_line
  // columns match only in part, so these two stay as they are whether or not a
  // renderer learns to localize a declared category_names.)
  scatter_zh_iso3_label_field: [
    { ...base, reader_task: "correlation", chart_type: "scatter", x_field: "x", y_field: "y", label_field: "label", x_unit: "index", y_unit: "%", unit: "%", highlight_values: ["KEN"], language: "zh", title: "快照测试图表", note: "仅用于回归测试" },
    [{ x: 1, y: 20, label: "KEN" }, { x: 2, y: 26, label: "NOR" }, { x: 3, y: 31, label: "BRA" }, { x: 4, y: 29, label: "CHN" }, { x: 5, y: 40, label: "IND" }],
  ],
  scatter_zh_country_label_field_partial_match: [
    { ...base, reader_task: "correlation", chart_type: "scatter", x_field: "x", y_field: "y", label_field: "country", x_unit: "index", y_unit: "%", unit: "%", highlight_values: ["Kenya"], language: "zh", title: "快照测试图表", note: "仅用于回归测试" },
    [{ x: 1, y: 20, country: "Kenya" }, { x: 2, y: 26, country: "Norway" }, { x: 3, y: 31, country: "Atlantis" }, { x: 4, y: 29, country: "China" }, { x: 5, y: 40, country: "India" }],
  ],
  multi_line_zh_country_series_partial_match: [
    { ...base, reader_task: "change", chart_type: "multi_line", x_field: "year", value_field: "value", series_field: "country", highlight_values: ["Kenya"], language: "zh", title: "快照测试图表", note: "仅用于回归测试" },
    ["Kenya", "Norway", "Atlantis"].flatMap((country, s) => [2021, 2022, 2023, 2024].map((year, i) => ({ country, year, value: 20 + s * 10 + i * (3 + s) }))),
  ],
  sankey_zh_iso3_source_field_explicit_only: [
    { ...complexBase, reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", chart_type: "sankey", source_field: "iso3", target_field: "target", value_field: "value", language: "zh", title: "快照测试图表", note: "仅用于回归测试" },
    [{ iso3: "KEN", target: "Exports", value: 20 }, { iso3: "NOR", target: "Exports", value: 30 }, { iso3: "BRA", target: "Exports", value: 25 }, { iso3: "CHN", target: "Domestic", value: 15 }],
  ],
};

// A snapshot refresh rewrites the digests blindly, so the intent of the cases
// above is also checked on the markup: each prints its raw values (as a
// whole text node, or as a label followed by a value) in both viewports. A
// localized name sneaking into these charts fails here before --update can
// bless it.
const PRINTS_RAW_VALUES = {
  horizontal_bar_zh_country_field_partial_match: ["Kenya", "Norway", "Brazil", "Atlantis"],
  horizontal_bar_zh_iso3_codes_unsignalled_field: ["KEN", "NOR", "BRA", "CHN"],
  horizontal_bar_zh_currency_codes_unsignalled_field: ["TRY", "GBP", "JPY", "USD"],
  horizontal_bar_zh_iso2_codes_country_field: ["KE", "NO", "BR", "CN"],
  horizontal_bar_zh_currency_field_partial_match: ["USD", "EUR", "Basket"],
  horizontal_bar_en_plain_names: ["Northern Europe", "Southern Europe", "Eastern Europe"],
  horizontal_bar_en_worldbank_names_auto: ["Kenya", "Norway", "Brazil"],
  horizontal_bar_en_worldbank_names_declared: ["Kenya", "Norway", "Hong Kong SAR, China", "Congo, Dem. Rep."],
  scatter_zh_iso3_label_field: ["KEN"],
  scatter_zh_country_label_field_partial_match: ["Kenya"],
  multi_line_zh_country_series_partial_match: ["Kenya", "Atlantis"],
  sankey_zh_iso3_source_field_explicit_only: ["KEN", "NOR", "BRA", "CHN"],
};
for (const [name, values] of Object.entries(PRINTS_RAW_VALUES)) {
  const [spec, rows] = cases[name];
  const bundle = renderVizBundle(spec, rows);
  for (const value of values) {
    for (const viewport of ["desktop", "mobile"]) {
      assert.ok(bundle[viewport].includes(`>${value}<`) || bundle[viewport].includes(`>${value} `), `${name}: the ${viewport} render does not print ${value} as it is`);
    }
  }
}

const actual = {};
for (const [name, [spec, rows]] of Object.entries(cases)) {
  const bundle = renderVizBundle(spec, rows);
  actual[name] = {
    desktop: createHash("sha256").update(bundle.desktop).digest("hex"),
    mobile: createHash("sha256").update(bundle.mobile).digest("hex"),
  };
}

// Annotation layers are new renderer output; they must pass the same
// render-QA gate (12px floor, overlap, contrast) the product enforces at
// render time. Checked before --update so a snapshot refresh can't skip it.
const qaFailures = [];
for (const [name, [spec, rows]] of Object.entries(cases)) {
  if (!/reference_line|range_bracket|waffle|choropleth|treemap/.test(name)) continue;
  const qa = runRenderQa({ desktop: renderVizBundle(spec, rows).desktop });
  if (!qa.passed) qaFailures.push(`${name}: ${JSON.stringify(qa.viewports.desktop.geometry.failures.concat(qa.viewports.desktop.contrast.failures)).slice(0, 300)}`);
}
assert.deepEqual(qaFailures, [], qaFailures.join("\n"));

const url = new URL("../fixtures/viz-snapshots.json", import.meta.url);
if (process.argv.includes("--update")) {
  await writeFile(url, JSON.stringify(actual, null, 2) + "\n", "utf8");
  console.log("viz snapshots updated");
  console.log(actual);
  process.exit(0);
}

const expected = JSON.parse(await readFile(url, "utf8"));
assert.deepEqual(actual, expected);
console.log("viz snapshots: PASS");
for (const [name, hashes] of Object.entries(actual)) console.log(`${name}: desktop=${hashes.desktop.slice(0, 12)} mobile=${hashes.mobile.slice(0, 12)}`);
