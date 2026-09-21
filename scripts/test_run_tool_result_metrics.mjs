#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'r5-tool-metrics-'));
const events = [
  { type: 'tool_execution_end', tool_result_metrics: { tool_name: 'fixture_tool', model_visible_result_bytes: 12, artifact_bytes: 42, truncated_for_model: true } },
  { type: 'newsroom_rpc_metrics', outcome: 'success', prompt_bytes: 7, tokens_input: 3 },
];
await writeFile(join(root, 'events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
const parsed = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const metric = parsed.find((event) => event.tool_result_metrics)?.tool_result_metrics;
assert.deepEqual(metric, events[0].tool_result_metrics);
assert.equal(parsed.filter((event) => event.type === 'newsroom_rpc_metrics').length, 1);
console.log(JSON.stringify({ status: 'PASS', tool_result_bytes_total: metric.model_visible_result_bytes, artifact_bytes_total: metric.artifact_bytes, truncated_count: 1 }));
