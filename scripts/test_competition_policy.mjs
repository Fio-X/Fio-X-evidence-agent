import assert from 'node:assert/strict';
import { COMPETITION_PROFILE_IDS, evaluateCompetitionProfile } from '../runtime/pi/competition.mjs';

assert.deepEqual(COMPETITION_PROFILE_IDS, ['editorial', 'snd47_infographics', 'oja2026_visual', 'sigma2026', 'iib_awards']);

const deterministic = {
  passed: true,
  score: 97,
  rubric: {
    impact_story_focus: 95,
    engagement: 94,
    clarity_information_flow: 96,
    effectiveness: 95,
    hierarchy: 94,
    editorial_rhythm: 93,
    inclusion_accessibility: 95,
    responsive_execution: 96,
    craft_geometry: 94,
    originality_variety: 90,
  },
};
const vision = {
  passed: true,
  score: 92,
  rubric: {
    hierarchy: 92,
    legibility: 94,
    composition: 92,
    visual_coherence: 91,
    typography: 90,
    source_legibility: 93,
    responsive_quality: 94,
    illustration_integration: 90,
    color_contrast: 91,
    editorial_distinctiveness: 88,
  },
};
const spec = { quality_target: 'award', competition_profile: 'snd47_infographics' };
const aiAssets = {
  'visualizations/illustrations/a.json': { manifest: { kind: 'rich_illustration', provenance: { origin: 'generative_ai' } } },
};
const humanAssets = {
  'visualizations/illustrations/a.json': { manifest: { kind: 'rich_illustration', provenance: { origin: 'human' } } },
};
const sndAi = evaluateCompetitionProfile({ profile_id: 'snd47_infographics', spec, assets: aiAssets, deterministic_critic: deterministic, vision_critic: vision });
assert.equal(sndAi.machine_passed, false);
assert.ok(sndAi.blockers.some((b) => b.code === 'illustration_origin_ineligible'));
const sndHuman = evaluateCompetitionProfile({ profile_id: 'snd47_infographics', spec, assets: humanAssets, deterministic_critic: deterministic, vision_critic: vision });
assert.equal(sndHuman.machine_passed, true);
assert.equal(sndHuman.submission_ready, false);
assert.ok(sndHuman.manual_requirements.length >= 1);

const oja = evaluateCompetitionProfile({ profile_id: 'oja2026_visual', spec: { ...spec, competition_profile: 'oja2026_visual' }, assets: aiAssets, deterministic_critic: deterministic, vision_critic: vision });
assert.equal(oja.machine_passed, true);
assert.equal(oja.submission_ready, false);

const lowMobile = structuredClone(vision);
lowMobile.rubric.responsive_quality = 70;
const ojaLow = evaluateCompetitionProfile({ profile_id: 'oja2026_visual', spec: { ...spec, competition_profile: 'oja2026_visual' }, assets: humanAssets, deterministic_critic: deterministic, vision_critic: lowMobile });
assert.equal(ojaLow.machine_passed, false);
assert.ok(ojaLow.blockers.some((b) => b.dimension === 'responsive_quality'));

console.log('competition policy tests: PASS');
console.log('SND47 AI-origin eligibility + OJA mobile-quality floors: PASS');
