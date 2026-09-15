import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,'../..');

export function loadRuntimeManifests(root=ROOT){
  const dir=path.join(root,'runtimes');
  if(!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir,{withFileTypes:true})
    .filter(d=>d.isDirectory() && fs.existsSync(path.join(dir,d.name,'manifest.json')))
    .map(d=>JSON.parse(fs.readFileSync(path.join(dir,d.name,'manifest.json'),'utf8')))
    .sort((a,b)=>a.id.localeCompare(b.id));
}

export function capabilityIndex(manifests=loadRuntimeManifests()){
  const out=new Map();
  for(const m of manifests){
    for(const cap of m.capabilities){
      if(!out.has(cap)) out.set(cap,[]);
      out.get(cap).push(m.id);
    }
  }
  return out;
}

export function runtimeForBackend(backend){
  const map={
    python_publication:'viz-python',r_editorial:'viz-r',ggraph_static:'viz-r',sfnetworks_spatial:'viz-r',
    qgis_cartography:'viz-qgis',pygmt_scientific:'viz-pygmt',datashader_density:'viz-density',
    maplibre_deckgl:'viz-map',sigma_graph:'viz-sigma',echarts_editorial:'viz-web',d3_editorial:'viz-d3',plotly_browser:'viz-browser',canvas_network:'viz-browser',networkx_graph:'viz-browser',adjacency_matrix:'viz-python'
  };
  return map[backend] ?? null;
}
