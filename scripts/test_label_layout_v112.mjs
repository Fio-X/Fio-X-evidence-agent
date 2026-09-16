#!/usr/bin/env node
import assert from 'node:assert/strict';import {layoutLabels} from '../runtime/pi/label_layout.mjs';
const labels=[{id:'a',text:'Alpha',x:100,y:100,priority:10,preferred:'right'},{id:'b',text:'Beta',x:102,y:102,priority:8},{id:'c',text:'Gamma',x:104,y:104,priority:1}];
const r=layoutLabels(labels,{bounds:{left:0,top:0,right:240,bottom:180},obstacles:[{x:115,y:80,w:60,h:40,weight:90}],max_labels:2});assert.equal(r.placed.length,2);assert.equal(r.suppressed.length,1);assert.equal(r.suppressed[0].reason,'density_budget');assert.ok(r.placed.every(p=>Number.isFinite(p.cost)));console.log('label layout v1.12 PASS',r.diagnostics);
