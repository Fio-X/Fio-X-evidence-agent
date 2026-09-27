import assert from 'node:assert/strict';
import { applyVisionPatches, normalizeVisionCriticReport, validateVisionCriticReport, VISION_RUBRIC_KEYS } from '../runtime/pi/vision.mjs';

const rubric = Object.fromEntries(VISION_RUBRIC_KEYS.map((key) => [key, 88]));
const report = {
  passed: true,
  score: 88,
  confidence: 0.81,
  rubric,
  issues: [{ severity: 'warning', code: 'tight_caption', viewport: 'mobile', module_id: 'visual-1', evidence: 'Caption wraps to three visible lines.', recommendation: 'Promote the visual and move it earlier on mobile.' }],
  patches: [
    { target_module_id: 'visual-1', field: 'span', value: 'full' },
    { target_module_id: 'visual-1', field: 'mobile_move_before', value: 'text-1' },
  ],
};
assert.deepEqual(validateVisionCriticReport(report, ['text-1', 'visual-1', 'stat-1']), []);
assert.equal(normalizeVisionCriticReport(report, ['text-1', 'visual-1', 'stat-1']).passed, true);
const blocker = { ...report, issues: [{ ...report.issues[0], severity: 'blocker' }] };
assert.equal(normalizeVisionCriticReport(blocker, ['text-1', 'visual-1', 'stat-1']).passed, false);
assert.ok(validateVisionCriticReport({ ...report, patches: [{ target_module_id: 'visual-1', field: 'claim', value: 'change it' }] }, ['visual-1']).length > 0);
assert.ok(validateVisionCriticReport({ ...report, patches: [{ target_module_id: 'missing', field: 'span', value: 'full' }] }, ['visual-1']).length > 0);
assert.ok(validateVisionCriticReport({ ...report, patches: [{ target_module_id: 'visual-1', field: 'mobile_move_before', value: 'visual-1' }] }, ['visual-1']).length > 0);

const sourceSpec = {
  schema_version: '1.2.0',
  title: 'Safe visual revision',
  dek: 'A fixture for bounded image-aware revision.',
  alt: 'A responsive editorial page with verified modules in a bounded revision fixture.',
  intent: 'Test evidence-preserving visual revision.',
  primary_message: 'The visual editor may change layout without changing evidence.',
  story_arc: 'explain',
  audience: 'informed',
  quality_target: 'award',
  competition_profile: 'editorial',
  modules: [
    { id: 'text-1', type: 'text', body: 'Evidence-backed explanatory copy.', claim_ids: ['claim-1'], span: 'full', story_role: 'resolution', priority: 3, emphasis: 'secondary' },
    { id: 'visual-1', type: 'visual', manifest_ref: 'visualizations/a.json', span: 'half', story_role: 'evidence', priority: 2, emphasis: 'primary' },
    { id: 'stat-1', type: 'hero_stat', value: '42', label: 'Verified total', claim_id: 'claim-1', span: 'third', story_role: 'hook', priority: 1, emphasis: 'primary' },
  ],
};
const revision = applyVisionPatches(sourceSpec, report);
assert.equal(revision.spec.modules.find((m) => m.id === 'visual-1').span, 'full');
assert.deepEqual(revision.spec.modules.map((m) => m.id), ['text-1', 'visual-1', 'stat-1']);
assert.deepEqual(revision.spec.mobile_module_order, ['visual-1', 'text-1', 'stat-1']);
assert.equal(revision.spec.modules.find((m) => m.id === 'text-1').body, sourceSpec.modules[0].body);
assert.equal(revision.safety.evidence_fields_preserved, true);

const legacyRevision = applyVisionPatches({ ...sourceSpec, schema_version: '1.1.0', competition_profile: undefined }, report);
assert.equal(legacyRevision.spec.schema_version, '1.2.0');
assert.equal(legacyRevision.spec.competition_profile, 'editorial');
assert.equal(legacyRevision.safety.source_schema_version, '1.1.0');

console.log('vision critic contract tests: PASS');
console.log('bounded layout revision + mobile-only order: PASS');
