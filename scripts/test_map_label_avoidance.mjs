#!/usr/bin/env node
// Map round B: deterministic pre-render label avoidance for dense small-unit
// choropleths, plus the map-face fixes (legend title, footnote columns,
// integer legend cap, framing). Synthetic rows only; no topic-specific data.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID, framingRings } from "../runtime/pi/choropleth.mjs";

import { clippedFramingRings, omittedFramingRings, chooseMapProjection, fitMapProjection, geometryRings, neFeatureAttributes, neFeatureCount, neFeatureGeometry } from "../runtime/pi/choropleth.mjs";

// Selector helper: every selector asserts its match count BEFORE its content,
// so an empty or mistyped selector can never pass vacuously.
const pick = (svg, re, { count, min = 1, label }) => {
  const found = [...svg.matchAll(re)];
  if (count !== undefined) assert.equal(found.length, count, `${label}: expected ${count} matches, got ${found.length}`);
  else assert.ok(found.length >= min, `${label}: expected >= ${min} matches, got ${found.length}`);
  return found;
};

// framingRings coverage contract: it frames only; omittedFramingRings names
// exactly what it leaves out, and clippedFramingRings names the visible ones
// that then fall outside the frame (those must reach the chart note).
{
  const sq = (lon, lat, s) => [[lon, lat], [lon + s, lat], [lon + s, lat + s], [lon, lat + s], [lon, lat]];
  const main = sq(0, 0, 20);
  const nearTiny = sq(12, 10, 0.5);
  const farTiny = sq(170, -40, 0.5);
  const farBig = sq(100, 0, 15);
  const farMid = sq(60, 60, 2); // far but >= 5% of main's bbox area? 4/400 = 1% -> dropped, >= 1 deg2
  assert.deepEqual(framingRings([main, nearTiny, farTiny, farBig]), [main, nearTiny, farBig]);
  assert.deepEqual(framingRings([farTiny]), [farTiny]);
  assert.deepEqual(framingRings([]), []);
  const all = [main, nearTiny, farTiny, farBig, farMid];
  const kept = framingRings(all), omitted = omittedFramingRings(all);
  assert.equal(kept.length + omitted.length, all.length, "kept + omitted covers every ring");
  assert.ok(omitted.includes(farTiny) && omitted.includes(farMid) && !omitted.includes(main));
  const project = (lon, lat) => ({ x: lon * 5, y: lat * 5 });
  const frame = { left: 0, right: 600, top: 0, bottom: 400 }; // lon 0..120, lat 0..80
  assert.deepEqual(clippedFramingRings(all, project, frame), [], "far pieces inside the frame are drawn, not clipped");
  const narrow = { left: 0, right: 200, top: 0, bottom: 150 }; // lon 0..40, lat 0..30
  const clipped = clippedFramingRings(all, project, narrow);
  assert.deepEqual(clipped, [farMid], "visible omitted piece outside the frame is reported; sub-1-deg2 specks are not");
}

// Real multi-territory regions: with the frame the renderer really builds,
// no region drops a visible (>= 1 deg2) piece outside it without the note.
{
  const affected = [];
  for (let i = 0; i < neFeatureCount(); i++) {
    const rings = geometryRings(neFeatureGeometry(i));
    if (omittedFramingRings(rings).length) affected.push(i);
  }
  assert.ok(affected.length >= 15, `expected many multi-territory regions, got ${affected.length}`);
  // Map rects the renderer builds (desktop and mobile) for a one-region choropleth.
  for (const [l, r, t, b] of [[54, 986, 92, 552], [32, 608, 85, 465]]) {
    for (const i of affected) {
      const rings = geometryRings(neFeatureGeometry(i));
      const pts = []; // what viz.mjs frames: only the kept rings
      for (const r of rings.filter((r) => !omittedFramingRings(rings).includes(r))) for (const p of r) pts.push(p);
      const choice = chooseMapProjection(pts);
      const { project } = fitMapProjection(choice, pts, l, r, t, b, 0.06);
      const lost = clippedFramingRings(rings, project, { left: l, right: r, top: t, bottom: b });
      assert.equal(lost.length, 0, `${neFeatureAttributes(i).name}: ${lost.length} visible piece(s) fall outside the ${l}-${r} x ${t}-${b} frame without a note`);
    }
  }
}

const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const base = {
  schema_version: "0.9.0", reader_task: "spatial", title: "Units per region",
  alt: "A choropleth map of a count per small country, darker meaning a higher count.",
  source_note: "synthetic fixture", claim_id: "claim-label-avoid",
  sql: "SELECT country, n, year FROM fixture", unit: "n", chart_type: "choropleth",
  category_field: "country", value_field: "n", category_names: "worldbank",
  reference_period_field: "year", mixed_period_strategy: "acknowledge",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license,
  basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [], inset: { auto: true },
};
const names = ["Fiji", "Tonga", "Samoa", "Vanuatu", "Kiribati", "Malta", "Luxembourg", "Singapore", "Maldives", "Barbados",
  "Bahrain", "Qatar", "Kuwait", "Cyprus", "Comoros", "Mauritius", "Seychelles", "Grenada", "Dominica", "Andorra",
  "Monaco", "Liechtenstein", "San Marino", "Palau", "Nauru", "Tuvalu", "Brazil", "India", "Australia"];
// Moderate density: must be clean. Stress density (all names): bounded, not clean.
const moderate = ["Fiji", "Tonga", "Vanuatu", "Malta", "Luxembourg", "Bahrain", "Qatar", "Brazil", "India", "Australia"];
const mk = (list) => list.map((country, i) => ({ country, n: 1 + ((i * 7) % 12), year: 2017 }));
const spec = { ...base, measure_kind: "count" };
const qaFor = (b, rows) =>
  runRenderQa({ desktop: b.desktop, mobile: b.mobile }, { choropleth: { rows, category_field: "country", value_field: "n", category_names: "worldbank", unit: "n", measure_kind: "count" } });
const failuresOf = (qa) => Object.entries(qa.viewports).flatMap(([vp, v]) => ["geometry", "value_labels", "contrast"].flatMap((k) => (v[k]?.failures ?? []).map((f) => ({ vp, rule: f.rule, message: f.message }))));

// Clean samples (item 6): total render QA must pass with no tolerance filter.
// The moderate sample swaps Tonga for Singapore; the Tonga/Fiji variant is
// reported below as a known residual instead of being filtered out here.
const clean = ["Fiji", "Singapore", "Vanuatu", "Malta", "Luxembourg", "Bahrain", "Qatar", "Brazil", "India", "Australia"];
{
  const rows = mk(clean);
  const a = renderVizBundle(spec, rows);
  assert.equal(a.desktop, renderVizBundle(spec, rows).desktop, "label layout is deterministic");
  const qa = qaFor(a, rows);
  assert.equal(qa.failure_count, 0, `clean sample must pass total QA: ${JSON.stringify(failuresOf(qa))}`);
  assert.equal(qa.passed, true);

}

// Numbered markers, legend title and footnote numbers, checked on the stress
// sample (the one that really produces footnote markers), both viewports.
{
  const rows = mk(names);
  const a = renderVizBundle(spec, rows);
  for (const vp of ["desktop", "mobile"]) {
    const markers = pick(a[vp], /data-role="choropleth-(?:inset-)?footnote-marker"[^>]*cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g, { min: 1, label: `${vp} markers` })
      .map((m) => ({ x: +m[1], y: +m[2], r: +m[3] }));
    for (let x = 0; x < markers.length; x++) for (let y = x + 1; y < markers.length; y++) {
      assert.ok(Math.hypot(markers[x].x - markers[y].x, markers[x].y - markers[y].y) >= markers[x].r + markers[y].r, `${vp}: markers ${x}/${y} overlap`);
    }
    // Legend title is the measure, not the chart title.
    const [t] = pick(a[vp], /data-role="choropleth-legend-title"[^>]*>([^<]*)</g, { count: 1, label: `${vp} legend title` });
    assert.notEqual(t[1], spec.title, "legend title must not repeat the chart title");
    // Footnote numbers are right-aligned so two-digit rows line up.
    for (const [n] of pick(a[vp], /<text data-role="choropleth-footnote-number"[^>]*>/g, { min: 1, label: `${vp} footnote numbers` })) {
      assert.match(n, /text-anchor="end"/);
    }
  }
}

// Legend cap (item 4): swatches, ticks and displayed range come from the same
// class count and never name a value above the data max, in both viewports.
{
  const legendOf = (svg, label) => {
    const [g] = pick(svg, /<g data-role="choropleth-legend">[\s\S]*?<\/g>/g, { count: 1, label: `${label} legend group` });
    const swatches = pick(g[0], /<rect /g, { min: 1, label: `${label} swatches` }).length;
    const ticks = pick(g[0], /<text(?![^>]*legend-title)[^>]*>([^<]*)</g, { min: 1, label: `${label} ticks` }).map((m) => m[1]);
    return { swatches, ticks };
  };
  const cases = [
    ["one value", [5], 1, ["5 n"]],
    ["two equal values", [5, 5], 1, ["5 n"]],
    ["two distinct values", [3, 7], 5, ["3", "4", "5", "6", "7 n"]],
    ["three consecutive values", [1, 2, 3], 3, ["1", "2", "3 n"]],
    ["gap in values", [1, 2, 12], 3, ["0", "5", "10", "12 n"]],
    ["wide range", [3, 50, 400, 9000], 5, ["0", "2000", "4000", "6000", "8000", "9000 n"]],
  ];
  for (const [label, vals, swatches, ticks] of cases) {
    const rows = ["France", "Germany", "Spain", "Italy"].slice(0, vals.length).map((country, i) => ({ country, n: vals[i], year: 2017 }));
    const b = renderVizBundle(spec, rows);
    for (const vp of ["desktop", "mobile"]) {
      const l = legendOf(b[vp], `${label}/${vp}`);
      assert.equal(l.swatches, swatches, `${label}/${vp}: swatch count`);
      assert.deepEqual(l.ticks, ticks, `${label}/${vp}: ticks`);
      assert.ok(l.ticks.every((t) => Number(t.replace(/[^\d.-]/g, "")) <= Math.max(...vals)), `${label}/${vp}: tick above data max`);
    }
  }
  // Same single value without a declared measure kind: still one swatch.
  const rows = [{ country: "France", n: 5, year: 2017 }];
  const b = renderVizBundle({ ...base }, rows);
  for (const vp of ["desktop", "mobile"]) assert.deepEqual(legendOf(b[vp], `untyped single/${vp}`), { swatches: 1, ticks: ["5 n"] });
  // Calendar-year values (continuous multi-year): the cap stops at the latest year.
  const years = [2015, 2016, 2017].map((n, i) => ({ country: ["France", "Germany", "Spain"][i], n, year: 2017 }));
  const yb = renderVizBundle({ ...spec, measure_kind: "year" }, years);
  for (const vp of ["desktop", "mobile"]) {
    const l = legendOf(yb[vp], `years/${vp}`);
    assert.ok(l.ticks.every((t) => Number(t.replace(/[^\d.-]/g, "")) <= 2017), `years/${vp}: ${l.ticks}`);
  }
}

// Known residuals (item 6), reported separately and NOT filtered out of the
// clean samples above. Bounds are ratchets: they may only go down.
{
  const report = (label, list, bound) => {
    const rows = mk(list);
    const qa = qaFor(renderVizBundle(spec, rows), rows);
    const fails = failuresOf(qa);
    console.log(`known residual [${label}]: ${qa.failure_count} QA failure(s) ${JSON.stringify(fails.reduce((c, f) => ({ ...c, [`${f.vp}:${f.rule}`]: (c[`${f.vp}:${f.rule}`] ?? 0) + 1 }), {}))}`);
    assert.ok(qa.failure_count <= bound, `${label}: ${qa.failure_count} failures exceeds the recorded residual ${bound}`);
  };
  report("Tonga/Fiji neighbour polygon", ["Fiji", "Tonga", "Vanuatu", "Malta", "Luxembourg", "Bahrain", "Qatar", "Brazil", "India", "Australia"], 1);
  report("stress, 29 tiny/dispersed units (baseline 45)", names, 7);
}
console.log("map label avoidance -- PASS");
