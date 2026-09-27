export { BACKENDS as GIS_BACKENDS, rankBackends, chooseBackend } from '../visual/backend_router_v2.mjs';

export function chooseGisBackend({mode='static',marks=0,labels=0,interaction=false,terrain=false,density=false}={}){
  if(interaction && marks>10000) return 'maplibre_deckgl';
  if(density || marks>=1000000) return 'datashader_density';
  if(terrain) return 'pygmt_publication';
  if(labels>=40) return 'qgis_layout';
  return 'python_publication';
}
