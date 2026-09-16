import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const CONFIG=path.join(ROOT,'config','editorial-style-mappings.json');
export const STYLE_MAPPING_VERSION='0.2.0';
export function styleRegistry(){return JSON.parse(fs.readFileSync(CONFIG,'utf8'));}
function uniq(xs){return [...new Set((xs??[]).map(String))];}
export function resolveEditorialStyle({requested=null,dimensions=[],topologies=[],signals=[]}={}){
  const registry=styleRegistry(); const dims=uniq(dimensions), tops=uniq(topologies), sigs=uniq(signals);
  const compatible=(name)=>{const p=registry.profiles[name];if(!p)return {ok:false,reasons:['unknown_profile']};const dimBad=dims.filter(d=>!p.compatible_dimensions.includes(d));const topBad=tops.filter(t=>!p.compatible_topologies.includes(t));return {ok:dimBad.length===0&&topBad.length===0,reasons:[...dimBad.map(d=>`dimension:${d}`),...topBad.map(t=>`topology:${t}`)]};};
  if(requested){const c=compatible(requested);if(!c.ok)return {status:'BLOCK',profile:null,reasons:c.reasons,requested};return {status:'PASS',profile:requested,tokens:structuredClone(registry.profiles[requested].tokens),reasons:['explicit_compatible_profile'],signals:sigs};}
  const rows=[];for(const rule of registry.rules){const p=registry.profiles[rule.profile];if(!p)continue;const c=compatible(rule.profile);if(!c.ok)continue;const req=rule.requires_any_dimension??[];if(req.length&&!req.some(x=>dims.includes(x)))continue;const reqSig=rule.requires_any_signal??[];if(reqSig.length&&!reqSig.some(x=>sigs.includes(x)))continue;rows.push({profile:rule.profile,score:Number(rule.priority??0)});}rows.sort((a,b)=>b.score-a.score||a.profile.localeCompare(b.profile));const pick=rows[0]?.profile??'analytical_precision';const c=compatible(pick);if(!c.ok)return {status:'BLOCK',profile:null,reasons:c.reasons};return {status:'PASS',profile:pick,tokens:structuredClone(registry.profiles[pick].tokens),reasons:['automatic_style_mapping'],ranked:rows,signals:sigs};
}
export function validateStyleRegistry(){const r=styleRegistry(),errors=[];if(r.schema_version!==STYLE_MAPPING_VERSION)errors.push(`style mapping schema_version must be ${STYLE_MAPPING_VERSION}`);for(const rule of r.rules??[])if(!r.profiles?.[rule.profile])errors.push(`unknown style rule profile:${rule.profile}`);return errors;}
