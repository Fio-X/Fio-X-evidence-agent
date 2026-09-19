export const PUBLICATION_BINDING_VERSION='0.1.0';

const DATA_KEYS=new Set(['data','rows','values','x','y','z','labels','parents','source','target','value','node','link']);
export function assertViewSpecHasNoInlineData(value,path='view_spec'){
  if(value==null) return;
  if(Array.isArray(value)){
    if(value.length && value.every(v=>['string','number','boolean'].includes(typeof v))) throw new Error(`${path} contains inline data array`);
    value.forEach((v,i)=>assertViewSpecHasNoInlineData(v,`${path}[${i}]`));
    return;
  }
  if(typeof value!=='object') return;
  for(const [k,v] of Object.entries(value)){
    if(DATA_KEYS.has(k) && Array.isArray(v) && v.length) throw new Error(`${path}.${k} contains inline data; bind a computation instead`);
    assertViewSpecHasNoInlineData(v,`${path}.${k}`);
  }
}

function field(mapping,name,required=true){const v=String(mapping?.[name]??'').trim();if(required&&!v)throw new Error(`field_mapping.${name} is required`);return v||null;}
function fieldAny(mapping,names,required=true){for(const name of names){const v=String(mapping?.[name]??'').trim();if(v)return v;}if(required)throw new Error(`field_mapping.${names[0]} is required`);return null;}
function col(rows,key){return rows.map(r=>r?.[key]);}
function finiteNumber(v){const n=Number(v);return Number.isFinite(n)?n:null;}

function networkFromRows(module,rows,mapping,view){
  const sf=fieldAny(mapping,['source','source_field']),tf=fieldAny(mapping,['target','target_field']),lf=fieldAny(mapping,['label','label_field','country','country_field'],false),wf=fieldAny(mapping,['weight','weight_field','value','value_field'],false);
  const nodes=new Map(),edges=[];
  const ensure=(id,row)=>{
    const key=String(id??'').trim();
    if(!key)return null;
    if(!nodes.has(key))nodes.set(key,{id:key,label:lf?String(row?.[lf]??key):key,degree:0,community:0});
    return nodes.get(key);
  };
  for(const row of rows){
    const source=ensure(row?.[sf],row),target=ensure(row?.[tf],row);
    if(!source||!target||source.id===target.id)continue;
    const weight=wf?finiteNumber(row?.[wf]):1;
    if(weight==null||weight<0)throw new Error(`module '${module.id}' has an invalid network weight`);
    source.degree+=1;target.degree+=1;edges.push({source:source.id,target:target.id,weight});
  }
  const adjacency=new Map([...nodes].map(([id])=>[id,[]]));
  for(const edge of edges){adjacency.get(edge.source).push(edge.target);adjacency.get(edge.target).push(edge.source);}
  let community=0;
  for(const id of [...nodes.keys()].sort()){
    if(nodes.get(id).community)continue;
    community+=1;const queue=[id];nodes.get(id).community=community;
    for(let i=0;i<queue.length;i++)for(const next of [...new Set(adjacency.get(queue[i])??[])].sort()){
      if(nodes.get(next).community)continue;nodes.get(next).community=community;queue.push(next);
    }
  }
  const ordered=[...nodes.values()].sort((a,b)=>b.degree-a.degree||a.id.localeCompare(b.id));
  const radius=Number(view.radius??1);
  const count=Math.max(1,ordered.length);
  const positioned=ordered.map((node,index)=>({
    ...node,
    // A deterministic circular frame is a portable schematic layout. It is
    // never presented as geographic or physical geometry.
    x:count===1?0:Math.cos((index/count)*Math.PI*2)*radius,
    y:count===1?0:Math.sin((index/count)*Math.PI*2)*radius,
  }));
  return {nodes:positioned,edges,label_policy:view.label_policy??'key',controls:view.controls??[{id:'reset',label:'Reset focus',action:'reset',state:'network'}],layout_note:'Deterministic circular schematic layout; positions do not encode geography or causality.'};
}

export function buildEvidenceBoundModule(module,rows){
  const mapping=module.evidence_binding?.field_mapping??{};
  const view=module.view_spec??{};
  if(module.type==='stat'){
    const valueField=field(mapping,'value');
    const rowIndex=Math.max(0,Math.min(rows.length-1,Number(view.row_index??0)));
    if(!rows.length) throw new Error(`module '${module.id}' has no bound rows`);
    return {...module,value:rows[rowIndex]?.[valueField],unit:module.unit??view.unit,_a11y_rows:rows.slice(0,200)};
  }
  if(module.type==='model'&&String(module.visual_type||view.visual_type||'')==='network'){
    return {...module,engine:'native_canvas',visual_type:'network',spec:networkFromRows(module,rows,mapping,view),_a11y_rows:rows.slice(0,200)};
  }
  if(module.type!=='plotly') return {...module,spec:{...(module.spec??{}),rows,evidence_binding:module.evidence_binding,view_spec:view}};
  const type=String(module.visual_type||view.visual_type||'statistical');
  let data=[]; let layout={...(view.layout??{})}; let controls=view.controls??[];
  if(type==='statistical'){
    const x=field(mapping,'x'),y=field(mapping,'y'); const mark=String(view.mark??'scatter'); const seriesField=field(mapping,'series',false);
    if(seriesField){const groups=new Map();for(const r of rows){const key=String(r?.[seriesField]??'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}for(const [name,rs] of groups)data.push({type:mark==='bar'?'bar':'scatter',mode:mark==='line'?'lines+markers':mark==='scatter'?'markers':undefined,name,x:col(rs,x),y:col(rs,y)});}
    else data=[{type:mark==='bar'?'bar':'scatter',mode:mark==='line'?'lines+markers':mark==='scatter'?'markers':undefined,x:col(rows,x),y:col(rows,y),name:view.series_label??module.title??''}];
  } else if(type==='sankey'){
    const sf=fieldAny(mapping,['source','source_field']),tf=fieldAny(mapping,['target','target_field']),vf=fieldAny(mapping,['value','value_field']); const labels=[]; const idx=new Map(); const get=v=>{const s=String(v);if(!idx.has(s)){idx.set(s,labels.length);labels.push(s);}return idx.get(s)};
    const source=[],target=[],value=[];for(const r of rows){source.push(get(r?.[sf]));target.push(get(r?.[tf]));const n=finiteNumber(r?.[vf]);if(n==null)throw new Error(`module '${module.id}' has non-numeric Sankey value`);value.push(n);}
    data=[{type:'sankey',node:{label:labels,pad:view.node_pad??15,thickness:view.node_thickness??18},link:{source,target,value}}];
  } else if(['treemap','sunburst','icicle'].includes(type)){
    const lf=field(mapping,'label'),pf=field(mapping,'parent'),vf=field(mapping,'value'); data=[{type,labels:col(rows,lf).map(String),parents:col(rows,pf).map(v=>v==null?'':String(v)),values:col(rows,vf).map(v=>Number(v)),branchvalues:view.branchvalues??'total'}];
  } else if(type==='uncertainty_band'){
    const xf=field(mapping,'x'),lf=field(mapping,'lower'),cf=field(mapping,'central'),uf=field(mapping,'upper'); const x=col(rows,xf),lower=col(rows,lf).map(Number),central=col(rows,cf).map(Number),upper=col(rows,uf).map(Number);
    data=[{type:'scatter',mode:'lines',x,y:upper,line:{width:0},hoverinfo:'skip',showlegend:false},{type:'scatter',mode:'lines',x,y:lower,fill:'tonexty',name:view.band_label??'Interval',line:{width:0}},{type:'scatter',mode:'lines+markers',x,y:central,name:view.central_label??'Central estimate'}];
  } else if(type==='parallel_coordinates'){
    const dims=Array.isArray(mapping.dimensions)?mapping.dimensions:[]; if(!dims.length) throw new Error('field_mapping.dimensions is required'); data=[{type:'parcoords',dimensions:dims.map(d=>({label:d.label??d.field,values:col(rows,d.field).map(Number)}))}];
  } else if(type==='geo_linked'){
    const lon=fieldAny(mapping,['lon','longitude','lon_field'],false),lat=fieldAny(mapping,['lat','latitude','lat_field'],false),location=fieldAny(mapping,['location','location_field','iso_code','country_code','country_field'],false),label=fieldAny(mapping,['label','label_field','country','country_field'],false),size=fieldAny(mapping,['size','size_field'],false),color=fieldAny(mapping,['color','color_field','value','value_field'],false);
    if((lon&&!lat)||(!lon&&lat)) throw new Error(`module '${module.id}' geo_linked requires both lon_field and lat_field`);
    if(!lon&&!location) throw new Error(`module '${module.id}' geo_linked requires lon/lat fields or a location_field with ISO-3 codes`);
    const marker={size:size?col(rows,size).map(v=>finiteNumber(v)??0):10,sizemode:view.sizemode??'area',sizemin:view.sizemin??4,color:color?col(rows,color).map(v=>finiteNumber(v)??0):undefined,colorscale:view.colorscale??'Viridis',showscale:Boolean(color),colorbar:color?{title:view.colorbar_title??color}:undefined};
    const trace={type:'scattergeo',mode:view.mode??'markers',text:label?col(rows,label).map(String):undefined,marker};
    if(lon&&lat){trace.lon=col(rows,lon).map(v=>finiteNumber(v));trace.lat=col(rows,lat).map(v=>finiteNumber(v));trace.hovertemplate=view.hovertemplate??(label?`%{text}<br>lon=%{lon:.2f}<br>lat=%{lat:.2f}<extra></extra>`:'lon=%{lon:.2f}<br>lat=%{lat:.2f}<extra></extra>');}
    else {const locations=col(rows,location).map(v=>String(v??'').trim());const iso3=locations.filter(Boolean).length>0&&locations.filter(Boolean).every(v=>/^[A-Z]{3}$/.test(v.toUpperCase()));trace.locations=iso3?locations.map(v=>v.toUpperCase()):locations;trace.locationmode=view.locationmode??(iso3?'ISO-3':'country names');trace.hovertemplate=view.hovertemplate??(label?`%{text}<br>%{location}<extra></extra>`:'%{location}<extra></extra>');}
    data=[trace];
    layout={geo:{projection:{type:view.projection??'natural earth'},showland:true,landcolor:view.landcolor??'#e8e4da',showocean:true,oceancolor:view.oceancolor??'#e8eeee',showcountries:true,countrycolor:view.countrycolor??'#c7c0b5',...((view.layout??{}).geo??{})},...layout};
  } else throw new Error(`evidence-bound Plotly visual_type '${type}' is unsupported; use a validated map/analysis/model artifact or add a deterministic compiler`);
  return {...module,spec:{visual_type:type,figure:{data,layout,config:view.config??{}},controls,evidence_binding:module.evidence_binding},_a11y_rows:rows.slice(0,200)};
}
