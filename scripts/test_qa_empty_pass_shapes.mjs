#!/usr/bin/env node
// NEWSROOM_QA_NO_EMPTY_PASS=1, cd's review of ed441e5: charts drawn with shapes the old counters did not know are not empty passes,
// and a row of thin untagged bars is a chart, not furniture. All read from the SVG the renderer wrote, never from a fixture name.
//  - adjacency matrix: matrix-cell rects are data marks; streamgraph: filled `stream` bands make the label rule "not applicable" (never a pass);
//  - heatmap without NEWSROOM_HEATMAP_VALUE_LABELS: cells carry no role; with heatmapChart they are "not applicable", an empty one still fails;
//  - more than three thin untagged rects is not page furniture; the all-zero rule also reads altitude and speed fields.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa, valuesAllZero, viewportHasNoChartShapes } from "../runtime/pi/render_qa.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const nep = (svg, options, on = "1") => {
  if (on === null) delete process.env.NEWSROOM_QA_NO_EMPTY_PASS; else process.env.NEWSROOM_QA_NO_EMPTY_PASS = on;
  try { return runRenderQa({ desktop: svg }, options).viewports.desktop; } finally { delete process.env.NEWSROOM_QA_NO_EMPTY_PASS; }
};
const empties = (v) => v.extra_checks.no_empty_pass.failures.filter((f) => f.rule === "qa_rule_matched_nothing");
const fixture = (name) => readFileSync(join(ROOT, "fixtures/complex", `${name}.svg`), "utf8");

// adjacency matrix: the cells are marks
const matrix = nep(fixture("matrix"));
assert.ok(matrix.extra_checks.no_empty_pass.population.marks > 0, "matrix cells are counted as data marks");
assert.equal(empties(matrix).length, 0, "no empty pass on a matrix");
assert.equal(matrix.extra_checks.no_empty_pass.not_applicable, undefined);

// streamgraph: bands are drawn data, not obstacles
const stream = nep(fixture("streamgraph"));
assert.equal(empties(stream).length, 0, "no empty pass on a streamgraph");
const na = stream.extra_checks.no_empty_pass.not_applicable;
assert.deepEqual(na.map((x) => x.checked_rule), ["text_crosses_data_mark"]);
assert.ok(/filled band/.test(na[0].reason));
assert.equal(stream.extra_checks.no_empty_pass.population.marks, 0, "and it is not counted as a pass");
// the same SVG without its bands is not a streamgraph that was drawn
const bandless = fixture("streamgraph").replace(/<path\b[^>]*data-role="stream"[^>]*>/g, "");
assert.ok(!(nep(bandless).extra_checks.no_empty_pass.not_applicable ?? []).some((x) => /filled band/.test(x.reason)), "no bands: no band reason");
// off: the report carries nothing of this
assert.equal(nep(fixture("matrix"), undefined, null).extra_checks?.no_empty_pass, undefined);

// heatmap, label proof off: cells have no role
const spec = { schema_version: "0.9.0", language: "zh", chart_type: "heatmap", reader_task: "comparison", data_topology: "tabular", verification_mode: "draft", title: "各国燃料占比", subtitle: "各来源占比", unit: "%", x_field: "fuel", y_field: "country", value_field: "share", decimals: 1, source: "测试", source_note: "测试", sql: "SELECT 1", alt: "热力图测试，若干国家乘四种燃料的占比。" };
const rows = ["甲国", "乙国", "丙国"].flatMap((country, i) => ["煤", "气", "水", "风"].map((fuel, j) => ({ country, fuel, share: 5 + i * 7 + j * 3 })));
const heat = renderVizBundle(spec, rows, { mobilePages: false }).desktop;
assert.ok(!heat.includes('data-role="heatmap-cell"'), "the fixture is the unlabelled heatmap");
assert.equal(empties(nep(heat)).length, 1, "without the chart hint it is still an empty pass (as before)");
const hv = nep(heat, { heatmapChart: true });
assert.equal(empties(hv).length, 0);
assert.ok(/12 heatmap cell/.test(hv.extra_checks.no_empty_pass.not_applicable[0].reason), "12 cells drawn");
assert.equal(empties(nep(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><text x="20" y="40" font-size="14" fill="#111">无数据</text><rect data-role="legend-swatch" x="20" y="170" width="10" height="10" fill="#345"/></svg>`, { heatmapChart: true })).length, 1, "a heatmap with no cells still fails");

// wide heatmaps: with 76+ columns every cell is under 8 px, but they are still drawn cells (fe's review: thin cells beyond the furniture cap count)
for (const cols of [8, 40, 75, 76, 120]) {
  const wideRows = ["甲国", "乙国", "丙国"].flatMap((country, i) => Array.from({ length: cols }, (_, j) => ({ country, fuel: `F${j}`, share: 5 + ((i * 7 + j * 3) % 40) })));
  const wide = renderVizBundle(spec, wideRows, { mobilePages: false }).desktop;
  const wv = nep(wide, { heatmapChart: true });
  assert.equal(empties(wv).length, 0, `${cols} columns: not an empty pass`);
  assert.ok(new RegExp(`${cols * 3} heatmap cell`).test(wv.extra_checks.no_empty_pass.not_applicable?.[0]?.reason ?? ""), `${cols} columns: every cell counted`);
}
// the same thin rects without the heatmap hint are not counted as cells, and a heatmap whose cells are gone still fails
const noCells = nep(renderVizBundle(spec, rows, { mobilePages: false }).desktop.replace(/<rect\b(?![^>]*(?:data-role|width="(?:[89]\d\d|\d{4})"))[^>]*>/g, ""), { heatmapChart: true });
assert.equal(empties(noCells).length, 1, "a heatmap with its cells removed still fails");

// thin untagged rects: a few are accent bars, a row of them is a chart
const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">';
const thin = (n) => `${head}${Array.from({ length: n }, (_, i) => `<rect x="${20 + i * 40}" y="${150 - 6 - i * 5}" width="30" height="6" fill="#345"/>`).join("")}<text x="20" y="190" font-size="14" fill="#111">说明</text></svg>`;
assert.equal(viewportHasNoChartShapes(thin(3)), true, "three thin bars are furniture");
for (const n of [4, 6, 9]) assert.equal(viewportHasNoChartShapes(thin(n)), false, `${n} thin bars are a chart`);
const tall = `${head}${Array.from({ length: 6 }, (_, i) => `<rect x="${20 + i * 40}" y="${190 - (i + 1) * 10}" width="6" height="${(i + 1) * 10}" fill="#345"/>`).join("")}</svg>`;
assert.equal(viewportHasNoChartShapes(tall), false, "six thin upright bars are a chart");
assert.equal(viewportHasNoChartShapes(`${head}<rect width="400" height="200" fill="#fff"/>${thin(3).slice(head.length)}`), true, "a backdrop does not count against the three");

// all-zero rule: altitude and speed
const traj = { chart_type: "trajectory_profile", altitude_field: "alt", speed_field: "spd" };
assert.equal(valuesAllZero(traj, [{ alt: 0, spd: 0 }, { alt: "0", spd: 0 }]), true);
assert.equal(valuesAllZero(traj, [{ alt: 0, spd: 0 }, { alt: 0, spd: 4 }]), false, "one non-zero speed");
assert.equal(valuesAllZero({ chart_type: "trajectory_profile" }, [{ alt: 0 }]), false, "no such fields");
console.log("PASS qa empty-pass shapes");
