#!/usr/bin/env node
// Deterministically derives runtime/pi/assets/economy-names.json - the
// vendored, provenance-recorded table the newsroom viz/infographic
// renderers use to show a real Chinese place name (e.g. "刚果（金）")
// instead of leaking a World Bank English row value ("Congo, Dem. Rep.")
// onto a zh chart. The model never translates a name itself: every zh
// string this table can produce came from Unicode CLDR (via Node's bundled
// ICU, Intl.DisplayNames), from the World Bank's own zh country list
// (vendored in fixtures/external/worldbank_country_list/, see SOURCE.json
// there), or from the small policy override table below.
//
// Inputs:
//   - the two raw World Bank Countries-and-Lending-Groups API responses
//     (v2/country, en and zh), vendored verbatim;
//   - for the Natural Earth territories the World Bank list has no row for,
//     the ISO 3166-1 alpha-2 code (ISO_A2_EH) of each territory, read from
//     the pinned full-attribute Natural Earth 50m release. That ~3MB source
//     is intentionally NOT vendored (see fixtures/external/
//     naturalearth_50m_attributes/SOURCE.json); the CLI below takes its path
//     as an argument and refuses any file whose sha256 differs from the pin.
// This script performs no network access.
//
// Usage (offline; the NE file comes from the pinned commit recorded in
// SOURCE.json, e.g. `git show 3649244:experiments/infographic/africa/source/
// ne_50m_admin_0_countries.geojson > /tmp/ne.geojson`):
//
//   node scripts/build_economy_names.mjs /tmp/ne.geojson
//
// Toolchain pin: CLDR names are data of the ICU build Node ships, so the CLI
// refuses to write unless node/ICU/CLDR are exactly PINNED_TOOLCHAIN (the
// versions the committed asset records). Changing the pin is a reviewed,
// deliberate edit of this file, after which every changed name shows up in
// the asset diff.
//
// buildEconomyNames() is the pure derivation (no file writes, no toolchain
// check): scripts/test_economy_names.mjs imports it directly and re-derives
// the committed asset to prove it is neither stale nor hand-edited.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { EXPECTED_SOURCE_SHA256 as NE_SOURCE_SHA256 } from "./build_ne_attributes.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_EN_PATH = join(ROOT, "fixtures/external/worldbank_country_list/wb-country-en.json");
export const DEFAULT_ZH_PATH = join(ROOT, "fixtures/external/worldbank_country_list/wb-country-zh.json");
export const NE_SOURCE_RECORD_PATH = join(ROOT, "fixtures/external/naturalearth_50m_attributes/SOURCE.json");
export const ECONOMY_NAMES_ASSET_PATH = join(ROOT, "runtime/pi/assets/economy-names.json");
export const ECONOMY_NAMES_SCHEMA_VERSION = "0.2.0";

// The node/ICU/CLDR the committed names were generated with. The CLI refuses
// to run on anything else; the currency builder shares this pin.
export const PINNED_TOOLCHAIN = Object.freeze({ node: "24.14.1", icu: "78.2", cldr: "48.0" });

/** Throws unless `versions` (default: this process) is exactly PINNED_TOOLCHAIN. */
export function assertPinnedToolchain(versions = process.versions) {
  const live = { node: versions.node, icu: versions.icu, cldr: versions.cldr };
  const mismatched = Object.keys(PINNED_TOOLCHAIN).filter((key) => live[key] !== PINNED_TOOLCHAIN[key]);
  if (mismatched.length) {
    throw new Error(
      `refusing to build: this toolchain is node ${live.node} / ICU ${live.icu} / CLDR ${live.cldr}, but the committed names were generated with `
      + `node ${PINNED_TOOLCHAIN.node} / ICU ${PINNED_TOOLCHAIN.icu} / CLDR ${PINNED_TOOLCHAIN.cldr}. Run the builder under the pinned toolchain `
      + `(or change PINNED_TOOLCHAIN in a reviewed edit and check every changed name in the asset diff).`,
    );
  }
}

// The 22 Natural Earth admin-0 features that carry an ISO_A3_EH but have no
// row in the World Bank country list (so no economy entry). They resolve by
// ISO3 / ISO2 only, never by an English name.
export const TERRITORY_ISO3 = Object.freeze([
  "VAT", "SGS", "IOT", "SHN", "PCN", "AIA", "FLK", "MSR", "JEY", "GGY", "TWN",
  "NIU", "COK", "ESH", "SPM", "WLF", "BLM", "ATF", "ALA", "HMD", "NFK", "ATA",
]);

// Policy overrides of the CLDR zh-Hans name (zh-naming-policy-1003, rule
// table). `policy_rule` is the rule number that authorizes the entry: 3 is the
// override table itself (HKG MAC TWN PSE FSM), 5 the Kosovo rule, 6 the two
// Congo names with full-width brackets. This is the ONLY place a zh name is
// ever replaced; nothing else is overridden (other CLDR names a mainland
// newsroom might word differently are listed in the task report, not changed).
export const ZH_OVERRIDES = Object.freeze({
  HKG: Object.freeze({ zh: "中国香港", policy_rule: 3 }),
  MAC: Object.freeze({ zh: "中国澳门", policy_rule: 3 }),
  TWN: Object.freeze({ zh: "中国台湾", policy_rule: 3 }),
  PSE: Object.freeze({ zh: "巴勒斯坦", policy_rule: 3 }),
  FSM: Object.freeze({ zh: "密克罗尼西亚联邦", policy_rule: 3 }),
  XKX: Object.freeze({ zh: "科索沃", policy_rule: 5 }),
  COD: Object.freeze({ zh: "刚果（金）", policy_rule: 6 }),
  COG: Object.freeze({ zh: "刚果（布）", policy_rule: 6 }),
});

// Documented alternate spellings of a code, per mode. `target` is a key of the
// same mode's primary table. Every other OWID_* aggregate code stays
// unresolved on purpose (aggregate rows belong out of a country chart; the
// lint tells the model to filter them in SQL).
export const ALIASES = Object.freeze([
  Object.freeze({ mode: "iso3", alias: "OWID_KOS", target: "XKX", source: "Our World in Data code for Kosovo" }),
  Object.freeze({ mode: "iso3", alias: "OWID_WRL", target: "WLD", source: "Our World in Data code for the World aggregate" }),
  Object.freeze({ mode: "iso2", alias: "EL", target: "GR", source: "Eurostat geo code for Greece (ISO 3166-1 alpha-2 is GR)" }),
  Object.freeze({ mode: "iso2", alias: "UK", target: "GB", source: "Eurostat geo code for the United Kingdom (ISO 3166-1 alpha-2 is GB)" }),
]);

// Recorded verbatim in the asset so a reader of the shipped file (not just
// this script) can see how every name was chosen.
const RULES = Object.freeze([
  "zh = Unicode CLDR zh-Hans region name (Intl.DisplayNames) for the entry's ISO 3166-1 alpha-2 code.",
  "When CLDR has no name for the code (the World Bank pseudo-code JG for the Channel Islands), zh = the World Bank's own zh name, zh_source 'worldbank'.",
  "The override table (zh_source 'override') replaces the CLDR name only where a policy rule says so; policy_rule is that rule's number and cldr_zh records what CLDR said.",
  "Natural Earth territories (the `territories` list) have no World Bank row: they resolve by ISO3 and ISO2 only, never by an English name. Their ISO2 is ISO_A2_EH of the pinned Natural Earth source (sources.natural_earth_admin0_50m); their en_name is the CLDR English region name.",
  "Aggregates (World Bank regions and income groups, plus WLD) keep the World Bank zh names. Aggregate rows belong out of a country chart; use them only when the aggregate itself is the subject.",
  "`aliases` map a documented alternate code to a primary key of the same mode; any other code that is not a primary key does not resolve.",
  "A zh name is never an English fallback: an empty name or one with Latin letters aborts the build.",
]);

// A Latin letter anywhere in a zh display name means CLDR/World Bank data
// silently failed to translate (or a fallback leaked a raw ISO code, e.g.
// CLDR returning "JG" for a code it does not have a name for) - never ship
// that as if it were a Chinese name.
const LATIN_LETTER_RE = /[A-Za-z]/;
const ISO2_RE = /^[A-Z]{2}$/;

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

// The provenance record of the pinned Natural Earth release, taken from the
// vendored fixtures/external/naturalearth_50m_attributes/SOURCE.json (and
// cross-checked against the pin build_ne_attributes.mjs enforces).
function neSourceRecord() {
  const record = JSON.parse(readFileSync(NE_SOURCE_RECORD_PATH, "utf8")).files?.[0];
  if (!record || record.sha256 !== NE_SOURCE_SHA256) {
    throw new Error(`${NE_SOURCE_RECORD_PATH}: its recorded sha256 must equal the pin in build_ne_attributes.mjs (${NE_SOURCE_SHA256})`);
  }
  return {
    file: record.file,
    vendored: false,
    provenance: "fixtures/external/naturalearth_50m_attributes/SOURCE.json",
    url: record.url,
    retrieved_at: record.retrieved_at,
    bytes: record.bytes,
    sha256: record.sha256,
    fields_used: ["ISO_A3_EH", "ISO_A2_EH"],
  };
}

/**
 * ISO 3166-1 alpha-2 code (ISO_A2_EH) of each TERRITORY_ISO3 entry, read from
 * the pinned full-attribute Natural Earth 50m release at `nePath`. Refuses a
 * file whose sha256 or byte length differs from the recorded pin, and any
 * territory that does not match exactly one feature with a real two-letter
 * code (never guesses).
 *
 * @param {string} nePath
 * @returns {Record<string, string>} iso3 -> iso2
 */
export function readNeTerritoryIso2(nePath) {
  if (!nePath) throw new Error("readNeTerritoryIso2: the path of the pinned ne_50m_admin_0_countries.geojson is required");
  const bytes = readFileSync(nePath);
  const digest = sha256(bytes);
  if (digest !== NE_SOURCE_SHA256) {
    throw new Error(`refusing to read '${nePath}': sha256 ${digest} does not match the recorded Natural Earth release ${NE_SOURCE_SHA256}`);
  }
  const record = neSourceRecord();
  if (bytes.length !== record.bytes) throw new Error(`'${nePath}' has ${bytes.length} bytes, the recorded release has ${record.bytes}`);
  const features = JSON.parse(bytes.toString("utf8"))?.features;
  if (!Array.isArray(features)) throw new Error(`${nePath}: expected a FeatureCollection with a features array`);
  const iso2ByIso3 = {};
  for (const iso3 of TERRITORY_ISO3) {
    const matches = features.filter((feature) => String(feature?.properties?.ISO_A3_EH ?? "").trim() === iso3);
    if (matches.length !== 1) throw new Error(`expected exactly one Natural Earth feature with ISO_A3_EH '${iso3}', found ${matches.length}`);
    const iso2 = String(matches[0].properties.ISO_A2_EH ?? "").trim();
    if (!ISO2_RE.test(iso2)) throw new Error(`Natural Earth feature '${iso3}' has no usable ISO_A2_EH (${JSON.stringify(iso2)})`);
    iso2ByIso3[iso3] = iso2;
  }
  return iso2ByIso3;
}

/**
 * Pure derivation of the economy-names asset's substantive content: the
 * vendored-file provenance and the economies / territories / aggregates /
 * aliases tables. Throws if any included zh name would be empty or contain
 * Latin letters, if an override or alias does not land on a real entry, or if
 * a code is not unique (a real World Bank/CLDR data change or fixture
 * corruption, never something to route around).
 *
 * `territoryIso2` is the iso3 -> iso2 map of the TERRITORY_ISO3 entries
 * (readNeTerritoryIso2() produces it from the pinned Natural Earth file; a
 * test without that file may pass the values stored in the committed asset).
 *
 * @param {{enPath?: string, zhPath?: string, territoryIso2: Record<string, string>}} options
 */
export function buildEconomyNames({ enPath = DEFAULT_EN_PATH, zhPath = DEFAULT_ZH_PATH, territoryIso2 } = {}) {
  if (!territoryIso2) throw new Error("buildEconomyNames: territoryIso2 (iso3 -> iso2 of the Natural Earth territories) is required; see readNeTerritoryIso2()");
  const en = loadWbList(enPath);
  const zh = loadWbList(zhPath);
  const zhById = new Map(zh.rows.map((row) => [row.id, row]));
  const regionZh = new Intl.DisplayNames(["zh-Hans"], { type: "region" });
  const regionEn = new Intl.DisplayNames(["en"], { type: "region" });

  function worldBankZh(id) {
    const row = zhById.get(id);
    return String(row?.name ?? "").trim();
  }

  // CLDR's name for an ISO 3166-1 alpha-2 code in the given display-names
  // instance, or null when CLDR has no entry for it. Intl.DisplayNames throws
  // on a genuinely malformed code (not the case here - every code used is a
  // real two-letter code) and, for a code it recognises the *shape* of but has
  // no localized name for, returns the code itself unchanged (observed for
  // economy CHI/iso2 "JG", the World Bank's pseudo-code for the Channel
  // Islands) - both treated as "no CLDR name".
  function cldrName(displayNames, iso2) {
    let name;
    try {
      name = displayNames.of(iso2);
    } catch {
      return null;
    }
    if (!name || name === iso2) return null;
    return name;
  }

  const overridesApplied = new Set();
  // Replaces `entry.zh` per the override table, recording the rule number and
  // what CLDR had said. Key order is fixed so the asset bytes are stable.
  function applyOverride(entry, cldr) {
    const override = ZH_OVERRIDES[entry.iso3];
    if (!override) return entry;
    assertZhName(override.zh, `override ${entry.iso3}`);
    overridesApplied.add(entry.iso3);
    return { ...entry, zh: override.zh, zh_source: "override", policy_rule: override.policy_rule, cldr_zh: cldr };
  }

  const wbIds = new Set(en.rows.map((row) => row.id));

  const economies = en.rows
    .filter((row) => row.region?.value !== "Aggregates")
    .map((row) => {
      const iso3 = row.id;
      const iso2 = row.iso2Code;
      const wb_name = String(row.name ?? "").trim();
      const cldr = cldrName(regionZh, iso2);
      const base = cldr
        ? { iso3, iso2, wb_name, zh: cldr, zh_source: "cldr" }
        : { iso3, iso2, wb_name, zh: worldBankZh(iso3), zh_source: "worldbank" };
      const entry = applyOverride(base, cldr);
      assertZhName(entry.zh, `economy ${iso3} (${iso2})`);
      return entry;
    })
    .sort((a, b) => a.iso3.localeCompare(b.iso3));

  const territories = TERRITORY_ISO3
    .map((iso3) => {
      if (wbIds.has(iso3)) throw new Error(`territory '${iso3}' is now in the World Bank country list; remove it from TERRITORY_ISO3`);
      const iso2 = territoryIso2[iso3];
      if (!ISO2_RE.test(String(iso2 ?? ""))) throw new Error(`territory '${iso3}' has no usable ISO 3166-1 alpha-2 code (${JSON.stringify(iso2)})`);
      const en_name = cldrName(regionEn, iso2);
      if (!en_name) throw new Error(`CLDR has no English name for territory ${iso3} (${iso2})`);
      const cldr = cldrName(regionZh, iso2);
      if (!cldr && !ZH_OVERRIDES[iso3]) throw new Error(`CLDR has no zh name for territory ${iso3} (${iso2}) and the override table has none; a zh name is never an English fallback`);
      const base = { iso3, iso2, en_name, zh: cldr, zh_source: "cldr" };
      const entry = { ...applyOverride(base, cldr), source: "natural_earth_admin0_50m" };
      assertZhName(entry.zh, `territory ${iso3} (${iso2})`);
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

  // Every override must land on a real economy or territory (a mistyped code
  // would otherwise silently do nothing), and never on an aggregate.
  for (const code of Object.keys(ZH_OVERRIDES)) {
    if (!overridesApplied.has(code)) throw new Error(`override '${code}' matches no economy or territory`);
  }

  // Codes are lookup keys: every iso3 and every iso2 must be unique across the
  // economies and territories, and no iso3 may be reused by an aggregate.
  const iso3Seen = new Map();
  const iso2Seen = new Map();
  for (const entry of [...economies, ...territories, ...aggregates]) {
    if (iso3Seen.has(entry.iso3)) throw new Error(`duplicate iso3 '${entry.iso3}'`);
    iso3Seen.set(entry.iso3, entry);
    if (!entry.iso2) continue;
    if (iso2Seen.has(entry.iso2)) throw new Error(`duplicate iso2 '${entry.iso2}' (${iso2Seen.get(entry.iso2).iso3} and ${entry.iso3})`);
    iso2Seen.set(entry.iso2, entry);
  }
  // wb_name is the lookup key of the by-name mode: unique across entries that have one.
  const wbNameSeen = new Set();
  for (const entry of [...economies, ...aggregates]) {
    if (wbNameSeen.has(entry.wb_name)) throw new Error(`duplicate wb_name '${entry.wb_name}'`);
    wbNameSeen.add(entry.wb_name);
  }

  const primaryKeys = { iso3: iso3Seen, iso2: iso2Seen };
  const aliases = ALIASES.map((alias) => {
    const primary = primaryKeys[alias.mode];
    if (!primary) throw new Error(`alias '${alias.alias}' names an unsupported mode '${alias.mode}'`);
    if (primary.has(alias.alias)) throw new Error(`alias '${alias.alias}' would shadow a primary ${alias.mode} code`);
    if (!primary.has(alias.target)) throw new Error(`alias '${alias.alias}' targets '${alias.target}', which is not a ${alias.mode} code in the tables`);
    return { mode: alias.mode, alias: alias.alias, target: alias.target, source: alias.source };
  });

  return {
    rules: [...RULES],
    sources: {
      wb_country_en: { file: "fixtures/external/worldbank_country_list/wb-country-en.json", bytes: en.bytes.length, sha256: sha256(en.bytes) },
      wb_country_zh: { file: "fixtures/external/worldbank_country_list/wb-country-zh.json", bytes: zh.bytes.length, sha256: sha256(zh.bytes) },
      natural_earth_admin0_50m: neSourceRecord(),
    },
    economies,
    territories,
    aggregates,
    aliases,
  };
}

function main() {
  assertPinnedToolchain();
  const nePath = process.argv[2];
  if (!nePath) {
    console.error("usage: node scripts/build_economy_names.mjs <path-to-ne_50m_admin_0_countries.geojson>");
    console.error("  (the pinned Natural Earth release; see fixtures/external/naturalearth_50m_attributes/SOURCE.json)");
    process.exit(1);
  }
  const derived = buildEconomyNames({ territoryIso2: readNeTerritoryIso2(nePath) });
  const asset = {
    schema_version: ECONOMY_NAMES_SCHEMA_VERSION,
    generated_by: "scripts/build_economy_names.mjs",
    // assertPinnedToolchain() above guarantees these equal PINNED_TOOLCHAIN.
    versions: { node: process.versions.node, icu: process.versions.icu, cldr: process.versions.cldr },
    ...derived,
  };
  writeFileSync(ECONOMY_NAMES_ASSET_PATH, JSON.stringify(asset, null, 2) + "\n");
  console.log(`wrote ${ECONOMY_NAMES_ASSET_PATH}`);
  console.log(`  economies: ${asset.economies.length}, territories: ${asset.territories.length}, aggregates: ${asset.aggregates.length}, aliases: ${asset.aliases.length}`);
  console.log(`  node=${asset.versions.node} icu=${asset.versions.icu} cldr=${asset.versions.cldr}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
