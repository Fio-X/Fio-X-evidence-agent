#!/usr/bin/env node
// H1: with the hero value gate on (always on, no switch and no parameter turns it off), a hero_stat's number must be in its own claim's rows. Synthetic
// data only.
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintInfographicSpec } from '../runtime/pi/infographic.mjs';

const A = 'claim-a', UNV = 'claim-unverified';
const hero = (extra = {}) => ({ id: 'h1', type: 'hero_stat', span: 'third', value: '1.2', unit: '°C', label: 'Synthetic label without digits', detail: 'Synthetic detail', claim_id: A, ...extra });
const page = (h) => ({ schema_version: '1.0.0', kicker: 'SYNTHETIC', title: 'Hero value gate fixture page', dek: 'A synthetic page for the hero value gate.', alt: 'A synthetic page.', modules: [h] });
// The runtime re-fills each hero from its claim (newsroom.ts fillHeroModule; test_hero_value_tool_path.mjs covers that) and
// hands the refusals to lint as context.hero_checks; lint only reports them and keeps the claim-verified check.
const ctx = (extra = {}) => ({ verified_claim_ids: [A], mobile_pages: false, ...extra });
const mine = (lint) => lint.blockers.filter((b) => b.includes("'h1'"));
const on = (h, extra = {}) => mine(lintInfographicSpec(page(h), {}, ctx({ hero_checks: { h1: [] }, ...extra })));

let n = 0;
const ok = (name, h, extra) => { assert.deepEqual(on(h, extra), [], name); n += 1; };
const bad = (name, h, expected, extra) => { assert.deepEqual(on(h, extra), expected, name); n += 1; };

ok('re-check clean', hero());
bad('the re-check refusal is reported', hero(), ["HERO_VALUE_TYPED: hero_stat 'h1' value '9' is typed"], { hero_checks: { h1: ["HERO_VALUE_TYPED: hero_stat 'h1' value '9' is typed"] } });
bad('no re-check ran for the module: blocked, never passed', hero(), [`hero_stat 'h1' was not re-checked against its claim bindings (hero value gate)`], { hero_checks: {} });
bad('hero_checks missing entirely', hero(), [`hero_stat 'h1' was not re-checked against its claim bindings (hero value gate)`], { hero_checks: undefined });
bad('unverified claim', hero({ claim_id: UNV }), [`hero_stat 'h1' references unverified claim '${UNV}'`, `hero_stat 'h1' claim '${UNV}' is not verified (hero value gate)`]);
bad('empty verified set', hero(), [`hero_stat 'h1' references unverified claim '${A}'`, `hero_stat 'h1' claim '${A}' is not verified (hero value gate)`], { verified_claim_ids: [] });
// No parameter turns the gate off: a caller that still passes hero_value_gate:false (or anything else) gets the same blockers.
for (const flag of [false, 0, '0', null, undefined, 'off']) {
  const withFlag = (h, extra = {}) => mine(lintInfographicSpec(page(h), {}, ctx({ hero_value_gate: flag, hero_checks: { h1: [] }, ...extra })));
  assert.deepEqual(withFlag(hero({ claim_id: UNV })), on(hero({ claim_id: UNV })), `flag ${String(flag)} changed the unverified-claim result`);
  assert.deepEqual(withFlag(hero(), { hero_checks: {} }), on(hero(), { hero_checks: {} }), `flag ${String(flag)} let an un-rechecked hero through`);
  assert.deepEqual(withFlag(hero(), { hero_checks: { h1: ["HERO_VALUE_TYPED: hero_stat 'h1' value 'x' is typed"] } }), ["HERO_VALUE_TYPED: hero_stat 'h1' value 'x' is typed"], `flag ${String(flag)} hid a refusal`); n += 3;
}
// No context at all (no hero_value_gate, no hero_checks): a hero_stat is blocked, never passed untested.
assert.deepEqual(mine(lintInfographicSpec(page(hero()), {}, ctx())), [`hero_stat 'h1' was not re-checked against its claim bindings (hero value gate)`], 'bare context'); n += 1;
// The old comparison with a4d4cb0 (gate off = lint unchanged) is gone: there is no off state left to compare.
console.log(`hero value gate: ${n} checks -- PASS`);
