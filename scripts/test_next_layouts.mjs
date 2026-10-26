#!/usr/bin/env node
// NEWSROOM_NEXT=1 page layouts (runtime/pi/next_layouts.mjs): both registered layouts compose a page from the page plan and its charts
// with every slot filled (big number, line drawing, charts, notes, sources); the numbers a layout draws itself are the plan's hero and the
// chart rows as formatted by viz.mjs; layout text keeps the 12px floor and no chart is drawn below its own width; the drawing is picked
// by topic words with a fallback. Offline: no network, no provider, no run directory.
// Usage: node scripts/test_next_layouts.mjs
import assert from "node:assert/strict";
import { chartValueFormatter } from "../runtime/pi/viz.mjs";
import { ILLUSTRATIONS, PAGE_LAYOUTS, layoutContent, pickIllustration, renderPageLayout } from "../runtime/pi/next_layouts.mjs";

const rows = Array.from({ length: 12 }, (_, i) => ({ name: `R${i + 1}`, value: Math.round((60 - i * 4.25) * 10) / 10 }));
const spec = { category_field: "name", value_field: "value", unit: "%", measure_semantics: [{ phenomenon: "可再生能源占比" }] };
const chart = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img"><defs><clipPath id="c"><rect width="9" height="9"/></clipPath></defs><rect clip-path="url(#c)" width="${w}" height="${h}" fill="#eee"/><text font-size="12">x</text></svg>`;
const plan = { title: "哪国可再生能源占比最高", dek: "各国对比", modules: [
  { id: "hero1", type: "hero_stat", value: "60", unit: "%", label: "R1 最高。" },
  { id: "m1", type: "visual", body: "R1 has the highest value." },
  { id: "m2", type: "visual", body: "R12 最低，为 13.3。" },
  { id: "text1", type: "text", body: "读图：颜色越深占比越高。" }] };
const visuals = [["m1", 1040, 778], ["m2", 1040, 900]].map(([id, w, h]) => ({ module: plan.modules.find((m) => m.id === id), spec, rows,
  manifest: { source_note: "欧盟统计局 sdg_07_40，2025 年" }, svg: chart(w, h) }));
const content = layoutContent(plan, visuals);

assert.deepEqual(PAGE_LAYOUTS.map((l) => l.id), ["magazine", "ledger"]);
assert.equal(content.illustration.id, "energy");
// The ledger is the lead chart's top five and bottom three rows, highest first, with one break between them.
assert.deepEqual(content.ledger.map((r) => r && r.rank), [1, 2, 3, 4, 5, null, 10, 11, 12]);
const format = chartValueFormatter(spec, rows.map((r) => r.value));
for (const row of content.ledger.filter(Boolean)) assert.equal(row.value, format(rows[row.rank - 1].value));
// A float-noise row prints at the chart's own decimals, not at its longest string.
const noisy = layoutContent(plan, visuals.map((v) => ({ ...v, rows: rows.map((r, i) => (i ? r : { ...r, value: 60.300000000000004 })) })));
assert.equal(noisy.ledger[0].value, chartValueFormatter(spec, [60.300000000000004, ...rows.slice(1).map((r) => r.value)])(60.300000000000004));
assert.doesNotMatch(noisy.ledger[0].value, /0000/);
// Rows over more than one period or series, or naming a category twice, get no ledger column.
const twoYears = rows.flatMap((r) => [{ ...r, year: 2023 }, { ...r, year: 2024 }]);
for (const extra of [{ x_field: "year" }, { reference_period_field: "year" }, { series_field: "year" }, {}])
  assert.deepEqual(layoutContent(plan, visuals.map((v) => ({ ...v, spec: { ...spec, ...extra }, rows: twoYears }))).ledger, [], JSON.stringify(extra));

for (const layout of PAGE_LAYOUTS) {
  const svg = renderPageLayout(layout.id, content);
  const outside = svg.replace(/<svg data-role="layout-chart"[\s\S]*?<\/svg>/g, "");
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 1440 \d+"/, layout.id);
  assert.match(outside, /data-role="layout-hero-value"[^>]*>60<tspan[^>]*>%<\/tspan><\/text>/, `${layout.id}: hero value from the plan`);
  assert.match(outside, /data-role="layout-illustration" data-illustration="energy"/, `${layout.id}: drawing slot`);
  assert.match(outside, /示意，不表示数据/, `${layout.id}: the drawing is marked as not data`);
  assert.match(outside, /R12 最低/, `${layout.id}: short note slot`);
  assert.match(outside, /data-role="layout-source"[^>]*>欧盟统计局 sdg_07_40，2025 年</, `${layout.id}: sources`);
  assert.doesNotMatch(outside, /has the highest/, `${layout.id}: an English body is not drawn as a note`);
  const embeds = [...svg.matchAll(/<svg data-role="layout-chart" data-module="([^"]+)" x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="[\d.]+" viewBox="0 0 (\d+) \d+">/g)];
  assert.deepEqual(embeds.map((m) => m[1]), ["m1", "m2"], `${layout.id}: both charts placed`);
  for (const [, id, w, own] of embeds) assert.ok(Number(w) >= Number(own), `${layout.id}: ${id} drawn at ${w} under its own width ${own}`);
  for (const m of outside.matchAll(/font-size="([\d.]+)"/g)) assert.ok(Number(m[1]) >= 12, `${layout.id}: layout text at ${m[1]}px`);
  // Each embedded chart's ids are prefixed, so two charts' clips cannot collide on one page.
  assert.match(svg, /id="m1-c"/); assert.match(svg, /url\(#m2-c\)/); assert.doesNotMatch(svg, /id="c"/);
}
// A module id with no ASCII still gets a distinct id prefix; a page with no source line draws no empty source footer.
const zh = layoutContent({ ...plan, modules: plan.modules.map((m) => (m.type === "visual" ? { ...m, id: m.id === "m1" ? "地图" : "条形" } : m)) },
  visuals.map((v, i) => ({ ...v, module: { ...v.module, id: i ? "条形" : "地图" }, manifest: {} })));
for (const layout of PAGE_LAYOUTS) {
  const svg = renderPageLayout(layout.id, zh);
  assert.match(svg, /id="chart0-c"/); assert.match(svg, /id="chart1-c"/); assert.doesNotMatch(svg, /id="-/);
  assert.doesNotMatch(svg, /资料来源/, `${layout.id}: no empty source footer`);
}
// B's note markers are lettered squares, never the charts' round numbered data markers.
assert.match(renderPageLayout("ledger", content), /data-role="layout-note-marker"[^>]*\/><text[^>]*>A<\/text>/);
assert.throws(() => renderPageLayout("poster", content), /unknown page layout 'poster'/);

assert.equal(pickIllustration(["欧盟货物贸易顺差"]).id, "trade");
assert.equal(pickIllustration(["温室气体排放"]).id, "emissions");
assert.equal(pickIllustration(["各国失业率"]).id, ILLUSTRATIONS.at(-1).id);
console.log("next_layouts: 2 layouts, slots, numbers from the plan and rows, 12px floor, chart widths, drawing pick: ok");
