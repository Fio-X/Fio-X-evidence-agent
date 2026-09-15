#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import {spawnSync} from 'node:child_process';
const out=fs.mkdtempSync(path.join(os.tmpdir(),'adn-q-v134-'));
const r=spawnSync('node',['scripts/run_backend_qualification.mjs','--case','nasa_climate_trend','--output',out,'--health','outputs/runtime-health.json'],{encoding:'utf8',timeout:90000});
if(r.status!==0)throw new Error(r.stderr||r.stdout);
const s=JSON.parse(fs.readFileSync(path.join(out,'run-summary.json'),'utf8')); const c=s.cases[0]; const row=c.rows.find(x=>x.backend==='python_publication');
if(c.design_system_id!=='scientific')throw new Error(`unexpected design system ${c.design_system_id}`); if(!row||row.status!=='RENDERED')throw new Error('python candidate did not render'); if(!row.visual_qa||row.visual_qa.competition_readiness!=='UNASSESSED')throw new Error('visual qa missing or overreached');
const req=JSON.parse(fs.readFileSync(path.join(out,c.id,'python_publication','request.json'),'utf8')); const man=JSON.parse(fs.readFileSync(path.join(out,c.id,'python_publication','manifest.json'),'utf8')); if(req.design_system.id!=='scientific'||man.design_system_id!=='scientific')throw new Error('design system audit chain broken');
console.log('qualification design/qa integration v1.34: PASS');
