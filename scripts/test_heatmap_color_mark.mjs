#!/usr/bin/env node
// NEWSROOM_HEATMAP_VALUE_LABELS=1: a heatmap may declare mark_semantics "color" (quantitative.color_mark_choropleth_only)
// only when heatmapValueLabelsProven holds - the same per-cell proof as color_only_quantity. Everything else stays an ERROR.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { misleadingQuantitativeValidator } from "../runtime/pi/editorial_validators.mjs";

const spec = { schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各国燃料占比", subtitle: "各来源占比", unit: "%", x_field: "fuel", y_field: "country", value_field: "share", decimals: 1, source: "测试", source_note: "测试", sql: "SELECT 1", alt: "热力图测试，若干国家乘四种燃料的占比。" };
const fuels = ["煤", "石油", "天然气", "水泥"];
const wide = Array.from({ length: 5 }, (_, i) => `国${i + 1}`).flatMap((c, i) => Array.from({ length: 40 }, (_, j) => ({ country: c, fuel: `燃料${j + 1}`, share: 10 + i * 3 + j * 0.5 })));
const normal = Array.from({ length: 6 }, (_, i) => `国${i + 1}`).flatMap((c, i) => fuels.map((fu, j) => ({ country: c, fuel: fu, share: 10 + i * 3 + j * 1.5 })));
const sha = (t) => createHash("sha256").update(t).digest("hex");
const env = (v, fn) => { const o = process.env.NEWSROOM_HEATMAP_VALUE_LABELS; if (v === undefined) delete process.env.NEWSROOM_HEATMAP_VALUE_LABELS; else process.env.NEWSROOM_HEATMAP_VALUE_LABELS = v; try { return fn(); } finally { if (o === undefined) delete process.env.NEWSROOM_HEATMAP_VALUE_LABELS; else process.env.NEWSROOM_HEATMAP_VALUE_LABELS = o; } };
const build = (rows) => env("1", () => { const svg = renderVizBundle(spec, rows, { mobilePages: false }).desktop; return { svg, qa: runRenderQa({ desktop: svg }, { heatmap: { rows, spec, x_field: "fuel", y_field: "country", value_field: "share" } }) }; });
const mod = { id: "m", type: "visual", manifest_ref: "visualizations/m.json", quantitative_encoding: { quantity_kind: "share", mark_semantics: "color", scale_type: "linear", baseline_policy: "not_applicable", uncertainty_disclosed: true } };
const RULE = "quantitative.color_mark_choropleth_only";
const hit = (chart, svg, qa) => misleadingQuantitativeValidator({ schema_version: "1.5.0", modules: [mod] }, { "visualizations/m.json": { manifest: { chart_type: chart }, desktopSvg: svg, ...(qa ? { renderQa: qa } : {}) } }).some((i) => i.rule_id === RULE);

const ok = build(normal), tiny = build(wide);
assert.equal(ok.qa.viewports.desktop.value_labels.passed, true);
assert.equal(tiny.qa.viewports.desktop.value_labels.passed, false);
// labelled heatmap with color passes with the switch on
assert.equal(env("1", () => hit("heatmap", ok.svg, ok.qa)), false);
// switch off / not exact "1": still ERROR
for (const v of [undefined, "0", "true", ""]) assert.equal(env(v, () => hit("heatmap", ok.svg, ok.qa)), true, `switch ${v}`);
// unproven: no renderQa, stale sha, small cells -> ERROR
assert.equal(env("1", () => hit("heatmap", ok.svg, undefined)), true);
const stale = JSON.parse(JSON.stringify(ok.qa)); stale.viewports.desktop.svg_sha256 = sha("other");
assert.equal(env("1", () => hit("heatmap", ok.svg, stale)), true);
assert.equal(env("1", () => hit("heatmap", tiny.svg, tiny.qa)), true);
// other chart types with color stay ERROR even with the same proof; choropleth is unchanged
assert.equal(env("1", () => hit("horizontal_bar", ok.svg, ok.qa)), true);
assert.equal(env("1", () => hit("bar", ok.svg, ok.qa)), true);
assert.equal(env("1", () => hit("choropleth", ok.svg, undefined)), false);
assert.equal(env(undefined, () => hit("choropleth", ok.svg, undefined)), false);
console.log("PASS heatmap color mark");
