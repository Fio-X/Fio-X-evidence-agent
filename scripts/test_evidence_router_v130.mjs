#!/usr/bin/env node
import assert from 'node:assert/strict';
import { planBackendRouting } from '../runtime/visual/backend_router_v2.mjs';
import { compileVisualRecipeV2 } from '../runtime/visual/visual_compiler_v2.mjs';
const all=Object.fromEntries(['viz-python','viz-r','viz-qgis','viz-pygmt','viz-density','viz-web'].map(x=>[x,{status:'AVAILABLE'}]));
const mk=(patch={})=>({schema_version:'2.0.0',analytical_job:'geography',artifact_mode:'static_editorial',story_family:'new_map_family',data_profile:{mark_count:1000},geography:{enabled:true,scale:'regional'},network:{enabled:false},annotation:{label_count:10},delivery:{print:true,interactive:false},backend_hints:{},...patch});
const generic=planBackendRouting(mk(),{health:all}); assert.equal(generic.challenger,true); assert.ok(generic.challenger_reasons.includes('new_story_family_without_human_prior'));
const local=planBackendRouting(mk({geography:{enabled:true,scale:'local'},annotation:{label_count:80}}),{health:all}); assert.equal(local.backend,'qgis_cartography'); assert.equal(local.specialist_rule,true);
const priors={schema_version:'2.0.0',story_families:{new_map_family:{status:'QUALIFIED',probabilities:{r_editorial:.8,python_publication:.15,qgis_cartography:.05}}}};
const withPrior=planBackendRouting(mk(),{health:all,priors}); assert.equal(withPrior.has_qualified_prior,true); assert.ok(withPrior.ranked.find(x=>x.backend==='r_editorial').score>generic.ranked.find(x=>x.backend==='r_editorial').score);
const flag=compileVisualRecipeV2(mk(),{health:all,flagship:true}); assert.equal(flag.execution_policy,'production_with_challenger'); assert.ok(flag.candidates.length>=2);
console.log('evidence router v1.30: PASS');
