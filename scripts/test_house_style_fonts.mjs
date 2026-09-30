#!/usr/bin/env node
// Fix 12 regression test: font unification. House style used to pair two
// typefaces - a CJK sans stack (HOUSE_FONT_SANS) for body/axis/data text and
// a separate Songti-led serif stack (HOUSE_FONT_TITLE, viz.mjs; plus
// infographic.mjs's own unrelated, Latin-only Georgia/Arial split for page
// titles vs. chrome) - so the serif/sans pairing carried the hierarchy on
// its own. User decision: all sans. One CJK sans stack now covers every
// house-style face - page title, section heads, chart titles, hero
// numerals, body text and chart labels alike - and font-weight (700 for
// titles/heads, 400 for body; unchanged by this fix) carries the hierarchy
// instead.
//
// viz.mjs: HOUSE_FONT_TITLE is gone; applyStyle's house branch now sets
// FONT_TITLE = HOUSE_FONT_SANS, the same stack FONT_SANS already used, so
// FONT_TITLE and FONT_SANS resolve identically in *every* style (legacy
// already did this implicitly - both were always DEFAULT_FONT_SANS).
// HOUSE_FONT_SANS is now exported so infographic.mjs can reuse the exact
// same constant rather than declaring a second one.
//
// infographic.mjs: SANS/SERIF (previously plain, always-Latin consts) are
// now mutable bindings wired through applyInfographicStyle exactly like
// INK/MUTED/GRID/ACCENT/PAPER already were. Legacy keeps its original,
// byte-for-byte Arial/Georgia split (renamed LEGACY_SANS/LEGACY_SERIF, values
// unchanged); house collapses both onto the imported HOUSE_FONT_SANS.
//
// This file asserts the user-visible contract directly: no Songti or
// Georgia glyph family reaches a house-style page or chart, the exact old
// Arial/Georgia split still reaches a legacy one byte-for-byte, and the
// weight-only hierarchy (700/400) this fix relies on is unchanged.
import assert from "node:assert/strict";
import { lintVizSpec, renderVizSvg, HOUSE_FONT_SANS } from "../runtime/pi/viz.mjs";
import { composeInfographicBundle, validateInfographicSpec } from "../runtime/pi/infographic.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const LEGACY_SANS = "Arial, Helvetica, sans-serif";
const LEGACY_SERIF = "Georgia, 'Times New Roman', serif";
// A substring unique to the CJK stack (not a substring of any Latin stack
// above), so "is the house stack actually wired in" can be checked without
// restating the whole long literal at every call site.
const HOUSE_MARKER = "PingFang SC";

// Matches the visible <text>/<tspan> element carrying `needle`, never the
// accessibility <title>/<desc> element some renderers also emit with the
// same string (that element carries no font-family attribute at all).
function extractTextLine(svg, needle) {
  const line = svg.split("\n").find((l) => l.includes(needle) && l.includes("font-family="));
  assert.ok(line, `expected a <text>/<tspan> line containing "${needle}" in: ${svg.slice(0, 200)}...`);
  return line;
}
function fontFamilyOf(line) {
  const m = /font-family="([^"]*)"/.exec(line);
  assert.ok(m, `expected a font-family attribute in: ${line}`);
  return m[1];
}

// ---------------------------------------------------------------------------
// 1. viz.mjs charts: house style uses one CJK sans stack for title and body
//    alike; legacy is untouched (both were already the same Arial stack).
// ---------------------------------------------------------------------------
{
  const claimId = "claim-house-style-fonts";
  const ctx = { verified_claim_ids: [claimId] };
  const rows = [{ category: "甲", value: 42 }, { category: "乙", value: 31 }, { category: "丙", value: 18 }, { category: "丁", value: 9 }];
  const chartTitle = "四类占比排名";
  function chartSpec(styleOverride = {}) {
    return {
      schema_version: "0.9.0", reader_task: "ranking", takeaway: "甲在这组同类对比中领先。",
      chart_type: "horizontal_bar", title: chartTitle, subtitle: "字体统一回归测试",
      alt: "四个类别的横向条形图，从甲的42到丁的9。", source_note: "Synthetic fixture", claim_id: claimId,
      sql: "SELECT * FROM synthetic_bar", unit: "units", category_field: "category", value_field: "value",
      sort: "desc", highlight_values: ["甲"], annotations: [], language: "zh", ...styleOverride,
    };
  }

  for (const [name, styleOverride, expectTitleFamily, expectMarker] of [
    ["house", {}, HOUSE_FONT_SANS, true],
    ["legacy", { style_id: "legacy" }, LEGACY_SANS, false],
  ]) {
    const spec = chartSpec(styleOverride);
    const lint = lintVizSpec(spec, rows, ctx);
    assert.equal(lint.passed, true, `${name}: fixture must lint clean - ${lint.blockers?.join(" | ")}`);
    const svg = renderVizSvg(spec, rows);

    assert.ok(!svg.includes("Songti"), `${name}: chart SVG must never contain the retired Songti SC stack`);
    assert.ok(!svg.includes("Georgia"), `${name}: chart SVG must never contain Georgia (viz.mjs never used it, in either style)`);
    assert.equal(svg.includes(HOUSE_MARKER), expectMarker, `${name}: chart SVG's CJK-stack marker presence must match the active style`);

    const titleLine = extractTextLine(svg, chartTitle);
    assert.equal(fontFamilyOf(titleLine), expectTitleFamily, `${name}: chart title's font-family must be the active style's stack: ${titleLine}`);

    // FONT_TITLE and FONT_SANS now resolve identically in every style (fix
    // 12 makes house match what legacy already did) - a tick/category label
    // (drawn via FONT_SANS) must carry the exact same font-family as the
    // title (drawn via FONT_TITLE).
    const categoryLine = extractTextLine(svg, "甲");
    assert.equal(fontFamilyOf(categoryLine), fontFamilyOf(titleLine), `${name}: FONT_TITLE and FONT_SANS must resolve to the same stack: title="${titleLine}" category="${categoryLine}"`);
  }
  console.log("viz.mjs charts: house style unifies title+body on one CJK sans stack, legacy unchanged: PASS");
}

// ---------------------------------------------------------------------------
// 2. infographic.mjs page chrome: house style collapses SANS/SERIF onto the
//    one imported CJK stack everywhere; legacy keeps its original,
//    byte-for-byte Arial/Georgia split.
// ---------------------------------------------------------------------------
const claim = "claim-house-style-fonts-page";
function pageSpec(styleOverride = {}) {
  return {
    schema_version: "1.0.0",
    kicker: "DATA FEATURE",
    title: "字体统一回归测试页面标题",
    dek: "Regression fixture for fix 12's font-unification contract.",
    alt: "A section header, a hero statistic, a text module and a pull quote fixture.",
    byline: "Newsroom Agent",
    date_label: "Regression edition",
    layout: "feature",
    complexity_budget: "low",
    source_note: "Synthetic font-unification regression fixture",
    language: "zh",
    ...styleOverride,
    modules: [
      { id: "section-1", type: "section_header", span: "full", eyebrow: "背景", heading: "章节标题", deck: "章节说明文字。" },
      { id: "stat-total", type: "hero_stat", span: "third", tone: "accent", value: "100", unit: "PJ", label: "已核实的合成总量", detail: "核实声明夹具", claim_id: claim },
      { id: "note", type: "text", span: "two_thirds", label: "说明", heading: "正文标题", body: "这里是模块正文内容。", claim_ids: [claim] },
      { id: "quote-1", type: "pull_quote", span: "full", text: "这是一段引述文字。", attribution: "来源附注" },
    ],
  };
}

function assertNoRetiredFamilies(svg, label) {
  assert.ok(!svg.includes("Songti"), `${label}: page SVG must never contain Songti (viz.mjs's retired house title stack)`);
}

// --- 2a. House style (default): one CJK stack everywhere, no Georgia -------
{
  const spec = pageSpec();
  assert.deepEqual(validateInfographicSpec(spec), [], "house fixture must validate");
  const bundle = composeInfographicBundle(spec, {});
  for (const [name, svg] of [["desktop", bundle.desktop.svg], ["mobile", bundle.mobile.svg]]) {
    assertNoRetiredFamilies(svg, `house/${name}`);
    assert.ok(!svg.includes("Georgia"), `house/${name}: page SVG must not contain Georgia under house style`);
    assert.ok(svg.includes(HOUSE_FONT_SANS), `house/${name}: page SVG must use the imported HOUSE_FONT_SANS stack: ${svg.match(/font-family="[^"]*"/)}`);

    // Weight carries the hierarchy now, not typeface: a heading (700) and a
    // body paragraph (400) must both use the exact same font-family.
    const headingLine = extractTextLine(svg, "正文标题");
    const bodyLine = extractTextLine(svg, "这里是模块正文内容。");
    assert.equal(fontFamilyOf(headingLine), HOUSE_FONT_SANS, `house/${name}: heading must use the house CJK stack: ${headingLine}`);
    assert.equal(fontFamilyOf(bodyLine), HOUSE_FONT_SANS, `house/${name}: body copy must use the house CJK stack: ${bodyLine}`);
    assert.ok(/font-weight="700"/.test(headingLine), `house/${name}: heading weight must stay 700 (unchanged by this fix): ${headingLine}`);
    assert.ok(/font-weight="400"/.test(bodyLine), `house/${name}: body weight must stay 400 (unchanged by this fix): ${bodyLine}`);
  }
  const qa = runRenderQa({ desktop: bundle.desktop.svg, mobile: bundle.mobile.svg });
  assert.equal(qa.passed, true, `render-QA (house): ${JSON.stringify(qa.viewports)}`);
  console.log("infographic.mjs house style: one CJK sans stack everywhere (title/heads/hero/body/chrome), no Georgia/Songti, weights unchanged, render-QA clean: PASS");
}

// --- 2b. Legacy style: byte-for-byte original Arial/Georgia split ---------
{
  const spec = pageSpec({ style_id: "legacy" });
  const bundle = composeInfographicBundle(spec, {});
  for (const [name, svg] of [["desktop", bundle.desktop.svg], ["mobile", bundle.mobile.svg]]) {
    assertNoRetiredFamilies(svg, `legacy/${name}`);
    assert.ok(svg.includes(LEGACY_SERIF), `legacy/${name}: page SVG must keep its original Georgia stack: ${svg.match(/font-family="[^"]*"/g)}`);
    assert.ok(svg.includes(LEGACY_SANS), `legacy/${name}: page SVG must keep its original Arial stack`);
    assert.ok(!svg.includes(HOUSE_MARKER), `legacy/${name}: page SVG must not use the house CJK stack`);

    const headingLine = extractTextLine(svg, "正文标题");
    const bodyLine = extractTextLine(svg, "这里是模块正文内容。");
    assert.equal(fontFamilyOf(headingLine), LEGACY_SERIF, `legacy/${name}: heading must keep its original Georgia stack: ${headingLine}`);
    assert.equal(fontFamilyOf(bodyLine), LEGACY_SANS, `legacy/${name}: body copy must keep its original Arial stack: ${bodyLine}`);
    assert.ok(/font-weight="700"/.test(headingLine), `legacy/${name}: heading weight must stay 700: ${headingLine}`);
    assert.ok(/font-weight="400"/.test(bodyLine), `legacy/${name}: body weight must stay 400: ${bodyLine}`);
  }
  const qa = runRenderQa({ desktop: bundle.desktop.svg, mobile: bundle.mobile.svg });
  assert.equal(qa.passed, true, `render-QA (legacy): ${JSON.stringify(qa.viewports)}`);
  console.log("infographic.mjs legacy style: original Arial/Georgia split preserved byte-for-byte, render-QA clean: PASS");
}

// --- 2c. NEWSROOM_HOUSE_STYLE=legacy env fallback reaches fonts too --------
{
  const prior = process.env.NEWSROOM_HOUSE_STYLE;
  process.env.NEWSROOM_HOUSE_STYLE = "legacy";
  try {
    const bundle = composeInfographicBundle(pageSpec(), {});
    assert.ok(bundle.desktop.svg.includes(LEGACY_SERIF) && bundle.desktop.svg.includes(LEGACY_SANS), "NEWSROOM_HOUSE_STYLE=legacy must restore the original Arial/Georgia split");
    assert.ok(!bundle.desktop.svg.includes(HOUSE_MARKER), "NEWSROOM_HOUSE_STYLE=legacy must not use the house CJK stack");
  } finally {
    if (prior === undefined) delete process.env.NEWSROOM_HOUSE_STYLE;
    else process.env.NEWSROOM_HOUSE_STYLE = prior;
  }
  console.log("NEWSROOM_HOUSE_STYLE=legacy env fallback reaches fonts too: PASS");
}

console.log("font unification (fix 12) regression: PASS");
