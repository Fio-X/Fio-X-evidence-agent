// Fix 6 regression test: a single-series line with no highlight signal must
// draw in ink (#1A1A1A), not the mid-grey "de-emphasised context series"
// colour (accent2, #757575) it used to hardcode unconditionally. The accent
// (#D0021B) is reserved for an explicit highlight_values match against one
// of the series' own x-values (e.g. calling out the endpoint) - the same
// convention every non-line chart type already uses for highlight_values.
// This test targets the color/emphasis branch in isolation with a small
// illustrative dataset; the real China TFR series (and its 3-decimal value
// labels) is covered end-to-end by test_value_label_decimals.mjs and by the
// task's rendered trend.png.
import assert from "node:assert/strict";
import { renderVizSvg, renderVizMobileSvg } from "../runtime/pi/viz.mjs";

const INK = "#1A1A1A";
const ACCENT = "#D0021B";
const ACCENT2_HOUSE = "#757575";
const ACCENT2_LEGACY = "#2f6f8f";

const baseSpec = {
  chart_type: "line",
  visual_family: "temporal",
  language: "zh",
  reader_task: "change",
  title: "单线颜色回归测试",
  subtitle: "",
  takeaway: "占位说明。",
  alt: "占位替代文本。",
  source_note: "测试数据",
  claim_id: "claim-702e6061e3521144",
  sql: "SELECT * FROM synthetic",
  unit: "个孩子",
  x_field: "year",
  value_field: "value",
};

const rows = [
  { year: 2019, value: 1.5 },
  { year: 2020, value: 1.4 },
  { year: 2021, value: 1.3 },
  { year: 2022, value: 1.1 },
  { year: 2023, value: 1.0 },
];

function linePathStrokes(svg) {
  return [...svg.matchAll(/<polyline data-role="line-path"[^>]*stroke="([^"]+)"/g)].map((m) => m[1]);
}
function linePointFills(svg) {
  return [...svg.matchAll(/<circle data-role="line-point"[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
}

// 1. House style, no highlight_values at all: ink, not grey.
{
  const spec = { ...baseSpec };
  const desktop = renderVizSvg(spec, rows);
  const mobile = renderVizMobileSvg(spec, rows);
  for (const [label, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    const strokes = linePathStrokes(svg);
    assert.equal(strokes.length, 1, `${label}: expected exactly one line-path`);
    assert.equal(strokes[0], INK, `${label}: no-highlight single line must be ink, got ${strokes[0]}`);
    assert.notEqual(strokes[0], ACCENT2_HOUSE, `${label}: must not be the old hardcoded accent2 grey`);
    const fills = linePointFills(svg);
    assert.ok(fills.every((f) => f === INK), `${label}: line-point markers must match the ink stroke`);
  }
  console.log("single-series line, no highlight: ink (house style): PASS");
}

// 2. House style, highlight_values names the endpoint's own x-value: accent.
{
  const spec = { ...baseSpec, highlight_values: [2023] };
  const desktop = renderVizSvg(spec, rows);
  const mobile = renderVizMobileSvg(spec, rows);
  for (const [label, svg] of [["desktop", desktop], ["mobile", mobile]]) {
    const strokes = linePathStrokes(svg);
    assert.equal(strokes[0], ACCENT, `${label}: endpoint-highlighted single line must be accent, got ${strokes[0]}`);
  }
  console.log("single-series line, highlight_values names the endpoint: accent: PASS");
}

// 3. House style, highlight_values present but matching nothing in this
//    series (e.g. a stray/irrelevant value): still ink, not accidentally
//    always-on.
{
  const spec = { ...baseSpec, highlight_values: [1999] };
  const svg = renderVizSvg(spec, rows);
  const strokes = linePathStrokes(svg);
  assert.equal(strokes[0], INK, `non-matching highlight_values must not turn the line accent, got ${strokes[0]}`);
  console.log("single-series line, highlight_values matches nothing: still ink: PASS");
}

// 4. Multi-series behaviour is untouched: highlighted series accent,
//    non-highlighted context grey (#9E9E9E) - guards the shared branch.
{
  const spec = {
    ...baseSpec,
    chart_type: "multi_line",
    visual_family: "statistical",
    series_field: "entity",
    highlight_values: ["China"],
  };
  const multiRows = [
    { year: 2019, value: 1.5, entity: "China" },
    { year: 2023, value: 1.0, entity: "China" },
    { year: 2019, value: 2.3, entity: "World" },
    { year: 2023, value: 2.25, entity: "World" },
  ];
  const svg = renderVizSvg(spec, multiRows);
  const strokes = linePathStrokes(svg);
  assert.equal(strokes.length, 2, "expected two line-paths for a two-series multi_line chart");
  assert.ok(strokes.includes(ACCENT), "highlighted series must still be accent");
  assert.ok(strokes.includes("#9E9E9E"), "non-highlighted series must still be context grey, unaffected by fix 6");
  console.log("multi-series line: highlighted/context colors unaffected by fix 6: PASS");
}

// 5. Legacy style: byte-identical old behaviour - always accent2 (the
//    legacy palette's own accent2, a teal, not the house grey), regardless
//    of highlight_values.
{
  const legacySpec = { ...baseSpec, style_id: "legacy" };
  const withHighlight = { ...legacySpec, highlight_values: [2023] };
  for (const spec of [legacySpec, withHighlight]) {
    const svg = renderVizSvg(spec, rows);
    const strokes = linePathStrokes(svg);
    assert.equal(strokes[0], ACCENT2_LEGACY, `legacy single line must stay accent2 (${ACCENT2_LEGACY}) verbatim, got ${strokes[0]}`);
  }
  console.log("legacy style: single-line stroke unchanged (accent2), fix 6 is a house-style-only no-op: PASS");
}

console.log("single-series line color regression: PASS");
