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
assert.match(bundle.desktop, /fill="#2f6f8f"/);
assert.match(bundle.desktop, /fill="#d1493f"/);
const critic = critiqueViz(spec, rows, lint, bundle.desktop);
assert.equal(critic.passed, true, JSON.stringify(critic));
console.log("grouped dot renderer: PASS (desktop/mobile series and category labels are disambiguated)");
