#!/usr/bin/env node
// NEWSROOM_QA_NO_EMPTY_PASS=1: a chart whose every value to draw is 0 is rejected, and the rejection says why and gives two ways out.
// Judgement stays: the all-zero mirrored bar failed before this change (no marks) and still fails; one non-zero value is judged as before;
// switch off, the report is byte-identical (the allZero option is ignored). Needs no provider.
import assert from "node:assert/strict";
import { ALL_ZERO_MESSAGE, runRenderQa, valuesAllZero } from "../runtime/pi/render_qa.mjs";
import { renderVizBundle } from "../runtime/pi/viz.mjs";

const spec = { schema_version: "0.7.0", reader_task: "comparison", takeaway: "t", title: "Fixture", alt: "Synthetic fixture chart for the test.", source_note: "Synthetic", claim_id: "c1", sql: "SELECT 1", unit: "%", direct_labels: true, annotations: [], highlight_values: [], chart_type: "mirrored_bar", category_field: "c", value_field: "v", series_field: "s" };
const rowsWith = (f) => ["A", "B", "C", "D"].flatMap((c, i) => [{ c, s: "Left", v: f(i, 0) }, { c, s: "Right", v: f(i, 1) }]);
const zero = rowsWith(() => 0);
const mixed = rowsWith((i, s) => (i === 2 && s === 1 ? 3 : 0));
const run = (rows, on, options) => {
  if (on === undefined) delete process.env.NEWSROOM_QA_NO_EMPTY_PASS; else process.env.NEWSROOM_QA_NO_EMPTY_PASS = on;
  return runRenderQa(renderVizBundle(spec, rows, { mobilePages: false }), options);
};
const asProduct = (rows, on) => run(rows, on, valuesAllZero(spec, rows) && on === "1" ? { allZero: true } : {});

// detection
assert.equal(valuesAllZero(spec, zero), true);
assert.equal(valuesAllZero(spec, mixed), false, "one non-zero value is not all zero");
assert.equal(valuesAllZero(spec, []), false, "no values is not all zero");
assert.equal(valuesAllZero({ ...spec, value_field: undefined }, zero), false, "no value field");
assert.equal(valuesAllZero(spec, rowsWith(() => "0")), true);
assert.equal(valuesAllZero(spec, rowsWith(() => "n/a")), false, "a non-numeric value is judged as before");
assert.equal(valuesAllZero(spec, rowsWith(() => null)), false, "only nulls: nothing seen");
assert.equal(valuesAllZero({ ...spec, chart_type: "scatter", x_field: "c", y_field: "v", value_field: undefined }, zero), false, "coordinates do not count");

// on: the all-zero mirrored bar fails, the failure names both ways out
const on = asProduct(zero, "1");
assert.equal(on.passed, false);
const failures = on.viewports.desktop.extra_checks.no_empty_pass.failures;
const named = failures.find((f) => f.rule === "qa_all_values_zero");
assert.ok(named, "an all-zero failure is reported");
assert.equal(named.message, ALL_ZERO_MESSAGE);
assert.match(named.message, /all (?:the )?values to draw are 0/i);
assert.match(named.message, /nothing to draw/);
assert.match(named.message, /change the data or the metric/);
assert.match(named.message, /do not draw this chart and state in the text that these values are all 0/);
// the judgement did not move: without the new option it fails on the same empty-mark rule as before
const before = run(zero, "1");
assert.equal(before.passed, false);
assert.ok(before.viewports.desktop.extra_checks.no_empty_pass.failures.some((f) => f.checked_rule === "text_crosses_data_mark"));
assert.equal(before.viewports.desktop.extra_checks.no_empty_pass.failures.some((f) => f.rule === "qa_all_values_zero"), false);

// one non-zero value: the same report as without the rule
assert.equal(JSON.stringify(asProduct(mixed, "1")), JSON.stringify(run(mixed, "1")), "one non-zero value is judged as before");
assert.equal(asProduct(mixed, "1").viewports.desktop.extra_checks.no_empty_pass.failures.some((f) => f.rule === "qa_all_values_zero"), false);

// off: byte-identical, even when the option is passed
for (const v of [undefined, "0", "true", "", " 1", "01"]) {
  for (const rows of [zero, mixed]) {
    const plain = JSON.stringify(run(rows, v));
    assert.equal(JSON.stringify(run(rows, v, { allZero: true })), plain, `off (${JSON.stringify(v)}): the option changes nothing`);
    assert.equal(plain.includes("qa_all_values_zero") || plain.includes("extra_checks"), false, `off (${JSON.stringify(v)}): no extra checks`);
  }
}
delete process.env.NEWSROOM_QA_NO_EMPTY_PASS;
console.log("PASS qa all zero");
