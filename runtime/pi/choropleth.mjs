// Pure geometry/join/lint helpers for chart_type='choropleth': the Natural
// Earth attribute sidecar (name/continent/label point per basemap feature,
// keyed positionally onto the registered, geometry-only
// naturalearth_admin0_50m basemap - see basemap_registry.mjs and
// scripts/build_ne_attributes.mjs), the row-to-feature join via
// runtime/pi/economy_names.mjs's own vendored table (never a model-chosen
// key), a from-scratch Lambert azimuthal equal-area projection (forward and
// inverse; the product ships no mapping dependency), and the small amount of
// choropleth-specific classification math (nice-round class breaks).
//
// SVG assembly, palette, and text layout stay in viz.mjs (which imports this
// module) - the same split cartography.mjs (pure map math) / viz.mjs
// (rendering) already uses for cartographic_flow_map.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getBasemap } from "./basemap_registry.mjs";
import { economyEntryFor } from "./economy_names.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// The one basemap this chart type is bound to: the only registered basemap
// the attribute sidecar was built against (see
// fixtures/external/naturalearth_50m_attributes/SOURCE.json).
export const CHOROPLETH_BASEMAP_ID = "naturalearth_admin0_50m";

function loadAttributesAsset() {
  const path = join(HERE, "assets", "naturalearth-admin0-50m-attributes.json");
  const asset = JSON.parse(readFileSync(path, "utf8"));
  const byIso3 = new Map();
  for (const feature of asset.features) {
    if (!feature.iso3) continue;
    if (!byIso3.has(feature.iso3)) byIso3.set(feature.iso3, []);
    byIso3.get(feature.iso3).push(feature.index);
  }
  return { asset, byIso3 };
}

const ATTRIBUTES = loadAttributesAsset();

/** The parsed naturalearth-admin0-50m-attributes.json sidecar, unmodified. */
export function neAttributesAsset() {
  return ATTRIBUTES.asset;
}

/** Basemap feature indices (into both the sidecar and the vendored geometry) carrying this iso3. Empty when none. */
export function featureIndicesForIso3(iso3) {
  return ATTRIBUTES.byIso3.get(iso3) ?? [];
}

/** Sidecar attribute entry for basemap feature `index`, or null. */
export function neFeatureAttributes(index) {
  return ATTRIBUTES.asset.features[index] ?? null;
}

function basemapFeatureList() {
  return getBasemap(CHOROPLETH_BASEMAP_ID)?.data?.features ?? [];
}

/** GeoJSON geometry of basemap feature `index` from the registered basemap, or null. */
export function neFeatureGeometry(index) {
  return basemapFeatureList()[index]?.geometry ?? null;
}

/** Feature count of the registered basemap (242 at the time of writing). */
export function neFeatureCount() {
  return basemapFeatureList().length;
}

// ---------------------------------------------------------------------------
// Join: row[category_field] -> economy_names.mjs table entry -> iso3 ->
// sidecar features with that iso3. No model-chosen key anywhere in this path.

/**
 * Resolve every row's category value through economy_names.mjs's vendored
 * table to an iso3 and the basemap feature indices carrying it. One entry
 * per row, in row order. `entry` is economy_names.mjs's own table entry
 * (carries `.kind` - "economy" | "aggregate" - and `.iso3`), or null when
 * the raw value has no exact table match at all (economy_names.mjs's own
 * unmappedEconomyNameValues lint already blocks that case).
 */
export function joinChoroplethRows(rows, spec) {
  const field = spec?.category_field;
  const categoryNames = spec?.category_names;
  return (rows ?? []).map((row) => {
    const raw = row?.[field];
    const entry = economyEntryFor(raw, categoryNames);
    const iso3 = entry?.iso3 ?? null;
    const featureIndices = iso3 ? featureIndicesForIso3(iso3) : [];
    return { row, raw, entry, iso3, featureIndices };
  });
}

/**
 * Deterministic, blocking lint for chart_type='choropleth'. Reuses
 * economy_names.mjs's own unmapped-value check (invoked separately, in
 * viz.mjs's lintVizSpec, exactly like every other category_names chart type)
 * for "unmapped values"; this function covers the remaining choropleth-
 * specific cases: the row cap, aggregate rows (a regional/income rollup has
 * no single map feature), individual economies with zero matching map
 * features (present in the World Bank table, absent from this basemap - for
 * example CHI/Channel Islands or GIB/Gibraltar), and duplicate economies
 * (two rows resolving to the same iso3, which would colour/label the same
 * feature(s) twice with conflicting values).
 */
export function lintChoroplethSpec(spec, rows) {
  const blockers = [];
  const warnings = [];
  const categoryNames = spec?.category_names;
  if (!["worldbank", "iso3"].includes(categoryNames)) {
    blockers.push("choropleth requires category_names to be 'worldbank' or 'iso3'");
  }
  const rowList = Array.isArray(rows) ? rows : [];
  if (rowList.length > 60) blockers.push(`choropleth has ${rowList.length} rows; maximum is 60 - filter rows in SQL`);
  if (!["worldbank", "iso3"].includes(categoryNames) || !spec?.category_field) return { blockers, warnings };

  const joined = joinChoroplethRows(rowList, spec);
  const aggregateValues = [...new Set(joined.filter((item) => item.entry?.kind === "aggregate").map((item) => String(item.raw)))];
  if (aggregateValues.length) {
    blockers.push(`choropleth category_field '${spec.category_field}' contains ${aggregateValues.length} aggregate row(s) that are not map features: ${aggregateValues.slice(0, 8).join(", ")}`);
  }
  const noFeatureValues = [...new Set(joined.filter((item) => item.entry?.kind === "economy" && item.featureIndices.length === 0).map((item) => String(item.raw)))];
  if (noFeatureValues.length) {
    blockers.push(`choropleth category_field '${spec.category_field}' contains ${noFeatureValues.length} economy value(s) with no matching map feature: ${noFeatureValues.slice(0, 8).join(", ")}`);
  }
  const rawsByIso3 = new Map();
  for (const item of joined) {
    if (item.entry?.kind !== "economy" || !item.iso3) continue;
    if (!rawsByIso3.has(item.iso3)) rawsByIso3.set(item.iso3, []);
    rawsByIso3.get(item.iso3).push(String(item.raw));
  }
  const duplicates = [...rawsByIso3.entries()].filter(([, raws]) => raws.length > 1);
  if (duplicates.length) {
    const detail = duplicates.slice(0, 5).map(([iso3, raws]) => `${iso3} (${raws.join(", ")})`).join("; ");
    blockers.push(`choropleth category_field '${spec.category_field}' has ${duplicates.length} duplicate economy/economies mapping to the same map feature(s): ${detail}`);
  }
  // inset.iso3 (manual mode) must name only economies actually plotted on
  // this map - a code with no data row would otherwise silently vanish from
  // both the main map's labels and the inset (validateVizSpec's own object
  // shape check runs earlier; this is the only place with `rows` in hand to
  // check the codes resolve to real, plotted data).
  if (spec?.inset && Array.isArray(spec.inset.iso3) && spec.inset.iso3.length) {
    const plottedIso3 = new Set(joined.filter((item) => item.entry?.kind === "economy" && item.featureIndices.length).map((item) => item.iso3));
    const requested = spec.inset.iso3.map((code) => String(code ?? "").trim().toUpperCase());
    const unplotted = requested.filter((code) => !plottedIso3.has(code));
    if (unplotted.length) {
      blockers.push(`choropleth inset.iso3 names ${unplotted.length} code(s) with no plotted data on this map: ${unplotted.slice(0, 8).join(", ")}`);
    }
  }
  return { blockers, warnings };
}

// ---------------------------------------------------------------------------
// Lambert azimuthal equal-area projection (spherical, oblique/general
// aspect). Forward/inverse per Snyder, "Map Projections - A Working Manual"
// (USGS Professional Paper 1395): forward eq. 24-1..24-3, inverse eq.
// 20-14/20-15 with c(rho) from eq. 24-16, all on the unit sphere (R=1).
// lon0/lat0 (degrees) is the projection centre; y is northward-positive in
// this raw, unscaled form (the pixel fit step below flips it for SVG).

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Raw (R=1, unscaled) forward projection centred at (lon0, lat0), both in degrees. Returns [x, y]. */
export function azimuthalEqualAreaForward(lon0, lat0) {
  const phi0 = lat0 * DEG2RAD;
  const lambda0 = lon0 * DEG2RAD;
  const sinPhi0 = Math.sin(phi0);
  const cosPhi0 = Math.cos(phi0);
  return (lon, lat) => {
    const phi = lat * DEG2RAD;
    const lambda = lon * DEG2RAD - lambda0;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const cosLambda = Math.cos(lambda);
    const cosC = sinPhi0 * sinPhi + cosPhi0 * cosPhi * cosLambda;
    const k = Math.sqrt(Math.max(0, 2 / (1 + cosC)));
    return [k * cosPhi * Math.sin(lambda), k * (cosPhi0 * sinPhi - sinPhi0 * cosPhi * cosLambda)];
  };
}

/** Raw (R=1, unscaled) inverse of azimuthalEqualAreaForward(lon0, lat0). Returns [lon, lat] in degrees, or null at the antipode (undefined). */
export function azimuthalEqualAreaInverse(lon0, lat0) {
  const phi0 = lat0 * DEG2RAD;
  const lambda0 = lon0 * DEG2RAD;
  const sinPhi0 = Math.sin(phi0);
  const cosPhi0 = Math.cos(phi0);
  return (x, y) => {
    const rho = Math.hypot(x, y);
    if (rho < 1e-9) return [lon0, lat0];
    if (rho > 2) return null; // beyond the projection's disk (antipodal hemisphere)
    const c = 2 * Math.asin(Math.min(1, rho / 2));
    const sinC = Math.sin(c);
    const cosC = Math.cos(c);
    const phi = Math.asin(cosC * sinPhi0 + (y * sinC * cosPhi0) / rho);
    const lambda = lambda0 + Math.atan2(x * sinC, rho * cosPhi0 * cosC - y * sinPhi0 * sinC);
    let lon = lambda * RAD2DEG;
    lon = ((lon + 540) % 360) - 180; // normalize to (-180, 180]
    return [lon, phi * RAD2DEG];
  };
}

/** Great-circle angular distance (degrees) between (lon,lat) and the centre (lon0,lat0). */
export function angularDistanceDeg(lon, lat, lon0, lat0) {
  const phi0 = lat0 * DEG2RAD;
  const phi = lat * DEG2RAD;
  const dLambda = (lon - lon0) * DEG2RAD;
  const cosC = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dLambda);
  return Math.acos(Math.max(-1, Math.min(1, cosC))) * RAD2DEG;
}

/**
 * Fit a raw azimuthal projection to a pixel rect: scales/centres/flips-y so
 * that projecting every [lon, lat] in `points` lands inside
 * [left,right]x[top,bottom] with `paddingRatio` of slack on each side, then
 * returns {project, invert} in pixel space. Mirrors createProjectionForExtent
 * in cartography.mjs (bbox-fit a raw projection to a plot rect), but fits to
 * the exact projected bounding box of real ring points rather than a
 * lon/lat bbox resampled on its edges - required here because an azimuthal
 * projection can bow a straight-edged lon/lat bbox into a curve, so only the
 * actual projected geometry gives a correct pixel bbox.
 */
export function fitAzimuthalProjection(lon0, lat0, points, left, right, top, bottom, paddingRatio = 0.08) {
  const rawForward = azimuthalEqualAreaForward(lon0, lat0);
  const rawInverse = azimuthalEqualAreaInverse(lon0, lat0);
  const projected = (points ?? []).map(([lon, lat]) => rawForward(lon, lat)).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const xs = projected.length ? projected.map((p) => p[0]) : [-1, 1];
  const ys = projected.length ? projected.map((p) => p[1]) : [-1, 1];
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const w = Math.max(1e-9, xmax - xmin);
  const h = Math.max(1e-9, ymax - ymin);
  const pad = Math.max(0, Number(paddingRatio) || 0);
  const availW = Math.max(1, right - left);
  const availH = Math.max(1, bottom - top);
  const scale = Math.min(availW / (w * (1 + 2 * pad)), availH / (h * (1 + 2 * pad)));
  const cx = (xmin + xmax) / 2;
  const cy = (ymin + ymax) / 2;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  return {
    lon0,
    lat0,
    scale,
    project(lon, lat) {
      const [x, y] = rawForward(lon, lat);
      return { x: midX + (x - cx) * scale, y: midY - (y - cy) * scale };
    },
    invert(px, py) {
      const x = (px - midX) / scale + cx;
      const y = -(py - midY) / scale + cy;
      return rawInverse(x, y);
    },
  };
}

/** Centre (bbox midpoint, in degrees) of a set of [lon, lat] pairs. */
export function bboxCenter(points) {
  if (!points || !points.length) return [0, 0];
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}

// ---------------------------------------------------------------------------
// Ring/geometry helpers.

/** Flattened list of linear rings (outer + holes) for a Polygon or MultiPolygon geometry. */
export function geometryRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

/** True when every point of `ring` is within `limitDeg` of the projection centre. */
export function ringWithinHorizon(ring, lon0, lat0, limitDeg = 90) {
  return (ring ?? []).every(([lon, lat]) => angularDistanceDeg(lon, lat, lon0, lat0) <= limitDeg);
}

function intersectAtX(a, b, x) {
  const t = (x - a[0]) / (b[0] - a[0]);
  return [x, a[1] + t * (b[1] - a[1])];
}
function intersectAtY(a, b, y) {
  const t = (y - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), y];
}

/**
 * Sutherland-Hodgman polygon clip against an axis-aligned rect, in whatever
 * coordinate space `points` are already in (every caller here uses it in
 * projected pixel space, after project() has run). This exists because
 * render_qa_contrast.mjs's polygon containment check reads a rendered
 * <path>'s own `d` geometry directly and does not honour SVG clip-path: a
 * context country whose true projected shape reaches far outside the plot
 * rect - routine for an azimuthal projection fit tightly to a small,
 * regional set of data features, where a country near the fitted region's
 * horizon (up to limitDeg away) projects to a huge radius - would otherwise
 * still "contain" a point on the page nowhere near the visible map,
 * corrupting an unrelated label's contrast check even though a real
 * renderer's clip-path hides it perfectly well visually. SVG clip-path is
 * kept too (belt and suspenders for real renderers/screenshots); this is
 * what keeps the emitted geometry itself honest for a tool that reads `d`
 * directly.
 */
export function clipPolygonToRect(points, rect) {
  if (!points || !points.length) return [];
  const edges = [
    { inside: (p) => p[0] >= rect.left, intersect: intersectAtX, at: rect.left },
    { inside: (p) => p[0] <= rect.right, intersect: intersectAtX, at: rect.right },
    { inside: (p) => p[1] >= rect.top, intersect: intersectAtY, at: rect.top },
    { inside: (p) => p[1] <= rect.bottom, intersect: intersectAtY, at: rect.bottom },
  ];
  let output = points;
  for (const edge of edges) {
    if (!output.length) break;
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const curr = input[i];
      const prev = input[(i - 1 + input.length) % input.length];
      const currIn = edge.inside(curr);
      const prevIn = edge.inside(prev);
      if (currIn) {
        if (!prevIn) output.push(edge.intersect(prev, curr, edge.at));
        output.push(curr);
      } else if (prevIn) {
        output.push(edge.intersect(prev, curr, edge.at));
      }
    }
  }
  return output;
}

/**
 * SVG path `d` for one ring, projected, optionally clipped to `clipRect`
 * (see clipPolygonToRect), rounded to `precision` decimal places, and
 * thinned by dropping a point closer than `minDist` px to the previously
 * emitted point of the same ring - keeps the rendered map's SVG small
 * without changing its visible shape at typical display sizes.
 */
export function ringPath(ring, project, { precision = 1, minDist = 0.5, clipRect = null } = {}) {
  const factor = 10 ** precision;
  let projected = [];
  for (const point of ring ?? []) {
    const p = project(point[0], point[1]);
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) projected.push([p.x, p.y]);
  }
  if (clipRect) projected = clipPolygonToRect(projected, clipRect);
  let d = "";
  let prev = null;
  let started = false;
  for (const [px, py] of projected) {
    const rx = Math.round(px * factor) / factor;
    const ry = Math.round(py * factor) / factor;
    if (prev && Math.hypot(rx - prev.x, ry - prev.y) < minDist) continue;
    d += `${started ? "L" : "M"}${rx},${ry}`;
    started = true;
    prev = { x: rx, y: ry };
  }
  return d ? `${d}Z` : "";
}

/**
 * SVG path `d` for a whole feature geometry: every ring within `limitDeg` of
 * (lon0,lat0), projected, clipped to `clipRect` when given, and rounded via
 * ringPath. Rings that cross the projection's horizon are dropped whole
 * (never partially clipped in lon/lat space) - clipRect is the pixel-space
 * clip that actually keeps every emitted coordinate inside the plot rect
 * (see clipPolygonToRect's own doc comment for why relying on SVG clip-path
 * alone is not enough).
 */
export function featurePath(geometry, project, { lon0, lat0, limitDeg = 90, precision = 1, minDist = 0.5, clipRect = null } = {}) {
  const rings = geometryRings(geometry).filter((ring) => lon0 === undefined || ringWithinHorizon(ring, lon0, lat0, limitDeg));
  return rings.map((ring) => ringPath(ring, project, { precision, minDist, clipRect })).join("");
}

// ---------------------------------------------------------------------------
// Classification: a 5-class sequential ramp with nice round class breaks
// computed from the data (not the unit) - see niceBreaks' own doc comment.

/**
 * `classes`+1 nice round numbers spanning at least [min, max]: the same
 * "1/2/5 x 10^k" nice-number family viz.mjs's tickValues() ticks use (see
 * that function's own comment), but solved for an EXACT class count (a
 * legend needs a fixed number of swatches, not "however many ticks()
 * lands on") and for guaranteed coverage of the data (tickValues() instead
 * finds ticks that lie inside an already-fixed [start,stop] domain, the
 * opposite direction). Escalates the step (1 -> 2 -> 5 -> 10 x the next
 * power of ten) until floor(min/step)*step + classes*step covers max; this
 * always terminates (a wide enough step trivially covers any finite range)
 * and, for most real data, resolves at the first or second candidate (for
 * example min=19.6/max=96.3/classes=5 resolves to step=20 at the first
 * candidate: [0,20,40,60,80,100]).
 */
export function niceBreaks(min, max, classes = 5) {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (hi <= lo) hi = lo + 1;
  const n = Math.max(1, Math.floor(classes));
  const rawStep = (hi - lo) / n;
  const power0 = Math.floor(Math.log10(rawStep));
  const NICE_FACTORS = [1, 2, 5, 10];
  for (let power = power0; power <= power0 + 4; power++) {
    const base = 10 ** power;
    for (const factor of NICE_FACTORS) {
      const step = factor * base;
      if (step < rawStep - 1e-9) continue;
      const niceMin = Math.floor(lo / step) * step;
      if (niceMin + n * step >= hi - 1e-9) {
        const breaks = [];
        for (let i = 0; i <= n; i++) breaks.push(Math.round((niceMin + i * step) * 1e6) / 1e6);
        return breaks;
      }
    }
  }
  // Unreachable in practice (the power0+4 pass always finds a covering
  // step), but never throw from a lint/render-path helper: fall back to a
  // plain linear split so a caller always gets classes+1 finite numbers.
  const step = (hi - lo) / n;
  return Array.from({ length: n + 1 }, (_, i) => Math.round((lo + i * step) * 1e6) / 1e6);
}

// ---------------------------------------------------------------------------
// Zoom inset geometry (task: small-region inset). Pure bbox math only - the
// label-fits-or-not decision (which needs viz.mjs's own font-metric
// heuristic, choroplethLabelWidth) and all SVG assembly stay in viz.mjs, same
// split as the rest of this module.

/**
 * Projected pixel bbox of a set of basemap feature indices' own rings, under
 * `project` (a projection's forward function, (lon, lat) => {x, y}).
 * Returns null when no ring point projects to a finite pixel (an empty
 * feature list, or every point beyond the projection's own horizon).
 */
export function projectedFeatureBBox(featureIndices, project) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const index of featureIndices ?? []) {
    for (const ring of geometryRings(neFeatureGeometry(index))) {
      for (const [lon, lat] of ring) {
        const p = project(lon, lat);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, maxX, minY, maxY };
}

/** Index (0-based) of the class `value` falls into, given `breaks` (classes+1 edges, ascending). Clamps out-of-range values into the nearest edge class. */
export function classifyValue(value, breaks) {
  const classes = breaks.length - 1;
  if (!Number.isFinite(value) || classes < 1) return 0;
  if (value <= breaks[0]) return 0;
  if (value >= breaks[classes]) return classes - 1;
  for (let i = 0; i < classes; i++) {
    if (value >= breaks[i] && value < breaks[i + 1]) return i;
  }
  return classes - 1;
}
