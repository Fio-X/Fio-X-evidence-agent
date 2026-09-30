#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rankEditorialGrammarCandidates } from '../runtime/pi/editorial_grammar.mjs';
import { grammarCompatibilityValidator } from '../runtime/pi/editorial_validators.mjs';

const registry = JSON.parse(await readFile(new URL('../config/editorial-grammar-registry.json', import.meta.url), 'utf8'));

function buildGrammarSelection({ primary, supporting = [], evidence_features, cognitive_goals, available_renderer_capabilities = ['svg', 'canvas2d'] }) {
  const context = { evidence_features, cognitive_goals, available_renderer_capabilities };
  const ranked = rankEditorialGrammarCandidates(context, registry);
  const primaryRow = ranked.find((row) => row.grammar === primary);
  const others = ranked.filter((row) => row.grammar !== primary).slice(0, 2);
  return {
    schema_version: '0.1.0', project_id: 'flow-ledger-fixture', primary, supporting,
    available_renderer_capabilities, evidence_features, cognitive_goals,
    candidates: [primaryRow, ...others],
    selected: primary,
    decision_log: [{ stage: 'final_selection', grammar: primary, outcome: 'select', reason_code: 'test_fixture' }],
  };
}

function sankeySpec({ editorial_grammar, scenes = [], extraModules = [] }) {
  return {
    schema_version: '1.5.0',
    editorial_grammar,
    scene_graph: { schema_version: '0.2.0', scenes },
    modules: [
      { id: 'flow-module', type: 'visual', visual_grammar: 'flow' },
      ...extraModules,
    ],
  };
}

// 1. FLOW_LEDGER as primary with both required evidence features lints clean against a plain flow module.
{
  const grammar = buildGrammarSelection({
    primary: 'FLOW_LEDGER',
    evidence_features: ['origin_destination_relation', 'quantity'],
    cognitive_goals: ['ORIENT', 'MEASURE', 'COMPARE'],
  });
  const spec = sankeySpec({ editorial_grammar: grammar, scenes: [{ id: 'orient', primary_cognitive_goal: 'ORIENT' }] });
  const issues = grammarCompatibilityValidator(spec, registry);
  assert.deepEqual(issues, [], JSON.stringify(issues));
}

// 2. Missing origin_destination_relation fails FLOW_LEDGER's hard constraint.
{
  const grammar = buildGrammarSelection({
    primary: 'FLOW_LEDGER',
    evidence_features: ['quantity'],
    cognitive_goals: ['ORIENT', 'MEASURE', 'COMPARE'],
  });
  const spec = sankeySpec({ editorial_grammar: grammar, scenes: [{ id: 'orient', primary_cognitive_goal: 'ORIENT' }] });
  const issues = grammarCompatibilityValidator(spec, registry);
  assert.ok(issues.some((row) => row.rule_id === 'grammar.hard_constraint_failed'), JSON.stringify(issues));
}

// 3. Missing quantity fails FLOW_LEDGER's hard constraint.
{
  const grammar = buildGrammarSelection({
    primary: 'FLOW_LEDGER',
    evidence_features: ['origin_destination_relation'],
    cognitive_goals: ['ORIENT', 'MEASURE', 'COMPARE'],
  });
  const spec = sankeySpec({ editorial_grammar: grammar, scenes: [{ id: 'orient', primary_cognitive_goal: 'ORIENT' }] });
  const issues = grammarCompatibilityValidator(spec, registry);
  assert.ok(issues.some((row) => row.rule_id === 'grammar.hard_constraint_failed'), JSON.stringify(issues));
}

// 4. FLOW_LEDGER carries no EXPLAIN cognitive goal, so an EXPLAIN scene is incompatible.
{
  const grammar = buildGrammarSelection({
    primary: 'FLOW_LEDGER',
    evidence_features: ['origin_destination_relation', 'quantity'],
    cognitive_goals: ['ORIENT', 'MEASURE', 'COMPARE'],
  });
  const spec = sankeySpec({ editorial_grammar: grammar, scenes: [{ id: 'explain', primary_cognitive_goal: 'EXPLAIN' }] });
  const issues = grammarCompatibilityValidator(spec, registry);
  assert.ok(issues.some((row) => row.rule_id === 'grammar.cognitive_goal_incompatible'), JSON.stringify(issues));
}

// 5. FLOW_LEDGER carries no CONSEQUENCE cognitive goal either -- no causal claim follows from a descriptive flow.
{
  const grammar = buildGrammarSelection({
    primary: 'FLOW_LEDGER',
    evidence_features: ['origin_destination_relation', 'quantity'],
    cognitive_goals: ['ORIENT', 'MEASURE', 'COMPARE'],
  });
  const spec = sankeySpec({ editorial_grammar: grammar, scenes: [{ id: 'consequence', primary_cognitive_goal: 'CONSEQUENCE' }] });
  const issues = grammarCompatibilityValidator(spec, registry);
  assert.ok(issues.some((row) => row.rule_id === 'grammar.cognitive_goal_incompatible'), JSON.stringify(issues));
}

// 6. FLOW_LEDGER plus supporting THEN_NOW covers an added trend module and still lints clean.
{
  const grammar = buildGrammarSelection({
    primary: 'FLOW_LEDGER', supporting: ['THEN_NOW'],
    evidence_features: ['origin_destination_relation', 'quantity', 'comparable_timepoints'],
    cognitive_goals: ['ORIENT', 'MEASURE', 'COMPARE'],
  });
  const spec = sankeySpec({
    editorial_grammar: grammar,
    scenes: [{ id: 'orient', primary_cognitive_goal: 'ORIENT' }],
    extraModules: [{ id: 'trend-module', type: 'visual', visual_grammar: 'trend' }],
  });
  const issues = grammarCompatibilityValidator(spec, registry);
  assert.deepEqual(issues, [], JSON.stringify(issues));
}

console.log('flow ledger grammar: PASS');
