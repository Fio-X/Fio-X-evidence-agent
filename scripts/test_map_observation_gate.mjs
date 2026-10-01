#!/usr/bin/env node
// Observation layers follow the reference-layer rule: every point is read from
// a recorded, sha256-pinned file; a coordinate typed into the spec is blocked.
// Synthetic offline data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileScientificMap } from '../runtime/pi/scientific_map.mjs';
import { validateMapSpec as validatePi } from '../runtime/pi/map_spec.mjs';
import { validateMapSpec as validateVisual } from '../runtime/visual/map_spec.mjs';
import { compileScientificMap as compileWeb } from '../runtime/web/scientific_map.mjs';
import { resolveReferenceLayers } from '../runtime/pi/map_reference_layers.mjs';

const root = mkdtempSync(join(tmpdir(), 'obs-gate-'));
mkdirSync(join(root, 'data'), { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const io = { readBytes: async (p) => readFileSync(join(root, p)), readJson: async (p) => JSON.parse(readFileSync(join(root, p), 'utf8')) };
function putData(ext, text) {
  const bytes = Buffer.from(text); const h = sha(bytes); const rel = `data/${h}.${ext}`;
  writeFileSync(join(root, rel), bytes); writeFileSync(join(root, `${rel}.meta.json`), JSON.stringify({ sha256: h, file: rel }));
  return { path: rel, sha256: h };
}
const e0 = { west: 10, east: 30, south: 0.5, north: 20 };
const base = (layers) => ({ schema_version: '0.2.0', projection: 'equirectangular', crs: 'EPSG:4326', task: 'regional', basemap_id: 'naturalearth_admin0_110m', extent: e0, scale: { enabled: true, unit: 'km', length_km: 100 }, layers });
const obs = (source, extra = {}) => base([{ id: 'o', type: 'observations', ...extra, source }]);
const good = putData('csv', 'name,lon,lat,v\nA,15,5,2\nB,20,10,4\n');
const goodSrc = { ...good, format: 'csv', lon_field: 'lon', lat_field: 'lat', value_field: 'v', label_field: 'name' };

// --- passes: points come from the pinned file and reach the figure ----------
for (const validate of [validatePi, validateVisual]) assert.equal(validate(obs(goodSrc)).status, 'PASS');
{
  const spec = obs(goodSrc); const res = await resolveReferenceLayers(spec, io);
  assert.deepEqual(res.layers.o.points.map((p) => [p.lon, p.lat, p.value, p.label]), [[15, 5, 2, 'A'], [20, 10, 4, 'B']]);
  for (const compile of [compileScientificMap, compileWeb]) {
    const m = compile(spec, res); assert.ok(m.figure.data.some((t) => JSON.stringify(t.x) === '[15,20]' && JSON.stringify(t.y) === '[5,10]'), 'pinned points reach the figure');
    assert.throws(() => compile(spec, null), /MAP_LAYER_NOT_RESOLVED/);
  }
}

// --- must-fail: the gate ----------------------------------------------------
for (const validate of [validatePi, validateVisual]) {
  const inline = validate(base([{ id: 'o', type: 'observations', points: [{ lon: 15, lat: 5, value: 1 }] }]));
  assert.equal(inline.status, 'BLOCK'); assert.ok(inline.errors.some((x) => /inline coordinates are rejected/.test(x)));
  assert.equal(validate(base([{ id: 'o', type: 'observations', points: [{ lon: 15, lat: 5 }], source: goodSrc }])).status, 'BLOCK', 'inline points blocked even beside a source');
  assert.equal(validate(base([{ id: 'o', type: 'observations' }])).status, 'BLOCK', 'no source');
  for (const path of ['outputs/x.csv', '../data/x.csv', 'data/a/b.csv', `computations/short.json`]) assert.equal(validate(obs({ ...goodSrc, path })).status, 'BLOCK', path);
  assert.equal(validate(obs({ ...goodSrc, sha256: 'xyz' })).status, 'BLOCK');
  assert.equal(validate(obs({ ...goodSrc, lon_field: undefined })).status, 'BLOCK');
  assert.equal(validate(obs({ ...goodSrc, lat_field: undefined })).status, 'BLOCK');
}

// --- must-fail: the resolver ------------------------------------------------
await assert.rejects(resolveReferenceLayers(obs({ ...goodSrc, sha256: sha(Buffer.from('other')) }), io), /MAP_SOURCE_HASH_MISMATCH/);
{ const f = putData('csv', 'name,lon,lat,v\nA,15,5,2\n'); await assert.rejects(resolveReferenceLayers(obs({ ...f, format: 'csv', lon_field: 'longitude', lat_field: 'lat' }), io), /MAP_COORD_INVALID|MAP_VALUE_INVALID|coordinate|finite/i, 'missing lon field'); }
{ const f = putData('csv', 'name,lon,lat,v\nA,abc,5,2\n'); await assert.rejects(resolveReferenceLayers(obs({ ...f, format: 'csv', lon_field: 'lon', lat_field: 'lat' }), io), /./, 'non-finite lon'); }
{ const f = putData('csv', 'name,lon,lat,v\nA,15,,2\n'); await assert.rejects(resolveReferenceLayers(obs({ ...f, format: 'csv', lon_field: 'lon', lat_field: 'lat' }), io), /./, 'empty lat'); }
{ const f = putData('csv', 'name,lon,lat,v\nA,15,5,n/a\n'); await assert.rejects(resolveReferenceLayers(obs({ ...f, format: 'csv', lon_field: 'lon', lat_field: 'lat', value_field: 'v' }), io), /MAP_VALUE_INVALID/, 'named value column must be numeric'); }
{ const f = putData('csv', 'name,lon,lat,v\nA,15,5,2\nB,95,5,2\n'); await assert.rejects(resolveReferenceLayers(obs({ ...f, format: 'csv', lon_field: 'lon', lat_field: 'lat' }), io), /MAP_COORD_OUTSIDE_EXTENT/); }
{ const f = putData('csv', 'name,lon,lat,v\nA,0,0,2\n'); await assert.rejects(resolveReferenceLayers(obs({ ...f, format: 'csv', lon_field: 'lon', lat_field: 'lat' }), io), /./, '(0,0) null island rejected by coord()'); }
{ const bytes = Buffer.from('name,lon,lat\nA,15,5\n'); const h = sha(bytes); const rel = `data/${h}.csv`; writeFileSync(join(root, rel), bytes); // no provenance sidecar
  await assert.rejects(resolveReferenceLayers(obs({ path: rel, sha256: h, format: 'csv', lon_field: 'lon', lat_field: 'lat' }), io), /MAP_SOURCE_NOT_RECORDED/); }
console.log('map observation gate: PASS');
