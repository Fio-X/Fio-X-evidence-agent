#!/usr/bin/env node
// Fix 8 regression test: "CJK title line-breaking." Chart titles, infographic
// page titles and section_header headings were wrapped with the same plain
// greedy fill (wrapText) used for body copy: it always crams as much as
// possible onto the earlier line(s), which for CJK headlines (a) frequently
// breaks mid-clause a few characters before a comma or full stop that would
// have made a clean line, and (b) can strand a very short, unbalanced
// remainder alone on the last line.
//
// Fix: a new house-style-only wrapHeadline(text, maxChars) reuses wrapText's
// own tokenizer but re-chooses *where* lines break, in order of preference:
//   1. a break right after a full-width punctuation/closing character (the
//      same NO_START kinsoku set, reused because every character that must
//      never *start* a line is, by the same logic, always safe to *end* one)
//      when the remaining line(s) still fit within maxChars;
//   2. otherwise, whichever feasible boundary is closest to an even split
//      across all lines ("balanced"), rather than always maximising the
//      first line the way greedy fill does;
//   3. a post-process that never leaves 3 characters or fewer alone on the
//      last line, borrowing the previous line's last token down - the same
//      idea controlWidow already applies to a single trailing widow
//      character, generalised to any short remainder - unless doing so would
//      overflow maxChars, in which case the short last line is accepted
//      rather than risk an overflow.
// wrapHeadline always returns exactly as many lines as wrapText would for
// the same input, so no header/section-height layout math is ever affected
// - only which characters land on which line. It is gated two ways, so it
// can never fire outside CJK house-style headlines: (a) an isWideChar guard
// inside wrapHeadline itself returns wrapText's output unchanged for any
// text with no wide character; (b) callers only reach it through
// viz.mjs's headlineWrap()/infographic.mjs's lines(), both of which check
// their own module's HOUSE_STYLE_ACTIVE flag and fall back to plain
// wrapText under style_id/style:"legacy" or NEWSROOM_HOUSE_STYLE=legacy.
//
// In scope: chart titles (frame/mobileFrame's spec.title), infographic page
// titles (headerMetrics/drawHeader's spec.title) and section_header module
// headings (drawSectionHeader's module.heading). Deliberately out of scope,
// unchanged by this fix: chart subtitles, infographic deks, scene.title/dek,
// and every other module's own heading/label/body/caption text - all still
// plain wrapText, in both styles.
import assert from "node:assert/strict";
import { wrapText, wrapHeadline, renderVizBundle } from "../runtime/pi/viz.mjs";
import { composeInfographicBundle, validateInfographicSpec } from "../runtime/pi/infographic.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

// --- Direct wrapHeadline fixtures -------------------------------------
// Each pair below is the exact, hand-verified output of wrapText (today's
// plain greedy fill, still used by legacy) and wrapHeadline (the new
// house-style behaviour) for the same (text, maxChars) used by a real call
// site, so this test doubles as documentation of the rule in practice.

// 1. Punctuation-preferred break: a comma sits well before the greedy
//    break point, and the remainder still fits, so wrapHeadline breaks
//    right after it instead of cramming past it.
{
  const text = "中国生育率持续走低，与主要经济体的差距逐年拉大，政策效果仍待观察验证";
  const maxChars = 62; // frame()'s desktop chart-title budget
  assert.deepEqual(wrapText(text, maxChars), [
    "中国生育率持续走低，与主要经济体的差距逐年拉大，政策效果仍待观",
    "察验证",
  ]);
  assert.deepEqual(wrapHeadline(text, maxChars), [
    "中国生育率持续走低，",
    "与主要经济体的差距逐年拉大，政策效果仍待观察验证",
  ]);
  console.log("wrapHeadline: punctuation-preferred break (desktop chart-title budget): PASS");
}

// 2. Balanced fallback: no punctuation sits near an even split, so
//    wrapHeadline chooses the most evenly-balanced feasible boundary
//    instead of greedy fill's maximal first line.
{
  const text = "中国生育率下降速度远超多数发达国家平均水平";
  const maxChars = 38; // mobileFrame()'s mobile chart-title budget
  assert.deepEqual(wrapText(text, maxChars), [
    "中国生育率下降速度远超多数发达国家平均",
    "水平",
  ]);
  assert.deepEqual(wrapHeadline(text, maxChars), [
    "中国生育率下降速度远",
    "超多数发达国家平均水平",
  ]);
  console.log("wrapHeadline: balanced fallback (mobile chart-title budget): PASS");
}

// 3. Punctuation-preferred break at the infographic page-title budget.
{
  const text = "中国生育率跌至历史新低，育龄女性生育意愿持续走弱";
  const maxChars = 31; // headerMetrics's desktop page-title budget
  assert.deepEqual(wrapText(text, maxChars), [
    "中国生育率跌至历史新低，育龄女",
    "性生育意愿持续走弱",
  ]);
  assert.deepEqual(wrapHeadline(text, maxChars), [
    "中国生育率跌至历史新低，",
    "育龄女性生育意愿持续走弱",
  ]);
  console.log("wrapHeadline: punctuation-preferred break (infographic page-title budget): PASS");
}

// 4. The recursive split generalises past two lines: a 3-line mobile page
//    title still gets a punctuation-preferred first break and a balanced
//    second one, and still comes back as exactly 3 lines.
{
  const text = "中国生育率跌至新低育龄妇女生育意愿走弱明显";
  const maxChars = 19; // headerMetrics's mobile page-title budget
  assert.deepEqual(wrapText(text, maxChars), [
    "中国生育率跌至新低",
    "育龄妇女生育意愿走",
    "弱明显",
  ]);
  assert.deepEqual(wrapHeadline(text, maxChars), [
    "中国生育率跌至",
    "新低育龄妇女生",
    "育意愿走弱明显",
  ]);
  console.log("wrapHeadline: 3-line case (infographic mobile page-title budget): PASS");
}

// 5. Balanced fallback at the section_header heading budget.
{
  const text = "政策放开为何依然没能带来生育率回升背后隐藏的深层结构性原因剖析";
  const maxChars = 48; // drawSectionHeader's desktop heading budget
  assert.deepEqual(wrapText(text, maxChars), [
    "政策放开为何依然没能带来生育率回升背后隐藏的深层",
    "结构性原因剖析",
  ]);
  assert.deepEqual(wrapHeadline(text, maxChars), [
    "政策放开为何依然没能带来生育率",
    "回升背后隐藏的深层结构性原因剖析",
  ]);
  console.log("wrapHeadline: balanced fallback (section heading budget): PASS");
}

// 6. The <=3-char last-line fixup: greedy fill stops one character short of
//    a clean boundary, leaving "担忧A" (3 units) dangling; wrapHeadline's
//    borrow-back step folds the previous line's last token down.
{
  const text = "中国生育率持续下降令人担忧A";
  const maxChars = 22;
  assert.deepEqual(wrapText(text, maxChars), ["中国生育率持续下降令人", "担忧A"]);
  assert.deepEqual(wrapHeadline(text, maxChars), ["中国生育率持续", "下降令人担忧A"]);
  console.log("wrapHeadline: <=3-char last-line fixup: PASS");
}

// --- Safety properties shared by every fixture above --------------------
{
  const fixtures = [
    ["中国生育率持续走低，与主要经济体的差距逐年拉大，政策效果仍待观察验证", 62],
    ["中国生育率下降速度远超多数发达国家平均水平", 38],
    ["中国生育率跌至历史新低，育龄女性生育意愿持续走弱", 31],
    ["中国生育率跌至新低育龄妇女生育意愿走弱明显", 19],
    ["政策放开为何依然没能带来生育率回升背后隐藏的深层结构性原因剖析", 48],
    ["中国生育率持续下降令人担忧A", 22],
  ];
  for (const [text, maxChars] of fixtures) {
    const plain = wrapText(text, maxChars);
    const headline = wrapHeadline(text, maxChars);
    assert.equal(headline.length, plain.length,
      `wrapHeadline must keep wrapText's line count for "${text}" @ ${maxChars}: ${JSON.stringify({ plain, headline })}`);
    assert.equal(headline.join(""), text, `wrapHeadline must not drop or reorder characters: ${JSON.stringify(headline)}`);
    for (const line of headline) {
      assert.ok(Array.from(line).length <= maxChars || plain.some((l) => l === line),
        `wrapHeadline line "${line}" exceeds maxChars=${maxChars}`);
    }
  }
  console.log("wrapHeadline: line-count and content-preservation invariants hold for every fixture: PASS");
}

// A Latin-only headline (no wide character) must come back byte-identical
// to wrapText - the isWideChar guard means house style never touches
// non-CJK titles.
{
  const text = "The quick brown fox jumps over the lazy dog and keeps running";
  const maxChars = 20;
  const plain = wrapText(text, maxChars);
  assert.deepEqual(plain, ["The quick brown fox", "jumps over the lazy", "dog and keeps", "running"]);
  assert.deepEqual(wrapHeadline(text, maxChars), plain, "a Latin-only headline must be untouched by wrapHeadline");
  console.log("wrapHeadline: Latin-only text is returned unchanged (CJK-only gating): PASS");
}

// --- End-to-end: desktop chart title (renderVizBundle) -------------------
const rows = [
  { country: "甲国", value: 82.1 },
  { country: "乙国", value: 65.4 },
  { country: "丙国", value: 41.3 },
];
function chartSpec(title, styleOverride = {}) {
  return {
    reader_task: "ranking",
    takeaway: "测试标题换行回归",
    chart_type: "horizontal_bar",
    title,
    alt: "横向条形图，用于标题换行回归测试。",
    source_note: "离线测试数据",
    claim_id: "claim-headline-wrap",
    sql: "SELECT 1",
    unit: "%",
    category_field: "country",
    value_field: "value",
    mixed_period_strategy: "reject",
    sort: "desc",
    highlight_values: ["甲国"],
    direct_labels: true,
    annotations: [],
    ...styleOverride,
  };
}

function titleLinesOf(svg, fontSize) {
  const re = new RegExp(`<text[^>]*font-size="${fontSize}"[^>]*>([^<]*)<\\/text>`, "g");
  return [...svg.matchAll(re)].map((m) => m[1]);
}

{
  const title = "中国生育率持续走低，与主要经济体的差距逐年拉大，政策效果仍待观察验证";
  const houseBundle = renderVizBundle(chartSpec(title), rows);
  assert.deepEqual(titleLinesOf(houseBundle.desktop, 28), [
    "中国生育率持续走低，",
    "与主要经济体的差距逐年拉大，政策效果仍待观察验证",
  ], "house-style desktop chart title must render wrapHeadline's break, not wrapText's");
  const legacyBundle = renderVizBundle(chartSpec(title, { style_id: "legacy" }), rows);
  assert.deepEqual(titleLinesOf(legacyBundle.desktop, 28), [
    "中国生育率持续走低，与主要经济体的差距逐年拉大，政策效果仍待观",
    "察验证",
  ], "legacy desktop chart title must keep plain wrapText's greedy break");
  const qa = runRenderQa({ desktop: houseBundle.desktop, mobile: houseBundle.mobile });
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports));
  console.log("end-to-end: desktop chart title (renderVizBundle) - house wraps at the comma, legacy stays greedy, render-QA clean: PASS");
}

// --- End-to-end: mobile chart title (renderVizBundle) ---------------------
{
  const title = "中国生育率下降速度远超多数发达国家平均水平";
  const houseBundle = renderVizBundle(chartSpec(title), rows);
  assert.deepEqual(titleLinesOf(houseBundle.mobile, 25), [
    "中国生育率下降速度远",
    "超多数发达国家平均水平",
  ], "house-style mobile chart title must render wrapHeadline's balanced break");
  const legacyBundle = renderVizBundle(chartSpec(title, { style_id: "legacy" }), rows);
  assert.deepEqual(titleLinesOf(legacyBundle.mobile, 25), [
    "中国生育率下降速度远超多数发达国家平均",
    "水平",
  ], "legacy mobile chart title must keep plain wrapText's greedy break");
  console.log("end-to-end: mobile chart title (renderVizBundle) - house balances the split, legacy stays greedy: PASS");
}

// --- End-to-end: infographic page title + section heading -----------------
const claim = "claim-headline-wrap";
function infographicSpec(title, heading, styleOverride = {}) {
  return {
    schema_version: "1.0.0",
    kicker: "DATA FEATURE",
    title,
    dek: "标题换行回归测试固定说明文字，用于满足信息图规范的必填字段。",
    alt: "用于标题换行回归测试的信息图固定夹具，包含标题、章节标题与正文模块。",
    byline: "Newsroom Agent",
    date_label: "Regression edition",
    layout: "feature",
    complexity_budget: "low",
    source_note: "离线测试数据",
    language: "zh",
    ...styleOverride,
    modules: [
      { id: "section-1", type: "section_header", span: "full", eyebrow: "背景", heading, deck: "章节说明文字。" },
      { id: "stat-total", type: "hero_stat", span: "third", tone: "accent", value: "100", unit: "PJ", label: "已核实的合成总量", detail: "核实声明夹具", claim_id: claim },
      { id: "note", type: "text", span: "two_thirds", label: "说明", heading: "正文标题", body: "这里是模块正文内容，用于检查标题换行规则不影响其他模块。", claim_ids: [claim] },
      { id: "quote-1", type: "pull_quote", span: "full", text: "这是一段引述文字。", attribution: "来源附注" },
    ],
  };
}

{
  const title = "中国生育率跌至历史新低，育龄女性生育意愿持续走弱";
  const heading = "章节标题占位文字"; // kept short/plain: this fixture isolates the page title only
  const spec = infographicSpec(title, heading);
  assert.deepEqual(validateInfographicSpec(spec), []);
  const houseBundle = composeInfographicBundle(spec, {});
  assert.deepEqual(titleLinesOf(houseBundle.desktop.svg, 68), [
    "中国生育率跌至历史新低，",
    "育龄女性生育意愿持续走弱",
  ], "house-style infographic page title (desktop) must render wrapHeadline's break");
  const legacySpec = infographicSpec(title, heading, { style_id: "legacy" });
  const legacyBundle = composeInfographicBundle(legacySpec, {});
  assert.deepEqual(titleLinesOf(legacyBundle.desktop.svg, 68), [
    "中国生育率跌至历史新低，育龄女",
    "性生育意愿持续走弱",
  ], "legacy infographic page title (desktop) must keep plain wrapText's greedy break");
  const qa = runRenderQa({ desktop: houseBundle.desktop.svg, mobile: houseBundle.mobile.svg });
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports));
  console.log("end-to-end: infographic page title, desktop (composeInfographicBundle) - house wraps at the comma, legacy stays greedy, render-QA clean: PASS");
}

// 3-line mobile page title.
{
  const title = "中国生育率跌至新低育龄妇女生育意愿走弱明显";
  const heading = "章节标题占位文字";
  const spec = infographicSpec(title, heading);
  const houseBundle = composeInfographicBundle(spec, {});
  assert.deepEqual(titleLinesOf(houseBundle.mobile.svg, 45), [
    "中国生育率跌至",
    "新低育龄妇女生",
    "育意愿走弱明显",
  ], "house-style infographic page title (mobile, 3-line) must render wrapHeadline's break");
  const legacyBundle = composeInfographicBundle(infographicSpec(title, heading, { style_id: "legacy" }), {});
  assert.deepEqual(titleLinesOf(legacyBundle.mobile.svg, 45), [
    "中国生育率跌至新低",
    "育龄妇女生育意愿走",
    "弱明显",
  ], "legacy infographic page title (mobile) must keep plain wrapText's greedy break");
  console.log("end-to-end: infographic page title, mobile 3-line case (composeInfographicBundle) - house rewraps, legacy stays greedy: PASS");
}

// Section heading (balanced fallback), isolated with a short, plain page
// title so the two headline-mode call sites in this file don't interact.
{
  const title = "标题占位文字";
  const heading = "政策放开为何依然没能带来生育率回升背后隐藏的深层结构性原因剖析";
  const spec = infographicSpec(title, heading);
  const houseBundle = composeInfographicBundle(spec, {});
  assert.deepEqual(titleLinesOf(houseBundle.desktop.svg, 36), [
    "政策放开为何依然没能带来生育率",
    "回升背后隐藏的深层结构性原因剖析",
  ], "house-style section heading (desktop) must render wrapHeadline's balanced break");
  const legacyBundle = composeInfographicBundle(infographicSpec(title, heading, { style_id: "legacy" }), {});
  assert.deepEqual(titleLinesOf(legacyBundle.desktop.svg, 36), [
    "政策放开为何依然没能带来生育率回升背后隐藏的深层",
    "结构性原因剖析",
  ], "legacy section heading (desktop) must keep plain wrapText's greedy break");
  const qa = runRenderQa({ desktop: houseBundle.desktop.svg, mobile: houseBundle.mobile.svg });
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports));
  console.log("end-to-end: section_header heading, desktop (composeInfographicBundle) - house balances the split, legacy stays greedy, render-QA clean: PASS");
}

console.log("headline wrap (CJK title line-breaking) regression: PASS");
