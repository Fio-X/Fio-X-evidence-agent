#!/usr/bin/env node
// Deterministically derives runtime/pi/assets/currency-names.json - the
// vendored, provenance-recorded table the newsroom viz renderers use to show
// a real Chinese currency name ("土耳其里拉") instead of leaking a bare ISO 4217
// code ("TRY") onto a zh chart. Same contract as the economy table
// (scripts/build_economy_names.mjs): the model never translates a name
// itself, and every zh string this table can produce came from Unicode CLDR
// (via Node's bundled ICU, Intl.DisplayNames) or from the tiny override table
// below.
//
//   codes : Intl.supportedValuesOf("currency")
//   zh    : Intl.DisplayNames(["zh-Hans"], { type: "currency" })
//   en    : Intl.DisplayNames(["en"], { type: "currency" })
//
// A code CLDR cannot name in zh (the display-names API then returns the code
// itself, or a name with Latin letters) is excluded and recorded in
// `excluded`, never given an English fallback: it then resolves nowhere and
// lintVizSpec blocks it.
//
// Usage (offline, no inputs besides the toolchain):
//
//   node scripts/build_currency_names.mjs
//
// Toolchain pin: the CLI refuses to write unless node/ICU/CLDR are exactly the
// PINNED_TOOLCHAIN of scripts/build_economy_names.mjs (CLDR 47 and CLDR 48
// differ for a few codes: KGS en, XCG and ZWG zh), so the committed bytes do
// not depend on whichever Node ran the build.
//
// buildCurrencyNames() is the pure derivation (no file writes, no toolchain
// check): scripts/test_economy_names.mjs imports it and re-derives the
// committed asset (tolerating only the documented CLDR-version-sensitive codes
// on a toolchain other than the pin).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertPinnedToolchain } from "./build_economy_names.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CURRENCY_NAMES_ASSET_PATH = join(ROOT, "runtime/pi/assets/currency-names.json");
export const CURRENCY_NAMES_SCHEMA_VERSION = "0.1.0";

// Policy rule 9 (zh-naming-policy-1003): the mainland short names of two
// currencies whose CLDR names are the long forms (澳大利亚元, 加拿大元). The ONLY
// overrides; every other CLDR name stays as CLDR names it (美元, 日元, 英镑,
// 人民币, 韩元, 瑞士法郎, 欧元, 土耳其里拉, 印度卢比, 墨西哥比索, 巴西雷亚尔 ...).
export const CURRENCY_ZH_OVERRIDES = Object.freeze({
  AUD: Object.freeze({ zh: "澳元", policy_rule: 9 }),
  CAD: Object.freeze({ zh: "加元", policy_rule: 9 }),
});

const RULES = Object.freeze([
  "codes = Intl.supportedValuesOf('currency'); zh = Unicode CLDR zh-Hans currency display name; en = the CLDR English currency display name.",
  "The override table (zh_source 'override') replaces the CLDR name only where a policy rule says so; policy_rule is that rule's number and cldr_zh records what CLDR said.",
  "A code CLDR has no zh name for (or whose zh name has Latin letters) is listed in `excluded` and resolves nowhere; a zh name is never an English fallback.",
  "Resolution is by exact ISO 4217 code only; a currency name is never matched by text.",
]);

const LATIN_LETTER_RE = /[A-Za-z]/;

/**
 * Pure derivation of the currency-names asset's substantive content.
 * `codes` defaults to the running toolchain's Intl.supportedValuesOf("currency").
 *
 * @param {{codes?: string[]}} [options]
 * @returns {{rules: string[], source: object, currencies: object[], excluded: object[]}}
 */
export function buildCurrencyNames({ codes = Intl.supportedValuesOf("currency") } = {}) {
  const zhNames = new Intl.DisplayNames(["zh-Hans"], { type: "currency" });
  const enNames = new Intl.DisplayNames(["en"], { type: "currency" });
  const sorted = [...codes].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error("currency-names build: duplicate currency code in the input list");

  // Intl.DisplayNames returns the code itself when it has no name for it.
  function cldrName(displayNames, code) {
    let name;
    try {
      name = displayNames.of(code);
    } catch {
      return null;
    }
    if (!name || !name.trim() || name === code) return null;
    return name;
  }

  const currencies = [];
  const excluded = [];
  const overridesApplied = new Set();
  for (const code of sorted) {
    if (!/^[A-Z]{3}$/.test(code)) throw new Error(`currency-names build: '${code}' is not a three-letter ISO 4217 code`);
    const en = cldrName(enNames, code);
    const cldr = cldrName(zhNames, code);
    const override = CURRENCY_ZH_OVERRIDES[code];
    if (override) {
      if (LATIN_LETTER_RE.test(override.zh)) throw new Error(`currency-names build: override zh for ${code} contains Latin letters`);
      overridesApplied.add(code);
    }
    const zh = override ? override.zh : cldr;
    if (!zh || LATIN_LETTER_RE.test(zh)) {
      excluded.push({ code, reason: !zh ? "no CLDR zh-Hans display name" : "CLDR zh-Hans display name contains Latin letters" });
      continue;
    }
    if (!en) {
      excluded.push({ code, reason: "no CLDR English display name" });
      continue;
    }
    currencies.push(override
      ? { code, en, zh, zh_source: "override", policy_rule: override.policy_rule, cldr_zh: cldr }
      : { code, en, zh, zh_source: "cldr" });
  }
  for (const code of Object.keys(CURRENCY_ZH_OVERRIDES)) {
    if (!overridesApplied.has(code)) throw new Error(`currency-names build: override '${code}' is not in Intl.supportedValuesOf('currency')`);
  }

  return {
    rules: [...RULES],
    source: {
      codes: "Intl.supportedValuesOf('currency')",
      zh: "Intl.DisplayNames(['zh-Hans'], { type: 'currency' })",
      en: "Intl.DisplayNames(['en'], { type: 'currency' })",
    },
    currencies,
    excluded,
  };
}

function main() {
  assertPinnedToolchain();
  const derived = buildCurrencyNames();
  const asset = {
    schema_version: CURRENCY_NAMES_SCHEMA_VERSION,
    generated_by: "scripts/build_currency_names.mjs",
    // assertPinnedToolchain() above guarantees these equal PINNED_TOOLCHAIN.
    versions: { node: process.versions.node, icu: process.versions.icu, cldr: process.versions.cldr },
    ...derived,
  };
  writeFileSync(CURRENCY_NAMES_ASSET_PATH, JSON.stringify(asset, null, 2) + "\n");
  console.log(`wrote ${CURRENCY_NAMES_ASSET_PATH}`);
  console.log(`  currencies: ${asset.currencies.length}, excluded: ${asset.excluded.length}`);
  console.log(`  node=${asset.versions.node} icu=${asset.versions.icu} cldr=${asset.versions.cldr}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
