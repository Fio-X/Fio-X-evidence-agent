#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { CHOROPLETH_BASEMAP_ID } from "../runtime/pi/choropleth.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";

const choroplethBasemap = getBasemap(CHOROPLETH_BASEMAP_ID);

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
};

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
