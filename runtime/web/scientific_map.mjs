import { requireBasemap } from '../pi/basemap_registry.mjs';
import { assertMapSpec } from '../visual/map_spec.mjs';

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
function obsTrace(layer){
  const pts=layer.points||[];const vals=pts.map(p=>p.value).filter(Number.isFinite);const hasValue=vals.length===pts.length&&vals.length>0;
  const marker={size:pts.map(p=>Math.max(6,Math.min(18,6+Number(p.size_value??p.value??0)*1.4))),opacity:.82,line:{width:.7,color:'#ffffff'}};
  if(hasValue){marker.color=pts.map(p=>p.value);marker.colorscale=[[0,'#d9e4df'],[.5,'#789b8e'],[1,'#274f44']];marker.showscale=Boolean(layer.encoding?.show_colorbar);marker.colorbar={title:layer.encoding?.colorbar_title||layer.unit||''};}
  else marker.color='#3f675c';
  return {type:'scatter',mode:pts.length<=4?'markers+text':'markers',x:pts.map(p=>p.lon),y:pts.map(p=>p.lat),text:pts.map(p=>pts.length<=4?(p.value!=null?`M ${p.value}`:String(p.label||p.id||'')):`${p.label||p.id||'Observation'}${p.value!=null?`<br>${p.value}${layer.unit?` ${layer.unit}`:''}`:''}${p.uncertainty_km!=null?`<br>Uncertainty: ${p.uncertainty_km} km`:''}`),textposition:'top center',textfont:{size:11,color:'#17191b'},hovertext:pts.map(p=>`${p.label||p.id||'Observation'}${p.value!=null?`<br>${p.value}${layer.unit?` ${layer.unit}`:''}`:''}${p.uncertainty_km!=null?`<br>Uncertainty: ${p.uncertainty_km} km`:''}`),hoverinfo:'text',name:layer.label||layer.id,marker};
}
function scaleBar(spec){
  const e=spec.extent;const mid=(e.south+e.north)/2;const kmPerDeg=111.32*Math.max(.1,Math.cos(mid*Math.PI/180));const spanKm=(e.east-e.west)*kmPerDeg;const target=spec.scale.length_km||Math.max(10,Math.pow(10,Math.floor(Math.log10(spanKm/5))));const deg=target/kmPerDeg;const x0=e.west+(e.east-e.west)*.06;const y=e.south+(e.north-e.south)*.07;return {shape:{type:'line',x0,y0:y,x1:x0+deg,y1:y,line:{color:'#17191b',width:1.2}},annotation:{x:x0+deg/2,y:y,xref:'x',yref:'y',text:`${target} km`,showarrow:false,yshift:11,font:{size:11,color:'#17191b'}}};
}
export function compileScientificMap(spec){
  const gate=assertMapSpec(spec);let data=[];if(spec.basemap_asset){const c=lineFeatureCoords(spec.basemap_asset.features);data.push({type:'scatter',mode:'lines',x:c.x,y:c.y,line:{width:.55,color:'#9ba8a1'},hoverinfo:'skip',showlegend:false,name:'Physical context'});}else{const base=requireBasemap(spec.basemap_id);data=[basemapTrace(base)];}
  for(const l of spec.layers||[]){if(l.type==='observations')data.push(obsTrace(l));}
  const sb=scaleBar(spec);const e=spec.extent;const midLat=(e.south+e.north)/2;const aspect=1/Math.max(.2,Math.cos(midLat*Math.PI/180));
  return {schema_version:'0.1.0',renderer:'plotly_browser',visual_type:'scientific_map',map_gate:gate,figure:{data,layout:{margin:{l:52,r:22,t:16,b:48},showlegend:false,xaxis:{range:[e.west,e.east],title:'Longitude',showgrid:true,gridcolor:'#e3e7e4',zeroline:false,constrain:'domain',dtick:spec.graticule?.lon_step||undefined},yaxis:{range:[e.south,e.north],title:'Latitude',showgrid:true,gridcolor:'#e3e7e4',zeroline:false,scaleanchor:'x',scaleratio:aspect,constrain:'domain',dtick:spec.graticule?.lat_step||undefined},shapes:[sb.shape],annotations:[sb.annotation],paper_bgcolor:'#ffffff',plot_bgcolor:'#ffffff'},config:{displaylogo:false,responsive:true,scrollZoom:false}},controls:[]};
}
