#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessStoryGraph } from '../runtime/pi/story_graph.mjs';
import { composeInfographicBundle, lintInfographicSpec, validateInfographicSpec } from '../runtime/pi/infographic.mjs';
import { runEditorialValidators, VALIDATOR_SEVERITIES } from '../runtime/pi/editorial_validators.mjs';

const registry = JSON.parse(await readFile(new URL('../config/editorial-grammar-registry.json', import.meta.url), 'utf8'));
const readerQuestion = 'How did the geography and scale of estimated international migration flows change?';
const visualThesis = 'A route-led world view connects changing corridors to regional composition and long-run change.';
const claims = ['c-map', 'c-flow', 'c-trend', 'c-outcome'];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><path d="M5 30L95 30" stroke="#111"/><circle cx="75" cy="30" r="5"/></svg>';
const asset = (chart_type, claim_id) => ({ desktopSvg: svg, mobileSvg: svg, manifest: { chart_type, claim_id, source_note: 'Gaskin and Abel model estimates, 1990–2023', verification_mode: 'verified', artifact_status: 'VERIFIED', publishable: true }, critic: { passed: true } });
const assets = {
  'visualizations/map.json': asset('geo_flow_map', 'c-map'),
  'visualizations/sankey.json': asset('sankey', 'c-flow'),
  'visualizations/trend.json': asset('line', 'c-trend'),
};
const storyGraph = assessStoryGraph({
  story_id: 'migration', reader_question: readerQuestion, visual_thesis: visualThesis,
  nodes: [
    { id: 'n-map', kind: 'evidence', summary: 'Estimated corridors form a changing world geography.', explanatory_dimension: 'spatial', claim_ids: ['c-map'] },
    { id: 'n-composition', kind: 'evidence', summary: 'Regional composition concentrates and disperses over time.', explanatory_dimension: 'distribution', claim_ids: ['c-flow'] },
    { id: 'n-change', kind: 'outcome', summary: 'The route system changes in scale and destination structure.', explanatory_dimension: 'trend', claim_ids: ['c-trend', 'c-outcome'] },
  ],
  edges: [{ from: 'n-map', to: 'n-composition', relation: 'explains' }, { from: 'n-composition', to: 'n-change', relation: 'precedes' }],
  entry_node_ids: ['n-map'], answer_node_ids: ['n-change'],
});

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

assert.deepEqual(validateInfographicSpec(spec), []);
const report = runEditorialValidators(spec, assets, { editorial_grammar_registry: registry });
assert.equal(report.passed, true, JSON.stringify(report.issues));
assert.deepEqual(Object.keys(report.validators).sort(), ['annotation_target_validator', 'grammar_compatibility_validator', 'misleading_quantitative_validator', 'scene_cognitive_budget_validator', 'visual_channel_owner_validator'].sort());
assert.deepEqual(VALIDATOR_SEVERITIES, ['FATAL', 'ERROR', 'WARNING', 'INFO']);
const lint = lintInfographicSpec(spec, assets, { verified_claim_ids: claims, story_graph: storyGraph, editorial_grammar_registry: registry });
assert.equal(lint.passed, true, lint.blockers.join(' | '));
assert.equal(lint.validators.passed, true);
const bundle = composeInfographicBundle(spec, assets);
assert.equal(bundle.desktop.candidate_scores.length, 3);
assert.deepEqual(bundle.mobile.boxes.map((box) => box.id), spec.mobile_module_order);

function expectRule(mutator, rule) {
  const value = structuredClone(spec); mutator(value);
  const result = runEditorialValidators(value, assets, { editorial_grammar_registry: registry });
  assert.equal(result.passed, false, `expected ${rule} to fail`);
  assert.ok(result.issues.some((row) => row.rule_id === rule), JSON.stringify(result.issues));
}
expectRule((value) => { value.modules[0].annotations[0].target_object_id = 'missing'; }, 'annotation.target_bound');
expectRule((value) => { value.modules[0].visual_channels.push({ channel: 'size', field: 'uncertainty', role: 'uncertainty' }); }, 'visual_channel.single_owner');
expectRule((value) => { value.modules[1].quantitative_encoding.quantity_kind = 'stock_change'; }, 'quantitative.stock_change_is_not_flow');
expectRule((value) => { value.scene_graph.scenes[0].scene_budget.max_supporting_objects = 0; }, 'scene.supporting_budget');
expectRule((value) => { value.editorial_grammar.candidates[0].soft_score = 0.01; }, 'grammar.soft_score_mismatch');
expectRule((value) => { value.editorial_grammar.candidates[0].hard_constraints_passed = false; }, 'grammar.hard_constraint_result_mismatch');
expectRule((value) => {
  value.editorial_grammar.primary = 'CUTAWAY'; value.editorial_grammar.supporting = []; value.editorial_grammar.selected = 'CUTAWAY';
  value.editorial_grammar.candidates[0].grammar = 'CUTAWAY'; value.editorial_grammar.decision_log[0].grammar = 'CUTAWAY';
}, 'grammar.visual_mode_incompatible');
const incompatible = structuredClone(spec);
incompatible.editorial_grammar.primary = 'CUTAWAY'; incompatible.editorial_grammar.supporting = []; incompatible.editorial_grammar.selected = 'CUTAWAY';
incompatible.editorial_grammar.candidates[0].grammar = 'CUTAWAY'; incompatible.editorial_grammar.decision_log[0].grammar = 'CUTAWAY';
let compatibility = runEditorialValidators(incompatible, assets, { editorial_grammar_registry: registry });
let visualIssue = compatibility.issues.find((row) => row.rule_id === 'grammar.visual_mode_incompatible');
assert.deepEqual(visualIssue.recommendation, {
  primary: 'ROUTE_SPINE', supporting: ['THEN_NOW'], max_supporting: 2,
  reason: 'ROUTE_SPINE covers route geography and flows while THEN_NOW covers change over comparable timepoints',
});
const withComposition = structuredClone(incompatible);
withComposition.modules.push({ ...withComposition.modules[1], id: 'composition', visual_grammar: 'composition', annotations: [], graphic_object_ids: ['composition-objects'] });
compatibility = runEditorialValidators(withComposition, assets, { editorial_grammar_registry: registry });
visualIssue = compatibility.issues.find((row) => row.rule_id === 'grammar.visual_mode_incompatible' && row.path.endsWith('/visual_grammar'));
assert.deepEqual(visualIssue.recommendation.supporting, ['THEN_NOW', 'SPECIMEN_GRID']);
assert.deepEqual(visualIssue.recommendation.supporting_options, [['THEN_NOW', 'SPECIMEN_GRID'], ['THEN_NOW', 'SCALE_TRANSLATOR']]);
assert.ok(visualIssue.message.includes('primary ROUTE_SPINE') && visualIssue.message.includes('THEN_NOW'));
console.log('cognitive editorial validators v1.5: PASS');
