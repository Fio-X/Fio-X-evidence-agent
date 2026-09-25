#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lintEditorialGrammarSelection } from '../runtime/pi/editorial_grammar.mjs';
import { runEditorialValidators } from '../runtime/pi/editorial_validators.mjs';
import { validateInfographicSpec } from '../runtime/pi/infographic.mjs';
import { assessStoryGraph } from '../runtime/pi/story_graph.mjs';

const load = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const story = await load('../fixtures/migration/story-ir/story-graph.json');
const grammar = await load('../fixtures/migration/story-ir/editorial-grammar-selection.json');
const spec = await load('../fixtures/migration/story-ir/infographic-spec.json');
const registry = await load('../config/editorial-grammar-registry.json');

const assessed = assessStoryGraph(story);
assert.equal(assessed.passed, true, JSON.stringify(assessed.issues));
assert.equal(assessed.metrics.closure_coverage, 1);
assert.equal(lintEditorialGrammarSelection(grammar, registry).passed, true);
assert.deepEqual(validateInfographicSpec(spec), []);
const validators = runEditorialValidators(spec, {}, { editorial_grammar_registry: registry });
assert.equal(validators.passed, true, JSON.stringify(validators.issues));
assert.equal(spec.editorial_grammar.primary, 'ROUTE_SPINE');
assert.deepEqual(spec.editorial_grammar.supporting, ['THEN_NOW', 'SCALE_TRANSLATOR']);
assert.deepEqual(spec.scene_graph.scenes.map((scene) => scene.primary_cognitive_goal), ['ORIENT', 'ZOOM', 'MEASURE', 'COMPARE', 'CONSEQUENCE']);
assert.ok(spec.modules.some((module) => module.visual_grammar === 'spatial'));
assert.ok(spec.modules.some((module) => module.visual_grammar === 'flow'));
assert.ok(spec.modules.some((module) => module.visual_grammar === 'trend'));
assert.ok(spec.modules.some((module) => module.visual_grammar === 'network'));
console.log('migration story IR runtime: PASS');
