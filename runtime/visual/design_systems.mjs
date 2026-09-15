import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const DEFAULT_PATH=path.join(ROOT,'config/editorial-design-systems.json');
function canonical(v){ if(Array.isArray(v))return v.map(canonical); if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])); return v; }
function hash(v){ return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex'); }
export function loadDesignSystems(p=DEFAULT_PATH){ const obj=JSON.parse(fs.readFileSync(p,'utf8')); const ids=obj.systems.map(x=>x.id); if(new Set(ids).size!==ids.length)throw new Error('design system ids must be unique'); return obj; }
function inferredId({story_family='',story_id='',analytical_job=''}={}){
  const sf=String(story_family); const id=String(story_id); const job=String(analytical_job);
  if(['maritime_trajectory','flight_route'].includes(sf)) return 'movement';
  if(sf.includes('network')||job==='network') return 'network';
  if(id.startsWith('titanic_')||sf==='investigative') return 'investigative';
  if(id.startsWith('worldbank_')||id.startsWith('eia_')||['energy_flow','global_flow'].includes(sf)) return 'economic';
  if(id.startsWith('nasa_')||id.startsWith('owid_')||sf==='terrain_environmental') return 'scientific';
  if(sf.includes('local')||sf==='explainer') return 'explainer';
  return 'scientific';
}
export function resolveDesignSystem(input,{catalog=loadDesignSystems(),preferred=null}={}){
  const selected=preferred||input?.design_system_id||inferredId(input); const sys=catalog.systems.find(x=>x.id===selected); if(!sys) throw new Error(`unknown design system '${selected}'`);
  const out={schema_version:'1.0.0',id:sys.id,description:sys.description,tokens:sys.tokens,composition:sys.composition}; out.content_hash=hash(out); return Object.freeze(out);
}
export function designDiversityDiagnostics(rows,{maxShare=0.55,minSystems=3}={}){
  const ids=rows.map(x=>x?.design_system_id).filter(Boolean); const counts={}; for(const id of ids)counts[id]=(counts[id]??0)+1; const total=ids.length; const ranked=Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])); const share=total&&ranked.length?ranked[0][1]/total:0;
  const issues=[]; if(total&&ranked.length<minSystems)issues.push('too_few_design_systems'); if(share>maxShare)issues.push('single_design_system_dominates');
  return {schema_version:'1.0.0',total,counts,distinct_systems:ranked.length,max_share:Number(share.toFixed(4)),status:issues.length?'ADVISORY':'PASS',issues};
}

export function compositionDiversityDiagnostics(cases,{maxShare=0.30,minSignatures=5}={}){
  const signatures=[];
  for(const c of cases??[]){
    for(const r of c?.rows??[]){ if(r?.status!=='RENDERED')continue; const m=r.backend_manifest??{}; signatures.push([c.design_system_id??'unknown',m.renderer??r.backend??'unknown',m.chart_type??'none'].join('|')); }
  }
  const counts={}; for(const x of signatures)counts[x]=(counts[x]??0)+1; const ranked=Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])); const total=signatures.length; const share=total&&ranked.length?ranked[0][1]/total:0; const issues=[]; if(total&&ranked.length<minSignatures)issues.push('too_few_composition_signatures'); if(share>maxShare)issues.push('single_composition_signature_dominates');
  return {schema_version:'1.0.0',total,distinct_signatures:ranked.length,max_share:Number(share.toFixed(4)),dominant_signature:ranked[0]?.[0]??null,counts:Object.fromEntries(ranked),status:issues.length?'ADVISORY':'PASS',issues};
}
