#!/usr/bin/env node
// Displaced numbered markers keep a visible geographic link (tether), and
// render QA fails a displaced marker without one. Synthetic rows only.
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { runRenderQa } from "../runtime/pi/render_qa.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID } from "../runtime/pi/choropleth.mjs";

const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const spec = {
  schema_version: "0.9.0", reader_task: "spatial", title: "Units per region",
  alt: "A choropleth map of a count per small country, darker meaning a higher count.",
  source_note: "synthetic fixture", claim_id: "claim-tether",
  sql: "SELECT country, n, year FROM fixture", unit: "n", chart_type: "choropleth",
  category_field: "country", value_field: "n", category_names: "worldbank",
  reference_period_field: "year", mixed_period_strategy: "acknowledge",
  basemap_id: basemap.id, basemap_source_url: basemap.source_url, basemap_license: basemap.license,
  basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [], inset: { auto: true },
  measure_kind: "count",
};
// Central-Europe cluster: dense enough that the inset must displace markers.
const cluster = ["Albania", "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Hungary", "Moldova", "Montenegro", "North Macedonia", "Romania",
  "Serbia", "Slovak Republic", "Slovenia", "Czechia", "Poland", "Estonia", "Latvia", "Lithuania", "Lebanon", "Armenia", "Georgia",
  "Azerbaijan", "Comoros", "Maldives", "Sri Lanka", "Belarus", "Ukraine", "Turkiye"];
const rows = cluster.map((country, i) => ({ country, n: 1 + ((i * 7) % 12), year: 2017 }));
const qaOf = (r) => (bundle) => runRenderQa({ desktop: bundle.desktop, mobile: bundle.mobile }, { choropleth: { rows: r, category_field: "country", value_field: "n", category_names: "worldbank", unit: "n", measure_kind: "count" } });
const bundle = renderVizBundle(spec, rows);
const qa = qaOf(rows)(bundle);
const ruleHits = (q, rule) => Object.values(q.viewports).flatMap((v) => ["geometry", "value_labels"].flatMap((k) => v[k]?.failures ?? [])).filter((f) => f.rule === rule);

for (const viewport of ["desktop", "mobile"]) {
  const svg = bundle[viewport];
  const circles = [...svg.matchAll(/<circle data-role="(choropleth-(?:inset-)?footnote-marker)"[^>]*>/g)].map((m) => {
    const num = (k) => Number(m[0].match(new RegExp(`${k}="([\\d.]+)"`))?.[1]);
    return { role: m[1], number: m[0].match(/data-number="(\d+)"/)?.[1], x: num("cx"), y: num("cy"), ax: num("data-anchor-x"), ay: num("data-anchor-y") };
  });
  assert.ok(circles.length > 0, `${viewport}: fixture must produce numbered markers`);
  assert.ok(circles.every((c) => [c.x, c.y, c.ax, c.ay].every(Number.isFinite)), `${viewport}: every marker carries its anchor`);
  const displaced = circles.filter((c) => Math.hypot(c.x - c.ax, c.y - c.ay) > 9);
  const tethers = [...svg.matchAll(/<path data-role="choropleth-(?:inset-)?footnote-marker-leader"[^>]*data-number="(\d+)"[^>]*d="M([\d.]+),([\d.]+) L([\d.]+),([\d.]+)"/g)];
  assert.equal(tethers.length, displaced.length, `${viewport}: one tether per displaced marker (${displaced.length})`);
  if (viewport === "desktop") assert.ok(displaced.length > 0, "desktop fixture must displace at least one marker");
  for (const c of displaced) {
    const t = tethers.find((m) => m[1] === c.number);
    assert.ok(t, `${viewport}: displaced marker ${c.number} has a tether`);
    assert.ok(Math.hypot(+t[4] - c.ax, +t[5] - c.ay) <= 0.6, `${viewport}: tether ${c.number} ends at the true point`);
    assert.ok(Math.abs(Math.hypot(+t[2] - c.x, +t[3] - c.y) - 9) <= 1.5, `${viewport}: tether ${c.number} starts on the circle`);
  }
}
// A cluster dense enough to displace markers also leaves more than a quarter
// of them list-only, so it is a KNOWN RESIDUAL, not a clean sample: its only
// QA failure is the disclosed list-only rule (no tether crossing text, markers
// or leaders, no stray overlap), and nothing is filtered out.
{
  const fails = Object.values(qa.viewports).flatMap((v) => ["geometry", "value_labels", "contrast"].flatMap((k) => v[k]?.failures ?? []));
  assert.deepEqual([...new Set(fails.map((f) => f.rule))], ["markers_list_only_exceed_quarter"], `unexpected QA failures: ${JSON.stringify(fails.map((f) => f.message))}`);
}
assert.equal(ruleHits(qa, "marker_displaced_without_tether").length, 0);

// Must-fail: strip the tethers from the same render.
const stripped = {
  desktop: bundle.desktop.replace(/<path data-role="choropleth-(?:inset-)?footnote-marker-leader"[^>]*\/>/g, ""),
  mobile: bundle.mobile.replace(/<path data-role="choropleth-(?:inset-)?footnote-marker-leader"[^>]*\/>/g, ""),
};
assert.notEqual(stripped.desktop, bundle.desktop, "the desktop render had tethers to strip");
const bad = qaOf(rows)(stripped);
assert.equal(bad.passed, false);
assert.ok(ruleHits(bad, "marker_displaced_without_tether").length > 0, "QA must flag displaced markers without a tether");

// List-only markers are disclosed: counted in QA output, named in the chart
// note, and a chart that drops more than a quarter of its markers fails.
{
  const lo = (q, vp) => q.viewports[vp].value_labels.list_only_markers;
  const total = (svg) => [...svg.matchAll(/data-role="choropleth-(?:inset-)?footnote-marker"/g)].length;
  const report = {};
  for (const vp of ["desktop", "mobile"]) {
    const l = lo(qa, vp);
    assert.ok(l && Number.isFinite(l.count) && Number.isFinite(l.total), `${vp}: QA reports list_only_markers`);
    assert.equal(l.total - l.count, total(bundle[vp]), `${vp}: drawn markers + list-only = numbered regions`);
    if (l.count) assert.match(bundle[vp], /另有 \d+ 个地区|more region\(s\) are too crowded/, `${vp}: note names the list-only count`);
    report[vp] = `${l.count}/${l.total}`;
  }
  console.log("list-only markers (dropped/total):", JSON.stringify(report));
  // Must-fail: claim more than a quarter of the markers were dropped.
  const forged = { ...bundle, desktop: bundle.desktop.replace("</svg>", '<g data-role="choropleth-marker-list-only" data-count="9" data-total="10" data-iso3="AAA"/></svg>') };
  const q2 = qaOf(rows)(forged);
  assert.ok(ruleHits(q2, "markers_list_only_exceed_quarter").length > 0, "more than a quarter list-only must fail QA");
}
console.log("marker tether -- PASS");
