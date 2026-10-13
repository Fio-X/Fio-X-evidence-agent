#!/usr/bin/env node
// K286: three renderer defects found in run12, each pinned offline.
//  D1  choropleth under a riso/pencil page style: the no-data regions keep the shared no-data fill (render QA: no_data_style_missing).
import assert from "node:assert/strict";
import { renderVizBundle, PALETTE } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID } from "../runtime/pi/choropleth.mjs";

process.env.NEWSROOM_RENDER_STYLES = "1";
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const choroSpec = {
  schema_version: "0.9.0", reader_task: "spatial", title: "Renewable energy consumption share", alt: "A choropleth map of renewable energy share across several African countries.",
  source_note: "World Bank fixture", claim_id: "claim-k286", sql: "SELECT country, v FROM fixture", unit: "%", chart_type: "choropleth", category_field: "country", value_field: "v",
  category_names: "worldbank", reference_period_field: "year", mixed_period_strategy: "acknowledge", basemap_id: basemap.id, basemap_source_url: basemap.source_url,
  basemap_license: basemap.license, basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [],
};
const choroRows = [["Chad", 70], ["Congo, Dem. Rep.", 96.3], ["Guinea", 66.6], ["Liberia", 92.8], ["Mauritania", 19.6], ["Niger", 79.6], ["Nigeria", 80.3], ["Zambia", 83]].map(([country, v]) => ({ country, year: 2022, v }));

const contextFills = (svg) => [...svg.matchAll(/<path data-role="choropleth-context"[^>]*fill="([^"]*)"/g)].map((m) => m[1].toLowerCase());
for (const style of ["riso", "pencil"]) {
  const bundle = renderVizBundle({ ...choroSpec, page_render_style: style }, choroRows);
  const fills = contextFills(bundle.desktop);
  assert.ok(fills.length > 0, `${style}: the map has no-data regions`);
  assert.deepEqual([...new Set(fills)], [PALETTE.grid.toLowerCase()], `${style}: no-data regions keep the shared no-data fill`);
  const qa = runRenderQa(bundle);
  assert.ok(!JSON.stringify(qa.viewports).includes("no_data_style_missing"), `${style}: render QA has no no_data_style_missing`);
}
console.log("ok: D1 no-data fill under riso/pencil");

//  D2  multi_line under the story forms without any wave field: every line-path carries data-series (render QA wave_line_missing).
const lineSpec = {
  schema_version: "0.9.0", reader_task: "change", title: "Deaths by drug class", takeaway: "Opioids fell the most.", alt: "Lines of deaths by class, 2020 to 2024.", source_note: "Source: fixture",
  claim_id: "claim-k286-line", sql: "SELECT year, cls, n FROM fixture", unit: "deaths", chart_type: "multi_line", x_field: "year", value_field: "n", series_field: "cls", highlight_values: ["opioid"], annotations: [],
};
const lineRows = ["opioid", "stimulant", "other"].flatMap((cls, i) => [2020, 2021, 2022, 2023, 2024].map((year, j) => ({ year, cls, n: 100 + i * 40 + (j * (3 - i) * 9) })));
process.env.NEWSROOM_STORY_FORMS = "1";
for (const [label, spec] of [["plain", lineSpec], ["riso", { ...lineSpec, page_render_style: "riso" }], ["riso+tone", { ...lineSpec, page_render_style: "riso", emphasis_tone: "coral" }]]) {
  const bundle = renderVizBundle(spec, lineRows);
  const tags = [...bundle.desktop.matchAll(/<(?:polyline|path) data-role="line-path"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tags.length, 3, `${label}: one line per series`);
  for (const t of tags) assert.match(t, /data-series="(opioid|stimulant|other)"/, `${label}: ${t.slice(0, 60)}`);
  const qa = runRenderQa(bundle, { spec, rows: lineRows });
  assert.ok(!JSON.stringify(qa).includes("wave_line_missing"), `${label}: no wave_line_missing`);
}
// off: the story forms are off, so the line is byte-identical to before (no data-series)
delete process.env.NEWSROOM_STORY_FORMS;
assert.ok(!renderVizBundle(lineSpec, lineRows).desktop.includes("data-series"), "story forms off: no data-series added");
console.log("ok: D2 line-path data-series");

//  D3  choropleth, top-60 hosts of a world map (run12 plan 5cc15b31, rows read back from the rejected render): a leader ended 0.04px outside the Ethiopia
//      label's box, the placer accepted it, and render QA read it as crossing "100.9 万人". NEWSROOM_CHORO_LEADER_CLEARANCE=1 keeps leaders 2px clear of accepted boxes.
const hostSpec = {"schema_version": "0.9.0", "reader_task": "spatial", "title": "收容最多的不是欧美", "subtitle": "收容难民最多的 60 个国家，2024 年底，单位：万人", "takeaway": "收容难民最多的是伊朗，348.9 万人。", "alt": "收容最多的不是欧美. 收容难民最多的是伊朗，348.9 万人。", "note": "其余国家收容人数较少，地图上不着色。", "source_note": "联合国难民署（UNHCR）难民数据查询平台，2024 年底", "unit": "万人", "value_field": "wan", "chart_type": "choropleth", "measure_kind": "count", "language": "zh", "sort": "none", "direct_labels": true, "mixed_period_strategy": "reject", "basemap_id": "naturalearth_admin0_50m", "basemap_source_url": "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/", "basemap_license": "Public domain (Natural Earth terms of use)", "basemap_content_hash": "fb05dfb0bc0312dc7d11edea2097011513a3065e228df9951e9ef7751f40996e", "claim_id": "claim-c53ba5372249425e", "category_field": "iso3", "category_names": "iso3", "highlight_values": ["IRN", "TUR", "DEU"], "annotations": [], "sql": "SELECT iso3, wan FROM fixture ORDER BY wan DESC LIMIT 60"};
const hostRows = [["IRN", 348.9], ["TUR", 294.1], ["DEU", 274.9], ["UGA", 175.9], ["PAK", 156.0], ["TCD", 127.9], ["POL", 100.9], ["ETH", 100.9], ["BGD", 100.6], ["SDN", 79.3], ["LBN", 75.9], ["FRA", 72.2], ["JOR", 64.4], ["KEN", 60.4], ["COD", 51.7], ["GBR", 51.6], ["SSD", 51.5], ["USA", 43.5], ["ESP", 42.9], ["CMR", 42.8], ["CZE", 39.1], ["NER", 37.0], ["IRQ", 31.8], ["ITA", 31.3], ["AUT", 28.5], ["CAN", 26.9], ["NLD", 26.3], ["BRA", 25.7], ["EGY", 23.8], ["IND", 23.7], ["LBY", 20.0], ["CHE", 19.6], ["ROU", 18.5], ["BEL", 18.4], ["DZA", 18.3], ["TZA", 17.7], ["SWE", 16.3], ["MRT", 15.5], ["MEX", 15.1], ["SVK", 14.4], ["ARM", 14.4], ["MYS", 13.8], ["MDA", 13.6], ["MLI", 13.6], ["IRL", 12.5], ["NOR", 12.4], ["GRC", 11.6], ["RWA", 11.4], ["BGR", 10.9], ["DNK", 9.8], ["NGA", 9.6], ["FIN", 9.3], ["BDI", 8.9], ["THA", 8.4], ["ZMB", 7.9], ["HUN", 7.2], ["ZAF", 7.1], ["PRT", 6.9], ["KAZ", 6.6], ["COG", 6.2]].map(([iso3, wan]) => ({ iso3, wan }));
const geometryFailures = (svgBundle) => runRenderQa(svgBundle).viewports.desktop.geometry.failures.map((f) => `${f.rule}: ${f.message}`);
delete process.env.NEWSROOM_CHORO_LEADER_CLEARANCE;
const hostOff = renderVizBundle(hostSpec, hostRows);
assert.ok(geometryFailures(hostOff).some((m) => /^leader_crosses_text: leader choropleth-leader#\d+ crosses text "100\.9/.test(m)), "pin: without the switch the run12 map still fails with the leader crossing the 100.9 label");
process.env.NEWSROOM_CHORO_LEADER_CLEARANCE = "2";
assert.equal(renderVizBundle(hostSpec, hostRows).desktop, hostOff.desktop, "only the exact value 1 turns the clearance on");
process.env.NEWSROOM_CHORO_LEADER_CLEARANCE = "1";
const hostOn = renderVizBundle(hostSpec, hostRows);
assert.deepEqual(geometryFailures(hostOn), [], "with the switch the same rows pass render QA's geometry check");
assert.equal((hostOn.desktop.match(/data-role="choropleth-label"/g) ?? []).length >= 20, true, "labels are still placed, none dropped to pass");
delete process.env.NEWSROOM_CHORO_LEADER_CLEARANCE;
console.log("ok: D3 leader clearance");

//  D4  sankey: a column that already holds an other-like node (其他国家) got a second "其他" from the 3% fold (run12 plan 79ad1fe6, five small hosts folded, no note).
//      NEWSROOM_SANKEY_ONE_OTHER=1: the render stops with SANKEY_SECOND_OTHER instead; a fold with no clash stays, names its members in the note; render QA counts other-like nodes.
const sankeySpec = { schema_version: "0.9.0", reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", complexity_budget: "medium", takeaway: "难民主要流向邻国", chart_type: "sankey", title: "难民去哪里", alt: "桑基图", source_note: "联合国难民署", claim_id: "claim-k286-sk", sql: "SELECT 1", unit: "万人", source_field: "source", target_field: "target", value_field: "value", note: "2024 年底。", language: "zh" };
const flowRows = (list) => list.map(([source, target, value]) => ({ source, target, value }));
const clashRows = flowRows([["难民", "伊朗", 348], ["难民", "土耳其", 300], ["难民", "德国", 250], ["难民", "其他国家", 514], ["难民", "南苏丹", 40], ["难民", "苏丹", 39], ["难民", "利比亚", 3], ["难民", "捷克", 4], ["难民", "埃塞俄比亚", 5]]);
const plainRows = flowRows([["难民", "伊朗", 348], ["难民", "土耳其", 300], ["难民", "德国", 250], ["难民", "南苏丹", 4], ["难民", "苏丹", 3], ["难民", "利比亚", 3]]);
const labelsOf = (svg) => [...svg.matchAll(/data-role="flow-node-label"[^>]*>([^<]*)</g)].map((m) => m[1]);
const extraFailures = (svg) => runRenderQa({ desktop: svg }).viewports.desktop.extra_checks?.sankey_one_other?.failures ?? [];
delete process.env.NEWSROOM_SANKEY_ONE_OTHER;
const clashOff = renderVizBundle(sankeySpec, clashRows).desktop;
assert.equal(labelsOf(clashOff).filter((l) => /^其他/.test(l)).length, 2, "pin: without the switch the clash draws two other-like nodes (其他国家 and a folded 其他)");
assert.deepEqual(extraFailures(clashOff), [], "QA check is off with the switch off");
process.env.NEWSROOM_SANKEY_ONE_OTHER = "2";
assert.equal(renderVizBundle(sankeySpec, clashRows).desktop, clashOff, "only the exact value 1 turns it on");
process.env.NEWSROOM_SANKEY_ONE_OTHER = "1";
assert.throws(() => renderVizBundle(sankeySpec, clashRows), /SANKEY_SECOND_OTHER.*其他国家.*南苏丹.*SQL/, "on: the clash stops with a message that names the existing node, the small nodes and SQL");
const foldOn = renderVizBundle(sankeySpec, plainRows).desktop;
assert.equal(labelsOf(foldOn).filter((l) => /^其他/.test(l)).length, 1, "on: a fold with no clash makes exactly one 其他");
assert.match(foldOn, /南苏丹、苏丹、利比亚|其他（[^）]*）：/, "on: the note names what was folded");
assert.deepEqual(extraFailures(foldOn), [], "QA: one other-like node passes");
const twoOthers = flowRows([["难民", "伊朗", 348], ["难民", "其他国家", 100], ["难民", "其他", 90], ["难民", "德国", 250]]);
delete process.env.NEWSROOM_SANKEY_ONE_OTHER;
const twoSvg = renderVizBundle(sankeySpec, twoOthers).desktop;
process.env.NEWSROOM_SANKEY_ONE_OTHER = "1";
assert.deepEqual(extraFailures(twoSvg).map((f) => f.rule), ["sankey_second_other_node"], "QA: two other-like nodes in the drawing fail");
delete process.env.NEWSROOM_SANKEY_ONE_OTHER;
console.log("ok: D4 sankey one other");
