import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VISUAL_SKILLS } from './visual_skill_bundle.mjs';
import { BACKENDS, BACKEND_POLICY_VERSION, backendEligibility, eligibleBackendIds, inferRecipeTopology, scoreBackends } from './backend_policy.mjs';
import { resolveEditorialDesignSystem } from './editorial_design_system_bundle.mjs';

export const VISUAL_BACKEND_PROFILES=Object.freeze(Object.fromEntries(Object.entries(BACKENDS).map(([id,p])=>[id,{runtime:p.runtime,skill:p.skill,mode:p.kind,strengths:p.capabilities}])));

function commandOk(command,args=['--version']){
  try { const r=spawnSync(command,args,{encoding:'utf8',timeout:4000}); return r.status===0; } catch { return false; }
}
function pythonImports(modules){ return commandOk('python3',['-c',modules.map(m=>`import ${m}`).join(';')]); }
function declaredBackends(){
  const value=String(process.env.NEWSROOM_VISUAL_BACKENDS||'').trim();
  if(!value) return null;
  return new Set(value.split(',').map(x=>x.trim()).filter(Boolean));
}

export function detectVisualRuntimeHealth(){
  const declared=declaredBackends();
  const declaredStatus=(backend)=>declared?declared.has(backend):null;
  const py=declaredStatus('python_publication') ?? pythonImports(['geopandas','shapely','pyproj','matplotlib']);
  const r=declaredStatus('r_editorial') ?? commandOk('Rscript',['--version']);
  const qgis=declaredStatus('qgis_cartography') ?? commandOk('qgis_process',['--version']);
  const pygmt=declaredStatus('pygmt_scientific') ?? (commandOk('gmt',['--version']) && pythonImports(['pygmt']));
  const ds=declaredStatus('datashader_density') ?? pythonImports(['datashader','dask']);
  // Plotly and the native Canvas network renderer are bundled in this Node
  // runtime. They do not require Python, NetworkX or a browser executable to
  // produce a self-contained HTML artifact; those dependencies are only
  // needed for optional browser QA or specialist graph analysis. The previous
  // health check conflated those concerns and incorrectly marked the portable
  // fallbacks unavailable on a clean machine.
  const plotlyBundle=existsSync(fileURLToPath(new URL('./vendor/plotly-3.3.1.min.js',import.meta.url)));
  const nativeCanvas=existsSync(fileURLToPath(new URL('./publication.mjs',import.meta.url)));
  const networkx=declaredStatus('networkx_graph') ?? pythonImports(['networkx']);
  const browser=declared ? (['plotly_browser','networkx_graph'].some(b=>declared.has(b))) : plotlyBundle;
  const web=declared?(['maplibre_deckgl','sigma_graph','echarts_editorial','d3_editorial'].some(b=>declared.has(b))):false;
  return Object.freeze({
    python_publication:py,r_editorial:r,qgis_cartography:qgis,pygmt_scientific:pygmt,datashader_density:ds,
    maplibre_deckgl:declaredStatus('maplibre_deckgl') ?? web,
    sigma_graph:declaredStatus('sigma_graph') ?? web,
    echarts_editorial:declaredStatus('echarts_editorial') ?? web,
    d3_editorial:declaredStatus('d3_editorial') ?? web,
    plotly_browser:declaredStatus('plotly_browser') ?? browser,
    canvas_network:declaredStatus('canvas_network') ?? nativeCanvas,
    networkx_graph:networkx,
    ggraph_static:declaredStatus('ggraph_static') ?? r,
    sfnetworks_spatial:declaredStatus('sfnetworks_spatial') ?? r,
    adjacency_matrix:declaredStatus('adjacency_matrix') ?? py
  });
}


export function detectGraphExtractionRuntimeHealth(){
  const declared=String(process.env.NEWSROOM_GRAPH_EXTRACTORS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(declared.length) return Object.freeze({graphrag:declared.includes('graphrag')});
  return Object.freeze({graphrag:pythonImports(['graphrag','pyarrow','pandas'])});
}

export function planVisualBackend(recipe,{availability=detectVisualRuntimeHealth(),includeUnavailable=false,priors={}}={}){
  const normalized={
    schema_version:'2.0.0',
    analytical_job:recipe.analytical_job ?? (recipe.network?'network':recipe.geographic?'geography':'comparison'),
    artifact_mode:recipe.artifact_mode ?? (recipe.interactive?'interactive':'static_editorial'),
    story_family:recipe.story_family||'general',
    data_profile:{mark_count:Number(recipe.mark_count||0),node_count:Number(recipe.node_count||0),edge_count:Number(recipe.edge_count||0),geometry:recipe.geometry??null},
    geography:{enabled:Boolean(recipe.geographic),scale:recipe.geographic_scale||'regional',terrain:Boolean(recipe.terrain),bathymetry:Boolean(recipe.bathymetry)},
    network:{enabled:Boolean(recipe.network),spatial:Boolean(recipe.spatial_network),comparison_dense:Boolean(recipe.comparison_dense)},
    annotation:{label_count:Number(recipe.label_count||0)},
    delivery:{interactive:Boolean(recipe.interactive),print:Boolean(recipe.print),vector_required:Boolean(recipe.vector_required)},
    backend_hints:{allow:[],deny:[],required_capabilities:recipe.required_capabilities??[],qualification_mode:Boolean(recipe.qualification_mode),challenger_mode:Boolean(recipe.challenger_mode)}
  };
  const eligible=eligibleBackendIds(normalized);
  const ranked=scoreBackends(normalized,{priors,candidateBackends:eligible}).map(x=>({...x,available:Boolean(availability[x.backend]),runtime:BACKENDS[x.backend].runtime,skill:BACKENDS[x.backend].skill,topology:inferRecipeTopology(normalized)})).filter(x=>includeUnavailable||x.available);
  const primary=ranked[0]??null;
  const design_system=resolveEditorialDesignSystem(recipe);
  const hard_filter={topology:inferRecipeTopology(normalized),eligible,rejected:Object.fromEntries(Object.keys(BACKENDS).map(b=>[b,backendEligibility(normalized,b)]).filter(([,v])=>!v.eligible).map(([b,v])=>[b,v.reasons]))};
  return {schema_version:'2.3.0',policy_version:BACKEND_POLICY_VERSION,recipe,design_system,primary_backend:primary?.backend??null,primary_skill:primary?.skill??null,ranked,hard_filter,blocked:Object.keys(BACKENDS).filter(b=>!availability[b]),execution_policy:recipe.qualification_mode?'qualification_multi_render':recipe.challenger_mode?'production_with_challenger':'production_single_backend'};
}

export function visualSkill(name){ const skill=VISUAL_SKILLS[name]; if(!skill) throw new Error(`unknown visual skill '${name}'`); return skill; }
export function visualSkillForBackend(backend){ const profile=VISUAL_BACKEND_PROFILES[backend]; if(!profile) throw new Error(`unknown visual backend '${backend}'`); return visualSkill(profile.skill); }
