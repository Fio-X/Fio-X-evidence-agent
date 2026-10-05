#!/usr/bin/env node
// The highlighted sankey flow's value label: accent text-safe shade, no halo, on paper beside its band and
// at least 2px clear of node labels, other value labels, node bars and every band; omitted when no spot is clear.
import assert from "node:assert/strict";
import { lintVizSpec, renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { ASCENT_RATIO, DESCENT_RATIO, estimateTextWidth } from "../runtime/pi/render_qa_geometry.mjs";

const mk = (big, other = 20) => [["来源甲", "去向一", big], ["来源甲", "去向二", other], ["来源乙", "去向二", 30], ["来源乙", "去向三", 10], ["来源丙", "去向一", 15], ["来源丙", "去向三", 25], ["来源乙", "去向一", 5]].map(([source, target, value]) => ({ source, target, value }));
const baseSpec = (extra = {}) => ({ schema_version: "0.9.0", reader_task: "flow", visual_family: "flow", data_topology: "flow_edges", complexity_budget: "medium", takeaway: "来源甲流向去向一的量最大", chart_type: "sankey", title: "各来源的去向", subtitle: "合成数据，单位：万吨", alt: "合成数据：桑基图显示三个来源流向三个去向。", source_note: "合成数据", claim_id: "claim-k3", sql: "SELECT 1", unit: "万吨", language: "zh", source_field: "source", target_field: "target", value_field: "value", flow_conservation: "none", highlight_values: ["来源甲"], annotations: [], ...extra });

const NUM = /-?\d+(?:\.\d+)?/g;
function inspect(svg) {
  const labels = [...svg.matchAll(/<text data-role="flow-value-label" data-flow-key="([^"]*)"[^>]*>([^<]*)<\/text>/g)];
  const links = [...svg.matchAll(/<path data-role="flow-link" data-flow-key="([^"]*)"[^>]* d="([^"]+)"[^>]* stroke-width="([\d.]+)"/g)].map((m) => ({ key: m[1], n: m[2].match(NUM).map(Number), sw: Number(m[3]) }));
  return { labels, links };
}
const cubic = ([x1, y1, c1x, c1y, c2x, c2y, x2, y2], t) => { const m = 1 - t; return { x: m ** 3 * x1 + 3 * m * m * t * c1x + 3 * m * t * t * c2x + t ** 3 * x2, y: m ** 3 * y1 + 3 * m * m * t * c1y + 3 * m * t * t * c2y + t ** 3 * y2 }; };
const distToBox = (p, b) => Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));

function check(name, spec, rows, { mobile = false } = {}) {
  assert.deepEqual(lintVizSpec(spec, rows, { verified_claim_ids: ["claim-k3"] }).blockers, [], `${name}: lint`);
  const bundle = renderVizBundle(spec, rows);
  const svg = typeof bundle.desktop === "string" ? bundle.desktop : bundle.desktop.svg;
  const qa = runRenderQa({ desktop: svg }).viewports.desktop;
  const failures = [...(qa.geometry?.failures ?? []), ...(qa.contrast?.failures ?? [])].map((f) => f.rule);
  const { labels, links } = inspect(svg);
  if (!labels.length) return { svg, drawn: false, failures };
  for (const label of labels) {
  const tag = label[0];
  assert.match(tag, /fill="#D0021B"/i, `${name}: accent text-safe fill`);
  assert.ok(!/stroke=|paint-order/.test(tag), `${name}: no halo`);
  const x = Number(/ x="([\d.-]+)"/.exec(tag)[1]), y = Number(/ y="([\d.-]+)"/.exec(tag)[1]);
  const w = label[2].length * 12.5 * 0.8 + 8, box = { x: x - w / 2, y: y - 12.5 - 3, w, h: 12.5 + 7 };
  // independent of the renderer: every sampled centreline point must be farther than half its band plus 2px
  for (const link of links) for (let i = 0; i <= 400; i++) {
    const d = distToBox(cubic(link.n, i / 400), box);
    assert.ok(d >= link.sw / 2 + 2 - 0.5, `${name}: label ${d.toFixed(1)}px from a band of width ${link.sw}`);
  }
  // attribution: the text box's gap to each band (box to centreline, less half the width) - its own band is 2-11px away and
  // at least 1px nearer than every other band
  const tw = estimateTextWidth(label[2], 12.5, true), tb = { x: x - tw / 2, y: y - 12.5 * ASCENT_RATIO, w: tw, h: 12.5 * (ASCENT_RATIO + DESCENT_RATIO) };
  const gap = (link) => Math.min(...Array.from({ length: 401 }, (_, i) => distToBox(cubic(link.n, i / 400), tb))) - link.sw / 2;
  const own = links.find((l) => l.key === label[1]);
  assert.ok(own, `${name}: own band found`);
  const ownGap = gap(own);
  assert.ok(ownGap >= 2 - 0.25 && ownGap <= 11, `${name}: own-band gap ${ownGap.toFixed(2)}px in [2, 11]`);
  for (const l of links) if (l !== own) assert.ok(gap(l) >= ownGap + 1 - 0.25, `${name}: another band is ${gap(l).toFixed(2)}px away, own ${ownGap.toFixed(2)}px`);
  }
  return { svg, drawn: true, failures };
}

// V64 fixture: 30px highlighted band; and an 8px one
for (const [name, rows] of [["30px band", mk(40)], ["8px band", mk(8, 5)]]) {
  const r = check(name, baseSpec(), rows);
  assert.ok(r.drawn, `${name}: label drawn`);
  assert.deepEqual(r.failures, [], `${name}: render QA passes`);
}

// 60 seeded sankeys: 20 shapes x highlight on the largest, a middle and the thinnest flow
let seed = 20261005;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
let pass = 0, omitted = 0, total = 0;
const omittedBy = { largest: 0, middle: 0, thinnest: 0, "source only": 0, "two sources": 0 };
const drawnBy = { largest: 0, middle: 0, thinnest: 0, "source only": 0, "two sources": 0 };
for (let k = 0; k < 20; k++) {
  const ns = 3 + Math.floor(rand() * 3), nt = 3 + Math.floor(rand() * 3);
  const rows = [];
  for (let i = 0; i < ns; i++) for (let j = 0; j < nt; j++) rows.push({ source: `来源${i + 1}`, target: `去向${j + 1}`, value: 5 + Math.floor(rand() * 95) });
  const order = rows.map((r, i) => i).sort((a, b) => rows[b].value - rows[a].value);
  const modes = [["largest", order[0]], ["middle", order[order.length >> 1]], ["thinnest", order[order.length - 1]]].map(([which, idx]) => [which, [rows[idx].source, rows[idx].target]]);
  modes.push(["source only", [rows[order[0]].source]], ["two sources", [...new Set([rows[order[0]].source, rows[order[1]].source, rows[order[order.length - 1]].source])].slice(0, 2)]);
  for (const [which, highlight] of modes) {
    total++;
    const r = check(`random ${k} ${which}`, baseSpec({ highlight_values: highlight }), rows);
    if (!r.drawn) { omitted++; omittedBy[which]++; } else drawnBy[which]++;
    if (r.failures.length === 0) pass++;
  }
}
console.log(`random sankeys: ${total}, QA pass ${pass}, label drawn ${JSON.stringify(drawnBy)}, omitted ${omitted} (${JSON.stringify(omittedBy)})`);
assert.equal(total, 100);
assert.equal(pass, total, "render QA passes for every seeded sankey");
console.log("sankey value label: ok");
