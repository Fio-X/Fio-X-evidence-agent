import assert from "node:assert/strict";
import { critiqueViz, lintVizSpec, renderVizBundle } from "../runtime/pi/viz.mjs";

const spec = {
  chart_type: "dot",
  title: "月度出口对比",
  subtitle: "同一月份显示两个年份，避免把重复月份读成一条序列",
  alt: "按月份比较 2025 年和 2026 年出口量的分组点图，两个年份使用不同颜色。",
  source_note: "官方固定测试数据",
  unit: "MMcf",
  claim_id: "claim-grouped-dots",
  sql: "SELECT month, year, value FROM fixture ORDER BY month, year",
  reader_task: "comparison",
  category_field: "month",
  value_field: "value",
  series_field: "year",
  direct_labels: true,
  annotations: [{
    type: "point",
    match_field: "month",
    match_value: "Jan",
    text: "+30%",
    claim_id: "claim-grouped-dots",
  }],
};
const rows = [
  { month: "Jan", year: "2025", value: 100 },
  { month: "Jan", year: "2026", value: 130 },
  { month: "Feb", year: "2025", value: 110 },
  { month: "Feb", year: "2026", value: 140 },
];

const lint = lintVizSpec(spec, rows, { verified_claim_ids: [spec.claim_id] });
assert.equal(lint.passed, true, lint.blockers.join("; "));
const bundle = renderVizBundle(spec, rows);
for (const viewport of ["desktop", "mobile"]) {
  const svg = bundle[viewport];
  assert.match(svg, /role="img"/);
  assert.match(svg, /data-role="dot-value-label"/);
  assert.equal((svg.match(/>Jan<\/text>/g) ?? []).length, 1, `${viewport} should render one Jan category label`);
  assert.equal((svg.match(/>Feb<\/text>/g) ?? []).length, 1, `${viewport} should render one Feb category label`);
  assert.match(svg, />2025<\/text>/);
  assert.match(svg, />2026<\/text>/);
  assert.equal((svg.match(/data-role="dot-value-label"/g) ?? []).length, 4);
  assert.match(svg, /data-role="dot-value-label"[^>]*text-anchor="end"[^>]*>140<\/text>/, `${viewport} should keep the edge label inside the frame`);
  assert.equal((svg.match(/data-role="annotation"/g) ?? []).length, 1, `${viewport} should render a matched annotation once per category`);
}
// House style is now the default (see styleFor/applyStyle in viz.mjs). This
// spec has no highlight_values, so both series draw from seriesColorsFor's
// grey ramp (PALETTE.series3/series4 = "#BDBDBD"/"#9E9E9E") rather than the
// legacy accent2/accent duo ("#2f6f8f"/"#d1493f") - house style reserves the
// one accent red for an explicitly highlighted series/category, never a
// plain multi-series split. Colour-only change.
assert.match(bundle.desktop, /fill="#BDBDBD"/);
assert.match(bundle.desktop, /fill="#9E9E9E"/);
const critic = critiqueViz(spec, rows, lint, bundle.desktop);
assert.equal(critic.passed, true, JSON.stringify(critic));
console.log("grouped dot renderer: PASS (desktop/mobile series and category labels are disambiguated)");

// B1: the legend prefix was previously hardcoded in Chinese regardless of
// chart language. This spec has a Chinese title but no language field, so
// language defaults to "en" and the legend must say "Group: ", not "分组：".
assert.match(bundle.desktop, />Group: </);
assert.match(bundle.mobile, />Group: </);
assert.doesNotMatch(bundle.desktop, /分组：/);
assert.doesNotMatch(bundle.mobile, /分组：/);
console.log("grouped dot legend prefix defaults to English when language is unset: PASS");

// B1: language: "zh" localizes the legend prefix on renderGroupedDots
// (desktop) and renderGroupedDotsMobile (mobile), independent of any
// reference_line annotation.
const zhSpec = {
  ...spec,
  language: "zh",
};
const zhLint = lintVizSpec(zhSpec, rows, { verified_claim_ids: [zhSpec.claim_id] });
assert.equal(zhLint.passed, true, zhLint.blockers.join("; "));
const zhBundle = renderVizBundle(zhSpec, rows);
for (const viewport of ["desktop", "mobile"]) {
  assert.match(zhBundle[viewport], />分组：</, `${viewport} should localize the legend prefix`);
}
const zhCritic = critiqueViz(zhSpec, rows, zhLint, zhBundle.desktop);
assert.equal(zhCritic.passed, true, JSON.stringify(zhCritic));
console.log("grouped dot zh legend prefix (desktop/mobile): PASS");

// B2: a reference_line annotation renders on both renderGroupedDots
// (desktop) and renderGroupedDotsMobile (mobile), independent of chart
// language.
const refLineSpec = {
  ...spec,
  annotations: [
    ...spec.annotations,
    { type: "reference_line", text: "Target: 120", value: 120, claim_id: "claim-grouped-dots" },
  ],
};
const refLineLint = lintVizSpec(refLineSpec, rows, { verified_claim_ids: [refLineSpec.claim_id] });
assert.equal(refLineLint.passed, true, refLineLint.blockers.join("; "));
const refLineBundle = renderVizBundle(refLineSpec, rows);
for (const viewport of ["desktop", "mobile"]) {
  const svg = refLineBundle[viewport];
  assert.match(svg, /data-role="reference-line"/, `${viewport} should render the reference line`);
  assert.match(svg, /data-role="reference-line-label"[^>]*>Target: 120</, `${viewport} should render the reference line label`);
}
const refLineCritic = critiqueViz(refLineSpec, rows, refLineLint, refLineBundle.desktop);
assert.equal(refLineCritic.passed, true, JSON.stringify(refLineCritic));
console.log("grouped dot reference_line (desktop/mobile): PASS");
