// Generated from runtime/visual/editorial_semantics.mjs. Do not edit by hand.
import { COMPARABILITY, compareMeasureSemantics, normalizeMeasureSemantics } from './measure_semantics.mjs';

export const CLAIM_SPEC_VERSION='1.0.0';
export const EDITORIAL_GRAMMAR_VERSION='1.0.0';

// `comparison` is a reader-facing task exposed by the newsroom tool schema.
// Keep it as a first-class claim relation so the model can declare a direct
// comparison without being rejected before the chart grammar is evaluated.
const RELATIONS=new Set(['rank','comparison','change','trend','anomaly','benchmark','composition','distribution','relationship','correlation','uncertainty','flow','geography','network']);
const DERIVED_METRICS=new Set(['percent_change','absolute_change','percentage_point_change','ratio']);

function object(v,name){ if(!v||typeof v!=='object'||Array.isArray(v)) throw new Error(`${name} must be an object`); }
function string(v,name,{required=true}={}){
  if(v==null&&!required) return null;
  if(typeof v!=='string'||!v.trim()) throw new Error(`${name} must be a non-empty string`);
  return v.trim();
}
function strings(v,name){
  if(v==null) return [];
  if(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!x.trim())) throw new Error(`${name} must be an array of non-empty strings`);
  return [...new Set(v.map(x=>x.trim()))];
}

export function normalizeClaimSpec(input,measures=[]){
  if(input==null) return null;
  object(input,'claim_spec');
  const requestedRelation=string(input.relation,'claim_spec.relation');
  if(!RELATIONS.has(requestedRelation)) throw new Error(`unsupported claim_spec.relation: ${requestedRelation}`);
  // Accept the reader-facing term and canonicalize it to the newsroom
  // relationship grammar before deriving recommended visual forms.
  const relation=requestedRelation==='correlation'?'relationship':requestedRelation;
  const target=string(input.target_measure,'claim_spec.target_measure',{required:false});
  const baseline=string(input.baseline_measure,'claim_spec.baseline_measure',{required:false});
  const contexts=strings(input.context_measures,'claim_spec.context_measures');
  const explicit=strings(input.measure_ids,'claim_spec.measure_ids');
  const measureIds=[...new Set([...explicit,...(target?[target]:[]),...(baseline?[baseline]:[]),...contexts])];
  if(!measureIds.length) throw new Error('claim_spec must reference at least one measure');
  const known=new Set(measures.map(x=>x.id));
  for(const id of measureIds) if(!known.has(id)) throw new Error(`claim_spec references unknown measure: ${id}`);
  let derived=null;
  if(input.derived_metric!=null){
    const raw=typeof input.derived_metric==='string'?{type:input.derived_metric}:input.derived_metric;
    object(raw,'claim_spec.derived_metric');
    const type=string(raw.type,'claim_spec.derived_metric.type');
    if(!DERIVED_METRICS.has(type)) throw new Error(`unsupported claim_spec.derived_metric.type: ${type}`);
    derived=Object.freeze({type});
  }
  return Object.freeze({
    schema_version:CLAIM_SPEC_VERSION,
    // Draft visual plans may declare the comparison grammar before a factual
    // claim is reviewed; publishable plans still bind a verified claim_id.
    claim_id:string(input.claim_id,'claim_spec.claim_id',{required:false}),
    relation,
    reader_task:string(input.reader_task,'claim_spec.reader_task'),
    target_measure:target,
    baseline_measure:baseline,
    context_measures:Object.freeze(contexts),
    measure_ids:Object.freeze(measureIds),
    derived_metric:derived
  });
}

function computeDerivedMetric(claim,measureMap){
  if(!claim?.derived_metric) return null;
  if(!claim.target_measure||!claim.baseline_measure) return Object.freeze({status:'UNAVAILABLE',reason:'target_and_baseline_required'});
  const target=measureMap.get(claim.target_measure), baseline=measureMap.get(claim.baseline_measure);
  if(target?.value==null||baseline?.value==null) return Object.freeze({status:'UNAVAILABLE',reason:'scalar_values_required'});
  const t=target.value,b=baseline.value,type=claim.derived_metric.type;
  let value,unit;
  if(type==='percent_change'){
    if(b===0) return Object.freeze({status:'UNAVAILABLE',reason:'zero_baseline'});
    value=((t-b)/b)*100; unit='%';
  } else if(type==='absolute_change'){
    value=t-b; unit=target.unit;
  } else if(type==='percentage_point_change'){
    value=t-b; unit='percentage_points';
  } else if(type==='ratio'){
    if(b===0) return Object.freeze({status:'UNAVAILABLE',reason:'zero_baseline'});
    value=t/b; unit='ratio';
  }
  return Object.freeze({status:'COMPUTED',type,value,unit,target_measure:target.id,baseline_measure:baseline.id});
}

function grammarFor(claim,gate){
  if(!claim) return null;
  const twoPoint=Boolean(claim.target_measure&&claim.baseline_measure);
  const map={
    rank:['horizontal_bar','dot'],
    comparison:['horizontal_bar','dot','dumbbell','slope','small_multiples'],
    change:twoPoint?['dumbbell','slope']:['line'],
    trend:['line','small_multiples'],
    anomaly:['diverging_bar','dot','small_multiples'],
    benchmark:['dot_with_reference','bullet'],
    composition:['stacked_bar','heatmap'],
    distribution:['dot_distribution','histogram','boxplot'],
    relationship:['scatter'],
    uncertainty:['interval','ribbon'],
    flow:['sankey','alluvial','flow_map'],
    geography:['symbol_map','choropleth'],
    network:['node_link','adjacency_matrix']
  };
  const constraints=[];
  if(gate.status==='CONTEXTUAL') constraints.push('contextual_measures_must_use_distinct_visual_roles','do_not_encode_contextual_measures_as_equivalent_peers');
  if(claim.derived_metric?.type==='percent_change') constraints.push('surface_derived_percent_change_as_primary_annotation');
  return Object.freeze({
    schema_version:EDITORIAL_GRAMMAR_VERSION,
    grammar:claim.relation,
    reader_task:claim.reader_task,
    recommended_forms:Object.freeze(map[claim.relation]??[]),
    required_constraints:Object.freeze(constraints)
  });
}

export function evaluateVisualSemantics(input){
  const measures=normalizeMeasureSemantics(input?.measure_semantics);
  if(!measures.length){
    return Object.freeze({status:'NOT_DECLARED',enforcement:'legacy',measures,claim_spec:null,comparisons:Object.freeze([]),derived_metric:null,editorial_plan:null,repairs:Object.freeze([])});
  }
  const claim=normalizeClaimSpec(input?.claim_spec,measures);
  if(!claim) throw new Error('claim_spec is required when measure_semantics are declared');
  const map=new Map(measures.map(x=>[x.id,x]));
  const comparisons=[];
  for(let i=0;i<claim.measure_ids.length;i++){
    for(let j=i+1;j<claim.measure_ids.length;j++){
      const a=map.get(claim.measure_ids[i]),b=map.get(claim.measure_ids[j]);
      const verdict=compareMeasureSemantics(a,b);
      comparisons.push(Object.freeze({a:a.id,b:b.id,...verdict}));
    }
  }
  const blocked=comparisons.some(x=>x.status===COMPARABILITY.INCOMPATIBLE);
  const contextual=!blocked&&comparisons.some(x=>x.status===COMPARABILITY.CONTEXTUAL);
  const status=blocked?'BLOCK':(contextual?'CONTEXTUAL':'PASS');
  const repairs=[...new Set(comparisons.flatMap(x=>x.repair))];
  const derivedMetric=computeDerivedMetric(claim,map);
  const gate=Object.freeze({status,enforcement:'strict',measures,claim_spec:claim,comparisons:Object.freeze(comparisons),derived_metric:derivedMetric,repairs:Object.freeze(repairs)});
  return Object.freeze({...gate,editorial_plan:grammarFor(claim,gate)});
}
