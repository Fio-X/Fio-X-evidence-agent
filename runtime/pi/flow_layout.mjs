import { createHash } from 'node:crypto';

function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function stableSign(value){const h=createHash('sha256').update(String(value)).digest();return (h[0]&1)?1:-1;}
function quadraticPoint(a,c,b,t){const u=1-t;return{x:u*u*a.x+2*u*t*c.x+t*t*b.x,y:u*u*a.y+2*u*t*c.y+t*t*b.y};}
function quadraticCandidate(a,b,bend){
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.max(1,Math.hypot(dx,dy)),nx=-dy/len,ny=dx/len,c={x:(a.x+b.x)/2+nx*bend,y:(a.y+b.y)/2+ny*bend};
  const points=Array.from({length:13},(_,i)=>quadraticPoint(a,c,b,i/12)),mid=quadraticPoint(a,c,b,.5);
  return{d:`M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`,control:c,points,mid};
}
function orient(a,b,c){return(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);}
function properSegmentIntersection(a,b,c,d){
  const o1=orient(a,b,c),o2=orient(a,b,d),o3=orient(c,d,a),o4=orient(c,d,b),eps=1e-7;
  return ((o1>eps&&o2<-eps)||(o1<-eps&&o2>eps))&&((o3>eps&&o4<-eps)||(o3<-eps&&o4>eps));
}
function pointSegDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(l2<1e-9)return Math.hypot(p.x-a.x,p.y-a.y);const t=clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/l2,0,1),x=a.x+t*dx,y=a.y+t*dy;return Math.hypot(p.x-x,p.y-y);}
function polylineCrossings(a,b){let n=0;for(let i=1;i<a.length;i++)for(let j=1;j<b.length;j++)if(properSegmentIntersection(a[i-1],a[i],b[j-1],b[j]))n++;return n;}
function samePoint(a,b,tol=5){return Math.hypot(a.x-b.x,a.y-b.y)<=tol;}
function indexKey(item){return item.key??item.index;}

export function optimizeAbstractOdRoutes(items,bounds={}){
  const prepared=items.map((item,index)=>({...item,index,len:Math.hypot(item.b.x-item.a.x,item.b.y-item.a.y)}));
  const endpoints=prepared.flatMap(item=>[{p:item.a,route:indexKey(item)},{p:item.b,route:indexKey(item)}]);
  const chosen=[];
  for(const item of prepared){
    const base=Math.min(88,Math.max(14,item.len*.17)),preferred=stableSign(item.key),magnitudes=[base*.7,base*1.15],candidates=[];
    for(const sign of [preferred,-preferred])for(const mag of magnitudes)candidates.push(quadraticCandidate(item.a,item.b,sign*mag));
    let best=null;
    for(let ci=0;ci<candidates.length;ci++){
      const c=candidates[ci];let crossings=0,nodeIntrusions=0,boundary=0;
      for(const prior of chosen){if(samePoint(item.a,prior.item.a)||samePoint(item.a,prior.item.b)||samePoint(item.b,prior.item.a)||samePoint(item.b,prior.item.b))continue;crossings+=polylineCrossings(c.points,prior.points);}
      for(const ep of endpoints){if(ep.route===indexKey(item)||samePoint(ep.p,item.a)||samePoint(ep.p,item.b))continue;let d=Infinity;for(let i=1;i<c.points.length;i++)d=Math.min(d,pointSegDistance(ep.p,c.points[i-1],c.points[i]));if(d<9)nodeIntrusions+=1;}
      if(Number.isFinite(bounds.left)&&c.control.x<bounds.left)boundary+=(bounds.left-c.control.x)/10;
      if(Number.isFinite(bounds.right)&&c.control.x>bounds.right)boundary+=(c.control.x-bounds.right)/10;
      if(Number.isFinite(bounds.top)&&c.control.y<bounds.top)boundary+=(bounds.top-c.control.y)/10;
      if(Number.isFinite(bounds.bottom)&&c.control.y>bounds.bottom)boundary+=(c.control.y-bounds.bottom)/10;
      const score=crossings*100+nodeIntrusions*16+boundary+Math.abs(c.control.x-(item.a.x+item.b.x)/2)*.0001+ci*.00001;
      if(!best||score<best.score)best={...c,score,crossings,nodeIntrusions};
    }
    chosen.push({item,...best});
  }
  return chosen.sort((a,b)=>a.item.index-b.item.index);
}

export function abstractOdPath(a,b,key,rank=0){
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.max(1,Math.hypot(dx,dy)),base=Math.min(68,len*0.16)+Math.min(24,rank*4);
  return quadraticCandidate(a,b,stableSign(key)*base).d;
}

export function flowLayoutDiagnostics(layout){
  return layout.reduce((acc,item)=>{acc.crossings+=item.crossings??0;acc.node_intrusions+=item.nodeIntrusions??0;acc.total_cost+=item.score??0;return acc;},{crossings:0,node_intrusions:0,total_cost:0});
}
