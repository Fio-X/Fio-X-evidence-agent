import assert from 'node:assert/strict';
import { chooseBackend } from '../runtime/visual/backend_router_v2.mjs';
const all=Object.fromEntries(['viz-python','viz-r','viz-qgis','viz-pygmt','viz-density','viz-web','viz-browser','viz-sigma','viz-map','viz-d3'].map(x=>[x,{status:'AVAILABLE'}]));
const mk=(patch={})=>({schema_version:'2.0.0',analytical_job:'geography',artifact_mode:'static_editorial',story_family:'general_map',data_profile:{mark_count:1000},geography:{enabled:true,scale:'regional'},network:{enabled:false},annotation:{label_count:10},delivery:{print:true,interactive:false},backend_hints:{},...patch});
assert.equal(chooseBackend(mk({geography:{enabled:true,scale:'local'},annotation:{label_count:80}}),{health:all}).backend,'qgis_cartography');
assert.equal(chooseBackend(mk({story_family:'bathymetry',geography:{enabled:true,scale:'regional',bathymetry:true}}),{health:all}).backend,'pygmt_scientific');
assert.equal(chooseBackend(mk({story_family:'ais_density',data_profile:{mark_count:2_000_000}}),{health:all}).backend,'datashader_density');
assert.equal(chooseBackend(mk({analytical_job:'network',artifact_mode:'interactive',geography:{enabled:true,scale:'regional'},network:{enabled:true},delivery:{print:false,interactive:true}}),{health:all}).backend,'sigma_graph');
assert.equal(chooseBackend(mk({analytical_job:'network',story_family:'dense_graph',data_profile:{mark_count:0,node_count:2000,edge_count:20000},geography:{enabled:false},network:{enabled:true,comparison_dense:true},delivery:{print:true,interactive:false}}),{health:all}).backend,'adjacency_matrix');
assert.equal(chooseBackend(mk({artifact_mode:'interactive',story_family:'ais_live',data_profile:{mark_count:5_000_000},delivery:{print:false,interactive:true}}),{health:all}).backend,'maplibre_deckgl');

const tabular={schema_version:'2.0.0',analytical_job:'comparison',artifact_mode:'print',story_family:'generic_print_comparison',data_profile:{mark_count:8},geography:{enabled:false},network:{enabled:false},annotation:{label_count:8},delivery:{print:true,interactive:false,vector_required:true},backend_hints:{}};
const tabularPlan=chooseBackend(tabular,{health:all});
assert.ok(!tabularPlan.ranked.some(x=>x.backend==='adjacency_matrix'));
assert.ok(tabularPlan.hard_filter.rejected.adjacency_matrix.some(x=>x.startsWith('topology:')));

console.log('backend router v1.23 PASS');
