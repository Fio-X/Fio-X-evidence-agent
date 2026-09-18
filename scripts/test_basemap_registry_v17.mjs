#!/usr/bin/env node
import assert from 'node:assert/strict';import {listBasemaps,basemapAdequacy,getBasemap} from '../runtime/pi/cartography.mjs';
const maps=listBasemaps();assert.ok(maps.length>=3);assert.ok(getBasemap('naturalearth_admin0_110m'));assert.ok(getBasemap('naturalearth_admin0_50m'));assert.ok(getBasemap('gshhg_syros_i_local'));
const syros={west:24.94057,east:24.94375,south:37.43388,north:37.43858};
assert.equal(basemapAdequacy('naturalearth_admin0_110m',syros).adequate,false);assert.equal(basemapAdequacy('gshhg_syros_i_local',syros,'local_context').adequate,true);assert.equal(basemapAdequacy('gshhg_syros_i_local',syros,'local_port').adequate,false);
console.log(`basemap registry v1.7 PASS providers=${maps.length}`);
