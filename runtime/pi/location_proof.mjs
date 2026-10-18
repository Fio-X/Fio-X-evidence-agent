// The switch NEWSROOM_LOCATION_EVIDENCE (default off) and the page-level rule over location evidence; no imports, so a reader of it does not load the basemaps.
// A page's locations count as proven only when every map module of the page has location evidence that checked out (location_evidence.mjs).
export function locationEvidenceEnabled(env = process.env) { return env.NEWSROOM_LOCATION_EVIDENCE === "1"; }

// The chart types that count as a map on a page. Only choropleth can have evidence; a coordinate map on the page keeps the proof from holding.
export const LOCATION_MAP_CHARTS = Object.freeze(["geo_flow_map", "cartographic_flow_map", "choropleth"]);

/**
 * True when the page has at least one map module and every map module's evidence passed.
 * modules: the plan's modules; checks: { [module id]: { chart_type, ok } } from the manifests.
 * A module is a map if its check says so, or the plan names it a map chart or a spatial module; a map module with no check entry is unproven.
 */
export function locationProofFor(modules = [], checks = {}) {
  const isMap = (m) => m?.type === "visual" && (LOCATION_MAP_CHARTS.includes(String(checks[String(m.id)]?.chart_type)) || LOCATION_MAP_CHARTS.includes(String(m.chart)) || m.visual_grammar === "spatial");
  const maps = (modules ?? []).filter(isMap);
  return maps.length > 0 && maps.every((m) => checks[String(m.id)]?.ok === true && checks[String(m.id)]?.chart_type === "choropleth");
}
