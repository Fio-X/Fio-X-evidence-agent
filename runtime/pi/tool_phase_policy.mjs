import { TOOL_INDEX, TOOL_REGISTRY, toolEnabledForProfile } from './tool_registry.mjs';

export const TOOL_PHASE_POLICY_VERSION='0.2.0';
export const VALID_TOOL_PHASES=Object.freeze(['core','discover','verify','synthesize','design','publish','verify_publication']);
export const TOOL_PHASES=Object.freeze(Object.fromEntries(TOOL_REGISTRY.tools.map(tool=>[tool.name,tool.phase])));

export function toolEnabledForPhase(name, requested='all'){
  const meta=TOOL_INDEX[String(name??'')];
  if(!meta) return false;
  const raw=String(requested??'all').trim();
  if(!raw||raw==='all') return true;
  const enabled=new Set(raw.split(',').map(x=>x.trim()).filter(Boolean));
  enabled.add('core');
  return enabled.has(meta.phase);
}

export function toolEnabled(name, {phase='all', profile=TOOL_REGISTRY.default_profile}={}){
  return toolEnabledForProfile(name, profile) && toolEnabledForPhase(name, phase);
}
