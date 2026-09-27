#!/usr/bin/env node
import assert from 'node:assert/strict';import {clusterFlowsGrid,trajectoryDensityGrid} from '../runtime/pi/flow_aggregation.mjs';
const rows=[
 {source_lon:0,source_lat:0,target_lon:20,target_lat:10,value:4,geometry_semantics:'abstract_od',unit:'x',time_window:'2025'},
 {source_lon:1,source_lat:1,target_lon:21,target_lat:11,value:6,geometry_semantics:'abstract_od',unit:'x',time_window:'2025'},
 {source_lon:60,source_lat:0,target_lon:80,target_lat:10,value:3,geometry_semantics:'abstract_od',unit:'x',time_window:'2025'}];
const c=clusterFlowsGrid(rows,{source_lon_field:'source_lon',source_lat_field:'source_lat',target_lon_field:'target_lon',target_lat_field:'target_lat',value_field:'value',cell_deg:5});assert.equal(c.length,2);assert.equal(c[0].value+c[1].value,13);
const d=trajectoryDensityGrid([{lon:1,lat:1},{lon:1.01,lat:1.01},{lon:2,lat:2}],{cell_deg:.1});assert.equal(d[0].count,2);
assert.throws(()=>clusterFlowsGrid([{...rows[0],unit:'x'},{...rows[1],unit:'y'}],{source_lon_field:'source_lon',source_lat_field:'source_lat',target_lon_field:'target_lon',target_lat_field:'target_lat',value_field:'value'}),/incompatible unit/);
console.log('flow aggregation v1.9 PASS');
