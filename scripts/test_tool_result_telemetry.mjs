#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../runtime/pi/newsroom.ts', import.meta.url), 'utf8');
const match = source.match(/function textResult\([\s\S]*?\n\}/);
assert.ok(match, 'textResult helper must remain present');
const executable = match[0]
  .replaceAll('text: string', 'text').replaceAll('details: Record<string, unknown>', 'details')
  .replace('telemetry: { artifact_bytes?: number; truncated_for_model?: boolean }', 'telemetry')
  .replace('const resultDetails: Record<string, unknown>', 'const resultDetails').replaceAll(' as const', '');
const textResult = vm.runInNewContext(`(${executable})`, { Buffer });
const text = '測定結果 ✅';
const result = textResult(text, { status: 'ok' }, { artifact_bytes: 99, truncated_for_model: false });
assert.equal(result.content[0].text, text);
assert.equal(result.details.model_visible_result_bytes, Buffer.byteLength(text));
assert.equal(result.details.artifact_bytes, 99);
assert.equal(result.details.truncated_for_model, false);
console.log(JSON.stringify({ status: 'PASS', model_visible_result_bytes: result.details.model_visible_result_bytes, artifact_bytes: 99 }));
