#!/usr/bin/env node
// K298: NEWSROOM_CHORO_LEDGER_SIZE=1 (exact "1", default off) draws the numbered list under a choropleth at 16px (the page body size) instead of 12.5px, reflowing it; pinned offline on the run12b LIMIT 60 plan.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

for (const k of ["RENDER_STYLES", "STORY_FORMS", "TILE_MAP", "UNIT_AWARE_LABELS", "US_STATES", "CHORO_LEADER_CLEARANCE", "UNIT_AWARE_LABELS"]) process.env[`NEWSROOM_${k}`] = "1";

const badgeSpec = {"schema_version": "0.9.0", "reader_task": "spatial", "title": "收容最多的不是欧美", "subtitle": "收容难民最多的 50 个国家，2024 年底，单位：万人", "takeaway": "收容难民最多的是伊朗，348.9 万人。", "alt": "收容最多的不是欧美. 收容难民最多的是伊朗，348.9 万人。", "note": "其余国家收容人数较少，地图上不着色。", "source_note": "联合国难民署（UNHCR）难民数据查询平台，2024 年底", "unit": "万人", "value_field": "wan", "chart_type": "choropleth", "measure_kind": "count", "language": "zh", "sort": "none", "direct_labels": true, "mixed_period_strategy": "reject", "basemap_id": "naturalearth_admin0_50m", "basemap_source_url": "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/", "basemap_license": "Public domain (Natural Earth terms of use)", "basemap_content_hash": "fb05dfb0bc0312dc7d11edea2097011513a3065e228df9951e9ef7751f40996e", "claim_id": "claim-97bd04b19a88a958", "page_render_style": "riso", "render_style": "riso", "category_field": "iso3", "category_names": "iso3", "highlight_values": ["IRN", "TUR", "DEU"], "annotations": []};
const ROWS60 = [["IRN", 348.9], ["TUR", 294.1], ["DEU", 274.9], ["UGA", 175.9], ["PAK", 156.0], ["TCD", 127.9], ["POL", 100.9], ["ETH", 100.9], ["BGD", 100.6], ["SDN", 79.3], ["LBN", 75.9], ["FRA", 72.2], ["JOR", 64.4], ["KEN", 60.4], ["COD", 51.7], ["GBR", 51.6], ["SSD", 51.5], ["USA", 43.5], ["ESP", 42.9], ["CMR", 42.8], ["CZE", 39.1], ["NER", 37.0], ["IRQ", 31.8], ["ITA", 31.3], ["AUT", 28.5], ["CAN", 26.9], ["NLD", 26.3], ["BRA", 25.7], ["EGY", 23.8], ["IND", 23.7], ["LBY", 20.0], ["CHE", 19.6], ["ROU", 18.5], ["BEL", 18.4], ["DZA", 18.3], ["TZA", 17.7], ["SWE", 16.3], ["MRT", 15.5], ["MEX", 15.1], ["SVK", 14.4], ["ARM", 14.4], ["MYS", 13.8], ["MDA", 13.6], ["MLI", 13.6], ["IRL", 12.5], ["NOR", 12.4], ["GRC", 11.6], ["RWA", 11.4], ["BGR", 10.9], ["DNK", 9.8], ["NGA", 9.6], ["FIN", 9.3], ["BDI", 8.9], ["THA", 8.4], ["ZMB", 7.9], ["HUN", 7.2], ["ZAF", 7.1], ["PRT", 6.9], ["KAZ", 6.6], ["COG", 6.2]];
const badgeRows = (list, limit) => list.map(([iso3, wan]) => ({ iso3, wan }));
const failuresOf = (bundle) => runRenderQa(bundle).viewports.desktop.geometry.failures.map((f) => `${f.rule}: ${f.message}`);
const heightOf = (bundle) => Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(bundle.desktop)[1]);
const sp60 = { ...badgeSpec, sql: "SELECT iso3, wan FROM fixture ORDER BY wan DESC LIMIT 60", subtitle: "收容难民最多的 60 个国家，2024 年底，单位：万人" };

const sizesOf = (bundle, role) => [...bundle.desktop.matchAll(new RegExp(`data-role="choropleth-footnote-${role}"[^>]*font-size="([\\d.]+)"`, "g"))].map((m) => Number(m[1]));
const count = (bundle) => (bundle.desktop.match(/data-role="choropleth-footnote-name"/g) || []).length;
const PAGE_SCALE = 1290 / 1040;
delete process.env.NEWSROOM_CHORO_LEDGER_SIZE;
const off = renderVizBundle(sp60, badgeRows(ROWS60));
assert.deepEqual(failuresOf(off), [], "pin: LIMIT 60 passes render QA today");
for (const role of ["name", "value", "number"]) assert.ok(sizesOf(off, role).length && sizesOf(off, role).every((s) => s === 12.5), `pin: list ${role} is 12.5px today`);
process.env.NEWSROOM_CHORO_LEDGER_SIZE = "2";
assert.equal(renderVizBundle(sp60, badgeRows(ROWS60)).desktop, off.desktop, "only the exact value 1 turns it on");
process.env.NEWSROOM_CHORO_LEDGER_SIZE = "1";
const on = renderVizBundle(sp60, badgeRows(ROWS60));
assert.deepEqual(failuresOf(on), [], "16px list still passes render QA (min-size and overlap checks run on it)");
for (const role of ["name", "value", "number"]) assert.ok(sizesOf(on, role).every((s) => s === 16), `on: list ${role} is 16px`);
assert.equal(count(on), count(off), "no list row is dropped");
assert.ok(heightOf(on) > heightOf(off), "the list grows the map; rows reflow instead of the text shrinking");
process.env.NEWSROOM_CHORO_LIST_COMPACT = "1"; process.env.NEWSROOM_CHORO_BADGE_CLEAR = "1";
const both = renderVizBundle(sp60, badgeRows(ROWS60));
assert.deepEqual(failuresOf(both), [], "ledger size + K289 switches pass QA together");
assert.equal(count(both), count(off), "no row dropped with the compact list");
for (const k of ["CHORO_LEDGER_SIZE", "CHORO_LIST_COMPACT", "CHORO_BADGE_CLEAR"]) delete process.env[`NEWSROOM_${k}`];
console.log(`ok: K298 ledger 16px; height off ${heightOf(off)} on ${heightOf(on)} compact+on ${heightOf(both)} (x${PAGE_SCALE.toFixed(3)} at page width)`);
