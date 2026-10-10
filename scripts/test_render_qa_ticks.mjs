// Tests for the tick / value-label read-back (NEWSROOM_QA_TICK_READBACK=1): every case in
// scripts/fixtures/tick_readback/cases.json against runtime/pi/render_qa_ticks.mjs, the report wiring in
// render_qa.mjs, and the switch matrix. The same cases.json is read by the Python and Rust tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTickReadback } from "../runtime/pi/render_qa_ticks.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tick_readback");
const fixtures = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf8"));
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));

function build(c) {
  const f = fixtures[c.fixture];
  let svg = readFileSync(join(dir, f.file), "utf8");
  for (const e of c.edits ?? []) {
    assert.ok(svg.includes(e.find), `${c.name}: edit target not found: ${e.find}`);
    svg = svg.replace(e.find, () => e.replace);
  }
  const rows = [...f.rows, ...(c.rows_extra ? [c.rows_extra] : [])];
  const ctx = { chart_type: f.chart_type, rows, category_field: f.category_field, value_field: f.value_field, ...(f.series_field ? { series_field: f.series_field } : {}), ...(f.period_field ? { period_field: f.period_field } : {}), ...(f.unit !== undefined ? { unit: f.unit } : {}), ...(f.language ? { language: f.language } : {}), ...(c.ctx ?? {}) };
  for (const key of c.ctx_drop ?? []) delete ctx[key];
  return { svg, ctx };
}

let n = 0;
for (const c of cases) {
  const { svg, ctx } = build(c);
  const result = checkTickReadback(svg, ctx);
  if (c.expect === "green") assert.deepEqual(result.failures, [], `${c.name}: ${JSON.stringify(result.failures)}`);
  else if (c.expect === "uncovered") { assert.equal(result.status, "uncovered", c.name); assert.notEqual(result.passed, true, `${c.name}: uncovered must never read as passed`); }
  else {
    assert.ok(result.failures.length > 0, `${c.name}: expected failures, got none`);
    assert.ok(result.failures.some((x) => x.rule === c.rule), `${c.name}: expected rule ${c.rule}, got ${result.failures.map((x) => x.rule)}`);
  }
  n++;
}

// switch matrix through runRenderQa: only the exact "1" adds the rule; every other value leaves the report as before
const good = build(cases[0]);
const bad = build(cases.find((c) => c.name.startsWith("t1 tick text 500万 -> 5000万 (A)")));
const render = (svg, ctx) => JSON.stringify(runRenderQa({ desktop: svg }, ctx ? { tick_readback: ctx } : {}));
const plain = render(bad.svg, null);
const old = process.env.NEWSROOM_QA_TICK_READBACK;
try {
  for (const value of [undefined, "0", "", "yes", " 1", "on"]) {
    if (value === undefined) delete process.env.NEWSROOM_QA_TICK_READBACK; else process.env.NEWSROOM_QA_TICK_READBACK = value;
    assert.equal(render(bad.svg, bad.ctx), plain, `switch ${JSON.stringify(value)} must leave the report unchanged`);
  }
  process.env.NEWSROOM_QA_TICK_READBACK = "1";
  const on = JSON.parse(render(bad.svg, bad.ctx));
  assert.equal(on.passed, false);
  assert.ok(on.failure_count >= 1 && on.viewports.desktop.tick_readback.failures.length >= 1);
  const ok = JSON.parse(render(good.svg, good.ctx));
  assert.equal(ok.viewports.desktop.tick_readback.passed, true);
  const unc = JSON.parse(render(good.svg, { ...good.ctx, chart_type: "line" }));
  assert.equal(unc.viewports.desktop.tick_readback.status, "uncovered");
  assert.equal(unc.viewports.desktop.tick_readback.passed, false, "uncovered is never recorded as passed");
} finally {
  if (old === undefined) delete process.env.NEWSROOM_QA_TICK_READBACK; else process.env.NEWSROOM_QA_TICK_READBACK = old;
}
console.log(`ok test_render_qa_ticks: ${n} cases + switch matrix`);
