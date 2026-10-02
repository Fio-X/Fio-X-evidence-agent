#!/usr/bin/env node
// H1: with NEWSROOM_HERO_VALUE_GATE=1 (context.hero_value_gate), a hero_stat's number must be in its own
// claim's rows. Synthetic data only. Off: lint output is unchanged from a4d4cb0 (compared when that commit exists).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lintInfographicSpec } from '../runtime/pi/infographic.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = 'claim-a', B = 'claim-b', EMPTY = 'claim-empty', UNV = 'claim-unverified';
const rowsOf = { [A]: [[{ year_value: 1.17, share: 12.3, frac: 0.123, big: 500000000, n: 1234, a: 80, b: 60 }]], [B]: [[{ other: 777 }]], [EMPTY]: [] };
const hero = (extra = {}) => ({ id: 'h1', type: 'hero_stat', span: 'third', value: '1.2', unit: '°C', label: 'Synthetic label without digits', detail: 'Synthetic detail', claim_id: A, ...extra });
const page = (h) => ({ schema_version: '1.0.0', kicker: 'SYNTHETIC', title: 'Hero value gate fixture page', dek: 'A synthetic page for the hero value gate.', alt: 'A synthetic page.', modules: [h] });
const ctx = (extra = {}) => ({ verified_claim_ids: [A, B, EMPTY], mobile_pages: false, hero_claim_rows: rowsOf, ...extra });
const mine = (lint) => lint.blockers.filter((b) => b.startsWith("hero_stat 'h1'"));
const on = (h, extra = {}) => mine(lintInfographicSpec(page(h), {}, ctx({ hero_value_gate: true, ...extra })));

let n = 0;
const ok = (name, h, extra) => { assert.deepEqual(on(h, extra), [], name); n += 1; };
const bad = (name, h, expected, extra, before = []) => { assert.deepEqual(on(h, extra), [...before, expected], name); n += 1; };

// positive
ok('1.2 degC vs 1.17', hero());
ok('12.3% vs 12.3', hero({ value: '12.3', unit: '%' }));
ok('12.3% vs 0.123 (fraction)', hero({ value: '12.3', unit: '%' }), { hero_claim_rows: { [A]: [[{ frac: 0.123 }]] } });
ok('5亿 vs 500000000', hero({ value: '5', unit: '亿' }));
ok('1,234 vs 1234', hero({ value: '1,234', unit: '' }));
ok('year-only label skipped', hero({ value: '1.2', label: 'Since 2017 in the sample' }));
ok('year-like value is matched, not skipped', hero({ value: '2017', unit: '' }), { hero_claim_rows: { [A]: [[{ y: 2017 }]] } });
// negative, exact blockers
bad('not in rows', hero({ value: '9.9' }), `hero_stat 'h1' value number '9.9' is not in the rows of claim '${A}'`);
bad("another claim's rows", hero({ value: '777', unit: '' }), `hero_stat 'h1' value number '777' is not in the rows of claim '${A}'`);
bad('derived only (80-60=20)', hero({ value: '20', unit: '' }), `hero_stat 'h1' value number '20' is not in the rows of claim '${A}'`);
bad('wrong scale 5万', hero({ value: '5', unit: '万' }), `hero_stat 'h1' value number '5万' is not in the rows of claim '${A}'`);
bad('year-like value not in rows', hero({ value: '2018', unit: '' }), `hero_stat 'h1' value number '2018' is not in the rows of claim '${A}'`);
bad('no rows', hero({ claim_id: EMPTY }), `hero_stat 'h1' claim '${EMPTY}' has no computation rows to check its value against`);
bad('unverified claim', hero({ claim_id: UNV }), `hero_stat 'h1' claim '${UNV}' is not verified (hero value gate)`, { verified_claim_ids: [A] }, [`hero_stat 'h1' references unverified claim '${UNV}'`]);
bad('empty verified set', hero(), `hero_stat 'h1' claim '${A}' is not verified (hero value gate)`, { verified_claim_ids: [] });
bad('no digits', hero({ value: '约一半', unit: '' }), `hero_stat 'h1' value has no number to check against claim '${A}'`);
bad('two numbers', hero({ value: '1.2 to 12.3', unit: '' }), `hero_stat 'h1' value has more than one number (1.2, 12.3); claim '${A}'`);
bad('unmatched label number', hero({ label: 'Up 4.4 points in the sample' }), `hero_stat 'h1' label number '4.4' is not in the rows of claim '${A}'`);
bad('unmatched detail number', hero({ detail: 'About 31 cases' }), `hero_stat 'h1' detail number '31' is not in the rows of claim '${A}'`);
ok('label number that derives from the rows (20 = 80-60)', hero({ label: 'A gap of 20 in the sample' }));
// the old lint (empty verified set) accepted any claim id; that stays true with the switch off
assert.deepEqual(mine(lintInfographicSpec(page(hero({ claim_id: UNV })), {}, ctx({ verified_claim_ids: [] }))), []); n += 1;

// switch off: same lint result as a4d4cb0 for every case above
const cases = [hero(), hero({ value: '9.9' }), hero({ claim_id: EMPTY }), hero({ value: '约一半', unit: '' }), hero({ claim_id: UNV }), hero({ value: '1.2 to 12.3', unit: '' })];
let base = null;
try {
  const dir = mkdtempSync(join(tmpdir(), 'hero-base-'));
  mkdirSync(join(dir, 'runtime'), { recursive: true });
  execFileSync('sh', ['-c', `git -C '${ROOT}' archive a4d4cb0 runtime/pi | tar -x -C '${dir}'`], { stdio: 'pipe' });
  base = await import(pathToFileURL(join(dir, 'runtime/pi/infographic.mjs')).href);
} catch { console.log('SKIP off-equality: commit a4d4cb0 not available'); }
if (base) {
  for (const h of cases) for (const extra of [{}, { verified_claim_ids: [] }, { verified_claim_ids: [A] }]) {
    const c = ctx(extra);
    assert.deepEqual(lintInfographicSpec(page(h), {}, c), base.lintInfographicSpec(page(h), {}, c), `off differs from a4d4cb0: ${JSON.stringify(h)}`);
    const o = ctx({ ...extra, hero_value_gate: false });
    assert.deepEqual(lintInfographicSpec(page(h), {}, o), base.lintInfographicSpec(page(h), {}, o)); n += 2;
  }
}
console.log(`hero value gate: ${n} checks -- PASS`);
