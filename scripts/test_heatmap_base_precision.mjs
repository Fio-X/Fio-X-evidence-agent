#!/usr/bin/env node
// NEWSROOM_HEATMAP_TIDY=1, no explicit spec.decimals (the real chart path never carries it): the heatmap prints the shared
// formatter's BASE precision, without the collision raise that turned a 0.668-22.087 grid into three decimals.
// Off (unset, "0", "true", ""), the SVG is byte-identical; the V546 proof still passes on the same cell text.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const base = { schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "distribution", data_topology: "tabular", verification_mode: "draft", title: "各国人均排放", subtitle: "逐年", unit: "吨/人", x_field: "year", y_field: "country", value_field: "value", source: "测试", source_note: "测试", sql: "SELECT 1", alt: "热力图测试，十五个国家八个年份的人均排放。" };
const years = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022];
const grid = (f, n = 15) => Array.from({ length: n }, (_, i) => `国${i + 1}`).flatMap((c, i) => years.map((y, j) => ({ country: c, year: String(y), value: f(i, j) })));
const env = (vars, fn) => { const old = {}; for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } try { return fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
const render = (spec, rows) => renderVizBundle(spec, rows, { mobilePages: false }).desktop;
const cellTexts = (svg) => [...svg.matchAll(/data-role="heatmap-cell-value"[^>]*>([^<]*)</g)].map((m) => m[1]);
const ON = { NEWSROOM_HEATMAP_TIDY: "1", NEWSROOM_HEATMAP_VALUE_LABELS: "1" };

// case 2 shape: 15x8, 0.668..22.087 t/person -> one decimal, never three
const c2 = grid((i, j) => 0.668 + ((i * 8 + j) * 7919 % 120) / 120 * (22.087 - 0.668));
c2[0].value = 0.668; c2[1].value = 22.087;
const on = env(ON, () => render(base, c2));
const texts = cellTexts(on);
assert.equal(texts.length, 120);
for (const t of texts) assert.match(t, /^\d+\.\d$/, `one decimal: ${t}`);
// the V546 proof passes on the same text
const spec = { ...base };
const qa = env(ON, () => runRenderQa({ desktop: on }, { heatmap: { rows: c2, spec, x_field: "year", y_field: "country", value_field: "value" } }));
assert.equal(qa.viewports.desktop.value_labels.passed, true, JSON.stringify(qa.viewports.desktop.value_labels));

// a grid of shares (unit %) keeps one decimal; a grid of larger numbers prints none, small ones two
const shares = env(ON, () => cellTexts(render({ ...base, unit: "%" }, grid((i, j) => (i * 3 + j) % 60 + 0.37))));
for (const t of shares) assert.match(t, /^\d+\.\d$/);
const big = env(ON, () => cellTexts(render(base, grid((i, j) => 150 + i * 17 + j * 3.3))));
for (const t of big) assert.match(t, /^\d+$/, `no decimals at hundreds: ${t}`);
const small = env(ON, () => cellTexts(render(base, grid((i, j) => 1 + (i + j) * 0.123))));
for (const t of small) assert.match(t, /^\d+\.\d\d$/, `two decimals below ten: ${t}`);

// rule 5: a tiny non-zero value never prints as zero
const tiny = grid((i, j) => 5 + i + j); tiny[3].value = 0.0004;
const tinyTexts = env(ON, () => cellTexts(render(base, tiny)));
assert.ok(tinyTexts.every((t) => Number(t) !== 0), `a non-zero value prints as zero: ${tinyTexts.filter((t) => Number(t) === 0)}`);

// an explicit spec.decimals still wins; off is byte-identical
const explicit = env(ON, () => cellTexts(render({ ...base, decimals: 1 }, c2)));
for (const t of explicit) assert.match(t, /^\d+\.\d$/);
const off = env({ NEWSROOM_HEATMAP_TIDY: undefined, NEWSROOM_HEATMAP_VALUE_LABELS: undefined }, () => render(base, c2));
for (const v of ["0", "true", ""]) assert.equal(env({ NEWSROOM_HEATMAP_TIDY: v, NEWSROOM_HEATMAP_VALUE_LABELS: undefined }, () => render(base, c2)), off);
console.log("PASS heatmap base precision");
