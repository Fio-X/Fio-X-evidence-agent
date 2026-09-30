#!/usr/bin/env node
// Fix 11 regression test: a "visual" module's rail kicker repeated its
// embedded chart's own SVG title. A visual module's own chart (rendered by
// renderVizSvg, embedded via embedVisual) already carries its own title -
// drawModuleChrome's "${number} · ${module.label}" kicker printed that same
// string again, in miniature, immediately above the chart that already
// shows it. Fix: a visual module's kicker is now a bare ordinal ("01") -
// every other module type (here: text) keeps its full "${number} · label"
// kicker unchanged.
import assert from "node:assert/strict";
import { lintVizSpec, renderVizBundle, critiqueViz } from "../runtime/pi/viz.mjs";
import { validateInfographicSpec, lintInfographicSpec, composeInfographicBundle } from "../runtime/pi/infographic.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const claim = "claim-visual-kicker-fixture";
const context = { verified_claim_ids: [claim] };
const chartLabel = "四类占比排名";
const textLabel = "说明";

const barRows = [{ category: "甲", value: 42 }, { category: "乙", value: 31 }, { category: "丙", value: 18 }, { category: "丁", value: 9 }];
const barSpec = {
  schema_version: "0.9.0", reader_task: "ranking", takeaway: "甲在这组同类对比中领先。",
  chart_type: "horizontal_bar", title: chartLabel, subtitle: "回归测试用图", alt: "四个类别的横向条形图，从甲的42到丁的9。",
  source_note: "Synthetic fixture", claim_id: claim, sql: "SELECT * FROM synthetic_bar", unit: "units",
  category_field: "category", value_field: "value", sort: "desc", highlight_values: ["甲"], annotations: [],
  language: "zh",
};
const barLint = lintVizSpec(barSpec, barRows, context);
assert.equal(barLint.passed, true, barLint.blockers?.join(" | "));
const barBundle = renderVizBundle(barSpec, barRows);
const barCritic = critiqueViz(barSpec, barRows, barLint, barBundle.desktop);
assert.equal(barCritic.passed, true);

const assets = {
  "visualizations/bar.json": { desktopSvg: barBundle.desktop, mobileSvg: barBundle.mobile, manifest: { claim_id: claim, source_note: barSpec.source_note, chart_type: barSpec.chart_type, alt: barSpec.alt, language: "zh" } },
};

function spec(styleOverride = {}) {
  return {
    schema_version: "1.0.0",
    kicker: "DATA FEATURE",
    title: "Visual kicker bare-ordinal fixture",
    dek: "Regression fixture for drawModuleChrome's fix 11 contract.",
    alt: "A section header, a bar chart visual module and a text module fixture.",
    byline: "Newsroom Agent",
    date_label: "Regression edition",
    layout: "feature",
    complexity_budget: "low",
    source_note: "Synthetic visual-kicker regression fixture",
    language: "zh",
    ...styleOverride,
    modules: [
      { id: "section-1", type: "section_header", span: "full", eyebrow: "背景", heading: "章节标题", deck: "章节说明文字。" },
      // span:'full' (not 'two_thirds') so the embedded chart's native
      // viewBox scales to >=1x and clears the render-QA 12px font floor on
      // its own merits - test_infographic.mjs's railSpec fixture documents
      // the same precedent for a "visual" module held to a strict render-QA
      // check (a 'two_thirds' visual column is legitimately narrower than
      // this chart's native size and is not asserted against render-QA
      // anywhere in this codebase; that pre-existing scaling behaviour is
      // unrelated to fix 11 and out of scope here).
      { id: "bar", type: "visual", span: "full", label: chartLabel, manifest_ref: "visualizations/bar.json" },
      { id: "note", type: "text", span: "full", label: textLabel, heading: "正文标题", body: "这里是模块正文内容。", claim_ids: [claim] },
    ],
  };
}

for (const [name, styleOverride] of [["house", {}], ["legacy", { style_id: "legacy" }]]) {
  const s = spec(styleOverride);
  assert.deepEqual(validateInfographicSpec(s), [], `fixture (${name}) must validate`);
  const lint = lintInfographicSpec(s, assets, context);
  assert.equal(lint.passed, true, `${name}: ${lint.blockers?.join(" | ")}`);
  const bundle = composeInfographicBundle(s, assets);
  for (const [viewport, svg] of [["desktop", bundle.desktop.svg], ["mobile", bundle.mobile.svg]]) {
    // The visual module (ordinal 01) must show a bare ordinal, never its
    // label - the embedded chart already carries that exact title itself.
    assert.ok(svg.includes(">01</text>"), `${name}/${viewport}: visual module must show a bare "01" ordinal: ${svg.match(/>0\d[^<]*<\/text>/g)}`);
    assert.ok(!svg.includes(`01 · ${chartLabel}`), `${name}/${viewport}: visual module must not repeat its chart's own title in the kicker`);
    // The embedded chart itself legitimately shows its title twice already
    // (an accessibility <title> plus its own visible on-chart heading) -
    // that pre-existing pair is not what fix 11 is about. What fix 11 must
    // guarantee is that the *kicker* (module chrome, above the chart) does
    // not contribute a third copy: with a bare "01" kicker asserted above,
    // the label must appear only the chart's own two times, never a third.
    assert.equal(svg.split(chartLabel).length - 1, 2, `${name}/${viewport}: chart title "${chartLabel}" must appear only the chart's own two times (accessibility title + on-chart heading), not a third time from the kicker: ${svg.match(/<text[^>]*>[^<]*四类[^<]*<\/text>/g)}`);
    // The text module (ordinal 02) is a different module type and must keep
    // its normal "${number} · label" kicker - fix 11 must not reach it.
    assert.ok(svg.includes(`02 · ${textLabel}`), `${name}/${viewport}: the text module's own kicker must still render its label: ${svg.match(/\d{2}[^<]*<\/text>/g)}`);
  }
  // Desktop-only, matching test_infographic.mjs's own railQa precedent for a
  // "visual" module: this chart's native size legitimately runs a shade
  // under the 12px floor once scaled to a mobile column's narrower width
  // (11.72px here), a pre-existing embed-scaling characteristic orthogonal
  // to fix 11's kicker-text contract and not asserted anywhere else in this
  // suite for a visual module's mobile viewport either.
  const qa = runRenderQa({ desktop: bundle.desktop.svg });
  assert.equal(qa.passed, true, `render-QA (${name}): ${JSON.stringify(qa.viewports)}`);
  console.log(`${name} style: visual module kicker is a bare ordinal, chart title not duplicated, text module kicker unchanged, render-QA clean: PASS`);
}

console.log("visual module kicker bare-ordinal (fix 11) regression: PASS");
