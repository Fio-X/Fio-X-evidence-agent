#!/usr/bin/env node
// Chinese chart labels count in 万 and 亿 (and 万亿), not k/m/bn; English output stays as it was.
// zh: |v|>=1e12 x万亿, >=1e8 x亿, >=1e4 x万 (one decimal below 10 of the unit, else none),
// 1,000-9,999 a plain integer, below 1,000 unchanged. fmt() itself stays language-neutral unless
// a caller passes lang, so render_qa_labels (which calls fmt) and choroplethValueText are untouched.
// Synthetic data only.
import assert from "node:assert/strict";
import { fmt, fmtSpec, tickLabel, tickLabelSpec, renderVizBundle } from "../runtime/pi/viz.mjs";

const zh = { language: "zh" };
const en = { language: "en" };
const cases = [
  [999, "999"], [999.5, "1000"], [1000, "1000"], [8500, "8500"], [9999, "9999"],
  [10000, "1.0万"], [12000, "1.2万"], [99999, "10.0万"], [100000, "10万"], [350000, "35万"], [9_999_999, "1000万"],
  [1e8, "1.0亿"], [1.2e8, "1.2亿"], [3.5e9, "35亿"], [1e12, "1.0万亿"], [1.2e13, "12万亿"], [1.2e12, "1.2万亿"],
  [-12000, "-1.2万"], [-1e8, "-1.0亿"], [-8500, "-8500"],
];
for (const [v, want] of cases) assert.equal(fmtSpec(zh, v, ""), want, `zh ${v}`);
assert.equal(fmtSpec(zh, 12000, "%"), "1.2万%");
assert.equal(fmtSpec(zh, 50.5, "%"), fmtSpec(en, 50.5, "%"), "% below 1000 unchanged");
assert.equal(fmtSpec(zh, 12000, "$"), "$1.2万");
// value labels keep the one decimal like 2.0k does; ticks drop a trailing .0
assert.equal(tickLabel(20000, "", "zh"), "2万");
assert.equal(tickLabel(1e8, "", "zh"), "1亿");
assert.equal(tickLabel(25000, "", "zh"), "2.5万");
assert.equal(tickLabelSpec(zh, 3e12, ""), "3万亿");
// English is byte-identical to the language-less call
for (const v of [0.5, 12, 150, 999, 1000, 1500, 8500, 9999, 10000, 12000, 99999, 1e6, 3.5e6, 1e9, 2.1e9, 1e12, -12000, -1e9]) {
  for (const unit of ["", "%", "$", "t"]) {
    assert.equal(fmtSpec(en, v, unit), fmt(v, unit), `en ${v} ${unit}`);
    assert.equal(fmtSpec(undefined, v, unit), fmt(v, unit), `no spec ${v} ${unit}`);
    assert.equal(tickLabelSpec(en, v, unit), tickLabel(v, unit), `en tick ${v} ${unit}`);
  }
}
assert.equal(fmt(12000), "12k");
assert.equal(fmt(1.2e8), "120m");
assert.equal(fmt(3.5e9), "3.5bn");
assert.equal(tickLabel(2000), "2k");
// shared-decimals branch: English is unchanged; zh labels from 1万 up use the
// axis's 万/亿 scaling (round-3 rule), never comma-grouped digits
assert.equal(fmtSpec(en, 67500, "", 1), "67,500.0");
assert.equal(fmtSpec(zh, 67500, "", 1), "6.75万");

// charts
const base = {
  schema_version: "0.7.0", takeaway: "t", title: "Scale", subtitle: "synthetic", alt: "A synthetic chart used to check number scale words in axis and value labels.",
  source_note: "synthetic fixture", claim_id: "claim-zh-scale", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, unit: "元",
};
const bars = ["甲", "乙", "丙", "丁"].map((category, i) => ({ category, value: [3.5e9, 1.2e9, 8.4e8, 1.1e8][i] }));
const barSpec = (language) => ({ ...base, language, reader_task: "ranking", chart_type: "horizontal_bar", category_field: "category", value_field: "value", sort: "desc" });
const barZh = renderVizBundle(barSpec("zh"), bars, { mobilePages: false }).desktop;
// axis ticks take 亿; the value labels carry a shared integer decimals count, and since
// round 3 a zh label from 1万 up takes the same scaling instead of comma-grouped digits
assert.match(barZh, />10亿</, "zh bar tick");
assert.match(barZh, />30亿 元</, "zh bar tick with unit");
// one unit and one shared decimal count: the smallest value (1.1亿) needs one decimal, so all do
assert.match(barZh, />35.0亿 元</, "zh bar value label uses 亿 like the axis");
assert.match(barZh, />12.0亿</, "zh bar shares the decimal count");
assert.match(barZh, />1.1亿</, "zh bar smallest value");
assert.doesNotMatch(barZh, />3,500,000,000/, "no comma-grouped billions in the zh bar");
assert.doesNotMatch(barZh, />\d+(\.\d+)?(k|m|bn)\b/, "no k/m/bn text in the zh bar");
const barEn = renderVizBundle(barSpec("en"), bars, { mobilePages: false }).desktop;
assert.match(barEn, />1bn</, "en bar ticks still use bn");
assert.doesNotMatch(barEn, /亿|万/, "en bar has no 万/亿");

const points = [[2500, 68], [52000, 72], [160000, 78], [420000, 81], [1150000, 84]].map(([gdp, life], i) => ({ country: "ABCDE"[i], gdp, life }));
const scatterSpec = (language) => ({ ...base, language, reader_task: "correlation", visual_family: "statistical", data_topology: "tabular", chart_type: "scatter", x_field: "gdp", y_field: "life", label_field: "country", x_scale: "log", x_label: "GDP", y_label: "Life", x_unit: "", y_unit: "", unit: "岁" });
const scatterZh = renderVizBundle(scatterSpec("zh"), points, { mobilePages: false }).desktop;
assert.match(scatterZh, />\d+(\.\d+)?万</, "zh log-x scatter ticks use 万");
assert.doesNotMatch(scatterZh, />\d+(\.\d+)?(k|m|bn)</, "no k/m/bn tick in the zh scatter");
const scatterEn = renderVizBundle(scatterSpec("en"), points, { mobilePages: false }).desktop;
assert.match(scatterEn, />\d+(\.\d+)?(k|m)</, "en scatter ticks keep k/m");
assert.doesNotMatch(scatterEn, /万|亿/);
console.log("ok test_zh_number_scale");
