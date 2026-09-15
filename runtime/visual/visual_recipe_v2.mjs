export const VISUAL_RECIPE_SCHEMA_VERSION='2.0.0';

const JOBS=new Set(['comparison','time_change','distribution','composition','flow','network','hierarchy','geography','explanatory']);
const MODES=new Set(['static_editorial','interactive','print','hybrid']);
const SCALES=new Set(['global','regional','local','site']);

function integer(v,name,{min=0}={}){
  if(!Number.isInteger(v)||v<min) throw new Error(`${name} must be an integer >= ${min}`);
}
function bool(v,name){ if(typeof v!=='boolean') throw new Error(`${name} must be boolean`); }
function object(v,name){ if(!v||typeof v!=='object'||Array.isArray(v)) throw new Error(`${name} must be an object`); }
function stringArray(v,name){ if(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!x.trim())) throw new Error(`${name} must be an array of non-empty strings`); }

export function validateVisualRecipeV2(recipe){
  object(recipe,'recipe');
  if(recipe.schema_version!=null&&recipe.schema_version!==VISUAL_RECIPE_SCHEMA_VERSION) throw new Error(`recipe.schema_version must be ${VISUAL_RECIPE_SCHEMA_VERSION}`);
  if(!JOBS.has(recipe.analytical_job)) throw new Error(`unsupported analytical_job: ${recipe.analytical_job}`);
  if(!MODES.has(recipe.artifact_mode)) throw new Error(`unsupported artifact_mode: ${recipe.artifact_mode}`);
  if(typeof recipe.story_family!=='string'||!recipe.story_family.trim()) throw new Error('story_family must be a non-empty string');
  object(recipe.data_profile,'data_profile'); integer(recipe.data_profile.mark_count??0,'data_profile.mark_count');
  for(const k of ['node_count','edge_count','estimated_bytes']) if(recipe.data_profile[k]!=null) integer(recipe.data_profile[k],`data_profile.${k}`);
  object(recipe.geography,'geography'); bool(recipe.geography.enabled,'geography.enabled');
  if(recipe.geography.enabled&&recipe.geography.scale!=null&&!SCALES.has(recipe.geography.scale)) throw new Error(`unsupported geography.scale: ${recipe.geography.scale}`);
  for(const k of ['terrain','bathymetry']) if(recipe.geography[k]!=null) bool(recipe.geography[k],`geography.${k}`);
  object(recipe.network,'network'); bool(recipe.network.enabled,'network.enabled');
  for(const k of ['spatial','directed','weighted','community_structure','comparison_dense']) if(recipe.network[k]!=null) bool(recipe.network[k],`network.${k}`);
  object(recipe.annotation,'annotation'); integer(recipe.annotation.label_count??0,'annotation.label_count');
  object(recipe.delivery,'delivery'); bool(recipe.delivery.print,'delivery.print'); bool(recipe.delivery.interactive,'delivery.interactive');
  for(const k of ['mobile','vector_required','animation']) if(recipe.delivery[k]!=null) bool(recipe.delivery[k],`delivery.${k}`);
  if(recipe.artifact_mode==='interactive'&&!recipe.delivery.interactive) throw new Error('interactive artifact_mode requires delivery.interactive=true');
  if(recipe.network.enabled&&!['network','flow','hierarchy','explanatory'].includes(recipe.analytical_job)) throw new Error('network.enabled requires a network-compatible analytical_job');
  if(recipe.backend_hints!=null){
    object(recipe.backend_hints,'backend_hints');
    for(const k of ['allow','deny','required_capabilities']) if(recipe.backend_hints[k]!=null) stringArray(recipe.backend_hints[k],`backend_hints.${k}`);
  }
  if(recipe.measure_semantics!=null){
    if(!Array.isArray(recipe.measure_semantics)) throw new Error('measure_semantics must be an array');
    for(const [i,row] of recipe.measure_semantics.entries()) object(row,`measure_semantics[${i}]`);
    if(recipe.measure_semantics.length&&recipe.claim_spec==null) throw new Error('claim_spec is required when measure_semantics are declared');
  }
  if(recipe.claim_spec!=null){
    object(recipe.claim_spec,'claim_spec');
    if(!Array.isArray(recipe.measure_semantics)||!recipe.measure_semantics.length) throw new Error('measure_semantics are required when claim_spec is declared');
  }
  return recipe;
}

export function normalizeVisualRecipeV2(recipe){
  validateVisualRecipeV2(recipe);
  return Object.freeze({
    schema_version:VISUAL_RECIPE_SCHEMA_VERSION,
    ...recipe,
    data_profile:Object.freeze({node_count:0,edge_count:0,temporal:false,...recipe.data_profile}),
    geography:Object.freeze({scale:'regional',projection_policy:'editorial_auto',terrain:false,bathymetry:false,context_layers:[],...recipe.geography}),
    network:Object.freeze({spatial:false,directed:false,weighted:false,community_structure:false,comparison_dense:false,...recipe.network}),
    annotation:Object.freeze({direct_labels:true,locator:false,scale_bar:false,source_note:true,...recipe.annotation}),
    delivery:Object.freeze({mobile:true,vector_required:false,animation:false,...recipe.delivery}),
    backend_hints:Object.freeze({allow:[],deny:[],required_capabilities:[],qualification_mode:false,challenger_mode:false,...(recipe.backend_hints??{})}),
    claim_ids:Object.freeze([...(recipe.claim_ids??[])]),
    measure_semantics:Object.freeze([...(recipe.measure_semantics??[])]),
    claim_spec:recipe.claim_spec?Object.freeze({...recipe.claim_spec}):null,
    generated_imagery:Boolean(recipe.generated_imagery)
  });
}
