#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  localHash,
  localImageInfo,
  localMetadata,
  localSpotlight,
  localSqliteQuery,
  localText,
} from '../runtime/pi/local_backend.mjs';

const samples = Number(process.env.NEWSROOM_BENCH_SAMPLES || 12);
const warmups = 2;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

async function benchmark(name, fn, backendOf = (value) => value?.backend ?? null) {
  for (let i = 0; i < warmups; i += 1) await fn();
  const durations = [];
  let last;
  for (let i = 0; i < samples; i += 1) {
    const result = await timed(fn);
    durations.push(result.ms);
    last = result.value;
  }
  return {
    name,
    backend: backendOf(last),
    samples,
    p50_ms: Number(percentile(durations, 50).toFixed(3)),
    p95_ms: Number(percentile(durations, 95).toFixed(3)),
    min_ms: Number(Math.min(...durations).toFixed(3)),
    max_ms: Number(Math.max(...durations).toFixed(3)),
  };
}

async function portableHash(file) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve({ backend: 'portable:node-crypto', digest: hash.digest('hex') }));
  });
}

async function runCurl(url) {
  return await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/curl', ['--fail', '--silent', '--show-error', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(err).toString('utf8')));
      resolve({ backend: 'macos:curl', bytes: Buffer.concat(out).length });
    });
  });
}

async function runNodeFetch(url) {
  const response = await fetch(url);
  const bytes = (await response.arrayBuffer()).byteLength;
  return { backend: 'portable:node-fetch', bytes };
}

assert.equal(process.platform, 'darwin', 'benchmark is intended for macOS');
const root = await mkdtemp(path.join(os.tmpdir(), 'newsroom-local-bench-'));
process.env.NEWSROOM_ARTIFACT_DIR = root;
let server;
try {
  await writeFile(path.join(root, 'note.txt'), 'benchmark '.repeat(4096));
  await writeFile(path.join(root, 'rich.rtf'), '{\\rtf1\\ansi Newsroom benchmark rich text}');
  await writeFile(path.join(root, 'search-target-newsroom.txt'), 'search fixture');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2jS8AAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, 'pixel.png'), png);
  const db = path.join(root, 'sample.sqlite');
  const sqlite = spawnSync('/usr/bin/sqlite3', [db, 'create table items(id integer, label text); insert into items values (1, "alpha"), (2, "beta"), (3, "gamma");'], { encoding: 'utf8' });
  assert.equal(sqlite.status, 0, sqlite.stderr);

  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('newsroom-http-benchmark');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/fixture`;

  const rows = [];
  rows.push(await benchmark('metadata_local_first', () => localMetadata('note.txt')));
  rows.push(await benchmark('metadata_portable_stat', async () => ({ backend: 'portable:fs-stat', ...(await stat(path.join(root, 'note.txt'))) })));
  rows.push(await benchmark('text_conversion_local_first', () => localText('rich.rtf')));
  rows.push(await benchmark('text_plain_portable', () => localText('note.txt')));
  rows.push(await benchmark('image_probe_local_first', () => localImageInfo('pixel.png')));
  rows.push(await benchmark('sqlite_local_first', () => localSqliteQuery('sample.sqlite', 'select id, label from items order by id')));
  rows.push(await benchmark('hash_local_first', () => localHash('note.txt')));
  rows.push(await benchmark('hash_portable_crypto', () => portableHash(path.join(root, 'note.txt'))));
  rows.push(await benchmark('local_search', () => localSpotlight('search-target-newsroom')));
  rows.push(await benchmark('http_curl', () => runCurl(url)));
  rows.push(await benchmark('http_node_fetch', () => runNodeFetch(url)));

  const selected = Object.fromEntries(rows.map((row) => [row.name, row.backend]));
  assert.match(selected.metadata_local_first, /^macos:/);
  assert.equal(selected.text_conversion_local_first, 'macos:textutil');
  assert.equal(selected.text_plain_portable, 'portable:fs');
  assert.equal(selected.image_probe_local_first, 'macos:sips');
  assert.equal(selected.sqlite_local_first, 'macos:sqlite3');
  assert.equal(selected.hash_local_first, 'macos:shasum');
  assert.equal(selected.hash_portable_crypto, 'portable:node-crypto');
  assert.ok(['macos:mdfind', 'portable:filename-walk'].includes(selected.local_search));
  assert.equal(selected.http_curl, 'macos:curl');
  assert.equal(selected.http_node_fetch, 'portable:node-fetch');

  console.log(JSON.stringify({
    schema_version: '1.0.0',
    platform: process.platform,
    arch: process.arch,
    samples,
    threshold_policy: 'none; report measured p50/p95 and backend selection without inventing a mandatory speedup target',
    rows,
  }, null, 2));
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
