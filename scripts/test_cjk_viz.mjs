import assert from "node:assert/strict";
import { renderVizBundle, wrapText } from "../runtime/pi/viz.mjs";

const title = "欧洲可再生能源发电量在过去五年出现显著增长但不同国家之间的转型速度差异仍然很大";
const lines = wrapText(title, 18);
assert.ok(lines.length >= 3, lines);
assert.equal(lines.join(""), title);

const spec = {
  reader_task: "ranking",
  takeaway: "测试中文移动端标题自动换行",
  chart_type: "horizontal_bar",
  title,
  subtitle: "同一观察年份的国家比较，避免混合年份产生误导。",
  alt: "横向条形图展示三个国家的可再生能源占比。",
  source_note: "离线测试数据",
  note: "仅用于排版回归测试。",
  claim_id: "claim-cjk",
  sql: "SELECT 1",
  unit: "%",
  category_field: "country",
  value_field: "value",
  mixed_period_strategy: "reject",
  sort: "desc",
  highlight_values: ["甲国"],
  direct_labels: true,
  annotations: [],
};
const rows = [
  { country: "甲国", value: 82.1 },
  { country: "乙国", value: 65.4 },
  { country: "丙国", value: 41.3 },
];
const bundle = renderVizBundle(spec, rows);
assert.match(bundle.mobile, /data-viewport="mobile"/);
assert.match(bundle.desktop, /data-viewport="desktop"/);
const mobileTitleLines = (bundle.mobile.match(/font-size="25"/g) || []).length;
assert.ok(mobileTitleLines >= 2, `expected wrapped mobile title, got ${mobileTitleLines} line(s)`);
assert.ok(bundle.mobile.includes("欧洲可再生能源发电量"));
assert.ok(bundle.mobile.includes("转型速度差异仍然很大"));
console.log(`CJK wrapping: PASS (${lines.length} logical lines; ${mobileTitleLines} mobile title nodes)`);
