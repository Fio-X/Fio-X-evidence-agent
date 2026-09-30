#!/usr/bin/env node
// Regression tests for the end-label de-collision pass (repelEndLabels /
// endLabelLeader, wired into renderSlope/renderMobileSlope) and for the
// point-annotation obstacle-aware layout added alongside it
// (createAnnotationLayout / addPointAnnotation), plus the render-QA rule
// that must keep rejecting a genuinely impossible case
// (text_crosses_data_mark / text_overlap in render_qa_geometry.mjs).
//
// House-style invariants under test:
//   - a near-tie between two end labels is never "fixed" by rounding or
//     altering the reported value - only the label's y position moves;
//   - a short, <=1px neutral-grey leader appears whenever a label moves
//     more than ~3px from its own point, and never otherwise;
//   - a leader is drawn behind the data marks (paint order);
//   - a data-mark/annotation collision that repelEndLabels'/the annotation
//     layout's own best-effort placement genuinely cannot resolve must still
//     fail render QA - this suite must not "pass" an overcrowded case by
//     construction.
import assert from "node:assert/strict";
import { renderVizSvg, HOUSE_PALETTES } from "../runtime/pi/viz.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

// House style is the runtime default (see viz.mjs's styleFor/applyStyle), so
// every text/leader literal this suite matches against must be house's own
// font stack + muted grey, not the pre-house Arial/#687076 legacy values -
// those still exist and are asserted separately (style_id: "legacy" case),
// but they are no longer what a spec with no style_id renders.
const HOUSE_FONT_SANS_PATTERN = "'PingFang SC', 'Heiti SC', 'Noto Sans SC', 'Microsoft YaHei', Arial, Helvetica, sans-serif";
const HOUSE_MUTED = HOUSE_PALETTES.house.muted;

// Mirrors runtime/pi/viz.mjs's own (unexported) fmt() number formatting
// exactly, so this suite can assert "the label is whatever fmt() would
// produce from the raw data, unrounded any further by the repel pass" -
// without hardcoding a magnitude-dependent decimal count that belongs to
// fmt(), not to this test. Fix 13: renderSlope now resolves one shared
// decimals count per chart (resolveChartDecimals(), the same mechanism
// every other chart type already used) and passes it down, so this mirror
// takes the already-known-correct resolved count for each fixture below as
// an explicit argument, the same way test_value_label_decimals.mjs hardcodes
// its own real fixture's resolved "3" rather than re-implementing
// autoValueDecimals() here.
function fmt(value, unit = "", decimals = null) {
  if (Number.isInteger(decimals)) return unit ? `${value.toFixed(decimals)} ${unit}` : value.toFixed(decimals);
  const abs = Math.abs(value);
  let text;
  if (abs >= 100) text = value.toFixed(0);
  else if (abs >= 10) text = value.toFixed(1).replace(/\.0$/, "");
  else text = value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return unit ? `${text} ${unit}` : text;
}

const claimId = "claim-label-decollide";
const baseSpec = {
  schema_version: "0.7.0",
  reader_task: "comparison",
  takeaway: "Two federal spending categories are nearly tied.",
  chart_type: "slope",
  title: "Federal outlays, FY2023 to FY2024 ($bn)",
  alt: "A slope chart comparing federal spending categories between two years; two right-end values are nearly tied.",
  source_note: "Synthetic regression fixture",
  claim_id: claimId,
  sql: "SELECT * FROM synthetic",
  unit: "$bn",
  category_field: "category",
  start_field: "start",
  end_field: "end",
  annotations: [],
};

function extractSlopeLabels(svg) {
  // The right-end value labels are the plain (non-annotation, non-role)
  // <text> nodes anchored "start" just past the right column; left-end
  // labels are anchor="end" just before the left column. Both are emitted
  // without a data-role attribute (see renderSlope).
  const rows = [];
  const fontPattern = HOUSE_FONT_SANS_PATTERN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<text x="([0-9.]+)" y="([0-9.]+)" text-anchor="(start|end)" font-family="${fontPattern}" font-size="12" fill="#[0-9a-fA-F]+">([^<]*)</text>`, "g");
  let m;
  while ((m = re.exec(svg))) rows.push({ x: Number(m[1]), y: Number(m[2]), anchor: m[3], text: m[4] });
  return rows;
}

function extractLeaders(svg) {
  return [...svg.matchAll(/<line data-role="label-leader" x1="([-0-9.]+)" y1="([-0-9.]+)" x2="([-0-9.]+)" y2="([-0-9.]+)" stroke="(#[0-9a-fA-F]+)" stroke-width="([0-9.]+)"\/>/g)]
    .map((m) => ({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]), stroke: m[5], strokeWidth: Number(m[6]) }));
}

// ---------------------------------------------------------------------------
// 1. The exact reported case: two right-end labels ~66x9px apart in value,
//    close enough that their un-repelled y positions would land within a
//    12px text row of each other.
// ---------------------------------------------------------------------------
{
  const rows = [
    { category: "Net Interest", start: 475.0, end: 881.7 },
    { category: "Defense", start: 751.8, end: 874.0 },
    { category: "Medicaid", start: 592.4, end: 616.1 },
    { category: "Education", start: 79.3, end: 82.6 },
  ];
  const spec = { ...baseSpec, highlight_values: [] };
  const svg = renderVizSvg(spec, rows);

  // Values must render exactly as fmt() formats them from the raw data -
  // never altered or further rounded by the repel pass to force separation.
  // resolveChartDecimals() over this fixture's full 8-value set resolves to
  // 1 (881.7 would cross the integer boundary - round to a whole "882" - at
  // d=0, forcing escalation; every value is already distinguishable and
  // boundary-safe at d=1). Both are right-end (fmt(e.b)) labels, never the
  // first label drawn (Net Interest's own left label is), so fix 13 leaves
  // them bare - no unit suffix.
  const netInterestText = fmt(881.7, "", 1);
  const defenseText = fmt(874.0, "", 1);
  assert.notEqual(netInterestText, defenseText, "test fixture sanity: the two near-tied values must format to distinct strings");
  assert.match(svg, new RegExp(`>${netInterestText.replace(/[.$]/g, "\\$&")}<`), "Net Interest's exact end value must appear unrounded by anything beyond fmt() itself");
  assert.match(svg, new RegExp(`>${defenseText.replace(/[.$]/g, "\\$&")}<`), "Defense's exact end value must appear unrounded by anything beyond fmt() itself");

  const labels = extractSlopeLabels(svg);
  const rightLabels = labels.filter((l) => l.anchor === "start");
  assert.ok(rightLabels.length >= 2, "expected at least the near-tied right-end labels to be present");
  const netInterest = rightLabels.find((l) => l.text === netInterestText);
  const defense = rightLabels.find((l) => l.text === defenseText);
  assert.ok(netInterest && defense, "both near-tied right labels must be present, exact text");
  assert.ok(Math.abs(netInterest.y - defense.y) >= 18, `near-tied right labels must be repelled apart: got ${netInterest.y} vs ${defense.y}`);

  // A leader must appear for at least one of the two repelled labels (the
  // one that moved further than ~3px from its own point), thin and
  // neutral-grey per house style.
  const leaders = extractLeaders(svg);
  assert.ok(leaders.length >= 1, "at least one label-leader expected for the repelled near-tie");
  for (const leader of leaders) {
    assert.ok(leader.strokeWidth <= 1, `leader stroke-width must stay <=1px, got ${leader.strokeWidth}`);
    assert.equal(leader.stroke, HOUSE_MUTED, "leader must use the neutral-grey muted palette colour (house style, the default)");
  }

  const qa = checkSvgGeometry(svg);
  assert.equal(qa.passed, true, `resolvable near-tie must pass render QA: ${JSON.stringify(qa.failures)}`);
  console.log("slope 2-way near-tie exact reported case: PASS");
}

// ---------------------------------------------------------------------------
// 2. A 3-way near-tie: three right-end values within a couple of points of
//    each other, all three labels must end up separated by the minimum gap.
// ---------------------------------------------------------------------------
{
  const rows = [
    { category: "Alpha", start: 30.0, end: 50.2 },
    { category: "Beta", start: 32.0, end: 50.6 },
    { category: "Gamma", start: 34.0, end: 51.1 },
    { category: "Delta", start: 10.0, end: 6.0 },
  ];
  const spec = { ...baseSpec, unit: "index", highlight_values: [] };
  const svg = renderVizSvg(spec, rows);

  // resolveChartDecimals() over this fixture's full 8-value set resolves to
  // 1, same reasoning as block 1 above (50.2 etc. would cross the integer
  // boundary at d=0). All three are right-end labels, never the first label
  // drawn, so - fix 13 - they're bare, no "index" unit suffix.
  const expected = [fmt(50.2, "", 1), fmt(50.6, "", 1), fmt(51.1, "", 1)];
  for (const text of expected) assert.match(svg, new RegExp(`>${text.replace(/[.$]/g, "\\$&")}<`), `${text} must appear unrounded`);

  const rightLabels = extractSlopeLabels(svg).filter((l) => l.anchor === "start" && expected.includes(l.text));
  assert.equal(rightLabels.length, 3, "all three near-tied labels must be present with their exact values");
  const ys = rightLabels.map((l) => l.y).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] - ys[i - 1] >= 18 - 0.01, `3-way near-tie labels must each clear the minimum gap: ${ys}`);
  }

  const qa = checkSvgGeometry(svg);
  assert.equal(qa.passed, true, `resolvable 3-way near-tie must pass render QA: ${JSON.stringify(qa.failures)}`);
  console.log("slope 3-way near-tie: PASS");
}

// ---------------------------------------------------------------------------
// 3. An impossible case: far more near-tied labels crammed into a plot band
//    than the layout has room to separate at the minimum gap. This must NOT
//    be silently hidden - render QA must still fail it, so a genuinely
//    overcrowded chart is caught rather than shipped with invisible or
//    overlapping labels.
//
//    renderSlope's own frame height scales with row count (~26px/row),
//    which always leaves enough room for that many labels at the minimum
//    gap - a chart that grows with its own label count can't be forced
//    into this state through row count alone. A scatter chart's plot band
//    is fixed regardless of point count, so piling many highlighted
//    (direct-labeled) points on top of one another there is the genuine
//    "no obstacle-aware placement can save this" case that createAnnotationLayout's
//    own header comment says render QA - not this layout pass - must catch.
// ---------------------------------------------------------------------------
{
  const rows = Array.from({ length: 30 }, (_, i) => ({
    entity: `Entity ${i + 1}`,
    x: 5,
    y: 50 + i * 0.001, // 30 points effectively stacked on one spot
  }));
  const spec = {
    ...baseSpec,
    chart_type: "scatter",
    x_field: "x",
    y_field: "y",
    label_field: "entity",
    highlight_values: rows.map((r) => r.entity), // every point gets a direct label
    annotations: [],
  };
  delete spec.category_field; delete spec.start_field; delete spec.end_field;
  const svg = renderVizSvg(spec, rows);
  const qa = checkSvgGeometry(svg);
  assert.equal(qa.passed, false, "30 direct labels stacked on one point must still fail render QA, not be hidden by the obstacle-aware layout");
  assert.ok(qa.failures.some((f) => f.rule === "text_overlap"), `expected a text_overlap failure for the impossible case, got: ${JSON.stringify(qa.failures.map((f) => f.rule))}`);
  console.log("scatter impossible label pile-up still fails render QA (not hidden): PASS");
}

console.log("label de-collision regression: PASS");
