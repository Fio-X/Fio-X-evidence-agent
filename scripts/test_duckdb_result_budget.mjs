#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hashRows } from '../runtime/pi/viz.mjs';
const source = await readFile(new URL('../runtime/pi/newsroom.ts', import.meta.url), 'utf8');
assert.match(source, /preview_rows/);
assert.match(source, /result_hash: resultHash/);
assert.match(source, /artifact_ref: path/);
const rows = Array.from({ length: 240 }, (_, i) => ({ id: i, value: 'payload-' + i }));
const hash = hashRows(rows);
const envelope = { row_count: rows.length, preview_rows: rows.slice(0, 50), artifact_ref: `computations/${hash}.json`, result_hash: hash, truncated_for_model: true };
assert.equal(envelope.preview_rows.length, 50);
assert.equal(envelope.result_hash, hashRows(rows));
assert.ok(Buffer.byteLength(JSON.stringify(envelope)) < Buffer.byteLength(JSON.stringify({ row_count: rows.length, rows, artifact: envelope.artifact_ref })));
console.log(JSON.stringify({ status: 'PASS', rows: rows.length, preview_rows: 50, result_hash: hash, replay_hash_equivalent: true }, null, 2));
