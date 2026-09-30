// Loads the vendored, provenance-recorded World Bank/CLDR economy name
// table (runtime/pi/assets/economy-names.json, built by
// scripts/build_economy_names.mjs from fixtures/external/
// worldbank_country_list/) and resolves a raw World Bank row value
// (English name, e.g. "Congo, Dem. Rep.", or an ISO3 economy/aggregate
// code, e.g. "COD") to a display name for a chart's name field.
//
// This module never translates anything itself - every zh string it can
// return was already present in the vendored asset (from Unicode CLDR via
// Node's bundled ICU, or from the World Bank's own zh country list). The
// model is likewise never allowed to translate a name: viz.mjs's lint
// requires the raw value to already be an exact World Bank English name or
// ISO3 code (see lintVizSpec's category_names checks), and only the
// resolver here ever turns that raw value into localized display text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// The two supported values of the viz-spec `category_names` field
// (validateVizSpec's enum check imports this directly, so the renderer and
// the validator can never drift apart on what is a legal value).
export const ECONOMY_NAME_MODES = Object.freeze(["worldbank", "iso3"]);

function loadEconomyNamesAsset() {
  const path = join(HERE, "assets", "economy-names.json");
  const asset = JSON.parse(readFileSync(path, "utf8"));
  // `kind` is added here, in memory, only - it is not part of the vendored
  // asset's own schema. It lets a caller (choropleth's join/lint) tell an
  // individual economy (iso3 names one country/territory) apart from a
  // regional/income-group aggregate (iso3 names a rollup such as SSF or WLD
  // that no single map feature can represent) without re-deriving that
  // distinction from economy-names.json's own economies/aggregates split.
  const entries = [
    ...asset.economies.map((entry) => ({ ...entry, kind: "economy" })),
    ...asset.aggregates.map((entry) => ({ ...entry, kind: "aggregate" })),
  ];
  const byIso3 = new Map(entries.map((entry) => [entry.iso3, entry]));
  const byWbName = new Map(entries.map((entry) => [entry.wb_name, entry]));
  return { asset, entries, byIso3, byWbName };
}

const TABLE = loadEconomyNamesAsset();

function tableFor(categoryNames) {
  return categoryNames === "iso3" ? TABLE.byIso3 : TABLE.byWbName;
}

/**
 * Every distinct value in `values` that is not an exact match (trimmed World
 * Bank English name for categoryNames==="worldbank", trimmed code for
 * "iso3") in the vendored table. Order-preserving, deduplicated. Used by
 * lintVizSpec to block a category_names chart whose name field contains a
 * value the table cannot resolve - the model must use the exact World Bank
 * name or ISO3 code, never a paraphrase or its own translation.
 */
export function unmappedEconomyNameValues(values, categoryNames) {
  const table = tableFor(categoryNames);
  const seen = new Set();
  const unmapped = [];
  for (const value of values) {
    const key = String(value ?? "").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!table.has(key)) unmapped.push(key);
  }
  return unmapped;
}

/**
 * Resolve a raw category/facet/series value to display text, per spec:
 *   - language "zh": the table's zh name (whichever lookup key matched).
 *   - language "en", categoryNames "iso3": the table's World Bank English
 *     name (the raw value was a code, so it must be replaced to be
 *     readable at all).
 *   - language "en", categoryNames "worldbank": the raw value, unchanged
 *     (it is already the World Bank English name - byte-identical).
 * Falls back to the raw value unchanged if the table has no match; render
 * time is not the gate for that (lintVizSpec's unmappedEconomyNameValues
 * check is), so this never throws.
 */
export function resolveEconomyDisplayName(rawValue, categoryNames, lang) {
  const raw = String(rawValue ?? "");
  if (!categoryNames) return raw;
  // World Bank data carries some names with a trailing space
  // ("Sub-Saharan Africa "); the table stores them trimmed.
  const entry = tableFor(categoryNames).get(raw.trim());
  if (!entry) return raw;
  if (lang === "zh") return entry.zh;
  return categoryNames === "iso3" ? entry.wb_name : raw;
}

/**
 * The vendored table entry a raw category/facet/series value resolves to,
 * or null when the table has no exact match. Used wherever a caller needs
 * more than the display name - choropleth's join needs the entry's iso3 (to
 * key into the Natural Earth attribute sidecar) and its kind ("economy" vs
 * "aggregate", see loadEconomyNamesAsset above) - without re-implementing
 * this module's own trim/lookup convention.
 */
export function economyEntryFor(rawValue, categoryNames) {
  if (!categoryNames) return null;
  const raw = String(rawValue ?? "").trim();
  return tableFor(categoryNames).get(raw) ?? null;
}
