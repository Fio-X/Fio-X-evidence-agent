#!/usr/bin/env node
// Diverging bar value labels: every label sits just outside its own bar's end,
// on the bar's own side, and no label or category name lands on a bar. The old
// layout moved the label of any bar that reached the plot edge (the longest bar
// on each side) inside that bar, so render QA reported text_crosses_data_mark
// on essentially every diverging chart. Shapes covered: all positive, all
// negative, mixed, near-zero (including exactly 0), long Chinese category
// names, big numbers, decimals - each with and without highlighted bars, on the
// desktop and the mobile page. Synthetic data only.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const base = {
  schema_version: "0.7.0", reader_task: "comparison", takeaway: "t", title: "Diverging labels", subtitle: "synthetic",
  alt: "A diverging bar chart of synthetic changes per category.", source_note: "synthetic fixture",
  claim_id: "claim-diverging-labels", sql: "SELECT 1", unit: "%", highlight_values: [], direct_labels: true, annotations: [],
  language: "zh", chart_type: "diverging_bar", category_field: "c", value_field: "v",
};
const short = ["甲地区", "乙地区", "丙地区", "丁地区", "戊地区", "己地区"];
const long = ["第一季度华东地区线上渠道", "第二季度华南地区线下渠道", "第三季度华北地区经销渠道", "第四季度西南地区直营渠道", "全年西北地区合作渠道", "全年东北地区新兴渠道"];
const rowsOf = (values, names = short) => values.map((v, i) => ({ c: names[i], v }));
const cases = {
  "all positive": rowsOf([14, 9, 6, 3, 1, 12]),
  "all negative": rowsOf([-14, -9, -6, -3, -1, -12]),
  mixed: rowsOf([14, 9, 6, -3, -8, -17]),
  "near zero": rowsOf([0.2, -0.1, 0, 0.05, -0.3, 0.4]),
  "tiny beside large": rowsOf([0.2, -0.1, 14, -17, 0, 0.05]),
  "long names": rowsOf([14, 9, 6, -3, -8, -17], long),
  "long names, all negative": rowsOf([-14, -9, -6, -3, -8, -17], long),
  "big numbers": rowsOf([123456, 98765, 4321, -3210, -87654, -123456]),
  decimals: rowsOf([1.25, 0.75, 0.5, -0.25, -0.8, -1.5]),
};

const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

// The drawn rows of a page, in drawing order: each bar, its value label and its category name (same row centre).
function rowsOfPage(svg) {
  const bars = [...svg.matchAll(/<rect data-role="data-bar"[^>]*>/g)].map((m) => attrsOf(m[0]))
    .map((a) => ({ x: Number(a.x), right: Number(a.x) + Number(a.width), centre: Number(a.y) + Number(a.height) / 2 }));
  const labels = [...svg.matchAll(/<text data-role="bar-value-label"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ ...attrsOf(m[0]), text: m[1] }));
  const texts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), text: m[3] }));
  assert.equal(bars.length, labels.length, "one value label per bar");
  return bars.map((bar, i) => ({ bar, label: labels[i], category: texts.find((t) => Math.abs(t.y - (bar.centre + 4)) < 0.01 && t.x < bar.x) }));
}

let pages = 0;
for (const [name, rows] of Object.entries(cases)) {
  for (const highlight of [false, true]) {
    const spec = { ...base, highlight_values: highlight ? [rows[0].c, rows.at(-1).c] : [] };
    const bundle = renderVizBundle(spec, rows, { mobilePages: true });
    const qa = runRenderQa({ desktop: bundle.desktop, mobile: bundle.mobile });
    for (const viewport of ["desktop", "mobile"]) {
      const tag = `${viewport} "${name}"${highlight ? " (highlighted)" : ""}`;
      const failures = qa.viewports[viewport].geometry.failures;
      assert.deepEqual(failures.filter((f) => f.rule === "text_crosses_data_mark"), [], `${tag}: no text sits on a bar`);
      assert.deepEqual(failures.filter((f) => f.rule === "text_overlap"), [], `${tag}: no two texts overlap`);
      assert.equal(qa.viewports[viewport].passed, true, `${tag}: render QA passes: ${JSON.stringify(failures.slice(0, 2))}`);

      const drawn = rowsOfPage(bundle[viewport]);
      assert.equal(drawn.length, rows.length, `${tag}: every row is drawn`);
      const allBarLeft = Math.min(...drawn.map((r) => r.bar.x));
      for (const { bar, label, category } of drawn) {
        const negative = /^[-−]/.test(label.text);
        if (negative) {
          assert.equal(label["text-anchor"], "end", `${tag}: ${label.text} hangs off the bar's left end`);
          assert.ok(Number(label.x) <= bar.x - 6, `${tag}: ${label.text} sits left of its bar (${label.x} vs bar ${bar.x})`);
        } else {
          assert.equal(label["text-anchor"], "start", `${tag}: ${label.text} starts at the bar's right end`);
          assert.ok(Number(label.x) >= bar.right + 6, `${tag}: ${label.text} sits right of its bar (${label.x} vs bar end ${bar.right})`);
        }
        assert.ok(!/^#f{3}(?:f{3})?$/i.test(label.fill), `${tag}: ${label.text} is never white-on-bar`);
        assert.ok(category, `${tag}: the row has its category name`);
        assert.ok(category.x < allBarLeft, `${tag}: the category name ${category.text} sits left of every bar, positive or negative`);
      }
      pages += 1;
    }
  }
}
console.log(`diverging_bar: ${pages} pages (${Object.keys(cases).length} value shapes, plain and highlighted, desktop and mobile): labels outside their own bar ends, nothing on a bar, render QA passes: PASS`);
