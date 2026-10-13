#!/usr/bin/env node
// Covers the vendored name tables end to end:
//   runtime/pi/assets/economy-names.json (the World Bank country list in
//   fixtures/external/worldbank_country_list/, Unicode CLDR through Node's ICU,
//   the 22 Natural Earth territories, the policy override table and the alias
//   codes) and runtime/pi/assets/currency-names.json (CLDR currency names plus
//   the AUD and CAD short names):
//   - each committed asset is exactly what its builder derives right now (not
//     stale, not hand-edited) - versions/generated_by/schema_version excluded,
//     since those are build-machine facts, not derived content. The economy
//     table derives identically under every Node CI uses. The currency table
//     matches exactly on the pinned toolchain; on any other one (CI runs Node
//     22: ICU 77.1 / CLDR 47.0) this is a cross-version check: only the nine
//     explicit (code, field, committed value, derived value) tuples that CLDR
//     47 words differently (KGS en; XCG and ZWG, which CLDR 47 has no zh name
//     for) may differ, never a whole entry, and on CLDR 47.0 itself every one
//     of them must show up. The territory ISO2 codes are re-derived from the
//     pinned Natural Earth release when NE_SOURCE_PATH points at it
//     (sha256-checked); without it that check prints SKIP, because the only
//     codes left to compare would be the committed asset's own;
//   - the 217/22/19 economy/territory/aggregate counts and the exact aggregate
//     ID set: the aggregates are the explicit policy table's entries (policy
//     rule 7), never derived from the World Bank list, each carries its rule
//     number, and every other aggregate code or name stays unresolved;
//   - the specific name checks (Congo Dem. Rep. / Congo Rep. and neighbouring
//     Sub-Saharan African economies, Channel Islands falling back to the World
//     Bank zh name because CLDR has no name for pseudo-code "JG", and the
//     LCN/SSF aggregate zh names), the 22 territories, and the policy override
//     table with the rule number that authorizes each entry
//     (zh-naming-policy-1003: rules 3, 5 and 6 for places, rule 9 for two
//     currencies);
//   - every zh name in the shipped assets is non-empty and Latin-letter-free
//     (defence in depth: the builders already assert this at build time, but
//     this re-checks the committed bytes themselves, so a hand-edit that skips
//     the build cannot silently reintroduce a leaked English/code string);
//   - runtime/pi/economy_names.mjs's resolver: category_names "worldbank",
//     "iso3", "iso2" and "iso4217", the alias codes (OWID_KOS, OWID_WRL, the OWID_
//     income groups and OWID_EU27, EL, UK), the OWID_ continents, aggregates
//     staying unresolved in the ISO2 mode, "en" passthrough or expansion, and
//     unmapped-value detection for lintVizSpec's blocker.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGGREGATE_POLICY,
  AGGREGATE_POLICY_RULE,
  ALIASES,
  assertPinnedToolchain,
  buildEconomyNames,
  DEFAULT_EN_PATH,
  ECONOMY_NAMES_ASSET_PATH,
  ECONOMY_NAMES_SCHEMA_VERSION,
  PINNED_TOOLCHAIN,
  readNeTerritoryIso2,
  TERRITORY_ISO3,
  ZH_OVERRIDES,
} from "./build_economy_names.mjs";
import { buildCurrencyNames, CURRENCY_NAMES_ASSET_PATH, CURRENCY_NAMES_SCHEMA_VERSION, CURRENCY_ZH_OVERRIDES } from "./build_currency_names.mjs";
import {
  CATEGORY_NAME_MODES,
  CURRENCY_NAME_MODES,
  ECONOMY_NAME_MODES,
  economyEntryFor,
  resolveEconomyDisplayName,
  unmappedEconomyNameValues,
} from "../runtime/pi/economy_names.mjs";

const asset = JSON.parse(readFileSync(ECONOMY_NAMES_ASSET_PATH, "utf8"));
const currencyAsset = JSON.parse(readFileSync(CURRENCY_NAMES_ASSET_PATH, "utf8"));
const live = { node: process.versions.node, icu: process.versions.icu, cldr: process.versions.cldr };
const onPinnedToolchain = Object.keys(PINNED_TOOLCHAIN).every((key) => live[key] === PINNED_TOOLCHAIN[key]);

// -- the toolchain pin: both assets record it, the builders refuse anything else --
assert.deepEqual(asset.versions, PINNED_TOOLCHAIN, "economy-names.json was generated with the pinned toolchain");
assert.deepEqual(currencyAsset.versions, PINNED_TOOLCHAIN, "currency-names.json was generated with the pinned toolchain");
assert.doesNotThrow(() => assertPinnedToolchain(PINNED_TOOLCHAIN));
for (const key of Object.keys(PINNED_TOOLCHAIN)) {
  assert.throws(() => assertPinnedToolchain({ ...PINNED_TOOLCHAIN, [key]: "0.0.0" }), /refusing to build/, `a different ${key} is refused`);
}

// -- committed economy asset matches a fresh derivation --
assert.equal(asset.schema_version, ECONOMY_NAMES_SCHEMA_VERSION);
const nePath = process.env.NE_SOURCE_PATH;
const committedTerritoryIso2 = Object.fromEntries(asset.territories.map((territory) => [territory.iso3, territory.iso2]));
// The territory ISO2 codes are the one derived fact the repository cannot re-derive: they come from the pinned Natural
// Earth release (3MB, pinned by hash, not vendored). The derivation below needs some codes as input; without the release
// the only codes at hand are the committed asset's own, so that part of the comparison would be the asset compared with
// itself. It is skipped out loud and left out of the territories comparison instead of passing silently. (The codes are
// still compared with the hand-written EXPECTED_TERRITORIES list below, which does not read the release either.)
let territoryIso2 = committedTerritoryIso2;
const territoryIso2Rederived = Boolean(nePath);
const TERRITORY_ISO2_SKIP_REASON = "NE_SOURCE_PATH is not set, so the iso2 codes of the 22 territories are not re-derived from the pinned Natural Earth release (they are still compared with the expected list in this test; set NE_SOURCE_PATH to the pinned ne_50m_admin_0_countries.geojson to re-derive them)";
if (territoryIso2Rederived) {
  territoryIso2 = readNeTerritoryIso2(nePath);
  assert.deepEqual(territoryIso2, committedTerritoryIso2, "the territory ISO2 codes equal ISO_A2_EH of the pinned Natural Earth release");
} else {
  if (process.env.NEWSROOM_REQUIRE_NO_SKIP === "1") throw new Error(`section cannot run, and the run requires none to be skipped: ${TERRITORY_ISO2_SKIP_REASON}`);
  console.log(`SKIP territory ISO2 re-derivation: ${TERRITORY_ISO2_SKIP_REASON}`);
}
{
  // The reader refuses anything but the pinned release (it never guesses), and the derivation refuses to run without codes.
  const dir = mkdtempSync(join(tmpdir(), "economy-names-ne-"));
  try {
    const bogus = join(dir, "ne.geojson");
    writeFileSync(bogus, JSON.stringify({ type: "FeatureCollection", features: [] }));
    assert.throws(() => readNeTerritoryIso2(bogus), /does not match the recorded Natural Earth release/);
    assert.throws(() => readNeTerritoryIso2(""), /path of the pinned/);
    assert.throws(() => buildEconomyNames({}), /territoryIso2 .* is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const derived = buildEconomyNames({ territoryIso2 });
assert.deepEqual(derived.rules, asset.rules, "rules block must match a fresh derivation");
assert.deepEqual(derived.sources, asset.sources, "sources block (file/bytes/sha256) must match a fresh derivation");
assert.deepEqual(derived.economies, asset.economies, "economies table must match a fresh derivation (not stale/hand-edited)");
if (territoryIso2Rederived) {
  assert.deepEqual(derived.territories, asset.territories, "territories table must match a fresh derivation (not stale/hand-edited)");
} else {
  // The iso2 field was fed from the asset itself, so it says nothing here: everything else about a territory still must match.
  const withoutIso2 = (territories) => territories.map(({ iso2, ...rest }) => rest);
  assert.deepEqual(withoutIso2(derived.territories), withoutIso2(asset.territories), "territories table (iso2 not re-derived) must match a fresh derivation (not stale/hand-edited)");
}
assert.deepEqual(derived.aggregates, asset.aggregates, "aggregates table must match a fresh derivation (not stale/hand-edited)");
assert.deepEqual(derived.aliases, asset.aliases, "aliases table must match a fresh derivation (not stale/hand-edited)");
assert.equal(asset.sources.natural_earth_admin0_50m.vendored, false, "the 3MB Natural Earth source is pinned by hash, not vendored");

// -- committed currency asset vs a fresh derivation --
assert.equal(currencyAsset.schema_version, CURRENCY_NAMES_SCHEMA_VERSION);
const derivedCurrencies = buildCurrencyNames();
assert.deepEqual(derivedCurrencies.rules, currencyAsset.rules, "currency rules block must match a fresh derivation");
assert.deepEqual(derivedCurrencies.source, currencyAsset.source, "currency source block must match a fresh derivation");

// What CLDR 47.0 (ICU 77.1; Node 22.19.0, the toolchain CI runs) words differently from the pinned CLDR 48.0, as explicit
// [code, field, committed value, derived value] tuples, null meaning the field is absent. KGS: CLDR 47 says "Kyrgystani Som"
// where CLDR 48 says "Kyrgyz Som". XCG and ZWG: CLDR 47 has no zh-Hans name for them, so the builder lists them as excluded
// and every field of their entries is absent (excluded_reason is the reason of the excluded entry). A tuple stands for that
// one change and nothing else: another field of the same code, or another value of the same field, is a difference nobody
// has looked at, so it fails.
const CLDR_47_CURRENCY_DIFFERENCES = [
  ["KGS", "en", "Kyrgyz Som", "Kyrgystani Som"],
  ["XCG", "en", "Caribbean guilder", null],
  ["XCG", "excluded_reason", null, "no CLDR zh-Hans display name"],
  ["XCG", "zh", "加勒比盾", null],
  ["XCG", "zh_source", "cldr", null],
  ["ZWG", "en", "Zimbabwean Gold", null],
  ["ZWG", "excluded_reason", null, "no CLDR zh-Hans display name"],
  ["ZWG", "zh", "津巴布韦金元", null],
  ["ZWG", "zh_source", "cldr", null],
];
const tupleKey = (tuple) => JSON.stringify(tuple);
const sortedKeys = (tuples) => tuples.map(tupleKey).sort();

// Every (code, field, committed value, derived value) in which two currency tables differ: per code the fields of its named
// entry plus the reason of its excluded entry, so a code that moves between `currencies` and `excluded` shows up field by field.
function currencyDifferences(committed, derivedTable) {
  const fieldsByCode = (table) => {
    const fields = new Map();
    for (const { code, ...rest } of table.currencies) fields.set(code, { ...rest });
    for (const { code, reason } of table.excluded) fields.set(code, { ...(fields.get(code) ?? {}), excluded_reason: reason });
    return fields;
  };
  const [was, now] = [committed, derivedTable].map(fieldsByCode);
  const differences = [];
  for (const code of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const [before, after] = [was.get(code) ?? {}, now.get(code) ?? {}];
    for (const field of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if ((before[field] ?? null) !== (after[field] ?? null)) differences.push([code, field, before[field] ?? null, after[field] ?? null]);
    }
  }
  return differences;
}
// The differences that are not exactly one of the listed tuples.
function unlistedCurrencyDifferences(differences) {
  const listed = new Set(CLDR_47_CURRENCY_DIFFERENCES.map(tupleKey));
  return differences.filter((tuple) => !listed.has(tupleKey(tuple)));
}

// The tolerance is exact, whichever toolchain runs this: it takes the listed tuples and nothing else, never a whole entry.
{
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const entry = (table, code) => table.currencies.find((candidate) => candidate.code === code);
  const exclude = (table, code, reason = "no CLDR zh-Hans display name") => {
    table.currencies = table.currencies.filter((candidate) => candidate.code !== code);
    table.excluded.push({ code, reason });
  };
  const asCldr47 = () => {
    const table = clone(currencyAsset);
    entry(table, "KGS").en = "Kyrgystani Som";
    exclude(table, "XCG");
    exclude(table, "ZWG");
    return table;
  };
  assert.deepEqual(currencyDifferences(currencyAsset, clone(currencyAsset)), [], "a table does not differ from itself");
  assert.deepEqual(sortedKeys(currencyDifferences(currencyAsset, asCldr47())), sortedKeys(CLDR_47_CURRENCY_DIFFERENCES), "the listed tuples are what CLDR 47 does to the committed table");
  assert.deepEqual(unlistedCurrencyDifferences(currencyDifferences(currencyAsset, asCldr47())), [], "the listed tuples are tolerated");
  // Each of these is a code that has a tuple, or a code that has none, changed one step further than the tuple says.
  const unlistedAfter = (edit, committed = currencyAsset) => {
    const table = asCldr47();
    edit(table);
    return unlistedCurrencyDifferences(currencyDifferences(committed, table));
  };
  assert.deepEqual(unlistedAfter((t) => { entry(t, "KGS").zh = "吉尔吉斯索姆"; }), [["KGS", "zh", "吉尔吉斯斯坦索姆", "吉尔吉斯索姆"]], "another field of KGS");
  assert.deepEqual(unlistedAfter((t) => { entry(t, "KGS").en = "Kyrgyz Soms"; }), [["KGS", "en", "Kyrgyz Som", "Kyrgyz Soms"]], "another value of KGS en");
  assert.deepEqual(unlistedAfter((t) => { entry(t, "KGS").zh_source = "override"; }), [["KGS", "zh_source", "cldr", "override"]], "a field KGS never had a tuple for");
  const keptXcg = (t) => { t.excluded = t.excluded.filter((candidate) => candidate.code !== "XCG"); t.currencies.push({ code: "XCG", en: "Caribbean guilder", zh: "加勒比盾元", zh_source: "cldr" }); };
  assert.deepEqual(unlistedAfter(keptXcg), [["XCG", "zh", "加勒比盾", "加勒比盾元"]], "XCG named differently instead of excluded");
  assert.deepEqual(unlistedAfter((t) => { t.excluded.find((candidate) => candidate.code === "ZWG").reason = "no usable zh-Hans display name"; }), [["ZWG", "excluded_reason", null, "no usable zh-Hans display name"]], "ZWG excluded for another reason");
  assert.deepEqual(unlistedAfter((t) => { entry(t, "AED").en = "UAE Dirham"; }), [["AED", "en", "United Arab Emirates Dirham", "UAE Dirham"]], "a code with no tuple at all");
  assert.deepEqual(unlistedAfter((t) => exclude(t, "TRY")).map(([code]) => code), ["TRY", "TRY", "TRY", "TRY"], "another code excluded");
  // The committed value has to be the one the tuple names, not just the derived one.
  const committedElsewhere = clone(currencyAsset);
  entry(committedElsewhere, "KGS").en = "Kyrgyz Soms";
  assert.deepEqual(unlistedAfter(() => {}, committedElsewhere), [["KGS", "en", "Kyrgyz Soms", "Kyrgystani Som"]], "the committed value is part of the tuple");
}

const currencyDifferenceList = currencyDifferences(currencyAsset, derivedCurrencies);
const spellTuple = ([code, field, was, now]) => `${code} ${field}: ${was ?? "(absent)"} -> ${now ?? "(absent)"}`;
const currencyCheck = { mode: onPinnedToolchain ? "exact match on the pinned toolchain" : "cross-version check", tolerated: onPinnedToolchain ? [] : currencyDifferenceList.map(spellTuple) };
if (onPinnedToolchain) {
  assert.deepEqual(currencyDifferenceList, [], "the currencies table must match a fresh derivation exactly on the pinned toolchain");
  assert.deepEqual(derivedCurrencies.currencies, currencyAsset.currencies, "the currencies table must match a fresh derivation exactly on the pinned toolchain, order included");
  assert.deepEqual(derivedCurrencies.excluded, currencyAsset.excluded, "the excluded list must match a fresh derivation exactly on the pinned toolchain");
} else {
  assert.deepEqual(
    unlistedCurrencyDifferences(currencyDifferenceList),
    [],
    `cross-version check on node ${live.node} / ICU ${live.icu} / CLDR ${live.cldr} (the pin is ${PINNED_TOOLCHAIN.node} / ${PINNED_TOOLCHAIN.icu} / ${PINNED_TOOLCHAIN.cldr}): only the listed (code, field, committed value, derived value) tuples may differ from the committed currencies table`,
  );
  // On the toolchain the tuples were recorded on every one of them shows up, so none is stale or hiding something else.
  if (live.icu === "77.1" && live.cldr === "47.0") {
    assert.deepEqual(sortedKeys(currencyDifferenceList), sortedKeys(CLDR_47_CURRENCY_DIFFERENCES), "on CLDR 47.0 exactly the listed tuples differ from the committed currencies table");
  }
  console.log(`cross-version check: node ${live.node} / CLDR ${live.cldr} is not the pinned toolchain, so the currencies table was compared tuple by tuple: ${currencyDifferenceList.length} (code, field, committed value, derived value) differences, all of them listed (${[...new Set(currencyDifferenceList.map(([code]) => code))].join(", ") || "none"})`);
}
// Every code the toolchain knows is named or recorded as excluded, never silently missing.
{
  const covered = new Set([...currencyAsset.currencies, ...currencyAsset.excluded].map((entry) => entry.code));
  for (const code of Intl.supportedValuesOf("currency")) assert.ok(covered.has(code), `currency ${code} is neither in currencies nor in excluded`);
  assert.equal(currencyAsset.currencies.length, 162);
  assert.deepEqual(currencyAsset.excluded, [], "no currency is excluded on the pinned toolchain");
}

// -- counts --
assert.equal(asset.economies.length, 217, "217 economies (region.value !== 'Aggregates')");
assert.equal(asset.territories.length, 22, "22 Natural Earth territories without a World Bank row");
assert.equal(asset.aggregates.length, 19, "the aggregate policy table: WLD, EUU, four income groups, seven World Bank regions, six OWID continents");
assert.equal(asset.aliases.length, 9, "OWID_KOS, OWID_WRL, OWID_EU27, the four OWID_ income groups, EL and UK");
assert.deepEqual(asset.territories.map((entry) => entry.iso3).sort(), [...TERRITORY_ISO3].sort());

// -- exact aggregate ID set: the explicit policy table (zh-naming-policy-1003 rule 7), never derived from the World Bank list --
const aggregateIds = asset.aggregates.map((a) => a.iso3).sort();
assert.deepEqual(aggregateIds, [
  "EAS", "ECS", "EUU", "HIC", "LCN", "LIC", "LMC", "MEA", "NAC", "OWID_AFR", "OWID_ASI", "OWID_EUR", "OWID_NAM", "OWID_OCE", "OWID_SAM", "SAS", "SSF", "UMC", "WLD",
]);
assert.deepEqual(AGGREGATE_POLICY.map((policy) => policy.iso3).sort(), aggregateIds, "the asset holds exactly the policy table's aggregates");
assert.equal(AGGREGATE_POLICY_RULE, 7);
assert.ok(Object.isFrozen(AGGREGATE_POLICY) && AGGREGATE_POLICY.every((policy) => Object.isFrozen(policy)), "the policy table cannot be mutated by a caller");
// Section 3 of the policy plus the amended rule 7: the name of every displayable aggregate and where it comes from.
const EXPECTED_AGGREGATES = {
  WLD: ["世界", "policy"], EUU: ["欧盟", "policy"],
  HIC: ["高收入经济体", "policy"], UMC: ["中等偏上收入经济体", "policy"], LMC: ["中等偏下收入经济体", "policy"], LIC: ["低收入经济体", "policy"],
  OWID_AFR: ["非洲", "policy"], OWID_ASI: ["亚洲", "policy"], OWID_EUR: ["欧洲", "policy"], OWID_NAM: ["北美洲", "policy"], OWID_SAM: ["南美洲", "policy"], OWID_OCE: ["大洋洲", "policy"],
  EAS: ["东亚与太平洋地区", "worldbank"], ECS: ["欧洲与中亚地区", "worldbank"], LCN: ["拉丁美洲与加勒比海地区", "worldbank"], MEA: ["中东、北非、阿富汗与巴基斯坦", "worldbank"],
  NAC: ["北美", "worldbank"], SAS: ["南亚", "worldbank"], SSF: ["撒哈拉以南非洲地区", "worldbank"],
};
assert.deepEqual(
  Object.fromEntries(asset.aggregates.map((entry) => [entry.iso3, [entry.zh, entry.zh_source]])),
  EXPECTED_AGGREGATES,
  "every displayable aggregate: zh name and whether the policy table or the World Bank named it",
);
for (const entry of asset.aggregates) {
  assert.equal(entry.policy_rule, 7, `aggregate ${entry.iso3} carries its policy rule number`);
  assert.equal("wb_zh" in entry, entry.zh_source === "policy" && "wb_name" in entry, `aggregate ${entry.iso3}: wb_zh records the World Bank's own name wherever the policy table replaced one`);
}
// The income groups include Hong Kong, Macao and Taiwan, so they are 经济体, never 国家 (rule 4).
for (const code of ["HIC", "UMC", "LMC", "LIC"]) assert.match(asset.aggregates.find((entry) => entry.iso3 === code).zh, /收入经济体$/, `${code} is an economy group`);
{
  // Nothing is derived from the World Bank list: the aggregates are exactly the table passed in, and a bad entry aborts the build.
  const build = (aggregatePolicy) => buildEconomyNames({ territoryIso2, aggregatePolicy, aliasTable: [] }); // the alias table targets the real aggregates
  assert.deepEqual(build([{ iso3: "WLD", zh: "世界" }]).aggregates.map((entry) => entry.iso3), ["WLD"], "a one-entry table yields one aggregate, whatever else the World Bank lists");
  assert.deepEqual(build([]).aggregates, [], "an empty table yields none");
  assert.deepEqual(build([{ iso3: "WLD", zh: "世界" }, { iso3: "EAS", zh_from: "worldbank" }]).aggregates.map((entry) => entry.iso3), ["EAS", "WLD"], "sorted by code");
  assert.throws(() => build([{ iso3: "ZZZ", zh: "某地" }]), /'ZZZ' is not present in the World Bank en list/);
  assert.throws(() => build([{ iso3: "USA", zh: "某地" }]), /'USA' is an economy in the World Bank list, not an aggregate/);
  assert.throws(() => build([{ iso3: "WLD", en_name: "World", zh: "世界" }]), /carries its own English name but the World Bank list has a row/);
  assert.throws(() => build([{ iso3: "WLD", zh: "World" }]), /contains Latin letters/);
  assert.throws(() => build([{ iso3: "WLD", zh: "" }]), /empty zh name/);
  assert.throws(() => build([{ iso3: "AFR", zh_from: "worldbank" }]), /empty zh name for aggregate AFR/, "the World Bank has no zh name for AFR, so it cannot take one from there");
  assert.throws(() => build([{ iso3: "WLD", zh: "世界" }, { iso3: "WLD", zh: "世界" }]), /duplicate iso3 'WLD'/);
  assert.equal(build([{ iso3: "OWID_AFR", en_name: "Africa", zh: "非洲" }, { iso3: "OWID_ASI", en_name: "Asia", zh: "亚洲" }]).aggregates.length, 2, "entries without a World Bank name are not checked for a duplicate wb_name");
}

// -- codes are lookup keys: unique, well formed, and disjoint across the three lists --
{
  const everything = [...asset.economies, ...asset.territories, ...asset.aggregates];
  assert.equal(new Set(everything.map((entry) => entry.iso3)).size, everything.length, "every iso3 is unique across economies, territories and aggregates");
  const withIso2 = [...asset.economies, ...asset.territories];
  assert.equal(new Set(withIso2.map((entry) => entry.iso2)).size, withIso2.length, "every iso2 is unique across economies and territories");
  for (const entry of [...asset.economies, ...asset.territories]) assert.match(entry.iso3, /^[A-Z]{3}$/, `${entry.iso3} is three capital letters`);
  for (const entry of asset.aggregates) assert.match(entry.iso3, /^(?:[A-Z]{3}|OWID_[A-Z]{3})$/, `${entry.iso3} is three capital letters or an OWID_ continent code`);
  for (const entry of withIso2) assert.match(entry.iso2, /^[A-Z]{2}$/, `${entry.iso3}'s iso2 is two capital letters`);
  for (const aggregate of asset.aggregates) assert.equal("iso2" in aggregate, false, `aggregate ${aggregate.iso3} has no iso2`);
  for (const territory of asset.territories) assert.equal("wb_name" in territory, false, `territory ${territory.iso3} has no World Bank name`);
}

// -- specific economy checks: Sub-Saharan African economies that must
// resolve through CLDR, plus Channel Islands which must fall back to the
// World Bank zh name because CLDR returns the bare code "JG" for it --
const byIso3 = new Map(asset.economies.map((e) => [e.iso3, e]));
const expectedEconomies = {
  COD: { iso2: "CD", wb_name: "Congo, Dem. Rep.", zh: "刚果（金）", zh_source: "override" },
  COG: { iso2: "CG", wb_name: "Congo, Rep.", zh: "刚果（布）", zh_source: "override" },
  NER: { iso2: "NE", wb_name: "Niger", zh: "尼日尔", zh_source: "cldr" },
  NGA: { iso2: "NG", wb_name: "Nigeria", zh: "尼日利亚", zh_source: "cldr" },
  LBR: { iso2: "LR", wb_name: "Liberia", zh: "利比里亚", zh_source: "cldr" },
  ZMB: { iso2: "ZM", wb_name: "Zambia", zh: "赞比亚", zh_source: "cldr" },
  GIN: { iso2: "GN", wb_name: "Guinea", zh: "几内亚", zh_source: "cldr" },
  SLE: { iso2: "SL", wb_name: "Sierra Leone", zh: "塞拉利昂", zh_source: "cldr" },
  TCD: { iso2: "TD", wb_name: "Chad", zh: "乍得", zh_source: "cldr" },
  SSD: { iso2: "SS", wb_name: "South Sudan", zh: "南苏丹", zh_source: "cldr" },
  MRT: { iso2: "MR", wb_name: "Mauritania", zh: "毛里塔尼亚", zh_source: "cldr" },
  CHI: { iso2: "JG", wb_name: "Channel Islands", zh: "海峡群岛", zh_source: "worldbank" },
  // The English names that changed (Eswatini, Turkiye, Czechia) keep the Chinese names the mainland uses.
  SWZ: { iso2: "SZ", wb_name: "Eswatini", zh: "斯威士兰", zh_source: "cldr" },
  TUR: { iso2: "TR", wb_name: "Turkiye", zh: "土耳其", zh_source: "cldr" },
  CZE: { iso2: "CZ", wb_name: "Czechia", zh: "捷克", zh_source: "cldr" },
  CIV: { iso2: "CI", wb_name: "Cote d'Ivoire", zh: "科特迪瓦", zh_source: "cldr" },
};
for (const [iso3, expected] of Object.entries(expectedEconomies)) {
  const entry = byIso3.get(iso3);
  assert.ok(entry, `economy ${iso3} must be present`);
  assert.deepEqual({ iso2: entry.iso2, wb_name: entry.wb_name, zh: entry.zh, zh_source: entry.zh_source }, expected, `economy ${iso3}`);
}
// CHI keeps the World Bank's own zh name: it is a source name in Chinese, not an English fallback, so it is the one exception to policy rule 8
// (an iso3 with no CLDR zh name is dropped). The exception and its reason are recorded in the shipped asset's rules.
assert.ok(
  asset.rules.some((rule) => rule.includes("CHI") && rule.includes("exception to policy rule 8") && rule.includes("not an English fallback")),
  "the CHI exception to policy rule 8 and its reason are recorded in the rules list",
);
assert.deepEqual(asset.economies.filter((entry) => entry.zh_source === "worldbank").map((entry) => entry.iso3), ["CHI"], "CHI is the only economy named by the World Bank rather than CLDR");

// -- the 22 Natural Earth territories: ISO3 -> [ISO2, CLDR English name, CLDR zh name] --
const EXPECTED_TERRITORIES = {
  AIA: ["AI", "Anguilla", "安圭拉"],
  ALA: ["AX", "Åland Islands", "奥兰群岛"],
  ATA: ["AQ", "Antarctica", "南极洲"],
  ATF: ["TF", "French Southern Territories", "法属南部领地"],
  BLM: ["BL", "St. Barthélemy", "圣巴泰勒米"],
  COK: ["CK", "Cook Islands", "库克群岛"],
  ESH: ["EH", "Western Sahara", "西撒哈拉"],
  FLK: ["FK", "Falkland Islands", "福克兰群岛"],
  GGY: ["GG", "Guernsey", "根西岛"],
  HMD: ["HM", "Heard & McDonald Islands", "赫德岛和麦克唐纳群岛"],
  IOT: ["IO", "British Indian Ocean Territory", "英属印度洋领地"],
  JEY: ["JE", "Jersey", "泽西岛"],
  MSR: ["MS", "Montserrat", "蒙特塞拉特"],
  NFK: ["NF", "Norfolk Island", "诺福克岛"],
  NIU: ["NU", "Niue", "纽埃"],
  PCN: ["PN", "Pitcairn Islands", "皮特凯恩群岛"],
  SGS: ["GS", "South Georgia & South Sandwich Islands", "南乔治亚和南桑威奇群岛"],
  SHN: ["SH", "St. Helena", "圣赫勒拿"],
  SPM: ["PM", "St. Pierre & Miquelon", "圣皮埃尔和密克隆群岛"],
  TWN: ["TW", "Taiwan", "中国台湾"],
  VAT: ["VA", "Vatican City", "梵蒂冈"],
  WLF: ["WF", "Wallis & Futuna", "瓦利斯和富图纳"],
};
assert.deepEqual(
  Object.fromEntries(asset.territories.map((t) => [t.iso3, [t.iso2, t.en_name, t.zh]])),
  EXPECTED_TERRITORIES,
  "the 22 territories: ISO2, CLDR English name, zh name",
);
for (const territory of asset.territories) assert.equal(territory.source, "natural_earth_admin0_50m", `${territory.iso3} records its source`);
assert.deepEqual(asset.territories.filter((t) => t.zh_source === "override").map((t) => t.iso3), ["TWN"], "TWN is the one overridden territory");

// -- the policy override table: exactly these eight codes, each authorized by a rule --
assert.deepEqual(Object.keys(ZH_OVERRIDES).sort(), ["COD", "COG", "FSM", "HKG", "MAC", "PSE", "TWN", "XKX"]);
const EXPECTED_OVERRIDES = {
  HKG: { zh: "中国香港", policy_rule: 3 },
  MAC: { zh: "中国澳门", policy_rule: 3 },
  TWN: { zh: "中国台湾", policy_rule: 3 },
  PSE: { zh: "巴勒斯坦", policy_rule: 3 },
  FSM: { zh: "密克罗尼西亚联邦", policy_rule: 3 },
  XKX: { zh: "科索沃", policy_rule: 5 },
  COD: { zh: "刚果（金）", policy_rule: 6 },
  COG: { zh: "刚果（布）", policy_rule: 6 },
};
{
  const places = new Map([...asset.economies, ...asset.territories].map((entry) => [entry.iso3, entry]));
  for (const [iso3, expected] of Object.entries(EXPECTED_OVERRIDES)) {
    const entry = places.get(iso3);
    assert.ok(entry, `${iso3} is present`);
    assert.deepEqual({ zh: entry.zh, zh_source: entry.zh_source, policy_rule: entry.policy_rule }, { ...expected, zh_source: "override" }, `override ${iso3}`);
    assert.equal(typeof entry.cldr_zh, "string", `${iso3} records what CLDR said`);
  }
  const overridden = [...places.values()].filter((entry) => entry.zh_source === "override").map((entry) => entry.iso3).sort();
  assert.deepEqual(overridden, Object.keys(EXPECTED_OVERRIDES).sort(), "no entry is overridden outside the table");
  for (const entry of places.values()) {
    if (entry.zh_source === "override") continue;
    assert.equal("policy_rule" in entry, false, `${entry.iso3} has no policy_rule without an override`);
    assert.equal("cldr_zh" in entry, false, `${entry.iso3} has no cldr_zh without an override`);
  }
  // Policy rule 6: full-width brackets, never ASCII ones.
  for (const iso3 of ["COD", "COG"]) assert.match(places.get(iso3).zh, /^刚果（[金布]）$/, `${iso3} uses full-width brackets`);
  // Policy rule 3: Hong Kong, Macao and Taiwan are never printed as a bare country, nor with CLDR's long administrative form.
  assert.equal(places.get("HKG").cldr_zh, "中国香港特别行政区", "CLDR's long form is what the override replaced");
  assert.equal(places.get("TWN").cldr_zh, "台湾", "CLDR's bare name is what the override replaced");
}

// -- aggregate zh names (trimmed World Bank names; the raw en names have no
// leading/trailing whitespace to trim in the current WB list, but the
// build's wb_name derivation always trims, so this checks the trim did
// not silently change which aggregate matched) --
const byAggIso3 = new Map(asset.aggregates.map((a) => [a.iso3, a]));
assert.deepEqual(byAggIso3.get("SSF"), { iso3: "SSF", wb_name: "Sub-Saharan Africa", zh: "撒哈拉以南非洲地区", zh_source: "worldbank", policy_rule: 7 });
assert.deepEqual(byAggIso3.get("LCN"), { iso3: "LCN", wb_name: "Latin America & Caribbean", zh: "拉丁美洲与加勒比海地区", zh_source: "worldbank", policy_rule: 7 });
assert.deepEqual(byAggIso3.get("WLD"), { iso3: "WLD", wb_name: "World", zh: "世界", zh_source: "policy", policy_rule: 7, wb_zh: "世界" });
assert.deepEqual(byAggIso3.get("HIC"), { iso3: "HIC", wb_name: "High income", zh: "高收入经济体", zh_source: "policy", policy_rule: 7, wb_zh: "高收入国家" }, "the policy name replaced the World Bank's 国家 wording, which stays recorded");
assert.deepEqual(byAggIso3.get("EUU"), { iso3: "EUU", wb_name: "European Union", zh: "欧盟", zh_source: "policy", policy_rule: 7, wb_zh: "欧洲联盟" });
assert.deepEqual(byAggIso3.get("OWID_OCE"), { iso3: "OWID_OCE", en_name: "Oceania", zh: "大洋洲", zh_source: "policy", policy_rule: 7 }, "an OWID continent has no World Bank row, hence no wb_name or wb_zh");
for (const agg of asset.aggregates) {
  if ("wb_name" in agg) assert.equal(agg.wb_name, agg.wb_name.trim(), `aggregate ${agg.iso3} wb_name must already be trimmed`);
  else assert.ok(agg.en_name && agg.en_name === agg.en_name.trim(), `aggregate ${agg.iso3} has no World Bank name, so it carries its own trimmed en_name`);
}
// Every other aggregate the World Bank lists (TEA, TEC, ARB, EMU, OED, the IDA/IBRD subsets, small states ...) is NOT in the table: it
// resolves neither by code nor by name, so a chart that holds one is refused by the unmapped-value blocker.
{
  const listed = JSON.parse(readFileSync(DEFAULT_EN_PATH, "utf8"))[1].filter((row) => row.region?.value === "Aggregates");
  const inTable = new Set(asset.aggregates.map((entry) => entry.iso3));
  const others = listed.filter((row) => !inTable.has(row.id));
  assert.equal(listed.length, 78, "the vendored World Bank list has 78 aggregate rows");
  assert.equal(others.length, 65, "13 of them are in the policy table, the other 65 are not");
  assert.deepEqual(unmappedEconomyNameValues(others.map((row) => row.id), "iso3"), others.map((row) => row.id), "no other aggregate resolves by code");
  assert.deepEqual(unmappedEconomyNameValues(others.map((row) => row.name.trim()), "worldbank").length, others.length, "no other aggregate resolves by its World Bank name");
  for (const code of ["TEA", "TEC", "ARB", "EMU", "OED", "LDC", "IDA", "SST", "AFR"]) assert.equal(economyEntryFor(code, "iso3"), null, `${code} is not displayable`);
  for (const row of listed.filter((row) => inTable.has(row.id))) assert.equal(economyEntryFor(row.id, "iso3")?.kind, "aggregate", `${row.id} is an aggregate`);
}

// -- the alias codes: documented alternates of a primary code, per mode --
const aliasRows = (list) => list.map(({ mode, alias, target }) => [mode, alias, target]);
assert.deepEqual(aliasRows(asset.aliases), [
  ["iso3", "OWID_KOS", "XKX"], ["iso3", "OWID_WRL", "WLD"], ["iso3", "OWID_EU27", "EUU"],
  ["iso3", "OWID_HIC", "HIC"], ["iso3", "OWID_UMC", "UMC"], ["iso3", "OWID_LMC", "LMC"], ["iso3", "OWID_LIC", "LIC"],
  ["iso2", "EL", "GR"], ["iso2", "UK", "GB"],
]);
assert.deepEqual(aliasRows(ALIASES), aliasRows(asset.aliases));
for (const alias of asset.aliases) assert.ok(alias.source, `alias ${alias.alias} records where the code comes from`);

// -- defence in depth: no empty/Latin-letter zh name anywhere in the
// committed asset bytes themselves (the builders assert this at build time;
// this re-checks the files on disk) --
const LATIN_LETTER_RE = /[A-Za-z]/;
for (const entry of [...asset.economies, ...asset.territories, ...asset.aggregates]) {
  assert.ok(entry.zh && entry.zh.trim(), `${entry.iso3} zh name must not be empty`);
  assert.ok(!LATIN_LETTER_RE.test(entry.zh), `${entry.iso3} zh name must not contain Latin letters: ${JSON.stringify(entry.zh)}`);
}
for (const entry of currencyAsset.currencies) {
  assert.ok(entry.zh && entry.zh.trim(), `${entry.code} zh name must not be empty`);
  assert.ok(!LATIN_LETTER_RE.test(entry.zh), `${entry.code} zh name must not contain Latin letters: ${JSON.stringify(entry.zh)}`);
  assert.ok(entry.en && entry.en.trim(), `${entry.code} en name must not be empty`);
}
// No ASCII parentheses in a zh name (full-width ones are the house style: 刚果（金）). The one exception is the name CLDR
// itself ships for the historic ZWL, which no policy rule covers (reported, not decided here).
{
  const withAsciiBrackets = [...asset.economies, ...asset.territories, ...asset.aggregates].map((entry) => [entry.iso3, entry.zh])
    .concat(currencyAsset.currencies.map((entry) => [entry.code, entry.zh]))
    .filter(([, zh]) => /[()]/.test(zh))
    .map(([code]) => code);
  assert.deepEqual(withAsciiBrackets, ["ZWL"], "ASCII parentheses in a zh name: only ZWL");
}

// -- currencies: policy rule 9 --
assert.deepEqual(Object.keys(CURRENCY_ZH_OVERRIDES).sort(), ["AUD", "CAD"]);
const byCode = new Map(currencyAsset.currencies.map((c) => [c.code, c]));
for (const [code, zh] of [["AUD", "澳元"], ["CAD", "加元"]]) {
  const entry = byCode.get(code);
  assert.deepEqual({ zh: entry.zh, zh_source: entry.zh_source, policy_rule: entry.policy_rule }, { zh, zh_source: "override", policy_rule: 9 }, `override ${code}`);
  assert.match(entry.cldr_zh, /元$/, `${code} records the long CLDR form it replaced`);
}
assert.deepEqual(currencyAsset.currencies.filter((c) => c.zh_source === "override").map((c) => c.code), ["AUD", "CAD"], "no currency is overridden outside the table");
// The euro-FX page's set (the ECB reference-rate currencies, minus the euro itself) plus the policy's own examples.
const EXPECTED_CURRENCIES = {
  USD: "美元", JPY: "日元", GBP: "英镑", CNY: "人民币", KRW: "韩元", CHF: "瑞士法郎", EUR: "欧元", AUD: "澳元", CAD: "加元",
  TRY: "土耳其里拉", INR: "印度卢比", MXN: "墨西哥比索", BRL: "巴西雷亚尔",
  BGN: "保加利亚列弗", CZK: "捷克克朗", DKK: "丹麦克朗", HKD: "港元", HUF: "匈牙利福林", IDR: "印度尼西亚卢比", ILS: "以色列新谢克尔",
  ISK: "冰岛克朗", MYR: "马来西亚林吉特", NOK: "挪威克朗", NZD: "新西兰元", PHP: "菲律宾比索", PLN: "波兰兹罗提", RON: "罗马尼亚列伊",
  SEK: "瑞典克朗", SGD: "新加坡元", THB: "泰铢", ZAR: "南非兰特",
};
for (const [code, zh] of Object.entries(EXPECTED_CURRENCIES)) assert.equal(byCode.get(code)?.zh, zh, `currency ${code}`);
// Policy rule 9: a short name that several countries share (里拉, 卢比, 比索, 雷亚尔) is never a label on its own.
for (const entry of currencyAsset.currencies) {
  assert.ok(!["里拉", "卢比", "比索", "雷亚尔"].includes(entry.zh), `${entry.code}: '${entry.zh}' is ambiguous without a country`);
}

// -- runtime/pi/economy_names.mjs resolver --
assert.deepEqual(ECONOMY_NAME_MODES, ["worldbank", "iso3", "iso2"]);
assert.deepEqual(CURRENCY_NAME_MODES, ["iso4217"]);
assert.deepEqual(CATEGORY_NAME_MODES, ["worldbank", "iso3", "iso2", "iso4217"], "the legal values of category_names");
assert.ok(Object.isFrozen(ECONOMY_NAME_MODES) && Object.isFrozen(CURRENCY_NAME_MODES) && Object.isFrozen(CATEGORY_NAME_MODES), "the mode lists cannot be mutated by a caller");
assert.equal(resolveEconomyDisplayName("Congo, Dem. Rep.", "worldbank", "zh"), "刚果（金）");
assert.equal(resolveEconomyDisplayName("COD", "iso3", "zh"), "刚果（金）");
assert.equal(resolveEconomyDisplayName("CD", "iso2", "zh"), "刚果（金）");
assert.equal(resolveEconomyDisplayName("COD", "iso3", "en"), "Congo, Dem. Rep.", "iso3 + en must expand the code to the World Bank English name");
assert.equal(resolveEconomyDisplayName("CD", "iso2", "en"), "Congo, Dem. Rep.", "iso2 + en expands to the same World Bank English name");
assert.equal(resolveEconomyDisplayName("Congo, Dem. Rep.", "worldbank", "en"), "Congo, Dem. Rep.", "worldbank + en must be byte-identical passthrough");
assert.equal(resolveEconomyDisplayName("Congo, Dem. Rep.", undefined, "zh"), "Congo, Dem. Rep.", "no category_names set: raw value unchanged even on a zh page");
assert.equal(resolveEconomyDisplayName("Nowhere, Fictional", "worldbank", "zh"), "Nowhere, Fictional", "an unmapped value falls back to the raw value at render time (lintVizSpec is the gate, not the resolver)");
assert.equal(resolveEconomyDisplayName("COD", "no-such-mode", "zh"), "COD", "an unknown mode resolves nothing");
assert.deepEqual(unmappedEconomyNameValues(["COD"], "no-such-mode"), ["COD"]);

assert.deepEqual(unmappedEconomyNameValues(["Congo, Dem. Rep.", "Nowhere", "Chad", "Nowhere"], "worldbank"), ["Nowhere"], "order-preserving, deduplicated");
assert.deepEqual(unmappedEconomyNameValues(["COD", "XXX", "TCD"], "iso3"), ["XXX"]);
assert.deepEqual(unmappedEconomyNameValues(["Congo, Dem. Rep.", "Chad"], "worldbank"), [], "every value mapped: no unmapped values");
// World Bank indicator rows carry some names with a trailing space, exactly
// as the raw country list does; they must resolve, not be reported unmapped.
assert.equal(resolveEconomyDisplayName("Sub-Saharan Africa ", "worldbank", "zh"), "撒哈拉以南非洲地区");
assert.equal(resolveEconomyDisplayName("Sub-Saharan Africa ", "worldbank", "en"), "Sub-Saharan Africa ", "worldbank + en stays a byte-identical passthrough");
assert.deepEqual(unmappedEconomyNameValues(["Sub-Saharan Africa ", "Latin America & Caribbean "], "worldbank"), []);

// Every economy and aggregate resolves through all its keys to the same zh name, and the English output is unchanged.
for (const entry of [...asset.economies, ...asset.aggregates]) {
  assert.equal(resolveEconomyDisplayName(entry.iso3, "iso3", "zh"), entry.zh, `${entry.iso3} by ISO3`);
  if (entry.wb_name !== undefined) {
    assert.equal(resolveEconomyDisplayName(entry.wb_name, "worldbank", "zh"), entry.zh, `${entry.wb_name} by World Bank name`);
    assert.equal(resolveEconomyDisplayName(entry.iso3, "iso3", "en"), entry.wb_name, `${entry.iso3} en is the World Bank name`);
    assert.equal(resolveEconomyDisplayName(entry.wb_name, "worldbank", "en"), entry.wb_name, `${entry.wb_name} en passthrough`);
  } else {
    // An OWID continent has no World Bank name: by code only, and its English name is OWID's.
    assert.equal(resolveEconomyDisplayName(entry.iso3, "iso3", "en"), entry.en_name, `${entry.iso3} en is its own en_name`);
    assert.notEqual(economyEntryFor(entry.en_name, "worldbank"), economyEntryFor(entry.iso3, "iso3"), `${entry.iso3} never resolves by an English name`);
  }
  if (entry.iso2) assert.equal(resolveEconomyDisplayName(entry.iso2, "iso2", "zh"), entry.zh, `${entry.iso2} by ISO2`);
}

// -- OWID_ codes: Kosovo (an economy, whatever its prefix), the aggregates of the policy table, and nothing else --
assert.equal(resolveEconomyDisplayName("OWID_KOS", "iso3", "zh"), "科索沃");
assert.equal(resolveEconomyDisplayName("OWID_WRL", "iso3", "zh"), "世界");
assert.equal(resolveEconomyDisplayName("OWID_KOS", "iso3", "en"), "Kosovo");
assert.equal(economyEntryFor("OWID_KOS", "iso3"), economyEntryFor("XKX", "iso3"), "an alias is the same entry as its target");
assert.equal(economyEntryFor("OWID_KOS", "iso3")?.kind, "economy", "OWID_KOS is Kosovo: an economy, so the kind (never the OWID_ prefix) decides what is an aggregate");
assert.equal(economyEntryFor("OWID_WRL", "iso3")?.kind, "aggregate");
{
  // Section 3 of the policy: the OWID aggregates that may be shown, and the name each one gets.
  const OWID_AGGREGATES = {
    OWID_WRL: "世界", OWID_EU27: "欧盟", OWID_AFR: "非洲", OWID_ASI: "亚洲", OWID_EUR: "欧洲", OWID_NAM: "北美洲", OWID_SAM: "南美洲", OWID_OCE: "大洋洲",
    OWID_HIC: "高收入经济体", OWID_UMC: "中等偏上收入经济体", OWID_LMC: "中等偏下收入经济体", OWID_LIC: "低收入经济体",
  };
  for (const [code, zh] of Object.entries(OWID_AGGREGATES)) {
    assert.equal(resolveEconomyDisplayName(code, "iso3", "zh"), zh, `${code} by ISO3`);
    assert.equal(economyEntryFor(code, "iso3")?.kind, "aggregate", `${code} is an aggregate`);
    assert.equal(economyEntryFor(code, "iso2"), null, `${code} has no ISO2 code`);
  }
  assert.equal(economyEntryFor("OWID_HIC", "iso3"), economyEntryFor("HIC", "iso3"), "an OWID income group is the World Bank group of the same name");
  assert.equal(economyEntryFor("OWID_EU27", "iso3"), economyEntryFor("EUU", "iso3"));
  assert.equal(resolveEconomyDisplayName("OWID_EUR", "iso3", "en"), "Europe");
  // Every other OWID_ code (historical states, the UK nations, anything else) stays unresolved.
  const otherOwid = ["OWID_USS", "OWID_YUG", "OWID_CZS", "OWID_SRM", "OWID_ENG", "OWID_SCT", "OWID_WLS", "OWID_NIR", "OWID_CIS", "OWID_WORLD"];
  assert.deepEqual(unmappedEconomyNameValues(otherOwid, "iso3"), otherOwid, "every other OWID_* code stays unresolved");
}
assert.equal(resolveEconomyDisplayName("OWID_KOS", "iso2", "zh"), "OWID_KOS", "an ISO3 alias does not resolve in the ISO2 mode");

// -- ISO2 mode: the same entries as the ISO3 mode, World Bank economies and Natural Earth territories alike --
assert.equal(economyEntryFor("GR", "iso2"), economyEntryFor("GRC", "iso3"), "an ISO2 code resolves to the same entry as its ISO3");
assert.equal(resolveEconomyDisplayName("EL", "iso2", "zh"), "希腊", "Eurostat's EL is Greece");
assert.equal(economyEntryFor("EL", "iso2"), economyEntryFor("GR", "iso2"));
assert.equal(resolveEconomyDisplayName("UK", "iso2", "zh"), "英国", "Eurostat's UK is the United Kingdom");
assert.equal(resolveEconomyDisplayName("UK", "iso2", "en"), "United Kingdom");
assert.equal(economyEntryFor("UK", "iso2"), economyEntryFor("GB", "iso2"));
assert.equal(resolveEconomyDisplayName("TD", "iso2", "zh"), "乍得", "a World Bank economy");
assert.equal(resolveEconomyDisplayName("NA", "iso2", "zh"), "纳米比亚", "Namibia's code is the string NA, not a missing value");
assert.equal(resolveEconomyDisplayName("FK", "iso2", "zh"), "福克兰群岛", "a Natural Earth territory");
assert.equal(resolveEconomyDisplayName("FK", "iso2", "en"), "Falkland Islands", "a territory's English name is CLDR's");
assert.equal(resolveEconomyDisplayName("TW", "iso2", "zh"), "中国台湾");
assert.equal(resolveEconomyDisplayName("HK", "iso2", "zh"), "中国香港");
assert.equal(resolveEconomyDisplayName(" GR ", "iso2", "zh"), "希腊", "values are trimmed like the other modes");
assert.equal(economyEntryFor("GR", "iso2")?.kind, "economy");
assert.equal(economyEntryFor("FK", "iso2")?.kind, "economy");
assert.deepEqual(
  unmappedEconomyNameValues(["GR", "EU27_2020", "EA20", "XX", "gr"], "iso2"),
  ["EU27_2020", "EA20", "XX", "gr"],
  "aggregates (EU27_2020, EA20), unknown and lower-case codes stay unresolved",
);
assert.equal(economyEntryFor("WLD", "iso2"), null, "an aggregate has no ISO2 code");
assert.equal(resolveEconomyDisplayName("GRC", "iso2", "zh"), "GRC", "an ISO3 code does not resolve in the ISO2 mode");
assert.equal(resolveEconomyDisplayName("GR", "iso3", "zh"), "GR", "an ISO2 code does not resolve in the ISO3 mode");

// -- territories resolve by code only, never by an English name --
assert.equal(economyEntryFor("FLK", "iso3")?.zh, "福克兰群岛");
assert.equal(resolveEconomyDisplayName("FLK", "iso3", "en"), "Falkland Islands");
assert.equal(economyEntryFor("Falkland Islands", "worldbank"), null, "a territory has no World Bank name to match");
assert.equal(resolveEconomyDisplayName("Taiwan", "worldbank", "zh"), "Taiwan", "no English-name matching for a territory either");
assert.equal(resolveEconomyDisplayName("TWN", "iso3", "zh"), "中国台湾");
assert.equal(resolveEconomyDisplayName("Hong Kong SAR, China", "worldbank", "zh"), "中国香港");
assert.equal(resolveEconomyDisplayName("West Bank and Gaza", "worldbank", "zh"), "巴勒斯坦", "policy rule 11: the name is 巴勒斯坦 whatever the coverage");

// -- currencies: ISO 4217 codes only, English name from CLDR, never an English zh name --
assert.equal(resolveEconomyDisplayName("TRY", "iso4217", "zh"), "土耳其里拉");
assert.equal(resolveEconomyDisplayName("TRY", "iso4217", "en"), "Turkish Lira", "en + iso4217 expands the code to CLDR's English name");
assert.equal(resolveEconomyDisplayName("AUD", "iso4217", "zh"), "澳元");
assert.equal(resolveEconomyDisplayName("CAD", "iso4217", "zh"), "加元");
assert.equal(resolveEconomyDisplayName("AUD", "iso4217", "en"), "Australian Dollar");
assert.equal(resolveEconomyDisplayName("QQQ", "iso4217", "zh"), "QQQ", "an unknown code falls back to the raw value at render time");
assert.deepEqual(unmappedEconomyNameValues(["USD", "TRY", "QQQ", "Dollar", "usd"], "iso4217"), ["QQQ", "Dollar", "usd"], "codes only: no name matching, no case folding");
assert.equal(economyEntryFor("TRY", "iso4217")?.kind, "currency");
assert.equal("iso3" in economyEntryFor("TRY", "iso4217"), false, "a currency entry has no iso3 for a map join to use");
assert.equal(economyEntryFor("TRY", "iso3"), null, "TRY is not an economy code");
assert.equal(economyEntryFor("Turkish Lira", "iso4217"), null);
// BTN, MKD and SLE are both an ISO3 economy code and an ISO 4217 currency code: the mode decides.
for (const [code, place, currency] of [["BTN", "不丹", "不丹努尔特鲁姆"], ["MKD", "北马其顿", "马其顿第纳尔"], ["SLE", "塞拉利昂", "塞拉利昂新利昂"]]) {
  assert.equal(resolveEconomyDisplayName(code, "iso3", "zh"), place, `${code} as an economy`);
  assert.equal(resolveEconomyDisplayName(code, "iso4217", "zh"), currency, `${code} as a currency`);
}

console.log(JSON.stringify({
  status: "PASS",
  economies: asset.economies.length,
  territories: asset.territories.length,
  aggregates: asset.aggregates.length,
  aliases: asset.aliases.length,
  currencies: currencyAsset.currencies.length,
  aggregate_ids: aggregateIds,
  versions: asset.versions,
  toolchain: { ...live, pinned: onPinnedToolchain },
  currency_table_check: currencyCheck,
  territory_iso2: territoryIso2Rederived ? { checked: true, source: "pinned Natural Earth release" } : { checked: false, status: "SKIP", reason: TERRITORY_ISO2_SKIP_REASON },
}, null, 2));
