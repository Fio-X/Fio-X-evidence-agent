#!/usr/bin/env node
// Regression test for the mark/annotation layering fix (LAYERING_FIX in
// runtime/pi/viz.mjs) and its render-QA counterpart (stroke_over_mark in
// render_qa_geometry.mjs, opt-in via checkStrokeZOrder).
//
// The user's complaint: a dashed reference_line (and, in a follow-up
// correction, the solid 0-baseline and value-axis gridlines too) painted
// over bars/dots/connectors instead of behind them, so charts that combine
// a bar/dot/connector with a reference line looked "sloppy, like two
// separately-made pieces stuck together." House style (now the default -
// see styleFor/applyStyle in viz.mjs) turns LAYERING_FIX on; "legacy" is the
// only opt-out. This test proves:
//   1. The *legacy* escape hatch's draw order is unchanged (still fails the
//      new opt-in check - this documents the known pre-fix baseline, it is
//      not a regression, and legacy output stays byte-identical per
//      test_viz_snapshots.mjs).
//   2. The default (house) style - which turns LAYERING_FIX on - passes the
//      same check for horizontal_bar, dot, and dumbbell: no
//      reference-line/grid-line/zero-line stroke is painted after, and
//      crossing, a bar/dot/connector mark.
import assert from "node:assert/strict";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";
import { renderVizSvg, HOUSE_PALETTES } from "../runtime/pi/viz.mjs";

const baseSpec = {
  schema_version: "0.7.0",
  verification_mode: "draft",
  reader_task: "ranking",
  takeaway: "Layering-fix regression fixture.",
  alt: "Four economies against a 70 percent reference line.",
  source_note: "Synthetic regression fixture",
  sql: "SELECT * FROM synthetic",
  category_field: "economy",
  value_field: "value",
  unit: "%",
  sort: "desc",
  annotations: [{ type: "reference_line", value: 70, text: "七成" }],
};

const barRows = [
  { economy: "甲", value: 92 },
  { economy: "乙", value: 81 },
  { economy: "丙", value: 65 },
  { economy: "丁", value: 40 },
];

const dumbbellRows = [
  { economy: "甲", start: 30, end: 92 },
  { economy: "乙", start: 20, end: 81 },
  { economy: "丙", start: 55, end: 65 },
  { economy: "丁", start: 10, end: 40 },
];

function strokeOverMarkFailures(svg, pageBackground) {
  return checkSvgGeometry(svg, { checkStrokeZOrder: true, pageBackground }).failures.filter((f) => f.rule === "stroke_over_mark");
}

function paperFor(styleId) {
  return styleId === "legacy" ? "#ffffff" : HOUSE_PALETTES.house.paper;
}

const scenarios = [
  { name: "horizontal_bar", spec: { ...baseSpec, title: "横向条形图", chart_type: "horizontal_bar" }, rows: barRows },
  { name: "dot", spec: { ...baseSpec, title: "点图", chart_type: "dot" }, rows: barRows },
  {
    name: "dumbbell",
    spec: { ...baseSpec, title: "哑铃图", chart_type: "dumbbell", start_field: "start", end_field: "end", start_label: "起点", end_label: "终点" },
    rows: dumbbellRows,
  },
];

let checked = 0;
for (const { name, spec, rows } of scenarios) {
  // Legacy escape hatch: known pre-fix baseline, not asserted to pass - only
  // that the check itself still runs and returns the rule (proves the
  // opt-in rule fires on real renderer output, not just the hand-built unit
  // fixtures in test_render_qa_geometry.mjs).
  const legacySvg = renderVizSvg({ ...spec, style_id: "legacy" }, rows);
  const legacyFailures = strokeOverMarkFailures(legacySvg, paperFor("legacy"));
  assert.ok(legacyFailures.length > 0, `${name}: legacy style is expected to still show the pre-fix stroke_over_mark defect (documents the known baseline; not asserting it disappears without LAYERING_FIX)`);

  // Default (house) style: LAYERING_FIX is on, so no run needs an explicit
  // style_id/style at all - unstyled specs get the fix for free.
  const houseSvg = renderVizSvg({ ...spec }, rows);
  const houseFailures = strokeOverMarkFailures(houseSvg, paperFor("house"));
  assert.deepEqual(houseFailures, [], `${name}/house (default): expected no stroke_over_mark failures, got ${JSON.stringify(houseFailures, null, 2)}`);
  checked++;
}

console.log(`test_house_style_layering: PASS (${checked} style/chart-type combinations checked clean, default baseline confirmed unchanged)`);
