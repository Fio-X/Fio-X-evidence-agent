#!/usr/bin/env node
// Covers the vendored World Bank/CLDR economy-name table
// (runtime/pi/assets/economy-names.json, fixtures/external/
// worldbank_country_list/) end to end:
//   - the committed asset is exactly what scripts/build_economy_names.mjs
//     derives from the vendored raw files right now (not stale, not
//     hand-edited) - versions/generated_by/schema_version excluded, since
//     those are build-machine facts, not derived content;
//   - the 217/12 economy/aggregate counts and the exact aggregate ID set;
//   - the specific name checks the task called out (Congo Dem. Rep. /
//     Congo Rep. and neighbouring Sub-Saharan African economies resolving
//     to real CLDR zh names, Channel Islands falling back to the World
//     Bank zh name because CLDR has no name for pseudo-code "JG", and the
//     LCN/SSF aggregate zh names);
//   - every zh name in the shipped asset is non-empty and Latin-letter-free
//     (defence in depth: build_economy_names.mjs already asserts this at
//     build time, but this re-checks the committed bytes themselves, so a
//     hand-edit that skips the build cannot silently reintroduce a leaked
//     English/code string);
//   - runtime/pi/economy_names.mjs's resolver: category_names "worldbank"
//     and "iso3" resolve to the same zh name from either key, "en" +
//     "worldbank" is byte-identical passthrough, "en" + "iso3" expands the
//     code to the World Bank English name, and unmapped-value detection
//     for lintVizSpec's blocker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildEconomyNames, ECONOMY_NAMES_ASSET_PATH, ECONOMY_NAMES_SCHEMA_VERSION } from "./build_economy_names.mjs";
import { resolveEconomyDisplayName, unmappedEconomyNameValues, ECONOMY_NAME_MODES } from "../runtime/pi/economy_names.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const asset = JSON.parse(readFileSync(ECONOMY_NAMES_ASSET_PATH, "utf8"));

// -- committed asset matches a fresh derivation of the vendored raw files --
assert.equal(asset.schema_version, ECONOMY_NAMES_SCHEMA_VERSION);
const derived = buildEconomyNames();
assert.deepEqual(derived.sources, asset.sources, "sources block (file/bytes/sha256) must match a fresh derivation");
assert.deepEqual(derived.economies, asset.economies, "economies table must match a fresh derivation (not stale/hand-edited)");
assert.deepEqual(derived.aggregates, asset.aggregates, "aggregates table must match a fresh derivation (not stale/hand-edited)");

// -- counts --
assert.equal(asset.economies.length, 217, "217 economies (region.value !== 'Aggregates')");
assert.equal(asset.aggregates.length, 12, "WLD plus every distinct region/incomeLevel id in use");

// -- exact aggregate ID set (derived, never hand-picked) --
const aggregateIds = asset.aggregates.map((a) => a.iso3).sort();
assert.deepEqual(aggregateIds, ["EAS", "ECS", "HIC", "LCN", "LIC", "LMC", "MEA", "NAC", "SAS", "SSF", "UMC", "WLD"]);

// -- specific economy checks: Sub-Saharan African economies that must
// resolve through CLDR, plus Channel Islands which must fall back to the
// World Bank zh name because CLDR returns the bare code "JG" for it --
const byIso3 = new Map(asset.economies.map((e) => [e.iso3, e]));
const expectedEconomies = {
  COD: { iso2: "CD", wb_name: "Congo, Dem. Rep.", zh: "刚果（金）", zh_source: "cldr" },
  COG: { iso2: "CG", wb_name: "Congo, Rep.", zh: "刚果（布）", zh_source: "cldr" },
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
};
for (const [iso3, expected] of Object.entries(expectedEconomies)) {
  const entry = byIso3.get(iso3);
  assert.ok(entry, `economy ${iso3} must be present`);
  assert.deepEqual({ iso2: entry.iso2, wb_name: entry.wb_name, zh: entry.zh, zh_source: entry.zh_source }, expected, `economy ${iso3}`);
}

// -- aggregate zh names (trimmed World Bank names; the raw en names have no
// leading/trailing whitespace to trim in the current WB list, but the
// build's wb_name derivation always trims, so this checks the trim did
// not silently change which aggregate matched) --
const byAggIso3 = new Map(asset.aggregates.map((a) => [a.iso3, a]));
assert.deepEqual(byAggIso3.get("SSF"), { iso3: "SSF", wb_name: "Sub-Saharan Africa", zh: "撒哈拉以南非洲地区", zh_source: "worldbank" });
assert.deepEqual(byAggIso3.get("LCN"), { iso3: "LCN", wb_name: "Latin America & Caribbean", zh: "拉丁美洲与加勒比海地区", zh_source: "worldbank" });
for (const agg of asset.aggregates) assert.equal(agg.wb_name, agg.wb_name.trim(), `aggregate ${agg.iso3} wb_name must already be trimmed`);

// -- defence in depth: no empty/Latin-letter zh name anywhere in the
// committed asset bytes themselves (build_economy_names.mjs asserts this
// at build time; this re-checks the file on disk) --
const LATIN_LETTER_RE = /[A-Za-z]/;
for (const entry of [...asset.economies, ...asset.aggregates]) {
  assert.ok(entry.zh && entry.zh.trim(), `${entry.iso3} zh name must not be empty`);
  assert.ok(!LATIN_LETTER_RE.test(entry.zh), `${entry.iso3} zh name must not contain Latin letters: ${JSON.stringify(entry.zh)}`);
}

// -- runtime/pi/economy_names.mjs resolver --
assert.deepEqual(ECONOMY_NAME_MODES, ["worldbank", "iso3"]);
assert.equal(resolveEconomyDisplayName("Congo, Dem. Rep.", "worldbank", "zh"), "刚果（金）");
assert.equal(resolveEconomyDisplayName("COD", "iso3", "zh"), "刚果（金）");
assert.equal(resolveEconomyDisplayName("COD", "iso3", "en"), "Congo, Dem. Rep.", "iso3 + en must expand the code to the World Bank English name");
assert.equal(resolveEconomyDisplayName("Congo, Dem. Rep.", "worldbank", "en"), "Congo, Dem. Rep.", "worldbank + en must be byte-identical passthrough");
assert.equal(resolveEconomyDisplayName("Congo, Dem. Rep.", undefined, "zh"), "Congo, Dem. Rep.", "no category_names set: raw value unchanged even on a zh page");
assert.equal(resolveEconomyDisplayName("Nowhere, Fictional", "worldbank", "zh"), "Nowhere, Fictional", "an unmapped value falls back to the raw value at render time (lintVizSpec is the gate, not the resolver)");

assert.deepEqual(unmappedEconomyNameValues(["Congo, Dem. Rep.", "Nowhere", "Chad", "Nowhere"], "worldbank"), ["Nowhere"], "order-preserving, deduplicated");
assert.deepEqual(unmappedEconomyNameValues(["COD", "XXX", "TCD"], "iso3"), ["XXX"]);
assert.deepEqual(unmappedEconomyNameValues(["Congo, Dem. Rep.", "Chad"], "worldbank"), [], "every value mapped: no unmapped values");
// World Bank indicator rows carry some names with a trailing space, exactly
// as the raw country list does; they must resolve, not be reported unmapped.
assert.equal(resolveEconomyDisplayName("Sub-Saharan Africa ", "worldbank", "zh"), "撒哈拉以南非洲地区");
assert.equal(resolveEconomyDisplayName("Sub-Saharan Africa ", "worldbank", "en"), "Sub-Saharan Africa ", "worldbank + en stays a byte-identical passthrough");
assert.deepEqual(unmappedEconomyNameValues(["Sub-Saharan Africa ", "Latin America & Caribbean "], "worldbank"), []);

console.log(JSON.stringify({
  status: "PASS",
  economies: asset.economies.length,
  aggregates: asset.aggregates.length,
  aggregate_ids: aggregateIds,
  versions: asset.versions,
}, null, 2));
