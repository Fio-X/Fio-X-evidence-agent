#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskDag } from '../runtime/pi/parallel_scheduler.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectReject(tasks, pattern) {
  await assert.rejects(() => runTaskDag(tasks, async () => ({ ok: true })), pattern);
}

await expectReject([{ id: 'a', depends_on: ['b'] }, { id: 'b', depends_on: ['a'] }], /contains cycle/i);
await expectReject([{ id: 'a' }, { id: 'a' }], /duplicate task id/i);
await expectReject([{ id: 'a', depends_on: ['missing'] }], /unknown dependency/i);
await expectReject([{ id: 'absolute', write_scope: ['/artifact/out.json'] }], /write_scope must be relative/i);
await expectReject([{ id: 'windows-absolute', write_scope: ['C:\\artifact\\out.json'] }], /write_scope must be relative/i);
await expectReject([{ id: 'unc-absolute', write_scope: ['\\\\server\\share\\out.json'] }], /write_scope must be relative/i);
await expectReject([{ id: 'traversal', write_scope: ['reports/../secret.json'] }], /write_scope traversal is not allowed/i);

const orderTasks = [
  { id: 'slow', kind: 'local_hash' },
  { id: 'fast', kind: 'local_hash' },
  { id: 'join', kind: 'local_hash', depends_on: ['slow', 'fast'] },
];
const ordered = await runTaskDag(orderTasks, async (task) => {
  if (task.id === 'slow') await sleep(40);
  if (task.id === 'fast') await sleep(5);
  return { id: task.id };
}, { maxConcurrency: 2 });
assert.deepEqual(ordered.completed, ['slow', 'fast', 'join']);
assert.deepEqual(Object.keys(ordered.results), ['slow', 'fast', 'join']);

const partial = await runTaskDag([
  { id: 'root', kind: 'local_hash' },
  { id: 'dependent', kind: 'local_hash', depends_on: ['root'] },
  { id: 'independent', kind: 'local_hash' },
], async (task) => {
  if (task.id === 'root') throw new Error('boom');
  return { id: task.id, backend: 'test:local' };
}, { maxConcurrency: 3 });
assert.equal(partial.status, 'partial');
assert.deepEqual(partial.failed.map((row) => row.id), ['root']);
assert.deepEqual(partial.blocked.map((row) => row.id), ['dependent']);
assert.deepEqual(partial.completed, ['independent']);

const classified = [];
await runTaskDag([
  { id: 'n', kind: 'fetch_url', url: 'https://Example.COM/a', resource_class: 'local', resource_key: 'network:spoof.example' },
  { id: 'd', kind: 'duckdb_query', resource_class: 'local' },
  { id: 'l', kind: 'local_hash', resource_class: 'network', resource_key: 'network:spoof' },
], async (task) => {
  classified.push({ id: task.id, resource_class: task.resource_class, resource_key: task.resource_key });
  return { ok: true };
}, { maxConcurrency: 3 });
assert.deepEqual(classified.sort((a, b) => a.id.localeCompare(b.id)), [
  { id: 'd', resource_class: 'data', resource_key: null },
  { id: 'l', resource_class: 'local', resource_key: null },
  { id: 'n', resource_class: 'network', resource_key: 'network:example.com' },
]);

let sameHost = 0;
let maxSameHost = 0;
await runTaskDag(Array.from({ length: 5 }, (_, i) => ({
  id: `n${i}`,
  kind: 'fetch_url',
  url: `https://example.com/${i}`,
})), async (task) => {
  assert.equal(task.resource_class, 'network');
  sameHost += 1;
  maxSameHost = Math.max(maxSameHost, sameHost);
  await sleep(15);
  sameHost -= 1;
  return { ok: true };
}, { maxConcurrency: 5, resourceLimits: { network: 5 } });
assert.ok(maxSameHost <= 2, `per-host limit exceeded: ${maxSameHost}`);

const normalizedScopes = {};
const activeWriters = new Set();
let independentWriteOverlap = false;
await runTaskDag([
  { id: 'child', kind: 'local_hash', write_scope: ['reports//daily/./summary.json', 'reports/daily/summary.json'] },
  { id: 'parent', kind: 'local_hash', write_scope: ['reports/daily/'] },
  { id: 'other', kind: 'local_hash', write_scope: ['reports/other/output.json'] },
], async (task) => {
  normalizedScopes[task.id] = task.write_scope;
  if (task.id === 'parent') assert.ok(!activeWriters.has('child'), 'parent/child write scopes overlapped');
  if (task.id === 'other' && activeWriters.has('child')) independentWriteOverlap = true;
  activeWriters.add(task.id);
  await sleep(task.id === 'child' ? 35 : 8);
  activeWriters.delete(task.id);
  return { ok: true };
}, { maxConcurrency: 3 });
assert.deepEqual(normalizedScopes.child, ['reports/daily/summary.json']);
assert.deepEqual(normalizedScopes.parent, ['reports/daily']);
assert.deepEqual(normalizedScopes.other, ['reports/other/output.json']);
assert.equal(independentWriteOverlap, true, 'independent write scope should run in parallel');

const fairnessStarts = [];
let longKeyFinished = false;
const fairness = await runTaskDag([
  { id: 'a-long', kind: 'fetch_url', url: 'https://a.example/1' },
  { id: 'a-next', kind: 'fetch_url', url: 'https://a.example/2' },
  { id: 'b-ready', kind: 'fetch_url', url: 'https://b.example/1' },
], async (task) => {
  fairnessStarts.push(task.id);
  if (task.id === 'b-ready') assert.equal(longKeyFinished, false, 'ready task on another key was starved behind throttled key');
  await sleep(task.id === 'a-long' ? 40 : 5);
  if (task.id === 'a-long') longKeyFinished = true;
  return { ok: true };
}, {
  maxConcurrency: 2,
  resourceLimits: { network: 2 },
  keyLimits: { 'network:a.example': 1, 'network:b.example': 1 },
});
assert.deepEqual(fairnessStarts.slice(0, 2), ['a-long', 'b-ready']);
assert.deepEqual(fairness.completed, ['a-long', 'a-next', 'b-ready']);

const artifactRoot = await mkdtemp(join(tmpdir(), 'newsroom-parallel-budget-'));
const largeText = 'x'.repeat(20_000);
const perTask = await runTaskDag([
  { id: 'large', kind: 'local_text' },
  { id: 'small', kind: 'local_hash' },
], async (task) => task.id === 'large'
  ? { backend: 'test:text', text: largeText, path: 'data/full.txt' }
  : { backend: 'test:hash', sha256: 'abc' }, {
  maxConcurrency: 2,
  artifactRoot,
  resultBudgets: { local: 2048, default: 2048 },
  batchOutputBudget: 64 * 1024,
});
assert.equal(perTask.output_budget.per_task_truncated, 1);
assert.equal(perTask.results.large.truncated, true);
assert.equal(perTask.results.large.truncation_reason, 'parallel_task_output_budget');
assert.ok(perTask.results.large.full_result_ref);
assert.ok(perTask.results.large.full_result_sha256);
const storedTaskPath = join(artifactRoot, perTask.results.large.full_result_ref);
assert.ok((await stat(storedTaskPath)).isFile());
assert.equal(JSON.parse(await readFile(storedTaskPath, 'utf8')).text.length, largeText.length);

const batchRoot = await mkdtemp(join(tmpdir(), 'newsroom-parallel-batch-budget-'));
const aggregate = await runTaskDag(Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, kind: 'duckdb_query' })), async (task) => ({
  backend: 'test:data',
  rows: Array.from({ length: 80 }, (_, i) => ({ task: task.id, i, text: 'z'.repeat(80) })),
}), {
  maxConcurrency: 6,
  artifactRoot: batchRoot,
  resultBudgets: { data: 1024 * 1024 },
  batchOutputBudget: 12 * 1024,
});
assert.equal(aggregate.output_budget.batch_truncated, true);
assert.ok(aggregate.output_budget.full_batch_ref);
assert.ok(aggregate.output_budget.full_batch_sha256);
assert.ok(aggregate.output_budget.aggregate_returned_bytes <= 12 * 1024);
for (const value of Object.values(aggregate.results)) {
  assert.equal(value.truncated, true);
  assert.equal(value.truncation_reason, 'parallel_batch_output_budget');
}
assert.ok((await stat(join(batchRoot, aggregate.output_budget.full_batch_ref))).isFile());

const events = [];
const metrics = await runTaskDag([
  { id: 'local-ok', kind: 'local_hash' },
  { id: 'network-ok', kind: 'fetch_url', url: 'https://metrics.example/a' },
  { id: 'data-fail', kind: 'duckdb_query' },
  { id: 'blocked', kind: 'local_hash', depends_on: ['data-fail'] },
], async (task) => {
  await sleep(5);
  if (task.id === 'data-fail') throw new Error('expected failure');
  return { backend: task.id === 'local-ok' ? 'macos:shasum' : 'portable:fetch', ok: true };
}, { maxConcurrency: 3, emit: async (event) => events.push(event) });
assert.equal(metrics.failed.length, 1);
assert.equal(metrics.blocked.length, 1);
assert.equal(metrics.resource_stats.local.started, 1);
assert.equal(metrics.resource_stats.network.completed, 1);
assert.equal(metrics.resource_stats.data.failed, 1);
assert.ok(metrics.resource_stats.local.peak_concurrency >= 1);
assert.equal(metrics.backend_distribution['macos:shasum'], 1);
assert.equal(metrics.backend_distribution['portable:fetch'], 1);
const batchEnd = events.find((event) => event.type === 'newsroom_parallel_batch_end');
assert.ok(batchEnd);
assert.equal(batchEnd.failed_tasks, 1);
assert.equal(batchEnd.blocked_tasks, 1);
assert.deepEqual(batchEnd.backend_distribution, metrics.backend_distribution);
assert.deepEqual(batchEnd.resource_stats, metrics.resource_stats);
assert.ok(batchEnd.duration_ms >= 0);

console.log(JSON.stringify({
  status: 'PASS',
  max_same_host: maxSameHost,
  write_scope_normalization: true,
  fairness_no_starvation: true,
  per_task_truncated: perTask.output_budget.per_task_truncated,
  batch_truncated: aggregate.output_budget.batch_truncated,
  metric_resources: Object.keys(metrics.resource_stats),
}, null, 2));
