#!/usr/bin/env node
// Regression tests for the leader-transform fix in render_qa_geometry.mjs.
//
// Before this fix, ruleLeaderCrossings read leader (<line>/<path
// data-role="*-leader">) geometry via extractLeaderSegments, a standalone
// regex over the raw SVG text that took x1/y1/x2/y2 (and path M/L points)
// literally, with no transform resolution - the one rule in that module
// that did not go through the shared walkSvgTree/transform pipeline every
// text, rect, line, and mark already used. On a composed infographic page
// (infographic.mjs wraps each chart as a nested `<svg data-role=
// "infographic-visual" x y width height viewBox>`), that left a leader in
// its chart's local frame while the text it was compared against was
// already in page space, producing both false positives (a local-frame
// leader whose raw numbers happen to fall inside a page-space text box, far
// from where it is actually drawn) and false negatives (a real crossing
// inside a nested, scaled chart, never seen because the leader's true page
// position was never computed).
//
// Each scenario below is a *-transform pair*: the same relative geometry,
// once via a nested <svg viewBox> and once via a <g transform>, so both of
// this module's transform sources are covered. Every fixture in this file
// was checked by hand against the pre-fix code (a scratch side-by-side
// comparison, not shipped here) to confirm it actually reproduces the
// specific false positive/negative being guarded against, not just an
// arbitrary pass/fail.
import assert from "node:assert/strict";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

function leaderRules(result) {
  return result.failures.filter((f) => f.rule === "leader_crossing" || f.rule === "leader_crosses_text");
}

// ===========================================================================
// 1-3. Nested <svg viewBox> (infographic.mjs's embedVisual shape)
// ===========================================================================

// (1) False positive removed: a `label-leader` <line> lives inside a nested
// chart (data-role="infographic-visual", viewBox 0 0 100 50 scaled 3x into a
// 300x150 viewport at page offset (900,1500) - the same shape comp-01's real
// evidence SVG used). Its RAW/local endpoints (90,8)-(95,13) happen to fall
// numerically inside a page-level title's box, but its true page position -
// (900+3*90, 1500+3*8) to (900+3*95, 1500+3*13) = (1170,1524)-(1185,1539) -
// is nowhere near that title.
{
  const svg = `<svg viewBox="0 0 1200 1700">
    <text x="70" y="12" font-size="12">Page level title text spanning wide</text>
    <svg data-role="infographic-visual" x="900" y="1500" width="300" height="150" viewBox="0 0 100 50" preserveAspectRatio="xMidYMin meet">
      <line data-role="label-leader" x1="90" y1="8" x2="95" y2="13"/>
    </svg>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result), [], "nested <svg>: a local-frame coincidence must not be reported as leader_crosses_text");
  console.log("nested <svg> viewBox: local-frame false positive is fixed: PASS");
}

// (2) False negative fixed: leader and its label both live inside the SAME
// nested chart; once both are correctly scaled by that chart's own
// viewBox matrix, the leader genuinely crosses the label.
{
  const svg = `<svg viewBox="0 0 1200 1700">
    <svg data-role="infographic-visual" x="900" y="1500" width="300" height="150" viewBox="0 0 100 50" preserveAspectRatio="xMidYMin meet">
      <text x="20" y="20" font-size="10">Inside Nested Chart Label</text>
      <line data-role="label-leader" x1="10" y1="10" x2="90" y2="25"/>
    </svg>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result).map((f) => f.rule), ["leader_crosses_text"], "nested <svg>: a real crossing inside a scaled chart must be reported");
  console.log("nested <svg> viewBox: real crossing inside the nested chart is now detected: PASS");
}

// (3) False negative fixed: leader lives inside the nested chart, its label
// is a page-level sibling text OUTSIDE the chart; once the leader is
// transformed to page space it genuinely crosses that page-level text.
{
  const svg = `<svg viewBox="0 0 1200 1700">
    <svg data-role="infographic-visual" x="900" y="1500" width="300" height="150" viewBox="0 0 100 50" preserveAspectRatio="xMidYMin meet">
      <line data-role="label-leader" x1="0" y1="0" x2="100" y2="50"/>
    </svg>
    <text x="1000" y="1560" font-size="12">Page level label near the chart</text>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result).map((f) => f.rule), ["leader_crosses_text"], "nested <svg>: a real crossing from a nested leader to a page-level text must be reported");
  console.log("nested <svg> viewBox: real crossing from a nested leader to a page-level text is now detected: PASS");
}

// ===========================================================================
// 4-6. Same three shapes via <g transform="translate(..) scale(..)">
// ===========================================================================

{
  const svg = `<svg viewBox="0 0 1200 1700">
    <text x="70" y="12" font-size="12">Page level title text spanning wide</text>
    <g data-role="infographic-visual" transform="translate(900,1500) scale(3)">
      <line data-role="label-leader" x1="90" y1="8" x2="95" y2="13"/>
    </g>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result), [], "<g transform>: a local-frame coincidence must not be reported as leader_crosses_text");
  console.log("<g transform>: local-frame false positive is fixed: PASS");
}

{
  const svg = `<svg viewBox="0 0 1200 1700">
    <g data-role="infographic-visual" transform="translate(900,1500) scale(3)">
      <text x="20" y="20" font-size="10">Inside G Chart Label</text>
      <line data-role="label-leader" x1="10" y1="10" x2="90" y2="25"/>
    </g>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result).map((f) => f.rule), ["leader_crosses_text"], "<g transform>: a real crossing inside the transformed group must be reported");
  console.log("<g transform>: real crossing inside the transformed group is now detected: PASS");
}

{
  const svg = `<svg viewBox="0 0 1200 1700">
    <g data-role="infographic-visual" transform="translate(900,1500) scale(3)">
      <line data-role="label-leader" x1="0" y1="0" x2="100" y2="50"/>
    </g>
    <text x="1000" y="1560" font-size="12">Page level label near the chart</text>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result).map((f) => f.rule), ["leader_crosses_text"], "<g transform>: a real crossing from a grouped leader to a page-level text must be reported");
  console.log("<g transform>: real crossing from a grouped leader to a page-level text is now detected: PASS");
}

// ===========================================================================
// 7-8. leader_crossing (leader-vs-leader) across two different frames
// ===========================================================================

// (7) Pass case: a nested leader's RAW numbers (10,10)-(90,40) would cross a
// page-level leader's raw (5,25)-(95,25) if compared without transforming
// either one - but the nested leader's true page position, (930,1530)-
// (1170,1620), is nowhere near the page-level leader. Must pass.
{
  const svg = `<svg viewBox="0 0 1200 1700">
    <svg data-role="infographic-visual" x="900" y="1500" width="300" height="150" viewBox="0 0 100 50" preserveAspectRatio="xMidYMin meet">
      <line data-role="label-leader" x1="10" y1="10" x2="90" y2="40"/>
    </svg>
    <line data-role="annotation-leader" x1="5" y1="25" x2="95" y2="25"/>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result), [], "leader_crossing: distinct-frame leaders that do not truly cross in page space must pass");
  console.log("leader_crossing across frames: non-crossing pair passes: PASS");
}

// (8) Fail case: a nested leader's raw numbers (0,0)-(100,50) look nowhere
// near a page-level leader's raw (900,1550)-(1200,1500) - but the nested
// leader's true page position, (900,1500)-(1200,1650), genuinely crosses it
// (at page point (975,1537.5)). Must fail.
{
  const svg = `<svg viewBox="0 0 1200 1700">
    <svg data-role="infographic-visual" x="900" y="1500" width="300" height="150" viewBox="0 0 100 50" preserveAspectRatio="xMidYMin meet">
      <line data-role="label-leader" x1="0" y1="0" x2="100" y2="50"/>
    </svg>
    <line data-role="annotation-leader" x1="900" y1="1550" x2="1200" y2="1500"/>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result).map((f) => f.rule), ["leader_crossing"], "leader_crossing: distinct-frame leaders that truly cross in page space must fail");
  console.log("leader_crossing across frames: crossing pair fails: PASS");
}

// ===========================================================================
// 9. Leader ids follow true document order
// ===========================================================================

// Pre-fix, extractLeaderSegments ran ALL <line>s (sharing one global index)
// and THEN all <path>s (continuing that same index) as two separate regex
// passes - so a <path> leader appearing BEFORE a <line> leader in the actual
// document still got the LATER id. Leaders are now collected during one
// single document-order tree walk, so id order matches document order.
{
  const svg = `<svg viewBox="0 0 200 200">
    <path data-role="foo-leader" d="M0,0 L100,100"/>
    <line data-role="bar-leader" x1="0" y1="100" x2="100" y2="0"/>
  </svg>`;
  const result = checkSvgGeometry(svg);
  const crossing = result.failures.find((f) => f.rule === "leader_crossing");
  assert.ok(crossing, "the crossing path/line pair must be reported");
  assert.equal(crossing.element, "foo-leader#0+bar-leader#1", "the <path> (first in document order) must get index 0, and the <line> (second) index 1");
  console.log("leader ids follow true document order, not a lines-then-paths grouping: PASS");
}

// ===========================================================================
// 10-11. Marker-badge exemption frame-consistency
// ===========================================================================

// (10) No regression: a leader and its own stacked marker-badge digit that
// truly share one page-space x (both resolved through the SAME nested
// chart's transform) must stay exempted.
{
  const svg = `<svg viewBox="0 0 1200 1700">
    <svg data-role="infographic-visual" x="900" y="1500" width="300" height="150" viewBox="0 0 100 50" preserveAspectRatio="xMidYMin meet">
      <line data-role="annotation-leader" x1="50" y1="5" x2="50" y2="45"/>
      <text data-role="annotation-marker-label" x="50" y="20" font-size="10">1</text>
    </svg>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result), [], "marker-badge exemption: a genuine same-transform stack must stay exempted");
  console.log("marker-badge exemption: genuine same-frame stack stays exempted: PASS");
}

// (11) Frame-mismatch guard: a leader (chart A, scale 3, local x=50 -> page
// x=1050) and an unrelated annotation-marker-label text (chart B, scale 0.5,
// LOCAL x=1050 - chosen to coincidentally equal the LEADER's PAGE x, not
// chart B's own local frame) whose actual page-space anchor.x is 525, not
// 1050. A long string still lets its page-space box reach across to x=1050
// (box [525, 1244]), so this is a genuine crossing. Comparing local x's
// (50 vs 1050: far apart) correctly would never even reach the exemption;
// the bug this guards is comparing the text's LOCAL x directly against the
// leader's now-page-space x (1050 vs 1050: coincidentally "equal") instead
// of the text's own page-space anchor (525 vs 1050: correctly far apart).
// Confirmed by hand (scratch comparison, not shipped) that reverting just
// this comparison back to the text's local x wrongly exempts this crossing
// - and, separately, wrongly REJECTS case (10)'s legitimate same-frame
// stack, since node.x is local while a transformed leader's x is page-space
// for every real (scaled/nested) chart.
{
  const longText = "Marker label text stretched out long enough to reach across the page gap so its box still overlaps the far leader";
  const svg = `<svg viewBox="0 0 1200 1700">
    <svg data-role="infographic-visual" x="900" y="1500" width="300" height="150" viewBox="0 0 100 50" preserveAspectRatio="xMidYMin meet">
      <line data-role="annotation-leader" x1="50" y1="5" x2="50" y2="45"/>
    </svg>
    <svg data-role="infographic-visual" x="0" y="1500" width="600" height="150" viewBox="0 0 1200 300" preserveAspectRatio="xMidYMin meet">
      <text data-role="annotation-marker-label" x="1050" y="50" font-size="28">${longText}</text>
    </svg>
  </svg>`;
  const result = checkSvgGeometry(svg);
  assert.deepEqual(leaderRules(result).map((f) => f.rule), ["leader_crosses_text"], "marker-badge exemption: a local-x coincidence across two different frames must not be mistaken for a same-point stack");
  console.log("marker-badge exemption: cross-frame local-x coincidence is not mistaken for a same-point stack: PASS");
}

console.log("render_qa_geometry leader-transform regression: PASS");
