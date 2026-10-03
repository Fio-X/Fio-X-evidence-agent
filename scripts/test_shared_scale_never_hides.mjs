#!/usr/bin/env node
// The chart-level number formatter never hides a value: a non-zero value never prints as zero, no value
// loses or flips its sign, two different values print differently while 3 decimals in the printed unit can
// show the difference, and the shared decimal count is raised (up to 3) to get there. Only when 3 is not
// enough on a zh chart do the values that would collapse print in their own unit. The round-3 house style
// (one unit per chart, one decimal count) is unchanged. Synthetic data only.
import assert from "node:assert/strict";
import { chartValueFormatter, fmtSpec, renderVizBundle } from "../runtime/pi/viz.mjs";

const base = {
  schema_version: "0.7.0", takeaway: "t", title: "Scale", subtitle: "synthetic", alt: "A synthetic chart used to check number scale words in axis and value labels.",
  source_note: "synthetic fixture", claim_id: "claim-scale", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, unit: "元",
  reader_task: "ranking", chart_type: "horizontal_bar", category_field: "category", value_field: "value", sort: "desc",
};
const rowsOf = (vals) => vals.map((value, i) => ({ category: `c${i}`, value }));
// renderVizBundle activates the house style (the formatter's default path); the probe then asks the same
// chart-level formatter the renderer uses.
function labels(language, vals, extra = {}) {
  const spec = { ...base, language, ...extra };
  renderVizBundle(spec, rowsOf(vals), { mobilePages: false });
  const f = chartValueFormatter(spec, vals);
  return vals.map((v) => f(v, ""));
}
const MULT = { 万亿: 1e12, 亿: 1e8, 万: 1e4, "": 1 };
function parse(text) {
  const m = /^(-?[0-9.]+(?:e[+-]?\d+)?)(万亿|亿|万)?$/.exec(text.replace(/,/g, ""));
  assert.ok(m, `unparseable label ${JSON.stringify(text)}`);
  return { n: Number(m[1]), suffix: m[2] ?? "", mult: MULT[m[2] ?? ""], text };
}
function checkNeverHides(language, vals, extra = {}) {
  const out = labels(language, vals, extra).map(parse);
  const ctx = `${language} ${JSON.stringify(vals)} ${JSON.stringify(extra)} -> ${out.map((o) => o.text).join(" | ")}`;
  out.forEach((o, i) => {
    if (vals[i] === 0) return;
    assert.notEqual(o.n, 0, `rule 1 (non-zero printed as zero): ${ctx}`);
    assert.equal(Math.sign(o.n), Math.sign(vals[i]), `rule 2 (sign): ${ctx}`);
  });
  for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) {
    if (vals[i] === vals[j]) continue;
    // 3 decimals in the printed unit can tell them apart: same unit, and they differ by at least one 0.001 step
    const a = out[i], b = out[j];
    if (a.suffix !== b.suffix) continue;
    const step = a.mult * 0.001;
    if (Math.abs(vals[i] - vals[j]) < step * 1.0000001) continue;
    assert.notEqual(a.text, b.text, `rule 3 (distinct values printed alike): ${ctx}`);
  }
  return out.map((o) => o.text);
}

// Codex's counterexample: 1.00亿, 0.00亿, -0.00亿 before
{
  const t = checkNeverHides("zh", [100000000, 1, -1]);
  assert.equal(t[0], "1.00亿", "the large value keeps the shared unit");
  assert.ok(t[1].startsWith("1") && t[2].startsWith("-1"), `small values keep value and sign: ${t}`);
}
// en [1000.1, 1000.2]: "every value in the thousands means no decimals" no longer wins over rule 3
{
  const t = labels("en", [1000.1, 1000.2]);
  assert.notEqual(t[0], t[1], `en 1000.1 vs 1000.2: ${t}`);
}
// zh 10000.123 with decimals 3: the count is in the printed unit
assert.equal(labels("zh", [10000.123], { decimals: 3 })[0], "1.000万");
// explicit integer decimals keep at least that count for values from 1万 up
for (const [v, d] of [[12345.678, 2], [12345.678, 3], [-67500.5, 1]]) {
  const text = fmtSpec({ language: "zh" }, v, "", d);
  assert.ok(new RegExp(`\\.\\d{${d},}万$`).test(text), `explicit decimals ${d} kept: ${v} -> ${text}`);
}
// non-percent values across magnitudes, close together, small and non-zero, negative
const sets = [
  [1e8, 1, -1], [1e12, 1e8, 1e4, 1, 0.5], [-1e8, 1e8, 3], [12000, 1e8, 0.5], [1e9, 0.0004], [5e4, 5.0004e4],
  [1000.1, 1000.2], [123456.7, 123456.8], [86000, 88000, 0.2], [2.5e8, 2.49e8, 3], [-0.0004, 3e8], [1e13, 7, -7],
  [0.0001, 0.0002, 5000], [1e5, 1e5 + 1, 1e5 + 2],
];
for (const vals of sets) for (const language of ["zh", "en"]) {
  checkNeverHides(language, vals);
  checkNeverHides(language, vals, { decimals: 0 });
  checkNeverHides(language, vals, { decimals: 2 });
}
// rule 5: 3 decimals cannot show 1 next to 1e12 in 万亿 (0.000万亿); that value prints in its own unit, not as zero
{
  const t = checkNeverHides("zh", [1e13, 1, -1]);
  assert.ok(!/^-?0(\.0+)?(万亿)?$/.test(t[1]) && !/^-?0(\.0+)?(万亿)?$/.test(t[2]), `own unit: ${t}`);
}
// the round-3 house style is unchanged: one unit, one decimal count, 8.6万 beside 8.8万
assert.deepEqual(labels("zh", [86000, 88000]), ["8.6万", "8.8万"]);
assert.deepEqual(labels("zh", [3.5e9, 1.2e9, 8.4e8, 1.1e8]), ["35.0亿", "12.0亿", "8.4亿", "1.1亿"]);
assert.deepEqual(labels("zh", [350000, 120000]), ["35万", "12万"]);
assert.deepEqual(labels("en", [5, 5, 3]), ["5", "5", "3"]);
// an explicit decimal count is formatted from the value, never padded onto the four-significant-digit rounding
{
  const zh = (v, d) => fmtSpec({ language: "zh" }, v, "", d);
  assert.equal(zh(1234567, 3), "123.457万");
  assert.equal(zh(12345678, 3), "1234.568万");
  assert.equal(zh(123456789012, 2), "1234.57亿");
  assert.equal(zh(12345.678, 3), "1.235万");
  assert.equal(zh(-67500.5, 1), "-6.75万");
  assert.equal(zh(12345678, 1), "1234.6万", "an index-panel end value at or above 1000万 (fmtSpec(spec, lv, '', 1))");
}
console.log("shared scale never hides a value: all checks passed");
