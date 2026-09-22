#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { localSqliteQuery, localText } from '../runtime/pi/local_backend.mjs';
import { runTaskDag } from '../runtime/pi/parallel_scheduler.mjs';

assert.equal(process.platform, 'darwin', 'the semantic local backend path requires macOS');
const root = await mkdtemp(join(tmpdir(), 'newsroom-r6-parallel-replay-'));
process.env.NEWSROOM_ARTIFACT_DIR = root;
const text = 'complete local evidence '.repeat(4_000);
await writeFile(join(root, 'evidence.txt'), text, 'utf8');
const database = join(root, 'evidence.sqlite');
const sqlite = spawnSync('/usr/bin/sqlite3', [database, 'create table items(id integer, value text);'], { encoding: 'utf8' });
assert.equal(sqlite.status, 0, sqlite.stderr);
const rowsSql = Array.from({ length: 240 }, (_, index) => `insert into items values (${index}, '${'value-' + index + '-'.repeat(80)}');`).join(' ');
const insert = spawnSync('/usr/bin/sqlite3', [database, rowsSql], { encoding: 'utf8' });
assert.equal(insert.status, 0, insert.stderr);
const events = [];

const result = await runTaskDag([
  { id: 'text', kind: 'local_text', path: 'evidence.txt' },
  { id: 'sqlite', kind: 'sqlite_query', path: 'evidence.sqlite', sql: 'select id, value from items order by id' },
], async (task) => {
  if (task.kind === 'local_text') return localText(task.path, { full: true });
  if (task.kind === 'sqlite_query') return localSqliteQuery(task.path, task.sql);
  throw new Error(`unexpected task kind: ${task.kind}`);
}, {
  artifactRoot: root,
  maxConcurrency: 2,
  resultBudgets: { local: 8192, data: 8192, default: 8192 },
  batchOutputBudget: 8192,
  emit: async (event) => events.push(event),
});

assert.equal(result.status, 'ok');
assert.equal(result.failed.length, 0);
assert.equal(result.output_budget.per_task_truncated, 2);
assert.ok(result.output_budget.full_batch_ref, 'aggregate replay reference is required');
const fullBatch = JSON.parse(await readFile(join(root, result.output_budget.full_batch_ref), 'utf8'));
assert.equal(fullBatch.text.text, text);
assert.equal(fullBatch.sqlite.rows.length, 240);
for (const id of ['text', 'sqlite']) {
  const event = events.find((entry) => entry.type === 'newsroom_task_completed' && entry.task_id === id);
  assert.ok(event?.full_result_ref, `${id} must expose its full replay ref`);
  assert.ok((await stat(join(root, event.full_result_ref))).isFile());
  const full = JSON.parse(await readFile(join(root, event.full_result_ref), 'utf8'));
  if (id === 'text') assert.equal(full.text, text);
  else assert.equal(full.rows.length, 240);
}
assert.ok(result.results.text.preview_json.length < text.length);
assert.ok(result.results.sqlite.preview_json.length < JSON.stringify(fullBatch.sqlite).length);

console.log(JSON.stringify({
  status: 'PASS',
  text_complete_bytes: Buffer.byteLength(text, 'utf8'),
  sqlite_complete_rows: 240,
  per_task_truncated: result.output_budget.per_task_truncated,
  full_result_refs_replayable: true,
  full_batch_ref_replayable: true,
  scheduler_is_model_visible_budget_owner: true,
}, null, 2));
