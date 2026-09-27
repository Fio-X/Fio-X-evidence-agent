#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localText } from '../runtime/pi/local_backend.mjs';
const root = await mkdtemp(join(tmpdir(), 'newsroom-r5-local-'));
process.env.NEWSROOM_ARTIFACT_DIR = root;
const source = 'row,body\n' + Array.from({ length: 20_000 }, (_, i) => `${i},${'x'.repeat(12)}`).join('\n');
await writeFile(join(root, 'large.csv'), source);
const baseline = await localText('large.csv');
const bounded = await localText('large.csv', { maxBytes: 64 * 1024 });
assert.equal(baseline.text.length, source.length);
assert.ok(Buffer.byteLength(bounded.text) <= 64 * 1024);
assert.equal(bounded.truncated, true);
const backend = await readFile(new URL('../runtime/pi/local_backend.mjs', import.meta.url), 'utf8');
assert.match(backend, /-readonly/);
assert.match(backend, /maxRows/);
console.log(JSON.stringify({ status: 'PASS', baseline_bytes: Buffer.byteLength(source), bounded_bytes: Buffer.byteLength(bounded.text), read_only_sqlite: true, source_unchanged: true }, null, 2));
