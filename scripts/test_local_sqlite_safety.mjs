#!/usr/bin/env node
// sqlite_query must not read or write files outside the database: -readonly only
// protects the database, so the shell's file functions are blocked twice
// (deny-list regex, then sqlite3 -safe). Uses a fake secret in a temp dir only.
import { makeTestTmp } from "./tmp_helper.mjs";
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSqliteQuery, safeReadOnlySql } from '../runtime/pi/local_backend.mjs';

const SQLITE = '/usr/bin/sqlite3';
if (process.platform !== 'darwin' || !existsSync(SQLITE)) {
  console.log(JSON.stringify({ status: 'SKIP', reason: 'macOS sqlite3 not available' }));
  process.exit(0);
}
const root = makeTestTmp('newsroom-sqlite-safety-');
process.env.NEWSROOM_ARTIFACT_DIR = root;
const FAKE_SECRET = 'FAKE-SECRET-NOT-A-REAL-KEY';
const secretPath = join(root, 'secret.txt');
await writeFile(secretPath, FAKE_SECRET);
execFileSync(SQLITE, [join(root, 'x.db'), 'create table t(a); insert into t values (1),(2)']);

// 1. writefile must not create the file (rejected before sqlite3 runs).
const pwned = join(root, 'pwned.txt');
await assert.rejects(
  localSqliteQuery('x.db', `select writefile('${pwned}', 'owned')`),
  /read-only SELECT/,
);
assert.equal(existsSync(pwned), false, 'writefile must not produce a file');

// 2. readfile and fsdir are rejected, so the secret never comes back.
for (const sql of [
  `select readfile('${secretPath}')`,
  `select * from fsdir('${root}')`,
  `select edit('x')`,
  `select load_extension('x')`,
  `select * from zipfile('x.zip')`,
  `SELECT ReadFile('${secretPath}')`,
]) {
  await assert.rejects(localSqliteQuery('x.db', sql), /read-only SELECT/, sql);
  assert.equal(safeReadOnlySql(sql), false, sql);
}

// 3. Second layer: bypass the regex and run sqlite3 exactly as the backend does.
// -safe refuses these functions even when the deny-list is skipped.
const direct = (sql) => spawnSync(SQLITE, ['-safe', '-readonly', '-json', join(root, 'x.db'), sql], { encoding: 'utf8' });
const w = direct(`select writefile('${pwned}', 'owned')`);
assert.match(w.stderr, /cannot use the writefile\(\) function in safe mode/);
assert.equal(existsSync(pwned), false);
const r = direct(`select readfile('${secretPath}')`);
assert.match(r.stderr, /cannot use the readfile\(\) function in safe mode/);
assert.ok(!r.stdout.includes(FAKE_SECRET) && !r.stdout.includes('\\u0046\\u0041\\u004b\\u0045'), 'secret must not appear on stdout');
// -safe alone does NOT stop fsdir (it lists and reads files), which is why the regex layer must also reject it.
assert.equal(safeReadOnlySql(`select name from fsdir('${root}')`), false);

// 3b. One statement only: a second statement must not ride behind an allowed first one.
for (const sql of [
  'select 1; select 2',
  "select 1; pragma temp_store_directory='/tmp/x'",
  'select 1;\n.shell echo hi',
  'select 1 /* x */; pragma x',
  'select 1;;',
  "select 'a'; select 'b'",
  "select 'unterminated",
  'select 1 /* unterminated',
  'select 1 -- c\n; select 2',
]) {
  assert.equal(safeReadOnlySql(sql), false, sql);
  await assert.rejects(localSqliteQuery('x.db', sql), /read-only SELECT/, sql);
}
for (const sql of [
  'select 1',
  'select 1;',
  'select 1;  \n',
  "select 'a;b'",
  'select "a;b" from (select 1 as "a;b")',
  'pragma table_info(t)',
  'with c as (select a from t) select * from c',
  'with c as (select a from t) select * from c;',
  'select 1 /* note; */',
  'select 1; -- trailing comment',
]) {
  assert.equal(safeReadOnlySql(sql), true, sql);
}
// 4. The backend still passes -safe, and ordinary reads work.
const backend = await readFile(new URL('../runtime/pi/local_backend.mjs', import.meta.url), 'utf8');
assert.match(backend, /\['-safe', '-readonly', '-json'/);
const ok = await localSqliteQuery('x.db', 'select a from t order by a');
assert.deepEqual(ok.rows, [{ a: 1 }, { a: 2 }]);
console.log(JSON.stringify({ status: 'PASS', blocked: 7 }));
