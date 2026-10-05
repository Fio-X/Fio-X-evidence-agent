#!/usr/bin/env node
// A small-multiples line chart where one facet's range dwarfs the rest: that facet moves to its own panel under the grid
// (own vertical scale, a note says so) and the other facets share the narrower scale. Every other chart is byte-identical to a5f56b3.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lintVizSpec, renderVizBundle, renderVizSvg } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const spec = (o = {}) => ({ schema_version: "0.9.0", reader_task: "change", takeaway: "各系列走势", chart_type: "small_multiples", panel_mark: "line", title: "各系列走势", subtitle: "合成数据", alt: "A synthetic small-multiples chart with one line panel for each series.", source_note: "合成数据", claim_id: "claim-so", sql: "SELECT 1", unit: "点", language: "zh", facet_field: "series", x_field: "month", value_field: "value", highlight_values: [], annotations: [], direct_labels: true, ...o });
const months = Array.from({ length: 12 }, (_, i) => `2024-${String(i + 1).padStart(2, "0")}`);
const series = (name, f) => months.map((month, i) => ({ series: name, month, value: f(i) }));
const wave = (base, amp) => (i) => base + amp * Math.sin(i * 0.9);
const sha = (svg) => createHash("sha256").update(svg).digest("hex").slice(0, 16);

const PLOT_H = 170; // panelH 230 - 2 x 30
const geometry = (svg) => [...svg.matchAll(/<polyline [^>]*points="([^"]+)"/g)].map((m) => {
  const ys = m[1].split(" ").map((p) => Number(p.split(",")[1]));
  return Math.max(...ys) - Math.min(...ys);
});
const qaOf = (svg) => { const q = runRenderQa({ desktop: svg }).viewports.desktop; return [...(q.geometry?.failures ?? []), ...(q.contrast?.failures ?? [])].map((x) => x.rule); };
const NOTE_ZH = /变化幅度远大于其他各项，单独成图，纵轴刻度与上面各图不同/;

// ---- split shapes ---------------------------------------------------------------------------------------------------------
const shapeA = { spec: spec({ index_base: 100 }), rows: [...["S1", "S2", "S3", "S4", "S5"].map((n, k) => series(n, wave(100 + k, 6 + k))).flat(), ...series("S6", (i) => 100 + i * 28)] };
const shapeB = { spec: spec({ unit: "万吨" }), rows: [...["甲", "乙", "丙"].map((n, k) => series(n, wave(20 + 2 * k, 4))).flat(), ...series("丁", (i) => 10 + i * 17)] };
if (process.env.MEASURE) { // spans (share of plot height) of shapes A and B, also run at a5f56b3 for the before numbers
  for (const [n, { spec: sp, rows }] of [["A", shapeA], ["B", shapeB]]) console.log(n, geometry(renderVizSvg(sp, rows)).map((v) => (v / PLOT_H).toFixed(2)).join(" "));
  process.exit(0);
}
if (!process.env.PRINT_HASHES) for (const [name, { spec: sp, rows }, outlierName] of [["A (index, S6)", shapeA, "S6"], ["B (no index, 丁)", shapeB, "丁"]]) {
  assert.deepEqual(lintVizSpec(sp, rows, { verified_claim_ids: ["claim-so"] }).blockers, [], `${name}: lint`);
  const svg = renderVizSvg(sp, rows);
  const spans = geometry(svg);
  const grid = spans.slice(0, -1), own = spans[spans.length - 1];
  assert.equal(spans.length, rows.length / 12, `${name}: one polyline per facet`);
  assert.ok(Math.min(...grid) / PLOT_H >= 0.25, `${name}: every grid panel's line spans >= 0.25 of its plot height (min ${(Math.min(...grid) / PLOT_H).toFixed(2)})`);
  assert.ok(own / PLOT_H >= 0.8, `${name}: the outlier spans >= 0.8 of its own plot height (${(own / PLOT_H).toFixed(2)})`);
  assert.match(svg, NOTE_ZH, `${name}: the note is present`);
  assert.ok(svg.includes(`${outlierName}变化幅度远大于其他各项`), `${name}: the note names the outlier`);
    const ownTicks = svg.slice(svg.indexOf('data-role="outlier-note"')).match(/data-role="value-axis-tick"/g) ?? [];
  assert.ok(ownTicks.length >= 3, `${name}: the outlier panel has its own y ticks (${ownTicks.length})`);
  assert.deepEqual(qaOf(svg), [], `${name}: render QA passes`);
  assert.equal(renderVizSvg(sp, rows), svg, `${name}: deterministic`);
  const note = svg.match(/<text data-panel-box="[^"]*" data-role="outlier-note"|<text[^>]*data-role="outlier-note"[^>]*>/)?.[0] ?? "";
  assert.ok(/data-panel-box=/.test(note), `${name}: the note is tagged with its panel box`);
  if (name.startsWith("A")) {
    assert.ok(/data-role="index-base-line"/.test(svg.slice(svg.indexOf('data-role="outlier-note"'))), "A: the outlier panel draws the base line");
    assert.ok(/data-role="index-end-value"/.test(svg.slice(svg.indexOf('data-role="outlier-note"'))), "A: the outlier panel shows its end value");
  }
  console.log(`${name}: grid min span ${(Math.min(...grid) / PLOT_H).toFixed(2)}, outlier span ${(own / PLOT_H).toFixed(2)} of plot height`);
}
// en note
if (!process.env.PRINT_HASHES) {
  const svg = renderVizSvg({ ...shapeA.spec, language: "en" }, shapeA.rows);
  assert.ok(svg.includes("S6 moved far more than the others, so it has its own panel with a different vertical scale."), "en note");
}

// ---- byte-identical to a5f56b3 -------------------------------------------------------------------------------------------------
const three = [...series("甲", wave(100, 5)), ...series("乙", wave(101, 6)), ...series("丙", (i) => 100 + i * 40)];
const twoSame = [...["甲", "乙", "丙", "丁"].slice(0, 2).map((n, k) => series(n, wave(100 + k, 5))).flat(), ...series("丙", (i) => 100 + i * 30), ...series("丁", (i) => 100 + i * 32)];
const calm = ["甲", "乙", "丙", "丁"].map((n, k) => series(n, wave(100 + k, 5 + 2 * k))).flat();
// shape A's grid with the sixth facet's peak tuned so the shared span is a chosen multiple of the span without it
const ratioOf = (rows) => {
  const spanWithout = (skip) => { const v = rows.filter((r) => r.series !== skip).map((r) => r.value); return (Math.max(...v, 100) - Math.min(...v, 100)) * 1.16; };
  const all = rows.map((r) => r.value);
  const full = (Math.max(...all, 100) - Math.min(...all, 100)) * 1.16;
  return full / Math.min(...[...new Set(rows.map((r) => r.series))].map(spanWithout));
};
const nearRows = (peak) => [...["S1", "S2", "S3", "S4", "S5"].map((n, k) => series(n, wave(100 + k, 6 + k))).flat(), ...series("S6", (i) => 100 + (i / 11) * peak)];
const peakFor = (target) => { let lo = 1, hi = 1000; for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (ratioOf(nearRows(mid)) < target) lo = mid; else hi = mid; } return [lo, hi]; };
const [justUnder, justOver] = peakFor(3);
assert.ok(ratioOf(nearRows(justUnder)) < 3 && ratioOf(nearRows(justUnder)) > 2.97, "ratio just under 3");
assert.ok(ratioOf(nearRows(justOver)) >= 3 && ratioOf(nearRows(justOver)) < 3.03, "ratio just over 3");
const CASES = {
  "3 facets with an outlier": [spec({ index_base: 100 }), three],
  "two outliers moving the same way": [spec({ index_base: 100 }), twoSame],
  "no outlier, 4 facets": [spec({ index_base: 100 }), calm],
  "ratio just under 3": [spec({ index_base: 100 }), nearRows(justUnder)],
  "reference_line": [spec({ index_base: 100, annotations: [{ type: "reference_line", value: 130, text: "目标", claim_id: "claim-so" }] }), shapeA.rows],
  "dot panels": [spec({ panel_mark: "dot", index_base: 100 }), shapeA.rows],
  "no index, 3 facets with an outlier": [spec(), three],
  "no index, 5 facets, no outlier": [spec({ unit: "万吨" }), [...["甲", "乙", "丙", "丁", "戊"].map((n, k) => series(n, wave(20 + k, 4 + k))).flat()]],
};
// SHA-256 (first 16 hex) of the desktop SVG at a5f56b3, recorded before the change
const PINNED = process.env.PRINT_HASHES ? {} : {
  "3 facets with an outlier": "cf1a5cc9047cc912/e33d6596007fc514",
  "two outliers moving the same way": "66a6c0684579d1ce/5bd4f5d2de2debfd",
  "no outlier, 4 facets": "a8c3578a7859af5d/78f67d66d10d0676",
  "ratio just under 3": "ef66049564c8d533/5aa04ea7326ce6e5",
  "reference_line": "9c3dfe9cfb3d1f1b/a4d420d6bb09e12f",
  "dot panels": "b1a38bdb2026de0b/f34d4910884538ce",
  "no index, 3 facets with an outlier": "63c42c6e79aa8425/e33d6596007fc514",
  "no index, 5 facets, no outlier": "6fbbcb0f05c0e036/b7722bcf72bb6f74"
};
const hashes = {};
for (const [name, [sp, rows]] of Object.entries(CASES)) {
  const bundle = renderVizBundle(sp, rows);
  hashes[name] = sha(typeof bundle.desktop === "string" ? bundle.desktop : bundle.desktop.svg) + "/" + sha(typeof bundle.mobile === "string" ? bundle.mobile : bundle.mobile?.svg ?? "");
}
if (process.env.PRINT_HASHES) { console.log(JSON.stringify(hashes, null, 2)); process.exit(0); }
for (const [name, hash] of Object.entries(hashes)) assert.equal(hash, PINNED[name], `${name}: byte-identical to a5f56b3`);
// just over 3 splits, with the same grid
assert.match(renderVizSvg(spec({ index_base: 100 }), nearRows(justOver)), NOTE_ZH, "ratio just over 3 splits");
assert.ok(!NOTE_ZH.test(renderVizSvg(...CASES["ratio just under 3"])), "ratio just under 3 does not split");
// mobile is never split
assert.ok(!NOTE_ZH.test(String(renderVizBundle(shapeA.spec, shapeA.rows).mobile?.svg ?? renderVizBundle(shapeA.spec, shapeA.rows).mobile ?? "")), "mobile is untouched");
console.log("small multiples outlier panel: ok");
