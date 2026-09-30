#!/usr/bin/env node
// Tests for render_qa_geometry.mjs, in three parts:
//   1. Small inline synthetic SVG fixtures, one pass/fail pair per rule.
//      These are unit fixtures only - they are not evidence of anything
//      about the real pipeline, just of this module's own logic.
//   2. A replay over a real, previously-passed trial's chart SVGs (read-only,
//      skipped with a message if the path isn't present on this machine).
//      This is the actual regression check: a real chart that shipped with a
//      broken picture must fail this module.
//   3. An informational sweep over every chart type the existing viz test
//      suite renders. Counts are printed, never asserted on - this module is
//      not wired into any gate yet, and a separate task is raising font
//      sizes in parallel, so today's counts are expected to be non-zero.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { checkSvgGeometry, RENDER_QA_GEOMETRY_VERSION, TEXT_WIDTH_FACTORS, LATIN_ADVANCE_WIDTHS, LATIN_BOLD_ADVANCE_WIDTHS } from "../runtime/pi/render_qa_geometry.mjs";
import { renderVizSvg, renderVizMobileSvg } from "../runtime/pi/viz.mjs";

assert.equal(typeof RENDER_QA_GEOMETRY_VERSION, "string");
assert.equal(TEXT_WIDTH_FACTORS.cjk, 1.0);

// ===========================================================================
// Part 1: unit fixtures (synthetic, not evidence)
// ===========================================================================

function rulesOf(result) {
  return result.failures.map((f) => f.rule).sort();
}

// --- text_outside_viewbox --------------------------------------------------
{
  const fail = checkSvgGeometry(`<svg viewBox="0 0 100 50"><text x="10" y="80" font-size="12">below the box</text></svg>`);
  assert.equal(fail.passed, false, "unit: label baseline far past viewBox height should fail text_outside_viewbox");
  assert.deepEqual(rulesOf(fail), ["text_outside_viewbox"]);

  const pass = checkSvgGeometry(`<svg viewBox="0 0 100 50"><text x="10" y="20" font-size="12">inside</text></svg>`);
  assert.equal(pass.passed, true, "unit: label fully inside the viewBox should pass");
}

// --- text_overlap ------------------------------------------------------------
{
  const fail = checkSvgGeometry(
    `<svg viewBox="0 0 200 100"><text x="10" y="30" font-size="14">Alpha</text><text x="15" y="30" font-size="14">Beta</text></svg>`,
  );
  assert.equal(fail.passed, false, "unit: two labels stacked at nearly the same point should fail text_overlap");
  assert.deepEqual(rulesOf(fail), ["text_overlap"]);

  const pass = checkSvgGeometry(
    `<svg viewBox="0 0 200 100"><text x="10" y="30" font-size="14">Alpha</text><text x="150" y="30" font-size="14">Beta</text></svg>`,
  );
  assert.equal(pass.passed, true, "unit: two labels far apart on the same baseline should pass");
}

// --- font_below_floor ---------------------------------------------------------
{
  const fail = checkSvgGeometry(`<svg viewBox="0 0 200 100"><text x="5" y="20" font-size="10">tiny</text></svg>`);
  assert.equal(fail.passed, false, "unit: font-size below the default 12px floor should fail");
  assert.deepEqual(rulesOf(fail), ["font_below_floor"]);

  const passAtFloor = checkSvgGeometry(`<svg viewBox="0 0 200 100"><text x="5" y="20" font-size="12">at floor</text></svg>`);
  assert.equal(passAtFloor.passed, true, "unit: font-size exactly at the floor should pass (rule is strictly-below)");

  const customFloor = checkSvgGeometry(`<svg viewBox="0 0 200 100"><text x="5" y="20" font-size="13">custom</text></svg>`, { minFontSize: 14 });
  assert.equal(customFloor.passed, false, "unit: options.minFontSize should be honoured");

  // Inheritance: a <g font-size="9"> with no per-text override.
  const inheritedFromG = checkSvgGeometry(`<svg viewBox="0 0 200 100"><g font-size="9"><text x="5" y="20">inherited</text></g></svg>`);
  assert.deepEqual(rulesOf(inheritedFromG), ["font_below_floor"], "unit: font-size should inherit down from an ancestor <g>");

  // Simple <style> rule, no attribute at all.
  const fromStyle = checkSvgGeometry(`<svg viewBox="0 0 200 100"><style>text{font-size:9px}</style><text x="5" y="20">styled</text></svg>`);
  assert.deepEqual(rulesOf(fromStyle), ["font_below_floor"], "unit: a matching <style> rule should set the effective font-size");

  // CSS beats a plain presentation attribute, matching real cascade order.
  const styleOverridesAttr = checkSvgGeometry(
    `<svg viewBox="0 0 200 100"><style>text{font-size:9px}</style><text x="5" y="20" font-size="14">both</text></svg>`,
  );
  assert.deepEqual(rulesOf(styleOverridesAttr), ["font_below_floor"], "unit: a <style> rule should override a plain font-size attribute");
}

// --- indistinct_adjacent_marks ------------------------------------------------
{
  const touching = checkSvgGeometry(
    `<svg viewBox="0 0 200 100"><rect x="10" y="10" width="50" height="30" fill="#334eac"/><rect x="60" y="10" width="50" height="30" fill="#334eac"/></svg>`,
  );
  assert.equal(touching.passed, false, "unit: two touching same-fill rects with no stroke should fail");
  assert.deepEqual(rulesOf(touching), ["indistinct_adjacent_marks"]);

  const differentFill = checkSvgGeometry(
    `<svg viewBox="0 0 200 100"><rect x="10" y="10" width="50" height="30" fill="#334eac"/><rect x="60" y="10" width="50" height="30" fill="#aa3311"/></svg>`,
  );
  assert.equal(differentFill.passed, true, "unit: different fills should pass even when touching");

  const gapped = checkSvgGeometry(
    `<svg viewBox="0 0 200 100"><rect x="10" y="10" width="50" height="30" fill="#334eac"/><rect x="70" y="10" width="50" height="30" fill="#334eac"/></svg>`,
  );
  assert.equal(gapped.passed, true, "unit: a visible gap between same-fill rects should pass");

  const stroked = checkSvgGeometry(
    `<svg viewBox="0 0 200 100"><rect x="10" y="10" width="50" height="30" fill="#334eac"/><rect x="60" y="10" width="50" height="30" fill="#334eac" stroke="#ffffff" stroke-width="1"/></svg>`,
  );
  assert.equal(stroked.passed, true, "unit: a contrasting stroke at the shared edge should pass");

  // Positive-control fixtures (unit fixtures, not evidence): the owner's
  // accepted spike pages and the product's own geo-flow-map/parallel-sets
  // fixtures were over-firing this rule. These four cases pin the fix.
  const deepOverlapOnPurpose = checkSvgGeometry(
    `<svg viewBox="0 0 300 200"><rect x="10" y="10" width="150" height="100" fill="rgb(243,238,231)"/><rect x="66" y="10" width="150" height="100" fill="rgb(243,238,231)"/></svg>`,
  );
  assert.equal(deepOverlapOnPurpose.passed, true, "unit: two same-fill rects overlapping by -56px (a hero illustration merging on purpose) should pass, not read as adjacent segments");

  const whitePlatesOnWhitePage = checkSvgGeometry(
    `<svg viewBox="0 0 1000 1000"><rect x="0" y="0" width="1000" height="1000" fill="#ffffff"/><rect x="500" y="0" width="500" height="500" fill="white"/><rect x="999.86" y="600" width="100" height="100" fill="rgb(255,255,255)"/></svg>`,
  );
  assert.equal(whitePlatesOnWhitePage.passed, true, "unit: white plates/panels (hex, named, and rgb() spellings) on a white page should pass - they read as background, not marks");

  const rgbVsHexTouching = checkSvgGeometry(
    `<svg viewBox="0 0 200 100"><rect x="10" y="10" width="50" height="30" fill="rgb(51,78,172)"/><rect x="60" y="10" width="50" height="30" fill="#334eac"/></svg>`,
  );
  assert.equal(rgbVsHexTouching.passed, false, "unit: rgb() and hex spellings of the same colour, touching, should still fail - colour comparison must be format-aware");
  assert.deepEqual(rulesOf(rgbVsHexTouching), ["indistinct_adjacent_marks"]);

  const trialPattern = checkSvgGeometry(
    `<svg viewBox="0 0 200 100"><rect x="10" y="10" width="50" height="30" fill="#334eac"/><rect x="60" y="10" width="50" height="30" fill="#334eac"/></svg>`,
  );
  assert.equal(trialPattern.passed, false, "unit: the trial-03 pattern - same-fill segments touching edge to edge with a 0px gap - must still fail");
  assert.deepEqual(rulesOf(trialPattern), ["indistinct_adjacent_marks"]);
}

// --- transform handling (T6a: full affine engine, shared with render_qa_svg.mjs) --
{
  // rotate() on the element itself is now actually measured (the
  // axis-aligned box of the rotated rectangle), not skipped: this label's
  // rotated box still lands inside the viewBox, so only the (unrelated)
  // font-size floor fires and there is no "unresolved" note.
  const rotated = checkSvgGeometry(`<svg viewBox="0 0 200 100"><text x="10" y="20" font-size="8" transform="rotate(15 10 20)">rotated</text></svg>`);
  assert.deepEqual(rulesOf(rotated), ["font_below_floor"], "unit: an in-bounds rotated label should still be checked for font_below_floor");
  assert.equal(rotated.notes.length, 0, "unit: a resolvable rotate() should not produce an unmeasured note");

  // A rotation that actually pushes the rotated box outside the viewBox must
  // be caught (this is the matrix-desktop/-mobile defect class this task
  // exists to fix: rotated column headers were previously invisible to
  // text_outside_viewbox/text_overlap because rotate() was always skipped).
  const rotatedOverflow = checkSvgGeometry(`<svg viewBox="0 0 50 50"><text x="10" y="45" font-size="14" transform="rotate(90 10 45)">Hi</text></svg>`);
  assert.deepEqual(rulesOf(rotatedOverflow), ["text_outside_viewbox"], "unit: a rotation that carries the label past the viewBox edge should fail text_outside_viewbox");
  const rotatedOverflowUnrotated = checkSvgGeometry(`<svg viewBox="0 0 50 50"><text x="10" y="45" font-size="14">Hi</text></svg>`);
  assert.equal(rotatedOverflowUnrotated.passed, true, "unit: sanity check - the same label without the rotation is in-bounds");

  // A resolvable single translate() on a parent <g> should shift the child's
  // effective position before the viewBox check runs.
  const shiftedOut = checkSvgGeometry(`<svg viewBox="0 0 100 50"><g transform="translate(20,60)"><text x="10" y="10" font-size="12">shifted</text></g></svg>`);
  assert.deepEqual(rulesOf(shiftedOut), ["text_outside_viewbox"], "unit: translate(...) should be folded into the checked position");
  const notShifted = checkSvgGeometry(`<svg viewBox="0 0 100 50"><text x="10" y="10" font-size="12">shifted</text></svg>`);
  assert.equal(notShifted.passed, true, "unit: sanity check - the same label without the translate is in-bounds");

  // A transform composing more than one function (translate + rotate) is now
  // resolved exactly, via the shared affine engine, instead of being given up
  // on: this one still keeps its label in-bounds, so only font_below_floor
  // fires and there is no "unresolved" note.
  const composed = checkSvgGeometry(`<svg viewBox="0 0 100 50"><g transform="translate(5,5) rotate(10)"><text x="1" y="1" font-size="8">x</text></g></svg>`);
  assert.deepEqual(rulesOf(composed), ["font_below_floor"], "unit: a resolvable composed transform should be measured, not skipped");
  assert.equal(composed.notes.length, 0, "unit: a resolvable composed transform should not produce an unmeasured note");

  // A transform this engine genuinely cannot parse (an unknown function
  // name) is still left unresolved, reported as a note, and font_below_floor
  // still runs - the module must keep this fallback for real malformed input.
  const unresolvable = checkSvgGeometry(`<svg viewBox="0 0 100 50"><text x="1" y="1" font-size="8" transform="perspective(400)">x</text></svg>`);
  assert.deepEqual(rulesOf(unresolvable), ["font_below_floor"], "unit: an unparseable transform should still be checked for font_below_floor");
  assert.equal(unresolvable.notes.length, 1, "unit: an unparseable transform should produce exactly one unmeasured note");
  assert.match(unresolvable.notes[0].reason, /unresolved transform/);
  assert.equal(unresolvable.failures[0].bbox, null, "unit: an unresolved node's font_below_floor failure should report no bbox");
}

// --- nested <svg> viewBox-to-viewport scaling (T6a) -----------------------
// infographic.mjs's embedVisual/embedIllustration wrap an embedded chart's
// full-size SVG in `<svg x=... y=... width=... height=... viewBox=...
// preserveAspectRatio="xMidYMin meet">`, often shrinking it. Both the
// position remap and the resulting displayed font-size must be resolved.
{
  // Halving a 100x100 viewBox into a 50x50 viewport (scale 0.5) brings a
  // 24px inner label down to exactly the 12px floor - passes.
  const halfScaleAtFloor = checkSvgGeometry(
    `<svg viewBox="0 0 200 200"><svg x="0" y="0" width="50" height="50" viewBox="0 0 100 100"><text x="10" y="50" font-size="24">Inner</text></svg></svg>`,
  );
  assert.equal(halfScaleAtFloor.passed, true, "unit: a nested svg scaled to exactly bring a label to the floor should pass (rule is strictly-below)");

  // Shrinking the same viewport further (scale 0.25) brings that 24px label
  // down to an effective 6px - fails, and only on font_below_floor (the
  // rescaled box itself stays well inside both viewBoxes).
  const quarterScaleBelowFloor = checkSvgGeometry(
    `<svg viewBox="0 0 200 200"><svg x="0" y="0" width="25" height="25" viewBox="0 0 100 100"><text x="10" y="50" font-size="24">Inner</text></svg></svg>`,
  );
  assert.deepEqual(rulesOf(quarterScaleBelowFloor), ["font_below_floor"], "unit: a nested svg shrunk to a quarter scale should measure its text at the displayed (not native) size");
  assert.match(quarterScaleBelowFloor.failures[0].message, /font-size 6\b/, "unit: the displayed size (24 * 0.25) should be reported, not the raw 24");

  // Position mapping, isolated from any scaling (viewport dims equal the
  // inner viewBox, so scale is exactly 1): a nested svg placed at x=20 in a
  // 40-wide outer viewBox shifts its children 20 units right before the
  // viewBox check runs.
  const nestedInBounds = checkSvgGeometry(
    `<svg viewBox="0 0 40 40"><svg x="20" y="0" width="20" height="20" viewBox="0 0 20 20"><text x="2" y="10" font-size="12">Z</text></svg></svg>`,
  );
  assert.equal(nestedInBounds.passed, true, "unit: a nested svg label placed near its own origin should stay in the outer viewBox");
  const nestedShiftedOut = checkSvgGeometry(
    `<svg viewBox="0 0 40 40"><svg x="20" y="0" width="20" height="20" viewBox="0 0 20 20"><text x="15" y="10" font-size="12">Z</text></svg></svg>`,
  );
  assert.deepEqual(rulesOf(nestedShiftedOut), ["text_outside_viewbox"], "unit: the same nested svg's x=20 offset should carry a label near its own right edge past the outer viewBox");

  // A nested svg with a viewBox but no resolvable width/height cannot be
  // turned into a scale; it (and everything under it) is reported as
  // unmeasured, not guessed at.
  const nestedUnresolvable = checkSvgGeometry(`<svg viewBox="0 0 40 40"><svg x="0" y="0" viewBox="0 0 100 100"><text x="10" y="50" font-size="24">Inner</text></svg></svg>`);
  assert.equal(nestedUnresolvable.passed, true, "unit: an unmeasured nested svg produces no failures (notes only)");
  assert.equal(nestedUnresolvable.notes.length, 2, "unit: both the nested <svg> itself and its descendant text should each get their own note");
  assert.ok(nestedUnresolvable.notes.some((n) => /nested <svg>/.test(n.reason)));
  assert.ok(nestedUnresolvable.notes.some((n) => /unresolved transform/.test(n.reason)));
}

// --- options.displayScale (T6a) --------------------------------------------
// Unlike a nested <svg>, the root document has no ancestor to read a display
// size from - a caller who knows the whole chart is shown smaller (or
// larger) than its own viewBox units supplies displayScale explicitly.
{
  const defaultScale = checkSvgGeometry(`<svg viewBox="0 0 200 100"><text x="10" y="20" font-size="24">Big</text></svg>`);
  assert.equal(defaultScale.passed, true, "unit: default displayScale=1 should not change existing behaviour");

  const shrunkDisplay = checkSvgGeometry(`<svg viewBox="0 0 200 100"><text x="10" y="20" font-size="24">Big</text></svg>`, { displayScale: 0.4 });
  assert.deepEqual(rulesOf(shrunkDisplay), ["font_below_floor"], "unit: displayScale should shrink the effective font-size used by font_below_floor");
  assert.match(shrunkDisplay.failures[0].message, /font-size 9\.6\b/, "unit: the displayed size (24 * 0.4) should be reported");

  // text_outside_viewbox/text_overlap stay in native viewBox units and are
  // unaffected by displayScale, matching how the Chrome ground truth itself
  // measures them (in viewBox units, independent of the SVG's CSS display size).
  const stillInBounds = checkSvgGeometry(`<svg viewBox="0 0 200 100"><text x="10" y="20" font-size="12">Fits</text></svg>`, { displayScale: 0.1 });
  assert.ok(!stillInBounds.failures.some((f) => f.rule === "text_outside_viewbox"), "unit: displayScale must not shrink the box used for text_outside_viewbox");
}

// --- Latin advance-width table accuracy (T6a) ------------------------------
// LATIN_ADVANCE_WIDTHS/LATIN_BOLD_ADVANCE_WIDTHS were measured in Chrome
// (scratchpad/measure_font_widths.mjs); cross-check a representative sample
// against the standard Helvetica/Arial AFM core-font metrics (a stable,
// independently published reference, not derived from this module's own
// measurement) to confirm the embedded table is a real, accurate
// measurement and not a transcription error.
{
  const HELVETICA_AFM_PER_MILLE = { " ": 278, "0": 556, "i": 222, M: 833, W: 944, "@": 1015 };
  const HELVETICA_BOLD_AFM_PER_MILLE = { " ": 278, "0": 556, i: 278, M: 833, W: 944, "@": 975 };
  for (const [ch, perMille] of Object.entries(HELVETICA_AFM_PER_MILLE)) {
    const expected = perMille / 1000;
    const measured = LATIN_ADVANCE_WIDTHS[ch];
    const withinTolerance = Math.abs(measured - expected) / expected <= 0.03;
    assert.ok(withinTolerance, `unit: LATIN_ADVANCE_WIDTHS[${JSON.stringify(ch)}]=${measured} should be within 3% of the published Helvetica AFM width ${expected}`);
  }
  for (const [ch, perMille] of Object.entries(HELVETICA_BOLD_AFM_PER_MILLE)) {
    const expected = perMille / 1000;
    const measured = LATIN_BOLD_ADVANCE_WIDTHS[ch];
    const withinTolerance = Math.abs(measured - expected) / expected <= 0.03;
    assert.ok(withinTolerance, `unit: LATIN_BOLD_ADVANCE_WIDTHS[${JSON.stringify(ch)}]=${measured} should be within 3% of the published Helvetica-Bold AFM width ${expected}`);
  }

  // End-to-end: a known string's estimated box width should match the table
  // arithmetic exactly (units * fontSize * safetyMargin), wired correctly
  // through checkSvgGeometry's public bbox output.
  const knownString = "MMMMMMMMMM"; // 10 M's, deliberately wide and unambiguous
  const fontSize = 100;
  const expectedWidth = 10 * LATIN_ADVANCE_WIDTHS.M * fontSize * TEXT_WIDTH_FACTORS.safetyMargin;
  const tiny = checkSvgGeometry(`<svg viewBox="0 0 10 10"><text x="0" y="10" font-size="${fontSize}">${knownString}</text></svg>`);
  const outside = tiny.failures.find((f) => f.rule === "text_outside_viewbox");
  assert.ok(outside, "unit: a 10-M string at font-size 100 must overflow a 10x10 viewBox");
  assert.ok(Math.abs(outside.bbox.w - expectedWidth) < 0.01, `unit: estimated width ${outside.bbox.w} should match the table arithmetic ${expectedWidth}`);
}

console.log("unit fixtures (synthetic, not evidence): PASS");

// ===========================================================================
// Part 2: replay over a real trial's chart SVGs
// ===========================================================================
const TRIAL_DIR =
  process.env.NEWSROOM_TRIAL_REPLAY_DIR || "";
const TRIAL_BASENAME = "72c14834a91feee47a5f653594cd145c044816340f4441401e74db99e28c6929";
const trialFiles = [
  { label: "trial-03 .svg", path: `${TRIAL_DIR}/${TRIAL_BASENAME}.svg` },
  { label: "trial-03 .mobile.svg", path: `${TRIAL_DIR}/${TRIAL_BASENAME}.mobile.svg` },
];

if (trialFiles.every((f) => existsSync(f.path))) {
  const REQUIRED_RULES = ["text_outside_viewbox", "indistinct_adjacent_marks", "font_below_floor"];
  for (const { label, path } of trialFiles) {
    const svg = await readFile(path, "utf8");
    const result = checkSvgGeometry(svg);
    assert.equal(result.passed, false, `${label}: expected checkSvgGeometry to fail on this known-broken evidence chart`);
    const seen = new Set(result.failures.map((f) => f.rule));
    for (const rule of REQUIRED_RULES) assert.ok(seen.has(rule), `${label}: expected a ${rule} failure, saw rules [${[...seen].sort().join(", ")}]`);
    const counts = {};
    for (const f of result.failures) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
    console.log(`${label}: FAIL as expected - ${JSON.stringify(counts)}`);
    for (const rule of REQUIRED_RULES) {
      const example = result.failures.find((f) => f.rule === rule);
      console.log(`  example ${rule}: ${example.message}`);
    }
  }
  console.log("trial-03 replay: PASS (the check correctly fails this real, previously-passed broken chart)");
} else {
  console.log(`trial-03 evidence not found at ${TRIAL_DIR}; skipping replay assertions (expected off the owner's machine)`);
}

// ===========================================================================
// Part 3: informational sweep over chart types (no assertions on counts)
// ===========================================================================

function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((v) => v !== ""));
  return body.map((values) => Object.fromEntries(head.map((key, i) => [key, key === "country" ? values[i] : Number(values[i])])));
}

const worldBankRows = parseCsv(await readFile(new URL("../fixtures/world-bank-renewable-latest.csv", import.meta.url), "utf8"));
const sweepClaim = "claim-render-qa-geometry-sweep";
const sweepCommon = {
  schema_version: "0.7.0",
  reader_task: "ranking",
  takeaway: "Informational sweep fixture for render_qa_geometry.",
  title: "Countries split into two observation years",
  subtitle: "Renewable energy consumption as a share of total final energy consumption",
  alt: "Two panels separate countries observed in 2021 from countries observed in 2022.",
  source_note: "World Bank fixture, indicator EG.FEC.RNEW.ZS",
  note: "Observation years differ across countries in the fixture.",
  claim_id: sweepClaim,
  sql: "SELECT country, year, renewable_energy_consumption_pct FROM read_csv_auto('data/world-bank-renewable-latest.csv')",
  unit: "%",
  value_field: "renewable_energy_consumption_pct",
  reference_period_field: "year",
  sort: "desc",
  direct_labels: true,
  annotations: [],
};

const collisionRows = [
  { entity: "A", x: 1, y: 50.0 },
  { entity: "B", x: 2, y: 50.2 },
  { entity: "C", x: 3, y: 50.4 },
];
const scatterSpec = {
  schema_version: "0.7.0",
  reader_task: "correlation",
  takeaway: "Informational sweep fixture for render_qa_geometry.",
  chart_type: "scatter",
  title: "Collision-aware annotation test",
  alt: "Three nearby scatter points with annotations.",
  source_note: "Synthetic regression fixture",
  claim_id: sweepClaim,
  sql: "SELECT * FROM synthetic",
  unit: "index",
  x_field: "x",
  y_field: "y",
  label_field: "entity",
  annotations: [],
};

const directLabelRows = [
  { year: 2020, series: "Alpha", value: 50.0 },
  { year: 2021, series: "Alpha", value: 50.0 },
  { year: 2020, series: "Beta", value: 50.1 },
  { year: 2021, series: "Beta", value: 50.1 },
  { year: 2020, series: "Gamma", value: 50.2 },
  { year: 2021, series: "Gamma", value: 50.2 },
];
const multiLineSpec = {
  schema_version: "0.7.0",
  reader_task: "change",
  takeaway: "Informational sweep fixture for render_qa_geometry.",
  chart_type: "multi_line",
  title: "Collision-aware direct label test",
  alt: "Three series ending at nearly identical values.",
  source_note: "Synthetic regression fixture",
  claim_id: sweepClaim,
  sql: "SELECT * FROM synthetic",
  unit: "index",
  x_field: "year",
  value_field: "value",
  series_field: "series",
  direct_labels: true,
  annotations: [],
};

const handBuiltScenarios = [
  {
    source: "world-bank-horizontal_bar",
    spec: { ...sweepCommon, chart_type: "horizontal_bar", category_field: "country", mixed_period_strategy: "reject" },
    rows: worldBankRows,
  },
  {
    source: "world-bank-small_multiples",
    spec: {
      ...sweepCommon,
      reader_task: "comparison",
      chart_type: "small_multiples",
      x_field: "country",
      facet_field: "year",
      panel_mark: "dot",
      mixed_period_strategy: "facet",
      highlight_values: ["Congo, Dem. Rep."],
    },
    rows: worldBankRows,
  },
  { source: "synthetic-scatter", spec: scatterSpec, rows: collisionRows },
  { source: "synthetic-multi_line", spec: multiLineSpec, rows: directLabelRows },
];

// fixtures/complex/*.json and fixtures/spatial-explanatory/*.json already
// carry a proven-valid {spec, rows} pair each, exercised by
// test_complex_snapshots.mjs and the spatial-explanatory suite; reuse them
// here rather than guessing at required fields for chart types this file
// doesn't otherwise construct.
const fixtureFiles = [
  ...["hierarchy", "log-scatter", "matrix", "node-link", "sankey", "streamgraph", "timeline"].map((name) => `../fixtures/complex/${name}.json`),
  ...["chord", "geo-flow-map", "parallel-sets"].map((name) => `../fixtures/spatial-explanatory/${name}.json`),
];
const fixtureScenarios = [];
for (const rel of fixtureFiles) {
  const data = JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));
  fixtureScenarios.push({ source: rel.split("/").pop().replace(".json", ""), spec: data.spec, rows: data.rows });
}

const scenarios = [...handBuiltScenarios, ...fixtureScenarios];
const KNOWN_CHART_TYPES_NOT_SWEPT = ["dumbbell", "slope", "line", "diverging_bar", "heatmap", "alluvial", "cartographic_flow_map", "trajectory_profile", "process_schematic"];

console.log("");
console.log("render_qa_geometry informational sweep (not asserted - a separate task raises font sizes in parallel):");
const totals = {};
for (const { source, spec, rows } of scenarios) {
  for (const [viewport, render] of [
    ["desktop", renderVizSvg],
    ["mobile", renderVizMobileSvg],
  ]) {
    let svg;
    try {
      svg = render(spec, rows);
    } catch (err) {
      console.log(`  ${source} (${spec.chart_type}) ${viewport}: render threw - ${err.message}`);
      continue;
    }
    const result = checkSvgGeometry(svg);
    const counts = { text_outside_viewbox: 0, text_overlap: 0, font_below_floor: 0, indistinct_adjacent_marks: 0 };
    for (const f of result.failures) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
    for (const [rule, n] of Object.entries(counts)) totals[rule] = (totals[rule] ?? 0) + n;
    console.log(`  ${source.padEnd(28)} ${String(spec.chart_type).padEnd(18)} ${viewport.padEnd(7)} ${JSON.stringify(counts)} unmeasured(text=${result.summary.texts_unmeasured},rect=${result.summary.rects_unmeasured})`);
  }
}
console.log(`  TOTAL across ${scenarios.length} scenarios x 2 viewports: ${JSON.stringify(totals)}`);
console.log(`  chart types not covered by this sweep (no ready fixture): ${KNOWN_CHART_TYPES_NOT_SWEPT.join(", ")}`);
console.log("informational sweep: done (no assertions made on these counts)");
