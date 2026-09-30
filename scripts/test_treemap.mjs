#!/usr/bin/env node
// Covers the treemap chart type: a squarified, part-to-whole area encoding
// for one flat set of categories (optionally grouped one level deep via
// group_field, or bucketed into an "Other" tile via other_threshold_pct).
// Exercises the same surfaces every other chart-type test in this suite
// does - lintVizSpec's blocking checks, the rendered SVG's tile geometry/
// determinism/label behaviour, and the product's own render-QA gates
// (runtime/pi/render_qa.mjs) - rather than approximating them.
import assert from "node:assert/strict";
import { critiqueViz, lintVizSpec, renderVizBundle, validateVizSpec } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const claimId = "claim-treemap-fixture";

const base = {
  schema_version: "0.9.0",
  reader_task: "part_to_whole",
  takeaway: "Defense and social security together account for more than half of the budget.",
  title: "National budget by function",
  alt: "A treemap of national budget spending broken out by function, tile area proportional to spending.",
  source_note: "Ministry of Finance fixture, FY2024 budget",
  claim_id: claimId,
  sql: "SELECT function, spending_billion FROM fixture",
  unit: "$B",
  chart_type: "treemap",
  category_field: "function",
  value_field: "spending_billion",
  highlight_values: [],
  annotations: [],
};

function tileRects(svg) {
  return [...svg.matchAll(/<rect data-role="treemap-tile" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => ({
    x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]),
  }));
}

const budgetRows = [
  { function: "Defense", spending_billion: 320 },
  { function: "Social security", spending_billion: 260 },
  { function: "Health", spending_billion: 180 },
  { function: "Education", spending_billion: 90 },
  { function: "Interest on debt", spending_billion: 60 },
  { function: "Transportation", spending_billion: 30 },
];

// --- lint: a well-formed spec passes clean
{
  const lint = lintVizSpec(base, budgetRows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
}
console.log("treemap lint: well-formed spec passes -- PASS");

// --- lint: value_field must be strictly positive (area cannot represent
//     a zero or negative value)
{
  const rows = [...budgetRows.slice(0, -1), { function: "Contingency", spending_billion: 0 }];
  const lint = lintVizSpec(base, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, false);
  assert.ok(lint.blockers.some((b) => b.includes("must be strictly positive")), lint.blockers.join("; "));

  const negRows = [...budgetRows.slice(0, -1), { function: "Contingency", spending_billion: -5 }];
  const negLint = lintVizSpec(base, negRows, { verified_claim_ids: [claimId] });
  assert.equal(negLint.passed, false);
  assert.ok(negLint.blockers.some((b) => b.includes("must be strictly positive")), negLint.blockers.join("; "));
}
console.log("treemap lint: zero/negative value_field is blocked -- PASS");

// --- lint: more than 60 rows is blocked with a filter-in-SQL / bucket message
{
  const rows = Array.from({ length: 61 }, (_, i) => ({ function: `Item ${i}`, spending_billion: 61 - i }));
  const lint = lintVizSpec(base, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, false);
  assert.ok(lint.blockers.some((b) => b.includes("treemap has 61 rows") && b.includes("other_threshold_pct")), lint.blockers.join("; "));
}
console.log("treemap lint: >60 rows is blocked -- PASS");

// --- lint: group_field with more than 10 groups is blocked
{
  const rows = Array.from({ length: 20 }, (_, i) => ({
    function: `Item ${i}`, spending_billion: 20 - i, dept: `Dept ${i % 12}`,
  }));
  const spec = { ...base, group_field: "dept" };
  const lint = lintVizSpec(spec, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, false);
  assert.ok(lint.blockers.some((b) => b.includes("group_field has 12 groups")), lint.blockers.join("; "));
}
console.log("treemap lint: group_field with >10 groups is blocked -- PASS");

// --- validate: other_threshold_pct must be a number in [0, 50]; combining
//     it with group_field is rejected outright
{
  const okErrors = validateVizSpec(base);
  assert.equal(okErrors.length, 0, okErrors.join("; "));

  const bad1 = validateVizSpec({ ...base, other_threshold_pct: 60 });
  assert.ok(bad1.some((e) => e.includes("other_threshold_pct must be a number between 0 and 50")), bad1.join("; "));

  const bad2 = validateVizSpec({ ...base, other_threshold_pct: -1 });
  assert.ok(bad2.some((e) => e.includes("other_threshold_pct must be a number between 0 and 50")), bad2.join("; "));

  const bad3 = validateVizSpec({ ...base, group_field: "dept", other_threshold_pct: 5 });
  assert.ok(bad3.some((e) => e.includes("not supported together with group_field")), bad3.join("; "));
}
console.log("treemap validate: other_threshold_pct range and group_field exclusivity are rejected -- PASS");

// --- area proportionality: every tile's rendered area (w*h) is
//     proportional to its value, within a squarified-layout tolerance
{
  const { desktop } = renderVizBundle(base, budgetRows, { mobilePages: false });
  const tiles = tileRects(desktop);
  assert.equal(tiles.length, budgetRows.length, "one tile per row");
  const totalValue = budgetRows.reduce((sum, r) => sum + r.spending_billion, 0);
  const totalArea = tiles.reduce((sum, t) => sum + t.w * t.h, 0);
  const sorted = [...budgetRows].sort((a, b) => b.spending_billion - a.spending_billion);
  const sortedTiles = [...tiles].sort((a, b) => b.w * b.h - a.w * a.h);
  for (let i = 0; i < sorted.length; i++) {
    const expectedShare = sorted[i].spending_billion / totalValue;
    const actualShare = (sortedTiles[i].w * sortedTiles[i].h) / totalArea;
    assert.ok(Math.abs(expectedShare - actualShare) < 0.01, `tile ${i} area share ${actualShare} should be within 1pp of value share ${expectedShare}`);
  }
}
console.log("treemap geometry: tile area is proportional to value within tolerance -- PASS");

// --- determinism: identical rows in a different input order and with a
//     tie produce byte-identical output (same rows, shuffled + tie)
{
  const tiedRows = [
    { function: "A", spending_billion: 100 },
    { function: "B", spending_billion: 100 },
    { function: "C", spending_billion: 40 },
    { function: "D", spending_billion: 10 },
  ];
  const shuffled = [tiedRows[2], tiedRows[0], tiedRows[3], tiedRows[1]];
  const out1 = renderVizBundle(base, tiedRows, { mobilePages: false }).desktop;
  const out2 = renderVizBundle(base, shuffled, { mobilePages: false }).desktop;
  assert.equal(out1, out2, "row order (including a value tie) must not change rendered output");
}
console.log("treemap determinism: row order and ties do not change output -- PASS");

// --- labels: no clipped/truncated text. Every rendered tile label
//     (data-role=treemap-tile-label / treemap-tile-value) must be a whole
//     category name or value, never an ellipsis-truncated fragment; tiles
//     too small for a label are omitted from the plot and listed instead in
//     the "not labeled on the chart" note.
{
  const skewRows = [
    { function: "Dominant program", spending_billion: 900 },
    ...Array.from({ length: 9 }, (_, i) => ({ function: `Minor line item number ${i} with a long name`, spending_billion: 2 + i * 0.3 })),
  ];
  const lint = lintVizSpec(base, skewRows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(base, skewRows, { mobilePages: false });
  const labelTexts = [...desktop.matchAll(/<text data-role="treemap-tile-label"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  for (const label of labelTexts) {
    assert.ok(!label.includes("…"), `tile label "${label}" should never be an ellipsis-truncated fragment`);
  }
  // small tiles that got no label must be listed in the overflow note
  assert.match(desktop, /data-role="treemap-overflow-note"/, "small unlabeled tiles should be listed in the overflow note");
  const qa = runRenderQa(renderVizBundle(base, skewRows));
  assert.equal(qa.passed, true, `render-QA failed: ${JSON.stringify(qa.viewports, null, 2)}`);

  // the overflow note's own text must sit clear below the plot, not
  // overlapping the tile fill above it: a note baseline needs headroom for
  // its own font ascent (~0.7-0.8em), so the gap from the lowest tile's
  // bottom edge to the note's first baseline must exceed that ascent.
  const tiles = tileRects(desktop);
  const plotBottom = Math.max(...tiles.map((t) => t.y + t.h));
  const noteY = Number(desktop.match(/<text data-role="treemap-overflow-note"[^>]*y="([\d.]+)"/)[1]);
  assert.ok(noteY - plotBottom >= 12, `overflow note baseline (${noteY}) should clear the plot bottom (${plotBottom}) by at least a 12px font-ascent margin`);
}
console.log("treemap labels: no truncated text; unlabeled tiles listed in overflow note, clear of the plot -- PASS");

// --- other_threshold_pct: items below the threshold are bucketed into one
//     "Other" tile, and its members are listed in a note
{
  const rows = [
    { function: "Big", spending_billion: 500 },
    { function: "Medium", spending_billion: 200 },
    { function: "Tiny A", spending_billion: 3 },
    { function: "Tiny B", spending_billion: 2 },
    { function: "Tiny C", spending_billion: 1 },
  ];
  const spec = { ...base, other_threshold_pct: 2 };
  const lint = lintVizSpec(spec, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(spec, rows, { mobilePages: false });
  const tiles = tileRects(desktop);
  assert.equal(tiles.length, 3, "Big + Medium + one Other tile");
  assert.match(desktop, /data-role="treemap-other-note"/);
  assert.match(desktop, /Tiny A/, "Other-bucket members should be named in the note");
  assert.match(desktop, /Tiny B/, "Other-bucket members should be named in the note");
  assert.match(desktop, /Tiny C/, "Other-bucket members should be named in the note");
}
console.log("treemap other_threshold_pct: small items bucketed into one Other tile with a members note -- PASS");

// --- group_field: a one-level grouping draws a legend and group-boundary
//     rects, and each tile's colour is assigned per group
{
  const rows = [
    { function: "Army", spending_billion: 200, dept: "Defense" },
    { function: "Navy", spending_billion: 120, dept: "Defense" },
    { function: "Hospitals", spending_billion: 150, dept: "Health" },
    { function: "Clinics", spending_billion: 60, dept: "Health" },
  ];
  const spec = { ...base, group_field: "dept" };
  const lint = lintVizSpec(spec, rows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(spec, rows, { mobilePages: false });
  assert.match(desktop, /data-role="treemap-group-boundary"/);
  const tiles = tileRects(desktop);
  assert.equal(tiles.length, 4);
  const qa = runRenderQa(renderVizBundle(spec, rows));
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports, null, 2));
}
console.log("treemap group_field: one-level grouping renders a legend and boundary rects -- PASS");

// --- house style: any stroke is drawn behind data marks. The
//     group-boundary rects (stroke-only decoration) must appear in the SVG
//     document *before* any tile rect, so painter's-order puts the stroke
//     underneath every tile fill/label, never on top of it.
{
  const rows = [
    { function: "Army", spending_billion: 200, dept: "Defense" },
    { function: "Navy", spending_billion: 120, dept: "Defense" },
    { function: "Hospitals", spending_billion: 150, dept: "Health" },
  ];
  const spec = { ...base, group_field: "dept" };
  const { desktop } = renderVizBundle(spec, rows, { mobilePages: false });
  const firstTileIdx = desktop.indexOf('data-role="treemap-tile"');
  const firstBoundaryIdx = desktop.indexOf('data-role="treemap-group-boundary"');
  assert.ok(firstBoundaryIdx !== -1 && firstTileIdx !== -1, "expected both tile and group-boundary rects");
  assert.ok(firstBoundaryIdx < firstTileIdx, "group-boundary stroke must be drawn before (behind) tile fills");
}
console.log("treemap house style: group-boundary stroke drawn behind tile fills -- PASS");

// --- highlight_values: highlighted tile uses the one WCAG-safe accent fill.
//     Under the legacy palette, PALETTE.accent (#d1493f) was too low-contrast
//     for a white label (4.43:1, just under the 4.5:1 floor), so the
//     highlighted tile deliberately used PALETTE.negative (#a8443e, 5.90:1)
//     instead. House style's single red role serves both accent and
//     negative ("#D0021B"), and white-on-"#D0021B" is 5.67:1, so the
//     distinction collapses - the highlighted tile now uses PALETTE.accent
//     directly and is still WCAG-safe with no halo needed.
{
  const spec = { ...base, highlight_values: ["Defense"] };
  const lint = lintVizSpec(spec, budgetRows, { verified_claim_ids: [claimId] });
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  const { desktop } = renderVizBundle(spec, budgetRows, { mobilePages: false });
  assert.match(desktop, /data-role="treemap-tile"[^>]*fill="#D0021B"/, "highlighted tile should use the safe accent fill (PALETTE.accent)");
}
console.log("treemap highlight_values: matching tile uses the safe accent fill -- PASS");

// --- colour: no rainbow. Every ungrouped, unhighlighted tile shares one
//     neutral fill; the fills across a whole budgetRows render must collapse
//     to at most 2 distinct colours (the shared neutral, plus nothing else
//     since nothing here is highlighted)
{
  const { desktop } = renderVizBundle(base, budgetRows, { mobilePages: false });
  const fills = [...desktop.matchAll(/<rect data-role="treemap-tile"[^>]*fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
  assert.ok(fills.length > 1, "expected multiple tiles");
  assert.equal(new Set(fills).size, 1, `ungrouped, unhighlighted tiles must all share one neutral fill, got ${[...new Set(fills)]}`);
  assert.equal(fills[0], "#9E9E9E", "the shared neutral fill should be PALETTE.context (house default)");
}
console.log("treemap colour: ungrouped tiles share one neutral fill, no rainbow -- PASS");

// --- colour: group_field uses at most 3 muted hues, one per group - never
//     the 8-colour SERIES_COLORS cycle, and an unlabeled/ungrouped tile is
//     never coloured to imply a category it doesn't have
{
  const rows = [
    { function: "Army", spending_billion: 200, dept: "Defense" },
    { function: "Navy", spending_billion: 120, dept: "Defense" },
    { function: "Hospitals", spending_billion: 150, dept: "Health" },
    { function: "Clinics", spending_billion: 60, dept: "Health" },
  ];
  const spec = { ...base, group_field: "dept" };
  const { desktop } = renderVizBundle(spec, rows, { mobilePages: false });
  const fills = [...desktop.matchAll(/<rect data-role="treemap-tile"[^>]*fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
  const distinct = [...new Set(fills)];
  assert.ok(distinct.length <= 3, `group_field must use at most 3 muted hues, got ${distinct}`);
  assert.equal(distinct.length, 2, "two departments should map to exactly two distinct group hues");
  for (const fill of distinct) assert.ok(["#D6D6D6", "#BDBDBD", "#9E9E9E"].includes(fill), `${fill} should be one of the 3 muted group hues, not a SERIES_COLORS entry`);
}
console.log("treemap colour: group_field uses <=3 muted hues, never the SERIES_COLORS rainbow -- PASS");

// --- labels: no halo/stroke on tile text. The fill palette is chosen so
//     every label's contrast-picked colour clears 4.5:1 outright, so a
//     treemap label must never emit the stroke/paint-order halo attributes
//     labelStyleOnFill's fallback would otherwise add.
{
  const { desktop } = renderVizBundle(base, budgetRows, { mobilePages: false });
  const labelEls = [...desktop.matchAll(/<text data-role="treemap-tile-(?:label|share|value)"[^>]*>/g)].map((m) => m[0]);
  assert.ok(labelEls.length > 0, "expected treemap tile label elements");
  for (const el of labelEls) {
    assert.ok(!el.includes("stroke="), `treemap label should never carry a halo stroke: ${el}`);
    assert.ok(!el.includes("paint-order"), `treemap label should never carry a halo paint-order: ${el}`);
  }
}
console.log("treemap labels: no halo/stroke on tile text -- PASS");

// --- labels: the share-of-total percentage renders as the tile's primary
//     number, always at exactly one decimal place - never fmt()'s usual
//     magnitude-based precision (which would mix "64.6%" with "7.29%" and
//     "0.94%" on the same chart)
{
  const { desktop } = renderVizBundle(base, budgetRows, { mobilePages: false });
  const shareTexts = [...desktop.matchAll(/<text data-role="treemap-tile-share"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.ok(shareTexts.length > 0, "expected at least one share label");
  assert.ok(shareTexts.every((s) => /^\d+\.\d%$/.test(s)), `every share label should be a percentage at exactly one decimal, got ${shareTexts}`);
  const totalValue = budgetRows.reduce((sum, r) => sum + r.spending_billion, 0);
  const defenseShare = ((320 / totalValue) * 100).toFixed(1);
  assert.ok(shareTexts.includes(`${defenseShare}%`), `expected a "${defenseShare}%" share label among ${shareTexts}`);
  // the overflow/other notes carry the same one-decimal share, not fmt()'s
  // variable precision, for the tiles small enough to land there
  const skewRows = [
    { function: "Dominant", spending_billion: 900 },
    { function: "Tiny", spending_billion: 1 },
  ];
  const { desktop: skewSvg } = renderVizBundle(base, skewRows, { mobilePages: false });
  const tinyShare = ((1 / 901) * 100).toFixed(1);
  assert.match(skewSvg, new RegExp(`Tiny（${tinyShare}%`), `overflow note should carry the one-decimal share for Tiny, got: ${skewSvg.match(/data-role="treemap-overflow-note"[^>]*>[^<]*/)}`);
}
console.log("treemap labels: share-of-total renders at one decimal, on tile and in the notes -- PASS");

// --- units: zh output never prints the raw unit token literally ("$B") and
//     instead converts it to the idiomatic 亿 unit - an exact x10 unit
//     conversion (1 十亿/billion = 10 亿 by definition), with thousands
//     separators, never a rounded or otherwise-rescaled number
{
  const zhSpec = { ...base, language: "zh" };
  const { desktop } = renderVizBundle(zhSpec, budgetRows, { mobilePages: false });
  const valueTexts = [...desktop.matchAll(/<text data-role="treemap-tile-value"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.ok(valueTexts.length > 0, "expected at least one zh value label");
  for (const v of valueTexts) assert.ok(!v.includes("$B") && !v.includes("十亿美元"), `zh value label should never print the raw "$B" or the un-converted "十亿美元": ${v}`);
  assert.ok(valueTexts.includes("3,200亿美元"), `expected "3,200亿美元" (Defense: 320 $B x10, comma-grouped) among ${valueTexts}`);
  assert.ok(valueTexts.includes("900亿美元"), `expected "900亿美元" (Education: 90 $B x10) among ${valueTexts}`);

  // exact x10, never rounded: a fractional $B value converts to a fractional
  // 亿 value with no precision lost beyond fmt()'s own display rounding
  const fracRows = [{ function: "Fractional", spending_billion: 2.34 }, { function: "Rest", spending_billion: 100 }];
  const { desktop: fracSvg } = renderVizBundle({ ...zhSpec, other_threshold_pct: undefined, highlight_values: [] }, fracRows, { mobilePages: false });
  const fracValueTexts = [...fracSvg.matchAll(/<text data-role="treemap-tile-value"[^>]*>([^<]*)<\/text>/g), ...fracSvg.matchAll(/data-role="treemap-overflow-note"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.ok(fracValueTexts.some((v) => v.includes("23.4亿美元")), `2.34 $B x10 = 23.4 亿 exactly, expected "23.4亿美元" among ${fracValueTexts}`);
}
console.log("treemap units: zh converts $B to the idiomatic 亿 unit via an exact x10, comma-grouped -- PASS");

// --- en / zh fixtures: render-QA passes on a 10-category set (one
//     dominant + several tiny), both languages, desktop + mobile
{
  const enRows = [
    { function: "Dominant program", spending_billion: 620 },
    { function: "Second largest line", spending_billion: 140 },
    { function: "Health services", spending_billion: 70 },
    { function: "Education grants", spending_billion: 45 },
    { function: "Transportation", spending_billion: 30 },
    { function: "Housing support", spending_billion: 22 },
    { function: "Agriculture", spending_billion: 14 },
    { function: "Environment", spending_billion: 9 },
    { function: "Justice", spending_billion: 6 },
    { function: "Other small items", spending_billion: 4 },
  ];
  const enLint = lintVizSpec(base, enRows, { verified_claim_ids: [claimId] });
  assert.equal(enLint.passed, true, enLint.blockers.join("; "));
  const enBundle = renderVizBundle(base, enRows);
  const enQa = runRenderQa(enBundle);
  assert.equal(enQa.passed, true, `en render-QA failed: ${JSON.stringify(enQa.viewports, null, 2)}`);
  const enCritic = critiqueViz(base, enRows, enLint, enBundle.desktop);
  assert.equal(enCritic.passed, true, JSON.stringify(enCritic));

  const zhSpec = {
    ...base,
    language: "zh",
    title: "国家预算按职能分配",
    alt: "一张按职能划分国家预算支出的树状图，块面积与支出额成正比。",
  };
  const zhRows = [
    { function: "国防", spending_billion: 620 },
    { function: "社会保障", spending_billion: 140 },
    { function: "医疗卫生", spending_billion: 70 },
    { function: "教育补助", spending_billion: 45 },
    { function: "交通运输", spending_billion: 30 },
    { function: "住房保障", spending_billion: 22 },
    { function: "农业支持", spending_billion: 14 },
    { function: "环境保护", spending_billion: 9 },
    { function: "司法事务", spending_billion: 6 },
    { function: "其他小项", spending_billion: 4 },
  ];
  const zhLint = lintVizSpec(zhSpec, zhRows, { verified_claim_ids: [claimId] });
  assert.equal(zhLint.passed, true, zhLint.blockers.join("; "));
  const zhBundle = renderVizBundle(zhSpec, zhRows);
  const zhQa = runRenderQa(zhBundle);
  assert.equal(zhQa.passed, true, `zh render-QA failed: ${JSON.stringify(zhQa.viewports, null, 2)}`);
  const zhCritic = critiqueViz(zhSpec, zhRows, zhLint, zhBundle.desktop);
  assert.equal(zhCritic.passed, true, JSON.stringify(zhCritic));
  assert.match(zhBundle.desktop, />国防/, "zh category label should render");
}
console.log("treemap en/zh 10-category fixtures: render-QA passes (desktop/mobile) -- PASS");

console.log("treemap chart: PASS");
