#!/usr/bin/env node
// Two opt-in renderer fixes, tested on synthetic inputs by calling the functions directly (no browser):
//   NEWSROOM_LINE_TICK_AVOID_OVERLAP: a compact yearly line chart drops an x label that would overlap a kept one.
//   NEWSROOM_PAGE_TRIM_TEXT_SAFE: the page trim estimates text ink wide enough never to cut into it.
import assert from "node:assert/strict";
import { renderVizCompactSvg } from "../runtime/pi/viz.mjs";
import { trimmedSvgInfo } from "../runtime/pi/infographic.mjs";
import { checkSvgGeometry, estimateTextWidth } from "../runtime/pi/render_qa_geometry.mjs";

const K104 = "NEWSROOM_LINE_TICK_AVOID_OVERLAP", K102 = "NEWSROOM_PAGE_TRIM_TEXT_SAFE";
const withEnv = (name, value, fn) => { const old = process.env[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; try { return fn(); } finally { if (old === undefined) delete process.env[name]; else process.env[name] = old; } };

// K104
const base = { schema_version: "0.7.0", direct_labels: true, annotations: [], title: "Tick check", subtitle: "s", alt: "A chart used to check tick labels.", source_note: "fixture", sql: "select 1", claim_id: "claim-compact", reader_task: "sequence", takeaway: "t", language: "zh", chart_type: "line", x_field: "x", value_field: "v", unit: "%" };
const series = (n) => Array.from({ length: n }, (_, i) => ({ x: String(2025 - n + 1 + i), v: 10 + i * 1.5 }));
const render = (n, env) => withEnv(K104, env, () => renderVizCompactSvg(base, series(n)));
const xLabels = (svg) => [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="middle"[^>]*>(\d{4})<\/text>/g)].map((m) => ({ text: m[2], x: Number(m[1]), w: estimateTextWidth(m[2], 12, false) }));
const overlaps = (ls) => ls.some((a, i) => ls.slice(i + 1).some((b) => Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2) > 0));
// The series is one polyline; its points are the data points.
const dots = (svg) => (svg.match(/<polyline[^>]*data-role="line-path"[^>]*\spoints="([^"]+)"/)?.[1].trim().split(/\s+/) ?? []).length;

for (const n of [21, 26]) {
  const off = render(n, undefined), unset = render(n, "0"), on = render(n, "1");
  assert.equal(off, unset, `n=${n}: any value other than "1" is the same as unset`);
  assert.equal(off, withEnv(K104, undefined, () => renderVizCompactSvg(base, series(n))), `n=${n}: off is stable`);
  const labels = xLabels(on);
  assert.equal(labels[0].text, String(2025 - n + 1), `n=${n}: first label kept`);
  assert.equal(labels.at(-1).text, "2025", `n=${n}: last label kept`);
  assert.ok(!overlaps(labels), `n=${n}: no two kept labels overlap`);
  assert.equal(dots(on), dots(off), `n=${n}: every point is still drawn`);
  assert.equal(dots(off), n, `n=${n}: points drawn`);
  assert.deepEqual(checkSvgGeometry(on).failures.map((f) => f.rule), [], `n=${n}: QA clean with the switch on`);
  console.log(`K104 n=${n}: off=${xLabels(off).length} labels, on=${labels.length} labels, points=${dots(on)}, off QA=[${checkSvgGeometry(off).failures.map((f) => f.rule)}]`);
}
// n=26 is where today's labelling puts 2024 and 2025 next to each other.
{
  const off = render(26, undefined), on = render(26, "1");
  assert.ok(overlaps(xLabels(off)), "n=26 off: the last two labels overlap (today's behaviour)");
  assert.ok(checkSvgGeometry(off).failures.some((f) => f.rule === "text_overlap"), "n=26 off: render QA refuses it");
  assert.ok(xLabels(on).length < xLabels(off).length, "n=26 on: a label was dropped");
}
// n=21 does not overlap today, so on must equal off.
assert.equal(render(21, "1"), render(21, undefined), "n=21: nothing to drop, so the output is unchanged");

// K102
const fs = 12, x = 30.9;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><text x="${x}" y="20" text-anchor="end" font-size="${fs}">80%</text><line x1="${x + 8}" y1="20" x2="390" y2="20" stroke="#ccc" stroke-width="1"/></svg>`;
const trim = (env) => withEnv(K102, env, () => trimmedSvgInfo(svg));
const trueLeft = x - estimateTextWidth("80%", fs, false);
const offInfo = trim(undefined), onInfo = trim("1");
assert.deepEqual(trim("0"), offInfo, "any value other than \"1\" is the same as unset");
assert.ok(offInfo.minX > trueLeft, `off: trim at ${offInfo.minX} cuts into the label whose ink starts at ${trueLeft.toFixed(2)} (today's behaviour)`);
assert.ok(onInfo.minX <= trueLeft, `on: trim at ${onInfo.minX} leaves the label whole (ink starts at ${trueLeft.toFixed(2)})`);
assert.equal(onInfo.width, 400 - onInfo.minX);
// A chart with no text is trimmed exactly as before.
const noText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><line x1="20" y1="20" x2="390" y2="20" stroke="#ccc" stroke-width="1"/></svg>`;
assert.deepEqual(withEnv(K102, "1", () => trimmedSvgInfo(noText)), withEnv(K102, undefined, () => trimmedSvgInfo(noText)), "no text: unchanged");
console.log(`K102: label ink starts ${trueLeft.toFixed(2)}; off trims at ${offInfo.minX}; on trims at ${onInfo.minX}`);
console.log("ok");
