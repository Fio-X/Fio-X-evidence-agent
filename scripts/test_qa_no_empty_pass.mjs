#!/usr/bin/env node
// NEWSROOM_QA_NO_EMPTY_PASS=1 (exact "1", default off): a render-QA rule that had no text or mark to look at is reported as a finding
// instead of passing. Off: the report is byte-identical to before.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa, checkEmptyPasses } from "../runtime/pi/render_qa.mjs";

const withSwitch = (v, fn) => {
  const old = process.env.NEWSROOM_QA_NO_EMPTY_PASS;
  if (v === undefined) delete process.env.NEWSROOM_QA_NO_EMPTY_PASS; else process.env.NEWSROOM_QA_NO_EMPTY_PASS = v;
  try { return fn(); } finally { if (old === undefined) delete process.env.NEWSROOM_QA_NO_EMPTY_PASS; else process.env.NEWSROOM_QA_NO_EMPTY_PASS = old; }
};
const lineSpec = { schema_version: "0.7.0", reader_task: "change", takeaway: "fixture", chart_type: "multi_line", title: "三国产量", alt: "三条线", source_note: "合成数据", claim_id: "c1", sql: "SELECT 1", unit: "指数", x_field: "year", value_field: "value", series_field: "series", direct_labels: true, annotations: [] };
const lineRows = ["甲国", "乙国", "丙国"].flatMap((s, i) => [2019, 2020, 2021, 2022].map((year, j) => ({ year, series: s, value: 10 + i * 20 + j * (i + 1) * 3 })));
const real = renderVizBundle(lineSpec, lineRows, { mobilePages: false }).desktop;
const empty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"></svg>';
const qa = (svg, v) => withSwitch(v, () => runRenderQa({ desktop: svg }));

// 1. off: unset/"0"/"true" never change the report, even on an empty SVG
for (const svg of [real, empty]) {
  const base = JSON.stringify(qa(svg, undefined));
  for (const v of ["0", "true", ""]) assert.equal(JSON.stringify(qa(svg, v)), base);
  assert.ok(!base.includes("extra_checks"));
}
assert.equal(qa(empty, undefined).passed, true, "the empty SVG passes today: that is the defect");
// 2. on + an SVG with nothing to check: every touched rule is a finding and the report fails
const bad = qa(empty, "1");
const found = bad.viewports.desktop.extra_checks.no_empty_pass.failures;
assert.deepEqual([...new Set(found.map((f) => f.checked_rule))].sort(), ["font_below_floor", "text_contrast", "text_crosses_data_mark", "text_outside_nested_svg", "text_outside_panel", "text_outside_viewbox", "text_overlap"]);
assert.ok(found.every((f) => f.rule === "qa_rule_matched_nothing"));
assert.equal(bad.passed, false);
assert.equal(bad.failure_count, found.length);
// 3. on + a real chart: no empty pass, same verdict as off
const ok = qa(real, "1");
assert.deepEqual(ok.viewports.desktop.extra_checks.no_empty_pass.failures, [], JSON.stringify(ok.viewports.desktop.extra_checks));
assert.equal(ok.passed, qa(real, undefined).passed);
// 3b. a chart whose mark rule is empty is named, and only that rule
const hz = qa(real.replace(/data-role="[a-z-]*(point|line-path|bar)[a-z-]*"/g, ""), "1").viewports.desktop.extra_checks.no_empty_pass.failures.map((f) => f.checked_rule);
assert.ok(hz.every((r) => r === "text_crosses_data_mark"), JSON.stringify(hz));
// 4. texts only, no marks: only the mark rule is empty
const textOnly = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><text x="20" y="40" font-size="14" fill="#111">标题</text></svg>';
const t = qa(textOnly, "1").viewports.desktop.extra_checks.no_empty_pass.failures;
assert.deepEqual(t.map((f) => f.checked_rule), ["text_crosses_data_mark"]);
// 5. unit: unmeasured texts do not count as a population
assert.equal(checkEmptyPasses({ summary: { texts_checked: 2, texts_unmeasured: 2, marks_checked: 3 } }, { unmeasured: [] }).passed, false);

// 6. heatmaps: cells count as data marks (only with the cell attributes), a label inside its own cell is fine, one over a neighbour reports
const hspec = { schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各国燃料占比", subtitle: "各来源占比", unit: "%", x_field: "fuel", y_field: "country", value_field: "share", decimals: 1, source: "测试", source_note: "测试", sql: "SELECT 1", alt: "热力图测试，若干国家乘四种燃料的占比。", };
const fuels = ["煤", "石油", "天然气", "水泥"];
const hrows = Array.from({ length: 4 }, (_, i) => `国${i + 1}`).flatMap((c, i) => fuels.map((fu, j) => ({ country: c, fuel: fu, share: 10 + i * 3 + j * 1.5 })));
const hopt = { heatmap: { rows: hrows, spec: hspec, x_field: "fuel", y_field: "country", value_field: "share" } };
const heat = (labels) => { const o = process.env.NEWSROOM_HEATMAP_VALUE_LABELS; if (labels) process.env.NEWSROOM_HEATMAP_VALUE_LABELS = "1"; else delete process.env.NEWSROOM_HEATMAP_VALUE_LABELS; try { return renderVizBundle(hspec, hrows, { mobilePages: false }).desktop; } finally { if (o === undefined) delete process.env.NEWSROOM_HEATMAP_VALUE_LABELS; else process.env.NEWSROOM_HEATMAP_VALUE_LABELS = o; } };
const hqa = (svg, v) => withSwitch(v, () => runRenderQa({ desktop: svg }, hopt)).viewports.desktop;
const withCells = heat(true), noCells = heat(false);
const g = hqa(withCells, "1");
assert.deepEqual(g.extra_checks.no_empty_pass.failures, [], JSON.stringify(g.extra_checks.no_empty_pass));
assert.ok(g.extra_checks.no_empty_pass.population.marks >= 16);
assert.ok(!g.geometry.failures.some((f) => f.rule === "text_crosses_data_mark"), "labels inside their own cells are exempt");
// without cell attributes: not applicable, never a pass and never a finding
const n = hqa(noCells, "1").extra_checks.no_empty_pass;
assert.equal(n.passed, true);
assert.deepEqual(n.not_applicable.map((x) => x.checked_rule), ["text_crosses_data_mark"]);
// a value label moved over a neighbouring cell reports (red); off, the report has no such finding because cells are not marks
const m = withCells.match(/<text data-role="heatmap-cell-value" data-x="煤" data-y="国1" x="([0-9.]+)"/);
const moved = withCells.replace(m[0], m[0].replace(`x="${m[1]}"`, `x="${Number(m[1]) + 190}"`));
assert.notEqual(moved, withCells);
assert.ok(hqa(moved, "1").geometry.failures.some((f) => f.rule === "text_crosses_data_mark"), "label over a neighbour must report");
assert.ok(!hqa(moved, undefined).geometry.failures.some((f) => f.rule === "text_crosses_data_mark"));
// off: heatmap reports are byte-identical for unset/"0"
assert.equal(JSON.stringify(hqa(withCells, "0")), JSON.stringify(hqa(withCells, undefined)));
assert.ok(!JSON.stringify(hqa(withCells, undefined)).includes("not_applicable"));
console.log("PASS qa no empty pass");
