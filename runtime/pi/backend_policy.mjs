// Generated from runtime/visual/backend_policy.mjs. Do not edit by hand.
export const BACKEND_POLICY_VERSION='4.1.0';

export const BACKENDS=Object.freeze({
  python_publication:{runtime:'viz-python',kind:'static',skill:'python-gis',capabilities:['static_editorial','static_map','trajectory','flow_map','choropleth','symbol_map','adjacency_matrix'],topologies:['tabular','tabular_flow','geography','trajectory','geo_flow','process'],artifact_modes:['static_editorial','print','hybrid']},
  r_editorial:{runtime:'viz-r',kind:'static',skill:'r-editorial',capabilities:['static_editorial','static_map','statistical_chart'],topologies:['tabular','tabular_flow','geography','trajectory','geo_flow','process'],artifact_modes:['static_editorial','print','hybrid']},
  qgis_cartography:{runtime:'viz-qgis',kind:'static',skill:'qgis-cartography',capabilities:['publication_cartography','local_cartography','dense_labels','print_layout'],topologies:['geography','trajectory','geo_flow'],artifact_modes:['static_editorial','print','hybrid']},
  pygmt_scientific:{runtime:'viz-pygmt',kind:'static',skill:'pygmt-scientific',capabilities:['terrain','bathymetry','scientific_map','global_projection'],topologies:['geography','trajectory'],artifact_modes:['static_editorial','print','hybrid']},
  datashader_density:{runtime:'viz-density',kind:'compute',skill:'datashader-density',capabilities:['million_point_density','trajectory_density','raster_aggregation'],topologies:['tabular','geography','trajectory','geo_flow'],artifact_modes:['static_editorial','print','hybrid']},
  maplibre_deckgl:{runtime:'viz-map',kind:'interactive',skill:'web-geospatial',capabilities:['interactive_geo','gpu_paths','trips','vector_tiles','linked_geo_views','scientific_map','physical_basemap','projection_explicit','scale_bar'],topologies:['geography','trajectory','geo_flow'],artifact_modes:['interactive','hybrid']},
  sigma_graph:{runtime:'viz-sigma',kind:'interactive',skill:'sigma-network',capabilities:['interactive_network','graph_search','graph_filter'],topologies:['graph','spatial_network','hierarchy'],artifact_modes:['interactive','hybrid']},
  ggraph_static:{runtime:'viz-r',kind:'static',skill:'r-editorial',capabilities:['static_network'],topologies:['graph','hierarchy'],artifact_modes:['static_editorial','print','hybrid']},
  sfnetworks_spatial:{runtime:'viz-r',kind:'static',skill:'r-editorial',capabilities:['spatial_network'],topologies:['spatial_network'],artifact_modes:['static_editorial','print','hybrid']},
  adjacency_matrix:{runtime:'viz-python',kind:'static',skill:'editorial-chart',capabilities:['adjacency_matrix','dense_graph_comparison'],topologies:['graph'],artifact_modes:['static_editorial','print','hybrid']},
  echarts_editorial:{runtime:'viz-web',kind:'interactive',skill:'editorial-chart',capabilities:['statistical_chart'],topologies:['tabular','tabular_flow'],artifact_modes:['interactive','hybrid']},
  d3_editorial:{runtime:'viz-d3',kind:'interactive',skill:'d3-editorial',capabilities:['self_contained_html','responsive_html','radial_network','radial_hierarchy','circle_packing','interactive_sankey','interactive_chord','parallel_coordinates','custom_svg','linked_views','claim_annotations'],topologies:['tabular','tabular_flow','graph','hierarchy'],artifact_modes:['interactive','hybrid']},
  plotly_browser:{runtime:'viz-browser',kind:'interactive',skill:'plotly-editorial',capabilities:['self_contained_html','responsive_html','statistical_chart','plotly_interactive','plotly_sankey','interactive_sankey','linked_views','linked_geo_views','uncertainty_band','claim_annotations','scientific_map','physical_basemap','projection_explicit','scale_bar','radial_network','treemap','sunburst','icicle','parallel_coordinates'],topologies:['tabular','tabular_flow','graph','hierarchy','geography','geo_flow'],artifact_modes:['interactive','hybrid']},
  canvas_network:{runtime:'viz-browser',kind:'interactive',skill:'network-browser',capabilities:['self_contained_html','responsive_html','native_canvas_network','large_network','large_network_overview','interactive_focus','claim_annotations'],topologies:['graph','hierarchy','spatial_network'],artifact_modes:['interactive','hybrid']},
  networkx_graph:{runtime:'viz-browser',kind:'compute',skill:'network-analysis',capabilities:['network_analysis','network_layout','community_detection','community_reduction','centrality','graph_metrics'],topologies:['graph','hierarchy','spatial_network'],artifact_modes:['static_editorial','interactive','print','hybrid']}
});

function add(scores,b,points,reason){
  const s=scores.get(b); if(!s) return;
  s.score+=points; if(reason) s.reasons.push(reason);
}

export function inferRecipeTopology(recipe){
  const d=recipe.data_profile||{}, g=recipe.geography||{}, n=recipe.network||{};
  const geometry=String(d.geometry||'').toLowerCase();
  if(n.enabled){
    if(n.spatial) return 'spatial_network';
    if(recipe.analytical_job==='hierarchy') return 'hierarchy';
    return 'graph';
  }
  if(g.enabled){
    if(geometry.includes('trajectory')||String(recipe.story_family||'').includes('trajectory')) return 'trajectory';
    if(recipe.analytical_job==='flow'||String(recipe.story_family||'').includes('flow')) return 'geo_flow';
    return 'geography';
  }
  if(recipe.analytical_job==='flow') return 'tabular_flow';
  if(geometry.includes('process')) return 'process';
  return 'tabular';
}

export function backendEligibility(recipe,backend){
  const spec=BACKENDS[backend];
  if(!spec) return {eligible:false,reasons:['unknown_backend']};
  const topology=inferRecipeTopology(recipe);
  const reasons=[];
  if(!spec.topologies.includes(topology)) reasons.push(`topology:${topology}`);
  if(backend==='canvas_network'&&Number(recipe.data_profile?.node_count||0)>2500) reasons.push('scale_limit:nodes>2500');
  if(!spec.artifact_modes.includes(recipe.artifact_mode)) reasons.push(`artifact_mode:${recipe.artifact_mode}`);
  const required=recipe.backend_hints?.required_capabilities||[];
  // Presentation requirements constrain final renderers. Compute stages may
  // participate in a multi-stage plan without pretending to render the
  // requested visual form themselves.
  if(spec.kind!=='compute') for(const cap of required) if(!spec.capabilities.includes(cap)) reasons.push(`missing_capability:${cap}`);
  const delivery=recipe.delivery||{};
  if(recipe.artifact_mode==='interactive'&&!['interactive','compute'].includes(spec.kind)) reasons.push('interactive_delivery_requires_interactive_backend');
  if(!['interactive','hybrid'].includes(recipe.artifact_mode)&&spec.kind==='interactive') reasons.push('static_delivery_rejects_interactive_backend');
  return {eligible:reasons.length===0,reasons,topology};
}

export function eligibleBackendIds(recipe){
  return Object.keys(BACKENDS).filter(b=>backendEligibility(recipe,b).eligible);
}

export function scoreBackends(recipe,{priors={},candidateBackends=null}={}){
  const ids=candidateBackends??Object.keys(BACKENDS);
  const scores=new Map(ids.map(b=>[b,{backend:b,score:0,reasons:[]}]))
  const mode=recipe.artifact_mode;
  const family=String(recipe.story_family||'');
  const d=recipe.data_profile||{};
  const g=recipe.geography||{};
  const n=recipe.network||{};
  const a=recipe.annotation||{};
  const delivery=recipe.delivery||{};
  const marks=Number(d.mark_count||0);
  const nodes=Number(d.node_count||0);
  const edges=Number(d.edge_count||0);
  const labels=Number(a.label_count||0);
  const interactive=Boolean(delivery.interactive||mode==='interactive'||mode==='hybrid');

  if(n.enabled){
    const denseComparison=Boolean(n.comparison_dense)||(nodes>1500&&edges>nodes*8);
    add(scores,'networkx_graph',125,'network_analysis');
    if(denseComparison&&!interactive) add(scores,'adjacency_matrix',165,'dense_graph_comparison');
    if(n.spatial&&!interactive) add(scores,'sfnetworks_spatial',155,'spatial_network');
    if(interactive){
      add(scores,'sigma_graph',nodes>=3000?215:190,'interactive_network');
      add(scores,'canvas_network',nodes>=2500&&nodes<=15000?205:115,'native_canvas_large_network');
      add(scores,'d3_editorial',nodes<=5000?165:85,'custom_network');
      add(scores,'plotly_browser',nodes<=2500?120:35,'interactive_network_fallback');
      if(recipe.analytical_job==='hierarchy') add(scores,'d3_editorial',55,'hierarchy_specialist');
    } else add(scores,'ggraph_static',130,'static_network');
  } else if(interactive){
    if(g.enabled){
      add(scores,'maplibre_deckgl',150,'interactive_geography');
      add(scores,'plotly_browser',120,'interactive_geo_fallback');
      if(marks>=10_000) add(scores,'maplibre_deckgl',45,'gpu_geo_scale');
    } else if(recipe.analytical_job==='flow'){
      add(scores,'d3_editorial',180,'interactive_flow');
      add(scores,'plotly_browser',170,'interactive_sankey');
      add(scores,'echarts_editorial',105,'interactive_flow_fallback');
    } else {
      add(scores,'plotly_browser',150,'interactive_chart');
      add(scores,'echarts_editorial',115,'interactive_chart');
      add(scores,'d3_editorial',90,'custom_interactive_chart');
    }
  }

  if(!n.enabled){
    if(g.terrain||g.bathymetry||family.includes('terrain')||family.includes('bathymetry')) add(scores,'pygmt_scientific',170,'scientific_surface');
    if(!interactive&&(marks>=1_000_000||family.includes('density'))) add(scores,'datashader_density',160,'high_mark_count_aggregation');
    if(g.enabled&&['local','site'].includes(g.scale)&&labels>=40) add(scores,'qgis_cartography',145,'local_dense_labels');
    if(g.enabled&&delivery.print) add(scores,'qgis_cartography',35,'print_cartography');
    if(g.enabled&&!interactive&&['trajectory','maritime_trajectory','flight_route','global_flow','regional_flow'].some(x=>family.includes(x))){
      add(scores,'python_publication',75,'analytical_geo');
      add(scores,'r_editorial',60,'editorial_geo');
      add(scores,'qgis_cartography',50,'cartographic_candidate');
    }
    if(g.enabled&&!interactive){ add(scores,'python_publication',50,'default_static_geo'); add(scores,'r_editorial',40,'default_static_geo'); }
    if(!g.enabled&&!interactive){ add(scores,'r_editorial',65,'static_editorial_chart'); add(scores,'python_publication',45,'static_analytical_chart'); }
  }

  if(mode==='print'||delivery.vector_required){
    add(scores,'qgis_cartography',15,'vector_print');
    add(scores,'r_editorial',12,'vector_print');
    add(scores,'python_publication',10,'vector_print');
    add(scores,'ggraph_static',8,'vector_print');
    add(scores,'adjacency_matrix',8,'vector_print');
  }
  const prior=priors[family]||{};
  for(const [b,p] of Object.entries(prior)) if(scores.has(b)) add(scores,b,Math.round(Number(p)*30),'empirical_prior');
  return [...scores.values()].sort((a,b)=>b.score-a.score||a.backend.localeCompare(b.backend));
}
