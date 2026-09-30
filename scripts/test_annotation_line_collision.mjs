#!/usr/bin/env node
// Regression tests for the round-2 house-style fix: a line chart's point
// annotations must never land on top of the data line they annotate, must
// never collide with each other, and every annotation leader must end at
// its own target point - not at a neighbouring point.
//
// This reproduces (in a synthetic, self-contained fixture, not the real
// fertility-chart data) the reported bug: on a falling-then-flat line,
// "2021 年 5 月公布三孩政策" sat on the line near 2020-2021, and
// "2017 年小幅回升至 1.795" ran into "2016 年起施行二孩政策"; the leader
// for the 2017 annotation landed on the 2016 point instead of its own.
//
// Round-3 follow-up: enforcing a genuine >=12px horizontal clearance between
// ANY two labels (not just same-row ones, per the house-style fix) means
// this exact fixture's full-sentence 2016/2017 annotations - independently
// measured at ~126-166px wide against a ~93px x-gap - can never both fit on
// two rows without violating that clearance. This fixture is therefore
// EXPECTED to resolve to the numbered-marker + caption fallback, and that is
// the correct, intended behaviour of a faithfully-enforced clearance rule,
// not a bug. A second, short-label fixture below exercises the 2-row lane
// path itself (guide-below-label clearance, anchor flip, compact sizing).
import assert from "node:assert/strict";
import { renderVizSvg } from "../runtime/pi/viz.mjs";
import { checkSvgGeometry, ASCENT_RATIO, DESCENT_RATIO } from "../runtime/pi/render_qa_geometry.mjs";

// Shared helper for the guide-vs-label-bbox check (used below for both the
// fallback-mode fixture and the lane-mode fixture): approximates each
// <text> node's bbox from its x/y/anchor/font-size/content using the same
// CJK-is-roughly-square-per-unit assumption viz.mjs's own layout uses, then
// asserts no <line data-role="annotation-leader"> vertical segment crosses
// any text bbox's rectangle.
function assertNoGuideCrossesText(svg, label) {
  const textUnitsOf = (s) => [...s].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 1 : /\s/.test(ch) ? 0.2778 : 0.55), 0);
  const texts = [...svg.matchAll(/<text data-role="annotation" x="([-0-9.]+)" y="([-0-9.]+)"(?: text-anchor="(start|end|middle)")?[^>]*font-size="([0-9.]+)"[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => {
      const x = Number(m[1]), y = Number(m[2]), anchor = m[3] || "start", fontSize = Number(m[4]);
      const content = m[5].replace(/<[^>]*>/g, "");
      const width = textUnitsOf(content) * fontSize * 1.05;
      const x0 = anchor === "end" ? x - width : anchor === "middle" ? x - width / 2 : x;
      const x1 = x0 + width;
      return { x0, x1, yTop: y - fontSize * ASCENT_RATIO, yBottom: y + fontSize * DESCENT_RATIO };
    });
  const guides = [...svg.matchAll(/<line data-role="annotation-leader" x1="([-0-9.]+)" y1="([-0-9.]+)" x2="([-0-9.]+)" y2="([-0-9.]+)"/g)]
    .map((m) => ({ x: Number(m[1]), y0: Math.min(Number(m[2]), Number(m[4])), y1: Math.max(Number(m[2]), Number(m[4])) }));
  for (const g of guides) {
    for (const t of texts) {
      const xOverlap = g.x >= t.x0 && g.x <= t.x1;
      const yOverlap = g.y0 < t.yBottom && g.y1 > t.yTop;
      assert.ok(!(xOverlap && yOverlap), `${label}: a guide at x=${g.x} (y ${g.y0}-${g.y1}) crosses a text bbox (x ${t.x0}-${t.x1}, y ${t.yTop}-${t.yBottom})`);
    }
  }
}

const claimId = "claim-fertility-annotations";
const rows = [
  { year: 2014, value: 1.60 },
  { year: 2015, value: 1.62 },
  { year: 2016, value: 1.70 }, // "2016 年起施行二孩政策"
  { year: 2017, value: 1.795 }, // "2017 年小幅回升至 1.795" - own point, not 2016's
  { year: 2018, value: 1.50 },
  { year: 2019, value: 1.30 },
  { year: 2020, value: 1.10 },
  { year: 2021, value: 0.95 }, // falling line right through here - "2021 年 5 月公布三孩政策"
  { year: 2022, value: 0.90 },
  { year: 2023, value: 0.88 },
];
const spec = {
  schema_version: "0.7.0",
  reader_task: "change",
  takeaway: "Fertility fell even as two-child and three-child policies were announced.",
  chart_type: "line",
  title: "Total fertility rate, 2014-2023",
  alt: "A falling line chart of fertility rate with three policy annotations.",
  source_note: "Synthetic regression fixture",
  claim_id: claimId,
  sql: "SELECT * FROM synthetic",
  unit: "births",
  x_field: "year",
  value_field: "value",
  annotations: [
    { type: "point", text: "2016 年起施行二孩政策", claim_id: claimId, match_field: "year", match_value: 2016 },
    { type: "point", text: "2017 年小幅回升至 1.795", claim_id: claimId, match_field: "year", match_value: 2017 },
    { type: "point", text: "2021 年 5 月公布三孩政策", claim_id: claimId, match_field: "year", match_value: 2021 },
  ],
};

const svg = renderVizSvg(spec, rows);

// ---------------------------------------------------------------------------
// (1) render QA's text_crosses_data_mark rule must be clean: none of the
//     three annotation texts may sit on top of the line itself.
// ---------------------------------------------------------------------------
const qa = checkSvgGeometry(svg);
assert.equal(qa.passed, true, `annotated fertility line must pass render QA cleanly: ${JSON.stringify(qa.failures)}`);
assert.ok(qa.summary.marks_checked >= 1, "the line itself must have been recorded as a data mark to check against");
console.log("annotated line passes text_crosses_data_mark and text_overlap: PASS");

// ---------------------------------------------------------------------------
// (2) Guide/marker x invariant (round-3 event-annotation lane): every
//     annotation-leader (guide) and every data-point dot/marker for an
//     event must sit at that event's own data x - never a neighbour's
//     (e.g. the 2017 annotation must land at 2017's x, not 2016's).
// ---------------------------------------------------------------------------
// Recover each row's true plotted x the same way renderLine does, by
// reading the polyline's own points back out of the SVG (generic - reads
// rendered geometry, doesn't assume straight segments) and matching them
// in row order (rows are monotonic in x_field here, matching plot order).
const polylineMatch = svg.match(/<polyline[^>]*points="([^"]+)"/);
assert.ok(polylineMatch, "expected a polyline for the line chart's data mark");
const linePoints = polylineMatch[1].trim().split(/\s+/).map((pair) => {
  const [x, y] = pair.split(",").map(Number);
  return { x, y };
});
assert.equal(linePoints.length, rows.length, "one plotted point per row");
const pointByYear = new Map(rows.map((r, i) => [r.year, linePoints[i]]));

const leaders = [...svg.matchAll(/<line data-role="annotation-leader" x1="([-0-9.]+)" y1="([-0-9.]+)" x2="([-0-9.]+)" y2="([-0-9.]+)"/g)]
  .map((m) => ({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) }));
assert.equal(leaders.length, 3, "expected exactly one guide per point annotation");

const annotationYears = [2016, 2017, 2021];
leaders.forEach((leader, i) => {
  const target = pointByYear.get(annotationYears[i]);
  assert.ok(target, `no plotted point found for year ${annotationYears[i]}`);
  assert.ok(Math.abs(leader.x1 - target.x) < 0.01 && Math.abs(leader.x2 - target.x) < 0.01,
    `guide ${i} (for ${annotationYears[i]}) must run through its own point's x (${target.x}), got x1=${leader.x1} x2=${leader.x2}`);
});
console.log("each guide's x equals its own target point's x: PASS");

// ---------------------------------------------------------------------------
// (3) Annotation-vs-annotation collision: none of the three annotation text
//     boxes may overlap another (the reported "...1.795" running into
//     "...二孩政策" case). This fixture's real label widths force the
//     numbered-marker fallback (see header note), so its three annotation
//     text nodes are the caption-list rows, not lane labels - either way
//     none may collide.
// ---------------------------------------------------------------------------
const annotationTexts = [...svg.matchAll(/<text data-role="annotation" x="([-0-9.]+)" y="([-0-9.]+)"[^>]*>([\s\S]*?)<\/text>/g)];
assert.equal(annotationTexts.length, 3, "expected all three annotation text nodes");
assert.ok(qa.failures.every((f) => f.rule !== "text_overlap"), `no annotation may overlap another or the axis text: ${JSON.stringify(qa.failures)}`);
console.log("annotations do not collide with each other: PASS");

// ---------------------------------------------------------------------------
// (3b) No guide (annotation-leader) segment may intersect any label's text
//      bbox - the reported "guide runs through 二孩" bug.
// ---------------------------------------------------------------------------
assertNoGuideCrossesText(svg, "trend01 fixture");
console.log("no guide segment intersects any annotation text bbox: PASS");

// ---------------------------------------------------------------------------
// (4) Crowding fallback: when events sit too close to read as separate
//     lane guides (here, forced by cramming 8 annotations onto the SAME
//     single point - 0% of the plot width apart, well under the 6%
//     threshold), the whole chart must switch to numbered markers plus an
//     ordered caption list rather than force an overlapping placement or
//     hide a label. Render QA must still pass cleanly, every marker/guide
//     must sit at its own event's x, and no annotation may be dropped.
// ---------------------------------------------------------------------------
{
  const denseRows = [{ year: 2010, value: 1.5 }];
  const denseSpec = {
    ...spec,
    annotations: Array.from({ length: 8 }, (_, i) => ({
      type: "point",
      text: `注解第${i + 1}条这是一段较长的中文说明文字用于测试拥挤情形`,
      claim_id: claimId,
      match_field: "year",
      match_value: 2010,
    })),
  };
  const denseSvg = renderVizSvg(denseSpec, denseRows);
  const denseQa = checkSvgGeometry(denseSvg);
  assert.equal(denseQa.passed, true, `crowding fallback must still render QA-clean: ${JSON.stringify(denseQa.failures)}`);
  // Round-3 follow-up: markers are a single drawn circle (data-role
  // "annotation-marker") plus a PLAIN digit <text> - never a circled-digit
  // glyph (e.g. "①") drawn inside its own circle too (a double ring), and
  // the caption list reuses the exact same badge style as the on-chart
  // marker.
  // Scoped to data-role="annotation-marker-label" (the digit text drawMarkerBadge
  // emits, both on-chart and in the caption list) rather than any bare
  // ">N</text>" in the whole SVG: fix 3 (units repeat on every tick) can make
  // a house-style y-axis tick render as a bare "1"/"2"/etc. too, which would
  // otherwise be miscounted as a third occurrence of that marker's digit.
  for (let i = 1; i <= 8; i++) {
    const digitCount = (denseSvg.match(new RegExp(`data-role="annotation-marker-label"[^>]*>${i}</text>`, "g")) || []).length;
    assert.equal(digitCount, 2, `marker ${i} must appear as a plain digit exactly twice (on-chart + caption), got ${digitCount}`);
  }
  const circledGlyphs = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
  for (const g of circledGlyphs) {
    assert.ok(!denseSvg.includes(g), `must not use the circled-digit glyph ${g} - it double-rings with the drawn circle`);
  }
  const markerCircles = (denseSvg.match(/data-role="annotation-marker"/g) || []).length;
  assert.equal(markerCircles, 16, "expected exactly one on-chart marker circle and one caption badge circle per event (8 x 2)");
  const digitFontSizes = [...denseSvg.matchAll(/data-role="annotation-marker"[^>]*\/>\s*<text[^>]*font-size="([0-9.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(digitFontSizes.length >= 16 && digitFontSizes.every((f) => f >= 12), "every marker digit must render at >=12px (font floor)");
  console.log("crowding triggers the numbered-marker + caption fallback (plain digits, no double ring), QA stays clean, nothing is dropped: PASS");
  assertNoGuideCrossesText(denseSvg, "dense-crowding fallback fixture");
  console.log("dense-crowding fallback: no guide segment intersects any annotation text bbox: PASS");
}

// ---------------------------------------------------------------------------
// (4b) Lane-mode fixture: the main fixture above now legitimately resolves
//      to the fallback (its real label widths cannot fit two rows with
//      >=12px clearance at their actual x-spacing - see header note). This
//      fixture uses short, single-phrase labels on the same series so the
//      2-row lane path itself is exercised and its round-3 fixes (guide
//      stops below the label, anchor-aware left/right alignment, compact
//      content-driven lane sizing) are directly verified.
// ---------------------------------------------------------------------------
{
  const laneSpec = {
    ...spec,
    annotations: [
      { type: "point", text: "二孩政策", claim_id: claimId, match_field: "year", match_value: 2016 },
      { type: "point", text: "1.795 峰值", claim_id: claimId, match_field: "year", match_value: 2017 },
      { type: "point", text: "三孩政策", claim_id: claimId, match_field: "year", match_value: 2021 },
    ],
  };
  const laneSvg = renderVizSvg(laneSpec, rows);
  assert.ok(!laneSvg.includes('data-role="annotation-marker"'), "short labels must fit the 2-row lane, not fall back to numbered markers");
  const laneQa = checkSvgGeometry(laneSvg);
  assert.equal(laneQa.passed, true, `lane-mode fixture must pass render QA cleanly: ${JSON.stringify(laneQa.failures)}`);
  const laneTexts = [...laneSvg.matchAll(/<text data-role="annotation"[^>]*text-anchor="(start|end|middle)"/g)].map((m) => m[1]);
  assert.equal(laneTexts.length, 3, "expected all three lane labels");
  assert.ok(laneTexts.every((a) => a === "start" || a === "end"), 'lane labels must be left- or right-aligned at their own guide x (never "middle", which centres the guide through the label)');
  assertNoGuideCrossesText(laneSvg, "lane-mode fixture");
  console.log("lane-mode fixture: fits without fallback, QA-clean, anchored (not centred), no guide crosses any label: PASS");
  const laneSvgAgain = renderVizSvg(laneSpec, rows);
  assert.equal(laneSvgAgain, laneSvg, "rendering the same lane-mode spec twice must produce an identical SVG");
  console.log("lane layout (lane-mode fixture) is deterministic across renders: PASS");
}

// ---------------------------------------------------------------------------
// (5) Determinism: rendering the same spec twice must byte-for-byte match
//     (same SVG), for both the lane layout and the fallback layout.
// ---------------------------------------------------------------------------
{
  const svgAgain = renderVizSvg(spec, rows);
  assert.equal(svgAgain, svg, "rendering the same trend-01 spec twice must produce an identical SVG");
  console.log("lane layout is deterministic across renders: PASS");
}

// ---------------------------------------------------------------------------
// (6) Real trend-01 fixture (polish-2 fix 1): the actual production spec and
//     data behind the reported bug - China's 1990-2023 total fertility rate,
//     with the same three annotations at years 2016/2017/2021 that fell back
//     to numbered badges before the per-label row x anchor search replaced
//     the old "any two events within 6% of plot width -> fallback" rule.
//     Unlike fixture (4b) above (a synthetic 10-row series), this uses the
//     real 34-row annual series, so the x-spacing between 2016 and 2017 (one
//     year apart in a 1990-2023 domain) matches production exactly.
// ---------------------------------------------------------------------------
{
  const realRows = [
    [1990, 2.514], [1991, 1.934], [1992, 1.776], [1993, 1.691], [1994, 1.628],
    [1995, 1.588], [1996, 1.554], [1997, 1.527], [1998, 1.522], [1999, 1.530],
    [2000, 1.628], [2001, 1.563], [2002, 1.566], [2003, 1.570], [2004, 1.605],
    [2005, 1.624], [2006, 1.644], [2007, 1.666], [2008, 1.701], [2009, 1.714],
    [2010, 1.687], [2011, 1.668], [2012, 1.798], [2013, 1.714], [2014, 1.769],
    [2015, 1.670], [2016, 1.772], [2017, 1.795], [2018, 1.539], [2019, 1.496],
    [2020, 1.236], [2021, 1.117], [2022, 1.034], [2023, 0.999],
  ].map(([year, tfr]) => ({ year, tfr }));
  const realClaimId = "claim-70c5d83e4b5e0fbf";
  const realSpec = {
    schema_version: "0.7.0",
    reader_task: "change",
    takeaway: "China's fertility rate fell from 2.514 in 1990 to 0.999 in 2023.",
    chart_type: "line",
    language: "zh",
    title: "中国总和生育率，1990-2023 年",
    subtitle: "每名妇女一生平均生育子女数",
    alt: "折线图：中国总和生育率从 1990 年的 2.514 一路下降到 2023 年的 0.999。",
    source_note: "联合国世界人口展望估计数，经 Our World in Data 转存",
    claim_id: realClaimId,
    sql: "SELECT * FROM synthetic",
    unit: "个孩子",
    x_field: "year",
    value_field: "tfr",
    annotations: [
      { type: "point", text: "二孩政策", claim_id: "claim-c93c4b2693e2151c", match_field: "year", match_value: 2016 },
      { type: "point", text: "1.795 峰值", claim_id: "claim-c93c4b2693e2151c", match_field: "year", match_value: 2017 },
      { type: "point", text: "三孩政策", claim_id: "claim-4244c64d408c2410", match_field: "year", match_value: 2021 },
    ],
  };
  const realSvg = renderVizSvg(realSpec, realRows);
  assert.ok(!realSvg.includes('data-role="annotation-marker"'), "real trend-01 fixture: 2016/2017/2021 must fit the lane, not fall back to numbered markers");
  assert.ok(!/[①②③]/.test(realSvg), "real trend-01 fixture: must not use circled-digit glyphs either");
  const realQa = checkSvgGeometry(realSvg);
  assert.equal(realQa.passed, true, `real trend-01 fixture must pass render QA cleanly: ${JSON.stringify(realQa.failures)}`);
  const realLaneTexts = [...realSvg.matchAll(/<text data-role="annotation"[^>]*text-anchor="(start|end|middle)"[^>]*>([\s\S]*?)<\/text>/g)];
  assert.equal(realLaneTexts.length, 3, "expected all three lane labels for the real trend-01 fixture");
  const realLaneByText = new Map(realLaneTexts.map((m) => [m[2], m[1]]));
  assert.equal(realLaneByText.get("二孩政策"), "start", "2016's label must anchor start (or successfully share a row via some other valid anchor)");
  assert.equal(realLaneByText.get("1.795 峰值"), "start", "2017's label must anchor start (or successfully share a row via some other valid anchor)");
  assertNoGuideCrossesText(realSvg, "real trend-01 fixture");
  const realSvgAgain = renderVizSvg(realSpec, realRows);
  assert.equal(realSvgAgain, realSvg, "rendering the real trend-01 spec twice must produce an identical SVG");
  console.log("real trend-01 fixture (2016/2017/2021, 34-year series): lane labels, no badges, QA-clean, deterministic: PASS");
}

console.log("annotation/line collision regression: PASS");
