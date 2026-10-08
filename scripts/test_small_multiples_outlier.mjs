#!/usr/bin/env node
// A small-multiples line chart where one facet's range dwarfs the rest: that facet moves to its own panel under the grid
// (own vertical scale, a note says so) and the other facets share the narrower scale. Every other chart is byte-identical to fb44c18.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lintVizSpec, renderVizBundle, renderVizSvg } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { estimateTextWidth } from "../runtime/pi/render_qa_geometry.mjs";

// the outlier panel is behind NEWSROOM_SMALL_MULTIPLES_OUTLIER_PANEL (exact "1", default off); the assertions below run with it on
const SWITCH = "NEWSROOM_SMALL_MULTIPLES_OUTLIER_PANEL";
process.env[SWITCH] = "1";

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
const NOTE_ZH = /与其他各项数值相差悬殊，单独成图，纵轴刻度与上面各图不同/;

// ---- split shapes ---------------------------------------------------------------------------------------------------------
const shapeA = { spec: spec({ index_base: 100 }), rows: [...["S1", "S2", "S3", "S4", "S5"].map((n, k) => series(n, wave(100, 6 + k))).flat(), ...series("S6", (i) => 100 + i * 28)] };
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
  assert.ok(svg.includes(`${outlierName}与其他各项数值相差悬殊`), `${name}: the note names the outlier`);
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
  assert.ok(svg.replace(/&#39;|&apos;|&#x27;/g, "'").includes("S6 is far outside the others' range, so it has its own panel with a different vertical scale."), "en note");
}


// ---- round 2: ticks, label room, level shift, grid columns --------------------------------------------------------------------
const ownPart = (svg) => svg.slice(svg.indexOf('data-role="outlier-note"'));
const tickTexts = (svg) => [...ownPart(svg).matchAll(/<text ([^>]*)data-role="value-axis-tick"([^>]*)>([^<]*)</g)].map((m) => {
  const attrs = m[1] + m[2];
  return { x: Number(attrs.match(/ x="([^"]+)"/)[1]), box: attrs.match(/data-panel-box="([^"]+)"/)?.[1].split(",").map(Number), label: m[3] };
});
const thousands = { spec: spec({ unit: "点" }), rows: [...["甲", "乙", "丙", "丁"].map((n, k) => series(n, wave(30 + 3 * k, 8))).flat(), ...series("戊", (i) => 47 + (i / 11) * 822)] };
{
  const svg = renderVizSvg(thousands.spec, thousands.rows);
  assert.match(svg, NOTE_ZH, "thousands: split");
  const ticks = tickTexts(svg);
  assert.ok(ticks.length >= 3, `thousands: >= 3 y labels (${ticks.map((t) => t.label)})`);
  for (const t of ticks) {
    assert.ok(t.box, "thousands: tick is tagged with its panel box");
    assert.ok(t.x - estimateTextWidth(t.label, 12, false) >= t.box[0] + 2 - 1e-6, `thousands: label ${t.label} inside its panel box`);
  }
  assert.deepEqual(qaOf(svg), [], "thousands: render QA passes");
  const wide = { spec: spec({ unit: "点" }), rows: [...["甲", "乙", "丙", "丁"].map((n, k) => series(n, wave(300 + 30 * k, 80))).flat(), ...series("戊", (i) => 3120 + i * 700)] };
  const wsvg = renderVizSvg(wide.spec, wide.rows);
  assert.match(wsvg, NOTE_ZH, "wide labels: split");
  for (const t of tickTexts(wsvg)) assert.ok(t.x - estimateTextWidth(t.label, 12, false) >= t.box[0] + 2 - 1e-6, `wide labels: ${t.label} inside its box`);
  assert.deepEqual(qaOf(wsvg), [], "wide labels: render QA passes");
}
{ // level shift: flat and far above the others, no bigger move
  const flat = { spec: spec(), rows: [...["甲", "乙", "丙", "丁"].map((n, k) => series(n, wave(20 + 2 * k, 4))).flat(), ...series("戊", () => 300)] };
  const svg = renderVizSvg(flat.spec, flat.rows);
  assert.match(svg, NOTE_ZH, "level shift: split, new note");
  assert.ok(svg.includes("戊与其他各项数值相差悬殊"), "level shift: note names the facet");
  assert.ok(!/变化幅度/.test(svg), "level shift: no claim about the size of the change");
  assert.deepEqual(qaOf(svg), [], "level shift: render QA passes");
}
{ // the grid counts columns from the facets that stay in it
  const titleXs = (svg) => new Set([...svg.matchAll(/<text [^>]*? x="([^"]+)" y="[^"]+" font-family="[^"]+" font-size="14" font-weight="700"/g)].map((m) => m[1]));
  for (const [total, wantCols] of [[7, 2], [10, 3]]) {
    const rowsN = [...Array(total - 1)].map((_, k) => series(`F${k + 1}`, wave(100, 4 + (k % 3)))).flat().concat(series("OUT", (i) => 100 + i * 28));
    const svg = renderVizSvg(spec({ index_base: 100 }), rowsN);
    assert.match(svg, NOTE_ZH, `${total} index facets: split`);
    assert.equal(titleXs(svg).size, wantCols, `${total} index facets: grid has ${wantCols} columns`);
    assert.deepEqual(qaOf(svg), [], `${total} index facets: render QA passes`);
  }
}

// ---- byte-identical to fb44c18 -------------------------------------------------------------------------------------------------
const three = [...series("甲", wave(100, 5)), ...series("乙", wave(100, 6)), ...series("丙", (i) => 100 + i * 40)];
const twoSame = [...["甲", "乙", "丙", "丁"].slice(0, 2).map((n, k) => series(n, wave(100, 5))).flat(), ...series("丙", (i) => 100 + i * 30), ...series("丁", (i) => 100 + i * 32)];
const calm = ["甲", "乙", "丙", "丁"].map((n, k) => series(n, wave(100, 5 + 2 * k))).flat();
// shape A's grid with the sixth facet's peak tuned so the shared span is a chosen multiple of the span without it
const ratioOf = (rows) => {
  const spanWithout = (skip) => { const v = rows.filter((r) => r.series !== skip).map((r) => r.value); return (Math.max(...v, 100) - Math.min(...v, 100)) * 1.16; };
  const all = rows.map((r) => r.value);
  const full = (Math.max(...all, 100) - Math.min(...all, 100)) * 1.16;
  return full / Math.min(...[...new Set(rows.map((r) => r.series))].map(spanWithout));
};
const nearRows = (peak) => [...["S1", "S2", "S3", "S4", "S5"].map((n, k) => series(n, wave(100, 6 + k))).flat(), ...series("S6", (i) => 100 + (i / 11) * peak)];
const peakFor = (target) => { let lo = 1, hi = 1000; for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (ratioOf(nearRows(mid)) < target) lo = mid; else hi = mid; } return [lo, hi]; };
// 1% either side of 3: a ratio within float noise of 3 would decide on rounding, not on the rule
const justUnder = peakFor(2.99)[0], justOver = peakFor(3.01)[1];
assert.ok(ratioOf(nearRows(justUnder)) < 3 && ratioOf(nearRows(justUnder)) > 2.97, "ratio just under 3");
assert.ok(ratioOf(nearRows(justOver)) >= 3 && ratioOf(nearRows(justOver)) < 3.03, "ratio just over 3");
const CASES = {
  "3 facets with an outlier": [spec({ index_base: 100 }), three],
  "two outliers moving the same way": [spec({ index_base: 100 }), twoSame],
  "no outlier, 4 facets": [spec({ index_base: 100 }), calm],
  "ratio just under 3": [spec({ index_base: 100 }), nearRows(justUnder)],
  "reference_line": [spec({ index_base: 100, annotations: [{ type: "reference_line", value: 130, text: "目标", claim_id: "claim-so" }] }), shapeA.rows],
  "dot panels": [spec({ panel_mark: "dot" }), shapeA.rows],
  "no index, 3 facets with an outlier": [spec(), three],
  "no index, 5 facets, no outlier": [spec({ unit: "万吨" }), [...["甲", "乙", "丙", "丁", "戊"].map((n, k) => series(n, wave(20 + k, 4 + k))).flat()]],
};
// SHA-256 (first 16 hex) of the desktop SVG at fb44c18, recorded before the change
const PINNED = process.env.PRINT_HASHES ? {} : {
  "3 facets with an outlier": "2c48f736801a3430/854f45c60d21ba30",
  "two outliers moving the same way": "5109637fe6e55ff0/7b8f121dbe0d863e",
  "no outlier, 4 facets": "a3adb4332c90fb9c/08f78e2a6ed3e22d",
  "ratio just under 3": "065a03b16d157dd8/e8e7d16ebf80171f",
  "reference_line": "e5b8fc2035546a3f/3f06c53a44503ffe",
  "dot panels": "ea143657c92c3672/2406306ed5c25937",
  "no index, 3 facets with an outlier": "228b3a926f32270c/854f45c60d21ba30",
  "no index, 5 facets, no outlier": "6fbbcb0f05c0e036/b7722bcf72bb6f74"
};
const hashes = {};
for (const [name, [sp, rows]] of Object.entries(CASES)) {
  const bundle = renderVizBundle(sp, rows);
  hashes[name] = sha(typeof bundle.desktop === "string" ? bundle.desktop : bundle.desktop.svg) + "/" + sha(typeof bundle.mobile === "string" ? bundle.mobile : bundle.mobile?.svg ?? "");
}
if (process.env.PRINT_HASHES) { console.log(JSON.stringify(hashes, null, 2)); process.exit(0); }
for (const [name, hash] of Object.entries(hashes)) assert.equal(hash, PINNED[name], `${name}: byte-identical to fb44c18`);
// just over 3 splits, with the same grid
assert.match(renderVizSvg(spec({ index_base: 100 }), nearRows(justOver)), NOTE_ZH, "ratio just over 3 splits");
assert.ok(!NOTE_ZH.test(renderVizSvg(...CASES["ratio just under 3"])), "ratio just under 3 does not split");
// mobile is never split
assert.ok(!NOTE_ZH.test(String(renderVizBundle(shapeA.spec, shapeA.rows).mobile?.svg ?? renderVizBundle(shapeA.spec, shapeA.rows).mobile ?? "")), "mobile is untouched");
// switch off (unset, and anything but "1"): the outlier fixtures render byte-identical to fb44c18, desktop and mobile
const OFF_PINNED = { A: "e78166d88d65bd5c/f33c26c91d62cb81", B: "bc99f7853f709fab/567a08543fba5ddd" };
const bundleHash = (sp, rows) => { const b = renderVizBundle(sp, rows); return sha(typeof b.desktop === "string" ? b.desktop : b.desktop.svg) + "/" + sha(typeof b.mobile === "string" ? b.mobile : b.mobile?.svg ?? ""); };
for (const off of [undefined, "0", "true"]) {
  if (off === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = off;
  assert.equal(bundleHash(shapeA.spec, shapeA.rows), OFF_PINNED.A, `switch ${off}: shape A byte-identical to fb44c18`);
  assert.equal(bundleHash(shapeB.spec, shapeB.rows), OFF_PINNED.B, `switch ${off}: shape B byte-identical to fb44c18`);
  assert.ok(!NOTE_ZH.test(renderVizSvg(shapeA.spec, shapeA.rows)), `switch ${off}: no outlier panel`);
}
process.env[SWITCH] = "1";
assert.notEqual(bundleHash(shapeA.spec, shapeA.rows), OFF_PINNED.A, "switch on changes shape A");
console.log("small multiples outlier panel: ok");
