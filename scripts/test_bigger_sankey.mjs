#!/usr/bin/env node
// NEWSROOM_BIGGER_CHARTS=1 (default off, desktop only): Sankey node bars (cap 140, factor 180) and bands (factor 44) are larger.
// Off (unset, "0", "true", ""), the SVG is byte-identical; on, render QA stays clean and the chart is taller.
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const spec = (extra = {}) => ({ schema_version: "0.9.0", reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", complexity_budget: "medium", takeaway: "煤是最大的化石排放来源", chart_type: "sankey", title: "碳的来源与去向", subtitle: "单位：十亿吨碳", alt: "桑基图显示各来源的流向。", source_note: "测试数据", claim_id: "claim-n", sql: "SELECT 1", unit: "GtC", language: "zh", source_field: "source", target_field: "target", value_field: "value", flow_conservation: "none", highlight_values: [], annotations: [], ...extra });
const rowsOf = (list) => list.map(([source, target, value]) => ({ source, target, value }));
const render = (sp, rows, mobile = false) => { const b = renderVizBundle(sp, rows, { mobilePages: mobile }); return mobile ? b.mobile : b.desktop; };
const qa = (svg) => { const v = runRenderQa({ desktop: svg }).viewports.desktop; return [...(v.geometry?.failures ?? []), ...(v.contrast?.failures ?? [])].map((f) => f.rule); };
const withSwitch = (value, fn) => { const old = process.env.NEWSROOM_BIGGER_CHARTS; if (value === undefined) delete process.env.NEWSROOM_BIGGER_CHARTS; else process.env.NEWSROOM_BIGGER_CHARTS = value; try { return fn(); } finally { if (old === undefined) delete process.env.NEWSROOM_BIGGER_CHARTS; else process.env.NEWSROOM_BIGGER_CHARTS = old; } };
const height = (svg) => Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg)[1]);

const shapes = {
  twoColumns: rowsOf([["煤", "电力", 40], ["气", "电力", 30], ["油", "热", 20]]),
  threeColumns: rowsOf([["煤", "化石", 40], ["石油", "化石", 30], ["化石", "大气", 40], ["化石", "海洋", 30]]),
  sixNodes: rowsOf([["煤", "化石", 40], ["石油", "化石", 30], ["天然气", "化石", 20], ["化石", "大气", 50], ["化石", "海洋", 25], ["化石", "陆地", 15]]),
  withOther: rowsOf([["煤", "化石", 40], ["石油", "化石", 30], ["水泥生产", "化石", 1], ["火炬燃烧", "化石", 1], ["化石", "大气", 40], ["化石", "海洋", 32]]),
  oneBigNode: rowsOf([["煤", "化石", 90], ["气", "化石", 5], ["油", "化石", 5], ["化石", "大气", 100]]),
};
for (const [name, rows] of Object.entries(shapes)) {
  const base = withSwitch(undefined, () => render(spec(), rows));
  for (const v of ["0", "true", ""]) assert.equal(withSwitch(v, () => render(spec(), rows)), base, `${name}: switch ${JSON.stringify(v)} is off`);
  const on = withSwitch("1", () => render(spec(), rows));
  assert.notEqual(on, base, `${name}: the switch changes the chart`);
  assert.ok(height(on) >= height(base), `${name}: never shorter`);
  assert.deepEqual(qa(base), qa(base), name);
  assert.deepEqual(qa(on).filter((r) => !qa(base).includes(r)), [], `${name}: render QA adds no rejection`);
  assert.ok(!qa(on).includes("text_crosses_data_mark") || qa(base).includes("text_crosses_data_mark"), `${name}: no text_crosses_data_mark`);
  // mobile is never touched
  assert.equal(withSwitch("1", () => render(spec(), rows, true)), withSwitch(undefined, () => render(spec(), rows, true)), `${name}: mobile unchanged`);
}

// the real Germany energy table: write before/after SVG for the PNG step when OUT is set
const csv = "/Users/fio/code/PJ004-local-docs/demo-1008/data-complex/11-germany-imports-and-energy/eurostat_DE_2023_energy_ktoe_v2.csv";
if (existsSync(csv)) {
  const de = readFileSync(csv, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")).map(([source, target, value]) => ({ source, target, value: Number(value) }));
  const off = withSwitch(undefined, () => render(spec(), de)), on = withSwitch("1", () => render(spec(), de));
  assert.deepEqual(qa(on).filter((r) => !qa(off).includes(r)), [], "Germany: render QA adds no rejection");
  console.log(`Germany height off ${height(off)} on ${height(on)}; QA off [${qa(off)}] on [${qa(on)}]`);
  if (process.env.OUT) { mkdirSync(process.env.OUT, { recursive: true }); writeFileSync(`${process.env.OUT}/de-off.svg`, off); writeFileSync(`${process.env.OUT}/de-on.svg`, on); }
}
console.log("PASS bigger sankey");
