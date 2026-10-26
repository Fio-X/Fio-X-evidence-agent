// Loads the vendored, provenance-recorded name tables and resolves a raw
// row value to a display name for a chart's name field:
//
//   - runtime/pi/assets/economy-names.json (built by
//     scripts/build_economy_names.mjs from fixtures/external/
//     worldbank_country_list/ plus the Natural Earth territory codes):
//       category_names "worldbank"  exact World Bank English name ("Congo, Dem. Rep.")
//       category_names "iso3"       ISO3 economy/aggregate/territory code ("COD"), the
//                                   OWID_ continent codes, plus the documented alias codes
//                                   (OWID_KOS, OWID_WRL, OWID_EU27 and the OWID_ income groups)
//       category_names "iso2"       ISO 3166-1 alpha-2 code ("CD"), plus the
//                                   documented Eurostat aliases (EL, UK) and the
//                                   Eurostat except codes the table names (CN_X_HK)
//   - runtime/pi/assets/currency-names.json (built by
//     scripts/build_currency_names.mjs):
//       category_names "iso4217"    ISO 4217 currency code ("TRY")
//
// This module never translates anything itself - every zh string it can
// return was already present in a vendored asset (from Unicode CLDR via
// Node's bundled ICU, from the World Bank's own zh country list, or from the
// builders' small policy override tables). The model is likewise never
// allowed to translate a name: viz.mjs's lint requires the raw value to
// already be an exact World Bank English name or code (see lintVizSpec's
// category_names checks), and only the resolver here ever turns that raw
// value into localized display text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { trackExport } from "./groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// The modes that name a place (economy, territory or aggregate). The
// choropleth join is built on these (it needs an entry with an iso3 that
// keys into the Natural Earth sidecar), so a currency mode is NOT here.
//
// "us_state" (US states + DC, runtime/pi/assets/us-state-names.json) is a model-visible mode only with NEWSROOM_US_STATES=1
// (exact "1", off by default); the switch is read once, when this module loads. With it off the three constants below are
// exactly what they were before the mode existed.
export function usStatesEnabled() {
  return process.env.NEWSROOM_US_STATES === "1";
}
export const ECONOMY_NAME_MODES = Object.freeze(["worldbank", "iso3", "iso2", ...(usStatesEnabled() ? ["us_state"] : [])]);
// The modes that name a currency (no map feature, so never legal on a choropleth).
export const CURRENCY_NAME_MODES = Object.freeze(["iso4217"]);
// Every legal value of the viz-spec `category_names` field (validateVizSpec's
// enum check imports this, so the renderer and the validator can never drift
// apart on what is a legal value).
export const CATEGORY_NAME_MODES = Object.freeze([...ECONOMY_NAME_MODES, ...CURRENCY_NAME_MODES]);

function loadEconomyNamesAsset() {
  const path = join(HERE, "assets", "economy-names.json");
  const asset = JSON.parse(readFileSync(path, "utf8"));
  // `kind` and `en` are added here, in memory, only - they are not part of the
  // vendored asset's own schema. `kind` lets a caller (choropleth's join/lint)
  // tell an individual economy or territory (iso3 names one map feature) apart
  // from a regional/income-group aggregate (iso3 names a rollup such as SSF or
  // WLD that no single map feature can represent) without re-deriving that
  // distinction from the asset's own economies/territories/aggregates split.
  // `en` is the English display name: the World Bank name for an economy or
  // aggregate, the CLDR English name for a territory.
  const tag = (entry, kind) => ({ ...entry, en: entry.wb_name ?? entry.en_name, kind });
  const economies = asset.economies.map((entry) => tag(entry, "economy"));
  const territories = asset.territories.map((entry) => tag(entry, "economy"));
  const aggregates = asset.aggregates.map((entry) => tag(entry, "aggregate"));
  const entries = [...economies, ...territories, ...aggregates];
  const byIso3 = new Map(entries.map((entry) => [entry.iso3, entry]));
  const byIso2 = new Map([...economies, ...territories].map((entry) => [entry.iso2, entry]));
  // Territories have no World Bank name: they resolve by code only, never by an English name.
  // Neither does an aggregate that has no World Bank row (the Our World in Data continents).
  const byWbName = new Map([...economies, ...aggregates].filter((entry) => entry.wb_name !== undefined).map((entry) => [entry.wb_name, entry]));
  const modeTables = { iso3: byIso3, iso2: byIso2 };
  for (const alias of asset.aliases ?? []) {
    const table = modeTables[alias.mode];
    const target = table?.get(alias.target);
    if (!target) throw new Error(`economy-names.json: alias '${alias.alias}' targets '${alias.target}', which is not a ${alias.mode} code`);
    if (table.has(alias.alias)) throw new Error(`economy-names.json: alias '${alias.alias}' shadows a primary ${alias.mode} code`);
    table.set(alias.alias, target);
  }
  // An except code (CN_X_HK, China except Hong Kong) is another place than its A: iso2 mode only, by its own code, and no
  // iso3, so it joins no map feature.
  for (const place of asset.except_places ?? []) {
    if (byIso2.has(place.code)) throw new Error(`economy-names.json: except code '${place.code}' shadows an iso2 code`);
    byIso2.set(place.code, { ...place, en: place.en_name, kind: "economy" });
  }
  return { asset, entries, byIso3, byIso2, byWbName };
}

function loadCurrencyNamesAsset() {
  const path = join(HERE, "assets", "currency-names.json");
  const asset = JSON.parse(readFileSync(path, "utf8"));
  const entries = asset.currencies.map((entry) => ({ ...entry, kind: "currency" }));
  return { asset, entries, byCode: new Map(entries.map((entry) => [entry.code, entry])) };
}

// US states: one entry per state or DC, keyed by USPS code and by English full name (exact, trimmed). `iso3` is the map
// join id "US-<USPS>" (the choropleth renderer keys every region by `iso3`); kind is "economy" so a state is a plottable region.
function loadUsStateNamesAsset() {
  const asset = JSON.parse(readFileSync(join(HERE, "assets", "us-state-names.json"), "utf8"));
  const entries = asset.states.map((row) => ({ ...row, iso3: `US-${row.usps}`, kind: "economy" }));
  const byKey = new Map();
  for (const entry of entries) { byKey.set(entry.usps, entry); byKey.set(entry.en, entry); if (entry.zh) byKey.set(entry.zh, entry); }
  return { asset, entries, byKey };
}

const ECONOMY_TABLE = loadEconomyNamesAsset();
const US_STATE_TABLE = loadUsStateNamesAsset();
const CURRENCY_TABLE = loadCurrencyNamesAsset();
const NO_ENTRIES = new Map();

function tableFor(categoryNames) {
  switch (categoryNames) {
    case "worldbank": return ECONOMY_TABLE.byWbName;
    case "iso3": return ECONOMY_TABLE.byIso3;
    case "iso2": return ECONOMY_TABLE.byIso2;
    case "iso4217": return CURRENCY_TABLE.byCode;
    case "us_state": return usStatesEnabled() ? US_STATE_TABLE.byKey : NO_ENTRIES;
    default: return NO_ENTRIES; // an unknown mode resolves nothing (validateVizSpec rejects it first)
  }
}

/**
 * Every distinct value in `values` that is not an exact match (trimmed World
 * Bank English name for categoryNames==="worldbank", trimmed code for
 * "iso3", "iso2" and "iso4217") in the vendored table. Order-preserving,
 * deduplicated. Used by lintVizSpec to block a category_names chart whose
 * name field contains a value the table cannot resolve - the model must use
 * the exact World Bank name or code, never a paraphrase or its own
 * translation.
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
 *   - language "en", categoryNames "iso3" / "iso2" / "iso4217": the table's
 *     English name (the raw value was a code, so it must be replaced to be
 *     readable at all): the World Bank English name, the CLDR English name of a
 *     territory, or the CLDR English currency name.
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
  // ("Sub-Saharan Africa "); the tables store them trimmed.
  const entry = tableFor(categoryNames).get(raw.trim());
  if (!entry) return raw;
  if (lang === "zh") return entry.zh;
  return categoryNames === "worldbank" ? raw : entry.en;
}

/**
 * The vendored table entry a raw category/facet/series value resolves to,
 * or null when the table has no exact match. Used wherever a caller needs
 * more than the display name - choropleth's join needs the entry's iso3 (to
 * key into the Natural Earth attribute sidecar) and its kind ("economy" vs
 * "aggregate", see loadEconomyNamesAsset above; a currency entry has kind
 * "currency" and no iso3) - without re-implementing this module's own
 * trim/lookup convention.
 */
export function economyEntryFor(rawValue, categoryNames) {
  if (!categoryNames) return null;
  const raw = String(rawValue ?? "").trim();
  return tableFor(categoryNames).get(raw) ?? null;
}

// K315: report-only record of tools reaching this module's exports (key economy_names.mjs::name). test_k315_export_wrap pins this list.
{
  economyEntryFor = trackExport("economy_names.mjs::economyEntryFor", economyEntryFor);
  resolveEconomyDisplayName = trackExport("economy_names.mjs::resolveEconomyDisplayName", resolveEconomyDisplayName);
  unmappedEconomyNameValues = trackExport("economy_names.mjs::unmappedEconomyNameValues", unmappedEconomyNameValues);
  usStatesEnabled = trackExport("economy_names.mjs::usStatesEnabled", usStatesEnabled);
}
