#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { composeInfographicBundle, critiqueInfographic, lintInfographicSpec } from '../runtime/pi/infographic.mjs';

const desktop=await readFile(new URL('../fixtures/newsroom-viz-v0.5.svg',import.meta.url),'utf8');
const mobile=await readFile(new URL('../fixtures/newsroom-viz-v0.5.mobile.svg',import.meta.url),'utf8');
const claim='claim-benchmark';
const assets={
 'visualizations/a.json':{desktopSvg:desktop,mobileSvg:mobile,manifest:{claim_id:claim,source_note:'Regression fixture',chart_type:'small_multiples'},critic:{passed:true,score:100}},
 'visualizations/b.json':{desktopSvg:desktop,mobileSvg:mobile,manifest:{claim_id:claim,source_note:'Regression fixture',chart_type:'sankey'},critic:{passed:true,score:100}},
};
const spec={
 schema_version:'1.1.0',kicker:'BENCHMARK',title:'A magazine infographic performance regression fixture',
 dek:'Two responsive upstream visuals, two hero statistics and explanatory copy are composed into one editorial page.',
 alt:'A benchmark magazine infographic containing multiple responsive modules.',layout:'feature',complexity_budget:'medium',
 intent:'Benchmark award-informed layout generation, ranking and critique without model or database latency.',
 primary_message:'Candidate layout generation and rubric critique should remain a negligible deterministic cost.',
 story_arc:'explain',audience:'informed',quality_target:'award',
 modules:[
  {id:'section',type:'section_header',span:'full',heading:'Composition benchmark',deck:'The same immutable visual assets are reused in each iteration.',story_role:'context',priority:2,emphasis:'secondary'},
  {id:'stat',type:'hero_stat',span:'third',value:'94.2',unit:'quads',label:'Synthetic hero statistic',claim_id:claim,story_role:'hook',priority:1,emphasis:'primary'},
  {id:'a',type:'visual',span:'two_thirds',manifest_ref:'visualizations/a.json',story_role:'evidence',priority:2,emphasis:'primary'},
  {id:'b',type:'visual',span:'full',manifest_ref:'visualizations/b.json',story_role:'evidence',priority:1,emphasis:'hero'},
  {id:'text',type:'text',span:'full',heading:'Why it matters',body:'The benchmark measures deterministic candidate composition, ranking and award-informed critic work. It excludes model inference, network fetches and database queries.',claim_ids:[claim],story_role:'resolution',priority:3,emphasis:'secondary'},
 ]
};
const lint=lintInfographicSpec(spec,assets,{verified_claim_ids:[claim]});if(!lint.passed) throw new Error(lint.blockers.join(' | '));
for(let i=0;i<20;i++){const b=composeInfographicBundle(spec,assets);critiqueInfographic(spec,b);}
const times=[];const N=240;
for(let i=0;i<N;i++){
 const t0=performance.now();const b=composeInfographicBundle(spec,assets);critiqueInfographic(spec,b);times.push(performance.now()-t0);
}
times.sort((a,b)=>a-b);const pct=p=>times[Math.min(times.length-1,Math.floor((times.length-1)*p))];
const lastBundle=composeInfographicBundle(spec,assets);
const result={iterations:N,candidates_per_desktop:lastBundle.desktop.candidate_scores.length,p50_ms:pct(.5),p95_ms:pct(.95),max_ms:times.at(-1),budget_p95_ms:15,passed:pct(.95)<15};
console.log(JSON.stringify(result,null,2));if(!result.passed) process.exit(2);
