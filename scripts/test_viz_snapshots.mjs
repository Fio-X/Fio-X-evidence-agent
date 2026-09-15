#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { renderVizBundle } from "../runtime/pi/viz.mjs";

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
};

const actual = {};
for (const [name, [spec, rows]] of Object.entries(cases)) {
  const bundle = renderVizBundle(spec, rows);
  actual[name] = {
    desktop: createHash("sha256").update(bundle.desktop).digest("hex"),
    mobile: createHash("sha256").update(bundle.mobile).digest("hex"),
  };
}

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
