import assert from 'node:assert/strict';
import { chooseGraphBackend } from '../runtime/graph/backend_registry.mjs';
assert.equal(chooseGraphBackend({nodes:120,edges:300}),'ggraph_static');
assert.equal(chooseGraphBackend({interactive:true,nodes:120,edges:300}),'sigma_graph');
assert.equal(chooseGraphBackend({spatial:true,nodes:500,edges:800}),'sfnetworks_spatial');
assert.equal(chooseGraphBackend({comparisonDense:true,nodes:2000,edges:40000}),'adjacency_matrix');
console.log('graph backend v1.20 PASS');
