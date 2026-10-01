// Resolves reference_points / reference_lines map layers from recorded data.
// A MapSpec only *names* a file (or a source-bound computation) and pins its
// sha256; every coordinate is read from those bytes here. Model-typed
// coordinates never reach the map: the spec validator rejects them, and this
// resolver refuses any file whose hash, content address or provenance sidecar
// does not check out.
import { createHash } from "node:crypto";
import { recordedInputState } from "./computation_rows.mjs";

export const MAX_STATUS_VALUES = 6;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseCsv(textValue) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const text = String(textValue ?? "").replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!clean.length) return [];
  const header = clean[0].map((h) => h.trim());
  return clean.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function coord(lon, lat, where) {
  const x = typeof lon === "number" ? lon : (String(lon ?? "").trim() === "" ? NaN : Number(lon));
  const y = typeof lat === "number" ? lat : (String(lat ?? "").trim() === "" ? NaN : Number(lat));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`MAP_COORD_INVALID: ${where} has a missing or non-numeric coordinate`);
  if (x < -180 || x > 180 || y < -90 || y > 90) throw new Error(`MAP_COORD_INVALID: ${where} is outside WGS84 bounds`);
  // (0,0) is the classic placeholder for "no coordinate"; a real site there
  // must be recorded with a non-degenerate coordinate pair.
  if (x === 0 && y === 0) throw new Error(`MAP_COORD_INVALID: ${where} is exactly (0,0), a null-coordinate placeholder`);
  return [x, y];
}

function geojsonFeatures(doc) {
  if (doc?.type === "FeatureCollection" && Array.isArray(doc.features)) return doc.features;
  if (doc?.type === "Feature") return [doc];
  throw new Error("MAP_SOURCE_INVALID: GeoJSON must be a Feature or FeatureCollection");
}

function nameOf(value, where) {
  const name = String(value ?? "").trim();
  if (!name) throw new Error(`MAP_NAME_MISSING: ${where} has no name; every point and line needs a visible name`);
  return name;
}

function featuresFromRows(layer, rows) {
  const src = layer.source;
  const points = layer.type === "reference_points";
  const get = (row, key) => (key ? row?.[key] : undefined);
  const out = [];
  if (points) {
    rows.forEach((row, i) => {
      const where = `${layer.id} row ${i + 1}`;
      out.push({ name: nameOf(get(row, src.name_field), where), status: statusOf(layer, row), coords: [coord(get(row, src.lon_field), get(row, src.lat_field), where)] });
    });
    return out;
  }
  const groups = new Map();
  rows.forEach((row, i) => {
    const where = `${layer.id} row ${i + 1}`;
    const key = String(get(row, src.group_field) ?? "").trim();
    if (!key) throw new Error(`MAP_SOURCE_INVALID: ${where} has no ${src.group_field}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ i, row, c: coord(get(row, src.lon_field), get(row, src.lat_field), where) });
  });
  for (const [key, items] of groups) {
    if (src.order_field) items.sort((a, b) => Number(get(a.row, src.order_field)) - Number(get(b.row, src.order_field)) || a.i - b.i);
    if (items.length < 2) throw new Error(`MAP_SOURCE_INVALID: line '${key}' has fewer than 2 vertices`);
    out.push({ name: nameOf(get(items[0].row, src.name_field), `line ${key}`), status: statusOf(layer, items[0].row), coords: items.map((x) => x.c) });
  }
  return out;
}

function statusOf(layer, row) {
  if (!layer.status_field) return null;
  const v = String(row?.[layer.status_field] ?? "").trim();
  if (!v) throw new Error(`MAP_STATUS_MISSING: ${layer.id} has a feature without a ${layer.status_field} value`);
  return v;
}

function featuresFromGeojson(layer, doc) {
  const src = layer.source;
  const points = layer.type === "reference_points";
  const out = [];
  geojsonFeatures(doc).forEach((f, i) => {
    const where = `${layer.id} feature ${i + 1}`;
    const g = f?.geometry ?? {};
    const props = f?.properties ?? {};
    const name = nameOf(props[src.name_field], where);
    const status = statusOf(layer, props);
    if (points) {
      const pts = g.type === "Point" ? [g.coordinates] : g.type === "MultiPoint" ? g.coordinates : null;
      if (!pts) throw new Error(`MAP_SOURCE_INVALID: ${where} is not a Point/MultiPoint`);
      for (const p of pts) out.push({ name, status, coords: [coord(p?.[0], p?.[1], where)] });
    } else {
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : null;
      if (!lines) throw new Error(`MAP_SOURCE_INVALID: ${where} is not a LineString/MultiLineString`);
      // a MultiLineString is one named feature drawn as several parts
      const parts = lines.map((line) => {
        if (!Array.isArray(line) || line.length < 2) throw new Error(`MAP_SOURCE_INVALID: ${where} has a line with fewer than 2 vertices`);
        return line.map((p) => coord(p?.[0], p?.[1], where));
      });
      out.push({ name, status, parts });
    }
  });
  return out;
}

function inExtent(c, e) { return c[0] >= e.west && c[0] <= e.east && c[1] >= e.south && c[1] <= e.north; }

/**
 * io = { readBytes(path)->Uint8Array, readJson(path)->object }, both rooted at
 * the artifact directory. Returns { layers: { [id]: {...} } } or throws.
 */
export async function resolveReferenceLayers(spec, io) {
  const resolution = { schema_version: "0.1.0", layers: {} };
  for (const layer of spec?.layers ?? []) {
    if (!["reference_points", "reference_lines", "line"].includes(layer?.type)) continue;
    const l = layer.type === "line" ? { ...layer, type: "reference_lines" } : layer;
    const src = l.source;
    const bytes = await io.readBytes(src.path);
    const actual = sha256(bytes);
    if (actual !== src.sha256) throw new Error(`MAP_SOURCE_HASH_MISMATCH: ${src.path} hashes to ${actual}, spec pins ${src.sha256}`);
    const inputs = [{ path: src.path, sha256: actual }];
    let features;
    if (src.path.startsWith("data/")) {
      // must be a recorded dataset: content-addressed name + provenance sidecar
      const base = src.path.split("/").pop();
      if (!(base === actual || base.startsWith(`${actual}.`))) throw new Error(`MAP_SOURCE_NOT_RECORDED: ${src.path} is not content-addressed by its sha256`);
      let meta = null;
      try { meta = await io.readJson(`${src.path}.meta.json`); } catch { meta = null; }
      if (!meta || meta.sha256 !== actual) throw new Error(`MAP_SOURCE_NOT_RECORDED: ${src.path} has no matching provenance metadata`);
      if (src.format === "geojson") features = featuresFromGeojson(l, JSON.parse(Buffer.from(bytes).toString("utf8")));
      else features = featuresFromRows(l, parseCsv(Buffer.from(bytes).toString("utf8")));
    } else {
      const record = JSON.parse(Buffer.from(bytes).toString("utf8"));
      const state = await recordedInputState(record, (ref) => io.readJson(ref));
      if (state.binding !== "source_bound") throw new Error(`MAP_SOURCE_NOT_BOUND: computation ${src.path} is ${state.binding}, not source_bound`);
      for (const input of record.read_inputs) {
        if (!String(input.path).startsWith("data/")) continue;
        const h = sha256(await io.readBytes(input.path));
        if (h !== input.sha256) throw new Error(`MAP_SOURCE_HASH_MISMATCH: computation input ${input.path} changed since the query ran`);
        inputs.push({ path: input.path, sha256: h });
      }
      if (!Array.isArray(record.rows)) throw new Error("MAP_SOURCE_INVALID: computation has no rows");
      features = featuresFromRows(l, record.rows);
    }
    if (!features.length) throw new Error(`MAP_SOURCE_INVALID: ${l.id} resolved to no features`);
    const statuses = [...new Set(features.map((f) => f.status).filter((v) => v !== null))].sort();
    if (statuses.length > MAX_STATUS_VALUES) throw new Error(`MAP_STATUS_TOO_MANY: ${l.id} has ${statuses.length} status values; at most ${MAX_STATUS_VALUES} can be told apart`);
    const e = spec.extent;
    for (const f of features) {
      const all = f.parts ? f.parts.flat() : f.coords;
      const inside = all.filter((c) => inExtent(c, e)).length;
      if (l.type === "reference_points" ? inside !== all.length : inside === 0) throw new Error(`MAP_COORD_OUTSIDE_EXTENT: ${l.id} '${f.name}' lies outside the map extent`);
    }
    const norm = features.map((f) => ({ name: f.name, status: f.status, parts: f.parts ?? (l.type === "reference_points" ? [f.coords] : [f.coords]) }));
    resolution.layers[l.id] = { kind: l.type === "reference_points" ? "points" : "lines", statuses, features: norm, inputs, content_sha256: sha256(JSON.stringify(norm)) };
  }
  return resolution;
}
