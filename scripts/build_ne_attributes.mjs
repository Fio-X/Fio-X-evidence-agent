#!/usr/bin/env node
// Derives runtime/pi/assets/naturalearth-admin0-50m-attributes.json - a
// sidecar attribute table for the registered, geometry-only
// naturalearth_admin0_50m basemap (runtime/pi/assets/naturalearth-admin0-50m.geojson,
// 242 features with EMPTY properties; see runtime/pi/basemap_registry.mjs).
//
// That basemap's bytes/content_hash must never change - choropleth's join,
// cartographic_flow_map, and every other consumer key off its exact
// content_hash - so this script never writes to it. It only reads it, to
// prove, feature by feature, that an external Natural Earth release that
// still carries full attributes has geometrically identical features (same
// count, same order, same rings), then writes iso3/name/continent/subregion/
// label metadata indexed the same way (feature i here describes feature i
// of the vendored geometry).
//
// Run manually, pointing at a local copy of the upstream
// ne_50m_admin_0_countries.geojson release (see
// fixtures/external/naturalearth_50m_attributes/SOURCE.json for provenance
// and how to fetch it again; the ~3MB source is intentionally not vendored):
//
//   node scripts/build_ne_attributes.mjs /path/to/ne_50m_admin_0_countries.geojson
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const VENDORED_BASEMAP_PATH = join(ROOT, "runtime/pi/assets/naturalearth-admin0-50m.geojson");
export const ATTRIBUTES_ASSET_PATH = join(ROOT, "runtime/pi/assets/naturalearth-admin0-50m-attributes.json");
export const NE_ATTRIBUTES_SCHEMA_VERSION = "0.1.0";

// Provenance of the external (unvendored) full-attribute release this
// script reads from; see fixtures/external/naturalearth_50m_attributes/SOURCE.json.
export const EXPECTED_SOURCE_SHA256 = "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb";
export const SOURCE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson";
export const SOURCE_RETRIEVED_AT = "2026-09-27T02:34:28Z";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// World Bank Kosovo code alias: Natural Earth (like ISO 3166-1) has no
// official ISO_A3 for Kosovo - ISO_A3_EH is the sentinel "-99" - but the
// World Bank's own economy list carries Kosovo under "XKX", so that is the
// one documented substitution this join makes. Every other -99 feature at
// this vintage (Somaliland, Northern Cyprus, Siachen Glacier) has no World
// Bank economy at all and is intentionally left iso3=null, never guessed.
function iso3For(props) {
  const eh = String(props?.ISO_A3_EH ?? "").trim();
  if (eh === "-99") return props?.ADM0_A3 === "KOS" ? "XKX" : null;
  return eh || null;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false; // numbers/strings/booleans already resolved by a===b above
}

// Recorded verbatim in the sidecar header so a reader of the shipped asset
// (not just this script) can see the exact join rule without re-deriving it.
const RULES = Object.freeze([
  "iso3 = feature.properties.ISO_A3_EH.",
  "When ISO_A3_EH is '-99', iso3 = null, except one documented alias: ADM0_A3 'KOS' (Kosovo) becomes 'XKX', the World Bank's Kosovo code.",
  "Geometry is never read from this source at runtime: the registered basemap (runtime/pi/assets/naturalearth-admin0-50m.geojson) is the sole geometry of record. This asset carries attributes only, indexed positionally - feature i here describes feature i of the vendored geometry.",
]);

/**
 * Pure derivation of the attribute sidecar's content from an external,
 * full-attribute Natural Earth release plus the already-vendored
 * (geometry-only) basemap. Throws rather than writing anything when the
 * source's sha256 does not match the recorded upstream release, or when any
 * feature's geometry does not deep-equal the vendored basemap's geometry at
 * the same index.
 *
 * @param {{sourcePath: string}} options
 */
export function buildNeAttributes({ sourcePath }) {
  if (!sourcePath) throw new Error("buildNeAttributes: sourcePath is required");
  const sourceBytes = readFileSync(sourcePath);
  const sourceSha256 = sha256(sourceBytes);
  if (sourceSha256 !== EXPECTED_SOURCE_SHA256) {
    throw new Error(`refusing to build from '${sourcePath}': sha256 ${sourceSha256} does not match the recorded upstream release ${EXPECTED_SOURCE_SHA256}`);
  }
  const source = JSON.parse(sourceBytes.toString("utf8"));
  const sourceFeatures = source?.features;
  if (!Array.isArray(sourceFeatures)) throw new Error(`${sourcePath}: expected a FeatureCollection with a features array`);

  const vendoredBytes = readFileSync(VENDORED_BASEMAP_PATH);
  const vendoredContentHash = sha256(vendoredBytes);
  const vendored = JSON.parse(vendoredBytes.toString("utf8"));
  const vendoredFeatures = vendored?.features;
  if (!Array.isArray(vendoredFeatures)) throw new Error(`${VENDORED_BASEMAP_PATH}: expected a FeatureCollection with a features array`);
  if (vendoredFeatures.length !== sourceFeatures.length) {
    throw new Error(`geometry count mismatch: vendored basemap has ${vendoredFeatures.length} features, source has ${sourceFeatures.length}`);
  }

  const features = sourceFeatures.map((feature, index) => {
    if (!deepEqual(feature.geometry, vendoredFeatures[index].geometry)) {
      throw new Error(`geometry mismatch at feature index ${index} (name=${feature?.properties?.NAME ?? "?"}): source and vendored basemap geometry differ`);
    }
    const props = feature.properties ?? {};
    const labelX = Number(props.LABEL_X);
    const labelY = Number(props.LABEL_Y);
    if (!Number.isFinite(labelX) || !Number.isFinite(labelY)) throw new Error(`feature index ${index} (${props.NAME}) has non-numeric LABEL_X/LABEL_Y`);
    return {
      index,
      iso3: iso3For(props),
      adm0_a3: String(props.ADM0_A3 ?? ""),
      name: String(props.NAME ?? ""),
      continent: String(props.CONTINENT ?? ""),
      subregion: String(props.SUBREGION ?? ""),
      label: [labelX, labelY],
    };
  });

  return {
    schema_version: NE_ATTRIBUTES_SCHEMA_VERSION,
    generated_by: "scripts/build_ne_attributes.mjs",
    source: { url: SOURCE_URL, retrieved_at: SOURCE_RETRIEVED_AT, sha256: sourceSha256 },
    vendored_geometry: { file: "runtime/pi/assets/naturalearth-admin0-50m.geojson", content_hash: vendoredContentHash },
    rules: RULES,
    features,
  };
}

function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error("usage: node scripts/build_ne_attributes.mjs <path-to-ne_50m_admin_0_countries.geojson>");
    process.exit(1);
  }
  const asset = buildNeAttributes({ sourcePath });
  writeFileSync(ATTRIBUTES_ASSET_PATH, JSON.stringify(asset, null, 2) + "\n");
  console.log(`wrote ${ATTRIBUTES_ASSET_PATH}`);
  console.log(`  features: ${asset.features.length}`);
  console.log(`  vendored geometry content_hash: ${asset.vendored_geometry.content_hash}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
