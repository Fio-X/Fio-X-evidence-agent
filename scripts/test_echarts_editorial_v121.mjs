import assert from 'node:assert/strict';
import { compileEchartsEditorialScene } from '../runtime/web/echarts_editorial.mjs';
const scene=compileEchartsEditorialScene({dataPath:'fixtures/realdata/eia-us-energy-flow-2024.csv',options:{chart_type:'sankey',source_field:'source',target_field:'target',value_field:'quadrillion_btu',title:'U.S. energy flow'}});
assert.equal(scene.renderer,'echarts'); assert.equal(scene.option.series[0].type,'sankey');
assert.equal(scene.option.series[0].links.length,11); assert.equal(scene.option.animation,false);
const scene2=compileEchartsEditorialScene({dataPath:'fixtures/realdata/eia-us-energy-flow-2024.csv',options:{chart_type:'sankey',source_field:'source',target_field:'target',value_field:'quadrillion_btu',title:'U.S. energy flow'}});
assert.deepEqual(scene,scene2);
console.log('echarts editorial v1.21 PASS');
