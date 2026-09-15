import { BACKENDS, BACKEND_POLICY_VERSION, backendEligibility, eligibleBackendIds, inferRecipeTopology, scoreBackends } from './backend_policy.mjs';
import { runtimeForBackend } from './runtime_registry.mjs';
import { normalizeVisualRecipeV2 } from './visual_recipe_v2.mjs';
import { qualifiedPriorMap } from './backend_priors.mjs';

export { BACKENDS, BACKEND_POLICY_VERSION };
function available(backend,health){ if(!health) return true; const runtime=runtimeForBackend(backend); const row=health[runtime]; return Boolean(row&&row.status==='AVAILABLE'); }
function softmax(rows,temp=45){
  if(!rows.length)return [];
  const max=Math.max(...rows.map(x=>x.score)); const weights=rows.map(x=>Math.exp((x.score-max)/temp)); const sum=weights.reduce((a,b)=>a+b,0)||1;
  return rows.map((x,i)=>({...x,selection_probability:weights[i]/sum}));
}
function hardSpecialist(row){ return row?.reasons?.some(r=>['scientific_surface','high_mark_count_aggregation','interactive_network','interactive_geography','local_dense_labels','dense_graph_comparison','spatial_network'].includes(r)); }

export function rankBackends(input,{health=null,priors={}}={}){
  const recipe=normalizeVisualRecipeV2(input); const allow=new Set(recipe.backend_hints.allow||[]); const deny=new Set(recipe.backend_hints.deny||[]); const pmap=qualifiedPriorMap(priors);
  const eligible=new Set(eligibleBackendIds(recipe).filter(b=>(allow.size===0||allow.has(b))&&!deny.has(b)));
  const ranked=scoreBackends(recipe,{priors:pmap,candidateBackends:[...eligible]})
    .map(x=>({...x,runtime:BACKENDS[x.backend].runtime,skill:BACKENDS[x.backend].skill,available:available(x.backend,health),topology:inferRecipeTopology(recipe)}))
    .filter(x=>x.available);
  return softmax(ranked);
}

export function planBackendRouting(input,{health=null,priors={},flagship=false}={}){
  const recipe=normalizeVisualRecipeV2(input); const ranked=rankBackends(recipe,{health,priors});
  const hardFilter={topology:inferRecipeTopology(recipe),eligible:Object.keys(BACKENDS).filter(b=>backendEligibility(recipe,b).eligible),rejected:Object.fromEntries(Object.keys(BACKENDS).map(b=>[b,backendEligibility(recipe,b)]).filter(([,v])=>!v.eligible).map(([b,v])=>[b,v.reasons]))};
  if(!ranked.length) return {backend:null,confidence:0,probability_gap:0,reasons:['no_available_backend'],ranked:[],challenger:false,challenger_reasons:[],hard_filter:hardFilter};
  const top=ranked[0],second=ranked[1]??null; const gap=second?top.selection_probability-second.selection_probability:1; const pmap=qualifiedPriorMap(priors); const hasPrior=Boolean(pmap[recipe.story_family]); const specialist=hardSpecialist(top);
  const reasons=[];
  if(flagship) reasons.push('flagship_story');
  if(recipe.backend_hints.challenger_mode) reasons.push('explicit_challenger');
  if(second&&!hasPrior&&!specialist) reasons.push('new_story_family_without_human_prior');
  if(second&&top.selection_probability<0.65&&!specialist) reasons.push('low_selection_confidence');
  if(second&&gap<0.12&&!specialist) reasons.push('top_two_close');
  const challenger=Boolean(second)&&reasons.length>0;
  return {...top,backend:top.backend,confidence:top.selection_probability,probability_gap:gap,has_qualified_prior:hasPrior,specialist_rule:specialist,ranked,challenger,challenger_reasons:reasons,hard_filter:hardFilter};
}

export function chooseBackend(recipe,opts={}){
  const plan=planBackendRouting(recipe,opts);
  if(!plan.backend) return {backend:null,score:0,reasons:['no_available_backend'],ranked:[],confidence:0,hard_filter:plan.hard_filter};
  return plan;
}
