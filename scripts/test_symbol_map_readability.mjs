#!/usr/bin/env node
// symbol_map readability (#218; part of NEWSROOM_SYMBOL_MAP=1, default off): a name beside the circles that have room, a list under the map that names EVERY
// circle with its value, a footnote that says which circle pairs overlap by more than 60% of the smaller one, and the render-QA checks that hold the three
// together. Pure rules first, then a world render, then the QA tampers, then source mutations: each rule is broken on purpose in a copy of the runtime and
// this same test, run against the copy, must fail.
// Run: node scripts/test_symbol_map_readability.mjs
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const ROOT = process.env.SYMBOL_READABILITY_ROOT ?? REPO; // a mutated copy of the runtime when the parent runs this file as its own child
process.env.NEWSROOM_SYMBOL_MAP = "1";
process.env.NEWSROOM_MAP_WORLD = "1";
const load = (name) => import(pathToFileURL(join(ROOT, "runtime/pi", name)).href);
const viz = await load("viz.mjs");
const ch = await load("choropleth.mjs");
const rq = await load("render_qa.mjs");
const { getBasemap } = await load("basemap_registry.mjs");

const textWidth = (text, size) => String(text).length * size * 0.6;
const BOUNDS = { left: 0, right: 400, top: 0, bottom: 200 };

// 1 pure rules
{
  const items = [...Array(12)].map((_, i) => ({ iso3: `C${String(i).padStart(2, "0")}`, row: { c: `name${i}`, v: 100 - i } }));
  const spec = { category_field: "c", value_field: "v", highlight_values: [] };
  assert.deepEqual(ch.symbolLabelIso3s(items, spec), items.slice(0, 8).map((i) => i.iso3), "the eight largest are the label candidates, largest first");
  assert.equal(ch.SYMBOL_LABEL_MAX, ch.WORLD_LABEL_MAX, "the cap is the world choropleth's");
  assert.deepEqual(ch.symbolLabelIso3s(items, { ...spec, highlight_values: ["name10"] }).slice(-1), ["C10"], "a highlighted row is a candidate too");
  assert.equal(ch.symbolLabelIso3s(items, { ...spec, highlight_values: ["name10"] }).length, 9);
  const tie = [{ iso3: "ZZZ", row: { c: "z", v: 5 } }, { iso3: "AAA", row: { c: "a", v: 5 } }];
  assert.deepEqual(ch.symbolLabelIso3s(tie, spec), ["AAA", "ZZZ"], "ties go by iso3");
  assert.deepEqual(ch.symbolLabelIso3s([{ iso3: "A", row: { c: "a", v: 0 } }, { iso3: "B", row: { c: "b", v: -1 } }], spec), [], "no circle for zero or negative");
}
{
  // two circles side by side: the second name cannot go right of the second circle if the first name sits there; no two boxes and no circle are touched
  const circles = [{ id: "A", x: 100, y: 100, r: 20 }, { id: "B", x: 150, y: 100, r: 20 }, { id: "C", x: 390, y: 100, r: 10 }];
  const names = new Map([["A", "Alpha"], ["B", "Beta"], ["C", "Gamma"]]);
  const out = ch.placeSymbolLabels(circles, ["A", "B", "C"], names, { bounds: BOUNDS, textWidth });
  assert.equal(out.placed.length + out.listOnly.length, 3, "every wanted name is placed or listed");
  for (let i = 0; i < out.placed.length; i++) {
    const a = out.placed[i].box;
    assert.ok(a.x >= BOUNDS.left && a.x + a.w <= BOUNDS.right && a.y >= BOUNDS.top && a.y + a.h <= BOUNDS.bottom, "inside the frame");
    for (const c of circles) {
      const nx = Math.max(a.x, Math.min(c.x, a.x + a.w)), ny = Math.max(a.y, Math.min(c.y, a.y + a.h));
      assert.ok(Math.hypot(nx - c.x, ny - c.y) >= c.r + 1, `label ${out.placed[i].id} clear of circle ${c.id}`);
    }
    for (let j = i + 1; j < out.placed.length; j++) {
      const b = out.placed[j].box;
      assert.ok(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y), "label boxes do not overlap");
    }
  }
  assert.ok(out.placed.some((p) => p.id === "A") && out.placed.some((p) => p.id === "B"), "both close circles get a name somewhere clear");
  // the only free spot of B would sit on A's name: B is left to the list rather than overprinting it
  const clash = ch.placeSymbolLabels([{ id: "A", x: 300, y: 100, r: 10 }, { id: "B", x: 395, y: 100, r: 5 }], ["A", "B"], new Map([["A", "Alphabet"], ["B", "Beta"]]), { bounds: BOUNDS, textWidth });
  assert.deepEqual(clash.placed.map((p) => p.id), ["A"], "A is named");
  assert.deepEqual(clash.listOnly, ["B"], "B's name would overprint A's: it goes to the list");
  // a circle boxed in on all four sides (frame corner, neighbours) goes to the list
  const boxed = [{ id: "A", x: 20, y: 10, r: 8 }, { id: "N", x: 20, y: 40, r: 25 }, { id: "E", x: 60, y: 10, r: 25 }, { id: "W", x: -10, y: 10, r: 25 }];
  const none = ch.placeSymbolLabels(boxed, ["A"], new Map([["A", "Alpha"]]), { bounds: { left: 0, right: 70, top: 0, bottom: 60 }, textWidth });
  assert.deepEqual(none.listOnly, ["A"], "no free spot: the name is left to the list");
  assert.deepEqual(ch.placeSymbolLabels(circles, ["Q"], names, { bounds: BOUNDS, textWidth }).listOnly, ["Q"], "an unknown id is left to the list");
  // no pixel cutoff: a 2.5 px circle gets its name when there is room
  const tiny = ch.placeSymbolLabels([{ id: "T", x: 100, y: 100, r: 2.5 }], ["T"], new Map([["T", "Tiny"]]), { bounds: BOUNDS, textWidth });
  assert.equal(tiny.placed.length, 1, "a tiny circle with room is named on the map");
}
{
  const nameOf = (id) => id.toLowerCase();
  assert.equal(ch.symbolOverlapNote([], nameOf, "en"), "");
  assert.match(ch.symbolOverlapNote([["A", "B"]], nameOf, "en"), /^1 pair\(s\) of circles overlap by more than 60% of the smaller circle \(a \/ b\)/);
  assert.match(ch.symbolOverlapNote([["A", "B"], ["C", "D"]], nameOf, "zh"), /^2 对圆重叠超过较小圆面积的 60%（a、b；c、d），各地区数值见下方清单。$/);
  assert.match(ch.symbolOverlapNote([["A", "B"], ["C", "D"], ["E", "F"], ["G", "H"], ["I", "J"]], nameOf, "en"), /^5 pair\(s\).*\(a \/ b; c \/ d; e \/ f; g \/ h, …\)/, "at most four pairs are named");
  const pairs = ch.symbolCrowdedPairs([{ id: "A", x: 0, y: 0, r: 10 }, { id: "B", x: 5, y: 0, r: 10 }, { id: "C", x: 100, y: 0, r: 10 }, { id: "D", x: 19.5, y: 0, r: 10 }]);
  assert.deepEqual(pairs, [["A", "B"]], "pairs over 60% of the smaller circle only (A-B 0.79; B-D at 14.5 apart is under; C is alone)");
}

// 2 a world render with crowded countries
const common = { schema_version: "0.9.0", takeaway: "t", subtitle: "synthetic", alt: "A synthetic symbol map.", source_note: "synthetic fixture", source: "synthetic", claim_id: "c1", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, verification_mode: "draft", reader_task: "spatial", chart_type: "symbol_map", category_field: "c", value_field: "v", measure_kind: "count" };
const bm = getBasemap("naturalearth_admin0_50m");
const world = (language) => ({ ...common, language, title: language === "zh" ? "世界" : "World", unit: "PJ", category_names: "iso3", map_extent: "world", basemap_id: bm.id, basemap_source_url: bm.source_url, basemap_license: bm.license, basemap_content_hash: bm.content_hash });
const rowsAll = [["USA", 32000], ["RUS", 14000], ["CHN", 13000], ["DEU", 3100], ["FRA", 2900], ["GBR", 2500], ["NLD", 2300], ["BEL", 2100], ["IND", 2200], ["AUS", 1600], ["BRA", 1300], ["JPN", 800], ["ZAF", 700], ["NGA", 40], ["ISL", 0.3], ["CAN", 0]].map(([c, v]) => ({ c, v }));
const render = (spec, rows) => viz.renderVizBundle(spec, rows, { mobilePages: false }).desktop;
const tagsOf = (svg, role, tag) => [...svg.matchAll(new RegExp(`<${tag}\\b[^>]*data-role="${role}"[^>]*>`, "g"))].map((m) => m[0]);
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const qaOf = (svg, spec, rows) => rq.runRenderQa({ desktop: svg }, { symbol_map: { rows, spec } });
const listCheck = (qa) => (qa.viewports?.desktop ?? qa).extra_checks?.symbol_map_list;

for (const language of ["en", "zh"]) {
  const spec = world(language);
  const svg = render(spec, rowsAll);
  const circles = tagsOf(svg, "symbol-circle", "circle");
  const ids = circles.map((t) => attr(t, "data-iso3"));
  const positive = rowsAll.filter((r) => r.v > 0);
  assert.equal(ids.length, positive.length, `${language}: one circle per positive value`);
  // the list: every circle once, with its exact value
  const listNames = tagsOf(svg, "symbol-list-name", "text").map((t) => attr(t, "data-iso3"));
  const listValues = new Map(tagsOf(svg, "symbol-list-value", "text").map((t) => [attr(t, "data-iso3"), Number(attr(t, "data-value"))]));
  assert.deepEqual([...listNames].sort(), [...ids].sort(), `${language}: the list names every circle, not only the unlabelled ones`);
  for (const t of circles) assert.equal(listValues.get(attr(t, "data-iso3")), Number(attr(t, "data-value")), `${language}: ${attr(t, "data-iso3")} list value equals the circle's`);
  // labels: only candidates, each belongs to a circle, labelled + list-only = all candidates
  const labelled = tagsOf(svg, "symbol-label", "text").map((t) => attr(t, "data-iso3"));
  const candidates = ch.symbolLabelIso3s(positive.map((r) => ({ iso3: r.c, row: r })), spec);
  assert.equal(candidates.length, 8);
  assert.ok(labelled.length >= 1 && labelled.every((id) => candidates.includes(id)), `${language}: names appear, and only for the eight largest`);
  const group = /<g\b[^>]*data-role="symbol-labels"[^>]*>/.exec(svg)?.[0];
  assert.equal(Number(attr(group, "data-labelled")) + Number(attr(group, "data-list-only")), candidates.length, `${language}: each candidate is on the map or in the list-only count`);
  // overlap: the footnote says so, the group records the same pairs the geometry gives
  const found = ch.checkSymbolMapList(svg);
  assert.deepEqual(found.failures, [], `${language}: list check passes`);
  assert.ok(found.crowded.length >= 1, `${language}: the fixture has crowded pairs`);
  const recorded = attr(/<g\b[^>]*data-role="symbol-map-circles"[^>]*>/.exec(svg)[0], "data-crowded-pairs").split(";");
  assert.deepEqual([...recorded].sort(), [...found.crowded].sort(), `${language}: recorded pairs equal the geometry's`);
  const footer = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(" ");
  assert.match(footer, language === "en" ? /pair\(s\) of circles overlap by more than 60% of the smaller circle/ : /对圆重叠超过较小圆面积的 60%/, `${language}: the footnote carries the overlap notice`);
  const qa = qaOf(svg, spec, rowsAll);
  assert.equal(listCheck(qa)?.passed, true, `${language}: render QA runs the list check and it passes`);
  assert.equal(qa.passed, true, `${language}: the whole render QA passes (${JSON.stringify(qa.viewports?.desktop?.geometry?.failures?.slice(0, 2))})`);
}
{
  // no crowding: no notice, an empty record
  const spec = world("en");
  const rows = [{ c: "USA", v: 100 }, { c: "CHN", v: 90 }, { c: "BRA", v: 50 }];
  const svg = render(spec, rows);
  assert.equal(attr(/<g\b[^>]*data-role="symbol-map-circles"[^>]*>/.exec(svg)[0], "data-crowded-pairs"), "");
  assert.ok(!/overlap by more than/.test(svg), "no overlap notice when nothing overlaps");
  assert.equal(listCheck(qaOf(svg, spec, rows))?.passed, true);
}

// 3 the QA catches each tamper
{
  const spec = world("en");
  const svg = render(spec, rowsAll);
  const fails = (s, opts) => ch.checkSymbolMapList(s, opts).failures.map((f) => f.rule);
  const dropName = svg.replace(/<text\b[^>]*data-role="symbol-list-name"[^>]*data-iso3="DEU"[^>]*>[^<]*<\/text>/, "");
  assert.notEqual(dropName, svg);
  assert.ok(fails(dropName).includes("symbol-list-missing"), "a circle missing from the list");
  const extra = svg.replace("</svg>", '<text data-role="symbol-list-name" data-iso3="XXX">X</text></svg>');
  assert.ok(fails(extra).includes("symbol-list-extra"), "a list entry with no circle");
  const wrongValue = svg.replace(/(data-role="symbol-list-value" data-iso3="DEU" data-value=")[^"]*"/, '$1999"');
  assert.notEqual(wrongValue, svg);
  assert.ok(fails(wrongValue).includes("symbol-list-value-mismatch"), "a list value that differs from its circle");
  const orphan = svg.replace("</svg>", '<text data-role="symbol-label" data-iso3="XXX">X</text></svg>');
  assert.ok(fails(orphan).includes("symbol-label-without-circle"), "a name for a circle that is not there");
  const noRecord = svg.replace(/data-crowded-pairs="[^"]*"/, 'data-crowded-pairs=""');
  assert.ok(fails(noRecord).includes("symbol-crowded-pairs"), "crowded pairs hidden from the record");
  const dup = svg.replace("</svg>", '<text data-role="symbol-list-name" data-iso3="DEU">D</text></svg>');
  assert.ok(fails(dup).includes("symbol-list-duplicate"), "a list entry twice");
  // the rows are the independent side: a circle dropped from the circles AND the list together still fails against the rows
  const strip = svg.replace(/<circle\b[^>]*data-iso3="DEU"[^>]*\/>/, "").replace(/<text\b[^>]*data-role="symbol-list-(name|value)"[^>]*data-iso3="DEU"[^>]*>[^<]*<\/text>/g, "");
  assert.deepEqual(fails(strip), ["symbol-crowded-pairs"].filter((r) => fails(strip).includes(r)), "the stripped page is consistent with itself apart from the crowded record");
  const expected = rowsAll.filter((r) => r.v > 0).map((r) => r.c);
  assert.ok(fails(strip, { expectedIso3: expected }).includes("symbol-circle-vs-rows-missing"), "a circle dropped from circles and list together is caught against the rows");
  assert.ok(fails(svg, { expectedIso3: [...expected, "XXX"] }).includes("symbol-circle-vs-rows-missing"));
  assert.ok(fails(svg, { expectedIso3: expected.slice(1) }).includes("symbol-circle-vs-rows-extra"));
  assert.deepEqual(fails(svg, { expectedIso3: expected }), []);
}

// 3b focus_place: a diamond for a place with no circle
{
  const spec = { ...world("en"), focus_place: "DEU" };
  const rows = rowsAll.filter((r) => r.c !== "DEU");
  const svg = render(spec, rows);
  const marks = svg.match(/<[a-zA-Z]+\b[^>]*data-role="focus-mark"[^>]*>/g) ?? [];
  assert.equal(marks.length, 1, "one focus mark");
  assert.ok(/^<path\b/.test(marks[0]) && attr(marks[0], "data-focus") === "DEU", "a path for DEU");
  assert.ok(!/data-(iso3|value|r)=/.test(marks[0]), "no data attributes on the mark");
  const positive = rows.filter((r) => r.v > 0).length;
  assert.equal(tagsOf(svg, "symbol-circle", "circle").length, positive, "circle count still equals the data rows with the mark present");
  assert.equal(ch.checkSymbolMapRadii(svg).count, positive, "the radius check reads the same count");
  assert.ok(!tagsOf(svg, "symbol-list-name", "text").some((t) => attr(t, "data-iso3") === "DEU"), "the focus place is not in the circle list");
  {
    // with room (an isolated place) the name sits beside the diamond; crowded Europe has none, and then only the legend note names it
    const ausRows = rowsAll.filter((r) => r.c !== "AUS");
    const ausSvg = render({ ...spec, focus_place: "AUS" }, ausRows);
    assert.ok(/data-role="focus-mark-label"[^>]*>Australia</.test(ausSvg), "its name sits beside it when there is room");
    assert.equal(rq.runRenderQa({ desktop: ausSvg }, viz.symbolMapQaOptions({ ...spec, focus_place: "AUS" }, ausRows)).passed, true);
  }
  assert.ok(/◆ Germany: the place this map is about, no circle and no value/.test(svg), "the legend explains the diamond");
  const qa = rq.runRenderQa({ desktop: svg }, viz.symbolMapQaOptions(spec, rows));
  assert.equal(qa.passed, true, "render QA passes with the mark");
  assert.deepEqual(listCheck(rq.runRenderQa({ desktop: svg }, viz.symbolMapQaOptions({ ...spec, focus_place: undefined }, rows))).failures.map((f) => f.rule), ["symbol-focus-mark-unexpected"], "a mark the spec did not ask for is a failure");
  // tampers
  const fails = (s2, o) => ch.checkSymbolMapList(s2, o).failures.map((f) => f.rule);
  const asCircle = svg.replace(/<path data-role="focus-mark"[^>]*\/>/, '<circle data-role="focus-mark" data-focus="DEU" cx="1" cy="1" r="7"/>');
  assert.notEqual(asCircle, svg);
  assert.ok(fails(asCircle, { focus: { iso3: "DEU" } }).includes("symbol-focus-mark-not-path"), "a circle mark is refused");
  assert.ok(fails(svg.replace('data-role="focus-mark"', 'data-role="focus-mark" data-iso3="DEU"')).includes("symbol-focus-mark-has-data"), "a mark with data attributes is refused");
  assert.ok(fails(svg.replace("</svg>", '<path data-role="focus-mark" data-focus="DEU" d="M0 0Z"/></svg>')).includes("symbol-focus-mark-duplicate"));
  assert.ok(fails(svg.replace(/<path data-role="focus-mark"[^>]*\/>/, ""), { focus: { iso3: "DEU" } }).includes("symbol-focus-mark-missing"), "a mark that the spec asked for but is gone");
  assert.ok(fails(svg, { focus: { iso3: "FRA" } }).includes("symbol-focus-mark-wrong-place"));
  assert.ok(fails(svg, { focus: null }).includes("symbol-focus-mark-unexpected"));
  assert.deepEqual(fails(svg, { focus: { iso3: "DEU" } }), []);
  // what the model is told
  const lint = (sp, rs) => viz.lintVizSpec(sp, rs);
  const unresolved = lint({ ...spec, focus_place: "Atlantis" }, rows).blockers.filter((b) => /focus_place/.test(b));
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0], /^symbol_map focus_place 'Atlantis' is not a region of the base map; name it the way category_names does, or drop focus_place$/);
  const hasCircle = lint({ ...spec, focus_place: "USA" }, rows);
  assert.ok(hasCircle.warnings.some((w) => /focus_place 'USA' already has a circle; no focus mark is drawn/.test(w)), "a focus place that already has a circle is reported");
  assert.ok(!/data-role="focus-mark"/.test(render({ ...spec, focus_place: "USA" }, rows)), "and no mark is drawn for it");
  assert.ok(viz.validateVizSpec({ ...spec, chart_type: "horizontal_bar" }).some((e) => /focus_place is only for chart_type symbol_map/.test(e)), "focus_place on another chart type is refused");
  console.log(`focus text bytes: unresolved ${Buffer.byteLength(unresolved[0])}, has_circle warning ${Buffer.byteLength(hasCircle.warnings.find((w) => /focus_place/.test(w)))}`);
}

// 3b2 the diamond sits on top of a circle and is still not counted as one
{
  const spec = { ...world("en"), focus_place: "DEU" };
  const rows = rowsAll.filter((r) => r.c !== "DEU");
  const svg = render(spec, rows);
  const mark = (svg.match(/<path\b[^>]*data-role="focus-mark"[^>]*>/) ?? [""])[0];
  const nums = (attr(mark, "d") ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const cx = nums[0], cy = nums[1] + 7; // M x y-7 ...: the diamond's centre
  const under = tagsOf(svg, "symbol-circle", "circle").filter((t) => Math.hypot(Number(attr(t, "cx")) - cx, Number(attr(t, "cy")) - cy) < Number(attr(t, "r")));
  assert.ok(under.length >= 1, "precondition: the diamond's centre lies inside at least one data circle in this fixture");
  const positive = rows.filter((r) => r.v > 0).length;
  assert.equal(tagsOf(svg, "symbol-circle", "circle").length, positive, "still one circle per data row");
  assert.equal(ch.checkSymbolMapRadii(svg).count, positive, "the radius check does not count the diamond");
  const found = ch.checkSymbolMapList(svg, { expectedIso3: rows.filter((r) => r.v > 0).map((r) => r.c), focus: { iso3: "DEU" } });
  assert.deepEqual(found.failures, []);
  assert.equal(found.circles, positive);
  assert.equal(found.focusMarks, 1);
}

// 3c the QA is wired and does not skip quietly
{
  const spec = world("en");
  const svg = render(spec, rowsAll);
  const opts = viz.symbolMapQaOptions(spec, rowsAll);
  assert.deepEqual(Object.keys(opts), ["symbol_map"]);
  assert.equal(rq.runRenderQa({ desktop: svg }, opts).passed, true);
  // a circle dropped together with its list entry is caught only against the rows that the options carry
  const strip = svg.replace(/<circle\b[^>]*data-iso3="DEU"[^>]*\/>/, "").replace(/<text\b[^>]*data-role="symbol-list-(name|value)"[^>]*data-iso3="DEU"[^>]*>[^<]*<\/text>/g, "");
  assert.notEqual(strip, svg);
  assert.equal(rq.runRenderQa({ desktop: strip }, opts).passed, false, "through the real options the dropped circle is refused");
  const without = rq.runRenderQa({ desktop: svg }, {});
  assert.equal(without.passed, false, "a symbol_map page checked without its options fails");
  assert.ok(JSON.stringify(without).includes("symbol-qa-options-missing"));
  assert.ok(ch.checkSymbolMapList(svg.replace(/data-role="symbol-map-circles"/, 'data-role="x"')).failures.some((f) => f.rule === "symbol-circles-group-missing"), "circles without their group tag are a failure");
  const src = readFileSync(join(ROOT, "runtime/pi/newsroom.ts"), "utf8");
  assert.match(src, /spec\.chart_type === "symbol_map"\s*\?\s*symbolMapQaOptions\(spec, rows\)/, "newsroom.ts builds the symbol_map QA options through symbolMapQaOptions");
}

// 4 mutations: break each rule in a copy of the runtime, run this file against the copy, it must fail
if (!process.env.SYMBOL_READABILITY_ROOT) {
  const tmp = makeTestTmp("symbol-readability-mutants-");
  const copy = join(tmp, "m");
  cpSync(join(REPO, "runtime", "pi"), join(copy, "runtime", "pi"), { recursive: true });
  cpSync(join(HERE, "tmp_helper.mjs"), join(copy, "scripts", "tmp_helper.mjs"), { recursive: true });
  const mutants = [
    ["list drops an entry", "viz.mjs", "listEntries.forEach((e, i) => {", "listEntries.slice(1).forEach((e, i) => {"],
    ["overlap notice dropped", "viz.mjs", "const overlapNote = symbolOverlapNote(crowdedPairs, nameOf, lang);", 'const overlapNote = "";'],
    ["crowded record dropped", "viz.mjs", 'data-crowded-pairs="${crowdedPairs', 'data-crowded-x="${crowdedPairs'],
    ["labels not drawn", "viz.mjs", "for (const l of labels.placed) f.parts.push(", "for (const l of []) f.parts.push("],
    ["page height ignores the list", "viz.mjs", "const bodyH = Math.max(bodyH0, Math.ceil(listBottom - f0.bodyTop) + 8);", "const bodyH = bodyH0;"],
    ["labels may overlap each other", "choropleth.mjs", "      && !boxes.some((other) => labelBoxesOverlap(box, other)) && !circles.some", "      && !circles.some"],
    ["labels may sit on circles", "choropleth.mjs", " && !circles.some((other) => labelBoxHitsCircle(box, other, clearance)));", ");"],
    ["nine candidates instead of eight", "choropleth.mjs", "ordered.slice(0, SYMBOL_LABEL_MAX)", "ordered.slice(0, SYMBOL_LABEL_MAX + 1)"],
    ["crowded threshold raised", "choropleth.mjs", "circleOverlapShare(circles[i], circles[j]) > SYMBOL_MAX_OVERLAP) out.push", "circleOverlapShare(circles[i], circles[j]) > 1) out.push"],
    ["QA ignores a missing list entry", "choropleth.mjs", "if (!named.has(c.id) || !valued.has(c.id)) failures.push", "if (false) failures.push"],
    ["QA ignores the rows", "choropleth.mjs", "if (expectedIso3) {", "if (false) {"],
    ["QA ignores the crowded record", "choropleth.mjs", 'if ([...recorded].sort().join(";") !== [...crowded].sort().join(";")) failures.push', "if (false) failures.push"],
    ["render QA does not run the list check", "render_qa.mjs", "extra.symbol_map_list = {", "extra.symbol_map_list_off = {"],
    ["newsroom.ts drops the QA options wiring", "newsroom.ts", "? symbolMapQaOptions(spec, rows)", "? {}"],
    ["QA passes a page checked without options", "render_qa.mjs", "if (!haveRows) list.failures.push", "if (false) list.failures.push"],
    ["circles without group tag pass", "choropleth.mjs", "if (circles.length && !groupTag)", "if (false && !groupTag)"],
    ["focus mark drawn as a circle", "viz.mjs", '<path data-role="focus-mark" data-focus=', '<circle data-role="focus-mark" data-focus='],
    ["focus mark carries data", "viz.mjs", '<path data-role="focus-mark" data-focus=', '<path data-role="focus-mark" data-iso3="X" data-focus='],
    ["renderer ignores focus_place", "viz.mjs", 'const focusMark = focusStatus.kind === "mark" ?', "const focusMark = false ?"],
    ["QA ignores a missing focus mark", "choropleth.mjs", "if (focus && marks.length === 0)", "if (false && marks.length === 0)"],
    ["QA ignores an unexpected focus mark", "choropleth.mjs", "else if (!focus && marks.length)", "else if (false && marks.length)"],
    ["unresolved focus place not reported", "choropleth.mjs", 'if (status.kind === "unresolved") return', 'if (false) return'],
    ["focus place already drawn not reported", "choropleth.mjs", 'if (status.kind === "has_circle") return', 'if (false) return'],
  ];
  for (const [name, file, from, to] of mutants) {
    const path = join(copy, "runtime", "pi", file);
    const original = readFileSync(path, "utf8");
    assert.equal(original.split(from).length - 1, 1, `mutation "${name}": the text to break occurs exactly once in ${file}`);
    writeFileSync(path, original.replace(from, to));
    const run = spawnSync(process.execPath, [join(HERE, "test_symbol_map_readability.mjs")], { env: { ...process.env, SYMBOL_READABILITY_ROOT: copy }, encoding: "utf8" });
    writeFileSync(path, original);
    assert.notEqual(run.status, 0, `mutation "${name}" must turn this test red, but it stayed green`);
  }
  console.log(`test_symbol_map_readability: ok (${mutants.length} mutations all red)`);
} else {
  console.log("test_symbol_map_readability: child ok");
}
