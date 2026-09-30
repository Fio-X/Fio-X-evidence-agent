#!/usr/bin/env node
// Covers the generic rule (not an Africa/topic-specific special case): a
// choropleth's color channel may pass infographic lint's
// visual_channel.color_only_quantity blocker only when the module's own
// render-QA report proves, from the rendered SVG and bound to it by
// sha256, that every plotted region's value shows as complete, exact,
// legible text (runtime/pi/editorial_validators.mjs's
// choroplethValueLabelsProven, runtime/pi/render_qa_labels.mjs). Also
// covers the THEMATIC_MAP editorial grammar (config/editorial-grammar-
// registry.json) as the first grammar to allow the 'spatial' visual
// grammar outside CUTAWAY/ROUTE_SPINE.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { visualChannelOwnerValidator, grammarCompatibilityValidator, runEditorialValidators } from "../runtime/pi/editorial_validators.mjs";

const registry = JSON.parse(await readFile(new URL("../config/editorial-grammar-registry.json", import.meta.url), "utf8"));

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const desktopSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><title>t</title></svg>';
const mobileSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 100"><title>t</title></svg>';

function passingRenderQa() {
  const viewport = (svg) => ({ svg_sha256: sha256(svg), passed: true, value_labels: { passed: true, checked: 2, failures: [] } });
  return { schema_version: "render-qa/1.0.0", passed: true, viewports: { desktop: viewport(desktopSvg), mobile: viewport(mobileSvg) } };
}

function choroplethModule() {
  return {
    id: "map",
    type: "visual",
    manifest_ref: "visualizations/map.json",
    visual_grammar: "spatial",
    visual_channels: [{ channel: "color", field: "value", role: "quantitative" }],
  };
}

function nonChoroplethColorOnlyModule() {
  return {
    id: "bar",
    type: "visual",
    manifest_ref: "visualizations/bar.json",
    visual_grammar: "distribution",
    visual_channels: [{ channel: "color", field: "value", role: "quantitative" }],
  };
}

// --- a choropleth with a proven, hash-bound, passing value_labels report is
//     exempt from color_only_quantity -------------------------------------
{
  const spec = { schema_version: "1.5.0", modules: [choroplethModule()] };
  const assets = { "visualizations/map.json": { manifest: { chart_type: "choropleth" }, desktopSvg, mobileSvg, renderQa: passingRenderQa() } };
  const issues = visualChannelOwnerValidator(spec, assets);
  assert.deepEqual(issues, [], JSON.stringify(issues));
}
console.log("exemption: a choropleth with a proven passing value_labels report is exempt from color_only_quantity -- PASS");

// --- non-choropleth color-only quantity is still blocked, even with the same
//     "proof" shape (chart_type gate cannot be spoofed by any other chart) --
{
  const spec = { schema_version: "1.5.0", modules: [nonChoroplethColorOnlyModule()] };
  const assets = { "visualizations/bar.json": { manifest: { chart_type: "bar" }, desktopSvg, mobileSvg, renderQa: passingRenderQa() } };
  const issues = visualChannelOwnerValidator(spec, assets);
  assert.ok(issues.some((i) => i.rule_id === "visual_channel.color_only_quantity"), JSON.stringify(issues));
}
console.log("exemption: a non-choropleth color-only-quantity module is still blocked -- PASS");

// --- no renderQa at all: still blocked --------------------------------------
{
  const spec = { schema_version: "1.5.0", modules: [choroplethModule()] };
  const assets = { "visualizations/map.json": { manifest: { chart_type: "choropleth" }, desktopSvg, mobileSvg } };
  const issues = visualChannelOwnerValidator(spec, assets);
  assert.ok(issues.some((i) => i.rule_id === "visual_channel.color_only_quantity"), JSON.stringify(issues));
}
console.log("exemption: a choropleth with no render_qa report at all is still blocked -- PASS");

// --- value_labels present but failing: still blocked ------------------------
{
  const spec = { schema_version: "1.5.0", modules: [choroplethModule()] };
  const qa = passingRenderQa();
  qa.viewports.desktop.value_labels = { passed: false, checked: 2, failures: [{ rule: "value_label_missing", message: "fixture" }] };
  const assets = { "visualizations/map.json": { manifest: { chart_type: "choropleth" }, desktopSvg, mobileSvg, renderQa: qa } };
  const issues = visualChannelOwnerValidator(spec, assets);
  assert.ok(issues.some((i) => i.rule_id === "visual_channel.color_only_quantity"), JSON.stringify(issues));
}
console.log("exemption: a choropleth whose value_labels check failed is still blocked -- PASS");

// --- value_labels missing on one viewport (e.g. mobile omitted from the
//     report though the module has a mobile SVG): still blocked ------------
{
  const spec = { schema_version: "1.5.0", modules: [choroplethModule()] };
  const qa = passingRenderQa();
  delete qa.viewports.mobile.value_labels;
  const assets = { "visualizations/map.json": { manifest: { chart_type: "choropleth" }, desktopSvg, mobileSvg, renderQa: qa } };
  const issues = visualChannelOwnerValidator(spec, assets);
  assert.ok(issues.some((i) => i.rule_id === "visual_channel.color_only_quantity"), JSON.stringify(issues));
}
console.log("exemption: a choropleth missing a value_labels check on any one viewport is still blocked -- PASS");

// --- a stale/hash-mismatched report (the SVG on disk right now does not match
//     what the report's svg_sha256 says it checked) is still blocked, exactly
//     as a tampered SVG would be caught by the verifiers ------------------
{
  const spec = { schema_version: "1.5.0", modules: [choroplethModule()] };
  const qa = passingRenderQa();
  const assets = { "visualizations/map.json": { manifest: { chart_type: "choropleth" }, desktopSvg: desktopSvg + "<!-- tampered -->", mobileSvg, renderQa: qa } };
  const issues = visualChannelOwnerValidator(spec, assets);
  assert.ok(issues.some((i) => i.rule_id === "visual_channel.color_only_quantity"), JSON.stringify(issues));
}
console.log("exemption: a hash-mismatched (stale/tampered) render_qa report is still blocked -- PASS");

// --- THEMATIC_MAP: the new grammar allows 'spatial' generically, and it is
//     usable as a primary selection (not a page-specific carve-out) -------
{
  const entry = (registry.grammars ?? []).find((g) => g.id === "THEMATIC_MAP");
  assert.ok(entry, "THEMATIC_MAP should be registered");
  assert.deepEqual(entry.compatible_visual_grammars, ["spatial"]);

  const spec = { modules: [choroplethModule()], editorial_grammar: { primary: "THEMATIC_MAP", supporting: [] } };
  const issues = grammarCompatibilityValidator(spec, registry);
  assert.deepEqual(issues, [], JSON.stringify(issues));
}
console.log("exemption: THEMATIC_MAP registers 'spatial' as a compatible visual grammar -- PASS");

// --- runEditorialValidators wiring: assets flow through end to end, so the
//     exemption is reachable from the same entrypoint infographic lint uses
{
  const spec = { schema_version: "1.5.0", modules: [choroplethModule()] };
  const assets = { "visualizations/map.json": { manifest: { chart_type: "choropleth" }, desktopSvg, mobileSvg, renderQa: passingRenderQa() } };
  const report = runEditorialValidators(spec, assets, { editorial_grammar_registry: registry });
  assert.ok(!report.issues.some((i) => i.rule_id === "visual_channel.color_only_quantity"), JSON.stringify(report.issues));
}
console.log("exemption: reachable end to end via runEditorialValidators (the entrypoint infographic lint uses) -- PASS");

console.log("choropleth lint exemption: PASS");
