#!/usr/bin/env node
// Line / multi_line value axis: the tick list must bracket every plotted value.
// lineAxisDomain widens the data range by the step of the data range, but
// lineAxisTicks re-derives its own step from the widened span and used to round
// to the *nearest* tick, which for a domain whose edges are not multiples of
// that step lands the lowest (or highest) tick just inside the domain: data
// 18..64 gave domain [10, 70], tick step 20 and ticks 20..80, so the point at 18
// hung below the lowest tick (render QA value_axis_domain_bracket). Seeded random
// series sets - negatives, tiny and huge magnitudes, %-unit zero baselines - plus
// series whose lowest/highest value sits just below/above a nice tick, on the
// desktop, mobile and compact pages. Synthetic data only.
import assert from "node:assert/strict";
import { lineAxisDomain, lineAxisTicks, renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";

const base = {
  schema_version: "0.7.0", reader_task: "change", takeaway: "t", title: "Axis bracket", subtitle: "synthetic",
  alt: "A line chart of synthetic series whose values must stay inside the axis.", source_note: "synthetic fixture",
  claim_id: "claim-axis-bracket", sql: "SELECT 1", direct_labels: true, annotations: [], language: "zh",
  x_field: "x", value_field: "v",
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261002);
const pick = (list) => list[Math.floor(rnd() * list.length)];
const sig = (v) => Number(v.toPrecision(4));

const years = (count) => Array.from({ length: count }, (_, i) => 2010 + i);
const cases = [];

// The reported chart: lowest value 18 under a lowest tick of 20, highest 64.
cases.push({
  name: "reported 18..64", unit: "万件",
  series: { 产品甲: [18, 25, 31, 40, 47, 52, 58, 64], 产品乙: [30, 33, 36, 35, 41, 44, 47, 46] },
});

// The lowest / highest / most negative value sits just below / above a nice tick.
for (const tick of [20, 50, 100, 0.5, 2000]) {
  for (const f of [0.002, 0.03]) {
    for (const [label, lo, hi] of [
      [`lowest ${tick}x(1-${f})`, tick * (1 - f), tick * 3.2],
      [`highest ${tick}x(1+${f})`, tick * 0.4, tick * (1 + f)],
      [`negative -${tick}x(1+${f})`, -tick * (1 + f), tick * 0.7],
    ]) {
      const count = 6 + Math.floor(rnd() * 3);
      const ramp = Array.from({ length: count }, (_, i) => sig(lo + ((hi - lo) * i) / (count - 1)));
      const band = Array.from({ length: count }, (_, i) => sig(lo + (hi - lo) * (0.3 + 0.4 * ((i * 7) % count) / count)));
      cases.push({ name: label, unit: pick(["万件", "指数", "°C"]), series: { 甲: ramp, 乙: band } });
    }
  }
}

// Seeded random series sets: offsets below zero, magnitudes from 0.01 to 1000, %-unit zero baselines.
for (let i = 0; i < 30; i++) {
  const scale = pick([0.01, 0.1, 1, 10, 100, 1000]);
  const offset = pick([0, 0, -50, -3, 20, 200]) * scale;
  const count = 3 + Math.floor(rnd() * 8);
  const series = {};
  for (let s = 0; s < 1 + Math.floor(rnd() * 3); s++) {
    series[`系列${s + 1}`] = Array.from({ length: count }, () => sig(offset + scale * (rnd() * 60 + s * 7)));
  }
  cases.push({ name: `random #${i + 1}`, unit: pick(["万件", "%", "°C", "指数", "亿元"]), series });
}
assert.ok(cases.length >= 20, "at least 20 series sets");

const attrOf = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
// Strict, pixel-level re-check straight from the SVG (the render QA rule allows 0.75px of slack).
function axisAndPoints(svg) {
  const tickYs = [...svg.matchAll(/<line [^>]*data-role="value-axis-tick"[^>]*>/g)].map((m) => Number(attrOf(m[0], "y1")));
  const pointYs = [
    ...[...svg.matchAll(/<circle [^>]*data-role="line-point"[^>]*>/g)].map((m) => Number(attrOf(m[0], "cy"))),
    ...[...svg.matchAll(/<polyline [^>]*data-role="line-path"[^>]*>/g)].flatMap((m) => attrOf(m[0], "points").trim().split(/\s+/).map((p) => Number(p.split(",")[1]))),
  ];
  return { tickYs, pointYs };
}

let pages = 0, oldRoundingWouldMiss = 0, bracketed = 0;
cases.forEach((c, index) => {
  const names = Object.keys(c.series);
  const rows = names.flatMap((name) => c.series[name].map((v, i) => ({ x: years(c.series[name].length)[i], s: name, v })));
  const values = rows.map((r) => r.v);
  const single = names.length === 1 || index % 5 === 4;
  const useRows = single ? rows.filter((r) => r.s === names[0]) : rows;
  const spec = { ...base, unit: c.unit, ...(single ? { chart_type: "line" } : { chart_type: "multi_line", series_field: "s", highlight_values: [names[0]] }) };
  const plotted = useRows.map((r) => r.v);

  // The tick list handed to the renderer covers the data, strictly (to float noise).
  const domain = lineAxisDomain(plotted, c.unit === "%", 4);
  const ticks = lineAxisTicks(domain, 4);
  const noise = (ticks[1] - ticks[0]) * 1e-6;
  assert.ok(ticks[0] <= Math.min(...plotted) + noise, `${c.name}: lowest tick ${ticks[0]} must not sit above the lowest value ${Math.min(...plotted)}`);
  assert.ok(ticks.at(-1) >= Math.max(...plotted) - noise, `${c.name}: highest tick ${ticks.at(-1)} must not sit below the highest value ${Math.max(...plotted)}`);
  const legacy = lineAxisTicks(domain, 4, false);
  if (legacy[0] > Math.min(...plotted) + noise || legacy.at(-1) < Math.max(...plotted) - noise) oldRoundingWouldMiss += 1;
  bracketed += 1;

  const bundle = renderVizBundle(spec, useRows, { mobilePages: true, compact: true });
  const qa = runRenderQa({ desktop: bundle.desktop, mobile: bundle.mobile, compact: bundle.compact });
  for (const viewport of ["desktop", "mobile", "compact"]) {
    const tag = `${c.name} (${spec.chart_type}, ${c.unit}) ${viewport}`;
    const findings = qa.viewports[viewport].geometry.failures.filter((f) => f.rule === "value_axis_domain_bracket");
    assert.deepEqual(findings, [], `${tag}: render QA reports no point outside the ticks`);
    const { tickYs, pointYs } = axisAndPoints(bundle[viewport]);
    assert.ok(tickYs.length >= 3, `${tag}: the value axis is drawn (${tickYs.length} ticks)`);
    assert.ok(pointYs.length >= plotted.length, `${tag}: every observation is on the page (${pointYs.length} points for ${plotted.length} values)`);
    assert.ok(pointYs.every(Number.isFinite), `${tag}: every plotted y is finite`);
    assert.ok(Math.min(...pointYs) >= Math.min(...tickYs) - 1e-6, `${tag}: no point above the highest tick`);
    assert.ok(Math.max(...pointYs) <= Math.max(...tickYs) + 1e-6, `${tag}: no point below the lowest tick`);
    pages += 1;
  }
});
assert.ok(oldRoundingWouldMiss >= 5, `the series sets exercise the defect: the old nearest-tick rounding misses the data in ${oldRoundingWouldMiss} of ${cases.length}`);

// The legacy style keeps its nearest-tick rounding byte-for-byte; house style covers the domain.
assert.deepEqual(lineAxisTicks([10, 70], 4, false), [20, 40, 60, 80], "legacy rounding is unchanged");
assert.deepEqual(lineAxisTicks([10, 70], 4), [0, 20, 40, 60, 80], "the default tick list covers the whole domain");
assert.deepEqual(lineAxisTicks([0, 100], 4), lineAxisTicks([0, 100], 4, false), "a domain that is already a multiple of its step is untouched");
{
  const reported = cases[0];
  const rows = Object.entries(reported.series).flatMap(([s, vs]) => vs.map((v, i) => ({ x: years(vs.length)[i], s, v })));
  const spec = { ...base, unit: reported.unit, chart_type: "multi_line", series_field: "s", highlight_values: ["产品甲"] };
  const count = (svg) => (svg.match(/data-role="value-axis-tick"/g) ?? []).length;
  assert.equal(count(renderVizBundle(spec, rows, { mobilePages: false }).desktop), 5, "house style: ticks 0, 20, 40, 60, 80");
  assert.equal(count(renderVizBundle({ ...spec, style_id: "legacy" }, rows, { mobilePages: false }).desktop), 4, "legacy style: ticks 20, 40, 60, 80 as before");
}

console.log(`line axis: ${cases.length} series sets (${pages} pages, desktop+mobile+compact), ${bracketed} tick lists bracket every value (the old rounding missed ${oldRoundingWouldMiss}), no value_axis_domain_bracket: PASS`);
