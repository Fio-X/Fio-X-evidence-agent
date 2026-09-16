#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executeBackend, loadRuntimeLock } from '../runtime/visual/runtime_executor.mjs';
import { PythonWarmWorkerClient } from '../runtime/visual/warm_worker_client.mjs';
import { runtimeForBackend } from '../runtime/visual/runtime_registry.mjs';
import { buildSemanticContract } from '../runtime/visual/semantic_contract.mjs';
import { normalizeVisualRecipeV2 } from '../runtime/visual/visual_recipe_v2.mjs';
import { resolveDesignSystem, designDiversityDiagnostics, compositionDiversityDiagnostics } from '../runtime/visual/design_systems.mjs';
import { applyArtDirectionPatchV2 } from '../runtime/visual/art_direction_replay.mjs';
import { summarizeVisualQa } from '../runtime/visual/visual_qa.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function arg(name, fallback=null){ const i=process.argv.indexOf(name); return i>=0?process.argv[i+1]:fallback; }
function shaFile(p){ return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function finalArtifact(name){ return /\.(svg|png|pdf|jpg|jpeg|webp|html)$/i.test(name); }
function readManifest(outdir){ const p=path.join(outdir,'manifest.json'); if(!fs.existsSync(p)) return null; try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;} }

function maybePatch(req,c,backend){
  const dir=arg('--patch-dir',null); if(!dir)return {request:req,status:'NONE'};
  const base=path.resolve(ROOT,dir); const candidates=[path.join(base,`${c.id}.${backend}.json`),path.join(base,`${c.id}.json`)];
  const hit=candidates.find(fs.existsSync); if(!hit)return {request:req,status:'NONE'};
  const patch=JSON.parse(fs.readFileSync(hit,'utf8')); const applied=applyArtDirectionPatchV2(req,patch);
  if(applied.status!=='APPLIED')return {request:req,status:applied.status,reason:applied.reason??applied.errors??null,patch_path:path.relative(ROOT,hit)};
  return {request:applied.request,status:'APPLIED',patch_path:path.relative(ROOT,hit),request_hash_before:applied.request_hash_before,request_hash_after:applied.request_hash_after};
}
function artifactStatus(outdir,files,manifest){
  if(manifest?.artifact_status==='SCENE_READY_BROWSER_RENDER_REQUIRED') return 'SCENE_ONLY';
  return files.some(finalArtifact)?'RENDERED':'NO_FINAL_ARTIFACT';
}

const caseId=arg('--case');
const outRoot=path.resolve(ROOT,arg('--output','outputs/backend-qualification-run'));
const manifestPath=path.resolve(ROOT,arg('--manifest','fixtures/benchmarks/v2/manifest.json'));
const healthPath=path.resolve(ROOT,arg('--health','outputs/runtime-health.json'));
const runtimeLockPath=arg('--runtime-lock',fs.existsSync(path.join(ROOT,'runtimes/runtime-lock.json'))?'runtimes/runtime-lock.json':null);
const runtimeLock=runtimeLockPath?loadRuntimeLock(path.resolve(ROOT,runtimeLockPath)):null;
const engine=arg('--engine',null);
const benchmark=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const health=JSON.parse(fs.readFileSync(healthPath,'utf8')).runtimes;
const selected=benchmark.cases.filter(c=>!caseId||c.id===caseId);
if(caseId&&!selected.length) throw new Error(`unknown benchmark case ${caseId}`);
fs.mkdirSync(outRoot,{recursive:true});
const summary={schema_version:'1.3.0',benchmark_status:benchmark.status,cases:[],execution:{python_warm_worker:false}};
const qaTargets=[];
let pythonWarm=null;
if(health?.['viz-python']?.status==='AVAILABLE' && arg('--no-warm-python',null)===null){
  try{ pythonWarm=new PythonWarmWorkerClient(); await pythonWarm.ready; summary.execution.python_warm_worker=true; }catch(e){ summary.execution.python_warm_worker_error=String(e.message||e); pythonWarm=null; }
}

for(const c of selected){
  const caseDir=path.join(outRoot,c.id); fs.mkdirSync(caseDir,{recursive:true});
  const recipe=normalizeVisualRecipeV2(c.recipe);
  const recipePath=path.join(caseDir,'recipe.json'); fs.writeFileSync(recipePath,JSON.stringify(recipe,null,2)+'\n');
  const semantic=buildSemanticContract(ROOT,c.semantic_contract);
  const designSystem=resolveDesignSystem({story_id:c.id,story_family:c.story_family,analytical_job:recipe.analytical_job},{preferred:c.design_system_id??null});
  fs.writeFileSync(path.join(caseDir,'design-system.json'),JSON.stringify(designSystem,null,2)+'\n');
  fs.writeFileSync(path.join(caseDir,'semantic-contract.json'),JSON.stringify(semantic,null,2)+'\n');
  const evidenceHashes=Object.fromEntries(semantic.evidence.map(x=>[x.path,x.sha256]));
  const rows=[];
  for(const backend of c.candidate_backends){
    const runtime=runtimeForBackend(backend); const conf=c.render_requests?.[backend];
    if(!conf||conf.status){ rows.push({backend,runtime,status:conf?.status??'PENDING_BACKEND_WIRING',semantic_fingerprint:semantic.fingerprint}); continue; }
    const outdir=path.join(caseDir,backend); fs.mkdirSync(outdir,{recursive:true});
    let req={
      schema_version:'1.1.0',backend,story_id:c.id,recipe_path:path.relative(ROOT,recipePath),output_dir:path.relative(ROOT,outdir),
      semantic_fingerprint:semantic.fingerprint,evidence_hashes:evidenceHashes,claim_ids:semantic.claim_ids,
      inputs:conf.inputs??{},options:conf.options??{},template:conf.template??null,design_system:designSystem
    };
    const patchState=maybePatch(req,c,backend); req=patchState.request;
    const reqPath=path.join(outdir,'request.json'); fs.writeFileSync(reqPath,JSON.stringify(req,null,2)+'\n');
    let execution, executionMode;
    if(pythonWarm && runtime==='viz-python' && ['python_publication','adjacency_matrix'].includes(backend)){
      try{
        const wr=await pythonWarm.render(backend,path.relative(ROOT,reqPath));
        executionMode='warm_worker_native';
        if(wr.status!=='PASS'){ rows.push({backend,runtime,status:'RENDER_FAILED',execution_mode:executionMode,error:wr.error??'warm worker failed',semantic_fingerprint:semantic.fingerprint}); continue; }
        execution={run:{status:0,stdout:JSON.stringify(wr),stderr:''},plan:{mode:executionMode}};
      }catch(e){ rows.push({backend,runtime,status:'RENDER_FAILED',execution_mode:'warm_worker_native',error:String(e.message||e),semantic_fingerprint:semantic.fingerprint}); continue; }
    }else{
      try{ execution=executeBackend(backend,{requestPath:path.relative(ROOT,reqPath),outputDir:req.output_dir,health,runtimeLock,engine,caseDir,timeout:180000}); }
      catch(e){ rows.push({backend,runtime,status:'NO_ADAPTER',error:String(e.message||e),semantic_fingerprint:semantic.fingerprint}); continue; }
      if(!execution.run){ rows.push({backend,runtime,status:execution.plan.status,reason:execution.plan.reason??null,execution_mode:execution.plan.mode??null,semantic_fingerprint:semantic.fingerprint}); continue; }
      const run=execution.run;
      if(run.status!==0){ rows.push({backend,runtime,status:'RENDER_FAILED',execution_mode:execution.plan.mode,exit_code:run.status,stderr:(run.stderr||'').slice(-3000),semantic_fingerprint:semantic.fingerprint}); continue; }
    }
    const run=execution.run;
    const files=fs.readdirSync(outdir).filter(x=>x!=='request.json').sort();
    const backendManifest=readManifest(outdir);
    const status=artifactStatus(outdir,files,backendManifest);
    const artifacts=fs.readdirSync(outdir).filter(x=>x!=='request.json').sort().map(f=>{ const p=path.join(outdir,f); const b=fs.readFileSync(p); return {file:f,sha256:crypto.createHash('sha256').update(b).digest('hex'),bytes:b.length,final:finalArtifact(f)}; });
    const row={backend,runtime,status,execution_mode:execution.plan.mode,semantic_fingerprint:semantic.fingerprint,design_system_id:designSystem.id,patch_status:patchState.status,patch_path:patchState.patch_path??null,visual_qa:null,backend_manifest:backendManifest,artifacts,stdout:(run.stdout||'').slice(-1200)};
    rows.push(row);
    const png=files.find(f=>/\.png$/i.test(f)); if(png) qaTargets.push({key:`${c.id}/${backend}`,path:path.join(outdir,png),row});
  }
  const rendered=rows.filter(r=>r.status==='RENDERED');
  const fingerprints=new Set(rendered.map(r=>r.semantic_fingerprint));
  const semanticEquivalent=rendered.length<2 || (fingerprints.size===1 && [...fingerprints][0]===semantic.fingerprint);
  if(!semanticEquivalent) throw new Error(`${c.id}: rendered candidates do not share semantic fingerprint`);
  const salt=crypto.randomBytes(16).toString('hex');
  const ordered=[...rendered].sort((a,b)=>crypto.createHash('sha256').update(`${salt}:${a.backend}`).digest('hex').localeCompare(crypto.createHash('sha256').update(`${salt}:${b.backend}`).digest('hex')));
  const reviewDir=path.join(caseDir,'review'); fs.mkdirSync(reviewDir,{recursive:true}); fs.mkdirSync(path.join(caseDir,'private'),{recursive:true});
  const blind=ordered.map((r,i)=>{
    const candidate=String.fromCharCode(65+i); const candidateDir=path.join(reviewDir,`candidate-${candidate}`); fs.mkdirSync(candidateDir,{recursive:true});
    const artifacts=r.artifacts.filter(a=>a.final).map(a=>{ const src=path.join(caseDir,r.backend,a.file); const dst=path.join(candidateDir,a.file); fs.copyFileSync(src,dst); return `candidate-${candidate}/${a.file}`; });
    return {candidate,artifacts};
  });
  const key=ordered.map((r,i)=>({candidate:String.fromCharCode(65+i),backend:r.backend}));
  const blindManifest={schema_version:'1.2.0',story_id:c.id,story_family:c.story_family,semantic_fingerprint:semantic.fingerprint,candidates:blind,pairwise:blind.flatMap((x,i)=>blind.slice(i+1).map(y=>[x.candidate,y.candidate])),review_status:blind.length>=2?'READY':'WAITING_FOR_MULTIPLE_BACKENDS'};
  fs.writeFileSync(path.join(caseDir,'review/blind-manifest.json'),JSON.stringify(blindManifest,null,2)+'\n');
  fs.writeFileSync(path.join(caseDir,'private/backend-key.json'),JSON.stringify({schema_version:'1.0.0',story_id:c.id,salt,key},null,2)+'\n');
  summary.cases.push({id:c.id,story_family:c.story_family,design_system_id:designSystem.id,design_system_hash:designSystem.content_hash,semantic_fingerprint:semantic.fingerprint,rows,rendered_count:rendered.length,semantic_equivalent:semanticEquivalent,blind_ready:rendered.length>=2});
}
if(pythonWarm) await pythonWarm.close();
if(qaTargets.length){
  const inputPath=path.join(outRoot,'visual-qa-batch-input.json'), outputPath=path.join(outRoot,'visual-qa-batch.json');
  fs.writeFileSync(inputPath,JSON.stringify(qaTargets.map(x=>({key:x.key,path:x.path})),null,2)+'\n');
  const q=spawnSync('python3',['scripts/visual_qa_batch.py','--input',inputPath,'--output',outputPath],{cwd:ROOT,encoding:'utf8',timeout:120000});
  if(q.status!==0) summary.visual_qa_batch_error=(q.stderr||q.stdout||'batch visual qa failed').slice(-2000);
  else { const reports=JSON.parse(fs.readFileSync(outputPath,'utf8')); for(const t of qaTargets)t.row.visual_qa=reports[t.key]??null; }
  try{fs.unlinkSync(inputPath);}catch{}
}
summary.design_diversity=designDiversityDiagnostics(summary.cases);
summary.composition_diversity=compositionDiversityDiagnostics(summary.cases);
summary.visual_qa=summarizeVisualQa(summary.cases.flatMap(c=>c.rows.map(r=>r.visual_qa).filter(Boolean)));
summary.external_runtime_gate=summary.cases.some(c=>c.rows.some(r=>r.status==='BLOCKED_RUNTIME'||r.status==='RUNTIME_UNAVAILABLE'))?'PENDING_EXTERNAL_RUNTIME':'CLEAR';
fs.writeFileSync(path.join(outRoot,'run-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
