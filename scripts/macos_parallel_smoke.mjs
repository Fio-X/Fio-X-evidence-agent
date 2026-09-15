#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { runTaskDag } from '../runtime/pi/parallel_scheduler.mjs';
import { localBackendStatus, localHash, localMetadata, localPlistJson, localSqliteQuery } from '../runtime/pi/local_backend.mjs';

assert.equal(process.platform, 'darwin', 'this smoke test is intended for macOS');
const root = await mkdtemp(path.join(os.tmpdir(), 'newsroom-macos-smoke-'));
process.env.NEWSROOM_ARTIFACT_DIR = root;
try {
  const status = await localBackendStatus();
  for (const tool of ['mdls','mdfind','textutil','sips','qlmanage','sqlite3','curl','file','shasum','plutil']) {
    assert.equal(status.tools[tool], true, `missing native tool: ${tool}`);
  }

  await writeFile(path.join(root, 'note.txt'), 'newsroom local backend');
  const metadata = await localMetadata('note.txt');
  assert.match(metadata.backend, /^macos:/);
  const hash = await localHash('note.txt');
  assert.equal(hash.backend, 'macos:shasum');
  assert.match(hash.digest, /^[0-9a-f]{64}$/);

  const plist = path.join(root, 'sample.plist');
  await writeFile(plist, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>name</key><string>newsroom</string></dict></plist>');
  const plistResult = await localPlistJson('sample.plist');
  assert.equal(JSON.parse(plistResult.text).name, 'newsroom');

  const db = path.join(root, 'sample.sqlite');
  const sqlite = spawnSync('/usr/bin/sqlite3', [db, 'create table items(id integer, label text); insert into items values (1, "alpha"), (2, "beta");'], { encoding: 'utf8' });
  assert.equal(sqlite.status, 0, sqlite.stderr);
  const rows = await localSqliteQuery('sample.sqlite', 'select id, label from items order by id');
  assert.deepEqual(rows.rows, [{ id: 1, label: 'alpha' }, { id: 2, label: 'beta' }]);
  await assert.rejects(() => localSqliteQuery('sample.sqlite', 'delete from items'), /read-only/i);

  let sameHost = 0;
  let maxSameHost = 0;
  const tasks = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, kind: 'fetch_url', url: `https://example.com/${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i}`, kind: 'fetch_url', url: `https://example.org/${i}` })),
  ];
  const dag = await runTaskDag(tasks, async (task) => {
    assert.equal(task.resource_class, 'network');
    if (task.resource_key === 'network:example.com') {
      sameHost += 1;
      maxSameHost = Math.max(maxSameHost, sameHost);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (task.resource_key === 'network:example.com') sameHost -= 1;
    return { backend: 'smoke' };
  }, { maxConcurrency: 6, resourceLimits: { network: 4 } });
  assert.equal(dag.status, 'ok');
  assert.ok(maxSameHost <= 2, `per-host limit exceeded: ${maxSameHost}`);
  assert.ok(dag.max_observed_parallelism >= 3, 'expected fan-out across hosts');

  const files = [];
  for (let i = 0; i < 12; i += 1) {
    const name = `bench-${i}.bin`;
    await writeFile(path.join(root, name), Buffer.alloc(256 * 1024, i));
    files.push(name);
  }
  const serialStart = performance.now();
  for (const file of files) await localHash(file);
  const serialMs = performance.now() - serialStart;
  const parallelStart = performance.now();
  const parallel = await runTaskDag(files.map((file, i) => ({ id: `h${i}`, kind: 'local_hash', path: file })), (task) => localHash(task.path), { maxConcurrency: 6, resourceLimits: { local: 6 } });
  const parallelMs = performance.now() - parallelStart;

  console.log(JSON.stringify({
    status: 'PASS',
    platform: process.platform,
    arch: process.arch,
    native_tools: status.tools,
    scheduler: { max_observed_parallelism: dag.max_observed_parallelism, per_host_max: maxSameHost },
    benchmark: { serial_ms: Number(serialMs.toFixed(3)), parallel_ms: Number(parallelMs.toFixed(3)), speedup: Number((serialMs / Math.max(parallelMs, 0.001)).toFixed(3)), max_observed_parallelism: parallel.max_observed_parallelism },
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
