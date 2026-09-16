#!/usr/bin/env node
import assert from 'node:assert/strict';
import {compileVisualRecipe} from '../runtime/gis/ai_visual_compiler.mjs';
let p=compileVisualRecipe({analytical_job:'flow',mode:'static',geographic:true,language:'python',marks:15000,labels:20});
assert.equal(p.geometry_backend,'geopandas_shapely_PROJ');assert.equal(p.render_backend,'python_publication');assert.equal(p.data_bearing_pixels,'deterministic_only');
p=compileVisualRecipe({analytical_job:'flow',mode:'static',geographic:true,language:'r',marks:500000,density:true,labels:10});
assert.equal(p.render_backend,'datashader_density');assert.equal(p.geometry_backend,'sf_GEOD_GEOS_PROJ');
p=compileVisualRecipe({analytical_job:'geography',mode:'static',geographic:true,marks:5000,labels:150});
assert.equal(p.render_backend,'qgis_layout');assert.equal(p.generated_imagery_policy,'disabled');
p=compileVisualRecipe({analytical_job:'geography',mode:'interactive',geographic:true,interaction:true,marks:100000,generated_imagery:true});
assert.equal(p.render_backend,'maplibre_deckgl');assert.equal(p.generated_imagery_policy,'context_only_no_data_geometry');
console.log('AI visual compiler v1.15 PASS');
