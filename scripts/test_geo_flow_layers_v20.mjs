#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getBasemap,
} from '../runtime/pi/cartography.mjs';
import { critiqueViz, hashRows, lintVizSpec } from '../runtime/pi/viz.mjs';
import { renderGeoFlowCompositeHtml, renderGeoFlowLayers, validateGeoFlowLayers } from '../runtime/pi/geo_flow_layers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.env.GEO_FLOW_OUT ?? '/private/tmp/fio-x-map-flow-20260917';
const CLAIM = 'claim-geo-flow-v20';
const DETAIL_BASEMAP = getBasemap('naturalearth_admin0_50m');
assert.ok(DETAIL_BASEMAP, 'the pinned 1:50m basemap must be registered');

function parseCsv(input) {
  const lines = input.trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  return lines.map((line) => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((key, index) => {
      const value = values[index] ?? '';
      return [key, /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value];
    }));
  });
}

function haversineKm(aLon, aLat, bLon, bLat) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const sa = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
}

function sourceFields(rows) {
  return rows.map((row) => ({
    ...row,
    source: row.source ?? row.country,
    flow_id: `${row.source ?? row.country}->${row.target}`,
    flow_layer: row.flow_layer ?? 'energy',
    flow_unit: row.flow_unit ?? 'thousand b/d',
    flow_period: row.flow_period ?? '2024',
    value: row.value ?? row.thousand_bpd,
  }));
}

const crude = parseCsv(await readFile(join(ROOT, 'fixtures/v09-realdata/eia-us-crude-imports-2024.csv'), 'utf8'));
const distance = parseCsv(await readFile(join(ROOT, 'fixtures/benchmarks/v2/data/eia-crude-distance-vs-volume.csv'), 'utf8'));
const remittance = parseCsv(await readFile(join(ROOT, 'fixtures/v15-cartographic-flow/world-bank-remittance-corridors-2021.csv'), 'utf8'));
const remittanceSource = JSON.parse(await readFile(join(ROOT, 'fixtures/v15-cartographic-flow/world-bank-remittance-corridors-2021.source.json'), 'utf8'));

const energyRows = sourceFields(crude.map((row) => ({
  ...row,
  value: row.thousand_bpd,
  flow_layer: 'Energy',
  flow_unit: 'thousand b/d',
  flow_period: '2024 average',
})));
const distanceByCountry = new Map(distance.map((row) => [String(row.country), row]));
const logisticsRows = sourceFields(crude.map((row) => {
  const km = Number(distanceByCountry.get(String(row.country))?.distance_km);
  return {
    ...row,
    value: Number((Number(row.thousand_bpd) * km).toFixed(1)),
    flow_layer: 'Logistics exposure',
    flow_unit: 'thousand bbl·km/day',
    flow_period: '2024 derived proxy',
  };
}));
const capitalRows = sourceFields(remittance.map((row) => ({
  source: row.source,
  source_lat: row.source_lat,
  source_lon: row.source_lon,
  target: row.target,
  target_lat: row.target_lat,
  target_lon: row.target_lon,
  value: row.usd_billion,
  flow_id: `${row.source}->${row.target}`,
  flow_layer: 'Capital',
  flow_unit: 'USD bn',
  flow_period: '2021 estimate',
})));

const baseSpec = {
  schema_version: '1.1.0',
  reader_task: 'flow',
  visual_family: 'spatial',
  data_topology: 'geo_edges',
  chart_type: 'cartographic_flow_map',
  title: 'Three kinds of flow share a geography',
  subtitle: 'Select a layer; width is comparable only within that layer',
  alt: 'An interactive map and linked Sankey compare energy relationships, a distance-weighted logistics exposure proxy, and estimated capital corridors. Each layer uses a separate unit and width scale; arcs are abstract origin-destination relationships.',
  source_note: 'Layer sources are listed with each panel.',
  note: 'Country anchors are representative. Abstract arcs encode relationships and do not trace physical tanker, pipeline, vessel, road, rail, or money-transfer routes.',
  claim_id: CLAIM,
  sql: 'SELECT * FROM geo_flow_layers',
  unit: 'per-layer scale',
  source_field: 'source',
  target_field: 'target',
  source_lat_field: 'source_lat',
  source_lon_field: 'source_lon',
  target_lat_field: 'target_lat',
  target_lon_field: 'target_lon',
  value_field: 'value',
  flow_id_field: 'flow_id',
  geometry_semantics: 'abstract_od',
  geometry_crs: 'EPSG:4326',
  projection: 'natural_earth_1',
  basemap_id: DETAIL_BASEMAP.id,
  basemap_source_url: DETAIL_BASEMAP.source_url,
  basemap_license: DETAIL_BASEMAP.license,
  basemap_content_hash: DETAIL_BASEMAP.content_hash,
  aggregation_policy: 'none',
  direct_labels: true,
};

const layers = [
  {
    id: 'energy',
    label: 'Energy',
    title: 'Canada anchors the selected crude-import relationships',
    subtitle: 'EIA 2024 average · thousand barrels per day',
    unit: 'thousand b/d',
    measure_kind: 'flow',
    temporal_basis: '2024 annual average',
    rows: energyRows,
    source_field: 'source', target_field: 'target', value_field: 'value',
    source_lat_field: 'source_lat', source_lon_field: 'source_lon', target_lat_field: 'target_lat', target_lon_field: 'target_lon',
    source_url: 'https://www.eia.gov/petroleum/imports/',
    source_accessed: '2026-09-17',
    source_note: 'U.S. Energy Information Administration, crude-oil import relationships, 2024 fixture',
    note: 'Widths show the selected import relationship measure. Country anchors are representative, so these curves do not claim tanker or pipeline geometry.',
    geometry_semantics: 'abstract_od',
    geometry_note: 'Representative country anchors; relationship arcs only.',
  },
  {
    id: 'logistics',
    label: 'Logistics exposure',
    title: 'Longer origins carry more distance-weighted exposure',
    subtitle: 'Derived from EIA volume × great-circle distance · thousand bbl·km/day',
    unit: 'thousand bbl·km/day',
    measure_kind: 'index',
    temporal_basis: '2024 derived proxy',
    rows: logisticsRows,
    source_field: 'source', target_field: 'target', value_field: 'value',
    source_lat_field: 'source_lat', source_lon_field: 'source_lon', target_lat_field: 'target_lat', target_lon_field: 'target_lon',
    source_url: 'https://www.eia.gov/petroleum/imports/',
    source_accessed: '2026-09-17',
    source_note: 'Derived reproducibly from the EIA 2024 import fixture and its frozen great-circle distance table',
    note: 'This is a logistics exposure proxy, not observed cargo movement. Values equal imported volume multiplied by great-circle distance; arcs remain abstract relationships.',
    geometry_semantics: 'great_circle_reference',
    geometry_note: 'Geodesic reference line for a derived distance-weighted proxy; not a filed route.',
  },
  {
    id: 'capital',
    label: 'Capital',
    title: 'Estimated remittance corridors concentrate on India',
    subtitle: 'World Bank 2021 bilateral estimates · USD billions',
    unit: 'USD bn',
    measure_kind: 'flow',
    temporal_basis: '2021 estimate',
    rows: capitalRows,
    source_field: 'source', target_field: 'target', value_field: 'value',
    source_lat_field: 'source_lat', source_lon_field: 'source_lon', target_lat_field: 'target_lat', target_lon_field: 'target_lon',
    source_url: remittanceSource.url,
    source_accessed: '2026-09-17',
    source_note: 'World Bank, Bilateral Remittance Matrix (new), published 2022; 2021 corridor estimates',
    note: 'These are estimates allocated from migrant-stock and income assumptions. Country-capital anchors do not represent financial infrastructure or transaction paths.',
    geometry_semantics: 'abstract_od',
    geometry_note: 'Country-capital representative anchors; estimated bilateral relationship arcs only.',
  },
];

const validation = validateGeoFlowLayers({ baseSpec, layers, layer_order: ['energy', 'logistics', 'capital'] });
assert.equal(validation.passed, true, validation.blockers.join(' | '));
assert.equal(validation.scale_policy, 'within_layer_only');

// The single-spec lint also protects callers that pass all rows through the
// newsroom tool instead of using the composite helper.
const combinedRows = [...energyRows, ...logisticsRows, ...capitalRows];
const layeredLint = lintVizSpec({
  ...baseSpec,
  flow_layer_field: 'flow_layer',
  flow_unit_field: 'flow_unit',
  flow_period_field: 'flow_period',
  flow_layer_order: ['Energy', 'Logistics exposure', 'Capital'],
}, combinedRows, { verified_claim_ids: [CLAIM] });
assert.equal(layeredLint.passed, true, layeredLint.blockers.join(' | '));
assert.ok(layeredLint.notes.some((note) => note.includes('independent layers')));

const badUnits = validateGeoFlowLayers({
  baseSpec,
  layers: [{ ...layers[0], rows: layers[0].rows.map((row, index) => index === 0 ? { ...row, value: row.value } : row), unit: 'thousand b/d' }, { ...layers[1], unit: 'thousand b/d', measure_kind: 'index' }],
});
assert.equal(badUnits.passed, true, badUnits.blockers.join(' | '));
assert.ok(badUnits.warnings.some((warning) => warning.includes('share a unit')));

const rendered = renderGeoFlowLayers({ baseSpec, layers, layer_order: ['energy', 'logistics', 'capital'] });
for (const layer of rendered.layers) {
  assert.ok(layer.bundle.desktop.includes('data-role="cartographic-basemap"'), `${layer.id} missing basemap`);
  assert.ok(layer.bundle.desktop.includes('data-role="cartographic-hit"'), `${layer.id} missing wide route hit target`);
  assert.ok(layer.bundle.desktop.includes(`data-flow-key="${String(layer.rows[0].flow_id).replace(/>/g, '&gt;')}`), `${layer.id} missing stable route key`);
  const lint = lintVizSpec(layer.spec, layer.rows, { verified_claim_ids: [CLAIM] });
  assert.equal(lint.passed, true, `${layer.id} lint: ${lint.blockers.join(' | ')}`);
  const critic = critiqueViz(layer.spec, layer.rows, lint, layer.bundle.desktop);
  assert.equal(critic.passed, true, `${layer.id} critic: ${JSON.stringify(critic)}`);
}

for (const layer of rendered.layers) {
  const sankeyRows = layer.rows.map((row) => ({ source: row.source, target: row.target, value: row.value, flow_id: row.flow_id }));
  const sankeySpec = {
    schema_version: '0.9.0', reader_task: 'flow', visual_family: 'flow', data_topology: 'flow_edges', chart_type: 'sankey',
    title: `${layer.label} · two-end aggregate`, subtitle: layer.subtitle, alt: `Sankey of ${layer.label} source-to-destination relationships.`,
    source_note: layer.source_note, note: layer.note, claim_id: CLAIM, sql: 'SELECT source,target,value FROM geo_flow_layers', unit: layer.unit,
    source_field: 'source', target_field: 'target', value_field: 'value', flow_id_field: 'flow_id', flow_conservation: 'off', direct_labels: true,
  };
  const bundle = (await import('../runtime/pi/viz.mjs')).renderVizBundle(sankeySpec, sankeyRows);
  layer.sankeySvg = bundle.desktop;
  layer.sankeyMobileSvg = bundle.mobile;
}

const html = renderGeoFlowCompositeHtml({
  title: 'Three ledgers, one geography',
  dek: 'A map locates relationships. A Sankey makes the two-end topology explicit. The layers below keep quantities honest when the units change.',
  readerQuestion: 'How do energy supply, logistics exposure and capital relationships connect the same world map?',
  sourceNote: 'Prototype generated by Fio-X v20 layered cartographic flow contract. Data are frozen fixtures for reproducibility; this is a visual evaluation artifact, not a qualification or release claim.',
  layers: rendered.layers,
  activeLayer: 'energy',
});

const sourceFiles = [
  'fixtures/v09-realdata/eia-us-crude-imports-2024.csv',
  'fixtures/benchmarks/v2/data/eia-crude-distance-vs-volume.csv',
  'fixtures/v15-cartographic-flow/world-bank-remittance-corridors-2021.csv',
  'fixtures/v15-cartographic-flow/world-bank-remittance-corridors-2021.source.json',
];
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (relative) => {
  const bytes = await readFile(join(ROOT, relative));
  return [relative, createHash('sha256').update(bytes).digest('hex')];
})));
const metadata = {
  schema_version: '0.1.0',
  artifact_status: 'VISUAL_EVALUATION_READY',
  generated_at: '2026-09-17',
  title: 'Three ledgers, one geography',
  validation,
  layered_lint: { passed: layeredLint.passed, data_hash: layeredLint.data_hash, notes: layeredLint.notes },
  layers: rendered.layers.map((layer) => ({
    id: layer.id, label: layer.label, unit: layer.unit, measure_kind: layer.measure_kind, temporal_basis: layer.temporal_basis,
    row_count: layer.rows.length, data_hash: hashRows(layer.rows), source_url: layer.source_url, source_accessed: layer.source_accessed,
    geometry_semantics: layer.geometry_semantics,
  })),
  source_file_sha256: hashes,
  interaction_contract: ['layer tabs', 'route hover/focus', 'click-to-pin', 'Escape releases pin', 'reduced motion respected', 'wide transparent route hit targets'],
  scale_policy: 'widths reset within each layer; units are not cross-layer comparable',
  basemap: {
    id: DETAIL_BASEMAP.id,
    resolution: DETAIL_BASEMAP.resolution,
    content_hash: DETAIL_BASEMAP.content_hash,
    source_url: DETAIL_BASEMAP.source_url,
    license: DETAIL_BASEMAP.license,
  },
};
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'index.html'), html, 'utf8');
await writeFile(join(OUT, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
await writeFile(join(OUT, 'energy-map.svg'), rendered.layers[0].bundle.desktop, 'utf8');
await writeFile(join(OUT, 'logistics-map.svg'), rendered.layers[1].bundle.desktop, 'utf8');
await writeFile(join(OUT, 'capital-map.svg'), rendered.layers[2].bundle.desktop, 'utf8');
console.log(JSON.stringify({ status: 'PASS', out: OUT, layers: metadata.layers.map(({ id, unit, row_count }) => ({ id, unit, row_count })), html_bytes: Buffer.byteLength(html) }));
