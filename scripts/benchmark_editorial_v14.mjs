#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { scoreSemanticNovelty } from '../runtime/pi/editorial.mjs';
const dimensions=['trend','rank','spatial','mechanism','comparison','distribution','uncertainty','human_scale','method','context'];
const modules=Array.from({length:30},(_,i)=>({id:`m${i}`,reader_question_id:`q${Math.floor(i/2)}`,claim_set:[`c${Math.floor(i/2)}`,`c${i}`],new_information:`Module ${i} adds evidence dimension ${dimensions[i%dimensions.length]} with unique observation ${i}.`,explanatory_dimension:dimensions[i%dimensions.length],dependency_on:i?[`m${i-1}`]:[]}));
for(let i=0;i<50;i++) scoreSemanticNovelty({concept_ref:'benchmark',modules});
const times=[];for(let i=0;i<2000;i++){const t0=performance.now();scoreSemanticNovelty({concept_ref:'benchmark',modules});times.push(performance.now()-t0);}times.sort((a,b)=>a-b);const pct=p=>times[Math.floor((times.length-1)*p)];const result={iterations:2000,module_count:30,p50_ms:pct(.5),p95_ms:pct(.95),max_ms:times.at(-1),budget_p95_ms:5,passed:pct(.95)<5};console.log(JSON.stringify(result,null,2));if(!result.passed)process.exit(2);
