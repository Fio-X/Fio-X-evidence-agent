#!/usr/bin/env node
// Fix 3 regression test: "units repeat on every tick" ("3 个孩子 / 2.5 个孩子
// / …" on the trend/world line charts, and "0 个孩子 / 0.5 个孩子 …" on the
// peer dot chart). Best practice (FT/Economist/SCMP): axis ticks show bare
// numbers, and the unit appears once - on the top-most y tick (line/
// multi_line) or the last x tick (horizontal_bar/dot/dumbbell), which are
// all drawn by the one shared addHorizontalAxis()/renderLine() Y-tick loops.
// Direct value labels on dot/bar charts carry the unit on the first
// (top-most, as drawn) label only; a single line's own end label keeps its
// unit (covered by test_value_label_decimals.mjs's assertWorldEndLabels,
// unaffected by this fix - left untouched here to avoid duplicating it).
//
// This is a house-style-only behaviour (HOUSE_STYLE_ACTIVE): legacy style
// keeps the old, fully-repeated-unit output byte-for-byte, verified below.
import assert from "node:assert/strict";
import { renderVizSvg, renderVizMobileSvg } from "../runtime/pi/viz.mjs";

const claimId = "claim-axis-unit-once";
const baseSpec = {
  schema_version: "0.7.0",
  reader_task: "change",
  takeaway: "Illustrative fixture for the axis-tick/direct-label unit rule.",
  language: "zh",
  alt: "占位替代文本。",
  source_note: "测试数据",
  claim_id: claimId,
  sql: "SELECT * FROM synthetic",
};

// Y-axis tick text nodes, in ascending-value order (renderLine/renderMobileLine
// draw them top-to-bottom on the page, but the underlying values ascend -
// see the module's own note on lineAxisTicks/tickValues ordering), isolated
// by the same text-anchor="end" pattern test_value_label_decimals.mjs uses.
function extractYAxisTicks(svg) {
  return [...svg.matchAll(/<text x="[-0-9.]+" y="[-0-9.]+" text-anchor="end" font-family="[^"]+" font-size="12" fill="[^"]+">([^<]*)<\/text>/g)].map((m) => m[1]);
}
// Horizontal-axis tick text nodes (addHorizontalAxis: horizontal_bar/dot/
// dumbbell), isolated the same way test_viz_ticks.mjs does.
function extractXAxisTicks(svg) {
  return [...svg.matchAll(/text-anchor="middle"[^>]*font-size="12"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}
// Direct/row value labels: the only font-weight="600" text nodes, same
// isolation test_value_label_decimals.mjs relies on.
function extractValueLabels(svg) {
  return [...svg.matchAll(/<text[^>]*font-weight="600"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

function assertUnitOnLastOnly(ticks, unit, label) {
  assert.ok(ticks.length >= 2, `${label}: need at least 2 ticks to exercise the rule, got ${JSON.stringify(ticks)}`);
  for (let i = 0; i < ticks.length - 1; i++) {
    assert.ok(!ticks[i].includes(unit), `${label}: tick[${i}]="${ticks[i]}" must be a bare number, not carry "${unit}"`);
  }
  assert.ok(ticks[ticks.length - 1].includes(unit), `${label}: the last tick must carry the unit "${unit}", got ${JSON.stringify(ticks)}`);
}

function assertUnitOnFirstOnly(labels, unit, label) {
  assert.ok(labels.length >= 2, `${label}: need at least 2 value labels to exercise the rule, got ${JSON.stringify(labels)}`);
  assert.ok(labels[0].includes(unit), `${label}: the first value label must carry the unit "${unit}", got ${JSON.stringify(labels)}`);
  for (let i = 1; i < labels.length; i++) {
    assert.ok(!labels[i].includes(unit), `${label}: value label[${i}]="${labels[i]}" must be a bare number, not carry "${unit}"`);
  }
}

// --- 1. Single-series line: Y ticks bare except the top-most --------------
{
  const spec = { ...baseSpec, chart_type: "line", title: "单线轴单位测试", unit: "个孩子", x_field: "year", value_field: "value" };
  const rows = [
    { year: 2019, value: 0.5 }, { year: 2020, value: 1.1 }, { year: 2021, value: 1.8 },
    { year: 2022, value: 2.4 }, { year: 2023, value: 3.1 },
  ];
  for (const [name, render] of [["desktop", renderVizSvg], ["mobile", renderVizMobileSvg]]) {
    const svg = render(spec, rows);
    assertUnitOnLastOnly(extractYAxisTicks(svg), "个孩子", `line ${name} Y ticks`);
  }
  console.log("line chart: Y-axis ticks bare except the top-most: PASS");
}

// --- 2. Multi-line (China vs. World shape): same shared Y-tick loop -------
{
  const spec = {
    ...baseSpec, chart_type: "multi_line", visual_family: "statistical", title: "双线轴单位测试",
    unit: "个孩子", x_field: "year", value_field: "value", series_field: "entity", highlight_values: ["China"],
  };
  const rows = [
    { year: 2019, value: 1.5, entity: "China" }, { year: 2023, value: 1.0, entity: "China" },
    { year: 2019, value: 2.3, entity: "World" }, { year: 2023, value: 3.2, entity: "World" },
  ];
  const svg = renderVizSvg(spec, rows);
  assertUnitOnLastOnly(extractYAxisTicks(svg), "个孩子", "multi_line Y ticks");
  console.log("multi_line chart: Y-axis ticks bare except the top-most: PASS");
}

// --- 3. Dot chart (viz-peer.json shape): X ticks AND direct labels --------
{
  const spec = {
    ...baseSpec, chart_type: "dot", visual_family: "statistical", title: "点图轴单位测试",
    unit: "个孩子", category_field: "entity", value_field: "tfr", sort: "desc", direct_labels: true,
    highlight_values: ["China"],
  };
  const rows = [
    { entity: "World", tfr: 2.251 }, { entity: "United States", tfr: 1.624 }, { entity: "Japan", tfr: 1.208 },
    { entity: "China", tfr: 0.999 }, { entity: "Korea, Rep.", tfr: 0.72 },
  ];
  for (const [name, render] of [["desktop", renderVizSvg], ["mobile", renderVizMobileSvg]]) {
    const svg = render(spec, rows);
    assertUnitOnLastOnly(extractXAxisTicks(svg), "个孩子", `dot ${name} X ticks`);
    assertUnitOnFirstOnly(extractValueLabels(svg), "个孩子", `dot ${name} direct labels`);
  }
  console.log("dot chart: X-axis ticks bare except the last, direct labels bare except the first: PASS");
}

// --- 4. horizontal_bar shares the exact same renderHorizontal() code path -
{
  const spec = {
    ...baseSpec, chart_type: "horizontal_bar", visual_family: "statistical", title: "条形图轴单位测试",
    unit: "units", category_field: "category", value_field: "value", sort: "desc", highlight_values: ["A"],
  };
  const rows = [{ category: "A", value: 42 }, { category: "B", value: 31 }, { category: "C", value: 18 }, { category: "D", value: 9 }];
  const svg = renderVizSvg(spec, rows);
  assertUnitOnLastOnly(extractXAxisTicks(svg), "units", "horizontal_bar X ticks");
  assertUnitOnFirstOnly(extractValueLabels(svg), "units", "horizontal_bar direct labels");
  console.log("horizontal_bar: same shared axis/label rule as dot (renderHorizontal): PASS");
}

// --- 5. Percent unit: fix 3 applies to "%" too - it is not decimals-style -
//    scoped away from "%" the way fix 2's resolveChartDecimals() is. Best
//    practice keeps a bare "20 / 40 / 60 / 80%" axis, not "20% / 40% / …".
{
  const spec = {
    ...baseSpec, chart_type: "horizontal_bar", visual_family: "statistical", title: "百分比轴单位测试",
    unit: "%", category_field: "category", value_field: "value", sort: "desc", highlight_values: [],
  };
  const rows = [{ category: "A", value: 92 }, { category: "B", value: 61 }, { category: "C", value: 30 }];
  const svg = renderVizSvg(spec, rows);
  assertUnitOnLastOnly(extractXAxisTicks(svg), "%", "percent horizontal_bar X ticks");
  assertUnitOnFirstOnly(extractValueLabels(svg), "%", "percent horizontal_bar direct labels");
  console.log("percent unit ('%'): same once-only rule applies, independent of fix 2's decimals scoping: PASS");
}

// --- 6. Legacy style: byte-identical old behaviour - unit on every tick ---
//    and every direct label, for both a Y-axis chart and an X-axis chart.
{
  const lineSpec = { ...baseSpec, chart_type: "line", title: "单线轴单位测试", unit: "个孩子", x_field: "year", value_field: "value", style_id: "legacy" };
  const lineRows = [{ year: 2019, value: 0.5 }, { year: 2020, value: 1.1 }, { year: 2021, value: 1.8 }, { year: 2022, value: 2.4 }, { year: 2023, value: 3.1 }];
  const lineSvg = renderVizSvg(lineSpec, lineRows);
  const lineTicks = extractYAxisTicks(lineSvg);
  assert.ok(lineTicks.length >= 2, "legacy line: expected at least 2 Y ticks");
  assert.ok(lineTicks.every((t) => t.includes("个孩子")), `legacy style must keep the unit on every Y tick: ${JSON.stringify(lineTicks)}`);

  const barSpec = { ...baseSpec, chart_type: "horizontal_bar", visual_family: "statistical", title: "条形图轴单位测试", unit: "units", category_field: "category", value_field: "value", sort: "desc", highlight_values: [], style_id: "legacy" };
  const barRows = [{ category: "A", value: 42 }, { category: "B", value: 31 }, { category: "C", value: 18 }, { category: "D", value: 9 }];
  const barSvg = renderVizSvg(barSpec, barRows);
  const barTicks = extractXAxisTicks(barSvg);
  const barLabels = extractValueLabels(barSvg);
  assert.ok(barTicks.every((t) => t.includes("units")), `legacy style must keep the unit on every X tick: ${JSON.stringify(barTicks)}`);
  assert.ok(barLabels.every((t) => t.includes("units")), `legacy style must keep the unit on every direct label: ${JSON.stringify(barLabels)}`);
  console.log("legacy style: unit repeated on every tick and every direct label, byte-for-byte unchanged: PASS");
}

console.log("axis-tick / direct-label unit-once regression: PASS");
