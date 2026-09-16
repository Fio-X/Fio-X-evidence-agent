import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {BASEMAP_CONTENT_HASH,BASEMAP_ID,BASEMAP_LICENSE,BASEMAP_SOURCE_URL} from '../runtime/pi/cartography.mjs';
import {renderVizBundle} from '../runtime/pi/viz.mjs';

const record=JSON.parse(readFileSync(new URL('../fixtures/v16-movement/adsb-dal1812-sampled.json',import.meta.url),'utf8'));
const points=record.points;
const mapRows=[{source:'Observed coverage begins',target:'MSP / ground',value:1,trajectory_points:JSON.stringify(points)}];
const mapSpec={schema_version:'1.1.0',reader_task:'spatial',visual_family:'spatial',data_topology:'geo_edges',chart_type:'cartographic_flow_map',title:'Trajectory benchmark',subtitle:'Observed path with a preserved gap',alt:'Benchmark observed trajectory.',source_note:'xoolive/traffic readsb fixture.',note:'Observed geometry with source gap.',claim_id:'claim-bench-v16',sql:'fixture',unit:'trajectory',source_field:'source',target_field:'target',value_field:'value',geometry_semantics:'observed_trajectory',geometry_crs:'EPSG:4326',projection:'natural_earth_1',basemap_id:BASEMAP_ID,basemap_source_url:BASEMAP_SOURCE_URL,basemap_license:BASEMAP_LICENSE,basemap_content_hash:BASEMAP_CONTENT_HASH,route_provenance_note:'xoolive/traffic readsb public sample',trajectory_points_field:'trajectory_points',extent_mode:'data',extent_padding_ratio:.16,reference_path:'great_circle',locator_inset:true,aggregation_policy:'none',direct_labels:true,annotations:[]};
const profile=points.map(p=>({elapsed_min:p.elapsed_s/60,altitude_ft:p.altitude_ft,ground_speed_kt:p.ground_speed_kt,segment:p.segment}));
const profileSpec={schema_version:'1.1.0',reader_task:'change',visual_family:'temporal',data_topology:'tabular',chart_type:'trajectory_profile',title:'Profile benchmark',subtitle:'Altitude and speed share elapsed time',alt:'Benchmark trajectory profile.',source_note:'xoolive/traffic readsb public sample.',note:'Observed samples.',claim_id:'claim-bench-v16',sql:'fixture',unit:'trajectory state',x_field:'elapsed_min',altitude_field:'altitude_ft',speed_field:'ground_speed_kt',segment_field:'segment',altitude_unit:'ft',speed_unit:'kt',annotations:[]};

function bench(label,spec,rows,iterations,budget){for(let i=0;i<25;i++)renderVizBundle(spec,rows);const times=[];for(let i=0;i<iterations;i++){const t=performance.now();renderVizBundle(spec,rows);times.push(performance.now()-t);}times.sort((a,b)=>a-b);const q=p=>times[Math.min(times.length-1,Math.floor((times.length-1)*p))];const r={label,iterations,p50_ms:q(.5),p95_ms:q(.95),max_ms:times.at(-1),budget_p95_ms:budget};console.log(JSON.stringify(r));if(r.p95_ms>budget)process.exitCode=1;return r;}
bench('observed-trajectory cartographic bundle',mapSpec,mapRows,300,10);
bench('trajectory profile bundle',profileSpec,profile,500,5);
