#!/usr/bin/env node
// Scientific map: declared line/polygon layers must be drawn (or blocked), and
// geo_flow layers with a signed measure must be explicit and direction-aware.
// Synthetic offline data only.
import assert from 'node:assert/strict';
import { compileScientificMap } from '../runtime/pi/scientific_map.mjs';
import { validateMapSpec } from '../runtime/pi/map_spec.mjs';
import { validateGeoFlowLayers, normalizeSignedRows } from '../runtime/pi/geo_flow_layers.mjs';
import { listBasemaps } from '../runtime/pi/basemap_registry.mjs';

const basemapId = (listBasemaps?.() ?? [])[0]?.id ?? 'naturalearth_admin0_110m';
const extents = [
  { west: 10, east: 30, south: 0, north: 20 },       // northern, eastern
  { west: -70, east: -50, south: -30, north: -10 },  // southern, western
  { west: -5, east: 5, south: -5, north: 5 },        // straddling both zero lines
];
const base = (extent, layers) => ({ schema_version: '0.2.0', projection: 'equirectangular', crs: 'EPSG:4326', task: 'regional', basemap_id: basemapId, extent, scale: { enabled: true, unit: 'km', length_km: 100 }, layers });
const pt = (e, fx, fy, label) => ({ lon: e.west + (e.east - e.west) * fx, lat: e.south + (e.north - e.south) * fy, ...(label ? { label } : {}) });

for (const e of extents) {
  // 2 points + 1 line + 1 polygon: all drawn, every name present in a trace
  const spec = base(e, [
    { id: 'p', type: 'observations', points: [pt(e, .2, .2, 'Alpha'), pt(e, .8, .3, 'Beta')] },
    { id: 'l', type: 'line', label: 'Corridor', points: [pt(e, .1, .5, 'Start'), pt(e, .5, .6), pt(e, .9, .7, 'End')] },
    { id: 'g', type: 'polygon', label: 'Zone', points: [pt(e, .3, .8), pt(e, .6, .8), pt(e, .45, .95)] },
  ]);
  assert.equal(validateMapSpec(spec).status, 'PASS', JSON.stringify(validateMapSpec(spec)));
  const fig = compileScientificMap(spec).figure.data;
  const names = fig.flatMap((t) => [].concat(t.text ?? []).map(String)).join('|');
  for (const n of ['Alpha', 'Beta', 'Start', 'End']) assert.ok(names.includes(n), `name ${n} must be drawn`);
  assert.equal(fig.length, 1 + 3, 'basemap + three layers');
  assert.equal(fig[2].mode.includes('lines'), true);
  assert.equal(fig[3].fill, 'toself');
}

// must-fail: line with one vertex, polygon with two, vertex outside extent, bad coords
const e0 = extents[0];
for (const [name, layer] of [
  ['short line', { id: 'l', type: 'line', points: [pt(e0, .5, .5)] }],
  ['short polygon', { id: 'g', type: 'polygon', points: [pt(e0, .1, .1), pt(e0, .2, .2)] }],
  ['outside extent', { id: 'l', type: 'line', points: [pt(e0, .5, .5), { lon: e0.east + 5, lat: e0.south + 1 }] }],
  ['non-numeric', { id: 'l', type: 'line', points: [pt(e0, .5, .5), { lon: 'x', lat: 1 }] }],
  ['no points', { id: 'l', type: 'line' }],
]) {
  const spec = base(e0, [layer]);
  assert.equal(validateMapSpec(spec).status, 'BLOCK', name);
  assert.throws(() => compileScientificMap(spec), /MAP_SPEC_BLOCKED/, name);
}

// --- geo_flow signed values ---------------------------------------------
const baseSpec = { chart_type: 'cartographic_flow_map', value_field: 'v', source_field: 's', target_field: 't', source_lat_field: 'slat', source_lon_field: 'slon', target_lat_field: 'tlat', target_lon_field: 'tlon' };
const mk = (rows, extra = {}) => ({ baseSpec, layers: [{ id: 'a', label: 'A', unit: 'units', measure_kind: 'flow', temporal_basis: 'period', source_url: 'https://example.test/x', source_note: 'n', rows, ...extra }] });
const rowShapes = {
  mixed: [{ s: 'P', t: 'Q', slat: 1, slon: 2, tlat: 3, tlon: 4, v: 5 }, { s: 'R', t: 'S', slat: 5, slon: 6, tlat: 7, tlon: 8, v: -2 }],
  allNegative: [{ s: 'P', t: 'Q', slat: -1, slon: -2, tlat: -3, tlon: -4, v: -7.5 }],
  withZero: [{ s: 'P', t: 'Q', slat: 0, slon: 0, tlat: 1, tlon: 1, v: 0 }, { s: 'Q', t: 'R', slat: 1, slon: 1, tlat: 2, tlon: 2, v: -1 }],
};
const blockersOf = (cfg) => validateGeoFlowLayers(cfg).blockers.filter((b) => /negative|signed/.test(b));
for (const [shape, rows] of Object.entries(rowShapes)) {
  const hasNeg = rows.some((r) => r.v < 0);
  // must-fail: negative without declaration (message names the fix); unknown mode; missing note
  if (hasNeg) {
    const b = blockersOf(mk(rows));
    assert.ok(b.some((x) => /signed_values='reverse_direction'/.test(x)), `${shape}: undeclared negatives blocked with guidance`);
  }
  assert.ok(blockersOf(mk(rows, { signed_values: 'abs' })).some((x) => /must be one of/.test(x)), `${shape}: unknown mode`);
  assert.ok(blockersOf(mk(rows, { signed_values: 'reverse_direction' })).some((x) => /signed_note/.test(x)), `${shape}: note required`);
  // must-pass: declared + noted -> no signed/negative blocker, and normalization is faithful
  const ok = mk(rows, { signed_values: 'reverse_direction', signed_note: 'Negative values run from the listed target to the listed source.' });
  assert.deepEqual(blockersOf(ok), [], shape);
  const norm = normalizeSignedRows(baseSpec, ok.layers[0]);
  norm.forEach((n, i) => {
    const o = rows[i];
    assert.ok(n.v >= 0);
    if (o.v < 0) { assert.equal(n.s, o.t); assert.equal(n.t, o.s); assert.equal(n.slat, o.tlat); assert.equal(n.tlon, o.slon); assert.equal(n.v, -o.v); assert.equal(n.v_signed, o.v); }
    else assert.deepEqual(n, o);
  });
}
// non-numeric still blocked even when signed mode is declared
assert.ok(validateGeoFlowLayers(mk([{ ...rowShapes.mixed[0], v: 'n/a' }], { signed_values: 'reverse_direction', signed_note: 'x' })).blockers.some((b) => /non-numeric/.test(b)));
console.log('scientific map layers + signed geo_flow: PASS');
