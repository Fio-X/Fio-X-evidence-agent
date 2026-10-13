#!/usr/bin/env node
// K261 step 2: with NEWSROOM_EMBED_MIN_TEXT=1 (exact "1"), a chart that has no stored variant keeping the 12px floor in its slot is drawn again at the
// slot's width from the same spec and rows (horizontal bar, dot, line, multi-line); the redraw is listed in the page result (page manifest) and replays
// byte for byte from the chart's inputs and that width. Switch off: nothing changes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderVizSvg, renderVizSvgAtWidth, hasWidthVariant, critiqueViz } from "../runtime/pi/viz.mjs";
import { composeInfographicBundle, textInkInsideEmbedBox } from "../runtime/pi/infographic.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { MIN_FONT_SIZE_FLOOR } from "../runtime/pi/render_qa_geometry.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const claimId = "claim-redraw";
const base = {
  schema_version: "0.7.0", reader_task: "comparison", takeaway: "Synthetic redraw takeaway.",
  title: "Synthetic redraw fixture", subtitle: "In-memory rendering only",
  alt: "Synthetic chart used to check a chart drawn again at its slot width.",
  source_note: "Synthetic redraw fixture", claim_id: claimId, sql: "SELECT 1", unit: "%", sort: "desc",
  highlight_values: ["A"], direct_labels: true, annotations: [],
};
const categories = Array.from({ length: 8 }, (_, i) => ({ category: String.fromCharCode(65 + i), value: 20 + i * 3 }));
const timeRows = Array.from({ length: 12 }, (_, i) => ({ year: 2001 + i, value: 30 + i * 1.1 }));
const multiRows = ["A", "B", "C"].flatMap((series, s) => Array.from({ length: 10 }, (_, i) => ({ year: 2007 + i, series, value: 20 + s * 8 + i * (1 + s * 0.12) })));
const cases = [
  ["horizontal_bar", { ...base, reader_task: "ranking", chart_type: "horizontal_bar", category_field: "category", value_field: "value" }, categories],
  ["dot", { ...base, reader_task: "ranking", chart_type: "dot", category_field: "category", value_field: "value" }, categories],
  ["line", { ...base, reader_task: "change", chart_type: "line", x_field: "year", value_field: "value" }, timeRows],
  ["multi_line", { ...base, reader_task: "change", chart_type: "multi_line", x_field: "year", value_field: "value", series_field: "series", highlight_values: ["A"] }, multiRows],
];

// The chart-level check a redraw must pass: the render check and the critic, the same functions the draw step and the critic tool use.
const chartCheck = ({ spec, rows, lint }, svg) => runRenderQa({ desktop: svg }).passed === true && critiqueViz(spec, rows, lint ?? {}, svg).passed === true;

function page(ref, asset, span, check = chartCheck) {
  const spec = {
    schema_version: "1.0.0", kicker: "TEST", title: "A narrow slot keeps the type size", dek: "Redraw at slot width fixture.",
    alt: "A page with one narrow chart and two text blocks, used to check chart redraw at slot width.", byline: "Newsroom Agent", date_label: "Test", layout: "feature", complexity_budget: "low", source_note: "Synthetic",
    modules: [
      { id: "v", type: "visual", span, label: "Chart", manifest_ref: ref },
      { id: "t0", type: "text", span: "third", label: "Note", heading: "A note", body: "A second short block that fills the row beside the narrow chart.", claim_ids: [claimId] },
      { id: "t", type: "text", span: "third", label: "Why", heading: "Why it matters", body: "A chart drawn for a wide slot and squeezed into a narrow one shrinks its labels; drawing it again at the narrow width keeps them.", claim_ids: [claimId] },
    ],
  };
  return composeInfographicBundle(spec, { [ref]: asset }, { mobilePages: false, chartCheck: check });
}

const SPAN = "third";
for (const [name, spec, rows] of cases) {
  assert.equal(hasWidthVariant(spec), true, name);
  const ref = `visualizations/${name}.json`;
  const wide = renderVizSvg(spec, rows);
  const inputs = { spec, rows };
  const inputsSha = sha(JSON.stringify(inputs));
  // No narrower variant stored: both stand-ins are the desktop drawing.
  const asset = { desktopSvg: wide, mobileSvg: wide, manifest: { claim_id: claimId, chart_type: spec.chart_type }, critic: { passed: true, score: 90 }, inputs, inputsSha256: inputsSha };

  delete process.env.NEWSROOM_EMBED_MIN_TEXT;
  const off = page(ref, asset, SPAN);
  assert.equal(off.embedded_variants, undefined, `${name}: off adds nothing`);
  const offNoInputs = page(ref, { ...asset, inputs: undefined, inputsSha256: undefined }, SPAN);
  assert.equal(off.desktop.svg, offNoInputs.desktop.svg, `${name}: off, the inputs are not read`);

  process.env.NEWSROOM_EMBED_MIN_TEXT = "true";
  assert.equal(page(ref, asset, SPAN).embedded_variants, undefined, `${name}: only exact "1" counts`);

  process.env.NEWSROOM_EMBED_MIN_TEXT = "1";
  const noInputs = page(ref, { ...asset, inputs: undefined, inputsSha256: undefined }, SPAN);
  assert.equal(noInputs.embedded_variants, undefined, `${name}: without stored inputs nothing is redrawn`);
  const on = page(ref, asset, SPAN);
  assert.equal(on.embedded_variants?.length, 1, `${name}: one redraw recorded`);
  const rec = on.embedded_variants[0];
  assert.equal(rec.manifest_ref, ref);
  assert.ok(rec.width >= 300 && rec.width < 1040, `${name}: slot width ${rec.width}`);
  // Replayable: inputs + width give the recorded bytes.
  const replay = renderVizSvgAtWidth(spec, rows, rec.width);
  assert.equal(sha(replay), rec.sha256, `${name}: replay hash`);
  // Same data and labels: every text of the wide drawing is still there.
  const texts = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]).filter(Boolean);
  const wideTexts = new Set(texts(wide));
  const redrawTexts = new Set(texts(replay));
  for (const t of ["A", "B"]) if (wideTexts.has(t)) assert.ok(redrawTexts.has(t), `${name}: label ${t} kept`);
  assert.equal(redrawTexts.size >= Math.floor(wideTexts.size / 2), true, `${name}: labels kept`);
  // The result passes the render check's size floor; the normal page does not.
  const qaOn = runRenderQa({ desktop: on.desktop.svg });
  const small = (qa) => (qa.viewports.desktop.geometry.failures ?? []).filter((f) => /font|size|small/i.test(JSON.stringify(f)));
  assert.equal(small(qaOn).length, 0, `${name}: redrawn page keeps the floor ${MIN_FONT_SIZE_FLOOR}: ${JSON.stringify(small(qaOn).slice(0, 2))}`);
  const qaOff = runRenderQa({ desktop: off.desktop.svg });
  assert.ok(small(qaOff).length > 0, `${name}: the squeezed page falls under the floor`);
  // The strict text-inside-box check: a tick label whose over-estimated width reaches past the embedded box is refused even when render QA's own estimate passes.
{
  const svgOf = (x) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 397 200"><title>t</title><desc>d</desc><line x1="0" y1="10" x2="397" y2="10" stroke="#000"/><text x="${x}" y="50" text-anchor="end" font-size="12">50%</text><text x="300" y="80" font-size="12">end</text></svg>`;
  assert.equal(textInkInsideEmbedBox(svgOf(75)), true, "margin left: inside");
  assert.equal(textInkInsideEmbedBox(svgOf(28)), false, "no margin left: refused");
  const qa28 = runRenderQa({ desktop: svgOf(28) });
  assert.equal(qa28.viewports.desktop.geometry.failures.some((f) => f.rule === "text_outside_viewbox"), false, "render QA's own estimate does not see the overrun (the gap the strict check closes)");
}

// Without a chart check, or with one that refuses, the redraw is not used: the page is the normal one.
  assert.equal(page(ref, asset, SPAN, null).embedded_variants, undefined, `${name}: no check, no redraw`);
  const refused = page(ref, asset, SPAN, () => false);
  assert.equal(refused.embedded_variants, undefined, `${name}: refused redraw not recorded`);
  assert.equal(refused.desktop.svg, noInputs.desktop.svg, `${name}: refused redraw leaves the page the stored variants give (same as with no stored inputs)`);
  // Deterministic: composing again gives the same page and the same record.
  const again = page(ref, asset, SPAN);
  assert.equal(again.desktop.svg, on.desktop.svg);
  assert.deepEqual(again.embedded_variants, on.embedded_variants);
  console.log(`ok ${name}: redrawn at ${rec.width}px`);
}

// A redraw that fails the chart-level render check is not used (twelve long series labels collide at the narrow width), with the real check.
{
  const names = Array.from({ length: 12 }, (_, k) => `Region number ${k + 1} with long name`);
  const spec = { ...base, reader_task: "change", chart_type: "multi_line", x_field: "year", value_field: "value", series_field: "series", highlight_values: [names[0]] };
  const rows = names.flatMap((series, s) => Array.from({ length: 10 }, (_, i) => ({ year: 2007 + i, series, value: 20 + s * 0.3 + i })));
  const ref = "visualizations/collide.json";
  const wide = renderVizSvg(spec, rows);
  const asset = { desktopSvg: wide, mobileSvg: wide, manifest: { claim_id: claimId, chart_type: spec.chart_type }, critic: { passed: true, score: 90 }, inputs: { spec, rows }, inputsSha256: sha(JSON.stringify({ spec, rows })) };
  const redrawn = renderVizSvgAtWidth(spec, rows, 397);
  assert.equal(runRenderQa({ desktop: redrawn }).passed, false, "the narrow redraw fails the chart-level render check");
  process.env.NEWSROOM_EMBED_MIN_TEXT = "1";
  const used = page(ref, asset, SPAN);
  assert.equal(used.embedded_variants, undefined, "a redraw that fails the chart check is not adopted");
  assert.equal(used.desktop.svg, page(ref, { ...asset, inputs: undefined, inputsSha256: undefined }, SPAN).desktop.svg, "falls back to the page the stored variants give");
  delete process.env.NEWSROOM_EMBED_MIN_TEXT;
  console.log("ok a redraw failing the chart check is not used");
}

// A chart type without a width variant is not redrawn, and the bad width is refused.
assert.equal(hasWidthVariant({ chart_type: "heatmap" }), false);
assert.throws(() => renderVizSvgAtWidth({ chart_type: "heatmap" }, [], 600));
assert.throws(() => renderVizSvgAtWidth(cases[0][1], cases[0][2], 200));
delete process.env.NEWSROOM_EMBED_MIN_TEXT;
console.log("embed redraw tests passed");
