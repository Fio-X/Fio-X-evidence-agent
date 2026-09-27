import assert from 'node:assert/strict';
import { buildBackendCommand } from '../runtime/visual/backend_executor.mjs';
for(const [backend,needle] of [['python_publication','python_publication_request.py'],['qgis_cartography','qgis_publication_map.py'],['pygmt_scientific','pygmt_publication_map.py'],['datashader_density','datashader_density.py'],['adjacency_matrix','python_adjacency_matrix.py'],['r_editorial','r_publication_request.R'],['ggraph_static','r_ggraph.R'],['sfnetworks_spatial','r_sfnetworks.R'],['sigma_graph','render_request.mjs']]){
  const c=buildBackendCommand(backend,{requestPath:'req.json'}); assert.ok(c.args.join(' ').includes(needle),backend);
}
console.log('backend executor v1.18 PASS');
