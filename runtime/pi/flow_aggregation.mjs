function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function bucket(v,size){return Math.floor(v/size)*size;}
function assertCompatible(rows,{semantics_field='geometry_semantics',unit_field='unit',time_field='time_window'}={}){
  for(const field of [semantics_field,unit_field,time_field]){
    const values=new Set(rows.map(r=>r?.[field]).filter(v=>v!==undefined&&v!==null&&v!==''));
    if(values.size>1)throw new Error(`Cannot aggregate incompatible ${field}: ${[...values].join(', ')}`);
  }
}
export function clusterFlowsGrid(rows,spec={}){
  assertCompatible(rows,spec);
  const cell=Math.max(.01,Number(spec.cell_deg)||5),groups=new Map();
  for(const row of rows){
    const slon=num(row[spec.source_lon_field]),slat=num(row[spec.source_lat_field]),tlon=num(row[spec.target_lon_field]),tlat=num(row[spec.target_lat_field]),value=num(row[spec.value_field]);
    if([slon,slat,tlon,tlat,value].some(v=>v===null))continue;
    const key=[bucket(slon,cell),bucket(slat,cell),bucket(tlon,cell),bucket(tlat,cell)].join('|');
    let g=groups.get(key);if(!g){g={key,value:0,count:0,source_lon_sum:0,source_lat_sum:0,target_lon_sum:0,target_lat_sum:0,members:[]};groups.set(key,g);}
    g.value+=value;g.count++;g.source_lon_sum+=slon;g.source_lat_sum+=slat;g.target_lon_sum+=tlon;g.target_lat_sum+=tlat;g.members.push(row);
  }
  return [...groups.values()].map(g=>({cluster_id:g.key,value:g.value,count:g.count,source_lon:g.source_lon_sum/g.count,source_lat:g.source_lat_sum/g.count,target_lon:g.target_lon_sum/g.count,target_lat:g.target_lat_sum/g.count}));
}
export function trajectoryDensityGrid(points,{cell_deg=.1}={}){
  const cell=Math.max(.0001,Number(cell_deg)||.1),cells=new Map();
  for(const p of points??[]){const lon=num(p.lon),lat=num(p.lat);if(lon===null||lat===null)continue;const x=bucket(lon,cell),y=bucket(lat,cell),key=`${x}|${y}`;let c=cells.get(key);if(!c){c={cell_id:key,west:x,east:x+cell,south:y,north:y+cell,count:0};cells.set(key,c);}c.count++;}
  return [...cells.values()].sort((a,b)=>b.count-a.count||a.cell_id.localeCompare(b.cell_id));
}
