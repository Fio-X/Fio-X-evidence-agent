#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compareMeasureSemantics } from '../runtime/visual/measure_semantics.mjs';
import { evaluateVisualSemantics } from '../runtime/visual/editorial_semantics.mjs';
import { backendEligibility } from '../runtime/visual/backend_policy.mjs';

const corpus=JSON.parse(fs.readFileSync(new URL('../fixtures/v17-editorial-semantics/adversarial-corpus.json',import.meta.url),'utf8'));
let incompatibleFalseNegatives=0;
for(const c of corpus.cases){
  const verdict=compareMeasureSemantics(c.a,c.b);
  assert.equal(verdict.status,c.expected,`${c.id}: expected ${c.expected}, got ${verdict.status}`);
  if(c.reason) assert.ok(verdict.reasons.includes(c.reason),`${c.id}: missing reason ${c.reason}`);
  if(c.expected==='INCOMPATIBLE'&&verdict.status!=='INCOMPATIBLE') incompatibleFalseNegatives++;
}
assert.equal(incompatibleFalseNegatives,0,'INCOMPATIBLE false negatives must be zero');

const grammarCases=[
  ['rank',['horizontal_bar','dot']],['comparison',['horizontal_bar','dot','dumbbell','slope','small_multiples']],['change',['dumbbell','slope']],['trend',['line','small_multiples']],
  ['benchmark',['dot_with_reference','bullet']],['relationship',['scatter']],['flow',['sankey','alluvial','flow_map']],
  ['network',['node_link','adjacency_matrix']]
];
const baseMeasures=[
  {id:'a',phenomenon:'metric',unit:'u',measure_kind:'level',temporal_basis:{type:'period'},aggregation:'annual',value:12},
  {id:'b',phenomenon:'metric',unit:'u',measure_kind:'level',temporal_basis:{type:'period'},aggregation:'annual',value:10}
];
for(const [relation,expectedForms] of grammarCases){
  const gate=evaluateVisualSemantics({measure_semantics:baseMeasures,claim_spec:{claim_id:`claim:${relation}`,relation,reader_task:`task_${relation}`,target_measure:'a',baseline_measure:'b'}});
  assert.equal(gate.editorial_plan.grammar,relation);
  assert.deepEqual(gate.editorial_plan.recommended_forms,expectedForms);
}

const recipe=(patch={})=>({schema_version:'2.0.0',analytical_job:'comparison',artifact_mode:'static_editorial',story_family:'backend_negative_matrix',data_profile:{mark_count:10},geography:{enabled:false},network:{enabled:false},annotation:{label_count:4},delivery:{print:true,interactive:false},backend_hints:{required_capabilities:[]},...patch});
const matrices=[
  {id:'tabular_static',r:recipe(),must:['python_publication','r_editorial'],mustNot:['adjacency_matrix','sigma_graph','qgis_cartography']},
  {id:'local_geo',r:recipe({analytical_job:'geography',story_family:'local_map',geography:{enabled:true,scale:'local'}}),must:['python_publication','r_editorial','qgis_cartography'],mustNot:['adjacency_matrix','sigma_graph']},
  {id:'dense_graph',r:recipe({analytical_job:'network',story_family:'dense_graph',data_profile:{mark_count:0,node_count:2000,edge_count:20000},network:{enabled:true,comparison_dense:true}}),must:['ggraph_static','adjacency_matrix'],mustNot:['python_publication','qgis_cartography','sigma_graph']},
  {id:'interactive_network',r:recipe({analytical_job:'network',artifact_mode:'interactive',network:{enabled:true},delivery:{print:false,interactive:true}}),must:['sigma_graph'],mustNot:['adjacency_matrix','ggraph_static','python_publication']},
  {id:'interactive_geo',r:recipe({analytical_job:'geography',artifact_mode:'interactive',geography:{enabled:true,scale:'regional'},delivery:{print:false,interactive:true}}),must:['maplibre_deckgl'],mustNot:['qgis_cartography','python_publication','sigma_graph']},
  {id:'spatial_network',r:recipe({analytical_job:'network',network:{enabled:true,spatial:true}}),must:['sfnetworks_spatial'],mustNot:['adjacency_matrix','python_publication','qgis_cartography']}
];
for(const m of matrices){
  for(const b of m.must) assert.equal(backendEligibility(m.r,b).eligible,true,`${m.id}: ${b} should be eligible`);
  for(const b of m.mustNot) assert.equal(backendEligibility(m.r,b).eligible,false,`${m.id}: ${b} should be rejected`);
}

console.log(`editorial semantics adversarial v1.7 PASS (${corpus.cases.length} semantic cases, ${grammarCases.length} grammar cases, ${matrices.length} backend matrices)`);
