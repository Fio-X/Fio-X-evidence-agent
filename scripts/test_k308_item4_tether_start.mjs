#!/usr/bin/env node
// K308 item 4: a displaced marker's own tether must not start inside its own
// number's text box. NEWSROOM_CHORO_TETHER_CLEAR=1 (exact, default off).
import assert from "node:assert/strict";
import { renderVizBundle } from "../runtime/pi/viz.mjs";
import { getBasemap } from "../runtime/pi/basemap_registry.mjs";
import { CHOROPLETH_BASEMAP_ID } from "../runtime/pi/choropleth.mjs";

import { neAttributesAsset, joinChoroplethRows } from "../runtime/pi/choropleth.mjs";
process.env.NEWSROOM_MAP_WORLD = "1";
const basemap = getBasemap(CHOROPLETH_BASEMAP_ID);
const spec = {
  schema_version: "0.9.0", reader_task: "spatial", title: "Inflation by economy", alt: "A world map of inflation by economy, darker meaning higher.",
  source_note: "Synthetic fixture", claim_id: "claim-world-fixture", sql: "SELECT iso3, v FROM fixture", unit: "%", chart_type: "choropleth",
  category_field: "iso3", value_field: "v", category_names: "iso3", basemap_id: basemap.id, basemap_source_url: basemap.source_url,
  basemap_license: basemap.license, basemap_content_hash: basemap.content_hash, highlight_values: [], annotations: [], map_extent: "world",
};
const seen = new Set();
const ISO = neAttributesAsset().features.filter((f) => f.iso3 && f.continent !== "Antarctica" && f.continent !== "Seven seas (open ocean)" && !seen.has(f.iso3) && seen.add(f.iso3)).map((f) => f.iso3);
const skew = (i) => Math.round((0.5 + (((i * 37) % 97) / 97) ** 4 * 60 + (i % 7 === 0 ? 3 : 0)) * 10) / 10;
const rows = ISO.map((iso3, i) => ({ iso3, v: skew(i) })).filter((r) => joinChoroplethRows([r], spec)[0]?.entry?.kind === "economy" && joinChoroplethRows([r], spec)[0].featureIndices.length);
const render = (v) => {
  if (v === undefined) delete process.env.NEWSROOM_CHORO_TETHER_CLEAR; else process.env.NEWSROOM_CHORO_TETHER_CLEAR = v;
  return renderVizBundle(spec, rows).desktop;
};
const off = render(undefined);
for (const v of ["0", "2", "true", " 1", "yes"]) assert.equal(render(v), off, `switch value ${JSON.stringify(v)} is byte-identical to off`);
const on = render("1");
assert.notEqual(on, off, "on changes tether starts");
const parse = (svg) => {
  const markers = new Map([...svg.matchAll(/<circle data-role="choropleth-(?:inset-)?footnote-marker"[^>]*data-number="(\d+)"[^>]*cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => [m[1], { x: +m[2], y: +m[3] }]));
  const tethers = [...svg.matchAll(/<path data-role="choropleth-(?:inset-)?footnote-marker-leader"[^>]*data-number="(\d+)"[^>]*d="M([\d.]+),([\d.]+) L([\d.]+),([\d.]+)"/g)].map((m) => ({ n: m[1], sx: +m[2], sy: +m[3], ex: +m[4], ey: +m[5] }));
  return { markers, tethers };
};
const inBox = (t, c) => t.sx > c.x - 7 && t.sx < c.x + 7 && t.sy > c.y - 5.6 && t.sy < c.y + 7;
const offInsideProbe = (p) => p.tethers.filter((t) => inBox(t, p.markers.get(t.n))).length;
const a = parse(off), b = parse(on);
{ // the geometry behind the fix, per direction (the real failure: MWI marker 27, 45 degrees)
  const box = (r, ang) => { const x = Math.cos(ang) * r, y = Math.sin(ang) * r; return x > -7 && x < 7 && y > -5.6 && y < 7; };
  assert.ok(box(9, Math.PI / 4), "off: a 45-degree tether starts inside its own number box");
  for (let k = 0; k < 360; k++) assert.ok(!box(10.4, (k / 180) * Math.PI), `on: radius 10.4 leaves the box at ${k} degrees`);
}
assert.ok(a.tethers.length > 0 && a.tethers.length === b.tethers.length, "same tethers, same count");
let offInside = 0;
for (const t of a.tethers) if (inBox(t, a.markers.get(t.n))) offInside++;
for (const t of b.tethers) {
  const c = b.markers.get(t.n);
  assert.ok(!inBox(t, c), `on: tether ${t.n} starts outside its own number box`);
  assert.ok(Math.abs(Math.hypot(t.sx - c.x, t.sy - c.y) - 9) <= 1.5, `on: tether ${t.n} start stays within the QA tolerance of the circle`);
  assert.ok(Math.hypot(t.ex - c.x, t.ey - c.y) > 0 && b.tethers.length, "tether still reaches its point");
}
console.log(`PASS k308 item4 tether start (off had ${offInside} tether start(s) inside the own number box)`);
