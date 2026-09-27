#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileVisualRecipeV2 } from '../runtime/visual/visual_compiler_v2.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('../fixtures/v17-editorial-semantics/saudi-hormuz-2026-09-14.json',import.meta.url),'utf8'));
const health=Object.fromEntries(['viz-python','viz-r','viz-qgis','viz-pygmt','viz-density','viz-web'].map(x=>[x,{status:'AVAILABLE'}]));
for(const c of fixture.cases){
  const plan=compileVisualRecipeV2(c.recipe,{health});
  assert.equal(plan.compile_status,c.expected_compile_status,`${c.id}: compile status`);
  assert.equal(plan.semantic_gate.status,c.expected_semantic_status,`${c.id}: semantic status`);
  if(c.expected_grammar) assert.equal(plan.editorial_plan.grammar,c.expected_grammar,`${c.id}: grammar`);
  if(c.expected_percent_change!=null) assert.ok(Math.abs(plan.semantic_gate.derived_metric.value-c.expected_percent_change)<1e-9,`${c.id}: derived metric`);
  if(c.expected_compile_status==='READY') assert.ok(!plan.candidates.some(x=>x.backend==='adjacency_matrix'),`${c.id}: adjacency_matrix leaked through hard filter`);
  if(c.expected_compile_status==='BLOCKED') assert.ok(plan.unresolved.includes('semantic_comparison_blocked'),`${c.id}: missing semantic blocker`);
}
console.log(`cold story editorial semantics v1.7 PASS (${fixture.story_date}, ${fixture.cases.length} cases)`);
