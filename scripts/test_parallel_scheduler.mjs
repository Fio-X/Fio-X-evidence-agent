#!/usr/bin/env node
import assert from 'node:assert/strict';
import { runTaskDag } from '../runtime/pi/parallel_scheduler.mjs';

async function expectReject(tasks, pattern) {
  await assert.rejects(() => runTaskDag(tasks, async () => ({ ok: true })), pattern);
}

await expectReject([
  { id: 'a', depends_on: ['b'] },
  { id: 'b', depends_on: ['a'] },
], /contains cycle/i);

await expectReject([
  { id: 'a' },
  { id: 'a' },
], /duplicate task id/i);

await expectReject([
  { id: 'a', depends_on: ['missing'] },
], /unknown dependency/i);

const orderTasks = [
  { id: 'slow', kind: 'local_hash' },
  { id: 'fast', kind: 'local_hash' },
  { id: 'join', kind: 'local_hash', depends_on: ['slow', 'fast'] },
];
const ordered = await runTaskDag(orderTasks, async (task) => {
  if (task.id === 'slow') await new Promise((resolve) => setTimeout(resolve, 40));
  if (task.id === 'fast') await new Promise((resolve) => setTimeout(resolve, 5));
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
  return { id: task.id };
}, { maxConcurrency: 3 });
assert.equal(partial.status, 'partial');
assert.deepEqual(partial.failed.map((row) => row.id), ['root']);
assert.deepEqual(partial.blocked.map((row) => row.id), ['dependent']);
assert.deepEqual(partial.completed, ['independent']);

const classified = [];
await runTaskDag([
  { id: 'n', kind: 'fetch_url', url: 'https://Example.COM/a', resource_class: 'local', resource_key: 'local:spoof' },
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
  resource_key: 'network:example.com',
})), async (task) => {
  assert.equal(task.resource_class, 'network');
  sameHost += 1;
  maxSameHost = Math.max(maxSameHost, sameHost);
  await new Promise((resolve) => setTimeout(resolve, 15));
  sameHost -= 1;
  return { ok: true };
}, { maxConcurrency: 5, resourceLimits: { network: 5 } });
assert.ok(maxSameHost <= 2, `per-host limit exceeded: ${maxSameHost}`);

console.log(JSON.stringify({ status: 'PASS', max_same_host: maxSameHost }, null, 2));
