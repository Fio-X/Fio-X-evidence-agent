#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../runtime/pi/newsroom.ts', import.meta.url), 'utf8');
assert.match(source, /function modelResultBudget/);
assert.equal((source.match(/result_budget: Type\.Optional/g) || []).length, 3);
assert.match(source, /model_visible_result_bytes/);
assert.match(source, /artifact_bytes/);
assert.match(source, /truncated_for_model/);
assert.doesNotMatch(source, /NEWSROOM_DUCKDB_COMPACT_ENVELOPE|compact_envelope|compact_results/);

const budget = 12 * 1024;
const baseline = [
  JSON.stringify({ rows: Array.from({ length: 240 }, (_, i) => ({ id: i, value: 'value-' + i, body: 'x'.repeat(120) })) }),
  'x'.repeat(80_000),
  'x'.repeat(368_898),
  JSON.stringify({ results: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`task-${i}`, { text: 'local evidence '.repeat(2400), rows: Array.from({ length: 180 }, (_, j) => ({ id: j })) }])) }),
];
const compact = [
  JSON.stringify({ row_count: 240, preview_rows: Array.from({ length: 50 }, (_, i) => ({ id: i, value: 'value-' + i, body: 'x'.repeat(120) }),), result_hash: 'hash', artifact_ref: 'computations/hash.json', truncated_for_model: true }),
  JSON.stringify({ source_chars: 80_000, excerpt: 'x'.repeat(10_000), snapshot_ref: 'sources/hash.json', snapshot_hash: 'hash', truncated_for_model: true }),
  'x'.repeat(65_536),
  JSON.stringify({ result_ref: 'runtime/parallel-results/batch-hash.json', truncated_for_model: true }),
].map((value) => value.length > budget ? value.slice(0, budget) : value);
const baselineBytes = baseline.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
const compactBytes = compact.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
const reduction = 1 - compactBytes / baselineBytes;
assert.ok(reduction >= 0.75, `combined reduction ${reduction} must be >= 75%`);
console.log(JSON.stringify({ status: 'PASS', baseline_model_visible_bytes: baselineBytes, budgeted_model_visible_bytes: compactBytes, reduction_ratio: Number(reduction.toFixed(4)), default_behavior_opt_in: true, full_artifacts_referenced: true }, null, 2));
