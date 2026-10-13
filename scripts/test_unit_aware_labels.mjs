#!/usr/bin/env node
// NEWSROOM_UNIT_AWARE_LABELS=1 (exact "1", default off): a unit that already carries a magnitude is converted to 万/亿 (en: m/bn),
// never stacked (no "万 百万吨"); Sankey names get a wider column before any cut and a cut is a render QA warning; heatmap cell
// text is black or white by contrast with no outline; a heatmap whose cells are too small for their numbers fails at the single
// chart. Off (unset, "0", "true", ""), every SVG is byte-identical.
import assert from "node:assert/strict";
import { renderVizBundle, unitAwareText, fmtSpec } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const withEnv = (vars, fn) => {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};
const sw = (v, fn, extra = {}) => withEnv({ NEWSROOM_UNIT_AWARE_LABELS: v, ...extra }, fn);
const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

// the one formatter
assert.equal(unitAwareText(4835.3, "百万吨", "zh"), "48.4 亿吨");
assert.equal(unitAwareText(12000, "万吨", "zh"), "1.2 亿吨");
assert.equal(unitAwareText(0.0005, "百万吨", "zh"), "500 吨");
assert.equal(unitAwareText(35, "千万人", "zh"), "3.5 亿人");
assert.equal(unitAwareText(4835.3, "million tonnes", "en"), "4.84bn tonnes");
assert.equal(unitAwareText(12, "千克", "zh"), null, "千克 is a base unit, not a magnitude");
assert.equal(unitAwareText(5, "吨", "zh"), null);
assert.equal(unitAwareText(4835.3, "百万吨", "zh", 2), "48.35 亿吨", "a shared decimal count is kept");

// Sankey
const sankeySpec = (extra = {}) => ({ schema_version: "0.9.0", reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", complexity_budget: "medium", takeaway: "煤是最大的来源", chart_type: "sankey", title: "排放的来源与去向", subtitle: "单位：百万吨", alt: "桑基图显示各来源的流向。", source_note: "测试数据", claim_id: "claim-n", sql: "SELECT 1", unit: "百万吨", language: "zh", source_field: "source", target_field: "target", value_field: "value", flow_conservation: "none", highlight_values: [], annotations: [], ...extra });
const edges = (list) => list.map(([source, target, value]) => ({ source, target, value }));
const rows = edges([["煤", "化石", 48353], ["石油", "化石", 31002], ["化石", "大气", 60004], ["化石", "海洋", 19351]]);
const render = (sp, r) => renderVizBundle(sp, r, { mobilePages: false }).desktop;
const base = sw(undefined, () => render(sankeySpec(), rows));
assert.ok(texts(base).some((t) => /万 百万吨/.test(t)), "off: the old stacked spelling is what this switch fixes");
for (const v of ["0", "true", ""]) assert.equal(sw(v, () => render(sankeySpec(), rows)), base, `switch ${JSON.stringify(v)} is off`);
const on = sw("1", () => render(sankeySpec(), rows));
assert.notEqual(on, base);
assert.ok(!texts(on).some((t) => /万 百万吨|万百万吨/.test(t)), "on: no magnitude stacked on a magnitude unit");
assert.ok(texts(on).includes("484 亿吨"), `煤 48353 百万吨 -> 484 亿吨 (got ${texts(on).filter((t) => /吨/.test(t)).join("|")})`);
const en = sw("1", () => render(sankeySpec({ language: "en", unit: "million tonnes", title: "Sources", subtitle: "million tonnes", alt: "Flow chart of sources." }), rows));
assert.ok(texts(en).some((t) => /^4\.84bn tonnes$/.test(t) || /bn tonnes/.test(t)), `en: bn tonnes (got ${texts(en).filter((t) => /tonnes/.test(t)).join("|")})`);

// truncation: a long name is cut at 14 units off; on it has a wider column first, and a cut that remains is a warning
const longName = "其他国家及地区的合计排放"; // 11 characters = 22 units: over the 14-unit budget, inside the 24-unit one
const longRows = edges([[longName, "化石", 4835.3], ["石油", "化石", 3100.2], ["化石", "大气", 8000]]);
const offLong = sw(undefined, () => render(sankeySpec(), longRows));
assert.ok(texts(offLong).some((t) => t.endsWith("…")), "off: an 11-character name is cut");
const onLong = sw("1", () => render(sankeySpec(), longRows));
assert.ok(!texts(onLong).some((t) => t.endsWith("…")), "on: the wider column keeps an 11-character name whole");
const reallyLong = "其他国家及地区的合计排放量总和以及一切未列出的国家与地区汇总";
const cutRows = edges([[reallyLong, "化石", 4835.3], ["石油", "化石", 3100.2], ["化石", "大气", 8000]]);
const cutSvg = sw("1", () => render(sankeySpec(), cutRows));
assert.ok(texts(cutSvg).some((t) => t.endsWith("…")), "on: a name past the budget is still cut");
const qaOn = sw("1", () => runRenderQa({ desktop: cutSvg }));
assert.ok((qaOn.viewports.desktop.warnings ?? []).some((w) => w.rule === "label_truncated" && w.message.includes(reallyLong)), "the cut is a render QA warning");
assert.equal(qaOn.viewports.desktop.warnings?.length, 1);
const qaOff = sw(undefined, () => runRenderQa({ desktop: sw(undefined, () => render(sankeySpec(), cutRows)) }));
assert.equal(qaOff.viewports.desktop.warnings, undefined, "off: no warnings field");

// heatmap
const heatSpec = (extra = {}) => ({ schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各国排放", subtitle: "年", x_field: "year", y_field: "country", value_field: "v", unit: "Mt", alt: "热力图。", source_note: "测试", sql: "SELECT 1", ...extra });
const heatRows = (cols, nrows = 5) => Array.from({ length: nrows }, (_, c) => Array.from({ length: cols }, (_, y) => ({ country: `c${c}`, year: 2000 + y, v: (c * cols + y) * 10 }))).flat();
const heatBase = sw(undefined, () => render(heatSpec(), heatRows(8)));
for (const v of ["0", "true", ""]) assert.equal(sw(v, () => render(heatSpec(), heatRows(8))), heatBase, `heatmap: switch ${JSON.stringify(v)} is off`);
assert.match(heatBase, /paint-order/, "off: the old outline is present");
const heatOn = sw("1", () => render(heatSpec(), heatRows(8)));
assert.doesNotMatch(heatOn, /paint-order|stroke-linejoin="round" paint/, "on: no outline");
// the legend ends are muted grey text on the page background, not cell text
const cellFills = new Set([...heatOn.matchAll(/<text[^>]*fill="(#[0-9a-f]{6})"[^>]*>\d+ Mt</g)].map((m) => m[1]).filter((f) => f !== "#666666"));
assert.ok(cellFills.size >= 1);
for (const f of cellFills) assert.ok(["#ffffff", "#000000"].includes(f), `cell text is black or white: ${f}`);
const heatQa = sw("1", () => runRenderQa({ desktop: heatOn }).viewports.desktop);
assert.equal(heatQa.contrast.failures.length, 0, "on: no contrast failure on any cell");
assert.equal(heatQa.warnings, undefined);

// K229: too many columns with the value-labels proof on is an error at the single chart, with the transpose advice
const proof = { NEWSROOM_HEATMAP_VALUE_LABELS: "1" };
const wide = heatRows(20);
const err = assert.throws(() => sw("1", () => render(heatSpec(), wide), proof), /列数 20 太多.*转置为行×列/);
assert.doesNotThrow(() => sw("1", () => render(heatSpec(), heatRows(10)), proof), "10 columns fit");
assert.doesNotThrow(() => sw(undefined, () => render(heatSpec(), wide), proof), "off: the old behaviour (cells without numbers) is unchanged");
assert.doesNotThrow(() => sw("1", () => render(heatSpec(), wide)), "no value-label proof wanted: no error");
assert.throws(() => sw("1", () => render(heatSpec({ language: "en" }), wide), proof), /20 columns.*Transpose/);
void err;
console.log("ok unit-aware labels");
