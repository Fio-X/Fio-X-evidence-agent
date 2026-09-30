#!/usr/bin/env node
// Regression test for fix 13: renderSlope/renderMobileSlope's two label
// helpers called `fmt(e.a, spec.unit)` / `fmt(e.b, spec.unit)` directly - no
// resolved decimals count, and the unit on every label. Reported: comp-01's
// 亿-scale values (e.g. 3756 rising to 8817, alongside 6876 rising to 8740,
// unit "亿美元") fell into fmt()'s old abs>=1_000 magnitude branch and
// printed as "8.8k 亿美元" - an abbreviation that hides three of a
// four-digit number's digits on a chart whose whole point is showing the
// exact figures.
//
// Fix: resolve one shared decimals count per chart through the same
// resolveChartDecimals() path renderHorizontal/renderLine already use, and
// pass it to fmt() for every slope label - Number.isInteger(decimals) skips
// the magnitude/abbreviation branches entirely, exactly as it already does
// for every other chart type. Unit-once follows d7c8e27's own dot/bar rule:
// the unit shows on the first label actually drawn (row 0's left label)
// only, every other label (that row's right label, and every other row's
// both labels) is bare. Both are gated on HOUSE_STYLE_ACTIVE, so legacy
// keeps abbreviating and repeating the unit on every label, byte-for-byte.
import assert from "node:assert/strict";
import { renderVizSvg, renderVizMobileSvg } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

// The exact reported comp-01 shape: two economies, 亿-scale start/end values,
// unit "亿美元".
const slopeSpec = {
  schema_version: "0.7.0",
  reader_task: "comparison",
  chart_type: "slope",
  title: "comp-01 fixture",
  takeaway: "Synthetic fix-13 fixture reproducing the reported comp-01 shape.",
  alt: "Synthetic fixture exercising the slope-chart decimals/unit-once fix.",
  source_note: "Synthetic fixture",
  claim_id: "claim-slope-fix13",
  sql: "SELECT * FROM synthetic",
  unit: "亿美元",
  category_field: "entity",
  start_field: "start",
  end_field: "end",
  start_label: "2015",
  end_label: "2023",
  highlight_values: ["X"],
};
const slopeRows = [
  { entity: "X", start: 3756, end: 8817 },
  { entity: "Y", start: 6876, end: 8740 },
];

// renderLine/renderSlope's own label text nodes are the only plain <text>
// elements in this chart's output besides the axis-header pair
// (start_label/end_label) and the footer's source note - matching those out
// is simpler here than isolating a shared data-role, since slope labels
// carry none.
function extractLabelTexts(svg) {
  const all = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  return all.filter((t) => t !== "comp-01 fixture" && t !== "2015" && t !== "2023" && !t.startsWith("Source:"));
}

// --- House style (desktop): no abbreviation, unit exactly once -----------

const svg = renderVizSvg(slopeSpec, slopeRows);
const mobileSvg = renderVizMobileSvg(slopeSpec, slopeRows);
const labels = extractLabelTexts(svg);

assert.equal(labels.length, 4, `expected exactly 4 slope labels (2 rows x start+end), got ${JSON.stringify(labels)}`);
assert.ok(!labels.some((t) => /\dk\b/.test(t)), `no label may contain a "k" abbreviation - a value >= 1000 must print in full once decimals are resolved: ${JSON.stringify(labels)}`);
const unitCount = labels.filter((t) => t.includes("亿美元")).length;
assert.equal(unitCount, 1, `the unit must appear exactly once across all 4 labels (on the first one drawn): ${JSON.stringify(labels)}`);
assert.ok(labels[0].startsWith("X ") && labels[0].endsWith("亿美元"), `the first drawn label (row 0's left/start label) must carry both the category name and the unit: ${JSON.stringify(labels)}`);
for (const num of ["3756", "6876", "8817", "8740"]) {
  assert.ok(labels.some((t) => t.includes(num)), `expected "${num}" to appear in full (not abbreviated) among the slope labels: ${JSON.stringify(labels)}`);
}

console.log("house style slope: no k/m/bn abbreviation, unit shown exactly once, all 4 values in full: PASS");

// --- Render-QA: desktop geometry must pass (Task's explicit requirement) -

const qa = runRenderQa({ desktop: svg, mobile: mobileSvg });
assert.equal(qa.viewports.desktop.geometry.passed, true, `desktop render-QA geometry must pass: ${JSON.stringify(qa.viewports.desktop.geometry.failures)}`);

console.log("house style slope: desktop render-QA geometry check passes: PASS");

// --- Legacy style: byte-for-byte original abbreviation + every-label-unit

// style_id:"legacy" must resolve HOUSE_STYLE_ACTIVE to false, so
// resolveChartDecimals() returns null and fmt() takes its untouched old
// abs>=1_000 "k" branch, and every label keeps its own unit - i.e. this
// fix must not change legacy rendering at all.
const legacySvg = renderVizSvg({ ...slopeSpec, style_id: "legacy" }, slopeRows);
const legacyLabels = extractLabelTexts(legacySvg);
assert.deepEqual(
  legacyLabels,
  ["X 3.8k 亿美元", "8.8k 亿美元", "Y 6.9k 亿美元", "8.7k 亿美元"],
  `legacy style must keep its old abbreviated, every-label-unit output byte-for-byte: ${JSON.stringify(legacyLabels)}`,
);

console.log("legacy style (style_id=\"legacy\"): old abbreviated, every-label-unit output untouched, byte-for-byte: PASS");

console.log("slope-chart decimals/unit-once regression (fix 13): PASS");
