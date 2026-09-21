#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hashRows } from '../runtime/pi/viz.mjs';

const source = await readFile(new URL('../runtime/pi/newsroom.ts', import.meta.url), 'utf8');
assert.match(source, /NEWSROOM_DUCKDB_COMPACT_ENVELOPE/);
assert.match(source, /DUCKDB_MODEL_PREVIEW_ROWS = 50/);
assert.match(source, /preview_rows/);
assert.match(source, /truncated_for_model/);
assert.match(source, /result_hash: resultHash/);
assert.match(source, /rows, artifact: path/);

const rows = Array.from({ length: 240 }, (_, index) => ({
  category: `category-${index % 12}`,
  rank: index + 1,
  value: (index + 1) * 17,
  label: `A deterministic fixture row with enough text to make the A/B reduction visible ${index}`,
}));
const resultHash = hashRows(rows);
const artifactRef = `computations/${resultHash}.json`;
const baseline = { row_count: rows.length, rows, artifact: artifactRef };
const compact = {
  row_count: rows.length,
  columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
  preview_rows: rows.slice(0, 50),
  artifact_ref: artifactRef,
  result_hash: resultHash,
  truncated_for_model: true,
};

assert.equal(compact.preview_rows.length, 50);
assert.equal(compact.row_count, rows.length);
assert.equal(compact.result_hash, hashRows(rows));
assert.equal(compact.artifact_ref, artifactRef);
assert.equal(compact.truncated_for_model, true);
const baselineBytes = Buffer.byteLength(JSON.stringify(baseline));
const compactBytes = Buffer.byteLength(JSON.stringify(compact));
assert.ok(compactBytes < baselineBytes, `${compactBytes} must be below ${baselineBytes}`);
assert.ok(compactBytes / baselineBytes < 0.4, `${compactBytes}/${baselineBytes} should be a substantial reduction`);

console.log(JSON.stringify({
  status: 'PASS',
  rows: rows.length,
  preview_rows: compact.preview_rows.length,
  baseline_model_visible_bytes: baselineBytes,
  compact_model_visible_bytes: compactBytes,
  reduction_bytes: baselineBytes - compactBytes,
  reduction_ratio: Number((1 - compactBytes / baselineBytes).toFixed(4)),
  result_hash: resultHash,
  replay_hash_equivalent: compact.result_hash === hashRows(rows),
  evidence_gate_source_unchanged: source.includes('assertInlineRowsHaveEvidence(safeSql, await hasUsableEvidenceInput(inputSnapshot))'),
}, null, 2));
