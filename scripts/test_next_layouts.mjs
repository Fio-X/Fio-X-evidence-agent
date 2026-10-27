#!/usr/bin/env node
// NEWSROOM_NEXT=1 page layouts (runtime/pi/next_layouts.mjs): both registered layouts compose a page from the page plan and its charts
// with every slot filled (big number, line drawing, charts, notes, sources); the numbers a layout draws itself are the plan's hero and the
// chart rows as formatted by viz.mjs; layout text keeps the 12px floor and no chart is drawn below its own width; the drawing is picked
// by topic words with a fallback. Offline: no network, no provider, no run directory.
// Usage: node scripts/test_next_layouts.mjs
import assert from "node:assert/strict";
import { chartValueFormatter } from "../runtime/pi/viz.mjs";
import { ILLUSTRATIONS, PAGE_LAYOUTS, layoutContent, pickIllustration, renderPageLayout, unfilledPlaceholders } from "../runtime/pi/next_layouts.mjs";
import { composeInfographicBundle, critiqueInfographic, validateInfographicSpec } from "../runtime/pi/infographic.mjs";
import { validatePublicationSpec } from "../runtime/pi/publication.mjs";

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
  // A sets the chart bodies as short notes; B's lettered notes are facts from the ledger rows, and the page's text modules go under the plate.
  if (layout.id === "magazine") assert.match(outside, /R12 最低/, `${layout.id}: short note slot`);
  else {
    assert.match(outside, /data-role="layout-fact"[^>]*>可再生能源占比最高：R1 60%/, "ledger: fact A from the top row");
    assert.match(outside, /data-role="layout-fact"[^>]*>可再生能源占比最低：R12 13.3%/, "ledger: fact B from the bottom row");
    assert.match(outside, /读图：颜色越深占比越高/, "ledger: text module under the plate");
    assert.doesNotMatch(outside, /R12 最低，为/, "ledger: a chart body is not drawn as a lettered note");
  }
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
// Each lettered fact on the plate letters its own ledger row too; with no ledger there are no facts, so nothing is lettered.
const ledgerSvg = renderPageLayout("ledger", content);
assert.equal((ledgerSvg.match(/data-role="layout-note-marker"/g) ?? []).length, 4, "two facts, each on the plate and on its ledger row");
assert.deepEqual(layoutContent(plan, visuals.map((v) => ({ ...v, rows: twoYears, spec: { ...spec, x_field: "year" } }))).facts, []);
assert.doesNotMatch(renderPageLayout("ledger", layoutContent(plan, visuals.map((v) => ({ ...v, rows: [] })))), /layout-note-marker/);
assert.throws(() => renderPageLayout("poster", content), /unknown page layout 'poster'/);
// The hero fits its column (magazine x 64 w 560, ledger x 964 w 412) by the layout's own textWidth less 8px: a unit that does not fit drops to
// its own line (wrapped when it is still too wide), a value too wide by itself is set smaller, and the label starts below the hero. A hero that fits stays on one line
// with the label at today's offset. The value and unit are drawn as given, never cut.
const wide = (ch) => /[⺀-￯]/.test(ch);
const measure = (text, size) => [...text].reduce((w, ch) => w + (wide(ch) ? size : size * 0.56), 0);
const unesc = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const column = { magazine: [64, 560, 56], ledger: [964, 412, 42] };
for (const [value, unit] of [["39941.8", "吉瓦时"], ["8.3", "吨二氧化碳当量/人"], ["12%", ""], ["123456789012", "欧元"], ["12345678901234567890", "元"], ["1.2", "百万吨石油当量（按最终能源消费口径计算）"], ["60", "%"]]) {
  for (const layout of PAGE_LAYOUTS) {
    const [x0, width, labelGap] = column[layout.id];
    const svg = renderPageLayout(layout.id, { ...content, hero: { value, unit, label: "标签" } });
    const tag = `${layout.id} ${value}${unit}`;
    const h = svg.match(/<text data-role="layout-hero-value" x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>([^<]*)(?:<tspan dx="6"[^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/tspan>)?<\/text>/);
    assert.ok(h, tag);
    const [x, y, size] = [Number(h[1]), Number(h[2]), Number(h[3])];
    assert.equal(x, x0, tag);
    assert.equal(unesc(h[4]), value, `${tag}: the value is drawn as given`);
    const unitLines = [...svg.matchAll(/<text data-role="layout-hero-unit" x="([\d.]+)" y="([\d.]+)" font-family="[^"]*" font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g)];
    const right = [x + measure(value, size) + (h[5] ? 6 + measure(unesc(h[6]), Number(h[5])) : 0),
      ...unitLines.map((m) => Number(m[1]) + measure(unesc(m[4]), Number(m[3])))];
    assert.ok(size >= 56, `${tag}: hero set at ${size}px, under the 56px floor`);
    if (size > 56) for (const r of right) assert.ok(r <= x0 + width - 8, `${tag}: hero box ends at ${r}, past the 8px slack before ${x0 + width}`);
    assert.equal((h[6] ? unesc(h[6]) : "") + unitLines.map((m) => unesc(m[4])).join(""), unit, `${tag}: the unit is drawn whole, once`);
    // Render QA's boxes, conservatively: the value reaches 0.25 of its size below its baseline, a unit line its whole size above.
    if (unitLines.length) assert.ok(Number(unitLines[0][2]) - Number(unitLines[0][3]) >= y + 0.25 * size, `${tag}: the unit's box clears the value's`);
    const bottom = Math.max(y, ...unitLines.map((m) => Number(m[2])));
    const label = Number(svg.match(new RegExp(`<text[^>]*x="${x0}" y="([\\d.]+)"[^>]*>标签</text>`))[1]);
    assert.ok(label >= bottom + labelGap, `${tag}: label at ${label} under the hero's bottom ${bottom}`);
    if (!unitLines.length && size === (layout.id === "magazine" ? 136 : 96)) assert.equal(label, y + labelGap, `${tag}: one-line hero, label at today's offset`);
  }
}
// The cases from the cell: q3's 39941.8 吉瓦时 in the ledger and 8.3 吨二氧化碳当量/人 in both layouts drop their unit; 60% and 12% stay on one line.
assert.match(renderPageLayout("ledger", { ...content, hero: { value: "39941.8", unit: "吉瓦时", label: "x" } }), /data-role="layout-hero-unit"[^>]*>吉瓦时</);
for (const layout of PAGE_LAYOUTS) {
  assert.match(renderPageLayout(layout.id, { ...content, hero: { value: "8.3", unit: "吨二氧化碳当量/人", label: "x" } }), /data-role="layout-hero-unit"/, layout.id);
  assert.doesNotMatch(renderPageLayout(layout.id, { ...content, hero: { value: "12%", unit: "", label: "x" } }), /layout-hero-unit/, layout.id);
}

assert.equal(pickIllustration(["欧盟货物贸易顺差"]).id, "trade");
assert.equal(pickIllustration(["温室气体排放"]).id, "emissions");
assert.equal(pickIllustration(["各国失业率"]).id, ILLUSTRATIONS.at(-1).id);
// The page pipeline: with the switch on, a desktop page of a big number, charts and text is composed in the sealed layout B, in
// composeOne's shape (module boxes, the visual's role, the sources footer), and the critic passes it; switch off, mobile, or a module
// type B does not draw keeps the old composer.
const pageSpec = { schema_version: "1.0.0", title: plan.title, dek: plan.dek, alt: "一张信息图：各国可再生能源占比的排名，R1 最高，R12 最低，附账本与读图说明。",
  modules: [{ ...plan.modules[0], claim_id: "c1" }, { ...plan.modules[1], manifest_ref: "visualizations/m1.json" }, { ...plan.modules[3], claim_ids: ["c1"] }] };
const pageAssets = { "visualizations/m1.json": { manifest: { chart_type: "horizontal_bar", source_note: "欧盟统计局 sdg_07_40，2025 年" }, desktopSvg: chart(1040, 700), nextChart: { spec, rows } } };
const saved = process.env.NEWSROOM_NEXT;
try {
  process.env.NEWSROOM_NEXT = "1";
  const page = composeInfographicBundle(pageSpec, pageAssets, { mobilePages: false }).desktop;
  assert.equal(page.layout_strategy, "ledger");
  assert.deepEqual(page.boxes.map((b) => b.id).sort(), ["hero1", "m1", "text1"]);
  assert.match(page.svg, /data-role="infographic-visual"/);
  assert.match(page.svg, /data-viewport="desktop" data-layout-strategy="ledger"/);
  assert.match(page.svg, /data-role="layout-fact"/);
  const critic = critiqueInfographic(pageSpec, { desktop: page });
  assert.deepEqual(critic.issues.filter((i) => i.severity === "blocker"), [], JSON.stringify(critic.issues));
  const withMap = { ...pageSpec, modules: [...pageSpec.modules, { id: "s1", type: "section_header", heading: "各国", claim_ids: ["c1"] }] };
  assert.notEqual(composeInfographicBundle(withMap, pageAssets, { mobilePages: false }).desktop.layout_strategy, "ledger");
  delete process.env.NEWSROOM_NEXT;
  assert.notEqual(composeInfographicBundle(pageSpec, pageAssets, { mobilePages: false }).desktop.layout_strategy, "ledger");
} finally {
  if (saved === undefined) delete process.env.NEWSROOM_NEXT; else process.env.NEWSROOM_NEXT = saved;
}
// A placeholder left in any page or publication text is named; value_from, a kept template and a JSON string are not page text.
assert.deepEqual(unfilledPlaceholders({ title: "t", modules: [{ id: "hero1", value_from: "{first.gap}", label_template: "{first.year}",
  field_mapping_json: "{\"value\":1}", title: "{first.country_iso2}的占比在{first.year}年最高", body: "瑞典最高" }] }),
  ["modules[0].title: {first.country_iso2}", "modules[0].title: {first.year}"]);
// With the switch on, both specs refuse it; off, neither check runs.
const leaked = (spec) => spec.modules.map((m, i) => (i ? m : { ...m, label: "{first.country_iso2}最高" }));
try {
  process.env.NEWSROOM_NEXT = "1";
  assert.ok(validateInfographicSpec({ ...pageSpec, modules: leaked(pageSpec) }).includes("unfilled placeholder in modules[0].label: {first.country_iso2}"));
  assert.ok(validatePublicationSpec({ title: "{first.year}", modules: [] }).includes("unfilled placeholder in title: {first.year}"));
  assert.ok(!validateInfographicSpec(pageSpec).some((e) => e.startsWith("unfilled placeholder")));
  delete process.env.NEWSROOM_NEXT;
  assert.ok(!validateInfographicSpec({ ...pageSpec, modules: leaked(pageSpec) }).some((e) => e.startsWith("unfilled placeholder")));
  assert.ok(!validatePublicationSpec({ title: "{first.year}", modules: [] }).some((e) => e.startsWith("unfilled placeholder")));
} finally {
  if (saved === undefined) delete process.env.NEWSROOM_NEXT; else process.env.NEWSROOM_NEXT = saved;
}
console.log("next_layouts: 2 layouts, slots, numbers from the plan and rows, 12px floor, chart widths, drawing pick, sealed page in the pipeline, no unfilled placeholder, hero fits its column: ok");
