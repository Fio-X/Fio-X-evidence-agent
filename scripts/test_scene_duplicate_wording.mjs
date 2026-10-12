#!/usr/bin/env node
// NEWSROOM_SCENE_DUPLICATE_WORDING=1 (default off) changes only the TEXT of the refusal when one module is written
// twice in the same scene (anchor and sidecar). The refusal itself is identical with the switch on or off.
import assert from 'node:assert/strict';
import { validateInfographicSpec } from '../runtime/pi/infographic.mjs';

const readerQuestion = 'How did the geography and scale of estimated international migration flows change?';
const visualThesis = 'A route-led world view connects changing corridors to regional composition and long-run change.';
const editorialGrammar = {
  schema_version: '0.1.0', project_id: 'migration', primary: 'ROUTE_SPINE', supporting: ['THEN_NOW', 'SCALE_TRANSLATOR'],
  available_renderer_capabilities: ['svg', 'canvas2d'],
  evidence_features: ['origin_destination_relation', 'verified_locations', 'comparable_timepoints', 'quantity', 'human_scale_reference'],
  cognitive_goals: ['ORIENT', 'ZOOM', 'MEASURE', 'COMPARE', 'CONSEQUENCE'],
  candidates: [
    { grammar: 'ROUTE_SPINE', hard_constraints_passed: true, renderer_capability_passed: true, soft_score: 1, reason_codes: ['route_evidence_complete'] },
    { grammar: 'THEN_NOW', hard_constraints_passed: true, renderer_capability_passed: true, soft_score: 0.94, reason_codes: ['timepoints_comparable'] },
    { grammar: 'SCALE_TRANSLATOR', hard_constraints_passed: true, renderer_capability_passed: true, soft_score: 0.88, reason_codes: ['scale_reference_available'] },
  ],
  selected: 'ROUTE_SPINE', decision_log: [{ stage: 'final_selection', grammar: 'ROUTE_SPINE', outcome: 'select', reason_code: 'highest_eligible_score' }],
};
const quantitative = { quantity_kind: 'estimated_flow', mark_semantics: 'flow_width', scale_type: 'linear', baseline_policy: 'not_applicable', uncertainty_disclosed: true, disclosure: 'Mean estimates are shown; standard deviation is available in the source data.' };
const spec = {
  schema_version: '1.5.0', title: 'The routes moved', dek: 'A route-led account of changing estimated migration flows.', alt: 'A world route map, regional Sankey and trend view explain changes in model-estimated international migration flows.',
  layout: 'feature', complexity_budget: 'medium', intent: 'Explain changing migration geography without confusing estimated flows and stocks.', primary_message: 'The geography and scale of estimated routes changed together.',
  reader_question: readerQuestion, visual_thesis: visualThesis, story_graph_ref: 'editorial/story-graphs/migration.json', story_arc: 'question_answer', audience: 'general', quality_target: 'publishable', competition_profile: 'editorial',
  editorial_discovery_ref: 'editorial/discovery/migration.json', visual_concept_ref: 'editorial/concepts/migration.json', selected_concept_id: 'route-spine', novelty_ref: 'editorial/novelty/migration.json', asset_plan_ref: 'editorial/assets/migration.json', editorial_grammar: editorialGrammar,
  mobile_module_order: ['map', 'flow', 'trend', 'resolution'],
  scene_graph: { schema_version: '0.2.0', scenes: [
    { id: 'orient', pattern: 'hero_with_rail', anchor_module_id: 'map', sidecar_module_ids: ['flow'], primary_cognitive_goal: 'ORIENT', hero_object_id: 'route-a', supporting_claim_ids: ['c-map', 'c-flow'], scene_budget: { max_supporting_objects: 1, max_annotations: 2, max_claims: 2 } },
    { id: 'compare', pattern: 'hero_sidecar_stack', anchor_module_id: 'trend', sidecar_module_ids: ['resolution'], primary_cognitive_goal: 'COMPARE', hero_object_id: 'trend', supporting_claim_ids: ['c-trend', 'c-outcome'], scene_budget: { max_supporting_objects: 1, max_annotations: 1, max_claims: 2 } },
  ]},
  modules: [
    { id: 'map', type: 'visual', span: 'full', manifest_ref: 'visualizations/map.json', visual_grammar: 'spatial', story_node_ids: ['n-map'], story_role: 'hook', priority: 1, emphasis: 'hero', claim_set: ['c-map'], graphic_object_ids: ['route-a'], annotations: [{ id: 'map-note', target_object_id: 'route-a', text: 'A model-estimated route, not an observed journey.', claim_id: 'c-map' }], visual_channels: [{ channel: 'size', field: 'estimated_flow_mean', role: 'quantitative' }, { channel: 'connection', field: 'origin_destination', role: 'identity' }], quantitative_encoding: quantitative },
    { id: 'flow', type: 'visual', span: 'half', manifest_ref: 'visualizations/sankey.json', visual_grammar: 'flow', story_node_ids: ['n-composition'], story_role: 'evidence', priority: 2, emphasis: 'primary', claim_set: ['c-flow'], graphic_object_ids: ['regional-links'], visual_channels: [{ channel: 'length', field: 'estimated_flow_mean', role: 'quantitative' }, { channel: 'connection', field: 'region_pair', role: 'identity' }], quantitative_encoding: quantitative },
    { id: 'trend', type: 'visual', span: 'two_thirds', manifest_ref: 'visualizations/trend.json', visual_grammar: 'trend', story_node_ids: ['n-change'], story_role: 'evidence', priority: 2, emphasis: 'primary', claim_set: ['c-trend'], graphic_object_ids: ['trend-line'], visual_channels: [{ channel: 'position', field: 'estimated_flow_mean', role: 'quantitative' }, { channel: 'color', field: 'year', role: 'categorical' }], quantitative_encoding: { ...quantitative, mark_semantics: 'position' } },
    { id: 'resolution', type: 'text', span: 'third', body: 'The result is a changed route system, not a direct reading of migrant-stock differences.', claim_ids: ['c-outcome'], claim_set: ['c-outcome'], story_node_ids: ['n-change'], story_role: 'resolution', priority: 2, emphasis: 'support' },
  ],
};

const OLD = (id) => `module '${id}' cannot belong to more than one scene`;
const NEW = (id, scene) => `module '${id}' is written twice in scene '${scene}' (as anchor and as sidecar); list it once`;
const withEnv = (value, fn) => {
  const prior = process.env.NEWSROOM_SCENE_DUPLICATE_WORDING;
  if (value === undefined) delete process.env.NEWSROOM_SCENE_DUPLICATE_WORDING; else process.env.NEWSROOM_SCENE_DUPLICATE_WORDING = value;
  try { return fn(); } finally { if (prior === undefined) delete process.env.NEWSROOM_SCENE_DUPLICATE_WORDING; else process.env.NEWSROOM_SCENE_DUPLICATE_WORDING = prior; }
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const sameScene = clone(spec); sameScene.scene_graph.scenes[0].sidecar_module_ids = ['map'];            // anchor also a sidecar
const crossScene = clone(spec); crossScene.scene_graph.scenes[1].sidecar_module_ids = ['flow'];         // flow in two scenes

for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '01']) {
  assert.deepEqual(withEnv(value, () => validateInfographicSpec(spec)), [], `valid plan stays valid (${value})`);
  const errors = withEnv(value, () => validateInfographicSpec(sameScene));
  assert.ok(errors.includes(OLD('map')), `off (${JSON.stringify(value)}): old message byte-identical, got ${JSON.stringify(errors)}`);
  assert.ok(!errors.some((e) => e.includes('written twice')), `off (${JSON.stringify(value)}): no new text`);
}
const base = withEnv(undefined, () => validateInfographicSpec(sameScene));
const on = withEnv('1', () => validateInfographicSpec(sameScene));
assert.equal(on.length, base.length, 'same number of refusals with the switch on');
assert.deepEqual(on.filter((e) => e !== NEW('map', 'orient')), base.filter((e) => e !== OLD('map')), 'the only difference is the one message');
assert.ok(on.includes(NEW('map', 'orient')) && !on.includes(OLD('map')), `on: new message replaces old, got ${JSON.stringify(on)}`);
// A module that really sits in two scenes keeps the old text, switch on or off.
for (const value of [undefined, '1']) {
  const errors = withEnv(value, () => validateInfographicSpec(crossScene));
  assert.ok(errors.includes(OLD('flow')), `cross-scene keeps old message (${value}): ${JSON.stringify(errors)}`);
  assert.ok(!errors.some((e) => e.includes('written twice')), `cross-scene never gets the same-scene text (${value})`);
}
assert.deepEqual(withEnv('1', () => validateInfographicSpec(spec)), [], 'valid plan still valid with the switch on');
console.log('test_scene_duplicate_wording: ok');
