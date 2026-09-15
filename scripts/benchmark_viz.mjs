#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { critiqueViz, lintVizSpec, renderVizBundle } from "../runtime/pi/viz.mjs";

const claimId = "claim-bench";
const base = {
  schema_version: "0.7.0",
  reader_task: "comparison",
  takeaway: "Synthetic benchmark takeaway.",
  title: "Synthetic newsroom visualization benchmark",
  subtitle: "In-memory lint and SVG rendering only",
  alt: "Synthetic chart used to benchmark deterministic newsroom visualization rendering performance.",
  source_note: "Synthetic benchmark data",
  claim_id: claimId,
  sql: "SELECT 1",
  unit: "%",
  sort: "desc",
  highlight_values: ["A"],
  direct_labels: true,
  annotations: [],
};

const categories = Array.from({ length: 16 }, (_, i) => ({ category: String.fromCharCode(65 + i), value: 20 + i * 3, start: 18 + i * 2, end: 23 + i * 3 }));
const timeRows = Array.from({ length: 24 }, (_, i) => ({ year: 2001 + i, value: 30 + i * 1.1 }));
const multiRows = ["A", "B", "C", "D"].flatMap((series, s) => Array.from({ length: 18 }, (_, i) => ({ year: 2007 + i, series, value: 20 + s * 8 + i * (1 + s * 0.12) })));
const facetRows = ["North", "South", "East", "West"].flatMap((facet, f) => Array.from({ length: 10 }, (_, i) => ({ facet, year: 2015 + i, value: 20 + f * 8 + i * 2 })));
const scatterRows = Array.from({ length: 80 }, (_, i) => ({ x: i + 1, y: 20 + i * 0.8 + (i % 5) * 2, label: `P${i + 1}` }));
const heatRows = ["A", "B", "C", "D", "E", "F"].flatMap((y, yi) => ["2019", "2020", "2021", "2022", "2023", "2024"].map((x, xi) => ({ x, y, value: 10 + yi * 7 + xi * 4 })));

const cases = [
  ["horizontal_bar", { ...base, reader_task: "ranking", chart_type: "horizontal_bar", category_field: "category", value_field: "value" }, categories],
  ["dot", { ...base, reader_task: "ranking", chart_type: "dot", category_field: "category", value_field: "value" }, categories],
  ["dumbbell", { ...base, chart_type: "dumbbell", category_field: "category", start_field: "start", end_field: "end" }, categories],
  ["slope", { ...base, chart_type: "slope", category_field: "category", start_field: "start", end_field: "end" }, categories.slice(0, 10)],
  ["line", { ...base, reader_task: "change", chart_type: "line", x_field: "year", value_field: "value" }, timeRows],
  ["multi_line", { ...base, reader_task: "change", chart_type: "multi_line", x_field: "year", value_field: "value", series_field: "series", highlight_values: ["A"] }, multiRows],
  ["small_multiples", { ...base, reader_task: "change", chart_type: "small_multiples", x_field: "year", value_field: "value", facet_field: "facet", panel_mark: "line" }, facetRows],
  ["scatter", { ...base, reader_task: "correlation", chart_type: "scatter", x_field: "x", y_field: "y", label_field: "label", x_unit: "index", y_unit: "%", unit: "%", highlight_values: ["P80"] }, scatterRows],
  ["diverging_bar", { ...base, chart_type: "diverging_bar", category_field: "category", value_field: "value" }, categories.map((r, i) => ({ ...r, value: i % 2 ? r.value : -r.value }))],
  ["heatmap", { ...base, reader_task: "distribution", chart_type: "heatmap", x_field: "x", y_field: "y", value_field: "value" }, heatRows],
];

const ITERATIONS = Number(process.env.NEWSROOM_BENCH_ITERATIONS || 120);
const P95_BUDGET_MS = Number(process.env.NEWSROOM_VIZ_P95_MS || 10);
const samples = [];
const perCase = [];

for (const [name, spec, rows] of cases) {
  const lint = lintVizSpec(spec, rows, { verified_claim_ids: [claimId] });
  if (!lint.passed) throw new Error(`${name} benchmark lint failed: ${lint.blockers.join(" | ")}`);
  renderVizBundle(spec, rows);
  const local = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const currentLint = lintVizSpec(spec, rows, { verified_claim_ids: [claimId] });
    const bundle = renderVizBundle(spec, rows);
    critiqueViz(spec, rows, currentLint, bundle.desktop);
    critiqueViz(spec, rows, currentLint, bundle.mobile);
    const elapsed = performance.now() - start;
    local.push(elapsed);
    samples.push(elapsed);
  }
  local.sort((a, b) => a - b);
  perCase.push({ name, p50: local[Math.floor(local.length * 0.50)], p95: local[Math.min(local.length - 1, Math.floor(local.length * 0.95))] });
}

samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length * 0.50)];
const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
const max = samples[samples.length - 1];

console.log(`responsive viz benchmark: ${cases.length} chart families x ${ITERATIONS} iterations (lint + desktop + mobile + dual critic)`);
for (const row of perCase) console.log(`${row.name.padEnd(18)} p50=${row.p50.toFixed(3)}ms p95=${row.p95.toFixed(3)}ms`);
console.log(`overall p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms budget=${P95_BUDGET_MS.toFixed(1)}ms`);
if (p95 > P95_BUDGET_MS) {
  console.error(`FAIL: visualization p95 ${p95.toFixed(3)}ms exceeds budget ${P95_BUDGET_MS.toFixed(1)}ms`);
  process.exit(2);
}
console.log("performance budget: PASS");
