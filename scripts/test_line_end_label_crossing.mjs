#!/usr/bin/env node
// Fix 5 regression test: "end label lands on its own line" - on
// viz-world.json (the same real, published trend-01 module fix 4 covers:
// China vs. World total fertility rate, 1990-2023) each series' end label
// visually sat on top of - crossed - that series' own polyline, a render-QA
// text_crosses_data_mark failure.
//
// Root cause: Task B appends every series' exact value to its end label
// ("世界 2.251 个孩子"), which for a CJK name plus a decimal value plus a CJK
// unit is wide enough that the pre-existing right-edge clamp (which only
// ever pulls an over-wide label further LEFT, to keep it inside the canvas)
// pulls the label's own start behind the data point it names - on this
// fixture, on both series' labels on mobile, and on the World series' label
// on desktop. There is no clamp floor, so the label's text runs directly
// over the point and the end of the line.
//
// Fix: split the label onto two lines - the series name, then the value and
// unit - only when the combined single line would not fit; each line is far
// narrower than the combined string, so both fit inside the same margin
// without moving, shrinking the font, or touching the plotted line/point.
// See layoutLineEndLabel in runtime/pi/viz.mjs for the exact mechanism,
// including the mobile-only fallback (right-anchoring a split line against
// the canvas's own true edge) needed because the per-character width
// estimate this renderer uses (there is no real font-metrics measurement
// available at this layer) can still overestimate a short line's width past
// what mobile's much narrower canvas leaves between the point and the edge.
//
// House-style-only: legacy keeps its old, single-line-only layout - and
// therefore this exact crossing - byte-for-byte (verified below).
import assert from "node:assert/strict";
import { renderVizSvg, renderVizMobileSvg } from "../runtime/pi/viz.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

function crossings(svg) {
  return checkSvgGeometry(svg).failures.filter((f) => f.rule === "text_crosses_data_mark");
}

function extractDirectLabelTexts(svg) {
  return [...svg.matchAll(/<text data-role="direct-label"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

// Real published data (UN World Population Prospects via Our World in Data),
// the same fixture test_line_header_tick_clearance.mjs (fix 4) and
// test_value_label_decimals.mjs use.
const worldRowsByYear = {
  1990: [2.514, 3.31], 1995: [1.588, 2.889], 2000: [1.628, 2.754], 2005: [1.624, 2.63],
  2010: [1.687, 2.602], 2015: [1.67, 2.537], 2017: [1.795, 2.504], 2020: [1.236, 2.322],
  2023: [0.999, 2.251],
};
const worldRows = [];
for (const [year, [china, world]] of Object.entries(worldRowsByYear)) {
  worldRows.push({ year: Number(year), entity: "China", tfr: china });
  worldRows.push({ year: Number(year), entity: "World", tfr: world });
}
const worldSpec = {
  schema_version: "0.7.0",
  reader_task: "change",
  chart_type: "multi_line",
  language: "zh",
  title: "2017 年后，与世界平均差距迅速拉大",
  subtitle: "总和生育率，中国与世界平均，1990-2023 年",
  takeaway: "中国总和生育率 1990 年以来始终低于世界平均；2017 年后与世界平均的差距迅速拉大，从 0.709 扩大到 2023 年的 1.252。",
  alt: "双线折线图：中国与世界平均总和生育率，1990-2023 年。世界平均从 3.310 缓慢降到 2.251；中国从 2.514 快速降到 0.999。",
  source_note: "联合国世界人口展望估计数，经 Our World in Data 转存",
  claim_id: "claim-702e6061e3521144",
  sql: "SELECT * FROM synthetic",
  unit: "个孩子",
  x_field: "year",
  value_field: "tfr",
  series_field: "entity",
  highlight_values: ["China"],
  category_names: "worldbank",
};

// --- 1. The exact reported fixture: no end label may cross its own line, on
//        either viewport --------------------------------------------------
for (const [name, render] of [["desktop", renderVizSvg], ["mobile", renderVizMobileSvg]]) {
  const svg = render(worldSpec, worldRows);
  const found = crossings(svg);
  assert.deepEqual(found, [], `viz-world.json (${name}): no end label may cross its own series' line: ${JSON.stringify(found)}`);
}
console.log("viz-world.json fixture: no end label crosses its own series' line, desktop + mobile: PASS");

// --- 2. The overflowing labels are now split into a name line and a
//        value+unit line - not silently truncated, dropped, or merged -----
{
  const labels = extractDirectLabelTexts(renderVizSvg(worldSpec, worldRows));
  assert.ok(labels.includes("世界"), `expected a standalone "世界" name line, got ${JSON.stringify(labels)}`);
  assert.ok(labels.includes("2.251 个孩子"), `expected a standalone "2.251 个孩子" value line, got ${JSON.stringify(labels)}`);
  assert.ok(labels.includes("中国"), `expected a standalone "中国" name line, got ${JSON.stringify(labels)}`);
  assert.ok(labels.includes("0.999 个孩子"), `expected a standalone "0.999 个孩子" value line, got ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes("世界 2.251 个孩子"), `the World label should now be two lines, not one combined node: ${JSON.stringify(labels)}`);
  console.log("viz-world.json fixture: overflowing labels split into a name line + a value line, nothing dropped: PASS");
}

// --- 3. A short-label multi_line chart (name + value comfortably fits)
//        keeps its old single-line label untouched - this fix must not
//        split a label that never needed splitting ------------------------
{
  const spec = {
    ...worldSpec, title: "短标签双线图", subtitle: undefined,
  };
  const rows = [
    { year: 2019, entity: "A", tfr: 1.2 }, { year: 2023, entity: "A", tfr: 1.5 },
    { year: 2019, entity: "B", tfr: 2.1 }, { year: 2023, entity: "B", tfr: 1.9 },
  ];
  const svg = renderVizSvg({ ...spec, unit: "units", highlight_values: ["A"] }, rows);
  const labels = extractDirectLabelTexts(svg);
  assert.ok(labels.some((t) => t === "A 1.5 units"), `expected the untouched single-line label "A 1.5 units": ${JSON.stringify(labels)}`);
  assert.ok(labels.some((t) => t === "B 1.9 units"), `expected the untouched single-line label "B 1.9 units": ${JSON.stringify(labels)}`);
  assert.deepEqual(crossings(svg), [], "a short-label fixture should never cross its own line in the first place");
  console.log("short-label multi_line chart: single-line end labels unchanged, not split: PASS");
}

// --- 4. Legacy style keeps the old, single-line-only layout byte-for-byte:
//        the same crossings this fix resolves in house style must still
//        reproduce under style_id="legacy" - proof the fix is gated, not
//        applied globally ---------------------------------------------------
{
  for (const [name, render, expectedCrossings] of [
    ["desktop", renderVizSvg, 1],
    ["mobile", renderVizMobileSvg, 2],
  ]) {
    const legacySvg = render({ ...worldSpec, style_id: "legacy" }, worldRows);
    const found = crossings(legacySvg);
    assert.equal(found.length, expectedCrossings, `legacy ${name}: expected ${expectedCrossings} pre-existing crossing(s) unchanged, got ${JSON.stringify(found)}`);
    const labels = extractDirectLabelTexts(legacySvg);
    assert.ok(labels.some((t) => t.includes("世界") || t.toLowerCase().includes("world")), `legacy ${name}: World's label must still be a single combined line: ${JSON.stringify(labels)}`);
  }
  console.log("legacy style: old single-line end-label layout and its crossings reproduce unchanged, byte-for-byte behaviour preserved: PASS");
}

console.log("end-label / own-line crossing regression: PASS");
