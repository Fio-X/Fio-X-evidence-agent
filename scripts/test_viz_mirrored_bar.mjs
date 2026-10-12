#!/usr/bin/env node
// Covers the mirrored_bar chart type: two series drawn back to back around a
// centre gutter that holds the category labels (a population pyramid is the
// typical use), on ONE symmetric axis, with an optional second period drawn
// either as an outline over the same rows ("overlay") or as a second pyramid
// beside the first ("side_by_side").
//
// Every case here uses deterministic synthetic data. The suite reads the
// rendered SVG back (bars, gridlines, labels) instead of re-implementing the
// renderer's layout, so each drawing rule is checked against what a reader
// would see: one scale for both sides, bars flush to the gutter, the label
// thinning rule, the colour roles, the printed-number rule. Lint blockers
// and warnings are each refused and accepted at their boundary, the product's
// own render QA (runtime/pi/render_qa.mjs) must pass on the typical cases,
// and three SVG snapshots (fixtures/viz-mirrored-bar/) pin the exact output.
//
// Snapshots are rewritten only with this test's own flag:
//   node scripts/test_viz_mirrored_bar.mjs --update
// A missing snapshot fails and says so; a changed one fails until reviewed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHART_TYPES, HOUSE_FONT_SANS, HOUSE_PALETTES, critiqueViz, lintVizSpec, renderVizBundle, renderVizMobileSvg, renderVizSvg, validateVizSpec } from "../runtime/pi/viz.mjs";
import { runRenderQa, valuesAllZero } from "../runtime/pi/render_qa.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

// The house style is the default; a legacy switch in the caller's environment
// must not change what this suite pins. Restored at the end.
const savedStyleEnv = process.env.NEWSROOM_HOUSE_STYLE;
delete process.env.NEWSROOM_HOUSE_STYLE;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const fixtureDir = path.join(repoRoot, "fixtures", "viz-mirrored-bar");
const update = process.argv.includes("--update");
const P = HOUSE_PALETTES.house;
const claimId = "claim-mirrored-fixture";

function check(name, fn) {
  fn();
  console.log(`mirrored_bar ${name} -- PASS`);
}

// ---------------------------------------------------------------------------
// Synthetic data and specs
// ---------------------------------------------------------------------------
const BANDS_18 = ["0-4", "5-9", "10-14", "15-19", "20-24", "25-29", "30-34", "35-39", "40-44", "45-49", "50-54", "55-59", "60-64", "65-69", "70-74", "75-79", "80-84", "85+"];
const SIDES = ["Side A", "Side B"];

// 1.2 .. 4.4 in steps of 0.2: one decimal, so a printed label equals its row value exactly.
const wave = (band, side, period) => Math.round((1.2 + ((band * 7 + side * 5 + period * 3) % 17) * 0.2) * 10) / 10;

// Rows are emitted period by period, band by band, side by side.
function buildRows({ bands = BANDS_18, sides = SIDES, periods = [2010, 2020], cellValue = wave } = {}) {
  const rows = [];
  for (const [p, period] of periods.entries()) {
    for (const [b, band] of bands.entries()) {
      for (const [s, side] of sides.entries()) rows.push({ band, side, period, share: cellValue(b, s, p) });
    }
  }
  return rows;
}

const base = {
  schema_version: "0.9.0",
  reader_task: "comparison",
  takeaway: "The older bands grew and the youngest bands shrank between the two periods.",
  title: "Share of each age band, by side",
  subtitle: "Synthetic fixture data, share of the total in %",
  alt: "A back-to-back bar chart of the share of each age band for two sides in two periods, fixture data.",
  source_note: "Synthetic fixture, no real source",
  claim_id: claimId,
  sql: "SELECT band, side, period, share FROM fixture",
  unit: "%",
  chart_type: "mirrored_bar",
  category_field: "band",
  series_field: "side",
  value_field: "share",
  highlight_values: [],
  annotations: [],
};
const withPeriods = { ...base, period_field: "period" };
const lintCtx = { verified_claim_ids: [claimId] };

// ---------------------------------------------------------------------------
// SVG read-back helpers (no geometry is re-derived from the renderer's code)
// ---------------------------------------------------------------------------
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function elements(svg, tag) {
  const out = [];
  for (const m of svg.matchAll(new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, "g"))) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push({ ...attrs, text: m[2] === undefined ? "" : decode(m[2]) });
  }
  return out;
}
const role = (svg, tag, name) => elements(svg, tag).filter((e) => e["data-role"] === name);
const num = (e, key) => Number(e[key]);
const viewWidth = (svg) => Number(/viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)[1]);
const numeric = (text) => Number(text.replace(/[^\d.]/g, ""));
const near = (a, b, tol = 0.03) => Math.abs(a - b) <= tol;

// One pyramid's geometry as drawn. panels = 2 selects the left (0) or right (1) pyramid.
function analyse(svg, { panel = 0, panels = 1 } = {}) {
  const mid = viewWidth(svg) / 2;
  const inPanel = (x) => panels === 1 || (panel === 0 ? x < mid : x > mid);
  const gridX = [...new Set(role(svg, "line", "grid-line").map((l) => num(l, "x1")).filter(inPanel))].sort((a, b) => a - b);
  assert.equal(gridX.length % 2, 0, "gridlines come in mirrored pairs");
  const tickCount = gridX.length / 2;
  const gl = gridX[tickCount - 1];
  const gr = gridX[tickCount];
  const centre = (gl + gr) / 2;
  const tickTexts = role(svg, "text", "axis-tick-label").filter((t) => inPanel(num(t, "x")));
  const rightTicks = tickTexts.filter((t) => num(t, "x") > centre).sort((a, b) => num(a, "x") - num(b, "x"));
  const leftTicks = tickTexts.filter((t) => num(t, "x") < centre).sort((a, b) => num(b, "x") - num(a, "x"));
  const outer = rightTicks.at(-1);
  const k = (num(outer, "x") - gr) / numeric(outer.text); // px per unit of value_field
  const byY = (a, b) => num(a, "y") - num(b, "y") || num(a, "x") - num(b, "x");
  const box = (r) => ({ x: num(r, "x"), y: num(r, "y"), w: num(r, "width"), h: num(r, "height"), fill: r.fill, stroke: r.stroke, opacity: Number(r["stroke-opacity"]) });
  const bars = role(svg, "rect", "data-bar").sort(byY).map(box).filter((b) => inPanel(b.x + b.w / 2));
  const outlines = role(svg, "rect", "data-bar-outline").sort(byY).map(box).filter((b) => inPanel(b.x + b.w / 2));
  const ys = [...new Set(bars.map((b) => b.y))].sort((a, b) => a - b); // top row first
  const rowAt = (y) => ys.findIndex((top) => y >= top - 0.01 && y <= top + bars[0].h + 0.01);
  const isLeft = (b) => b.x + b.w <= gl + 0.03;
  const inPanelText = (t) => inPanel(num(t, "x"));
  return {
    gl, gr, centre, tickCount, k, gridX, ys, rowAt, bars, outlines,
    ticks: { left: leftTicks, right: rightTicks },
    leftBars: bars.filter(isLeft),
    rightBars: bars.filter((b) => !isLeft(b)),
    // value drawn for the bar of side ("left"|"right") at a row slot (0 = top row)
    valueAt: (slot, side) => {
      const b = bars.find((bar) => bar.y === ys[slot] && (side === "left" ? isLeft(bar) : !isLeft(bar)));
      return b ? b.w / k : null;
    },
    // gutter labels, series names, value labels: top to bottom
    labels: role(svg, "text", "category-label").filter(inPanelText).sort(byY),
    names: role(svg, "text", "series-name").filter(inPanelText).sort((a, b) => num(a, "x") - num(b, "x")),
    valueLabels: role(svg, "text", "bar-value-label").filter(inPanelText).sort(byY),
  };
}

// The bundle's QA, as the product runs it, plus the opt-in stroke z-order rule.
function assertQaClean(spec, rows, name, family = HOUSE_FONT_SANS) {
  const bundle = renderVizBundle(spec, rows, { mobilePages: false });
  const qa = runRenderQa(bundle);
  assert.equal(qa.passed, true, `${name}: render QA failed: ${JSON.stringify(qa.viewports.desktop.geometry.failures.concat(qa.viewports.desktop.contrast.failures)).slice(0, 700)}`);
  assert.equal(qa.failure_count, 0, name);
  const z = checkSvgGeometry(bundle.desktop, { checkStrokeZOrder: true });
  assert.equal(z.passed, true, `${name}: ${JSON.stringify(z.failures).slice(0, 500)}`);
  assertFontsAndTokens(bundle.desktop, name, family);
  return bundle.desktop;
}

// An independent scan (not the product's own geometry rule): no font-size under 12,
// one sans stack everywhere (the house one unless the legacy style is asked for), no non-finite or undefined token anywhere.
function assertFontsAndTokens(svg, name, family = HOUSE_FONT_SANS) {
  const sizes = [...svg.matchAll(/font-size="([^"]*)"/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 0, name);
  assert.ok(sizes.every((s) => Number.isFinite(s) && s >= 12), `${name}: font sizes ${[...new Set(sizes)].join(",")}`);
  const families = [...new Set([...svg.matchAll(/font-family="([^"]*)"/g)].map((m) => decode(m[1])))];
  assert.deepEqual(families, [family], `${name}: ${families.join(" | ")}`);
  assert.ok(!/NaN|Infinity|undefined|\[object/.test(svg), `${name}: non-finite or undefined token in the SVG`);
}

const lintOf = (spec, rows) => lintVizSpec(spec, rows, lintCtx);
const blockerMatching = (lint, re) => lint.blockers.some((b) => re.test(b));
const warningMatching = (lint, re) => lint.warnings.some((w) => re.test(w));

const typical = buildRows();
const currentValues = (rows, period) => rows.filter((r) => r.period === period).map((r) => r.share);

// ===========================================================================
// 1. Registry: chart type, validation, schema
// ===========================================================================
check("registry: chart type is listed and a complete spec validates", () => {
  assert.ok(CHART_TYPES.includes("mirrored_bar"));
  assert.deepEqual(validateVizSpec({ ...withPeriods, left_series: "Side B", first_row: "top", current_period: 2010, compare_layout: "side_by_side", direct_labels: true }), []);
  assert.deepEqual(validateVizSpec(base), []);
});

check("registry: validateVizSpec refuses malformed optional fields and missing required ones", () => {
  const errors = (extra, drop = []) => {
    const spec = { ...withPeriods, ...extra };
    for (const key of drop) delete spec[key];
    return validateVizSpec(spec);
  };
  assert.ok(errors({ first_row: "middle" }).some((e) => /first_row/.test(e)));
  assert.ok(errors({ compare_layout: "stacked" }).some((e) => /compare_layout/.test(e)));
  assert.ok(errors({ direct_labels: "yes" }).some((e) => /direct_labels/.test(e)));
  assert.ok(errors({ left_series: "" }).some((e) => /left_series/.test(e)));
  assert.ok(errors({ current_period: "   " }).some((e) => /current_period/.test(e)));
  assert.ok(errors({ period_field: { a: 1 } }).some((e) => /period_field/.test(e)));
  for (const key of ["category_field", "series_field", "value_field"]) {
    assert.ok(errors({}, [key]).some((e) => e.includes(`Missing required field '${key}'`)), key);
  }
  // each accepted value of the two enums
  for (const first_row of ["bottom", "top"]) assert.deepEqual(errors({ first_row }), []);
  for (const compare_layout of ["overlay", "side_by_side"]) assert.deepEqual(errors({ compare_layout }), []);
});

check("registry: the schema names the type, its five new fields and its required fields", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas", "newsroom-viz-spec.schema.json"), "utf8"));
  assert.ok(schema.properties.chart_type.enum.includes("mirrored_bar"));
  for (const field of ["left_series", "first_row", "period_field", "current_period", "compare_layout"]) assert.ok(schema.properties[field], field);
  assert.deepEqual(schema.properties.first_row.enum, ["bottom", "top"]);
  assert.deepEqual(schema.properties.compare_layout.enum, ["overlay", "side_by_side"]);
  const block = schema.allOf.find((entry) => entry.if?.properties?.chart_type?.const === "mirrored_bar");
  assert.ok(block, "an if/then block for mirrored_bar");
  assert.deepEqual(block.then.required, ["category_field", "series_field", "value_field"]);
  // additionalProperties is false: every key of a fully dressed spec must be declared
  assert.equal(schema.additionalProperties, false);
  const dressed = { ...withPeriods, left_series: "Side B", first_row: "top", current_period: 2010, compare_layout: "side_by_side", direct_labels: true, decimals: 1, language: "en" };
  for (const key of Object.keys(dressed)) assert.ok(key in schema.properties, `schema is missing '${key}'`);
});

// ===========================================================================
// 2. Lint: blockers refused and accepted at the boundary, then the warnings
// ===========================================================================
check("lint: a well-formed overlay spec passes with no blockers and no warnings", () => {
  const lint = lintOf(withPeriods, typical);
  assert.equal(lint.passed, true, lint.blockers.join("; "));
  assert.deepEqual(lint.blockers, []);
  assert.deepEqual(lint.warnings, []);
  // one period, no period_field
  const single = lintOf(base, buildRows({ periods: [2020] }));
  assert.equal(single.passed, true, single.blockers.join("; "));
  assert.deepEqual(single.warnings, []);
});

check("lint: more than 25 categories is blocked, exactly 25 is accepted", () => {
  const bands = (count) => Array.from({ length: count }, (_, i) => `Band ${String(i + 1).padStart(2, "0")}`);
  const at25 = lintOf(withPeriods, buildRows({ bands: bands(25) }));
  assert.equal(at25.passed, true, at25.blockers.join("; "));
  assert.ok(!blockerMatching(at25, /categories/));
  const at26 = lintOf(withPeriods, buildRows({ bands: bands(26) }));
  assert.equal(at26.passed, false);
  assert.ok(blockerMatching(at26, /26 categories; maximum is 25/), at26.blockers.join("; "));
});

check("lint: exactly 2 distinct series_field values are required", () => {
  const sidesOf = (sides) => lintOf(withPeriods, buildRows({ sides }));
  assert.equal(sidesOf(["Side A", "Side B"]).passed, true);
  for (const sides of [["Side A"], ["Side A", "Side B", "Side C"]]) {
    const lint = sidesOf(sides);
    assert.equal(lint.passed, false, sides.join());
    assert.ok(blockerMatching(lint, new RegExp(`exactly 2 distinct values .*found ${sides.length}`)), lint.blockers.join("; "));
  }
});

check("lint: at most 2 periods; one period value and no period_field are fine", () => {
  assert.equal(lintOf(withPeriods, buildRows({ periods: [2010, 2020] })).passed, true);
  const three = lintOf(withPeriods, buildRows({ periods: [2000, 2010, 2020] }));
  assert.equal(three.passed, false);
  assert.ok(blockerMatching(three, /has 3 distinct values; maximum is 2/), three.blockers.join("; "));
  // a period_field holding a single value is just one period
  assert.equal(lintOf(withPeriods, buildRows({ periods: [2020] })).passed, true);
  // a period_field the rows do not have
  const absent = lintOf({ ...base, period_field: "year" }, typical);
  assert.equal(absent.passed, false);
  assert.ok(blockerMatching(absent, /Field 'year' is absent from query output/), absent.blockers.join("; "));
});

check("lint: a duplicate (category, series, period) row is blocked, the same cell in another period is not", () => {
  // the same band and side in two periods is two cells, not a duplicate
  assert.ok(!blockerMatching(lintOf(withPeriods, typical), /duplicate/));
  // a repeated row is
  const dup = lintOf(withPeriods, [...typical, { ...typical[0], share: 2.5 }]);
  assert.equal(dup.passed, false);
  assert.ok(blockerMatching(dup, /1 duplicate \(category, series, period\) row/), dup.blockers.join("; "));
  const dup3 = lintOf(withPeriods, [...typical, { ...typical[0] }, { ...typical[1] }, { ...typical[2] }]);
  assert.ok(blockerMatching(dup3, /3 duplicate/), dup3.blockers.join("; "));
  // two periods of rows with no period_field to tell them apart: every cell is duplicated
  const noPeriodField = lintOf(base, typical);
  assert.equal(noPeriodField.passed, false);
  assert.ok(blockerMatching(noPeriodField, /duplicate/), noPeriodField.blockers.join("; "));
});

check("lint: a negative value is blocked, zero is accepted; non-numeric and non-finite values are blocked", () => {
  const withValue = (value) => typical.map((row, i) => (i === 5 ? { ...row, share: value } : row));
  assert.equal(lintOf(withPeriods, withValue(0)).passed, true);
  const negative = lintOf(withPeriods, withValue(-0.1));
  assert.equal(negative.passed, false);
  assert.ok(blockerMatching(negative, /value_field 'share' must be >= 0/), negative.blockers.join("; "));
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "abc", null, ""]) {
    const lint = lintOf(withPeriods, withValue(bad));
    assert.equal(lint.passed, false, String(bad));
    assert.ok(blockerMatching(lint, /Field 'share' contains non-numeric or missing values/), `${String(bad)}: ${lint.blockers.join("; ")}`);
  }
  // numeric strings are numbers, as everywhere else in the product
  assert.equal(lintOf(withPeriods, withValue("2.5")).passed, true);
});

check("lint: left_series and current_period must exist in the data", () => {
  assert.equal(lintOf({ ...withPeriods, left_series: "Side B" }, typical).passed, true);
  const noSide = lintOf({ ...withPeriods, left_series: "Side C" }, typical);
  assert.equal(noSide.passed, false);
  assert.ok(blockerMatching(noSide, /left_series 'Side C' is not a value of 'side'/), noSide.blockers.join("; "));
  // number or string spelling of a period both match the rows' 2010
  assert.equal(lintOf({ ...withPeriods, current_period: 2010 }, typical).passed, true);
  assert.equal(lintOf({ ...withPeriods, current_period: "2010" }, typical).passed, true);
  const noPeriod = lintOf({ ...withPeriods, current_period: 2015 }, typical);
  assert.equal(noPeriod.passed, false);
  assert.ok(blockerMatching(noPeriod, /current_period '2015' is not a value of 'period'/), noPeriod.blockers.join("; "));
  // current_period with no period_field to look it up in
  const orphan = lintOf({ ...base, current_period: 2020 }, buildRows({ periods: [2020] }));
  assert.equal(orphan.passed, false);
  assert.ok(blockerMatching(orphan, /current_period needs a period_field/), orphan.blockers.join("; "));
});

check("lint: more than 20 categories warns, 20 does not; a missing cell warns", () => {
  const bands = (count) => Array.from({ length: count }, (_, i) => `Band ${String(i + 1).padStart(2, "0")}`);
  const at20 = lintOf(withPeriods, buildRows({ bands: bands(20) }));
  assert.equal(at20.passed, true);
  assert.ok(!warningMatching(at20, /categories/), at20.warnings.join("; "));
  const at21 = lintOf(withPeriods, buildRows({ bands: bands(21) }));
  assert.equal(at21.passed, true, at21.blockers.join("; "));
  assert.ok(warningMatching(at21, /21 categories; above 20/), at21.warnings.join("; "));

  // one side missing for one band in one period
  const oneGone = lintOf(withPeriods, typical.filter((_, i) => i !== 7));
  assert.equal(oneGone.passed, true, oneGone.blockers.join("; "));
  assert.ok(warningMatching(oneGone, /missing 1 \(category, series, period\) combination/), oneGone.warnings.join("; "));
  // a whole category missing in one period: both sides of it
  const bandGone = lintOf(withPeriods, typical.filter((r) => !(r.band === "20-24" && r.period === 2010)));
  assert.ok(warningMatching(bandGone, /missing 2 \(category, series, period\) combination/), bandGone.warnings.join("; "));
  assert.equal(bandGone.passed, true);
});

check("lint: taskFit accepts the type for comparison and distribution, not for ranking", () => {
  const fits = (reader_task) => warningMatching(lintOf({ ...withPeriods, reader_task }, typical), /unusual fit/);
  assert.equal(fits("comparison"), false);
  assert.equal(fits("distribution"), false);
  assert.equal(fits("ranking"), true);
});

// ===========================================================================
// 3. Drawing rules
// ===========================================================================
check("axis: one symmetric axis whose maximum is the nice ceiling over both sides and both periods", () => {
  // the single largest value (4.4) sits on the right side of the NON-current period only
  const rows = buildRows({ bands: ["a", "b", "c", "d"], cellValue: (b, s, p) => (b === 2 && s === 1 && p === 0 ? 4.4 : 1) });
  const svg = renderVizSvg(withPeriods, rows);
  const g = analyse(svg);
  const tickValues = g.ticks.right.map((t) => numeric(t.text));
  assert.deepEqual(tickValues, [0, 1, 2, 3, 4, 5], "ceiling of 4.4 on a step of 1");
  assert.deepEqual(g.ticks.left.map((t) => numeric(t.text)), tickValues, "the left half repeats the right half's ticks");
  // no tick label carries a minus sign (ASCII hyphen-minus or U+2212)
  assert.ok(g.ticks.left.concat(g.ticks.right).every((t) => !/[-−]/.test(t.text)), "no minus signs on tick labels");
  // mirrored: tick i sits at the same distance from its own zero line on both sides
  for (let i = 0; i < tickValues.length; i++) assert.ok(near(num(g.ticks.left[i], "x") - g.gl, -(num(g.ticks.right[i], "x") - g.gr)), `tick ${i}`);
  // the outline of the 4.4 row reaches exactly the last-but-one tick + 0.4 step, inside the axis
  assert.ok(g.outlines.some((o) => near(o.x + o.w + 0.75, g.gr + 4.4 * g.k)), "the 4.4 outline ends at 4.4 on the shared scale");

  // the ceiling is the smallest tick at or above the maximum: max 4 -> last tick 4
  const exact = analyse(renderVizSvg(withPeriods, buildRows({ bands: ["a", "b"], cellValue: (b, s, p) => (b === 0 && s === 0 && p === 1 ? 4 : 1) })));
  assert.deepEqual(exact.ticks.right.map((t) => numeric(t.text)), [0, 1, 2, 3, 4]);
  // fractional data: max 0.43 -> ticks every 0.1 up to 0.5
  const small = analyse(renderVizSvg(withPeriods, buildRows({ bands: ["a", "b"], cellValue: (b, s, p) => (b === 1 && s === 1 && p === 0 ? 0.43 : 0.2) })));
  const smallTicks = small.ticks.right.map((t) => numeric(t.text));
  assert.deepEqual(smallTicks, [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
});

check("axis: the same scale on both sides, bars flush to the gutter, a 1-2 px gap between rows", () => {
  const svg = renderVizSvg(withPeriods, typical);
  const g = analyse(svg);
  assert.equal(g.leftBars.length, 18);
  assert.equal(g.rightBars.length, 18);
  const current = typical.filter((r) => r.period === 2020);
  // bar width / k is the row's value, on both sides: nothing is adjusted
  BANDS_18.forEach((band, i) => {
    const slot = 17 - i; // first_row defaults to bottom
    for (const [side, name] of [["left", "Side A"], ["right", "Side B"]]) {
      const expected = current.find((r) => r.band === band && r.side === name).share;
      assert.ok(near(g.valueAt(slot, side), expected, 0.02), `${band} ${side}: ${g.valueAt(slot, side)} vs ${expected}`);
    }
  });
  // flush: left bars end on the left zero line, right bars start on the right zero line
  assert.ok(g.leftBars.every((b) => near(b.x + b.w, g.gl)));
  assert.ok(g.rightBars.every((b) => near(b.x, g.gr)));
  // row gap
  const pitch = g.ys[1] - g.ys[0];
  for (let i = 1; i < g.ys.length; i++) assert.ok(near(g.ys[i] - g.ys[i - 1], pitch, 0.011), "even row pitch");
  const gap = pitch - g.bars[0].h;
  assert.ok(gap >= 1 && gap <= 2, `row gap ${gap}px`);
  // light vertical gridlines in the house grid colour, all the same length
  const lines = role(svg, "line", "grid-line");
  assert.ok(lines.length > 0 && lines.every((l) => l.x1 === l.x2 && l.stroke === P.grid));
  assert.equal(new Set(lines.map((l) => `${l.y1}:${l.y2}`)).size, 1);
});

check("category labels: all rows up to 12, otherwise every second row from the first plus the last", () => {
  const labelled = (count, spec = withPeriods) => {
    const bands = BANDS_18.slice(0, count);
    const g = analyse(renderVizSvg(spec, buildRows({ bands })));
    return g.labels.map((t) => t.text);
  };
  // labels are read top to bottom, which is reverse row order under the default first_row "bottom"
  const expectedFor = (count) => {
    const all = BANDS_18.slice(0, count);
    return all.filter((_, i) => count <= 12 || i % 2 === 0 || i === count - 1);
  };
  for (const count of [2, 12, 13, 14, 18]) {
    assert.deepEqual(labelled(count).slice().reverse(), expectedFor(count), `${count} rows`);
  }
  // 12 rows: every row; 13: even indices only (the last, index 12, is even); 14: even indices plus the last (index 13)
  assert.equal(labelled(12).length, 12);
  assert.equal(labelled(13).length, 7);
  assert.equal(labelled(14).length, 8);
  assert.ok(labelled(14).includes("65-69"), "the last row is labelled although it is an odd index");
  // 18 rows: the last row ("85+") is labelled although index 17 is odd
  assert.ok(labelled(18).includes("85+"));
  assert.equal(labelled(18).length, 10);
  // the labels sit in the centre gutter, centred on it
  const g = analyse(renderVizSvg(withPeriods, typical));
  assert.ok(g.labels.every((t) => near(num(t, "x"), g.centre) && t["text-anchor"] === "middle"));
  assert.ok(g.labels.every((t) => num(t, "x") > g.gl && num(t, "x") < g.gr));
});

check("rows: first_row decides which end the first category sits at", () => {
  // the first category in row order has the largest value on each side, so its bar is the longest
  const rows = buildRows({ bands: ["w", "x", "y", "z"], periods: [2020], cellValue: (b) => 4 - b });
  const spec = { ...base };
  const bottom = analyse(renderVizSvg(spec, rows));
  const top = analyse(renderVizSvg({ ...spec, first_row: "top" }, rows));
  const explicitBottom = analyse(renderVizSvg({ ...spec, first_row: "bottom" }, rows));
  assert.deepEqual(bottom.leftBars.map((b) => Math.round(b.w / bottom.k)), [1, 2, 3, 4], "default: the longest (first) row is the bottom one");
  assert.deepEqual(top.leftBars.map((b) => Math.round(b.w / top.k)), [4, 3, 2, 1], "top: the first row is at the top");
  assert.deepEqual(explicitBottom.leftBars.map((b) => b.w), bottom.leftBars.map((b) => b.w));
  assert.deepEqual(bottom.labels.map((t) => t.text), ["z", "y", "x", "w"]);
  assert.deepEqual(top.labels.map((t) => t.text), ["w", "x", "y", "z"]);
});

check("series: names are direct labels above each half; left_series picks the left; no legend", () => {
  const rows = buildRows({ periods: [2020], cellValue: (b, s) => (s === 0 ? 1.5 : 3.5) });
  const dflt = analyse(renderVizSvg(base, rows));
  assert.deepEqual(dflt.names.map((t) => t.text), ["Side A", "Side B"], "default: first series in row order on the left");
  assert.ok(num(dflt.names[0], "x") < dflt.centre && num(dflt.names[1], "x") > dflt.centre);
  assert.ok(dflt.names.every((t) => num(t, "y") < Math.min(...dflt.bars.map((b) => b.y))), "names sit above the first row");
  // the data follows the name: Side A (1.5) is drawn on the left, Side B (3.5) on the right
  assert.ok(near(dflt.valueAt(0, "left"), 1.5, 0.02) && near(dflt.valueAt(0, "right"), 3.5, 0.02));
  const swapped = analyse(renderVizSvg({ ...base, left_series: "Side B" }, rows));
  assert.deepEqual(swapped.names.map((t) => t.text), ["Side B", "Side A"]);
  assert.ok(near(swapped.valueAt(0, "left"), 3.5, 0.02) && near(swapped.valueAt(0, "right"), 1.5, 0.02));
  // naming the first series explicitly is the default
  assert.equal(renderVizSvg({ ...base, left_series: "Side A" }, rows), renderVizSvg(base, rows));
  // no legend: a single period draws no swatch and no key text
  const svg = renderVizSvg(base, rows);
  assert.equal(role(svg, "rect", "legend-swatch").length, 0);
  assert.equal(role(svg, "text", "period-key-label").length, 0);
  // "first in row order" really is row order: reversing the rows swaps the default
  const reversed = analyse(renderVizSvg(base, [...rows].reverse()));
  assert.deepEqual(reversed.names.map((t) => t.text), ["Side B", "Side A"]);
  // numeric series values are accepted for left_series by their string form
  const numericSides = buildRows({ periods: [2020], sides: [1, 2] });
  const numeric2 = analyse(renderVizSvg({ ...base, left_series: 2 }, numericSides));
  assert.deepEqual(numeric2.names.map((t) => t.text), ["2", "1"]);
});

check("colours: two house colours for the two sides, the accent for highlight_values rows", () => {
  const g = analyse(renderVizSvg({ ...withPeriods, highlight_values: ["85+", "40-44"] }, typical));
  const accentRows = new Set(g.bars.filter((b) => b.fill === P.accent).map((b) => b.y));
  assert.equal(accentRows.size, 2, "the two highlighted rows");
  assert.equal(g.bars.filter((b) => b.fill === P.accent).length, 4, "both bars of each highlighted row");
  const plain = g.bars.filter((b) => b.fill !== P.accent);
  assert.ok(plain.filter((b) => b.x + b.w <= g.gl + 0.03).every((b) => b.fill === P.accent2));
  assert.ok(plain.filter((b) => b.x >= g.gr - 0.03).every((b) => b.fill === P.series3));
  assert.notEqual(P.accent2, P.series3);
  // a highlighted category's gutter label is the bold one (read top to bottom: 85+ is the top row)
  const bold = g.labels.filter((t) => t["font-weight"] === "700").map((t) => t.text);
  assert.deepEqual(bold, ["85+", "40-44"]);
  assert.ok(g.labels.filter((t) => t["font-weight"] !== "700").length >= 6);
  // series names and gutter labels use the ink colour, ticks the muted grey
  const svg = renderVizSvg(withPeriods, typical);
  assert.ok(role(svg, "text", "series-name").every((t) => t.fill === P.ink));
  assert.ok(role(svg, "text", "axis-tick-label").every((t) => t.fill === P.muted));
});

check("overlay: the other period is an outline (a stroke, no fill) over the same rows; the current period is filled", () => {
  const svg = renderVizSvg(withPeriods, typical);
  const g = analyse(svg);
  assert.equal(g.bars.length, 36, "filled bars: 18 rows x 2 sides");
  assert.equal(g.outlines.length, 36, "outlines: 18 rows x 2 sides");
  assert.ok(g.outlines.every((o) => o.fill === "none"), "no fill");
  assert.ok(g.outlines.every((o) => o.stroke === P.ink && o.opacity > 0 && o.opacity < 1), "ink at reduced opacity");
  // the filled bars are the later period (the default current), the outlines the earlier one
  const value = (rows, period, band, side) => rows.find((r) => r.period === period && r.band === band && r.side === side).share;
  BANDS_18.forEach((band, i) => {
    const slot = 17 - i;
    const bar = (side) => g.valueAt(slot, side);
    assert.ok(near(bar("left"), value(typical, 2020, band, "Side A"), 0.02));
    assert.ok(near(bar("right"), value(typical, 2020, band, "Side B"), 0.02));
    // the outline's OUTER edge lands on the other period's value
    const rowY = g.ys[slot];
    const left = g.outlines.find((o) => o.x + o.w <= g.gl + 1 && o.y > rowY - 1.01 && o.y < rowY + 1.01);
    const right = g.outlines.find((o) => o.x >= g.gr - 1 && o.y > rowY - 1.01 && o.y < rowY + 1.01);
    assert.ok(near(g.gl - (left.x - 0.75), value(typical, 2010, band, "Side A") * g.k, 0.05), `${band} left outline`);
    assert.ok(near(right.x + right.w + 0.75 - g.gr, value(typical, 2010, band, "Side B") * g.k, 0.05), `${band} right outline`);
  });
  // the outlines are painted after (over) the filled bars
  assert.ok(svg.lastIndexOf('data-role="data-bar"') < svg.indexOf('data-role="data-bar-outline"'));
  // current_period flips the roles: 2010 filled, 2020 outlined
  const flipped = analyse(renderVizSvg({ ...withPeriods, current_period: 2010 }, typical));
  assert.ok(near(flipped.valueAt(17, "left"), value(typical, 2010, "0-4", "Side A"), 0.02));
  assert.ok(flipped.outlines.some((o) => near(o.x - 0.75, flipped.gl - value(typical, 2020, "0-4", "Side A") * flipped.k, 0.05)));
  // the order of the rows does not decide the current period: with the rows reversed (2020 rows first) the later
  // period is still the filled one. Reversed rows also reverse the category order and make "Side B" the first
  // series, so the top row is now "0-4" and the left half is "Side B".
  const shuffled = analyse(renderVizSvg(withPeriods, [...typical].reverse()));
  const later = value(typical, 2020, "0-4", "Side B");
  const earlier = value(typical, 2010, "0-4", "Side B");
  assert.notEqual(later, earlier, "the fixture cell must differ between periods for this check to mean anything");
  assert.ok(near(shuffled.valueAt(0, "left"), later, 0.02), "reversed rows: the later period is still the filled one");
});

check("overlay: a one-line key with a filled and an outline swatch and the period values from the rows", () => {
  const svg = renderVizSvg(withPeriods, typical);
  const swatches = role(svg, "rect", "legend-swatch");
  const keyTexts = role(svg, "text", "period-key-label");
  assert.equal(swatches.length, 2);
  assert.equal(keyTexts.length, 2);
  assert.ok(swatches[0].fill !== "none" && !swatches[0].stroke, "filled swatch first (the current period)");
  assert.equal(swatches[1].fill, "none", "outline swatch second");
  assert.equal(swatches[1].stroke, P.ink);
  assert.ok(Number(swatches[1]["stroke-opacity"]) < 1);
  assert.deepEqual(keyTexts.map((t) => t.text), ["2020", "2010"], "current period first, then the comparison period");
  assert.equal(new Set(keyTexts.map((t) => t.y)).size, 1, "one line");
  assert.equal(new Set(swatches.map((s) => s.y)).size, 1, "one line");
  // the period values come from the rows: textual periods are shown as they are
  const textual = renderVizSvg(withPeriods, buildRows({ bands: ["a", "b"], periods: ["FY19/20", "FY20/21"] }));
  assert.deepEqual(role(textual, "text", "period-key-label").map((t) => t.text), ["FY20/21", "FY19/20"]);
  // current_period swaps the key's order with the drawing
  assert.deepEqual(role(renderVizSvg({ ...withPeriods, current_period: 2010 }, typical), "text", "period-key-label").map((t) => t.text), ["2010", "2020"]);
});

check("default layout: overlay, the earlier period hollow and the later filled; side_by_side is the opt-in", () => {
  // The default spec (what a plan that chooses nothing sends) names neither compare_layout nor current_period.
  assert.ok(!("compare_layout" in withPeriods) && !("current_period" in withPeriods), "the default spec leaves both fields out");
  const value = (rows, period, band, side) => rows.find((r) => r.period === period && r.band === band && r.side === side).share;
  const dflt = renderVizSvg(withPeriods, typical);
  // No compare_layout is overlay and no current_period is the latest period: the same bytes as saying so.
  assert.equal(dflt, renderVizSvg({ ...withPeriods, compare_layout: "overlay" }, typical), "no compare_layout is overlay, byte for byte");
  assert.equal(dflt, renderVizSvg({ ...withPeriods, current_period: 2020 }, typical), "no current_period is the later period, byte for byte");
  assert.equal(dflt, renderVizSvg({ ...withPeriods, compare_layout: "overlay", current_period: "2020" }, typical), "...and the period named as text is the same period");
  assert.notEqual(dflt, renderVizSvg({ ...withPeriods, compare_layout: "side_by_side" }, typical), "side_by_side is a different drawing");
  assert.notEqual(dflt, renderVizSvg({ ...withPeriods, current_period: 2010 }, typical), "naming the earlier period as current flips which one is filled");
  // One pyramid: the later period (2020) filled, the earlier period (2010) a hollow outline drawn over it.
  const g = analyse(dflt);
  assert.equal(g.bars.length, 36, "one filled bar per row and side");
  assert.equal(g.outlines.length, 36, "one hollow outline per row and side");
  assert.ok(g.bars.every((b) => b.fill !== "none" && !b.stroke), "the bars are filled and have no stroke");
  assert.ok(g.outlines.every((o) => o.fill === "none" && o.stroke === P.ink), "the outlines are hollow with an ink stroke");
  assert.equal(role(dflt, "text", "panel-title").length, 0, "one pyramid: no panel titles");
  BANDS_18.forEach((band, i) => {
    const slot = 17 - i; // the first category is at the bottom by default
    const rowY = g.ys[slot];
    assert.ok(near(g.valueAt(slot, "left"), value(typical, 2020, band, "Side A"), 0.02), `${band}: the filled left bar is the later period`);
    assert.ok(near(g.valueAt(slot, "right"), value(typical, 2020, band, "Side B"), 0.02), `${band}: the filled right bar is the later period`);
    const left = g.outlines.find((o) => o.x + o.w <= g.gl + 1 && o.y > rowY - 1.01 && o.y < rowY + 1.01);
    const right = g.outlines.find((o) => o.x >= g.gr - 1 && o.y > rowY - 1.01 && o.y < rowY + 1.01);
    assert.ok(near(g.gl - (left.x - 0.75), value(typical, 2010, band, "Side A") * g.k, 0.05), `${band}: the left outline is the earlier period`);
    assert.ok(near(right.x + right.w + 0.75 - g.gr, value(typical, 2010, band, "Side B") * g.k, 0.05), `${band}: the right outline is the earlier period`);
  });
  const swatches = role(dflt, "rect", "legend-swatch");
  assert.ok(swatches[0].fill !== "none" && swatches[1].fill === "none", "the key shows the filled swatch (later period) first and the hollow one second");
  assert.deepEqual(role(dflt, "text", "period-key-label").map((t) => t.text), ["2020", "2010"], "...named 2020 then 2010");
  // The latest period is the latest in period order, not the last row: numbers sort by value (9 before 10, though
  // "9" sorts after "10" as text) and the order of the rows decides nothing.
  const nines = buildRows({ bands: ["a", "b", "c"], periods: ["9", "10"] });
  for (const rows of [nines, [...nines].reverse()]) {
    assert.deepEqual(role(renderVizSvg(withPeriods, rows), "text", "period-key-label").map((t) => t.text), ["10", "9"], "the later period (10) is the filled one");
  }
  // side_by_side is the opt-in: no outlines, one titled pyramid per period, the earlier on the left.
  const sbs = renderVizSvg({ ...withPeriods, compare_layout: "side_by_side" }, typical);
  assert.equal(role(sbs, "rect", "data-bar-outline").length, 0, "side_by_side draws no outlines");
  assert.deepEqual(role(sbs, "text", "panel-title").map((t) => t.text), ["2010", "2020"], "...but one titled pyramid per period");
});

check("side_by_side: two pyramids titled with their periods, one axis maximum, no outlines", () => {
  const spec = { ...withPeriods, compare_layout: "side_by_side" };
  const svg = renderVizSvg(spec, typical);
  assert.equal(role(svg, "rect", "data-bar-outline").length, 0);
  assert.equal(role(svg, "rect", "legend-swatch").length, 0);
  assert.equal(role(svg, "text", "period-key-label").length, 0, "the panel titles replace the key");
  assert.deepEqual(role(svg, "text", "panel-title").map((t) => t.text), ["2010", "2020"], "earlier period on the left");
  const [first, second] = [analyse(svg, { panel: 0, panels: 2 }), analyse(svg, { panel: 1, panels: 2 })];
  assert.equal(first.bars.length, 36);
  assert.equal(second.bars.length, 36);
  // one axis maximum, one scale: identical tick sets and identical px per unit
  assert.deepEqual(first.ticks.right.map((t) => t.text), second.ticks.right.map((t) => t.text));
  assert.deepEqual(first.ticks.left.map((t) => t.text), second.ticks.left.map((t) => t.text));
  assert.ok(near(first.k, second.k, 0.01));
  // each pyramid draws its own period
  BANDS_18.forEach((band, i) => {
    const slot = 17 - i;
    const value = (period, side) => typical.find((r) => r.period === period && r.band === band && r.side === side).share;
    assert.ok(near(first.valueAt(slot, "left"), value(2010, "Side A"), 0.02), `2010 ${band}`);
    assert.ok(near(second.valueAt(slot, "right"), value(2020, "Side B"), 0.02), `2020 ${band}`);
  });
  // the shared maximum covers the largest value of EITHER period
  const maxAll = Math.max(...typical.map((r) => r.share));
  assert.ok(numeric(first.ticks.right.at(-1).text) >= maxAll);
  assert.ok(numeric(first.ticks.right.at(-2).text) < maxAll);
  // series names appear above both pyramids; titles sit above the names
  assert.equal(role(svg, "text", "series-name").length, 4);
  const titleY = num(role(svg, "text", "panel-title")[0], "y");
  assert.ok(role(svg, "text", "series-name").every((t) => num(t, "y") > titleY));
  // current_period does not matter here: each pyramid is its own period
  assert.equal(renderVizSvg({ ...spec, current_period: 2010 }, typical), svg);
  // the default compare_layout is overlay
  assert.equal(renderVizSvg({ ...withPeriods, compare_layout: "overlay" }, typical), renderVizSvg(withPeriods, typical));
});

check("direct_labels: off by default; at most 12 rows label every bar of the current period, more rows only highlighted ones", () => {
  const spec = { ...withPeriods };
  assert.equal(role(renderVizSvg(spec, typical), "text", "bar-value-label").length, 0, "default: no value labels");
  assert.equal(role(renderVizSvg({ ...spec, direct_labels: false }, typical), "text", "bar-value-label").length, 0);

  // 12 rows: every bar of the current period carries its own value
  const bands12 = BANDS_18.slice(0, 12);
  const rows12 = buildRows({ bands: bands12 });
  const svg12 = renderVizSvg({ ...spec, direct_labels: true }, rows12);
  const g12 = analyse(svg12);
  assert.equal(g12.valueLabels.length, 24);
  assert.deepEqual(g12.valueLabels.map((t) => numeric(t.text)).sort((a, b) => a - b), currentValues(rows12, 2020).slice().sort((a, b) => a - b), "the current period's values, nothing else");
  // each label sits on its own side, beyond every mark (filled bar and outline) of its row
  const left = g12.valueLabels.filter((t) => num(t, "x") < g12.centre);
  const right = g12.valueLabels.filter((t) => num(t, "x") > g12.centre);
  assert.equal(left.length, 12);
  assert.equal(right.length, 12);
  assert.ok(left.every((t) => t["text-anchor"] === "end") && right.every((t) => t["text-anchor"] === "start"));
  const rowMarks = (t) => g12.bars.concat(g12.outlines).filter((m) => g12.rowAt(m.y) === g12.rowAt(num(t, "y") - 4));
  for (const t of left) assert.ok(rowMarks(t).filter((m) => m.x + m.w <= g12.gl + 1).every((m) => num(t, "x") <= m.x - 4), "left label clear of its row's marks");
  for (const t of right) assert.ok(rowMarks(t).filter((m) => m.x >= g12.gr - 1).every((m) => num(t, "x") >= m.x + m.w + 4), "right label clear of its row's marks");
  // in house style the unit is stated once per half, on the top-most label
  assert.equal(g12.valueLabels.filter((t) => t.text.includes("%")).length, 2);
  const unitLeft = left.filter((t) => t.text.includes("%"));
  assert.equal(unitLeft.length, 1);
  assert.equal(num(unitLeft[0], "y"), Math.min(...left.map((t) => num(t, "y"))));

  // 13 rows: only highlighted rows are labelled
  const rows13 = buildRows({ bands: BANDS_18.slice(0, 13) });
  assert.equal(role(renderVizSvg({ ...spec, direct_labels: true }, rows13), "text", "bar-value-label").length, 0, "13 rows, nothing highlighted");
  const hi = analyse(renderVizSvg({ ...spec, direct_labels: true, highlight_values: ["85+"] }, typical));
  assert.equal(hi.valueLabels.length, 2, "18 rows, one highlighted row: one label per side");
  const wanted = ["Side A", "Side B"].map((side) => typical.find((r) => r.period === 2020 && r.band === "85+" && r.side === side).share);
  assert.deepEqual(hi.valueLabels.map((t) => numeric(t.text)).sort((a, b) => a - b), wanted.sort((a, b) => a - b));
  // the labelled row is the 85+ row, the top one
  assert.ok(hi.valueLabels.every((t) => hi.rowAt(num(t, "y") - 4) === 0));

  // side_by_side: each pyramid labels its own period
  const sbs = renderVizSvg({ ...spec, compare_layout: "side_by_side", direct_labels: true }, rows12);
  const left2010 = analyse(sbs, { panel: 0, panels: 2 }).valueLabels.map((t) => numeric(t.text)).sort((a, b) => a - b);
  const right2020 = analyse(sbs, { panel: 1, panels: 2 }).valueLabels.map((t) => numeric(t.text)).sort((a, b) => a - b);
  assert.deepEqual(left2010, currentValues(rows12, 2010).slice().sort((a, b) => a - b));
  assert.deepEqual(right2020, currentValues(rows12, 2020).slice().sort((a, b) => a - b));

  // current_period picks which period overlay labels
  const flipped = analyse(renderVizSvg({ ...spec, direct_labels: true, current_period: 2010 }, rows12));
  assert.deepEqual(flipped.valueLabels.map((t) => numeric(t.text)).sort((a, b) => a - b), currentValues(rows12, 2010).slice().sort((a, b) => a - b));
});

check("direct_labels: decimals and unit follow the spec through fmtSpec", () => {
  const table = [[1.25, 3.5], [2.75, 0.5], [4.12, 2]];
  const rows = buildRows({ bands: ["a", "b", "c"], periods: [2020], cellValue: (b, s) => table[b][s] });
  const spec = { ...base, unit: "M", direct_labels: true, decimals: 2 };
  const g = analyse(renderVizSvg(spec, rows));
  const texts = g.valueLabels.map((t) => t.text);
  for (const wanted of ["1.25", "3.50", "2.75", "0.50", "4.12", "2.00"]) assert.ok(texts.some((t) => t.includes(wanted)), `${wanted} in ${texts.join(" | ")}`);
  // fewer decimals round the same values
  const one = analyse(renderVizSvg({ ...spec, decimals: 1 }, rows)).valueLabels.map((t) => t.text);
  for (const wanted of ["3.5", "2.0", "0.5"]) assert.ok(one.some((t) => t.includes(wanted)), `${wanted} in ${one.join(" | ")}`);
  assert.ok(one.every((t) => !/\.\d\d/.test(t)), one.join(" | "));
  // the unit rides on the outermost tick of each half
  assert.ok(g.ticks.right.at(-1).text.includes("M") && g.ticks.left.at(-1).text.includes("M"));
  assert.ok(g.ticks.right.slice(0, -1).every((t) => !t.text.includes("M")));
});

check("printed numbers: every number is a value_field value, an axis tick, a period value or part of a category name", () => {
  const rows = buildRows({ bands: BANDS_18.slice(0, 12) });
  const svg = renderVizSvg({ ...withPeriods, direct_labels: true, highlight_values: ["5-9"] }, rows);
  const inputs = new Set(rows.map((r) => r.share));
  const g = analyse(svg);
  assert.ok(g.valueLabels.length > 0 && g.valueLabels.every((t) => inputs.has(numeric(t.text))), "bar value labels are row values");
  const ticks = g.ticks.right.map((t) => numeric(t.text));
  const step = ticks[1] - ticks[0];
  assert.ok(ticks.every((v, i) => near(v, i * step, 1e-9)), "ticks are 0, step, 2 step ...");
  // the other numeric text the chart draws is the period key, taken from the rows
  assert.deepEqual(role(svg, "text", "period-key-label").map((t) => Number(t.text)), [2020, 2010]);
  // every number in any <text> of the whole SVG is one of those; a sum, a difference or a share would not be
  const allowed = new Set([...inputs, ...ticks, 2010, 2020]);
  for (const band of BANDS_18.slice(0, 12)) for (const token of band.match(/\d+(?:\.\d+)?/g)) allowed.add(Number(token));
  const tokens = elements(svg, "text").flatMap((t) => t.text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  assert.ok(tokens.length > 0);
  const stray = tokens.filter((v) => !allowed.has(v));
  assert.deepEqual(stray, [], `numbers in the SVG that are not row values or ticks: ${stray.join(", ")}`);
});

check("size and style: desktop width, house sans everywhere, 12 px floor, mobile routes to the desktop render", () => {
  const { series_field: _unused, ...baseWithoutSeries } = base;
  const horizontal = renderVizSvg({ ...baseWithoutSeries, chart_type: "horizontal_bar" }, buildRows({ bands: ["a", "b", "c"], periods: [2020], sides: ["Side A"] }));
  const svg = renderVizSvg(withPeriods, typical);
  assert.equal(viewWidth(svg), viewWidth(horizontal), "same chart width as the other desktop renderers");
  assert.equal(viewWidth(svg), 1040);
  assertFontsAndTokens(svg, "overlay");
  // mobile pages are not built: the mobile switch gives the desktop drawing
  assert.equal(renderVizMobileSvg(withPeriods, typical), svg);
  assert.equal(renderVizBundle(withPeriods, typical).mobile, svg);
  // deterministic: byte-identical on a second run
  assert.equal(renderVizSvg(withPeriods, typical), svg);
  // the chart is accessible and carries its source like every other chart
  const critique = critiqueViz(withPeriods, typical, lintOf(withPeriods, typical), svg);
  assert.equal(critique.issues.filter((i) => i.severity === "blocker").length, 0, JSON.stringify(critique.issues));
  assert.equal(critique.passed, true);
});

// ===========================================================================
// 4. Edge cases
// ===========================================================================
check("edge: long names fit the gutter, and only an absurdly long one is cut with an ellipsis", () => {
  // a long but plausible label widens the gutter instead of being cut
  const longBand = "A long category name, as a survey might word a band";
  const rows = buildRows({ bands: [longBand, "Short", "Another category label"], sides: ["The first side with a long name", "The second side with a long name too"] });
  const svg = assertQaClean(withPeriods, rows, "long names");
  const g = analyse(svg);
  assert.ok(g.labels.some((t) => t.text === longBand), "a plausible long label is shown in full");
  assert.ok(g.labels.some((t) => t.text === "Short"));
  assert.deepEqual(g.names.map((t) => t.text), ["The first side with a long name", "The second side with a long name too"]);
  assert.ok(g.leftBars.length === 3 && g.rightBars.length === 3);
  // a label far past any sensible gutter is shortened with an ellipsis, and the chart still passes QA
  const absurd = "x".repeat(60) + " " + "y".repeat(60) + " " + "z".repeat(60);
  const cut = assertQaClean(withPeriods, buildRows({ bands: [absurd, "Short"], sides: ["S".repeat(90), "T".repeat(90)] }), "absurd names");
  const gc = analyse(cut);
  assert.ok(gc.labels.some((t) => t.text.endsWith("\u2026") && t.text.length < absurd.length), "the absurd category label is shortened");
  assert.ok(gc.names.every((t) => t.text.endsWith("\u2026")), "and so are the absurd series names");
  assert.ok(gc.labels.some((t) => t.text === "Short"));
  // the same for period values: the overlay key and the side_by_side panel titles stay on the page
  const longPeriods = ["P".repeat(70) + " one", "P".repeat(70) + " two"];
  const keyed = assertQaClean(withPeriods, buildRows({ bands: ["a", "b", "c"], periods: longPeriods }), "absurd period values, overlay");
  const keys = role(keyed, "text", "period-key-label");
  assert.equal(keys.length, 2);
  assert.ok(keys.every((t) => t.text.endsWith("\u2026") && t.text.length < longPeriods[0].length), "overlay key: absurd period values are shortened");
  const titled = assertQaClean({ ...withPeriods, compare_layout: "side_by_side" }, buildRows({ bands: ["a", "b", "c"], periods: longPeriods }), "absurd period values, side by side");
  const titles = role(titled, "text", "panel-title");
  assert.equal(titles.length, 2);
  assert.ok(titles.every((t) => t.text.endsWith("\u2026") && t.text.length < longPeriods[0].length), "panel titles: absurd period values are shortened");
  // a plausible long period value is shown in full
  const plausible = ["Fiscal year 2019/20", "Fiscal year 2020/21"];
  const full = assertQaClean(withPeriods, buildRows({ bands: ["a", "b", "c"], periods: plausible }), "plausible period values");
  assert.deepEqual(role(full, "text", "period-key-label").map((t) => t.text), [plausible[1], plausible[0]], "the current (later) period first, then the outline period");
});

check("edge: a multi-word unit rides the outermost tick, the axis thins to make room, nothing overlaps", () => {
  const eight = buildRows({ bands: BANDS_18.slice(0, 8) });
  for (const unit of ["persons per 1,000", "million tonnes CO2", "thousand persons", "人/平方公里"]) {
    const spec = { ...withPeriods, unit, decimals: 1 };
    const plain = assertQaClean(spec, eight, `${unit}, overlay`);
    assertQaClean({ ...spec, direct_labels: true }, eight, `${unit}, overlay, direct labels`);
    assertQaClean({ ...spec, compare_layout: "side_by_side" }, eight, `${unit}, side by side`);
    // the unit is printed once per half: on the outermost tick, none of the others
    const ticks = role(plain, "text", "axis-tick-label").map((t) => t.text);
    assert.equal(ticks.filter((t) => t.includes(unit)).length, 2, `${unit}: once on each half's outermost tick`);
  }
  // a half too narrow for a third tick label keeps just 0 and the maximum
  const narrow = assertQaClean({ ...withPeriods, unit: "persons per 1,000", decimals: 1, compare_layout: "side_by_side" }, eight, "narrow halves");
  for (const panel of [0, 1]) assert.equal(analyse(narrow, { panel, panels: 2 }).tickCount, 2, "two ticks: 0 and the maximum");
  // while a wide half with the same unit keeps its usual ticks
  const wide = assertQaClean({ ...withPeriods, unit: "persons per 1,000", decimals: 1 }, eight, "wide halves");
  assert.ok(analyse(wide).tickCount >= 4, "overlay halves keep four or more ticks");
  // legacy prints the unit on every tick: the two "0" labels still fit side by side in the gutter
  assertQaClean({ ...withPeriods, unit: "USD m", decimals: 1, style_id: "legacy" }, eight, "legacy unit on every tick", "Arial, Helvetica, sans-serif");
  // a unit too wide for a short label next to a long bar shortens the bars, it never flips or erases them
  const squeezed = assertQaClean({ ...withPeriods, unit: "persons per 1,000", decimals: 1, direct_labels: true }, eight, "unit label beside a bar");
  const sq = analyse(squeezed);
  assert.ok(sq.leftBars.length === 8 && sq.rightBars.length === 8 && sq.bars.every((b) => b.w > 0), "every bar is still drawn with a positive length");
});

check("edge: numeric categories, two rows, 25 rows and textual periods render and pass QA", () => {
  assertQaClean(withPeriods, buildRows({ bands: [1990, 2000, 2010, 2020] }), "numeric categories");
  assertQaClean(withPeriods, buildRows({ bands: ["a", "b"] }), "two rows");
  const bands25 = Array.from({ length: 25 }, (_, i) => `Band ${String(i + 1).padStart(2, "0")}`);
  const svg25 = assertQaClean(withPeriods, buildRows({ bands: bands25 }), "25 rows");
  assert.equal(analyse(svg25).labels.length, 13, "25 rows: every second row from the first, the last row (index 24) is even");
  assertQaClean({ ...withPeriods, compare_layout: "side_by_side" }, buildRows({ bands: bands25 }), "25 rows side by side");
  assertQaClean(withPeriods, buildRows({ bands: ["a", "b", "c"], periods: ["FY19/20", "FY20/21"] }), "textual periods");
});

check("edge: one-sided missing cells, all-zero values and one huge value render without non-finite output", () => {
  // the right side of one band is missing in both periods: its bar stays empty
  const gappy = typical.filter((r) => !(r.band === "30-34" && r.side === "Side B"));
  const svg = assertQaClean(withPeriods, gappy, "missing cells");
  const g = analyse(svg);
  assert.equal(g.rightBars.length, 17);
  assert.equal(g.leftBars.length, 18);
  // all zero: no bars and no outlines, but a valid axis
  const zeroRows = buildRows({ bands: ["a", "b", "c"], cellValue: () => 0 });
  let zeroSvg;
  if (process.env.NEWSROOM_QA_NO_EMPTY_PASS === "1") {
    // an all-zero chart is a real empty finding: with the switch on the product rejects it and says why (the render itself is unchanged)
    assert.equal(valuesAllZero(withPeriods, zeroRows), true);
    const zeroBundle = renderVizBundle(withPeriods, zeroRows, { mobilePages: false });
    const zeroQa = runRenderQa(zeroBundle, { allZero: true });
    assert.equal(zeroQa.passed, false, "all zero: rejected with the switch on");
    const named = zeroQa.viewports.desktop.extra_checks.no_empty_pass.failures.find((f) => f.rule === "qa_all_values_zero");
    assert.ok(named, "all zero: the rejection names the cause");
    assert.match(named.message, /change the data or the metric/);
    assert.match(named.message, /state in the text that these values are all 0/);
    zeroSvg = zeroBundle.desktop;
  } else zeroSvg = assertQaClean(withPeriods, zeroRows, "all zero");
  assert.equal(role(zeroSvg, "rect", "data-bar").length, 0);
  assert.equal(role(zeroSvg, "rect", "data-bar-outline").length, 0);
  assert.ok(role(zeroSvg, "line", "grid-line").length >= 4);
  // one huge value among small ones: the axis follows the maximum
  const huge = assertQaClean({ ...withPeriods, unit: "people" }, buildRows({ bands: ["a", "b", "c", "d"], cellValue: (b, s, p) => (b === 1 && s === 0 && p === 1 ? 2_500_000 : 1200) }), "one huge value");
  assert.ok(role(huge, "rect", "data-bar").length > 0);
  // a period_field with one value is one period
  const onePeriod = renderVizSvg(withPeriods, buildRows({ bands: ["a", "b"], periods: [2020] }));
  assert.equal(role(onePeriod, "rect", "data-bar-outline").length, 0);
  assert.equal(role(onePeriod, "rect", "legend-swatch").length, 0);
  // a spec that skipped lint (3 series) still renders instead of throwing: the extra series is ignored
  const threeSides = renderVizSvg(withPeriods, buildRows({ bands: ["a", "b"], sides: ["Side A", "Side B", "Side C"] }));
  assert.deepEqual(analyse(threeSides).names.map((t) => t.text), ["Side A", "Side B"]);
});

check("edge: the legacy style and the zh language render and pass QA", () => {
  assertQaClean({ ...withPeriods, style_id: "legacy" }, typical, "legacy style", "Arial, Helvetica, sans-serif");
  const zhRows = buildRows({ bands: ["0-9", "10-19", "20-29", "30-39"], sides: ["甲组", "乙组"] });
  const zh = { ...withPeriods, language: "zh", title: "各年龄段占比（示例数据）", subtitle: "示例数据，单位：%", alt: "甲组与乙组在两个年份各年龄段占比的背靠背条形图，示例数据。", source_note: "示例数据", direct_labels: true };
  const svg = assertQaClean(zh, zhRows, "zh");
  assert.deepEqual(analyse(svg).names.map((t) => t.text), ["甲组", "乙组"]);
  // legacy keeps the unit on every value label
  const legacyLabels = role(renderVizSvg({ ...withPeriods, style_id: "legacy", direct_labels: true }, buildRows({ bands: ["a", "b"] })), "text", "bar-value-label");
  assert.equal(legacyLabels.length, 4);
  assert.ok(legacyLabels.every((t) => t.text.includes("%")));
});

// ===========================================================================
// 5. Render QA on the typical cases (geometry, contrast, 12 px floor, tokens, stroke z-order)
// ===========================================================================
const caseOverlay = { spec: { ...withPeriods, highlight_values: ["85+"] }, rows: typical };
const caseSideBySide = { spec: { ...withPeriods, compare_layout: "side_by_side", highlight_values: ["85+"] }, rows: typical };
const rows8 = buildRows({ bands: ["0-9", "10-19", "20-29", "30-39", "40-49", "50-59", "60-69", "70+"], sides: ["甲组", "乙组"], periods: [2020], cellValue: (b, s) => [[5.5, 5.1], [6.2, 5.8], [7.3, 6.9], [8.4, 8.1], [8.6, 8.3], [7.5, 7.6], [6.1, 6.5], [7.1, 11.2]][b][s] });
const caseSingle = { spec: { ...base, direct_labels: true, language: "zh", title: "各年龄段占比（示例数据）", subtitle: "示例数据，单位：%", source_note: "示例数据" }, rows: rows8 };

check("render QA: typical cases pass runRenderQa, the font scan, the token scan and the stroke z-order check", () => {
  assertQaClean(caseOverlay.spec, caseOverlay.rows, "overlay, 18 rows");
  assertQaClean(caseSideBySide.spec, caseSideBySide.rows, "side_by_side, 18 rows");
  assertQaClean(caseSingle.spec, caseSingle.rows, "one period, 8 rows, direct labels");
  // the 12-row boundary, first row on top, the other side on the left, direct labels on, both layouts
  const rows12 = buildRows({ bands: BANDS_18.slice(0, 12) });
  const twelve = { ...withPeriods, first_row: "top", left_series: "Side B", direct_labels: true, highlight_values: ["5-9"] };
  assertQaClean(twelve, rows12, "12 rows, top, swapped, labelled");
  assertQaClean({ ...twelve, compare_layout: "side_by_side" }, rows12, "12 rows side by side, labelled");
  // 13 rows with only a highlighted row labelled
  assertQaClean({ ...withPeriods, direct_labels: true, highlight_values: ["60-64"] }, buildRows({ bands: BANDS_18.slice(0, 13) }), "13 rows, one label per side");
});

// ===========================================================================
// 6. Snapshots
// ===========================================================================
const snapshots = {
  "overlay.svg": caseOverlay,
  "side_by_side.svg": caseSideBySide,
  "single_labels.svg": caseSingle,
};

check(`snapshots: exact SVG output of three typical cases${update ? " (rewritten: --update)" : ""}`, () => {
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const [file, { spec, rows }] of Object.entries(snapshots)) {
    const svg = renderVizSvg(spec, rows);
    const target = path.join(fixtureDir, file);
    if (update) {
      fs.writeFileSync(target, svg);
      continue;
    }
    assert.ok(fs.existsSync(target), `missing snapshot fixtures/viz-mirrored-bar/${file}; run: node scripts/test_viz_mirrored_bar.mjs --update`);
    assert.equal(svg, fs.readFileSync(target, "utf8"), `snapshot fixtures/viz-mirrored-bar/${file} changed; review the diff, then run: node scripts/test_viz_mirrored_bar.mjs --update`);
  }
});

// Annotations: mirrored_bar draws none, so a point/node annotation blocks and the nudge does not ask for one.
{
  const note = { type: "point", text: "Band 1", match_field: "band", match_value: typical[0].band, claim_id: claimId };
  for (const type of ["point", "node"]) {
    const lint = lintOf({ ...withPeriods, annotations: [{ ...note, type }] }, typical);
    assert.equal(lint.passed, false, `a ${type} annotation on mirrored_bar blocks`);
    assert.ok(lint.blockers.some((m) => m.includes(`${type} is not supported on chart_type 'mirrored_bar'`) && m.includes("nothing needs adding")), lint.blockers.join("; "));
  }
  assert.equal(lintOf({ ...withPeriods, annotations: [{ type: "reference_line", value: 10, text: "x" }] }, typical).passed, false, "a reference_line on mirrored_bar still blocks");
  const findings = critiqueViz(withPeriods, typical, lintOf(withPeriods, typical), "");
  assert.ok(!JSON.stringify(findings).includes("no_annotation"), "no annotation nudge for a form that draws none");
}
if (savedStyleEnv === undefined) delete process.env.NEWSROOM_HOUSE_STYLE;
else process.env.NEWSROOM_HOUSE_STYLE = savedStyleEnv;
console.log(update ? "mirrored_bar snapshots updated" : "mirrored_bar tests -- PASS");
