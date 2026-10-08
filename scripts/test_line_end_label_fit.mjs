#!/usr/bin/env node
// NEWSROOM_LINE_END_LABEL_FIT (default off): a single-series line chart's end label with a long unit stays inside the
// frame, at both widths, with every character kept. Synthetic input, calls the renderer directly (no browser).
import assert from "node:assert/strict";
import { renderVizSvg, renderVizCompactSvg } from "../runtime/pi/viz.mjs";
import { checkSvgGeometry } from "../runtime/pi/render_qa_geometry.mjs";

const KEY = "NEWSROOM_LINE_END_LABEL_FIT";
const withEnv = (value, fn) => { const old = process.env[KEY]; if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value; try { return fn(); } finally { if (old === undefined) delete process.env[KEY]; else process.env[KEY] = old; } };
const spec = { schema_version: "0.7.0", direct_labels: true, annotations: [], title: "End label fit", subtitle: "s", alt: "A chart used to check the end label stays inside the frame.", source_note: "fixture", sql: "select 1", claim_id: "claim-endfit", reader_task: "change", takeaway: "t", language: "zh", chart_type: "line", x_field: "x", value_field: "v", unit: "‰（每千人）" };
const rows = Array.from({ length: 30 }, (_, i) => ({ x: String(1994 + i), v: 40 - i * 1.1 }));
const labelTexts = (svg) => [...svg.matchAll(/<text data-role="direct-label"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

for (const [name, render] of [["desktop", renderVizSvg], ["compact", renderVizCompactSvg]]) {
  const off = withEnv(undefined, () => render(spec, rows)), zero = withEnv("0", () => render(spec, rows)), on = withEnv("1", () => render(spec, rows));
  assert.equal(off, zero, `${name}: any value other than "1" is the same as unset`);
  assert.ok(checkSvgGeometry(off).failures.some((f) => f.rule === "text_outside_viewbox"), `${name} off: today's label crosses the right edge`);
  assert.deepEqual(checkSvgGeometry(on).failures.filter((f) => f.rule === "text_outside_viewbox"), [], `${name} on: the end label is inside the frame`);
  const lines = labelTexts(on);
  assert.equal(lines.length, 2, `${name} on: two lines`);
  assert.equal(lines.join(""), labelTexts(off).join(""), `${name} on: same characters, only broken`);
  assert.ok(lines[0].endsWith("\u2030") && lines[1].startsWith("\uFF08"), `${name} on: the per-mille sign stays with its number, the break is before the bracket`);
  assert.ok(!/^[%\u2030\u00B0\u2103]/u.test(lines[1]), `${name} on: no line starts with a unit sign`);
  assert.ok(!/font-size="(?:[0-9]|1[01])"/.test(on.slice(on.indexOf("direct-label"))) , `${name} on: font stays at 12`);
}
// A unit sign never starts a line: a label with a space only after the sign breaks at the bracket, a bare "x ‰" has no usable break.
{
  const rowsP = rows.map((r) => ({ ...r })), per = { ...spec, unit: "‰" };
  const lines = labelTexts(withEnv("1", () => renderVizSvg(per, rowsP)));
  assert.ok(lines.every((t) => !/^[%‰°℃]/u.test(t)), "no line starts with a unit sign");
}
// A label that already fits is untouched, switch on or off.
const short = { ...spec, unit: "%" };
for (const render of [renderVizSvg, renderVizCompactSvg]) assert.equal(withEnv("1", () => render(short, rows)), withEnv(undefined, () => render(short, rows)), "a label that fits is byte-identical");
console.log("test_line_end_label_fit: ok");
