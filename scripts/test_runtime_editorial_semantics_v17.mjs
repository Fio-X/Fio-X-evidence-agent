#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
const newsroom=fs.readFileSync(new URL('../runtime/pi/newsroom.ts',import.meta.url),'utf8');
const runtime=fs.readFileSync(new URL('../src/runtime.rs',import.meta.url),'utf8');
for(const marker of [
  'import { evaluateVisualSemantics } from "./editorial_semantics.mjs"',
  'SEMANTIC_DECLARATION_REQUIRED',
  'SEMANTIC_COMPARISON_BLOCKED',
  'EDITORIAL_GRAMMAR_BLOCKED',
  'semantic_gate: semanticGate',
  'editorial_plan: semanticGate.editorial_plan'
]) assert.ok(newsroom.includes(marker),`missing runtime semantic marker: ${marker}`);
for(const task of ['ranking','comparison','change','distribution','correlation','part_to_whole']) assert.ok(newsroom.includes(`"${task}"`),`missing semantic-required task: ${task}`);
for(const marker of ['MEASURE_SEMANTICS_RUNTIME','EDITORIAL_SEMANTICS_RUNTIME','measure_semantics_path','editorial_semantics_path']) assert.ok(runtime.includes(marker),`missing runtime materialization marker: ${marker}`);
console.log('runtime editorial semantics v1.7 PASS');
