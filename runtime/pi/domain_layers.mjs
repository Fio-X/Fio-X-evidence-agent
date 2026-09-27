export const DOMAIN_EVIDENCE_ROLES=['contextual','correlated','mechanistic','reported_causal'];

export function validateDomainLayer(layer,{story_time}={}){
  const errors=[];
  if(!layer||typeof layer!=='object')return ['domain layer must be an object'];
  if(!String(layer.id??'').trim())errors.push('id is required');
  if(!DOMAIN_EVIDENCE_ROLES.includes(layer.evidence_role))errors.push(`evidence_role must be one of ${DOMAIN_EVIDENCE_ROLES.join(', ')}`);
  if(!String(layer.source_url??'').trim())errors.push('source_url is required');
  if(!String(layer.content_hash??'').match(/^[0-9a-f]{64}$/))errors.push('content_hash must be sha256');
  if(story_time&&layer.valid_from&&String(story_time)<String(layer.valid_from))errors.push('domain layer is not yet valid at story_time');
  if(story_time&&layer.valid_to&&String(story_time)>String(layer.valid_to))errors.push('domain layer is expired at story_time');
  return errors;
}

export function maySupportCausalWording(layer){return ['mechanistic','reported_causal'].includes(layer?.evidence_role);}
export function assertCausalSupport(layer,wording='causal annotation'){
  if(!maySupportCausalWording(layer))throw new Error(`${wording} requires mechanistic or reported_causal evidence; got ${layer?.evidence_role??'missing'}`);
  return true;
}
export function bindAnnotationToFeature(annotation,layer,featureId){
  const feature=(layer?.features??[]).find(f=>String(f.id)===String(featureId));
  if(!feature)throw new Error(`Unknown domain feature '${featureId}' in layer '${layer?.id??''}'`);
  return {...annotation,domain_binding:{layer_id:layer.id,feature_id:String(featureId),evidence_role:layer.evidence_role}};
}
