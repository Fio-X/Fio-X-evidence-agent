import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compileWebGeoScene } from '../runtime/web/maplibre_deckgl.mjs';
const pkg=JSON.parse(fs.readFileSync(new URL('../runtime/web/package.json',import.meta.url),'utf8'));
for(const [k,v] of Object.entries({'sigma':'3.0.3','graphology':'0.26.0','maplibre-gl':'6.9.0','deck.gl':'9.4.0','echarts':'6.0.0','d3':'7.9.0','vega-lite':'6.4.3'})) assert.equal(pkg.dependencies[k],v);
const sigma=fs.readFileSync(new URL('../runtime/web/sigma_graph.mjs',import.meta.url),'utf8'); assert.ok(!sigma.includes('Math.random(')); assert.ok(sigma.includes('deterministicPosition'));
const scene=compileWebGeoScene({view:{center:[25,37.4],zoom:9},layers:[{id:'trips',type:'TripsLayer',data_ref:'data/trips.parquet',pickable:true}],data_hashes:{trips:'abc'}});
assert.equal(scene.renderer,'maplibre_deckgl'); assert.equal(scene.deck_layers[0].type,'TripsLayer');
console.log('web runtime contract v1.20 PASS');
