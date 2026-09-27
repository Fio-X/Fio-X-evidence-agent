import {createHash} from 'node:crypto';

function hash(text){return createHash('sha256').update(text).digest('hex');}
export function addStableEditIds(svg,{prefix='adn'}={}){
  const counts=new Map();
  return String(svg).replace(/<([a-z]+)([^>]*\sdata-role="([^"]+)"[^>]*)>/g,(m,tag,attrs,role)=>{
    if(/\sdata-edit-id=/.test(attrs))return m;
    const n=(counts.get(role)??0)+1;counts.set(role,n);return `<${tag}${attrs} data-edit-id="${prefix}:${role}:${n}">`;
  });
}
export function buildProFinishManifest({svg,scene_id,desktop_artboard='desktop',mobile_artboard='mobile',origin='software'}={}){
  const editable=addStableEditIds(svg??'');
  return {schema_version:'1.0.0',scene_id,origin,source_svg_hash:hash(String(svg??'')),editable_svg_hash:hash(editable),protected_classes:['data-value','claim','unit','source','computation'],artboards:[desktop_artboard,mobile_artboard],editable_svg:editable};
}
export function validateFinishPatch(patch){
  const allowed=new Set(['position','size','emphasis','label_anchor','visibility','line_break']);const errors=[];
  for(const op of patch?.operations??[]){if(!String(op.object_id??'').trim())errors.push('object_id required');if(!allowed.has(op.field))errors.push(`protected or unsupported finish field '${op.field}'`);}
  return errors;
}
