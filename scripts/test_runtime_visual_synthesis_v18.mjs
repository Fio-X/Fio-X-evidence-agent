#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
const newsroom=fs.readFileSync(new URL('../runtime/pi/newsroom.ts',import.meta.url),'utf8');
const infographic=fs.readFileSync(new URL('../runtime/pi/infographic.mjs',import.meta.url),'utf8');
const runtime=fs.readFileSync(new URL('../src/runtime.rs',import.meta.url),'utf8');
for(const marker of [
  'name: "newsroom_story_graph"',
  'INFOGRAPHIC_MODULE_BINDING_REQUIRED',
  'schema_version: "1.4.0"',
  'story_graph_ref: Type.String()',
  'reader_question: Type.String()',
  'visual_thesis: Type.String()',
  'delivery_role: Type.Optional(StringEnum(["standalone_visual", "infographic_module"] as const))'
]) assert.ok(newsroom.includes(marker),`missing v1.8 orchestration marker: ${marker}`);
for(const marker of ['default_chart_equivalence','reader_question_closure_missing_answer_coverage','story_node_ids','visual_grammar','evaluateInfographicSynthesis']) assert.ok(infographic.includes(marker),`missing v1.8 synthesis marker: ${marker}`);
for(const marker of ['STORY_GRAPH_RUNTIME','story_graph_path']) assert.ok(runtime.includes(marker),`missing StoryGraph runtime materialization marker: ${marker}`);
console.log('runtime visual synthesis v1.8 PASS');
