#!/usr/bin/env node
// symbol_map (NEWSROOM_SYMBOL_MAP=1, default off): the area-proportional circle map. Pure rules (radius, minimum visible circle, overlap shrink, legend values,
// value lint, the radius check of render QA) and the render of a world map and a US state map. Off (unset, "0", "true", " 1") the chart type is unsupported.
import assert from "node:assert/strict";

const KEY = "NEWSROOM_SYMBOL_MAP";
const old = { symbol: process.env[KEY], us: process.env.NEWSROOM_US_STATES, world: process.env.NEWSROOM_MAP_WORLD };
process.env[KEY] = "1";
process.env.NEWSROOM_US_STATES = "1";
process.env.NEWSROOM_MAP_WORLD = "1";
const viz = await import("../runtime/pi/viz.mjs");
const ch = await import("../runtime/pi/choropleth.mjs");
const { getBasemap } = await import("../runtime/pi/basemap_registry.mjs");

// 1 the pure rules
assert.equal(ch.symbolRadius(100, 100, 50), 50);
assert.ok(Math.abs(ch.symbolRadius(25, 100, 50) - 25) < 1e-9, "a quarter of the value is half the radius (area proportional)");
assert.equal(ch.symbolRadius(0, 100, 50), 0);
assert.equal(ch.symbolRadius(-1, 100, 50), 0);
{
  const plan = ch.planSymbols([{ id: "A", value: 100, x: 0, y: 0 }, { id: "B", value: 0.1, x: 500, y: 0 }, { id: "Z", value: 0, x: 900, y: 0 }, { id: "C", value: 25, x: 250, y: 400 }], { rMax: 50 });
  assert.deepEqual(plan.circles.map((c) => c.id), ["A", "C", "B"], "largest first");
  assert.deepEqual(plan.zero.map((z) => z.id), ["Z"], "a zero value gets no circle but is listed");
  const b = plan.circles.find((c) => c.id === "B");
  assert.ok(b.min && b.drawR === ch.SYMBOL_MIN_RADIUS_PX && b.r < b.drawR, "a tiny value is drawn at the minimum size and keeps its true radius");
  assert.ok(!plan.circles.find((c) => c.id === "A").min);
  assert.equal(plan.shrinks, 0);
  assert.equal(plan.vMax, 100);
}
{
  const crowded = ch.planSymbols([{ id: "A", value: 100, x: 0, y: 0 }, { id: "B", value: 90, x: 10, y: 0 }], { rMax: 50 });
  assert.equal(crowded.shrinks, ch.SYMBOL_MAX_SHRINKS, "overlapping circles shrink rMax, at most twice");
  assert.ok(crowded.rMax < 50 && crowded.crowded.length === 1, "what still overlaps is reported");
  const apart = ch.planSymbols([{ id: "A", value: 100, x: 0, y: 0 }, { id: "B", value: 90, x: 500, y: 0 }], { rMax: 50 });
  assert.equal(apart.shrinks, 0);
}
assert.ok(ch.circleOverlapShare({ x: 0, y: 0, r: 10 }, { x: 100, y: 0, r: 10 }) === 0);
assert.ok(ch.circleOverlapShare({ x: 0, y: 0, r: 10 }, { x: 1, y: 0, r: 3 }) === 1);
assert.ok(Math.abs(ch.circleOverlapShare({ x: 0, y: 0, r: 10 }, { x: 10, y: 0, r: 10 }) - 0.391) < 0.01);
assert.deepEqual([1, 2, 5, 10, 20, 50, 70, 3100, 0.3].map(ch.niceFloor125), [1, 2, 5, 10, 20, 50, 50, 2000, 0.2]);
assert.equal(ch.niceFloor125(0), 0);
assert.deepEqual(ch.symbolLegendValues(32000), [20000, 10000, 2000]);
assert.deepEqual(ch.symbolLegendValues(1), [1, 0.5, 0.1]);
assert.deepEqual(ch.symbolLegendValues(0), []);

// 2 the value lint
const base = { chart_type: "symbol_map", category_field: "c", value_field: "v", measure_kind: "count" };
assert.deepEqual(ch.lintSymbolMap(base, [{ c: "A", v: 3 }, { c: "B", v: 0 }, { c: "C", v: null }]), { errors: [], warnings: [] });
assert.match(ch.lintSymbolMap(base, [{ c: "A", v: -3 }]).errors[0], /cannot draw negative values \(A\)/);
assert.match(ch.lintSymbolMap(base, [{ c: "A", v: "x" }]).errors[0], /non-finite values for: A/);
assert.match(ch.lintSymbolMap({ ...base, measure_kind: "rate" }, [{ c: "A", v: 3 }]).warnings[0], /choropleth/);
assert.equal(ch.lintSymbolMap({ ...base, measure_kind: "rate" }, [{ c: "A", v: 3 }]).errors.length, 0, "a rate drawn as circles is advised against, not refused");

// 3 the render: world map, US state map
const common = { schema_version: "0.9.0", takeaway: "t", subtitle: "synthetic", alt: "A synthetic symbol map.", source_note: "synthetic fixture", source: "synthetic", claim_id: "c1", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, language: "zh", verification_mode: "draft", reader_task: "spatial", chart_type: "symbol_map", category_field: "c", value_field: "v", measure_kind: "count" };
const world = { ...common, title: "World", unit: "PJ", category_names: "iso3", map_extent: "world", basemap_id: "naturalearth_admin0_50m", basemap_source_url: "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-countries/", basemap_license: "Public domain (Natural Earth terms of use)", basemap_content_hash: "fb05dfb0bc0312dc7d11edea2097011513a3065e228df9951e9ef7751f40996e" };
const worldRows = [["USA", 32000], ["RUS", 14000], ["CHN", 13000], ["DEU", 3100], ["BRA", 1300], ["AUS", 1600], ["NGA", 40], ["ISL", 0.3], ["ZAF", 0], ["JPN", null]].map(([c, v]) => ({ c, v }));
const bm = getBasemap(ch.CHOROPLETH_US_BASEMAP_ID);
const us = { ...common, title: "US", unit: "人", category_names: "us_state", basemap_id: ch.CHOROPLETH_US_BASEMAP_ID, basemap_source_url: bm.source_url, basemap_license: bm.license, basemap_content_hash: bm.content_hash };
const usRows = [["CA", 280000], ["TX", 230000], ["FL", 220000], ["NY", 150000], ["AK", 5000], ["HI", 12000], ["WY", 5200]].map(([c, v]) => ({ c, v }));
// the fixtures are synthetic: claim, zh-title and missing-value blockers belong to other rules
const symbolBlockers = (spec, rows) => viz.lintVizSpec(spec, rows).blockers.filter((b) => !/claim_id|CJK|non-numeric or missing/.test(b));
const render = (spec, rows) => viz.renderVizBundle(spec, rows, { mobilePages: false }).desktop;
const circles = (svg) => [...svg.matchAll(/<circle\b[^>]*data-role="symbol-circle"[^>]*>/g)].map((m) => ({ tag: m[0], iso3: /data-iso3="([^"]*)"/.exec(m[0])[1], value: Number(/data-value="([^"]*)"/.exec(m[0])[1]), r: Number(/data-r="([^"]*)"/.exec(m[0])[1]), min: / data-min-r="1"/.test(m[0]), drawR: Number(/ r="([^"]*)"/.exec(m[0])[1]) }));

for (const [name, spec, rows, minOnes] of [["world", world, worldRows, ["ISL", "NGA"]], ["us", us, usRows, []]]) {
  assert.deepEqual(symbolBlockers(spec, rows), [], `${name}: no symbol_map, basemap or name blocker`);
  const svg = render(spec, rows);
  const cs = circles(svg);
  const want = rows.filter((r) => r.v > 0).length;
  assert.equal(cs.length, want, `${name}: one circle per positive value (no circle for zero or no data)`);
  assert.deepEqual(cs.map((c) => c.value), [...cs.map((c) => c.value)].sort((a, b) => b - a), `${name}: drawn largest first, small circles on top`);
  const qa = ch.checkSymbolMapRadii(svg);
  assert.deepEqual(qa.failures, [], `${name}: radius check passes`);
  assert.equal(qa.count, want);
  const top = cs[0];
  for (const c of cs.filter((c) => !c.min)) assert.ok(Math.abs(c.r - top.r * Math.sqrt(c.value / top.value)) < 0.01, `${name}: ${c.iso3} area is proportional`);
  assert.deepEqual(cs.filter((c) => c.min).map((c) => c.iso3).sort(), [...minOnes].sort(), `${name}: only the tiny values are enlarged`);
  for (const c of cs.filter((c) => c.min)) assert.ok(c.drawR > c.r, `${name}: ${c.iso3} drawn larger than its true radius`);
  const legend = [...svg.matchAll(/data-role="symbol-legend-circle" data-value="([^"]*)" data-r="([^"]*)"/g)].map((m) => ({ v: Number(m[1]), r: Number(m[2]) }));
  assert.ok(legend.length >= 2, `${name}: nested legend circles`);
  const rMax = Number(/data-r-max="([^"]*)"/.exec(svg)[1]), vMax = Number(/data-v-max="([^"]*)"/.exec(svg)[1]);
  for (const l of legend) assert.ok(Math.abs(l.r - rMax * Math.sqrt(l.v / vMax)) < 0.01, `${name}: legend circle ${l.v} uses the map's own radius rule`);
  assert.match(svg, /圆的面积与数值成正比/, `${name}: legend title`);
  assert.equal(/data-role="symbol-legend-note"[^>]*>[^<]*小于最小可见/.test(svg), minOnes.length > 0, `${name}: the minimum-size note is there exactly when a circle was enlarged`);
  assert.equal(/data-role="symbol-legend-note"[^>]*>[^<]*无数据/.test(svg), rows.some((r) => r.v === null), `${name}: the no-data note`);
  assert.equal(/data-role="symbol-legend-note"[^>]*>[^<]*数值为 0/.test(svg), rows.some((r) => r.v === 0), `${name}: the zero note`);
  if (name === "us") assert.match(svg, /data-role="symbol-map-us-box"/, "us: Alaska and Hawaii boxes");
}

// 4 the radius check catches a tampered render
{
  const svg = render(world, worldRows);
  const linear = svg.replace(/(data-role="symbol-circle" data-iso3="DEU" data-value="3100" data-r=")[^"]*"/, '$1999"');
  assert.ok(ch.checkSymbolMapRadii(linear).failures.some((f) => f.rule === "symbol-circle-area" && f.iso3 === "DEU"));
  const noData = svg.replace(/(data-role="symbol-circle" data-iso3="[^"]*" data-value="[^"]*") data-r="[^"]*"/, "$1");
  assert.ok(ch.checkSymbolMapRadii(noData).failures.some((f) => f.rule === "symbol-circle-missing-data"));
  const notEnlarged = svg.replace(/(data-iso3="ISL"[^>]*data-draw-r=")[^"]*"/, '$10.000"');
  assert.ok(ch.checkSymbolMapRadii(notEnlarged).failures.some((f) => f.rule === "symbol-circle-min-not-enlarged"));
}

// 5 a negative value is a blocker through the real lint; a rate is only advised
assert.ok(viz.lintVizSpec(world, [{ c: "USA", v: -1 }, { c: "RUS", v: 2 }]).blockers.some((b) => /cannot draw negative/.test(b)));
assert.deepEqual(symbolBlockers({ ...world, measure_kind: "rate", unit: "%" }, worldRows), []);

// 6 off: unsupported
for (const value of [undefined, "0", "true", " 1", "1 ", "yes"]) {
  if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value;
  assert.ok(viz.lintVizSpec(world, worldRows).blockers.some((b) => /Unsupported chart_type 'symbol_map'/.test(b)), `off (${value}): unsupported`);
  assert.throws(() => render(world, worldRows), `off (${value}): the renderer refuses`);
}
for (const [k, v] of [[KEY, old.symbol], ["NEWSROOM_US_STATES", old.us], ["NEWSROOM_MAP_WORLD", old.world]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
console.log("test_symbol_map: ok");
