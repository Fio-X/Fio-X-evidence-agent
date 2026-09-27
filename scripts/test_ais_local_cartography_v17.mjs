#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {getBasemap} from '../runtime/pi/cartography.mjs';
import {lintVizSpec,renderVizBundle,critiqueViz} from '../runtime/pi/viz.mjs';

const r=JSON.parse(await readFile(new URL('../fixtures/v16-movement/ais-syros-sampled.json',import.meta.url),'utf8'));
const claim='claim-ais-syros-v17';
const rows=[{source:'first retained AIS point',target:'last retained AIS point',value:1,trajectory_points:JSON.stringify(r.points)}];
const basemap=getBasemap('gshhg_syros_i_local');
assert.ok(basemap,'local Syros basemap must be registered');
const spec={
  schema_version:'1.1.0',reader_task:'spatial',visual_family:'spatial',data_topology:'geo_edges',chart_type:'cartographic_flow_map',
  title:'A local AIS track gains coastline context at the scale it needs',
  subtitle:'Selected AIS positions around Syros, shown against a provenance-bound local coastline extract',
  alt:'Observed AIS trajectory around Syros rendered against an intermediate-resolution GSHHG coastline extract. The local island shape is visible at the same fitted extent as the trajectory.',
  source_note:'ITSLab-UAegean/vesseltrack-tools sample dataset; GSHHG 2.3.6 coastline via basemap-data 2.0.0.',
  note:'Solid geometry follows selected exact AIS observations. The local coastline is a deterministic extract from GSHHG and is used only as geographic context.',
  claim_id:claim,sql:'fixture:ais-syros-sampled.json',unit:'trajectory',source_field:'source',target_field:'target',value_field:'value',
  geometry_semantics:'observed_trajectory',geometry_crs:'EPSG:4326',projection:'natural_earth_1',
  basemap_id:basemap.id,basemap_source_url:basemap.source_url,basemap_license:basemap.license,basemap_content_hash:basemap.content_hash,
  route_provenance_note:'ITSLab-UAegean/vesseltrack-tools sample, selected exact AIS rows from real-movement-based Syros test data',
  trajectory_points_field:'trajectory_points',map_task:'local_context',extent_mode:'data',extent_padding_ratio:.12,extent_min_span_deg:.012,reference_path:'none',locator_inset:true,aggregation_policy:'none',annotations:[]
};
const lint=lintVizSpec(spec,rows,{verified_claim_ids:[claim]});
assert.equal(lint.passed,true,lint.blockers.join(' | '));
const b=renderVizBundle(spec,rows),c=critiqueViz(spec,rows,lint,b.desktop);
assert.equal(c.passed,true,JSON.stringify(c));
assert.equal(c.issues.some(i=>i.code==='basemap_detail_mismatch'),false,JSON.stringify(c));
const out=new URL('../outputs/v17-ais/',import.meta.url);await mkdir(out,{recursive:true});
await writeFile(new URL('syros-local-trajectory.svg',out),b.desktop);await writeFile(new URL('syros-local-trajectory.mobile.svg',out),b.mobile);
console.log(`AIS local cartography v1.7 PASS critic=${c.score} basemap=${basemap.id} hash=${basemap.content_hash}`);
