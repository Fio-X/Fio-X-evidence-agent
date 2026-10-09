#!/usr/bin/env node
// A model-supplied search query must never reach mdfind as an option.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSpotlight } from '../runtime/pi/local_backend.mjs';

const root = await mkdtemp(join(tmpdir(), 'newsroom-spotlight-args-'));
process.env.NEWSROOM_ARTIFACT_DIR = root;
await writeFile(join(root, 'alpha-report.txt'), 'x');
for (const query of ['-live', '-count', '-attr kMDItemPath', '-0']) {
  const r = await localSpotlight(query);
  assert.equal(r.backend, 'portable:filename-walk', `${query} must not go to mdfind`);
  assert.deepEqual(r.results, []);
}
const ok = await localSpotlight('alpha');
assert.ok(ok.results.some((p) => p.endsWith('alpha-report.txt')));
const src = await readFile(new URL('../runtime/pi/local_backend.mjs', import.meta.url), 'utf8');
assert.match(src, /startsWith\('-'\)/);
console.log(JSON.stringify({ status: 'PASS' }));
