#!/usr/bin/env node
// NEWSROOM_HEATMAP_LOG_COLOR=1 (exact "1", default off): heatmap spec.color_scale "log" colours cells on the log of the value.
// Off, the field is absent from the tool definition, rejected by validation, and the SVG is byte-identical.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderVizBundle, validateVizSpec, lintVizSpec } from "../runtime/pi/viz.mjs";

const spec = (extra = {}) => ({ schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各国排放", subtitle: "年", x_field: "year", y_field: "country", value_field: "v", unit: "Mt", alt: "热力图测试，六国乘五个年份的排放。", source_note: "测试", sql: "SELECT 1", ...extra });
const countries = ["中国", "美国", "印度", "德国", "日本", "巴西"];
const years = [2000, 2005, 2010, 2015, 2020];
const big = { 中国: 3000, 美国: 5000, 印度: 300, 德国: 800, 日本: 1100, 巴西: 90 };
const rows = countries.flatMap((c, i) => years.map((y, j) => ({ country: c, year: y, v: Math.round(big[c] * (1 + j * 0.1) * (c === "中国" ? 1 + j : 1)) })));
const render = (sp, r = rows) => renderVizBundle(sp, r, { mobilePages: false }).desktop;
const withSwitch = (value, fn) => { const old = process.env.NEWSROOM_HEATMAP_LOG_COLOR; if (value === undefined) delete process.env.NEWSROOM_HEATMAP_LOG_COLOR; else process.env.NEWSROOM_HEATMAP_LOG_COLOR = value; try { return fn(); } finally { if (old === undefined) delete process.env.NEWSROOM_HEATMAP_LOG_COLOR; else process.env.NEWSROOM_HEATMAP_LOG_COLOR = old; } };
const fills = (svg) => [...svg.matchAll(/<rect x="[^"]*" y="[^"]*" width="(?!1")[^"]*" height="[^"]*" fill="(#[0-9a-fA-F]{6}|rgb[^"]*)"/g)].map((m) => m[1]);

// tool definition: the field is spread in only when the switch is exactly "1"
const src = readFileSync(new URL("../runtime/pi/newsroom.ts", import.meta.url), "utf8");
assert.match(src, /\.\.\.\(process\.env\.NEWSROOM_HEATMAP_LOG_COLOR === "1" \? \{ color_scale: /, "color_scale enters the tool definition only behind the switch");
assert.equal((src.match(/color_scale:/g) ?? []).length, 1, "one definition site");

const errorsOf = (sp) => { const r = validateVizSpec(sp); return Array.isArray(r) ? r : (r?.errors ?? []); };
// off: unset, "0", "true", "" all behave as absent
const base = withSwitch(undefined, () => render(spec()));
for (const v of ["0", "true", ""]) {
  assert.equal(withSwitch(v, () => render(spec())), base, `switch ${JSON.stringify(v)} is off`);
  assert.throws(() => withSwitch(v, () => render(spec({ color_scale: "log" }))), /color_scale is not available/, `switch ${JSON.stringify(v)}: render refuses color_scale`);
  assert.ok(withSwitch(v, () => errorsOf(spec({ color_scale: "log" }))).some((e) => /color_scale is not available/.test(e)), `switch ${JSON.stringify(v)}: color_scale rejected`);
}
assert.deepEqual(withSwitch(undefined, () => errorsOf(spec())), withSwitch("1", () => errorsOf(spec())), "no color_scale: validation unchanged");

// on
const lin = withSwitch("1", () => render(spec({ color_scale: "linear" })));
assert.equal(lin, base, "linear with the switch on is the same SVG as before");
const log = withSwitch("1", () => render(spec({ color_scale: "log" })));
assert.notEqual(log, lin, "log changes the chart");
const order = rows.map((r, i) => [r.v, i]).sort((a, b) => a[0] - b[0]);
const fl = fills(lin), fg = fills(log);
assert.equal(fl.length, fg.length);
assert.equal(fl.length, rows.length, "one fill per cell");
assert.notDeepEqual(fg, fl, "colour banding differs");
// the lowest third of values spans more distinct colours on log than on linear
const low = order.slice(0, Math.floor(rows.length / 3)).map(([, i]) => i);
// fills are in y-then-x order, same as rows
assert.ok(new Set(low.map((i) => fg[i])).size > new Set(low.map((i) => fl[i])).size, "small cells are easier to tell apart on log");
assert.match(log, /对数色阶/, "legend names the log scale");
assert.doesNotMatch(lin, /对数色阶/);
assert.match(withSwitch("1", () => render(spec({ color_scale: "log", language: "en" }))), /Log colour scale/);
const nums = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter((t) => /\d/.test(t));
const legendTicks = nums(log).filter((t) => /^(10|100|1,?000|10,?000)/.test(t));
assert.ok(legendTicks.length >= 1, "power-of-ten ticks on the legend");

// validation and lint
assert.deepEqual(withSwitch("1", () => errorsOf(spec({ color_scale: "log" }))), []);
assert.ok(withSwitch("1", () => errorsOf(spec({ color_scale: "sqrt" }))).some((e) => /must be linear or log/.test(e)));
assert.ok(withSwitch("1", () => errorsOf(spec({ chart_type: "bar", color_scale: "log" }))).some((e) => /only applies to chart_type heatmap/.test(e)));
const blockersOf = (sp, r) => { const out = lintVizSpec(sp, r, {}); return Array.isArray(out) ? out : (out?.blockers ?? out?.errors ?? []); };
const zeroRows = rows.map((r, i) => (i === 0 ? { ...r, v: 0 } : i === 1 ? { ...r, v: -5 } : r));
const lz = withSwitch("1", () => blockersOf(spec({ color_scale: "log" }), zeroRows));
assert.ok(lz.some((b) => /Log color_scale requires every value in 'v' to be above 0 \(2 cells at or below zero\); use the linear colour scale/.test(b)), JSON.stringify(lz));
assert.ok(!withSwitch("1", () => blockersOf(spec({ color_scale: "log" }), rows)).some((b) => /Log color_scale/.test(b)));
assert.ok(!withSwitch("1", () => blockersOf(spec({ color_scale: "linear" }), zeroRows)).some((b) => /Log color_scale/.test(b)), "linear allows zeros");
assert.ok(!withSwitch(undefined, () => blockersOf(spec(), zeroRows)).some((b) => /Log color_scale/.test(b)));
console.log("ok heatmap log colour");
