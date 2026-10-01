import { requireBasemap } from './basemap_registry.mjs';
import { assertMapSpec } from './map_spec.mjs';

function ringCoords(geometry){
  const out=[];
  if(!geometry)return out;
  if(geometry.type==='Polygon') for(const ring of geometry.coordinates) out.push(ring);
  if(geometry.type==='MultiPolygon') for(const poly of geometry.coordinates) for(const ring of poly) out.push(ring);
  return out;
}
function lineFeatureCoords(features){const x=[],y=[];for(const f of features||[]){const g=f.geometry||{};const lines=g.type==='LineString'?[g.coordinates]:g.type==='MultiLineString'?g.coordinates:[];for(const line of lines){for(const p of line){x.push(p[0]);y.push(p[1]);}x.push(null);y.push(null);}}return {x,y};}
function basemapTrace(entry){
  const x=[],y=[];
  for(const f of entry.data.features||[]) for(const ring of ringCoords(f.geometry)){for(const p of ring){x.push(p[0]);y.push(p[1]);}x.push(null);y.push(null);}
  return {type:'scatter',mode:'lines',x,y,line:{width:.45,color:'#c3cbc6'},fill:'toself',fillcolor:'#f2f4f1',hoverinfo:'skip',showlegend:false,name:'Land context'};
}
function obsTrace(layer,pts){
const vals=pts.map(p=>p.value).filter(Number.isFinite);const hasValue=vals.length===pts.length&&vals.length>0;
  const marker={size:pts.map(p=>Math.max(6,Math.min(18,6+Number(p.size_value??p.value??0)*1.4))),opacity:.82,line:{width:.7,color:'#ffffff'}};
  if(hasValue){marker.color=pts.map(p=>p.value);marker.colorscale=[[0,'#d9e4df'],[.5,'#789b8e'],[1,'#274f44']];marker.showscale=Boolean(layer.encoding?.show_colorbar);marker.colorbar={title:layer.encoding?.colorbar_title||layer.unit||''};}
  else marker.color='#3f675c';
  return {type:'scatter',mode:pts.length<=4?'markers+text':'markers',x:pts.map(p=>p.lon),y:pts.map(p=>p.lat),text:pts.map(p=>pts.length<=4?(p.value!=null?`M ${p.value}`:String(p.label||p.id||'')):`${p.label||p.id||'Observation'}${p.value!=null?`<br>${p.value}${layer.unit?` ${layer.unit}`:''}`:''}${p.uncertainty_km!=null?`<br>Uncertainty: ${p.uncertainty_km} km`:''}`),textposition:'top center',textfont:{size:11,color:'#17191b'},hovertext:pts.map(p=>`${p.label||p.id||'Observation'}${p.value!=null?`<br>${p.value}${layer.unit?` ${layer.unit}`:''}`:''}${p.uncertainty_km!=null?`<br>Uncertainty: ${p.uncertainty_km} km`:''}`),hoverinfo:'text',name:layer.label||layer.id,marker};
}
const POINT_SYMBOLS=['circle','circle-open','square','square-open','diamond','diamond-open'];
const LINE_DASHES=['solid','dash','dot','dashdot','longdash','longdashdot'];
export const DIRECT_LABEL_MAX=12;
// Split a polyline where it crosses the antimeridian so no segment is drawn
// straight across the whole map; the crossing latitude is interpolated.
export function splitAntimeridian(coords){
  const segs=[];let cur=[coords[0]];
  for(let i=1;i<coords.length;i++){const a=coords[i-1],b=coords[i];
    if(Math.abs(b[0]-a[0])>180){const edge=a[0]>0?180:-180;const bu=b[0]+(a[0]>0?360:-360);const t=(edge-a[0])/(bu-a[0]);const lat=a[1]+t*(b[1]-a[1]);cur.push([edge,lat]);segs.push(cur);cur=[[-edge,lat],b];}
    else cur.push(b);}
  segs.push(cur);return segs;
}
function labelAnchor(parts){let best=parts[0];for(const p of parts)if(p.length>best.length)best=p;const m=Math.floor(best.length/2);return best.length%2?best[m]:[(best[m-1][0]+best[m][0])/2,(best[m-1][1]+best[m][1])/2];}
// Reference layers carry no measured value: coordinates, a name and a source.
// Coordinates come only from a resolution built by map_reference_layers.mjs.
function referenceTraces(spec,resolution){
  const layers=(spec.layers||[]).filter(l=>l.type==='reference_points'||l.type==='reference_lines'||l.type==='line');
  const all=[];for(const l of layers){const r=resolution?.layers?.[l.id];if(!r)continue;r.features.forEach(f=>all.push({layer:l,res:r,f}));}
  const total=all.length;const direct=total<=DIRECT_LABEL_MAX;
  const traces=[],feats=[],list=[];let n=0;
  for(const l of layers){const r=resolution?.layers?.[l.id];if(!r)continue;
    const isPts=r.kind==='points';const statuses=r.statuses.length?r.statuses:[null];
    const labelX=[],labelY=[],labelT=[];
    statuses.forEach((st,si)=>{
      const fs=r.features.filter(f=>f.status===st);if(!fs.length)return;
      const col=l.encoding?.color||'#3f675c';const name=st===null?(l.label||l.id):`${l.label||l.id}: ${st}`;
      if(isPts){
        const x=[],y=[],t=[];
        for(const f of fs){n++;const c=f.parts[0][0];x.push(c[0]);y.push(c[1]);const shown=direct?f.name:String(n);t.push(shown);feats.push({layer:l.id,n,name:f.name,status:f.status,visible_as:direct?'label':'list'});if(!direct)list.push({n,name:f.name,status:f.status});}
        const sym=POINT_SYMBOLS[si%POINT_SYMBOLS.length];
        traces.push({type:'scatter',mode:'markers+text',x,y,text:t,textposition:'top center',textfont:{size:11,color:'#17191b'},hovertext:fs.map(f=>f.name),hoverinfo:'text',name,showlegend:r.statuses.length>0,marker:{size:9,symbol:sym,color:col,line:{width:1.6,color:col}}});
      } else {
        const x=[],y=[];
        for(const f of fs){n++;for(const part of f.parts)for(const seg of splitAntimeridian(part)){for(const c of seg){x.push(c[0]);y.push(c[1]);}x.push(null);y.push(null);}
          const a=labelAnchor(f.parts.length>1?f.parts:splitAntimeridian(f.parts[0]));labelX.push(a[0]);labelY.push(a[1]);labelT.push(direct?f.name:String(n));
          feats.push({layer:l.id,n,name:f.name,status:f.status,visible_as:direct?'label':'list'});if(!direct)list.push({n,name:f.name,status:f.status});}
        traces.push({type:'scatter',mode:'lines',x,y,hoverinfo:'name',name,showlegend:r.statuses.length>0,line:{width:l.encoding?.width||2.4,color:col,dash:LINE_DASHES[si%LINE_DASHES.length]}});
      }
    });
    if(!isPts&&labelT.length)traces.push({type:'scatter',mode:'text',x:labelX,y:labelY,text:labelT,textposition:'top center',textfont:{size:11,color:'#17191b'},hoverinfo:'skip',showlegend:false,name:`${l.label||l.id} names`});
  }
  return {traces,feats,list,direct};
}
// QA: every reference feature must have a visible name, either drawn beside
// it or listed under its number. Works on the compiled figure alone.
export function qaReferenceNames(compiled){
  const issues=[];const data=compiled?.figure?.data||[];const ann=(compiled?.figure?.layout?.annotations||[]).map(a=>String(a.text||'')).join('\n');
  for(const f of compiled?.reference_features||[]){
    const texts=data.flatMap(t=>[].concat(t.text||[]).map(String));
    if(f.visible_as==='label'){if(!texts.includes(f.name))issues.push({rule:'reference_name_not_visible',name:f.name});}
    else if(!(ann.split(/<br>|\n/).includes(`${f.n}. ${f.name}`)&&texts.includes(String(f.n))))issues.push({rule:'reference_name_not_visible',name:f.name});
  }
  return issues;
}
function scaleBar(spec){
  const e=spec.extent;const mid=(e.south+e.north)/2;const kmPerDeg=111.32*Math.max(.1,Math.cos(mid*Math.PI/180));const spanKm=(e.east-e.west)*kmPerDeg;const target=spec.scale.length_km||Math.max(10,Math.pow(10,Math.floor(Math.log10(spanKm/5))));const deg=target/kmPerDeg;const x0=e.west+(e.east-e.west)*.06;const y=e.south+(e.north-e.south)*.07;return {shape:{type:'line',x0,y0:y,x1:x0+deg,y1:y,line:{color:'#17191b',width:1.2}},annotation:{x:x0+deg/2,y:y,xref:'x',yref:'y',text:`${target} km`,showarrow:false,yshift:11,font:{size:11,color:'#17191b'}}};
}
export function compileScientificMap(spec,resolution=null){
  const gate=assertMapSpec(spec);let data=[];if(spec.basemap_asset){const c=lineFeatureCoords(spec.basemap_asset.features);data.push({type:'scatter',mode:'lines',x:c.x,y:c.y,line:{width:.55,color:'#9ba8a1'},hoverinfo:'skip',showlegend:false,name:'Physical context'});}else{const base=requireBasemap(spec.basemap_id);data=[basemapTrace(base)];}
  const rendered=new Set();
  for(const l of spec.layers||[]){if(l.type==='observations'){const pts=resolution?.layers?.[l.id]?.points;if(!Array.isArray(pts)||!pts.length)throw new Error(`MAP_LAYER_NOT_RESOLVED: ${l.id} has no points resolved from its pinned source`);data.push(obsTrace(l,pts));rendered.add(l.id);}}
  const ref=referenceTraces(spec,resolution);for(const t of ref.traces)data.push(t);
  for(const l of spec.layers||[])if(resolution?.layers?.[l.id])rendered.add(l.id);
  // Add-only guard: a layer that passed validation must produce output, so a
  // declared layer can never vanish silently from the figure.
  const missing=(spec.layers||[]).filter(l=>!rendered.has(l.id)).map(l=>l.id);
  if(missing.length)throw new Error(`MAP_LAYER_NOT_RENDERED: ${missing.join(', ')}`);
  const sb=scaleBar(spec);const e=spec.extent;const midLat=(e.south+e.north)/2;const aspect=1/Math.max(.2,Math.cos(midLat*Math.PI/180));
  const compiled={schema_version:'0.1.0',renderer:'plotly_browser',visual_type:'scientific_map',map_gate:gate,figure:{data,layout:{margin:{l:52,r:22,t:16,b:48},showlegend:false,xaxis:{range:[e.west,e.east],title:'Longitude',showgrid:true,gridcolor:'#e3e7e4',zeroline:false,constrain:'domain',dtick:spec.graticule?.lon_step||undefined},yaxis:{range:[e.south,e.north],title:'Latitude',showgrid:true,gridcolor:'#e3e7e4',zeroline:false,scaleanchor:'x',scaleratio:aspect,constrain:'domain',dtick:spec.graticule?.lat_step||undefined},shapes:[sb.shape],annotations:[sb.annotation],paper_bgcolor:'#ffffff',plot_bgcolor:'#ffffff'},config:{displaylogo:false,responsive:true,scrollZoom:false}},controls:[]};
  if(ref.feats.length){
    const hasLegend=ref.traces.some(t=>t.showlegend);const lay=compiled.figure.layout;
    if(hasLegend){lay.showlegend=true;lay.legend={orientation:'h',x:0,y:-0.14,font:{size:11}};lay.margin.b=96;}
    if(!ref.direct){lay.margin.r=250;lay.annotations=[...lay.annotations,{xref:'paper',yref:'paper',x:1.01,y:1,xanchor:'left',yanchor:'top',align:'left',showarrow:false,font:{size:11,color:'#17191b'},text:ref.list.map(x=>`${x.n}. ${x.name}`).join('<br>')}];}
    compiled.reference_features=ref.feats;compiled.name_list=ref.list;
    const issues=qaReferenceNames(compiled);if(issues.length)throw new Error(`MAP_REFERENCE_NAME_NOT_VISIBLE: ${issues.map(x=>x.name).join(', ')}`);
  }
  return compiled;
}
