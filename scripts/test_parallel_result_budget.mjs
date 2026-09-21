#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskDag } from '../runtime/pi/parallel_scheduler.mjs';

const newsroom = await readFile(new URL('../runtime/pi/newsroom.ts', import.meta.url), 'utf8');
assert.match(newsroom, /compact_results: Type\.Optional\(Type\.Boolean/);
assert.match(newsroom, /resultBudgets: \{ local: resultBudgetBytes, data: resultBudgetBytes/);
assert.match(newsroom, /const response = compactResults \? \{ \.\.\.result, result_ref: resultRef \}/);

const root = await mkdtemp(join(tmpdir(), 'newsroom-parallel-envelope-'));
const tasks = [
  ...Array.from({ length: 6 }, (_, i) => ({ id: `text-${i}`, kind: 'local_text' })),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `sql-${i}`, kind: 'sqlite_query' })),
];
const runner = async (task) => ({
  backend: task.kind === 'sqlite_query' ? 'sqlite:readonly' : 'local:text',
  rows: task.kind === 'sqlite_query' ? Array.from({ length: 180 }, (_, i) => ({ id: i, value: 'sqlite-value-' + i })) : undefined,
  text: task.kind === 'local_text' ? 'local evidence '.repeat(2400) : undefined,
  path: `synthetic/${task.id}`,
});

const baseline = await runTaskDag(tasks, runner, { artifactRoot: root, maxConcurrency: 8 });
const compact = await runTaskDag(tasks, runner, {
  artifactRoot: root,
  maxConcurrency: 8,
  resultBudgets: { local: 8192, data: 8192, default: 8192 },
  batchOutputBudget: 32768,
});
const baselineBytes = Buffer.byteLength(JSON.stringify(baseline));
const compactBytes = Buffer.byteLength(JSON.stringify({ ...compact, result_ref: compact.output_budget.full_batch_ref ?? null }));
assert.ok(compact.output_budget.batch_truncated, 'compact A/B must persist the full batch');
assert.ok(compact.output_budget.full_batch_ref);
assert.ok(compact.output_budget.full_batch_sha256);
assert.ok(compactBytes < baselineBytes, 'compact response must be smaller');
assert.ok(compactBytes <= 32768);
assert.equal(compact.status, baseline.status);
assert.deepEqual(compact.completed, baseline.completed);
assert.equal(compact.failed.length, 0);
assert.equal(compact.blocked.length, 0);
const fullPath = join(root, compact.output_budget.full_batch_ref);
assert.ok((await stat(fullPath)).isFile());
const full = JSON.parse(await readFile(fullPath, 'utf8'));
assert.equal(full['text-0'].text.length, 36000);
assert.equal(full['sql-0'].rows.length, 180);
assert.match(JSON.stringify(compact.results), /full_batch_ref/);

console.log(JSON.stringify({
  status: 'PASS',
  baseline_model_visible_bytes: baselineBytes,
  compact_model_visible_bytes: compactBytes,
  reduction_percent: Number(((1 - compactBytes / baselineBytes) * 100).toFixed(2)),
  full_artifact_bytes: Buffer.byteLength(JSON.stringify(full)),
  task_count: tasks.length,
  compact_result_ref: compact.output_budget.full_batch_ref,
}, null, 2));
