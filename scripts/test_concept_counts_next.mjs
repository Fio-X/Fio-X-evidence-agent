#!/usr/bin/env node
// The concept counts of newsroom.ts by switch: the new route loosens the tournament's count and framings only; the award
// summary keeps its count on both routes. The three functions are taken from the source and run with a stub switch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../runtime/pi/newsroom.ts', import.meta.url), 'utf8');
const body = (name) => {
  const found = source.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(found, name);
  return found[0];
};
const counts = (env) => {
  const make = new Function('process', 'nextRouteEnabled', `${body('awardMinConcepts')}\n${body('conceptMinCount')}\n${body('conceptMinFramings')}\nreturn { award: awardMinConcepts(), tournament: conceptMinCount(), framings: conceptMinFramings() };`);
  return make({ env }, () => env.NEWSROOM_NEXT === '1');
};
assert.deepEqual(counts({}), { award: 8, tournament: 8, framings: 3 });
assert.deepEqual(counts({ NEWSROOM_CONCEPT_COUNT_3: '1' }), { award: 3, tournament: 3, framings: 3 });
assert.deepEqual(counts({ NEWSROOM_NEXT: '1' }), { award: 8, tournament: 1, framings: 1 });
// Every award summary call reads the award count, never the tournament's.
const calls = source.match(/summarizeAwardMode\(params, \{[^\n]*\}\)/g);
assert.equal(calls.length, 2);
for (const call of calls) assert.ok(call.includes('minConcepts: awardMinConcepts()') && !call.includes('conceptMinCount'), call);
console.log('concept counts by switch: PASS');
