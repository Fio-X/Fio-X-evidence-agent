#!/usr/bin/env node
// Negative percentage line charts (desktop, mobile and compact): the value
// axis must reach below zero and every plotted point must sit inside the
// tick-bracketed plot area. (lineAxisDomain used to pin the floor at 0 for
// percent charts; this is an intended change, mobile pages included.)
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const base = { schema_version: "0.7.0", direct_labels: true, annotations: [], title: "Negative percent line", subtitle: "s", alt: "A line chart whose values are negative percentages.", source_note: "fixture", sql: "select 1", claim_id: "claim-neg", reader_task: "sequence", takeaway: "t", language: "zh", x_field: "x", value_field: "v", unit: "%" };
const years = Array.from({ length: 12 }, (_, i) => String(2012 + i));
const single = { spec: { ...base, chart_type: "line" }, rows: years.map((x, i) => ({ x, v: -9 + i * 0.4 })) };
const multi = { spec: { ...base, chart_type: "multi_line", series_field: "s", highlight_values: ["甲"] }, rows: years.flatMap((x, i) => [["甲", -12 + i * 0.5], ["乙", -3 - i * 0.6]].map(([s, v]) => ({ x, s, v }))) };

for (const [name, { spec, rows }] of Object.entries({ line: single, multi_line: multi })) {
  const bundle = renderVizBundle(spec, rows, { mobilePages: true, compact: false });
  const compact = renderVizBundle(spec, rows, { mobilePages: false, compact: true }).compact;
  for (const [viewport, svg] of [["desktop", bundle.desktop], ["mobile", bundle.mobile], ["compact", compact]]) {
    const ticks = [...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter((t) => /^[−-]\d/.test(t.trim()));
    assert.ok(ticks.length > 0, `${name} ${viewport}: the axis has a tick below zero: no negative tick label found`);
    const qa = runRenderQa(viewport === "compact" ? { desktop: bundle.desktop, compact: svg } : { desktop: bundle.desktop, mobile: bundle.mobile });
    const failures = qa.viewports[viewport].geometry.failures;
    assert.deepEqual(failures.filter((f) => f.rule === "value_axis_domain_bracket"), [], `${name} ${viewport}: every point is inside the tick-bracketed range`);
    assert.equal(qa.viewports[viewport].passed, true, `${name} ${viewport}: render QA passes: ${JSON.stringify(failures.slice(0, 2))}`);
  }
  console.log(`${name}: negative percent axis reaches below zero, all points inside the plot (desktop, mobile, compact): PASS`);
}
