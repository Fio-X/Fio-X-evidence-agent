#!/usr/bin/env node
// H1: with the hero value gate on (always on in the runtime, no switch turns it off; the pure lint takes it as
// context.hero_value_gate and stays off without it), a hero_stat's number must be in its own claim's rows. Synthetic
// data only. Off: lint output is unchanged from a4d4cb0 (compared when that commit exists).
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lintInfographicSpec } from '../runtime/pi/infographic.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = 'claim-a', UNV = 'claim-unverified';
const hero = (extra = {}) => ({ id: 'h1', type: 'hero_stat', span: 'third', value: '1.2', unit: '°C', label: 'Synthetic label without digits', detail: 'Synthetic detail', claim_id: A, ...extra });
const page = (h) => ({ schema_version: '1.0.0', kicker: 'SYNTHETIC', title: 'Hero value gate fixture page', dek: 'A synthetic page for the hero value gate.', alt: 'A synthetic page.', modules: [h] });
// The runtime re-fills each hero from its claim (newsroom.ts fillHeroModule; test_hero_value_tool_path.mjs covers that) and
// hands the refusals to lint as context.hero_checks; lint only reports them and keeps the claim-verified check.
const ctx = (extra = {}) => ({ verified_claim_ids: [A], mobile_pages: false, ...extra });
const mine = (lint) => lint.blockers.filter((b) => b.includes("'h1'"));
const on = (h, extra = {}) => mine(lintInfographicSpec(page(h), {}, ctx({ hero_value_gate: true, hero_checks: { h1: [] }, ...extra })));

let n = 0;
const ok = (name, h, extra) => { assert.deepEqual(on(h, extra), [], name); n += 1; };
const bad = (name, h, expected, extra) => { assert.deepEqual(on(h, extra), expected, name); n += 1; };

ok('re-check clean', hero());
bad('the re-check refusal is reported', hero(), ["HERO_VALUE_TYPED: hero_stat 'h1' value '9' is typed"], { hero_checks: { h1: ["HERO_VALUE_TYPED: hero_stat 'h1' value '9' is typed"] } });
bad('no re-check ran for the module: blocked, never passed', hero(), [`hero_stat 'h1' was not re-checked against its claim bindings (hero value gate)`], { hero_checks: {} });
bad('hero_checks missing entirely', hero(), [`hero_stat 'h1' was not re-checked against its claim bindings (hero value gate)`], { hero_checks: undefined });
bad('unverified claim', hero({ claim_id: UNV }), [`hero_stat 'h1' references unverified claim '${UNV}'`, `hero_stat 'h1' claim '${UNV}' is not verified (hero value gate)`]);
bad('empty verified set (gate on)', hero(), [`hero_stat 'h1' references unverified claim '${A}'`, `hero_stat 'h1' claim '${A}' is not verified (hero value gate)`], { verified_claim_ids: [] });
// empty verified set, gate off: a cited claim id is no longer let through
bad('empty verified set (gate off)', hero({ claim_id: UNV }), [`hero_stat 'h1' references unverified claim '${UNV}'`], { verified_claim_ids: [], hero_value_gate: false, hero_checks: undefined });

// switch off: same lint result as a4d4cb0 whenever some claim is verified (an empty verified set now blocks cited claims on purpose)
const cases = [hero(), hero({ value: '9.9' }), hero({ value: '约一半', unit: '' }), hero({ claim_id: UNV }), hero({ value: '1.2 to 12.3', unit: '' })];
let base = null;
try {
  const dir = makeTestTmp('hero-base-');
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  execFileSync('sh', ['-c', `git -C '${ROOT}' archive a4d4cb0 runtime/pi | tar -x -C '${dir}'`], { stdio: 'pipe' });
  base = await import(pathToFileURL(join(dir, 'runtime/pi/infographic.mjs')).href);
} catch { console.log('SKIP off-equality: commit a4d4cb0 not available'); }
if (base) {
  for (const h of cases) for (const extra of [{}, { verified_claim_ids: [A] }]) {
    const c = ctx(extra);
    assert.deepEqual(lintInfographicSpec(page(h), {}, c), base.lintInfographicSpec(page(h), {}, c), `off differs from a4d4cb0: ${JSON.stringify(h)}`);
    const o = ctx({ ...extra, hero_value_gate: false });
    assert.deepEqual(lintInfographicSpec(page(h), {}, o), base.lintInfographicSpec(page(h), {}, o)); n += 2;
  }
}
console.log(`hero value gate: ${n} checks -- PASS`);
