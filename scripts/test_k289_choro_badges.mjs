#!/usr/bin/env node
// K289: choropleth numbered badges and the panel height of a map with a long list, each pinned offline on run12b plans.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

for (const k of ["RENDER_STYLES", "STORY_FORMS", "TILE_MAP", "UNIT_AWARE_LABELS", "US_STATES", "CHORO_LEADER_CLEARANCE", "UNIT_AWARE_LABELS"]) process.env[`NEWSROOM_${k}`] = "1";

//  K289 1  choropleth numbered badges: a badge (the number of a country too small to label) was placed on another highlighted country's outline (run12b plans LIMIT 50 / LIMIT 40;
//         rows read back from the rejected renders). NEWSROOM_CHORO_BADGE_CLEAR=1 keeps badges clear of highlight outlines. Whether a map passed depended on the row count.
const badgeSpec = {"schema_version": "0.9.0", "reader_task": "spatial", "title": "收容最多的不是欧美", "subtitle": "收容难民最多的 50 个国家，2024 年底，单位：万人", "takeaway": "收容难民最多的是伊朗，348.9 万人。", "alt": "收容最多的不是欧美. 收容难民最多的是伊朗，348.9 万人。", "note": "其余国家收容人数较少，地图上不着色。", "source_note": "联合国难民署（UNHCR）难民数据查询平台，2024 年底", "unit": "万人", "value_field": "wan", "chart_type": "choropleth", "measure_kind": "count", "language": "zh", "sort": "none", "direct_labels": true, "mixed_period_strategy": "reject", "basemap_id": "naturalearth_admin0_50m", "basemap_source_url": "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/", "basemap_license": "Public domain (Natural Earth terms of use)", "basemap_content_hash": "fb05dfb0bc0312dc7d11edea2097011513a3065e228df9951e9ef7751f40996e", "claim_id": "claim-97bd04b19a88a958", "page_render_style": "riso", "render_style": "riso", "category_field": "iso3", "category_names": "iso3", "highlight_values": ["IRN", "TUR", "DEU"], "annotations": []};
const badgeRows = (list, limit) => list.map(([iso3, wan]) => ({ iso3, wan }));
const ROWS50 = [["IRN", 348.9], ["TUR", 294.1], ["DEU", 274.9], ["UGA", 175.9], ["PAK", 156.0], ["TCD", 127.9], ["POL", 100.9], ["ETH", 100.9], ["BGD", 100.6], ["SDN", 79.3], ["LBN", 75.9], ["FRA", 72.2], ["JOR", 64.4], ["KEN", 60.4], ["COD", 51.7], ["GBR", 51.6], ["SSD", 51.5], ["USA", 43.5], ["ESP", 42.9], ["CMR", 42.8], ["CZE", 39.1], ["NER", 37.0], ["IRQ", 31.8], ["ITA", 31.3], ["AUT", 28.5], ["CAN", 26.9], ["NLD", 26.3], ["BRA", 25.7], ["EGY", 23.8], ["IND", 23.7], ["LBY", 20.0], ["CHE", 19.6], ["ROU", 18.5], ["BEL", 18.4], ["DZA", 18.3], ["TZA", 17.7], ["SWE", 16.3], ["MRT", 15.5], ["MEX", 15.1], ["SVK", 14.4], ["ARM", 14.4], ["MYS", 13.8], ["MDA", 13.6], ["MLI", 13.6], ["IRL", 12.5], ["NOR", 12.4], ["GRC", 11.6], ["RWA", 11.4], ["BGR", 10.9], ["DNK", 9.8]];
const ROWS40 = [["IRN", 348.9], ["TUR", 294.1], ["DEU", 274.9], ["UGA", 175.9], ["PAK", 156.0], ["TCD", 127.9], ["POL", 100.9], ["ETH", 100.9], ["BGD", 100.6], ["SDN", 79.3], ["LBN", 75.9], ["FRA", 72.2], ["JOR", 64.4], ["KEN", 60.4], ["COD", 51.7], ["GBR", 51.6], ["SSD", 51.5], ["USA", 43.5], ["ESP", 42.9], ["CMR", 42.8], ["CZE", 39.1], ["NER", 37.0], ["IRQ", 31.8], ["ITA", 31.3], ["AUT", 28.5], ["CAN", 26.9], ["NLD", 26.3], ["BRA", 25.7], ["EGY", 23.8], ["IND", 23.7], ["LBY", 20.0], ["CHE", 19.6], ["ROU", 18.5], ["BEL", 18.4], ["DZA", 18.3], ["TZA", 17.7], ["SWE", 16.3], ["MRT", 15.5], ["MEX", 15.1], ["ARM", 14.4]];
const failuresOf = (bundle) => runRenderQa(bundle).viewports.desktop.geometry.failures.map((f) => `${f.rule}: ${f.message}`);
for (const [label, list, limit] of [["LIMIT 50", ROWS50, 50], ["LIMIT 40", ROWS40, 40]]) {
  const sp = { ...badgeSpec, sql: `SELECT iso3, wan FROM fixture ORDER BY wan DESC LIMIT ${limit}`, subtitle: `收容难民最多的 ${limit} 个国家，2024 年底，单位：万人` };
  delete process.env.NEWSROOM_CHORO_BADGE_CLEAR;
  const off = renderVizBundle(sp, badgeRows(list));
  assert.ok(failuresOf(off).some((m) => /^text_crosses_data_mark: text "\d+"/.test(m)), `pin: ${label} without the switch fails with a badge on a data mark`);
  process.env.NEWSROOM_CHORO_BADGE_CLEAR = "2";
  assert.equal(renderVizBundle(sp, badgeRows(list)).desktop, off.desktop, "only the exact value 1 turns it on");
  process.env.NEWSROOM_CHORO_BADGE_CLEAR = "1";
  const on = renderVizBundle(sp, badgeRows(list));
  assert.deepEqual(failuresOf(on), [], `${label}: with the switch the badges clear every outline and QA passes`);
  delete process.env.NEWSROOM_CHORO_BADGE_CLEAR;
}

//  K289 2  map + numbered list height: LIMIT 60 passes QA but is 897 units tall on a 1040 wide map, 1113 px at page width (1290), over the 1100 panel cap. NEWSROOM_CHORO_LIST_COMPACT=1 puts the list in 8-row columns.
const ROWS60 = [["IRN", 348.9], ["TUR", 294.1], ["DEU", 274.9], ["UGA", 175.9], ["PAK", 156.0], ["TCD", 127.9], ["POL", 100.9], ["ETH", 100.9], ["BGD", 100.6], ["SDN", 79.3], ["LBN", 75.9], ["FRA", 72.2], ["JOR", 64.4], ["KEN", 60.4], ["COD", 51.7], ["GBR", 51.6], ["SSD", 51.5], ["USA", 43.5], ["ESP", 42.9], ["CMR", 42.8], ["CZE", 39.1], ["NER", 37.0], ["IRQ", 31.8], ["ITA", 31.3], ["AUT", 28.5], ["CAN", 26.9], ["NLD", 26.3], ["BRA", 25.7], ["EGY", 23.8], ["IND", 23.7], ["LBY", 20.0], ["CHE", 19.6], ["ROU", 18.5], ["BEL", 18.4], ["DZA", 18.3], ["TZA", 17.7], ["SWE", 16.3], ["MRT", 15.5], ["MEX", 15.1], ["SVK", 14.4], ["ARM", 14.4], ["MYS", 13.8], ["MDA", 13.6], ["MLI", 13.6], ["IRL", 12.5], ["NOR", 12.4], ["GRC", 11.6], ["RWA", 11.4], ["BGR", 10.9], ["DNK", 9.8], ["NGA", 9.6], ["FIN", 9.3], ["BDI", 8.9], ["THA", 8.4], ["ZMB", 7.9], ["HUN", 7.2], ["ZAF", 7.1], ["PRT", 6.9], ["KAZ", 6.6], ["COG", 6.2]];
const heightOf = (bundle) => Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(bundle.desktop)[1]);
const sp60 = { ...badgeSpec, sql: "SELECT iso3, wan FROM fixture ORDER BY wan DESC LIMIT 60", subtitle: "收容难民最多的 60 个国家，2024 年底，单位：万人" };
const PAGE_SCALE = 1290 / 1040, PANEL_CAP = 1100;
delete process.env.NEWSROOM_CHORO_LIST_COMPACT;
const tall = renderVizBundle(sp60, badgeRows(ROWS60));
assert.deepEqual(failuresOf(tall), [], "pin: LIMIT 60 passes render QA");
assert.ok(heightOf(tall) * PAGE_SCALE > PANEL_CAP, "pin: without the switch the map is over the panel cap at page width");
process.env.NEWSROOM_CHORO_LIST_COMPACT = "2";
assert.equal(renderVizBundle(sp60, badgeRows(ROWS60)).desktop, tall.desktop, "only the exact value 1 turns it on");
process.env.NEWSROOM_CHORO_LIST_COMPACT = "1";
const compact = renderVizBundle(sp60, badgeRows(ROWS60));
assert.deepEqual(failuresOf(compact), [], "compact list still passes render QA");
assert.ok(heightOf(compact) * PAGE_SCALE <= PANEL_CAP, `compact map fits the panel cap (${Math.round(heightOf(compact) * PAGE_SCALE)} px)`);
assert.equal((compact.desktop.match(/choropleth-footnote-name/g) || []).length, (tall.desktop.match(/choropleth-footnote-name/g) || []).length, "no list row is dropped");
delete process.env.NEWSROOM_CHORO_LIST_COMPACT;
process.env.NEWSROOM_CHORO_BADGE_CLEAR = "1";
process.env.NEWSROOM_CHORO_LIST_COMPACT = "1";
assert.deepEqual(failuresOf(renderVizBundle(sp60, badgeRows(ROWS60))), [], "LIMIT 60 passes with both switches");
delete process.env.NEWSROOM_CHORO_BADGE_CLEAR;
delete process.env.NEWSROOM_CHORO_LIST_COMPACT;
console.log("ok: K289 badges clear highlight outlines; compact list fits the panel");
