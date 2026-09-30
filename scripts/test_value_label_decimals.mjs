#!/usr/bin/env node
// Regression tests for the round-2 house-style fix: value-label precision
// must be consistent within a chart, and a value must never round across an
// integer boundary. Reported bug: on the real China-fertility peer-rank
// chart, China's 2023 rate (0.999) rendered as "1 个孩子" while its
// neighbours showed "2.25 个孩子" / "1.62 个孩子" - both a false "China hit
// exactly one child per woman" reading and a decimal count that did not even
// agree across the chart's own five labels.
//
// Root cause: fmt()'s old low-magnitude branch is
// `value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")` -
// (0.999).toFixed(2) itself rounds UP to "1.00" in plain JS, and the
// trailing-zero strip then turns that into the bare, misleadingly-integer
// "1". Two decimals is not enough to dodge this either - only 3 decimals
// keeps 0.999 non-integer, which is why the auto-picked default below lands
// on 3 for this real dataset, matching the approved decimals=3 rule for the
// fertility page.
//
// Fix: fmt()'s new optional third `decimals` argument, when an integer,
// takes over completely (no magnitude branching, no trailing-zero strip) -
// see resolveChartDecimals()/autoValueDecimals() in runtime/pi/viz.mjs. It
// is resolved ONCE per chart from every value that chart will display, so
// every label agrees, and it is only ever active in house style
// (HOUSE_STYLE_ACTIVE) - legacy style keeps the exact old per-value
// behaviour, decimals included.
//
// All data below is the real trend-01 fertility-page data (UN World
// Population Prospects via Our World in Data, the same CSV the real
// viz-peer.json / viz-world.json specs query), not synthetic numbers - this
// mirrors the annotation-lane regression test's real-fixture section.
import assert from "node:assert/strict";
import { renderVizSvg, renderVizMobileSvg, fmt } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

// --- 1. fmt() itself: the exact rounding/formatting contract -----------

// Root-cause proof: 0.999 rounds to a whole number at 0, 1, or 2 decimals -
// only 3 decimals keeps it a visibly non-integer value.
assert.equal((0.999).toFixed(0), "1", "sanity: toFixed(0) rounds 0.999 up");
assert.equal((0.999).toFixed(1), "1.0", "sanity: toFixed(1) rounds 0.999 up");
assert.equal((0.999).toFixed(2), "1.00", "sanity: toFixed(2) rounds 0.999 up");
assert.equal((0.999).toFixed(3), "0.999", "sanity: only toFixed(3) keeps 0.999 non-integer");

// decimals=null (the default): fmt()'s old per-value behaviour, byte-for-byte
// unchanged - this is exactly what legacy style must keep forever.
assert.equal(fmt(0.999, "个孩子"), "1 个孩子", "fmt() with no decimals arg must keep its old (buggy) trailing-zero-stripped behaviour - this is the legacy contract, not something fix 2 is allowed to change");
assert.equal(fmt(0.72, "个孩子"), "0.72 个孩子", "fmt() with no decimals arg: 0.72 has no trailing zero to strip (ends in a non-zero digit), so it renders as-is at 2 decimals");

// decimals=3 (what resolveChartDecimals() picks for this real dataset): no
// rounding across the integer boundary, and trailing zeros are KEPT.
assert.equal(fmt(0.999, "个孩子", 3), "0.999 个孩子", "fmt(value, unit, 3) must never round 0.999 into an integer");
assert.equal(fmt(0.72, "个孩子", 3), "0.720 个孩子", "fmt(value, unit, 3) must keep the trailing zero (0.720, not 0.72)");
assert.equal(fmt(2.251, "个孩子", 3), "2.251 个孩子", "fmt(value, unit, 3) leaves an already-3-decimal value alone");
assert.equal(fmt(1.208, "个孩子", 3), "1.208 个孩子", "fmt(value, unit, 3) on a third real peer value");

// decimals=0: an explicit low decimals count is honoured exactly as given
// (no silent upgrade), including the rounding it implies - callers (schema
// validation) are responsible for not setting an inappropriate value.
assert.equal(fmt(0.999, "个孩子", 0), "1 个孩子", "fmt(value, unit, 0) rounds exactly as toFixed(0) would");

console.log("fmt() decimals contract (root cause + fix): PASS");

// --- 1b. Follow-up fix (b): comma-grouping for large resolved-decimal values

// Root cause: inside the decimals!==null branch, `value.toFixed(decimals)`
// never groups the integer part - the magnitude branches below (the ones
// this branch pre-empts) never needed grouping because they abbreviate
// ("67.5k") instead. Reported: on a chart whose resolved decimals is 0,
// 67500 rendered as the bare, typo-looking "67500" instead of "67,500".
assert.equal(fmt(67500, "", 0), "67,500", "fmt(67500, '', 0): before this fix, printed the ungrouped, typo-looking '67500'");
assert.equal(fmt(67500, "", 1), "67,500.0", "fmt(67500, '', 1): grouping must hold for any resolved decimals count, not just 0");
assert.equal(fmt(9999, "", 0), "9999", "fmt(9999, '', 0): below the 10,000 threshold, must stay ungrouped and byte-identical to before this fix");
assert.equal(fmt(-67500, "", 0), "-67,500", "fmt(-67500, '', 0): the sign must pass through the grouping untouched");
assert.equal(fmt(12345.678, "个孩子", 3), "12,345.678 个孩子", "fmt(): grouping must compose with an existing unit suffix and a non-zero decimals count");

console.log("fmt() follow-up fix: large resolved-decimal values (>=10,000) are comma-grouped, 9999 and below unchanged: PASS");

// renderHorizontal/renderMobileHorizontal's two value-label branches are the
// only text nodes in their output that set font-weight="600" - axis ticks
// (addHorizontalAxis) and category-name labels never set font-weight at
// all, so this precisely isolates value labels from everything else in the
// same chart, including fix 3's still-open "unit repeats on every tick" bug.
function extractValueLabelTexts(svg) {
  return [...svg.matchAll(/<text[^>]*font-weight="600"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

// renderLine/renderMobileLine's end labels are the only text nodes tagged
// data-role="direct-label" - this isolates them from axis ticks and x-axis
// category labels the same way, for the line-chart case.
function extractDirectLabelTexts(svg) {
  return [...svg.matchAll(/<text data-role="direct-label"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}

// --- 2. Real viz-peer.json (dot, direct_labels:true, 5 economies, 2023) -

// Exact real 2023 rows for these five economies, from the same source CSV
// viz-peer.json's own SQL queries (Entity, Year, "Fertility rate"),
// including its `CASE Entity WHEN 'South Korea' THEN 'Korea, Rep.'` rename -
// and matching viz-peer.json's own `alt` text verbatim: "世界平均 2.251、
// 美国 1.624、日本 1.208、中国 0.999、韩国 0.720".
const peerRows = [
  { entity: "World", tfr: 2.251 },
  { entity: "United States", tfr: 1.624 },
  { entity: "Japan", tfr: 1.208 },
  { entity: "China", tfr: 0.999 },
  { entity: "Korea, Rep.", tfr: 0.72 },
];
const peerSpec = {
  schema_version: "0.7.0",
  reader_task: "ranking",
  chart_type: "dot",
  language: "zh",
  title: "总和生育率，2023 年",
  takeaway: "2023 年中国总和生育率为 0.999，低于世界平均、美国和日本，只高于韩国。",
  alt: "点图：2023 年五个经济体总和生育率从高到低排列——世界平均 2.251、美国 1.624、日本 1.208、中国 0.999、韩国 0.720。",
  source_note: "联合国世界人口展望估计数，经 Our World in Data 转存",
  claim_id: "claim-702e6061e3521144",
  sql: "SELECT * FROM synthetic",
  unit: "个孩子",
  category_field: "entity",
  value_field: "tfr",
  category_names: "worldbank",
  sort: "desc",
  direct_labels: true,
  x_field: "tfr",
  x_unit: "个孩子",
  highlight_values: ["China"],
};

function assertAllThreeDecimals(svg, label) {
  const labels = extractValueLabelTexts(svg);
  assert.equal(labels.length, 5, `${label}: expected exactly 5 value labels, got ${JSON.stringify(labels)}`);
  // Fix 3 (units repeat on every tick/label): a dot chart's direct value
  // labels carry the unit on the first rendered label only (sorted desc, so
  // World's 2.251 个孩子); the remaining four are bare numbers. All five
  // must still share the same 3-decimal precision - that is the actual bug
  // this test guards: China's 0.999 must never collapse to a bare "1".
  const expected = ["2.251 个孩子", "1.624", "1.208", "0.999", "0.720"];
  assert.deepEqual(labels, expected, `${label}: expected ${JSON.stringify(expected)} (unit on first label only, fix 3); got ${JSON.stringify(labels)}`);
  assert.ok(!labels.includes("1") && !labels.includes("1 个孩子"), `${label}: a value label rounded to the old integer "1": ${JSON.stringify(labels)}`);
}

const peerSvg = renderVizSvg(peerSpec, peerRows);
assertAllThreeDecimals(peerSvg, "desktop viz-peer.json fixture");

const peerMobileSvg = renderVizMobileSvg(peerSpec, peerRows);
assertAllThreeDecimals(peerMobileSvg, "mobile viz-peer.json fixture");

console.log("real viz-peer.json fixture (5 economies, 2023): consistent 3-decimal labels, desktop + mobile: PASS");

// --- 3. Real viz-world.json (multi_line, China vs. World, 1990-2023) ---

// Exact real China + World rows, 1990-2023, from the same source CSV
// viz-world.json's own SQL queries - matching its own `alt` text verbatim:
// "世界平均从 3.310 缓慢降到 2.251；中国从 2.514 快速降到 0.999".
const worldRowsByYear = {
  1990: [2.514, 3.31], 1991: [1.934, 3.131], 1992: [1.776, 3.044], 1993: [1.691, 2.98],
  1994: [1.628, 2.933], 1995: [1.588, 2.889], 1996: [1.554, 2.846], 1997: [1.527, 2.809],
  1998: [1.522, 2.776], 1999: [1.53, 2.75], 2000: [1.628, 2.754], 2001: [1.563, 2.714],
  2002: [1.566, 2.684], 2003: [1.57, 2.659], 2004: [1.605, 2.647], 2005: [1.624, 2.63],
  2006: [1.644, 2.625], 2007: [1.666, 2.623], 2008: [1.701, 2.626], 2009: [1.714, 2.621],
  2010: [1.687, 2.602], 2011: [1.668, 2.588], 2012: [1.798, 2.607], 2013: [1.714, 2.572],
  2014: [1.769, 2.564], 2015: [1.67, 2.537], 2016: [1.772, 2.536], 2017: [1.795, 2.504],
  2018: [1.539, 2.437], 2019: [1.496, 2.397], 2020: [1.236, 2.322], 2021: [1.117, 2.291],
  2022: [1.034, 2.265], 2023: [0.999, 2.251],
};
const worldRows = [];
for (const [year, [china, world]] of Object.entries(worldRowsByYear)) {
  worldRows.push({ year: Number(year), entity: "China", tfr: china });
  worldRows.push({ year: Number(year), entity: "World", tfr: world });
}
const worldSpec = {
  schema_version: "0.7.0",
  reader_task: "change",
  chart_type: "multi_line",
  language: "zh",
  title: "2017 年后，与世界平均差距迅速拉大",
  takeaway: "中国总和生育率 1990 年以来始终低于世界平均；2017 年后与世界平均的差距迅速拉大，从 0.709 扩大到 2023 年的 1.252。",
  alt: "双线折线图：中国与世界平均总和生育率，1990-2023 年。世界平均从 3.310 缓慢降到 2.251；中国从 2.514 快速降到 0.999。",
  source_note: "联合国世界人口展望估计数，经 Our World in Data 转存",
  claim_id: "claim-702e6061e3521144",
  sql: "SELECT * FROM synthetic",
  unit: "个孩子",
  x_field: "year",
  value_field: "tfr",
  series_field: "entity",
  highlight_values: ["China"],
  category_names: "worldbank",
};

function assertWorldEndLabels(svg, label) {
  const labels = extractDirectLabelTexts(svg);
  assert.ok(labels.length >= 2, `${label}: expected at least 2 end labels, got ${JSON.stringify(labels)}`);
  assert.ok(labels.some((t) => t.endsWith("0.999 个孩子")), `${label}: expected an end label ending in "0.999 个孩子" (China); got ${JSON.stringify(labels)}`);
  assert.ok(labels.some((t) => t.endsWith("2.251 个孩子")), `${label}: expected an end label ending in "2.251 个孩子" (World); got ${JSON.stringify(labels)}`);
  assert.ok(!labels.some((t) => t.endsWith(" 1 个孩子") || t === "1 个孩子"), `${label}: an end label rounded to the old integer "1 个孩子": ${JSON.stringify(labels)}`);
}

const worldSvg = renderVizSvg(worldSpec, worldRows);
assertWorldEndLabels(worldSvg, "desktop viz-world.json fixture");

const worldMobileSvg = renderVizMobileSvg(worldSpec, worldRows);
assertWorldEndLabels(worldMobileSvg, "mobile viz-world.json fixture");

console.log("real viz-world.json fixture (China vs. World, 1990-2023): consistent 3-decimal end labels, desktop + mobile: PASS");

// --- 4. Legacy style must stay byte-identical (old, still-buggy output) -

// style_id:"legacy" must resolve HOUSE_STYLE_ACTIVE to false, so
// resolveChartDecimals() returns null and fmt() takes its untouched old
// branch - i.e. legacy still shows the bare "1", because fix 2 is not
// allowed to change legacy output at all, bug included.
const legacyPeerSvg = renderVizSvg({ ...peerSpec, style_id: "legacy" }, peerRows);
const legacyPeerLabels = extractValueLabelTexts(legacyPeerSvg);
// This is the bug itself, preserved: legacy shows China's 0.999 as a bare
// "1" (0 decimals) and Korea's 0.72 as "0.72" (2 decimals) in the very same
// chart - exactly the inconsistent precision fix 2 exists to fix in house
// style, kept fully intact, byte-for-byte, in legacy.
assert.ok(legacyPeerLabels.includes("1 个孩子"), `legacy style must keep its old (pre-fix) rounded-to-integer output for 0.999 - fix 2 must not touch legacy rendering: ${JSON.stringify(legacyPeerLabels)}`);
assert.ok(legacyPeerLabels.includes("0.72 个孩子"), `legacy style: Korea's 0.72 must still render as the old-format 0.72 个孩子: ${JSON.stringify(legacyPeerLabels)}`);
assert.ok(!legacyPeerLabels.includes("0.999 个孩子"), "legacy style must not pick up the new 3-decimal formatting");
assert.ok(!legacyPeerLabels.includes("0.720 个孩子"), "legacy style must not print Korea's value at 3 decimals (0.720)");

const legacyWorldSvg = renderVizSvg({ ...worldSpec, style_id: "legacy" }, worldRows);
const legacyWorldLabels = extractDirectLabelTexts(legacyWorldSvg);
assert.ok(legacyWorldLabels.some((t) => t.endsWith(" 1 个孩子") || t === "1 个孩子"), `legacy multi_line style must keep its old rounded-to-integer end label for China's 0.999: ${JSON.stringify(legacyWorldLabels)}`);
assert.ok(!legacyWorldLabels.some((t) => t.endsWith("0.999 个孩子")), "legacy multi_line style must not pick up the new 3-decimal formatting");

console.log("legacy style (style_id=\"legacy\"): old per-value formatting untouched, byte-for-byte: PASS");

// --- 5. Axis ticks are unaffected: they keep tickLabel()'s own formatting -

// tickLabel() is a completely separate function from fmt() and this fix
// never touches it - assert the axis still uses its own nice-number rule
// (e.g. a "2.5" or "3" tick, never a value forced to 3 decimals like
// "2.500") by checking no axis tick text happens to carry 3 decimals.
const axisTickTexts = [...worldSvg.matchAll(/<text x="[-0-9.]+" y="[-0-9.]+" text-anchor="end" font-family="[^"]+" font-size="12" fill="[^"]+">([^<]*)<\/text>/g)].map((m) => m[1]);
assert.ok(axisTickTexts.length > 0, "expected to find axis tick labels in the world.json fixture");
assert.ok(!axisTickTexts.some((t) => /\.\d{3}/.test(t)), `axis ticks must keep their own nice-number formatting, not the 3-decimal value-label rule: ${JSON.stringify(axisTickTexts)}`);

console.log("axis ticks keep tickLabel()'s own nice-number formatting, independent of value-label decimals: PASS");

console.log("value-label decimal precision regression: PASS");

// --- 6. Follow-up fix (a): a genuine tie must not force decimal escalation

// Root cause: autoValueDecimals()'s old `distinguishable` check compared the
// number of distinct *strings* at a given decimal count to the *raw* number
// of values, duplicates included. Two categories that are genuinely, exactly
// equal (e.g. rows of 5 and 5) can never be told apart by trying more
// decimals, so that comparison always failed and drove the loop to the
// 3-decimal cap - a real tie like [5, 5, 3] rendered "5.000"/"5.000"/"3.000"
// instead of stopping at the correct, simplest "5"/"5"/"3" at d=0. Fixed by
// comparing the distinct-string count to the distinct-*value* count instead.
// Driven through a real chart render (not fmt()/autoValueDecimals() in
// isolation - autoValueDecimals() is not exported) using the same dot-chart,
// direct-label-extraction path as section 2 above.
function tieSpec(values, unit = "widgets") {
  const categories = ["A", "B", "C", "D"].slice(0, values.length);
  return {
    schema_version: "0.7.0",
    reader_task: "ranking",
    chart_type: "dot",
    title: "Tie-escalation fixture",
    takeaway: "Synthetic tie-escalation fixture.",
    alt: "Synthetic fixture exercising autoValueDecimals' tie-escalation fix.",
    source_note: "Synthetic fixture",
    claim_id: "claim-tie-escalation",
    sql: "SELECT * FROM synthetic",
    unit,
    category_field: "category",
    value_field: "value",
    sort: "desc",
    direct_labels: true,
    x_field: "value",
    x_unit: unit,
    highlight_values: [categories[0]],
  };
}
function tieRows(values) {
  const categories = ["A", "B", "C", "D"].slice(0, values.length);
  return categories.map((category, i) => ({ category, value: values[i] }));
}
// Fix 3 puts the unit on the chart's first (sorted-desc) label only, the
// rest are bare numbers (section 2's own assertAllThreeDecimals relies on
// the same behaviour) - strip that optional trailing " <unit>" so every
// label can be compared on its number alone, regardless of which one
// happens to carry it.
function numericPart(label) {
  return label.replace(/\s+\S+$/, "");
}

{
  const values = [5, 5, 3];
  const labels = extractValueLabelTexts(renderVizSvg(tieSpec(values), tieRows(values))).map(numericPart);
  assert.deepEqual(labels, ["5", "5", "3"], `tie-escalation 1/4: an exact integer tie ([5,5,3]) must resolve at d=0, not escalate to the 3dp cap: ${JSON.stringify(labels)}`);
}
console.log("tie-escalation 1/4: an exact integer tie ([5,5,3]) resolves at d=0, not the 3dp cap: PASS");

{
  const values = [2.5, 2.5, 1.2];
  const labels = extractValueLabelTexts(renderVizSvg(tieSpec(values), tieRows(values))).map(numericPart);
  // d=0 is rejected regardless (2.5 would round to the whole number "3",
  // crossing the integer boundary) - d=1 is both boundary-safe and, under
  // the fix, correctly recognises the repeated 2.5 as a genuine tie rather
  // than a reason to escalate past d=1.
  assert.deepEqual(labels, ["2.5", "2.5", "1.2"], `tie-escalation 2/4: a tie among non-integer values ([2.5,2.5,1.2]) must resolve at the boundary-safe d=1, not escalate further just because 2.5 repeats: ${JSON.stringify(labels)}`);
}
console.log("tie-escalation 2/4: a non-integer tie ([2.5,2.5,1.2]) resolves at the boundary-safe d=1, not further: PASS");

{
  const values = [5.01, 5.02, 3];
  const labels = extractValueLabelTexts(renderVizSvg(tieSpec(values), tieRows(values))).map(numericPart);
  // Guards against overcorrection: genuinely different values that only
  // *look* tied at low precision (both round to "5" at d=0 and d=1) must
  // still escalate until distinguishable - sort:"desc" renders 5.02 (B)
  // before 5.01 (A) before 3 (C).
  assert.deepEqual(labels, ["5.02", "5.01", "3.00"], `tie-escalation 3/4: genuinely different near-tied values ([5.01,5.02,3]) must still escalate to disambiguate (sorted desc): ${JSON.stringify(labels)}`);
}
console.log("tie-escalation 3/4: genuinely different near-tied values ([5.01,5.02,3]) still escalate to disambiguate: PASS");

{
  const values = [7, 7, 7, 7];
  const labels = extractValueLabelTexts(renderVizSvg(tieSpec(values), tieRows(values))).map(numericPart);
  assert.deepEqual(labels, ["7", "7", "7", "7"], `tie-escalation 4/4: a four-way exact tie ([7,7,7,7]) must resolve at d=0, not escalate: ${JSON.stringify(labels)}`);
}
console.log("tie-escalation 4/4: a four-way exact tie ([7,7,7,7]) resolves at d=0: PASS");

// --- 7. Follow-up fix (b): comma-grouping composes with a real chart's ----
//        end-label placement and text-width estimate, and passes render-QA.

// Every label-width estimate in viz.mjs (the ones that size a chart's right
// gutter and end-label placement boxes) calls `textUnits(fmt(...))` on the
// already-formatted string, never on the raw number - so a wider,
// comma-grouped label is automatically accounted for by construction. This
// renders a real multi_line chart (the same shape as section 3's
// viz-world.json fixture) with large, whole-number, monotonically rising
// values that push the resolved decimals to 0 and the highlighted series'
// end label (67500) past the 10,000 comma-grouping threshold, then asserts
// render-QA still passes - i.e. the extra comma character never overflows
// the plot's gutter or collides with anything.
const bigSpec = {
  schema_version: "0.7.0",
  reader_task: "change",
  chart_type: "multi_line",
  title: "Comma-grouping fixture",
  takeaway: "Synthetic large-value fixture for the comma-grouping fix.",
  alt: "Synthetic fixture exercising fmt()'s comma-grouping fix on a real chart's end label.",
  source_note: "Synthetic fixture",
  claim_id: "claim-comma-grouping",
  sql: "SELECT * FROM synthetic",
  unit: "元",
  x_field: "year",
  value_field: "value",
  series_field: "entity",
  highlight_values: ["China"],
};
const bigRows = [
  { year: 2020, entity: "China", value: 30000 },
  { year: 2021, entity: "China", value: 50000 },
  { year: 2022, entity: "China", value: 67500 },
  { year: 2020, entity: "World", value: 20000 },
  { year: 2021, entity: "World", value: 35000 },
  { year: 2022, entity: "World", value: 52000 },
];
const bigSvg = renderVizSvg(bigSpec, bigRows);
const bigMobileSvg = renderVizMobileSvg(bigSpec, bigRows);
const bigLabels = extractDirectLabelTexts(bigSvg);
assert.ok(bigLabels.some((t) => t.endsWith("67,500 元")), `expected a comma-grouped end label for 67500: ${JSON.stringify(bigLabels)}`);
assert.ok(!bigLabels.some((t) => /(?<!,)\b67500\b/.test(t)), `must not print the ungrouped, typo-looking "67500": ${JSON.stringify(bigLabels)}`);

const bigQa = runRenderQa({ desktop: bigSvg, mobile: bigMobileSvg });
assert.equal(bigQa.passed, true, `render-QA on a comma-grouped (wider) end label must still pass geometry/contrast checks - the extra comma must not overflow the plot's gutter: ${JSON.stringify(bigQa.viewports)}`);

console.log("comma-grouping composes correctly with a real chart's end-label placement/text-width estimate and passes render-QA: PASS");
