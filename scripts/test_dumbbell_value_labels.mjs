#!/usr/bin/env node
// Dumbbell value labels: the lower value's label must sit beyond the lower end
// of the span and the higher value's beyond the higher end, so the two labels
// always point away from each other, and identical values get a single label.
// A reversed pair (start above end) used to put both labels on the inside of
// the span, so close values printed "18%" on top of "17%" (render QA
// text_overlap). Gaps of 0, 0.5, 1 and 10 units are swept across pixel
// distances from touching dots to well apart, both ways round, desktop and
// mobile. Synthetic data only.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const base = {
  schema_version: "0.7.0", reader_task: "comparison", takeaway: "t", title: "Dumbbell labels", subtitle: "synthetic",
  alt: "A dumbbell chart of synthetic start and end values per category.", source_note: "synthetic fixture",
  claim_id: "claim-dumbbell-labels", sql: "SELECT 1", unit: "%", highlight_values: [], direct_labels: true, annotations: [],
  language: "zh", chart_type: "dumbbell", category_field: "c", start_field: "s", end_field: "e",
};

// Row 1 spans the whole domain; row 2 holds the close pair at its middle. The
// domain span sets how many pixels `gap` units occupy, so sweeping the span
// sweeps the pixel distance between the two dots (the old overlap window was
// roughly 14-56px apart on the desktop page).
function render(gap, dir, pixelsPerGap) {
  const span = gap === 0 ? pixelsPerGap * 10 : (gap * 695) / pixelsPerGap;
  const low = 100, mid = low + span / 2;
  const rows = [{ c: "下界", s: low, e: low + span }, { c: "甲", s: mid, e: mid + dir * gap }];
  return renderVizBundle({ ...base }, rows, { mobilePages: true });
}

// The dumbbell rows of a page: each row's start/end dots (drawn in that order)
// and the value labels sitting 9px above its line.
function dumbbellRows(svg) {
  const dots = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="(?:5|4\.8)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  const texts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="(\w+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), anchor: m[3], text: m[4] }));
  const rows = [];
  for (let i = 0; i + 1 < dots.length; i += 2) {
    rows.push({ start: dots[i], end: dots[i + 1], labels: texts.filter((t) => Math.abs(t.y - (dots[i].y - 9)) < 0.01).sort((p, q) => p.x - q.x) });
  }
  return rows;
}

let cases = 0, equalCases = 0, overlapWindowCases = 0;
for (const gap of [0, 0.5, 1, 10]) {
  for (const dir of [1, -1]) {
    for (const pixelsPerGap of gap === 0 ? [1] : [3, 8, 14, 20, 28, 40, 56, 80]) {
      const bundle = render(gap, dir, pixelsPerGap);
      const qa = runRenderQa({ desktop: bundle.desktop, mobile: bundle.mobile });
      for (const viewport of ["desktop", "mobile"]) {
        const tag = `${viewport} gap=${gap} dir=${dir > 0 ? "end above start" : "start above end"} dots ~${pixelsPerGap}px apart on desktop`;
        const failures = qa.viewports[viewport].geometry.failures;
        assert.deepEqual(failures.filter((f) => f.rule === "text_overlap"), [], `${tag}: no two value labels overlap`);
        assert.deepEqual(failures, [], `${tag}: render QA is clean`);

        const row = dumbbellRows(bundle[viewport])[1];
        const dotLeft = Math.min(row.start.x, row.end.x), dotRight = Math.max(row.start.x, row.end.x);
        const [first, last] = [row.labels[0], row.labels.at(-1)];
        if (row.labels.length === 1) {
          // Identical displayed values: one label, beside the end dot.
          equalCases += 1;
          assert.equal(first.anchor, "start", `${tag}: the single label starts after the dots`);
          assert.ok(first.x > dotRight, `${tag}: the single label sits right of both dots`);
        } else {
          assert.equal(row.labels.length, 2, `${tag}: two value labels for two different values`);
          assert.notEqual(first.text, last.text, `${tag}: the two labels show different values`);
          assert.ok(first.anchor === "end" && first.x < dotLeft, `${tag}: the left label ends before the left dot`);
          assert.ok(last.anchor === "start" && last.x > dotRight, `${tag}: the right label starts after the right dot`);
          assert.ok(parseFloat(first.text) <= parseFloat(last.text), `${tag}: the lower value is on the left (${first.text} / ${last.text})`);
        }
        cases += 1;
        if (gap > 0 && dotRight - dotLeft > 14 && dotRight - dotLeft < 56) overlapWindowCases += 1;
      }
    }
  }
}
assert.ok(equalCases >= 4, `equal values are exercised (${equalCases} cases)`);
assert.ok(overlapWindowCases >= 8, `the old overlap window is exercised (${overlapWindowCases} cases)`);
console.log(`dumbbell: ${cases} pages (gaps 0/0.5/1/10, both orders, desktop+mobile): lower value left, higher right, one label when equal, no overlap: PASS`);
