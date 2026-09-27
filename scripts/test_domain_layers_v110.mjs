#!/usr/bin/env node
import assert from 'node:assert/strict';import {validateDomainLayer,assertCausalSupport,bindAnnotationToFeature} from '../runtime/pi/domain_layers.mjs';
const layer={schema_version:'1.0.0',id:'airport-context',layer_type:'airport',evidence_role:'contextual',source_url:'https://example.invalid/source',license:'test',content_hash:'a'.repeat(64),features:[{id:'MSP',lon:-93.22,lat:44.88}]};
assert.deepEqual(validateDomainLayer(layer,{story_time:'2025-02-05'}),[]);assert.throws(()=>assertCausalSupport(layer),/requires mechanistic/);const a=bindAnnotationToFeature({text:'destination airport'},layer,'MSP');assert.equal(a.domain_binding.feature_id,'MSP');
const causal={...layer,id:'reported-route-rule',evidence_role:'reported_causal'};assert.equal(assertCausalSupport(causal),true);
console.log('domain layers v1.10 PASS');
