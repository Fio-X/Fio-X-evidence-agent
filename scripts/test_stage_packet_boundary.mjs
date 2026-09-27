#!/usr/bin/env node
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  createStagePacket,
  resolveStagePacket,
  serializedBoundaryBytes,
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
const loaded = {};
const artifacts = {};
for (const [kind, name] of Object.entries(names)) {
  const bytes = await readFile(path.join(fixture, name));
  loaded[kind] = JSON.parse(bytes);
  artifacts[kind] = { kind, ref: `fixtures/migration/story-ir/${name}`, hash: hash(bytes) };
}

const handoffs = [
  {
    id: 'research-to-design',
    scope: 'design',
    kinds: ['evidence_ledger', 'fact_graph', 'claim_graph'],
    reason: 'RESEARCH_DESIGN_BOUNDARY',
  },
  {
    id: 'design-to-publish',
    scope: 'publish',
    kinds: ['story_graph', 'editorial_grammar', 'infographic_spec'],
    reason: 'DESIGN_PUBLISH_BOUNDARY',
  },
];

const results = [];
for (const handoff of handoffs) {
  const inline = Object.fromEntries(handoff.kinds.map((kind) => [names[kind], loaded[kind]]));
  const packet = createStagePacket({
    artifacts: handoff.kinds.map((kind) => artifacts[kind]),
    reason_codes: [handoff.reason, 'CONTENT_ADDRESSED', 'IR_REUSE'],
    allowed_scope: [handoff.scope],
  });
  const packetBytes = serializedBoundaryBytes(packet);
  const inlineBytes = serializedBoundaryBytes(inline);
  const iterations = 100;
  const durations = [];
  let rehydratedCount = 0;
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const resolved = await resolveStagePacket(packet, { root, scope: handoff.scope });
    durations.push(performance.now() - started);
    rehydratedCount += Object.keys(resolved.resolved).length;
  }
  durations.sort((a, b) => a - b);
  const percentile = (p) => durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)];
  const reduction = (1 - packetBytes / inlineBytes) * 100;
  assert.equal(rehydratedCount, iterations * handoff.kinds.length);
  assert.ok(reduction > 0, `${handoff.id} packet must be smaller than inline boundary`);
  results.push({
    id: handoff.id,
    inline_bytes: inlineBytes,
    packet_bytes: packetBytes,
    reduction_percent: Number(reduction.toFixed(2)),
    resolve_iterations: iterations,
    resolve_median_ms: Number(percentile(0.5).toFixed(3)),
    resolve_p95_ms: Number(percentile(0.95).toFixed(3)),
    rehydrated_artifacts: handoff.kinds.length,
  });
}

const researchPacket = createStagePacket({
  artifacts: [artifacts.evidence_ledger],
  reason_codes: ['TEST'],
  allowed_scope: ['design'],
});
await assert.rejects(
  () => resolveStagePacket(researchPacket, { root, scope: 'publish' }),
  (error) => error.code === 'stage_packet.scope_violation',
);
assert.throws(
  () => createStagePacket({
    artifacts: [{ ...artifacts.fact_graph, ref: '../outside.json' }],
    reason_codes: ['TEST'],
    allowed_scope: ['design'],
  }),
  (error) => error.code === 'stage_packet.unsafe_ref',
);

console.log(JSON.stringify({
  status: 'PASS',
  handoffs: results,
  fail_closed: {
    scope_violation: 'PASS',
    unsafe_ref: 'PASS',
    tampered_and_missing_refs: 'COVERED_BY_test_stage_packet',
  },
  packet_body_duplication: 'NONE',
}));
