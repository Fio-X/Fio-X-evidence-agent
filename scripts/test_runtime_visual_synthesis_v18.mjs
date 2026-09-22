#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
const newsroom=fs.readFileSync(new URL('../runtime/pi/newsroom.ts',import.meta.url),'utf8');
const infographic=fs.readFileSync(new URL('../runtime/pi/infographic.mjs',import.meta.url),'utf8');
const runtime=fs.readFileSync(new URL('../src/runtime.rs',import.meta.url),'utf8');
for(const marker of [
  'name: "newsroom_story_graph"',
  'INFOGRAPHIC_MODULE_BINDING_REQUIRED',
  'schema_version: "1.5.0"',
  'story_graph_ref: Type.String()',
  'reader_question: Type.String()',
  'visual_thesis: Type.String()',
  'editorial_grammar: editorialGrammarParameters',
  'primary_cognitive_goal: StringEnum(["ORIENT", "ZOOM", "EXPLAIN", "MEASURE", "COMPARE", "CONSEQUENCE"] as const)',
  'schema_version: Type.Literal("0.2.0")',
  'delivery_role: Type.Optional(StringEnum(["standalone_visual", "infographic_module"] as const))',
  'name: "newsroom_portable_publication"',
  'field_mapping_json',
  'portable_fallback'
]) assert.ok(newsroom.includes(marker),`missing v1.8 orchestration marker: ${marker}`);
for(const marker of ['default_chart_equivalence','reader_question_closure_missing_answer_coverage','story_node_ids','visual_grammar','evaluateInfographicSynthesis','runEditorialValidators','1.5.0']) assert.ok(infographic.includes(marker),`missing visual synthesis marker: ${marker}`);
assert.ok(newsroom.includes('role-qualified bipartite node labels'));
assert.ok(newsroom.includes('ROUTE_SPINE as primary'));
for(const marker of ['STORY_GRAPH_RUNTIME','story_graph_path']) assert.ok(runtime.includes(marker),`missing StoryGraph runtime materialization marker: ${marker}`);
for(const marker of ['join(root, "runtime", "browser_qa.py")','join(root, "runtime", "networkx_analyze.py")','join(root, "runtime", "networkx_reduce.py")']) assert.ok(newsroom.includes(marker),`missing materialized runtime path: ${marker}`);
for(const marker of ['let browser_qa_path = runtime_dir.join("browser_qa.py")','let networkx_analyze_path = runtime_dir.join("networkx_analyze.py")','let networkx_reduce_path = runtime_dir.join("networkx_reduce.py")']) assert.ok(runtime.includes(marker),`missing runtime materialization: ${marker}`);
for(const marker of ['EDITORIAL_STYLE_MAPPING_CONFIG','editorial-style-mappings.json','config_dir']) assert.ok(runtime.includes(marker),`missing style mapping materialization: ${marker}`);
console.log('runtime visual synthesis v1.8 PASS');
