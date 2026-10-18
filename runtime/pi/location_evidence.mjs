// NEWSROOM_LOCATION_EVIDENCE=1 (default off): a choropleth or symbol_map render writes what its own name join proved, and the editorial grammar
// accepts `verified_locations` only from that file, never from what the model reports.
// The file is visualizations/locations/<manifest key>.json; the manifest carries location_evidence_ref and location_evidence_sha256.
// What it proves: every row's name or code resolved through the vendored table to an iso3 (or US state id) and to at least one feature of
// the registered basemap. It does not prove that a point, port or pipeline lies where a story says; only choropleth has this join
// (cartographic_flow_map / geo_flow_map carry coordinates the model or data gave, so they never produce this file).
import { createHash } from "node:crypto";
import { CHOROPLETH_BASEMAP_ID, CHOROPLETH_US_BASEMAP_ID, isUsStateMap, joinChoroplethRows } from "./choropleth.mjs";
import { getBasemap } from "./basemap_registry.mjs";

export const LOCATION_EVIDENCE_SCHEMA_VERSION = "1.0.0";
export { locationEvidenceEnabled } from "./location_proof.mjs";
import { LOCATION_EVIDENCE_CHARTS } from "./location_proof.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Where the evidence for the manifest <key>.json lives. */
export function locationEvidenceRef(key) { return `visualizations/locations/${key}.json`; }

/** The evidence for one choropleth's or symbol_map's rows (both join names to the same basemaps through joinChoroplethRows), or null for any other chart type. Pure: same rows and spec give the same text. */
export function buildLocationEvidence(rows, spec) {
  if (!LOCATION_EVIDENCE_CHARTS.includes(spec?.chart_type)) return null;
  const basemapId = isUsStateMap(spec) ? CHOROPLETH_US_BASEMAP_ID : CHOROPLETH_BASEMAP_ID;
  const entries = joinChoroplethRows(rows, spec).map((joined, rowIndex) => ({
    row_index: rowIndex,
    raw: String(joined.raw ?? ""),
    iso3: joined.iso3,
    feature_indices: joined.featureIndices,
    matched: Boolean(joined.iso3) && joined.entry?.kind === "economy" && joined.featureIndices.length > 0,
  }));
  const unmatched = [...new Set(entries.filter((e) => !e.matched).map((e) => e.raw))];
  const matchedCount = entries.filter((e) => e.matched).length;
  return {
    schema_version: LOCATION_EVIDENCE_SCHEMA_VERSION,
    chart_type: spec.chart_type,
    category_names: String(spec.category_names ?? ""),
    basemap_id: basemapId,
    basemap_content_hash: getBasemap(basemapId)?.content_hash ?? "",
    rows: entries.map(({ matched, ...rest }) => rest),
    unmatched,
    matched_count: matchedCount,
    join_status: entries.length === 0 ? "empty" : unmatched.length ? "has_unmatched" : "all_matched",
  };
}

/** The text that is written, and its sha256 (the manifest records it). */
export function locationEvidenceText(evidence) {
  const text = JSON.stringify(evidence, null, 2) + "\n";
  return { text, sha256: sha256(text) };
}

/**
 * Whether a manifest's evidence counts: the text hashes to what the manifest recorded, it names the registered basemap at its current
 * hash, every row joined, and the row count equals the manifest's. Returns { ok, reason }.
 */
export function checkLocationEvidence(manifest, text) {
  if (!LOCATION_EVIDENCE_CHARTS.includes(manifest?.chart_type)) return { ok: false, reason: "not_a_choropleth" };
  if (typeof text !== "string" || !manifest.location_evidence_sha256) return { ok: false, reason: "no_evidence" };
  if (sha256(text) !== manifest.location_evidence_sha256) return { ok: false, reason: "hash_mismatch" };
  let evidence;
  try { evidence = JSON.parse(text); } catch { return { ok: false, reason: "unreadable" }; }
  if (evidence?.schema_version !== LOCATION_EVIDENCE_SCHEMA_VERSION || evidence.chart_type !== manifest.chart_type) return { ok: false, reason: "wrong_schema" };
  const basemap = getBasemap(evidence.basemap_id);
  if (!basemap || basemap.content_hash !== evidence.basemap_content_hash) return { ok: false, reason: "basemap_mismatch" };
  if (!Array.isArray(evidence.rows) || evidence.rows.length === 0 || evidence.rows.length !== manifest.row_count) return { ok: false, reason: "row_count_mismatch" };
  if (evidence.join_status !== "all_matched" || evidence.unmatched?.length || evidence.matched_count !== evidence.rows.length) return { ok: false, reason: "not_all_matched" };
  return { ok: true, reason: "all_matched" };
}
