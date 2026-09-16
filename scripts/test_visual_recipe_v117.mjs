import assert from 'node:assert/strict';
import { compileVisualRecipeV2 } from '../runtime/visual/visual_compiler_v2.mjs';
import { normalizeVisualRecipeV2 } from '../runtime/visual/visual_recipe_v2.mjs';
const health={
 'viz-python':{status:'AVAILABLE'},'viz-r':{status:'AVAILABLE'},'viz-qgis':{status:'AVAILABLE'},'viz-pygmt':{status:'AVAILABLE'},'viz-density':{status:'AVAILABLE'},'viz-web':{status:'AVAILABLE'}
};
const base={schema_version:'2.0.0',analytical_job:'flow',artifact_mode:'static_editorial',story_family:'maritime_trajectory',data_profile:{geometry:'trajectory',mark_count:15000,temporal:true},geography:{enabled:true,scale:'local',projection_policy:'local_metric'},network:{enabled:false},annotation:{label_count:22,direct_labels:true},delivery:{print:true,interactive:false,mobile:true,vector_required:true},backend_hints:{}};
const normalized=normalizeVisualRecipeV2(base); assert.equal(normalized.schema_version,'2.0.0');
const plan=compileVisualRecipeV2(base,{health});
assert.equal(plan.schema_version,'2.3.0'); assert.ok(plan.primary_backend); assert.equal(plan.data_bearing_pixels,'deterministic_only'); assert.equal(plan.execution_graph[0].stage,'render');
const q=compileVisualRecipeV2({...base,annotation:{label_count:90},backend_hints:{qualification_mode:true}},{health});
assert.equal(q.primary_backend,'qgis_cartography'); assert.ok(q.candidates.length>=3); assert.equal(q.execution_policy,'qualification_multi_render');
const dense=compileVisualRecipeV2({...base,story_family:'ais_density',data_profile:{mark_count:2_000_000},annotation:{label_count:10}},{health});
assert.equal(dense.primary_backend,'datashader_density'); assert.equal(dense.execution_graph[0].stage,'aggregate'); assert.equal(dense.execution_graph[1].stage,'compose');
assert.throws(()=>normalizeVisualRecipeV2({...base,artifact_mode:'interactive'}),/delivery.interactive/);
console.log('visual recipe v1.17 PASS');
