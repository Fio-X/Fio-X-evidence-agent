#!/usr/bin/env node
// Covers the range_bracket viz-spec annotation end to end (validateVizSpec
// shape checks, lintVizSpec chart-type/domain/count/overlap blockers, the
// renderer's reserved-right-margin bracket+label draw and its interaction
// with category_names) plus CJK widow control in wrapText, the other
// reader-facing fix landed alongside it.
import assert from "node:assert/strict";
import { validateVizSpec, lintVizSpec, renderVizSvg, wrapText } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const BASE = {
  schema_version: "0.7.0",
  reader_task: "ranking",
  verification_mode: "draft", // no claim store in this standalone test; annotations only require claim_id outside draft mode
  takeaway: "Eight economies draw at least 70% of final energy consumption from renewables.",
  title: "Renewable energy share, selected economies",
  alt: "Horizontal bar chart ranking ten economies by renewable energy consumption share.",
  source_note: "World Bank",
  claim_id: "range-bracket-claim",
  sql: "SELECT 1",
  unit: "%",
  direct_labels: true,
  annotations: [],
  highlight_values: [],
  category_field: "country",
  value_field: "pct",
};

// Ten real World Bank English country names (never translated by this
// test - the model must always pass these through verbatim), sorted here
// by descending pct like the renderer's own default row order.
const ROWS = [
  { country: "Congo, Dem. Rep.", pct: 96 },
  { country: "Liberia", pct: 94 },
  { country: "Zambia", pct: 89 },
  { country: "Nigeria", pct: 84 },
  { country: "Niger", pct: 79 },
  { country: "Sierra Leone", pct: 76 },
  { country: "Congo, Rep.", pct: 72 },
  { country: "Chad", pct: 71 },
  { country: "Ghana", pct: 45 },
  { country: "Kenya", pct: 38 },
];

function spec(overrides = {}) {
  return { ...BASE, chart_type: "horizontal_bar", ...overrides };
}
function bracket(overrides = {}) {
  return { type: "range_bracket", match_field: "country", match_value: "Congo, Dem. Rep.", end_match_value: "Chad", text: "8 countries draw at least 70%", ...overrides };
}
function rangeBracketBlockers(theSpec, rows = ROWS) {
  return lintVizSpec(theSpec, rows, {}).blockers.filter((b) => b.includes("range_bracket"));
}
function qaFailures(qa) {
  return qa.viewports.desktop.geometry.failures.concat(qa.viewports.desktop.contrast.failures);
}

// -- validateVizSpec: shape --
assert.deepEqual(
  validateVizSpec(spec({ annotations: [{ type: "range_bracket", match_field: "country", match_value: "Chad", text: "x" }] })),
  ["annotations[0] range_bracket requires match_field, match_value and end_match_value"],
);
assert.deepEqual(validateVizSpec(spec({ annotations: [bracket({ tone: "bold" })] })), ["annotations[0] range_bracket tone must be 'accent' when set"]);
assert.deepEqual(validateVizSpec(spec({ annotations: [bracket()] })), [], "a well-formed range_bracket has no shape errors");
assert.deepEqual(validateVizSpec(spec({ annotations: [bracket({ tone: "accent" })] })), [], "tone:'accent' is valid");

// -- lintVizSpec: chart_type blockers (only horizontal_bar and plain dot) --
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "dumbbell", start_field: "pct", end_field: "pct", annotations: [bracket()] })), ["annotations[0] range_bracket is not supported on chart_type 'dumbbell'"]);
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "line", x_field: "country", value_field: "pct", annotations: [bracket()] })), ["annotations[0] range_bracket is not supported on chart_type 'line'"]);
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "diverging_bar", annotations: [bracket()] })), ["annotations[0] range_bracket is not supported on chart_type 'diverging_bar'"]);
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "dot", annotations: [bracket()] })), [], "plain (ungrouped) dot is allowed");
assert.deepEqual(rangeBracketBlockers(spec({ chart_type: "dot", series_field: "pct", annotations: [bracket()] })), ["annotations[0] range_bracket is not supported when series_field is set (grouped dot layout)"]);

// -- lintVizSpec: match_field/match_value/end_match_value --
assert.deepEqual(rangeBracketBlockers(spec({ annotations: [bracket({ match_field: "pct" })] })), ["annotations[0] range_bracket match_field must equal category_field"]);
assert.deepEqual(rangeBracketBlockers(spec({ annotations: [bracket({ match_value: "Nowhere, Fictional" })] })), ["annotations[0] range_bracket match_value 'Nowhere, Fictional' was not found in 'country'"]);
assert.deepEqual(rangeBracketBlockers(spec({ annotations: [bracket({ end_match_value: "Nowhere, Fictional" })] })), ["annotations[0] range_bracket end_match_value 'Nowhere, Fictional' was not found in 'country'"]);

// -- lintVizSpec: at most 2, and no overlap (three genuinely non-
// overlapping ranges, so only the count blocker fires) --
assert.deepEqual(
  rangeBracketBlockers(spec({
    annotations: [
      bracket({ match_value: "Congo, Dem. Rep.", end_match_value: "Liberia", text: "a" }),
      bracket({ match_value: "Zambia", end_match_value: "Nigeria", text: "b" }),
      bracket({ match_value: "Niger", end_match_value: "Sierra Leone", text: "c" }),
    ],
  })),
  ["Visualization has 3 range_bracket annotations; maximum is 2"],
);
assert.deepEqual(
  rangeBracketBlockers(spec({ annotations: [bracket({ match_value: "Congo, Dem. Rep.", end_match_value: "Nigeria", text: "a" }), bracket({ match_value: "Niger", end_match_value: "Sierra Leone", text: "b" })] })),
  [],
  "two adjacent, non-overlapping brackets are allowed",
);
assert.deepEqual(
  rangeBracketBlockers(spec({ annotations: [bracket({ match_value: "Congo, Dem. Rep.", end_match_value: "Nigeria", text: "a" }), bracket({ match_value: "Zambia", end_match_value: "Niger", text: "b" })] })),
  ["range_bracket annotations must not overlap"],
  "ranges [0,3] and [2,4] share rows 2-3",
);

// -- valid case: renders, passes render QA, exactly one bracket path, and
// the reserved margin shrinks the plot's own right edge rather than
// growing the canvas (viewBox width unchanged) --
{
  const s = spec({ annotations: [bracket()] });
  assert.deepEqual(rangeBracketBlockers(s), []);
  const svg = renderVizSvg(s, ROWS);
  const qa = runRenderQa({ desktop: svg });
  assert.ok(qa.passed && qa.failure_count === 0, `range_bracket render QA failed: ${JSON.stringify(qaFailures(qa))}`);
  assert.equal((svg.match(/data-role="range-bracket"/g) || []).length, 1);
  assert.match(svg, /viewBox="0 0 1040 /);
}

// -- viewBox width is identical whether or not a range_bracket is present:
// a chart with no range_bracket must render exactly as it did before this
// feature existed (matching reference_line's own "only when present"
// convention for its margin) --
{
  const withBracket = renderVizSvg(spec({ annotations: [bracket()] }), ROWS);
  const withoutBracket = renderVizSvg(spec({ annotations: [] }), ROWS);
  const widthOf = (svg) => /viewBox="0 0 (\d+) /.exec(svg)[1];
  assert.equal(widthOf(withBracket), widthOf(withoutBracket));
  assert.equal((withoutBracket.match(/data-role="range-bracket"/g) || []).length, 0);
}

// -- two brackets: independent, non-overlapping spans; default and accent
// tone both draw and pass render QA; tone actually changes the stroke
// colour (never the same colour twice) --
{
  const s = spec({
    annotations: [
      bracket({ match_value: "Congo, Dem. Rep.", end_match_value: "Nigeria", text: "Top four" }),
      bracket({ match_value: "Niger", end_match_value: "Chad", text: "Next four, still above 70%", tone: "accent" }),
    ],
  });
  assert.deepEqual(rangeBracketBlockers(s), []);
  const svg = renderVizSvg(s, ROWS);
  const qa = runRenderQa({ desktop: svg });
  assert.ok(qa.passed && qa.failure_count === 0, `two-bracket render QA failed: ${JSON.stringify(qaFailures(qa))}`);
  const strokes = [...svg.matchAll(/<path data-role="range-bracket" d="[^"]+" fill="none" stroke="(#[0-9a-fA-F]+)"/g)].map((m) => m[1]);
  assert.equal(strokes.length, 2);
  assert.notEqual(strokes[0], strokes[1], "tone:'accent' must draw a visibly different line colour than the default tone");
}

// -- defence in depth: diverging_bar shares renderHorizontal with
// horizontal_bar, but lintVizSpec already blocks range_bracket there; the
// renderer must never draw a bracket for it even if a caller bypassed
// lint, so an existing diverging_bar chart's geometry can never regress --
{
  const s = spec({ chart_type: "diverging_bar", annotations: [bracket()] });
  assert.deepEqual(rangeBracketBlockers(s), ["annotations[0] range_bracket is not supported on chart_type 'diverging_bar'"]);
  const svg = renderVizSvg(s, ROWS);
  assert.equal((svg.match(/data-role="range-bracket"/g) || []).length, 0, "renderHorizontal must not draw a bracket for diverging_bar even when lint is bypassed");
}

// -- category_names + zh + range_bracket together: match_value/
// end_match_value stay the raw World Bank English names the model wrote
// (never translated by the model); the rendered category labels show the
// vendored zh name; the raw English name never appears as visible text --
{
  const s = spec({
    language: "zh",
    category_names: "worldbank",
    title: "可再生能源占比最高的经济体",
    annotations: [{ type: "range_bracket", match_field: "country", match_value: "Congo, Dem. Rep.", end_match_value: "Chad", text: "八个经济体占比超过七成", claim_id: "x" }],
  });
  assert.deepEqual(rangeBracketBlockers(s), [], "lint matches on the raw World Bank name, not the zh display name");
  const svg = renderVizSvg(s, ROWS);
  const qa = runRenderQa({ desktop: svg });
  assert.ok(qa.passed && qa.failure_count === 0, `zh + category_names range_bracket render QA failed: ${JSON.stringify(qaFailures(qa))}`);
  assert.match(svg, /刚果（金）/, "the category axis must show the vendored zh name (not a model-authored translation)");
  assert.ok(!svg.includes("Congo, Dem. Rep."), "the raw World Bank English name must not appear as chart text once category_names replaces it");
  assert.equal((svg.match(/data-role="range-bracket"/g) || []).length, 1);
}

// -- category_names lint: unmapped value blocker, up to 5 shown --
{
  const badRows = [...ROWS, { country: "Neverland", pct: 5 }];
  const lint = lintVizSpec(spec({ category_names: "worldbank" }), badRows, {});
  assert.ok(
    lint.blockers.includes("category_names='worldbank' cannot resolve 1 value(s) in 'country' (e.g. 'Neverland'); use the exact World Bank English name instead of translating it yourself"),
    JSON.stringify(lint.blockers),
  );
}

// -- category_names lint: a zh chart whose name field has no CJK and no
// category_names set gets a warning suggesting it, not a hard blocker --
{
  const lint = lintVizSpec(spec({ language: "zh", title: "可再生能源占比最高的经济体" }), ROWS, {});
  assert.ok(
    lint.warnings.includes("zh chart's 'country' values contain no CJK characters; consider setting category_names to show localized names instead of the raw World Bank English text"),
    JSON.stringify(lint.warnings),
  );
}

// -- highlight_values still match the raw World Bank name even when
// category_names is set and the visible label is the zh name --
{
  const s = spec({ language: "zh", category_names: "worldbank", title: "可再生能源占比最高的经济体", highlight_values: ["Congo, Dem. Rep."] });
  const svg = renderVizSvg(s, ROWS);
  assert.match(svg, /刚果（金）/);
}

console.log("range_bracket: PASS");

// ---------------------------------------------------------------------
// CJK widow control (wrapText's internal controlWidow step): a wrapped
// block whose last line would hold exactly one wide (CJK) character -
// optionally plus trailing kinsoku punctuation glued to it - is
// rebalanced by moving one wide character down from the previous line,
// unless that would leave the previous line with fewer than two wide
// characters of its own. Character order and kinsoku merging are always
// preserved (lines.join("") always reproduces the input exactly); Latin
// text has no wide character to find, so it is always left untouched.
// ---------------------------------------------------------------------

// A plain widow: 5 wide chars greedily pack 4 into line 1 (8 units, at
// the maxChars=8 budget), leaving a lone 5th on line 2; rebalanced to 3+2
// so neither line holds fewer than two.
{
  const lines = wrapText("一二三四五", 8);
  assert.deepEqual(lines, ["一二三", "四五"]);
  assert.equal(lines.join(""), "一二三四五");
}

// A widow with trailing kinsoku punctuation glued to it ("五。" can never
// be split across a line break, and "。" can never start a line): still
// rebalanced, and the punctuation moves down still attached to its
// character.
{
  const lines = wrapText("一二三四五。", 8);
  assert.deepEqual(lines, ["一二三", "四五。"]);
  assert.equal(lines.join(""), "一二三四五。");
}

// Guard: rebalancing would leave the previous line with only one wide
// character, so a genuine widow is left as-is rather than trading one
// orphan for another.
{
  const lines = wrapText("一二三", 4);
  assert.deepEqual(lines, ["一二", "三"]);
}

// Not a widow at all (the last line already holds two wide characters):
// untouched.
{
  const lines = wrapText("一二三四五六", 8);
  assert.deepEqual(lines, ["一二三四", "五六"]);
}

// The previous line ends with a kinsoku pair ("丙，"): the whole pair moves
// down, so the comma never starts the last line.
{
  const lines = wrapText("甲乙丙，丁", 8);
  assert.deepEqual(lines, ["甲乙", "丙，丁"]);
}

// The previous line ends with an opening bracket glued to its character
// ("（丙"): the pair moves down together, so the previous line never ends
// with "（".
{
  const lines = wrapText("甲乙（丙丁", 8);
  assert.deepEqual(lines, ["甲乙", "（丙丁"]);
}

// An author's space before a CJK character is kept, the same as a space
// before a Latin word: "11 国中有 8 国" must not come out as "11国中有 8国".
assert.deepEqual(wrapText("11 国中有 8 国", 40), ["11 国中有 8 国"]);
assert.deepEqual(wrapText("6 国为 2021 年", 40), ["6 国为 2021 年"]);

// Latin-only input can never trigger widow control (no code point is
// ever "wide"), even when the greedy wrap happens to leave a single
// short word alone on the last line.
{
  const lines = wrapText("Alpha bravo charlie delta echo foxtrot golf", 10);
  assert.ok(lines.length >= 2, lines);
  assert.equal(lines.at(-1), "golf", "a lone final word on the last line is never pulled into the previous line");
  assert.equal(lines.join(" "), "Alpha bravo charlie delta echo foxtrot golf");
}

console.log("CJK widow control: PASS");
