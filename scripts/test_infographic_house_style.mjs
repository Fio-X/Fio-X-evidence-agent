#!/usr/bin/env node
// Fix 7 regression test: "infographic.mjs ignores house style." Page chrome
// drawn directly by runtime/pi/infographic.mjs - header/footer rules, the
// kicker, section heads, body text, pull quotes, the sources footer - was
// hardcoded to its own pre-house palette (INK #1d2329, MUTED #69727a,
// GRID #d9dde1, ACCENT #c9473d, PAPER #fffdf9), completely independent of
// runtime/pi/viz.mjs's house style, so a composed page's own chrome never
// matched the (house-styled) charts embedded in it.
//
// Fix: infographic.mjs now carries its own mutable "current style" bindings
// (INK/MUTED/GRID/ACCENT/PAPER), mirroring viz.mjs's PALETTE/applyStyle
// pattern, reassigned once per composeOne() call from the same house hex
// values viz.mjs's HOUSE_PALETTES.house uses (paper #FFFFFF, ink #1A1A1A,
// muted #666666, grid #E5E5E5, accent #D0021B). style_id/style: "legacy" (or
// NEWSROOM_HOUSE_STYLE=legacy) restores the exact old hardcoded colours.
//
// Font-family (SANS/SERIF) was fix 12's own separate scope and has since
// landed too - see scripts/test_house_style_fonts.mjs for that fix's
// dedicated contract (one CJK sans stack under house style, the original
// Arial/Georgia split preserved byte-for-byte under legacy). Check #2b below
// now normalizes font-family out alongside the five colours, rather than
// leaving it out of scope. hero_stat's coloured-card background/tone/
// contrast pairing was fix 9's own separate, droppable restyle ("no filled
// background") and has since landed - see scripts/test_hero_stat_restyle.mjs
// for its dedicated contract. Check #4 below now only asserts fix 7 left
// hero_stat's *legacy* rendering alone; it no longer asserts house-style
// hero_stat is untouched, since fix 9 deliberately changed that.
import assert from "node:assert/strict";
import { composeInfographicBundle, validateInfographicSpec } from "../runtime/pi/infographic.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const claim = "claim-house-style-fixture";

function baseSpec(styleOverride = {}) {
  return {
    schema_version: "1.0.0",
    kicker: "DATA FEATURE",
    title: "House style now reaches the page chrome, not just the charts",
    dek: "Regression fixture for infographic.mjs's own header, footer, section head and pull quote colours.",
    alt: "A four-module infographic fixture exercising every page-chrome colour role.",
    byline: "Newsroom Agent",
    date_label: "Regression edition",
    layout: "feature",
    complexity_budget: "low",
    source_note: "Synthetic house-style regression fixture",
    language: "zh",
    ...styleOverride,
    modules: [
      { id: "section-1", type: "section_header", span: "full", eyebrow: "背景", heading: "同一份规范驱动页面与图表", deck: "章节说明文字。" },
      { id: "stat-total", type: "hero_stat", span: "third", tone: "accent", value: "100", unit: "PJ", label: "已核实的合成总量", detail: "核实声明夹具", claim_id: claim },
      { id: "note", type: "text", span: "two_thirds", label: "说明", heading: "正文标题", body: "这里是模块正文内容，用于检查文字颜色。", claim_ids: [claim] },
      { id: "quote-1", type: "pull_quote", span: "full", text: "这是一段引述文字。", attribution: "来源附注" },
    ],
  };
}

const HOUSE = { ink: "#1A1A1A", muted: "#666666", grid: "#E5E5E5", accent: "#D0021B", paper: "#FFFFFF" };
const LEGACY = { ink: "#1d2329", muted: "#69727a", grid: "#d9dde1", accent: "#c9473d", paper: "#fffdf9" };

function assertRoleColors(svg, colors, label) {
  for (const [role, present] of Object.entries(colors.present)) {
    assert.ok(svg.includes(present), `${label}: expected ${role} colour ${present} to appear somewhere in the composed SVG`);
  }
  for (const [role, absent] of Object.entries(colors.absent)) {
    assert.ok(!svg.includes(absent), `${label}: did not expect the other style's ${role} colour ${absent} to appear in the composed SVG`);
  }
}

// drawHeroStat (runtime/pi/infographic.mjs) brackets everything it draws
// between a start rect and an end marker rect that share the same
// data-role="hero-stat" attribute (the end marker is an invisible 1x1
// fill="none" rect, added so this bracketing works regardless of how many
// lines the label/detail text wrapped to). These two helpers use the first
// and last such line as an inclusive range, rather than assuming a fixed
// line count - hero_stat's own structure now legitimately differs between
// house and legacy (fix 9), so the two styles' blocks are not the same size.
function heroStatRange(svg) {
  const lines = svg.split("\n");
  const idx = [];
  lines.forEach((l, i) => { if (l.includes('data-role="hero-stat"')) idx.push(i); });
  assert.ok(idx.length >= 2, `expected a hero-stat start+end marker pair in: ${svg.slice(0, 200)}...`);
  return { lines, first: idx[0], last: idx[idx.length - 1] };
}
function heroStatBlock(svg) {
  const { lines, first, last } = heroStatRange(svg);
  return lines.slice(first, last + 1).join("\n");
}
// hero_stat's own colours are fix 9's separate scope (see check #4 below),
// so a whole-page "must not contain the other style's colours" check has to
// look outside that whole block, or it would trip on hero_stat's own,
// legitimately different treatment even on a correctly-fixed page.
function withoutHeroStat(svg) {
  const { lines, first, last } = heroStatRange(svg);
  return lines.filter((_, i) => i < first || i > last).join("\n");
}

// --- 1. House style (the default): page chrome uses the house palette -----
{
  const spec = baseSpec();
  assert.deepEqual(validateInfographicSpec(spec), []);
  const bundle = composeInfographicBundle(spec, {});
  for (const [name, svg] of [["desktop", bundle.desktop.svg], ["mobile", bundle.mobile.svg]]) {
    assertRoleColors(svg, {
      present: { ink: HOUSE.ink, muted: HOUSE.muted, grid: HOUSE.grid, paper: HOUSE.paper },
      absent: { ink: LEGACY.ink, muted: LEGACY.muted, grid: LEGACY.grid, paper: LEGACY.paper },
    }, `house style (${name})`);
    const rest = withoutHeroStat(svg);
    assert.ok(rest.includes(HOUSE.accent), `house style (${name}): expected the house accent outside hero_stat (header kicker/section eyebrow/pull-quote bar)`);
    assert.ok(!rest.includes(LEGACY.accent), `house style (${name}): did not expect the legacy accent outside hero_stat: ${rest.match(new RegExp(`.{0,40}${LEGACY.accent}.{0,40}`))}`);
    assert.ok(svg.includes(`fill="${HOUSE.paper}"`), `house style (${name}): page background must be the house paper colour`);
  }
  const qa = runRenderQa({ desktop: bundle.desktop.svg, mobile: bundle.mobile.svg });
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports));
  console.log("house style (default): page chrome uses viz.mjs's house palette, render-QA clean: PASS");
}

// --- 2. Legacy style: byte-for-byte old chrome colours ---------------------
{
  const spec = baseSpec({ style_id: "legacy" });
  const bundle = composeInfographicBundle(spec, {});
  for (const [name, svg] of [["desktop", bundle.desktop.svg], ["mobile", bundle.mobile.svg]]) {
    assertRoleColors(svg, {
      present: { ink: LEGACY.ink, muted: LEGACY.muted, grid: LEGACY.grid, paper: LEGACY.paper },
      absent: { ink: HOUSE.ink, muted: HOUSE.muted, grid: HOUSE.grid, paper: HOUSE.paper },
    }, `legacy style (${name})`);
    const rest = withoutHeroStat(svg);
    assert.ok(rest.includes(LEGACY.accent), `legacy style (${name}): expected the legacy accent outside hero_stat too (chrome must match hero_stat's already-legacy accent)`);
    assert.ok(!rest.includes(HOUSE.accent), `legacy style (${name}): did not expect the house accent anywhere`);
    assert.ok(svg.includes(`fill="${LEGACY.paper}"`), `legacy style (${name}): page background must keep the old paper colour`);
  }
  const qa = runRenderQa({ desktop: bundle.desktop.svg, mobile: bundle.mobile.svg });
  assert.equal(qa.passed, true, JSON.stringify(qa.viewports));
  console.log("legacy style: page chrome keeps its old hardcoded colours, render-QA clean: PASS");
}

// --- 2b. House vs. legacy chrome (outside hero_stat, fix 9's own separate
//         scope - see check #4) differs by *only* the five swapped hex
//         values and (as of fix 12) each style's own font-family choice -
//         normalizing both out of both SVGs must leave byte-identical
//         strings, proving fix 7 (and fix 12) are a pure colour/font swap
//         with no structural/layout/text side effect (a stronger, more
//         direct check than re-deriving individual role assertions above).
//         Font-family is stripped to one fixed placeholder rather than
//         swap-mapped like the five colours, because fix 12 deliberately
//         makes the two styles' own mapping asymmetric: house collapses
//         SANS and SERIF onto the same single CJK stack, while legacy keeps
//         its original two, distinct Arial/Georgia stacks - swap-mapping
//         each style's SANS/SERIF the way the colours are would fail on
//         exactly that intended asymmetry rather than on a real regression.
//         See scripts/test_house_style_fonts.mjs for that asymmetry's own
//         dedicated assertions. hero_stat is excluded here: since fix 9, its
//         own structure (a filled card under legacy vs. a thin rule under
//         house) genuinely differs between styles, not just its colours, so
//         it has no place in a "pure colour/font swap" comparison - check #4
//         covers it instead.
{
  const houseSvg = withoutHeroStat(composeInfographicBundle(baseSpec(), {}).desktop.svg);
  const legacySvg = withoutHeroStat(composeInfographicBundle(baseSpec({ style_id: "legacy" }), {}).desktop.svg);
  const stripFontFamily = (svg) => svg.replace(/font-family="[^"]*"/g, 'font-family="FONT"');
  const normalize = (svg, colors) => stripFontFamily(svg)
    .replaceAll(colors.ink, "INK").replaceAll(colors.muted, "MUTED")
    .replaceAll(colors.grid, "GRID").replaceAll(colors.accent, "ACCENT").replaceAll(colors.paper, "PAPER");
  const houseNormalized = normalize(houseSvg, HOUSE);
  const legacyNormalized = normalize(legacySvg, LEGACY);
  assert.equal(houseNormalized, legacyNormalized, "house and legacy chrome (outside hero_stat) must be identical once each style's own five colours and its own font-family choice are normalized out - any remaining difference would mean fix 7/fix 12 changed more than colour/font");
  console.log("house vs. legacy: chrome outside hero_stat differs by exactly the five swapped colours plus font-family, nothing else structural: PASS");
}

// --- 3. Same NEWSROOM_HOUSE_STYLE=legacy env fallback viz.mjs itself uses --
{
  const prior = process.env.NEWSROOM_HOUSE_STYLE;
  process.env.NEWSROOM_HOUSE_STYLE = "legacy";
  try {
    const bundle = composeInfographicBundle(baseSpec(), {});
    assert.ok(bundle.desktop.svg.includes(LEGACY.accent), "NEWSROOM_HOUSE_STYLE=legacy must fall back to legacy colours, same as viz.mjs");
    assert.ok(!bundle.desktop.svg.includes(HOUSE.accent), "NEWSROOM_HOUSE_STYLE=legacy must not use the house accent");
  } finally {
    if (prior === undefined) delete process.env.NEWSROOM_HOUSE_STYLE;
    else process.env.NEWSROOM_HOUSE_STYLE = prior;
  }
  console.log("NEWSROOM_HOUSE_STYLE=legacy env fallback: matches viz.mjs's own precedence: PASS");
}

// --- 4. hero_stat: fix 7 left its *legacy* rendering alone (still the old
//        tone-coloured filled card, on the old hex values); fix 9 (its own,
//        separate, droppable commit - see test_hero_stat_restyle.mjs for
//        its full contract) is what changed its house-style rendering to a
//        thin accent rule with no filled card. -----------------------------
{
  const houseBundle = composeInfographicBundle(baseSpec(), {});
  const legacyBundle = composeInfographicBundle(baseSpec({ style_id: "legacy" }), {});
  for (const [name, house, legacy] of [
    ["desktop", houseBundle.desktop.svg, legacyBundle.desktop.svg],
    ["mobile", houseBundle.mobile.svg, legacyBundle.mobile.svg],
  ]) {
    const houseHero = heroStatBlock(house);
    const legacyHero = heroStatBlock(legacy);
    assert.notEqual(houseHero, legacyHero, `hero_stat (${name}) must now render differently under house style than under legacy - that is fix 9's whole point:\n${houseHero}`);
    // Legacy: still the pre-existing accent-tone filled card, byte-for-byte -
    // fix 7 must not have reached into it.
    assert.ok(/rx="5"/.test(legacyHero), `hero_stat (${name}) legacy must keep its old rounded filled card: ${legacyHero}`);
    assert.ok(legacyHero.includes(LEGACY.accent), `hero_stat (${name}) legacy must still use the original accent-tone fill: ${legacyHero}`);
    assert.ok(!legacyHero.includes(HOUSE.accent), `hero_stat (${name}) legacy must not use the house accent: ${legacyHero}`);
  }
  console.log("hero_stat: fix 7 left its legacy rendering untouched (fix 9 is what changed house style): PASS");
}

console.log("infographic house-style wiring regression: PASS");
