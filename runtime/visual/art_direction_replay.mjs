import crypto from 'node:crypto';

const SAFE_PATHS = [
  /^\/options\/(title_size|label_top_n|highlight_max|legend_position|label_offsets|visibility|line_breaks)$/,
  /^\/design_system\/tokens\/(outer_left|outer_right|plot_top|plot_bottom)$/,
  /^\/design_system\/composition\/[a-z][a-z0-9_]*$/,
];
const PROTECTED_PATH = /\/(fact|facts|sql|claim|claims|evidence|computation|computations|source|sources|inputs)(\/|$)/i;
const VIEWPORTS = new Set(['desktop', 'tablet', 'mobile', 'all']);
function clone(x){return x===undefined?undefined:JSON.parse(JSON.stringify(x));}
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
function hash(v){const encoded=JSON.stringify(canonical(v));return crypto.createHash('sha256').update(encoded===undefined?'__undefined__':encoded).digest('hex');}
function tokens(path){return path.slice(1).split('/').map(x=>x.replace(/~1/g,'/').replace(/~0/g,'~'));}
function safePath(path){return typeof path==='string'&&!PROTECTED_PATH.test(path)&&SAFE_PATHS.some(re=>re.test(path));}
function getAt(root,path){let at=root;for(const key of tokens(path)){if(at==null||typeof at!=='object'||!(key in at))return undefined;at=at[key];}return at;}
function setAt(root,path,value,op){const parts=tokens(path);let at=root;for(const key of parts.slice(0,-1)){if(!at[key]||typeof at[key]!=='object')at[key]={};at=at[key];}const key=parts.at(-1);if(op==='remove')delete at[key];else at[key]=clone(value);}

export function validateArtDirectionPatchV2(patch){
  const e=[];
  if(patch?.schema_version!=='2.1.0')e.push('schema_version must be 2.1.0');
  if(!patch?.patch_id)e.push('patch_id required');
  if(!patch?.story_id)e.push('story_id required');
  if(!/^[0-9a-f]{64}$/.test(String(patch?.base_semantic_fingerprint??'')))e.push('valid base_semantic_fingerprint required');
  if(!/^[0-9a-f]{64}$/.test(String(patch?.base_design_system_hash??'')))e.push('valid base_design_system_hash required');
  for(const [i,op] of (patch?.operations??[]).entries()){
    if(!op?.operation_id)e.push(`operation ${i+1} operation_id required`);
    if(!op?.validator_rule_id)e.push(`operation ${i+1} validator_rule_id required`);
    if(!op?.scene_id)e.push(`operation ${i+1} scene_id required`);
    if(!op?.object_id)e.push(`operation ${i+1} object_id required`);
    if(!['add','replace','remove'].includes(op?.op))e.push(`operation ${i+1} op must be add, replace, or remove`);
    if(!safePath(op?.path))e.push(`operation ${i+1} path '${op?.path}' is protected or unsupported`);
    if(op?.op!=='remove'&&!Object.prototype.hasOwnProperty.call(op??{},'value'))e.push(`operation ${i+1} value required`);
    for(const viewport of (op?.viewports??[]))if(!VIEWPORTS.has(viewport))e.push(`operation ${i+1} viewport '${viewport}' unsupported`);
  }
  if(!(patch?.operations?.length))e.push('operations required');
  return e;
}

export function applyArtDirectionPatchV2(request,patch){
  const errors=validateArtDirectionPatchV2(patch);
  if(errors.length)return {status:'INVALID_PATCH',errors,request};
  if(request.story_id!==patch.story_id)return {status:'INVALIDATED_STORY',reason:'story_id_mismatch',request};
  if(patch.backend&&patch.backend!==request.backend)return {status:'SKIPPED_BACKEND',reason:'backend_scope_mismatch',request};
  if(request.semantic_fingerprint!==patch.base_semantic_fingerprint)return {status:'INVALIDATED_SEMANTICS',reason:'semantic_fingerprint_changed',request};
  if(request.design_system?.content_hash!==patch.base_design_system_hash)return {status:'INVALIDATED_DESIGN_SYSTEM',reason:'design_system_changed',request};
  const out=clone(request);const before=hash(out);const diff=[];const inverse=[];
  for(const operation of patch.operations){
    const prior=getAt(out,operation.path);
    if(Object.prototype.hasOwnProperty.call(operation,'previous_value')&&hash(prior)!==hash(operation.previous_value))return {status:'PATCH_CONFLICT',reason:`previous_value_mismatch:${operation.operation_id}`,request};
    setAt(out,operation.path,operation.value,operation.op);
    const after=getAt(out,operation.path);
    diff.push({operation_id:operation.operation_id,validator_rule_id:operation.validator_rule_id,scene_id:operation.scene_id,object_id:operation.object_id,path:operation.path,before:clone(prior),after:clone(after),viewports:operation.viewports??['all']});
    inverse.unshift({...operation,op:prior===undefined?'remove':'replace',value:clone(prior),previous_value:clone(after),validator_rule_id:`rollback:${operation.validator_rule_id}`});
  }
  const protectedAfter={semantic_fingerprint:out.semantic_fingerprint,evidence_hashes:out.evidence_hashes,claim_ids:out.claim_ids,inputs:out.inputs};
  const protectedBefore={semantic_fingerprint:request.semantic_fingerprint,evidence_hashes:request.evidence_hashes,claim_ids:request.claim_ids,inputs:request.inputs};
  if(hash(protectedAfter)!==hash(protectedBefore))throw new Error('art direction patch modified protected evidence fields');
  const affected={scene_ids:[...new Set(diff.map(x=>x.scene_id))],object_ids:[...new Set(diff.map(x=>x.object_id))],viewports:[...new Set(diff.flatMap(x=>x.viewports.includes('all')?['desktop','tablet','mobile']:x.viewports))]};
  out.art_direction_patch={patch_id:patch.patch_id,application_status:'APPLIED',diff,affected};
  const inversePatch={...patch,patch_id:`${patch.patch_id}:rollback`,operations:inverse};
  return {status:'APPLIED',request:out,request_hash_before:before,request_hash_after:hash(out),semantic_fingerprint:out.semantic_fingerprint,diff,inverse_patch:inversePatch,affected,recompile:affected};
}

export function rollbackArtDirectionPatchV2(applied){
  if(applied?.status!=='APPLIED'||!applied?.inverse_patch)return {status:'INVALID_ROLLBACK',reason:'applied patch result required'};
  const rolled=applyArtDirectionPatchV2(applied.request,applied.inverse_patch);
  if(rolled.status!=='APPLIED')return rolled;
  const request=clone(rolled.request);delete request.art_direction_patch;
  return {...rolled,status:'ROLLED_BACK',request,request_hash_after:hash(request)};
}
