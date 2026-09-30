#!/usr/bin/env node
// Deterministically derives runtime/pi/assets/economy-names.json - the
// vendored, provenance-recorded table the newsroom viz/infographic
// renderers use to show a real Chinese place name (e.g. "刚果（金）")
// instead of leaking a World Bank English row value ("Congo, Dem. Rep.")
// onto a zh chart. The model never translates a name itself: every zh
// string this table can produce came from either Unicode CLDR (via
// Node's bundled ICU, Intl.DisplayNames) or the World Bank's own zh
// country list, both vendored/recorded in fixtures/external/
// worldbank_country_list/ (see SOURCE.json there).
//
// Inputs are the two raw World Bank Countries-and-Lending-Groups API
// responses (v2/country, en and zh), vendored verbatim - this script
// performs no network access.
//
// buildEconomyNames() is the pure derivation (no file writes); the CLI
// entry point below it reads the two fixture files, calls it, stamps a
// build-environment `versions` block (Node/ICU/CLDR, which genuinely
// varies by build machine and is therefore captured live rather than
// pinned), and writes the asset. scripts/test_economy_names.mjs imports
// buildEconomyNames() directly and re-derives the substantive
// (version-independent) fields to check the committed asset is not
// stale or hand-edited.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_EN_PATH = join(ROOT, "fixtures/external/worldbank_country_list/wb-country-en.json");
export const DEFAULT_ZH_PATH = join(ROOT, "fixtures/external/worldbank_country_list/wb-country-zh.json");
export const ECONOMY_NAMES_ASSET_PATH = join(ROOT, "runtime/pi/assets/economy-names.json");
export const ECONOMY_NAMES_SCHEMA_VERSION = "0.1.0";

// A Latin letter anywhere in a zh display name means CLDR/World Bank data
// silently failed to translate (or a fallback leaked a raw ISO code, e.g.
// CLDR returning "JG" for a code it does not have a name for) - never ship
// that as if it were a Chinese name.
const LATIN_LETTER_RE = /[A-Za-z]/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function loadWbList(path) {
  const bytes = readFileSync(path);
  const parsed = JSON.parse(bytes.toString("utf8"));
  const rows = Array.isArray(parsed) ? parsed[1] : null;
  if (!Array.isArray(rows)) throw new Error(`${path}: expected the World Bank API's [meta, rows] shape`);
  return { bytes, rows };
}

function assertZhName(zh, context) {
  if (!zh || !zh.trim()) throw new Error(`economy-names build: empty zh name for ${context}`);
  if (LATIN_LETTER_RE.test(zh)) throw new Error(`economy-names build: zh name for ${context} contains Latin letters: ${JSON.stringify(zh)}`);
}

/**
 * Pure derivation of the economy-names asset's substantive (build-machine-
 * independent) content: the vendored file provenance and the economies/
 * aggregates name tables. Throws if any included zh name would be empty or
 * contain Latin letters (a real World Bank/CLDR data change or fixture
 * corruption, never something to route around).
 *
 * @param {{enPath?: string, zhPath?: string}} [options]
 */
export function buildEconomyNames({ enPath = DEFAULT_EN_PATH, zhPath = DEFAULT_ZH_PATH } = {}) {
  const en = loadWbList(enPath);
  const zh = loadWbList(zhPath);
  const zhById = new Map(zh.rows.map((row) => [row.id, row]));
  const displayNames = new Intl.DisplayNames(["zh-Hans"], { type: "region" });

  function worldBankZh(id) {
    const row = zhById.get(id);
    return String(row?.name ?? "").trim();
  }

  // CLDR's zh-Hans name for an ISO 3166-1 alpha-2 code, or null when CLDR
  // has no entry for it. Intl.DisplayNames throws on a genuinely malformed
  // code (not the case here - every economy row has a real iso2Code) and,
  // for a code it recognises the *shape* of but has no localized name for,
  // returns the code itself unchanged (observed for economy CHI/iso2 "JG",
  // the World Bank's pseudo-code for the Channel Islands) - both treated
  // as "no CLDR name".
  function cldrZh(iso2) {
    let name;
    try {
      name = displayNames.of(iso2);
    } catch {
      return null;
    }
    if (!name || name === iso2) return null;
    return name;
  }

  const economies = en.rows
    .filter((row) => row.region?.value !== "Aggregates")
    .map((row) => {
      const iso3 = row.id;
      const iso2 = row.iso2Code;
      const wb_name = String(row.name ?? "").trim();
      const cldr = cldrZh(iso2);
      const entry = cldr
        ? { iso3, iso2, wb_name, zh: cldr, zh_source: "cldr" }
        : { iso3, iso2, wb_name, zh: worldBankZh(iso3), zh_source: "worldbank" };
      assertZhName(entry.zh, `economy ${iso3} (${iso2})`);
      return entry;
    })
    .sort((a, b) => a.iso3.localeCompare(b.iso3));

  // Aggregates are derived from the economies themselves, never hand-
  // picked: "WLD" (the whole-world aggregate every economy rolls up to)
  // plus every distinct region.id and incomeLevel.id an included economy
  // is actually assigned to. All 12 aggregate names come from the World
  // Bank's own zh list - CLDR's region catalogue has no notion of a
  // lending/income aggregate.
  const aggregateIds = new Set(["WLD"]);
  for (const row of en.rows) {
    if (row.region?.value === "Aggregates") continue;
    if (row.region?.id) aggregateIds.add(row.region.id);
    if (row.incomeLevel?.id) aggregateIds.add(row.incomeLevel.id);
  }
  const enById = new Map(en.rows.map((row) => [row.id, row]));
  const aggregates = [...aggregateIds]
    .sort()
    .map((iso3) => {
      const enRow = enById.get(iso3);
      if (!enRow) throw new Error(`economy-names build: aggregate '${iso3}' is not present in the World Bank en list`);
      const wb_name = String(enRow.name ?? "").trim();
      const zhName = worldBankZh(iso3);
      const entry = { iso3, wb_name, zh: zhName, zh_source: "worldbank" };
      assertZhName(entry.zh, `aggregate ${iso3}`);
      return entry;
    });

  return {
    sources: {
      wb_country_en: { file: "fixtures/external/worldbank_country_list/wb-country-en.json", bytes: en.bytes.length, sha256: sha256(en.bytes) },
      wb_country_zh: { file: "fixtures/external/worldbank_country_list/wb-country-zh.json", bytes: zh.bytes.length, sha256: sha256(zh.bytes) },
    },
    economies,
    aggregates,
  };
}

function main() {
  const derived = buildEconomyNames();
  const asset = {
    schema_version: ECONOMY_NAMES_SCHEMA_VERSION,
    generated_by: "scripts/build_economy_names.mjs",
    // Genuinely varies by build machine (unlike the two fixtures' sha256s,
    // which are file facts) - captured live rather than pinned. Verified
    // (scripts/test_economy_names.mjs, and by hand across Node 22.19.0 and
    // 24.14.1 during this task) that CLDR's zh-Hans region names for every
    // included economy are identical across the Node versions this repo's
    // CI and development environments actually use, so this asset does not
    // need to be rebuilt per-environment.
    versions: { node: process.versions.node, icu: process.versions.icu, cldr: process.versions.cldr },
    ...derived,
  };
  writeFileSync(ECONOMY_NAMES_ASSET_PATH, JSON.stringify(asset, null, 2) + "\n");
  console.log(`wrote ${ECONOMY_NAMES_ASSET_PATH}`);
  console.log(`  economies: ${asset.economies.length}, aggregates: ${asset.aggregates.length}`);
  console.log(`  node=${asset.versions.node} icu=${asset.versions.icu} cldr=${asset.versions.cldr}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
