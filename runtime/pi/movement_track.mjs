const EARTH_RADIUS_M = 6371008.8;
function rad(v){return v*Math.PI/180;}
function haversineM(a,b){
  const p1=rad(a.lat),p2=rad(b.lat),dp=rad(b.lat-a.lat),dl=rad(b.lon-a.lon);
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*EARTH_RADIUS_M*Math.asin(Math.min(1,Math.sqrt(h)));
}
function pointLineDistanceM(p,a,b){
  // Local equirectangular approximation is stable for editorial simplification spans.
  const lat0=rad((a.lat+b.lat+p.lat)/3), kx=111320*Math.cos(lat0), ky=110540;
  const ax=a.lon*kx, ay=a.lat*ky, bx=b.lon*kx, by=b.lat*ky, px=p.lon*kx, py=p.lat*ky;
  const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
  if(l2<1e-9)return Math.hypot(px-ax,py-ay);
  const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/l2));
  return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
}
function douglasPeucker(points,toleranceM){
  if(points.length<=2||toleranceM<=0)return points.slice();
  let max=-1,index=-1;
  for(let i=1;i<points.length-1;i++){const d=pointLineDistanceM(points[i],points[0],points.at(-1));if(d>max){max=d;index=i;}}
  if(max<=toleranceM)return [points[0],points.at(-1)];
  const left=douglasPeucker(points.slice(0,index+1),toleranceM),right=douglasPeucker(points.slice(index),toleranceM);
  return [...left.slice(0,-1),...right];
}
function finiteOrNull(value){const x=Number(value);return Number.isFinite(x)?x:null;}

export function normalizeMovementPoints(points,{gap_seconds=1800}={}){
  if(!Array.isArray(points))throw new Error('Movement points must be an array');
  const clean=[];let rejected=0,lastElapsed=-Infinity,derivedSegment=0,lastAccepted=null;
  for(const raw of points){
    const lon=finiteOrNull(raw?.lon),lat=finiteOrNull(raw?.lat),elapsed=finiteOrNull(raw?.elapsed_s);
    if(lon===null||lat===null||elapsed===null||lon < -180||lon > 180||lat < -90||lat > 90||elapsed<=lastElapsed){rejected++;continue;}
    if(lastAccepted&&elapsed-lastAccepted.elapsed_s>gap_seconds)derivedSegment++;
    const explicitSegment=finiteOrNull(raw.segment);
    const point={...raw,lon,lat,elapsed_s:elapsed,segment:explicitSegment===null?derivedSegment:explicitSegment};
    clean.push(point);lastAccepted=point;lastElapsed=elapsed;
  }
  return {clean_points:clean,rejected_points:rejected};
}

export function simplifyMovementPoints(points,{tolerance_m=0}={}){
  if(!Array.isArray(points)||points.length<=2)return points?.slice?.()??[];
  const groups=[];
  for(const p of points){let g=groups.at(-1);if(!g||g.segment!==p.segment){g={segment:p.segment,points:[]};groups.push(g);}g.points.push(p);}
  return groups.flatMap(g=>douglasPeucker(g.points,Number(tolerance_m)||0));
}

export function movementMetrics(rawPoints,cleanPoints,publicationPoints){
  const clean=cleanPoints??[],pub=publicationPoints??[];
  let distance=0,maxGap=0;
  for(let i=1;i<clean.length;i++){if(clean[i].segment===clean[i-1].segment)distance+=haversineM(clean[i-1],clean[i]);maxGap=Math.max(maxGap,clean[i].elapsed_s-clean[i-1].elapsed_s);}
  const duration=clean.length>1?clean.at(-1).elapsed_s-clean[0].elapsed_s:0;
  return {
    raw_point_count: rawPoints?.length??0,
    clean_point_count: clean.length,
    publication_point_count: pub.length,
    rejected_point_count: Math.max(0,(rawPoints?.length??0)-clean.length),
    segment_count: new Set(clean.map(p=>p.segment)).size,
    observed_duration_s: duration,
    largest_time_gap_s: maxGap,
    observed_distance_m: Math.round(distance),
    publication_retention_ratio: clean.length?pub.length/clean.length:0,
  };
}

export function buildMovementTrack({track_id,object_type='unknown',source,source_id,points,gap_seconds=1800,simplify_tolerance_m=0}){
  if(!String(track_id??'').trim())throw new Error('track_id is required');
  const raw_points=structuredClone(points??[]);
  const {clean_points,rejected_points}=normalizeMovementPoints(raw_points,{gap_seconds});
  if(clean_points.length<2)throw new Error('MovementTrack needs at least two valid ordered points');
  const publication_points=simplifyMovementPoints(clean_points,{tolerance_m:simplify_tolerance_m});
  return {
    schema_version:'1.0.0',track_id,object_type,source:source??'',source_id:source_id??'',
    processing:{gap_seconds,simplify_tolerance_m,rejected_points},
    raw_points,clean_points,publication_points,
    metrics:movementMetrics(raw_points,clean_points,publication_points),
  };
}
