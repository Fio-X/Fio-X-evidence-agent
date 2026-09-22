#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deriveVerification, validateFactGraph, validateFactSignature } from '../runtime/pi/fact_graph.mjs';
import { lintEditorialGrammarSelection, materializeEditorialGrammarSelection, rankEditorialGrammarCandidates, selectEditorialGrammar } from '../runtime/pi/editorial_grammar.mjs';

const registry = JSON.parse(await readFile(new URL('../config/editorial-grammar-registry.json', import.meta.url), 'utf8'));
const hash = 'a'.repeat(64);
const graph = {
  schema_version: '0.1.0', fact_graph_id: 'migration',
  entities: [{ id: 'a', kind: 'country', label: 'A', evidence_ids: ['ev'] }],
  relations: [],
  quantities: [
    { id: 'stock', phenomenon: 'migrant_stock', value: 10, unit: 'persons', origin: 'source_extraction', evidence_ids: ['ev'] },
    { id: 'share', phenomenon: 'stock_share', value: 0.1, unit: 'ratio', origin: 'calculation', calculation_id: 'calc', evidence_ids: ['ev'] },
  ],
  processes: [], locations: [], time: [], scale: [], uncertainty: [],
  evidence: [{ id: 'ev', source_ref: 'source.csv', source_sha256: hash, extraction_method: 'structured_import', extraction_status: 'passed' }],
  calculations: [{ id: 'calc', operation: 'divide', input_fact_ids: ['stock'], code_ref: 'share.sql', result_sha256: hash, replay_status: 'passed' }],
};
assert.equal(validateFactGraph(graph).passed, true);
const invented = structuredClone(graph);
invented.quantities[0].origin = 'llm_inference';
assert.equal(validateFactGraph(invented).passed, false);
assert.ok(validateFactGraph(invented).issues.some((row) => row.rule_id === 'quantity.origin_forbidden'));

assert.equal(deriveVerification({ source_resolved: true, extraction_passed: true, computation_replayed: true, claim_supported: true }).publishable, true);
assert.equal(deriveVerification({ source_resolved: true, extraction_passed: true, computation_replayed: false, claim_supported: true }).publishable, false);
const forged = validateFactSignature({ verification: { authority: 'system', source_resolved: true, extraction_passed: true, computation_replayed: false, claim_supported: true, publishable: true } });
assert.equal(forged.passed, false);
assert.ok(forged.issues.some((row) => row.rule_id === 'verification.publishable_derived'));

const context = {
  evidence_features: ['origin_destination_relation', 'verified_locations', 'comparable_timepoints', 'quantity', 'human_scale_reference', 'comparable_entities'],
  cognitive_goals: ['ORIENT', 'ZOOM', 'MEASURE', 'COMPARE', 'CONSEQUENCE'],
  available_renderer_capabilities: ['svg', 'canvas2d'],
};
const ranked = rankEditorialGrammarCandidates(context, registry);
assert.equal(ranked[0].grammar, 'ROUTE_SPINE');
const picked = selectEditorialGrammar(context, registry);
assert.equal(picked.candidates.length, 3);
assert.equal(picked.selected, 'ROUTE_SPINE');
const selection = {
  schema_version: '0.1.0', project_id: 'migration', primary: 'ROUTE_SPINE', supporting: ['THEN_NOW', 'SCALE_TRANSLATOR'],
  available_renderer_capabilities: context.available_renderer_capabilities, evidence_features: context.evidence_features,
  cognitive_goals: context.cognitive_goals,
  candidates: picked.candidates, selected: picked.selected,
  decision_log: [{ stage: 'final_selection', grammar: 'ROUTE_SPINE', outcome: 'select', reason_code: 'highest_eligible_score' }],
};
assert.equal(lintEditorialGrammarSelection(selection, registry).passed, true);
const materialized = materializeEditorialGrammarSelection({
  project_id: 'migration', primary: 'ROUTE_SPINE', supporting: ['THEN_NOW', 'SCALE_TRANSLATOR'], ...context,
}, registry);
assert.equal(materialized.selected, 'ROUTE_SPINE');
assert.equal(materialized.candidates.length, 3);
assert.equal(materialized.decision_log.at(-1).stage, 'final_selection');
assert.equal(lintEditorialGrammarSelection(materialized, registry).passed, true);
const sparseMaterialized = materializeEditorialGrammarSelection({
  project_id: 'sparse-change', primary: 'THEN_NOW', supporting: [],
  evidence_features: ['comparable_timepoints'], cognitive_goals: ['COMPARE'], available_renderer_capabilities: ['svg'],
}, registry);
assert.equal(sparseMaterialized.candidates.length, 3);
assert.equal(sparseMaterialized.candidates[0].hard_constraints_passed, true);
assert.ok(sparseMaterialized.candidates.slice(1).some((candidate) => !candidate.hard_constraints_passed));
assert.equal(lintEditorialGrammarSelection(sparseMaterialized, registry).passed, true);
assert.throws(() => materializeEditorialGrammarSelection({
  project_id: 'migration', primary: 'CUTAWAY', supporting: [], ...context,
}, registry), /EDITORIAL_GRAMMAR_PRIMARY_INELIGIBLE/);
assert.throws(() => materializeEditorialGrammarSelection({
  project_id: 'migration', primary: 'THEN_NOW', supporting: [], ...context,
  evidence_features: ['时间序列趋势'],
}, registry), /EDITORIAL_GRAMMAR_EVIDENCE_FEATURE_UNKNOWN.*allowed:/);
const crowded = structuredClone(selection);
crowded.supporting.push('SPECIMEN_GRID');
assert.equal(lintEditorialGrammarSelection(crowded, registry).passed, false);
assert.ok(lintEditorialGrammarSelection(crowded, registry).issues.some((row) => row.rule_id === 'grammar.supporting_limit'));
const rendererForgery = structuredClone(selection);
rendererForgery.available_renderer_capabilities = ['webgl_map'];
rendererForgery.candidates.find((row) => row.grammar === 'SCALE_TRANSLATOR').renderer_capability_passed = true;
assert.equal(lintEditorialGrammarSelection(rendererForgery, registry).passed, false);
assert.ok(lintEditorialGrammarSelection(rendererForgery, registry).issues.some((row) => row.rule_id === 'grammar.renderer_result_mismatch'));
console.log('fact and editorial contract runtime: PASS');
