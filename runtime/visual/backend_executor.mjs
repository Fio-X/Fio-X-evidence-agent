export function buildBackendCommand(backend,{requestPath,outputDir='outputs/visual-compiler'}={}){
  if(!requestPath) throw new Error(`${backend} requires requestPath`);
  const common={cwd:process.cwd(),backend,outputDir};
  const py={
    python_publication:'runtime/gis/python_publication_request.py',
    qgis_cartography:'runtime/gis/qgis_publication_map.py',
    pygmt_scientific:'runtime/gis/pygmt_publication_map.py',
    datashader_density:'runtime/gis/datashader_density.py',
    adjacency_matrix:'runtime/graph/python_adjacency_matrix.py'
  };
  if(py[backend]) return {...common,command:'python3',args:[py[backend],'--request',requestPath]};
  if(backend==='networkx_graph') return {...common,command:'python3',args:['runtime/browser/networkx_analyze.py','--request',requestPath,'--output',`${outputDir}/networkx-analysis.json`]};
  if(backend==='plotly_browser') return {...common,command:'python3',args:['runtime/browser/plotly_render.py','--request',requestPath,'--output-dir',outputDir]};
  if(backend==='canvas_network') return {...common,command:'node',args:['runtime/web/render_request.mjs','--request',requestPath]};
  if(backend==='r_editorial') return {...common,command:'Rscript',args:['runtime/gis/r_publication_request.R',requestPath]};
  if(backend==='ggraph_static') return {...common,command:'Rscript',args:['runtime/graph/r_ggraph.R',requestPath]};
  if(backend==='sfnetworks_spatial') return {...common,command:'Rscript',args:['runtime/graph/r_sfnetworks.R',requestPath]};
  if(backend==='maplibre_deckgl'||backend==='sigma_graph'||backend==='echarts_editorial'||backend==='d3_editorial') return {...common,command:'node',args:['runtime/web/render_request.mjs','--request',requestPath]};
  throw new Error(`backend ${backend} has no command adapter`);
}
