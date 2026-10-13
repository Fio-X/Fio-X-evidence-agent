#!/usr/bin/env node
// K245: NEWSROOM_CHART_TEXT_WORDS=1 (exact "1", default off) refuses number words in the title, subtitle, alt and source line of the
// older chart types. Off: nothing changes. Run as: node scripts/test_chart_text_words.mjs [on|off] (no argument runs both halves).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const here = fileURLToPath(import.meta.url);
if (mode !== "on" && mode !== "off") {
  for (const half of ["off", "on"]) {
    const env = { ...process.env }; delete env.NEWSROOM_CHART_TEXT_WORDS;
    if (half === "on") env.NEWSROOM_CHART_TEXT_WORDS = "1";
    const r = spawnSync(process.execPath, [here, half], { env, stdio: "inherit" });
    assert.strictEqual(r.status, 0, `${half} half failed`);
  }
  process.exit(0);
}
const R = fileURLToPath(new URL("../runtime/pi/", import.meta.url));
const { lintVizSpec } = await import(R + "viz.mjs");
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
const bar = (over = {}) => ({ schema_version: "0.9.0", reader_task: "ranking", takeaway: "x", claim_id: "c1", language: "zh", chart_type: "horizontal_bar", title: "各国占比排名", subtitle: "单位：百分比", alt: "横向条形图按占比从高到低排列各个国家。", source_note: "示例数据", unit: "%", category_field: "country", value_field: "share", sql: "SELECT 1", annotations: [], highlight_values: [], ...over });
const rows = [{ country: "甲", share: 40 }, { country: "乙", share: 30 }, { country: "丙", share: 20 }];
const blockers = (spec) => lintVizSpec(spec, rows, { verified_claim_ids: ["c1"] }).blockers;
const worded = (spec) => blockers(spec).some((b) => /has a number word/.test(b));
ok(!worded(bar()), "a clean bar spec has no number-word blocker");
for (const [field, text] of [["title", "三国占比排名"], ["subtitle", "前两名"], ["alt", "横向条形图展示一万个点。"], ["source_note", "来源：两个机构的表"]]) {
  const spec = bar({ [field]: text });
  if (mode === "on") ok(worded(spec), `on: a number word in ${field} is blocked`);
  else ok(!worded(spec), `off: a number word in ${field} is not looked at`);
}
if (mode === "on") ok(blockers(bar({ title: "三国占比排名" })).filter((b) => /has a number word/.test(b)).length === 1, "on: one blocker per field, not duplicated");
console.log(`chart text number words (${mode} half) PASS checks=${checks}`);
