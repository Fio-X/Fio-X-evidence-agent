#!/usr/bin/env node
// 1012l step 1: the US state basemap asset, its attributes sidecar and its registry row agree with each other and with us-state-names.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getBasemap, selectBasemap, listBasemaps } from '../runtime/pi/cartography.mjs';
const A = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime/pi/assets');
const geoBytes = readFileSync(join(A, 'naturalearth-admin1-us-110m.geojson'));
const geo = JSON.parse(geoBytes);
const side = JSON.parse(readFileSync(join(A, 'naturalearth-admin1-us-110m-attributes.json'), 'utf8'));
const names = JSON.parse(readFileSync(join(A, 'us-state-names.json'), 'utf8')).states;
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks++; };
ok(geo.features.length === 51 && side.features.length === 51, '51 features in geometry and sidecar');
ok(side.vendored_geometry.content_hash === createHash('sha256').update(geoBytes).digest('hex'), 'sidecar hash matches geometry');
for (let i = 0; i < 51; i++) {
  const s = side.features[i], n = names[i];
  ok(s.index === i && s.usps === n.usps && s.fips === n.fips && s.name === n.en, `row ${i} ${n.usps} matches the names table`);
  const g = geo.features[i].geometry;
  ok(['Polygon', 'MultiPolygon'].includes(g.type) && g.coordinates.length > 0, `${n.usps} has geometry`);
}
const bm = getBasemap('naturalearth_admin1_us_110m');
ok(bm && bm.content_hash === side.vendored_geometry.content_hash, 'registry hash equals sidecar hash');
ok(bm.license.startsWith('Public domain') && bm.source_url.includes('admin-1-states-provinces'), 'license and source recorded');
const pts = geo.features.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).flat(2 - 1).flat());
ok(pts.every(([x, y]) => x >= bm.extent.west && x <= bm.extent.east && y >= bm.extent.south && y <= bm.extent.north), 'every point inside the registered extent');
const bboxOf = (u) => { const p = geo.features[side.features.findIndex((s) => s.usps === u)].geometry; const q = (p.type === 'Polygon' ? [p.coordinates] : p.coordinates).flat().flat(); return [Math.min(...q.map((a) => a[0])), Math.max(...q.map((a) => a[0])), Math.min(...q.map((a) => a[1])), Math.max(...q.map((a) => a[1]))]; };
const ak = bboxOf('AK'), hi = bboxOf('HI');
ok(ak[3] > 70 && ak[0] < -165, 'Alaska present with its far north and west');
ok(hi[2] < 20 && hi[3] > 22, 'Hawaii present');
for (const u of ['RI', 'DE', 'DC']) ok(geo.features[side.features.findIndex((s) => s.usps === u)].geometry.coordinates.length > 0, `${u} present`);
// registering the basemap must not change what selectBasemap picks without an id
for (const extent of [undefined, { west: -125, east: -66, south: 24, north: 50 }, { west: 0, east: 20, south: 0, north: 20 }]) ok(selectBasemap({ extent }).id !== 'naturalearth_admin1_us_110m', 'never auto-selected');
ok(listBasemaps().some((m) => m.id === 'naturalearth_admin1_us_110m'), 'listed');
console.log(`us state basemap PASS checks=${checks}`);
