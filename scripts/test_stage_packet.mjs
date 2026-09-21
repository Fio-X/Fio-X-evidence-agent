#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createRetryContextPacket,
  resolveRetryContextPacket,
  serializedBoundaryBytes,
  validateRetryContextPacket,
} from '../runtime/pi/stage_packet.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'retry-context-packet-'));
try {
  const evidence = Buffer.from(JSON.stringify({ full_evidence_body: 'x'.repeat(100_000) }));
  await writeFile(path.join(root, 'evidence.json'), evidence);
  const hash = createHash('sha256').update(evidence).digest('hex');
  const packet = createRetryContextPacket({
    goal: 'map, flow, and trend complex visual story',
    refs: { evidence: 'evidence.json' },
    hashes: { evidence: hash },
    passed_gates: [],
    remaining_gaps: ['publication desktop/mobile outputs are missing'],
    required_visual_modes: ['map/spatial', 'flow', 'trend/change'],
  });
  assert.equal(validateRetryContextPacket(packet).passed, true);
  const resolved = await resolveRetryContextPacket(packet, { root });
  assert.equal(resolved.resolved.evidence.hash, hash);
  assert.ok(serializedBoundaryBytes(packet) < evidence.length / 10);
  assert.equal(Object.hasOwn(packet, 'full_evidence_body'), false);

  const tampered = { ...packet, hashes: { evidence: '0'.repeat(64) } };
  await assert.rejects(
    () => resolveRetryContextPacket(tampered, { root }),
    (error) => error.code === 'retry_packet.packet_hash',
  );
  const missing = createRetryContextPacket({ ...packet, refs: { evidence: 'missing.json' }, hashes: { evidence: hash } });
  await assert.rejects(
    () => resolveRetryContextPacket(missing, { root }),
    (error) => error.code === 'retry_packet.missing_ref',
  );
  console.log(JSON.stringify({ packet_bytes: serializedBoundaryBytes(packet), full_artifact_bytes: evidence.length, reduction_percent: (1 - serializedBoundaryBytes(packet) / evidence.length) * 100, tampered: 'fail_closed', missing: 'fail_closed' }));
} finally {
  await rm(root, { recursive: true, force: true });
}
