#!/usr/bin/env node
// K281 horizontal_bar details (run11 follow-up chart). Four default-off switches, each exact "1":
//   NEWSROOM_BAR_REF_DOMAIN  - a reference_line just past the longest bar widens the axis (lint and render share one rule)
//   NEWSROOM_BAR_ZERO_MARK   - a zero value gets a visible 3px tick (data-bar rect unchanged)
//   NEWSROOM_BAR_LABEL_UNIT  - house style: no row label repeats the unit the axis already carries
// Also pins (no switch) that a highlighted bar is drawn in the accent colour and the others in the context colour.
import assert from "node:assert/strict";
import { lintVizSpec, renderVizSvg } from "../runtime/pi/viz.mjs";

const SWITCHES = ["NEWSROOM_BAR_REF_DOMAIN", "NEWSROOM_BAR_ZERO_MARK", "NEWSROOM_BAR_LABEL_UNIT"];
const withEnv = (env, fn) => {
  const saved = Object.fromEntries(SWITCHES.map((k) => [k, process.env[k]]));
  for (const k of SWITCHES) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

const base = {
  schema_version: "0.7.0", verification_mode: "draft", reader_task: "ranking", takeaway: "K281 fixture.",
  alt: "Ten states by decline.", source_note: "Synthetic fixture", sql: "SELECT * FROM synthetic",
  title: "降幅最小的州", chart_type: "horizontal_bar", category_field: "name", value_field: "v", unit: "%", sort: "asc",
  highlight_values: ["甲", "乙"],
  annotations: [{ type: "reference_line", value: 15, text: "15% 划线" }],
};
const rows = [["甲", 0], ["乙", 0], ["丙", 3], ["丁", 5.6], ["戊", 10.5], ["己", 13.4]].map(([name, v]) => ({ name, v }));

const refBlockers = (spec, r) => lintVizSpec(spec, r).blockers.filter((b) => /outside the value axis domain/.test(String(b)));

// 1a reference line domain
withEnv({}, () => assert.equal(refBlockers(base, rows).length, 1, "off: a reference line past the data max is refused as before"));
withEnv({ NEWSROOM_BAR_REF_DOMAIN: "1" }, () => {
  assert.equal(refBlockers(base, rows).length, 0, "on: 15 over a 13.4 maximum is accepted");
  const svg = renderVizSvg(base, rows);
  assert.ok(/data-role="reference-line"|stroke-dasharray/.test(svg), "on: the reference line is drawn");
  const far = { ...base, annotations: [{ type: "reference_line", value: 80, text: "太远" }] };
  assert.equal(refBlockers(far, rows).length, 1, "on: a line beyond twice the data maximum is still refused");
});
withEnv({ NEWSROOM_BAR_REF_DOMAIN: "2" }, () => assert.equal(refBlockers(base, rows).length, 1, "only exact 1 turns it on"));

// 1c zero mark
const marks = (svg) => (svg.match(/data-role="zero-mark"/g) ?? []).length;
const bars = (svg) => (svg.match(/data-role="data-bar"/g) ?? []).length;
const plain = { ...base, annotations: [] };
const offSvg = withEnv({}, () => renderVizSvg(plain, rows));
const onSvg = withEnv({ NEWSROOM_BAR_ZERO_MARK: "1" }, () => renderVizSvg(plain, rows));
assert.equal(marks(offSvg), 0, "off: no zero mark");
assert.equal(marks(onSvg), 2, "on: one mark per zero value");
assert.equal(bars(onSvg), bars(offSvg), "on: the data-bar rects are unchanged");
assert.equal(onSvg.replace(/<rect data-role="zero-mark"[^>]*\/>\n?/g, ""), offSvg, "on: the only difference is the mark elements");

// 1b highlight colour (no switch): highlighted bars use the accent, the rest the context colour
const fills = (svg) => [...svg.matchAll(/<rect data-role="data-bar"[^>]*fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase());
const f = fills(offSvg);
assert.equal(f.length, 6);
assert.equal(f[0], f[1], "both highlighted bars share one colour");
assert.notEqual(f[0], f[2], "highlighted differs from the rest");
assert.equal(new Set(f.slice(2)).size, 1, "all other bars share the context colour");

// 1d label unit: house style, one format on every row label
const labelTexts = (svg) => [...svg.matchAll(/<text[^>]*font-weight="600"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const offL = labelTexts(offSvg), onL = labelTexts(withEnv({ NEWSROOM_BAR_LABEL_UNIT: "1" }, () => renderVizSvg(plain, rows)));
assert.ok(offL.some((t) => t.includes("%")) && offL.some((t) => !t.includes("%")), `off: the old mixed labels (${offL.join(" ")})`);
assert.ok(onL.length === offL.length && onL.every((t) => !t.includes("%")), `on: no row label repeats the unit (${onL.join(" ")})`);
assert.ok(/>\d+%<\/text>/.test(withEnv({ NEWSROOM_BAR_LABEL_UNIT: "1" }, () => renderVizSvg(plain, rows))), "on: the axis still carries the unit");

console.log("test_bar_details_k281: ok");
