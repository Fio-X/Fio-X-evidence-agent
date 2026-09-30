// Deterministic, browser-free geometry checks over rendered SVG chart and
// infographic markup.
//
// Today nothing looks at the rendered picture: a chart can pass every
// evidence/verification/lint gate while its labels sit outside the canvas,
// its font is unreadably small, or a dozen distinct bars merge into one
// indistinguishable band. This module is a pure, synchronous function that
// parses just enough of the SVG grammar our own renderers emit (viz.mjs,
// infographic.mjs, and the lieflat templates they feed) to catch exactly
// those defects, without a browser, network access, or any new dependency.
//
// It is not wired into any pipeline yet - that is a later, separate task.
//
// Design principle: every estimate here is conservative and documented, and
// favours reporting an "unmeasured" note over guessing when the input is
// ambiguous (an unresolved transform, an unrecognised colour format, a
// missing viewBox). Notes never count as a pass and never count as a
// failure - they are a third, explicit "we don't know" bucket. Model output
// (or renderer output) can make this check fail; nothing can make it pass
// except geometry that actually satisfies the rule.
//
// Existing helpers surveyed for reuse before writing this: svg_security.mjs
// (assertSafeSvg only checks *presence* of a viewBox via regex and forbids
// active content - no geometry, and its one true export doesn't help here),
// label_layout.mjs (its `overlap`/`inside` axis-aligned-box helpers are not
// exported - private to that module), and infographic.mjs's `boxesOverlap`
// (~line 895, also private/unexported). None of those three are importable
// without editing files this task must not touch, so the small AABB
// primitives below are original code, but deliberately mirror the same
// "x < x2+w2-padding && ..." convention `boxesOverlap` already uses in this
// codebase for consistency.
//
// T6a (Chrome-calibration pass): render_qa_contrast.mjs already had a tested
// XML tokenizer and a full 2D affine transform engine (translate/scale/
// rotate/skewX/skewY/matrix, composed across ancestors). Those were split
// out into runtime/pi/render_qa_svg.mjs and are reused here instead of this
// module's old translate-only resolver, so a `rotate()`'d label (viz.mjs's
// y-axis title, the adjacency-matrix column headers) is now actually
// measured - as the axis-aligned box of the rotated rectangle - instead of
// being silently skipped. A nested `<svg viewBox=... preserveAspectRatio=...>`
// (infographic.mjs's embedded chart/illustration modules) is resolved the
// same way SVG itself defines it: as an extra scale+translate applied only
// to that element's children.
//
// Leader-transform fix: ruleLeaderCrossings used to source its segments from
// extractLeaderSegments, a standalone regex over the raw SVG text that read
// x1/y1/x2/y2 (and path M/L points) literally, with no transform resolution
// at all - the one rule in this module that did not go through the T6a
// transform engine above. On a composed infographic page (infographic.mjs
// embeds each chart as a nested `<svg data-role="infographic-visual" x y
// width height viewBox>`), that left a leader in the chart's local frame
// while every text it was compared against was already in page space,
// producing both false positives (a local-frame leader that happens to
// overlap a page-space text's raw coordinates, though nowhere near it once
// actually placed) and false negatives (a real crossing inside a nested,
// scaled chart, tested at the wrong place). Leaders are now collected during
// the same walkSvgTree pass as texts/rects/lines/marks, carrying the same
// accumulated matrix (nested <svg> viewBox matrix + <g>/element `transform`),
// so leader_crossing/leader_crosses_text compare like-for-like page-space
// coordinates exactly like every other rule here.

import { parseXml, multiply, apply, ownTransformMatrix, IDENTITY } from "./render_qa_svg.mjs";

export const RENDER_QA_GEOMETRY_VERSION = "0.3.3";

// ---------------------------------------------------------------------------
// Text width estimate.
//
// Every character contributes a width in em (a multiple of the element's own
// font-size) to the estimated advance width:
//
//   - Latin/ASCII/common punctuation: a per-character table measured in
//     Chrome (see LATIN_ADVANCE_WIDTHS below for exactly how).
//   - cjk (1.0em): CJK ideographs, kana, hangul and other full-width script
//     characters render at very close to one em of advance width in the
//     Arial/Helvetica stack these renderers declare everywhere, regardless
//     of weight (unlike Latin glyphs, a CJK font's full-width ideographs
//     are drawn to the same advance width in bold as in regular - there is
//     no separate bold CJK table here, deliberately).
//   - space (0.2778em, matches the measured table's own U+0020 entry):
//     applied via the same `\s` branch as any other whitespace character
//     (tab, newline) that could appear in unusually-formatted input text.
//   - safetyMargin (1.05x): a small, deliberate overestimate applied to the
//     summed width, so this check keeps erring toward flagging a genuinely
//     broken chart rather than silently missing one, even on top of an
//     exactly-measured table.
export const TEXT_WIDTH_FACTORS = Object.freeze({
  cjk: 1.0,
  space: 0.2778,
  safetyMargin: 1.05,
});

// Per-character advance-width table for ASCII 32-126 plus a small set of
// extended punctuation actually observed in this codebase's renderer source
// and/or its 39-file Chrome-calibration set (ellipsis, middle dot, arrow,
// three currency signs, curly single/double quotes, em/en dash, degree,
// plus-minus, multiplication, division, bullet) - see runtime/pi/viz.mjs and
// runtime/pi/infographic.mjs's `SANS` constant for where "Arial, Helvetica,
// sans-serif" is declared; that is the font stack measured here.
//
// Generated once with real Chrome (channel "chrome" - the same browser used
// for this module's ground truth throughout T6a) via
// `CanvasRenderingContext2D.measureText()` at `font: "100px Arial,
// Helvetica, sans-serif"` (LATIN_ADVANCE_WIDTHS) and `"bold 100px ..."`
// (LATIN_BOLD_ADVANCE_WIDTHS), then dividing by 100 so each value is already
// an em fraction; cross-checked for a sample of characters against SVG
// `<text>.getComputedTextLength()`, which agreed to within 0.001em. See
// scratchpad/measure_font_widths.mjs and measure_font_widths_svg.mjs (not
// part of this repo) for the exact scripts.
//
// On the machine this was measured on (macOS), that font stack resolves to
// the system "Helvetica": the measured digit width (0.5562em = 556/1000 em)
// is exactly Helvetica/Arial's standard tabular-figure advance width, and
// Arial itself was designed to be metric-compatible with Helvetica for
// print/display portability, so this table is a correct measurement of
// either. "…" (ellipsis), "—" (em dash) and "→" (rightwards arrow) measure
// at a full 1.0em in both weights: this font/environment has no actual
// glyph for them, so the browser substitutes a fallback ("tofu") glyph
// exactly one em wide - a real, reproducible measurement, not an artefact
// of the measuring method (canvas and SVG agreed on this too).
//
// Regenerate by re-running those scripts if the rendering environment's
// resolved font changes.
export const LATIN_ADVANCE_WIDTHS = Object.freeze({
  " ":0.2778,"!":0.2778,"\"":0.355,"#":0.5562,"$":0.5562,"%":0.8892,"&":0.667,"'":0.1909,
  "(":0.333,")":0.333,"*":0.3892,"+":0.584,",":0.2778,"-":0.333,".":0.2778,"/":0.2778,
  "0":0.5562,"1":0.5562,"2":0.5562,"3":0.5562,"4":0.5562,"5":0.5562,"6":0.5562,"7":0.5562,
  "8":0.5562,"9":0.5562,":":0.2778,";":0.2778,"<":0.584,"=":0.584,">":0.584,"?":0.5562,
  "@":1.0151,"A":0.667,"B":0.667,"C":0.7222,"D":0.7222,"E":0.667,"F":0.6108,"G":0.7778,
  "H":0.7222,"I":0.2778,"J":0.5,"K":0.667,"L":0.5562,"M":0.833,"N":0.7222,"O":0.7778,
  "P":0.667,"Q":0.7778,"R":0.7222,"S":0.667,"T":0.6108,"U":0.7222,"V":0.667,"W":0.9438,
  "X":0.667,"Y":0.667,"Z":0.6108,"[":0.2778,"\\":0.2778,"]":0.2778,"^":0.4692,"_":0.5562,
  "`":0.333,"a":0.5562,"b":0.5562,"c":0.5,"d":0.5562,"e":0.5562,"f":0.2778,"g":0.5562,
  "h":0.5562,"i":0.2222,"j":0.2222,"k":0.5,"l":0.2222,"m":0.833,"n":0.5562,"o":0.5562,
  "p":0.5562,"q":0.5562,"r":0.333,"s":0.5,"t":0.2778,"u":0.5562,"v":0.5,"w":0.7222,
  "x":0.5,"y":0.5,"z":0.5,"{":0.334,"|":0.2598,"}":0.334,"~":0.584,
  "…":1,"·":0.333,"→":1,"£":0.5562,"€":0.5562,"¥":0.5562,
  "“":0.333,"”":0.333,"‘":0.2222,"’":0.2222,"—":1,"–":0.5562,
  "°":0.3999,"±":0.5488,"×":0.584,"÷":0.5488,"•":0.3501,
});
export const LATIN_BOLD_ADVANCE_WIDTHS = Object.freeze({
  " ":0.2778,"!":0.333,"\"":0.4741,"#":0.5562,"$":0.5562,"%":0.8892,"&":0.7222,"'":0.2378,
  "(":0.333,")":0.333,"*":0.3892,"+":0.584,",":0.2778,"-":0.333,".":0.2778,"/":0.2778,
  "0":0.5562,"1":0.5562,"2":0.5562,"3":0.5562,"4":0.5562,"5":0.5562,"6":0.5562,"7":0.5562,
  "8":0.5562,"9":0.5562,":":0.333,";":0.333,"<":0.584,"=":0.584,">":0.584,"?":0.6108,
  "@":0.9751,"A":0.7222,"B":0.7222,"C":0.7222,"D":0.7222,"E":0.667,"F":0.6108,"G":0.7778,
  "H":0.7222,"I":0.2778,"J":0.5562,"K":0.7222,"L":0.6108,"M":0.833,"N":0.7222,"O":0.7778,
  "P":0.667,"Q":0.7778,"R":0.7222,"S":0.667,"T":0.6108,"U":0.7222,"V":0.667,"W":0.9438,
  "X":0.667,"Y":0.667,"Z":0.6108,"[":0.333,"\\":0.2778,"]":0.333,"^":0.584,"_":0.5562,
  "`":0.333,"a":0.5562,"b":0.6108,"c":0.5562,"d":0.6108,"e":0.5562,"f":0.333,"g":0.6108,
  "h":0.6108,"i":0.2778,"j":0.2778,"k":0.5562,"l":0.2778,"m":0.8892,"n":0.6108,"o":0.6108,
  "p":0.6108,"q":0.6108,"r":0.3892,"s":0.5562,"t":0.333,"u":0.6108,"v":0.5562,"w":0.7778,
  "x":0.5562,"y":0.5562,"z":0.5,"{":0.3892,"|":0.2798,"}":0.3892,"~":0.584,
  "…":1,"·":0.333,"→":1,"£":0.5562,"€":0.5562,"¥":0.5562,
  "“":0.5,"”":0.5,"‘":0.2778,"’":0.2778,"—":1,"–":0.5562,
  "°":0.3999,"±":0.5488,"×":0.584,"÷":0.5488,"•":0.3501,
});

// A Latin/symbol character outside both tables above (an accented letter, an
// uncommon symbol, an emoji): none currently appear in this codebase's
// renderer source or in its 39-file Chrome-calibration set (checked
// directly), but if one appears later this module must not silently
// under-measure it. 1.02em is wider than every measured glyph above (the
// widest is "@" at 1.0151em regular / 0.9751em bold), so an unmeasured
// character is over-, never under-, estimated - consistent with this
// module's bias toward false positives over false negatives.
const FALLBACK_LATIN_WIDTH = 1.02;

// Vertical box estimate: SVG `<text>`/`<tspan>` is positioned by baseline
// (the `y` attribute), not a top-left corner. We approximate the ink box
// around that baseline using typical sans-serif metrics: ascenders reach
// about 0.8em above the baseline, descenders drop about 0.25em below it.
// Both are deliberately generous (biased toward detecting overflow, not
// missing it) and both are tunable via options.
export const ASCENT_RATIO = 0.8;
export const DESCENT_RATIO = 0.25;

// Weights from 600 up are measured with the bold table. The renderers'
// Arial/Helvetica stack has only regular and bold faces, and CSS font
// matching resolves 600 to the bold face: in Chrome, "Transformation is the
// main" measures 11.80em at 400 and 500 but 12.78em at both 600 and 700.
// viz.mjs sets many labels at 600, so treating 600 as regular would
// under-measure them by about 8%.
export const BOLD_WEIGHT_THRESHOLD = 600;

// UA default font-size (CSS 'medium'), used only when no font-size can be
// found anywhere in an element's ancestry or in a matching <style> rule.
const UA_DEFAULT_FONT_SIZE = 16;

const DEFAULT_OPTIONS = Object.freeze({
  minFontSize: 12, // font_below_floor: effective font-size must be >= this
  viewboxTolerance: 0.5, // text_outside_viewbox: px slack around the viewBox edges
  textOverlapTolerance: 1, // text_overlap: intersection must exceed this on both axes
  edgeGapTolerance: 1, // indistinct_adjacent_marks: a gap in [-overlapTolerance, edgeGapTolerance) counts as touching
  overlapTolerance: 0.5, // indistinct_adjacent_marks: rects overlapping by more than this are one shape on purpose (e.g. an illustration), not adjacent segments - not flagged
  minSharedEdge: 2, // indistinct_adjacent_marks: px of perpendicular overlap to call two rects "along an edge"
  minFillOpacity: 0.05, // rects this transparent or more are treated as invisible, not "marks"
  pageBackground: "#ffffff", // indistinct_adjacent_marks: rects this colour are page/panel background plates, not competing marks
  displayScale: 1, // font_below_floor only: root display width / viewBox width, for a chart shown smaller (or larger) than its own viewBox units, e.g. embedded as a shrunken infographic module. text_outside_viewbox/text_overlap always stay in native viewBox units (matching how the Chrome ground truth itself measures them), so this option does not affect those two rules.
  axisBracketTolerance: 0.75, // value_axis_domain_bracket: px slack (line-chart pixel space) a plotted point may sit past its outermost tick before it counts as "outside the bracketed domain"
});

// Wide (full-width) character ranges folded into the CJK width bucket:
// CJK punctuation & symbols, hiragana/katakana + phonetic extensions,
// CJK unified ideographs (+ extension A), hangul syllables, CJK
// compatibility ideographs, and the fullwidth/halfwidth forms block (which
// carries fullwidth Latin letters and punctuation used inside CJK copy).
// Hangul is included because Korean text is set at the same one-em advance
// width as Han/Kana in this same Arial/Helvetica stack, even though it is
// not, strictly, "CJK" - a documented, deliberate widening of the bucket.
const WIDE_CHAR_RE = /[　-〿぀-ヿㇰ-ㇿ㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿＀-￯]/;

function estimateTextWidth(text, fontSize, bold) {
  const table = bold ? LATIN_BOLD_ADVANCE_WIDTHS : LATIN_ADVANCE_WIDTHS;
  let units = 0;
  for (const ch of Array.from(String(text))) {
    if (/\s/.test(ch)) units += TEXT_WIDTH_FACTORS.space;
    else if (WIDE_CHAR_RE.test(ch)) units += TEXT_WIDTH_FACTORS.cjk;
    else units += table[ch] ?? FALLBACK_LATIN_WIDTH;
  }
  return units * fontSize * TEXT_WIDTH_FACTORS.safetyMargin;
}

function isBold(fontWeight) {
  if (fontWeight === undefined || fontWeight === null) return false;
  const s = String(fontWeight).trim().toLowerCase();
  if (s === "bold" || s === "bolder") return true;
  const num = Number(s);
  return Number.isFinite(num) && num >= BOLD_WEIGHT_THRESHOLD;
}

// Estimated ink box in the text node's own *local* coordinate space (before
// any transform on the element or its ancestors is applied).
function estimateTextBox(node) {
  const bold = isBold(node.fontWeight);
  const width = estimateTextWidth(node.text, node.fontSize, bold);
  // text-anchor centres/right-aligns a whole text CHUNK around its anchor
  // x, not each tspan independently. A mid-chunk continuation tspan (no
  // own x - see resolveTspanPosition's isChunkStart) already sits at its
  // correct left edge via cursor advancement, so it is measured as
  // anchor="start" regardless of the inherited text-anchor value; applying
  // the chunk's centring/right-alignment a second time to it would shift
  // it backwards on top of the tspan(s) before it in the same chunk.
  const anchor = node.isChunkStart && (node.textAnchor === "middle" || node.textAnchor === "end") ? node.textAnchor : "start";
  let x0;
  if (anchor === "middle") x0 = node.x - width / 2;
  else if (anchor === "end") x0 = node.x - width;
  else x0 = node.x;
  const ascent = node.fontSize * ASCENT_RATIO;
  const descent = node.fontSize * DESCENT_RATIO;
  return { x: x0, y: node.y - ascent, w: width, h: ascent + descent };
}

// Axis-aligned bounding box of `box`'s four corners after `matrix` (so a
// rotated or skewed box is tested as the smallest upright rectangle that
// fully contains it - the same thing a reader's eye, or getBoundingClientRect,
// would report).
function transformedBox(box, matrix) {
  const corners = [
    apply(matrix, box.x, box.y),
    apply(matrix, box.x + box.w, box.y),
    apply(matrix, box.x, box.y + box.h),
    apply(matrix, box.x + box.w, box.y + box.h),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// The displayed (post-transform) box for a resolved text node: its own local
// ink box, mapped through the accumulated transform matrix.
function estimateDisplayBox(node) {
  return transformedBox(estimateTextBox(node), node.matrix);
}

// Area-scale factor of an affine matrix's linear part (ignoring
// translation): sqrt(|det|). This is 1 for a pure translate and/or rotate
// (neither changes apparent size), sx for an isotropic scale(sx), and the
// geometric mean sqrt(sx*sy) for an anisotropic scale or a nested <svg>'s
// non-uniform viewBox-to-viewport remap - a single, well-defined scalar to
// multiply a font-size by so a shrunken nested chart is measured at its
// actually displayed size.
function accumulatedScale(matrix) {
  return Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));
}

// ---------------------------------------------------------------------------
// Minimal, deterministic SVG parsing. The XML tokenizer (parseXml) and the
// affine transform primitives (multiply/apply/ownTransformMatrix/IDENTITY)
// live in render_qa_svg.mjs, shared with render_qa_contrast.mjs. What is
// specific to this module: the font-size/weight/text-anchor CSS cascade
// (simpler than render_qa_contrast.mjs's - type/class/id selectors and plain
// presentation attributes only, no inline `style=""`, since no renderer in
// this codebase emits per-element `style=""`) and folding in a nested
// <svg>'s viewBox-to-viewport remap alongside its `transform` attribute.

const TEXT_BEARING = new Set(["text", "tspan"]);

// ---------------------------------------------------------------------------
// Data-mark geometry for text_crosses_data_mark (round-2 house-style fix:
// annotation text landing on top of the line/bar/dot it annotates). This
// module cannot classify "is this element a data mark" by colour alone
// (that would misfire on process-schematic boxes with text drawn on top of
// them on purpose, and on axis/gridlines) so it uses the same signal the
// renderers already emit for other purposes:
//   - <circle>, <polyline> and any non-<defs> <path>: always a data mark.
//     Exhaustively checked against this codebase's renderers: no <circle> or
//     <polyline> is ever purely decorative, and the only <path> elements
//     that are (arrow-marker glyphs) live inside <defs>, which is excluded
//     below.
//   - <rect> / <line>: only when explicitly tagged `data-role="data-..."`
//     (e.g. "data-bar", "data-line") by the renderer, since most rects/lines
//     in this codebase's SVG are backgrounds, cards, gridlines or reference
//     lines, not data marks - opt-in avoids false positives on those.
// Anything tagged with a role in DECORATION_ROLES is excluded even if it
// would otherwise qualify (a leader line is a <line data-role="...leader">
// - never a data mark, even though it points at one).
const DECORATION_ROLES = new Set([
  "annotation-leader",
  "direct-label-leader",
  "label-leader",
  "reference-line",
  "reference-line-label",
  "legend-swatch",
  // A numbered-marker badge (the crowding fallback for line-chart event
  // annotations): its own glyph is drawn centred inside it by design, so
  // this circle must not be treated as a data mark that glyph "crosses".
  "annotation-marker",
]);

// Container roles whose entire subtree is UI chrome (a legend key, an inset
// locator map), not data: any circle/rect/path/line inside one of these is
// excluded from text_crosses_data_mark regardless of its own tag or role,
// the same way <defs> is excluded - mirrors this codebase's own convention
// of tagging a wrapping <g data-role="..."> around a self-contained widget
// (see cartographic-direction-key, cartographic-locator in viz.mjs).
const DECORATION_CONTAINER_ROLES = new Set([
  "cartographic-direction-key",
  "cartographic-locator",
]);

// A choropleth numbered marker (the fallback for a country too small to
// label directly) draws its own number centred inside its circle by design.
// Only that exact pair is exempt from text_crosses_data_mark: the text's role
// must name the circle's role, its content must be the circle's data-number,
// and its box centre must sit inside the circle. The circle stays a data mark
// for every other text, so a country name or value landing on a marker still
// fails.
const MARKER_DIGIT_ROLES = new Map([
  ["choropleth-footnote-marker-label", "choropleth-footnote-marker"],
  ["choropleth-inset-footnote-marker-label", "choropleth-inset-footnote-marker"],
]);

function isOwnMarkerDigit(node, box, mark) {
  if (mark.kind !== "circle" || MARKER_DIGIT_ROLES.get(node.role) !== mark.role) return false;
  if (mark.number == null || String(node.text ?? "").trim() !== mark.number) return false;
  return Math.hypot(box.x + box.w / 2 - mark.cx, box.y + box.h / 2 - mark.cy) <= mark.r;
}

function isDataRole(role) {
  return typeof role === "string" && role.startsWith("data-");
}

// De Casteljau flattening for cubic/quadratic Beziers: enough steps to look
// smooth at chart scale without generating pathological point counts for
// generic curve support that must also cover a future monotone-cubic line.
const BEZIER_STEPS_CUBIC = 16;
const BEZIER_STEPS_QUAD = 12;

function cubicPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
  };
}
function quadPoint(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

// Tokenizes an SVG path `d` string into alternating command letters and
// numbers. Deliberately does not handle the "1.5.6" (two numbers glued
// without a separator between two decimal points) edge case: every renderer
// in this codebase emits explicit separators, and this is (like the rest of
// this module) a parser for what our own renderers produce, not a
// general-purpose SVG path parser.
function tokenizePathD(d) {
  const tokens = [];
  const re = /([MLHVCSQTAZmlhvcsqtaz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(String(d ?? "")))) {
    if (m[1]) tokens.push({ type: "cmd", value: m[1] });
    else tokens.push({ type: "num", value: parseFloat(m[2]) });
  }
  return tokens;
}

// Flattens an SVG path `d` string into an array of polylines (each an array
// of {x,y} points in the path's own local coordinate space), by walking its
// command list and sampling curves. Supports M/L/H/V/C/S/Q/T/Z (absolute and
// relative). `A` (elliptical arc) is approximated as a straight chord to its
// endpoint - documented, and conservative in the direction of under- rather
// than over-flagging an arc segment, since no renderer in this codebase
// currently emits `A`.
function flattenPathD(d) {
  const tokens = tokenizePathD(d);
  const polylines = [];
  let cur = { x: 0, y: 0 };
  let subStart = { x: 0, y: 0 };
  let curPoly = null;
  let prevCmd = null;
  let prevCtrl = null;
  let i = 0;

  function nums(count) {
    const out = [];
    for (let k = 0; k < count; k++) {
      if (i >= tokens.length || tokens[i].type !== "num") return null;
      out.push(tokens[i].value);
      i++;
    }
    return out;
  }
  function startPoly() {
    curPoly = [{ x: cur.x, y: cur.y }];
    polylines.push(curPoly);
  }
  function lineTo(p) {
    cur = p;
    curPoly.push({ x: p.x, y: p.y });
  }
  function cubicTo(c1, c2, end) {
    const p0 = cur;
    for (let s = 1; s <= BEZIER_STEPS_CUBIC; s++) curPoly.push(cubicPoint(p0, c1, c2, end, s / BEZIER_STEPS_CUBIC));
    cur = end;
  }
  function quadTo(c, end) {
    const p0 = cur;
    for (let s = 1; s <= BEZIER_STEPS_QUAD; s++) curPoly.push(quadPoint(p0, c, end, s / BEZIER_STEPS_QUAD));
    cur = end;
  }
  function toAbs(x, y, abs) {
    return abs ? { x, y } : { x: cur.x + x, y: cur.y + y };
  }

  while (i < tokens.length) {
    if (tokens[i].type !== "cmd") { i++; continue; }
    const raw = tokens[i].value;
    i++;
    const abs = raw === raw.toUpperCase();
    const cmd = raw.toUpperCase();
    switch (cmd) {
      case "M": {
        const first = nums(2);
        if (!first) { prevCmd = cmd; break; }
        cur = toAbs(first[0], first[1], abs);
        subStart = { ...cur };
        startPoly();
        while (i < tokens.length && tokens[i].type === "num") {
          const p = nums(2);
          if (!p) break;
          lineTo(toAbs(p[0], p[1], abs));
        }
        break;
      }
      case "L": {
        while (i < tokens.length && tokens[i].type === "num") {
          const p = nums(2);
          if (!p) break;
          lineTo(toAbs(p[0], p[1], abs));
        }
        break;
      }
      case "H": {
        while (i < tokens.length && tokens[i].type === "num") {
          const p = nums(1);
          if (!p) break;
          lineTo({ x: abs ? p[0] : cur.x + p[0], y: cur.y });
        }
        break;
      }
      case "V": {
        while (i < tokens.length && tokens[i].type === "num") {
          const p = nums(1);
          if (!p) break;
          lineTo({ x: cur.x, y: abs ? p[0] : cur.y + p[0] });
        }
        break;
      }
      case "C": {
        while (i < tokens.length && tokens[i].type === "num") {
          const p = nums(6);
          if (!p) break;
          const c1 = toAbs(p[0], p[1], abs), c2 = toAbs(p[2], p[3], abs), end = toAbs(p[4], p[5], abs);
          cubicTo(c1, c2, end);
          prevCtrl = c2;
        }
        break;
      }
      case "S": {
        while (i < tokens.length && tokens[i].type === "num") {
          const p = nums(4);
          if (!p) break;
          const c2 = toAbs(p[0], p[1], abs), end = toAbs(p[2], p[3], abs);
          const c1 = prevCmd && (prevCmd === "C" || prevCmd === "S") && prevCtrl ? { x: 2 * cur.x - prevCtrl.x, y: 2 * cur.y - prevCtrl.y } : { ...cur };
          cubicTo(c1, c2, end);
          prevCtrl = c2;
        }
        break;
      }
      case "Q": {
        while (i < tokens.length && tokens[i].type === "num") {
          const p = nums(4);
          if (!p) break;
          const c = toAbs(p[0], p[1], abs), end = toAbs(p[2], p[3], abs);
          quadTo(c, end);
          prevCtrl = c;
        }
        break;
      }
      case "T": {
        while (i < tokens.length && tokens[i].type === "num") {
          const p = nums(2);
          if (!p) break;
          const end = toAbs(p[0], p[1], abs);
          const c = prevCmd && (prevCmd === "Q" || prevCmd === "T") && prevCtrl ? { x: 2 * cur.x - prevCtrl.x, y: 2 * cur.y - prevCtrl.y } : { ...cur };
          quadTo(c, end);
          prevCtrl = c;
        }
        break;
      }
      case "A": {
        while (i < tokens.length && tokens[i].type === "num") {
          const p = nums(7);
          if (!p) break;
          lineTo(toAbs(p[5], p[6], abs));
        }
        break;
      }
      case "Z": {
        if (curPoly && subStart) lineTo({ x: subStart.x, y: subStart.y });
        cur = { ...subStart };
        break;
      }
      default:
        break;
    }
    prevCmd = cmd;
  }
  return polylines;
}

function parsePointsAttr(raw) {
  const nums = String(raw ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const points = [];
  for (let k = 0; k + 1 < nums.length; k += 2) {
    if (Number.isFinite(nums[k]) && Number.isFinite(nums[k + 1])) points.push({ x: nums[k], y: nums[k + 1] });
  }
  return points;
}

// Pulls the M/L (absolute-only) anchor points out of a leader <path>'s `d`
// string: exactly the restricted subset the old regex-based leader extractor
// supported, deliberately NOT the general M/L/H/V/C/S/Q/T/A/Z
// (absolute-and-relative) flattenPathD curve flattener used for data marks
// elsewhere in this module. A leader is always drawn as straight segments,
// never a curve (see the multi-segment "elbow leader" note on
// ruleLeaderCrossings below), and every leader path this codebase's own
// renderers emit (choropleth-leader) already fits this subset - this function
// keeps that scope exactly as narrow as before the T6a-style transform fix,
// so a leader path built from some other command (relative or curved) stays
// exactly as invisible to leader_crossing/leader_crosses_text as it was
// previously, rather than silently widening what counts as a leader.
function extractLeaderPathPoints(d) {
  const points = [];
  const re = /([ML])\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(String(d ?? "")))) points.push({ x: Number(m[2]), y: Number(m[3]) });
  return points;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Liang-Barsky segment-vs-axis-aligned-box clip test: true iff any point of
// the segment [x1,y1]-[x2,y2] (not the infinite line through it) lies inside
// (or on) `box`. Degenerate (zero-length) segments correctly reduce to a
// point-in-box test via the p===0 branch.
function segmentIntersectsBox(x1, y1, x2, y2, box) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - box.x, box.x + box.w - x1, y1 - box.y, box.y + box.h - y1];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) { if (q[k] < 0) return false; continue; }
    const r = q[k] / p[k];
    if (p[k] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

function circleIntersectsBox(cx, cy, r, box) {
  const nx = clamp(cx, box.x, box.x + box.w);
  const ny = clamp(cy, box.y, box.y + box.h);
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r + 1e-6;
}

function boxesIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function parseCssLength(raw) {
  if (raw === undefined || raw === null) return null;
  const m = /^(-?[\d.]+)\s*(px)?$/i.exec(String(raw).trim());
  return m ? Number(m[1]) : NaN; // NaN = present but in units we don't resolve (em, %, pt, ...)
}

function normalizeColor(raw) {
  if (raw === undefined || raw === null) return null;
  let v = String(raw).trim().toLowerCase();
  if (!v) return null;
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (shortHex) v = `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`;
  return v;
}

// Named-colour equivalence: the 16 CSS2 basic keywords plus 'orange' (the
// most common CSS3 addition in practice). Any other named colour (the CSS
// Color spec has 147) falls back to literal normalized-string comparison in
// sameColor() below - it will still match another occurrence of the exact
// same keyword, just not a hex/rgb() spelling of the same colour.
const NAMED_COLORS = Object.freeze({
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], lime: [0, 255, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], aqua: [0, 255, 255], cyan: [0, 255, 255],
  fuchsia: [255, 0, 255], magenta: [255, 0, 255], silver: [192, 192, 192],
  gray: [128, 128, 128], grey: [128, 128, 128], maroon: [128, 0, 0],
  olive: [128, 128, 0], green: [0, 128, 0], purple: [128, 0, 128],
  teal: [0, 128, 128], navy: [0, 0, 128], orange: [255, 165, 0],
});

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function parseColorChannel(raw) {
  const s = raw.trim();
  return s.endsWith("%") ? clampByte((parseFloat(s) / 100) * 255) : clampByte(parseFloat(s));
}

// Parses hex (#rgb, #rrggbb), rgb()/rgba() and the small named-colour table
// above into an [r,g,b] triple (0-255 each). Returns null for formats this
// module does not resolve structurally (currentColor, hsl(), a CSS
// variable, an unlisted named colour, or 'none'/'transparent'); callers fall
// back to a plain string comparison via sameColor() in that case, so an
// unresolved format still matches an identical literal spelling.
function parseColorRgb(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  if (!v || v === "none" || v === "transparent") return null;
  const longHex = /^#([0-9a-f]{6})$/.exec(v);
  if (longHex) return [longHex[1].slice(0, 2), longHex[1].slice(2, 4), longHex[1].slice(4, 6)].map((h) => parseInt(h, 16));
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (shortHex) return [shortHex[1], shortHex[2], shortHex[3]].map((h) => parseInt(h + h, 16));
  const rgbFn = /^rgba?\(\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*,\s*([\d.]+%?)\s*(?:,\s*[\d.]+\s*)?\)$/.exec(v);
  if (rgbFn) return [rgbFn[1], rgbFn[2], rgbFn[3]].map(parseColorChannel);
  if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, v)) return NAMED_COLORS[v];
  return null;
}

// True when two fill/stroke values are the same colour: structurally, via
// parseColorRgb, whenever both sides resolve to an RGB triple (so
// "rgb(51,78,172)" and "#334eac" compare equal); otherwise by literal
// normalized-string equality, which is the conservative fallback for a
// format neither side can be parsed into.
function sameColor(rawA, rgbA, rawB, rgbB) {
  if (rgbA && rgbB) return rgbA[0] === rgbB[0] && rgbA[1] === rgbB[1] && rgbA[2] === rgbB[2];
  return rawA === rawB;
}

function parseViewBox(raw) {
  if (!raw) return null;
  const nums = raw.trim().split(/[\s,]+/).map(Number);
  if (nums.length !== 4 || nums.some((v) => !Number.isFinite(v))) return null;
  const [minX, minY, width, height] = nums;
  return { minX, minY, width, height };
}

function parseWidthHeightFallback(attrs) {
  const w = attrs.width !== undefined ? parseCssLength(attrs.width) : NaN;
  const h = attrs.height !== undefined ? parseCssLength(attrs.height) : NaN;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { minX: 0, minY: 0, width: w, height: h };
}

// --- <style> extraction: simple type/class/id selectors only -------------
// (none of the current renderers emit a <style> block at all; this exists
// so the font-size floor check can honour one if a future renderer does.)
function extractStyleRules(svgText) {
  const rules = [];
  let order = 0;
  const strippedSvgText = svgText.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, body) => {
    const css = body.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const chunk of css.split("}")) {
      const brace = chunk.indexOf("{");
      if (brace === -1) continue;
      const selectorsRaw = chunk.slice(0, brace).trim();
      if (!selectorsRaw) continue;
      const decls = {};
      for (const part of chunk.slice(brace + 1).split(";")) {
        const colon = part.indexOf(":");
        if (colon === -1) continue;
        const prop = part.slice(0, colon).trim().toLowerCase();
        const val = part.slice(colon + 1).trim();
        if (prop) decls[prop] = val;
      }
      for (const rawSelector of selectorsRaw.split(",")) {
        const selector = rawSelector.trim();
        if (!selector) continue;
        if (selector.startsWith("#")) rules.push({ type: "id", value: selector.slice(1), decls, order: order++ });
        else if (selector.startsWith(".")) rules.push({ type: "class", value: selector.slice(1), decls, order: order++ });
        else rules.push({ type: "tag", value: selector.toLowerCase(), decls, order: order++ });
      }
    }
    return ""; // remove from the text the tree walker sees
  });
  return { rules, strippedSvgText };
}

const SPECIFICITY = { id: 3, class: 2, tag: 1 };

function resolveStyleDecls(rules, tag, id, classes) {
  if (!rules.length) return {};
  const matches = rules.filter(
    (r) => (r.type === "tag" && r.value === tag) || (r.type === "id" && id && r.value === id) || (r.type === "class" && classes.includes(r.value)),
  );
  matches.sort((a, b) => SPECIFICITY[a.type] - SPECIFICITY[b.type] || a.order - b.order);
  const decls = {};
  for (const r of matches) Object.assign(decls, r.decls); // higher specificity / later source wins per-property
  return decls;
}

function truncate(s, n = 60) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function fmt(n) {
  return Math.round(n * 100) / 100;
}

// Resolves a `preserveAspectRatio` attribute into an alignment keyword
// (default "xMidYMid" per the SVG spec when the attribute is absent or
// unparseable) and "meet" (default) or "slice".
function parsePreserveAspectRatio(raw) {
  const tokens = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.includes("none")) return { align: "none", meetOrSlice: "meet" };
  const meetOrSlice = tokens.includes("slice") ? "slice" : "meet";
  const align = tokens.find((t) => /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.test(t)) ?? "xMidYMid";
  return { align, meetOrSlice };
}

// The extra transform a nested (non-root) `<svg>` applies to its own
// children only: its `viewBox` (if any) is mapped onto the box its own
// `x`/`y`/`width`/`height` describe, honouring `preserveAspectRatio` (SVG's
// own algorithm: uniform scale = min/max of the two axis scales for
// "meet"/"slice", then align the leftover slack per the x/y keywords; "none"
// scales each axis independently to fit exactly). Returns null when the
// scale cannot be computed (missing/non-numeric/non-positive width, height,
// viewBox width or viewBox height) rather than guessing.
function computeViewBoxMatrix(attrs) {
  const x = attrs.x !== undefined ? parseFloat(attrs.x) : 0;
  const y = attrs.y !== undefined ? parseFloat(attrs.y) : 0;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const vb = parseViewBox(attrs.viewBox);
  if (!vb) return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }; // no viewBox: children share this coordinate system, offset only by x/y
  const w = attrs.width !== undefined ? parseCssLength(attrs.width) : NaN;
  const h = attrs.height !== undefined ? parseCssLength(attrs.height) : NaN;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || vb.width <= 0 || vb.height <= 0) return null;
  const { align, meetOrSlice } = parsePreserveAspectRatio(attrs.preserveAspectRatio);
  let sx = w / vb.width;
  let sy = h / vb.height;
  let offsetX = 0;
  let offsetY = 0;
  if (align !== "none") {
    const s = meetOrSlice === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = s;
    sy = s;
    const extraW = w - vb.width * s;
    const extraH = h - vb.height * s;
    const xAlign = align.slice(1, 4); // "Min" | "Mid" | "Max"
    const yAlign = align.slice(5, 8);
    offsetX = xAlign === "Mid" ? extraW / 2 : xAlign === "Max" ? extraW : 0;
    offsetY = yAlign === "Mid" ? extraH / 2 : yAlign === "Max" ? extraH : 0;
  }
  return { a: sx, b: 0, c: 0, d: sy, e: x + offsetX - vb.minX * sx, f: y + offsetY - vb.minY * sy };
}

function findOutermostSvg(node) {
  if (node.tag === "svg") return node;
  for (const child of node.children) {
    const found = findOutermostSvg(child);
    if (found) return found;
  }
  return null;
}

// data-role values this module treats as a "structural/annotation stroke"
// for the stroke_over_mark rule (opt-in, see checkSvgGeometry's
// checkStrokeZOrder option): a reference_line's dashed rule, a value-axis
// gridline, the zero/0-baseline, an annotation leader line, and a range
// bracket's stem. All five are meant to sit *behind* the data marks they
// pass near - see runtime/pi/viz.mjs's LAYERING_FIX comments.
const ANNOTATION_STROKE_ROLES = new Set([
  "reference-line",
  "grid-line",
  "zero-line",
  "annotation-leader",
  "range-bracket",
]);

function walkSvgTree(svgText, styleRules) {
  const texts = [];
  const rects = [];
  const marks = [];
  const lines = [];
  const circles = [];
  const leaders = [];
  const notes = [];
  let idSeq = 0;

  const docRoot = parseXml(svgText);
  const svgRoot = findOutermostSvg(docRoot);
  const viewBox = svgRoot ? (parseViewBox(svgRoot.attrs.viewBox) ?? parseWidthHeightFallback(svgRoot.attrs)) : null;

  function cascadeStyle(node, parent) {
    const attrs = node.attrs || {};
    const id = attrs.id || null;
    const classes = (attrs.class || "").split(/\s+/).filter(Boolean);
    const styleDecls = resolveStyleDecls(styleRules, node.tag, id, classes);
    const styleFontSize = styleDecls["font-size"] !== undefined ? parseCssLength(styleDecls["font-size"]) : null;
    const attrFontSize = attrs["font-size"] !== undefined ? parseCssLength(attrs["font-size"]) : null;
    const localFontSize = styleFontSize !== null && !Number.isNaN(styleFontSize) ? styleFontSize : attrFontSize !== null && !Number.isNaN(attrFontSize) ? attrFontSize : null;
    const localFontWeight = styleDecls["font-weight"] ?? attrs["font-weight"] ?? null;
    const localAnchor = styleDecls["text-anchor"] ?? attrs["text-anchor"] ?? null;
    return {
      fontSize: localFontSize !== null ? localFontSize : (parent.fontSize ?? UA_DEFAULT_FONT_SIZE),
      fontWeight: localFontWeight !== null ? localFontWeight : (parent.fontWeight ?? "normal"),
      textAnchor: localAnchor !== null ? localAnchor : (parent.textAnchor ?? "start"),
    };
  }

  // Resolves a <tspan>'s effective (x, y) the way a real SVG renderer
  // would: its own x/y attribute if present, else inherited from the
  // running cursor (the parent <text>'s own position, chained forward
  // through preceding sibling tspans) plus its own dx/dy offset. This
  // codebase's own multi-line text convention (every multi-line <text> -
  // annotations, direct-labels, wrapped titles) sets x on every line but
  // only ever sets y on the parent <text>, using dy="0"/dy="<lineHeight>"
  // on each <tspan> to advance the baseline - so a tspan legitimately has
  // no y attribute of its own, and treating that as "position unresolved"
  // (as this function used to) made every multi-line text invisible to
  // text_outside_viewbox/text_overlap/text_crosses_data_mark - including
  // the reported fertility-chart annotation text this rule exists to catch.
  function resolveTspanPosition(node, cursor) {
    const attrs = node.attrs || {};
    const ownX = attrs.x !== undefined ? parseFloat(attrs.x) : NaN;
    const ownY = attrs.y !== undefined ? parseFloat(attrs.y) : NaN;
    const dx = attrs.dx !== undefined ? parseFloat(attrs.dx) : 0;
    const dy = attrs.dy !== undefined ? parseFloat(attrs.dy) : 0;
    const cursorX = cursor && Number.isFinite(cursor.x) ? cursor.x : NaN;
    const cursorY = cursor && Number.isFinite(cursor.y) ? cursor.y : NaN;
    const x = Number.isFinite(ownX) ? ownX : (Number.isFinite(cursorX) ? cursorX + (Number.isFinite(dx) ? dx : 0) : NaN);
    const y = Number.isFinite(ownY) ? ownY : (Number.isFinite(cursorY) ? cursorY + (Number.isFinite(dy) ? dy : 0) : NaN);
    // A tspan with its own x is a new anchor point (a new "text chunk" in
    // SVG terms) - text-anchor centres/right-aligns around THIS x. A tspan
    // without one is mid-chunk UNLESS it is the first tspan to consume the
    // ancestor <text>'s own still-untouched position (cursor.fresh) - that
    // tspan is the chunk's true anchor-bearer, it just inherited the anchor
    // x from its parent <text> rather than declaring its own. Only a tspan
    // that inherits from a *preceding sibling's* post-render cursor (fresh
    // already spent) is a pure continuation. Callers need this distinction
    // because text-anchor must apply once per chunk, not once per tspan
    // (see estimateTextBox).
    const isChunkStart = Number.isFinite(ownX) || Boolean(cursor && cursor.fresh);
    return { x, y, isChunkStart };
  }

  function finalizeTextNode(node, style, matrix, elementId, ownPos) {
    const text = String(node.text ?? "").trim();
    if (!text) return;
    const hasPosition = !!ownPos && Number.isFinite(ownPos.x) && Number.isFinite(ownPos.y);
    const unresolved = matrix === null || !hasPosition;
    texts.push({
      id: elementId,
      tag: node.tag,
      text,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      textAnchor: style.textAnchor,
      x: hasPosition ? ownPos.x : null,
      y: hasPosition ? ownPos.y : null,
      matrix,
      unresolved,
      role: (node.attrs || {})["data-role"] ?? null,
      // <text> itself always starts a chunk; a tspan only does when it set
      // its own x (see resolveTspanPosition) - default true so a <text>
      // node (ownPos built inline in visit(), no isChunkStart field) still
      // gets real anchor centring, which is correct for the overwhelmingly
      // common single-chunk case.
      isChunkStart: ownPos?.isChunkStart ?? true,
    });
    if (matrix === null) {
      notes.push({ element: elementId, tag: node.tag, text: truncate(text), reason: `unresolved transform on <${node.tag}> or an ancestor element; text_outside_viewbox/text_overlap skipped for this element (font_below_floor still applies)` });
    } else if (!hasPosition) {
      notes.push({ element: elementId, tag: node.tag, text: truncate(text), reason: "missing or non-numeric x/y (and no resolvable inherited position); text_outside_viewbox/text_overlap skipped for this element (font_below_floor still applies)" });
    }
  }

  function recordRectNode(node, matrix, elementId, paintOrder) {
    const attrs = node.attrs || {};
    const w = attrs.width !== undefined ? parseFloat(attrs.width) : NaN;
    const h = attrs.height !== undefined ? parseFloat(attrs.height) : NaN;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return; // SVG spec: does not paint, nothing to check
    const x0 = parseFloat(attrs.x ?? "0");
    const y0 = parseFloat(attrs.y ?? "0");
    const validPosition = Number.isFinite(x0) && Number.isFinite(y0);
    const unresolved = matrix === null || !validPosition;
    const box = unresolved ? { x: null, y: null, w, h } : transformedBox({ x: x0, y: y0, w, h }, matrix);
    const fill = normalizeColor(attrs.fill);
    const fillOpacityRaw = attrs["fill-opacity"] !== undefined ? parseFloat(attrs["fill-opacity"]) : 1;
    const strokeRaw = attrs.stroke;
    rects.push({
      id: elementId,
      paintOrder,
      dataRole: attrs["data-role"] || null,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      fill,
      fillRgb: parseColorRgb(attrs.fill),
      fillOpacity: Number.isFinite(fillOpacityRaw) ? fillOpacityRaw : 1,
      stroke: normalizeColor(strokeRaw),
      strokeRgb: parseColorRgb(strokeRaw),
      strokeWidth: attrs["stroke-width"] !== undefined ? parseFloat(attrs["stroke-width"]) : strokeRaw ? 1 : 0,
      unresolved,
    });
    if (matrix === null) {
      notes.push({ element: elementId, tag: "rect", reason: "unresolved transform on this <rect> or an ancestor element; excluded from indistinct_adjacent_marks" });
    } else if (!validPosition) {
      notes.push({ element: elementId, tag: "rect", reason: "non-numeric x/y; excluded from indistinct_adjacent_marks" });
    }
  }

  function recordMarkNode(node, matrix, elementId) {
    const attrs = node.attrs || {};
    const role = attrs["data-role"];
    if (DECORATION_ROLES.has(role) || (typeof role === "string" && role.endsWith("-leader"))) return;
    if (matrix === null) {
      notes.push({ element: elementId, tag: node.tag, reason: `unresolved transform on this <${node.tag}> or an ancestor element; excluded from text_crosses_data_mark` });
      return;
    }
    if (node.tag === "circle") {
      const cx = parseFloat(attrs.cx ?? "0");
      const cy = parseFloat(attrs.cy ?? "0");
      const r = parseFloat(attrs.r ?? "0");
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || r <= 0) return;
      const center = apply(matrix, cx, cy);
      const scaledR = r * accumulatedScale(matrix);
      marks.push({ id: elementId, kind: "circle", cx: center.x, cy: center.y, r: scaledR, role: role ?? null, number: attrs["data-number"] ?? null });
      return;
    }
    if (node.tag === "polyline") {
      const pts = parsePointsAttr(attrs.points).map((p) => apply(matrix, p.x, p.y));
      if (pts.length >= 2) marks.push({ id: elementId, kind: "segments", points: pts });
      return;
    }
    if (node.tag === "path") {
      // A <path> only counts as a "line/curve" data mark - the thing text
      // must not cross - when it is explicitly unfilled (fill="none"): that
      // is this codebase's own convention for every stroked line/connector/
      // flow-ribbon path (verified by inspection: range-bracket, flow-link,
      // hierarchy-tree connectors, geo-flow, cartographic-flow,
      // parallel-ribbon, chord-ribbon/arc, process-edge all set
      // fill="none"), and it is exactly the generic signal a future
      // monotone-cubic line path would also use. A *filled* path (a
      // streamgraph band, a choropleth country region, a basemap fill) is an
      // area a label is normally placed inside, not a line a label must
      // avoid - conflating the two would make every choropleth/streamgraph
      // country-name or in-band label a false positive.
      if (normalizeColor(attrs.fill) !== "none") return;
      const polylines = flattenPathD(attrs.d);
      for (const poly of polylines) {
        const pts = poly.map((p) => apply(matrix, p.x, p.y));
        if (pts.length >= 2) marks.push({ id: elementId, kind: "segments", points: pts });
      }
      return;
    }
    if (node.tag === "line" && isDataRole(role)) {
      const x1 = parseFloat(attrs.x1 ?? "0"), y1 = parseFloat(attrs.y1 ?? "0");
      const x2 = parseFloat(attrs.x2 ?? "0"), y2 = parseFloat(attrs.y2 ?? "0");
      if (![x1, y1, x2, y2].every(Number.isFinite)) return;
      const p1 = apply(matrix, x1, y1), p2 = apply(matrix, x2, y2);
      marks.push({ id: elementId, kind: "segments", points: [p1, p2] });
      return;
    }
    if (node.tag === "rect" && isDataRole(role)) {
      const w = parseFloat(attrs.width ?? "0"), h = parseFloat(attrs.height ?? "0");
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
      const x0 = parseFloat(attrs.x ?? "0"), y0 = parseFloat(attrs.y ?? "0");
      if (!Number.isFinite(x0) || !Number.isFinite(y0)) return;
      const box = transformedBox({ x: x0, y: y0, w, h }, matrix);
      marks.push({ id: elementId, kind: "rect", box });
    }
  }

  // After a text-bearing node's *own* text run (not its descendants'), the
  // horizontal position a same-line, no-x sibling <tspan> should continue
  // from is the visual RIGHT edge of that run, not its x attribute. For a
  // start-anchored run like `<text x="20">100<tspan dx="7">PJ</tspan></text>`
  // (hero-stat's value+unit pattern) that edge is x+width. For a
  // middle-anchored run (this codebase's choropleth/waffle centred
  // value+period pattern, e.g. `<text x="M" text-anchor="middle">70%<tspan
  // dx="4">2022</tspan></text>`) the run is centred on x, so its right edge
  // is x+width/2. An end-anchored run already has its right edge AT x (it
  // grows leftward), so no advance is needed. Getting this wrong measured a
  // dx-chained unit/period only a few px after the number's start instead of
  // after its actual glyphs, producing a false text_overlap between a number
  // and its own unit/period label.
  function cursorAfterOwnText(node, style, ownPos) {
    if (!ownPos || !Number.isFinite(ownPos.x) || !Number.isFinite(ownPos.y)) return ownPos;
    const text = node.text ?? "";
    if (!text) return ownPos;
    const anchor = style.textAnchor === "middle" || style.textAnchor === "end" ? style.textAnchor : "start";
    if (anchor === "end") return ownPos;
    const width = estimateTextWidth(text, style.fontSize, isBold(style.fontWeight));
    return { x: ownPos.x + (anchor === "middle" ? width / 2 : width), y: ownPos.y };
  }

  // Records a <line> for the opt-in stroke_over_mark rule only: an
  // "annotation" line (its data-role is one of ANNOTATION_STROKE_ROLES) or a
  // "mark" line - a data line thick enough (>=2px) to read as a mark rather
  // than a hairline rule (e.g. a dumbbell's connector, stroke-width 3). Any
  // other <line> (a thin unrelated hairline) is ignored by both roles: it
  // cannot fail and cannot be crossed.
  function recordLineNode(node, matrix, elementId, paintOrder) {
    const attrs = node.attrs || {};
    const x1 = parseFloat(attrs.x1 ?? "0");
    const y1 = parseFloat(attrs.y1 ?? "0");
    const x2 = parseFloat(attrs.x2 ?? "0");
    const y2 = parseFloat(attrs.y2 ?? "0");
    const validPosition = [x1, y1, x2, y2].every(Number.isFinite);
    const unresolved = matrix === null || !validPosition;
    const dataRole = attrs["data-role"] || null;
    const strokeWidth = attrs["stroke-width"] !== undefined ? parseFloat(attrs["stroke-width"]) : 1;
    const isAnnotation = ANNOTATION_STROKE_ROLES.has(dataRole);
    const isMark = !isAnnotation && Number.isFinite(strokeWidth) && strokeWidth >= 2;
    if (!isAnnotation && !isMark) return; // not relevant to stroke_over_mark
    let p1 = null, p2 = null;
    if (!unresolved) {
      p1 = apply(matrix, x1, y1);
      p2 = apply(matrix, x2, y2);
    }
    lines.push({ id: elementId, paintOrder, dataRole, isAnnotation, isMark, p1, p2, unresolved });
  }

  // Records a <circle> for the opt-in stroke_over_mark rule only (a dot
  // chart's value marker). Its post-transform bounding square is used as a
  // conservative axis-aligned proxy for intersection testing.
  function recordCircleNode(node, matrix, elementId, paintOrder) {
    const attrs = node.attrs || {};
    const cx = parseFloat(attrs.cx ?? "0");
    const cy = parseFloat(attrs.cy ?? "0");
    const r = parseFloat(attrs.r ?? "0");
    const validPosition = [cx, cy, r].every(Number.isFinite) && r > 0;
    const fill = normalizeColor(attrs.fill);
    if (!validPosition || !fill || fill === "none") return;
    const unresolved = matrix === null;
    const box = unresolved ? null : transformedBox({ x: cx - r, y: cy - r, w: r * 2, h: r * 2 }, matrix);
    circles.push({ id: elementId, paintOrder, box, unresolved });
  }

  // Records a <line> or <path> tagged with a "*-leader" data-role suffix
  // (annotation-leader, label-leader, direct-label-leader, geo-label-leader,
  // cartographic-label-leader, choropleth-leader, or any future role sharing
  // the suffix - matched generically, same as recordMarkNode's own leader
  // exclusion above) for ruleLeaderCrossings, resolved through this same
  // accumulated `matrix` (nested <svg> viewBox matrix + <g>/element
  // `transform`) as every text/rect/line/mark this walk already records -
  // the fix for this rule's own T6a gap (see the module-level comment).
  // Mirrors extractLeaderSegments' old id scheme (`role#index`, index shared
  // across all leaders in the order they are actually recorded - i.e. real
  // document order now, not "all <line>s then all <path>s") so failure
  // messages stay comparably shaped; an element whose own coordinates don't
  // parse still consumes no index, exactly as before.
  function recordLeaderNode(node, matrix, elementId) {
    const attrs = node.attrs || {};
    const role = attrs["data-role"];
    if (typeof role !== "string" || !role.endsWith("-leader")) return;
    let localPoints = null;
    if (node.tag === "line") {
      const x1 = parseFloat(attrs.x1 ?? "0"), y1 = parseFloat(attrs.y1 ?? "0");
      const x2 = parseFloat(attrs.x2 ?? "0"), y2 = parseFloat(attrs.y2 ?? "0");
      if ([x1, y1, x2, y2].every(Number.isFinite)) localPoints = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
    } else if (node.tag === "path") {
      const pts = extractLeaderPathPoints(attrs.d);
      if (pts.length >= 2) localPoints = pts;
    }
    if (!localPoints) return; // no parseable geometry - nothing to record, same as before
    if (matrix === null) {
      notes.push({ element: elementId, tag: node.tag, reason: `unresolved transform on this <${node.tag}> or an ancestor element; excluded from leader_crossing/leader_crosses_text` });
      return;
    }
    const pagePoints = localPoints.map((p) => apply(matrix, p.x, p.y));
    const segments = [];
    for (let i = 0; i + 1 < pagePoints.length; i++) segments.push([pagePoints[i], pagePoints[i + 1]]);
    leaders.push({ id: `${role}#${leaders.length}`, segments });
  }

  // `textCursor` threads the running (x, y) position a <tspan> without its
  // own x/y should inherit: seeded from the nearest ancestor <text>'s own
  // position, then advanced to each tspan's own resolved position (plus its
  // own text's width, for a same-line dx continuation) as its siblings are
  // visited in document order (see resolveTspanPosition, cursorAfterOwnText).
  function visit(node, parentStyle, parentMatrix, insideDefs, insideDecoration, textCursor) {
    const paintOrder = idSeq++;
    const elementId = `${node.tag}#${paintOrder}`;
    const style = cascadeStyle(node, parentStyle);
    const ownMatrix = parentMatrix === null ? null : ownTransformMatrix(node);
    const selfMatrix = parentMatrix === null || ownMatrix === null ? null : multiply(ownMatrix, parentMatrix);
    const childInsideDefs = insideDefs || node.tag === "defs";
    const childInsideDecoration = insideDecoration || DECORATION_CONTAINER_ROLES.has((node.attrs || {})["data-role"]);

    let ownPos = null;
    if (node.tag === "text") {
      const attrs = node.attrs || {};
      const ownX = attrs.x !== undefined ? parseFloat(attrs.x) : NaN;
      const ownY = attrs.y !== undefined ? parseFloat(attrs.y) : NaN;
      ownPos = { x: ownX, y: ownY };
    } else if (node.tag === "tspan") {
      ownPos = resolveTspanPosition(node, textCursor);
    }

    if (TEXT_BEARING.has(node.tag)) finalizeTextNode(node, style, selfMatrix, elementId, ownPos);
    if (node.tag === "rect") recordRectNode(node, selfMatrix, elementId, paintOrder);
    if (node.tag === "line") recordLineNode(node, selfMatrix, elementId, paintOrder);
    if (node.tag === "circle") recordCircleNode(node, selfMatrix, elementId, paintOrder);
    // Leaders are recorded regardless of insideDefs/insideDecoration, matching
    // extractLeaderSegments' old scope: it regexed the whole document text, so
    // a leader nested under a decoration-container role was never excluded.
    if (node.tag === "line" || node.tag === "path") recordLeaderNode(node, selfMatrix, elementId);
    if (!insideDefs && !insideDecoration && (node.tag === "circle" || node.tag === "polyline" || node.tag === "path" || node.tag === "line" || node.tag === "rect")) {
      recordMarkNode(node, selfMatrix, elementId);
    }

    let childMatrix = selfMatrix;
    if (node.tag === "svg" && node !== svgRoot) {
      if (selfMatrix === null) {
        childMatrix = null;
      } else {
        const vbMatrix = computeViewBoxMatrix(node.attrs || {});
        if (vbMatrix === null) {
          childMatrix = null;
          notes.push({ element: elementId, tag: "svg", reason: "nested <svg>'s viewBox/width/height could not be resolved into a scale; its content is excluded from text_outside_viewbox/text_overlap (font_below_floor still applies at the unscaled font-size)" });
        } else {
          childMatrix = multiply(vbMatrix, selfMatrix);
        }
      }
    }
    const ownEndCursor = TEXT_BEARING.has(node.tag) ? cursorAfterOwnText(node, style, ownPos) : textCursor;
    // The cursor handed to this node's *first* child is "fresh" only when
    // nothing has rendered under this node yet: either this node is the
    // <text> element itself (its own x/y hasn't been consumed by any tspan
    // yet), or this node is a tspan that just established a fresh anchor of
    // its own (ownPos.isChunkStart) - fresh in that case is transitive to
    // its own not-yet-rendered children. Once any child actually renders,
    // later siblings inherit a *spent* cursor (fresh: false): they continue
    // the glyph run, they don't re-anchor it (see resolveTspanPosition).
    const startsFreshChunk = node.tag === "text" || (ownPos && ownPos.isChunkStart);
    let runningCursor = ownEndCursor ? { ...ownEndCursor, fresh: startsFreshChunk } : ownEndCursor;
    for (const child of node.children) {
      const childPos = visit(child, style, childMatrix, childInsideDefs, childInsideDecoration, runningCursor);
      if (childPos && (Number.isFinite(childPos.x) || Number.isFinite(childPos.y))) runningCursor = { ...childPos, fresh: false };
    }
    // Hand the caller (this node's *parent*, iterating its own children in
    // document order) the position a same-line sibling should continue from:
    // this node's own text advances the cursor (cursorAfterOwnText above);
    // if this node instead had element children (e.g. a <text> whose value
    // and unit both live in child <tspan>s, own text ""), the last child's
    // resolved end position is the more accurate continuation point.
    return runningCursor !== ownEndCursor ? runningCursor : ownEndCursor;
  }

  const rootStyle = { fontSize: null, fontWeight: null, textAnchor: null };
  for (const child of docRoot.children) visit(child, rootStyle, IDENTITY, false, false, null);

  return { texts, rects, marks, lines, circles, leaders, notes, viewBox };
}

// ---------------------------------------------------------------------------
// Rules

function ruleTextOutsideViewbox(texts, viewBox, options) {
  if (!viewBox) return [];
  const tol = options.viewboxTolerance;
  const minX = viewBox.minX - tol;
  const minY = viewBox.minY - tol;
  const maxX = viewBox.minX + viewBox.width + tol;
  const maxY = viewBox.minY + viewBox.height + tol;
  const failures = [];
  for (const node of texts) {
    if (node.unresolved) continue;
    const box = estimateDisplayBox(node);
    if (box.x < minX || box.y < minY || box.x + box.w > maxX || box.y + box.h > maxY) {
      failures.push({
        rule: "text_outside_viewbox",
        message: `text "${truncate(node.text)}" estimated box [${fmt(box.x)}, ${fmt(box.y)}, ${fmt(box.x + box.w)}, ${fmt(box.y + box.h)}] falls outside viewBox [${viewBox.minX}, ${viewBox.minY}, ${fmt(viewBox.minX + viewBox.width)}, ${fmt(viewBox.minY + viewBox.height)}]`,
        element: node.id,
        bbox: box,
      });
    }
  }
  return failures;
}

function ruleTextOverlap(texts, options) {
  const tol = options.textOverlapTolerance;
  const measurable = texts.filter((t) => !t.unresolved).map((t) => ({ node: t, box: estimateDisplayBox(t) }));
  const failures = [];
  for (let i = 0; i < measurable.length; i++) {
    for (let j = i + 1; j < measurable.length; j++) {
      const a = measurable[i];
      const b = measurable[j];
      const iw = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
      const ih = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y);
      if (iw > tol && ih > tol) {
        failures.push({
          rule: "text_overlap",
          message: `text "${truncate(a.node.text)}" overlaps "${truncate(b.node.text)}" by ~${fmt(iw)}x${fmt(ih)}px`,
          element: `${a.node.id}+${b.node.id}`,
          bbox: { x: Math.max(a.box.x, b.box.x), y: Math.max(a.box.y, b.box.y), w: iw, h: ih },
        });
      }
    }
  }
  return failures;
}

function ruleFontBelowFloor(texts, options) {
  const floor = options.minFontSize;
  const failures = [];
  for (const node of texts) {
    const scale = node.matrix ? accumulatedScale(node.matrix) : 1;
    const effectiveFontSize = node.fontSize * scale * options.displayScale;
    if (effectiveFontSize < floor - 1e-9) {
      failures.push({
        rule: "font_below_floor",
        message: `text "${truncate(node.text)}" renders at font-size ${fmt(effectiveFontSize)}, below the ${floor}px floor`,
        element: node.id,
        bbox: node.unresolved ? null : estimateDisplayBox(node),
      });
    }
  }
  return failures;
}

function edgeAdjacency(a, b, minSharedEdge) {
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const candidates = [];
  if (yOverlap >= minSharedEdge) candidates.push({ axis: "x", gap: a.x <= b.x ? b.x - (a.x + a.w) : a.x - (b.x + b.w) });
  if (xOverlap >= minSharedEdge) candidates.push({ axis: "y", gap: a.y <= b.y ? b.y - (a.y + a.h) : a.y - (b.y + b.h) });
  if (!candidates.length) return null;
  return candidates.reduce((best, c) => (best === null || c.gap < best.gap ? c : best), null);
}

// Flags only rects whose facing edges actually *coincide* - a small overlap
// (rendering slop) through a small gap, both within tolerance of zero. Two
// other shapes that share a fill are deliberately NOT flagged:
//   - Rects that overlap by more than options.overlapTolerance are one
//     shape merged on purpose (e.g. a hero illustration built from stacked
//     same-colour rects), not a chart's adjacent data segments.
//   - Rects whose fill matches options.pageBackground (default white) are
//     page or panel background plates, not competing marks; they are
//     excluded from the candidate pool entirely, regardless of geometry, so
//     white-on-white panel seams never fire this rule.
// The real defect this rule exists to catch (trial-03: same-fill chart
// segments touching edge to edge with a gap of exactly 0) sits well inside
// both windows and is unaffected by either exclusion.
function ruleIndistinctAdjacentMarks(rects, options) {
  const bgRgb = parseColorRgb(options.pageBackground);
  const bgNorm = normalizeColor(options.pageBackground);
  const isBackground = (r) => sameColor(r.fill, r.fillRgb, bgNorm, bgRgb);
  const measurable = rects.filter((r) => !r.unresolved && r.fill && r.fill !== "none" && r.fillOpacity > options.minFillOpacity && !isBackground(r));
  const failures = [];
  for (let i = 0; i < measurable.length; i++) {
    for (let j = i + 1; j < measurable.length; j++) {
      const a = measurable[i];
      const b = measurable[j];
      if (!sameColor(a.fill, a.fillRgb, b.fill, b.fillRgb)) continue; // different fills always pass
      const edge = edgeAdjacency(a, b, options.minSharedEdge);
      if (!edge) continue;
      if (edge.gap < -options.overlapTolerance || edge.gap >= options.edgeGapTolerance) continue; // a deep overlap or a real gap always passes
      const hasContrastStroke = [a, b].some((r) => r.stroke && r.stroke !== "none" && r.strokeWidth > 0 && !sameColor(r.stroke, r.strokeRgb, a.fill, a.fillRgb));
      if (hasContrastStroke) continue; // a contrasting stroke always passes
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      failures.push({
        rule: "indistinct_adjacent_marks",
        message: `rects ${a.id} and ${b.id} share fill ${a.fill} with a ${fmt(edge.gap)}px gap on the ${edge.axis} axis and no contrasting stroke; they will read as one shape`,
        element: `${a.id}+${b.id}`,
        bbox: { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y },
      });
    }
  }
  return failures;
}

// text bounding boxes must not intersect a data mark (a line/curve it
// annotates, a bar, a dot): the round-2 house-style fix for annotation text
// that lands on top of the data it labels. Strict, no exemptions/options to
// disable it - a rendered chart either keeps its text clear of its own data
// marks or it does not pass. Marks are pre-resolved into display coordinates
// by walkSvgTree/recordMarkNode above (generic to curves: a `<path>` is
// sampled along its actual flattened geometry, not assumed to be straight
// segments, so this also covers a monotone-cubic line renderer).
function ruleTextCrossesDataMark(texts, marks) {
  const failures = [];
  const measurable = texts.filter((t) => !t.unresolved).map((t) => ({ node: t, box: estimateDisplayBox(t) }));
  for (const { node, box } of measurable) {
    for (const mark of marks) {
      if (isOwnMarkerDigit(node, box, mark)) continue;
      let hit = false;
      if (mark.kind === "circle") {
        hit = circleIntersectsBox(mark.cx, mark.cy, mark.r, box);
      } else if (mark.kind === "rect") {
        hit = boxesIntersect(box, mark.box);
      } else if (mark.kind === "segments") {
        for (let k = 0; k + 1 < mark.points.length && !hit; k++) {
          const a = mark.points[k], b = mark.points[k + 1];
          if (segmentIntersectsBox(a.x, a.y, b.x, b.y, box)) hit = true;
        }
      }
      if (hit) {
        failures.push({
          rule: "text_crosses_data_mark",
          message: `text "${truncate(node.text)}" estimated box [${fmt(box.x)}, ${fmt(box.y)}, ${fmt(box.x + box.w)}, ${fmt(box.y + box.h)}] intersects data mark ${mark.id}`,
          element: `${node.id}+${mark.id}`,
          bbox: box,
        });
        break; // one failure per text node is enough to fail the render; keep the list readable
      }
    }
  }
  return failures;
}

// Opt-in (see checkSvgGeometry's checkStrokeZOrder option): fails when a
// structural/annotation stroke - a reference_line's dashed rule, a
// value-axis gridline, the zero/0-baseline, an annotation leader, or a range
// bracket stem (ANNOTATION_STROKE_ROLES) - is painted *after*, and visibly
// crosses, a data mark (a filled rect/circle, or another thick "mark" line
// such as a dumbbell connector). SVG paints in document order, so a later
// paintOrder means "on top" - exactly the defect this rule exists to catch:
// a dashed reference line or a solid axis/grid stroke sliced visibly across
// a bar, dot or connector instead of running behind it.
function ruleStrokeOverMark(lines, rects, circles, options) {
  const bgRgb = parseColorRgb(options.pageBackground);
  const bgNorm = normalizeColor(options.pageBackground);
  const isBackground = (r) => sameColor(r.fill, r.fillRgb, bgNorm, bgRgb);
  const markRects = rects.filter((r) => !r.unresolved && r.fill && r.fill !== "none" && r.fillOpacity > options.minFillOpacity && !isBackground(r));
  const markCircles = circles.filter((c) => !c.unresolved);
  const markLines = lines.filter((l) => l.isMark && !l.unresolved);
  const annotationLines = lines.filter((l) => l.isAnnotation && !l.unresolved);

  const failures = [];
  for (const line of annotationLines) {
    for (const rect of markRects) {
      if (line.paintOrder <= rect.paintOrder) continue; // painted first (or same) - the mark, if anything, covers it
      const box = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      if (!segmentIntersectsBox(line.p1.x, line.p1.y, line.p2.x, line.p2.y, box)) continue;
      failures.push({
        rule: "stroke_over_mark",
        message: `${line.dataRole ?? "line"} (${line.id}) is painted after data mark ${rect.id} and visibly crosses it; move it behind the mark or add a knockout gap`,
        element: `${line.id}+${rect.id}`,
        bbox: box,
      });
    }
    for (const circle of markCircles) {
      if (line.paintOrder <= circle.paintOrder) continue;
      if (!segmentIntersectsBox(line.p1.x, line.p1.y, line.p2.x, line.p2.y, circle.box)) continue;
      failures.push({
        rule: "stroke_over_mark",
        message: `${line.dataRole ?? "line"} (${line.id}) is painted after data mark ${circle.id} and visibly crosses it; move it behind the mark or add a knockout gap`,
        element: `${line.id}+${circle.id}`,
        bbox: circle.box,
      });
    }
    for (const mark of markLines) {
      if (line.paintOrder <= mark.paintOrder) continue;
      const minX = Math.min(mark.p1.x, mark.p2.x), maxX = Math.max(mark.p1.x, mark.p2.x);
      const minY = Math.min(mark.p1.y, mark.p2.y), maxY = Math.max(mark.p1.y, mark.p2.y);
      const box = { x: minX, y: minY, w: Math.max(maxX - minX, 0.01), h: Math.max(maxY - minY, 0.01) };
      if (!segmentIntersectsBox(line.p1.x, line.p1.y, line.p2.x, line.p2.y, box)) continue;
      failures.push({
        rule: "stroke_over_mark",
        message: `${line.dataRole ?? "line"} (${line.id}) is painted after data mark ${mark.id} and visibly crosses it; move it behind the mark or add a knockout gap`,
        element: `${line.id}+${mark.id}`,
        bbox: box,
      });
    }
  }
  return failures;
}

// Task B render-QA (line-chart axis honesty): renderLine/renderMobileLine now
// tag their y-axis gridlines data-role="value-axis-tick", their series
// paths data-role="line-path" (a <polyline> or a monotone <path>), and their
// markers data-role="line-point". This rule is purely additive - it only
// runs at all when at least one value-axis-tick element is present, so every
// other chart type (and every SVG that predates this rule) is unaffected -
// and re-derives the tick-bracketed y-range from those tags with a small,
// tag-scoped regex extraction rather than the full transform-resolving
// tree-walker above, since line-chart marks in this renderer are never
// nested inside a transformed group.
function extractTaggedElements(svgText, tag, role) {
  const re = new RegExp(`<${tag}\\b[^>]*data-role="${role}"[^>]*/?>`, "g");
  const out = [];
  let match;
  while ((match = re.exec(svgText))) out.push(match[0]);
  return out;
}

function attr(tagText, name) {
  const match = tagText.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

// Pulls the true anchor-point y-coordinates out of an SVG path `d` string
// built by monotoneCubicPath (an initial M, then a run of cubic C segments
// each ending at its own data point) - i.e. the M point and each C command's
// *final* coordinate pair, skipping the two control points in between so a
// bezier bulge's control handles (which may legitimately swing outside the
// domain for a short stretch) are never mistaken for a plotted observation.
function pathDataPointYs(d) {
  const commands = String(d ?? "").match(/[ML][^MLC]*|C[^MLC]*/g) ?? [];
  const ys = [];
  for (const cmd of commands) {
    const nums = cmd.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd[0] === "C") {
      if (nums.length >= 6) ys.push(nums[5]);
    } else if (nums.length >= 2) {
      ys.push(nums[1]);
    }
  }
  return ys;
}

function ruleValueAxisDomainBracket(svgText, options) {
  const ticks = extractTaggedElements(svgText, "line", "value-axis-tick");
  if (!ticks.length) return [];
  const tickYs = ticks.map((t) => Number(attr(t, "y1"))).filter((y) => Number.isFinite(y));
  if (!tickYs.length) return [];
  const tol = options.axisBracketTolerance;
  const lo = Math.min(...tickYs) - tol;
  const hi = Math.max(...tickYs) + tol;
  const failures = [];
  const flag = (id, y) => {
    if (y < lo || y > hi) {
      failures.push({
        rule: "value_axis_domain_bracket",
        message: `plotted point on ${id} at y=${fmt(y)} falls outside the tick-bracketed axis range [${fmt(lo)}, ${fmt(hi)}]`,
        element: id,
        bbox: null,
      });
    }
  };
  for (const el of extractTaggedElements(svgText, "circle", "line-point")) {
    const cy = Number(attr(el, "cy"));
    if (Number.isFinite(cy)) flag("line-point", cy);
  }
  for (const el of extractTaggedElements(svgText, "polyline", "line-path")) {
    const points = (attr(el, "points") ?? "").trim().split(/\s+/).filter(Boolean);
    for (const p of points) {
      const y = Number(p.split(",")[1]);
      if (Number.isFinite(y)) flag("line-path", y);
    }
  }
  for (const el of extractTaggedElements(svgText, "path", "line-path")) {
    for (const y of pathDataPointYs(attr(el, "d"))) flag("line-path", y);
  }
  return failures;
}

// Two leader lines (a data point's thin connector to its own label) must
// never cross each other, and a leader must never cross through any
// annotation text - either reads as the wrong point matched to the wrong
// label. An "elbow" leader - a single leader's path bending once or more
// to route around an obstacle - is fine; only crossings BETWEEN two
// different leaders, or a leader crossing a text box, are flagged. This is
// generic across every current *-leader data-role (annotation-leader,
// label-leader, direct-label-leader, geo-label-leader,
// cartographic-label-leader, choropleth-leader) and any future one, since
// it matches on the "-leader" suffix rather than an explicit role list -
// both straight <line> leaders and multi-segment elbow <path> leaders
// (M/L commands only; a leader is always drawn as straight segments, never
// a curve) are collected the same way, by recordLeaderNode during the
// walkSvgTree pass above (not a separate regex pass over the raw SVG text -
// see the module-level leader-transform-fix comment), so every leader point
// below already sits in the same page-space frame as the `texts` this rule
// compares it against.

function cross2(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function onSegment(a, b, p) {
  return (
    Math.min(a.x, b.x) - 1e-6 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-6 &&
    Math.min(a.y, b.y) - 1e-6 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-6
  );
}

// Proper segment-segment crossing test (Cormen et al.): true for a genuine
// transversal crossing, and also for a collinear/endpoint touch that lies
// within the other segment's span. Callers exclude a shared endpoint
// themselves (see sharesEndpoint) since two leaders legitimately meeting at
// the same anchor point is a junction, not a crossing.
function segmentsCross(a1, a2, b1, b2) {
  const d1 = cross2(b1, b2, a1);
  const d2 = cross2(b1, b2, a2);
  const d3 = cross2(a1, a2, b1);
  const d4 = cross2(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSegment(b1, b2, a1)) return true;
  if (d2 === 0 && onSegment(b1, b2, a2)) return true;
  if (d3 === 0 && onSegment(a1, a2, b1)) return true;
  if (d4 === 0 && onSegment(a1, a2, b2)) return true;
  return false;
}

function sharesEndpoint(a1, a2, b1, b2) {
  const same = (p, q) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
  return same(a1, b1) || same(a1, b2) || same(a2, b1) || same(a2, b2);
}

function ruleLeaderCrossings(leaders, texts) {
  const failures = [];
  for (let i = 0; i < leaders.length; i++) {
    for (let j = i + 1; j < leaders.length; j++) {
      for (const [a1, a2] of leaders[i].segments) {
        for (const [b1, b2] of leaders[j].segments) {
          if (sharesEndpoint(a1, a2, b1, b2)) continue;
          if (segmentsCross(a1, a2, b1, b2)) {
            failures.push({
              rule: "leader_crossing",
              message: `leader ${leaders[i].id} crosses leader ${leaders[j].id}`,
              element: `${leaders[i].id}+${leaders[j].id}`,
              bbox: null,
            });
          }
        }
      }
    }
  }
  // `anchor` is the text's own (pre-offset) position resolved into page
  // space (matrix guaranteed non-null here since unresolved texts were
  // already filtered out) - NOT node.x/node.y, which are local to whatever
  // frame that text was declared in. `p1`/`p2` below are leader endpoints
  // already in page space (recordLeaderNode), so the marker-badge exemption
  // must compare page-space to page-space; comparing node.x (local) against
  // p1.x (page space) would be comparing two different frames whenever the
  // text sits inside a scaled/nested <svg> or a <g transform>.
  const measurableTexts = texts
    .filter((t) => !t.unresolved)
    .map((t) => ({ node: t, box: estimateDisplayBox(t), anchor: apply(t.matrix, t.x, t.y) }));
  for (const leader of leaders) {
    for (const [p1, p2] of leader.segments) {
      const vertical = Math.abs(p1.x - p2.x) < 0.5;
      for (const { node, box, anchor } of measurableTexts) {
        if (!segmentIntersectsBox(p1.x, p1.y, p2.x, p2.y, box)) continue;
        // A numbered marker badge (drawMarkerBadge's own digit, tagged
        // "annotation-marker-label") is deliberately stacked coaxially on
        // its group's shared vertical guide when two or more annotations
        // share one data point - every badge in that stack, and every
        // leader that reaches past it to a badge further out, shares the
        // same x. That is an intentional, unambiguous "these all point to
        // one spot" design (each badge's own number still keys it to its
        // own caption line below), not a wrong-point-to-wrong-label
        // crossing, so it is exempt here. Any OTHER text - a real
        // annotation caption, an axis label, a direct data label - still
        // fails the instant a leader crosses it, on this or any other axis.
        if (node.role === "annotation-marker-label" && vertical && Math.abs(anchor.x - p1.x) < 2) continue;
        failures.push({
          rule: "leader_crosses_text",
          message: `leader ${leader.id} crosses text "${truncate(node.text)}"`,
          element: `${leader.id}+${node.id}`,
          bbox: box,
        });
      }
    }
  }
  return failures;
}

/**
 * Pure, deterministic geometry check over a rendered SVG string. No DOM, no
 * browser, no network, no model or provider calls: same input always
 * produces the same output.
 *
 * @param {string} svgText - a full `<svg ...>...</svg>` document.
 * @param {object} [options]
 * @param {number} [options.minFontSize=12] - font_below_floor threshold.
 * @param {number} [options.viewboxTolerance=0.5] - px slack for text_outside_viewbox.
 * @param {number} [options.textOverlapTolerance=1] - px the intersection must exceed on both axes for text_overlap.
 * @param {number} [options.edgeGapTolerance=1] - px: a gap below this (and at or above -overlapTolerance) counts as "touching" for indistinct_adjacent_marks.
 * @param {number} [options.overlapTolerance=0.5] - px: rects overlapping by more than this are one shape on purpose, not adjacent segments, for indistinct_adjacent_marks.
 * @param {number} [options.minSharedEdge=2] - px of perpendicular overlap required to call two rects "along a shared edge".
 * @param {number} [options.minFillOpacity=0.05] - rects this transparent or more are ignored as invisible.
 * @param {string} [options.pageBackground='#ffffff'] - rects this colour are treated as background plates/panels, not marks, for indistinct_adjacent_marks.
 * @param {number} [options.displayScale=1] - root display width / viewBox width; font_below_floor only, compares the displayed (not native viewBox-unit) font size against minFontSize.
 * @param {boolean} [options.checkStrokeZOrder=false] - opt-in stroke_over_mark rule: fails when a reference-line/grid-line/zero-line/annotation-leader/range-bracket stroke is painted after, and visibly crosses, a data mark (rect, circle, or a thick "mark" line). Off by default so existing callers/snapshots are unaffected; enable it explicitly to check the LAYERING_FIX draw order in runtime/pi/viz.mjs.
 * @returns {{version:string, passed:boolean, failures:Array<{rule:string,message:string,element:string,bbox:object|null}>, notes:Array<object>, summary:object}}
 */
export function checkSvgGeometry(svgText, options = {}) {
  const text = String(svgText ?? "");
  if (!text.includes("<svg")) throw new Error("checkSvgGeometry: input does not look like SVG (missing <svg)");
  const opts = { ...DEFAULT_OPTIONS, checkStrokeZOrder: false, ...options };

  const { rules: styleRules, strippedSvgText } = extractStyleRules(text);
  const { texts, rects, marks, lines, circles, leaders, notes, viewBox } = walkSvgTree(strippedSvgText, styleRules);
  if (!viewBox) notes.push({ element: "svg", reason: "no parsable viewBox (and no numeric width/height fallback) on the root <svg>; text_outside_viewbox skipped entirely" });

  const failures = [
    ...ruleTextOutsideViewbox(texts, viewBox, opts),
    ...ruleTextOverlap(texts, opts),
    ...ruleFontBelowFloor(texts, opts),
    ...ruleIndistinctAdjacentMarks(rects, opts),
    ...ruleTextCrossesDataMark(texts, marks),
    ...(opts.checkStrokeZOrder ? ruleStrokeOverMark(lines, rects, circles, opts) : []),
    ...ruleValueAxisDomainBracket(text, opts),
    ...ruleLeaderCrossings(leaders, texts),
  ];

  const failuresByRule = {};
  for (const f of failures) failuresByRule[f.rule] = (failuresByRule[f.rule] ?? 0) + 1;

  return {
    version: RENDER_QA_GEOMETRY_VERSION,
    passed: failures.length === 0,
    failures,
    notes,
    summary: {
      texts_checked: texts.length,
      rects_checked: rects.length,
      marks_checked: marks.length,
      texts_unmeasured: texts.filter((t) => t.unresolved).length,
      rects_unmeasured: rects.filter((r) => r.unresolved).length,
      failures_by_rule: failuresByRule,
    },
  };
}
