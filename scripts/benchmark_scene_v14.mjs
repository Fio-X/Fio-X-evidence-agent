#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { composeInfographicBundle } from '../runtime/pi/infographic.mjs';

const claim='claim-bench';
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 420"><title>Benchmark</title><desc>Benchmark visual</desc><rect width="800" height="420" fill="#eee"/><path d="M40 340 L220 260 L400 280 L600 140 L760 90" fill="none" stroke="#333" stroke-width="5"/></svg>';
const asset={desktopSvg:svg,mobileSvg:svg,manifest:{claim_id:claim,source_note:'benchmark',chart_type:'line',alt:'Benchmark visual for deterministic scene layout performance.'},critic:{passed:true,score:100}};
const assets={}; for(let i=0;i<3;i++) assets[`visualizations/v${i}.json`]=asset;
const modules=[]; const scenes=[];
for(let i=0;i<3;i++){
  const anchor=`v${i}`; modules.push({id:anchor,type:'visual',span:'two_thirds',manifest_ref:`visualizations/v${i}.json`,story_role:i===0?'evidence':'context',priority:i===0?1:2,emphasis:i===0?'hero':'primary'});
  const side=[];
  for(let j=0;j<3;j++){
    const id=`s${i}-${j}`; side.push(id);
    if(j===0) modules.push({id,type:'hero_stat',span:'third',value:String(10+i+j),label:`Benchmark statistic ${i}-${j}`,claim_id:claim,story_role:'hook',priority:2,emphasis:'secondary'});
    else modules.push({id,type:'text',span:'third',heading:`Context ${i}-${j}`,body:'A compact benchmark text module used only to exercise deterministic scene placement.',claim_ids:[claim],story_role:'explanation',priority:3,emphasis:'support'});
  }
  scenes.push({id:`scene-${i}`,pattern:i%2?'hero_with_rail':'hero_sidecar_stack',anchor_module_id:anchor,sidecar_module_ids:side,shared_source_scope:true});
}
const spec={schema_version:'1.3.0',title:'Scene benchmark',dek:'Twelve scene elements exercise bounded deterministic art-direction geometry.',alt:'Synthetic scene benchmark with three anchors and nine sidecars.',layout:'feature',complexity_budget:'medium',intent:'Benchmark scene layout.',primary_message:'Bounded SceneGraph composition remains cheap.',story_arc:'explain',audience:'specialist',quality_target:'publishable',competition_profile:'editorial',scene_graph:{schema_version:'0.1.0',scenes},modules};
const values=[]; const iterations=1200;
for(let i=0;i<iterations;i++){const t=performance.now();composeInfographicBundle(spec,assets);values.push(performance.now()-t);}
values.sort((a,b)=>a-b); const pick=q=>values[Math.min(values.length-1,Math.floor(values.length*q))];
const report={iterations,scene_elements:12,p50_ms:pick(0.5),p95_ms:pick(0.95),max_ms:values.at(-1),budget_p95_ms:5}; report.passed=report.p95_ms<=report.budget_p95_ms;
console.log(JSON.stringify(report,null,2)); if(!report.passed) process.exit(1);
