#!/usr/bin/env node
// NEWSROOM_HEATMAP_TIDY=1 (default off, desktop only): the heatmap's colour domain and legend ends are the data's own
// min and max (never padded below zero), cells carry bare numbers on the shared decimal count, and the unit is said once.
// Off (unset, "0", "true", ""), the SVG is byte-identical.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const spec = (extra = {}) => ({ schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各国燃料占比", subtitle: "各来源占比", unit: "%", x_field: "fuel", y_field: "country", value_field: "share", decimals: 1, source: "测试", source_note: "测试", sql: "SELECT 1", alt: "热力图测试，十个国家乘四种燃料的占比。", ...extra });
const countries = ["中国", "美国", "印度", "俄罗斯", "日本", "伊朗", "德国", "印尼", "韩国", "沙特"];
const fuels = ["煤", "石油", "天然气", "水泥"];
const rowsOf = (f) => countries.flatMap((c, i) => fuels.map((fu, j) => ({ country: c, fuel: fu, share: f(i, j) })));
const shapes = {
  mixedMagnitudes: rowsOf((i, j) => [17, 2.15, 21.4, 0.37][j] + i * 1.3),
  zeroMin: rowsOf((i, j) => (i + j === 0 ? 0 : (i * 4 + j) * 0.7)),
  rates: rowsOf((i, j) => ((i * 7 + j * 3) % 11) / 10),
};
const render = (sp, rows) => renderVizBundle(sp, rows, { mobilePages: false }).desktop;
const qa = (svg) => { const v = runRenderQa({ desktop: svg }).viewports.desktop; return [...(v.geometry?.failures ?? []), ...(v.contrast?.failures ?? [])].map((f) => f.rule); };
const countBy = (rules) => rules.reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map());
const withSwitch = (value, fn) => { const old = process.env.NEWSROOM_HEATMAP_TIDY; if (value === undefined) delete process.env.NEWSROOM_HEATMAP_TIDY; else process.env.NEWSROOM_HEATMAP_TIDY = value; try { return fn(); } finally { if (old === undefined) delete process.env.NEWSROOM_HEATMAP_TIDY; else process.env.NEWSROOM_HEATMAP_TIDY = old; } };
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

for (const [name, rows] of Object.entries(shapes)) for (const unit of ["%", "吨/人"]) {
  const sp = spec({ unit });
  const label = `${name}/${unit}`;
  const base = withSwitch(undefined, () => render(sp, rows));
  for (const v of ["0", "true", ""]) assert.equal(withSwitch(v, () => render(sp, rows)), base, `${label}: switch ${JSON.stringify(v)} is off`);
  const on = withSwitch("1", () => render(sp, rows));
  assert.notEqual(on, base, `${label}: the switch changes the chart`);
  // render QA: no rule has more issues on than off
  const off = countBy(qa(base));
  for (const [rule, n] of countBy(qa(on))) assert.ok(n <= (off.get(rule) ?? 0), `${label}: ${rule} ${n} on > ${off.get(rule) ?? 0} off`);
  // numbers: every numeric text is a bare fixed-decimal number inside the data range; the unit appears once
  const vals = rows.map((r) => r.share), lo = Math.min(...vals), hi = Math.max(...vals);
  const nums = texts(on).filter((t) => /^[-−]?[\d,]+(\.\d+)?$/.test(t));
  assert.ok(nums.length >= vals.length, `${label}: cell labels present`);
  for (const t of nums) {
    assert.match(t, /^\d+\.\d$/, `${label}: fixed one decimal, no unit: ${t}`);
    const v = Number(t);
    assert.ok(v >= Number(lo.toFixed(1)) - 1e-9 && v <= Number(hi.toFixed(1)) + 1e-9, `${label}: ${t} inside the data range ${lo}..${hi}`);
  }
  const cells = rows.map((r) => r.share.toFixed(1));
  for (const c of cells) assert.ok(nums.includes(c), `${label}: cell ${c} printed`);
  assert.ok(!texts(on).some((t) => /[-−]\d/.test(t)), `${label}: no negative number anywhere`);
  assert.equal(texts(on).filter((t) => t === `单位：${unit}`).length, 1, `${label}: unit said once`);
  assert.equal(texts(on).filter((t) => /\d.*(%|吨)/.test(t)).length, 0, `${label}: no number carries a unit`);
  assert.ok(texts(on).includes(lo.toFixed(1)) && texts(on).includes(hi.toFixed(1)), `${label}: legend ends are the data min and max`);
}
console.log("PASS heatmap tidy");
