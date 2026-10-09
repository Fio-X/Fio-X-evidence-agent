#!/usr/bin/env node
// NEWSROOM_HEATMAP_VALUE_LABELS=1 (exact "1", default off): a heatmap may pass infographic lint's color_only_quantity blocker
// only when its render-QA report proves, bound by sha256 to the desktop SVG, that EVERY non-null cell shows its exact value.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { visualChannelOwnerValidator } from "../runtime/pi/editorial_validators.mjs";

const spec = { schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各国燃料占比", subtitle: "各来源占比", unit: "%", x_field: "fuel", y_field: "country", value_field: "share", decimals: 1, source: "测试", source_note: "测试", sql: "SELECT 1", alt: "热力图测试，若干国家乘四种燃料的占比。", };
const fuels = ["煤", "石油", "天然气", "水泥"];
const mk = (n) => Array.from({ length: n }, (_, i) => `国${i + 1}`).flatMap((c, i) => fuels.map((fu, j) => ({ country: c, fuel: fu, share: 10 + i * 3 + j * 1.5 })));
const sha = (t) => createHash("sha256").update(t).digest("hex");
const env = (v, fn) => { const o = process.env.NEWSROOM_HEATMAP_VALUE_LABELS; if (v === undefined) delete process.env.NEWSROOM_HEATMAP_VALUE_LABELS; else process.env.NEWSROOM_HEATMAP_VALUE_LABELS = v; try { return fn(); } finally { if (o === undefined) delete process.env.NEWSROOM_HEATMAP_VALUE_LABELS; else process.env.NEWSROOM_HEATMAP_VALUE_LABELS = o; } };
const render = (rows) => renderVizBundle(spec, rows, { mobilePages: false }).desktop;
const qaFor = (svg, rows) => runRenderQa({ desktop: svg }, { heatmap: { rows, spec, x_field: "fuel", y_field: "country", value_field: "share" } });
const mod = { id: "h", type: "visual", manifest_ref: "visualizations/h.json", visual_grammar: "distribution", visual_channels: [{ channel: "color", field: "share", role: "quantitative" }] };
const issues = (svg, renderQa, chart = "heatmap") => visualChannelOwnerValidator({ schema_version: "1.5.0", modules: [mod] }, { "visualizations/h.json": { manifest: { chart_type: chart }, desktopSvg: svg, ...(renderQa ? { renderQa } : {}) } });
const blocked = (l) => l.some((i) => i.rule_id === "visual_channel.color_only_quantity");

const rows = mk(6);
// 1. off: the SVG is byte-identical for unset/"0"/"true"/"", and carries no proof attributes
const base = env(undefined, () => render(rows));
for (const v of ["0", "true", ""]) assert.equal(env(v, () => render(rows)), base);
assert.ok(!base.includes("data-role=\"heatmap-cell"));
// the switch off never proves anything, even with a passing-looking report
const onSvg = env("1", () => render(rows));
const onQa = env("1", () => qaFor(onSvg, rows));
assert.equal(onQa.viewports.desktop.value_labels.passed, true, JSON.stringify(onQa.viewports.desktop.value_labels));
assert.ok(blocked(env(undefined, () => issues(onSvg, onQa))), "switch off: still blocked");
assert.ok(blocked(env("true", () => issues(onSvg, onQa))), "switch true: still blocked");
// 2. on + every cell labelled: exempt
assert.deepEqual(env("1", () => issues(onSvg, onQa)), []);
// the choropleth path is untouched: a bar with the same proof stays blocked
assert.ok(blocked(env("1", () => issues(onSvg, onQa, "bar"))));
// 3. on + tiny cells (many columns/rows -> labels suppressed): proof fails and the block stays
const tiny = Array.from({ length: 5 }, (_, i) => `国${i + 1}`).flatMap((c, i) => Array.from({ length: 40 }, (_, j) => ({ country: c, fuel: `燃料${j + 1}`, share: 10 + i * 3 + j * 0.5 })));
const tinySvg = env("1", () => render(tiny));
const tinyQa = env("1", () => qaFor(tinySvg, tiny));
assert.equal(tinyQa.viewports.desktop.value_labels.passed, false);
assert.ok(tinyQa.viewports.desktop.value_labels.failures.some((f) => f.rule === "value_label_missing"));
assert.ok(blocked(env("1", () => issues(tinySvg, tinyQa))));
// the heatmap still renders: label proof never changes the overall QA verdict
assert.equal(tinyQa.passed, runRenderQa({ desktop: tinySvg }).passed);
// 4. stale sha
const stale = JSON.parse(JSON.stringify(onQa)); stale.viewports.desktop.svg_sha256 = sha("other");
assert.ok(blocked(env("1", () => issues(onSvg, stale))));
// 5. missing renderQa
assert.ok(blocked(env("1", () => issues(onSvg, undefined))));
// a wrong label text fails the proof
const tampered = onSvg.replace(/(data-role="heatmap-cell-value"[^>]*>)[^<]*/, "$199.9");
assert.equal(env("1", () => qaFor(tampered, rows)).viewports.desktop.value_labels.passed, false);
// a removed label fails the proof
const dropped = onSvg.replace(/<text data-role="heatmap-cell-value"[^>]*>[^<]*<\/text>/, "");
assert.equal(env("1", () => qaFor(dropped, rows)).viewports.desktop.value_labels.passed, false);
console.log("PASS heatmap value labels");
