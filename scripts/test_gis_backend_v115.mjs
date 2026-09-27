#!/usr/bin/env node
import assert from 'node:assert/strict';
import {chooseGisBackend} from '../runtime/gis/backend_registry.mjs';
assert.equal(chooseGisBackend({mode:'static',marks:15,labels:3}),'python_publication');
assert.equal(chooseGisBackend({mode:'interactive',marks:100000,interaction:true}),'maplibre_deckgl');
assert.equal(chooseGisBackend({marks:500000,density:true}),'datashader_density');
assert.equal(chooseGisBackend({labels:120}),'qgis_layout');
console.log('GIS backend router v1.15 PASS');
