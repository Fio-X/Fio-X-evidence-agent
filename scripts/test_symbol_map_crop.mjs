#!/usr/bin/env node
// symbol_map crop (NEWSROOM_SYMBOL_MAP_CROP=1 on top of NEWSROOM_SYMBOL_MAP=1, default off): the frame is decided by the points the circles sit on (their label
// points, plus the focus place's), not by the whole outlines. Pure box rules first, then renders, then the program-counted footnote line, then source mutations:
// each rule is broken on purpose in a copy of the runtime and this same test, run against the copy, must fail.
// "Circles inside the frame" is judged here from the output SVG alone (frame rectangle, cx/cy/r, diamond path), not from the renderer's own layout variables.
// Run: node scripts/test_symbol_map_crop.mjs
import "./group_env_pin.mjs";
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const ROOT = process.env.SYMBOL_CROP_ROOT ?? REPO; // a mutated copy of the runtime when the parent runs this file as its own child
const KEY = "NEWSROOM_SYMBOL_MAP_CROP";
process.env.NEWSROOM_SYMBOL_MAP = "1";
process.env.NEWSROOM_US_STATES = "1";
delete process.env.NEWSROOM_MAP_WORLD;
delete process.env[KEY];
const load = (name) => import(pathToFileURL(join(ROOT, "runtime/pi", name)).href);
const viz = await load("viz.mjs");
const ch = await load("choropleth.mjs");
const rq = await load("render_qa.mjs");
const { getBasemap } = await load("basemap_registry.mjs");
const { assertSafeSvg } = await load("svg_security.mjs");

const common = { schema_version: "0.9.0", takeaway: "t", subtitle: "synthetic", alt: "A synthetic symbol map.", source_note: "synthetic fixture", source: "synthetic", claim_id: "c1", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, verification_mode: "draft", reader_task: "spatial", chart_type: "symbol_map", category_field: "c", value_field: "v", measure_kind: "count" };
const bm = getBasemap("naturalearth_admin0_50m");
const spec = (language = "en", extra = {}) => ({ ...common, language, title: "T", unit: "PJ", category_names: "iso3", basemap_id: bm.id, basemap_source_url: bm.source_url, basemap_license: bm.license, basemap_content_hash: bm.content_hash, ...extra });
const rowsOf = (pairs) => pairs.map(([c, v]) => ({ c, v }));
const render = (s, rows, crop) => {
  if (crop === undefined) delete process.env[KEY]; else process.env[KEY] = crop;
  try { return viz.renderVizBundle(s, rows, { mobilePages: false }).desktop; } finally { delete process.env[KEY]; }
};
const sha = (t) => createHash("sha256").update(t).digest("hex");
const frameTag = (svg) => /<rect\b[^>]*data-role="symbol-map-frame"[^>]*>/.exec(svg)?.[0];
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag ?? "")?.[1];
const frameOf = (svg) => attr(frameTag(svg), "data-frame");

// Judged from the output only: the frame rectangle, every circle's cx/cy/r, the focus diamond's path, and every placed name's estimated box.
function outsideFrame(svg, tol = 0.6) {
  const f = frameTag(svg);
  const L = Number(attr(f, "x")), T = Number(attr(f, "y")), R = L + Number(attr(f, "width")), B = T + Number(attr(f, "height"));
  const vb = /viewBox="([^"]+)"/.exec(svg)[1].split(/\s+/).map(Number);
  assert.ok(L >= vb[0] && R <= vb[0] + vb[2] && T >= vb[1] && B <= vb[1] + vb[3], "the frame sits inside the viewBox");
  const bad = [];
  for (const m of svg.matchAll(/<circle\b[^>]*data-role="symbol-circle"[^>]*>/g)) {
    const cx = Number(attr(m[0], "cx")), cy = Number(attr(m[0], "cy")), r = Number(attr(m[0], "r"));
    if (cx - r < L - tol || cx + r > R + tol || cy - r < T - tol || cy + r > B + tol) bad.push(`circle ${attr(m[0], "data-iso3")}`);
  }
  for (const m of svg.matchAll(/<path\b[^>]*data-role="focus-mark"[^>]*>/g)) {
    const nums = [...attr(m[0], "d").matchAll(/-?\d+(?:\.\d+)?/g)].map((x) => Number(x[0]));
    const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
    if (Math.min(...xs) < L - tol || Math.max(...xs) > R + tol || Math.min(...ys) < T - tol || Math.max(...ys) > B + tol) bad.push("focus diamond");
  }
  for (const m of svg.matchAll(/<text\b[^>]*data-role="(?:symbol-label|focus-mark-label)"[^>]*>([^<]*)<\/text>/g)) {
    const x = Number(attr(m[0], "x")), y = Number(attr(m[0], "y")), anchor = attr(m[0], "text-anchor");
    const w = [...m[1]].reduce((s, ch2) => s + (ch2.charCodeAt(0) > 255 ? 12 : 12 * 0.6), 0);
    const x0 = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    if (x0 < L - tol || x0 + w > R + tol || y - 12 < T - tol || y > B + tol) bad.push(`label ${m[1]}`);
  }
  return bad;
}

// 1 the box rules (pure)
{
  assert.equal(ch.symbolMapCropEnabled(), false, "unset: off");
  for (const [value, expected] of [["1", true], ["true", false], ["1 ", false], [" 1", false], ["0", false], ["", false], ["yes", false]]) {
    process.env[KEY] = value;
    assert.equal(ch.symbolMapCropEnabled(), expected, `switch value ${JSON.stringify(value)}`);
  }
  delete process.env[KEY];
  // constants: pinned (starting values, not from the literature, not trial-run)
  assert.equal(ch.SYMBOL_CROP_MARGIN, 0.12);
  assert.equal(ch.SYMBOL_CROP_MIN_LON, 24);
  assert.equal(ch.SYMBOL_CROP_MIN_LAT, 16);
  const src = readFileSync(join(ROOT, "runtime/pi/choropleth.mjs"), "utf8");
  assert.match(src, /Starting values: not from the literature, not trial-run\./, "the constants carry the honest comment");
  // minimum span: one point, two close points
  const one = ch.symbolCropBox([[10, 50]]);
  assert.ok(Math.abs(one.lonMax - one.lonMin - 24) < 1e-9 && Math.abs(one.latMax - one.latMin - 16) < 1e-9, "one point: the minimum span, not a point");
  const two = ch.symbolCropBox([[10, 50], [12, 51]]);
  assert.ok(two.lonMax - two.lonMin >= 24 - 1e-9 && two.latMax - two.latMin >= 16 - 1e-9, "two close points: not under the minimum span");
  // margin: 12% of the span each side
  const wide = ch.symbolCropBox([[0, 0], [100, 40]]);
  assert.ok(Math.abs(wide.lonMax - wide.lonMin - 100 * 1.24) < 1e-9 && Math.abs(wide.latMax - wide.latMin - 40 * 1.24) < 1e-9, "span plus 12% each side");
  assert.ok(Math.abs(wide.lonMin - -12) < 1e-9 && Math.abs(wide.latMax - 44.8) < 1e-9);
  // date line: the span goes around the largest gap, not 360
  const dl = ch.symbolCropBox([[178, -17], [-120, 37]]);
  assert.ok(Math.abs(dl.lonMax - dl.lonMin - 62 * 1.24) < 1e-9, `Fiji to the western US: 62 degrees plus margin, not 298 or 360 (${dl.lonMax - dl.lonMin})`);
  assert.equal(dl.crossesDateLine, true);
  assert.equal(ch.symbolCropBox([[10, 50], [20, 40]]).crossesDateLine, false);
  assert.equal(ch.symbolCropBox([]), null);
  assert.equal(ch.symbolCropFrameMode(ch.symbolCropBox([[10, 50], [12, 51]])), "region");
  assert.equal(ch.symbolCropFrameMode(ch.symbolCropBox([[-120, 40], [150, -30], [20, 60], [-60, -40]])), "world");
}

// 2 switch off: nothing changes (hashes of the #218 output, fc93bdbb); crop on without the symbol map switch changes nothing either (no chart)
// Outlines of these three (Dutch overseas parts, Portuguese islands, Australia) make the old rule say "world"; their label points do not.
const SPREAD = rowsOf([["NLD", 100], ["PRT", 40], ["AUS", 20]]);
const BASELINE = { en: "3e71fdeec765103ee4e76024ab9b79b5e28450c7dda9356757ad1d8a164c8cf3", zh: "6c9d84716dcd99f9871e05fae8013a6d9a9efea3669821c149ecaa2fa43784f5" }; // sha256 of the fc93bdbb output
{
  for (const language of ["en", "zh"]) {
    const off = render(spec(language), SPREAD);
    assert.equal(sha(off), BASELINE[language], `${language}: switch off is byte-identical to fc93bdbb`);
    assert.equal(sha(render(spec(language), SPREAD, "0")), sha(off), `${language}: "0" is off`);
    assert.equal(sha(render(spec(language), SPREAD, "true")), sha(off), `${language}: "true" is off`);
    assert.ok(!/data-frame-source/.test(off) && !/地图已裁剪|is cropped to the area/.test(off), `${language}: off carries no crop marker and no M line`);
  }
}

// 3 on: the old rule says world (outlines), the new rule a smaller frame; every circle inside, judged from the SVG
for (const [label, pairs, tier] of [["spread", [["NLD", 100], ["PRT", 40], ["AUS", 20]], "crop"], ["two far points", [["NLD", 100], ["BRA", 60]], "region"]]) {
  const rows = rowsOf(pairs), ids = pairs.map(([c]) => c).sort();
  const off = render(spec("en"), rows);
  assert.equal(frameOf(off), "world", `${label}: old rule: the outlines make it the whole base map`);
  const on = render(spec("en"), rows, "1");
  assert.equal(frameOf(on), tier, `${label}: new rule: ${tier}`);
  assert.equal(attr(frameTag(on), "data-frame-source"), "data-extent", `${label}: the cropped frame is marked`);
  assert.deepEqual(outsideFrame(on), [], `${label}: no circle, diamond or name outside the frame, judged from the SVG`);
  assert.equal((on.match(/data-role="symbol-circle"/g) ?? []).length, ids.length, `${label}: every circle is drawn`);
  const listed = [...on.matchAll(/data-role="symbol-list-name"[^>]*data-iso3="([A-Z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, ids, `${label}: the list still names every circle`);
  assertSafeSvg(on, { label: "cropped symbol map" });
  const qa = rq.runRenderQa({ desktop: on }, { symbol_map: { rows, spec: spec("en") } });
  assert.equal(qa.passed, true, `${label}: render QA passes on the cropped map (${JSON.stringify(qa.viewports?.desktop?.geometry?.failures?.slice(0, 2))})`);
  assert.deepEqual(ch.checkSymbolMapRadii(on).failures, [], `${label}: radius rules hold`);
  assert.deepEqual(ch.checkSymbolMapList(on, { expectedIso3: ids }).failures, [], `${label}: list rules hold against the rows`);
  // the checker is not self-proving: move one circle out of the frame in a copy of the output and it must report it
  const moved = on.replace(/(data-role="symbol-circle" data-iso3="NLD"[^>]*? cx=")[^"]*"/, '$19999"');
  assert.notEqual(moved, on);
  assert.deepEqual(outsideFrame(moved), ["circle NLD"], `${label}: a circle moved out of the frame is reported by the independent check`);
}

const allIso3Early = [...new Set(Array.from({ length: ch.neFeatureCount() }, (_, i) => ch.neFeatureAttributes(i)?.iso3).filter(Boolean))];
// 4 date line: Fiji, Australia and the western US: the box goes around the largest gap; a world-projection crop cannot cross it, so that tier is the whole base map
{
  const dlRows = rowsOf([["USA", 50], ["AUS", 40], ["FJI", 30]]);
  const off = render(spec("en"), dlRows);
  const on = render(spec("en"), dlRows, "1");
  assert.equal(frameOf(on), "world", "crop tier across the date line: the whole base map");
  assert.equal(frameOf(off), "crop", "the old rule cropped the world projection here, wrapped at 180 degrees: the new tier does not repeat it across the date line");
  assert.ok(!/data-frame-source/.test(on) && !/地图已裁剪|is cropped to the area/.test(on), "no crop marker or M line when it ended as the whole base map (M = 0, nothing is outside)");
  // Fiji, Russia and the US: a box that really crosses the date line and lands in the crop tier; it is the whole map, never a wrapped crop
  const ruFj = render(spec("en"), rowsOf([["FJI", 100], ["RUS", 85], ["USA", 70]]), "1");
  assert.equal(frameOf(ruFj), "world", "Fiji, Russia, US: the whole base map (date-line crossing falls back)");
  assert.ok(!/data-frame-source/.test(ruFj) && !/is cropped to the area/.test(ruFj), "and no crop marker, no M line (M = 0)");
  // with rows for every base-layer country but two, the date-line crop tier is still the whole map: no frame, so nothing is hidden and no M line
  const dlFull = render(spec("en"), rowsOf([["USA", 50], ["AUS", 40], ["FJI", 30], ...allIso3Early.filter((c) => !["USA", "AUS", "FJI", "RUS", "NZL"].includes(c)).map((c) => [c, null])]), "1");
  assert.equal(frameOf(dlFull), "world", "date line with absent regions: the whole map");
  assert.ok(!/is cropped to the area/.test(dlFull), "and no M line");
  // the regional tier across the date line is cropped, with the unwrapped corners
  const small = rowsOf([["FJI", 10], ["TON", 8], ["WSM", 6]]);
  const smallOn = render(spec("en"), small, "1");
  assert.equal(frameOf(smallOn), "region", "Fiji, Tonga and Samoa across the date line: a fitted regional frame");
  assert.deepEqual(outsideFrame(smallOn), [], "every circle inside");
}

// 5 guard: a big circle on a small country at the frame edge does not fit, so the output is the switch-off world output
{
  const edge = rowsOf([["MAC", 100000], ["KNA", 30], ["TGO", 30]]);
  const on = render(spec("en"), edge, "1");
  assert.equal(frameOf(on), "world", "falls back to the whole base map");
  assert.equal(frameOf(render(spec("en"), edge)), "world", "fixture: the switch-off output is the whole base map too");
  assert.equal(sha(on), sha(render(spec("en"), edge)), "and equals the switch-off output");
  assert.deepEqual(outsideFrame(on), []);
  assert.ok(!/data-frame-source|is cropped to the area/.test(on), "no crop marker after the fallback");
}

// 6 focus diamond: inside the extent, and the extent grows to include it
{
  const rows = rowsOf([["DEU", 100], ["FRA", 80]]);
  const plain = render(spec("en"), rows, "1");
  const withFocus = render(spec("en", { focus_place: "POL" }), rows, "1");
  assert.match(withFocus, /data-role="focus-mark"/, "the diamond is drawn");
  assert.deepEqual(outsideFrame(withFocus), [], "diamond, circles and names inside");
  const far = render(spec("en", { focus_place: "JPN" }), rows, "1");
  assert.deepEqual(outsideFrame(far), [], "a far focus place is held by the frame (or the whole base map)");
  assert.match(far, /data-role="focus-mark"/);
  assert.notEqual(sha(far), sha(plain), "the focus place changed the extent");
  // the focus point is part of the box (margin included), so the diamond sits well inside the frame; ignoring it leaves the diamond at the edge
  const inset = (svg) => {
    const f = frameTag(svg), L = Number(attr(f, "x")), T = Number(attr(f, "y")), R = L + Number(attr(f, "width")), B = T + Number(attr(f, "height"));
    const nums = [...attr(/<path\b[^>]*data-role="focus-mark"[^>]*>/.exec(svg)[0], "d").matchAll(/-?\d+(?:\.\d+)?/g)].map((x) => Number(x[0]));
    const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
    return Math.min(Math.min(...xs) - L, R - Math.max(...xs), Math.min(...ys) - T, B - Math.max(...ys));
  };
  const bra = render(spec("en", { focus_place: "BRA" }), rows, "1");
  assert.equal(frameOf(bra), "region", "Germany, France and a focus place in Brazil: the focus point is in the box, so a regional frame, not the whole map");
  assert.deepEqual(outsideFrame(bra), []);
  assert.ok(inset(far) >= 8, `the far focus place has room inside the frame (${inset(far).toFixed(1)} px)`);
}

// 7 other frames are not touched: US state map, map_extent world
{
  const bmUs = getBasemap(ch.CHOROPLETH_US_BASEMAP_ID);
  const us = { ...common, language: "en", title: "US", unit: "people", category_names: "us_state", basemap_id: ch.CHOROPLETH_US_BASEMAP_ID, basemap_source_url: bmUs.source_url, basemap_license: bmUs.license, basemap_content_hash: bmUs.content_hash };
  const usRows = rowsOf([["CA", 280000], ["TX", 230000], ["FL", 220000], ["AK", 5000], ["HI", 12000]]);
  assert.equal(sha(render(us, usRows, "1")), sha(render(us, usRows)), "US state map: identical with the switch on");
  process.env.NEWSROOM_MAP_WORLD = "1";
  try {
    const w = spec("en", { map_extent: "world" });
    assert.equal(sha(render(w, SPREAD, "1")), sha(render(w, SPREAD)), "map_extent world: identical with the switch on");
    assert.equal(frameOf(render(w, SPREAD, "1")), "world");
  } finally { delete process.env.NEWSROOM_MAP_WORLD; }
}

// 8 names at the frame edge are not cut: a circle at the edge of the box, every placed name (estimated box) inside the frame
{
  for (const language of ["en", "zh"]) {
    const rows = rowsOf([["DEU", 100], ["POL", 90], ["FRA", 70], ["ITA", 60], ["ESP", 50], ["GBR", 40]]);
    const on = render(spec(language), rows, "1");
    assert.deepEqual(outsideFrame(on), [], `${language}: circles and names inside the frame`);
  }
  // fixtures where a long name beside a circle at the frame edge is cut when the bounds are removed (probed on a mutated copy)
  for (const pair of [[["BIH", 100], ["PNG", 85]], [["MLT", 100], ["ARE", 85]], [["LUX", 100], ["ARE", 85]]]) {
    const on = render(spec("en"), rowsOf(pair), "1");
    assert.deepEqual(outsideFrame(on), [], `${pair.map((p) => p[0])}: names inside the frame`);
  }
}

// 9 the footnote: N is the base-layer count and does not change; M (outside the frame) is a separate line, counted by the program in projected space.
// Hand-worked fixtures: every base-layer country gets a row except the named ones, so N is exactly the named ones; M is worked out from the map, not computed.
const allIso3 = [...new Set(Array.from({ length: ch.neFeatureCount() }, (_, i) => ch.neFeatureAttributes(i)?.iso3).filter(Boolean))];
const withAbsent = (circles, absent) => rowsOf([...circles, ...allIso3.filter((c) => !circles.some(([k]) => k === c) && !absent.includes(c)).map((c) => [c, null])]);
const noRowN = (svg, lang) => Number((lang === "zh" ? /(\d+) 个地区没有数据行，未显示/ : /(\d+) region\(s\) have no data row and are not shown/).exec(svg)?.[1] ?? 0);
const mCount = (svg, lang) => { const m = (lang === "zh" ? /地图已裁剪到有数据的范围，上述地区中有 (\d+) 个在框外、未显示/ : /The map is cropped to the area with data; (\d+) of them are outside the frame and not shown\./).exec(svg); return m ? Number(m[1]) : null; };
{
  const cases = [
    // Europe circles; Australia and New Zealand have no row and are far outside: N=2, M=2
    { name: "two far regions", circles: [["DEU", 100], ["FRA", 80], ["ITA", 60]], absent: ["AUS", "NZL"], N: 2, M: 2 },
    // Canada and Mexico circles; Russia (pieces across the date line, none near) and Fiji have no row: N=2, M=2 (a lon/lat box of Russia would reach the frame)
    { name: "date-line region outside", circles: [["CAN", 100], ["MEX", 80]], absent: ["RUS", "FJI"], N: 2, M: 2 },
    // Germany, Italy, Poland circles; France (mainland inside the frame, so it is shown) and Australia: N=2, M=1 (a partly or wholly visible region is not counted)
    { name: "partly visible is inside", circles: [["DEU", 100], ["ITA", 80], ["POL", 60]], absent: ["FRA", "AUS"], N: 2, M: 1 },
    // Canada, Britain and Brazil circles make the world-projection crop (about 100 degrees of longitude, latitudes -10 to 62); Japan sits inside that latitude band but far east
    // of the frame, Australia far south-east: N=2, M=2 (a test of only the vertical side would count Japan as inside)
    { name: "same latitudes, outside east", circles: [["CAN", 100], ["GBR", 80], ["BRA", 60]], absent: ["JPN", "AUS"], N: 2, M: 2 },
  ];
  for (const language of ["en", "zh"]) for (const c of cases) {
    const rows = withAbsent(c.circles, c.absent);
    const on = render(spec(language), rows, "1");
    const off = render(spec(language), rows);
    const label = `${language} ${c.name}`;
    assert.notEqual(frameOf(on), "world", `${label}: cropped`);
    assert.equal(noRowN(off, language), c.N, `${label}: fixture has the hand-set N (switch off)`);
    assert.equal(noRowN(on, language), c.N, `${label}: N unchanged by the crop`);
    assert.equal(mCount(on, language), c.M, `${label}: M as worked out by hand`);
    assert.ok(mCount(on, language) <= noRowN(on, language), `${label}: M <= N`);
    assert.equal(mCount(off, language), null, `${label}: no M line with the switch off`);
    assert.deepEqual(outsideFrame(on), [], `${label}: circles inside`);
  }
  // a fallback to the whole base map has no M line
  const edgeRows = withAbsent([["MAC", 100000], ["KNA", 30], ["TGO", 30]], ["AUS"]);
  assert.equal(mCount(render(spec("en"), edgeRows, "1"), "en"), null, "no M line when the whole base map is drawn");
}

// 10 source mutations: break each rule in a copy of the runtime, run this file against the copy, it must fail
if (!process.env.SYMBOL_CROP_ROOT) {
  const tmp = makeTestTmp("symbol-crop-mutants-");
  const copy = join(tmp, "m");
  cpSync(join(REPO, "runtime", "pi"), join(copy, "runtime", "pi"), { recursive: true });
  cpSync(join(HERE, "tmp_helper.mjs"), join(copy, "scripts", "tmp_helper.mjs"), { recursive: true });
  const mutants = [
    ["M1 input points are the outlines again", [["viz.mjs", "cropBox = symbolCropBox(anchors);", "cropBox = symbolCropBox(dataPoints);"]]],
    ["M2 no minimum span", [["choropleth.mjs", "Math.max(SYMBOL_CROP_MIN_LON, (360 - gap)", "Math.max(0, (360 - gap)"], ["choropleth.mjs", "Math.max(SYMBOL_CROP_MIN_LAT, (latHi - latLo)", "Math.max(0, (latHi - latLo)"]]],
    ["M3 no largest gap", [["choropleth.mjs", "if (lons[i] - lons[i - 1] > gap) {", "if (false) {"]]],
    ["M4 the focus point is not added", [["viz.mjs", "if (focusMark) anchors.push(", "if (false) anchors.push("]]],
    ["M5 no fall back to the whole base map", [["viz.mjs", 'if (layout.overflow > 0.5 && (frameMode === "crop" || frameMode === "region")) {', "if (false) {"]]],
    ["M6 N counts only what is inside the frame", [["viz.mjs", "const noRow = [...baseRegions].filter((iso3) => !joinedFeatures.has(iso3)).length;", "const noRow = [...baseRegions].filter((iso3) => !joinedFeatures.has(iso3)).length - (cropBox && frameMode !== \"world\" ? 1 : 0);"]]],
    ["M7 the switch is truthy", [["choropleth.mjs", 'process.env.NEWSROOM_SYMBOL_MAP_CROP === "1"', "Boolean(process.env.NEWSROOM_SYMBOL_MAP_CROP)"]]],
    ["M8 no M line", [["viz.mjs", '    rows2.push(lang === "zh" ? `地图已裁剪', '    void (lang === "zh" ? `地图已裁剪']]],
    ["M9 a partly visible region counts as outside", [["viz.mjs", "return x1 >= clipRect.left && x0 <= clipRect.right && y1 >= clipRect.top && y0 <= clipRect.bottom;", "return x0 >= clipRect.left && x1 <= clipRect.right && y0 >= clipRect.top && y1 <= clipRect.bottom;"]]],
    ["M9b the frame test ignores the horizontal side", [["viz.mjs", "return x1 >= clipRect.left && x0 <= clipRect.right && y1", "return true && y1"]]],
    ["M10 a circle is drawn outside the frame", [["viz.mjs", 'data-r="${c.r.toFixed(3)}"${extraAll} cx="${c.x.toFixed(1)}"', 'data-r="${c.r.toFixed(3)}"${extraAll} cx="${(c.x + (cropBox ? 5000 : 0)).toFixed(1)}"']]],
    ["M11 names are not kept inside the frame", [["viz.mjs", "{ bounds: { left: mapLeft, right: mapRight, top, bottom }, textWidth: choroplethLabelWidth,", "{ bounds: { left: -1e6, right: 1e6, top: -1e6, bottom: 1e6 }, textWidth: choroplethLabelWidth,"]]],
    ["M12 a starting constant changed", [["choropleth.mjs", "SYMBOL_CROP_MARGIN = 0.12", "SYMBOL_CROP_MARGIN = 0.13"]]],
    ["M13 a crop across the date line is kept", [["viz.mjs", 'if (frameMode === "crop" && cropBox.crossesDateLine) frameMode = "world";', ""]]],
  ];
  for (const [name, edits] of mutants) {
    const originals = edits.map(([file]) => [join(copy, "runtime", "pi", file), readFileSync(join(copy, "runtime", "pi", file), "utf8")]);
    edits.forEach(([file, from, to]) => {
      const path = join(copy, "runtime", "pi", file);
      const text = readFileSync(path, "utf8");
      assert.equal(text.split(from).length - 1, 1, `mutation "${name}": the text to break occurs exactly once in ${file}`);
      writeFileSync(path, text.replace(from, () => to));
    });
    const run = spawnSync(process.execPath, [join(HERE, "test_symbol_map_crop.mjs")], { env: { ...process.env, SYMBOL_CROP_ROOT: copy }, encoding: "utf8" });
    for (const [path, text] of originals.reverse()) writeFileSync(path, text);
    assert.notEqual(run.status, 0, `mutation "${name}" must turn this test red, but it stayed green`);
  }
  console.log(`test_symbol_map_crop: ok (${mutants.length} mutations all red)`);
} else {
  console.log("test_symbol_map_crop: child ok");
}
