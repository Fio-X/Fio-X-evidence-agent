function rect(x,y,w,h){return{x,y,w,h};}
export function solveVisualScene(scene,{width=1040,height=720,margin=40}={}){
  const placements=new Map();const nodes=scene.nodes??[];if(!nodes.length)return{placements:{},width,height};
  const hero=nodes[0];placements.set(hero.id,rect(margin,margin,Math.round(width*.62),Math.round(height*.62)));
  for(let i=1;i<nodes.length;i++){
    const n=nodes[i],rel=(scene.relations??[]).find(r=>r.from===n.id),target=placements.get(rel?.to)??placements.get(hero.id),placement=rel?.placement??'below';let p;
    if(placement==='right'||placement==='right_rail')p=rect(Math.min(width-margin-260,target.x+target.w+24),target.y,Math.max(180,width-(target.x+target.w+24)-margin),Math.min(target.h,180));
    else p=rect(target.x,Math.min(height-margin-140,target.y+target.h+24),target.w,120);
    const ad=n.art_direction??{};if(ad.position){p.x=Number(ad.position.x??p.x);p.y=Number(ad.position.y??p.y);}if(ad.size){p.w=Number(ad.size.w??p.w);p.h=Number(ad.size.h??p.h);}placements.set(n.id,p);
  }
  return{width,height,placements:Object.fromEntries(placements)};
}
