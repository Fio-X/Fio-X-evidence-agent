export const RENDER_BACKENDS=['svg','canvas2d','webgl_map'];
export function estimateRenderCost({path_count=0,point_count=0,label_count=0,redraw_hz=0,interaction=false,geographic=false,print_export=false}={}){
  return {path_count,point_count,label_count,redraw_hz,interaction:Boolean(interaction),geographic:Boolean(geographic),print_export:Boolean(print_export),complexity:path_count*4+point_count+label_count*12+redraw_hz*100};
}
export function chooseRenderer(input,{available_backends=['svg']}={}){
  const cost=estimateRenderCost(input);let desired='svg',reason='semantic text and export fidelity dominate';
  if(cost.geographic&&(cost.point_count>50000||cost.path_count>5000||cost.redraw_hz>5)){desired='webgl_map';reason='dense geographic marks or redraw rate exceed static SVG budget';}
  else if(cost.point_count>25000||cost.path_count>3000||cost.redraw_hz>8){desired='canvas2d';reason='dense immediate-mode marks exceed retained SVG budget';}
  if(cost.print_export&&cost.label_count>0){desired='svg';reason='print/export plus semantic labels require vector text';}
  const selected=available_backends.includes(desired)?desired:(available_backends.includes('svg')?'svg':available_backends[0]);
  return {schema_version:'1.0.0',cost,desired_backend:desired,selected_backend:selected,fallback_backend:selected===desired?null:selected,reason,capability_status:selected===desired?'native':'fallback'};
}
