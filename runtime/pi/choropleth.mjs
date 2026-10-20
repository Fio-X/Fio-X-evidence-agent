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
import { symbolMapOn } from "./symbol_map_switch.mjs";
import { fitUsProjection } from "./us_projection.mjs";
import { ECONOMY_NAME_MODES, economyEntryFor, usStatesEnabled } from "./economy_names.mjs";

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

// US state maps (NEWSROOM_US_STATES=1, category_names 'us_state'): the 51 features of the registered state basemap live in
// the same feature-index space as the world basemap, shifted by US_INDEX_BASE (a world index is < 1000 and never reaches it),
// so every renderer path that walks `featureIndices` works on states unchanged. Each state's region id is "US-<USPS>".
export const US_INDEX_BASE = 1000;
export const CHOROPLETH_US_BASEMAP_ID = "naturalearth_admin1_us_110m";

function loadUsAttributes() {
  const asset = JSON.parse(readFileSync(join(HERE, "assets", "naturalearth-admin1-us-110m-attributes.json"), "utf8"));
  const byId = new Map(asset.features.map((feature) => [`US-${feature.usps}`, [US_INDEX_BASE + feature.index]]));
  return { asset, byId };
}
const US_ATTRIBUTES = loadUsAttributes();

export { usStatesEnabled };

/** True for a choropleth that draws US states: the switch is on and the spec says category_names 'us_state'. */
export function isUsStateMap(spec) {
  return usStatesEnabled() && spec?.category_names === "us_state";
}

/** Feature indices of one US state map, in basemap order. */
export function usFeatureIndexList() {
  return US_ATTRIBUTES.asset.features.map((feature) => US_INDEX_BASE + feature.index);
}

/** Feature indices to draw for a choropleth spec: every world feature, or the 51 states for a US state map. */
export function choroplethFeatureIndexList(spec) {
  return isUsStateMap(spec) ? usFeatureIndexList() : Array.from({ length: neFeatureCount() }, (_, index) => index);
}

/** Basemap feature indices (into both the sidecar and the vendored geometry) carrying this iso3. Empty when none. */
export function featureIndicesForIso3(iso3) {
  return ATTRIBUTES.byIso3.get(iso3) ?? US_ATTRIBUTES.byId.get(iso3) ?? [];
}

/** Sidecar attribute entry for basemap feature `index`, or null. A US state entry carries name and label point only. */
export function neFeatureAttributes(index) {
  if (index >= US_INDEX_BASE) {
    const feature = US_ATTRIBUTES.asset.features[index - US_INDEX_BASE];
    return feature ? { index, iso3: `US-${feature.usps}`, name: feature.name, label: feature.label } : null;
  }
  return ATTRIBUTES.asset.features[index] ?? null;
}

function basemapFeatureList() {
  return getBasemap(CHOROPLETH_BASEMAP_ID)?.data?.features ?? [];
}

/** GeoJSON geometry of basemap feature `index` from the registered basemap, or null. */
export function neFeatureGeometry(index) {
  if (index >= US_INDEX_BASE) return getBasemap(CHOROPLETH_US_BASEMAP_ID)?.data?.features?.[index - US_INDEX_BASE]?.geometry ?? null;
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
 * unmappedEconomyNameValues lint already blocks that case). Every
 * ECONOMY_NAME_MODES mode ("worldbank", "iso3", "iso2") lands on the same
 * entry, so an ISO2-keyed row joins through that entry's iso3 exactly like
 * an ISO3-keyed one.
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
/**
 * World mode is behind NEWSROOM_MAP_WORLD, off by default; only the exact string "1" turns it on. Known open issues
 * while it is on: the LIMIT-regex completeness check, the value_labels exemption of color_only_quantity, and the
 * publication verifiers (verify_artifact.py, verify.rs) that still require a label on every region.
 */
// The one allowed path for a map of more than 60 economies, named by both the row-cap refusal and the LIMIT warning (K308 item 3).
function WORLD_PATH_HINT() {
  return mapWorldEnabled()
    ? "to map every economy with data set map_extent 'world' and remove any LIMIT (the countries the map does not label are listed under it); otherwise keep at most 60 rows chosen by a WHERE rule such as a value threshold, not by LIMIT"
    : "map_extent 'world' is not available in this run, so keep at most 60 rows chosen by a WHERE rule such as a value threshold, not by LIMIT";
}
export function mapWorldEnabled() {
  return process.env.NEWSROOM_MAP_WORLD === "1";
}

/** True for the opt-in whole-world mode (`map_extent: "world"`, only with NEWSROOM_MAP_WORLD=1). */
export function isWorldExtent(spec) {
  return mapWorldEnabled() && spec?.map_extent === "world";
}

/**
 * World list mode (NEWSROOM_MAP_WORLD_LIST, off by default; only the exact string "1" turns it on, and only with
 * world mode): the countries the map does not label are each printed once in a grouped list under the map. The
 * switch is the program's own - no chart spec can turn it on.
 */
export function mapWorldListEnabled() {
  return process.env.NEWSROOM_MAP_WORLD_LIST === "1";
}

export function isWorldListMode(spec) {
  return mapWorldListEnabled() && isWorldExtent(spec);
}

/** World mode draws at most this many text labels on the map. */
export const WORLD_LABEL_MAX = 8;

/** Fixed frame for the world projection: Equal Earth over the populated latitudes (no Antarctica), never the data's bbox. */
export const WORLD_FRAME_POINTS = [[-180, 0], [180, 0], [0, 84], [0, -58]];

/** True for the basemap's Antarctica feature, which world mode leaves undrawn. */
export function isAntarcticaFeature(index) {
  return neFeatureAttributes(index)?.continent === "Antarctica";
}

// symbol_map (the symbol map switch: on unless exactly "0", read in symbol_map_switch.mjs): a proportional-circle map. A total (tonnes, people, PJ, counts) goes on the
// map as a circle whose AREA is proportional to the value, anchored on the region's label point; the basemap, the join and the region
// names are the choropleth's own. Pure functions only: the SVG layout lives in viz.mjs (renderSymbolMap).
export function symbolMapEnabled() {
  return symbolMapOn(process.env);
}

// Extent rule for a symbol map that is not a US state map: the share of the globe's surface that the regions' bounding box covers (the extent
// classes of the Projection Wizard, Savric, Jenny and Jenny 2016, Cartographic Journal 53(2), built on Snyder's guideline: world at two-thirds or
// more, hemisphere from one-sixth up to two-thirds, continent or smaller below one-sixth). world: the whole base map; crop: the world
// projection (Equal Earth, north up) cropped to the box with padding; region: a projection fitted to the box (the azimuthal one chooseMapProjection picks).
// Where the numbers come from: the paper gives the three extent CLASSES (world / hemisphere-to-continent / smaller), built on Snyder's guideline, but
// the cut-offs 2/3 and 1/6 below are OUR OWN choices following those classes - we found no section or table of the paper that states them.
// Likewise the way the share is computed (longitude span around the largest gap, sine of the latitude band) is our own implementation.
export const SYMBOL_WORLD_SHARE = 2 / 3;
export const SYMBOL_REGION_SHARE = 1 / 6;
export function symbolBoxShare(points) {
  const pts = (points ?? []).filter((p) => Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));
  if (pts.length < 2) return 0;
  const lons = pts.map((p) => ((Number(p[0]) + 540) % 360) - 180).sort((x, y) => x - y);
  let gap = lons[0] + 360 - lons[lons.length - 1];
  for (let i = 1; i < lons.length; i++) gap = Math.max(gap, lons[i] - lons[i - 1]);
  const lats = pts.map((p) => Number(p[1]));
  const rad = Math.PI / 180;
  return ((360 - gap) / 360) * ((Math.sin(Math.max(...lats) * rad) - Math.sin(Math.min(...lats) * rad)) / 2);
}
// Report-only: true when [lon, lat] lies inside none of the polygons (even-odd over the rings of each feature). A symbol anchored outside its own
// region (an archipelago's label point at sea, a small island) is listed, never refused.
export function pointInsideFeatures(point, geometries) {
  const [x, y] = point;
  for (const geometry of geometries ?? []) {
    let inside = false;
    for (const ring of geometryRings(geometry)) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}
export function symbolMapFrameMode(points) {
  const share = symbolBoxShare(points);
  return share >= SYMBOL_WORLD_SHARE ? "world" : share >= SYMBOL_REGION_SHARE ? "crop" : "region";
}

// symbol_map crop (NEWSROOM_SYMBOL_MAP_CROP=1 together with NEWSROOM_SYMBOL_MAP=1, exact "1", default off): the frame is decided by the points the circles
// sit on (label points, plus the focus place's), not by the whole outlines, so one huge or date-line-crossing country no longer widens it to the world.
export function symbolMapCropEnabled() {
  return process.env.NEWSROOM_SYMBOL_MAP_CROP === "1";
}
// Starting values: not from the literature, not trial-run. Margin is a share of the span added on each side; the minimums stop one or two close
// circles from collapsing the frame into a point. Change them only together with the test that pins them.
export const SYMBOL_CROP_MARGIN = 0.12;
export const SYMBOL_CROP_MIN_LON = 24;
export const SYMBOL_CROP_MIN_LAT = 16;
// Box of the given [lon, lat] points: longitude span around the largest gap (date line), latitude min to max, plus margin and minimum span.
// lonMin..lonMax is unwrapped (lonMax - lonMin is the span, either end may leave [-180, 180]); crossesDateLine says so. null when no point is usable.
export function symbolCropBox(points) {
  const pts = (points ?? []).filter((p) => Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));
  if (!pts.length) return null;
  const lons = pts.map((p) => ((Number(p[0]) + 540) % 360) - 180).sort((x, y) => x - y);
  let gap = lons[0] + 360 - lons[lons.length - 1], start = 0;
  for (let i = 1; i < lons.length; i++) if (lons[i] - lons[i - 1] > gap) { gap = lons[i] - lons[i - 1]; start = i; }
  const lats = pts.map((p) => Number(p[1]));
  const latLo = Math.min(...lats), latHi = Math.max(...lats);
  const lonSpan = Math.min(360, Math.max(SYMBOL_CROP_MIN_LON, (360 - gap) * (1 + 2 * SYMBOL_CROP_MARGIN)));
  const latSpan = Math.max(SYMBOL_CROP_MIN_LAT, (latHi - latLo) * (1 + 2 * SYMBOL_CROP_MARGIN));
  const lonMid = lons[start] + (360 - gap) / 2, latMid = (latLo + latHi) / 2;
  const latMin = Math.max(-90, latMid - latSpan / 2), latMax = Math.min(90, latMid + latSpan / 2);
  const lonMin = lonMid - lonSpan / 2, lonMax = lonMid + lonSpan / 2;
  return { lonMin, lonMax, latMin, latMax, crossesDateLine: lonSpan < 360 && (lonMin < -180 || lonMax > 180) };
}
export function symbolCropBoxShare(box) {
  const rad = Math.PI / 180;
  return ((box.lonMax - box.lonMin) / 360) * ((Math.sin(box.latMax * rad) - Math.sin(box.latMin * rad)) / 2);
}
// Same tier rule and thresholds as symbolMapFrameMode; only the input differs.
export function symbolCropFrameMode(box) {
  const share = symbolCropBoxShare(box);
  return share >= SYMBOL_WORLD_SHARE ? "world" : share >= SYMBOL_REGION_SHARE ? "crop" : "region";
}
export function symbolCropCorners(box) {
  return [[box.lonMin, box.latMin], [box.lonMax, box.latMin], [box.lonMax, box.latMax], [box.lonMin, box.latMax]];
}

export const SYMBOL_MIN_RADIUS_PX = 2.5;
export const SYMBOL_MAX_OVERLAP = 0.6;
export const SYMBOL_SHRINK_FACTOR = 0.85;
export const SYMBOL_MAX_SHRINKS = 2;
export const SYMBOL_TOTAL_KINDS = new Set(["count", "flow", "stock", "cumulative", "capacity", "level"]);

// Area proportional to the value: r = rMax * sqrt(v / vMax).
export function symbolRadius(value, vMax, rMax) {
  if (!(value > 0) || !(vMax > 0)) return 0;
  return rMax * Math.sqrt(value / vMax);
}

// Overlap of two circles as a share of the smaller circle's area (0 apart, 1 when the smaller sits wholly inside the larger).
export function circleOverlapShare(a, b) {
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const small = Math.min(a.r, b.r), big = Math.max(a.r, b.r);
  if (!(small > 0)) return 0;
  if (d >= small + big) return 0;
  if (d <= big - small) return 1;
  const part = (r, other) => r * r * Math.acos((d * d + r * r - other * other) / (2 * d * r));
  const lens = part(a.r, b.r) + part(b.r, a.r) - 0.5 * Math.sqrt((-d + a.r + b.r) * (d + a.r - b.r) * (d - a.r + b.r) * (d + a.r + b.r));
  return Math.min(1, Math.max(0, lens / (Math.PI * small * small)));
}

function worstOverlap(circles) {
  let worst = 0;
  for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) worst = Math.max(worst, circleOverlapShare(circles[i], circles[j]));
  return worst;
}

/**
 * Radii for `items` ({ id, value, x, y }). Values <= 0 get no circle (`zero` lists them). A value whose true radius is below `rMin` is drawn at
 * rMin and flagged `min: true`; `r` stays the true radius. When two circles overlap by more than SYMBOL_MAX_OVERLAP of the smaller one, rMax
 * shrinks (x0.85, at most twice); what still overlaps after that is reported in `crowded` for the caller's fallback.
 */
export function planSymbols(items, { rMax, rMin = SYMBOL_MIN_RADIUS_PX } = {}) {
  const positive = items.filter((item) => item.value > 0 && Number.isFinite(item.value));
  const zero = items.filter((item) => item.value === 0);
  const vMax = positive.reduce((m, item) => Math.max(m, item.value), 0);
  let radius = rMax, shrinks = 0, circles = [];
  const build = () => positive
    .map((item) => {
      const r = symbolRadius(item.value, vMax, radius);
      return { ...item, r, drawR: Math.max(r, rMin), min: r < rMin };
    })
    .sort((a, b) => b.value - a.value || String(a.id).localeCompare(String(b.id), "en-US"));
  circles = build();
  while (shrinks < SYMBOL_MAX_SHRINKS && worstOverlap(circles.map((c) => ({ x: c.x, y: c.y, r: c.drawR }))) > SYMBOL_MAX_OVERLAP) {
    radius *= SYMBOL_SHRINK_FACTOR;
    shrinks += 1;
    circles = build();
  }
  const crowded = [];
  for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) {
    const a = circles[i], b = circles[j];
    if (circleOverlapShare({ x: a.x, y: a.y, r: a.drawR }, { x: b.x, y: b.y, r: b.drawR }) > SYMBOL_MAX_OVERLAP) crowded.push([a.id, b.id]);
  }
  return { vMax, rMax: radius, shrinks, circles, zero, crowded };
}

// The 1-2-5 number at or below `value` (1, 2, 5 times a power of ten); 0 for a non-positive value.
export function niceFloor125(value) {
  if (!(value > 0)) return 0;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const m of [5, 2, 1]) if (m * base <= value * (1 + 1e-12)) return m * base;
  return base;
}

// Legend values: the 1-2-5 number at or below vMax, one near half its area, one near a tenth. Distinct, descending.
export function symbolLegendValues(vMax) {
  const top = niceFloor125(vMax);
  if (!(top > 0)) return [];
  const out = [top];
  for (const share of [0.5, 0.1]) {
    const v = niceFloor125(top * share);
    if (v > 0 && v < out[out.length - 1]) out.push(v);
  }
  return out;
}

/**
 * Value rules for a symbol_map spec and its rows. Errors block, warnings only advise. A negative or non-finite value blocks (a circle has no
 * sign: use diverging_bar or a signed choropleth). A rate or share drawn as circles is allowed but advised toward a choropleth.
 */
export function lintSymbolMap(spec, rows) {
  const errors = [], warnings = [];
  const field = spec?.value_field;
  const bad = [], negative = [];
  for (const row of rows ?? []) {
    const raw = row?.[field];
    if (raw === null || raw === undefined || raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) bad.push(String(row?.[spec.category_field] ?? "?"));
    else if (v < 0) negative.push(String(row?.[spec.category_field] ?? "?"));
  }
  if (bad.length) errors.push(`symbol_map value_field '${field}' has non-finite values for: ${bad.slice(0, 5).join(", ")}`);
  if (negative.length) errors.push(`symbol_map cannot draw negative values (${negative.slice(0, 5).join(", ")}): a circle's area has no sign; use diverging_bar, or a choropleth with signed classes`);
  const kind = spec?.measure_kind ?? (Array.isArray(spec?.measure_semantics) ? spec.measure_semantics.find((m) => m?.field === field || m?.id === field)?.measure_kind : undefined);
  if (kind && ["rate", "share", "mean", "median", "index"].includes(kind)) warnings.push(`symbol_map value_field is a ${kind}; circle area suits totals, a ratio or average reads better as a choropleth`);
  return { errors, warnings };
}

const attrOf = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };
const numAttr = (tag, name) => { const raw = attrOf(tag, name); return raw === null || raw.trim() === "" ? NaN : Number(raw); };

/**
 * Render QA: every symbol-circle must carry data-value and data-r, and data-r must equal rMax * sqrt(value / vMax) where the largest value's
 * circle fixes rMax (tolerance 0.01 px). A circle flagged data-min-r is drawn larger than its true radius; its data-r is still held to the area
 * rule, and it is listed in `enlarged`. The largest value must have the largest radius.
 */
export function checkSymbolMapRadii(svg, { tolerance = 0.01 } = {}) {
  const failures = [];
  const circles = [];
  for (const tag of String(svg).match(/<circle\b[^>]*data-role="symbol-circle"[^>]*>/g) ?? []) {
    const value = numAttr(tag, "data-value"), r = numAttr(tag, "data-r"), iso3 = attrOf(tag, "data-iso3");
    if (!Number.isFinite(value) || !Number.isFinite(r)) { failures.push({ rule: "symbol-circle-missing-data", iso3 }); continue; }
    const shown = Number((/\sr="([^"]*)"/.exec(tag) ?? [])[1]);
    circles.push({ iso3, value, r, minR: attrOf(tag, "data-min-r") !== null, drawR: numAttr(tag, "data-draw-r"), cx: numAttr(tag, "cx"), cy: numAttr(tag, "cy"), shown });
  }
  // every circle lies inside the map frame (a clipped circle would hide part of its value)
  const frameTag = /<rect\b[^>]*data-role="symbol-map-frame"[^>]*>/.exec(String(svg))?.[0];
  if (frameTag) {
    const fx = numAttr(frameTag, "x"), fy = numAttr(frameTag, "y"), fw = numAttr(frameTag, "width"), fh = numAttr(frameTag, "height");
    for (const c of circles) {
      if (c.cx - c.shown < fx - 0.5 || c.cx + c.shown > fx + fw + 0.5 || c.cy - c.shown < fy - 0.5 || c.cy + c.shown > fy + fh + 0.5) failures.push({ rule: "symbol-circle-outside-frame", iso3: c.iso3 });
    }
  }
  const enlarged = circles.filter((c) => c.minR).map((c) => ({ iso3: c.iso3, r: c.r, drawR: c.drawR }));
  for (const c of circles.filter((c) => c.minR)) {
    if (!(c.drawR > c.r)) failures.push({ rule: "symbol-circle-min-not-enlarged", iso3: c.iso3 });
    // the minimum flag is legal only for a true radius under the minimum, drawn at exactly the minimum
    if (!(c.r < SYMBOL_MIN_RADIUS_PX) || Math.abs(c.drawR - SYMBOL_MIN_RADIUS_PX) > tolerance) failures.push({ rule: "symbol-circle-min-flag-illegal", iso3: c.iso3 });
  }
  // the DRAWN radius is what the reader sees: it must equal data-r (or data-draw-r for a minimum circle), not just the circle's own attributes
  for (const c of circles) {
    const wantShown = c.minR ? c.drawR : c.r;
    if (!Number.isFinite(c.shown) || !Number.isFinite(wantShown) || Math.abs(c.shown - wantShown) > tolerance) failures.push({ rule: "symbol-circle-drawn-r-mismatch", iso3: c.iso3, want: wantShown, got: c.shown });
  }
  if (circles.length && !frameTag) failures.push({ rule: "symbol-circle-no-frame" });
  // the renderer states how many circles it drew (rows with zero or no data are counted apart, they get none): a deleted circle breaks the count
  const groupTag = /<g\b[^>]*data-role="symbol-map-circles"[^>]*>/.exec(String(svg))?.[0];
  if (circles.length || groupTag) {
    const drawn = groupTag ? numAttr(groupTag, "data-circles") : NaN;
    if (!Number.isFinite(drawn) || drawn !== circles.length) failures.push({ rule: "symbol-circle-count", want: drawn, got: circles.length });
  }
  const top = circles.reduce((best, c) => (!best || c.value > best.value ? c : best), null);
  if (top) {
    if (top.minR) failures.push({ rule: "symbol-circle-largest-enlarged", iso3: top.iso3 });
    else for (const c of circles) {
      // the true radius (data-r) follows the area rule for every circle, a minimum circle included: only its drawn radius is enlarged
      const want = top.r * Math.sqrt(c.value / top.value);
      if (Math.abs(c.r - want) > tolerance) failures.push({ rule: "symbol-circle-area", iso3: c.iso3, want: Number(want.toFixed(3)), got: c.r });
      if (c.minR) continue;
      if (c.value < top.value && c.r >= top.r) failures.push({ rule: "symbol-circle-largest", iso3: c.iso3 });
    }
  }
  const anchorOutside = [...String(svg).matchAll(/<circle\b[^>]*data-role="symbol-circle"[^>]*\sdata-anchor-outside="1"[^>]*>/g)].map((m) => attrOf(m[0], "data-iso3"));
  return { failures, enlarged, count: circles.length, anchorOutside };
}

// ---- symbol_map readability (#218; part of NEWSROOM_SYMBOL_MAP, which is default off) ----
// Names: the largest SYMBOL_LABEL_MAX circles (the same cap as the world choropleth's labels) plus every highlight_values row are CANDIDATES for a name
// on the map; whether one is drawn there is decided by placement (placeSymbolLabels), not by a pixel size. A list under the map names EVERY circle once,
// so a circle without a label, or one hidden under its neighbour, is still named with its value. `items` are joined rows ({ iso3, row }).
export const SYMBOL_LABEL_MAX = WORLD_LABEL_MAX;
export function symbolLabelIso3s(items, spec) {
  const val = (item) => Number(item.row?.[spec?.value_field]);
  const list = (items ?? []).filter((item) => item?.iso3 && Number.isFinite(val(item)) && val(item) > 0);
  const ordered = [...list].sort((a, b) => val(b) - val(a) || String(a.iso3).localeCompare(String(b.iso3), "en-US"));
  const out = new Set(ordered.slice(0, SYMBOL_LABEL_MAX).map((item) => item.iso3));
  const highlights = new Set((spec?.highlight_values ?? []).map(String));
  for (const item of ordered) if (highlights.has(String(item.row?.[spec?.category_field]))) out.add(item.iso3);
  return ordered.map((item) => item.iso3).filter((iso3) => out.has(iso3));
}

const labelBoxesOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const labelBoxHitsCircle = (b, c, clearance) => {
  const nx = Math.max(b.x, Math.min(c.x, b.x + b.w)), ny = Math.max(b.y, Math.min(c.y, b.y + b.h));
  return Math.hypot(nx - c.x, ny - c.y) < c.r + clearance;
};

/**
 * Place the name of each wanted circle beside it: right, left, above, below, the first spot whose box lies inside `bounds`, touches no earlier
 * label box and no circle (any circle, its own included, with `clearance` px to spare). A name with no such spot is listed in `listOnly` - the
 * list under the map still names it. `circles` are { id, x, y, r } (r = the DRAWN radius); `names` maps id -> text. Pure and deterministic.
 */
export function placeSymbolLabels(circles, wantedIds, names, { bounds, textWidth, fontSize = 12, gap = 3, clearance = 1 } = {}) {
  const placed = [], listOnly = [], boxes = [];
  const byId = new Map((circles ?? []).map((c) => [c.id, c]));
  const h = Math.round(fontSize * 1.2);
  for (const id of wantedIds ?? []) {
    const c = byId.get(id);
    const text = String(names?.get(id) ?? "");
    if (!c || !text) { listOnly.push(id); continue; }
    const w = textWidth(text, fontSize);
    const spots = [
      { anchor: "start", box: { x: c.x + c.r + gap, y: c.y - h / 2, w, h } },
      { anchor: "end", box: { x: c.x - c.r - gap - w, y: c.y - h / 2, w, h } },
      { anchor: "middle", box: { x: c.x - w / 2, y: c.y - c.r - gap - h, w, h } },
      { anchor: "middle", box: { x: c.x - w / 2, y: c.y + c.r + gap, w, h } },
    ];
    const spot = spots.find(({ box }) => box.x >= bounds.left && box.x + box.w <= bounds.right && box.y >= bounds.top && box.y + box.h <= bounds.bottom
      && !boxes.some((other) => labelBoxesOverlap(box, other)) && !circles.some((other) => labelBoxHitsCircle(box, other, clearance)));
    if (!spot) { listOnly.push(id); continue; }
    boxes.push(spot.box);
    const x = spot.anchor === "start" ? spot.box.x : spot.anchor === "end" ? spot.box.x + spot.box.w : spot.box.x + spot.box.w / 2;
    placed.push({ id, text, x, y: spot.box.y + h * 0.78, anchor: spot.anchor, box: spot.box });
  }
  return { placed, listOnly };
}

/** The footnote sentence for crowded circle pairs (each overlapping by more than SYMBOL_MAX_OVERLAP of the smaller circle); "" when there are none. */
export function symbolOverlapNote(crowded, nameOf, lang) {
  const pairs = crowded ?? [];
  if (!pairs.length) return "";
  const shown = pairs.slice(0, 4).map(([a, b]) => `${nameOf(a)}${lang === "zh" ? "、" : " / "}${nameOf(b)}`);
  const more = pairs.length > shown.length ? (lang === "zh" ? "等" : ", …") : "";
  const pct = Math.round(SYMBOL_MAX_OVERLAP * 100);
  return lang === "zh"
    ? `${pairs.length} 对圆重叠超过较小圆面积的 ${pct}%（${shown.join("；")}${more}），各地区数值见下方清单。`
    : `${pairs.length} pair(s) of circles overlap by more than ${pct}% of the smaller circle (${shown.join("; ")}${more}); every value is in the list below.`;
}

/** The circle pairs whose overlap exceeds SYMBOL_MAX_OVERLAP of the smaller circle, as [idA, idB] in input order. `circles` are { id, x, y, r } (drawn radius). */
export function symbolCrowdedPairs(circles) {
  const out = [];
  for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) {
    if (circleOverlapShare(circles[i], circles[j]) > SYMBOL_MAX_OVERLAP) out.push([circles[i].id, circles[j].id]);
  }
  return out;
}

/**
 * Render QA for the circle list and the overlap record. From the SVG alone: every symbol-circle is named once in the list (data-role
 * symbol-list-name / symbol-list-value, data-iso3), the list holds nothing else, a list value equals its circle's data-value, a label
 * (symbol-label) belongs to a circle, and the group's data-crowded-pairs equals the pairs recomputed from the circles' drawn geometry.
 * With `expectedIso3` (from the data rows, a source independent of the SVG) the circle set must equal it, so a circle cannot be dropped
 * from circles and list together. Findings fail the render.
 */
/**
 * The optional focus_place of a symbol_map (a place the map is about that has no circle, e.g. the importer when the circles are its sources): kind
 * "none" (not set), "unresolved" (not a region of the base map), "has_circle" (it already has a circle, so no mark) or "mark" (a diamond is drawn there).
 * Lint, the renderer and render QA all read it from here, so they agree.
 */
export function symbolFocusStatus(spec, rows) {
  const place = spec?.focus_place;
  if (place === undefined || place === null || place === "") return { kind: "none" };
  const target = joinChoroplethRows([{ [spec.category_field]: place }], spec).find((item) => item.entry?.kind === "economy" && item.iso3 && item.featureIndices.length);
  if (!target) return { kind: "unresolved", place: String(place) };
  const drawn = joinChoroplethRows(rows ?? [], spec).some((item) => item.entry?.kind === "economy" && item.iso3 === target.iso3 && item.featureIndices.length && Number(item.row?.[spec.value_field]) > 0);
  return drawn ? { kind: "has_circle", iso3: target.iso3, place: String(place) } : { kind: "mark", iso3: target.iso3, place: String(place), featureIndices: target.featureIndices, raw: target.raw };
}

/** Lint text for a focus_place that cannot be used as asked (blocks) or is not drawn (advises); [] when there is nothing to say. */
export function symbolFocusLint(spec, rows) {
  const status = symbolFocusStatus(spec, rows);
  if (status.kind === "unresolved") return { errors: [`symbol_map focus_place '${status.place}' is not a region of the base map; name it the way category_names does, or drop focus_place`], warnings: [] };
  if (status.kind === "has_circle") return { errors: [], warnings: [`symbol_map focus_place '${status.place}' already has a circle; no focus mark is drawn`] };
  return { errors: [], warnings: [] };
}

export function checkSymbolMapList(svg, { expectedIso3, focus } = {}) {
  const failures = [];
  const text = String(svg);
  const circles = [];
  for (const tag of text.match(/<circle\b[^>]*data-role="symbol-circle"[^>]*>/g) ?? []) {
    circles.push({ id: attrOf(tag, "data-iso3"), value: numAttr(tag, "data-value"), x: numAttr(tag, "cx"), y: numAttr(tag, "cy"), r: Number((/\sr="([^"]*)"/.exec(tag) ?? [])[1]) });
  }
  const ids = circles.map((c) => c.id);
  if (new Set(ids).size !== ids.length) failures.push({ rule: "symbol-circle-duplicate" });
  const named = new Map(), valued = new Map();
  for (const tag of text.match(/<text\b[^>]*data-role="symbol-list-name"[^>]*>/g) ?? []) {
    const id = attrOf(tag, "data-iso3");
    if (named.has(id)) failures.push({ rule: "symbol-list-duplicate", iso3: id });
    named.set(id, true);
  }
  for (const tag of text.match(/<text\b[^>]*data-role="symbol-list-value"[^>]*>/g) ?? []) valued.set(attrOf(tag, "data-iso3"), numAttr(tag, "data-value"));
  for (const c of circles) {
    if (!named.has(c.id) || !valued.has(c.id)) failures.push({ rule: "symbol-list-missing", iso3: c.id });
    else if (valued.get(c.id) !== c.value) failures.push({ rule: "symbol-list-value-mismatch", iso3: c.id, want: c.value, got: valued.get(c.id) });
  }
  for (const id of new Set([...named.keys(), ...valued.keys()])) if (!ids.includes(id)) failures.push({ rule: "symbol-list-extra", iso3: id });
  for (const tag of text.match(/<text\b[^>]*data-role="symbol-label"[^>]*>/g) ?? []) {
    const id = attrOf(tag, "data-iso3");
    if (!ids.includes(id)) failures.push({ rule: "symbol-label-without-circle", iso3: id });
  }
  if (expectedIso3) {
    const want = new Set(expectedIso3);
    for (const id of want) if (!ids.includes(id)) failures.push({ rule: "symbol-circle-vs-rows-missing", iso3: id });
    for (const id of ids) if (!want.has(id)) failures.push({ rule: "symbol-circle-vs-rows-extra", iso3: id });
  }
  // the focus mark is a path, never a circle, and carries no data: a circle would be read back as a data value
  const marks = text.match(/<[a-zA-Z]+\b[^>]*data-role="focus-mark"[^>]*>/g) ?? [];
  for (const tag of marks) {
    if (!/^<path\b/.test(tag)) failures.push({ rule: "symbol-focus-mark-not-path" });
    if (/\bdata-(iso3|value|r)=/.test(tag)) failures.push({ rule: "symbol-focus-mark-has-data" });
  }
  if (marks.length > 1) failures.push({ rule: "symbol-focus-mark-duplicate" });
  if (focus !== undefined) {
    if (focus && marks.length === 0) failures.push({ rule: "symbol-focus-mark-missing", iso3: focus.iso3 });
    else if (focus && attrOf(marks[0], "data-focus") !== focus.iso3) failures.push({ rule: "symbol-focus-mark-wrong-place", want: focus.iso3, got: attrOf(marks[0], "data-focus") });
    else if (!focus && marks.length) failures.push({ rule: "symbol-focus-mark-unexpected" });
  }
  const groupTag = /<g\b[^>]*data-role="symbol-map-circles"[^>]*>/.exec(text)?.[0];
  const crowded = symbolCrowdedPairs(circles).map(([a, b]) => `${a}:${b}`);
  if (circles.length && !groupTag) failures.push({ rule: "symbol-circles-group-missing" });
  if (groupTag) {
    const recorded = (attrOf(groupTag, "data-crowded-pairs") ?? "").split(";").filter(Boolean);
    if ([...recorded].sort().join(";") !== [...crowded].sort().join(";")) failures.push({ rule: "symbol-crowded-pairs", want: crowded, got: recorded });
  }
  return { failures, circles: circles.length, listed: named.size, crowded, focusMarks: marks.length };
}

/**
 * The iso3 codes that carry a text label in world mode: the lowest and the
 * highest value (ties: smallest iso3) plus every row named in
 * highlight_values. `items` are joined, plottable rows. The renderer, the
 * lint and render QA all call this, so they agree on who is labelled.
 */
export function worldLabelIso3s(items, spec) {
  const out = new Set();
  const list = (items ?? []).filter((item) => item?.iso3 && Number.isFinite(Number(item.row?.[spec?.value_field])));
  if (!list.length) return out;
  const val = (item) => Number(item.row[spec.value_field]);
  const byValue = [...list].sort((a, b) => val(a) - val(b) || String(a.iso3).localeCompare(String(b.iso3), "en-US"));
  out.add(byValue[0].iso3);
  const top = val(byValue[byValue.length - 1]);
  out.add(byValue.find((item) => val(item) === top).iso3);
  const highlights = new Set((spec?.highlight_values ?? []).map(String));
  for (const item of list) if (highlights.has(String(item.row[spec.category_field]))) out.add(item.iso3);
  return out;
}

/**
 * World list mode: the iso3 codes that are printed in the list under the map - every plotted country that
 * worldLabelIso3s does not label on the map. `items` are joined, plottable rows; the renderer and render QA both
 * call this, QA with items it re-derived from the rows.
 */
export function worldListIso3s(items, spec) {
  const labelled = worldLabelIso3s(items, spec);
  const out = new Set();
  for (const item of items ?? []) {
    if (item?.iso3 && Number.isFinite(Number(item.row?.[spec?.value_field])) && !labelled.has(item.iso3)) out.add(item.iso3);
  }
  return out;
}

export function lintChoroplethSpec(spec, rows) {
  const blockers = [];
  const warnings = [];
  const categoryNames = spec?.category_names;
  // The modes that name a place: each resolves to an economy-table entry whose
  // iso3 keys into the basemap sidecar. A currency mode (iso4217) names no map
  // feature, so it is never a legal choropleth join key.
  const mapModes = ECONOMY_NAME_MODES;
  if (!mapModes.includes(categoryNames)) {
    const modeList = `${mapModes.slice(0, -1).map((mode) => `'${mode}'`).join(", ")} or '${mapModes[mapModes.length - 1]}'`;
    const currencyNote = categoryNames === "iso4217" ? "; 'iso4217' names a currency, which is not a map feature" : "";
    blockers.push(`choropleth requires category_names to be ${modeList}${currencyNote}`);
  }
  const rowList = Array.isArray(rows) ? rows : [];
  const world = isWorldExtent(spec);
  if (!world && rowList.length > 60) {
    blockers.push(`choropleth has ${rowList.length} rows; maximum is 60 - filter rows in SQL`);
    // K308 item 3: the refusal and the LIMIT warning below name the same allowed path (guidance only; the cap and its text are unchanged).
    blockers.push(`choropleth over the 60-row cap: ${WORLD_PATH_HINT()}`);
  }
  if (world && isRowSlice(spec)) blockers.push("choropleth map_extent 'world' needs every economy with data, but the SQL has a LIMIT - remove the LIMIT (or drop map_extent for a top-N slice)");
  if (!mapModes.includes(categoryNames) || !spec?.category_field) return { blockers, warnings };

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
  if (isUsStateMap(spec) && spec.chart_type !== "symbol_map") {
    // A symbol map may be sparse (a state with no circle is simply not drawn); a choropleth is not.
    // A US state map is the whole of the United States: a state with no row would be an unexplained blank on it.
    const have = new Set(joined.filter((item) => item.entry?.kind === "economy" && item.iso3).map((item) => item.iso3));
    const missing = usFeatureIndexList().map((index) => neFeatureAttributes(index)).filter((attrs) => attrs && !have.has(attrs.iso3)).map((attrs) => attrs.name);
    if (missing.length) {
      blockers.push(`choropleth category_names 'us_state' needs a row for every state and DC, but ${missing.length} of 51 ${missing.length === 1 ? "has" : "have"} none: ${missing.slice(0, 8).join(", ")}`);
    }
  }
  if (world) {
    const labelled = worldLabelIso3s(joined.filter((item) => item.entry?.kind === "economy" && item.iso3 && item.featureIndices.length && Number.isFinite(Number(item.row?.[spec.value_field]))), spec);
    if (labelled.size > WORLD_LABEL_MAX) {
      blockers.push(`choropleth map_extent 'world' labels at most ${WORLD_LABEL_MAX} features (the range ends plus highlight_values) but ${labelled.size} would be labelled - shorten highlight_values`);
    }
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
  if (isRowSlice(spec)) {
    warnings.push(world
      ? "choropleth rows come from a LIMIT query, so the map covers only a top-N slice while the source has more economies; map every economy with data and use a bar chart for a top list"
      : `choropleth rows come from a LIMIT query, so the map covers only a top-N slice while the source has more economies; map every economy with data and use a bar chart for a top list. ${WORLD_PATH_HINT()}`);
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

// ---------------------------------------------------------------------------
// Projection choice (diagnosis P1). The azimuthal projection above can only
// show points within a 90-degree horizon of its centre, and the bbox midpoint
// of data that straddles the antimeridian (e.g. New Zealand plus Europe) is a
// useless centre, so rings used to be dropped whole. The choice is made from
// the data's real spherical extent, never from a lon/lat bbox midpoint alone:
//   1. the bbox centre, when every data point is within AZIMUTHAL_FIT_DEG of
//      it (unchanged framing for every map that already fitted);
//   2. else the centre of the (approximate) minimal enclosing spherical cap,
//      when its radius is within AZIMUTHAL_FIT_DEG;
//   3. else a world projection (Equal Earth, central meridian 0 - the vendored
//      basemap is already cut at +/-180, so no ring needs splitting).
export const AZIMUTHAL_FIT_DEG = 80;

function toUnit(lon, lat) {
  const l = lon * DEG2RAD, p = lat * DEG2RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}
function fromUnit([x, y, z]) {
  return [Math.atan2(y, x) * RAD2DEG, Math.atan2(z, Math.hypot(x, y)) * RAD2DEG];
}
function normalizeVec(v) {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}

/** Approximate minimal enclosing spherical cap of [lon, lat] points: { lon, lat, radiusDeg }. */
export function enclosingCap(points) {
  const pts = (points ?? []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return { lon: 0, lat: 0, radiusDeg: 0 };
  const vecs = pts.map(([lon, lat]) => toUnit(lon, lat));
  // Badoiu-Clarkson style iteration on the sphere, seeded from the mean
  // direction; deterministic and plenty accurate for a framing decision.
  let c = normalizeVec(vecs.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]));
  if (!Number.isFinite(c[0])) c = vecs[0];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let i = 1; i <= 400; i++) {
    let far = vecs[0], best = Infinity;
    for (const v of vecs) { const d = dot(c, v); if (d < best) { best = d; far = v; } }
    const t = 1 / (i + 1);
    c = normalizeVec([c[0] + (far[0] - c[0]) * t, c[1] + (far[1] - c[1]) * t, c[2] + (far[2] - c[2]) * t]);
  }
  let minDot = 1;
  for (const v of vecs) minDot = Math.min(minDot, dot(c, v));
  const [lon, lat] = fromUnit(c);
  return { lon, lat, radiusDeg: Math.acos(Math.max(-1, Math.min(1, minDot))) * RAD2DEG };
}

function maxAngularDistance(points, lon0, lat0) {
  let max = 0;
  for (const [lon, lat] of points) max = Math.max(max, angularDistanceDeg(lon, lat, lon0, lat0));
  return max;
}

/** Decide the main-map projection for a set of data points: { kind: "azimuthal"|"world", lon0, lat0 }. */
export function chooseMapProjection(points) {
  const pts = points && points.length ? points : [[0, 0]];
  const [bLon, bLat] = bboxCenter(pts);
  if (maxAngularDistance(pts, bLon, bLat) <= AZIMUTHAL_FIT_DEG) return { kind: "azimuthal", lon0: bLon, lat0: bLat };
  const cap = enclosingCap(pts);
  if (cap.radiusDeg <= AZIMUTHAL_FIT_DEG) return { kind: "azimuthal", lon0: cap.lon, lat0: cap.lat };
  return { kind: "world", lon0: 0, lat0: bLat };
}

// Equal Earth (Savric, Patterson, Jenny 2018): equal-area like the azimuthal
// projection above, so colour density stays honest on a world-scale map.
const EQE_A1 = 1.340264, EQE_A2 = -0.081106, EQE_A3 = 0.000893, EQE_A4 = 0.003796;
const EQE_M = Math.sqrt(3) / 2;
function equalEarthForward(lon, lat) {
  const l = lon * DEG2RAD;
  const t = Math.asin(EQE_M * Math.sin(lat * DEG2RAD));
  const t2 = t * t, t6 = t2 * t2 * t2;
  const x = (2 * Math.sqrt(3) * l * Math.cos(t)) / (3 * (9 * EQE_A4 * t6 * t2 + 7 * EQE_A3 * t6 + 3 * EQE_A2 * t2 + EQE_A1));
  const y = t * (EQE_A1 + EQE_A2 * t2 + t6 * (EQE_A3 + EQE_A4 * t2));
  return [x, y];
}

/** Equal Earth fitted to a pixel rect (same contract as fitAzimuthalProjection: scale/centre/flip-y, padded). */
export function fitWorldProjection(points, left, right, top, bottom, paddingRatio = 0.08) {
  const projected = (points ?? []).map(([lon, lat]) => equalEarthForward(lon, lat)).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const xs = projected.length ? projected.map((p) => p[0]) : [-1, 1];
  const ys = projected.length ? projected.map((p) => p[1]) : [-1, 1];
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const w = Math.max(1e-9, xmax - xmin), h = Math.max(1e-9, ymax - ymin);
  const pad = Math.max(0, Number(paddingRatio) || 0);
  const scale = Math.min(Math.max(1, right - left) / (w * (1 + 2 * pad)), Math.max(1, bottom - top) / (h * (1 + 2 * pad)));
  const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
  const midX = (left + right) / 2, midY = (top + bottom) / 2;
  return {
    lon0: 0,
    lat0: 0,
    scale,
    world: true,
    project(lon, lat) {
      const [x, y] = equalEarthForward(lon, lat);
      return { x: midX + (x - cx) * scale, y: midY - (y - cy) * scale };
    },
  };
}

/** Fit whichever projection chooseMapProjection picked to a pixel rect. */
export function fitMapProjection(choice, points, left, right, top, bottom, paddingRatio = 0.08) {
  if (choice.kind === "us") return fitUsProjection(points, left, right, top, bottom, paddingRatio);
  return choice.kind === "world"
    ? fitWorldProjection(points, left, right, top, bottom, paddingRatio)
    : fitAzimuthalProjection(choice.lon0, choice.lat0, points, left, right, top, bottom, paddingRatio);
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

/**
 * The rings of one region that should drive map framing. A region that owns a
 * small, distant outlier (an island group across the ocean from the mainland,
 * or on the far side of the antimeridian) would otherwise stretch the framed
 * extent across the whole ocean and leave most of the map blank. A ring is
 * dropped only when it is both tiny next to the region's largest ring and far
 * from it.
 *
 * COVERAGE CONTRACT: this function decides the FRAME only. The dropped rings
 * are still part of the region's geometry (colour, joins and coverage checks
 * use all of it), but any dropped ring that then falls outside the frame is
 * clipped away. omittedFramingRings() names exactly those rings so the
 * renderer can say so in the chart note; nothing is clipped without that note.
 */
export function framingRings(rings, { tinyShare = 0.05, farDeg = 15 } = {}) {
  const boxes = (rings ?? []).map((ring) => {
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    for (const [lon, lat] of ring) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
    return { ring, area: Math.max(0, e - w) * Math.max(0, n - s), lon: (w + e) / 2, lat: (s + n) / 2 };
  }).filter((b) => b.ring.length && Number.isFinite(b.area));
  if (boxes.length < 2) return boxes.map((b) => b.ring);
  const main = boxes.reduce((best, b) => (b.area > best.area ? b : best));
  return boxes
    .filter((b) => b === main || b.area >= main.area * tinyShare || angularDistanceDeg(b.lon, b.lat, main.lon, main.lat) <= farDeg)
    .map((b) => b.ring);
}

/** The rings framingRings() leaves out of the frame (same options). */
export function omittedFramingRings(rings, opts) {
  const kept = new Set(framingRings(rings, opts));
  return (rings ?? []).filter((ring) => ring?.length && !kept.has(ring));
}

/**
 * Omitted rings that are big enough to see (bbox >= minAreaDeg deg^2) and lie
 * wholly outside `rect` once projected: the territories that framing would
 * otherwise clip without a word. `project(lon, lat)` -> {x, y}.
 */
export function clippedFramingRings(rings, project, rect, { minAreaDeg = 1 } = {}) {
  return omittedFramingRings(rings).filter((ring) => ringBBoxAreaDeg(ring) >= minAreaDeg && !ring.some(([lon, lat]) => {
    const p = project(lon, lat);
    return Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
  }));
}

/** Lon/lat bbox area (deg^2) of a ring. */
export function ringBBoxAreaDeg(ring) {
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const [lon, lat] of ring ?? []) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
  return Number.isFinite(w) ? Math.max(0, e - w) * Math.max(0, n - s) : 0;
}

/** True when every point of `ring` is within `limitDeg` of the projection centre. */
export function ringWithinHorizon(ring, lon0, lat0, limitDeg = 90) {
  if (lat0 === null) return true; // world projection: nothing lies beyond a horizon
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
export function niceBreaks(min, max, classes = 5, opts = {}) {
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
      // integer data (counts, calendar years): whole-number steps only, so
      // no legend edge reads 1.2 / 1.4
      if (opts?.integer && (step < 1 || !Number.isInteger(step))) continue;
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

/**
 * Class edges for a choropleth. Unskewed data keeps niceBreaks' linear nice
 * edges (unchanged). Right-skewed data (max at least 2.5x the 90th
 * percentile, so one or two extreme values would leave nearly every region
 * in the lightest equal-interval class) gets 1-2-5 geometric edges sized to
 * the bulk of the data instead: the smallest 1-2-5 number at or above the
 * 90th percentile closes the second-to-last class, and the three 1-2-5
 * numbers below it open the others; the first class is open below and the
 * last is open above (classifyValue already clamps into the end classes).
 * Returns { breaks, skewed, openBottom, openTop }; `breaks` always has
 * classes+1 ascending entries, the outer two being the data min and max.
 */
export function classBreaks(values, classes = 5, opts = {}) {
  const nums = (values ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const min = nums.length ? nums[0] : 0;
  const max = nums.length ? nums[nums.length - 1] : 1;
  const linear = { breaks: niceBreaks(min, max, classes, opts), skewed: false, openBottom: false, openTop: false };
  if (opts?.integer || classes !== 5 || nums.length < 6) return linear;
  const q = (p) => { const pos = (nums.length - 1) * p; const lo = Math.floor(pos); return nums[lo] + (nums[Math.min(lo + 1, nums.length - 1)] - nums[lo]) * (pos - lo); };
  const p90 = q(0.9);
  if (!(p90 > 0) || !(max >= 2.5 * p90)) return linear;
  const seq = [];
  for (let power = -6; power <= 12; power++) for (const f of [1, 2, 5]) seq.push(f * 10 ** power);
  const topIdx = seq.findIndex((v) => v >= p90 - 1e-12);
  if (topIdx < 3) return linear;
  const inner = seq.slice(topIdx - 3, topIdx + 1).map((v) => Math.round(v * 1e9) / 1e9);
  // the edges must rise strictly from the data minimum to the maximum, else the first class would be empty
  if (!(min < inner[0] && inner[3] < max)) return linear;
  return { breaks: [min, ...inner, max], skewed: true, openBottom: true, openTop: true };
}

// K309: NEWSROOM_SIGNED_SCALE=1 (exact "1", default off): a coloured value column that holds both signs gets one shared signed scale
// (choropleth classes and heatmap cells alike) instead of the one-way ramp, where the largest loss sat in the lightest class.
// Zero is the class edge between the two sides; both sides share the same magnitude classes (classBreaks on |v|, so the
// skewed 1-2-5 edges still apply), so a dot or tint of one size means the same |v| on either side; the classes next to zero are the
// lightest. A side keeps only the classes up to its own largest |v|, so there are at most 5 + 5 classes (the limit is 11).
export function signedScaleEnabled() {
  return process.env.NEWSROOM_SIGNED_SCALE === "1";
}
export function signedScaleCheckEnabled() { return process.env.NEWSROOM_SIGNED_SCALE_CHECK === "1" || process.env.NEWSROOM_SIGNED_SCALE === "1"; }
export function hasBothSigns(values) {
  let neg = false, pos = false;
  for (const v of values ?? []) { if (!Number.isFinite(v)) continue; if (v < 0) neg = true; else if (v > 0) pos = true; }
  return neg && pos;
}
export const SIGNED_SCALE_MAX_CLASSES = 11;
/**
 * signedClassPlan(values, { integer, neg, pos, neutral }): { breaks, classes, magnitude, skewed, colorOf(value) }.
 * `breaks` are ascending edges with 0 among them (classifyValue works on them unchanged; 0 itself falls in the first class above zero).
 * Each class: { sign: "neg" | "pos", level (0 next to zero .. 1 at the largest magnitude class), rgb, fill, lo, hi, openOuter }.
 * Fills mix the neutral light grey toward the side's colour (`neg` / `pos`, [r, g, b] from the existing palette tokens).
 */
export function signedClassPlan(values, opts = {}) {
  const nums = (values ?? []).map(Number).filter(Number.isFinite);
  const mags = nums.filter((v) => v !== 0).map(Math.abs);
  let plan = mags.length ? classBreaks(mags, 5, { integer: opts.integer }) : { breaks: [0, 1], skewed: false };
  // Magnitudes over at least one power of ten that classBreaks did not already treat as skewed: 1-2-5 edges between the smallest and the
  // largest |v| (the same edge family as the skewed branch), else almost every value would sit in the class next to zero.
  const minMag = mags.length ? Math.min(...mags) : 0, maxMag = mags.length ? Math.max(...mags) : 1;
  if (!plan.skewed && !opts.integer && minMag > 0 && maxMag >= 10 * minMag) {
    const seq = [];
    for (let power = -6; power <= 12; power++) for (const f of [1, 2, 5]) { const v = Math.round(f * 10 ** power * 1e9) / 1e9; if (v > minMag && v < maxMag) seq.push(v); }
    const inner = seq.length <= 4 ? seq : [0, 1, 2, 3].map((i) => seq[Math.round((i * (seq.length - 1)) / 3)]);
    if (inner.length >= 2) plan = { breaks: [minMag, ...inner, maxMag], skewed: true };
  }
  const edges = plan.breaks.slice();
  edges[0] = 0;
  const magnitude = edges.filter((v, i) => i === 0 || v > edges[i - 1]);
  const steps = magnitude.length - 1;
  const negMax = Math.max(0, ...nums.filter((v) => v < 0).map(Math.abs));
  const posMax = Math.max(0, ...nums.filter((v) => v >= 0));
  const used = (m) => (m > 0 ? classifyValue(m, magnitude) + 1 : 0);
  const nNeg = used(negMax), nPos = Math.max(1, used(posMax));
  const neutral = opts.neutral ?? [242, 243, 244];
  const mixTo = (target, t) => neutral.map((v, i) => Math.round(v + ((target ?? neutral)[i] - v) * t));
  const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const tint = (k) => (steps <= 1 ? 1 : 0.22 + 0.78 * (k / (steps - 1)));
  const classes = [];
  for (let k = nNeg - 1; k >= 0; k--) classes.push({ sign: "neg", level: steps <= 1 ? 1 : k / (steps - 1), rgb: mixTo(opts.neg, tint(k)), fill: css(mixTo(opts.neg, tint(k))), lo: -magnitude[k + 1], hi: k === 0 ? 0 : -magnitude[k], openOuter: Boolean(plan.skewed) && k === steps - 1 });
  for (let k = 0; k < nPos; k++) classes.push({ sign: "pos", level: steps <= 1 ? 1 : k / (steps - 1), rgb: mixTo(opts.pos, tint(k)), fill: css(mixTo(opts.pos, tint(k))), lo: magnitude[k], hi: magnitude[k + 1], openOuter: Boolean(plan.skewed) && k === steps - 1 });
  const breaks = [...classes.map((c) => c.lo), classes[classes.length - 1].hi].map((v) => (v === 0 ? 0 : v));
  return { breaks, classes, magnitude, skewed: Boolean(plan.skewed), colorOf: (value) => classes[classifyValue(value, breaks)] };
}

/**
 * True when the rows look like a LIMIT slice of a larger source: the grey
 * features then have data, they just were not selected. The lint warning and
 * the "no data" swatch both read this one condition.
 */
export function isRowSlice(spec) {
  return /\blimit\s+\d+/i.test(String(spec?.sql ?? ""));
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

// NEWSROOM_CHOROPLETH_NORMALIZED (default on; "0" turns it off): a choropleth colours regions, so a total
// (people, tonnes, PJ) mostly redraws how big each region is. The value column must be a ratio, share or
// per-capita figure. The program reads that from DuckDB's own parse of the plan SQL (json_serialize_sql), not
// from what the model says about it: a division whose divisor is data counts; a constant divisor, a divisor
// made of the numerator's own columns (a / a, a / (1.0 * a)) and a constant hidden in a CTE do not; (a - b) / b does. A column
// taken straight from the file has no arithmetic to read, so it passes only when measure_semantics gives
// measure_kind rate or share AND a denominator AND the unit text names a ratio (mean, median and index have their own rule below); a declaration never lets a division by a constant, a total or the column itself through, nor a sum or count that is not divided by data.
const NORMALIZED_UNIT = /[%％‰‱]|每\s*(?:\d|[十百千万亿]|人|户|平方)|人均|户均|占比|比率|比例|\bper\s+(?:\d|capita|person|people|household|thousand|million|square|km|sq)|\/\s*(?:人|户|capita|person|people|household|km|平方公里|\d)/i;
// Closed word list for the unit of an index (measure_kind 'index'): the unit text must name an index or a score.
const INDEX_UNIT = /指[数數]|\bindex\b|\bindices\b|(?:^|[^A-Za-z])(?:19|20)\d\d\s*=\s*100\b|基期|\bscore\b|评分|得分|\brating\b/i;
const MEAN_FUNCTIONS = new Set(["avg", "mean", "favg"]);
const MEDIAN_FUNCTIONS = new Set(["median", "quantile", "quantile_cont", "quantile_disc", "approx_quantile"]);
const TOTAL_KINDS = new Set(["count", "stock", "flow", "cumulative", "capacity"]);
const DIVIDE_FUNCTIONS = new Set(["/", "//", "divide", "fdiv"]);
const isAstNode = (value) => value !== null && typeof value === "object";

function astWalk(node, visit) {
  if (Array.isArray(node)) { node.forEach((child) => astWalk(child, visit)); return; }
  if (!isAstNode(node)) return;
  visit(node);
  for (const child of Object.values(node)) astWalk(child, visit);
}

function topSelect(ast) {
  const node = ast?.statements?.[0]?.node;
  return node?.type === "SELECT_NODE" ? node : null;
}

const OTHER_ROW_WINDOWS = new Set(["lag", "lead", "first_value", "last_value", "nth_value", "first", "last"]);
// What makes a value a total: sum and count in any spelling. avg, median, min and max of a column are read as that column passing through.
const TOTAL_AGGREGATES = new Set(["sum", "count", "count_star", "fsum", "kahan_sum", "sumkahan", "sum_no_overflow", "total", "count_if", "countif", "approx_count_distinct", "bool_or_count"]);
// A total built from a list: list_sum(list(x)), list_count, list_reduce, list_aggregate, and len/array_length/cardinality over a list that an aggregate just collected.
const LIST_TOTAL_FUNCTIONS = new Set(["list_sum", "list_count", "list_reduce", "list_aggregate", "array_aggregate", "list_sumkahan", "list_fsum", "list_kahan_sum", "array_reduce"]);
const LIST_LENGTH_FUNCTIONS = new Set(["len", "length", "array_length", "list_length", "cardinality", "array_len", "list_len"]);
const LIST_BUILDERS = new Set(["list", "array_agg", "list_agg", "array_agg_distinct", "histogram", "list_distinct", "array_distinct", "list_unique", "array_unique"]);
const AGGREGATES = new Set(["sum", "avg", "count", "min", "max", "median", "mean", "first", "last", "any_value", "arbitrary", "string_agg"]);

function containsAggregate(expr) {
  let found = false;
  astWalk(expr, (node) => { const name = String(node.function_name ?? "").toLowerCase(); if (node.class === "FUNCTION" && !node.is_operator && (AGGREGATES.has(name) || TOTAL_AGGREGATES.has(name) || isListTotal(node))) found = true; });
  return found;
}

function cteColumns(select) {
  // alias -> expression, over every CTE of the statement; an alias defined twice is not resolved (ambiguous).
  // A CTE column that aggregates without GROUP BY is one number for every row (marked __scalar).
  const seen = new Map();
  astWalk([select?.cte_map, select?.from_table], (node) => {
    if (node.type !== "SELECT_NODE" || !Array.isArray(node.select_list)) return;
    const grouped = Array.isArray(node.group_expressions) && node.group_expressions.length > 0;
    for (const item of node.select_list) {
      if (!item?.alias) continue;
      const key = String(item.alias).toLowerCase();
      seen.set(key, seen.has(key) ? null : { ...item, __scalar: !grouped && containsAggregate(item) });
    }
  });
  // Qualifiers that name a real table: a BASE_TABLE (by alias or name) that is not a CTE of this statement.
  const cteNames = new Set((select?.cte_map?.map ?? []).map((entry) => String(entry?.key ?? "").toLowerCase()));
  const real = new Set();
  astWalk(select, (node) => {
    if (node.type !== "BASE_TABLE") return;
    const name = String(node.table_name ?? "").toLowerCase();
    if (!cteNames.has(name)) { if (name) real.add(name); if (node.alias) real.add(String(node.alias).toLowerCase()); }
  });
  seen.realTables = real;
  return seen;
}

function lastName(expr) {
  const names = expr?.column_names;
  return Array.isArray(names) && names.length ? String(names[names.length - 1]).toLowerCase() : null;
}

// A column that names a CTE column is replaced by that column's own expression (a few levels), so a constant
// or a division defined in a CTE is seen where it is used.
function inlineCte(expr, ctes, depth = 0) {
  if (Array.isArray(expr)) return expr.map((child) => inlineCte(child, ctes, depth));
  if (!isAstNode(expr) || depth > 4) return expr;
  if (expr.class === "COLUMN_REF") {
    const names = Array.isArray(expr.column_names) ? expr.column_names : [];
    // A bare name or a name qualified by a CTE or derived table is that column; a name qualified by a real table is the table's own column, even when a CTE column has the same name.
    const def = names.length === 1 || !ctes.realTables?.has(String(names[names.length - 2]).toLowerCase()) ? ctes.get(lastName(expr)) : null;
    return def ? inlineCte(def, ctes, depth + 1) : expr;
  }
  const out = {};
  for (const [key, value] of Object.entries(expr)) out[key] = key === "subquery" ? value : inlineCte(value, ctes, depth);
  return out;
}

// Column references as "qualifier.name" (or "name" when written bare), so a.cpi and b.cpi of a self-join are two columns.
function columnRefs(expr, out = new Set()) {
  astWalk(expr, (node) => {
    if (node.class !== "COLUMN_REF") return;
    const names = Array.isArray(node.column_names) ? node.column_names.map((part) => String(part).toLowerCase()) : [];
    if (names.length) out.add(names.slice(-2).join("."));
  });
  return out;
}

function sameColumn(left, right) {
  const [leftName, leftQualifier] = left.split(".").reverse();
  const [rightName, rightQualifier] = right.split(".").reverse();
  return leftName === rightName && (!leftQualifier || !rightQualifier || leftQualifier === rightQualifier);
}

// Self-division: numerator and divisor read exactly the same single column (a / a, a / (1.0 * a), a / (a + a)).
// (a - b) / b, SUM(CASE WHEN c THEN x END) / SUM(x) and a.cpi / b.cpi read different column sets and are ratios.
function sameColumnSet(left, right) {
  const leftRefs = [...left];
  const rightRefs = [...right];
  return leftRefs.every((ref) => rightRefs.some((other) => sameColumn(ref, other))) && rightRefs.every((ref) => leftRefs.some((other) => sameColumn(ref, other)));
}

function ownTables(node, out = new Set()) {
  astWalk(node, (n) => {
    if (n.type === "BASE_TABLE") { if (n.table_name) out.add(String(n.table_name).toLowerCase()); }
    if (n.alias && (n.type === "BASE_TABLE" || n.type === "SUBQUERY" || n.type === "TABLE_FUNCTION")) out.add(String(n.alias).toLowerCase());
  });
  return out;
}

// A subquery is correlated when it names a column through a table that is not one of its own.
function isCorrelated(sub, region) {
  const own = ownTables(sub.subquery?.node);
  let outer = false;
  astWalk(sub.subquery?.node, (n) => {
    if (n.class === "COLUMN_REF" && Array.isArray(n.column_names) && n.column_names.length > 1 && !own.has(String(n.column_names[0]).toLowerCase()) && (!region || lastName(n) === region)) outer = true;
  });
  return outer;
}

// What a divisor offers: the data columns it reads that differ from row to row, and whether anything in it
// follows the region (a correlated subquery, a window partitioned by something). A scalar total (a sum over
// all rows, a subquery with no link to the outer row, a window over everything) is one number for every
// region, so it is a constant: dividing by it only shrinks the totals in proportion.
function divisorSignals(expr, grouped, region) {
  const refs = new Set();
  let varies = false;
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isAstNode(node)) return;
    if (node.__scalar) return;
    if (node.class === "WINDOW") {
      // A window that partitions by the region (a share within the region) or reads another row (LAG, LEAD, FIRST_VALUE) follows the region; OVER () and a sum or count over other partitions give one number for everyone.
      if (OTHER_ROW_WINDOWS.has(String(node.function_name ?? "").toLowerCase()) || (Array.isArray(node.partitions) && node.partitions.some((part) => !region || lastName(part) === region))) varies = true;
      return;
    }
    if (node.class === "SUBQUERY") { if (isCorrelated(node, region)) varies = true; return; }
    if (node.class === "FUNCTION" && !node.is_operator && AGGREGATES.has(String(node.function_name ?? "").toLowerCase()) && !grouped) return;
    if (node.class === "COLUMN_REF") { columnRefs(node, refs); return; }
    Object.values(node).forEach(visit);
  };
  visit(expr);
  return { refs, varies };
}

function isDivision(node) {
  return node.class === "FUNCTION" && DIVIDE_FUNCTIONS.has(String(node.function_name ?? "").toLowerCase()) && Array.isArray(node.children) && node.children.length === 2;
}

function isDataDivision(node, ctes, grouped, region) {
  if (!isDivision(node)) return false;
  const numerator = inlineCte(node.children[0], ctes);
  const divisor = inlineCte(node.children[1], ctes);
  const top = columnRefs(numerator);
  const { refs, varies } = divisorSignals(divisor, grouped, region);
  if (varies) return true;
  if (!refs.size) return false; // a constant, a scalar total, however it is written
  return !(refs.size === 1 && sameColumnSet(top, refs)); // a / a, a / (1.0 * a), a / (a * 1) divide the one column by itself; (a - b) / b and (a - b) / (a + b) read two columns
}

function namedFunction(node, names) {
  return node?.class === "FUNCTION" && !node.is_operator && names.has(String(node.function_name ?? "").toLowerCase());
}

function unwrapCast(node) {
  if (node?.class === "CAST" && node.child) return unwrapCast(node.child);
  if (namedFunction(node, new Set(["nullif"])) && node.children?.length === 2) return unwrapCast(node.children[0]); // SUM(x) / NULLIF(COUNT(*), 0)
  return node;
}

// A mean per region written as SUM(x) / COUNT(...) in a grouped select: both aggregates belong to the same group. A window, a
// subquery, or a total over the whole table (a CTE aggregate without GROUP BY, marked __scalar) anywhere in it is not a mean per region.
function isMeanRatio(node, grouped) {
  if (!grouped || !isDivision(node)) return false;
  const [numerator, divisor] = node.children;
  if (!namedFunction(unwrapCast(divisor), new Set(["count", "count_star"]))) return false;
  let sum = false;
  let foreign = false;
  astWalk([numerator, divisor], (n) => {
    if (n.class === "WINDOW" || n.class === "SUBQUERY" || n.__scalar) foreign = true;
    if (namedFunction(n, TOTAL_AGGREGATES) && !["count", "count_star"].includes(String(n.function_name).toLowerCase())) sum = true;
  });
  return sum && !foreign;
}

function isListTotal(node) {
  if (node.class !== "FUNCTION" || node.is_operator) return false;
  const name = String(node.function_name ?? "").toLowerCase();
  if (LIST_TOTAL_FUNCTIONS.has(name)) return true;
  if (!LIST_LENGTH_FUNCTIONS.has(name)) return false;
  let built = false;
  astWalk(node.children, (n) => { if (n.class === "FUNCTION" && !n.is_operator && LIST_BUILDERS.has(String(n.function_name ?? "").toLowerCase())) built = true; });
  return built;
}

// A sum or count (plain or as a window) that is not inside a division by data: that part of the value is a total.
function hasTotalAggregate(expr, ctes, grouped, region) {
  let found = false;
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!isAstNode(node) || found) return;
    if (isMeanRatio(node, grouped) || isDataDivision(node, ctes, grouped, region)) return;
    if ((node.class === "FUNCTION" || node.class === "WINDOW") && !node.is_operator && TOTAL_AGGREGATES.has(String(node.function_name ?? "").toLowerCase())) { found = true; return; }
    if (isListTotal(node)) { found = true; return; }
    Object.values(node).forEach(visit);
  };
  visit(expr);
  return found;
}

function valueExpression(select, valueField, ctes) {
  const wanted = String(valueField ?? "").toLowerCase();
  for (const item of select?.select_list ?? []) {
    const name = item?.alias ? String(item.alias).toLowerCase() : lastName(item);
    if (name === wanted) return inlineCte(item, ctes);
  }
  return null;
}

function valueMeasure(spec) {
  const entries = Array.isArray(spec?.measure_semantics) ? spec.measure_semantics : [];
  return entries.find((entry) => entry?.field === spec?.value_field || entry?.id === spec?.value_field) ?? (entries.length === 1 ? entries[0] : null);
}

/** Refusals for a choropleth whose value column is a total. `ast` is json_serialize_sql of the plan SQL (null when it could not be parsed). */
export function lintChoroplethNormalized(ast, spec) {
  const measure = valueMeasure(spec);
  const kind = String(measure?.measure_kind ?? spec?.measure_kind ?? "");
  const select = topSelect(ast);
  const ctes = select ? cteColumns(select) : new Map();
  const expr = select ? valueExpression(select, spec?.value_field, ctes) : null;
  const grouped = Array.isArray(select?.group_expressions) && select.group_expressions.length > 0;
  const region = spec?.category_field ? String(spec.category_field).toLowerCase() : null;
  let divided = false;
  let anyDivision = false;
  let meanRatio = false;
  let meanAgg = false;
  let medianAgg = false;
  if (expr) astWalk(expr, (node) => {
    if (isMeanRatio(node, grouped)) meanRatio = true;
    else if (isDataDivision(node, ctes, grouped, region)) divided = true;
    else if (isDivision(node)) anyDivision = true;
    if (namedFunction(node, MEAN_FUNCTIONS)) meanAgg = true;
    if (namedFunction(node, MEDIAN_FUNCTIONS)) medianAgg = true;
  });
  const field = String(spec?.value_field ?? "the value column");
  const fix = "A choropleth colours regions, so a total mostly shows which region is bigger, and dividing by one total (a sum over all rows) or by a constant does not change that. Map a ratio, share or per-capita figure whose divisor is a data column that differs by region (e.g. SELECT deaths / population * 100000 AS rate FROM t), and declare it in measure_semantics with measure_kind rate or share, a denominator (the divisor in words, e.g. 'population' or 'price level a year earlier') and a unit such as % or per 100,000; for an average, median or index by region declare measure_kind mean, median or index with a denominator (what it is averaged over, or the index base) and a unit; for totals use horizontal_bar (a ranked bar chart)";
  const totalText = `choropleth value '${field}' is a sum or a count (a total) and is not divided by a column that differs by region; a declaration of rate or share does not change what the SQL computes. ${fix}`;
  // A constant, total or self division anywhere in the value is refused even when another part of it divides by data.
  if (divided && !anyDivision) {
    if (TOTAL_KINDS.has(kind)) return [`choropleth value '${field}' is a division in SQL but measure_semantics declares measure_kind '${kind}', a total; declare 'rate' or 'share' with its denominator, or stop dividing. ${fix}`];
    return hasTotalAggregate(expr, ctes, grouped, region) ? [totalText] : [];
  }
  // The whole statement is searched for a constant division only when the value column could not be found; a constant division in a WHERE does not touch a column that is read as it is.
  if (!expr && ast) astWalk(ast, (node) => { if (isDivision(node) && !isDataDivision(node, ctes, grouped, region)) anyDivision = true; });
  // A division whose divisor is a constant, a scalar total or the column itself is not rescued by a declaration.
  if (anyDivision) return [`choropleth value '${field}' divides by something that does not differ by region (a constant, one total over all rows, or the value's own column), so it is still a total on another scale. ${fix}`];
  // A sum or count that is not divided per region is a total, whatever measure_semantics says about it.
  if (expr && hasTotalAggregate(expr, ctes, grouped, region)) return [totalText];
  // An average per region: SUM(x) / COUNT(...) of one group is read as a mean and needs measure_kind 'mean'; AVG and MEDIAN of a column must not contradict the declared kind.
  if (meanRatio && kind !== "mean") return [`choropleth value '${field}' is an average per region (SUM / COUNT of one group); declare measure_kind 'mean' with a denominator (what it is averaged over) and a unit, not '${kind || "none"}'. ${fix}`];
  if ((meanAgg && !medianAgg && kind === "median") || (medianAgg && !meanAgg && kind === "mean")) return [`choropleth value '${field}' is computed as a ${medianAgg && !meanAgg ? "median" : "mean"} in SQL but measure_semantics declares measure_kind '${kind}'; declare what the SQL computes. ${fix}`];
  const denominator = String(measure?.denominator ?? "").trim();
  const units = [measure?.unit, spec?.unit].map((text) => String(text ?? "").trim()).filter(Boolean);
  const missing = [];
  if (!["rate", "share", "mean", "median", "index"].includes(kind)) missing.push(`measure_kind 'rate', 'share', 'mean', 'median' or 'index' (declared: ${kind || "none"})`);
  if (!denominator) missing.push(kind === "index" ? "a denominator in measure_semantics naming the base of the index (e.g. '2015 = 100')" : kind === "mean" || kind === "median" ? "a denominator in measure_semantics naming what the value is averaged over" : "a denominator in measure_semantics");
  if (kind === "mean" || kind === "median") { if (!units.length) missing.push(`a unit (e.g. °C) for the ${kind}`); }
  else if (kind === "index") { if (!units.some((text) => INDEX_UNIT.test(text))) missing.push(`a unit that names an index or a score such as 指数, index, =100 (declared: ${units.join(" / ") || "none"})`); }
  else if (!units.some((text) => NORMALIZED_UNIT.test(text))) missing.push(`a unit that names a ratio such as %, per 100,000 or 人均 (declared: ${units.join(" / ") || "none"})`);
  if (!missing.length) return [];
  return [`choropleth value '${field}' is not shown to be a ratio: its SQL has no division by data that was found${expr ? " (the check reads the final SELECT, its WITH clauses and derived tables in FROM)" : " (the value column was not found in the final SELECT)"} and it lacks ${missing.join("; ")}. ${fix}`];
}
