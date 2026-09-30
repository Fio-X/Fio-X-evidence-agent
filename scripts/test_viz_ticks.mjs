import assert from "node:assert/strict";
import { tickValues, logTickValues, tickLabel, renderVizBundle } from "../runtime/pi/viz.mjs";

function assertTicks(actual, expected, msg) {
  assert.equal(actual.length, expected.length, `${msg}: got [${actual}] expected [${expected}]`);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${msg}: tick[${i}] ${v} !== ${expected[i]} (got [${actual}])`));
}

// Linear domains snap to a d3-style 1/2/5 x 10^k step, not an equal split.
assertTicks(tickValues([0, 96.3], 4), [0, 20, 40, 60, 80], "[0,96.3] count4");
assertTicks(tickValues([0, 100], 4), [0, 20, 40, 60, 80, 100], "[0,100] count4");
assertTicks(tickValues([38.4, 61.6], 4), [40, 45, 50, 55, 60], "[38.4,61.6] count4");

{
  const ticks = tickValues([-12, 30], 4);
  assert.ok(ticks.includes(0), `[-12,30] should include 0, got [${ticks}]`);
}

{
  const ticks = tickValues([0, 0.73], 4);
  assertTicks(ticks, [0, 0.2, 0.4, 0.6], "[0,0.73] count4");
  ticks.forEach((t) => assert.equal(t, Number(t.toPrecision(12)), `float noise in tick ${t}`));
}

assertTicks(tickValues([0, 96.3], 2), [0, 50], "[0,96.3] count2");

// Every tick must land inside its domain and the array must ascend, for
// every linear case exercised above plus the two log cases below.
const linearCases = [
  [[0, 96.3], 4],
  [[0, 100], 4],
  [[38.4, 61.6], 4],
  [[-12, 30], 4],
  [[0, 0.73], 4],
  [[0, 96.3], 2],
];
for (const [domain, count] of linearCases) {
  const ticks = tickValues(domain, count);
  const lo = Math.min(...domain), hi = Math.max(...domain);
  for (const t of ticks) assert.ok(t >= lo - 1e-9 && t <= hi + 1e-9, `tick ${t} outside domain [${domain}]`);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1], `ticks not ascending: [${ticks}]`);
}

// Degenerate domains must not throw, loop forever, or come back empty.
assert.ok(tickValues([5, 5]).length >= 1, "degenerate [5,5] returned no ticks");
assert.ok(tickValues([0, 0]).length >= 1, "degenerate [0,0] returned no ticks");

// Log-space domains: {1,2,5}x10^k candidates inside the domain, thinned to
// bare powers of ten once there are more than 8.
assertTicks(logTickValues([3, 6]), [1e3, 1e4, 1e5, 1e6], "log [3,6]");
assertTicks(logTickValues([Math.log10(15), Math.log10(65)]), [20, 50], "log [log10(15),log10(65)]");

const logCases = [
  [3, 6],
  [Math.log10(15), Math.log10(65)],
];
for (const logDomain of logCases) {
  const ticks = logTickValues(logDomain);
  const lo = 10 ** Math.min(...logDomain), hi = 10 ** Math.max(...logDomain);
  for (const t of ticks) assert.ok(t >= lo - 1e-9 && t <= hi + 1e-9, `log tick ${t} outside domain [${logDomain}]`);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1], `log ticks not ascending: [${ticks}]`);
}
// Extra: a degenerate log domain (min===max) must not throw or come back empty.
assert.ok(logTickValues([2, 2]).length >= 1, "degenerate log domain [2,2] returned no ticks");

// Tick-only label formatting: strip a bare ".0" before k/m/bn; keep any
// other fractional digit; fmt() itself (data/value labels) is untouched.
assert.equal(tickLabel(2000, ""), "2k");
assert.equal(tickLabel(2500, ""), "2.5k");
assert.equal(tickLabel(40, "%"), "40%");

console.log("tick math: PASS");

// Render check: the chart the axis-tick fix targets - a horizontal bar
// chart whose largest value (96.3%) is not a round number. Spec shape
// copied from scripts/test_cjk_viz.mjs, English text.
const spec = {
  reader_task: "ranking",
  takeaway: "Eleven economies ranked by the tested indicator",
  chart_type: "horizontal_bar",
  title: "Eleven economies ranked by the tested indicator",
  subtitle: "Synthetic values chosen to exercise round-number axis ticks.",
  alt: "Horizontal bar chart ranking eleven economies from 96.3 percent down to 19.6 percent.",
  source_note: "Offline test fixture",
  note: "For nice-tick regression testing only.",
  claim_id: "claim-nice-ticks",
  sql: "SELECT 1",
  unit: "%",
  category_field: "name",
  value_field: "value",
  mixed_period_strategy: "reject",
  sort: "desc",
  direct_labels: true,
  annotations: [],
};
const rows = [
  { name: "Economy A", value: 96.3 },
  { name: "Economy B", value: 92.8 },
  { name: "Economy C", value: 83 },
  { name: "Economy D", value: 80.3 },
  { name: "Economy E", value: 79.6 },
  { name: "Economy F", value: 71.6 },
  { name: "Economy G", value: 71.4 },
  { name: "Economy H", value: 70 },
  { name: "Economy I", value: 66.6 },
  { name: "Economy J", value: 32.4 },
  { name: "Economy K", value: 19.6 },
];
const bundle = renderVizBundle(spec, rows, { mobilePages: false });
// Axis tick labels are the only text-anchor="middle" nodes horizontal_bar
// emits (category labels are anchor="end", value labels start/end).
const axisLabels = [...bundle.desktop.matchAll(/text-anchor="middle"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
// Fix 3 (units repeat on every tick): house style shows the unit once, on
// the last (highest-value) tick only - bare numbers on every other tick.
assert.deepEqual(axisLabels, ["0", "20", "40", "60", "80%"], `axis labels: [${axisLabels}]`);

console.log(`render check: PASS (axis labels ${axisLabels.join(", ")})`);
