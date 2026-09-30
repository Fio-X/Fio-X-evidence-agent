#!/usr/bin/env node
// Fix 9 regression test (its own, separate, droppable commit): hero_stat's
// solid tone-coloured card ("dark"/"light"/"accent") is replaced under house
// style by a thin accent top rule, the numeral in accent on plain white, and
// the unit/label/detail in ink/muted like any other module's text. tone no
// longer selects a colour under house style - one accent, used the same way
// everywhere else on the page, replaces the three-tone card palette. Legacy
// style (style_id/style: "legacy", or NEWSROOM_HOUSE_STYLE=legacy) keeps the
// exact old per-tone card, byte-for-byte - see runtime/pi/infographic.mjs's
// drawHeroStat and its header comment.
//
// This test also surfaces (but does not fix - legacy style must stay
// unchanged, and it predates fix 9) a pre-existing contrast defect in the
// legacy tone="light" card: LEGACY_MUTED #69727a on FAINT #f4f2ee is 4.38:1
// for the detail text, just under the 4.5:1 floor. See composeHero's
// knownPreexistingContrastDefect handling below.
import assert from "node:assert/strict";
import { composeInfographicBundle, validateInfographicSpec } from "../runtime/pi/infographic.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const HOUSE_ACCENT = "#D0021B";
const HOUSE_INK = "#1A1A1A";
const HOUSE_MUTED = "#666666";
const LEGACY_ACCENT = "#c9473d";
const LEGACY_INK = "#1d2329";
const LEGACY_MUTED = "#69727a";
const DARK = "#24313a";
const FAINT = "#f4f2ee";
const ACCENT_MUTED_TINT = "#fefcfc";
const DARK_MUTED_TINT = "#f5d9d5";

function claimSpec(tone, styleOverride = {}) {
  const claim = "claim-hero-stat-fixture";
  return {
    schema_version: "1.0.0",
    kicker: "DATA FEATURE",
    title: "Hero stat restyle fixture",
    dek: "Regression fixture for drawHeroStat's fix 9 contract.",
    alt: "A hero_stat module fixture exercising every tone.",
    byline: "Newsroom Agent",
    date_label: "Regression edition",
    layout: "feature",
    complexity_budget: "low",
    source_note: "Synthetic hero_stat regression fixture",
    language: "zh",
    ...styleOverride,
    modules: [
      { id: "section-1", type: "section_header", span: "full", eyebrow: "背景", heading: "章节标题", deck: "章节说明文字。" },
      { id: "stat-total", type: "hero_stat", span: "third", tone, value: "100", unit: "PJ", label: "已核实的合成总量", detail: "核实声明夹具", claim_id: claim },
      { id: "note", type: "text", span: "two_thirds", label: "说明", heading: "正文标题", body: "这里是模块正文内容。", claim_ids: [claim] },
    ],
  };
}

function heroStatBlock(svg) {
  const lines = svg.split("\n");
  const idx = [];
  lines.forEach((l, i) => { if (l.includes('data-role="hero-stat"')) idx.push(i); });
  assert.ok(idx.length >= 2, `expected a hero-stat start+end marker pair in: ${svg.slice(0, 200)}...`);
  return lines.slice(idx[0], idx[idx.length - 1] + 1).join("\n");
}

function composeHero(tone, styleOverride, opts = {}) {
  const spec = claimSpec(tone, styleOverride);
  assert.deepEqual(validateInfographicSpec(spec), [], `fixture (tone=${tone}) must validate`);
  const bundle = composeInfographicBundle(spec, {});
  const qa = runRenderQa({ desktop: bundle.desktop.svg, mobile: bundle.mobile.svg });
  if (!qa.passed && opts.knownPreexistingContrastDefect) {
    // Pre-existing defect in the untouched legacy path, out of fix 9's
    // scope: LEGACY_MUTED #69727a on FAINT #f4f2ee (tone="light" hero_stat
    // detail text) is 4.38:1, just under the 4.5:1 floor for 12px normal
    // text. This is the exact old, hardcoded pairing - fix 9's legacy branch
    // is byte-for-byte the pre-existing code - and was never caught before
    // because no prior test exercised tone="light" with a detail string
    // through render-QA. Not fixed here (legacy style must stay unchanged;
    // see this file's own header comment and AGENTS.md's "report the
    // smallest proposed fix instead of silently changing source"). Assert
    // it fails for *only* this known reason, so this stays a real regression
    // check: a new or different failure here still fails the test.
    for (const [name, viewport] of Object.entries(qa.viewports)) {
      assert.equal(viewport.geometry.passed, true, `unexpected geometry failure (tone=${tone}, ${name}): ${JSON.stringify(viewport.geometry.failures)}`);
      assert.equal(viewport.contrast.failures.length, 1, `expected exactly the one known pre-existing contrast failure (tone=${tone}, ${name}): ${JSON.stringify(viewport.contrast.failures)}`);
      const f = viewport.contrast.failures[0];
      assert.equal(f.foreground, LEGACY_MUTED, `unexpected pre-existing contrast failure shape (tone=${tone}, ${name}): ${JSON.stringify(f)}`);
      assert.equal(f.background, FAINT, `unexpected pre-existing contrast failure shape (tone=${tone}, ${name}): ${JSON.stringify(f)}`);
    }
  } else {
    assert.equal(qa.passed, true, `render-QA (tone=${tone}, style=${JSON.stringify(styleOverride)}): ${JSON.stringify(qa.viewports)}`);
  }
  return { desktop: heroStatBlock(bundle.desktop.svg), mobile: heroStatBlock(bundle.mobile.svg) };
}

// --- 1. House style: no filled card, for every tone ------------------------
for (const tone of ["accent", "dark", "light"]) {
  const hero = composeHero(tone, {});
  for (const [name, block] of [["desktop", hero.desktop], ["mobile", hero.mobile]]) {
    assert.ok(!/rx="5"/.test(block), `house style (tone=${tone}, ${name}) must not draw the old rounded filled card: ${block}`);
    assert.ok(/height="3"/.test(block), `house style (tone=${tone}, ${name}) must draw the thin 3px top rule: ${block}`);
    assert.ok(block.includes(HOUSE_ACCENT), `house style (tone=${tone}, ${name}) numeral/rule must use the house accent: ${block}`);
    assert.ok(block.includes(HOUSE_INK), `house style (tone=${tone}, ${name}) label/unit must use house ink: ${block}`);
    assert.ok(block.includes(HOUSE_MUTED), `house style (tone=${tone}, ${name}) detail must use house muted: ${block}`);
    assert.ok(!block.includes(LEGACY_ACCENT) && !block.includes(DARK) && !block.includes(FAINT), `house style (tone=${tone}, ${name}) must not use any legacy tone colour: ${block}`);
  }
}
console.log("house style: no filled card, accent numeral + ink/muted text, for every tone: PASS");

// --- 2. House style output is identical regardless of tone - tone no longer
//        selects a colour once there is no card left to colour ------------
{
  const accent = composeHero("accent", {});
  const dark = composeHero("dark", {});
  const light = composeHero("light", {});
  assert.equal(accent.desktop, dark.desktop, "house style hero_stat must render identically for tone=accent and tone=dark (tone is legacy-card-only now)");
  assert.equal(accent.desktop, light.desktop, "house style hero_stat must render identically for tone=accent and tone=light (tone is legacy-card-only now)");
  console.log("house style: tone no longer affects hero_stat's colour: PASS");
}

// --- 3. Legacy style: byte-for-byte old per-tone card, for every tone -----
{
  const expect = {
    accent: { fill: LEGACY_ACCENT, fg: "#ffffff", muted: ACCENT_MUTED_TINT },
    dark: { fill: DARK, fg: "#ffffff", muted: DARK_MUTED_TINT },
    light: { fill: FAINT, fg: LEGACY_INK, muted: LEGACY_MUTED },
  };
  for (const tone of ["accent", "dark", "light"]) {
    const hero = composeHero(tone, { style_id: "legacy" }, { knownPreexistingContrastDefect: tone === "light" });
    for (const [name, block] of [["desktop", hero.desktop], ["mobile", hero.mobile]]) {
      assert.ok(/rx="5"/.test(block), `legacy style (tone=${tone}, ${name}) must keep the old rounded filled card: ${block}`);
      assert.ok(!/height="3"/.test(block), `legacy style (tone=${tone}, ${name}) must not draw fix 9's thin rule: ${block}`);
      assert.ok(block.includes(expect[tone].fill), `legacy style (tone=${tone}, ${name}) must keep its exact old card fill: ${block}`);
      assert.ok(block.includes(expect[tone].fg), `legacy style (tone=${tone}, ${name}) must keep its exact old foreground: ${block}`);
      assert.ok(block.includes(expect[tone].muted), `legacy style (tone=${tone}, ${name}) must keep its exact old detail tint: ${block}`);
      assert.ok(!block.includes(HOUSE_ACCENT) && !block.includes(HOUSE_INK) && !block.includes(HOUSE_MUTED), `legacy style (tone=${tone}, ${name}) must not use any house colour: ${block}`);
    }
  }
  console.log("legacy style: byte-for-byte old per-tone card, for every tone: PASS");
}

// --- 4. NEWSROOM_HOUSE_STYLE=legacy env fallback reaches hero_stat too ----
{
  const prior = process.env.NEWSROOM_HOUSE_STYLE;
  process.env.NEWSROOM_HOUSE_STYLE = "legacy";
  try {
    const hero = composeHero("accent", {});
    assert.ok(/rx="5"/.test(hero.desktop) && hero.desktop.includes(LEGACY_ACCENT), "NEWSROOM_HOUSE_STYLE=legacy must restore hero_stat's old filled card too");
  } finally {
    if (prior === undefined) delete process.env.NEWSROOM_HOUSE_STYLE;
    else process.env.NEWSROOM_HOUSE_STYLE = prior;
  }
  console.log("NEWSROOM_HOUSE_STYLE=legacy env fallback reaches hero_stat: PASS");
}

console.log("hero_stat restyle (fix 9) regression: PASS");
