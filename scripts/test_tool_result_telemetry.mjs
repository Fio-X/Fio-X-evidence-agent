#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../runtime/pi/newsroom.ts', import.meta.url), 'utf8');
const match = source.match(/function textResult\([\s\S]*?\n\}/);
assert.ok(match, 'textResult helper must remain present');
const executableHelper = match[0]
  .replace('text: string', 'text')
  .replace('details: Record<string, unknown>', 'details')
  .replace('telemetry: { artifact_bytes?: number; truncated_for_model?: boolean }', 'telemetry')
  .replace('const resultDetails: Record<string, unknown>', 'const resultDetails')
  .replace(' as const', '');
const textResult = vm.runInNewContext(`(${executableHelper})`, { Buffer });

const small = 'small result';
const smallResult = textResult(small, { status: 'ok' });
assert.equal(smallResult.content[0].text, small);
assert.equal(smallResult.details.model_visible_result_bytes, Buffer.byteLength(small, 'utf8'));
assert.equal(smallResult.details.status, 'ok');
assert.ok(!Object.hasOwn(smallResult.details, 'artifact_bytes'));
assert.ok(!Object.hasOwn(smallResult.details, 'truncated_for_model'));

const unicode = '測定結果 ✅';
assert.equal(textResult(unicode).details.model_visible_result_bytes, Buffer.byteLength(unicode, 'utf8'));

const large = 'x'.repeat(256 * 1024);
const largeResult = textResult(large, {}, { artifact_bytes: 1024 * 1024, truncated_for_model: true });
assert.equal(largeResult.content[0].text, large, 'telemetry must not change returned tool text');
assert.equal(largeResult.details.model_visible_result_bytes, 256 * 1024);
assert.equal(largeResult.details.artifact_bytes, 1024 * 1024);
assert.equal(largeResult.details.truncated_for_model, true);
assert.ok(!Object.hasOwn(largeResult.details, 'text'));

console.log(JSON.stringify({
  status: 'PASS',
  cases: { small_bytes: smallResult.details.model_visible_result_bytes, large_bytes: largeResult.details.model_visible_result_bytes },
  artifact_bytes: largeResult.details.artifact_bytes,
  truncated_for_model: largeResult.details.truncated_for_model,
}));
