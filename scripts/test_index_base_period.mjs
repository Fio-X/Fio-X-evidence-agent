#!/usr/bin/env node
// index_base needs a real base period: one x value at which every panel equals index_base (relative tolerance
// 1e-9), else INDEX_BASE_NOT_IN_DATA naming the panels that lack it; the label reads "<x> = <base>" and shows
// exactly once (above the first row of panels when no panel has a clear spot); and index_base is refused
// unless the chart is small_multiples with panel_mark "line". Synthetic data only.
import assert from "node:assert/strict";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";
import { lintVizSpec, renderVizBundle, validateVizSpec } from "../runtime/pi/viz.mjs";

const base = {
  schema_version: "0.9.0", takeaway: "t", title: "Index", subtitle: "synthetic", alt: "A synthetic rebased index chart used to check the base period.",
  source_note: "synthetic fixture", claim_id: "claim-index", sql: "SELECT 1", annotations: [], highlight_values: [], direct_labels: true, language: "zh",
  verification_mode: "draft", reader_task: "change", chart_type: "small_multiples", panel_mark: "line", x_field: "x", value_field: "v", facet_field: "f", unit: "点",
};
const spec = { ...base, index_base: 100 };
const rowsFor = (panels, valueAt) => panels.flatMap((f, k) => [0, 1, 2, 3, 4].map((i) => ({ f, x: `2023-0${i + 1}`, v: valueAt(k, i) })));
const good = rowsFor(["甲", "乙", "丙"], (k, i) => 100 + (k + 1) * i);
const blockers = (s, rows) => lintVizSpec(s, rows, {}).blockers;
const codes = (s, rows) => blockers(s, rows).filter((b) => b.startsWith("INDEX_BASE_"));
const labelsOf = (svg) => [...svg.matchAll(/<text [^>]*data-role="index-base-label"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

// the base period exists: lint accepts it, and the label names it like the x axis
assert.deepEqual(codes(spec, good), [], "a real base period passes");
assert.deepEqual(labelsOf(renderVizBundle(spec, good, { mobilePages: false }).desktop), ["2023-01 = 100"]);
assert.deepEqual(labelsOf(renderVizBundle({ ...spec, language: "en" }, good, { mobilePages: false }).desktop), ["2023-01 = 100"]);
// within a relative tolerance of 1e-9
assert.deepEqual(codes(spec, rowsFor(["甲", "乙"], (k, i) => (i === 2 ? 100 * (1 + 5e-10) : 90 + i))), [], "inside the tolerance");
// a panel without the base period is named; no panel having it at all names every panel
{
  const rows = rowsFor(["甲", "乙", "丙"], (k, i) => (k === 1 ? 101 + i : 100 + i));
  const found = codes(spec, rows);
  assert.equal(found.length, 1, `one refusal: ${found}`);
  assert.match(found[0], /^INDEX_BASE_NOT_IN_DATA/);
  assert.match(found[0], /乙/);
  assert.doesNotMatch(found[0].split("panels without it:")[1] ?? "", /甲|丙/, "only the lacking panel is named");
  assert.match(found[0], /rebase in SQL/);
  assert.match(found[0], /drop index_base/);
  const none = codes(spec, rowsFor(["甲", "乙"], (k, i) => 101 + i));
  assert.match(none[0], /INDEX_BASE_NOT_IN_DATA/);
  assert.ok(none[0].includes("甲") && none[0].includes("乙"), "every panel named when none holds the base");
  // each panel reaches 100, but never at the same x
  const shifted = codes(spec, rowsFor(["甲", "乙"], (k, i) => (i === k ? 100 : 105)));
  assert.match(shifted[0] ?? "", /INDEX_BASE_NOT_IN_DATA/, "no single x shared by every panel");
}
// the renderer never draws a base that is not in the data
assert.throws(() => renderVizBundle(spec, rowsFor(["甲", "乙"], (k, i) => 101 + i), { mobilePages: false }), /INDEX_BASE_NOT_IN_DATA/);
// applicability: small_multiples with panel_mark line only
for (const bad of [{ panel_mark: "dot" }, { chart_type: "line" }, { chart_type: "horizontal_bar" }]) {
  const found = validateVizSpec({ ...spec, ...bad }).filter((e) => e.startsWith("INDEX_BASE_NOT_APPLICABLE"));
  assert.equal(found.length, 1, `index_base refused on ${JSON.stringify(bad)}`);
}
assert.deepEqual(validateVizSpec(spec).filter((e) => e.includes("index_base")), []);
// the old labels are gone
{
  const svg = renderVizBundle(spec, good, { mobilePages: false }).desktop;
  assert.ok(!svg.includes("基期 = ") && !/base = 100/.test(svg), "no bare 基期 / base label");
}
// zigzag: no clear spot in any panel; the label still shows exactly once, above the first row, QA clean
{
  const months = (i) => `${2023 + Math.floor(i / 12)}-${String(1 + (i % 12)).padStart(2, "0")}`;
  const rows = ["甲", "乙", "丙", "丁"].flatMap((f) => Array.from({ length: 40 }, (_, i) => ({ f, x: months(i), v: i === 0 ? 100 : i % 2 ? 97 : 103 })));
  const svg = renderVizBundle(spec, rows, { mobilePages: false }).desktop;
  assert.deepEqual(labelsOf(svg), ["2023-01 = 100"], "zigzag: exactly one label");
  assert.equal(checkSvgGeometry(svg).failures.length, 0, "zigzag: render QA geometry clean");
}
console.log("index_base period: all checks passed");
