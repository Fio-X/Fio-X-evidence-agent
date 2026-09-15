#!/usr/bin/env node
import assert from 'node:assert/strict';
import { compareMeasureSemantics, COMPARABILITY } from '../runtime/visual/measure_semantics.mjs';
import { evaluateVisualSemantics } from '../runtime/visual/editorial_semantics.mjs';
import { compileVisualRecipeV2 } from '../runtime/visual/visual_compiler_v2.mjs';
import { planBackendRouting } from '../runtime/visual/backend_router_v2.mjs';

const all=Object.fromEntries(['viz-python','viz-r','viz-qgis','viz-pygmt','viz-density','viz-web'].map(x=>[x,{status:'AVAILABLE'}]));
const base=(patch={})=>({
  schema_version:'2.0.0',analytical_job:'comparison',artifact_mode:'static_editorial',story_family:'editorial_semantics_regression',
  data_profile:{mark_count:4},geography:{enabled:false},network:{enabled:false},annotation:{label_count:4},
  delivery:{print:true,interactive:false,mobile:true,vector_required:true},backend_hints:{},...patch
});

const current={id:'current',phenomenon:'vessel_transits',unit:'vessels/day',measure_kind:'rate',temporal_basis:{type:'point_in_time',date:'2026-09-14'},observation_status:'observed',aggregation:'daily',value:7};
const prewar={id:'prewar',phenomenon:'vessel_transits',unit:'vessels/day',measure_kind:'rate',temporal_basis:{type:'point_in_time'},observation_status:'observed',aggregation:'daily',value:125};
const hormuz=compileVisualRecipeV2(base({
  analytical_job:'time_change',story_family:'hormuz_transit_collapse',data_profile:{mark_count:2,temporal:true},
  measure_semantics:[current,prewar],
  claim_spec:{claim_id:'claim:hormuz-collapse',relation:'change',reader_task:'magnitude_of_change',target_measure:'current',baseline_measure:'prewar',derived_metric:'percent_change'}
}),{health:all});
assert.equal(hormuz.compile_status,'READY');
assert.equal(hormuz.semantic_gate.status,'PASS');
assert.equal(hormuz.editorial_plan.grammar,'change');
assert.deepEqual(hormuz.editorial_plan.recommended_forms,['dumbbell','slope']);
assert.ok(Math.abs(hormuz.semantic_gate.derived_metric.value-(-94.4))<1e-9);
assert.ok(hormuz.editorial_plan.required_constraints.includes('surface_derived_percent_change_as_primary_annotation'));
assert.ok(!hormuz.candidates.some(x=>x.backend==='adjacency_matrix'));

const flow={id:'recent_flow',phenomenon:'crude_oil_flow',unit:'mbd',measure_kind:'flow',temporal_basis:{type:'point_in_time',date:'2026-09-14'},observation_status:'observed',aggregation:'daily',value:4};
const capacity={id:'pipeline_capacity',phenomenon:'crude_oil_flow',unit:'mbd',measure_kind:'capacity',temporal_basis:{type:'structural'},observation_status:'capacity',aggregation:'daily',value:7};
const forecast={id:'annual_supply_change',phenomenon:'crude_oil_flow',unit:'mbd',measure_kind:'change',temporal_basis:{type:'annual_average',start:'2026-01-01',end:'2026-12-31'},observation_status:'forecast',aggregation:'annual_average',value:-5.7};
const shutin={id:'gulf_shut_in',phenomenon:'crude_oil_flow',unit:'mbd',measure_kind:'flow',temporal_basis:{type:'point_in_time',date:'2026-09-14'},observation_status:'observed',aggregation:'daily',value:10};
const bad=compileVisualRecipeV2(base({
  story_family:'supply_shock_scale',measure_semantics:[flow,capacity,forecast,shutin],
  claim_spec:{claim_id:'claim:supply-shock',relation:'benchmark',reader_task:'compare_scale',target_measure:'recent_flow',context_measures:['pipeline_capacity','annual_supply_change','gulf_shut_in']}
}),{health:all});
assert.equal(bad.compile_status,'BLOCKED');
assert.equal(bad.primary_backend,null);
assert.equal(bad.semantic_gate.status,'BLOCK');
assert.ok(bad.unresolved.includes('semantic_comparison_blocked'));
assert.ok(bad.semantic_gate.comparisons.some(x=>x.status==='INCOMPATIBLE'&&x.reasons.includes('temporal_basis_mismatch')));

const contextual=evaluateVisualSemantics({
  measure_semantics:[flow,capacity],
  claim_spec:{claim_id:'claim:capacity-context',relation:'benchmark',reader_task:'actual_vs_capacity',target_measure:'recent_flow',baseline_measure:'pipeline_capacity'}
});
assert.equal(contextual.status,'CONTEXTUAL');
assert.ok(contextual.editorial_plan.required_constraints.includes('do_not_encode_contextual_measures_as_equivalent_peers'));
assert.equal(compareMeasureSemantics(flow,capacity).status,COMPARABILITY.CONTEXTUAL);

const routing=planBackendRouting(base(),{health:all});
assert.equal(routing.hard_filter.topology,'tabular');
assert.ok(!routing.ranked.some(x=>x.backend==='adjacency_matrix'));
assert.ok(routing.hard_filter.rejected.adjacency_matrix.some(x=>x.startsWith('topology:')));

const denominatorA={id:'a',phenomenon:'income',unit:'USD',measure_kind:'level',temporal_basis:{type:'period'},denominator:'person',aggregation:'annual'};
const denominatorB={id:'b',phenomenon:'income',unit:'USD',measure_kind:'level',temporal_basis:{type:'period'},denominator:null,aggregation:'annual'};
assert.equal(compareMeasureSemantics(denominatorA,denominatorB).status,COMPARABILITY.INCOMPATIBLE);

console.log('editorial semantics v1.7 PASS');
