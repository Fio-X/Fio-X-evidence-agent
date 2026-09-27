export const GRAPH_BACKENDS=Object.freeze({
  sigma_graph:{runtime:'viz-web',mode:'interactive',engine:'Sigma.js 3 + Graphology',max_recommended_nodes:50000},
  ggraph_static:{runtime:'viz-r',mode:'static',engine:'igraph/tidygraph + ggraph',max_recommended_nodes:5000},
  sfnetworks_spatial:{runtime:'viz-r',mode:'static',engine:'sfnetworks + sf',max_recommended_nodes:50000},
  adjacency_matrix:{runtime:'viz-python',mode:'static',engine:'deterministic matrix',max_recommended_nodes:2000}
});

export function chooseGraphBackend({interactive=false,spatial=false,nodes=0,edges=0,comparisonDense=false}={}){
  if(comparisonDense || (nodes>1500 && edges>nodes*8)) return 'adjacency_matrix';
  if(spatial) return 'sfnetworks_spatial';
  if(interactive || nodes>5000) return 'sigma_graph';
  return 'ggraph_static';
}
