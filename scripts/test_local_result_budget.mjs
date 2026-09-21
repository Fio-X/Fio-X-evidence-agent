#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localSqliteQuery, localText } from '../runtime/pi/local_backend.mjs';

const execFileAsync = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), 'newsroom-local-result-budget-'));
process.env.NEWSROOM_ARTIFACT_DIR = root;
const source = 'row,body\n' + Array.from({ length: 20000 }, (_, i) => `${i},${'x'.repeat(12)}`).join('\n');
await writeFile(join(root, 'large.csv'), source, 'utf8');
const baseline = await localText('large.csv');
const bounded = await localText('large.csv', { maxBytes: 64 * 1024 });
assert.equal(baseline.text.length, source.length);
assert.ok(Buffer.byteLength(bounded.text, 'utf8') <= 64 * 1024);
assert.equal(bounded.truncated, true);
assert.equal(bounded.path, baseline.path);

const extension = await readFile(new URL('../runtime/pi/newsroom.ts', import.meta.url), 'utf8');
const backend = await readFile(new URL('../runtime/pi/local_backend.mjs', import.meta.url), 'utf8');
assert.match(extension, /result_budget/);
assert.match(extension, /maxBytes: resultBudget\.maxBytes/);
assert.match(extension, /maxRows: resultBudget\.maxRows/);
assert.match(backend, /local_sqlite_query accepts read-only/); // safety implementation remains authoritative

const database = join(root, 'sample.sqlite');
await execFileAsync('/usr/bin/sqlite3', [database, 'CREATE TABLE facts(id INTEGER, body TEXT); WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM seq WHERE id < 200) INSERT INTO facts SELECT id, printf(\'payload-%03d\', id) FROM seq;']);
const sqlite = await localSqliteQuery('sample.sqlite', 'SELECT id, body FROM facts ORDER BY id', { maxBytes: 1024, maxRows: 3 });
assert.equal(sqlite.total_rows, 200);
assert.equal(sqlite.rows.length, 3);
assert.equal(sqlite.truncated, true);
assert.ok(sqlite.preview_bytes <= 1024);
await assert.rejects(() => localSqliteQuery('sample.sqlite', 'DELETE FROM facts'));

console.log(JSON.stringify({
  status: 'PASS',
  baseline_bytes: Buffer.byteLength(baseline.text, 'utf8'),
  bounded_bytes: Buffer.byteLength(bounded.text, 'utf8'),
  reduction_ratio: 1 - Buffer.byteLength(bounded.text, 'utf8') / Buffer.byteLength(baseline.text, 'utf8'),
  sqlite_total_rows: sqlite.total_rows,
  sqlite_preview_rows: sqlite.rows.length,
  sqlite_preview_bytes: sqlite.preview_bytes,
  sqlite_truncated: sqlite.truncated,
}, null, 2));
