#!/usr/bin/env node
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {spawnSync} from 'node:child_process';
function run(args){const r=spawnSync('node',['scripts/run_backend_qualification.mjs',...args],{encoding:'utf8',timeout:90000});if(r.status!==0)throw new Error(r.stderr||r.stdout);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'adn-patch-v134-')); const a=path.join(root,'a'),b=path.join(root,'b'),patches=path.join(root,'patches'); fs.mkdirSync(patches);
run(['--case','nasa_climate_trend','--output',a,'--health','outputs/runtime-health.json']);
const reqA=JSON.parse(fs.readFileSync(path.join(a,'nasa_climate_trend','python_publication','request.json'),'utf8')); const manA=JSON.parse(fs.readFileSync(path.join(a,'nasa_climate_trend','python_publication','manifest.json'),'utf8'));
const patch={schema_version:'2.0.0',patch_id:'nasa-title-air',story_id:'nasa_climate_trend',backend:'python_publication',base_semantic_fingerprint:reqA.semantic_fingerprint,base_design_system_hash:reqA.design_system.content_hash,operations:[{target_id:'story:nasa_climate_trend:title',field:'title_size',value:27,reason:'increase headline hierarchy'},{target_id:'story:nasa_climate_trend:canvas',field:'layout_margins',value:{outer_left:.06,outer_right:.95,plot_top:.78},reason:'give the data field more width'}]};
fs.writeFileSync(path.join(patches,'nasa_climate_trend.python_publication.json'),JSON.stringify(patch,null,2));
run(['--case','nasa_climate_trend','--output',b,'--health','outputs/runtime-health.json','--patch-dir',patches]);
const sum=JSON.parse(fs.readFileSync(path.join(b,'run-summary.json'),'utf8')); const row=sum.cases[0].rows.find(x=>x.backend==='python_publication'); if(row.patch_status!=='APPLIED')throw new Error(`patch not applied: ${JSON.stringify(row)}`);
const reqB=JSON.parse(fs.readFileSync(path.join(b,'nasa_climate_trend','python_publication','request.json'),'utf8')); const manB=JSON.parse(fs.readFileSync(path.join(b,'nasa_climate_trend','python_publication','manifest.json'),'utf8'));
if(reqB.options.title_size!==27||reqB.design_system.tokens.outer_left!==.06)throw new Error('patched presentation values absent'); if(reqA.semantic_fingerprint!==reqB.semantic_fingerprint||manA.semantic_fingerprint!==manB.semantic_fingerprint)throw new Error('patch changed semantics'); if(manA.png_sha256===manB.png_sha256)throw new Error('presentation patch did not change rendered artifact');
console.log('art direction replay render v1.34: PASS');
