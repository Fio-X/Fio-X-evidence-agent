// 1012i (K223, K237): NEWSROOM_GUIDE_ERRORS=1 (exact "1", default off) only rewrites the text of two misleading blockers. What is blocked is the same on and off.
import assert from "node:assert/strict";
import { lintInfographicSpec } from "../runtime/pi/infographic.mjs";
import { COMPACT_CHART_TYPES, hasCompactVariant } from "../runtime/pi/viz.mjs";

let n = 0;
const same = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
const ok = (c, m) => { assert.ok(c, m); n++; };
const KEY = "NEWSROOM_GUIDE_ERRORS";

// ---- 1. width blockers ----
const spec = (chartA, chartB, scene, span = "full") => ({
  schema_version: "1.5.0", language: "en", title: "T", dek: "D",
  scene_graph: { schema_version: "0.2.0", scenes: [scene] },
  modules: [
    { id: "a", type: "visual", span, manifest_ref: "visualizations/a.json" },
    { id: "b", type: "visual", span: "full", manifest_ref: "visualizations/b.json" },
    { id: "ill", type: "illustration", span: "full", asset_ref: "illustrations/i.json" },
  ],
});
const asset = (chart_type, compact = false) => ({ desktopSvg: "<svg/>", ...(compact ? { compactSvg: "<svg/>" } : {}), manifest: { chart_type } });
const assets = (a, b) => ({ "visualizations/a.json": a, "visualizations/b.json": b, "illustrations/i.json": { desktopSvg: "<svg/>", manifest: { kind: "illustration" } } });
const blockersOf = (s, a) => { const lint = lintInfographicSpec(s, a, { mobile_pages: false }); return (lint.blockers ?? []).filter((b) => /columns in scene|must use span 'full'/.test(b)); };
const stack = { id: "s1", pattern: "hero_sidecar_stack", anchor_module_id: "b", sidecar_module_ids: ["a"] };
const rail = { id: "s1", pattern: "hero_with_rail", anchor_module_id: "b", sidecar_module_ids: ["a", "ill"] };

const types = [...COMPACT_CHART_TYPES];
ok(types.includes("horizontal_bar") && !hasCompactVariant({ chart_type: "heatmap" }), "fixture types: bar has an 8-column variant, heatmap does not");
for (const [label, s, a] of [
  ["narrow span, bar", spec(0, 0, stack, "half"), assets(asset("horizontal_bar", true), asset("horizontal_bar", true))],
  ["narrow span, heatmap", spec(0, 0, stack, "half"), assets(asset("heatmap"), asset("heatmap"))],
  ["4-col sidecar, bar", spec(0, 0, stack), assets(asset("horizontal_bar", true), asset("horizontal_bar", true))],
  ["4-col sidecar, heatmap", spec(0, 0, stack), assets(asset("heatmap"), asset("heatmap"))],
  ["rail with 2 sidecars", spec(0, 0, rail), assets(asset("heatmap"), asset("heatmap"))],
]) {
  delete process.env[KEY];
  const off = blockersOf(s, a);
  ok(off.length > 0, `${label}: blocked with the switch off`);
  for (const v of ["0", "true", ""]) { process.env[KEY] = v; same(blockersOf(s, a), off, `${label}: ${JSON.stringify(v)} is off, text unchanged`); }
  process.env[KEY] = "1";
  const on = blockersOf(s, a);
  same(on.length, off.length, `${label}: the same things are blocked on and off`);
  same(on.map((b) => b.match(/^\w+ '[^']+'/)[0]), off.map((b) => b.match(/^\w+ '[^']+'/)[0]), `${label}: the same modules are blocked`);
  const bar = /bar/.test(label), heat = /heatmap/.test(label);
  const chartBlocker = on.find((b) => b.startsWith("visual 'a'"));
  if (chartBlocker && bar) ok(/hero_sidecar_stack/.test(chartBlocker) && /8-column variant/.test(chartBlocker) && /below the chart, not beside it/.test(chartBlocker), chartBlocker);
  if (chartBlocker && heat) ok(/no 8-column variant/.test(chartBlocker) && /hero_with_rail/.test(chartBlocker) && /below the chart, not beside it/.test(chartBlocker) && !/there is no compact chart variant/.test(chartBlocker), chartBlocker);
  ok(!on.some((b) => /there is no compact chart variant/.test(b)), `${label}: the misleading sentence is gone`);
}
// the wording follows the asset's own compact SVG, not the chart type name
process.env[KEY] = "1";
const noSvg = blockersOf(spec(0, 0, stack), assets(asset("horizontal_bar"), asset("horizontal_bar"))).find((b) => b.startsWith("visual 'a'"));
ok(noSvg && /no 8-column variant/.test(noSvg), "bar type without compactSvg: says no 8-column variant");
const withSvg = blockersOf(spec(0, 0, stack, "half"), assets(asset("heatmap", true), asset("heatmap", true))).find((b) => b.startsWith("visual 'a'"));
ok(withSvg && /hero_sidecar_stack/.test(withSvg) && !/no 8-column variant/.test(withSvg), "heatmap type with compactSvg: points to hero_sidecar_stack");
delete process.env[KEY];
// the illustration blockers say it has no 8-column variant
process.env[KEY] = "1";
const illOn = blockersOf(spec(0, 0, { id: "s1", pattern: "hero_sidecar_stack", anchor_module_id: "b", sidecar_module_ids: ["ill"] }), assets(asset("heatmap"), asset("heatmap"))).filter((b) => b.startsWith("illustration"));
ok(illOn.length > 0 && illOn.every((b) => /no 8-column variant/.test(b) && /hero_with_rail/.test(b)), JSON.stringify(illOn));
delete process.env[KEY];
console.log(`test_guide_errors (width): ${n} checks passed`);
