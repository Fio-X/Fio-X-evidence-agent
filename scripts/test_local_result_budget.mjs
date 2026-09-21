#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localText } from '../runtime/pi/local_backend.mjs';
const root = await mkdtemp(join(tmpdir(), 'newsroom-r5-local-'));
process.env.NEWSROOM_ARTIFACT_DIR = root;
const source = 'row,body\n' + Array.from({ length: 180_000 }, (_, i) => `${i},${'x'.repeat(12)}`).join('\n');
await writeFile(join(root, 'large.csv'), source);
const baseline = await localText('large.csv');
const bounded = await localText('large.csv', { maxBytes: 64 * 1024 });
const full = await localText('large.csv', { full: true });
assert.equal(baseline.truncated, true);
assert.ok(Buffer.byteLength(baseline.text) <= 2 * 1024 * 1024);
assert.ok(Buffer.byteLength(bounded.text) <= 64 * 1024);
assert.equal(bounded.truncated, true);
assert.equal(full.text, source);
assert.equal(full.truncated, false);
const backend = await readFile(new URL('../runtime/pi/local_backend.mjs', import.meta.url), 'utf8');
assert.match(backend, /-readonly/);
assert.doesNotMatch(backend, /maxRows/);
console.log(JSON.stringify({
  status: 'PASS',
  source_bytes: Buffer.byteLength(source),
  default_bytes: Buffer.byteLength(baseline.text),
  bounded_bytes: Buffer.byteLength(bounded.text),
  full_bytes: Buffer.byteLength(full.text),
  default_truncated: baseline.truncated,
  explicit_max_bytes_truncated: bounded.truncated,
  full_mode_complete: full.text === source,
  read_only_sqlite: true,
  helper_max_rows_absent: true,
}, null, 2));
