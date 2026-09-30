#!/usr/bin/env node
// Regression tests for the single-grid waffle (spec.waffle_layout ===
// "single_grid"), which shares ONE 10x10 grid across all of a spec's
// categories instead of renderWaffle's default one-grid-per-category mode.
// Covers: largest-remainder apportionment (exact cell counts summing to
// 100, never drifting from rounding), the accent+grey palette with a
// 5-category visible cap and highlight-preserving merge into "其他"/
// "Other" (exact sum, never rounded/re-derived), a fixed-width
// right-aligned legend value column, cell counts moved out of
// reader-facing text into a data-cell-count attribute, always-one-decimal
// percent formatting, the lint cap (2-5 categories for this mode), render
// QA cleanliness, and determinism.
import assert from "node:assert/strict";
import { renderVizSvg, renderVizMobileSvg, lintVizSpec } from "../runtime/pi/viz.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";
import { checkSvgContrast } from "../runtime/pi/render_qa_contrast.mjs";

function baseSpec(overrides = {}) {
  return {
    schema_version: "0.7.0",
    reader_task: "part_to_whole",
    takeaway: "Coal and gas still dominate the power mix.",
    chart_type: "waffle",
    waffle_layout: "single_grid",
    title: "Electricity generation mix, 2023",
    alt: "A single 10x10 waffle grid split across electricity sources.",
    source_note: "Synthetic regression fixture (single-grid waffle)",
    claim_id: "claim-energy-mix-single-grid",
    sql: "SELECT * FROM synthetic",
    unit: "%",
    category_field: "source",
    value_field: "share",
    ...overrides,
  };
}

// Eight categories: above the 5-visible cap, so this fixture exercises the
// merge-to-"其他"/"Other" path. Coal is the spec's own highlighted
// category (also the largest value here, so it would survive anyway; the
// highlight-preservation rule itself only matters when a highlighted
// category is NOT already among the top values, which this file does not
// need a second fixture to prove - the lint/plan logic keeps it regardless
// of rank).
const rows8 = [
  { source: "Coal", share: 34.2 },
  { source: "Natural gas", share: 24.7 },
  { source: "Nuclear", share: 8.9 },
  { source: "Hydro", share: 6.1 },
  { source: "Wind", share: 10.3 },
  { source: "Solar", share: 6.8 },
  { source: "Other renewables", share: 4.5 },
  { source: "Oil", share: 4.5 },
];
const spec8 = baseSpec({ highlight_values: ["Coal"] });

// ---------------------------------------------------------------------------
// (1) Largest-remainder apportionment: exact, hand-verified cell counts
//     that sum to exactly 100. The renderer sorts entries by value
//     descending (after the highlight-preserving 5-category cap merges the
//     4 smallest into "其他"), so the expected visible order is:
//     Coal(34.2, highlighted) > Natural gas(24.7) > Wind(10.3) >
//     Nuclear(8.9) > Other(21.9 = 6.8+6.1+4.5+4.5). Floors: 34,24,10,8,21 =
//     97, a 3-cell shortfall going to the 3 largest remainders - see the
//     hand-checked expectation below.
// ---------------------------------------------------------------------------
const desktop = renderVizSvg(spec8, rows8);
const cellsByColor = [...desktop.matchAll(/<rect data-role="waffle-cell"[^>]*fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
assert.equal(cellsByColor.length, 100, "a single-grid waffle must always render exactly 100 cells");
const counts = [];
let run = 1;
for (let i = 1; i <= cellsByColor.length; i++) {
  if (i < cellsByColor.length && cellsByColor[i] === cellsByColor[i - 1]) { run++; continue; }
  counts.push(run);
  run = 1;
}
assert.equal(counts.length, 5, `expected exactly 5 visible entries (4 kept + merged Other) after the cap, got ${counts.length} runs: [${counts}]`);
assert.equal(counts.reduce((a, b) => a + b, 0), 100, "cell counts must sum to exactly 100");
assert.deepEqual(counts, [34, 25, 10, 9, 22], `expected the largest-remainder allocation [34,25,10,9,22] over the 5 capped/merged entries, got [${counts}]`);
console.log("largest-remainder allocation over the capped/merged entries is exact and sums to 100: PASS");

// ---------------------------------------------------------------------------
// (2) Cap + highlight-preserving merge: with 8 categories, exactly 5
//     legend rows show (4 kept + "Other"), the highlighted category (Coal)
//     is always kept, "Other"'s value is the EXACT sum of the 4 merged
//     rows (6.8+6.1+4.5+4.5 = 21.9, never rounded/re-derived), and the
//     merged categories' names appear only in a composition note, not as
//     their own legend rows.
// ---------------------------------------------------------------------------
{
  const legendNames = [...desktop.matchAll(/font-weight="600"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.equal(legendNames.length, 5, `expected exactly 5 legend name rows, got ${legendNames.length}: ${JSON.stringify(legendNames)}`);
  assert.deepEqual(legendNames, ["Coal", "Natural gas", "Wind", "Nuclear", "Other"], `expected legend names sorted by value with Other last, got ${JSON.stringify(legendNames)}`);
  assert.ok(desktop.includes(">21.9%<"), 'expected the merged "Other" row to show the exact sum 21.9%, not a rounded figure');
  assert.ok(!desktop.includes(">Solar<"), 'merged category "Solar" must not appear as its own legend row');
  assert.ok(!desktop.includes(">Hydro<"), 'merged category "Hydro" must not appear as its own legend row');
  assert.ok(desktop.includes("Other includes:"), "expected a composition note introducing the merged categories");
  for (const name of ["Solar", "Hydro", "Other renewables", "Oil"]) {
    assert.ok(desktop.includes(name), `composition note must name merged category "${name}"`);
  }
  assert.ok(desktop.includes("exact sum 21.9%"), "composition note must state the exact merged sum");
  console.log('5-category cap with highlight-preserving merge into "Other" (exact sum, named in a note): PASS');
}

// ---------------------------------------------------------------------------
// (3) Palette: the highlighted category gets PALETTE.accent (#d1493f);
//     every other visible category and the merged "Other" bucket get grey/
//     grey-blue steps, ordered darkest-first by descending value, with the
//     lightest step reserved for "Other" - never a multi-hue categorical
//     palette, and never a colour reused between two different legend rows.
// ---------------------------------------------------------------------------
{
  const swatches = [...desktop.matchAll(/<rect data-role="legend-swatch"[^>]*fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
  assert.equal(swatches.length, 5, "expected one legend swatch per visible entry (including Other)");
  assert.equal(swatches[0], "#D0021B", "the highlighted category (Coal) must use PALETTE.accent (house style, the default)");
  const greySteps = swatches.slice(1);
  assert.equal(new Set(greySteps).size, greySteps.length, "grey/grey-blue steps must be distinct across rows, never repeated");
  assert.ok(greySteps.every((c) => c !== "#D0021B"), "non-highlighted rows must never use the accent colour");
  assert.equal(swatches[swatches.length - 1], "#F2F2F2", '"Other" must use the lightest reserved grey step (house style)');
  const uniqueGridColors = [...new Set(cellsByColor)];
  assert.deepEqual(swatches, uniqueGridColors, "legend swatch colours must match the grid's own per-category colours in the same order");
  console.log("palette is accent-for-highlight + distinct ordered grey/grey-blue steps, lightest reserved for Other: PASS");
}

// ---------------------------------------------------------------------------
// (3b) style_id: "legacy" must keep the exact pre-house-style hex values
//     (WAFFLE_GREY_STEPS' original literals), byte-for-byte, proving the
//     PALETTE.waffleGreySteps live-binding rework never touched legacy output.
// ---------------------------------------------------------------------------
{
  const legacySpec = baseSpec({ highlight_values: ["Coal"], style_id: "legacy" });
  const legacyDesktop = renderVizSvg(legacySpec, rows8);
  const legacySwatches = [...legacyDesktop.matchAll(/<rect data-role="legend-swatch"[^>]*fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
  assert.equal(legacySwatches[0], "#d1493f", "legacy style's highlighted category must keep the original accent hex");
  assert.equal(legacySwatches[legacySwatches.length - 1], "#d3d9e0", "legacy style's Other bucket must keep the original lightest grey hex");
  assert.deepEqual(legacySwatches.slice(1, -1), ["#3a4552", "#5c6773", "#828d99"].slice(0, legacySwatches.length - 2), "legacy style's mid grey steps must keep their original hex values");
  console.log('style_id: "legacy" reproduces the original waffle palette byte-for-byte: PASS');
}

// ---------------------------------------------------------------------------
// (4) Legend value column is a single fixed-width, right-aligned table
//     column: every value <text> shares the same x regardless of its row's
//     own name width (the bug being fixed: values used to drift to
//     different x positions depending on name length).
// ---------------------------------------------------------------------------
{
  const valueXs = [...desktop.matchAll(/<text data-cell-count="\d+" x="([\d.]+)"/g)].map((m) => m[1]);
  assert.equal(valueXs.length, 5, "expected one value <text> per visible legend row");
  assert.equal(new Set(valueXs).size, 1, `all legend value x-coordinates must be identical (one aligned column), got distinct values: ${JSON.stringify(valueXs)}`);
  console.log("legend value column is a single fixed-width, right-aligned x for every row: PASS");
}

// ---------------------------------------------------------------------------
// (5) Cell counts must never appear in reader-facing text (no "(N cells)"),
//     only in a data-cell-count attribute for tests/metadata.
// ---------------------------------------------------------------------------
{
  assert.ok(!/\(\d+\s*cells?\)/i.test(desktop), 'reader-facing text must never contain "(N cells)"');
  const cellCountAttrs = [...desktop.matchAll(/data-cell-count="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(cellCountAttrs, counts, "data-cell-count attributes must match the actual rendered per-category cell counts, in the same order");
  console.log("cell counts are attribute-only metadata, never in reader-facing text: PASS");
}

// ---------------------------------------------------------------------------
// (6) Percent formatting is always exactly one decimal, matching the
//     treemap's convention, regardless of whether the underlying value
//     happens to be a whole number (e.g. a whole-number value of 10 must
//     render "10.0%", not "10%").
// ---------------------------------------------------------------------------
{
  const rowsWhole = [
    { source: "A", share: 10 },
    { source: "B", share: 30 },
    { source: "C", share: 60 },
  ];
  const svgWhole = renderVizSvg(baseSpec(), rowsWhole);
  assert.ok(svgWhole.includes(">10.0%<"), 'a whole-number value (10) must render as "10.0%", not "10%"');
  assert.ok(svgWhole.includes(">30.0%<"), 'a whole-number value (30) must render as "30.0%", not "30%"');
  assert.ok(svgWhole.includes(">60.0%<"), 'a whole-number value (60) must render as "60.0%", not "60%"');
  console.log("percent labels always render at exactly one decimal, even for whole-number values: PASS");
}

// ---------------------------------------------------------------------------
// (7) zh formatting: category names in Chinese, one-decimal percents, and
//     zh-specific composition-note punctuation ("、" between items,
//     "，合计" before the exact sum), not the English note text.
// ---------------------------------------------------------------------------
{
  const rowsZh = [
    { source: "煤炭", share: 34.2 },
    { source: "天然气", share: 24.7 },
    { source: "风能", share: 10.3 },
    { source: "核能", share: 8.9 },
    { source: "太阳能", share: 6.8 },
    { source: "水电", share: 6.1 },
    { source: "其他可再生能源", share: 4.5 },
    { source: "石油", share: 4.5 },
  ];
  const specZh = baseSpec({ highlight_values: ["煤炭"], language: "zh" });
  const svgZh = renderVizSvg(specZh, rowsZh);
  assert.ok(svgZh.includes(">其他<"), 'zh "Other" bucket label must read "其他"');
  assert.ok(svgZh.includes("其他包含："), 'zh composition note must open with "其他包含："');
  assert.ok(svgZh.includes("，合计"), 'zh composition note must join the exact sum with "，合计"');
  assert.ok(svgZh.includes("、"), 'zh composition note must separate merged items with "、"');
  assert.ok(svgZh.includes("34.2%") && svgZh.includes("21.9%"), "zh percents must still render at one decimal");
  const qaZh = checkSvgGeometry(svgZh);
  assert.equal(qaZh.passed, true, `zh single-grid waffle must pass render QA cleanly: ${JSON.stringify(qaZh.failures)}`);
  console.log("zh labels/percent formatting and composition-note punctuation are correct: PASS");
}

// ---------------------------------------------------------------------------
// (8) At or below the 5-category cap, no merge happens at all: every row
//     shows individually, and there is no "Other" bucket or note.
// ---------------------------------------------------------------------------
{
  const rows5 = rows8.slice(0, 5);
  const svg5 = renderVizSvg(baseSpec({ highlight_values: ["Coal"] }), rows5);
  assert.ok(!svg5.includes("Other includes:"), "at the cap (5 categories), no composition note should render");
  const names5 = [...svg5.matchAll(/font-weight="600"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.equal(names5.length, 5, "at exactly 5 categories, all 5 must show individually");
  for (const row of rows5) {
    assert.ok(names5.includes(row.source), `category "${row.source}" must show individually at/below the cap`);
  }
  console.log("at or below the 5-category cap, no merge/Other bucket is introduced: PASS");
}

// ---------------------------------------------------------------------------
// (9) Render QA (geometry + contrast) must pass cleanly on both viewports
//     for the merge-triggering 8-category fixture.
// ---------------------------------------------------------------------------
const qaD = checkSvgGeometry(desktop);
assert.equal(qaD.passed, true, `single-grid waffle (desktop) must pass render QA cleanly: ${JSON.stringify(qaD.failures)}`);
const contrastD = checkSvgContrast(desktop);
assert.equal(contrastD.passed, true, `single-grid waffle (desktop) must pass contrast QA cleanly: ${JSON.stringify(contrastD.failures)}`);
const mobile = renderVizMobileSvg(spec8, rows8);
const qaM = checkSvgGeometry(mobile);
assert.equal(qaM.passed, true, `single-grid waffle (mobile) must pass render QA cleanly: ${JSON.stringify(qaM.failures)}`);
const contrastM = checkSvgContrast(mobile);
assert.equal(contrastM.passed, true, `single-grid waffle (mobile) must pass contrast QA cleanly: ${JSON.stringify(contrastM.failures)}`);
console.log("single-grid waffle passes geometry + contrast render QA on both viewports: PASS");

// ---------------------------------------------------------------------------
// (10) Lint: single-grid mode allows 2-5 categories (not the default
//      mode's 1-4 grid cap), and still requires unit='%'.
// ---------------------------------------------------------------------------
{
  const rows5 = rows8.slice(0, 5);
  const tooFew = lintVizSpec(spec8, rows8.slice(0, 1));
  assert.ok(tooFew.blockers.some((b) => /single-grid waffle/.test(b)), "single-grid waffle with 1 category must be blocked (nothing to apportion)");
  const tooMany = lintVizSpec(spec8, [...rows5, { source: "Extra", share: 1 }]);
  assert.ok(tooMany.blockers.some((b) => /single-grid waffle/.test(b)), "single-grid waffle with 6 categories must be blocked (cap is 5)");
  const ok = lintVizSpec(spec8, rows5);
  assert.ok(!ok.blockers.some((b) => /single-grid waffle/.test(b)), `single-grid waffle with 5 categories must not be blocked: ${JSON.stringify(ok.blockers)}`);
  // The default (multi-grid) mode's stricter 4-row cap must not leak into
  // single-grid mode, and vice versa: a plain waffle (no waffle_layout)
  // with 5 rows must still be blocked by the OLD 4-grid cap, not treated
  // as single-grid.
  const { waffle_layout, ...multiGridSpec } = spec8;
  const multiGridBlocked = lintVizSpec(multiGridSpec, rows5);
  assert.ok(multiGridBlocked.blockers.some((b) => /maximum is 4/.test(b)), "default (multi-grid) waffle mode must keep its own 4-row cap");
  console.log("lint enforces the single-grid 2-5 category cap independently of the default mode's 4-grid cap: PASS");
}

// ---------------------------------------------------------------------------
// (11) Determinism: rendering the same spec twice must byte-for-byte match.
// ---------------------------------------------------------------------------
{
  const again = renderVizSvg(spec8, rows8);
  assert.equal(again, desktop, "rendering the same single-grid waffle spec twice must produce an identical SVG");
  console.log("single-grid waffle is deterministic across renders: PASS");
}

console.log("waffle single-grid regression: PASS");
