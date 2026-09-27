function overlap(a,b){return Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));}
function inside(r,b){return r.x>=b.left&&r.y>=b.top&&r.x+r.w<=b.right&&r.y+r.h<=b.bottom;}
function candidates(label){
  const w=label.w??Math.max(24,String(label.text??'').length*(label.font_size??10)*.56+8),h=label.h??(label.font_size??10)+8,gap=label.gap??6,x=label.x,y=label.y;
  return [
    {placement:'right',x:x+gap,y:y-h/2,w,h,anchor_x:x+gap,anchor_y:y},
    {placement:'left',x:x-gap-w,y:y-h/2,w,h,anchor_x:x-gap,anchor_y:y},
    {placement:'above',x:x-w/2,y:y-gap-h,w,h,anchor_x:x,anchor_y:y-gap},
    {placement:'below',x:x-w/2,y:y+gap,w,h,anchor_x:x,anchor_y:y+gap+h},
  ];
}
export function layoutLabels(labels,{bounds={left:0,top:0,right:1040,bottom:720},obstacles=[],max_labels=Infinity}={}){
  const placed=[],suppressed=[];
  const ordered=[...labels].sort((a,b)=>(b.priority??0)-(a.priority??0)||String(a.id).localeCompare(String(b.id)));
  for(const label of ordered){
    if(placed.length>=max_labels){suppressed.push({...label,reason:'density_budget'});continue;}
    let best=null;
    for(const c of candidates(label)){
      let cost=inside(c,bounds)?0:100000;
      for(const p of placed)cost+=overlap(c,p.rect)*100;
      for(const o of obstacles)cost+=overlap(c,o)*(o.weight??40);
      cost+=Math.hypot((c.x+c.w/2)-label.x,(c.y+c.h/2)-label.y)*.2;
      if(label.preferred&&c.placement!==label.preferred)cost+=10;
      if(!best||cost<best.cost)best={candidate:c,cost};
    }
    if(!best||best.cost>=100000){suppressed.push({...label,reason:'no_valid_candidate'});continue;}
    placed.push({id:label.id,text:label.text,priority:label.priority??0,placement:best.candidate.placement,rect:best.candidate,cost:best.cost,leader:{x1:label.x,y1:label.y,x2:best.candidate.anchor_x,y2:best.candidate.anchor_y}});
  }
  return {placed,suppressed,diagnostics:{placed_count:placed.length,suppressed_count:suppressed.length,total_cost:placed.reduce((a,p)=>a+p.cost,0)}};
}
