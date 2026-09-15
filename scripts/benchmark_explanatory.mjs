#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { lintExplanatorySpec, renderExplanatoryBundle, critiqueExplanatory } from '../runtime/pi/explanatory.mjs';
const claim='claim-explainer-benchmark';
const spec={schema_version:'0.1.0',view:'cutaway',not_to_scale:true,title:'Explanatory graphic benchmark',subject:'Synthetic layered system',subtitle:'Deterministic semantic illustration performance fixture',alt:'A schematic cutaway with six labeled layers is used to benchmark deterministic explanatory graphics.',source_note:'Synthetic benchmark',parts:Array.from({length:6},(_,i)=>({id:`p${i}`,label:`Layer ${i+1}`,detail:`Synthetic explanatory detail ${i+1}`,weight:i%2?1.2:1,claim_ids:[claim]})),relationships:[]};
const lint=lintExplanatorySpec(spec,{verified_claim_ids:[claim]});if(!lint.passed)throw new Error(lint.blockers.join(' | '));
for(let i=0;i<30;i++){const b=renderExplanatoryBundle(spec);critiqueExplanatory(spec,b);}
const times=[],N=400;for(let i=0;i<N;i++){const t0=performance.now();const b=renderExplanatoryBundle(spec);critiqueExplanatory(spec,b);times.push(performance.now()-t0);}times.sort((a,b)=>a-b);const pct=p=>times[Math.min(times.length-1,Math.floor((times.length-1)*p))];const result={iterations:N,p50_ms:pct(.5),p95_ms:pct(.95),max_ms:times.at(-1),budget_p95_ms:8,passed:pct(.95)<8};console.log(JSON.stringify(result,null,2));if(!result.passed)process.exit(2);
