#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  createStagePacket,
  resolveStagePacket,
  serializedBoundaryBytes,
  validateStagePacket,
} from '../runtime/pi/stage_packet.mjs';

const root = path.resolve(new URL('../', import.meta.url).pathname);
const fixture = path.join(root, 'fixtures', 'migration', 'story-ir');
const names = {
  evidence_ledger: 'evidence-ledger.json',
  fact_graph: 'fact-graph.json',
  claim_graph: 'claim-graph.json',
  story_graph: 'story-graph.json',
  editorial_grammar: 'editorial-grammar-selection.json',
  infographic_spec: 'infographic-spec.json',
};

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const artifacts = [];
const fullIr = {};
for (const [kind, name] of Object.entries(names)) {
  const bytes = await readFile(path.join(fixture, name));
  artifacts.push({ kind, ref: `fixtures/migration/story-ir/${name}`, hash: hash(bytes) });
  fullIr[name] = JSON.parse(bytes);
}

const packet = createStagePacket({
  artifacts,
  reason_codes: ['BOUNDARY_PROJECTION', 'CONTENT_ADDRESSED', 'IR_REUSE'],
  allowed_scope: ['evidence', 'design', 'story'],
});
assert.equal(validateStagePacket(packet).passed, true);
const resolved = await resolveStagePacket(packet, { root, scope: 'design' });
assert.equal(Object.keys(resolved.resolved).length, 6);
assert.equal(Object.values(resolved.resolved).every((value) => value.absolute.startsWith(root)), true);

const baselineBytes = serializedBoundaryBytes(fullIr);
const packetBytes = serializedBoundaryBytes(packet);
const reduction = (1 - packetBytes / baselineBytes) * 100;
assert.ok(reduction >= 80, `boundary reduction ${reduction.toFixed(2)}% is below 80%`);
assert.equal(Object.hasOwn(packet, 'facts'), false);
assert.equal(Object.hasOwn(packet, 'claims'), false);
assert.equal(Object.hasOwn(packet, 'evidence'), false);

const temp = await mkdtemp(path.join(os.tmpdir(), 'stage-packet-'));
try {
  const copiedRef = path.join(temp, 'artifact.json');
  await cp(path.join(fixture, names.fact_graph), copiedRef);
  const tampered = { ...packet, refs: { fact_graph: 'artifact.json' } };
  tampered.hashes = { fact_graph: packet.hashes.fact_graph };
  tampered.packet_hash = createHash('sha256').update(JSON.stringify({
    allowed_scope: tampered.allowed_scope,
    hashes: tampered.hashes,
    reason_codes: tampered.reason_codes,
    refs: tampered.refs,
    schema_version: tampered.schema_version,
  })).digest('hex');
  await writeFile(copiedRef, `${await readFile(copiedRef, 'utf8')}\n`);
  await assert.rejects(() => resolveStagePacket(tampered, { root: temp }), (error) => error.code === 'stage_packet.hash_mismatch');
  const missing = createStagePacket({ artifacts: [{ ...artifacts[0], ref: 'missing.json' }], reason_codes: ['TEST'], allowed_scope: ['evidence'] });
  await assert.rejects(() => resolveStagePacket(missing, { root: temp }), (error) => error.code === 'stage_packet.missing_ref');
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log(JSON.stringify({
  status: 'PASS',
  baseline_bytes: baselineBytes,
  packet_bytes: packetBytes,
  boundary_reduction_percent: Number(reduction.toFixed(2)),
  artifact_count: artifacts.length,
  tampered_resolution: 'FAIL_CLOSED',
  missing_resolution: 'FAIL_CLOSED',
}));
