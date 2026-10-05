#!/usr/bin/env node
// stacked_bar_100: one horizontal 0-100% bar per entity, split into segments
// (composition across many entities). Synthetic data only.
//
// Covers every drawing rule (segment order, sort, highlight, widths that end
// exactly at 100%, printed values that are the row's own rounded values and
// are never adjusted, the rounding note, segment names above the first bar or
// a one-line key, in-bar labels only where they fit, the 1px gap, distinct
// greys, the axis), every lint blocker both refused and accepted at its
// boundary, the lint warnings, the spec validation, the schema (checked
// structurally: no JSON Schema library is available), render QA on the typical
// cases, and SVG hash snapshots of four typical cases.
//
// Values are printed per segment_values. The default is "highlight_column" (only the
// highlight segment's value, in a column right of the bars); "in_bar" is the opt-in that prints
// every value inside its segment. The in-bar rules are tested with segment_values "in_bar" named
// (specIn below); everything else leaves it out and so runs on the default.
//
//   node scripts/test_viz_stacked_bar_100.mjs            compare with the fixture
//   node scripts/test_viz_stacked_bar_100.mjs --update   rewrite the fixture
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHART_TYPES, HOUSE_PALETTES, fmtSpec, isWideChar, lintVizSpec, renderVizBundle, renderVizMobileSvg, renderVizSvg, validateVizSpec } from "../runtime/pi/viz.mjs";
import { resolveEconomyDisplayName } from "../runtime/pi/economy_names.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { LATIN_ADVANCE_WIDTHS, LATIN_BOLD_ADVANCE_WIDTHS, TEXT_WIDTH_FACTORS } from "../runtime/pi/render_qa_geometry.mjs";
import { parseXml } from "../runtime/pi/render_qa_svg.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = join(here, "..", "fixtures", "viz-stacked-bar-100-snapshots.json");
const UPDATE = process.argv.includes("--update");
const HOUSE = HOUSE_PALETTES.house;
const NOTE_ZH = "因四舍五入，各项相加可能不等于100%";
const NOTE_EN = "Figures may not add up to 100% because of rounding";
const SUM_MESSAGE = "compute shares in SQL so that each row sums to 100";

// ---------------------------------------------------------------------------
// Specs and data
// ---------------------------------------------------------------------------
function spec(overrides = {}) {
  return {
    schema_version: "0.7.0", reader_task: "part_to_whole", takeaway: "t", title: "示例数据：各国就业构成", subtitle: "示例数据",
    alt: "A stacked bar chart of synthetic shares by segment for each entity.", source_note: "示例数据（合成）",
    claim_id: "claim-stacked", sql: "SELECT 1", unit: "%", highlight_values: [], direct_labels: true, annotations: [],
    language: "zh", chart_type: "stacked_bar_100", category_field: "c", series_field: "s", value_field: "v",
    ...overrides,
  };
}

// A spec that asks for the in-bar values by name (the default is the highlight column).
const specIn = (overrides = {}) => spec({ segment_values: "in_bar", ...overrides });

// [[entity, {segment: value, ...}], ...] -> long rows, in that order.
function rowsOf(table) {
  return table.flatMap(([c, parts]) => Object.entries(parts).map(([s, v]) => ({ c, s, v })));
}

// 25 entities x 3 sectors, 1 decimal, every row exactly 100.0 (built in tenths
// so the sums are exact). Segment 农业 runs 1-70, 工业 10-35, 服务业 is the
// rest; the first rows have a small segment under 4% so labels must drop out.
const ENTITY_NAMES = ["甲国", "乙国", "丙国", "丁国", "戊国", "己国", "庚国", "辛国", "壬国", "癸国", "子国", "丑国", "寅国", "卯国", "辰国", "巳国", "午国", "未国", "申国", "酉国", "戌国", "亥国", "壹国", "贰国", "叁国"];
function sectorRows() {
  let seed = 20261002;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  return rowsOf(ENTITY_NAMES.map((name, i) => {
    const agriculture = Math.round((1 + 69 * Math.pow(i / 24, 1.6)) * 10);
    const industry = Math.round((10 + 25 * next()) * 10);
    return [name, { 农业: agriculture / 10, 工业: industry / 10, 服务业: (1000 - agriculture - industry) / 10 }];
  }));
}
const SECTOR_SPEC = { segment_order: ["农业", "工业", "服务业"], sort_segment: "农业", highlight_segment: "农业" };

// ---------------------------------------------------------------------------
// Reading a rendered SVG, independently of the renderer
// ---------------------------------------------------------------------------
function read(svg) {
  const nodes = [];
  (function walk(node) { nodes.push(node); node.children.forEach(walk); })(parseXml(svg));
  const segments = nodes.filter((n) => n.tag === "rect" && n.attrs["data-role"] === "stacked-segment").map((n) => ({
    category: n.attrs["data-category"], series: n.attrs["data-series"], value: Number(n.attrs["data-value"]),
    x: Number(n.attrs.x), y: Number(n.attrs.y), w: Number(n.attrs.width), h: Number(n.attrs.height),
    fill: n.attrs.fill, stroke: n.attrs.stroke, strokeWidth: n.attrs["stroke-width"], docIndex: n.docIndex,
  }));
  const texts = nodes.filter((n) => n.tag === "text").map((n) => ({
    role: n.attrs["data-role"] ?? null, x: Number(n.attrs.x), y: Number(n.attrs.y), anchor: n.attrs["text-anchor"] ?? "start",
    size: Number(n.attrs["font-size"]), weight: n.attrs["font-weight"] ?? "400", fill: n.attrs.fill, text: n.text,
    halo: n.attrs.stroke ?? null, docIndex: n.docIndex,
  }));
  const bars = [...new Set(segments.map((s) => s.y))].sort((a, b) => a - b).map((y) => segments.filter((s) => s.y === y).sort((p, q) => p.x - q.x));
  const gridLines = nodes.filter((n) => n.tag === "line" && n.attrs["data-role"] === "grid-line").map((n) => ({ x: Number(n.attrs.x1), y1: Number(n.attrs.y1), y2: Number(n.attrs.y2), stroke: n.attrs.stroke, docIndex: n.docIndex }));
  const swatches = nodes.filter((n) => n.tag === "rect" && n.attrs["data-role"] === "legend-swatch").map((n) => ({ x: Number(n.attrs.x), y: Number(n.attrs.y), fill: n.attrs.fill }));
  const rects = nodes.filter((n) => n.tag === "rect");
  const viewBox = nodes.find((n) => n.tag === "svg")?.attrs.viewBox.split(" ").map(Number);
  return {
    nodes, segments, texts, bars, gridLines, swatches, rects, width: viewBox[2], height: viewBox[3],
    plotLeft: Math.min(...segments.map((s) => s.x)), plotRight: Math.max(...segments.map((s) => s.x + s.w)),
    role: (name) => texts.filter((t) => t.role === name),
  };
}

// The estimated ink box of a text, the way render QA measures it (same
// per-glyph tables, 1.05 margin, ascent 0.8em, descent 0.25em), re-derived
// here from the exported tables.
function boxOf(t) {
  const bold = t.weight === "bold" || Number(t.weight) >= 600;
  const table = bold ? LATIN_BOLD_ADVANCE_WIDTHS : LATIN_ADVANCE_WIDTHS;
  let units = 0;
  for (const ch of Array.from(t.text)) units += /\s/.test(ch) ? TEXT_WIDTH_FACTORS.space : isWideChar(ch) ? TEXT_WIDTH_FACTORS.cjk : (table[ch] ?? 1.02);
  const w = units * t.size * TEXT_WIDTH_FACTORS.safetyMargin;
  const x = t.anchor === "middle" ? t.x - w / 2 : t.anchor === "end" ? t.x - w : t.x;
  return { x, y: t.y - 0.8 * t.size, w, h: 1.05 * t.size };
}
const labelWidth = (text) => boxOf({ text, size: 12, anchor: "start", x: 0, y: 0, weight: "400" }).w;
const intersects = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;

function contrast(hexA, hexB) {
  const lum = (hex) => {
    const v = parseInt(hex.replace("#", ""), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  };
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// What "objective QA passes" means for every rendered case: render QA
// (geometry + contrast), the 12px font scan, no non-finite or undefined
// tokens, and this form's own rules: no text other than a bar's own value
// label touches any segment, every value label sits inside its segment with
// 4px padding on each side, and all text stays inside the viewBox.
function assertQaClean(label, svg) {
  const qa = runRenderQa({ desktop: svg });
  const failures = [...qa.viewports.desktop.geometry.failures, ...qa.viewports.desktop.contrast.failures];
  assert.deepEqual(failures.map((f) => `${f.rule}: ${f.message}`), [], `${label}: render QA is clean`);
  assert.equal(qa.passed, true, `${label}: render QA passed`);
  for (const match of svg.matchAll(/font-size="([\d.]+)"/g)) assert.ok(Number(match[1]) >= 12, `${label}: no text below 12px (${match[1]})`);
  assert.ok(!/NaN|undefined|Infinity|\bnull\b/.test(svg), `${label}: no non-finite or undefined tokens`);
  const v = read(svg);
  for (const t of v.texts) {
    const box = boxOf(t);
    assert.ok(box.x >= -0.01 && box.x + box.w <= v.width + 0.01 && box.y >= -0.01 && box.y + box.h <= v.height + 0.01, `${label}: "${t.text}" stays inside the viewBox`);
    if (t.role === "stacked-value") {
      const owner = v.segments.filter((s) => s.x <= t.x && t.x <= s.x + s.w && s.y <= t.y && t.y <= s.y + s.h);
      assert.equal(owner.length, 1, `${label}: value label "${t.text}" sits on exactly one segment`);
      const [s] = owner;
      assert.ok(box.x >= s.x + 4 - 0.01 && box.x + box.w <= s.x + s.w - 4 + 0.01, `${label}: value label "${t.text}" has 4px padding each side (box ${box.x.toFixed(2)}..${(box.x + box.w).toFixed(2)} in ${s.x}..${(s.x + s.w).toFixed(2)})`);
      assert.ok(box.y >= s.y && box.y + box.h <= s.y + s.h, `${label}: value label "${t.text}" sits inside the bar height`);
    } else {
      for (const s of v.segments) assert.ok(!intersects(box, s), `${label}: "${t.text}" (${t.role ?? "axis"}) does not touch segment ${s.category}/${s.series}`);
    }
  }
}

const printed = (v) => v.role("stacked-value").map((t) => t.text);
function barOf(v, category) { return v.bars.find((bar) => bar[0].category === category); }
const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// 1. Registry, validation, mobile route, schema
// ---------------------------------------------------------------------------
{
  assert.equal(CHART_TYPES.at(-1), "stacked_bar_100", "the type is registered at the end of CHART_TYPES");
  assert.equal(CHART_TYPES.at(-2), "treemap", "...right after treemap");
  assert.deepEqual(validateVizSpec(spec()), [], "a typical spec validates");
  for (const field of ["category_field", "series_field", "value_field"]) {
    const broken = spec(); delete broken[field];
    assert.ok(validateVizSpec(broken).includes(`Missing required field '${field}'`), `${field} is required`);
  }
  const refused = (overrides, text) => assert.ok(validateVizSpec(spec(overrides)).some((e) => e.includes(text)), `${JSON.stringify(overrides)} is refused (${text})`);
  const accepted = (overrides) => assert.deepEqual(validateVizSpec(spec(overrides)), [], `${JSON.stringify(overrides)} is accepted`);
  accepted({ decimals: 0 }); accepted({ decimals: 1 });
  refused({ decimals: 2 }, "decimals must be 0 or 1"); refused({ decimals: "1" }, "decimals must be 0 or 1");
  accepted({ sort: "asc" }); accepted({ sort: "desc" }); accepted({ sort: "none" });
  refused({ sort: "up" }, "sort must be asc, desc or none");
  accepted({ segment_order: ["a"] }); accepted({ segment_order: ["a", "b", "c", "d", "e"] });
  refused({ segment_order: [] }, "segment_order must list 1 to 5");
  refused({ segment_order: ["a", "b", "c", "d", "e", "f"] }, "segment_order must list 1 to 5");
  refused({ segment_order: ["a", ""] }, "segment_order must list 1 to 5");
  refused({ segment_order: "a" }, "segment_order must list 1 to 5");
  refused({ segment_order: ["a", "a"] }, "segment_order must not repeat");
  refused({ sort_segment: "" }, "sort_segment must be a non-empty segment name");
  refused({ highlight_segment: 3 }, "highlight_segment must be a non-empty segment name");
  accepted({ segment_values: "in_bar" }); accepted({ segment_values: "highlight_column" });
  refused({ segment_values: "outside" }, "segment_values must be one of");

  const rows = sectorRows();
  assert.equal(renderVizMobileSvg(spec(SECTOR_SPEC), rows), renderVizSvg(spec(SECTOR_SPEC), rows), "the mobile route draws the desktop renderer (no mobile layout)");
  const bundle = renderVizBundle(spec(SECTOR_SPEC), rows, { mobilePages: true });
  assert.equal(bundle.mobile, bundle.desktop, "renderVizBundle: mobile is the desktop SVG");

  // The renderer is deterministic and leaves its inputs alone.
  const s1 = spec(SECTOR_SPEC), r1 = sectorRows();
  const snapshotS = JSON.stringify(s1), snapshotR = JSON.stringify(r1);
  assert.equal(renderVizSvg(s1, r1), renderVizSvg(s1, r1), "two renders of the same input are byte-identical");
  assert.equal(JSON.stringify(s1), snapshotS, "the spec is not mutated");
  assert.equal(JSON.stringify(r1), snapshotR, "the rows are not mutated");
  console.log("stacked_bar_100: registry, validation, mobile route, determinism -- PASS");
}

{
  const schema = JSON.parse(readFileSync(join(here, "..", "schemas", "newsroom-viz-spec.schema.json"), "utf8"));
  const enumList = schema.properties.chart_type.enum;
  assert.equal(enumList[enumList.indexOf("treemap") + 1], "stacked_bar_100", "the schema enum lists the type right after treemap");
  assert.equal(schema.additionalProperties, false, "the schema still refuses unknown fields");
  const p = schema.properties;
  assert.deepEqual([p.segment_order.type, p.segment_order.items.type, p.segment_order.minItems, p.segment_order.maxItems, p.segment_order.uniqueItems], ["array", "string", 1, 5, true]);
  assert.equal(p.sort_segment.type, "string");
  assert.equal(p.highlight_segment.type, "string");
  assert.deepEqual(p.segment_values.enum, ["in_bar", "highlight_column"]);
  assert.match(p.segment_values.description, /highlight_column \(default\)/, "the schema names highlight_column as the default");
  assert.doesNotMatch(p.segment_values.description, /in_bar \(default\)/, "...and not in_bar");
  const block = schema.allOf.find((entry) => entry.if?.properties?.chart_type?.const === "stacked_bar_100");
  assert.ok(block, "the schema has an if/then block for the type");
  assert.deepEqual(block.then.required, ["category_field", "series_field", "value_field", "unit"]);
  assert.equal(block.then.properties.unit.const, "%", "the schema pins unit to %");
  assert.deepEqual(block.then.properties.decimals.enum, [0, 1], "the schema limits decimals to 0 or 1");
  // Every spec field this form uses is a declared schema property (the schema refuses unknown fields).
  const full = spec({ ...SECTOR_SPEC, sort: "desc", decimals: 1, segment_values: "in_bar", category_names: "iso3", subtitle: "s", direct_labels: true });
  for (const key of Object.keys(full)) assert.ok(key in p, `schema property '${key}' exists`);
  console.log("stacked_bar_100: schema (enum, properties, if/then) -- PASS");
}

// ---------------------------------------------------------------------------
// 2. Drawing rules
// ---------------------------------------------------------------------------
const THREE = rowsOf([
  ["甲", { X: 10.0, Y: 30.0, Z: 60.0 }],
  ["乙", { X: 40.0, Y: 25.5, Z: 34.5 }],
  ["丙", { X: 70.0, Y: 10.0, Z: 20.0 }],
  ["丁", { X: 40.0, Y: 20.0, Z: 40.0 }],
]);
const seriesOrder = (bar) => bar.map((s) => s.series);
const barCategories = (v) => v.bars.map((bar) => bar[0].category);


{
  // Segment order, sort, highlight: the defaults and every override.
  const draw = (overrides) => read(renderVizSvg(spec(overrides), THREE));
  const fillOf = (v, series) => v.segments.find((s) => s.series === series).fill;

  let v = draw({});
  assert.deepEqual(seriesOrder(v.bars[0]), ["X", "Y", "Z"], "default order: first appearance (the first segment is the highlight)");
  assert.deepEqual(barCategories(v), ["丙", "乙", "丁", "甲"], "default sort: descending by the first segment; the tie keeps SQL order (乙 before 丁)");
  assert.equal(fillOf(v, "X"), HOUSE.accent, "the highlight defaults to the sort segment");

  v = draw({ highlight_segment: "Z" });
  assert.deepEqual(seriesOrder(v.bars[0]), ["Z", "X", "Y"], "default order: highlight_segment first, then first appearance");
  assert.equal(fillOf(v, "Z"), HOUSE.accent);
  assert.deepEqual(barCategories(v), ["甲", "丁", "乙", "丙"], "the sort segment defaults to the first in segment order (Z here)");

  v = draw({ sort_segment: "Y" });
  assert.deepEqual(seriesOrder(v.bars[0]), ["Y", "X", "Z"], "with only sort_segment: it is the highlight, so it is drawn first");
  assert.equal(fillOf(v, "Y"), HOUSE.accent);
  assert.deepEqual(barCategories(v), ["甲", "乙", "丁", "丙"], "bars are ordered by the Y segment's own value");

  v = draw({ segment_order: ["Z", "Y"] });
  assert.deepEqual(seriesOrder(v.bars[0]), ["Z", "Y", "X"], "a segment missing from segment_order is appended, never dropped");
  assert.equal(v.segments.length, 12, "every row is drawn");
  assert.equal(fillOf(v, "Z"), HOUSE.accent, "the highlight defaults to the first of segment_order");

  v = draw({ segment_order: ["Y", "X", "Z"], highlight_segment: "Z" });
  assert.deepEqual(seriesOrder(v.bars[0]), ["Y", "X", "Z"], "segment_order is drawn as listed, left to right");
  assert.equal(fillOf(v, "Z"), HOUSE.accent, "the highlight can be any segment");
  assert.deepEqual(barCategories(v), ["甲", "乙", "丁", "丙"], "the sort segment defaults to the first of segment_order (Y)");

  v = draw({ sort_segment: "Z", segment_order: ["X", "Y", "Z"] });
  assert.deepEqual(seriesOrder(v.bars[0]), ["X", "Y", "Z"]);
  assert.equal(fillOf(v, "Z"), HOUSE.accent, "highlight defaults to sort_segment");
  assert.deepEqual(barCategories(v), ["甲", "丁", "乙", "丙"], "bars are ordered by the sort segment, not by the first segment");

  assert.deepEqual(barCategories(draw({ sort: "asc" })), ["甲", "乙", "丁", "丙"], "sort asc: ascending by the sort segment, ties in SQL order");
  assert.deepEqual(barCategories(draw({ sort: "none" })), ["甲", "乙", "丙", "丁"], "sort none keeps the SQL row order");
  assert.deepEqual(barCategories(draw({ sort: "desc" })), ["丙", "乙", "丁", "甲"], "sort desc is the default");

  // A bar that lacks the sort segment counts as 0 for the ordering.
  const gap = rowsOf([["甲", { X: 50, Y: 50 }], ["乙", { Y: 100 }], ["丙", { X: 20, Y: 80 }]]);
  assert.deepEqual(barCategories(read(renderVizSvg(spec({ sort_segment: "X" }), gap))), ["甲", "丙", "乙"], "a missing sort segment sorts as 0");
  console.log("stacked_bar_100: segment order, sort, highlight defaults and overrides -- PASS");
}

{
  // Geometry: widths are value / the row's own sum, every bar starts at the 0
  // gridline and ends exactly on the 100% gridline, neighbours touch.
  const rows = rowsOf([
    ["甲", { X: 10.0, Y: 30.0, Z: 60.0 }],
    ["乙", { X: 33.3, Y: 33.3, Z: 33.4 }],
    ["丙", { X: 20.2, Y: 30.3, Z: 50.5 }], // sums to 101.0: still drawn to exactly 100%
    ["丁", { X: 19.8, Y: 29.7, Z: 49.5 }], // sums to 99.0
  ]);
  const v = read(renderVizSvg(spec({ sort: "none" }), rows));
  const plotW = v.plotRight - v.plotLeft;
  assert.equal(v.bars.length, 4);
  for (const bar of v.bars) {
    const sum = bar.reduce((total, s) => total + s.value, 0);
    assert.ok(near(bar[0].x, v.plotLeft), `${bar[0].category}: starts at the 0 baseline`);
    assert.ok(near(bar.at(-1).x + bar.at(-1).w, v.plotRight), `${bar[0].category}: ends exactly at 100% (sum ${sum.toFixed(1)})`);
    bar.forEach((s, i) => {
      assert.ok(near(s.w, (plotW * s.value) / sum, 0.021), `${s.category}/${s.series}: width is value / row sum (${s.w} vs ${((plotW * s.value) / sum).toFixed(3)})`);
      if (i > 0) assert.ok(near(bar[i - 1].x + bar[i - 1].w, s.x), `${s.category}/${s.series}: touches the previous segment`);
      assert.equal(s.stroke, HOUSE.paper, "each segment has a paper-coloured stroke");
      assert.equal(s.strokeWidth, "1", "...1px wide, which makes the 1px white gap between neighbours");
    });
  }
  const gridXs = v.gridLines.map((g) => g.x);
  assert.equal(gridXs.length, 5, "five gridlines: 0/25/50/75/100%");
  [0, 25, 50, 75, 100].forEach((tick, i) => assert.ok(near(gridXs[i], v.plotLeft + (plotW * tick) / 100), `gridline ${tick}% sits at its own position`));
  assert.ok(v.gridLines.every((g) => g.docIndex < Math.min(...v.segments.map((s) => s.docIndex))), "gridlines are painted before every segment");

  // A segment missing from a bar is drawn as 0 (no rect); the bar still ends at 100%.
  const holes = read(renderVizSvg(spec({ sort: "none", segment_order: ["X", "Y", "Z"] }), rowsOf([["甲", { X: 50, Z: 50 }], ["乙", { X: 20, Y: 30, Z: 50 }]])));
  assert.deepEqual(seriesOrder(holes.bars[0]), ["X", "Z"], "a missing segment has no rect");
  assert.ok(near(holes.bars[0].at(-1).x + holes.bars[0].at(-1).w, holes.plotRight), "the bar with a missing segment still ends at 100%");
  // A zero value is no rect either, and an all-zero bar draws nothing but its name.
  const zeros = read(renderVizSvg(spec({ sort: "none" }), rowsOf([["甲", { X: 0, Y: 100 }], ["乙", { X: 0, Y: 0 }], ["丙", { X: 40, Y: 60 }]])));
  assert.deepEqual(zeros.bars.map((bar) => bar.map((s) => s.series)), [["Y"], ["X", "Y"]], "zero values draw no rect; an all-zero bar draws no rects");
  assert.ok(zeros.role("stacked-entity").some((t) => t.text === "乙"), "...but keeps its entity name");
  console.log("stacked_bar_100: widths = value / row sum, bars end at exactly 100%, 1px gap, gridlines first -- PASS");
}

{
  // Printed values: the row's own value, rounded with the spec's decimals, never adjusted.
  const rows = rowsOf([["甲", { X: 33.4, Y: 33.3, Z: 33.3 }], ["乙", { X: 12.34, Y: 50.56, Z: 37.1 }]]);
  for (const decimals of [0, 1]) {
    const s = specIn({ sort: "none", decimals, segment_order: ["X", "Y", "Z"] });
    const v = read(renderVizSvg(s, rows));
    for (const label of v.role("stacked-value")) {
      const owner = v.segments.find((seg) => seg.x <= label.x && label.x <= seg.x + seg.w && seg.y <= label.y && label.y <= seg.y + seg.h);
      assert.equal(label.text, fmtSpec(s, owner.value, "", decimals), `decimals ${decimals}: ${owner.category}/${owner.series} prints its own value rounded with fmtSpec`);
    }
    assert.equal(v.role("stacked-value").length, 6, `decimals ${decimals}: every segment is wide enough for its label`);
  }
  assert.deepEqual(printed(read(renderVizSvg(specIn({ sort: "none", decimals: 0, segment_order: ["X", "Y", "Z"] }), rows))), ["33", "33", "33", "12", "51", "37"], "decimals 0: 33.4/33.3/33.3 stay 33/33/33 (no largest-remainder adjustment)");
  assert.deepEqual(printed(read(renderVizSvg(specIn({ sort: "none", decimals: 1, segment_order: ["X", "Y", "Z"] }), rows))), ["33.4", "33.3", "33.3", "12.3", "50.6", "37.1"], "decimals 1");
  // Default decimals: 1 when any value is not a whole number, else 0.
  assert.deepEqual(printed(read(renderVizSvg(specIn({ sort: "none", segment_order: ["X", "Y", "Z"] }), rowsOf([["甲", { X: 20, Y: 30, Z: 50 }]])))), ["20", "30", "50"], "default decimals: 0 when every value is whole");
  assert.deepEqual(printed(read(renderVizSvg(specIn({ sort: "none", segment_order: ["X", "Y", "Z"] }), rowsOf([["甲", { X: 20, Y: 30, Z: 50 }], ["乙", { X: 20.5, Y: 29.5, Z: 50 }]])))), ["20.0", "30.0", "50.0", "20.5", "29.5", "50.0"], "default decimals: 1 as soon as one value is not whole");
  // The explicit style (DECIMAL_MODE) cannot change what is printed.
  for (const segment_values of ["in_bar", "highlight_column"]) {
    assert.equal(renderVizSvg(spec({ style_id: "house", segment_values, ...SECTOR_SPEC }), sectorRows()), renderVizSvg(spec({ segment_values, ...SECTOR_SPEC }), sectorRows()), `style_id house prints the same text and marks as the default (${segment_values})`);
  }
  console.log("stacked_bar_100: printed value = the row's own value, rounded only with fmtSpec, never adjusted -- PASS");
}

{
  // The rounding note: only when some row's printed values do not add to 100 at that precision.
  const exact = rowsOf([["甲", { X: 33.4, Y: 33.3, Z: 33.3 }], ["乙", { X: 20.0, Y: 30.0, Z: 50.0 }]]);
  const noteTexts = (s, rows) => read(renderVizSvg(s, rows)).role("stacked-rounding-note").map((t) => t.text);
  assert.deepEqual(noteTexts(specIn({ decimals: 1 }), exact), [], "decimals 1, rows that add to exactly 100.0: no note");
  assert.deepEqual(noteTexts(specIn({ decimals: 0 }), exact), [NOTE_ZH], "decimals 0 turns 33.4/33.3/33.3 into 33/33/33: the zh note appears, once");
  assert.deepEqual(noteTexts(specIn({ decimals: 0, language: "en" }), exact), [NOTE_EN], "the en note");
  const whole = rowsOf([["甲", { X: 20, Y: 30, Z: 50 }], ["乙", { X: 99, Y: 1, Z: 0 }]]);
  assert.deepEqual(noteTexts(specIn({ decimals: 0 }), whole), [], "decimals 0 with whole numbers that add to 100: no note");
  assert.deepEqual(noteTexts(specIn({}), whole), [], "...and with the default decimals");
  assert.deepEqual(noteTexts(specIn({ decimals: 0 }), rowsOf([["甲", { X: 20, Y: 30, Z: 50 }], ["乙", { X: 12.4, Y: 30.4, Z: 57.2 }]])), [NOTE_ZH], "one off row is enough");
  // A row that sums to 99.9 at the data's own precision is off by data, not by rounding: still a note (the printed values do not add to 100).
  assert.deepEqual(noteTexts(specIn({ decimals: 1 }), rowsOf([["甲", { X: 33.3, Y: 33.3, Z: 33.3 }]])), [NOTE_ZH], "printed values that sum to 99.9 get the note");
  // The note's only number is the 100% of the work-order text; it sits below the bars, left aligned, muted.
  const v = read(renderVizSvg(specIn({ decimals: 0 }), exact));
  const [note] = v.role("stacked-rounding-note");
  assert.ok(note.y > Math.max(...v.segments.map((s) => s.y + s.h)), "the note sits below the last bar");
  assert.equal(note.fill, HOUSE.muted, "...in the muted text colour");
  assert.equal(note.size, 12);
  // The highlight column prints one figure per bar, so there is nothing to add up: no note.
  assert.deepEqual(noteTexts(spec({ decimals: 0, segment_values: "highlight_column" }), exact), [], "highlight_column: no rounding note (one printed figure per bar)");
  assert.deepEqual(noteTexts(spec({ decimals: 0 }), exact), [], "the default is the highlight column: no rounding note either");
  console.log("stacked_bar_100: rounding note (zh/en), only when printed values do not add to 100 -- PASS");
}

for (const extra of [{}, { segment_values: "in_bar" }]) {
  // Segment names: once each, centred on their own segment, directly above the
  // first bar, in segment order. Axis and gridlines. The default values (the highlight
  // column) and the in-bar values both leave all of this where it is.
  const v = read(renderVizSvg(spec({ ...SECTOR_SPEC, ...extra }), sectorRows()));
  const names = v.role("stacked-segment-name");
  const first = v.bars[0];
  assert.deepEqual(names.map((n) => n.text), ["农业", "工业", "服务业"], "each segment name appears exactly once, in segment order");
  assert.deepEqual(first.map((s) => s.series), ["农业", "工业", "服务业"]);
  names.forEach((name, i) => {
    assert.equal(name.anchor, "middle");
    assert.ok(near(name.x, first[i].x + first[i].w / 2, 0.02), `"${name.text}" is centred on its own segment`);
    assert.ok(name.y < first[0].y && first[0].y - name.y < 20, `"${name.text}" sits directly above the first bar`);
  });
  assert.equal(names[0].weight, "700", "the highlight's name is bold");
  assert.equal(names[0].fill, HOUSE.accent, "...in the accent text colour");
  assert.ok(names.slice(1).every((n) => n.weight === "400" && n.fill === HOUSE.ink), "the other names are regular ink");
  assert.equal(v.role("stacked-key").length, 0, "no key when the names fit");
  assert.equal(v.swatches.length, 0, "no swatches when the names fit");

  // The axis: 0/25/50/75/100%, light gridlines, above everything, the % only on the last tick (house style).
  const ticks = v.texts.filter((t) => t.role === null && /^(0|25|50|75|100)%?$/.test(t.text));
  assert.deepEqual(ticks.map((t) => t.text), ["0", "25", "50", "75", "100%"], "axis ticks 0/25/50/75/100%");
  ticks.forEach((tick, i) => {
    assert.equal(tick.anchor, "middle");
    assert.ok(near(tick.x, v.gridLines[i].x), `tick ${tick.text} sits on its gridline`);
    assert.ok(tick.y < names[0].y, "the axis row is above the segment-name row");
    assert.equal(tick.fill, HOUSE.muted, "ticks are muted text");
    assert.ok(v.gridLines[i].y1 > tick.y && v.gridLines[i].y1 < names[0].y, "each gridline starts just under its tick");
    assert.ok(v.gridLines[i].y2 > Math.max(...v.segments.map((s) => s.y + s.h)), "...and runs past the last bar");
  });
  assert.ok(v.gridLines.every((g) => g.stroke === HOUSE.grid), "gridlines are the light house grey");
  // No number is printed that is not a value_field value or an axis tick: the bars' own value labels in the bars, or the
  // highlight column (the value and a %) by default.
  const numeric = v.texts.filter((t) => /\d/.test(t.text) && !ticks.includes(t));
  const valueRole = extra.segment_values === "in_bar" ? "stacked-value" : "stacked-column-value";
  assert.ok(numeric.length > 0 && numeric.every((t) => t.role === valueRole), `the only other numbers are the ${valueRole} texts`);
  const allValues = new Set(sectorRows().map((row) => fmtSpec(spec(), row.v, "", 1)));
  assert.ok(numeric.every((t) => allValues.has(t.text.replace(/%$/, ""))), "...each one a value_field value rounded with fmtSpec");
}
console.log("stacked_bar_100: segment names (once, centred, above the first bar), axis and gridlines, in both value modes -- PASS");

{
  // The key fallback: when a name does not fit its own segment on the first bar
  // (or direct labels are off), one key line above the chart, swatch + name, no box.
  const keyCheck = (label, v, expected) => {
    assert.equal(v.role("stacked-segment-name").length, 0, `${label}: no names above the first bar`);
    const keys = v.role("stacked-key");
    assert.deepEqual(keys.map((k) => k.text), expected, `${label}: the key lists the segments in segment order`);
    assert.equal(new Set(keys.map((k) => k.y)).size, 1, `${label}: the key is one line`);
    const tick = v.texts.find((t) => t.role === null && t.text === "0");
    assert.ok(keys[0].y < tick.y, `${label}: the key sits above the axis row`);
    assert.equal(v.swatches.length, expected.length, `${label}: one swatch per name`);
    keys.forEach((key, i) => {
      const own = v.segments.find((s) => s.series === key.text);
      assert.equal(v.swatches[i].fill, own.fill, `${label}: swatch ${i} has its segment's fill`);
      assert.ok(key.x - v.swatches[i].x > 10 && key.x - v.swatches[i].x <= 16, `${label}: the name follows its swatch`);
    });
    assert.equal(keys[0].weight, "700", `${label}: the highlight is bold`);
    // No legend box: apart from the page background, the only rects are bars and swatches.
    const others = v.rects.filter((r) => !["stacked-segment", "legend-swatch"].includes(r.attrs["data-role"]));
    assert.ok(others.every((r) => Number(r.attrs.width) >= v.width), `${label}: no box around the key`);
  };
  const thin = rowsOf([["甲", { X: 97, Y: 2, Z: 1 }], ["乙", { X: 50, Y: 30, Z: 20 }]]);
  keyCheck("a thin segment on the first bar", read(renderVizSvg(spec({}), thin)), ["X", "Y", "Z"]);
  keyCheck("direct_labels false", read(renderVizSvg(spec({ ...SECTOR_SPEC, direct_labels: false }), sectorRows())), ["农业", "工业", "服务业"]);
  // The names-or-key decision is per chart, on the first bar only: a thin segment on a later bar keeps the names.
  const later = read(renderVizSvg(spec({ sort: "none" }), rowsOf([["甲", { X: 50, Y: 30, Z: 20 }], ["乙", { X: 97, Y: 2, Z: 1 }]])));
  assert.equal(later.role("stacked-segment-name").length, 3, "a thin segment on a later bar does not force the key");
  // Exactly at the fit boundary: the name needs its own width plus 4px each side.
  const widthOfName = (name, bold) => boxOf({ text: name, size: 12, anchor: "start", x: 0, y: 0, weight: bold ? "700" : "400" }).w;
  const single = read(renderVizSvg(spec({ sort: "none" }), rowsOf([["甲", { X: 50, Y: 30, Z: 20 }]])));
  const plotW = single.plotRight - single.plotLeft;
  const needed = (widthOfName("Z", false) + 8) / plotW * 100; // percent of the bar the narrowest name needs
  const below = Math.ceil((needed - 0.2) * 10) / 10, above = Math.ceil((needed + 0.2) * 10) / 10;
  const probe = (zTenths) => read(renderVizSvg(spec({ sort: "none" }), rowsOf([["甲", { X: (1000 - 200 - zTenths) / 10, Y: 20, Z: zTenths / 10 }]])));
  assert.equal(probe(Math.round(below * 10)).role("stacked-segment-name").length, 0, `a Z segment of ${below}% is too narrow for its name: key`);
  assert.equal(probe(Math.round(above * 10)).role("stacked-segment-name").length, 3, `a Z segment of ${above}% fits its name: names`);

  // A key that is too wide for one line wraps instead of running off the page.
  const long = ["Alpha alpha alpha alpha alpha alpha", "Bravo bravo bravo bravo bravo bravo", "Charlie charlie charlie charlie", "Delta delta delta delta delta delta", "Echo echo echo echo echo echo echo"];
  const wide = rowsOf([["甲", Object.fromEntries(long.map((name) => [name, 20]))], ["乙", Object.fromEntries(long.map((name, i) => [name, [10, 30, 20, 25, 15][i]]))]]);
  const wrapped = read(renderVizSvg(spec({ language: "en" }), wide));
  assert.ok(new Set(wrapped.role("stacked-key").map((k) => k.y)).size >= 2, "a key too wide for one line wraps to a second line");
  assertQaClean("wrapped key", renderVizSvg(spec({ language: "en" }), wide));
  console.log("stacked_bar_100: key fallback (one line, swatches, no box, wraps only when it must) -- PASS");
}

{
  // In-bar value labels (segment_values "in_bar", the opt-in): drawn only where the label fits inside its segment
  // with 4px of padding each side. Checked against an independent estimate of
  // the label's width (re-derived here from render QA's own glyph tables).
  const check = (label, s, rows) => {
    const v = read(renderVizSvg(s, rows));
    const decimals = s.decimals ?? (rows.some((row) => !Number.isInteger(row.v)) ? 1 : 0);
    let kept = 0, dropped = 0;
    for (const seg of v.segments) {
      const text = fmtSpec(s, seg.value, "", decimals);
      const need = labelWidth(text) + 8;
      const drawn = v.role("stacked-value").filter((t) => t.x >= seg.x && t.x <= seg.x + seg.w && t.y >= seg.y && t.y <= seg.y + seg.h);
      if (Math.abs(need - seg.w) < 0.03) continue; // exactly on the boundary: either answer is acceptable
      if (need <= seg.w) {
        kept += 1;
        assert.equal(drawn.length, 1, `${label}: ${seg.category}/${seg.series} (${seg.w}px wide, needs ${need.toFixed(2)}) keeps its label`);
        assert.equal(drawn[0].text, text, `${label}: the label is the segment's own value`);
        assert.ok(near(drawn[0].x, seg.x + seg.w / 2, 0.02) && drawn[0].anchor === "middle", `${label}: the label is centred in its segment`);
        const fill = drawn[0].fill.toLowerCase();
        assert.ok(contrast(fill, seg.fill) >= 4.5, `${label}: label ${fill} on ${seg.fill} has contrast >= 4.5`);
        assert.ok([HOUSE.ink.toLowerCase(), "#ffffff"].includes(fill), `${label}: labels are white or ink`);
        assert.equal(drawn[0].halo, null, `${label}: no halo is needed when the contrast already clears the floor`);
      } else {
        dropped += 1;
        assert.equal(drawn.length, 0, `${label}: ${seg.category}/${seg.series} (${seg.w}px wide, needs ${need.toFixed(2)}) drops its label`);
      }
    }
    return { kept, dropped, v };
  };

  const big = check("25 bars", specIn(SECTOR_SPEC), sectorRows());
  assert.ok(big.kept > 60 && big.dropped >= 3, `the 25-bar case has both kept (${big.kept}) and dropped (${big.dropped}) labels, so the rule is exercised both ways`);
  // White on the accent and the dark greys, ink on the light grey, whichever the contrast floor picks.
  const colourOf = (v, series) => v.role("stacked-value").filter((t) => v.segments.some((s) => s.series === series && t.x >= s.x && t.x <= s.x + s.w && t.y >= s.y && t.y <= s.y + s.h)).map((t) => t.fill.toLowerCase());
  assert.ok(colourOf(big.v, "农业").every((f) => f === "#ffffff"), "white on the accent");
  const five = rowsOf([["甲", { A: 30, B: 25, C: 20, D: 15, E: 10 }], ["乙", { A: 10, B: 20, C: 30, D: 25, E: 15 }], ["丙", { A: 20, B: 20, C: 20, D: 20, E: 20 }]]);
  const fiveV = check("5 segments", specIn({ sort: "none", segment_order: ["A", "B", "C", "D", "E"], highlight_segment: "B" }), five);
  const byFill = new Map();
  for (const t of fiveV.v.role("stacked-value")) {
    const seg = fiveV.v.segments.find((s) => t.x >= s.x && t.x <= s.x + s.w && t.y >= s.y && t.y <= s.y + s.h);
    byFill.set(seg.fill, t.fill.toLowerCase());
  }
  assert.equal(byFill.size, 5, "all five fills carry labels");
  assert.deepEqual([...byFill].map(([fill, text]) => `${fill.toLowerCase()}:${text}`).sort(), [
    "#666666:#ffffff", "#757575:#ffffff", "#9e9e9e:#1a1a1a", "#bdbdbd:#1a1a1a", "#d0021b:#ffffff",
  ], "white on the accent and the dark greys, ink on the mid and light greys");

  // Sweep one thin segment from 1.0% to 6.0% in 0.1 steps: its label appears exactly when it fits.
  let sawDrop = false, sawKeep = false;
  for (let tenths = 10; tenths <= 60; tenths += 1) {
    const rows = rowsOf([["甲", { X: (800 - tenths) / 10, Y: tenths / 10, Z: 20 }]]);
    const { kept, dropped } = check(`sweep ${tenths / 10}%`, specIn({ sort: "none", decimals: 1, segment_order: ["X", "Y", "Z"] }), rows);
    if (dropped) sawDrop = true;
    if (kept === 3) sawKeep = true;
  }
  assert.ok(sawDrop && sawKeep, "the sweep crosses the threshold (labels drop below it and come back above it)");
  // Precision changes what fits: "12.3" is wider than "12".
  const wideRow = rowsOf([["甲", { X: 4.1, Y: 15.9, Z: 80 }]]);
  const withOne = read(renderVizSvg(specIn({ sort: "none", decimals: 1, segment_order: ["X", "Y", "Z"] }), wideRow));
  const withZero = read(renderVizSvg(specIn({ sort: "none", decimals: 0, segment_order: ["X", "Y", "Z"] }), wideRow));
  assert.ok(withZero.role("stacked-value").length >= withOne.role("stacked-value").length, "fewer decimals never drop more labels");
  console.log("stacked_bar_100: in-bar labels (the in_bar opt-in) only where they fit (4px each side), label colours -- PASS");
}

{
  // Colours: one accent, distinct greys, a 1px white gap. Adjacent greys never trip QA's indistinct-adjacent-marks rule.
  const five = rowsOf([["甲", { A: 30, B: 25, C: 20, D: 15, E: 10 }], ["乙", { A: 10, B: 20, C: 30, D: 25, E: 15 }], ["丙", { A: 20, B: 0, C: 30, D: 0, E: 50 }], ["丁", { A: 100, B: 0, C: 0, D: 0, E: 0 }]]);
  const svg = renderVizSvg(spec({ sort: "none", segment_order: ["A", "B", "C", "D", "E"], highlight_segment: "C" }), five);
  const v = read(svg);
  const fillBySeries = new Map(v.segments.map((s) => [s.series, s.fill]));
  assert.equal(fillBySeries.get("C"), HOUSE.accent, "the highlight segment is the one accent");
  const greys = [...fillBySeries].filter(([series]) => series !== "C").map(([, fill]) => fill);
  assert.equal(new Set(greys).size, 4, "the other four segments have four distinct fills");
  assert.ok(greys.every((fill) => HOUSE.waffleGreySteps.map((g) => g.toLowerCase()).includes(fill.toLowerCase())), "...all taken from the house grey steps");
  assert.ok(!greys.includes(HOUSE.accent), "no grey equals the accent");
  assert.equal(new Set(fillBySeries.values()).size, 5, "one fill per segment, five segments");
  // One segment, one colour, in every bar.
  for (const seg of v.segments) assert.equal(seg.fill, fillBySeries.get(seg.series), `${seg.category}/${seg.series} uses its segment's colour`);
  // Neighbours (also across a skipped segment) never share a fill.
  for (const bar of v.bars) bar.forEach((seg, i) => { if (i > 0) assert.notEqual(seg.fill, bar[i - 1].fill, `${seg.category}: ${bar[i - 1].series} and ${seg.series} differ`); });
  const qa = runRenderQa({ desktop: svg });
  assert.ok(!qa.viewports.desktop.geometry.failures.some((f) => f.rule === "indistinct_adjacent_marks"), "no indistinct adjacent marks");
  assertQaClean("5 segments with skipped segments", svg);
  console.log("stacked_bar_100: one accent, distinct greys, 1px white gap, QA indistinct-marks clean -- PASS");
}

{
  // Entity names on the left, right-aligned against the bars; category_names localises ISO3 codes.
  const rows = rowsOf([["USA", { X: 60, Y: 40 }], ["CHN", { X: 30, Y: 70 }], ["DEU", { X: 45, Y: 55 }]]);
  for (const language of ["zh", "en"]) {
    const s = spec({ language, category_names: "iso3", sort: "none", title: language === "zh" ? "示例数据：占比" : "Sample data: shares", subtitle: language === "zh" ? "示例数据" : "Sample data" });
    const v = read(renderVizSvg(s, rows));
    const labels = v.role("stacked-entity");
    assert.deepEqual(labels.map((t) => t.text), ["USA", "CHN", "DEU"].map((code) => resolveEconomyDisplayName(code, "iso3", language)), `${language}: entity names are localised with category_names iso3`);
    assert.ok(labels.every((t, i) => t.text !== ["USA", "CHN", "DEU"][i]), `${language}: ...so they differ from the raw codes`);
    assert.deepEqual(v.bars.map((bar) => bar[0].category), ["USA", "CHN", "DEU"], `${language}: the data keeps the raw code`);
    labels.forEach((t, i) => {
      assert.equal(t.anchor, "end", "entity names are right-aligned");
      assert.ok(near(t.x, v.plotLeft - 14), "...14px left of the bars");
      assert.ok(near(t.y, v.bars[i][0].y + v.bars[i][0].h / 2 + 4), "...centred on their bar");
    });
    assertQaClean(`category_names ${language}`, renderVizSvg(s, rows));
  }
  // Without category_names the raw value is printed as is.
  assert.deepEqual(read(renderVizSvg(spec({ sort: "none" }), rows)).role("stacked-entity").map((t) => t.text), ["USA", "CHN", "DEU"]);
  console.log("stacked_bar_100: entity names on the left, category_names localisation -- PASS");
}

{
  // segment_values "highlight_column" (the default, named here explicitly): no in-bar labels; only the highlight segment's value, in a column just right of the 100% end.
  const column = spec({ ...SECTOR_SPEC, segment_values: "highlight_column" });
  const svg = renderVizSvg(column, sectorRows());
  const v = read(svg);
  assert.equal(v.role("stacked-value").length, 0, "no in-bar labels");
  const values = v.role("stacked-column-value");
  assert.equal(values.length, 25, "one column value per bar");
  const rightEdge = 1040 - 54;
  values.forEach((t, i) => {
    const bar = v.bars[i];
    const own = bar.find((s) => s.series === "农业");
    assert.equal(t.text, `${fmtSpec(column, own.value, "", 1)}%`, `${own.category}: the column prints the highlight segment's own value`);
    assert.equal(t.anchor, "end", "right-aligned");
    assert.ok(near(t.x, rightEdge), "against the right edge");
    assert.ok(near(t.y, bar[0].y + bar[0].h / 2 + 4), "on its bar's baseline");
    assert.ok(boxOf(t).x >= v.plotRight + 14 - 0.01, "at least 14px right of the 100% end");
    assert.equal(t.fill, HOUSE.ink);
  });
  const [header, ...extra] = v.role("stacked-column-header");
  assert.equal(extra.length, 0);
  assert.equal(header.text, "农业", "the column header is the highlight segment's name");
  assert.equal(header.fill, HOUSE.accent);
  assert.equal(header.weight, "700");
  assert.equal(header.anchor, "end");
  assert.ok(near(header.x, rightEdge), "the header sits above the column");
  assert.ok(header.y < v.bars[0][0].y, "...above the first bar");
  assert.equal(v.role("stacked-rounding-note").length, 0, "no rounding note: one printed figure per bar");
  const inBar = read(renderVizSvg(specIn(SECTOR_SPEC), sectorRows()));
  assert.ok(v.plotRight < inBar.plotRight, "the column takes room from the bars");
  for (const bar of v.bars) assert.ok(near(bar.at(-1).x + bar.at(-1).w, v.plotRight), "every bar still ends exactly at 100%");
  assertQaClean("highlight column", svg);
  // With the key fallback the header sits on the key row.
  const keyed = read(renderVizSvg(spec({ ...SECTOR_SPEC, segment_values: "highlight_column", direct_labels: false }), sectorRows()));
  assert.equal(keyed.role("stacked-column-header")[0].y, keyed.role("stacked-key")[0].y, "key mode: the header is on the key row");
  assertQaClean("highlight column with a key", renderVizSvg(spec({ ...SECTOR_SPEC, segment_values: "highlight_column", direct_labels: false }), sectorRows()));
  // A bar without the highlight segment prints no column value.
  const holes = read(renderVizSvg(spec({ sort: "none", segment_values: "highlight_column" }), rowsOf([["甲", { X: 60, Y: 40 }], ["乙", { Y: 100 }]])));
  assert.deepEqual(holes.role("stacked-column-value").map((t) => t.text), ["60%"], "a bar without the highlight segment has no column value");
  // A highlight name wider than the column folds onto further lines (never cut); the bars move down to make room.
  const longName = "A very long highlighted segment name for the column header";
  const longRows = rowsOf([["甲", { [longName]: 60, Other: 40 }], ["乙", { [longName]: 30, Other: 70 }]]);
  for (const direct_labels of [true, false]) {
    const longV = read(renderVizSvg(spec({ language: "en", sort: "none", segment_values: "highlight_column", highlight_segment: longName, direct_labels }), longRows));
    const headers = longV.role("stacked-column-header");
    assert.ok(headers.length >= 2, `direct_labels ${direct_labels}: the long header folds onto ${headers.length} lines`);
    assert.equal(headers.map((t) => t.text).join(" "), longName, "the folded header is the whole name");
    assert.ok(headers.every((t) => boxOf(t).x >= longV.plotRight + 14 - 0.01), "every header line stays inside the column");
    assert.ok(headers.every((t, i) => i === 0 || t.y - headers[i - 1].y === 14), "header lines are 14px apart");
    assert.ok(headers.at(-1).y + 3 <= longV.bars[0][0].y, "the first bar starts below the last header line");
  }
  console.log("stacked_bar_100: highlight_column (no in-bar labels, one value per bar, right of 100%) -- PASS");
}

{
  // The default value layout. A spec that leaves segment_values out is the highlight column, not the in-bar values:
  // only the highlighted segment's value is printed, once per bar, in a right column; in_bar is the opt-in.
  const rows = sectorRows();
  const byDefault = renderVizSvg(spec(SECTOR_SPEC), rows);
  assert.ok(!("segment_values" in spec(SECTOR_SPEC)), "the default spec leaves segment_values out");
  assert.equal(byDefault, renderVizSvg(spec({ ...SECTOR_SPEC, segment_values: "highlight_column" }), rows), "segment_values omitted is byte-identical to highlight_column");
  assert.notEqual(byDefault, renderVizSvg(specIn(SECTOR_SPEC), rows), "...and differs from in_bar");
  const d = read(byDefault);
  assert.equal(d.role("stacked-value").length, 0, "by default no value is printed inside a bar");
  assert.equal(d.role("stacked-column-value").length, 25, "...only the highlight segment's value, once per bar, in the right column");
  assert.equal(d.role("stacked-column-header").length, 1, "...under one header");
  assert.equal(d.role("stacked-rounding-note").length, 0, "...and with one figure per bar there is no rounding note");
  // The opt-in: in_bar prints every value inside its segment (where it fits) and has no column.
  const o = read(renderVizSvg(specIn(SECTOR_SPEC), rows));
  assert.ok(o.role("stacked-value").length > 60 && o.role("stacked-column-value").length === 0 && o.role("stacked-column-header").length === 0, "in_bar still prints the values inside the segments and draws no column");
  // The column follows the highlight that the spec picks, whichever way it is picked.
  const columnOf = (overrides, data = rows) => {
    const v = read(renderVizSvg(spec({ ...SECTOR_SPEC, ...overrides }), data));
    return { header: v.role("stacked-column-header").map((t) => t.text).join(" "), n: v.role("stacked-column-value").length };
  };
  assert.deepEqual(columnOf({ highlight_segment: "工业" }), { header: "工业", n: 25 }, "highlight_segment picks the column");
  assert.deepEqual(columnOf({ highlight_segment: undefined, sort_segment: "服务业" }), { header: "服务业", n: 25 }, "else sort_segment");
  assert.deepEqual(columnOf({ highlight_segment: undefined, sort_segment: undefined, segment_order: ["服务业", "农业", "工业"] }), { header: "服务业", n: 25 }, "else the first segment_order entry");
  assert.deepEqual(columnOf({ highlight_segment: undefined, sort_segment: undefined, segment_order: undefined }), { header: "农业", n: 25 }, "else the first segment of the data");
  // No highlight in the data: the column has nothing to print, so the values stay in the bars (never lost).
  const none = read(renderVizSvg(spec({ highlight_segment: "nope", sort: "none" }), THREE));
  assert.ok(none.role("stacked-value").length > 0 && none.role("stacked-column-value").length === 0, "a highlight that is not in the data falls back to in-bar values");
  // A rendered default stays inside the page's own checks.
  assertQaClean("default value layout", byDefault);
  console.log("stacked_bar_100: default value layout is the highlight column, in_bar is the opt-in -- PASS");
}

{
  // Robustness: the renderer does not run lint, so it must draw any rows sensibly (no throw, no NaN, nothing cut).
  const clean = (label, svg) => assert.ok(!/NaN|undefined|Infinity|\bnull\b/.test(svg), `${label}: no non-finite or undefined tokens`);
  const nearestBar = (v, t) => v.bars.map((bar, i) => ({ i, d: Math.abs(t.y - (bar[0]?.y + bar[0]?.h / 2 + 4)) })).sort((a, b) => a.d - b.d)[0].i;

  // Entity names wider than the label column fold onto further lines and are never cut.
  const longEn = "Federated Republic of the Northern Highlands and Coastal Islands (synthetic example name)";
  const longZh = "示例联邦共和国北部高地与沿海岛屿联合地区综合发展统计区域名称特别长的一个示例名称";
  for (const [label, name, joiner, language] of [["spaces", longEn, " ", "en"], ["no spaces", longZh, "", "zh"]]) {
    const rows = rowsOf([[name, { X: 60, Y: 40 }], ["Short", { X: 30, Y: 70 }]]);
    const svg = renderVizSvg(spec({ language, sort: "none" }), rows);
    const v = read(svg);
    const lines = v.role("stacked-entity").filter((t) => nearestBar(v, t) === 0);
    assert.ok(lines.length >= 2, `${label}: the long name folds onto ${lines.length} lines`);
    assert.equal(lines.map((t) => t.text).join(joiner), name, `${label}: the folded lines are the whole name, nothing cut`);
    assert.ok(lines.every((t, i) => i === 0 || t.y - lines[i - 1].y === 14), `${label}: lines are 14px apart`);
    assert.ok(lines.every((t) => boxOf(t).w <= 1040 * 0.3 + 0.5), `${label}: every line is within the label column`);
    assert.equal(v.role("stacked-entity").filter((t) => nearestBar(v, t) === 1).length, 1, `${label}: a short name stays on one line`);
    assertQaClean(`folded names (${label})`, svg);
    const centreY = v.bars[0][0].y + v.bars[0][0].h / 2;
    assert.ok(near((lines[0].y + lines.at(-1).y) / 2, centreY + 4, 0.51), `${label}: the lines are centred on the bar`);
  }

  // Characters that need escaping in XML survive; the SVG still parses.
  const odd = rowsOf([["A & B <c> \"d\"", { "S&1": 60, "S<2>": 40 }]]);
  const oddSvg = renderVizSvg(spec({ language: "en" }), odd);
  clean("xml characters", oddSvg);
  assert.ok(oddSvg.includes("A &amp; B &lt;c&gt;"), "entity names are XML-escaped");
  assert.ok(oddSvg.includes('data-series="S&amp;1"'), "segment names in attributes are escaped too");
  assertQaClean("xml characters", oddSvg);

  // Unknown highlight (lint refuses it, the renderer must not break): no accent, all greys.
  const noAccent = renderVizSvg(spec({ highlight_segment: "nope", sort: "none" }), THREE);
  clean("unknown highlight", noAccent);
  assert.ok(!read(noAccent).segments.some((s) => s.fill === HOUSE.accent), "no segment takes the accent when the highlight is not in the data");
  assert.ok(read(noAccent).role("stacked-value").length > 0, "...and the values stay in the bars, since there is no highlight column to carry them");
  // More segments than the lint limit still draw (the 6th and 7th reuse greys, never the accent).
  const many = rowsOf([["甲", { A: 20, B: 20, C: 20, D: 20, E: 10, F: 5, G: 5 }]]);
  const manySvg = renderVizSvg(spec({}), many);
  clean("7 segments", manySvg);
  assert.equal(read(manySvg).segments.length, 7, "all seven segments are drawn");
  // Non-numeric and non-finite values count as 0; the bar still ends at 100%.
  const messy = [{ c: "甲", s: "X", v: "abc" }, { c: "甲", s: "Y", v: 100 }, { c: "甲", s: "Z", v: null }, { c: "乙", s: "X", v: NaN }, { c: "乙", s: "Y", v: Infinity }, { c: "乙", s: "Z", v: 50 }];
  const messySvg = renderVizSvg(spec({ sort: "none" }), messy);
  clean("non-numeric values", messySvg);
  const messyV = read(messySvg);
  assert.deepEqual(messyV.bars.map((bar) => bar.map((s) => s.series)), [["Y"], ["Z"]], "a non-numeric value draws nothing");
  assert.ok(messyV.bars.every((bar) => near(bar.at(-1).x + bar.at(-1).w, messyV.plotRight)), "the other segments still end at 100%");
  // A repeated (category, series) pair: the first row wins (lint refuses the repeat).
  const dup = read(renderVizSvg(spec({ sort: "none" }), [{ c: "甲", s: "X", v: 60 }, { c: "甲", s: "Y", v: 40 }, { c: "甲", s: "X", v: 5 }]));
  assert.deepEqual(dup.bars[0].map((s) => [s.series, s.value]), [["X", 60], ["Y", 40]], "the first of a repeated pair is drawn");
  // No rows and a single full-width segment.
  const empty = renderVizSvg(spec({}), []);
  clean("no rows", empty);
  assert.equal(read(empty).segments.length, 0, "no rows: no bars");
  const solo = renderVizSvg(specIn({}), rowsOf([["甲", { X: 100 }]]));
  clean("one bar, one segment", solo);
  assert.equal(read(solo).role("stacked-value")[0].text, "100", "100 prints as 100");
  assertQaClean("one bar, one segment", solo);
  const soloColumn = renderVizSvg(spec({}), rowsOf([["甲", { X: 100 }]]));
  clean("one bar, one segment, default", soloColumn);
  assert.deepEqual(read(soloColumn).role("stacked-column-value").map((t) => t.text), ["100%"], "the default column prints 100%");
  assertQaClean("one bar, one segment, default", soloColumn);
  console.log("stacked_bar_100: robustness (folded names, escaping, odd rows, no rows) -- PASS");
}

{
  // Short charts: the canvas follows the content instead of frame()'s 420px
  // default (which left about 85px of blank paper under three bars), with a
  // 300px floor so that a single bar does not become a strip. The footer rule
  // sits just under the last bar, or just under the rounding note.
  const measure = (svg) => {
    const v = read(svg);
    const rule = v.nodes.filter((n) => n.tag === "line" && !n.attrs["data-role"] && Number(n.attrs.x1) === 54 && Number(n.attrs.x2) === v.width - 54).at(-1);
    return { height: v.height, barsBottom: Math.max(...v.segments.map((s) => s.y + s.h)), ruleY: Number(rule.attrs.y1), note: v.role("stacked-rounding-note")[0] };
  };
  const groups = (count, parts) => rowsOf(Array.from({ length: count }, (_, i) => [`第${i + 1}组`, parts]));
  for (const extra of [{}, { segment_values: "in_bar" }]) {
    const mode = extra.segment_values ?? "default";
    for (const count of [2, 3, 4, 5, 6, 12]) {
      const m = measure(renderVizSvg(spec({ sort: "none", ...extra }), groups(count, { X: 60, Y: 40 })));
      assert.ok(m.ruleY - m.barsBottom <= 20, `${mode}, ${count} bars: no blank band under the last bar (${m.ruleY - m.barsBottom}px down to the footer rule)`);
      if (count <= 5) assert.ok(m.height < 420, `${mode}, ${count} bars: the canvas follows the content (${m.height} < 420)`);
    }
    assert.equal(measure(renderVizSvg(spec({ sort: "none", ...extra }), groups(1, { X: 60, Y: 40 }))).height, 300, `${mode}, one bar: the 300px floor`);
  }
  // By default the rounding note is off (one printed figure per bar), so 33/33/33 draws no note and the footer rule still hugs the bars.
  const noNote = measure(renderVizSvg(spec({ sort: "none", decimals: 0 }), groups(3, { X: 33.4, Y: 33.3, Z: 33.3 })));
  assert.ok(!noNote.note, "three bars of 33/33/33, default layout: no rounding note");
  assert.ok(noNote.ruleY - noNote.barsBottom <= 20, `...and no blank band under the last bar (${noNote.ruleY - noNote.barsBottom}px)`);
  const withNote = measure(renderVizSvg(specIn({ sort: "none", decimals: 0 }), groups(3, { X: 33.4, Y: 33.3, Z: 33.3 })));
  assert.ok(withNote.note, "three bars of 33/33/33: the rounding note is drawn");
  assert.ok(withNote.note.y > withNote.barsBottom && withNote.ruleY - withNote.note.y <= 20, `the rounding note sits between the last bar and the footer rule (${withNote.barsBottom} < ${withNote.note?.y} < ${withNote.ruleY})`);
  assert.ok(withNote.height < 420, `three bars with the note: the canvas follows the content (${withNote.height} < 420)`);
  console.log("stacked_bar_100: short charts keep the canvas their content needs -- PASS");
}

{
  // Styles: the explicit house style equals the default (guards the DECIMAL_MODE hazard of unit "%"); legacy is clean too.
  const rows = sectorRows();
  assert.equal(renderVizSvg(spec({ ...SECTOR_SPEC, style_id: "house" }), rows), renderVizSvg(spec(SECTOR_SPEC), rows), "style_id house is byte-identical to the default");
  assert.equal(renderVizSvg(spec({ ...SECTOR_SPEC, decimals: 0, style_id: "house" }), rows), renderVizSvg(spec({ ...SECTOR_SPEC, decimals: 0 }), rows), "...also with decimals 0 (the one-decimal rule for % never overrides the spec)");
  const legacy = renderVizSvg(spec({ ...SECTOR_SPEC, style_id: "legacy" }), rows);
  const lv = read(legacy);
  assert.deepEqual(lv.texts.filter((t) => t.role === null && /^\d+%?$/.test(t.text)).map((t) => t.text), ["0%", "25%", "50%", "75%", "100%"], "legacy style: the % is on every tick");
  for (const [role, extra] of [["stacked-column-value", {}], ["stacked-value", { segment_values: "in_bar" }]]) {
    const texts = (style) => read(renderVizSvg(spec({ ...SECTOR_SPEC, ...extra, style_id: style }), rows)).role(role).map((t) => t.text);
    assert.ok(texts("legacy").length >= 25, `${role}: legacy prints its values`);
    assert.deepEqual(texts("legacy"), texts("house"), `the printed values (${role}) do not depend on the style`);
    assert.equal(renderVizSvg(spec({ ...SECTOR_SPEC, ...extra, style_id: "house" }), rows), renderVizSvg(spec({ ...SECTOR_SPEC, ...extra }), rows), `style_id house is byte-identical to the default (${role})`);
  }
  assert.notEqual(lv.segments[0].fill, HOUSE.accent, "legacy draws the legacy accent");
  assert.equal(new Set(lv.segments.filter((s) => s.category === lv.bars[0][0].category).map((s) => s.fill)).size, 3, "legacy: three distinct segment fills");
  assertQaClean("legacy style", legacy);
  console.log("stacked_bar_100: style handling (house = default, legacy clean) -- PASS");
}

{
  // Objective QA on the typical cases: render QA (geometry + contrast), the 12px scan, no non-finite tokens, own rules.
  const cases = [
    ["25 bars, in-bar values (opt-in)", specIn(SECTOR_SPEC), sectorRows()],
    ["25 bars, default (highlight column)", spec(SECTOR_SPEC), sectorRows()],
    ["25 bars, highlight column named explicitly", spec({ ...SECTOR_SPEC, segment_values: "highlight_column" }), sectorRows()],
    ["25 bars, decimals 0 with the rounding note (in-bar)", specIn({ ...SECTOR_SPEC, decimals: 0 }), sectorRows()],
    ["25 bars, decimals 0, default (no note)", spec({ ...SECTOR_SPEC, decimals: 0 }), sectorRows()],
    ["25 bars, key (direct labels off), default", spec({ ...SECTOR_SPEC, direct_labels: false }), sectorRows()],
    ["25 bars, key (direct labels off), in-bar", specIn({ ...SECTOR_SPEC, direct_labels: false }), sectorRows()],
    ["25 bars, sorted ascending by the last segment", spec({ segment_order: ["服务业", "工业", "农业"], highlight_segment: "农业", sort: "asc" }), sectorRows()],
    ["25 bars, English", spec({ ...SECTOR_SPEC, language: "en", title: "Sample data: shares by sector", subtitle: "Sample data", source_note: "Sample data (synthetic)" }), sectorRows().map((row) => ({ ...row, c: row.c.replace("国", " Land"), s: { 农业: "Farming", 工业: "Industry", 服务业: "Services" }[row.s] }))],
    ["4 bars (roomy)", spec({}), THREE],
    ["4 bars, a thin first segment (key)", spec({ sort: "none" }), rowsOf([["甲", { X: 97, Y: 2, Z: 1 }], ["乙", { X: 50, Y: 30, Z: 20 }], ["丙", { X: 20, Y: 50, Z: 30 }], ["丁", { X: 33.3, Y: 33.3, Z: 33.4 }]])],
    ["5 segments", spec({ sort: "none", segment_order: ["A", "B", "C", "D", "E"], highlight_segment: "B" }), rowsOf([["甲", { A: 30, B: 25, C: 20, D: 15, E: 10 }], ["乙", { A: 10, B: 20, C: 30, D: 25, E: 15 }], ["丙", { A: 20, B: 20, C: 20, D: 20, E: 20 }]])],
    ["a segment missing from some bars", spec({ sort: "none" }), rowsOf([["甲", { X: 60, Y: 40 }], ["乙", { X: 100 }], ["丙", { Y: 100 }], ["丁", { X: 30, Y: 30, Z: 40 }]])],
    ["one bar, one segment", spec({}), rowsOf([["甲", { X: 100 }]])],
    ["long entity names", spec({ language: "en", sort: "none" }), rowsOf([["Federated Republic of the Northern Highlands and Coastal Islands (synthetic example name)", { X: 60, Y: 40 }], ["Short", { X: 30, Y: 70 }]])],
    ["a long highlight name in the column", spec({ language: "en", sort: "none", segment_values: "highlight_column", highlight_segment: "A very long highlighted segment name for the column header" }), rowsOf([["甲", { "A very long highlighted segment name for the column header": 60, Other: 40 }], ["乙", { "A very long highlighted segment name for the column header": 30, Other: 70 }]])],
    ["legacy style", spec({ ...SECTOR_SPEC, style_id: "legacy" }), sectorRows()],
  ];
  // Every case is also drawn with the in-bar opt-in (unless it already sets segment_values), so both layouts are covered.
  let drawn = 0;
  for (const [label, s, rows] of cases) {
    assertQaClean(label, renderVizSvg(s, rows));
    drawn += 1;
    if (s.segment_values === undefined) {
      assertQaClean(`${label} (in-bar)`, renderVizSvg({ ...s, segment_values: "in_bar" }, rows));
      drawn += 1;
    }
  }
  console.log(`stacked_bar_100: objective QA clean on ${cases.length} typical and edge cases (${drawn} renders, both value layouts) -- PASS`);
}

// ---------------------------------------------------------------------------
// 3. Lint: every blocker refused and accepted at its boundary, the warnings
// ---------------------------------------------------------------------------
{
  const CONTEXT = { verified_claim_ids: ["claim-stacked"] };
  const lint = (overrides, rows) => lintVizSpec(spec(overrides), rows, CONTEXT);
  const blockersOf = (overrides, rows) => lint(overrides, rows).blockers;
  const refused = (label, overrides, rows, text) => {
    const blockers = blockersOf(overrides, rows);
    assert.ok(blockers.some((m) => m.includes(text)), `${label}: refused with "${text}" (got ${JSON.stringify(blockers)})`);
  };
  const accepted = (label, overrides, rows) => assert.deepEqual(blockersOf(overrides, rows), [], `${label}: accepted`);
  const two = (x, y) => rowsOf([["甲", { X: x, Y: y }]]);
  const bars = (count) => rowsOf(Array.from({ length: count }, (_, i) => [`第${i + 1}国`, { X: 60, Y: 40 }]));
  const segments = (count) => rowsOf([["甲", Object.fromEntries(Array.from({ length: count }, (_, i) => [`S${i + 1}`, count === 5 ? 20 : count === 6 ? [20, 20, 20, 20, 10, 10][i] : 100 / count]))]]);
  const warningsOf = (rows, overrides = {}) => lint(overrides, rows).warnings;

  accepted("a valid spec", {}, sectorRows());
  assert.deepEqual(blockersOf(SECTOR_SPEC, sectorRows()), [], "the typical case has no blockers");

  // Bars: 25 accepted, 26 refused; the warning starts above 20.
  accepted("25 bars", {}, bars(25));
  refused("26 bars", {}, bars(26), "stacked_bar_100 has 26 bars; maximum is 25");
  assert.deepEqual(warningsOf(bars(20)), [], "20 bars: no warning");
  assert.ok(warningsOf(bars(21)).some((m) => m.includes("21 bars")), "21 bars: a warning");
  assert.ok(warningsOf(bars(25)).some((m) => m.includes("25 bars")), "25 bars: a warning (and no blocker)");
  assert.ok(!warningsOf(bars(26)).some((m) => m.includes("26 bars")), "26 bars: the blocker replaces the warning");

  // Segments: 5 accepted, 6 refused.
  accepted("5 segments", {}, segments(5));
  refused("6 segments", {}, segments(6), "stacked_bar_100 has 6 segments; maximum is 5");

  // Row sums: 100 +/- 1 inclusive.
  accepted("sum 100", {}, two(60, 40));
  accepted("sum 99.0", {}, two(50, 49));
  accepted("sum 101.0", {}, two(50, 51));
  accepted("33.3 + 33.3 + 33.4 (float noise above 100)", {}, rowsOf([["甲", { X: 33.3, Y: 33.3, Z: 33.4 }]]));
  refused("sum 98.99", {}, two(50, 48.99), SUM_MESSAGE);
  refused("sum 101.01", {}, two(50, 51.01), SUM_MESSAGE);
  refused("sum 50 (counts, not shares)", {}, two(30, 20), SUM_MESSAGE);
  refused("one off bar among good ones", {}, rowsOf([["甲", { X: 60, Y: 40 }], ["乙", { X: 70, Y: 40 }], ["丙", { X: 50, Y: 50 }]]), "乙 sums to 110");
  assert.ok(blockersOf({}, two(50, 48.99)).some((m) => m.includes("甲 sums to 98.99")), "the message names the bar and its sum");
  assert.ok(blockersOf({}, two(50, 48.99)).some((m) => m.endsWith(SUM_MESSAGE)), "the message ends with the SQL hint");

  // Negative values.
  refused("negative value", {}, two(-1, 101), "must not be negative");
  accepted("zero value", {}, two(0, 100));
  // Non-numeric / non-finite values: the generic numeric-field blocker.
  for (const [label, bad] of [["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity], ["text", "abc"], ["null", null], ["empty string", ""]]) {
    refused(`value ${label}`, {}, [{ c: "甲", s: "X", v: bad }, { c: "甲", s: "Y", v: 100 }], "contains non-numeric or missing values");
  }
  accepted("numeric strings", {}, [{ c: "甲", s: "X", v: "60" }, { c: "甲", s: "Y", v: "40" }]);

  // Unit.
  accepted("unit %", { unit: "%" }, two(60, 40));
  refused("unit percent", { unit: "percent" }, two(60, 40), "stacked_bar_100 requires unit='%'");
  refused("unit missing", { unit: undefined }, two(60, 40), "stacked_bar_100 requires unit='%'");

  // Names that must exist in the data.
  accepted("highlight_segment in the data", { highlight_segment: "Y" }, two(60, 40));
  accepted("sort_segment in the data", { sort_segment: "Y" }, two(60, 40));
  accepted("segment_order in the data", { segment_order: ["Y", "X"] }, two(60, 40));
  accepted("segment_order that lists only some", { segment_order: ["Y"] }, two(60, 40));
  refused("highlight_segment not in the data", { highlight_segment: "W" }, two(60, 40), "highlight_segment 'W' is not a value of series_field 's'");
  refused("sort_segment not in the data", { sort_segment: "W" }, two(60, 40), "sort_segment 'W' is not a value of series_field 's'");
  refused("segment_order not in the data", { segment_order: ["X", "W"] }, two(60, 40), "segment_order lists 'W', not a value of series_field 's'");
  refused("segment_order too long", { segment_order: ["a", "b", "c", "d", "e", "f"] }, two(60, 40), "segment_order must list 1 to 5");
  refused("decimals 2", { decimals: 2 }, two(60, 40), "decimals must be 0 or 1");

  // Repeated pairs and blank names.
  refused("a repeated (category, series) pair", {}, [{ c: "甲", s: "X", v: 60 }, { c: "甲", s: "Y", v: 40 }, { c: "甲", s: "X", v: 0 }], "repeated (category, series) pair");
  refused("a blank category", {}, [{ c: "", s: "X", v: 60 }, { c: "", s: "Y", v: 40 }], "blank category_field or series_field");
  refused("a blank segment", {}, [{ c: "甲", s: "", v: 60 }, { c: "甲", s: "Y", v: 40 }], "blank category_field or series_field");

  // A segment missing from some bars blocks; the task fit warns.
  const gaps = rowsOf([["甲", { X: 60, Y: 40 }], ["乙", { X: 100 }], ["丙", { X: 100 }]]);
  refused("a segment missing from some bars", {}, gaps, "segment 'Y' has no row for 2 bar(s): '乙', '丙'");
  assert.ok(blockersOf({}, gaps).some((m) => m.includes("explicit 0 row") && m.includes("SQL")), "the missing-segment blocker says to return an explicit 0 row from SQL");
  accepted("an explicit 0 row for the missing segment", {}, rowsOf([["甲", { X: 60, Y: 40 }], ["乙", { X: 100, Y: 0 }], ["丙", { X: 100, Y: 0 }]]));
  assert.deepEqual(warningsOf(two(60, 40)), [], "no warning when every bar has every segment");
  assert.ok(!warningsOf(two(60, 40)).some((m) => m.includes("unusual fit")), "part_to_whole: a fit for this form");
  assert.ok(warningsOf(two(60, 40), { reader_task: "comparison" }).some((m) => m.includes("'stacked_bar_100' is an unusual fit for reader task 'comparison'")), "comparison: not in this form's task set");
  console.log("stacked_bar_100: lint blockers refused and accepted at their boundaries, warnings -- PASS");
}

// ---------------------------------------------------------------------------
// 4. SVG snapshots of three typical cases (sha256 + byte length)
// ---------------------------------------------------------------------------
{
  const cases = {
    // The three keys that existed before the default changed keep the layout they were taken with (now written out),
    // so their hashes are unchanged; the default itself is pinned by the fourth key and by the equality check below.
    "25 bars, in-bar values": () => renderVizSvg(specIn(SECTOR_SPEC), sectorRows()),
    "25 bars, highlight column": () => renderVizSvg(spec({ ...SECTOR_SPEC, segment_values: "highlight_column" }), sectorRows()),
    "25 bars, no decimals, rounding note": () => renderVizSvg(specIn({ ...SECTOR_SPEC, decimals: 0 }), sectorRows()),
    "25 bars, no decimals, default layout (no note)": () => renderVizSvg(spec({ ...SECTOR_SPEC, decimals: 0 }), sectorRows()),
  };
  const actual = Object.fromEntries(Object.entries(cases).map(([name, draw]) => {
    const svg = draw();
    return [name, { sha256: createHash("sha256").update(svg).digest("hex"), bytes: Buffer.byteLength(svg) }];
  }));
  if (UPDATE) {
    writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`stacked_bar_100: snapshots rewritten (${Object.keys(actual).length}) -- UPDATED ${SNAPSHOT_FILE}`);
  } else {
    let expected;
    try { expected = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")); } catch { assert.fail(`snapshot fixture missing or unreadable: run node scripts/test_viz_stacked_bar_100.mjs --update (${SNAPSHOT_FILE})`); }
    assert.deepEqual(Object.keys(expected), Object.keys(actual), "the snapshot fixture lists exactly these cases");
    for (const name of Object.keys(actual)) {
      assert.deepEqual(actual[name], expected[name], `snapshot "${name}" changed; if intended, run node scripts/test_viz_stacked_bar_100.mjs --update`);
    }
    console.log(`stacked_bar_100: ${Object.keys(actual).length} SVG snapshots match -- PASS`);
  }
}

// category_names iso3 on the bar names: a World row mixed with economies blocks and is named; an unknown code blocks.
{
  const lintIso = (codes) => lintVizSpec(spec({ category_names: "iso3" }), rowsOf(codes.map((code) => [code, { X: 60, Y: 40 }])), { verified_claim_ids: ["claim-stacked"] });
  assert.deepEqual(lintIso(["USA", "CHN", "DEU"]).blockers, [], "economies only pass");
  const mixed = lintIso(["USA", "CHN", "WLD"]);
  assert.ok(mixed.blockers.some((m) => m.includes("'WLD'") && m.includes("aggregate")), mixed.blockers.join("; "));
  const unknown = lintIso(["USA", "CHN", "XXQ"]);
  assert.ok(unknown.blockers.some((m) => m.includes("cannot resolve") && m.includes("'XXQ'")), unknown.blockers.join("; "));
}

console.log("stacked_bar_100: ok");
