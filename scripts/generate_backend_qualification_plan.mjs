#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { compileVisualRecipeV2 } from '../runtime/visual/visual_compiler_v2.mjs';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'fixtures/benchmarks/v2/manifest.json'),'utf8'));
const healthDoc=JSON.parse(fs.readFileSync(path.join(root,'outputs/runtime-health.json'),'utf8'));
const health=healthDoc.runtimes;

const recipeFor=(c)=>{
  const fam=c.story_family;
  const network=fam.includes('network');
  const geo=['maritime_trajectory','flight_route','global_flow','local_cartography'].some(x=>fam.includes(x));
  const local=fam.includes('maritime')||fam.includes('local');
  return {
    analytical_job:network?'network':(geo?'flow':'comparison'),
    artifact_mode:'static_editorial',
    story_family:fam,
    data_profile:{mark_count: fam==='maritime_trajectory'?15:1000, node_count:network?40:0, edge_count:network?80:0, temporal:fam.includes('trajectory')||fam.includes('route')},
    geography:{enabled:geo,scale:local?'local':'regional',projection_policy:local?'local_metric':'editorial_auto',terrain:false,bathymetry:false,context_layers:[]},
    network:{enabled:network,spatial:false,directed:true,weighted:true,community_structure:network},
    annotation:{label_count:local?20:10,direct_labels:true},
    delivery:{print:true,interactive:false,mobile:true,vector_required:true,animation:false},
    backend_hints:{allow:c.candidate_backends,qualification_mode:true,challenger_mode:false},
    generated_imagery:false
  };
};

const cases=manifest.cases.map(c=>{
  const recipe=recipeFor(c);
  const plan=compileVisualRecipeV2(recipe,{health});
  return {...c,recipe,plan,blocked_backends:c.candidate_backends.filter(b=>!plan.candidates.some(x=>x.backend===b))};
});
const out={schema_version:'1.0.0',generated_from:manifest.status,health_snapshot:'outputs/runtime-health.json',cases};
const outPath=path.join(root,'outputs/backend-qualification-plan.json');
fs.writeFileSync(outPath,JSON.stringify(out,null,2)+'\n');
console.log(outPath);
