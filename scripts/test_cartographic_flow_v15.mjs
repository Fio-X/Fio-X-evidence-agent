import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASEMAP_CONTENT_HASH, BASEMAP_ID, BASEMAP_LICENSE, BASEMAP_SOURCE_URL,
  createProjection, greatCirclePoints
} from '../runtime/pi/cartography.mjs';
import { validateVizSpec, lintVizSpec, critiqueViz, renderVizBundle } from '../runtime/pi/viz.mjs';

const ROOT=new URL('..', import.meta.url).pathname;
const OUT=join(ROOT,'outputs','v15-carto'); mkdirSync(OUT,{recursive:true});

function csv(path){
  const [head,...lines]=readFileSync(path,'utf8').trim().split(/\r?\n/); const fields=head.split(',');
  return lines.map(line=>{const values=line.split(',');return Object.fromEntries(fields.map((f,i)=>[f,/^-?\d+(\.\d+)?$/.test(values[i])?Number(values[i]):values[i]]));});
}
function assert(cond,msg){if(!cond) throw new Error(msg);}
function base(title,subtitle,unit){return {
  schema_version:'1.0.0', chart_type:'cartographic_flow_map', reader_task:'flow', visual_family:'spatial', data_topology:'geo_edges',
  title, subtitle, unit, claim_id:'claim-carto-v15', sql:'SELECT * FROM cartographic_flow_fixture', alt:`${title}. ${subtitle} Cartographic flow visualization with source and route semantics disclosure.`,
  source_note:'Published source; see case-specific fixture metadata.', note:'Arcs encode relationships and do not show physical tanker, pipeline, aircraft, vessel, or financial infrastructure routes.',
  value_field:'value', source_field:'source', target_field:'target', geometry_crs:'EPSG:4326', projection:'natural_earth_1', basemap_id:BASEMAP_ID,
  basemap_source_url:BASEMAP_SOURCE_URL, basemap_license:BASEMAP_LICENSE, basemap_content_hash:BASEMAP_CONTENT_HASH, aggregation_policy:'none'
};}
function exercise(spec,rows,name){
  const validation=validateVizSpec(spec); assert(validation.length===0,`${name} validation failed: ${validation.join(' | ')}`);
  const lint=lintVizSpec(spec,rows,{verified_claim_ids:['claim-carto-v15']}); assert(lint.passed,`${name} lint failed: ${lint.blockers.join(' | ')}`);
  const bundle=renderVizBundle(spec,rows); const critic=critiqueViz(spec,rows,lint,bundle.desktop); assert(critic.passed,`${name} critic failed: ${JSON.stringify(critic.issues)}`);
  assert(bundle.desktop.includes('data-role="cartographic-basemap"'),`${name} missing basemap`);
  assert(bundle.desktop.includes(`data-geometry-semantics="${spec.geometry_semantics}"`),`${name} missing semantics marker`);
  assert(bundle.desktop.includes('data-role="cartographic-disclosure"'),`${name} missing semantics disclosure`);
  writeFileSync(join(OUT,`${name}.svg`),bundle.desktop); writeFileSync(join(OUT,`${name}.mobile.svg`),bundle.mobile);
  return {lint,critic,bundle};
}

// Projection regression: the world must be centered and approximately symmetric after the Natural Earth I formula fix.
const p=createProjection('natural_earth_1',60,980,100,500), west=p(-180,0),zero=p(0,0),east=p(180,0);
assert(Math.abs(zero.x-520)<1,`projection center drifted: ${zero.x}`);
assert(Math.abs((zero.x-west.x)-(east.x-zero.x))<1,`projection lost east-west symmetry: ${JSON.stringify({west,zero,east})}`);
assert(east.x-west.x>700,'Natural Earth world coverage unexpectedly compressed');
const gc=greatCirclePoints(-73.7781,40.6413,103.9940,1.3644,32); assert(gc.length===33&&gc.every(([lon,lat])=>Number.isFinite(lon)&&Number.isFinite(lat)),'great-circle interpolation invalid');

const eia=csv(join(ROOT,'fixtures','v09-realdata','eia-us-crude-imports-2024.csv')).map(r=>({source:r.country,target:r.target,source_lat:r.source_lat,source_lon:r.source_lon,target_lat:r.target_lat,target_lon:r.target_lon,value:r.thousand_bpd}));
const eiaSpec={...base('U.S. crude imports are anchored by Canada','Selected origin-destination relationships, average thousand barrels per day, 2024','thousand b/d'),source_note:'U.S. Energy Information Administration, Petroleum & Other Liquids, selected 2024 crude-oil imports.',geometry_semantics:'abstract_od',source_lat_field:'source_lat',source_lon_field:'source_lon',target_lat_field:'target_lat',target_lon_field:'target_lon'};
const eiaResult=exercise(eiaSpec,eia,'eia-abstract');
assert(eiaResult.bundle.desktop.includes('do not represent physical routes'),'EIA OD disclosure missing');

const rem=csv(join(ROOT,'fixtures','v15-cartographic-flow','world-bank-remittance-corridors-2021.csv')).map(r=>({source:r.source,target:r.target,source_lat:r.source_lat,source_lon:r.source_lon,target_lat:r.target_lat,target_lon:r.target_lon,value:r.usd_billion}));
const remSpec={...base('Four of the largest estimated remittance corridors in 2021','Published World Bank bilateral corridor estimates, billions of U.S. dollars','$bn'),source_note:'World Bank, Bilateral Remittance Matrix (new), published 2022; 2021 corridor estimates.',geometry_semantics:'abstract_od',source_lat_field:'source_lat',source_lon_field:'source_lon',target_lat_field:'target_lat',target_lon_field:'target_lon',note:'Arcs encode estimated bilateral remittance relationships; they do not represent physical routes or money-transfer infrastructure.'};
exercise(remSpec,rem,'world-bank-remittance-2021');

const contract=JSON.parse(readFileSync(join(ROOT,'fixtures','v15-cartographic-flow','route-semantics-contract.json'),'utf8')).map(r=>({source:'A',target:'B',value:r.amount,geometry:JSON.stringify(r.geometry),observed_at:r.observed_at}));
for(const semantics of ['verified_route','observed_trajectory','network_constrained']){
  const spec={...base(`${semantics} contract`,`Geometry semantics contract regression`,'units'),geometry_semantics:semantics,route_geometry_field:'geometry',route_provenance_note:'v1.5 deterministic contract fixture; geometry is illustrative and not published as a real-world route.',note:'Contract-only geometry. Do not interpret this fixture as a real physical route.',...(semantics==='observed_trajectory'?{time_field:'observed_at'}:{})};
  exercise(spec,contract,`contract-${semantics}`);
}
const gcRows=[{source:'JFK',target:'SIN',source_lat:40.6413,source_lon:-73.7781,target_lat:1.3644,target_lon:103.9940,value:1}];
const gcSpec={...base('Great-circle reference contract','Geodesic baseline between two coordinate anchors','reference'),geometry_semantics:'great_circle_reference',source_lat_field:'source_lat',source_lon_field:'source_lon',target_lat_field:'target_lat',target_lon_field:'target_lon',note:'Line is a geodesic reference path and does not represent a filed or observed aircraft route.'};
const gcResult=exercise(gcSpec,gcRows,'contract-great-circle'); assert(gcResult.bundle.desktop.includes('do not represent filed or observed routes'),'great-circle disclosure missing');

const bad={...gcSpec,geometry_semantics:'observed_trajectory'}; assert(validateVizSpec(bad).some(x=>x.includes('route_geometry_field')),'observed trajectory without route geometry did not fail');
const observedWithoutTime={...base('Observed trajectory missing time contract','Should fail','units'),geometry_semantics:'observed_trajectory',route_geometry_field:'geometry',route_provenance_note:'contract fixture'}; assert(validateVizSpec(observedWithoutTime).some(x=>x.includes('time_field')),'observed trajectory without time_field did not fail');
const badHash={...eiaSpec,basemap_content_hash:'0'.repeat(64)}; assert(validateVizSpec(badHash).some(x=>x.includes('basemap_content_hash')),'basemap hash mutation did not fail');
const tooMany=Array.from({length:81},(_,i)=>({source:`S${i}`,target:'T',source_lat:0,source_lon:-170+i*4,target_lat:10,target_lon:0,value:81-i}));
const denseLint=lintVizSpec(eiaSpec,tooMany,{verified_claim_ids:['claim-carto-v15']}); assert(!denseLint.passed&&denseLint.blockers.some(x=>x.includes('aggregation_policy=top_n')),'81-route unaggregated map did not fail closed');
const topSpec={...eiaSpec,aggregation_policy:'top_n',top_n:20}; assert(lintVizSpec(topSpec,tooMany,{verified_claim_ids:['claim-carto-v15']}).passed,'top_n aggregation did not recover dense route fixture');

console.log('cartographic flow v1.5 PASS');
console.log(`basemap sha256 ${BASEMAP_CONTENT_HASH}`);
console.log(`EIA critic ${eiaResult.critic.score}/100; World Bank corridors ${rem.length}`);
