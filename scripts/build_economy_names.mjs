#!/usr/bin/env node
// Deterministically derives runtime/pi/assets/economy-names.json - the
// vendored, provenance-recorded table the newsroom viz/infographic
// renderers use to show a real Chinese place name (e.g. "刚果（金）")
// instead of leaking a World Bank English row value ("Congo, Dem. Rep.")
// onto a zh chart. The model never translates a name itself: every zh
// string this table can produce came from Unicode CLDR (via Node's bundled
// ICU, Intl.DisplayNames), from the World Bank's own zh country list
// (vendored in fixtures/external/worldbank_country_list/, see SOURCE.json
// there), or from the small policy tables below (the override table and the
// table of displayable aggregates).
//
// Inputs:
//   - the two raw World Bank Countries-and-Lending-Groups API responses
//     (v2/country, en and zh), vendored verbatim;
//   - for the Natural Earth territories the World Bank list has no row for,
//     the ISO 3166-1 alpha-2 code (ISO_A2_EH) of each territory, read from
//     the pinned full-attribute Natural Earth 50m release. That ~3MB source
//     is intentionally NOT vendored (see fixtures/external/
//     naturalearth_50m_attributes/SOURCE.json); the CLI below takes its path
//     as an argument and refuses any file whose sha256 differs from the pin;
//   - the Eurostat GEO code list (codes and English labels), vendored
//     verbatim in fixtures/external/eurostat_geo_codelist/: its <A>_X_<B>
//     codes ("China except Hong Kong") are named from A's and B's names.
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
export const DEFAULT_GEO_PATH = join(ROOT, "fixtures/external/eurostat_geo_codelist/geo.tsv");
export const NE_SOURCE_RECORD_PATH = join(ROOT, "fixtures/external/naturalearth_50m_attributes/SOURCE.json");
export const ECONOMY_NAMES_ASSET_PATH = join(ROOT, "runtime/pi/assets/economy-names.json");
export const ECONOMY_NAMES_SCHEMA_VERSION = "0.4.0";

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

// The aggregates that may ever get a display name (zh-naming-policy-1003 rule 7,
// section 3 of the policy, amended 2026-10-03). Aggregates are NEVER derived
// from the World Bank list: only these entries exist in the asset's
// `aggregates`, each carrying `policy_rule` 7, and every other aggregate code
// or name (the other World Bank aggregates such as TEA or ARB, every other
// OWID_ code, a region the table does not list) stays unresolved, so a chart
// that holds one is refused. An aggregate row belongs out of a country chart:
// the lint (runtime/pi/viz.mjs) blocks one mixed with economies on the ranking
// forms and tells the author to filter it out in SQL.
//   - `zh` is the policy table's own name; `zh_from: "worldbank"` instead takes
//     the World Bank's own zh name (the seven regions: a sourced name beats
//     losing region comparisons, and after the lint they can only appear on an
//     all-aggregate chart or as a reference series).
//   - an entry with `en_name` has no World Bank row (the six Our World in Data
//     continents): `en_name` is OWID's name for it.
//   - the income groups are 经济体, never 国家: they include Hong Kong, Macao
//     and Taiwan (rule 4).
export const AGGREGATE_POLICY_RULE = 7;
export const AGGREGATE_POLICY = Object.freeze([
  Object.freeze({ iso3: "WLD", zh: "世界" }),
  Object.freeze({ iso3: "EUU", zh: "欧盟" }),
  Object.freeze({ iso3: "HIC", zh: "高收入经济体" }),
  Object.freeze({ iso3: "UMC", zh: "中等偏上收入经济体" }),
  Object.freeze({ iso3: "LMC", zh: "中等偏下收入经济体" }),
  Object.freeze({ iso3: "LIC", zh: "低收入经济体" }),
  Object.freeze({ iso3: "EAS", zh_from: "worldbank" }),
  Object.freeze({ iso3: "ECS", zh_from: "worldbank" }),
  Object.freeze({ iso3: "LCN", zh_from: "worldbank" }),
  Object.freeze({ iso3: "MEA", zh_from: "worldbank" }),
  Object.freeze({ iso3: "NAC", zh_from: "worldbank" }),
  Object.freeze({ iso3: "SAS", zh_from: "worldbank" }),
  Object.freeze({ iso3: "SSF", zh_from: "worldbank" }),
  Object.freeze({ iso3: "OWID_AFR", en_name: "Africa", zh: "非洲" }),
  Object.freeze({ iso3: "OWID_ASI", en_name: "Asia", zh: "亚洲" }),
  Object.freeze({ iso3: "OWID_EUR", en_name: "Europe", zh: "欧洲" }),
  Object.freeze({ iso3: "OWID_NAM", en_name: "North America", zh: "北美洲" }),
  Object.freeze({ iso3: "OWID_SAM", en_name: "South America", zh: "南美洲" }),
  Object.freeze({ iso3: "OWID_OCE", en_name: "Oceania", zh: "大洋洲" }),
]);

// Documented alternate spellings of a code, per mode. `target` is a key of the
// same mode's primary table. The OWID_ codes that name an aggregate of the
// policy table below alias the World Bank code of that aggregate (the six
// continents are primary entries of their own); every other OWID_ code
// stays unresolved on purpose (aggregate rows belong out of a country chart;
// the lint tells the model to filter them in SQL).
export const ALIASES = Object.freeze([
  Object.freeze({ mode: "iso3", alias: "OWID_KOS", target: "XKX", source: "Our World in Data code for Kosovo" }),
  Object.freeze({ mode: "iso3", alias: "OWID_WRL", target: "WLD", source: "Our World in Data code for the World aggregate" }),
  Object.freeze({ mode: "iso3", alias: "OWID_EU27", target: "EUU", source: "Our World in Data code for the European Union aggregate" }),
  Object.freeze({ mode: "iso3", alias: "OWID_HIC", target: "HIC", source: "Our World in Data code for the World Bank high-income group" }),
  Object.freeze({ mode: "iso3", alias: "OWID_UMC", target: "UMC", source: "Our World in Data code for the World Bank upper-middle-income group" }),
  Object.freeze({ mode: "iso3", alias: "OWID_LMC", target: "LMC", source: "Our World in Data code for the World Bank lower-middle-income group" }),
  Object.freeze({ mode: "iso3", alias: "OWID_LIC", target: "LIC", source: "Our World in Data code for the World Bank low-income group" }),
  Object.freeze({ mode: "iso2", alias: "EL", target: "GR", source: "Eurostat geo code for Greece (ISO 3166-1 alpha-2 is GR)" }),
  Object.freeze({ mode: "iso2", alias: "UK", target: "GB", source: "Eurostat geo code for the United Kingdom (ISO 3166-1 alpha-2 is GB)" }),
]);

// Recorded verbatim in the asset so a reader of the shipped file (not just
// this script) can see how every name was chosen.
const RULES = Object.freeze([
  "zh = Unicode CLDR zh-Hans region name (Intl.DisplayNames) for the entry's ISO 3166-1 alpha-2 code.",
  "When CLDR has no name for the code (the World Bank pseudo-code JG for the Channel Islands, CHI), zh = the World Bank's own zh name, zh_source 'worldbank'. This is the one exception to policy rule 8 (an iso3 with no CLDR name is dropped and never shown in English): the World Bank's name is Chinese, a source name and not an English fallback, so the entry is kept (reviewed decision of 2026-10-03).",
  "The override table (zh_source 'override') replaces the CLDR name only where a policy rule says so; policy_rule is that rule's number and cldr_zh records what CLDR said.",
  "Natural Earth territories (the `territories` list) have no World Bank row: they resolve by ISO3 and ISO2 only, never by an English name. Their ISO2 is ISO_A2_EH of the pinned Natural Earth source (sources.natural_earth_admin0_50m); their en_name is the CLDR English region name.",
  "Aggregates are never derived from the World Bank list: only the entries of the explicit policy table (policy rule 7) exist in `aggregates`, each with policy_rule 7, and every other aggregate code or name does not resolve, so a chart that holds one is refused. The seven World Bank regions keep the World Bank's zh names (zh_source 'worldbank'); the others take the policy table's name (zh_source 'policy', wb_zh records what the World Bank said where it has a name). The income groups are 经济体, never 国家, because they include Hong Kong, Macao and Taiwan. Aggregate rows belong out of a country chart; use them only when the aggregate itself is the subject.",
  "`aliases` map a documented alternate code to a primary key of the same mode; any other code that is not a primary key does not resolve.",
  "Except codes (the `except_places` list): every code <A>_X_<B> of the vendored Eurostat GEO code list (sources.eurostat_geo_codelist) whose A and B are both iso2 codes of the tables (an economy, a territory or an iso2 alias) and B two letters is named zh = A's zh name in the tables + '（不含' + B's Unicode CLDR zh-Hans short region name (Intl.DisplayNames style 'short'; B's zh name in the tables where CLDR has none) + '）', zh_source 'composed'; en_name is Eurostat's own label. B is named inside A, so it takes the short name (香港, not the override 中国香港 a place gets on its own). Nothing is written per code: an except code whose A or B the tables do not name (EU27_2020_X_DK, EEA_X_LI) stays unnamed, as A itself does. An except code is another place than A: it resolves in the iso2 mode only, by its own code, and names no map feature (no iso3).",
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

// The Eurostat GEO code list as [code, label] rows: tab-separated, no header, CRLF or LF line ends.
function loadGeoCodelist(path) {
  const bytes = readFileSync(path);
  const rows = bytes.toString("utf8").split(/\r?\n/).filter((line) => line.length).map((line) => line.split("\t"));
  const bad = rows.find((row) => row.length !== 2 || !row[0] || !row[1].trim());
  if (bad) throw new Error(`${path}: expected tab-separated code and label rows, found ${JSON.stringify(bad)}`);
  return { bytes, rows: rows.map(([code, label]) => [code, label.trim()]) };
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
 * aliases tables (the aggregates are exactly the entries of
 * AGGREGATE_POLICY). Throws if any included zh name would be empty or contain
 * Latin letters, if an override, an aggregate policy entry or an alias does
 * not land on a real entry, or if a code is not unique (a real World
 * Bank/CLDR data change or fixture corruption, never something to route
 * around).
 *
 * `territoryIso2` is the iso3 -> iso2 map of the TERRITORY_ISO3 entries
 * (readNeTerritoryIso2() produces it from the pinned Natural Earth file; a
 * test without that file may pass the values stored in the committed asset).
 *
 * `aggregatePolicy` is AGGREGATE_POLICY and `aliasTable` is ALIASES; a test
 * passes other tables to prove the aggregates are exactly the policy table's
 * entries and that a bad entry aborts the build.
 *
 * `geoPath` is the Eurostat GEO code list whose <A>_X_<B> codes become
 * `except_places` (a test passes another list to prove the rule is generic).
 *
 * @param {{enPath?: string, zhPath?: string, geoPath?: string, territoryIso2: Record<string, string>, aggregatePolicy?: readonly object[], aliasTable?: readonly object[]}} options
 */
export function buildEconomyNames({ enPath = DEFAULT_EN_PATH, zhPath = DEFAULT_ZH_PATH, geoPath = DEFAULT_GEO_PATH, territoryIso2, aggregatePolicy = AGGREGATE_POLICY, aliasTable = ALIASES } = {}) {
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
    .sort((a, b) => a.iso3.localeCompare(b.iso3, "en-US"));

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
    .sort((a, b) => a.iso3.localeCompare(b.iso3, "en-US"));

  // Aggregates are exactly the entries of AGGREGATE_POLICY (policy rule 7), in
  // code order: the policy table names which aggregates exist, nothing is
  // derived from the World Bank list. A table entry that does not land on a
  // real World Bank aggregate (or, for an OWID continent, that collides with a
  // World Bank row) aborts the build, so a typo cannot silently do nothing.
  const enById = new Map(en.rows.map((row) => [row.id, row]));
  const aggregates = aggregatePolicy
    .map((policy) => {
      const iso3 = policy.iso3;
      const enRow = enById.get(iso3);
      let entry;
      if (policy.en_name) {
        if (enRow) throw new Error(`economy-names build: aggregate policy entry '${iso3}' carries its own English name but the World Bank list has a row for it`);
        entry = { iso3, en_name: policy.en_name, zh: policy.zh, zh_source: "policy", policy_rule: AGGREGATE_POLICY_RULE };
      } else {
        if (!enRow) throw new Error(`economy-names build: aggregate policy entry '${iso3}' is not present in the World Bank en list`);
        if (enRow.region?.value !== "Aggregates") throw new Error(`economy-names build: aggregate policy entry '${iso3}' is an economy in the World Bank list, not an aggregate`);
        const wb_name = String(enRow.name ?? "").trim();
        entry = policy.zh_from === "worldbank"
          ? { iso3, wb_name, zh: worldBankZh(iso3), zh_source: "worldbank", policy_rule: AGGREGATE_POLICY_RULE }
          : { iso3, wb_name, zh: policy.zh, zh_source: "policy", policy_rule: AGGREGATE_POLICY_RULE, wb_zh: worldBankZh(iso3) };
      }
      assertZhName(entry.zh, `aggregate ${iso3}`);
      return entry;
    })
    .sort((a, b) => (a.iso3 < b.iso3 ? -1 : a.iso3 > b.iso3 ? 1 : 0));

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
    if (entry.wb_name === undefined) continue; // an OWID continent has no World Bank name
    if (wbNameSeen.has(entry.wb_name)) throw new Error(`duplicate wb_name '${entry.wb_name}'`);
    wbNameSeen.add(entry.wb_name);
  }

  const primaryKeys = { iso3: iso3Seen, iso2: iso2Seen };
  const aliases = aliasTable.map((alias) => {
    const primary = primaryKeys[alias.mode];
    if (!primary) throw new Error(`alias '${alias.alias}' names an unsupported mode '${alias.mode}'`);
    if (primary.has(alias.alias)) throw new Error(`alias '${alias.alias}' would shadow a primary ${alias.mode} code`);
    if (!primary.has(alias.target)) throw new Error(`alias '${alias.alias}' targets '${alias.target}', which is not a ${alias.mode} code in the tables`);
    return { mode: alias.mode, alias: alias.alias, target: alias.target, source: alias.source };
  });

  // Except codes, in code order: one rule for every <A>_X_<B> of the code list whose A and B the iso2 table names (see RULES).
  const geo = loadGeoCodelist(geoPath);
  const regionZhShort = new Intl.DisplayNames(["zh-Hans"], { type: "region", style: "short" });
  const iso2Entry = (code) => iso2Seen.get(aliases.find((alias) => alias.mode === "iso2" && alias.alias === code)?.target ?? code);
  const except_places = geo.rows
    .map(([code, label]) => ({ code, label, parts: /^(.+)_X_([A-Z]{2})$/.exec(code) }))
    .filter(({ parts }) => parts && iso2Entry(parts[1]) && iso2Entry(parts[2]))
    .map(({ code, label, parts: [, of, except] }) => {
      if (iso2Seen.has(code) || aliases.some((alias) => alias.alias === code)) throw new Error(`except code '${code}' would shadow an iso2 code`);
      const exceptZh = cldrName(regionZhShort, except) ?? iso2Entry(except).zh;
      const entry = { code, of, except, en_name: label, zh: `${iso2Entry(of).zh}（不含${exceptZh}）`, zh_source: "composed" };
      assertZhName(entry.zh, `except code ${code}`);
      return entry;
    })
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    rules: [...RULES],
    sources: {
      wb_country_en: { file: "fixtures/external/worldbank_country_list/wb-country-en.json", bytes: en.bytes.length, sha256: sha256(en.bytes) },
      wb_country_zh: { file: "fixtures/external/worldbank_country_list/wb-country-zh.json", bytes: zh.bytes.length, sha256: sha256(zh.bytes) },
      natural_earth_admin0_50m: neSourceRecord(),
      eurostat_geo_codelist: { file: "fixtures/external/eurostat_geo_codelist/geo.tsv", bytes: geo.bytes.length, sha256: sha256(geo.bytes) },
    },
    economies,
    territories,
    aggregates,
    aliases,
    except_places,
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
  console.log(`  economies: ${asset.economies.length}, territories: ${asset.territories.length}, aggregates: ${asset.aggregates.length}, aliases: ${asset.aliases.length}, except places: ${asset.except_places.length}`);
  console.log(`  node=${asset.versions.node} icu=${asset.versions.icu} cldr=${asset.versions.cldr}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
