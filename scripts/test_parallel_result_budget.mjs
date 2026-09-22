#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskDag } from '../runtime/pi/parallel_scheduler.mjs';
const root = await mkdtemp(join(tmpdir(), 'newsroom-r5-parallel-'));
const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `task-${i}`, kind: 'local_text' }));
const runner = async (task) => ({ path: task.id, text: 'local evidence '.repeat(2400), rows: Array.from({ length: 180 }, (_, i) => ({ id: i })) });
const baseline = await runTaskDag(tasks, runner, { artifactRoot: root, maxConcurrency: 8 });
const bounded = await runTaskDag(tasks, runner, { artifactRoot: root, maxConcurrency: 8, resultBudgets: { local: 8192, data: 8192, default: 8192 }, batchOutputBudget: 32768 });
assert.equal(bounded.status, baseline.status);
assert.equal(bounded.failed.length, 0);
assert.equal(bounded.output_budget.batch_truncated, true);
assert.ok(bounded.output_budget.full_batch_ref);
assert.ok((await stat(join(root, bounded.output_budget.full_batch_ref))).isFile());
const full = JSON.parse(await readFile(join(root, bounded.output_budget.full_batch_ref), 'utf8'));
assert.equal(full['task-0'].text.length, 36_000);
console.log(JSON.stringify({ status: 'PASS', task_count: tasks.length, batch_truncated: true, full_batch_replayable: true, batch_limit_bytes: 32768 }, null, 2));
