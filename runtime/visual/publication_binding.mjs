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
function col(rows,key){return rows.map(r=>r?.[key]);}
function finiteNumber(v){const n=Number(v);return Number.isFinite(n)?n:null;}

export function buildEvidenceBoundModule(module,rows){
  const mapping=module.evidence_binding?.field_mapping??{};
  const view=module.view_spec??{};
  if(module.type==='stat'){
    const valueField=field(mapping,'value');
    const rowIndex=Math.max(0,Math.min(rows.length-1,Number(view.row_index??0)));
    if(!rows.length) throw new Error(`module '${module.id}' has no bound rows`);
    return {...module,value:rows[rowIndex]?.[valueField],unit:module.unit??view.unit,_a11y_rows:rows.slice(0,200)};
  }
  if(module.type!=='plotly') return {...module,spec:{...(module.spec??{}),rows,evidence_binding:module.evidence_binding,view_spec:view}};
  const type=String(module.visual_type||view.visual_type||'statistical');
  let data=[]; let layout={...(view.layout??{})}; let controls=view.controls??[];
  if(type==='statistical'){
    const x=field(mapping,'x'),y=field(mapping,'y'); const mark=String(view.mark??'scatter'); const seriesField=field(mapping,'series',false);
    if(seriesField){const groups=new Map();for(const r of rows){const key=String(r?.[seriesField]??'');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}for(const [name,rs] of groups)data.push({type:mark==='bar'?'bar':'scatter',mode:mark==='line'?'lines+markers':mark==='scatter'?'markers':undefined,name,x:col(rs,x),y:col(rs,y)});}
    else data=[{type:mark==='bar'?'bar':'scatter',mode:mark==='line'?'lines+markers':mark==='scatter'?'markers':undefined,x:col(rows,x),y:col(rows,y),name:view.series_label??module.title??''}];
  } else if(type==='sankey'){
    const sf=field(mapping,'source'),tf=field(mapping,'target'),vf=field(mapping,'value'); const labels=[]; const idx=new Map(); const get=v=>{const s=String(v);if(!idx.has(s)){idx.set(s,labels.length);labels.push(s);}return idx.get(s)};
    const source=[],target=[],value=[];for(const r of rows){source.push(get(r?.[sf]));target.push(get(r?.[tf]));const n=finiteNumber(r?.[vf]);if(n==null)throw new Error(`module '${module.id}' has non-numeric Sankey value`);value.push(n);}
    data=[{type:'sankey',node:{label:labels,pad:view.node_pad??15,thickness:view.node_thickness??18},link:{source,target,value}}];
  } else if(['treemap','sunburst','icicle'].includes(type)){
    const lf=field(mapping,'label'),pf=field(mapping,'parent'),vf=field(mapping,'value'); data=[{type,labels:col(rows,lf).map(String),parents:col(rows,pf).map(v=>v==null?'':String(v)),values:col(rows,vf).map(v=>Number(v)),branchvalues:view.branchvalues??'total'}];
  } else if(type==='uncertainty_band'){
    const xf=field(mapping,'x'),lf=field(mapping,'lower'),cf=field(mapping,'central'),uf=field(mapping,'upper'); const x=col(rows,xf),lower=col(rows,lf).map(Number),central=col(rows,cf).map(Number),upper=col(rows,uf).map(Number);
    data=[{type:'scatter',mode:'lines',x,y:upper,line:{width:0},hoverinfo:'skip',showlegend:false},{type:'scatter',mode:'lines',x,y:lower,fill:'tonexty',name:view.band_label??'Interval',line:{width:0}},{type:'scatter',mode:'lines+markers',x,y:central,name:view.central_label??'Central estimate'}];
  } else if(type==='parallel_coordinates'){
    const dims=Array.isArray(mapping.dimensions)?mapping.dimensions:[]; if(!dims.length) throw new Error('field_mapping.dimensions is required'); data=[{type:'parcoords',dimensions:dims.map(d=>({label:d.label??d.field,values:col(rows,d.field).map(Number)}))}];
  } else throw new Error(`evidence-bound Plotly visual_type '${type}' is unsupported; use a validated map/analysis/model artifact or add a deterministic compiler`);
  return {...module,spec:{visual_type:type,figure:{data,layout,config:view.config??{}},controls,evidence_binding:module.evidence_binding},_a11y_rows:rows.slice(0,200)};
}
