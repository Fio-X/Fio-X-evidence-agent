#!/usr/bin/env node
// NEWSROOM_QA_SHARED_WIDTH=1 (exact "1", default off): the heatmap/choropleth label proof measures text with the same estimator the geometry
// check uses, and that estimator gives combining marks and zero-width joiners no advance. Off: both estimators and every report are unchanged.
import assert from "node:assert/strict";
import { estimateTextWidth } from "../runtime/pi/render_qa_geometry.mjs";
import { checkHeatmapValueLabels } from "../runtime/pi/render_qa_labels.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { parseXml } from "../runtime/pi/render_qa_svg.mjs";

const withSwitch = (v, fn) => {
  const old = process.env.NEWSROOM_QA_SHARED_WIDTH;
  if (v === undefined) delete process.env.NEWSROOM_QA_SHARED_WIDTH; else process.env.NEWSROOM_QA_SHARED_WIDTH = v;
  try { return fn(); } finally { if (old === undefined) delete process.env.NEWSROOM_QA_SHARED_WIDTH; else process.env.NEWSROOM_QA_SHARED_WIDTH = old; }
};
const labelOld = (t, s) => Array.from(t).reduce((a, c) => a + (/[　-鿿＀-￯]/u.test(c) ? s : s * 0.56), 0);

// 1. off: the geometry estimator is what it was (frozen numbers), combining marks still count as a Latin fallback
for (const v of [undefined, "0", "true", ""]) {
  assert.equal(withSwitch(v, () => estimateTextWidth("石油", 12, false)).toFixed(2), "25.20");
  assert.equal(withSwitch(v, () => estimateTextWidth("12.5", 12, false)).toFixed(2), "24.52");
  assert.ok(withSwitch(v, () => estimateTextWidth("école", 12, false)) > withSwitch("1", () => estimateTextWidth("école", 12, false)));
}
// 2. on: a combining mark / ZWJ / variation selector adds nothing; Han, Hangul and Latin are unchanged
const w = (t) => withSwitch("1", () => estimateTextWidth(t, 12, false));
assert.equal(w("é"), w("e"));
assert.equal(w("a‍b"), w("ab"));
assert.equal(w("石油"), withSwitch(undefined, () => estimateTextWidth("石油", 12, false)));
assert.equal(w("한국어").toFixed(2), "37.80");

// 3. the label proof: a Hangul value label that the old 0.56em estimate thought fitted a 40px cell
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect data-role="heatmap-cell" data-x="a" data-y="b" data-value="1" x="0" y="0" width="40" height="30" fill="#ddd"/><text data-role="heatmap-cell-value" data-x="a" data-y="b" x="20" y="19" text-anchor="middle" font-size="12">한국어한국</text></svg>';
const opts = { rows: [{ a: "a", b: "b", v: 1 }], x_field: "a", y_field: "b", value_field: "v" };
const check = (textWidth) => checkHeatmapValueLabels(svg, opts, { parseXml, cellText: () => "한국어한국", ...(textWidth ? { textWidth } : {}) });
assert.equal(labelOld("한국어한국", 12).toFixed(1), "33.6"); // old estimate: fits in 40px
assert.equal(check(undefined).passed, true, "off: the overflow is missed (the defect)");
const caught = check(estimateTextWidth);
assert.equal(caught.passed, false);
assert.ok(caught.failures.some((f) => f.rule === "value_label_outside_cell"));
// 4. wired through runRenderQa: unset leaves the report byte-identical, "1" uses the shared estimator
const run = (v) => withSwitch(v, () => runRenderQa({ desktop: svg }, { heatmap: { ...opts, spec: { language: "zh" } } }));
assert.equal(JSON.stringify(run("0")), JSON.stringify(run(undefined)));
const rules = (r) => r.viewports.desktop.value_labels.failures.map((f) => f.rule);
assert.ok(!rules(run(undefined)).includes("value_label_outside_cell"));
assert.ok(rules(run("1")).includes("value_label_outside_cell"));
console.log("PASS qa shared width");
