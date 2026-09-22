#!/usr/bin/env node
import assert from 'node:assert/strict';
import {resolveEditorialStyle,validateStyleRegistry} from '../runtime/visual/style_mapping.mjs';
assert.deepEqual(validateStyleRegistry(),[]);
const cases=[
 [['trend','comparison'],['tabular'],[],'analytical_precision'],
 [['flow','mechanism'],['flow_edges'],[],'systems_explainer'],
 [['network','outcome'],['graph_edges'],[],'investigative_network'],
 [['uncertainty','context'],['tabular'],[],'uncertainty_forecast'],
 [['spatial','distribution'],['geography'],[],'spatial_monitor'],
 [['spatial','context'],['geography'],['scientific_spatial'],'nature_scientific_map']
];
for(const [dimensions,topologies,signals,expected] of cases){const r=resolveEditorialStyle({dimensions,topologies,signals});assert.equal(r.status,'PASS',JSON.stringify(r));assert.equal(r.profile,expected,JSON.stringify(r));assert.ok(r.tokens.font_body);assert.ok(r.tokens.density);assert.ok(r.tokens.annotation);}
const blocked=resolveEditorialStyle({requested:'investigative_network',dimensions:['uncertainty'],topologies:['tabular']});assert.equal(blocked.status,'BLOCK');
const nature=resolveEditorialStyle({requested:'nature_scientific_map',dimensions:['spatial','uncertainty'],topologies:['geography']});assert.equal(nature.status,'PASS');assert.equal(nature.tokens.color_strategy,'restrained');assert.equal(nature.tokens.scale_semantics,'required');
const japanese=resolveEditorialStyle({requested:'japanese_editorial',dimensions:['flow','network'],topologies:['flow_edges','graph_edges']});assert.equal(japanese.status,'PASS');assert.equal(japanese.tokens.geometry,'asymmetric_editorial');assert.equal(japanese.tokens.composition,'asymmetric_editorial');
console.log(JSON.stringify({status:'PASS',profiles:[...cases.map(x=>x[3]),japanese.profile],negative:blocked.reasons},null,2));
