#!/usr/bin/env node
// Map round B: deterministic pre-render label avoidance for dense small-unit
// choropleths, plus the map-face fixes (legend title, footnote columns,
// integer legend cap, framing). Synthetic rows only; no topic-specific data.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID, framingRings } from "../runtime/pi/choropleth.mjs";

// framingRings: drops only a ring that is both tiny and far from the main ring.
{
  const sq = (lon, lat, s) => [[lon, lat], [lon + s, lat], [lon + s, lat + s], [lon, lat + s], [lon, lat]];
  const main = sq(0, 0, 20);
  const nearTiny = sq(12, 10, 0.5);
  const farTiny = sq(170, -40, 0.5);
  const farBig = sq(100, 0, 15);
  assert.deepEqual(framingRings([main, nearTiny, farTiny, farBig]), [main, nearTiny, farBig]);
  assert.deepEqual(framingRings([farTiny]), [farTiny]);
  assert.deepEqual(framingRings([]), []);
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
const rows = mk(moderate);
const spec = { ...base, measure_kind: "count" };
const qaOf = (desktop, mobile) =>
  runRenderQa({ desktop, mobile }, { choropleth: { rows, category_field: "country", value_field: "n", category_names: "worldbank", unit: "n", measure_kind: "count" } });

const a = renderVizBundle(spec, rows);
const b = renderVizBundle(spec, rows);
assert.equal(a.desktop, b.desktop, "label layout is deterministic");

// Moderate density: baseline 327de35 had leader_crosses_text x2 and
// text_crosses_data_mark x1 here; those classes must now be gone. One
// pre-existing leader_label_overlaps_polygon (inset box vs a neighbour polygon)
// is a known residual and is the only failure tolerated.
{
  const qa = qaOf(a.desktop, a.mobile);
  const failures = Object.values(qa.viewports).flatMap((v) => ["geometry", "value_labels"].flatMap((k) => v[k]?.failures ?? []));
  const unexpected = failures.filter((f) => f.rule !== "leader_label_overlaps_polygon");
  assert.deepEqual(unexpected.map((f) => f.rule), [], `dense small-unit map: ${JSON.stringify(unexpected.map((f) => f.message))}`);
  assert.ok(failures.length <= 1, `at most the known residual, got ${failures.length}`);
}

// Numbered markers never overlap each other.
{
  const markers = [...a.desktop.matchAll(/data-role="choropleth-(?:footnote-marker|inset-marker)"[^>]*cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)]
    .map((m) => ({ x: +m[1], y: +m[2], r: +m[3] }));
  for (let i = 0; i < markers.length; i++) for (let j = i + 1; j < markers.length; j++) {
    assert.ok(Math.hypot(markers[i].x - markers[j].x, markers[i].y - markers[j].y) >= markers[i].r + markers[j].r, `markers ${i}/${j} overlap`);
  }
}

// Legend title is the measure, not the chart title.
{
  const t = a.desktop.match(/data-role="choropleth-legend-title"[^>]*>([^<]*)</)?.[1];
  assert.ok(t !== undefined && t !== spec.title, `legend title must not repeat the chart title (got ${t})`);
}

// Footnote numbers are right-aligned so two-digit rows line up.
{
  const nums = [...a.desktop.matchAll(/<text data-role="choropleth-footnote-number"[^>]*>/g)].map((m) => m[0]);
  for (const n of nums) assert.match(n, /text-anchor="end"/, "footnote number is right-aligned");
}

// Integer data: the legend never runs past the data maximum.
{
  const max = Math.max(...rows.map((r) => r.n));
  const ticks = [...a.desktop.matchAll(/data-role="choropleth-legend-tick"[^>]*>([^<]*)</g)].map((m) => Number(m[1].replace(/[^\d.-]/g, ""))).filter(Number.isFinite);
  assert.ok(ticks.every((t) => t <= max), `legend ticks ${ticks} exceed the data max ${max}`);
}

// Stress density (29 tiny/dispersed units): baseline 327de35 had 45 QA failures.
{
  const stressRows = mk(names);
  const s = renderVizBundle(spec, stressRows);
  const qa = runRenderQa({ desktop: s.desktop, mobile: s.mobile }, { choropleth: { rows: stressRows, category_field: "country", value_field: "n", category_names: "worldbank", unit: "n", measure_kind: "count" } });
  assert.ok(qa.failure_count <= 20, `stress map regressed: ${qa.failure_count} QA failures (was 45 before avoidance, 15 after)`);
}
console.log("map label avoidance -- PASS");
