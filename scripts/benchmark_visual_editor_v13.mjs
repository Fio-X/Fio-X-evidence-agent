import { performance } from 'node:perf_hooks';
import { applyVisionPatches } from '../runtime/pi/vision.mjs';
import { evaluateCompetitionProfile } from '../runtime/pi/competition.mjs';

const iterations = 4000;
const moduleCount = 12;
const spec = {
  schema_version: '1.2.0',
  competition_profile: 'oja2026_visual',
  quality_target: 'award',
  intent: 'explain',
  primary_message: 'Verified fixture message',
  audience: 'general',
  story_arc: ['lead', 'explain', 'context'],
  modules: Array.from({ length: moduleCount }, (_, i) => ({
    id: `m${i + 1}`,
    type: i % 3 === 0 ? 'visual' : 'text',
    story_role: i === 0 ? 'lead' : 'evidence',
    priority: Math.min(5, 1 + (i % 5)),
    emphasis: i === 0 ? 'hero' : 'secondary',
    span: i === 0 ? 'full' : 'half',
    claim_refs: [`claim-${i + 1}`],
    source_refs: [`sources/${i + 1}.json`],
    body: `Evidence module ${i + 1}`,
  })),
  mobile_module_order: Array.from({ length: moduleCount }, (_, i) => `m${i + 1}`),
};

const vision = {
  passed: true,
  score: 92,
  confidence: 0.88,
  rubric: {
    hierarchy: 92,
    legibility: 94,
    composition: 91,
    visual_coherence: 90,
    typography: 91,
    source_legibility: 92,
    responsive_quality: 93,
    illustration_integration: 89,
    color_contrast: 94,
    editorial_distinctiveness: 88,
  },
  issues: [],
  patches: [
    { target_module_id: 'm2', field: 'span', value: 'full' },
    { target_module_id: 'm5', field: 'mobile_move_before', value: 'm3' },
    { target_module_id: 'm7', field: 'priority', value: '2' },
  ],
};

const deterministic = {
  passed: true,
  score: 97,
  rubric: {
    impact_story_focus: 96,
    engagement: 94,
    clarity_information_flow: 97,
    effectiveness: 96,
    hierarchy: 96,
    editorial_rhythm: 94,
    inclusion_accessibility: 95,
    responsive_execution: 96,
    craft_geometry: 93,
    originality_variety: 90,
  },
};

const assets = {
  'visualizations/illustrations/mock.json': {
    manifest: { kind: 'rich_illustration', provenance: { origin: 'generative_ai' } },
  },
};

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function measure(fn) {
  const values = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    values.push(performance.now() - start);
  }
  return {
    p50_ms: percentile(values, 0.50),
    p95_ms: percentile(values, 0.95),
    max_ms: Math.max(...values),
  };
}

for (let i = 0; i < 100; i += 1) {
  applyVisionPatches(spec, vision);
  evaluateCompetitionProfile({ profile_id: 'oja2026_visual', spec, assets, deterministic_critic: deterministic, vision_critic: vision });
}

const revision = measure(() => applyVisionPatches(spec, vision));
const preflight = measure(() => evaluateCompetitionProfile({
  profile_id: 'oja2026_visual', spec, assets, deterministic_critic: deterministic, vision_critic: vision,
}));
const budgets = { revision_p95_ms: 2.0, preflight_p95_ms: 0.5 };
const passed = revision.p95_ms <= budgets.revision_p95_ms && preflight.p95_ms <= budgets.preflight_p95_ms;

console.log(JSON.stringify({ iterations, module_count: moduleCount, patches_per_revision: vision.patches.length, revision, preflight, budgets, passed }, null, 2));
if (!passed) process.exit(1);
