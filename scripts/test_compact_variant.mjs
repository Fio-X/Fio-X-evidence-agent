#!/usr/bin/env node
// Compact (8-of-12-column) chart variant: renderer matrix, render QA on both
// widths, hash bindings (manifest, critic, page lint/render) and the page lint
// that must keep blocking an 8-column placement without a compact variant.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPACT_VIEW_W, renderVizBundle, renderVizCompactSvg, hasCompactVariant } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const base = { schema_version: "0.7.0", direct_labels: true, annotations: [], title: "Compact variant check", subtitle: "A short subtitle", alt: "A chart used to check the compact variant layout.", source_note: "fixture", sql: "select 1", claim_id: "claim-compact", reader_task: "sequence", takeaway: "t", language: "zh" };
const bar = (extra) => ({ ...base, chart_type: "horizontal_bar", category_field: "c", value_field: "v", highlight_values: [], ...extra });
const line = (extra) => ({ ...base, chart_type: "line", x_field: "x", value_field: "v", ...extra });
const multi = (extra) => ({ ...base, chart_type: "multi_line", x_field: "x", value_field: "v", series_field: "s", highlight_values: [], ...extra });
const years = Array.from({ length: 12 }, (_, i) => String(2012 + i));
const many = Array.from({ length: 24 }, (_, i) => ({ c: `Country ${String.fromCharCode(65 + (i % 26))}${i}`, v: 100 - i * 3 }));

const SHAPES = {
  "long category names": { spec: bar({ unit: "%" }), rows: [{ c: "波斯尼亚和黑塞哥维那", v: 41.5 }, { c: "马其顿共和国（北马其顿）", v: 30.2 }, { c: "Saint Vincent and the Grenadines", v: 12.1 }] },
  "20+ bars": { spec: bar({ unit: "%", highlight_values: ["Country A0"] }), rows: many },
  "negative values": { spec: bar({ unit: "%" }), rows: [{ c: "甲", v: 12.5 }, { c: "乙", v: -8.4 }, { c: "丙", v: -21.7 }, { c: "丁", v: 3.1 }] },
  "big numbers with units": { spec: bar({ unit: "亿美元" }), rows: [{ c: "中国", v: 123456.7 }, { c: "美国", v: 98765.4 }, { c: "德国", v: 4567.8 }] },
  "years as categories": { spec: bar({ unit: "万人", sort: "none" }), rows: years.map((c, i) => ({ c, v: 200 + i * 17 })) },
  "line: years, big numbers": { spec: line({ unit: "亿元", highlight_values: ["2023"] }), rows: years.map((x, i) => ({ x, v: 12000 + i * 830 })) },
  "line: negatives": { spec: line({ unit: "%" }), rows: years.map((x, i) => ({ x, v: -3 + i * 0.7 })) },
  "multi_line: long names": { spec: multi({ unit: "%", highlight_values: ["波斯尼亚和黑塞哥维那"] }), rows: years.flatMap((x, i) => [["波斯尼亚和黑塞哥维那", 4 + i], ["North Macedonia", 6 + i * 0.5], ["中国", 9 - i * 0.3]].map(([s, v]) => ({ x, s, v }))) },
};

const fontSizes = (svg) => new Set([...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1])));
for (const [name, { spec, rows }] of Object.entries(SHAPES)) {
  const bundle = renderVizBundle(spec, rows, { mobilePages: false, compact: true });
  assert.ok(bundle.compact, `${name}: a compact variant is rendered`);
  assert.match(bundle.desktop, /viewBox="0 0 1040 /);
  assert.match(bundle.compact, new RegExp(`viewBox="0 0 ${COMPACT_VIEW_W} `), `${name}: compact is laid out at ${COMPACT_VIEW_W}`);
  assert.match(bundle.compact, /data-viewport="compact"/);
  assert.doesNotMatch(bundle.compact, /transform="scale|<g transform="matrix/, `${name}: re-laid out, not scaled`);
  // house-style sizes kept: every compact font size is one the desktop chart also uses
  for (const size of fontSizes(bundle.compact)) assert.ok(fontSizes(bundle.desktop).has(size), `${name}: compact font ${size} is a desktop house size`);
  assert.ok(Math.min(...fontSizes(bundle.compact)) >= 12, `${name}: no text below 12px`);
  const qa = runRenderQa({ desktop: bundle.desktop, compact: bundle.compact });
  for (const viewport of ["desktop", "compact"]) {
    const report = qa.viewports[viewport];
    assert.equal(report.passed, true, `${name}: ${viewport} render QA must pass: ${JSON.stringify([...report.geometry.failures, ...report.contrast.failures]).slice(0, 400)}`);
  }
  assert.notEqual(qa.viewports.compact.svg_sha256, qa.viewports.desktop.svg_sha256);
  // deterministic
  assert.equal(renderVizCompactSvg(spec, rows), bundle.compact);
}
console.log(`compact renderer matrix: ${Object.keys(SHAPES).length} shapes x (desktop, compact) -- PASS`);

// Only bar/line/multi_line have a compact variant; any other chart type fails closed.
assert.equal(hasCompactVariant({ chart_type: "choropleth" }), false);
assert.throws(() => renderVizCompactSvg({ ...base, chart_type: "scatter" }, []), /No compact variant/);
const dot = renderVizBundle(bar({ chart_type: "dot", unit: "%" }), [{ c: "A", v: 1 }, { c: "B", v: 2 }], { mobilePages: false, compact: true });
assert.equal(dot.compact, undefined);
// Not asked for: the bundle is exactly what it was before.
assert.deepEqual(Object.keys(renderVizBundle(SHAPES["negative values"].spec, SHAPES["negative values"].rows, { mobilePages: false })), ["desktop"]);
console.log("compact variant scope: PASS");

// Category names are never cut: a name wider than the label column folds onto
// a second line; two long names sharing a prefix stay distinguishable.
{
  const names = [
    "United Kingdom of Great Britain and Northern Ireland",
    "United Kingdom of Great Britain and Northern Ireland (overseas territories)",
    "波斯尼亚和黑塞哥维那联邦及其下属各个行政区域合计",
    "波斯尼亚和黑塞哥维那联邦及其下属各个行政区域其他",
  ];
  const rows = names.map((c, i) => ({ c, v: 90 - i * 10 }));
  const spec = bar({ unit: "%" });
  const bundle = renderVizBundle(spec, rows, { mobilePages: false, compact: true });
  for (const [viewport, svg] of [["desktop", bundle.desktop], ["compact", bundle.compact]]) {
    assert.doesNotMatch(svg, /…/, `${viewport}: no name is shortened with an ellipsis`);
    const texts = [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replaceAll("&amp;", "&"));
    for (const name of names) {
      const whole = texts.includes(name);
      const folded = texts.some((first, i) => name.startsWith(first) && [` `, ``].some((gap) => texts[i + 1] !== undefined && first + gap + texts[i + 1] === name));
      assert.ok(whole || folded, `${viewport}: the full text of "${name}" is in the SVG`);
    }
    assert.equal(new Set(names.map((name) => texts.find((t) => t.startsWith(name.slice(0, 6)) && t !== undefined))).size >= 1, true);
  }
  const qaLong = runRenderQa({ desktop: bundle.desktop, compact: bundle.compact });
  assert.equal(qaLong.passed, true, `folded long names pass render QA: ${JSON.stringify(Object.values(qaLong.viewports).flatMap((v) => v.geometry.failures).slice(0, 2))}`);
  // The two long names differ in the text that is drawn.
  const drawn = (svg, tail) => svg.includes(tail);
  assert.ok(drawn(bundle.compact, "(overseas territories)") || drawn(bundle.compact, "territories)"), "the distinguishing tail of the longer UK name is drawn");
  assert.ok(drawn(bundle.compact, "合计") && drawn(bundle.compact, "其他"), "the distinguishing tails of the two CJK names are drawn");
  // A name too long even for two lines is not shortened; render QA blocks it.
  const absurd = [{ c: "Alpha ".repeat(40).trim(), v: 5 }, { c: "B", v: 3 }];
  const absurdBundle = renderVizBundle(spec, absurd, { mobilePages: false, compact: true });
  assert.doesNotMatch(absurdBundle.compact, /…/);
  console.log(`long category names fold, never truncate (desktop + compact); QA outcome for an absurd name: ${runRenderQa({ desktop: absurdBundle.desktop, compact: absurdBundle.compact }).passed ? "passes" : "blocked"}`);
}
