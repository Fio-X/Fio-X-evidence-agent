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
  // a missing circle must not read as zero: the note counts the base regions that have no row (from the join, not from the model)
  const noRowNote = /data-role="symbol-legend-note"[^>]*>(\d+) 个地区没有数据行，未显示/.exec(svg);
  assert.ok(noRowNote, `${name}: a sparse map says how many regions have no data row`);
  if (name === "us") assert.equal(Number(noRowNote[1]), 51 - rows.length, "us: 51 states and DC minus the rows given");
  else assert.ok(Number(noRowNote[1]) > 100, "world: most countries have no row");
  // legend numbers use the project's 万/亿 formatter, not raw integers
  const legendTexts = [...svg.matchAll(/data-role="symbol-legend-value"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(legendTexts, name === "us" ? ["20万人", "10万人", "2万人"] : ["2万 PJ", "1万 PJ", "0.2万 PJ"], `${name}: legend values`);
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

// 4b render QA runs the radius proof on a symbol map and fails a tampered one
{
  const { runRenderQa } = await import("../runtime/pi/render_qa.mjs");
  const svg = render(world, worldRows);
  const good = runRenderQa({ desktop: svg });
  assert.equal(good.viewports.desktop.extra_checks.symbol_map_radii.passed, true, "render QA: radii proof present and passing");
  const bad = runRenderQa({ desktop: svg.replace(/(data-role="symbol-circle" data-iso3="DEU" data-value="3100" data-r=")[^"]*"/, '$1999"') });
  assert.equal(bad.viewports.desktop.passed, false, "render QA: a circle whose radius breaks the area rule fails the viewport");
  assert.ok(bad.viewports.desktop.extra_checks.symbol_map_radii.failures.some((f) => f.rule === "symbol-circle-area"));
}

// 4c the K958 forest rows (net change per region and period, with negatives) are refused: a circle cannot show a decrease
{
  const forestRows = [["Africa", -327.8], ["Asia", 118.4], ["Europe", 20.6], ["South America", -413.2]].map(([c, v]) => ({ c, v }));
  const lint = ch.lintSymbolMap({ ...base, measure_kind: "stock" }, forestRows);
  assert.equal(lint.errors.length, 1);
  assert.match(lint.errors[0], /cannot draw negative values \(Africa, South America\)/);
  assert.ok(symbolBlockers({ ...world, category_names: "iso3" }, [{ c: "BRA", v: -413.2 }, { c: "CHN", v: 118.4 }]).some((b) => /negative/.test(b)), "through the lint a signed series blocks the symbol map");
}

// 4d the extent rule (Projection Wizard extent classes): box share of the globe >= 2/3 world, 1/6 to 2/3 crop of the world projection, below 1/6 a fitted region
assert.ok(Math.abs(ch.symbolBoxShare([[-135, -90], [-45, 0], [45, 0], [135, 90]]) - 0.75) < 1e-9 && Math.abs(ch.symbolBoxShare([[-180, 0], [0, 90]]) - 0.25) < 1e-9);
assert.equal(ch.symbolMapFrameMode([[-135, -90], [-45, 0], [45, 0], [135, 90]]), "world");
assert.equal(ch.symbolMapFrameMode([[-125, 25], [30, 71]]), "region", "Europe plus the US: 11% of the globe");
assert.equal(ch.symbolMapFrameMode([[-125, -35], [20, 0], [150, 70]]), "crop", "Americas to East Asia: between a sixth and two thirds");
assert.equal(ch.symbolMapFrameMode([[170, 0], [-170, 10]]), "region", "across the antimeridian the span is 20 degrees, not 340");
assert.equal(ch.symbolMapFrameMode([[10, 10]]), "region");
const frameOf = (svg) => /data-role="symbol-map-frame" data-frame="(\w+)"/.exec(svg)?.[1];
{
  const auto = { ...world, map_extent: undefined };
  const gasRows = [["NOR", 1155685], ["NLD", 688146], ["BEL", 581787], ["USA", 214133], ["FRA", 32885]].map(([c, v]) => ({ c, v }));
  assert.deepEqual(symbolBlockers(auto, gasRows), [], "no map_extent is accepted for a few regions");
  const gas = render(auto, gasRows);
  assert.equal(frameOf(gas), "crop", "Europe plus the US (Alaska and Hawaii included): the world projection cropped to the box");
  const eu = render(auto, ["DEU", "FRA", "ITA", "ESP", "POL"].map((c, j) => ({ c, v: 100 - j })));
  assert.equal(frameOf(eu), "region", "a few European countries: a fitted regional projection");
  assert.deepEqual(ch.checkSymbolMapRadii(eu).failures, []);
  assert.deepEqual(ch.checkSymbolMapRadii(gas).failures, [], "no circle is clipped by the fitted frame");
  const crop = render(auto, ["USA", "AUS", "BRA", "CHN", "ZAF"].map((c, i) => ({ c, v: 100 - i })));
  assert.ok(["crop", "world"].includes(frameOf(crop)), "regions spread over the globe use the world projection");
  const spread = render(auto, ["USA", "AUS", "BRA", "CHN", "ZAF", "RUS", "ARG", "NZL", "CAN"].map((c, i) => ({ c, v: 100 - i })));
  assert.equal(frameOf(spread), "world", "a box of two thirds of the globe or more is the whole base map");
  assert.equal(frameOf(render(world, worldRows)), "world", "map_extent world is always the whole base map");
  // a big circle on the edge of the data frame: padding grows until it fits (Spain is at the edge of a Spain-to-Chile frame)
  const edge = render({ ...world, map_extent: undefined }, [{ c: "ESP", v: 1000 }, { c: "CHL", v: 10 }]);
  assert.deepEqual(ch.checkSymbolMapRadii(edge).failures, [], "a circle on the frame edge is not clipped");
  const clipped = gas.replace(/(data-role="symbol-circle" data-iso3="NOR"[^>]*? cx=")[^"]*"/, '$11"');
  assert.ok(ch.checkSymbolMapRadii(clipped).failures.some((f) => f.rule === "symbol-circle-outside-frame" && f.iso3 === "NOR"));
}

// 4e legend units: one unit for the whole legend, chosen from the largest ring; no space before a Chinese unit word, one before a Latin unit
{
  const legendOf = (spec, rows) => [...render(spec, rows).matchAll(/data-role="symbol-legend-value"[^>]*>([^<]*)</g)].map((m) => m[1]);
  const rowsBig = [["CHN", 12000], ["USA", 5000], ["IND", 3000]].map(([c, v]) => ({ c, v }));
  assert.deepEqual(legendOf({ ...world, unit: "百万吨" }, rowsBig), ["100亿吨", "50亿吨", "10亿吨"], "one unit: 100亿吨 / 50亿吨 / 10亿吨");
  assert.deepEqual(legendOf({ ...world, unit: "万人" }, [{ c: "CHN", v: 30000 }, { c: "USA", v: 3000 }]), ["2亿人", "1亿人", "0.2亿人"], "scale from the top ring (万人 -> 亿人)");
  assert.deepEqual(legendOf({ ...world, unit: "TJ" }, [{ c: "CHN", v: 1155685 }, { c: "USA", v: 1000 }]), ["100万 TJ", "50万 TJ", "10万 TJ"], "a Latin unit keeps one space");
  assert.deepEqual(legendOf({ ...world, unit: "吨" }, [{ c: "CHN", v: 1155685 }, { c: "USA", v: 1000 }]), ["100万吨", "50万吨", "10万吨"], "a Chinese unit word takes no space");
}

// 4f report-only: a circle anchored outside its own region's polygon is listed (never refused)
{
  assert.equal(ch.pointInsideFeatures([5, 5], [{ type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] }]), true);
  assert.equal(ch.pointInsideFeatures([15, 5], [{ type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] }]), false);
  assert.equal(ch.pointInsideFeatures([5, 5], [{ type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] }]), false, "a hole is not inside");
  const svg = render(world, worldRows);
  const qa = ch.checkSymbolMapRadii(svg);
  assert.ok(Array.isArray(qa.anchorOutside), "the QA result lists the circles whose anchor is outside their region");
  assert.deepEqual(qa.failures, [], "listing them never fails the check");
  const isl = ch.checkSymbolMapRadii(render(world, [{ c: "DEU", v: 10 }, { c: "NZL", v: 5 }, { c: "STP", v: 1 }])).anchorOutside;
  assert.deepEqual(isl.sort(), ["NZL", "STP"], "islands whose label point misses the polygon are listed; Germany's is inside");
  const tagged = svg.replace(/(data-role="symbol-circle" data-iso3="DEU")/, '$1 data-anchor-outside="1"');
  assert.deepEqual(ch.checkSymbolMapRadii(tagged).anchorOutside, ["DEU"]);
}

// 4g K989d: the check reads the DRAWN radius; a zoomed frame that cannot hold every circle falls back to the world frame; position; minimum-circle note
{
  const svg = render(world, worldRows);
  const rules = (t) => ch.checkSymbolMapRadii(t).failures.map((f) => f.rule + ":" + f.iso3);
  // the drawn r is changed while data-r stays: only the drawn-radius rule can see it
  const drawn = svg.replace(/(data-iso3="DEU"[^>]*? cx="[^"]*" cy="[^"]*" r=")[^"]*"/, '$180"');
  assert.deepEqual(ch.checkSymbolMapRadii(drawn).failures.filter((f) => f.rule === "symbol-circle-area"), [], "data-r alone is self-consistent");
  assert.ok(rules(drawn).includes("symbol-circle-drawn-r-mismatch:DEU"), "a drawn r that differs from data-r fails");
  assert.ok(rules(svg.replace(/(data-iso3="DEU"[^>]*? cx="[^"]*" cy="[^"]*") r="[^"]*"/, "$1")).includes("symbol-circle-drawn-r-mismatch:DEU"), "a circle without a drawn r fails");
  assert.ok(rules(svg.replace(/(data-iso3="ISL"[^>]*? cx="[^"]*" cy="[^"]*" r=")[^"]*"/, '$140"')).includes("symbol-circle-drawn-r-mismatch:ISL"), "a minimum circle drawn at another size than data-draw-r fails");
  assert.ok(rules(svg.replace(/(data-iso3="DEU" data-value="3100" data-r="[^"]*")/, '$1 data-min-r="1" data-draw-r="1000.000"').replace(/(data-iso3="DEU"[^>]*? cx="[^"]*" cy="[^"]*" r=")[^"]*"/, '$11000.000"')).includes("symbol-circle-min-flag-illegal:DEU"), "the minimum flag on a circle whose true radius is not under the minimum fails");
  assert.ok(ch.checkSymbolMapRadii(svg.replace(/<rect data-role="symbol-map-frame"[^>]*>/, "")).failures.some((f) => f.rule === "symbol-circle-no-frame"), "circles without the frame rectangle fail");
  // fallback: Uruguay is the biggest circle at the edge of a Uruguay-to-China box; the zoomed frame cannot hold it
  const auto = { ...world, map_extent: undefined };
  const edge2 = render(auto, [{ c: "URY", v: 1000 }, { c: "CHN", v: 10 }]);
  assert.equal(/data-role="symbol-map-frame" data-frame="([^"]*)"/.exec(edge2)[1], "world", "circles that do not fit the zoomed frame fall back to the world frame");
  assert.deepEqual(ch.checkSymbolMapRadii(edge2).failures, [], "and none is clipped there");
  // position: the circle sits on the region's label point (Germany west of Russia, Nigeria south of Germany)
  const at = (iso3) => { const c = /<circle\b[^>]*data-iso3="[A-Z]+"[^>]*>/g; for (const m of svg.matchAll(c)) if (new RegExp(`data-iso3="${iso3}"`).test(m[0]) && /symbol-circle/.test(m[0])) return { x: Number(/ cx="([^"]*)"/.exec(m[0])[1]), y: Number(/ cy="([^"]*)"/.exec(m[0])[1]) }; return null; };
  assert.ok(at("DEU").x < at("RUS").x, "Germany is west of Russia");
  assert.ok(at("NGA").y > at("DEU").y, "Nigeria is south of Germany");
  assert.ok(at("USA").x < at("DEU").x && at("BRA").y > at("USA").y, "the USA is west of Germany and Brazil south of the USA");
  // the minimum-circle note says how many circles are under the minimum (ISL and NGA: 2), not how many circles there are
  const note = (t) => /(\d+) 个圆小于最小可见尺寸/.exec(t)?.[1];
  assert.equal(note(svg), "2", "two circles are under the minimum");
  assert.equal(note(render(world, [{ c: "USA", v: 32000 }, { c: "RUS", v: 14000 }, { c: "ISL", v: 0.3 }])), "1", "one circle under the minimum, three circles in all");
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
