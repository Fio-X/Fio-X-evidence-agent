#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PythonWarmWorkerClient } from '../runtime/visual/warm_worker_client.mjs';
const root=path.resolve('.'); const out='outputs/test-warm-worker-client-v131'; fs.rmSync(out,{recursive:true,force:true}); fs.mkdirSync(out,{recursive:true});
const fp='a'.repeat(64), eh='b'.repeat(64);
function request(i){ const od=`${out}/r${i}`; fs.mkdirSync(od,{recursive:true}); const p=`${od}/request.json`; fs.writeFileSync(p,JSON.stringify({backend:'python_publication',story_id:`warm-${i}`,recipe_path:'test',output_dir:od,semantic_fingerprint:fp,evidence_hashes:{'fixtures/realdata/nasa-gistemp-1980-2025.csv':eh},claim_ids:['claim:warm'],inputs:{table:'fixtures/realdata/nasa-gistemp-1980-2025.csv'},options:{renderer:'editorial_chart',chart_type:'line',x_field:'year',y_field:'anomaly_c',title:'Warm worker client'}},null,2)); return p; }
const w=new PythonWarmWorkerClient(); const ready=await w.ready; assert.equal(ready.runtime,'viz-python');
const a=await w.render('python_publication',request(1)); const b=await w.render('python_publication',request(2)); assert.equal(a.status,'PASS'); assert.equal(b.status,'PASS'); assert.equal(a.pid,b.pid); assert.ok(fs.existsSync(`${out}/r1/figure.svg`)); await w.close();
console.log('warm worker client v1.31: PASS');
