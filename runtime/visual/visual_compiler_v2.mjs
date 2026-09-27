import { BACKENDS, planBackendRouting } from './backend_router_v2.mjs';
import { normalizeVisualRecipeV2 } from './visual_recipe_v2.mjs';
import { evaluateVisualSemantics } from './editorial_semantics.mjs';

function nextFinalRenderer(ranked){ return ranked.find(x=>BACKENDS[x.backend].kind!=='compute')??null; }
function executionGraph(recipe,ranked){
  const primary=ranked[0]??null; if(!primary)return [];
  if(primary.backend==='datashader_density'){
    const final=nextFinalRenderer(ranked.slice(1)); return [{stage:'aggregate',backend:'datashader_density',runtime:'viz-density',artifact_role:'evidence_bearing_raster'},...(final?[{stage:'compose',backend:final.backend,runtime:final.runtime,artifact_role:'editorial_composition'}]:[])];
  }
  const graphAnalysis=recipe.network?.enabled?ranked.find(x=>x.backend==='networkx_graph'):null;
  const final=primary.backend==='networkx_graph'?nextFinalRenderer(ranked.slice(1)):primary;
  const stages=[];
  if(graphAnalysis&&final?.backend!==graphAnalysis.backend) stages.push({stage:'analyze',backend:'networkx_graph',runtime:'viz-browser',artifact_role:'graph_metrics_layout'});
  if(final) stages.push({stage:'render',backend:final.backend,runtime:final.runtime,artifact_role:'final'});
  return stages;
}
function qaPolicy(qualification){
  return {hard_gates:['schema','source_ledger','semantic_comparability','claim_grammar','data_fidelity','geometry_crs','export_integrity'],visual:['screenshot_critic'],human:qualification?['blinded_pairwise']:[]};
}
export function compileVisualRecipeV2(input,{health=null,priors={},flagship=false}={}){
  const recipe=normalizeVisualRecipeV2(input);
  const semanticGate=evaluateVisualSemantics(recipe);
  const qualification=Boolean(recipe.backend_hints.qualification_mode);
  if(semanticGate.status==='BLOCK'){
    return Object.freeze({
      schema_version:'2.3.0',recipe_schema_version:recipe.schema_version,compile_status:'BLOCKED',analytical_job:recipe.analytical_job,story_family:recipe.story_family,artifact_mode:recipe.artifact_mode,
      primary_backend:null,routing_confidence:0,probability_gap:0,has_qualified_prior:false,challenger_reasons:[],candidates:[],execution_graph:[],execution_policy:'semantic_block',
      semantic_gate:semanticGate,editorial_plan:semanticGate.editorial_plan,backend_hard_filter:null,
      data_bearing_pixels:'deterministic_only',generated_imagery_policy:recipe.generated_imagery?'context_only_no_data_geometry':'disabled',factual_geometry_policy:'backend_geometry_engine_only',
      qa:qaPolicy(qualification),unresolved:['semantic_comparison_blocked']
    });
  }
  const plan=planBackendRouting(recipe,{health,priors,flagship}); const ranked=plan.ranked||[]; const challenger=!qualification&&plan.challenger;
  const primary=ranked[0]??null; const selected=qualification?ranked:ranked.slice(0,challenger?2:1);
  const candidates=selected.map(x=>({backend:x.backend,runtime:x.runtime,skill:x.skill,score:x.score,selection_probability:x.selection_probability,reasons:x.reasons,kind:BACKENDS[x.backend].kind,topology:x.topology}));
  const graph=executionGraph(recipe,ranked); const unresolved=[]; if(!primary)unresolved.push('runtime_unavailable'); if(primary?.backend==='datashader_density'&&graph.length<2)unresolved.push('density_compositor_unavailable'); if(primary&&BACKENDS[primary.backend].kind==='compute'&&!graph.some(x=>x.artifact_role==='final'))unresolved.push('final_renderer_unavailable');
  const compileStatus=primary&&unresolved.length===0?'READY':'UNRESOLVED';
  return Object.freeze({schema_version:'2.3.0',recipe_schema_version:recipe.schema_version,compile_status:compileStatus,analytical_job:recipe.analytical_job,story_family:recipe.story_family,artifact_mode:recipe.artifact_mode,primary_backend:primary?.backend??null,routing_confidence:plan.confidence??0,probability_gap:plan.probability_gap??0,has_qualified_prior:Boolean(plan.has_qualified_prior),challenger_reasons:plan.challenger_reasons??[],candidates,execution_graph:graph,execution_policy:qualification?'qualification_multi_render':(challenger?'production_with_challenger':'production_single_backend'),semantic_gate:semanticGate,editorial_plan:semanticGate.editorial_plan,backend_hard_filter:plan.hard_filter??null,data_bearing_pixels:'deterministic_only',generated_imagery_policy:recipe.generated_imagery?'context_only_no_data_geometry':'disabled',factual_geometry_policy:'backend_geometry_engine_only',qa:qaPolicy(qualification),unresolved});
}
