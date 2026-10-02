#!/usr/bin/env node
// Scatter highlight labels: the short leader joining a highlighted point to its
// direct label used to read `placedLabel.dx`, which annotationLayout.place()
// never returns, so it came out as x2="NaN" - an invalid attribute no browser
// draws and render QA silently skips. Highlighted points at the plot corners,
// edge midpoints and middle must get finite leaders that start on their own
// point and end at their own label, on the desktop and the mobile page, and
// render QA (leader_crosses_text included) must still pass.
// Synthetic data only.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const base = {
  schema_version: "0.7.0", direct_labels: true, annotations: [], title: "Scatter leader", subtitle: "synthetic",
  alt: "A scatter chart whose highlighted points sit at the corners, edges and middle of the plot.",
  source_note: "synthetic fixture", sql: "select 1", claim_id: "claim-scatter-leader", reader_task: "correlation",
  takeaway: "t", language: "zh", chart_type: "scatter", x_field: "x", y_field: "y", label_field: "name",
  x_label: "X", y_label: "Y", x_unit: "idx", y_unit: "%", unit: "%",
};

// [label, x, y]: corners, edge midpoints and the middle of a 0-100 square.
const HIGHLIGHTED = [
  ["Alpha", 0, 0], ["Bravo", 100, 0], ["Charlie", 0, 100], ["Delta", 100, 100],
  ["Echo", 0, 50], ["Foxtrot", 100, 50], ["Golf", 50, 100], ["Hotel", 50, 0], ["India", 50, 50],
];
const filler = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, x: 12 + ((i * 29) % 77), y: 8 + ((i * 41) % 85) }));
const rows = [...HIGHLIGHTED.map(([name, x, y]) => ({ name, x, y })), ...filler];
const spec = { ...base, highlight_values: HIGHLIGHTED.map(([name]) => name) };

const attrsOf = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

// Distance from a point to a label's estimated ink box (12px bold text; Latin ~7px, CJK 12px per character).
function distanceToLabel(x, y, label, text) {
  const w = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 12 : 7), 0);
  const x0 = label["text-anchor"] === "middle" ? Number(label.x) - w / 2 : label["text-anchor"] === "end" ? Number(label.x) - w : Number(label.x);
  const top = Number(label.y) - 11, bottom = Number(label.y) + 4;
  return Math.hypot(Math.max(x0 - x, 0, x - (x0 + w)), Math.max(top - y, 0, y - bottom));
}

const bundle = renderVizBundle(spec, rows, { mobilePages: true });
const qa = runRenderQa({ desktop: bundle.desktop, mobile: bundle.mobile });

for (const viewport of ["desktop", "mobile"]) {
  const svg = bundle[viewport];
  assert.doesNotMatch(svg, /\b(?:NaN|undefined|Infinity)\b/, `${viewport}: no NaN/undefined/Infinity token in the SVG`);

  const highlightedCircles = [...svg.matchAll(/<circle [^>]*>/g)].map((m) => attrsOf(m[0])).filter((a) => Number(a.r) > 5);
  assert.equal(highlightedCircles.length, HIGHLIGHTED.length, `${viewport}: every highlighted point is drawn`);

  // Walk leaders and labels in document order: each leader is pushed right before its own label.
  const tags = [...svg.matchAll(/<(?:line|text) data-role="direct-label(?:-leader)?"[^>]*>([^<]*)/g)].map((m) => ({ tag: m[0].split(">")[0] + ">", text: m[1], attrs: attrsOf(m[0].split(">")[0]) }));
  const leaders = [];
  tags.forEach(({ tag, attrs }, i) => {
    if (!tag.startsWith("<line")) return;
    const label = tags[i + 1];
    assert.ok(label && label.tag.startsWith("<text"), `${viewport}: a leader is followed by its own label`);
    leaders.push({ leader: attrs, label: label.attrs, text: label.text });
  });
  assert.ok(leaders.length >= 3, `${viewport}: the left/right-placed highlighted points draw leaders (found ${leaders.length})`);

  for (const { leader, label, text } of leaders) {
    const [x1, y1, x2, y2] = ["x1", "y1", "x2", "y2"].map((k) => Number(leader[k]));
    assert.ok([x1, y1, x2, y2].every(Number.isFinite), `${viewport}: leader coordinates are finite: ${JSON.stringify(leader)}`);
    assert.ok(highlightedCircles.some((c) => Math.abs(Number(c.cx) - x1) < 0.01 && Math.abs(Number(c.cy) - y1) < 0.01), `${viewport}: the leader starts on a highlighted point`);
    const gap = distanceToLabel(x2, y2, label, text);
    assert.ok(gap > 0 && gap < 4, `${viewport}: the leader ends just short of its own label "${text}" (${gap.toFixed(1)}px away)`);
    const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    assert.ok(x2 > 0 && y2 > 0 && x2 < Number(viewBox[1]) && y2 < Number(viewBox[2]), `${viewport}: the leader ends inside the page`);
  }

  const failures = qa.viewports[viewport].geometry.failures;
  assert.deepEqual(failures.filter((f) => f.rule.startsWith("leader_")), [], `${viewport}: no leader crosses a label or another leader`);
  assert.equal(qa.viewports[viewport].passed, true, `${viewport}: render QA passes: ${JSON.stringify(failures.slice(0, 2))}`);
  console.log(`scatter ${viewport}: ${leaders.length} finite leaders end at their labels, no NaN token, render QA passes: PASS`);
}
