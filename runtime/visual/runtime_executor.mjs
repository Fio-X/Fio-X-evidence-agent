import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBackendCommand } from './backend_executor.mjs';
import { runtimeForBackend } from './runtime_registry.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

export function detectContainerEngine(){
  for(const name of ['docker','podman']){ const r=spawnSync(name,['--version'],{encoding:'utf8'}); if(r.status===0)return name; }
  return null;
}
export function loadRuntimeLock(p){ if(!p||!fs.existsSync(p))return null; return JSON.parse(fs.readFileSync(p,'utf8')); }
function imageRef(row){ return row.image.includes('@sha256:')?row.image:`${row.image}@${row.image_digest}`; }
export function backendExecutionPlan(backend,{requestPath,outputDir,health={},runtimeLock=null,engine=null,caseDir=null}={}){
  const runtime=runtimeForBackend(backend); if(!runtime) return {status:'NO_RUNTIME',runtime,backend};
  const cmd=buildBackendCommand(backend,{requestPath,outputDir});
  if(health?.[runtime]?.status==='AVAILABLE') return {status:'READY_NATIVE',runtime,backend,command:cmd.command,args:cmd.args,cwd:ROOT,mode:'native'};
  const lockRow=runtimeLock?.runtimes?.[runtime]; const useEngine=engine||detectContainerEngine();
  if(!lockRow) return {status:'BLOCKED_RUNTIME',runtime,backend,reason:'runtime unavailable locally and no promoted runtime lock'};
  if(lockRow.health_status!=='PASS') return {status:'BLOCKED_RUNTIME',runtime,backend,reason:'runtime lock health is not PASS'};
  if(!useEngine) return {status:'BLOCKED_RUNTIME',runtime,backend,reason:'promoted runtime exists but docker/podman is unavailable'};
  if(!caseDir) return {status:'BLOCKED_RUNTIME',runtime,backend,reason:'container execution requires caseDir bind mount'};
  const absCase=path.resolve(caseDir); const relCase=path.relative(ROOT,absCase); if(relCase.startsWith('..')) throw new Error('caseDir must be inside repository root');
  const containerCase=path.posix.join('/workspace',...relCase.split(path.sep));
  return {status:'READY_CONTAINER',runtime,backend,mode:'container',command:useEngine,args:['run','--rm','-v',`${absCase}:${containerCase}`,'-w','/workspace',imageRef(lockRow),cmd.command,...cmd.args],cwd:ROOT,image:imageRef(lockRow),lock_source_commit:runtimeLock.source_commit};
}
export function executeBackend(backend,opts={}){
  const plan=backendExecutionPlan(backend,opts); if(!['READY_NATIVE','READY_CONTAINER'].includes(plan.status)) return {plan,run:null};
  const run=spawnSync(plan.command,plan.args,{cwd:plan.cwd,encoding:'utf8',timeout:opts.timeout??180000}); return {plan,run};
}
