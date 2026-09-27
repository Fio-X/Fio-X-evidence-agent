import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFINITIONS = [
  {
    id: 'naturalearth_admin0_110m',
    file: 'naturalearth-admin0-110m.geojson',
    source_url: 'https://www.naturalearthdata.com/downloads/110m-cultural-vectors/110m-admin-0-countries/',
    license: 'Public domain (Natural Earth terms of use)',
    resolution: '110m',
    nominal_scale: 110_000_000,
    detail_class: 'global',
    valid_tasks: ['world', 'continental', 'regional', 'global_context', 'regional_route'],
    extent: { west: -180, east: 180, south: -90, north: 90 },
    label: 'Natural Earth Admin 0, 1:110m',
  },
  {
    id: 'gshhg_syros_i_local',
    file: 'gshhs-i-syros-local.geojson',
    source_url: 'https://www.soest.hawaii.edu/pwessel/gshhg/',
    license: 'LGPL-3.0-or-later (GSHHG 2.3.6 via basemap-data 2.0.0)',
    resolution: 'intermediate',
    nominal_scale: 1_000_000,
    detail_class: 'local',
    valid_tasks: ['local', 'trajectory', 'local_context'],
    extent: { west: 24.82, east: 25.02, south: 37.34, north: 37.53 },
    label: 'GSHHG intermediate coastline, Syros local extract',
  },
];

const REGISTRY = new Map();
for (const definition of DEFINITIONS) {
  const path = join(HERE, 'assets', definition.file);
  const bytes = readFileSync(path);
  REGISTRY.set(definition.id, Object.freeze({
    ...definition,
    path,
    content_hash: createHash('sha256').update(bytes).digest('hex'),
    data: JSON.parse(bytes.toString('utf8')),
  }));
}

export const DEFAULT_BASEMAP_ID = 'naturalearth_admin0_110m';

export function listBasemaps() {
  return [...REGISTRY.values()].map(({ data, path, ...meta }) => ({ ...meta }));
}

export function getBasemap(id = DEFAULT_BASEMAP_ID) {
  return REGISTRY.get(id) ?? null;
}

export function requireBasemap(id = DEFAULT_BASEMAP_ID) {
  const entry = getBasemap(id);
  if (!entry) throw new Error(`Unknown basemap_id '${id}'`);
  return entry;
}

export function basemapCoversExtent(entryOrId, extent, tolerance = 1e-9) {
  const entry = typeof entryOrId === 'string' ? getBasemap(entryOrId) : entryOrId;
  if (!entry || !extent) return false;
  const e = entry.extent;
  return extent.west >= e.west - tolerance && extent.east <= e.east + tolerance && extent.south >= e.south - tolerance && extent.north <= e.north + tolerance;
}

export function inferCartographicTask(extent) {
  if (!extent) return 'world';
  const span = Math.max(Math.abs(extent.east - extent.west), Math.abs(extent.north - extent.south));
  if (span < 0.35) return 'harbour';
  if (span < 2) return 'local';
  if (span < 35) return 'regional';
  if (span < 120) return 'continental';
  return 'world';
}

export function basemapAdequacy(entryOrId, extent, taskOverride=null) {
  const entry = typeof entryOrId === 'string' ? getBasemap(entryOrId) : entryOrId;
  if (!entry) return { adequate: false, reason: 'unknown_basemap', task: inferCartographicTask(extent) };
  const task = taskOverride ?? inferCartographicTask(extent);
  if (!basemapCoversExtent(entry, extent)) return { adequate: false, reason: 'extent_not_covered', task, basemap: entry.id };
  const adequate = entry.valid_tasks.includes(task) || (task === 'trajectory' && entry.valid_tasks.includes('local'));
  return { adequate, reason: adequate ? 'ok' : 'detail_class_mismatch', task, basemap: entry.id };
}

export function selectBasemap({ extent, preferred_id, task } = {}) {
  if (preferred_id) {
    const preferred = getBasemap(preferred_id);
    if (!preferred) throw new Error(`Unknown basemap_id '${preferred_id}'`);
    return preferred;
  }
  const inferred = task ?? inferCartographicTask(extent);
  const candidates = [...REGISTRY.values()].filter((entry) => entry.valid_tasks.includes(inferred) && (!extent || basemapCoversExtent(entry, extent)));
  return candidates.sort((a, b) => a.nominal_scale - b.nominal_scale)[0] ?? requireBasemap();
}
