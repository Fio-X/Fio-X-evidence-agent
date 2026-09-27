#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSemanticContract } from '../runtime/visual/semantic_contract.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const a=buildSemanticContract(root,{evidence_paths:['fixtures/realdata/nasa-gistemp-1980-2025.csv'],claim_ids:['claim:a'],semantics:{x:'year',y:'anomaly_c',unit:'degC'}});
const b=buildSemanticContract(root,{semantics:{unit:'degC',y:'anomaly_c',x:'year'},claim_ids:['claim:a'],evidence_paths:['fixtures/realdata/nasa-gistemp-1980-2025.csv']});
assert.equal(a.fingerprint,b.fingerprint);
assert.equal(a.evidence.length,1);
assert.match(a.fingerprint,/^[0-9a-f]{64}$/);

const c=buildSemanticContract(root,{
  evidence_paths:['fixtures/realdata/nasa-gistemp-1980-2025.csv'],claim_ids:['claim:a'],semantics:{x:'year',y:'anomaly_c',unit:'degC'},
  measure_semantics:[
    {id:'recent',phenomenon:'temperature_anomaly',unit:'degC',measure_kind:'level',temporal_basis:{type:'period'},observation_status:'observed',aggregation:'annual',value:1.2},
    {id:'baseline',phenomenon:'temperature_anomaly',unit:'degC',measure_kind:'level',temporal_basis:{type:'period'},observation_status:'observed',aggregation:'annual',value:0.6}
  ],
  claim_spec:{claim_id:'claim:a',relation:'change',reader_task:'magnitude_of_change',target_measure:'recent',baseline_measure:'baseline',derived_metric:'absolute_change'}
});
assert.equal(c.schema_version,'1.1.0');
assert.equal(c.measure_semantics.length,2);
assert.equal(c.claim_spec.relation,'change');

console.log('semantic contract v1.27: PASS');
