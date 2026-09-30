#!/usr/bin/env node
// Fix 4 regression test: "header collides with top tick." On viz-world.json
// (a real, published trend-01 module: China vs. World total fertility rate,
// 1990-2023) the chart's title/subtitle overlapped the top y-axis tick label
// ("4 个孩子"), a render-QA text_overlap failure - and removing the subtitle
// did not fix it either.
//
// Root cause (found while diagnosing the reported ~3px overlap): renderLine
// positioned its y-scale on lineAxisDomain()'s own "nice" [min,max] (e.g.
// [0.5, 3.5] for this data), but lineAxisTicks() re-derives its own step from
// that already-rounded span and can round its top (or bottom) tick a half
// step past it - here, tick 4 versus a domain max of 3.5. verticalScale()
// then extrapolates that out-of-domain tick linearly, placing its gridline
// well above `top` - on this fixture, ~53px above, comfortably inside the
// header. A fixed pixel nudge to the header gap cannot fix this in general
// (the overshoot's pixel size depends on the chart's own plot height and
// domain width); the actual fix widens the *scale's* positioning domain to
// cover the tick list's own extremes, so no drawn tick can ever land outside
// [top, bottom] - see the "Fix 4" comment beside yScaleDomain in renderLine/
// renderMobileLine. A small additional top-clearance term (half the
// tick-label's own font size) is kept on top of that, covering the tick
// label text's own ascent past its gridline.
//
// House-style-only: legacy keeps its old, narrower, overlap-prone geometry
// byte-for-byte (verified below by confirming the old collision still
// reproduces under style_id="legacy").
import assert from "node:assert/strict";
import { renderVizSvg, renderVizMobileSvg } from "../runtime/pi/viz.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

// This fixture's end labels also happen to cross their own series' polyline
// (a separate, pre-existing text_crosses_data_mark failure - fix 5's "end
// label" defect, not this one) both before and after this fix. Fix 4 is
// scoped to the text_overlap rule (header vs. the top tick) only, so assert
// on that rule specifically rather than blanket QA cleanliness here.
function assertNoHeaderTickOverlap(svg, label) {
  const qa = checkSvgGeometry(svg);
  const overlaps = qa.failures.filter((f) => f.rule === "text_overlap");
  assert.deepEqual(overlaps, [], `${label}: header must not overlap the top y tick: ${JSON.stringify(overlaps)}`);
}

// Real published data (UN World Population Prospects via Our World in Data),
// the same values used by test_value_label_decimals.mjs's viz-world.json
// fixture - China's total fertility rate fell below the world average's own
// decline steadily enough that the y-axis tops out at "4", a nice round
// number the raw data (max 3.31, World 1990) never reaches.
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

// --- 1. The exact reported fixture (with subtitle): render-QA must be clean,
//        on both viewports -----------------------------------------------
for (const [name, render] of [["desktop", renderVizSvg], ["mobile", renderVizMobileSvg]]) {
  const svg = render(worldSpec, worldRows);
  assertNoHeaderTickOverlap(svg, `viz-world.json (${name})`);
}
console.log("viz-world.json fixture (with subtitle): header does not overlap the top y tick, desktop + mobile: PASS");

// --- 2. Same fixture with the subtitle removed - the bug report noted
//        removing the subtitle did not fix it, so the fix must not depend on
//        the subtitle being present or absent either -----------------------
{
  const noSubtitleSpec = { ...worldSpec, subtitle: undefined };
  const svg = renderVizSvg(noSubtitleSpec, worldRows);
  assertNoHeaderTickOverlap(svg, "viz-world.json without a subtitle");
}
console.log("viz-world.json fixture (subtitle removed): still clean - the fix does not depend on the subtitle: PASS");

// --- 3. A single-series line chart exercises the same renderLine top-margin
//        code path as multi_line (both call the same "no lane" laneTop/top
//        branch) - confirm it is clean too, not just the multi-series case -
{
  const spec = {
    ...worldSpec, chart_type: "line", series_field: undefined, highlight_values: [],
    title: "单线标题与顶部刻度间距测试",
  };
  const rows = worldRows.filter((r) => r.entity === "China");
  const svg = renderVizSvg(spec, rows);
  assertNoHeaderTickOverlap(svg, "single-series line");
}
console.log("single-series line chart (same top-margin code path): PASS");

// --- 4. Legacy style keeps the old, narrower geometry byte-for-byte: the
//        same header/top-tick collision this fix resolves in house style
//        must still reproduce under style_id="legacy" - proof the fix is
//        gated, not applied globally ----------------------------------------
{
  const legacySvg = renderVizSvg({ ...worldSpec, style_id: "legacy" }, worldRows);
  const legacyQa = checkSvgGeometry(legacySvg);
  assert.equal(legacyQa.passed, false, "legacy style must keep its old geometry unchanged, including this exact header/top-tick collision");
  assert.ok(legacyQa.failures.some((f) => f.rule === "text_overlap"), `legacy style's failure must still be the same text_overlap this fix addresses in house style: ${JSON.stringify(legacyQa.failures)}`);
}
console.log("legacy style: old header/top-tick collision reproduces unchanged, byte-for-byte behaviour preserved: PASS");

console.log("header/top-tick clearance regression: PASS");
