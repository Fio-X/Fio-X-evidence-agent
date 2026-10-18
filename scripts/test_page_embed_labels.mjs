#!/usr/bin/env node
// #223: the page step re-embeds each chart (title cut, viewBox trim, id prefix, scale, variant choice), but the page-level render QA passes
// no per-chart options. This test runs the REAL page composition (composeInfographicBundle -> embedVisual -> trimmedSvgInfo) on a real chart of
// each type that has a per-chart render-QA check, cuts the embedded <svg data-role="infographic-visual"> out of the page, and asserts, for every
// chart type, slot span and variant the page can pick:
//   (1) the multiset of text nodes (<text>, <title>, <desc>) and of data-* name=value pairs equals the source variant it was embedded from;
//   (2) no estimated label box leaves the trimmed viewBox the page embeds (rule text_outside_viewbox of render_qa_geometry, run on the cut-out
//       as a standalone svg whose viewBox is the trimmed one).
// No browser is used. Proxy for (2): checkSvgGeometry's text box estimate (per-glyph advance tables, ascent/descent ratios), the one the
// product's own render QA uses on single charts and that its comments calibrate against Chrome; so a label judged inside here is judged
// inside by the same ruler that passed the single chart. Mutants (a temporary copy of runtime/ with trimmedSvgInfo or embedVisual changed) must go red.
// The six checks: choropleth, tile_map, heatmap, story_form, tick_readback (horizontal_bar, incl. the compact variant), allZero (all-zero bars).
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.NEWSROOM_TILE_MAP = "1";
process.env.NEWSROOM_STORY_FORMS = "1";
process.env.NEWSROOM_HEATMAP_VALUE_LABELS = "1";
for (const k of ["NEWSROOM_PAGE_POLISH", "NEWSROOM_EMBED_MIN_TEXT", "NEWSROOM_PAGE_TRIM_TEXT_SAFE"]) delete process.env[k];

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const load = async (root) => {
  const u = (f) => pathToFileURL(join(root, "runtime/pi", f)).href;
  return { viz: await import(u("viz.mjs")), info: await import(u("infographic.mjs")), geo: await import(u("render_qa_geometry.mjs")) };
};

// ---- fixtures: one real chart per check -------------------------------------------------------------------------------------------------------
const { usStates } = await import(pathToFileURL(join(ROOT, "runtime/pi/us_states.mjs")).href);
const { getBasemap } = await import(pathToFileURL(join(ROOT, "runtime/pi/basemap_registry.mjs")).href);
const { CHOROPLETH_BASEMAP_ID } = await import(pathToFileURL(join(ROOT, "runtime/pi/choropleth.mjs")).href);
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const claim = "claim-embed-labels";
const plain = { schema_version: "0.9.0", reader_task: "comparison", takeaway: "Synthetic embed fixture.", subtitle: "In-memory rendering only", source_note: "Synthetic fixture", claim_id: claim, sql: "SELECT 1", annotations: [] };

const africa = [["Chad", 2022, 70.0], ["Congo, Dem. Rep.", 2021, 96.3], ["Congo, Rep.", 2021, 71.4], ["Guinea", 2022, 66.6], ["Liberia", 2022, 92.8], ["Mauritania", 2022, 19.6], ["Niger", 2021, 79.6], ["Nigeria", 2021, 80.3], ["Sierra Leone", 2022, 71.6], ["South Sudan", 2021, 32.4], ["Zambia", 2021, 83.0]].map(([country, year, v]) => ({ country, year, renewable_energy_consumption_pct: v }));
const bars = Array.from({ length: 8 }, (_, i) => ({ category: String.fromCharCode(65 + i), value: 20 + i * 3 }));
const heatFuels = ["煤", "石油", "天然气", "水泥"];
const heatRows = Array.from({ length: 6 }, (_, i) => `国${i + 1}`).flatMap((c, i) => heatFuels.map((fu, j) => ({ country: c, fuel: fu, share: 10 + i * 3 + j * 1.5 })));
const tileRows = usStates().flatMap((s, i) => { const drop = -(5 + ((i * 7) % 40)); return [2021, 2022, 2023, 2024].map((y, j) => ({ state: s.usps, year: y, deaths: 10 + (i % 9) + (j === 1 ? 6 : j * -1), drop })); });

const charts = [
  { name: "choropleth", spans: ["full", "half"], rows: africa, spec: { ...plain, title: "Renewable energy consumption share", alt: "A choropleth map of renewable energy's share of final energy consumption across several African countries, darker meaning a higher share.", unit: "%", chart_type: "choropleth", category_field: "country", value_field: "renewable_energy_consumption_pct", category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "acknowledge", basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license, basemap_content_hash: basemap.content_hash, highlight_values: [] } },
  { name: "tile_map", spans: ["full", "half"], rows: tileRows, spec: { ...plain, language: "zh", chart_type: "tile_map", data_topology: "tabular", verification_mode: "draft", title: "各州药物过量死亡", alt: "美国各州药物过量死亡率的格子地图，每格一条逐年折线", unit: "每10万人", category_field: "state", x_field: "year", value_field: "deaths", color_field: "drop", color_unit: "%", color_label: "比峰值降了多少", color_dark: "low", highlight_values: ["WV"] } },
  { name: "heatmap", spans: ["full", "half"], rows: heatRows, spec: { ...plain, language: "zh", chart_type: "heatmap", data_topology: "tabular", verification_mode: "draft", title: "各国燃料占比", subtitle: "各来源占比", unit: "%", x_field: "fuel", y_field: "country", value_field: "share", decimals: 1, alt: "热力图测试，若干国家乘四种燃料的占比。" } },
  { name: "story_form", spans: ["full", "half"], rows: [{ label: "2025 年", per_day: 193.55 }], spec: { schema_version: "0.9.0", verification_mode: "draft", reader_task: "sequence", title: "美国的一天", chart_type: "clock_dial", clock_span: "day", language: "zh", category_field: "label", per_day_field: "per_day", value_field: "per_day", unit: "人", source_note: "合成数据", note: "按全年平均摊开，不是真实的时刻分布。", alt: "一天的钟面。", takeaway: "平均每天的人数。", sql: "SELECT 1", claim_id: claim } },
  { name: "tick_readback", spans: ["full", "half", "two_thirds"], expectCompact: "two_thirds", rows: bars, spec: { ...plain, reader_task: "ranking", title: "Synthetic bars", alt: "Synthetic horizontal bars used to check the chart embedded on a page.", unit: "%", sort: "desc", highlight_values: ["A"], direct_labels: true, chart_type: "horizontal_bar", category_field: "category", value_field: "value" } },
  { name: "allZero", spans: ["full", "two_thirds"], rows: bars.map((r) => ({ ...r, value: 0 })), spec: { ...plain, reader_task: "ranking", title: "Synthetic zero bars", alt: "Synthetic all-zero horizontal bars used to check the chart embedded on a page.", unit: "%", sort: "desc", highlight_values: [], direct_labels: true, chart_type: "horizontal_bar", category_field: "category", value_field: "value" } },
];

// The estimate is of the glyph ADVANCE box; a glyph's ink sits inside it by its side bearing. trimmedSvgInfo cuts at 0.65 em per glyph, so a wide capital
// ("H" is 0.76 em) in a right-anchored axis label overhangs the cut by 1.1 px ("H") to 1.8 px ("G") of advance box at 12 px. Measured in Chrome (headless, 4x raster of the
// source region vs the trimmed embed, bars with labels A..H, WWW/MMM/USA/OECD..., Mmm/Wwww...) that is 0 differing ink pixels, so the slack is 2.5 px:
// enough for a side bearing, far below any real cut (the mutants below move the edge by 40 px).
const ADVANCE_SLACK = 2.5;

// ---- extraction and the two assertions ------------------------------------------------------------------------------------------------------
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const strip = (s) => String(s).replace(/<[^>]*>/g, "");
function signature(inner) {
  const nodes = new Map(), data = new Map();
  for (const m of String(inner).matchAll(/<(text|title|desc)\b[^>]*>([\s\S]*?)<\/\1>/g)) bump(nodes, `${m[1]}:${strip(m[2])}`);
  for (const m of String(inner).matchAll(/\sdata-([\w-]+)=["']([^"']*)["']/g)) bump(data, `${m[1]}=${m[2]}`);
  return { nodes, data };
}
const diff = (a, b) => { const out = []; for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) out.push(`${k} source=${a.get(k) ?? 0} embedded=${b.get(k) ?? 0}`); return out; };
const sameSig = (a, b) => diff(a.nodes, b.nodes).length === 0 && diff(a.data, b.data).length === 0;

function pageFor(ref, span) {
  return {
    schema_version: "1.0.0", kicker: "TEST", title: "A page that embeds one chart", dek: "Embedded chart label fixture.",
    alt: "A page with one embedded chart and two text blocks, used to check that the embedded chart keeps its labels.", byline: "Newsroom Agent", date_label: "Test", layout: "feature", complexity_budget: "low", source_note: "Synthetic",
    modules: [
      { id: "v", type: "visual", span, label: "Chart", manifest_ref: ref },
      { id: "t0", type: "text", span: "third", label: "Note", heading: "A note", body: "A short block that fills the row beside the chart.", claim_ids: [claim] },
      { id: "t1", type: "text", span: "third", label: "Why", heading: "Why it matters", body: "A second short block that fills the row beside the chart.", claim_ids: [claim] },
    ],
  };
}

// Returns { rows: [one line per chart x span], violations: [text] } for a runtime tree (the real one, or a mutated copy).
async function check(root) {
  const { viz, info, geo } = await load(root);
  const report = [], violations = [];
  for (const c of charts) {
    const bundle = viz.renderVizBundle(c.spec, c.rows, { compact: true });
    const variants = { desktop: bundle.desktop, mobile: bundle.mobile, compact: bundle.compact };
    const asset = { desktopSvg: bundle.desktop, mobileSvg: bundle.mobile ?? bundle.desktop, ...(bundle.compact ? { compactSvg: bundle.compact } : {}), manifest: { claim_id: claim, chart_type: c.spec.chart_type }, critic: { passed: true, score: 90 } };
    const sigs = Object.entries(variants).filter(([, svg]) => typeof svg === "string").map(([name, svg]) => [name, signature(info.svgInfo(svg).inner)]);
    for (const [name, svg] of Object.entries(variants)) if (typeof svg === "string") assert.ok(!/<svg\b/i.test(info.svgInfo(svg).inner), `${c.name}/${name}: a chart with its own nested <svg> cannot be cut out by this test`);
    for (const span of c.spans) {
      const ref = `visualizations/${c.name}.json`, tag = `${c.name}@${span}`;
      const page = info.composeInfographicBundle(pageFor(ref, span), { [ref]: asset }, { mobilePages: false });
      const svg = page.desktop.svg;
      const start = svg.search(/<svg data-role="infographic-visual" data-module-id="v"/);
      assert.ok(start >= 0, `${tag}: the page has no embedded chart`);
      const open = svg.slice(start).match(/^<svg [^>]*>/)[0];
      const viewBox = open.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
      const inner = svg.slice(start + open.length, svg.indexOf("</svg>", start + open.length));
      // (1) the embedded content is one of the source variants, by text nodes and data-* values
      const embedded = signature(inner);
      // Text and data-* are identical across a chart's variants, so the variant is told by the trimmed viewBox the page cut for it.
      const sameBox = (name) => { const t = info.trimmedSvgInfo(variants[name]); return [t.minX, t.minY, t.width, t.height].join(" ") === viewBox.join(" "); };
      const matched = sigs.filter(([n, s]) => sameSig(s, embedded) && sameBox(n)).map(([n]) => n);
      if (!sigs.some(([, s]) => sameSig(s, embedded))) {
        const [bestName, best] = sigs.map(([n, s]) => [n, [...diff(s.nodes, embedded.nodes), ...diff(s.data, embedded.data)]]).sort((a, b) => a[1].length - b[1].length)[0];
        violations.push(`${tag}: embedded text nodes / data-* values equal no source variant (closest ${bestName}: ${best.slice(0, 3).join("; ")}${best.length > 3 ? ` ... ${best.length} differences` : ""})`);
      }
      if (!matched.length) violations.push(`${tag}: the embedded viewBox [${viewBox.join(" ")}] is the trimmed viewBox of no source variant`);
      if (c.expectCompact === span && !matched.includes("compact")) violations.push(`${tag}: the slot is meant to pick the compact variant, matched ${matched.join(",") || "none"}`);
      // (2) every estimated label box lies inside the trimmed viewBox the page embeds
      const standalone = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(" ")}" width="${viewBox[2]}" height="${viewBox[3]}">${inner}</svg>`;
      const result = geo.checkSvgGeometry(standalone, { viewboxTolerance: ADVANCE_SLACK });
      const outside = result.failures.filter((f) => f.rule === "text_outside_viewbox");
      if (result.summary.texts_checked === 0) violations.push(`${tag}: no label could be measured, the check would pass for nothing`);
      for (const f of outside) violations.push(`${tag}: label outside the trimmed viewBox [${viewBox.join(" ")}]: ${JSON.stringify(f).slice(0, 200)}`);
      report.push(`${tag.padEnd(26)} variant=${(matched.join("/") || "none").padEnd(8)} viewBox=[${viewBox.join(" ")}] texts=${result.summary.texts_checked} unmeasured=${result.summary.texts_unmeasured} outside=${outside.length}`);
    }
  }
  return { report, violations };
}

// ---- the real code path must be clean ----------------------------------------------------------------------------------------------------------
const real = await check(ROOT);
console.log(real.report.join("\n"));
assert.deepEqual(real.violations, [], `labels or values changed on the page:\n${real.violations.join("\n")}`);
const compactRow = real.report.find((l) => l.startsWith("tick_readback@two_thirds"));
assert.match(compactRow, /variant=compact/, "the compact variant was exercised");

// ---- mutants: a copy of runtime/ with one page-step change each must turn the check red --------------------------------------------------------
const mutants = [
  ["bottom trim one extra margin", "bottom + CHART_INK_PAD - info.minY", "bottom + CHART_INK_PAD - info.minY - 40"],
  ["left trim one extra margin", "Math.floor(left - info.minX)", "Math.floor(left - info.minX) + 40"],
  ["an embedded text is changed", "const inner = namespaceSvgInner(info.inner, `embed-", "const inner = namespaceSvgInner(String(info.inner).replace(/<text\\b/, '<text data-extra=\"1\" '), `embed-"],
];
for (const [name, from, to] of mutants) {
  const dir = mkdtempSync(join(tmpdir(), "embed-labels-mutant-"));
  try {
    cpSync(join(ROOT, "runtime"), join(dir, "runtime"), { recursive: true });
    cpSync(join(ROOT, "config"), join(dir, "config"), { recursive: true });
    const file = join(dir, "runtime/pi/infographic.mjs");
    const source = readFileSync(file, "utf8");
    assert.equal(source.split(from).length - 1, 1, `mutant "${name}": the target text must occur exactly once`);
    writeFileSync(file, source.replace(from, () => to));
    const result = await check(dir);
    assert.ok(result.violations.length > 0, `mutant "${name}" stayed green`);
    console.log(`mutant red: ${name} (${result.violations.length} violations, first: ${result.violations[0].slice(0, 120)})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log("test_page_embed_labels: ok");
