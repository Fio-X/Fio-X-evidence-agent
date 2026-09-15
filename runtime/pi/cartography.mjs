import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_BASEMAP_ID, basemapAdequacy, getBasemap, listBasemaps, requireBasemap, selectBasemap } from './basemap_registry.mjs';
export { abstractOdPath, optimizeAbstractOdRoutes } from './flow_layout.mjs';

export const CARTOGRAPHY_SCHEMA_VERSION = '0.3.0';
export const BASEMAP_ID = DEFAULT_BASEMAP_ID;
const DEFAULT_BASEMAP = requireBasemap(BASEMAP_ID);
export const BASEMAP_SOURCE_URL = DEFAULT_BASEMAP.source_url;
export const BASEMAP_LICENSE = DEFAULT_BASEMAP.license;
export const BASEMAP_CONTENT_HASH = DEFAULT_BASEMAP.content_hash;
export const GEOMETRY_SEMANTICS = ['abstract_od','great_circle_reference','verified_route','observed_trajectory','network_constrained'];
export const MAP_PROJECTIONS = ['natural_earth_1','equirectangular'];
export { basemapAdequacy, getBasemap, listBasemaps, selectBasemap };

const BASEMAP = DEFAULT_BASEMAP.data;

function rad(v){ return v * Math.PI / 180; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function rawNaturalEarth1(lon, lat) {
  const lambda = rad(lon), phi = rad(clamp(lat,-89.999,89.999));
  const phi2 = phi * phi, phi4 = phi2 * phi2;
  const x = lambda * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * phi2 * (0.003971 * phi2 - 0.001529 * phi4)));
  const y = phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)));
  return [x,-y];
}
function rawEquirectangular(lon, lat){ return [rad(lon), -rad(lat)]; }
function rawProject(projection, lon, lat){ return projection === 'equirectangular' ? rawEquirectangular(lon,lat) : rawNaturalEarth1(lon,lat); }

function geometryCoordinateArrays(geometry){
  if(!geometry) return [];
  if(geometry.type==='Polygon') return geometry.coordinates;
  if(geometry.type==='MultiPolygon') return geometry.coordinates.flat();
  return [];
}

const BOUNDS_CACHE = new Map();
function projectionBounds(projection){
  if(BOUNDS_CACHE.has(projection)) return BOUNDS_CACHE.get(projection);
  let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;
  for(const feature of BASEMAP.features ?? []) for(const ring of geometryCoordinateArrays(feature.geometry)) for(const pt of ring){
    const [x,y]=rawProject(projection,Number(pt[0]),Number(pt[1]));
    if(!Number.isFinite(x)||!Number.isFinite(y)) continue;
    xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);
  }
  const out={xmin,xmax,ymin,ymax}; BOUNDS_CACHE.set(projection,out); return out;
}

export function createProjection(projection, left, right, top, bottom){
  const b=projectionBounds(projection);
  const sx=(right-left)/(b.xmax-b.xmin), sy=(bottom-top)/(b.ymax-b.ymin), s=Math.min(sx,sy);
  const ox=left+((right-left)-(b.xmax-b.xmin)*s)/2-b.xmin*s;
  const oy=top+((bottom-top)-(b.ymax-b.ymin)*s)/2-b.ymin*s;
  return (lon,lat)=>{const [x,y]=rawProject(projection,lon,lat);return{x:ox+x*s,y:oy+y*s};};
}

export function createProjectionForExtent(projection, extent, left, right, top, bottom, paddingRatio=0.08, minimumSpanDeg=0){
  if(!extent||![extent.west,extent.east,extent.south,extent.north].every(Number.isFinite)) return createProjection(projection,left,right,top,bottom);
  const pad=clamp(Number(paddingRatio)||0,0,0.35), requestedMin=clamp(Number(minimumSpanDeg)||0,0,60);
  const rawLonSpan=Math.max(0.001,extent.east-extent.west), rawLatSpan=Math.max(0.001,extent.north-extent.south), lonSpan=Math.max(rawLonSpan,requestedMin), latSpan=Math.max(rawLatSpan,requestedMin), lonMid=(extent.west+extent.east)/2, latMid=(extent.south+extent.north)/2;
  const west=clamp(lonMid-lonSpan/2-lonSpan*pad,-180,180), east=clamp(lonMid+lonSpan/2+lonSpan*pad,-180,180), south=clamp(latMid-latSpan/2-latSpan*pad,-89.5,89.5), north=clamp(latMid+latSpan/2+latSpan*pad,-89.5,89.5);
  const samples=[];
  for(let i=0;i<=16;i++){const t=i/16;const lon=west+(east-west)*t,lat=south+(north-south)*t;samples.push(rawProject(projection,lon,south),rawProject(projection,lon,north),rawProject(projection,west,lat),rawProject(projection,east,lat));}
  const xs=samples.map(p=>p[0]).filter(Number.isFinite),ys=samples.map(p=>p[1]).filter(Number.isFinite);
  if(!xs.length||!ys.length)return createProjection(projection,left,right,top,bottom);
  const b={xmin:Math.min(...xs),xmax:Math.max(...xs),ymin:Math.min(...ys),ymax:Math.max(...ys)};
  const sx=(right-left)/Math.max(1e-9,b.xmax-b.xmin), sy=(bottom-top)/Math.max(1e-9,b.ymax-b.ymin), scale=Math.min(sx,sy);
  const ox=left+((right-left)-(b.xmax-b.xmin)*scale)/2-b.xmin*scale, oy=top+((bottom-top)-(b.ymax-b.ymin)*scale)/2-b.ymin*scale;
  return (lon,lat)=>{const [x,y]=rawProject(projection,lon,lat);return{x:ox+x*scale,y:oy+y*scale};};
}

export function parseTrajectoryPoints(value){
  if(value===null||value===undefined||value==='') return null;
  let parsed=value;if(typeof value==='string'){try{parsed=JSON.parse(value);}catch{return null;}}
  if(!Array.isArray(parsed)||parsed.length<2)return null;
  const out=[];
  for(const point of parsed){
    if(!point||typeof point!=='object')return null;
    const lon=Number(point.lon),lat=Number(point.lat),elapsed=Number(point.elapsed_s);
    if(!Number.isFinite(lon)||!Number.isFinite(lat)||lon<-180||lon>180||lat<-90||lat>90||!Number.isFinite(elapsed))return null;
    out.push({...point,lon,lat,elapsed_s:elapsed,segment:Number.isFinite(Number(point.segment))?Number(point.segment):0});
  }
  for(let i=1;i<out.length;i++)if(out[i].elapsed_s<=out[i-1].elapsed_s)return null;
  return out;
}

export function trajectoryLines(points){
  if(!Array.isArray(points)||points.length<2)return null;const lines=[];let line=[];let segment=points[0].segment;
  for(const p of points){if(p.segment!==segment&&line.length){if(line.length>=2)lines.push(line);line=[];segment=p.segment;}line.push([p.lon,p.lat]);}
  if(line.length>=2)lines.push(line);return lines.length?lines:null;
}

export function coordinateExtent(lines){
  const pts=(lines??[]).flat();if(!pts.length)return null;const lons=pts.map(p=>Number(p[0])).filter(Number.isFinite),lats=pts.map(p=>Number(p[1])).filter(Number.isFinite);
  return lons.length&&lats.length?{west:Math.min(...lons),east:Math.max(...lons),south:Math.min(...lats),north:Math.max(...lats)}:null;
}

function pathFromRing(ring, project){
  let d=''; let prev=null;
  for(const pt of ring){
    const p=project(Number(pt[0]),Number(pt[1]));
    if(!Number.isFinite(p.x)||!Number.isFinite(p.y)) continue;
    // Natural Earth source contains dateline-split polygons. Guard accidental long jumps after simplification.
    const cmd = !prev || Math.abs(p.x-prev.x)>460 ? 'M' : 'L';
    d += `${cmd}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    prev=p;
  }
  return d ? d+'Z' : '';
}

export function renderBasemapPaths(project, basemapId=BASEMAP_ID){
  const basemap=requireBasemap(basemapId).data; let d='';
  for(const feature of basemap.features ?? []) for(const ring of geometryCoordinateArrays(feature.geometry)) d += pathFromRing(ring,project);
  return d;
}

function toVec(lon,lat){const la=rad(lat),lo=rad(lon),c=Math.cos(la);return[c*Math.cos(lo),c*Math.sin(lo),Math.sin(la)];}
function fromVec([x,y,z]){const lon=Math.atan2(y,x)*180/Math.PI,lat=Math.atan2(z,Math.hypot(x,y))*180/Math.PI;return[lon,lat];}
function norm(v){const m=Math.hypot(...v)||1;return v.map(x=>x/m);}
export function greatCirclePoints(lon1,lat1,lon2,lat2,steps=32){
  const a=toVec(lon1,lat1),b=toVec(lon2,lat2),dot=clamp(a[0]*b[0]+a[1]*b[1]+a[2]*b[2],-1,1),omega=Math.acos(dot);
  if(omega<1e-8) return [[lon1,lat1],[lon2,lat2]];
  const so=Math.sin(omega),out=[];
  for(let i=0;i<=steps;i++){const t=i/steps,s0=Math.sin((1-t)*omega)/so,s1=Math.sin(t*omega)/so;out.push(fromVec(norm([a[0]*s0+b[0]*s1,a[1]*s0+b[1]*s1,a[2]*s0+b[2]*s1])));}
  return out;
}

export function parseRouteGeometry(value){
  if(value===null||value===undefined||value==='') return null;
  let parsed=value;
  if(typeof value==='string') { try { parsed=JSON.parse(value); } catch { return null; } }
  if(Array.isArray(parsed)) {
    if(parsed.every(p=>Array.isArray(p)&&p.length>=2)) return [parsed.map(p=>[Number(p[0]),Number(p[1])])];
    return null;
  }
  if(parsed?.type==='LineString' && Array.isArray(parsed.coordinates)) return [parsed.coordinates.map(p=>[Number(p[0]),Number(p[1])])];
  if(parsed?.type==='MultiLineString' && Array.isArray(parsed.coordinates)) return parsed.coordinates.map(line=>line.map(p=>[Number(p[0]),Number(p[1])]));
  if(parsed?.type==='Feature') return parseRouteGeometry(parsed.geometry);
  return null;
}

export function validRouteGeometry(lines){
  return Array.isArray(lines)&&lines.length>0&&lines.every(line=>Array.isArray(line)&&line.length>=2&&line.every(([lon,lat])=>Number.isFinite(lon)&&Number.isFinite(lat)&&lon>=-180&&lon<=180&&lat>=-90&&lat<=90));
}

export function projectedPolylinePath(lines, project, jumpThreshold=430){
  let d='';
  for(const line of lines){let prev=null;for(const [lon,lat] of line){const p=project(lon,lat);const cmd=!prev||Math.abs(p.x-prev.x)>jumpThreshold?'M':'L';d+=`${cmd}${p.x.toFixed(1)},${p.y.toFixed(1)}`;prev=p;}}
  return d;
}

export function geometryDisclosure(semantics, provenance=''){
  if(semantics==='abstract_od') return 'Arcs encode origin-destination relationships; they do not represent physical routes.';
  if(semantics==='great_circle_reference') return 'Lines show geodesic reference paths; they do not represent filed or observed routes.';
  if(semantics==='observed_trajectory') return `Paths follow observed trajectory samples${provenance?` from ${provenance}`:''}; gaps may reflect observation coverage.`;
  if(semantics==='network_constrained') return `Paths follow verified network-constrained geometry${provenance?` from ${provenance}`:''}.`;
  return `Paths follow verified route geometry${provenance?` from ${provenance}`:''}.`;
}

export function selectRoutes(rows,spec){
  const sorted=rows.slice().sort((a,b)=>(Number(b?.[spec.value_field])||0)-(Number(a?.[spec.value_field])||0));
  if(spec.aggregation_policy==='top_n') return sorted.slice(0,Math.max(1,Number(spec.top_n)||20));
  return sorted;
}
