import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  critiqueRichIllustration,
  illustrationAdapterRequest,
  lintIllustrationSpec,
  normalizeIllustrationAdapterResponse,
  validateIllustrationSpec,
} from '../runtime/pi/illustration.mjs';

const spec = {
  schema_version: '0.2.0',
  title: 'How the system moves energy',
  subject: 'A simplified energy flow system',
  intent: 'Explain the mechanism while preserving factual evidence boundaries.',
  alt: 'Editorial illustration showing a source node feeding a directional energy flow into a destination node.',
  style_direction: 'Restrained magazine illustration with strong hierarchy and clear factual labels.',
  aspect_ratio: 'adaptive',
  origin_policy: 'ai_disclosed',
  source_note: 'Fixture evidence used only for contract testing.',
  credit: 'Newsroom visual desk',
  claim_ids: ['claim-1'],
  evidence_refs: ['sources/source.json'],
  factual_elements: [{ id: 'flow', label: 'Energy flow', claim_ids: ['claim-1'] }],
  constraints: ['No photorealistic reconstruction'],
};
assert.deepEqual(validateIllustrationSpec(spec), []);
const lint = lintIllustrationSpec(spec, { verified_claim_ids: ['claim-1'], evidence_refs: ['sources/source.json'] });
assert.equal(lint.passed, true);
const request = illustrationAdapterRequest(spec, { evidence_snapshot_hash: 'abc' });
const proc = spawnSync('python3', ['scripts/mock_illustration_adapter.py'], { input: JSON.stringify(request), encoding: 'utf8' });
assert.equal(proc.status, 0, proc.stderr);
const normalized = normalizeIllustrationAdapterResponse(spec, JSON.parse(proc.stdout));
assert.match(normalized.desktop, /data-rich-illustration-version="0\.2\.0"/);
assert.match(normalized.desktop, /<title>/);
assert.match(normalized.desktop, /<desc>/);
assert.equal(normalized.provenance.origin, 'generative_ai');
const manifest = { provenance: normalized.provenance };
const critic = critiqueRichIllustration(spec, manifest, { desktop: normalized.desktop, mobile: normalized.mobile });
assert.equal(critic.passed, true);

assert.throws(() => normalizeIllustrationAdapterResponse({ ...spec, origin_policy: 'human_only' }, JSON.parse(proc.stdout)), /human_only rejects/);
assert.throws(() => normalizeIllustrationAdapterResponse(spec, { ...JSON.parse(proc.stdout), variants: { desktop: '<svg viewBox="0 0 10 10"><script/></svg>', mobile: '<svg viewBox="0 0 10 10"></svg>' } }), /contains script/);
console.log('rich illustration contract tests: PASS');
