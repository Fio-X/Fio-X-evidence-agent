import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import louvain from 'graphology-communities-louvain';

function fnv1a32(text){
  let h=0x811c9dc5;
  for(const ch of String(text)){ h^=ch.codePointAt(0); h=Math.imul(h,0x01000193)>>>0; }
  return h>>>0;
}

function deterministicPosition(id,index,total){
  const h=fnv1a32(id);
  const jitter=((h&0xffff)/0xffff-0.5)*0.12;
  const angle=(2*Math.PI*((index+0.5)/Math.max(total,1)))+jitter;
  const radius=1+(((h>>>16)&0xff)/255)*0.08;
  return {x:Math.cos(angle)*radius,y:Math.sin(angle)*radius};
}

export function buildGraphologyGraph(spec){
  const graph=new Graph({type:spec.directed?'directed':'undirected',multi:false,allowSelfLoops:false});
  const nodes=[...spec.nodes].map(n=>({...n,id:String(n.id)})).sort((a,b)=>a.id.localeCompare(b.id));
  nodes.forEach((n,i)=>{
    const pos=(Number.isFinite(Number(n.x))&&Number.isFinite(Number(n.y)))?{x:Number(n.x),y:Number(n.y)}:deterministicPosition(n.id,i,nodes.length);
    graph.addNode(n.id,{label:n.label??n.id,size:Number(n.size??3),...pos,...n.attributes});
  });
  const edges=[...spec.edges].map((e,i)=>({...e,_i:i,source:String(e.source),target:String(e.target)})).sort((a,b)=>a.source.localeCompare(b.source)||a.target.localeCompare(b.target)||a._i-b._i);
  for(const e of edges){
    if(graph.hasNode(e.source)&&graph.hasNode(e.target)&&!graph.hasEdge(e.source,e.target)) graph.addEdge(e.source,e.target,{weight:Number(e.weight??1),...e.attributes});
  }
  if(spec.community!==false&&graph.size>0) louvain.assign(graph,{getEdgeWeight:'weight'});
  if(spec.layout!=='fixed'&&graph.order>1&&graph.size>0) forceAtlas2.assign(graph,{iterations:Number(spec.iterations??80),settings:forceAtlas2.inferSettings(graph)});
  return graph;
}

export function graphSnapshot(graph){
  return {
    nodes:graph.nodes().sort().map(id=>({id,...graph.getNodeAttributes(id)})),
    edges:graph.edges().sort().map(key=>({key,source:graph.source(key),target:graph.target(key),...graph.getEdgeAttributes(key)}))
  };
}

export function mountSigma(container,spec){ const graph=buildGraphologyGraph(spec); return new Sigma(graph,container,spec.sigmaSettings??{}); }
