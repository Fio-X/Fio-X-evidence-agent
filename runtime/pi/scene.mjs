export const VISUAL_SCENE_VERSION='0.1.0';
export const SCENE_PRIMITIVES=['anchor','inset','embedded_chart','annotation_field','callout','mask','crop','rail','locator','illustration','substrate','module'];
export const SCENE_RELATIONS=['align','attach','contain','avoid','overlap_allowed','follow_path','share_scale'];
const PROTECTED_FIELDS=new Set(['value','data','unit','claim','claim_text','source','source_id','source_url','computation','sql']);

export function validateVisualScene(scene){
  const errors=[];if(!scene||typeof scene!=='object')return ['scene must be an object'];
  if(scene.schema_version!==VISUAL_SCENE_VERSION)errors.push(`schema_version must be ${VISUAL_SCENE_VERSION}`);
  const ids=new Set();for(const node of scene.nodes??[]){if(!node.id||ids.has(node.id))errors.push(`scene node id must be unique: ${node.id??'missing'}`);ids.add(node.id);if(!SCENE_PRIMITIVES.includes(node.type))errors.push(`unsupported scene primitive ${node.type}`);for(const k of Object.keys(node))if(PROTECTED_FIELDS.has(k))errors.push(`scene node '${node.id}' may not own protected field '${k}'`);}
  for(const rel of scene.relations??[]){if(!SCENE_RELATIONS.includes(rel.type))errors.push(`unsupported scene relation ${rel.type}`);if(!ids.has(rel.from)||!ids.has(rel.to))errors.push(`relation ${rel.type} references unknown node`);}
  return errors;
}

export function compileLegacyScene(pattern,moduleIds,{viewport='desktop'}={}){
  const ids=moduleIds.map(String);const nodes=ids.map((id,i)=>({id:`module:${id}`,type:'module',module_ref:id,z:10+i,collision_group:'content'}));const relations=[];
  if(pattern==='hero_sidecar_stack'&&nodes.length>1){relations.push({type:'attach',from:nodes[1].id,to:nodes[0].id,placement:viewport==='mobile'?'below':'right'});for(let i=2;i<nodes.length;i++)relations.push({type:'attach',from:nodes[i].id,to:nodes[i-1].id,placement:'below'});}
  else if(pattern==='hero_with_rail'&&nodes.length>1){for(let i=1;i<nodes.length;i++)relations.push({type:'attach',from:nodes[i].id,to:nodes[0].id,placement:viewport==='mobile'?'below':'right_rail'});}
  else if(!['hero_sidecar_stack','hero_with_rail'].includes(pattern))throw new Error(`Unknown legacy scene pattern '${pattern}'`);
  return {schema_version:VISUAL_SCENE_VERSION,id:`legacy:${pattern}:${viewport}`,viewport,nodes,relations};
}

export function applyArtDirectionPatch(scene,patch){
  const next=structuredClone(scene),byId=new Map((next.nodes??[]).map(n=>[n.id,n]));
  for(const op of patch?.operations??[]){const node=byId.get(op.node_id);if(!node)throw new Error(`Unknown scene node '${op.node_id}'`);if(!['position','size','emphasis','label_anchor','visibility'].includes(op.field))throw new Error(`Patch field '${op.field}' is not presentation-safe`);node.art_direction={...(node.art_direction??{}),[op.field]:structuredClone(op.value)};}
  return next;
}
