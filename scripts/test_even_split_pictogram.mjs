#!/usr/bin/env node
// NEWSROOM_EVEN_SPLIT_PICTOGRAM: the one-day clock (one group of identical people spread evenly) is refused unless it compares against a named
// external quantity (compare_label + compare_field). An equal people_dots split or clocks with equal minutes are allowed. Run: node scripts/test_even_split_pictogram.mjs
import assert from "node:assert/strict";
process.env.NEWSROOM_STORY_FORMS = "1";
const R = new URL("../runtime/pi/", import.meta.url).pathname;
const { renderVizBundle } = await import(R + "viz.mjs");
const { runRenderQa } = await import(R + "render_qa.mjs");
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const common = { schema_version: "0.9.0", takeaway: "Fixture.", claim_id: "c1", language: "zh", sql: "SELECT 1", annotations: [], highlight_values: [], source_note: "示例假数据" };
const dotsSpec = (over = {}) => ({ ...common, reader_task: "part_to_whole", chart_type: "people_dots", title: "人点阵示例（假数据）", subtitle: "每个点代表一批人", alt: "总人数中有一部分涉及某事的点阵图，每个点代表一批人。", unit: "人", value_field: "total", part_field: "involved", per_dot_field: "per_dot", part_label: "涉及某事", rest_label: "其余", ...over });
const clockSpec = (over = {}) => ({ ...common, reader_task: "comparison", chart_type: "clock_dial", title: "钟面示例（假数据）", subtitle: "每个点是一个人，一圈 60 分钟", alt: "多个钟面，点数是每小时经过的人数，扇形是第一个人经过的时间。", unit: "分钟", category_field: "name", minutes_field: "minutes", ...over });
const daySpec = (over = {}) => { const s = clockSpec({ clock_span: "day", per_day_field: "per_day", ...over }); delete s.minutes_field; return s; };
const cases = {
  dotsEven: [dotsSpec(), [{ total: 10000, involved: 5000, per_dot: 500 }]],
  dotsEven2: [dotsSpec(), [{ total: 60000, involved: 30000, per_dot: 1000 }]],
  clocksEven: [clockSpec(), [{ name: "甲类", minutes: 10 }, { name: "乙类", minutes: 10 }, { name: "丙类", minutes: 10 }]],
  dayClock: [daySpec(), [{ name: "全部（假数据）", per_day: 193.55 }]],
  dotsUnequal: [dotsSpec(), [{ total: 100350, involved: 68420, per_dot: 1000 }]],
  clocksUnequal: [clockSpec(), [{ name: "甲类", minutes: 7.5 }, { name: "乙类", minutes: 12 }]],
  dotsCompared: [dotsSpec({ compare_label: "全国平均涨幅", compare_field: "national" }), [{ total: 10000, involved: 5000, per_dot: 500, national: 38 }]],
  dayCompared: [daySpec({ compare_label: "全国日均", compare_field: "national_day" }), [{ name: "全部（假数据）", per_day: 193.55, national_day: 520 }]],
};
const qa = (key) => {
  const [spec, rows] = cases[key];
  const svg = renderVizBundle(spec, rows).desktop;
  const res = runRenderQa({ desktop: svg }, { story_form: { spec, rows } }).viewports.desktop.extra_checks.story_form;
  return { passed: res.passed, even: res.failures.some((f) => f.rule === "even_split_pictogram"), other: res.failures.filter((f) => f.rule !== "even_split_pictogram") };
};
const run = (on) => { if (on) process.env.NEWSROOM_EVEN_SPLIT_PICTOGRAM = "1"; else delete process.env.NEWSROOM_EVEN_SPLIT_PICTOGRAM; return Object.fromEntries(Object.keys(cases).map((k) => [k, qa(k)])); };

const off = run(false);
for (const [k, r] of Object.entries(off)) ok(r.passed && !r.even && r.other.length === 0, `off: ${k} passes as before ${JSON.stringify(r)}`);
for (const v of ["true", "yes", "0", ""]) { process.env.NEWSROOM_EVEN_SPLIT_PICTOGRAM = v; ok(qa("dotsEven").passed, `value "${v}" is off`); }
const on = run(true);
ok(on.dayClock.even && !on.dayClock.passed, "on: dayClock is refused");
for (const k of ["dotsEven", "dotsEven2", "clocksEven", "dotsUnequal", "clocksUnequal", "dotsCompared", "dayCompared"]) ok(on[k].passed && !on[k].even, `on: ${k} is accepted`);
// a comparison that is only half there, or points at the chart's own column, does not count
{
  const [spec, rows] = cases.dayClock;
  const bad = (over, r = rows) => { process.env.NEWSROOM_EVEN_SPLIT_PICTOGRAM = "1"; return !runRenderQa({ desktop: renderVizBundle(spec, rows).desktop }, { story_form: { spec: { ...spec, ...over }, rows: r } }).viewports.desktop.extra_checks.story_form.passed; };
  ok(bad({ compare_label: "平均" }), "label without a column is refused");
  ok(bad({ compare_field: "national" }, [{ ...rows[0], national: 3 }]), "column without a name is refused");
  ok(bad({ compare_label: "平均", compare_field: "per_day" }), "the chart's own column is not an external quantity");
  ok(bad({ compare_label: "平均", compare_field: "national" }, [{ ...rows[0], national: "n/a" }]), "a non-numeric column is refused");
}
console.log(`even split pictogram PASS checks=${checks}`);
