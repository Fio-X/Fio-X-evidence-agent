#!/usr/bin/env node
// K281 item 3 pin (no product change): the one-day clock of the run11 page is not an empty ring. The plan's dot count equals the
// clock-dot marks drawn, and a clock that would draw no dot is already refused by the data rules (so lint cannot pass an empty clock).
import assert from "node:assert/strict";
process.env.NEWSROOM_STORY_FORMS = "1";
const { renderVizSvg } = await import("../runtime/pi/viz.mjs");
const { clockBlockers, clockPlan } = await import("../runtime/pi/story_forms.mjs");

const spec = {
  schema_version: "0.9.0", verification_mode: "draft", reader_task: "sequence", title: "美国的一天", chart_type: "clock_dial", clock_span: "day",
  language: "zh", category_field: "label", per_day_field: "per_day", value_field: "per_day", unit: "人", source_note: "合成数据",
  note: "按全年平均摊开，不是真实的时刻分布。", alt: "一天的钟面。", takeaway: "平均每天的人数。", sql: "SELECT 1",
};
const rows = [{ label: "2025 年", per_day: 193.55 }];
assert.deepEqual(clockBlockers(spec, rows), []);
const plan = clockPlan(spec, rows);
assert.equal(plan[0].count, 194);
const svg = renderVizSvg(spec, rows);
assert.equal((svg.match(/data-role="clock-dot"/g) ?? []).length, 194, "every planned dot is drawn");
for (const perDay of [0, 0.2, 0.49]) assert.ok(clockBlockers(spec, [{ label: "x", per_day: perDay }]).length > 0, `${perDay} a day would draw no dot and is refused`);
console.log("test_clock_dots_k281: ok");
