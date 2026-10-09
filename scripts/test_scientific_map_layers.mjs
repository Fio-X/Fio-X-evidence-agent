#!/usr/bin/env node
// Reference layers on the scientific map: coordinates come only from recorded
// data bound by sha256 (never from the spec), every feature has a visible
// name, and status styling yields a complete legend. Synthetic offline data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileScientificMap, qaReferenceNames, splitAntimeridian } from '../runtime/pi/scientific_map.mjs';
import { validateMapSpec } from '../runtime/pi/map_spec.mjs';
import { resolveReferenceLayers } from '../runtime/pi/map_reference_layers.mjs';

const root = mkdtempSync(join(tmpdir(), 'ref-layers-'));
mkdirSync(join(root, 'data'), { recursive: true });
mkdirSync(join(root, 'computations'), { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const io = { readBytes: async (p) => readFileSync(join(root, p)), readJson: async (p) => JSON.parse(readFileSync(join(root, p), 'utf8')) };
function putData(ext, text, { meta = true, nameOverride } = {}) {
  const bytes = Buffer.from(text); const h = sha(bytes); const rel = `data/${nameOverride ?? `${h}.${ext}`}`;
  writeFileSync(join(root, rel), bytes);
  if (meta) writeFileSync(join(root, `${rel}.meta.json`), JSON.stringify({ sha256: h, file: rel }));
  return { path: rel, sha256: h };
}
function putComputation(rows, readInputs, binding) {
  const text = JSON.stringify({ rows, read_inputs: readInputs, input_binding: binding });
  const h = sha(Buffer.from(text)); const rel = `computations/${sha(Buffer.from('k' + text))}.json`;
  writeFileSync(join(root, rel), text);
  return { path: rel, sha256: h };
}
const base = (extent, layers, task = 'regional') => ({ schema_version: '0.2.0', projection: 'equirectangular', crs: 'EPSG:4326', task, basemap_id: 'naturalearth_admin0_110m', extent, scale: { enabled: true, unit: 'km', length_km: 100 }, layers });
const at = (e, fx, fy) => [Number((e.west + (e.east - e.west) * fx).toFixed(4)), Number((e.south + (e.north - e.south) * fy).toFixed(4))];
const build = async (spec) => { assert.equal(validateMapSpec(spec).status, 'PASS', JSON.stringify(validateMapSpec(spec))); const res = await resolveReferenceLayers(spec, io); return { res, map: compileScientificMap(spec, res) }; };
const textsOf = (m) => m.figure.data.flatMap((t) => [].concat(t.text ?? []).map(String));
const legendOf = (m) => m.figure.data.filter((t) => t.showlegend && t.name !== 'Land context');

const extents = [{ west: 10, east: 30, south: 0.5, north: 20 }, { west: -70, east: -50, south: -30, north: -10 }, { west: -8, east: 8, south: -6, north: 6 }];
for (const [k, e] of extents.entries()) {
  // GeoJSON lines with three statuses (solid / dashed / dotted), one MultiLineString
  const gj = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { nm: 'Line A', st: 'built' }, geometry: { type: 'LineString', coordinates: [at(e, .1, .2), at(e, .5, .3), at(e, .9, .25)] } },
    { type: 'Feature', properties: { nm: 'Line B', st: 'planned' }, geometry: { type: 'MultiLineString', coordinates: [[at(e, .1, .6), at(e, .4, .65)], [at(e, .5, .7), at(e, .9, .8)]] } },
    { type: 'Feature', properties: { nm: 'Line C', st: 'proposed' }, geometry: { type: 'LineString', coordinates: [at(e, .2, .9), at(e, .8, .95)] } },
  ] };
  const f1 = putData('geojson', JSON.stringify(gj));
  const spec = base(e, [{ id: 'lines', type: 'reference_lines', label: 'Links', status_field: 'st', source: { ...f1, format: 'geojson', name_field: 'nm' } }]);
  const { map } = await build(spec);
  const leg = legendOf(map); assert.deepEqual(leg.map((t) => t.name).sort(), ['Links: built', 'Links: planned', 'Links: proposed'], `legend complete (${k})`);
  assert.equal(new Set(leg.map((t) => t.line.dash)).size, 3, 'three distinct dash styles');
  for (const n of ['Line A', 'Line B', 'Line C']) assert.ok(textsOf(map).includes(n), `name ${n}`);
  assert.equal(map.figure.layout.showlegend, true);
  assert.deepEqual(qaReferenceNames(map), []);

  // CSV points, two statuses (solid vs open marker), mixed with the legacy observation layer untouched
  const csv = `site,lon,lat,state\n"Site, One",${at(e, .2, .3)[0]},${at(e, .2, .3)[1]},signed\nSite Two,${at(e, .7, .4)[0]},${at(e, .7, .4)[1]},pending\nSite Three,${at(e, .5, .8)[0]},${at(e, .5, .8)[1]},signed\n`;
  const f2 = putData('csv', csv);
  const spec2 = base(e, [{ id: 'sites', type: 'reference_points', label: 'Sites', status_field: 'state', source: { ...f2, format: 'csv', name_field: 'site', lon_field: 'lon', lat_field: 'lat' } }]);
  const r2 = await build(spec2);
  const pl = legendOf(r2.map); assert.deepEqual(pl.map((t) => t.name).sort(), ['Sites: pending', 'Sites: signed']);
  assert.equal(new Set(pl.map((t) => t.marker.symbol)).size, 2); assert.ok(pl.some((t) => t.marker.symbol.endsWith('-open')) && pl.some((t) => !t.marker.symbol.endsWith('-open')));
  assert.ok(textsOf(r2.map).includes('Site, One'));

  // No status field: one trace, no legend; names still drawn
  const spec3 = base(e, [{ id: 'sites', type: 'reference_points', label: 'Sites', source: { ...f2, format: 'csv', name_field: 'site', lon_field: 'lon', lat_field: 'lat' } }]);
  const r3 = await build(spec3); assert.equal(legendOf(r3.map).length, 0); assert.equal(r3.map.figure.layout.showlegend, false);
}

// CSV vertex rows -> lines (shuffled order), over the direct-label limit -> numbered list
{
  const e = extents[0]; const rows = ['line,seq,lon,lat,label'];
  for (let i = 0; i < 15; i++) { const y = 1 + i * 1.2; const a = at(e, .1, y / 20), b = at(e, .9, y / 20); rows.push(`L${i},2,${b[0]},${b[1]},Route ${i}`, `L${i},1,${a[0]},${a[1]},Route ${i}`); }
  const f = putData('csv', rows.join('\n') + '\n');
  const { map, res } = await build(base(e, [{ id: 'r', type: 'reference_lines', source: { ...f, format: 'csv', name_field: 'label', lon_field: 'lon', lat_field: 'lat', group_field: 'line', order_field: 'seq' } }]));
  assert.equal(res.layers.r.features.length, 15); assert.ok(res.layers.r.features.every((x) => x.parts[0][0][0] < x.parts[0][1][0]), 'vertices ordered by seq');
  assert.equal(map.name_list.length, 15); assert.ok(map.reference_features.every((x) => x.visible_as === 'list'));
  assert.ok(map.figure.layout.annotations.some((a) => String(a.text).includes('15. Route 14')));
  assert.deepEqual(qaReferenceNames(map), []);
}

// Computation rows (source bound to a recorded dataset) feed a CJK-named layer
{
  const e = extents[1]; const f = putData('csv', 'x\n1\n');
  const rows = [{ name: '站点甲', lon: at(e, .3, .3)[0], lat: at(e, .3, .3)[1] }, { name: '站点乙', lon: at(e, .6, .6)[0], lat: at(e, .6, .6)[1] }];
  const c = putComputation(rows, [{ path: f.path, sha256: f.sha256 }], 'source_bound');
  const { map } = await build(base(e, [{ id: 'p', type: 'reference_points', source: { ...c, format: 'rows', name_field: 'name', lon_field: 'lon', lat_field: 'lat' } }]));
  assert.ok(textsOf(map).includes('站点甲') && textsOf(map).includes('站点乙'));
  // must-fail: literal-only / unbound computation, and an input that changed after the query
  const lit = putComputation(rows, [], 'literal_only');
  await assert.rejects(resolveReferenceLayers(base(e, [{ id: 'p', type: 'reference_points', source: { ...lit, format: 'rows', name_field: 'name', lon_field: 'lon', lat_field: 'lat' } }]), io), /MAP_SOURCE_NOT_BOUND/);
  const stale = putComputation(rows, [{ path: f.path, sha256: '0'.repeat(64) }], 'source_bound');
  await assert.rejects(resolveReferenceLayers(base(e, [{ id: 'p', type: 'reference_points', source: { ...stale, format: 'rows', name_field: 'name', lon_field: 'lon', lat_field: 'lat' } }]), io), /MAP_SOURCE_HASH_MISMATCH/);
}

// Antimeridian: a line crossing +/-180 becomes separate segments, never one segment across the map
{
  const e = { west: -180, east: 180, south: -40, north: 40 };
  const gj = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { nm: 'Eastward' }, geometry: { type: 'LineString', coordinates: [[170, -10], [178, -12], [-176, -14], [-170, -15]] } },
    { type: 'Feature', properties: { nm: 'Westward' }, geometry: { type: 'LineString', coordinates: [[-172, 20], [-179, 22], [175, 24], [168, 25]] } } ] };
  const f = putData('geojson', JSON.stringify(gj));
  const { map } = await build(base(e, [{ id: 'x', type: 'reference_lines', source: { ...f, format: 'geojson', name_field: 'nm' } }], 'world'));
  const tr = map.figure.data.find((t) => t.name === 'x'); const segs = []; let cur = [];
  for (let i = 0; i < tr.x.length; i++) { if (tr.x[i] === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(tr.x[i]); }
  assert.equal(segs.length, 4, 'each crossing line is split in two');
  for (const s of segs) for (let i = 1; i < s.length; i++) assert.ok(Math.abs(s[i] - s[i - 1]) <= 180, 'no segment spans the map');
  assert.ok(segs.some((s) => s.includes(180)) && segs.some((s) => s.includes(-180)));
  assert.equal(splitAntimeridian([[10, 0], [20, 5]]).length, 1, 'non-crossing line is not split');
}

// --- must-fail: spec lint ---------------------------------------------------
const e0 = extents[0]; const good = putData('csv', `n,lon,lat\nA,${at(e0, .5, .5)[0]},${at(e0, .5, .5)[1]}\n`);
const src = { ...good, format: 'csv', name_field: 'n', lon_field: 'lon', lat_field: 'lat' };
for (const [name, layer, re] of [
  ['inline points', { id: 'p', type: 'reference_points', source: src, points: [{ lon: 12, lat: 3, label: 'X' }] }, /inline coordinates are rejected/],
  ['inline coordinates on a line', { id: 'l', type: 'line', coordinates: [[1, 2], [3, 4]], source: src }, /inline coordinates are rejected/],
  ['inline features', { id: 'l', type: 'reference_lines', features: [], source: src }, /inline coordinates are rejected/],
  ['no source', { id: 'p', type: 'reference_points' }, /source required/],
  ['bad hash', { id: 'p', type: 'reference_points', source: { ...src, sha256: 'abc' } }, /sha256 must be/],
  ['path outside data', { id: 'p', type: 'reference_points', source: { ...src, path: '../etc/x.csv' } }, /source.path must be/],
  ['no name field', { id: 'p', type: 'reference_points', source: { ...src, name_field: '' } }, /name_field required/],
  ['polygon', { id: 'g', type: 'polygon', source: src }, /polygon is not rendered/],
]) {
  const spec = base(e0, [layer]); const g = validateMapSpec(spec);
  assert.equal(g.status, 'BLOCK', name); assert.ok(g.errors.some((x) => re.test(x)), `${name}: ${g.errors}`);
  assert.throws(() => compileScientificMap(spec), /MAP_SPEC_BLOCKED/, name);
}
// a declared layer without a resolution never vanishes silently
assert.throws(() => compileScientificMap(base(e0, [{ id: 'p', type: 'reference_points', source: src }])), /MAP_LAYER_NOT_RENDERED/);

// --- must-fail: resolver ----------------------------------------------------
const bad = async (csv, extra = {}, opts = {}) => { const f = putData('csv', csv, opts); return resolveReferenceLayers(base(e0, [{ id: 'p', type: 'reference_points', ...extra, source: { ...f, format: 'csv', name_field: 'n', lon_field: 'lon', lat_field: 'lat', ...(extra.src ?? {}) } }]), io); };
const ok = at(e0, .5, .5);
await assert.rejects(bad(`n,lon,lat\nZero,0,0\n`), /\(0,0\)/);
await assert.rejects(bad(`n,lon,lat\nNan,NaN,5\n`), /MAP_COORD_INVALID/);
await assert.rejects(bad(`n,lon,lat\nEmpty,,5\n`), /MAP_COORD_INVALID/);
await assert.rejects(bad(`n,lon,lat\nFar,200,5\n`), /outside WGS84/);
await assert.rejects(bad(`n,lon,lat\n,${ok[0]},${ok[1]}\n`), /MAP_NAME_MISSING/);
await assert.rejects(bad(`n,lon,lat\nOut,${e0.east + 3},${ok[1]}\n`), /MAP_COORD_OUTSIDE_EXTENT/);
await assert.rejects(bad(`n,lon,lat\nNoMeta,${ok[0]},${ok[1]}\n`, {}, { meta: false }), /MAP_SOURCE_NOT_RECORDED/);
await assert.rejects(bad(`n,lon,lat,s\nA,${ok[0]},${ok[1]},\n`, { status_field: 's' }), /MAP_STATUS_MISSING/);
await assert.rejects(bad(`n,lon,lat,s\n` + Array.from({ length: 7 }, (_, i) => `A${i},${ok[0]},${ok[1]},s${i}`).join('\n') + '\n', { status_field: 's' }), /MAP_STATUS_TOO_MANY/);
{ const f = putData('csv', `n,lon,lat\nA,${ok[0]},${ok[1]}\n`); await assert.rejects(resolveReferenceLayers(base(e0, [{ id: 'p', type: 'reference_points', source: { ...f, sha256: sha(Buffer.from('other')), format: 'csv', name_field: 'n', lon_field: 'lon', lat_field: 'lat' } }]), io), /MAP_SOURCE_HASH_MISMATCH/); }
{ const f = putData('csv', `n,lon,lat\nA,${ok[0]},${ok[1]}\n`, { nameOverride: 'plain-name.csv' }); await assert.rejects(resolveReferenceLayers(base(e0, [{ id: 'p', type: 'reference_points', source: { ...f, format: 'csv', name_field: 'n', lon_field: 'lon', lat_field: 'lat' } }]), io), /MAP_SOURCE_NOT_RECORDED/); }

// --- must-fail: QA on the compiled figure -----------------------------------
{
  const { map } = await build(base(e0, [{ id: 'p', type: 'reference_points', source: src }]));
  assert.deepEqual(qaReferenceNames(map), []);
  const broken = structuredClone(map); for (const t of broken.figure.data) if (t.text) t.text = t.text.map(() => '');
  assert.deepEqual(qaReferenceNames(broken).map((x) => x.rule), ['reference_name_not_visible']);
}
console.log('reference map layers: PASS');
