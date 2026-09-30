#!/usr/bin/env node
// Fix 10 regression test: hero_stat's label rendered twice. drawModuleChrome
// draws every module's own rail kicker ("01 · LABEL") from the same
// module.label field drawHeroStat already prints, large, directly under the
// numeral - so a hero_stat module's label appeared twice on the page, once
// tiny at the top of its box and once as its own big caption. Fix:
// drawModuleChrome now skips hero_stat entirely (hairline included, the same
// way it already skips section_header), rather than keeping the hairline
// and only dropping the label - hero_stat's own accent top rule (fix 9)
// already marks its top edge under house style, so a second, chrome-drawn
// hairline there would be redundant too. This applies to both styles: the
// duplicate-label bug is structural, not a house-vs-legacy colour choice.
import assert from "node:assert/strict";
import { composeInfographicBundle, validateInfographicSpec } from "../runtime/pi/infographic.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const claim = "claim-kicker-dedupe-fixture";
const heroLabel = "已核实的合成总量";
const textLabel = "说明";

function spec(styleOverride = {}) {
  return {
    schema_version: "1.0.0",
    kicker: "DATA FEATURE",
    title: "Hero stat kicker dedupe fixture",
    dek: "Regression fixture for drawModuleChrome's fix 10 contract.",
    alt: "A section header, a hero statistic and a text module fixture.",
    byline: "Newsroom Agent",
    date_label: "Regression edition",
    layout: "feature",
    complexity_budget: "low",
    source_note: "Synthetic kicker-dedupe regression fixture",
    language: "zh",
    ...styleOverride,
    modules: [
      { id: "section-1", type: "section_header", span: "full", eyebrow: "背景", heading: "章节标题", deck: "章节说明文字。" },
      { id: "stat-total", type: "hero_stat", span: "third", tone: "accent", value: "100", unit: "PJ", label: heroLabel, detail: "核实声明夹具", claim_id: claim },
      { id: "note", type: "text", span: "two_thirds", label: textLabel, heading: "正文标题", body: "这里是模块正文内容。", claim_ids: [claim] },
    ],
  };
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

for (const [name, styleOverride] of [["house", {}], ["legacy", { style_id: "legacy" }]]) {
  const s = spec(styleOverride);
  assert.deepEqual(validateInfographicSpec(s), [], `fixture (${name}) must validate`);
  const bundle = composeInfographicBundle(s, {});
  for (const [viewport, svg] of [["desktop", bundle.desktop.svg], ["mobile", bundle.mobile.svg]]) {
    // hero_stat's own label must appear exactly once (drawHeroStat's own big
    // caption) - not a second time in a rail kicker above it.
    assert.equal(countOccurrences(svg, heroLabel), 1, `${name}/${viewport}: hero_stat's label "${heroLabel}" must appear exactly once, not duplicated by a rail kicker`);
    // hero_stat must not draw a "01 · " (or any bare ordinal) kicker line at
    // all - drawModuleChrome must skip it completely, same as section_header.
    assert.ok(!svg.includes(`01 · ${heroLabel}`), `${name}/${viewport}: hero_stat must not draw its old "01 · label" rail kicker`);
    // The *other* content module (text, ordinal 02 - section_header is not
    // numbered) must still get its normal kicker: fix 10 must not silently
    // remove chrome from module types it was not asked to touch.
    assert.ok(svg.includes(`02 · ${textLabel}`), `${name}/${viewport}: the text module's own rail kicker must still render normally: ${svg.match(/\d{2} · [^<]*/g)}`);
  }
  const qa = runRenderQa({ desktop: bundle.desktop.svg, mobile: bundle.mobile.svg });
  assert.equal(qa.passed, true, `render-QA (${name}): ${JSON.stringify(qa.viewports)}`);
  console.log(`${name} style: hero_stat's rail kicker is gone, its label prints once, other modules' kickers are untouched, render-QA clean: PASS`);
}

console.log("hero_stat kicker dedupe (fix 10) regression: PASS");
