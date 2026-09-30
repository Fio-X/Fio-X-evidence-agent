#!/usr/bin/env node
// Renders every viz chart type (desktop + mobile) and every infographic module type,
// then parses all <text>/<tspan> elements from the emitted SVG - including font-size
// inherited from ancestor <text>/<g> elements and any CSS in a <style> block - and
// asserts every resolved font-size is at least 12px (house rule: no reader-visible
// text below 12px). Fails with the full list of offending chart type / element.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lintVizSpec, renderVizSvg, renderVizMobileSvg } from "../runtime/pi/viz.mjs";
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle } from "../runtime/pi/infographic.mjs";
import { BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL } from "../runtime/pi/cartography.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const FLOOR = 12;

// ---------------------------------------------------------------------------
// SVG font-size scanner: resolves the effective font-size of every <text> and
// <tspan> element, honoring (in cascade order, lowest to highest precedence):
//   1. default initial value (16, the CSS/SVG user-agent default)
//   2. inherited value from the nearest ancestor <text>/<g>/... element
//   3. a matching rule inside a <style> block (tag selector, then class selector)
//   4. an inline style="font-size:..." attribute
//   5. a direct font-size="..." attribute on the element itself
// ---------------------------------------------------------------------------
function parseCssRules(svg) {
  const rules = [];
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let sm;
  while ((sm = styleRe.exec(svg))) {
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let rm;
    while ((rm = ruleRe.exec(sm[1]))) {
      const body = rm[2];
      const fm = /font-size\s*:\s*([0-9.]+)/.exec(body);
      if (!fm) continue;
      const size = parseFloat(fm[1]);
      for (const sel of rm[1].split(",").map((s) => s.trim()).filter(Boolean)) rules.push({ selector: sel, size });
    }
  }
  return rules;
}

function matchCss(rules, tag, cls) {
  let matched = null;
  for (const rule of rules) if (rule.selector === tag || rule.selector === "*") matched = rule.size;
  for (const rule of rules) if (rule.selector.startsWith(".") && cls.includes(rule.selector.slice(1))) matched = rule.size;
  return matched;
}

function parseAttrs(tagBody) {
  const attrs = {};
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = attrRe.exec(tagBody))) attrs[m[1] ?? m[3]] = m[2] !== undefined ? m[2] : m[4];
  return attrs;
}

// Returns a list of { tag, size, snippet } for every <text>/<tspan> whose
// resolved font-size is below `floor`.
function findFontFloorOffenders(svg, floor = FLOOR) {
  const cssRules = parseCssRules(svg);
  const body = svg.replace(/<style[^>]*>[\s\S]*?<\/style>/g, (m) => " ".repeat(m.length));
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][a-zA-Z0-9_:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)\s*>/g;
  const stack = [16];
  const offenders = [];
  let scanned = 0;
  let m;
  while ((m = tagRe.exec(body))) {
    const isClose = m[1] === "/";
    const tag = m[2];
    if (isClose) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = parseAttrs(m[3] ?? "");
    const cls = (attrs.class ?? "").split(/\s+/).filter(Boolean);
    let own = null;
    if (attrs["font-size"] !== undefined && attrs["font-size"] !== "") {
      const v = parseFloat(attrs["font-size"]);
      if (!Number.isNaN(v)) own = v;
    }
    if (own === null && attrs.style) {
      const sm = /font-size\s*:\s*([0-9.]+)/.exec(attrs.style);
      if (sm) own = parseFloat(sm[1]);
    }
    if (own === null) {
      const cssSize = matchCss(cssRules, tag, cls);
      if (cssSize !== null && cssSize !== undefined) own = cssSize;
    }
    const resolved = own !== null ? own : stack[stack.length - 1];
    const isSelfClose = m[4] === "/";
    if (tag === "text" || tag === "tspan") {
      scanned += 1;
      if (resolved < floor) {
        const snippet = m[0].length > 160 ? `${m[0].slice(0, 160)}...` : m[0];
        offenders.push({ tag, size: resolved, snippet });
      }
    }
    if (!isSelfClose) stack.push(resolved);
  }
  return { offenders, scanned };
}

const allOffenders = [];
let totalScanned = 0;
function check(label, svg) {
  const { offenders, scanned } = findFontFloorOffenders(svg);
  totalScanned += scanned;
  for (const o of offenders) allOffenders.push(`${label}: <${o.tag}> font-size=${o.size} :: ${o.snippet}`);
}

// ---------------------------------------------------------------------------
// Chart fixtures - reused verbatim (same fields, same rows) from the existing
// suite: scripts/benchmark_viz.mjs, scripts/benchmark_complex_viz.mjs,
// scripts/benchmark_cartographic_flow_v15.mjs, scripts/benchmark_trajectory_v16.mjs
// and fixtures/spatial-explanatory/*.json (as consumed by
// scripts/test_spatial_explanatory_snapshots.mjs).
// ---------------------------------------------------------------------------
const claimId = "claim-font-floor";
const ctx = { verified_claim_ids: [claimId] };

const base = {
  schema_version: "0.7.0", reader_task: "comparison", takeaway: "Synthetic font-floor takeaway.",
  title: "Synthetic newsroom visualization font-floor fixture", subtitle: "In-memory lint and SVG rendering only",
  alt: "Synthetic chart used to check reader-visible text stays at or above the twelve pixel font floor.",
  source_note: "Synthetic font-floor fixture", claim_id: claimId, sql: "SELECT 1", unit: "%", sort: "desc",
  highlight_values: ["A"], direct_labels: true, annotations: [],
};
const categories = Array.from({ length: 16 }, (_, i) => ({ category: String.fromCharCode(65 + i), value: 20 + i * 3, start: 18 + i * 2, end: 23 + i * 3 }));
const timeRows = Array.from({ length: 24 }, (_, i) => ({ year: 2001 + i, value: 30 + i * 1.1 }));
const multiRows = ["A", "B", "C", "D"].flatMap((series, s) => Array.from({ length: 18 }, (_, i) => ({ year: 2007 + i, series, value: 20 + s * 8 + i * (1 + s * 0.12) })));
const facetRows = ["North", "South", "East", "West"].flatMap((facet, f) => Array.from({ length: 10 }, (_, i) => ({ facet, year: 2015 + i, value: 20 + f * 8 + i * 2 })));
const scatterRows = Array.from({ length: 80 }, (_, i) => ({ x: i + 1, y: 20 + i * 0.8 + (i % 5) * 2, label: `P${i + 1}` }));
const heatRows = ["A", "B", "C", "D", "E", "F"].flatMap((y, yi) => ["2019", "2020", "2021", "2022", "2023", "2024"].map((x, xi) => ({ x, y, value: 10 + yi * 7 + xi * 4 })));

const flowRows = [];
for (let i = 0; i < 6; i++) flowRows.push({ source: `Source ${i + 1}`, target: "Hub", value: 20 + i * 4 });
for (let i = 0; i < 10; i++) flowRows.push({ source: "Hub", target: `Sector ${i + 1}`, value: 8 + i });
const networkRows = [];
for (let i = 0; i < 28; i++) { networkRows.push({ source: `N${i}`, target: `N${(i + 3) % 28}`, value: 1 + (i % 5) }); networkRows.push({ source: `N${i}`, target: `N${(i + 7) % 28}`, value: 1 + (i % 3) }); }
const hierarchyRows = [{ node: "Root", parent: null }];
for (let i = 0; i < 5; i++) { hierarchyRows.push({ node: `L1-${i}`, parent: "Root" }); for (let j = 0; j < 5; j++) hierarchyRows.push({ node: `L2-${i}-${j}`, parent: `L1-${i}` }); }
const timelineRows = Array.from({ length: 28 }, (_, i) => ({ date: `202${Math.floor(i / 12) + 2}-${String((i % 12) + 1).padStart(2, "0")}-01`, event: `Milestone ${i + 1}` }));
const streamRows = ["A", "B", "C", "D", "E", "F"].flatMap((series, si) => Array.from({ length: 20 }, (_, i) => ({ year: 2005 + i, series, value: 10 + si * 4 + (i % 4) * 2 + i * (si % 2 ? 0.4 : 0.2) })));
const complexBase = { schema_version: "0.8.0", takeaway: "Complex font-floor benchmark", title: "Complex visual journalism font-floor fixture", alt: "Complex visual journalism fixture with topology-aware rendering used to check the font floor.", source_note: "Synthetic font-floor fixture", claim_id: claimId, sql: "SELECT * FROM synthetic", unit: "units", complexity_budget: "medium", annotations: [], highlight_values: [] };

const cases = [
  ["horizontal_bar", { ...base, reader_task: "ranking", chart_type: "horizontal_bar", category_field: "category", value_field: "value" }, categories],
  ["dot", { ...base, reader_task: "ranking", chart_type: "dot", category_field: "category", value_field: "value" }, categories],
  ["dumbbell", { ...base, chart_type: "dumbbell", category_field: "category", start_field: "start", end_field: "end" }, categories],
  ["slope", { ...base, chart_type: "slope", category_field: "category", start_field: "start", end_field: "end" }, categories.slice(0, 10)],
  ["line", { ...base, reader_task: "change", chart_type: "line", x_field: "year", value_field: "value" }, timeRows],
  ["multi_line", { ...base, reader_task: "change", chart_type: "multi_line", x_field: "year", value_field: "value", series_field: "series", highlight_values: ["A"] }, multiRows],
  ["small_multiples", { ...base, reader_task: "change", chart_type: "small_multiples", x_field: "year", value_field: "value", facet_field: "facet", panel_mark: "line" }, facetRows],
  ["scatter", { ...base, reader_task: "correlation", chart_type: "scatter", x_field: "x", y_field: "y", label_field: "label", x_unit: "index", y_unit: "%", unit: "%", highlight_values: ["P80"] }, scatterRows],
  ["diverging_bar", { ...base, chart_type: "diverging_bar", category_field: "category", value_field: "value" }, categories.map((r, i) => ({ ...r, value: i % 2 ? r.value : -r.value }))],
  ["heatmap", { ...base, reader_task: "distribution", chart_type: "heatmap", x_field: "x", y_field: "y", value_field: "value" }, heatRows],
  ["sankey", { ...complexBase, reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", chart_type: "sankey", source_field: "source", target_field: "target", value_field: "value" }, flowRows],
  ["alluvial", { ...complexBase, reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", chart_type: "alluvial", source_field: "source", target_field: "target", value_field: "value" }, flowRows],
  ["node_link", { ...complexBase, reader_task: "relationship", visual_family: "relationship", data_topology: "graph_edges", chart_type: "node_link", source_field: "source", target_field: "target", value_field: "value" }, networkRows],
  ["adjacency_matrix", { ...complexBase, reader_task: "relationship", visual_family: "relationship", data_topology: "graph_edges", chart_type: "adjacency_matrix", source_field: "source", target_field: "target", value_field: "value" }, networkRows],
  ["hierarchy_tree", { ...complexBase, reader_task: "hierarchy", visual_family: "hierarchy", data_topology: "hierarchy", chart_type: "hierarchy_tree", node_field: "node", parent_field: "parent" }, hierarchyRows],
  ["timeline", { ...complexBase, reader_task: "sequence", visual_family: "temporal", data_topology: "events", chart_type: "timeline", x_field: "date", label_field: "event" }, timelineRows],
  ["streamgraph", { ...complexBase, reader_task: "change", visual_family: "temporal", data_topology: "tabular", chart_type: "streamgraph", x_field: "year", series_field: "series", value_field: "value" }, streamRows],
];

for (const name of ["parallel-sets", "chord", "geo-flow-map", "process-schematic"]) {
  const fixture = JSON.parse(readFileSync(join(ROOT, "fixtures", "spatial-explanatory", `${name}.json`), "utf8"));
  cases.push([name.replace(/-/g, "_"), fixture.spec, fixture.rows]);
}

// cartographic_flow_map: real EIA origin-destination fixture (same file used by benchmark_cartographic_flow_v15.mjs)
function csv(path) {
  const [h, ...ls] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const fs = h.split(",");
  return ls.map((l) => { const vs = l.split(","); return Object.fromEntries(fs.map((f, i) => [f, /^-?\d+(\.\d+)?$/.test(vs[i]) ? Number(vs[i]) : vs[i]])); });
}
const cartoRows = csv(join(ROOT, "fixtures", "v09-realdata", "eia-us-crude-imports-2024.csv")).map((r) => ({ source: r.country, target: r.target, source_lat: r.source_lat, source_lon: r.source_lon, target_lat: r.target_lat, target_lon: r.target_lon, value: r.thousand_bpd }));
const cartoSpec = { schema_version: "1.0.0", chart_type: "cartographic_flow_map", reader_task: "flow", visual_family: "spatial", data_topology: "geo_edges", title: "Cartographic font-floor fixture", subtitle: "Six real EIA origin-destination relationships", alt: "Cartographic fixture with six real EIA origin-destination relationships used to check the font floor.", source_note: "EIA 2024 crude oil import fixture.", note: "Arcs encode relationships and do not show physical tanker or pipeline routes.", unit: "thousand b/d", claim_id: claimId, sql: "SELECT * FROM eia", value_field: "value", source_field: "source", target_field: "target", source_lat_field: "source_lat", source_lon_field: "source_lon", target_lat_field: "target_lat", target_lon_field: "target_lon", geometry_semantics: "abstract_od", geometry_crs: "EPSG:4326", projection: "natural_earth_1", basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, aggregation_policy: "none" };
cases.push(["cartographic_flow_map", cartoSpec, cartoRows]);

// trajectory_profile + a second, observed-trajectory cartographic_flow_map variant (same file used by benchmark_trajectory_v16.mjs)
const record = JSON.parse(readFileSync(join(ROOT, "fixtures", "v16-movement", "adsb-dal1812-sampled.json"), "utf8"));
const points = record.points;
const trajectoryMapSpec = { schema_version: "1.1.0", reader_task: "spatial", visual_family: "spatial", data_topology: "geo_edges", chart_type: "cartographic_flow_map", title: "Trajectory font-floor fixture", subtitle: "Observed path with a preserved gap", alt: "Font-floor fixture using an observed trajectory with a preserved source gap.", source_note: "xoolive/traffic readsb fixture.", note: "Observed geometry with source gap.", claim_id: claimId, sql: "fixture", unit: "trajectory", source_field: "source", target_field: "target", value_field: "value", geometry_semantics: "observed_trajectory", geometry_crs: "EPSG:4326", projection: "natural_earth_1", basemap_id: BASEMAP_ID, basemap_source_url: BASEMAP_SOURCE_URL, basemap_license: BASEMAP_LICENSE, basemap_content_hash: BASEMAP_CONTENT_HASH, route_provenance_note: "xoolive/traffic readsb public sample", trajectory_points_field: "trajectory_points", extent_mode: "data", extent_padding_ratio: 0.16, reference_path: "great_circle", locator_inset: true, aggregation_policy: "none", direct_labels: true, annotations: [] };
const trajectoryMapRows = [{ source: "Observed coverage begins", target: "MSP / ground", value: 1, trajectory_points: JSON.stringify(points) }];
cases.push(["cartographic_flow_map_observed_trajectory", trajectoryMapSpec, trajectoryMapRows]);
const profileRows = points.map((p) => ({ elapsed_min: p.elapsed_s / 60, altitude_ft: p.altitude_ft, ground_speed_kt: p.ground_speed_kt, segment: p.segment }));
const profileSpec = { schema_version: "1.1.0", reader_task: "change", visual_family: "temporal", data_topology: "tabular", chart_type: "trajectory_profile", title: "Profile font-floor fixture", subtitle: "Altitude and speed share elapsed time", alt: "Font-floor fixture showing a trajectory profile of altitude and speed.", source_note: "xoolive/traffic readsb public sample.", note: "Observed samples.", claim_id: claimId, sql: "fixture", unit: "trajectory state", x_field: "elapsed_min", altitude_field: "altitude_ft", speed_field: "ground_speed_kt", segment_field: "segment", altitude_unit: "ft", speed_unit: "kt", annotations: [] };
cases.push(["trajectory_profile", profileSpec, profileRows]);

console.log(`font floor: rendering ${cases.length} chart fixtures (desktop + mobile) via renderVizSvg/renderVizMobileSvg`);
for (const [name, spec, rows] of cases) {
  const caseCtx = { verified_claim_ids: [spec.claim_id ?? claimId] };
  const lint = lintVizSpec(spec, rows, caseCtx);
  assert.equal(lint.passed, true, `${name}: fixture must lint clean before it is used to check the font floor - ${lint.blockers.join(" | ")}`);
  const desktopSvg = renderVizSvg(spec, rows);
  const mobileSvg = renderVizMobileSvg(spec, rows);
  assert.ok(desktopSvg.includes("<svg"), `${name}: desktop render must produce an <svg> root`);
  assert.ok(mobileSvg.includes("<svg"), `${name}: mobile render must produce an <svg> root`);
  check(`${name} (desktop)`, desktopSvg);
  check(`${name} (mobile)`, mobileSvg);
}

// ---------------------------------------------------------------------------
// Infographic modules - reuses the exact bar/sankey spec, rows and asset shape
// from scripts/test_infographic.mjs, extended with pull_quote (as in
// scripts/test_magazine_realdata.mjs) and illustration so every one of the six
// INFOGRAPHIC_MODULE_TYPES (section_header, hero_stat, visual, illustration,
// text, pull_quote) is exercised at least once.
// ---------------------------------------------------------------------------
const barRows = [{ category: "A", value: 42 }, { category: "B", value: 31 }, { category: "C", value: 18 }, { category: "D", value: 9 }];
const barSpec = { schema_version: "0.9.0", reader_task: "ranking", takeaway: "A leads the selected categories.", chart_type: "horizontal_bar", title: "A leads this selected comparison", subtitle: "Synthetic font-floor fixture", alt: "Horizontal bars rank four synthetic categories from A at 42 to D at 9.", source_note: "Synthetic fixture", claim_id: claimId, sql: "SELECT * FROM synthetic_bar", unit: "units", category_field: "category", value_field: "value", sort: "desc", highlight_values: ["A"], annotations: [] };
const barLint = lintVizSpec(barSpec, barRows, ctx);
assert.equal(barLint.passed, true, barLint.blockers.join(" | "));
const barDesktop = renderVizSvg(barSpec, barRows);
const barMobile = renderVizMobileSvg(barSpec, barRows);

const flowSpec = { schema_version: "0.9.0", reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", complexity_budget: "medium", takeaway: "Three sources feed the system before energy reaches users and losses.", chart_type: "sankey", title: "Energy moves through one system", subtitle: "Synthetic font-floor fixture", alt: "A Sankey diagram shows solar, wind and gas feeding a system that supplies homes and industry while some energy is lost.", source_note: "Synthetic fixture", claim_id: claimId, sql: "SELECT * FROM synthetic_flow", unit: "PJ", source_field: "source", target_field: "target", value_field: "value", flow_conservation: "strict", flow_tolerance: 0.001, highlight_values: ["Losses"], annotations: [] };
const flowRowsIg = [{ source: "Solar", target: "System", value: 20 }, { source: "Wind", target: "System", value: 30 }, { source: "Gas", target: "System", value: 50 }, { source: "System", target: "Homes", value: 35 }, { source: "System", target: "Industry", value: 45 }, { source: "System", target: "Losses", value: 20 }];
const flowLint = lintVizSpec(flowSpec, flowRowsIg, ctx);
assert.equal(flowLint.passed, true, flowLint.blockers.join(" | "));
const flowDesktop = renderVizSvg(flowSpec, flowRowsIg);
const flowMobile = renderVizMobileSvg(flowSpec, flowRowsIg);

const igAssets = {
  "visualizations/bar.json": { desktopSvg: barDesktop, mobileSvg: barMobile, manifest: { claim_id: claimId, source_note: barSpec.source_note, chart_type: barSpec.chart_type, alt: barSpec.alt }, critic: { passed: true, score: 95 } },
  "visualizations/flow.json": { desktopSvg: flowDesktop, mobileSvg: flowMobile, manifest: { claim_id: claimId, source_note: flowSpec.source_note, chart_type: flowSpec.chart_type, alt: flowSpec.alt }, critic: { passed: true, score: 95 } },
};

const igSpec = {
  schema_version: "1.0.0", kicker: "SYSTEMS / DATA FEATURE", title: "A system is easier to understand when the parts share one page",
  dek: "This font-floor fixture combines verified numbers, explanatory copy and two upstream newsroom visuals into a single responsive editorial composition.",
  alt: "A magazine-style data feature with a large headline, a hero statistic, a ranking chart, a Sankey illustration, a pull quote and explanatory text.",
  byline: "Newsroom Agent", date_label: "Font-floor edition", layout: "feature", complexity_budget: "medium", source_note: "Synthetic infographic font-floor fixture",
  modules: [
    { id: "section-1", type: "section_header", span: "full", eyebrow: "The premise", heading: "Numbers gain meaning from hierarchy", deck: "The composer controls reading order while preserving upstream data provenance." },
    { id: "stat-total", type: "hero_stat", span: "third", tone: "accent", value: "100", unit: "PJ", label: "Total energy entering the synthetic system", detail: "Verified claim fixture", claim_id: claimId, label_short: "Total" },
    { id: "bar", type: "visual", span: "two_thirds", label: "The ranking", manifest_ref: "visualizations/bar.json" },
    { id: "flow-illustration", type: "illustration", span: "full", label: "How the system fits together", asset_ref: "visualizations/flow.json", alt: flowSpec.alt, credit: "Synthetic fixture schematic", claim_ids: [claimId] },
    { id: "quote-1", type: "pull_quote", span: "half", label: "Why it matters", text: "The system loses one fifth of its energy before it reaches any home or factory.", attribution: "Synthetic fixture calculation", claim_ids: [claimId] },
    { id: "text", type: "text", span: "two_thirds", label: "Why it matters", heading: "One feature, several reading speeds", body: "The headline provides the argument, the hero number rewards scanning, the chart supports comparison, and explanatory prose gives the reader enough context to interpret the structure without detaching the visuals from their verified claims.", claim_ids: [claimId] },
  ],
};
assert.deepEqual(validateInfographicSpec(igSpec), []);
const igLint = lintInfographicSpec(igSpec, igAssets, ctx);
assert.equal(igLint.passed, true, igLint.blockers.join(" | "));
const igBundle = composeInfographicBundle(igSpec, igAssets);
assert.ok(igBundle.desktop.svg.includes("<svg"), "infographic desktop render must produce an <svg> root");
assert.ok(igBundle.mobile.svg.includes("<svg"), "infographic mobile render must produce an <svg> root");
console.log("font floor: rendering 1 infographic bundle (all six module types) via composeInfographicBundle");
check("infographic (desktop)", igBundle.desktop.svg);
check("infographic (mobile)", igBundle.mobile.svg);

if (allOffenders.length) {
  console.error(`font floor: FAIL - ${allOffenders.length} element(s) below ${FLOOR}px across ${totalScanned} scanned:`);
  for (const line of allOffenders) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(`font floor: PASS - ${totalScanned} <text>/<tspan> elements scanned across ${cases.length} chart fixtures (desktop+mobile) and 1 infographic bundle (desktop+mobile), 0 below ${FLOOR}px`);
